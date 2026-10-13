// Motivos do offscreen traduzidos no SW (Emenda 15). Os textos saem do próprio código do
// offscreen (todo `error: '...'` e `error: \`...\`` de tab.ts e blob.ts), então um motivo novo
// sem tradução faz este teste falhar.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { useLocale } from '../../tests/helpers/i18n-setup'
import { ROOT } from '../../tests/helpers/paths'
import { offscreenReason } from './offscreen-reasons'

afterEach(() => useLocale('pt_BR'))

/** Os motivos literais do offscreen, com cada `${...}` trocado por um valor de exemplo. */
function offscreenTexts(): string[] {
  const out: string[] = []
  for (const file of ['tab.ts', 'blob.ts']) {
    const src = readFileSync(join(ROOT, 'src', 'offscreen', file), 'utf8')
    for (const m of src.matchAll(/error: (?:'([^']+)'|`([^`]+)`)/g)) out.push((m[1] ?? m[2]).replace(/\$\{[^}]+\}/g, 'abc-123'))
  }
  return out
}

describe('offscreenReason', () => {
  it('o offscreen tem os motivos esperados', () => {
    expect(offscreenTexts().length).toBeGreaterThanOrEqual(7)
  })

  it('em português, cada motivo sai igual ao texto do offscreen', () => {
    for (const text of offscreenTexts()) expect(offscreenReason(text)).toBe(text)
  })

  it('em inglês, todo motivo é traduzido, com os valores inteiros', () => {
    useLocale('en')
    for (const text of offscreenTexts()) {
      const out = offscreenReason(text)
      expect(out, text).not.toBe(text)
      expect(out, text).not.toMatch(/ã|á|ç|é|ê|í|ó|õ|ú| da | sem | não /)
    }
    expect(offscreenReason('getUserMedia da aba: NotAllowedError: x')).toBe('tab getUserMedia: NotAllowedError: x')
    expect(offscreenReason('sessão 20261006-1 sem chunks no IndexedDB')).toBe('session 20261006-1 has no chunks in IndexedDB')
  })

  it('motivo desconhecido (erro cru do navegador) aparece como veio', () => {
    useLocale('en')
    expect(offscreenReason('AbortError: The operation was aborted.')).toBe('AbortError: The operation was aborted.')
    expect(offscreenReason(undefined)).toBe('')
  })
})
