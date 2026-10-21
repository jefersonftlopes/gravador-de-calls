// Monta o info.json (docs/ARQUITETURA.md, "info.json") a partir do registro da sessão.
import { formatISO } from 'date-fns'
import { RECORDING_KBPS, RECORDING_MIME } from '../shared/constants'
import { displayTitle } from '../shared/naming'
import type { InfoFile, InfoJson, InfoLanguage, TitleSource } from '../shared/protocol'
import { messageLocale, t, uiLanguage } from '../shared/i18n'
import { speakersOutput, type SpeakerLabels } from '../shared/speakers'
import type { SessionRecord } from './idb'

export const iso = (ms: number) => formatISO(new Date(ms))

export function timeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone
  } catch {
    return 'desconhecido'
  }
}

/**
 * Idioma da interface para o info.json (Emenda 19): o helper escreve nele o cabeçalho do
 * transcricao.md. Só com o idioma escolhido nas configurações; no automático, null (o info.json sai
 * sem o campo e o cabeçalho em português, como antes da 0.4.1, qualquer que seja o idioma do Chrome).
 */
export function interfaceLanguage(): InfoLanguage | null {
  if (uiLanguage() === 'auto') return null
  return messageLocale() === 'pt-BR' ? 'pt-BR' : 'en'
}

/** Rótulos da linha do tempo dos falantes no idioma da interface (Emenda 18). */
export function speakerLabels(): SpeakerLabels {
  return { you: t('speakerYou'), unknown: (n) => t('speakerUnknown', n), youNotRecorded: t('speakerYouNotRecorded') }
}

/** O falantes.json e o resumo do info.json desta sessão (null sem falante de participante). */
export function speakersOf(rec: SessionRecord) {
  return rec.kind === 'pagina' ? speakersOutput(rec.speakers, speakerLabels(), rec.file) : null
}

/**
 * Uma entrada de `arquivos` do info.json. Emenda 25: o `audio-microfone.webm` leva o `desvioMs`, o
 * quanto ele começou depois do audio.webm da mesma pasta (os dois saem do mesmo atraso do mixer,
 * então é só esse número que falta para casar os dois no tempo). Só quando ele entra na pasta da
 * call, e só quando há desvio medido.
 */
export function infoFileOf(rec: SessionRecord): InfoFile {
  const skew = rec.kind === 'microfone' && rec.pairedSessionId && typeof rec.micSkewMs === 'number' ? Math.round(rec.micSkewMs) : null
  return {
    nome: rec.file,
    tipo: rec.kind,
    bytes: rec.bytes,
    formato: RECORDING_MIME,
    kbps: RECORDING_KBPS,
    ...(skew === null ? {} : { desvioMs: skew }),
  }
}

export function buildInfo(
  rec: SessionRecord,
  opts: { interrupted: boolean; extensionVersion: string; helperVersion: string | null },
): InfoJson {
  const meta = rec.meta
  const endedAt = rec.endedAt ?? rec.lastChunkAt ?? rec.startedAt
  const title = displayTitle(meta.title, meta.code)
  const titleSource: TitleSource = meta.titleSource ?? (meta.title ? 'dom' : meta.code ? 'codigo' : 'nenhum')
  const diag = rec.diag
  const speakers = speakersOf(rec)
  const language = interfaceLanguage()
  return {
    versao: 1,
    sessao: rec.sessionId,
    perfil: rec.profileLabel.trim() || null,
    plataforma: rec.platform,
    titulo: title,
    tituloFonte: titleSource,
    codigo: meta.code ?? '',
    idReuniao: meta.meetingId ?? '',
    url: meta.url ?? '',
    tituloDaAba: meta.tabTitle ?? '',
    ...(meta.titleSignals
      ? { tituloSinais: { elemento: meta.titleSignals.element, seletor: meta.titleSignals.selector, abaIgualCodigo: meta.titleSignals.tabEqualsCode } }
      : {}),
    inicio: iso(rec.startedAt),
    fim: iso(endedAt),
    duracaoSegundos: Math.max(0, Math.round((endedAt - rec.startedAt) / 1000)),
    fuso: timeZone(),
    // O SW junta os participantes de todas as leituras: o próprio nome que chegou depois sai aqui.
    participantes: (meta.participants ?? []).filter((n) => !meta.selfName || n !== meta.selfName),
    voce: meta.selfName ?? '',
    ...(meta.selfSignals ? { voceSinais: { roster: meta.selfSignals.roster, espacos: meta.selfSignals.spaces, marcadorDom: meta.selfSignals.domMarker } } : {}),
    arquivos: [infoFileOf(rec)],
    captura: {
      fonteInicial: diag?.initial ?? null,
      fonteFinal: diag?.selected ?? null,
      trocas: rec.seamSwitches.filter((s) => s.from !== null).map((s) => ({ em: iso(s.at), de: s.from, para: s.to })),
      contextoAudio: diag?.ctxState ?? 'none',
      teveAudio: diag?.everHadSpeech ?? false,
    },
    // Espera ainda aberta no fim vai até o fim da gravação.
    esperas: rec.holds.map((h) => ({ de: iso(h.from), ate: iso(h.to ?? endedAt) })),
    lacunas: rec.gaps,
    status: opts.interrupted ? 'interrompida' : 'concluida',
    motivoFim: rec.endReason ?? (opts.interrupted ? 'interrompida' : 'call-encerrada'),
    ...(rec.autoLeave
      ? { saidaAutomatica: { motivo: rec.autoLeave.motivo, pico: rec.autoLeave.pico, na: rec.autoLeave.na, em: iso(rec.autoLeave.em) } }
      : {}),
    extensao: opts.extensionVersion,
    helper: opts.helperVersion,
    ...(language ? { idiomaInterface: language } : {}),
    ...(speakers ? { falantes: speakers.summary } : {}),
  }
}
