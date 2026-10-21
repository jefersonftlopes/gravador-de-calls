// Gravação da voz do próprio usuário, por aba (Emenda 25), lado do documento offscreen.
//
//   getUserMedia({ audio: true })   UMA vez para o navegador inteiro
//     -> MediaStreamAudioSourceNode -> DelayNode(MIXER_DELAY_MS)
//          -> [ligado/desligado por aba, conforme o portão]
//               -> MediaStreamAudioDestinationNode mono -> MediaRecorder -> chunks -> SW
//
// Por que aqui: o service worker do MV3 não tem MediaRecorder nem getUserMedia, e o documento
// offscreen já existe (motivos BLOBS + USER_MEDIA + AUDIO_PLAYBACK) com o gravador do modo aba.
//
// Três regras que este arquivo cumpre, e que os testes cobram:
//
// 1. NUNCA ligado ao `ctx.destination`. A voz dele não pode sair nos alto-falantes: voltaria para a
//    call pelo microfone, em eco. O modo aba liga no destino de propósito (a captura de aba tira o
//    som da aba), e aqui é o contrário.
// 2. FECHADO é DESLIGADO, não ganho zero. O portão fechado DESCONECTA o nó do destino de gravação;
//    não há nenhum GainNode no caminho. Ganho zero depende de um número estar certo; desligar
//    depende da topologia, e é isso que o teste mede em dBFS no arquivo gerado.
// 3. O getUserMedia só acontece na PRIMEIRA abertura do portão. Com o recurso ligado mas o portão
//    fechado a call toda (o caso da faixa processada da Emenda 24, seção F), o microfone nem é
//    pedido: nenhuma permissão, nenhuma captura, nenhum arquivo.
//
// A troca é agendada (`waitMs`, de src/shared/mic-route.ts): o gravador fica depois de um atraso
// igual ao do mixer da call, então desligar daqui a `delay - idade` corta o áudio a partir do
// instante do mudo, e ligar daqui a `delay` inteiro só deixa passar o áudio de depois do desmudo.
// Precedente: o seletor do mixer (src/main-world/capture/mixer.ts) também fica depois do atraso.
//
// Os chunks vão para o SW por um Port próprio ("gravador:microfone"), com a mesma lógica do modo
// aba (seq a partir de 0, o SW grava no IndexedDB antes do ack, os chunks sem ack ficam em memória
// e são reenviados se o Port cair). A lógica é repetida de ./tab.ts de propósito: ver PORT_MIC em
// src/shared/constants.ts.
import { blobToBase64 } from '../shared/base64'
import { MIXER_DELAY_MS, PORT_MIC, RECORDING_KBPS, RECORDING_MIME, RECORDING_TIMESLICE_MS, isDownType } from '../shared/constants'
import type { Down, EndReason, MicOffscreenState, MicPermissionState, Up } from '../shared/protocol'
import type { OffscreenHandlers } from './handlers'

type ChunkMsg = Extract<Up, { t: 'session:chunk' }>
type EndMsg = Extract<Up, { t: 'session:end' }>

const RECONNECT_MS = [250, 500, 1000, 2000, 4000]
/** O primeiro chunk (com o cabeçalho EBML) sai logo, como no modo aba. */
const FIRST_CHUNK_MS = 1000
/**
 * Margem a mais na espera para LIGAR. Erra para o lado de ligar tarde (perder o comecinho da
 * palavra) em vez de ligar cedo (deixar entrar áudio de quando a pessoa estava muda).
 */
const OPEN_MARGIN_MS = 60

/** Gravador do microfone de UMA aba. */
interface MicRec {
  tabId: number
  sessionId: string
  /** Destino mono do gravador. Nada chega nele enquanto o portão estiver fechado. */
  dest: MediaStreamAudioDestinationNode
  recorder: MediaRecorder
  /** O nó está ligado ao destino agora (o portão está aberto para esta aba). */
  on: boolean
  /** Já esteve ligado alguma vez. Nunca ligado, o SW descarta a sessão e nenhum arquivo aparece. */
  everOn: boolean
  /** Troca agendada (a última manda; um comando novo cancela a anterior). */
  timer: ReturnType<typeof setTimeout> | null
  firstChunkTimer: ReturnType<typeof setTimeout> | null
  seq: number
  bytes: number
  unacked: Map<number, ChunkMsg>
  /** Chunks ainda sendo convertidos para base64 (o fim espera todos). */
  encoding: Promise<void>
  end: EndMsg | null
  stopping: Promise<void> | null
}

const byTab = new Map<number, MicRec>()
/** Gravadores que já pararam mas ainda têm chunk sem ack ou o fim a confirmar. */
const draining = new Map<string, MicRec>()

/** O microfone, um só para o navegador inteiro (o getUserMedia não é por aba). */
let ctx: AudioContext | null = null
let stream: MediaStream | null = null
let source: MediaStreamAudioSourceNode | null = null
let delay: DelayNode | null = null
let opening: Promise<{ ok: boolean; error?: string }> | null = null
let lastError: string | null = null

let port: chrome.runtime.Port | null = null
let reconnectAttempt = 0
let reconnectTimer: ReturnType<typeof setTimeout> | null = null

const log = (...a: unknown[]) => console.debug('[gravador microfone]', ...a)

function all(): MicRec[] {
  return [...byTab.values(), ...draining.values()]
}

function bySession(sessionId: string): MicRec | undefined {
  return all().find((c) => c.sessionId === sessionId)
}

// ---------------------------------------------------------------------------------------------
// Port com o SW (mesma lógica do modo aba; ver o cabeçalho)
// ---------------------------------------------------------------------------------------------

function connect(): chrome.runtime.Port | null {
  if (port) return port
  try {
    port = chrome.runtime.connect({ name: PORT_MIC })
  } catch (e) {
    log('connect', e)
    return null
  }
  port.onMessage.addListener(onDown)
  port.onDisconnect.addListener(() => {
    void chrome.runtime.lastError
    port = null
    if (all().length > 0) scheduleReconnect()
  })
  return port
}

function scheduleReconnect() {
  if (reconnectTimer) return
  const wait = RECONNECT_MS[Math.min(reconnectAttempt, RECONNECT_MS.length - 1)]
  reconnectAttempt++
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    if (port) return
    const p = connect()
    if (p) resync(p)
    else scheduleReconnect()
  }, wait)
}

/** Liga o Port a uma sessão sem esperar chunk (como no modo aba: o parar do popup chega por ele). */
function bind(p: chrome.runtime.Port, c: MicRec) {
  try {
    p.postMessage({ t: 'session:resume', localId: c.sessionId, sessionId: c.sessionId, nextSeq: c.seq } satisfies Up)
  } catch (e) {
    log('bind', e)
  }
}

function resync(p: chrome.runtime.Port) {
  try {
    for (const c of all()) {
      if (!c.end) bind(p, c)
      for (const seq of [...c.unacked.keys()].sort((a, b) => a - b)) p.postMessage(c.unacked.get(seq)!)
      if (c.end) p.postMessage(c.end)
    }
    reconnectAttempt = 0
  } catch (e) {
    log('resync', e)
    port = null
    scheduleReconnect()
  }
}

function send(msg: Up) {
  const reconnecting = !port
  const p = connect()
  if (!p) {
    scheduleReconnect()
    return
  }
  if (reconnecting) {
    resync(p)
    if (msg.t === 'session:chunk' || msg.t === 'session:end') return
  }
  try {
    p.postMessage(msg)
  } catch (e) {
    log('postMessage', e)
    port = null
    scheduleReconnect()
  }
}

function maybeForget(c: MicRec) {
  if (c.end && c.unacked.size === 0) draining.delete(c.sessionId)
}

function onDown(raw: unknown) {
  const msg = raw as Down
  if (!msg || typeof msg !== 'object' || !isDownType(msg.t)) return
  if (msg.t === 'chunk:ack') {
    const c = bySession(msg.sessionId)
    if (!c) return
    c.unacked.delete(msg.seq)
    maybeForget(c)
    return
  }
  if (msg.t === 'session:stop') {
    const c = bySession(msg.sessionId)
    if (c && byTab.get(c.tabId) === c) void stopMic(c, 'parado-pelo-usuario')
  }
}

// ---------------------------------------------------------------------------------------------
// O microfone
// ---------------------------------------------------------------------------------------------

/** O que o navegador diz da permissão do microfone PARA ESTE DOCUMENTO (origem da extensão). */
export async function micPermission(): Promise<MicPermissionState> {
  try {
    const st = await navigator.permissions.query({ name: 'microphone' as PermissionName })
    return st.state === 'granted' || st.state === 'denied' || st.state === 'prompt' ? st.state : 'indisponivel'
  } catch {
    // Navegador sem a consulta para 'microphone': não dá para saber daqui.
    return 'indisponivel'
  }
}

function ensureCtx(): AudioContext {
  ctx ??= new AudioContext({ latencyHint: 'interactive' })
  return ctx
}

/**
 * Abre o microfone (uma vez para o navegador inteiro) e monta fonte -> atraso. O documento offscreen
 * não tem interface, então ele NÃO consegue pedir permissão: ela tem de estar concedida para a
 * origem chrome-extension:// (a página de configurações pede, no clique em que o usuário liga o
 * recurso). Sem permissão, o getUserMedia falha na hora e o motivo volta para o SW.
 */
function openMic(): Promise<{ ok: boolean; error?: string }> {
  if (source && delay && stream?.getAudioTracks()[0]?.readyState === 'live') return Promise.resolve({ ok: true })
  opening ??= (async () => {
    try {
      const c = ensureCtx()
      const got = await navigator.mediaDevices.getUserMedia({ audio: true })
      const track = got.getAudioTracks()[0]
      if (!track) {
        for (const t of got.getTracks()) t.stop()
        throw new Error('o microfone veio sem faixa de áudio')
      }
      stream = got
      source = new MediaStreamAudioSourceNode(c, { mediaStream: got })
      // O atraso do mixer da call, pelo mesmo motivo: a troca do portão vale para o áudio de trás
      // (src/shared/mic-route.ts, micEdgeWaitMs) e os dois arquivos saem com o mesmo atraso.
      delay = new DelayNode(c, { delayTime: MIXER_DELAY_MS / 1000, maxDelayTime: Math.max(1, MIXER_DELAY_MS / 1000) })
      source.connect(delay)
      if (c.state === 'suspended') await c.resume().catch(() => {})
      lastError = null
      log('microfone aberto', c.state, `atraso ${MIXER_DELAY_MS} ms`)
      return { ok: true }
    } catch (e) {
      const error = String((e as Error)?.message ?? e)
      lastError = error
      log('getUserMedia', error)
      return { ok: false, error }
    } finally {
      opening = null
    }
  })()
  return opening
}

/** Solta o microfone: sem gravador nenhum, nada fica capturando (o indicador do Chrome apaga). */
function releaseMic() {
  if (byTab.size > 0) return
  for (const t of stream?.getTracks() ?? []) t.stop()
  try {
    source?.disconnect()
    delay?.disconnect()
  } catch {
    // já desligado
  }
  stream = null
  source = null
  delay = null
  if (ctx) {
    const c = ctx
    ctx = null
    void c.close().catch(() => {})
  }
  log('microfone solto')
}

/** Liga ou desliga o nó desta aba AGORA (idempotente; é a topologia que garante o silêncio). */
function apply(c: MicRec, open: boolean) {
  if (open === c.on) return
  if (open) {
    if (!delay) return
    delay.connect(c.dest)
    c.on = true
    c.everOn = true
  } else {
    try {
      delay?.disconnect(c.dest)
    } catch {
      // não estava ligado
    }
    c.on = false
  }
  log('portão', c.tabId, open ? 'aberto' : 'fechado')
}

// ---------------------------------------------------------------------------------------------
// Gravador por aba
// ---------------------------------------------------------------------------------------------

function onData(c: MicRec, blob: Blob | undefined) {
  if (!blob || blob.size === 0) return
  const seq = c.seq++
  c.bytes += blob.size
  const at = Date.now()
  c.encoding = c.encoding
    .then(async () => {
      const data = await blobToBase64(blob)
      const msg: ChunkMsg = { t: 'session:chunk', sessionId: c.sessionId, seq, data, bytes: blob.size, at }
      c.unacked.set(seq, msg)
      send(msg)
    })
    .catch((e) => log('chunk', seq, e))
}

function startMic(tabId: number, sessionId: string): { ok: boolean; error?: string } {
  if (byTab.has(tabId)) return { ok: false, error: 'esta aba já tem gravador de microfone' }
  try {
    const c = ensureCtx()
    // O destino existe desde o começo, com NADA ligado nele: o gravador grava silêncio até o
    // portão abrir, e o arquivo fica com a mesma base de tempo da gravação da call.
    const dest = new MediaStreamAudioDestinationNode(c, { channelCount: 1, channelCountMode: 'explicit', channelInterpretation: 'speakers' })
    const recorder = new MediaRecorder(dest.stream, { mimeType: RECORDING_MIME, audioBitsPerSecond: RECORDING_KBPS * 1000 })
    const rec: MicRec = {
      tabId,
      sessionId,
      dest,
      recorder,
      on: false,
      everOn: false,
      timer: null,
      firstChunkTimer: null,
      seq: 0,
      bytes: 0,
      unacked: new Map(),
      encoding: Promise.resolve(),
      end: null,
      stopping: null,
    }
    recorder.addEventListener('dataavailable', (ev) => onData(rec, (ev as BlobEvent).data))
    recorder.addEventListener('error', (ev) => log('MediaRecorder erro', (ev as ErrorEvent).error ?? ev))
    recorder.start(RECORDING_TIMESLICE_MS)
    rec.firstChunkTimer = setTimeout(() => {
      rec.firstChunkTimer = null
      if (recorder.state === 'recording') recorder.requestData()
    }, FIRST_CHUNK_MS)
    byTab.set(tabId, rec)
    const p = connect()
    if (p) bind(p, rec)
    log('gravador do microfone pronto', tabId, sessionId, c.state)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e) }
  }
}

/**
 * O comando do portão: agenda a troca para `waitMs` depois (ver o cabeçalho). Um comando novo
 * cancela o agendamento anterior, então o último manda. A primeira abertura abre o microfone.
 */
async function gate(tabId: number, open: boolean, waitMs: number): Promise<{ ok: boolean; error?: string; permission?: MicPermissionState }> {
  const c = byTab.get(tabId)
  if (!c) return { ok: false, error: 'esta aba não tem gravador de microfone' }
  if (c.timer) clearTimeout(c.timer)
  c.timer = null
  const wait = Number.isFinite(waitMs) ? Math.max(0, waitMs) : 0
  const deadline = Date.now() + wait + (open ? OPEN_MARGIN_MS : 0)
  if (!open) {
    schedule(c, false, Math.max(0, deadline - Date.now()))
    return { ok: true }
  }
  const r = await openMic()
  if (!r.ok) return { ok: false, error: r.error, permission: await micPermission() }
  // O gravador pode ter parado enquanto o getUserMedia respondia.
  if (byTab.get(tabId) !== c) return { ok: false, error: 'o gravador do microfone parou' }
  schedule(c, true, Math.max(0, deadline - Date.now()))
  return { ok: true }
}

function schedule(c: MicRec, open: boolean, wait: number) {
  if (wait <= 0) return apply(c, open)
  c.timer = setTimeout(() => {
    c.timer = null
    if (byTab.get(c.tabId) === c) apply(c, open)
  }, wait)
}

function stopMic(c: MicRec, reason: EndReason): Promise<void> {
  if (c.stopping) return c.stopping
  c.stopping = (async () => {
    if (c.timer) clearTimeout(c.timer)
    if (c.firstChunkTimer) clearTimeout(c.firstChunkTimer)
    c.timer = null
    c.firstChunkTimer = null
    apply(c, false)
    if (byTab.get(c.tabId) === c) byTab.delete(c.tabId)
    draining.set(c.sessionId, c)
    if (c.recorder.state !== 'inactive') {
      await new Promise<void>((resolve) => {
        c.recorder.addEventListener('stop', () => resolve(), { once: true })
        try {
          c.recorder.stop()
        } catch (e) {
          log('stop', e)
          resolve()
        }
      })
    }
    await c.encoding
    try {
      c.dest.disconnect()
    } catch {
      // nada ligado
    }
    releaseMic()
    const end: EndMsg = { t: 'session:end', sessionId: c.sessionId, endedAt: Date.now(), reason, lastSeq: c.seq - 1 }
    c.end = end
    send(end)
    maybeForget(c)
    log('parou o microfone', c.tabId, c.sessionId, reason, 'chunks', c.seq, c.everOn ? 'teve voz' : 'nunca abriu')
  })()
  return c.stopping
}

async function state(): Promise<MicOffscreenState> {
  return {
    capturando: stream?.getAudioTracks()[0]?.readyState === 'live',
    permissao: await micPermission(),
    erro: lastError,
    abas: [...byTab.keys()].sort((a, b) => a - b),
    ligadas: [...byTab.values()].filter((c) => c.on).map((c) => c.tabId).sort((a, b) => a - b),
    jaLigadas: all().filter((c) => c.everOn).map((c) => c.tabId).sort((a, b) => a - b),
  }
}

type MicReq = 'offscreen:mic-start' | 'offscreen:mic-gate' | 'offscreen:mic-stop' | 'offscreen:mic-state'

export const micHandlers: OffscreenHandlers<MicReq> = {
  'offscreen:mic-start': async (req) => startMic(req.tabId, req.sessionId),
  'offscreen:mic-gate': async (req) => gate(req.tabId, req.open, req.waitMs),
  'offscreen:mic-stop': async (req) => {
    const c = byTab.get(req.tabId) ?? [...draining.values()].find((d) => d.tabId === req.tabId && !d.end)
    if (c) await stopMic(c, req.reason ?? 'parado-pelo-usuario')
    return { ok: true }
  },
  'offscreen:mic-state': async () => state(),
}
