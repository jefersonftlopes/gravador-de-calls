// Regra 1 do MAIN world: nada nosso sobe para a página, nem numa frame sem as APIs de mídia.
import { describe, expect, it } from 'vitest'
import { HOOK_SYMBOL } from '../shared/constants'
import { installHook } from './install'

describe('installHook', () => {
  it('numa frame sem MediaStream/MediaStreamTrack/Document não lança e marca a instalação', () => {
    const win = { location: { hostname: 'meet.google.com' } } as unknown as Window
    expect(() => installHook(win)).not.toThrow()
    expect(installHook({ location: { hostname: 'meet.google.com' } } as unknown as Window)).toBe('falhou')
    expect((win as unknown as Record<symbol, unknown>)[Symbol.for(HOOK_SYMBOL)]).toBe(true)
  })

  it('instala uma vez por realm', () => {
    const win = { location: { hostname: 'meet.google.com' } } as unknown as Window
    installHook(win)
    expect(installHook(win)).toBe('ja-instalado')
  })

  it('janela que não aceita a marca: desiste sem lançar', () => {
    const win = Object.freeze({ location: { hostname: 'meet.google.com' } }) as unknown as Window
    expect(installHook(win)).toBe('falhou')
  })
})
