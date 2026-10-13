// Onde a transcrição por API é escrita (Emenda 21): a pasta da call, nos DOIS destinos.
//
// - Salva pelo helper: a operação `transcription-write` escreve os arquivos na pasta (o helper
//   confere a raiz e o nome, como no `open-file`) e grava o estado em `info.json.transcricao`, pelo
//   mesmo `updateInfoTranscription` que o worker do motor local usa. O popup então mostra
//   "Transcrição pronta" e "Abrir transcrição" sem saber quem transcreveu.
// - Salva em Downloads (o caso de quem instala pela loja, sem helper): os arquivos descem pelo
//   chrome.downloads, na mesma pasta da gravação, do mesmo jeito do sink-downloads.ts (Blob montado
//   no offscreen, porque createObjectURL não existe no service worker). O info.json NÃO é
//   reescrito: o chrome.downloads não sobrescreve um arquivo já baixado sem risco de virar
//   "info (1).json", então o estado fica na extensão (API_TRANSCRIPTION_STATE_KEY) e o popup o
//   mostra do mesmo jeito. Está declarado na Emenda 21.
import { t } from '../shared/i18n'
import { offscreenReason } from '../shared/offscreen-reasons'
import type { InfoTranscription } from '../shared/protocol'
import type { ApiAudioRecord } from './idb'
import { sendToOffscreen } from './offscreen-doc'
import { host } from './sink-host'

/** Um arquivo de texto da transcrição. */
export interface TranscriptFile {
  nome: string
  texto: string
}

/** Tipo do Blob de cada arquivo (o Chrome mantém a extensão do nome quando o tipo combina). */
function mimeOf(nome: string): string {
  if (nome.endsWith('.srt')) return 'application/x-subrip'
  return 'text/markdown'
}

export interface WriteResult {
  /** Caminho do .md (só com o helper: é o que o "Abrir transcrição" abre). */
  path: string | null
  /** chrome.downloads do .md (sem helper: o "Abrir transcrição" mostra o arquivo no Finder). */
  downloadId?: number
}

/**
 * Escreve os arquivos da transcrição na pasta da call e registra o estado. Lança quando não dá:
 * quem chama guarda o áudio e tenta de novo.
 */
export async function writeTranscript(job: Pick<ApiAudioRecord, 'savedPath' | 'sink' | 'audio'>, files: readonly TranscriptFile[], transcricao?: InfoTranscription): Promise<WriteResult> {
  if (job.sink === 'host') return writeViaHost(job, files, transcricao)
  if (files.length === 0) return { path: null }
  return writeViaDownloads(job, files)
}

async function writeViaHost(job: Pick<ApiAudioRecord, 'savedPath' | 'audio'>, files: readonly TranscriptFile[], transcricao?: InfoTranscription): Promise<WriteResult> {
  const r = await host.transcriptionWrite(job.savedPath, job.audio, files, transcricao)
  if (!r.ok) throw new Error(r.error)
  const md = files.find((f) => f.nome.endsWith('.md'))
  return { path: md ? `${job.savedPath.replace(/\/+$/, '')}/${md.nome}` : null }
}

const nfc = (s: string) => s.normalize('NFC')
const baseName = (p: string) => p.slice(p.lastIndexOf('/') + 1)
const DOWNLOAD_TIMEOUT_MS = 2 * 60_000
const POLL_MS = 100

async function waitDone(id: number): Promise<chrome.downloads.DownloadItem> {
  const t0 = Date.now()
  for (;;) {
    const [d] = await chrome.downloads.search({ id })
    if (d && d.state === 'complete') return d
    if (d && d.state === 'interrupted') throw new Error(t('errDownloadInterrupted', d.error ?? t('errDownloadNoReason')))
    if (!d) throw new Error(t('errDownloadGone', id))
    if (Date.now() - t0 > DOWNLOAD_TIMEOUT_MS) throw new Error(t('errDownloadTimeout', id, DOWNLOAD_TIMEOUT_MS))
    await new Promise((r) => setTimeout(r, POLL_MS))
  }
}

async function undo(id: number): Promise<void> {
  await chrome.downloads.removeFile(id).catch(() => {})
  await chrome.downloads.erase({ id }).catch(() => {})
}

/** Blob de texto montado no offscreen (o service worker não tem createObjectURL). */
async function textUrl(texto: string, mime: string): Promise<string> {
  const r = await sendToOffscreen({ target: 'offscreen', t: 'offscreen:text-url', texto, mime })
  if (!r?.ok || !r.url) throw new Error(t('errBlobUrl', mime, r?.error ? offscreenReason(r.error) : t('errNoAnswer')))
  return r.url
}

async function writeViaDownloads(job: Pick<ApiAudioRecord, 'savedPath'>, files: readonly TranscriptFile[]): Promise<WriteResult> {
  const urls: string[] = []
  const done: number[] = []
  let mdId: number | undefined
  try {
    for (const f of files) {
      const url = await textUrl(f.texto, mimeOf(f.nome))
      urls.push(url)
      // 'overwrite': a transcrição de novo (uma gravação reenviada) troca o arquivo em vez de
      // deixar "transcricao (2).md". O nome é conferido abaixo: se o Chrome renomeou, desfaz.
      const id = await chrome.downloads.download({ url, filename: `${job.savedPath}/${f.nome}`, conflictAction: 'overwrite', saveAs: false })
      const item = await waitDone(id).catch(async (e: unknown) => {
        await undo(id)
        throw e
      })
      if (nfc(baseName(item.filename)) !== nfc(f.nome)) {
        await undo(item.id)
        throw new Error(t('errNoFreeName', `${job.savedPath}/${f.nome}`))
      }
      done.push(item.id)
      if (f.nome.endsWith('.md')) mdId = item.id
    }
    return { path: null, ...(mdId !== undefined ? { downloadId: mdId } : {}) }
  } catch (e) {
    // Nada pela metade: o que desceu sai, e a próxima tentativa recomeça.
    for (const id of done) await undo(id)
    throw e
  } finally {
    for (const u of urls) await sendToOffscreen({ target: 'offscreen', t: 'offscreen:revoke', url: u }).catch(() => {})
  }
}
