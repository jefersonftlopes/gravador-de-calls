// Emenda 22, ponta a ponta: a escolha do motor de transcrição nas configurações, SEM o helper (o
// cenário de quem instala pela Chrome Web Store, que é quem vê este passo a passo).
//
// O defeito relatado pelo usuário: "não to conseguindo selecionar o A API da OpenAI, com a sua
// chave". Na 0.5.0 o rádio era `checked={cfg.ativa}` e o `onChange` saía na primeira linha sem
// chave, então o rádio voltava sozinho para "O seu computador" e a única pista era um parágrafo no
// fim da seção. O primeiro teste daqui falha naquele código: o rádio não ficava marcado e a frase
// não aparecia junto da opção.
//
// O texto esperado do prompt vem de docs/PROMPT-INSTALAR.md, e não de um literal daqui: quem amarra
// aquele arquivo aos passos do código é tests/unit/prompt-instalar.test.ts. Assim a tela, o
// documento e o site são conferidos contra a mesma fonte, e esta spec não precisa importar o módulo
// da extensão (o loader do Playwright não lê o import de JSON das mensagens).
//
// Nenhum destes testes faz requisição de rede: ninguém grava call, o endereço aponta para o
// loopback e a chave é um literal FALSO deste arquivo. Quem prova que nada é enviado sem o motor
// ligado, sem chave, sem permissão ou com endereço de outra origem é
// tests/e2e/transcricao-api.spec.ts e src/background/api-transcription.test.ts.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { EXTENSION_ID, launchWithExtension, type Harness } from '../helpers/browser'
import { ROOT } from '../helpers/paths'

const OPTIONS = `chrome-extension://${EXTENSION_ID}/src/options/index.html`

/** Chave FALSA, literal deste arquivo. Nenhuma chave de verdade entra no repositório. */
const CHAVE_FALSA = 'sk-teste-falsa-1111111111111111111111'
/** Endereço no loopback: origem aceita no build de desenvolvimento, e ninguém escuta nessa porta. */
const ENDERECO_FALSO = 'http://127.0.0.1:9/v1/audio/transcriptions'

/** Os dois prompts do documento do repositório, na ordem em que ele os escreve (pt_BR e depois en). */
const [PROMPT_PT, PROMPT_EN] = [...readFileSync(join(ROOT, 'docs/PROMPT-INSTALAR.md'), 'utf8').matchAll(/```text\n([\s\S]*?)\n```/g)].map((m) => `${m[1]}\n`)

/** Quantos passos o prompt tem (um "Comandos:" por passo). */
const PASSOS = (PROMPT_PT.match(/\n {3}Comandos:/g) ?? []).length
/** O endereço do repositório que o prompt cita. */
const REPO = /^Projeto: (\S+)$/m.exec(PROMPT_PT)![1]

let h: Harness | undefined

test.beforeAll(() => {
  // Se o documento não trouxer os dois blocos, todo o resto desta spec mediria o nada.
  expect(PROMPT_PT, 'o bloco em português de docs/PROMPT-INSTALAR.md').toContain('Instalar a transcrição local')
  expect(PROMPT_EN, 'o bloco em inglês de docs/PROMPT-INSTALAR.md').toContain('Install local transcription')
  expect(PASSOS).toBeGreaterThan(1)
})

test.afterEach(async ({}, testInfo) => {
  if (h && testInfo.status !== testInfo.expectedStatus) {
    await testInfo.attach('console', { body: h.logs.join('\n'), contentType: 'text/plain' })
    console.log(h.logs.join('\n'))
  }
  await h?.close()
  h = undefined
})

/** Abre as configurações sem o helper (o uso normal de quem baixou da loja). */
async function abrirOpcoes(init?: () => void): Promise<Page> {
  h = await launchWithExtension({ installHost: false })
  const options = await h.context.newPage()
  if (init) await options.addInitScript(init)
  await options.goto(OPTIONS)
  await expect(options.getByTestId('secao-transcricao')).toBeVisible()
  return options
}

/** Abre o acordeão do passo a passo e espera o conteúdo. */
async function abrirPassoAPasso(options: Page): Promise<void> {
  const section = options.getByTestId('secao-transcricao')
  await section.getByTestId('passo-a-passo').getByText('Como instalar neste computador', { exact: false }).click()
  await expect(section.getByTestId('passo-a-passo-lista')).toBeVisible()
}

/** O texto exato do bloco do prompt (textContent, sem a normalização de espaços do toHaveText). */
const promptNaTela = (options: Page) => options.getByTestId('passo-a-passo-prompt').textContent()

const apiAtivaGuardada = (options: Page) =>
  options.evaluate(async () => ((await chrome.storage.local.get('settings')).settings as { apiTranscription?: { ativa?: boolean } } | undefined)?.apiTranscription?.ativa)

test('o defeito relatado: escolher a API sem chave troca o painel na hora e diz que falta a chave junto da opção', async () => {
  const options = await abrirOpcoes()
  const section = options.getByTestId('secao-transcricao')
  const motor = section.getByTestId('transcricao-motor')

  // Ao abrir, o painel começa no motor ativo: o local, que é o padrão.
  await expect(motor).toHaveAttribute('data-painel', 'local')
  await expect(section.getByTestId('motor-local')).toBeChecked()
  await expect(section.getByTestId('painel-local')).toBeVisible()
  await expect(section.getByTestId('painel-api')).toHaveCount(0)

  await section.getByTestId('motor-api').click()

  // O clique muda a tela, na hora: era isto que não acontecia.
  await expect(section.getByTestId('motor-api')).toBeChecked()
  await expect(section.getByTestId('motor-local')).not.toBeChecked()
  await expect(motor).toHaveAttribute('data-painel', 'api')
  await expect(section.getByTestId('painel-api')).toBeVisible()
  await expect(section.getByTestId('painel-local')).toHaveCount(0)

  // E diz o que falta JUNTO da opção, dentro do grupo das opções, não no fim da seção.
  const situacao = section.getByTestId('motor-situacao')
  await expect(situacao).toHaveAttribute('data-situacao', 'api-sem-chave')
  await expect(situacao).toContainText('Cole a chave da API antes de ligar.')
  await expect(section.locator('fieldset [data-testid="motor-situacao"]')).toHaveCount(1)

  // Escolher o painel não ligou nada e não salvou nada: sem `ativa: true` no storage (a seção pode
  // nem existir ainda, que é o estado de quem nunca mexeu nela).
  await expect(motor).toHaveAttribute('data-motor', 'local')
  expect(await apiAtivaGuardada(options)).not.toBe(true)
})

test('cada painel mostra só o que é dele: a chave e o endereço no da API, o passo a passo e o formulário no do computador', async () => {
  const options = await abrirOpcoes()
  const section = options.getByTestId('secao-transcricao')

  // Painel do computador (o de abrir): o passo a passo e o aviso de que o motor local precisa do
  // helper. Nada da chave, do custo nem do aviso de privacidade.
  await expect(section.getByTestId('passo-a-passo')).toBeVisible()
  await expect(section.getByTestId('transcricao-sem-helper')).toContainText('exige o helper local')
  await expect(section.getByTestId('transcricao-api-privacidade')).toHaveCount(0)
  await expect(section.getByTestId('transcricao-api-custo')).toHaveCount(0)
  await expect(section.getByLabel('Chave da API de transcrição')).toHaveCount(0)

  await section.getByTestId('motor-api').click()

  // Painel da API: o aviso de privacidade, o custo, o limite, a chave e o endereço. Nada do helper.
  await expect(section.getByTestId('transcricao-api-privacidade')).toContainText('o áudio da call, com a voz dos participantes, é enviado')
  await expect(section.getByTestId('transcricao-api-custo')).toContainText('US$ 0,36 por hora de call')
  await expect(section.getByTestId('transcricao-api-limite')).toContainText('25 MB')
  await expect(section.getByLabel('Chave da API de transcrição')).toBeVisible()
  await expect(section.getByText('Endereço da API', { exact: true })).toBeVisible()
  await expect(section.getByTestId('passo-a-passo')).toHaveCount(0)
  await expect(section.getByTestId('transcricao-sem-helper')).toHaveCount(0)
})

test('o painel do computador tem o acordeão do passo a passo, fechado por padrão, com os passos, o prompt e o link do projeto', async () => {
  const options = await abrirOpcoes()
  const section = options.getByTestId('secao-transcricao')
  const details = section.getByTestId('passo-a-passo')

  // Começa fechado: o conteúdo está no DOM, mas não visível.
  expect(await details.evaluate((el) => (el as HTMLDetailsElement).open)).toBe(false)
  await expect(section.getByTestId('passo-a-passo-lista')).not.toBeVisible()

  await abrirPassoAPasso(options)

  // Um item por passo do prompt, e o tamanho do download no passo do modelo.
  await expect(section.getByTestId('passo-a-passo-lista').locator('li')).toHaveCount(PASSOS)
  await expect(section.getByTestId('passo-a-passo-lista')).toContainText('1,6 GB de download')
  await expect(section.getByTestId('passo-a-passo-lista')).toContainText('o whisper.cpp e o ffmpeg')

  // O prompt da tela é, letra por letra, o de docs/PROMPT-INSTALAR.md.
  expect(await promptNaTela(options)).toBe(PROMPT_PT)
  await expect(section.getByTestId('passo-a-passo-prompt')).toContainText('npm run teste:transcricao-real')
  await expect(section.getByTestId('passo-a-passo-prompt')).toContainText('npm install')

  // O link para o repositório público, o mesmo que o prompt cita.
  await expect(section.getByRole('link', { name: 'Ver o projeto no GitHub' })).toHaveAttribute('href', REPO)
})

test('o botão Copiar confirma que copiou, e o que vai para a área de transferência é o prompt da tela', async () => {
  const options = await abrirOpcoes()
  const section = options.getByTestId('secao-transcricao')
  await abrirPassoAPasso(options)
  await section.getByTestId('passo-a-passo-copiar').click()
  await expect(section.getByTestId('passo-a-passo-copiado')).toHaveText('Copiado.')
  // A leitura da área de transferência pode ser recusada pelo Chrome; quando ela vem, é o prompt.
  const copiado = await options.evaluate(() => navigator.clipboard.readText().catch(() => null))
  if (copiado !== null) expect(copiado).toBe(PROMPT_PT)
})

test('o aviso de que o instalador existe só para macOS sai do chrome.runtime.getPlatformInfo, não do navegador', async () => {
  // Neste Mac o aviso não aparece.
  const noMac = await abrirOpcoes()
  await abrirPassoAPasso(noMac)
  await expect(noMac.getByTestId('passo-a-passo-so-mac')).toHaveCount(0)
  await h!.close()
  h = undefined

  // Com a plataforma respondendo Windows, o aviso aparece, e o passo a passo continua lá.
  const noWin = await abrirOpcoes(() => {
    const runtime = (globalThis as unknown as { chrome?: { runtime?: Record<string, unknown> } }).chrome?.runtime
    if (runtime) runtime.getPlatformInfo = () => Promise.resolve({ os: 'win', arch: 'x86-64', nacl_arch: 'x86-64' })
  })
  await abrirPassoAPasso(noWin)
  await expect(noWin.getByTestId('passo-a-passo-so-mac')).toContainText('O instalador existe só para macOS, e este computador é win.')
  await expect(noWin.getByTestId('passo-a-passo-lista')).toBeVisible()
})

test('o prompt sai no idioma da interface (Emenda 19): escolher English troca o texto na hora', async () => {
  const options = await abrirOpcoes()
  const section = options.getByTestId('secao-transcricao')
  await abrirPassoAPasso(options)
  expect(await promptNaTela(options)).toBe(PROMPT_PT)

  await options.getByTestId('idioma').selectOption({ label: 'English' })
  await expect(options.getByRole('heading', { name: 'Language' })).toBeVisible()
  await expect.poll(() => promptNaTela(options)).toBe(PROMPT_EN)
  await expect(section.getByTestId('passo-a-passo-lista')).toContainText('1.6 GB download')

  await options.getByTestId('idioma').selectOption('auto')
  await expect.poll(() => promptNaTela(options)).toBe(PROMPT_PT)
})

test('sem o helper, a situação do computador diz que falta instalar e manda para o passo a passo, sem tom de erro', async () => {
  const options = await abrirOpcoes()
  const section = options.getByTestId('secao-transcricao')
  const situacao = section.getByTestId('motor-situacao')
  await expect(situacao).toHaveAttribute('data-situacao', 'local-sem-helper')
  await expect(situacao).toContainText('Falta instalar o programa que transcreve')
  await expect(situacao).toContainText('O passo a passo está aqui embaixo')
  // Emenda 15: o único alerta âmbar ou vermelho da página continua sendo o aviso de privacidade da API.
  expect(await options.locator('[class*="amber"]:not([data-testid="transcricao-api-privacidade"]), [class*="red-"]').count()).toBe(0)
})

test('voltar para a opção do computador desliga o motor por API (escolha explícita de não mandar áudio para fora)', async () => {
  const options = await abrirOpcoes()
  const section = options.getByTestId('secao-transcricao')
  const motor = section.getByTestId('transcricao-motor')

  await section.getByTestId('motor-api').click()
  await section.getByText('Endereço da API', { exact: true }).click()
  await section.getByLabel('Endereço da API de transcrição').fill(ENDERECO_FALSO)
  await section.getByLabel('Endereço da API de transcrição').blur()
  await expect(section.getByTestId('transcricao-api-mensagem')).toContainText('Transcrição por API salva neste perfil')
  await section.getByLabel('Chave da API de transcrição').fill(CHAVE_FALSA)
  await section.getByRole('button', { name: 'Guardar a chave' }).click()
  await expect(section.getByTestId('transcricao-api-chave')).toContainText('••••1111')

  // Com chave e com a permissão do loopback já concedida, falta só ligar.
  await expect(section.getByTestId('motor-situacao')).toHaveAttribute('data-situacao', 'api-desligado')
  await section.getByTestId('motor-situacao-acao').click()
  await expect(motor).toHaveAttribute('data-motor', 'api')
  await expect(section.getByTestId('motor-situacao')).toHaveAttribute('data-situacao', 'api-ligado')
  expect(await apiAtivaGuardada(options)).toBe(true)

  // E escolher o computador desliga de verdade, no storage.
  await section.getByTestId('motor-local').click()
  await expect(motor).toHaveAttribute('data-painel', 'local')
  await expect(motor).toHaveAttribute('data-motor', 'local')
  await expect(section.getByTestId('transcricao-api-mensagem')).toContainText('Desligado: nenhuma call deste perfil é enviada para a API.')
  expect(await apiAtivaGuardada(options)).toBe(false)

  // A chave apagada também desliga, e a situação volta a dizer que falta a chave.
  await section.getByTestId('motor-api').click()
  await expect(section.getByTestId('motor-situacao')).toHaveAttribute('data-situacao', 'api-desligado')
  await section.getByTestId('transcricao-api-apagar-chave').click()
  await expect(section.getByTestId('motor-situacao')).toHaveAttribute('data-situacao', 'api-sem-chave')
})
