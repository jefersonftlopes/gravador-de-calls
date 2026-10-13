// Reserva downloads (AC9) e o helper que some no meio da sessão (AC10):
// - sem helper desde o início: `Downloads/Gravações de calls/[perfil/]AAAA-MM/...`, com Blobs
//   `audio/webm` e `application/json` e o info.json por último; duas calls do mesmo minuto e
//   título viram "X" e "X (2)";
// - o helper some e volta antes do fim: os chunks que ficaram só no IndexedDB vão para o helper;
// - o helper some e não volta: salva em downloads, e o staging que sobrou no helper é apagado
//   pela primeira passada da recuperação depois que ele volta. O RECOVER_ALARM sai quando nada
//   fica aberto, então em uso essa passada é a do próximo início do SW, da próxima abertura do
//   Chrome ou do alarme de outra gravação; aqui o teste a chama direto (recoverNow).
// O helper é derrubado só neste perfil: o processo filho do Chrome deste user-data-dir (outros
// testes da máquina rodam os seus helpers ao mesmo tempo).
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { decodePcm, measureWindows, median, RATE } from '../helpers/audio'
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

async function joinCall(hh: Harness, room: string, tone = 440): Promise<Page> {
  const peer = await hh.context.newPage()
  await peer.goto(`https://meet.google.com/__peer?tom=${tone}&sala=${room}`)
  await peer.click('#iniciar')
  const call = await hh.context.newPage()
  await call.goto(`https://meet.google.com/abc-defg-hij?variante=normal&sala=${room}`)
  await expect.poll(() => call.evaluate(() => (window as any).fixture.micLive)).toBe(true)
  await call.click('#participar')
  return call
}

const leave = (call: Page) => call.click('button[jsname="CQylAd"]')

/** Pastas de gravação dentro de Downloads/Gravações de calls (com o nível do perfil, se houver). */
function downloadsRecordings(hh: Harness, profile?: string) {
  return findRecordings(join(hh.downloadsDir!, 'Gravações de calls'), profile)
}

/** PIDs do helper deste perfil: filhos do processo principal do Chrome deste user-data-dir. */
function helperPids(hh: Harness): number[] {
  const rows = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\n')
    .map((l) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), cmd: m[3] }))
  const browser = rows.find((r) => r.ppid === process.pid && r.cmd.includes(`--user-data-dir=${hh.userDataDir}`))
  if (!browser) throw new Error('processo do Chrome deste perfil não encontrado')
  return rows.filter((r) => r.ppid === browser.pid && r.cmd.includes('gravador-host.mjs')).map((r) => r.pid)
}

const wrapper = (hh: Harness) => join(hh.base, 'gravador-host.sh')

/** O helper some: o wrapper do manifesto deixa de existir e o processo vivo morre. */
async function killHelper(hh: Harness): Promise<number[]> {
  renameSync(wrapper(hh), `${wrapper(hh)}.desligado`)
  const pids = helperPids(hh)
  for (const pid of pids) process.kill(pid, 'SIGKILL')
  await expect.poll(() => helperPids(hh)).toEqual([])
  return pids
}

function restoreHelper(hh: Harness) {
  renameSync(`${wrapper(hh)}.desligado`, wrapper(hh))
}

function expectTone(file: string, tone: number, other?: number) {
  const pcm = decodePcm(file)
  const w = measureWindows(pcm, other ? [tone, other] : [tone]).slice(3, -1)
  expect(w.length).toBeGreaterThanOrEqual(5)
  expect(median(w.map((x) => x.db[tone]))).toBeGreaterThan(-20)
  for (const x of w) {
    expect(x.db[tone], `${file} segundo ${x.second}`).toBeGreaterThan(-20)
    if (other) expect(x.db[other], `${file} segundo ${x.second}`).toBeLessThanOrEqual(x.db[tone] - 30)
  }
  return pcm.length / RATE
}

test('sem helper: Downloads/Gravações de calls/Trabalho/AAAA-MM/, Blobs audio/webm e application/json, info.json por último, X e X (2)', async () => {
  h = await launchWithExtension({ installHost: false, downloads: true, settings: { profileLabel: 'Trabalho' } })
  const api = swApi(h.sw)
  expect((await api.pingHost(true)).ok).toBe(false)
  // As duas calls precisam começar no mesmo minuto (o nome da pasta tem HHhMM).
  const sec = new Date().getSeconds()
  if (sec > 35) await new Promise((r) => setTimeout(r, (61 - sec) * 1000))
  const calls = await Promise.all([joinCall(h, 'dl-a', 440), joinCall(h, 'dl-b', 660)])
  await expect.poll(async () => (await api.activeRecordings()).length, { timeout: 10_000 }).toBe(2)
  const active = await api.activeRecordings()
  for (const a of active) expect(await h.sw.evaluate(async (id) => (await chrome.tabs.get(id)).autoDiscardable, a.tabId)).toBe(false)
  // O tom de cada sessão sai da sala da aba dela (os host_permissions dão a URL).
  const toneOf = new Map<string, number>()
  for (const a of active) {
    const url = await h.sw.evaluate(async (id) => (await chrome.tabs.get(id)).url ?? '', a.tabId)
    toneOf.set(a.sessionId, url.includes('sala=dl-a') ? 440 : 660)
  }
  await calls[0].waitForTimeout(12_000)
  // O Blob que o offscreen monta para o downloads, lido de volta numa página da extensão.
  const blobUrl = (await h.sw.evaluate(
    (sessionId) => (globalThis as any).__gravador.sendToOffscreen({ target: 'offscreen', t: 'offscreen:blob-url', sessionId, mime: 'audio/webm' }),
    active[0].sessionId,
  )) as { ok: boolean; url: string; bytes: number }
  expect(blobUrl.ok).toBe(true)
  const extPage = await h.context.newPage()
  await extPage.goto(new URL('/src/options/index.html', h.sw.url()).href)
  const blob = await extPage.evaluate(async (url) => {
    const b = await (await fetch(url)).blob()
    return { type: b.type, size: b.size }
  }, blobUrl.url)
  await extPage.close()
  expect(blob).toEqual({ type: 'audio/webm', size: blobUrl.bytes })
  expect(blob.size).toBeGreaterThan(0)
  await h.sw.evaluate((url) => (globalThis as any).__gravador.sendToOffscreen({ target: 'offscreen', t: 'offscreen:revoke', url }), blobUrl.url)
  await Promise.all(calls.map((c) => leave(c)))
  await expect.poll(() => downloadsRecordings(h!, 'Trabalho').filter((r) => r.info).length, { timeout: 20_000, intervals: [250] }).toBe(2)

  const recs = downloadsRecordings(h, 'Trabalho')
  const names = recs.map((r) => r.folder).sort()
  expect(names[0]).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}h\d{2} - Daily do time \(Meet\)$/)
  expect(names[1]).toBe(`${names[0]} (2)`)
  // Nada na raiz do helper (que nem existe aqui) e nada direto em Downloads.
  expect(findRecordings(h.root)).toEqual([])
  // (a pasta vazia do canário é do harness)
  expect(readdirSync(h.downloadsDir!).filter((n) => n !== 'gravador-canario')).toEqual(['Gravações de calls'])

  const items = (await h.sw.evaluate(async () =>
    (await chrome.downloads.search({})).map((d) => ({ id: d.id, filename: d.filename, mime: d.mime, state: d.state })),
  )) as Array<{ id: number; filename: string; mime: string; state: string }>
  for (const rec of recs) {
    const info = rec.info!
    expect(rec.files).toEqual(['audio.webm', 'info.json'])
    expect(info).toMatchObject({ perfil: 'Trabalho', status: 'concluida', motivoFim: 'saiu-da-call', helper: null, lacunas: [] })
    const audio = join(rec.dir, 'audio.webm')
    expect(info.arquivos[0].bytes).toBe(statSync(audio).size)
    // info.json por último.
    expect(statSync(join(rec.dir, 'info.json')).mtimeMs).toBeGreaterThanOrEqual(statSync(audio).mtimeMs)
    // Ordem pelo ID do download (o áudio antes do info.json). O info.json sai com o tipo
    // application/json (com text/plain o Chrome trocaria a extensão para .txt). Do áudio o
    // Chrome informa video/webm (medido no CfT 151, embora o Blob seja audio/webm): o que
    // importa é a extensão .webm ficar, e ela fica.
    const mine = items.filter((d) => d.filename.startsWith(rec.dir + '/')).sort((x, y) => x.id - y.id)
    expect(mine.map((d) => [d.filename.slice(rec.dir.length + 1), d.state])).toEqual([
      ['audio.webm', 'complete'],
      ['info.json', 'complete'],
    ])
    expect(mine[0].mime).toMatch(/^(audio|video)\/webm$/)
    expect(mine[1].mime).toBe('application/json')
  }
  // Cada pasta tem o tom da sua call e não o da outra.
  for (const rec of recs) {
    const mine = toneOf.get(rec.info!.sessao)!
    expect(mine, rec.folder).toBeDefined()
    const decoded = expectTone(join(rec.dir, 'audio.webm'), mine, mine === 440 ? 660 : 440)
    expect(Math.abs(decoded - rec.info!.duracaoSegundos)).toBeLessThanOrEqual(2)
  }
  // "Mostrar no Finder" pelo downloads: as últimas gravações guardam o downloadId do info.json.
  const recent = (await h.sw.evaluate(() => (globalThis as any).__gravador.loadRecent())) as Array<{ sessionId: string; sink: string; downloadId?: number; path: string }>
  for (const r of recent) {
    expect(r.sink).toBe('downloads')
    expect(items.find((d) => d.id === r.downloadId)?.filename.endsWith('/info.json')).toBe(true)
  }
  expect(recent.map((r) => r.path).sort()).toEqual(names.map((n) => `Gravações de calls/Trabalho/${recs[0].month}/${n}`))
  for (const a of active) await expect.poll(() => h!.sw.evaluate(async (id) => (await chrome.tabs.get(id)).autoDiscardable, a.tabId)).toBe(true)
  await expect.poll(() => api.countChunks()).toBe(0)
})

test('o helper some no meio e volta antes do fim: os chunks que ficaram só no IndexedDB vão para o helper', async () => {
  h = await launchWithExtension()
  const call = await joinCall(h, 'helper-volta')
  const api = swApi(h.sw)
  await expect.poll(async () => (await api.activeRecordings()).length, { timeout: 10_000 }).toBe(1)
  const [active] = await api.activeRecordings()
  const part = join(h.root, '.gravando', active.sessionId, 'audio.webm.part')
  await expect.poll(() => (existsSync(part) ? statSync(part).size : 0), { timeout: 10_000 }).toBeGreaterThan(0)

  const killed = await killHelper(h)
  expect(killed.length).toBe(1)
  const sizeAtKill = statSync(part).size
  const chunksAtKill = await api.countChunks(active.sessionId)
  await call.waitForTimeout(12_000)
  // Sem helper: o staging parou, mas os chunks continuaram entrando no IndexedDB.
  expect(statSync(part).size).toBe(sizeAtKill)
  expect(await api.countChunks(active.sessionId)).toBeGreaterThanOrEqual(chunksAtKill + 2)
  expect((await api.pingHost(true)).ok).toBe(false)

  restoreHelper(h)
  await call.waitForTimeout(3_000)
  await leave(call)
  await expect.poll(() => findRecordings(h!.root).filter((r) => r.info).length, { timeout: 20_000, intervals: [250] }).toBe(1)
  const [rec] = findRecordings(h.root)
  const info = rec.info!
  expect(info).toMatchObject({ sessao: active.sessionId, status: 'concluida', lacunas: [], helper: '0.5.0' })
  const audio = join(rec.dir, 'audio.webm')
  expect(info.arquivos[0].bytes).toBe(statSync(audio).size)
  // Sem buraco onde o helper esteve fora: o tom está em toda janela.
  const decoded = expectTone(audio, 440)
  console.log(`helper voltou: ${chunksAtKill} chunks antes da queda do helper, ${(statSync(audio).size / 1024).toFixed(1)} KB no fim, decodificado ${decoded.toFixed(2)} s, duração ${info.duracaoSegundos} s`)
  expect(Math.abs(decoded - info.duracaoSegundos)).toBeLessThanOrEqual(2)
  expect(stagingEntries(h.root)).toEqual([])
  await expect.poll(() => api.countChunks()).toBe(0)
  expect(h.logs.some((l) => l.includes('append recusado') || l.includes('helper'))).toBe(true)
})

test('o helper some no meio e não volta: salva em downloads; depois que ele volta, a passada seguinte da recuperação apaga a sobra do staging', async () => {
  h = await launchWithExtension({ downloads: true })
  const call = await joinCall(h, 'helper-some')
  const api = swApi(h.sw)
  await expect.poll(async () => (await api.activeRecordings()).length, { timeout: 10_000 }).toBe(1)
  const [active] = await api.activeRecordings()
  const part = join(h.root, '.gravando', active.sessionId, 'audio.webm.part')
  await expect.poll(() => (existsSync(part) ? statSync(part).size : 0), { timeout: 10_000 }).toBeGreaterThan(0)
  await killHelper(h)
  await call.waitForTimeout(10_000)
  await leave(call)
  await expect.poll(() => downloadsRecordings(h!).filter((r) => r.info).length, { timeout: 20_000, intervals: [250] }).toBe(1)
  const [rec] = downloadsRecordings(h)
  expect(rec.info).toMatchObject({ sessao: active.sessionId, status: 'concluida', helper: null, lacunas: [] })
  const decoded = expectTone(join(rec.dir, 'audio.webm'), 440)
  expect(Math.abs(decoded - rec.info!.duracaoSegundos)).toBeLessThanOrEqual(2)
  // Na raiz do helper só ficou o staging parcial (nenhuma pasta final).
  expect(findRecordings(h.root)).toEqual([])
  expect(stagingEntries(h.root)).toEqual([active.sessionId])

  // O info.json aparece no disco um pouco antes de o SW marcar "salva" (o download ainda é
  // conferido e a sessão gravada): até lá a recuperação deixa o staging de uma sessão que está
  // finalizando agora, de propósito. Sem esperar, o teste dependia da sorte (Emenda 10).
  await expect
    .poll(async () => (await api.listSessions()).find((s) => s.sessionId === active.sessionId)?.status, { timeout: 10_000 })
    .toBe('salva')
  // O helper volta: a passada seguinte da recuperação vê que a sessão já foi salva e apaga a sobra.
  restoreHelper(h)
  await api.testing('recoverNow')
  expect(stagingEntries(h.root)).toEqual([])
  expect(findRecordings(h.root)).toEqual([])
  expect(downloadsRecordings(h).length).toBe(1)
})
