// Troca de métodos e acessores nativos por embrulhos nossos, do jeito menos visível possível.
//
// O embrulho é criado como método abreviado de objeto (`{ [nome](...a) {} }[nome]`), como os
// nativos: não é construtor (`new pc.addTrack()` lança TypeError) e não tem `prototype`. Nome,
// `length` e as flags do descritor são copiados do original; quando o método é herdado, as
// flags vêm do protótipo que o tem de fato (operações WebIDL são enumeráveis, então o for-in da
// página continua vendo o método; Emenda 6). O que continua diferente do nativo, aceito e
// registrado na Emenda 5: `Function.prototype.toString` mostra o nosso código (não
// "[native code]") e, quando o método nativo é herdado (addEventListener do RTCPeerConnection
// vem de EventTarget.prototype), o embrulho vira propriedade própria do protótipo trocado (e
// aparece no Object.keys dele).
//
// Usado pelo registry (receptores e faixas locais) e pelos seams; quem chama continua obrigado à
// regra 1: chamar o original primeiro e devolver o que ele devolveu.

export type AnyFn = (this: any, ...args: any[]) => unknown

/** Cria um método não construtível com o nome `name` que delega para `impl`. */
export function asMethod<F extends AnyFn>(name: string, impl: F): F {
  const holder = {
    [name](this: unknown, ...args: unknown[]): unknown {
      return impl.apply(this, args)
    },
  }
  return holder[name] as F
}

function copyNameAndLength(target: AnyFn, original: AnyFn): void {
  try {
    Object.defineProperty(target, 'name', { value: original.name, configurable: true })
    Object.defineProperty(target, 'length', { value: original.length, configurable: true })
  } catch {
    // sem nome bonito, sem problema
  }
}

/**
 * Descritor de `name` no próprio objeto ou, se for herdado, no primeiro protótipo da cadeia que
 * o tem (o dono de fato).
 */
export function ownerDescriptor(obj: object, name: string): PropertyDescriptor | undefined {
  for (let o: object | null = obj; o; o = Object.getPrototypeOf(o)) {
    const desc = Object.getOwnPropertyDescriptor(o, name)
    if (desc) return desc
  }
  return undefined
}

/**
 * Troca `proto[name]` por um método que chama `wrapper` (com o mesmo `this` e argumentos).
 * Mantém nome, `length` e as flags do descritor original (do dono, se o método for herdado).
 */
export function replaceMethod(proto: object, name: string, original: AnyFn, wrapper: AnyFn): void {
  const desc = ownerDescriptor(proto, name)
  const method = asMethod(name, wrapper)
  copyNameAndLength(method, original)
  Object.defineProperty(proto, name, {
    value: method,
    writable: desc?.writable ?? true,
    enumerable: desc?.enumerable ?? false,
    configurable: true,
  })
}

/**
 * Troca o setter de `proto[name]` (mantendo o getter original). `after(this, valor)` roda
 * depois do setter original, dentro de try/catch; a exceção vai para `onError`.
 * Devolve false se a propriedade não for um acessor configurável.
 */
export function wrapSetter<T>(
  proto: object,
  name: string,
  after: (self: T, value: unknown) => void,
  onError: (e: unknown) => void,
): boolean {
  const desc = Object.getOwnPropertyDescriptor(proto, name)
  if (!desc?.set || !desc.get || !desc.configurable) return false
  const origSet = desc.set
  const holder = {
    set [name](v: unknown) {
      origSet.call(this, v)
      try {
        after(this as unknown as T, v)
      } catch (e) {
        onError(e)
      }
    },
  }
  const set = Object.getOwnPropertyDescriptor(holder, name)!.set!
  Object.defineProperty(proto, name, { configurable: true, enumerable: desc.enumerable, get: desc.get, set })
  return true
}
