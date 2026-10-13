// Modo aba (AC12, fatia do modo aba), lado do documento offscreen.
//
// Para cada aba capturada (várias ao mesmo tempo, uma por tabId):
//
//   getUserMedia({ chromeMediaSource: 'tab', chromeMediaSourceId })
//     -> MediaStreamAudioSourceNode -> GainNode -> limitador -> ctx.destination  (devolução: o usuário continua ouvindo)
//                                   -> MediaStreamAudioDestinationNode mono -> MediaRecorder
//                                   -> AnalyserNode (diagnóstico: está chegando áudio?)
//
// Emenda 14 (volume por aba): a captura da aba (TabAudio: fonte e GainNode de saída) existe em
// dois modos. "volume" é só fonte -> ganho -> destino, sem gravador, para o controle de volume do
// popup; "gravando" é o modo aba, com o gravador ligado à MESMA fonte. O Chrome só deixa uma
// captura por aba, então o modo aba começa em cima da captura de volume que já existir (sem outro
// getUserMedia) e, ao parar com o volume fora de 100% e a devolução ligada, a captura volta a ser
// só de volume. O gravador e o medidor tiram o som da fonte, ANTES do ganho: o volume nunca entra
// na gravação. O ganho que se ouve é `replay ? volume : 0`, seguido de um limitador que só age
// acima de 100% (o pico da aba amplificado não estoura na saída). A captura sobrevive à navegação
// da aba, inclusive para outro site e para páginas chrome:// (medido no Chrome for Testing 151):
// só a aba fechada (ou o Chrome encerrando a captura) termina a faixa.
//
// A captura de aba tira o som da aba dos alto-falantes; por isso a fonte também vai para o
// destino do AudioContext. Aqui isso é permitido, ao contrário do MAIN world (regra 4 vale
// só para a página da call). Exceção (Emenda 11): o som que a página toca num dispositivo de
// saída próprio (setSinkId, caso do Teams logado) continua tocando durante a captura; aí a
// devolução começa desligada (o SW decide pelo relay) e o popup pode ligar ou desligar.
// A devolução é um GainNode (1 ou 0), para trocar sem refazer o grafo nem a gravação.
//
// Os chunks vão para o SW por um Port "gravador:aba" (um só para o documento), com a mesma
// lógica do relay (src/content/relay.ts): seq a partir de 0, o SW grava no IndexedDB antes do
// ack, os chunks sem ack ficam em memória e, se o Port cair (o SW reiniciou), o offscreen
// reconecta e reenvia os pendentes em ordem, e depois o fim.
import { blobToBase64 } from '../shared/base64'
import { PORT_TAB, RECORDING_KBPS, RECORDING_MIME, RECORDING_TIMESLICE_MS, SEAM_IDS, isDownType } from '../shared/constants'
import type { CaptureDiag, Down, EndReason, SeamId, TabAudioState, Up } from '../shared/protocol'
import { audibleGain, clampVolume, isNativeVolume, VOLUME_NATIVE } from '../shared/volume'
import type { OffscreenHandlers } from './handlers'

type ChunkMsg = Extract<Up, { t: 'session:chunk' }>
type EndMsg = Extract<Up, { t: 'session:end' }>

/** Energia acima disso conta como "tem som" (mesmo limiar da arbitragem do MAIN world). */
const SPEECH_DBFS = -55
const FLOOR_DBFS = -200
const DIAG_MS = 5000
const METER_MS = 250
const RECONNECT_MS = [250, 500, 1000, 2000, 4000]
const FIRST_CHUNK_MS = 1000

/**
 * Captura de uma aba (Emenda 14): a fonte e o ganho que se ouve. Vive enquanto houver gravação do
 * modo aba ou volume fora de 100%.
 */
interface TabAudio {
  tabId: number
  stream: MediaStream
  ctx: AudioContext
  source: MediaStreamAudioSourceNode
  /** Ganho até a saída padrão: `replay ? volume : 0` (Emendas 11, 12 e 14). */
  outGain: GainNode
  /** Limitador entre o ganho e a saída: neutro até 100%, segura o pico acima disso. */
  limiter: DynamicsCompressorNode
  /** Volume desta aba, de 0 a 2 (1 é o som original). */
  volume: number
  /** Devolução do som do modo aba (Emenda 11). Sem gravação, sempre ligada. */
  replay: boolean
  /** Gravação do modo aba em cima desta captura (null: só volume). */
  rec: Capture | null
  /** A faixa terminou (aba fechada ou captura encerrada pelo Chrome). */
  ended: boolean
  closed: boolean
}

/** Gravação do modo aba (o gravador em cima de uma TabAudio). */
interface Capture {
  tabId: number
  sessionId: string
  audio: TabAudio
  /** Destino mono do gravador, ligado à fonte (antes do ganho do volume). */
  dest: MediaStreamAudioDestinationNode
  analyser: AnalyserNode
  buf: Float32Array<ArrayBuffer>
  recorder: MediaRecorder
  /** Próximo seq a emitir. */
  seq: number
  bytes: number
  unacked: Map<number, ChunkMsg>
  /** Chunks ainda sendo convertidos para base64 (o fim espera todos). */
  encoding: Promise<void>
  end: EndMsg | null
  stopping: Promise<void> | null
  everHadSpeech: boolean
  lastSpeechAt: number | null
  timers: ReturnType<typeof setInterval>[]
}

/** Capturas da aba (só volume ou gravando) por aba. Emenda 14. */
const audioByTab = new Map<number, TabAudio>()
/** Gravações vivas por aba. */
const byTab = new Map<number, Capture>()
/** Capturas que já pararam mas ainda têm chunk sem ack ou o fim a confirmar. */
const draining = new Map<string, Capture>()

let port: chrome.runtime.Port | null = null
let reconnectAttempt = 0
let reconnectTimer: ReturnType<typeof setTimeout> | null = null

const log = (...a: unknown[]) => console.debug('[gravador aba]', ...a)

function all(): Capture[] {
  return [...byTab.values(), ...draining.values()]
}

function bySession(sessionId: string): Capture | undefined {
  return all().find((c) => c.sessionId === sessionId)
}

// ---------------------------------------------------------------------------------------------
// Port com o SW
// ---------------------------------------------------------------------------------------------

function connect(): chrome.runtime.Port | null {
  if (port) return port
  try {
    port = chrome.runtime.connect({ name: PORT_TAB })
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
  const delay = RECONNECT_MS[Math.min(reconnectAttempt, RECONNECT_MS.length - 1)]
  reconnectAttempt++
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    if (port) return
    const p = connect()
    if (p) resync(p)
    else scheduleReconnect()
  }, delay)
}

/**
 * Liga o Port a uma sessão sem esperar chunk (Emenda 7): o session:resume de uma sessão do modo
 * aba não toca no índice das sessões de página do SW. Sem isto, o botão parar do popup no
 * primeiro segundo (antes do primeiro chunk) não chegava aqui e a aba seguia capturada.
 */
function bind(p: chrome.runtime.Port, c: Capture) {
  try {
    p.postMessage({ t: 'session:resume', localId: c.sessionId, sessionId: c.sessionId, nextSeq: c.seq } satisfies Up)
  } catch (e) {
    // O Port caiu agora: a reconexão (resync) liga de novo.
    log('bind', e)
  }
}

/** Depois de reconectar: o Port de volta a cada sessão, os pendentes em ordem, e o fim. */
function resync(p: chrome.runtime.Port) {
  try {
    for (const c of all()) {
      if (!c.end) bind(p, c)
      const pending = [...c.unacked.keys()].sort((a, b) => a - b)
      for (const seq of pending) p.postMessage(c.unacked.get(seq)!)
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
  // O Port tinha caído: antes da mensagem nova, os pendentes (o resync já inclui `msg`
  // quando ela é um chunk guardado ou o fim).
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

/** Parou, mandou o fim e o SW confirmou todos os chunks: nada mais a reenviar. */
function maybeForget(c: Capture) {
  if (c.end && c.unacked.size === 0) draining.delete(c.sessionId)
}

function onDown(raw: unknown) {
  const msg = raw as Down
  if (!msg || typeof msg !== 'object' || !isDownType(msg.t)) return
  switch (msg.t) {
    case 'chunk:ack': {
      const c = bySession(msg.sessionId)
      if (!c) return
      c.unacked.delete(msg.seq)
      maybeForget(c)
      return
    }
    case 'session:stop': {
      // Botão parar do popup (sessions.ts stopSession manda pelo Port desta sessão).
      const c = bySession(msg.sessionId)
      if (c && byTab.get(c.tabId) === c) void stopCapture(c, 'parado-pelo-usuario')
      return
    }
    default:
      return
  }
}

// ---------------------------------------------------------------------------------------------
// Captura
// ---------------------------------------------------------------------------------------------

function measureDbfs(c: Capture): number {
  c.analyser.getFloatTimeDomainData(c.buf)
  let s = 0
  for (const v of c.buf) s += v * v
  const rms = Math.sqrt(s / c.buf.length)
  return rms > 0 ? Math.max(FLOOR_DBFS, 20 * Math.log10(rms)) : FLOOR_DBFS
}

function diagOf(c: Capture): CaptureDiag {
  const now = Date.now()
  const seams = Object.fromEntries(SEAM_IDS.map((id) => [id, { sources: 0, dbfs: FLOOR_DBFS, speech: false }])) as Record<
    SeamId,
    { sources: number; dbfs: number; speech: boolean }
  >
  return {
    at: now,
    ctxState: c.audio.ctx.state,
    initial: null,
    selected: null,
    switches: [],
    seams,
    pcs: { open: 0, connected: 0 },
    remoteAudioTracks: 0,
    primed: 0,
    chunks: c.seq,
    bytes: c.bytes,
    everHadSpeech: c.everHadSpeech,
    silentForMs: c.lastSpeechAt === null ? null : Math.max(0, now - c.lastSpeechAt),
    recorderState: c.recorder.state,
    holds: [],
  }
}

async function getTabStream(streamId: string): Promise<MediaStream> {
  // Formato legado (mandatory) é o que a captura de aba aceita com o ID do getMediaStreamId.
  const constraints = {
    audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
    video: false,
  } as unknown as MediaStreamConstraints
  return navigator.mediaDevices.getUserMedia(constraints)
}

/**
 * Limitador da saída: até 100% (ratio 1) não mexe em nada; acima disso, o que passar de -1 dBFS é
 * achatado (ratio 20, sem joelho), para o pico amplificado não estourar na saída.
 */
const LIMITER_ON = { threshold: -1, ratio: 20 }
const LIMITER_OFF = { threshold: 0, ratio: 1 }

function newLimiter(ctx: AudioContext, volume: number): DynamicsCompressorNode {
  const p = volume > VOLUME_NATIVE ? LIMITER_ON : LIMITER_OFF
  return new DynamicsCompressorNode(ctx, { threshold: p.threshold, ratio: p.ratio, knee: 0, attack: 0.003, release: 0.25 })
}

/** Ganho que se ouve, aplicado sem estalo, e o limitador ligado só acima de 100%. */
function applyGain(a: TabAudio) {
  a.outGain.gain.setTargetAtTime(audibleGain(a.volume, a.replay), a.ctx.currentTime, 0.02)
  const p = a.volume > VOLUME_NATIVE ? LIMITER_ON : LIMITER_OFF
  a.limiter.threshold.value = p.threshold
  a.limiter.ratio.value = p.ratio
}

/**
 * A captura fica só de volume depois de a gravação parar? Só com volume fora de 100%, a devolução
 * ligada e a faixa viva. Devolução desligada quer dizer que o usuário não quis o som da extensão
 * (a página toca num dispositivo próprio, Emenda 11): religar ao parar traria o som em dobro de
 * volta, então a captura é desfeita e a aba volta ao caminho de som dela.
 */
function keepsVolume(a: TabAudio): boolean {
  return !a.closed && !a.ended && a.replay && !isNativeVolume(a.volume) && a.stream.getAudioTracks()[0]?.readyState === 'live'
}

/** Desfaz a captura da aba: a aba volta ao caminho de som dela (e ao dispositivo que ela escolheu). */
async function releaseAudio(a: TabAudio): Promise<void> {
  if (a.closed) return
  a.closed = true
  if (audioByTab.get(a.tabId) === a) audioByTab.delete(a.tabId)
  for (const t of a.stream.getTracks()) t.stop()
  await a.ctx.close().catch(() => {})
  log('captura desfeita', a.tabId)
}

/**
 * Abre a captura da aba com o ID do getMediaStreamId: fonte -> ganho -> destino (o usuário
 * continua ouvindo; a captura de aba tira o som da aba dos alto-falantes). Sem gravador.
 */
async function openTabAudio(tabId: number, streamId: string, volume: number, replay: boolean): Promise<{ ok: true; audio: TabAudio } | { ok: false; error: string }> {
  let stream: MediaStream
  try {
    stream = await getTabStream(streamId)
  } catch (e) {
    return { ok: false, error: `getUserMedia da aba: ${String((e as Error)?.message ?? e)}` }
  }
  const track = stream.getAudioTracks()[0]
  if (!track) {
    for (const t of stream.getTracks()) t.stop()
    return { ok: false, error: 'a captura da aba veio sem áudio' }
  }
  let ctx: AudioContext | null = null
  try {
    ctx = new AudioContext({ latencyHint: 'interactive' })
    const source = new MediaStreamAudioSourceNode(ctx, { mediaStream: stream })
    // Devolução e volume num GainNode só, para trocar sem refazer o grafo nem a gravação.
    const outGain = new GainNode(ctx, { gain: audibleGain(volume, replay) })
    const limiter = newLimiter(ctx, volume)
    source.connect(outGain)
    outGain.connect(limiter)
    limiter.connect(ctx.destination)
    if (ctx.state === 'suspended') await ctx.resume().catch(() => {})
    const a: TabAudio = { tabId, stream, ctx, source, outGain, limiter, volume, replay, rec: null, ended: false, closed: false }
    // Aba fechada (ou captura encerrada pelo Chrome por outro motivo; a navegação não encerra): a
    // faixa termina; a gravação fecha sozinha e a captura é desfeita.
    track.addEventListener('ended', () => {
      a.ended = true
      if (a.rec) {
        if (byTab.get(tabId) === a.rec) void stopCapture(a.rec, 'aba-fechada')
      } else void releaseAudio(a)
    })
    audioByTab.set(tabId, a)
    return { ok: true, audio: a }
  } catch (e) {
    for (const t of stream.getTracks()) t.stop()
    void ctx?.close().catch(() => {})
    return { ok: false, error: String((e as Error)?.message ?? e) }
  }
}

/** A captura viva da aba, se houver (uma que já terminou não serve para gravar). */
function liveAudio(tabId: number): TabAudio | undefined {
  const a = audioByTab.get(tabId)
  return a && !a.closed && !a.ended ? a : undefined
}

async function startCapture(tabId: number, streamId: string | undefined, sessionId: string, replay: boolean): Promise<{ ok: boolean; error?: string }> {
  if (byTab.has(tabId)) return { ok: false, error: 'esta aba já está sendo gravada' }
  // Emenda 14: a captura de volume que a aba já tem é a mesma que se grava (sem outro getUserMedia).
  let a = liveAudio(tabId)
  const reused = !!a
  if (a) {
    a.replay = replay
    applyGain(a)
  } else {
    if (!streamId) return { ok: false, error: 'a aba não tem captura para reaproveitar' }
    const opened = await openTabAudio(tabId, streamId, VOLUME_NATIVE, replay)
    if (!opened.ok) return opened
    a = opened.audio
  }
  let dest: MediaStreamAudioDestinationNode | null = null
  let analyser: AnalyserNode | null = null
  try {
    // O gravador e o medidor ligados à fonte, antes do ganho: o volume não entra na gravação.
    dest = new MediaStreamAudioDestinationNode(a.ctx, { channelCount: 1, channelCountMode: 'explicit', channelInterpretation: 'speakers' })
    a.source.connect(dest)
    analyser = new AnalyserNode(a.ctx, { fftSize: 2048 })
    a.source.connect(analyser)
    const recorder = new MediaRecorder(dest.stream, { mimeType: RECORDING_MIME, audioBitsPerSecond: RECORDING_KBPS * 1000 })
    const c: Capture = {
      tabId,
      sessionId,
      audio: a,
      dest,
      analyser,
      buf: new Float32Array(analyser.fftSize),
      recorder,
      seq: 0,
      bytes: 0,
      unacked: new Map(),
      encoding: Promise.resolve(),
      end: null,
      stopping: null,
      everHadSpeech: false,
      lastSpeechAt: null,
      timers: [],
    }
    recorder.addEventListener('dataavailable', (ev) => onData(c, (ev as BlobEvent).data))
    recorder.addEventListener('error', (ev) => log('MediaRecorder erro', (ev as ErrorEvent).error ?? ev))
    recorder.start(RECORDING_TIMESLICE_MS)
    // O primeiro chunk (com o cabeçalho) sai logo, para o arquivo ter o cabeçalho cedo. O Port já
    // está ligado à sessão pelo session:resume (bind, abaixo).
    setTimeout(() => {
      if (recorder.state === 'recording') recorder.requestData()
    }, FIRST_CHUNK_MS)
    c.timers.push(
      setInterval(() => {
        const db = measureDbfs(c)
        if (db > SPEECH_DBFS) {
          c.everHadSpeech = true
          c.lastSpeechAt = Date.now()
        }
      }, METER_MS),
      setInterval(() => send({ t: 'session:diag', sessionId: c.sessionId, diag: diagOf(c) }), DIAG_MS),
    )
    a.rec = c
    byTab.set(tabId, c)
    const p = connect()
    if (p) bind(p, c)
    log('gravando a aba', tabId, sessionId, a.ctx.state, reused ? `na captura de volume (${a.volume})` : 'captura nova')
    return { ok: true }
  } catch (e) {
    disconnectRecorder(a, dest, analyser)
    // Captura reaproveitada: o volume continua como estava; captura nova: desfeita.
    if (reused) {
      a.replay = true
      applyGain(a)
    } else await releaseAudio(a)
    return { ok: false, error: String((e as Error)?.message ?? e) }
  }
}

/** Tira o gravador e o medidor da fonte (a captura pode continuar só de volume). */
function disconnectRecorder(a: TabAudio, dest: AudioNode | null, analyser: AudioNode | null) {
  for (const n of [dest, analyser]) {
    if (!n) continue
    try {
      a.source.disconnect(n)
    } catch {
      // Não estava ligado.
    }
  }
}

function onData(c: Capture, blob: Blob | undefined) {
  if (!blob || blob.size === 0) return
  const seq = c.seq++
  c.bytes += blob.size
  const at = Date.now()
  // Converte na ordem (a fila garante que o chunk n sai antes do n+1).
  c.encoding = c.encoding
    .then(async () => {
      const data = await blobToBase64(blob)
      const msg: ChunkMsg = { t: 'session:chunk', sessionId: c.sessionId, seq, data, bytes: blob.size, at }
      c.unacked.set(seq, msg)
      send(msg)
    })
    .catch((e) => log('chunk', seq, e))
}

function stopCapture(c: Capture, reason: EndReason): Promise<void> {
  if (c.stopping) return c.stopping
  c.stopping = (async () => {
    for (const t of c.timers) clearInterval(t)
    c.timers = []
    // Sai do mapa vivo antes de esperar: um toggle novo na mesma aba já pode começar outra.
    if (byTab.get(c.tabId) === c) byTab.delete(c.tabId)
    draining.set(c.sessionId, c)
    if (c.recorder.state !== 'inactive') {
      await new Promise<void>((resolve) => {
        // 'stop' dispara depois do último 'dataavailable'.
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
    // Emenda 14: sem outra gravação em cima, a captura fica só de volume (volume fora de 100%, a
    // devolução ligada e a aba viva) ou é desfeita.
    const a = c.audio
    disconnectRecorder(a, c.dest, c.analyser)
    if (a.rec === c) a.rec = null
    if (!a.rec) {
      if (keepsVolume(a)) log('a captura fica só de volume', c.tabId, a.volume)
      else await releaseAudio(a)
    }
    const end: EndMsg = { t: 'session:end', sessionId: c.sessionId, endedAt: Date.now(), reason, lastSeq: c.seq - 1 }
    c.end = end
    send(end)
    maybeForget(c)
    log('parou a aba', c.tabId, c.sessionId, reason, 'chunks', c.seq)
  })()
  return c.stopping
}

// ---------------------------------------------------------------------------------------------
// Handlers do roteador (./offscreen.ts)
// ---------------------------------------------------------------------------------------------

/** Estado da captura da aba (offscreen:tab-audio e o gancho de teste do SW). */
function audioState(tabId: number): TabAudioState {
  const a = liveAudio(tabId)
  if (!a) return { mode: null, volume: VOLUME_NATIVE, replay: true, gain: VOLUME_NATIVE }
  return { mode: a.rec ? 'gravando' : 'volume', volume: a.volume, replay: a.replay, gain: a.outGain.gain.value }
}

type TabReq = 'offscreen:tab-start' | 'offscreen:tab-stop' | 'offscreen:tab-replay'
type VolumeReq = 'offscreen:tab-volume-start' | 'offscreen:tab-volume' | 'offscreen:tab-volume-stop' | 'offscreen:tab-audio'

export const tabHandlers: OffscreenHandlers<TabReq | VolumeReq> = {
  'offscreen:tab-start': async (req) => startCapture(req.tabId, req.streamId, req.sessionId, req.replay !== false),
  'offscreen:tab-replay': async (req) => {
    const c = byTab.get(req.tabId)
    if (!c) return { ok: false }
    c.audio.replay = req.on
    applyGain(c.audio)
    log('devolução', req.tabId, req.on ? 'ligada' : 'desligada')
    return { ok: true }
  },
  'offscreen:tab-stop': async (req) => {
    const { tabId, reason } = req
    // Já parando (a faixa terminou com a aba fechada): espera o mesmo fim.
    // Nada gravando nesta aba: já está parado (idempotente, como o contrato da fatia 1 espera).
    // Uma captura só de volume não é gravação: fica como está (Emenda 14).
    const c = byTab.get(tabId) ?? [...draining.values()].find((d) => d.tabId === tabId && !d.end)
    if (c) await stopCapture(c, reason ?? 'parado-pelo-usuario')
    return { ok: true }
  },
  // Emenda 14: volume por aba.
  'offscreen:tab-volume-start': async (req) => {
    const volume = clampVolume(req.volume)
    if (volume === null) return { ok: false, error: 'volume inválido' }
    const a = liveAudio(req.tabId)
    if (a) {
      a.volume = volume
      applyGain(a)
      return { ok: true }
    }
    const opened = await openTabAudio(req.tabId, req.streamId, volume, true)
    if (!opened.ok) return opened
    log('volume da aba', req.tabId, volume, 'captura nova')
    return { ok: true }
  },
  'offscreen:tab-volume': async (req) => {
    const volume = clampVolume(req.volume)
    const a = liveAudio(req.tabId)
    if (!a || volume === null) return { ok: false }
    a.volume = volume
    applyGain(a)
    log('volume da aba', req.tabId, volume, a.rec ? 'gravando' : 'só volume')
    return { ok: true }
  },
  'offscreen:tab-volume-stop': async (req) => {
    const a = audioByTab.get(req.tabId)
    if (!a) return { ok: true }
    // Gravando: 100% só volta o ganho; a gravação nunca para por causa do volume.
    if (a.rec) {
      a.volume = VOLUME_NATIVE
      applyGain(a)
      return { ok: true }
    }
    await releaseAudio(a)
    return { ok: true }
  },
  'offscreen:tab-audio': async (req) => audioState(req.tabId),
}
