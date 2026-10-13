// Fonte da contagem do vigia e o indicador na página no idioma da interface (Emenda 15): o dado
// (protocolo e log) continua em português; a tela traduz.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { useLocale } from '../../tests/helpers/i18n-setup'
import { ROOT } from '../../tests/helpers/paths'
import {
  FONTE_BOTAO_PESSOAS,
  FONTE_BOTAO_PESSOAS_ANTIGO,
  FONTE_PAINEL_PEOPLE,
  FONTE_PAINEL_PESSOAS,
  FONTE_TEXTO_DA_PAGINA,
  vigiaSourceLabel,
} from './vigia-source'

afterEach(() => useLocale('pt_BR'))

const FONTES = [FONTE_PAINEL_PEOPLE, FONTE_TEXTO_DA_PAGINA, FONTE_BOTAO_PESSOAS, FONTE_PAINEL_PESSOAS, FONTE_BOTAO_PESSOAS_ANTIGO]

describe('vigiaSourceLabel', () => {
  it('em português, o rótulo é o próprio dado', () => {
    for (const f of FONTES) expect(vigiaSourceLabel(f)).toBe(f)
  })

  it('em inglês, cada fonte conhecida é traduzida', () => {
    useLocale('en')
    expect(FONTES.map(vigiaSourceLabel)).toEqual(['People panel', 'page text', 'people button', 'people panel', 'people button (old interface)'])
  })

  it('uma fonte desconhecida aparece como veio', () => {
    useLocale('en')
    expect(vigiaSourceLabel('outra fonte')).toBe('outra fonte')
  })
})

describe('indicador do vigia na página', () => {
  it('todo texto mostrado passa por t() (nenhum literal no mostrar)', () => {
    const src = readFileSync(join(ROOT, 'src', 'content', 'vigia', 'vigia.ts'), 'utf8')
    expect(src.match(/this\.mostrar\(/g)?.length).toBeGreaterThanOrEqual(6)
    // Emenda 19: o mostrar recebe uma função (o indicador é reescrito na troca de idioma), nunca um
    // texto pronto. Um template só vale começando por um valor (`${t(...)}...`), nunca por texto.
    expect(src.match(/this\.mostrar\(\s*(['"`]|t\()/g)).toBeNull()
    expect(src.match(/this\.mostrar\(\s*\(\)\s*=>\s*(['"]|`(?!\$\{))/g)).toBeNull()
    // A fonte vai pelo rótulo traduzido, não crua.
    expect(src).toMatch(/t\('vigiaVia', vigiaSourceLabel\(\w+\)\)/)
  })

  it('a camada de DOM só escreve as fontes que a tradução conhece', () => {
    const src = readFileSync(join(ROOT, 'src', 'content', 'vigia', 'contagem.ts'), 'utf8')
    expect(src.match(/fonte: '[^']/g)).toBeNull()
  })
})
