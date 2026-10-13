// Fatia 1 ponta a ponta: Meet falso, participante remoto com tom de 440 Hz, microfone falso de
// 1000 Hz mandado como envio, helper de verdade gravando numa raiz temporária.
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { decodePcm, measureWindows, median, RATE } from '../helpers/audio'
import { launchWithExtension, swApi, type Harness } from '../helpers/browser'
import { findRecordings, stagingEntries } from '../helpers/recordings'
import { watchWebAudio } from '../helpers/webaudio'

const CALL_URL = 'https://meet.google.com/abc-defg-hij?variante=normal&sala=fatia1'
const PEER_URL = 'https://meet.google.com/__peer?tom=440&sala=fatia1'
const RECORD_MS = 20_000

async function startPeer(h: Harness, url: string): Promise<Page> {
  const peer = await h.context.newPage()
  await peer.goto(url)
  await peer.click('#iniciar')
  await expect.poll(() => peer.evaluate(() => (window as any).fixture.state)).toBe('pronto')
  return peer
}

test.describe('fatia 1', () => {
  let h: Harness
  const pageErrors: string[] = []

  test.beforeEach(() => {
    pageErrors.length = 0
  })

  test.afterEach(async ({}, testInfo) => {
    if (h && testInfo.status !== testInfo.expectedStatus) {
      await testInfo.attach('console', { body: h.logs.join('\n'), contentType: 'text/plain' })
      console.log(h.logs.join('\n'))
    }
    await h?.close()
  })

  test('grava só o áudio remoto de uma call do Meet e salva na pasta', async () => {
    h = await launchWithExtension()
    const api = swApi(h.sw)

    // O helper responde pelo manifesto em <user-data-dir>/NativeMessagingHosts.
    const helper = await api.pingHost(true)
    expect(helper, `helper: ${JSON.stringify(helper)}`).toMatchObject({ ok: true, version: '0.5.0', root: h.root, writable: true })

    const peer = await startPeer(h, PEER_URL)
    const call = await h.context.newPage()
    call.on('pageerror', (e) => pageErrors.push(e.message))
    // Regra 4: o grafo de WebAudio da página (inclusive o do MAIN world) visto pelo CDP.
    const graph = await watchWebAudio(h.context, call)
    await call.goto(CALL_URL)
    await expect.poll(() => call.evaluate(() => (window as any).fixture.micLive)).toBe(true)

    // Antes de entrar: nada grava.
    expect(await api.activeRecordings()).toEqual([])

    // Clique de verdade (gesto do usuário), como no Meet.
    await call.click('#participar')
    await expect.poll(() => call.evaluate(() => (window as any).fixture.pcState), { timeout: 15_000, intervals: [100] }).toBe('connected')

    // AC1: começa em até 5 s depois de os sinais de "em call" aparecerem (o último a aparecer é o
    // PC conectado com áudio remoto vivo).
    const inCallAt = Date.now()
    await expect.poll(async () => (await api.activeRecordings()).length, { timeout: 5_000, intervals: [100] }).toBe(1)
    const startDelay = Date.now() - inCallAt
    expect(startDelay, `início em ${startDelay} ms`).toBeLessThanOrEqual(5_000)
    const [active] = await api.activeRecordings()

    // Um script da página manda um bridge:open próprio depois que a ponte foi confirmada. O relay
    // tem de ignorar (senão trocaria de porta e o resto da sessão sumiria em silêncio: lacuna,
    // áudio curto ou fim não salvo, todos conferidos abaixo).
    await call.evaluate(() => {
      const ch = new MessageChannel()
      ;(window as any).__portaFalsa = { recebidas: 0 }
      ch.port1.onmessage = () => (window as any).__portaFalsa.recebidas++
      window.postMessage({ __gravador__: 1, dir: 'up', t: 'bridge:open' }, location.origin, [ch.port2])
    })

    await call.waitForTimeout(RECORD_MS)
    expect(await call.evaluate(() => (window as any).__portaFalsa.recebidas), 'o relay respondeu na porta falsa').toBe(0)

    // O microfone falso chegou mesmo ao participante remoto (o envio existe e tem som).
    const micRms = await peer.evaluate(() => (window as any).fixture.micRms)
    expect(micRms, 'o microfone falso precisa estar sendo enviado').toBeGreaterThan(0.05)

    // AC14: a ponte da extensão não usa window.postMessage para o tráfego. Os listeners de
    // 'message' da página só podem ter visto o aperto de mão (nada de chunk, diag ou sessão).
    const seen = (await call.evaluate(() => (window as any).fixture.gravadorMessages)) as Array<{ t: string | null; temMsg: boolean; msgT: string | null }>
    expect(seen.filter((m) => m.temMsg), `mensagens da ponte vistas pela página: ${JSON.stringify(seen)}`).toEqual([])
    for (const m of seen) expect(['bridge:open', 'bridge:ready']).toContain(m.t)
    // Até 4 do aperto de mão (ready + 1 ou 2 opens, conforme a ordem dos mundos) + o open falso.
    expect(seen.length).toBeLessThanOrEqual(5)

    // Contratos para as próximas fatias (Emenda 4): o fim da sessão de página é avisado (o modo
    // aba para junto) e a espera do vigia só termina com a gravação salva (info.json escrito).
    // A finalização ganha 1,5 s de atraso (helper lento): entre "todos os chunks no IndexedDB" e
    // "salva" fica uma janela que uma espera mais curta não atravessaria.
    await api.delayFinalize(1500)
    await h.sw.evaluate(() => {
      const g = globalThis as any
      g.__fimDaPagina = []
      g.__gravador.onPageSessionEnded((e: unknown) => g.__fimDaPagina.push(e))
    })
    const savedCheck = h.sw.evaluate(async (tabId: number) => {
      const g = (globalThis as any).__gravador
      const ok = await g.waitTabSessionSaved(tabId, 20_000)
      const sessions = (await g.listSessions()) as Array<{ status: string }>
      return { ok, statuses: sessions.map((x) => x.status) }
    }, active.tabId)

    await call.click('button[jsname="CQylAd"]')
    await expect(call.locator('h1[jsname="r4nke"]')).toBeVisible()
    const leftAt = Date.now()

    // AC6: salva em até 10 s depois de sair. waitTabSessionSaved resolve quando a sessão está
    // "salva", e nesse instante o info.json já tem de estar no disco.
    const saved = await savedCheck
    const saveDelay = Date.now() - leftAt
    expect(saved).toEqual({ ok: true, statuses: ['salva'] })
    expect(findRecordings(h.root).filter((r) => r.info).length, 'info.json no disco quando a sessão ficou salva').toBe(1)
    expect(saveDelay, `salvo em ${saveDelay} ms`).toBeLessThanOrEqual(10_000)
    console.log(`AC1 início em ${startDelay} ms; AC6 salvo em ${saveDelay} ms (com 1,5 s de atraso de teste na finalização)`)
    expect(await h.sw.evaluate(() => (globalThis as any).__fimDaPagina)).toEqual([
      { tabId: active.tabId, sessionId: active.sessionId, reason: 'saiu-da-call' },
    ])
    const [rec] = findRecordings(h.root)

    // AC7: forma do nome e conteúdo da pasta.
    expect(rec.month).toMatch(/^\d{4}-\d{2}$/)
    expect(rec.folder).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}h\d{2} - Daily do time \(Meet\)$/)
    expect(rec.folder.startsWith(rec.month)).toBe(true)
    expect(rec.files).toEqual(['audio.webm', 'info.json'])
    expect(stagingEntries(h.root)).toEqual([])

    // AC8: info.json.
    const info = rec.info!
    expect(info).toMatchObject({
      versao: 1,
      sessao: active.sessionId,
      perfil: null,
      plataforma: 'meet',
      titulo: 'Daily do time',
      tituloFonte: 'dom',
      codigo: 'abc-defg-hij',
      status: 'concluida',
      motivoFim: 'saiu-da-call',
      // A versão sobe a cada correção (publicar recusa código novo com a mesma versão).
      extensao: JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')).version,
      helper: '0.5.0',
    })
    expect(info.url).toBe(CALL_URL)
    expect(info.inicio).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/)
    expect(info.fim).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/)
    expect(info.fuso).toBeTruthy()
    const span = (Date.parse(info.fim) - Date.parse(info.inicio)) / 1000
    expect(Math.abs(span - info.duracaoSegundos)).toBeLessThanOrEqual(1)
    expect(info.duracaoSegundos).toBeGreaterThanOrEqual(RECORD_MS / 1000)
    expect(info.duracaoSegundos).toBeLessThan(RECORD_MS / 1000 + 15)
    expect(info.captura.fonteInicial).toBe('receivers')
    expect(info.captura.fonteFinal).toBe('receivers')
    expect(info.captura.contextoAudio).toBe('running')
    expect(info.captura.teveAudio).toBe(true)
    expect(info.lacunas).toEqual([])
    const audioPath = join(rec.dir, 'audio.webm')
    expect(info.arquivos).toEqual([
      { nome: 'audio.webm', tipo: 'pagina', bytes: statSync(audioPath).size, formato: 'audio/webm;codecs=opus', kbps: 32 },
    ])

    // O áudio decodifica e dura o que foi gravado.
    const pcm = decodePcm(audioPath)
    const decodedSec = pcm.length / RATE
    expect(Math.abs(decodedSec - info.duracaoSegundos), `decodificado ${decodedSec.toFixed(2)} s`).toBeLessThanOrEqual(2)

    // AC3: 440 Hz forte, 1000 Hz (microfone) pelo menos 30 dB abaixo, janela a janela.
    // Pula os 3 primeiros segundos (atraso de 1,5 s do mixer + arranque) e o último.
    const windows = measureWindows(pcm, [440, 1000]).slice(3, -1)
    expect(windows.length).toBeGreaterThanOrEqual(15)
    const db440 = windows.map((w) => w.db[440])
    const db1000 = windows.map((w) => w.db[1000])
    test.info().annotations.push({
      type: 'audio',
      description: `440 Hz mediana ${median(db440).toFixed(1)} dBFS; 1000 Hz máx ${Math.max(...db1000).toFixed(1)} dBFS; decodificado ${decodedSec.toFixed(2)} s; duração ${info.duracaoSegundos} s`,
    })
    console.log(test.info().annotations.at(-1)?.description)
    expect(median(db440)).toBeGreaterThan(-20)
    for (const w of windows) expect(w.db[1000], `segundo ${w.second}`).toBeLessThanOrEqual(w.db[440] - 30)

    // Nada ficou no IndexedDB depois de salvar.
    await expect.poll(() => api.countChunks()).toBe(0)
    const sessions = await api.listSessions()
    expect(sessions.find((s) => s.sessionId === active.sessionId)?.status).toBe('salva')
    expect(await api.activeRecordings()).toEqual([])

    // AC14: os ganchos não jogaram erro na página, nem erro de console, nem violação de Trusted
    // Types (a página roda com require-trusted-types-for 'script'; uma violação dentro do nosso
    // try/catch não vira pageerror, mas vira erro de console e securitypolicyviolation).
    expect(pageErrors).toEqual([])
    expect(await call.evaluate(() => (window as any).fixture.errors)).toEqual([])
    expect(h.pageErrors).toEqual([])

    // Regra 4: o mixer existiu e nada dele (nem de nenhum contexto desta página, que não cria
    // nenhum) chegou ao AudioDestination.
    expect(graph.mixerContexts().length, `nós: ${JSON.stringify(graph.nodes().map((n) => [n.nodeType, n.channelCount, n.channelCountMode]))}`).toBeGreaterThanOrEqual(1)
    for (const id of graph.contexts()) expect(graph.edgesIntoSpeaker(id), `contexto ${id}`).toEqual([])
  })

  test('sala de espera com PC conectado e áudio remoto não grava', async () => {
    h = await launchWithExtension()
    const api = swApi(h.sw)
    await startPeer(h, 'https://meet.google.com/__peer?tom=440&sala=espera')
    const call = await h.context.newPage()
    await call.goto('https://meet.google.com/xyz-abcd-efg?variante=sala-de-espera&sala=espera')
    await expect(call.locator('#participar')).toBeVisible()
    // O PC existe, está conectado e recebendo o tom: só os marcadores de "em call" faltam.
    await expect.poll(() => call.evaluate(() => (window as any).fixture.pcState), { timeout: 15_000 }).toBe('connected')
    await expect.poll(() => call.evaluate(() => (window as any).fixture.remoteTrack)).toBe(true)

    await call.waitForTimeout(10_000)

    expect(await api.activeRecordings()).toEqual([])
    expect(await api.listSessions()).toEqual([])
    expect(findRecordings(h.root)).toEqual([])
    expect(stagingEntries(h.root)).toEqual([])
    expect(existsSync(join(h.root, '.gravando'))).toBe(false)
  })

  /** Grava `ms` de uma variante do Meet falso e devolve o info.json e o áudio medido. */
  async function recordVariant(variant: string, room: string, ms: number) {
    h = await launchWithExtension()
    const api = swApi(h.sw)
    await startPeer(h, `https://meet.google.com/__peer?tom=440&sala=${room}`)
    const call = await h.context.newPage()
    call.on('pageerror', (e) => pageErrors.push(e.message))
    await call.goto(`https://meet.google.com/abc-defg-hij?variante=${variant}&sala=${room}`)
    await expect.poll(() => call.evaluate(() => (window as any).fixture.micLive)).toBe(true)
    await call.click('#participar')
    await expect.poll(() => call.evaluate(() => (window as any).fixture.remoteTrack), { timeout: 15_000 }).toBe(true)
    await expect.poll(async () => (await api.activeRecordings()).length, { timeout: 10_000, intervals: [250] }).toBe(1)
    await call.waitForTimeout(ms)
    await call.click('button[jsname="CQylAd"]')
    await expect.poll(() => findRecordings(h.root).filter((r) => r.info).length, { timeout: 10_000, intervals: [250] }).toBe(1)
    const [rec] = findRecordings(h.root)
    const windows = measureWindows(decodePcm(join(rec.dir, 'audio.webm')), [440]).slice(3, -1)
    const db440 = windows.map((w) => w.db[440])
    console.log(`${variant}: 440 Hz mediana ${median(db440).toFixed(1)} dBFS em ${windows.length} janelas`)
    const errors = (await call.evaluate(() => (window as any).fixture.errors)) as string[]
    return { info: rec.info!, windows, db440, errors: [...errors, ...h.pageErrors.map((e) => `${e.kind}: ${e.text}`)] }
  }

  test('PC que só passa pelo construtor (sem ontrack nem addTrack) é gravado: Proxy da regra 7', async () => {
    // A variante so-construtor não usa nenhum dos outros caminhos de registro, então só o Proxy
    // do construtor faz este PC entrar no registro e a call ser vista.
    const r = await recordVariant('so-construtor', 'construtor', 10_000)
    expect(r.errors).toEqual([])
    expect(r.info.captura.fonteInicial).toBe('receivers')
    expect(r.windows.length).toBeGreaterThanOrEqual(5)
    expect(median(r.db440)).toBeGreaterThan(-20)
    expect(pageErrors).toEqual([])
  })

  test('sem nenhum elemento tocando o áudio remoto, o priming do crbug 40094084 faz a gravação ter som', async () => {
    const r = await recordVariant('sem-audio', 'sem-audio', 10_000)
    expect(r.errors).toEqual([])
    expect(r.info.captura.teveAudio).toBe(true)
    expect(r.windows.length).toBeGreaterThanOrEqual(5)
    for (const [i, db] of r.db440.entries()) expect(db, `janela ${i}`).toBeGreaterThan(-20)
    expect(pageErrors).toEqual([])
  })

  test('sem o manifesto em <user-data-dir>/NativeMessagingHosts o helper não responde', async () => {
    // Controle negativo do primeiro teste: prova que o ping de lá vinha do manifesto do perfil
    // temporário, e não de uma instalação no Chrome real.
    h = await launchWithExtension({ installHost: false })
    const helper = await swApi(h.sw).pingHost(true)
    expect(helper.ok).toBe(false)
    expect(helper.error).toMatch(/native messaging host not found/i)
  })
})
