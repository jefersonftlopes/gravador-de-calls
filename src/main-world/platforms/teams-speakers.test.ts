import { describe, expect, it } from 'vitest'
import { SPEAKER_KEY_PREFIX } from '../../shared/constants'
import type { ContributingSource } from '../capture/registry'
import { createTeamsSpeakers, dominantFromMainChannel, speakerOfSource } from './teams-speakers'
import type { Registry } from '../capture/registry'
import type { Originals } from '../originals'
import type { TeamsCallLike } from './teams'

const NOW = 1_760_000_000_000

function participant(displayName: string, sources: number[], state = 3, how: 'method' | 'endpoints' = 'method') {
  if (how === 'endpoints') {
    return { displayName, state, endpoints: { endpointDetails: [{ mediaStreams: sources.map((sourceId) => ({ type: 'audio', sourceId, direction: 'recvonly' })) }] } }
  }
  return { displayName, state, hasAudioSource: (id: number) => sources.includes(id) }
}

const call: TeamsCallLike = {
  state: 3,
  participants: [participant('Ana Souza', [1053]), participant('Bruno Lima', [2331], 3, 'endpoints'), participant('Visitante no lobby', [4444], 7)],
  localSignalingParticipant: participant('Alex Lima', [9999]),
}

const probe = (now: number, csrcs: ContributingSource[] = []) => ({ now, contributingSources: () => csrcs })

function bytes(prefix: number[], json: unknown): Uint8Array {
  return Uint8Array.from([...prefix, ...new TextEncoder().encode(JSON.stringify(json))])
}

/** Documento falso com os blocos de vídeo do Teams. */
function teamsDoc(tiles: Array<{ name: string; speaking: boolean }>): Document {
  const outlines = tiles.map((t) => ({
    getAttribute: (k: string) => (k === 'data-is-speaking' ? String(t.speaking) : null),
    closest: () => ({
      getAttribute: (k: string) => (k === 'data-tid' ? t.name : null),
      querySelector: () => ({ textContent: t.name }),
    }),
  }))
  return { querySelectorAll: () => outlines } as unknown as Document
}

describe('speakerOfSource', () => {
  it('pelo hasAudioSource e, sem ele, pelos mediaStreams; lobby fica de fora; você é vazio', () => {
    expect(speakerOfSource(call, 1053)).toBe('Ana Souza')
    expect(speakerOfSource(call, 2331)).toBe('Bruno Lima')
    expect(speakerOfSource(call, 4444)).toBeNull()
    expect(speakerOfSource(call, 9999)).toBe('')
    expect(speakerOfSource(call, 1)).toBeNull()
    expect(speakerOfSource(null, 1053)).toBeNull()
  })

  it('um hasAudioSource que lança não derruba a leitura', () => {
    const broken: TeamsCallLike = { participants: [{ displayName: 'Ana', hasAudioSource: () => { throw new Error('mudou') } }] }
    expect(speakerOfSource(broken, 1)).toBeNull()
  })
})

describe('dominantFromMainChannel', () => {
  it('acha o JSON depois dos bytes de cabeçalho (mesmo com [ no cabeçalho)', () => {
    expect(dominantFromMainChannel(bytes([0, 1, 2, 3], [{ history: [1053, 2331], type: 'dsh' }]))).toBe(1053)
    expect(dominantFromMainChannel(bytes([0x5b, 0x7b, 9], [{ history: [2331], type: 'dsh' }]))).toBe(2331)
    expect(dominantFromMainChannel('[{"type":"dsh","history":[7]}]')).toBe(7)
    expect(dominantFromMainChannel(bytes([0], { recognitionResults: [] }))).toBeNull()
    expect(dominantFromMainChannel(bytes([0], [{ type: 'outra', history: [1] }]))).toBeNull()
    expect(dominantFromMainChannel(Uint8Array.from([0xff, 0xfe]))).toBeNull()
  })
})

describe('falantes do Teams', () => {
  it('CSRC primeiro, com o nome do objeto da call', () => {
    const s = createTeamsSpeakers()
    expect(s.read(probe(NOW, [{ source: 1053, timestamp: NOW - 10 }, { source: 2331, timestamp: NOW - 10 }]), call, 'Alex Lima', undefined)).toEqual({
      nomes: ['Ana Souza', 'Bruno Lima'],
      fonte: 'csrc',
    })
  })

  it('o CSRC da sua própria fonte nunca vira falante (nem chave provisória)', () => {
    const s = createTeamsSpeakers()
    expect(s.read(probe(NOW, [{ source: 9999, timestamp: NOW }, { source: 1053, timestamp: NOW }]), call, 'Alex Lima', undefined)).toEqual({ nomes: ['Ana Souza'], fonte: 'csrc' })
  })

  it('CSRC desconhecido vira chave provisória e o alias aparece quando o participante chega', () => {
    const s = createTeamsSpeakers()
    const r = s.read(probe(NOW, [{ source: 5555, timestamp: NOW }]), call, '', undefined)!
    expect(r.nomes).toEqual([`${SPEAKER_KEY_PREFIX}csrc:5555`])
    const later: TeamsCallLike = { ...call, participants: [...(call.participants as unknown[]), participant('Carla Dias', [5555])] }
    expect(s.aliases(later)).toEqual({ [`${SPEAKER_KEY_PREFIX}csrc:5555`]: 'Carla Dias' })
  })

  it('sem CSRC, o dsh do main-channel: um por vez, e o dsh que aponta para você vale como ninguém', () => {
    const s = createTeamsSpeakers()
    expect(s.read(probe(NOW), call, 'Alex Lima', undefined)).toBeNull()
    s.onMainChannel(bytes([1, 2], [{ history: [2331, 1053], type: 'dsh' }]))
    expect(s.read(probe(NOW), call, 'Alex Lima', undefined)).toEqual({ nomes: ['Bruno Lima'], fonte: 'dsh' })
    s.onMainChannel(bytes([1, 2], [{ history: [9999], type: 'dsh' }]))
    expect(s.read(probe(NOW), call, 'Alex Lima', undefined)).toEqual({ nomes: [], fonte: 'dsh' })
    // Um dominante que não é de nenhum participante (pode ser você) também não vira falante.
    s.onMainChannel(bytes([1, 2], [{ history: [31337], type: 'dsh' }]))
    expect(s.read(probe(NOW), call, 'Alex Lima', undefined)).toEqual({ nomes: [], fonte: 'dsh' })
  })

  it('sem CSRC nem dsh, o indicador do bloco de vídeo (sem você)', () => {
    const s = createTeamsSpeakers()
    const doc = teamsDoc([
      { name: 'Ana Souza', speaking: true },
      { name: 'Bruno Lima', speaking: false },
      { name: 'Alex Lima', speaking: true },
    ])
    expect(s.read(probe(NOW), call, 'Alex Lima', doc)).toEqual({ nomes: ['Ana Souza'], fonte: 'dom' })
    expect(s.read(probe(NOW), call, 'Alex Lima', teamsDoc([]))).toBeNull()
  })

  it('o dsh não diz o fim da fala: sem fala no áudio dos outros, ninguém; sem a medida, vale o dominante', () => {
    const s = createTeamsSpeakers()
    s.onMainChannel(bytes([1, 2], [{ history: [1053], type: 'dsh' }]))
    expect(s.read({ ...probe(NOW), remoteSpeech: true }, call, 'Alex Lima', undefined)).toEqual({ nomes: ['Ana Souza'], fonte: 'dsh' })
    expect(s.read({ ...probe(NOW), remoteSpeech: false }, call, 'Alex Lima', undefined)).toEqual({ nomes: [], fonte: 'dsh' })
    expect(s.read(probe(NOW), call, 'Alex Lima', undefined)).toEqual({ nomes: ['Ana Souza'], fonte: 'dsh' })
  })

  it('quando todos os main-channel fecham, o último dominante deixa de valer e volta o indicador do DOM', () => {
    class FakeChannel {
      listeners = new Map<string, Array<(ev: unknown) => void>>()
      constructor(readonly label: string) {}
      addEventListener(type: string, cb: (ev: unknown) => void) {
        this.listeners.set(type, [...(this.listeners.get(type) ?? []), cb])
      }
      emit(type: string, ev: unknown = {}) {
        for (const cb of this.listeners.get(type) ?? []) cb(ev)
      }
    }
    const onChannel: Array<(ch: RTCDataChannel) => void> = []
    const registry = { onDataChannel: (cb: (ch: RTCDataChannel) => void) => (onChannel.push(cb), () => {}) } as unknown as Registry
    const orig = { pcAddEventListener: FakeChannel.prototype.addEventListener, dataChannelLabelGet: undefined, timeOrigin: 0 } as unknown as Originals
    const s = createTeamsSpeakers()
    s.install({ orig, registry, log: () => {} })
    const a = new FakeChannel('main-channel')
    const b = new FakeChannel('main-channel')
    for (const ch of [a, b, new FakeChannel('outro')]) onChannel[0](ch as unknown as RTCDataChannel)
    a.emit('message', { data: JSON.stringify([{ history: [1053], type: 'dsh' }]) })
    const doc = teamsDoc([{ name: 'Bruno Lima', speaking: true }])
    expect(s.read(probe(NOW), call, 'Alex Lima', doc)).toEqual({ nomes: ['Ana Souza'], fonte: 'dsh' })
    // Um dos dois fechou: o outro ainda pode mandar dsh.
    a.emit('close')
    expect(s.read(probe(NOW), call, 'Alex Lima', doc)).toEqual({ nomes: ['Ana Souza'], fonte: 'dsh' })
    b.emit('close')
    expect(s.read(probe(NOW), call, 'Alex Lima', doc)).toEqual({ nomes: ['Bruno Lima'], fonte: 'dom' })
  })
})
