// As quatro fontes de captura ("seams"), docs/ARQUITETURA.md "Captura: as quatro fontes".
//
// Cada seam entrega uma lista de fontes (MediaStream com uma faixa de áudio) que o mixer liga
// num grupo próprio. A arbitragem escolhe qual grupo vai para a gravação.
//
// "receivers" mora aqui (com o priming do crbug 40094084); "elements", "sources" e "output" moram
// em seam-elements.ts, seam-sources.ts e seam-output.ts. Faixa local (microfone, clones, envios)
// nunca entra em nenhum deles (registry.isLocal).
import type { SeamId } from '../../shared/protocol'
import type { Originals } from '../originals'
import type { Registry } from './registry'
import { createPageGraph } from './page-graph'
import { installElementsSeam } from './seam-elements'
import { installOutputSeam } from './seam-output'
import { installSourcesSeam } from './seam-sources'

export interface SeamSource {
  /** Chave estável da fonte (o mixer usa para ligar/desligar sem duplicar). */
  key: string
  /** Stream com a faixa a ligar no mixer (MediaStreamAudioSourceNode). */
  stream: MediaStream
}

export interface Seam {
  readonly id: SeamId
  /** Fontes vivas agora. Chamado pelo mixer a cada ~1 s e quando `onChange` dispara. */
  sources(): SeamSource[]
}

export interface SeamSet {
  readonly all: readonly Seam[]
  get(id: SeamId): Seam
  /** Algum seam ganhou fonte nova (para o mixer sincronizar já, sem esperar o polling). */
  onChange(cb: () => void): () => void
  /** Quantos elementos de priming criamos (diagnóstico). */
  primedCount(): number
}

type Log = (...a: unknown[]) => void

// ---------------------------------------------------------------------------------------------
// receivers
// ---------------------------------------------------------------------------------------------

/**
 * Priming (crbug 40094084): faixa remota só produz áudio no WebAudio se algum elemento da mesma
 * frame estiver tocando áudio WebRTC. Se nenhum elemento da página toca áudio remoto, criamos um
 * `new Audio()` mudo, fora do DOM e sem play(), com a faixa. Medido no Chrome 154 e no CfT 151:
 * basta. O setter de srcObject usado é o ORIGINAL, para o seam "elements" não nos ver.
 */
function createPrimer(orig: Originals, registry: Registry, log: Log) {
  const primed = new Map<MediaStreamTrack, HTMLAudioElement>()

  const pagePlaysRemoteAudio = (): boolean => {
    try {
      const els = orig.querySelectorAll.call(document, 'audio, video') as NodeListOf<HTMLMediaElement>
      for (const el of Array.from(els)) {
        const src = orig.mediaSrcObjectGet?.call(el)
        if (!(src instanceof orig.MediaStream)) continue
        const paused = orig.mediaPausedGet ? Boolean(orig.mediaPausedGet.call(el)) : el.paused
        if (paused) continue
        for (const t of orig.streamGetAudioTracks.call(src)) {
          if (t.readyState === 'live' && registry.isReceiverTrack(t)) return true
        }
      }
    } catch (e) {
      log('pagePlaysRemoteAudio', e)
    }
    return false
  }

  return {
    sync(tracks: readonly MediaStreamTrack[]) {
      // Solta o que acabou.
      for (const [t, el] of primed) {
        if (t.readyState !== 'live' || !tracks.includes(t)) {
          try {
            orig.mediaSrcObjectSet?.call(el, null)
          } catch {
            // nada
          }
          primed.delete(t)
        }
      }
      if (tracks.length === 0 || pagePlaysRemoteAudio()) return
      for (const t of tracks) {
        if (primed.has(t)) continue
        try {
          const el = new orig.Audio()
          el.muted = true
          if (orig.mediaSrcObjectSet) orig.mediaSrcObjectSet.call(el, new orig.MediaStream([t]))
          else el.srcObject = new orig.MediaStream([t])
          primed.set(t, el)
        } catch (e) {
          log('priming', e)
        }
      }
    },
    count: () => primed.size,
  }
}

function installReceiversSeam(orig: Originals, registry: Registry, log: Log): Seam & { primedCount(): number } {
  const streams = new WeakMap<MediaStreamTrack, MediaStream>()
  const primer = createPrimer(orig, registry, log)
  let counter = 0
  const keys = new WeakMap<MediaStreamTrack, string>()
  return {
    id: 'receivers',
    sources() {
      const tracks = registry.remoteAudioTracks().map((r) => r.track)
      primer.sync(tracks)
      return tracks.map((t) => {
        let s = streams.get(t)
        if (!s) {
          s = new orig.MediaStream([t])
          streams.set(t, s)
        }
        let key = keys.get(t)
        if (!key) {
          key = `rx-${++counter}-${t.id}`
          keys.set(t, key)
        }
        return { key, stream: s }
      })
    },
    primedCount: () => primer.count(),
  }
}

/** Instala os quatro seams. Chamado no document_start, logo depois do registry. */
export function installSeams(orig: Originals, registry: Registry, log: Log): SeamSet {
  const listeners = new Set<() => void>()
  const notify = () => {
    for (const cb of listeners) {
      try {
        cb()
      } catch (e) {
        log('seam listener', e)
      }
    }
  }
  registry.onRemoteAudio(notify)
  const receivers = installReceiversSeam(orig, registry, log)
  // Cada seam é instalado isolado: se um falhar (API ausente nesta frame), os outros continuam.
  const guarded = (id: SeamId, install: () => Seam): Seam => {
    try {
      return install()
    } catch (e) {
      log('seam', id, e)
      return { id, sources: () => [] }
    }
  }
  // Grafo de WebAudio da página: montado pelo "output" (connect/disconnect), lido pelo "sources".
  const graph = createPageGraph()
  const all: Seam[] = [
    receivers,
    guarded('elements', () => installElementsSeam(orig, registry, log, notify)),
    guarded('sources', () => installSourcesSeam(orig, registry, log, notify, graph)),
    guarded('output', () => installOutputSeam(orig, registry, log, notify, graph)),
  ]
  const byId = new Map(all.map((s) => [s.id, s]))
  return {
    all,
    get: (id) => byId.get(id)!,
    onChange(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    primedCount: () => receivers.primedCount(),
  }
}
