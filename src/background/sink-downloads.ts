// Destino de reserva: chrome.downloads, quando o helper não está instalado ou sumiu (AC9).
// O Blob é montado no offscreen (createObjectURL não existe no SW, src/offscreen/blob.ts) e o
// SW chama downloads.download com `<pasta>/<relDir>/<arquivo>`: primeiro o áudio
// (`audio/webm`), depois os arquivos de texto a mais (o falantes.json, Emenda 18) e o info.json
// (`application/json`), por último, como no helper (AC7).
//
// Colisão de nome (AC7, " (2)"): o chrome.downloads só grava dentro da pasta de downloads e não
// deixa ver o disco. A pasta conta como ocupada se o histórico de downloads já tem um arquivo
// nela, ou se o Chrome renomeou o áudio (conflictAction 'uniquify' devolve `audio (1).webm`
// quando o arquivo já existe, mesmo que tenha vindo de outro perfil): nesse caso o arquivo
// renomeado é apagado e a próxima pasta é tentada. Dentro deste SW os salvamentos são feitos um
// de cada vez, então duas calls do mesmo minuto não disputam a mesma pasta.
import type { HostExtraFile, InfoJson } from '../shared/protocol'
import { downloadsFolderName, t } from '../shared/i18n'
import { offscreenReason } from '../shared/offscreen-reasons'
import { putSession, type SessionRecord } from './idb'
import { sendToOffscreen } from './offscreen-doc'

/**
 * Pasta dentro de Downloads usada pela reserva, no idioma da interface (Emenda 15): "Gravações de
 * calls" em português, "Call recordings" em inglês. Decidida a cada salvamento.
 */
export function downloadsFolder(): string {
  return downloadsFolderName()
}

/** Tipos dos Blobs (o Chrome ajusta a extensão do nome ao tipo). */
export const AUDIO_BLOB_TYPE = 'audio/webm'
export const INFO_BLOB_TYPE = 'application/json'

/** Quanto um download pode levar até terminar (arquivo de horas, disco lento). */
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000
const POLL_MS = 100
const MAX_SUFFIX = 100

export interface DownloadsResult {
  /** Caminho relativo à pasta de downloads. */
  path: string
  /**
   * ID do chrome.downloads de um dos arquivos da pasta (o info.json, por exemplo). Vai para as
   * últimas gravações e o "Mostrar no Finder" usa chrome.downloads.show(downloadId) (AC11).
   */
  downloadId?: number
}

const nfc = (s: string) => s.normalize('NFC')
const baseName = (p: string) => p.slice(p.lastIndexOf('/') + 1)

/** Algum download conhecido (e ainda no disco) já está dentro de `folder`? */
async function folderUsed(folder: string): Promise<boolean> {
  const needle = nfc(`/${folder}/`)
  const items = await chrome.downloads.search({})
  return items.some((d) => d.exists !== false && d.state !== 'interrupted' && nfc(d.filename).includes(needle))
}

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

/** Apaga o arquivo do disco e o item do histórico (o que ficou de uma tentativa que falhou). */
async function undo(id: number): Promise<void> {
  await chrome.downloads.removeFile(id).catch(() => {})
  await chrome.downloads.erase({ id }).catch(() => {})
}

/** Baixa e espera terminar. Se falhar, o item sai do histórico para não ocupar a pasta. */
async function download(url: string, filename: string): Promise<chrome.downloads.DownloadItem> {
  const id = await chrome.downloads.download({ url, filename, conflictAction: 'uniquify', saveAs: false })
  try {
    return await waitDone(id)
  } catch (e) {
    await undo(id)
    throw e
  }
}

async function blobUrl(sessionId: string, mime: string): Promise<string> {
  const r = await sendToOffscreen({ target: 'offscreen', t: 'offscreen:blob-url', sessionId, mime })
  if (!r?.ok || !r.url) throw new Error(t('errBlobUrl', mime, r?.error ? offscreenReason(r.error) : t('errNoAnswer')))
  return r.url
}

async function revoke(url: string | null) {
  if (!url) return
  await sendToOffscreen({ target: 'offscreen', t: 'offscreen:revoke', url }).catch(() => {})
}

/**
 * Baixa um JSON pela mesma via do info.json: o offscreen monta o Blob de `rec.downloadInfo`.
 * Devolve o item baixado.
 */
async function downloadJson(rec: SessionRecord, text: string, filename: string, urls: string[]): Promise<chrome.downloads.DownloadItem> {
  rec.downloadInfo = text
  await putSession(rec)
  const url = await blobUrl(rec.sessionId, INFO_BLOB_TYPE)
  urls.push(url)
  return download(url, filename)
}

async function save(rec: SessionRecord, relDir: string, info: InfoJson, extras: readonly HostExtraFile[] = []): Promise<DownloadsResult> {
  const parts = relDir.split('/')
  const last = parts.pop()!
  const parent = [downloadsFolder(), ...parts].join('/')
  let audioUrl: string | null = null
  const jsonUrls: string[] = []
  try {
    audioUrl = await blobUrl(rec.sessionId, AUDIO_BLOB_TYPE)
    for (let n = 1; n <= MAX_SUFFIX; n++) {
      const folder = `${parent}/${n === 1 ? last : `${last} (${n})`}`
      if (await folderUsed(folder)) continue
      const audio = await download(audioUrl, `${folder}/${rec.file}`)
      if (nfc(baseName(audio.filename)) !== nfc(rec.file)) {
        // O Chrome renomeou: a pasta já tem esse arquivo (outro perfil, ou um download apagado do
        // histórico). Desfaz e tenta o próximo nome.
        await undo(audio.id)
        continue
      }
      const done: number[] = [audio.id]
      try {
        for (const x of extras) done.push((await downloadJson(rec, x.texto, `${folder}/${x.nome}`, jsonUrls)).id)
        // info.json por último: é o marcador de "pasta completa".
        const infoItem = await downloadJson(rec, JSON.stringify(info, null, 2) + '\n', `${folder}/info.json`, jsonUrls)
        return { path: folder, downloadId: infoItem.id }
      } catch (e) {
        // Sem info.json a pasta não está completa: desfaz o áudio (e o que mais desceu), para a
        // próxima tentativa (a recuperação, a cada minuto) usar a mesma pasta em vez de deixar
        // " (2)", " (3)"... só com áudio para trás.
        for (const id of done) await undo(id)
        throw e
      }
    }
    throw new Error(t('errNoFreeName', `${parent}/${last}`))
  } finally {
    await revoke(audioUrl)
    for (const u of jsonUrls) await revoke(u)
    if (rec.downloadInfo) {
      rec.downloadInfo = null
      await putSession(rec).catch(() => {})
    }
  }
}

let chain: Promise<unknown> = Promise.resolve()

/**
 * Salva a gravação na pasta de downloads do perfil: `<pasta>/<relDir>/` (o relDir já
 * traz o nível do perfil, Emenda 1). Lança se não conseguir; o chamador mantém os chunks no
 * IndexedDB para a recuperação tentar de novo.
 */
export function saveViaDownloads(rec: SessionRecord, relDir: string, info: InfoJson, extras: readonly HostExtraFile[] = []): Promise<DownloadsResult> {
  const run = chain.then(() => save(rec, relDir, info, extras))
  chain = run.catch(() => {})
  return run
}
