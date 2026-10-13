// Lado offscreen do modo aba (tab.ts) com a captura, o WebAudio, o MediaRecorder e o Port
// trocados por falsos: os caminhos que o ponta a ponta não isola.
// - a faixa da captura terminando sozinha (o Chrome encerrou a captura) fecha a gravação, com o
//   último pedaço e o session:end, sem depender do tabs.onRemoved do SW (que cobre o mesmo fim
//   quando a aba fecha, por isso o ponta a ponta não distingue os dois);
// - o Port se liga à sessão no início pelo session:resume (Emenda 7), antes de qualquer chunk, e
//   de novo a cada reconexão (pelo timer ou pelo chunk que acha o Port caído);
// - o tab-stop leva o motivo pedido ao session:end;
// - a devolução do som começa como o SW pediu e o popup liga ou desliga (Emenda 11);
// - volume por aba (Emenda 14): captura só de volume, o modo aba em cima dela sem outro
//   getUserMedia, a volta a só volume quando a gravação para (só com a devolução ligada), o
//   gravador antes do ganho e o limitador da saída acima de 100%.
import { beforeEach, describe, expect, it, vi } from 'vitest'

class FakeTrack extends EventTarget {
  readyState = 'live'
  stop() {
    this.readyState = 'ended'
  }
}

class FakeRecorder extends EventTarget {
  static last: FakeRecorder | null = null
  /** O próximo construtor falha (o MediaRecorder recusou o formato, por exemplo). */
  static failNext = false
  state: 'inactive' | 'recording' = 'inactive'
  constructor() {
    super()
    if (FakeRecorder.failNext) {
      FakeRecorder.failNext = false
      throw new Error('MediaRecorder recusou')
    }
    FakeRecorder.last = this
  }
  start() {
    this.state = 'recording'
  }
  requestData() {
    this.emitData()
  }
  stop() {
    this.emitData()
    this.state = 'inactive'
    this.dispatchEvent(new Event('stop'))
  }
  private emitData() {
    const ev = new Event('dataavailable') as Event & { data: Blob }
    ev.data = new Blob([new Uint8Array([1, 2, 3])])
    this.dispatchEvent(ev)
  }
}

/** Ligações do grafo falso (de -> para), para conferir onde o gravador tira o som. */
const edges: Array<[FakeNode, unknown]> = []

class FakeNode {
  connect(to: unknown) {
    edges.push([this, to])
    return to
  }
  disconnect(to?: unknown) {
    for (let i = edges.length - 1; i >= 0; i--) if (edges[i][0] === this && (to === undefined || edges[i][1] === to)) edges.splice(i, 1)
  }
}

class FakeSource extends FakeNode {}
class FakeDest extends FakeNode {
  stream = {}
}

/** GainNode falso: guarda o ganho atual da devolução. */
class FakeGain extends FakeNode {
  static last: FakeGain | null = null
  gain = {
    value: 1,
    setTargetAtTime(v: number) {
      this.value = v
    },
  }
  constructor(_ctx: unknown, opts?: { gain?: number }) {
    super()
    this.gain.value = opts?.gain ?? 1
    FakeGain.last = this
  }
}

/** Limitador falso (DynamicsCompressorNode): guarda os parâmetros que o tab.ts deixa nele. */
class FakeLimiter extends FakeNode {
  static last: FakeLimiter | null = null
  threshold = { value: 0 }
  ratio = { value: 1 }
  knee = { value: 0 }
  constructor(_ctx: unknown, opts?: { threshold?: number; ratio?: number; knee?: number }) {
    super()
    this.threshold.value = opts?.threshold ?? -24
    this.ratio.value = opts?.ratio ?? 12
    this.knee.value = opts?.knee ?? 30
    FakeLimiter.last = this
  }
}

const sent: Array<Record<string, unknown>> = []
let track: FakeTrack
let getUserMediaCalls = 0
let contextsClosed = 0
/** O ctx.destination do AudioContext falso (para conferir o caminho até a saída). */
let destination: object = {}

/** Port falso: guarda o que cada conexão recebeu e deixa o teste derrubá-la (o SW reiniciou). */
class FakePort {
  sent: Array<Record<string, unknown>> = []
  private disconnectListeners: Array<() => void> = []
  postMessage(m: Record<string, unknown>) {
    this.sent.push(m)
    sent.push(m)
  }
  onMessage = { addListener: () => {} }
  onDisconnect = { addListener: (fn: () => void) => void this.disconnectListeners.push(fn) }
  drop() {
    for (const fn of this.disconnectListeners) fn()
  }
}
const ports: FakePort[] = []

function installGlobals() {
  sent.length = 0
  edges.length = 0
  getUserMediaCalls = 0
  contextsClosed = 0
  track = new FakeTrack()
  const stream = { getAudioTracks: () => [track], getTracks: () => [track] }
  destination = {}
  vi.stubGlobal('navigator', {
    mediaDevices: {
      getUserMedia: async () => {
        getUserMediaCalls++
        return stream
      },
    },
  })
  vi.stubGlobal(
    'AudioContext',
    class {
      state = 'running'
      currentTime = 0
      destination = destination
      resume = async () => {}
      close = async () => {
        contextsClosed++
      }
    },
  )
  vi.stubGlobal('MediaStreamAudioSourceNode', FakeSource)
  vi.stubGlobal('GainNode', FakeGain)
  vi.stubGlobal('DynamicsCompressorNode', FakeLimiter)
  vi.stubGlobal('MediaStreamAudioDestinationNode', FakeDest)
  vi.stubGlobal(
    'AnalyserNode',
    class extends FakeNode {
      fftSize = 32
      getFloatTimeDomainData() {}
    },
  )
  vi.stubGlobal('MediaRecorder', FakeRecorder)
  ports.length = 0
  vi.stubGlobal('chrome', {
    runtime: {
      connect: () => {
        const port = new FakePort()
        ports.push(port)
        return port
      },
      lastError: undefined,
    },
  })
}

async function load() {
  vi.resetModules()
  installGlobals()
  return (await import('./tab')).tabHandlers
}

const start = { target: 'offscreen', t: 'offscreen:tab-start', tabId: 7, streamId: 'stream-1', sessionId: 'S-aba', replay: true } as const

beforeEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  FakeRecorder.last = null
  FakeRecorder.failNext = false
})

describe('offscreen do modo aba', () => {
  it('o Port se liga à sessão no início (session:resume), antes de qualquer chunk', async () => {
    const handlers = await load()
    expect(await handlers['offscreen:tab-start'](start)).toEqual({ ok: true })
    expect(sent).toEqual([{ t: 'session:resume', localId: 'S-aba', sessionId: 'S-aba', nextSeq: 0 }])
  })

  it('o Port que volta depois de cair (o SW reiniciou) se liga de novo à sessão antes do primeiro chunk', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    const handlers = await load()
    await handlers['offscreen:tab-start'](start)
    expect(ports).toHaveLength(1)
    ports[0].drop()
    // A reconexão sai sozinha (o primeiro passo do RECONNECT_MS), antes do primeiro chunk (1 s).
    await vi.advanceTimersByTimeAsync(300)
    expect(ports).toHaveLength(2)
    // Sem o resume aqui, um ui:stop que chegasse agora acharia a sessão sem Port no SW e a aba
    // seguiria capturada (a mesma classe do início, Emenda 7).
    expect(ports[1].sent).toEqual([{ t: 'session:resume', localId: 'S-aba', sessionId: 'S-aba', nextSeq: 0 }])
  })

  it('um chunk com o Port caído reconecta: primeiro o session:resume, depois o chunk', async () => {
    const handlers = await load()
    await handlers['offscreen:tab-start'](start)
    ports[0].drop()
    FakeRecorder.last!.requestData()
    await vi.waitFor(() => expect(ports[1]?.sent.some((m) => m.t === 'session:chunk')).toBe(true))
    expect(ports[1].sent.map((m) => m.t)).toEqual(['session:resume', 'session:chunk'])
    expect(ports[1].sent[0]).toEqual({ t: 'session:resume', localId: 'S-aba', sessionId: 'S-aba', nextSeq: 1 })
    expect(ports[1].sent[1]).toMatchObject({ sessionId: 'S-aba', seq: 0 })
  })

  it('a faixa da captura terminando sozinha fecha a gravação: último pedaço e session:end com aba-fechada', async () => {
    const handlers = await load()
    await handlers['offscreen:tab-start'](start)
    expect(FakeRecorder.last!.state).toBe('recording')
    track.dispatchEvent(new Event('ended'))
    await vi.waitFor(() => expect(sent.some((m) => m.t === 'session:end')).toBe(true))
    expect(FakeRecorder.last!.state).toBe('inactive')
    const chunks = sent.filter((m) => m.t === 'session:chunk')
    expect(chunks.map((m) => m.seq)).toEqual([0])
    expect(sent.find((m) => m.t === 'session:end')).toMatchObject({ sessionId: 'S-aba', reason: 'aba-fechada', lastSeq: 0 })
    // Parada de verdade: um tab-start novo na mesma aba começa outra gravação.
    expect(await handlers['offscreen:tab-start']({ ...start, sessionId: 'S-2' })).toEqual({ ok: true })
  })

  it('devolução: começa como o SW pediu e o popup liga ou desliga (Emenda 11)', async () => {
    const handlers = await load()
    await handlers['offscreen:tab-start']({ ...start, replay: false })
    expect(FakeGain.last!.gain.value).toBe(0)
    expect(await handlers['offscreen:tab-replay']({ target: 'offscreen', t: 'offscreen:tab-replay', tabId: 7, on: true })).toEqual({ ok: true })
    expect(FakeGain.last!.gain.value).toBe(1)
    expect(await handlers['offscreen:tab-replay']({ target: 'offscreen', t: 'offscreen:tab-replay', tabId: 7, on: false })).toEqual({ ok: true })
    expect(FakeGain.last!.gain.value).toBe(0)
    // Aba que não está gravando: nada a trocar.
    expect(await handlers['offscreen:tab-replay']({ target: 'offscreen', t: 'offscreen:tab-replay', tabId: 99, on: true })).toEqual({ ok: false })
  })

  it('devolução ligada por padrão (fora do Meet e do Teams o som volta como antes)', async () => {
    const handlers = await load()
    await handlers['offscreen:tab-start'](start)
    expect(FakeGain.last!.gain.value).toBe(1)
  })

  it('o tab-stop leva o motivo ao session:end (sem motivo, parado pelo usuário)', async () => {
    const handlers = await load()
    await handlers['offscreen:tab-start'](start)
    expect(await handlers['offscreen:tab-stop']({ target: 'offscreen', t: 'offscreen:tab-stop', tabId: 7, reason: 'saiu-da-call' })).toEqual({ ok: true })
    expect(sent.find((m) => m.t === 'session:end')).toMatchObject({ reason: 'saiu-da-call' })
    await handlers['offscreen:tab-start']({ ...start, sessionId: 'S-2' })
    await handlers['offscreen:tab-stop']({ target: 'offscreen', t: 'offscreen:tab-stop', tabId: 7 })
    expect(sent.filter((m) => m.t === 'session:end').at(-1)).toMatchObject({ sessionId: 'S-2', reason: 'parado-pelo-usuario' })
  })

  // -------------------------------------------------------------------------------------------
  // Volume por aba (Emenda 14)
  // -------------------------------------------------------------------------------------------

  const volStart = (volume: number) => ({ target: 'offscreen', t: 'offscreen:tab-volume-start', tabId: 7, streamId: 'stream-v', volume }) as const
  const setVolume = (volume: number) => ({ target: 'offscreen', t: 'offscreen:tab-volume', tabId: 7, volume }) as const
  const volStop = { target: 'offscreen', t: 'offscreen:tab-volume-stop', tabId: 7 } as const
  const audioOf = { target: 'offscreen', t: 'offscreen:tab-audio', tabId: 7 } as const
  const replayTo = (on: boolean) => ({ target: 'offscreen', t: 'offscreen:tab-replay', tabId: 7, on }) as const
  /** O gravador tira o som de quem? Só da fonte, nunca do ganho do volume. */
  const recorderFeeds = () => edges.filter(([, to]) => to instanceof FakeDest).map(([from]) => from.constructor.name)

  it('volume: a captura só de volume não tem gravador, o ganho é o volume e 100% a desfaz', async () => {
    const handlers = await load()
    expect(await handlers['offscreen:tab-volume-start'](volStart(1.5))).toEqual({ ok: true })
    expect(getUserMediaCalls).toBe(1)
    expect(FakeRecorder.last, 'só volume não grava').toBeNull()
    expect(sent, 'nada vai ao Port sem gravação').toEqual([])
    expect(FakeGain.last!.gain.value).toBe(1.5)
    expect(await handlers['offscreen:tab-audio'](audioOf)).toEqual({ mode: 'volume', volume: 1.5, replay: true, gain: 1.5 })
    expect(await handlers['offscreen:tab-volume'](setVolume(0.3))).toEqual({ ok: true })
    expect(FakeGain.last!.gain.value).toBe(0.3)
    // Limitado a 0..2 também aqui.
    await handlers['offscreen:tab-volume'](setVolume(7))
    expect(FakeGain.last!.gain.value).toBe(2)
    expect(await handlers['offscreen:tab-volume-stop'](volStop)).toEqual({ ok: true })
    expect(track.readyState, 'a captura foi desfeita').toBe('ended')
    expect(contextsClosed).toBe(1)
    expect(await handlers['offscreen:tab-audio'](audioOf)).toMatchObject({ mode: null })
    // Sem captura, ajustar não acha nada.
    expect(await handlers['offscreen:tab-volume'](setVolume(0.5))).toEqual({ ok: false })
  })

  it('volume -> modo aba: o gravador entra na mesma captura (sem outro getUserMedia), antes do ganho, e o volume fica', async () => {
    const handlers = await load()
    await handlers['offscreen:tab-volume-start'](volStart(0.3))
    const gain = FakeGain.last!
    // Sem streamId: o SW sabe que a aba já tem a captura de volume.
    expect(await handlers['offscreen:tab-start']({ ...start, streamId: undefined })).toEqual({ ok: true })
    expect(getUserMediaCalls, 'um segundo getUserMedia da aba falharia no Chrome').toBe(1)
    expect(FakeGain.last, 'o mesmo grafo').toBe(gain)
    expect(gain.gain.value).toBe(0.3)
    expect(FakeRecorder.last!.state).toBe('recording')
    expect(recorderFeeds(), 'a gravação sai da fonte, antes do volume').toEqual(['FakeSource'])
    expect(await handlers['offscreen:tab-audio'](audioOf)).toMatchObject({ mode: 'gravando', volume: 0.3 })
    // 100% durante a gravação só muda o ganho: a gravação continua.
    expect(await handlers['offscreen:tab-volume-stop'](volStop)).toEqual({ ok: true })
    expect(gain.gain.value).toBe(1)
    expect(FakeRecorder.last!.state).toBe('recording')
    expect(track.readyState).toBe('live')
  })

  it('modo aba -> só volume: parar a gravação com o volume fora de 100% mantém a captura, sem o gravador', async () => {
    const handlers = await load()
    await handlers['offscreen:tab-start'](start)
    expect(recorderFeeds()).toEqual(['FakeSource'])
    await handlers['offscreen:tab-volume'](setVolume(0.3))
    await handlers['offscreen:tab-replay'](replayTo(false))
    expect(FakeGain.last!.gain.value).toBe(0)
    await handlers['offscreen:tab-replay'](replayTo(true))
    await handlers['offscreen:tab-stop']({ target: 'offscreen', t: 'offscreen:tab-stop', tabId: 7 })
    expect(sent.find((m) => m.t === 'session:end')).toMatchObject({ sessionId: 'S-aba' })
    expect(FakeRecorder.last!.state).toBe('inactive')
    expect(track.readyState, 'a captura continua para o volume').toBe('live')
    expect(contextsClosed).toBe(0)
    expect(recorderFeeds(), 'o gravador saiu da fonte').toEqual([])
    // Sem gravação a devolução volta a valer: ouve-se o volume.
    expect(await handlers['offscreen:tab-audio'](audioOf)).toEqual({ mode: 'volume', volume: 0.3, replay: true, gain: 0.3 })
    // E um modo aba novo entra na mesma captura.
    expect(await handlers['offscreen:tab-start']({ ...start, sessionId: 'S-2', streamId: undefined })).toEqual({ ok: true })
    expect(getUserMediaCalls).toBe(1)
  })

  it('parar a gravação com o volume em 100% desfaz a captura (a aba volta ao caminho de som dela)', async () => {
    const handlers = await load()
    await handlers['offscreen:tab-volume-start'](volStart(0.5))
    await handlers['offscreen:tab-start']({ ...start, streamId: undefined })
    await handlers['offscreen:tab-volume'](setVolume(1))
    await handlers['offscreen:tab-stop']({ target: 'offscreen', t: 'offscreen:tab-stop', tabId: 7 })
    expect(track.readyState).toBe('ended')
    expect(contextsClosed).toBe(1)
    expect(await handlers['offscreen:tab-audio'](audioOf)).toMatchObject({ mode: null })
  })

  it('devolução desligada dá ganho 0 qualquer que seja o volume; ligada, o volume', async () => {
    const handlers = await load()
    await handlers['offscreen:tab-start']({ ...start, replay: false })
    for (const v of [0.3, 1, 2]) {
      await handlers['offscreen:tab-volume'](setVolume(v))
      expect(FakeGain.last!.gain.value, `volume ${v}`).toBe(0)
    }
    await handlers['offscreen:tab-replay'](replayTo(true))
    expect(FakeGain.last!.gain.value).toBe(2)
  })

  it('o modo aba sem streamId numa aba sem captura recusa (o SW pede um ID novo)', async () => {
    const handlers = await load()
    expect(await handlers['offscreen:tab-start']({ ...start, streamId: undefined })).toMatchObject({ ok: false })
    expect(getUserMediaCalls).toBe(0)
  })

  it('a faixa terminando numa captura só de volume (aba fechada ou o Chrome encerrou) desfaz a captura', async () => {
    const handlers = await load()
    await handlers['offscreen:tab-volume-start'](volStart(1.5))
    track.dispatchEvent(new Event('ended'))
    await vi.waitFor(() => expect(contextsClosed).toBe(1))
    expect(await handlers['offscreen:tab-audio'](audioOf)).toMatchObject({ mode: null })
    // A próxima captura é nova.
    expect(await handlers['offscreen:tab-volume-start'](volStart(0.5))).toEqual({ ok: true })
    expect(getUserMediaCalls).toBe(2)
  })
  it('parar a gravação com a devolução desligada desfaz a captura, mesmo com o volume fora de 100%', async () => {
    const handlers = await load()
    await handlers['offscreen:tab-volume-start'](volStart(0.3))
    await handlers['offscreen:tab-start']({ ...start, streamId: undefined })
    // A página toca num dispositivo próprio (Emenda 11): o usuário desligou o som repetido.
    await handlers['offscreen:tab-replay'](replayTo(false))
    await handlers['offscreen:tab-stop']({ target: 'offscreen', t: 'offscreen:tab-stop', tabId: 7 })
    expect(sent.find((m) => m.t === 'session:end')).toMatchObject({ sessionId: 'S-aba' })
    expect(track.readyState, 'religar a devolução traria o som em dobro de volta').toBe('ended')
    expect(contextsClosed).toBe(1)
    expect(await handlers['offscreen:tab-audio'](audioOf)).toMatchObject({ mode: null })
  })

  it('a faixa que termina durante a gravação com o volume fora de 100% fecha a gravação e desfaz a captura', async () => {
    const handlers = await load()
    await handlers['offscreen:tab-start'](start)
    await handlers['offscreen:tab-volume'](setVolume(0.3))
    // O evento chega com a faixa ainda "live" no falso: vale o `ended` que o tab.ts guardou.
    track.dispatchEvent(new Event('ended'))
    await vi.waitFor(() => expect(sent.some((m) => m.t === 'session:end')).toBe(true))
    expect(sent.find((m) => m.t === 'session:end')).toMatchObject({ reason: 'aba-fechada' })
    await vi.waitFor(() => expect(contextsClosed).toBe(1))
    expect(await handlers['offscreen:tab-audio'](audioOf)).toMatchObject({ mode: null })
  })

  it('logo depois de a faixa terminar, um modo aba novo não reaproveita a captura que acabou', async () => {
    const handlers = await load()
    await handlers['offscreen:tab-start'](start)
    track.dispatchEvent(new Event('ended'))
    // Ainda fechando a gravação (a captura só é desfeita depois do último pedaço).
    expect(await handlers['offscreen:tab-start']({ ...start, sessionId: 'S-2', streamId: undefined })).toMatchObject({ ok: false })
    expect(getUserMediaCalls).toBe(1)
  })

  it('a captura de volume reaproveitada segue a devolução que o SW pediu', async () => {
    const handlers = await load()
    await handlers['offscreen:tab-volume-start'](volStart(0.3))
    await handlers['offscreen:tab-start']({ ...start, streamId: undefined, replay: false })
    expect(await handlers['offscreen:tab-audio'](audioOf)).toEqual({ mode: 'gravando', volume: 0.3, replay: false, gain: 0 })
  })

  it('o gravador que falha numa captura reaproveitada deixa a captura só de volume, com a devolução ligada', async () => {
    const handlers = await load()
    await handlers['offscreen:tab-volume-start'](volStart(0.3))
    FakeRecorder.failNext = true
    expect(await handlers['offscreen:tab-start']({ ...start, streamId: undefined, replay: false })).toMatchObject({ ok: false, error: 'MediaRecorder recusou' })
    expect(track.readyState, 'o volume continua').toBe('live')
    expect(contextsClosed).toBe(0)
    expect(recorderFeeds()).toEqual([])
    expect(await handlers['offscreen:tab-audio'](audioOf)).toEqual({ mode: 'volume', volume: 0.3, replay: true, gain: 0.3 })
  })

  it('o gravador que falha numa captura nova desfaz a captura', async () => {
    const handlers = await load()
    FakeRecorder.failNext = true
    expect(await handlers['offscreen:tab-start'](start)).toMatchObject({ ok: false })
    expect(track.readyState).toBe('ended')
    expect(contextsClosed).toBe(1)
    expect(await handlers['offscreen:tab-audio'](audioOf)).toMatchObject({ mode: null })
  })

  it('o tab-volume-start também limita o volume a 0..2', async () => {
    const handlers = await load()
    expect(await handlers['offscreen:tab-volume-start'](volStart(7))).toEqual({ ok: true })
    expect(FakeGain.last!.gain.value).toBe(2)
    expect(await handlers['offscreen:tab-audio'](audioOf)).toMatchObject({ mode: 'volume', volume: 2 })
    // Na captura que já existe, também.
    expect(await handlers['offscreen:tab-volume-start'](volStart(-3))).toEqual({ ok: true })
    expect(FakeGain.last!.gain.value).toBe(0)
    expect(await handlers['offscreen:tab-volume-start'](volStart(Number.NaN))).toMatchObject({ ok: false })
  })

  it('a saída passa pelo limitador: neutro até 100%, ligado acima disso', async () => {
    const handlers = await load()
    await handlers['offscreen:tab-volume-start'](volStart(0.5))
    const gain = FakeGain.last!
    const limiter = FakeLimiter.last!
    const into = (n: unknown) => edges.filter(([, to]) => to === n).map(([from]) => from)
    expect(into(limiter), 'ganho -> limitador').toEqual([gain])
    expect(into(destination), 'limitador -> saída, e nada mais na saída').toEqual([limiter])
    expect(limiter.knee.value).toBe(0)
    expect([limiter.threshold.value, limiter.ratio.value], '50%: neutro').toEqual([0, 1])
    await handlers['offscreen:tab-volume'](setVolume(2))
    expect([limiter.threshold.value, limiter.ratio.value], '200%: segura o pico').toEqual([-1, 20])
    await handlers['offscreen:tab-volume'](setVolume(1))
    expect([limiter.threshold.value, limiter.ratio.value], '100%: neutro').toEqual([0, 1])
    // Captura que já nasce acima de 100%.
    await handlers['offscreen:tab-volume-stop'](volStop)
    await handlers['offscreen:tab-volume-start'](volStart(1.5))
    expect([FakeLimiter.last!.threshold.value, FakeLimiter.last!.ratio.value]).toEqual([-1, 20])
  })
})
