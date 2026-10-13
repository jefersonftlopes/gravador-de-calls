// Grafo de WebAudio da página, montado pelos embrulhos de AudioNode.connect/disconnect do seam
// "output" (seam-output.ts) e lido também pelo seam "sources". Só ligações entre nós (as de
// AudioParam ficam de fora).
//
// Só as arestas de saída, num mapa fraco pela origem: a origem segura o destino (como o próprio
// grafo de áudio faz), e nada segura a origem. Um AudioBufferSourceNode que acabou de tocar fica
// livre para o coletor mesmo ligado num GainNode que vive a call inteira (com as arestas de
// entrada guardadas no GainNode, ele seguraria todos os pedaços já tocados; medido no CfT com essa
// versão: 12000 de 12000 vivos depois do coletor, contra 0 sem a extensão). A contaminação por faixa local é calculada para a frente, a partir das
// fontes de stream e de elemento (seam-output.ts), então as arestas de entrada não fazem falta.

export interface PageGraph {
  link(from: AudioNode, to: AudioNode): void
  unlink(from: AudioNode, to: AudioNode): void
  /** disconnect() sem argumentos: todas as saídas do nó. */
  unlinkAll(from: AudioNode): void
  outputsOf(node: AudioNode): Iterable<AudioNode>
  /** O nó está ligado em algum outro nó (a página o usa)? */
  hasOutputs(node: AudioNode): boolean
}

export function createPageGraph(): PageGraph {
  const outputs = new WeakMap<AudioNode, Set<AudioNode>>()
  return {
    link(a, b) {
      let o = outputs.get(a)
      if (!o) outputs.set(a, (o = new Set()))
      o.add(b)
    },
    unlink(a, b) {
      outputs.get(a)?.delete(b)
    },
    unlinkAll(a) {
      outputs.delete(a)
    },
    outputsOf: (n) => outputs.get(n) ?? [],
    hasOutputs: (n) => (outputs.get(n)?.size ?? 0) > 0,
  }
}
