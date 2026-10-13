// O prompt da instalação do motor local em três destinos (Emenda 22): a tela da extensão (que o lê
// direto de src/shared/instalar-local.ts), docs/PROMPT-INSTALAR.md e a seção do site, nas duas
// línguas. Os três nascem do MESMO array de passos, e este teste é o portão: mudar um passo no
// código e esquecer o documento ou o site deixa a suíte vermelha.
//
// Gerar de novo: `npm run prompt` (este mesmo arquivo com ATUALIZAR_PROMPT=1 escreve os três).
// O passo a passo visível na tela é conferido por src/shared/instalar-local.test.ts e pelo
// ponta a ponta tests/e2e/motor-passo-a-passo.spec.ts.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MESSAGE_LOCALES, type MessageLocale } from '../../src/shared/i18n'
import { installPrompt } from '../../src/shared/instalar-local'
import { ROOT } from '../helpers/paths'

/** Escreve os arquivos em vez de só conferir (`npm run prompt`). */
const ATUALIZAR = !!process.env.ATUALIZAR_PROMPT

const DOC = 'docs/PROMPT-INSTALAR.md'
const INICIO = '<!--prompt-instalar:inicio-->'
const FIM = '<!--prompt-instalar:fim-->'

/** A página do site de cada língua, com a seção do prompt entre as marcas. */
const PAGES: Record<MessageLocale, string> = { pt_BR: 'site/index.html', en: 'site/en/index.html' }

/** Cabeçalho de cada língua dentro do documento (o idioma do prompt é o da seção). */
const DOC_HEADINGS: Record<MessageLocale, string> = { pt_BR: 'Português (Brasil)', en: 'English' }

/**
 * Ordem das seções no documento, declarada aqui: o português primeiro, como o texto em volta dele.
 * `MESSAGE_LOCALES` sai da tabela das mensagens e começa pelo `en` (o padrão do manifesto), que não
 * é a ordem que um documento escrito em português quer.
 */
const DOC_ORDER: readonly MessageLocale[] = ['pt_BR', 'en']

/** O documento inteiro, montado a partir dos passos do código. */
function docText(): string {
  const out = [
    '# Prompt para instalar a transcrição local',
    '',
    '<!-- Gerado por `npm run prompt` a partir de src/shared/instalar-local.ts. Não edite à mão: o',
    '     teste tests/unit/prompt-instalar.test.ts falha quando este arquivo sai de sincronia com os',
    '     passos do código. -->',
    '',
    'Transcrever no próprio computador exige o whisper.cpp, o ffmpeg e um modelo de reconhecimento de',
    'fala. A extensão mostra este mesmo passo a passo em Configurações, na seção Transcrição, dentro do',
    'acordeão da opção "O seu computador". Copie o bloco da sua língua e cole no Claude Code.',
    '',
  ]
  for (const locale of DOC_ORDER) {
    out.push(`## ${DOC_HEADINGS[locale]}`, '', '```text', installPrompt(locale).trimEnd(), '```', '')
  }
  return `${out.join('\n').trimEnd()}\n`
}

/** O prompt como texto dentro de um `<pre>` do site. */
function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Troca o que está entre as marcas na página do site. */
function withBlock(html: string, block: string, file: string): string {
  const from = html.indexOf(INICIO)
  const to = html.indexOf(FIM)
  if (from < 0 || to < from) throw new Error(`marcas do prompt não achadas em ${file}`)
  return html.slice(0, from + INICIO.length) + block + html.slice(to)
}

/** O que está entre as marcas na página do site. */
function blockOf(html: string, file: string): string {
  const from = html.indexOf(INICIO)
  const to = html.indexOf(FIM)
  if (from < 0 || to < from) throw new Error(`marcas do prompt não achadas em ${file}`)
  return html.slice(from + INICIO.length, to)
}

if (ATUALIZAR) {
  writeFileSync(join(ROOT, DOC), docText())
  for (const locale of DOC_ORDER) {
    const file = PAGES[locale]
    const path = join(ROOT, file)
    writeFileSync(path, withBlock(readFileSync(path, 'utf8'), escapeHtml(installPrompt(locale).trimEnd()), file))
  }
}

describe('docs/PROMPT-INSTALAR.md', () => {
  it('é exatamente o que os passos do código geram (rode npm run prompt para atualizar)', () => {
    expect(readFileSync(join(ROOT, DOC), 'utf8')).toBe(docText())
  })

  it('traz o prompt das duas línguas, cada um no seu bloco, o português primeiro', () => {
    const text = readFileSync(join(ROOT, DOC), 'utf8')
    for (const locale of MESSAGE_LOCALES) {
      expect(text, locale).toContain(`## ${DOC_HEADINGS[locale]}`)
      expect(text, locale).toContain(installPrompt(locale).trimEnd())
    }
    // Um bloco aberto por língua e um fechado: o prompt não pode ter cerca de código dentro.
    expect(text.split('```').length - 1).toBe(DOC_ORDER.length * 2)
    // A ordem dos blocos é a que a spec de ponta a ponta lê para achar o prompt de cada língua.
    expect([...text.matchAll(/```text\n([\s\S]*?)\n```/g)].map((m) => `${m[1]}\n`)).toEqual(DOC_ORDER.map((l) => installPrompt(l)))
  })
})

describe('seção do site', () => {
  for (const locale of MESSAGE_LOCALES) {
    it(`${PAGES[locale]} traz o prompt em ${locale}, escapado para HTML`, () => {
      const file = PAGES[locale]
      const html = readFileSync(join(ROOT, file), 'utf8')
      expect(blockOf(html, file)).toBe(escapeHtml(installPrompt(locale).trimEnd()))
      // A seção existe de verdade: o bloco está dentro de um <pre> e o link do projeto está ao lado.
      expect(html).toContain('<pre class="prompt">')
      expect(html).toContain('github.com/jefersonftlopes/gravador-de-calls')
    })
  }

  it('o prompt do site e o do documento são o mesmo texto', () => {
    for (const locale of MESSAGE_LOCALES) {
      const html = readFileSync(join(ROOT, PAGES[locale]), 'utf8')
      const doSite = blockOf(html, PAGES[locale])
      expect(doSite).toBe(escapeHtml(installPrompt(locale).trimEnd()))
      expect(readFileSync(join(ROOT, DOC), 'utf8')).toContain(installPrompt(locale).trimEnd())
    }
  })
})
