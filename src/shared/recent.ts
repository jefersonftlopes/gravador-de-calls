// Regras das "últimas gravações" usadas pelo popup e pelo SW.
import type { RecentRecording } from './protocol'

/** Dá para mostrar no Finder? Helper: tem o caminho. Downloads: tem o ID do download. */
export function canReveal(rec: RecentRecording): boolean {
  return rec.sink === 'host' ? rec.path.length > 0 : typeof rec.downloadId === 'number'
}
