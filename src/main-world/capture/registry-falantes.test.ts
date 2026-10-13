// Registro, partes da Emenda 18, numa janela falsa: createDataChannel embrulhado devolve o MESMO
// canal (regra 1) e avisa quem escuta; o canal que vem do outro lado (evento 'datachannel') também;
// o CSRC é lido dos receptores de áudio vivos (sem os locais); e o microfone do getUserMedia fica
// à mão para medir a sua fala, sem o do getDisplayMedia.
import { describe, expect, it } from 'vitest'
import type { Originals } from '../originals'
import { installRegistry } from './registry'
import { tapChannels } from '../speakers/channels'

class FakeTrack {
  readyState = 'live'
  constructor(
    readonly kind: string,
    readonly id: string,
  ) {}
  clone() {
    return new FakeTrack(this.kind, `${this.id}-clone`)
  }
}

class FakeStream {
  constructor(readonly tracks: FakeTrack[]) {}
  getTracks() {
    return this.tracks
  }
  getAudioTracks() {
    return this.tracks.filter((t) => t.kind === 'audio')
  }
  clone() {
    return new FakeStream(this.tracks.map((t) => t.clone()))
  }
}

class FakeChannel {
  listeners = new Map<string, Array<(ev: unknown) => void>>()
  constructor(readonly label: string) {}
  addEventListener(type: string, cb: (ev: unknown) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), cb])
  }
  emit(type: string, ev: unknown) {
    for (const cb of this.listeners.get(type) ?? []) cb(ev)
  }
}

function fakeWindow() {
  const created: FakeChannel[] = []
  class RTCPeerConnection {
    listeners = new Map<string, Array<(ev: unknown) => void>>()
    receivers: Array<{ track: FakeTrack; csrcs: unknown[] }> = []
    connectionState = 'connected'
    addEventListener(type: string, cb: (ev: unknown) => void) {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), cb])
    }
    emit(type: string, ev: unknown) {
      for (const cb of this.listeners.get(type) ?? []) cb(ev)
    }
    createDataChannel(label: string) {
      const ch = new FakeChannel(label)
      created.push(ch)
      return ch
    }
    getReceivers() {
      return this.receivers
    }
    getSenders() {
      return []
    }
    getTransceivers() {
      return []
    }
    close() {
      this.connectionState = 'closed'
    }
  }
  function getContributingSources(this: { csrcs: unknown[] }) {
    return this.csrcs
  }
  class MediaDevices {
    constructor(readonly next: () => FakeStream) {}
    getUserMedia() {
      return Promise.resolve(this.next())
    }
    getDisplayMedia() {
      return Promise.resolve(this.next())
    }
  }
  const win = { RTCPeerConnection, MediaDevices, MediaStreamTrack: FakeTrack, MediaStream: FakeStream }
  const pcProto = RTCPeerConnection.prototype
  const orig = {
    win,
    RTCPeerConnection,
    pcAddEventListener: pcProto.addEventListener,
    pcGetReceivers: pcProto.getReceivers,
    pcGetSenders: pcProto.getSenders,
    pcGetTransceivers: pcProto.getTransceivers,
    pcCreateDataChannel: pcProto.createDataChannel,
    pcClose: pcProto.close,
    receiverGetContributingSources: getContributingSources,
    getUserMedia: MediaDevices.prototype.getUserMedia,
    getDisplayMedia: MediaDevices.prototype.getDisplayMedia,
    trackClone: FakeTrack.prototype.clone,
    streamClone: FakeStream.prototype.clone,
    streamGetTracks: FakeStream.prototype.getTracks,
    streamGetAudioTracks: FakeStream.prototype.getAudioTracks,
    WeakRef,
    now: () => 0,
    promiseThen: Promise.prototype.then,
  } as unknown as Originals
  return { win, orig, created }
}

const noLog = () => {}

describe('registry: canais de dados (Emenda 18)', () => {
  it('createDataChannel devolve o mesmo canal e quem escuta ouve as mensagens do rótulo pedido', () => {
    const { win, orig, created } = fakeWindow()
    const reg = installRegistry(orig, noLog)
    const got: Array<Uint8Array | string> = []
    tapChannels(orig, reg, new Map([['dcrpc', (d: Uint8Array | string) => got.push(d)]]), noLog)
    const pc = new win.RTCPeerConnection()
    const ch = pc.createDataChannel('dcrpc')
    expect(ch).toBe(created[0])
    const other = pc.createDataChannel('outro') as unknown as FakeChannel
    other.emit('message', { data: 'ignorado' })
    ;(ch as unknown as FakeChannel).emit('message', { data: new Uint8Array([1, 2]).buffer })
    ;(ch as unknown as FakeChannel).emit('message', { data: 'texto' })
    expect(got).toEqual([new Uint8Array([1, 2]), 'texto'])
  })

  it('o canal do outro lado chega pelo evento datachannel do PC registrado', () => {
    const { win, orig } = fakeWindow()
    const reg = installRegistry(orig, noLog)
    const got: Array<Uint8Array | string> = []
    tapChannels(orig, reg, new Map([['collections', (d: Uint8Array | string) => got.push(d)]]), noLog)
    const pc = new win.RTCPeerConnection() as unknown as { emit(t: string, ev: unknown): void }
    const ch = new FakeChannel('collections')
    pc.emit('datachannel', { channel: ch })
    ch.emit('message', { data: new Uint8Array([7]) })
    expect(got).toEqual([new Uint8Array([7])])
  })

  it('um handler que lança não chega à página', () => {
    const { win, orig } = fakeWindow()
    const reg = installRegistry(orig, noLog)
    tapChannels(orig, reg, new Map([['dcrpc', () => { throw new Error('nosso erro') }]]), noLog)
    const ch = new win.RTCPeerConnection().createDataChannel('dcrpc') as unknown as FakeChannel
    expect(() => ch.emit('message', { data: 'x' })).not.toThrow()
  })
})

describe('registry: CSRC e microfone (Emenda 18)', () => {
  it('CSRC só dos receptores de áudio vivos e não locais', () => {
    const { win, orig } = fakeWindow()
    const reg = installRegistry(orig, noLog)
    const pc = new win.RTCPeerConnection() as unknown as { receivers: Array<{ track: FakeTrack; csrcs: unknown[] }> }
    const ended = new FakeTrack('audio', 'fim')
    ended.readyState = 'ended'
    pc.receivers = [
      { track: new FakeTrack('audio', 'a'), csrcs: [{ source: 1053, timestamp: 10, audioLevel: 0.2 }] },
      { track: new FakeTrack('video', 'v'), csrcs: [{ source: 1, timestamp: 10 }] },
      { track: ended, csrcs: [{ source: 2, timestamp: 10 }] },
      { track: new FakeTrack('audio', 'b'), csrcs: [{ source: 'x', timestamp: 10 }, { source: 2331, timestamp: 11 }] },
    ]
    expect(reg.contributingSources()).toEqual([
      { source: 1053, timestamp: 10, rtpTimestamp: undefined, audioLevel: 0.2, receiver: 1 },
      { source: 2331, timestamp: 11, rtpTimestamp: undefined, audioLevel: undefined, receiver: 2 },
    ])
    // Emenda 20: o número do receptor é o mesmo na leitura seguinte (diagnóstico do mesmo pacote).
    pc.receivers[0].csrcs = [{ source: 1053, timestamp: 12 }, { source: 42, timestamp: 12 }]
    expect(reg.contributingSources().map((c) => [c.source, c.receiver])).toEqual([
      [1053, 1],
      [42, 1],
      [2331, 2],
    ])
  })

  it('o microfone é o áudio do getUserMedia (não o da tela) e some quando termina', async () => {
    const { win, orig } = fakeWindow()
    const reg = installRegistry(orig, noLog)
    const mic = new FakeTrack('audio', 'mic')
    const screenAudio = new FakeTrack('audio', 'tela')
    const md = new win.MediaDevices(() => new FakeStream([mic, new FakeTrack('video', 'cam')]))
    await (md as unknown as MediaDevices).getUserMedia({ audio: true })
    const md2 = new win.MediaDevices(() => new FakeStream([screenAudio]))
    await (md2 as unknown as MediaDevices).getDisplayMedia()
    expect(reg.localMicTracks()).toEqual([mic])
    expect(reg.isLocal(screenAudio as unknown as MediaStreamTrack)).toBe(true)
    mic.readyState = 'ended'
    expect(reg.localMicTracks()).toEqual([])
  })
})
