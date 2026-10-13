// Seam "output": o que a página manda para o alto-falante pelo WebAudio dela (docs/ARQUITETURA.md,
// "Captura: as quatro fontes"). Cobre o áudio que nunca passa por um receptor nem por um
// elemento: decodificado em JS/WASM e tocado por AudioBufferSourceNode, gerador etc.
//
// AudioNode.prototype.connect e disconnect são embrulhados (original primeiro, mesmo retorno).
// Quando a página liga um nó num AudioDestinationNode, ligamos também o mesmo nó (mesma saída)
// num MediaStreamAudioDestinationNode nosso, um por contexto da página: o "tee". O stream do tee é
// local, então entra no mixer sem o problema do crbug 40094084. O tee nunca vai para um
// AudioDestinationNode (regra 4): é um destino de stream, sem saída.
//
// Nunca há tee quando:
// - a origem é um AudioWorkletNode (regra 6: o NetEQ do Meet derruba o renderer);
// - a origem é alimentada, direta ou indiretamente, por uma faixa local (microfone, clone, envio).
//   O embrulho do connect mantém o grafo da página (page-graph.ts), e uma origem
//   "contaminada" por um MediaStreamAudioSourceNode ou MediaElementAudioSourceNode de faixa local
//   fica fora. É mais largo que o mínimo da arquitetura (só a fonte local ligada direto no
//   destino): um GainNode que soma microfone e call também fica fora, porque não dá para separar.
//
// Custo e memória (AC14: a página não pode ficar mais lenta nem segurar o que largou). A página
// pode ligar dezenas de AudioBufferSourceNode por segundo, um por pedaço decodificado, a call
// inteira. Por isso:
// - nada aqui segura um nó da página: o que ela ligou no destination fica por WeakRef, e o grafo só
//   guarda arestas de saída num mapa fraco (page-graph.ts). Medido no CfT com a versão anterior
//   (conjuntos fortes): 12000 de 12000 pedaços já tocados continuavam vivos depois do coletor;
//   sem a extensão, 0 (tests/e2e/seams.spec.ts, "custo e memória do connect");
// - a contaminação é calculada para a frente, a partir das fontes de stream e de elemento (poucas),
//   e guardada; ela só muda quando a página liga ou desliga um nó contaminado ou uma dessas fontes,
//   ou quando uma faixa vira local (a consulta de ~1 s refaz tudo). Uma ligação comum (pedaço ->
//   ganho, ou pedaço -> destination) custa O(1) e mexe só na origem dela. Medido no mesmo teste,
//   a cada 1000 ligações: sem a extensão 1 ms; com esta versão 1-2 ms (ganho) e 3-4 ms
//   (destination, o tee é um connect a mais); com a anterior, que refazia tudo a cada ligação,
//   de 44 para 778 ms (ganho) e de 879 para 2129 ms (destination) ao longo de 12 lotes.
//
// O mesmo grafo serve aos outros seams: um MediaStreamAudioDestinationNode DA PÁGINA alimentado por
// faixa local (microfone processado que a página toca num <audio>) tem as faixas do stream dele
// marcadas como locais, e então os seams "elements" e "sources" também o deixam de fora. A marca é
// permanente de propósito: um clone feito depois dela também é local (o embrulho de clone do
// registro herda a marca), e desmarcar trocaria um risco de gravar o microfone (AC3) por perder a
// call nesse caminho num caso raro. Marcar avisa o controlador (notify), que tira a fonte do mixer
// na hora, sem esperar a consulta seguinte.
import type { Originals } from '../originals'
import { replaceMethod, type AnyFn } from '../wrap'
import type { PageGraph } from './page-graph'
import type { Registry } from './registry'
import type { Seam, SeamSource } from './seams'
import { audioTracksOf, protoGetter, type Log } from './seam-util'

/** Um nó que a página ligou no AudioDestinationNode. */
interface Wanted {
  ref: WeakRef<AudioNode>
  /** Saídas que a página ligou no destination. */
  outs: Set<number>
  /** Saídas ligadas no tee agora. */
  active: Set<number>
  /** Esta entrada conta em `activeEntries`? */
  counted: boolean
}

interface ContextInfo {
  ctx: AudioContext
  /** Nosso destino de stream neste contexto (criado na primeira ligação permitida). */
  tee: { node: MediaStreamAudioDestinationNode; source: SeamSource } | null
  wanted: WeakMap<AudioNode, Wanted>
  list: Set<Wanted>
  /** Tamanho de `list` que dispara a poda das entradas cujo nó o coletor já levou. */
  pruneAt: number
  /** Entradas com alguma saída no tee (o tee só entra no mixer com alguma). */
  activeEntries: number
  /** MediaStreamAudioDestinationNode da página neste contexto. */
  pageDests: Set<WeakRef<MediaStreamAudioDestinationNode>>
  knownDests: WeakSet<MediaStreamAudioDestinationNode>
}

/** Poda mínima: abaixo disso a lista nunca é varrida fora da consulta. */
const PRUNE_MIN = 256

const EMPTY: Seam = { id: 'output', sources: () => [] }

export function installOutputSeam(orig: Originals, registry: Registry, log: Log, notify: () => void, graph: PageGraph): Seam {
  const w = orig.win as Window &
    typeof globalThis & { BaseAudioContext?: typeof BaseAudioContext; MediaElementAudioSourceNode?: typeof MediaElementAudioSourceNode }
  const NodeClass = w.AudioNode
  const connect = orig.audioNodeConnect as ((this: AudioNode, ...a: unknown[]) => unknown) | undefined
  const disconnect = orig.audioNodeDisconnect as ((this: AudioNode, ...a: unknown[]) => unknown) | undefined
  const AC = orig.AudioContext
  const Dest = orig.AudioDestinationNode
  const StreamDest = orig.MediaStreamAudioDestinationNode
  if (!NodeClass || !connect || !disconnect || !AC || !Dest || !StreamDest) return EMPTY

  // Getters originais, capturados agora (no document_start, antes de qualquer código da página).
  const nodeContext = protoGetter<AudioNode>(NodeClass.prototype, 'context')
  const ctxState = protoGetter<BaseAudioContext>(w.BaseAudioContext?.prototype ?? AC.prototype, 'state')
  const StreamSource = orig.MediaStreamAudioSourceNode
  const streamOfSource = protoGetter<MediaStreamAudioSourceNode>(StreamSource?.prototype, 'mediaStream')
  const ElementSource = w.MediaElementAudioSourceNode
  const elementOfSource = protoGetter<MediaElementAudioSourceNode>(ElementSource?.prototype, 'mediaElement')
  const streamOfDest = protoGetter<MediaStreamAudioDestinationNode>(StreamDest.prototype, 'stream')
  const Worklet = orig.AudioWorkletNode
  const Ref = orig.WeakRef

  const contexts = new Map<BaseAudioContext, ContextInfo>()
  const ours = new WeakSet<AudioNode>()
  let counter = 0

  // Fontes de stream e de elemento que a página ligou em algum lugar: de onde a contaminação parte.
  // Por WeakRef: o Chrome mantém viva uma fonte de stream ligada (medido no CfT: sem nenhuma
  // referência da página, ela sobrevive ao coletor), então uma que some não toca mais nada.
  const seeds = new Set<WeakRef<AudioNode>>()
  const knownSeeds = new WeakSet<AudioNode>()
  /** Nós alcançados por alguma faixa local, calculado por `refreshTaint`. */
  let taint = new WeakSet<AudioNode>()
  /** A contaminação guardada pode estar velha (refeita no fim do mesmo evento). */
  let dirty = true

  const contextOf = (n: AudioNode): BaseAudioContext | null => {
    try {
      return (nodeContext ? nodeContext.call(n) : n.context) as BaseAudioContext
    } catch {
      return null
    }
  }
  const isClosed = (ctx: BaseAudioContext): boolean => {
    try {
      return (ctxState ? ctxState.call(ctx) : ctx.state) === 'closed'
    } catch {
      return true
    }
  }

  const anyLocal = (s: unknown) => audioTracksOf(orig, s).some((t) => registry.isLocal(t))
  const isSeedType = (n: AudioNode): boolean => (!!StreamSource && n instanceof StreamSource) || (!!ElementSource && n instanceof ElementSource)

  /** O nó toca uma faixa local? (fonte de stream ou de elemento com microfone, clone, envio) */
  const isLocalSource = (n: AudioNode): boolean => {
    try {
      if (StreamSource && n instanceof StreamSource) return anyLocal(streamOfSource ? streamOfSource.call(n) : n.mediaStream)
      if (ElementSource && n instanceof ElementSource) {
        const el = elementOfSource ? elementOfSource.call(n) : n.mediaElement
        const src = el && (orig.mediaSrcObjectGet ? orig.mediaSrcObjectGet.call(el as HTMLMediaElement) : (el as HTMLMediaElement).srcObject)
        return anyLocal(src)
      }
    } catch (e) {
      log('fonte local?', e)
    }
    return false
  }

  /** Refaz a contaminação: tudo o que uma fonte local alcança pelas saídas. */
  const computeTaint = () => {
    const next = new WeakSet<AudioNode>()
    const stack: AudioNode[] = []
    for (const ref of seeds) {
      const n = ref.deref()
      if (!n) seeds.delete(ref)
      else if (isLocalSource(n)) stack.push(n)
    }
    while (stack.length > 0) {
      const n = stack.pop()!
      if (next.has(n)) continue
      next.add(n)
      for (const o of graph.outputsOf(n)) if (!next.has(o)) stack.push(o)
    }
    taint = next
  }

  /** Marca como locais as faixas dos destinos de stream da página contaminados. Marcou alguma? */
  const markPageDests = (): boolean => {
    let marked = false
    for (const info of contexts.values()) {
      for (const ref of info.pageDests) {
        const d = ref.deref()
        if (!d) {
          info.pageDests.delete(ref)
          continue
        }
        if (!taint.has(d)) continue
        for (const t of audioTracksOf(orig, streamOfDest ? streamOfDest.call(d) : d.stream)) {
          if (registry.isLocal(t)) continue
          registry.markLocal(t)
          marked = true
        }
      }
    }
    return marked
  }

  /**
   * Contaminação e marcas em dia. Uma faixa recém-marcada pode ser a de uma fonte de stream (a
   * página levou o destino processado para outro nó), então repete até nada novo ser marcado
   * (termina: cada volta marca pelo menos uma faixa de um conjunto finito).
   */
  const refreshTaint = (): boolean => {
    let marked = false
    for (;;) {
      computeTaint()
      if (!markPageDests()) break
      marked = true
    }
    dirty = false
    return marked
  }

  const infoFor = (ctx: BaseAudioContext): ContextInfo | null => {
    // Só AudioContext tem MediaStreamAudioDestinationNode (OfflineAudioContext não).
    if (!(ctx instanceof AC)) return null
    let info = contexts.get(ctx)
    if (!info) {
      for (const c of contexts.keys()) if (isClosed(c)) contexts.delete(c)
      info = {
        ctx,
        tee: null,
        wanted: new WeakMap(),
        list: new Set(),
        pruneAt: PRUNE_MIN,
        activeEntries: 0,
        pageDests: new Set(),
        knownDests: new WeakSet(),
      }
      contexts.set(ctx, info)
    }
    return info
  }

  const ensureTee = (info: ContextInfo) => {
    if (info.tee) return info.tee
    const node = new StreamDest(info.ctx)
    ours.add(node)
    const stream = (streamOfDest ? streamOfDest.call(node) : node.stream) as MediaStream
    info.tee = { node, source: { key: `out-${++counter}`, stream } }
    return info.tee
  }

  /**
   * Deixa o tee coerente para uma entrada: liga as saídas permitidas que faltam e tira as que não
   * valem mais. `node` undefined: o coletor levou o nó (a ligação dele no tee foi junto).
   */
  const apply = (info: ContextInfo, e: Wanted, node: AudioNode | undefined) => {
    if (node) {
      const allowed = !(Worklet && node instanceof Worklet) && !taint.has(node)
      for (const out of e.outs) {
        if (!allowed || e.active.has(out)) continue
        try {
          connect.call(node, ensureTee(info).node, out)
          e.active.add(out)
        } catch (err) {
          log('tee', err)
        }
      }
      for (const out of [...e.active]) {
        if (allowed && e.outs.has(out)) continue
        try {
          if (info.tee) disconnect.call(node, info.tee.node, out)
        } catch {
          // já desligado pela própria página
        }
        e.active.delete(out)
      }
    } else {
      e.outs.clear()
      e.active.clear()
    }
    const counts = e.active.size > 0
    if (counts !== e.counted) {
      info.activeEntries += counts ? 1 : -1
      e.counted = counts
    }
    if (e.outs.size === 0 && e.active.size === 0) {
      info.list.delete(e)
      if (node) info.wanted.delete(node)
    }
  }

  /** Tira da lista as entradas cujo nó o coletor levou. Custo amortizado O(1) por ligação. */
  const prune = (info: ContextInfo) => {
    for (const e of info.list) if (!e.ref.deref()) apply(info, e, undefined)
    info.pruneAt = Math.max(PRUNE_MIN, 2 * info.list.size)
  }

  /** Passada completa: contaminação, marcas e o tee de todo contexto. */
  const reconcileAll = () => {
    let changed = refreshTaint()
    for (const [ctx, info] of contexts) {
      if (isClosed(ctx)) {
        contexts.delete(ctx)
        continue
      }
      const before = info.activeEntries > 0
      for (const e of info.list) apply(info, e, e.ref.deref())
      info.pruneAt = Math.max(PRUNE_MIN, 2 * info.list.size)
      if (before !== info.activeEntries > 0) changed = true
    }
    if (changed) notify()
  }

  /** Ajuste de uma entrada só, avisando o controlador se o tee entrou ou saiu do mixer. */
  const applyOne = (info: ContextInfo, e: Wanted, node: AudioNode) => {
    const before = info.activeEntries > 0
    apply(info, e, node)
    if (before !== info.activeEntries > 0) notify()
  }

  const afterConnect = (src: AudioNode, args: unknown[]) => {
    const dst = args[0]
    if (!(src instanceof NodeClass) || !(dst instanceof NodeClass) || ours.has(dst)) return
    if (dirty) reconcileAll()
    graph.link(src, dst)
    // Contaminação só muda se a origem é uma fonte de stream/elemento ou já está contaminada.
    if (isSeedType(src)) {
      if (!knownSeeds.has(src)) {
        knownSeeds.add(src)
        seeds.add(new Ref(src))
      }
      dirty = true
    } else if (taint.has(src)) dirty = true
    const ctx = contextOf(src)
    let entry: { info: ContextInfo; e: Wanted } | null = null
    if (ctx && dst instanceof Dest) {
      const info = infoFor(ctx)
      if (info) {
        let e = info.wanted.get(src)
        if (!e) {
          if (info.list.size >= info.pruneAt) prune(info)
          e = { ref: new Ref(src), outs: new Set(), active: new Set(), counted: false }
          info.wanted.set(src, e)
          info.list.add(e)
        }
        e.outs.add(Number(args[1] ?? 0) >>> 0)
        entry = { info, e }
      }
    } else if (ctx && dst instanceof StreamDest) {
      const info = infoFor(ctx)
      if (info && !info.knownDests.has(dst)) {
        info.knownDests.add(dst)
        info.pageDests.add(new Ref(dst))
      }
    }
    if (dirty) reconcileAll()
    else if (entry) applyOne(entry.info, entry.e, src)
  }

  const afterDisconnect = (src: AudioNode, args: unknown[]) => {
    if (!(src instanceof NodeClass)) return
    if (dirty) reconcileAll()
    // Desligar um nó limpo não muda a contaminação de ninguém; desligar um contaminado pode tirar.
    const wasTainted = taint.has(src)
    const ctx = contextOf(src)
    const info = ctx ? contexts.get(ctx) : undefined
    const e = info?.wanted.get(src)
    const [a, b] = args
    if (args.length === 0) {
      // disconnect(): o original tirou todas as saídas, inclusive a do tee.
      graph.unlinkAll(src)
      if (e) {
        e.outs.clear()
        e.active.clear()
      }
    } else if (a instanceof NodeClass) {
      // disconnect(nó[, saída[, entrada]]). Sem saída, todas as ligações para o nó saem. Com
      // saída, o grafo fica como está (mais contaminação, nunca menos: o lado seguro).
      if (b === undefined) graph.unlink(src, a)
      if (e && a instanceof Dest) {
        if (b === undefined) e.outs.clear()
        else e.outs.delete(Number(b) >>> 0)
      }
    } else if (typeof a === 'number' || typeof a === 'string' || a === undefined || a === null) {
      // disconnect(saída): o original tirou todas as ligações dessa saída, inclusive a do tee.
      const out = Number(a ?? 0) >>> 0
      if (e) {
        e.outs.delete(out)
        e.active.delete(out)
      }
    }
    // disconnect(AudioParam...): não muda o grafo de nós nem o tee.
    if (wasTainted) {
      dirty = true
      reconcileAll()
    } else if (info && e) applyOne(info, e, src)
  }

  {
    const o = connect
    replaceMethod(NodeClass.prototype, 'connect', o as AnyFn, function (this: AudioNode, ...args: unknown[]) {
      const r = o.apply(this, args)
      try {
        afterConnect(this, args)
      } catch (e) {
        log('connect', e)
      }
      return r
    } as AnyFn)
  }
  {
    const o = disconnect
    replaceMethod(NodeClass.prototype, 'disconnect', o as AnyFn, function (this: AudioNode, ...args: unknown[]) {
      const r = o.apply(this, args)
      try {
        afterDisconnect(this, args)
      } catch (e) {
        log('disconnect', e)
      }
      return r
    } as AnyFn)
  }

  return {
    id: 'output',
    sources() {
      // A cada consulta tudo é refeito: uma faixa pode ter virado local (passou a ser envio) e o
      // srcObject de um elemento ligado por MediaElementAudioSourceNode pode ter mudado.
      try {
        dirty = true
        reconcileAll()
      } catch (e) {
        log('reconcile', e)
      }
      const out: SeamSource[] = []
      for (const info of contexts.values()) if (info.tee && info.activeEntries > 0) out.push(info.tee.source)
      return out
    },
  }
}
