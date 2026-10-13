// Quem disse o quê (Emenda 18), ponta a ponta: a página falsa da call muda quem fala em instantes
// conhecidos, a extensão grava a linha do tempo dos falantes, o SW escreve o falantes.json na
// pasta, e o worker da transcrição (whisper-cli FALSO, com segmentos em tempos conhecidos) escreve
// o transcricao.md com o nome de cada um, na ordem, e a linha da sua fala, que não é gravada.
//
// Os instantes são contados do começo da gravação (o `startedAt` que o MAIN world mandou, no mesmo
// relógio Date.now() das páginas). O áudio gravado sai MIXER_DELAY_MS (1,5 s) depois do sinal ao
// vivo, então quem fala de t a t' ao vivo fica, no áudio e na linha do tempo, de t + 1,5 a t' + 1,5.
//
// Sinais usados (os que uma página de teste consegue produzir de verdade; o CSRC não existe numa
// conexão direta entre duas abas e fica nos testes de unidade):
// - Teams: 'dsh' do falante dominante no canal 'main-channel', com o nome pelo objeto da call
//   (hasAudioSource e os mediaStreams), e o indicador do bloco de vídeo, sem nenhum dos outros;
// - Meet: roster pelo canal 'collections' (do outro lado) e pela resposta do SyncMeetingSpaceCollections,
//   e quem fala pelo snapshot do 'dcrpc' (canal que a página cria).
// - Você: o microfone falso ligado e desligado (track.enabled) nos instantes do roteiro.
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { launchWithExtension, swApi, type Harness, type LaunchOptions } from '../helpers/browser'
import { fakeSegments, fakeTranscriptionConfig, makeFakeTools, type FakeTools } from '../helpers/fake-transcricao'
import { findRecordings } from '../helpers/recordings'
import { installTeamsRoutes } from '../fixtures/teams/routes'
import { installMeetRosterRoute } from '../fixtures/meet/roster'
import { collectionsMessage, dcrpcMessage, dcrpcRecord } from '../helpers/protobuf'

let h: Harness | undefined
const dirs: string[] = []

test.afterEach(async ({}, testInfo) => {
  if (h && testInfo.status !== testInfo.expectedStatus) {
    const log = existsSync(h.hostLog) ? readFileSync(h.hostLog, 'utf8') : '(sem log do helper)'
    await testInfo.attach('console', { body: `${h.logs.join('\n')}\n--- helper.log ---\n${log}`, contentType: 'text/plain' })
    console.log(h.logs.join('\n'), '\n--- helper.log ---\n', log)
  }
  await h?.close()
  h = undefined
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const fx = (page: Page, key: string) => page.evaluate((k) => (window as any).fixture[k], key)
const b64 = (u: Uint8Array) => Buffer.from(u).toString('base64')
const dsh = (id: number) => JSON.stringify([{ history: [id], type: 'dsh' }])

/** Os segmentos do whisper falso, em segundos do áudio gravado. */
const SEGMENTS: Array<[number, number, string]> = [
  [3, 6, 'Bom dia a todos.'],
  [9, 12, 'Obrigado, Ana.'],
  [20.5, 22, 'Voltando ao assunto.'],
]

/** O que o transcricao.md tem de dizer, na ordem (com o atraso de 1,5 s já contado nos roteiros). */
const EXPECTED_LINES = [
  '[00:03] Ana Souza: Bom dia a todos.',
  '[00:09] Bruno Lima: Obrigado, Ana.',
  '[00:14] Você: (sua fala não é gravada)',
  '[00:20] Ana Souza: Voltando ao assunto.',
]

async function launch(routes?: LaunchOptions['routes']): Promise<FakeTools> {
  const dir = mkdtempSync(join(tmpdir(), 'gravador-e2e-falantes-'))
  dirs.push(dir)
  const tools = makeFakeTools(join(dir, 'bin'))
  fakeSegments(tools, SEGMENTS)
  h = await launchWithExtension({ routes, transcricao: fakeTranscriptionConfig(tools), settings: { profileLabel: '' } })
  return tools
}

async function startPeer(url: string): Promise<Page> {
  const peer = await h!.context.newPage()
  await peer.goto(url)
  await peer.click('#iniciar')
  await expect.poll(() => peer.evaluate(() => (window as any).fixture.state)).toBe('pronto')
  return peer
}

async function waitRecording(): Promise<{ sessionId: string; tabId: number; startedAt: number }> {
  const api = swApi(h!.sw)
  await expect.poll(async () => (await api.activeRecordings()).length, { timeout: 15_000, intervals: [100] }).toBe(1)
  const [active] = (await api.activeRecordings()) as Array<{ sessionId: string; tabId: number; startedAt: number }>
  return active
}

/** Espera a pasta da call ter o .md pronto e devolve as linhas da fala e a pasta. */
async function transcriptOf(): Promise<{ lines: string[]; dir: string }> {
  await expect.poll(() => findRecordings(h!.root).filter((r) => r.info).length, { timeout: 20_000, intervals: [250] }).toBe(1)
  const [rec] = findRecordings(h!.root)
  const info = () => JSON.parse(readFileSync(join(rec.dir, 'info.json'), 'utf8'))
  await expect.poll(() => info().transcricao?.status, { timeout: 20_000, intervals: [250] }).toBe('pronta')
  const md = readFileSync(join(rec.dir, 'transcricao.md'), 'utf8')
  return { lines: md.split('---\n')[1].split('\n').filter(Boolean), dir: rec.dir }
}

function checkFolder(dir: string, fontes: string[]) {
  expect(findRecordings(h!.root)[0].files).toEqual(['audio.webm', 'falantes.json', 'info.json', 'transcricao.md', 'transcricao.srt'])
  const info = JSON.parse(readFileSync(join(dir, 'info.json'), 'utf8'))
  expect(info.falantes.arquivo).toBe('falantes.json')
  expect(info.falantes.pessoas.map((p: { nome: string }) => p.nome)).toEqual(['Ana Souza', 'Bruno Lima', 'Você'])
  expect(info.falantes.fontes).toEqual(fontes)
  const file = JSON.parse(readFileSync(join(dir, 'falantes.json'), 'utf8'))
  expect(file).toMatchObject({ versao: 1, audio: 'audio.webm', atrasoMs: 1500, textos: { voceNaoGravada: '(sua fala não é gravada)' } })
  const srt = readFileSync(join(dir, 'transcricao.srt'), 'utf8')
  expect(srt).toContain('\nAna Souza: Bom dia a todos.\n')
  expect(srt).toContain('\nBruno Lima: Obrigado, Ana.\n')
}

test('Teams: o dsh do main-channel e o objeto da call dizem quem falou; o transcricao.md sai com os nomes na ordem', async () => {
  await launch(installTeamsRoutes)
  const room = 't-falantes'
  const peer = await startPeer(`https://teams.microsoft.com/__peer?variante=canais&tom=440&sala=${room}`)
  const call = await h!.context.newPage()
  await call.goto(`https://teams.microsoft.com/meet/1234567890123?p=abcd&variante=falantes&sala=${room}`)
  await expect.poll(() => fx(call, 'micDesligado')).toBe(true)
  await call.click('#participar')
  await expect.poll(() => fx(call, 'pcState'), { timeout: 15_000, intervals: [100] }).toBe('connected')
  await expect.poll(() => peer.evaluate(() => (window as any).peer.canais()), { timeout: 10_000 }).toEqual([['main-channel', 'open']])
  await call.evaluate(() => (window as any).ui.admitir())
  const { startedAt } = await waitRecording()

  // Ao vivo: Ana de 1 a 7 s, Bruno de 7 a 13 s, você (o dsh aponta para a sua fonte) de 13 a 17 s,
  // Ana de 18 s até sair.
  await peer.evaluate(
    (plano) => (window as any).peer.roteiro(plano),
    [
      { em: startedAt + 1000, canal: 'main-channel', texto: dsh(1053) },
      { em: startedAt + 7000, canal: 'main-channel', b64: b64(Uint8Array.from([0, 3, ...Buffer.from(dsh(2331))])) },
      { em: startedAt + 13_000, canal: 'main-channel', texto: dsh(9999) },
      { em: startedAt + 18_000, canal: 'main-channel', texto: dsh(1053) },
    ],
  )
  await call.evaluate(
    (plano) => (window as any).fixture.roteiroMic(plano),
    [
      { em: startedAt + 13_000, on: true },
      { em: startedAt + 17_000, on: false },
    ],
  )
  await call.waitForTimeout(startedAt + 24_000 - Date.now())
  await call.click('#hangup-button')

  const { lines, dir } = await transcriptOf()
  expect(lines).toEqual(EXPECTED_LINES)
  checkFolder(dir, ['dsh', 'microfone'])
  expect(await fx(call, 'errors')).toEqual([])
  expect(h!.pageErrors).toEqual([])
})

test('Teams sem CSRC nem main-channel: o indicador do bloco de vídeo diz quem falou (e o seu bloco nunca)', async () => {
  await launch(installTeamsRoutes)
  const room = 't-falantes-dom'
  await startPeer(`https://teams.microsoft.com/__peer?variante=teams&tom=440&sala=${room}`)
  const call = await h!.context.newPage()
  await call.goto(`https://teams.microsoft.com/meet/1234567890123?p=abcd&variante=falantes-dom&sala=${room}`)
  await expect.poll(() => fx(call, 'micDesligado')).toBe(true)
  await call.click('#participar')
  await expect.poll(() => fx(call, 'pcState'), { timeout: 15_000, intervals: [100] }).toBe('connected')
  await call.evaluate(() => (window as any).ui.admitir())
  const { startedAt } = await waitRecording()
  await call.evaluate(
    (plano) => (window as any).fixture.roteiroDom(plano),
    [
      { em: startedAt + 1000, falando: ['Ana Souza'] },
      { em: startedAt + 7000, falando: ['Bruno Lima'] },
      // O seu bloco acende, mas você vem do microfone, não do bloco.
      { em: startedAt + 13_000, falando: ['Alex Lima'] },
      { em: startedAt + 17_000, falando: [] },
      { em: startedAt + 18_000, falando: ['Ana Souza'] },
    ],
  )
  await call.waitForTimeout(startedAt + 24_000 - Date.now())
  await call.click('#hangup-button')

  const { lines, dir } = await transcriptOf()
  expect(lines).toEqual([EXPECTED_LINES[0], EXPECTED_LINES[1], EXPECTED_LINES[3]])
  const info = JSON.parse(readFileSync(join(dir, 'info.json'), 'utf8'))
  expect(info.falantes.pessoas.map((p: { nome: string }) => p.nome)).toEqual(['Ana Souza', 'Bruno Lima'])
  expect(info.falantes.fontes).toEqual(['dom'])
})

test('Meet: roster pelo collections e pelo SyncMeetingSpaceCollections, quem fala pelo dcrpc; o transcricao.md sai com os nomes na ordem, e o seu nome vem da roster', async () => {
  const ANA = 'spaces/sala1/devices/2'
  const BRUNO = 'spaces/sala1/devices/3'
  const EU = 'spaces/sala1/devices/1'
  const OUTRA = 'spaces/outra/devices/8'
  // A Ana e você estavam antes (a resposta do fetch); o Bruno entra pelo collections, que também
  // traz os streams e uma pessoa de outra call da mesma conta (que nunca pode aparecer).
  await launch(async (context) =>
    installMeetRosterRoute(context, [
      { deviceId: EU, name: 'Alex Lima', self: true },
      { deviceId: ANA, name: 'Ana Souza' },
    ]),
  )
  const room = 'm-falantes'
  const collections = collectionsMessage(
    [
      { deviceId: BRUNO, name: 'Bruno Lima' },
      { deviceId: OUTRA, name: 'Pessoa de outra call' },
    ],
    [
      ['1053', ANA],
      ['2331', BRUNO],
      ['77', OUTRA],
    ],
  )
  const peer = await startPeer(`https://meet.google.com/__peer?variante=canais&tom=440&sala=${room}&abrir=collections`)
  const call = await h!.context.newPage()
  // Emenda 20: o seu bloco sem o [data-self-name], como na daily real.
  await call.goto(`https://meet.google.com/abc-defg-hij?variante=falantes&sala=${room}&marca=nao`)
  await expect.poll(() => fx(call, 'micDesligado')).toBe(true)
  await call.click('#participar')
  await expect.poll(() => fx(call, 'pcState'), { timeout: 15_000, intervals: [100] }).toBe('connected')
  await expect.poll(() => peer.evaluate(() => (window as any).peer.canais()), { timeout: 10_000 }).toEqual([
    ['collections', 'open'],
    ['dcrpc', 'open'],
  ])
  await expect.poll(() => fx(call, 'rosterBuscada')).toBe(true)
  await peer.evaluate((d) => (window as any).peer.enviar('collections', { b64: d }), b64(collections))
  const { startedAt } = await waitRecording()
  const snap = (...recs: Array<[string | number, boolean]>) => b64(dcrpcMessage(recs.map(([id, on]) => dcrpcRecord(id, on))))
  await peer.evaluate(
    (plano) => (window as any).peer.roteiro(plano),
    [
      // A Ana pelo deviceId; o Bruno pelo id numérico (streamId); a pessoa de outra call "fala" junto.
      { em: startedAt + 1000, canal: 'dcrpc', b64: snap([ANA, true], [2331, false], [OUTRA, true]) },
      { em: startedAt + 7000, canal: 'dcrpc', b64: snap([ANA, false], [2331, true], [OUTRA, true]) },
      { em: startedAt + 13_000, canal: 'dcrpc', b64: snap([ANA, false], [2331, false], [EU, true]) },
      { em: startedAt + 18_000, canal: 'dcrpc', b64: snap([ANA, true], [2331, false]) },
    ],
  )
  await call.evaluate(
    (plano) => (window as any).fixture.roteiroMic(plano),
    [
      { em: startedAt + 13_000, on: true },
      { em: startedAt + 17_000, on: false },
    ],
  )
  await call.waitForTimeout(startedAt + 24_000 - Date.now())
  await call.click('button[jsname="CQylAd"]')

  const { lines, dir } = await transcriptOf()
  expect(lines).toEqual(EXPECTED_LINES)
  checkFolder(dir, ['dcrpc', 'microfone'])
  expect(readFileSync(join(dir, 'falantes.json'), 'utf8')).not.toContain('outra call')
  // Emenda 20: o seu nome pela roster (campo 7, no space da call), fora dos participantes; os
  // diagnósticos no info.json; sem fonte descartada nem diagnóstico de CSRC (sem CSRC aqui).
  const info = JSON.parse(readFileSync(join(dir, 'info.json'), 'utf8'))
  expect(info).toMatchObject({ voce: 'Alex Lima', voceSinais: { roster: true, espacos: 2, marcadorDom: false }, tituloSinais: { elemento: 'outro', seletor: 'NeC6gb' } })
  expect(info.participantes).not.toContain('Alex Lima')
  const file = JSON.parse(readFileSync(join(dir, 'falantes.json'), 'utf8'))
  expect(file).not.toHaveProperty('descartadas')
  expect(file).not.toHaveProperty('diagnostico')
  expect(await fx(call, 'errors')).toEqual([])
  expect(await fx(call, 'unhandled')).toEqual([])
  expect(h!.pageErrors).toEqual([])
})
