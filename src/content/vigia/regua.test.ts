// Régua do vigia: os casos do script do usuário (Emenda 2) em tabela, e a mesma régua comparada
// leitura a leitura com o `criarRegua` do próprio script (docs/referencia/vigia-original.js),
// para o porte não poder divergir em silêncio. Emenda 16: os três modos em tabela (sozinho,
// proporção, quantidade), a configuração antiga migrada e o modo sozinho igual ao script sem a
// regra da queda.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { VigiaCfg } from '../../shared/protocol'
import { DEFAULT_VIGIA, normalizeSettings } from '../../shared/settings'
import { criarRegua, limiteDoPico } from './regua'

type Leitura = number | null

/** Roda a régua e devolve o índice da leitura em que ela manda sair (ou null se nunca). */
function primeiraSaida(leituras: Leitura[], cfg: VigiaCfg = DEFAULT_VIGIA): number | null {
  const r = criarRegua(cfg)
  for (const [i, n] of leituras.entries()) if (r.ver(n).sair) return i
  return null
}

/** O `criarRegua` do script original, com o CFG injetado (o script lia um global). */
function reguaDoScript(cfg: VigiaCfg): { ver(n: Leitura): { limite: number; armado: boolean; sair: boolean }; pico: number; seguidas: number } {
  const src = readFileSync(new URL('../../../docs/referencia/vigia-original.js', import.meta.url), 'utf8')
  const ini = src.indexOf('function criarRegua()')
  const fim = src.indexOf('const badge = document.createElement')
  expect(ini, 'criarRegua no script original').toBeGreaterThan(0)
  const corpo = src.slice(ini, fim)
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function('CFG', `${corpo}\nreturn criarRegua();`)(cfg)
}

describe('régua do vigia: casos do script', () => {
  const casos: Array<{ nome: string; leituras: Leitura[]; sai: number | null }> = [
    { nome: 'pico 2: sozinho sai na hora', leituras: [2, 2, 1], sai: 2 },
    { nome: 'pico 2: com 2 nunca sai', leituras: [2, 2, 2, 2, 2, 2, 2, 2], sai: null },
    { nome: 'pico 3: com 2 nunca sai (limite 1)', leituras: [3, 2, 2, 2, 2, 2, 2, 2], sai: null },
    { nome: 'pico 3: sozinho sai na hora', leituras: [3, 2, 1], sai: 2 },
    { nome: 'pico 8: com 2 sai na 4a leitura seguida', leituras: [8, 2, 2, 2, 2, 2], sai: 4 },
    { nome: 'pico 8: com 3 nunca sai (limite 2)', leituras: [8, 3, 3, 3, 3, 3, 3, 3], sai: null },
    { nome: 'pico 8: leitura acima do limite zera as seguidas', leituras: [8, 2, 2, 2, 3, 2, 2, 2, 2], sai: 8 },
    { nome: 'pico 8: leitura null não zera nem conta', leituras: [8, 2, null, 2, null, 2, 2], sai: 6 },
    { nome: 'pico 8: só null depois do pico nunca sai', leituras: [8, null, null, null, null, null], sai: null },
    { nome: 'pico 8: sozinho sai na hora, sem esperar as 4', leituras: [8, 5, 1], sai: 2 },
    { nome: 'pico 5: sozinho sai na hora', leituras: [5, 1], sai: 1 },
    { nome: 'pico 4: limite é o mínimo 2', leituras: [4, 2, 2, 2, 2], sai: 4 },
    { nome: 'pico 10: limite 3 (floor de 3,0000000000000004)', leituras: [10, 3, 3, 3, 3], sai: 4 },
    { nome: 'pico 20: com 6 sai na 4a, com 7 nunca', leituras: [20, 7, 7, 7, 7, 6, 6, 6, 6], sai: 8 },
    { nome: 'sozinho desde o começo (pico 1) nunca sai: desarmado', leituras: [1, 1, 1, 1, 1, 1], sai: null },
    { nome: 'sem contagem nunca sai', leituras: [null, null, null, null, null], sai: null },
    { nome: 'pico 3: 0 conta como abaixo do limite (quirk do script)', leituras: [3, 0, 0, 0, 0], sai: 4 },
    { nome: 'pico 2: o pico sobe e o limite acompanha', leituras: [2, 9, 3, 3, 3, 2, 2, 2, 2], sai: 8 },
  ]
  for (const c of casos) {
    it(c.nome, () => {
      expect(primeiraSaida(c.leituras)).toBe(c.sai)
    })
  }

  it('limite, armado e seguidas leitura a leitura (pico 8, queda para 2 com um null no meio)', () => {
    const r = criarRegua(DEFAULT_VIGIA)
    const passos = [8, 2, null, 2, 2, 2].map((n) => ({ n, ...r.ver(n), pico: r.pico, seguidas: r.seguidas }))
    expect(passos).toEqual([
      { n: 8, limite: 2, armado: true, sair: false, pico: 8, seguidas: 0 },
      { n: 2, limite: 2, armado: true, sair: false, pico: 8, seguidas: 1 },
      { n: null, limite: 2, armado: true, sair: false, pico: 8, seguidas: 1 },
      { n: 2, limite: 2, armado: true, sair: false, pico: 8, seguidas: 2 },
      { n: 2, limite: 2, armado: true, sair: false, pico: 8, seguidas: 3 },
      { n: 2, limite: 2, armado: true, sair: true, pico: 8, seguidas: 4 },
    ])
  })

  it('antes de qualquer contagem: limite 1, desarmado', () => {
    expect(criarRegua(DEFAULT_VIGIA).ver(null)).toEqual({ limite: 1, armado: false, sair: false })
  })

  it('limiteDoPico segue a fórmula do script', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 20, 100].map((p) => limiteDoPico(p, DEFAULT_VIGIA))).toEqual([1, 1, 1, 2, 2, 2, 2, 2, 2, 3, 3, 6, 30])
  })

  it('confirmacoes vem da configuração', () => {
    expect(primeiraSaida([8, 2, 2], { ...DEFAULT_VIGIA, confirmacoes: 2 })).toBe(2)
    expect(primeiraSaida([8, 2, 2, 2, 2, 2, 2], { ...DEFAULT_VIGIA, confirmacoes: 6 })).toBe(6)
  })

  it('configuração nova vale na próxima leitura, sem zerar o pico', () => {
    let cfg: VigiaCfg = DEFAULT_VIGIA
    const r = criarRegua(() => cfg)
    expect(r.ver(8)).toMatchObject({ limite: 2, sair: false })
    expect(r.ver(3)).toMatchObject({ limite: 2, sair: false })
    cfg = { ...DEFAULT_VIGIA, fracao: 0.5, confirmacoes: 1 }
    expect(r.ver(3)).toEqual({ limite: 4, armado: true, sair: true })
    expect(r.pico).toBe(8)
  })
})

describe('régua do vigia: os três modos (Emenda 16)', () => {
  const SOZINHO: VigiaCfg = { ...DEFAULT_VIGIA, modo: 'sozinho' }
  const METADE: VigiaCfg = { ...DEFAULT_VIGIA, modo: 'proporcao', fracao: 0.5 }
  const TRES: VigiaCfg = { ...DEFAULT_VIGIA, modo: 'quantidade', quantidade: 3 }
  const casos: Array<{ nome: string; cfg: VigiaCfg; leituras: Leitura[]; sai: number | null }> = [
    // sozinho: só sai com 1 (ou com o 0 do script, depois das confirmações)
    { nome: 'sozinho: call de 8 com 2 nunca sai', cfg: SOZINHO, leituras: [8, 2, 2, 2, 2, 2, 2, 2], sai: null },
    { nome: 'sozinho: call de 20 com 2 nunca sai', cfg: SOZINHO, leituras: [20, 2, 2, 2, 2, 2, 2, 2], sai: null },
    { nome: 'sozinho: ficar sozinho sai na hora', cfg: SOZINHO, leituras: [8, 2, 1], sai: 2 },
    { nome: 'sozinho: leitura null antes de ficar sozinho não atrapalha', cfg: SOZINHO, leituras: [8, null, 1], sai: 2 },
    { nome: 'sozinho: sozinho desde o começo nunca sai (desarmado)', cfg: SOZINHO, leituras: [1, 1, 1, 1, 1], sai: null },
    { nome: 'sozinho: 0 conta como abaixo do limite (quirk do script)', cfg: SOZINHO, leituras: [3, 0, 0, 0, 0], sai: 4 },
    // proporção, metade
    { nome: 'metade: call de 10 sai com 5 depois das 4 leituras', cfg: METADE, leituras: [10, 5, 5, 5, 5], sai: 4 },
    { nome: 'metade: call de 10 com 6 nunca sai', cfg: METADE, leituras: [10, 6, 6, 6, 6, 6, 6], sai: null },
    { nome: 'metade: call de 9 sai com 4 (floor de 4,5)', cfg: METADE, leituras: [9, 4, 4, 4, 4], sai: 4 },
    { nome: 'metade: call de 9 com 5 nunca sai', cfg: METADE, leituras: [9, 5, 5, 5, 5, 5], sai: null },
    { nome: 'metade: call que nunca chegou a 4 com 2 nunca sai', cfg: METADE, leituras: [3, 2, 2, 2, 2, 2, 2], sai: null },
    { nome: 'metade: call de 3 sai na hora sozinho', cfg: METADE, leituras: [3, 1], sai: 1 },
    { nome: 'metade: leitura null não zera nem conta', cfg: METADE, leituras: [10, 5, null, 5, 5, 5], sai: 5 },
    { nome: 'metade: leitura acima do limite zera as confirmações', cfg: METADE, leituras: [10, 5, 5, 6, 5, 5, 5, 5], sai: 7 },
    { nome: 'metade: sozinho sai na hora, sem esperar as confirmações', cfg: METADE, leituras: [10, 5, 1], sai: 2 },
    // quantidade, 3 ou menos
    { nome: 'quantidade 3: call de 10 sai com 3 depois das 4 leituras', cfg: TRES, leituras: [10, 3, 3, 3, 3], sai: 4 },
    { nome: 'quantidade 3: call de 10 com 4 nunca sai', cfg: TRES, leituras: [10, 4, 4, 4, 4, 4, 4], sai: null },
    { nome: 'quantidade 3: call que nunca passou de 3 nunca sai com 3', cfg: TRES, leituras: [3, 3, 3, 3, 3, 3], sai: null },
    { nome: 'quantidade 3: call que nunca passou de 3 nunca sai com 2', cfg: TRES, leituras: [3, 2, 2, 2, 2, 2, 2], sai: null },
    { nome: 'quantidade 3: call que nunca passou de 3 sai sozinho na hora', cfg: TRES, leituras: [3, 2, 1], sai: 2 },
    { nome: 'quantidade 3: call de 4 já arma', cfg: TRES, leituras: [4, 3, 3, 3, 3], sai: 4 },
    { nome: 'quantidade 3: o pico sobe e arma no meio', cfg: TRES, leituras: [2, 3, 3, 3, 3, 4, 3, 3, 3, 3], sai: 9 },
    { nome: 'quantidade 3: leitura null não zera nem conta', cfg: TRES, leituras: [10, 3, null, 3, null, 3, 3], sai: 6 },
    { nome: 'quantidade 3: sozinho sai na hora', cfg: TRES, leituras: [10, 2, 1], sai: 2 },
    { nome: 'quantidade 3: só null depois do pico nunca sai', cfg: TRES, leituras: [10, null, null, null, null, null], sai: null },
    { nome: 'quantidade 3, 1 confirmação: sai na primeira leitura com 3', cfg: { ...TRES, confirmacoes: 1 }, leituras: [10, 3], sai: 1 },
    { nome: 'quantidade 3, 6 confirmações: sai na sexta', cfg: { ...TRES, confirmacoes: 6 }, leituras: [10, 3, 3, 3, 3, 3, 3], sai: 6 },
    { nome: 'quantidade 1: igual a só sozinho', cfg: { ...TRES, quantidade: 1 }, leituras: [10, 2, 2, 2, 2, 2, 1], sai: 6 },
    { nome: 'quantidade 50: call de 51 sai com 50', cfg: { ...TRES, quantidade: 50 }, leituras: [51, 50, 50, 50, 50], sai: 4 },
    { nome: 'quantidade 50: call de 50 nunca sai com 10', cfg: { ...TRES, quantidade: 50 }, leituras: [50, 10, 10, 10, 10, 10], sai: null },
    { nome: 'sem contagem nenhuma nunca sai', cfg: TRES, leituras: [null, null, null, null], sai: null },
  ]
  for (const c of casos) {
    it(c.nome, () => {
      expect(primeiraSaida(c.leituras, c.cfg)).toBe(c.sai)
    })
  }

  it('limite por pico em cada modo', () => {
    const picos = [1, 2, 3, 4, 5, 9, 10, 20]
    expect(picos.map((p) => limiteDoPico(p, SOZINHO))).toEqual([1, 1, 1, 1, 1, 1, 1, 1])
    expect(picos.map((p) => limiteDoPico(p, METADE))).toEqual([1, 1, 1, 2, 2, 4, 5, 10])
    expect(picos.map((p) => limiteDoPico(p, TRES))).toEqual([1, 1, 1, 3, 3, 3, 3, 3])
    expect(picos.map((p) => limiteDoPico(p, { ...DEFAULT_VIGIA, fracao: 0.75 }))).toEqual([1, 1, 1, 3, 3, 6, 7, 15])
    expect(picos.map((p) => limiteDoPico(p, { ...DEFAULT_VIGIA, fracao: 0.25 }))).toEqual([1, 1, 1, 2, 2, 2, 2, 5])
  })

  it('trocar de modo com a call aberta vale na próxima leitura, sem perder o pico', () => {
    let cfg: VigiaCfg = SOZINHO
    const r = criarRegua(() => cfg)
    expect(r.ver(10)).toMatchObject({ limite: 1, sair: false })
    expect(r.ver(3)).toMatchObject({ limite: 1, sair: false })
    cfg = { ...TRES, confirmacoes: 1 }
    expect(r.ver(3)).toEqual({ limite: 3, armado: true, sair: true })
    expect(r.pico).toBe(10)
  })

  it('configuração guardada antes do modo existir: vira proporção com os números dela', () => {
    const antiga = { intervaloSeg: 5, fracao: 0.5, minimo: 3, picoParaQueda: 6, confirmacoes: 2, faltasParaFim: 3 }
    const migrada = normalizeSettings({ autoLeave: true, vigia: antiga }).vigia
    expect(migrada).toMatchObject({ ...antiga, modo: 'proporcao' })
    // Igual ao script com os mesmos números, leitura a leitura.
    const nossa = criarRegua(migrada)
    const deles = reguaDoScript(antiga as unknown as VigiaCfg)
    for (const n of [7, 4, 3, null, 3, 5, 3, 3, 1]) expect(nossa.ver(n)).toEqual(deles.ver(n))
    expect(primeiraSaida([8, 4, 4], migrada)).toBe(2)
    expect(primeiraSaida([5, 2, 2, 2], migrada)).toBe(null)
  })
})

describe('régua do vigia: igual ao criarRegua do script original', () => {
  // Gerador determinístico (sem Math.random): a mesma sequência a cada execução.
  function lcg(seed: number) {
    let s = seed >>> 0
    return () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0
      return s / 2 ** 32
    }
  }

  it('3000 sequências aleatórias com configurações variadas dão o mesmo limite, armado, sair, pico e seguidas', () => {
    const rnd = lcg(20261006)
    const cfgs: VigiaCfg[] = [
      DEFAULT_VIGIA,
      { ...DEFAULT_VIGIA, fracao: 0.5, minimo: 3, picoParaQueda: 6, confirmacoes: 2 },
      { ...DEFAULT_VIGIA, fracao: 0.1, minimo: 1, picoParaQueda: 2, confirmacoes: 1 },
      { ...DEFAULT_VIGIA, fracao: 0.75, minimo: 2, picoParaQueda: 10, confirmacoes: 7 },
    ]
    let leituras = 0
    for (let k = 0; k < 3000; k++) {
      const cfg = cfgs[k % cfgs.length]
      const nossa = criarRegua(cfg)
      const deles = reguaDoScript(cfg)
      const len = 1 + Math.floor(rnd() * 25)
      for (let i = 0; i < len; i++) {
        const x = rnd()
        const n: Leitura = x < 0.15 ? null : Math.floor(rnd() * 14)
        const a = nossa.ver(n)
        const b = deles.ver(n)
        leituras++
        expect({ ...a, pico: nossa.pico, seguidas: nossa.seguidas }, `seq ${k} leitura ${i} (n=${n})`).toEqual({ ...b, pico: deles.pico, seguidas: deles.seguidas })
      }
    }
    expect(leituras).toBeGreaterThan(30_000)
  })

  it('modo sozinho é o script com a regra da queda desligada (picoParaQueda acima de qualquer call)', () => {
    const rnd = lcg(20261008)
    const cfg: VigiaCfg = { ...DEFAULT_VIGIA, modo: 'sozinho' }
    const semQueda = { ...DEFAULT_VIGIA, picoParaQueda: Number.POSITIVE_INFINITY }
    for (let k = 0; k < 500; k++) {
      const nossa = criarRegua(cfg)
      const deles = reguaDoScript(semQueda)
      for (let i = 0; i < 20; i++) {
        const n: Leitura = rnd() < 0.15 ? null : Math.floor(rnd() * 14)
        expect({ ...nossa.ver(n), seguidas: nossa.seguidas }, `seq ${k} leitura ${i}`).toEqual({ ...deles.ver(n), seguidas: deles.seguidas })
      }
    }
  })
})
