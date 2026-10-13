// Adaptador do Teams ponta a ponta (AC2, AC6, AC8, esperas): páginas falsas do Teams nos três
// hosts (tests/fixtures/teams/), participante remoto com o tom principal (440 Hz) num stream
// `mainAudio` e um tom redundante (660 Hz) num stream `dominantSpeaker-1`, microfone falso de
// 1000 Hz mandado como envio, helper de verdade gravando numa raiz temporária. Com o <audio> do
// body a gravação vem do seam `elements`; a variante `sem-elemento` tira o <audio> e força os
// receptores, onde o filtro do `mainAudio` é o que separa o 660 Hz.
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { decodePcm, measureWindows, median } from '../helpers/audio'
import { launchWithExtension, swApi, type Harness } from '../helpers/browser'
import { findRecordings, stagingEntries } from '../helpers/recordings'
import { installTeamsRoutes } from '../fixtures/teams/routes'

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/

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

async function startPeer(harness: Harness, url: string): Promise<Page> {
  const peer = await harness.context.newPage()
  await peer.goto(url)
  await peer.click('#iniciar')
  await expect.poll(() => peer.evaluate(() => (window as any).fixture.state)).toBe('pronto')
  return peer
}

/**
 * Abre a reunião, passa pelo pré-join e pelo lobby (com o PC conectado e o áudio tocando) e
 * confere que nada gravou em nenhum dos dois. Devolve a página no lobby.
 */
async function joinToLobby(harness: Harness, host: string, path: string, variant: string, room: string, peerQuery = '') {
  const api = swApi(harness.sw)
  await startPeer(harness, `https://${host}/__peer?variante=teams&tom=440&dominante=660&sala=${room}${peerQuery}`)
  const call = await harness.context.newPage()
  const sep = path.includes('?') ? '&' : '?'
  await call.goto(`https://${host}${path}${sep}variante=${variant}&sala=${room}`)
  await expect.poll(() => fx(call, 'micLive')).toBe(true)
  await expect(call.locator('[data-tid="prejoin-join-button"]')).toBeVisible()
  // Pré-join: nada grava.
  await call.waitForTimeout(3000)
  expect(await api.activeRecordings(), 'gravou no pré-join').toEqual([])

  await call.click('#participar')
  await expect.poll(() => fx(call, 'pcState'), { timeout: 15_000, intervals: [100] }).toBe('connected')
  await expect.poll(() => fx(call, 'mainAudio')).toBe(true)
  await expect.poll(() => fx(call, 'dominantSpeaker')).toBe(true)
  // Lobby: o PC está conectado com áudio remoto vivo e a barra com #hangup-button está na tela.
  await expect(call.locator('#hangup-button')).toBeVisible()
  await call.waitForTimeout(8000)
  expect(await api.activeRecordings(), 'gravou no lobby').toEqual([])
  expect(await api.listSessions(), 'sessão aberta no lobby').toEqual([])
  return call
}

/** Admite a página e mede quanto a gravação levou para começar (AC2: até 5 s). */
async function admitAndMeasure(harness: Harness, call: Page): Promise<{ tabId: number; sessionId: string; startMs: number }> {
  const api = swApi(harness.sw)
  await call.evaluate(() => (window as any).ui.admitir())
  const t0 = Date.now()
  await expect.poll(async () => (await api.activeRecordings()).length, { timeout: 5_000, intervals: [100] }).toBe(1)
  const startMs = Date.now() - t0
  expect(startMs, `início em ${startMs} ms`).toBeLessThanOrEqual(5_000)
  const [active] = await api.activeRecordings()
  return { ...active, startMs }
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

/**
 * Mede o áudio salvo: 440 Hz (principal) forte; 660 Hz (dominantSpeaker) e 1000 Hz (microfone)
 * 30 dB abaixo. Pula os 3 primeiros segundos (atraso de 1,5 s do mixer + arranque) e o último;
 * `seconds` limita às janelas em que o tom ainda tocava (fins que esperam com o PC fechado).
 */
function checkAudio(dir: string, label: string, seconds?: number) {
  const all = measureWindows(decodePcm(join(dir, 'audio.webm')), [440, 660, 1000])
  const windows = seconds === undefined ? all.slice(3, -1) : all.slice(3, 3 + seconds)
  const db440 = windows.map((w) => w.db[440])
  const max660 = Math.max(...windows.map((w) => w.db[660] - w.db[440]))
  const max1000 = Math.max(...windows.map((w) => w.db[1000] - w.db[440]))
  const line = `${label}: 440 Hz mediana ${median(db440).toFixed(1)} dBFS; 660 Hz no máximo ${max660.toFixed(1)} dB do 440; 1000 Hz no máximo ${max1000.toFixed(1)} dB do 440; ${windows.length} janelas`
  test.info().annotations.push({ type: 'audio', description: line })
  console.log(line)
  expect(windows.length).toBeGreaterThanOrEqual(5)
  expect(median(db440)).toBeGreaterThan(-20)
  for (const w of windows) {
    expect(w.db[660], `dominantSpeaker no segundo ${w.second}`).toBeLessThanOrEqual(w.db[440] - 30)
    expect(w.db[1000], `microfone no segundo ${w.second}`).toBeLessThanOrEqual(w.db[440] - 30)
  }
}

async function noErrors(call: Page) {
  expect(await fx(call, 'errors')).toEqual([])
  expect(h!.pageErrors).toEqual([])
}

test('v2 em teams.microsoft.com: não grava no pré-join nem no lobby, grava conectado, marca a espera e salva ao desligar', async () => {
  h = await launchWithExtension({ routes: installTeamsRoutes })
  const call = await joinToLobby(h, 'teams.microsoft.com', '/meet/1234567890123?p=abcd', 'normal', 't-v2')
  const active = await admitAndMeasure(h, call)

  await call.waitForTimeout(6000)
  // Bruno sai, Carla entra: os nomes se acumulam.
  await call.evaluate(() =>
    (window as any).ui.trocarParticipantes([
      { displayName: 'Ana Souza', state: 3 },
      { displayName: 'Carla Dias', state: 3 },
      { displayName: 'Visitante no lobby', state: 7 },
    ]),
  )
  await call.waitForTimeout(6000)
  // Espera (o próprio Teams põe a call em espera quando a mesma conta entra em outra).
  await call.evaluate(() => (window as any).ui.espera())
  await call.waitForTimeout(4000)
  await call.evaluate(() => (window as any).ui.retomar())
  await call.waitForTimeout(5000)
  expect((await swApi(h.sw).activeRecordings()).map((r) => r.sessionId), 'a espera não encerra a gravação').toEqual([active.sessionId])

  // AC6: estado 6 e depois 7 ao desligar; salvo em até 10 s.
  const saved = savedPromise(h, active.tabId)
  await call.click('#hangup-button')
  const leftAt = Date.now()
  const r = await saved
  const saveMs = r.at - leftAt
  expect(r.ok).toBe(true)
  expect(saveMs, `salvo em ${saveMs} ms`).toBeLessThanOrEqual(10_000)

  const recs = findRecordings(h.root)
  expect(recs).toHaveLength(1)
  const [rec] = recs
  expect(rec.folder).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}h\d{2} - Planejamento trimestral \(Teams\)$/)
  expect(rec.files).toEqual(['audio.webm', 'info.json'])
  expect(stagingEntries(h.root)).toEqual([])
  const info = rec.info!
  expect(info).toMatchObject({
    plataforma: 'teams',
    // O cabeçalho só existe no pré-join e a aba na call é a casca: lido lá e guardado.
    titulo: 'Planejamento trimestral',
    tituloFonte: 'dom',
    codigo: '1234567890123',
    idReuniao: '19:meeting_UGxhbmVqYW1lbnRvLWZhbHNv@thread.v2',
    tituloDaAba: 'Microsoft Teams meeting | Microsoft Teams',
    voce: 'Alex Lima',
    status: 'concluida',
    motivoFim: 'saiu-da-call',
    lacunas: [],
  })
  expect(info.url).toContain('https://teams.microsoft.com/meet/1234567890123?p=abcd')
  // Sem quem está no lobby, sem nome vazio, sem o próprio usuário; acumulados.
  expect([...info.participantes].sort()).toEqual(['Ana Souza', 'Bruno Lima', 'Carla Dias'])
  expect(info.inicio).toMatch(ISO_RE)
  expect(info.fim).toMatch(ISO_RE)
  // Prioridade do Teams: elements primeiro (ARQUITETURA, "Arbitragem"). O <audio> do body toca só
  // o mainAudio, então é a fonte de partida desde que o seam elements existe (fatia dos seams).
  // Por isso o 660 Hz baixo aqui não prova o filtro dos receptores: quem prova é o teste "sem
  // <audio> na página", abaixo.
  expect(info.captura.fonteInicial).toBe('elements')
  expect(info.captura.teveAudio).toBe(true)
  // Um período de espera de ~4 s (o laço é de 1 s e o ISO é por segundo).
  expect(info.esperas).toHaveLength(1)
  const holdSec = (Date.parse(info.esperas[0].ate!) - Date.parse(info.esperas[0].de)) / 1000
  expect(holdSec, `espera de ${holdSec} s`).toBeGreaterThanOrEqual(2)
  expect(holdSec).toBeLessThanOrEqual(6)
  expect(Date.parse(info.esperas[0].de)).toBeGreaterThanOrEqual(Date.parse(info.inicio))
  console.log(`Teams v2: início em ${active.startMs} ms; salvo em ${saveMs} ms; espera de ${holdSec} s`)

  checkAudio(rec.dir, 'Teams v2')
  await noErrors(call)
})

test('pelo proxy do Defender for Cloud Apps (teams.cloud.microsoft.mcas.ms): grava sozinho e salva como no host simples (Emenda 17)', async () => {
  // Achado de uso real (08/10/2026): a empresa abre o Teams pelo proxy do Conditional Access App
  // Control, que acrescenta ".mcas.ms" ao host. Sem o host no manifesto, nada entrava na página.
  h = await launchWithExtension({ routes: installTeamsRoutes })
  const host = 'teams.cloud.microsoft.mcas.ms'
  const call = await joinToLobby(h, host, '/meet/1234567890123?p=abcd', 'normal', 't-proxy')
  const active = await admitAndMeasure(h, call)
  // Badge e popup tratam a aba como do Teams.
  await expect.poll(() => h!.sw.evaluate((id) => chrome.action.getBadgeText({ tabId: id }), active.tabId)).toBe('REC')
  await call.waitForTimeout(8000)

  const saved = savedPromise(h, active.tabId)
  await call.click('#hangup-button')
  const leftAt = Date.now()
  const r = await saved
  const saveMs = r.at - leftAt
  expect(r.ok).toBe(true)
  expect(saveMs, `salvo em ${saveMs} ms`).toBeLessThanOrEqual(10_000)

  const recs = findRecordings(h.root)
  expect(recs).toHaveLength(1)
  const [rec] = recs
  expect(rec.folder).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}h\d{2} - Planejamento trimestral \(Teams\)$/)
  expect(rec.files).toEqual(['audio.webm', 'info.json'])
  // O mesmo que no host simples: título do pré-join, código e ID da URL, nomes do objeto da call.
  expect(rec.info).toMatchObject({
    plataforma: 'teams',
    titulo: 'Planejamento trimestral',
    tituloFonte: 'dom',
    codigo: '1234567890123',
    idReuniao: '19:meeting_UGxhbmVqYW1lbnRvLWZhbHNv@thread.v2',
    voce: 'Alex Lima',
    status: 'concluida',
    motivoFim: 'saiu-da-call',
  })
  expect(rec.info!.url).toContain(`https://${host}/meet/1234567890123?p=abcd`)
  expect([...rec.info!.participantes].sort()).toEqual(['Ana Souza', 'Bruno Lima'])
  console.log(`Teams pelo proxy: início em ${active.startMs} ms; salvo em ${saveMs} ms`)
  checkAudio(rec.dir, 'Teams pelo proxy')
  await noErrors(call)
})

test('a página cancela todos os timers ao carregar e no meio da gravação (como o Teams logado): grava e salva sozinho (Emenda 12)', async () => {
  h = await launchWithExtension({ routes: installTeamsRoutes })
  const call = await joinToLobby(h, 'teams.cloud.microsoft', '/', 'limpa-timers', 't-timers')
  const active = await admitAndMeasure(h, call)
  // No meio da gravação a página cancela tudo de novo (o laço de 1 s e o da arbitragem morrem).
  await call.waitForTimeout(3000)
  await call.evaluate(() => (window as any).cancelarTudoDeNovo())
  await call.waitForTimeout(12_000)
  expect((await swApi(h.sw).activeRecordings()).map((r) => r.sessionId), 'continua gravando').toEqual([active.sessionId])

  const saved = savedPromise(h, active.tabId)
  await call.click('#hangup-button')
  const leftAt = Date.now()
  const r = await saved
  const saveMs = r.at - leftAt
  expect(r.ok).toBe(true)
  expect(saveMs, `salvo em ${saveMs} ms`).toBeLessThanOrEqual(10_000)
  const recs = findRecordings(h.root)
  expect(recs).toHaveLength(1)
  expect(recs[0].info).toMatchObject({ plataforma: 'teams', status: 'concluida', motivoFim: 'saiu-da-call' })
  console.log(`Teams com timers cancelados: início em ${active.startMs} ms; salvo em ${saveMs} ms`)
  checkAudio(recs[0].dir, 'Teams com timers cancelados')
  await noErrors(call)
})

test('reunião leve em teams.live.com: objeto em callingDebug, título da aba, fim pela tela de fim da reunião anônima', async () => {
  h = await launchWithExtension({ routes: installTeamsRoutes })
  const call = await joinToLobby(h, 'teams.live.com', '/light-meetings/launch?agent=web&coords=e30', 'leve', 't-leve')
  const active = await admitAndMeasure(h, call)
  await call.waitForTimeout(8000)

  const saved = savedPromise(h, active.tabId)
  await call.click('#hangup-button')
  const leftAt = Date.now()
  await expect(call.locator('[data-testid="calling-anon-meeting-end-screen"]')).toBeVisible()
  const r = await saved
  const saveMs = r.at - leftAt
  expect(r.ok).toBe(true)
  expect(saveMs, `salvo em ${saveMs} ms`).toBeLessThanOrEqual(10_000)

  const [rec] = findRecordings(h.root)
  expect(rec.folder).toMatch(/ - Suporte do cliente \(Teams\)$/)
  expect(rec.info).toMatchObject({
    plataforma: 'teams',
    titulo: 'Suporte do cliente',
    tituloFonte: 'titulo-da-aba',
    codigo: '',
    idReuniao: '19:meeting_U3Vwb3J0ZS1sZXZl@thread.v2',
    voce: 'Alex Lima',
    esperas: [],
    motivoFim: 'saiu-da-call',
  })
  expect([...rec.info!.participantes].sort()).toEqual(['Ana Souza', 'Bruno Lima'])
  console.log(`Teams leve: início em ${active.startMs} ms; salvo em ${saveMs} ms`)
  checkAudio(rec.dir, 'Teams leve')
  await noErrors(call)
})

test('sem objeto da call em teams.cloud.microsoft: decide pelo DOM e pelo PC, e o botão de desligar sumindo com a faixa encerrada fecha', async () => {
  h = await launchWithExtension({ routes: installTeamsRoutes })
  const thread = '19:meeting_UmV2aXNhby1kb20@thread.v2'
  const path = `/l/meetup-join/${encodeURIComponent(thread)}/0?context=${encodeURIComponent('{"Tid":"t","Oid":"o"}')}`
  // O lobby tem a barra com #hangup-button e o PC com áudio: só o marcador do lobby segura.
  const call = await joinToLobby(h, 'teams.cloud.microsoft', path, 'dom', 't-dom')
  const active = await admitAndMeasure(h, call)
  await call.waitForTimeout(12_000)

  const saved = savedPromise(h, active.tabId)
  await call.click('#hangup-button')
  const leftAt = Date.now()
  const r = await saved
  const saveMs = r.at - leftAt
  expect(r.ok).toBe(true)
  // 5 s sem o botão + 1,5 s do atraso do mixer + a finalização.
  expect(saveMs, `salvo em ${saveMs} ms`).toBeLessThanOrEqual(10_000)

  const [rec] = findRecordings(h.root)
  expect(rec.info).toMatchObject({
    plataforma: 'teams',
    titulo: 'Revisão de contrato',
    tituloFonte: 'dom',
    codigo: '',
    idReuniao: thread,
    voce: '',
    motivoFim: 'call-encerrada',
  })
  // Pelo painel de pessoas, sem a linha do lobby.
  expect([...rec.info!.participantes].sort()).toEqual(['Ana Souza', 'Bruno Lima'])
  console.log(`Teams DOM: início em ${active.startMs} ms; salvo em ${saveMs} ms depois de desligar`)
  // Depois de desligar, 5 s de silêncio com o PC fechado até o fim: mede só os 8 s com o tom.
  checkAudio(rec.dir, 'Teams DOM', 8)
  await noErrors(call)
})

test('sem objeto da call, "em call" falso por 15 s com o PC vivo encerra como fora-da-call', async () => {
  h = await launchWithExtension({ routes: installTeamsRoutes })
  const call = await joinToLobby(h, 'teams.cloud.microsoft', '/meet/9876543210?p=x', 'dom', 't-fora')
  const active = await admitAndMeasure(h, call)
  await call.waitForTimeout(6000)

  const saved = savedPromise(h, active.tabId, 40_000)
  // Os controles somem, o PC e o áudio continuam: nem o botão sumido (faixa viva) nem o estado
  // encerram; só o "fora da call" por 15 s.
  await call.evaluate(() => (window as any).ui.sumirControles())
  const goneAt = Date.now()
  await call.waitForTimeout(12_000)
  expect((await swApi(h.sw).activeRecordings()).length, 'encerrou antes dos 15 s').toBe(1)
  const r = await saved
  const totalMs = r.at - goneAt
  expect(r.ok).toBe(true)
  expect(totalMs, `salvo ${totalMs} ms depois de os controles sumirem`).toBeGreaterThanOrEqual(15_000)
  // AC6: até 10 s depois de o sinal (15 s fora da call) se completar.
  expect(totalMs - 15_000, `salvo ${totalMs - 15_000} ms depois dos 15 s`).toBeLessThanOrEqual(10_000)
  const [rec] = findRecordings(h.root)
  expect(rec.info).toMatchObject({ plataforma: 'teams', codigo: '9876543210', motivoFim: 'fora-da-call' })
  console.log(`Teams fora da call: salvo ${totalMs} ms depois de os controles sumirem`)
  await noErrors(call)
})

test('sem <audio> na página: a gravação vem dos receptores e o filtro do mainAudio deixa o dominantSpeaker de fora', async () => {
  h = await launchWithExtension({ routes: installTeamsRoutes })
  const call = await joinToLobby(h, 'teams.microsoft.com', '/meet/5556667778889?p=r', 'sem-elemento', 't-receptores')
  expect(await call.evaluate(() => document.querySelectorAll('audio, video').length), 'a página não toca a call em elemento').toBe(0)
  const active = await admitAndMeasure(h, call)
  await call.waitForTimeout(12_000)
  const saved = savedPromise(h, active.tabId)
  await call.click('#hangup-button')
  const r = await saved
  expect(r.ok).toBe(true)
  const [rec] = findRecordings(h.root)
  expect(rec.info).toMatchObject({ plataforma: 'teams', codigo: '5556667778889', motivoFim: 'saiu-da-call' })
  // Sem fonte no elements, o próximo da prioridade do Teams; e nada de troca no meio.
  expect(rec.info!.captura.fonteInicial).toBe('receivers')
  expect(rec.info!.captura.fonteFinal).toBe('receivers')
  expect(rec.info!.captura.teveAudio).toBe(true)
  // Aqui o 660 Hz chega ao seam escolhido: só o filtro o mantém 30 dB abaixo.
  checkAudio(rec.dir, 'Teams receptores')
  await noErrors(call)
})

// Precisa do seam `elements` (fatia dos seams, já na main).
test('caminho WASM: mainAudio mudo, o som de verdade pelo <audio> do body, e a gravação segue o elemento', async () => {
  h = await launchWithExtension({ routes: installTeamsRoutes })
  const call = await joinToLobby(h, 'teams.microsoft.com', '/meet/1112223334445?p=w', 'teams-wasm', 't-wasm', '&mudo=1&dominante=0')
  const active = await admitAndMeasure(h, call)
  await expect.poll(() => fx(call, 'wasm')).toBe(true)
  await call.waitForTimeout(12_000)
  const saved = savedPromise(h, active.tabId)
  await call.click('#hangup-button')
  const r = await saved
  expect(r.ok).toBe(true)
  const [rec] = findRecordings(h.root)
  expect(rec.info).toMatchObject({ plataforma: 'teams', motivoFim: 'saiu-da-call' })
  expect(rec.info!.captura.fonteFinal).toBe('elements')
  expect(rec.info!.captura.teveAudio).toBe(true)
  const windows = measureWindows(decodePcm(join(rec.dir, 'audio.webm')), [440, 1000]).slice(3, -1)
  const db440 = windows.map((w) => w.db[440])
  console.log(`Teams WASM: 440 Hz mediana ${median(db440).toFixed(1)} dBFS em ${windows.length} janelas`)
  expect(median(db440)).toBeGreaterThan(-20)
  for (const w of windows) expect(w.db[1000], `microfone no segundo ${w.second}`).toBeLessThanOrEqual(w.db[440] - 30)
  await noErrors(call)
})
