import { describe, expect, it } from 'vitest'
import { mergeIntervals } from '../../shared/speakers'
import type { SpeakerInterval } from '../../shared/protocol'
import { CLOSE_AFTER_MS, MAX_OPEN_MS, SAMPLE_MS, createTimeline, toRecordingMs, type SpeakerReading } from './timeline'

const T0 = 1_760_000_000_000
const DELAY = 1500
const r = (...nomes: string[]): SpeakerReading => ({ nomes, fonte: 'dsh' })

/** Amostra a cada 250 ms de `fromMs` a `toMs` (relativos ao começo) com a mesma leitura. */
function run(tl: ReturnType<typeof createTimeline>, fromMs: number, toMs: number, reading: SpeakerReading | null) {
  for (let t = fromMs; t < toMs; t += SAMPLE_MS) tl.sample(T0 + t, reading)
}

describe('toRecordingMs (atraso do mixer)', () => {
  it('soma o atraso: o que é ao vivo em t aparece no áudio em t + atraso', () => {
    expect(toRecordingMs(T0, T0, DELAY)).toBe(1500)
    expect(toRecordingMs(T0 + 10_000, T0, DELAY)).toBe(11_500)
    expect(toRecordingMs(T0 + 10_000, T0, 0)).toBe(10_000)
    // Antes do começo (relógio que voltou) não fica negativo.
    expect(toRecordingMs(T0 - 5000, T0, DELAY)).toBe(0)
  })
})

describe('createTimeline', () => {
  it('abre na primeira leitura, fecha depois da histerese e desloca pelo atraso', () => {
    const tl = createTimeline({ startedAt: T0, delayMs: DELAY })
    run(tl, 0, 2000, r())
    run(tl, 2000, 6000, r('Ana Souza'))
    run(tl, 6000, 9000, r())
    expect(tl.all(T0 + 9000)).toEqual([{ nome: 'Ana Souza', de: 2000 + DELAY, ate: 5750 + SAMPLE_MS + DELAY, fonte: 'dsh' }])
  })

  it('pausa mais curta que a histerese não quebra a fala; mais longa, quebra', () => {
    const tl = createTimeline({ startedAt: T0, delayMs: 0 })
    expect(CLOSE_AFTER_MS).toBe(1000)
    run(tl, 0, 2000, r('Ana Souza'))
    // 750 ms sem a Ana (três leituras): ainda é a mesma fala.
    run(tl, 2000, 2750, r())
    run(tl, 2750, 4000, r('Ana Souza'))
    expect(tl.all(0).map((i) => [i.de, i.ate])).toEqual([[0, 4000]])
    run(tl, 4000, 7000, r())
    run(tl, 7000, 8000, r('Ana Souza'))
    run(tl, 8000, 10_000, r())
    expect(tl.all(0).map((i) => [i.de, i.ate])).toEqual([
      [0, 4000],
      [7000, 8000],
    ])
  })

  it('duas pessoas ao mesmo tempo e a troca de quem fala', () => {
    const tl = createTimeline({ startedAt: T0, delayMs: 0 })
    run(tl, 0, 3000, r('Ana Souza'))
    run(tl, 3000, 4000, r('Ana Souza', 'Bruno Lima'))
    run(tl, 4000, 8000, r('Bruno Lima'))
    run(tl, 8000, 10_000, r())
    expect(tl.all(0).map((i) => [i.nome, i.de, i.ate])).toEqual([
      ['Ana Souza', 0, 4000],
      ['Bruno Lima', 3000, 8000],
    ])
  })

  it('null (o adaptador não sabe) fecha como ninguém falando', () => {
    const tl = createTimeline({ startedAt: T0, delayMs: 0 })
    run(tl, 0, 2000, r('Ana Souza'))
    run(tl, 2000, 5000, null)
    expect(tl.all(0)).toEqual([{ nome: 'Ana Souza', de: 0, ate: 2000, fonte: 'dsh' }])
  })

  it('você (microfone) é um intervalo à parte, com voce e sem nome', () => {
    const tl = createTimeline({ startedAt: T0, delayMs: DELAY })
    for (let t = 0; t < 6000; t += SAMPLE_MS) {
      tl.sample(T0 + t, r(t < 3000 ? 'Ana Souza' : ''))
      tl.sampleSelf(T0 + t, t >= 3000 && t < 5000)
    }
    tl.closeAll(T0 + 6000)
    expect(tl.all(0)).toEqual([
      { nome: 'Ana Souza', de: DELAY, ate: 3000 + DELAY, fonte: 'dsh' },
      { nome: '', voce: true, de: 3000 + DELAY, ate: 5000 + DELAY, fonte: 'microfone' },
    ])
  })

  it('closeAll fecha o que está aberto no instante do fim', () => {
    const tl = createTimeline({ startedAt: T0, delayMs: 0 })
    run(tl, 0, 3000, r('Ana Souza'))
    tl.closeAll(T0 + 3000)
    expect(tl.all(0)).toEqual([{ nome: 'Ana Souza', de: 0, ate: 3000, fonte: 'dsh' }])
  })

  it('o lote manda só o que ainda pode mudar e, quando nada mudou, nada', () => {
    const tl = createTimeline({ startedAt: T0, delayMs: 0 })
    run(tl, 0, 2000, r('Ana Souza'))
    const b1 = tl.batch(T0 + 2000)!
    expect(b1.from).toBe(0)
    expect(b1.intervals.map((i) => i.nome)).toEqual(['Ana Souza'])
    run(tl, 2000, 4000, r())
    run(tl, 4000, 6000, r('Bruno Lima'))
    run(tl, 6000, 6500, r('Bruno Lima'))
    // A Ana ainda estava aberta no lote anterior: este a reenvia, já fechada, e o Bruno.
    const b2 = tl.batch(T0 + 6500)!
    expect(b2.from).toBe(0)
    expect(b2.intervals.map((i) => i.nome)).toEqual(['Ana Souza', 'Bruno Lima'])
    const b3 = tl.batch(T0 + 6500)
    expect(b3).toBeNull()
    run(tl, 6500, 7000, r('Bruno Lima'))
    const b4 = tl.batch(T0 + 7000)!
    expect(b4.from).toBe(1)
    expect(b4.intervals.map((i) => [i.nome, i.ate])).toEqual([['Bruno Lima', 7000]])
  })

  it('aplicar os lotes em ordem dá a linha inteira (o que o SW faz)', () => {
    const tl = createTimeline({ startedAt: T0, delayMs: 0 })
    let stored: Array<{ nome: string; de: number; ate: number }> = []
    const flush = (t: number) => {
      const b = tl.batch(T0 + t)
      if (b) stored = [...stored.slice(0, b.from), ...b.intervals]
    }
    const plan: Array<[number, string[]]> = [
      [0, ['Ana Souza']],
      [3000, []],
      [4500, ['Bruno Lima']],
      [9000, ['Ana Souza', 'Bruno Lima']],
      [10_000, []],
      [12_000, ['Carla Dias']],
    ]
    for (let t = 0; t < 15_000; t += SAMPLE_MS) {
      const cur = [...plan].reverse().find(([at]) => t >= at)![1]
      tl.sample(T0 + t, r(...cur))
      if (t % 1000 === 0) flush(t)
    }
    tl.closeAll(T0 + 15_000)
    flush(15_000)
    expect(stored).toEqual(tl.all(0))
    expect(stored.map((i) => i.nome)).toEqual(['Ana Souza', 'Bruno Lima', 'Ana Souza', 'Carla Dias'])
  })

  it('closeAll com o fim do áudio (pagehide): o que começou depois sai, o resto é cortado ali', () => {
    const tl = createTimeline({ startedAt: T0, delayMs: DELAY })
    for (let t = 0; t < 10_000; t += SAMPLE_MS) {
      tl.sample(T0 + t, r(...(t < 3000 ? ['Ana Souza'] : []), ...(t >= 6000 ? ['Bruno Lima'] : []), ...(t >= 9000 ? ['Carla Dias'] : [])))
      tl.sampleSelf(T0 + t, t >= 7000)
    }
    // O gravador parou em 10 s (sem gravar o atraso): no áudio, 10 s é o fim.
    tl.closeAll(T0 + 10_000, 10_000)
    expect(tl.all(0).map((i) => [i.voce ? 'Você' : i.nome, i.de, i.ate])).toEqual([
      ['Ana Souza', DELAY, 3000 + DELAY],
      ['Bruno Lima', 6000 + DELAY, 10_000],
      ['Você', 7000 + DELAY, 10_000],
    ])
    // Sem o fim do áudio (o finish grava o atraso), nada é cortado.
    const tl2 = createTimeline({ startedAt: T0, delayMs: DELAY })
    run(tl2, 0, 10_000, r('Ana Souza'))
    tl2.closeAll(T0 + 10_000)
    expect(tl2.all(0).map((i) => [i.de, i.ate])).toEqual([[DELAY, 10_000 + DELAY]])
  })

  it('intervalo aberto há MAX_OPEN_MS é cortado: o lote fica pequeno e os pedaços se juntam de novo no SW', () => {
    const tl = createTimeline({ startedAt: T0, delayMs: 0 })
    expect(MAX_OPEN_MS).toBe(30_000)
    let stored: SpeakerInterval[] = []
    let biggest = 0
    // A Ana "fala" sem parar por 5 min (sinal preso) e o Bruno entra e sai a cada 4 s.
    for (let t = 0; t < 300_000; t += SAMPLE_MS) {
      tl.sample(T0 + t, r('Ana Souza', ...(t % 8000 < 4000 ? ['Bruno Lima'] : [])))
      if (t % 5000 === 0) {
        const b = tl.batch(T0 + t)
        if (b) {
          biggest = Math.max(biggest, b.intervals.length)
          stored = [...stored.slice(0, b.from), ...b.intervals]
        }
      }
    }
    tl.closeAll(T0 + 300_000)
    const b = tl.batch(T0 + 300_000)!
    stored = [...stored.slice(0, b.from), ...b.intervals]
    expect(stored).toEqual(tl.all(0))
    // Sem o corte, o último lote levaria os 38 intervalos desde o começo da Ana.
    expect(biggest).toBeLessThanOrEqual(12)
    const ana = stored.filter((i) => i.nome === 'Ana Souza')
    expect(ana.length).toBe(10)
    // Os pedaços se encostam: juntos, são a fala inteira.
    expect(mergeIntervals(stored).filter((i) => i.nome === 'Ana Souza').map((i) => [i.de, i.ate])).toEqual([[0, 300_000]])
  })

  it('para no limite de intervalos', () => {
    const tl = createTimeline({ startedAt: T0, delayMs: 0, maxIntervals: 2 })
    run(tl, 0, 1000, r('A'))
    run(tl, 1000, 3000, r())
    run(tl, 3000, 4000, r('B'))
    run(tl, 4000, 6000, r())
    run(tl, 6000, 7000, r('C'))
    expect(tl.all(0).map((i) => i.nome)).toEqual(['A', 'B'])
  })
})
