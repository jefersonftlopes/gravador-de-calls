// "Mostrar no Finder" (AC11) de uma das últimas gravações. Escolhe pelo destino em que ela foi
// salva: helper (open -R no caminho absoluto) ou downloads (chrome.downloads.show). Separado de
// ui-api.ts para o vitest testar sem o chrome.*.
import type { RecentRecording } from '../shared/protocol'
import { t } from '../shared/i18n'
export { canReveal } from '../shared/recent'

export interface RevealDeps {
  hostReveal(path: string): Promise<{ ok: true } | { ok: false; error: string }>
  showDownload(downloadId: number): void
}

export type RevealResult = { ok: true } | { ok: false; error: string }

export async function revealRecording(rec: RecentRecording | undefined, deps: RevealDeps): Promise<RevealResult> {
  if (!rec) return { ok: false, error: t('errRecentNotFound') }
  if (rec.sink === 'downloads') {
    if (typeof rec.downloadId !== 'number') return { ok: false, error: t('errDownloadNoId') }
    try {
      deps.showDownload(rec.downloadId)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: String((e as Error)?.message ?? e) }
    }
  }
  return deps.hostReveal(rec.path)
}
