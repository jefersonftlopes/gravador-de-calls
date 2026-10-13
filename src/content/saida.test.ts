import { describe, expect, it } from 'vitest'
import { pageUsesSpecificOutput } from './saida'

describe('pageUsesSpecificOutput', () => {
  it('Teams real: vídeos mudos na saída padrão e um <audio> num dispositivo próprio', () => {
    const els = [
      { sinkId: '', muted: true },
      { sinkId: '', muted: true },
      { sinkId: 'f3a9c0', muted: false },
    ]
    expect(pageUsesSpecificOutput(els)).toBe(true)
  })

  it('tudo na saída padrão: devolve o som', () => {
    expect(pageUsesSpecificOutput([{ sinkId: '', muted: false }, { sinkId: '', muted: true }])).toBe(false)
  })

  it('dispositivo próprio num elemento mudo não conta', () => {
    expect(pageUsesSpecificOutput([{ sinkId: 'abc', muted: true }])).toBe(false)
  })

  it('sem elementos ou sem suporte a sinkId: saída padrão', () => {
    expect(pageUsesSpecificOutput([])).toBe(false)
    expect(pageUsesSpecificOutput([{ muted: false }])).toBe(false)
  })
})
