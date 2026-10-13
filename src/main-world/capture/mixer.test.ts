// Regra 4 do MAIN world: nada nosso vai para um AudioDestinationNode e o contexto do mixer nasce
// com sinkId { type: 'none' }. Sem isto, toda call tocaria duas vezes para o usuário e nenhum
// teste de áudio gravado perceberia (o arquivo sai igual). WebAudio falso, que registra cada
// construção e cada connect feito pelo connect ORIGINAL (o único que o mixer pode usar).
import { describe, expect, it } from 'vitest'
import { SEAM_IDS } from '../../shared/constants'
import type { Originals } from '../originals'
import { createMixer } from './mixer'

class FakeNode {
  constructor(
    readonly ctx: FakeContext,
    readonly kind: string,
    readonly opts: unknown = undefined,
  ) {
    ctx.nodes.push(this)
  }
  gain = { value: 1, cancelScheduledValues() {}, setValueAtTime() {}, setTargetAtTime() {} }
  fftSize = 2048
  stream = { id: 'dest' }
  getFloatTimeDomainData(buf: Float32Array) {
    buf.fill(0)
  }
}

class FakeContext {
  static created: Array<{ ctx: FakeContext; opts: unknown }> = []
  static rejectSinkId = false
  readonly nodes: FakeNode[] = []
  readonly destination: FakeNode
  state: AudioContextState = 'running'
  currentTime = 0
  constructor(opts?: { sinkId?: unknown }) {
    if (FakeContext.rejectSinkId && opts && 'sinkId' in opts) throw new TypeError('sinkId não suportado')
    this.destination = new FakeNode(this, 'AudioDestination')
    FakeContext.created.push({ ctx: this, opts })
  }
  resume() {
    return Promise.resolve()
  }
  close() {
    return Promise.resolve()
  }
}

const nodeClass = (kind: string) =>
  class extends FakeNode {
    constructor(ctx: FakeContext, opts?: unknown) {
      super(ctx, kind, opts)
    }
  }

function fakeOriginals() {
  const connects: Array<{ from: FakeNode; to: unknown }> = []
  const orig = {
    win: {},
    AudioContext: FakeContext,
    GainNode: nodeClass('Gain'),
    DelayNode: nodeClass('Delay'),
    AnalyserNode: nodeClass('Analyser'),
    MediaStreamAudioDestinationNode: nodeClass('MediaStreamAudioDestination'),
    MediaStreamAudioSourceNode: nodeClass('MediaStreamAudioSource'),
    audioNodeConnect(this: FakeNode, to: unknown) {
      connects.push({ from: this, to })
      return to
    },
    audioNodeDisconnect() {},
    addEventListener() {},
    removeEventListener() {},
  } as unknown as Originals
  return { orig, connects }
}

function exercise() {
  const { orig, connects } = fakeOriginals()
  const before = FakeContext.created.length
  const mixer = createMixer(orig, () => {})
  expect(mixer).not.toBeNull()
  // Liga fontes em todos os seams e escolhe um: o grafo completo de uma sessão.
  for (const seam of SEAM_IDS) mixer!.sync(seam, [{ key: `${seam}-1`, stream: {} as MediaStream }])
  mixer!.select('receivers')
  mixer!.select('elements')
  const created = FakeContext.created.slice(before)
  return { mixer: mixer!, connects, created }
}

describe('mixer: regra 4 (nada nosso é audível)', () => {
  it('cria o AudioContext com sinkId { type: "none" }', () => {
    FakeContext.rejectSinkId = false
    const { created } = exercise()
    expect(created).toHaveLength(1)
    expect(created[0].opts).toMatchObject({ sinkId: { type: 'none' } })
  })

  it('nenhum connect tem o destino do contexto como alvo, e o gravado é o MediaStreamAudioDestination mono', () => {
    FakeContext.rejectSinkId = false
    const { connects, created, mixer } = exercise()
    const ctx = created[0].ctx
    expect(connects.length).toBeGreaterThan(0)
    for (const c of connects) {
      expect(c.to).not.toBe(ctx.destination)
      expect((c.to as FakeNode).kind).not.toBe('AudioDestination')
    }
    const dests = ctx.nodes.filter((n) => n.kind === 'MediaStreamAudioDestination')
    expect(dests).toHaveLength(1)
    expect(dests[0].opts).toMatchObject({ channelCount: 1, channelCountMode: 'explicit' })
    expect(mixer.stream).toBe(dests[0].stream)
    // Cada seletor termina no destino gravado, e só ele.
    const intoDest = connects.filter((c) => c.to === dests[0])
    expect(intoDest).toHaveLength(SEAM_IDS.length)
    for (const c of intoDest) expect(c.from.kind).toBe('Gain')
  })

  it('sem suporte a sinkId, o contexto de reserva continua sem nada ligado ao destino', () => {
    FakeContext.rejectSinkId = true
    try {
      const { connects, created } = exercise()
      expect(created).toHaveLength(1)
      for (const c of connects) expect(c.to).not.toBe(created[0].ctx.destination)
    } finally {
      FakeContext.rejectSinkId = false
    }
  })
})

// Troca agendada no áudio atrasado (AC5 "sem perder o começo da fala"): o seletor novo entra a
// partir da última fala medida no antigo e o antigo só sai depois do fim provável dela, nunca
// antes do que já saiu da linha de atraso.
describe('mixer: troca de seam no áudio atrasado', () => {
  function withCalls() {
    const { orig } = fakeOriginals()
    const before = FakeContext.created.length
    const mixer = createMixer(orig, () => {})!
    const ctx = FakeContext.created[before].ctx
    for (const seam of SEAM_IDS) mixer.sync(seam, [{ key: `${seam}-1`, stream: {} as MediaStream }])
    // Grupos na ordem de SEAM_IDS: [soma, analisador, atraso, seletor] por seam.
    const gains = ctx.nodes.filter((n) => n.kind === 'Gain')
    const analysers = ctx.nodes.filter((n) => n.kind === 'Analyser')
    const calls: Array<[string, string, number, number]> = []
    SEAM_IDS.forEach((id, i) => {
      const sel = gains[i * 2 + 1]
      sel.gain = {
        value: 0,
        cancelScheduledValues() {},
        setValueAtTime: (v: number, t: number) => void calls.push([id, 'set', v, t]),
        setTargetAtTime: (v: number, t: number) => void calls.push([id, 'target', v, Math.round(t * 1000) / 1000]),
      } as never
    })
    const loud = (id: string, on: boolean) => {
      analysers[SEAM_IDS.indexOf(id as never)].getFloatTimeDomainData = (buf: Float32Array) => void buf.fill(on ? 0.5 : 0)
    }
    return { mixer, ctx, calls, loud }
  }

  it('a primeira escolha é imediata', () => {
    const { mixer, calls } = withCalls()
    mixer.select('receivers')
    expect(calls).toEqual(SEAM_IDS.map((id) => [id, 'set', id === 'receivers' ? 1 : 0, 0]))
  })

  it('passagem: o novo entra na última fala do antigo e o antigo sai um laço e uma janela depois', () => {
    const { mixer, ctx, calls, loud } = withCalls()
    mixer.select('receivers')
    calls.length = 0
    ctx.currentTime = 10
    loud('receivers', true)
    mixer.measure()
    loud('receivers', false)
    ctx.currentTime = 11.1
    mixer.measure()
    mixer.select('sources')
    expect(calls).toEqual([
      ['receivers', 'target', 0, 11.8],
      ['elements', 'target', 0, 11.1],
      ['sources', 'target', 1, 11.5],
      ['output', 'target', 0, 11.1],
    ])
  })

  it('antigo calado há mais que o atraso: a troca vale já, para o áudio de 1,5 s atrás', () => {
    const { mixer, ctx, calls, loud } = withCalls()
    mixer.select('receivers')
    calls.length = 0
    ctx.currentTime = 2
    loud('receivers', true)
    mixer.measure()
    ctx.currentTime = 9
    mixer.select('output')
    expect(calls.map((c) => c[3])).toEqual([9, 9, 9, 9])
    expect(calls.find((c) => c[0] === 'output')).toEqual(['output', 'target', 1, 9])
  })
})
