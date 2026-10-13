import { describe, expect, it } from 'vitest'
import type { SeamId } from '../../shared/protocol'
import { arbitrate, hasSpeech, initialArbitration, SPEECH_DBFS, type Measurements } from './arbitration'

const MEET: SeamId[] = ['receivers', 'sources', 'elements', 'output']
const silent = { sources: 1, dbfs: -120 }
const loud = { sources: 1, dbfs: -20 }
const none = { sources: 0, dbfs: -200 }

function m(partial: Partial<Measurements>): Measurements {
  return { receivers: none, elements: none, sources: none, output: none, ...partial }
}

describe('arbitrate', () => {
  it('não escolhe nada enquanto nenhum seam tem fonte', () => {
    const r = arbitrate(initialArbitration(MEET), m({}), 0)
    expect(r.change).toBeNull()
    expect(r.state.selected).toBeNull()
  })

  it('escolhe o primeiro da prioridade que tem fonte, mesmo mudo', () => {
    const r = arbitrate(initialArbitration(MEET), m({ elements: loud, receivers: silent }), 0)
    expect(r.change).toEqual({ at: 0, from: null, to: 'receivers' })
    expect(r.state.initial).toBe('receivers')
    expect(r.state.switches).toEqual([])
  })

  it('troca para quem tem fala depois de 1 s de silêncio no selecionado', () => {
    let s = arbitrate(initialArbitration(MEET), m({ receivers: silent, elements: silent }), 0).state
    // Durante a carência de 1 s não troca.
    let r = arbitrate(s, m({ receivers: silent, elements: loud }), 500)
    expect(r.change).toBeNull()
    s = r.state
    r = arbitrate(s, m({ receivers: silent, elements: loud }), 1000)
    expect(r.change).toEqual({ at: 1000, from: 'receivers', to: 'elements' })
    expect(r.state.switches).toHaveLength(1)
  })

  it('nunca troca enquanto o selecionado tem fala', () => {
    let s = arbitrate(initialArbitration(MEET), m({ receivers: loud, output: loud }), 0).state
    for (let t = 250; t <= 5000; t += 250) {
      const r = arbitrate(s, m({ receivers: loud, output: loud }), t)
      expect(r.change).toBeNull()
      s = r.state
    }
    expect(s.selected).toBe('receivers')
    expect(s.everHadSpeech).toBe(true)
  })

  it('não troca "para cima" quando o atual volta a funcionar', () => {
    let s = arbitrate(initialArbitration(MEET), m({ receivers: silent, output: loud }), 0).state
    s = arbitrate(s, m({ receivers: silent, output: loud }), 1000).state
    expect(s.selected).toBe('output')
    // receivers agora tem fala, mas output segue com fala: fica em output.
    const r = arbitrate(s, m({ receivers: loud, output: loud }), 3000)
    expect(r.change).toBeNull()
    expect(r.state.selected).toBe('output')
  })

  it('entre vários com fala escolhe o de maior prioridade', () => {
    let s = arbitrate(initialArbitration(MEET), m({ receivers: silent, elements: silent, output: silent }), 0).state
    const r = arbitrate(s, m({ receivers: silent, elements: loud, output: loud }), 1500)
    expect(r.change?.to).toBe('elements')
  })

  it('ignora fala antiga (fora da janela de 1 s)', () => {
    let s = arbitrate(initialArbitration(MEET), m({ receivers: silent, output: loud }), 0).state
    s = arbitrate(s, m({ receivers: silent, output: silent }), 200).state
    const r = arbitrate(s, m({ receivers: silent, output: silent }), 2000)
    expect(r.change).toBeNull()
  })

  it('fala abaixo de -55 dBFS não conta', () => {
    let s = arbitrate(initialArbitration(MEET), m({ receivers: silent, output: silent }), 0).state
    const r = arbitrate(s, m({ receivers: silent, output: { sources: 1, dbfs: -56 } }), 2000)
    expect(r.change).toBeNull()
  })
})

// Tabela de cenários: cada seam é uma linha do tempo ('fala', 'mudo' ou sem fonte), avaliada a
// cada laço de 250 ms. O resultado é a lista de escolhas { at, from, to } (a inicial com from null).
type Level = 'fala' | 'mudo' | 'baixo' | null
type Timeline = Partial<Record<SeamId, (t: number) => Level>>
const TEAMS: SeamId[] = ['elements', 'receivers', 'sources', 'output']
const sempre = (l: Level) => () => l
const ate = (ms: number, antes: Level, depois: Level) => (t: number) => (t < ms ? antes : depois)
const DB: Record<Exclude<Level, null>, number> = { fala: -20, mudo: -120, baixo: -56 }

function simulate(priority: SeamId[], timeline: Timeline, untilMs: number) {
  let state = initialArbitration(priority)
  const changes: Array<{ at: number; from: SeamId | null; to: SeamId }> = []
  for (let t = 0; t <= untilMs; t += 250) {
    const ms: Partial<Measurements> = {}
    for (const [id, f] of Object.entries(timeline) as Array<[SeamId, (t: number) => Level]>) {
      const level = f(t)
      ms[id] = level === null ? none : { sources: 1, dbfs: DB[level] }
    }
    const r = arbitrate(state, m(ms), t)
    state = r.state
    if (r.change) changes.push(r.change)
  }
  return { state, changes }
}

describe('arbitrate: tabela de cenários', () => {
  const cases: Array<{ nome: string; priority: SeamId[]; timeline: Timeline; until: number; changes: Array<[number, SeamId | null, SeamId]> }> = [
    { nome: 'ninguém tem fonte: nada é escolhido', priority: MEET, timeline: {}, until: 3000, changes: [] },
    {
      nome: 'Meet: começa no receptor mesmo mudo quando ninguém fala',
      priority: MEET,
      timeline: { receivers: sempre('mudo'), elements: sempre('mudo'), output: sempre('mudo') },
      until: 5000,
      changes: [[0, null, 'receivers']],
    },
    {
      nome: 'Teams: começa no elemento',
      priority: TEAMS,
      timeline: { receivers: sempre('fala'), elements: sempre('fala') },
      until: 3000,
      changes: [[0, null, 'elements']],
    },
    {
      nome: 'decoy: receptor mudo desde o início, troca depois da carência de 1 s para o de maior prioridade com fala',
      priority: MEET,
      timeline: { receivers: sempre('mudo'), elements: sempre('mudo'), sources: sempre('fala'), output: sempre('fala') },
      until: 8000,
      changes: [
        [0, null, 'receivers'],
        [1000, 'receivers', 'sources'],
      ],
    },
    {
      nome: 'começo da fala com tudo em silêncio: troca no primeiro laço com fala',
      priority: MEET,
      timeline: { receivers: sempre('mudo'), sources: ate(5000, 'mudo', 'fala'), output: ate(5250, 'mudo', 'fala') },
      until: 9000,
      changes: [
        [0, null, 'receivers'],
        [5000, 'receivers', 'sources'],
      ],
    },
    {
      nome: 'passagem: o receptor cala e o áudio passa a vir por "sources"; troca 1 s depois',
      priority: MEET,
      timeline: { receivers: ate(6000, 'fala', 'mudo'), sources: ate(6000, 'mudo', 'fala') },
      until: 10_000,
      changes: [
        [0, null, 'receivers'],
        [6750, 'receivers', 'sources'],
      ],
    },
    {
      nome: 'nunca troca enquanto o selecionado tem fala',
      priority: MEET,
      timeline: { receivers: sempre('fala'), elements: sempre('fala'), sources: sempre('fala'), output: sempre('fala') },
      until: 10_000,
      changes: [[0, null, 'receivers']],
    },
    {
      nome: 'não volta "para cima" enquanto o atual funciona',
      priority: MEET,
      timeline: { receivers: ate(4000, 'mudo', 'fala'), output: sempre('fala') },
      until: 10_000,
      changes: [
        [0, null, 'receivers'],
        [1000, 'receivers', 'output'],
      ],
    },
    {
      nome: 'volta para o de cima quando o atual cala e o de cima fala',
      priority: MEET,
      timeline: { receivers: ate(4000, 'mudo', 'fala'), output: ate(5000, 'fala', 'mudo') },
      until: 10_000,
      changes: [
        [0, null, 'receivers'],
        [1000, 'receivers', 'output'],
        [5750, 'output', 'receivers'],
      ],
    },
    {
      nome: 'todos calam juntos (o tee um laço depois): não troca para quem também calou',
      priority: MEET,
      timeline: { receivers: sempre('mudo'), sources: ate(6000, 'fala', 'mudo'), output: ate(6250, 'fala', 'mudo') },
      until: 12_000,
      changes: [
        [0, null, 'receivers'],
        [1000, 'receivers', 'sources'],
      ],
    },
    {
      nome: 'fala a -56 dBFS (abaixo do limiar de -55) não conta',
      priority: MEET,
      timeline: { receivers: sempre('mudo'), output: sempre('baixo') },
      until: 6000,
      changes: [[0, null, 'receivers']],
    },
    {
      nome: 'seam que perde a fonte conta como mudo',
      priority: MEET,
      timeline: { receivers: (t) => (t < 3000 ? 'fala' : null), elements: sempre('fala') },
      until: 8000,
      changes: [
        [0, null, 'receivers'],
        [3750, 'receivers', 'elements'],
      ],
    },
  ]

  it.each(cases)('$nome', ({ priority, timeline, until, changes }) => {
    const r = simulate(priority, timeline, until)
    expect(r.changes).toEqual(changes.map(([at, from, to]) => ({ at, from, to })))
    // O info.json recebe só as trocas de verdade (a escolha inicial fica em `initial`).
    expect(r.state.switches).toEqual(r.changes.filter((c) => c.from !== null))
    expect(r.state.initial).toBe(changes[0]?.[2] ?? null)
  })

  it('limiar: -54 dBFS conta como fala, -55 não', () => {
    expect(hasSpeech({ sources: 1, dbfs: -54 })).toBe(true)
    expect(hasSpeech({ sources: 1, dbfs: SPEECH_DBFS })).toBe(false)
    expect(hasSpeech({ sources: 0, dbfs: -10 })).toBe(false)
  })
})
