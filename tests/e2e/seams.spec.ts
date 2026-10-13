// Seams "elements", "sources" e "output" e a arbitragem ponta a ponta (AC5, com AC3 e AC14 em
// cada seam novo). Meet falso com o receptor WebRTC mudo e o tom remoto (440 Hz) chegando por outro
// caminho; microfone falso de 1000 Hz mandado como envio; helper de verdade gravando numa raiz
// temporária. Cada teste confere o seam escolhido e as trocas no info.json, o tom no arquivo, o
// microfone pelo menos 30 dB abaixo e nenhum erro novo na página.
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { DELAY_SEC } from '../../src/main-world/capture/mixer'
import type { CaptureDiag, InfoJson, SeamId, SeamSwitch } from '../../src/shared/protocol'
import { decodePcm, goertzelDb, measureWindows, median, RATE, type WindowMeasure } from '../helpers/audio'
import { launchWithExtension, launchWithoutExtension, swApi, type Harness } from '../helpers/browser'
import { findRecordings } from '../helpers/recordings'
import { watchWebAudio, type AudioGraph } from '../helpers/webaudio'

interface Recorded {
  info: InfoJson
  /** Registro da sessão no IndexedDB do SW (trocas com hora em ms e o último diagnóstico). */
  record: SessionRow
  /** Diagnóstico da página lido antes de sair da call (o do fim já é depois de o PC fechar). */
  diag: CaptureDiag
  pcm: Float32Array
  windows: WindowMeasure[]
  call: Page
  peer: Page
  /** Erros da página da call e do console das abas de call (AC14). */
  errors: string[]
  graph: AudioGraph
  /** Tocador de PCM da página (variantes decoy e elemento-gerado): quando faltou amostra. */
  player: { faltas: number; faltasEm: number[] } | null
}

type SessionRow = { sessionId: string; startedAt: number; seamSwitches: SeamSwitch[]; diag: CaptureDiag | null }

let h: Harness | undefined

test.afterEach(async ({}, testInfo) => {
  if (h && testInfo.status !== testInfo.expectedStatus) {
    await testInfo.attach('console', { body: h.logs.join('\n'), contentType: 'text/plain' })
    console.log(h.logs.join('\n'))
  }
  await h?.close()
  h = undefined
})

/**
 * Grava uma variante do Meet falso com o participante `pcm` (tests/fixtures/peer/variantes/pcm.js).
 * `peerQuery` vai na URL do participante (trechos `pcm=` e `pcTom=`); `ms` conta a partir do
 * início da gravação.
 */
async function record(variant: string, room: string, peerQuery: string, ms: number): Promise<Recorded> {
  h = await launchWithExtension()
  const api = swApi(h.sw)
  const peer = await h.context.newPage()
  await peer.goto(`https://meet.google.com/__peer?tom=440&sala=${room}&variante=pcm&${peerQuery}`)
  await peer.click('#iniciar')
  await expect.poll(() => peer.evaluate(() => (window as any).fixture.state)).toBe('pronto')
  const call = await h.context.newPage()
  const pageErrors: string[] = []
  call.on('pageerror', (e) => pageErrors.push(`pageerror: ${e.message}`))
  const graph = await watchWebAudio(h.context, call)
  await call.goto(`https://meet.google.com/abc-defg-hij?variante=${variant}&sala=${room}`)
  await expect.poll(() => call.evaluate(() => (window as any).fixture.micLive)).toBe(true)
  await call.click('#participar')
  await expect.poll(() => call.evaluate(() => (window as any).fixture.pcState), { timeout: 15_000, intervals: [100] }).toBe('connected')
  await expect.poll(async () => (await api.activeRecordings()).length, { timeout: 10_000, intervals: [100] }).toBe(1)
  const [active] = await api.activeRecordings()
  await call.waitForTimeout(ms)
  const live = ((await api.listSessions()) as unknown as SessionRow[]).find((s) => s.sessionId === active.sessionId)
  expect(live?.diag, 'diagnóstico da página durante a gravação').toBeTruthy()
  const diag = live!.diag!
  const player = (await call.evaluate(() => (window as any).fixture.pcm ?? null)) as Recorded['player']
  await call.click('button[jsname="CQylAd"]')
  await expect.poll(() => findRecordings(h!.root).filter((r) => r.info).length, { timeout: 15_000, intervals: [250] }).toBe(1)
  const [rec] = findRecordings(h.root)
  const record = ((await api.listSessions()) as unknown as SessionRow[]).find((s) => s.sessionId === active.sessionId)!
  const pcm = decodePcm(join(rec.dir, 'audio.webm'))
  const fxErrors = (await call.evaluate(() => (window as any).fixture.errors)) as string[]
  const peerErrors = (await peer.evaluate(() => (window as any).fixture.errors)) as string[]
  return {
    info: rec.info!,
    record,
    diag,
    pcm,
    windows: measureWindows(pcm, [440, 1000]),
    call,
    peer,
    player,
    errors: [...pageErrors, ...fxErrors, ...peerErrors.map((e) => `participante: ${e}`), ...h.pageErrors.map((e) => `${e.kind}: ${e.text}`)],
    graph,
  }
}

/** Trocas do info.json sem a hora (a hora é conferida pelo registro, em ms). */
const switches = (info: InfoJson) => info.captura.trocas.map((t) => ({ de: t.de, para: t.para }))

/**
 * AC3 e presença do tom, janela a janela (1 s), de `from` até o penúltimo segundo: 440 Hz acima de
 * -20 dBFS e 1000 Hz pelo menos 30 dB abaixo dele.
 */
function expectRemoteOnly(r: Recorded, label: string, from = 3) {
  const windows = r.windows.slice(from, -1)
  expect(windows.length, `${label}: janelas`).toBeGreaterThanOrEqual(8)
  const db440 = windows.map((w) => w.db[440])
  const db1000 = windows.map((w) => w.db[1000])
  const line = `${label}: 440 Hz mediana ${median(db440).toFixed(1)} dBFS (mín ${Math.min(...db440).toFixed(1)}); 1000 Hz máx ${Math.max(...db1000).toFixed(1)} dBFS; menor distância ${Math.min(...windows.map((w) => w.db[440] - w.db[1000])).toFixed(1)} dB; ${windows.length} janelas`
  test.info().annotations.push({ type: 'audio', description: line })
  console.log(line)
  console.log(`${label}: por segundo (440/1000) ${windows.map((w) => `${w.second}:${w.db[440].toFixed(0)}/${w.db[1000].toFixed(0)}`).join(' ')}`)
  if (r.player) {
    // Diagnóstico de queda do tom: quadros que o tocador da página completou com zeros (o fluxo
    // do DataChannel atrasou), no segundo aproximado do arquivo (início da gravação mais o atraso
    // do mixer). Uma queda num segundo com falta é da página, não da gravação.
    const at = r.player.faltasEm.map((t) => ((t - r.record.startedAt) / 1000 + DELAY_SEC).toFixed(1))
    console.log(`${label}: faltas do tocador da página ${r.player.faltas} amostras em ${r.player.faltasEm.length} quadros; segundos do arquivo [${at.join(' ')}]`)
  }
  for (const w of windows) {
    expect(w.db[440], `${label}: 440 Hz no segundo ${w.second}`).toBeGreaterThan(-20)
    expect(w.db[1000], `${label}: 1000 Hz no segundo ${w.second}`).toBeLessThanOrEqual(w.db[440] - 30)
  }
}

/** Quadros curtos com o tom (true) ou sem (false), para medir começo e buracos com ~10 ms. */
function toneFrames(pcm: Float32Array, freq: number, frameMs = 10): { on: boolean[]; db: number[]; frameMs: number } {
  const len = Math.round((RATE * frameMs) / 1000)
  const winLen = len * 4
  const db: number[] = []
  for (let start = 0; start + winLen <= pcm.length; start += len) db.push(goertzelDb(pcm, start, winLen, freq))
  // Limiar: 12 dB abaixo do nível típico do tom (mediana dos quadros com som).
  const loud = db.filter((d) => d > -40)
  const level = loud.length ? median(loud) : -200
  return { on: db.map((d) => d > level - 12), db, frameMs }
}

/** Trechos contínuos com o tom: [início, fim) em ms. Buracos menores que `bridgeMs` não cortam. */
function toneRuns(frames: ReturnType<typeof toneFrames>, bridgeMs = 0): Array<{ from: number; to: number }> {
  const runs: Array<{ from: number; to: number }> = []
  frames.on.forEach((on, i) => {
    if (!on) return
    const t = i * frames.frameMs
    const last = runs.at(-1)
    if (last && t - last.to <= bridgeMs) last.to = t + frames.frameMs
    else runs.push({ from: t, to: t + frames.frameMs })
  })
  return runs
}

function expectCleanPage(r: Recorded) {
  expect(r.errors, 'erros da página, do participante e do console das abas de call').toEqual([])
}

function expectSwitch(r: Recorded, to: SeamId) {
  expect(r.info.captura.fonteInicial).toBe('receivers')
  expect(r.info.captura.fonteFinal).toBe(to)
  expect(switches(r.info)).toEqual([{ de: 'receivers', para: to }])
  expect(r.info.captura.teveAudio).toBe(true)
  const sw = r.record.seamSwitches.filter((s) => s.from !== null)
  expect(sw).toHaveLength(1)
  return sw[0]
}

test.describe('seams', () => {
  test('decoy: receptor mudo e tom pelo DataChannel tocado por createMediaStreamSource vai para "sources"', async () => {
    const r = await record('decoy', 'decoy', 'pcm=0-', 14_000)
    expectCleanPage(r)
    const sw = expectSwitch(r, 'sources')
    // A fonte padrão veio muda desde o começo: troca em até 2 s do início da gravação (AC5).
    const after = sw.at - r.record.startedAt
    console.log(`decoy: troca receivers -> sources ${after} ms depois do início`)
    expect(after).toBeLessThanOrEqual(2000)
    // Os outros caminhos do tom também foram vistos, e o elemento mudo também.
    expect(r.diag.seams.sources.sources).toBe(1)
    expect(r.diag.seams.output.sources).toBe(1)
    expect(r.diag.seams.elements).toMatchObject({ sources: 1, speech: false })
    expect(r.diag.seams.receivers).toMatchObject({ sources: 1, speech: false })
    expectRemoteOnly(r, 'decoy')
  })

  test('elemento-gerado: gerador -> MediaStreamDestination -> <audio> no body (formato do Teams WASM) vai para "elements"', async () => {
    const r = await record('elemento-gerado', 'elemento', 'pcm=0-', 14_000)
    expectCleanPage(r)
    const sw = expectSwitch(r, 'elements')
    const after = sw.at - r.record.startedAt
    console.log(`elemento-gerado: troca receivers -> elements ${after} ms depois do início`)
    expect(after).toBeLessThanOrEqual(2000)
    // O tom não passou por createMediaStreamSource nem pelo destination: só "elements" o tem.
    expect(r.diag.seams.sources.sources).toBe(0)
    expect(r.diag.seams.output.sources).toBe(0)
    expect(r.diag.seams.elements).toMatchObject({ sources: 1, speech: true })
    expectRemoteOnly(r, 'elemento-gerado')
  })

  test('saida: tom só por AudioBufferSourceNode -> GainNode -> destination vai para "output" pelo tee', async () => {
    const r = await record('saida', 'saida', 'pcm=', 14_000)
    expectCleanPage(r)
    const sw = expectSwitch(r, 'output')
    const after = sw.at - r.record.startedAt
    console.log(`saida: troca receivers -> output ${after} ms depois do início`)
    expect(after).toBeLessThanOrEqual(2000)
    expect(r.diag.seams.sources.sources).toBe(0)
    expect(r.diag.seams.output).toMatchObject({ sources: 1, speech: true })
    expectRemoteOnly(r, 'saida')
    // Regra 4: o tee nunca vai para o alto-falante. No contexto da página, a única ligação no
    // AudioDestination é a do GainNode dela; no mixer, nenhuma.
    const mixers = r.graph.mixerContexts()
    expect(mixers.length).toBeGreaterThanOrEqual(1)
    for (const id of mixers) expect(r.graph.edgesIntoSpeaker(id)).toEqual([])
    const pageContexts = r.graph.contexts().filter((id) => !mixers.includes(id) && r.graph.edgesIntoSpeaker(id).length > 0)
    expect(pageContexts).toHaveLength(1)
    expect(r.graph.edgesIntoSpeaker(pageContexts[0]).map((e) => e.fromType)).toEqual(['Gain'])
  })

  test('mic-local: o microfone tocado por <audio>, createMediaStreamSource e destination nunca entra em seam nenhum', async () => {
    const r = await record('mic-local', 'mic-local', 'pcm=', 14_000)
    expectCleanPage(r)
    // O microfone tem som de verdade na página (senão o teste não provaria nada): bem acima do
    // limiar de fala da arbitragem (-55 dBFS), então qualquer seam que o deixasse entrar o
    // escolheria. Medido: ~-28 dBFS (o getUserMedia padrão processa o tom de 1000 Hz).
    const micDb = (await r.call.evaluate(() => (window as any).fixture.micDb)) as number[]
    expect(micDb.length).toBeGreaterThan(5)
    console.log(`mic-local: microfone na página, mediana ${median(micDb).toFixed(1)} dBFS`)
    expect(median(micDb), 'energia do microfone medida pela página').toBeGreaterThan(-45)
    expect(await r.call.evaluate(() => ['mic-elemento', 'mic-processado'].map((id) => !(document.getElementById(id) as HTMLAudioElement).paused))).toEqual([true, true])
    // Nenhuma fonte local em elements nem em sources; output só com o tom (o microfone ligado no
    // destination, direto ou por um ganho, ficou sem tee).
    expect(r.diag.seams.elements.sources).toBe(0)
    expect(r.diag.seams.sources.sources).toBe(0)
    expect(r.diag.seams.output).toMatchObject({ sources: 1, speech: true })
    expectSwitch(r, 'output')
    expectRemoteOnly(r, 'mic-local')
  })

  test('começo da fala: tom que começa com a gravação em silêncio não perde o começo na troca de seam', async () => {
    // Receptor mudo o tempo todo; pelo DataChannel, 9 s de zeros, 2 s de tom, 2 s de zeros e tom
    // até o fim. A gravação começa de 1 a 3 s depois do DataChannel abrir (desde a 0.3.1, mais
    // perto de 1 s), então o primeiro trecho de tom chega com "receivers" selecionado e a troca para
    // "sources" acontece no meio dele. 18 s de gravação deixam pelo menos 3 janelas inteiras depois
    // do segundo trecho, qualquer que seja esse começo.
    const r = await record('decoy', 'comeco', 'pcm=9000-11000,13000-', 18_000)
    expectCleanPage(r)
    const sw = expectSwitch(r, 'sources')
    const marks = (await r.peer.evaluate(() => (window as any).fixture.marcos)) as { pcm: Array<{ deEm: number; ateEm: number | null }> }
    const onset = marks.pcm[0].deEm
    expect(onset, 'o tom começou depois do início da gravação').toBeGreaterThan(r.record.startedAt + 2000)
    const latency = sw.at - onset
    const frames = toneFrames(r.pcm, 440)
    const runs = toneRuns(frames, 30)
    const first = runs[0]
    const burst = first.to - first.from
    const lost = 2000 - burst
    const line = `começo: troca ${latency} ms depois do tom começar no participante; primeiro trecho de tom no arquivo em ${(first.from / 1000).toFixed(2)} s com ${burst} ms (esperado 2000; perdeu ${lost} ms); ${runs.length} trechos`
    test.info().annotations.push({ type: 'audio', description: line })
    console.log(line)
    // Até 2 s para trocar (AC5) e o começo preservado pela linha de atraso.
    expect(latency).toBeLessThanOrEqual(2000)
    expect(first.from, 'antes do tom, silêncio desde o começo do arquivo').toBeGreaterThan(3000)
    // A troca acontece em ~250 ms (um laço), e o tom já chega à página atrasado pelo DataChannel,
    // então sem a linha de atraso o arquivo perderia só ~60 ms (medido com DELAY_SEC 0,001: 1940 ms
    // no trecho). Com ela, nada (medido: 2010 ms; a janela de 40 ms da medida estica o trecho um
    // pouco). O limite fica entre os dois.
    expect(lost, `trecho de ${burst} ms`).toBeLessThanOrEqual(30)
    expect(burst, 'o trecho não emendou com o seguinte').toBeLessThan(2400)
    // Depois do primeiro trecho: 2 s de silêncio e o tom de novo, contínuo.
    expect(runs[1].from - first.to).toBeGreaterThan(1500)
    expect(runs.length).toBe(2)
    const tail = r.windows.slice(Math.ceil(runs[1].from / 1000) + 1, -1)
    expect(tail.length).toBeGreaterThanOrEqual(3)
    for (const w of tail) expect(w.db[1000], `segundo ${w.second}`).toBeLessThanOrEqual(w.db[440] - 30)
  })

  test('passagem: a plataforma muda o caminho no meio da call e o arquivo não tem buraco maior que 300 ms', async () => {
    // O tom vem pelo PC nos primeiros 12 s depois do DataChannel abrir e então passa para o
    // DataChannel (o Teams trocando o <audio> para o decodificador WASM, por exemplo). A troca só
    // pode acontecer 1 s depois de o receptor calar, então sem a linha de atraso (e sem o seletor
    // agendado para o instante em que o antigo calou) esse segundo sumiria do arquivo.
    const r = await record('decoy', 'passagem', 'pcTom=0-12000&pcm=12000-', 16_000)
    expectCleanPage(r)
    const sw = expectSwitch(r, 'sources')
    const marks = (await r.peer.evaluate(() => (window as any).fixture.marcos)) as { pc: Array<{ ateEm: number }> }
    const silentAt = marks.pc[0].ateEm
    const latency = sw.at - silentAt
    const frames = toneFrames(r.pcm, 440)
    const runs = toneRuns(frames)
    const firstOn = runs[0].from
    const lastOn = runs.at(-1)!.to
    let worst = 0
    for (let i = 1; i < runs.length; i++) worst = Math.max(worst, runs[i].from - runs[i - 1].to)
    const line = `passagem: troca ${latency} ms depois de o receptor calar; tom de ${(firstOn / 1000).toFixed(2)} s a ${(lastOn / 1000).toFixed(2)} s; maior buraco ${worst} ms em ${runs.length} trechos`
    test.info().annotations.push({ type: 'audio', description: line })
    console.log(line)
    expect(latency).toBeGreaterThanOrEqual(900)
    expect(latency).toBeLessThanOrEqual(2000)
    expect(worst, 'maior buraco no tom').toBeLessThanOrEqual(300)
    expectRemoteOnly(r, 'passagem')
  })

  test('custo e memória do connect: 12 mil pedaços tocados não ficam presos nem deixam o connect mais lento (AC14)', async () => {
    // O formato de quem decodifica em JS/WASM e toca cada pedaço num AudioBufferSourceNode: 12 lotes
    // de 1000 pedaços curtos, ligados num GainNode que vive a página inteira e direto no
    // destination. Mede, na própria página, quanto o lote de connect custa e quantos pedaços já
    // tocados sobrevivem ao coletor (CDP HeapProfiler.collectGarbage), com e sem a extensão.
    const measure = async (context: import('@playwright/test').BrowserContext) => {
      const page = await context.newPage()
      await page.goto('https://meet.google.com/abc-defg-hij?variante=integridade&sala=custo')
      // Clique de verdade: o AudioContext precisa rodar para os pedaços tocarem até o fim.
      await page.mouse.click(5, 5)
      const result: Record<string, { ms: number[]; vivos: number }> = {}
      const cdp = await context.newCDPSession(page)
      for (const alvo of ['ganho', 'destination'] as const) {
        const ms = (await page.evaluate(async (alvo) => {
          const w = window as any
          const ctx: AudioContext = w.__custoCtx ?? (w.__custoCtx = new AudioContext())
          await ctx.resume()
          const g = ctx.createGain()
          g.gain.value = 0
          g.connect(ctx.destination)
          const buf = ctx.createBuffer(1, 128, ctx.sampleRate)
          w.__vivos = []
          const out: number[] = []
          for (let lote = 0; lote < 12; lote++) {
            const nodes: AudioBufferSourceNode[] = []
            for (let i = 0; i < 1000; i++) {
              const s = ctx.createBufferSource()
              s.buffer = buf
              nodes.push(s)
            }
            const t0 = performance.now()
            for (const s of nodes) s.connect(alvo === 'ganho' ? g : ctx.destination)
            out.push(performance.now() - t0)
            for (const s of nodes) {
              s.start()
              w.__vivos.push(new WeakRef(s))
            }
            // Um respiro entre lotes, como os pedaços chegando ao longo do tempo.
            await new Promise((r) => setTimeout(r, 20))
          }
          return out
        }, alvo)) as number[]
        await page.waitForTimeout(500)
        for (let i = 0; i < 6; i++) {
          await cdp.send('HeapProfiler.collectGarbage')
          await page.waitForTimeout(100)
        }
        const vivos = (await page.evaluate(() => ((window as any).__vivos as WeakRef<object>[]).filter((r) => r.deref()).length)) as number
        result[alvo] = { ms, vivos }
      }
      await page.close()
      return result
    }
    const plain = await launchWithoutExtension()
    let sem: Awaited<ReturnType<typeof measure>>
    try {
      sem = await measure(plain.context)
    } finally {
      await plain.close()
    }
    h = await launchWithExtension()
    const com = await measure(h.context)
    const fmt = (ms: number[]) => ms.map((m) => m.toFixed(0)).join(' ')
    for (const alvo of ['ganho', 'destination'] as const) {
      const line = `custo do connect (${alvo}): ms por 1000, sem [${fmt(sem[alvo].ms)}], com [${fmt(com[alvo].ms)}]; pedaços vivos depois do coletor: sem ${sem[alvo].vivos}, com ${com[alvo].vivos} de 12000`
      test.info().annotations.push({ type: 'custo', description: line })
      console.log(line)
    }
    for (const alvo of ['ganho', 'destination'] as const) {
      // O controle prova que o coletor leva os pedaços; com a extensão, o mesmo.
      expect(sem[alvo].vivos, `sem a extensão (${alvo})`).toBe(0)
      expect(com[alvo].vivos, `pedaços presos pela extensão (${alvo})`).toBe(0)
      // O custo não cresce com o que já foi ligado: nenhuma mediana móvel de 3 lotes passa do dobro
      // da dos 3 primeiros (mais 5 ms de folga para o ruído de uma máquina carregada). O coletor
      // poda as entradas de tempos em tempos, então só o pico mostra o crescimento entre podas.
      const ms = com[alvo].ms
      const first = median(ms.slice(0, 3))
      const peak = Math.max(...ms.slice(2).map((_, i) => median(ms.slice(i, i + 3))))
      expect(peak, `${alvo}: pior trecho ${peak.toFixed(1)} ms contra ${first.toFixed(1)} ms nos primeiros`).toBeLessThanOrEqual(2 * first + 5)
      // E o connect embrulhado custa da mesma ordem que o nativo: o tee é um connect a mais, o
      // resto é O(1). Medido: 1 ms sem e 1-4 ms com, a cada 1000; a versão que refazia tudo a cada
      // connect passava de 40 ms já no primeiro lote.
      const base = median(sem[alvo].ms)
      expect(median(ms), `${alvo}: com a extensão contra ${base.toFixed(1)} ms sem`).toBeLessThanOrEqual(5 * base + 5)
    }
    expect(h.pageErrors).toEqual([])
  })

  test('integridade dos embrulhos novos: srcObject, createMediaStreamSource e connect/disconnect devolvem o mesmo com e sem a extensão', async () => {
    const read = async (context: import('@playwright/test').BrowserContext) => {
      const page = await context.newPage()
      await page.goto('https://meet.google.com/abc-defg-hij?variante=integridade&sala=retornos')
      return page.evaluate(() => (window as any).fixture.retornosAudio())
    }
    const plain = await launchWithoutExtension()
    let sem: Record<string, unknown>
    try {
      sem = await read(plain.context)
    } finally {
      await plain.close()
    }
    h = await launchWithExtension()
    const com = await read(h.context)
    console.log(`retornos dos embrulhos dos seams: ${JSON.stringify(com)}`)
    expect(sem).toEqual({
      createMediaStreamSourceDevolveNo: true,
      connectDevolveDestino: true,
      connectNoDestinationDevolveDestination: true,
      connectParamDevolveUndefined: true,
      disconnectNoDevolveUndefined: true,
      disconnectDevolveUndefined: true,
      connectOutroContexto: 'InvalidAccessError',
      connectSaidaInvalida: 'IndexSizeError',
      disconnectNaoLigado: 'InvalidAccessError',
      disconnectSaidaInvalida: 'IndexSizeError',
      srcObjectDevolveOMesmo: true,
      srcObjectNulo: true,
      srcObjectInvalido: 'TypeError',
    })
    expect(com).toEqual(sem)
    expect(h.pageErrors).toEqual([])
  })
})
