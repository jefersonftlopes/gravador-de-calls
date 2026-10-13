// Destino principal: o helper local por native messaging (grava na pasta escolhida, aos poucos,
// durante a call). Um único Port nativo, aberto sob demanda; ele também mantém o SW vivo
// enquanto há gravação (Chrome 105+).
//
// Emenda 20: o Port ocioso fecha sozinho. Sem isto, o popup e as configurações (que perguntam ao
// helper a cada 1 ou 2 s) deixavam o Port aberto para sempre: o processo do helper que o Chrome
// abriu continuava vivo com o código antigo depois de um `npm run instalar` (medido: um processo de
// 3 dias e 17 horas, e uma daily gravada com o helper 0.4.0 uma hora depois de instalar a 0.4.1).
// Com uma gravação em andamento o Port nunca fecha por aqui: o fim da gravação já o solta.
import { HOST_NAME } from '../shared/constants'
import { t } from '../shared/i18n'
import type { HelperStatus, HostExtraFile, HostRequest, HostRes, InfoJson, InfoTranscription, OrphanInfoJson, TranscriptionConfig } from '../shared/protocol'

const DEFAULT_TIMEOUT_MS = 15_000
const PING_CACHE_MS = 15_000
/**
 * Sem nenhum pedido ao helper por tanto tempo (e sem gravação), o Port fecha: acima do cache de 15 s
 * do ping e do intervalo de 2 s do popup, então com uma tela aberta ele continua.
 */
export const IDLE_RELEASE_MS = 30_000

interface Pending {
  resolve: (r: HostRes) => void
  timer: ReturnType<typeof setTimeout>
}

let port: chrome.runtime.Port | null = null
let nextId = 1
const pending = new Map<number, Pending>()
let lastStatus: HelperStatus = { ok: false, version: null, root: null, writable: false, error: 'ainda não verificado' }
let lastPingAt = 0
let idleTimer: ReturnType<typeof setTimeout> | null = null
let idleMs = IDLE_RELEASE_MS

/** Só os testes de ponta a ponta (gancho `hostIdleMs`): encurta a espera; null volta aos 30 s. */
export function setHostIdleMs(ms: number | null): void {
  idleMs = ms == null ? IDLE_RELEASE_MS : Math.max(0, ms)
}
/** Enquanto devolver true (há gravação), o Port ocioso não fecha. Quem sabe é o sessions.ts. */
let keepWhile: () => boolean = () => false

/** Registra a condição que segura o Port aberto mesmo ocioso (uma gravação em andamento). */
export function keepHostWhile(fn: () => boolean): void {
  keepWhile = fn
}

function clearIdle() {
  if (idleTimer !== null) clearTimeout(idleTimer)
  idleTimer = null
}

/** Com o Port aberto e nenhum pedido pendente, arma o fechamento por ociosidade. */
function armIdle() {
  clearIdle()
  if (!port || pending.size > 0) return
  idleTimer = setTimeout(() => {
    idleTimer = null
    let keep = true
    try {
      keep = keepWhile()
    } catch {
      // na dúvida, segura
    }
    if (!keep) releaseHost()
  }, idleMs)
}

function failAll(error: string) {
  for (const [id, p] of pending) {
    clearTimeout(p.timer)
    p.resolve({ id, ok: false, error })
  }
  pending.clear()
}

function ensurePort(): chrome.runtime.Port {
  if (port) return port
  const p = chrome.runtime.connectNative(HOST_NAME)
  p.onMessage.addListener((msg: HostRes) => {
    const entry = pending.get(msg?.id)
    if (!entry) return
    pending.delete(msg.id)
    clearTimeout(entry.timer)
    if (pending.size === 0) armIdle()
    entry.resolve(msg)
  })
  p.onDisconnect.addListener(() => {
    const error = chrome.runtime.lastError?.message ?? t('errHelperDisconnected')
    if (port === p) {
      port = null
      clearIdle()
    }
    lastStatus = { ok: false, version: null, root: null, writable: false, error }
    lastPingAt = Date.now()
    failAll(error)
  })
  port = p
  return p
}

/** Manda uma requisição ao helper. Nunca rejeita: falha vira `{ ok: false, error }`. */
export function hostRequest(req: HostRequest, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<HostRes> {
  const id = nextId++
  return new Promise((resolve) => {
    let p: chrome.runtime.Port
    // O fechamento armado antes não precisa ser cancelado aqui: o releaseHost recusa com pedido
    // pendente, e a resposta deste arma de novo.
    try {
      p = ensurePort()
    } catch (e) {
      resolve({ id, ok: false, error: String((e as Error)?.message ?? e) })
      return
    }
    const timer = setTimeout(() => {
      pending.delete(id)
      if (pending.size === 0) armIdle()
      resolve({ id, ok: false, error: t('errHelperTimeout', req.op, timeoutMs) })
    }, timeoutMs)
    pending.set(id, { resolve, timer })
    try {
      p.postMessage({ id, ...req })
    } catch (e) {
      pending.delete(id)
      clearTimeout(timer)
      if (pending.size === 0) armIdle()
      resolve({ id, ok: false, error: String((e as Error)?.message ?? e) })
    }
  })
}

/** O helper está instalado e respondendo? Usa cache de 15 s, salvo `force`. */
export async function pingHost(force = false): Promise<HelperStatus> {
  if (!force && Date.now() - lastPingAt < PING_CACHE_MS) return lastStatus
  const r = await hostRequest({ op: 'ping' }, 5000)
  lastPingAt = Date.now()
  lastStatus = r.ok
    ? { ok: true, version: String(r.version ?? ''), root: String(r.root ?? ''), writable: r.writable === true, error: null }
    : { ok: false, version: null, root: null, writable: false, error: r.error }
  return lastStatus
}

export function hostStatus(): HelperStatus {
  return lastStatus
}

/**
 * Fecha o Port nativo (deixa o SW dormir quando não há gravação). O processo do helper sai sozinho
 * no fim do stdin, e o próximo pedido abre um novo, com o código instalado agora.
 */
export function releaseHost(): void {
  if (!port || pending.size > 0) return
  clearIdle()
  try {
    port.disconnect()
  } catch {
    // já fechado
  }
  port = null
}

// Atalhos tipados ---------------------------------------------------------------------------

// A raiz é do helper (Emenda 1): nenhuma operação de gravação recebe `root`.
export const host = {
  getConfig: () => hostRequest({ op: 'get-config' }),
  setRoot: async (path: string) => {
    const r = await hostRequest({ op: 'set-root', path })
    lastPingAt = 0
    return r
  },
  checkRoot: (path: string) => hostRequest({ op: 'check-root', path }),
  chooseFolder: (prompt: string) => hostRequest({ op: 'choose-folder', prompt }, 10 * 60_000),
  begin: (sessionId: string, owner: string) => hostRequest({ op: 'begin', sessionId, owner }),
  append: (sessionId: string, file: string, seq: number, data: string) => hostRequest({ op: 'append', sessionId, file, seq, data }),
  /**
   * `extras` (Emenda 18): o falantes.json, escrito pelo helper antes do info.json.
   * `semTranscricao` (Emenda 21): o motor por API desta extensão vai transcrever, então o helper
   * não põe a pasta na fila do motor local.
   */
  finalize: (sessionId: string, relDir: string, info: InfoJson | OrphanInfoJson | null, merge = false, extras: HostExtraFile[] = [], semTranscricao = false) =>
    hostRequest({ op: 'finalize', sessionId, relDir, info, merge, ...(extras.length ? { extras } : {}), ...(semTranscricao ? { semTranscricao } : {}) }, 60_000),
  discard: (sessionId: string) => hostRequest({ op: 'discard', sessionId }),
  listStaging: (owner: string) => hostRequest({ op: 'list-staging', owner }),
  reveal: (path: string) => hostRequest({ op: 'reveal', path }),
  // Transcrição (Emenda 13): a configuração mora no helper, como a raiz.
  setTranscription: (patch: Partial<TranscriptionConfig>) => hostRequest({ op: 'set-transcription', patch }),
  transcriptionStatus: (paths: string[] = [], timeoutMs = 5000) => hostRequest({ op: 'transcription-status', paths }, timeoutMs),
  openFile: (path: string) => hostRequest({ op: 'open-file', path }),
  chooseFile: (prompt: string) => hostRequest({ op: 'choose-file', prompt }, 10 * 60_000),
  /** Emenda 21: a transcrição que a extensão fez, escrita na pasta da call pelo helper. */
  transcriptionWrite: (path: string, audio: string, arquivos: readonly HostExtraFile[], transcricao?: InfoTranscription) =>
    hostRequest({ op: 'transcription-write', path, audio, arquivos: [...arquivos], ...(transcricao ? { transcricao } : {}) }, 30_000),
}
