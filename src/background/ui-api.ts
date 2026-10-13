// Mensagens do popup e das configurações para o SW (UiReq -> UiResMap).
// O vigia é lido e comandado só pelas funções de ./vigia.ts (Emenda 6).
import { parseTabVolumeReq, type BuildInfo, type UiReq, type UiResMap, type VigiaTabState } from '../shared/protocol'
import { BAKED } from '../shared/version'
import { autoReloadState } from './auto-reload'
import { loadRecent, loadSettings, saveSettings } from '../shared/settings'
import { hasConsent } from '../shared/consent'
import { languageReady, t } from '../shared/i18n'
import { tabsNeedingReload } from './badge'
import { activeRecordings, pendingSaves, recoverSessions, stopSession } from './sessions'
import { revealRecording } from './reveal'
import { host, pingHost } from './sink-host'
import { setTabReplay, tabReplay, toggleTabCapture } from './tabcapture'
import { getTabVolume, setTabVolume } from './tabvolume'
import { chooseModel, openTranscript, setTranscription, transcriptionForPopup, transcriptionSettings } from './transcription'
import { registerTestHooks } from './testing'
import { vigiaCommand, vigiaStatuses, vigiaTabState } from './vigia'

/**
 * Gancho de teste (nunca armado pelo produto): respostas falsas de ui:vigia-status por aba, para
 * o teste da interface conferir como o popup mostra uma leitura do vigia sem depender da fatia
 * do vigia. null tira a resposta falsa.
 */
const fakeVigia = new Map<number, VigiaTabState>()
function fakeVigiaTabState(tabId: number, state: VigiaTabState | null): void {
  if (state) fakeVigia.set(tabId, state)
  else fakeVigia.delete(tabId)
}

/**
 * Ganchos de teste da Emenda 17 (nunca armados pelo produto). `fakeWorkerVersion`: o ui:state diz
 * outra versão do SW (`'omitir'`: sem o campo, como um SW anterior à 0.3.1). `dropUiRequests`: o
 * SW não responde a esses pedidos, como um SW antigo que não os conhece (a resposta chega vazia).
 */
let fakeWorker: BuildInfo | 'omitir' | null = null
function fakeWorkerVersion(v: BuildInfo | 'omitir' | null): void {
  fakeWorker = v
}
const dropped = new Set<string>()
function dropUiRequests(types: string[]): void {
  dropped.clear()
  for (const t of types) dropped.add(t)
}

type Handler<K extends UiReq['t']> = (req: Extract<UiReq, { t: K }>) => Promise<UiResMap[K]>

const handlers: { [K in UiReq['t']]: Handler<K> } = {
  'ui:state': async () => {
    const recent = await loadRecent()
    const helper = await pingHost()
    return {
      active: activeRecordings().map((a) => (a.kind === 'aba' ? { ...a, replay: tabReplay(a.tabId) ?? true } : a)),
      recent,
      helper,
      settings: await loadSettings(),
      vigia: vigiaStatuses(),
      reloadTabs: await tabsNeedingReload(),
      pendingSaves: pendingSaves(),
      // Emenda 13: o estado da transcrição vem do helper (info.json de cada pasta).
      transcription: await transcriptionForPopup(recent, helper),
      consentGiven: await hasConsent(),
      // Emenda 17: a versão embutida neste SW e a publicação que ele ainda não está rodando.
      ...(fakeWorker === 'omitir' ? {} : { worker: fakeWorker ?? BAKED }),
      update: autoReloadState(),
    }
  },
  'ui:stop': async (req) => ({ ok: await stopSession(req.sessionId) }),
  'ui:reveal': async (req) => {
    const rec = (await loadRecent()).find((r) => r.sessionId === req.sessionId)
    return revealRecording(rec, {
      async hostReveal(path) {
        const r = await host.reveal(path)
        return r.ok ? { ok: true } : { ok: false, error: r.error }
      },
      showDownload: (id) => chrome.downloads.show(id),
    })
  },
  'ui:tab-capture': async (req) => toggleTabCapture(req.tabId),
  'ui:tab-replay': async (req) => setTabReplay(req.tabId, req.on),
  'ui:choose-folder': async () => {
    const r = await host.chooseFolder(t('promptChooseFolder'))
    return r.ok ? { ok: true, path: String(r.path) } : { ok: false, error: r.error }
  },
  'ui:check-root': async (req) => {
    const r = await host.checkRoot(req.path)
    return r.ok ? { ok: true, root: String(r.root) } : { ok: false, error: r.error }
  },
  'ui:set-root': async (req) => {
    const r = await host.setRoot(req.path)
    return r.ok ? { ok: true, root: String(r.root) } : { ok: false, error: r.error }
  },
  'ui:save-settings': async (req) => {
    await saveSettings(req.settings)
    return { ok: true }
  },
  'ui:vigia-status': async (req) => fakeVigia.get(req.tabId) ?? vigiaTabState(req.tabId),
  'ui:vigia-sair-agora': async (req) =>
    vigiaCommand(req.tabId, 'sair-agora') ? { ok: true } : { ok: false, error: t('errVigiaInactive') },
  'ui:vigia-desligar': async (req) =>
    vigiaCommand(req.tabId, 'desligar-nesta-call') ? { ok: true } : { ok: false, error: t('errVigiaInactive') },
  'ui:transcription': async () => transcriptionSettings(),
  'ui:set-transcription': async (req) => setTranscription(req.patch),
  'ui:open-transcript': async (req) => openTranscript((await loadRecent()).find((r) => r.sessionId === req.sessionId)),
  'ui:choose-model': async () => chooseModel(),
  'ui:retry-saves': async () => {
    await recoverSessions()
    // A passada dispara as finalizações sem esperar: dá um tempo curto para elas terminarem.
    for (let i = 0; i < 20 && pendingSaves().length > 0; i++) await new Promise((r) => setTimeout(r, 250))
    return { ok: true, pending: pendingSaves().length }
  },
  // Volume desta aba (Emenda 14): validado com zod; o volume é limitado a 0..2 em setTabVolume.
  'ui:tab-volume-get': async (req) => {
    const r = parseTabVolumeReq(req)
    if (r?.t !== 'ui:tab-volume-get') throw new Error(t('errInvalidVolumeRequest'))
    return getTabVolume(r.tabId)
  },
  'ui:tab-volume-set': async (req) => {
    const r = parseTabVolumeReq(req)
    if (r?.t !== 'ui:tab-volume-set') return { ok: false, error: t('errInvalidVolumeRequest') }
    return setTabVolume(r.tabId, r.volume)
  },
}

function isUiReq(msg: unknown): msg is UiReq {
  return !!msg && typeof msg === 'object' && typeof (msg as { t?: unknown }).t === 'string' && (msg as { t: string }).t in handlers
}

function isExtensionPage(sender: chrome.runtime.MessageSender): boolean {
  if (sender.id !== chrome.runtime.id) return false
  const url = sender.url ?? sender.origin ?? ''
  if (!sender.tab) return true
  return url.startsWith(chrome.runtime.getURL(''))
}

export function registerUiApi(): void {
  registerTestHooks({ fakeVigiaTabState, fakeWorkerVersion, dropUiRequests })
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    // Só páginas da própria extensão (popup, options), inclusive abertas numa aba (o teste abre o
    // popup como página; o usuário pode abrir as configurações numa aba). Content scripts têm
    // sender.url da página da call, nunca chrome-extension://<id>/, então não passam (Emenda 5).
    if (!isExtensionPage(sender)) return false
    if (!isUiReq(msg)) return false
    if (dropped.has(msg.t)) return false
    const handler = handlers[msg.t] as (r: UiReq) => Promise<unknown>
    // Emenda 19: as respostas levam textos (erros, motivos) no idioma escolhido, também no pedido
    // que acordou o SW, antes de a leitura do idioma terminar.
    languageReady()
      .then(() => handler(msg))
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String(e?.message ?? e) }))
    return true
  })
}
