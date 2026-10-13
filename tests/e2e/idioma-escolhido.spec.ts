// Emenda 19, ponta a ponta: o idioma da interface escolhido nas configurações, num Chrome em
// português (o chrome.i18n continua em português o tempo todo).
// - Trocar para English nas configurações muda na hora, sem recarregar nada: a própria página (com
//   o que já foi digitado num campo continuando lá), as boas-vindas abertas, o popup aberto, o
//   título do ícone (o global e o de uma aba com REC) e o popup aberto depois. O valor fica
//   guardado, e o Salvar do formulário não o desfaz. Automático volta ao português.
// - O indicador do vigia na página da call troca de idioma na hora, sem esperar a próxima leitura.
// - Com o SW parado, a troca de idioma gravada no storage (sem mensagem nenhuma ao SW) o acorda, e o
//   título do ícone muda.
// - As mensagens que já estão na tela trocam junto, inclusive o motivo que o SW escreveu no idioma
//   de antes: o erro inesperado e o do helper sem transcrição nas configurações, o helper que não
//   responde (configurações e popup), os erros do modo aba e do volume no popup e o erro do
//   "Entendi" nas boas-vindas.
import { execFileSync } from 'node:child_process'
import { renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page, type Worker } from '@playwright/test'
import { DEFAULT_VIGIA } from '../../src/shared/settings'
import { EXTENSION_ID, currentServiceWorker, launchWithExtension, stopExtensionServiceWorker, swApi, waitWelcomePage, type Harness } from '../helpers/browser'
import { indicador, novaAba, setSettings, ultimoTexto } from '../fixtures/vigia/e2e'
import { installVigiaRoutes } from '../fixtures/vigia/routes'

const POPUP = `chrome-extension://${EXTENSION_ID}/src/popup/index.html`
const OPTIONS = `chrome-extension://${EXTENSION_ID}/src/options/index.html`

let h: Harness | undefined

test.afterEach(async ({}, testInfo) => {
  if (h && testInfo.status !== testInfo.expectedStatus) {
    await testInfo.attach('console', { body: h.logs.join('\n'), contentType: 'text/plain' })
    console.log(h.logs.join('\n'))
  }
  await h?.close()
  h = undefined
})

const storedLanguage = (sw: Worker) => sw.evaluate(async () => ((await chrome.storage.local.get('settings')).settings as { language?: string } | undefined)?.language)
const globalTitle = (sw: Worker) => sw.evaluate(() => chrome.action.getTitle({}))
const tabTitle = (sw: Worker, tabId: number) => sw.evaluate((id) => chrome.action.getTitle({ tabId: id }), tabId)

/** Id da aba de uma página da extensão (sem a permissão "tabs", o tabs.query do SW não dá a URL dela). */
async function ownTabId(page: Page): Promise<number> {
  const id = await page.evaluate(async () => (await chrome.tabs.getCurrent())?.id ?? null)
  if (id == null) throw new Error(`aba não encontrada: ${page.url()}`)
  return id
}

const languageSelect = (options: Page) => options.getByTestId('idioma')

test('Chrome em português: English nas configurações troca na hora a página, as boas-vindas, o popup e o ícone, fica guardado, e Automático volta ao português', async () => {
  // Sem o aviso confirmado: as boas-vindas ficam abertas e o título global do ícone tem texto nos
  // dois idiomas (o padrão, "Gravador de Calls", é o mesmo nos dois).
  h = await launchWithExtension({ consent: false, installHost: false })
  const api = swApi(h.sw)
  expect(await h.sw.evaluate(() => chrome.i18n.getMessage('localeTag'))).toBe('pt-BR')
  const welcome = await waitWelcomePage(h.context)
  await expect(welcome.getByRole('heading', { level: 1 })).toHaveText('Bem-vindo ao Gravador de Calls')
  await expect.poll(() => globalTitle(h!.sw)).toBe('Gravador de Calls: leia e confirme o aviso para a gravação automática começar')

  // Uma aba com o REC: o título dela é próprio da aba.
  const welcomeTab = await ownTabId(welcome)
  await api.testing('setBadge', welcomeTab, 'rec')
  expect(await tabTitle(h.sw, welcomeTab)).toBe('Gravador de Calls: gravando esta call')

  const popup = await h.context.newPage()
  await popup.goto(POPUP)
  await expect(popup.getByText('Gravando agora')).toBeVisible()

  const options = await h.context.newPage()
  await options.goto(OPTIONS)
  await expect(options.locator('html')).toHaveAttribute('lang', 'pt-BR')
  await expect(options).toHaveTitle('Gravador de Calls: Configurações')
  await expect(options.getByRole('heading', { name: 'Idioma' })).toBeVisible()
  await expect(languageSelect(options)).toHaveValue('auto')
  await expect(languageSelect(options).locator('option')).toHaveText(['Automático (idioma do Chrome)', 'Português (Brasil)', 'English'])
  // Um campo mexido e não salvo, com a mensagem de erro do Salvar: os dois continuam depois da
  // troca de idioma, e a mensagem troca junto.
  const minSeconds = options.getByLabel('Descartar gravações com menos de (segundos)')
  await minSeconds.fill('-5')
  await options.getByRole('button', { name: 'Salvar', exact: true }).click()
  await expect(options.getByText('no mínimo 0', { exact: true })).toBeVisible()

  await languageSelect(options).selectOption({ label: 'English' })

  // A página das configurações, sem recarregar.
  await expect(options.getByRole('heading', { name: 'Recordings folder' })).toBeVisible()
  await expect(options.getByRole('heading', { name: 'Language' })).toBeVisible()
  await expect(options.locator('html')).toHaveAttribute('lang', 'en')
  await expect(options).toHaveTitle('Gravador de Calls: Settings')
  await expect(options.getByTestId('idioma-mensagem')).toHaveText('Language saved: it applies to this Chrome profile.')
  await expect(languageSelect(options)).toHaveValue('en')
  await expect(languageSelect(options).locator('option')).toHaveText(["Automatic (Chrome's language)", 'Português (Brasil)', 'English'])
  await expect(options.getByLabel('Discard recordings shorter than (seconds)')).toHaveValue('-5')
  await expect(options.getByText('at least 0', { exact: true })).toBeVisible()
  await expect(options.getByText('no mínimo 0', { exact: true })).toHaveCount(0)
  await options.getByLabel('Discard recordings shorter than (seconds)').fill('45')
  await expect(options.getByText('at least 0', { exact: true })).toHaveCount(0)
  await expect(options.getByRole('button', { name: 'Save', exact: true })).toBeEnabled()
  await expect.poll(() => storedLanguage(h!.sw)).toBe('en')

  // As boas-vindas e o popup que já estavam abertos.
  await expect(welcome.getByRole('heading', { level: 1 })).toHaveText('Welcome to Gravador de Calls')
  await expect(welcome.locator('html')).toHaveAttribute('lang', 'en')
  await expect(welcome).toHaveTitle('Welcome to Gravador de Calls')
  // A pasta em Downloads segue o idioma do Chrome (o texto em volta, o escolhido).
  await expect(welcome.getByTestId('onde-fica')).toContainText('Downloads/Gravações de calls')
  await expect(popup.getByText('Recording now')).toBeVisible()
  await expect(popup.locator('html')).toHaveAttribute('lang', 'en')

  // O ícone: o título global e o da aba com REC, reaplicados pelo SW.
  await expect.poll(() => globalTitle(h!.sw)).toBe('Gravador de Calls: read and confirm the notice to turn on automatic recording')
  await expect.poll(() => tabTitle(h!.sw, welcomeTab)).toBe('Gravador de Calls: recording this call')
  // O chrome.i18n continua no idioma do Chrome: a troca é da extensão.
  expect(await h.sw.evaluate(() => chrome.i18n.getMessage('localeTag'))).toBe('pt-BR')

  // Um popup aberto depois já nasce em inglês.
  const popup2 = await h.context.newPage()
  await popup2.goto(POPUP)
  await expect(popup2.locator('html')).toHaveAttribute('lang', 'en')
  await expect(popup2.getByText('No recording in progress.')).toBeVisible()
  await expect(popup2.getByRole('button', { name: 'Settings', exact: true })).toBeVisible()

  // O Salvar do formulário guarda o campo mexido e não desfaz o idioma.
  await options.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(options.getByTestId('salvar-mensagem')).toHaveText("This profile's settings were saved.")
  const saved = (await h.sw.evaluate(async () => (await chrome.storage.local.get('settings')).settings)) as { minSeconds: number; language: string }
  expect(saved).toMatchObject({ minSeconds: 45, language: 'en' })

  // Recarregada, a página continua em inglês e não pisca em português: o idioma vem do storage
  // antes do primeiro render (o observador anota o primeiro título que aparece na página).
  await options.addInitScript(() => {
    const w = window as unknown as { primeiroTitulo?: string }
    new MutationObserver(() => {
      const h1 = document.querySelector('h1')
      if (h1 && w.primeiroTitulo === undefined) w.primeiroTitulo = `${document.documentElement.lang} ${document.querySelector('h2')?.textContent ?? ''}`
    }).observe(document, { childList: true, subtree: true })
  })
  await options.reload()
  await expect(options.getByRole('heading', { name: 'Recordings folder' })).toBeVisible()
  await expect(languageSelect(options)).toHaveValue('en')
  expect(await options.evaluate(() => (window as unknown as { primeiroTitulo?: string }).primeiroTitulo)).toBe('en Language')

  // Automático: de volta ao idioma do Chrome em tudo.
  await languageSelect(options).selectOption('auto')
  await expect(options.getByRole('heading', { name: 'Pasta das gravações' })).toBeVisible()
  await expect(options.locator('html')).toHaveAttribute('lang', 'pt-BR')
  await expect(options.getByTestId('idioma-mensagem')).toHaveText('Idioma salvo: vale para este perfil do Chrome.')
  await expect.poll(() => storedLanguage(h!.sw)).toBe('auto')
  await expect(welcome.getByRole('heading', { level: 1 })).toHaveText('Bem-vindo ao Gravador de Calls')
  await expect(popup2.getByText('Nenhuma gravação em andamento.')).toBeVisible()
  await expect.poll(() => globalTitle(h!.sw)).toBe('Gravador de Calls: leia e confirme o aviso para a gravação automática começar')
  await expect.poll(() => tabTitle(h!.sw, welcomeTab)).toBe('Gravador de Calls: gravando esta call')

  // Trocado em outra aba das configurações: a primeira acompanha inteira, sem mensagem nenhuma dela.
  const other = await h.context.newPage()
  await other.goto(OPTIONS)
  await languageSelect(other).selectOption({ label: 'English' })
  await expect(options.getByRole('heading', { name: 'Recordings folder' })).toBeVisible()
  await expect(options.getByRole('button', { name: 'Save', exact: true })).toBeVisible()
  await expect(languageSelect(options)).toHaveValue('en')
})

test('o indicador do vigia na página da call troca de idioma na hora, sem esperar a próxima leitura', async () => {
  h = await launchWithExtension({ installHost: false, routes: installVigiaRoutes })
  // Uma leitura a cada 30 s: a troca não tem como vir de uma leitura nova.
  const call = await novaAba(h.context)
  await call.goto('https://teams.microsoft.com/v2/?n=10&painel=aberto')
  await call.click('#entrar')
  await expect(call.locator('#hangup-button')).toBeVisible()
  await setSettings(h, { autoLeave: true, vigia: { ...DEFAULT_VIGIA, intervaloSeg: 30 } })
  await expect.poll(() => ultimoTexto(call)).toBe('vigia: 10 na call · pico 10 · sai com 3 ou menos · via painel People')
  const lida = (await indicador(call)).at(-1)!.at

  const options = await h.context.newPage()
  await options.goto(OPTIONS)
  await languageSelect(options).selectOption({ label: 'English' })
  await expect.poll(() => ultimoTexto(call), { timeout: 5_000, intervals: [100] }).toBe('auto-leave: 10 in the call · peak 10 · leaves at 3 or fewer · via People panel')
  const trocada = (await indicador(call)).at(-1)!.at
  expect(trocada - lida).toBeLessThan(25_000)

  await languageSelect(options).selectOption('auto')
  await expect.poll(() => ultimoTexto(call), { timeout: 5_000, intervals: [100] }).toBe('vigia: 10 na call · pico 10 · sai com 3 ou menos · via painel People')
  // Nenhuma leitura no meio: só as três versões do mesmo texto.
  expect((await indicador(call)).map((l) => l.text).filter((x) => x?.includes('na call') || x?.includes('in the call'))).toEqual([
    'vigia: 10 na call · pico 10 · sai com 3 ou menos · via painel People',
    'auto-leave: 10 in the call · peak 10 · leaves at 3 or fewer · via People panel',
    'vigia: 10 na call · pico 10 · sai com 3 ou menos · via painel People',
  ])
  expect(h.pageErrors).toEqual([])
})

test('com o SW parado, a troca de idioma no storage o acorda e o título do ícone muda', async () => {
  h = await launchWithExtension({ consent: false, installHost: false })
  await waitWelcomePage(h.context)
  await expect.poll(() => globalTitle(h!.sw)).toBe('Gravador de Calls: leia e confirme o aviso para a gravação automática começar')
  // A página que escreve abre antes (ela fala com o SW ao abrir); depois o SW para.
  const options = await h.context.newPage()
  await options.goto(OPTIONS)
  await expect(languageSelect(options)).toHaveValue('auto')
  expect(await stopExtensionServiceWorker(h)).toContain('stopped')
  // Direto no storage, como faria outra página da extensão: o SW só fica sabendo pelo storage.onChanged.
  await options.evaluate(async () => {
    const { settings } = await chrome.storage.local.get('settings')
    await chrome.storage.local.set({ settings: { ...((settings as object | undefined) ?? {}), language: 'en' } })
  })
  const sw = await currentServiceWorker(h)
  await expect.poll(() => globalTitle(sw)).toBe('Gravador de Calls: read and confirm the notice to turn on automatic recording')
  await expect(options.getByRole('heading', { name: 'Recordings folder' })).toBeVisible()
})

/** Troca o idioma direto no storage, como as configurações fazem (o SW e as páginas ouvem). */
const storeLanguage = (page: Page, language: string) =>
  page.evaluate(async (l) => {
    const { settings } = await chrome.storage.local.get('settings')
    await chrome.storage.local.set({ settings: { ...((settings as object | undefined) ?? {}), language: l } })
  }, language)

test('configurações: o erro inesperado e o do helper sem transcrição, já na tela, trocam de idioma inteiros', async () => {
  h = await launchWithExtension({
    // O helper de antes da transcrição (o mesmo do AC20 em transcricao.spec.ts): o SW responde com o
    // trOldHelper no idioma da hora.
    beforeLaunch: ({ base }) => {
      renameSync(join(base, 'gravador-host.mjs'), join(base, 'gravador-host-atual.mjs'))
      writeFileSync(
        join(base, 'gravador-host.mjs'),
        [
          "import { encodeFrame, handle, readFrames } from './gravador-host-atual.mjs'",
          "const NOVAS = new Set(['set-transcription', 'transcription-status', 'open-file', 'choose-file'])",
          'readFrames(process.stdin, async (msg) => {',
          "  let res = NOVAS.has(msg?.op) ? { id: msg.id, ok: false, error: `operação desconhecida: ${msg.op}` } : await handle(msg)",
          "  if (msg?.op === 'ping' && res.ok) res = { ...res, version: '0.1.0' }",
          "  if (msg?.op === 'get-config' && res.ok) { delete res.transcricao; delete res.motores }",
          '  process.stdout.write(encodeFrame(res))',
          '}, () => process.exit(0))',
          '',
        ].join('\n'),
      )
    },
  })
  const options = await h.context.newPage()
  await options.goto(OPTIONS)
  await expect(options.getByTestId('transcricao-erro')).toHaveText(
    'Não deu para ler a transcrição do helper: o helper instalado é de uma versão sem transcrição: rode npm run instalar de novo',
  )
  // Uma rejeição que ninguém tratou, com o motivo que o uiCall escreve quando o SW não responde.
  await options.evaluate(() => {
    void Promise.reject(new Error('o service worker da extensão não respondeu ao pedido "ui:x" (ele pode estar rodando uma versão anterior: recarregue a extensão)'))
  })
  await expect(options.getByTestId('erro-inesperado')).toHaveText(
    'Algo falhou: o service worker da extensão não respondeu ao pedido "ui:x" (ele pode estar rodando uma versão anterior: recarregue a extensão)',
  )

  await languageSelect(options).selectOption({ label: 'English' })
  await expect(options.getByRole('heading', { name: 'Language' })).toBeVisible()
  await expect(options.getByTestId('transcricao-erro')).toHaveText(
    "Couldn't read the transcription settings from the helper: the installed helper is from a version without transcription: run npm run instalar again",
  )
  await expect(options.getByTestId('erro-inesperado')).toHaveText(
    'Something failed: the extension\'s service worker didn\'t answer the "ui:x" request (it may be running an earlier version: reload the extension)',
  )
  // E de volta, sem recarregar.
  await languageSelect(options).selectOption('auto')
  await expect(options.getByTestId('erro-inesperado')).toHaveText(
    'Algo falhou: o service worker da extensão não respondeu ao pedido "ui:x" (ele pode estar rodando uma versão anterior: recarregue a extensão)',
  )
  await expect(options.getByTestId('transcricao-erro')).toContainText('rode npm run instalar de novo')
})

test('helper instalado que não responde: o motivo que o SW escreveu em português sai em inglês nas configurações e no popup', async () => {
  h = await launchWithExtension({})
  // O wrapper abre, mas o helper nunca responde: lê a entrada até o Chrome fechar o canal. Sem exec:
  // a saída do sh continua sendo o canal do Chrome (com ela em /dev/null, o Chrome diz que o host saiu).
  writeFileSync(join(h.base, 'gravador-host.sh'), '#!/bin/sh\ncat > /dev/null\n')
  try {
    execFileSync('pkill', ['-f', join(h.base, 'gravador-host.mjs')])
  } catch {
    // nenhum aberto
  }
  const api = swApi(h.sw)
  await expect.poll(async () => (await api.pingHost(true)).error, { timeout: 20_000 }).toBe('helper não respondeu a ping em 5000 ms')
  const options = await h.context.newPage()
  await options.goto(OPTIONS)
  await expect(options.getByTestId('sem-helper')).toHaveAttribute('data-helper', 'nao-abre')
  await expect(options.getByTestId('sem-helper')).toContainText('mas não abriu (helper não respondeu a ping em 5000 ms)')
  const popup = await h.context.newPage()
  await popup.goto(POPUP)
  await expect(popup.getByTestId('helper')).toContainText('mas não abriu (helper não respondeu a ping em 5000 ms)')

  await languageSelect(options).selectOption({ label: 'English' })
  await expect(options.getByTestId('sem-helper')).toContainText("The helper is installed but didn't open (helper did not answer ping within 5000 ms): saving to Downloads/Gravações de calls.")
  await expect(options.getByTestId('helper-status')).toHaveText('Installed, but doesn\'t open (helper did not answer ping within 5000 ms): recordings go to Downloads/Gravações de calls.')
  await expect(popup.getByTestId('helper')).toContainText("The helper is installed but didn't open (helper did not answer ping within 5000 ms)")
})

test('popup aberto: os erros do modo aba e do volume que já estão na tela trocam de idioma inteiros', async () => {
  const PAGE_URL = 'https://meet.google.com/__ocupada'
  h = await launchWithExtension({
    installHost: false,
    routes: async (context) => {
      await context.route(`${PAGE_URL}**`, (route) => route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<!doctype html><title>Página</title><p>página comum</p>' }))
    },
  })
  const api = swApi(h.sw)
  const page = await h.context.newPage()
  await page.goto(PAGE_URL)
  const tabId = (await h.sw.evaluate(async (u) => (await chrome.tabs.query({ url: u }))[0]?.id ?? null, `${PAGE_URL}*`)) as number
  const popup = await h.context.newPage()
  await popup.goto(`${POPUP}?tabId=${tabId}`)
  // A captura presa por outra extensão (captura-ocupada.spec.ts): o SW responde com o errCaptureBusy.
  await api.testing('failTabStreamId', 'Cannot capture a tab with an active stream.')
  await popup.getByRole('button', { name: 'Gravar esta aba (modo aba)' }).click()
  await expect(popup.getByTestId('modo-aba-erro')).toHaveText('Modo aba: Outra extensão (por exemplo, o Volume Master) já está capturando o som desta aba. Desligue essa extensão em chrome://extensions, ou feche e reabra a aba, e tente de novo.')
  await api.testing('failTabStreamId', 'Cannot capture a tab with an active stream.')
  await popup.getByRole('slider', { name: 'Volume desta aba' }).fill('150')
  await expect(popup.getByTestId('volume-erro')).toHaveText('Não deu para mudar o volume: Outra extensão (por exemplo, o Volume Master) já está capturando o som desta aba. Desligue essa extensão em chrome://extensions, ou feche e reabra a aba, e tente de novo.')

  await storeLanguage(popup, 'en')
  await expect(popup.getByRole('button', { name: 'Record this tab (tab mode)' })).toBeVisible()
  const busy = "Another extension (for example, Volume Master) is already capturing this tab's sound. Turn that extension off in chrome://extensions, or close and reopen the tab, and try again."
  await expect(popup.getByTestId('modo-aba-erro')).toHaveText(`Tab mode: ${busy}`)
  await expect(popup.getByTestId('volume-erro')).toHaveText(`Couldn't change the volume: ${busy}`)
  expect(h.pageErrors).toEqual([])
})

test('boas-vindas abertas: o erro do "Entendi" que já está na tela troca de idioma inteiro', async () => {
  h = await launchWithExtension({ consent: false, installHost: false })
  const welcome = await waitWelcomePage(h.context)
  await expect(welcome.getByRole('heading', { level: 1 })).toHaveText('Bem-vindo ao Gravador de Calls')
  // A gravação da confirmação falha uma vez (o storage recusa); o resto do storage funciona.
  await welcome.evaluate(() => {
    const local = chrome.storage.local
    const set = local.set.bind(local)
    let failed = false
    local.set = ((items: Record<string, unknown>) => {
      if (!failed && 'consent' in items) {
        failed = true
        return Promise.reject(new Error('boom'))
      }
      return set(items)
    }) as typeof local.set
  })
  await welcome.getByTestId('entendi').click()
  await expect(welcome.getByText('Não deu para salvar a confirmação: boom')).toBeVisible()
  await storeLanguage(welcome, 'en')
  await expect(welcome.getByRole('heading', { level: 1 })).toHaveText('Welcome to Gravador de Calls')
  await expect(welcome.getByText("Couldn't save the confirmation: boom")).toBeVisible()
})
