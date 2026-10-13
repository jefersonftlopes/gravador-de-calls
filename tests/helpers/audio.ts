// Análise do áudio gravado: ffmpeg decodifica para PCM mono 16 kHz e um Goertzel por janela de
// 1 s mede a energia de cada tom (em dBFS de amplitude: um seno de amplitude A dá 20*log10(A)).
import { execFileSync } from 'node:child_process'
import { FFMPEG } from './paths'

export const RATE = 16000

/** Decodifica qualquer arquivo de áudio para PCM mono 16 kHz (mesmo comando do README). */
export function decodePcm(file: string): Float32Array {
  const out = execFileSync(
    FFMPEG,
    ['-v', 'error', '-i', file, '-af', 'aresample=async=1', '-ar', String(RATE), '-ac', '1', '-f', 's16le', '-c:a', 'pcm_s16le', '-'],
    { maxBuffer: 512 * 1024 * 1024 },
  )
  const samples = new Float32Array(out.length / 2)
  for (let i = 0; i < samples.length; i++) samples[i] = out.readInt16LE(i * 2) / 32768
  return samples
}

/** Amplitude do tom `freq` no trecho [start, start+len), em dBFS. */
export function goertzelDb(samples: Float32Array, start: number, len: number, freq: number, rate = RATE): number {
  const k = Math.round((len * freq) / rate)
  const w = (2 * Math.PI * k) / len
  const coeff = 2 * Math.cos(w)
  let s1 = 0
  let s2 = 0
  for (let i = 0; i < len; i++) {
    // Janela de Hann para o vazamento espectral não esconder um tom fraco perto de um forte.
    const hann = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (len - 1))
    const s0 = samples[start + i] * hann + coeff * s1 - s2
    s2 = s1
    s1 = s0
  }
  const power = s1 * s1 + s2 * s2 - coeff * s1 * s2
  // Hann tem ganho coerente 0,5: amplitude = 2*|X|/(N*0,5).
  const amp = (2 * Math.sqrt(Math.max(power, 0))) / (len * 0.5)
  return amp > 0 ? 20 * Math.log10(amp) : -200
}

export interface WindowMeasure {
  second: number
  db: Record<number, number>
}

/** Mede cada janela de 1 s inteira. */
export function measureWindows(samples: Float32Array, freqs: number[], rate = RATE): WindowMeasure[] {
  const out: WindowMeasure[] = []
  for (let s = 0; (s + 1) * rate <= samples.length; s++) {
    const db: Record<number, number> = {}
    for (const f of freqs) db[f] = goertzelDb(samples, s * rate, rate, f, rate)
    out.push({ second: s, db })
  }
  return out
}

export function median(xs: number[]): number {
  const a = [...xs].sort((x, y) => x - y)
  return a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2
}
