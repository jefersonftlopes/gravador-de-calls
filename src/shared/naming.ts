// Nomes de pasta e de sessão (docs/ARQUITETURA.md, "Nomes").
//
// Pasta da call: `[<perfil>/]<AAAA-MM>/<AAAA-MM-DD HHhMM> - <título> (<Meet|Teams>)`, com hora
// local. O nível do perfil só existe quando o perfil tem nome (Emenda 1).
// O saneamento segue as regras de componente de caminho do Chromium (IsSafePortablePathComponent),
// que valem também para o modo downloads: assim o mesmo nome serve para os dois destinos.
//
// Emenda 15: as palavras do nome ("Sem título", "Outro site") seguem o idioma da interface, como a
// pasta em Downloads; Meet e Teams são nomes próprios. Em português o nome não muda.
import { format } from 'date-fns'
import { t } from './i18n'
import type { RecordingPlatform } from './protocol'

/** Limite de bytes UTF-8 por componente de caminho (o APFS aceita 255; deixamos folga). */
export const MAX_COMPONENT_BYTES = 120

/** "Sem título" (ou "Untitled"), no idioma da interface. */
export function untitled(): string {
  return t('untitled')
}

/** `outro`: modo aba numa aba fora dos hosts das calls (Emenda 7). */
export function platformLabel(platform: RecordingPlatform): string {
  return platform === 'meet' ? 'Meet' : platform === 'teams' ? 'Teams' : t('platformOther')
}

// Caracteres proibidos em qualquer componente pelo Chromium, em qualquer sistema:
// `" * / : < > ? \ |`. Cada um tem um substituto legível (ver cleanChars).
const CLOCK = /(\d{1,2}):(\d{2})/g
const COLON = /\s*:\s*/g
const SLASHES = /[/\\|]/g
const DROPPED = /[*<>?]/g
// Controle (Cc), formatação (Cf, inclui os joiners de emoji), separadores de linha e parágrafo.
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu
// Não caracteres do Unicode: U+FDD0..U+FDEF e os dois últimos de cada plano.
const NONCHAR = /[\u{FDD0}-\u{FDEF}\u{FFFE}\u{FFFF}\u{1FFFE}\u{1FFFF}\u{2FFFE}\u{2FFFF}\u{3FFFE}\u{3FFFF}\u{4FFFE}\u{4FFFF}\u{5FFFE}\u{5FFFF}\u{6FFFE}\u{6FFFF}\u{7FFFE}\u{7FFFF}\u{8FFFE}\u{8FFFF}\u{9FFFE}\u{9FFFF}\u{AFFFE}\u{AFFFF}\u{BFFFE}\u{BFFFF}\u{CFFFE}\u{CFFFF}\u{DFFFE}\u{DFFFF}\u{EFFFE}\u{EFFFF}\u{FFFFE}\u{FFFFF}\u{10FFFE}\u{10FFFF}]/gu
// Pontas que o Chromium rejeita: espaço, ponto e til.
const EDGES = /^[\s.~]+|[\s.~]+$/gu
// Nomes reservados do Windows (com ou sem extensão), rejeitados pelo Chromium até no macOS.
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9]|clock\$|conin\$|conout\$)(\..*)?$/i
const RESERVED_FILES = /^(desktop\.ini|thumbs\.db)$/i
// Extensões que o Chromium trata como perigosas no fim do nome.
const DANGEROUS_EXT = /\.(lnk|local|scf|url)$/i

const encoder = new TextEncoder()

export function utf8Bytes(s: string): number {
  return encoder.encode(s).length
}

/** Corta `s` para caber em `maxBytes` UTF-8 sem partir um grafema (emoji, acento combinado). */
export function truncateBytes(s: string, maxBytes: number): string {
  if (utf8Bytes(s) <= maxBytes) return s
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  let out = ''
  let used = 0
  for (const { segment } of segmenter.segment(s)) {
    const b = utf8Bytes(segment)
    if (used + b > maxBytes) break
    out += segment
    used += b
  }
  return out
}

/** Limpa caracteres e espaços, sem tratar pontas nem tamanho. */
function cleanChars(s: string): string {
  return s
    .normalize('NFC')
    .replace(INVISIBLE, ' ')
    .replace(NONCHAR, '')
    .replace(CLOCK, '$1h$2')
    .replace(COLON, ' - ')
    .replace(SLASHES, '-')
    .replace(/"/g, "'")
    .replace(DROPPED, '')
    .replace(/\s+/gu, ' ')
}

function trimEdges(s: string): string {
  let prev: string
  let out = s
  do {
    prev = out
    out = out.replace(EDGES, '')
  } while (out !== prev)
  return out
}

/**
 * Saneia um componente de caminho (um nome de pasta ou arquivo, sem `/`).
 * Devolve string vazia quando nada sobra; quem chama decide o substituto.
 */
export function sanitizeComponent(input: string, maxBytes = MAX_COMPONENT_BYTES): string {
  let s = trimEdges(cleanChars(input))
  s = trimEdges(truncateBytes(s, maxBytes))
  if (RESERVED.test(s) || RESERVED_FILES.test(s)) s = truncateBytes(`_${s}`, maxBytes)
  if (DANGEROUS_EXT.test(s)) s = `${s.slice(0, -1)}_`
  return s
}

export interface FolderInput {
  /** Início da gravação (hora local da máquina). */
  startedAt: Date | number
  title: string | null | undefined
  /** Código da reunião, usado quando não há título. */
  code?: string | null
  platform: RecordingPlatform
  /** Nome do perfil do Chrome ("Trabalho"); vazio ou ausente: sem esse nível. */
  profileLabel?: string | null
}

/** O título saneado, senão o código, senão vazio (quem mostra põe o "Sem título" do idioma que vale). */
export function cleanTitle(title: string | null | undefined, code?: string | null): string {
  for (const candidate of [title, code]) {
    const clean = trimEdges(cleanChars(candidate ?? ''))
    if (clean) return clean
  }
  return ''
}

/** Título que vai no nome: o título saneado, senão o código, senão "Sem título". */
export function displayTitle(title: string | null | undefined, code?: string | null): string {
  return cleanTitle(title, code) || untitled()
}

/** `AAAA-MM` do mês da gravação. */
export function monthFolder(startedAt: Date | number): string {
  return format(startedAt, 'yyyy-MM')
}

/** `AAAA-MM-DD HHhMM - <título> (<Meet|Teams>)`, saneado e dentro do limite de bytes. */
export function callFolderName(input: FolderInput): string {
  const prefix = `${format(input.startedAt, "yyyy-MM-dd HH'h'mm")} - `
  const suffix = ` (${platformLabel(input.platform)})`
  const budget = MAX_COMPONENT_BYTES - utf8Bytes(prefix) - utf8Bytes(suffix)
  let title = trimEdges(truncateBytes(displayTitle(input.title, input.code), budget))
  if (!title) title = untitled()
  return sanitizeComponent(`${prefix}${title}${suffix}`)
}

/** Nome do perfil saneado como pasta; string vazia quando não há nome utilizável. */
export function profileFolder(label: string | null | undefined): string {
  return sanitizeComponent(label ?? '')
}

/** Caminho relativo à raiz: `[<perfil>/]<AAAA-MM>/<AAAA-MM-DD HHhMM> - <título> (<Meet|Teams>)`. */
export function recordingRelDir(input: FolderInput): string {
  const profile = profileFolder(input.profileLabel)
  const rel = `${monthFolder(input.startedAt)}/${callFolderName(input)}`
  return profile ? `${profile}/${rel}` : rel
}

/** `AAAAMMDD-HHmmss-<tabId>-<4 hex>` (ID interno da sessão). */
export function makeSessionId(startedAt: Date | number, tabId: number, random: () => number = Math.random): string {
  const hex = Math.floor(random() * 0x10000)
    .toString(16)
    .padStart(4, '0')
    .slice(-4)
  return `${format(startedAt, 'yyyyMMdd-HHmmss')}-${tabId}-${hex}`
}
