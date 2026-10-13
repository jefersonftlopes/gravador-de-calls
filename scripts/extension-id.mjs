// Deriva o ID da extensão a partir da chave pública fixa (campo "key" do manifesto).
// Regra do Chrome: SHA-256 do SPKI em DER, primeiros 16 bytes, cada nibble mapeado em a..p.
// Uso: node scripts/extension-id.mjs   (imprime o ID)
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
export const KEY_FILE = join(ROOT, 'extension-key.json')

/** Lê a chave pública (SPKI em base64) versionada no repositório. */
export function readPublicKey() {
  const { key } = JSON.parse(readFileSync(KEY_FILE, 'utf8'))
  if (typeof key !== 'string' || key.length < 100) throw new Error(`chave inválida em ${KEY_FILE}`)
  return key
}

/** Calcula o ID da extensão a partir da chave pública em base64. */
export function extensionIdFromKey(base64Spki) {
  const der = Buffer.from(base64Spki, 'base64')
  const hex = createHash('sha256').update(der).digest('hex').slice(0, 32)
  return [...hex].map((c) => String.fromCharCode('a'.charCodeAt(0) + parseInt(c, 16))).join('')
}

export function extensionId() {
  return extensionIdFromKey(readPublicKey())
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  console.log(extensionId())
}
