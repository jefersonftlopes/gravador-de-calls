import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
export const DIST = join(ROOT, 'dist')
export const ARTIFACTS = join(ROOT, 'test-results', 'gravador')
export const MIC_WAV = join(ARTIFACTS, 'mic-1000hz.wav')
export const FFMPEG = process.env.FFMPEG ?? (existsSync('/opt/homebrew/bin/ffmpeg') ? '/opt/homebrew/bin/ffmpeg' : 'ffmpeg')

/**
 * Chrome for Testing a usar. Padrão: GRAVADOR_CHROMIUM, senão o chromium mais novo já baixado em
 * ~/Library/Caches/ms-playwright (o @playwright/test 1.63 espera a revisão 1243, que não está
 * baixada aqui; a 1234 é o CfT 151 usado no laboratório). Nunca o Chrome de marca.
 */
export function chromiumPath(): string {
  if (process.env.GRAVADOR_CHROMIUM) return process.env.GRAVADOR_CHROMIUM
  const cache = join(homedir(), 'Library', 'Caches', 'ms-playwright')
  const dirs = existsSync(cache)
    ? readdirSync(cache)
        .filter((d) => /^chromium-\d+$/.test(d))
        .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))
    : []
  for (const d of dirs) {
    for (const arch of ['chrome-mac-arm64', 'chrome-mac-x64', 'chrome-mac']) {
      const p = join(cache, d, arch, 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing')
      if (existsSync(p)) return p
    }
  }
  throw new Error('Chrome for Testing não encontrado; defina GRAVADOR_CHROMIUM')
}
