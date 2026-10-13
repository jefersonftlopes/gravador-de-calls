// Teams pelo proxy do Defender for Cloud Apps (Emenda 17, AC26): o vigia e o popup no host
// teams.cloud.microsoft.mcas.ms, com a página que imita o Teams para o vigia
// (tests/fixtures/vigia/teams-page.ts) servida nesse host. A gravação pelo proxy fica em
// teams.spec.ts; aqui, o que ela não cobre: o vigia reconhece o host pelo proxy (conta e sai
// sozinho) e o popup trata a aba como do Teams (mostra a seção do vigia com a contagem).
import { expect, test, type BrowserContext, type Page } from '@playwright/test'
import { EXTENSION_ID, launchWithExtension, type Harness } from '../helpers/browser'
import { fulfillHtml } from '../fixtures/routes'
import { LIGADO, fx, novaAba, quandoFechar, tabIdOf, ultimoTexto, vigiaEventos, vigiaTabState } from '../fixtures/vigia/e2e'
import { teamsVigiaPage } from '../fixtures/vigia/teams-page'

const POPUP = `chrome-extension://${EXTENSION_ID}/src/popup/index.html`
const PROXY_HOST = 'teams.cloud.microsoft.mcas.ms'

let h: Harness | undefined

test.afterEach(async ({}, testInfo) => {
  if (h && testInfo.status !== testInfo.expectedStatus) {
    await testInfo.attach('console', { body: h.logs.join('\n'), contentType: 'text/plain' })
    console.log(h.logs.join('\n'))
  }
  await h?.close()
  h = undefined
})

/** A página do vigia no host pelo proxy (as rotas do vigia só servem teams.microsoft.com). */
async function proxyVigiaRoutes(context: BrowserContext): Promise<void> {
  await context.route(`https://${PROXY_HOST}/**`, (route) => {
    if (new URL(route.request().url()).pathname === '/__peer') return route.fallback()
    return fulfillHtml(route, teamsVigiaPage())
  })
}

const setN = (page: Page, n: number) => page.evaluate((x) => (window as any).vigiaFx.setN(x), n)

test('pelo proxy (teams.cloud.microsoft.mcas.ms): o vigia conta, o popup mostra a contagem da aba e ficar sozinho sai e fecha a aba', async () => {
  h = await launchWithExtension({ installHost: false, routes: proxyVigiaRoutes, settings: LIGADO })
  const page = await novaAba(h.context)
  await page.goto(`https://${PROXY_HOST}/v2/?n=3&painel=aberto`)
  await page.click('#entrar')
  await expect(page.locator('#hangup-button')).toBeVisible()

  // O vigia entrou e reconhece o Teams pelo host do proxy.
  await expect.poll(() => ultimoTexto(page)).toContain('3 na call')
  const tabId = await tabIdOf(h, page)
  await expect.poll(async () => (await vigiaTabState(h!, tabId)).status?.n).toBe(3)
  expect(await vigiaTabState(h, tabId)).toMatchObject({ connected: true, disabledForCall: false, status: { platform: 'teams', naCall: true, n: 3 } })

  // O popup trata a aba como do Teams: a seção do vigia aparece com a contagem desta aba.
  const popup = await h.context.newPage()
  await popup.goto(`${POPUP}?tabId=${tabId}`)
  const vigia = popup.getByTestId('vigia')
  await expect(vigia.getByTestId('vigia-linha')).toContainText('3 na call')
  await expect(vigia.getByTestId('vigia-fonte')).toContainText('Teams')

  // Sair sozinho pelo proxy: ficar sozinho sai da call e o SW fecha a aba.
  const closed = quandoFechar(page)
  await setN(page, 1)
  await expect.poll(async () => (await fx<{ leftAt: number | null }>(page)).leftAt, { timeout: 5_000, intervals: [50] }).not.toBeNull()
  await closed
  const ev = await vigiaEventos(h)
  expect(ev.map((e) => [e.t, e.tabId, e.motivo])).toEqual([
    ['saindo', tabId, 'caiu de 3 para 1'],
    ['fechou', tabId, 'saiu-da-call'],
  ])
  expect(h.pageErrors).toEqual([])
})
