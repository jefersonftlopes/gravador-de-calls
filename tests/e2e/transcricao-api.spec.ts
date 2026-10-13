// Transcrição por API dentro da extensão (Emenda 21), ponta a ponta no Chrome for Testing, com um
// SERVIDOR FALSO local no lugar da API e uma chave FALSA. Nunca a API de verdade, nunca uma chave
// de verdade: o endereço aponta para 127.0.0.1 numa porta do teste, e a chave é um literal daqui.
//
// O cenário é o de quem instala pela Chrome Web Store: SEM o helper (installHost: false), com a
// gravação caindo em Downloads. É isso que o motor novo resolve.
//
// A call falsa do Meet é a mesma de tests/e2e/falantes.spec.ts (roster pelo `collections`, quem
// fala pelo `dcrpc`), então o transcricao.md tem de sair com os nomes de quem falou.
//
// Por que o endereço do servidor falso é http://127.0.0.1: o `chrome.permissions.request` de uma
// permissão de host precisa do diálogo do Chrome, e no headless a promessa nunca resolve (medido em
// 13/10/2026). O loopback está em `host_permissions` do build de desenvolvimento, então ele já vem
// concedido e o clique de ligar o motor resolve na hora. Quem prova que nada é enviado sem a
// permissão concedida é src/background/api-transcription.test.ts.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { EXTENSION_ID, currentServiceWorker, launchWithExtension, stopExtensionServiceWorker, swApi, type Harness } from '../helpers/browser'
import { installMeetRosterRoute } from '../fixtures/meet/roster'
import { collectionsMessage, dcrpcMessage, dcrpcRecord } from '../helpers/protobuf'

const POPUP = `chrome-extension://${EXTENSION_ID}/src/popup/index.html`
const OPTIONS = `chrome-extension://${EXTENSION_ID}/src/options/index.html`

/** Chave FALSA, literal deste arquivo. Nenhuma chave de verdade entra no repositório. */
const CHAVE_FALSA = 'sk-teste-falsa-0000000000000000000000'

/** Os trechos que o servidor falso devolve, em segundos do áudio gravado. */
const SEGMENTOS: Array<[number, number, string]> = [
  [3, 6, 'Bom dia a todos.'],
  [9, 12, 'Obrigado, Ana.'],
  [20.5, 22, 'Voltando ao assunto.'],
]

/** O que o transcricao.md tem de dizer, na ordem (o atraso de 1,5 s já contado nos roteiros). */
const LINHAS_ESPERADAS = [
  '[00:03] Ana Souza: Bom dia a todos.',
  '[00:09] Bruno Lima: Obrigado, Ana.',
  '[00:14] Você: (sua fala não é gravada)',
  '[00:20] Ana Souza: Voltando ao assunto.',
]

interface Pedido {
  authorization: string | undefined
  contentType: string | undefined
  bytes: number
  /** Os campos do multipart que são texto (model, response_format...). */
  campos: Record<string, string>
  /** O multipart trouxe a parte do arquivo com o nome esperado? */
  temArquivo: boolean
}

interface Fake {
  server: Server
  url: string
  pedidos: Pedido[]
  /** Respostas, em ordem; a última vale para as seguintes. 200 devolve os SEGMENTOS. */
  respostas: number[]
  close(): Promise<void>
}

/** Lê os nomes dos campos de texto de um corpo multipart (o bastante para o teste conferir). */
function lerMultipart(body: Buffer, contentType: string): { campos: Record<string, string>; temArquivo: boolean } {
  const boundary = /boundary=(.+)$/.exec(contentType)?.[1]
  const campos: Record<string, string> = {}
  let temArquivo = false
  if (!boundary) return { campos, temArquivo }
  for (const parte of body.toString('latin1').split(`--${boundary}`)) {
    const m = /name="([^"]+)"(?:; filename="([^"]+)")?\r?\n(?:[^\r\n]*\r?\n)*\r?\n([\s\S]*?)\r?\n?$/.exec(parte)
    if (!m) continue
    if (m[2]) {
      temArquivo = m[2] === 'audio.webm' && m[3].length > 0
      continue
    }
    campos[m[1]] = m[3]
  }
  return { campos, temArquivo }
}

/** Servidor HTTP falso no loopback, no lugar da API do provedor. */
async function servidorFalso(): Promise<Fake> {
  const pedidos: Pedido[] = []
  const respostas: number[] = [200]
  const handler = (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      const contentType = req.headers['content-type']
      const { campos, temArquivo } = lerMultipart(body, contentType ?? '')
      pedidos.push({ authorization: req.headers.authorization, contentType, bytes: body.length, campos, temArquivo })
      const status = respostas.length > 1 ? respostas.shift()! : respostas[0]
      if (status !== 200) {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'falha do servidor falso' } }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          task: 'transcribe',
          language: 'portuguese',
          duration: 24,
          text: SEGMENTOS.map((s) => s[2]).join(' '),
          segments: SEGMENTOS.map(([start, end, text], id) => ({ id, start, end, text: ` ${text}` })),
        }),
      )
    })
  }
  const server = createServer(handler)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const port = (server.address() as { port: number }).port
  return {
    server,
    url: `http://127.0.0.1:${port}/v1/audio/transcriptions`,
    pedidos,
    respostas,
    close: () => new Promise<void>((r) => server.close(() => r())),
  }
}

let h: Harness | undefined
let fake: Fake | undefined

test.afterEach(async ({}, testInfo) => {
  if (h && testInfo.status !== testInfo.expectedStatus) {
    await testInfo.attach('console', { body: h.logs.join('\n'), contentType: 'text/plain' })
    console.log(h.logs.join('\n'))
  }
  await h?.close()
  h = undefined
  await fake?.close()
  fake = undefined
})

const fx = (page: Page, key: string) => page.evaluate((k) => (window as any).fixture[k], key)
const b64 = (u: Uint8Array) => Buffer.from(u).toString('base64')

/** Sobe o Chrome SEM helper, com downloads de verdade, e o servidor falso. */
async function launch(): Promise<void> {
  fake = await servidorFalso()
  h = await launchWithExtension({
    installHost: false,
    downloads: true,
    settings: { profileLabel: '', minSeconds: 5 },
    routes: async (context) =>
      installMeetRosterRoute(context, [
        { deviceId: 'spaces/sala1/devices/1', name: 'Alex Lima', self: true },
        { deviceId: 'spaces/sala1/devices/2', name: 'Ana Souza' },
      ]),
  })
}

/**
 * Liga o motor por API pela TELA de configurações, como o usuário faz: o endereço do servidor
 * falso, a chave, e o rádio do motor (que pede a permissão de host).
 */
async function ligarMotorPelaTela(): Promise<Page> {
  const options = await h!.context.newPage()
  await options.goto(OPTIONS)
  const section = options.getByTestId('secao-transcricao')
  // O aviso de privacidade aparece ANTES de ligar.
  await expect(section.getByTestId('transcricao-api-privacidade')).toContainText('o áudio da call, com a voz dos participantes, é enviado')
  await expect(section.getByTestId('transcricao-api-custo')).toContainText('US$ 0,36 por hora de call')
  await expect(section.getByTestId('transcricao-api-limite')).toContainText('25 MB')
  await expect(section.getByTestId('transcricao-motor')).toHaveAttribute('data-motor', 'local')

  // Ligar sem a chave não liga, e diz por quê.
  await section.getByTestId('motor-api').click()
  await expect(section.getByTestId('transcricao-api-mensagem')).toContainText('Cole a chave da API antes de ligar')
  await expect(section.getByTestId('transcricao-motor')).toHaveAttribute('data-motor', 'local')

  // Endereço do servidor falso (em "Endereço da API") e a chave.
  await section.getByText('Endereço da API', { exact: true }).click()
  await section.getByLabel('Endereço da API de transcrição').fill(fake!.url)
  await section.getByLabel('Endereço da API de transcrição').blur()
  await expect(section.getByTestId('transcricao-api-mensagem')).toContainText('Transcrição por API salva neste perfil')
  await section.getByLabel('Chave da API de transcrição').fill(CHAVE_FALSA)
  await section.getByRole('button', { name: 'Guardar a chave' }).click()
  // A chave guardada nunca aparece inteira na tela.
  await expect(section.getByTestId('transcricao-api-chave')).toContainText('••••0000')
  await expect(options.locator('body')).not.toContainText(CHAVE_FALSA)

  await section.getByTestId('motor-api').click()
  await expect(section.getByTestId('transcricao-api-mensagem')).toContainText('as próximas calls deste perfil são transcritas pela API')
  await expect(section.getByTestId('transcricao-motor')).toHaveAttribute('data-motor', 'api')
  return options
}

/** Grava uma call falsa do Meet com dois participantes falando em instantes conhecidos. */
async function gravarCall(sala: string): Promise<{ sessionId: string }> {
  const ANA = 'spaces/sala1/devices/2'
  const BRUNO = 'spaces/sala1/devices/3'
  const EU = 'spaces/sala1/devices/1'
  const collections = collectionsMessage([{ deviceId: BRUNO, name: 'Bruno Lima' }], [['1053', ANA], ['2331', BRUNO]])
  const peer = await h!.context.newPage()
  await peer.goto(`https://meet.google.com/__peer?variante=canais&tom=440&sala=${sala}&abrir=collections`)
  await peer.click('#iniciar')
  await expect.poll(() => peer.evaluate(() => (window as any).fixture.state)).toBe('pronto')
  const call = await h!.context.newPage()
  await call.goto(`https://meet.google.com/abc-defg-hij?variante=falantes&sala=${sala}&marca=nao`)
  await expect.poll(() => fx(call, 'micDesligado')).toBe(true)
  await call.click('#participar')
  await expect.poll(() => fx(call, 'pcState'), { timeout: 15_000, intervals: [100] }).toBe('connected')
  await expect.poll(() => peer.evaluate(() => (window as any).peer.canais()), { timeout: 10_000 }).toEqual([
    ['collections', 'open'],
    ['dcrpc', 'open'],
  ])
  await expect.poll(() => fx(call, 'rosterBuscada')).toBe(true)
  await peer.evaluate((d) => (window as any).peer.enviar('collections', { b64: d }), b64(collections))
  await expect.poll(async () => (await swApi(h!.sw).activeRecordings()).length, { timeout: 15_000, intervals: [100] }).toBe(1)
  const [active] = (await swApi(h!.sw).activeRecordings()) as unknown as Array<{ sessionId: string; startedAt: number }>
  const snap = (...recs: Array<[string | number, boolean]>) => b64(dcrpcMessage(recs.map(([id, on]) => dcrpcRecord(id, on))))
  await peer.evaluate(
    (plano) => (window as any).peer.roteiro(plano),
    [
      { em: active.startedAt + 1000, canal: 'dcrpc', b64: snap([ANA, true], [2331, false]) },
      { em: active.startedAt + 7000, canal: 'dcrpc', b64: snap([ANA, false], [2331, true]) },
      { em: active.startedAt + 13_000, canal: 'dcrpc', b64: snap([ANA, false], [2331, false], [EU, true]) },
      { em: active.startedAt + 18_000, canal: 'dcrpc', b64: snap([ANA, true], [2331, false]) },
    ],
  )
  await call.evaluate(
    (plano) => (window as any).fixture.roteiroMic(plano),
    [
      { em: active.startedAt + 13_000, on: true },
      { em: active.startedAt + 17_000, on: false },
    ],
  )
  await call.waitForTimeout(active.startedAt + 24_000 - Date.now())
  await expect(call.locator('button[jsname="CQylAd"]')).toBeVisible()
  await call.click('button[jsname="CQylAd"]')
  await expect.poll(async () => (await swApi(h!.sw).activeRecordings()).length, { timeout: 20_000, intervals: [250] }).toBe(0)
  return { sessionId: active.sessionId }
}

/** A pasta da call dentro da pasta de downloads do perfil. */
function pastaDaCall(): string {
  const raiz = join(h!.downloadsDir!, 'Gravações de calls')
  const mes = readdirSync(raiz).filter((f) => /^\d{4}-\d{2}$/.test(f))
  expect(mes, `meses em ${raiz}`).toHaveLength(1)
  const calls = readdirSync(join(raiz, mes[0]))
  expect(calls, 'pastas de call').toHaveLength(1)
  return join(raiz, mes[0], calls[0])
}

/** Quantas gravações estão com o áudio guardado esperando a transcrição por API. */
const naFila = async () => swApi(h!.sw).testing<number>('apiQueueSize')

test('a call é transcrita pela API, o transcricao.md sai com os nomes de quem falou, o popup mostra pronta e o áudio guardado é apagado', async () => {
  await launch()
  await ligarMotorPelaTela()
  await gravarCall('api-ok')

  // A transcrição chega: o .md e o .srt aparecem na pasta da call, em Downloads.
  await expect.poll(() => (existsSync(pastaDaCall()) ? readdirSync(pastaDaCall()).sort() : []), { timeout: 30_000, intervals: [250] }).toEqual([
    'audio.webm',
    'falantes.json',
    'info.json',
    'transcricao.md',
    'transcricao.srt',
  ])
  const dir = pastaDaCall()
  const md = readFileSync(join(dir, 'transcricao.md'), 'utf8')
  expect(md).toContain('# Daily do time')
  expect(md).toContain('- **Transcrição:** OpenAI API, modelo whisper-1, idioma portuguese')
  expect(md.split('---\n')[1].split('\n').filter(Boolean)).toEqual(LINHAS_ESPERADAS)
  const srt = readFileSync(join(dir, 'transcricao.srt'), 'utf8')
  expect(srt).toContain('\nAna Souza: Bom dia a todos.\n')
  expect(srt).toContain('\nBruno Lima: Obrigado, Ana.\n')

  // Uma requisição só, com a chave SÓ no cabeçalho Authorization e o áudio no multipart.
  expect(fake!.pedidos).toHaveLength(1)
  const [req] = fake!.pedidos
  expect(req.authorization).toBe(`Bearer ${CHAVE_FALSA}`)
  expect(req.contentType).toMatch(/^multipart\/form-data; boundary=/)
  expect(req.temArquivo).toBe(true)
  expect(req.campos).toMatchObject({ model: 'whisper-1', response_format: 'verbose_json', 'timestamp_granularities[]': 'segment' })
  expect(req.bytes).toBeGreaterThan(1000)

  // O popup mostra pronta (sem helper, e sem falar que a transcrição precisa dele).
  const popup = await h!.context.newPage()
  await popup.goto(POPUP)
  await expect(popup.getByTestId('recente')).toHaveCount(1)
  const line = popup.getByTestId('transcricao')
  await expect(line).toHaveAttribute('data-status', 'pronta', { timeout: 10_000 })
  await expect(line).toContainText('Transcrição pronta')
  await expect(popup.getByTestId('transcricao-aviso')).toHaveCount(0)
  await expect(popup.getByText('Sem transcrição: ela precisa do helper local.')).toHaveCount(0)

  // E o áudio guardado foi apagado depois: nada fica guardado além do necessário.
  expect(await naFila()).toBe(0)
  // A chave não aparece em nenhum arquivo da pasta da call.
  for (const f of readdirSync(dir).filter((x) => !x.endsWith('.webm'))) {
    expect(readFileSync(join(dir, f), 'utf8'), f).not.toContain(CHAVE_FALSA)
  }
})

test('401 não repete sozinho, apaga o áudio guardado e o popup mostra a mensagem de chave recusada', async () => {
  await launch()
  await ligarMotorPelaTela()
  fake!.respostas.splice(0, fake!.respostas.length, 401)
  await gravarCall('api-401')

  const popup = await h!.context.newPage()
  await popup.goto(POPUP)
  const line = popup.getByTestId('transcricao')
  await expect(line).toHaveAttribute('data-status', 'falhou', { timeout: 30_000 })
  await expect(line).toContainText('o provedor recusou a chave da API')
  // Não repete sozinho e não deixa o áudio guardado.
  const pedidos = fake!.pedidos.length
  expect(pedidos).toBe(1)
  await swApi(h!.sw).testing('runApiQueue')
  expect(fake!.pedidos).toHaveLength(pedidos)
  expect(await naFila()).toBe(0)
  expect(readdirSync(pastaDaCall()).sort()).toEqual(['audio.webm', 'falantes.json', 'info.json'])
})

test('429 repete: a gravação espera na fila com o motivo e a tentativa seguinte transcreve', async () => {
  await launch()
  await ligarMotorPelaTela()
  fake!.respostas.splice(0, fake!.respostas.length, 429, 200)
  await gravarCall('api-429')

  const popup = await h!.context.newPage()
  await popup.goto(POPUP)
  const line = popup.getByTestId('transcricao')
  await expect(line).toHaveAttribute('data-status', 'pendente', { timeout: 30_000 })
  await expect(line).toContainText('o provedor pediu para esperar')
  expect(fake!.pedidos).toHaveLength(1)
  // O áudio continua guardado, esperando a espera crescente passar.
  expect(await naFila()).toBe(1)
  // A espera é de 15 s; o teste adianta a hora do trabalho e roda a passada de novo (é o que o
  // chrome.alarms faria em até um minuto).
  await swApi(h!.sw).testing('apiQueueDueNow')
  await swApi(h!.sw).testing('runApiQueue')
  await expect.poll(() => fake!.pedidos.length, { timeout: 20_000, intervals: [250] }).toBe(2)
  await expect(line).toHaveAttribute('data-status', 'pronta', { timeout: 20_000 })
  expect(await naFila()).toBe(0)
  expect(readdirSync(pastaDaCall())).toContain('transcricao.md')
})

test('o service worker reiniciado no meio retoma a fila (ela vive no IndexedDB)', async () => {
  await launch()
  await ligarMotorPelaTela()
  // A primeira tentativa falha com 5xx: a gravação fica na fila, e aí o SW é derrubado.
  fake!.respostas.splice(0, fake!.respostas.length, 500, 200)
  await gravarCall('api-sw')
  await expect.poll(() => fake!.pedidos.length, { timeout: 30_000, intervals: [250] }).toBe(1)
  await expect.poll(naFila, { timeout: 15_000, intervals: [250] }).toBe(1)

  const estados = await stopExtensionServiceWorker(h!)
  expect(estados.join(','), 'o SW precisa ter parado').toContain('stopped')
  h!.sw = await currentServiceWorker(h!)
  // O SW novo não tem nada em memória: a fila que ele vê é a do IndexedDB.
  expect(await naFila()).toBe(1)
  await swApi(h!.sw).testing('apiQueueDueNow')
  await swApi(h!.sw).testing('runApiQueue')
  await expect.poll(() => fake!.pedidos.length, { timeout: 20_000, intervals: [250] }).toBe(2)
  await expect.poll(() => readdirSync(pastaDaCall()).includes('transcricao.md'), { timeout: 20_000, intervals: [250] }).toBe(true)
  expect(await naFila()).toBe(0)
})

test('com o motor desligado, nada é enviado e a pasta sai sem transcrição', async () => {
  await launch()
  const options = await h!.context.newPage()
  await options.goto(OPTIONS)
  // Só a chave e o endereço, sem ligar o motor.
  const section = options.getByTestId('secao-transcricao')
  await section.getByText('Endereço da API', { exact: true }).click()
  await section.getByLabel('Endereço da API de transcrição').fill(fake!.url)
  await section.getByLabel('Endereço da API de transcrição').blur()
  await section.getByLabel('Chave da API de transcrição').fill(CHAVE_FALSA)
  await section.getByRole('button', { name: 'Guardar a chave' }).click()
  await expect(section.getByTestId('transcricao-api-chave')).toBeVisible()
  await expect(section.getByTestId('transcricao-motor')).toHaveAttribute('data-motor', 'local')

  await gravarCall('api-desligado')
  await expect.poll(() => (existsSync(pastaDaCall()) ? readdirSync(pastaDaCall()).sort() : []), { timeout: 30_000, intervals: [250] }).toEqual([
    'audio.webm',
    'falantes.json',
    'info.json',
  ])
  // Tempo de sobra para uma requisição que não deveria existir.
  await options.waitForTimeout(3000)
  expect(fake!.pedidos).toEqual([])
  expect(await naFila()).toBe(0)
  const popup = await h!.context.newPage()
  await popup.goto(POPUP)
  await expect(popup.getByTestId('recente')).toHaveCount(1)
  await expect(popup.getByTestId('transcricao')).toHaveCount(0)
})
