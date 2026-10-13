// Versão rodando x versão no disco (Emenda 17), ponta a ponta.
//
// Achado de uso real (08/10/2026): num perfil, o service worker ainda era o código da 0.1.2 e o
// popup já era o da 0.3.0, porque o Chrome guarda o script do SW de uma extensão sem compactação
// até ela ser recarregada, e lê as páginas do disco a cada abertura. O popup mandou
// ui:tab-volume-set, o SW antigo não conhecia, a resposta veio vazia e o popup quebrou em
// silêncio. Aqui:
// - cada parte (SW, offscreen, popup) diz a mesma versão e o mesmo build do dist/versao.json;
// - SW de outra versão (gancho `fakeWorkerVersion`): popup e configurações avisam, nas duas
//   línguas, e "Recarregar agora" recarrega a extensão; com uma gravação, o botão fica desligado;
// - SW que não responde a um pedido (gancho `dropUiRequests`, como o SW antigo): o erro aparece;
// - recarga sozinha numa cópia publicada pelo scripts/publicar.mjs numa pasta temporária: com o
//   publicado.json reescrito para outra versão, recarrega quando nada está em uso, uma vez só
//   (sem laço), e espera durante uma gravação, recarregando depois que a call acaba. O perfil liga o
//   modo de desenvolvedor, como os perfis de verdade que carregam a extensão sem compactação: sem
//   ele, o Chrome deixa a extensão recarregada desligada (medido no Chrome for Testing).
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type BrowserContext, type Page, type Worker } from '@playwright/test'
import { EXTENSION_ID, launchWithExtension, swApi, type Harness } from '../helpers/browser'
import { DIST, ROOT } from '../helpers/paths'
import { findRecordings } from '../helpers/recordings'
// @ts-expect-error módulo .mjs sem tipos
import { publish } from '../../scripts/publicar.mjs'

const POPUP = `chrome-extension://${EXTENSION_ID}/src/popup/index.html`
const OPTIONS = `chrome-extension://${EXTENSION_ID}/src/options/index.html`
const PAGE_URL = 'https://meet.google.com/__pagina-comum'
const CALL_URL = 'https://meet.google.com/abc-defg-hij?variante=normal&sala=versao'
const PEER_URL = 'https://meet.google.com/__peer?tom=440&sala=versao'

interface BuildInfo {
  version: string
  build: string
}
const built = (): BuildInfo => JSON.parse(readFileSync(join(DIST, 'versao.json'), 'utf8')) as BuildInfo
const pkgVersion = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }).version

let h: Harness | undefined
const temps: string[] = []

test.afterEach(async ({}, testInfo) => {
  if (h && testInfo.status !== testInfo.expectedStatus) {
    await testInfo.attach('console', { body: h.logs.join('\n'), contentType: 'text/plain' })
    console.log(h.logs.join('\n'))
  }
  await h?.close()
  h = undefined
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true })
})

async function pageRoute(context: BrowserContext): Promise<void> {
  await context.route(`${PAGE_URL}**`, (route) =>
    route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<!doctype html><title>Página comum</title><p>página comum</p>' }),
  )
}

async function tabIdOf(sw: Worker, url: string): Promise<number> {
  const id = await sw.evaluate(async (u) => (await chrome.tabs.query({ url: u }))[0]?.id ?? null, `${url}*`)
  expect(id).not.toBeNull()
  return id as number
}

/** Abre o popup como página e espera o primeiro ui:state (a linha do helper aparece). */
async function openPopup(harness: Harness, tabId?: number): Promise<{ popup: Page; errors: string[] }> {
  const popup = await harness.context.newPage()
  const errors: string[] = []
  popup.on('pageerror', (e) => errors.push(e.message))
  await popup.goto(tabId ? `${POPUP}?tabId=${tabId}` : POPUP)
  await expect(popup.getByTestId('helper')).toBeVisible()
  return { popup, errors }
}

async function startMeetCall(harness: Harness): Promise<{ call: Page; peer: Page; tabId: number; sessionId: string }> {
  const peer = await harness.context.newPage()
  await peer.goto(PEER_URL)
  await peer.click('#iniciar')
  await expect.poll(() => peer.evaluate(() => (window as any).fixture.state)).toBe('pronto')
  const call = await harness.context.newPage()
  await call.goto(CALL_URL)
  await expect.poll(() => call.evaluate(() => (window as any).fixture.micLive)).toBe(true)
  await call.click('#participar')
  const api = swApi(harness.sw)
  await expect.poll(async () => (await api.activeRecordings()).length, { timeout: 20_000, intervals: [200] }).toBe(1)
  const [active] = await api.activeRecordings()
  // Acima da duração mínima dos testes (5 s): a gravação é salva, não descartada.
  await call.waitForTimeout(7000)
  return { call, peer, ...active }
}

/** Sai da call pelo botão do Meet e espera a gravação ser salva. */
async function leaveMeetCall(harness: Harness, call: Page, tabId: number): Promise<void> {
  const saved = harness.sw.evaluate(([id]) => (globalThis as any).__gravador.waitTabSessionSaved(id, 20_000), [tabId] as [number])
  await call.click('button[jsname="CQylAd"]')
  expect(await saved, 'a gravação foi salva').toBe(true)
}

/** Publica o dist/ numa pasta temporária, como o npm run publicar (que nunca é rodado aqui). */
async function publishToTemp(): Promise<string> {
  const base = mkdtempSync(join(tmpdir(), 'gravador-publicada-'))
  temps.push(base)
  const dest = join(base, 'extensao')
  await publish({ src: DIST, dest })
  return dest
}

/** Reescreve o publicado.json como uma publicação nova (o código do disco continua o mesmo). */
function fakeNewPublication(dest: string, versao: string, build: string): void {
  const file = join(dest, 'publicado.json')
  const stamp = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  writeFileSync(file, JSON.stringify({ ...stamp, versao, build }, null, 2))
}

type Decision = { action: string; waiting?: string[] }

/**
 * Roda a conferência da recarga sozinha agora (a mesma do alarme de 1 minuto). Se o SW recarregar,
 * a avaliação morre com ele: devolve `'recarregou'` e o SW novo.
 */
async function checkNow(harness: Harness, sw: Worker): Promise<{ decision: Decision | 'recarregou'; sw: Worker }> {
  const next = harness.context.waitForEvent('serviceworker', { predicate: (w) => w !== sw, timeout: 15_000 })
  const decision = (await sw
    .evaluate(() => (globalThis as any).__gravador.testing.checkPublishedVersion())
    .catch(() => 'recarregou')) as Decision | 'recarregou'
  if (decision !== 'recarregou' && decision.action !== 'recarregar') {
    next.catch(() => {})
    return { decision, sw }
  }
  const fresh = await next
  expect(new URL(fresh.url()).host).toBe(EXTENSION_ID)
  return { decision: 'recarregou', sw: fresh }
}

/** Espera o SW novo terminar a conferência de quando sobe. */
async function startupState(sw: Worker): Promise<unknown> {
  let last: unknown = null
  await expect
    .poll(
      async () => {
        last = await sw.evaluate(() => (globalThis as any).__gravador?.testing?.autoReloadState?.() ?? null).catch(() => null)
        return last !== null
      },
      { timeout: 15_000 },
    )
    .toBe(true)
  return last
}

test('cada parte roda o mesmo código: SW e offscreen dizem a versão e o build do dist/versao.json, e o popup fica sem aviso', async () => {
  h = await launchWithExtension()
  const info = built()
  expect(info.version).toBe(pkgVersion)
  expect(info.build).toMatch(/^[0-9a-f]{12}$/)
  const { popup, errors } = await openPopup(h)
  const state = (await popup.evaluate(() => chrome.runtime.sendMessage({ t: 'ui:state' }))) as { worker: BuildInfo; update: unknown }
  expect(state.worker).toEqual(info)
  // Sem publicado.json (o dist/ de trabalho), nada de recarga sozinha.
  expect(state.update).toBeNull()
  const offscreen = await h.sw.evaluate(() => (globalThis as any).__gravador.sendToOffscreen({ target: 'offscreen', t: 'offscreen:version' }))
  expect(offscreen).toEqual(info)
  await expect(popup.getByTestId('versao')).toHaveText(`v${info.version}`)
  await popup.waitForTimeout(1500)
  await expect(popup.getByTestId('aviso-versao')).toHaveCount(0)
  expect(await h.sw.evaluate(() => chrome.alarms.get('gravador:versao-publicada').then((a) => a ?? null)), 'sem alarme fora da cópia publicada').toBeNull()
  expect(errors).toEqual([])
})

test('SW de uma versão anterior: popup e configurações avisam; com gravação o botão fica desligado; "Recarregar agora" recarrega', async () => {
  h = await launchWithExtension({ developerMode: true })
  const api = swApi(h.sw)
  const info = built()
  await api.testing('fakeWorkerVersion', { version: '0.1.2', build: 'antigo' })
  const { popup, errors } = await openPopup(h)
  const banner = popup.getByTestId('aviso-versao')
  await expect(banner.getByTestId('aviso-versao-texto')).toHaveText(`Este perfil ainda está com a versão 0.1.2 da extensão rodando. Recarregue a extensão para usar a versão ${info.version}.`)
  await expect(banner.getByTestId('recarregar-extensao')).toHaveText('Recarregar agora')
  await expect(banner.getByTestId('recarregar-extensao')).toBeEnabled()

  const options = await h.context.newPage()
  await options.goto(OPTIONS)
  await expect(options.getByTestId('aviso-versao-texto')).toHaveText(`Este perfil ainda está com a versão 0.1.2 da extensão rodando. Recarregue a extensão para usar a versão ${info.version}.`)
  await options.close()

  // Um SW anterior à 0.3.1 nem manda o campo: "uma versão anterior".
  await api.testing('fakeWorkerVersion', 'omitir')
  await expect(banner.getByTestId('aviso-versao-texto')).toHaveText(`Este perfil ainda está com uma versão anterior da extensão rodando. Recarregue a extensão para usar a versão ${info.version}.`)

  // Com uma gravação em andamento, recarregar a encerraria: o botão desliga e diz por quê.
  const { call, peer, tabId } = await startMeetCall(h)
  await expect(banner.getByTestId('recarregar-extensao')).toBeDisabled()
  await expect(banner.getByTestId('recarregar-bloqueado')).toHaveText('Há uma gravação em andamento, e recarregar agora a encerraria. O botão volta quando ela terminar.')
  await leaveMeetCall(h, call, tabId)
  await expect(banner.getByTestId('recarregar-extensao')).toBeEnabled()
  await expect(banner.getByTestId('recarregar-bloqueado')).toHaveCount(0)
  await call.close()
  await peer.close()
  expect(errors).toEqual([])

  // "Recarregar agora": a extensão recarrega (SW novo, sem o gancho) e o aviso some.
  const next = h.context.waitForEvent('serviceworker', { predicate: (w) => w !== h!.sw, timeout: 15_000 })
  await banner.getByTestId('recarregar-extensao').click()
  const fresh = await next
  expect(new URL(fresh.url()).host).toBe(EXTENSION_ID)
  const again = await h.context.newPage()
  await again.goto(POPUP)
  await expect(again.getByTestId('helper')).toBeVisible()
  await again.waitForTimeout(1500)
  await expect(again.getByTestId('aviso-versao')).toHaveCount(0)
  // A gravação de antes continua salva.
  expect(findRecordings(h.root)).toHaveLength(1)
})

test('em inglês: o aviso de versão e o erro de um pedido sem resposta', async () => {
  h = await launchWithExtension({ locale: 'en-US', routes: pageRoute })
  const api = swApi(h.sw)
  const info = built()
  const page = await h.context.newPage()
  await page.goto(PAGE_URL)
  const tabId = await tabIdOf(h.sw, PAGE_URL)
  await api.testing('fakeWorkerVersion', { version: '0.1.2', build: 'antigo' })
  await api.testing('dropUiRequests', ['ui:tab-volume-set'])
  const { popup, errors } = await openPopup(h, tabId)
  await expect(popup.getByTestId('aviso-versao-texto')).toHaveText(`This profile is still running version 0.1.2 of the extension. Reload the extension to use version ${info.version}.`)
  await expect(popup.getByTestId('recarregar-extensao')).toHaveText('Reload now')
  await popup.getByRole('slider', { name: "This tab's volume" }).fill('150')
  await expect(popup.getByTestId('volume-erro')).toHaveText(
    `Couldn't change the volume: the extension's service worker didn't answer the "ui:tab-volume-set" request (it may be running an earlier version: reload the extension)`,
  )
  expect(errors).toEqual([])
})

test('SW que não responde a um pedido (como o SW antigo): o popup mostra o erro em vez de quebrar em silêncio', async () => {
  h = await launchWithExtension({ routes: pageRoute })
  const api = swApi(h.sw)
  const page = await h.context.newPage()
  await page.goto(PAGE_URL)
  const tabId = await tabIdOf(h.sw, PAGE_URL)
  await api.testing('dropUiRequests', ['ui:tab-volume-set'])
  const { popup, errors } = await openPopup(h, tabId)
  await popup.getByRole('slider', { name: 'Volume desta aba' }).fill('150')
  await expect(popup.getByTestId('volume-erro')).toHaveText(
    'Não deu para mudar o volume: o service worker da extensão não respondeu ao pedido "ui:tab-volume-set" (ele pode estar rodando uma versão anterior: recarregue a extensão)',
  )
  // O controle volta ao que vale de verdade (o SW respondeu ao ui:tab-volume-get: sem captura).
  await expect(popup.getByTestId('volume-valor')).toHaveText('100%')

  // O volume lido ao abrir também: sem resposta, o motivo aparece.
  await api.testing('dropUiRequests', ['ui:tab-volume-get'])
  const second = await openPopup(h, tabId)
  await expect(second.popup.getByTestId('volume-erro')).toHaveText(
    'Não deu para mudar o volume: o service worker da extensão não respondeu ao pedido "ui:tab-volume-get" (ele pode estar rodando uma versão anterior: recarregue a extensão)',
  )

  // A rede de segurança: uma rejeição que nenhuma seção tratou aparece no popup.
  await popup.evaluate(() => {
    void Promise.reject(new Error('pedido sem dono'))
  })
  await expect(popup.getByTestId('erro-inesperado')).toHaveText('Algo falhou: pedido sem dono')
  expect(errors).toEqual([])
  expect(second.errors).toEqual([])
})

test('cópia publicada: com o publicado.json de outra versão e nada em uso, recarrega sozinha uma vez só (sem laço)', async () => {
  const dest = await publishToTemp()
  const info = built()
  expect(JSON.parse(readFileSync(join(dest, 'publicado.json'), 'utf8'))).toMatchObject({ versao: info.version, build: info.build })
  h = await launchWithExtension({ extensionDir: dest, developerMode: true })
  // Recém-publicada e em dia: nada, mas o alarme de 1 minuto fica.
  await expect.poll(() => h!.sw.evaluate(() => chrome.alarms.get('gravador:versao-publicada').then((a) => a?.periodInMinutes ?? null))).toBe(1)
  expect(await h.sw.evaluate(() => (globalThis as any).__gravador.testing.checkPublishedVersion())).toEqual({ action: 'nada', why: 'em-dia' })

  fakeNewPublication(dest, '9.9.9', 'outrobuild12')
  const first = await checkNow(h, h.sw)
  expect(first.decision, 'nada em uso: recarrega').toBe('recarregou')
  const sw = first.sw
  const record = await sw.evaluate(() => chrome.storage.local.get('recargaAutomatica').then((r) => r.recargaAutomatica))
  expect(record).toMatchObject({ key: '9.9.9+outrobuild12', from: info.version, to: '9.9.9' })

  // O SW novo é o mesmo código (só o carimbo mudou): ao subir, desiste em vez de recarregar de novo.
  expect(await startupState(sw)).toEqual({ published: { version: '9.9.9', build: 'outrobuild12' }, waiting: [], gaveUp: true })
  const again = await checkNow(h, sw)
  expect(again.decision).toEqual({ action: 'desistir', published: { version: '9.9.9', build: 'outrobuild12' } })
  expect(again.sw).toBe(sw)
  await expect.poll(() => sw.evaluate(() => chrome.action.getBadgeText({}))).toBe('↑')
  const { popup } = await openPopup(h)
  await expect(popup.getByTestId('aviso-versao-texto')).toHaveText(`Este perfil ainda está com a versão ${info.version} da extensão rodando. Recarregue a extensão para usar a versão 9.9.9.`)
  await expect(popup.getByTestId('aviso-versao-desistiu')).toBeVisible()
  // Nenhuma outra recarga nos segundos seguintes.
  await popup.waitForTimeout(3000)
  expect(await sw.evaluate(() => 1)).toBe(1)
})

test('cópia publicada: durante uma gravação a recarga espera (aviso com o motivo e o badge), e acontece quando a call acaba', async () => {
  const dest = await publishToTemp()
  const info = built()
  h = await launchWithExtension({ extensionDir: dest, developerMode: true })
  const { call, peer, tabId, sessionId } = await startMeetCall(h)

  fakeNewPublication(dest, '9.9.9', 'outrobuild12')
  const during = await checkNow(h, h.sw)
  expect(during.decision).toEqual({ action: 'esperar', published: { version: '9.9.9', build: 'outrobuild12' }, waiting: ['gravando', 'call-aberta'] })
  expect(during.sw, 'o SW continua o mesmo').toBe(h.sw)
  expect((await swApi(h.sw).activeRecordings()).map((r) => r.sessionId), 'a gravação continua').toEqual([sessionId])
  await expect.poll(() => h!.sw.evaluate(() => chrome.action.getBadgeText({}))).toBe('↑')
  expect(await h.sw.evaluate(() => chrome.action.getTitle({}))).toBe(
    'Gravador de Calls: a versão 9.9.9 foi publicada; a extensão recarrega sozinha quando nenhuma gravação nem call estiver aberta',
  )

  const { popup, errors } = await openPopup(h)
  await expect(popup.getByTestId('aviso-versao-texto')).toHaveText(`Este perfil ainda está com a versão ${info.version} da extensão rodando. Recarregue a extensão para usar a versão 9.9.9.`)
  await expect(popup.getByTestId('aviso-versao-esperando')).toHaveText('Ela recarrega sozinha quando nada estiver em uso (esperando: gravação em andamento, aba do Meet ou do Teams aberta).')
  await expect(popup.getByTestId('recarregar-extensao')).toBeDisabled()

  // A call acaba e a gravação é salva; com as abas do Meet ainda abertas, continua esperando.
  await leaveMeetCall(h, call, tabId)
  const afterCall = await checkNow(h, h.sw)
  expect(afterCall.decision).toMatchObject({ action: 'esperar', waiting: ['call-aberta'] })
  expect(errors).toEqual([])

  // Sem nenhuma aba do Meet: recarrega.
  await call.close()
  await peer.close()
  const done = await checkNow(h, h.sw)
  expect(done.decision).toBe('recarregou')
  const [rec] = findRecordings(h.root)
  expect(rec?.info).toMatchObject({ status: 'concluida', motivoFim: 'saiu-da-call' })
})
