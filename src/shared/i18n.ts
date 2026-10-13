// Tradução da interface (Emenda 15) com o idioma escolhido nas configurações (Emenda 19).
//
// - As mensagens ficam em public/_locales/<idioma>/messages.json (en é o padrão do manifesto,
//   pt_BR a tradução). Com o idioma `auto` (o padrão), quem escolhe o arquivo é o Chrome, pelo
//   idioma da interface do navegador, e o texto vem do chrome.i18n.getMessage, como antes da 0.4.1.
// - Com `pt_BR` ou `en` escolhidos, o texto sai das mesmas mensagens, embutidas no bundle e
//   formatadas aqui por `formatMessage`, com a semântica do chrome.i18n medida no Chrome for
//   Testing 151 (o chrome.i18n não deixa trocar o idioma em tempo de execução).
// - `t(chave, ...valores)`: os valores entram no lugar de $1, $2... da mensagem.
// - `tp(base, n, ...valores)`: plural. Usa `<base>_one` ou `<base>_other` pela regra do idioma
//   da mensagem (Intl.PluralRules com o `localeTag`), e `n` é sempre o $1.
// - A chave tem tipo: uma chave que não existe no en não compila, e o teste
//   src/shared/i18n.test.ts confere que as duas línguas têm as mesmas chaves e que toda chave
//   usada no código existe.
// - Idioma: `initLanguage()` lê o `settings.language` do chrome.storage.local uma vez e passa a
//   ouvir as mudanças; `onLanguageChange` avisa quem precisa redesenhar (as páginas pelo
//   useLanguage, o SW reaplica os títulos do ícone, o vigia reescreve o indicador). Este arquivo não
//   importa o zod nem o React: o content script do vigia e o SW o usam.
import en from '../../public/_locales/en/messages.json'
import ptBR from '../../public/_locales/pt_BR/messages.json'
import { SETTINGS_KEY, UI_LANGUAGES } from './constants'
import type { UiLanguage } from './protocol'

export type { UiLanguage } from './protocol'
export type MessageKey = keyof typeof en
type PluralBase<K> = K extends `${infer B}_one` ? (`${B}_other` extends MessageKey ? B : never) : never
/** Mensagens com plural: existem `<base>_one` e `<base>_other`. */
export type PluralKey = PluralBase<MessageKey>
export type Substitution = string | number
/** Idioma de um messages.json embutido (o nome da pasta em public/_locales). */
export type MessageLocale = Exclude<UiLanguage, 'auto'>

/** Uma entrada do messages.json (o formato do Chrome). */
export interface MessageEntry {
  message: string
  placeholders?: Record<string, { content: string }>
}
export type MessageTable = Record<string, MessageEntry>

const TABLES: Record<MessageLocale, MessageTable> = { en, pt_BR: ptBR }
export const MESSAGE_LOCALES = Object.keys(TABLES) as MessageLocale[]
/** Todas as chaves das mensagens (as do en, o padrão do manifesto; o pt_BR tem as mesmas). */
export const MESSAGE_KEYS = Object.keys(en) as MessageKey[]

/**
 * A mensagem com os valores, como o chrome.i18n.getMessage faz (medido no Chrome for Testing 151,
 * 07/10/2026): os placeholders com nome ($NOME$, sem diferenciar maiúsculas) viram o `content`
 * deles; depois $1..$9 viram os valores, um valor que falta vira texto vazio e $$ vira $. Sem a
 * mensagem, ''. O chrome.i18n falso dos testes (tests/helpers/i18n-fake.ts) usa esta função.
 */
export function formatMessage(entry: MessageEntry | undefined, subs?: string | readonly string[]): string {
  if (!entry || typeof entry.message !== 'string') return ''
  const values = subs === undefined ? [] : typeof subs === 'string' ? [subs] : subs
  return withPlaceholders(entry).replace(VALUE_RE, (_w, d: string) => (d === '$' ? '$' : (values[Number(d) - 1] ?? '')))
}

/** $1..$9 e $$ depois dos placeholders com nome (a mesma leitura no formatador e no reconhecedor). */
const VALUE_RE = /\$(\$|[1-9])/g

/** A mensagem com os placeholders com nome ($NOME$) trocados pelo `content` deles. */
function withPlaceholders(entry: MessageEntry): string {
  const placeholders = new Map(Object.entries(entry.placeholders ?? {}).map(([k, v]) => [k.toLowerCase(), v]))
  return entry.message.replace(/\$([A-Za-z0-9_@]+)\$/g, (whole, name: string) => placeholders.get(name.toLowerCase())?.content ?? whole)
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

interface MessagePattern {
  re: RegExp
  /** O número ($n) de cada grupo da expressão, na ordem. */
  slots: number[]
}

const patterns = new Map<string, MessagePattern | null>()

/**
 * A expressão que reconhece a mensagem já formatada: o texto fixo literal e cada $n um grupo (um
 * $n repetido tem de repetir o mesmo valor). Sem texto fixo, null: qualquer texto passaria.
 */
function messagePattern(locale: MessageLocale, key: MessageKey): MessagePattern | null {
  const id = `${locale}:${key}`
  const cached = patterns.get(id)
  if (cached !== undefined) return cached
  const entry = TABLES[locale][key]
  let pattern: MessagePattern | null = null
  if (entry && typeof entry.message === 'string') {
    const text = withPlaceholders(entry)
    const slots: number[] = []
    let source = ''
    let literal = ''
    let last = 0
    for (const m of text.matchAll(VALUE_RE)) {
      const fixed = text.slice(last, m.index) + (m[1] === '$' ? '$' : '')
      literal += fixed
      source += escapeRe(fixed)
      if (m[1] !== '$') {
        const n = Number(m[1])
        const seen = slots.indexOf(n)
        if (seen >= 0) source += `\\${seen + 1}`
        else {
          slots.push(n)
          source += '([\\s\\S]*?)'
        }
      }
      last = m.index + m[0].length
    }
    const tail = text.slice(last)
    literal += tail
    if (literal.trim()) pattern = { re: new RegExp(`^${source}${escapeRe(tail)}$`), slots }
  }
  patterns.set(id, pattern)
  return pattern
}

/**
 * Reconhece um texto que já saiu de uma destas mensagens, em qualquer das línguas embutidas
 * (Emenda 19): a chave e os valores ($1, $2...). O SW guarda alguns motivos já traduzidos (o status
 * do helper, o erro de uma gravação não salva); a tela os reconhece e os mostra no idioma que vale
 * agora. Formatar de novo na mesma língua dá o mesmo texto. Sem nenhuma, null.
 */
export function recognizeMessage(text: string, keys: readonly MessageKey[]): { key: MessageKey; subs: string[] } | null {
  for (const locale of MESSAGE_LOCALES) {
    for (const key of keys) {
      const pattern = messagePattern(locale, key)
      const m = pattern?.re.exec(text)
      if (!pattern || !m) continue
      const count = Math.max(0, ...pattern.slots)
      const subs = Array.from({ length: count }, (_v, i) => {
        const group = pattern.slots.indexOf(i + 1)
        return group >= 0 ? m[group + 1] : ''
      })
      return { key, subs }
    }
  }
  return null
}

type GetMessage = (key: string, subs?: string | string[]) => string

function chromeGetMessage(): GetMessage | null {
  const i18n = (globalThis as { chrome?: { i18n?: { getMessage?: GetMessage } } }).chrome?.i18n
  return typeof i18n?.getMessage === 'function' ? i18n.getMessage.bind(i18n) : null
}

/** A mensagem pelo chrome.i18n (o idioma do Chrome), sem trocar a chave quando falta. */
function chromeMessage(key: string, subs: string[]): string {
  const get = chromeGetMessage()
  return get ? get(key, subs) : ''
}

// ---------------------------------------------------------------------------------------------
// Idioma escolhido
// ---------------------------------------------------------------------------------------------

let language: UiLanguage = 'auto'
const listeners = new Set<(language: UiLanguage) => void>()

/** O idioma escolhido nas configurações (`auto` até `initLanguage` ler, e fora da extensão). */
export function uiLanguage(): UiLanguage {
  return language
}

/** O `language` de uma configuração guardada, sem zod; ausente ou desconhecido vira `auto`. */
export function languageOf(settings: unknown): UiLanguage {
  const v = settings && typeof settings === 'object' ? (settings as { language?: unknown }).language : undefined
  return typeof v === 'string' && (UI_LANGUAGES as readonly string[]).includes(v) ? (v as UiLanguage) : 'auto'
}

/** Troca o idioma deste contexto e avisa quem ouve (nada acontece se for o mesmo). */
export function setLanguage(next: UiLanguage): void {
  if (next === language) return
  language = next
  for (const cb of [...listeners]) {
    try {
      cb(next)
    } catch (e) {
      console.debug('[gravador i18n] ouvinte do idioma falhou', e)
    }
  }
}

/** Chama `cb` a cada troca de idioma deste contexto. Devolve a função que para de ouvir. */
export function onLanguageChange(cb: (language: UiLanguage) => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

/** Espera máxima pela leitura do storage: um storage que não responde não segura texto nenhum. */
const INIT_TIMEOUT_MS = 2000

let ready: Promise<UiLanguage> | null = null

/**
 * Lê o idioma guardado e passa a ouvir as mudanças (uma vez por contexto; as próximas chamadas
 * devolvem a mesma promessa). O ouvinte entra antes da leitura e na mesma volta do laço: no SW,
 * é ele que recebe o storage.onChanged que acordou o SW, e uma mudança que chegue antes da
 * leitura vale mais que ela. Nunca rejeita: sem storage (fora da extensão), fica em `auto`.
 */
export function initLanguage(): Promise<UiLanguage> {
  if (ready) return ready
  const storage = (globalThis as { chrome?: { storage?: typeof chrome.storage } }).chrome?.storage
  if (!storage?.local?.get || !storage.onChanged?.addListener) return (ready = Promise.resolve(language))
  let changed = false
  storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !(SETTINGS_KEY in changes)) return
    changed = true
    setLanguage(languageOf(changes[SETTINGS_KEY].newValue))
  })
  const read = Promise.resolve()
    .then(() => storage.local.get(SETTINGS_KEY))
    .then(
      (got) => {
        if (!changed) setLanguage(languageOf(got?.[SETTINGS_KEY]))
        return language
      },
      () => language,
    )
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<UiLanguage>((resolve) => {
    timer = setTimeout(() => resolve(language), INIT_TIMEOUT_MS)
  })
  ready = Promise.race([read.finally(() => clearTimeout(timer)), timeout])
  return ready
}

/**
 * Resolve quando o idioma guardado já vale neste contexto. O SW espera por ela antes de criar um
 * texto visível (título do ícone, notificação, resposta às telas, arquivos da gravação): o evento
 * que acordou o SW pode chegar antes da leitura do storage. Sem `initLanguage`, resolve na hora.
 */
export function languageReady(): Promise<UiLanguage> {
  return ready ?? Promise.resolve(language)
}

// ---------------------------------------------------------------------------------------------
// Mensagens
// ---------------------------------------------------------------------------------------------

/** A mensagem num idioma embutido, sem olhar o escolhido (o SW reconhece os títulos dos dois). */
export function tIn(locale: MessageLocale, key: MessageKey, ...subs: Substitution[]): string {
  return formatMessage(TABLES[locale][key], subs.map(String)) || key
}

/** Mensagem traduzida. Sem a mensagem (ou fora da extensão), devolve a própria chave. */
export function t(key: MessageKey, ...subs: Substitution[]): string {
  const values = subs.map(String)
  const text = language === 'auto' ? chromeMessage(key, values) : formatMessage(TABLES[language][key], values)
  return text || key
}

/** Idioma da mensagem que vale ("en" ou "pt-BR"): a escolhida, ou a que o Chrome escolheu. */
export function messageLocale(): string {
  const tag = t('localeTag')
  return tag === 'localeTag' ? 'en' : tag
}

/** Plural pela regra do idioma das mensagens: `n` vai como $1, os outros valores depois. */
export function tp(base: PluralKey, n: number, ...subs: Substitution[]): string {
  let one = n === 1
  try {
    one = new Intl.PluralRules(messageLocale()).select(n) === 'one'
  } catch {
    // Intl sem o idioma: fica a regra do inglês
  }
  return t(`${base}_${one ? 'one' : 'other'}` as MessageKey, n, ...subs)
}

/**
 * Nome da pasta dentro de Downloads (reserva sem o helper). Segue o idioma do Chrome, nunca o
 * escolhido (Emenda 19): trocar o idioma da extensão não divide as gravações em duas pastas.
 */
export function downloadsFolderName(): string {
  return chromeMessage('downloadsFolderName', []) || 'downloadsFolderName'
}
