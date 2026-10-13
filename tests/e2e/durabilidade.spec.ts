// Durabilidade (AC10, AC15): o Chrome cai (SIGKILL) ou fecha normalmente no meio da call e a
// gravação sai "interrompida" na próxima abertura, com o áudio até ~5 s antes; fechar a aba no
// meio é fim normal ("aba-fechada"); gravação mais curta que a duração mínima é descartada; a
// aba que grava não pode ser descartada pelo Chrome.
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { decodePcm, measureWindows, median, RATE } from '../helpers/audio'
import { launchWithExtension, swApi, type Harness } from '../helpers/browser'
import { findRecordings, stagingEntries } from '../helpers/recordings'
import type { ActiveRecording } from '../../src/shared/protocol'

let h: Harness | undefined

test.afterEach(async ({}, testInfo) => {
  if (h && testInfo.status !== testInfo.expectedStatus) {
    await testInfo.attach('console', { body: h.logs.join('\n'), contentType: 'text/plain' })
    console.log(h.logs.join('\n'))
  }
  await h?.close()
  h = undefined
})

async function joinCall(hh: Harness, room: string, tone = 440): Promise<Page> {
  const peer = await hh.context.newPage()
  await peer.goto(`https://meet.google.com/__peer?tom=${tone}&sala=${room}`)
  await peer.click('#iniciar')
  const call = await hh.context.newPage()
  await call.goto(`https://meet.google.com/abc-defg-hij?variante=normal&sala=${room}`)
  await expect.poll(() => call.evaluate(() => (window as any).fixture.micLive)).toBe(true)
  await call.click('#participar')
  await expect.poll(async () => (await swApi(hh.sw).activeRecordings()).length, { timeout: 10_000 }).toBe(1)
  return call
}

/** activeRecordings com o tipo completo (o swApi compartilhado só declara sessionId e tabId). */
const activeOf = async (hh: Harness) => (await swApi(hh.sw).activeRecordings()) as unknown as ActiveRecording[]

const autoDiscardable = (hh: Harness, tabId: number) =>
  hh.sw.evaluate(async (id) => (await chrome.tabs.get(id)).autoDiscardable, tabId)

test('o Chrome cai (SIGKILL) no meio da call: na próxima abertura sai "interrompida" com o áudio até ~5 s antes', async () => {
  h = await launchWithExtension()
  await joinCall(h, 'queda-chrome')
  const [active] = await activeOf(h)
  // Uns 3 chunks gravados e um em andamento.
  await new Promise((r) => setTimeout(r, 17_000))
  const crashAt = Date.now()
  await h.crash()
  // Nada foi salvo ainda: a queda não teve pagehide nem onRemoved.
  expect(findRecordings(h.root)).toEqual([])
  expect(stagingEntries(h.root)).toEqual([active.sessionId])

  const reopenedAt = Date.now()
  h = await h.relaunch()
  await expect.poll(() => findRecordings(h!.root).filter((r) => r.info).length, { timeout: 20_000, intervals: [250] }).toBe(1)
  const savedIn = Date.now() - reopenedAt
  const [rec] = findRecordings(h.root)
  const info = rec.info!
  expect(info).toMatchObject({ sessao: active.sessionId, status: 'interrompida', motivoFim: 'interrompida', lacunas: [] })
  expect(rec.files).toEqual(['audio.webm', 'info.json'])
  const audio = join(rec.dir, 'audio.webm')
  expect(info.arquivos[0].bytes).toBe(statSync(audio).size)

  // AC10: perde no máximo o chunk em andamento (timeslice de 5 s) mais o trânsito até o
  // IndexedDB; o atraso de 1,5 s do mixer já existe em toda gravação e cabe na mesma folga.
  const pcm = decodePcm(audio)
  const decoded = pcm.length / RATE
  const recordedUntilCrash = (crashAt - active.startedAt) / 1000
  const lost = recordedUntilCrash - decoded
  console.log(`queda: gravado até a queda ${recordedUntilCrash.toFixed(2)} s, decodificado ${decoded.toFixed(2)} s, perdido ${lost.toFixed(2)} s; duração no info ${info.duracaoSegundos} s; salvo ${savedIn} ms depois de reabrir`)
  expect(lost, `perdido ${lost.toFixed(2)} s`).toBeLessThanOrEqual(6.5)
  expect(decoded).toBeGreaterThanOrEqual(10)
  expect(Math.abs(decoded - info.duracaoSegundos)).toBeLessThanOrEqual(2)
  const db = measureWindows(pcm, [440]).slice(3, -1).map((w) => w.db[440])
  expect(median(db)).toBeGreaterThan(-20)
  for (const [i, x] of db.entries()) expect(x, `janela ${i + 3}`).toBeGreaterThan(-20)

  const api = swApi(h.sw)
  await expect.poll(() => api.countChunks()).toBe(0)
  expect((await api.listSessions()).map((s) => [s.sessionId, s.status])).toEqual([[active.sessionId, 'salva']])
  expect(stagingEntries(h.root)).toEqual([])
  expect(h.logs.some((l) => l.includes('recuperação: interrompida') && l.includes('outro boot do navegador'))).toBe(true)
})

test('o Chrome fecha normalmente no meio da call: na próxima abertura sai "interrompida" com o áudio até ~5 s antes', async () => {
  h = await launchWithExtension()
  await joinCall(h, 'chrome-fechado')
  const [active] = await activeOf(h)
  await new Promise((r) => setTimeout(r, 17_000))
  const closeAt = Date.now()
  // relaunch() sem crash(): fecha o contexto do jeito normal (com pagehide e onRemoved) e abre o
  // mesmo perfil de novo. O SW morre junto com o Chrome antes de a finalização terminar.
  const reopenedAt = Date.now()
  h = await h.relaunch()
  await expect.poll(() => findRecordings(h!.root).filter((r) => r.info).length, { timeout: 20_000, intervals: [250] }).toBe(1)
  const savedIn = Date.now() - reopenedAt
  const [rec] = findRecordings(h.root)
  const info = rec.info!
  expect(info).toMatchObject({ sessao: active.sessionId, status: 'interrompida', motivoFim: 'interrompida', lacunas: [] })
  expect(rec.files).toEqual(['audio.webm', 'info.json'])
  const audio = join(rec.dir, 'audio.webm')
  expect(info.arquivos[0].bytes).toBe(statSync(audio).size)

  const pcm = decodePcm(audio)
  const decoded = pcm.length / RATE
  const recordedUntilClose = (closeAt - active.startedAt) / 1000
  const lost = recordedUntilClose - decoded
  console.log(`Chrome fechado: gravado até fechar ${recordedUntilClose.toFixed(2)} s, decodificado ${decoded.toFixed(2)} s, perdido ${lost.toFixed(2)} s; duração no info ${info.duracaoSegundos} s; salvo ${savedIn} ms depois de reabrir`)
  expect(lost, `perdido ${lost.toFixed(2)} s`).toBeLessThanOrEqual(6.5)
  expect(decoded).toBeGreaterThanOrEqual(10)
  expect(Math.abs(decoded - info.duracaoSegundos)).toBeLessThanOrEqual(2)
  const db = measureWindows(pcm, [440]).slice(3, -1).map((w) => w.db[440])
  expect(median(db)).toBeGreaterThan(-20)
  for (const [i, x] of db.entries()) expect(x, `janela ${i + 3}`).toBeGreaterThan(-20)

  const api = swApi(h.sw)
  await expect.poll(() => api.countChunks()).toBe(0)
  expect((await api.listSessions()).map((s) => [s.sessionId, s.status])).toEqual([[active.sessionId, 'salva']])
  expect(stagingEntries(h.root)).toEqual([])
})

test('fechar a aba no meio da call: salva como concluída, motivoFim aba-fechada', async () => {
  h = await launchWithExtension()
  const call = await joinCall(h, 'aba-fechada')
  const [active] = await activeOf(h)
  await call.waitForTimeout(12_000)
  const closedAt = Date.now()
  await call.close()
  await expect.poll(() => findRecordings(h!.root).filter((r) => r.info).length, { timeout: 15_000, intervals: [250] }).toBe(1)
  const savedIn = Date.now() - closedAt
  const [rec] = findRecordings(h.root)
  const info = rec.info!
  expect(info).toMatchObject({ sessao: active.sessionId, status: 'concluida', motivoFim: 'aba-fechada' })
  const pcm = decodePcm(join(rec.dir, 'audio.webm'))
  const decoded = pcm.length / RATE
  const recordedUntilClose = (closedAt - active.startedAt) / 1000
  console.log(`aba fechada: gravado até fechar ${recordedUntilClose.toFixed(2)} s, decodificado ${decoded.toFixed(2)} s, lacunas ${JSON.stringify(info.lacunas)}, salvo em ${savedIn} ms`)
  expect(info.lacunas).toEqual([])
  expect(recordedUntilClose - decoded).toBeLessThanOrEqual(6.5)
  expect(savedIn).toBeLessThanOrEqual(10_000)
  for (const w of measureWindows(pcm, [440]).slice(3, -1)) expect(w.db[440], `segundo ${w.second}`).toBeGreaterThan(-20)
  expect(stagingEntries(h.root)).toEqual([])
})

test('mais curta que a duração mínima: descartada (helper, IndexedDB e status); autoDiscardable só enquanto grava', async () => {
  h = await launchWithExtension({ settings: { minSeconds: 30 } })
  const call = await joinCall(h, 'curta')
  const api = swApi(h.sw)
  const [active] = await api.activeRecordings()
  expect(await autoDiscardable(h, active.tabId)).toBe(false)
  await call.waitForTimeout(12_000)
  // O helper já recebeu os primeiros chunks (o descarte tem de apagar o staging).
  expect(stagingEntries(h.root)).toEqual([active.sessionId])
  expect(statSync(join(h.root, '.gravando', active.sessionId, 'audio.webm.part')).size).toBeGreaterThan(0)
  await call.click('button[jsname="CQylAd"]')
  await expect.poll(async () => (await api.listSessions()).map((s) => s.status), { timeout: 10_000 }).toEqual(['descartada'])
  expect(findRecordings(h.root)).toEqual([])
  await expect.poll(() => stagingEntries(h!.root)).toEqual([])
  expect(await api.countChunks()).toBe(0)
  await expect.poll(() => autoDiscardable(h!, active.tabId)).toBe(true)
  expect(h.logs.some((l) => l.includes('descartada') && l.includes(active.sessionId))).toBe(true)
})
