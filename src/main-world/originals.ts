// Referências às APIs originais do realm, capturadas UMA vez, antes de qualquer gancho.
//
// Regra 2 do MAIN world: a nossa lógica só usa estas referências, nunca o método embrulhado.
// Assim o mixer não registra a si mesmo como fonte quando o seam "output" embrulhar
// AudioNode.connect, e o priming não aparece para o seam "elements" quando ele embrulhar
// o setter de srcObject.

type Getter<T> = (this: T) => unknown
type Setter<T> = (this: T, v: unknown) => void

function getter<T>(proto: object | undefined, name: string): Getter<T> | undefined {
  return proto ? (Object.getOwnPropertyDescriptor(proto, name)?.get as Getter<T> | undefined) : undefined
}
function setter<T>(proto: object | undefined, name: string): Setter<T> | undefined {
  return proto ? (Object.getOwnPropertyDescriptor(proto, name)?.set as Setter<T> | undefined) : undefined
}

export interface Originals {
  win: Window & typeof globalThis
  // Construtores
  RTCPeerConnection: typeof RTCPeerConnection | undefined
  webkitRTCPeerConnection: typeof RTCPeerConnection | undefined
  AudioContext: typeof AudioContext | undefined
  MediaStream: typeof MediaStream
  MediaRecorder: typeof MediaRecorder | undefined
  MediaStreamAudioDestinationNode: typeof MediaStreamAudioDestinationNode | undefined
  MediaStreamAudioSourceNode: typeof MediaStreamAudioSourceNode | undefined
  GainNode: typeof GainNode | undefined
  DelayNode: typeof DelayNode | undefined
  AnalyserNode: typeof AnalyserNode | undefined
  Audio: typeof Audio
  WeakRef: typeof WeakRef
  /** Ponte MAIN <-> relay por MessagePort (bridge.ts): a página não vê o tráfego. */
  MessageChannel: typeof MessageChannel | undefined
  // Para os seams "sources" e "output" (capturados aqui para quem os implementar não precisar
  // mexer neste arquivo). Podem faltar em frames sem WebAudio ou em versões antigas.
  AudioWorkletNode: typeof AudioWorkletNode | undefined
  AudioDestinationNode: typeof AudioDestinationNode | undefined
  /** Chrome 94+, só em janelas (MediaStreamTrackGenerator, Insertable Streams). */
  MediaStreamTrackGenerator: (new (init: { kind: 'audio' | 'video' }) => MediaStreamTrack) | undefined
  // RTCPeerConnection.prototype
  pcAddEventListener: EventTarget['addEventListener']
  pcRemoveEventListener: EventTarget['removeEventListener']
  pcOntrackGet: Getter<RTCPeerConnection> | undefined
  pcOntrackSet: Setter<RTCPeerConnection> | undefined
  pcGetReceivers: (() => RTCRtpReceiver[]) | undefined
  pcGetSenders: (() => RTCRtpSender[]) | undefined
  pcGetTransceivers: (() => RTCRtpTransceiver[]) | undefined
  pcAddTrack: RTCPeerConnection['addTrack'] | undefined
  pcAddTransceiver: RTCPeerConnection['addTransceiver'] | undefined
  pcClose: (() => void) | undefined
  pcConnectionState: Getter<RTCPeerConnection> | undefined
  senderReplaceTrack: RTCRtpSender['replaceTrack'] | undefined
  // Linha do tempo dos falantes (Emenda 18)
  pcCreateDataChannel: RTCPeerConnection['createDataChannel'] | undefined
  receiverGetContributingSources: RTCRtpReceiver['getContributingSources'] | undefined
  dataChannelLabelGet: Getter<RTCDataChannel> | undefined
  fetch: typeof fetch | undefined
  DecompressionStream: typeof DecompressionStream | undefined
  atob: ((s: string) => string) | undefined
  /** performance.timeOrigin: o carimbo do CSRC pode vir no relógio do performance.now(). */
  timeOrigin: number
  // Mídia
  getUserMedia: MediaDevices['getUserMedia'] | undefined
  getDisplayMedia: MediaDevices['getDisplayMedia'] | undefined
  trackClone: MediaStreamTrack['clone']
  streamClone: MediaStream['clone']
  streamGetAudioTracks: MediaStream['getAudioTracks']
  streamGetTracks: MediaStream['getTracks']
  mediaSrcObjectGet: Getter<HTMLMediaElement> | undefined
  mediaSrcObjectSet: Setter<HTMLMediaElement> | undefined
  mediaPausedGet: Getter<HTMLMediaElement> | undefined
  mediaPlay: HTMLMediaElement['play'] | undefined
  // WebAudio (usado pelo mixer e pelos seams sources/output)
  createMediaStreamSource: AudioContext['createMediaStreamSource'] | undefined
  /** AudioContext.prototype.createMediaStreamTrackSource (só existe em algumas versões). */
  createMediaStreamTrackSource: ((this: AudioContext, track: MediaStreamTrack) => AudioNode) | undefined
  audioNodeConnect: AudioNode['connect'] | undefined
  audioNodeDisconnect: AudioNode['disconnect'] | undefined
  // Diversos
  addEventListener: Window['addEventListener']
  removeEventListener: Window['removeEventListener']
  postMessage: Window['postMessage']
  portPostMessage: MessagePort['postMessage'] | undefined
  portStart: MessagePort['start'] | undefined
  portAddEventListener: MessagePort['addEventListener'] | undefined
  /** Fonte de tempo que a página não cancela (relógio resistente, Emenda 12). */
  MutationObserver: typeof MutationObserver | undefined
  setInterval: typeof setInterval
  clearInterval: typeof clearInterval
  setTimeout: typeof setTimeout
  clearTimeout: typeof clearTimeout
  querySelector: Document['querySelector']
  querySelectorAll: Document['querySelectorAll']
  now: () => number
  consoleDebug: Console['debug']
  /** Promise.prototype.then do realm (a página pode trocar o dela depois). */
  promiseThen: Promise<unknown>['then']
}

type HookWindow = Window &
  typeof globalThis & {
    webkitRTCPeerConnection?: typeof RTCPeerConnection
    MediaStreamTrackGenerator?: Originals['MediaStreamTrackGenerator']
  }

/**
 * Captura tudo de que precisamos. Deve ser a primeira coisa do hook. Pode lançar numa frame
 * sem alguma API básica (MediaStream, Document): quem chama (install.ts) engole o erro.
 */
export function captureOriginals(win: Window = window): Originals {
  const w = win as HookWindow
  const PC = w.RTCPeerConnection
  const pcProto = PC?.prototype
  const mediaProto = w.HTMLMediaElement?.prototype
  // createMediaStreamSource fica em AudioContext.prototype (não existe no OfflineAudioContext).
  const ctxProto = w.AudioContext?.prototype
  const nodeProto = w.AudioNode?.prototype
  return {
    win: w,
    RTCPeerConnection: PC,
    webkitRTCPeerConnection: w.webkitRTCPeerConnection,
    AudioContext: w.AudioContext,
    MediaStream: w.MediaStream,
    MediaRecorder: w.MediaRecorder,
    MediaStreamAudioDestinationNode: w.MediaStreamAudioDestinationNode,
    MediaStreamAudioSourceNode: w.MediaStreamAudioSourceNode,
    GainNode: w.GainNode,
    DelayNode: w.DelayNode,
    AnalyserNode: w.AnalyserNode,
    Audio: w.Audio,
    WeakRef: w.WeakRef,
    MessageChannel: w.MessageChannel,
    AudioWorkletNode: w.AudioWorkletNode,
    AudioDestinationNode: w.AudioDestinationNode,
    MediaStreamTrackGenerator: w.MediaStreamTrackGenerator,
    pcAddEventListener: pcProto?.addEventListener ?? w.EventTarget.prototype.addEventListener,
    pcRemoveEventListener: pcProto?.removeEventListener ?? w.EventTarget.prototype.removeEventListener,
    pcOntrackGet: getter(pcProto, 'ontrack'),
    pcOntrackSet: setter(pcProto, 'ontrack'),
    pcGetReceivers: pcProto?.getReceivers,
    pcGetSenders: pcProto?.getSenders,
    pcGetTransceivers: pcProto?.getTransceivers,
    pcAddTrack: pcProto?.addTrack,
    pcAddTransceiver: pcProto?.addTransceiver,
    pcClose: pcProto?.close,
    pcConnectionState: getter(pcProto, 'connectionState'),
    senderReplaceTrack: w.RTCRtpSender?.prototype.replaceTrack,
    pcCreateDataChannel: pcProto?.createDataChannel,
    receiverGetContributingSources: w.RTCRtpReceiver?.prototype.getContributingSources,
    dataChannelLabelGet: getter(w.RTCDataChannel?.prototype, 'label'),
    fetch: typeof w.fetch === 'function' ? w.fetch : undefined,
    DecompressionStream: w.DecompressionStream,
    atob: typeof w.atob === 'function' ? w.atob.bind(w) : undefined,
    timeOrigin: Number(w.performance?.timeOrigin) || 0,
    getUserMedia: w.MediaDevices?.prototype.getUserMedia,
    getDisplayMedia: w.MediaDevices?.prototype.getDisplayMedia,
    trackClone: w.MediaStreamTrack.prototype.clone,
    streamClone: w.MediaStream.prototype.clone,
    streamGetAudioTracks: w.MediaStream.prototype.getAudioTracks,
    streamGetTracks: w.MediaStream.prototype.getTracks,
    mediaSrcObjectGet: getter(mediaProto, 'srcObject'),
    mediaSrcObjectSet: setter(mediaProto, 'srcObject'),
    mediaPausedGet: getter(mediaProto, 'paused'),
    mediaPlay: mediaProto?.play,
    createMediaStreamSource: ctxProto?.createMediaStreamSource,
    createMediaStreamTrackSource: (ctxProto as { createMediaStreamTrackSource?: Originals['createMediaStreamTrackSource'] } | undefined)
      ?.createMediaStreamTrackSource,
    audioNodeConnect: nodeProto?.connect,
    audioNodeDisconnect: nodeProto?.disconnect,
    addEventListener: w.addEventListener,
    removeEventListener: w.removeEventListener,
    postMessage: w.postMessage,
    portPostMessage: w.MessagePort?.prototype.postMessage,
    portStart: w.MessagePort?.prototype.start,
    portAddEventListener: w.MessagePort?.prototype.addEventListener,
    MutationObserver: w.MutationObserver,
    setInterval: w.setInterval.bind(w) as typeof setInterval,
    clearInterval: w.clearInterval.bind(w) as typeof clearInterval,
    setTimeout: w.setTimeout.bind(w) as typeof setTimeout,
    clearTimeout: w.clearTimeout.bind(w) as typeof clearTimeout,
    querySelector: w.Document.prototype.querySelector,
    querySelectorAll: w.Document.prototype.querySelectorAll,
    now: w.Date.now.bind(w.Date),
    consoleDebug: w.console.debug.bind(w.console),
    promiseThen: w.Promise.prototype.then,
  }
}

/** Log discreto (nível debug: nunca vira "erro novo no console" da página, AC14). */
export function makeLog(orig: Originals): (...args: unknown[]) => void {
  return (...args: unknown[]) => {
    try {
      orig.consoleDebug('[gravador]', ...args)
    } catch {
      // nada: log nunca pode quebrar a página
    }
  }
}

/** Executa `fn` engolindo qualquer exceção (regra 1). */
export function safe<T>(log: (...a: unknown[]) => void, where: string, fn: () => T): T | undefined {
  try {
    return fn()
  } catch (e) {
    log('erro em', where, e)
    return undefined
  }
}
