// Emenda 1: dois perfis do Chrome (dois user-data-dirs, cada um com o seu helper) gravam ao
// mesmo tempo na MESMA raiz, com o mesmo título no mesmo minuto: duas pastas (X e X (2)), cada
// uma com o seu tom. E a recuperação de um perfil (SW reiniciado) não mexe no staging do outro.
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { decodePcm, measureWindows, median } from '../helpers/audio'
import { launchWithExtension, stopExtensionServiceWorker, swApi, type Harness } from '../helpers/browser'
import { findRecordings } from '../helpers/recordings'

const harnesses: Harness[] = []
let sharedRoot = ''

test.afterEach(async ({}, testInfo) => {
  for (const h of harnesses) {
    if (testInfo.status !== testInfo.expectedStatus) console.log(h.logs.join('\n'))
    await h.close()
  }
  harnesses.length = 0
  // A raiz fica dentro de uma pasta temporária própria: apaga a pasta inteira, não só a raiz.
  if (sharedRoot) rmSync(dirname(sharedRoot), { recursive: true, force: true })
  sharedRoot = ''
})

async function joinCall(h: Harness, tone: number, room: string): Promise<Page> {
  const peer = await h.context.newPage()
  await peer.goto(`https://meet.google.com/__peer?tom=${tone}&sala=${room}`)
  await peer.click('#iniciar')
  const call = await h.context.newPage()
  await call.goto(`https://meet.google.com/abc-defg-hij?variante=normal&sala=${room}`)
  await expect.poll(() => call.evaluate(() => (window as any).fixture.micLive)).toBe(true)
  await call.click('#participar')
  return call
}

test('dois perfis na mesma raiz, mesmo título e minuto: X e X (2), cada um com o seu tom', async () => {
  sharedRoot = join(mkdtempSync(join(tmpdir(), 'gravador-raiz-')), 'Gravações de calls')
  const a = await launchWithExtension({ root: sharedRoot })
  harnesses.push(a)
  const b = await launchWithExtension({ root: sharedRoot })
  harnesses.push(b)

  // Os dois inícios precisam cair no mesmo minuto (o nome da pasta tem HHhMM).
  const sec = new Date().getSeconds()
  if (sec > 35) await new Promise((r) => setTimeout(r, (61 - sec) * 1000))

  const [callA, callB] = await Promise.all([joinCall(a, 440, 'perfil-a'), joinCall(b, 660, 'perfil-b')])
  for (const h of [a, b]) await expect.poll(async () => (await swApi(h.sw).activeRecordings()).length, { timeout: 10_000 }).toBe(1)
  const [sessA] = await swApi(a.sw).activeRecordings()
  const [sessB] = await swApi(b.sw).activeRecordings()

  await callA.waitForTimeout(6_000)
  // Recuperação do perfil A (SW reinicia e roda recoverSessions) enquanto B grava.
  const stagingB = join(sharedRoot, '.gravando', sessB.sessionId)
  const sizeBefore = statSync(join(stagingB, 'audio.webm.part')).size
  expect(await stopExtensionServiceWorker(a)).toContain('stopped')
  await callA.waitForTimeout(8_000)
  expect(statSync(join(stagingB, 'audio.webm.part')).size).toBeGreaterThan(sizeBefore)

  await Promise.all([callA.click('button[jsname="CQylAd"]'), callB.click('button[jsname="CQylAd"]')])
  await expect.poll(() => findRecordings(sharedRoot).filter((r) => r.info).length, { timeout: 15_000, intervals: [250] }).toBe(2)

  const recs = findRecordings(sharedRoot)
  const names = recs.map((r) => r.folder).sort()
  expect(names[0]).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}h\d{2} - Daily do time \(Meet\)$/)
  expect(names[1]).toBe(`${names[0]} (2)`)
  expect(readdirSync(join(sharedRoot, '.gravando'))).toEqual([])

  // Cada pasta tem o tom do seu perfil e não o do outro.
  const toneOf: Record<string, [number, number]> = { [sessA.sessionId]: [440, 660], [sessB.sessionId]: [660, 440] }
  for (const rec of recs) {
    const [mine, other] = toneOf[rec.info!.sessao]
    expect(mine, `pasta ${rec.folder}`).toBeDefined()
    const w = measureWindows(decodePcm(join(rec.dir, 'audio.webm')), [mine, other]).slice(3, -1)
    expect(median(w.map((x) => x.db[mine]))).toBeGreaterThan(-20)
    for (const x of w) expect(x.db[other], `${rec.folder} segundo ${x.second}`).toBeLessThanOrEqual(x.db[mine] - 30)
  }
})
