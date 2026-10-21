// Roteamento da voz entre as abas (Emenda 25): nenhuma aba, uma aba, duas ao mesmo tempo, a aba
// que fecha, a regra de "sem faixa observável não grava" e quando a troca vale no áudio. A regra é
// pura, então este teste é a prova dela; o que o navegador faz de verdade está em
// tests/e2e/microfone.spec.ts.
import { describe, expect, it } from 'vitest'
import { MIXER_DELAY_MS } from './constants'
import type { MicTrackState } from './mic-gate'
import { MIC_REPORT_STALE_MS, micEdgeWaitMs, micRouteDecide, type MicTabReport } from './mic-route'

/** Uma faixa aberta: viva, ligada, sem mudo do sistema e num sender de verdade. */
const aberta = (over: Partial<MicTrackState> = {}): MicTrackState => ({ readyState: 'live', enabled: true, muted: false, sender: 7, ...over })

const AGORA = 10_000
/** Um relato fresco daquela aba (a frame manda um por segundo, mesmo sem troca). */
const relato = (tabId: number, tracks: MicTrackState[], over: Partial<MicTabReport> = {}): MicTabReport => ({
  tabId,
  tracks,
  at: AGORA,
  sinceMs: 250,
  ...over,
})

describe('quais abas recebem a voz', () => {
  it('nenhuma aba relatando: ninguém recebe', () => {
    expect(micRouteDecide([], AGORA)).toEqual({ tabs: [], open: [] })
  })

  it('uma aba com o portão aberto: só ela recebe', () => {
    const r = micRouteDecide([relato(5, [aberta()])], AGORA)
    expect(r.open).toEqual([5])
    expect(r.tabs).toEqual([{ tabId: 5, open: true, reason: null, waitMs: MIXER_DELAY_MS }])
  })

  it('duas abas com o portão aberto ao mesmo tempo: as duas recebem', () => {
    // As duas calls estão de fato ouvindo ele; não há como escolher uma.
    expect(micRouteDecide([relato(9, [aberta()]), relato(4, [aberta({ sender: 2 })])], AGORA).open).toEqual([4, 9])
  })

  it('a aba que fecha sai do roteamento e a outra continua', () => {
    const r = micRouteDecide([relato(4, [aberta({ enabled: false })]), relato(9, [aberta()])], AGORA)
    expect(r.open).toEqual([9])
    expect(r.tabs[0]).toMatchObject({ tabId: 4, open: false, reason: 'enabled' })
  })

  it('nenhuma aba com envio vivo: ninguém recebe', () => {
    expect(micRouteDecide([relato(4, [aberta({ sender: null })]), relato(9, [aberta({ muted: true })])], AGORA).open).toEqual([])
  })

  it('a aba que deixou de relatar fecha, e não fica gravando para sempre', () => {
    const velho = relato(4, [aberta()], { at: AGORA - MIC_REPORT_STALE_MS - 1 })
    expect(micRouteDecide([velho], AGORA).tabs).toEqual([{ tabId: 4, open: false, reason: 'desconhecido', waitMs: 0 }])
    // No limite ainda vale (três relatos de rotina perdidos é o que fecha).
    expect(micRouteDecide([{ ...velho, at: AGORA - MIC_REPORT_STALE_MS }], AGORA).open).toEqual([4])
  })

  it('relato com instante inválido conta como velho (o padrão é fechado)', () => {
    expect(micRouteDecide([relato(4, [aberta()], { at: Number.NaN })], AGORA).open).toEqual([])
  })
})

describe('sem faixa observável não grava', () => {
  it('nenhuma faixa de microfone na aba: fechado por sem-faixa', () => {
    // O caso da faixa processada: o cliente envia uma faixa derivada e a do getUserMedia não está
    // em sender nenhum. Sem a faixa da página não existe sinal de mudo, então não se grava.
    expect(micRouteDecide([relato(4, [])], AGORA).tabs).toEqual([{ tabId: 4, open: false, reason: 'sem-faixa', waitMs: MIXER_DELAY_MS - 250 }])
    expect(micRouteDecide([relato(4, [])], AGORA).open).toEqual([])
  })

  it('faixa viva e ligada que ninguém está enviando: fechado por sem-sender', () => {
    expect(micRouteDecide([relato(4, [aberta({ sender: null })])], AGORA).tabs[0]).toMatchObject({ open: false, reason: 'sem-sender' })
  })

  it('qualquer estado indeterminado fecha', () => {
    for (const falta of ['readyState', 'enabled', 'muted', 'sender'] as const) {
      const t = aberta()
      delete t[falta]
      expect(micRouteDecide([relato(4, [t])], AGORA).tabs[0], falta).toMatchObject({ open: false, reason: 'desconhecido' })
    }
  })
})

describe('quando a troca vale no áudio', () => {
  it('abrir espera o atraso inteiro: nada de antes do desmudo entra', () => {
    expect(micEdgeWaitMs(true, 250, 1500)).toBe(1500)
    // A idade não muda nada ao abrir: o pior caso é sempre "desmutou agora".
    expect(micEdgeWaitMs(true, 5000, 1500)).toBe(1500)
  })

  it('fechar desconta a idade da leitura: o corte vale para o áudio de trás', () => {
    expect(micEdgeWaitMs(false, 250, 1500)).toBe(1250)
    expect(micEdgeWaitMs(false, 1000, 1500)).toBe(500)
  })

  it('leitura mais antiga que o atraso desliga na hora (corta mais, que é o lado seguro)', () => {
    expect(micEdgeWaitMs(false, 1500, 1500)).toBe(0)
    expect(micEdgeWaitMs(false, 9000, 1500)).toBe(0)
  })

  it('idade inválida ou negativa conta como zero', () => {
    expect(micEdgeWaitMs(false, Number.NaN, 1500)).toBe(1500)
    expect(micEdgeWaitMs(false, -10, 1500)).toBe(1500)
  })

  it('sem atraso nenhum, a troca vale na hora nos dois lados', () => {
    expect(micEdgeWaitMs(true, 250, 0)).toBe(0)
    expect(micEdgeWaitMs(false, 250, 0)).toBe(0)
  })

  it('a decisão usa o atraso do mixer por padrão, e o que mandarem quando mandam', () => {
    expect(micRouteDecide([relato(4, [aberta()])], AGORA).tabs[0].waitMs).toBe(MIXER_DELAY_MS)
    expect(micRouteDecide([relato(4, [aberta()])], AGORA, 400).tabs[0].waitMs).toBe(400)
    expect(micRouteDecide([relato(4, [aberta({ enabled: false })], { sinceMs: 100 })], AGORA, 400).tabs[0].waitMs).toBe(300)
  })
})
