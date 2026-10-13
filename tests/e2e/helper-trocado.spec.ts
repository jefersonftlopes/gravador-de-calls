// Helper trocado no disco com a extensão aberta (Emenda 20), ponta a ponta no Chrome for Testing com
// o native messaging de verdade.
//
// Achado de uso real (13/10/2026): uma daily gravada uma hora depois de um `npm run instalar` saiu
// com o helper da versão anterior no info.json. O popup e as configurações perguntam ao helper a
// cada 1 ou 2 s e o Port nativo nunca fechava, então o processo que o Chrome abriu antes continuava
// vivo com o código antigo (um deles estava aberto havia 3 dias e 17 horas). Agora o Port ocioso
// fecha (30 s; aqui, 1,5 s pelo gancho `hostIdleMs`), menos durante uma gravação. Aqui:
// - popup aberto e fechado, helper trocado no disco: o popup seguinte mostra a versão nova, e o
//   processo antigo saiu;
// - helper trocado no meio de uma call: a gravação termina inteira com o processo de antes (o
//   info.json diz a versão antiga, sem lacunas), e o popup seguinte já mostra a nova.
import { execFileSync } from 'node:child_process'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { EXTENSION_ID, launchWithExtension, swApi, type Harness } from '../helpers/browser'
import { ROOT } from '../helpers/paths'
import { findRecordings } from '../helpers/recordings'

const POPUP = `chrome-extension://${EXTENSION_ID}/src/popup/index.html`
const CALL_URL = 'https://meet.google.com/abc-defg-hij?variante=normal&sala=helper-trocado'
const PEER_URL = 'https://meet.google.com/__peer?tom=440&sala=helper-trocado'
const IDLE_MS = 1500
const NEW_VERSION = '9.9.9'
const OLD_VERSION = /HOST_VERSION = '([^']+)'/.exec(readFileSync(join(ROOT, 'host', 'gravador-host.mjs'), 'utf8'))![1]

let h: Harness | undefined

test.afterEach(async ({}, testInfo) => {
  if (h && testInfo.status !== testInfo.expectedStatus) {
    await testInfo.attach('console', { body: h.logs.join('\n'), contentType: 'text/plain' })
    console.log(h.logs.join('\n'))
  }
  await h?.close()
  h = undefined
})

/** Pids dos processos do helper deste teste (o caminho instalado é só dele). */
function helperPids(base: string): number[] {
  try {
    return execFileSync('pgrep', ['-f', join(base, 'gravador-host.mjs')], { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean)
      .map(Number)
  } catch {
    return []
  }
}

/**
 * Troca o helper instalado por um que responde como a versão 9.9.9, como um `npm run instalar` de
 * uma versão nova: o arquivo muda no lugar, e um processo já aberto continua com o código dele.
 */
function installNewHelper(base: string): void {
  renameSync(join(base, 'gravador-host.mjs'), join(base, 'gravador-host-anterior.mjs'))
  writeFileSync(
    join(base, 'gravador-host.mjs'),
    [
      "import { encodeFrame, handle, readFrames } from './gravador-host-anterior.mjs'",
      'readFrames(process.stdin, async (msg) => {',
      '  let res = await handle(msg)',
      `  if (msg?.op === 'ping' && res.ok) res = { ...res, version: '${NEW_VERSION}' }`,
      '  process.stdout.write(encodeFrame(res))',
      '}, () => process.exit(0))',
      '',
    ].join('\n'),
  )
}

async function openPopup(harness: Harness): Promise<Page> {
  const popup = await harness.context.newPage()
  await popup.goto(POPUP)
  await expect(popup.getByTestId('helper')).toBeVisible()
  return popup
}

test('popup aberto e fechado, helper trocado no disco: o popup seguinte mostra a versão nova, e o processo antigo saiu', async () => {
  h = await launchWithExtension()
  await h.sw.evaluate((ms) => (globalThis as any).__gravador.testing.hostIdleMs(ms), IDLE_MS)
  const first = await openPopup(h)
  await expect(first.getByTestId('helper')).toContainText(`helper ${OLD_VERSION}`)
  const before = helperPids(h.base)
  expect(before.length, 'um processo do helper aberto pelo popup').toBe(1)

  installNewHelper(h.base)
  await first.close()
  // O processo antigo sai sozinho quando o Port fecha (fim do stdin).
  await expect.poll(() => helperPids(h!.base).filter((p) => before.includes(p)), { timeout: 10_000 }).toEqual([])

  // O cache de 15 s do ping pode mostrar a versão de antes por um instante; depois, a nova.
  const second = await openPopup(h)
  await expect(second.getByTestId('helper')).toContainText(`helper ${NEW_VERSION}`, { timeout: 25_000 })
})

test('helper trocado no meio de uma call: a gravação termina inteira com o processo de antes, e o popup seguinte mostra a versão nova', async () => {
  h = await launchWithExtension()
  await h.sw.evaluate((ms) => (globalThis as any).__gravador.testing.hostIdleMs(ms), IDLE_MS)
  const peer = await h.context.newPage()
  await peer.goto(PEER_URL)
  await peer.click('#iniciar')
  await expect.poll(() => peer.evaluate(() => (window as any).fixture.state)).toBe('pronto')
  const call = await h.context.newPage()
  await call.goto(CALL_URL)
  await expect.poll(() => call.evaluate(() => (window as any).fixture.micLive)).toBe(true)
  await call.click('#participar')
  const api = swApi(h.sw)
  await expect.poll(async () => (await api.activeRecordings()).length, { timeout: 20_000, intervals: [200] }).toBe(1)
  const [active] = await api.activeRecordings()
  await call.waitForTimeout(3000)
  const before = helperPids(h.base)
  expect(before.length).toBe(1)

  installNewHelper(h.base)
  // Bem mais que a espera do Port ocioso, com os appends de 5 s no meio: o processo continua o mesmo.
  await call.waitForTimeout(8000)
  expect(helperPids(h.base)).toEqual(before)

  const saved = h.sw.evaluate(([id]) => (globalThis as any).__gravador.waitTabSessionSaved(id, 20_000), [active.tabId] as [number])
  await call.click('button[jsname="CQylAd"]')
  expect(await saved, 'a gravação foi salva').toBe(true)
  const [rec] = findRecordings(h.root)
  expect(rec?.info).toMatchObject({ sessao: active.sessionId, status: 'concluida', lacunas: [], helper: OLD_VERSION })
  // Fim da gravação: o Port fecha e o processo antigo sai.
  await expect.poll(() => helperPids(h!.base).filter((p) => before.includes(p)), { timeout: 10_000 }).toEqual([])

  const popup = await openPopup(h)
  await expect(popup.getByTestId('helper')).toContainText(`helper ${NEW_VERSION}`, { timeout: 25_000 })
})
