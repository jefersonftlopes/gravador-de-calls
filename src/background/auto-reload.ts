// Recarga sozinha da cópia publicada (Emenda 17), lado do SW.
//
// O `npm run publicar` troca a pasta que os perfis carregam e grava nela o `publicado.json`
// (versão, impressão digital e o identificador do build). O Chrome continua com o SW antigo até a
// extensão ser recarregada. Então o SW confere, ao subir e num alarme a cada minuto, o
// publicado.json do próprio pacote: se a versão ou o build forem outros que os embutidos nele, e
// nada estiver em uso (nenhuma gravação, nenhuma aba do Meet ou do Teams, nenhum volume de aba,
// nenhuma captura começando, a página de configurações fechada), chama chrome.runtime.reload().
// Senão espera e mostra o aviso no popup e o badge.
//
// O pacote da loja não tem o publicado.json (e o __STORE_BUILD__ desliga tudo aqui): a loja
// atualiza a extensão sozinha. O build de trabalho (dist/) também não tem: os testes e o
// desenvolvimento não recarregam sozinhos.
//
// Laço: recarregar com um publicado.json que não bate com o código do disco (editado à mão, uma
// publicação pela metade) daria o mesmo código de novo, e outra recarga. Antes de recarregar, o SW
// grava em chrome.storage.local a publicação que tentou; para essa mesma publicação ele não tenta
// de novo (`desistir`) e o aviso diz para recarregar à mão.
import { CALL_MATCHES } from '../shared/hosts'
import type { AutoReloadState, AutoReloadWait, BuildInfo } from '../shared/protocol'
import { BAKED } from '../shared/version'
import { listSessions } from './idb'
import { activeRecordings, pendingSaves } from './sessions'
import { tabCaptureOpsInFlight } from './tabvolume'
import { registerTestHooks } from './testing'

/** Arquivo que o npm run publicar grava na pasta publicada (scripts/publicar.mjs, STAMP_FILE). */
export const PUBLISHED_STAMP_FILE = 'publicado.json'
export const AUTO_RELOAD_ALARM = 'gravador:versao-publicada'
/** Última recarga sozinha tentada (chrome.storage.local). */
export const AUTO_RELOAD_KEY = 'recargaAutomatica'

/** O que o publicar grava. `build` só existe a partir da 0.3.1 (das publicações anteriores, só a versão). */
export interface PublishedStamp {
  versao: string
  impressao?: string
  build?: string
  em?: string
}

export interface AutoReloadAttempt {
  /** Publicação tentada (`versao+build`). */
  key: string
  at: number
  from: string
  to: string
}

export interface AutoReloadInputs {
  baked: BuildInfo
  stamp: PublishedStamp | null
  /** Gravações abertas (página ou modo aba), na memória ou no IndexedDB. */
  recordings: number
  /** Gravações terminadas ainda sendo salvas (finalizando ou interrompidas por salvar). */
  saving: number
  /** Abas abertas nos hosts das calls (qualquer página do Meet ou do Teams). */
  callTabs: number
  /** Abas com a captura desta extensão (volume desta aba ou modo aba). */
  capturedTabs: number
  /**
   * Abas com uma captura sendo pedida agora (modo aba ou volume, ./tabvolume.ts): o atalho ou o
   * botão do popup acabou de pedir e a sessão ainda não existe. Recarregar mataria essa captura.
   */
  startingCaptures: number
  /** Páginas de configurações abertas (recarregar fecha a página e perde o que não foi salvo). */
  optionsPages: number
  lastAttempt: AutoReloadAttempt | null
}

export type AutoReloadDecision =
  | { action: 'nada'; why: 'sem-publicacao' | 'em-dia' }
  | { action: 'esperar'; published: BuildInfo; waiting: AutoReloadWait[] }
  | { action: 'desistir'; published: BuildInfo }
  | { action: 'recarregar'; published: BuildInfo; key: string }

/** O publicado.json lido, ou null se não for um carimbo válido. */
export function parseStamp(raw: unknown): PublishedStamp | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.versao !== 'string' || !/^\d+(\.\d+){0,3}$/.test(r.versao)) return null
  return {
    versao: r.versao,
    ...(typeof r.impressao === 'string' ? { impressao: r.impressao } : {}),
    ...(typeof r.build === 'string' && r.build ? { build: r.build } : {}),
    ...(typeof r.em === 'string' ? { em: r.em } : {}),
  }
}

/** Identificador de uma publicação, para não tentar a mesma duas vezes. */
export function stampKey(stamp: PublishedStamp): string {
  return `${stamp.versao}+${stamp.build ?? stamp.impressao ?? ''}`
}

/**
 * Regra pura: recarregar, esperar, desistir ou nada. Uma publicação sem `build` (de antes da
 * 0.3.1) compara só a versão.
 */
export function decideAutoReload(i: AutoReloadInputs): AutoReloadDecision {
  if (!i.stamp) return { action: 'nada', why: 'sem-publicacao' }
  const sameVersion = i.stamp.versao === i.baked.version
  const sameBuild = !i.stamp.build || i.stamp.build === i.baked.build
  if (sameVersion && sameBuild) return { action: 'nada', why: 'em-dia' }
  const published: BuildInfo = { version: i.stamp.versao, build: i.stamp.build ?? '' }
  const key = stampKey(i.stamp)
  if (i.lastAttempt?.key === key) return { action: 'desistir', published }
  const waiting: AutoReloadWait[] = []
  if (i.recordings > 0) waiting.push('gravando')
  if (i.saving > 0) waiting.push('salvando')
  if (i.callTabs > 0) waiting.push('call-aberta')
  if (i.capturedTabs > 0) waiting.push('volume')
  if (i.startingCaptures > 0) waiting.push('iniciando-captura')
  if (i.optionsPages > 0) waiting.push('configuracoes-abertas')
  if (waiting.length > 0) return { action: 'esperar', published, waiting }
  return { action: 'recarregar', published, key }
}

const log = (...a: unknown[]) => console.debug('[gravador sw versao]', ...a)

/** O que o SW viu na última conferência (vai no ui:state e no badge). */
let state: AutoReloadState | null = null
const listeners = new Set<(s: AutoReloadState | null) => void>()

export function autoReloadState(): AutoReloadState | null {
  return state
}

/** Avisa quando a publicação esperando muda (o badge global ouve). */
export function onAutoReloadState(fn: (s: AutoReloadState | null) => void): void {
  listeners.add(fn)
}

function setState(next: AutoReloadState | null): void {
  const changed = JSON.stringify(next) !== JSON.stringify(state)
  state = next
  if (changed) for (const fn of listeners) fn(next)
}

async function readStamp(): Promise<PublishedStamp | null> {
  try {
    const r = await fetch(chrome.runtime.getURL(PUBLISHED_STAMP_FILE), { cache: 'no-store' })
    return r.ok ? parseStamp(await r.json()) : null
  } catch {
    // Sem o arquivo (loja, dist/): o fetch de um recurso que não existe falha.
    return null
  }
}

async function countOpenSessions(): Promise<{ recordings: number; saving: number }> {
  const ids = new Set(activeRecordings().map((r) => r.sessionId))
  const saving = new Set(pendingSaves().map((p) => p.sessionId))
  try {
    for (const r of await listSessions('gravando')) ids.add(r.sessionId)
    for (const st of ['finalizando', 'interrompida'] as const) for (const r of await listSessions(st)) saving.add(r.sessionId)
  } catch {
    // IndexedDB indisponível: vale a memória.
  }
  return { recordings: ids.size, saving: saving.size }
}

/** Páginas de configurações abertas em abas (o options_page do manifesto). */
async function countOptionsPages(): Promise<number> {
  const url = chrome.runtime.getURL('src/options/index.html')
  try {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ['TAB' as chrome.runtime.ContextType] })
    return contexts.filter((c) => c.documentUrl?.startsWith(url)).length
  } catch {
    return 0
  }
}

async function gatherInputs(stamp: PublishedStamp): Promise<AutoReloadInputs> {
  const { recordings, saving } = await countOpenSessions()
  const callTabs = (await chrome.tabs.query({ url: [...CALL_MATCHES] }).catch(() => [])).length
  const captured = await chrome.tabCapture.getCapturedTabs().catch(() => [] as chrome.tabCapture.CaptureInfo[])
  const capturedTabs = captured.filter((c) => c.status === 'active' || c.status === 'pending').length
  const optionsPages = await countOptionsPages()
  const got = await chrome.storage.local.get(AUTO_RELOAD_KEY).catch(() => ({}) as Record<string, unknown>)
  const lastAttempt = (got[AUTO_RELOAD_KEY] as AutoReloadAttempt | undefined) ?? null
  // Lido por último, logo antes de decidir: a janela até o chrome.runtime.reload() fica a menor possível.
  const startingCaptures = tabCaptureOpsInFlight()
  return { baked: BAKED, stamp, recordings, saving, callTabs, capturedTabs, startingCaptures, optionsPages, lastAttempt }
}

/** Gancho de teste: a recarga é trocada por um registro (o teste confere sem perder o SW). */
let reloadOverride: (() => void) | null = null

/** Uma conferência agora: lê o publicado.json, decide e age. Devolve a decisão (log e testes). */
export async function checkPublishedVersion(): Promise<AutoReloadDecision> {
  if (__STORE_BUILD__) return { action: 'nada', why: 'sem-publicacao' }
  const stamp = await readStamp()
  if (!stamp) {
    setState(null)
    await chrome.alarms.clear(AUTO_RELOAD_ALARM).catch(() => false)
    return { action: 'nada', why: 'sem-publicacao' }
  }
  // Cópia publicada: o alarme fica, para ver a próxima publicação.
  ensureAlarm()
  const decision = decideAutoReload(await gatherInputs(stamp))
  switch (decision.action) {
    case 'nada':
      setState(null)
      break
    case 'esperar':
      setState({ published: decision.published, waiting: decision.waiting, gaveUp: false })
      log('versão', decision.published.version, 'publicada; esperando:', decision.waiting.join(', '))
      break
    case 'desistir':
      setState({ published: decision.published, waiting: [], gaveUp: true })
      log('versão', decision.published.version, 'publicada, mas a recarga já foi tentada e o código continua', BAKED.version)
      break
    case 'recarregar': {
      setState({ published: decision.published, waiting: [], gaveUp: false })
      const attempt: AutoReloadAttempt = { key: decision.key, at: Date.now(), from: BAKED.version, to: decision.published.version }
      await chrome.storage.local.set({ [AUTO_RELOAD_KEY]: attempt })
      log('recarregando sozinho:', BAKED.version, '->', decision.published.version)
      if (reloadOverride) reloadOverride()
      else chrome.runtime.reload()
      break
    }
  }
  return decision
}

function ensureAlarm(): void {
  try {
    Promise.resolve(chrome.alarms.create(AUTO_RELOAD_ALARM, { periodInMinutes: 1 })).catch(() => {})
  } catch (e) {
    log('alarme', e)
  }
}

/** Gancho de teste: troca a recarga por `fn` (null volta à recarga de verdade). */
function fakeAutoReload(on: boolean): void {
  reloadOverride = on ? () => log('recarga sozinha (falsa, teste)') : null
}

/** Ouvintes da recarga sozinha (chamado por index.ts no carregamento) e a conferência ao subir. */
export function registerAutoReload(): void {
  registerTestHooks({ checkPublishedVersion, fakeAutoReload, autoReloadState })
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === AUTO_RELOAD_ALARM) void checkPublishedVersion()
  })
  if (!__STORE_BUILD__) void checkPublishedVersion()
}
