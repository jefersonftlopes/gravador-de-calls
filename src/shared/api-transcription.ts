// Motor de transcrição por API de um provedor, com a chave do próprio usuário, rodando DENTRO da
// extensão (Emenda 21). Este arquivo tem só o que é puro e sem dependências: os provedores, a
// configuração por perfil, a classificação dos erros, a política de retenção do áudio guardado e a
// montagem do multipart. A fila, o IndexedDB e o envio ficam em src/background/api-transcription.ts.
//
// Por que existe: a transcrição de hoje é do helper local (whisper.cpp, ffmpeg, modelo de 1,5 GB,
// terminal). Quem instala pela Chrome Web Store não tem helper, e a seção das configurações só
// mostrava um aviso. Com este motor, quem baixa da loja cola a chave e a transcrição funciona.
//
// Três coisas que este arquivo garante, e que os testes cobram:
// - a CHAVE nunca entra em Settings, em log, no info.json nem numa mensagem de erro: ela mora numa
//   chave de armazenamento própria (API_KEY_STORAGE_KEY) e só aparece no cabeçalho Authorization;
// - a configuração é POR PERFIL do Chrome (mandar o áudio para fora é decisão de cada empresa), e
//   nasce DESLIGADA;
// - o endereço do provedor é dado, não código: trocar de provedor é uma linha em API_PROVIDERS. A
//   extensão só aceita uma origem declarada aqui, que é a mesma lista do optional_host_permissions.
import { API_KEY_STORAGE_KEY } from './constants'

export { API_KEY_STORAGE_KEY }

/** Um provedor de transcrição por API. Dado, não código: trocar de provedor é uma linha. */
export interface ApiProvider {
  id: string
  /** Nome do provedor nas telas (nome próprio, não traduzido). */
  rotulo: string
  /** Endereço completo da operação de transcrição. */
  endpoint: string
  /** Padrão de host do chrome.permissions (o mesmo do optional_host_permissions). */
  origem: string
  /**
   * Modelo padrão. No OpenAI só o `whisper-1` devolve os tempos de cada trecho
   * (response_format=verbose_json com timestamp_granularities[]=segment); o gpt-4o-transcribe e o
   * gpt-4o-mini-transcribe são mais baratos e NÃO devolvem tempos, e sem tempos não dá para casar a
   * fala com o falantes.json (Emenda 18) nem manter os nomes de quem falou.
   */
  modelo: string
  /** Página onde o usuário cria a chave. */
  chaveUrl: string
  /** Dólares por minuto de áudio (whisper-1: 0,006, conferido na documentação em 13/10/2026). */
  dolaresPorMinuto: number
  /** Limite de tamanho de uma requisição, em bytes (OpenAI: 25 MB). */
  maxBytes: number
}

/** 25 MB: a 32 kbps mono (o nosso formato) dá cerca de 1 h 49 de call. */
export const OPENAI_MAX_BYTES = 25 * 1024 * 1024

export const API_PROVIDERS: readonly ApiProvider[] = Object.freeze([
  Object.freeze({
    id: 'openai',
    rotulo: 'OpenAI',
    endpoint: 'https://api.openai.com/v1/audio/transcriptions',
    origem: 'https://api.openai.com/*',
    modelo: 'whisper-1',
    chaveUrl: 'https://platform.openai.com/api-keys',
    dolaresPorMinuto: 0.006,
    maxBytes: OPENAI_MAX_BYTES,
  }),
])

export const DEFAULT_API_PROVIDER = API_PROVIDERS[0]

/** O id que o info.json e o cabeçalho do transcricao.md levam (ENGINE_LABELS em host/texto.mjs). */
export const API_ENGINE_ID = 'openai-api'

/**
 * Origem do servidor falso dos testes de ponta a ponta, só no build de desenvolvimento
 * (manifest.config.ts, STORE_BUILD). Os testes nunca falam com a API de verdade e nunca usam uma
 * chave de verdade: eles sobem um servidor HTTP local e apontam o endpoint para ele. No pacote da
 * loja esta origem não entra no manifesto nem na lista de origens aceitas, e aí só sobra https.
 *
 * Ela entra em `host_permissions` do build de desenvolvimento, e não em
 * `optional_host_permissions`, porque o `chrome.permissions.request` de uma permissão de host
 * precisa do diálogo do Chrome: medido no Chrome for Testing headless em 13/10/2026, a promessa
 * nunca resolve (não há ninguém para clicar). A origem do provedor de verdade continua opcional, e
 * quem prova que nada é enviado sem a permissão concedida é o teste de unidade da fila.
 */
export const TEST_API_ORIGIN = 'http://127.0.0.1/*'

/** As origens que a extensão aceita como endpoint. Fora delas, nada é enviado. */
export function allowedApiOrigins(storeBuild = __STORE_BUILD__): string[] {
  return [...API_PROVIDERS.map((p) => p.origem), ...(storeBuild ? [] : [TEST_API_ORIGIN])]
}

/** As que o manifesto pede na instalação: nenhuma na loja, só o servidor falso no desenvolvimento. */
export function declaredApiOrigins(storeBuild = __STORE_BUILD__): string[] {
  return storeBuild ? [] : [TEST_API_ORIGIN]
}

/** As que o usuário concede na hora de ligar o motor (chrome.permissions.request). */
export function optionalApiOrigins(): string[] {
  return API_PROVIDERS.map((p) => p.origem)
}

/** Configuração do motor por API, por perfil do Chrome (dentro de Settings; a chave, NUNCA). */
export interface ApiTranscriptionConfig {
  /** Desligada por padrão: mandar o áudio da call para fora é decisão de cada perfil. */
  ativa: boolean
  /** Id de API_PROVIDERS. */
  provedor: string
  /** Endereço da operação (vazio: o do provedor). Só uma origem declarada é aceita. */
  endpoint: string
  /** Modelo (vazio: o do provedor). */
  modelo: string
  /** `auto` (o provedor detecta) ou um código de idioma (pt, en...). */
  idioma: string
}

export const DEFAULT_API_TRANSCRIPTION: ApiTranscriptionConfig = Object.freeze({
  ativa: false,
  provedor: DEFAULT_API_PROVIDER.id,
  endpoint: '',
  modelo: '',
  idioma: 'auto',
})

export function providerOf(id: string): ApiProvider {
  return API_PROVIDERS.find((p) => p.id === id) ?? DEFAULT_API_PROVIDER
}

/** O endereço que vale: o configurado, senão o do provedor. */
export function endpointOf(cfg: ApiTranscriptionConfig): string {
  return cfg.endpoint.trim() || providerOf(cfg.provedor).endpoint
}

/** O modelo que vale: o configurado, senão o do provedor. */
export function modelOf(cfg: ApiTranscriptionConfig): string {
  return cfg.modelo.trim() || providerOf(cfg.provedor).modelo
}

/** O limite de tamanho por requisição que vale (o do provedor). */
export function maxBytesOf(cfg: ApiTranscriptionConfig): number {
  return providerOf(cfg.provedor).maxBytes
}

/** O padrão de host do chrome.permissions para um endereço, ou null se o endereço não serve. */
export function originPatternOf(url: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  // https sempre; http só na origem do servidor falso dos testes, que o build da loja não declara.
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null
  const pattern = `${parsed.protocol}//${parsed.hostname}/*`
  return allowedApiOrigins().includes(pattern) ? pattern : null
}

/** O endereço configurado é aceitável? (origem declarada e, fora dos testes, https). */
export function isAllowedEndpoint(url: string): boolean {
  return originPatternOf(url) !== null
}

// ---------------------------------------------------------------------------------------------
// Retenção do áudio guardado
// ---------------------------------------------------------------------------------------------

/**
 * Os pedaços do áudio saem do IndexedDB assim que a gravação é salva (deleteChunks em
 * src/background/sessions.ts), e a extensão NÃO consegue ler de volta o arquivo que o helper
 * gravou no disco. Para transcrever por API o áudio tem de ficar guardado DEPOIS de salvar, e por
 * isso ele tem prazo e tamanho máximos: nada fica guardado para sempre.
 */
export const API_RETENTION = Object.freeze({
  /** Tentativas por gravação (a primeira conta). Na última que falhar, o áudio é apagado. */
  maxAttempts: 5,
  /** Idade máxima do áudio guardado: 24 h. Passou disso, o áudio sai e a gravação fica com erro. */
  maxAgeMs: 24 * 60 * 60_000,
  /**
   * Soma máxima do áudio guardado: 300 MB (cerca de 21 h de call a 32 kbps). Estourando, as mais
   * antigas saem até caber, com erro legível, para a fila não encher o disco do usuário.
   */
  maxTotalBytes: 300 * 1024 * 1024,
  /** Esperas entre as tentativas, em ms (crescente). A última vale para as seguintes. */
  backoffMs: [15_000, 60_000, 5 * 60_000, 15 * 60_000] as const,
})

/** Espera antes da tentativa número `attempts + 1` (a 1ª tentativa é imediata). */
export function backoffFor(attempts: number): number {
  const list = API_RETENTION.backoffMs
  if (attempts <= 0) return 0
  return list[Math.min(attempts, list.length) - 1]
}

/** Por que um áudio guardado foi descartado sem transcrever. */
export type ApiDropReason = 'tentativas' | 'idade' | 'espaco' | 'grande'

/** O mínimo que a retenção precisa saber de um áudio guardado. */
export interface RetainedAudio {
  sessionId: string
  bytes: number
  createdAt: number
  attempts: number
}

/**
 * Decide o que fica e o que sai da fila, pelos três limites (pura, para o teste medir cada um).
 * `now`: agora. Os mais novos ficam; a soma é contada do mais novo para o mais antigo, e o que não
 * couber sai por `espaco`.
 */
export function applyRetention<T extends RetainedAudio>(jobs: readonly T[], now: number): { keep: T[]; drop: Array<{ job: T; reason: ApiDropReason }> } {
  const keep: T[] = []
  const drop: Array<{ job: T; reason: ApiDropReason }> = []
  let total = 0
  // Do mais novo para o mais antigo: a call que acabou de ser gravada nunca é a que sai por espaço.
  for (const job of [...jobs].sort((a, b) => b.createdAt - a.createdAt)) {
    if (job.attempts >= API_RETENTION.maxAttempts) {
      drop.push({ job, reason: 'tentativas' })
      continue
    }
    if (now - job.createdAt > API_RETENTION.maxAgeMs) {
      drop.push({ job, reason: 'idade' })
      continue
    }
    if (total + job.bytes > API_RETENTION.maxTotalBytes) {
      drop.push({ job, reason: 'espaco' })
      continue
    }
    total += job.bytes
    keep.push(job)
  }
  keep.reverse()
  return { keep, drop }
}

// ---------------------------------------------------------------------------------------------
// Erros
// ---------------------------------------------------------------------------------------------

/**
 * Como tratar a falha de um envio. Cada um se comporta de um jeito:
 * - `config`: a chave está errada ou sem acesso (401, 403). NÃO repete sozinho: repetir não
 *   conserta e gasta a fila. O usuário corrige a chave nas configurações.
 * - `limite`: o provedor pediu para esperar (429). Repete, com espera crescente.
 * - `servidor`: erro do lado do provedor (5xx). Repete, com espera crescente.
 * - `rede`: não chegou resposta (sem internet, DNS, VPN). Repete.
 * - `grande`: o áudio passa do limite por requisição (413, ou a conferência antes de enviar).
 *   Não repete: o motor local transcreve esta call.
 * - `pedido`: o provedor recusou o pedido (400, 404, 422...). Não repete sozinho: repetir daria o
 *   mesmo erro.
 */
export type ApiErrorKind = 'config' | 'limite' | 'servidor' | 'rede' | 'grande' | 'pedido'

/** O erro se repete sozinho? */
export function retriesAlone(kind: ApiErrorKind): boolean {
  return kind === 'limite' || kind === 'servidor' || kind === 'rede'
}

/** Classifica a falha pelo código HTTP; `null` é "não chegou resposta" (erro de rede). */
export function classifyApiError(status: number | null): ApiErrorKind {
  if (status === null) return 'rede'
  if (status === 401 || status === 403) return 'config'
  if (status === 429) return 'limite'
  if (status === 413) return 'grande'
  if (status >= 500) return 'servidor'
  return 'pedido'
}

// ---------------------------------------------------------------------------------------------
// Requisição
// ---------------------------------------------------------------------------------------------

/** Nome do arquivo no multipart. O provedor decide o formato pela extensão. */
export const API_UPLOAD_FILENAME = 'audio.webm'

/** Os campos do multipart, sem o áudio (parte binária) e sem a chave (vai no cabeçalho). */
export function multipartFields(cfg: ApiTranscriptionConfig): Array<[string, string]> {
  const fields: Array<[string, string]> = [
    ['model', modelOf(cfg)],
    // verbose_json + segment: o único jeito de receber os tempos de cada trecho, que o
    // assignSpeakers precisa para casar a fala com o falantes.json (Emenda 18).
    ['response_format', 'verbose_json'],
    ['timestamp_granularities[]', 'segment'],
  ]
  if (cfg.idioma && cfg.idioma !== 'auto') fields.push(['language', cfg.idioma])
  return fields
}

/**
 * Cabeçalhos da requisição. É o ÚNICO lugar em que a chave aparece: nada de query string (que
 * entraria em log de proxy), nada de corpo, nada de mensagem de erro.
 */
export function authHeaders(key: string): Record<string, string> {
  return { Authorization: `Bearer ${key}` }
}

/** Segmentos { start, end, text } da resposta verbose_json (tempos em segundos). */
export function segmentsFromApiJson(json: unknown): Array<{ start: number; end: number; text: string }> {
  const obj = json && typeof json === 'object' ? (json as Record<string, unknown>) : {}
  const list = Array.isArray(obj.segments) ? obj.segments : []
  const out: Array<{ start: number; end: number; text: string }> = []
  for (const raw of list) {
    const s = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
    const text = String(s.text ?? '').trim()
    if (!text) continue
    const start = Number(s.start)
    const end = Number(s.end)
    if (!Number.isFinite(start)) continue
    out.push({ start: Math.max(0, start), end: Number.isFinite(end) ? Math.max(start, end) : start, text })
  }
  // Sem `segments` (um provedor que só devolve o texto): um trecho só, sem tempo.
  if (out.length === 0 && typeof obj.text === 'string' && obj.text.trim()) out.push({ start: 0, end: 0, text: obj.text.trim() })
  return out
}

/** O idioma que a resposta diz (ou o configurado). */
export function languageFromApiJson(json: unknown, cfg: ApiTranscriptionConfig): string {
  const obj = json && typeof json === 'object' ? (json as Record<string, unknown>) : {}
  return typeof obj.language === 'string' && obj.language ? obj.language : cfg.idioma
}

/** Custo por hora de call, em dólares, para a tela dizer quanto custa. */
export function dollarsPerHour(cfg: ApiTranscriptionConfig): number {
  return Math.round(providerOf(cfg.provedor).dolaresPorMinuto * 60 * 100) / 100
}

/**
 * Mescla o que estiver salvo com os padrões; campo inválido volta ao padrão. Nunca lê nem escreve
 * `chave`: se um objeto guardado trouxer algo parecido com uma chave, ele é ignorado aqui (a chave
 * tem armazenamento próprio).
 */
export function normalizeApiTranscription(raw: unknown): ApiTranscriptionConfig {
  const obj = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const out = { ...DEFAULT_API_TRANSCRIPTION }
  if (typeof obj.ativa === 'boolean') out.ativa = obj.ativa
  if (typeof obj.provedor === 'string' && API_PROVIDERS.some((p) => p.id === obj.provedor)) out.provedor = obj.provedor
  if (typeof obj.endpoint === 'string' && (!obj.endpoint.trim() || isAllowedEndpoint(obj.endpoint.trim()))) out.endpoint = obj.endpoint.trim()
  if (typeof obj.modelo === 'string' && obj.modelo.length <= 100) out.modelo = obj.modelo.trim()
  if (typeof obj.idioma === 'string' && /^(auto|[a-z]{2,3})$/.test(obj.idioma)) out.idioma = obj.idioma
  return out
}
