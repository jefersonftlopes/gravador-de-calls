// Captura da aba ocupada por outra extensão (Emenda 17): o Chrome só deixa uma captura por aba, e o
// Volume Master segura a dele para sempre. O getMediaStreamId falha com "Cannot capture a tab with
// an active stream." e o popup mostrava isso cru ("Tab mode: tab capture denied: ..."). Agora mostra
// o que fazer, no modo aba e no volume desta aba, nas duas línguas, até a próxima ação.
//
// A falha é forçada pelo gancho de teste `failTabStreamId` (src/background/capture-id.ts), com o
// texto exato do Chrome: o Chrome for Testing não tem o Volume Master, e o pedido nem chega a ele.
import { expect, test, type Page } from '@playwright/test'
import { EXTENSION_ID, launchWithExtension, swApi, type Harness, type UiLocale } from '../helpers/browser'

const POPUP = `chrome-extension://${EXTENSION_ID}/src/popup/index.html`
/** Página que não é call num host das calls, onde o popup aberto como página vê a URL. */
const PAGE_URL = 'https://meet.google.com/__ocupada'
const CHROME_ERROR = 'Cannot capture a tab with an active stream.'

const TEXTS: Record<UiLocale, { busy: string; tabMode: string; tabModePrefix: string; volume: string; volumePrefix: string }> = {
  'pt-BR': {
    busy: 'Outra extensão (por exemplo, o Volume Master) já está capturando o som desta aba. Desligue essa extensão em chrome://extensions, ou feche e reabra a aba, e tente de novo.',
    tabMode: 'Gravar esta aba (modo aba)',
    tabModePrefix: 'Modo aba: ',
    volume: 'Volume desta aba',
    volumePrefix: 'Não deu para mudar o volume: ',
  },
  'en-US': {
    busy: "Another extension (for example, Volume Master) is already capturing this tab's sound. Turn that extension off in chrome://extensions, or close and reopen the tab, and try again.",
    tabMode: 'Record this tab (tab mode)',
    tabModePrefix: 'Tab mode: ',
    volume: "This tab's volume",
    volumePrefix: "Couldn't change the volume: ",
  },
}

let h: Harness | undefined

test.afterEach(async ({}, testInfo) => {
  if (h && testInfo.status !== testInfo.expectedStatus) {
    await testInfo.attach('console', { body: h.logs.join('\n'), contentType: 'text/plain' })
    console.log(h.logs.join('\n'))
  }
  await h?.close()
  h = undefined
})

async function openPopup(harness: Harness): Promise<{ popup: Page; tabId: number; errors: string[] }> {
  const page = await harness.context.newPage()
  await page.goto(PAGE_URL)
  const tabId = (await harness.sw.evaluate(async (u) => (await chrome.tabs.query({ url: u }))[0]?.id ?? null, `${PAGE_URL}*`)) as number
  expect(tabId).not.toBeNull()
  const popup = await harness.context.newPage()
  const errors: string[] = []
  popup.on('pageerror', (e) => errors.push(e.message))
  await popup.goto(`${POPUP}?tabId=${tabId}`)
  return { popup, tabId, errors }
}

for (const locale of ['pt-BR', 'en-US'] as const) {
  test(`${locale}: o modo aba e o volume desta aba com a captura presa por outra extensão dizem o que fazer`, async () => {
    const text = TEXTS[locale]
    h = await launchWithExtension({
      locale,
      routes: async (context) => {
        await context.route(`${PAGE_URL}**`, (route) => route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<!doctype html><title>Página</title><p>página comum</p>' }))
      },
    })
    const api = swApi(h.sw)
    const { popup, errors } = await openPopup(h)

    // Modo aba.
    await api.testing('failTabStreamId', CHROME_ERROR)
    await popup.getByRole('button', { name: text.tabMode }).click()
    await expect(popup.getByTestId('modo-aba-erro')).toHaveText(`${text.tabModePrefix}${text.busy}`)
    expect(await api.activeRecordings(), 'nenhuma gravação do modo aba ficou aberta').toEqual([])
    // A mensagem fica até a próxima ação (a próxima tentativa a troca).
    await popup.waitForTimeout(2500)
    await expect(popup.getByTestId('modo-aba-erro')).toHaveText(`${text.tabModePrefix}${text.busy}`)

    // Volume desta aba.
    await api.testing('failTabStreamId', CHROME_ERROR)
    await popup.getByRole('slider', { name: text.volume }).fill('150')
    await expect(popup.getByTestId('volume-erro')).toHaveText(`${text.volumePrefix}${text.busy}`)
    // O controle volta ao que vale de verdade (sem captura: 100%).
    await expect(popup.getByTestId('volume-valor')).toHaveText('100%')
    await popup.waitForTimeout(2500)
    await expect(popup.getByTestId('volume-erro')).toHaveText(`${text.volumePrefix}${text.busy}`)
    expect(errors, 'exceção não tratada no popup').toEqual([])
    await popup.close()
  })
}
