// Linha do tempo dos falantes (Emenda 18). Funções puras, testadas com vitest.
//
// O controlador da sessão amostra o adaptador (quem fala agora) e o microfone (se você fala) a
// cada 250 ms, no relógio resistente, e entrega cada leitura aqui. O construtor abre um intervalo
// na primeira leitura em que a pessoa aparece e só fecha depois de CLOSE_AFTER_MS sem ela: as
// pausas curtas entre frases não quebram a fala (é esta histerese que junta quem volta logo). A
// junção final, depois dos nomes resolvidos, é do SW (src/shared/speakers.ts, mergeIntervals).
//
// Tempo: os sinais são ao vivo e o áudio gravado sai MIXER_DELAY_MS depois (a linha de atraso do
// mixer). Uma leitura no instante `agora` (relógio da página) vale, no áudio, em
// `agora - inicioDaGravacao + atraso` (toRecordingMs). Assim os intervalos ficam no mesmo relógio
// dos segmentos do whisper.
//
// Envio: `batch()` devolve os intervalos que ainda podem mudar, a partir do primeiro aberto
// (`from`); o SW troca tudo de `from` em diante. Um intervalo fechado não muda mais. Um intervalo
// aberto há MAX_OPEN_MS (sinal preso, monólogo) é cortado em dois que se encostam (o SW junta de
// novo): sem isso, cada lote reenviaria tudo desde ele.
import type { SpeakerInterval, SpeakerSource } from '../../shared/protocol'

/** Sem a pessoa por tanto tempo, a fala dela acabou (histerese parecida com a do attendee). */
export const CLOSE_AFTER_MS = 1000
/** Intervalo aberto há tanto tempo é cortado (o lote fica pequeno; o SW junta os pedaços). */
export const MAX_OPEN_MS = 30_000
/** Período da amostragem (o laço de 250 ms da arbitragem). */
export const SAMPLE_MS = 250

/** O que o adaptador leu agora: quem fala e por qual sinal. */
export interface SpeakerReading {
  nomes: readonly string[]
  fonte: SpeakerSource
}

/** Converte um instante da página (ms) para o tempo do áudio gravado (ms desde o começo dele). */
export function toRecordingMs(nowMs: number, startedAtMs: number, delayMs: number): number {
  return Math.max(0, Math.round(nowMs - startedAtMs + delayMs))
}

interface Open {
  index: number
  /** Última leitura (tempo da gravação) em que a pessoa apareceu. */
  lastSeen: number
}

export interface TimelineOptions {
  startedAt: number
  delayMs: number
  closeAfterMs?: number
  maxOpenMs?: number
  sampleMs?: number
  maxIntervals?: number
}

export interface Timeline {
  /** Leitura dos participantes (null: o adaptador não sabe dizer agora, vale como ninguém). */
  sample(now: number, reading: SpeakerReading | null): void
  /** Leitura do próprio usuário (o microfone tem fala agora?). */
  sampleSelf(now: number, speaking: boolean): void
  /**
   * Fecha tudo o que está aberto (fim da gravação). Com `audioEndMs` (tempo da gravação em que o
   * áudio acabou, no pagehide), nada passa dele: o que começou depois sai e o resto é cortado ali.
   */
  closeAll(now: number, audioEndMs?: number): void
  /** Intervalos que ainda podem mudar, a partir de `from`; null se nada mudou desde o último. */
  batch(now: number): { from: number; intervals: SpeakerInterval[] } | null
  /** Todos os intervalos (cópia). */
  all(now: number): SpeakerInterval[]
  readonly size: number
}

const SELF_KEY = '\u0000voce'

export function createTimeline(opts: TimelineOptions): Timeline {
  const closeAfter = opts.closeAfterMs ?? CLOSE_AFTER_MS
  const maxOpen = opts.maxOpenMs ?? MAX_OPEN_MS
  const sampleMs = opts.sampleMs ?? SAMPLE_MS
  const max = opts.maxIntervals ?? Infinity
  // Em ordem de início: cada intervalo novo começa na leitura de agora, e o tempo só anda.
  const list: SpeakerInterval[] = []
  /** Quem está falando agora, por chave (nome, ou SELF_KEY). */
  const open = new Map<string, Open>()
  /** Primeiro índice que pode mudar no próximo lote (o que veio antes já foi e não muda). */
  let sentFrom = 0
  let dirty = false

  const at = (now: number) => toRecordingMs(now, opts.startedAt, opts.delayMs)

  const close = (key: string, o: Open) => {
    const i = list[o.index]
    i.ate = Math.max(i.de, o.lastSeen + sampleMs)
    open.delete(key)
    dirty = true
  }

  const see = (key: string, t: number, make: () => SpeakerInterval) => {
    const o = open.get(key)
    if (o) {
      const cur = list[o.index]
      cur.ate = Math.max(cur.ate, t + sampleMs)
      o.lastSeen = t
      dirty = true
      // Aberto há muito tempo: fecha em t e continua num pedaço novo que encosta nele.
      if (t - cur.de >= maxOpen && list.length < max) {
        cur.ate = Math.max(cur.de, t)
        list.push({ ...cur, de: t, ate: t + sampleMs })
        o.index = list.length - 1
      }
      return
    }
    if (list.length >= max) return
    list.push({ ...make(), de: t, ate: t + sampleMs })
    open.set(key, { index: list.length - 1, lastSeen: t })
    dirty = true
  }

  const expire = (t: number, present: (key: string) => boolean, remote: boolean) => {
    for (const [key, o] of [...open]) {
      if ((key === SELF_KEY) === remote) continue
      if (present(key)) continue
      if (t - o.lastSeen >= closeAfter) close(key, o)
    }
  }

  /** Primeiro índice que ainda pode mudar: o primeiro aberto. */
  const firstMutable = (): number => {
    let first = list.length
    for (const o of open.values()) first = Math.min(first, o.index)
    return first
  }

  return {
    get size() {
      return list.length
    },
    sample(now, reading) {
      const t = at(now)
      const names = new Set((reading?.nomes ?? []).map((n) => n.trim()).filter(Boolean))
      for (const nome of names) see(`r:${nome}`, t, () => ({ nome, de: t, ate: t, fonte: reading!.fonte }))
      expire(t, (key) => names.has(key.slice(2)), true)
    },
    sampleSelf(now, speaking) {
      const t = at(now)
      if (speaking) see(SELF_KEY, t, () => ({ nome: '', de: t, ate: t, fonte: 'microfone', voce: true }))
      expire(t, () => speaking, false)
    },
    closeAll(now, audioEndMs) {
      const t = at(now)
      for (const [key, o] of [...open]) {
        o.lastSeen = Math.min(o.lastSeen, t)
        close(key, o)
      }
      if (audioEndMs === undefined) return
      const end = Math.max(0, Math.round(audioEndMs))
      // Começou no fim do áudio ou depois: não está na gravação.
      while (list.length > 0 && list[list.length - 1].de >= end) list.pop()
      sentFrom = Math.min(sentFrom, list.length)
      list.forEach((i, idx) => {
        if (i.ate <= end) return
        i.ate = end
        sentFrom = Math.min(sentFrom, idx)
      })
      dirty = true
    },
    batch() {
      if (!dirty) return null
      const from = Math.min(sentFrom, list.length)
      const intervals = list.slice(from).map((i) => ({ ...i }))
      sentFrom = firstMutable()
      dirty = false
      return { from, intervals }
    },
    all() {
      return list.map((i) => ({ ...i }))
    },
  }
}
