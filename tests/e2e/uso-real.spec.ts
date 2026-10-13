// Casos de uso real que a primeira suíte não via (Emenda 10): o service worker dorme entre os
// eventos (o MV3 para o SW ocioso uns 30 s depois do último evento, e o Playwright, ligado ao
// SW, nunca deixa isso acontecer sozinho), e o layout do Meet muda no meio da call.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { EXTENSION_ID, currentServiceWorker, launchWithExtension, stopExtensionServiceWorker, swApi, type Harness } from '../helpers/browser'
import { DIST } from '../helpers/paths'

let h: Harness | undefined

test.afterEach(async ({}, testInfo) => {
  if (h && testInfo.status !== testInfo.expectedStatus) {
    await testInfo.attach('console', { body: h.logs.join('\n'), contentType: 'text/plain' })
    console.log(h.logs.join('\n'))
  }
  await h?.close()
  h = undefined
})

const fx = (page: Page, key: string) => page.evaluate((k) => (window as any).fixture[k], key)

async function startPeer(harness: Harness, room: string): Promise<Page> {
  const peer = await harness.context.newPage()
  await peer.goto(`https://meet.google.com/__peer?tom=440&sala=${room}`)
  await peer.click('#iniciar')
  await expect.poll(() => peer.evaluate(() => (window as any).fixture.state)).toBe('pronto')
  return peer
}

async function openCall(harness: Harness, variant: string, room: string): Promise<Page> {
  const call = await harness.context.newPage()
  await call.goto(`https://meet.google.com/abc-defg-hij?variante=${variant}&sala=${room}`)
  await expect.poll(() => fx(call, 'micLive')).toBe(true)
  return call
}

/** Grava as configurações por uma página da extensão (o SW pode estar parado). */
async function saveSettingsFromPage(harness: Harness, patch: Record<string, unknown>): Promise<void> {
  const id = new URL(harness.sw.url()).host
  const page = await harness.context.newPage()
  await page.goto(`chrome-extension://${id}/src/options/index.html`)
  await page.evaluate(async (p) => {
    const cur = ((await chrome.storage.local.get('settings')).settings ?? {}) as object
    await chrome.storage.local.set({ settings: { ...cur, ...p } })
  }, patch)
  await page.close()
}

test('religar a gravação automática depois de o SW dormir vale na aba de call já aberta (AC15)', async () => {
  h = await launchWithExtension({ settings: { autoMeet: false } })
  await startPeer(h, 'religar')
  // A aba abre com a gravação do Meet desligada: o hello recebe autoMeet false.
  const call = await openCall(h, 'normal', 'religar')
  await call.waitForTimeout(1500)
  // O SW dorme (como depois de 30 s ocioso) e o relay, sem nada pendente, não reconecta.
  const seen = await stopExtensionServiceWorker(h)
  expect(seen).toContain('stopped')
  // Liga de novo pelas configurações: o SW acorda pelo storage, mas não tem Port nenhum.
  await saveSettingsFromPage(h, { autoMeet: true })
  await call.waitForTimeout(1000)
  await call.click('#participar')
  await expect.poll(() => fx(call, 'pcState'), { timeout: 15_000, intervals: [100] }).toBe('connected')
  const sw = await currentServiceWorker(h)
  await expect.poll(async () => (await swApi(sw).activeRecordings()).length, { timeout: 10_000, intervals: [250] }).toBe(1)
  expect(h.pageErrors).toEqual([])
})

test('a página da call não lê nenhum arquivo da extensão, e o vigia não carrega um arquivo com hash (Emenda 10)', async () => {
  const manifest = JSON.parse(readFileSync(join(DIST, 'manifest.json'), 'utf8')) as {
    web_accessible_resources?: unknown[]
    content_scripts: Array<{ js: string[]; world?: string }>
  }
  // Sem recursos acessíveis: a página não acha a extensão por uma URL fixa nem lê o código dela.
  expect(manifest.web_accessible_resources ?? []).toEqual([])
  // Os três content scripts são arquivos autocontidos (sem import() de um nome com hash, que some
  // num rebuild com a aba aberta).
  for (const cs of manifest.content_scripts) {
    for (const file of cs.js) {
      const code = readFileSync(join(DIST, file), 'utf8')
      expect(code, file).not.toMatch(/\bimport\s*\(/)
      expect(file, 'nome com hash').not.toMatch(/-[A-Za-z0-9_-]{8}\.js$/)
    }
  }
  h = await launchWithExtension({ installHost: false })
  const call = await h.context.newPage()
  await call.goto('https://meet.google.com/abc-defg-hij?variante=normal&sala=war')
  const files = ['manifest.json', ...readdirSync(join(DIST, 'assets')).map((f) => `assets/${f}`)]
  const readable = await call.evaluate(
    async ([id, list]) => {
      const out: string[] = []
      for (const f of list) {
        try {
          const r = await fetch(`chrome-extension://${id}/${f}`)
          if (r.ok) out.push(f)
        } catch {
          // bloqueado: é o esperado
        }
      }
      return out
    },
    [EXTENSION_ID, files] as [string, string[]],
  )
  expect(readable).toEqual([])
})
