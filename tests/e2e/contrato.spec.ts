// Contratos que as próximas fatias usam (ARQUITETURA, Emenda 4), conferidos no Chrome de verdade:
// o documento offscreen único com o roteador por fatia, a extensibilidade do harness (rotas e
// flags a mais, ID fixo) e os invariantes do construtor embrulhado (regra 7).
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { EXTENSION_ID, launchWithExtension, swApi, type Harness } from '../helpers/browser'
import { fulfillHtml } from '../fixtures/routes'

let h: Harness | undefined

test.afterEach(async ({}, testInfo) => {
  if (h && testInfo.status !== testInfo.expectedStatus) console.log(h.logs.join('\n'))
  await h?.close()
  h = undefined
})

test('documento offscreen: um só, mesmo com chamadas simultâneas, e o roteador responde por fatia', async () => {
  h = await launchWithExtension({ installHost: false })
  const r = await h.sw.evaluate(async () => {
    const g = (globalThis as any).__gravador
    await Promise.all([g.ensureOffscreen(), g.ensureOffscreen(), g.ensureOffscreen()])
    await g.ensureOffscreen()
    const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT' as chrome.runtime.ContextType] })
    const revoke = await g.sendToOffscreen({ target: 'offscreen', t: 'offscreen:revoke', url: 'blob:nada' })
    const tabStop = await g.sendToOffscreen({ target: 'offscreen', t: 'offscreen:tab-stop', tabId: 1 })
    return { count: contexts.length, url: contexts[0]?.documentUrl ?? null, revoke, tabStop }
  })
  expect(r).toEqual({
    count: 1,
    url: `chrome-extension://${EXTENSION_ID}/src/offscreen/offscreen.html`,
    revoke: { ok: true },
    tabStop: { ok: true },
  })
})

test('harness: rotas e flags a mais, e o hook entra também nos hosts do Teams', async () => {
  const flag = `--allowlisted-extension-id=${EXTENSION_ID}`
  h = await launchWithExtension({
    installHost: false,
    extraArgs: [flag],
    routes: async (context) => {
      // Rota de uma fatia: tem precedência sobre as padrão e devolve o /__peer para elas.
      await context.route('https://teams.microsoft.com/**', (route) => {
        if (new URL(route.request().url()).pathname === '/__peer') return route.fallback()
        return fulfillHtml(route, '<!doctype html><title>Teams falso</title><p id="ok">teams</p>')
      })
    },
  })
  const page = await h.context.newPage()
  await page.goto('https://teams.microsoft.com/v2/')
  await expect(page.locator('#ok')).toHaveText('teams')
  expect(await page.evaluate(() => (window as any)[Symbol.for('gravador.hook')])).toBe(true)
  await page.goto('https://teams.microsoft.com/__peer?tom=660&sala=t')
  await expect(page.locator('#iniciar')).toBeVisible()

  const version = await h.context.newPage()
  await version.goto('chrome://version')
  expect(await version.locator('#command_line').textContent()).toContain(flag)
})

test('construtor embrulhado preserva instanceof, protótipo, constructor e estáticos (regra 7)', async () => {
  h = await launchWithExtension({ installHost: false })
  const page = await h.context.newPage()
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto('https://meet.google.com/abc-defg-hij?variante=normal&sala=regra7')
  const r = await page.evaluate(async () => {
    const PC = window.RTCPeerConnection
    const pc = new PC()
    const desc = Object.getOwnPropertyDescriptor(window, 'RTCPeerConnection')!
    const protoDesc = Object.getOwnPropertyDescriptor(PC.prototype, 'constructor')!
    const cert = await PC.generateCertificate({ name: 'ECDSA', namedCurve: 'P-256' } as EcKeyGenParams)
    const out = {
      hook: (window as any)[Symbol.for('gravador.hook')] === true,
      // O addTrack do protótipo é o nosso (prova de que os ganchos estão instalados).
      addTrackWrapped: !/\[native code\]/.test(Function.prototype.toString.call(PC.prototype.addTrack)),
      instanceOf: pc instanceof PC,
      protoSame: Object.getPrototypeOf(pc) === PC.prototype,
      ctorSame: pc.constructor === PC,
      protoCtor: PC.prototype.constructor === PC,
      protoCtorFlags: [protoDesc.writable, protoDesc.enumerable, protoDesc.configurable],
      globalFlags: [desc.writable, desc.enumerable, desc.configurable],
      name: PC.name,
      length: PC.length,
      certificate: cert instanceof RTCCertificate,
      callWithoutNew: (() => {
        try {
          ;(PC as unknown as () => void)()
          return 'não lançou'
        } catch (e) {
          return (e as Error).constructor.name
        }
      })(),
      webkit: !('webkitRTCPeerConnection' in window) || (window as any).webkitRTCPeerConnection === PC,
    }
    pc.close()
    return out
  })
  expect(r).toEqual({
    hook: true,
    addTrackWrapped: true,
    instanceOf: true,
    protoSame: true,
    ctorSame: true,
    protoCtor: true,
    protoCtorFlags: [true, false, true],
    globalFlags: [true, false, true],
    name: 'RTCPeerConnection',
    length: 0,
    certificate: true,
    callWithoutNew: 'TypeError',
    webkit: true,
  })
  expect(errors).toEqual([])
})

test('harness: relaunch e crash mantêm o perfil, o helper e a raiz (AC10, Emenda 5)', async () => {
  h = await launchWithExtension({ settings: { profileLabel: 'Trabalho' } })
  const first = { base: h.base, root: h.root }
  await h.sw.evaluate(() => chrome.storage.local.set({ marcaDoTeste: 'antes' }))
  // O profileId (dono das sessões no helper) é gerado uma vez e tem de sobreviver ao relaunch.
  await expect.poll(() => h!.sw.evaluate(async () => (await chrome.storage.local.get('profileId')).profileId ?? null)).not.toBeNull()
  const profileId = await h.sw.evaluate(async () => (await chrome.storage.local.get('profileId')).profileId)

  // Fechar o Chrome e abrir de novo no mesmo perfil.
  h = await h.relaunch()
  expect({ base: h.base, root: h.root }).toEqual(first)
  expect(await h.sw.evaluate(() => chrome.storage.local.get('marcaDoTeste'))).toEqual({ marcaDoTeste: 'antes' })
  const s1 = (await h.sw.evaluate(async () => (await chrome.storage.local.get('settings')).settings)) as any
  expect(s1).toMatchObject({ profileLabel: 'Trabalho' })
  expect(await h.sw.evaluate(async () => (await chrome.storage.local.get('profileId')).profileId)).toBe(profileId)
  expect((await swApi(h.sw).pingHost(true)).root).toBe(first.root)

  // Queda (SIGKILL) e reabertura.
  await h.crash()
  h = await h.relaunch()
  expect(await h.sw.evaluate(() => chrome.storage.local.get('marcaDoTeste'))).toEqual({ marcaDoTeste: 'antes' })
  expect((await swApi(h.sw).pingHost(true)).root).toBe(first.root)
})

test('harness: downloads de verdade caem na pasta temporária com as subpastas do chrome.downloads', async () => {
  h = await launchWithExtension({ installHost: false, downloads: true })
  expect(h.downloadsDir).toBe(join(h.base, 'downloads'))
  const rel = 'Gravações de calls/Trabalho/2026-10/2026-10-06 14h30 - Daily (Meet)/audio.webm'
  const r = await h.sw.evaluate(async (filename) => {
    const id = await chrome.downloads.download({ url: 'data:audio/webm;base64,GkXfow==', filename, saveAs: false, conflictAction: 'uniquify' })
    for (let i = 0; i < 100; i++) {
      const [d] = await chrome.downloads.search({ id })
      if (d && d.state !== 'in_progress') return { state: d.state, filename: d.filename }
      await new Promise((res) => setTimeout(res, 100))
    }
    return { state: 'timeout', filename: '' }
  }, rel)
  expect(r).toEqual({ state: 'complete', filename: join(h.downloadsDir!, rel) })
  expect(existsSync(join(h.downloadsDir!, rel))).toBe(true)
  // O canário do harness não ficou no histórico de downloads.
  expect(await h.sw.evaluate(async () => (await chrome.downloads.search({})).map((d) => d.filename))).toEqual([join(h.downloadsDir!, rel)])

  // O relaunch volta a pôr os downloads na mesma pasta.
  h = await h.relaunch()
  expect(h.downloadsDir).toBe(join(h.base, 'downloads'))
})

/** Um tabId que não existe (os ids do Chrome são pequenos e crescem a partir de 1). */
const NO_TAB = 2_000_000_000

test('ganchos de teste do SW por fatia e a API do popup aberta numa aba (Emenda 5)', async () => {
  h = await launchWithExtension({ installHost: false })
  const api = swApi(h.sw)
  const hooks = await api.testingHooks()
  for (const name of ['delayFinalize', 'holdPersistAt', 'heldPersistSeq', 'noAudioAlertMs', 'toggleTabCapture', 'markTabsOpenedBeforeInstall', 'notifyNoAudio', 'handleNotificationClick', 'setBadge']) {
    expect(hooks, name).toContain(name)
  }
  // Modo aba implementado (Emenda 7): uma aba que não existe não começa nada e diz por quê.
  expect(await api.testing('toggleTabCapture', NO_TAB)).toEqual({ ok: false, error: 'aba não encontrada' })
  await expect(api.testing('naoExiste')).rejects.toThrow(/gancho de teste inexistente/)

  // O popup aberto como página numa aba fala com o SW (o teste da interface faz assim).
  const popup = await h.context.newPage()
  await popup.goto(`chrome-extension://${EXTENSION_ID}/src/popup/index.html`)
  const state = await popup.evaluate(() => chrome.runtime.sendMessage({ t: 'ui:state' }))
  expect(state).toMatchObject({ active: [], recent: [] })
  expect(state.settings).toMatchObject({ autoMeet: true })
  expect(await popup.evaluate((tabId) => chrome.runtime.sendMessage({ t: 'ui:tab-capture', tabId }), NO_TAB)).toEqual({
    ok: false,
    error: 'aba não encontrada',
  })
  expect(await api.activeRecordings()).toEqual([])
  // activeTab (Emenda 7): título e URL de uma aba de outro site no gesto que libera a captura.
  expect(await h.sw.evaluate(() => chrome.runtime.getManifest().permissions)).toContain('activeTab')
})
