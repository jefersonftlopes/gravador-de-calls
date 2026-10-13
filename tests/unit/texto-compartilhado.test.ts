// host/texto.mjs: o texto da transcrição que o helper E a extensão usam iguais (Emenda 21).
//
// O que este arquivo protege:
// - nada de node:*, DOM nem chrome.* no arquivo compartilhado (senão o Vite não o importa, e foi
//   justamente por isso que host/transcricao.mjs não podia ser importado pela extensão);
// - o helper não tem uma segunda cópia das regras: host/transcricao.mjs importa e reexporta;
// - os dois lados veem exatamente as mesmas funções (o mesmo objeto, não uma cópia igual);
// - 'texto.mjs' está em HOST_FILES, senão a cópia instalada do helper não sobe.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error módulo .mjs sem tipos
import { HOST_DIR, HOST_FILES } from '../../host/args.mjs'
import * as texto from '../../host/texto.mjs'
// @ts-expect-error módulo .mjs sem tipos
import * as helper from '../../host/transcricao.mjs'

const source = readFileSync(join(HOST_DIR, 'texto.mjs'), 'utf8')
/** O código sem os comentários (que falam de node:* e de chrome.* justamente para proibi-los). */
const code = source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, '')

/** As funções e constantes que os dois lados compartilham (o contrato da Emenda 21). */
const SHARED = [
  'ENGINE_LABELS',
  'LANGUAGE_RE',
  'MARKDOWN_LABELS',
  'MODEL_PREFERENCE',
  'NEIGHBOR_GAP_SEC',
  'ORPHAN_GRACE_MS',
  'PARAGRAPH',
  'REPEATS',
  'SPEAKERS_FILE',
  'UNNAMED_SHADOW',
  'assignSpeakers',
  'buildMarkdown',
  'buildSrt',
  'checkUnnamedSources',
  'cleanSpeakerName',
  'collapseInside',
  'collapseRepeats',
  'dropInventedSegments',
  'errorLine',
  'fillSpeakerGaps',
  'formatClock',
  'formatDuration',
  'formatLocalStart',
  'formatSrtTime',
  'isObj',
  'markdownLanguage',
  'mdLine',
  'mdName',
  'mergeSegments',
  'pausedBetween',
  'platformLabel',
  'rankModel',
  'reconcileTranscription',
  'segmentsFromWhisperJson',
  'selfLines',
  'silencesFromFfmpeg',
  'speakerTimelineFrom',
  'speechText',
  'srtName',
  'transcriptStem',
  'transcriptionsOf',
] as const

describe('texto compartilhado (Emenda 21)', () => {
  it('não importa node:*, DOM nem chrome.* (é o que o Vite consegue incluir no bundle)', () => {
    expect(code).not.toMatch(/from '(node:|fs|path|os|child_process)/)
    expect(code).not.toMatch(/\brequire\(/)
    expect(code).not.toMatch(/\bchrome\./)
    // `window` sozinho existe como campo do REPEATS; o que não pode é o objeto global.
    expect(code).not.toMatch(/(^|[^.\w])(document|window|self|globalThis|indexedDB|localStorage)\./)
    expect(code).not.toMatch(/\bprocess\./)
  })

  it('o helper reexporta as funções do arquivo compartilhado, sem uma segunda cópia', () => {
    for (const name of SHARED) {
      expect(texto, name).toHaveProperty(name)
      // Mesma identidade: se o helper tivesse a cópia dele, estes seriam objetos diferentes.
      expect((helper as Record<string, unknown>)[name], name).toBe((texto as Record<string, unknown>)[name])
    }
  })

  it('o helper não redeclara nenhuma das regras compartilhadas', () => {
    const transcricao = readFileSync(join(HOST_DIR, 'transcricao.mjs'), 'utf8')
    // Depois do bloco de reexportação, nada de `export const X =` / `export function X(` repetido.
    for (const name of SHARED) {
      expect(transcricao, name).not.toMatch(new RegExp(`^export (const|function|async function) ${name}\\b`, 'm'))
      expect(transcricao, name).not.toMatch(new RegExp(`^(const|function|async function) ${name}\\b`, 'm'))
    }
  })

  it('texto.mjs é copiado na instalação do helper', () => {
    expect(HOST_FILES).toContain('texto.mjs')
  })

  it('as regras compartilhadas funcionam chamadas direto do arquivo novo', () => {
    expect(texto.formatClock(3725, true)).toBe('1:02:05')
    expect(texto.transcriptStem('audio-aba.webm')).toBe('transcricao-aba')
    expect(texto.markdownLanguage({ idiomaInterface: 'en' })).toBe('en')
    expect(texto.ENGINE_LABELS['whisper-cpp']).toBe('whisper.cpp (local)')
    // O motor por API tem rótulo próprio, para o cabeçalho do transcricao.md dizer quem transcreveu.
    expect(texto.ENGINE_LABELS['openai-api']).toBeTruthy()
  })
})
