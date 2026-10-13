// Modo aba (plano B, AC12): comando `gravar-aba` (Alt+Shift+G) e botão do popup (ui:tab-capture
// em ui-api.ts) chamam o mesmo toggleTabCapture(tabId).
//
// Início: o SW pede chrome.tabCapture.getMediaStreamId({ targetTabId }) e entrega o ID ao
// offscreen (src/offscreen/tab.ts), que o consome com getUserMedia em até 10 s. A sessão é
// criada aqui com createSession({ kind: 'aba' }) (arquivo audio-aba.webm, badge, begin no
// helper) e, se a aba tem uma sessão de página gravando, fica pareada com ela: no fim o arquivo
// entra na pasta da call (sessions.ts, finalize com merge). Sem sessão de página, pasta própria
// com o título e a URL da aba.
//
// Fim: o mesmo atalho ou botão de novo, o botão parar do popup (session:stop pelo Port do
// offscreen), a aba fechada (a faixa da captura termina e tabs.onRemoved), ou a sessão de
// página da aba terminando (onPageSessionEnded).
//
// Gatilho de teste (ARQUITETURA, "Modo aba"): `__gravador.testing.toggleTabCapture(tabId)`.
// Com --allowlisted-extension-id o getMediaStreamId não pede gesto.
//
// Volume por aba (Emenda 14, ./tabvolume.ts): o Chrome só deixa uma captura por aba. Se a aba já
// tem a captura só de volume, o modo aba começa em cima dela (sem outro getMediaStreamId) e, ao
// parar com o volume fora de 100%, o offscreen a mantém só de volume.
import { PAGE_OUTPUT_QUERY, type ActiveRecording, type CallMeta, type EndReason, type PageOutputAnswer, type RecordingPlatform } from '../shared/protocol'
import { t } from '../shared/i18n'
import { platformOfHost } from '../shared/hosts'
import { offscreenReason } from '../shared/offscreen-reasons'
import { getSession, listSessions } from './idb'
import { failTabStreamId, tabStreamId } from './capture-id'
import { ensureOffscreen, sendToOffscreen } from './offscreen-doc'
import { activeRecordings, createSession, onPageSessionEnded, stopSession } from './sessions'
import { registerTabVolume, tabAudioState, withTabLock } from './tabvolume'
import { registerTestHooks } from './testing'

export const TAB_COMMAND = 'gravar-aba'

/** Prazo do Chrome para consumir o ID do getMediaStreamId (ARQUITETURA, "Modo aba"). */
export const STREAM_ID_TTL_MS = 10_000

export interface TabCaptureResult {
  ok: boolean
  error?: string
}

const log = (...a: unknown[]) => console.debug('[gravador sw aba]', ...a)

/** Prazo para o relay da aba dizer se a página toca num dispositivo de saída próprio. */
const PAGE_OUTPUT_TIMEOUT_MS = 500

/**
 * Devolução do som por aba no modo aba: true devolve à saída padrão. Começa ligada (Emenda 12);
 * o popup troca com ui:tab-replay quando o usuário ouve em dobro ou não ouve nada.
 */
const replayByTab = new Map<number, boolean>()

/**
 * A página da aba toca num dispositivo de saída próprio? Pergunta ao relay da frame do topo.
 * Fora do Meet e do Teams não há relay: a resposta é "não" e o som é devolvido, como antes.
 */
async function pageUsesSpecificOutput(tabId: number): Promise<boolean> {
  let ask: Promise<boolean>
  try {
    ask = chrome.tabs
      .sendMessage(tabId, { t: PAGE_OUTPUT_QUERY }, { frameId: 0 })
      .then((r: PageOutputAnswer | undefined) => r?.especifica === true)
      .catch(() => false)
  } catch {
    return false
  }
  const timeout = new Promise<boolean>((res) => setTimeout(() => res(false), PAGE_OUTPUT_TIMEOUT_MS))
  return Promise.race([ask, timeout])
}

/** Estado da devolução da aba (undefined: a aba não está no modo aba). */
export function tabReplay(tabId: number): boolean | undefined {
  return replayByTab.get(tabId)
}

/** Liga ou desliga a devolução do som do modo aba daquela aba (botão do popup). */
export async function setTabReplay(tabId: number, on: boolean): Promise<TabCaptureResult> {
  if (!replayByTab.has(tabId)) return { ok: false, error: t('errNotInTabMode') }
  const r = await sendToOffscreen({ target: 'offscreen', t: 'offscreen:tab-replay', tabId, on }).catch(() => ({ ok: false }))
  if (!r.ok) return { ok: false, error: t('errCaptureNoAnswer') }
  replayByTab.set(tabId, on)
  return { ok: true }
}

/** Toggle em andamento por aba: um segundo toggle durante o início (ou a parada) espera o mesmo resultado. */
const inFlight = new Map<number, Promise<TabCaptureResult>>()

function sessionOfTab(tabId: number, kind: ActiveRecording['kind']): ActiveRecording | undefined {
  return activeRecordings().find((r) => r.tabId === tabId && r.kind === kind)
}

/**
 * A gravação do modo aba desta aba, se houver. A memória do SW (activeRecordings) só conhece as
 * sessões já carregadas: logo depois de o SW reiniciar, antes da recuperação ou do próximo chunk,
 * a sessão só existe no IndexedDB. Sem olhar lá, o toggle de parar viraria um início e falharia
 * com "Cannot capture a tab with an active stream" (a parada do usuário se perderia).
 *
 * Fora da memória, vale só com a aba capturada de verdade: uma sessão "gravando" que sobrou de
 * uma queda do Chrome pode ter o mesmo tabId de uma aba nova (os ids recomeçam), e essa a
 * recuperação fecha como interrompida; ela não pode virar um "parar" na aba nova.
 */
async function tabSessionOf(tabId: number): Promise<{ sessionId: string | null; captured: boolean }> {
  const mem = sessionOfTab(tabId, 'aba')
  if (mem) return { sessionId: mem.sessionId, captured: true }
  if (!(await isTabCaptured(tabId))) return { sessionId: null, captured: false }
  const stored = (await listSessions('gravando').catch(() => [])).find((r) => r.kind === 'aba' && r.tabId === tabId)
  return { sessionId: stored?.sessionId ?? null, captured: true }
}

/** O Chrome diz que esta extensão está capturando a aba (a captura vive no offscreen). */
async function isTabCaptured(tabId: number): Promise<boolean> {
  const tabs = await chrome.tabCapture.getCapturedTabs().catch(() => [] as chrome.tabCapture.CaptureInfo[])
  return tabs.some((t) => t.tabId === tabId && (t.status === 'active' || t.status === 'pending'))
}

/** Ainda "gravando", na memória ou (sessão não carregada depois de um reinício) no IndexedDB. */
async function isStillRecording(sessionId: string): Promise<boolean> {
  if (activeRecordings().some((r) => r.sessionId === sessionId)) return true
  return (await getSession(sessionId).catch(() => undefined))?.status === 'gravando'
}

/**
 * Plataforma de uma aba sem sessão de página (Emenda 7). Fora dos hosts das calls é `outro`: a
 * pasta fica "(Outro site)", não "(Meet)". Sem URL também é `outro`, porque os hosts das calls
 * sempre dão a URL (host_permissions) e o activeTab dá a das outras abas no gesto do usuário.
 */
export function platformOfUrl(url: string | undefined): RecordingPlatform {
  try {
    // Hosts das calls, também pelo proxy do Defender for Cloud Apps (src/shared/hosts.ts).
    return platformOfHost(new URL(url ?? '').hostname) ?? 'outro'
  } catch {
    return 'outro'
  }
}

/**
 * Título e URL da aba como metadados (vão no info.json e no nome da pasta própria). Nos hosts
 * das calls eles vêm das host_permissions; em outro site, do activeTab, que o Chrome concede na
 * mesma invocação (atalho ou clique no ícone e no botão do popup) que libera a captura da aba.
 */
export function tabMeta(tab: Pick<chrome.tabs.Tab, 'title' | 'url'>): Partial<CallMeta> {
  const title = (tab.title ?? '').trim()
  return {
    url: tab.url ?? '',
    tabTitle: title,
    ...(title ? { title, titleSource: 'titulo-da-aba' as const } : { titleSource: 'nenhum' as const }),
  }
}

/** Liga ou desliga a gravação do modo aba na aba indicada. */
export async function toggleTabCapture(tabId: number): Promise<TabCaptureResult> {
  const pending = inFlight.get(tabId)
  if (pending) return pending
  // Na fila da aba com o volume (Emenda 14): nunca duas capturas da mesma aba ao mesmo tempo.
  const p = withTabLock(tabId, () => decideAndToggle(tabId)).finally(() => inFlight.delete(tabId))
  inFlight.set(tabId, p)
  return p
}

/**
 * Parar ou começar. Parar vale se há sessão do modo aba na memória ou se o Chrome ainda vê a aba
 * capturada por esta extensão (o offscreen grava, mesmo com a sessão só no IndexedDB). Fica
 * dentro do `inFlight` para um segundo toggle durante a decisão esperar o mesmo resultado.
 */
async function decideAndToggle(tabId: number): Promise<TabCaptureResult> {
  const { sessionId, captured } = await tabSessionOf(tabId)
  // Emenda 14: a aba capturada sem sessão do modo aba pode ser só o volume dela. Aí é um início,
  // em cima da mesma captura; sem o volume, é uma captura órfã e o toggle a para, como antes.
  if (captured && !sessionId && (await tabAudioState(tabId)).mode === 'volume') return startTabCapture(tabId, true)
  if (captured) return stopTabCapture(tabId, 'parado-pelo-usuario', sessionId)
  return startTabCapture(tabId, false)
}

/** Pede o ID da captura da aba ao Chrome (o erro já vem traduzido, ./capture-id.ts). */
const newStreamId = tabStreamId

/** `reuse`: a aba já tem a captura só de volume (Emenda 14); o gravador entra nela. */
async function startTabCapture(tabId: number, reuse: boolean): Promise<TabCaptureResult> {
  const tab = await chrome.tabs.get(tabId).catch(() => null)
  if (!tab) return { ok: false, error: t('errTabNotFound') }
  // Devolve o som por padrão (Emenda 12): a segunda call real mostrou que o Chrome silencia
  // também o que a página toca num dispositivo próprio. A saída da página só vai para o log, como
  // pista se o eco voltar; o botão do popup troca.
  const especifica = await pageUsesSpecificOutput(tabId)
  const replay = true
  // O documento primeiro: o ID da captura tem prazo curto para ser consumido.
  await ensureOffscreen()
  let streamId: string | undefined
  const t0 = Date.now()
  if (!reuse) {
    const id = await newStreamId(tabId)
    if (!id.ok) return { ok: false, error: id.error }
    streamId = id.streamId
  }
  const page = sessionOfTab(tabId, 'pagina')
  const rec = await createSession({
    tabId,
    frameId: 0,
    platform: page?.platform ?? platformOfUrl(tab.url),
    kind: 'aba',
    localId: `aba-${tabId}-${t0}`,
    startedAt: Date.now(),
    meta: tabMeta(tab),
    port: null,
    pairedSessionId: page?.sessionId ?? null,
  })
  const elapsed = Date.now() - t0
  if (elapsed > STREAM_ID_TTL_MS) log('ID da captura entregue tarde', elapsed, 'ms')
  const startIn = (id: string | undefined) =>
    sendToOffscreen({ target: 'offscreen', t: 'offscreen:tab-start', tabId, streamId: id, sessionId: rec.sessionId, replay }).catch(
      (e: unknown) => ({ ok: false, error: String((e as Error)?.message ?? e) }),
    )
  let r = await startIn(streamId)
  if (!r.ok && reuse) {
    // A captura de volume acabou entre a decisão e o início (navegação, por exemplo): uma nova.
    log('a captura de volume não estava mais lá; pedindo outra', tabId, r.error)
    const id = await newStreamId(tabId)
    if (id.ok) r = await startIn(id.streamId)
  }
  if (!r.ok) {
    // Sem nenhum chunk, a finalização descarta a sessão (e o staging no helper).
    await stopSession(rec.sessionId)
    return { ok: false, error: r.error ? offscreenReason(r.error) : t('errOffscreenTabFailed') }
  }
  replayByTab.set(tabId, replay)
  log('modo aba gravando', tabId, rec.sessionId, reuse ? 'na captura de volume' : 'captura nova', especifica ? 'página com saída própria' : 'página na saída padrão', page ? `pareado com ${page.sessionId}` : 'pasta própria', `${elapsed} ms até o offscreen`)
  return { ok: true }
}

/**
 * Para a gravação do modo aba da aba. O motivo vai no session:end que o offscreen manda (campo
 * `reason` do tab-stop, Emenda 7). Se o offscreen não tinha a captura (documento
 * recriado, por exemplo), nenhum session:end chega e a sessão continuaria "gravando": depois de
 * um prazo, o SW fecha com o que já chegou.
 */
async function stopTabCapture(tabId: number, reason: EndReason, sessionId: string | null): Promise<TabCaptureResult> {
  replayByTab.delete(tabId)
  const r = await sendToOffscreen({ target: 'offscreen', t: 'offscreen:tab-stop', tabId, reason }).catch(() => ({ ok: false }))
  if (sessionId) void closeIfStillRecording(sessionId, r.ok ? ORPHAN_STOP_MS : 0)
  return { ok: true }
}

/**
 * Prazo para a sessão sair de "gravando" depois do tab-stop. O offscreen manda o session:end antes
 * de responder, e a finalização começa em seguida (espera no máximo 5 s pelos chunks anunciados).
 */
const ORPHAN_STOP_MS = 12_000

async function closeIfStillRecording(sessionId: string, waitMs: number): Promise<void> {
  const t0 = Date.now()
  while (Date.now() - t0 < waitMs) {
    if (!(await isStillRecording(sessionId))) return
    await new Promise((res) => setTimeout(res, 250))
  }
  // stopSession confere o estado da memória: se a finalização já começou, não faz nada.
  if (await isStillRecording(sessionId)) {
    log('o offscreen não tinha a captura; fechando a sessão pelo SW', sessionId)
    await stopSession(sessionId)
  }
}

export function registerTabCapture(): void {
  registerTestHooks({ toggleTabCapture, tabReplay, tabAudioState, failTabStreamId })
  registerTabVolume()
  chrome.commands.onCommand.addListener((command, tab) => {
    if (command !== TAB_COMMAND || tab?.id == null) return
    void toggleTabCapture(tab.id)
  })
  // A sessão de página da aba terminou: o modo aba para junto (e salva na pasta dela).
  onPageSessionEnded((e) => {
    void tabSessionOf(e.tabId).then(({ sessionId, captured }) => {
      if (captured) void stopTabCapture(e.tabId, e.reason, sessionId)
    })
  })
  // Aba fechada: a faixa da captura termina sozinha no offscreen; pedir o fim já aqui adianta o
  // último chunk antes de o sessions.ts finalizar a sessão (300 ms depois do onRemoved).
  chrome.tabs.onRemoved.addListener((tabId) => {
    void tabSessionOf(tabId).then(({ sessionId }) => {
      if (sessionId) void stopTabCapture(tabId, 'aba-fechada', sessionId)
    })
  })
}
