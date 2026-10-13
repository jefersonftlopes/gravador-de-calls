// Embrulho do window.fetch do Meet (Emenda 18), regra 1: o original roda primeiro; fora da URL da
// roster a página recebe a MESMA promise do original; na URL da roster, a promise derivada resolve
// com a MESMA Response (corpo intacto para a página) ou rejeita com o MESMO motivo, e o clone é
// lido sem a página esperar por nós.
import { describe, expect, it, vi } from 'vitest'
import type { Originals } from '../originals'
import { tapFetch } from './fetch-tap'

const ROSTER = /\/roster(?:[?#]|$)/

function setup(impl: (input: unknown) => Promise<Response>) {
  const original = vi.fn(function fetch(input: unknown) {
    return impl(input)
  })
  const win = { fetch: original } as unknown as Window & typeof globalThis
  const orig = { fetch: original, win, promiseThen: Promise.prototype.then } as unknown as Originals
  const texts: string[] = []
  const logs: unknown[][] = []
  expect(tapFetch(orig, ROSTER, (t) => texts.push(t), (...a) => logs.push(a))).toBe(true)
  return { win, original, texts, logs }
}

const settle = () => new Promise((r) => setTimeout(r, 10))

describe('tapFetch', () => {
  it('fora da URL da roster, a página recebe exatamente a promise do original', async () => {
    let made: Promise<Response> | null = null
    const { win, original, texts } = setup(() => (made = Promise.resolve(new Response('outro'))))
    const p = win.fetch('https://meet.google.com/outra', { method: 'POST' })
    expect(p).toBe(made)
    expect(original).toHaveBeenCalledWith('https://meet.google.com/outra', { method: 'POST' })
    await p
    await settle()
    expect(texts).toEqual([])
  })

  it('na URL da roster: a mesma Response, o corpo inteiro para a página e o clone lido por nós', async () => {
    const res = new Response('corpo da roster')
    const { win, texts } = setup(() => Promise.resolve(res))
    const p = win.fetch(new Request('https://meet.google.com/roster?x=1'))
    const got = await p
    expect(got).toBe(res)
    expect(await got.text()).toBe('corpo da roster')
    await settle()
    expect(texts).toEqual(['corpo da roster'])
  })

  it('resposta que não é ok não é lida', async () => {
    const { win, texts } = setup(() => Promise.resolve(new Response('erro', { status: 500 })))
    await win.fetch('https://meet.google.com/roster')
    await settle()
    expect(texts).toEqual([])
  })

  it('a rejeição do original chega à página com o mesmo motivo', async () => {
    const motivo = new TypeError('Failed to fetch')
    const { win } = setup(() => Promise.reject(motivo))
    await expect(win.fetch('https://meet.google.com/roster')).rejects.toBe(motivo)
    let other: Promise<Response> | null = null
    const s2 = setup(() => (other = Promise.reject(motivo)))
    const p2 = s2.win.fetch('https://meet.google.com/outra')
    expect(p2).toBe(other)
    await expect(p2).rejects.toBe(motivo)
  })

  it('o embrulho se chama fetch e um onText que lança não chega à página', async () => {
    const original = function fetch() {
      return Promise.resolve(new Response('x'))
    }
    const win = { fetch: original } as unknown as Window & typeof globalThis
    const logs: unknown[][] = []
    tapFetch({ fetch: original, win, promiseThen: Promise.prototype.then } as unknown as Originals, ROSTER, () => {
      throw new Error('quebrou')
    }, (...a) => logs.push(a))
    expect(win.fetch.name).toBe('fetch')
    const r = await win.fetch('https://meet.google.com/roster')
    expect(await r.text()).toBe('x')
    await settle()
    expect(logs.some((l) => l[0] === 'fetch (roster)')).toBe(true)
  })

  it('sem fetch original, não embrulha', () => {
    expect(tapFetch({ fetch: undefined, win: {} } as unknown as Originals, ROSTER, () => {}, () => {})).toBe(false)
  })
})
