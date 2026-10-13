// Transcrição automática ao fim de cada call (AC19, AC20, Emenda 13), ponta a ponta: call falsa do
// Meet, helper de verdade numa raiz temporária e a seção `transcricao` do config.json do teste
// apontando para um ffmpeg e um whisper-cli FALSOS (tests/helpers/fake-transcricao.ts). O worker
// destacado de verdade (host/transcrever.mjs) é aberto pelo helper que o Chrome abriu. Nenhum
// whisper de verdade roda aqui.
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { EXTENSION_ID, launchWithExtension, swApi, type Harness, type LaunchOptions } from '../helpers/browser'
import { fakeTranscriptionConfig, FAKE_TEXT, makeFakeTools, type FakeTools } from '../helpers/fake-transcricao'
import { findRecordings, type FoundRecording } from '../helpers/recordings'

const POPUP = `chrome-extension://${EXTENSION_ID}/src/popup/index.html`
const OPTIONS = `chrome-extension://${EXTENSION_ID}/src/options/index.html`

let h: Harness | undefined
const toolDirs: string[] = []

test.afterEach(async ({}, testInfo) => {
  if (h && testInfo.status !== testInfo.expectedStatus) {
    const log = existsSync(h.hostLog) ? readFileSync(h.hostLog, 'utf8') : '(sem log do helper)'
    await testInfo.attach('console', { body: `${h.logs.join('\n')}\n--- helper.log ---\n${log}`, contentType: 'text/plain' })
    console.log(h.logs.join('\n'), '\n--- helper.log ---\n', log)
  }
  await h?.close()
  h = undefined
  for (const d of toolDirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/**
 * Programas falsos numa pasta temporária própria e um "abrir com o aplicativo padrão" que só anota
 * o caminho (o Chrome passa o ambiente dele ao helper; GRAVADOR_OPEN_CMD só existe para testes).
 */
async function launch(transcricao: (t: FakeTools) => Record<string, unknown>, opts: LaunchOptions = {}): Promise<{ h: Harness; tools: FakeTools; opened: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'gravador-e2e-ferramentas-'))
  toolDirs.push(dir)
  const tools = makeFakeTools(join(dir, 'bin'))
  const opened = join(dir, 'abertos.log')
  const opener = join(dir, 'abrir.sh')
  writeFileSync(opener, `#!/bin/sh\necho "$1" >> ${JSON.stringify(opened)}\n`)
  chmodSync(opener, 0o755)
  h = await launchWithExtension({
    ...opts,
    transcricao: transcricao(tools),
    contextOptions: { env: { ...process.env, GRAVADOR_OPEN_CMD: opener } as Record<string, string> },
  })
  return { h, tools, opened }
}

async function startPeer(h: Harness, room: string): Promise<Page> {
  const peer = await h.context.newPage()
  await peer.goto(`https://meet.google.com/__peer?tom=440&sala=${room}`)
  await peer.click('#iniciar')
  await expect.poll(() => peer.evaluate(() => (window as any).fixture.state)).toBe('pronto')
  return peer
}

/** Grava `ms` de uma call do Meet falso, sai e espera o info.json da pasta. */
async function recordCall(h: Harness, room: string, ms = 7000): Promise<{ rec: FoundRecording; sessionId: string }> {
  await startPeer(h, room)
  const call = await h.context.newPage()
  await call.goto(`https://meet.google.com/abc-defg-hij?variante=normal&sala=${room}`)
  await expect.poll(() => call.evaluate(() => (window as any).fixture.micLive)).toBe(true)
  await call.click('#participar')
  await expect.poll(async () => (await swApi(h.sw).activeRecordings()).length, { timeout: 15_000, intervals: [250] }).toBe(1)
  const [active] = await swApi(h.sw).activeRecordings()
  await call.waitForTimeout(ms)
  await call.click('button[jsname="CQylAd"]')
  await expect.poll(() => findRecordings(h.root).filter((r) => r.info).length, { timeout: 15_000, intervals: [250] }).toBe(1)
  const [rec] = findRecordings(h.root)
  return { rec, sessionId: active.sessionId }
}

const infoOf = (dir: string) => JSON.parse(readFileSync(join(dir, 'info.json'), 'utf8'))

test('AC19: a call salva é transcrita sozinha (md e srt na pasta, info.json pronta) e o popup abre a transcrição', async () => {
  const { h, tools, opened } = await launch((t) => fakeTranscriptionConfig(t), { settings: { profileLabel: '' } })
  const { rec, sessionId } = await recordCall(h, 'transcricao')

  await expect.poll(() => infoOf(rec.dir).transcricao?.status, { timeout: 20_000, intervals: [250] }).toBe('pronta')
  const info = infoOf(rec.dir)
  expect(info.transcricao).toMatchObject({ status: 'pronta', motor: 'whisper-cpp', modelo: 'ggml-small.bin', idioma: 'pt', audio: 'audio.webm', arquivos: ['transcricao.md', 'transcricao.srt'] })
  expect(info.transcricao.erro).toBeUndefined()
  // O resto do info.json continua o da gravação.
  expect(info).toMatchObject({ sessao: sessionId, plataforma: 'meet', titulo: 'Daily do time', status: 'concluida', motivoFim: 'saiu-da-call' })
  expect(findRecordings(h.root)[0].files).toEqual(['audio.webm', 'info.json', 'transcricao.md', 'transcricao.srt'])

  const md = readFileSync(join(rec.dir, 'transcricao.md'), 'utf8')
  expect(md).toContain('# Daily do time\n')
  expect(md).toContain('- **Plataforma:** Google Meet')
  expect(md).toMatch(/- \*\*Data:\*\* \d{2}\/\d{2}\/\d{4} \d{2}:\d{2}/)
  expect(md).toMatch(/- \*\*Duração:\*\* \d+ s/)
  expect(md).toContain('- **Participantes:**')
  expect(md).toContain('- **Transcrição:** whisper.cpp (local), modelo ggml-small.bin, idioma pt')
  expect(md).toContain(`[00:00] ${FAKE_TEXT} segunda frase.`)
  expect(readFileSync(join(rec.dir, 'transcricao.srt'), 'utf8')).toBe(`1\n00:00:00,000 --> 00:00:02,500\n${FAKE_TEXT}\n\n2\n00:00:02,600 --> 00:00:04,000\nsegunda frase.\n`)
  // O whisper falso rodou uma vez só, com o WAV convertido pelo ffmpeg falso.
  expect(readFileSync(tools.calls, 'utf8').trim().split('\n').map((l) => l.split(' ')[0])).toEqual(['inicio', 'fim'])

  const popup = await h.context.newPage()
  await popup.goto(POPUP)
  const item = popup.getByTestId('recente').filter({ has: popup.getByText('Daily do time') })
  await expect(item.getByTestId('transcricao')).toHaveAttribute('data-status', 'pronta')
  await expect(item.getByText('Transcrição pronta.')).toBeVisible()
  await expect(popup.getByTestId('transcricao-aviso')).toHaveCount(0)
  await item.getByRole('button', { name: 'Abrir transcrição' }).click()
  await expect.poll(() => (existsSync(opened) ? readFileSync(opened, 'utf8').trim() : ''), { timeout: 10_000 }).toBe(realpathSync(join(rec.dir, 'transcricao.md')))
})

test('AC19: falha na transcrição aparece no popup com o motivo e o áudio fica', async () => {
  const { h, tools } = await launch((t) => fakeTranscriptionConfig(t))
  // O whisper falso sai com erro (como um modelo corrompido).
  writeFileSync(join(tools.dir, 'falhar'), '')
  const { rec } = await recordCall(h, 'transcricao-falha')
  await expect.poll(() => infoOf(rec.dir).transcricao?.status, { timeout: 20_000, intervals: [250] }).toBe('falhou')
  expect(infoOf(rec.dir).transcricao.erro).toMatch(/^o whisper-cli falhou \(código 3\): whisper_init: error: modelo corrompido/)
  expect(findRecordings(h.root)[0].files).toEqual(['audio.webm', 'info.json'])
  const popup = await h.context.newPage()
  await popup.goto(POPUP)
  const line = popup.getByTestId('transcricao')
  await expect(line).toHaveAttribute('data-status', 'falhou')
  await expect(line).toContainText('Transcrição falhou: o whisper-cli falhou (código 3)')
})

test('AC19: sem o whisper-cli a call espera na fila com o motivo (não falha) e corrigir o caminho nas configurações transcreve', async () => {
  const { h, tools } = await launch((t) => fakeTranscriptionConfig(t, { whisperCli: join(t.dir, 'nao-existe') }))
  const { rec } = await recordCall(h, 'transcricao-espera')
  await expect.poll(() => infoOf(rec.dir).transcricao?.espera ?? '', { timeout: 20_000, intervals: [250] }).toMatch(/^whisper-cli não encontrado em .*nao-existe/)
  expect(infoOf(rec.dir).transcricao.status).toBe('pendente')
  expect(existsSync(tools.calls)).toBe(false)

  const popup = await h.context.newPage()
  await popup.goto(POPUP)
  const line = popup.getByTestId('transcricao')
  await expect(line).toHaveAttribute('data-status', 'pendente')
  await expect(line).toContainText('Na fila, esperando: whisper-cli não encontrado em')
  await expect(popup.getByTestId('transcricao-aviso')).toContainText('Transcrição indisponível: whisper-cli não encontrado em')

  const options = await h.context.newPage()
  await options.goto(OPTIONS)
  const section = options.getByTestId('secao-transcricao')
  await expect(section.getByTestId('transcricao-disponivel')).toHaveAttribute('data-disponivel', 'nao')
  await section.getByText('Avançado (caminhos dos programas)').click()
  await section.getByLabel('Caminho do whisper-cli').fill(tools.whisperCli)
  await section.getByRole('button', { name: 'Salvar transcrição' }).click()
  await expect(section.getByTestId('transcricao-mensagem')).toContainText('Transcrição salva no helper')
  // O helper abre o worker para o que esperava, sem outra call.
  await expect.poll(() => infoOf(rec.dir).transcricao?.status, { timeout: 20_000, intervals: [250] }).toBe('pronta')
  expect(infoOf(rec.dir).transcricao.espera).toBeUndefined()
  await expect(line).toHaveAttribute('data-status', 'pronta', { timeout: 10_000 })
  await expect(popup.getByTestId('transcricao-aviso')).toHaveCount(0)
})

test('AC20: transcrição desligada não produz nada e o popup não fala em transcrição', async () => {
  const { h, tools } = await launch((t) => fakeTranscriptionConfig(t, { ativa: false }))
  const { rec } = await recordCall(h, 'sem-transcricao')
  // Tempo de sobra para um worker que não deveria ter sido aberto.
  await new Promise((r) => setTimeout(r, 3000))
  expect(findRecordings(h.root)[0].files).toEqual(['audio.webm', 'info.json'])
  expect(infoOf(rec.dir).transcricao).toBeUndefined()
  expect(existsSync(tools.calls)).toBe(false)
  const fila = join(h.base, 'helper-config', 'fila')
  expect(existsSync(fila) ? readdirSync(fila) : []).toEqual([])
  const popup = await h.context.newPage()
  await popup.goto(POPUP)
  await expect(popup.getByTestId('recente')).toHaveCount(1)
  await expect(popup.getByTestId('transcricao')).toHaveCount(0)
})

test('AC20: configurações mostram se dá para transcrever e salvam a transcrição no helper', async () => {
  const { h, tools } = await launch((t) => fakeTranscriptionConfig(t))
  const options = await h.context.newPage()
  await options.goto(OPTIONS)
  const section = options.getByTestId('secao-transcricao')
  await expect(section.getByTestId('transcricao-disponivel')).toHaveAttribute('data-disponivel', 'sim')
  await expect(section.getByTestId('transcricao-disponivel')).toContainText(tools.model)
  await expect(section.getByLabel('Modelo do whisper')).toHaveValue(tools.model)
  await expect(section.getByLabel('Motor de transcrição')).toHaveValue('whisper-cpp')

  // Caminho relativo: o formulário recusa antes de mandar.
  await section.getByLabel('Modelo do whisper').fill('relativo.bin')
  await section.getByRole('button', { name: 'Salvar transcrição' }).click()
  await expect(section.getByText('use um caminho absoluto ou começando com ~')).toBeVisible()

  // Modelo que não existe: o helper recusa e diz por quê.
  await section.getByLabel('Modelo do whisper').fill(join(tools.dir, 'sumiu.bin'))
  await section.getByRole('button', { name: 'Salvar transcrição' }).click()
  await expect(section.getByTestId('transcricao-mensagem')).toContainText('Não foi possível salvar a transcrição: modelo não encontrado')

  await section.getByLabel('Modelo do whisper').fill(tools.model)
  await section.getByLabel('Idioma da transcrição').selectOption('pt')
  await section.getByRole('button', { name: 'Salvar transcrição' }).click()
  await expect(section.getByTestId('transcricao-mensagem')).toContainText('Transcrição salva no helper')
  const cfg = JSON.parse(readFileSync(join(h.base, 'helper-config', 'config.json'), 'utf8'))
  expect(cfg).toMatchObject({ root: h.root, transcricao: { ativa: true, idioma: 'pt', modelo: tools.model } })

  // Sem o whisper-cli, a linha diz o motivo.
  writeFileSync(join(h.base, 'helper-config', 'config.json'), JSON.stringify({ ...cfg, transcricao: { ...cfg.transcricao, whisperCli: join(tools.dir, 'nao-existe') } }))
  await options.reload()
  await expect(options.getByTestId('transcricao-disponivel')).toHaveAttribute('data-disponivel', 'nao')
  await expect(options.getByTestId('transcricao-disponivel')).toContainText('whisper-cli não encontrado em')
})

test('AC20: helper de antes da transcrição (0.1.0): o popup e as configurações dizem para reinstalar', async () => {
  h = await launchWithExtension({
    // O helper instalado vira um de antes da 0.2.0: responde ao resto, não conhece a transcrição.
    beforeLaunch: ({ base }) => {
      renameSync(join(base, 'gravador-host.mjs'), join(base, 'gravador-host-atual.mjs'))
      writeFileSync(
        join(base, 'gravador-host.mjs'),
        [
          "import { encodeFrame, handle, readFrames } from './gravador-host-atual.mjs'",
          "const NOVAS = new Set(['set-transcription', 'transcription-status', 'open-file', 'choose-file'])",
          'readFrames(process.stdin, async (msg) => {',
          "  let res = NOVAS.has(msg?.op) ? { id: msg.id, ok: false, error: `operação desconhecida: ${msg.op}` } : await handle(msg)",
          "  if (msg?.op === 'ping' && res.ok) res = { ...res, version: '0.1.0' }",
          "  if (msg?.op === 'get-config' && res.ok) { delete res.transcricao; delete res.motores }",
          '  process.stdout.write(encodeFrame(res))',
          '}, () => process.exit(0))',
          '',
        ].join('\n'),
      )
    },
  })
  const popup = await h.context.newPage()
  await popup.goto(POPUP)
  await expect(popup.getByTestId('helper')).toContainText('helper 0.1.0')
  await expect(popup.getByTestId('transcricao-aviso')).toContainText('Sem transcrição: o helper instalado é de uma versão sem transcrição: rode npm run instalar de novo')
  const options = await h.context.newPage()
  await options.goto(OPTIONS)
  await expect(options.getByTestId('transcricao-erro')).toContainText('rode npm run instalar de novo')
})

test('AC20 e Emenda 15: sem o helper, a gravação salva em Downloads não tem linha de transcrição, e as configurações a mostram em Avançado como recurso do helper', async () => {
  h = await launchWithExtension({ installHost: false, downloads: true })
  await startPeer(h, 'sem-helper-transcricao')
  const call = await h.context.newPage()
  await call.goto('https://meet.google.com/abc-defg-hij?variante=normal&sala=sem-helper-transcricao')
  await expect.poll(() => call.evaluate(() => (window as any).fixture.micLive)).toBe(true)
  await call.click('#participar')
  await expect.poll(async () => (await swApi(h!.sw).activeRecordings()).length, { timeout: 15_000, intervals: [250] }).toBe(1)
  await call.waitForTimeout(7000)
  await call.click('button[jsname="CQylAd"]')
  const popup = await h.context.newPage()
  await popup.goto(POPUP)
  await expect(popup.getByTestId('recente')).toHaveCount(1, { timeout: 20_000 })
  await expect(popup.getByTestId('recente')).toContainText('em Downloads')
  // Sem helper é o uso normal da loja: nem a linha da gravação nem o aviso geral falam da transcrição.
  await expect(popup.getByTestId('transcricao')).toHaveCount(0)
  await expect(popup.getByTestId('transcricao-aviso')).toHaveCount(0)
  const options = await h.context.newPage()
  await options.goto(OPTIONS)
  // Emenda 21: a seção existe (o motor por API funciona sem o helper) e o motor local, dentro
  // dela, é que diz que precisa do helper.
  await expect(options.getByTestId('secao-transcricao')).toHaveCount(1)
  await expect(options.getByTestId('secao-transcricao').getByTestId('transcricao-sem-helper')).toContainText('exige o helper local, ainda não distribuído pela loja')
})
