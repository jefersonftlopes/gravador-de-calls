#!/usr/bin/env node
// Helper local do Gravador de Calls (native messaging, Node sem dependências).
//
// O Chrome abre este processo pelo wrapper gerado por host/instalar.mjs e conversa por stdio:
// cada mensagem é 4 bytes de tamanho (ordem nativa, little-endian no Mac) seguidos de JSON.
// Respostas para o Chrome têm no máximo 1 MB. Nada além do protocolo pode ir para o stdout.
//
// Operações (docs/ARQUITETURA.md, "Helper", "Emenda 1" e "Emenda 13"):
//   ping, get-config, set-root, check-root, choose-folder, begin, append, finalize, discard,
//   list-staging, reveal, set-transcription, transcription-status, transcription-write, open-file,
//   choose-file
//
// Transcrição (Emenda 13, host/transcricao.mjs): com `transcricao.ativa` no config.json, cada
// finalize que termina põe cada áudio ainda não transcrito da pasta na fila (<pasta do
// config.json>/fila) e abre o worker destacado (host/transcrever.mjs) se nenhum estiver rodando e
// der para transcrever; sem o whisper, o ffmpeg ou o modelo, a call espera na fila com o motivo.
// Falhar ao enfileirar nunca falha o finalize.
//
// Vários perfis do Chrome = vários processos deste helper ao mesmo tempo, na mesma raiz:
// - a raiz mora em config.json (GRAVADOR_CONFIG ou ~/Library/Application Support/gravador-de-calls/);
// - cada sessão tem um índice <configDir>/sessoes/<sessionId>.json com a raiz e o dono do
//   begin, então mudar a raiz no meio da call não perde o staging;
// - finalize reserva a pasta final com mkdir NÃO recursivo (EEXIST: " (2)", " (3)"...), sem
//   "existe? então cria" em dois passos.
//
// - list-staging devolve, por sessão do dono pedido, os arquivos, `createdAt` (do owner.json) e
//   `updatedAt` (último mtime do staging), em ms: a recuperação só mexe num staging órfão parado.
//
// Escrita durante a call: <raiz>/.gravando/<sessionId>/<arquivo>.part, com um sidecar
// <arquivo>.part.json { nextSeq, bytes }, e owner.json com o dono (profileId). Cada append
// trunca o .part para `bytes` antes de escrever (idempotente se o processo cair entre os dois
// passos), faz fsync e só então responde.
import { spawn } from 'node:child_process'
import { constants as fsc, fstatSync, realpathSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ENGINES,
  ENGINE_LABELS,
  applyTranscriptionPatch,
  createEngine,
  enqueueTranscription,
  listJobs,
  lockHolder,
  normalizeTranscriptionConfig,
  readJson,
  reconcileTranscription,
  startQueue,
  updateInfoTranscription,
  writeAtomic,
} from './transcricao.mjs'

export const HOST_VERSION = '0.5.0'
const HOST_DIR = path.dirname(fileURLToPath(import.meta.url))
export const STAGING_DIR = '.gravando'
export const DEFAULT_ROOT = '~/Documents/Gravações de calls'
const OWNER_FILE = 'owner.json'
const OWNER_RE = /^[A-Za-z0-9_-]{1,100}$/
const MAX_OUT_BYTES = 1024 * 1024
const FILE_RE = /^[a-z0-9][a-z0-9._-]{0,80}$/i
const SESSION_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/
/** Emenda 18: arquivos de texto que o finalize aceita a mais (nada de nome livre vindo de fora). */
export const EXTRA_FILES = new Set(['falantes.json'])
export const MAX_EXTRA_BYTES = 8 * 1024 * 1024

/** Os `extras` do finalize que dá para escrever: só os nomes conhecidos e texto de tamanho razoável. */
export function acceptedExtras(extras) {
  if (!Array.isArray(extras)) return []
  return extras.filter((x) => x && typeof x === 'object' && EXTRA_FILES.has(x.nome) && typeof x.texto === 'string' && Buffer.byteLength(x.texto) <= MAX_EXTRA_BYTES)
}

// ---------------------------------------------------------------------------------------------
// Utilitários
// ---------------------------------------------------------------------------------------------

export function expandHome(p) {
  if (typeof p !== 'string' || !p.trim()) throw new Error('caminho vazio')
  const s = p.trim()
  if (s === '~') return os.homedir()
  if (s.startsWith('~/')) return path.join(os.homedir(), s.slice(2))
  if (!path.isAbsolute(s)) throw new Error(`caminho precisa ser absoluto ou começar com ~: ${s}`)
  return path.resolve(s)
}

function checkSessionId(id) {
  if (typeof id !== 'string' || !SESSION_RE.test(id)) throw new Error(`sessionId inválido: ${id}`)
  return id
}

function checkFile(name) {
  if (typeof name !== 'string' || !FILE_RE.test(name) || name.includes('..')) throw new Error(`nome de arquivo inválido: ${name}`)
  return name
}

/** relDir relativo, sem `..`, sem componentes vazios. */
function checkRelDir(rel) {
  if (typeof rel !== 'string' || !rel || rel.startsWith('/') || rel.includes('\\') || rel.includes('\0')) {
    throw new Error(`relDir inválido: ${rel}`)
  }
  const parts = rel.split('/')
  if (parts.some((p) => !p || p === '.' || p === '..')) throw new Error(`relDir inválido: ${rel}`)
  return parts
}

function checkOwner(owner) {
  if (typeof owner !== 'string' || !OWNER_RE.test(owner)) throw new Error(`owner inválido: ${owner}`)
  return owner
}

// ---------------------------------------------------------------------------------------------
// Configuração (raiz única para todos os perfis)
// ---------------------------------------------------------------------------------------------

export function configPath() {
  if (process.env.GRAVADOR_CONFIG) return expandHome(process.env.GRAVADOR_CONFIG)
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'gravador-de-calls', 'config.json')
  }
  return path.join(os.homedir(), '.config', 'gravador-de-calls', 'config.json')
}

/**
 * config.json inteiro: a raiz e a seção `transcricao` (Emenda 13), com os padrões. Os campos que
 * esta versão não conhece ficam como estão (uma versão nova não perde o que a outra gravou).
 */
export async function readConfig() {
  let cfg = {}
  try {
    const raw = JSON.parse(await fs.readFile(configPath(), 'utf8'))
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) cfg = raw
  } catch {
    // sem config.json: padrões
  }
  return {
    ...cfg,
    root: typeof cfg.root === 'string' && cfg.root.trim() ? cfg.root : DEFAULT_ROOT,
    transcricao: normalizeTranscriptionConfig(cfg.transcricao),
  }
}

async function writeConfig(cfg) {
  await fs.mkdir(path.dirname(configPath()), { recursive: true })
  await writeFileSync(configPath(), JSON.stringify(cfg, null, 2) + '\n')
}

async function currentRoot() {
  return expandHome((await readConfig()).root)
}

/** Índice da sessão: raiz e dono gravados no begin (sobrevive à troca de raiz). */
function indexPath(sessionId) {
  return path.join(path.dirname(configPath()), 'sessoes', `${checkSessionId(sessionId)}.json`)
}

async function readIndex(sessionId) {
  try {
    return JSON.parse(await fs.readFile(indexPath(sessionId), 'utf8'))
  } catch {
    return null
  }
}

async function sessionRoot(sessionId) {
  const idx = await readIndex(sessionId)
  if (typeof idx?.root === 'string') return idx.root
  return currentRoot()
}

/**
 * Sessão já finalizada (Emenda 10): o índice vira lápide com `done` e `finalPath`, e begin e
 * finalize repetidos (o SW morreu antes de marcar "salva") devolvem a mesma pasta em vez de
 * reservar " (2)". Lápides com mais de 30 dias saem no list-staging.
 */
const TOMBSTONE_MAX_MS = 30 * 24 * 3600_000

async function stagingFor(sessionId) {
  return path.join(await sessionRoot(sessionId), STAGING_DIR, checkSessionId(sessionId))
}

const PRIVACY_HINT = 'no macOS, confira Ajustes do Sistema > Privacidade e Segurança > Arquivos e Pastas (o pedido sai em nome do Google Chrome)'

/**
 * Erro do sistema de arquivos em português, com o código entre parênteses (Emenda 10). A tela das
 * configurações mostra esta mensagem como veio.
 */
export function friendlyFsError(e, abs) {
  const code = e?.code
  const reasons = {
    EACCES: `sem permissão para gravar aí; ${PRIVACY_HINT}`,
    EPERM: `sem permissão para gravar aí; ${PRIVACY_HINT}`,
    ENOTDIR: 'o caminho passa por um arquivo, não por uma pasta',
    EEXIST: 'o caminho passa por um arquivo, não por uma pasta',
    EROFS: 'o disco é só de leitura',
    ENOSPC: 'o disco está cheio',
    ENOENT: abs.startsWith('/Volumes/') ? 'o disco não está conectado' : 'a pasta não existe e não deu para criar',
  }
  const reason = reasons[code]
  if (!reason) return e
  const out = new Error(`${reason} (${code}): ${abs}`)
  out.code = code
  return out
}

/** Cria (se preciso) e confirma que dá para gravar na pasta. */
async function validateRoot(p) {
  const abs = expandHome(p)
  try {
    await fs.mkdir(abs, { recursive: true })
    const probe = path.join(abs, `.gravador-teste-${process.pid}-${Date.now()}`)
    await fs.writeFile(probe, 'ok')
    await fs.rm(probe, { force: true })
  } catch (e) {
    throw friendlyFsError(e, abs)
  }
  return abs
}

/** Dá para gravar? Sem criar nada: sobe até o primeiro ancestral que existe. */
async function canWrite(abs) {
  let p = abs
  for (;;) {
    try {
      await fs.access(p, fsc.W_OK)
      return true
    } catch (e) {
      if (e?.code !== 'ENOENT') return false
      const up = path.dirname(p)
      if (up === p) return false
      p = up
    }
  }
}

async function exists(p) {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

async function readMeta(metaPath) {
  try {
    const m = JSON.parse(await fs.readFile(metaPath, 'utf8'))
    return { nextSeq: Number(m.nextSeq) || 0, bytes: Number(m.bytes) || 0 }
  } catch {
    return { nextSeq: 0, bytes: 0 }
  }
}

async function writeFileSync(p, data) {
  const tmp = `${p}.tmp-${process.pid}`
  const fh = await fs.open(tmp, 'w')
  try {
    await fh.writeFile(data)
    await fh.sync()
  } finally {
    await fh.close()
  }
  await fs.rename(tmp, p)
}

async function fsyncDir(dir) {
  try {
    const fh = await fs.open(dir, fsc.O_RDONLY)
    try {
      await fh.sync()
    } finally {
      await fh.close()
    }
  } catch {
    // nem todo sistema deixa abrir diretório
  }
}

function run(cmd, args) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    child.on('error', (e) => resolve({ code: -1, out, err: String(e) }))
    child.on('close', (code) => resolve({ code, out, err }))
  })
}

// ---------------------------------------------------------------------------------------------
// Transcrição (Emenda 13)
// ---------------------------------------------------------------------------------------------

const configDir = () => path.dirname(configPath())

/**
 * Abre o worker destacado: grupo de processos próprio (detached) e unref, então ele continua
 * quando o Chrome fecha o helper. A saída vai para o mesmo log do helper quando o stderr dele é um
 * arquivo (o wrapper manda para ~/Library/Logs/gravador-de-calls/helper.log).
 */
function spawnWorker() {
  let errFd = 'ignore'
  try {
    if (fstatSync(2).isFile()) errFd = 2
  } catch {
    // stderr fechado
  }
  const child = spawn(process.execPath, [path.join(HOST_DIR, 'transcrever.mjs')], {
    detached: true,
    stdio: ['ignore', errFd, errFd],
    env: process.env,
    cwd: configDir(),
  })
  child.on('error', (e) => process.stderr.write(`gravador-host: não deu para abrir o worker de transcrição: ${e?.message ?? e}\n`))
  child.unref()
}

/**
 * Depois de um finalize: põe na fila cada áudio ainda não transcrito da pasta e garante o worker
 * (sem o motor, os trabalhos esperam na fila com o motivo). Nunca lança (o finalize já deu certo).
 */
async function queueTranscription(folder) {
  try {
    const { transcricao } = await readConfig()
    if (!transcricao.ativa) return
    await enqueueTranscription(configDir(), folder, transcricao)
    await startQueue(configDir(), transcricao, async () => spawnWorker())
  } catch (e) {
    process.stderr.write(`gravador-host: não deu para pôr na fila de transcrição (${folder}): ${e?.message ?? e}\n`)
  }
}

/** Raízes onde estão as gravações: a atual e as gravadas nos índices das sessões (raiz trocada). */
async function knownRoots() {
  const roots = new Set([await currentRoot()])
  const idxDir = path.join(configDir(), 'sessoes')
  try {
    for (const f of await fs.readdir(idxDir)) {
      const idx = await readJson(path.join(idxDir, f))
      if (typeof idx?.root === 'string') roots.add(idx.root)
    }
  } catch {
    // sem índices
  }
  const real = []
  for (const r of roots) {
    try {
      real.push(await fs.realpath(r))
    } catch {
      // raiz que não existe mais
    }
  }
  return real
}

/** Caminho real dentro de uma das raízes, ou erro (nada de ../ nem symlink para fora). */
async function insideRoots(p, roots) {
  const abs = expandHome(p)
  let real
  try {
    real = await fs.realpath(abs)
  } catch {
    throw new Error(`não existe: ${abs}`)
  }
  if (!roots.some((r) => real.startsWith(r + path.sep))) throw new Error(`fora da pasta das gravações: ${abs}`)
  return real
}

const TRANSCRIPT_FILE_RE = /^transcricao[\w.-]*\.(md|srt)$/

/** Comando que abre um arquivo com o aplicativo padrão (GRAVADOR_OPEN_CMD só nos testes). */
function openCommand() {
  if (process.env.GRAVADOR_OPEN_CMD) return process.env.GRAVADOR_OPEN_CMD
  if (process.platform === 'darwin') return 'open'
  if (process.platform === 'linux') return 'xdg-open'
  throw new Error('abrir arquivo só existe no macOS e no Linux')
}

// ---------------------------------------------------------------------------------------------
// Operações
// ---------------------------------------------------------------------------------------------

export const ops = {
  async ping() {
    const root = await currentRoot()
    return { version: HOST_VERSION, node: process.version, platform: process.platform, root, writable: await canWrite(root), configPath: configPath() }
  },

  async 'get-config'() {
    const cfg = await readConfig()
    return { root: expandHome(cfg.root), configPath: configPath(), transcricao: cfg.transcricao, motores: Object.keys(ENGINES).map((id) => ({ id, rotulo: ENGINE_LABELS[id] ?? id })) }
  },

  async 'set-root'({ path: p }) {
    const abs = await validateRoot(p)
    await writeConfig({ ...(await readConfig()), root: abs })
    return { root: abs }
  },

  /** Valida e grava a mudança na seção `transcricao` (vale para todos os perfis). */
  async 'set-transcription'({ patch }) {
    const cfg = await readConfig()
    const transcricao = await applyTranscriptionPatch(cfg.transcricao, patch)
    await writeConfig({ ...cfg, transcricao })
    // O que esperava o motor (caminho do whisper ou do modelo corrigido agora) entra já.
    await startQueue(configDir(), transcricao, async () => spawnWorker()).catch((e) =>
      process.stderr.write(`gravador-host: não deu para abrir o worker de transcrição: ${e?.message ?? e}\n`),
    )
    return { transcricao }
  },

  /**
   * Dá para transcrever? (o que foi achado e, se não der, o motivo), a fila e o estado da
   * transcrição de cada pasta pedida em `paths` (as últimas gravações do popup).
   */
  async 'transcription-status'({ paths } = {}) {
    const { transcricao } = await readConfig()
    let disponivel = false
    let motivo = null
    let detalhes = {}
    try {
      const av = await createEngine(transcricao, { configDir: configDir() }).available()
      disponivel = av.ok
      motivo = av.ok ? null : (av.motivo ?? 'indisponível')
      detalhes = av.detalhes ?? {}
    } catch (e) {
      motivo = String(e?.message ?? e)
    }
    const jobs = await listJobs(configDir())
    const fila = jobs.map((j) => ({ id: j.id, pasta: j.pasta, audio: j.audio, estado: j.estado, criadoEm: j.criadoEm }))
    const recentes = []
    const wanted = Array.isArray(paths) ? paths.filter((p) => typeof p === 'string' && p).slice(0, 50) : []
    // O popup pergunta a cada 2 s: as raízes (que leem os índices das sessões) uma vez por pedido.
    const roots = wanted.length ? await knownRoots() : []
    const queuedKeys = new Set()
    for (const j of wanted.length ? jobs : []) {
      try {
        queuedKeys.add(`${await fs.realpath(j.pasta)}\0${j.audio}`)
      } catch {
        // pasta do trabalho sumiu
      }
    }
    for (const p of wanted) {
      let real
      try {
        real = await insideRoots(p, roots)
      } catch {
        recentes.push({ path: p, transcricao: null })
        continue
      }
      const infoPath = path.join(real, 'info.json')
      const info = await readJson(infoPath)
      const t = info?.transcricao ?? null
      if (!t) {
        recentes.push({ path: p, transcricao: null })
        continue
      }
      // Pendente sem trabalho na fila (o trabalho se perdeu num erro de disco): mostra falhou.
      const queued = queuedKeys.has(`${real}\0${t.audio}`)
      let ageMs = 0
      try {
        ageMs = Date.now() - (await fs.stat(infoPath)).mtimeMs
      } catch {
        // sumiu agora
      }
      recentes.push({ path: p, transcricao: reconcileTranscription(t, { queued, ageMs }) })
    }
    return {
      ativa: transcricao.ativa,
      motor: transcricao.motor,
      idioma: transcricao.idioma,
      disponivel,
      motivo,
      detalhes,
      modeloEncontrado: detalhes.modelo ?? null,
      trabalhando: Boolean(await lockHolder(configDir())),
      fila,
      recentes,
    }
  },

  /** Abre uma transcrição com o aplicativo padrão. Só transcricao*.md|srt dentro da raiz. */
  async 'open-file'({ path: p }) {
    if (typeof p !== 'string' || !p) throw new Error('caminho vazio')
    const real = await insideRoots(p, await knownRoots())
    if (!TRANSCRIPT_FILE_RE.test(path.basename(real))) throw new Error(`só abre a transcrição (transcricao.md ou .srt): ${path.basename(real)}`)
    if (!(await fs.stat(real)).isFile()) throw new Error(`não é um arquivo: ${real}`)
    const r = await run(openCommand(), [real])
    if (r.code !== 0) throw new Error(r.err.trim() || 'falha ao abrir o arquivo')
    return { path: real }
  },

  /** Seletor de arquivo do macOS (modelo do whisper nas configurações). */
  async 'choose-file'({ prompt }) {
    if (process.platform !== 'darwin') throw new Error('seletor de arquivo só existe no macOS')
    const safePrompt = String(prompt ?? 'Escolha o arquivo').replace(/["\\]/g, ' ').slice(0, 200)
    const r = await run('osascript', ['-e', `POSIX path of (choose file with prompt "${safePrompt}")`])
    if (r.code !== 0) throw new Error(/-128/.test(r.err) ? 'cancelado' : r.err.trim() || 'falha no seletor')
    return { path: r.out.trim() }
  },

  async 'check-root'({ path: p }) {
    return { root: await validateRoot(p), writable: true }
  },

  async 'choose-folder'({ prompt }) {
    if (process.platform !== 'darwin') throw new Error('seletor de pasta só existe no macOS')
    const safePrompt = String(prompt ?? 'Escolha a pasta das gravações').replace(/["\\]/g, ' ').slice(0, 200)
    const r = await run('osascript', ['-e', `POSIX path of (choose folder with prompt "${safePrompt}")`])
    if (r.code !== 0) throw new Error(/-128/.test(r.err) ? 'cancelado' : r.err.trim() || 'falha no seletor')
    return { path: r.out.trim().replace(/\/$/, '') }
  },

  async begin({ sessionId, owner }) {
    checkSessionId(sessionId)
    checkOwner(owner)
    const idx = indexPath(sessionId)
    const prev = await readIndex(sessionId)
    // Já finalizada: não abre staging novo; quem chama usa a pasta que já existe.
    if (prev?.done && typeof prev.finalPath === 'string') return { done: true, path: prev.finalPath, root: prev.root }
    let root
    if (typeof prev?.root === 'string') {
      // begin repetido (SW reiniciou): mantém a raiz do primeiro.
      root = prev.root
    } else {
      root = await currentRoot()
      await fs.mkdir(path.dirname(idx), { recursive: true })
      await writeFileSync(idx, JSON.stringify({ sessionId, owner, root, createdAt: new Date().toISOString() }))
    }
    const dir = path.join(root, STAGING_DIR, sessionId)
    await fs.mkdir(dir, { recursive: true })
    const ownerFile = path.join(dir, OWNER_FILE)
    if (!(await exists(ownerFile))) {
      await writeFileSync(ownerFile, JSON.stringify({ owner, sessionId, createdAt: new Date().toISOString(), pid: process.pid }))
    }
    return { staging: dir, root }
  },

  async append({ sessionId, file, seq, data }) {
    const dir = await stagingFor(sessionId)
    const name = checkFile(file)
    if (!Number.isInteger(seq) || seq < 0) throw new Error(`seq inválido: ${seq}`)
    if (typeof data !== 'string') throw new Error('data ausente')
    if (!(await exists(dir))) throw new Error('sessão sem begin')
    const part = path.join(dir, `${name}.part`)
    const metaPath = `${part}.json`
    const meta = await readMeta(metaPath)
    if (seq !== meta.nextSeq) {
      const err = new Error(`seq fora de ordem: recebido ${seq}, esperado ${meta.nextSeq}`)
      err.expected = meta.nextSeq
      throw err
    }
    const buf = Buffer.from(data, 'base64')
    const fh = await fs.open(part, fsc.O_WRONLY | fsc.O_CREAT)
    try {
      await fh.truncate(meta.bytes)
      await fh.write(buf, 0, buf.length, meta.bytes)
      await fh.sync()
    } finally {
      await fh.close()
    }
    const next = { nextSeq: seq + 1, bytes: meta.bytes + buf.length }
    await writeFileSync(metaPath, JSON.stringify(next))
    return next
  },

  /**
   * Emenda 21: escreve na pasta da call os arquivos de uma transcrição que a EXTENSÃO fez (motor
   * por API) e grava o estado em `info.json.transcricao`, pelo mesmo updateInfoTranscription que o
   * worker do motor local usa. As mesmas guardas do `open-file`: a pasta tem de estar dentro de uma
   * raiz conhecida (caminho real, sem `..` nem symlink para fora) e cada nome tem de ser
   * `transcricao*.md` ou `.srt`. Nada de nome livre vindo de fora.
   */
  async 'transcription-write'({ path: p, audio, arquivos, transcricao }) {
    if (typeof p !== 'string' || !p) throw new Error('caminho vazio')
    const real = await insideRoots(p, await knownRoots())
    if (!(await fs.stat(real)).isDirectory()) throw new Error(`não é uma pasta: ${real}`)
    const audioName = checkFile(audio)
    const files = Array.isArray(arquivos) ? arquivos : []
    for (const f of files) {
      if (!f || typeof f !== 'object' || typeof f.texto !== 'string') throw new Error('arquivo da transcrição inválido')
      if (typeof f.nome !== 'string' || !TRANSCRIPT_FILE_RE.test(f.nome)) throw new Error(`só escreve a transcrição (transcricao*.md ou .srt): ${f?.nome}`)
      if (Buffer.byteLength(f.texto) > MAX_EXTRA_BYTES) throw new Error(`transcrição grande demais: ${f.nome}`)
    }
    const escritos = []
    for (const f of files) {
      await writeAtomic(path.join(real, f.nome), f.texto)
      escritos.push(f.nome)
    }
    let registrado = false
    if (transcricao && typeof transcricao === 'object' && !Array.isArray(transcricao)) {
      registrado = await updateInfoTranscription(real, audioName, transcricao, { primary: true })
    }
    return { path: real, arquivos: escritos, registrado }
  },

  async finalize({ sessionId, relDir, info, merge, extras, semTranscricao }) {
    const idx = await readIndex(checkSessionId(sessionId))
    if (idx?.done && typeof idx.finalPath === 'string') return { path: idx.finalPath }
    const root = await sessionRoot(sessionId)
    const dir = path.join(root, STAGING_DIR, checkSessionId(sessionId))
    const parts = checkRelDir(relDir)
    if (!(await exists(dir))) throw new Error('sessão sem begin')
    const parent = path.join(root, ...parts.slice(0, -1))
    await fs.mkdir(parent, { recursive: true })
    // Reserva sem corrida: mkdir não recursivo do último nível; EEXIST passa para o próximo nome.
    const base = parts[parts.length - 1]
    let target = null
    let merged = false
    // Um finalize anterior reservou a pasta e foi interrompido antes do info.json: continua nela.
    if (typeof idx?.target === 'string' && (await exists(idx.target)) && !(await exists(path.join(idx.target, 'info.json')))) {
      target = idx.target
      merged = true
    }
    for (let n = 1; n < 1000 && !target; n++) {
      const candidate = path.join(parent, n === 1 ? base : `${base} (${n})`)
      try {
        await fs.mkdir(candidate)
        target = candidate
      } catch (e) {
        if (e?.code !== 'EEXIST') throw e
        if (merge && n === 1) {
          target = candidate
          merged = true
        }
      }
    }
    if (!target) throw new Error('não achei um nome livre para a pasta')
    if (idx) await writeFileSync(indexPath(sessionId), JSON.stringify({ ...idx, target }))
    for (const entry of await fs.readdir(dir)) {
      if (entry === OWNER_FILE || entry.endsWith('.part.json') || entry.includes('.tmp-')) continue
      const finalName = entry.endsWith('.part') ? entry.slice(0, -5) : entry
      const ext = path.extname(finalName)
      const stem = finalName.slice(0, finalName.length - ext.length)
      let dest = path.join(target, finalName)
      // Só acontece no merge (pasta nova está vazia): nunca sobrescreve um arquivo existente.
      for (let n = 2; merged && (await exists(dest)); n++) dest = path.join(target, `${stem} (${n})${ext}`)
      await fs.rename(path.join(dir, entry), dest)
    }
    await fs.rm(dir, { recursive: true, force: true })
    // Emenda 18: o falantes.json (a linha do tempo dos falantes) entra antes do info.json, então a
    // transcrição, que só começa com a pasta completa, já o encontra.
    for (const x of acceptedExtras(extras)) await writeFileSync(path.join(target, x.nome), x.texto)
    // info.json por último: é o marcador de "pasta completa".
    if (info && typeof info === 'object') {
      // Emenda 13: o modo aba que entra na pasta da página não apaga o estado da transcrição dela
      // (o áudio do modo aba entra na fila logo abaixo, com a transcrição própria).
      const previous = merged ? await readJson(path.join(target, 'info.json')) : null
      const out = { ...info }
      for (const k of ['transcricao', 'transcricoes']) if (previous?.[k] && !info[k]) out[k] = previous[k]
      await writeFileSync(path.join(target, 'info.json'), JSON.stringify(out, null, 2) + '\n')
    }
    await fsyncDir(target)
    await fsyncDir(parent)
    // Lápide no lugar do índice: um finalize repetido devolve esta mesma pasta.
    if (idx) await writeFileSync(indexPath(sessionId), JSON.stringify({ ...idx, target, done: true, finalPath: target, finishedAt: new Date().toISOString() }))
    else await fs.rm(indexPath(sessionId), { force: true })
    // Emenda 13: só a pasta completa (com info.json) vai para a transcrição.
    // Emenda 21: com `semTranscricao`, o motor por API da extensão transcreve esta call, e a fila
    // do motor local nem é tocada (senão os dois escreveriam o mesmo transcricao.md).
    if (info && typeof info === 'object' && semTranscricao !== true) await queueTranscription(target)
    return { path: target }
  },

  async discard({ sessionId }) {
    // Já finalizada: a pasta final e a lápide ficam (um discard de "recomeçar do zero" não pode
    // abrir caminho para uma segunda cópia).
    const idx = await readIndex(checkSessionId(sessionId))
    if (idx?.done && typeof idx.finalPath === 'string') return { done: true, path: idx.finalPath }
    await fs.rm(await stagingFor(sessionId), { recursive: true, force: true })
    await fs.rm(indexPath(sessionId), { force: true })
    return {}
  },

  async 'list-staging'({ owner }) {
    checkOwner(owner)
    // Raízes onde procurar: a atual e as dos índices deste dono (sessão começada antes de trocar a raiz).
    const roots = new Set([await currentRoot()])
    const idxDir = path.join(path.dirname(configPath()), 'sessoes')
    if (await exists(idxDir)) {
      for (const f of await fs.readdir(idxDir)) {
        try {
          const idx = JSON.parse(await fs.readFile(path.join(idxDir, f), 'utf8'))
          if (idx.done) {
            if (Date.now() - (Date.parse(idx.finishedAt) || 0) > TOMBSTONE_MAX_MS) await fs.rm(path.join(idxDir, f), { force: true })
            continue
          }
          if (idx.owner === owner && typeof idx.root === 'string') roots.add(idx.root)
        } catch {
          // índice ilegível: ignora
        }
      }
    }
    const sessions = []
    for (const root of roots) {
      const base = path.join(root, STAGING_DIR)
      if (!(await exists(base))) continue
      for (const sessionId of await fs.readdir(base)) {
        if (!SESSION_RE.test(sessionId)) continue
        const dir = path.join(base, sessionId)
        let ownerInfo = null
        try {
          ownerInfo = JSON.parse(await fs.readFile(path.join(dir, OWNER_FILE), 'utf8'))
        } catch {
          continue
        }
        // Só as do dono pedido: a recuperação de um perfil nunca vê o staging vivo de outro.
        if (ownerInfo?.owner !== owner) continue
        const files = []
        let updatedAt = 0
        for (const entry of await fs.readdir(dir)) {
          try {
            updatedAt = Math.max(updatedAt, (await fs.stat(path.join(dir, entry))).mtimeMs)
          } catch {
            // sumiu entre o readdir e o stat
          }
          if (!entry.endsWith('.part')) continue
          const meta = await readMeta(path.join(dir, `${entry}.json`))
          files.push({ file: entry.slice(0, -5), bytes: meta.bytes, nextSeq: meta.nextSeq })
        }
        const createdAt = Date.parse(ownerInfo.createdAt) || 0
        // O dono devolvido é o do owner.json (quem chama confere de novo).
        sessions.push({ sessionId, owner: ownerInfo.owner, files, createdAt, updatedAt: Math.round(updatedAt) || createdAt })
      }
    }
    return { sessions }
  },

  async reveal({ path: p }) {
    const abs = expandHome(p)
    if (!(await exists(abs))) throw new Error(`não existe: ${abs}`)
    if (process.platform !== 'darwin') throw new Error('reveal só existe no macOS')
    const r = await run('open', ['-R', abs])
    if (r.code !== 0) throw new Error(r.err.trim() || 'falha ao abrir o Finder')
    return {}
  },
}

export async function handle(req) {
  const id = req && typeof req.id === 'number' ? req.id : -1
  const fn = req && typeof req.op === 'string' && Object.hasOwn(ops, req.op) ? ops[req.op] : null
  if (!fn) return { id, ok: false, error: `operação desconhecida: ${req?.op}` }
  try {
    return { id, ok: true, ...(await fn(req)) }
  } catch (e) {
    const res = { id, ok: false, error: String(e?.message ?? e) }
    if (typeof e?.expected === 'number') res.expected = e.expected
    return res
  }
}

// ---------------------------------------------------------------------------------------------
// Framing stdio
// ---------------------------------------------------------------------------------------------

export function encodeFrame(obj) {
  let json = Buffer.from(JSON.stringify(obj), 'utf8')
  if (json.length > MAX_OUT_BYTES) {
    json = Buffer.from(JSON.stringify({ id: obj?.id ?? -1, ok: false, error: 'resposta maior que 1 MB' }), 'utf8')
  }
  const head = Buffer.alloc(4)
  head.writeUInt32LE(json.length, 0)
  return Buffer.concat([head, json])
}

/**
 * Lê frames de um stream; chama onMessage em ordem (cada um espera o anterior terminar). Os que
 * `concurrent(msg)` aceita rodam por fora da fila (Emenda 10): o seletor de pasta do macOS espera
 * o usuário por minutos, e os appends e o ping da gravação em andamento não podem esperar junto.
 */
export function readFrames(stream, onMessage, onEnd, concurrent = () => false) {
  let buf = Buffer.alloc(0)
  let chain = Promise.resolve()
  stream.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk])
    while (buf.length >= 4) {
      const len = buf.readUInt32LE(0)
      if (buf.length < 4 + len) break
      const body = buf.subarray(4, 4 + len)
      buf = buf.subarray(4 + len)
      let msg
      try {
        msg = JSON.parse(body.toString('utf8'))
      } catch {
        msg = { id: -1, op: '__invalido__' }
      }
      if (concurrent(msg)) void Promise.resolve(onMessage(msg)).catch(() => {})
      else chain = chain.then(() => onMessage(msg))
    }
  })
  stream.on('end', () => {
    chain.then(() => onEnd?.())
  })
}

/** Operações que esperam o usuário (seletor do macOS, Finder): fora da fila das gravações. */
const CONCURRENT_OPS = new Set(['choose-folder', 'choose-file', 'reveal', 'open-file'])

/**
 * Trabalhos que ficaram na fila (o Mac desligou no meio, o worker morreu): o helper, ao abrir,
 * garante um worker para eles, sem esperar a próxima call terminar.
 */
export async function resumeTranscriptionQueue() {
  try {
    const { transcricao } = await readConfig()
    return await startQueue(configDir(), transcricao, async () => spawnWorker())
  } catch (e) {
    process.stderr.write(`gravador-host: não deu para retomar a fila de transcrição: ${e?.message ?? e}\n`)
    return { started: false }
  }
}

function main() {
  void resumeTranscriptionQueue()
  readFrames(
    process.stdin,
    async (msg) => {
      const res = await handle(msg)
      process.stdout.write(encodeFrame(res))
    },
    () => process.exit(0),
    (msg) => CONCURRENT_OPS.has(msg?.op),
  )
}

// Pelo caminho real: o wrapper pode chamar o helper por um caminho com symlink (/var -> /private/var).
function realOrSame(p) {
  try {
    return realpathSync(p)
  } catch {
    return path.resolve(p)
  }
}
const invokedDirectly = process.argv[1] && realOrSame(process.argv[1]) === realOrSame(fileURLToPath(import.meta.url))
if (invokedDirectly) main()
