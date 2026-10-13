#!/usr/bin/env node
// Gera os PNGs do ícone a partir dos SVGs de assets/icone (fora de public/, para não irem no
// pacote da loja), sem dependência nova: abre o Chrome for Testing do Playwright em headless (o
// chrome-headless-shell, quando baixado) e tira um screenshot com fundo transparente de cada tamanho.
//
//   node scripts/renderizar-icones.mjs            grava public/icons/icon{16,32,48,128}.png
//   node scripts/renderizar-icones.mjs --amostra  também grava a folha de conferência
//                                                    (fundos claro e escuro, 1x e ampliado) em
//                                                    artifacts/icones/amostra.png
//
// Margens seguem a orientação da Chrome Web Store: no de 128 px o desenho ocupa 96 px, com 16 px
// transparentes de cada lado; nos menores a margem cai para quase nada, porque a barra de
// ferramentas já dá o respiro. O de 16 px usa o desenho próprio (icon-16.svg), alinhado ao pixel.
// Nunca abre o Chrome de marca: só o Chrome for Testing (ou GRAVADOR_CHROMIUM).
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ICONS = path.join(ROOT, 'public', 'icons')
const SOURCES = path.join(ROOT, 'assets', 'icone')

/** Tamanho final, margem transparente de cada lado e SVG de origem. */
const TARGETS = [
  { size: 16, pad: 0, svg: 'icon-16.svg' },
  { size: 32, pad: 1, svg: 'icon.svg' },
  { size: 48, pad: 2, svg: 'icon.svg' },
  { size: 128, pad: 16, svg: 'icon.svg' },
]

/**
 * O chrome-headless-shell do Playwright (o headless antigo: o --screenshot dele sai sozinho), senão
 * o Chrome for Testing. GRAVADOR_CHROMIUM manda em tudo. Nunca o Chrome de marca.
 */
function chromiumPath() {
  if (process.env.GRAVADOR_CHROMIUM) return process.env.GRAVADOR_CHROMIUM
  const cache = path.join(homedir(), 'Library', 'Caches', 'ms-playwright')
  const newest = (re) =>
    existsSync(cache)
      ? readdirSync(cache)
          .filter((d) => re.test(d))
          .sort((a, b) => Number(b.split('-').pop()) - Number(a.split('-').pop()))
      : []
  for (const d of newest(/^chromium_headless_shell-\d+$/)) {
    for (const arch of ['chrome-headless-shell-mac-arm64', 'chrome-headless-shell-mac-x64', 'chrome-mac-arm64', 'chrome-mac']) {
      const p = path.join(cache, d, arch, 'chrome-headless-shell')
      if (existsSync(p)) return p
    }
  }
  for (const d of newest(/^chromium-\d+$/)) {
    for (const arch of ['chrome-mac-arm64', 'chrome-mac-x64', 'chrome-mac']) {
      const p = path.join(cache, d, arch, 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing')
      if (existsSync(p)) return p
    }
  }
  throw new Error('Chrome for Testing não encontrado; defina GRAVADOR_CHROMIUM')
}

/** Screenshot de um HTML num PNG de largura x altura, com fundo transparente. */
function shoot(chrome, html, out, width, height) {
  const tmp = mkdtempSync(path.join(tmpdir(), 'gravador-icone-'))
  try {
    const page = path.join(tmp, 'pagina.html')
    writeFileSync(page, html)
    const r = spawnSync(chrome, [
      '--headless',
      `--user-data-dir=${path.join(tmp, 'perfil')}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--hide-scrollbars',
      '--disable-gpu',
      '--disable-background-networking',
      '--disable-component-update',
      '--force-device-scale-factor=1',
      '--default-background-color=00000000',
      `--window-size=${width},${height}`,
      `--screenshot=${out}`,
      `file://${page}`,
    ], { encoding: 'utf8', timeout: 60_000 })
    if (r.status !== 0 || !existsSync(out)) throw new Error(`o Chrome for Testing não gerou ${out}: ${r.stderr}`)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

const dataUri = (file) => `data:image/svg+xml;base64,${readFileSync(path.join(SOURCES, file)).toString('base64')}`

function iconPage({ size, pad, svg }) {
  const art = size - pad * 2
  return `<!doctype html><html><head><style>html,body{margin:0;background:transparent}
img{display:block;position:absolute;left:${pad}px;top:${pad}px;width:${art}px;height:${art}px}</style></head>
<body><img src="${dataUri(svg)}"></body></html>`
}

function samplePage() {
  // Fundos da barra do Chrome: claro, cinza claro, escuro (#202124) e o cinza do tema escuro (#35363a).
  const backgrounds = ['#ffffff', '#f1f3f4', '#35363a', '#202124']
  const png = (s) => `data:image/png;base64,${readFileSync(path.join(ICONS, `icon${s}.png`)).toString('base64')}`
  const row = (bg) => `<div class="row" style="background:${bg}">
    <img src="${png(16)}" width="16" height="16">
    <img src="${png(32)}" width="16" height="16" title="32 px exibido em 16 (tela retina)">
    <img src="${png(48)}" width="48" height="48">
    <img src="${png(128)}" width="128" height="128">
    <img class="zoom" src="${png(16)}" width="128" height="128">
    <img class="zoom" src="${png(32)}" width="128" height="128">
  </div>`
  return `<!doctype html><html><head><style>html,body{margin:0;background:#888}
.row{display:flex;align-items:center;gap:24px;padding:16px 24px;height:160px;box-sizing:border-box}
.zoom{image-rendering:pixelated}</style></head><body>${backgrounds.map(row).join('')}</body></html>`
}

const chrome = chromiumPath()
for (const t of TARGETS) {
  const out = path.join(ICONS, `icon${t.size}.png`)
  shoot(chrome, iconPage(t), out, t.size, t.size)
  console.log(`ok ${path.relative(ROOT, out)}`)
}
if (process.argv.includes('--amostra')) {
  const dir = path.join(ROOT, 'artifacts', 'icones')
  mkdirSync(dir, { recursive: true })
  const out = path.join(dir, 'amostra.png')
  shoot(chrome, samplePage(), out, 760, 640)
  console.log(`ok ${path.relative(ROOT, out)}`)
}
