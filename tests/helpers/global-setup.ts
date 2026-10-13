// Gera o WAV do microfone falso (1000 Hz) e confere que a extensão foi construída.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { ARTIFACTS, DIST, FFMPEG, MIC_WAV } from './paths'

export default function globalSetup() {
  if (!existsSync(`${DIST}/manifest.json`)) throw new Error('dist/ não existe: rode npm run build antes (npm run test:e2e já faz isso)')
  mkdirSync(ARTIFACTS, { recursive: true })
  if (!existsSync(MIC_WAV)) {
    execFileSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'aevalsrc=0.5*sin(2*PI*1000*t):s=48000:d=180', '-ac', '1', '-c:a', 'pcm_s16le', MIC_WAV])
  }
}
