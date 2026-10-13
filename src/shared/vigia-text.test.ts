// Textos do vigia (Emenda 16): a linha da contagem (popup e indicador) e o exemplo das
// configurações, nos dois idiomas, calculados com a mesma regra do vigia.
import { afterEach, describe, expect, it } from 'vitest'
import { useLocale } from '../../tests/helpers/i18n-setup'
import type { VigiaCfg } from './protocol'
import { DEFAULT_VIGIA } from './settings'
import { vigiaCountLine, vigiaExample } from './vigia-text'

afterEach(() => useLocale('pt_BR'))

const linha = { n: 6, pico: 10, limite: 5, armado: true, seguidas: 0 }

describe('linha da contagem', () => {
  it('com limite: "sai com N ou menos"', () => {
    expect(vigiaCountLine(linha, 4)).toBe('6 na call · pico 10 · sai com 5 ou menos')
    expect(vigiaCountLine({ ...linha, n: 5, seguidas: 2 }, 4)).toBe('5 na call · pico 10 · sai com 5 ou menos · confirmando 2/4')
  })
  it('limite 1 (modo sozinho ou call pequena): "sai se você ficar sozinho"', () => {
    expect(vigiaCountLine({ ...linha, n: 3, pico: 3, limite: 1 }, 4)).toBe('3 na call · pico 3 · sai se você ficar sozinho')
    expect(vigiaCountLine({ n: 1, pico: 1, limite: 1, armado: false, seguidas: 0 }, 4)).toBe('1 na call · pico 1 · sai se você ficar sozinho (espera alguém entrar)')
  })
  it('em inglês', () => {
    useLocale('en')
    expect(vigiaCountLine({ ...linha, seguidas: 1 }, 4)).toBe('6 in the call · peak 10 · leaves at 5 or fewer · confirming 1/4')
    expect(vigiaCountLine({ ...linha, limite: 1 }, 4)).toBe('6 in the call · peak 10 · leaves if you are alone')
  })
})

describe('exemplo das configurações', () => {
  const casos: Array<{ nome: string; cfg: VigiaCfg; pt: string; en: string }> = [
    {
      nome: 'metade com 20 s',
      cfg: { ...DEFAULT_VIGIA, fracao: 0.5 },
      pt: 'Exemplo: numa call que chegou a 10 pessoas, o vigia sai quando restarem 5 ou menos, depois de 20 s confirmando. Se você ficar sozinho, sai na hora. Numa call que nunca passou de 3 pessoas, só sai quando você ficar sozinho.',
      en: 'Example: in a call that reached 10 people, auto-leave exits when 5 or fewer remain, after confirming for 20 s. If you are alone, it exits right away. In a call that never had more than 3 people, it only exits when you are alone.',
    },
    {
      nome: 'padrão do script (30%): o mínimo de 2 vale',
      cfg: DEFAULT_VIGIA,
      pt: 'Exemplo: numa call que chegou a 10 pessoas, o vigia sai quando restarem 3 ou menos, depois de 20 s confirmando. Se você ficar sozinho, sai na hora. Numa call que nunca passou de 3 pessoas, só sai quando você ficar sozinho.',
      en: 'Example: in a call that reached 10 people, auto-leave exits when 3 or fewer remain, after confirming for 20 s. If you are alone, it exits right away. In a call that never had more than 3 people, it only exits when you are alone.',
    },
    {
      nome: 'quantidade 3, na hora',
      cfg: { ...DEFAULT_VIGIA, modo: 'quantidade', quantidade: 3, confirmacoes: 1 },
      pt: 'Exemplo: numa call que chegou a 10 pessoas, o vigia sai quando restarem 3 ou menos, sem esperar. Se você ficar sozinho, sai na hora. Numa call que nunca passou de 3 pessoas, só sai quando você ficar sozinho.',
      en: 'Example: in a call that reached 10 people, auto-leave exits when 3 or fewer remain, without waiting. If you are alone, it exits right away. In a call that never had more than 3 people, it only exits when you are alone.',
    },
    {
      nome: 'quantidade 8: o exemplo usa uma call maior',
      cfg: { ...DEFAULT_VIGIA, modo: 'quantidade', quantidade: 8, confirmacoes: 6 },
      pt: 'Exemplo: numa call que chegou a 16 pessoas, o vigia sai quando restarem 8 ou menos, depois de 30 s confirmando. Se você ficar sozinho, sai na hora. Numa call que nunca passou de 8 pessoas, só sai quando você ficar sozinho.',
      en: 'Example: in a call that reached 16 people, auto-leave exits when 8 or fewer remain, after confirming for 30 s. If you are alone, it exits right away. In a call that never had more than 8 people, it only exits when you are alone.',
    },
    {
      nome: 'sozinho',
      cfg: { ...DEFAULT_VIGIA, modo: 'sozinho' },
      pt: 'Exemplo: numa call que chegou a 10 pessoas, o vigia espera todo mundo sair e sai na hora em que você ficar sozinho.',
      en: 'Example: in a call that reached 10 people, auto-leave waits for everyone else to go and exits as soon as you are alone.',
    },
    {
      nome: 'quantidade 1 é o mesmo que sozinho',
      cfg: { ...DEFAULT_VIGIA, modo: 'quantidade', quantidade: 1 },
      pt: 'Exemplo: numa call que chegou a 10 pessoas, o vigia espera todo mundo sair e sai na hora em que você ficar sozinho.',
      en: 'Example: in a call that reached 10 people, auto-leave waits for everyone else to go and exits as soon as you are alone.',
    },
  ]
  for (const c of casos) {
    it(c.nome, () => {
      expect(vigiaExample(c.cfg)).toBe(c.pt)
      useLocale('en')
      expect(vigiaExample(c.cfg)).toBe(c.en)
    })
  }
})
