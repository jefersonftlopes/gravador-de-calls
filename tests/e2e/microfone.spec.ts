// A gravação da própria voz (Emenda 25) num Chrome de verdade, MEDIDA em dBFS no arquivo gerado.
//
// O microfone falso toca um tom de 1000 Hz e o outro participante um de 440 Hz. Com o recurso
// LIGADO no perfil, a pasta da call ganha `audio-microfone.webm`, e é nele que se mede:
//
// - as QUATRO formas de mutar (track.enabled, track.stop(), sender.replaceTrack(null),
//   pc.removeTrack): o trecho mudo fica em SILÊNCIO e os trechos abertos têm o tom;
// - o caso da faixa processada (a página envia uma faixa derivada, e a do getUserMedia não está em
//   sender nenhum): o portão fica fechado a call toda e NENHUM arquivo é gravado;
// - com o recurso DESLIGADO (o padrão): nenhum arquivo, nenhum getUserMedia, nenhuma permissão.
//
// Por que o silêncio e não o corte: o gravador fica rodando e o NÓ é desligado (não há GainNode no
// caminho), então o arquivo tem a mesma base de tempo do audio.webm da call e a linha do tempo dos
// falantes continua limpa. O atraso de MIXER_DELAY_MS antes do portão é o mesmo do mixer da call: a
// troca vale para o áudio de trás, então nada do trecho mudo chega ao gravador (ver micEdgeWaitMs em
// src/shared/mic-route.ts).
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { decodePcm, measureWindows } from '../helpers/audio'
import { launchWithExtension, seedMicPermission, swApi, type Harness } from '../helpers/browser'
import { installMeetRosterRoute } from '../fixtures/meet/roster'
import { dcrpcMessage, dcrpcRecord } from '../helpers/protobuf'
import { findRecordings } from '../helpers/recordings'
import type { InfoJson, MicOffscreenState, SpeakersFile } from '../../src/shared/protocol'

const ANA = 'spaces/sala1/devices/2'
const EU = 'spaces/sala1/devices/1'
/** Quanto tempo em cada fase (aberto, mudo, aberto de novo). */
const FASE_MS = 6000
/** O arquivo da voz (src/shared/constants.ts, MIC_FILE). */
const MIC_FILE = 'audio-microfone.webm'

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
const estadoDaPagina = (page: Page) => page.evaluate(() => (window as any).fixture.estado())

const micState = (hh: Harness) =>
  hh.sw.evaluate(() =>
    (globalThis as unknown as { __gravador: { sendToOffscreen(r: unknown): Promise<unknown> } }).__gravador.sendToOffscreen({
      target: 'offscreen',
      t: 'offscreen:mic-state',
    }),
  ) as Promise<MicOffscreenState>

interface CallOpts {
  sala: string
  variante: string
  /** Liga o recurso no perfil (o padrão do produto é desligado). */
  micRecording?: boolean
  /** Sem helper, com a pasta de downloads de verdade (o outro destino). */
  downloads?: boolean
}

/**
 * Sobe uma call do Meet falsa com o microfone enviado ao PC e a Ana falando pelo 'dcrpc'. A
 * permissão do microfone é concedida para a origem da extensão em TODOS os casos, inclusive no do
 * recurso desligado: ali ela mostra que, mesmo podendo, nada é pedido nem gravado.
 */
async function abrirCall(opts: CallOpts): Promise<{ call: Page; peer: Page }> {
  h = await launchWithExtension({
    settings: { minSeconds: 5, ...(opts.micRecording ? { micRecording: true } : {}) },
    beforeLaunch: ({ userDataDir }) => seedMicPermission(userDataDir),
    ...(opts.downloads ? { downloads: true, installHost: false } : {}),
    routes: (context) =>
      installMeetRosterRoute(context, [
        { deviceId: EU, name: 'Alex Lima', self: true },
        { deviceId: ANA, name: 'Ana Souza' },
      ]),
  })
  const peer = await h.context.newPage()
  await peer.goto(`https://meet.google.com/__peer?variante=canais&tom=440&sala=${opts.sala}`)
  await peer.click('#iniciar')
  await expect.poll(() => peer.evaluate(() => (window as any).fixture.state)).toBe('pronto')
  const call = await h.context.newPage()
  await call.goto(`https://meet.google.com/abc-defg-hij?variante=${opts.variante}&sala=${opts.sala}`)
  await expect.poll(() => fx(call, 'micPronto')).toBe(true)
  await call.click('#participar')
  await expect.poll(() => fx(call, 'pcState'), { timeout: 15_000, intervals: [100] }).toBe('connected')
  await expect.poll(() => peer.evaluate(() => (window as any).peer.canais()), { timeout: 10_000 }).toEqual([['dcrpc', 'open']])
  await expect.poll(() => fx(call, 'rosterBuscada')).toBe(true)
  const snapshot = Buffer.from(dcrpcMessage([dcrpcRecord(ANA, true)])).toString('base64')
  await expect.poll(async () => (await swApi(h!.sw).activeRecordings()).length, { timeout: 15_000, intervals: [100] }).toBeGreaterThanOrEqual(1)
  await peer.evaluate((d) => (window as any).peer.enviar('dcrpc', { b64: d }), snapshot)
  return { call, peer }
}

/**
 * Espera a pasta da call com o info.json e, com `aguardar`, também aquele arquivo: a sessão
 * pareada (o microfone) salva DEPOIS da de página, e o info.json dela é reescrito ali.
 */
async function pastaDaCall(base = h!.root, aguardar?: string): Promise<{ dir: string; files: string[]; info: InfoJson; falantes: SpeakersFile | null }> {
  await expect
    .poll(
      () => {
        const achadas = findRecordings(base).filter((r) => r.info)
        if (achadas.length !== 1) return 0
        // O info.json é reescrito DEPOIS do áudio: esperar os dois evita ler no meio do caminho.
        const pronto = !aguardar || (achadas[0].files.includes(aguardar) && achadas[0].info!.arquivos.some((a) => a.nome === aguardar))
        return pronto ? 1 : 0
      },
      { timeout: 30_000, intervals: [250] },
    )
    .toBe(1)
  const [rec] = findRecordings(base)
  const falantesPath = join(rec.dir, 'falantes.json')
  return {
    dir: rec.dir,
    files: rec.files,
    info: rec.info!,
    falantes: existsSync(falantesPath) ? (JSON.parse(readFileSync(falantesPath, 'utf8')) as SpeakersFile) : null,
  }
}

/**
 * Espera TODA sessão deste perfil terminar (salva ou descartada). Sem isto, um teste que afirma
 * "nenhum arquivo do microfone" poderia ler a pasta antes de a sessão do microfone salvar, e
 * passaria sem provar nada (a sessão pareada salva DEPOIS da de página).
 */
async function todasEncerradas(): Promise<Array<{ sessionId: string; status: string }>> {
  await expect
    .poll(async () => (await swApi(h!.sw).listSessions()).every((r) => r.status === 'salva' || r.status === 'descartada'), {
      timeout: 30_000,
      intervals: [250],
    })
    .toBe(true)
  return swApi(h!.sw).listSessions()
}

/** Acima disto a janela TEM o tom do microfone; abaixo de SILENCIO_DBFS ela está em silêncio. */
const TOM_DBFS = -40
const SILENCIO_DBFS = -60

interface Trecho {
  tom: boolean
  janelas: number[]
}

/**
 * As janelas de 1 s do arquivo do microfone, agrupadas em trechos "com tom" e "sem tom". É a forma
 * de medir que não depende de casar o relógio do teste com o do gravador: o que se cobra é a FORMA
 * (abriu, fechou, abriu) e que o trecho fechado esteja mesmo em silêncio.
 */
function trechos(file: string): { trechos: Trecho[]; db: number[] } {
  const db = measureWindows(decodePcm(file), [1000]).map((w) => w.db[1000])
  const out: Trecho[] = []
  for (const [i, v] of db.entries()) {
    const tom = v > TOM_DBFS
    // A janela de borda (a troca cai no meio dela) não entra em nenhum trecho.
    if (!tom && v > SILENCIO_DBFS) continue
    const last = out.at(-1)
    if (last && last.tom === tom) last.janelas.push(i)
    else out.push({ tom, janelas: [i] })
  }
  return { trechos: out, db }
}

const mostrar = (db: number[]) => db.map((v) => v.toFixed(0)).join(' ')

/** As quatro formas de mutar, como na Emenda 24 (tests/e2e/mudo.spec.ts). */
const FORMAS = [
  { forma: 'enabled', como: 'track.enabled = false', motivo: 'enabled' },
  { forma: 'stop', como: 'track.stop()', motivo: 'readyState' },
  { forma: 'replace', como: 'sender.replaceTrack(null)', motivo: 'semSender' },
  { forma: 'remove', como: 'pc.removeTrack(sender)', motivo: 'semSender' },
] as const

for (const caso of FORMAS) {
  test(`mutar com ${caso.como}: o trecho mudo fica em silêncio no ${MIC_FILE} e os abertos têm o tom`, async () => {
    const { call } = await abrirCall({ sala: `mic-${caso.forma}`, variante: 'mudo', micRecording: true })

    await call.waitForTimeout(FASE_MS)
    expect(await estadoDaPagina(call)).toMatchObject({ readyState: 'live', enabled: true, enviando: true })
    await expect.poll(async () => (await micState(h!)).ligadas.length, { timeout: 10_000 }).toBe(1)

    await call.evaluate((f) => (window as any).fixture.mutar(f), caso.forma)
    await expect.poll(async () => (await micState(h!)).ligadas.length, { timeout: 10_000 }).toBe(0)
    await call.waitForTimeout(FASE_MS)

    await call.evaluate((f) => (window as any).fixture.desmutar(f), caso.forma)
    await expect.poll(async () => (await micState(h!)).ligadas.length, { timeout: 10_000 }).toBe(1)
    await call.waitForTimeout(FASE_MS)
    await call.click('button[jsname="CQylAd"]')

    const { dir, files, info, falantes } = await pastaDaCall(h!.root, MIC_FILE)
    expect(files).toEqual(['audio-microfone.webm', 'audio.webm', 'falantes.json', 'info.json'])
    // O arquivo é separado e está no info.json, com o desvio em relação ao audio.webm.
    const mic = info.arquivos.find((a) => a.nome === MIC_FILE)
    expect(mic, 'o audio-microfone.webm tem de estar no info.json').toBeDefined()
    expect(mic!.tipo).toBe('microfone')
    expect(mic!.formato).toBe('audio/webm;codecs=opus')
    expect(mic!.kbps).toBe(32)
    expect(typeof mic!.desvioMs).toBe('number')
    expect(mic!.desvioMs!).toBeLessThan(5000)

    const { trechos: ts, db } = trechos(join(dir, MIC_FILE))
    console.log(`${caso.como}: 1000 Hz por segundo no ${MIC_FILE}: ${mostrar(db)}`)
    console.log(`${caso.como}: trechos ${ts.map((t) => `${t.tom ? 'tom' : 'silêncio'}x${t.janelas.length}`).join(' ')} | desvio ${mic!.desvioMs} ms`)
    // A forma: silêncio do atraso, tom, silêncio do mudo, tom (e o silêncio do fim, se couber).
    const comTom = ts.filter((t) => t.tom)
    expect(comTom.length, 'dois trechos com o tom (antes e depois do mudo)').toBe(2)
    for (const t of comTom) expect(t.janelas.length, 'cada trecho aberto dura alguns segundos').toBeGreaterThanOrEqual(3)
    // O trecho mudo, entre os dois, está em SILÊNCIO: é a prova em dBFS.
    const meio = ts.findIndex((t) => t.tom)
    const mudo = ts[meio + 1]
    expect(mudo?.tom).toBe(false)
    expect(mudo!.janelas.length, 'o trecho mudo dura alguns segundos').toBeGreaterThanOrEqual(3)
    for (const j of mudo!.janelas) expect(db[j], `segundo ${j} do trecho mudo`).toBeLessThanOrEqual(SILENCIO_DBFS)

    // E o portão foi medido como a Emenda 24 manda.
    const diag = falantes?.diagnostico?.microfone
    expect(diag, 'o diagnóstico do microfone continua no falantes.json').toBeDefined()
    console.log(`${caso.como}: diagnóstico ${JSON.stringify(diag)}`)
    expect(diag!.abriu).toBe(2)
    expect(diag!.motivos[caso.motivo]).toBeGreaterThan(8)

    expect(await fx(call, 'errors')).toEqual([])
    expect(await fx(call, 'unhandled')).toEqual([])
    expect(h!.pageErrors).toEqual([])
  })
}

test('faixa processada: a do getUserMedia não está em sender nenhum, e nada é gravado', async () => {
  const { call } = await abrirCall({ sala: 'mic-processado', variante: 'mic-processado', micRecording: true })
  // A página envia a faixa DERIVADA, não a do getUserMedia.
  expect(await estadoDaPagina(call)).toMatchObject({ readyState: 'live', enabled: true, enviando: false, enviandoDerivada: true })
  await call.waitForTimeout(2 * FASE_MS)

  // O portão nunca abriu: o microfone nem foi aberto.
  const estado = await micState(h!)
  console.log(`faixa processada: offscreen ${JSON.stringify(estado)}`)
  expect(estado.ligadas).toEqual([])
  expect(estado.jaLigadas).toEqual([])
  expect(estado.capturando, 'o getUserMedia do offscreen nem foi chamado').toBe(false)
  await call.click('button[jsname="CQylAd"]')

  // Toda sessão encerrada: a do microfone foi DESCARTADA (o portão nunca abriu).
  const sessoes = await todasEncerradas()
  console.log(`faixa processada: sessões ${sessoes.map((r) => r.status).sort().join(' ')}`)
  expect(sessoes.filter((r) => r.status === 'descartada').length, 'a sessão do microfone é descartada').toBe(1)
  const { files, info, falantes } = await pastaDaCall()
  // Nenhum arquivo do microfone: é a prova de que nada foi gravado.
  expect(files).toEqual(['audio.webm', 'falantes.json', 'info.json'])
  expect(info.arquivos.map((a) => a.nome)).toEqual(['audio.webm'])
  const diag = falantes?.diagnostico?.microfone
  console.log(`faixa processada: diagnóstico ${JSON.stringify(diag)}`)
  expect(diag!.abriu).toBe(0)
  expect(diag!.motivos.semSender).toBeGreaterThan(20)
  expect(h!.pageErrors).toEqual([])
})

test('com o recurso desligado (o padrão): nenhum arquivo, nenhum getUserMedia, nenhuma permissão pedida', async () => {
  // A permissão está CONCEDIDA neste perfil (o teste a semeia): o que impede a gravação é só a
  // escolha do usuário estar desligada, que é o padrão.
  const { call } = await abrirCall({ sala: 'mic-desligado', variante: 'mudo' })
  await call.waitForTimeout(FASE_MS)
  const estado = await micState(h!)
  console.log(`desligado: offscreen ${JSON.stringify(estado)}`)
  // Nenhum gravador preparado (o mic-start nem foi mandado), nenhuma captura, e `erro` nulo: não
  // houve getUserMedia nenhum, nem com sucesso nem com falha.
  expect(estado.abas).toEqual([])
  expect(estado.ligadas).toEqual([])
  expect(estado.capturando).toBe(false)
  expect(estado.erro).toBeNull()

  await call.click('button[jsname="CQylAd"]')
  // Uma sessão só (a da página): nenhuma de microfone foi criada.
  expect((await todasEncerradas()).length).toBe(1)
  const { files, info } = await pastaDaCall()
  expect(files).toEqual(['audio.webm', 'falantes.json', 'info.json'])
  expect(info.arquivos.map((a) => a.nome)).toEqual(['audio.webm'])
  // E o SW nem falou de microfone.
  expect(h!.logs.filter((l) => l.includes('[gravador sw microfone]'))).toEqual([])
  expect(h!.logs.filter((l) => l.includes('[gravador microfone]'))).toEqual([])
  expect(h!.pageErrors).toEqual([])
})

test('sem helper: o arquivo da voz entra na pasta da call em Downloads, com o audio.webm', async () => {
  const { call } = await abrirCall({ sala: 'mic-downloads', variante: 'mudo', micRecording: true, downloads: true })
  expect((await swApi(h!.sw).pingHost(true)).ok, 'este teste é o destino downloads').toBe(false)
  await expect.poll(async () => (await micState(h!)).ligadas.length, { timeout: 15_000 }).toBe(1)
  await call.waitForTimeout(2 * FASE_MS)
  await call.click('button[jsname="CQylAd"]')

  // A reserva do AC9: Downloads/<pasta das gravações>/AAAA-MM/<pasta da call>/.
  const rec = await pastaDaCall(join(h!.downloadsDir!, 'Gravações de calls'), MIC_FILE)
  console.log(`downloads: ${rec.files.join(' ')}`)
  expect(rec.files).toEqual(['audio-microfone.webm', 'audio.webm', 'falantes.json', 'info.json'])
  expect(rec.info.arquivos.map((a) => a.nome).sort()).toEqual(['audio-microfone.webm', 'audio.webm'])
  const db = measureWindows(decodePcm(join(rec.dir, MIC_FILE)), [1000]).map((w) => w.db[1000])
  console.log(`downloads: 1000 Hz por segundo no ${MIC_FILE}: ${db.map((v) => v.toFixed(0)).join(' ')}`)
  expect(db.filter((v) => v > TOM_DBFS).length, 'o tom do microfone está no arquivo').toBeGreaterThanOrEqual(5)
  expect(h!.pageErrors).toEqual([])
})
