// Fiação do filtro dos receptores (Emenda 5): o installHook entrega ao registro o
// `filterReceiverTracks` do adaptador do host. No Teams, sem isto os receptores misturam o
// `mainAudio` com os `dominantSpeaker-*` e a gravação repete palavras sempre que o seam
// `elements` não tem fonte. O resto da instalação vai por falsos: aqui só interessa a ligação.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RemoteAudioTrack } from './capture/registry'

const setTrackFilter = vi.fn()

vi.mock('./originals', () => ({ captureOriginals: () => ({}), makeLog: () => () => {} }))
vi.mock('./capture/registry', () => ({ installRegistry: () => ({ setTrackFilter }) }))
vi.mock('./capture/seams', () => ({ installSeams: () => ({}) }))
vi.mock('./bridge', () => ({ createBridge: () => ({}) }))
vi.mock('./session', () => ({ startSessionController: () => ({}) }))

const { installHook } = await import('./install')
const { teamsAdapter, filterMainAudio } = await import('./platforms/teams')

const rt = (trackId: string, streamId: string): RemoteAudioTrack =>
  ({ track: { id: trackId, kind: 'audio' } as MediaStreamTrack, streams: [{ id: streamId } as MediaStream] }) as RemoteAudioTrack

const win = (hostname: string) => ({ location: { hostname } }) as unknown as Window

beforeEach(() => setTrackFilter.mockClear())

describe('installHook liga o filtro dos receptores do adaptador', () => {
  it('o adaptador do Teams declara o filtro do mainAudio', () => {
    expect(teamsAdapter.filterReceiverTracks).toBe(filterMainAudio)
  })

  it.each(['teams.microsoft.com', 'teams.cloud.microsoft', 'teams.live.com'])('no Teams (%s), o registro recebe o filtro: os dominantSpeaker saem', (host) => {
    expect(installHook(win(host))).toBe('instalado')
    expect(setTrackFilter).toHaveBeenCalledTimes(1)
    const filter = setTrackFilter.mock.calls[0][0] as ((all: readonly RemoteAudioTrack[]) => readonly RemoteAudioTrack[]) | undefined
    expect(filter).toBeTypeOf('function')
    const main = rt('t1', 'mainAudio')
    expect(filter!([rt('t2', 'dominantSpeaker-1'), main, rt('t3', 'dominantSpeaker-2')])).toEqual([main])
  })

  it('no Meet, sem filtro: todas as faixas remotas valem', () => {
    expect(installHook(win('meet.google.com'))).toBe('instalado')
    expect(setTrackFilter).toHaveBeenCalledWith(undefined)
  })
})
