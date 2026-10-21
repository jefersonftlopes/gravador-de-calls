// A regra do mudo (Emenda 24) num Chrome de verdade: a página falsa do Meet manda o microfone
// falso pelo RTCPeerConnection e muta das QUATRO formas que um aplicativo de call usa, uma por
// teste. Em cada uma, o portão tem de FECHAR com o motivo certo e ABRIR de novo ao desmutar, e o
// diagnóstico do falantes.json (só números, Emenda 20) tem de dizer isso.
//
// O que este teste NÃO prova: qual das quatro formas o Meet e o Teams usam de verdade. Isso só a
// call real do usuário diz, e é para isso que o diagnóstico existe.
//
// Duas das quatro formas são indistinguíveis pela observação, de propósito: `replaceTrack(null)` e
// `removeTrack(sender)` deixam a faixa viva e ligada sem nenhum sender mandando ela, e as duas
// fecham por `sem-sender`. O que importa é fechar.
//
// E a fatia é só medida: nenhum áudio de microfone sai da sessão. O último teste mede a gravação
// (o tom de 1000 Hz do microfone falso pelo menos 30 dB abaixo do tom de 440 Hz do outro
// participante, AC3) e confere que a pasta da call não ganhou arquivo nenhum.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { decodePcm, measureWindows, median } from '../helpers/audio'
import { launchWithExtension, swApi, type Harness } from '../helpers/browser'
import { installMeetRosterRoute } from '../fixtures/meet/roster'
import { dcrpcMessage, dcrpcRecord } from '../helpers/protobuf'
import { findRecordings } from '../helpers/recordings'
import type { SpeakersFile } from '../../src/shared/protocol'

const ANA = 'spaces/sala1/devices/2'
const EU = 'spaces/sala1/devices/1'
/** Quanto tempo em cada fase (aberto, mudo, aberto de novo): 4 s dão 16 leituras de 250 ms. */
const FASE_MS = 4000

let h: Harness | undefined

test.afterEach(async ({}, testInfo) => {
  if (h && testInfo.status !== testInfo.expectedStatus) {
    const log = existsSync(h.hostLog) ? readFileSync(h.hostLog, 'utf8') : '(sem log do helper)'
    await testInfo.attach('console', { body: `${h.logs.join('\n')}\n--- helper.log ---\n${log}`, contentType: 'text/plain' })
    console.log(h.logs.join('\n'))
  }
  await h?.close()
  h = undefined
})

const fx = (page: Page, key: string) => page.evaluate((k) => (window as any).fixture[k], key)

/** O que a própria página vê da faixa e do sender (fx.estado da variante). */
const estadoDaPagina = (page: Page) => page.evaluate(() => (window as any).fixture.estado()) as Promise<PageState>

interface PageState {
  readyState: string | null
  enabled: boolean | null
  muted: boolean | null
  enviando: boolean
}

/**
 * Sobe uma call do Meet falsa com o microfone enviado ao PC e a Ana falando pelo 'dcrpc' (o
 * falantes.json só existe com alguém falando). Devolve a aba da call e o `startedAt` da gravação.
 */
async function callComMicrofone(sala: string): Promise<{ call: Page; peer: Page }> {
  h = await launchWithExtension({
    routes: (context) =>
      installMeetRosterRoute(context, [
        { deviceId: EU, name: 'Alex Lima', self: true },
        { deviceId: ANA, name: 'Ana Souza' },
      ]),
  })
  const peer = await h.context.newPage()
  await peer.goto(`https://meet.google.com/__peer?variante=canais&tom=440&sala=${sala}`)
  await peer.click('#iniciar')
  await expect.poll(() => peer.evaluate(() => (window as any).fixture.state)).toBe('pronto')
  const call = await h.context.newPage()
  await call.goto(`https://meet.google.com/abc-defg-hij?variante=mudo&sala=${sala}`)
  await expect.poll(() => fx(call, 'micPronto')).toBe(true)
  await call.click('#participar')
  await expect.poll(() => fx(call, 'pcState'), { timeout: 15_000, intervals: [100] }).toBe('connected')
  await expect.poll(() => peer.evaluate(() => (window as any).peer.canais()), { timeout: 10_000 }).toEqual([['dcrpc', 'open']])
  await expect.poll(() => fx(call, 'rosterBuscada')).toBe(true)
  // Uma leitura do dcrpc vale 30 s: a Ana "fala" durante toda a gravação.
  const snapshot = Buffer.from(dcrpcMessage([dcrpcRecord(ANA, true)])).toString('base64')
  await expect
    .poll(async () => (await swApi(h!.sw).activeRecordings()).length, { timeout: 15_000, intervals: [100] })
    .toBe(1)
  await peer.evaluate((d) => (window as any).peer.enviar('dcrpc', { b64: d }), snapshot)
  return { call, peer }
}

/** Espera a pasta da call com o info.json e devolve o falantes.json dela. */
async function falantesDaPasta(): Promise<{ file: SpeakersFile; dir: string; files: string[] }> {
  await expect.poll(() => findRecordings(h!.root).filter((r) => r.info).length, { timeout: 20_000, intervals: [250] }).toBe(1)
  const [rec] = findRecordings(h!.root)
  return { file: JSON.parse(readFileSync(join(rec.dir, 'falantes.json'), 'utf8')) as SpeakersFile, dir: rec.dir, files: rec.files }
}

type Motivo = 'readyState' | 'enabled' | 'muted' | 'semSender' | 'semFaixa' | 'desconhecido'
const MOTIVOS: readonly Motivo[] = ['readyState', 'enabled', 'muted', 'semSender', 'semFaixa', 'desconhecido']

/**
 * Nenhum motivo fora dos `permitidos` apareceu. `semSender` é sempre permitido no fim: sair da call
 * fecha o RTCPeerConnection, e aí o microfone deixa de estar num sender de verdade. Esse
 * fechamento do fim é correto (o microfone não vai mais para a call) e acontece de uma a quatro
 * leituras antes de o controlador ver o fim, por isso as contagens do fim entram como faixa.
 */
function conferirMotivos(motivos: Record<Motivo, number>, permitidos: Motivo[]): void {
  for (const m of MOTIVOS) {
    if (permitidos.includes(m) || m === 'semSender') continue
    expect(motivos[m], `motivo ${m}`).toBe(0)
  }
}

/** As quatro formas de mutar, o estado que a página mostra no mudo e o motivo esperado no portão. */
const FORMAS = [
  { forma: 'enabled', como: 'track.enabled = false', motivo: 'enabled' as Motivo, mudo: { readyState: 'live', enabled: false, enviando: true } },
  { forma: 'stop', como: 'track.stop()', motivo: 'readyState' as Motivo, mudo: { readyState: 'ended', enabled: true, enviando: true } },
  { forma: 'replace', como: 'sender.replaceTrack(null)', motivo: 'semSender' as Motivo, mudo: { readyState: 'live', enabled: true, enviando: false } },
  { forma: 'remove', como: 'pc.removeTrack(sender)', motivo: 'semSender' as Motivo, mudo: { readyState: 'live', enabled: true, enviando: false } },
] as const

for (const caso of FORMAS) {
  test(`mutar com ${caso.como}: o portão fecha por ${caso.motivo} e abre de novo ao desmutar`, async () => {
    const { call, peer } = await callComMicrofone(`mudo-${caso.forma}`)

    // Fase 1, aberto: o microfone é mesmo enviado (o outro lado recebe áudio dele).
    await call.waitForTimeout(FASE_MS)
    expect(await estadoDaPagina(call)).toMatchObject({ readyState: 'live', enabled: true, enviando: true })
    const micRms = (await peer.evaluate(() => (window as any).fixture.micRms)) as number
    expect(micRms, `o participante remoto recebeu ${micRms} de RMS do microfone`).toBeGreaterThan(0.01)

    // Fase 2, mudo de uma das quatro formas.
    const mudo = (await call.evaluate((f) => (window as any).fixture.mutar(f), caso.forma)) as PageState
    expect(mudo).toMatchObject(caso.mudo)
    await call.waitForTimeout(FASE_MS)

    // Fase 3, desmutado.
    const volta = (await call.evaluate((f) => (window as any).fixture.desmutar(f), caso.forma)) as PageState
    expect(volta).toMatchObject({ readyState: 'live', enabled: true, enviando: true })
    await call.waitForTimeout(FASE_MS)
    await call.click('button[jsname="CQylAd"]')

    const { file, files } = await falantesDaPasta()
    const mic = file.diagnostico?.microfone
    console.log(`${caso.como}: ${JSON.stringify(mic)}`)
    expect(mic, 'o diagnóstico do microfone tem de estar no falantes.json').toBeDefined()
    // Abriu no começo da gravação, fechou no mudo, abriu de novo ao desmutar, e no fim da call o PC
    // fecha (o fechamento do fim pode ou não caber antes de o controlador ver o fim).
    expect(mic!.abriu).toBe(2)
    expect(mic!.fechou).toBeGreaterThanOrEqual(1)
    expect(mic!.fechou).toBeLessThanOrEqual(2)
    expect(mic!.leituras).toBeGreaterThan(30)
    expect(mic!.segundosAberto).toBeGreaterThan(5)
    expect(mic!.segundosFechado).toBeGreaterThan(2)
    expect(mic!.faixasMax).toBeGreaterThanOrEqual(1)
    // O motivo é o da forma usada, e nenhum outro aparece.
    expect(mic!.motivos[caso.motivo], `motivo ${caso.motivo}`).toBeGreaterThan(8)
    conferirMotivos(mic!.motivos, [caso.motivo])
    // Nenhum arquivo novo: esta fatia não grava o microfone.
    expect(files).toEqual(['audio.webm', 'falantes.json', 'info.json'])
    expect(await fx(call, 'errors')).toEqual([])
    expect(await fx(call, 'unhandled')).toEqual([])
    expect(h!.pageErrors).toEqual([])
  })
}

test('com o portão aberto a call toda, nada do microfone entra na gravação (AC3) e a pasta não ganha arquivo', async () => {
  const { call, peer } = await callComMicrofone('mudo-nao-grava')
  await call.waitForTimeout(3 * FASE_MS)
  await call.click('button[jsname="CQylAd"]')

  const { file, dir, files } = await falantesDaPasta()
  const mic = file.diagnostico?.microfone
  expect(mic, 'o diagnóstico do microfone tem de estar no falantes.json').toBeDefined()
  // O portão abriu uma vez e ficou aberto até o fim da call (só o PC fechando no fim o fecha).
  expect(mic!.abriu).toBe(1)
  expect(mic!.fechou).toBeLessThanOrEqual(1)
  conferirMotivos(mic!.motivos, [])
  expect(mic!.segundosAberto).toBeGreaterThan(8)
  expect(mic!.segundosFechado).toBeLessThan(2)
  const micRms = (await peer.evaluate(() => (window as any).fixture.micRms)) as number
  expect(micRms, 'o microfone estava quente de verdade').toBeGreaterThan(0.01)

  // E a gravação continua só com o áudio do outro participante.
  expect(files).toEqual(['audio.webm', 'falantes.json', 'info.json'])
  const info = JSON.parse(readFileSync(join(dir, 'info.json'), 'utf8')) as { arquivos: Array<{ nome: string }> }
  expect(info.arquivos.map((a) => a.nome)).toEqual(['audio.webm'])
  const windows = measureWindows(decodePcm(join(dir, 'audio.webm')), [440, 1000]).slice(3, -1)
  const db440 = windows.map((w) => w.db[440])
  const db1000 = windows.map((w) => w.db[1000])
  console.log(`portão aberto: 440 Hz mediana ${median(db440).toFixed(1)} dBFS; 1000 Hz máx ${Math.max(...db1000).toFixed(1)} dBFS em ${windows.length} janelas`)
  expect(windows.length).toBeGreaterThanOrEqual(5)
  expect(median(db440)).toBeGreaterThan(-30)
  for (const w of windows) expect(w.db[1000], `segundo ${w.second}`).toBeLessThanOrEqual(w.db[440] - 30)
  expect(h!.pageErrors).toEqual([])
})
