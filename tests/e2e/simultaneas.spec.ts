// AC4: três calls do Meet ao mesmo tempo, no mesmo perfil, cada uma na sua aba e com o seu
// participante remoto (440, 660 e 880 Hz). Saem três pastas, e cada arquivo tem só o seu tom: os
// outros dois e o microfone falso (1000 Hz) pelo menos 30 dB abaixo, janela a janela.
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { decodePcm, measureWindows, median } from '../helpers/audio'
import { launchWithExtension, swApi, type Harness } from '../helpers/browser'
import { findRecordings, stagingEntries } from '../helpers/recordings'

let h: Harness | undefined

test.afterEach(async ({}, testInfo) => {
  if (h && testInfo.status !== testInfo.expectedStatus) {
    await testInfo.attach('console', { body: h.logs.join('\n'), contentType: 'text/plain' })
    console.log(h.logs.join('\n'))
  }
  await h?.close()
  h = undefined
})

const TONES = [440, 660, 880] as const
const CODES = ['abc-defg-hij', 'klm-nopq-rst', 'uvw-xyza-bcd'] as const

async function joinCall(harness: Harness, tone: number, code: string): Promise<Page> {
  const room = `simultanea-${tone}`
  const peer = await harness.context.newPage()
  await peer.goto(`https://meet.google.com/__peer?tom=${tone}&sala=${room}`)
  await peer.click('#iniciar')
  await expect.poll(() => peer.evaluate(() => (window as any).fixture.state)).toBe('pronto')
  const call = await harness.context.newPage()
  await call.goto(`https://meet.google.com/${code}?variante=normal&sala=${room}`)
  await expect.poll(() => call.evaluate(() => (window as any).fixture.micLive)).toBe(true)
  await call.click('#participar')
  return call
}

test('três calls simultâneas em três abas dão três pastas, cada arquivo só com o seu tom (AC4)', async () => {
  h = await launchWithExtension()
  const api = swApi(h.sw)
  const calls: Page[] = []
  for (let i = 0; i < TONES.length; i++) calls.push(await joinCall(h, TONES[i], CODES[i]))
  await expect.poll(async () => (await api.activeRecordings()).length, { timeout: 15_000, intervals: [250] }).toBe(3)
  const active = await api.activeRecordings()
  expect(new Set(active.map((a) => a.tabId)).size, 'uma gravação por aba').toBe(3)

  await calls[0].waitForTimeout(15_000)
  await Promise.all(calls.map((c) => c.click('button[jsname="CQylAd"]')))
  await expect.poll(() => findRecordings(h!.root).filter((r) => r.info).length, { timeout: 20_000, intervals: [250] }).toBe(3)
  expect(stagingEntries(h.root)).toEqual([])

  const recs = findRecordings(h.root)
  expect(new Set(recs.map((r) => r.dir)).size).toBe(3)
  const notes: string[] = []
  for (const rec of recs) {
    const i = CODES.indexOf(rec.info!.codigo as (typeof CODES)[number])
    expect(i, `código ${rec.info!.codigo}`).toBeGreaterThanOrEqual(0)
    const mine = TONES[i]
    const others = [...TONES.filter((t) => t !== mine), 1000]
    expect(rec.files).toEqual(['audio.webm', 'info.json'])
    // Pula os 3 primeiros segundos (atraso de 1,5 s do mixer e arranque) e o último.
    const windows = measureWindows(decodePcm(join(rec.dir, 'audio.webm')), [mine, ...others]).slice(3, -1)
    expect(windows.length).toBeGreaterThanOrEqual(8)
    expect(median(windows.map((w) => w.db[mine]))).toBeGreaterThan(-20)
    for (const w of windows) for (const f of others) expect(w.db[f], `${rec.folder}: ${f} Hz no segundo ${w.second}`).toBeLessThanOrEqual(w.db[mine] - 30)
    const worst = Math.max(...windows.flatMap((w) => others.map((f) => w.db[f] - w.db[mine])))
    notes.push(`${mine} Hz: mediana ${median(windows.map((w) => w.db[mine])).toFixed(1)} dBFS, vizinho mais forte a ${worst.toFixed(1)} dB do tom, ${windows.length} janelas`)
  }
  const note = `AC4 três abas: ${notes.join(' | ')}`
  test.info().annotations.push({ type: 'audio', description: note })
  console.log(note)
  expect(h.pageErrors).toEqual([])
})
