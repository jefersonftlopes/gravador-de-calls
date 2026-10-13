// Rotas próprias do vigia (Emenda 4: sem depender de tests/fixtures/teams/), passadas em
// launchWithExtension({ routes: installVigiaRoutes }). Instaladas depois das padrão, então têm
// precedência; o que não é do vigia volta para as padrão com route.fallback().
//
//   https://teams.microsoft.com/<qualquer caminho>   ./teams-page.ts (menos /__peer)
//   https://meet.google.com/<código>?vigia=1&...      ../meet/page.ts com a variante ./meet.js
//                                                     (a reunião de verdade do Meet falso, com PC
//                                                     e participante remoto: dá para gravar)
import type { BrowserContext } from '@playwright/test'
import { meetPage } from '../meet/page'
import { fulfillHtml, readVariant } from '../routes'
import { INDICADOR_OBSERVER } from './indicador'
import { teamsVigiaPage } from './teams-page'

const CODE_RE = /^\/([a-z]{3}-[a-z]{4}-[a-z]{3})$/

export async function installVigiaRoutes(context: BrowserContext): Promise<void> {
  await context.route('https://teams.microsoft.com/**', (route) => {
    if (new URL(route.request().url()).pathname === '/__peer') return route.fallback()
    return fulfillHtml(route, teamsVigiaPage())
  })
  await context.route('https://meet.google.com/**', (route) => {
    const url = new URL(route.request().url())
    if (!url.searchParams.has('vigia') || !CODE_RE.test(url.pathname)) return route.fallback()
    const js = readVariant('vigia', 'meet')
    if (js === null) return route.fulfill({ status: 500, body: 'tests/fixtures/vigia/meet.js sumiu' })
    return fulfillHtml(route, meetPage(`${INDICADOR_OBSERVER}\n${js}`))
  })
}
