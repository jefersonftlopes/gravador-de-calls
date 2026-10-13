// Descompressão dos sinais do Meet (Emenda 18): zlib e gzip pelo DecompressionStream nativo, nunca
// rejeita (erro vira null) e para no limite de saída (bomba de descompressão).
import { describe, expect, it } from 'vitest'
import { MAX_INFLATED_BYTES, inflate } from './channels'

async function compress(bytes: Uint8Array, format: 'deflate' | 'gzip'): Promise<Uint8Array> {
  const stream = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new CompressionStream(format))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

const orig = { DecompressionStream: globalThis.DecompressionStream }

describe('inflate', () => {
  it('zlib e gzip voltam aos bytes de antes', async () => {
    const data = new TextEncoder().encode('participantes da call '.repeat(200))
    for (const format of ['deflate', 'gzip'] as const) {
      expect(await inflate(orig, await compress(data, format), format)).toEqual(data)
    }
  })

  it('entrada inválida vira null, sem rejeitar', async () => {
    await expect(inflate(orig, Uint8Array.from([1, 2, 3, 4, 5]), 'gzip')).resolves.toBeNull()
    await expect(inflate(orig, await compress(Uint8Array.from([1, 2, 3]), 'gzip'), 'deflate')).resolves.toBeNull()
  })

  it('saída acima do limite vira null (bomba de descompressão); no limite, passa', async () => {
    expect(MAX_INFLATED_BYTES).toBe(16 * 1024 * 1024)
    const bomb = await compress(new Uint8Array(MAX_INFLATED_BYTES + 1), 'gzip')
    expect(bomb.length).toBeLessThan(64 * 1024)
    await expect(inflate(orig, bomb, 'gzip')).resolves.toBeNull()
    const ok = await inflate(orig, await compress(new Uint8Array(MAX_INFLATED_BYTES), 'gzip'), 'gzip')
    expect(ok?.length).toBe(MAX_INFLATED_BYTES)
  })

  it('sem DecompressionStream, null', async () => {
    await expect(inflate({ DecompressionStream: undefined }, Uint8Array.from([1]), 'gzip')).resolves.toBeNull()
  })
})
