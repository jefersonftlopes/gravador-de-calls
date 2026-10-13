// Partes puras da contagem e do diálogo do organizador do vigia (o DOM é coberto pelo ponta a
// ponta, tests/e2e/vigia*.spec.ts).
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  RE_NA_REUNIAO,
  RE_TEXTO_PAGINA,
  contagemAntiga,
  contagemDoPainel,
  contagemDoSelo,
  contagemDoTextoDaPagina,
  contagemDoTitulo,
  linhasDasSecoes,
} from './contagem'
import { RE_ENCERRAR, RE_SO_SAIR, escolherSoSair } from './dialogo'

describe('Teams: regex do script', () => {
  it('são as mesmas do script original, caractere por caractere', () => {
    const src = readFileSync(new URL('../../../docs/referencia/vigia-original.js', import.meta.url), 'utf8')
    expect(src).toContain(`const RE_NA_REUNIAO = ${RE_NA_REUNIAO.toString()};`)
    expect(src).toContain(`document.body.innerText.match(${RE_TEXTO_PAGINA.toString()})`)
    for (const sel of ['#hangup-button', '#microphone-button', '#call-duration-custom', '#roster-participants-search-input', '[id^="roster-title-section"]', '#roster-button']) {
      expect(src).toContain(sel)
    }
  })

  const titulos: Array<[string, number | null]> = [
    ['Nesta reunião (5) Nesta reunião', 5],
    ['In this meeting (12)', 12],
    ['Na reuniao (3)', 3],
    ['Em reunião: 7', 7],
    ['in the meeting  (1)', 1],
    ['Participantes', null],
    ['Convidados (4)', null],
  ]
  for (const [texto, n] of titulos) it(`título "${texto}" -> ${n}`, () => expect(contagemDoTitulo(texto)).toBe(n))

  it('reserva pelo texto da página só no começo de uma linha', () => {
    expect(contagemDoTextoDaPagina('Chat\nNesta reunião (4)\nFulano')).toBe(4)
    expect(contagemDoTextoDaPagina('Fulano disse: nesta reunião (4)')).toBeNull()
  })
})

describe('Meet: contagem', () => {
  const selos: Array<[string | null, number | null]> = [
    ['3', 3],
    ['1', 1],
    ['0', null],
    ['-2', null],
    ['2.5', null],
    ['', null],
    ['abc', null],
    [null, null],
  ]
  for (const [v, n] of selos) it(`data-avatar-count=${JSON.stringify(v)} -> ${n}`, () => expect(contagemDoSelo(v)).toBe(n))

  it('painel: nomes únicos, sem apresentação nem áudio mesclado', () => {
    expect(
      contagemDoPainel([
        { label: 'Alex Lima', text: 'Alex Lima\n(Você)' },
        { label: 'Ana Souza', text: 'Ana Souza' },
        { label: 'Ana Souza', text: 'Ana Souza\nApresentação' },
        { label: 'Apresentação', text: 'Apresentação' },
        { label: 'Presentation', text: 'Presentation' },
        { label: 'apresentação de Bruno', text: 'apresentação de Bruno' },
        { label: 'Bruno Lima', text: 'Bruno Lima' },
        { label: 'Áudio mesclado', text: 'Sala 3' },
        { label: 'Sala de reunião', text: 'Sala de reunião\nMerged audio' },
      ]),
    ).toBe(3)
  })

  it('painel vazio não conta (null, não zero)', () => {
    expect(contagemDoPainel([])).toBeNull()
    expect(contagemDoPainel([{ label: 'Apresentação', text: '' }])).toBeNull()
  })

  it('interface antiga', () => {
    expect(contagemAntiga('People - 4 joined')).toBe(4)
    expect(contagemAntiga('7')).toBe(7)
    expect(contagemAntiga('0')).toBeNull()
    expect(contagemAntiga('People')).toBeNull()
    expect(contagemAntiga(null)).toBeNull()
  })
})

describe('Meet: diálogo do organizador', () => {
  it('as listas são as da Emenda 3', () => {
    expect(RE_SO_SAIR.toString()).toBe('/^(just leave( the call)?|leave meeting|leave call|apenas sair( da chamada)?|sair da reuni[aã]o|sair da chamada)$/i')
    expect(RE_ENCERRAR.toString()).toBe('/everyone|for all|todos|encerrar|^end /i')
  })

  const casos: Array<{ nome: string; opcoes: Array<{ text: string; label: string }>; escolhe: number | null }> = [
    {
      nome: 'pt-BR: escolhe "Sair da reunião", mesmo depois de "Encerrar a reunião para todos"',
      opcoes: [
        { text: 'Encerrar a reunião para todos', label: '' },
        { text: 'Sair da reunião', label: '' },
      ],
      escolhe: 1,
    },
    {
      nome: 'en: "Just leave the call" e não "End the call for everyone"',
      opcoes: [
        { text: 'End the call for everyone', label: '' },
        { text: '  Just leave the call ', label: '' },
      ],
      escolhe: 1,
    },
    { nome: 'Google Help: "Leave meeting" e não "End meeting for all"', opcoes: [{ text: 'End meeting for all', label: '' }, { text: 'Leave meeting', label: '' }], escolhe: 1 },
    { nome: 'pelo aria-label quando o texto é só ícone', opcoes: [{ text: 'call_end', label: 'Apenas sair da chamada' }], escolhe: 0 },
    {
      nome: 'texto de sair com aria-label de encerrar para todos: não clica',
      opcoes: [
        { text: 'Sair da reunião', label: 'Encerrar a reunião para todos' },
        { text: 'Cancelar', label: '' },
      ],
      escolhe: null,
    },
    { nome: 'Pd96ce é só dica: com texto de encerrar, não clica', opcoes: [{ text: 'Encerrar para todos', label: '' }], escolhe: null },
    { nome: 'substring não vale ("Sair" sozinho, "Sair mesmo assim")', opcoes: [{ text: 'Sair', label: '' }, { text: 'Sair mesmo assim', label: '' }], escolhe: null },
    { nome: '"Sair da reunião para todos" não é a frase inteira da lista', opcoes: [{ text: 'Sair da reunião para todos', label: '' }], escolhe: null },
    { nome: '"End call" não é "leave call"', opcoes: [{ text: 'End call', label: '' }], escolhe: null },
    { nome: 'nenhuma opção', opcoes: [], escolhe: null },
  ]
  for (const c of casos) it(c.nome, () => expect(escolherSoSair(c.opcoes)).toBe(c.escolhe))
})

describe('Meet: seções do painel de pessoas (Emenda 10)', () => {
  it('sem seção conta tudo; uma seção só, ela; várias, só a da call pelo rótulo; sem achar, não conta', () => {
    expect(linhasDasSecoes([], ['a', 'b'])).toEqual(['a', 'b'])
    expect(linhasDasSecoes([{ label: 'In call', linhas: ['a'] }], ['a'])).toEqual(['a'])
    const secoes = [
      { label: 'Aguardando para participar', linhas: ['c', 'd'] },
      { label: 'Na chamada', linhas: ['a', 'b'] },
    ]
    expect(linhasDasSecoes(secoes, ['c', 'd', 'a', 'b'])).toEqual(['a', 'b'])
    expect(linhasDasSecoes([{ label: 'Waiting to be admitted', linhas: ['c'] }, { label: ' In call ', linhas: ['a'] }], [])).toEqual(['a'])
    expect(linhasDasSecoes([{ label: 'Esperando', linhas: ['c'] }, { label: 'Pessoas', linhas: ['a'] }], ['c', 'a'])).toBeNull()
  })
})
