// Rotas das páginas falsas do Teams, passadas em launchWithExtension({ routes: installTeamsRoutes }).
// Instaladas depois das padrão (tests/fixtures/routes.ts), então têm precedência em todos os hosts do
// Teams (os três e as formas pelo proxy do Defender for Cloud Apps):
//
//   https://<host do Teams>/__peer?variante=<nome>&...
//       participante remoto do Teams (../peer-page.ts com ./peer/<nome>.js); sem variante, ou com
//       uma variante que não é daqui, o pedido volta às rotas padrão (route.fallback()).
//   https://<host do Teams>/<qualquer caminho>?variante=<nome>&sala=<sala>
//       reunião do Teams (./page.ts com ./variantes/<nome>.js, padrão "normal"). O caminho é o da
//       plataforma (/meet/<dígitos>, /l/meetup-join/..., /light-meetings/launch...), para o
//       adaptador ler o código e o ID da URL.
import type { BrowserContext } from '@playwright/test'
import { hostsOf } from '../../../src/shared/hosts'
import { fulfillHtml, readVariant } from '../routes'
import { peerPage } from '../peer-page'
import { teamsPage } from './page'

/** Os hosts do Teams e as formas pelo proxy do Defender for Cloud Apps (Emenda 17). */
export const TEAMS_HOSTS: readonly string[] = hostsOf('teams')

export async function installTeamsRoutes(context: BrowserContext): Promise<void> {
  for (const host of TEAMS_HOSTS) {
    await context.route(`https://${host}/**`, async (route) => {
      const url = new URL(route.request().url())
      const name = url.searchParams.get('variante')
      if (url.pathname === '/__peer') {
        const js = name ? readVariant('teams/peer', name) : null
        return js === null ? route.fallback() : fulfillHtml(route, peerPage(js))
      }
      if (route.request().resourceType() !== 'document') return route.fulfill({ status: 204, body: '' })
      const js = readVariant('teams/variantes', name || 'normal')
      if (js === null) return fulfillHtml(route, `<!doctype html><title>404</title><p>variante desconhecida do Teams</p>`, 404)
      return fulfillHtml(route, teamsPage(js))
    })
  }
}
