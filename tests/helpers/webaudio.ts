// Grafo de WebAudio de uma página, visto pelo domínio WebAudio do CDP (todos os mundos, inclusive
// o MAIN world da extensão). Serve de guarda da regra 4: nada da extensão pode chegar a um
// AudioDestinationNode (o usuário ouviria a call duas vezes, e o arquivo gravado sairia igual).
//
// Chame watchWebAudio ANTES do page.goto: o CDP só conta o que for criado depois do enable.
import type { BrowserContext, Page } from '@playwright/test'

export interface AudioNodeInfo {
  nodeId: string
  contextId: string
  nodeType: string
  channelCount: number
  channelCountMode: string
}

export interface AudioGraph {
  contexts(): string[]
  nodes(contextId?: string): AudioNodeInfo[]
  /**
   * Contextos do mixer da extensão: os que têm uma linha de atraso por seam (4 DelayNode) e um
   * MediaStreamAudioDestination (src/main-world/capture/mixer.ts). O CDP manda channelCount e
   * channelCountMode do momento da criação, antes das opções do construtor (medido no CfT 151:
   * o nó mono aparece com 2/"explicit"), então eles não servem para reconhecer o mixer.
   */
  mixerContexts(): string[]
  /** Ligações cujo destino é o AudioDestination do contexto (o que vai para o alto-falante). */
  edgesIntoSpeaker(contextId: string): Array<{ from: string; fromType: string }>
}

export async function watchWebAudio(context: BrowserContext, page: Page): Promise<AudioGraph> {
  const cdp = await context.newCDPSession(page)
  const contexts = new Set<string>()
  const nodes = new Map<string, AudioNodeInfo>()
  const edges: Array<{ contextId: string; sourceId: string; destinationId: string }> = []
  cdp.on('WebAudio.contextCreated', (e: { context: { contextId: string } }) => contexts.add(e.context.contextId))
  cdp.on('WebAudio.audioNodeCreated', (e: { node: AudioNodeInfo }) => nodes.set(e.node.nodeId, e.node))
  cdp.on('WebAudio.nodesConnected', (e: { contextId: string; sourceId: string; destinationId: string }) => edges.push(e))
  await cdp.send('WebAudio.enable')
  const graph: AudioGraph = {
    contexts: () => [...contexts],
    nodes: (contextId) => [...nodes.values()].filter((n) => !contextId || n.contextId === contextId),
    mixerContexts: () =>
      [...contexts].filter((id) => {
        const ns = graph.nodes(id)
        return (
          ns.filter((n) => n.nodeType === 'Delay').length >= 4 &&
          ns.some((n) => n.nodeType === 'MediaStreamAudioDestination')
        )
      }),
    edgesIntoSpeaker: (contextId) =>
      edges
        .filter((e) => e.contextId === contextId && nodes.get(e.destinationId)?.nodeType === 'AudioDestination')
        .map((e) => ({ from: e.sourceId, fromType: nodes.get(e.sourceId)?.nodeType ?? '?' })),
  }
  return graph
}
