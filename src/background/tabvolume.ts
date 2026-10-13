// Volume por aba (Emenda 14), lado do SW: o controle "Volume desta aba" do popup.
//
// Mecanismo: chrome.tabCapture da aba (abrir o popup é a invocação da extensão que libera a
// captura), consumida no offscreen como fonte -> GainNode(volume) -> destino. Em 100% sem modo aba,
// a captura é desfeita e a aba volta ao caminho de som dela (e ao dispositivo de saída que ela
// escolheu). O Chrome só deixa uma captura por aba, então o modo aba (tabcapture.ts) começa em
// cima da captura de volume que já existir e, ao parar com o volume fora de 100%, ela continua
// só de volume.
//
// Nenhuma gravação passa pelo volume: o gravador do modo aba tira o som da fonte, antes do ganho
// (src/offscreen/tab.ts), e a gravação automática na página não vê a captura de aba.
//
// A verdade da captura fica no offscreen (o SW reinicia e perde a memória; o offscreen não): o SW
// pergunta (offscreen:tab-audio) quando o Chrome diz que a aba está capturada, e guarda o volume
// por aba enquanto a captura vive. O volume é da aba, como no Volume Master: a captura sobrevive à
// navegação, inclusive para outro site e para páginas chrome:// (medido no Chrome for Testing 151),
// e o volume vai junto. Aba fechada, captura encerrada pelo Chrome ou captura desfeita: o volume
// da aba é esquecido.
import type { TabAudioState, TabVolumeState, UiResMap } from '../shared/protocol'
import { t } from '../shared/i18n'
import { offscreenReason } from '../shared/offscreen-reasons'
import { clampVolume, decideVolume, VOLUME_NATIVE } from '../shared/volume'
import { tabStreamId } from './capture-id'
import { ensureOffscreen, sendToOffscreen } from './offscreen-doc'

const log = (...a: unknown[]) => console.debug('[gravador sw volume]', ...a)

/** Volume por aba enquanto a captura da extensão vive (Emenda 14). */
const volumeByTab = new Map<number, number>()

/** Fila por aba: o volume e o modo aba nunca abrem duas capturas da mesma aba ao mesmo tempo. */
const locks = new Map<number, Promise<unknown>>()

/**
 * Abas com uma operação de captura na fila agora (volume ou toggle do modo aba). A recarga sozinha
 * (auto-reload.ts) espera por elas: entre o getMediaStreamId e a sessão criada, nem a memória, nem
 * o IndexedDB, nem o getCapturedTabs mostram ainda a captura que o usuário acabou de pedir.
 */
export function tabCaptureOpsInFlight(): number {
  return locks.size
}

/** Roda `fn` depois de tudo o que já está na fila desta aba (volume e toggle do modo aba). */
export function withTabLock<T>(tabId: number, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(tabId) ?? Promise.resolve()
  const run = prev.then(fn, fn)
  const tail = run.catch(() => {})
  locks.set(tabId, tail)
  void tail.then(() => {
    if (locks.get(tabId) === tail) locks.delete(tabId)
  })
  return run
}

const NO_CAPTURE: TabAudioState = { mode: null, volume: VOLUME_NATIVE, replay: true, gain: VOLUME_NATIVE }

/** O Chrome diz que esta extensão está capturando a aba (a captura vive no offscreen). */
async function capturedByUs(tabId: number): Promise<boolean> {
  const tabs = await chrome.tabCapture.getCapturedTabs().catch(() => [] as chrome.tabCapture.CaptureInfo[])
  return tabs.some((t) => t.tabId === tabId && (t.status === 'active' || t.status === 'pending'))
}

/**
 * Como está a captura da aba: nenhuma, só de volume ou gravando (modo aba). Sem captura, esquece o
 * volume da aba. Também é o gancho de teste `tabAudioState` (o ganho que se ouve no offscreen).
 */
export async function tabAudioState(tabId: number): Promise<TabAudioState> {
  if (!(await capturedByUs(tabId))) {
    volumeByTab.delete(tabId)
    return NO_CAPTURE
  }
  const r = await sendToOffscreen({ target: 'offscreen', t: 'offscreen:tab-audio', tabId }).catch(() => null)
  if (!r) {
    // Offscreen sem resposta, com a aba capturada: vale o que o SW lembra. Com um volume lembrado,
    // a captura é a de volume (o popup mostra o valor e o 100% tenta desfazê-la, em vez de pedir
    // ao Chrome uma segunda captura, que ele recusa); sem nada lembrado, segue sem modo, como antes.
    const remembered = volumeByTab.get(tabId)
    if (remembered === undefined) return NO_CAPTURE
    return { mode: 'volume', volume: remembered, replay: true, gain: remembered }
  }
  if (r.mode) volumeByTab.set(tabId, r.volume)
  else volumeByTab.delete(tabId)
  return r
}

/** ui:tab-volume-get: o volume atual da aba e se há captura nela. */
export async function getTabVolume(tabId: number): Promise<TabVolumeState> {
  const s = await tabAudioState(tabId)
  return { volume: s.mode ? s.volume : VOLUME_NATIVE, active: s.mode !== null, mode: s.mode }
}

/** O volume que o SW lembra desta aba (undefined: sem captura). */
export function rememberedTabVolume(tabId: number): number | undefined {
  return volumeByTab.get(tabId)
}

/**
 * ui:tab-volume-set: aplica o volume (limitado a 0..2). Sem captura, 100% não faz nada e outro
 * valor abre uma captura só de volume; só de volume, 100% a desfaz; com o modo aba gravando, só o
 * ganho muda (100% nunca para a gravação).
 */
export function setTabVolume(tabId: number, raw: number): Promise<UiResMap['ui:tab-volume-set']> {
  const volume = clampVolume(raw)
  if (volume === null) return Promise.resolve({ ok: false, error: t('errInvalidVolume') })
  return withTabLock(tabId, async () => {
    const cur = await tabAudioState(tabId)
    const action = decideVolume(cur.mode, volume)
    switch (action) {
      case 'nada':
        volumeByTab.delete(tabId)
        return { ok: true, volume, active: false, mode: null }
      case 'iniciar': {
        // O documento primeiro: o ID da captura tem prazo curto para ser consumido.
        await ensureOffscreen()
        // Outra extensão segurando a captura da aba vira uma mensagem que diz o que fazer (Emenda 17).
        const id = await tabStreamId(tabId)
        if (!id.ok) return { ok: false, error: id.error }
        const streamId = id.streamId
        const r = await sendToOffscreen({ target: 'offscreen', t: 'offscreen:tab-volume-start', tabId, streamId, volume }).catch(
          (e: unknown) => ({ ok: false, error: String((e as Error)?.message ?? e) }),
        )
        if (!r.ok) return { ok: false, error: r.error ? offscreenReason(r.error) : t('errCaptureNoAnswer') }
        volumeByTab.set(tabId, volume)
        log('volume da aba', tabId, volume, 'captura nova')
        return { ok: true, volume, active: true, mode: 'volume' }
      }
      case 'ajustar': {
        const r = await sendToOffscreen({ target: 'offscreen', t: 'offscreen:tab-volume', tabId, volume }).catch(() => ({ ok: false }))
        if (!r.ok) return { ok: false, error: t('errCaptureNoAnswer') }
        volumeByTab.set(tabId, volume)
        return { ok: true, volume, active: true, mode: cur.mode }
      }
      case 'parar': {
        const r = await sendToOffscreen({ target: 'offscreen', t: 'offscreen:tab-volume-stop', tabId }).catch(() => ({ ok: false }))
        if (!r.ok) return { ok: false, error: t('errCaptureNoAnswer') }
        volumeByTab.delete(tabId)
        log('volume da aba de volta a 100%: captura desfeita', tabId)
        return { ok: true, volume: VOLUME_NATIVE, active: false, mode: null }
      }
    }
  })
}

/** Ouvintes do volume por aba (chamado por registerTabCapture, sem mexer em index.ts). */
export function registerTabVolume(): void {
  chrome.tabs.onRemoved.addListener((tabId) => {
    volumeByTab.delete(tabId)
  })
  // Captura encerrada pelo Chrome (a navegação não encerra; a aba fechada, sim): o offscreen
  // desfaz a dele quando a faixa termina; aqui o SW esquece o volume. tabAudioState também confere.
  chrome.tabCapture.onStatusChanged?.addListener((info) => {
    if (info.status === 'stopped' || info.status === 'error') volumeByTab.delete(info.tabId)
  })
}
