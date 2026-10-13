// Texto da transcrição: as funções puras que o helper (host/transcricao.mjs, Node sem build) e a
// extensão (service worker, TypeScript com Vite) usam IGUAIS (Emenda 21).
//
// Por que .mjs com um .d.mts ao lado, e não TypeScript: o helper roda em Node puro, sem build, a
// partir da cópia em bin/ que o host/instalar.mjs faz (por isso 'texto.mjs' está em HOST_FILES de
// host/args.mjs), e a extensão é TypeScript com Vite. Um arquivo .mjs ESM serve aos dois: o Node o
// importa direto e o Vite o inclui no bundle. Os tipos vêm de host/texto.d.mts, como o
// scripts/build-info.mjs faz com o vite.config.ts (o precedente do repositório). Nada aqui importa
// node:*, DOM nem chrome.*: é o que torna o arquivo compartilhável.
//
// O helper NÃO tem cópia destas funções: host/transcricao.mjs importa e reexporta este arquivo.

/** Objeto comum (nem null nem array). */
export const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v)

/** Texto de uma linha só (sem quebra de linha), para o .md e para os nomes. */
export const mdLine = (s) => String(s ?? '').replace(/[\r\n]+/g, ' ').trim()

/** `auto` ou um código ISO 639-1/639-2 em minúsculas (pt, en, es...). */
export const LANGUAGE_RE = /^(auto|[a-z]{2,3})$/

/** Rótulo de cada motor nas telas e no transcricao.md. */
export const ENGINE_LABELS = {
  'whisper-cpp': 'whisper.cpp (local)',
  'openai-api': 'OpenAI API',
}

/** Famílias de modelo em ordem de preferência (melhor primeiro; o tiny só se não houver outro). */
export const MODEL_PREFERENCE = ['large-v3-turbo', 'large-v3', 'large-v2', 'large-v1', 'large', 'medium', 'small', 'base', 'tiny']

/**
 * Posição de um arquivo de modelo na preferência (menor é melhor) ou null se não for um modelo
 * útil. Aceita as variantes quantizadas (ggml-small-q5_1.bin). Os modelos só de inglês (.en) só
 * contam com o idioma `en`, e ficam depois do multilíngue da mesma família.
 */
export function rankModel(fileName, idioma = 'auto') {
  const m = /^ggml-([a-z0-9-]+?)(\.en)?(-q\d(?:_\d)?)?\.bin$/i.exec(fileName)
  if (!m) return null
  const family = m[1].toLowerCase()
  const idx = MODEL_PREFERENCE.indexOf(family)
  if (idx < 0) return null
  const englishOnly = Boolean(m[2])
  if (englishOnly && idioma !== 'en') return null
  return idx * 4 + (englishOnly ? 2 : 0) + (m[3] ? 1 : 0)
}

/** A linha do stderr que explica a falha (o resto é o registro de carga do ggml e do Metal). */
export function errorLine(stderr) {
  const lines = String(stderr ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  const flagged = lines.filter((l) => /error|erro|failed|falh|invalid|not found|unable|cannot/i.test(l))
  return (flagged.at(-1) ?? lines.at(-1) ?? '').slice(0, 300)
}

// ---------------------------------------------------------------------------------------------
// Texto de saída
// ---------------------------------------------------------------------------------------------

/**
 * Texto de fala de um segmento, sem as marcas que o whisper escreve no lugar dela: [BLANK_AUDIO],
 * [Música], [Aplausos], ♪ e, quando são o segmento inteiro, (música), (risos) ou *música*. O
 * whisper.cpp escreve o silêncio de uma call como "[Música]" em português.
 */
export function speechText(raw) {
  const t = String(raw ?? '')
    .replace(/\[[^\]\n]{0,60}\]/g, ' ')
    .replace(/[♪♫]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (/^(?:\([^)\n]{0,60}\)\s*|\*[^*\n]{0,60}\*\s*)+$/.test(t)) return ''
  return /[\p{L}\p{N}]/u.test(t) ? t : ''
}

/** Segmentos { start, end, text } (segundos) do JSON do whisper-cli -oj, sem os vazios. */
export function segmentsFromWhisperJson(json) {
  const list = Array.isArray(json?.transcription) ? json.transcription : []
  const out = []
  for (const s of list) {
    const text = speechText(s?.text)
    if (!text) continue
    const from = Number(s?.offsets?.from)
    const to = Number(s?.offsets?.to)
    const start = Number.isFinite(from) ? from / 1000 : parseClock(s?.timestamps?.from)
    const end = Number.isFinite(to) ? to / 1000 : parseClock(s?.timestamps?.to)
    out.push({ start: Math.max(0, start), end: Math.max(start, end), text })
  }
  return out
}

/**
 * Pausas { start, end } (segundos) que o filtro silencedetect do ffmpeg escreveu no stderr. O
 * whisper.cpp põe o silêncio dentro do segmento anterior (os segmentos saem colados), então a
 * pausa entre dois parágrafos só aparece por aqui.
 */
export function silencesFromFfmpeg(stderr) {
  const out = []
  let open = null
  for (const line of String(stderr ?? '').split('\n')) {
    const a = /silence_start:\s*(-?[\d.]+)/.exec(line)
    if (a) open = Math.max(0, Number(a[1]))
    const b = /silence_end:\s*([\d.]+)/.exec(line)
    if (b && open !== null) {
      const end = Number(b[1])
      if (Number.isFinite(open) && Number.isFinite(end) && end > open) out.push({ start: open, end })
      open = null
    }
  }
  // Silêncio até o fim do áudio sem o silence_end (ffmpeg antigo).
  if (open !== null && Number.isFinite(open)) out.push({ start: open, end: Number.POSITIVE_INFINITY })
  return out
}

/** Abaixo disto de fala dentro do segmento (fora dos silêncios medidos), o segmento é invenção. */
const MIN_SPEECH_SEC = 0.3
/** Só frases curtas caem: as invenções do whisper no silêncio são curtas ("you", "Obrigado."). */
const MAX_INVENTED_WORDS = 6

/**
 * Tira os segmentos que o whisper inventou em cima de silêncio medido (alucinação conhecida dos
 * modelos Whisper: uma gravação muda vira "you" ou "Obrigado."). Cai só o segmento curto (até 6
 * palavras) com o meio dentro de um silêncio e menos de 0,3 s fora dele; sem as pausas medidas,
 * nada cai.
 */
export function dropInventedSegments(segments, pauses = []) {
  if (!pauses.length) return segments
  return segments.filter((s) => {
    const len = Math.max(0, s.end - s.start)
    const mid = s.start + len / 2
    if (!pauses.some((p) => p.start <= mid && mid <= p.end)) return true
    const covered = pauses.reduce((acc, p) => acc + Math.max(0, Math.min(s.end, p.end) - Math.max(s.start, p.start)), 0)
    const words = s.text.split(/\s+/).filter(Boolean).length
    return !(len - covered < MIN_SPEECH_SEC && words <= MAX_INVENTED_WORDS)
  })
}

/**
 * Repetição em laço do whisper (Emenda 20). Numa daily real, na borda de um silêncio longo (a fala
 * do próprio usuário, que não é gravada), o whisper repetiu a mesma frase em quatro segmentos
 * seguidos e esticou uma cópia de outra por cima do silêncio. Medido nessa call: 350 segmentos viram
 * 344, saem 24 palavras, todas das cópias (nenhuma outra palavra muda), em cerca de 1,5 ms. As
 * comparações ignoram maiúsculas, acentos e pontuação.
 */
export const REPEATS = Object.freeze({
  /** Dentro de um segmento: uma frase de 2 ou mais palavras repetida tantas vezes seguidas fica uma. */
  minPhraseCopies: 3,
  /** Dentro de um segmento: uma palavra repetida tantas vezes seguidas fica uma. */
  minWordCopies: 4,
  /** Uma frase igual a um destes últimos segmentos mantidos... */
  window: 3,
  /** ...começando até tanto depois do fim dele, sai (o laço "A / B / C / A / A / A"). */
  windowSec: 10,
  /** Com menos palavras que isto ("Tchau", "Bom dia"), a frase repetida pode ser de duas pessoas. */
  minWindowWords: 3,
})

const normText = (t) =>
  String(t)
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()

/** Tira a repetição em laço de dentro de um segmento (o período mais curto primeiro). */
export function collapseInside(text, o = REPEATS) {
  const tok = String(text).split(/\s+/).filter(Boolean)
  const nt = tok.map(normText)
  const out = []
  let i = 0
  while (i < tok.length) {
    let done = false
    for (let k = 1; k <= Math.min(12, Math.floor((tok.length - i) / 2)) && !done; k++) {
      const need = k === 1 ? o.minWordCopies : o.minPhraseCopies
      if (i + need * k > tok.length) continue
      const key = nt.slice(i, i + k).join(' ')
      if (!key.trim()) continue
      let c = 1
      while (i + (c + 1) * k <= tok.length && nt.slice(i + c * k, i + (c + 1) * k).join(' ') === key) c++
      if (c >= need) {
        out.push(...tok.slice(i, i + k))
        i += c * k
        done = true
      }
    }
    if (!done) out.push(tok[i++])
  }
  return out.join(' ')
}

/** Segundos de um segmento fora dos silêncios medidos. */
function speechSec(s, pauses) {
  const len = Math.max(0, s.end - s.start)
  const covered = pauses.reduce((a, p) => a + Math.max(0, Math.min(s.end, p.end) - Math.max(s.start, p.start)), 0)
  return Math.max(0, len - covered)
}

/**
 * Colapsa a repetição em laço do whisper (Emenda 20, REPEATS):
 * 1. dentro de um segmento, a frase repetida 3 ou mais vezes (ou a palavra 4 ou mais) fica uma;
 * 2. um segmento com o mesmo texto do anterior mantido fica um só, o que tem mais fala fora dos
 *    silêncios medidos (empate: o primeiro); com 1 ou 2 palavras, só quando uma das cópias está mais
 *    da metade em silêncio (senão podem ser duas pessoas dizendo "Tchau");
 * 3. um segmento de 3 ou mais palavras igual a um dos 3 anteriores mantidos, começando até 10 s
 *    depois do fim dele, sai.
 */
export function collapseRepeats(segments, pauses = [], o = REPEATS) {
  const kept = []
  for (const seg of segments) {
    const s = { ...seg, text: collapseInside(seg.text, o) }
    const n = normText(s.text)
    const words = n ? n.split(' ').length : 0
    const last = kept[kept.length - 1]
    if (last && n && normText(last.text) === n) {
      const silentShare = (x) => 1 - speechSec(x, pauses) / Math.max(1e-6, x.end - x.start)
      if (words >= o.minWindowWords || Math.max(silentShare(s), silentShare(last)) > 0.5) {
        if (speechSec(s, pauses) > speechSec(last, pauses) + 1e-6) kept[kept.length - 1] = s
        continue
      }
    }
    if (words >= o.minWindowWords && kept.slice(-o.window).some((r) => normText(r.text) === n && s.start - r.end <= o.windowSec)) continue
    kept.push(s)
  }
  return kept
}

/** Até tanto de distância, um vizinho conta para a herança do falante. */
export const NEIGHBOR_GAP_SEC = 1

/**
 * Um segmento sem falante (cai num buraco curto da linha do tempo) herda o falante só quando o
 * segmento de antes e o de depois, a até 1 s, têm o mesmo (Emenda 20). O "mais próximo" errou o
 * único caso real medido: deu a quem tinha 0,25 s ali, e a frase era de quem falava antes e depois.
 */
export function fillSpeakerGaps(segments) {
  return segments.map((s, i) => {
    if (s.speaker) return s
    const prev = segments[i - 1]
    const next = segments[i + 1]
    if (!prev?.speaker || prev.speaker !== next?.speaker) return s
    if (s.start - prev.end > NEIGHBOR_GAP_SEC || next.start - s.end > NEIGHBOR_GAP_SEC) return s
    return { ...s, speaker: prev.speaker }
  })
}

function parseClock(s) {
  const m = /^(\d+):(\d{2}):(\d{2})[,.](\d{3})$/.exec(String(s ?? ''))
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000 : 0
}

/** Regras de parágrafo: o whisper corta a fala em pedaços de poucos segundos. */
export const PARAGRAPH = Object.freeze({
  /** Pausa maior que isto começa um parágrafo novo. */
  maxGapSec: 2,
  /** Passou disto e a frase terminou: parágrafo novo. */
  softChars: 300,
  /** Passou disto: parágrafo novo de qualquer jeito. */
  hardChars: 700,
})

/**
 * Houve uma pausa longa entre o segmento `last` e o seguinte `next`? O whisper estica o segmento
 * por cima do silêncio e o seguinte começa onde a fala volta, então uma pausa medida pelo ffmpeg
 * conta para esta fronteira quando termina perto do fim de `last` (até 1 s antes) e começa antes
 * de `next`. Um silêncio no começo ou no meio de um segmento, com fala depois dele no mesmo
 * segmento, não quebra o parágrafo.
 */
export function pausedBetween(last, next, pauses, rules) {
  if (next.start - last.end > rules.maxGapSec) return true
  return pauses.some((p) => p.end - p.start >= rules.maxGapSec && p.end >= last.end - 1 && p.start < next.start + 0.5)
}

/**
 * Junta segmentos seguidos em parágrafos legíveis (cada um com o tempo do primeiro). `pauses`:
 * silêncios medidos no áudio (silencesFromFfmpeg), que também começam um parágrafo novo. Com os
 * falantes (Emenda 18, `speaker` em cada segmento), a troca de falante também começa outro.
 */
export function mergeSegments(segments, rules = PARAGRAPH, pauses = []) {
  const paragraphs = []
  let cur = null
  let last = null
  for (const s of segments) {
    if (cur) {
      const ended = /[.!?…]["')\]]?$/.test(cur.text)
      const tooLong = cur.text.length >= rules.hardChars || (cur.text.length >= rules.softChars && ended)
      if (!pausedBetween(last, s, pauses, rules) && !tooLong && (s.speaker ?? null) === (cur.speaker ?? null)) {
        cur.text = `${cur.text} ${s.text}`
        cur.end = Math.max(cur.end, s.end)
        last = s
        continue
      }
      paragraphs.push(cur)
    }
    cur = { start: s.start, end: s.end, text: s.text, ...(s.speaker ? { speaker: s.speaker } : {}) }
    last = s
  }
  if (cur) paragraphs.push(cur)
  return paragraphs
}

const pad = (n, w = 2) => String(Math.floor(n)).padStart(w, '0')

/** [mm:ss] ou, em call de uma hora ou mais, [h:mm:ss]. */
export function formatClock(sec, long = false) {
  const t = Math.max(0, Math.floor(sec))
  const h = Math.floor(t / 3600)
  const m = Math.floor((t % 3600) / 60)
  const s = t % 60
  return long ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m + h * 60)}:${pad(s)}`
}

/** 00:01:02,345 (formato do SRT). */
export function formatSrtTime(sec) {
  const ms = Math.max(0, Math.round(sec * 1000))
  return `${pad(ms / 3600000)}:${pad((ms % 3600000) / 60000)}:${pad((ms % 60000) / 1000)},${pad(ms % 1000, 3)}`
}

export function buildSrt(segments) {
  return segments.map((s, i) => `${i + 1}\n${formatSrtTime(s.start)} --> ${formatSrtTime(s.end)}\n${s.speaker ? `${srtName(s.speaker)}: ` : ''}${s.text}\n`).join('\n')
}

// ---------------------------------------------------------------------------------------------
// Falantes (Emenda 18): a extensão escreve a linha do tempo em falantes.json, em ms desde o começo
// do áudio da página (já com o atraso do mixer). Cada segmento do whisper fica com o participante
// de maior sobreposição; o próprio usuário nunca recebe um segmento (a voz dele não é gravada).
// ---------------------------------------------------------------------------------------------

export const SPEAKERS_FILE = 'falantes.json'
const DEFAULT_SELF_NOT_RECORDED = '(sua fala não é gravada)'
/** Fala do próprio usuário mais curta que isto não vira linha (tosse, ruído). */
export const MIN_SELF_LINE_SEC = 1
/** A fala dele vira linha quando os segmentos da call cobrem menos que esta fração dela. */
export const SELF_MAX_COVERED = 0.5

/**
 * Nome de quem falou como texto de uma linha só: sem caracteres de controle, separadores de linha
 * e de parágrafo do Unicode nem marcas de direção do texto (que quebram ou embaralham a linha), com
 * os espaços colapsados. O nome vem da página da call: qualquer participante escolhe o dele.
 */
export function cleanSpeakerName(s) {
  return String(s ?? '')
    .replace(/[\p{Cc}\p{Zl}\p{Zp}\u200e\u200f\u202a-\u202e\u2066-\u2069]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300)
}

/** No .md, o nome é texto: os sinais de markdown e de HTML ganham a barra invertida. */
export const mdName = (s) => s.replace(/[\\`*_[\]<>~&]/g, '\\$&')

/** No .srt, os players leem <i>, <font> e {\an8}: esses sinais viram parecidos que não são marcação. */
export const srtName = (s) => s.replace(/</g, '\u2039').replace(/>/g, '\u203a').replace(/\{/g, '(').replace(/\}/g, ')')

/**
 * Fonte sem nome que acompanha quem fala (Emenda 20): a mesma regra e os mesmos limiares do
 * `UNNAMED_SHADOW` da extensão (src/shared/speakers.ts, onde estão as medidas que os justificam).
 * Do tempo ativo dela, pelo menos 85% com alguma pessoa nomeada falando junto; e, do tempo em que as
 * nomeadas falam, pelo menos 50% com ela ativa junto. Não é uma pessoa: numa daily real do Meet, o
 * marcador de quem está mais alto (CSRC 42) virou "Participante 1" e levou 330 de 350 trechos.
 */
export const UNNAMED_SHADOW = Object.freeze({ minCoveredPct: 85, minPresencePct: 50 })

/** Rótulo que a extensão dá a quem a plataforma não nomeou (falantes.json de antes da 0.4.2, sem `semNome`). */
const UNKNOWN_LABEL_RE = /^(?:Participante|Participant) \d+$/

function unionOf(list) {
  const out = []
  for (const i of [...list].sort((a, b) => a.start - b.start)) {
    const last = out[out.length - 1]
    if (last && i.start <= last.end) last.end = Math.max(last.end, i.end)
    else if (i.end > i.start) out.push({ start: i.start, end: i.end })
  }
  return out
}

const spanSec = (u) => u.reduce((s, i) => s + (i.end - i.start), 0)

function sharedSec(a, b) {
  let t = 0
  let j = 0
  for (const x of a) {
    while (j < b.length && b[j].end <= x.start) j++
    for (let k = j; k < b.length && b[k].start < x.end; k++) t += Math.min(x.end, b[k].end) - Math.max(x.start, b[k].start)
  }
  return t
}

/**
 * Mede cada nome de `unnamed` contra os outros participantes (intervalos em segundos, sem o próprio
 * usuário). Devolve, na ordem da primeira fala, { nome, segundos, coberturaPct, presencaPct,
 * pessoasCobertas, sombra }.
 */
export function checkUnnamedSources(remote, unnamed) {
  const named = new Map()
  const loose = new Map()
  for (const i of [...remote].sort((a, b) => a.start - b.start)) {
    const m = unnamed.has(i.nome) ? loose : named
    if (!m.has(i.nome)) m.set(i.nome, [])
    m.get(i.nome).push(i)
  }
  if (loose.size === 0) return []
  const namedUnion = unionOf([...named.values()].flat())
  const namedTotal = spanSec(namedUnion)
  const persons = [...named.values()].map(unionOf)
  const out = []
  for (const [nome, list] of loose) {
    const mine = unionOf(list)
    const sec = spanSec(mine)
    const together = sharedSec(mine, namedUnion)
    const coberturaPct = sec > 0 ? (100 * together) / sec : 0
    const presencaPct = namedTotal > 0 ? (100 * together) / namedTotal : 0
    const pessoasCobertas = persons.filter((p) => sharedSec(mine, p) > 0).length
    const sombra = sec > 0 && coberturaPct >= UNNAMED_SHADOW.minCoveredPct && presencaPct >= UNNAMED_SHADOW.minPresencePct
    out.push({ nome, segundos: sec, coberturaPct, presencaPct, pessoasCobertas, sombra })
  }
  return out
}

/**
 * Linha do tempo de falantes.json para um áudio (segundos); null sem o arquivo, de outro áudio, ou
 * sem nenhum intervalo de participante (aí a transcrição sai como antes). Uma fonte sem nome que
 * acompanha quem fala sai (Emenda 20) e vai em `descartadas`, para o log: uma gravação de antes da
 * 0.4.2, transcrita de novo, sai com os nomes certos.
 */
export function speakerTimelineFrom(file, audio) {
  if (!isObj(file) || file.versao !== 1 || !Array.isArray(file.intervalos)) return null
  if (typeof file.audio === 'string' && file.audio !== audio) return null
  const ok = (i) => isObj(i) && typeof i.nome === 'string' && Number.isFinite(i.de) && Number.isFinite(i.ate) && i.ate >= i.de
  const all = file.intervalos.filter(ok).map((i) => ({ nome: cleanSpeakerName(i.nome), start: i.de / 1000, end: i.ate / 1000, voce: i.voce === true }))
  let remote = all.filter((i) => !i.voce && i.nome)
  // Sem nome: o que a extensão marcou com `semNome` (0.4.2 em diante) ou o rótulo "Participante N".
  const marked = Array.isArray(file.pessoas) ? file.pessoas.filter((p) => isObj(p) && p.semNome === true && typeof p.nome === 'string').map((p) => cleanSpeakerName(p.nome)) : []
  const unnamed = new Set([...marked, ...remote.map((i) => i.nome).filter((n) => UNKNOWN_LABEL_RE.test(n))])
  const descartadas = checkUnnamedSources(remote, unnamed).filter((c) => c.sombra)
  if (descartadas.length) {
    const out = new Set(descartadas.map((c) => c.nome))
    remote = remote.filter((i) => !out.has(i.nome))
  }
  if (remote.length === 0) return null
  const naoGravada = typeof file.textos?.voceNaoGravada === 'string' && file.textos.voceNaoGravada.trim() ? mdLine(file.textos.voceNaoGravada) : DEFAULT_SELF_NOT_RECORDED
  return { remote, self: all.filter((i) => i.voce && i.nome), naoGravada, descartadas }
}

const overlap = (a, b) => Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start))

/**
 * Cada segmento com o participante de maior sobreposição (`speaker`). Empate: o de intervalo mais
 * longo; depois, o que começou antes. Sem sobreposição: sem nome. Nunca o próprio usuário.
 */
export function assignSpeakers(segments, timeline) {
  if (!timeline) return segments
  return segments.map((s) => {
    const by = new Map()
    for (const i of timeline.remote) {
      const o = overlap(s, i)
      if (o <= 0) continue
      const cur = by.get(i.nome) ?? { nome: i.nome, o: 0, len: 0, first: i.start }
      cur.o += o
      cur.len += i.end - i.start
      cur.first = Math.min(cur.first, i.start)
      by.set(i.nome, cur)
    }
    let best = null
    for (const c of by.values()) {
      if (!best) best = c
      else if (c.o > best.o + 1e-6) best = c
      else if (Math.abs(c.o - best.o) <= 1e-6 && (c.len > best.len + 1e-6 || (Math.abs(c.len - best.len) <= 1e-6 && c.first < best.first))) best = c
    }
    return best ? { ...s, speaker: best.nome } : { ...s }
  })
}

/**
 * Onde o próprio usuário falou e a gravação não tem fala da call (a dele nunca é gravada): uma linha
 * para a conversa manter a ordem. Intervalos curtos não contam; um intervalo coberto pelos
 * segmentos da call em SELF_MAX_COVERED ou mais também não.
 */
export function selfLines(timeline, segments) {
  if (!timeline) return []
  const out = []
  for (const i of timeline.self) {
    const len = i.end - i.start
    if (len < MIN_SELF_LINE_SEC) continue
    let covered = 0
    for (const s of segments) covered += overlap(s, i)
    if (covered / len < SELF_MAX_COVERED) out.push({ start: i.start, end: i.end, speaker: i.nome, text: timeline.naoGravada, self: true })
  }
  return out.sort((a, b) => a.start - b.start)
}

/**
 * Rótulos do cabeçalho do transcricao.md em cada idioma da interface (Emenda 19), pelo
 * `idiomaInterface` que a extensão grava no info.json. Sem o campo (info.json de antes da 0.4.1) ou
 * com um valor desconhecido, português, como sempre foi. Os nomes da plataforma, do motor e o
 * conteúdo (título, participantes, perfil, a fala) não mudam.
 */
export const MARKDOWN_LABELS = Object.freeze({
  'pt-BR': Object.freeze({
    untitled: 'Sem título',
    platform: 'Plataforma',
    date: 'Data',
    duration: 'Duração',
    participants: 'Participantes',
    nobody: 'não identificados',
    profile: 'Perfil',
    audio: 'Áudio',
    tabMode: 'modo aba',
    transcription: 'Transcrição',
    model: 'modelo',
    language: 'idioma',
    noSpeech: 'Nenhuma fala reconhecida na gravação.',
    unknown: 'desconhecida',
    otherSite: 'Outro site',
  }),
  en: Object.freeze({
    untitled: 'Untitled',
    platform: 'Platform',
    date: 'Date',
    duration: 'Duration',
    participants: 'Participants',
    nobody: 'not identified',
    profile: 'Profile',
    audio: 'Audio',
    tabMode: 'tab mode',
    transcription: 'Transcription',
    model: 'model',
    language: 'language',
    noSpeech: 'No speech recognized in the recording.',
    unknown: 'unknown',
    otherSite: 'Other site',
  }),
})

/** O idioma do cabeçalho para um info.json: o `idiomaInterface` conhecido, senão pt-BR. */
export function markdownLanguage(info) {
  const lang = info?.idiomaInterface
  return typeof lang === 'string' && Object.hasOwn(MARKDOWN_LABELS, lang) ? lang : 'pt-BR'
}

const PLATFORM_NAMES = { meet: 'Google Meet', teams: 'Microsoft Teams' }

export function platformLabel(platform, labels) {
  if (platform === 'outro') return labels.otherSite
  return typeof platform === 'string' && Object.hasOwn(PLATFORM_NAMES, platform) ? PLATFORM_NAMES[platform] : labels.unknown
}

/** "1 h 02 min", "32 min 05 s", "45 s". */
export function formatDuration(totalSec) {
  const t = Math.max(0, Math.round(Number(totalSec) || 0))
  const h = Math.floor(t / 3600)
  const m = Math.floor((t % 3600) / 60)
  const s = t % 60
  if (h > 0) return `${h} h ${pad(m)} min`
  if (m > 0) return `${m} min ${pad(s)} s`
  return `${s} s`
}

const MONTHS_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * Data e hora locais da call, tiradas do ISO com fuso do info.json (o horário que a pessoa viu, sem
 * depender do fuso de quem transcreve): "06/10/2026 14:30"; em inglês (Emenda 19), como o popup
 * mostra as datas: "Oct 6, 2026, 2:30 PM".
 */
export function formatLocalStart(iso, lang = 'pt-BR') {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(iso ?? ''))
  if (!m) return MARKDOWN_LABELS[markdownLanguage({ idiomaInterface: lang })].unknown
  if (lang !== 'en') return `${m[3]}/${m[2]}/${m[1]} ${m[4]}:${m[5]}`
  const h = Number(m[4])
  return `${MONTHS_EN[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}, ${h % 12 || 12}:${m[5]} ${h < 12 ? 'AM' : 'PM'}`
}

/**
 * transcricao.md: cabeçalho com os dados da call e a fala em parágrafos com o tempo. O cabeçalho
 * sai no idioma da interface gravado no info.json (Emenda 19; sem ele, em português).
 */
export function buildMarkdown({ info = {}, segments, language, motor, model, audio = 'audio.webm', pauses = [], speakers = null }) {
  const lang = markdownLanguage(info)
  const L = MARKDOWN_LABELS[lang]
  const paragraphs = mergeSegments(segments, PARAGRAPH, pauses)
  // Emenda 18: as linhas da sua fala entram na ordem do tempo, entre os parágrafos da call.
  const own = selfLines(speakers, segments)
  const lastEnd = segments.length ? segments[segments.length - 1].end : 0
  const long = Math.max(Number(info.duracaoSegundos) || 0, lastEnd) >= 3600
  const participantes = Array.isArray(info.participantes) ? info.participantes.map(mdLine).filter(Boolean) : []
  const lines = [
    `# ${mdLine(info.titulo) || L.untitled}`,
    '',
    `- **${L.platform}:** ${platformLabel(info.plataforma, L)}`,
    `- **${L.date}:** ${formatLocalStart(info.inicio, lang)}`,
    `- **${L.duration}:** ${formatDuration(info.duracaoSegundos)}`,
    `- **${L.participants}:** ${participantes.length ? participantes.join(', ') : L.nobody}`,
  ]
  if (info.perfil) lines.push(`- **${L.profile}:** ${mdLine(info.perfil)}`)
  // Pasta com mais de um áudio (o modo aba entrou na pasta da página): diz de qual é esta.
  if (audio !== 'audio.webm') lines.push(`- **${L.audio}:** ${mdLine(audio)}${/aba/i.test(audio) ? ` (${L.tabMode})` : ''}`)
  lines.push(`- **${L.transcription}:** ${ENGINE_LABELS[motor] ?? motor}${model ? `, ${L.model} ${model}` : ''}${language ? `, ${L.language} ${language}` : ''}`)
  lines.push('', '---', '')
  if (paragraphs.length === 0) lines.push(`_${L.noSpeech}_`, '')
  // Os parágrafos ficam na ordem de sempre (a de antes, mesmo com segmentos fora de ordem); cada
  // linha sua entra antes do primeiro parágrafo que começa depois dela.
  const entries = []
  let k = 0
  for (const p of paragraphs) {
    while (k < own.length && own[k].start < p.start) entries.push(own[k++])
    entries.push(p)
  }
  entries.push(...own.slice(k))
  for (const p of entries) lines.push(`[${formatClock(p.start, long)}] ${p.speaker ? `${mdName(p.speaker)}: ` : ''}${p.text}`, '')
  return lines.join('\n')
}

// ---------------------------------------------------------------------------------------------
// Estado da transcrição no info.json (as partes que não tocam o disco)
// ---------------------------------------------------------------------------------------------

/**
 * Estado da transcrição de cada áudio da pasta, por nome do arquivo: `transcricoes` do info.json,
 * mais o `transcricao` de uma pasta de antes de haver mais de um áudio transcrito.
 */
export function transcriptionsOf(info) {
  const all = isObj(info?.transcricoes) ? { ...info.transcricoes } : {}
  const t = info?.transcricao
  if (isObj(t) && typeof t.audio === 'string' && !isObj(all[t.audio])) all[t.audio] = t
  return all
}

/**
 * Um pendente ou transcrevendo sem trabalho na fila há mais que isto não é o instante entre
 * marcar o info.json e gravar o trabalho: o trabalho se perdeu (erro de disco no worker).
 */
export const ORPHAN_GRACE_MS = 10_000

/**
 * O estado que a tela deve mostrar: um pendente ou transcrevendo cujo trabalho não está mais na
 * fila vira falhou (senão o popup diria "Na fila" para sempre). `queued`: há trabalho para este
 * áudio; `ageMs`: idade do info.json.
 */
export function reconcileTranscription(t, { queued, ageMs }) {
  if (!isObj(t)) return t ?? null
  if ((t.status === 'pendente' || t.status === 'transcrevendo') && !queued && ageMs > ORPHAN_GRACE_MS) {
    return { ...t, status: 'falhou', erro: 'a transcrição saiu da fila sem terminar (veja o log do helper)' }
  }
  return t
}

/**
 * Nome (sem extensão) dos arquivos da transcrição de um áudio: audio.webm vira transcricao,
 * audio-aba.webm vira transcricao-aba, "audio-aba (2).webm" vira transcricao-aba-2.
 */
export function transcriptStem(audio) {
  const stem = String(audio).replace(/\.webm$/i, '')
  const suffix = stem
    .slice('audio'.length)
    .replace(/[^\w.-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/-$/, '')
  return `transcricao${suffix}`
}
