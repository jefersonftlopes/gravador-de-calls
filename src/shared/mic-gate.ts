// Regra do mudo (Emenda 24): quando o microfone conta como ABERTO (quente) e, quando não conta,
// qual condição o fechou. Pura e sem zod, como ./vigia-rule.ts e ./speakers.ts: o registry do MAIN
// world só OBSERVA o estado de cada faixa (capture/registry.ts, `micGateInputs`) e quem decide é
// este arquivo, que roda também no vitest sem navegador nenhum.
//
// O PADRÃO É FECHADO: qualquer uma das condições falsa, ou qualquer estado que não se consiga
// determinar, significa fechado. Gravar quem se achava mudo é o pior defeito possível deste
// recurso, então na dúvida não se grava.
//
// Mutar não é só parar a faixa: um aplicativo pode mutar PARANDO DE ENVIAR e mantendo a captura
// viva, para não pedir permissão de novo nem ter atraso ao desmutar. Nesse caso a tela diz mudo e a
// faixa continua quente. Por isso a condição (d): a faixa tem de ser, AGORA, a faixa de algum
// RTCRtpSender de uma RTCPeerConnection registrada.
//
// Qual das formas o Meet e o Teams usam de verdade NÃO se sabe: é o que o diagnóstico mede numa
// call real (`micGateDiagnostics`, que vai no falantes.json como o diagnóstico de CSRC da Emenda
// 20). Nada aqui grava áudio: este arquivo só decide e conta.
import type { SpeakerDiagnostics } from './protocol'

/**
 * Por que o portão está fechado. Os quatro primeiros são as condições da regra, na ordem em que
 * são conferidas; os dois últimos são o padrão fechado:
 * - `sem-faixa`: nenhuma faixa de microfone à vista (antes do getUserMedia, ou depois de a
 *   página largar todas);
 * - `desconhecido`: alguma condição não deu para determinar (a regra não chuta).
 */
export type MicGateReason = 'readyState' | 'enabled' | 'muted' | 'sem-sender' | 'sem-faixa' | 'desconhecido'

/** Todos os motivos, na ordem em que o diagnóstico os escreve. */
export const MIC_GATE_REASONS: readonly MicGateReason[] = ['readyState', 'enabled', 'muted', 'sem-sender', 'sem-faixa', 'desconhecido']

/**
 * O estado observado de UMA faixa de microfone (o que o registry lê, sem decidir nada). Qualquer
 * campo `undefined` é "não deu para determinar", e fecha o portão por `desconhecido`.
 */
export interface MicTrackState {
  /** `track.readyState`: só `'live'` abre. */
  readyState?: string
  /** `track.enabled`. */
  enabled?: boolean
  /** `track.muted`: mudo do sistema ou do aparelho. */
  muted?: boolean
  /**
   * Id do RTCRtpSender que manda esta faixa agora (número estável por sender, nunca o objeto);
   * `null` quando nenhum sender a manda, `undefined` quando não deu para ler os senders.
   */
  sender?: number | null
}

export interface MicGateDecision {
  open: boolean
  /** A condição que fechou; `null` quando abriu. */
  reason: MicGateReason | null
  /** O sender da faixa que abriu o portão; `null` quando fechado. */
  sender: number | null
}

/**
 * Quão perto do aberto uma faixa chegou. Com várias faixas, o motivo do portão é o da faixa que
 * chegou mais longe: é a informação mais útil (uma faixa morta ao lado de uma viva que não está
 * sendo enviada diz "a página parou de enviar", não "a faixa morreu").
 */
const RANK: Record<MicGateReason, number> = { desconhecido: 0, 'sem-faixa': 0, readyState: 1, enabled: 2, muted: 3, 'sem-sender': 4 }

/** A condição que fecha esta faixa, na ordem da regra; `null` quando ela está aberta. */
function reasonOfTrack(t: MicTrackState): MicGateReason | null {
  if (typeof t.readyState !== 'string' || typeof t.enabled !== 'boolean' || typeof t.muted !== 'boolean' || t.sender === undefined) return 'desconhecido'
  if (t.readyState !== 'live') return 'readyState'
  if (!t.enabled) return 'enabled'
  if (t.muted) return 'muted'
  if (t.sender === null) return 'sem-sender'
  return null
}

/**
 * O portão do microfone: ABERTO quando alguma faixa passa pelas quatro condições (viva, ligada,
 * sem mudo do sistema e sendo enviada por um sender de verdade); FECHADO em qualquer outro caso,
 * com o motivo da faixa que chegou mais longe.
 */
export function micGateDecide(tracks: readonly MicTrackState[]): MicGateDecision {
  if (tracks.length === 0) return { open: false, reason: 'sem-faixa', sender: null }
  let worst: MicGateReason | null = null
  for (const t of tracks) {
    const r = reasonOfTrack(t)
    if (r === null) return { open: true, reason: null, sender: t.sender as number }
    if (worst === null || RANK[r] > RANK[worst]) worst = r
  }
  return { open: false, reason: worst ?? 'desconhecido', sender: null }
}

/**
 * Quanto tempo uma leitura pode valer. O laço é de 250 ms, mas uma aba em segundo plano (ou a
 * máquina suspensa) pode deixar duas leituras longe uma da outra; o teto evita que uma suspensão
 * de horas vire "horas com o microfone aberto".
 */
export const MIC_GATE_MAX_STEP_MS = 5000

/** O que o controlador da sessão acumula durante a gravação (só números, nunca áudio). */
export interface MicGateStats {
  readings: number
  /** Estado atual; `null` antes da primeira leitura. */
  open: boolean | null
  /** Instante da última leitura (mesmo relógio das leituras). */
  at: number | null
  openMs: number
  closedMs: number
  /** Transições para aberto e para fechado (a primeira leitura conta uma). */
  opened: number
  closed: number
  /** Leituras fechadas por cada motivo (uma leitura aberta não conta em nenhum). */
  reasons: Record<MicGateReason, number>
  /** Maior número de faixas de microfone vistas numa leitura. */
  maxTracks: number
}

export function initialMicGate(): MicGateStats {
  return {
    readings: 0,
    open: null,
    at: null,
    openMs: 0,
    closedMs: 0,
    opened: 0,
    closed: 0,
    reasons: { readyState: 0, enabled: 0, muted: 0, 'sem-sender': 0, 'sem-faixa': 0, desconhecido: 0 },
    maxTracks: 0,
  }
}

/**
 * Uma leitura: soma o tempo desde a leitura anterior no estado que valia até agora, aplica a
 * decisão e conta a transição e o motivo. Pura (devolve um estado novo), como `arbitrate`.
 */
export function stepMicGate(s: MicGateStats, now: number, tracks: readonly MicTrackState[]): MicGateStats {
  const d = micGateDecide(tracks)
  const dt = s.at === null ? 0 : Math.min(Math.max(0, now - s.at), MIC_GATE_MAX_STEP_MS)
  const changed = s.open !== d.open
  return {
    readings: s.readings + 1,
    open: d.open,
    at: now,
    openMs: s.openMs + (s.open === true ? dt : 0),
    closedMs: s.closedMs + (s.open === false ? dt : 0),
    opened: s.opened + (changed && d.open ? 1 : 0),
    closed: s.closed + (changed && !d.open ? 1 : 0),
    reasons: d.reason === null ? s.reasons : { ...s.reasons, [d.reason]: s.reasons[d.reason] + 1 },
    maxTracks: Math.max(s.maxTracks, tracks.length),
  }
}

const round1 = (n: number) => Math.round(n / 100) / 10

/**
 * O diagnóstico do falantes.json (Emenda 24): só números, para a próxima call real dizer como o
 * Meet e o Teams mutam de verdade. Nunca áudio, nunca texto do usuário, nunca nome de dispositivo.
 * O último intervalo (até 250 ms, entre a última leitura e o fim da gravação) não entra.
 */
export function micGateDiagnostics(s: MicGateStats): NonNullable<SpeakerDiagnostics['microfone']> {
  return {
    leituras: s.readings,
    abriu: s.opened,
    fechou: s.closed,
    segundosAberto: round1(s.openMs),
    segundosFechado: round1(s.closedMs),
    faixasMax: s.maxTracks,
    motivos: {
      readyState: s.reasons.readyState,
      enabled: s.reasons.enabled,
      muted: s.reasons.muted,
      semSender: s.reasons['sem-sender'],
      semFaixa: s.reasons['sem-faixa'],
      desconhecido: s.reasons.desconhecido,
    },
  }
}
