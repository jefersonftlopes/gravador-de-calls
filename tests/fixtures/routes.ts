// Rotas padrão das páginas falsas, instaladas por launchWithExtension (tests/helpers/browser.ts).
// O manifesto real é exercitado: os content scripts entram porque a URL é a da plataforma.
//
//   https://<qualquer host de call>/__peer?tom=<Hz>&sala=<sala>[&variante=<nome>]
//       participante remoto (./peer-page.ts; variante em ./peer/variantes/<nome>.js)
//   https://meet.google.com/<código>?variante=<nome>&sala=<sala>
//       reunião do Meet (./meet/page.ts; variante em ./meet/variantes/<nome>.js, padrão "normal")
//   qualquer outro caminho: 204 vazio.
//
// Para estender sem mexer aqui:
// - variante nova do Meet ou do participante: só criar o arquivo .js na pasta de variantes;
// - outra plataforma (Teams): rotas próprias num arquivo da fatia (ex.: tests/fixtures/teams/
//   routes.ts), passadas em launchWithExtension({ routes }). Elas são instaladas DEPOIS destas e
//   por isso têm precedência (Playwright usa a rota registrada por último); para deixar o
//   /__peer com este arquivo, chame route.fallback().
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { BrowserContext, Route } from '@playwright/test'
import { CALL_HOSTS as SHARED_CALL_HOSTS, isMeetHost } from '../../src/shared/hosts'
import { meetPage } from './meet/page'
import { peerPage } from './peer-page'

const HERE = dirname(fileURLToPath(import.meta.url))
/**
 * As duas formas de caminho que o Meet serve: /<código> e, desde 23/10/2026, /meet/<código>.
 * Escrita aqui de propósito, em vez de importar a do código: o duplo serve a página dos dois
 * jeitos, e quem está sendo medido é a detecção da extensão, não esta expressão.
 */
const CODE_RE = /^\/(?:meet\/)?([a-z]{3}-[a-z]{4}-[a-z]{3})$/
const VARIANT_RE = /^[a-z0-9-]{1,40}$/

/** Hosts de call do manifesto, também pelo proxy do Defender for Cloud Apps (src/shared/hosts.ts, Emenda 17). */
export const CALL_HOSTS: readonly string[] = SHARED_CALL_HOSTS

/** Mesmo CSP de Trusted Types do Meet e do Teams: se o hook usar innerHTML/eval, a página acusa. */
export const PAGE_CSP = "require-trusted-types-for 'script'"

export function fulfillHtml(route: Route, body: string, status = 200): Promise<void> {
  return route.fulfill({
    status,
    contentType: 'text/html; charset=utf-8',
    headers: { 'Content-Security-Policy': PAGE_CSP },
    body,
  })
}

/**
 * Lê o script de uma variante em tests/fixtures/<pasta>/<nome>.js. Devolve null se o nome for
 * inválido ou o arquivo não existir (a rota responde 404 e o teste falha alto).
 */
export function readVariant(folder: string, name: string): string | null {
  if (!VARIANT_RE.test(name)) return null
  const file = join(HERE, folder, `${name}.js`)
  return existsSync(file) ? readFileSync(file, 'utf8') : null
}

function notFound(route: Route, what: string): Promise<void> {
  return fulfillHtml(route, `<!doctype html><title>404</title><p>variante desconhecida: ${what.replace(/[<>&]/g, '')}</p>`, 404)
}

export async function installDefaultRoutes(context: BrowserContext): Promise<void> {
  for (const host of CALL_HOSTS) {
    await context.route(`https://${host}/**`, async (route) => {
      const url = new URL(route.request().url())
      if (url.pathname === '/__peer') {
        const name = url.searchParams.get('variante')
        if (!name) return fulfillHtml(route, peerPage())
        const js = readVariant('peer/variantes', name)
        return js === null ? notFound(route, `peer/${name}`) : fulfillHtml(route, peerPage(js))
      }
      if (isMeetHost(host) && CODE_RE.test(url.pathname)) {
        const name = url.searchParams.get('variante') || 'normal'
        const js = readVariant('meet/variantes', name)
        return js === null ? notFound(route, `meet/${name}`) : fulfillHtml(route, meetPage(js))
      }
      return route.fulfill({ status: 204, body: '' })
    })
  }
}
