// Vigia no Teams (AC18, Emenda 2): porte do script do usuário numa página que imita o Teams
// (tests/fixtures/vigia/teams-page.ts), com uma leitura por segundo (intervaloSeg: 1, os outros
// cinco números são os do script). Mede o tempo de cada decisão contra o intervalo de leitura.
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { decodePcm, measureWindows, median, RATE } from '../helpers/audio'
import { launchWithExtension, swApi, type Harness } from '../helpers/browser'
import { findRecordings } from '../helpers/recordings'
import { installTeamsRoutes } from '../fixtures/teams/routes'
import {
  INTERVALO_MS,
  LIGADO,
  novaAba,
  VIGIA_RAPIDO,
  fx,
  indicador,
  quandoFechar,
  setSettings,
  tabIdOf,
  ultimoTexto,
  vigiaCommand,
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

interface TeamsFx {
  n: number
  hangupClicks: number
  rosterClicks: number
  state: string
  leftAt: number | null
  endedAt: number | null
  errors: string[]
}

async function abrirTeams(query: string): Promise<Page> {
  const page = await novaAba(h!.context)
  await page.goto(`https://teams.microsoft.com/v2/?${query}`)
  return page
}

async function entrar(page: Page): Promise<void> {
  await page.click('#entrar')
  await expect(page.locator('#hangup-button')).toBeVisible()
}

const setN = (page: Page, n: number) => page.evaluate((x) => (window as any).vigiaFx.setN(x), n)

test.describe('vigia no Teams', () => {
  test('ficar sozinho sai na hora e fecha a aba (abre o painel People sozinho)', async () => {
    h = await launchWithExtension({ installHost: false, routes: installVigiaRoutes, settings: LIGADO })
    const page = await abrirTeams('n=3')

    // Antes de entrar: espera a call, sem contar faltas (o script só conta depois de ver a call).
    await expect.poll(() => ultimoTexto(page)).toBe('vigia: esperando a call começar...')
    await page.waitForTimeout(3 * INTERVALO_MS)
    expect((await indicador(page)).map((l) => l.text)).toEqual(['vigia: esperando a call começar...'])

    await entrar(page)
    // Painel fechado: a primeira leitura não acha a contagem, abre o painel (uma vez) e a
    // seguinte lê "Nesta reunião (3)".
    await expect.poll(() => ultimoTexto(page)).toBe('vigia: 3 na call · pico 3 · sai se você ficar sozinho · via painel People')
    const textos = (await indicador(page)).map((l) => l.text)
    expect(textos).toContain('vigia: NÃO achei a contagem (1x): o painel People está aberto?')
    expect((await fx<TeamsFx>(page)).rosterClicks).toBe(1)
    expect((await indicador(page)).every((l) => l.text === null || l.fixed), 'indicador com position:fixed').toBe(true)

    // O popup lê o vigia pelo SW (Emenda 6).
    const tabId = await tabIdOf(h, page)
    await expect.poll(async () => (await vigiaTabState(h!, tabId)).status?.n).toBe(3)
    expect(await vigiaTabState(h, tabId)).toMatchObject({
      connected: true,
      disabledForCall: false,
      status: { platform: 'teams', naCall: true, n: 3, fonte: 'painel People', pico: 3, limite: 1, armado: true, seguidas: 0, saindo: false, tentativas: 0 },
    })

    const closed = quandoFechar(page)
    const t0 = Date.now()
    await setN(page, 1)
    await expect.poll(async () => (await fx<TeamsFx>(page)).leftAt, { timeout: 5_000, intervals: [50] }).not.toBeNull()
    const st = await fx<TeamsFx>(page)
    const closedAt = await closed
    const saiuEm = st.leftAt! - t0
    const fechouEm = closedAt - st.leftAt!
    console.log(`Teams sozinho: saiu ${saiuEm} ms depois de ficar sozinho; aba fechada ${fechouEm} ms depois de sair (intervalo ${INTERVALO_MS} ms)`)
    // Sozinho sai na primeira leitura (no máximo um intervalo, mais a folga do clique).
    expect(saiuEm).toBeLessThanOrEqual(INTERVALO_MS + 500)
    // Fecha na leitura seguinte, quando o botão de desligar sumiu.
    expect(fechouEm).toBeLessThanOrEqual(INTERVALO_MS + 1500)
    expect(st.hangupClicks).toBe(1)
    expect(st.errors).toEqual([])

    const ev = await vigiaEventos(h)
    expect(ev.map(({ t, tabId: id, motivo, depoisDeSalvar }) => ({ t, tabId: id, motivo, depoisDeSalvar }))).toEqual([
      { t: 'saindo', tabId, motivo: 'caiu de 3 para 1', depoisDeSalvar: undefined },
      { t: 'fechou', tabId, motivo: 'saiu-da-call', depoisDeSalvar: true },
    ])
    expect(h.pageErrors).toEqual([])
  })

  test('queda proporcional espera as 4 leituras, uma leitura sem contagem não zera, e tenta sair até o botão sumir', async () => {
    h = await launchWithExtension({ installHost: false, routes: installVigiaRoutes, settings: LIGADO })
    const page = await abrirTeams('n=8&painel=aberto&cliques=2')
    await entrar(page)
    await expect.poll(() => ultimoTexto(page)).toBe('vigia: 8 na call · pico 8 · sai com 2 ou menos · via painel People')

    // 3 está acima do limite (floor(8 * 0,3) = 2): não sai, nem conta queda.
    await setN(page, 3)
    await expect.poll(() => ultimoTexto(page)).toBe('vigia: 3 na call · pico 8 · sai com 2 ou menos · via painel People')
    await page.waitForTimeout(4 * INTERVALO_MS)
    expect((await fx<TeamsFx>(page)).hangupClicks).toBe(0)
    expect((await indicador(page)).some((l) => l.text?.includes('confirmando'))).toBe(false)

    const closed = quandoFechar(page)
    const t0 = Date.now()
    await setN(page, 2)
    await expect.poll(() => ultimoTexto(page)).toBe('vigia: 2 na call · pico 8 · sai com 2 ou menos · confirmando 2/4 · via painel People')
    // O painel fecha: a próxima leitura é null (não zera nem conta) e o vigia abre o painel de novo.
    await page.evaluate(() => (window as any).vigiaFx.fecharPainel())
    await expect.poll(async () => (await fx<TeamsFx>(page)).leftAt, { timeout: 10_000, intervals: [50] }).not.toBeNull()
    const st = await fx<TeamsFx>(page)
    const closedAt = await closed
    const leituras = (await indicador(page)).filter((l) => l.at >= t0)
    const textos = leituras.map((l) => l.text)
    console.log(`Teams queda proporcional: ${textos.join(' -> ')}`)

    const iQueda = (k: number) => textos.indexOf(`vigia: 2 na call · pico 8 · sai com 2 ou menos · confirmando ${k}/4 · via painel People`)
    const iNull = textos.findIndex((t) => t?.startsWith('vigia: NÃO achei a contagem'))
    expect(iQueda(1)).toBeGreaterThanOrEqual(0)
    expect(iQueda(2)).toBeGreaterThan(iQueda(1))
    expect(iNull, 'a leitura sem contagem vem depois da queda 2/4').toBeGreaterThan(iQueda(2))
    expect(iQueda(3), 'depois da leitura null a queda continua em 3/4, não volta a 1/4').toBeGreaterThan(iNull)
    expect(textos.slice(iNull)).not.toContain(`vigia: 2 na call · pico 8 · sai com 2 ou menos · confirmando 1/4 · via painel People`)
    expect(textos).toContain('vigia: saindo da call (tentativa 1)...')
    expect(textos).toContain('vigia: saindo da call (tentativa 2)...')
    expect(textos.at(-1)).toBe('vigia: fechando...')

    // Do primeiro 2 lido até o primeiro clique: 4 leituras com 2 e uma null no meio, isto é,
    // pelo menos 4 intervalos depois da leitura "queda 1/4".
    const primeiroClique = leituras.find((l) => l.text === 'vigia: saindo da call (tentativa 1)...')!.at
    const desdeQueda1 = primeiroClique - leituras[iQueda(1)].at
    console.log(`queda 1/4 -> primeiro clique: ${desdeQueda1} ms; 2 colocado -> saiu (2o clique): ${st.leftAt! - t0} ms; saiu -> aba fechada: ${closedAt - st.leftAt!} ms`)
    expect(desdeQueda1).toBeGreaterThanOrEqual(4 * INTERVALO_MS - 300)
    expect(st.hangupClicks, 'o primeiro clique não tirou da call: tenta de novo na leitura seguinte').toBe(2)
    expect(closedAt - st.leftAt!).toBeLessThanOrEqual(INTERVALO_MS + 1500)

    const ev = await vigiaEventos(h)
    expect(ev.filter((e) => e.t === 'saindo').map((e) => e.motivo)).toEqual(['caiu de 8 para 2'])
    expect(ev.filter((e) => e.t === 'fechou').map((e) => e.motivo)).toEqual(['saiu-da-call'])
    expect(h.pageErrors).toEqual([])
  })

  test('desligado não faz nada; ligar e desligar com a call aberta vale na próxima leitura', async () => {
    h = await launchWithExtension({ installHost: false, routes: installVigiaRoutes, settings: { vigia: VIGIA_RAPIDO } })
    const page = await abrirTeams('n=3')
    await entrar(page)
    const tabId = await tabIdOf(h, page)
    await setN(page, 1)
    await page.waitForTimeout(4 * INTERVALO_MS)
    expect(await indicador(page)).toEqual([])
    expect(await fx<TeamsFx>(page)).toMatchObject({ hangupClicks: 0, rosterClicks: 0, state: 'call' })
    expect(await vigiaTabState(h, tabId)).toEqual({ connected: false, disabledForCall: false, status: null })

    // Liga com a call aberta: o content script conecta na hora e começa a ler (pico 1: desarmado).
    await setSettings(h, { autoLeave: true })
    await expect.poll(() => ultimoTexto(page)).toBe('vigia: 1 na call · pico 1 · sai se você ficar sozinho (espera alguém entrar) · via painel People')
    await setN(page, 2)
    await expect.poll(() => ultimoTexto(page)).toBe('vigia: 2 na call · pico 2 · sai se você ficar sozinho · via painel People')

    // Sem o indicador: ele sai da página, mas o vigia continua lendo (o popup vê pelo SW).
    await setSettings(h, { vigiaIndicador: false })
    await expect.poll(async () => (await indicador(page)).at(-1)?.text).toBeNull()
    await setN(page, 3)
    await expect.poll(async () => (await vigiaTabState(h!, tabId)).status?.pico).toBe(3)
    expect((await vigiaTabState(h, tabId)).status).toMatchObject({ naCall: true, n: 3, pico: 3 })
    expect((await indicador(page)).at(-1)?.text, 'o indicador não volta sozinho').toBeNull()
    expect((await indicador(page)).some((l) => l.text?.includes('3 na call')), 'nenhuma leitura com 3 apareceu na página').toBe(false)
    // Volta: o indicador reaparece já com a leitura atual.
    await setSettings(h, { vigiaIndicador: true })
    await expect.poll(() => ultimoTexto(page)).toBe('vigia: 3 na call · pico 3 · sai se você ficar sozinho · via painel People')

    // Desliga: o indicador sai e ficar sozinho não faz mais nada.
    await setSettings(h, { autoLeave: false })
    await expect.poll(async () => (await indicador(page)).at(-1)?.text).toBeNull()
    await setN(page, 1)
    await page.waitForTimeout(4 * INTERVALO_MS)
    expect((await indicador(page)).at(-1)?.text).toBeNull()
    expect((await fx<TeamsFx>(page)).hangupClicks).toBe(0)
    expect(page.isClosed()).toBe(false)
    expect(await vigiaEventos(h)).toEqual([])
    await expect.poll(async () => (await vigiaTabState(h!, tabId)).connected).toBe(false)
    expect(h.pageErrors).toEqual([])
  })

  test('mudar a régua com a call aberta vale na próxima leitura, sem perder o pico', async () => {
    h = await launchWithExtension({ installHost: false, routes: installVigiaRoutes, settings: LIGADO })
    const page = await abrirTeams('n=8&painel=aberto')
    await entrar(page)
    await expect.poll(() => ultimoTexto(page)).toBe('vigia: 8 na call · pico 8 · sai com 2 ou menos · via painel People')
    // 3 fica acima do limite do script (floor(8 * 0,3) = 2): nada acontece.
    await setN(page, 3)
    await expect.poll(() => ultimoTexto(page)).toBe('vigia: 3 na call · pico 8 · sai com 2 ou menos · via painel People')
    await page.waitForTimeout(2 * INTERVALO_MS)
    expect((await fx<TeamsFx>(page)).hangupClicks).toBe(0)

    // fracao 0,5 (limite floor(8 * 0,5) = 4) e 2 confirmações: o 3 passa a ser queda já na próxima
    // leitura, e a segunda leitura sai.
    const closed = quandoFechar(page)
    const t0 = Date.now()
    await setSettings(h, { vigia: { ...VIGIA_RAPIDO, fracao: 0.5, confirmacoes: 2 } })
    const QUEDA = 'vigia: 3 na call · pico 8 · sai com 4 ou menos · confirmando 1/2 · via painel People'
    await expect.poll(() => ultimoTexto(page), { timeout: 2 * INTERVALO_MS + 1000 }).not.toBe('vigia: 3 na call · pico 8 · sai com 2 ou menos · via painel People')
    await expect.poll(async () => (await fx<TeamsFx>(page)).leftAt, { timeout: 5_000, intervals: [50] }).not.toBeNull()
    const st = await fx<TeamsFx>(page)
    await closed
    const depois = (await indicador(page)).filter((l) => l.at >= t0)
    const textos = depois.map((l) => l.text)
    console.log(`Teams régua nova: ${textos.join(' -> ')}`)
    expect(textos[0], 'a primeira leitura depois da mudança já usa a régua nova').toBe(QUEDA)
    expect(depois[0].at - t0).toBeLessThanOrEqual(INTERVALO_MS + 700)
    expect(textos.slice(1)).toEqual(['vigia: saindo da call (tentativa 1)...', 'vigia: fechando...'])
    expect(st.leftAt! - depois[0].at, 'sai na leitura seguinte (2a confirmação)').toBeLessThanOrEqual(INTERVALO_MS + 500)
    expect(st.hangupClicks).toBe(1)
    const ev = await vigiaEventos(h)
    expect(ev.map((e) => [e.t, e.motivo])).toEqual([
      ['saindo', 'caiu de 8 para 3'],
      ['fechou', 'saiu-da-call'],
    ])
    expect(h.pageErrors).toEqual([])
  })

  test('modo quantidade (3 ou menos, 2 confirmações): call que nunca passou de 3 só sai sozinho; na de 10, 4 fica e 3 sai (Emenda 16)', async () => {
    h = await launchWithExtension({ installHost: false, routes: installVigiaRoutes, settings: { autoLeave: true, vigia: { ...VIGIA_RAPIDO, modo: 'quantidade', quantidade: 3, confirmacoes: 2 } } })
    const page = await abrirTeams('n=3&painel=aberto')
    await entrar(page)
    // Nunca passou de 3: "3 ou menos" ainda não vale (sairia no pico); com 2, fica.
    await expect.poll(() => ultimoTexto(page)).toBe('vigia: 3 na call · pico 3 · sai se você ficar sozinho · via painel People')
    await setN(page, 2)
    await expect.poll(() => ultimoTexto(page)).toBe('vigia: 2 na call · pico 3 · sai se você ficar sozinho · via painel People')
    await page.waitForTimeout(3 * INTERVALO_MS)
    expect((await fx<TeamsFx>(page)).hangupClicks).toBe(0)

    // A call cresce para 10: arma. 4 está acima do limite.
    await setN(page, 10)
    await expect.poll(() => ultimoTexto(page)).toBe('vigia: 10 na call · pico 10 · sai com 3 ou menos · via painel People')
    await setN(page, 4)
    await expect.poll(() => ultimoTexto(page)).toBe('vigia: 4 na call · pico 10 · sai com 3 ou menos · via painel People')
    await page.waitForTimeout(3 * INTERVALO_MS)
    expect((await fx<TeamsFx>(page)).hangupClicks).toBe(0)

    const closed = quandoFechar(page)
    const t0 = Date.now()
    await setN(page, 3)
    await expect.poll(async () => (await fx<TeamsFx>(page)).leftAt, { timeout: 5_000, intervals: [50] }).not.toBeNull()
    const st = await fx<TeamsFx>(page)
    await closed
    const leituras = (await indicador(page)).filter((l) => l.at >= t0)
    const textos = leituras.map((l) => l.text)
    console.log(`Teams quantidade 3: ${textos.join(' -> ')}`)
    expect(textos[0]).toBe('vigia: 3 na call · pico 10 · sai com 3 ou menos · confirmando 1/2 · via painel People')
    expect(textos.slice(1)).toEqual(['vigia: saindo da call (tentativa 1)...', 'vigia: fechando...'])
    // A segunda leitura com 3 sai (uma leitura depois da primeira).
    expect(leituras[1].at - leituras[0].at).toBeGreaterThanOrEqual(INTERVALO_MS - 300)
    expect(st.hangupClicks).toBe(1)
    expect((await vigiaEventos(h)).map((e) => [e.t, e.motivo])).toEqual([
      ['saindo', 'caiu de 10 para 3'],
      ['fechou', 'saiu-da-call'],
    ])
    expect(h.pageErrors).toEqual([])
  })

  test('modo proporção com metade: na call de 10, 6 fica e 5 sai depois das 4 leituras (Emenda 16)', async () => {
    h = await launchWithExtension({ installHost: false, routes: installVigiaRoutes, settings: { autoLeave: true, vigia: { ...VIGIA_RAPIDO, modo: 'proporcao', fracao: 0.5 } } })
    const page = await abrirTeams('n=10&painel=aberto')
    await entrar(page)
    await expect.poll(() => ultimoTexto(page)).toBe('vigia: 10 na call · pico 10 · sai com 5 ou menos · via painel People')
    await setN(page, 6)
    await expect.poll(() => ultimoTexto(page)).toBe('vigia: 6 na call · pico 10 · sai com 5 ou menos · via painel People')
    await page.waitForTimeout(5 * INTERVALO_MS)
    expect((await fx<TeamsFx>(page)).hangupClicks).toBe(0)
    expect((await indicador(page)).some((l) => l.text?.includes('confirmando'))).toBe(false)

    const closed = quandoFechar(page)
    await setN(page, 5)
    await expect.poll(async () => (await fx<TeamsFx>(page)).leftAt, { timeout: 10_000, intervals: [50] }).not.toBeNull()
    await closed
    const leituras = await indicador(page)
    const textos = leituras.map((l) => l.text)
    const iQueda = (k: number) => textos.indexOf(`vigia: 5 na call · pico 10 · sai com 5 ou menos · confirmando ${k}/4 · via painel People`)
    expect([1, 2, 3].map(iQueda).every((i, k, a) => i >= 0 && (k === 0 || i > a[k - 1]))).toBe(true)
    const clique = leituras.find((l) => l.text === 'vigia: saindo da call (tentativa 1)...')!.at
    expect(clique - leituras[iQueda(1)].at, 'sai na 4a leitura com 5').toBeGreaterThanOrEqual(3 * INTERVALO_MS - 300)
    expect((await vigiaEventos(h)).filter((e) => e.t === 'saindo').map((e) => e.motivo)).toEqual(['caiu de 10 para 5'])
    expect(h.pageErrors).toEqual([])
  })

  test('a call some sem clique: fecha a aba depois de faltasParaFim leituras', async () => {
    h = await launchWithExtension({ installHost: false, routes: installVigiaRoutes, settings: LIGADO })
    const page = await abrirTeams('n=5&painel=aberto')
    await entrar(page)
    await expect.poll(() => ultimoTexto(page)).toBe('vigia: 5 na call · pico 5 · sai com 2 ou menos · via painel People')
    const closed = quandoFechar(page)
    const t0 = Date.now()
    await page.evaluate(() => (window as any).vigiaFx.encerrar())
    const closedAt = await closed
    const st = await fx<TeamsFx>(page).catch(() => null)
    expect(st, 'a aba já fechou').toBeNull()
    const ev = await vigiaEventos(h)
    const fechou = ev.find((e) => e.t === 'fechou')!
    console.log(`Teams call sumiu: aba fechada ${closedAt - t0} ms depois (faltasParaFim ${VIGIA_RAPIDO.faltasParaFim}, intervalo ${INTERVALO_MS} ms)`)
    // A 1a leitura sem call vem em até 1 intervalo; a 3a, 2 intervalos depois dela.
    expect(closedAt - t0).toBeGreaterThanOrEqual((VIGIA_RAPIDO.faltasParaFim - 1) * INTERVALO_MS - 300)
    expect(closedAt - t0).toBeLessThanOrEqual(VIGIA_RAPIDO.faltasParaFim * INTERVALO_MS + 1500)
    // As leituras depois do fim: 1/3, 2/3 e, na 3a, fecha (o "fechando..." cobre o 3/3 na mesma leitura).
    const depois = (await indicador(page)).filter((l) => l.at >= t0)
    expect(depois.map((l) => l.text)).toEqual(['vigia: a call sumiu (1/3)', 'vigia: a call sumiu (2/3)', 'vigia: fechando...'])
    const daPrimeira = closedAt - depois[0].at
    console.log(`1a leitura sem a call -> aba fechada: ${daPrimeira} ms`)
    expect(daPrimeira).toBeGreaterThanOrEqual((VIGIA_RAPIDO.faltasParaFim - 1) * INTERVALO_MS - 300)
    expect(daPrimeira).toBeLessThan(VIGIA_RAPIDO.faltasParaFim * INTERVALO_MS)
    expect(fechou).toMatchObject({ motivo: 'a-call-acabou', depoisDeSalvar: true })
    expect(ev.filter((e) => e.t === 'saindo')).toEqual([])
    expect(h.pageErrors).toEqual([])
  })

  test('a call some e volta antes da 3a leitura: as faltas zeram e a aba fica', async () => {
    h = await launchWithExtension({ installHost: false, routes: installVigiaRoutes, settings: LIGADO })
    const page = await abrirTeams('n=5&painel=aberto')
    await entrar(page)
    await expect.poll(() => ultimoTexto(page)).toContain('5 na call')
    // Duas vezes fora por 1,5 intervalo (1 ou 2 leituras sem a call), com a call de volta no meio.
    for (let i = 0; i < 2; i++) {
      await page.evaluate((ms) => (window as any).vigiaFx.sumirPor(ms), 1.5 * INTERVALO_MS)
      await page.waitForTimeout(3 * INTERVALO_MS)
    }
    expect(page.isClosed()).toBe(false)
    const textos = (await indicador(page)).map((l) => l.text)
    console.log(`Teams some e volta: ${textos.join(' -> ')}`)
    expect(textos.filter((t) => t === 'vigia: a call sumiu (1/3)').length, 'a contagem de faltas recomeça do 1').toBe(2)
    expect(textos).not.toContain('vigia: a call sumiu (3/3)')
    expect(textos.at(-1)).toBe('vigia: 5 na call · pico 5 · sai com 2 ou menos · via painel People')
    expect(await vigiaEventos(h)).toEqual([])
  })

  test('extensão recarregada ou atualizada com a call aberta: o vigia órfão para e nunca mais clica em sair', async () => {
    h = await launchWithExtension({ installHost: false, routes: installVigiaRoutes, settings: LIGADO })
    const page = await abrirTeams('n=3&painel=aberto')
    await entrar(page)
    await expect.poll(() => ultimoTexto(page)).toBe('vigia: 3 na call · pico 3 · sai se você ficar sozinho · via painel People')
    // O mesmo que o "recarregar" do chrome://extensions ou uma atualização: o content script da
    // aba fica órfão (sem Port, sem configuração nova, sem "Desligar nesta call").
    await h.sw.evaluate(() => setTimeout(() => chrome.runtime.reload(), 50)).catch(() => {})
    await page.waitForTimeout(3 * INTERVALO_MS)
    await setN(page, 1)
    await page.waitForTimeout(4 * INTERVALO_MS)
    const st = await fx<TeamsFx>(page)
    expect(st.hangupClicks, 'o vigia órfão saiu da call').toBe(0)
    expect(st.leftAt).toBeNull()
    expect(page.isClosed()).toBe(false)
  })

  test('sala de grupo no mesmo documento: a call some por um instante e volta menor; o pico recomeça e o vigia não sai', async () => {
    h = await launchWithExtension({ installHost: false, routes: installVigiaRoutes, settings: LIGADO })
    const page = await abrirTeams('n=20&painel=aberto')
    await entrar(page)
    await expect.poll(() => ultimoTexto(page)).toBe('vigia: 20 na call · pico 20 · sai com 6 ou menos · via painel People')
    // A troca para a sala de 4 pessoas: os marcadores somem por uma leitura e voltam com 4.
    await page.evaluate((ms) => (window as any).vigiaFx.sumirPor(ms), 1.5 * INTERVALO_MS)
    await setN(page, 4)
    await page.waitForTimeout(7 * INTERVALO_MS)
    const st = await fx<TeamsFx>(page)
    expect(st.hangupClicks, 'saiu da sala de grupo pelo pico da reunião principal').toBe(0)
    expect(await ultimoTexto(page)).toBe('vigia: 4 na call · pico 4 · sai com 2 ou menos · via painel People')
    expect(await vigiaEventos(h)).toEqual([])
  })

  test('popup: "Desligar nesta call" para o vigia daquela aba e "Sair agora" sai na hora', async () => {
    h = await launchWithExtension({ installHost: false, routes: installVigiaRoutes, settings: LIGADO })
    const a = await abrirTeams('n=4&painel=aberto&sala=a')
    const b = await abrirTeams('n=6&painel=aberto&sala=b')
    await entrar(a)
    await entrar(b)
    await expect.poll(() => ultimoTexto(a)).toContain('4 na call')
    await expect.poll(() => ultimoTexto(b)).toContain('6 na call')
    const tabA = await tabIdOf(h, a)
    const tabB = await tabIdOf(h, b)

    expect(await vigiaCommand(h, tabA, 'desligar-nesta-call')).toBe(true)
    await expect.poll(async () => (await indicador(a)).at(-1)?.text).toBeNull()
    expect(await vigiaTabState(h, tabA)).toMatchObject({ connected: true, disabledForCall: true })
    await setN(a, 1)

    const closedB = quandoFechar(b)
    const t0 = Date.now()
    expect(await vigiaCommand(h, tabB, 'sair-agora')).toBe(true)
    const closedAt = await closedB
    console.log(`Sair agora: aba fechada ${closedAt - t0} ms depois do comando`)
    expect(closedAt - t0).toBeLessThanOrEqual(INTERVALO_MS + 1500)

    await a.waitForTimeout(4 * INTERVALO_MS)
    expect(a.isClosed()).toBe(false)
    expect((await fx<TeamsFx>(a)).hangupClicks).toBe(0)
    const ev = await vigiaEventos(h)
    expect(ev.map((e) => [e.t, e.tabId, e.motivo])).toEqual([
      ['saindo', tabB, 'pedido manual'],
      ['fechou', tabB, 'saiu-da-call'],
    ])
    expect(h.pageErrors).toEqual([])
  })

  test('"Desligar nesta call" vale até a próxima call da mesma aba, sem recarregar; uma queda curta é a mesma call', async () => {
    h = await launchWithExtension({ installHost: false, routes: installVigiaRoutes, settings: LIGADO })
    const page = await abrirTeams('n=4&painel=aberto')
    await entrar(page)
    await expect.poll(() => ultimoTexto(page)).toBe('vigia: 4 na call · pico 4 · sai com 2 ou menos · via painel People')
    const tabId = await tabIdOf(h, page)
    expect(await vigiaCommand(h, tabId, 'desligar-nesta-call')).toBe(true)
    await expect.poll(async () => (await indicador(page)).at(-1)?.text).toBeNull()
    expect(await vigiaTabState(h, tabId)).toMatchObject({ connected: true, disabledForCall: true, status: null })

    // Parado: ficar sozinho não sai, e uma queda curta (menos de faltasParaFim leituras) é a mesma
    // call. Três quedas curtas seguidas (de 1 ou 2 leituras cada) não somam: cada volta zera.
    await setN(page, 1)
    for (let i = 0; i < 3; i++) {
      await page.evaluate((ms) => (window as any).vigiaFx.sumirPor(ms), 1.5 * INTERVALO_MS)
      await page.waitForTimeout(3 * INTERVALO_MS)
    }
    expect((await fx<TeamsFx>(page)).hangupClicks).toBe(0)
    expect(await vigiaTabState(h, tabId)).toMatchObject({ connected: true, disabledForCall: true })
    expect((await indicador(page)).at(-1)?.text).toBeNull()

    // A call acaba (faltasParaFim leituras sem ela) e outra começa no mesmo documento (o Teams é
    // aplicação de página única): o vigia volta a valer sozinho, com a régua do zero.
    await setN(page, 5)
    const voltou = Date.now()
    await page.evaluate((ms) => (window as any).vigiaFx.sumirPor(ms), (VIGIA_RAPIDO.faltasParaFim + 1.5) * INTERVALO_MS)
    await expect.poll(async () => (await vigiaTabState(h!, tabId)).disabledForCall, { timeout: 15_000 }).toBe(false)
    await expect.poll(() => ultimoTexto(page), { timeout: 10_000 }).toBe('vigia: 5 na call · pico 5 · sai com 2 ou menos · via painel People')
    console.log(`Teams call nova: vigia de volta ${Date.now() - voltou} ms depois de a call sumir`)
    expect(await vigiaTabState(h, tabId)).toMatchObject({ connected: true, disabledForCall: false, status: { n: 5, pico: 5 } })
    // E vale de verdade: ficar sozinho na call nova sai e fecha a aba.
    const closed = quandoFechar(page)
    await setN(page, 1)
    await closed
    const ev = await vigiaEventos(h)
    expect(ev.map((e) => [e.t, e.motivo])).toEqual([
      ['saindo', 'caiu de 5 para 1'],
      ['fechou', 'saiu-da-call'],
    ])
    expect(h.pageErrors).toEqual([])
  })

  test('Teams gravando: a aba só fecha depois do info.json, com saída automática, e o áudio vai até a saída', async () => {
    // A reunião falsa do adaptador do Teams (tests/fixtures/teams/, variante vigia), com PC,
    // participante remoto e o painel People: grava de verdade e o vigia conta.
    h = await launchWithExtension({ routes: installTeamsRoutes, settings: LIGADO })
    const api = swApi(h.sw)
    const peer = await h.context.newPage()
    await peer.goto('https://teams.microsoft.com/__peer?variante=teams&tom=440&dominante=660&sala=vigia-teams')
    await peer.click('#iniciar')
    await expect.poll(() => peer.evaluate(() => (window as any).fixture.state)).toBe('pronto')
    const page = await h.context.newPage()
    await page.goto('https://teams.microsoft.com/meet/1234567890123?p=abcd&variante=vigia&n=3&sala=vigia-teams')
    const fixture = <T>(key: string) => page.evaluate((k) => (window as any).fixture[k], key) as Promise<T>
    await expect.poll(() => fixture('micLive')).toBe(true)
    // Alguns segundos no pré-join, como numa entrada de verdade: o adaptador lê o título do
    // cabeçalho ali (a cada 1 s), e ele some na call.
    await page.waitForTimeout(2000)
    await page.click('#participar')
    await expect.poll(() => fixture('pcState'), { timeout: 15_000, intervals: [100] }).toBe('connected')
    await page.evaluate(() => (window as any).ui.admitir())
    await expect.poll(async () => (await api.activeRecordings()).length, { timeout: 15_000, intervals: [250] }).toBe(1)
    const [active] = await api.activeRecordings()
    await expect.poll(async () => (await vigiaTabState(h!, active.tabId)).status?.n, { timeout: 10_000 }).toBe(3)
    await page.waitForTimeout(12_000)
    expect(await fixture<string[]>('errors')).toEqual([])

    // Finalização lenta de propósito (helper lento): entre a saída e o info.json ficam 3 s a mais.
    const DELAY_MS = 3000
    await api.delayFinalize(DELAY_MS)
    const closed = page.waitForEvent('close', { timeout: 40_000 }).then(() => ({
      at: Date.now(),
      infos: findRecordings(h!.root).filter((r) => r.info).length,
    }))
    await page.evaluate(() => (window as any).fixture.setN(1))
    await expect.poll(() => fixture<number | undefined>('desligouEm'), { timeout: 5_000, intervals: [50] }).toBeGreaterThan(0)
    const leftAt = (await fixture<number>('desligouEm'))!
    const fechou = await closed
    console.log(`Teams gravando: aba fechada ${fechou.at - leftAt} ms depois de sair (finalização com ${DELAY_MS} ms a mais); info.json no disco ao fechar: ${fechou.infos}`)
    expect(fechou.infos, 'o info.json já existia quando a aba fechou').toBe(1)
    expect(fechou.at - leftAt).toBeGreaterThanOrEqual(DELAY_MS)
    expect(fechou.at - leftAt).toBeLessThanOrEqual(DELAY_MS + 10_000)
    const ev = await vigiaEventos(h)
    expect(ev.find((e) => e.t === 'fechou')).toMatchObject({ motivo: 'saiu-da-call', depoisDeSalvar: true })

    const [rec] = findRecordings(h.root)
    const info = rec.info!
    expect(rec.folder).toMatch(/ - Planejamento trimestral \(Teams\)$/)
    expect(info).toMatchObject({
      sessao: active.sessionId,
      plataforma: 'teams',
      status: 'concluida',
      motivoFim: 'saida-automatica',
      saidaAutomatica: { motivo: 'caiu de 3 para 1', pico: 3, na: 1 },
    })
    const em = Date.parse((info as any).saidaAutomatica.em)
    expect(Math.abs(em - leftAt), `saidaAutomatica.em ${(info as any).saidaAutomatica.em}`).toBeLessThanOrEqual(2000)

    // O áudio vai até a saída: no arquivo, o instante t é a call em t - 1,5 s (atraso do mixer).
    const session = (await api.listSessions()).find((s) => s.sessionId === active.sessionId) as unknown as { startedAt: number }
    const saidaNoArquivo = (leftAt - session.startedAt) / 1000 + 1.5
    const pcm = decodePcm(join(rec.dir, 'audio.webm'))
    const decoded = pcm.length / RATE
    const windows = measureWindows(pcm, [440, 660, 1000])
    const comTom = windows.filter((w) => w.db[440] > -20).map((w) => w.second)
    const ultimoComTom = Math.max(...comTom)
    const meio = windows.slice(3, Math.floor(saidaNoArquivo - 0.25))
    console.log(
      `Teams áudio: ${decoded.toFixed(2)} s decodificados; saída no arquivo em ${saidaNoArquivo.toFixed(2)} s; último segundo com 440 Hz: ${ultimoComTom}; mediana 440 Hz antes da saída ${median(meio.map((w) => w.db[440])).toFixed(1)} dBFS; menor ${Math.min(...meio.map((w) => w.db[440])).toFixed(1)} dBFS`,
    )
    expect(decoded).toBeGreaterThanOrEqual(saidaNoArquivo - 0.5)
    for (const w of meio) {
      expect(w.db[440], `440 Hz no segundo ${w.second}`).toBeGreaterThan(-20)
      expect(w.db[660], `dominantSpeaker no segundo ${w.second}`).toBeLessThanOrEqual(w.db[440] - 30)
      expect(w.db[1000], `microfone no segundo ${w.second}`).toBeLessThanOrEqual(w.db[440] - 30)
    }
    expect(ultimoComTom + 1).toBeGreaterThanOrEqual(saidaNoArquivo - 1.5)
    expect(h.pageErrors).toEqual([])
  })
})
