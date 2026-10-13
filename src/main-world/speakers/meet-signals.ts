// Sinais de rede do Meet para a linha do tempo dos falantes (Emenda 18). Funções puras sobre os
// bytes já descomprimidos; nada aqui lança. Formatos por engenharia reversa (attendee, Meeting-BaaS),
// resumidos em docs/pesquisa/falantes-2026-10-09.md:
//
// - canal 'collections' (zlib ou gzip) e a resposta do SyncMeetingSpaceCollections (base64):
//   UserInfo { 1 deviceId 'spaces/<s>/devices/<n>', 2 fullName, 4 status, 7 isCurrentUserString,
//   21 parentDeviceId, 29 displayName } e DeviceOutputInfo { 2 tipo, 4 streamId (dígitos, igual a
//   String(csrc)), 6 deviceId }, procurados em qualquer profundidade;
// - canal 'dcrpc': topo { 2 snapshot gzip } e, dentro, registros { 4 id (deviceId ou dígitos),
//   8 id numérico, 9 { 2 = falando } }.
import { has, num, parseMessage, str, sub, walk, type PbField } from './protobuf'

export const DEVICE_RE = /^spaces\/([^/\s]+)\/devices\/[^/\s]+$/
const DIGITS_RE = /^\d{1,20}$/
/** status do UserInfo: 6 fora da reunião, 7 removido. */
const STATUS_GONE = new Set([6, 7])

export interface MeetUser {
  deviceId: string
  /** O nome que vira falante: o displayName (29), senão o fullName (2). */
  name: string
  /** fullName (2) e displayName (29), cada um como veio (vazio sem o campo). */
  fullName: string
  displayName: string
  /** isCurrentUserString (7) com valor verdadeiro: o próprio usuário. */
  self: boolean
  /** Apresentação (tem parentDeviceId): não é uma pessoa falando. */
  presentation: boolean
  gone: boolean
}

export interface RosterUpdate {
  users: MeetUser[]
  /** streamId (String(csrc)) -> deviceId. */
  streams: Array<{ streamId: string; deviceId: string }>
}

/** Space de um deviceId ('spaces/<s>/devices/<n>'), ou null. */
export function spaceOf(deviceId: string): string | null {
  return DEVICE_RE.exec(deviceId)?.[1] ?? null
}

const cleanText = (s: string | null) => (s ?? '').replace(/\s+/g, ' ').trim().slice(0, 300)

/**
 * O campo 7 (isCurrentUserString) diz que é o próprio usuário? Leitura tolerante, a do Meeting-BaaS
 * (Emenda 20): texto não vazio e diferente de "false" e de "0", ou varint diferente de 0. Só a
 * presença do campo não basta: um "false" faria de qualquer participante o próprio usuário.
 */
export function isCurrentUser(fields: readonly PbField[]): boolean {
  const f = fields.find((x) => x.no === 7)
  if (!f) return false
  if (f.wire === 2) {
    const t = (str(fields, 7) ?? '').trim().toLowerCase()
    return t !== '' && t !== 'false' && t !== '0'
  }
  return (f.num ?? 0) !== 0
}

function userFrom(fields: PbField[]): MeetUser | null {
  const deviceId = str(fields, 1)
  if (!deviceId || !DEVICE_RE.test(deviceId)) return null
  const fullName = cleanText(str(fields, 2))
  const displayName = cleanText(str(fields, 29))
  const name = displayName || fullName
  if (!name || name.startsWith('spaces/')) return null
  const status = num(fields, 4)
  return {
    deviceId,
    name,
    fullName: fullName.startsWith('spaces/') ? '' : fullName,
    displayName: displayName.startsWith('spaces/') ? '' : displayName,
    self: isCurrentUser(fields),
    presentation: has(fields, 21),
    gone: status !== null && STATUS_GONE.has(status),
  }
}

/** Usuários e mapas de stream achados numa mensagem da roster (collections ou fetch). */
export function parseRoster(buf: Uint8Array): RosterUpdate {
  const users: MeetUser[] = []
  const streams: RosterUpdate['streams'] = []
  walk(buf, (fields) => {
    const u = userFrom(fields)
    if (u) users.push(u)
    const streamId = str(fields, 4)
    const deviceId = str(fields, 6)
    if (streamId && DIGITS_RE.test(streamId) && deviceId && DEVICE_RE.test(deviceId)) streams.push({ streamId, deviceId })
  })
  return { users, streams }
}

export interface DcrpcRecord {
  /** deviceId ('spaces/...') ou streamId (dígitos). */
  id: string
  speaking: boolean
}

/**
 * Registros de um snapshot do dcrpc já descomprimido; null se não houver nenhum (a mensagem não
 * era um snapshot, ou o formato mudou: quem chama não muda o estado).
 */
export function parseDcrpcSnapshot(buf: Uint8Array): DcrpcRecord[] | null {
  const out: DcrpcRecord[] = []
  const seen = new Set<string>()
  walk(buf, (fields) => {
    const active = fields.find((f) => f.no === 9 && f.wire === 2)
    if (!active) return
    const s4 = str(fields, 4)
    const n8 = num(fields, 8)
    const id = s4 && (DEVICE_RE.test(s4) || DIGITS_RE.test(s4)) ? s4 : n8 !== null ? String(n8) : null
    if (!id || seen.has(id)) return
    const inner = sub(fields, 9)
    if (inner === null) return
    seen.add(id)
    out.push({ id, speaking: has(inner, 2) })
  })
  return out.length ? out : null
}

/** Bytes comprimidos do topo de uma mensagem do dcrpc (campo 2), ou null (keepalive, outro tipo). */
export function dcrpcPayload(buf: Uint8Array): Uint8Array | null {
  const f = parseMessage(buf)?.find((x) => x.no === 2 && x.wire === 2)
  return f?.bytes ?? null
}

/** Formato de compressão pelos primeiros bytes: zlib (0x78), gzip (1f 8b) ou nenhum. */
export function compressionOf(buf: Uint8Array): 'deflate' | 'gzip' | null {
  if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) return 'gzip'
  if (buf.length >= 2 && buf[0] === 0x78 && ((buf[0] << 8) | buf[1]) % 31 === 0) return 'deflate'
  return null
}

/** O registro do próprio usuário num space (Emenda 20). */
export interface MeetSelf {
  deviceId: string
  fullName: string
  displayName: string
}

/** Roster acumulada de uma call do Meet: nomes por device e devices por stream. */
export class MeetRoster {
  readonly names = new Map<string, string>()
  readonly streams = new Map<string, string>()
  /** Devices que não falam por esta pessoa (o próprio usuário, apresentações, quem saiu). */
  readonly ignored = new Set<string>()
  selfSpace: string | null = null
  /**
   * Space da call aberta nesta aba, lido dos blocos [data-participant-id] do DOM (Emenda 20): a tela
   * só mostra esta call. Vale mais que o `selfSpace`, que é o do primeiro registro do próprio usuário
   * a chegar e pode ser de outra call da mesma conta.
   */
  callSpace: string | null = null
  /** O registro do próprio usuário em cada space (a conta recebe o estado de outras calls). */
  readonly selves = new Map<string, MeetSelf>()
  /** Spaces vistos na roster (diagnóstico). */
  readonly spaces = new Set<string>()

  apply(update: RosterUpdate): void {
    for (const u of update.users) {
      const space = spaceOf(u.deviceId)
      if (space) this.spaces.add(space)
      if (u.self) {
        this.selfSpace ??= space
        if (space) this.selves.set(space, { deviceId: u.deviceId, fullName: u.fullName, displayName: u.displayName })
      }
      if (u.self || u.presentation) this.ignored.add(u.deviceId)
      // Quem saiu continua com o nome: a fala de antes ainda é dele.
      this.names.set(u.deviceId, u.name)
    }
    for (const s of update.streams) this.streams.set(s.streamId, s.deviceId)
  }

  /** Esquece tudo (testes de unidade). */
  reset(): void {
    this.names.clear()
    this.streams.clear()
    this.ignored.clear()
    this.selves.clear()
    this.spaces.clear()
    this.selfSpace = null
    this.callSpace = null
  }

  /**
   * O próprio usuário na call desta aba: o registro do space do DOM, quando ele é conhecido; senão,
   * o do `selfSpace`. null sem registro dele (o campo 7 não veio).
   */
  self(): MeetSelf | null {
    const space = this.callSpace ?? this.selfSpace
    return space ? this.selves.get(space) ?? null : null
  }

  /** O device é desta call (o space do DOM, ou o do próprio usuário, quando algum é conhecido)? */
  sameCall(deviceId: string): boolean {
    const space = spaceOf(deviceId)
    const ref = this.callSpace ?? this.selfSpace
    return ref === null || space === null || space === ref
  }

  /**
   * deviceId de um id (deviceId direto ou streamId). null: desconhecido, de outra call, ou um
   * device que não é de pessoa remota.
   */
  deviceOf(id: string): string | null {
    const device = DEVICE_RE.test(id) ? id : this.streams.get(id)
    if (!device || !this.sameCall(device) || this.ignored.has(device)) return null
    return device
  }

  /** O id é sabidamente do próprio usuário ou de uma apresentação (nunca vira falante). */
  isIgnored(id: string): boolean {
    const device = DEVICE_RE.test(id) ? id : this.streams.get(id)
    return device !== undefined && (this.ignored.has(device) || !this.sameCall(device))
  }
}
