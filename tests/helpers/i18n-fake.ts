// chrome.i18n falso para os testes de unidade (Emenda 15), com as mensagens de verdade de
// public/_locales. Segue o que o Chrome faz (medido no Chrome for Testing 151, 07/10/2026):
// $1..$9 trocados pelos valores, um valor que falta vira texto vazio, $$ vira $, os
// placeholders com nome ($NOME$) e chave inexistente devolve ''. A formatação é a de produção
// (`formatMessage`, src/shared/i18n.ts, Emenda 19): o idioma escolhido nas configurações usa a
// mesma função, então o fake e o idioma escolhido não têm como divergir.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { formatMessage, type MessageTable } from '../../src/shared/i18n'
import { ROOT } from './paths'

export type Locale = 'en' | 'pt_BR'

const cache = new Map<Locale, MessageTable>()

export function localeMessages(locale: Locale): MessageTable {
  let m = cache.get(locale)
  if (!m) {
    m = JSON.parse(readFileSync(join(ROOT, 'public', '_locales', locale, 'messages.json'), 'utf8')) as MessageTable
    cache.set(locale, m)
  }
  return m
}

export function fakeGetMessage(locale: Locale) {
  return (key: string, subs?: string | string[]): string => formatMessage(localeMessages(locale)[key], subs)
}

export function fakeI18n(locale: Locale) {
  return {
    getMessage: fakeGetMessage(locale),
    getUILanguage: () => (locale === 'pt_BR' ? 'pt-BR' : 'en-US'),
  }
}
