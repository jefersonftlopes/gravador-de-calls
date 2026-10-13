// Codificador mínimo de protobuf para os testes (Emenda 18): monta as mensagens do Meet (roster do
// 'collections', resposta do SyncMeetingSpaceCollections e snapshots do 'dcrpc') no formato que a
// pesquisa descreve (docs/pesquisa/falantes-2026-10-09.md). Só para os testes: o produto só lê.
import { deflateSync, gzipSync } from 'node:zlib'

export type PbValue = number | string | Uint8Array | PbMsg
/** Campos em ordem: [número, valor]. Mensagem aninhada é outro PbMsg. */
export type PbMsg = Array<[number, PbValue]>

function varint(n: number): number[] {
  const out: number[] = []
  let v = n
  while (v >= 0x80) {
    out.push((v % 128) | 0x80)
    v = Math.floor(v / 128)
  }
  out.push(v)
  return out
}

export function encode(msg: PbMsg): Uint8Array {
  const out: number[] = []
  for (const [no, value] of msg) {
    if (typeof value === 'number') {
      out.push(...varint(no * 8), ...varint(value))
      continue
    }
    const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value instanceof Uint8Array ? value : encode(value)
    out.push(...varint(no * 8 + 2), ...varint(bytes.length), ...bytes)
  }
  return Uint8Array.from(out)
}

export interface FakeUser {
  deviceId: string
  /** fullName (2); também o displayName (29) quando `displayName` não vem. */
  name: string
  /** displayName (29), quando diferente do nome completo (o Meet manda o primeiro nome). */
  displayName?: string
  self?: boolean
  /**
   * Valor do campo 7 (isCurrentUserString) quando não é o 'true' de sempre: texto ou varint. Nunca
   * visto numa call deste projeto; a forma vem da descrição de terceiros (Emenda 20).
   */
  selfValue?: string | number
  presentation?: boolean
  status?: number
}

/** UserInfo { 1 deviceId, 2 fullName, 4 status, 7 isCurrentUserString, 21 parentDeviceId, 29 displayName }. */
export function userInfo(u: FakeUser): PbMsg {
  const m: PbMsg = [
    [1, u.deviceId],
    [2, u.name],
    [4, u.status ?? 1],
  ]
  if (u.self || u.selfValue !== undefined) m.push([7, u.selfValue ?? 'true'])
  if (u.presentation) m.push([21, u.deviceId.replace(/\d+$/, '0')])
  m.push([29, u.displayName ?? u.name])
  return m
}

/** DeviceOutputInfo { 2 tipo (1 áudio), 4 streamId, 6 deviceId }. */
export function deviceOutput(streamId: string, deviceId: string): PbMsg {
  return [
    [2, 1],
    [4, streamId],
    [6, deviceId],
  ]
}

/**
 * Uma mensagem do 'collections' (CollectionEvent 1.2.3.2 = DeviceOutputInfoList e 1.2.13.1.2 =
 * UserInfoList), comprimida com zlib.
 */
export function collectionsMessage(users: FakeUser[], streams: Array<[string, string]>): Uint8Array {
  const devices: PbMsg = streams.map(([s, d]) => [2, deviceOutput(s, d)] as [number, PbValue])
  const userList: PbMsg = users.map((u) => [2, userInfo(u)] as [number, PbValue])
  const event: PbMsg = [[1, [[2, [[3, devices], [13, [[1, userList]]]]]]]]
  return deflateSync(encode(event))
}

/** Resposta do SyncMeetingSpaceCollections: base64 de UserInfoListResponse 2.2.2 = UserInfoList. */
export function rosterResponseBase64(users: FakeUser[]): string {
  const userList: PbMsg = users.map((u) => [2, userInfo(u)] as [number, PbValue])
  return Buffer.from(encode([[2, [[2, userList]]]])).toString('base64')
}

/** Um registro do dcrpc: { 4 id (deviceId) ou 8 id numérico, 9 { 2 = falando } }. */
export function dcrpcRecord(id: string | number, speaking: boolean): PbMsg {
  const active: PbMsg = speaking ? [[2, 1]] : []
  return typeof id === 'number' ? [[8, id], [9, active]] : [[4, id], [9, active]]
}

/** Mensagem do 'dcrpc': topo { 2 gzip(snapshot) }, snapshot com envelopes [2] até os registros [4]. */
export function dcrpcMessage(records: PbMsg[], depth = 2): Uint8Array {
  let inner: PbMsg = records.map((r) => [4, r] as [number, PbValue])
  for (let i = 0; i < depth; i++) inner = [[2, inner]]
  return encode([[2, gzipSync(encode(inner))]])
}

/** O keepalive do dcrpc (campo 1 no topo). */
export function dcrpcKeepalive(): Uint8Array {
  return encode([[1, 1]])
}
