// Setup do vitest (vitest.config.ts): `chrome.i18n` falso em português (o idioma em que os
// testes antigos conferem os textos). Os testes que montam um `chrome` falso inteiro
// (`globalThis.chrome = {...}`) ganham o i18n junto, porque a atribuição passa por aqui.
// `useLocale('en')` troca o idioma até o fim do arquivo de teste.
import { fakeI18n, type Locale } from './i18n-fake'

let locale: Locale = 'pt_BR'
let current: Record<string, unknown> | undefined

const withI18n = (v: unknown) => {
  if (v && typeof v === 'object' && !('i18n' in v)) (v as Record<string, unknown>).i18n = fakeI18n(locale)
  return v as Record<string, unknown> | undefined
}

Object.defineProperty(globalThis, 'chrome', {
  configurable: true,
  get: () => current,
  set: (v: unknown) => {
    current = withI18n(v)
  },
})
current = withI18n({})

/** Idioma das mensagens nos testes deste arquivo. */
export function useLocale(next: Locale): void {
  locale = next
  if (current) current.i18n = fakeI18n(next)
}
