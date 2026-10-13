// O service worker reinicia no meio da gravação: o relay reconecta, manda session:resume e
// reenvia o que não teve ack; o SW retoma do IndexedDB. Nada se perde (AC10, parte do SW).
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { decodePcm, measureWindows, RATE } from '../helpers/audio'
import { currentServiceWorker, launchWithExtension, stopExtensionServiceWorker, swApi, type Harness } from '../helpers/browser'
import { findRecordings } from '../helpers/recordings'

let h: Harness

test.afterEach(async ({}, testInfo) => {
  if (h && testInfo.status !== testInfo.expectedStatus) {
    await testInfo.attach('console', { body: h.logs.join('\n'), contentType: 'text/plain' })
    console.log(h.logs.join('\n'))
  }
  await h?.close()
})

test('SW reinicia no meio da gravação e o arquivo sai inteiro, sem lacuna', async () => {
  // Com nome de perfil: a pasta ganha o nível <raiz>/Trabalho/ (Emenda 1).
  h = await launchWithExtension({ settings: { profileLabel: 'Trabalho' } })
  const peer = await h.context.newPage()
  await peer.goto('https://meet.google.com/__peer?tom=440&sala=queda')
  await peer.click('#iniciar')
  const call = await h.context.newPage()
  await call.goto('https://meet.google.com/abc-defg-hij?variante=normal&sala=queda')
  await expect.poll(() => call.evaluate(() => (window as any).fixture.micLive)).toBe(true)
  await call.click('#participar')
  await expect.poll(async () => (await swApi(h.sw).activeRecordings()).length, { timeout: 10_000 }).toBe(1)
  const [active] = await swApi(h.sw).activeRecordings()

  // Depois do primeiro chunk (5 s), derruba o SW.
  await call.waitForTimeout(7_000)
  const states = await stopExtensionServiceWorker(h)
  expect(states, `estados do SW: ${states.join(',')}`).toContain('stopped')

  // O próximo chunk do relay acorda o SW; a gravação continua na mesma sessão.
  await call.waitForTimeout(13_000)
  const sw = await currentServiceWorker(h)
  const api = swApi(sw)
  expect((await api.activeRecordings()).map((a) => a.sessionId)).toEqual([active.sessionId])

  await call.click('button[jsname="CQylAd"]')
  await expect.poll(() => findRecordings(h.root, 'Trabalho').filter((r) => r.info).length, { timeout: 15_000, intervals: [250] }).toBe(1)
  expect(findRecordings(h.root)).toEqual([])
  const [rec] = findRecordings(h.root, 'Trabalho')
  const info = rec.info!
  expect(info.sessao).toBe(active.sessionId)
  expect(info.perfil).toBe('Trabalho')
  expect(info.status).toBe('concluida')
  expect(info.lacunas).toEqual([])
  const audio = join(rec.dir, 'audio.webm')
  expect(info.arquivos[0].bytes).toBe(statSync(audio).size)

  const pcm = decodePcm(audio)
  expect(Math.abs(pcm.length / RATE - info.duracaoSegundos)).toBeLessThanOrEqual(2)
  // Sem buraco: o tom está presente em toda janela depois do arranque.
  for (const w of measureWindows(pcm, [440]).slice(3, -1)) expect(w.db[440], `segundo ${w.second}`).toBeGreaterThan(-20)

  await expect.poll(() => api.countChunks()).toBe(0)
  // A mesma sessão foi aceita uma vez só e retomada pelo relay depois do reinício.
  expect(h.logs.filter((l) => l.includes('sessão aceita')).length).toBe(1)
  expect(h.logs.some((l) => l.includes(`sessão retomada ${active.sessionId}`))).toBe(true)
})

test('SW cai entre receber um chunk e gravá-lo no IndexedDB: o relay reenvia e o arquivo sai sem lacuna', async () => {
  // AC10, regra "o SW grava cada chunk no IndexedDB ANTES de mandar o ack": o SW segura o chunk 1
  // antes de gravar (gancho de teste) e é derrubado nessa janela. Sem ack, o relay ainda guarda o
  // chunk e o reenvia depois de reconectar. Se o ack saísse antes de gravar, o relay teria soltado
  // o chunk e o arquivo teria um buraco de 5 s (lacunas [{1,1}] e duração menor).
  h = await launchWithExtension()
  const peer = await h.context.newPage()
  await peer.goto('https://meet.google.com/__peer?tom=440&sala=queda-ack')
  await peer.click('#iniciar')
  const call = await h.context.newPage()
  await call.goto('https://meet.google.com/abc-defg-hij?variante=normal&sala=queda-ack')
  await expect.poll(() => call.evaluate(() => (window as any).fixture.micLive)).toBe(true)
  await call.click('#participar')
  await expect.poll(async () => (await swApi(h.sw).activeRecordings()).length, { timeout: 10_000 }).toBe(1)
  const [active] = await swApi(h.sw).activeRecordings()

  await swApi(h.sw).holdPersistAt(1)
  await expect.poll(() => swApi(h.sw).heldPersistSeq(), { timeout: 15_000, intervals: [100] }).toBe(1)
  // O chunk 1 está no SW, ainda fora do IndexedDB.
  expect(await swApi(h.sw).countChunks(active.sessionId)).toBe(1)
  const states = await stopExtensionServiceWorker(h)
  expect(states, `estados do SW: ${states.join(',')}`).toContain('stopped')

  await call.waitForTimeout(8_000)
  const sw = await currentServiceWorker(h)
  const api = swApi(sw)
  expect((await api.activeRecordings()).map((a) => a.sessionId)).toEqual([active.sessionId])
  expect(await api.heldPersistSeq()).toBeNull()

  await call.click('button[jsname="CQylAd"]')
  await expect.poll(() => findRecordings(h.root).filter((r) => r.info).length, { timeout: 10_000, intervals: [250] }).toBe(1)
  const [rec] = findRecordings(h.root)
  const info = rec.info!
  expect(info.sessao).toBe(active.sessionId)
  expect(info.lacunas).toEqual([])
  const pcm = decodePcm(join(rec.dir, 'audio.webm'))
  expect(Math.abs(pcm.length / RATE - info.duracaoSegundos), `decodificado ${(pcm.length / RATE).toFixed(2)} s`).toBeLessThanOrEqual(2)
  for (const w of measureWindows(pcm, [440]).slice(3, -1)) expect(w.db[440], `segundo ${w.second}`).toBeGreaterThan(-20)
  expect(h.logs.some((l) => l.includes('segurando o chunk 1'))).toBe(true)
  expect(h.logs.some((l) => l.includes(`sessão retomada ${active.sessionId}`))).toBe(true)
})
