// Tipos de host/texto.mjs (Emenda 21): o texto da transcrição, igual no helper (Node sem build) e
// na extensão (TypeScript com Vite). O mesmo arranjo de scripts/build-info.mjs + .d.mts, que o
// vite.config.ts já usa: o Node importa o .mjs direto e o TypeScript lê os tipos daqui.
import type { InfoJson, InfoTranscription, SpeakersFile } from '../src/shared/protocol'

/** Segmento de fala do motor de transcrição, em segundos. */
export interface TextSegment {
  start: number
  end: number
  text: string
  /** Nome de quem falou (depois do assignSpeakers). */
  speaker?: string
}

/** Silêncio medido no áudio, em segundos. */
export interface TextPause {
  start: number
  end: number
}

/** Um intervalo da linha do tempo dos falantes, já em segundos. */
export interface TimelineInterval {
  nome: string
  start: number
  end: number
  voce: boolean
}

/** Medida de uma fonte sem nome contra as nomeadas (Emenda 20). */
export interface UnnamedCheck {
  nome: string
  segundos: number
  coberturaPct: number
  presencaPct: number
  pessoasCobertas: number
  /** Acompanha quem fala: não é uma pessoa. */
  sombra: boolean
}

/** A linha do tempo lida de um falantes.json, pronta para o assignSpeakers. */
export interface SpeakerTimeline {
  remote: TimelineInterval[]
  self: TimelineInterval[]
  /** Texto que entra no lugar da fala do próprio usuário. */
  naoGravada: string
  descartadas: UnnamedCheck[]
}

export type MarkdownLanguage = 'pt-BR' | 'en'

export interface MarkdownLabelSet {
  untitled: string
  platform: string
  date: string
  duration: string
  participants: string
  nobody: string
  profile: string
  audio: string
  tabMode: string
  transcription: string
  model: string
  language: string
  noSpeech: string
  unknown: string
  otherSite: string
}

export declare const isObj: (v: unknown) => boolean
export declare const mdLine: (s: unknown) => string
export declare const LANGUAGE_RE: RegExp
/** Rótulo de cada motor nas telas e no transcricao.md. */
export declare const ENGINE_LABELS: Record<string, string>
export declare const MODEL_PREFERENCE: string[]
export declare function rankModel(fileName: string, idioma?: string): number | null
export declare function errorLine(stderr: unknown): string

export declare function speechText(raw: unknown): string
export declare function segmentsFromWhisperJson(json: unknown): TextSegment[]
export declare function silencesFromFfmpeg(stderr: unknown): TextPause[]
export declare function dropInventedSegments<T extends TextSegment>(segments: T[], pauses?: readonly TextPause[]): T[]

export declare const REPEATS: Readonly<{
  minPhraseCopies: number
  minWordCopies: number
  window: number
  windowSec: number
  minWindowWords: number
}>
export declare function collapseInside(text: string, o?: typeof REPEATS): string
export declare function collapseRepeats<T extends TextSegment>(segments: readonly T[], pauses?: readonly TextPause[], o?: typeof REPEATS): T[]
export declare const NEIGHBOR_GAP_SEC: number
export declare function fillSpeakerGaps<T extends TextSegment>(segments: readonly T[]): T[]

export declare const PARAGRAPH: Readonly<{ maxGapSec: number; softChars: number; hardChars: number }>
export declare function pausedBetween(last: TextSegment, next: TextSegment, pauses: readonly TextPause[], rules: typeof PARAGRAPH): boolean
export declare function mergeSegments(segments: readonly TextSegment[], rules?: typeof PARAGRAPH, pauses?: readonly TextPause[]): TextSegment[]

export declare function formatClock(sec: number, long?: boolean): string
export declare function formatSrtTime(sec: number): string
export declare function buildSrt(segments: readonly TextSegment[]): string

export declare const SPEAKERS_FILE: string
export declare const MIN_SELF_LINE_SEC: number
export declare const SELF_MAX_COVERED: number
export declare function cleanSpeakerName(s: unknown): string
export declare const mdName: (s: string) => string
export declare const srtName: (s: string) => string
export declare const UNNAMED_SHADOW: Readonly<{ minCoveredPct: number; minPresencePct: number }>
export declare function checkUnnamedSources(remote: readonly TimelineInterval[], unnamed: ReadonlySet<string>): UnnamedCheck[]
/** null sem o arquivo, de outro áudio, ou sem nenhum intervalo de participante. */
export declare function speakerTimelineFrom(file: SpeakersFile | null | undefined, audio: string): SpeakerTimeline | null
export declare function assignSpeakers<T extends TextSegment>(segments: readonly T[], timeline: SpeakerTimeline | null): T[]
export declare function selfLines(timeline: SpeakerTimeline | null, segments: readonly TextSegment[]): Array<TextSegment & { speaker: string; self: true }>

export declare const MARKDOWN_LABELS: Readonly<Record<MarkdownLanguage, Readonly<MarkdownLabelSet>>>
export declare function markdownLanguage(info: unknown): MarkdownLanguage
export declare function platformLabel(platform: unknown, labels: MarkdownLabelSet): string
export declare function formatDuration(totalSec: unknown): string
export declare function formatLocalStart(iso: unknown, lang?: MarkdownLanguage): string

export declare function buildMarkdown(opts: {
  info?: Partial<InfoJson> | Record<string, unknown>
  segments: readonly TextSegment[]
  language?: string | null
  motor: string
  model?: string | null
  audio?: string
  pauses?: readonly TextPause[]
  speakers?: SpeakerTimeline | null
}): string

export declare function transcriptionsOf(info: unknown): Record<string, InfoTranscription>
export declare const ORPHAN_GRACE_MS: number
export declare function reconcileTranscription(t: unknown, opts: { queued: boolean; ageMs: number }): InfoTranscription | null
export declare function transcriptStem(audio: string): string
