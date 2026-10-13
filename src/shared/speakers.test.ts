import { describe, expect, it } from 'vitest'
import daily from '../../tests/fixtures/falantes/daily-meet-anonimizada.json'
import { MIXER_DELAY_MS, SPEAKER_KEY_PREFIX } from './constants'
import type { SpeakerInterval } from './protocol'
import { UNNAMED_SHADOW, applySpeakersBatch, checkUnnamedSources, mergeIntervals, speakersOutput, type SpeakerLabels } from './speakers'

const labels: SpeakerLabels = { you: 'Você', unknown: (n) => `Participante ${n}`, youNotRecorded: '(sua fala não é gravada)' }
const iv = (nome: string, de: number, ate: number, extra: Partial<SpeakerInterval> = {}): SpeakerInterval => ({ nome, de, ate, fonte: 'dsh', ...extra })

describe('applySpeakersBatch', () => {
  it('troca tudo a partir de `from` e junta os aliases', () => {
    let r = applySpeakersBatch(null, { from: 0, intervals: [iv('A', 0, 1000)] }).record
    r = applySpeakersBatch(r, { from: 0, intervals: [iv('A', 0, 2000), iv('B', 1500, 1800)], aliases: { k: 'X' } }).record
    r = applySpeakersBatch(r, { from: 1, intervals: [iv('B', 1500, 3000)] }).record
    expect(r).toEqual({ intervals: [iv('A', 0, 2000), iv('B', 1500, 3000)], aliases: { k: 'X' } })
  })

  it('um lote além do guardado (outro se perdeu) não mexe nos intervalos, mas o alias vale', () => {
    const cur = { intervals: [iv('A', 0, 1000)], aliases: {} }
    const out = applySpeakersBatch(cur, { from: 3, intervals: [iv('C', 9000, 9500)], aliases: { k: 'Y' } })
    expect(out.applied).toBe(false)
    expect(out.record).toEqual({ intervals: [iv('A', 0, 1000)], aliases: { k: 'Y' } })
    // O fim reenvia a linha inteira a partir do 0.
    expect(applySpeakersBatch(out.record, { from: 0, intervals: [iv('A', 0, 1000), iv('B', 2000, 3000), iv('C', 9000, 9500)] }).record.intervals).toHaveLength(3)
  })
})

describe('mergeIntervals', () => {
  it('junta a mesma pessoa que encosta ou sobrepõe; você só com você', () => {
    expect(
      mergeIntervals([iv('A', 3000, 5000), iv('A', 0, 3000), iv('B', 1000, 2000), iv('', 2000, 2500, { voce: true }), iv('', 2500, 4000, { voce: true }), iv('A', 6000, 7000)]),
    ).toEqual([iv('A', 0, 5000), iv('B', 1000, 2000), iv('', 2000, 4000, { voce: true }), iv('A', 6000, 7000)])
  })
})

describe('speakersOutput', () => {
  it('resolve as chaves provisórias pelos aliases e numera as que sobraram, na ordem da primeira fala', () => {
    const k1 = `${SPEAKER_KEY_PREFIX}csrc:1`
    const k2 = `${SPEAKER_KEY_PREFIX}csrc:2`
    const k3 = `${SPEAKER_KEY_PREFIX}dev:3`
    const out = speakersOutput(
      {
        intervals: [iv(k2, 0, 1000, { fonte: 'csrc' }), iv('Ana Souza', 1000, 3000), iv(k1, 3000, 4000, { fonte: 'csrc' }), iv(k3, 5000, 6000, { fonte: 'dcrpc' }), iv('', 6000, 8000, { voce: true, fonte: 'microfone' })],
        aliases: { [k1]: 'Bruno Lima' },
      },
      labels,
    )!
    expect(out.file.intervalos.map((i) => i.nome)).toEqual(['Participante 1', 'Ana Souza', 'Bruno Lima', 'Participante 2', 'Você'])
    expect(out.file).toMatchObject({ versao: 1, audio: 'audio.webm', atrasoMs: MIXER_DELAY_MS, textos: { voceNaoGravada: '(sua fala não é gravada)' } })
    expect(out.summary).toEqual({
      arquivo: 'falantes.json',
      pessoas: [
        { nome: 'Participante 1', segundos: 1, semNome: true },
        { nome: 'Ana Souza', segundos: 2 },
        { nome: 'Bruno Lima', segundos: 1 },
        { nome: 'Participante 2', segundos: 1, semNome: true },
        { nome: 'Você', segundos: 2, voce: true },
      ],
      fontes: ['csrc', 'dsh', 'dcrpc', 'microfone'],
    })
  })

  it('soma o tempo de cada pessoa sem contar duas vezes o que se sobrepõe', () => {
    const out = speakersOutput({ intervals: [iv('Ana', 0, 4000), iv('Ana', 2000, 5000), iv('Ana', 10_000, 11_500)], aliases: {} }, labels)!
    expect(out.summary.pessoas).toEqual([{ nome: 'Ana', segundos: 6.5 }])
  })

  it('sem intervalo de participante (só o microfone), nada', () => {
    expect(speakersOutput({ intervals: [iv('', 0, 5000, { voce: true, fonte: 'microfone' })], aliases: {} }, labels)).toBeNull()
    expect(speakersOutput(null, labels)).toBeNull()
    expect(speakersOutput({ intervals: [], aliases: {} }, labels)).toBeNull()
  })
})

describe('fonte sem nome que acompanha quem fala (Emenda 20)', () => {
  const GHOST = `${SPEAKER_KEY_PREFIX}csrc:42`
  /** A daily real anonimizada: o fantasma como a chave provisória que o Meet deu, as pessoas por letra. */
  const fromFixture = (): SpeakerInterval[] =>
    daily.intervalos.map((i) =>
      i.quem === 'voce'
        ? iv('', i.de, i.ate, { voce: true, fonte: 'microfone' })
        : iv(i.quem === 'fantasma' ? GHOST : `Pessoa ${i.quem}`, i.de, i.ate, { fonte: 'csrc' }),
    )

  it('na daily real, a fonte sem nome sai da linha do tempo e das pessoas; as 6 pessoas e você ficam', () => {
    const out = speakersOutput({ intervals: fromFixture(), aliases: {} }, labels)!
    expect(out.summary.pessoas.map((p) => p.nome)).toEqual(['Pessoa A', 'Pessoa B', 'Pessoa C', 'Você', 'Pessoa D', 'Pessoa E', 'Pessoa F'])
    expect(out.file.intervalos.some((i) => i.nome.startsWith('Participante'))).toBe(false)
    expect(out.file.descartadas).toEqual([{ chave: 'csrc:42', segundos: 399.5, coberturaPct: 98.7, presencaPct: 99.2, pessoasCobertas: 6 }])
    // As pessoas ficam com o tempo de antes: só a fonte sem nome saiu.
    expect(out.summary.pessoas.find((p) => p.nome === 'Pessoa C')).toEqual({ nome: 'Pessoa C', segundos: 142.2 })
    expect(out.summary.fontes).toEqual(['csrc', 'microfone'])
  })

  it('as medidas da daily real: o fantasma longe dos limiares, as pessoas reais também', () => {
    const remote = fromFixture().filter((i) => !i.voce)
    // Cada pessoa medida como se fosse a sem nome, contra as outras (sem o fantasma).
    for (const who of ['A', 'B', 'C', 'D', 'E', 'F']) {
      const [c] = checkUnnamedSources(remote.filter((i) => i.nome !== GHOST).map((i) => ({ key: i.nome, unnamed: i.nome === `Pessoa ${who}`, de: i.de, ate: i.ate })))
      expect(c.coveredPct, who).toBeLessThan(16)
      expect(c.presencePct, who).toBeLessThan(4)
      expect(c.shadow, who).toBe(false)
    }
    const [g] = checkUnnamedSources(remote.map((i) => ({ key: i.nome, unnamed: i.nome === GHOST, de: i.de, ate: i.ate })))
    expect(g.coveredPct).toBeGreaterThan(UNNAMED_SHADOW.minCoveredPct + 10)
    expect(g.presencePct).toBeGreaterThan(UNNAMED_SHADOW.minPresencePct + 40)
  })

  it('pessoa sem nome que fala sozinha fica, e é a "Participante 1" (a descartada não gasta número)', () => {
    const solo = `${SPEAKER_KEY_PREFIX}csrc:7`
    const intervals = [...fromFixture(), iv(solo, 520_000, 540_000, { fonte: 'csrc' }), iv(solo, 541_000, 548_000, { fonte: 'csrc' })]
    const out = speakersOutput({ intervals, aliases: {} }, labels)!
    expect(out.summary.pessoas.find((p) => p.semNome)).toEqual({ nome: 'Participante 1', segundos: 27, semNome: true })
    expect(out.file.descartadas?.map((d) => d.chave)).toEqual(['csrc:42'])
  })

  it('duas pessoas que às vezes falam juntas ficam as duas, mesmo uma sem nome', () => {
    const k = `${SPEAKER_KEY_PREFIX}csrc:9`
    const intervals = [iv('Ana', 0, 10_000), iv(k, 9_000, 20_000), iv('Ana', 20_000, 30_000), iv(k, 29_000, 40_000), iv('Ana', 39_500, 45_000)]
    const out = speakersOutput({ intervals, aliases: {} }, labels)!
    expect(out.summary.pessoas.map((p) => p.nome)).toEqual(['Ana', 'Participante 1'])
    expect(out.file.descartadas).toBeUndefined()
  })

  it('quem só faz interjeições por cima de 3 pessoas fica (cobertura alta, presença baixa)', () => {
    const k = `${SPEAKER_KEY_PREFIX}csrc:5`
    const intervals = [
      iv('Ana', 0, 30_000),
      iv(k, 10_000, 11_000),
      iv('Bruno', 30_000, 60_000),
      iv(k, 40_000, 41_000),
      iv('Carla', 60_000, 90_000),
      iv(k, 70_000, 71_000),
      iv(k, 80_000, 80_500),
    ]
    const [c] = checkUnnamedSources(intervals.map((i) => ({ key: i.nome, unnamed: i.nome === k, de: i.de, ate: i.ate })))
    expect(c).toMatchObject({ coveredPct: 100, personsCovered: 3, shadow: false })
    expect(speakersOutput({ intervals, aliases: {} }, labels)!.summary.pessoas.map((p) => p.nome)).toEqual(['Ana', 'Participante 1', 'Bruno', 'Carla'])
  })

  it('pessoa sem nome que fala muito, com a nomeada só falando por cima dela, fica (presença alta, cobertura baixa)', () => {
    const k = `${SPEAKER_KEY_PREFIX}csrc:8`
    const intervals = [iv(k, 0, 60_000), iv('Ana', 20_000, 22_000), iv('Ana', 40_000, 43_000)]
    const [c] = checkUnnamedSources(intervals.map((i) => ({ key: i.nome, unnamed: i.nome === k, de: i.de, ate: i.ate })))
    expect(c).toMatchObject({ presencePct: 100, shadow: false })
    expect(speakersOutput({ intervals, aliases: {} }, labels)!.summary.pessoas.map((p) => p.nome)).toEqual(['Participante 1', 'Ana'])
  })

  it('numa call de duas pessoas, a fonte sem nome que acompanha a única nomeada também sai', () => {
    const intervals = [iv('Ana', 1_000, 9_000), iv(GHOST, 1_000, 9_250), iv('Ana', 12_000, 30_000), iv(GHOST, 12_250, 30_000), iv('', 9_500, 11_500, { voce: true, fonte: 'microfone' })]
    const out = speakersOutput({ intervals, aliases: {} }, labels)!
    expect(out.summary.pessoas.map((p) => p.nome)).toEqual(['Ana', 'Você'])
    expect(out.file.descartadas).toEqual([{ chave: 'csrc:42', segundos: 26, coberturaPct: 99, presencaPct: 99, pessoasCobertas: 1 }])
  })

  it('uma chave que a roster resolveu nunca sai, mesmo andando junto de todo mundo', () => {
    const k = `${SPEAKER_KEY_PREFIX}csrc:3`
    const intervals = [iv('Ana', 0, 10_000), iv(k, 0, 10_000, { fonte: 'csrc' }), iv('Bruno', 10_000, 20_000), iv(k, 10_000, 20_000, { fonte: 'csrc' })]
    const out = speakersOutput({ intervals, aliases: { [k]: 'Carla' } }, labels)!
    expect(out.summary.pessoas.map((p) => p.nome)).toEqual(['Ana', 'Carla', 'Bruno'])
    expect(out.file.descartadas).toBeUndefined()
  })

  it('o diagnóstico do lote final fica guardado (também num lote fora de ordem) e vai para o falantes.json', () => {
    const diagnostico = { csrc: { receptores: 3, fontes: [{ csrc: 42, leiturasAtiva: 1598, receptores: 1, resolvida: false, mesmoPacoteComNomeada: 1590, ignorada: 'mais-alto' as const }] } }
    let r = applySpeakersBatch(null, { from: 0, intervals: [iv('Ana', 0, 4000)] }).record
    r = applySpeakersBatch(r, { from: 9, intervals: [], diagnostico }).record
    r = applySpeakersBatch(r, { from: 1, intervals: [iv('Bruno', 4000, 6000)] }).record
    expect(r.diagnostico).toEqual(diagnostico)
    expect(speakersOutput(r, labels)!.file.diagnostico).toEqual(diagnostico)
    expect(speakersOutput({ intervals: [iv('Ana', 0, 4000)], aliases: {} }, labels)!.file).not.toHaveProperty('diagnostico')
  })

  it('sem fonte sem nome, o falantes.json sai como antes (sem descartadas nem semNome)', () => {
    const out = speakersOutput({ intervals: [iv('Ana', 0, 4000), iv('Bruno', 3000, 9000)], aliases: {} }, labels)!
    expect(out.file).not.toHaveProperty('descartadas')
    expect(out.summary.pessoas).toEqual([{ nome: 'Ana', segundos: 4 }, { nome: 'Bruno', segundos: 6 }])
  })
})
