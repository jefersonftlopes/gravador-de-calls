// O instrumento do teste ponta a ponta precisa ser capaz de falhar: se o microfone (1000 Hz)
// vazasse na gravação, o Goertzel tem de enxergar. Gera arquivos com ffmpeg e mede.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { decodePcm, measureWindows, median } from '../helpers/audio'
import { FFMPEG } from '../helpers/paths'

const dir = mkdtempSync(join(tmpdir(), 'gravador-audio-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

/** WebM/Opus 32 kbps mono (mesmo formato da extensão) com 440 Hz a 0,5 e 1000 Hz na amplitude dada. */
function makeWebm(name: string, micAmp: number): string {
  const file = join(dir, name)
  const expr = `0.5*sin(2*PI*440*t)+${micAmp}*sin(2*PI*1000*t)`
  execFileSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', `aevalsrc=${expr}:s=48000:d=6`, '-ac', '1', '-c:a', 'libopus', '-b:a', '32k', file])
  return file
}

describe('medição de tons (Goertzel)', () => {
  it('mede 440 Hz a 0,5 como cerca de -6 dBFS', () => {
    const w = measureWindows(decodePcm(makeWebm('so-440.webm', 0)), [440, 1000]).slice(1, -1)
    expect(median(w.map((x) => x.db[440]))).toBeGreaterThan(-8)
    expect(median(w.map((x) => x.db[440]))).toBeLessThan(-4)
    for (const x of w) expect(x.db[1000]).toBeLessThan(x.db[440] - 30)
  })

  it('acusa o microfone vazado a -20 dBFS (a regra dos 30 dB falharia)', () => {
    const w = measureWindows(decodePcm(makeWebm('vazou.webm', 0.1)), [440, 1000]).slice(1, -1)
    const mic = median(w.map((x) => x.db[1000]))
    expect(mic).toBeGreaterThan(-23)
    expect(mic).toBeLessThan(-17)
    expect(w.every((x) => x.db[1000] <= x.db[440] - 30)).toBe(false)
  })

  it('acusa até um vazamento fraco, 34 dB abaixo do tom remoto', () => {
    const w = measureWindows(decodePcm(makeWebm('fraco.webm', 0.01)), [440, 1000]).slice(1, -1)
    expect(median(w.map((x) => x.db[1000]))).toBeGreaterThan(-45)
  })
})
