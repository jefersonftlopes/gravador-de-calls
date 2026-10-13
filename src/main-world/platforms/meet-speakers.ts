// Quem fala agora no Meet (Emenda 18; pesquisa em docs/pesquisa/falantes-2026-10-09.md). Só
// sinais passivos, sem clicar em nada, sem abrir painel e sem ligar legenda. Em ordem:
//
// 1. CSRC dos receptores de áudio (caminho WebRTC nativo): String(csrc) é o streamId de um
//    deviceOutput da roster, que leva ao deviceId e ao nome. Funciona com a aba em segundo plano.
// 2. Canal 'dcrpc' (o servidor diz quem fala, por device): o caminho em que o Meet decodifica o
//    áudio ele mesmo (NetEq) e o CSRC fica vazio.
// 3. Medidor de voz do bloco no DOM ([jsname="QgSmzd"] trocando de classe dentro de
//    [data-participant-id]): só com a aba visível (o Meet para de atualizar em segundo plano).
//
// Roster: canal 'collections' (zlib ou gzip) e a resposta do fetch SyncMeetingSpaceCollections
// (base64), com reserva no nome do bloco do DOM (o data-participant-id é o deviceId). Fica só o
// space do próprio usuário (a mesma conta recebe estado de outras calls), sem o próprio device e
// sem apresentações. Um CSRC ou device sem nome vira uma chave provisória, resolvida depois.
import { SPEAKER_KEY_PREFIX } from '../../shared/constants'
import { inflate, fromBase64, tapChannels } from '../speakers/channels'
import { CsrcTracker } from '../speakers/csrc'
import { tapFetch } from '../speakers/fetch-tap'
import { DEVICE_RE, MeetRoster, compressionOf, dcrpcPayload, parseDcrpcSnapshot, parseRoster, spaceOf } from '../speakers/meet-signals'
import type { SpeakerReading } from '../speakers/timeline'
import type { ContributingSource } from '../capture/registry'
import type { Originals } from '../originals'
import type { SpeakerDiagnostics } from '../../shared/protocol'
import type { SpeakerProbe, SpeakerSignalsContext } from './types'

export const MEET_ROSTER_URL_RE = /\/\$rpc\/google\.rtc\.meetings\.v1\.MeetingSpaceService\/SyncMeetingSpaceCollections(?:[?#]|$)/
/**
 * CSRC que o servidor de mídia do Meet põe, além do CSRC do participante, nos pacotes de quem está
 * mais alto (Emenda 20). Não é uma pessoa: o cliente de referência do próprio Google
 * (googleworkspace/meet-media-api-samples) o trata como reservado, `kLoudestSpeakerCsrc = 42` em
 * C++ e `LOUDEST_SPEAKER_CSRC = 42` na web, e o tira antes de escolher o participante. Numa daily
 * real (13/10/2026) ele ficou ativo sempre que alguém falava e virou "Participante 1" em 330 de 350
 * trechos. Fica aqui, e não no CsrcTracker, porque o Teams usa o mesmo rastreador.
 */
export const MEET_LOUDEST_SPEAKER_CSRC = 42
/** Diagnóstico do CSRC (Emenda 20): quantas fontes acompanha, e quantas vão para o falantes.json. */
const DIAG_MAX_SOURCES = 64
const DIAG_OUT_SOURCES = 32
/** Um snapshot do dcrpc vale até tanto depois de chegar (cadência não documentada). */
export const DCRPC_STALE_MS = 30_000
/** Medidor do DOM: falando até tanto depois da última troca de classe (Natively: 800 ms). */
export const DOM_SPEAKING_MS = 800

/** Um bloco do Meet como lido do DOM (tudo texto, para a regra ser testável sem DOM). */
export interface MeetTileReading {
  participantId: string
  mediaId: string | null
  name: string
  isSelf: boolean
  /** O atributo `class` de cada medidor [jsname="QgSmzd"] do bloco, na ordem. */
  meters: string[]
}

/** Medidor de voz do DOM: troca de classe recente = falando (função de estado, sem DOM). */
export class DomMeterTracker {
  private last = new Map<string, { cls: string; changedAt: number }>()

  /** Nomes falando agora; null se não houver medidor nenhum na tela. */
  update(now: number, tiles: readonly MeetTileReading[]): string[] | null {
    let meters = 0
    const out = new Set<string>()
    const next = new Map<string, { cls: string; changedAt: number }>()
    for (const t of tiles) {
      // O bloco de apresentação tem media id próprio (o da câmera é igual ao participant id).
      if (t.isSelf || (t.mediaId && t.mediaId !== t.participantId)) continue
      t.meters.forEach((cls, i) => {
        meters++
        const key = `${t.participantId}#${i}`
        const before = this.last.get(key)
        // Primeira vez que o medidor aparece: ainda não dá para dizer que mudou.
        const changedAt = before ? (before.cls === cls ? before.changedAt : now) : -Infinity
        next.set(key, { cls, changedAt })
        if (t.name && now - changedAt <= DOM_SPEAKING_MS) out.add(t.name)
      })
    }
    this.last = next
    return meters > 0 ? [...out] : null
  }
}

const TILE = '[data-participant-id]'
const SELF = '[data-self-name]'
const METER = '[jsname="QgSmzd"]'
const JUNK = /^Google Participant \(|spaces\/|devices\//

function readTiles(doc: Document): MeetTileReading[] {
  const selfTiles = new Set<Element>()
  for (const mark of Array.from(doc.querySelectorAll(SELF))) {
    const tile = mark.closest(TILE)
    if (tile) selfTiles.add(tile)
  }
  const out: MeetTileReading[] = []
  for (const el of Array.from(doc.querySelectorAll(TILE))) {
    const name = (el.querySelector('span.notranslate')?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 300)
    out.push({
      participantId: el.getAttribute('data-participant-id') ?? '',
      mediaId: el.getAttribute('data-tile-media-id'),
      name: JUNK.test(name) ? '' : name,
      isSelf: selfTiles.has(el) || el.querySelector(SELF) !== null,
      // getAttribute e não className: num SVG o className é um SVGAnimatedString que nunca muda (Pipit).
      meters: Array.from(el.querySelectorAll(METER), (m) => m.getAttribute('class') ?? ''),
    })
  }
  return out
}

export interface MeetSpeakers {
  install(ctx: SpeakerSignalsContext): void
  read(probe: SpeakerProbe, doc?: Document): SpeakerReading | null
  aliases(): Record<string, string>
  /** Emenda 20: o diagnóstico do CSRC desta call, só com números; null sem nenhum CSRC ativo. */
  diagnostics(): SpeakerDiagnostics | null
  /** Para os testes: entrega uma mensagem como se viesse do canal. */
  onChannel(label: 'collections' | 'dcrpc', data: Uint8Array | string): Promise<void>
  onRosterText(text: string): Promise<void>
  readonly roster: MeetRoster
}

export function createMeetSpeakers(opts: { now?: () => number } = {}): MeetSpeakers {
  let now = opts.now ?? (() => Date.now())
  let orig: Pick<Originals, 'DecompressionStream' | 'atob' | 'timeOrigin'> = { DecompressionStream: globalThis.DecompressionStream, atob: undefined, timeOrigin: 0 }
  let log: (...a: unknown[]) => void = () => {}
  const roster = new MeetRoster()
  let csrc = new CsrcTracker()
  const dom = new DomMeterTracker()
  let dcrpc: { ids: string[]; at: number } | null = null
  /** Nomes do DOM por deviceId (reserva da roster). */
  const domNames = new Map<string, string>()
  /** Chaves provisórias já entregues -> id (streamId ou deviceId). */
  const pending = new Map<string, string>()
  let warnedFormat = false
  /** Emenda 20: por CSRC ativo, quantas leituras, em quais receptores e quantas no pacote de uma nomeada. */
  const csrcStats = new Map<number, { reads: number; receivers: Set<number>; samePacketNamed: number }>()
  const receiversSeen = new Set<number>()

  const bytesOf = (d: Uint8Array | string): Uint8Array => (typeof d === 'string' ? new TextEncoder().encode(d) : d)

  const decompressed = async (buf: Uint8Array): Promise<Uint8Array | null> => {
    const fmt = compressionOf(buf)
    return fmt ? inflate(orig, buf, fmt) : buf
  }

  const onCollections = async (data: Uint8Array | string) => {
    const raw = await decompressed(bytesOf(data))
    if (!raw) return
    const update = parseRoster(raw)
    roster.apply(update)
    if (update.users.length || update.streams.length) log('roster do Meet', update.users.length, 'pessoas', update.streams.length, 'streams')
  }

  const onDcrpc = async (data: Uint8Array | string) => {
    const payload = dcrpcPayload(bytesOf(data))
    if (!payload) return
    const raw = await decompressed(payload)
    const records = raw ? parseDcrpcSnapshot(raw) : null
    if (!records) {
      if (!warnedFormat) log('dcrpc: snapshot sem registros reconhecidos (o formato pode ter mudado)')
      warnedFormat = true
      return
    }
    dcrpc = { ids: records.filter((r) => r.speaking).map((r) => r.id), at: now() }
  }

  const onRosterText = async (text: string) => {
    const bytes = fromBase64(orig, text.trim()) ?? bytesOf(text)
    const raw = await decompressed(bytes)
    if (raw) roster.apply(parseRoster(raw))
  }

  /** Nome de um id (streamId ou deviceId), uma chave provisória, ou null (não é pessoa remota). */
  const nameOf = (id: string, kind: string): string | null => {
    // O próprio usuário, uma apresentação ou um device de outra call (outro space, mesmo sem estar
    // na roster): nunca vira falante desta.
    if (roster.isIgnored(id)) return null
    const device = roster.deviceOf(id)
    const name = device ? roster.names.get(device) ?? domNames.get(device) : undefined
    if (name) return name
    const key = `${SPEAKER_KEY_PREFIX}${kind}:${id}`
    pending.set(key, id)
    return key
  }

  /** O nome que um id já tem (sem criar chave provisória); null se não tem ou não é pessoa remota. */
  const knownName = (id: string): string | null => {
    if (roster.isIgnored(id)) return null
    const device = roster.deviceOf(id)
    return (device ? roster.names.get(device) ?? domNames.get(device) : undefined) ?? null
  }

  /**
   * Conta, para o diagnóstico, cada CSRC ativo nesta leitura (o 42 também). "Mesmo pacote": outra
   * entrada no mesmo receptor com o mesmo `timestamp` e `rtpTimestamp`, porque a libwebrtc copia os
   * dois do pacote para cada CSRC dele.
   */
  const noteCsrc = (entries: readonly ContributingSource[], active: readonly number[]) => {
    for (const e of entries) if (e.receiver !== undefined) receiversSeen.add(e.receiver)
    for (const source of active) {
      let st = csrcStats.get(source)
      if (!st) {
        if (csrcStats.size >= DIAG_MAX_SOURCES) continue
        st = { reads: 0, receivers: new Set(), samePacketNamed: 0 }
        csrcStats.set(source, st)
      }
      st.reads++
      const mine = entries.filter((e) => e.source === source)
      for (const e of mine) if (e.receiver !== undefined) st.receivers.add(e.receiver)
      const newest = mine.reduce<ContributingSource | null>((a, b) => (!a || b.timestamp > a.timestamp ? b : a), null)
      if (!newest || newest.receiver === undefined || newest.rtpTimestamp === undefined) continue
      const together = entries.some(
        (f) => f.source !== source && f.receiver === newest.receiver && f.timestamp === newest.timestamp && f.rtpTimestamp === newest.rtpTimestamp && knownName(String(f.source)) !== null,
      )
      if (together) st.samePacketNamed++
    }
  }

  const refreshDom = (doc: Document | undefined) => {
    if (!doc) return [] as MeetTileReading[]
    const tiles = readTiles(doc)
    // Emenda 20: os blocos só mostram esta call, então o space deles é o da call.
    const space = tiles.map((t) => spaceOf(t.participantId)).find((x) => x !== null)
    if (space) roster.callSpace = space
    for (const t of tiles) {
      if (!t.isSelf && t.name && DEVICE_RE.test(t.participantId)) domNames.set(t.participantId, t.name)
      // O bloco do próprio usuário diz o space desta call quando a roster ainda não disse.
      if (t.isSelf && roster.selfSpace === null) roster.selfSpace = spaceOf(t.participantId)
      if (t.isSelf && DEVICE_RE.test(t.participantId)) roster.ignored.add(t.participantId)
    }
    return tiles
  }

  return {
    roster,
    install(ctx) {
      orig = ctx.orig
      log = ctx.log
      now = ctx.orig.now
      csrc = new CsrcTracker(ctx.orig.timeOrigin)
      const handlers = new Map([
        ['collections', (d: Uint8Array | string) => void onCollections(d).catch((e) => log('collections', e))],
        ['dcrpc', (d: Uint8Array | string) => void onDcrpc(d).catch((e) => log('dcrpc', e))],
      ])
      tapChannels(ctx.orig, ctx.registry, handlers, ctx.log)
      tapFetch(ctx.orig, MEET_ROSTER_URL_RE, (text) => void onRosterText(text).catch((e) => log('roster (fetch)', e)), ctx.log)
    },
    read(probe, doc = typeof document === 'undefined' ? undefined : document) {
      let tiles: MeetTileReading[] = []
      try {
        tiles = refreshDom(doc)
      } catch (e) {
        log('blocos do Meet', e)
      }
      const entries = probe.contributingSources()
      const active = csrc.active(entries, probe.now)
      if (csrc.alive(probe.now)) {
        try {
          noteCsrc(entries, active)
        } catch (e) {
          log('diagnóstico do CSRC', e)
        }
        // O marcador de "mais alto" chega junto com o CSRC de quem fala: nunca é falante.
        const nomes = active
          .filter((s) => s !== MEET_LOUDEST_SPEAKER_CSRC)
          .map((s) => nameOf(String(s), 'csrc'))
          .filter((n): n is string => n !== null)
        return { nomes, fonte: 'csrc' }
      }
      if (dcrpc && probe.now - dcrpc.at <= DCRPC_STALE_MS) {
        const nomes = dcrpc.ids.map((id) => nameOf(id, 'dev')).filter((n): n is string => n !== null)
        return { nomes, fonte: 'dcrpc' }
      }
      const fromDom = dom.update(probe.now, tiles)
      return fromDom ? { nomes: fromDom, fonte: 'dom' } : null
    },
    aliases() {
      const out: Record<string, string> = {}
      for (const [key, id] of pending) {
        const device = roster.deviceOf(id)
        const name = device ? roster.names.get(device) ?? domNames.get(device) : undefined
        if (name) out[key] = name
      }
      return out
    },
    diagnostics() {
      if (csrcStats.size === 0) return null
      const fontes = [...csrcStats]
        .sort((a, b) => b[1].reads - a[1].reads)
        .slice(0, DIAG_OUT_SOURCES)
        .map(([source, st]) => {
          const ignorada = source === MEET_LOUDEST_SPEAKER_CSRC ? ('mais-alto' as const) : roster.isIgnored(String(source)) ? ('roster' as const) : null
          return {
            csrc: source,
            leiturasAtiva: st.reads,
            receptores: st.receivers.size,
            resolvida: knownName(String(source)) !== null,
            mesmoPacoteComNomeada: st.samePacketNamed,
            ...(ignorada ? { ignorada } : {}),
          }
        })
      return { csrc: { receptores: receiversSeen.size, fontes } }
    },
    onChannel: (label, data) => (label === 'collections' ? onCollections(data) : onDcrpc(data)),
    onRosterText,
  }
}
