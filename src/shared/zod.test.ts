// O zod da extensão sem JIT (Emenda 15): carregar o protocolo já liga o jitless, antes de qualquer
// schema validar (com o JIT, o zod tentaria Function(), que a CSP do Manifest V3 recusa).
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { settingsSchema } from './protocol'

describe('zod sem JIT', () => {
  it('o protocolo liga o jitless e os schemas continuam validando', () => {
    expect(z.config().jitless).toBe(true)
    expect(settingsSchema.safeParse({ nada: 1 }).success).toBeTypeOf('boolean')
    expect(settingsSchema.safeParse(null).success).toBe(false)
  })
})
