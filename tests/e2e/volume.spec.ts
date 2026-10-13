// Volume por aba (AC21, Emenda 14) ponta a ponta: o controle "Volume desta aba" do popup abre a
// captura da aba (chrome.tabCapture no SW, getUserMedia no offscreen) só para o ganho, e nenhuma
// gravação passa por ele.
//
// Mesmo Chrome do modo-aba.spec.ts (`LaunchOptions.tabCapture`: --allowlisted-extension-id libera o
// getMediaStreamId sem gesto, --disable-audio-output não deixa nada sair nos alto-falantes). O
// ganho que se ouve é lido do offscreen pelo gancho de teste `tabAudioState` (só leitura): com a
// saída de áudio desligada, não há como medir o que sai nos alto-falantes.
//
// A página de tom fica em meet.google.com/__tom: uma página que não é call, num host em que o SW e
// o popup aberto como página veem a URL (fora dos hosts do manifesto, a URL vem do activeTab, que
// só o clique de verdade no ícone concede).
import { join } from 'node:path'
import { expect, test, type BrowserContext, type Page } from '@playwright/test'
import { decodePcm, measureWindows, median, RATE, type WindowMeasure } from '../helpers/audio'
import { EXTENSION_ID, launchWithExtension, swApi, type Harness } from '../helpers/browser'
import { findRecordings, type FoundRecording } from '../helpers/recordings'

const TONE_PATH = '/__tom'
const TONE_URL = `https://meet.google.com${TONE_PATH}`
/** Outro site (fora dos hosts do manifesto: o popup aberto como página não vê a URL dele). */
const OTHER_HOST = 'https://outro-site.test'
const POPUP = `chrome-extension://${EXTENSION_ID}/src/popup/index.html`

/**
 * Mediana do 440 Hz do audio.webm da fatia 1 (fatia1.spec.ts, "grava só o áudio remoto"), medida
 * na mesma máquina com o mesmo par Meet falso (tom do participante a 0,5 de amplitude). É a
 * referência do nível normal da gravação na página.
 */
const FATIA1_440_DBFS = -6.0
/** Tolerância de nível: 30% de volume daria -10,5 dB, muito fora dela. */
const LEVEL_TOLERANCE_DB = 1.5

/** Página que toca um tom pelo AudioContext dela (a mesma do modo-aba.spec.ts). */
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
  const fulfill = (route: Parameters<Parameters<BrowserContext['route']>[1]>[0]) =>
    route.fulfill({
      contentType: 'text/html; charset=utf-8',
      headers: { 'Content-Security-Policy': "require-trusted-types-for 'script'" },
      body: tonePage(),
    })
  await context.route(`${TONE_URL}**`, fulfill)
  await context.route(`${OTHER_HOST}/**`, fulfill)
}

function launch(): Promise<Harness> {
  return launchWithExtension({ tabCapture: true, routes: toneRoutes })
}

async function openTone(h: Harness, query: string): Promise<{ page: Page; tabId: number }> {
  const page = await h.context.newPage()
  await page.goto(`${TONE_URL}?${query}`)
  await page.click('#tocar')
  await expect.poll(() => page.evaluate(() => (window as any).fixture.ctxState)).toBe('running')
  const tabId = await h.sw.evaluate(async (u) => (await chrome.tabs.query({ url: u }))[0]?.id ?? null, `${TONE_URL}*`)
  if (tabId == null) throw new Error('aba do tom não encontrada')
  return { page, tabId }
}

interface AudioState {
  mode: 'volume' | 'gravando' | null
  volume: number
  replay: boolean
  gain: number
}
const audioState = (h: Harness, tabId: number) => swApi(h.sw).testing<AudioState>('tabAudioState', tabId)
interface Active {
  sessionId: string
  tabId: number
  kind: 'pagina' | 'aba'
  startedAt: number
}
const activeOf = async (h: Harness) => (await swApi(h.sw).activeRecordings()) as unknown as Active[]

const toggle = (h: Harness, tabId: number) => swApi(h.sw).testing<{ ok: boolean; error?: string }>('toggleTabCapture', tabId)

/** Abas que o Chrome diz estarem sendo capturadas por esta extensão agora. */
const capturedTabs = (h: Harness) =>
  h.sw.evaluate(async () => (await chrome.tabCapture.getCapturedTabs()).filter((c) => c.status === 'active' || c.status === 'pending').map((c) => c.tabId))

async function openPopup(h: Harness, tabId: number): Promise<Page> {
  const popup = await h.context.newPage()
  await popup.goto(`${POPUP}?tabId=${tabId}`)
  await expect(popup.getByTestId('volume')).toBeVisible()
  return popup
}

/** Move o controle do popup como o usuário (o input range recebe o valor e dispara o evento). */
async function slide(popup: Page, percent: number): Promise<void> {
  await popup.getByRole('slider', { name: 'Volume desta aba' }).fill(String(percent))
  await expect(popup.getByTestId('volume-valor')).toHaveText(`${percent}%`)
}

const uiSend = <T>(p: Page, msg: object) => p.evaluate((m) => chrome.runtime.sendMessage(m), msg) as Promise<T>

/** O ganho que se ouve chega ao alvo (o GainNode anda até ele em ~0,1 s). */
async function expectGain(h: Harness, tabId: number, mode: AudioState['mode'], gain: number): Promise<void> {
  await expect
    .poll(
      async () => {
        const s = await audioState(h, tabId)
        return s.mode === mode && Math.abs(s.gain - gain) < 0.01
      },
      { timeout: 5_000, intervals: [100] },
    )
    .toBe(true)
}

async function waitSaved(h: Harness, count: number, timeout = 20_000): Promise<FoundRecording[]> {
  await expect.poll(() => findRecordings(h.root).filter((r) => r.info).length, { timeout, intervals: [250] }).toBe(count)
  return findRecordings(h.root)
}

function measure(file: string, freqs: number[]): { windows: WindowMeasure[]; seconds: number } {
  const pcm = decodePcm(file)
  return { windows: measureWindows(pcm, freqs), seconds: pcm.length / RATE }
}

const med = (ws: WindowMeasure[], f: number) => median(ws.map((w) => w.db[f]))

test.describe('volume por aba (AC21)', () => {
  let h: Harness

  test.afterEach(async ({}, testInfo) => {
    if (h && testInfo.status !== testInfo.expectedStatus) {
      await testInfo.attach('console', { body: h.logs.join('\n'), contentType: 'text/plain' })
      console.log(h.logs.join('\n'))
    }
    await h?.close()
  })

  test('150% pelo popup abre a captura com ganho 1,5 sem gravar nada; 100% desfaz a captura', async () => {
    h = await launch()
    const { tabId } = await openTone(h, 'tom=523')
    const popup = await openPopup(h, tabId)
    await expect(popup.getByTestId('volume-valor')).toHaveText('100%')
    await expect(popup.getByText('Fora de 100%, o som desta aba sai pela saída padrão do computador (não pelo fone escolhido dentro do site).')).toBeVisible()
    expect(await capturedTabs(h)).toEqual([])

    await slide(popup, 150)
    await expect.poll(() => capturedTabs(h), { timeout: 10_000, intervals: [100] }).toEqual([tabId])
    await expectGain(h, tabId, 'volume', 1.5)
    expect(await audioState(h, tabId)).toMatchObject({ mode: 'volume', volume: 1.5, replay: true })
    // Só volume: nenhuma gravação.
    expect(await activeOf(h)).toEqual([])
    expect(await uiSend(popup, { t: 'ui:tab-volume-get', tabId })).toEqual({ volume: 1.5, active: true, mode: 'volume' })

    // O SW limita: 5 vira 2 (200%).
    expect(await uiSend(popup, { t: 'ui:tab-volume-set', tabId, volume: 5 })).toMatchObject({ ok: true, volume: 2 })
    await expectGain(h, tabId, 'volume', 2)
    expect(await uiSend(popup, { t: 'ui:tab-volume-set', tabId, volume: 'alto' })).toEqual({ ok: false, error: 'pedido de volume inválido' })
    // O controle do popup ainda mostra 150% (os pedidos acima não passaram por ele): outro valor.
    await slide(popup, 140)
    await expectGain(h, tabId, 'volume', 1.4)

    // 100%: a captura é desfeita (a aba volta ao caminho de som dela).
    await popup.getByRole('button', { name: '100%' }).click()
    await expect(popup.getByTestId('volume-valor')).toHaveText('100%')
    await expect.poll(() => capturedTabs(h), { timeout: 5_000, intervals: [100] }).toEqual([])
    expect((await audioState(h, tabId)).mode).toBeNull()
    expect(await activeOf(h)).toEqual([])
    await expect(popup.getByTestId('volume-erro')).toHaveCount(0)
    expect(findRecordings(h.root)).toEqual([])
  })

  test('volume em 30% e modo aba: a gravação sai no nível de uma gravação a 100% e a captura fica só de volume depois', async () => {
    h = await launch()
    const { page, tabId } = await openTone(h, 'tom=523&titulo=Volume%20baixo')
    const popup = await openPopup(h, tabId)
    await slide(popup, 30)
    await expectGain(h, tabId, 'volume', 0.3)

    // O modo aba entra na mesma captura (o Chrome recusaria uma segunda: "active stream").
    expect(await toggle(h, tabId)).toEqual({ ok: true })
    await expect.poll(async () => (await activeOf(h)).map((r) => r.kind)).toEqual(['aba'])
    await expectGain(h, tabId, 'gravando', 0.3)
    await page.waitForTimeout(10_000)
    expect(await toggle(h, tabId)).toEqual({ ok: true })
    const [low] = await waitSaved(h, 1)
    // Parou com o volume fora de 100%: a captura continua, só de volume, a 30%.
    await expect.poll(async () => (await activeOf(h)).length, { timeout: 15_000 }).toBe(0)
    expect(await capturedTabs(h)).toEqual([tabId])
    await expectGain(h, tabId, 'volume', 0.3)

    // Referência: a mesma aba gravada a 100%, sem captura de volume antes.
    await popup.getByRole('button', { name: '100%' }).click()
    await expect.poll(() => capturedTabs(h), { timeout: 5_000, intervals: [100] }).toEqual([])
    expect(await toggle(h, tabId)).toEqual({ ok: true })
    await expectGain(h, tabId, 'gravando', 1)
    await page.waitForTimeout(10_000)
    expect(await toggle(h, tabId)).toEqual({ ok: true })
    const recs = await waitSaved(h, 2)
    const ref = recs.find((r) => r.dir !== low.dir)!
    // A 100% a captura acaba com a gravação.
    await expect.poll(() => capturedTabs(h), { timeout: 5_000, intervals: [100] }).toEqual([])

    const a = measure(join(low.dir, 'audio-aba.webm'), [523, 1000])
    const b = measure(join(ref.dir, 'audio-aba.webm'), [523, 1000])
    const lowDb = med(a.windows.slice(2, -1), 523)
    const refDb = med(b.windows.slice(2, -1), 523)
    const note = `audio-aba com volume 30%: 523 Hz mediana ${lowDb.toFixed(2)} dBFS em ${a.seconds.toFixed(1)} s; a 100%: ${refDb.toFixed(2)} dBFS em ${b.seconds.toFixed(1)} s; diferença ${(lowDb - refDb).toFixed(2)} dB`
    test.info().annotations.push({ type: 'audio', description: note })
    console.log(note)
    expect(a.seconds).toBeGreaterThanOrEqual(8)
    expect(b.seconds).toBeGreaterThanOrEqual(8)
    expect(refDb).toBeGreaterThan(-20)
    expect(Math.abs(lowDb - refDb), 'a gravação passou pelo volume').toBeLessThanOrEqual(LEVEL_TOLERANCE_DB)
    for (const rec of [low, ref]) expect(rec.info).toMatchObject({ status: 'concluida', motivoFim: 'parado-pelo-usuario', lacunas: [] })
  })

  test('volume em 30% numa call do Meet: o audio.webm da gravação na página fica no nível normal e sem o microfone', async () => {
    h = await launch()
    const peer = await h.context.newPage()
    await peer.goto('https://meet.google.com/__peer?tom=440&sala=volume')
    await peer.click('#iniciar')
    await expect.poll(() => peer.evaluate(() => (window as any).fixture.state)).toBe('pronto')
    const call = await h.context.newPage()
    await call.goto('https://meet.google.com/abc-defg-hij?variante=normal&sala=volume')
    await expect.poll(() => call.evaluate(() => (window as any).fixture.micLive)).toBe(true)
    await call.click('#participar')
    await expect.poll(async () => (await activeOf(h)).length, { timeout: 15_000, intervals: [250] }).toBe(1)
    const [session] = await activeOf(h)
    expect(session.kind).toBe('pagina')
    const tabId = session.tabId

    await call.waitForTimeout(10_000)
    const popup = await openPopup(h, tabId)
    const changedAtSec = (Date.now() - session.startedAt) / 1000
    await slide(popup, 30)
    await expect.poll(() => capturedTabs(h), { timeout: 10_000, intervals: [100] }).toEqual([tabId])
    await expectGain(h, tabId, 'volume', 0.3)
    // A gravação na página continua sozinha, sem modo aba.
    expect((await activeOf(h)).map((r) => [r.sessionId, r.kind])).toEqual([[session.sessionId, 'pagina']])
    await call.waitForTimeout(12_000)
    expect(await peer.evaluate(() => (window as any).fixture.micRms)).toBeGreaterThan(0.05)

    await call.click('button[jsname="CQylAd"]')
    const [rec] = await waitSaved(h, 1)
    expect(rec.files).toEqual(['audio.webm', 'info.json'])
    expect(rec.info).toMatchObject({ status: 'concluida', motivoFim: 'saiu-da-call', lacunas: [] })
    const { windows, seconds } = measure(join(rec.dir, 'audio.webm'), [440, 1000])
    // O mixer da página atrasa 1,5 s: antes da troca, do segundo 3 até 2 s antes; depois, de 3 s
    // depois da troca até o penúltimo segundo.
    const before = windows.filter((w) => w.second >= 3 && w.second <= changedAtSec - 2)
    const after = windows.filter((w) => w.second >= changedAtSec + 3).slice(0, -1)
    const beforeDb = med(before, 440)
    const afterDb = med(after, 440)
    const note = `audio.webm: 440 Hz mediana ${beforeDb.toFixed(2)} dBFS antes do volume 30% (${before.length} s) e ${afterDb.toFixed(2)} dBFS depois (${after.length} s); referência da fatia 1 ${FATIA1_440_DBFS} dBFS; 1000 Hz máx ${Math.max(...windows.map((w) => w.db[1000])).toFixed(1)}; decodificado ${seconds.toFixed(1)} s; troca no segundo ${changedAtSec.toFixed(1)}`
    test.info().annotations.push({ type: 'audio', description: note })
    console.log(note)
    expect(before.length).toBeGreaterThanOrEqual(4)
    expect(after.length).toBeGreaterThanOrEqual(7)
    expect(Math.abs(afterDb - FATIA1_440_DBFS), 'nível depois do volume contra a fatia 1').toBeLessThanOrEqual(LEVEL_TOLERANCE_DB)
    expect(Math.abs(afterDb - beforeDb), 'nível depois do volume contra antes dele').toBeLessThanOrEqual(LEVEL_TOLERANCE_DB)
    for (const w of [...before, ...after]) expect(w.db[1000], `segundo ${w.second}, 1000 Hz`).toBeLessThanOrEqual(w.db[440] - 30)
    expect(h.pageErrors).toEqual([])
  })

  test('o popup reaberto mostra o volume lembrado da aba; páginas que não são http ou https não têm o controle', async () => {
    h = await launch()
    const { tabId } = await openTone(h, 'tom=523')
    const first = await openPopup(h, tabId)
    await slide(first, 150)
    await expectGain(h, tabId, 'volume', 1.5)
    await first.close()

    const again = await openPopup(h, tabId)
    await expect(again.getByTestId('volume-valor')).toHaveText('150%')
    await expect(again.getByRole('slider', { name: 'Volume desta aba' })).toHaveValue('150')
    await expect(again.getByRole('button', { name: '100%' })).toBeEnabled()
    await again.close()

    // Uma página do Chrome: sem o controle (e sem captura nela).
    const chromePage = await h.context.newPage()
    await chromePage.goto('chrome://version/')
    await chromePage.bringToFront()
    const chromeTab = await h.sw.evaluate(async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.id ?? null)
    expect(chromeTab).not.toBe(tabId)
    const popup = await h.context.newPage()
    await popup.goto(`${POPUP}?tabId=${chromeTab}`)
    await expect(popup.getByRole('button', { name: 'Gravar esta aba (modo aba)' })).toBeVisible()
    await expect(popup.getByTestId('volume')).toHaveCount(0)
    // A aba do tom continua a 150%.
    expect(await capturedTabs(h)).toEqual([tabId])
    expect(h.pageErrors).toEqual([])
  })
  test('o volume é da aba: continua depois de navegar, até numa página chrome://, e o popup dali volta a 100%', async () => {
    h = await launch()
    const { page, tabId } = await openTone(h, 'tom=523')
    const first = await openPopup(h, tabId)
    await slide(first, 150)
    await expectGain(h, tabId, 'volume', 1.5)
    await first.close()

    // Medido no Chrome for Testing 151: a captura da aba sobrevive à navegação (mesmo site, outro
    // site, página do Chrome). O volume vai junto, como no Volume Master.
    for (const url of [`${TONE_URL}?tom=440`, `${OTHER_HOST}${TONE_PATH}?tom=440`, 'chrome://version/']) {
      await page.goto(url)
      expect(await capturedTabs(h), url).toEqual([tabId])
      await expectGain(h, tabId, 'volume', 1.5)
    }
    // Na página chrome:// o popup mostra o controle, porque a aba ainda está com o volume.
    const popup = await openPopup(h, tabId)
    expect(await uiSend(popup, { t: 'ui:tab-volume-get', tabId })).toEqual({ volume: 1.5, active: true, mode: 'volume' })
    await expect(popup.getByTestId('volume-valor')).toHaveText('150%')
    await expect(popup.getByTestId('volume-fora')).toHaveText('O volume continua valendo nesta aba depois de sair do site. O botão 100% devolve o som original.')
    await slide(popup, 80)
    await expectGain(h, tabId, 'volume', 0.8)
    await popup.getByRole('button', { name: '100%' }).click()
    await expect.poll(() => capturedTabs(h), { timeout: 5_000, intervals: [100] }).toEqual([])
    expect((await audioState(h, tabId)).mode).toBeNull()
    // A seção não some debaixo do clique; e o popup reaberto ali, sem captura, não a mostra.
    await expect(popup.getByTestId('volume-valor')).toHaveText('100%')
    await expect(popup.getByTestId('volume-erro')).toHaveCount(0)
    await popup.close()
    const again = await h.context.newPage()
    await again.goto(`${POPUP}?tabId=${tabId}`)
    await expect(again.getByRole('button', { name: 'Gravar esta aba (modo aba)' })).toBeVisible()
    await expect(again.getByTestId('volume')).toHaveCount(0)
    expect(findRecordings(h.root)).toEqual([])
    expect(h.pageErrors).toEqual([])
  })

  test('o último movimento vale: a tecla solta manda na hora e fechar o popup antes da espera não perde o valor', async () => {
    h = await launch()
    const { tabId } = await openTone(h, 'tom=523')
    const popup = await h.context.newPage()
    // Relógio falso no popup e parado: a espera de 120 ms do controle nunca acaba sozinha, então
    // só o envio na hora (tecla solta, popup fechando) leva o valor ao SW.
    await popup.clock.install()
    await popup.goto(`${POPUP}?tabId=${tabId}`)
    await expect(popup.getByTestId('volume-valor')).toHaveText('100%')
    await popup.clock.pauseAt(Date.now() + 5_000)

    await slide(popup, 150)
    await popup.waitForTimeout(1_000)
    expect(await capturedTabs(h), 'com o relógio parado, a espera não manda nada').toEqual([])

    const slider = popup.getByRole('slider', { name: 'Volume desta aba' })
    await slider.focus()
    await popup.keyboard.press('ArrowLeft')
    await expect(popup.getByTestId('volume-valor')).toHaveText('145%')
    await expect.poll(() => capturedTabs(h), { timeout: 10_000, intervals: [100] }).toEqual([tabId])
    await expectGain(h, tabId, 'volume', 1.45)

    await slide(popup, 60)
    await popup.waitForTimeout(1_000)
    expect((await audioState(h, tabId)).volume, 'ainda na espera').toBe(1.45)
    await popup.close()
    await expectGain(h, tabId, 'volume', 0.6)
  })
})
