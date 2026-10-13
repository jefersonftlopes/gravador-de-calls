// Emenda 15, ponta a ponta: a extensão em inglês (Chrome com a interface em en-US) e o aviso da
// primeira execução.
// - A instalação abre a página de boas-vindas; até o "I understand", uma call do Meet não grava
//   sozinha, e o popup e o badge dizem por quê; confirmado, a call que já estava aberta começa a
//   gravar.
// - Popup e configurações em inglês sem o helper, e a gravação cai em Downloads/Call recordings.
// - Em português (o padrão dos testes): boas-vindas em português e o manifesto traduzido nos dois.
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page, type Worker } from '@playwright/test'
import { EXTENSION_ID, launchWithExtension, swApi, waitWelcomePage, type Harness } from '../helpers/browser'
import { findRecordings } from '../helpers/recordings'

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

async function startPeer(hh: Harness, room: string): Promise<Page> {
  const peer = await hh.context.newPage()
  await peer.goto(`https://meet.google.com/__peer?tom=440&sala=${room}`)
  await peer.click('#iniciar')
  await expect.poll(() => peer.evaluate(() => (window as any).fixture.state)).toBe('pronto')
  return peer
}

async function joinCall(hh: Harness, room: string): Promise<Page> {
  const call = await hh.context.newPage()
  await call.goto(`https://meet.google.com/abc-defg-hij?variante=normal&sala=${room}`)
  await expect.poll(() => call.evaluate(() => (window as any).fixture.micLive)).toBe(true)
  await call.click('#participar')
  await expect.poll(() => call.evaluate(() => (window as any).fixture.pcState), { timeout: 15_000 }).toBe('connected')
  return call
}

async function globalBadge(sw: Worker): Promise<{ text: string; title: string }> {
  return sw.evaluate(async () => ({ text: await chrome.action.getBadgeText({}), title: await chrome.action.getTitle({}) }))
}

test('em inglês: a instalação abre as boas-vindas; até o "I understand" a call não grava sozinha (popup e badge explicam); confirmado, a call aberta começa a gravar', async () => {
  h = await launchWithExtension({ locale: 'en-US', consent: false })
  const api = swApi(h.sw)
  // Qual messages.json o Chrome escolheu (o getUILanguage do SW sai do navigator, que o Playwright emula).
  expect(await h.sw.evaluate(() => chrome.i18n.getMessage('localeTag'))).toBe('en')

  const welcome = await waitWelcomePage(h.context)
  await expect(welcome.getByRole('heading', { level: 1 })).toHaveText('Welcome to Gravador de Calls')
  await expect(welcome.locator('html')).toHaveAttribute('lang', 'en')
  await expect(welcome.getByText('Never your microphone: your voice is not in the recording.')).toBeVisible()
  await expect(welcome.getByTestId('onde-fica')).toContainText('Downloads/Call recordings')
  await expect(welcome.getByText(/LGPD/)).toBeVisible()
  await expect(welcome.getByText(/in some US states, every participant must agree/)).toBeVisible()
  await expect(welcome.getByRole('link', { name: 'Privacy policy' })).toHaveAttribute('href', 'https://gravador-de-calls.vercel.app/en/privacy')

  // Sem a confirmação: badge global e popup explicam, e o link do popup abre a página.
  await expect.poll(() => globalBadge(h!.sw)).toEqual({ text: '!', title: 'Gravador de Calls: read and confirm the notice to turn on automatic recording' })
  const popup = await h.context.newPage()
  await popup.goto(POPUP)
  await expect(popup.getByTestId('aviso-consentimento')).toContainText("Automatic recording hasn't started yet")
  await expect(popup.getByText('Recording now')).toBeVisible()
  const [again] = await Promise.all([h.context.waitForEvent('page'), popup.getByRole('button', { name: 'Read the notice' }).click()])
  await again.waitForLoadState()
  expect(again.url()).toBe(`chrome-extension://${EXTENSION_ID}/src/welcome/index.html`)
  await again.close()

  // A call entra e fica sem gravar.
  await startPeer(h, 'aviso')
  const call = await joinCall(h, 'aviso')
  await call.waitForTimeout(6_000)
  expect(await api.activeRecordings()).toEqual([])
  expect(await api.listSessions()).toEqual([])

  // "I understand": a mesma call (já aberta) começa a gravar, e o aviso some do popup e do badge.
  await welcome.getByRole('button', { name: 'I understand' }).click()
  await expect(welcome.getByTestId('confirmado')).toContainText('All set: automatic recording is on in this profile.')
  await expect.poll(async () => (await api.activeRecordings()).length, { timeout: 15_000, intervals: [250] }).toBe(1)
  await expect(popup.getByTestId('aviso-consentimento')).toHaveCount(0)
  await expect(popup.getByTestId('gravacao')).toHaveCount(1)
  await expect.poll(async () => (await globalBadge(h!.sw)).text).toBe('')
  const consent = (await h.sw.evaluate(async () => (await chrome.storage.local.get('consent')).consent)) as { via: string; version: number }
  expect(consent).toMatchObject({ via: 'pagina', version: 1 })
})

test('em inglês, sem o helper: popup e configurações em inglês e a gravação vai para Downloads/Call recordings', async () => {
  h = await launchWithExtension({ locale: 'en-US', installHost: false, downloads: true })
  const popup = await h.context.newPage()
  await popup.goto(POPUP)
  await expect(popup.locator('html')).toHaveAttribute('lang', 'en')
  await expect(popup.getByRole('button', { name: 'Settings', exact: true })).toBeVisible()
  await expect(popup.getByText('Recording now')).toBeVisible()
  await expect(popup.getByText('No recording in progress.')).toBeVisible()
  await expect(popup.getByTestId('helper')).toHaveText('Saving to Downloads/Call recordings.')
  await expect(popup.getByTestId('aviso-consentimento')).toHaveCount(0)

  const options = await h.context.newPage()
  await options.goto(OPTIONS)
  await expect(options.getByRole('heading', { name: 'Recordings folder' })).toBeVisible()
  await expect(options.getByTestId('sem-helper')).toHaveText(/^Saving to Downloads\/Call recordings\./)
  await expect(options.getByLabel('Record Google Meet calls automatically')).toBeChecked()
  await expect(options.getByLabel('Record Microsoft Teams calls automatically')).toBeChecked()
  await expect(options.getByRole('button', { name: 'Save', exact: true })).toBeVisible()
  await expect(options.getByTestId('secao-avancado')).toContainText('not yet distributed through the store')
  await expect(options.getByTestId('previa-pasta')).toHaveText('Downloads/Call recordings/YYYY-MM/YYYY-MM-DD HHhMM - title (Meet|Teams)/')
  await expect(options.getByRole('link', { name: 'Privacy policy' })).toHaveAttribute('href', 'https://gravador-de-calls.vercel.app/en/privacy')

  await startPeer(h, 'ingles')
  const call = await joinCall(h, 'ingles')
  await expect.poll(async () => (await swApi(h!.sw).activeRecordings()).length, { timeout: 15_000, intervals: [250] }).toBe(1)
  await expect(popup.getByTestId('gravacao')).toContainText(/audio coming in|no audio yet/)
  await call.waitForTimeout(7_000)
  await call.click('button[jsname="CQylAd"]')
  const folder = join(h.downloadsDir!, 'Call recordings')
  await expect.poll(() => findRecordings(folder).filter((r) => r.info).length, { timeout: 20_000, intervals: [250] }).toBe(1)
  const [rec] = findRecordings(folder)
  expect(rec.files).toEqual(['audio.webm', 'info.json'])
  // O formato do info.json é contrato: as chaves continuam as mesmas em inglês.
  expect(rec.info).toMatchObject({ plataforma: 'meet', status: 'concluida', motivoFim: 'saiu-da-call' })
  expect(existsSync(join(h.downloadsDir!, 'Gravações de calls'))).toBe(false)
  expect(readdirSync(h.downloadsDir!).filter((n) => n !== 'gravador-canario')).toEqual(['Call recordings'])
  const recent = popup.getByTestId('recente')
  await expect(recent).toContainText('in Downloads')
  await expect(recent.getByRole('button', { name: 'Show in folder' })).toBeVisible()
})

test('em português (padrão dos testes): boas-vindas em português, e o manifesto traduzido nos dois idiomas', async () => {
  h = await launchWithExtension({ consent: false })
  expect(await h.sw.evaluate(() => chrome.i18n.getMessage('localeTag'))).toBe('pt-BR')
  const welcome = await waitWelcomePage(h.context)
  await expect(welcome.getByRole('heading', { level: 1 })).toHaveText('Bem-vindo ao Gravador de Calls')
  await expect(welcome.getByText('Nunca o seu microfone: a sua voz não entra na gravação.')).toBeVisible()
  await expect(welcome.getByTestId('onde-fica')).toContainText('Downloads/Gravações de calls')
  const cmds = (await h.sw.evaluate(async () => (await chrome.commands.getAll()).map((c) => [c.name, c.description]))) as string[][]
  expect(cmds).toContainEqual(['gravar-aba', 'Gravar esta aba pela captura de aba do Chrome (modo aba)'])
  expect(await h.sw.evaluate(() => chrome.action.getTitle({}))).toBe('Gravador de Calls: leia e confirme o aviso para a gravação automática começar')
  await h.close()

  h = await launchWithExtension({ locale: 'en-US' })
  const cmdsEn = (await h.sw.evaluate(async () => (await chrome.commands.getAll()).map((c) => [c.name, c.description]))) as string[][]
  expect(cmdsEn).toContainEqual(['gravar-aba', "Record this tab with Chrome's tab capture (tab mode)"])
  expect(await h.sw.evaluate(() => chrome.action.getTitle({}))).toBe('Gravador de Calls')
})
