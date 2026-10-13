// Transcrição automática ao fim de cada call (Emenda 13). Node sem dependências, usado pelo helper
// (host/gravador-host.mjs: configuração, enfileirar, operações) e pelo worker destacado
// (host/transcrever.mjs: processa a fila).
//
// Partes:
// - configuração `transcricao` do config.json do helper (vale para todos os perfis, como a raiz);
// - motores de transcrição, com uma interface só (ENGINES, abaixo);
// - texto de saída: transcricao.md (cabeçalho + parágrafos com o tempo) e transcricao.srt, por
//   áudio da pasta (transcricao-aba.md para o audio-aba.webm do modo aba);
// - fila durável em <pasta do config.json>/fila, um trabalho por áudio, e a trava do worker
//   (worker.lock com o pid, trocada sob worker.lock.troca quando velha);
// - processamento de um trabalho: info.json atualizado de forma atômica a cada estado.
//
// Nada aqui apaga o áudio da gravação: uma falha vira `transcricao.status = 'falhou'` com o motivo.
import { spawn } from 'node:child_process'
import { constants as fsc } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  ENGINE_LABELS,
  LANGUAGE_RE,
  PARAGRAPH,
  SPEAKERS_FILE,
  assignSpeakers,
  buildMarkdown,
  buildSrt,
  collapseRepeats,
  dropInventedSegments,
  errorLine,
  fillSpeakerGaps,
  isObj,
  rankModel,
  segmentsFromWhisperJson,
  silencesFromFfmpeg,
  speakerTimelineFrom,
  transcriptStem,
  transcriptionsOf,
} from './texto.mjs'

// O texto da transcrição (parágrafos, falantes, markdown, SRT) mora em host/texto.mjs, importado
// também pela extensão (Emenda 21). Aqui ele é reexportado: o helper, os scripts e os testes
// continuam pedindo tudo a este arquivo, e não existe uma segunda cópia das regras.
export {
  ENGINE_LABELS,
  LANGUAGE_RE,
  MARKDOWN_LABELS,
  MIN_SELF_LINE_SEC,
  MODEL_PREFERENCE,
  NEIGHBOR_GAP_SEC,
  ORPHAN_GRACE_MS,
  PARAGRAPH,
  REPEATS,
  SELF_MAX_COVERED,
  SPEAKERS_FILE,
  UNNAMED_SHADOW,
  assignSpeakers,
  buildMarkdown,
  buildSrt,
  checkUnnamedSources,
  cleanSpeakerName,
  collapseInside,
  collapseRepeats,
  dropInventedSegments,
  errorLine,
  fillSpeakerGaps,
  formatClock,
  formatDuration,
  formatLocalStart,
  formatSrtTime,
  isObj,
  markdownLanguage,
  mdLine,
  mdName,
  mergeSegments,
  pausedBetween,
  platformLabel,
  rankModel,
  reconcileTranscription,
  segmentsFromWhisperJson,
  selfLines,
  silencesFromFfmpeg,
  speakerTimelineFrom,
  speechText,
  srtName,
  transcriptStem,
  transcriptionsOf,
} from './texto.mjs'

// ---------------------------------------------------------------------------------------------
// Configuração
// ---------------------------------------------------------------------------------------------

/** Padrões da seção `transcricao` do config.json. Modelo vazio: descobre sozinho. */
export const TRANSCRIPTION_DEFAULTS = Object.freeze({
  ativa: true,
  motor: 'whisper-cpp',
  modelo: '',
  idioma: 'auto',
  whisperCli: '',
  ffmpeg: '',
})

const PATH_FIELDS = ['modelo', 'whisperCli', 'ffmpeg']

export function expandHomePath(p) {
  const s = String(p ?? '').trim()
  if (!s) return ''
  if (s === '~') return os.homedir()
  if (s.startsWith('~/')) return path.join(os.homedir(), s.slice(2))
  return path.resolve(s)
}

/** Mescla o que está no config.json com os padrões; campo inválido volta ao padrão. */
export function normalizeTranscriptionConfig(raw) {
  const obj = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const out = { ...TRANSCRIPTION_DEFAULTS }
  if (typeof obj.ativa === 'boolean') out.ativa = obj.ativa
  if (typeof obj.motor === 'string' && Object.hasOwn(ENGINES, obj.motor)) out.motor = obj.motor
  if (typeof obj.idioma === 'string' && LANGUAGE_RE.test(obj.idioma)) out.idioma = obj.idioma
  for (const f of PATH_FIELDS) if (typeof obj[f] === 'string') out[f] = obj[f].trim()
  return out
}

async function isFile(p) {
  try {
    return (await fs.stat(p)).isFile()
  } catch {
    return false
  }
}

async function isExecutable(p) {
  try {
    if (!(await fs.stat(p)).isFile()) return false
    await fs.access(p, fsc.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Valida um pedido de mudança (op set-transcription) e devolve a configuração nova. Erros em
 * português, prontos para a tela das configurações.
 */
export async function applyTranscriptionPatch(current, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('pedido inválido: falta a mudança')
  const next = { ...normalizeTranscriptionConfig(current) }
  for (const [key, value] of Object.entries(patch)) {
    switch (key) {
      case 'ativa':
        if (typeof value !== 'boolean') throw new Error('ativa precisa ser verdadeiro ou falso')
        next.ativa = value
        break
      case 'motor':
        if (typeof value !== 'string' || !Object.hasOwn(ENGINES, value)) throw new Error(`motor desconhecido: ${value}`)
        next.motor = value
        break
      case 'idioma':
        if (typeof value !== 'string' || !LANGUAGE_RE.test(value)) throw new Error(`idioma inválido: ${value} (use auto, pt, en...)`)
        next.idioma = value
        break
      case 'modelo':
      case 'whisperCli':
      case 'ffmpeg': {
        if (typeof value !== 'string' || value.length > 4096 || value.includes('\0')) throw new Error(`${key} inválido`)
        const trimmed = value.trim()
        // Só confere o caminho que mudou: um modelo que sumiu da pasta não pode impedir de salvar o
        // resto (nem de desligar a transcrição), já que a tela manda a configuração inteira.
        if (trimmed && trimmed !== next[key]) {
          if (!trimmed.startsWith('/') && !trimmed.startsWith('~')) throw new Error(`${key}: use um caminho absoluto ou começando com ~`)
          const abs = expandHomePath(trimmed)
          if (key === 'modelo' && !(await isFile(abs))) throw new Error(`modelo não encontrado: ${abs}`)
          if (key !== 'modelo' && !(await isExecutable(abs))) throw new Error(`${key === 'ffmpeg' ? 'ffmpeg' : 'whisper-cli'} não encontrado ou sem permissão de execução: ${abs}`)
        }
        next[key] = trimmed
        break
      }
      default:
        throw new Error(`campo desconhecido: ${key}`)
    }
  }
  return next
}

// ---------------------------------------------------------------------------------------------
// Descoberta de programas e modelos
// ---------------------------------------------------------------------------------------------

/**
 * Pastas de reserva para os programas: o Chrome abre o helper sem o PATH do terminal, então o
 * Homebrew (Apple Silicon e Intel) entra mesmo quando não está no PATH.
 */
export const FALLBACK_BIN_DIRS = ['/opt/homebrew/bin', '/usr/local/bin']

/**
 * Acha um executável: o caminho configurado (se houver, só ele: um caminho errado na
 * configuração é um erro a mostrar, não um motivo para usar outro programa), depois o PATH, depois
 * as pastas de reserva.
 */
export async function findExecutable(names, { configured = '', env = process.env, fallbackDirs = FALLBACK_BIN_DIRS, label = names[0] } = {}) {
  if (configured) {
    const abs = expandHomePath(configured)
    if (await isExecutable(abs)) return { path: abs }
    return { path: null, motivo: `${label} não encontrado em ${abs} (confira o caminho nas configurações)` }
  }
  const dirs = [...String(env.PATH ?? '').split(path.delimiter).filter(Boolean), ...fallbackDirs]
  const seen = new Set()
  for (const dir of dirs) {
    if (seen.has(dir) || !path.isAbsolute(dir)) continue
    seen.add(dir)
    for (const name of names) {
      const candidate = path.join(dir, name)
      if (await isExecutable(candidate)) return { path: candidate }
    }
  }
  return { path: null, motivo: `${label} não encontrado (instale com: brew install ${label === 'ffmpeg' ? 'ffmpeg' : 'whisper-cpp'}, ou informe o caminho nas configurações)` }
}

/** Pastas onde se costuma guardar os modelos do whisper.cpp. */
export function modelDirs({ home = os.homedir(), configDir } = {}) {
  const dirs = [
    path.join(home, '.cache', 'whisper-models'),
    path.join(home, '.whisper-models'),
    path.join(home, '.cache', 'whisper.cpp'),
    '/opt/homebrew/share/whisper-cpp/models',
    '/opt/homebrew/share/whisper-cpp',
    '/usr/local/share/whisper-cpp/models',
    '/usr/local/share/whisper-cpp',
  ]
  if (configDir) dirs.push(path.join(configDir, 'modelos'))
  if (process.platform === 'darwin') dirs.push(path.join(home, 'Library', 'Application Support', 'gravador-de-calls', 'modelos'))
  return [...new Set(dirs)]
}

/** Modelo configurado (se houver, só ele) ou o melhor achado nas pastas comuns. */
export async function findModel({ configured = '', dirs = modelDirs(), idioma = 'auto' } = {}) {
  if (configured) {
    const abs = expandHomePath(configured)
    if (await isFile(abs)) return { path: abs }
    return { path: null, motivo: `modelo não encontrado: ${abs}` }
  }
  let best = null
  for (const dir of dirs) {
    let entries
    try {
      entries = await fs.readdir(dir)
    } catch {
      continue
    }
    for (const name of entries) {
      const rank = rankModel(name, idioma)
      if (rank === null) continue
      const full = path.join(dir, name)
      if (!(await isFile(full))) continue
      if (!best || rank < best.rank) best = { rank, path: full }
    }
  }
  if (best) return { path: best.path }
  return {
    path: null,
    motivo: 'modelo não encontrado: baixe um modelo do whisper.cpp (ggml-tiny, base, small, medium ou large, como ggml-small.bin) para ~/.cache/whisper-models ou informe o caminho nas configurações',
  }
}

// ---------------------------------------------------------------------------------------------
// Processos
// ---------------------------------------------------------------------------------------------

/** SIGKILL no grupo do processo (o filho e o que ele abriu); sem grupo próprio, só nele. */
function killTree(pid) {
  try {
    process.kill(-pid, 'SIGKILL')
    return
  } catch {
    // não é líder de grupo (ou já saiu)
  }
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    // já saiu
  }
}

/**
 * Roda um programa e guarda só o fim da saída (o whisper escreve muito no stderr). `onSpawn`
 * recebe o pid e o nome do programa: o worker grava no trabalho para, se morrer, o próximo worker
 * matar o filho que sobrou (nunca dois whisper ao mesmo tempo). O filho abre o próprio grupo de
 * processos (`detached`), para o limite de tempo matar também o que ele tiver aberto.
 */
export function runProcess(cmd, args, { timeoutMs = 0, onSpawn, env = process.env, group = false, errMax = 16 * 1024 } = {}) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env, detached: group })
    } catch (e) {
      resolve({ code: -1, out: '', err: String(e?.message ?? e), timedOut: false })
      return
    }
    let out = ''
    let err = ''
    let timedOut = false
    let settled = false
    const keep = (s, d, max) => (s + d).slice(-max)
    child.stdout.on('data', (d) => (out = keep(out, d, 64 * 1024)))
    child.stderr.on('data', (d) => (err = keep(err, d, errMax)))
    // O registro do pid termina antes de devolver: quem chama pode apagar o trabalho logo depois.
    const recorded = child.pid && onSpawn ? Promise.resolve(onSpawn(child.pid, path.basename(cmd))).catch(() => {}) : Promise.resolve()
    const finish = (code, extraErr = '') => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      void recorded.then(() => resolve({ code, out, err: err + extraErr, timedOut }))
    }
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true
            if (group && child.pid) killTree(child.pid)
            else child.kill('SIGKILL')
          }, timeoutMs)
        : null
    child.on('error', (e) => finish(-1, String(e?.message ?? e)))
    // Passou do tempo: devolve quando o processo sai, sem esperar um neto que segure a saída aberta.
    child.on('exit', (code) => {
      if (timedOut) finish(code ?? -1)
    })
    child.on('close', (code) => finish(code ?? -1))
  })
}

// ---------------------------------------------------------------------------------------------
// Motores de transcrição
// ---------------------------------------------------------------------------------------------

/**
 * Um motor de transcrição é `{ id, available(), transcribe(job) }`:
 * - available(): Promise<{ ok, motivo?, detalhes }> diz se dá para transcrever agora e, se não,
 *   por quê (em português, para a tela); `detalhes` lista o que foi achado (caminhos).
 * - transcribe({ audioPath, tmpDir, timeoutMs, onSpawn }): Promise<{ segments: [{ start, end,
 *   text }], language, model, pauses? }>, com start e end em segundos; `pauses` ([{ start, end }])
 *   são os silêncios longos medidos no áudio, quando o motor sabe medir.
 *
 * A lista fica aberta de propósito (docs/LOJA.md): um motor no navegador (Whisper em WebGPU no
 * documento offscreen, com o modelo como dado e nenhum código remoto) e um motor na nuvem com a
 * chave do próprio usuário entram aqui com o mesmo contrato, sem mudar a fila nem os arquivos de
 * saída. Hoje só existe o whisper.cpp local.
 */
export const ENGINES = {
  'whisper-cpp': createWhisperCppEngine,
}

/** Cria o motor configurado. `ctx`: { env, fallbackDirs, modelDirs } (os testes trocam). */
export function createEngine(cfg, ctx = {}) {
  const config = normalizeTranscriptionConfig(cfg)
  const factory = ENGINES[config.motor]
  if (!factory) throw new Error(`motor desconhecido: ${config.motor}`)
  return factory(config, ctx)
}

/** Abaixo disto o áudio conta como silêncio (a call chega sem ruído de fundo, pelo WebRTC). */
const SILENCE_NOISE = '-40dB'

/** whisper.cpp (whisper-cli) com o áudio convertido antes pelo ffmpeg para WAV 16 kHz mono. */
export function createWhisperCppEngine(cfg, ctx = {}) {
  const config = normalizeTranscriptionConfig(cfg)
  const discover = async () => {
    const [whisper, ffmpeg, model] = await Promise.all([
      findExecutable(['whisper-cli', 'whisper-cpp'], { configured: config.whisperCli, env: ctx.env, fallbackDirs: ctx.fallbackDirs, label: 'whisper-cli' }),
      findExecutable(['ffmpeg'], { configured: config.ffmpeg, env: ctx.env, fallbackDirs: ctx.fallbackDirs, label: 'ffmpeg' }),
      findModel({ configured: config.modelo, dirs: ctx.modelDirs ?? modelDirs({ configDir: ctx.configDir }), idioma: config.idioma }),
    ])
    return { whisper, ffmpeg, model }
  }
  return {
    id: 'whisper-cpp',
    async available() {
      const { whisper, ffmpeg, model } = await discover()
      const detalhes = { whisperCli: whisper.path, ffmpeg: ffmpeg.path, modelo: model.path }
      const motivo = whisper.motivo ?? ffmpeg.motivo ?? model.motivo
      return motivo ? { ok: false, motivo, detalhes } : { ok: true, detalhes }
    },
    async transcribe({ audioPath, tmpDir, timeoutMs = 0, onSpawn }) {
      const { whisper, ffmpeg, model } = await discover()
      const motivo = whisper.motivo ?? ffmpeg.motivo ?? model.motivo
      if (motivo) throw new Error(motivo)
      const wav = path.join(tmpDir, 'audio.wav')
      // whisper.cpp 1.9 só lê wav, mp3, flac e ogg-vorbis; o WebM/Opus da gravação passa pelo ffmpeg.
      // aresample=async=1 preenche as lacunas de tempo do WebM (chunks perdidos) em vez de colar.
      // silencedetect mede as pausas (no stderr, nível info) para os parágrafos do transcricao.md.
      const conv = await runProcess(
        ffmpeg.path,
        [
          '-nostdin',
          '-hide_banner',
          '-nostats',
          '-v',
          'info',
          '-y',
          '-i',
          audioPath,
          '-af',
          `aresample=async=1,silencedetect=noise=${SILENCE_NOISE}:d=${PARAGRAPH.maxGapSec}`,
          '-ar',
          '16000',
          '-ac',
          '1',
          '-c:a',
          'pcm_s16le',
          wav,
        ],
        { timeoutMs, onSpawn, env: ctx.env, group: true, errMax: 4 * 1024 * 1024 },
      )
      if (conv.timedOut) throw new Error('o ffmpeg passou do tempo limite convertendo o áudio')
      if (conv.code !== 0 || !(await isFile(wav))) throw new Error(`o ffmpeg não conseguiu converter o áudio${errorLine(conv.err) ? `: ${errorLine(conv.err)}` : ''}`)
      const outBase = path.join(tmpDir, 'saida')
      const threads = String(Math.max(1, Math.min(4, Math.floor(os.cpus().length / 2) || 1)))
      const run = await runProcess(whisper.path, ['-m', model.path, '-l', config.idioma, '-t', threads, '-f', wav, '-oj', '-of', outBase, '-np'], {
        timeoutMs,
        onSpawn,
        env: ctx.env,
        group: true,
      })
      if (run.timedOut) throw new Error('o whisper-cli passou do tempo limite')
      if (run.code !== 0) throw new Error(`o whisper-cli falhou (código ${run.code})${errorLine(run.err) ? `: ${errorLine(run.err)}` : ''}`)
      let json
      try {
        json = JSON.parse(await fs.readFile(`${outBase}.json`, 'utf8'))
      } catch {
        throw new Error('o whisper-cli terminou sem escrever o resultado (JSON)')
      }
      return {
        segments: segmentsFromWhisperJson(json),
        language: typeof json?.result?.language === 'string' && json.result.language ? json.result.language : config.idioma,
        model: path.basename(model.path),
        pauses: silencesFromFfmpeg(conv.err),
      }
    },
  }
}

export async function readSpeakerTimeline(folder, audio) {
  return speakerTimelineFrom(await readJson(path.join(folder, SPEAKERS_FILE)), audio)
}

// ---------------------------------------------------------------------------------------------
// Escrita atômica e info.json
// ---------------------------------------------------------------------------------------------

/** Escreve num temporário ao lado, faz fsync e troca pelo nome final (nunca há arquivo pela metade). */
export async function writeAtomic(p, data) {
  const tmp = `${p}.tmp-${process.pid}-${Math.random().toString(16).slice(2, 8)}`
  try {
    const fh = await fs.open(tmp, 'w')
    try {
      await fh.writeFile(data)
      await fh.sync()
    } finally {
      await fh.close()
    }
    await fs.rename(tmp, p)
  } catch (e) {
    // Disco cheio ou pasta sem permissão: o temporário não fica para trás.
    await fs.rm(tmp, { force: true }).catch(() => {})
    throw e
  }
}

export async function readJson(p) {
  try {
    return JSON.parse(await fs.readFile(p, 'utf8'))
  } catch {
    return null
  }
}

/** Campos que só valem no estado em que foram escritos: somem na mudança seguinte que não os traz. */
const TRANSIENT_FIELDS = ['erro', 'espera']

/**
 * Muda o estado da transcrição de um áudio no info.json da pasta (lê, muda, escreve atômico):
 * `transcricoes[audio]` e, quando este é o áudio principal, `transcricao` (o que o popup mostra).
 * `primary`: este áudio passa a ser o principal (o último posto na fila, como o do modo aba que
 * entrou depois na pasta da página). Sem info.json (a pasta sumiu ou ainda não terminou) não cria
 * um: devolve false.
 */
export async function updateInfoTranscription(folder, audio, patch, { primary = false } = {}) {
  const infoPath = path.join(folder, 'info.json')
  const info = await readJson(infoPath)
  if (!isObj(info)) return false
  const all = transcriptionsOf(info)
  const next = { ...(isObj(all[audio]) ? all[audio] : {}), ...patch, audio }
  for (const f of TRANSIENT_FIELDS) if (!(f in patch)) delete next[f]
  all[audio] = next
  const current = isObj(info.transcricao) && typeof info.transcricao.audio === 'string' && isObj(all[info.transcricao.audio]) ? info.transcricao.audio : null
  info.transcricao = all[primary || !current ? audio : current]
  info.transcricoes = all
  await writeAtomic(infoPath, JSON.stringify(info, null, 2) + '\n')
  return true
}

// ---------------------------------------------------------------------------------------------
// Fila e trava do worker
// ---------------------------------------------------------------------------------------------

export const QUEUE_DIR = 'fila'
const LOCK_FILE = 'worker.lock'
/** Trava de troca: só quem a segura tira uma trava velha do worker. */
const TAKEOVER_SUFFIX = '.troca'
/** Uma trava de troca mais velha que isto é de um processo que morreu no meio da troca. */
const TAKEOVER_STALE_MS = 10_000
const JOB_RE = /^\d{13}-[a-f0-9]{8}\.json$/
/** Um trabalho interrompido tantas vezes (o worker morreu no meio) vira falha. */
export const MAX_ATTEMPTS = 3
/** Erros inesperados (disco, permissão) num trabalho antes de ele sair da fila de vez. */
export const MAX_UNEXPECTED_ERRORS = 3
/** Limite de tempo mínimo de cada processo (ffmpeg, whisper); a call longa ganha mais. */
export const MIN_TIMEOUT_MS = 20 * 60_000

export function queueDir(configDir) {
  return path.join(configDir, QUEUE_DIR)
}

const AUDIO_RE = /^audio[\w ()-]*\.webm$/i

/**
 * Áudios a transcrever na pasta: audio.webm (a página) primeiro, depois os outros audio*.webm
 * (audio-aba.webm do modo aba, sozinho ou junto da página).
 */
export async function listAudios(folder) {
  let entries
  try {
    entries = (await fs.readdir(folder)).sort()
  } catch {
    return []
  }
  const audios = entries.filter((e) => AUDIO_RE.test(e))
  return [...audios.filter((a) => a === 'audio.webm'), ...audios.filter((a) => a !== 'audio.webm')]
}

export async function listJobs(configDir) {
  const dir = queueDir(configDir)
  let entries
  try {
    entries = await fs.readdir(dir)
  } catch {
    return []
  }
  const jobs = []
  for (const name of entries.filter((e) => JOB_RE.test(e)).sort()) {
    const job = await readJson(path.join(dir, name))
    if (job && typeof job.pasta === 'string' && typeof job.audio === 'string') jobs.push({ ...job, file: path.join(dir, name) })
  }
  return jobs
}

const samePath = (a, b) => path.resolve(a) === path.resolve(b)

/**
 * Põe na fila cada áudio da pasta que ainda não foi transcrito (depois de o finalize escrever o
 * info.json) e marca `pendente` no info.json. Não duplica: o áudio já na fila ou já pronto fica
 * como está. Um pendente sem trabalho na fila (o trabalho se perdeu) entra de novo, e um que
 * falhou também (é o refazer). Com `redo`, uma pronta também entra (transcrever de novo).
 */
export async function enqueueTranscription(configDir, folder, cfg, { redo = false } = {}) {
  const config = normalizeTranscriptionConfig(cfg)
  const audios = await listAudios(folder)
  if (!audios.length) return { queued: false, ids: [], motivo: 'sem áudio na pasta' }
  const info = await readJson(path.join(folder, 'info.json'))
  if (!isObj(info)) return { queued: false, ids: [], motivo: 'sem info.json na pasta' }
  const states = transcriptionsOf(info)
  const jobs = await listJobs(configDir)
  const dir = queueDir(configDir)
  await fs.mkdir(dir, { recursive: true })
  const ids = []
  const motivos = []
  const skip = (audio, motivo) => motivos.push(audios.length > 1 ? `${audio}: ${motivo}` : motivo)
  for (const audio of audios) {
    // `redo` (Emenda 20, npm run transcrever): uma pronta entra de novo, e o .md e o .srt são trocados.
    if (states[audio]?.status === 'pronta' && !redo) {
      skip(audio, 'já pronta')
      continue
    }
    if (jobs.some((j) => samePath(j.pasta, folder) && j.audio === audio)) {
      skip(audio, 'já na fila')
      continue
    }
    const id = `${Date.now()}-${Math.random().toString(16).slice(2, 10).padEnd(8, '0')}`
    // pendente antes de o trabalho existir: um worker já rodando que pegue o trabalho e falhe na
    // hora não tem o estado dele desfeito por esta escrita.
    await updateInfoTranscription(
      folder,
      audio,
      { status: 'pendente', motor: config.motor, modelo: null, idioma: config.idioma, inicio: null, fim: null, duracaoProcessamentoSeg: null, arquivos: [] },
      { primary: true },
    )
    const job = { versao: 1, id, pasta: folder, audio, criadoEm: new Date().toISOString(), estado: 'pendente', tentativas: 0 }
    await writeAtomic(path.join(dir, `${id}.json`), JSON.stringify(job, null, 2) + '\n')
    ids.push(id)
  }
  return ids.length ? { queued: true, id: ids[0], ids } : { queued: false, ids, motivo: motivos.join('; ') }
}

/** O processo existe? (EPERM: existe, de outro usuário.) */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e?.code === 'EPERM'
  }
}

/** Há quanto tempo o processo roda, em ms (ps -o etime=), ou null se não deu para saber. */
export async function processAgeMs(pid) {
  const r = await runProcess('ps', ['-p', String(pid), '-o', 'etime='])
  if (r.code !== 0) return null
  const m = /^\s*(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)\s*$/.exec(r.out)
  if (!m) return null
  return (((Number(m[1] ?? 0) * 24 + Number(m[2] ?? 0)) * 60 + Number(m[3])) * 60 + Number(m[4])) * 1000
}

/**
 * O pid da trava ainda é do worker que a criou? Depois de um reboot o mesmo pid pode ser de um
 * processo qualquer: um processo que começou depois da trava não é o dono dela.
 */
async function lockOwnerAlive(lock) {
  if (!pidAlive(lock.pid)) return false
  const created = Date.parse(lock.inicio)
  if (!Number.isFinite(created)) return true
  const age = await processAgeMs(lock.pid)
  if (age === null) return true
  return Date.now() - age <= created + 3000
}

/** { exists, holder }: a trava existe e quem a segura (null se é velha). */
async function inspectLock(p) {
  let st
  try {
    st = await fs.stat(p)
  } catch {
    return { exists: false, holder: null }
  }
  const lock = await readJson(p)
  if (!lock || !Number.isInteger(lock.pid)) {
    // Outro worker acabou de criar e ainda não escreveu o pid: não é uma trava velha.
    return { exists: true, holder: Date.now() - st.mtimeMs < 5000 ? { pid: null, fresh: true } : null }
  }
  return { exists: true, holder: (await lockOwnerAlive(lock)) ? lock : null }
}

/** Trava do worker: quem a segura (o arquivo existe e o dono está vivo), ou null. */
export async function lockHolder(configDir) {
  return (await inspectLock(path.join(queueDir(configDir), LOCK_FILE))).holder
}

/** Cria a trava com open 'wx' (atômico): false se já existe. */
async function createLock(p, pid) {
  let fh
  try {
    fh = await fs.open(p, 'wx')
  } catch (e) {
    if (e?.code === 'EEXIST') return false
    throw e
  }
  try {
    await fh.writeFile(JSON.stringify({ pid, inicio: new Date().toISOString() }))
    await fh.sync()
  } finally {
    await fh.close()
  }
  return true
}

/**
 * Tira uma trava velha e pega a trava no lugar dela, segurando a trava de troca. Só quem segura a
 * troca apaga a trava do worker, e confere de novo antes de apagar: dois workers que acharam a
 * mesma trava velha nunca apagam a nova um do outro. Uma trava que existe não pode ser trocada por
 * outra (o 'wx' falha), então a que foi conferida é a que sai.
 */
async function takeOverStale(p, pid) {
  const t = `${p}${TAKEOVER_SUFFIX}`
  if (!(await createLock(t, pid))) {
    // Troca de um processo que morreu no meio dela (raro): sai sozinha depois de alguns segundos.
    try {
      if (Date.now() - (await fs.stat(t)).mtimeMs > TAKEOVER_STALE_MS) await fs.rm(t, { force: true })
    } catch {
      // já saiu
    }
    return false
  }
  try {
    const { exists, holder } = await inspectLock(p)
    if (holder) return false
    if (exists) await fs.rm(p, { force: true })
    return await createLock(p, pid)
  } finally {
    await fs.rm(t, { force: true })
  }
}

/**
 * Pega a trava. Uma trava de um processo que morreu (kill -9, queda, reboot) é trocada pela nova
 * sob a trava de troca. Devolve false se outro worker vivo tem a trava.
 */
export async function acquireLock(configDir, pid = process.pid) {
  const dir = queueDir(configDir)
  await fs.mkdir(dir, { recursive: true })
  const p = path.join(dir, LOCK_FILE)
  for (let attempt = 0; attempt < 4; attempt++) {
    if (await createLock(p, pid)) return true
    const { exists, holder } = await inspectLock(p)
    if (holder) return false
    if (!exists) continue
    if (await takeOverStale(p, pid)) return true
    // Outro está trocando a trava agora: espera um pouco e confere de novo.
    await new Promise((r) => setTimeout(r, 20 + Math.random() * 30))
  }
  return false
}

export async function releaseLock(configDir, pid = process.pid) {
  const p = path.join(queueDir(configDir), LOCK_FILE)
  const lock = await readJson(p)
  if (lock?.pid === pid) await fs.rm(p, { force: true })
}

/**
 * Garante um worker rodando para a fila. `spawnWorker` abre o processo destacado (o helper passa o
 * dele); quem decide de verdade é a trava, que o próprio worker pega ao subir.
 */
export async function ensureWorker(configDir, spawnWorker) {
  if (await lockHolder(configDir)) return { started: false }
  if ((await listJobs(configDir)).length === 0) return { started: false }
  await spawnWorker()
  return { started: true }
}

/**
 * Marca os trabalhos da fila como esperando o motor (`pendente` com `espera` no info.json):
 * falta o whisper, o ffmpeg ou o modelo, o que vale para todos os trabalhos de uma vez.
 */
export async function markWaiting(jobs, motivo) {
  for (const job of jobs) {
    try {
      const t = transcriptionsOf(await readJson(path.join(job.pasta, 'info.json')))[job.audio]
      if (t && t.status !== 'pendente' && t.status !== 'transcrevendo') continue
      if (t?.status === 'pendente' && t.espera === motivo) continue
      await updateInfoTranscription(job.pasta, job.audio, { status: 'pendente', espera: motivo, inicio: null, fim: null })
    } catch {
      // pasta sem permissão: o próximo worker tenta de novo
    }
  }
}

/**
 * Abre o worker se houver trabalho na fila, a transcrição estiver ligada e der para transcrever. O
 * helper chama depois de um finalize, ao abrir e quando a configuração muda. Sem o motor (whisper,
 * ffmpeg ou modelo faltando) os trabalhos não viram falha: ficam na fila esperando, com o motivo
 * no info.json, e entram quando o motor aparecer.
 */
export async function startQueue(configDir, cfgRaw, spawnWorker, engineCtx = {}) {
  const cfg = normalizeTranscriptionConfig(cfgRaw)
  if (!cfg.ativa) return { started: false, motivo: 'transcrição desligada' }
  const jobs = await listJobs(configDir)
  if (jobs.length === 0) return { started: false }
  if (await lockHolder(configDir)) return { started: false }
  let av
  try {
    av = await createEngine(cfg, { configDir, ...engineCtx }).available()
  } catch (e) {
    av = { ok: false, motivo: humanError(e) }
  }
  if (!av.ok) {
    const motivo = av.motivo ?? 'motor de transcrição indisponível'
    await markWaiting(jobs, motivo)
    return { started: false, motivo }
  }
  await spawnWorker()
  return { started: true }
}

// ---------------------------------------------------------------------------------------------
// Processar a fila (worker)
// ---------------------------------------------------------------------------------------------

/** Nome do comando de um pid (para não matar um processo qualquer que herdou o pid). */
async function commandOf(pid) {
  const r = await runProcess('ps', ['-p', String(pid), '-o', 'command='])
  return r.code === 0 ? r.out.trim() : ''
}

/**
 * Um worker anterior morreu no meio deste trabalho: mata o ffmpeg ou o whisper que ele deixou
 * rodando (e o grupo dele), para nunca haver dois whisper ao mesmo tempo. Só se o pid ainda for
 * daquele programa: depois de um reboot o pid pode ser de outro processo.
 */
async function killLeftoverChild(job, log) {
  const pid = job.filhoPid
  if (!Number.isInteger(pid) || !pidAlive(pid)) return
  const cmd = await commandOf(pid)
  if (!job.filhoCmd || !cmd.includes(job.filhoCmd)) return
  log(`matando o processo que sobrou do worker anterior: ${pid} (${job.filhoCmd})`)
  killTree(pid)
  for (let i = 0; i < 50 && pidAlive(pid); i++) await new Promise((r) => setTimeout(r, 100))
}

const humanError = (e) => String(e?.message ?? e).slice(0, 500)

/**
 * Processa um trabalho: transcrevendo -> pronta (md e srt escritos por inteiro antes) ou falhou
 * (com o motivo). Sem o motor (whisper, ffmpeg ou modelo faltando) devolve `aguardando` e o
 * trabalho fica na fila. O áudio nunca é apagado. Devolve { status, motivo? }.
 */
export async function processJob(configDir, job, { readConfig, engineCtx = {}, log = () => {}, minTimeoutMs = MIN_TIMEOUT_MS }) {
  const folder = job.pasta
  const audio = job.audio
  const infoPath = path.join(folder, 'info.json')
  const info = await readJson(infoPath)
  if (!info) {
    log(`pasta sem info.json (movida ou apagada?), trabalho descartado: ${folder}`)
    await fs.rm(job.file, { force: true })
    return { status: 'descartado' }
  }
  const cfg = normalizeTranscriptionConfig((await readConfig())?.transcricao)
  const tentativas = (Number(job.tentativas) || 0) + 1
  const started = Date.now()
  const startedIso = new Date(started).toISOString()
  const update = (patch) => updateInfoTranscription(folder, audio, patch)
  const fail = async (motivo) => {
    await update({
      status: 'falhou',
      motor: cfg.motor,
      idioma: cfg.idioma,
      fim: new Date().toISOString(),
      duracaoProcessamentoSeg: Math.round((Date.now() - started) / 100) / 10,
      arquivos: [],
      erro: motivo,
    })
    await fs.rm(job.file, { force: true })
    log(`falhou: ${folder} (${audio}): ${motivo}`)
    return { status: 'falhou', motivo }
  }
  if (tentativas > MAX_ATTEMPTS) return fail(`a transcrição foi interrompida ${MAX_ATTEMPTS} vezes no meio; o áudio continua na pasta`)
  const audioPath = path.join(folder, audio)
  if (!(await isFile(audioPath))) return fail(`áudio não encontrado: ${audio}`)
  let engine
  try {
    engine = createEngine(cfg, { configDir, ...engineCtx })
  } catch (e) {
    return fail(humanError(e))
  }
  const saveJob = (extra) => writeAtomic(job.file, JSON.stringify({ ...job, file: undefined, ...extra }, null, 2) + '\n')
  const av = await engine.available()
  if (!av.ok) {
    // Falta o whisper, o ffmpeg ou o modelo: não é falha desta call, espera na fila até o motor
    // aparecer (o helper abre o worker de novo quando a configuração muda ou ao abrir).
    const motivo = av.motivo ?? 'motor de transcrição indisponível'
    if (job.estado !== 'pendente') await saveJob({ estado: 'pendente', filhoPid: null, filhoCmd: null })
    await update({ status: 'pendente', espera: motivo, inicio: null, fim: null })
    log(`esperando o motor de transcrição: ${motivo}`)
    return { status: 'aguardando', motivo }
  }
  await saveJob({ estado: 'transcrevendo', tentativas, workerPid: process.pid, inicio: startedIso, filhoPid: null, filhoCmd: null })
  await update({ status: 'transcrevendo', motor: cfg.motor, idioma: cfg.idioma, inicio: startedIso, fim: null, arquivos: [] })

  const tmpDir = await fs.mkdtemp(path.join(await ensureTmpBase(configDir), 'job-'))
  let result
  try {
    // Uma call de 2 h leva alguns minutos; o limite só existe para um processo travado não segurar
    // a fila para sempre.
    const timeoutMs = Math.max(minTimeoutMs, (Number(info.duracaoSegundos) || 0) * 2000)
    result = await engine.transcribe({
      audioPath,
      tmpDir,
      timeoutMs,
      onSpawn: (pid, cmd) => saveJob({ estado: 'transcrevendo', tentativas, workerPid: process.pid, inicio: startedIso, filhoPid: pid, filhoCmd: cmd }),
    })
  } catch (e) {
    return fail(humanError(e))
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true })
  }

  const fresh = (await readJson(infoPath)) ?? info
  const stem = transcriptStem(audio)
  const arquivos = [`${stem}.md`, `${stem}.srt`]
  const pauses = result.pauses ?? []
  // Emenda 18: com a linha do tempo dos falantes deste áudio, cada segmento ganha o nome de quem falou.
  const speakers = await readSpeakerTimeline(folder, audio).catch(() => null)
  for (const d of speakers?.descartadas ?? []) {
    log(`fonte sem nome fora da linha do tempo (acompanhava quem fala): ${folder} (${d.segundos.toFixed(1)} s, ${d.coberturaPct.toFixed(1)}% junto de quem tem nome, presente em ${d.presencaPct.toFixed(1)}% da fala deles)`)
  }
  const kept = collapseRepeats(dropInventedSegments(result.segments, pauses), pauses)
  const segments = speakers ? fillSpeakerGaps(assignSpeakers(kept, speakers)) : kept
  const md = buildMarkdown({ info: fresh, segments, language: result.language, motor: cfg.motor, model: result.model, audio, pauses, speakers })
  await writeAtomic(path.join(folder, arquivos[0]), md)
  await writeAtomic(path.join(folder, arquivos[1]), buildSrt(segments))
  const fim = Date.now()
  await update({
    status: 'pronta',
    motor: cfg.motor,
    modelo: result.model,
    idioma: result.language,
    inicio: startedIso,
    fim: new Date(fim).toISOString(),
    duracaoProcessamentoSeg: Math.round((fim - started) / 100) / 10,
    arquivos,
  })
  await fs.rm(job.file, { force: true })
  const dropped = result.segments.length - segments.length
  log(`pronta: ${folder} (${audio}, ${segments.length} segmentos${dropped ? `, ${dropped} fora (inventados no silêncio ou repetidos)` : ''}, ${((fim - started) / 1000).toFixed(1)} s)`)
  return { status: 'pronta' }
}

async function ensureTmpBase(configDir) {
  const dir = path.join(queueDir(configDir), 'tmp')
  await fs.mkdir(dir, { recursive: true })
  return dir
}

/**
 * Erro inesperado num trabalho (disco cheio, pasta sem permissão). O trabalho só sai da fila
 * depois de o info.json dizer falhou; se nem isso deu para escrever, ele fica para o próximo
 * worker, até MAX_UNEXPECTED_ERRORS vezes (aí sai, e o transcription-status mostra falhou).
 */
async function handleUnexpected(job, e, log) {
  const motivo = humanError(e)
  log(`erro inesperado em ${job.pasta} (${job.audio}): ${motivo}`)
  const written = await updateInfoTranscription(job.pasta, job.audio, { status: 'falhou', erro: motivo, arquivos: [] }).then(
    (ok) => ok,
    () => false,
  )
  const erros = (Number(job.errosInesperados) || 0) + 1
  if (written || erros >= MAX_UNEXPECTED_ERRORS) {
    await fs.rm(job.file, { force: true })
    return
  }
  await writeAtomic(job.file, JSON.stringify({ ...job, file: undefined, estado: 'pendente', errosInesperados: erros }, null, 2) + '\n').catch(() => {})
}

/**
 * Laço do worker: pega a trava, retoma o que sobrou (mata o filho órfão de um worker que morreu),
 * processa um trabalho por vez e, com a fila vazia, solta a trava e confere de novo: um trabalho
 * que entrou nesse meio (o helper viu a trava viva e não abriu outro worker) é pego aqui. Para com
 * trabalhos na fila quando a transcrição é desligada ou falta o motor.
 *
 * Opções dos testes: `minTimeoutMs` (limite de cada processo) e `beforeRelease` (roda com a fila
 * vazia, logo antes de soltar a trava).
 */
export async function runWorker(configDir, { readConfig, engineCtx, log = () => {}, minTimeoutMs, beforeRelease } = {}) {
  let processed = 0
  // Erro inesperado nesta rodada: o trabalho fica para o próximo worker, sem laço sem fim.
  const skipped = new Set()
  for (;;) {
    if (!(await acquireLock(configDir))) {
      log('outro worker já está rodando; saindo')
      return processed
    }
    let stop = false
    try {
      // Sobra de um worker anterior (temporários e o filho que ficou rodando).
      await fs.rm(path.join(queueDir(configDir), 'tmp'), { recursive: true, force: true })
      for (;;) {
        const job = (await listJobs(configDir)).find((j) => !skipped.has(j.file))
        if (!job) break
        if (!normalizeTranscriptionConfig((await readConfig())?.transcricao).ativa) {
          log('transcrição desligada: os trabalhos ficam na fila até ligar de novo')
          stop = true
          break
        }
        if (job.estado === 'transcrevendo') await killLeftoverChild(job, log)
        let r
        try {
          r = await processJob(configDir, job, { readConfig, engineCtx, log, ...(minTimeoutMs === undefined ? {} : { minTimeoutMs }) })
        } catch (e) {
          await handleUnexpected(job, e, log)
          skipped.add(job.file)
          r = { status: 'erro' }
        }
        if (r.status === 'aguardando') {
          await markWaiting(await listJobs(configDir), r.motivo)
          stop = true
          break
        }
        processed++
      }
      if (!stop && beforeRelease) await beforeRelease()
    } finally {
      await releaseLock(configDir)
    }
    if (stop) return processed
    if ((await listJobs(configDir)).every((j) => skipped.has(j.file))) return processed
  }
}
