// Vigia no Meet (AC18, Emendas 3 e 6): contagem pelo selo [data-avatar-count], nunca abre o
// painel de pessoas, diálogo do organizador respondido só com "sair", e o caso com gravação de
// verdade: a aba só fecha depois do info.json e o áudio vai até a saída.
// Página: o Meet falso de tests/fixtures/meet/page.ts com a variante tests/fixtures/vigia/meet.js.
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { decodePcm, measureWindows, median, RATE } from '../helpers/audio'
import { launchWithExtension, swApi, type Harness } from '../helpers/browser'
import { findRecordings } from '../helpers/recordings'
import {
  INTERVALO_MS,
  LIGADO,
  VIGIA_RAPIDO,
  fx,
  indicador,
  novaAba,
  quandoFechar,
  setSettings,
  tabIdOf,
  ultimoTexto,
  vigiaEventos,
  vigiaTabState,
} from '../fixtures/vigia/e2e'
import { installVigiaRoutes } from '../fixtures/vigia/routes'

let h: Harness | undefined

test.afterEach(async ({}, testInfo) => {
  if (h && testInfo.status !== testInfo.expectedStatus) {
    await testInfo.attach('console', { body: h.logs.join('\n'), contentType: 'text/plain' })
    console.log(h.logs.join('\n'))
  }
  await h?.close()
  h = undefined
})

interface MeetFx {
  n: number
  leaveClicks: number
  dialogClicks: string[]
  encerrouParaTodos: boolean
  peopleButtonClicks: number
  leftAt: number | null
  dialogShownAt: number | null
}

async function abrirMeet(query: string): Promise<Page> {
  const page = await novaAba(h!.context)
  await page.goto(`https://meet.google.com/abc-defg-hij?vigia=1&${query}`)
  await page.click('#participar')
  await expect(page.locator('button[jsname="CQylAd"]')).toBeVisible()
  return page
}

const setN = (page: Page, n: number) => page.evaluate((x) => (window as any).vigiaFx.setN(x), n)

test.describe('vigia no Meet', () => {
  test('conta pelo selo de participantes, nunca clica no botão de pessoas, e sozinho sai e fecha', async () => {
    h = await launchWithExtension({ installHost: false, routes: installVigiaRoutes, settings: LIGADO })
    const page = await abrirMeet('n=3&sala=selo')
    await expect.poll(() => ultimoTexto(page)).toBe('vigia: 3 na call · pico 3 · sai se você ficar sozinho · via botão de pessoas')
    const tabId = await tabIdOf(h, page)
    await expect.poll(async () => (await vigiaTabState(h!, tabId)).status?.platform).toBe('meet')
    expect((await vigiaTabState(h, tabId)).status).toMatchObject({ naCall: true, n: 3, fonte: 'botão de pessoas', pico: 3, limite: 1, armado: true })

    // 5 pelo selo com só 2 blocos de vídeo na tela: os blocos nunca entram na conta.
    await setN(page, 5)
    await expect.poll(() => ultimoTexto(page)).toBe('vigia: 5 na call · pico 5 · sai com 2 ou menos · via botão de pessoas')
    await setN(page, 2)
    await expect.poll(() => ultimoTexto(page)).toContain('confirmando 1/4')

    const closed = quandoFechar(page)
    const t0 = Date.now()
    await setN(page, 1)
    await expect.poll(async () => (await fx<MeetFx>(page)).leftAt, { timeout: 5_000, intervals: [50] }).not.toBeNull()
    const st = await fx<MeetFx>(page)
    const closedAt = await closed
    console.log(`Meet sozinho: saiu ${st.leftAt! - t0} ms depois; aba fechada ${closedAt - st.leftAt!} ms depois de sair`)
    expect(st.leftAt! - t0).toBeLessThanOrEqual(INTERVALO_MS + 500)
    expect(closedAt - st.leftAt!).toBeLessThanOrEqual(INTERVALO_MS + 1500)
    expect(st).toMatchObject({ leaveClicks: 1, peopleButtonClicks: 0, dialogClicks: [], encerrouParaTodos: false })
    const ev = await vigiaEventos(h)
    expect(ev.map((e) => [e.t, e.motivo])).toEqual([
      ['saindo', 'caiu de 5 para 1'],
      ['fechou', 'saiu-da-call'],
    ])
    expect(h.pageErrors).toEqual([])
  })

  test('sem o selo: não abre o painel sozinho; conta pelo painel que o usuário abriu', async () => {
    h = await launchWithExtension({ installHost: false, routes: installVigiaRoutes, settings: LIGADO })
    const page = await abrirMeet('n=3&selo=nao&sala=painel')
    await expect.poll(() => ultimoTexto(page)).toBe('vigia: NÃO achei a contagem (3x): o selo de pessoas está na tela?')
    expect((await fx<MeetFx>(page)).peopleButtonClicks, 'no Meet o vigia nunca abre o painel').toBe(0)

    // O usuário abre o painel: nomes únicos, sem a linha de apresentação nem a repetida.
    await page.evaluate(() => (window as any).vigiaFx.abrirPainel(['Alex Lima', 'Ana Souza', 'Ana Souza', 'Apresentação', 'Bruno Lima']))
    await expect.poll(() => ultimoTexto(page)).toBe('vigia: 3 na call · pico 3 · sai se você ficar sozinho · via painel de pessoas')

    const closed = quandoFechar(page)
    await page.evaluate(() => (window as any).vigiaFx.abrirPainel(['Alex Lima', 'Apresentação']))
    await closed
    const ev = await vigiaEventos(h)
    expect(ev.map((e) => [e.t, e.motivo])).toEqual([
      ['saindo', 'caiu de 3 para 1'],
      ['fechou', 'saiu-da-call'],
    ])
    expect(h.pageErrors).toEqual([])
  })

  test('painel de pessoas com gente aguardando para entrar: só quem está na call conta', async () => {
    h = await launchWithExtension({ installHost: false, routes: installVigiaRoutes, settings: LIGADO })
    const page = await abrirMeet('n=3&selo=nao&sala=aguardando')
    await page.evaluate(() => (window as any).vigiaFx.abrirPainel(['Alex Lima', 'Ana Souza', 'Bruno Lima'], ['Carla Dias', 'Davi Reis']))
    await expect.poll(() => ultimoTexto(page)).toBe('vigia: 3 na call · pico 3 · sai se você ficar sozinho · via painel de pessoas')
    await page.waitForTimeout(2 * INTERVALO_MS)
    expect((await indicador(page)).some((l) => l.text?.includes('5 na call')), 'contou quem aguarda').toBe(false)
  })

  test('o ícone de legenda some no meio da call (janela estreita): o vigia não acha que a call acabou e não fecha a aba', async () => {
    h = await launchWithExtension({ installHost: false, routes: installVigiaRoutes, settings: LIGADO })
    const page = await abrirMeet('n=3&sala=estreita')
    await expect.poll(() => ultimoTexto(page)).toBe('vigia: 3 na call · pico 3 · sai se você ficar sozinho · via botão de pessoas')
    await page.evaluate(() => (window as any).vigiaFx.sumirLegenda())
    // Mais que faltasParaFim (3) leituras sem o ícone.
    await page.waitForTimeout(6 * INTERVALO_MS)
    expect(page.isClosed(), 'fechou a aba com a call em andamento').toBe(false)
    expect((await indicador(page)).some((l) => l.text?.startsWith('vigia: a call sumiu')), 'contou a call como sumida').toBe(false)
    expect(await vigiaEventos(h)).toEqual([])
    // Continua valendo: sozinho, sai e fecha.
    const closed = quandoFechar(page)
    await setN(page, 1)
    await closed
    const ev = await vigiaEventos(h)
    expect(ev.map((e) => [e.t, e.motivo])).toEqual([
      ['saindo', 'caiu de 3 para 1'],
      ['fechou', 'saiu-da-call'],
    ])
    expect(h.pageErrors).toEqual([])
  })

  test('um [role="dialog"] alheio na tela (o balão de pessoas) não impede a saída de quem não organiza', async () => {
    h = await launchWithExtension({ installHost: false, routes: installVigiaRoutes, settings: LIGADO })
    const page = await abrirMeet('n=3&balao=1&sala=balao')
    await expect(page.locator('[role="dialog"]')).toBeVisible()
    await expect.poll(() => ultimoTexto(page)).toContain('3 na call')
    const closed = quandoFechar(page)
    await setN(page, 1)
    await expect.poll(async () => (await fx<MeetFx>(page)).leftAt, { timeout: 5_000, intervals: [50] }).not.toBeNull()
    // O balão continua na tela depois da saída: mesmo assim o vigia sabe que saiu e fecha.
    await expect(page.locator('[role="dialog"]')).toBeVisible()
    const leftAt = (await fx<MeetFx>(page)).leftAt!
    const closedAt = await closed
    console.log(`Meet com balão alheio: aba fechada ${closedAt - leftAt} ms depois de sair`)
    expect(closedAt - leftAt).toBeLessThanOrEqual(INTERVALO_MS + 1500)
    const ev = await vigiaEventos(h)
    expect(ev.map((e) => [e.t, e.motivo])).toEqual([
      ['saindo', 'caiu de 3 para 1'],
      ['fechou', 'saiu-da-call'],
    ])
    expect(h.pageErrors).toEqual([])
  })

  test('mudar o intervalo com a call aberta vale a partir da leitura seguinte', async () => {
    h = await launchWithExtension({ installHost: false, routes: installVigiaRoutes, settings: LIGADO })
    // Sem o selo, cada leitura muda o texto ("NÃO achei a contagem (Nx)"): dá para medir o intervalo.
    const page = await abrirMeet('n=3&selo=nao&sala=intervalo')
    await expect.poll(() => ultimoTexto(page)).toContain('(4x)')
    const contagens = (await indicador(page)).filter((l) => l.text?.startsWith('vigia: NÃO achei a contagem'))
    const antes = contagens.slice(1).map((l, i) => l.at - contagens[i].at)
    console.log(`intervalo 1 s: ${antes.join(', ')} ms entre leituras`)
    for (const d of antes) expect(d).toBeLessThanOrEqual(INTERVALO_MS + 500)

    const tMuda = Date.now()
    await setSettings(h, { vigia: { ...VIGIA_RAPIDO, intervaloSeg: 2 } })
    // A leitura já agendada (1 s) roda; daí em diante, uma a cada 2 s.
    await page.waitForTimeout(INTERVALO_MS + 3 * 2000 + 500)
    const depois = (await indicador(page)).filter((l) => l.at > tMuda && l.text?.startsWith('vigia: NÃO achei a contagem'))
    const gaps = depois.slice(1).map((l, i) => l.at - depois[i].at)
    console.log(`intervalo 2 s: ${gaps.join(', ')} ms entre leituras (depois da mudança)`)
    expect(gaps.length).toBeGreaterThanOrEqual(2)
    for (const d of gaps.slice(1)) expect(d).toBeGreaterThanOrEqual(2000 - 300)
    for (const d of gaps) expect(d).toBeLessThanOrEqual(2000 + 700)
    expect((await fx<MeetFx>(page)).peopleButtonClicks).toBe(0)
    expect(h.pageErrors).toEqual([])
  })

  test('diálogo do organizador: clica só em "Sair da reunião", nunca em "Encerrar a reunião para todos"', async () => {
    h = await launchWithExtension({ installHost: false, routes: installVigiaRoutes, settings: LIGADO })
    const page = await abrirMeet('n=3&dialogo=organizador&sala=org')
    await expect.poll(() => ultimoTexto(page)).toContain('3 na call')
    const closed = quandoFechar(page)
    await setN(page, 1)
    await expect.poll(async () => (await fx<MeetFx>(page)).leftAt, { timeout: 8_000, intervals: [50] }).not.toBeNull()
    const st = await fx<MeetFx>(page)
    await closed
    console.log(`diálogo do organizador: apareceu e foi respondido em ${st.leftAt! - st.dialogShownAt!} ms (${st.dialogClicks.join(', ')})`)
    expect(st).toMatchObject({ leaveClicks: 1, dialogClicks: ['Sair da reunião'], encerrouParaTodos: false })
    expect(st.leftAt! - st.dialogShownAt!).toBeLessThanOrEqual(2000)
    const ev = await vigiaEventos(h)
    expect(ev.map((e) => e.t)).toEqual(['saindo', 'fechou'])
    expect(h.pageErrors).toEqual([])
  })

  test('diálogo ambíguo: não clica em nada, para de tentar e avisa', async () => {
    h = await launchWithExtension({ installHost: false, routes: installVigiaRoutes, settings: LIGADO })
    const page = await abrirMeet('n=3&dialogo=ambiguo&sala=amb')
    await expect.poll(() => ultimoTexto(page)).toContain('3 na call')
    const tabId = await tabIdOf(h, page)
    await setN(page, 1)
    await expect.poll(() => ultimoTexto(page), { timeout: 8_000 }).toBe('vigia: NÃO consegui sair sozinho: confirme na aba')
    await page.waitForTimeout(5 * INTERVALO_MS)
    const st = await fx<MeetFx>(page)
    expect(page.isClosed()).toBe(false)
    expect(st, 'um clique em sair (abre o diálogo) e nenhum no diálogo').toMatchObject({ leaveClicks: 1, dialogClicks: [], encerrouParaTodos: false, leftAt: null })
    await expect(page.locator('[role="dialog"]')).toBeVisible()
    const ev = await vigiaEventos(h)
    expect(ev.map((e) => [e.t, e.tabId])).toEqual([
      ['saindo', tabId],
      ['aviso', tabId],
    ])
    const aviso = ev.find((e) => e.t === 'aviso')!
    expect(aviso.motivo).toContain('Sair da reunião')
    expect(aviso.notificou, 'a notificação foi criada').toBe(true)
    const notes = await h.sw.evaluate(() => chrome.notifications.getAll())
    console.log(`aviso: ${aviso.motivo}; notificações: ${JSON.stringify(Object.keys(notes))}`)
    expect(Object.keys(notes).some((id) => id.startsWith(`vigia-${tabId}-`))).toBe(true)
    expect(h.pageErrors).toEqual([])
  })

  test('com gravação e diálogo ambíguo: a marca de saída automática é desfeita e o usuário sai sozinho', async () => {
    h = await launchWithExtension({ routes: installVigiaRoutes, settings: LIGADO })
    const api = swApi(h.sw)
    const peer = await h.context.newPage()
    await peer.goto('https://meet.google.com/__peer?tom=440&sala=vigia-amb-rec')
    await peer.click('#iniciar')
    await expect.poll(() => peer.evaluate(() => (window as any).fixture.state)).toBe('pronto')

    const page = await novaAba(h.context)
    await page.goto('https://meet.google.com/abc-defg-hij?vigia=1&n=3&dialogo=ambiguo&sala=vigia-amb-rec')
    await expect.poll(() => page.evaluate(() => (window as any).fixture.micLive)).toBe(true)
    await page.click('#participar')
    await expect.poll(async () => (await api.activeRecordings()).length, { timeout: 15_000, intervals: [250] }).toBe(1)
    const [active] = await api.activeRecordings()
    const tabId = await tabIdOf(h, page)
    await expect.poll(() => ultimoTexto(page)).toContain('3 na call')
    await page.waitForTimeout(7_000)

    await setN(page, 1)
    await expect.poll(() => ultimoTexto(page), { timeout: 8_000 }).toBe('vigia: NÃO consegui sair sozinho: confirme na aba')
    await expect.poll(async () => (await vigiaEventos(h!)).map((e) => e.t)).toEqual(['saindo', 'aviso'])
    // O usuário confirma na aba, à mão (sem passar pelo diálogo do vigia).
    await page.evaluate(() => (window as any).vigiaFx.encerrar())
    await expect.poll(() => findRecordings(h!.root).filter((r) => r.info).length, { timeout: 30_000, intervals: [250] }).toBe(1)
    await page.waitForTimeout(2 * INTERVALO_MS)
    expect(page.isClosed(), 'o vigia desistiu: quem fecha a aba é o usuário').toBe(false)

    const [rec] = findRecordings(h.root)
    const info = rec.info! as unknown as Record<string, unknown>
    console.log(`diálogo ambíguo gravando: motivoFim ${String(info.motivoFim)}; saidaAutomatica ${JSON.stringify(info.saidaAutomatica)}`)
    expect(info).toMatchObject({ sessao: active.sessionId, plataforma: 'meet', status: 'concluida' })
    expect(info.motivoFim).not.toBe('saida-automatica')
    expect(info).not.toHaveProperty('saidaAutomatica')
    expect((await vigiaEventos(h)).map((e) => [e.t, e.tabId])).toEqual([
      ['saindo', tabId],
      ['aviso', tabId],
    ])
    expect(await fx<MeetFx>(page)).toMatchObject({ leaveClicks: 1, dialogClicks: [], encerrouParaTodos: false })
    expect(h.pageErrors).toEqual([])
  })

  test('com gravação: a aba só fecha depois do info.json, com saída automática, e o áudio vai até a saída', async () => {
    h = await launchWithExtension({ routes: installVigiaRoutes, settings: LIGADO })
    const api = swApi(h.sw)
    const peer = await h.context.newPage()
    await peer.goto('https://meet.google.com/__peer?tom=440&sala=vigia-rec')
    await peer.click('#iniciar')
    await expect.poll(() => peer.evaluate(() => (window as any).fixture.state)).toBe('pronto')

    const page = await novaAba(h.context)
    await page.goto('https://meet.google.com/abc-defg-hij?vigia=1&n=3&sala=vigia-rec')
    await expect.poll(() => page.evaluate(() => (window as any).fixture.micLive)).toBe(true)
    await page.click('#participar')
    await expect.poll(async () => (await api.activeRecordings()).length, { timeout: 15_000, intervals: [250] }).toBe(1)
    const [active] = await api.activeRecordings()
    await expect.poll(() => ultimoTexto(page)).toContain('3 na call')
    await page.waitForTimeout(12_000)

    // Finalização lenta de propósito (helper lento): entre a saída e o info.json ficam 3 s a
    // mais. Uma aba fechada sem esperar a gravação salvar fecharia antes do info.json.
    const DELAY_MS = 3000
    await api.delayFinalize(DELAY_MS)
    const closed = page.waitForEvent('close', { timeout: 40_000 }).then(() => ({
      at: Date.now(),
      infos: findRecordings(h!.root).filter((r) => r.info).length,
    }))
    await setN(page, 1)
    await expect.poll(async () => (await fx<MeetFx>(page)).leftAt, { timeout: 5_000, intervals: [50] }).not.toBeNull()
    const leftAt = (await fx<MeetFx>(page)).leftAt!
    const fechou = await closed
    console.log(`Meet gravando: aba fechada ${fechou.at - leftAt} ms depois de sair (finalização com ${DELAY_MS} ms a mais); info.json no disco ao fechar: ${fechou.infos}`)
    expect(fechou.infos, 'o info.json já existia quando a aba fechou').toBe(1)
    expect(fechou.at - leftAt).toBeGreaterThanOrEqual(DELAY_MS)
    expect(fechou.at - leftAt).toBeLessThanOrEqual(DELAY_MS + 10_000)
    const ev = await vigiaEventos(h)
    expect(ev.find((e) => e.t === 'fechou')).toMatchObject({ motivo: 'saiu-da-call', depoisDeSalvar: true })

    const [rec] = findRecordings(h.root)
    const info = rec.info!
    expect(info).toMatchObject({
      sessao: active.sessionId,
      plataforma: 'meet',
      status: 'concluida',
      motivoFim: 'saida-automatica',
      saidaAutomatica: { motivo: 'caiu de 3 para 1', pico: 3, na: 1 },
    })
    const em = Date.parse((info as any).saidaAutomatica.em)
    expect(Math.abs(em - leftAt), `saidaAutomatica.em ${(info as any).saidaAutomatica.em}`).toBeLessThanOrEqual(2000)

    // O áudio vai até a saída. No arquivo, o instante t corresponde à call em t - 1,5 s (o atraso
    // do mixer), e a gravação começou em startedAt. Logo a saída está em (saída - início) + 1,5 s.
    const session = (await api.listSessions()).find((s) => s.sessionId === active.sessionId) as unknown as { startedAt: number }
    const saidaNoArquivo = (leftAt - session.startedAt) / 1000 + 1.5
    const pcm = decodePcm(join(rec.dir, 'audio.webm'))
    const decoded = pcm.length / RATE
    const windows = measureWindows(pcm, [440])
    const comTom = windows.filter((w) => w.db[440] > -20).map((w) => w.second)
    const ultimoComTom = Math.max(...comTom)
    // Janelas inteiras que terminam antes da saída (menos 0,25 s de folga para o relógio).
    const meio = windows.slice(3, Math.floor(saidaNoArquivo - 0.25)).map((w) => w.db[440])
    console.log(
      `áudio: ${decoded.toFixed(2)} s decodificados; saída no arquivo em ${saidaNoArquivo.toFixed(2)} s; último segundo com 440 Hz: ${ultimoComTom} (janela ${ultimoComTom}-${ultimoComTom + 1} s); mediana 440 Hz antes da saída ${median(meio).toFixed(1)} dBFS; menor ${Math.min(...meio).toFixed(1)} dBFS`,
    )
    expect(decoded).toBeGreaterThanOrEqual(saidaNoArquivo - 0.5)
    // O tom está em toda janela inteira antes da saída (do 3o segundo, depois do atraso e do
    // arranque) e a última janela com tom termina a menos de 1,5 s da saída.
    for (const db of meio) expect(db).toBeGreaterThan(-20)
    expect(ultimoComTom + 1).toBeGreaterThanOrEqual(saidaNoArquivo - 1.5)
    expect(h.pageErrors).toEqual([])
  })
})
