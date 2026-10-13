// Mixer: AudioContext próprio, um grupo por seam, analisador sem atraso, atraso de 1,5 s e
// seletor antes do destino gravado (docs/ARQUITETURA.md, "Mixer").
//
//   fonte -> MediaStreamAudioSourceNode -> grupo[seam] (GainNode soma)
//   grupo[seam] -> AnalyserNode (sem atraso, mede energia)
//   grupo[seam] -> DelayNode(1,5 s) -> seletor[seam] (GainNode 0 ou 1) -> destino (mono, explicit)
//
// Regra 4: nada nosso vai para um AudioDestinationNode. O contexto usa sinkId { type: 'none' }
// e é criado só quando a sessão começa (depois do clique de entrar, então nasce 'running').
// Todos os nós são criados pelos construtores ORIGINAIS e ligados pelo connect ORIGINAL, para o
// seam "output" (que embrulha AudioNode.connect) nunca ver o nosso grafo.
import type { SeamId } from '../../shared/protocol'
import { MIXER_DELAY_MS, SEAM_IDS } from '../../shared/constants'
import type { Originals } from '../originals'
import { ARBITRATION_TICK_MS, SPEECH_DBFS } from './arbitration'
import type { SeamSource } from './seams'

export const DELAY_SEC = MIXER_DELAY_MS / 1000
/** Constante de tempo da rampa do seletor: ~20 ms até ~95%. */
const RAMP_TIME_CONSTANT = 0.007
/**
 * Incerteza de quando o seam antigo calou: a fala é vista a cada medida (laço de 250 ms) numa
 * janela de 2048 amostras (~43 ms), então o silêncio começou até um laço e uma janela depois da
 * última medida com fala.
 */
const SPEECH_END_SLACK_SEC = ARBITRATION_TICK_MS / 1000 + 0.05
/** dBFS usado para "nenhum sinal" (JSON não tem -Infinity). */
export const FLOOR_DBFS = -200

export interface Mixer {
  readonly ctx: AudioContext
  /** Stream do destino mono que o MediaRecorder grava. */
  readonly stream: MediaStream
  readonly selected: SeamId | null
  /** Liga as fontes novas e desliga as que sumiram do seam. */
  sync(seam: SeamId, sources: readonly SeamSource[]): void
  sourceCount(seam: SeamId): number
  /** Energia instantânea (sem atraso) por seam, em dBFS. */
  measure(): Record<SeamId, { sources: number; dbfs: number }>
  /**
   * Liga o seletor de `seam` e desliga os outros (rampa curta; a primeira é imediata). A troca vale
   * para o áudio atrasado: o novo entra a partir da última fala medida no antigo e o antigo só sai
   * depois do fim provável dessa fala (os dois somados nesse intervalo curto), nunca antes do que
   * já saiu do atraso. Assim nem o fim do antigo nem o começo do novo se perdem na passagem.
   */
  select(seam: SeamId): void
  /**
   * Emenda 18: energia (dBFS, a maior entre as faixas) do microfone, para saber se você fala. Cada
   * faixa vai só para um AnalyserNode próprio, nunca para o destino gravado nem para nenhuma saída.
   */
  measureMic(tracks: readonly MediaStreamTrack[]): number
  ctxState(): AudioContextState
  close(): void
}

interface Group {
  sum: GainNode
  analyser: AnalyserNode
  delay: DelayNode
  selector: GainNode
  buf: Float32Array<ArrayBuffer>
  nodes: Map<string, MediaStreamAudioSourceNode>
}

export function createMixer(orig: Originals, log: (...a: unknown[]) => void, delaySec = DELAY_SEC): Mixer | null {
  const AC = orig.AudioContext
  if (!AC || !orig.GainNode || !orig.DelayNode || !orig.AnalyserNode || !orig.MediaStreamAudioDestinationNode || !orig.MediaStreamAudioSourceNode) {
    log('WebAudio indisponível')
    return null
  }
  const connect = (a: AudioNode, b: AudioNode) => {
    if (orig.audioNodeConnect) (orig.audioNodeConnect as (this: AudioNode, d: AudioNode) => AudioNode).call(a, b)
    else a.connect(b)
  }
  const disconnect = (a: AudioNode) => {
    try {
      if (orig.audioNodeDisconnect) (orig.audioNodeDisconnect as (this: AudioNode) => void).call(a)
      else a.disconnect()
    } catch {
      // já desligado
    }
  }

  let ctx: AudioContext
  try {
    ctx = new AC({ sinkId: { type: 'none' }, latencyHint: 'playback' } as AudioContextOptions)
  } catch (e) {
    // sinkId não suportado: sem destino físico ligado, o contexto continua mudo para o usuário.
    log('AudioContext sem sinkId', e)
    ctx = new AC({ latencyHint: 'playback' })
  }

  const dest = new orig.MediaStreamAudioDestinationNode(ctx, { channelCount: 1, channelCountMode: 'explicit' })
  const groups = new Map<SeamId, Group>()
  for (const id of SEAM_IDS) {
    const sum = new orig.GainNode(ctx, { gain: 1 })
    const analyser = new orig.AnalyserNode(ctx, { fftSize: 2048 })
    const delay = new orig.DelayNode(ctx, { maxDelayTime: Math.max(1, delaySec + 0.5), delayTime: delaySec })
    const selector = new orig.GainNode(ctx, { gain: 0 })
    connect(sum, analyser)
    connect(sum, delay)
    connect(delay, selector)
    connect(selector, dest)
    groups.set(id, { sum, analyser, delay, selector, buf: new Float32Array(analyser.fftSize), nodes: new Map() })
  }

  // Contexto suspenso (aba recarregada sem novo clique): resume() agora e a cada gesto.
  const resume = () => {
    if (ctx.state === 'suspended') ctx.resume().catch(() => {})
  }
  const onGesture = () => resume()
  const gestureOpts = { capture: true, passive: true } as AddEventListenerOptions
  orig.addEventListener.call(orig.win, 'pointerdown', onGesture, gestureOpts)
  orig.addEventListener.call(orig.win, 'keydown', onGesture, gestureOpts)
  resume()

  let selected: SeamId | null = null
  let closed = false
  const mics = new Map<MediaStreamTrack, { node: MediaStreamAudioSourceNode; analyser: AnalyserNode; buf: Float32Array<ArrayBuffer> }>()
  const rmsDbfs = (analyser: AnalyserNode, buf: Float32Array<ArrayBuffer>) => {
    analyser.getFloatTimeDomainData(buf)
    let sum = 0
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i]
    const rms = Math.sqrt(sum / buf.length)
    return rms > 0 ? Math.max(FLOOR_DBFS, 20 * Math.log10(rms)) : FLOOR_DBFS
  }
  /** Última medida com fala de cada seam, no relógio do contexto (entrada do atraso). */
  const lastSpeechAt = new Map<SeamId, number>()

  return {
    ctx,
    stream: dest.stream,
    get selected() {
      return selected
    },
    sync(seam, sources) {
      const g = groups.get(seam)
      if (!g || closed) return
      const wanted = new Set(sources.map((s) => s.key))
      for (const [key, node] of g.nodes) {
        if (!wanted.has(key)) {
          disconnect(node)
          g.nodes.delete(key)
        }
      }
      for (const s of sources) {
        if (g.nodes.has(s.key)) continue
        try {
          const node = new orig.MediaStreamAudioSourceNode!(ctx, { mediaStream: s.stream })
          connect(node, g.sum)
          g.nodes.set(s.key, node)
        } catch (e) {
          log('ligar fonte', seam, e)
        }
      }
    },
    sourceCount: (seam) => groups.get(seam)?.nodes.size ?? 0,
    measure() {
      const out = {} as Record<SeamId, { sources: number; dbfs: number }>
      for (const [id, g] of groups) {
        let dbfs = FLOOR_DBFS
        if (g.nodes.size > 0) {
          g.analyser.getFloatTimeDomainData(g.buf)
          let sum = 0
          for (let i = 0; i < g.buf.length; i++) sum += g.buf[i] * g.buf[i]
          const rms = Math.sqrt(sum / g.buf.length)
          dbfs = rms > 0 ? Math.max(FLOOR_DBFS, 20 * Math.log10(rms)) : FLOOR_DBFS
          if (dbfs > SPEECH_DBFS) lastSpeechAt.set(id, ctx.currentTime)
        }
        out[id] = { sources: g.nodes.size, dbfs }
      }
      return out
    },
    select(seam) {
      const prev = selected
      selected = seam
      const t = ctx.currentTime
      // Instantes no relógio da ENTRADA do atraso; o que entrou antes de t - delaySec já saiu.
      const played = t - delaySec
      const prevSpeech = prev ? lastSpeechAt.get(prev) : undefined
      const onAt = Math.max(played, prevSpeech ?? -Infinity)
      const offAt = Math.max(played, prevSpeech === undefined ? -Infinity : prevSpeech + SPEECH_END_SLACK_SEC)
      for (const [id, g] of groups) {
        g.selector.gain.cancelScheduledValues(t)
        if (prev === null) {
          g.selector.gain.setValueAtTime(id === seam ? 1 : 0, t)
          continue
        }
        if (id === seam) g.selector.gain.setTargetAtTime(1, Math.max(t, onAt + delaySec), RAMP_TIME_CONSTANT)
        else if (id === prev) g.selector.gain.setTargetAtTime(0, Math.max(t, offAt + delaySec), RAMP_TIME_CONSTANT)
        else g.selector.gain.setTargetAtTime(0, t, RAMP_TIME_CONSTANT)
      }
    },
    measureMic(tracks) {
      if (closed) return FLOOR_DBFS
      const wanted = new Set(tracks)
      for (const [t, m] of mics) {
        if (!wanted.has(t)) {
          disconnect(m.node)
          mics.delete(t)
        }
      }
      let best = FLOOR_DBFS
      for (const t of tracks) {
        let m = mics.get(t)
        if (!m) {
          try {
            const node = new orig.MediaStreamAudioSourceNode!(ctx, { mediaStream: new orig.MediaStream([t]) })
            const analyser = new orig.AnalyserNode!(ctx, { fftSize: 2048 })
            connect(node, analyser)
            m = { node, analyser, buf: new Float32Array(analyser.fftSize) }
            mics.set(t, m)
          } catch (e) {
            log('medir microfone', e)
            continue
          }
        }
        best = Math.max(best, rmsDbfs(m.analyser, m.buf))
      }
      return best
    },
    ctxState: () => ctx.state,
    close() {
      if (closed) return
      closed = true
      orig.removeEventListener.call(orig.win, 'pointerdown', onGesture, gestureOpts)
      orig.removeEventListener.call(orig.win, 'keydown', onGesture, gestureOpts)
      for (const g of groups.values()) for (const n of g.nodes.values()) disconnect(n)
      for (const m of mics.values()) disconnect(m.node)
      mics.clear()
      ctx.close().catch(() => {})
    },
  }
}
