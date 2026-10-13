// Escolhas das configurações do vigia (Emenda 16): tempo de confirmação em leituras, frações
// oferecidas e o pico do exemplo.
import { describe, expect, it } from 'vitest'
import { DEFAULT_VIGIA } from './settings'
import { confirmacoesPara, opcoesDeConfirmacao, opcoesDeFracao, picoDoExemplo, segundosDeConfirmacao } from './vigia-rule'

describe('confirmar antes de sair: segundos e leituras', () => {
  it('com a leitura a cada 5 s: na hora, 10, 20 e 30 s são 1, 2, 4 e 6 leituras', () => {
    expect([0, 10, 20, 30].map((s) => confirmacoesPara(s, 5))).toEqual([1, 2, 4, 6])
    expect(opcoesDeConfirmacao(5, 4)).toEqual([
      { confirmacoes: 1, segundos: 0 },
      { confirmacoes: 2, segundos: 10 },
      { confirmacoes: 4, segundos: 20 },
      { confirmacoes: 6, segundos: 30 },
    ])
  })

  it('o padrão do script (4 leituras de 5 s) é 20 s', () => {
    expect(segundosDeConfirmacao(DEFAULT_VIGIA.confirmacoes, DEFAULT_VIGIA.intervaloSeg)).toBe(20)
  })

  it('a configuração atual entra mesmo fora da lista, em ordem', () => {
    expect(opcoesDeConfirmacao(5, 3).map((o) => o.confirmacoes)).toEqual([1, 2, 3, 4, 6])
    expect(opcoesDeConfirmacao(5, 3).find((o) => o.confirmacoes === 3)?.segundos).toBe(15)
  })

  it('outro intervalo: os segundos mostrados são os de verdade e as repetidas somem', () => {
    expect(opcoesDeConfirmacao(10, 2)).toEqual([
      { confirmacoes: 1, segundos: 0 },
      { confirmacoes: 2, segundos: 20 },
      { confirmacoes: 3, segundos: 30 },
    ])
    expect(opcoesDeConfirmacao(1, 1).map((o) => o.segundos)).toEqual([0, 10, 20, 30])
    expect(segundosDeConfirmacao(3, 2.5)).toBe(7.5)
  })
})

describe('frações oferecidas', () => {
  it('75%, metade, 30% e 25%, da maior para a menor', () => {
    expect(opcoesDeFracao(0.3)).toEqual([0.75, 0.5, 0.3, 0.25])
  })
  it('uma fração guardada fora da lista aparece também (quem mexia nos números antes)', () => {
    expect(opcoesDeFracao(0.6)).toEqual([0.75, 0.6, 0.5, 0.3, 0.25])
    expect(opcoesDeFracao(1)).toEqual([0.75, 0.5, 0.3, 0.25])
  })
})

describe('pico do exemplo', () => {
  it('10 pessoas, ou mais quando o modo só vale numa call maior', () => {
    expect(picoDoExemplo(DEFAULT_VIGIA)).toBe(10)
    expect(picoDoExemplo({ ...DEFAULT_VIGIA, modo: 'sozinho' })).toBe(10)
    expect(picoDoExemplo({ ...DEFAULT_VIGIA, modo: 'quantidade', quantidade: 3 })).toBe(10)
    expect(picoDoExemplo({ ...DEFAULT_VIGIA, modo: 'quantidade', quantidade: 8 })).toBe(16)
    expect(picoDoExemplo({ ...DEFAULT_VIGIA, picoParaQueda: 15 })).toBe(15)
  })
})
