// Controlador da sessão, parte da Emenda 18: a linha do tempo dos falantes no fim. O mixer e o
// gravador são falsos (sem Web Audio no node); a arbitragem, a linha do tempo e o relógio são os de
// verdade, no relógio falso do vitest. O "SW" aplica os lotes com o applySpeakersBatch de verdade
// e perde um deles no meio (como um SW que reiniciou com o lote em voo). Confere que:
// - o fim (finish) manda a linha inteira antes do session:end: refaz o lote perdido e leva quem só
//   falou depois do último lote periódico;
// - o pagehide também, e corta a linha no fim do áudio (o gravador para na hora, sem gravar o
//   atraso do mixer): quem começou ao vivo no último 1,5 s não está no áudio.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MIXER_DELAY_MS } from '../shared/constants'
import type { Down, SpeakerInterval, Up } from '../shared/protocol'
import type { MicTrackState } from '../shared/mic-gate'
import { applySpeakersBatch, type SpeakerTimelineRecord } from '../shared/speakers'
import type { Bridge } from './bridge'
import type { Registry } from './capture/registry'
import type { SeamSet } from './capture/seams'
import type { Originals } from './originals'
import type { PlatformAdapter, SpeakerProbe } from './platforms/types'

const recorder = {
  state: 'recording' as RecordingState,
  lastSeq: 0,
  bytes: 0,
  start() {},
  requestData: vi.fn(),
  stop: vi.fn(async () => 0),
}
let micDb = () => -100
/** Emenda 24: o estado das faixas de microfone que o registry "observa" em cada leitura. */
let micInputs: () => MicTrackState[] = () => []

vi.mock('./capture/recorder', () => ({ createRecorder: () => recorder }))
vi.mock('./capture/mixer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./capture/mixer')>()),
  createMixer: () => ({
    stream: {},
    selected: null,
    sync() {},
    sourceCount: () => 1,
    // O áudio dos outros sempre com fala: o dsh vale.
    measure: () => ({ receivers: { sources: 1, dbfs: -20 }, elements: { sources: 0, dbfs: -100 }, sources: { sources: 0, dbfs: -100 }, output: { sources: 0, dbfs: -100 } }),
    select() {},
    measureMic: () => micDb(),
    ctxState: () => 'running',
    close() {},
  }),
}))

const { startSessionController } = await import('./session')

const T0 = 1_760_000_000_000

interface Harness {
  sent: Up[]
  /** O `remoteSpeech` de cada leitura do adaptador. */
  remote: Array<boolean | undefined>
  stored: () => SpeakerInterval[]
  startedAt: () => number
  win: EventTarget
  end: () => void
  /** Avança o relógio falso até `rel` ms depois do começo da gravação. */
  until: (rel: number) => Promise<void>
}

/**
 * Sobe o controlador com o roteiro de quem fala (`who(rel)`, rel = ms desde o começo da gravação)
 * e o SW falso que perde o lote de número `dropBatch` (1 = o primeiro).
 */
async function harness(who: (rel: number) => string[], dropBatch: number): Promise<Harness> {
  const sent: Up[] = []
  let down: (m: Down) => void = () => {}
  let record: SpeakerTimelineRecord | null = null
  let batches = 0
  let startedAt = 0
  let ended = false
  const remote: Array<boolean | undefined> = []
  const bridge: Bridge = {
    send(m) {
      sent.push(m)
      if (m.t === 'session:start') {
        startedAt = m.startedAt
        queueMicrotask(() => down({ t: 'session:accepted', localId: m.localId, sessionId: 's1' }))
      }
      if (m.t === 'session:speakers' && ++batches !== dropBatch) record = applySpeakersBatch(record, m).record
    },
    onDown(cb) {
      down = cb
      return () => {}
    },
  }
  const win = Object.assign(new EventTarget(), { document: undefined })
  const orig = {
    setInterval: (fn: () => void, ms: number) => setInterval(fn, ms),
    clearInterval: (id: number) => clearInterval(id),
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (id: number) => clearTimeout(id),
    now: () => Date.now(),
    MutationObserver: undefined,
    win,
    addEventListener: EventTarget.prototype.addEventListener,
  } as unknown as Originals
  const adapter: PlatformAdapter = {
    id: 'teams',
    matchesUrl: () => true,
    seamPriority: ['receivers', 'elements', 'sources', 'output'],
    isInCall: () => true,
    endSignal: () => (ended ? 'saiu-da-call' : null),
    readMeta: () => ({}),
    readSpeakers: (p: SpeakerProbe) => {
      remote.push(p.remoteSpeech)
      return { nomes: startedAt ? who(p.now - startedAt) : [], fonte: 'dsh' }
    },
    speakerAliases: () => ({}),
    speakerDiagnostics: () => ({ csrc: { receptores: 1, fontes: [{ csrc: 42, leiturasAtiva: 3, receptores: 1, resolvida: false, mesmoPacoteComNomeada: 3, ignorada: 'mais-alto' }] } }),
  }
  const registry = {
    probe: () => ({ now: Date.now(), pcsOpen: 1, pcsConnected: 1, connectedWithLiveAudio: true, reconnectingWithAudio: false, liveRemoteAudioTracks: 1, audioPcClosedAt: null }),
    contributingSources: () => [],
    localMicTracks: () => [],
    micGateInputs: () => micInputs(),
  } as unknown as Registry
  const seams = { all: [], onChange: () => () => {}, primedCount: () => 0 } as unknown as SeamSet
  startSessionController({ orig, log: () => {}, adapter, registry, seams, bridge })
  await vi.advanceTimersByTimeAsync(3500)
  expect(startedAt).toBeGreaterThan(0)
  return {
    sent,
    remote,
    stored: () => record?.intervals ?? [],
    startedAt: () => startedAt,
    win,
    end: () => (ended = true),
    until: async (rel) => {
      await vi.advanceTimersByTimeAsync(startedAt + rel - Date.now())
    },
  }
}

const rows = (list: readonly SpeakerInterval[]) => list.map((i) => [i.voce ? 'Você' : i.nome, i.de, i.ate])
const D = MIXER_DELAY_MS

beforeEach(() => {
  vi.useFakeTimers({ now: T0 })
  vi.stubGlobal('location', { href: 'https://teams.microsoft.com/v2/' })
  vi.stubGlobal('window', {})
  vi.stubGlobal('document', { readyState: 'complete' })
  micDb = () => -100
  micInputs = () => []
  recorder.requestData.mockClear()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

// Ana de 0 a 6 s, Bruno de 6 a 12 s, a Carla só depois do último lote periódico (15 s).
const script = (rel: number) => (rel < 6000 ? ['Ana Souza'] : rel < 12_000 ? ['Bruno Lima'] : rel >= 16_000 ? ['Carla Dias'] : [])

describe('falantes no fim da gravação (Emenda 18)', () => {
  it('o finish manda a linha inteira antes do session:end: refaz o lote perdido e leva quem falou depois do último', async () => {
    const h = await harness(script, 2)
    // Você fala de 12,5 a 14,5 s (ao vivo, desde o começo da gravação).
    micDb = () => {
      const rel = Date.now() - h.startedAt()
      return rel >= 12_500 && rel < 14_500 ? -20 : -100
    }
    await h.until(19_500)
    // Até aqui, com o 2º lote perdido: a Ana com o fim velho e nada da Carla.
    expect(rows(h.stored()).map((r) => r[0])).not.toContain('Carla Dias')
    h.end()
    await h.until(25_000)
    const kinds = h.sent.map((m) => m.t)
    const lastBatch = kinds.lastIndexOf('session:speakers')
    expect(kinds.indexOf('session:end')).toBeGreaterThan(lastBatch)
    expect(h.sent[lastBatch]).toMatchObject({ from: 0 })
    // Emenda 20: o diagnóstico vai só no lote final, o da linha inteira.
    expect(h.sent[lastBatch]).toMatchObject({ diagnostico: { csrc: { receptores: 1 } } })
    expect(h.sent.filter((m, i) => m.t === 'session:speakers' && i !== lastBatch && 'diagnostico' in m)).toEqual([])
    const got = rows(h.stored())
    expect(got.slice(0, 3)).toEqual([
      ['Ana Souza', 250 + D, 5750 + 250 + D],
      ['Bruno Lima', 6000 + D, 11_750 + 250 + D],
      ['Você', 12_500 + D, 14_250 + 250 + D],
    ])
    expect(got).toHaveLength(4)
    const [nome, de, ate] = got[3]
    expect([nome, de]).toEqual(['Carla Dias', 16_000 + D])
    // Fechada no começo do finish (o fim chegou no tick de 20 s), com o atraso.
    expect(ate).toBeGreaterThanOrEqual(20_000 + D)
    expect(ate).toBeLessThanOrEqual(20_250 + D)
    // O adaptador sabe que o áudio dos outros tem fala (o dsh do Teams depende disso).
    expect(h.remote.length).toBeGreaterThan(50)
    expect(h.remote.every((r) => r === true)).toBe(true)
  })

  // Emenda 24: a regra do mudo só MEDE nesta fatia. O portão fecha no meio da call (o aplicativo
  // parou de enviar e manteve a faixa viva) e a linha do tempo não muda por isso: a sua fala
  // continua vindo do medidor do microfone, como na Emenda 18.
  it('o portão do microfone vai nos números do lote final e não mexe na linha do tempo', async () => {
    // O estado é montado antes do controlador subir: assim a primeira leitura já pega o portão
    // aberto, como numa call em que a pessoa entra com o microfone ligado.
    let hh: Harness | undefined
    micDb = () => -20
    micInputs = () => {
      const rel = hh ? Date.now() - hh.startedAt() : 0
      return [{ readyState: 'live', enabled: true, muted: false, sender: rel < 6000 ? 3 : null }]
    }
    const h = (hh = await harness(script, 0))
    await h.until(12_000)
    h.end()
    await h.until(17_000)
    const batches = h.sent.filter((m) => m.t === 'session:speakers')
    const last = batches.at(-1) as { diagnostico?: { microfone?: Record<string, unknown> } }
    const mic = last.diagnostico?.microfone as
      | { leituras: number; abriu: number; fechou: number; segundosAberto: number; segundosFechado: number; faixasMax: number; motivos: Record<string, number> }
      | undefined
    expect(mic).toBeDefined()
    expect(mic).toMatchObject({ abriu: 1, fechou: 1, faixasMax: 1 })
    expect(mic!.leituras).toBeGreaterThan(40)
    expect(mic!.segundosAberto).toBeGreaterThanOrEqual(5)
    expect(mic!.segundosAberto).toBeLessThanOrEqual(6.5)
    expect(mic!.segundosFechado).toBeGreaterThanOrEqual(5)
    expect(mic!.motivos).toMatchObject({ readyState: 0, enabled: 0, muted: 0, semFaixa: 0, desconhecido: 0 })
    expect(mic!.motivos.semSender).toBeGreaterThan(20)
    // Só no lote final, como o diagnóstico de CSRC.
    expect(batches.slice(0, -1).filter((m) => 'diagnostico' in m)).toEqual([])
    // A linha do tempo não sentiu o portão: você continua falando depois de o portão fechar.
    const voce = rows(h.stored()).filter((r) => r[0] === 'Você')
    expect(voce).toHaveLength(1)
    expect(Number(voce[0][2])).toBeGreaterThan(10_000 + D)
  })

  it('o pagehide manda a linha inteira, cortada no fim do áudio, antes do session:end', async () => {
    const who = (rel: number) => [...script(rel), ...(rel >= 18_500 ? ['Davi Rocha'] : [])]
    const h = await harness(who, 2)
    await h.until(19_100)
    h.win.dispatchEvent(new Event('pagehide'))
    expect(recorder.requestData).toHaveBeenCalled()
    const kinds = h.sent.map((m) => m.t)
    expect(kinds.at(-1)).toBe('session:end')
    expect(h.sent.at(-1)).toMatchObject({ reason: 'pagehide' })
    expect(h.sent.at(-2)).toMatchObject({ t: 'session:speakers', from: 0 })
    // O gravador parou em 19,1 s: no áudio, nada passa disso. O Davi começou ao vivo em 18,5 s
    // (20 s no áudio, depois do fim) e não aparece.
    expect(rows(h.stored())).toEqual([
      ['Ana Souza', 250 + D, 5750 + 250 + D],
      ['Bruno Lima', 6000 + D, 11_750 + 250 + D],
      ['Carla Dias', 16_000 + D, 19_100],
    ])
  })
})
