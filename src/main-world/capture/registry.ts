// Ganchos de WebRTC e de mídia local (seam "receivers" e exclusão do microfone).
//
// - RTCPeerConnection e webkitRTCPeerConnection trocados por um Proxy (regra 7): todo PC criado
//   na página entra no registro. O evento 'track' é ouvido com o addEventListener original na
//   própria instância e, por garantia, addEventListener('track') e o setter ontrack do protótipo
//   também registram o PC. getReceivers() dos PCs registrados é varrido a cada consulta.
// - Faixas locais (nunca gravar): resultados de getUserMedia/getDisplayMedia, seus clone(),
//   e tudo o que é usado como envio (addTrack, addTransceiver, replaceTrack, getSenders()).
//
// Os ganchos dos outros seams (srcObject, createMediaStreamSource, AudioNode.connect) ficam em
// ./seams.ts. Todo gancho chama o original primeiro e devolve exatamente o que ele devolveu
// (única exceção, Emenda 5: getUserMedia/getDisplayMedia devolvem a promise derivada que resolve
// com o mesmo stream ou rejeita com o mesmo motivo, para não marcar a promise da página como
// tratada).
import type { MicTrackState } from '../../shared/mic-gate'
import type { Originals } from '../originals'
import type { Probe } from '../platforms/types'
import { replaceMethod, wrapSetter, type AnyFn } from '../wrap'

/** Uma entrada de RTCRtpReceiver.getContributingSources() (Emenda 18). */
export interface ContributingSource {
  source: number
  timestamp: number
  rtpTimestamp?: number
  audioLevel?: number
  /**
   * Emenda 20: número do receptor de onde veio (estável enquanto o receptor existir, nunca o
   * objeto), para o diagnóstico dizer em quantos receptores cada CSRC apareceu e quais entradas são
   * do mesmo pacote (mesmo receptor, mesmo carimbo).
   */
  receiver?: number
}

export interface RemoteAudioTrack {
  track: MediaStreamTrack
  streams: readonly MediaStream[]
}

/**
 * Filtro do adaptador sobre o CONJUNTO das faixas remotas vivas (de todos os PCs), para regras
 * que dependem das outras faixas (Teams: se existe stream `mainAudio*`, só ele). Devolve o
 * subconjunto aceito; itens que não estavam na entrada são ignorados. Se lançar, vale a entrada.
 */
export type TrackFilter = (all: readonly RemoteAudioTrack[]) => readonly RemoteAudioTrack[]

export interface Registry {
  /** A faixa é local (microfone, tela, envio)? */
  isLocal(track: MediaStreamTrack): boolean
  markLocal(track: MediaStreamTrack | null | undefined): void
  /** Faixas remotas de áudio vivas, não locais, aceitas pelo filtro do adaptador. */
  remoteAudioTracks(): RemoteAudioTrack[]
  /** Toda faixa de áudio que já veio de um receptor (viva ou não), para outros seams excluírem/aceitarem. */
  isReceiverTrack(track: MediaStreamTrack): boolean
  /** Avisa quando surge uma faixa remota nova (evento 'track'). */
  onRemoteAudio(cb: () => void): () => void
  setTrackFilter(filter: TrackFilter | undefined): void
  probe(): Probe
  /**
   * Emenda 18: faixas de áudio do microfone (resultados do getUserMedia) ainda vivas. Só servem para
   * medir se você fala; nunca entram na gravação.
   */
  localMicTracks(): MediaStreamTrack[]
  /**
   * Emenda 24: o estado observado de cada faixa de microfone, para a regra do mudo
   * (src/shared/mic-gate.ts) decidir se o microfone está aberto. Este método só OBSERVA, nunca
   * decide. Diferente do `localMicTracks`, inclui a faixa que já terminou: é ela que diz que o mudo
   * foi um `track.stop()`.
   */
  micGateInputs(): MicTrackState[]
  /** Emenda 18: CSRCs de todos os receptores de áudio vivos dos PCs registrados (só leitura). */
  contributingSources(): ContributingSource[]
  /**
   * Emenda 18: avisa cada canal de dados dos PCs registrados, os criados pela página
   * (createDataChannel) e os que chegam do outro lado (evento 'datachannel').
   */
  onDataChannel(cb: (channel: RTCDataChannel) => void): () => void
}

interface PcInfo {
  closed: boolean
  hadAudio: boolean
  /** Já esteve 'connected' (Emenda 10: só um PC que já conectou "reconecta"). */
  everConnected: boolean
}

export function installRegistry(orig: Originals, log: (...a: unknown[]) => void): Registry {
  const w = orig.win as Window & typeof globalThis & { webkitRTCPeerConnection?: typeof RTCPeerConnection }
  // PCs registrados por referência FRACA: o hook nunca segura vivo um PC que a página largou sem
  // close() (o Meet cria um descartável em toda página com código). Só os PCs que já carregaram
  // áudio remoto ficam também em `strong` até fechar, para a captura não perder um PC vivo se a
  // página guardar só as faixas dele.
  const pcs = new Set<WeakRef<RTCPeerConnection>>()
  const registered = new WeakSet<RTCPeerConnection>()
  const strong = new Set<RTCPeerConnection>()
  const info = new WeakMap<RTCPeerConnection, PcInfo>()
  const locals = new WeakSet<MediaStreamTrack>()
  const receiverTracks = new WeakSet<MediaStreamTrack>()
  const trackStreams = new WeakMap<MediaStreamTrack, readonly MediaStream[]>()
  const listeners = new Set<() => void>()
  const channelListeners = new Set<(ch: RTCDataChannel) => void>()
  /** Faixas de áudio do getUserMedia (o microfone), por referência fraca. */
  const micTracks = new Set<WeakRef<MediaStreamTrack>>()
  /** Emenda 20: número de cada receptor nas entradas de CSRC (diagnóstico). */
  const receiverIds = new WeakMap<RTCRtpReceiver, number>()
  let nextReceiverId = 0
  /** Emenda 24: número de cada sender no estado das faixas de microfone (nunca o objeto). */
  const senderIds = new WeakMap<RTCRtpSender, number>()
  let nextSenderId = 0
  let filter: TrackFilter | undefined
  let audioPcClosedAt: number | null = null

  const markLocal = (t: MediaStreamTrack | null | undefined) => {
    if (t && typeof t === 'object') locals.add(t)
  }
  const markStreamLocal = (s: MediaStream, mic = false) => {
    try {
      for (const t of orig.streamGetTracks.call(s)) {
        locals.add(t)
        if (mic && t.kind === 'audio') micTracks.add(new orig.WeakRef(t))
      }
    } catch (e) {
      log('markStreamLocal', e)
    }
  }
  const notifyChannel = (ch: unknown) => {
    if (!ch || typeof ch !== 'object') return
    for (const cb of channelListeners) {
      try {
        cb(ch as RTCDataChannel)
      } catch (e) {
        log('canal de dados', e)
      }
    }
  }
  const onDataChannelEvent = (ev: Event) => {
    try {
      notifyChannel((ev as RTCDataChannelEvent).channel)
    } catch (e) {
      log('ondatachannel', e)
    }
  }
  const notify = () => {
    for (const cb of listeners) {
      try {
        cb()
      } catch (e) {
        log('listener', e)
      }
    }
  }

  const onTrack = (ev: Event) => {
    try {
      const e = ev as RTCTrackEvent
      if (e.track?.kind !== 'audio') return
      receiverTracks.add(e.track)
      trackStreams.set(e.track, Array.from(e.streams ?? []))
      notify()
    } catch (err) {
      log('onTrack', err)
    }
  }

  const markClosed = (pc: RTCPeerConnection) => {
    const i = info.get(pc)
    if (!i || i.closed) return
    i.closed = true
    strong.delete(pc)
    if (i.hadAudio) audioPcClosedAt = orig.now()
  }

  const register = (pc: RTCPeerConnection) => {
    if (!pc || typeof pc !== 'object' || registered.has(pc)) return
    registered.add(pc)
    pcs.add(new orig.WeakRef(pc))
    info.set(pc, { closed: false, hadAudio: false, everConnected: false })
    orig.pcAddEventListener.call(pc, 'track', onTrack)
    // Emenda 18: canais que o outro lado abre (o 'collections' do Meet vem do servidor).
    orig.pcAddEventListener.call(pc, 'datachannel', onDataChannelEvent)
  }

  // --- RTCPeerConnection: Proxy no construtor ---------------------------------------------------
  const PC = orig.RTCPeerConnection
  if (PC) {
    const handler: ProxyHandler<typeof RTCPeerConnection> = {
      construct(target, args, newTarget) {
        const pc = Reflect.construct(target, args, newTarget) as RTCPeerConnection
        try {
          register(pc)
        } catch (e) {
          log('register', e)
        }
        return pc
      },
    }
    const Wrapped = new Proxy(PC, handler)
    const define = (name: string, value: unknown) => {
      const desc = Object.getOwnPropertyDescriptor(w, name)
      Object.defineProperty(w, name, {
        value,
        writable: desc?.writable ?? true,
        enumerable: desc?.enumerable ?? false,
        configurable: true,
      })
    }
    define('RTCPeerConnection', Wrapped)
    const webkit = orig.webkitRTCPeerConnection
    if (webkit) define('webkitRTCPeerConnection', webkit === PC ? Wrapped : new Proxy(webkit, handler))

    const proto = PC.prototype
    // Invariante nativo: RTCPeerConnection.prototype.constructor === RTCPeerConnection (e então
    // pc.constructor === window.RTCPeerConnection). Sem isto, o global seria o Proxy e o
    // constructor do protótipo, o original. O nosso código só usa orig.RTCPeerConnection.
    {
      const desc = Object.getOwnPropertyDescriptor(proto, 'constructor')
      if (desc && desc.value === PC && desc.configurable) {
        Object.defineProperty(proto, 'constructor', { ...desc, value: Wrapped })
      }
    }
    // addEventListener('track') e ontrack: registram o PC (caso algum escape do construtor).
    const origAdd = orig.pcAddEventListener
    replaceMethod(proto, 'addEventListener', origAdd as AnyFn, function (this: RTCPeerConnection, ...args: unknown[]) {
      const r = (origAdd as (...a: unknown[]) => unknown).apply(this, args)
      try {
        if (args[0] === 'track') register(this)
      } catch (e) {
        log('addEventListener', e)
      }
      return r
    } as AnyFn)
    wrapSetter<RTCPeerConnection>(proto, 'ontrack', (pc) => register(pc), (e) => log('ontrack', e))
    // Envios: tudo o que a página manda é local.
    if (orig.pcAddTrack) {
      const o = orig.pcAddTrack
      replaceMethod(proto, 'addTrack', o as AnyFn, function (this: RTCPeerConnection, ...args: unknown[]) {
        const r = (o as (...a: unknown[]) => unknown).apply(this, args)
        try {
          markLocal(args[0] as MediaStreamTrack)
          register(this)
        } catch (e) {
          log('addTrack', e)
        }
        return r
      } as AnyFn)
    }
    if (orig.pcAddTransceiver) {
      const o = orig.pcAddTransceiver
      replaceMethod(proto, 'addTransceiver', o as AnyFn, function (this: RTCPeerConnection, ...args: unknown[]) {
        const r = (o as (...a: unknown[]) => unknown).apply(this, args)
        try {
          if (args[0] && typeof args[0] === 'object') markLocal(args[0] as MediaStreamTrack)
          register(this)
        } catch (e) {
          log('addTransceiver', e)
        }
        return r
      } as AnyFn)
    }
    if (orig.pcCreateDataChannel) {
      // Emenda 18: canais que a página cria (o 'dcrpc' do Meet, o 'main-channel' do Teams). O
      // original primeiro e o mesmo canal de volta; só um listener passivo de 'message' depois.
      const o = orig.pcCreateDataChannel
      replaceMethod(proto, 'createDataChannel', o as AnyFn, function (this: RTCPeerConnection, ...args: unknown[]) {
        const r = (o as (...a: unknown[]) => unknown).apply(this, args)
        try {
          register(this)
          notifyChannel(r)
        } catch (e) {
          log('createDataChannel', e)
        }
        return r
      } as AnyFn)
    }
    if (orig.pcClose) {
      const o = orig.pcClose
      replaceMethod(proto, 'close', o as AnyFn, function (this: RTCPeerConnection, ...args: unknown[]) {
        const r = (o as (...a: unknown[]) => unknown).apply(this, args)
        try {
          markClosed(this)
        } catch (e) {
          log('close', e)
        }
        return r
      } as AnyFn)
    }
  }
  if (orig.senderReplaceTrack && w.RTCRtpSender) {
    const o = orig.senderReplaceTrack
    replaceMethod(w.RTCRtpSender.prototype, 'replaceTrack', o as AnyFn, function (this: RTCRtpSender, ...args: unknown[]) {
      const r = (o as (...a: unknown[]) => unknown).apply(this, args)
      try {
        markLocal(args[0] as MediaStreamTrack | null)
      } catch (e) {
        log('replaceTrack', e)
      }
      return r
    } as AnyFn)
  }

  // --- Captura local: getUserMedia / getDisplayMedia / clone ------------------------------------
  const MD = w.MediaDevices?.prototype
  for (const [name, o] of [
    ['getUserMedia', orig.getUserMedia],
    ['getDisplayMedia', orig.getDisplayMedia],
  ] as const) {
    if (!MD || !o) continue
    replaceMethod(MD, name, o as AnyFn, function (this: MediaDevices, ...args: unknown[]) {
      const p = (o as (...a: unknown[]) => Promise<MediaStream>).apply(this, args)
      try {
        // A página recebe a promise DERIVADA, sem tratador de rejeição nosso: ela resolve com o
        // mesmo stream (já marcado como local antes de qualquer código da página vê-lo) ou
        // rejeita com o mesmo motivo. Uma rejeição que a página não trata continua disparando
        // o unhandledrejection dela, como sem a extensão. Anexar `.then(f, noop)` na promise
        // original marcaria a promise como tratada (Emenda 5).
        return orig.promiseThen.call(p, (s: unknown) => {
          markStreamLocal(s as MediaStream, name === 'getUserMedia')
          return s
        })
      } catch (e) {
        log(name, e)
        return p
      }
    } as AnyFn)
  }
  {
    const o = orig.trackClone
    replaceMethod(w.MediaStreamTrack.prototype, 'clone', o as AnyFn, function (this: MediaStreamTrack) {
      const c = o.call(this)
      try {
        if (locals.has(this)) locals.add(c)
      } catch (e) {
        log('track.clone', e)
      }
      return c
    } as AnyFn)
  }
  {
    const o = orig.streamClone
    replaceMethod(w.MediaStream.prototype, 'clone', o as AnyFn, function (this: MediaStream) {
      const c = o.call(this)
      try {
        const a = orig.streamGetTracks.call(this)
        const b = orig.streamGetTracks.call(c)
        a.forEach((t, i) => {
          if (locals.has(t) && b[i]) locals.add(b[i])
        })
      } catch (e) {
        log('stream.clone', e)
      }
      return c
    } as AnyFn)
  }

  // --- Consulta ---------------------------------------------------------------------------------
  const connectionState = (pc: RTCPeerConnection): string => {
    try {
      return String(orig.pcConnectionState ? orig.pcConnectionState.call(pc) : pc.connectionState)
    } catch {
      return 'closed'
    }
  }

  /**
   * Varre os PCs: poda fechados, marca envios como locais, devolve as faixas remotas por PC já
   * passadas pelo filtro do adaptador (aplicado ao conjunto de todos os PCs).
   */
  const scan = () => {
    const byPc = new Map<RTCPeerConnection, RemoteAudioTrack[]>()
    for (const ref of pcs) {
      const pc = ref.deref()
      const i = pc && info.get(pc)
      if (!pc || !i) {
        // A página largou o PC e o coletor de lixo levou: some do registro.
        pcs.delete(ref)
        continue
      }
      if (connectionState(pc) === 'closed') markClosed(pc)
      if (i.closed) {
        pcs.delete(ref)
        continue
      }
      try {
        for (const s of orig.pcGetSenders?.call(pc) ?? []) markLocal(s.track)
      } catch (e) {
        log('getSenders', e)
      }
      const list: RemoteAudioTrack[] = []
      try {
        const transceivers = orig.pcGetTransceivers?.call(pc) ?? []
        for (const r of orig.pcGetReceivers?.call(pc) ?? []) {
          const t = r.track
          if (!t || t.kind !== 'audio' || t.readyState !== 'live' || locals.has(t)) continue
          const tr = transceivers.find((x) => x.receiver === r)
          const dir = tr?.currentDirection
          if (dir && !dir.includes('recv')) continue
          receiverTracks.add(t)
          list.push({ track: t, streams: trackStreams.get(t) ?? [] })
        }
      } catch (e) {
        log('getReceivers', e)
      }
      byPc.set(pc, list)
    }
    const accepted = applyFilter(byPc)
    for (const [pc, list] of byPc) {
      const kept = accepted ? list.filter((r) => accepted.has(r.track)) : list
      byPc.set(pc, kept)
      if (kept.length > 0) {
        const i = info.get(pc)
        if (i) i.hadAudio = true
        strong.add(pc)
      }
    }
    return byPc
  }

  /** Faixas aceitas pelo filtro do adaptador (null: sem filtro, ou o filtro falhou). */
  const applyFilter = (byPc: Map<RTCPeerConnection, RemoteAudioTrack[]>): Set<MediaStreamTrack> | null => {
    if (!filter) return null
    const all: RemoteAudioTrack[] = []
    const seen = new Set<MediaStreamTrack>()
    for (const list of byPc.values()) {
      for (const r of list) {
        if (seen.has(r.track)) continue
        seen.add(r.track)
        all.push(r)
      }
    }
    if (all.length === 0) return null
    try {
      const out = filter(all)
      const accepted = new Set<MediaStreamTrack>()
      for (const r of out) if (r && seen.has(r.track)) accepted.add(r.track)
      return accepted
    } catch (e) {
      log('filtro do adaptador', e)
      return null
    }
  }

  return {
    isLocal: (t) => locals.has(t),
    markLocal,
    isReceiverTrack: (t) => receiverTracks.has(t),
    remoteAudioTracks() {
      const out: RemoteAudioTrack[] = []
      const seen = new Set<MediaStreamTrack>()
      for (const list of scan().values()) {
        for (const r of list) {
          if (seen.has(r.track)) continue
          seen.add(r.track)
          out.push(r)
        }
      }
      return out
    },
    onRemoteAudio(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    setTrackFilter(f) {
      filter = f
    },
    localMicTracks() {
      const out: MediaStreamTrack[] = []
      for (const ref of micTracks) {
        const t = ref.deref()
        if (!t) {
          micTracks.delete(ref)
          continue
        }
        // Emenda 24: a faixa que terminou fica no registro (o micGateInputs precisa dela para dizer
        // que o mudo foi um track.stop()); ela só não serve mais para medir. O registro não cresce:
        // a entrada é um WeakRef e sai quando a página larga a faixa.
        if (t.readyState === 'ended') continue
        out.push(t)
      }
      return out
    },
    micGateInputs() {
      // Quem está mandando cada faixa AGORA: os senders de todos os PCs registrados, pelo mesmo
      // getSenders que o scan() já usa (e, como lá, o que a página manda fica marcado como local,
      // para nunca entrar na gravação). Sem como ler os senders, o estado fica indeterminado
      // (`undefined`), e a regra fecha o portão por `desconhecido`: o padrão é fechado.
      const read = orig.pcGetSenders
      const bySender = new Map<MediaStreamTrack, number>()
      let sendersRead = Boolean(read)
      if (read) {
        for (const ref of pcs) {
          const pc = ref.deref()
          const i = pc && info.get(pc)
          if (!pc || !i || i.closed) continue
          try {
            for (const s of read.call(pc) ?? []) {
              const t = s.track
              if (!t) continue
              markLocal(t)
              let n = senderIds.get(s)
              if (n === undefined) senderIds.set(s, (n = ++nextSenderId))
              bySender.set(t, n)
            }
          } catch (e) {
            sendersRead = false
            log('getSenders (portão do microfone)', e)
          }
        }
      }
      const out: MicTrackState[] = []
      for (const ref of micTracks) {
        const t = ref.deref()
        if (!t) {
          micTracks.delete(ref)
          continue
        }
        out.push({
          readyState: typeof t.readyState === 'string' ? t.readyState : undefined,
          enabled: typeof t.enabled === 'boolean' ? t.enabled : undefined,
          muted: typeof t.muted === 'boolean' ? t.muted : undefined,
          sender: sendersRead ? (bySender.get(t) ?? null) : undefined,
        })
      }
      return out
    },
    contributingSources() {
      const read = orig.receiverGetContributingSources
      if (!read) return []
      const out: ContributingSource[] = []
      const idOf = (r: RTCRtpReceiver) => {
        let n = receiverIds.get(r)
        if (n === undefined) receiverIds.set(r, (n = ++nextReceiverId))
        return n
      }
      for (const ref of pcs) {
        const pc = ref.deref()
        const i = pc && info.get(pc)
        if (!pc || !i || i.closed) continue
        try {
          for (const r of orig.pcGetReceivers?.call(pc) ?? []) {
            const t = r.track
            if (!t || t.kind !== 'audio' || t.readyState !== 'live' || locals.has(t)) continue
            for (const c of read.call(r) ?? []) {
              if (typeof c?.source !== 'number' || typeof c.timestamp !== 'number') continue
              out.push({ source: c.source, timestamp: c.timestamp, rtpTimestamp: c.rtpTimestamp, audioLevel: c.audioLevel, receiver: idOf(r) })
            }
          }
        } catch (e) {
          log('getContributingSources', e)
        }
      }
      return out
    },
    onDataChannel(cb) {
      channelListeners.add(cb)
      return () => channelListeners.delete(cb)
    },
    probe() {
      const byPc = scan()
      let connected = 0
      let withAudio = false
      let reconnecting = false
      let live = 0
      for (const [pc, list] of byPc) {
        const state = connectionState(pc)
        const isConnected = state === 'connected'
        const i = info.get(pc)
        if (isConnected && i) i.everConnected = true
        if (isConnected) connected++
        live += list.length
        if (list.length > 0 && isConnected) withAudio = true
        // Emenda 10: o ICE se recuperando (VPN, troca de Wi-Fi) não é o fim da call.
        if (list.length > 0 && !isConnected && i?.everConnected && (state === 'disconnected' || state === 'connecting')) reconnecting = true
      }
      if (withAudio) audioPcClosedAt = null
      return {
        now: orig.now(),
        pcsOpen: byPc.size,
        pcsConnected: connected,
        connectedWithLiveAudio: withAudio,
        reconnectingWithAudio: reconnecting,
        liveRemoteAudioTracks: live,
        audioPcClosedAt,
      }
    },
  }
}
