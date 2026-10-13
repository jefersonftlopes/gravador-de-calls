// Fila da transcrição e worker destacado (Emenda 13), com ffmpeg e whisper-cli FALSOS
// (tests/helpers/fake-transcricao.ts): ciclo de vida de um trabalho, um por vez com dois workers ao
// mesmo tempo, retomada depois de um worker morto com kill -9 (e o whisper que ele deixou), trava
// velha, e o caminho da falha (o áudio fica, o info.json diz falhou com o motivo).
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { fakeTranscriptionConfig, FAKE_TEXT, makeFakeTools, type FakeTools } from '../helpers/fake-transcricao'
// @ts-expect-error módulo .mjs sem tipos
import { acquireLock, enqueueTranscription, listJobs, lockHolder, pidAlive, queueDir, reconcileTranscription, releaseLock, runWorker, startQueue, writeAtomic } from '../../host/transcricao.mjs'

const WORKER = resolve(dirname(fileURLToPath(import.meta.url)), '../../host/transcrever.mjs')
const base = mkdtempSync(join(tmpdir(), 'gravador-fila-'))
afterAll(() => rmSync(base, { recursive: true, force: true }))

let n = 0
interface Env {
  configDir: string
  configFile: string
  root: string
  tools: FakeTools
}

/** Pasta de config com a transcrição apontando para os programas falsos. */
function setup(extra: Record<string, unknown> = {}): Env {
  const dir = join(base, `caso-${++n}`)
  const configDir = join(dir, 'config')
  const root = join(dir, 'Gravações')
  mkdirSync(configDir, { recursive: true })
  mkdirSync(root, { recursive: true })
  const tools = makeFakeTools(join(dir, 'ferramentas'))
  const configFile = join(configDir, 'config.json')
  writeFileSync(configFile, JSON.stringify({ root, transcricao: fakeTranscriptionConfig(tools, extra) }))
  return { configDir, configFile, root, tools }
}

/** Uma pasta de gravação pronta (audio.webm + info.json), como o finalize deixa. */
function recording(env: Env, name: string, info: Record<string, unknown> = {}): string {
  const folder = join(env.root, '2026-10', `2026-10-06 14h30 - ${name} (Meet)`)
  mkdirSync(folder, { recursive: true })
  writeFileSync(join(folder, 'audio.webm'), `áudio de ${name}`)
  writeFileSync(
    join(folder, 'info.json'),
    JSON.stringify({ versao: 1, titulo: name, plataforma: 'meet', inicio: '2026-10-06T14:30:05-03:00', duracaoSegundos: 95, participantes: ['Ana Souza'], perfil: null, ...info }),
  )
  return folder
}

const readInfo = (folder: string) => JSON.parse(readFileSync(join(folder, 'info.json'), 'utf8'))
const readConfigOf = (env: Env) => async () => JSON.parse(readFileSync(env.configFile, 'utf8'))

/** Roda o worker de verdade (node host/transcrever.mjs) com o config.json do caso. */
function startWorker(env: Env) {
  const child = spawn(process.execPath, [WORKER], { env: { ...process.env, GRAVADOR_CONFIG: env.configFile }, stdio: ['ignore', 'ignore', 'pipe'] })
  let err = ''
  child.stderr.on('data', (d) => (err += d))
  const done = new Promise<number>((res) => child.on('close', (code) => res(code ?? -1)))
  return { child, done, log: () => err }
}

async function waitFor(fn: () => boolean, timeoutMs = 10_000, what = 'condição') {
  const t0 = Date.now()
  while (!fn()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`esperei demais: ${what}`)
    await new Promise((r) => setTimeout(r, 50))
  }
}

describe('fila da transcrição', () => {
  it('ciclo de vida: pendente na fila, depois pronta com transcricao.md e .srt; o áudio fica', async () => {
    const env = setup()
    const folder = recording(env, 'Daily', { perfil: 'Trabalho' })
    const cfg = (await readConfigOf(env)()).transcricao
    expect(await enqueueTranscription(env.configDir, folder, cfg)).toMatchObject({ queued: true })
    expect(readInfo(folder).transcricao).toMatchObject({ status: 'pendente', motor: 'whisper-cpp', idioma: 'auto', audio: 'audio.webm', arquivos: [] })
    // Mesma pasta de novo (modo aba entrando na pasta da página): não duplica.
    expect(await enqueueTranscription(env.configDir, folder, cfg)).toMatchObject({ queued: false })
    expect(await listJobs(env.configDir)).toHaveLength(1)
    // Mesmo com o info.json reescrito sem o estado (um finalize de outra versão), a fila não duplica.
    const semEstado = readInfo(folder)
    delete semEstado.transcricao
    writeFileSync(join(folder, 'info.json'), JSON.stringify(semEstado))
    expect(await enqueueTranscription(env.configDir, folder, cfg)).toMatchObject({ queued: false, motivo: 'já na fila' })
    expect(await listJobs(env.configDir)).toHaveLength(1)

    expect(await runWorker(env.configDir, { readConfig: readConfigOf(env) })).toBe(1)
    const t = readInfo(folder).transcricao
    expect(t).toMatchObject({ status: 'pronta', motor: 'whisper-cpp', modelo: 'ggml-small.bin', idioma: 'pt', arquivos: ['transcricao.md', 'transcricao.srt'] })
    expect(t.erro).toBeUndefined()
    expect(Date.parse(t.fim)).toBeGreaterThanOrEqual(Date.parse(t.inicio))
    expect(typeof t.duracaoProcessamentoSeg).toBe('number')
    const md = readFileSync(join(folder, 'transcricao.md'), 'utf8')
    expect(md).toContain('# Daily')
    expect(md).toContain('- **Perfil:** Trabalho')
    expect(md).toContain(`[00:00] ${FAKE_TEXT} segunda frase.`)
    expect(readFileSync(join(folder, 'transcricao.srt'), 'utf8')).toContain(`00:00:00,000 --> 00:00:02,500\n${FAKE_TEXT}`)
    expect(readdirSync(folder).sort()).toEqual(['audio.webm', 'info.json', 'transcricao.md', 'transcricao.srt'])
    expect(await listJobs(env.configDir)).toEqual([])
    // Nada de temporário sobrando (o WAV convertido é apagado).
    expect(existsSync(join(queueDir(env.configDir), 'tmp')) ? readdirSync(join(queueDir(env.configDir), 'tmp')) : []).toEqual([])
    // Já pronta: enfileirar de novo não refaz.
    expect(await enqueueTranscription(env.configDir, folder, cfg)).toMatchObject({ queued: false })
  })

  it('falha: info.json diz falhou com o motivo, o áudio fica e não aparece transcrição pela metade', async () => {
    const env = setup()
    writeFileSync(join(env.tools.dir, 'falhar'), '')
    const folder = recording(env, 'Quebrada')
    await enqueueTranscription(env.configDir, folder, {})
    await runWorker(env.configDir, { readConfig: readConfigOf(env) })
    const t = readInfo(folder).transcricao
    expect(t.status).toBe('falhou')
    expect(t.erro).toMatch(/o whisper-cli falhou \(código 3\): whisper_init: error: modelo corrompido/)
    expect(readdirSync(folder).sort()).toEqual(['audio.webm', 'info.json'])
    expect(readFileSync(join(folder, 'audio.webm'), 'utf8')).toBe('áudio de Quebrada')
    expect(await listJobs(env.configDir)).toEqual([])
  })

  it('sem o modelo ou o whisper-cli a call não falha: espera na fila com o motivo e é transcrita quando o motor aparece', async () => {
    const env = setup({ modelo: join(base, 'sumiu.bin') })
    const semModelo = recording(env, 'Sem modelo')
    const outra = recording(env, 'Outra sem modelo')
    await enqueueTranscription(env.configDir, semModelo, {})
    await enqueueTranscription(env.configDir, outra, {})
    expect(await runWorker(env.configDir, { readConfig: readConfigOf(env) })).toBe(0)
    // As duas esperam (o motor vale para todas), nenhuma vira falha, o whisper nem foi chamado.
    for (const f of [semModelo, outra]) {
      expect(readInfo(f).transcricao).toMatchObject({ status: 'pendente', espera: expect.stringMatching(/^modelo não encontrado: .*sumiu\.bin/) })
      expect(readInfo(f).transcricao.erro).toBeUndefined()
    }
    expect(await listJobs(env.configDir)).toHaveLength(2)
    expect(existsSync(env.tools.calls)).toBe(false)
    expect(existsSync(join(queueDir(env.configDir), 'worker.lock'))).toBe(false)

    // O helper não abre worker enquanto o motor não existe (sem laço de workers inúteis).
    let spawned = 0
    const cfg = () => JSON.parse(readFileSync(env.configFile, 'utf8')).transcricao
    expect(await startQueue(env.configDir, cfg(), async () => void spawned++)).toMatchObject({ started: false, motivo: expect.stringMatching(/modelo não encontrado/) })
    expect(spawned).toBe(0)

    // Modelo corrigido: o que esperava entra, e o motivo some.
    writeFileSync(env.configFile, JSON.stringify({ root: env.root, transcricao: fakeTranscriptionConfig(env.tools) }))
    expect(await startQueue(env.configDir, cfg(), async () => void spawned++)).toEqual({ started: true })
    expect(spawned).toBe(1)
    expect(await runWorker(env.configDir, { readConfig: readConfigOf(env) })).toBe(2)
    for (const f of [semModelo, outra]) {
      expect(readInfo(f).transcricao.status).toBe('pronta')
      expect(readInfo(f).transcricao.espera).toBeUndefined()
    }
    // Desligada: nem com trabalho na fila o helper abre o worker.
    writeFileSync(env.configFile, JSON.stringify({ root: env.root, transcricao: fakeTranscriptionConfig(env.tools, { ativa: false }) }))
    await enqueueTranscription(env.configDir, recording(env, 'Desligada'), {})
    expect(await startQueue(env.configDir, cfg(), async () => void spawned++)).toMatchObject({ started: false })
    expect(spawned).toBe(1)

    const env2 = setup({ whisperCli: join(base, 'nao-tem-whisper') })
    const semWhisper = recording(env2, 'Sem whisper')
    await enqueueTranscription(env2.configDir, semWhisper, {})
    await runWorker(env2.configDir, { readConfig: readConfigOf(env2) })
    expect(readInfo(semWhisper).transcricao).toMatchObject({ status: 'pendente', espera: expect.stringMatching(/^whisper-cli não encontrado em /) })
    expect(existsSync(join(semWhisper, 'audio.webm'))).toBe(true)
  })

  it('erro guardado de uma falha some quando a call entra de novo na fila e fica pronta', async () => {
    const env = setup()
    writeFileSync(join(env.tools.dir, 'falhar'), '')
    const folder = recording(env, 'De novo')
    await enqueueTranscription(env.configDir, folder, {})
    await runWorker(env.configDir, { readConfig: readConfigOf(env) })
    expect(readInfo(folder).transcricao).toMatchObject({ status: 'falhou', erro: expect.any(String) })
    rmSync(join(env.tools.dir, 'falhar'))
    // A que falhou entra de novo (é o refazer); o erro antigo não fica junto do pendente.
    expect(await enqueueTranscription(env.configDir, folder, {})).toMatchObject({ queued: true })
    expect(readInfo(folder).transcricao.status).toBe('pendente')
    expect(readInfo(folder).transcricao.erro).toBeUndefined()
    await runWorker(env.configDir, { readConfig: readConfigOf(env) })
    expect(readInfo(folder).transcricao.status).toBe('pronta')
    expect(readInfo(folder).transcricao.erro).toBeUndefined()
    expect(readInfo(folder).transcricoes['audio.webm'].erro).toBeUndefined()
  })

  it('áudio que sumiu antes da vez dele: falhou com o motivo, sem chamar o whisper', async () => {
    const env = setup()
    const folder = recording(env, 'Sem áudio')
    await enqueueTranscription(env.configDir, folder, {})
    rmSync(join(folder, 'audio.webm'))
    await runWorker(env.configDir, { readConfig: readConfigOf(env) })
    expect(readInfo(folder).transcricao).toMatchObject({ status: 'falhou', erro: 'áudio não encontrado: audio.webm' })
    expect(existsSync(env.tools.calls)).toBe(false)
    expect(await listJobs(env.configDir)).toEqual([])
  })

  it('interrompida três vezes no meio (o worker morreu) vira falhou, sem uma quarta tentativa', async () => {
    const env = setup()
    const folder = recording(env, 'Sempre cai')
    await enqueueTranscription(env.configDir, folder, {})
    const [job] = await listJobs(env.configDir)
    const { file, ...rest } = job
    writeFileSync(file, JSON.stringify({ ...rest, estado: 'transcrevendo', tentativas: 3, filhoPid: null, filhoCmd: null }))
    await runWorker(env.configDir, { readConfig: readConfigOf(env) })
    expect(readInfo(folder).transcricao).toMatchObject({ status: 'falhou', erro: expect.stringMatching(/interrompida 3 vezes/) })
    expect(existsSync(env.tools.calls)).toBe(false)
    expect(existsSync(join(folder, 'audio.webm'))).toBe(true)
    expect(await listJobs(env.configDir)).toEqual([])
  })

  it('processo travado passa do limite de tempo: o whisper (e o que ele abriu) morre e a call falha com o motivo', async () => {
    const env = setup()
    writeFileSync(join(env.tools.dir, 'espera'), '30')
    const folder = recording(env, 'Travada', { duracaoSegundos: 0 })
    await enqueueTranscription(env.configDir, folder, {})
    const t0 = Date.now()
    await runWorker(env.configDir, { readConfig: readConfigOf(env), minTimeoutMs: 500 })
    expect(Date.now() - t0).toBeLessThan(10_000)
    expect(readInfo(folder).transcricao).toMatchObject({ status: 'falhou', erro: 'o whisper-cli passou do tempo limite' })
    const pid = Number(readFileSync(env.tools.calls, 'utf8').trim().split(' ')[1])
    expect(pidAlive(pid)).toBe(false)
  }, 20_000)

  it('um trabalho que entra com a fila vazia, antes de a trava sair, é pego pelo mesmo worker', async () => {
    const env = setup()
    const a = recording(env, 'Primeira')
    const b = recording(env, 'Entrou no meio')
    await enqueueTranscription(env.configDir, a, {})
    let once = false
    const processed = await runWorker(env.configDir, {
      readConfig: readConfigOf(env),
      // O helper põe na fila, vê a trava viva e não abre outro worker.
      beforeRelease: async () => {
        if (once) return
        once = true
        await enqueueTranscription(env.configDir, b, {})
        expect(await lockHolder(env.configDir)).toMatchObject({ pid: process.pid })
      },
    })
    expect(processed).toBe(2)
    expect(readInfo(b).transcricao.status).toBe('pronta')
  })

  it('desligar a transcrição com o worker rodando: ele para depois do trabalho atual e deixa o resto na fila', async () => {
    const env = setup()
    const [a, b] = ['Antes', 'Depois'].map((n) => recording(env, n))
    for (const f of [a, b]) await enqueueTranscription(env.configDir, f, {})
    let reads = 0
    const readConfig = async () => {
      const cfg = JSON.parse(readFileSync(env.configFile, 'utf8'))
      // A 1a leitura é a conferência antes do 1o trabalho, a 2a é a do processJob; depois, desligada.
      return ++reads > 2 ? { ...cfg, transcricao: { ...cfg.transcricao, ativa: false } } : cfg
    }
    expect(await runWorker(env.configDir, { readConfig })).toBe(1)
    expect(readInfo(a).transcricao.status).toBe('pronta')
    expect(readInfo(b).transcricao.status).toBe('pendente')
    expect(await listJobs(env.configDir)).toHaveLength(1)
    expect(existsSync(join(queueDir(env.configDir), 'worker.lock'))).toBe(false)
  })

  it('erro inesperado (pasta sem permissão): o worker não fica em laço, tenta de novo depois e desiste na terceira', async () => {
    const env = setup()
    const folder = recording(env, 'Sem permissão')
    await enqueueTranscription(env.configDir, folder, {})
    chmodSync(folder, 0o555)
    try {
      for (let round = 1; round <= 3; round++) {
        const t0 = Date.now()
        await runWorker(env.configDir, { readConfig: readConfigOf(env) })
        expect(Date.now() - t0).toBeLessThan(10_000)
        const jobs = await listJobs(env.configDir)
        if (round < 3) expect(jobs.map((j: any) => j.errosInesperados)).toEqual([round])
        else expect(jobs).toEqual([])
        // Nada de temporário pela metade na pasta da call.
        expect(readdirSync(folder).sort()).toEqual(['audio.webm', 'info.json'])
      }
      // O info.json não pôde ser escrito (continua pendente): o status reconcilia como falhou.
      const t = readInfo(folder).transcricao
      expect(t.status).toBe('pendente')
      expect(reconcileTranscription(t, { queued: false, ageMs: 60_000 })).toMatchObject({ status: 'falhou', erro: expect.stringMatching(/saiu da fila sem terminar/) })
      expect(reconcileTranscription(t, { queued: true, ageMs: 60_000 })).toBe(t)
      expect(reconcileTranscription(t, { queued: false, ageMs: 1000 })).toBe(t)
    } finally {
      chmodSync(folder, 0o755)
    }
    // Pendente sem trabalho na fila: enfileirar de novo aceita (o trabalho tinha se perdido).
    expect(await enqueueTranscription(env.configDir, folder, {})).toMatchObject({ queued: true })
  }, 40_000)

  it('modo aba na pasta da página: o áudio do modo aba é transcrito também (transcricao-aba.md) e vira o principal; o da página fica', async () => {
    const env = setup()
    writeFileSync(join(env.tools.dir, 'eco'), '')
    const folder = recording(env, 'Com aba')
    writeFileSync(join(folder, 'audio.webm'), 'silencio da pagina')
    await enqueueTranscription(env.configDir, folder, {})
    await runWorker(env.configDir, { readConfig: readConfigOf(env) })
    const pagina = readInfo(folder).transcricao
    expect(pagina).toMatchObject({ status: 'pronta', audio: 'audio.webm', arquivos: ['transcricao.md', 'transcricao.srt'] })

    // O finalize do modo aba põe o audio-aba.webm na pasta e enfileira de novo.
    writeFileSync(join(folder, 'audio-aba.webm'), 'fala de verdade pela aba')
    expect(await enqueueTranscription(env.configDir, folder, {})).toMatchObject({ queued: true, ids: [expect.any(String)] })
    expect(readInfo(folder).transcricao).toMatchObject({ status: 'pendente', audio: 'audio-aba.webm' })
    expect(readInfo(folder).transcricoes['audio.webm']).toEqual(pagina)
    // Repetido: nem o da página (pronta) nem o da aba (na fila) duplicam.
    expect(await enqueueTranscription(env.configDir, folder, {})).toMatchObject({ queued: false, motivo: 'audio.webm: já pronta; audio-aba.webm: já na fila' })

    await runWorker(env.configDir, { readConfig: readConfigOf(env) })
    const info = readInfo(folder)
    expect(info.transcricao).toMatchObject({ status: 'pronta', audio: 'audio-aba.webm', arquivos: ['transcricao-aba.md', 'transcricao-aba.srt'] })
    expect(info.transcricoes['audio-aba.webm']).toEqual(info.transcricao)
    expect(info.transcricoes['audio.webm']).toEqual(pagina)
    expect(readdirSync(folder).sort()).toEqual(['audio-aba.webm', 'audio.webm', 'info.json', 'transcricao-aba.md', 'transcricao-aba.srt', 'transcricao.md', 'transcricao.srt'])
    expect(readFileSync(join(folder, 'transcricao-aba.md'), 'utf8')).toContain('[00:00] fala de verdade pela aba segunda frase.')
    expect(readFileSync(join(folder, 'transcricao-aba.md'), 'utf8')).toContain('- **Áudio:** audio-aba.webm (modo aba)')
    expect(readFileSync(join(folder, 'transcricao.md'), 'utf8')).toContain('[00:00] silencio da pagina segunda frase.')
  })

  it('as pausas que o ffmpeg mede chegam ao transcricao.md: quebram o parágrafo, e o que caiu em silêncio total sai', async () => {
    const env = setup()
    // Pausa de 2,05 s entre as duas frases do whisper falso (0-2,5 s e 2,6-4 s).
    writeFileSync(join(env.tools.dir, 'silencios.txt'), '[silencedetect @ 0x1] silence_start: 0.5\n[silencedetect @ 0x1] silence_end: 2.55 | silence_duration: 2.05\n')
    const comPausa = recording(env, 'Com pausa')
    await enqueueTranscription(env.configDir, comPausa, {})
    await runWorker(env.configDir, { readConfig: readConfigOf(env) })
    const md = readFileSync(join(comPausa, 'transcricao.md'), 'utf8')
    expect(md).toContain(`[00:00] ${FAKE_TEXT}\n\n[00:02] segunda frase.`)
    // Gravação muda: as duas frases caíram dentro do silêncio, o .md diz que não houve fala.
    writeFileSync(join(env.tools.dir, 'silencios.txt'), '[silencedetect @ 0x1] silence_start: 0\n[silencedetect @ 0x1] silence_end: 10 | silence_duration: 10\n')
    const muda = recording(env, 'Muda')
    await enqueueTranscription(env.configDir, muda, {})
    await runWorker(env.configDir, { readConfig: readConfigOf(env) })
    expect(readFileSync(join(muda, 'transcricao.md'), 'utf8')).toContain('_Nenhuma fala reconhecida na gravação._')
    expect(readFileSync(join(muda, 'transcricao.srt'), 'utf8')).toBe('')
    expect(readInfo(muda).transcricao.status).toBe('pronta')
  })

  it('pasta só do modo aba: transcreve o audio-aba.webm', async () => {
    const env = setup()
    const folder = recording(env, 'Só aba')
    rmSync(join(folder, 'audio.webm'))
    writeFileSync(join(folder, 'audio-aba.webm'), 'x')
    await enqueueTranscription(env.configDir, folder, {})
    await runWorker(env.configDir, { readConfig: readConfigOf(env) })
    expect(readInfo(folder).transcricao).toMatchObject({ status: 'pronta', audio: 'audio-aba.webm', arquivos: ['transcricao-aba.md', 'transcricao-aba.srt'] })
  })

  it('pid reaproveitado: o worker novo não mata um processo qualquer que herdou o pid do whisper órfão', async () => {
    const env = setup()
    const folder = recording(env, 'Pid reaproveitado')
    await enqueueTranscription(env.configDir, folder, {})
    const intruso = spawn('/bin/sleep', ['30'])
    try {
      await waitFor(() => pidAlive(intruso.pid as number), 5000, 'o sleep subir')
      const [job] = await listJobs(env.configDir)
      const { file, ...rest } = job
      writeFileSync(file, JSON.stringify({ ...rest, estado: 'transcrevendo', tentativas: 1, filhoPid: intruso.pid, filhoCmd: 'whisper-cli' }))
      await runWorker(env.configDir, { readConfig: readConfigOf(env) })
      expect(readInfo(folder).transcricao.status).toBe('pronta')
      expect(pidAlive(intruso.pid as number)).toBe(true)
    } finally {
      intruso.kill('SIGKILL')
    }
  })

  it('um por vez: dois workers ao mesmo tempo processam três trabalhos sem nunca rodar dois whisper juntos', async () => {
    const env = setup()
    writeFileSync(join(env.tools.dir, 'espera'), '0.4')
    const folders = ['Um', 'Dois', 'Três'].map((name) => recording(env, name))
    for (const f of folders) await enqueueTranscription(env.configDir, f, {})
    const a = startWorker(env)
    const b = startWorker(env)
    expect(await a.done).toBe(0)
    expect(await b.done).toBe(0)
    for (const f of folders) expect(readInfo(f).transcricao.status, f).toBe('pronta')
    const calls = readFileSync(env.tools.calls, 'utf8').trim().split('\n')
    // Três whisper, cada um termina antes de o próximo começar.
    expect(calls.map((l) => l.split(' ')[0])).toEqual(['inicio', 'fim', 'inicio', 'fim', 'inicio', 'fim'])
    for (let i = 0; i < calls.length; i += 2) expect(calls[i].split(' ')[1]).toBe(calls[i + 1].split(' ')[1])
    expect(`${a.log()}${b.log()}`).toMatch(/outro worker já está rodando|fila vazia/)
    expect(existsSync(join(queueDir(env.configDir), 'worker.lock'))).toBe(false)
  }, 30_000)

  it('retoma depois de um worker morto com kill -9: mata o whisper que sobrou e termina o trabalho', async () => {
    const env = setup()
    writeFileSync(join(env.tools.dir, 'espera'), '30')
    const folder = recording(env, 'Retomada')
    await enqueueTranscription(env.configDir, folder, {})
    const first = startWorker(env)
    // Espera o whisper falso começar (o "inicio" no log dele) e o pid dele no trabalho: o log pode
    // chegar antes da gravação do pid, e o pid antes de o script chegar no sleep.
    let job: any
    const t0 = Date.now()
    while (!existsSync(env.tools.calls) || !(job = (await listJobs(env.configDir))[0]) || job.filhoCmd !== 'whisper-cli') {
      if (Date.now() - t0 > 10_000) throw new Error('esperei demais: o whisper falso começar')
      await new Promise((r) => setTimeout(r, 50))
    }
    await new Promise((r) => setTimeout(r, 200))
    expect(job).toMatchObject({ estado: 'transcrevendo', tentativas: 1, filhoCmd: 'whisper-cli' })
    const orphan = job.filhoPid as number
    expect(pidAlive(orphan)).toBe(true)
    first.child.kill('SIGKILL')
    await first.done
    // O worker morreu, mas a trava ficou no disco e o whisper continua rodando (órfão).
    expect(existsSync(join(queueDir(env.configDir), 'worker.lock'))).toBe(true)
    expect(pidAlive(orphan)).toBe(true)
    expect(readInfo(folder).transcricao.status).toBe('transcrevendo')

    rmSync(join(env.tools.dir, 'espera'))
    const second = startWorker(env)
    expect(await second.done).toBe(0)
    expect(pidAlive(orphan)).toBe(false)
    expect(second.log()).toMatch(/matando o processo que sobrou/)
    expect(readInfo(folder).transcricao.status).toBe('pronta')
    expect(readFileSync(join(folder, 'transcricao.md'), 'utf8')).toContain(FAKE_TEXT)
    expect(await listJobs(env.configDir)).toEqual([])
  }, 30_000)

  it('trava velha (pid morto) é retomada; trava de um processo vivo faz o segundo worker sair sem mexer na fila', async () => {
    const env = setup()
    const folder = recording(env, 'Trava')
    await enqueueTranscription(env.configDir, folder, {})
    const lock = join(queueDir(env.configDir), 'worker.lock')
    // Um processo vivo (este teste) segura a trava.
    writeFileSync(lock, JSON.stringify({ pid: process.pid, inicio: new Date().toISOString() }))
    expect(await lockHolder(env.configDir)).toMatchObject({ pid: process.pid })
    expect(await runWorker(env.configDir, { readConfig: readConfigOf(env) })).toBe(0)
    expect(readInfo(folder).transcricao.status).toBe('pendente')

    // Agora de um pid que já morreu.
    const dead = spawn('/bin/sh', ['-c', 'exit 0'])
    await new Promise((r) => dead.on('close', r))
    writeFileSync(lock, JSON.stringify({ pid: dead.pid, inicio: new Date().toISOString() }))
    expect(await lockHolder(env.configDir)).toBeNull()
    expect(await runWorker(env.configDir, { readConfig: readConfigOf(env) })).toBe(1)
    expect(readInfo(folder).transcricao.status).toBe('pronta')
    expect(existsSync(lock)).toBe(false)
  })

  it('trava de um pid reaproveitado (o processo começou depois da trava, como depois de um reboot) é velha', async () => {
    const env = setup()
    const folder = recording(env, 'Reboot')
    await enqueueTranscription(env.configDir, folder, {})
    const lock = join(queueDir(env.configDir), 'worker.lock')
    writeFileSync(lock, JSON.stringify({ pid: process.pid, inicio: '2020-01-01T00:00:00.000Z' }))
    expect(await lockHolder(env.configDir)).toBeNull()
    expect(await runWorker(env.configDir, { readConfig: readConfigOf(env) })).toBe(1)
    expect(readInfo(folder).transcricao.status).toBe('pronta')
  })

  it('trava velha disputada ao mesmo tempo por processos diferentes: só um pega (nunca dois workers, nunca dois whisper)', async () => {
    const env = setup()
    const dir = queueDir(env.configDir)
    mkdirSync(dir, { recursive: true })
    const lock = join(dir, 'worker.lock')
    const sync = join(env.configDir, 'disputa')
    mkdirSync(sync, { recursive: true })
    const ROUNDS = 80
    // Quatro processos de verdade (como helpers de perfis diferentes abrindo workers ao mesmo
    // tempo), vivos a disputa inteira: em cada rodada esperam o sinal e chamam acquireLock juntos.
    const script = join(env.configDir, 'disputa.mjs')
    writeFileSync(
      script,
      [
        `import { existsSync, writeFileSync } from 'node:fs'`,
        `import { acquireLock } from ${JSON.stringify(pathToFileURL(resolve(dirname(fileURLToPath(import.meta.url)), '../../host/transcricao.mjs')).href)}`,
        `const [configDir, sync, rounds] = process.argv.slice(2)`,
        `const wait = async (f) => { while (!existsSync(f)) await new Promise((r) => setTimeout(r, 1)) }`,
        `for (let r = 0; r < Number(rounds); r++) {`,
        `  await wait(sync + '/vai-' + r)`,
        `  const got = await acquireLock(configDir, process.pid)`,
        `  writeFileSync(sync + '/res-' + r + '-' + process.pid, String(got))`,
        `  await wait(sync + '/fim-' + r)`,
        `}`,
      ].join('\n'),
    )
    const procs = Array.from({ length: 4 }, () => spawn(process.execPath, [script, env.configDir, sync, String(ROUNDS)], { stdio: 'ignore' }))
    try {
      const dead = spawn('/bin/sh', ['-c', 'exit 0'])
      await new Promise((r) => dead.on('close', r))
      let duplos = 0
      for (let round = 0; round < ROUNDS; round++) {
        writeFileSync(lock, JSON.stringify({ pid: dead.pid, inicio: new Date().toISOString() }))
        writeFileSync(join(sync, `vai-${round}`), '')
        await waitFor(() => readdirSync(sync).filter((f) => f.startsWith(`res-${round}-`)).length === procs.length, 15_000, `rodada ${round}`)
        const results = readdirSync(sync)
          .filter((f) => f.startsWith(`res-${round}-`))
          .map((f) => ({ pid: Number(f.split('-')[2]), got: readFileSync(join(sync, f), 'utf8') === 'true' }))
        const winners = results.filter((x) => x.got)
        if (winners.length !== 1) duplos++
        // Quem ficou com a trava é quem disse que pegou.
        expect(winners.map((w) => w.pid), `rodada ${round}`).toContain(JSON.parse(readFileSync(lock, 'utf8')).pid)
        rmSync(lock, { force: true })
        writeFileSync(join(sync, `fim-${round}`), '')
      }
      expect(duplos).toBe(0)
      expect(existsSync(`${lock}.troca`)).toBe(false)
    } finally {
      for (const p of procs) p.kill('SIGKILL')
    }
  }, 120_000)

  it('escrita atômica que falha não deixa o temporário para trás', async () => {
    const env = setup()
    const alvo = join(env.root, 'alvo')
    mkdirSync(join(alvo, 'dentro'), { recursive: true })
    await expect(writeAtomic(alvo, 'x')).rejects.toThrow()
    expect(readdirSync(env.root).filter((n) => n.includes('.tmp-'))).toEqual([])
  })

  it('a trava é exclusiva e só o dono a solta', async () => {
    const env = setup()
    expect(await acquireLock(env.configDir, process.pid)).toBe(true)
    expect(await acquireLock(env.configDir, process.pid)).toBe(false)
    await releaseLock(env.configDir, 1)
    expect(await lockHolder(env.configDir)).toMatchObject({ pid: process.pid })
    await releaseLock(env.configDir, process.pid)
    expect(await lockHolder(env.configDir)).toBeNull()
  })

  it('pasta apagada antes da vez dela: o trabalho sai da fila sem erro', async () => {
    const env = setup()
    const folder = recording(env, 'Apagada')
    await enqueueTranscription(env.configDir, folder, {})
    rmSync(folder, { recursive: true, force: true })
    await runWorker(env.configDir, { readConfig: readConfigOf(env) })
    expect(await listJobs(env.configDir)).toEqual([])
  })
})
