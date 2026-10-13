// Fatia da interface: popup e configurações abertos como páginas da extensão numa aba (a API do
// popup aceita, Emenda 5), dirigidos contra uma call falsa do Meet com o helper de verdade numa
// raiz temporária. Badge e notificações do AC13 e do AC16 pelos ganchos de teste do SW.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type BrowserContext, type Page, type Worker } from '@playwright/test'
import { EXTENSION_ID, currentServiceWorker, launchWithExtension, stopExtensionServiceWorker, swApi, type Harness, type LaunchOptions } from '../helpers/browser'
import { findRecordings } from '../helpers/recordings'
import { fulfillHtml } from '../fixtures/routes'
import { peerPage } from '../fixtures/peer-page'
import { DEFAULT_VIGIA } from '../../src/shared/settings'

const POPUP = `chrome-extension://${EXTENSION_ID}/src/popup/index.html`
const OPTIONS = `chrome-extension://${EXTENSION_ID}/src/options/index.html`
const AMBER = [242, 153, 0, 255]
const RED = [217, 48, 37, 255]
const BLUE = [26, 115, 232, 255]

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
 * Participante remoto mudo (`/__peer?variante=mudo`): a faixa existe e está viva, mas só carrega
 * silêncio. É a call em que a gravação automática não pega áudio (AC13). Rota própria desta
 * spec, instalada depois das padrão (tem precedência), sem mexer nas variantes compartilhadas.
 */
const SILENT_PEER = `
peer.opts.makeTrack = (ac, f) => {
  const osc = new OscillatorNode(ac, { frequency: f });
  const mute = new GainNode(ac, { gain: 0 });
  const dest = new MediaStreamAudioDestinationNode(ac, { channelCount: 1 });
  osc.connect(mute).connect(dest);
  osc.start();
  return dest.stream.getAudioTracks()[0];
};
`
async function silentPeerRoute(context: BrowserContext): Promise<void> {
  await context.route(
    (url) => url.pathname === '/__peer' && url.searchParams.get('variante') === 'mudo',
    (route) => fulfillHtml(route, peerPage(SILENT_PEER)),
  )
}

async function launch(opts: LaunchOptions = {}): Promise<Harness> {
  h = await launchWithExtension(opts)
  return h
}

async function startPeer(context: BrowserContext, room: string, extra = 'tom=440'): Promise<Page> {
  const peer = await context.newPage()
  await peer.goto(`https://meet.google.com/__peer?${extra}&sala=${room}`)
  await peer.click('#iniciar')
  await expect.poll(() => peer.evaluate(() => (window as any).fixture.state)).toBe('pronto')
  return peer
}

/** Entra numa call do Meet falso e espera a gravação começar. Devolve a aba e o tabId. */
async function joinMeet(h: Harness, room: string, code = 'abc-defg-hij'): Promise<{ call: Page; tabId: number; sessionId: string }> {
  const call = await h.context.newPage()
  await call.goto(`https://meet.google.com/${code}?variante=normal&sala=${room}`)
  await expect.poll(() => call.evaluate(() => (window as any).fixture.micLive)).toBe(true)
  const before = new Set((await swApi(h.sw).activeRecordings()).map((a) => a.sessionId))
  await call.click('#participar')
  let found: { sessionId: string; tabId: number } | undefined
  await expect
    .poll(
      async () => {
        found = (await swApi(h.sw).activeRecordings()).find((a) => !before.has(a.sessionId))
        return !!found
      },
      { timeout: 15_000, intervals: [250] },
    )
    .toBe(true)
  return { call, tabId: found!.tabId, sessionId: found!.sessionId }
}

async function tabIdOf(sw: Worker, urlPart: string): Promise<number> {
  const id = await sw.evaluate(async (part) => (await chrome.tabs.query({})).find((t) => t.url?.includes(part))?.id ?? null, urlPart)
  if (id == null) throw new Error(`aba não encontrada: ${urlPart}`)
  return id
}

async function badgeOf(sw: Worker, tabId: number): Promise<{ text: string; color: number[] }> {
  return sw.evaluate(
    async (id) => ({
      text: await chrome.action.getBadgeText({ tabId: id }),
      color: [...((await chrome.action.getBadgeBackgroundColor({ tabId: id })) as number[])],
    }),
    tabId,
  )
}

async function notifications(sw: Worker): Promise<string[]> {
  return sw.evaluate(async () => Object.keys(await chrome.notifications.getAll()).sort())
}

interface Shown {
  id: string
  title: string
  message: string
}
/** Registro das notificações criadas pelo badge.ts (chrome.storage.session, sobrevive ao SW). */
async function shownHistory(sw: Worker): Promise<Shown[]> {
  return sw.evaluate(async () => ((await chrome.storage.session.get('notificacoesMostradas')).notificacoesMostradas ?? []) as Shown[])
}

function readHostConfig(h: Harness): { root: string } {
  return JSON.parse(readFileSync(join(h.base, 'helper-config', 'config.json'), 'utf8'))
}

test('popup: gravação em andamento com plataforma, título, tempo e áudio chegando; o botão parar salva', async () => {
  const h = await launch()
  await startPeer(h.context, 'popup')
  const { call, tabId, sessionId } = await joinMeet(h, 'popup')
  const startedAt = Date.now()

  // Mede o que o botão do modo aba manda ao SW (o resultado depende da fatia do modo aba).
  await h.sw.evaluate(() => {
    const g = globalThis as any
    g.__uiMsgs = []
    chrome.runtime.onMessage.addListener((m: any) => {
      if (m?.t === 'ui:tab-capture') g.__uiMsgs.push(m)
      return false
    })
  })

  const popup = await h.context.newPage()
  await popup.goto(`${POPUP}?tabId=${tabId}`)
  const item = popup.locator(`[data-testid="gravacao"][data-session="${sessionId}"]`)
  await expect(item).toBeVisible()
  await expect(item).toContainText('Daily do time')
  await expect(item.getByTestId('plataforma')).toHaveText('Meet')
  await expect(item).toContainText('nesta aba')

  // O tempo anda (relógio m:ss), conferido duas vezes com 2 s de distância.
  const t1 = await item.getByTestId('tempo').textContent()
  await popup.waitForTimeout(2_000)
  const t2 = await item.getByTestId('tempo').textContent()
  const secs = (t: string | null) => {
    const [m, s] = (t ?? '').split(':').map(Number)
    return m * 60 + s
  }
  expect(t1).toMatch(/^\d+:\d{2}$/)
  expect(secs(t2) - secs(t1), `tempo ${t1} -> ${t2}`).toBeGreaterThanOrEqual(1)

  // Está chegando áudio agora (o diagnóstico vem a cada 5 s).
  await expect(item.getByTestId('audio')).toHaveAttribute('data-audio-now', 'sim', { timeout: 15_000 })
  await expect(item.getByTestId('audio')).toHaveText('chegando áudio')
  const audioAfterMs = Date.now() - startedAt

  // Perfil sem nome: o lembrete aparece. Vigia desligado (padrão): sem o bloco do vigia.
  await expect(popup.getByTestId('lembrete-perfil')).toBeVisible()
  await expect(popup.getByTestId('vigia')).toHaveCount(0)
  // Linha do helper com a raiz atual.
  await expect(popup.getByTestId('helper')).toContainText(`Salvando em ${h.root}`)
  await expect(popup.getByTestId('helper')).toContainText('helper 0.5.0')

  // Modo aba: o botão manda ui:tab-capture com a aba da call e o popup mostra a resposta.
  await popup.getByRole('button', { name: 'Gravar esta aba (modo aba)' }).click()
  await expect.poll(() => h.sw.evaluate(() => (globalThis as any).__uiMsgs)).toEqual([{ t: 'ui:tab-capture', tabId }])
  await expect(popup.getByTestId('modo-aba-erro').or(popup.getByRole('button', { name: 'Parar o modo aba nesta aba' }))).toBeVisible()

  // O SW recusa o primeiro "Parar" (resposta trocada só nesta página): o botão volta e o motivo
  // aparece, em vez de ficar em "Parando..." para sempre.
  await popup.evaluate(() => {
    const send = chrome.runtime.sendMessage.bind(chrome.runtime) as (m: unknown) => Promise<unknown>
    let failed = false
    ;(chrome.runtime as any).sendMessage = (m: any) => {
      if (m?.t === 'ui:stop' && !failed) {
        failed = true
        return Promise.resolve({ ok: false })
      }
      return send(m)
    }
  })
  await item.getByRole('button', { name: 'Parar' }).click()
  await expect(item.getByTestId('parar-erro')).toHaveText('Não deu para parar: o service worker recusou o pedido')
  await expect(item.getByRole('button', { name: 'Parar' })).toBeEnabled()
  expect((await swApi(h.sw).activeRecordings()).map((a) => a.sessionId)).toContain(sessionId)

  // Parar pelo popup: some de "Gravando agora", aparece nas últimas com "Mostrar no Finder".
  await call.waitForTimeout(Math.max(0, 7_000 - (Date.now() - startedAt)))
  const stopAt = Date.now()
  await item.getByRole('button', { name: 'Parar' }).click()
  await expect(item).toHaveCount(0, { timeout: 15_000 })
  const recent = popup.locator(`[data-testid="recente"][data-session="${sessionId}"]`)
  await expect(recent).toBeVisible({ timeout: 15_000 })
  const savedMs = Date.now() - stopAt
  await expect(recent).toContainText('Daily do time')
  await expect(recent).toContainText('Meet')
  // Não clica: abriria o Finder de verdade (o caminho é testado em reveal.test.ts).
  await expect(recent.getByRole('button', { name: 'Mostrar no Finder' })).toBeVisible()
  await expect(popup.locator('[data-testid="gravacao"]')).toHaveCount(0)

  const [rec] = findRecordings(h.root)
  expect(rec?.info).toMatchObject({ sessao: sessionId, motivoFim: 'parado-pelo-usuario', status: 'concluida', perfil: null })
  console.log(`AC11 popup: "chegando áudio" ${audioAfterMs} ms depois do início; parado e listado em ${savedMs} ms; tempo ${t1} -> ${t2}`)
  expect(h.pageErrors).toEqual([])
})

test('popup: vigia ligado mostra a contagem da aba e comanda "Sair agora" e "Desligar nesta call"', async () => {
  // confirmacoes fora do padrão (4): a linha do popup usa a configuração do perfil (AC18).
  const h = await launch({ settings: { autoLeave: true, vigia: { ...DEFAULT_VIGIA, confirmacoes: 6 } } })
  const api = swApi(h.sw)
  // Escuta o que o SW manda pelo Port de cada vigia (o mesmo objeto Port chega a todos os
  // ouvintes de onConnect): prova que o comando certo chegou à aba certa.
  await h.sw.evaluate((name) => {
    const g = globalThis as any
    g.__vigiaDown = []
    chrome.runtime.onConnect.addListener((port) => {
      if (port.name !== name) return
      const tab = port.sender?.tab?.id
      const post = port.postMessage.bind(port)
      port.postMessage = (m: any) => {
        g.__vigiaDown.push({ tab, t: m?.t })
        return post(m)
      }
    })
  }, 'gravador:vigia')
  const commandsTo = (tab: number) =>
    h.sw.evaluate((id) => ((globalThis as any).__vigiaDown as Array<{ tab: number; t: string }>).filter((m) => m.tab === id && m.t !== 'vigia:config').map((m) => m.t), tab)
  const call = await h.context.newPage()
  await call.goto('https://meet.google.com/abc-defg-hij?variante=normal&sala=vigia')
  const tabId = await tabIdOf(h.sw, 'sala=vigia')

  // Leitura falsa só para o que o popup mostra; os comandos vão ao vigia de verdade da aba.
  await api.testing('fakeVigiaTabState', tabId, {
    connected: true,
    disabledForCall: false,
    status: { platform: 'meet', naCall: true, n: 5, fonte: 'botão de pessoas', pico: 8, limite: 2, armado: true, seguidas: 2, saindo: false, tentativas: 0 },
  })
  const popup = await h.context.newPage()
  await popup.goto(`${POPUP}?tabId=${tabId}`)
  const vigia = popup.getByTestId('vigia')
  await expect(vigia.getByTestId('vigia-linha')).toHaveText('5 na call · pico 8 · sai com 2 ou menos · confirmando 2/6')
  await expect(vigia.getByTestId('vigia-fonte')).toHaveText('contagem: botão de pessoas (Meet)')

  // Sem a leitura falsa: o estado real do vigia desta aba (conectado, porque o autoLeave está
  // ligado neste perfil).
  await api.testing('fakeVigiaTabState', tabId, null)
  await expect.poll(() => popup.evaluate((id) => chrome.runtime.sendMessage({ t: 'ui:vigia-status', tabId: id }), tabId)).toMatchObject({ connected: true, disabledForCall: false })
  await expect(vigia.getByRole('button', { name: 'Sair agora' })).toBeVisible()

  expect(await commandsTo(tabId)).toEqual([])
  await vigia.getByRole('button', { name: 'Desligar nesta call' }).click()
  await expect(vigia).toContainText('Desligado nesta call')
  expect(await commandsTo(tabId)).toEqual(['vigia:desligar-nesta-call'])
  await expect(vigia.getByRole('button', { name: 'Sair agora' })).toHaveCount(0)
  expect(await popup.evaluate((id) => chrome.runtime.sendMessage({ t: 'ui:vigia-status', tabId: id }), tabId)).toMatchObject({ connected: true, disabledForCall: true })

  // "Sair agora" numa segunda aba de call: chega ao vigia dela.
  const call2 = await h.context.newPage()
  await call2.goto('https://meet.google.com/xyz-abcd-efg?variante=normal&sala=vigia2')
  const tab2 = await tabIdOf(h.sw, 'sala=vigia2')
  await expect.poll(() => popup.evaluate((id) => chrome.runtime.sendMessage({ t: 'ui:vigia-status', tabId: id }), tab2)).toMatchObject({ connected: true })
  const popup2 = await h.context.newPage()
  await popup2.goto(`${POPUP}?tabId=${tab2}`)
  await popup2.getByTestId('vigia').getByRole('button', { name: 'Sair agora' }).click()
  await expect(popup2.getByTestId('vigia')).toContainText('Saindo da call...')
  expect(await commandsTo(tab2)).toEqual(['vigia:sair-agora'])
  expect(await commandsTo(tabId)).toEqual(['vigia:desligar-nesta-call'])
  expect(await popup.evaluate((id) => chrome.runtime.sendMessage({ t: 'ui:vigia-status', tabId: id }), tab2)).toMatchObject({ connected: true, disabledForCall: false })
  expect(call.isClosed()).toBe(false)
})

test('configurações: persistem, a pasta muda no helper e o nome do perfil vira a primeira pasta', async () => {
  const h = await launch()
  const options = await h.context.newPage()
  await options.goto(OPTIONS)
  const rootInput = options.getByLabel('Pasta das gravações', { exact: true })
  await expect(rootInput).toHaveValue(h.root)

  // Atalho do modo aba como o Chrome mostra, e o botão que abre chrome://extensions/shortcuts.
  const shortcut = options.getByTestId('atalho')
  await expect(shortcut).not.toHaveText('...')
  const shortcutText = (await shortcut.textContent()) ?? ''
  const real = await options.evaluate(async () => (await chrome.commands.getAll()).find((c) => c.name === 'gravar-aba')?.shortcut ?? '')
  expect(shortcutText).toBe(real || 'nenhum')
  const [shortcutsPage] = await Promise.all([h.context.waitForEvent('page'), options.getByRole('button', { name: 'Trocar o atalho' }).click()])
  await expect.poll(() => shortcutsPage.url()).toBe('chrome://extensions/shortcuts')
  await shortcutsPage.close()

  // Pasta inválida (um arquivo no caminho): erro, e o config.json do helper não muda.
  const blocker = join(h.base, 'um-arquivo')
  writeFileSync(blocker, 'x')
  await rootInput.fill(join(blocker, 'sub'))
  await options.getByRole('button', { name: 'Usar esta pasta' }).click()
  await expect(options.getByTestId('pasta-mensagem')).toContainText('Não dá para gravar nessa pasta')
  expect(readHostConfig(h).root).toBe(h.root)

  // Pasta nova: check-root e set-root, gravada no config.json do helper (vale para todos os perfis).
  const newRoot = join(h.base, 'Nova raiz')
  await rootInput.fill(newRoot)
  await options.getByRole('button', { name: 'Usar esta pasta' }).click()
  await expect(options.getByTestId('pasta-mensagem')).toHaveText('Pasta salva no helper: vale para todos os perfis do Chrome.')
  expect(readHostConfig(h).root).toBe(newRoot)
  expect(existsSync(newRoot)).toBe(true)
  expect((await swApi(h.sw).pingHost(true)).root).toBe(newRoot)

  // Configurações deste perfil.
  const save = options.getByRole('button', { name: 'Salvar', exact: true })
  await expect(save).toBeDisabled()
  await options.getByLabel('Nome deste perfil (ex.: Trabalho)').fill('  Trabalho ')
  await expect(options.getByTestId('previa-pasta')).toHaveText(`${newRoot}/Trabalho/AAAA-MM/AAAA-MM-DD HHhMM - título (Meet|Teams)/`)
  await options.getByLabel('Gravar sozinho as calls do Microsoft Teams').uncheck()
  await options.getByLabel('Descartar gravações com menos de (segundos)').fill('6')
  await options.getByLabel('Sair e fechar a aba quando a call esvaziar').check()
  await options.getByText('Ajustes finos').click()
  const interval = options.getByLabel('Conferir a contagem a cada (segundos)')
  await expect(interval).toHaveValue('5')
  // Valor fora do schema: erro em português e nada salvo.
  await interval.fill('0')
  await save.click()
  await expect(options.getByText('no mínimo 1')).toBeVisible()
  // (O nome do perfil já foi salvo sozinho ao sair do campo, Emenda 10; o resto espera o Salvar.)
  expect(await h.sw.evaluate(async () => ((await chrome.storage.local.get('settings')).settings as any)?.minSeconds)).toBe(5)
  await interval.fill('9')
  await save.click()
  await expect(options.getByTestId('salvar-mensagem')).toHaveText('Configurações deste perfil salvas.')

  const stored = await h.sw.evaluate(async () => (await chrome.storage.local.get('settings')).settings)
  expect(stored).toMatchObject({ profileLabel: 'Trabalho', autoMeet: true, autoTeams: false, minSeconds: 6, autoLeave: true, vigiaIndicador: true, vigia: { modo: 'proporcao', quantidade: 2, intervaloSeg: 9, fracao: 0.3, minimo: 2, picoParaQueda: 4, confirmacoes: 4, faltasParaFim: 3 } })
  expect(stored).not.toHaveProperty('profileId')

  // Recarregar a página mostra o que ficou salvo.
  await options.reload()
  await expect(options.getByLabel('Nome deste perfil (ex.: Trabalho)')).toHaveValue('Trabalho')
  await expect(options.getByLabel('Gravar sozinho as calls do Microsoft Teams')).not.toBeChecked()
  await expect(options.getByLabel('Gravar sozinho as calls do Google Meet')).toBeChecked()
  await expect(options.getByLabel('Descartar gravações com menos de (segundos)')).toHaveValue('6')
  await expect(options.getByLabel('Sair e fechar a aba quando a call esvaziar')).toBeChecked()
  await expect(options.getByLabel('Conferir a contagem a cada (segundos)')).toHaveValue('9')
  // "Voltar aos valores padrão" restaura os números de "Ajustes finos" (Emenda 16).
  await options.getByText('Ajustes finos').click()
  await options.getByRole('button', { name: 'Voltar aos valores padrão' }).click()
  await expect(options.getByLabel('Conferir a contagem a cada (segundos)')).toHaveValue('5')
  await expect(options.getByRole('button', { name: 'Salvar', exact: true })).toBeEnabled()
  await options.getByRole('button', { name: 'Salvar', exact: true }).click()
  await expect(options.getByTestId('salvar-mensagem')).toHaveText('Configurações deste perfil salvas.')
  expect(await h.sw.evaluate(async () => ((await chrome.storage.local.get('settings')).settings as any)?.vigia)).toEqual({ modo: 'proporcao', quantidade: 2, intervaloSeg: 5, fracao: 0.3, minimo: 2, picoParaQueda: 4, confirmacoes: 4, faltasParaFim: 3 })

  // Uma call gravada agora vai para <raiz nova>/Trabalho/<AAAA-MM>/... e o info.json diz o perfil.
  await startPeer(h.context, 'perfil')
  const { call, sessionId } = await joinMeet(h, 'perfil')
  const popup = await h.context.newPage()
  await popup.goto(POPUP)
  await expect(popup.getByTestId('lembrete-perfil')).toHaveCount(0)
  await expect(popup.getByTestId('helper')).toContainText(`Salvando em ${newRoot}`)
  await call.waitForTimeout(8_000)
  await call.click('button[jsname="CQylAd"]')
  await expect.poll(() => findRecordings(newRoot, 'Trabalho').filter((r) => r.info).length, { timeout: 15_000, intervals: [250] }).toBe(1)
  const [rec] = findRecordings(newRoot, 'Trabalho')
  expect(rec.info).toMatchObject({ sessao: sessionId, perfil: 'Trabalho', plataforma: 'meet', motivoFim: 'saiu-da-call' })
  expect(rec.dir.startsWith(join(newRoot, 'Trabalho', rec.month))).toBe(true)
  expect(findRecordings(newRoot)).toEqual([])
  expect(findRecordings(h.root)).toEqual([])
  expect(findRecordings(h.root, 'Trabalho')).toEqual([])
  console.log(`AC9/AC17: ${rec.dir}`)
})

test('configurações: o nome do perfil é salvo ao sair do campo, sem o botão Salvar; e a página lembra de fixar o ícone (Emenda 10)', async () => {
  const h = await launch({ installHost: false })
  const options = await h.context.newPage()
  await options.goto(OPTIONS)
  // O Chrome não fixa sozinho uma extensão carregada sem compactação: sem fixar, REC, ↻ e o alerta
  // âmbar ficam escondidos no menu de extensões.
  await expect(options.getByTestId('fixar-icone')).toBeVisible()
  const label = options.getByLabel('Nome deste perfil (ex.: Trabalho)')
  await label.fill('Trabalho')
  await options.getByLabel('Gravar sozinho as calls do Microsoft Teams').uncheck()
  await expect(options.getByTestId('perfil-mensagem')).toContainText('Nome do perfil salvo')
  // Fechar sem o Salvar: o nome fica; a outra mudança, não.
  await options.close()
  const stored = (await h.sw.evaluate(async () => (await chrome.storage.local.get('settings')).settings)) as Record<string, unknown>
  expect(stored).toMatchObject({ profileLabel: 'Trabalho', autoTeams: true })
  const again = await h.context.newPage()
  await again.goto(OPTIONS)
  await expect(again.getByLabel('Nome deste perfil (ex.: Trabalho)')).toHaveValue('Trabalho')
})

test('configurações: gravação automática do Meet desligada não grava a call', async () => {
  const h = await launch()
  const options = await h.context.newPage()
  await options.goto(OPTIONS)
  await options.getByLabel('Gravar sozinho as calls do Google Meet').uncheck()
  await options.getByRole('button', { name: 'Salvar', exact: true }).click()
  await expect(options.getByTestId('salvar-mensagem')).toHaveText('Configurações deste perfil salvas.')

  await startPeer(h.context, 'desligado')
  const call = await h.context.newPage()
  await call.goto('https://meet.google.com/abc-defg-hij?variante=normal&sala=desligado')
  await expect.poll(() => call.evaluate(() => (window as any).fixture.micLive)).toBe(true)
  await call.click('#participar')
  await expect.poll(() => call.evaluate(() => (window as any).fixture.pcState), { timeout: 15_000 }).toBe('connected')
  await call.waitForTimeout(8_000)
  expect(await swApi(h.sw).activeRecordings()).toEqual([])
  expect(await swApi(h.sw).listSessions()).toEqual([])

  // Ligado de novo pela mesma tela: a próxima call grava.
  await options.getByLabel('Gravar sozinho as calls do Google Meet').check()
  await options.getByRole('button', { name: 'Salvar', exact: true }).click()
  await expect(options.getByTestId('salvar-mensagem')).toHaveText('Configurações deste perfil salvas.')
  await startPeer(h.context, 'religado')
  await joinMeet(h, 'religado', 'xyz-abcd-efg')
})

/**
 * Troca a resposta da API do SW para os tipos dados, só nesta página (o resto vai ao SW de
 * verdade). `reject` faz o sendMessage rejeitar, como quando a mensagem não chega ao SW.
 */
async function stubUi(page: Page, answers: Record<string, { resolve: unknown } | { reject: string }>) {
  await page.evaluate((a) => {
    const orig = chrome.runtime.sendMessage.bind(chrome.runtime) as (m: unknown) => Promise<unknown>
    ;(chrome.runtime as any).sendMessage = (m: { t?: string }) => {
      const r = m && typeof m.t === 'string' ? a[m.t] : undefined
      if (!r) return orig(m)
      return 'reject' in r ? Promise.reject(new Error(r.reject)) : Promise.resolve(r.resolve)
    }
  }, answers)
}

test('configurações: "Escolher..." aplica a pasta do seletor, falha da API aparece na tela, e pasta e perfil sobrevivem a fechar o Chrome (AC9)', async () => {
  h = await launch()
  let options = await h.context.newPage()
  const errors: string[] = []
  options.on('pageerror', (e) => errors.push(e.message))
  await options.goto(OPTIONS)
  const rootInput = () => options.getByLabel('Pasta das gravações', { exact: true })
  await expect(rootInput()).toHaveValue(h.root)

  // O seletor do macOS (osascript no helper) não abre no teste: a resposta dele é trocada e o
  // resto (check-root e set-root no helper de verdade) segue.
  const chosen = join(h.base, 'Escolhida no Finder')
  await stubUi(options, { 'ui:choose-folder': { resolve: { ok: true, path: chosen } } })
  await options.getByRole('button', { name: 'Escolher...' }).click()
  await expect(options.getByTestId('pasta-mensagem')).toHaveText('Pasta salva no helper: vale para todos os perfis do Chrome.')
  await expect(rootInput()).toHaveValue(chosen)
  expect(readHostConfig(h).root).toBe(chosen)
  expect(existsSync(chosen)).toBe(true)

  // Cancelar o seletor não mostra erro nem muda a pasta.
  await options.reload()
  await stubUi(options, { 'ui:choose-folder': { resolve: { ok: false, error: 'cancelado' } } })
  await options.getByRole('button', { name: 'Escolher...' }).click()
  await expect(options.getByRole('button', { name: 'Escolher...' })).toBeEnabled()
  await expect(options.getByTestId('pasta-mensagem')).toHaveCount(0)
  expect(readHostConfig(h).root).toBe(chosen)

  // A mensagem que não chega ao SW: erro na tela, botões de volta, nada sem tratamento.
  await options.reload()
  await stubUi(options, { 'ui:choose-folder': { reject: 'sem resposta do SW' }, 'ui:check-root': { reject: 'sem resposta do SW' } })
  await options.getByRole('button', { name: 'Escolher...' }).click()
  await expect(options.getByTestId('pasta-mensagem')).toHaveText('Não foi possível abrir o seletor: sem resposta do SW')
  await rootInput().fill(join(h.base, 'Outra'))
  await options.getByRole('button', { name: 'Usar esta pasta' }).click()
  await expect(options.getByTestId('pasta-mensagem')).toHaveText('Não dá para gravar nessa pasta: sem resposta do SW')
  await expect(options.getByRole('button', { name: 'Usar esta pasta' })).toBeEnabled()
  expect(readHostConfig(h).root).toBe(chosen)

  // A pasta passa no check-root de verdade, mas o set-root não chega ao SW.
  await options.reload()
  await stubUi(options, { 'ui:set-root': { reject: 'sem resposta do SW' } })
  await rootInput().fill(join(h.base, 'Outra'))
  await options.getByRole('button', { name: 'Usar esta pasta' }).click()
  await expect(options.getByTestId('pasta-mensagem')).toHaveText('Não foi possível salvar a pasta: sem resposta do SW')
  await expect(options.getByRole('button', { name: 'Escolher...' })).toBeEnabled()
  expect(readHostConfig(h).root).toBe(chosen)

  // "Salvar" das configurações do perfil com a mensagem que não chega ao SW.
  await stubUi(options, { 'ui:save-settings': { reject: 'sem resposta do SW' } })
  await options.getByLabel('Nome deste perfil (ex.: Trabalho)').fill('Não salvo')
  await options.getByRole('button', { name: 'Salvar', exact: true }).click()
  await expect(options.getByTestId('salvar-mensagem')).toHaveText('Não foi possível salvar: sem resposta do SW')
  expect(await h.sw.evaluate(async () => ((await chrome.storage.local.get('settings')).settings as { profileLabel?: string } | undefined)?.profileLabel ?? null)).not.toBe('Não salvo')
  expect(errors, 'promessa rejeitada sem tratamento na página').toEqual([])

  // Configurações deste perfil, e então fechar o Chrome e abrir de novo no mesmo perfil.
  await options.reload()
  await options.getByLabel('Nome deste perfil (ex.: Trabalho)').fill('Trabalho')
  await options.getByLabel('Gravar sozinho as calls do Microsoft Teams').uncheck()
  await options.getByLabel('Descartar gravações com menos de (segundos)').fill('7')
  await options.getByRole('button', { name: 'Salvar', exact: true }).click()
  await expect(options.getByTestId('salvar-mensagem')).toHaveText('Configurações deste perfil salvas.')

  h = await h.relaunch()
  expect(readHostConfig(h).root).toBe(chosen)
  expect((await swApi(h.sw).pingHost(true)).root).toBe(chosen)
  expect(await h.sw.evaluate(async () => (await chrome.storage.local.get('settings')).settings)).toMatchObject({ profileLabel: 'Trabalho', autoMeet: true, autoTeams: false, minSeconds: 7 })
  options = await h.context.newPage()
  await options.goto(OPTIONS)
  await expect(rootInput()).toHaveValue(chosen)
  await expect(options.getByLabel('Nome deste perfil (ex.: Trabalho)')).toHaveValue('Trabalho')
  await expect(options.getByLabel('Gravar sozinho as calls do Microsoft Teams')).not.toBeChecked()
  await expect(options.getByLabel('Descartar gravações com menos de (segundos)')).toHaveValue('7')
  await expect(options.getByTestId('previa-pasta')).toHaveText(`${chosen}/Trabalho/AAAA-MM/AAAA-MM-DD HHhMM - título (Meet|Teams)/`)
  const popup = await h.context.newPage()
  await popup.goto(POPUP)
  await expect(popup.getByTestId('helper')).toContainText(`Salvando em ${chosen}`)
})

test('helper instalado que não abre (node sumiu, wrapper quebrado): popup e configurações mostram o erro e mandam reinstalar (Emenda 10)', async () => {
  const h = await launch()
  // O manifesto continua lá; o wrapper não sobe o helper (o node fixado foi desinstalado, por exemplo).
  writeFileSync(join(h.base, 'gravador-host.sh'), '#!/bin/sh\nexit 1\n')
  // O helper que já estava aberto (o ping do harness) sai, como num reinício do Chrome.
  try {
    execFileSync('pkill', ['-f', join(h.base, 'gravador-host.mjs')])
  } catch {
    // nenhum aberto
  }
  await expect.poll(async () => (await swApi(h.sw).pingHost(true)).ok, { timeout: 10_000 }).toBe(false)
  const ping = await swApi(h.sw).pingHost(true)
  const popup = await h.context.newPage()
  await popup.goto(POPUP)
  await expect(popup.getByTestId('helper')).toHaveAttribute('data-helper', 'nao-abre')
  await expect(popup.getByTestId('helper')).toContainText(String(ping.error))
  await expect(popup.getByTestId('helper')).toContainText('npm run instalar')
  const options = await h.context.newPage()
  await options.goto(OPTIONS)
  await expect(options.getByTestId('sem-helper')).toHaveAttribute('data-helper', 'nao-abre')
  await expect(options.getByTestId('helper-status')).toContainText('Instalado, mas não abre')
})

test('sem o helper: popup e configurações dizem só que salva em Downloads, sem tom de alerta, e o helper fica em Avançado (AC9, Emenda 15)', async () => {
  const h = await launch({ installHost: false })
  const popup = await h.context.newPage()
  await popup.goto(POPUP)
  await expect(popup.getByTestId('helper')).toHaveText('Salvando em Downloads/Gravações de calls.')
  await expect(popup.getByTestId('helper')).toHaveAttribute('data-helper', 'nao-instalado')
  await expect(popup.getByTestId('helper')).not.toHaveClass(/amber|red/)
  await expect(popup.getByTestId('transcricao-aviso')).toHaveCount(0)
  const options = await h.context.newPage()
  await options.goto(OPTIONS)
  await expect(options.getByTestId('sem-helper')).toContainText('Salvando em Downloads/Gravações de calls.')
  await expect(options.getByTestId('sem-helper')).not.toHaveClass(/amber|red/)
  await expect(options.getByLabel('Pasta das gravações', { exact: true })).toHaveCount(0)
  // Emenda 21: a seção da transcrição existe sem o helper (o motor por API funciona sem ele), e o
  // motor local, dentro dela, é que diz que precisa do helper.
  await expect(options.getByTestId('secao-transcricao')).toHaveCount(1)
  await expect(options.getByTestId('transcricao-sem-helper')).toContainText('exige o helper local, ainda não distribuído pela loja')
  const advanced = options.getByTestId('secao-avancado')
  await expect(advanced).toContainText('ainda não distribuído pela loja')
  await expect(advanced.getByTestId('secao-helper')).toContainText('npm run instalar')
  await expect(advanced.getByTestId('pasta-avancado')).toContainText('exige o helper local')
  // Nada em vermelho ou âmbar na página quando o helper simplesmente não existe. O aviso de
  // privacidade do motor por API (Emenda 21) fica de fora: ele é um alerta de verdade, sobre o
  // áudio sair do computador, e não tem nada a ver com o helper.
  expect(await options.locator('[class*="amber"]:not([data-testid="transcricao-api-privacidade"]), [class*="red-"]').count()).toBe(0)
  await expect(options.getByTestId('previa-pasta')).toHaveText('Downloads/Gravações de calls/AAAA-MM/AAAA-MM-DD HHhMM - título (Meet|Teams)/')
})

test('AC13: 60 s sem áudio deixa o REC âmbar e mostra UMA notificação sugerindo o modo aba; com áudio fica vermelho', async () => {
  const h = await launch({ routes: silentPeerRoute })
  const api = swApi(h.sw)
  // 60 s viram 1 s (o SW confere a cada session:diag, a cada 5 s).
  await api.testing('noAudioAlertMs', 1_000)

  await startPeer(h.context, 'mudo', 'variante=mudo&tom=440')
  await startPeer(h.context, 'som', 'tom=440')
  const mute = await joinMeet(h, 'mudo')
  const sound = await joinMeet(h, 'som', 'xyz-abcd-efg')
  const t0 = Date.now()

  await expect.poll(async () => (await badgeOf(h.sw, mute.tabId)).color, { timeout: 15_000, intervals: [250] }).toEqual(AMBER)
  const amberMs = Date.now() - t0
  expect(await badgeOf(h.sw, mute.tabId)).toEqual({ text: 'REC', color: AMBER })
  const noteId = `sem-audio:${mute.tabId}:${mute.sessionId}`
  await expect.poll(() => notifications(h.sw)).toEqual([noteId])
  const shortcut = await h.sw.evaluate(async () => (await chrome.commands.getAll()).find((c) => c.name === 'gravar-aba')?.shortcut ?? '')
  const [note] = await shownHistory(h.sw)
  expect(note.title).toBe('Não está chegando áudio')
  expect(note.message).toContain('Grave pela captura da aba')
  expect(note.message).toContain('"Gravar esta aba" no popup')
  if (shortcut) expect(note.message).toContain(`atalho ${shortcut}`)

  // A call com som segue vermelha e sem notificação depois de vários diagnósticos.
  await sound.call.waitForTimeout(11_000)
  expect(await badgeOf(h.sw, sound.tabId)).toEqual({ text: 'REC', color: RED })
  expect((await shownHistory(h.sw)).map((n) => n.id)).toEqual([noteId])

  // Uma só, mesmo depois de o SW reiniciar (a sessão volta com o aviso "não mostrado" em memória).
  expect(await stopExtensionServiceWorker(h)).toContain('stopped')
  await mute.call.waitForTimeout(12_000)
  const sw = await currentServiceWorker(h)
  expect((await swApi(sw).activeRecordings()).map((a) => a.sessionId).sort()).toEqual([mute.sessionId, sound.sessionId].sort())
  // O gancho do limite é memória do SW: rearma. A sessão recarregada do IndexedDB chama
  // notifyNoAudio de novo no próximo diagnóstico (logo depois de pintar o âmbar).
  await swApi(sw).testing('noAudioAlertMs', 1_000)
  await expect.poll(async () => (await badgeOf(sw, mute.tabId)).color, { timeout: 15_000, intervals: [250] }).toEqual(AMBER)
  await mute.call.waitForTimeout(1_000)
  expect((await shownHistory(sw)).map((n) => n.id)).toEqual([noteId])
  expect(await notifications(sw)).toEqual([noteId])

  // Clique na notificação: foca a aba da call (outra aba está na frente).
  const other = await h.context.newPage()
  await other.goto('about:blank')
  await expect.poll(() => sw.evaluate((id) => chrome.tabs.get(id).then((t) => t.active), mute.tabId)).toBe(false)
  expect(await swApi(sw).testing('handleNotificationClick', noteId, null)).toEqual({ ok: true, tabId: mute.tabId, action: 'focar' })
  expect(await sw.evaluate((id) => chrome.tabs.get(id).then((t) => t.active), mute.tabId)).toBe(true)
  expect(await notifications(sw)).toEqual([])
  console.log(`AC13: badge âmbar ${amberMs} ms depois do início com o limite em 1 s; 1 notificação antes e depois do reinício do SW`)
})

/**
 * Páginas simples do Teams e da página inicial do Meet (as rotas padrão respondem 204 nelas) e
 * uma página fora dos hosts das calls (sem rede de verdade).
 */
async function plainPagesRoute(context: BrowserContext): Promise<void> {
  await context.route(
    (url) => url.searchParams.has('antiga') || url.searchParams.has('inicio') || url.hostname === 'example.com',
    (route) => fulfillHtml(route, '<!doctype html><title>Página</title><p>página</p>'),
  )
}

test('AC16: o popup aberto sobre uma aba marcada com ↻ diz que ela não grava até recarregar (Emenda 10)', async () => {
  const h = await launch({ installHost: false, routes: plainPagesRoute })
  const meet = await h.context.newPage()
  await meet.goto('https://meet.google.com/abc-defg-hij?variante=normal&sala=antiga-popup')
  const meetId = await tabIdOf(h.sw, 'sala=antiga-popup')
  const matches = await h.sw.evaluate(() => [...new Set(chrome.runtime.getManifest().content_scripts!.flatMap((c) => c.matches ?? []))])
  await swApi(h.sw).testing('markTabsOpenedBeforeInstall', matches)
  const popup = await h.context.newPage()
  await popup.goto(`${POPUP}?tabId=${meetId}`)
  await expect(popup.getByTestId('recarregar-aba')).toContainText('não grava até ser recarregada')
  await expect(popup.getByTestId('recarregar-aba')).toContainText('sai da call')
})

test('AC16: abas de call abertas antes da instalação ganham ↻ e aviso; pushState não tira, documento novo tira; clique foca', async () => {
  const h = await launch({ installHost: false, routes: plainPagesRoute })
  const api = swApi(h.sw)
  const meet = await h.context.newPage()
  await meet.goto('https://meet.google.com/abc-defg-hij?variante=normal&sala=antiga')
  const meet2 = await h.context.newPage()
  await meet2.goto('https://meet.google.com/xyz-abcd-efg?variante=normal&sala=outra-antiga')
  const teams = await h.context.newPage()
  await teams.goto('https://teams.microsoft.com/v2/?antiga=1')
  const landing = await h.context.newPage()
  await landing.goto('https://meet.google.com/?inicio=1')
  const meetId = await tabIdOf(h.sw, 'sala=antiga')
  const meet2Id = await tabIdOf(h.sw, 'sala=outra-antiga')
  const teamsId = await tabIdOf(h.sw, 'antiga=1')
  const landingId = await tabIdOf(h.sw, 'inicio=1')
  const reloadList = () => h.sw.evaluate(async () => ((await chrome.storage.session.get('abasParaRecarregar')).abasParaRecarregar ?? []) as number[])
  const isActive = (id: number) => h.sw.evaluate((t) => chrome.tabs.get(t).then((x) => x.active), id)
  const sorted = (a: number[]) => [...a].sort((x, y) => x - y)

  const matches = await h.sw.evaluate(() => [...new Set(chrome.runtime.getManifest().content_scripts!.flatMap((c) => c.matches ?? []))])
  const marked = sorted(await api.testing<number[]>('markTabsOpenedBeforeInstall', matches))
  expect(marked).toEqual(sorted([meetId, meet2Id, teamsId]))
  for (const id of marked) expect(await badgeOf(h.sw, id)).toEqual({ text: '↻', color: BLUE })
  expect((await badgeOf(h.sw, landingId)).text).toBe('')
  expect(await notifications(h.sw)).toEqual([`recarregar:${meetId}`, `recarregar:${meet2Id}`, `recarregar:${teamsId}`].sort())
  for (const n of await shownHistory(h.sw)) {
    expect(n.title).toBe('Recarregue a aba da call')
    expect(n.message).toContain('Recarregue a aba para gravar a call')
  }

  // Clique no corpo de um aviso do Meet: foca a aba (a da página inicial está na frente).
  expect(await isActive(meet2Id)).toBe(false)
  expect(await api.testing('handleNotificationClick', `recarregar:${meet2Id}`, null)).toEqual({ ok: true, tabId: meet2Id, action: 'focar' })
  expect(await isActive(meet2Id)).toBe(true)
  expect(await notifications(h.sw)).toEqual([`recarregar:${meetId}`, `recarregar:${teamsId}`].sort())
  // Focar não recarrega: o ↻ continua até a aba recarregar.
  expect((await badgeOf(h.sw, meet2Id)).text).toBe('↻')
  // Fechar a aba marcada a tira da lista.
  await meet2.close()
  await expect.poll(async () => sorted(await reloadList())).toEqual(sorted([meetId, teamsId]))

  // Navegação dentro da página (o Teams é aplicação de página única): o documento continua sem
  // os content scripts, então o ↻ e o aviso ficam.
  await teams.evaluate(() => history.pushState({}, '', '/v2/?antiga=1&calendario=1'))
  await teams.waitForTimeout(1_000)
  expect(await badgeOf(h.sw, teamsId)).toEqual({ text: '↻', color: BLUE })
  expect(await notifications(h.sw)).toEqual([`recarregar:${meetId}`, `recarregar:${teamsId}`].sort())
  // A página inicial do Meet indo para uma reunião sem documento novo ganha o ↻ e o aviso.
  await landing.evaluate(() => history.pushState({}, '', '/abc-defg-hij?inicio=1'))
  await expect.poll(async () => (await badgeOf(h.sw, landingId)).text).toBe('↻')
  await expect.poll(() => notifications(h.sw)).toEqual([`recarregar:${meetId}`, `recarregar:${teamsId}`, `recarregar:${landingId}`].sort())
  expect(await badgeOf(h.sw, teamsId)).toEqual({ text: '↻', color: BLUE })
  expect(sorted(await reloadList())).toEqual(sorted([meetId, teamsId, landingId]))

  // Botão "Recarregar agora" do aviso do Teams: recarrega e foca; o ↻ some.
  const reloaded = teams.waitForEvent('load', { timeout: 15_000 })
  expect(await api.testing('handleNotificationClick', `recarregar:${teamsId}`, 0)).toEqual({ ok: true, tabId: teamsId, action: 'recarregar' })
  await reloaded
  await expect.poll(async () => (await badgeOf(h.sw, teamsId)).text).toBe('')
  await expect.poll(async () => sorted(await reloadList())).toEqual(sorted([meetId, landingId]))
  expect(await isActive(teamsId)).toBe(true)

  // Um iframe novo nos hosts das calls traz os nossos scripts só para ele (o relay é all_frames e
  // conecta no hello da frame): o documento do topo continua sem eles, então o ↻ e o aviso ficam.
  // Só o Port da frame do topo tira.
  await h.sw.evaluate(() => {
    const g = globalThis as any
    g.__framePorts = []
    chrome.runtime.onConnect.addListener((p) => g.__framePorts.push({ name: p.name, tab: p.sender?.tab?.id, frameId: p.sender?.frameId }))
  })
  await meet.evaluate(() => {
    const f = document.createElement('iframe')
    f.src = 'https://meet.google.com/?inicio=frame'
    document.body.append(f)
  })
  const subframePorts = () =>
    h.sw.evaluate((id) => ((globalThis as any).__framePorts as Array<{ name: string; tab: number; frameId: number }>).filter((p) => p.tab === id && p.frameId !== 0).map((p) => p.name), meetId)
  await expect.poll(subframePorts, { timeout: 10_000 }).toContain('gravador:sessao')
  await meet.waitForTimeout(500)
  expect(await badgeOf(h.sw, meetId)).toEqual({ text: '↻', color: BLUE })
  expect(await notifications(h.sw)).toContain(`recarregar:${meetId}`)
  expect(await reloadList()).toContain(meetId)

  // O usuário recarrega a aba do Meet sem tocar no aviso: o ↻ e o aviso dela somem.
  expect(await notifications(h.sw)).toContain(`recarregar:${meetId}`)
  await meet.reload()
  await expect.poll(async () => (await badgeOf(h.sw, meetId)).text).toBe('')
  await expect.poll(() => notifications(h.sw)).toEqual([`recarregar:${landingId}`])
  expect(await reloadList()).toEqual([landingId])

  // Saiu dos hosts das calls (outro documento, sem os nossos scripts): esquece a aba.
  await landing.goto('https://example.com/')
  await expect.poll(() => notifications(h.sw)).toEqual([])
  expect(await reloadList()).toEqual([])
  expect(h.pageErrors).toEqual([])
})

test('a API do popup recusa mensagens de content script: só páginas da extensão leem o estado e mudam as configurações (Emenda 5)', async () => {
  const h = await launch({ installHost: false })
  const call = await h.context.newPage()
  await call.goto('https://meet.google.com/abc-defg-hij?variante=normal&sala=api')
  // O mundo ISOLATED da extensão nesta aba (o do relay e do vigia), pelo CDP.
  const cdp = await h.context.newCDPSession(call)
  const worlds: Array<{ id: number; name: string; type: string }> = []
  cdp.on('Runtime.executionContextCreated', (e: any) => worlds.push({ id: e.context.id, name: e.context.name, type: e.context.auxData?.type }))
  await cdp.send('Runtime.enable')
  await expect.poll(() => worlds.filter((w) => w.type === 'isolated' && w.name === 'Gravador de Calls').length).toBeGreaterThan(0)
  const world = worlds.find((w) => w.type === 'isolated' && w.name === 'Gravador de Calls')!
  const inContentScript = async (expression: string) => {
    const r = (await cdp.send('Runtime.evaluate', { expression, contextId: world.id, awaitPromise: true, returnByValue: true })) as any
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails))
    return r.result.value
  }
  // É mesmo o mundo da extensão: tem chrome.runtime com o ID dela.
  expect(await inContentScript('chrome.runtime.id')).toBe(EXTENSION_ID)
  const ask = (msg: object) =>
    inContentScript(`chrome.runtime.sendMessage(${JSON.stringify(msg)}).then((r) => ({ resposta: r ?? null }), (e) => ({ erro: String(e && e.message || e) }))`)

  const state = await ask({ t: 'ui:state' })
  expect(state.resposta, `o content script leu o estado: ${JSON.stringify(state)}`).toBeNull()
  const before = (await h.sw.evaluate(async () => (await chrome.storage.local.get('settings')).settings)) as Record<string, unknown>
  const saved = await ask({ t: 'ui:save-settings', settings: { ...before, autoMeet: false, minSeconds: 999 } })
  expect(saved.resposta).toBeNull()
  expect(await h.sw.evaluate(async () => (await chrome.storage.local.get('settings')).settings)).toEqual(before)
  await cdp.detach()

  // Controle: a mesma mensagem de uma página da extensão é respondida.
  const popup = await h.context.newPage()
  await popup.goto(POPUP)
  expect(await popup.evaluate(() => chrome.runtime.sendMessage({ t: 'ui:state' }))).toMatchObject({ active: [], recent: [] })
  expect(h.pageErrors).toEqual([])
})
