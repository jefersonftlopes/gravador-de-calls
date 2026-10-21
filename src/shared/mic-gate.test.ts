// Regra do mudo (Emenda 24): cada condição sozinha, as combinações, o padrão fechado e o
// diagnóstico de números. A regra é pura, então este teste é a prova dela: o que o navegador faz
// de verdade com cada forma de mutar está em tests/e2e/mudo.spec.ts.
import { describe, expect, it } from 'vitest'
import { MIC_GATE_MAX_STEP_MS, MIC_GATE_REASONS, initialMicGate, micGateDecide, micGateDiagnostics, stepMicGate, type MicTrackState } from './mic-gate'

/** Uma faixa aberta: viva, ligada, sem mudo do sistema e num sender de verdade. */
const aberta = (over: Partial<MicTrackState> = {}): MicTrackState => ({ readyState: 'live', enabled: true, muted: false, sender: 7, ...over })

describe('o portão do microfone: aberto só com as quatro condições', () => {
  it('as quatro condições verdadeiras abrem, e o portão diz qual sender está quente', () => {
    expect(micGateDecide([aberta()])).toEqual({ open: true, reason: null, sender: 7 })
  })

  it('cada condição sozinha fecha, com o motivo dela', () => {
    expect(micGateDecide([aberta({ readyState: 'ended' })])).toEqual({ open: false, reason: 'readyState', sender: null })
    expect(micGateDecide([aberta({ enabled: false })])).toEqual({ open: false, reason: 'enabled', sender: null })
    expect(micGateDecide([aberta({ muted: true })])).toEqual({ open: false, reason: 'muted', sender: null })
    expect(micGateDecide([aberta({ sender: null })])).toEqual({ open: false, reason: 'sem-sender', sender: null })
  })

  it('o sender 0 é um sender de verdade (não confundir com ausência)', () => {
    expect(micGateDecide([aberta({ sender: 0 })])).toMatchObject({ open: true, sender: 0 })
  })

  it('nenhuma faixa é fechado por sem-faixa (o padrão, antes do getUserMedia)', () => {
    expect(micGateDecide([])).toEqual({ open: false, reason: 'sem-faixa', sender: null })
  })

  it('estado que não se consegue determinar fecha por desconhecido, campo por campo', () => {
    for (const falta of ['readyState', 'enabled', 'muted', 'sender'] as const) {
      const t = aberta()
      delete t[falta]
      expect(micGateDecide([t])).toEqual({ open: false, reason: 'desconhecido', sender: null })
    }
    expect(micGateDecide([{}])).toMatchObject({ reason: 'desconhecido' })
  })

  it('as combinações: a condição mais cedo na ordem é a que aparece', () => {
    expect(micGateDecide([aberta({ readyState: 'ended', enabled: false, muted: true, sender: null })])).toMatchObject({ reason: 'readyState' })
    expect(micGateDecide([aberta({ enabled: false, muted: true, sender: null })])).toMatchObject({ reason: 'enabled' })
    expect(micGateDecide([aberta({ muted: true, sender: null })])).toMatchObject({ reason: 'muted' })
  })

  it('com várias faixas: uma aberta abre o portão, qualquer que seja a outra', () => {
    expect(micGateDecide([aberta({ readyState: 'ended' }), aberta({ sender: 9 })])).toEqual({ open: true, reason: null, sender: 9 })
    expect(micGateDecide([{}, aberta()])).toMatchObject({ open: true })
  })

  it('com várias faixas fechadas, o motivo é o da que chegou mais longe', () => {
    // A faixa morta não explica nada; a viva que ninguém está enviando explica o mudo.
    expect(micGateDecide([aberta({ readyState: 'ended' }), aberta({ sender: null })])).toMatchObject({ reason: 'sem-sender' })
    expect(micGateDecide([aberta({ sender: null }), aberta({ readyState: 'ended' })])).toMatchObject({ reason: 'sem-sender' })
    expect(micGateDecide([aberta({ enabled: false }), aberta({ readyState: 'ended' })])).toMatchObject({ reason: 'enabled' })
    expect(micGateDecide([{}, aberta({ enabled: false })])).toMatchObject({ reason: 'enabled' })
  })
})

describe('as leituras: tempo em cada estado, transições e motivos', () => {
  const ler = (passos: Array<[number, MicTrackState[]]>) => {
    let s = initialMicGate()
    for (const [now, tracks] of passos) s = stepMicGate(s, now, tracks)
    return s
  }

  it('a primeira leitura só marca o estado (não soma tempo) e conta como uma transição', () => {
    const s = stepMicGate(initialMicGate(), 1000, [aberta()])
    expect(s).toMatchObject({ readings: 1, open: true, at: 1000, openMs: 0, closedMs: 0, opened: 1, closed: 0, maxTracks: 1 })
    const f = stepMicGate(initialMicGate(), 1000, [])
    expect(f).toMatchObject({ open: false, opened: 0, closed: 1, reasons: { 'sem-faixa': 1 } })
  })

  it('o tempo de cada intervalo entra no estado que valia nele', () => {
    // Aberto de 1000 a 1500, fechado de 1500 a 2000, aberto de 2000 a 2250.
    const s = ler([
      [1000, [aberta()]],
      [1250, [aberta()]],
      [1500, [aberta({ enabled: false })]],
      [1750, [aberta({ enabled: false })]],
      [2000, [aberta()]],
      [2250, [aberta()]],
    ])
    expect(s).toMatchObject({ readings: 6, openMs: 750, closedMs: 500, opened: 2, closed: 1 })
    expect(s.reasons.enabled).toBe(2)
  })

  it('cada leitura fechada conta no motivo dela (uma call mutada o tempo todo não tem transição)', () => {
    const s = ler([
      [0, [aberta({ sender: null })]],
      [250, [aberta({ sender: null })]],
      [500, [aberta({ sender: null })]],
    ])
    expect(s).toMatchObject({ opened: 0, closed: 1, openMs: 0, closedMs: 500 })
    expect(s.reasons['sem-sender']).toBe(3)
  })

  it('leitura aberta não conta em nenhum motivo', () => {
    const s = ler([
      [0, [aberta()]],
      [250, [aberta()]],
    ])
    expect(Object.values(s.reasons).every((n) => n === 0)).toBe(true)
  })

  it('o motivo pode trocar sem o portão reabrir (mutou e depois parou a faixa)', () => {
    const s = ler([
      [0, [aberta()]],
      [250, [aberta({ enabled: false })]],
      [500, [aberta({ readyState: 'ended', enabled: false })]],
    ])
    expect(s).toMatchObject({ opened: 1, closed: 1 })
    expect(s.reasons).toMatchObject({ enabled: 1, readyState: 1 })
  })

  it('relógio que anda para trás não tira tempo, e um salto longo vale no máximo o teto', () => {
    const atras = ler([
      [1000, [aberta()]],
      [500, [aberta()]],
    ])
    expect(atras).toMatchObject({ openMs: 0, at: 500 })
    const salto = ler([
      [0, [aberta()]],
      [3_600_000, [aberta()]],
    ])
    expect(salto.openMs).toBe(MIC_GATE_MAX_STEP_MS)
  })

  it('faixasMax é o maior número de faixas visto numa leitura', () => {
    const s = ler([
      [0, [aberta()]],
      [250, [aberta(), aberta({ sender: 8 })]],
      [500, [aberta()]],
    ])
    expect(s.maxTracks).toBe(2)
  })
})

describe('o diagnóstico: só números', () => {
  it('leva as contagens, os segundos com uma casa e todos os motivos', () => {
    let s = initialMicGate()
    for (let i = 0; i <= 12; i++) s = stepMicGate(s, i * 250, i >= 4 && i < 8 ? [aberta({ muted: true })] : [aberta()])
    const d = micGateDiagnostics(s)
    expect(d).toEqual({
      leituras: 13,
      abriu: 2,
      fechou: 1,
      segundosAberto: 2,
      segundosFechado: 1,
      faixasMax: 1,
      motivos: { readyState: 0, enabled: 0, muted: 4, semSender: 0, semFaixa: 0, desconhecido: 0 },
    })
  })

  it('tudo número finito, nada de texto (nunca áudio, nome nem dispositivo)', () => {
    const d = micGateDiagnostics(stepMicGate(initialMicGate(), 0, [aberta()]))
    const valores = [...Object.values(d).filter((v) => typeof v !== 'object'), ...Object.values(d.motivos)]
    expect(valores.every((v) => typeof v === 'number' && Number.isFinite(v))).toBe(true)
    expect(JSON.stringify(d)).not.toContain('"live"')
  })

  it('os seis motivos da regra são os seis do diagnóstico', () => {
    const d = micGateDiagnostics(initialMicGate())
    expect(Object.keys(d.motivos)).toHaveLength(MIC_GATE_REASONS.length)
    expect(MIC_GATE_REASONS).toEqual(['readyState', 'enabled', 'muted', 'sem-sender', 'sem-faixa', 'desconhecido'])
  })

  it('segundos com uma casa (1,8 s de aberto)', () => {
    let s = stepMicGate(initialMicGate(), 0, [aberta()])
    s = stepMicGate(s, 1750, [aberta()])
    expect(micGateDiagnostics(s).segundosAberto).toBe(1.8)
  })
})
