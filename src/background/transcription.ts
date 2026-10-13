// Transcrição no service worker (Emenda 13). Quem transcreve é o helper (fila e worker
// destacado, host/transcricao.mjs); aqui só se lê o estado para o popup e as configurações e se
// repassam os pedidos delas. Uma gravação salva em Downloads (sem helper) não é transcrita.
import {
  transcriptionPatchSchema,
  type HelperStatus,
  type HostTranscriptionStatusOk,
  type RecentRecording,
  type RecentTranscription,
  type TranscriptionConfig,
  type TranscriptionEngineInfo,
  type TranscriptionUiState,
  type UiResMap,
} from '../shared/protocol'
import { apiTranscriptionForPopup, loadApiStates } from './api-transcription'
import { loadSettings } from '../shared/settings'
import { host } from './sink-host'
import { t } from '../shared/i18n'

/** O popup pede o estado a cada 1 s; o helper é consultado no máximo a cada STATUS_CACHE_MS. */
const STATUS_CACHE_MS = 2000
/** Quantas das últimas gravações têm o estado conferido (o popup mostra 5). */
const RECENT_CHECKED = 10

/** Helper de antes da 0.2.0: não conhece as operações da transcrição. */
const UNKNOWN_OP_RE = /operação desconhecida/
/** Motivo mostrado para um helper sem transcrição (lido na hora, no idioma da interface). */
export const oldHelperReason = (): string => t('trOldHelper')

let cache: { at: number; key: string; value: TranscriptionUiState } | null = null

/** Para os testes de unidade e quando a configuração muda. */
export function clearTranscriptionCache(): void {
  cache = null
}

/** O .md da transcrição que o helper escreveu (transcricao.md, transcricao-aba.md...). */
const TRANSCRIPT_MD_RE = /^transcricao[\w.-]*\.md$/

/** Caminho do .md na pasta: o nome que o info.json diz, ou transcricao.md (helper da 0.2.0). */
function transcriptPath(folder: string, arquivos: unknown): string {
  const name = Array.isArray(arquivos) ? arquivos.find((a): a is string => typeof a === 'string' && TRANSCRIPT_MD_RE.test(a)) : undefined
  return `${folder.replace(/\/+$/, '')}/${name ?? 'transcricao.md'}`
}

/**
 * Estado da transcrição para o popup. null sem helper E sem o motor por API (aí não há
 * transcrição nenhuma neste perfil, e o popup não fala dela).
 *
 * Emenda 21: com o motor por API ligado, o estado de cada gravação vem da extensão
 * (./api-transcription.ts) e vale mais que o do helper, porque é ele que transcreveu aquela call.
 */
export async function transcriptionForPopup(recent: RecentRecording[], helper: HelperStatus): Promise<TranscriptionUiState | null> {
  const api = (await loadSettings()).apiTranscription.ativa
  const apiStates = api ? await apiTranscriptionForPopup(recent) : {}
  if (!helper.ok) {
    if (!api) return null
    return { suportada: true, ativa: true, disponivel: true, motivo: null, porSessao: apiStates, motor: 'api' }
  }
  const tracked = recent.filter((r) => r.sink === 'host' && r.path).slice(0, RECENT_CHECKED)
  const key = tracked.map((r) => `${r.sessionId}:${r.path}`).join('|')
  // O cache é só da resposta do helper (o estado do motor por API é lido do storage, sem custo).
  if (cache && cache.key === key && Date.now() - cache.at < STATUS_CACHE_MS) return withApi(cache.value, api, apiStates)
  const r = await host.transcriptionStatus(
    tracked.map((t) => t.path),
    2000,
  )
  let value: TranscriptionUiState
  if (!r.ok) {
    const old = UNKNOWN_OP_RE.test(r.error)
    value = { suportada: !old, ativa: false, disponivel: false, motivo: old ? oldHelperReason() : r.error, porSessao: {} }
  } else {
    const st = r as unknown as HostTranscriptionStatusOk
    const byPath = new Map((Array.isArray(st.recentes) ? st.recentes : []).map((x) => [x.path, x.transcricao]))
    const porSessao: Record<string, RecentTranscription> = {}
    for (const t of tracked) {
      const info = byPath.get(t.path)
      if (!info || typeof info.status !== 'string') continue
      porSessao[t.sessionId] = {
        status: info.status,
        ...(info.erro ? { erro: String(info.erro) } : {}),
        ...(info.status === 'pendente' && info.espera ? { espera: String(info.espera) } : {}),
        ...(info.status === 'pronta' ? { arquivo: transcriptPath(t.path, info.arquivos) } : {}),
      }
    }
    value = { suportada: true, ativa: st.ativa === true, disponivel: st.disponivel === true, motivo: st.motivo ?? null, porSessao }
  }
  cache = { at: Date.now(), key, value }
  return withApi(value, api, apiStates)
}

/**
 * Emenda 21: com o motor por API ligado neste perfil, ele é o que está ligado, e o estado de cada
 * gravação que ele tratou vale mais que o do helper (foi ele que transcreveu aquela call).
 */
function withApi(value: TranscriptionUiState, api: boolean, apiStates: Record<string, RecentTranscription>): TranscriptionUiState {
  if (!api) return value
  return { ...value, ativa: true, disponivel: true, motivo: null, motor: 'api', porSessao: { ...value.porSessao, ...apiStates } }
}

/** Configuração, motores e disponibilidade (tela de configurações). */
export async function transcriptionSettings(): Promise<UiResMap['ui:transcription']> {
  const cfg = await host.getConfig()
  if (!cfg.ok) return { ok: false, error: cfg.error }
  if (!cfg.transcricao || typeof cfg.transcricao !== 'object') return { ok: false, error: oldHelperReason() }
  const st = await host.transcriptionStatus([])
  if (!st.ok) return { ok: false, error: UNKNOWN_OP_RE.test(st.error) ? oldHelperReason() : st.error }
  const status = st as unknown as HostTranscriptionStatusOk
  return {
    ok: true,
    state: {
      config: cfg.transcricao as TranscriptionConfig,
      motores: Array.isArray(cfg.motores) ? (cfg.motores as TranscriptionEngineInfo[]) : [{ id: 'whisper-cpp', rotulo: 'whisper.cpp (local)' }],
      disponivel: status.disponivel === true,
      motivo: status.motivo ?? null,
      detalhes: status.detalhes ?? {},
    },
  }
}

/** Valida (zod) e manda ao helper, que confere de novo e grava no config.json. */
export async function setTranscription(patch: unknown): Promise<UiResMap['ui:set-transcription']> {
  const parsed = transcriptionPatchSchema.safeParse(patch)
  if (!parsed.success) return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join('.') || 'pedido'}: ${i.message}`).join('; ') }
  const r = await host.setTranscription(parsed.data)
  clearTranscriptionCache()
  if (!r.ok) return { ok: false, error: UNKNOWN_OP_RE.test(r.error) ? oldHelperReason() : r.error }
  return { ok: true, config: r.transcricao as TranscriptionConfig }
}

/**
 * "Abrir transcrição": a pasta sai da gravação salva (nunca do popup) e o nome do arquivo, do
 * info.json dela (transcricao-aba.md quando a principal é a do modo aba); o helper confere a raiz e
 * o nome de novo.
 */
export async function openTranscript(rec: RecentRecording | undefined): Promise<UiResMap['ui:open-transcript']> {
  if (!rec) return { ok: false, error: t('errRecordingNotFound') }
  if (rec.sink !== 'host' || !rec.path) {
    // Emenda 21: sem o helper, a transcrição por API desceu pelo chrome.downloads. A extensão não
    // tem como abrir um arquivo com o aplicativo padrão (seria a permissão `downloads.open`, que
    // não vale o escopo), então mostra o arquivo no Finder, como o "Mostrar no Finder".
    const id = (await loadApiStates())[rec.sessionId]?.downloadId
    if (id === undefined) return { ok: false, error: t('errTranscriptNeedsHelper') }
    try {
      chrome.downloads.show(id)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: String((e as Error)?.message ?? e) }
    }
  }
  const st = await host.transcriptionStatus([rec.path], 2000)
  const info = st.ok ? (st as unknown as HostTranscriptionStatusOk).recentes?.find((x) => x.path === rec.path)?.transcricao : null
  const r = await host.openFile(transcriptPath(rec.path, info?.arquivos))
  return r.ok ? { ok: true } : { ok: false, error: r.error }
}

export async function chooseModel(): Promise<UiResMap['ui:choose-model']> {
  const r = await host.chooseFile(t('promptChooseModel'))
  return r.ok ? { ok: true, path: String(r.path) } : { ok: false, error: r.error }
}
