// Pacote da loja carregado no Chrome for Testing (Emenda 15): o build com GRAVADOR_LOJA=1 numa pasta
// temporária, sem a chave (então com outro ID) e sem helper. O service worker não expõe nada
// (`globalThis.__gravador` não existe), a instalação abre as boas-vindas, o popup abre e diz que
// salva em Downloads, e as configurações não mandam rodar o npm.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, expect, test, type BrowserContext } from '@playwright/test'
import { ROOT, chromiumPath } from '../helpers/paths'

const base = mkdtempSync(join(tmpdir(), 'gravador-e2e-loja-'))
const STORE = join(base, 'extensao')
let context: BrowserContext | undefined

test.beforeAll(() => {
  const r = spawnSync(join(ROOT, 'node_modules', '.bin', 'vite'), ['build', '--outDir', STORE, '--emptyOutDir', '--logLevel', 'error'], {
    cwd: ROOT,
    env: { ...process.env, GRAVADOR_LOJA: '1' },
    encoding: 'utf8',
  })
  if (r.status !== 0) throw new Error(`build da loja falhou: ${r.stderr}`)
})

test.afterAll(async () => {
  await context?.close().catch(() => {})
  rmSync(base, { recursive: true, force: true })
})

test('pacote da loja: sem o gancho de teste no SW, boas-vindas na instalação e o popup sem helper', async () => {
  context = await chromium.launchPersistentContext(join(base, 'perfil'), {
    executablePath: chromiumPath(),
    headless: true,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [`--disable-extensions-except=${STORE}`, `--load-extension=${STORE}`],
  })
  const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'))
  const id = new URL(sw.url()).host
  expect(await sw.evaluate(() => typeof (globalThis as { __gravador?: unknown }).__gravador)).toBe('undefined')
  expect(await sw.evaluate(() => chrome.runtime.getManifest().homepage_url)).toBe('https://gravador-de-calls.vercel.app')

  const welcome =
    context.pages().find((p) => p.url().includes('/src/welcome/')) ??
    (await context.waitForEvent('page', { predicate: (p) => p.url().includes('/src/welcome/'), timeout: 15_000 }))
  expect(welcome.url()).toBe(`chrome-extension://${id}/src/welcome/index.html`)
  await welcome.getByTestId('entendi').click()
  await expect(welcome.getByTestId('confirmado')).toBeVisible()

  const popup = await context.newPage()
  await popup.goto(`chrome-extension://${id}/src/popup/index.html`)
  await expect(popup.getByTestId('helper')).toHaveAttribute('data-helper', 'nao-instalado')
  await expect(popup.getByTestId('helper')).toContainText(/^(Saving to Downloads\/Call recordings|Salvando em Downloads\/Gravações de calls)\.$/)
  await expect(popup.getByTestId('aviso-consentimento')).toHaveCount(0)

  // Configurações: a seção avançada diz que o helper ainda não vem pela loja, sem a instrução de
  // instalar pelo npm (quem instala pela loja não tem a pasta do projeto). O build de
  // desenvolvimento mostra o npm run instalar (interface.spec.ts).
  const options = await context.newPage()
  await options.goto(`chrome-extension://${id}/src/options/index.html`)
  const advanced = options.getByTestId('secao-avancado')
  await expect(advanced).toContainText(/not yet distributed through the store|ainda não distribuído pela loja/)
  await expect(advanced.getByTestId('helper-status')).toHaveCount(1)
  await expect(advanced).not.toContainText('npm run')
  await expect(options.locator('body')).not.toContainText('npm run')
})
