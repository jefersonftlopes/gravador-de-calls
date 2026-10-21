// A permissão do microfone no documento offscreen (Emenda 25), MEDIDA num Chrome de verdade antes
// de escolher o caminho.
//
// O problema: o documento offscreen não tem interface, então ele não consegue pedir permissão (não
// há onde o Chrome mostrar o diálogo). O caminho da scre.io, que a Emenda 25 segue, é pedir UMA vez
// numa página visível da extensão (as configurações, no clique em que o usuário liga o recurso) e
// deixar o offscreen usar depois, porque a permissão é da ORIGEM chrome-extension://.
//
// É isso que estes dois testes medem:
//
// 1. a permissão concedida para a origem da extensão vale no documento offscreen, que então abre o
//    microfone;
// 2. sem ela, o getUserMedia do offscreen FALHA ("Permission dismissed": não há onde perguntar). Ele
//    não tem como contornar, e é por isso que `audioCapture` NÃO é declarado no manifesto: essa
//    permissão concederia sem perguntar, e para um recurso de microfone o aviso visível vale mais
//    que a conveniência.
//
// Limites declarados da medida: os dois testes rodam SEM o `--use-fake-ui-for-media-stream` (que
// aceita todo pedido de mídia e esconde justamente o que se quer medir: com ele o offscreen já
// responde `granted`, medido em 21/10/2026, e nada é gravado no perfil). No lugar do clique em
// "Permitir", que no headless ninguém pode dar, o teste 1 grava no perfil a mesma exceção de
// conteúdo que o clique grava (`seedMicPermission`), porque o CDP recusa conceder permissão a uma
// origem `chrome-extension://` ("Permission can't be granted to opaque origins"). O teste 2 nega com
// `--deny-permission-prompts`.
import { existsSync, readFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import { EXTENSION_ID, launchWithExtension, seedMicPermission, type Harness } from '../helpers/browser'
import type { MicOffscreenState } from '../../src/shared/protocol'

let h: Harness | undefined

test.afterEach(async ({}, testInfo) => {
  if (h && testInfo.status !== testInfo.expectedStatus) {
    const log = existsSync(h.hostLog) ? readFileSync(h.hostLog, 'utf8') : '(sem log do helper)'
    await testInfo.attach('console', { body: `${h.logs.join('\n')}\n--- helper.log ---\n${log}`, contentType: 'text/plain' })
    console.log(h.logs.join('\n'))
  }
  await h?.close()
  h = undefined
})

const TAB = 4321

/** Estado do microfone no offscreen (abre o documento se preciso). */
const micState = (hh: Harness) => offscreen<MicOffscreenState>(hh, { target: 'offscreen', t: 'offscreen:mic-state' })

const offscreen = <T>(hh: Harness, req: object) =>
  hh.sw.evaluate(
    (r) => (globalThis as unknown as { __gravador: { sendToOffscreen(x: unknown): Promise<unknown> } }).__gravador.sendToOffscreen(r),
    req,
  ) as Promise<T>

test('a permissão da origem da extensão vale no documento offscreen, e ele abre o microfone', async () => {
  h = await launchWithExtension({ fakeMediaUi: false, beforeLaunch: ({ userDataDir }) => seedMicPermission(userDataDir) })

  // O offscreen vê a permissão da origem (o clique do usuário na página de configurações).
  const estado = await micState(h)
  console.log(`offscreen com a permissão da origem: permissao=${estado.permissao} capturando=${estado.capturando}`)
  expect(estado.permissao).toBe('granted')
  expect(estado.capturando, 'a permissão não abre o microfone sozinha').toBe(false)

  // A página visível da extensão também consegue (é ela que pede, no clique do usuário).
  const page = await h.context.newPage()
  await page.goto(`chrome-extension://${EXTENSION_ID}/src/options/index.html`)
  const pedido = await page.evaluate(async () => {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true })
      const faixas = s.getAudioTracks().length
      for (const t of s.getTracks()) t.stop()
      return { ok: true, faixas }
    } catch (e) {
      return { ok: false, erro: String((e as Error)?.message ?? e) }
    }
  })
  console.log(`página de configurações: ${JSON.stringify(pedido)}`)
  expect(pedido.ok, `a página da extensão não conseguiu o microfone: ${JSON.stringify(pedido)}`).toBe(true)
  await page.close()

  // E o offscreen abre o microfone quando o portão manda.
  expect(
    await offscreen<{ ok: boolean }>(h, { target: 'offscreen', t: 'offscreen:mic-start', tabId: TAB, sessionId: '20261021-120000-4321-abcd' }),
  ).toEqual({ ok: true })
  const aberto = await offscreen<{ ok: boolean; error?: string }>(h, { target: 'offscreen', t: 'offscreen:mic-gate', tabId: TAB, open: true, waitMs: 0 })
  console.log(`offscreen abriu o microfone: ${JSON.stringify(aberto)}`)
  expect(aberto.ok, `o offscreen não abriu o microfone: ${aberto.error}`).toBe(true)
  // O nó é ligado `waitMs` depois (mais a margem de abertura), para nada de antes do desmudo entrar.
  await expect.poll(async () => (await micState(h!)).ligadas).toEqual([TAB])
  const ligado = await micState(h)
  expect(ligado.capturando).toBe(true)
  expect(ligado.erro).toBeNull()
  expect(ligado.jaLigadas).toEqual([TAB])

  await offscreen(h, { target: 'offscreen', t: 'offscreen:mic-stop', tabId: TAB })
  // Parado o último gravador, o microfone é solto (o indicador do Chrome apaga).
  await expect.poll(async () => (await micState(h!)).capturando).toBe(false)
})

test('sem a permissão, o getUserMedia do documento offscreen falha (ele não tem como pedir)', async () => {
  // Sem o --use-fake-ui-for-media-stream não há "Permitir" automático, e o --deny-permission-prompts
  // nega o pedido em vez de deixá-lo pendente para sempre.
  h = await launchWithExtension({ fakeMediaUi: false, extraArgs: ['--deny-permission-prompts'] })

  const antes = await micState(h)
  console.log(`offscreen sem permissão: permissao=${antes.permissao}`)
  expect(antes.permissao).toBe('prompt')

  expect(
    await offscreen<{ ok: boolean }>(h, { target: 'offscreen', t: 'offscreen:mic-start', tabId: TAB, sessionId: '20261021-120000-4321-abce' }),
  ).toEqual({ ok: true })
  const r = await offscreen<{ ok: boolean; error?: string; permission?: string }>(h, {
    target: 'offscreen',
    t: 'offscreen:mic-gate',
    tabId: TAB,
    open: true,
    waitMs: 0,
  })
  console.log(`offscreen sem permissão, abrir o portão: ${JSON.stringify(r)}`)
  expect(r.ok).toBe(false)
  expect(r.error, 'o motivo do getUserMedia volta para o SW').toBeTruthy()
  // O portão nunca abriu: nada chegou ao gravador, e a sessão vai ser descartada pelo SW.
  const estado = await micState(h)
  expect(estado.capturando).toBe(false)
  expect(estado.ligadas).toEqual([])
  expect(estado.jaLigadas).toEqual([])
  await offscreen(h, { target: 'offscreen', t: 'offscreen:mic-stop', tabId: TAB })
})
