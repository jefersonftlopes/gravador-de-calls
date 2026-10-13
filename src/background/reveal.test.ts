import { describe, expect, it } from 'vitest'
import type { RecentRecording } from '../shared/protocol'
import { canReveal, revealRecording, type RevealDeps } from './reveal'

const base: RecentRecording = {
  sessionId: 's1',
  platform: 'meet',
  kind: 'pagina',
  title: 'Daily',
  startedAt: 0,
  endedAt: 1,
  durationSeconds: 1,
  path: '/raiz/2026-10/x',
  sink: 'host',
  status: 'concluida',
}

function deps() {
  const calls: string[] = []
  const d: RevealDeps = {
    async hostReveal(path) {
      calls.push(`host:${path}`)
      return { ok: true }
    },
    showDownload(id) {
      calls.push(`download:${id}`)
    },
  }
  return { d, calls }
}

describe('revealRecording', () => {
  it('helper: abre o caminho absoluto pelo helper', async () => {
    const { d, calls } = deps()
    expect(await revealRecording(base, d)).toEqual({ ok: true })
    expect(calls).toEqual(['host:/raiz/2026-10/x'])
  })

  it('downloads: usa chrome.downloads.show com o ID guardado, nunca o helper', async () => {
    const { d, calls } = deps()
    const rec: RecentRecording = { ...base, sink: 'downloads', path: 'Gravações de calls/2026-10/x', downloadId: 42 }
    expect(canReveal(rec)).toBe(true)
    expect(await revealRecording(rec, d)).toEqual({ ok: true })
    expect(calls).toEqual(['download:42'])
  })

  it('downloads sem ID e gravação desconhecida: erro, sem chamar nada', async () => {
    const { d, calls } = deps()
    const rec: RecentRecording = { ...base, sink: 'downloads' }
    expect(canReveal(rec)).toBe(false)
    expect((await revealRecording(rec, d)).ok).toBe(false)
    expect((await revealRecording(undefined, d)).ok).toBe(false)
    expect(calls).toEqual([])
  })
})
