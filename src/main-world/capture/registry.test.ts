// Registro numa janela falsa: o que os testes ponta a ponta não alcançam com facilidade.
// - getUserMedia devolve a promise derivada (Emenda 5): mesmo valor, mesmo motivo, e a rejeição
//   não fica "tratada" por nós;
// - o filtro do adaptador vê o conjunto das faixas de todos os PCs (Emenda 5);
// - os embrulhos não são construtíveis, como os métodos nativos;
// - cada embrulho devolve exatamente o que o original devolveu (regra 1, mesma identidade).
import { describe, expect, it } from 'vitest'
import type { Originals } from '../originals'
import { installRegistry, type RemoteAudioTrack } from './registry'

class FakeTrack {
  readyState = 'live'
  constructor(
    readonly kind: string,
    readonly id: string,
  ) {}
  clone() {
    const c = new FakeTrack(this.kind, `${this.id}-clone`)
    returned.trackClone = c
    return c
  }
}

/** O que cada original falso devolveu por último (para conferir a identidade do retorno). */
const returned: Record<string, unknown> = {}

class FakeStream {
  constructor(
    readonly id: string,
    readonly tracks: FakeTrack[],
  ) {}
  getTracks() {
    return this.tracks
  }
  getAudioTracks() {
    return this.tracks.filter((t) => t.kind === 'audio')
  }
  clone() {
    const c = new FakeStream(`${this.id}-clone`, this.tracks.map((t) => t.clone()))
    returned.streamClone = c
    return c
  }
}

function fakeWindow(gum: () => Promise<unknown>) {
  class RTCPeerConnection {
    receivers: Array<{ track: FakeTrack }> = []
    connectionState = 'connected'
    addEventListener() {
      // O nativo devolve undefined; aqui um objeto, para provar que o embrulho repassa o valor.
      return (returned.addEventListener = { from: 'addEventListener' })
    }
    addTrack(track: FakeTrack) {
      return (returned.addTrack = { track })
    }
    addTransceiver() {
      return (returned.addTransceiver = { from: 'addTransceiver' })
    }
    close() {
      this.connectionState = 'closed'
      return (returned.close = { from: 'close' })
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
    set ontrack(_v: unknown) {}
    get ontrack() {
      return null
    }
  }
  class MediaDevices {
    getUserMedia() {
      return gum()
    }
    getDisplayMedia() {
      return gum()
    }
  }
  const win = {
    RTCPeerConnection,
    MediaDevices,
    RTCRtpSender: class {
      replaceTrack() {
        return (returned.replaceTrack = Promise.resolve())
      }
    },
    MediaStreamTrack: FakeTrack,
    MediaStream: FakeStream,
  }
  const pcProto = RTCPeerConnection.prototype
  const orig = {
    win,
    RTCPeerConnection,
    pcAddEventListener: pcProto.addEventListener,
    pcGetReceivers: pcProto.getReceivers,
    pcGetSenders: pcProto.getSenders,
    pcGetTransceivers: pcProto.getTransceivers,
    pcAddTrack: pcProto.addTrack,
    pcAddTransceiver: pcProto.addTransceiver,
    pcClose: pcProto.close,
    pcConnectionState: undefined,
    senderReplaceTrack: win.RTCRtpSender.prototype.replaceTrack,
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
  return { win, orig }
}

const noLog = () => {}

describe('getUserMedia embrulhado', () => {
  it('resolve com o mesmo stream, já marcado como local antes do then da página', async () => {
    const mic = new FakeStream('mic', [new FakeTrack('audio', 'mic-1')])
    const { win, orig } = fakeWindow(() => Promise.resolve(mic))
    const reg = installRegistry(orig, noLog)
    const md = new win.MediaDevices()
    const seenLocal = await md.getUserMedia().then((s) => reg.isLocal((s as FakeStream).tracks[0] as unknown as MediaStreamTrack))
    expect(seenLocal).toBe(true)
    expect(await md.getUserMedia()).toBe(mic)
  })

  it('rejeita com o mesmo motivo, sem nenhum tratador de rejeição nosso na promise original', async () => {
    const reason = new DOMException('negado', 'NotAllowedError')
    const { win, orig } = fakeWindow(() => Promise.reject(reason))
    // Registra cada then que o registro faz na promise original. Um tratador de rejeição ali
    // marcaria a promise como tratada e calaria o unhandledrejection da página (no navegador
    // isso é medido em tests/e2e/integridade.spec.ts).
    const thenCalls: Array<{ onRejected: unknown }> = []
    const realThen = Promise.prototype.then
    ;(orig as { promiseThen: unknown }).promiseThen = function (this: Promise<unknown>, onF: never, onR: never) {
      thenCalls.push({ onRejected: onR })
      return realThen.call(this, onF, onR)
    }
    installRegistry(orig, noLog)
    const md = new win.MediaDevices()
    await expect(md.getUserMedia()).rejects.toBe(reason)
    expect(thenCalls).toHaveLength(1)
    expect(thenCalls[0].onRejected).toBeUndefined()
  })
})

describe('filtro do adaptador', () => {
  it('recebe as faixas de todos os PCs de uma vez e só as escolhidas saem', () => {
    const { win, orig } = fakeWindow(() => Promise.resolve(null))
    const reg = installRegistry(orig, noLog)
    const a = new win.RTCPeerConnection()
    const b = new win.RTCPeerConnection()
    const main = new FakeTrack('audio', 'main')
    const dom = new FakeTrack('audio', 'dom')
    const other = new FakeTrack('audio', 'outra')
    a.receivers.push({ track: main }, { track: dom })
    b.receivers.push({ track: other })
    const calls: string[][] = []
    reg.setTrackFilter((all: readonly RemoteAudioTrack[]) => {
      calls.push(all.map((r) => (r.track as unknown as FakeTrack).id))
      return all.filter((r) => (r.track as unknown as FakeTrack).id === 'main')
    })
    const ids = reg.remoteAudioTracks().map((r) => (r.track as unknown as FakeTrack).id)
    expect(calls.at(-1)).toEqual(['main', 'dom', 'outra'])
    expect(ids).toEqual(['main'])
    expect(reg.probe()).toMatchObject({ pcsOpen: 2, connectedWithLiveAudio: true, liveRemoteAudioTracks: 1 })
  })

  it('filtro que lança ou devolve faixa desconhecida não tira nem inventa faixa', () => {
    const { win, orig } = fakeWindow(() => Promise.resolve(null))
    const reg = installRegistry(orig, noLog)
    const pc = new win.RTCPeerConnection()
    pc.receivers.push({ track: new FakeTrack('audio', 'x') })
    reg.setTrackFilter(() => {
      throw new Error('bug do adaptador')
    })
    expect(reg.remoteAudioTracks()).toHaveLength(1)
    reg.setTrackFilter(() => [{ track: new FakeTrack('audio', 'intrusa') as unknown as MediaStreamTrack, streams: [] }])
    expect(reg.remoteAudioTracks()).toHaveLength(0)
  })
})

describe('reconexão (Emenda 10)', () => {
  it('um PC que já tocou áudio e cai para disconnected ou connecting conta como reconectando; failed não', () => {
    const { win, orig } = fakeWindow(() => Promise.resolve(null))
    const reg = installRegistry(orig, noLog)
    const pc = new win.RTCPeerConnection()
    pc.receivers.push({ track: new FakeTrack('audio', 'a') })
    expect(reg.probe()).toMatchObject({ connectedWithLiveAudio: true, reconnectingWithAudio: false })
    pc.connectionState = 'disconnected'
    expect(reg.probe()).toMatchObject({ connectedWithLiveAudio: false, reconnectingWithAudio: true })
    pc.connectionState = 'connecting'
    expect(reg.probe()).toMatchObject({ connectedWithLiveAudio: false, reconnectingWithAudio: true })
    pc.connectionState = 'failed'
    expect(reg.probe()).toMatchObject({ connectedWithLiveAudio: false, reconnectingWithAudio: false })
  })

  it('um PC que nunca conectou (o descartável do Meet, ou um novo ainda negociando) não conta', () => {
    const { win, orig } = fakeWindow(() => Promise.resolve(null))
    const reg = installRegistry(orig, noLog)
    const pc = new win.RTCPeerConnection()
    pc.connectionState = 'connecting'
    pc.receivers.push({ track: new FakeTrack('audio', 'b') })
    expect(reg.probe()).toMatchObject({ connectedWithLiveAudio: false, reconnectingWithAudio: false })
    pc.connectionState = 'disconnected'
    expect(reg.probe()).toMatchObject({ reconnectingWithAudio: false })
  })
})

describe('embrulhos', () => {
  it('não são construtíveis e mantêm nome e tamanho', () => {
    const { win, orig } = fakeWindow(() => Promise.resolve(null))
    installRegistry(orig, noLog)
    const proto = win.RTCPeerConnection.prototype as unknown as Record<string, (...a: unknown[]) => unknown>
    for (const name of ['addTrack', 'addTransceiver', 'close', 'addEventListener']) {
      const fn = proto[name]
      expect(fn.name, name).toBe(name)
      expect('prototype' in fn, name).toBe(false)
      expect(() => new (fn as unknown as new () => unknown)(), name).toThrow(TypeError)
    }
    const gum = win.MediaDevices.prototype.getUserMedia as unknown as new () => unknown
    expect(() => new gum()).toThrow(TypeError)
    expect(win.MediaDevices.prototype.getUserMedia.length).toBe(0)
  })
})

describe('retorno dos embrulhos (regra 1)', () => {
  it('cada embrulho devolve o mesmo objeto que o original devolveu', async () => {
    const mic = new FakeStream('mic', [new FakeTrack('audio', 'mic-1')])
    const { win, orig } = fakeWindow(() => Promise.resolve(mic))
    const reg = installRegistry(orig, noLog)
    const pc = new win.RTCPeerConnection()
    const track = mic.tracks[0]

    expect(pc.addTrack(track)).toBe(returned.addTrack)
    expect(reg.isLocal(track as unknown as MediaStreamTrack)).toBe(true)
    expect(pc.addTransceiver()).toBe(returned.addTransceiver)
    expect(pc.addEventListener()).toBe(returned.addEventListener)
    const sender = new win.RTCRtpSender()
    expect(sender.replaceTrack()).toBe(returned.replaceTrack)

    const tc = track.clone()
    expect(tc).toBe(returned.trackClone)
    expect(reg.isLocal(tc as unknown as MediaStreamTrack)).toBe(true)
    const sc = mic.clone()
    expect(sc).toBe(returned.streamClone)
    expect(reg.isLocal(sc.tracks[0] as unknown as MediaStreamTrack)).toBe(true)

    expect(pc.close()).toBe(returned.close)
    expect(await new win.MediaDevices().getUserMedia()).toBe(mic)
    expect(await new win.MediaDevices().getDisplayMedia()).toBe(mic)
  })

  it('o original que lança: a exceção da página sobe igual, sem nada nosso no meio', () => {
    const { win, orig } = fakeWindow(() => Promise.resolve(null))
    const boom = new TypeError('addTrack inválido')
    ;(orig as { pcAddTrack: unknown }).pcAddTrack = () => {
      throw boom
    }
    installRegistry(orig, noLog)
    const pc = new win.RTCPeerConnection()
    expect(() => pc.addTrack(new FakeTrack('audio', 'x'))).toThrow(boom)
  })
})
