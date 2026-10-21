// Gravação da voz do próprio usuário, por aba (Emenda 25), lado do service worker: ele é quem
// DECIDE, com as regras puras de src/shared/mic-gate.ts (a regra do mudo, Emenda 24) e
// src/shared/mic-route.ts (quais abas recebem a voz, e quando a troca vale no áudio).
//
// O caminho inteiro:
//
//   frame da call (MAIN world)  session:mic { tracks, sinceMs }   a cada troca e de rotina
//        -> relay -> SW (aqui): micRouteDecide
//        -> offscreen (src/offscreen/mic.ts): offscreen:mic-gate { open, waitMs }
//        -> arquivo audio-microfone.webm na pasta da call (sessão própria, pareada com a da página)
//
// Desligado (o padrão), nada disto acontece: a frame não manda `session:mic` nenhum (a mensagem
// `settings` diz `micRecording: false`), nenhuma sessão de microfone é criada, nenhum getUserMedia é
// chamado e nenhuma permissão é pedida.
//
// Três regras de segurança, que os testes cobram:
//
// 1. Grava SOMENTE enquanto o portão do mudo disser aberto para aquela aba.
// 2. Sem nenhuma faixa de microfone observável na aba, o portão fica FECHADO (`sem-faixa`): sem a
//    faixa da página não existe sinal de mudo, e melhor não gravar do que gravar sem saber se a
//    pessoa está muda. Qualquer estado indeterminado também fecha.
// 3. O relato que para de chegar fecha o portão (MIC_REPORT_STALE_MS). Por isso existe o vigia
//    periódico daqui: sem relato nenhum não haveria quem fechasse.
import { MIC_REPORT_STALE_MS, micRouteDecide, type MicTabReport } from '../shared/mic-route'
import type { EndReason, MicOffscreenState, MicTrackState } from '../shared/protocol'
import { loadSettings } from '../shared/settings'
import { getSession, putSession } from './idb'
import { sendToOffscreen } from './offscreen-doc'
import { createSession, onMicReport, onPageSessionEnded, onPageSessionStarted, setMicRecordingBadge, stopSession } from './sessions'
import { registerTestHooks } from './testing'

const log = (...a: unknown[]) => console.debug('[gravador sw microfone]', ...a)

/** Com que frequência o vigia confere os relatos (um relato velho fecha o portão). */
const WATCH_MS = 1000

interface MicSession {
  tabId: number
  sessionId: string
  pageSessionId: string
  /** Quantos ms esta gravação começou depois da sessão de página (o `desvioMs` do info.json). */
  skewMs: number
  /** O portão está aberto para esta aba agora (o que já foi mandado ao offscreen). */
  open: boolean
  everOpen: boolean
}

/** Sessões de microfone vivas, por aba. */
const byTab = new Map<number, MicSession>()
/** Último relato de cada aba (o `at` é o `Date.now()` da chegada). */
const reports = new Map<number, MicTabReport>()
/** Começos em andamento por aba (um segundo session:start não cria duas sessões). */
const starting = new Map<number, Promise<void>>()
let watch: ReturnType<typeof setInterval> | null = null

/** A voz está sendo gravada nesta aba agora? (diagnóstico e testes) */
export function micRecordingOn(tabId: number): boolean {
  return byTab.get(tabId)?.open === true
}

function ensureWatch() {
  if (watch || byTab.size === 0) return
  watch = setInterval(() => {
    if (byTab.size === 0) {
      clearInterval(watch!)
      watch = null
      return
    }
    void reconcile()
  }, WATCH_MS)
}

/**
 * Começa a gravação do microfone desta aba: sessão própria (`kind: 'microfone'`, pareada com a da
 * página, para o arquivo entrar na pasta da call) e o gravador no offscreen, já rodando e gravando
 * silêncio, para o arquivo ter a mesma base de tempo da gravação da call. NADA de microfone é aberto
 * aqui: o getUserMedia só acontece na primeira abertura do portão.
 */
async function startMic(e: { tabId: number; sessionId: string; startedAt: number }): Promise<void> {
  const settings = await loadSettings()
  if (!settings.micRecording) return
  if (byTab.has(e.tabId)) return
  const startedAt = Date.now()
  const rec = await createSession({
    tabId: e.tabId,
    frameId: 0,
    platform: (await getSession(e.sessionId))?.platform ?? 'outro',
    kind: 'microfone',
    localId: `microfone-${e.tabId}-${startedAt}`,
    startedAt,
    meta: {},
    port: null,
    pairedSessionId: e.sessionId,
  })
  const m: MicSession = {
    tabId: e.tabId,
    sessionId: rec.sessionId,
    pageSessionId: e.sessionId,
    skewMs: Math.max(0, startedAt - e.startedAt),
    open: false,
    everOpen: false,
  }
  // O desvio vai para o registro: é dele que o info.json tira o `desvioMs`, inclusive depois de o
  // SW reiniciar (a memória daqui não sobrevive).
  rec.micSkewMs = m.skewMs
  await putSession(rec)
  const r = await sendToOffscreen({ target: 'offscreen', t: 'offscreen:mic-start', tabId: e.tabId, sessionId: rec.sessionId }).catch((err: unknown) => ({
    ok: false,
    error: String((err as Error)?.message ?? err),
  }))
  if (!r.ok) {
    log('o offscreen não preparou o gravador do microfone', e.tabId, r.error)
    // Sem nenhum chunk, a finalização descarta a sessão (e o staging no helper).
    await stopSession(rec.sessionId)
    return
  }
  byTab.set(e.tabId, m)
  ensureWatch()
  log('microfone pronto', e.tabId, rec.sessionId, `desvio ${m.skewMs} ms da sessão de página`)
  // O relato que já chegou (a frame manda a cada 250 ms) vale desde já.
  await reconcile()
}

/** O relato de uma aba (session:mic). Nunca decide nada: só guarda e manda reconciliar. */
function reportMicTracks(tabId: number, tracks: readonly MicTrackState[], sinceMs: number): void {
  reports.set(tabId, { tabId, tracks, at: Date.now(), sinceMs })
  if (byTab.has(tabId)) void reconcile()
}

/**
 * Compara a decisão com o que já está aplicado e manda ao offscreen só o que mudou. Uma aba sem
 * relato nenhum (a frame nunca mandou, ou o SW reiniciou e perdeu) conta como FECHADA.
 */
async function reconcile(): Promise<void> {
  const now = Date.now()
  const d = micRouteDecide([...reports.values()].filter((r) => byTab.has(r.tabId)), now)
  const decided = new Map(d.tabs.map((t) => [t.tabId, t]))
  for (const m of [...byTab.values()]) {
    const t = decided.get(m.tabId) ?? { tabId: m.tabId, open: false, reason: 'sem-faixa' as const, waitMs: 0 }
    if (t.open === m.open) continue
    const r = await sendToOffscreen({ target: 'offscreen', t: 'offscreen:mic-gate', tabId: m.tabId, open: t.open, waitMs: t.waitMs }).catch(
      (err: unknown) => ({ ok: false, error: String((err as Error)?.message ?? err), permission: undefined }),
    )
    if (!r.ok) {
      // A abertura falhou (sem permissão, sem aparelho): o portão continua fechado, e o motivo vai
      // para o log. Nada é gravado, que é o lado seguro.
      log('o offscreen não aplicou o portão', m.tabId, t.open, r.error, r.permission ?? '')
      continue
    }
    m.open = t.open
    log('portão do microfone', m.tabId, t.open ? 'aberto' : `fechado (${t.reason})`, `em ${t.waitMs} ms`)
    if (t.open && !m.everOpen) {
      m.everOpen = true
      const rec = await getSession(m.sessionId)
      if (rec) {
        rec.micEverOpen = true
        await putSession(rec)
      }
    }
    await setMicRecordingBadge(m.tabId, t.open)
  }
  // Abas que não gravam mais (a frame sumiu) continuam com o relato velho; limpa o que não serve.
  for (const tabId of [...reports.keys()]) {
    if (!byTab.has(tabId) && now - (reports.get(tabId)?.at ?? 0) > MIC_REPORT_STALE_MS) reports.delete(tabId)
  }
}

/** Para a gravação do microfone de uma aba. */
async function stopMic(tabId: number, reason: EndReason): Promise<void> {
  const m = byTab.get(tabId)
  if (!m) return
  byTab.delete(tabId)
  reports.delete(tabId)
  await sendToOffscreen({ target: 'offscreen', t: 'offscreen:mic-stop', tabId, reason }).catch(() => ({ ok: false }))
  log('microfone parado', tabId, m.sessionId, reason, m.everOpen ? 'teve voz' : 'nunca abriu')
  await setMicRecordingBadge(tabId, false)
}

/** Estado do microfone no offscreen (só diagnóstico e testes; nunca áudio). */
export async function micState(): Promise<MicOffscreenState | null> {
  return sendToOffscreen({ target: 'offscreen', t: 'offscreen:mic-state' }).catch(() => null)
}

export function registerMic(): void {
  registerTestHooks({ micState, micRecordingOn, micSessions: () => [...byTab.values()] })
  onMicReport((e) => reportMicTracks(e.tabId, e.tracks, e.sinceMs))
  onPageSessionStarted((e) => {
    const p = (starting.get(e.tabId) ?? Promise.resolve())
      .then(() => startMic(e))
      .catch((err) => log('startMic', err))
      .finally(() => {
        if (starting.get(e.tabId) === p) starting.delete(e.tabId)
      })
    starting.set(e.tabId, p)
  })
  onPageSessionEnded((e) => {
    void stopMic(e.tabId, e.reason)
  })
  chrome.tabs.onRemoved.addListener((tabId) => {
    void stopMic(tabId, 'aba-fechada')
  })
}
