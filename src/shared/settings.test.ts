// Padrões das configurações por perfil (Emendas 1, 2 e 6): o vigia começa desligado e os seis
// números são os do script do usuário (docs/referencia/vigia-original.js), lidos do próprio
// arquivo para o teste quebrar se um dos dois mudar sozinho.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { languageOf } from './i18n'
import { DEFAULT_SETTINGS, DEFAULT_VIGIA, SCRIPT_VIGIA, normalizeSettings } from './settings'

function numbersOfOriginalScript(): Record<string, number> {
  const src = readFileSync(new URL('../../docs/referencia/vigia-original.js', import.meta.url), 'utf8')
  const block = src.slice(src.indexOf('Object.assign({'), src.indexOf('}, window.VIGIA_CFG'))
  const out: Record<string, number> = {}
  for (const m of block.matchAll(/(\w+):\s*([\d.]+),/g)) out[m[1]] = Number(m[2])
  return out
}

describe('configurações padrão', () => {
  it('os seis números do vigia são os do script original, no modo proporção (Emenda 16)', () => {
    const original = numbersOfOriginalScript()
    expect(Object.keys(original)).toHaveLength(6)
    expect(SCRIPT_VIGIA).toEqual(original)
    expect(DEFAULT_VIGIA).toEqual({ modo: 'proporcao', quantidade: 2, ...original })
  })

  it('perfil sem nome, saída automática desligada e indicador ligado', () => {
    expect(DEFAULT_SETTINGS).toMatchObject({ profileLabel: '', autoLeave: false, vigiaIndicador: true, minSeconds: 30, autoMeet: true, autoTeams: true })
    expect(normalizeSettings(undefined)).toEqual({ ...DEFAULT_SETTINGS, vigia: DEFAULT_VIGIA })
  })

  it('campo inválido volta ao padrão sem derrubar os outros', () => {
    const s = normalizeSettings({ profileLabel: 'Trabalho', autoLeave: 'sim', vigia: { intervaloSeg: 0, fracao: 0.5 } }, 'id-1')
    expect(s.profileId).toBe('id-1')
    expect(s.profileLabel).toBe('Trabalho')
    expect(s.autoLeave).toBe(false)
    expect(s.vigia).toEqual({ ...DEFAULT_VIGIA, fracao: 0.5 })
  })
})

describe('regra de saída inválida guardada (Emenda 10)', () => {
  it('uma combinação que sairia no pico volta aos números do script nos três campos da regra', () => {
    const s = normalizeSettings({ vigia: { ...DEFAULT_VIGIA, intervaloSeg: 9, picoParaQueda: 2 } })
    expect(s.vigia).toEqual({ ...DEFAULT_VIGIA, intervaloSeg: 9 })
    expect(normalizeSettings({ vigia: { ...DEFAULT_VIGIA, fracao: 1 } }).vigia).toEqual(DEFAULT_VIGIA)
  })
})

describe('modo do vigia guardado (Emenda 16)', () => {
  it('configuração de antes do modo existir: vira proporção com os números dela, sem mudar nada', () => {
    const antiga = { intervaloSeg: 9, fracao: 0.5, minimo: 3, picoParaQueda: 6, confirmacoes: 2, faltasParaFim: 4 }
    const s = normalizeSettings({ profileLabel: 'Trabalho', autoLeave: true, vigiaIndicador: false, vigia: antiga })
    expect(s.vigia).toEqual({ ...antiga, modo: 'proporcao', quantidade: DEFAULT_VIGIA.quantidade })
    expect(s).toMatchObject({ profileLabel: 'Trabalho', autoLeave: true, vigiaIndicador: false })
  })

  it('configuração antiga com um número inválido: só ele volta ao padrão, e o modo é proporção', () => {
    const s = normalizeSettings({ vigia: { intervaloSeg: 0, fracao: 0.5, minimo: 2, picoParaQueda: 4, confirmacoes: 2, faltasParaFim: 3 } })
    expect(s.vigia).toEqual({ ...DEFAULT_VIGIA, fracao: 0.5, confirmacoes: 2 })
  })

  it('os modos novos e a quantidade são guardados como vieram', () => {
    expect(normalizeSettings({ vigia: { ...DEFAULT_VIGIA, modo: 'sozinho' } }).vigia.modo).toBe('sozinho')
    expect(normalizeSettings({ vigia: { ...DEFAULT_VIGIA, modo: 'quantidade', quantidade: 7 } }).vigia).toEqual({ ...DEFAULT_VIGIA, modo: 'quantidade', quantidade: 7 })
  })

  it('modo desconhecido ou quantidade fora de 1 a 50: voltam ao padrão sem derrubar o resto', () => {
    expect(normalizeSettings({ vigia: { ...DEFAULT_VIGIA, modo: 'metade', fracao: 0.75 } }).vigia).toEqual({ ...DEFAULT_VIGIA, fracao: 0.75 })
    for (const quantidade of [0, 51, 2.5, '3']) {
      expect(normalizeSettings({ vigia: { ...DEFAULT_VIGIA, modo: 'quantidade', quantidade } }).vigia, String(quantidade)).toEqual({ ...DEFAULT_VIGIA, modo: 'quantidade' })
    }
  })
})

describe('idioma da interface guardado (Emenda 19)', () => {
  it('padrão auto; configuração de antes da 0.4.1, sem o campo, é auto e o resto fica', () => {
    expect(DEFAULT_SETTINGS.language).toBe('auto')
    const antiga = { profileLabel: 'Trabalho', autoMeet: false, autoTeams: true, minSeconds: 45, autoLeave: true, vigiaIndicador: false, vigia: DEFAULT_VIGIA }
    expect(normalizeSettings(antiga)).toEqual({ ...antiga, profileId: '', language: 'auto', apiTranscription: DEFAULT_SETTINGS.apiTranscription })
  })

  it('pt_BR e en ficam como vieram', () => {
    expect(normalizeSettings({ language: 'pt_BR' }).language).toBe('pt_BR')
    expect(normalizeSettings({ language: 'en', minSeconds: 10 })).toMatchObject({ language: 'en', minSeconds: 10 })
  })

  it('idioma inválido volta a auto sem derrubar os outros campos', () => {
    for (const language of ['es', 'pt-BR', 'EN', '', null, 1, { en: true }]) {
      const s = normalizeSettings({ language, profileLabel: 'Trabalho', minSeconds: 12, vigia: { ...DEFAULT_VIGIA, modo: 'sozinho' } })
      expect(s, String(language)).toMatchObject({ language: 'auto', profileLabel: 'Trabalho', minSeconds: 12 })
      expect(s.vigia.modo).toBe('sozinho')
    }
  })

  it('a leitura sem zod do i18n (o vigia) dá o mesmo que o normalizeSettings', () => {
    for (const raw of [undefined, {}, { language: 'en' }, { language: 'pt_BR' }, { language: 'auto' }, { language: 'es' }, { language: 7 }]) {
      expect(languageOf(raw), JSON.stringify(raw)).toBe(normalizeSettings(raw).language)
    }
  })
})
