import { describe, expect, it } from 'vitest'
import { collectionsMessage, dcrpcMessage, dcrpcRecord, rosterResponseBase64 } from '../../../tests/helpers/protobuf'
import { SPEAKER_KEY_PREFIX } from '../../shared/constants'
import type { ContributingSource } from '../capture/registry'
import { DCRPC_STALE_MS, DomMeterTracker, MEET_LOUDEST_SPEAKER_CSRC, MEET_ROSTER_URL_RE, createMeetSpeakers, type MeetTileReading } from './meet-speakers'

const ANA = 'spaces/abc/devices/2'
const BRUNO = 'spaces/abc/devices/3'
const EU = 'spaces/abc/devices/1'
const NOW = 1_760_000_000_000

function probe(now: number, csrcs: ContributingSource[] = []) {
  return { now, contributingSources: () => csrcs }
}

async function withRoster() {
  let clock = NOW
  const s = createMeetSpeakers({ now: () => clock })
  await s.onChannel(
    'collections',
    collectionsMessage(
      [
        { deviceId: EU, name: 'Alex Lima', self: true },
        { deviceId: ANA, name: 'Ana Souza' },
      ],
      [
        ['1053', ANA],
        ['2331', BRUNO],
        ['11', EU],
      ],
    ),
  )
  return { s, setClock: (t: number) => (clock = t) }
}

describe('falantes do Meet', () => {
  it('CSRC primeiro: String(csrc) -> streamId -> deviceId -> nome', async () => {
    const { s } = await withRoster()
    const r = s.read(probe(NOW, [{ source: 1053, timestamp: NOW - 20, audioLevel: 0.3 }]), undefined)
    expect(r).toEqual({ nomes: ['Ana Souza'], fonte: 'csrc' })
  })

  it('CSRC sem nome vira chave provisória, resolvida quando a roster chega (lição do #330)', async () => {
    const { s } = await withRoster()
    const r = s.read(probe(NOW, [{ source: 2331, timestamp: NOW - 20 }]), undefined)!
    expect(r.fonte).toBe('csrc')
    expect(r.nomes).toEqual([`${SPEAKER_KEY_PREFIX}csrc:2331`])
    expect(s.aliases()).toEqual({})
    await s.onRosterText(rosterResponseBase64([{ deviceId: BRUNO, name: 'Bruno Lima' }]))
    expect(s.aliases()).toEqual({ [`${SPEAKER_KEY_PREFIX}csrc:2331`]: 'Bruno Lima' })
  })

  it('o CSRC 42 (marcador do mais alto do Meet) chega junto com o de quem fala e nunca vira falante (Emenda 20)', async () => {
    const { s } = await withRoster()
    // O mesmo pacote: os dois CSRCs com o mesmo carimbo, como a libwebrtc copia do pacote.
    const r = s.read(probe(NOW, [{ source: 1053, timestamp: NOW - 20, rtpTimestamp: 900, audioLevel: 0.3 }, { source: MEET_LOUDEST_SPEAKER_CSRC, timestamp: NOW - 20, rtpTimestamp: 900, audioLevel: 0.3 }]), undefined)
    expect(r).toEqual({ nomes: ['Ana Souza'], fonte: 'csrc' })
    // Sozinho (um pacote sem o participante): ninguém, e não uma chave provisória.
    expect(s.read(probe(NOW + 250, [{ source: MEET_LOUDEST_SPEAKER_CSRC, timestamp: NOW + 240, audioLevel: 0.3 }]), undefined)).toEqual({ nomes: [], fonte: 'csrc' })
    expect(s.aliases()).toEqual({})
  })

  it('diagnóstico do CSRC (Emenda 20): só números; o 42 no mesmo pacote da Ana, o seu como roster', async () => {
    const { s } = await withRoster()
    expect(s.diagnostics()).toBeNull()
    for (let k = 0; k < 3; k++) {
      const t = NOW + k * 250
      s.read(
        probe(t, [
          { source: 1053, timestamp: t - 5, rtpTimestamp: 900 + k, audioLevel: 0.3, receiver: 1 },
          { source: MEET_LOUDEST_SPEAKER_CSRC, timestamp: t - 5, rtpTimestamp: 900 + k, audioLevel: 0.3, receiver: 1 },
          // Mesmo carimbo e mesmo rtpTimestamp da Ana, mas em outro receptor: outro pacote.
          { source: 2331, timestamp: t - 5, rtpTimestamp: 900 + k, audioLevel: 0.2, receiver: 2 },
          // Mesmo receptor e mesmo carimbo da Ana, mas outro rtpTimestamp: outro pacote.
          { source: 5555, timestamp: t - 5, rtpTimestamp: 1 + k, audioLevel: 0.2, receiver: 1 },
          { source: 11, timestamp: t - 9, rtpTimestamp: 70 + k, audioLevel: 0.2, receiver: 3 },
        ]),
        undefined,
      )
    }
    const d = s.diagnostics()!
    expect(d.csrc!.receptores).toBe(3)
    expect(d.csrc!.fontes).toEqual([
      { csrc: 1053, leiturasAtiva: 3, receptores: 1, resolvida: true, mesmoPacoteComNomeada: 0 },
      { csrc: MEET_LOUDEST_SPEAKER_CSRC, leiturasAtiva: 3, receptores: 1, resolvida: false, mesmoPacoteComNomeada: 3, ignorada: 'mais-alto' },
      { csrc: 2331, leiturasAtiva: 3, receptores: 1, resolvida: false, mesmoPacoteComNomeada: 0 },
      { csrc: 5555, leiturasAtiva: 3, receptores: 1, resolvida: false, mesmoPacoteComNomeada: 0 },
      { csrc: 11, leiturasAtiva: 3, receptores: 1, resolvida: false, mesmoPacoteComNomeada: 0, ignorada: 'roster' },
    ])
    // Nenhum nome no diagnóstico.
    expect(JSON.stringify(d)).not.toMatch(/Ana|Alex|Bruno|spaces/)
  })

  it('o próprio usuário e um device de outra call nunca viram falante', async () => {
    const { s } = await withRoster()
    await s.onChannel('collections', collectionsMessage([{ deviceId: 'spaces/outra/devices/5', name: 'De outra call' }], [['77', 'spaces/outra/devices/5']]))
    const r = s.read(probe(NOW, [{ source: 11, timestamp: NOW }, { source: 77, timestamp: NOW }]), undefined)
    expect(r).toEqual({ nomes: [], fonte: 'csrc' })
  })

  it('sem CSRC (caminho NetEq), vale o dcrpc; o snapshot velho deixa de valer', async () => {
    const { s, setClock } = await withRoster()
    expect(s.read(probe(NOW), undefined)).toBeNull()
    await s.onChannel('dcrpc', dcrpcMessage([dcrpcRecord(ANA, true), dcrpcRecord(2331, true), dcrpcRecord(EU, true)]))
    expect(s.read(probe(NOW + 100), undefined)).toEqual({ nomes: ['Ana Souza', `${SPEAKER_KEY_PREFIX}dev:2331`], fonte: 'dcrpc' })
    await s.onChannel('dcrpc', dcrpcMessage([dcrpcRecord(ANA, false), dcrpcRecord(2331, false)]))
    expect(s.read(probe(NOW + 200), undefined)).toEqual({ nomes: [], fonte: 'dcrpc' })
    setClock(NOW + 300)
    await s.onChannel('dcrpc', dcrpcMessage([dcrpcRecord(ANA, true)]))
    expect(s.read(probe(NOW + 300 + DCRPC_STALE_MS + 1), undefined)).toBeNull()
  })

  it('um device de outra call que nem está na roster não vira "Participante N"; um desconhecido desta call vira', async () => {
    const { s } = await withRoster()
    await s.onChannel('dcrpc', dcrpcMessage([dcrpcRecord('spaces/outra/devices/8', true), dcrpcRecord(ANA, true), dcrpcRecord('spaces/abc/devices/9', true)]))
    expect(s.read(probe(NOW + 100), undefined)).toEqual({ nomes: ['Ana Souza', `${SPEAKER_KEY_PREFIX}dev:spaces/abc/devices/9`], fonte: 'dcrpc' })
  })

  it('com CSRC funcionando, o dcrpc não manda', async () => {
    const { s } = await withRoster()
    await s.onChannel('dcrpc', dcrpcMessage([dcrpcRecord(ANA, true)]))
    expect(s.read(probe(NOW, [{ source: 2331, timestamp: NOW, audioLevel: 0.001 }]), undefined)).toEqual({ nomes: [], fonte: 'csrc' })
  })

  it('a URL da roster é só a do SyncMeetingSpaceCollections', () => {
    expect(MEET_ROSTER_URL_RE.test('https://meet.google.com/$rpc/google.rtc.meetings.v1.MeetingSpaceService/SyncMeetingSpaceCollections')).toBe(true)
    expect(MEET_ROSTER_URL_RE.test('https://meet.google.com/$rpc/google.rtc.meetings.v1.MeetingSpaceService/SyncMeetingSpaceCollections?x=1')).toBe(true)
    expect(MEET_ROSTER_URL_RE.test('https://meet.google.com/$rpc/google.rtc.meetings.v1.MeetingSpaceService/SyncMeetingSpaceCollectionsX')).toBe(false)
    expect(MEET_ROSTER_URL_RE.test('https://meet.google.com/abc-defg-hij')).toBe(false)
  })
})

describe('DomMeterTracker (medidor [jsname="QgSmzd"])', () => {
  const tile = (participantId: string, name: string, cls: string, extra: Partial<MeetTileReading> = {}): MeetTileReading => ({
    participantId,
    mediaId: participantId,
    name,
    isSelf: false,
    meters: [cls],
    ...extra,
  })

  it('a classe que troca é fala; parada há mais de 800 ms, não; sem medidor, null', () => {
    const d = new DomMeterTracker()
    expect(d.update(0, [])).toBeNull()
    // Primeira vez: ainda não dá para dizer que mudou.
    expect(d.update(0, [tile(ANA, 'Ana Souza', 'a'), tile(BRUNO, 'Bruno Lima', 'x')])).toEqual([])
    expect(d.update(250, [tile(ANA, 'Ana Souza', 'b'), tile(BRUNO, 'Bruno Lima', 'x')])).toEqual(['Ana Souza'])
    expect(d.update(1000, [tile(ANA, 'Ana Souza', 'b'), tile(BRUNO, 'Bruno Lima', 'y')])).toEqual(['Ana Souza', 'Bruno Lima'])
    expect(d.update(1100, [tile(ANA, 'Ana Souza', 'b'), tile(BRUNO, 'Bruno Lima', 'y')])).toEqual(['Bruno Lima'])
  })

  it('o bloco do próprio usuário e o de apresentação não contam', () => {
    const d = new DomMeterTracker()
    d.update(0, [tile(EU, 'Alex Lima', 'a', { isSelf: true }), tile(ANA, 'Ana (apresentação)', 'a', { mediaId: 'spaces/abc/devices/2/tela' })])
    expect(d.update(250, [tile(EU, 'Alex Lima', 'b', { isSelf: true }), tile(ANA, 'Ana (apresentação)', 'b', { mediaId: 'spaces/abc/devices/2/tela' })])).toBeNull()
  })
})
