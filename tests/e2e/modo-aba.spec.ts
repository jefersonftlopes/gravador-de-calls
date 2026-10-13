// Modo aba (AC12) ponta a ponta: chrome.tabCapture no SW, getUserMedia da aba no offscreen,
// som devolvido aos alto-falantes e gravação mono em audio-aba.webm.
//
// O Chrome sobe com `LaunchOptions.tabCapture` (tests/helpers/browser.ts, Emenda 7): sem
// `--mute-audio` (a captura da aba chegaria em silêncio: RMS 0,000 contra 0,709 sem ela, tom de
// 523 Hz a 1,0), sem `--use-fake-ui-for-media-stream` (o getUserMedia de chromeMediaSource 'tab'
// falharia com "Requested device not found"), com `--auto-accept-camera-and-microphone-capture`,
// `--disable-audio-output` (nada sai nos alto-falantes da máquina) e `--allowlisted-extension-id`
// (o getMediaStreamId não pede gesto). O gatilho é o de teste `toggleTabCapture(tabId)`, o mesmo
// toggle pelo caminho do popup (ui:tab-capture), ou o botão do popup de verdade.
import { execFileSync } from 'node:child_process'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type BrowserContext, type CDPSession, type Page } from '@playwright/test'
import { decodePcm, measureWindows, median, RATE, type WindowMeasure } from '../helpers/audio'
import {
  EXTENSION_ID,
  currentServiceWorker,
  launchWithExtension,
  stopExtensionServiceWorker,
  swApi,
  type Harness,
  type LaunchOptions,
} from '../helpers/browser'
import { FFMPEG } from '../helpers/paths'
import { findRecordings, stagingEntries, type FoundRecording } from '../helpers/recordings'

const TONE_PATH = '/__tom'
/** Página de outro site (fora dos hosts do manifesto): o caso de uso real do plano B. */
const OTHER_HOST = 'https://outro-site.test'

/**
 * Página que toca um tom pelo AudioContext dela (saída da aba, como qualquer site faz). Sem
 * innerHTML: a rota usa o mesmo CSP de Trusted Types das calls.
 */
function tonePage(): string {
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><title>Tom de teste</title></head>
<body>
<button id="tocar">Tocar</button>
<script>
(() => {
  const q = new URLSearchParams(location.search);
  const freq = Number(q.get('tom')) || 523;
  document.title = q.get('titulo') || ('Tom de ' + freq + ' Hz');
  const fx = window.fixture = { state: 'parado', ctxState: 'none' };
  document.getElementById('tocar').addEventListener('click', () => {
    const ac = new AudioContext();
    const osc = new OscillatorNode(ac, { frequency: freq });
    const gain = new GainNode(ac, { gain: 0.5 });
    osc.connect(gain).connect(ac.destination);
    osc.start();
    fx.state = 'tocando';
    fx.ctxState = ac.state;
  });
})();
</script>
</body></html>`
}

async function toneRoutes(context: BrowserContext): Promise<void> {
  const handler = async (route: Parameters<Parameters<BrowserContext['route']>[1]>[0]) => {
    const url = new URL(route.request().url())
    if (url.pathname !== TONE_PATH) return route.fallback()
    return route.fulfill({
      contentType: 'text/html; charset=utf-8',
      headers: { 'Content-Security-Policy': "require-trusted-types-for 'script'" },
      body: tonePage(),
    })
  }
  await context.route(`https://meet.google.com${TONE_PATH}**`, handler)
  await context.route(`${OTHER_HOST}/**`, handler)
}

/** O harness com a captura de aba de verdade (LaunchOptions.tabCapture) e as páginas de tom. */
function launchForTabCapture(opts: LaunchOptions = {}): Promise<Harness> {
  return launchWithExtension({ ...opts, tabCapture: true, routes: toneRoutes })
}

async function openTone(h: Harness, url: string): Promise<Page> {
  const page = await h.context.newPage()
  await page.goto(url)
  // Clique de verdade: o AudioContext da página nasce tocando.
  await page.click('#tocar')
  await expect.poll(() => page.evaluate(() => (window as any).fixture.ctxState)).toBe('running')
  return page
}

/** tabId da aba pela URL (o SW enxerga só as abas dos hosts do manifesto). */
async function tabIdOf(h: Harness, urlPattern: string): Promise<number> {
  const id = await h.sw.evaluate(async (p) => (await chrome.tabs.query({ url: p }))[0]?.id ?? null, urlPattern)
  if (id == null) throw new Error(`aba não encontrada: ${urlPattern}`)
  return id
}

/** tabId de uma aba de qualquer host (também fora do manifesto, onde a URL não é visível). */
async function tabIdByOpener(h: Harness, page: Page): Promise<number> {
  // O id de qualquer aba é visível sem permissão; a ativa é a que o Playwright trouxe para frente.
  await page.bringToFront()
  const id = await h.sw.evaluate(async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.id ?? null)
  if (id == null) throw new Error('aba ativa não encontrada')
  return id
}

const toggle = (h: Harness, tabId: number) => swApi(h.sw).testing<{ ok: boolean; error?: string }>('toggleTabCapture', tabId)

/** Página de configurações da extensão aberta numa aba: fala com o SW como o popup fala (UiReq). */
async function uiPage(h: Harness): Promise<Page> {
  const p = await h.context.newPage()
  await p.goto(`chrome-extension://${EXTENSION_ID}/src/options/index.html`)
  return p
}

const uiSend = <T>(p: Page, msg: object) => p.evaluate((m) => chrome.runtime.sendMessage(m), msg) as Promise<T>

interface Active {
  sessionId: string
  tabId: number
  kind: 'pagina' | 'aba'
}
const activeOf = async (h: Harness) => (await swApi(h.sw).activeRecordings()) as unknown as Active[]

/** ffprobe ao lado do ffmpeg do harness. */
const FFPROBE = FFMPEG.replace(/ffmpeg$/, 'ffprobe')

/**
 * Canais e taxa média do arquivo gravado. Os canais vêm do cabeçalho Opus (o que o gravador
 * produziu, não o que o decodificador do teste mistura para mono). O info.json diz `kbps: 32` por
 * constante; aqui é o arquivo que responde. 32 kbit/s são 4 kB/s; o teto de 6 kB/s deixa folga
 * para o contêiner e pega qualquer gravador configurado para 64 kbit/s ou mais.
 */
function fileFormat(file: string, seconds: number): { channels: number; bytesPerSecond: number } {
  const out = execFileSync(FFPROBE, ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=channels', '-of', 'csv=p=0', file]).toString().trim()
  return { channels: Number(out), bytesPerSecond: statSync(file).size / seconds }
}

const MAX_BYTES_PER_SECOND = 6000

function expectMono32k(file: string, seconds: number): string {
  const f = fileFormat(file, seconds)
  expect(f.channels, 'o gravador do modo aba é mono').toBe(1)
  expect(f.bytesPerSecond, 'taxa do arquivo (32 kbit/s = 4000 B/s)').toBeLessThanOrEqual(MAX_BYTES_PER_SECOND)
  return `${f.channels} canal, ${Math.round(f.bytesPerSecond)} B/s`
}

/** Abas que o Chrome diz estarem sendo capturadas por esta extensão agora. */
const capturedTabs = (sw: Harness['sw']) =>
  sw.evaluate(async () => (await chrome.tabCapture.getCapturedTabs()).filter((c) => c.status === 'active' || c.status === 'pending').map((c) => c.tabId))

/** Mede os tons de um arquivo, sem os 2 primeiros segundos (arranque) e o último. */
function measure(file: string, freqs: number[]): { windows: WindowMeasure[]; seconds: number } {
  const pcm = decodePcm(file)
  return { windows: measureWindows(pcm, freqs).slice(2, -1), seconds: pcm.length / RATE }
}

function describeTones(name: string, windows: WindowMeasure[], freqs: number[]): string {
  return `${name}: ` + freqs.map((f) => `${f} Hz mediana ${median(windows.map((w) => w.db[f])).toFixed(1)} máx ${Math.max(...windows.map((w) => w.db[f])).toFixed(1)}`).join('; ')
}

/** O tom `strong` presente (> -20 dBFS de mediana) e cada `weak` pelo menos 30 dB abaixo dele, janela a janela. */
function expectOnlyTone(windows: WindowMeasure[], strong: number, weak: number[]) {
  expect(windows.length).toBeGreaterThanOrEqual(5)
  expect(median(windows.map((w) => w.db[strong]))).toBeGreaterThan(-20)
  for (const w of windows) for (const f of weak) expect(w.db[f], `segundo ${w.second}, ${f} Hz`).toBeLessThanOrEqual(w.db[strong] - 30)
}

async function waitSaved(h: Harness, count: number, timeout = 20_000): Promise<FoundRecording[]> {
  await expect.poll(() => findRecordings(h.root).filter((r) => r.info).length, { timeout, intervals: [250] }).toBe(count)
  return findRecordings(h.root)
}

/**
 * Grafo de WebAudio do documento offscreen pelo CDP. O Playwright não expõe o offscreen como
 * Page (ele aparece como alvo `background_page`), então a sessão é aberta por
 * Target.attachToTarget sem flatten e as mensagens vão por Target.sendMessageToTarget.
 */
interface OffscreenAudio {
  contexts: Map<string, string>
  nodes: Map<string, { contextId: string; nodeType: string }>
  edges: Array<{ contextId: string; sourceId: string; destinationId: string }>
  detach(): Promise<void>
}

async function watchOffscreenWebAudio(h: Harness): Promise<OffscreenAudio> {
  await h.sw.evaluate(() => (globalThis as any).__gravador.ensureOffscreen())
  const page = h.context.pages()[0] ?? (await h.context.newPage())
  const cdp: CDPSession = await h.context.newCDPSession(page)
  const { targetInfos } = (await cdp.send('Target.getTargets' as never)) as { targetInfos: Array<{ targetId: string; url: string; type: string }> }
  const target = targetInfos.find((t) => t.url === `chrome-extension://${EXTENSION_ID}/src/offscreen/offscreen.html`)
  if (!target) throw new Error(`offscreen não encontrado: ${JSON.stringify(targetInfos.map((t) => [t.type, t.url]))}`)
  const { sessionId } = (await cdp.send('Target.attachToTarget' as never, { targetId: target.targetId, flatten: false } as never)) as { sessionId: string }
  const out: OffscreenAudio = { contexts: new Map(), nodes: new Map(), edges: [], detach: async () => cdp.detach().catch(() => {}) }
  let nextId = 0
  const pending = new Map<number, (m: { error?: unknown }) => void>()
  cdp.on('Target.receivedMessageFromTarget' as never, ((e: { sessionId: string; message: string }) => {
    if (e.sessionId !== sessionId) return
    const m = JSON.parse(e.message) as { id?: number; method?: string; params?: any; error?: unknown }
    if (m.id !== undefined) return pending.get(m.id)?.(m)
    if (m.method === 'WebAudio.contextCreated') out.contexts.set(m.params.context.contextId, m.params.context.contextState)
    if (m.method === 'WebAudio.contextChanged') out.contexts.set(m.params.context.contextId, m.params.context.contextState)
    if (m.method === 'WebAudio.audioNodeCreated') out.nodes.set(m.params.node.nodeId, { contextId: m.params.node.contextId, nodeType: m.params.node.nodeType })
    if (m.method === 'WebAudio.nodesConnected') out.edges.push(m.params)
  }) as never)
  const send = (method: string) =>
    new Promise<void>((resolve, reject) => {
      const id = ++nextId
      pending.set(id, (m) => (m.error ? reject(new Error(JSON.stringify(m.error))) : resolve()))
      void cdp.send('Target.sendMessageToTarget' as never, { sessionId, message: JSON.stringify({ id, method }) } as never)
    })
  await send('WebAudio.enable')
  return out
}

test.describe('modo aba (AC12)', () => {
  let h: Harness

  test.afterEach(async ({}, testInfo) => {
    if (h && testInfo.status !== testInfo.expectedStatus) {
      await testInfo.attach('console', { body: h.logs.join('\n'), contentType: 'text/plain' })
      console.log(h.logs.join('\n'))
    }
    await h?.close()
  })

  test('página que não é call: pasta própria com audio-aba.webm, o tom de 523 Hz e o título e a URL da aba', async () => {
    h = await launchForTabCapture()
    const url = `https://meet.google.com${TONE_PATH}?tom=523&titulo=Treinamento%20gravado`
    const page = await openTone(h, url)
    const tabId = await tabIdOf(h, `https://meet.google.com${TONE_PATH}*`)
    // O atalho está registrado (o Chrome headless não entrega atalhos de extensão vindos do CDP,
    // então o toque de tecla em si fica para o teste manual; o ouvinte chama este mesmo toggle).
    const commands = await h.sw.evaluate(() => chrome.commands.getAll())
    expect(commands.find((c) => c.name === 'gravar-aba')?.shortcut).toMatch(/^(⌥⇧G|Alt\+Shift\+G)$/)

    const t0 = Date.now()
    expect(await toggle(h, tabId)).toEqual({ ok: true })
    const startMs = Date.now() - t0
    const [active] = await activeOf(h)
    expect(active).toMatchObject({ tabId, kind: 'aba' })
    // Nenhuma sessão de página: a página não é uma call.
    expect((await activeOf(h)).filter((r) => r.kind === 'pagina')).toEqual([])

    await page.waitForTimeout(12_000)
    const stopAt = Date.now()
    expect(await toggle(h, tabId)).toEqual({ ok: true })
    const [rec] = await waitSaved(h, 1)
    const saveMs = Date.now() - stopAt

    expect(rec.folder).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}h\d{2} - Treinamento gravado \(Meet\)$/)
    expect(rec.files).toEqual(['audio-aba.webm', 'info.json'])
    expect(stagingEntries(h.root)).toEqual([])
    const info = rec.info!
    expect(info).toMatchObject({
      sessao: active.sessionId,
      plataforma: 'meet',
      titulo: 'Treinamento gravado',
      tituloFonte: 'titulo-da-aba',
      tituloDaAba: 'Treinamento gravado',
      url,
      status: 'concluida',
      motivoFim: 'parado-pelo-usuario',
    })
    expect(info.arquivos).toEqual([expect.objectContaining({ nome: 'audio-aba.webm', tipo: 'aba', formato: 'audio/webm;codecs=opus', kbps: 32 })])
    expect(info.captura.teveAudio).toBe(true)
    expect(info.captura.contextoAudio).toBe('running')
    expect(info.lacunas).toEqual([])

    const { windows, seconds } = measure(join(rec.dir, 'audio-aba.webm'), [523, 1000])
    const format = expectMono32k(join(rec.dir, 'audio-aba.webm'), seconds)
    const note = `${describeTones('audio-aba', windows, [523, 1000])}; decodificado ${seconds.toFixed(2)} s; ${format}; duração ${info.duracaoSegundos} s; início ${startMs} ms; salvo ${saveMs} ms depois de parar`
    test.info().annotations.push({ type: 'audio', description: note })
    console.log(note)
    expect(Math.abs(seconds - info.duracaoSegundos), `decodificado ${seconds.toFixed(2)} s`).toBeLessThanOrEqual(2)
    expect(info.duracaoSegundos).toBeGreaterThanOrEqual(11)
    // Nenhum outro som na aba: o microfone falso (1000 Hz) não toca nela.
    expectOnlyTone(windows, 523, [1000])
    expect(saveMs).toBeLessThanOrEqual(10_000)
    await expect.poll(() => swApi(h.sw).countChunks()).toBe(0)
  })

  test('durante uma call do Meet, o modo aba salva audio-aba.webm na pasta da call, junto do audio.webm, ambos com 440 Hz e sem o microfone', async () => {
    h = await launchForTabCapture()
    const peer = await h.context.newPage()
    await peer.goto('https://meet.google.com/__peer?tom=440&sala=modo-aba')
    await peer.click('#iniciar')
    await expect.poll(() => peer.evaluate(() => (window as any).fixture.state)).toBe('pronto')
    const call = await h.context.newPage()
    await call.goto('https://meet.google.com/abc-defg-hij?variante=normal&sala=modo-aba')
    await expect.poll(() => call.evaluate(() => (window as any).fixture.micLive)).toBe(true)
    await call.click('#participar')
    await expect.poll(async () => (await activeOf(h)).length, { timeout: 15_000, intervals: [250] }).toBe(1)
    const [pageSession] = await activeOf(h)
    expect(pageSession.kind).toBe('pagina')
    const tabId = pageSession.tabId

    // Pelo caminho do botão do popup (ui:tab-capture), o mesmo toggle do atalho.
    const ui = await uiPage(h)
    expect(await uiSend(ui, { t: 'ui:tab-capture', tabId })).toEqual({ ok: true })
    await expect.poll(async () => (await activeOf(h)).map((r) => r.kind).sort()).toEqual(['aba', 'pagina'])
    const aba = (await activeOf(h)).find((r) => r.kind === 'aba')!

    await call.waitForTimeout(15_000)
    // O microfone falso estava mesmo sendo enviado (senão "sem 1000 Hz" não provaria nada).
    expect(await peer.evaluate(() => (window as any).fixture.micRms)).toBeGreaterThan(0.05)

    // Sair da call encerra a sessão de página, e o modo aba para junto (onPageSessionEnded).
    await call.click('button[jsname="CQylAd"]')
    const [rec] = await waitSaved(h, 1)
    await expect.poll(async () => (await activeOf(h)).length, { timeout: 15_000 }).toBe(0)
    await expect.poll(() => findRecordings(h.root)[0].files, { timeout: 15_000 }).toEqual(['audio-aba.webm', 'audio.webm', 'info.json'])
    expect(findRecordings(h.root)).toHaveLength(1)
    expect(stagingEntries(h.root)).toEqual([])
    const info = findRecordings(h.root)[0].info!
    expect(rec.folder).toMatch(/ - Daily do time \(Meet\)$/)
    expect(info.sessao).toBe(pageSession.sessionId)
    expect(info.motivoFim).toBe('saiu-da-call')
    expect(info.arquivos.map((a) => [a.nome, a.tipo])).toEqual([
      ['audio.webm', 'pagina'],
      ['audio-aba.webm', 'aba'],
    ])
    // O helper escreve o info.json antes de responder, e o SW marca `salva` depois da resposta: o
    // arquivo pode aparecer uns ms antes do status (uma leitura só falhou assim em 13/10/2026).
    await expect
      .poll(async () => ((await swApi(h.sw).listSessions()) as Array<{ sessionId: string; status: string }>).find((s) => s.sessionId === aba.sessionId)?.status, { timeout: 10_000 })
      .toBe('salva')

    const notes: string[] = []
    for (const file of ['audio.webm', 'audio-aba.webm']) {
      const { windows, seconds } = measure(join(rec.dir, file), [440, 1000])
      // audio.webm tem o atraso de 1,5 s do mixer: pula mais um segundo.
      const steady = file === 'audio.webm' ? windows.slice(1) : windows
      const format = file === 'audio-aba.webm' ? `; ${expectMono32k(join(rec.dir, file), seconds)}` : ''
      notes.push(`${describeTones(file, steady, [440, 1000])}; decodificado ${seconds.toFixed(2)} s${format}`)
      expect(seconds).toBeGreaterThanOrEqual(file === 'audio.webm' ? 15 : 12)
      expectOnlyTone(steady, 440, [1000])
    }
    test.info().annotations.push({ type: 'audio', description: notes.join(' | ') })
    console.log(notes.join(' | '))
    expect(h.pageErrors).toEqual([])
  })

  test('o usuário continua ouvindo: no offscreen a fonte da aba vai ao destino do AudioContext e ao gravador mono', async () => {
    h = await launchForTabCapture()
    const audio = await watchOffscreenWebAudio(h)
    await openTone(h, `https://meet.google.com${TONE_PATH}?tom=523`)
    const tabId = await tabIdOf(h, `https://meet.google.com${TONE_PATH}*`)
    expect(await toggle(h, tabId)).toEqual({ ok: true })

    const typeOf = (id: string) => audio.nodes.get(id)?.nodeType ?? '?'
    const sourceTargets = () => audio.edges.filter((e) => typeOf(e.sourceId) === 'MediaStreamAudioSource').map((e) => typeOf(e.destinationId))
    // O ramo gravado é ligado por último: quando ele aparece, o grafo da captura está completo.
    await expect.poll(sourceTargets, { timeout: 10_000 }).toContain('MediaStreamAudioDestination')
    const fromSource = sourceTargets()
    const ctxIds = [...audio.contexts.keys()]
    console.log('offscreen: contextos', JSON.stringify([...audio.contexts]), 'ligações da fonte da aba', JSON.stringify(fromSource))
    expect(ctxIds).toHaveLength(1)
    // Alto-falantes (o som que a captura tirou da aba volta para o usuário, pelo ganho da
    // devolução da Emenda 11) e o destino gravado.
    expect(fromSource).toContain('Gain')
    const fromGain = audio.edges.filter((e) => typeOf(e.sourceId) === 'Gain').map((e) => typeOf(e.destinationId))
    // Emenda 14: o ganho passa pelo limitador (neutro até 100%) antes dos alto-falantes.
    expect(fromGain).toEqual(['DynamicsCompressor'])
    const fromLimiter = audio.edges.filter((e) => typeOf(e.sourceId) === 'DynamicsCompressor').map((e) => typeOf(e.destinationId))
    expect(fromLimiter).toEqual(['AudioDestination'])
    expect(fromSource).toContain('MediaStreamAudioDestination')
    // A página de tom toca na saída padrão: a devolução começa ligada.
    expect(await swApi(h.sw).testing('tabReplay', tabId)).toBe(true)
    await expect.poll(() => audio.contexts.get(ctxIds[0])).toBe('running')

    // E a aba some dos alto-falantes dela mesma (é a captura que toca agora): o Chrome marca a
    // aba como capturada.
    const captured = await h.sw.evaluate(async () => (await chrome.tabCapture.getCapturedTabs()).map((c) => [c.tabId, c.status]))
    expect(captured).toEqual([[tabId, 'active']])
    await audio.detach()
    expect(await toggle(h, tabId)).toEqual({ ok: true })
    await expect.poll(async () => (await activeOf(h)).length).toBe(0)
  })

  test('duas abas gravadas ao mesmo tempo dão dois arquivos, cada um só com o seu tom', async () => {
    h = await launchForTabCapture()
    const a = await openTone(h, `https://meet.google.com${TONE_PATH}?tom=523&titulo=Aba%20A`)
    const tabA = await tabIdOf(h, `https://meet.google.com${TONE_PATH}*`)
    // A outra é de um site fora dos hosts do manifesto (o caso real do plano B: outra plataforma).
    const b = await openTone(h, `${OTHER_HOST}${TONE_PATH}?tom=784&titulo=Aba%20B`)
    const tabB = await tabIdByOpener(h, b)
    expect(tabB).not.toBe(tabA)

    expect(await toggle(h, tabA)).toEqual({ ok: true })
    expect(await toggle(h, tabB)).toEqual({ ok: true })
    const active = await activeOf(h)
    expect(active.map((r) => [r.tabId, r.kind]).sort()).toEqual([[tabA, 'aba'], [tabB, 'aba']].sort())
    const sessB = active.find((r) => r.tabId === tabB)!

    await a.waitForTimeout(12_000)
    // A pelo atalho de novo; B pelo botão parar do popup (session:stop pelo Port do offscreen).
    expect(await toggle(h, tabA)).toEqual({ ok: true })
    const ui = await uiPage(h)
    expect(await uiSend(ui, { t: 'ui:stop', sessionId: sessB.sessionId })).toEqual({ ok: true })
    const recs = await waitSaved(h, 2)
    // As duas capturas pararam de verdade no offscreen (o parar do popup chegou até lá).
    await expect
      .poll(() => h.sw.evaluate(async () => (await chrome.tabCapture.getCapturedTabs()).filter((c) => c.status === 'active').map((c) => c.tabId)))
      .toEqual([])
    const recA = recs.find((r) => r.info!.sessao !== sessB.sessionId)!
    const recB = recs.find((r) => r.info!.sessao === sessB.sessionId)!
    expect(recA.folder).toMatch(/ - Aba A \(Meet\)$/)
    expect(recA.info!.url).toContain('tom=523')
    // Fora dos hosts do manifesto, o título e a URL vêm do activeTab, que o Chrome só concede no
    // gesto do usuário (atalho, ícone, botão do popup); o gatilho de teste não é gesto, então aqui
    // fica "Sem título". A plataforma é `outro` e a pasta diz "(Outro site)", não "(Meet)" (Emenda 7).
    expect(recB.folder).toMatch(/ - Sem título \(Outro site\)$/)
    expect(recB.info!.plataforma).toBe('outro')
    expect(recA.info!.plataforma).toBe('meet')
    for (const r of [recA, recB]) expect(r.info!.motivoFim).toBe('parado-pelo-usuario')
    const notes: string[] = []
    for (const [rec, strong, weak] of [
      [recA, 523, 784],
      [recB, 784, 523],
    ] as const) {
      expect(rec.files).toEqual(['audio-aba.webm', 'info.json'])
      const { windows, seconds } = measure(join(rec.dir, 'audio-aba.webm'), [523, 784, 1000])
      notes.push(`${rec.folder}: ${describeTones('audio-aba', windows, [strong, weak, 1000])}; decodificado ${seconds.toFixed(2)} s`)
      expect(seconds).toBeGreaterThanOrEqual(10)
      expectOnlyTone(windows, strong, [weak, 1000])
    }
    test.info().annotations.push({ type: 'audio', description: notes.join(' | ') })
    console.log(notes.join(' | '))
  })

  test('fechar a aba finaliza a sessão do modo aba, com o áudio até o fechamento', async () => {
    h = await launchForTabCapture()
    const page = await openTone(h, `https://meet.google.com${TONE_PATH}?tom=523&titulo=Fecha%20sozinha`)
    const tabId = await tabIdOf(h, `https://meet.google.com${TONE_PATH}*`)
    const startedAt = Date.now()
    expect(await toggle(h, tabId)).toEqual({ ok: true })
    const [active] = await activeOf(h)
    // 14,5 s: os chunks saem em ~1 s, 6 s e 11 s, então ~3,5 s estão só no gravador quando a aba
    // fecha. Eles têm de chegar ao arquivo (o offscreen fecha o gravador antes de o SW finalizar).
    await page.waitForTimeout(14_500)
    const closedAt = Date.now()
    await page.close()
    const [rec] = await waitSaved(h, 1)
    const saveMs = Date.now() - closedAt
    const info = rec.info!
    expect(info.sessao).toBe(active.sessionId)
    expect(info.motivoFim).toBe('aba-fechada')
    expect(info.status).toBe('concluida')
    expect(rec.files).toEqual(['audio-aba.webm', 'info.json'])
    expect(await activeOf(h)).toEqual([])
    expect(await h.sw.evaluate(async () => (await chrome.tabCapture.getCapturedTabs()).filter((c) => c.status === 'active'))).toEqual([])
    const wallSec = (closedAt - startedAt) / 1000
    const { windows, seconds } = measure(join(rec.dir, 'audio-aba.webm'), [523])
    const note = `${describeTones('audio-aba', windows, [523])}; decodificado ${seconds.toFixed(2)} s de ${wallSec.toFixed(2)} s entre o toggle e o fechamento; duração ${info.duracaoSegundos} s; lacunas ${JSON.stringify(info.lacunas)}; salvo ${saveMs} ms depois de fechar`
    test.info().annotations.push({ type: 'audio', description: note })
    console.log(note)
    expect(saveMs).toBeLessThanOrEqual(10_000)
    expect(info.lacunas).toEqual([])
    expect(seconds, 'o último pedaço antes do fechamento ficou de fora').toBeGreaterThanOrEqual(wallSec - 1.5)
    expect(Math.abs(seconds - info.duracaoSegundos)).toBeLessThanOrEqual(2)
    expect(median(windows.map((w) => w.db[523]))).toBeGreaterThan(-20)
  })

  test('o service worker caindo com um chunk sem ack não perde nada: o offscreen reenvia ao reconectar', async () => {
    h = await launchForTabCapture()
    const page = await openTone(h, `https://meet.google.com${TONE_PATH}?tom=523&titulo=SW%20caiu`)
    const tabId = await tabIdOf(h, `https://meet.google.com${TONE_PATH}*`)
    const startedAt = Date.now()
    // O chunk 1 (~6 s) para antes do IndexedDB e o SW cai nessa janela: sem ack, o offscreen
    // precisa reenviá-lo ao reconectar (senão vira lacuna). Mesmo gancho de fatia1-queda.spec.ts.
    await swApi(h.sw).holdPersistAt(1)
    expect(await toggle(h, tabId)).toEqual({ ok: true })
    const [active] = await activeOf(h)
    await expect.poll(() => swApi(h.sw).heldPersistSeq(), { timeout: 15_000, intervals: [100] }).toBe(1)
    expect(await stopExtensionServiceWorker(h)).toContain('stopped')
    await page.waitForTimeout(8_000)
    const sw = await currentServiceWorker(h)
    // A sessão segue gravando depois do reinício (os chunks novos religam o Port à sessão).
    await expect.poll(async () => (await swApi(sw).activeRecordings()).map((r) => r.sessionId), { timeout: 10_000 }).toEqual([active.sessionId])
    const stopAt = Date.now()
    expect(await swApi(sw).testing('toggleTabCapture', tabId)).toEqual({ ok: true })
    const [rec] = await waitSaved(h, 1)
    const info = rec.info!
    const wallSec = (stopAt - startedAt) / 1000
    const { windows, seconds } = measure(join(rec.dir, 'audio-aba.webm'), [523])
    const note = `${describeTones('audio-aba', windows, [523])}; decodificado ${seconds.toFixed(2)} s de ${wallSec.toFixed(2)} s; lacunas ${JSON.stringify(info.lacunas)}; motivo ${info.motivoFim}`
    test.info().annotations.push({ type: 'audio', description: note })
    console.log(note)
    expect(info.sessao).toBe(active.sessionId)
    expect(info.motivoFim).toBe('parado-pelo-usuario')
    expect(info.status).toBe('concluida')
    expect(info.lacunas).toEqual([])
    expect(seconds).toBeGreaterThanOrEqual(wallSec - 1.5)
    for (const w of windows) expect(w.db[523], `segundo ${w.second}`).toBeGreaterThan(-20)
  })

  test('parar logo depois de o service worker reiniciar para de verdade, sem virar um início negado', async () => {
    h = await launchForTabCapture()
    const page = await openTone(h, `https://meet.google.com${TONE_PATH}?tom=523&titulo=Parar%20depois%20do%20rein%C3%ADcio`)
    const tabId = await tabIdOf(h, `https://meet.google.com${TONE_PATH}*`)
    // Aberta antes da queda: o botão do popup (ui:tab-capture) é a mensagem que acorda o SW.
    const ui = await uiPage(h)
    const startedAt = Date.now()
    expect(await toggle(h, tabId)).toEqual({ ok: true })
    const [active] = await activeOf(h)
    await page.waitForTimeout(7_000)
    // Derruba o SW e manda o toggle NA HORA, da mesma página (stopExtensionServiceWorker espera
    // 500 ms, tempo de o offscreen reconectar e a recuperação recarregar a sessão, o que esconde
    // a janela). Logo depois do reinício a sessão ainda não voltou à memória do SW (só está no
    // IndexedDB): o toggle tem de ser lido como "parar", não como um início na aba já capturada.
    const cdp = await h.context.newCDPSession(ui)
    await cdp.send('ServiceWorker.enable')
    await cdp.send('ServiceWorker.stopAllWorkers')
    const stopAt = Date.now()
    const r = await uiSend<{ ok: boolean; error?: string }>(ui, { t: 'ui:tab-capture', tabId })
    await cdp.detach()
    expect(r, 'o toggle depois do reinício foi lido como início').toEqual({ ok: true })
    const sw = await currentServiceWorker(h)
    // A captura para com este toggle (sem precisar de um segundo).
    await expect.poll(() => capturedTabs(sw), { timeout: 5_000, intervals: [250] }).toEqual([])
    const [rec] = await waitSaved(h, 1)
    const saveMs = Date.now() - stopAt
    const info = rec.info!
    const wallSec = (stopAt - startedAt) / 1000
    const { windows, seconds } = measure(join(rec.dir, 'audio-aba.webm'), [523])
    const note = `${describeTones('audio-aba', windows, [523])}; decodificado ${seconds.toFixed(2)} s de ${wallSec.toFixed(2)} s; lacunas ${JSON.stringify(info.lacunas)}; motivo ${info.motivoFim}; salvo ${saveMs} ms depois do toggle`
    test.info().annotations.push({ type: 'audio', description: note })
    console.log(note)
    expect(info.sessao).toBe(active.sessionId)
    expect(info.motivoFim).toBe('parado-pelo-usuario')
    expect(info.status).toBe('concluida')
    expect(info.lacunas).toEqual([])
    expect(saveMs).toBeLessThanOrEqual(10_000)
    expect(seconds).toBeGreaterThanOrEqual(wallSec - 1.5)
    expect(await swApi(sw).activeRecordings()).toEqual([])
  })

  test('parar pelo popup 2 s depois de começar (antes do chunk de 5 s) também para a captura no offscreen', async () => {
    h = await launchForTabCapture()
    const page = await openTone(h, `https://meet.google.com${TONE_PATH}?tom=523&titulo=Parada%20cedo`)
    const tabId = await tabIdOf(h, `https://meet.google.com${TONE_PATH}*`)
    const ui = await uiPage(h)
    expect(await toggle(h, tabId)).toEqual({ ok: true })
    const [active] = await activeOf(h)
    // O botão parar do popup só chega ao offscreen pelo Port da sessão, que o primeiro chunk liga.
    // Antes do chunk adiantado (1 s), o SW finalizaria sem o offscreen saber, e a aba seguiria
    // capturada (e muda para o usuário) sem nenhuma sessão.
    await page.waitForTimeout(2_000)
    expect(await uiSend(ui, { t: 'ui:stop', sessionId: active.sessionId })).toEqual({ ok: true })
    await expect.poll(() => capturedTabs(h.sw), { timeout: 5_000, intervals: [250] }).toEqual([])
    await expect.poll(async () => (await activeOf(h)).length, { timeout: 10_000 }).toBe(0)
    // Curta demais para guardar (minSeconds): descartada, sem pasta, staging nem chunk sobrando.
    await expect
      .poll(async () => ((await swApi(h.sw).listSessions()) as Array<{ sessionId: string; status: string }>).find((s) => s.sessionId === active.sessionId)?.status, { timeout: 10_000 })
      .toBe('descartada')
    expect(findRecordings(h.root)).toEqual([])
    expect(stagingEntries(h.root)).toEqual([])
    await expect.poll(() => swApi(h.sw).countChunks()).toBe(0)
    // E a aba pode ser gravada de novo logo em seguida.
    expect(await toggle(h, tabId)).toEqual({ ok: true })
    expect(await toggle(h, tabId)).toEqual({ ok: true })
  })

  test('parar pelo popup logo depois de começar, antes do primeiro chunk, também para a captura no offscreen', async () => {
    h = await launchForTabCapture()
    await openTone(h, `https://meet.google.com${TONE_PATH}?tom=523&titulo=Parada%20na%20hora`)
    const tabId = await tabIdOf(h, `https://meet.google.com${TONE_PATH}*`)
    const ui = await uiPage(h)
    const t0 = Date.now()
    expect(await toggle(h, tabId)).toEqual({ ok: true })
    const [active] = await activeOf(h)
    // Antes do primeiro chunk (o offscreen adianta o primeiro para 1 s): o Port do offscreen só
    // está ligado à sessão pelo session:resume do início (Emenda 7).
    expect(await swApi(h.sw).countChunks(active.sessionId)).toBe(0)
    expect(await uiSend(ui, { t: 'ui:stop', sessionId: active.sessionId })).toEqual({ ok: true })
    const stopMs = Date.now() - t0
    console.log(`parada na hora: ui:stop ${stopMs} ms depois do toggle`)
    expect(stopMs, 'o parar saiu antes do primeiro chunk').toBeLessThan(1000)
    await expect.poll(() => capturedTabs(h.sw), { timeout: 5_000, intervals: [250] }).toEqual([])
    await expect
      .poll(async () => ((await swApi(h.sw).listSessions()) as Array<{ sessionId: string; status: string }>).find((s) => s.sessionId === active.sessionId)?.status, { timeout: 10_000 })
      .toBe('descartada')
    expect(await activeOf(h)).toEqual([])
    expect(findRecordings(h.root)).toEqual([])
    expect(stagingEntries(h.root)).toEqual([])
    // O próximo toggle é um início (a captura órfã leria como "parar").
    expect(await toggle(h, tabId)).toEqual({ ok: true })
    await expect.poll(async () => (await activeOf(h)).map((r) => r.kind)).toEqual(['aba'])
    expect(await toggle(h, tabId)).toEqual({ ok: true })
  })

  test('o botão "Gravar esta aba (modo aba)" do popup grava a aba atual pela captura do Chrome, e o mesmo botão para', async () => {
    h = await launchForTabCapture()
    // Uma aba de outro site: o caso real do plano B (a captura na página não existe ali).
    const page = await openTone(h, `${OTHER_HOST}${TONE_PATH}?tom=784&titulo=Outra%20plataforma`)
    const tabId = await tabIdByOpener(h, page)
    const popup = await h.context.newPage()
    await popup.goto(`chrome-extension://${EXTENSION_ID}/src/popup/index.html?tabId=${tabId}`)
    const start = popup.getByRole('button', { name: 'Gravar esta aba (modo aba)' })
    await expect(start).toBeVisible()
    expect(await capturedTabs(h.sw)).toEqual([])
    const startedAt = Date.now()
    await start.click()
    await expect.poll(() => capturedTabs(h.sw), { timeout: 10_000, intervals: [100] }).toEqual([tabId])
    await expect.poll(async () => (await activeOf(h)).map((r) => [r.tabId, r.kind])).toEqual([[tabId, 'aba']])
    const startMs = Date.now() - startedAt
    await expect(popup.getByTestId('gravacao')).toContainText('modo aba')
    await expect(popup.getByTestId('plataforma')).toHaveText('Outro site')
    const stop = popup.getByRole('button', { name: 'Parar o modo aba nesta aba' })
    await expect(stop).toBeVisible()
    await popup.waitForTimeout(10_000)
    const stopAt = Date.now()
    await stop.click()
    const [rec] = await waitSaved(h, 1)
    const saveMs = Date.now() - stopAt
    await expect.poll(() => capturedTabs(h.sw)).toEqual([])
    await expect(popup.getByRole('button', { name: 'Gravar esta aba (modo aba)' })).toBeVisible()
    // O SW não vê a URL desta aba (sem host_permissions e o clique do Playwright não é gesto para
    // o activeTab), então "(Outro site)" aqui passa pelo caminho sem URL do platformOfUrl. O ramo
    // por host (aba fora das calls COM URL) é guardado pelo tabcapture.test.ts; título e URL reais
    // de outro site ficam para a verificação manual (Emenda 7).
    expect(rec.folder).toMatch(/ - Sem título \(Outro site\)$/)
    expect(rec.files).toEqual(['audio-aba.webm', 'info.json'])
    expect(rec.info).toMatchObject({ plataforma: 'outro', motivoFim: 'parado-pelo-usuario', status: 'concluida', lacunas: [] })
    const { windows, seconds } = measure(join(rec.dir, 'audio-aba.webm'), [784, 1000])
    const note = `popup: ${describeTones('audio-aba', windows, [784, 1000])}; decodificado ${seconds.toFixed(2)} s; captura ${startMs} ms depois do clique; salvo ${saveMs} ms depois do parar`
    test.info().annotations.push({ type: 'audio', description: note })
    console.log(note)
    expect(seconds).toBeGreaterThanOrEqual(9)
    expectOnlyTone(windows, 784, [1000])
    expect(saveMs).toBeLessThanOrEqual(10_000)
  })

  test('o botão do popup olha só a aba atual: com o modo aba gravando outra aba, ele grava esta (Emenda 10)', async () => {
    h = await launchForTabCapture()
    const a = await openTone(h, `${OTHER_HOST}${TONE_PATH}?tom=784&titulo=Aba%20A`)
    const aId = await tabIdByOpener(h, a)
    const b = await openTone(h, `${OTHER_HOST}${TONE_PATH}?tom=523&titulo=Aba%20B`)
    const bId = await tabIdByOpener(h, b)
    expect(await toggle(h, bId)).toEqual({ ok: true })
    await expect.poll(() => capturedTabs(h.sw), { timeout: 10_000, intervals: [100] }).toEqual([bId])
    await expect.poll(async () => (await activeOf(h)).map((r) => [r.tabId, r.kind])).toEqual([[bId, 'aba']])
    // O popup aberto sobre a aba A: o modo aba da B não é "desta aba".
    const popup = await h.context.newPage()
    await popup.goto(`chrome-extension://${EXTENSION_ID}/src/popup/index.html?tabId=${aId}`)
    const start = popup.getByRole('button', { name: 'Gravar esta aba (modo aba)' })
    await expect(start).toBeVisible()
    await expect(popup.getByRole('button', { name: 'Parar o modo aba nesta aba' })).toHaveCount(0)
    await start.click()
    await expect.poll(async () => [...(await capturedTabs(h.sw))].sort((x, y) => x - y), { timeout: 10_000, intervals: [100] }).toEqual([aId, bId].sort((x, y) => x - y))
    await expect(popup.getByRole('button', { name: 'Parar o modo aba nesta aba' })).toBeVisible()
    expect(await toggle(h, aId)).toEqual({ ok: true })
    expect(await toggle(h, bId)).toEqual({ ok: true })
    await expect.poll(() => capturedTabs(h.sw), { timeout: 10_000 }).toEqual([])
  })
})
