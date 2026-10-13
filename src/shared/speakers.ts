// Linha do tempo dos falantes do lado do SW (Emenda 18). Funções puras, testadas com vitest.
//
// - applySpeakersBatch: o lote do MAIN world troca tudo a partir de `from` (o MAIN reenvia os
//   intervalos que ainda podem mudar e, no fim, a linha inteira).
// - speakersOutput: o falantes.json e o resumo do info.json, com os nomes resolvidos (as chaves
//   provisórias pelo `aliases` que chegou depois, ou "Participante N"; o próprio usuário com o
//   rótulo do idioma). Sem nenhum intervalo de participante, nada: só o microfone não diz quem
//   falou na call.
// - checkUnnamedSources (Emenda 20): a fonte sem nome que acompanha quem fala (quase nunca sozinha
//   e quase sempre junto de quem fala) não é uma pessoa e sai da linha do tempo, registrada em
//   `descartadas`. O helper aplica a mesma regra ao ler um falantes.json (host/transcricao.mjs).
import { MAX_SPEAKER_INTERVALS, MIXER_DELAY_MS, SPEAKER_KEY_PREFIX, SPEAKERS_FILE } from './constants'
import type { InfoSpeakers, SpeakerDiagnostics, SpeakerDropped, SpeakerInterval, SpeakerSource, SpeakersFile } from './protocol'

/** O que o SW guarda da sessão (IndexedDB). */
export interface SpeakerTimelineRecord {
  intervals: SpeakerInterval[]
  aliases: Record<string, string>
  /** Emenda 20: o último diagnóstico que a página mandou (o do lote final). */
  diagnostico?: SpeakerDiagnostics
}

/**
 * Aplica um lote. Um `from` além do que já está guardado (um lote se perdeu, o SW reiniciou) não
 * mexe nos intervalos: a linha inteira chega de novo no fim da gravação. O `aliases` vale sempre.
 */
export function applySpeakersBatch(
  cur: SpeakerTimelineRecord | null | undefined,
  batch: { from: number; intervals: readonly SpeakerInterval[]; aliases?: Record<string, string>; diagnostico?: SpeakerDiagnostics },
): { record: SpeakerTimelineRecord; applied: boolean } {
  const base: SpeakerTimelineRecord = cur
    ? { intervals: cur.intervals, aliases: { ...cur.aliases }, ...(cur.diagnostico ? { diagnostico: cur.diagnostico } : {}) }
    : { intervals: [], aliases: {} }
  if (batch.aliases) Object.assign(base.aliases, batch.aliases)
  if (batch.diagnostico) base.diagnostico = batch.diagnostico
  if (batch.from > base.intervals.length) return { record: base, applied: false }
  base.intervals = [...base.intervals.slice(0, batch.from), ...batch.intervals].slice(0, MAX_SPEAKER_INTERVALS)
  return { record: base, applied: true }
}

/**
 * Junta intervalos da mesma pessoa que se encostam ou se sobrepõem (até `gapMs`) e devolve em
 * ordem de início. Os do próprio usuário só se juntam entre si.
 */
export function mergeIntervals(list: readonly SpeakerInterval[], gapMs = 0): SpeakerInterval[] {
  const key = (i: SpeakerInterval) => (i.voce ? '\u0000voce' : `r:${i.nome}`)
  const sorted = [...list].sort((a, b) => a.de - b.de || a.ate - b.ate)
  const out: SpeakerInterval[] = []
  const lastOf = new Map<string, SpeakerInterval>()
  for (const i of sorted) {
    const prev = lastOf.get(key(i))
    if (prev && i.de - prev.ate <= gapMs) {
      prev.ate = Math.max(prev.ate, i.ate)
      continue
    }
    const copy = { ...i }
    out.push(copy)
    lastOf.set(key(i), copy)
  }
  return out
}

export interface SpeakerLabels {
  /** Nome do próprio usuário na linha do tempo ("Você", "You"). */
  you: string
  /** Quem a plataforma não nomeou: "Participante 1"... */
  unknown: (n: number) => string
  /** Texto da transcrição no lugar da sua fala, que não é gravada. */
  youNotRecorded: string
}

/**
 * Fonte sem nome que acompanha quem fala (Emenda 20). Medido numa daily real do Meet (13/10/2026,
 * 6 pessoas nomeadas): a fonte que nunca teve nome passou 98,7% do tempo dela junto de alguma pessoa
 * nomeada e esteve presente em 99,2% do tempo em que as nomeadas falavam; as pessoas de verdade,
 * medidas do mesmo jeito contra as outras, ficaram entre 0,4% e 15,4% de cobertura e entre 0,1% e
 * 3,1% de presença. As duas condições juntas separam o marcador (que só existe com alguém falando, e
 * quase sempre que alguém fala) de quem fala sozinho, de duas pessoas que às vezes falam juntas e de
 * quem só faz interjeições por cima dos outros (cobertura alta, presença baixa). A presença, e não
 * "acompanha 3 ou mais pessoas", porque 3 das 6 pessoas reais da mesma call já se sobrepuseram a 3
 * outras, e porque numa call de 2 ou 3 pessoas o marcador só tem 1 ou 2 para acompanhar.
 */
export const UNNAMED_SHADOW = Object.freeze({
  /** Do tempo ativo da fonte, pelo menos isto com alguma pessoa nomeada falando junto. */
  minCoveredPct: 85,
  /** Do tempo em que as pessoas nomeadas falam, pelo menos isto com a fonte ativa junto. */
  minPresencePct: 50,
})

interface Span {
  de: number
  ate: number
}

/** União de intervalos, em ordem e sem sobreposição. */
function unionOf(list: readonly Span[]): Span[] {
  const out: Span[] = []
  for (const i of [...list].sort((a, b) => a.de - b.de)) {
    const last = out[out.length - 1]
    if (last && i.de <= last.ate) last.ate = Math.max(last.ate, i.ate)
    else if (i.ate > i.de) out.push({ de: i.de, ate: i.ate })
  }
  return out
}

const spanMs = (u: readonly Span[]) => u.reduce((s, i) => s + (i.ate - i.de), 0)

/** Tempo em comum entre duas uniões (cada uma em ordem e sem sobreposição). */
function sharedMs(a: readonly Span[], b: readonly Span[]): number {
  let t = 0
  let j = 0
  for (const x of a) {
    while (j < b.length && b[j].ate <= x.de) j++
    for (let k = j; k < b.length && b[k].de < x.ate; k++) t += Math.min(x.ate, b[k].ate) - Math.max(x.de, b[k].de)
  }
  return t
}

const pct = (part: number, whole: number) => (whole > 0 ? (100 * part) / whole : 0)

/** A medida de uma fonte sem nome contra as pessoas nomeadas. */
export interface UnnamedCheck {
  key: string
  ms: number
  coveredPct: number
  presencePct: number
  /** Quantas pessoas nomeadas diferentes falaram em algum momento junto com ela. */
  personsCovered: number
  /** Acompanha quem fala (UNNAMED_SHADOW): não é uma pessoa. */
  shadow: boolean
}

/**
 * Mede cada fonte sem nome (`unnamed`) contra as fontes nomeadas, sem o próprio usuário (passe só os
 * intervalos de participantes). Pura e na ordem da primeira fala, para o teste e para o helper.
 */
export function checkUnnamedSources(remote: ReadonlyArray<{ key: string; unnamed: boolean; de: number; ate: number }>): UnnamedCheck[] {
  const namedByKey = new Map<string, Span[]>()
  const unnamedByKey = new Map<string, Span[]>()
  for (const i of [...remote].sort((a, b) => a.de - b.de)) {
    const m = i.unnamed ? unnamedByKey : namedByKey
    const list = m.get(i.key) ?? []
    list.push(i)
    m.set(i.key, list)
  }
  if (unnamedByKey.size === 0) return []
  const namedUnion = unionOf([...namedByKey.values()].flat())
  const namedTotal = spanMs(namedUnion)
  const persons = [...namedByKey.values()].map(unionOf)
  const out: UnnamedCheck[] = []
  for (const [key, list] of unnamedByKey) {
    const mine = unionOf(list)
    const ms = spanMs(mine)
    const together = sharedMs(mine, namedUnion)
    const coveredPct = pct(together, ms)
    const presencePct = pct(together, namedTotal)
    const personsCovered = persons.filter((p) => sharedMs(mine, p) > 0).length
    const shadow = ms > 0 && coveredPct >= UNNAMED_SHADOW.minCoveredPct && presencePct >= UNNAMED_SHADOW.minPresencePct
    out.push({ key, ms, coveredPct, presencePct, personsCovered, shadow })
  }
  return out
}

const round1 = (n: number) => Math.round(n * 10) / 10

/** O falantes.json e o resumo do info.json; null sem nenhum intervalo de participante. */
export function speakersOutput(rec: SpeakerTimelineRecord | null | undefined, labels: SpeakerLabels, audio = 'audio.webm'): { file: SpeakersFile; summary: InfoSpeakers } | null {
  if (!rec || !rec.intervals.some((i) => !i.voce)) return null
  const unresolved = (i: SpeakerInterval) => !i.voce && i.nome.startsWith(SPEAKER_KEY_PREFIX) && !rec.aliases[i.nome]
  // Emenda 20: a fonte sem nome que acompanha quem fala sai antes de numerar os "Participante N".
  const checks = checkUnnamedSources(
    rec.intervals.filter((i) => !i.voce).map((i) => ({ key: i.nome.startsWith(SPEAKER_KEY_PREFIX) ? rec.aliases[i.nome] || i.nome : i.nome, unnamed: unresolved(i), de: i.de, ate: i.ate })),
  )
  const shadows = new Set(checks.filter((c) => c.shadow).map((c) => c.key))
  const descartadas: SpeakerDropped[] = checks
    .filter((c) => c.shadow)
    .map((c) => ({
      chave: c.key.slice(SPEAKER_KEY_PREFIX.length),
      segundos: round1(c.ms / 1000),
      coberturaPct: round1(c.coveredPct),
      presencaPct: round1(c.presencePct),
      pessoasCobertas: c.personsCovered,
    }))
  const kept = rec.intervals.filter((i) => !(unresolved(i) && shadows.has(i.nome)))
  if (!kept.some((i) => !i.voce)) return null
  const unknownNo = new Map<string, number>()
  const unnamedLabels = new Set<string>()
  const resolve = (i: SpeakerInterval): string => {
    if (i.voce) return labels.you
    if (!i.nome.startsWith(SPEAKER_KEY_PREFIX)) return i.nome
    const alias = rec.aliases[i.nome]
    if (alias) return alias
    if (!unknownNo.has(i.nome)) unknownNo.set(i.nome, unknownNo.size + 1)
    const label = labels.unknown(unknownNo.get(i.nome)!)
    unnamedLabels.add(label)
    return label
  }
  const named = [...kept]
    .sort((a, b) => a.de - b.de)
    .map((i) => ({ ...i, nome: resolve(i) }))
  const intervalos = mergeIntervals(named)
  const totals = new Map<string, { nome: string; ms: number; voce: boolean }>()
  for (const i of intervalos) {
    const k = i.voce ? '\u0000voce' : i.nome
    const t = totals.get(k) ?? { nome: i.nome, ms: 0, voce: Boolean(i.voce) }
    t.ms += i.ate - i.de
    totals.set(k, t)
  }
  // `semNome` (Emenda 20): o rótulo é nosso ("Participante N"), não o nome que a plataforma deu.
  const pessoas = [...totals.values()].map((t) => ({
    nome: t.nome,
    segundos: Math.round(t.ms / 100) / 10,
    ...(t.voce ? { voce: true as const } : {}),
    ...(!t.voce && unnamedLabels.has(t.nome) ? { semNome: true as const } : {}),
  }))
  const fontes = [...new Set(intervalos.map((i) => i.fonte))] as SpeakerSource[]
  return {
    file: {
      versao: 1,
      audio,
      atrasoMs: MIXER_DELAY_MS,
      intervalos,
      pessoas,
      textos: { voceNaoGravada: labels.youNotRecorded },
      ...(descartadas.length ? { descartadas } : {}),
      ...(rec.diagnostico ? { diagnostico: rec.diagnostico } : {}),
    },
    summary: { arquivo: SPEAKERS_FILE, pessoas, fontes },
  }
}
