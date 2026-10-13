// Arbitragem entre seams (docs/ARQUITETURA.md, "Arbitragem"). Função pura, testada com vitest.
//
// - energia em dBFS por grupo; "tem fala" acima de SPEECH_DBFS.
// - seam inicial: o primeiro da prioridade do adaptador que tiver alguma fonte.
// - troca só quando o selecionado está sem fala há pelo menos SILENCE_MS e outro seam teve fala
//   no último SPEECH_WINDOW_MS; escolhe o de maior prioridade entre os que têm fala. Nunca troca
//   se o atual está funcionando (evita oscilar).
// - a fala do outro seam tem de ter continuado pelo menos MIN_LEAD_MS depois da última fala do
//   selecionado. Sem isso, quando todos calam juntos (fim de toda call, ou só uma pausa) e um
//   caminho tem uns ms a mais de latência que o outro, a regra acima trocaria 1 s depois para um
//   seam que também já calou. Medido no teste "decoy": "sources" e "output" carregam o mesmo
//   áudio, e o tee de saída chega um laço depois.
// Quem chama aplica a troca nos seletores do mixer (depois do atraso de 1,5 s).
import type { SeamId, SeamSwitch } from '../../shared/protocol'

export const SPEECH_DBFS = -55
export const SILENCE_MS = 1000
export const SPEECH_WINDOW_MS = 1000
/** Quanto a fala do candidato tem de passar da última fala do selecionado (dois laços). */
export const MIN_LEAD_MS = 500
/** Intervalo do laço de arbitragem. */
export const ARBITRATION_TICK_MS = 250

export interface SeamMeasurement {
  /** Fontes ligadas no grupo. */
  sources: number
  /** Energia sem atraso, em dBFS. */
  dbfs: number
}

export type Measurements = Record<SeamId, SeamMeasurement>

export interface ArbitrationState {
  priority: readonly SeamId[]
  initial: SeamId | null
  selected: SeamId | null
  /** Quando o seam selecionado foi escolhido (dá a ele 1 s de carência). */
  selectedAt: number | null
  lastSpeechAt: Record<SeamId, number | null>
  everHadSpeech: boolean
  switches: SeamSwitch[]
}

export interface ArbitrationResult {
  state: ArbitrationState
  /** Troca a aplicar agora (inclui a escolha inicial, com from = null). */
  change: SeamSwitch | null
}

export function initialArbitration(priority: readonly SeamId[]): ArbitrationState {
  return {
    priority,
    initial: null,
    selected: null,
    selectedAt: null,
    lastSpeechAt: { receivers: null, elements: null, sources: null, output: null },
    everHadSpeech: false,
    switches: [],
  }
}

export function hasSpeech(m: SeamMeasurement | undefined): boolean {
  return !!m && m.sources > 0 && m.dbfs > SPEECH_DBFS
}

export function arbitrate(state: ArbitrationState, measurements: Measurements, now: number): ArbitrationResult {
  const lastSpeechAt = { ...state.lastSpeechAt }
  for (const id of state.priority) {
    if (hasSpeech(measurements[id])) lastSpeechAt[id] = now
  }
  const next: ArbitrationState = { ...state, lastSpeechAt }
  if (state.selected && hasSpeech(measurements[state.selected])) next.everHadSpeech = true

  // Escolha inicial.
  if (!state.selected) {
    const first = state.priority.find((id) => (measurements[id]?.sources ?? 0) > 0)
    if (!first) return { state: next, change: null }
    const change: SeamSwitch = { at: now, from: null, to: first }
    next.selected = first
    next.initial = first
    next.selectedAt = now
    if (hasSpeech(measurements[first])) next.everHadSpeech = true
    return { state: next, change }
  }

  const current = state.selected
  const currentSpeech = lastSpeechAt[current]
  const silentSince = Math.max(currentSpeech ?? -Infinity, state.selectedAt ?? -Infinity)
  if (now - silentSince < SILENCE_MS) return { state: next, change: null }

  const candidate = state.priority.find((id) => {
    if (id === current) return false
    const at = lastSpeechAt[id]
    if (at === null || now - at > SPEECH_WINDOW_MS || (measurements[id]?.sources ?? 0) === 0) return false
    return currentSpeech === null || at - currentSpeech >= MIN_LEAD_MS
  })
  if (!candidate) return { state: next, change: null }

  const change: SeamSwitch = { at: now, from: current, to: candidate }
  next.selected = candidate
  next.selectedAt = now
  next.switches = [...state.switches, change]
  return { state: next, change }
}
