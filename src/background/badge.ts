// Badge por aba e notificações (AC11, AC13, AC16).
// - REC vermelho: gravando com áudio. REC âmbar: 60 s sem nenhum áudio desde o início (o SW
//   decide e chama setBadge/notifyNoAudio uma vez por sessão; aqui a notificação também é única
//   por sessão depois de um reinício do SW, porque o registro fica em chrome.storage.session).
// - ↻ azul: aba de call aberta antes da instalação ou atualização (sem os content scripts). Some
//   quando um documento novo da aba traz os nossos content scripts (o relay conecta no hello),
//   quando a aba sai dos hosts das calls ou fecha. Navegação dentro da página (pushState do
//   Teams, que é aplicação de página única) não tira: o documento continua sem os scripts.
// - Clique numa notificação: foca a aba. Botão "Recarregar a aba (sai da call)" (AC16): recarrega e foca.
// - Emenda 19: títulos e notificações saem no idioma escolhido nas configurações, esperando a
//   leitura dele quando o SW acaba de acordar (languageReady); trocado o idioma, o título padrão e
//   o de cada aba são reaplicados na hora (refreshActionTitles). Notificação já mostrada fica como
//   saiu.
import { hasConsent } from '../shared/consent'
import { isCallHost, isMeetHost } from '../shared/hosts'
import { MESSAGE_LOCALES, languageReady, onLanguageChange, t, tIn, tp, type MessageKey } from '../shared/i18n'
import { registerTestHooks } from './testing'

export type BadgeState = 'rec' | 'rec-microfone' | 'rec-sem-audio' | 'recarregar' | 'nenhum'

const COLORS: Record<Exclude<BadgeState, 'nenhum'>, string> = {
  rec: '#d93025',
  // Emenda 25: o MESMO vermelho da gravação, de propósito. Nenhuma cor nova: o estado continua
  // sendo "gravando", e quem diz o que mudou é o texto, como o ↻ faz.
  'rec-microfone': '#d93025',
  'rec-sem-audio': '#f29900',
  recarregar: '#1a73e8',
}
const TEXT: Record<Exclude<BadgeState, 'nenhum'>, string> = {
  rec: 'REC',
  // "A sua voz está entrando no arquivo agora". Um tom de vermelho parecido passaria batido; o
  // texto não passa, e a dica do ícone diz a frase inteira.
  'rec-microfone': 'MIC',
  'rec-sem-audio': 'REC',
  recarregar: '↻',
}
// Títulos lidos na hora (Emenda 15), no idioma escolhido (Emenda 19).
const TITLE_KEYS: Record<Exclude<BadgeState, 'nenhum'>, MessageKey> = {
  rec: 'badgeRecording',
  'rec-microfone': 'badgeRecordingMic',
  'rec-sem-audio': 'badgeNoAudio',
  recarregar: 'badgeReload',
}
const tabTitleOf = (state: Exclude<BadgeState, 'nenhum'>) => t(TITLE_KEYS[state])
const defaultTitle = () => t('actionTitle')
/** Badge global do aviso da primeira execução ainda não confirmado (Emenda 15). */
const CONSENT_COLOR = '#1a73e8'
/** Badge global da versão publicada esperando a recarga sozinha (Emenda 17). */
const UPDATE_COLOR = '#7b1fa2'
/** Comando do modo aba no manifesto (o mesmo de tabcapture.ts; repetido para não importar o modo aba). */
const TAB_COMMAND = 'gravar-aba'

/** Notificações criadas (ids), em chrome.storage.session: sobrevive a um reinício do SW. */
const SHOWN_KEY = 'notificacoesMostradas'
/** Abas marcadas com ↻ (tabId), em chrome.storage.session. */
const RELOAD_KEY = 'abasParaRecarregar'
/**
 * Abas dos hosts das calls abertas antes da instalação (tabId), marcadas ou não: o documento
 * delas não tem os content scripts. Uma que ainda não é de call (página inicial do Meet) ganha o
 * ↻ se navegar dentro da página até uma reunião.
 */
const STALE_KEY = 'abasSemScripts'
const SHOWN_MAX = 200

const log = (...a: unknown[]) => console.debug('[gravador badge]', ...a)

// ---------------------------------------------------------------------------------------------
// Regras puras (testadas com vitest em badge.test.ts)
// ---------------------------------------------------------------------------------------------

/**
 * O badge de uma aba que está gravando. Emenda 25: a voz do usuário entrando no arquivo vence o
 * aviso de "sem áudio", porque é o sinal que ela NUNCA pode deixar de ver; o aviso de sem áudio
 * continua saindo como notificação, então a informação não se perde.
 */
export function recordingBadge(state: { silent: boolean; mic: boolean }): Exclude<BadgeState, 'nenhum' | 'recarregar'> {
  if (state.mic) return 'rec-microfone'
  return state.silent ? 'rec-sem-audio' : 'rec'
}

export type NotificationKind = 'sem-audio' | 'recarregar' | 'vigia'

/** Id da notificação: `<tipo>:<tabId>[:<sessionId>]`. */
export function notificationId(kind: Exclude<NotificationKind, 'vigia'>, tabId: number, sessionId?: string): string {
  return sessionId ? `${kind}:${tabId}:${sessionId}` : `${kind}:${tabId}`
}

export function parseNotificationId(id: string): { kind: NotificationKind; tabId: number; sessionId: string | null } | null {
  // A do vigia ("Não consegui sair da call sozinho", src/background/vigia.ts): vigia-<tabId>-<ms>.
  const v = /^vigia-(\d+)-\d+$/.exec(id)
  if (v) return { kind: 'vigia', tabId: Number(v[1]), sessionId: null }
  const m = /^(sem-audio|recarregar):(\d+)(?::(.+))?$/.exec(id)
  if (!m) return null
  return { kind: m[1] as NotificationKind, tabId: Number(m[2]), sessionId: m[3] ?? null }
}

const MEET_CODE_RE = /^\/[a-z]{3}-[a-z]{4}-[a-z]{3}(?:\/|$)/

function parseHttps(url: string | undefined): URL | null {
  if (!url) return null
  try {
    const u = new URL(url)
    return u.protocol === 'https:' ? u : null
  } catch {
    return null
  }
}

/** A URL é de um dos hosts das calls (onde os nossos content scripts rodam)? */
export function isCallHostUrl(url: string | undefined): boolean {
  const u = parseHttps(url)
  return !!u && isCallHost(u.hostname)
}

/**
 * A aba é de call e precisa recarregar para ser gravada? Meet: só a página de uma reunião (com o
 * código no caminho; a página inicial do Meet não grava nada). Teams: qualquer página, porque o
 * Teams é uma aplicação de página única e a call acontece dentro da mesma aba.
 */
export function isCallTabUrl(url: string | undefined): boolean {
  const u = parseHttps(url)
  if (!u || !isCallHostUrl(url)) return false
  return isMeetHost(u.hostname) ? MEET_CODE_RE.test(u.pathname) : true
}

/** Motivos do onInstalled em que as abas abertas NÃO perderam os content scripts. */
export function installReasonMarksTabs(reason: string | null): boolean {
  return reason !== 'chrome_update' && reason !== 'shared_module_update'
}

/** Texto do atalho do modo aba como o Chrome mostra ("⌥⇧G"), ou a sugestão quando não há. */
export function shortcutText(shortcut: string | undefined): string {
  return shortcut && shortcut.trim() ? shortcut : t('shortcutUnset')
}

// ---------------------------------------------------------------------------------------------
// Badge
// ---------------------------------------------------------------------------------------------

/**
 * Uma escrita de badge por vez em cada aba e no global (Emenda 19). A troca de idioma lê o título
 * de cada aba e o escreve de novo no idioma novo; um setBadge da mesma aba no meio (começado antes
 * ou depois da leitura) faria a troca escrever por cima o título do estado antigo. Na fila, a troca
 * de cada aba roda inteira antes ou depois do setBadge, e cada passo lê o estado e o idioma na hora
 * em que roda.
 */
const badgeQueues = new Map<number | 'global', Promise<void>>()

function inBadgeQueue(key: number | 'global', fn: () => Promise<void>): Promise<void> {
  const run = (badgeQueues.get(key) ?? Promise.resolve()).then(fn)
  const tail = run.catch(() => {})
  badgeQueues.set(key, tail)
  void tail.then(() => {
    if (badgeQueues.get(key) === tail) badgeQueues.delete(key)
  })
  return run
}

export function setBadge(tabId: number, state: BadgeState): Promise<void> {
  return inBadgeQueue(tabId, async () => {
    try {
      await languageReady()
      if (state === 'nenhum') {
        await chrome.action.setBadgeText({ tabId, text: '' })
        await chrome.action.setTitle({ tabId, title: defaultTitle() })
        return
      }
      await chrome.action.setBadgeBackgroundColor({ tabId, color: COLORS[state] })
      await chrome.action.setBadgeText({ tabId, text: TEXT[state] })
      await chrome.action.setTitle({ tabId, title: tabTitleOf(state) })
    } catch {
      // aba fechada no meio
    }
  })
}

/**
 * O estado de uma aba pelo título que ela tem, em qualquer das línguas (Emenda 19). Só os títulos
 * próprios de aba contam: o padrão e os globais (aviso, gravação não salva, versão) são do
 * applyGlobalBadge, e pôr um deles numa aba a prenderia ali.
 */
export function tabStateOfTitle(title: string): Exclude<BadgeState, 'nenhum'> | null {
  for (const [state, key] of Object.entries(TITLE_KEYS) as Array<[Exclude<BadgeState, 'nenhum'>, MessageKey]>) {
    if (MESSAGE_LOCALES.some((locale) => tIn(locale, key) === title) || t(key) === title) return state
  }
  return null
}

/**
 * Trocado o idioma (Emenda 19): o título global e o de cada aba com REC ou ↻ no idioma novo. O SW
 * não guarda o estado de cada aba (ele sobrevive no Chrome a um reinício do SW), então lê o título
 * de cada aba e reconhece o estado por ele.
 */
export async function refreshActionTitles(): Promise<void> {
  await applyGlobalBadge()
  let tabs: chrome.tabs.Tab[] = []
  try {
    tabs = await chrome.tabs.query({})
  } catch (e) {
    log('tabs.query', e)
    return
  }
  for (const tab of tabs) {
    const tabId = tab.id
    if (tabId == null) continue
    await inBadgeQueue(tabId, async () => {
      try {
        const state = tabStateOfTitle(await chrome.action.getTitle({ tabId }))
        if (state) await chrome.action.setTitle({ tabId, title: tabTitleOf(state) })
      } catch {
        // aba fechada no meio
      }
    })
  }
}

// ---------------------------------------------------------------------------------------------
// Registro em chrome.storage.session
// ---------------------------------------------------------------------------------------------

async function readList<T>(key: string): Promise<T[]> {
  try {
    const got = await chrome.storage.session.get(key)
    const v = got[key]
    return Array.isArray(v) ? (v as T[]) : []
  } catch {
    return []
  }
}

async function writeList<T>(key: string, list: T[]): Promise<void> {
  try {
    await chrome.storage.session.set({ [key]: list })
  } catch (e) {
    log('storage.session', e)
  }
}

/** Uma escrita por vez nas listas (dois tabs.onUpdated seguidos não se atropelam). */
let listChain: Promise<unknown> = Promise.resolve()
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = listChain.then(fn, fn)
  listChain = next.catch(() => {})
  return next
}

/** Notificação mostrada (registro em storage.session; também é o que o teste confere). */
export interface ShownNotification {
  id: string
  title: string
  message: string
  at: number
}

/**
 * Cria a notificação e guarda no registro. Com `once`, não cria de novo um id que já está no
 * registro (a do "sem áudio" é uma por sessão, mesmo que o SW reinicie no meio).
 */
function showNotification(id: string, options: chrome.notifications.NotificationCreateOptions, once: boolean): Promise<boolean> {
  return serial(async () => {
    const list = await readList<ShownNotification>(SHOWN_KEY)
    if (once && list.some((n) => n.id === id)) return false
    list.push({ id, title: options.title ?? '', message: options.message ?? '', at: Date.now() })
    await writeList(SHOWN_KEY, list.slice(-SHOWN_MAX))
    try {
      await chrome.notifications.create(id, options)
    } catch (e) {
      log('notificação', id, e)
    }
    return true
  })
}

async function tabTitle(tabId: number): Promise<string> {
  try {
    return (await chrome.tabs.get(tabId)).title ?? ''
  } catch {
    return ''
  }
}

async function tabCommandShortcut(): Promise<string | undefined> {
  try {
    return (await chrome.commands.getAll()).find((c) => c.name === TAB_COMMAND)?.shortcut
  } catch {
    return undefined
  }
}

/**
 * Fim de uma gravação na aba (Emenda 10): tira o REC, mas não o ↻. Recarregar ou atualizar a
 * extensão com uma call gravando fecha a gravação na recuperação e marca a aba com ↻ no
 * onInstalled, quase juntos; o REC apagado depois apagava o ↻ e a aba ficava sem nada. Lê a lista
 * na mesma fila das escritas de markTabsOpenedBeforeInstall, que só põe o ↻ depois de gravá-la.
 */
export function clearRecordingBadge(tabId: number): Promise<void> {
  return serial(async () => {
    const marked = (await readList<number>(RELOAD_KEY)).includes(tabId)
    await setBadge(tabId, marked ? 'recarregar' : 'nenhum')
  })
}

/**
 * Emenda 10: gravação que terminou e não foi salva (helper e downloads falharam). Sem isso o REC
 * sumia e parecia salvo. "!" âmbar no ícone em todas as abas (as que gravam mostram o REC delas) e
 * um aviso, uma vez por SW; o popup lista as pendentes com "Tentar agora".
 */
export async function setSaveWarning(pending: number): Promise<void> {
  pendingSaveCount = pending
  await applyGlobalBadge()
}

/** Quantas gravações não foram salvas (setSaveWarning) e se falta confirmar o aviso. */
let pendingSaveCount = 0
let consentMissing = false

/**
 * Badge global (todas as abas; as que gravam mostram o REC delas). As gravações não salvas vêm
 * antes: o áudio delas corre risco. Depois, o aviso da primeira execução (Emenda 15).
 */
export function globalBadge(pending: number, missingConsent: boolean, updateVersion: string | null = null): { text: string; color: string | null; title: string } {
  if (pending > 0) return { text: '!', color: COLORS['rec-sem-audio'], title: tp('badgePendingSaves', pending) }
  if (missingConsent) return { text: '!', color: CONSENT_COLOR, title: t('badgeConsent') }
  // Emenda 17: a versão publicada que o SW ainda não está rodando (recarga sozinha esperando).
  if (updateVersion) return { text: '↑', color: UPDATE_COLOR, title: t('badgeUpdateWaiting', updateVersion) }
  return { text: '', color: null, title: defaultTitle() }
}

/** Versão publicada esperando a recarga sozinha (null: nenhuma). Emenda 17. */
let updateWaiting: string | null = null

/** A recarga sozinha mudou de estado: o badge global mostra a versão que espera (ou some). */
export async function setUpdateBadge(version: string | null): Promise<void> {
  updateWaiting = version
  await applyGlobalBadge()
}

function applyGlobalBadge(): Promise<void> {
  return inBadgeQueue('global', async () => {
    await languageReady()
    // Lido na vez deste passo da fila: o estado e o idioma que valem agora.
    const b = globalBadge(pendingSaveCount, consentMissing, updateWaiting)
    try {
      if (b.color) await chrome.action.setBadgeBackgroundColor({ color: b.color })
      await chrome.action.setBadgeText({ text: b.text })
      await chrome.action.setTitle({ title: b.title })
    } catch {
      // nada
    }
  })
}

/** Lê a confirmação do aviso e acerta o badge global (SW subindo e a cada mudança). */
export async function refreshConsentBadge(): Promise<void> {
  consentMissing = !(await hasConsent())
  await applyGlobalBadge()
}

export async function notifySaveFailed(pending: number): Promise<void> {
  await setSaveWarning(pending)
  await languageReady()
  await showNotification(
    `nao-salvou:${Date.now()}`,
    {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: t('notifSaveFailedTitle'),
      message: t('notifSaveFailedMessage'),
      priority: 2,
      requireInteraction: true,
    },
    false,
  )
}

/** Abas marcadas com ↻ (o popup avisa na aba atual). */
export function tabsNeedingReload(): Promise<number[]> {
  return readList<number>(RELOAD_KEY)
}

// ---------------------------------------------------------------------------------------------
// AC13: sem áudio
// ---------------------------------------------------------------------------------------------

/**
 * AC13: a gravação passou 60 s sem nenhum áudio. O SW chama UMA vez por sessão, junto do badge
 * âmbar; depois de um reinício do SW ele pode chamar de novo, e o registro em storage.session
 * segura a repetição.
 */
export async function notifyNoAudio(tabId: number, sessionId: string): Promise<void> {
  const id = notificationId('sem-audio', tabId, sessionId)
  const [title, shortcut] = await Promise.all([tabTitle(tabId), tabCommandShortcut(), languageReady()])
  const options: chrome.notifications.NotificationCreateOptions = {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title: t('notifNoAudioTitle'),
    message: t('notifNoAudioMessage', shortcutText(shortcut)),
    contextMessage: title || undefined,
    priority: 1,
  }
  await showNotification(id, options, true)
}

// ---------------------------------------------------------------------------------------------
// AC16: abas abertas antes da instalação ou atualização
// ---------------------------------------------------------------------------------------------

/** Motivo do último onInstalled visto por este SW (null: ninguém disparou, ex.: o teste). */
let lastInstallReason: string | null = null

/** ↻ e aviso "Recarregue a aba da call" numa aba (o registro em RELOAD_KEY é de quem chama). */
async function showReloadMark(tabId: number, tabTitleText: string | undefined): Promise<void> {
  await setBadge(tabId, 'recarregar')
  await languageReady()
  const options: chrome.notifications.NotificationCreateOptions = {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title: t('notifReloadTitle'),
    message: t('notifReloadMessage'),
    contextMessage: tabTitleText || undefined,
    // Recarregar sai da call que estiver aberta nela (Emenda 10): o botão diz isso.
    buttons: [{ title: t('notifReloadButton') }],
    priority: 1,
    requireInteraction: true,
  }
  await showNotification(notificationId('recarregar', tabId), options, false)
}

/**
 * AC16: na instalação/atualização, marca com ↻ as abas de call abertas antes (sem os content
 * scripts) e avisa para recarregar. Chamado pelo chrome.runtime.onInstalled do SW (index.ts) e
 * pelo gancho de teste. Na atualização do Chrome as abas reabrem com os content scripts, então
 * nada é marcado.
 */
export async function markTabsOpenedBeforeInstall(matches: readonly string[]): Promise<number[]> {
  if (!installReasonMarksTabs(lastInstallReason)) return []
  if (matches.length === 0) return []
  let tabs: chrome.tabs.Tab[]
  try {
    tabs = await chrome.tabs.query({ url: [...matches] })
  } catch (e) {
    log('tabs.query', e)
    return []
  }
  const stale = tabs.flatMap((t) => (t.id != null && isCallHostUrl(t.url) ? [t.id] : []))
  const callTabs = tabs.filter((t) => t.id != null && isCallTabUrl(t.url))
  const marked = callTabs.map((t) => t.id!)
  // Registra antes de mostrar: um hello que chegue no meio já encontra a aba e tira o ↻.
  await serial(async () => {
    await writeList(STALE_KEY, [...new Set([...(await readList<number>(STALE_KEY)), ...stale])])
    await writeList(RELOAD_KEY, [...new Set([...(await readList<number>(RELOAD_KEY)), ...marked])])
  })
  for (const tab of callTabs) await showReloadMark(tab.id!, tab.title)
  return marked
}

/**
 * Esquece a aba: um documento novo dela trouxe os content scripts, ela saiu dos hosts das calls
 * ou fechou. Tira o ↻ e o aviso, se ela estava marcada.
 */
async function forgetStaleTab(tabId: number, removed: boolean): Promise<void> {
  const had = await serial(async () => {
    const stale = await readList<number>(STALE_KEY)
    if (stale.includes(tabId)) await writeList(STALE_KEY, stale.filter((t) => t !== tabId))
    const list = await readList<number>(RELOAD_KEY)
    if (!list.includes(tabId)) return false
    await writeList(RELOAD_KEY, list.filter((t) => t !== tabId))
    return true
  })
  if (!had) return
  if (!removed) await setBadge(tabId, 'nenhum')
  await chrome.notifications.clear(notificationId('recarregar', tabId)).catch(() => {})
}

async function tabUrl(tabId: number): Promise<string | undefined> {
  try {
    return (await chrome.tabs.get(tabId)).url
  } catch {
    return undefined
  }
}

/**
 * tabs.onUpdated de uma aba sem os content scripts. O Chrome manda `status: 'loading'` (com a
 * URL nova) também em pushState, replaceState e troca de hash (medido no CfT, 06/10/2026), então
 * daqui não dá para saber se veio um documento novo: isso fica para o hello dos content scripts
 * (onConnect abaixo). Daqui só sai o que é certo:
 * - a aba foi para fora dos hosts das calls (sem permissão nesses hosts, o Chrome não dá a URL):
 *   é outro documento, e nenhum content script nosso vai rodar nele; esquece;
 * - a aba chegou a uma reunião sem documento novo (página inicial do Meet -> sala, ou o Teams
 *   depois de reaparecer): ganha o ↻ e o aviso, quando a carga termina (o hello de um documento
 *   novo chega antes disso e já a terá esquecido).
 */
async function onStaleTabUpdated(tabId: number, change: chrome.tabs.OnUpdatedInfo): Promise<void> {
  if (!change.url && change.status !== 'loading' && change.status !== 'complete') return
  if (!(await readList<number>(STALE_KEY)).includes(tabId)) return
  const url = change.url ?? (await tabUrl(tabId))
  if (!isCallHostUrl(url)) {
    await forgetStaleTab(tabId, false)
    return
  }
  if (change.status !== 'complete' || !isCallTabUrl(url)) return
  const added = await serial(async () => {
    if (!(await readList<number>(STALE_KEY)).includes(tabId)) return false
    const list = await readList<number>(RELOAD_KEY)
    if (list.includes(tabId)) return false
    await writeList(RELOAD_KEY, [...list, tabId])
    return true
  })
  if (added) await showReloadMark(tabId, await tabTitle(tabId))
}

/**
 * Um content script nosso, da frame do topo de uma aba de call, abriu um Port (o relay conecta
 * no hello que o MAIN world manda em todo documento dos hosts das calls; o vigia também
 * conecta): o documento atual da aba tem os scripts e já pode gravar.
 */
function onContentScriptPort(port: chrome.runtime.Port): void {
  const s = port.sender
  if (s?.id !== chrome.runtime.id || s.tab?.id == null || s.frameId !== 0 || !isCallHostUrl(s.url)) return
  void forgetStaleTab(s.tab.id, false)
}

// ---------------------------------------------------------------------------------------------
// Cliques
// ---------------------------------------------------------------------------------------------

export interface NotificationClickResult {
  ok: boolean
  tabId?: number
  action?: 'focar' | 'recarregar'
  error?: string
}

async function focusTab(tabId: number): Promise<void> {
  const tab = await chrome.tabs.update(tabId, { active: true })
  if (tab?.windowId != null) await chrome.windows.update(tab.windowId, { focused: true })
}

/** Clique numa notificação nossa (button null: no corpo; 0: primeiro botão). */
async function handleNotificationClick(id: string, button: number | null): Promise<NotificationClickResult> {
  const parsed = parseNotificationId(id)
  if (!parsed) return { ok: false, error: 'notificação desconhecida' }
  const { kind, tabId } = parsed
  try {
    const action = kind === 'recarregar' && button === 0 ? 'recarregar' : 'focar'
    if (action === 'recarregar') await chrome.tabs.reload(tabId)
    await focusTab(tabId)
    await chrome.notifications.clear(id).catch(() => {})
    return { ok: true, tabId, action }
  } catch (e) {
    // A aba já fechou: some com o aviso.
    await chrome.notifications.clear(id).catch(() => {})
    return { ok: false, tabId, error: String((e as Error)?.message ?? e) }
  }
}

/**
 * Ouvintes do badge e das notificações, registrados no carregamento do SW por index.ts (os
 * ouvintes de eventos do SW precisam existir no topo). Este onInstalled é registrado antes do de
 * index.ts, então o motivo já está guardado quando markTabsOpenedBeforeInstall roda.
 */
export function registerBadge(): void {
  // AC13 e AC16 sem reinstalar a extensão nem esperar 60 s (o teste chama direto).
  registerTestHooks({ markTabsOpenedBeforeInstall, notifyNoAudio, handleNotificationClick, setBadge })
  chrome.runtime.onInstalled.addListener((details) => {
    lastInstallReason = details.reason
  })
  chrome.notifications.onClicked.addListener((id) => void handleNotificationClick(id, null))
  chrome.notifications.onButtonClicked.addListener((id, button) => void handleNotificationClick(id, button))
  chrome.runtime.onConnect.addListener(onContentScriptPort)
  chrome.tabs.onUpdated.addListener((tabId, change) => void onStaleTabUpdated(tabId, change))
  chrome.tabs.onRemoved.addListener((tabId) => void forgetStaleTab(tabId, true))
  // Emenda 19: o idioma escolhido nas configurações mudou (o storage.onChanged acorda o SW).
  onLanguageChange(() => void refreshActionTitles())
}
