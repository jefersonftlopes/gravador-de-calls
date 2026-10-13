// Peças comuns dos seams "elements", "sources" e "output" (docs/ARQUITETURA.md, "Captura").
import type { Originals } from '../originals'
import type { Registry } from './registry'
import type { SeamSource } from './seams'

export type Log = (...a: unknown[]) => void

/**
 * Uma fonte do mixer por faixa, com chave e stream estáveis: o mixer só liga a mesma faixa uma
 * vez e não troca o nó a cada sincronização. O stream é nosso (new MediaStream original), então a
 * página nunca o vê.
 */
export function trackSourceCache(orig: Originals, prefix: string): (t: MediaStreamTrack) => SeamSource {
  const cache = new WeakMap<MediaStreamTrack, SeamSource>()
  let counter = 0
  return (t) => {
    let s = cache.get(t)
    if (!s) {
      s = { key: `${prefix}-${++counter}-${t.id}`, stream: new orig.MediaStream([t]) }
      cache.set(t, s)
    }
    return s
  }
}

/**
 * A faixa pode entrar num seam? Áudio, viva e não local. Local é o microfone, os clones dele, tudo
 * o que a página mandou como envio e as saídas de grafo que a página alimentou com uma faixa local
 * (marcadas pelo seam "output"; ver seam-output.ts).
 */
export function usableTrack(registry: Registry, t: MediaStreamTrack | null | undefined): t is MediaStreamTrack {
  return !!t && t.kind === 'audio' && t.readyState === 'live' && !registry.isLocal(t)
}

/** Faixas de áudio de um stream pelo método original (a página pode ter trocado o dela). */
export function audioTracksOf(orig: Originals, s: unknown): MediaStreamTrack[] {
  if (!(s instanceof orig.MediaStream)) return []
  try {
    return orig.streamGetAudioTracks.call(s)
  } catch {
    return []
  }
}

/** Getter original de `name` em `proto` (capturado na instalação; undefined se não houver). */
export function protoGetter<T>(proto: object | undefined, name: string): ((this: T) => unknown) | undefined {
  try {
    return proto ? (Object.getOwnPropertyDescriptor(proto, name)?.get as ((this: T) => unknown) | undefined) : undefined
  } catch {
    return undefined
  }
}
