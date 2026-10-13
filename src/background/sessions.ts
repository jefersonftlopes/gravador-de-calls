// Registro de sessões por aba: recebe o Port do relay, grava cada chunk no IndexedDB ANTES do
// ack, transmite ao helper durante a call, finaliza (info.json + pasta) e recupera sessões
// abertas depois de uma queda (docs/ARQUITETURA.md, "Service worker").
import { PORT_SESSION, PORT_TAB, RECORDING_KBPS, RECORDING_MIME } from '../shared/constants'
import { base64ToBlob, blobToBase64 } from '../shared/base64'
import { format } from 'date-fns'
import { cleanTitle, makeSessionId, monthFolder, profileFolder, recordingRelDir, sanitizeComponent } from '../shared/naming'
import {
  parseUp,
  type ActiveRecording,
  type AutoLeaveInfo,
  type CallMeta,
  type CaptureDiag,
  type Down,
  type EndReason,
  type HostStagingEntry,
  type OrphanInfoJson,
  type PendingSave,
  type RecordingPlatform,
  type SessionKind,
  type Settings,
  type SinkKind,
  type Up,
} from '../shared/protocol'
import { ensureProfileId, loadSettings, pushRecent } from '../shared/settings'
import { languageReady, t } from '../shared/i18n'
import { autoAllowed, hasConsent, loadConsent } from '../shared/consent'
import { clearRecordingBadge, notifyNoAudio, notifySaveFailed, setBadge, setSaveWarning } from './badge'
import {
  deleteChunks,
  deleteSession,
  getChunks,
  getSession,
  listSessions,
  putChunkAndSession,
  putSession,
  type SessionRecord,
} from './idb'
import { queueApiTranscription } from './api-transcription'
import { closeTrailingGap } from './gaps'
import { buildInfo, iso, speakersOf, timeZone } from './info'
import { applySpeakersBatch } from '../shared/speakers'
import { SPEAKERS_FILE } from '../shared/constants'
import { host, hostStatus, keepHostWhile, pingHost, releaseHost, setHostIdleMs } from './sink-host'
import { saveViaDownloads } from './sink-downloads'
import { vigiaStatusOf } from './vigia-state'
import { registerTestHooks } from './testing'

/** Depois que o Port de uma frame cai sem session:end, espera isto antes de finalizar. */
const DISCONNECT_GRACE_MS = 3000
/** Fim por pagehide: espera um pouco para o tabs.onRemoved transformar em "aba-fechada". */
const PAGEHIDE_GRACE_MS = 1500
/** Recuperação: sessão aberta com a aba viva espera isto por um session:resume. */
const RECOVER_WAIT_MS = 30_000
/** Período do RECOVER_ALARM enquanto houver sessão aberta (o mínimo do Chrome 120+ é 30 s). */
const RECOVER_PERIOD_MIN = 1
/**
 * Recuperação: staging do helper deste perfil sem registro no IndexedDB, parado há isto, é
 * finalizado como "Gravação recuperada" (interrompida). Teste: testing.orphanIdleMs.
 */
const ORPHAN_IDLE_MS = 10 * 60_000
let orphanIdleMs = ORPHAN_IDLE_MS
/** Título da pasta de um staging órfão (sem registro, não se sabe a plataforma nem o título). */
export const ORPHAN_TITLE = 'Gravação recuperada'
/** Abrir a sessão (primeiro registro no IndexedDB): tentativas e espera entre elas. */
const CREATE_ATTEMPTS = 3
const CREATE_RETRY_MS = 1000
/** Gravar um chunk no IndexedDB: espera antes de cada nova tentativa (Emenda 10). */
const PERSIST_RETRY_MS = [300, 1000, 2000]
/** Streaming fora de sincronia: intervalo mínimo entre duas tentativas de recuperar no meio da call. */
const CATCH_UP_RETRY_MS = 15_000
/** Fim com chunks faltando (lastSeq > recebidos): espera o reenvio do relay. */
const MISSING_WAIT_MS = 5000
/** Sem fala desde o início por este tempo: badge em alerta (AC13). Teste: testing.noAudioAlertMs. */
const NO_AUDIO_ALERT_MS = 60_000
let noAudioAlertMs = NO_AUDIO_ALERT_MS

interface Runtime {
  rec: SessionRecord
  port: chrome.runtime.Port | null
  /** Fila serial do processamento da sessão (chunks, meta, fim). */
  chain: Promise<void>
  /** Fila serial dos appends no helper (não segura o ack). */
  hostChain: Promise<void>
  /** O streaming para o helper saiu de sincronia: no fim, reconstrói do IndexedDB. */
  hostDirty: boolean
  finishTimer: ReturnType<typeof setTimeout> | null
  pendingReason: EndReason | null
  finalizing: Promise<void> | null
  /** AC13: notificação de "sem áudio" já mostrada nesta sessão. */
  noAudioNotified: boolean
  /** onPageSessionEnded já avisado para esta sessão. */
  endNotified: boolean
  /**
   * Modo aba: a sessão de página pareada terminou (salva, descartada ou falhou ao salvar)
   * enquanto esta finalizava; ao terminar, finaliza de novo para decidir com o estado novo.
   */
  pairedWake: boolean
  /**
   * Um chunk não gravou no IndexedDB (Emenda 10): o SW derrubou o Port e espera o relay reenviar
   * a partir de `rec.nextSeq`. Até lá, os seguintes não têm ack nem viram lacuna.
   */
  awaitingResend: boolean
  /** Recuperação do streaming no meio da call (Emenda 10): rodando agora, e a última tentativa. */
  catchingUp: boolean
  lastCatchUpAt: number
  /** Emenda 10: uma tentativa de salvar falhou nesta vida do SW (o aviso já saiu). */
  saveFailed: boolean
}

const runtimes = new Map<string, Runtime>()
/** Emenda 20: o Port ocioso do helper fecha sozinho, menos com uma gravação em andamento. */
export const hasRecording = () => [...runtimes.values()].some((r) => r.rec.status === 'gravando')
keepHostWhile(hasRecording)
/** tabId -> sessionId ativo do tipo `pagina`. */
const activeByTab = new Map<number, string>()
const ports = new Set<chrome.runtime.Port>()
const log = (...a: unknown[]) => console.debug('[gravador sw]', ...a)

const extensionVersion = () => chrome.runtime.getManifest().version

function send(port: chrome.runtime.Port | null, msg: Down) {
  if (!port) return
  try {
    port.postMessage(msg)
  } catch (e) {
    log('postMessage', e)
  }
}

function enqueue(rt: Runtime, fn: () => Promise<void>): Promise<void> {
  rt.chain = rt.chain.then(fn).catch((e) => log('sessão', rt.rec.sessionId, e))
  return rt.chain
}

async function getRuntime(sessionId: string): Promise<Runtime | null> {
  const cached = runtimes.get(sessionId)
  if (cached) return cached
  const rec = await getSession(sessionId)
  if (!rec) return null
  // Pode ter sido carregado por outra chamada enquanto esperávamos o IndexedDB.
  const again = runtimes.get(sessionId)
  if (again) return again
  const rt: Runtime = {
    rec,
    port: null,
    chain: Promise.resolve(),
    hostChain: Promise.resolve(),
    hostDirty: true,
    finishTimer: null,
    pendingReason: null,
    finalizing: null,
    noAudioNotified: false,
    endNotified: false,
    pairedWake: false,
    awaitingResend: false,
    catchingUp: false,
    lastCatchUpAt: 0,
    saveFailed: false,
  }
  runtimes.set(sessionId, rt)
  if (rec.status === 'gravando' && rec.kind === 'pagina') activeByTab.set(rec.tabId, sessionId)
  return rt
}

// ---------------------------------------------------------------------------------------------
// Port do relay
// ---------------------------------------------------------------------------------------------

/**
 * Ports aceitos:
 * - "gravador:sessao": relay de uma frame de call (tem sender.tab).
 * - "gravador:aba": offscreen do modo aba (página da própria extensão, sem aba). Ele só manda
 *   chunk/meta/diag/end/resume de sessões que o SW criou com createSession({ kind: 'aba' }).
 */
export function registerSessionPorts(): void {
  registerTestHooks(testing)
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== PORT_SESSION && port.name !== PORT_TAB) return
    const fromExtension = !port.sender?.tab && (port.sender?.url ?? '').startsWith(chrome.runtime.getURL(''))
    if (port.name === PORT_SESSION ? port.sender?.tab?.id == null : !fromExtension) {
      port.disconnect()
      return
    }
    ports.add(port)
    // Uma fila por Port: as mensagens de uma frame são processadas na ordem em que chegaram.
    let chain = Promise.resolve()
    port.onMessage.addListener((raw: unknown) => {
      const msg = parseUp(raw)
      if (!msg) {
        log('mensagem inválida descartada', (raw as { t?: unknown })?.t)
        return
      }
      chain = chain.then(() => onUp(port, msg)).catch((e) => log('onUp', e))
    })
    port.onDisconnect.addListener(() => {
      ports.delete(port)
      for (const rt of runtimes.values()) {
        if (rt.port !== port) continue
        rt.port = null
        if (rt.rec.status === 'gravando') scheduleFinish(rt, rt.pendingReason ?? 'pagehide', DISCONNECT_GRACE_MS)
      }
    })
  })
}

async function onUp(port: chrome.runtime.Port, msg: Up): Promise<void> {
  // O offscreen não abre sessão nem recebe configurações: quem cria a sessão do modo aba é o SW.
  if (port.name === PORT_TAB && (msg.t === 'hello' || msg.t === 'session:start')) return
  switch (msg.t) {
    case 'hello': {
      send(port, await effectiveSettings())
      return
    }
    case 'session:start':
      return onStart(port, msg)
    case 'session:resume': {
      const rt = await getRuntime(msg.sessionId)
      if (!rt || rt.rec.status !== 'gravando') return
      // Cada Port retoma só o seu tipo: o relay as de página, o offscreen as do modo aba.
      if ((port.name === PORT_TAB) !== (rt.rec.kind === 'aba')) return
      rt.port = port
      cancelFinish(rt)
      // O índice por aba é só das sessões de página (o modo aba se liga ao Port no início, antes
      // do primeiro chunk, e não pode virar a sessão de página da aba). Emenda 7.
      if (rt.rec.kind === 'pagina') activeByTab.set(rt.rec.tabId, rt.rec.sessionId)
      log('sessão retomada', rt.rec.sessionId, 'próximo seq do relay', msg.nextSeq, 'gravados', rt.rec.nextSeq)
      return
    }
    case 'session:chunk': {
      const rt = await getRuntime(msg.sessionId)
      if (!rt) {
        // Sessão desconhecida (já salva e apagada): confirma para o relay soltar o chunk.
        send(port, { t: 'chunk:ack', sessionId: msg.sessionId, seq: msg.seq })
        return
      }
      rt.port = port
      return enqueue(rt, () => onChunk(rt, port, msg))
    }
    case 'session:meta': {
      const rt = await getRuntime(msg.sessionId)
      if (!rt) return
      return enqueue(rt, async () => {
        if (rt.rec.status === 'salva' || rt.rec.status === 'descartada') return
        rt.rec.meta = mergeMeta(rt.rec.meta, msg.meta)
        await putSession(rt.rec)
      })
    }
    case 'session:speakers': {
      const rt = await getRuntime(msg.sessionId)
      if (!rt || rt.rec.kind !== 'pagina') return
      return enqueue(rt, async () => {
        if (rt.rec.status === 'salva' || rt.rec.status === 'descartada') return
        const { record, applied } = applySpeakersBatch(rt.rec.speakers, msg)
        if (!applied) log('lote de falantes fora de ordem (o fim reenvia a linha inteira)', rt.rec.sessionId, msg.from, rt.rec.speakers?.intervals.length ?? 0)
        rt.rec.speakers = record
        await putSession(rt.rec)
      })
    }
    case 'session:diag': {
      const rt = await getRuntime(msg.sessionId)
      if (!rt) return
      return enqueue(rt, async () => {
        if (rt.rec.status === 'salva' || rt.rec.status === 'descartada') return
        rt.rec.diag = msg.diag
        rt.rec.seamSwitches = msg.diag.switches
        rt.rec.holds = msg.diag.holds
        await putSession(rt.rec)
        if (rt.rec.status === 'gravando') {
          const silent = !msg.diag.everHadSpeech && Date.now() - rt.rec.startedAt >= noAudioAlertMs
          await setBadge(rt.rec.tabId, silent ? 'rec-sem-audio' : 'rec')
          if (silent && !rt.noAudioNotified) {
            rt.noAudioNotified = true
            await notifyNoAudio(rt.rec.tabId, rt.rec.sessionId)
          }
        }
      })
    }
    case 'session:end': {
      const rt = await getRuntime(msg.sessionId)
      if (!rt || rt.rec.status !== 'gravando') return
      return enqueue(rt, async () => {
        rt.rec.endedAt = msg.endedAt
        rt.rec.lastSeq = msg.lastSeq
        await putSession(rt.rec)
        if (msg.reason === 'pagehide') scheduleFinish(rt, 'pagehide', PAGEHIDE_GRACE_MS)
        else scheduleFinish(rt, msg.reason, 0)
      })
    }
  }
}

function mergeMeta(a: Partial<CallMeta>, b: Partial<CallMeta>): Partial<CallMeta> {
  const out = { ...a, ...b }
  if (a.participants || b.participants) out.participants = [...new Set([...(a.participants ?? []), ...(b.participants ?? [])])]
  // Título mais forte não é trocado por um mais fraco.
  const rank = { dom: 3, 'titulo-da-aba': 2, codigo: 1, nenhum: 0 } as const
  if (a.titleSource && b.titleSource && rank[b.titleSource] < rank[a.titleSource]) {
    out.title = a.title
    out.titleSource = a.titleSource
  }
  return out
}

async function onStart(port: chrome.runtime.Port, msg: Extract<Up, { t: 'session:start' }>): Promise<void> {
  const tabId = port.sender!.tab!.id!
  const frameId = port.sender?.frameId ?? 0
  const settings = await loadSettings()
  const enabled = msg.platform === 'meet' ? settings.autoMeet : settings.autoTeams
  if (!enabled) return send(port, { t: 'session:rejected', localId: msg.localId, reason: 'disabled' })
  // Emenda 15: sem o aviso da primeira execução confirmado, a gravação automática não começa (o
  // settings do hello já diz isso ao MAIN world; isto cobre um session:start que chegue antes).
  if (!(await hasConsent())) return send(port, { t: 'session:rejected', localId: msg.localId, reason: 'no-consent' })

  const currentId = activeByTab.get(tabId)
  if (currentId) {
    const cur = runtimes.get(currentId)
    if (cur && cur.rec.localId === msg.localId) {
      // session:start reenviado depois de reconectar: a sessão já existe.
      cur.port = port
      return send(port, { t: 'session:accepted', localId: msg.localId, sessionId: cur.rec.sessionId })
    }
    if (cur && cur.rec.status === 'gravando' && cur.rec.frameId !== frameId) {
      return send(port, { t: 'session:rejected', localId: msg.localId, reason: 'other-frame' })
    }
    if (cur && cur.rec.status === 'gravando') {
      // A mesma frame abriu outra sessão sem fechar a anterior: fecha a anterior.
      void finalize(cur, 'call-encerrada')
    }
  }

  const opts: NewSession = {
    tabId,
    frameId,
    platform: msg.platform,
    kind: 'pagina',
    localId: msg.localId,
    startedAt: msg.startedAt,
    meta: { ...msg.meta, url: msg.meta.url ?? port.sender?.url ?? '' },
    port,
  }
  // O primeiro registro no IndexedDB pode falhar (disco cheio, banco fechando): tenta de novo e,
  // sem jeito, recusa. Sem resposta, o MAIN world gravaria a call inteira no vazio (Emenda 10).
  let rec: SessionRecord | null = null
  for (let attempt = 0; attempt < CREATE_ATTEMPTS && !rec; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, CREATE_RETRY_MS))
    try {
      rec = await createSession(opts)
    } catch (e) {
      log('não foi possível abrir a sessão', attempt + 1, e)
    }
  }
  if (!rec) return send(port, { t: 'session:rejected', localId: msg.localId, reason: 'other' })
  const sessionId = rec.sessionId
  send(port, { t: 'session:accepted', localId: msg.localId, sessionId })
  log('sessão aceita', sessionId, 'destino', rec.sink)
}

export interface NewSession {
  tabId: number
  frameId: number
  platform: RecordingPlatform
  kind: SessionKind
  /** ID local de quem grava (frame ou offscreen), para deduplicar inícios reenviados. */
  localId: string
  startedAt: number
  meta: Partial<CallMeta>
  /** Port que vai mandar os chunks (null: o offscreen conecta depois pelo "gravador:aba"). */
  port: chrome.runtime.Port | null
  /** Modo aba: sessão de página da mesma aba. */
  pairedSessionId?: string | null
}

/**
 * Cria e registra uma sessão (página ou modo aba): escolhe o destino, faz o begin no helper,
 * grava no IndexedDB, marca a aba (badge REC, sem descarte automático).
 */
export async function createSession(opts: NewSession): Promise<SessionRecord> {
  const settings = await loadSettings()
  const owner = await ensureProfileId()
  const bootId = await currentBootId()
  const sessionId = makeSessionId(opts.startedAt, opts.tabId)
  const status = await pingHost()
  const rec: SessionRecord = {
    sessionId,
    localId: opts.localId,
    tabId: opts.tabId,
    frameId: opts.frameId,
    platform: opts.platform,
    kind: opts.kind,
    status: 'gravando',
    startedAt: opts.startedAt,
    endedAt: null,
    endReason: null,
    meta: opts.meta,
    diag: null,
    seamSwitches: [],
    holds: [],
    nextSeq: 0,
    lastSeq: null,
    bytes: 0,
    lastChunkAt: null,
    gaps: [],
    // Emenda 10: um helper que responde mas não grava na raiz (disco externo desconectado, sem
    // permissão) começa em downloads em vez de falhar o begin.
    sink: status.ok && status.writable ? 'host' : 'downloads',
    root: status.root ?? '',
    owner,
    profileLabel: settings.profileLabel,
    autoLeave: null,
    hostFlushedSeq: 0,
    file: opts.kind === 'aba' ? 'audio-aba.webm' : 'audio.webm',
    pairedSessionId: opts.pairedSessionId ?? null,
    savedPath: null,
    lastError: status.ok ? (status.writable ? null : t('errNoWritePermissionAt', status.root ?? '')) : status.error,
    bootId,
    downloadInfo: null,
  }
  // O registro vai para o IndexedDB ANTES do begin: a recuperação trata como órfão um staging
  // do helper sem registro, então o staging nunca pode nascer antes do registro.
  await putSession(rec)
  let hostDirty = !(status.ok && status.writable)
  if (status.ok && status.writable) {
    const r = await host.begin(sessionId, owner)
    if (r.ok) rec.root = String(r.root ?? rec.root)
    else {
      rec.lastError = r.error
      hostDirty = true
    }
    await putSession(rec)
  }
  ensureRecoverAlarm()
  const rt: Runtime = {
    rec,
    port: opts.port,
    chain: Promise.resolve(),
    hostChain: Promise.resolve(),
    hostDirty,
    finishTimer: null,
    pendingReason: null,
    finalizing: null,
    noAudioNotified: false,
    endNotified: false,
    pairedWake: false,
    awaitingResend: false,
    catchingUp: false,
    lastCatchUpAt: 0,
    saveFailed: false,
  }
  runtimes.set(sessionId, rt)
  if (opts.kind === 'pagina') activeByTab.set(opts.tabId, sessionId)
  await setBadge(opts.tabId, 'rec')
  // A aba que grava não pode ser descartada pelo Chrome para economizar memória.
  Promise.resolve(chrome.tabs.update(opts.tabId, { autoDiscardable: false })).catch(() => {})
  return rec
}

async function onChunk(rt: Runtime, port: chrome.runtime.Port, msg: Extract<Up, { t: 'session:chunk' }>): Promise<void> {
  const rec = rt.rec
  const ack = () => send(port, { t: 'chunk:ack', sessionId: rec.sessionId, seq: msg.seq })
  if (rec.status !== 'gravando' && rec.status !== 'finalizando') return ack()
  if (msg.seq < rec.nextSeq) return ack()
  // Esperando o reenvio de um chunk que não gravou: os seguintes voltam com ele, em ordem.
  if (rt.awaitingResend && msg.seq > rec.nextSeq) return
  const before = { nextSeq: rec.nextSeq, bytes: rec.bytes, lastChunkAt: rec.lastChunkAt, gaps: rec.gaps, hostDirty: rt.hostDirty }
  if (msg.seq > rec.nextSeq) {
    rec.gaps = [...rec.gaps, { fromSeq: rec.nextSeq, toSeq: msg.seq - 1 }]
    rt.hostDirty = true
  }
  const blob = base64ToBlob(msg.data, RECORDING_MIME)
  rec.nextSeq = msg.seq + 1
  rec.bytes += blob.size
  rec.lastChunkAt = msg.at
  // AC10: o ack só sai depois do chunk estar no IndexedDB. Se o SW cair antes, o relay ainda tem
  // o chunk e reenvia ao reconectar (tests/e2e/fatia1-queda.spec.ts derruba o SW exatamente aqui).
  try {
    await persistChunkWithRetry({ sessionId: rec.sessionId, seq: msg.seq, data: blob, at: msg.at }, rec)
  } catch (e) {
    // Emenda 10: nada avança (o seq continua esperado, sem lacuna inventada) e nada é confirmado.
    // O Port cai de propósito: o relay reconecta e reenvia em ordem tudo o que não teve ack.
    Object.assign(rec, { nextSeq: before.nextSeq, bytes: before.bytes, lastChunkAt: before.lastChunkAt, gaps: before.gaps })
    rt.hostDirty = before.hostDirty
    rec.lastError = `IndexedDB: ${String((e as Error)?.message ?? e)}`
    rt.awaitingResend = true
    log('chunk não gravou no IndexedDB; pedindo o reenvio', rec.sessionId, msg.seq, e)
    dropPortForResend(port)
    return
  }
  rt.awaitingResend = false
  ack()
  if (rec.sink === 'host' && !rt.hostDirty) {
    const seq = msg.seq
    const data = msg.data
    rt.hostChain = rt.hostChain.then(() => streamToHost(rt, seq, data)).catch((e) => log('helper', e))
  } else maybeCatchUpHost(rt)
}

/**
 * O streaming para o helper saiu de sincronia (o SW reiniciou, um append estourou o tempo, ou a
 * sessão começou em downloads com o ping em cache): completa do IndexedDB agora, durante a call,
 * e volta a mandar cada chunk. Sem isso, o fim de uma call longa reenviava tudo, um append por
 * vez (Emenda 10). Com lacuna fica para o fim (o arquivo é refeito do zero lá).
 */
function maybeCatchUpHost(rt: Runtime): void {
  const rec = rt.rec
  if (rt.catchingUp || rec.status !== 'gravando' || rec.gaps.length > 0) return
  if (Date.now() - rt.lastCatchUpAt < CATCH_UP_RETRY_MS) return
  rt.catchingUp = true
  rt.hostChain = rt.hostChain
    .then(() => catchUpHost(rt))
    .catch((e) => log('helper (recuperar o streaming)', e))
    .finally(() => {
      rt.catchingUp = false
    })
}

async function catchUpHost(rt: Runtime): Promise<void> {
  const rec = rt.rec
  // Sem helper: tenta no próximo chunk (o ping tem cache de 15 s, então não insiste mais que isso).
  const status = await pingHost()
  if (!status.ok || !status.writable) return
  rt.lastCatchUpAt = Date.now()
  // Chunks que chegam enquanto isto roda entram no IndexedDB: mais uma passada os pega.
  for (let pass = 0; pass < 3; pass++) {
    if (rec.status !== 'gravando' || rec.gaps.length > 0) return
    const flushed = await flushToHost(rt)
    if (!flushed.ok || flushed.donePath) return
    if (rec.hostFlushedSeq >= rec.nextSeq) {
      rec.sink = 'host'
      rt.hostDirty = false
      log('streaming para o helper retomado', rec.sessionId, 'em', rec.hostFlushedSeq)
      return
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Ganchos de teste (Playwright, por __gravador.testing no SW). O produto nunca os arma.
// ---------------------------------------------------------------------------------------------

/** Quanto um chunk segurado espera antes de seguir (o teste derruba o SW bem antes disso). */
const TEST_HOLD_MAX_MS = 60_000
let holdPersistSeq: number | null = null
let heldPersistSeq: number | null = null
let finalizeDelayMs = 0

export const testing = {
  /**
   * O chunk com este seq (de qualquer sessão) para ANTES de ser gravado no IndexedDB, por até
   * 60 s. Serve para o teste derrubar o SW entre receber o chunk e gravá-lo.
   */
  holdPersistAt(seq: number | null): void {
    holdPersistSeq = seq
    heldPersistSeq = null
  },
  /** seq do chunk que está segurado agora (null se nenhum). */
  heldPersistSeq: (): number | null => heldPersistSeq,
  /**
   * Atrasa cada finalização em `ms` logo depois de a sessão virar "finalizando" (como um helper
   * lento com um arquivo grande). Abre uma janela entre "todos os chunks no IndexedDB" e "salva"
   * para o teste provar que a espera do vigia vai até o fim.
   */
  delayFinalize(ms: number): void {
    finalizeDelayMs = Math.max(0, ms)
  },
  /**
   * AC13 sem esperar 60 s: o alerta de "sem áudio" passa a valer depois de `ms` (null volta ao
   * padrão). Vale para as sessões já abertas, no próximo session:diag (a cada 5 s).
   */
  noAudioAlertMs(ms: number | null): void {
    noAudioAlertMs = ms == null ? NO_AUDIO_ALERT_MS : Math.max(0, ms)
  },
  /**
   * Staging órfão (do helper, deste perfil, sem registro no IndexedDB) passa a ser recuperado
   * depois de `ms` parado, em vez de 10 min (null volta ao padrão).
   */
  orphanIdleMs(ms: number | null): void {
    orphanIdleMs = ms == null ? ORPHAN_IDLE_MS : Math.max(0, ms)
  },
  /** Roda uma passada da recuperação agora (a mesma do início do SW e do RECOVER_ALARM). */
  recoverNow: (): Promise<void> => recoverSessions(),
  /** Emenda 20: o Port ocioso do helper fecha depois de `ms` em vez de 30 s (null volta ao padrão). */
  hostIdleMs(ms: number | null): void {
    setHostIdleMs(ms)
  },
}

/** Grava o chunk, tentando de novo (o idb.ts reabre a conexão que fechou). Lança se nada der. */
async function persistChunkWithRetry(chunk: Parameters<typeof putChunkAndSession>[0], rec: SessionRecord): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await persistChunk(chunk, rec)
    } catch (e) {
      if (attempt >= PERSIST_RETRY_MS.length) throw e
      log('IndexedDB falhou, tentando de novo', chunk.sessionId, chunk.seq, e)
      await new Promise((r) => setTimeout(r, PERSIST_RETRY_MS[attempt]))
    }
  }
}

/**
 * Derruba o Port de uma frame para o relay reconectar e reenviar o que não teve ack (o mesmo
 * caminho de um SW que reiniciou). Sem o onDisconnect deste lado (ele só dispara no outro): as
 * sessões soltam o Port sem marcar fim; o relay volta com session:resume. Se ele não voltar, a
 * recuperação por alarme trata a sessão como qualquer outra sem Port.
 */
function dropPortForResend(port: chrome.runtime.Port): void {
  ports.delete(port)
  for (const r of runtimes.values()) if (r.port === port) r.port = null
  try {
    port.disconnect()
  } catch {
    // já caiu
  }
}

async function persistChunk(chunk: Parameters<typeof putChunkAndSession>[0], rec: SessionRecord): Promise<void> {
  if (holdPersistSeq !== null && chunk.seq === holdPersistSeq) {
    holdPersistSeq = null
    heldPersistSeq = chunk.seq
    log('teste: segurando o chunk', chunk.seq, 'antes do IndexedDB')
    await new Promise((r) => setTimeout(r, TEST_HOLD_MAX_MS))
    heldPersistSeq = null
  }
  await putChunkAndSession(chunk, rec)
}

/** Append durante a call. Se sair de ordem, marca para reconstruir/completar no fim. */
async function streamToHost(rt: Runtime, seq: number, data: string): Promise<void> {
  const rec = rt.rec
  if (rt.hostDirty) return
  if (seq !== rec.hostFlushedSeq) {
    rt.hostDirty = true
    return
  }
  const r = await host.append(rec.sessionId, rec.file, seq, data)
  if (r.ok) rec.hostFlushedSeq = seq + 1
  else {
    if (typeof r.expected === 'number') rec.hostFlushedSeq = r.expected
    rt.hostDirty = true
    log('append recusado', r.error)
  }
}

/**
 * Completa o arquivo no helper a partir do IndexedDB (ordinal = posição do chunk). `donePath`: o
 * helper já tinha finalizado esta sessão (o SW morreu antes de marcar "salva"; Emenda 10), e a
 * pasta é essa, sem reenviar nada.
 */
async function flushToHost(rt: Runtime): Promise<{ ok: boolean; donePath: string | null }> {
  const rec = rt.rec
  const begin = await host.begin(rec.sessionId, rec.owner || (await ensureProfileId()))
  if (!begin.ok) {
    rec.lastError = begin.error
    return { ok: false, donePath: null }
  }
  if (begin.done === true && typeof begin.path === 'string') return { ok: true, donePath: begin.path }
  const chunks = await getChunks(rec.sessionId)
  let i = rec.hostFlushedSeq
  let guard = chunks.length * 2 + 4
  while (i < chunks.length && guard-- > 0) {
    const data = await blobToBase64(chunks[i].data)
    const r = await host.append(rec.sessionId, rec.file, i, data)
    if (r.ok) {
      i++
      rec.hostFlushedSeq = i
      continue
    }
    if (typeof r.expected === 'number' && r.expected <= chunks.length) {
      i = r.expected
      rec.hostFlushedSeq = i
      continue
    }
    rec.lastError = r.error
    return { ok: false, donePath: null }
  }
  return { ok: i >= chunks.length, donePath: null }
}

// ---------------------------------------------------------------------------------------------
// Fim
// ---------------------------------------------------------------------------------------------

function cancelFinish(rt: Runtime) {
  if (rt.finishTimer) clearTimeout(rt.finishTimer)
  rt.finishTimer = null
}

function scheduleFinish(rt: Runtime, reason: EndReason, delayMs: number) {
  rt.pendingReason = reason
  cancelFinish(rt)
  rt.finishTimer = setTimeout(() => {
    rt.finishTimer = null
    void finalize(rt, rt.pendingReason ?? reason)
  }, delayMs)
}

/** Para pelo popup: pede ao MAIN world; sem resposta em 10 s, finaliza com o que houver. */
export async function stopSession(sessionId: string): Promise<boolean> {
  const rt = await getRuntime(sessionId)
  if (!rt || rt.rec.status !== 'gravando') return false
  if (rt.port) {
    send(rt.port, { t: 'session:stop', sessionId, reason: 'user' })
    scheduleFinish(rt, 'parado-pelo-usuario', 10_000)
  } else void finalize(rt, 'parado-pelo-usuario')
  return true
}

export function onTabRemoved(tabId: number): void {
  // Fechar a aba é fim normal (SUPOSIÇÃO do ESPEC), não "interrompida". Vale para a sessão de
  // página e para a do modo aba.
  for (const rt of runtimes.values()) {
    if (rt.rec.tabId === tabId && rt.rec.status === 'gravando') scheduleFinish(rt, 'aba-fechada', 300)
  }
}

function finalize(rt: Runtime, reason: EndReason): Promise<void> {
  if (rt.finalizing) return rt.finalizing
  cancelFinish(rt)
  // A espera pelos chunks faltando fica FORA da fila da sessão: eles entram por ela.
  rt.finalizing = waitMissingChunks(rt)
    .then(() => enqueue(rt, () => doFinalize(rt, reason)))
    .finally(() => {
      rt.finalizing = null
      if (rt.rec.kind === 'pagina') wakePairedTabSessions(rt.rec.sessionId)
      else if (rt.pairedWake) {
        rt.pairedWake = false
        if (rt.rec.status === 'finalizando') void finalize(rt, rt.rec.endReason ?? reason)
      }
    })
  return rt.finalizing
}

/**
 * A sessão de página terminou a tentativa de finalizar, qualquer que seja o resultado (salva,
 * descartada por ser curta, ou falhou ao salvar). Acorda as sessões do modo aba pareadas que
 * esperavam por ela: com a página salva, o arquivo entra na pasta dela; descartada ou com falha,
 * o modo aba salva na pasta própria. Fica no `finally` para nenhum caminho esquecer.
 */
function wakePairedTabSessions(pageSessionId: string): void {
  for (const other of runtimes.values()) {
    if (other.rec.kind !== 'aba' || other.rec.pairedSessionId !== pageSessionId) continue
    if (other.finalizing) other.pairedWake = true
    else if (other.rec.status === 'finalizando') void finalize(other, other.rec.endReason ?? 'call-encerrada')
  }
}

/**
 * Modo aba: a sessão de página pareada ainda pode salvar (grava, ou finaliza agora)? Em memória
 * o estado é o mais novo; sem runtime (SW reiniciado), vale o IndexedDB, e a recuperação vai
 * finalizar a página e acordar esta sessão.
 */
async function pairedPageState(pageSessionId: string): Promise<{ pending: boolean; rec: SessionRecord | undefined }> {
  const page = runtimes.get(pageSessionId)
  if (page) return { pending: page.rec.status === 'gravando' || page.finalizing !== null, rec: page.rec }
  const rec = await getSession(pageSessionId)
  return { pending: rec?.status === 'gravando' || rec?.status === 'finalizando', rec }
}

async function waitMissingChunks(rt: Runtime) {
  const t0 = Date.now()
  while (rt.rec.lastSeq !== null && rt.rec.nextSeq <= rt.rec.lastSeq && Date.now() - t0 < MISSING_WAIT_MS) {
    await new Promise((r) => setTimeout(r, 250))
  }
}

async function doFinalize(rt: Runtime, reasonIn: EndReason): Promise<void> {
  const rec = rt.rec
  if (rec.status === 'salva' || rec.status === 'descartada') return
  notifyPageSessionEnded(rt, reasonIn)
  const interrupted = reasonIn === 'interrompida'
  // O vigia avisou antes de clicar em sair: o fim foi automático (Emenda 2).
  const reason: EndReason = rec.autoLeave && !interrupted ? 'saida-automatica' : reasonIn
  rec.status = 'finalizando'
  rec.endReason = reason
  rec.endedAt ??= rec.lastChunkAt ?? Date.now()
  // Chunks anunciados no session:end que nunca chegaram (rabo do pagehide, relay que caiu):
  // viram lacuna no info.json em vez de sumir calados.
  rec.gaps = closeTrailingGap(rec.gaps, rec.nextSeq, rec.lastSeq)
  await putSession(rec)
  if (finalizeDelayMs > 0) await new Promise((r) => setTimeout(r, finalizeDelayMs))
  await rt.hostChain
  const settings: Settings = await loadSettings()
  // Emenda 19: os nomes da pasta, os rótulos dos falantes e o idioma do info.json saem no idioma
  // escolhido, também na recuperação logo depois de o SW subir.
  await languageReady()
  const duration = (rec.endedAt - rec.startedAt) / 1000

  if (duration < settings.minSeconds || rec.nextSeq === 0) {
    if (rec.sink === 'host' || hostStatus().ok) await host.discard(rec.sessionId)
    await deleteChunks(rec.sessionId)
    rec.status = 'descartada'
    // Emenda 10: a call que ele não quis guardar não deixa título, URL nem participantes no
    // perfil. O registro em si fica (a recuperação o usa para apagar uma sobra de staging).
    rec.meta = {}
    rec.diag = null
    rec.speakers = null
    await putSession(rec)
    log('descartada', rec.sessionId, `${duration.toFixed(1)} s`)
    return cleanup(rt)
  }

  // Modo aba com sessão de página na mesma aba: o arquivo vai para a pasta dela. Se a página
  // ainda grava, espera (a finalização da página chama de novo esta sessão).
  const pairedState = rec.kind === 'aba' && rec.pairedSessionId ? await pairedPageState(rec.pairedSessionId) : null
  const paired = pairedState?.rec
  if (paired && pairedState.pending) {
    await putSession(rec)
    log('modo aba aguardando a sessão de página', rec.sessionId, paired.sessionId)
    return
  }
  const mergeInto = paired?.status === 'salva' && paired.sink === 'host' && paired.savedPath ? paired : null

  const helper = await pingHost(true)
  const helperVersion = helper.ok ? helper.version : null
  let info = buildInfo(rec, { interrupted, extensionVersion: extensionVersion(), helperVersion })
  let relDir = recordingRelDir({
    startedAt: rec.startedAt,
    title: rec.meta.title,
    code: rec.meta.code,
    platform: rec.platform,
    profileLabel: rec.profileLabel,
  })
  if (mergeInto) {
    // Pasta real da página (pode ter sufixo " (2)") e info.json dela com os dois arquivos.
    const levels = profileFolder(mergeInto.profileLabel) ? 3 : 2
    relDir = mergeInto.savedPath!.split('/').slice(-levels).join('/')
    const pageInfo = buildInfo(mergeInto, {
      interrupted: mergeInto.endReason === 'interrompida',
      extensionVersion: extensionVersion(),
      helperVersion,
    })
    info = { ...pageInfo, arquivos: [...pageInfo.arquivos, ...info.arquivos] }
  }
  let savedPath: string | null = null
  let downloadId: number | undefined
  let sink: SinkKind = rec.sink ?? 'host'
  // Emenda 18: a linha do tempo dos falantes vai como falantes.json (o modo aba que entra na pasta
  // da página não tem linha própria; a da página já está lá).
  const speakers = mergeInto ? null : speakersOf(rec)
  const extras = speakers ? [{ nome: SPEAKERS_FILE, texto: JSON.stringify(speakers.file, null, 2) + '\n' }] : []
  // Emenda 21: com o motor por API ligado neste perfil, o helper NÃO põe a pasta na fila do motor
  // local (senão os dois escreveriam o mesmo transcricao.md); quem transcreve é a extensão.
  const apiEngine = settings.apiTranscription.ativa

  if (helper.ok) {
    if (rt.hostDirty && rec.gaps.length > 0) {
      // Com lacuna o streaming parou no meio: recomeça o arquivo do zero a partir do IndexedDB.
      await host.discard(rec.sessionId)
      rec.hostFlushedSeq = 0
    }
    const flushed = await flushToHost(rt)
    if (flushed.donePath) {
      savedPath = flushed.donePath
      sink = 'host'
    } else if (flushed.ok) {
      const r = await host.finalize(rec.sessionId, relDir, info, mergeInto !== null, extras, apiEngine)
      if (r.ok) {
        savedPath = String(r.path)
        sink = 'host'
      } else rec.lastError = r.error
    }
  }
  if (!savedPath) {
    try {
      const r = await saveViaDownloads(rec, relDir, { ...info, helper: null }, extras)
      savedPath = r.path
      downloadId = r.downloadId
      sink = 'downloads'
    } catch (e) {
      rec.lastError = String((e as Error)?.message ?? e)
    }
  }
  if (!savedPath) {
    // Nada se perde: os chunks continuam no IndexedDB e a recuperação tenta de novo. Emenda 10:
    // sem o REC, o usuário achava que estava salvo; o popup lista a pendente e um aviso sai uma vez.
    await putSession(rec)
    log('não foi possível salvar', rec.sessionId, rec.lastError)
    const first = !rt.saveFailed
    rt.saveFailed = true
    cleanup(rt, false)
    if (first) void notifySaveFailed(pendingSaves().length)
    return
  }

  rec.status = 'salva'
  rec.sink = sink
  rec.savedPath = savedPath
  rec.lastError = null
  await putSession(rec)
  // Emenda 21: ANTES do deleteChunks, porque é só daqui que o áudio pode ser guardado para a
  // transcrição por API (a extensão não consegue ler de volta o arquivo que o helper gravou).
  // Desligado, isto não guarda nada e nada é enviado.
  if (apiEngine) {
    await queueApiTranscription({ rec, info, speakers: speakers?.file ?? null, savedPath, sink }).catch((e) => log('transcrição por API', e))
  }
  await deleteChunks(rec.sessionId)
  await pushRecent({
    sessionId: rec.sessionId,
    platform: rec.platform,
    kind: rec.kind,
    // Sem título, vazio (Emenda 19): o popup mostra o "Sem título" no idioma de quando mostra.
    title: cleanTitle(rec.meta.title, rec.meta.code),
    startedAt: rec.startedAt,
    endedAt: rec.endedAt,
    durationSeconds: info.duracaoSegundos,
    path: savedPath,
    sink,
    ...(downloadId !== undefined ? { downloadId } : {}),
    status: info.status,
  })
  log('salva', rec.sessionId, savedPath)
  // As sessões do modo aba que esperavam esta página são acordadas no finally de finalize().
  cleanup(rt)
}

function cleanup(rt: Runtime, forget = true) {
  const rec = rt.rec
  if (activeByTab.get(rec.tabId) === rec.sessionId) activeByTab.delete(rec.tabId)
  if (forget) runtimes.delete(rec.sessionId)
  // Outra gravação na mesma aba (página e modo aba juntos): a aba continua marcada e sem
  // descarte automático até a última terminar.
  const tabStillRecording = [...runtimes.values()].some((r) => r !== rt && r.rec.tabId === rec.tabId && r.rec.status === 'gravando')
  if (!tabStillRecording) {
    void clearRecordingBadge(rec.tabId)
    Promise.resolve(chrome.tabs.update(rec.tabId, { autoDiscardable: true })).catch(() => {})
  }
  if (!hasRecording()) releaseHost()
  void maybeClearRecoverAlarm()
  void setSaveWarning(pendingSaves().length)
}

// ---------------------------------------------------------------------------------------------
// Ligações com o vigia (Emenda 2)
// ---------------------------------------------------------------------------------------------

function pageRuntimeOfTab(tabId: number): Runtime | null {
  const id = activeByTab.get(tabId)
  return (id && runtimes.get(id)) || null
}

/**
 * O vigia vai sair sozinho desta aba: o fim da gravação vira "saida-automatica" e o info.json
 * ganha `saidaAutomatica` (gravado no IndexedDB, então sobrevive a um reinício do SW). `null`
 * desfaz (o vigia desistiu de sair, Meet sem botão seguro: o fim volta a ser o da plataforma).
 */
export async function setAutoLeave(tabId: number, info: AutoLeaveInfo | null): Promise<void> {
  const rt = pageRuntimeOfTab(tabId)
  if (!rt || rt.rec.status !== 'gravando') return
  await enqueue(rt, async () => {
    rt.rec.autoLeave = info
    await putSession(rt.rec)
  })
}

/**
 * Espera a sessão de página que a aba tem AGORA ficar salva (helper ou downloads terminaram e o
 * info.json existe) ou ser descartada (curta demais). Sem sessão, resolve na hora. Devolve se
 * conseguiu antes do limite. É o que o vigia usa antes de fechar a aba (ESPEC AC18: "a aba só
 * fecha depois que a gravação daquela call foi salva"; Emenda 4 da ARQUITETURA).
 */
export async function waitTabSessionSaved(tabId: number, timeoutMs: number): Promise<boolean> {
  const t0 = Date.now()
  // Emenda 10: a sessão de página da aba que tentou salvar e falhou (já fora do activeByTab) também
  // conta: ela não está salva, e a espera não pode dizer que está.
  const sessionId = activeByTab.get(tabId) ?? failedPageSessionOf(tabId)
  if (!sessionId) return true
  for (;;) {
    // Depois de salva, a sessão sai da memória (cleanup): o estado final está no IndexedDB.
    const rt = runtimes.get(sessionId)
    const status = rt?.rec.status ?? (await getSession(sessionId))?.status ?? null
    if (status === 'salva' || status === 'descartada' || status === null) return true
    // A tentativa terminou com falha: esperar o limite não muda nada (a recuperação tenta de novo
    // a cada minuto, com os chunks no IndexedDB). Devolve false na hora.
    if (rt && status === 'finalizando' && rt.saveFailed && !rt.finalizing) return false
    if (Date.now() - t0 >= timeoutMs) return false
    await new Promise((r) => setTimeout(r, 200))
  }
}

function failedPageSessionOf(tabId: number): string | undefined {
  for (const rt of runtimes.values()) {
    if (rt.rec.kind === 'pagina' && rt.rec.tabId === tabId && rt.rec.status === 'finalizando' && rt.saveFailed) return rt.rec.sessionId
  }
  return undefined
}

// ---------------------------------------------------------------------------------------------
// Fim da sessão de página (para o modo aba parar junto, ARQUITETURA "Modo aba")
// ---------------------------------------------------------------------------------------------

export interface PageSessionEnded {
  tabId: number
  sessionId: string
  /** Motivo com que a finalização começou (o info.json pode trocar por saida-automatica). */
  reason: EndReason
}

const pageEndListeners = new Set<(e: PageSessionEnded) => void>()

/**
 * Avisa quando uma sessão de página começa a finalizar (a call acabou, a aba fechou, o usuário
 * parou, ou a recuperação fechou uma sessão interrompida). Uma vez por sessão enquanto o SW
 * vive; depois de um reinício pode repetir, então o ouvinte precisa ser idempotente.
 * Registrar no carregamento do SW (ex.: dentro de registerTabCapture()).
 */
export function onPageSessionEnded(cb: (e: PageSessionEnded) => void): () => void {
  pageEndListeners.add(cb)
  return () => pageEndListeners.delete(cb)
}

function notifyPageSessionEnded(rt: Runtime, reason: EndReason): void {
  if (rt.rec.kind !== 'pagina' || rt.endNotified) return
  rt.endNotified = true
  const e: PageSessionEnded = { tabId: rt.rec.tabId, sessionId: rt.rec.sessionId, reason }
  for (const cb of pageEndListeners) {
    try {
      cb(e)
    } catch (err) {
      log('onPageSessionEnded', err)
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Recuperação e consultas
// ---------------------------------------------------------------------------------------------

/** Alarme da recuperação periódica: existe enquanto houver sessão aberta ou por salvar. */
export const RECOVER_ALARM = 'gravador:recuperar'

/**
 * Ouvintes que acordam o SW para a recuperação, registrados no carregamento por index.ts (os
 * ouvintes de eventos do SW precisam existir no topo). O index.ts também chama
 * recoverSessions() em todo carregamento; os dois caminhos caem na mesma passada.
 * - RECOVER_ALARM: a cada minuto enquanto houver sessão aberta. Um temporizador de 30 s morre
 *   com o SW; o alarme o acorda de novo e a passada decide outra vez.
 * - runtime.onStartup: o Chrome abriu o perfil (inclusive depois de cair). Os alarmes podem não
 *   sobreviver a um reinício do navegador; este evento sobrevive.
 */
export function registerSessionAlarms(): void {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === RECOVER_ALARM) void recoverSessions()
  })
  chrome.runtime.onStartup?.addListener(() => void recoverSessions())
}

function ensureRecoverAlarm(): void {
  try {
    Promise.resolve(chrome.alarms.create(RECOVER_ALARM, { periodInMinutes: RECOVER_PERIOD_MIN })).catch(() => {})
  } catch (e) {
    log('alarme', e)
  }
}

const OPEN_STATUSES = ['gravando', 'interrompida', 'finalizando'] as const

/** Sem sessão aberta nem por salvar (na memória e no IndexedDB): o alarme sai. */
async function maybeClearRecoverAlarm(): Promise<void> {
  try {
    if ([...runtimes.values()].some((r) => (OPEN_STATUSES as readonly string[]).includes(r.rec.status))) return
    for (const st of OPEN_STATUSES) if ((await listSessions(st)).length > 0) return
    await chrome.alarms.clear(RECOVER_ALARM)
  } catch (e) {
    log('alarme', e)
  }
}

const BOOT_KEY = 'gravador:boot'
let bootPromise: Promise<string | null> | null = null

/**
 * ID desta sessão do navegador, em chrome.storage.session (some quando o Chrome fecha, cai ou a
 * extensão é recarregada; sobrevive ao SW reiniciar). null se a área não existir.
 */
export function currentBootId(): Promise<string | null> {
  bootPromise ??= (async () => {
    try {
      const area = chrome.storage.session
      if (!area) return null
      const got = (await area.get(BOOT_KEY))[BOOT_KEY]
      if (typeof got === 'string' && got) return got
      const id = crypto.randomUUID()
      await area.set({ [BOOT_KEY]: id })
      return id
    } catch (e) {
      log('boot', e)
      return null
    }
  })()
  return bootPromise
}

let recovering: Promise<void> | null = null

/**
 * Sessões que ficaram abertas (queda do Chrome, da aba ou do SW) viram "interrompida" e são
 * finalizadas com o que houver; sessões que falharam ao salvar são tentadas de novo; e o staging
 * do helper deste perfil é conferido (ARQUITETURA, "Service worker" e Emenda 1). Uma passada de
 * cada vez: o início do SW, o onStartup e o alarme caem na mesma.
 */
export function recoverSessions(): Promise<void> {
  recovering ??= doRecover()
    .catch((e) => log('recuperação', e))
    .finally(() => {
      recovering = null
    })
  return recovering
}

async function markInterrupted(rt: Runtime): Promise<void> {
  await enqueue(rt, async () => {
    if (rt.rec.status !== 'gravando') return
    rt.rec.status = 'interrompida'
    // Depois de o Chrome reabrir, o tabId antigo pode ser de outra aba: a sessão sai do índice.
    if (activeByTab.get(rt.rec.tabId) === rt.rec.sessionId) activeByTab.delete(rt.rec.tabId)
    await putSession(rt.rec)
  })
}

async function interrupt(rt: Runtime): Promise<void> {
  await markInterrupted(rt)
  if (rt.rec.status === 'interrompida') void finalize(rt, 'interrompida')
}

async function doRecover(): Promise<void> {
  const boot = await currentBootId()
  const open: SessionRecord[] = []
  for (const st of OPEN_STATUSES) open.push(...(await listSessions(st)))
  for (const stored of open) {
    const rt = await getRuntime(stored.sessionId)
    // Já cuidada nesta vida do SW: finalizando agora, ou com um fim (ou a espera de 30 s) marcado.
    if (!rt || rt.finalizing || rt.finishTimer) continue
    const rec = rt.rec
    if (rec.status === 'finalizando') {
      // Falhou ao salvar (ou o SW morreu no meio): tenta de novo com o motivo que já tinha.
      void finalize(rt, rec.endReason ?? 'interrompida')
      continue
    }
    if (rec.status === 'interrompida') {
      void finalize(rt, 'interrompida')
      continue
    }
    if (rec.status !== 'gravando' || rt.port) continue
    // Começou em outra sessão do navegador: o content script que a gravava não existe mais.
    const otherBoot = boot !== null && rec.bootId !== boot
    const tab = otherBoot ? null : await Promise.resolve(chrome.tabs.get(rec.tabId)).catch(() => null)
    if (!tab) {
      log('recuperação: interrompida', rec.sessionId, otherBoot ? 'outro boot do navegador' : 'aba não existe')
      await interrupt(rt)
      continue
    }
    // A aba existe: dá tempo para o relay reconectar e mandar session:resume (que cancela isto).
    rt.finishTimer = setTimeout(() => {
      rt.finishTimer = null
      if (rt.port || rt.rec.status !== 'gravando') return
      log('recuperação: sem session:resume em 30 s', rt.rec.sessionId)
      void interrupt(rt)
    }, RECOVER_WAIT_MS)
  }
  await recoverStaging()
  // Depois do staging: esta passada já apagou as sobras das salvas antes de esquecê-las.
  await pruneOldRecords()
  void maybeClearRecoverAlarm()
}

/** Registros salvos ou descartados guardam a call (título, URL, participantes): somem depois disto. */
const RECORD_KEEP_MS = 7 * 24 * 3600_000

/** Emenda 10: o IndexedDB de cada perfil não vira um histórico de todas as calls. */
async function pruneOldRecords(): Promise<void> {
  const now = Date.now()
  for (const st of ['salva', 'descartada'] as const) {
    for (const rec of await listSessions(st)) {
      if (runtimes.has(rec.sessionId)) continue
      if (now - (rec.endedAt ?? rec.startedAt) < RECORD_KEEP_MS) continue
      await deleteSession(rec.sessionId)
    }
  }
}

/** `AAAAMMDD-HHmmss-...` (makeSessionId) em ms, hora local; null se não casar. */
export function sessionStartFromId(sessionId: string): number | null {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-/.exec(sessionId)
  if (!m) return null
  const [y, mo, d, h, mi, se] = m.slice(1).map(Number)
  const t = new Date(y, mo - 1, d, h, mi, se).getTime()
  return Number.isFinite(t) ? t : null
}

/**
 * Staging do helper deste perfil (list-staging filtra pelo dono, e aqui se confere de novo: a
 * recuperação do perfil A nunca toca no staging vivo do perfil B, Emenda 1):
 * - com registro salvo ou descartado: sobra (o salvamento foi por downloads, ou o discard
 *   falhou). Apaga.
 * - com registro aberto: é da recuperação acima (o flush completa a partir do IndexedDB).
 * - sem registro, parado há `orphanIdleMs`: vazio, apaga; com áudio, finaliza como "Gravação
 *   recuperada" (interrompida), para nada se perder.
 */
async function recoverStaging(): Promise<void> {
  // Sem cache: o helper pode ter voltado agora (a passada roda no máximo uma vez por minuto).
  const status = await pingHost(true)
  if (!status.ok) return
  const owner = await ensureProfileId()
  const r = await host.listStaging(owner)
  if (!r.ok || !Array.isArray(r.sessions)) return
  for (const entry of r.sessions as HostStagingEntry[]) {
    if (!entry || entry.owner !== owner || typeof entry.sessionId !== 'string') continue
    // Em memória e ainda aberta: é desta vida do SW. Uma sessão já salva também pode estar em
    // memória (uma mensagem atrasada do relay relê o registro), e a sobra dela tem de sair.
    const live = runtimes.get(entry.sessionId)
    if (live && live.rec.status !== 'salva' && live.rec.status !== 'descartada') continue
    const rec = await getSession(entry.sessionId)
    if (rec) {
      if (rec.status === 'salva' || rec.status === 'descartada') {
        log('recuperação: staging que sobrou de', rec.sessionId, rec.status)
        await host.discard(entry.sessionId)
      }
      continue
    }
    const files = Array.isArray(entry.files) ? entry.files : []
    const lastTouch = entry.updatedAt || entry.createdAt || 0
    if (Date.now() - lastTouch < orphanIdleMs) continue
    if (!files.some((f) => f.bytes > 0)) {
      await host.discard(entry.sessionId)
      continue
    }
    await finalizeOrphan(entry, files, lastTouch)
  }
  if (!hasRecording()) releaseHost()
}

async function finalizeOrphan(entry: HostStagingEntry, files: HostStagingEntry['files'], lastTouch: number): Promise<void> {
  const startedAt = sessionStartFromId(entry.sessionId) ?? (entry.createdAt || lastTouch)
  const endedAt = Math.max(startedAt, lastTouch)
  const settings = await loadSettings()
  const label = settings.profileLabel.trim()
  const folder = sanitizeComponent(`${format(startedAt, "yyyy-MM-dd HH'h'mm")} - ${ORPHAN_TITLE}`)
  const relDir = [profileFolder(label), monthFolder(startedAt), folder].filter(Boolean).join('/')
  const helper = hostStatus()
  // Sem registro não se sabe plataforma, título nem participantes: o info.json diz o que há.
  const info: OrphanInfoJson = {
    versao: 1,
    sessao: entry.sessionId,
    perfil: label || null,
    plataforma: null,
    titulo: ORPHAN_TITLE,
    semRegistro: true,
    inicio: iso(startedAt),
    fim: iso(endedAt),
    duracaoSegundos: Math.max(0, Math.round((endedAt - startedAt) / 1000)),
    fuso: timeZone(),
    arquivos: files
      .filter((f) => f.bytes > 0)
      .map((f) => ({ nome: f.file, tipo: f.file === 'audio-aba.webm' ? 'aba' : 'pagina', bytes: f.bytes, formato: RECORDING_MIME, kbps: RECORDING_KBPS })),
    lacunas: [],
    status: 'interrompida',
    motivoFim: 'interrompida',
    extensao: extensionVersion(),
    helper: helper.ok ? helper.version : null,
  }
  const r = await host.finalize(entry.sessionId, relDir, info)
  log('recuperação: staging órfão', entry.sessionId, r.ok ? `salvo em ${String(r.path)}` : r.error)
}

/** Fala no seam selecionado há no máximo isto: "chegando áudio agora" no popup (AC11). */
export const AUDIO_NOW_MS = 10_000

/**
 * "Está chegando áudio agora?" a partir do último session:diag (a cada 5 s). O silêncio
 * informado pela página é somado à idade do diagnóstico: uma página que parou de mandar
 * diagnóstico não fica "com áudio" para sempre.
 */
export function liveAudio(diag: CaptureDiag | null, now: number): { audioNow: boolean; silentForMs: number | null } {
  if (!diag || diag.silentForMs === null) return { audioNow: false, silentForMs: null }
  const silentForMs = diag.silentForMs + Math.max(0, now - diag.at)
  return { audioNow: silentForMs <= AUDIO_NOW_MS, silentForMs }
}

export function activeRecordings(): ActiveRecording[] {
  const now = Date.now()
  return [...runtimes.values()]
    .filter((rt) => rt.rec.status === 'gravando')
    .map((rt) => ({
      sessionId: rt.rec.sessionId,
      tabId: rt.rec.tabId,
      kind: rt.rec.kind,
      platform: rt.rec.platform,
      title: rt.rec.meta.title || rt.rec.meta.code || '',
      startedAt: rt.rec.startedAt,
      hasAudio: rt.rec.diag?.everHadSpeech ?? false,
      ...liveAudio(rt.rec.diag, now),
      lastChunkAgoMs: rt.rec.lastChunkAt === null ? null : now - rt.rec.lastChunkAt,
      bytes: rt.rec.bytes,
      vigia: vigiaStatusOf(rt.rec.tabId),
    }))
}

/**
 * Gravações que terminaram mas não foram salvas (helper e downloads falharam): os chunks estão no
 * IndexedDB e a recuperação tenta de novo a cada minuto. O popup lista (Emenda 10).
 */
export function pendingSaves(): PendingSave[] {
  return [...runtimes.values()]
    .filter((rt) => rt.rec.status === 'finalizando' && rt.saveFailed)
    .map((rt) => ({
      sessionId: rt.rec.sessionId,
      tabId: rt.rec.tabId,
      kind: rt.rec.kind,
      platform: rt.rec.platform,
      title: rt.rec.meta.title || rt.rec.meta.code || '',
      startedAt: rt.rec.startedAt,
      error: rt.rec.lastError ?? '',
    }))
}

/**
 * O que o MAIN world pode gravar sozinho: a configuração de cada plataforma E o aviso da primeira
 * execução confirmado (Emenda 15).
 */
async function effectiveSettings(): Promise<Extract<Down, { t: 'settings' }>> {
  const [s, consent] = await Promise.all([loadSettings(), loadConsent().catch(() => null)])
  return { t: 'settings', autoMeet: autoAllowed('meet', s, consent), autoTeams: autoAllowed('teams', s, consent) }
}

/** Avisa todas as frames conectadas que as configurações (ou a confirmação do aviso) mudaram. */
export async function broadcastSettings(): Promise<void> {
  const msg = await effectiveSettings()
  for (const p of ports) send(p, msg)
}
