import { describe, expect, it } from 'vitest'
import { ALIVE_MS, CsrcTracker, toEpochMs } from './csrc'

const NOW = 1_760_000_000_000

describe('toEpochMs', () => {
  it('carimbo de época fica; do performance.now() ganha o timeOrigin', () => {
    expect(toEpochMs(NOW - 20, NOW, 1_759_999_000_000)).toBe(NOW - 20)
    expect(toEpochMs(999_980, NOW, NOW - 1_000_000)).toBe(NOW - 20)
  })
})

describe('CsrcTracker', () => {
  it('presença na lista não é fala: só o carimbo que mudou conta', () => {
    const t = new CsrcTracker()
    // Primeira leitura: só o carimbo recente conta (a entrada fica 10 s depois do último pacote).
    expect(t.active([{ source: 1, timestamp: NOW - 50 }, { source: 2, timestamp: NOW - 8000 }], NOW)).toEqual([1])
    // A 2 continua com o mesmo carimbo velho; a 1 recebeu pacote novo.
    expect(t.active([{ source: 1, timestamp: NOW + 200 }, { source: 2, timestamp: NOW - 8000 }], NOW + 250)).toEqual([1])
    // A 1 parou (mesmo carimbo), a 2 voltou a falar.
    expect(t.active([{ source: 1, timestamp: NOW + 200 }, { source: 2, timestamp: NOW + 480 }], NOW + 500)).toEqual([2])
  })

  it('o rtpTimestamp que mudou também conta', () => {
    const t = new CsrcTracker()
    t.active([{ source: 7, timestamp: NOW - 10, rtpTimestamp: 100 }], NOW)
    expect(t.active([{ source: 7, timestamp: NOW - 10, rtpTimestamp: 900 }], NOW + 250)).toEqual([7])
  })

  it('nível de áudio abaixo de 0,01 não conta; sem nível, conta', () => {
    const t = new CsrcTracker()
    expect(t.active([{ source: 1, timestamp: NOW, audioLevel: 0.005 }, { source: 2, timestamp: NOW, audioLevel: 0.2 }, { source: 3, timestamp: NOW }], NOW)).toEqual([2, 3])
  })

  it('a mesma fonte em dois receptores vale uma vez, pelo carimbo mais novo', () => {
    const t = new CsrcTracker()
    t.active([{ source: 1, timestamp: NOW - 10 }], NOW)
    expect(t.active([{ source: 1, timestamp: NOW - 10 }, { source: 1, timestamp: NOW + 240 }], NOW + 250)).toEqual([1])
  })

  it('carimbo no relógio do performance.now() é convertido (senão nunca seria recente)', () => {
    const origin = NOW - 5_000_000
    const t = new CsrcTracker(origin)
    expect(t.active([{ source: 9, timestamp: NOW - origin - 30 }], NOW)).toEqual([9])
  })

  it('vivo até ALIVE_MS depois da última leitura com alguma entrada', () => {
    const t = new CsrcTracker()
    expect(t.alive(NOW)).toBe(false)
    t.active([{ source: 1, timestamp: NOW }], NOW)
    t.active([], NOW + 1000)
    expect(t.alive(NOW + ALIVE_MS)).toBe(true)
    expect(t.alive(NOW + ALIVE_MS + 1)).toBe(false)
  })
})
