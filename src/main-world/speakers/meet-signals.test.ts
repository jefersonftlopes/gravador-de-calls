import { inflateSync, gunzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { collectionsMessage, dcrpcKeepalive, dcrpcMessage, dcrpcRecord, encode, rosterResponseBase64 } from '../../../tests/helpers/protobuf'
import { MeetRoster, compressionOf, dcrpcPayload, isCurrentUser, parseDcrpcSnapshot, parseRoster, spaceOf, type MeetUser } from './meet-signals'
import { parseMessage, utf8 } from './protobuf'

const ANA = 'spaces/abc/devices/2'
const BRUNO = 'spaces/abc/devices/3'
const EU = 'spaces/abc/devices/1'
const user = (deviceId: string, name: string, self = false): MeetUser => ({ deviceId, name, fullName: name, displayName: name, self, presentation: false, gone: false })

describe('protobuf', () => {
  it('lê varint, bytes e recusa lixo sem lançar', () => {
    const f = parseMessage(encode([[1, 150], [2, 'oi'], [3, [[1, 7]]]]))!
    expect(f.map((x) => [x.no, x.wire])).toEqual([[1, 0], [2, 2], [3, 2]])
    expect(f[0].num).toBe(150)
    expect(utf8(f[1].bytes)).toBe('oi')
    expect(parseMessage(Uint8Array.from([0x0a, 0x05, 0x01]))).toBeNull()
    expect(parseMessage(Uint8Array.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]))).toBeNull()
    expect(utf8(Uint8Array.from([0xc3, 0x28]))).toBeNull()
  })
})

describe('roster do Meet', () => {
  it('acha pessoas e streams em qualquer profundidade (collections com zlib)', () => {
    const msg = collectionsMessage(
      [
        { deviceId: EU, name: 'Alex Lima', self: true },
        { deviceId: ANA, name: 'Ana Souza' },
        { deviceId: 'spaces/abc/devices/9', name: 'Apresentação', presentation: true },
      ],
      [
        ['1053', ANA],
        ['2331', BRUNO],
      ],
    )
    expect(compressionOf(msg)).toBe('deflate')
    const r = parseRoster(inflateSync(msg))
    expect(r.users.map((u) => [u.name, u.self, u.presentation])).toEqual([
      ['Alex Lima', true, false],
      ['Ana Souza', false, false],
      ['Apresentação', false, true],
    ])
    expect(r.streams).toEqual([
      { streamId: '1053', deviceId: ANA },
      { streamId: '2331', deviceId: BRUNO },
    ])
  })

  it('a resposta do SyncMeetingSpaceCollections (base64) também', () => {
    const r = parseRoster(Buffer.from(rosterResponseBase64([{ deviceId: BRUNO, name: 'Bruno Lima' }]), 'base64'))
    expect(r.users.map((u) => u.name)).toEqual(['Bruno Lima'])
  })

  it('o space desta call vem do próprio usuário e o de outra call fica de fora', () => {
    const roster = new MeetRoster()
    roster.apply({
      users: [
        user(EU, 'Alex Lima', true),
        user(ANA, 'Ana Souza'),
        user('spaces/outra/devices/5', 'Pessoa de outra call'),
      ],
      streams: [
        { streamId: '1053', deviceId: ANA },
        { streamId: '77', deviceId: 'spaces/outra/devices/5' },
        { streamId: '11', deviceId: EU },
      ],
    })
    expect(roster.selfSpace).toBe('abc')
    expect(roster.deviceOf('1053')).toBe(ANA)
    expect(roster.deviceOf(ANA)).toBe(ANA)
    expect(roster.deviceOf('77')).toBeNull()
    expect(roster.isIgnored('77')).toBe(true)
    expect(roster.deviceOf('11')).toBeNull()
    expect(roster.isIgnored(EU)).toBe(true)
    expect(roster.deviceOf('999')).toBeNull()
    expect(roster.isIgnored('999')).toBe(false)
    expect(spaceOf(ANA)).toBe('abc')
  })
})

describe('o próprio usuário na roster (Emenda 20)', () => {
  const fieldsOf = (value: string | number) => parseMessage(encode([[1, EU], [7, value]]))!

  it('o campo 7 vale pelo valor, não pela presença: "false", "0", vazio e varint 0 não são o próprio usuário', () => {
    for (const v of ['true', 'TRUE', '1', 'sim', 1, 7]) expect(isCurrentUser(fieldsOf(v)), String(v)).toBe(true)
    for (const v of ['false', 'False', '0', '', ' ', 0]) expect(isCurrentUser(fieldsOf(v)), JSON.stringify(v)).toBe(false)
    expect(isCurrentUser(parseMessage(encode([[1, EU]]))!)).toBe(false)
  })

  it('um participante com o campo 7 em "false" continua falante (com só a presença, ele sumia)', () => {
    const r = parseRoster(inflateSync(collectionsMessage([{ deviceId: ANA, name: 'Ana Souza', selfValue: 'false' }], [])))
    expect(r.users.map((u) => [u.name, u.self])).toEqual([['Ana Souza', false]])
  })

  it('guarda o nome completo (2) e o exibido (29) do próprio usuário, por space', () => {
    const r = parseRoster(inflateSync(collectionsMessage([{ deviceId: EU, name: 'Alex Lima', displayName: 'Alex', self: true }, { deviceId: ANA, name: 'Ana Souza' }], [])))
    const roster = new MeetRoster()
    roster.apply(r)
    expect(roster.self()).toEqual({ deviceId: EU, fullName: 'Alex Lima', displayName: 'Alex' })
    // O falante continua com o nome exibido (29), como antes.
    expect(roster.names.get(EU)).toBe('Alex')
    expect(roster.spaces).toEqual(new Set(['abc']))
  })

  it('com duas calls na mesma conta, vale o registro do space que o DOM mostra, e o filtro de call segue esse space', () => {
    const roster = new MeetRoster()
    // O registro da outra call chega primeiro e fixa o selfSpace, como antes.
    roster.apply({ users: [user('spaces/outra/devices/4', 'Alex Lima (outra aba)', true), user('spaces/outra/devices/5', 'Pessoa de outra call')], streams: [] })
    roster.apply({ users: [user(EU, 'Alex Lima', true), user(ANA, 'Ana Souza')], streams: [{ streamId: '1053', deviceId: ANA }] })
    expect(roster.selfSpace).toBe('outra')
    expect(roster.deviceOf('1053')).toBeNull()
    roster.callSpace = 'abc'
    expect(roster.self()?.deviceId).toBe(EU)
    expect(roster.deviceOf('1053')).toBe(ANA)
    expect(roster.deviceOf('spaces/outra/devices/5')).toBeNull()
  })

  it('sem o campo 7, nenhum registro do próprio usuário', () => {
    const roster = new MeetRoster()
    roster.apply({ users: [user(ANA, 'Ana Souza')], streams: [] })
    roster.callSpace = 'abc'
    expect(roster.self()).toBeNull()
  })
})

describe('dcrpc', () => {
  it('snapshot gzip: quem fala (por deviceId e por id numérico), em qualquer profundidade', () => {
    for (const depth of [1, 2, 4]) {
      const msg = dcrpcMessage([dcrpcRecord(ANA, true), dcrpcRecord(2331, false), dcrpcRecord(EU, true)], depth)
      const payload = dcrpcPayload(msg)!
      expect(compressionOf(payload)).toBe('gzip')
      expect(parseDcrpcSnapshot(gunzipSync(payload))).toEqual([
        { id: ANA, speaking: true },
        { id: '2331', speaking: false },
        { id: EU, speaking: true },
      ])
    }
  })

  it('keepalive e mensagem sem registros não mudam nada', () => {
    expect(dcrpcPayload(dcrpcKeepalive())).toBeNull()
    expect(parseDcrpcSnapshot(encode([[1, 'nada']]))).toBeNull()
  })
})
