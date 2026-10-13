// Leitura do que o helper gravou na raiz temporária.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { InfoJson } from '../../src/shared/protocol'

export interface FoundRecording {
  month: string
  folder: string
  dir: string
  info: InfoJson | null
  files: string[]
}

const MONTH_RE = /^\d{4}-\d{2}$/

/**
 * Pastas de gravação em <raiz>/[<perfil>/]<AAAA-MM>/<pasta>, ignorando o staging .gravando.
 * Sem `profile`, só olha os meses direto na raiz (pastas de perfil ficam de fora).
 */
export function findRecordings(root: string, profile?: string): FoundRecording[] {
  const baseDir = profile ? join(root, profile) : root
  if (!existsSync(baseDir)) return []
  const out: FoundRecording[] = []
  for (const month of readdirSync(baseDir)) {
    if (!MONTH_RE.test(month)) continue
    const mdir = join(baseDir, month)
    if (!statSync(mdir).isDirectory()) continue
    for (const folder of readdirSync(mdir)) {
      const dir = join(mdir, folder)
      if (!statSync(dir).isDirectory()) continue
      const files = readdirSync(dir).sort()
      const infoPath = join(dir, 'info.json')
      const info = existsSync(infoPath) ? (JSON.parse(readFileSync(infoPath, 'utf8')) as InfoJson) : null
      out.push({ month, folder, dir, info, files })
    }
  }
  return out
}

export function stagingEntries(root: string): string[] {
  const dir = join(root, '.gravando')
  return existsSync(dir) ? readdirSync(dir) : []
}
