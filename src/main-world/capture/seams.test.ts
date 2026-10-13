// Seams "elements", "sources" e "output" numa janela falsa: o que os testes ponta a ponta não
// isolam com facilidade.
// - regra 1: cada embrulho devolve o mesmo objeto que o original devolveu e deixa a exceção do
//   original subir igual;
// - regra 4: o tee nunca é ligado num AudioDestinationNode;
// - regra 6: nunca há tee saindo de um AudioWorkletNode;
// - faixa local (microfone, clone, envio) nunca entra, nem quando a contaminação chega depois;
// - o tee acompanha o disconnect da página.
import { describe, expect, it } from 'vitest'
import type { Originals } from '../originals'
import { createPageGraph } from './page-graph'
import type { Registry } from './registry'
import { installElementsSeam } from './seam-elements'
import { installOutputSeam } from './seam-output'
import { installSourcesSeam } from './seam-sources'

class FakeTrack {
  readyState = 'live'
  readonly kind = 'audio'
  constructor(readonly id: string) {}
}
class FakeStream {
  constructor(readonly tracks: FakeTrack[]) {}
  getAudioTracks() {
    return this.tracks
  }
}

class FakeContext {
  readonly destination: FakeDestination
  private _state = 'running'
  constructor() {
    this.destination = new FakeDestination(this)
  }
  get state() {
    return this._state
  }
  close() {
    this._state = 'closed'
  }
  createMediaStreamSource(stream: FakeStream) {
    // Devolve um objeto marcado: o embrulho tem de devolver exatamente este.
    return new FakeStreamSource(this, stream)
  }
}

/** Ligações feitas pelo connect ORIGINAL (de quem para quem, com saída). */
const edges: Array<{ from: FakeNode; to: FakeNode; out: number }> = []

class FakeNode {
  constructor(private readonly _ctx: FakeContext) {}
  get context() {
    return this._ctx
  }
  connect(to: unknown, out = 0) {
    if (!(to instanceof FakeNode)) return undefined
    if (to.context !== this.context) throw new DOMException('outro contexto', 'InvalidAccessError')
    edges.push({ from: this, to, out })
    return to
  }
  disconnect(...args: unknown[]) {
    const [a, b] = args
    const before = edges.length
    for (let i = edges.length - 1; i >= 0; i--) {
      const e = edges[i]
      if (e.from !== this) continue
      if (args.length === 0) edges.splice(i, 1)
      else if (typeof a === 'number' && e.out === a) edges.splice(i, 1)
      else if (a === e.to && (b === undefined || b === e.out)) edges.splice(i, 1)
    }
    if (args.length > 0 && edges.length === before) throw new DOMException('não ligado', 'InvalidAccessError')
    return undefined
  }
}
class FakeDestination extends FakeNode {}
class FakeGain extends FakeNode {}
class FakeWorklet extends FakeNode {}
class FakeStreamDest extends FakeNode {
  private readonly _stream = new FakeStream([new FakeTrack(`dest-${Math.random()}`)])
  get stream() {
    return this._stream
  }
}
class FakeStreamSource extends FakeNode {
  constructor(
    ctx: FakeContext,
    private readonly _ms: FakeStream,
  ) {
    super(ctx)
  }
  get mediaStream() {
    return this._ms
  }
}
class FakeMedia {
  private _src: unknown = null
  get srcObject() {
    return this._src
  }
  set srcObject(v: unknown) {
    if (v !== null && !(v instanceof FakeStream)) throw new TypeError('srcObject inválido')
    this._src = v
  }
}

function setup() {
  edges.length = 0
  // Os embrulhos são instalados nos protótipos falsos e desfeitos por restore() no fim do teste.
  const nodeProto = FakeNode.prototype as any
  const origConnect = nodeProto.connect
  const origDisconnect = nodeProto.disconnect
  const ctxProto = FakeContext.prototype as any
  const origCreate = ctxProto.createMediaStreamSource
  const mediaDesc = Object.getOwnPropertyDescriptor(FakeMedia.prototype, 'srcObject')!
  const restore = () => {
    nodeProto.connect = origConnect
    nodeProto.disconnect = origDisconnect
    ctxProto.createMediaStreamSource = origCreate
    Object.defineProperty(FakeMedia.prototype, 'srcObject', mediaDesc)
  }
  const locals = new Set<unknown>()
  const registry = {
    isLocal: (t: unknown) => locals.has(t),
    markLocal: (t: unknown) => void locals.add(t),
  } as unknown as Registry
  const win = {
    AudioNode: FakeNode,
    BaseAudioContext: undefined,
    AudioContext: FakeContext,
    HTMLMediaElement: FakeMedia,
    MediaElementAudioSourceNode: undefined,
  }
  let derefs = 0
  class CountingRef<T extends object> extends WeakRef<T> {
    override deref() {
      derefs++
      return super.deref()
    }
  }
  const orig = {
    win,
    AudioContext: FakeContext,
    AudioDestinationNode: FakeDestination,
    MediaStreamAudioDestinationNode: FakeStreamDest,
    MediaStreamAudioSourceNode: FakeStreamSource,
    AudioWorkletNode: FakeWorklet,
    MediaStream: FakeStream,
    streamGetAudioTracks: FakeStream.prototype.getAudioTracks,
    audioNodeConnect: origConnect,
    audioNodeDisconnect: origDisconnect,
    createMediaStreamSource: origCreate,
    createMediaStreamTrackSource: undefined,
    mediaSrcObjectGet: mediaDesc.get,
    mediaSrcObjectSet: mediaDesc.set,
    querySelectorAll: () => [],
    WeakRef: CountingRef,
    now: () => 0,
  } as unknown as Originals
  let notified = 0
  const notify = () => void notified++
  const log = () => {}
  const graph = createPageGraph()
  const output = installOutputSeam(orig, registry, log, notify, graph)
  const sources = installSourcesSeam(orig, registry, log, notify, graph)
  const elements = installElementsSeam(orig, registry, log, notify)
  return { output, sources, elements, locals, restore, notified: () => notified, derefs: () => derefs }
}

/** Ligações nossas: as que saem de um nó da página para um destino de stream que a página não criou. */
const teeEdges = (pageDests: FakeNode[] = []) => edges.filter((e) => e.to instanceof FakeStreamDest && !pageDests.includes(e.to))

describe('seam "output"', () => {
  it('liga no tee o que a página liga no destination e devolve o mesmo objeto do original', () => {
    const s = setup()
    try {
      const ctx = new FakeContext()
      const g = new FakeGain(ctx)
      const r = g.connect(ctx.destination)
      expect(r).toBe(ctx.destination)
      expect(teeEdges()).toHaveLength(1)
      expect(s.output.sources()).toHaveLength(1)
      // Regra 4: nada nosso vai para um AudioDestinationNode.
      const ours = teeEdges().map((e) => e.to)
      for (const e of edges) if (e.to instanceof FakeDestination) expect(ours).not.toContain(e.from)
      // connect para AudioParam (não é nó) devolve o mesmo (undefined) e não mexe no tee.
      expect(g.connect({ param: true })).toBeUndefined()
      expect(teeEdges()).toHaveLength(1)
    } finally {
      s.restore()
    }
  })

  it('a exceção do original sobe igual e nada é ligado', () => {
    const s = setup()
    try {
      const a = new FakeContext()
      const b = new FakeContext()
      const g = new FakeGain(a)
      expect(() => g.connect(b.destination)).toThrow(expect.objectContaining({ name: 'InvalidAccessError' }))
      expect(teeEdges()).toEqual([])
      expect(() => g.disconnect(b.destination)).toThrow(expect.objectContaining({ name: 'InvalidAccessError' }))
    } finally {
      s.restore()
    }
  })

  it('regra 6: nunca há tee saindo de um AudioWorkletNode', () => {
    const s = setup()
    try {
      const ctx = new FakeContext()
      new FakeWorklet(ctx).connect(ctx.destination)
      expect(teeEdges()).toEqual([])
      expect(s.output.sources()).toEqual([])
    } finally {
      s.restore()
    }
  })

  it('fonte de faixa local ligada no destination, direto ou por um ganho ligado antes, fica sem tee', () => {
    const s = setup()
    try {
      const ctx = new FakeContext()
      const mic = new FakeTrack('mic')
      s.locals.add(mic)
      ctx.createMediaStreamSource(new FakeStream([mic])).connect(ctx.destination)
      expect(teeEdges()).toEqual([])
      // Ganho ligado no destination ANTES (ganha tee) e o microfone ligado nele DEPOIS: o tee sai.
      const g = new FakeGain(ctx)
      g.connect(ctx.destination)
      expect(teeEdges()).toHaveLength(1)
      ctx.createMediaStreamSource(new FakeStream([mic])).connect(g)
      expect(teeEdges()).toEqual([])
      expect(s.output.sources()).toEqual([])
      // O tom remoto num ganho separado continua com tee.
      const tom = new FakeGain(ctx)
      tom.connect(ctx.destination)
      expect(teeEdges().map((e) => e.from)).toEqual([tom])
      expect(s.output.sources()).toHaveLength(1)
    } finally {
      s.restore()
    }
  })

  it('ganho que recebe o microfone ANTES de ir para o destination nasce sem tee', () => {
    const s = setup()
    try {
      const ctx = new FakeContext()
      const mic = new FakeTrack('mic')
      s.locals.add(mic)
      const g = new FakeGain(ctx)
      const fonte = ctx.createMediaStreamSource(new FakeStream([mic]))
      fonte.connect(g)
      g.connect(ctx.destination)
      expect(teeEdges()).toEqual([])
      expect(s.output.sources()).toEqual([])
      // Contaminação por mais de um salto: microfone -> ganho -> ganho -> destination.
      const h = new FakeGain(ctx)
      g.connect(h)
      h.connect(ctx.destination)
      expect(teeEdges()).toEqual([])
    } finally {
      s.restore()
    }
  })

  it('o microfone desligado do ganho devolve o tee, e o aviso acompanha', () => {
    const s = setup()
    try {
      const ctx = new FakeContext()
      const mic = new FakeTrack('mic')
      s.locals.add(mic)
      const g = new FakeGain(ctx)
      const before = s.notified()
      g.connect(ctx.destination)
      expect(teeEdges()).toHaveLength(1)
      expect(s.notified()).toBe(before + 1)
      const fonte = ctx.createMediaStreamSource(new FakeStream([mic]))
      fonte.connect(g)
      expect(teeEdges()).toEqual([])
      expect(s.notified()).toBe(before + 2)
      expect(fonte.disconnect(g)).toBeUndefined()
      expect(teeEdges().map((e) => e.from)).toEqual([g])
      expect(s.notified()).toBe(before + 3)
      // De novo, pelo disconnect() sem argumentos.
      fonte.connect(g)
      expect(teeEdges()).toEqual([])
      expect(fonte.disconnect()).toBeUndefined()
      expect(teeEdges().map((e) => e.from)).toEqual([g])
    } finally {
      s.restore()
    }
  })

  it('pedaços ligados um a um não refazem o que já foi ligado (custo O(1) por connect)', () => {
    const s = setup()
    try {
      const ctx = new FakeContext()
      const g = new FakeGain(ctx)
      g.connect(ctx.destination)
      // Metade dos pedaços vai direto no destination, metade num ganho que já tem tee. A versão
      // que refazia todas as entradas a cada connect leria cada referência fraca de novo a cada
      // ligação (~N²/2 leituras para N entradas); a incremental só lê na poda, amortizada.
      const start = s.derefs()
      const n = 4000
      for (let i = 0; i < n; i++) new FakeGain(ctx).connect(i % 2 ? ctx.destination : g)
      const reads = s.derefs() - start
      expect(teeEdges()).toHaveLength(1 + n / 2)
      expect(reads).toBeLessThanOrEqual(3 * (n / 2))
      // A consulta (a cada ~1 s) passa por todas, uma vez.
      const before = s.derefs()
      expect(s.output.sources()).toHaveLength(1)
      expect(s.derefs() - before).toBeLessThanOrEqual(1 + n / 2 + 1)
    } finally {
      s.restore()
    }
  })

  it('faixa que vira local depois (passou a ser envio) tira o tee na consulta seguinte', () => {
    const s = setup()
    try {
      const ctx = new FakeContext()
      const t = new FakeTrack('processada')
      ctx.createMediaStreamSource(new FakeStream([t])).connect(ctx.destination)
      expect(s.output.sources()).toHaveLength(1)
      s.locals.add(t)
      expect(s.output.sources()).toEqual([])
      expect(teeEdges()).toEqual([])
    } finally {
      s.restore()
    }
  })

  it('destino de stream da página alimentado pelo microfone tem as faixas marcadas como locais', () => {
    const s = setup()
    try {
      const ctx = new FakeContext()
      const mic = new FakeTrack('mic')
      s.locals.add(mic)
      const dest = new FakeStreamDest(ctx)
      ctx.createMediaStreamSource(new FakeStream([mic])).connect(dest)
      expect(s.locals.has(dest.stream.tracks[0])).toBe(true)
      // A marca avisa o controlador na hora (o mixer tira a fonte sem esperar a consulta de 1 s).
      expect(s.notified()).toBeGreaterThan(0)
      // E o elemento que toca esse destino fica fora do seam "elements".
      const el = new FakeMedia()
      el.srcObject = dest.stream
      expect(s.elements.sources()).toEqual([])
    } finally {
      s.restore()
    }
  })

  it('acompanha o disconnect da página: do destination, de uma saída e de tudo', () => {
    const s = setup()
    try {
      const ctx = new FakeContext()
      const a = new FakeGain(ctx)
      const b = new FakeGain(ctx)
      const c = new FakeGain(ctx)
      a.connect(ctx.destination)
      b.connect(ctx.destination)
      c.connect(ctx.destination)
      expect(teeEdges()).toHaveLength(3)
      expect(a.disconnect(ctx.destination)).toBeUndefined()
      expect(b.disconnect(0)).toBeUndefined()
      expect(teeEdges().map((e) => e.from)).toEqual([c])
      expect(c.disconnect()).toBeUndefined()
      expect(teeEdges()).toEqual([])
      expect(s.output.sources()).toEqual([])
      // Ligou de novo: o tee volta.
      a.connect(ctx.destination)
      expect(s.output.sources()).toHaveLength(1)
    } finally {
      s.restore()
    }
  })

  it('contexto fechado sai da consulta', () => {
    const s = setup()
    try {
      const ctx = new FakeContext()
      new FakeGain(ctx).connect(ctx.destination)
      expect(s.output.sources()).toHaveLength(1)
      ctx.close()
      expect(s.output.sources()).toEqual([])
    } finally {
      s.restore()
    }
  })
})

describe('seam "sources"', () => {
  it('devolve o nó do original e pega só faixas não locais de nós ligados', () => {
    const s = setup()
    try {
      const ctx = new FakeContext()
      const remota = new FakeTrack('remota')
      const mic = new FakeTrack('mic')
      s.locals.add(mic)
      const stream = new FakeStream([remota])
      const node = ctx.createMediaStreamSource(stream)
      expect(node).toBeInstanceOf(FakeStreamSource)
      expect(node.mediaStream).toBe(stream)
      // Ainda não ligado em nada: a página não o toca.
      expect(s.sources.sources()).toEqual([])
      node.connect(new FakeGain(ctx))
      const [src] = s.sources.sources()
      expect((src.stream as unknown as FakeStream).tracks).toEqual([remota])
      ctx.createMediaStreamSource(new FakeStream([mic])).connect(ctx.destination)
      expect(s.sources.sources()).toHaveLength(1)
      // Faixa que vira local depois (a página passou a mandá-la como envio) sai.
      const depois = new FakeTrack('depois')
      ctx.createMediaStreamSource(new FakeStream([depois])).connect(ctx.destination)
      expect(s.sources.sources()).toHaveLength(2)
      s.locals.add(depois)
      expect(s.sources.sources()).toHaveLength(1)
      // Faixa encerrada sai.
      remota.readyState = 'ended'
      expect(s.sources.sources()).toEqual([])
    } finally {
      s.restore()
    }
  })
})

describe('seam "elements"', () => {
  it('o setter devolve o mesmo valor ao getter, avisa e só a faixa não local entra (uma vez)', () => {
    const s = setup()
    try {
      const remota = new FakeTrack('remota')
      const mic = new FakeTrack('mic')
      s.locals.add(mic)
      const a = new FakeMedia()
      const b = new FakeMedia()
      const stream = new FakeStream([remota])
      const before = s.notified()
      a.srcObject = stream
      expect(a.srcObject).toBe(stream)
      expect(s.notified()).toBe(before + 1)
      b.srcObject = new FakeStream([remota, mic])
      const out = s.elements.sources()
      expect(out).toHaveLength(1)
      expect((out[0].stream as unknown as FakeStream).tracks).toEqual([remota])
      // A exceção do setter original sobe igual.
      expect(() => {
        a.srcObject = {}
      }).toThrow(TypeError)
      a.srcObject = null
      b.srcObject = null
      expect(s.elements.sources()).toEqual([])
    } finally {
      s.restore()
    }
  })
})
