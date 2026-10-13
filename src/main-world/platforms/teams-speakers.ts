// Quem fala agora no Teams web (Emenda 18; pesquisa em docs/pesquisa/falantes-2026-10-09.md). Só
// sinais passivos, sem clicar, sem ligar legenda e sem trocar handler da página. Em ordem:
//
// 1. CSRC dos receptores de áudio (o mix do servidor leva o sourceId de quem está no áudio): o
//    nome sai de `participant.hasAudioSource(csrc)` no objeto da call, com reserva em
//    `endpoints.endpointDetails[].mediaStreams[]` (`type: 'audio'`, `sourceId`). É a fonte do
//    attendee em produção e acompanha o áudio que gravamos.
// 2. Falante dominante 'dsh' no canal 'main-channel' (`[{ type: 'dsh', history: [sourceId, ...] }]`,
//    JSON depois de alguns bytes de cabeçalho): para o caminho do codec WASM e para quando o CSRC
//    não chega. Diz um falante por vez e só avisa quando ele muda, nunca quando a fala acaba: o
//    dominante só conta enquanto o áudio dos outros que gravamos tem fala (`probe.remoteSpeech`),
//    e deixa de valer quando todos os 'main-channel' fecham (aí volta o indicador do DOM).
// 3. Indicador do bloco de vídeo (`[data-tid="voice-level-stream-outline"][data-is-speaking="true"]`):
//    duas fontes dizem que ele está sem sinal no Teams v2 atual; fica por último, só quando os
//    outros dois não existem.
// O próprio usuário fica de fora: `participants` só tem os remotos, e um dsh que aponta para o
// `localSignalingParticipant` vale como ninguém. Um dsh que não bate com nenhum participante
// também (o dominante pode ser você, e o Teams não garante que o seu objeto diga a sua fonte):
// nunca chutar. Um CSRC sem dono, não: ele só existe no áudio dos outros, e vira chave provisória.
import { SPEAKER_KEY_PREFIX } from '../../shared/constants'
import { tapChannels } from '../speakers/channels'
import { CsrcTracker } from '../speakers/csrc'
import type { SpeakerReading } from '../speakers/timeline'
import type { TeamsCallLike } from './teams'
import type { SpeakerProbe, SpeakerSignalsContext } from './types'

/** participant.state: no lobby (não está na call). */
const IN_LOBBY = 7

function items(value: unknown): unknown[] {
  try {
    if (Array.isArray(value)) return value
    if (value instanceof Map) return [...value.values()]
    if (value !== null && typeof value === 'object') {
      const it = (value as { [Symbol.iterator]?: unknown })[Symbol.iterator]
      if (typeof it === 'function') return [...(value as Iterable<unknown>)]
      return Object.values(value as object)
    }
  } catch {
    // nada
  }
  return []
}

const clean = (s: unknown) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim().slice(0, 300) : '')

/** O participante tem a fonte de áudio `id` (hasAudioSource, ou o sourceId dos mediaStreams)? */
export function participantHasSource(p: unknown, id: number): boolean {
  try {
    const has = (p as { hasAudioSource?: unknown }).hasAudioSource
    if (typeof has === 'function' && has.call(p, id) === true) return true
  } catch {
    // o método interno mudou: tenta pelos mediaStreams
  }
  try {
    const details = (p as { endpoints?: { endpointDetails?: unknown } }).endpoints?.endpointDetails
    for (const d of items(details)) {
      for (const m of items((d as { mediaStreams?: unknown }).mediaStreams)) {
        const ms = m as { type?: unknown; sourceId?: unknown }
        if (ms.type === 'audio' && Number(ms.sourceId) === id) return true
      }
    }
  } catch {
    // nada
  }
  return false
}

/**
 * Nome do participante remoto com a fonte `id` (função pura): o displayName, '' para o próprio
 * usuário, null se ninguém tiver essa fonte.
 */
export function speakerOfSource(call: TeamsCallLike | null, id: number): string | null {
  if (!call) return null
  for (const p of items(call.participants)) {
    try {
      if ((p as { state?: unknown }).state === IN_LOBBY) continue
    } catch {
      continue
    }
    if (participantHasSource(p, id)) return clean((p as { displayName?: unknown }).displayName) || null
  }
  if (participantHasSource(call.localSignalingParticipant, id)) return ''
  return null
}

/**
 * Dominante de uma mensagem do 'main-channel' (função pura): o sourceId do `history[0]` do item
 * `dsh`, ou null se a mensagem não for dsh. O JSON vem depois de bytes de cabeçalho: tenta a
 * partir de cada '[' ou '{' (como o decodeMainChannelData do attendee).
 */
export function dominantFromMainChannel(data: Uint8Array | string): number | null {
  let text: string
  try {
    text = typeof data === 'string' ? data : new TextDecoder('utf-8').decode(data)
  } catch {
    return null
  }
  if (!text.includes('dsh')) return null
  let tries = 0
  for (let i = 0; i < text.length && tries < 8; i++) {
    const c = text[i]
    if (c !== '[' && c !== '{') continue
    tries++
    try {
      const v = JSON.parse(text.slice(i)) as unknown
      for (const item of Array.isArray(v) ? v : [v]) {
        const it = item as { type?: unknown; history?: unknown }
        if (it?.type === 'dsh' && Array.isArray(it.history) && it.history.length > 0) {
          const id = Number(it.history[0])
          return Number.isFinite(id) ? id : null
        }
      }
      return null
    } catch {
      // cabeçalho binário com '[' ou '{' no meio: tenta o próximo
    }
  }
  return null
}

/** Um bloco de vídeo do Teams como lido do DOM. */
export interface TeamsTileReading {
  name: string
  speaking: boolean
}

function readTiles(doc: Document): TeamsTileReading[] {
  const out: TeamsTileReading[] = []
  for (const outline of Array.from(doc.querySelectorAll('[data-tid="voice-level-stream-outline"]'))) {
    const tile = outline.closest('[data-stream-type]')
    const name = clean(tile?.querySelector('[data-tid="participant-info-nametag"]')?.textContent) || clean(tile?.getAttribute('data-tid'))
    out.push({ name, speaking: outline.getAttribute('data-is-speaking') === 'true' })
  }
  return out
}

export interface TeamsSpeakers {
  install(ctx: SpeakerSignalsContext): void
  read(probe: SpeakerProbe, call: TeamsCallLike | null, selfName: string, doc?: Document): SpeakerReading | null
  aliases(call: TeamsCallLike | null): Record<string, string>
  /** Para os testes: entrega uma mensagem como se viesse do 'main-channel'. */
  onMainChannel(data: Uint8Array | string): void
}

export function createTeamsSpeakers(): TeamsSpeakers {
  let csrc = new CsrcTracker()
  let dominant: number | null = null
  let sawDsh = false
  /** 'main-channel' escutados e ainda abertos. */
  let liveMain = 0
  const pending = new Map<string, number>()

  const nameOf = (call: TeamsCallLike | null, id: number, kind: string): string | null => {
    const name = speakerOfSource(call, id)
    if (name === '') return null
    if (name) return name
    const key = `${SPEAKER_KEY_PREFIX}${kind}:${id}`
    pending.set(key, id)
    return key
  }

  const onMainChannel = (data: Uint8Array | string) => {
    const id = dominantFromMainChannel(data)
    if (id === null) return
    dominant = id
    sawDsh = true
  }

  const lifecycle = {
    tapped: () => {
      liveMain++
    },
    closed: () => {
      liveMain = Math.max(0, liveMain - 1)
      if (liveMain > 0) return
      // Sem canal, não chega dsh novo: o último dominante não pode ficar valendo para sempre.
      dominant = null
      sawDsh = false
    },
  }

  return {
    install(ctx) {
      csrc = new CsrcTracker(ctx.orig.timeOrigin)
      tapChannels(ctx.orig, ctx.registry, new Map([['main-channel', onMainChannel]]), ctx.log, lifecycle)
    },
    read(probe, call, selfName, doc = typeof document === 'undefined' ? undefined : document) {
      const active = csrc.active(probe.contributingSources(), probe.now)
      if (csrc.alive(probe.now)) {
        return { nomes: active.map((s) => nameOf(call, s, 'csrc')).filter((n): n is string => n !== null), fonte: 'csrc' }
      }
      if (sawDsh) {
        // O dsh não diz o fim da fala: sem fala no áudio dos outros, ninguém fala.
        if (probe.remoteSpeech === false) return { nomes: [], fonte: 'dsh' }
        const n = dominant === null ? null : speakerOfSource(call, dominant)
        return { nomes: n ? [n] : [], fonte: 'dsh' }
      }
      if (!doc) return null
      const tiles = readTiles(doc)
      if (tiles.length === 0) return null
      const nomes = tiles.filter((t) => t.speaking && t.name && t.name !== selfName).map((t) => t.name)
      return { nomes: [...new Set(nomes)], fonte: 'dom' }
    },
    aliases(call) {
      const out: Record<string, string> = {}
      for (const [key, id] of pending) {
        const name = speakerOfSource(call, id)
        if (name) out[key] = name
      }
      return out
    },
    onMainChannel,
  }
}
