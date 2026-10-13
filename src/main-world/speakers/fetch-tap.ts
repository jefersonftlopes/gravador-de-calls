// Leitura passiva da resposta de UMA chamada de rede da página (Emenda 18): o Meet busca a lista de
// participantes em .../MeetingSpaceService/SyncMeetingSpaceCollections (texto base64 de protobuf),
// mais ou menos a cada minuto.
//
// Regra 1: o fetch original roda primeiro. Para qualquer outra URL, a página recebe exatamente a
// promise do original. Para a URL da lista, recebe a promise derivada que resolve com a MESMA
// Response (ou rejeita com o mesmo motivo), como o getUserMedia da Emenda 5: sem tratador de
// rejeição nosso, a rejeição que a página não trata continua chegando ao unhandledrejection dela.
// O clone é lido sem esperar (a página nunca espera por nós) e o corpo original fica intacto.
import type { Originals } from '../originals'
import { replaceMethod, type AnyFn } from '../wrap'

function urlOf(input: unknown): string {
  try {
    if (typeof input === 'string') return input
    if (input && typeof input === 'object') {
      const u = (input as { url?: unknown; href?: unknown }).url ?? (input as { href?: unknown }).href
      if (typeof u === 'string') return u
    }
  } catch {
    // nada
  }
  return ''
}

export function tapFetch(orig: Originals, match: RegExp, onText: (text: string) => void, log: (...a: unknown[]) => void): boolean {
  const o = orig.fetch
  if (!o) return false
  replaceMethod(orig.win, 'fetch', o as AnyFn, function (this: unknown, ...args: unknown[]) {
    const p = (o as (...a: unknown[]) => Promise<Response>).apply(this, args)
    try {
      if (!match.test(urlOf(args[0]))) return p
      return orig.promiseThen.call(p, (r: unknown) => {
        try {
          const res = r as Response
          if (res && res.ok) {
            res
              .clone()
              .text()
              .then(
                (text) => {
                  try {
                    onText(text)
                  } catch (e) {
                    log('fetch (roster)', e)
                  }
                },
                () => {},
              )
          }
        } catch (e) {
          log('fetch (clone)', e)
        }
        return r
      })
    } catch (e) {
      log('fetch', e)
      return p
    }
  } as AnyFn)
  return true
}
