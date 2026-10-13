// Textos do popup que dependem de regra (testados com vitest em format.test.ts). Texto que
// aparece uma vez só fica no JSX. Todos passam por t() (Emenda 15).
import { format, type Locale } from 'date-fns'
import { enUS, ptBR } from 'date-fns/locale'
import type { ActiveRecording, RecentRecording, RecentTranscription, RecordingPlatform, TranscriptionUiState, VigiaCfg, VigiaStatus } from '../shared/protocol'
import { helperReason } from '../shared/helper-reasons'
import { messageLocale, t } from '../shared/i18n'
import { vigiaCountLine } from '../shared/vigia-text'

/** Nome da plataforma (Meet e Teams são nomes próprios; "Outro site" é traduzido). */
export function platformLabel(p: RecordingPlatform): string {
  return p === 'meet' ? 'Meet' : p === 'teams' ? 'Teams' : t('platformOther')
}

/** Locale do date-fns no idioma das mensagens. */
export function dateLocale(): Locale {
  return messageLocale().toLowerCase().startsWith('pt') ? ptBR : enUS
}

/** Sem nenhum áudio desde o início por este tempo: o mesmo alerta do badge âmbar (AC13). */
export const NO_AUDIO_HINT_MS = 60_000

/** Tempo decorrido como relógio: "0:07", "12:34", "1:02:03". */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

/** Duração de uma gravação salva: "45 s", "12 min", "1 h 05 min". */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  if (s < 60) return t('durationSeconds', s)
  const totalMin = Math.round(s / 60)
  if (totalMin < 60) return t('durationMinutes', totalMin)
  const h = Math.floor(totalMin / 60)
  return t('durationHours', h, String(totalMin % 60).padStart(2, '0'))
}

/** Data e hora de início nas últimas gravações: "06/10 14:30" (em inglês, "Oct 6, 2:30 PM"). */
export function formatStart(at: number): string {
  return format(at, t('datePattern'), { locale: dateLocale() })
}

/** Data e hora completas (a confirmação do aviso na página de boas-vindas). */
export function formatDateTime(at: number): string {
  return format(at, t('dateTimePattern'), { locale: dateLocale() })
}

export type AudioTone = 'ok' | 'aviso' | 'alerta'

/** Está chegando áudio agora? (AC11, Emenda 6: audioNow e silentForMs vêm do SW). */
export function audioStatus(rec: Pick<ActiveRecording, 'audioNow' | 'hasAudio' | 'silentForMs' | 'startedAt'>, now: number): { text: string; tone: AudioTone } {
  if (rec.audioNow) return { text: t('audioArriving'), tone: 'ok' }
  if (rec.hasAudio && rec.silentForMs !== null) return { text: t('audioSilentFor', formatElapsed(rec.silentForMs)), tone: 'aviso' }
  if (rec.hasAudio) return { text: t('audioSilentNow'), tone: 'aviso' }
  if (now - rec.startedAt >= NO_AUDIO_HINT_MS) return { text: t('audioNoneTryTabMode'), tone: 'alerta' }
  return { text: t('audioNoneYet'), tone: 'aviso' }
}

/**
 * Linha do vigia, a mesma do indicador na página (src/shared/vigia-text.ts):
 * "5 na call · pico 8 · sai com 2 ou menos", com "(espera alguém entrar)" e "· confirmando 2/4"
 * quando for o caso.
 */
export function vigiaLine(s: VigiaStatus, cfg: Pick<VigiaCfg, 'confirmacoes'>): string {
  if (!s.naCall) return t('vigiaOutOfCall')
  if (s.n === null) return t('vigiaNoCount', s.pico)
  return vigiaCountLine({ n: s.n, pico: s.pico, limite: s.limite, armado: s.armado, seguidas: s.seguidas }, cfg.confirmacoes)
}

/** Mostra a raiz encurtando a pasta pessoal para "~" (só visual; o helper guarda o absoluto). */
export function shortPath(path: string): string {
  return path.replace(/^\/Users\/[^/]+(?=\/|$)/, '~')
}

/**
 * O que dizer da transcrição de uma das últimas gravações (Emenda 13). Salva em Downloads não é
 * transcrita: com o helper presente e a transcrição ligada (a gravação caiu em Downloads porque o
 * helper falhou), avisa que precisa do helper. Sem helper nenhum (o jeito normal da loja, Emenda
 * 15), não diz nada: a transcrição é um recurso avançado, não um defeito de cada gravação. Salva
 * pelo helper: o estado do info.json, se houver.
 */
export function transcriptionOf(rec: Pick<RecentRecording, 'sessionId' | 'sink'>, tr: TranscriptionUiState | null): RecentTranscription | 'precisa-helper' | null {
  // Emenda 21: o estado desta gravação vale mais que a regra do destino. Com o motor por API
  // ligado, uma gravação em Downloads TAMBÉM é transcrita, então ela não "precisa do helper".
  const own = tr?.porSessao[rec.sessionId]
  if (own) return own
  if (rec.sink === 'downloads') return tr !== null && tr.ativa && tr.motor !== 'api' ? 'precisa-helper' : null
  return null
}

/**
 * Aviso geral da transcrição no rodapé do popup (Emenda 13): um helper sem transcrição (de antes
 * da 0.2.0) ou a transcrição ligada sem o motor (whisper, ffmpeg ou modelo faltando). null quando
 * não há nada a dizer, inclusive sem helper (as gravações em Downloads já dizem que precisam dele).
 */
export function transcriptionNotice(tr: TranscriptionUiState | null): string | null {
  if (!tr) return null
  // Emenda 21: o motor por API não depende do helper nem de motor instalado; o que ele tem a dizer
  // de cada gravação já está na linha dela.
  if (tr.motor === 'api') return null
  if (!tr.suportada) return t('trNoticeOldHelper', tr.motivo ?? t('helperNoAnswer'))
  if (tr.ativa && !tr.disponivel) return t('trNoticeUnavailable', tr.motivo ? helperReason(tr.motivo) : t('reasonUnknown'))
  return null
}
