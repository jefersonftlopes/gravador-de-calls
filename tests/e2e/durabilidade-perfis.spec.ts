// Emenda 1 (AC17): a recuperação do perfil A, rodando enquanto A e B gravam na MESMA raiz, só
// mexe no staging do próprio A. Um staging órfão de A (sem registro no IndexedDB) é salvo como
// "Gravação recuperada"; o staging vivo de B continua crescendo e a gravação de B sai inteira.
// As duas calls têm o mesmo título no mesmo minuto: "X" e "X (2)", cada uma com o seu tom.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { decodePcm, measureWindows, median } from '../helpers/audio'
import { launchWithExtension, swApi, type Harness } from '../helpers/browser'
import { findRecordings } from '../helpers/recordings'

const harnesses: Harness[] = []
let sharedRoot = ''

test.afterEach(async ({}, testInfo) => {
  for (const h of harnesses) {
    if (testInfo.status !== testInfo.expectedStatus) console.log(h.logs.join('\n'))
    await h.close()
  }
  harnesses.length = 0
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

const profileIdOf = (h: Harness) => h.sw.evaluate(async () => (await chrome.storage.local.get('profileId')).profileId as string)
const partSize = (sessionId: string) => statSync(join(sharedRoot, '.gravando', sessionId, 'audio.webm.part')).size

const ORPHAN_ID = '20261006-143000-99-abcd'

/** Staging que o helper de A deixou sem registro no IndexedDB (ex.: o IndexedDB se perdeu). */
function plantOrphan(owner: string) {
  const dir = join(sharedRoot, '.gravando', ORPHAN_ID)
  mkdirSync(dir, { recursive: true })
  const old = new Date(Date.now() - 60 * 60_000)
  writeFileSync(join(dir, 'owner.json'), JSON.stringify({ owner, sessionId: ORPHAN_ID, createdAt: old.toISOString(), pid: 1 }))
  writeFileSync(join(dir, 'audio.webm.part'), Buffer.alloc(1000, 7))
  writeFileSync(join(dir, 'audio.webm.part.json'), JSON.stringify({ nextSeq: 2, bytes: 1000 }))
  for (const f of readdirSync(dir)) utimesSync(join(dir, f), old, old)
}

test('perfil A recupera enquanto A e B gravam na mesma raiz: só o staging de A é tocado; X e X (2) com o seu tom', async () => {
  sharedRoot = join(mkdtempSync(join(tmpdir(), 'gravador-raiz-')), 'Gravações de calls')
  const a = await launchWithExtension({ root: sharedRoot })
  harnesses.push(a)
  const b = await launchWithExtension({ root: sharedRoot })
  harnesses.push(b)
  const [ownerA, ownerB] = [await profileIdOf(a), await profileIdOf(b)]
  expect(ownerA).not.toBe(ownerB)
  plantOrphan(ownerA)

  const sec = new Date().getSeconds()
  if (sec > 35) await new Promise((r) => setTimeout(r, (61 - sec) * 1000))
  const [callA, callB] = await Promise.all([joinCall(a, 440, 'rec-a'), joinCall(b, 660, 'rec-b')])
  for (const h of [a, b]) await expect.poll(async () => (await swApi(h.sw).activeRecordings()).length, { timeout: 10_000 }).toBe(1)
  const [sessA] = await swApi(a.sw).activeRecordings()
  const [sessB] = await swApi(b.sw).activeRecordings()
  await callA.waitForTimeout(7_000)
  const before = { a: partSize(sessA.sessionId), b: partSize(sessB.sessionId) }
  expect(before.b).toBeGreaterThan(0)

  // Passada da recuperação em A, com o limite de "parado" zerado: todo staging sem registro que A
  // enxergar vira "Gravação recuperada". O de B não tem registro em A; só o filtro de dono o salva.
  const api = swApi(a.sw)
  await api.testing('orphanIdleMs', 0)
  await api.testing('recoverNow')
  await api.testing('orphanIdleMs', null)

  const recovered = findRecordings(sharedRoot).filter((r) => r.folder.endsWith('Gravação recuperada'))
  expect(recovered.map((r) => [r.month, r.folder, r.files])).toEqual([['2026-10', '2026-10-06 14h30 - Gravação recuperada', ['audio.webm', 'info.json']]])
  expect(recovered[0].info).toMatchObject({ sessao: ORPHAN_ID, status: 'interrompida', motivoFim: 'interrompida', semRegistro: true })
  expect(readFileSync(join(recovered[0].dir, 'audio.webm')).length).toBe(1000)
  expect(existsSync(join(sharedRoot, '.gravando', ORPHAN_ID))).toBe(false)

  // B continua gravando no mesmo staging, e A no dele.
  await callA.waitForTimeout(6_000)
  expect(readdirSync(join(sharedRoot, '.gravando')).sort()).toEqual([sessA.sessionId, sessB.sessionId].sort())
  expect(partSize(sessB.sessionId)).toBeGreaterThan(before.b)
  expect(partSize(sessA.sessionId)).toBeGreaterThan(before.a)

  await Promise.all([callA.click('button[jsname="CQylAd"]'), callB.click('button[jsname="CQylAd"]')])
  const calls = () => findRecordings(sharedRoot).filter((r) => r.info && !r.folder.endsWith('Gravação recuperada'))
  await expect.poll(() => calls().length, { timeout: 15_000, intervals: [250] }).toBe(2)
  const recs = calls()
  const names = recs.map((r) => r.folder).sort()
  expect(names[0]).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}h\d{2} - Daily do time \(Meet\)$/)
  expect(names[1]).toBe(`${names[0]} (2)`)
  expect(readdirSync(join(sharedRoot, '.gravando'))).toEqual([])

  const toneOf: Record<string, [number, number]> = { [sessA.sessionId]: [440, 660], [sessB.sessionId]: [660, 440] }
  for (const rec of recs) {
    expect(rec.info!.lacunas).toEqual([])
    const [mine, other] = toneOf[rec.info!.sessao]
    expect(mine, `pasta ${rec.folder}`).toBeDefined()
    const w = measureWindows(decodePcm(join(rec.dir, 'audio.webm')), [mine, other]).slice(3, -1)
    expect(median(w.map((x) => x.db[mine]))).toBeGreaterThan(-20)
    for (const x of w) {
      expect(x.db[mine], `${rec.folder} segundo ${x.second}`).toBeGreaterThan(-20)
      expect(x.db[other], `${rec.folder} segundo ${x.second}`).toBeLessThanOrEqual(x.db[mine] - 30)
    }
  }
  // B nunca foi recuperado por ninguém.
  expect(b.logs.some((l) => l.includes('recuperação'))).toBe(false)
  expect(a.logs.some((l) => l.includes(sessB.sessionId))).toBe(false)
})
