// "Quando sair" nas configurações (Emenda 16, 0.3.1), em português e em inglês: as três escolhas
// escritas por extenso, a confirmação em segundos, o exemplo que acompanha as escolhas, o que fica
// guardado, e o vigia de uma call do Teams falsa (tests/fixtures/vigia/teams-page.ts) usando o que
// foi escolhido na página. As capturas da seção vão para test-results (verificação visual).
import { copyFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page, type TestInfo } from '@playwright/test'
import { EXTENSION_ID, launchWithExtension, type Harness } from '../helpers/browser'
import { fx, indicador, novaAba, quandoFechar, tabIdOf, ultimoTexto, vigiaEventos } from '../fixtures/vigia/e2e'
import { installVigiaRoutes } from '../fixtures/vigia/routes'

const OPTIONS = `chrome-extension://${EXTENSION_ID}/src/options/index.html`

let h: Harness | undefined

test.afterEach(async ({}, testInfo) => {
  if (h && testInfo.status !== testInfo.expectedStatus) {
    await testInfo.attach('console', { body: h.logs.join('\n'), contentType: 'text/plain' })
    console.log(h.logs.join('\n'))
  }
  await h?.close()
  h = undefined
})

interface TeamsFx {
  n: number
  hangupClicks: number
  leftAt: number | null
}

const storedVigia = () => h!.sw.evaluate(async () => ((await chrome.storage.local.get('settings')).settings as any)?.vigia)

/** Captura a seção (test-results; e, com VIGIA_UX_SHOTS, uma cópia nessa pasta). */
async function shot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const path = testInfo.outputPath(name)
  await page.getByTestId('secao-sair').screenshot({ path })
  const dir = process.env.VIGIA_UX_SHOTS
  if (dir) {
    mkdirSync(dir, { recursive: true })
    copyFileSync(path, join(dir, name))
  }
}

async function abrirCall(n: number): Promise<Page> {
  const page = await novaAba(h!.context)
  await page.goto(`https://teams.microsoft.com/v2/?n=${n}&painel=aberto`)
  await page.click('#entrar')
  await expect(page.locator('#hangup-button')).toBeVisible()
  return page
}

const setN = (page: Page, n: number) => page.evaluate((x) => (window as any).vigiaFx.setN(x), n)

test('em português: cada escolha muda o exemplo, fica guardada, e o vigia da call usa a escolhida', async ({}, testInfo) => {
  h = await launchWithExtension({ installHost: false, routes: installVigiaRoutes })
  const options = await h.context.newPage()
  await options.setViewportSize({ width: 760, height: 1200 })
  await options.goto(OPTIONS)
  const sec = options.getByTestId('secao-sair')
  const exemplo = options.getByTestId('vigia-exemplo')
  const save = options.getByRole('button', { name: 'Salvar', exact: true })

  // Padrão: desligado, a regra do script (30% do pico, 20 s de confirmação).
  await expect(sec.getByLabel('Sair e fechar a aba quando a call esvaziar')).not.toBeChecked()
  await expect(sec.getByRole('radio', { name: 'Quando sair boa parte das pessoas' })).toBeChecked()
  await expect(sec.getByLabel('Quanto do maior número de pessoas pode restar')).toHaveValue('0.3')
  await expect(sec.getByLabel('Confirmar antes de sair')).toHaveValue('4')
  await expect(sec.getByLabel('Confirmar antes de sair').locator('option:checked')).toHaveText('20 s')
  await expect(exemplo).toHaveText(
    'Exemplo: numa call que chegou a 10 pessoas, o vigia sai quando restarem 3 ou menos, depois de 20 s confirmando. Se você ficar sozinho, sai na hora. Numa call que nunca passou de 3 pessoas, só sai quando você ficar sozinho.',
  )
  await expect(sec.getByTestId('regra-saida')).toHaveAttribute('data-ligado', 'nao')
  await sec.getByLabel('Sair e fechar a aba quando a call esvaziar').check()
  await expect(sec.getByTestId('regra-saida')).toHaveAttribute('data-ligado', 'sim')

  // Metade: escolher no seletor marca a escolha sozinho.
  await sec.getByRole('radio', { name: 'Quando eu ficar sozinho na call' }).check()
  await sec.getByLabel('Quanto do maior número de pessoas pode restar').selectOption({ label: 'metade (50%)' })
  await expect(sec.getByRole('radio', { name: 'Quando sair boa parte das pessoas' })).toBeChecked()
  await expect(exemplo).toHaveText(
    'Exemplo: numa call que chegou a 10 pessoas, o vigia sai quando restarem 5 ou menos, depois de 20 s confirmando. Se você ficar sozinho, sai na hora. Numa call que nunca passou de 3 pessoas, só sai quando você ficar sozinho.',
  )
  await shot(options, testInfo, 'opcoes-sair-pt-metade.png')

  // Quantidade: digitar o número marca a escolha.
  await sec.getByLabel('Número de pessoas, contando você').fill('3')
  await expect(sec.getByRole('radio', { name: 'Quando restarem poucas pessoas' })).toBeChecked()
  await sec.getByLabel('Confirmar antes de sair').selectOption({ label: 'na hora' })
  await expect(exemplo).toHaveText(
    'Exemplo: numa call que chegou a 10 pessoas, o vigia sai quando restarem 3 ou menos, sem esperar. Se você ficar sozinho, sai na hora. Numa call que nunca passou de 3 pessoas, só sai quando você ficar sozinho.',
  )
  // Fora de 1 a 50: o exemplo pede a correção e o Salvar mostra a mensagem.
  await sec.getByLabel('Número de pessoas, contando você').fill('0')
  await expect(exemplo).toHaveText('Corrija os números para ver o exemplo.')
  await save.click()
  await expect(sec.getByText('escolha de 1 a 50 pessoas')).toBeVisible()
  await sec.getByLabel('Número de pessoas, contando você').fill('3')
  await expect(sec.getByText('escolha de 1 a 50 pessoas')).toHaveCount(0)
  await shot(options, testInfo, 'opcoes-sair-pt-quantidade.png')

  // Sozinho: a confirmação some (não se aplica) e o exemplo diz só isso.
  await sec.getByLabel('Quando eu ficar sozinho na call').check()
  await expect(sec.getByLabel('Confirmar antes de sair')).toHaveCount(0)
  await expect(exemplo).toHaveText('Exemplo: numa call que chegou a 10 pessoas, o vigia espera todo mundo sair e sai na hora em que você ficar sozinho.')

  // Ajustes finos: uma leitura por segundo (para o teste não esperar 5 s por leitura).
  await sec.getByText('Ajustes finos').click()
  await expect(sec.getByText('Numa call menor, só sai quando você ficar sozinho. Padrão: 4.')).toBeVisible()
  await sec.getByLabel('Conferir a contagem a cada (segundos)').fill('1')
  await shot(options, testInfo, 'opcoes-sair-pt-sozinho-ajustes.png')
  await save.click()
  await expect(options.getByTestId('salvar-mensagem')).toHaveText('Configurações deste perfil salvas.')
  expect(await storedVigia()).toEqual({ modo: 'sozinho', quantidade: 3, intervaloSeg: 1, fracao: 0.5, minimo: 2, picoParaQueda: 4, confirmacoes: 1, faltasParaFim: 3 })

  // Recarregada, a página mostra o que ficou.
  await options.reload()
  await expect(sec.getByLabel('Quando eu ficar sozinho na call')).toBeChecked()
  await expect(sec.getByLabel('Número de pessoas, contando você')).toHaveValue('3')
  await expect(sec.getByLabel('Quanto do maior número de pessoas pode restar')).toHaveValue('0.5')

  // O vigia usa "sozinho": numa call de 10, ficar com 2 não sai.
  const call = await abrirCall(10)
  await expect.poll(() => ultimoTexto(call)).toBe('vigia: 10 na call · pico 10 · sai se você ficar sozinho · via painel People')
  await setN(call, 2)
  await expect.poll(() => ultimoTexto(call)).toBe('vigia: 2 na call · pico 10 · sai se você ficar sozinho · via painel People')
  await call.waitForTimeout(3_000)
  expect((await fx<TeamsFx>(call)).hangupClicks).toBe(0)

  // Trocada para "3 ou menos, na hora" com a call aberta: a próxima leitura já sai.
  const tabId = await tabIdOf(h, call)
  const closed = quandoFechar(call)
  await options.getByRole('radio', { name: 'Quando restarem poucas pessoas' }).check()
  await expect(sec.getByLabel('Confirmar antes de sair')).toHaveValue('1')
  await save.click()
  await expect(options.getByTestId('salvar-mensagem')).toHaveText('Configurações deste perfil salvas.')
  await expect.poll(async () => (await fx<TeamsFx>(call)).leftAt, { timeout: 5_000, intervals: [50] }).not.toBeNull()
  await closed
  // Com 1 confirmação, a leitura que decide e o "saindo" caem no mesmo tick (o indicador só mostra
  // o segundo); a leitura fica no log do vigia.
  expect(h.logs.some((l) => l.includes('2 na call · pico 10 · sai com 3 ou menos · confirmando 1/1 · via painel People'))).toBe(true)
  expect((await indicador(call)).map((l) => l.text).slice(-2)).toEqual(['vigia: saindo da call (tentativa 1)...', 'vigia: fechando...'])
  expect((await vigiaEventos(h)).map((e) => [e.t, e.tabId, e.motivo])).toEqual([
    ['saindo', tabId, 'caiu de 10 para 2'],
    ['fechou', tabId, 'saiu-da-call'],
  ])
  expect(h.pageErrors).toEqual([])
})

test('em inglês: as escolhas e o exemplo em inglês, guardados, e o vigia sai com metade da call', async ({}, testInfo) => {
  h = await launchWithExtension({ installHost: false, routes: installVigiaRoutes, locale: 'en-US' })
  const options = await h.context.newPage()
  await options.setViewportSize({ width: 760, height: 1200 })
  await options.goto(OPTIONS)
  const sec = options.getByTestId('secao-sair')
  const exemplo = options.getByTestId('vigia-exemplo')

  await expect(sec.getByRole('heading', { name: 'Leave and close the call automatically' })).toBeVisible()
  await expect(sec.getByText('When to leave')).toBeVisible()
  await sec.getByLabel('Leave and close the tab when the call empties').check()
  await sec.getByRole('radio', { name: "When I'm alone in the call" }).check()
  await expect(exemplo).toHaveText('Example: in a call that reached 10 people, auto-leave waits for everyone else to go and exits as soon as you are alone.')
  await sec.getByLabel('Number of people, counting you').fill('4')
  await expect(sec.getByRole('radio', { name: 'When only a few people remain' })).toBeChecked()
  await expect(exemplo).toHaveText(
    'Example: in a call that reached 10 people, auto-leave exits when 4 or fewer remain, after confirming for 20 s. If you are alone, it exits right away. In a call that never had more than 4 people, it only exits when you are alone.',
  )
  await sec.getByLabel("How much of the call's largest number of people may remain").selectOption({ label: 'half (50%)' })
  await expect(sec.getByRole('radio', { name: 'When most people have left' })).toBeChecked()
  await sec.getByLabel('Confirm before leaving').selectOption({ label: '10 s' })
  await expect(exemplo).toHaveText(
    'Example: in a call that reached 10 people, auto-leave exits when 5 or fewer remain, after confirming for 10 s. If you are alone, it exits right away. In a call that never had more than 3 people, it only exits when you are alone.',
  )
  // Uma leitura por segundo: as 2 confirmações passam a dar 2 s, e o exemplo acompanha.
  await sec.getByText('Fine-tuning').click()
  await sec.getByLabel('Check the count every (seconds)').fill('1')
  await expect(sec.getByLabel('Confirm before leaving').locator('option:checked')).toHaveText('2 s')
  await expect(exemplo).toContainText('when 5 or fewer remain, after confirming for 2 s.')
  // Mensagem da combinação que sairia de uma call cheia, nos rótulos novos.
  await sec.getByLabel('"Most people have left": also leave when at most this many remain (people)').fill('4')
  await options.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(sec.getByText('use a number larger than "also leave when at most this many remain" (4); otherwise it would leave a full call')).toBeVisible()
  await sec.getByLabel('"Most people have left": also leave when at most this many remain (people)').fill('2')
  // Corrigido o outro campo, a mensagem some sem precisar mexer no pico.
  await expect(sec.getByText(/use a number larger than/)).toHaveCount(0)
  await shot(options, testInfo, 'opcoes-sair-en-metade-ajustes.png')
  await options.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(options.getByTestId('salvar-mensagem')).toHaveText("This profile's settings were saved.")
  expect(await storedVigia()).toEqual({ modo: 'proporcao', quantidade: 4, intervaloSeg: 1, fracao: 0.5, minimo: 2, picoParaQueda: 4, confirmacoes: 2, faltasParaFim: 3 })
  await options.reload()
  await expect(sec.getByRole('radio', { name: 'When most people have left' })).toBeChecked()
  await expect(sec.getByLabel("How much of the call's largest number of people may remain").locator('option:checked')).toHaveText('half (50%)')

  // O vigia: numa call de 10, 6 não sai; 5 sai depois de 2 leituras.
  const call = await abrirCall(10)
  await expect.poll(() => ultimoTexto(call)).toBe('auto-leave: 10 in the call · peak 10 · leaves at 5 or fewer · via People panel')
  await setN(call, 6)
  await expect.poll(() => ultimoTexto(call)).toBe('auto-leave: 6 in the call · peak 10 · leaves at 5 or fewer · via People panel')
  await call.waitForTimeout(3_000)
  expect((await fx<TeamsFx>(call)).hangupClicks).toBe(0)
  const closed = quandoFechar(call)
  await setN(call, 5)
  await expect.poll(async () => (await fx<TeamsFx>(call)).leftAt, { timeout: 6_000, intervals: [50] }).not.toBeNull()
  await closed
  const textos = (await indicador(call)).map((l) => l.text)
  expect(textos).toContain('auto-leave: 5 in the call · peak 10 · leaves at 5 or fewer · confirming 1/2 · via People panel')
  expect((await vigiaEventos(h)).filter((e) => e.t === 'saindo').map((e) => e.motivo)).toEqual(['caiu de 10 para 5'])
  expect(h.pageErrors).toEqual([])
})
