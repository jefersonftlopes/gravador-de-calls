// Gravador: MediaRecorder webm/opus 32 kbps sobre o destino mono do mixer, fatias de 5 s.
// Cada `dataavailable` com bytes vira um chunk com `seq` crescente a partir de 0. O chunk 0 tem o
// cabeçalho EBML: sem ele nada decodifica.
import { RECORDING_KBPS, RECORDING_MIME, RECORDING_TIMESLICE_MS } from '../../shared/constants'
import type { Originals } from '../originals'

export interface RecorderChunk {
  seq: number
  blob: Blob
  at: number
}

export interface Recorder {
  readonly state: RecordingState | 'none'
  /** Último seq emitido (-1 se nenhum). */
  readonly lastSeq: number
  readonly bytes: number
  start(): void
  /** Pede o pedaço atual sem parar (usado no pagehide). */
  requestData(): void
  /** Para e resolve com o último seq, depois do último `dataavailable`. */
  stop(): Promise<number>
}

export function createRecorder(
  orig: Originals,
  stream: MediaStream,
  onChunk: (c: RecorderChunk) => void,
  log: (...a: unknown[]) => void,
): Recorder | null {
  const MR = orig.MediaRecorder
  if (!MR) {
    log('MediaRecorder indisponível')
    return null
  }
  let rec: MediaRecorder
  try {
    rec = new MR(stream, { mimeType: RECORDING_MIME, audioBitsPerSecond: RECORDING_KBPS * 1000 })
  } catch (e) {
    log('MediaRecorder', e)
    return null
  }
  let seq = 0
  let bytes = 0
  let stopped: Promise<number> | null = null
  rec.addEventListener('dataavailable', (ev) => {
    try {
      const blob = (ev as BlobEvent).data
      if (!blob || blob.size === 0) return
      bytes += blob.size
      onChunk({ seq: seq++, blob, at: orig.now() })
    } catch (e) {
      log('dataavailable', e)
    }
  })
  rec.addEventListener('error', (ev) => log('MediaRecorder erro', (ev as ErrorEvent).error ?? ev))
  return {
    get state() {
      return rec.state
    },
    get lastSeq() {
      return seq - 1
    },
    get bytes() {
      return bytes
    },
    start() {
      rec.start(RECORDING_TIMESLICE_MS)
    },
    requestData() {
      try {
        if (rec.state === 'recording') rec.requestData()
      } catch (e) {
        log('requestData', e)
      }
    },
    stop() {
      if (stopped) return stopped
      stopped = new Promise<number>((resolve) => {
        if (rec.state === 'inactive') return resolve(seq - 1)
        // 'stop' dispara depois do último 'dataavailable'.
        rec.addEventListener('stop', () => resolve(seq - 1), { once: true })
        try {
          rec.stop()
        } catch (e) {
          log('stop', e)
          resolve(seq - 1)
        }
      })
      return stopped
    },
  }
}
