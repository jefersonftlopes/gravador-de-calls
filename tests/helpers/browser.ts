// Sobe o Chrome for Testing com a extensão de dist/, num perfil temporário, com o helper
// instalado SÓ em <user-data-dir>/NativeMessagingHosts (o Chromium resolve
// DIR_USER_NATIVE_MESSAGING como <user-data-dir>/NativeMessagingHosts no Mac e no Linux).
// Nada toca o perfil real do Chrome nem ~/Library/Application Support/Google/Chrome.
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type BrowserContext, type Page, type Worker } from '@playwright/test'
import type { Settings } from '../../src/shared/protocol'
import { CALL_HOSTS, installDefaultRoutes } from '../fixtures/routes'
import { extensionId as extensionIdFromRepo } from '../../scripts/extension-id.mjs'
import { ARTIFACTS, DIST, MIC_WAV, ROOT, chromiumPath } from './paths'

/**
 * ID fixo da extensão (chave pública versionada em extension-key.json). Serve para flags que
 * precisam do ID antes de abrir o navegador, como --allowlisted-extension-id (modo aba).
 */
export const EXTENSION_ID: string = extensionIdFromRepo()

// Lista de features que o Playwright já desliga (o Chrome usa o ÚLTIMO --disable-features,
// então repetimos a dele) + WebRtcHideLocalIpsWithMdns, para os candidatos ICE entre as duas
// abas de teste serem IPs de loopback em vez de nomes .local que dependem do mDNS do sistema.
const DISABLED_FEATURES = [
  'AvoidUnnecessaryBeforeUnloadCheckSync',
  'DestroyProfileOnBrowserClose',
  'DialMediaRouteProvider',
  'GlobalMediaControls',
  'HttpsUpgrades',
  'LensOverlay',
  'MediaRouter',
  'PaintHolding',
  'ThirdPartyStoragePartitioning',
  'BlockOriginHeaderModificationOnRedirect',
  'Translate',
  'AutoDeElevate',
  'OptimizationHints',
  'WebRtcHideLocalIpsWithMdns',
]

/** Erro de console ou de página vindo de uma aba de call (AC14: com a extensão, nenhum novo). */
export interface PageError {
  url: string
  kind: 'console' | 'pageerror'
  text: string
}

export interface Harness {
  context: BrowserContext
  /** Linhas de console com "[gravador" das páginas e do SW (anexadas ao relatório se falhar). */
  logs: string[]
  /**
   * Erros de console (tipo `error`) e exceções não tratadas das abas nos hosts de call. Inclui
   * as violações de Trusted Types, que o Chrome registra como erro de console mesmo quando o
   * nosso try/catch engole a exceção.
   */
  pageErrors: PageError[]
  sw: Worker
  /** Pasta temporária do teste: perfil, raiz, helper, downloads. */
  base: string
  userDataDir: string
  root: string
  hostLog: string
  /** Pasta de downloads do perfil (só com `downloads: true`; senão null). */
  downloadsDir: string | null
  /**
   * Fecha o Chrome (como o usuário fechando a janela) e abre de novo no MESMO perfil, com o
   * mesmo helper e a mesma raiz. As configurações do primeiro launch não são regravadas (o
   * perfil guarda o que tinha). O Harness antigo não serve mais depois disto.
   */
  relaunch(opts?: Omit<LaunchOptions, 'base' | 'root'>): Promise<Harness>
  /**
   * Mata o processo do Chrome com SIGKILL (queda, sem pagehide nem onRemoved). Depois disto só
   * `relaunch()` ou `close()`.
   */
  crash(): Promise<void>
  close(): Promise<void>
}

/** Raiz padrão do ESPEC: os testes nunca podem criar nada aqui. */
export const REAL_DEFAULT_ROOT = join(homedir(), 'Documents', 'Gravações de calls')
/** Reserva downloads (AC9) no perfil real: os testes nunca podem criar nada aqui. */
export const REAL_DOWNLOADS_FOLDER = join(homedir(), 'Downloads', 'Gravações de calls')
/** A mesma reserva com a interface em inglês (Emenda 15). */
export const REAL_DOWNLOADS_FOLDER_EN = join(homedir(), 'Downloads', 'Call recordings')

/** Idioma da interface do Chrome nos testes (Emenda 15). */
export type UiLocale = 'pt-BR' | 'en-US'

/** Opções do launchPersistentContext que o harness deixa passar (o resto é dele). */
export type ContextOptions = Omit<
  NonNullable<Parameters<typeof chromium.launchPersistentContext>[1]>,
  'executablePath' | 'headless' | 'args' | 'ignoreDefaultArgs' | 'acceptDownloads' | 'downloadsPath'
>

export interface LaunchOptions {
  settings?: Partial<Omit<Settings, 'profileId'>>
  /**
   * Idioma da interface do Chrome (Emenda 15). Padrão pt-BR: os testes antigos conferem os textos
   * em português. No macOS o Chrome ignora --lang e usa o AppleLanguages do processo, então o
   * harness abre o Chrome for Testing por um wrapper que passa `-AppleLanguages (<idioma>)` (ver
   * localeExecutable). Vale no relaunch.
   */
  locale?: UiLocale
  /**
   * Aviso da primeira execução (Emenda 15). Padrão: o harness espera a página de boas-vindas que
   * a instalação abre, confirma o aviso (como o "Entendi") e fecha a página, para os testes antigos
   * gravarem sozinhos como antes. `false`: deixa a página aberta e o aviso sem confirmar.
   */
  consent?: boolean
  installHost?: boolean
  /** Raiz compartilhada (dois perfis gravando na mesma raiz). Padrão: uma raiz temporária nova. */
  root?: string
  /**
   * Seção `transcricao` do config.json do helper (Emenda 13). Padrão nos testes: desligada, porque
   * a padrão do produto é ligada e descobriria o whisper e o modelo de verdade desta máquina. Os
   * testes da transcrição passam os programas falsos (tests/helpers/fake-transcricao.ts).
   */
  transcricao?: Record<string, unknown>
  /**
   * Pasta temporária de um launch anterior (perfil, helper e raiz dela são reaproveitados).
   * Prefira `harness.relaunch()`; isto existe para quem precisa montar o perfil antes.
   */
  base?: string
  /**
   * Flags a mais para o Chrome for Testing (ex.: `--allowlisted-extension-id=${EXTENSION_ID}`
   * no modo aba). Vão depois das padrão. Não use para --disable-features (o Chrome só lê o
   * último): para isso, mude DISABLED_FEATURES.
   */
  extraArgs?: string[]
  /**
   * Rotas a mais (ex.: as páginas falsas do Teams). Instaladas DEPOIS das padrão
   * (tests/fixtures/routes.ts), então têm precedência; use route.fallback() para devolver o
   * pedido às padrão.
   */
  routes?: (context: BrowserContext) => Promise<void>
  /** false: não instala as rotas padrão (Meet e /__peer). */
  defaultRoutes?: boolean
  /** Opções a mais do launchPersistentContext (viewport, locale, permissions...). */
  contextOptions?: ContextOptions
  /**
   * Roda antes de abrir o Chrome, com o perfil já criado (ex.: escrever arquivos no perfil).
   * Para downloads use `downloads: true`, que já faz isso direito.
   */
  beforeLaunch?: (dirs: { base: string; userDataDir: string }) => void | Promise<void>
  /**
   * Downloads de verdade (reserva do AC9, chrome.downloads com subpastas): a pasta de downloads
   * do perfil vira `<base>/downloads` (Default/Preferences semeado antes de abrir) e o
   * comportamento padrão do Chrome volta (o Playwright troca os nomes por GUIDs). Um download de
   * canário confere que o arquivo caiu na pasta temporária antes de o teste começar.
   */
  downloads?: boolean
  /**
   * Modo aba de verdade (Emenda 7; medido no CfT 151 em 06/10/2026). Três trocas de flag:
   * - sem `--mute-audio` (padrão do Playwright): com ela a captura da aba chega em silêncio;
   * - sem `--use-fake-ui-for-media-stream`: com ela o getUserMedia de chromeMediaSource 'tab'
   *   falha com "Requested device not found". No lugar, `--auto-accept-camera-and-microphone-capture`
   *   aceita o microfone falso das páginas de call;
   * - com `--disable-audio-output`: sem o mudo, o som que o offscreen devolve sairia nos
   *   alto-falantes da máquina; assim o AudioContext roda num destino falso, no mesmo relógio.
   * E `--allowlisted-extension-id`, que libera o getMediaStreamId sem gesto. Vale no relaunch.
   */
  tabCapture?: boolean
  /**
   * `false` tira o `--use-fake-ui-for-media-stream` (que aceita todo pedido de mídia sem
   * perguntar), SEM ligar as outras flags do modo aba. Serve para medir o que acontece quando a
   * permissão do microfone NÃO está concedida (Emenda 25): no headless não há ninguém para clicar,
   * então o pedido fica pendente, e com `--deny-permission-prompts` ele é negado. Vale no relaunch.
   */
  fakeMediaUi?: boolean
  /**
   * Pasta da extensão carregada (padrão: dist/). A recarga sozinha (Emenda 17) é testada com uma
   * cópia publicada pelo scripts/publicar.mjs numa pasta temporária, que tem o publicado.json.
   */
  extensionDir?: string
  /**
   * Modo de desenvolvedor do perfil ligado (chrome://extensions), como nos perfis de verdade que
   * carregam a extensão sem compactação. Medido no Chrome for Testing (08/10/2026): sem ele,
   * chrome.runtime.reload() numa extensão do --load-extension a deixa desligada
   * ("unsupportedDeveloperExtension"); com ele, ela volta. Os testes da recarga (Emenda 17) ligam.
   */
  developerMode?: boolean
}

/** Erros de página que não são da extensão nem da página de teste (o Chrome headless). */
const IGNORED_PAGE_ERRORS: RegExp[] = []

function isCallHost(url: string): boolean {
  try {
    return CALL_HOSTS.includes(new URL(url).hostname)
  } catch {
    return false
  }
}

/** Mesma escrita de Preferences que o Chrome lê na abertura (download.default_directory). */
function seedDownloadPrefs(userDataDir: string, dir: string): void {
  const prefsFile = join(userDataDir, 'Default', 'Preferences')
  mkdirSync(join(userDataDir, 'Default'), { recursive: true })
  let prefs: Record<string, unknown> = {}
  if (existsSync(prefsFile)) {
    try {
      prefs = JSON.parse(readFileSync(prefsFile, 'utf8')) as Record<string, unknown>
    } catch {
      prefs = {}
    }
  }
  const download = { ...((prefs.download as object | undefined) ?? {}), default_directory: dir, prompt_for_download: false, directory_upgrade: true }
  prefs.download = download
  prefs.savefile = { ...((prefs.savefile as object | undefined) ?? {}), default_directory: dir }
  writeFileSync(prefsFile, JSON.stringify(prefs))
}

/**
 * Emenda 25: escreve no perfil a permissão do microfone CONCEDIDA para a origem
 * `chrome-extension://<id>`, que é exatamente o que o clique em "Permitir" no diálogo do Chrome
 * grava (`profile.content_settings.exceptions.media_stream_mic`). No headless não há ninguém para
 * clicar, e o CDP recusa conceder permissão a uma origem de extensão ("opaque origins"), então é
 * assim que o teste faz o papel do clique que a página de configurações provoca. Mesma técnica do
 * `seedDownloadPrefs` acima: o Chrome lê o Preferences na abertura.
 */
export function seedMicPermission(userDataDir: string): void {
  const file = join(userDataDir, 'Default', 'Preferences')
  mkdirSync(join(userDataDir, 'Default'), { recursive: true })
  const prefs: Record<string, unknown> = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>) : {}
  const profile = { ...((prefs.profile as Record<string, unknown> | undefined) ?? {}) }
  const content = { ...((profile.content_settings as Record<string, unknown> | undefined) ?? {}) }
  const exceptions = { ...((content.exceptions as Record<string, unknown> | undefined) ?? {}) }
  exceptions.media_stream_mic = {
    // 1 = ALLOW. O `last_modified` é em microssegundos desde a época do Windows, como o Chrome grava.
    [`chrome-extension://${EXTENSION_ID}/,*`]: { last_modified: String((Date.now() + 11_644_473_600_000) * 1000), setting: 1 },
  }
  content.exceptions = exceptions
  profile.content_settings = content
  prefs.profile = profile
  writeFileSync(file, JSON.stringify(prefs))
}

/** PID do processo principal do Chrome deste perfil (filho deste processo Node). */
function browserPid(userDataDir: string): number | null {
  const out = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    if (!m) continue
    if (Number(m[2]) !== process.pid) continue
    if (m[3].includes(`--user-data-dir=${userDataDir}`)) return Number(m[1])
  }
  return null
}

interface LaunchState {
  first: boolean
  realRootExisted: boolean
  realDownloadsExisted: boolean
  realDownloadsEnExisted: boolean
}

/**
 * O Chrome for Testing no idioma pedido. No macOS, um wrapper (em test-results, gerado a cada
 * launch) que tira o `about:blank` do Playwright e passa `-AppleLanguages (<idioma>)`: o macOS lê
 * esse par como preferência do processo, e o Chrome o abre como a única página inicial
 * (http://(pt-br)/, que dá erro de DNS sem sair da máquina; o harness troca por about:blank). O
 * headless recusa duas páginas iniciais, por isso o about:blank sai.
 */
function localeExecutable(locale: UiLocale): string {
  const real = chromiumPath()
  if (process.platform !== 'darwin') return real
  mkdirSync(ARTIFACTS, { recursive: true })
  const wrapper = join(ARTIFACTS, `chrome-${locale}.sh`)
  const body = [
    '#!/bin/bash',
    '# Gerado por tests/helpers/browser.ts (localeExecutable): Chrome for Testing com o idioma da interface.',
    'args=()',
    'for a in "$@"; do [ "$a" = "about:blank" ] || args+=("$a"); done',
    `exec ${JSON.stringify(real)} "\${args[@]}" -AppleLanguages "(${locale})"`,
    '',
  ].join('\n')
  if (!existsSync(wrapper) || readFileSync(wrapper, 'utf8') !== body) writeFileSync(wrapper, body)
  chmodSync(wrapper, 0o755)
  return wrapper
}

/** Página de boas-vindas que a instalação abre (src/welcome, Emenda 15). */
export const isWelcomePage = (url: string) => url.startsWith(`chrome-extension://${EXTENSION_ID}/src/welcome/`)

/**
 * Espera a página de boas-vindas da instalação (o SW a abre no onInstalled). Registra a espera
 * antes de olhar as páginas abertas, para não perder uma que abra no meio.
 */
export async function waitWelcomePage(context: BrowserContext, timeout = 15_000): Promise<Page> {
  const waiting = context.waitForEvent('page', { predicate: (p) => isWelcomePage(p.url()), timeout })
  const open = context.pages().find((p) => isWelcomePage(p.url()))
  if (open) {
    waiting.catch(() => {})
    return open
  }
  return waiting
}

export async function launchWithExtension(opts: LaunchOptions = {}): Promise<Harness> {
  const state: LaunchState = {
    first: !opts.base,
    realRootExisted: existsSync(REAL_DEFAULT_ROOT),
    realDownloadsExisted: existsSync(REAL_DOWNLOADS_FOLDER),
    realDownloadsEnExisted: existsSync(REAL_DOWNLOADS_FOLDER_EN),
  }
  return launchInternal(opts, state)
}

async function launchInternal(opts: LaunchOptions, state: LaunchState): Promise<Harness> {
  const base = opts.base ?? mkdtempSync(join(tmpdir(), 'gravador-e2e-'))
  const userDataDir = join(base, 'perfil')
  // A raiz é do helper (Emenda 1): config.json próprio do teste, exportado pelo wrapper. No
  // relaunch a raiz sai do config que já existe.
  const hostConfig = join(base, 'helper-config', 'config.json')
  const root: string =
    opts.root ?? (existsSync(hostConfig) ? (JSON.parse(readFileSync(hostConfig, 'utf8')) as { root: string }).root : join(base, 'Gravações de calls'))
  const hostLog = join(base, 'helper.log')
  mkdirSync(userDataDir, { recursive: true })
  mkdirSync(join(base, 'helper-config'), { recursive: true })
  if (!existsSync(hostConfig) || opts.root || opts.transcricao) {
    const prev = existsSync(hostConfig) ? (JSON.parse(readFileSync(hostConfig, 'utf8')) as Record<string, unknown>) : {}
    writeFileSync(hostConfig, JSON.stringify({ ...prev, root, transcricao: opts.transcricao ?? prev.transcricao ?? { ativa: false } }))
  }
  if (opts.installHost !== false) {
    execFileSync(process.execPath, [
      join(ROOT, 'host', 'instalar.mjs'),
      '--dir',
      join(userDataDir, 'NativeMessagingHosts'),
      '--wrapper',
      join(base, 'gravador-host.sh'),
      '--config',
      hostConfig,
      '--log',
      hostLog,
    ])
  }
  const downloadsDir = opts.downloads ? join(base, 'downloads') : null
  if (downloadsDir) {
    mkdirSync(downloadsDir, { recursive: true })
    seedDownloadPrefs(userDataDir, downloadsDir)
  }
  if (opts.beforeLaunch) await opts.beforeLaunch({ base, userDataDir })
  const baseArgs = opts.tabCapture
    ? [...BASE_ARGS.filter((a) => a !== FAKE_UI_ARG), ...TAB_CAPTURE_ARGS]
    : opts.fakeMediaUi === false
      ? BASE_ARGS.filter((a) => a !== FAKE_UI_ARG)
      : BASE_ARGS
  const locale = opts.locale ?? 'pt-BR'
  const context = await chromium.launchPersistentContext(userDataDir, {
    ...opts.contextOptions,
    executablePath: localeExecutable(locale),
    headless: true,
    // Sem --autoplay-policy=no-user-gesture-required: a página da call recebe um clique real.
    ignoreDefaultArgs: ['--disable-extensions', ...(opts.tabCapture ? ['--mute-audio'] : [])],
    args: [
      `--disable-extensions-except=${opts.extensionDir ?? DIST}`,
      `--load-extension=${opts.extensionDir ?? DIST}`,
      // Linux e Windows leem o idioma daqui; o macOS, do wrapper de localeExecutable.
      `--lang=${locale}`,
      ...baseArgs,
      ...(opts.extraArgs ?? []),
    ],
  })
  const { logs, pageErrors } = watchConsole(context)
  if (opts.defaultRoutes !== false) await installDefaultRoutes(context)
  if (opts.routes) await opts.routes(context)
  const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker', { timeout: 15_000 }))
  if (new URL(sw.url()).host !== EXTENSION_ID) {
    await context.close()
    throw new Error(`ID da extensão inesperado: ${sw.url()} (esperado ${EXTENSION_ID})`)
  }
  // A página inicial do wrapper do idioma (erro de DNS) vira about:blank.
  for (const p of context.pages()) if (/^(chrome-error:|http:\/\/\()/.test(p.url())) await p.goto('about:blank').catch(() => {})
  // Emenda 15: a instalação abre a página de boas-vindas; o aviso é confirmado como o "Entendi"
  // faria (a não ser com consent: false) e a página fecha.
  const hasConsent = async () => (await sw.evaluate(async () => (await chrome.storage.local.get('consent')).consent ?? null)) !== null
  if (state.first) {
    const welcome = await waitWelcomePage(context).catch(async (e) => {
      await context.close()
      throw new Error(`a página de boas-vindas não abriu na instalação: ${(e as Error).message}`)
    })
    if (opts.consent !== false) {
      await welcome.getByTestId('entendi').click()
      await welcome.getByTestId('confirmado').waitFor()
      await welcome.close()
    }
  } else if (opts.consent !== false && !(await hasConsent())) {
    await sw.evaluate(() => chrome.storage.local.set({ consent: { version: 1, at: Date.now(), via: 'pagina' } }))
  }
  if (state.first || opts.settings) {
    const settings = state.first ? { autoMeet: true, autoTeams: true, minSeconds: 5, ...opts.settings } : opts.settings
    await sw.evaluate(async (s) => {
      const cur = ((await chrome.storage.local.get('settings')).settings ?? {}) as object
      await chrome.storage.local.set({ settings: { ...cur, ...s } })
    }, settings)
  }
  if (opts.installHost !== false) {
    // Confere que o helper usa a raiz temporária (proteção contra gravar na pasta real).
    const ping = (await sw.evaluate(() =>
      (globalThis as unknown as { __gravador: { pingHost(f: boolean): Promise<unknown> } }).__gravador.pingHost(true),
    )) as { ok: boolean; root: string | null }
    if (!ping.ok || ping.root !== root) {
      await context.close()
      throw new Error(`helper não usa a raiz de teste: ${JSON.stringify(ping)}`)
    }
  }
  if (downloadsDir) await enableRealDownloads(context, sw, downloadsDir)
  if (opts.developerMode) await enableDeveloperMode(context)

  let closed = false
  context.on('close', () => {
    closed = true
  })
  const checkReal = () => {
    if (!state.realRootExisted && existsSync(REAL_DEFAULT_ROOT)) {
      throw new Error(`o teste criou ${REAL_DEFAULT_ROOT}: a raiz temporária não foi usada`)
    }
    if (!state.realDownloadsExisted && existsSync(REAL_DOWNLOADS_FOLDER)) {
      throw new Error(`o teste criou ${REAL_DOWNLOADS_FOLDER}: a pasta de downloads temporária não foi usada`)
    }
    if (!state.realDownloadsEnExisted && existsSync(REAL_DOWNLOADS_FOLDER_EN)) {
      throw new Error(`o teste criou ${REAL_DOWNLOADS_FOLDER_EN}: a pasta de downloads temporária não foi usada`)
    }
  }
  const h: Harness = {
    context,
    logs,
    pageErrors,
    sw,
    base,
    userDataDir,
    root,
    hostLog,
    downloadsDir,
    async relaunch(more = {}) {
      if (!closed) await context.close().catch(() => {})
      checkReal()
      const keep: LaunchOptions = {
        installHost: opts.installHost,
        extraArgs: opts.extraArgs,
        routes: opts.routes,
        defaultRoutes: opts.defaultRoutes,
        contextOptions: opts.contextOptions,
        downloads: opts.downloads,
        tabCapture: opts.tabCapture,
        fakeMediaUi: opts.fakeMediaUi,
        locale: opts.locale,
        consent: opts.consent,
        extensionDir: opts.extensionDir,
        developerMode: opts.developerMode,
      }
      // A transcrição já ficou no config.json do primeiro launch.
      return launchInternal({ ...keep, ...more, base }, { ...state, first: false })
    },
    async crash() {
      const pid = browserPid(userDataDir)
      if (pid == null) throw new Error('processo do Chrome deste perfil não encontrado')
      const gone = closed ? Promise.resolve() : new Promise<void>((r) => context.once('close', () => r()))
      process.kill(pid, 'SIGKILL')
      await gone
    },
    async close() {
      if (!closed) await context.close().catch(() => {})
      checkReal()
      if (!process.env.GRAVADOR_MANTER_TMP) rmSync(base, { recursive: true, force: true })
    },
  }
  return h
}

const FAKE_UI_ARG = '--use-fake-ui-for-media-stream'

/** Flags comuns a todo Chrome dos testes (com ou sem extensão). */
const BASE_ARGS = [
  FAKE_UI_ARG,
  '--use-fake-device-for-media-stream',
  `--use-file-for-fake-audio-capture=${MIC_WAV}`,
  `--disable-features=${DISABLED_FEATURES.join(',')}`,
]

/** `LaunchOptions.tabCapture`: o que entra no lugar de FAKE_UI_ARG (ver a opção). */
const TAB_CAPTURE_ARGS = ['--auto-accept-camera-and-microphone-capture', '--disable-audio-output', `--allowlisted-extension-id=${EXTENSION_ID}`]

function watchConsole(context: BrowserContext): { logs: string[]; pageErrors: PageError[] } {
  const logs: string[] = []
  const pageErrors: PageError[] = []
  const t0 = Date.now()
  const keep = (where: string) => (msg: { text(): string; type(): string }) => {
    const text = msg.text()
    if (text.includes('[gravador') || msg.type() === 'error') logs.push(`${((Date.now() - t0) / 1000).toFixed(1)}s ${where} ${msg.type()}: ${text}`)
  }
  const onPage = (p: Page) => {
    p.on('console', (msg) => {
      keep(new URL(p.url() || 'about:blank').pathname || 'pagina')(msg)
      if (msg.type() === 'error' && isCallHost(p.url()) && !IGNORED_PAGE_ERRORS.some((r) => r.test(msg.text()))) {
        pageErrors.push({ url: p.url(), kind: 'console', text: msg.text() })
      }
    })
    p.on('pageerror', (e) => {
      if (isCallHost(p.url())) pageErrors.push({ url: p.url(), kind: 'pageerror', text: e.message })
    })
  }
  for (const p of context.pages()) onPage(p)
  context.on('page', onPage)
  context.on('console', (msg) => {
    if (!msg.page()) keep('sw')(msg)
  })
  return { logs, pageErrors }
}

/**
 * Volta o download ao comportamento padrão do Chrome (o Playwright força "allowAndName", que
 * troca o nome por um GUID e ignora as subpastas do chrome.downloads) e confere com um canário
 * que o arquivo cai em `dir`. Se cair em outro lugar, para tudo e diz onde ficou.
 */
async function enableRealDownloads(context: BrowserContext, sw: Worker, dir: string): Promise<void> {
  const page = await context.newPage()
  try {
    const cdp = await context.newCDPSession(page)
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'default' })
    await cdp.detach()
  } finally {
    await page.close()
  }
  const r = (await sw.evaluate(async () => {
    const id = await chrome.downloads.download({
      url: 'data:application/octet-stream;base64,',
      filename: 'gravador-canario/ok.bin',
      conflictAction: 'uniquify',
      saveAs: false,
    })
    for (let i = 0; i < 100; i++) {
      const [d] = await chrome.downloads.search({ id })
      if (d && d.state !== 'in_progress') {
        await chrome.downloads.erase({ id })
        return { state: d.state, filename: d.filename, error: d.error ?? null }
      }
      await new Promise((res) => setTimeout(res, 100))
    }
    return { state: 'timeout', filename: '', error: null }
  })) as { state: string; filename: string; error: string | null }
  if (r.state !== 'complete' || !r.filename.startsWith(dir + '/')) {
    await context.close()
    throw new Error(`downloads fora da pasta temporária: ${JSON.stringify(r)} (esperado dentro de ${dir}). Confira e apague à mão se for o caso.`)
  }
}

/** Liga o modo de desenvolvedor do perfil pela página chrome://extensions (ver `developerMode`). */
async function enableDeveloperMode(context: BrowserContext): Promise<void> {
  const page = await context.newPage()
  try {
    await page.goto('chrome://extensions')
    const on = await page.evaluate(async () => {
      const dev = (chrome as unknown as { developerPrivate: { updateProfileConfiguration(c: object): Promise<void>; getProfileConfiguration(): Promise<{ inDeveloperMode: boolean }> } }).developerPrivate
      await dev.updateProfileConfiguration({ inDeveloperMode: true })
      return (await dev.getProfileConfiguration()).inDeveloperMode
    })
    if (!on) throw new Error('o modo de desenvolvedor não ligou')
  } finally {
    await page.close()
  }
}

/**
 * Chrome for Testing SEM a extensão, com as mesmas flags, rotas e páginas falsas. Serve de
 * controle para os testes de integridade (AC14): o que a página mede sem a extensão tem de
 * bater com o que ela mede com a extensão.
 */
export async function launchWithoutExtension(opts: Pick<LaunchOptions, 'routes' | 'defaultRoutes' | 'extraArgs' | 'contextOptions'> = {}) {
  const base = mkdtempSync(join(tmpdir(), 'gravador-e2e-sem-'))
  const context = await chromium.launchPersistentContext(join(base, 'perfil'), {
    ...opts.contextOptions,
    executablePath: chromiumPath(),
    headless: true,
    args: [...BASE_ARGS, ...(opts.extraArgs ?? [])],
  })
  const { logs, pageErrors } = watchConsole(context)
  if (opts.defaultRoutes !== false) await installDefaultRoutes(context)
  if (opts.routes) await opts.routes(context)
  return {
    context,
    logs,
    pageErrors,
    async close() {
      await context.close().catch(() => {})
      if (!process.env.GRAVADOR_MANTER_TMP) rmSync(base, { recursive: true, force: true })
    },
  }
}

/**
 * Para o service worker da extensão pelo CDP (ServiceWorker.stopAllWorkers numa página da
 * própria extensão, que está na mesma partição do SW). Devolve os estados vistos, para o teste
 * provar que ele parou mesmo.
 */
export async function stopExtensionServiceWorker(h: Harness): Promise<string[]> {
  const id = new URL(h.sw.url()).host
  const page = await h.context.newPage()
  // A página de opções não fala com o SW sozinha (o popup acordaria o SW a cada 1 s).
  await page.goto(`chrome-extension://${id}/src/options/index.html`)
  const cdp = await h.context.newCDPSession(page)
  const seen: string[] = []
  cdp.on('ServiceWorker.workerVersionUpdated', (e: { versions: Array<{ runningStatus: string }> }) => {
    for (const v of e.versions) seen.push(v.runningStatus)
  })
  await cdp.send('ServiceWorker.enable')
  await cdp.send('ServiceWorker.stopAllWorkers')
  await page.waitForTimeout(500)
  await cdp.detach()
  await page.close()
  return seen
}

/** O Worker atual do SW (depois de um reinício o objeto antigo não serve mais). */
export async function currentServiceWorker(h: Harness): Promise<Worker> {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    for (const w of h.context.serviceWorkers()) {
      try {
        if (await w.evaluate(() => typeof (globalThis as { __gravador?: unknown }).__gravador === 'object')) return w
      } catch {
        // worker morto
      }
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error('service worker não voltou')
}

/** Atalhos para o gancho de teste do SW (globalThis.__gravador). */
export function swApi(sw: Worker) {
  type Api = {
    activeRecordings(): Promise<Array<{ sessionId: string; tabId: number }>>
    listSessions(): Promise<Array<{ sessionId: string; status: string }>>
    countChunks(id?: string): Promise<number>
    pingHost(force?: boolean): Promise<{ ok: boolean; version: string | null; root: string | null; writable: boolean; error: string | null }>
  }
  const call = <K extends keyof Api>(name: K, ...args: Parameters<Api[K]>) =>
    sw.evaluate(
      ([n, a]) => (globalThis as unknown as { __gravador: Record<string, (...x: unknown[]) => unknown> }).__gravador[n](...a),
      [name, args] as [string, unknown[]],
    ) as ReturnType<Api[K]>
  type Testing = { holdPersistAt(seq: number | null): void; heldPersistSeq(): number | null; delayFinalize(ms: number): void }
  return {
    activeRecordings: () => call('activeRecordings'),
    listSessions: () => call('listSessions'),
    countChunks: (id?: string) => call('countChunks', id),
    pingHost: (force = true) => call('pingHost', force),
    /** O chunk `seq` para antes do IndexedDB até o SW morrer (ver sessions.ts, `testing`). */
    holdPersistAt: (seq: number | null) =>
      sw.evaluate((a) => (globalThis as unknown as { __gravador: { testing: Testing } }).__gravador.testing.holdPersistAt(a), seq),
    /** Cada finalização espera `ms` depois de virar "finalizando" (ver sessions.ts, `testing`). */
    delayFinalize: (ms: number) =>
      sw.evaluate((a) => (globalThis as unknown as { __gravador: { testing: Testing } }).__gravador.testing.delayFinalize(a), ms),
    heldPersistSeq: () =>
      sw.evaluate(() => (globalThis as unknown as { __gravador: { testing: Testing } }).__gravador.testing.heldPersistSeq()),
    /**
     * Chama um gancho do registro `__gravador.testing` (src/background/testing.ts) pelo nome.
     * Cada fatia registra os seus (toggleTabCapture, noAudioAlertMs, markTabsOpenedBeforeInstall...).
     */
    testing: <T = unknown>(name: string, ...args: unknown[]) =>
      sw.evaluate(
        async ([n, a]) => {
          const hooks = (globalThis as unknown as { __gravador: { testing: Record<string, (...x: unknown[]) => unknown> } }).__gravador.testing
          if (typeof hooks[n] !== 'function') throw new Error(`gancho de teste inexistente: ${n} (há: ${Object.keys(hooks).join(', ')})`)
          return hooks[n](...a)
        },
        [name, args] as [string, unknown[]],
      ) as Promise<T>,
    /** Nomes dos ganchos registrados. */
    testingHooks: () =>
      sw.evaluate(() => Object.keys((globalThis as unknown as { __gravador: { testing: object } }).__gravador.testing).sort()),
  }
}
