// Quem está no áudio agora pelo CSRC dos receptores (Emenda 18). Classe pura, testada com vitest.
//
// Cada pacote RTP do servidor de mídia (o SFU do Meet, o mix do Teams) leva no CSRC o id de quem
// está no áudio. RTCRtpReceiver.getContributingSources() guarda cada entrada por 10 s depois do
// último pacote, então presença na lista não é fala: conta como ativo o CSRC cujo `timestamp` ou
// `rtpTimestamp` mudou desde a leitura anterior (a própria extensão lê, no relógio resistente; não
// depende de o Meet ou o Teams chamarem). Na primeira vez que aparece, só vale se o carimbo for
// recente. O carimbo é de época no Chrome; um carimbo no relógio do performance.now() (outro
// navegador, outra versão) é convertido com o timeOrigin, como o toEpochMs do vexa. Com o nível de
// áudio na entrada (extensão de cabeçalho), abaixo de MIN_LEVEL não conta (o attendee usa 0,01).
import type { ContributingSource } from '../capture/registry'

export const MIN_LEVEL = 0.01
/** Primeira leitura de um CSRC: o carimbo precisa ser deste tanto para cá. */
export const FRESH_MS = 1000
/** Depois da última leitura com alguma entrada, o caminho do CSRC ainda conta como vivo. */
export const ALIVE_MS = 12_000
const DAY_MS = 86_400_000

/** Carimbo do CSRC em ms de época. */
export function toEpochMs(timestamp: number, nowEpoch: number, timeOrigin: number): number {
  if (Math.abs(nowEpoch - timestamp) < DAY_MS) return timestamp
  const viaOrigin = timestamp + timeOrigin
  return Math.abs(nowEpoch - viaOrigin) < DAY_MS ? viaOrigin : timestamp
}

export class CsrcTracker {
  private prev = new Map<number, { ts: number; rtp: number | undefined }>()
  /** Última leitura (época) com alguma entrada; null se nunca. */
  lastSeenAt: number | null = null

  constructor(private readonly timeOrigin = 0) {}

  /** CSRCs ativos nesta leitura. */
  active(entries: readonly ContributingSource[], nowEpoch: number): number[] {
    const out: number[] = []
    const next = new Map<number, { ts: number; rtp: number | undefined }>()
    for (const e of entries) {
      if (!Number.isFinite(e.source) || !Number.isFinite(e.timestamp)) continue
      // A mesma fonte em dois receptores: fica o carimbo mais novo.
      const cur = next.get(e.source)
      if (cur && cur.ts >= e.timestamp) continue
      next.set(e.source, { ts: e.timestamp, rtp: e.rtpTimestamp })
    }
    for (const [source, cur] of next) {
      const before = this.prev.get(source)
      const changed = before ? cur.ts !== before.ts || cur.rtp !== before.rtp : nowEpoch - toEpochMs(cur.ts, nowEpoch, this.timeOrigin) <= FRESH_MS
      if (!changed) continue
      const level = entries.find((e) => e.source === source && e.timestamp === cur.ts)?.audioLevel
      if (typeof level === 'number' && level < MIN_LEVEL) continue
      out.push(source)
    }
    if (next.size > 0) this.lastSeenAt = nowEpoch
    this.prev = next
    return out
  }

  /** O caminho do CSRC está funcionando (alguma entrada nos últimos ALIVE_MS)? */
  alive(nowEpoch: number): boolean {
    return this.lastSeenAt !== null && nowEpoch - this.lastSeenAt <= ALIVE_MS
  }
}
