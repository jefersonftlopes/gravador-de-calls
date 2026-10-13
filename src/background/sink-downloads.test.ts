// Reserva downloads (AC9) com chrome.downloads e o offscreen falsos: ordem dos arquivos (áudio e
// depois info.json), tipo de cada Blob, pasta "Gravações de calls/[perfil/]..." e colisão de nome
// virando " (2)", tanto pelo histórico quanto pelo arquivo que o Chrome renomeou.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { InfoJson } from '../shared/protocol'
import type { SessionRecord } from './idb'

const fake = vi.hoisted(() => ({
  /** Arquivos no disco (caminho relativo à pasta de downloads). */
  disk: new Set<string>(),
  /** Itens do histórico de downloads. */
  items: [] as Array<{ id: number; filename: string; state: string; exists: boolean; mime: string }>,
  blobs: new Map<string, { sessionId: string; mime: string }>(),
  revoked: [] as string[],
  downloadInfoSeen: [] as Array<string | null | undefined>,
  removed: [] as number[],
  /** Quantos downloads de info.json ainda vão terminar interrompidos (disco cheio, por exemplo). */
  failInfo: 0,
}))

const DL = '/Users/teste/Downloads'

vi.mock('./idb', () => ({
  putSession: async (rec: SessionRecord) => void fake.downloadInfoSeen.push(rec.downloadInfo),
}))

vi.mock('./offscreen-doc', () => ({
  sendToOffscreen: async (req: { t: string; sessionId?: string; mime?: string; url?: string }) => {
    if (req.t === 'offscreen:blob-url') {
      const url = `blob:x/${fake.blobs.size}`
      fake.blobs.set(url, { sessionId: req.sessionId!, mime: req.mime! })
      return { ok: true, url, bytes: 10 }
    }
    if (req.t === 'offscreen:revoke') fake.revoked.push(req.url!)
    return { ok: true }
  },
}))

function installChrome() {
  let nextId = 1
  ;(globalThis as unknown as { chrome: unknown }).chrome = {
    downloads: {
      download: async ({ url, filename }: { url: string; filename: string }) => {
        // conflictAction 'uniquify': o Chrome acrescenta " (1)" ao nome do arquivo que já existe.
        let rel = filename
        if (rel.endsWith('/info.json') && fake.failInfo > 0) {
          fake.failInfo--
          const id = nextId++
          fake.items.push({ id, filename: `${DL}/${rel}`, state: 'interrupted', exists: false, mime: fake.blobs.get(url)!.mime })
          return id
        }
        if (fake.disk.has(rel)) {
          const dot = rel.lastIndexOf('.')
          rel = `${rel.slice(0, dot)} (1)${rel.slice(dot)}`
        }
        fake.disk.add(rel)
        const id = nextId++
        fake.items.push({ id, filename: `${DL}/${rel}`, state: 'complete', exists: true, mime: fake.blobs.get(url)!.mime })
        return id
      },
      search: async (q: { id?: number }) =>
        fake.items.filter((d) => q.id === undefined || d.id === q.id).map((d) => (d.state === 'interrupted' ? { ...d, error: 'FILE_NO_SPACE' } : d)),
      removeFile: async (id: number) => {
        fake.removed.push(id)
        const d = fake.items.find((x) => x.id === id)!
        fake.disk.delete(d.filename.slice(DL.length + 1))
        d.exists = false
      },
      erase: async ({ id }: { id: number }) => {
        fake.items = fake.items.filter((d) => d.id !== id)
      },
    },
  }
}

const rec = (over: Partial<SessionRecord> = {}) => ({ sessionId: 's1', file: 'audio.webm', downloadInfo: null, ...over }) as SessionRecord
const info = { titulo: 'Daily', helper: null } as unknown as InfoJson
const REL = 'Trabalho/2026-10/2026-10-06 14h30 - Daily (Meet)'

beforeEach(() => {
  fake.disk.clear()
  fake.items = []
  fake.blobs.clear()
  fake.revoked.length = 0
  fake.downloadInfoSeen.length = 0
  fake.removed.length = 0
  fake.failInfo = 0
  installChrome()
})

describe('saveViaDownloads', () => {
  it('grava o áudio e depois o info.json em Gravações de calls/<relDir>/, cada um com o seu tipo', async () => {
    const { saveViaDownloads } = await import('./sink-downloads')
    const r = await saveViaDownloads(rec(), REL, info)
    expect(r).toEqual({ path: `Gravações de calls/${REL}`, downloadId: 2 })
    expect(fake.items.map((d) => [d.filename.slice(DL.length + 1), d.mime])).toEqual([
      [`Gravações de calls/${REL}/audio.webm`, 'audio/webm'],
      [`Gravações de calls/${REL}/info.json`, 'application/json'],
    ])
    // O info.json passou pelo IndexedDB (o offscreen lê de lá) e saiu de lá no fim.
    expect(JSON.parse(fake.downloadInfoSeen[0]!)).toEqual(info)
    expect(fake.downloadInfoSeen.at(-1)).toBeNull()
    expect(fake.revoked.sort()).toEqual([...fake.blobs.keys()].sort())
  })

  it('pasta já usada no histórico: vai para " (2)"; duas ao mesmo tempo não disputam a pasta', async () => {
    const { saveViaDownloads } = await import('./sink-downloads')
    const [a, b] = await Promise.all([saveViaDownloads(rec(), REL, info), saveViaDownloads(rec({ sessionId: 's2' }), REL, info)])
    expect([a.path, b.path]).toEqual([`Gravações de calls/${REL}`, `Gravações de calls/${REL} (2)`])
    const c = await saveViaDownloads(rec({ sessionId: 's3' }), REL, info)
    expect(c.path).toBe(`Gravações de calls/${REL} (3)`)
    // Decidido pelo histórico, antes de baixar: nenhum arquivo precisou ser desfeito.
    expect(fake.removed).toEqual([])
  })

  it('arquivo já no disco sem estar no histórico (outro perfil): desfaz o renomeado e vai para " (2)"', async () => {
    fake.disk.add(`Gravações de calls/${REL}/audio.webm`)
    const { saveViaDownloads } = await import('./sink-downloads')
    const r = await saveViaDownloads(rec(), REL, info)
    expect(r.path).toBe(`Gravações de calls/${REL} (2)`)
    expect(fake.removed).toHaveLength(1)
    expect([...fake.disk].sort()).toEqual(
      [`Gravações de calls/${REL}/audio.webm`, `Gravações de calls/${REL} (2)/audio.webm`, `Gravações de calls/${REL} (2)/info.json`].sort(),
    )
  })

  it('download interrompido: lança (os chunks ficam no IndexedDB para a recuperação)', async () => {
    const { saveViaDownloads } = await import('./sink-downloads')
    const chromeDl = (globalThis as unknown as { chrome: { downloads: { search: unknown } } }).chrome.downloads
    chromeDl.search = async (q: { id?: number }) =>
      fake.items.filter((d) => q.id === undefined || d.id === q.id).map((d) => ({ ...d, state: 'interrupted', error: 'FILE_NO_SPACE' }))
    await expect(saveViaDownloads(rec(), REL, info)).rejects.toThrow(/FILE_NO_SPACE/)
    expect(fake.revoked).toHaveLength(1)
  })

  it('o info.json falhou: desfaz o áudio, e a tentativa seguinte usa a mesma pasta (sem sobra só com áudio)', async () => {
    fake.failInfo = 1
    const { saveViaDownloads } = await import('./sink-downloads')
    await expect(saveViaDownloads(rec(), REL, info)).rejects.toThrow(/FILE_NO_SPACE/)
    expect([...fake.disk]).toEqual([])
    expect(fake.items).toEqual([])
    // A recuperação tenta de novo: a pasta continua livre.
    const r = await saveViaDownloads(rec(), REL, info)
    expect(r.path).toBe(`Gravações de calls/${REL}`)
    expect([...fake.disk].sort()).toEqual([`Gravações de calls/${REL}/audio.webm`, `Gravações de calls/${REL}/info.json`])
    expect(fake.items.map((d) => d.state)).toEqual(['complete', 'complete'])
  })
})
