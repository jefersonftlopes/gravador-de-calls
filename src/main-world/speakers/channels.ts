// Escuta passiva dos canais de dados e da descompressão (Emenda 18).
//
// - tapChannels: para cada canal de dados dos PCs registrados (criado pela página ou vindo do
//   outro lado) cujo rótulo interessa ao adaptador, põe um listener de 'message' com o
//   addEventListener original. Nada é enviado, nenhum handler da página é trocado, e o canal é o
//   mesmo objeto que a página tem. Com `lifecycle`, avisa também quando o canal é ligado e quando
//   fecha (listener de 'close', pelo mesmo addEventListener original).
// - inflate: zlib ou gzip pelo DecompressionStream nativo. Nunca rejeita (a rejeição de uma
//   promise nossa sem tratador apareceria no unhandledrejection da página): erro vira null.
import type { Registry } from '../capture/registry'
import type { Originals } from '../originals'

/** Mensagem maior que isto não é sinal de falante: ignorada sem ler. */
const MAX_MESSAGE_BYTES = 4 * 1024 * 1024
/** Saída máxima de uma descompressão. */
export const MAX_INFLATED_BYTES = 16 * 1024 * 1024

export type ChannelHandler = (data: Uint8Array | string) => void

/** Avisos opcionais do ciclo de vida dos canais escutados. */
export interface ChannelLifecycle {
  tapped?(label: string): void
  closed?(label: string): void
}

/** Converte o `data` de um MessageEvent de RTCDataChannel; Blob é lido sem bloquear. */
function toPayload(data: unknown, deliver: (d: Uint8Array | string) => void, log: (...a: unknown[]) => void): void {
  if (typeof data === 'string') {
    if (data.length <= MAX_MESSAGE_BYTES) deliver(data)
    return
  }
  if (data instanceof ArrayBuffer) {
    if (data.byteLength <= MAX_MESSAGE_BYTES) deliver(new Uint8Array(data))
    return
  }
  if (ArrayBuffer.isView(data)) {
    if (data.byteLength <= MAX_MESSAGE_BYTES) deliver(new Uint8Array(data.buffer, data.byteOffset, data.byteLength))
    return
  }
  if (typeof Blob !== 'undefined' && data instanceof Blob && data.size <= MAX_MESSAGE_BYTES) {
    data.arrayBuffer().then(
      (ab) => {
        try {
          deliver(new Uint8Array(ab))
        } catch (e) {
          log('canal (blob)', e)
        }
      },
      (e) => log('canal (blob)', e),
    )
  }
}

/** Liga os listeners nos canais com os rótulos de `handlers`. Devolve a função que desliga. */
export function tapChannels(
  orig: Originals,
  registry: Registry,
  handlers: ReadonlyMap<string, ChannelHandler>,
  log: (...a: unknown[]) => void,
  lifecycle: ChannelLifecycle = {},
): () => void {
  const seen = new WeakSet<object>()
  return registry.onDataChannel((ch) => {
    if (seen.has(ch)) return
    seen.add(ch)
    let label = ''
    try {
      label = String(orig.dataChannelLabelGet ? orig.dataChannelLabelGet.call(ch) : ch.label)
    } catch {
      return
    }
    const handler = handlers.get(label)
    if (!handler) return
    log('canal de dados', label)
    const deliver = (d: Uint8Array | string) => {
      try {
        handler(d)
      } catch (e) {
        log('canal', label, e)
      }
    }
    orig.pcAddEventListener.call(ch, 'message', (ev: Event) => {
      try {
        toPayload((ev as MessageEvent).data, deliver, log)
      } catch (e) {
        log('canal', label, e)
      }
    })
    const { tapped, closed } = lifecycle
    if (closed) {
      orig.pcAddEventListener.call(ch, 'close', () => {
        try {
          closed(label)
        } catch (e) {
          log('canal (fechou)', label, e)
        }
      })
    }
    try {
      tapped?.(label)
    } catch (e) {
      log('canal (ligado)', label, e)
    }
  })
}

/** Descomprime `bytes` (zlib = 'deflate', ou 'gzip'); null se não der. Nunca rejeita. */
export function inflate(orig: Pick<Originals, 'DecompressionStream'>, bytes: Uint8Array, format: 'deflate' | 'gzip'): Promise<Uint8Array | null> {
  const DS = orig.DecompressionStream
  if (!DS) return Promise.resolve(null)
  try {
    const ds = new DS(format)
    const writer = ds.writable.getWriter()
    // Os erros aparecem também na leitura; aqui só não podem ficar sem tratador.
    writer.write(bytes as Uint8Array<ArrayBuffer>).catch(() => {})
    writer.close().catch(() => {})
    const reader = ds.readable.getReader()
    const parts: Uint8Array[] = []
    let total = 0
    const pump = (): Promise<Uint8Array | null> =>
      reader.read().then(
        ({ done, value }) => {
          if (done) {
            const out = new Uint8Array(total)
            let off = 0
            for (const p of parts) {
              out.set(p, off)
              off += p.length
            }
            return out
          }
          total += value.length
          if (total > MAX_INFLATED_BYTES) {
            reader.cancel().catch(() => {})
            return null
          }
          parts.push(value)
          return pump()
        },
        () => null,
      )
    return pump().catch(() => null)
  } catch {
    return Promise.resolve(null)
  }
}

/** Base64 (com ou sem quebras de linha e o alfabeto de URL) para bytes; null se não for base64. */
export function fromBase64(orig: Pick<Originals, 'atob'>, text: string): Uint8Array | null {
  try {
    const clean = text.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/')
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean) || clean.length === 0) return null
    const bin = (orig.atob ?? atob)(clean)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  } catch {
    return null
  }
}
