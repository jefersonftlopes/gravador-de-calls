// Motor de transcrição por API dentro da extensão (Emenda 21): a fila, a retenção do áudio e o
// envio. É isto que faz a transcrição funcionar para quem instala pela Chrome Web Store, sem
// helper, sem whisper.cpp, sem ffmpeg, sem modelo de 1,5 GB e sem terminal.
//
// O motor local do helper continua existindo, continua sendo o padrão e nada do comportamento dele
// muda: quem liga este motor neste perfil é que passa a transcrever por aqui.
//
// O ponto delicado: os pedaços do áudio saem do IndexedDB assim que a gravação é salva
// (deleteChunks em ./sessions.ts) e a extensão NÃO consegue ler de volta o arquivo que o helper
// gravou no disco. Então, com o motor ligado, o finalize guarda o áudio num Blob na loja `apiAudio`
// ANTES de apagar os pedaços, e ele fica guardado até a transcrição terminar, com três limites
// explícitos (API_RETENTION): tentativas, idade e tamanho total guardado. Estourando qualquer um, o
// áudio é apagado e a gravação fica com um erro legível. Nada fica guardado para sempre.
//
// Durabilidade: a fila vive no IndexedDB e as tentativas são repetidas por chrome.alarms, no mesmo
// padrão do RECOVER_ALARM de ./sessions.ts. Um service worker que morre no meio não perde nada: o
// alarme acorda o SW e a passada decide de novo.
import {
  API_ENGINE_ID,
  API_RETENTION,
  API_UPLOAD_FILENAME,
  applyRetention,
  authHeaders,
  backoffFor,
  classifyApiError,
  endpointOf,
  isAllowedEndpoint,
  languageFromApiJson,
  maxBytesOf,
  modelOf,
  multipartFields,
  originPatternOf,
  providerOf,
  retriesAlone,
  segmentsFromApiJson,
  type ApiDropReason,
  type ApiErrorKind,
  type ApiTranscriptionConfig,
} from '../shared/api-transcription'
import { loadApiKey } from '../shared/api-key'
import { API_TRANSCRIPTION_STATE_KEY, RECORDING_MIME } from '../shared/constants'
import { languageReady, t } from '../shared/i18n'
import type { InfoJson, InfoTranscription, RecentRecording, RecentTranscription, SinkKind, SpeakersFile, TranscriptionStatus } from '../shared/protocol'
import { loadSettings } from '../shared/settings'
import {
  assignSpeakers,
  buildMarkdown,
  buildSrt,
  collapseRepeats,
  fillSpeakerGaps,
  speakerTimelineFrom,
  transcriptStem,
} from '../../host/texto.mjs'
import { deleteApiAudio, getChunks, listApiAudio, putApiAudio, type ApiAudioRecord, type SessionRecord } from './idb'
import { hostStatus } from './sink-host'
import { registerTestHooks } from './testing'
import { writeTranscript } from './transcript-sink'

const log = (...a: unknown[]) => console.debug('[gravador transcricao-api]', ...a)

/** Alarme das tentativas: existe enquanto houver áudio guardado esperando (como o RECOVER_ALARM). */
export const API_ALARM = 'gravador:transcricao-api'
/** Período do alarme enquanto houver fila (o mínimo do Chrome 120+ é 30 s). */
const API_PERIOD_MIN = 1

/**
 * O helper precisa desta versão para o motor por API: é a que conhece o `semTranscricao` do
 * finalize (não transcrever esta call no motor local) e a operação `transcription-write` (escrever
 * o transcricao.md na pasta da call). Com um helper anterior, os dois motores transcreveriam a
 * mesma pasta e um sobrescreveria o outro, então a gravação fica com o motivo e nada é enviado.
 */
export const HOST_MIN_FOR_API = '0.5.0'

/** `a >= b` em versões de números separados por ponto. */
export function atLeastVersion(a: string | null | undefined, b: string): boolean {
  if (!a) return false
  const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0)
  const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (x !== y) return x > y
  }
  return true
}

// ---------------------------------------------------------------------------------------------
// Estado por gravação (o que o popup mostra)
// ---------------------------------------------------------------------------------------------

/**
 * O estado da transcrição por API de cada gravação recente, no formato que o popup já conhece
 * (`RecentTranscription`): assim ele mostra "Transcrição pronta" e "Abrir transcrição" sem saber
 * quem transcreveu. Fica no chrome.storage.local, porque o áudio (e o registro dele) sai da fila
 * quando a transcrição termina, e a linha tem de continuar aparecendo.
 */
export type ApiTranscriptionStates = Record<string, RecentTranscription>

/** Quantas gravações guardam estado (o popup mostra 5; as últimas gravações guardam 20). */
const STATE_MAX = 20

export async function loadApiStates(): Promise<ApiTranscriptionStates> {
  try {
    const got = await chrome.storage.local.get(API_TRANSCRIPTION_STATE_KEY)
    const v = got[API_TRANSCRIPTION_STATE_KEY]
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as ApiTranscriptionStates) : {}
  } catch {
    return {}
  }
}

/** Troca o estado de uma gravação, mantendo no máximo STATE_MAX (as mais novas primeiro). */
async function setState(sessionId: string, state: RecentTranscription): Promise<void> {
  try {
    const all = await loadApiStates()
    const next: ApiTranscriptionStates = { [sessionId]: state }
    for (const [id, s] of Object.entries(all)) {
      if (id !== sessionId && Object.keys(next).length < STATE_MAX) next[id] = s
    }
    await chrome.storage.local.set({ [API_TRANSCRIPTION_STATE_KEY]: next })
  } catch (e) {
    log('não deu para guardar o estado', e)
  }
}

const pending = (espera?: string): RecentTranscription => ({ status: 'pendente', ...(espera ? { espera } : {}) })
const failed = (erro: string): RecentTranscription => ({ status: 'falhou', erro })

// ---------------------------------------------------------------------------------------------
// Mensagens de cada erro, no idioma da interface (Emenda 19)
// ---------------------------------------------------------------------------------------------

const mb = (bytes: number) => `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`

/** O motivo de uma falha de envio, no idioma da interface. Nunca leva a chave. */
export function apiErrorReason(kind: ApiErrorKind, status: number | null): string {
  switch (kind) {
    case 'config':
      return t('apiErrKey')
    case 'limite':
      return t('apiErrRate')
    case 'servidor':
      return t('apiErrServer', String(status ?? ''))
    case 'rede':
      return t('apiErrNetwork')
    case 'grande':
      return t('apiErrTooLarge', '', '')
    case 'pedido':
      return t('apiErrRequest', String(status ?? ''))
  }
}

/** O motivo de o áudio guardado ter sido apagado por um dos limites da retenção. */
export function dropReason(reason: ApiDropReason, job: { attempts: number; bytes: number }): string {
  switch (reason) {
    case 'tentativas':
      return t('apiErrAttempts', String(job.attempts))
    case 'idade':
      return t('apiErrAge', String(Math.round(API_RETENTION.maxAgeMs / 3_600_000)))
    case 'espaco':
      return t('apiErrSpace', mb(API_RETENTION.maxTotalBytes))
    case 'grande':
      return t('apiErrTooLarge', mb(job.bytes), mb(0))
  }
}

// ---------------------------------------------------------------------------------------------
// Entrada na fila (chamada pelo finalize)
// ---------------------------------------------------------------------------------------------

/** Este perfil transcreve por API? (lido do storage, por perfil). */
export async function apiEngineOn(): Promise<boolean> {
  return (await loadSettings()).apiTranscription.ativa
}

/**
 * O helper serve para este motor? Com o helper instalado numa versão anterior, não: ele
 * transcreveria a mesma pasta no motor local. Sem helper (o caso da loja), serve sempre.
 */
export function helperFitsApiEngine(): { ok: boolean; motivo?: string } {
  const helper = hostStatus()
  if (!helper.ok) return { ok: true }
  return atLeastVersion(helper.version, HOST_MIN_FOR_API) ? { ok: true } : { ok: false, motivo: t('apiErrHelperOld', HOST_MIN_FOR_API) }
}

export interface QueueArgs {
  rec: Pick<SessionRecord, 'sessionId' | 'file'>
  info: InfoJson
  speakers: SpeakersFile | null
  savedPath: string
  sink: SinkKind
}

/**
 * Guarda o áudio desta gravação para transcrever por API e põe na fila. Chamada pelo finalize
 * depois de a pasta estar salva e ANTES do deleteChunks. Nunca lança: a gravação já está salva, e
 * uma falha aqui só pode virar um motivo no popup.
 */
export async function queueApiTranscription(args: QueueArgs): Promise<{ queued: boolean; motivo?: string }> {
  try {
    await languageReady()
    const cfg = (await loadSettings()).apiTranscription
    // Desligado: nada é guardado e NADA é enviado.
    if (!cfg.ativa) return { queued: false }
    const fits = helperFitsApiEngine()
    if (!fits.ok) {
      await setState(args.rec.sessionId, failed(fits.motivo!))
      return { queued: false, motivo: fits.motivo }
    }
    const endpoint = endpointOf(cfg)
    if (!isAllowedEndpoint(endpoint)) {
      const motivo = t('apiErrEndpoint', endpoint)
      await setState(args.rec.sessionId, failed(motivo))
      return { queued: false, motivo }
    }
    const chunks = await getChunks(args.rec.sessionId)
    if (chunks.length === 0) return { queued: false }
    const blob = new Blob(
      chunks.map((c) => c.data),
      { type: RECORDING_MIME },
    )
    const limit = maxBytesOf(cfg)
    if (blob.size > limit) {
      // Acima do limite por requisição o áudio NÃO é enviado nem cortado nesta versão: cortar webm
      // sem ffmpeg está fora de escopo. A gravação fica com o motivo e o motor local transcreve.
      const motivo = t('apiErrTooLarge', mb(blob.size), mb(limit))
      await setState(args.rec.sessionId, failed(motivo))
      log('áudio acima do limite da API, não enviado', args.savedPath, blob.size, limit)
      return { queued: false, motivo }
    }
    const now = Date.now()
    await putApiAudio({
      sessionId: args.rec.sessionId,
      blob,
      bytes: blob.size,
      audio: args.rec.file,
      savedPath: args.savedPath,
      sink: args.sink,
      info: args.info,
      speakers: args.speakers,
      createdAt: now,
      attempts: 0,
      nextAt: now,
      lastError: null,
    })
    await setState(args.rec.sessionId, pending())
    ensureApiAlarm()
    void runApiQueue()
    return { queued: true }
  } catch (e) {
    log('não deu para pôr na fila', e)
    return { queued: false, motivo: String((e as Error)?.message ?? e) }
  }
}

// ---------------------------------------------------------------------------------------------
// Alarme
// ---------------------------------------------------------------------------------------------

export function registerApiTranscriptionAlarms(): void {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === API_ALARM) void runApiQueue()
  })
  chrome.runtime.onStartup?.addListener(() => void runApiQueue())
  registerTestHooks({ runApiQueue, apiQueueSize, setApiFetch, apiQueueDueNow })
}

function ensureApiAlarm(): void {
  try {
    Promise.resolve(chrome.alarms.create(API_ALARM, { periodInMinutes: API_PERIOD_MIN })).catch(() => {})
  } catch (e) {
    log('alarme', e)
  }
}

async function clearApiAlarmIfIdle(): Promise<void> {
  try {
    if ((await listApiAudio()).length > 0) return ensureApiAlarm()
    await chrome.alarms.clear(API_ALARM)
  } catch (e) {
    log('alarme', e)
  }
}

/** Quantas gravações estão com o áudio guardado esperando (gancho de teste). */
export async function apiQueueSize(): Promise<number> {
  return (await listApiAudio()).length
}

/**
 * Gancho de teste: adianta a hora de cada trabalho da fila, em vez de o teste esperar a espera
 * crescente (15 s, 1 min...). É o que o chrome.alarms faria na próxima volta.
 */
async function apiQueueDueNow(): Promise<number> {
  const jobs = await listApiAudio()
  for (const job of jobs) await putApiAudio({ ...job, nextAt: 0 })
  return jobs.length
}

// ---------------------------------------------------------------------------------------------
// Envio
// ---------------------------------------------------------------------------------------------

/** O fetch usado no envio. Só os testes trocam (gancho `setApiFetch`); o produto usa o global. */
let doFetch: typeof fetch = (...a: Parameters<typeof fetch>) => fetch(...a)

function setApiFetch(fake: ((url: string, init: RequestInit) => Promise<Response>) | null): void {
  doFetch = (fake ?? ((...a: Parameters<typeof fetch>) => fetch(...a))) as typeof fetch
}

/** A permissão de host da origem do endereço já foi concedida? */
export async function hasApiPermission(cfg: ApiTranscriptionConfig): Promise<boolean> {
  const origin = originPatternOf(endpointOf(cfg))
  if (!origin) return false
  try {
    return await chrome.permissions.contains({ origins: [origin] })
  } catch {
    return false
  }
}

interface SendResult {
  ok: boolean
  json?: unknown
  status: number | null
}

/**
 * Manda o áudio ao provedor. A chave aparece EXCLUSIVAMENTE no cabeçalho Authorization: nunca na
 * URL (um proxy registraria), nunca no corpo, nunca no retorno. O corpo de uma resposta de erro é
 * descartado sem ser lido para texto: ele pode ecoar o que foi enviado.
 */
async function send(cfg: ApiTranscriptionConfig, blob: Blob, key: string): Promise<SendResult> {
  const body = new FormData()
  for (const [name, value] of multipartFields(cfg)) body.append(name, value)
  body.append('file', blob, API_UPLOAD_FILENAME)
  let res: Response
  try {
    res = await doFetch(endpointOf(cfg), { method: 'POST', headers: authHeaders(key), body })
  } catch {
    // Sem resposta: rede, DNS, VPN. O motivo do navegador não entra na tela (ele pode levar a URL).
    return { ok: false, status: null }
  }
  if (!res.ok) return { ok: false, status: res.status }
  try {
    return { ok: true, json: await res.json(), status: res.status }
  } catch {
    return { ok: false, status: res.status }
  }
}

let running: Promise<void> | null = null

/**
 * Uma passada da fila: aplica a retenção, manda o que está na hora (um por vez) e deixa o alarme
 * de acordo com o que sobrou. Nunca roda duas vezes ao mesmo tempo no mesmo service worker.
 */
export function runApiQueue(): Promise<void> {
  running ??= pass().finally(() => {
    running = null
  })
  return running
}

async function pass(): Promise<void> {
  await languageReady()
  const now = Date.now()
  let jobs: ApiAudioRecord[]
  try {
    jobs = await listApiAudio()
  } catch (e) {
    log('não deu para ler a fila', e)
    return
  }
  if (jobs.length === 0) return clearApiAlarmIfIdle()
  // Retenção: cada limite apaga o áudio e deixa a gravação com um motivo legível.
  const { keep, drop } = applyRetention(jobs, now)
  for (const { job: full, reason } of drop) {
    const motivo = full.lastError && reason === 'tentativas' ? t('apiErrAttemptsWhy', String(full.attempts), full.lastError) : dropReason(reason, full)
    await setState(full.sessionId, failed(motivo))
    await deleteApiAudio(full.sessionId).catch(() => {})
    log('áudio guardado apagado', reason, full.savedPath)
  }
  const cfg = (await loadSettings()).apiTranscription
  if (!cfg.ativa) {
    // Desligado no meio: o que está guardado espera (a retenção ainda manda), e NADA é enviado.
    for (const job of keep) await setState(job.sessionId, pending(t('apiErrOff')))
    return clearApiAlarmIfIdle()
  }
  if (!isAllowedEndpoint(endpointOf(cfg))) {
    for (const job of keep) await setState(job.sessionId, pending(t('apiErrEndpoint', endpointOf(cfg))))
    return clearApiAlarmIfIdle()
  }
  if (!(await hasApiPermission(cfg))) {
    // Sem a permissão de host concedida, NADA é enviado: a gravação espera na fila com o motivo.
    for (const job of keep) await setState(job.sessionId, pending(t('apiErrNoPermission', providerOf(cfg.provedor).rotulo)))
    return clearApiAlarmIfIdle()
  }
  const key = await loadApiKey()
  if (!key) {
    for (const job of keep) await setState(job.sessionId, pending(t('apiErrNoKey')))
    return clearApiAlarmIfIdle()
  }
  for (const job of [...keep].sort((a, b) => a.createdAt - b.createdAt)) {
    if (job.nextAt > now) continue
    await one(job, cfg, key)
  }
  await clearApiAlarmIfIdle()
}

/** Um trabalho: envia, escreve a saída e sai da fila, ou guarda a falha para a próxima tentativa. */
async function one(job: ApiAudioRecord, cfg: ApiTranscriptionConfig, key: string): Promise<void> {
  await setState(job.sessionId, { status: 'transcrevendo' })
  const started = Date.now()
  const r = await send(cfg, job.blob, key)
  if (!r.ok) {
    const kind = classifyApiError(r.status)
    const motivo = kind === 'grande' ? t('apiErrTooLarge', mb(job.bytes), mb(maxBytesOf(cfg))) : apiErrorReason(kind, r.status)
    const attempts = job.attempts + 1
    if (!retriesAlone(kind)) {
      // 401 é erro de configuração: repetir não conserta. O áudio sai e a gravação fica com o motivo.
      await setState(job.sessionId, failed(motivo))
      await deleteApiAudio(job.sessionId).catch(() => {})
      await recordInfo(job, { status: 'falhou', erro: motivo, started })
      log('falhou sem repetir', kind, job.savedPath)
      return
    }
    await putApiAudio({ ...job, attempts, nextAt: Date.now() + backoffFor(attempts), lastError: motivo })
    await setState(job.sessionId, pending(motivo))
    ensureApiAlarm()
    log('vai repetir', kind, job.savedPath, attempts)
    return
  }
  try {
    const out = buildTranscript(job, cfg, r.json)
    const written = await writeTranscript(job, out.files)
    const transcricao: InfoTranscription & { arquivos: string[] } = {
      status: 'pronta',
      motor: API_ENGINE_ID,
      modelo: modelOf(cfg),
      idioma: out.language,
      audio: job.audio,
      inicio: new Date(started).toISOString(),
      fim: new Date().toISOString(),
      duracaoProcessamentoSeg: Math.round((Date.now() - started) / 100) / 10,
      arquivos: out.files.map((f) => f.nome),
    }
    await recordInfo(job, { status: 'pronta', transcricao, started })
    await setState(job.sessionId, {
      status: 'pronta',
      ...(written.path ? { arquivo: written.path } : {}),
      ...(written.downloadId !== undefined ? { downloadId: written.downloadId } : {}),
    })
    // Só agora o áudio guardado sai: a saída está escrita.
    await deleteApiAudio(job.sessionId).catch(() => {})
    log('pronta', job.savedPath, out.files.map((f) => f.nome).join(', '))
  } catch (e) {
    const motivo = t('apiErrWrite', String((e as Error)?.message ?? e))
    const attempts = job.attempts + 1
    await putApiAudio({ ...job, attempts, nextAt: Date.now() + backoffFor(attempts), lastError: motivo })
    await setState(job.sessionId, pending(motivo))
    ensureApiAlarm()
    log('não deu para escrever a saída', e)
  }
}

/** Registra o estado no info.json da pasta da call, quando dá (só o helper reescreve arquivo). */
async function recordInfo(job: ApiAudioRecord, s: { status: TranscriptionStatus; erro?: string; transcricao?: InfoTranscription; started: number }): Promise<void> {
  if (job.sink !== 'host') return
  const transcricao: InfoTranscription =
    s.transcricao ??
    ({
      status: s.status,
      motor: API_ENGINE_ID,
      modelo: null,
      idioma: job.info.idiomaInterface ?? '',
      audio: job.audio,
      inicio: new Date(s.started).toISOString(),
      fim: new Date().toISOString(),
      duracaoProcessamentoSeg: Math.round((Date.now() - s.started) / 100) / 10,
      arquivos: [],
      ...(s.erro ? { erro: s.erro } : {}),
    } satisfies InfoTranscription)
  await writeTranscript(job, [], transcricao).catch((e) => log('não deu para registrar no info.json', e))
}

/** Um arquivo de texto da transcrição a escrever na pasta da call. */
export interface TranscriptFile {
  nome: string
  texto: string
}

/**
 * O texto da transcrição. Passa pelas MESMAS funções do helper (host/texto.mjs): o colapso das
 * repetições, o casamento dos tempos com o falantes.json desta sessão, a herança do falante num
 * buraco curto, os parágrafos e o cabeçalho. É isto que faz o transcricao.md sair com os nomes de
 * quem falou, igual ao do motor local.
 */
export function buildTranscript(job: Pick<ApiAudioRecord, 'audio' | 'info' | 'speakers'>, cfg: ApiTranscriptionConfig, json: unknown): { files: TranscriptFile[]; language: string } {
  const language = languageFromApiJson(json, cfg)
  const raw = segmentsFromApiJson(json)
  // Sem silêncios medidos (a API não os devolve), o dropInventedSegments não tiraria nada: ele é o
  // único passo do motor local que depende do ffmpeg, e fica de fora.
  const kept = collapseRepeats(raw, [])
  const timeline = speakerTimelineFrom(job.speakers, job.audio)
  const segments = timeline ? fillSpeakerGaps(assignSpeakers(kept, timeline)) : kept
  const stem = transcriptStem(job.audio)
  const md = buildMarkdown({
    info: job.info,
    segments,
    language,
    motor: API_ENGINE_ID,
    model: modelOf(cfg),
    audio: job.audio,
    pauses: [],
    speakers: timeline,
  })
  return { files: [{ nome: `${stem}.md`, texto: md }, { nome: `${stem}.srt`, texto: buildSrt(segments) }], language }
}

// ---------------------------------------------------------------------------------------------
// O que o popup mostra
// ---------------------------------------------------------------------------------------------

/**
 * O estado por sessionId das gravações recentes, para o ui:state. Só as que este motor tratou: o
 * resto continua vindo do helper (./transcription.ts).
 */
export async function apiTranscriptionForPopup(recent: readonly RecentRecording[]): Promise<ApiTranscriptionStates> {
  const states = await loadApiStates()
  const out: ApiTranscriptionStates = {}
  for (const r of recent) if (states[r.sessionId]) out[r.sessionId] = states[r.sessionId]
  return out
}
