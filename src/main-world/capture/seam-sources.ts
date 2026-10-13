// Seam "sources": o que a página leva para o WebAudio dela por createMediaStreamSource (e por
// createMediaStreamTrackSource, onde existir; o Chrome não tem) (docs/ARQUITETURA.md, "Captura").
// Cobre o "decoy" do Meet: o receptor WebRTC vem mudo e o áudio de verdade chega por outro
// caminho (DataChannel + MediaStreamTrackGenerator, por exemplo) e passa por aqui.
//
// O embrulho chama o original primeiro e devolve o mesmo nó. Depois, dentro de try/catch, guarda
// o nó (com as faixas que a página passou) e avisa o controlador. Na consulta, cada faixa de áudio
// viva e não local de um nó que a página ligou em algum lugar vira uma fonte.
//
// Referência ao nó: a página costuma não guardar o nó que liga no destination (quem o mantém vivo é
// o grafo de áudio), então nada garante que o objeto JS sobreviva ao coletor com o som ainda
// tocando. Por precaução (não foi medido), o nó fica preso enquanto está ligado (grafo da página,
// page-graph.ts) e nos primeiros segundos depois de criado (a gravação pode começar depois);
// desligado e velho, fica só a referência fraca. Contexto fechado ou todas as faixas encerradas:
// sai.
import type { Originals } from '../originals'
import { replaceMethod, type AnyFn } from '../wrap'
import type { PageGraph } from './page-graph'
import type { Registry } from './registry'
import type { Seam, SeamSource } from './seams'
import { audioTracksOf, protoGetter, trackSourceCache, usableTrack, type Log } from './seam-util'

/** Protótipo que tem `name` como propriedade própria (BaseAudioContext ou AudioContext). */
function ownerOf(protos: Array<object | undefined>, name: string): object | undefined {
  return protos.find((p) => !!p && Object.prototype.hasOwnProperty.call(p, name))
}

/** Quanto tempo um nó novo fica preso mesmo sem estar ligado em nada. */
export const UNLINKED_GRACE_MS = 10_000

interface Entry {
  ref: WeakRef<AudioNode>
  /** Referência forte enquanto o nó está ligado ou é novo. */
  strong: AudioNode | null
  tracks: MediaStreamTrack[]
  at: number
}

export function installSourcesSeam(orig: Originals, registry: Registry, log: Log, notify: () => void, graph: PageGraph): Seam {
  const w = orig.win as Window & typeof globalThis & { BaseAudioContext?: typeof BaseAudioContext }
  const entries = new Set<Entry>()
  const known = new WeakSet<AudioNode>()
  const sourceFor = trackSourceCache(orig, 'src')
  const nodeContext = protoGetter<AudioNode>(w.AudioNode?.prototype, 'context')
  const ctxState = protoGetter<BaseAudioContext>(w.BaseAudioContext?.prototype ?? w.AudioContext?.prototype, 'state')

  const closed = (node: AudioNode): boolean => {
    try {
      const ctx = nodeContext ? nodeContext.call(node) : node.context
      const state = ctx && (ctxState ? ctxState.call(ctx as BaseAudioContext) : (ctx as BaseAudioContext).state)
      return state === 'closed'
    } catch {
      return false
    }
  }

  /** Atualiza a referência do nó e diz se ele ainda vale (null: sai do registro). */
  const refresh = (e: Entry, now: number): AudioNode | null => {
    const node = e.strong ?? e.ref.deref()
    if (!node || closed(node) || !e.tracks.some((t) => t.readyState === 'live')) return null
    e.strong = graph.hasOutputs(node) || now - e.at < UNLINKED_GRACE_MS ? node : null
    return node
  }

  const remember = (node: unknown, tracks: MediaStreamTrack[]) => {
    if (!node || typeof node !== 'object' || known.has(node as AudioNode)) return
    const n = node as AudioNode
    known.add(n)
    // Só faixa local (medidor do microfone, por exemplo): nunca vai entrar, não precisa guardar.
    if (tracks.every((t) => registry.isLocal(t))) return
    const now = orig.now()
    // Poda aqui também: a página pode criar fontes antes de a gravação começar (medidor do
    // microfone, por exemplo), e só a consulta da gravação podaria.
    for (const e of entries) if (!refresh(e, now)) entries.delete(e)
    entries.add({ ref: new orig.WeakRef(n), strong: n, tracks, at: now })
    notify()
  }

  const protos = [w.BaseAudioContext?.prototype, w.AudioContext?.prototype]
  if (orig.createMediaStreamSource) {
    const o = orig.createMediaStreamSource
    const proto = ownerOf(protos, 'createMediaStreamSource')
    if (proto) {
      replaceMethod(proto, 'createMediaStreamSource', o as AnyFn, function (this: AudioContext, ...args: unknown[]) {
        const r = (o as (...a: unknown[]) => unknown).apply(this, args)
        try {
          // O nó usa as faixas do momento da criação (faixa acrescentada depois ao stream não
          // toca nele), então a cópia é feita agora.
          remember(r, audioTracksOf(orig, args[0]))
        } catch (e) {
          log('createMediaStreamSource', e)
        }
        return r
      } as AnyFn)
    }
  }
  if (orig.createMediaStreamTrackSource) {
    const o = orig.createMediaStreamTrackSource
    const proto = ownerOf(protos, 'createMediaStreamTrackSource')
    if (proto) {
      replaceMethod(proto, 'createMediaStreamTrackSource', o as AnyFn, function (this: AudioContext, ...args: unknown[]) {
        const r = (o as (...a: unknown[]) => unknown).apply(this, args)
        try {
          const track = args[0] as MediaStreamTrack
          remember(r, track && typeof track === 'object' && track.kind === 'audio' ? [track] : [])
        } catch (e) {
          log('createMediaStreamTrackSource', e)
        }
        return r
      } as AnyFn)
    }
  }

  return {
    id: 'sources',
    sources() {
      const out: SeamSource[] = []
      const seen = new Set<MediaStreamTrack>()
      const now = orig.now()
      for (const e of entries) {
        const node = refresh(e, now)
        if (!node) {
          entries.delete(e)
          continue
        }
        // Nó que a página não ligou em nada não toca: fica fora (mas continua registrado).
        if (!graph.hasOutputs(node)) continue
        for (const t of e.tracks) {
          if (seen.has(t) || !usableTrack(registry, t)) continue
          seen.add(t)
          out.push(sourceFor(t))
        }
      }
      return out
    },
  }
}
