// Flags do descritor do embrulho (Emenda 6): o método trocado continua enumerável quando o
// original era, inclusive quando ele é herdado (no navegador, operações WebIDL são enumeráveis e
// o addEventListener do RTCPeerConnection vem de EventTarget.prototype).
import { describe, expect, it } from 'vitest'
import { ownerDescriptor, replaceMethod, type AnyFn } from './wrap'

function webIdlLike() {
  class Base {}
  class Derived extends Base {}
  // Como o WebIDL: operações enumeráveis, graváveis e configuráveis.
  Object.defineProperty(Base.prototype, 'listen', {
    value: function listen(_a: unknown, _b: unknown) {
      return 'base'
    },
    writable: true,
    enumerable: true,
    configurable: true,
  })
  Object.defineProperty(Derived.prototype, 'own', {
    value: function own() {
      return 'own'
    },
    writable: true,
    enumerable: true,
    configurable: true,
  })
  return { Base, Derived }
}

describe('replaceMethod', () => {
  it('método herdado: copia as flags do protótipo dono e o for-in continua vendo o método', () => {
    const { Base, Derived } = webIdlLike()
    const orig = (Base.prototype as unknown as { listen: AnyFn }).listen
    replaceMethod(Derived.prototype, 'listen', orig, function (this: unknown, ...a: unknown[]) {
      return orig.apply(this, a)
    } as AnyFn)
    const desc = Object.getOwnPropertyDescriptor(Derived.prototype, 'listen')!
    expect(desc).toMatchObject({ enumerable: true, writable: true, configurable: true })
    const seen: string[] = []
    for (const k in new Derived()) seen.push(k)
    expect(seen.sort()).toEqual(['listen', 'own'])
    expect((new Derived() as unknown as { listen: AnyFn }).listen(1, 2)).toBe('base')
    expect(desc.value.name).toBe('listen')
    expect(desc.value.length).toBe(2)
  })

  it('método próprio não enumerável continua não enumerável', () => {
    class C {
      m() {
        return 1
      }
    }
    const orig = C.prototype.m as AnyFn
    replaceMethod(C.prototype, 'm', orig, function (this: unknown) {
      return orig.call(this)
    } as AnyFn)
    expect(Object.getOwnPropertyDescriptor(C.prototype, 'm')).toMatchObject({ enumerable: false, writable: true })
    expect(Object.keys(C.prototype)).toEqual([])
  })

  it('redefinir uma chave própria não muda a ordem do Object.keys', () => {
    const { Derived } = webIdlLike()
    Object.defineProperty(Derived.prototype, 'depois', { value: () => 0, enumerable: true, configurable: true, writable: true })
    const before = Object.keys(Derived.prototype)
    const orig = (Derived.prototype as unknown as { own: AnyFn }).own
    replaceMethod(Derived.prototype, 'own', orig, orig)
    expect(Object.keys(Derived.prototype)).toEqual(before)
  })

  it('ownerDescriptor acha o dono na cadeia e devolve undefined quando ninguém tem', () => {
    const { Base, Derived } = webIdlLike()
    expect(ownerDescriptor(Derived.prototype, 'listen')?.value).toBe((Base.prototype as unknown as { listen: unknown }).listen)
    expect(ownerDescriptor(Derived.prototype, 'nada')).toBeUndefined()
  })
})
