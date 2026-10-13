// Adaptador do Meet endurecido, ponta a ponta (AC1, AC6, AC8): as variantes novas do Meet falso
// (tests/fixtures/meet/variantes/) cobrem a espera para ser admitido, o DOM de call sem PC
// conectado, os metadados que mudam durante a call e os fins sem a tela de saída.
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

const fx = (page: Page, key: string) => page.evaluate((k) => (window as any).fixture[k], key)
const act = (page: Page, name: string) => page.evaluate((n) => (window as any).fixture[n](), name)

async function startPeer(harness: Harness, room: string): Promise<Page> {
  const peer = await harness.context.newPage()
  await peer.goto(`https://meet.google.com/__peer?tom=440&sala=${room}`)
  await peer.click('#iniciar')
  await expect.poll(() => peer.evaluate(() => (window as any).fixture.state)).toBe('pronto')
  return peer
}

async function openCall(harness: Harness, variant: string, room: string, code = 'abc-defg-hij'): Promise<Page> {
  const call = await harness.context.newPage()
  await call.goto(`https://meet.google.com/${code}?variante=${variant}&sala=${room}`)
  await expect.poll(() => fx(call, 'micLive')).toBe(true)
  return call
}

function savedPromise(harness: Harness, tabId: number, timeoutMs = 20_000) {
  return harness.sw.evaluate(
    async ([id, ms]) => {
      const g = (globalThis as any).__gravador
      const ok = await g.waitTabSessionSaved(id, ms)
      return { ok, at: Date.now() }
    },
    [tabId, timeoutMs] as [number, number],
  )
}

/** Espera a gravação começar e devolve quanto levou desde `t0`. */
async function waitRecording(harness: Harness, t0: number, timeout = 5_000) {
  const api = swApi(harness.sw)
  await expect.poll(async () => (await api.activeRecordings()).length, { timeout, intervals: [100] }).toBe(1)
  const [active] = await api.activeRecordings()
  return { ...active, startMs: Date.now() - t0 }
}

/**
 * Mediana do 440 Hz, com o microfone (1000 Hz) 30 dB abaixo janela a janela. Pula os 3 primeiros
 * segundos (atraso de 1,5 s do mixer + arranque) e o último; `seconds` limita às janelas em que o
 * tom ainda tocava (fins que esperam com o PC fechado).
 */
function audio440(dir: string, label: string, seconds?: number): number {
  const all = measureWindows(decodePcm(join(dir, 'audio.webm')), [440, 1000])
  const windows = seconds === undefined ? all.slice(3, -1) : all.slice(3, 3 + seconds)
  const db440 = windows.map((w) => w.db[440])
  const m = median(db440)
  console.log(`${label}: 440 Hz mediana ${m.toFixed(1)} dBFS em ${windows.length} janelas`)
  expect(windows.length).toBeGreaterThanOrEqual(5)
  for (const w of windows) expect(w.db[1000], `microfone no segundo ${w.second}`).toBeLessThanOrEqual(w.db[440] - 30)
  return m
}

async function noErrors(call: Page) {
  expect(await fx(call, 'errors')).toEqual([])
  expect(h!.pageErrors).toEqual([])
}

test('pedindo para participar: botão de sair, PC conectado e áudio tocando não gravam; admitido, começa em até 5 s e salva ao sair', async () => {
  h = await launchWithExtension()
  const api = swApi(h.sw)
  await startPeer(h, 'pedindo')
  const call = await openCall(h, 'pedindo-para-participar', 'pedindo')
  await call.waitForTimeout(3000)
  expect(await api.activeRecordings(), 'gravou no pré-join').toEqual([])

  await call.click('#participar')
  await expect.poll(() => fx(call, 'pcState'), { timeout: 15_000, intervals: [100] }).toBe('connected')
  await expect.poll(() => fx(call, 'remoteTrack')).toBe(true)
  await expect(call.locator('.google-symbols', { hasText: 'call_end' })).toBeVisible()
  await call.waitForTimeout(10_000)
  expect(await api.activeRecordings(), 'gravou pedindo para participar').toEqual([])
  expect(await api.listSessions()).toEqual([])

  // O anfitrião deixa entrar: legenda e chat aparecem, o PC já estava conectado.
  await act(call, 'admitir')
  const active = await waitRecording(h, Date.now())
  expect(active.startMs, `início em ${active.startMs} ms`).toBeLessThanOrEqual(5_000)
  await call.waitForTimeout(8000)

  const saved = savedPromise(h, active.tabId)
  await call.click('button[jsname="CQylAd"]')
  await expect(call.locator('h1[jsname="r4nke"]')).toBeVisible()
  const leftAt = Date.now()
  const r = await saved
  const saveMs = r.at - leftAt
  expect(r.ok).toBe(true)
  expect(saveMs, `salvo em ${saveMs} ms`).toBeLessThanOrEqual(10_000)
  const [rec] = findRecordings(h.root)
  // A tela de saída troca a aba para "Meet": vale a aba da última leitura em call.
  expect(await call.title()).toBe('Meet')
  expect(rec.info).toMatchObject({
    plataforma: 'meet',
    titulo: 'Daily do time',
    tituloFonte: 'dom',
    tituloDaAba: 'Meet - Daily do time',
    codigo: 'abc-defg-hij',
    motivoFim: 'saiu-da-call',
  })
  // A gravação começa na admissão: não tem os 10 s da espera.
  expect(rec.info!.duracaoSegundos).toBeLessThan(8 + 6)
  console.log(`Meet admitido: início em ${active.startMs} ms; salvo em ${saveMs} ms`)
  expect(audio440(rec.dir, 'Meet admitido')).toBeGreaterThan(-20)
  await noErrors(call)
})

test('DOM completo de call com um PC que nunca conecta (receptor "live" mudo) não grava', async () => {
  h = await launchWithExtension()
  const api = swApi(h.sw)
  const call = await openCall(h, 'sem-pc', 'sem-pc')
  await call.click('#participar')
  await expect.poll(() => fx(call, 'receptorVivo')).toBe(true)
  // Os outros quatro sinais estão na tela.
  await expect(call.locator('button[jsname="CQylAd"]')).toBeVisible()
  await expect(call.locator('.google-symbols', { hasText: 'closed_caption_off' })).toBeVisible()
  await expect(call.locator('h1[jsname="r4nke"]')).toHaveCount(0)
  await call.waitForTimeout(10_000)
  expect(await fx(call, 'pcState')).not.toBe('connected')
  expect(await api.activeRecordings()).toEqual([])
  expect(await api.listSessions()).toEqual([])
  expect(findRecordings(h.root)).toEqual([])
  expect(stagingEntries(h.root)).toEqual([])
  await noErrors(call)
})

test('metadados: título que aparece tarde, participantes que mudam, sem o próprio bloco; fim pelo pc.close() sem tela de saída', async () => {
  h = await launchWithExtension()
  await startPeer(h, 'meta')
  const call = await openCall(h, 'metadados', 'meta', 'qwe-rtyu-iop')
  await call.click('#participar')
  await expect.poll(() => fx(call, 'pcState'), { timeout: 15_000, intervals: [100] }).toBe('connected')
  const active = await waitRecording(h, Date.now())
  // Leituras do controlador no início e a cada 5 s. O título e o Bruno só existem entre 6,5 s e
  // 13 s (a leitura dos 10 s); no fim o título sumiu e a Carla entrou (a releitura do fim).
  await call.waitForTimeout(6500)
  await act(call, 'meioDaCall')
  await call.waitForTimeout(6500)
  await act(call, 'fimDaCall')
  await call.waitForTimeout(500)

  // O PC que tinha o áudio fecha e nenhum outro aparece em 5 s.
  const saved = savedPromise(h, active.tabId)
  await act(call, 'fecharPc')
  const closedAt = Date.now()
  const r = await saved
  const saveMs = r.at - closedAt
  expect(r.ok).toBe(true)
  // 5 s de carência + 1,5 s do atraso do mixer + a finalização.
  expect(saveMs, `salvo em ${saveMs} ms depois do pc.close()`).toBeLessThanOrEqual(10_000)
  expect(saveMs).toBeGreaterThanOrEqual(5_000)

  const [rec] = findRecordings(h.root)
  expect(rec.folder).toMatch(/ - Revisão de arquitetura \(Meet\)$/)
  const info = rec.info!
  expect(info).toMatchObject({
    plataforma: 'meet',
    titulo: 'Revisão de arquitetura',
    tituloFonte: 'dom',
    codigo: 'qwe-rtyu-iop',
    tituloDaAba: 'Meet - qwe-rtyu-iop',
    voce: 'Alex Lima',
    motivoFim: 'call-encerrada',
    status: 'concluida',
  })
  expect([...info.participantes].sort()).toEqual(['Ana Souza', 'Bruno Lima', 'Carla Dias'])
  console.log(`Meet metadados: início em ${active.startMs} ms; salvo ${saveMs} ms depois do pc.close()`)
  // Depois do pc.close(), 5 s de silêncio até o fim: mede só os 9 s com o tom.
  expect(audio440(rec.dir, 'Meet metadados', 9)).toBeGreaterThan(-20)
  await noErrors(call)
})

test('PC que fecha e volta em menos de 5 s não encerra; sem o ícone de legenda a call continua; sem o botão de sair por 15 s encerra como fora-da-call', async () => {
  h = await launchWithExtension()
  const api = swApi(h.sw)
  await startPeer(h, 'reconecta')
  const call = await openCall(h, 'metadados', 'reconecta')
  await call.click('#participar')
  await expect.poll(() => fx(call, 'pcState'), { timeout: 15_000, intervals: [100] }).toBe('connected')
  const active = await waitRecording(h, Date.now())
  await call.waitForTimeout(6000)

  // O PC novo só sobe 2 s depois: mais que um ciclo de 1 s sem PC com áudio.
  await act(call, 'reconectar')
  const reconnectedAt = Date.now()
  await expect.poll(() => fx(call, 'pcState'), { timeout: 2_000, intervals: [100] }).not.toBe('connected')
  await expect.poll(() => fx(call, 'pcState'), { timeout: 8_000, intervals: [100] }).toBe('connected')
  const reconnectMs = Date.now() - reconnectedAt
  expect(reconnectMs, `reconexão em ${reconnectMs} ms`).toBeGreaterThan(1_500)
  expect(reconnectMs, `reconexão em ${reconnectMs} ms`).toBeLessThan(4_500)
  await call.waitForTimeout(9000)
  expect((await api.activeRecordings()).map((x) => x.sessionId), `encerrou com a reconexão em ${reconnectMs} ms`).toEqual([active.sessionId])

  // Janela estreita (três perfis lado a lado): o Meet leva a legenda e o chat para o menu "mais
  // opções". Os ícones só separam a sala de espera no começo; gravando, a call continua (Emenda 10).
  await act(call, 'sumirLegenda')
  await call.waitForTimeout(18_000)
  expect((await api.activeRecordings()).map((x) => x.sessionId), 'encerrou só porque o ícone de legenda sumiu').toEqual([active.sessionId])

  const saved = savedPromise(h, active.tabId, 40_000)
  await act(call, 'sumirSair')
  const goneAt = Date.now()
  await call.waitForTimeout(12_000)
  expect((await api.activeRecordings()).length, 'encerrou antes dos 15 s').toBe(1)
  const r = await saved
  const totalMs = r.at - goneAt
  expect(r.ok).toBe(true)
  expect(totalMs).toBeGreaterThanOrEqual(15_000)
  expect(totalMs - 15_000, `salvo ${totalMs - 15_000} ms depois dos 15 s`).toBeLessThanOrEqual(10_000)

  const [rec] = findRecordings(h.root)
  expect(rec.info).toMatchObject({ plataforma: 'meet', motivoFim: 'fora-da-call', lacunas: [] })
  console.log(`Meet reconexão em ${reconnectMs} ms sem encerrar; fora da call salvo ${totalMs} ms depois de o botão de sair sumir`)
  // O áudio continua depois da reconexão (a faixa nova entra no mixer).
  const windows = measureWindows(decodePcm(join(rec.dir, 'audio.webm')), [440])
  const after = windows.slice(Math.ceil(6 + reconnectMs / 1000) + 3, Math.ceil(6 + reconnectMs / 1000) + 9).map((w) => w.db[440])
  console.log(`Meet depois da reconexão: 440 Hz mediana ${median(after).toFixed(1)} dBFS em ${after.length} janelas`)
  expect(after.length).toBeGreaterThanOrEqual(5)
  expect(median(after)).toBeGreaterThan(-20)
  await noErrors(call)
})

// AC6, "navegar para fora": a página troca de documento (pagehide manda o fim com o que já saiu)
// ou a SPA sai da URL de call sem recarregar (o laço de 1 s vê o matchesUrl falhar). No pagehide
// não dá para esperar o último dataavailable: vale o AC10, perde no máximo o último chunk (5 s)
// mais o atraso de 1,5 s do mixer. Os 13 s de call dão dois chunks inteiros antes de sair.
for (const caso of [
  { nome: 'documento novo', motivo: 'pagehide', sair: (call: Page) => call.goto('about:blank') },
  { nome: 'pushState para fora da URL de call', motivo: 'navegou', sair: (call: Page) => call.evaluate(() => history.pushState({}, '', '/landing')) },
] as const) {
  test(`navegar para fora (${caso.nome}): salva em até 10 s com motivoFim ${caso.motivo} (AC6)`, async () => {
    h = await launchWithExtension()
    await startPeer(h, `navega-${caso.motivo}`)
    const call = await openCall(h, 'metadados', `navega-${caso.motivo}`)
    await call.click('#participar')
    await expect.poll(() => fx(call, 'pcState'), { timeout: 15_000, intervals: [100] }).toBe('connected')
    const active = await waitRecording(h, Date.now())
    const recordingSince = Date.now()
    await call.waitForTimeout(13_000)

    const saved = savedPromise(h, active.tabId)
    const leftAt = Date.now()
    await caso.sair(call)
    const r = await saved
    const saveMs = r.at - leftAt
    console.log(`Meet navegou (${caso.nome}): salvo em ${saveMs} ms`)
    expect(r.ok).toBe(true)
    expect(saveMs, `salvo em ${saveMs} ms`).toBeLessThanOrEqual(10_000)
    const recs = findRecordings(h.root)
    expect(recs).toHaveLength(1)
    // Os dados da call são os da última leitura dentro dela, não os da página para onde foi.
    expect(recs[0].info).toMatchObject({
      plataforma: 'meet',
      codigo: 'abc-defg-hij',
      tituloDaAba: 'Meet - abc-defg-hij',
      status: 'concluida',
      motivoFim: caso.motivo,
      lacunas: [],
    })
    expect(recs[0].folder).toMatch(/ - abc-defg-hij \(Meet\)$/)
    expect(audio440(recs[0].dir, `Meet navegou (${caso.nome})`)).toBeGreaterThan(-20)
    // Contra o relógio do teste, não contra a duração do info.json (que já é a do que chegou).
    const decoded = measureWindows(decodePcm(join(recs[0].dir, 'audio.webm')), [440]).length
    const lostSec = (leftAt - recordingSince) / 1000 - decoded
    console.log(`Meet navegou (${caso.nome}): ${decoded} s no arquivo, ${((leftAt - recordingSince) / 1000).toFixed(1)} s de call gravando`)
    expect(lostSec, `perdeu ${lostSec} s do fim`).toBeLessThanOrEqual(caso.motivo === 'pagehide' ? 6.5 : 1.5)
    expect(h.pageErrors).toEqual([])
  })
}
