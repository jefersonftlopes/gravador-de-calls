// Capturas da Chrome Web Store (docs/loja/capturas.md): as páginas reais da extensão (popup,
// configurações, boas-vindas) no Chrome for Testing, em português e em inglês, com uma call falsa
// do Meet (tests/fixtures, variante "vitrine" com título e nomes fictícios) e sem o helper, como
// na versão da loja. Cada tela vira um PNG de 1280x800 com uma legenda curta no mesmo idioma, em
// docs/loja/capturas/<idioma>/. O bloco promocional de 440x280 sai do ícone (assets/icone).
//
//   npm run capturas       (build de desenvolvimento em dist/ e Chrome for Testing, --workers=1)
//
// Usa o build de desenvolvimento pelo harness dos testes (tests/helpers/browser.ts): a interface é
// a mesma do pacote da loja. A única diferença visível seria a instrução do npm nas configurações
// sem helper, que fica dentro da área "Avançado" fechada; a captura confere que ela não aparece.
// Nada toca a pasta Downloads real: os downloads vão para a pasta temporária do perfil.
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { EXTENSION_ID, launchWithExtension, swApi, waitWelcomePage, type Harness, type UiLocale } from '../helpers/browser'
import { FFMPEG, ROOT } from '../helpers/paths'

const OUT = join(ROOT, 'docs', 'loja', 'capturas')
const POPUP = `chrome-extension://${EXTENSION_ID}/src/popup/index.html`
const OPTIONS = `chrome-extension://${EXTENSION_ID}/src/options/index.html`
const ICON_SVG = readFileSync(join(ROOT, 'assets', 'icone', 'icon.svg'))
/** Tempo de cada call antes da captura do popup (o relógio da gravação aparece no popup). */
const CALL_MS = 42_000

interface Texts {
  dir: string
  locale: UiLocale
  profile: string
  calls: Array<{ titulo: string; nomes: string[] }>
  slider: string
  /** Títulos das seções das configurações que entram na captura 4. */
  sections: [string, string]
  captions: Record<'gravando' | 'recentes' | 'volume' | 'opcoes' | 'aviso', [string, string]>
  promo: string
}

const LANGS: Texts[] = [
  {
    dir: 'pt-BR',
    locale: 'pt-BR',
    profile: 'Trabalho',
    calls: [
      { titulo: 'Reunião semanal', nomes: ['Alex Lima', 'Ana Souza', 'Bruno Costa'] },
      { titulo: 'Planejamento do trimestre', nomes: ['Alex Lima', 'Carla Dias'] },
    ],
    slider: 'Volume desta aba',
    sections: ['Gravação automática', 'Sair e fechar a call sozinho'],
    captions: {
      gravando: ['Grava sozinho quando a call começa', 'Uma gravação por aba, só com o áudio dos outros participantes. O seu microfone nunca entra.'],
      recentes: ['Tudo salvo no seu computador', 'Áudio e dados da call em Downloads, numa pasta por call. Sem servidor e sem conta.'],
      volume: ['Volume desta aba, de 0% a 200%', 'Ouça a call no volume de que precisar, sem mudar o nível da gravação.'],
      opcoes: ['Você decide o que grava', 'Gravação automática por plataforma, duração mínima e saída automática quando a call esvazia.'],
      aviso: ['Um aviso claro antes da primeira gravação', 'O que é gravado, onde fica e o consentimento dos participantes. Nada sai do computador.'],
    },
    promo: 'Cada call, a sua gravação. Tudo no seu computador.',
  },
  {
    dir: 'en',
    locale: 'en-US',
    profile: 'Work',
    calls: [
      { titulo: 'Weekly sync', nomes: ['Alex Lee', 'Ana Smith', 'Ben Carter'] },
      { titulo: 'Quarterly planning', nomes: ['Alex Lee', 'Carla Diaz'] },
    ],
    slider: "This tab's volume",
    sections: ['Automatic recording', 'Leave and close the call automatically'],
    captions: {
      gravando: ['Records on its own when the call starts', "One recording per tab, with only the other participants' audio. Your microphone is never recorded."],
      recentes: ['Everything saved on your computer', 'Audio and call details in Downloads, one folder per call. No server, no account.'],
      volume: ["This tab's volume, from 0% to 200%", 'Hear the call at the volume you need, without changing the recording level.'],
      opcoes: ['You decide what gets recorded', 'Automatic recording per platform, minimum length and auto-leave when the call empties.'],
      aviso: ['A clear notice before the first recording', "What is recorded, where it goes and the participants' consent. Nothing leaves your computer."],
    },
    promo: 'Every call, its own recording. All on your computer.',
  },
]

const svgUri = `data:image/svg+xml;base64,${ICON_SVG.toString('base64')}`
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** Quadro de 1280x800: marca e legenda à esquerda, a tela real à direita (em CSS px, a 2x). */
function framePage(lang: string, [title, sub]: [string, string], shot: Buffer, w: number, h: number): string {
  // A captura vem a 2x; cabe em 700x700 (px de CSS) sem passar de 1,25x do tamanho real.
  const scale = Math.min(1.25, 700 / (w / 2), 700 / (h / 2))
  const cw = Math.round((w / 2) * scale)
  const ch = Math.round((h / 2) * scale)
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><style>
html,body{margin:0;width:1280px;height:800px;overflow:hidden}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  background:linear-gradient(160deg,#3b82f6 0%,#1d4ed8 70%,#1e40af 100%);color:#fff;display:flex;align-items:center}
.texto{width:${1280 - cw - 72 - 72 - 64}px;padding-left:72px;box-sizing:content-box}
.marca{display:flex;align-items:center;gap:12px;font-size:20px;font-weight:600;opacity:.95;margin-bottom:36px}
.marca img{width:44px;height:44px}
h1{font-size:44px;line-height:1.15;margin:0 0 20px;font-weight:700;letter-spacing:-.01em}
p{font-size:22px;line-height:1.45;margin:0;color:#dbeafe}
.tela{position:absolute;right:72px;top:${Math.round((800 - ch) / 2)}px;width:${cw}px;height:${ch}px;border-radius:14px;
  overflow:hidden;background:#fff;box-shadow:0 24px 60px rgba(15,23,42,.45),0 2px 6px rgba(15,23,42,.25)}
.tela img{width:100%;height:100%;display:block}
</style></head><body>
<div class="texto"><div class="marca"><img src="${svgUri}" alt="">Gravador de Calls</div>
<h1>${esc(title)}</h1><p>${esc(sub)}</p></div>
<div class="tela"><img src="data:image/png;base64,${shot.toString('base64')}" alt=""></div>
</body></html>`
}

function promoPage(lang: string, line: string): string {
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><style>
html,body{margin:0;width:440px;height:280px;overflow:hidden}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  background:linear-gradient(180deg,#3b82f6 0%,#1d4ed8 60%);color:#fff;display:flex;align-items:center;gap:22px;padding:0 30px;box-sizing:border-box}
img{width:96px;height:96px;flex:none;filter:drop-shadow(0 6px 14px rgba(15,23,42,.35))}
h1{font-size:30px;line-height:1.1;margin:0 0 12px;font-weight:700}
p{font-size:18px;line-height:1.35;margin:0}
</style></head><body><img src="${svgUri}" alt=""><div><h1>Gravador de Calls</h1><p>${esc(line)}</p></div></body></html>`
}

/** PNG de 24 bits (sem canal alfa), como a loja pede para capturas e blocos. */
function savePng(buf: Buffer, file: string): void {
  mkdirSync(join(file, '..'), { recursive: true })
  const tmp = `${file}.rgba.png`
  writeFileSync(tmp, buf)
  execFileSync(FFMPEG, ['-v', 'error', '-y', '-i', tmp, '-pix_fmt', 'rgb24', `${file}.tmp.png`])
  rmSync(tmp)
  renameSync(`${file}.tmp.png`, file)
}

async function compose(h: Harness, lang: string, html: string, width: number, height: number, file: string): Promise<void> {
  const page = await h.context.newPage()
  await page.setViewportSize({ width, height })
  await page.setContent(html)
  await page.evaluate(() => Promise.all(Array.from(document.images).map((i) => i.decode())))
  // scale 'css': o contexto está a 2x, o PNG sai com os 1280x800 (ou 440x280) exatos.
  savePng(await page.screenshot({ clip: { x: 0, y: 0, width, height }, scale: 'css' }), file)
  await page.close()
  console.log(`ok ${file.slice(ROOT.length + 1)} (${lang})`)
}

/** Captura de um elemento a 2x (deviceScaleFactor do contexto) e o tamanho dela em px. */
async function shotOf(page: Page, selector: string): Promise<{ png: Buffer; w: number; h: number }> {
  const el = page.locator(selector).first()
  const box = (await el.boundingBox())!
  const png = await el.screenshot({ animations: 'disabled' })
  return { png, w: Math.round(box.width * 2), h: Math.round(box.height * 2) }
}

/** Empilha capturas (a 2x) num painel branco, como a página mostra, e devolve a captura do painel. */
async function stack(h: Harness, parts: Array<{ png: Buffer; w: number; h: number }>): Promise<{ png: Buffer; w: number; h: number }> {
  const page = await h.context.newPage()
  const width = Math.max(...parts.map((p) => p.w / 2)) + 32
  await page.setViewportSize({ width, height: 1600 })
  const imgs = parts.map((p) => `<img src="data:image/png;base64,${p.png.toString('base64')}" width="${p.w / 2}" height="${p.h / 2}">`).join('')
  await page.setContent(`<!doctype html><html><body style="margin:0;background:#fff"><div id="painel" style="display:flex;flex-direction:column;gap:12px;padding:16px;width:fit-content">${imgs}</div></body></html>`)
  await page.evaluate(() => Promise.all(Array.from(document.images).map((i) => i.decode())))
  const shot = await shotOf(page, '#painel')
  await page.close()
  return shot
}

async function startPeer(h: Harness, room: string): Promise<void> {
  const peer = await h.context.newPage()
  await peer.goto(`https://meet.google.com/__peer?tom=440&sala=${room}`)
  await peer.click('#iniciar')
  await expect.poll(() => peer.evaluate(() => (window as any).fixture.state)).toBe('pronto')
}

async function joinCall(h: Harness, code: string, room: string, call: { titulo: string; nomes: string[] }): Promise<Page> {
  const page = await h.context.newPage()
  const q = new URLSearchParams({ variante: 'vitrine', sala: room, titulo: call.titulo, nomes: call.nomes.join(',') })
  await page.goto(`https://meet.google.com/${code}?${q}`)
  await expect.poll(() => page.evaluate(() => (window as any).fixture.micLive)).toBe(true)
  await page.click('#participar')
  await expect.poll(() => page.evaluate(() => (window as any).fixture.pcState), { timeout: 15_000 }).toBe('connected')
  return page
}

const tabIdOf = (h: Harness, code: string) => h.sw.evaluate(async (u) => (await chrome.tabs.query({ url: u }))[0]?.id ?? null, `https://meet.google.com/${code}*`)

for (const L of LANGS) {
  test(`capturas da loja (${L.dir})`, async () => {
    test.setTimeout(300_000)
    const dir = join(OUT, L.dir)
    const h = await launchWithExtension({
      locale: L.locale,
      consent: false,
      installHost: false,
      downloads: true,
      tabCapture: true,
      // 30 s é o mínimo padrão do produto (o harness usa 5 s); as duas calls passam dele.
      settings: { profileLabel: L.profile, minSeconds: 30 },
      contextOptions: { deviceScaleFactor: 2, viewport: { width: 720, height: 900 }, colorScheme: 'light' },
    })
    try {
      // 5. Boas-vindas com o aviso, ainda sem confirmar (a página real que a instalação abre).
      const welcome = await waitWelcomePage(h.context)
      await welcome.setViewportSize({ width: 720, height: 900 })
      await expect(welcome.getByTestId('entendi')).toBeVisible()
      const w = await shotOf(welcome, 'main')
      await compose(h, L.dir, framePage(L.dir, L.captions.aviso, w.png, w.w, w.h), 1280, 800, join(dir, '5-aviso.png'))
      await welcome.getByTestId('entendi').click()
      await expect(welcome.getByTestId('confirmado')).toBeVisible()
      await welcome.close()

      // Duas calls ao mesmo tempo, cada uma na sua aba, com áudio chegando.
      const api = swApi(h.sw)
      await startPeer(h, 'vitrine1')
      await startPeer(h, 'vitrine2')
      const call1 = await joinCall(h, 'abc-defg-hij', 'vitrine1', L.calls[0])
      await call1.waitForTimeout(9_000)
      const call2 = await joinCall(h, 'xyz-wxyz-xyz', 'vitrine2', L.calls[1])
      await expect.poll(async () => (await api.activeRecordings()).length, { timeout: 15_000 }).toBe(2)
      await call1.waitForTimeout(CALL_MS)
      const tab1 = await tabIdOf(h, 'abc-defg-hij')

      // 1. Popup gravando, com "chegando áudio".
      const popup = await h.context.newPage()
      await popup.setViewportSize({ width: 360, height: 900 })
      await popup.goto(`${POPUP}?tabId=${tab1}`)
      await expect(popup.getByTestId('volume')).toBeVisible()
      await expect(popup.locator('main')).toContainText(L.dir === 'en' ? 'audio coming in' : 'chegando áudio')
      const p1 = await shotOf(popup, 'main')
      await compose(h, L.dir, framePage(L.dir, L.captions.gravando, p1.png, p1.w, p1.h), 1280, 800, join(dir, '1-gravando.png'))

      // 3. Volume desta aba em 150% (o controle real, com a captura da aba de verdade).
      await popup.getByRole('slider', { name: L.slider }).fill('150')
      await expect(popup.getByTestId('volume-valor')).toHaveText('150%')
      await popup.waitForTimeout(1_500)
      await expect(popup.getByTestId('volume-erro')).toHaveCount(0)
      const p3 = await shotOf(popup, 'main')
      await compose(h, L.dir, framePage(L.dir, L.captions.volume, p3.png, p3.w, p3.h), 1280, 800, join(dir, '3-volume.png'))
      await popup.getByRole('button', { name: '100%' }).click()

      // 2. Últimas gravações: as duas calls salvas em Downloads.
      await call2.click('button[jsname="CQylAd"]')
      await call1.waitForTimeout(4_000)
      await call1.click('button[jsname="CQylAd"]')
      await expect.poll(async () => (await api.activeRecordings()).length, { timeout: 20_000 }).toBe(0)
      await call1.close()
      await call2.close()
      const blank = await h.context.newPage()
      await blank.goto('about:blank')
      const recent = await h.context.newPage()
      await recent.setViewportSize({ width: 360, height: 900 })
      await recent.goto(POPUP)
      await expect(recent.locator('main')).toContainText(L.calls[1].titulo)
      await expect(recent.locator('main')).toContainText(L.calls[0].titulo)
      await recent.waitForTimeout(1_000)
      const p2 = await shotOf(recent, 'main')
      await compose(h, L.dir, framePage(L.dir, L.captions.recentes, p2.png, p2.w, p2.h), 1280, 800, join(dir, '2-recentes.png'))

      // 4. Configurações sem o helper, com a área "Avançado" fechada.
      const options = await h.context.newPage()
      await options.setViewportSize({ width: 720, height: 900 })
      await options.goto(OPTIONS)
      const advanced = options.getByTestId('secao-avancado')
      await expect(advanced).toBeVisible()
      expect(await advanced.locator('details').evaluate((d) => (d as HTMLDetailsElement).open)).toBe(false)
      expect(await options.evaluate(() => document.body.innerText)).not.toContain('npm run')
      // A página inteira não cabe legível em 1280x800: entram o cabeçalho e as seções que dizem o que
      // se decide (pasta, gravação automática, saída, avançado fechado), na ordem da página, cada uma
      // capturada como está, empilhadas num painel branco.
      const parts = [
        await shotOf(options, 'main > header'),
        await shotOf(options, '[data-testid="secao-pasta"]'),
        ...(await Promise.all(L.sections.map((title) => shotOf(options, `section:has(> h2:text-is("${title}"))`)))),
        await shotOf(options, '[data-testid="secao-avancado"]'),
      ]
      const o = await stack(h, parts)
      await compose(h, L.dir, framePage(L.dir, L.captions.opcoes, o.png, o.w, o.h), 1280, 800, join(dir, '4-opcoes.png'))

      // O bloco padrão é o da listagem em inglês (default_locale); o da listagem em português ao lado.
      const promo = L.dir === 'en' ? 'promo-440x280.png' : 'promo-440x280-pt_BR.png'
      await compose(h, L.dir, promoPage(L.dir, L.promo), 440, 280, join(ROOT, 'docs', 'loja', promo))
    } finally {
      await h.close()
    }
  })
}
