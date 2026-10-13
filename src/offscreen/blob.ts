// Destino downloads (AC9, fatia de durabilidade): monta o Blob de um arquivo da gravação e devolve
// um blob: URL para o SW chamar chrome.downloads.download (createObjectURL não existe no SW).
// O offscreen é página da extensão, mesma origem do SW: abre o mesmo banco `gravador` de
// src/background/idb.ts.
//
// - mime de áudio (`audio/webm`): os chunks da sessão, em ordem de seq.
// - `application/json`: o info.json que o SW deixou em `SessionRecord.downloadInfo`.
//
// O tipo do Blob decide a extensão que o Chrome mantém no nome: medido no CfT 151, um
// `data:text/plain` com nome `.json` vira `.txt` (ARQUITETURA, Emenda 5). Por isso cada arquivo
// sai com o tipo certo.
import { getChunks, getSession } from '../background/idb'
import type { OffscreenHandlers } from './handlers'

export const blobHandlers: OffscreenHandlers<'offscreen:blob-url' | 'offscreen:text-url' | 'offscreen:revoke'> = {
  // Emenda 21: um arquivo de texto da transcrição por API (transcricao.md, .srt) para o Downloads.
  'offscreen:text-url': async (req) => {
    const blob = new Blob([req.texto], { type: req.mime })
    return { ok: true, url: URL.createObjectURL(blob), bytes: blob.size }
  },
  'offscreen:blob-url': async (req) => {
    let blob: Blob
    if (req.mime.startsWith('application/json')) {
      const rec = await getSession(req.sessionId)
      if (!rec?.downloadInfo) return { ok: false, error: `sessão ${req.sessionId} sem info.json pendente` }
      blob = new Blob([rec.downloadInfo], { type: 'application/json' })
    } else {
      const chunks = await getChunks(req.sessionId)
      if (chunks.length === 0) return { ok: false, error: `sessão ${req.sessionId} sem chunks no IndexedDB` }
      blob = new Blob(
        chunks.map((c) => c.data),
        { type: req.mime },
      )
    }
    return { ok: true, url: URL.createObjectURL(blob), bytes: blob.size }
  },
  'offscreen:revoke': async (req) => {
    URL.revokeObjectURL(req.url)
    return { ok: true }
  },
}
