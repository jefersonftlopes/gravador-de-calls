// Gera o par de chaves RSA que fixa o ID da extensão.
// A chave pública (SPKI em base64) vai para extension-key.json, que é versionado e lido pelo
// manifesto. A chave privada fica em .keys/extensao.pem, fora do git; ela só seria necessária
// para empacotar um .crx com o mesmo ID.
// Não sobrescreve nada que já exista (use --forcar para gerar um ID novo de propósito).
import { generateKeyPairSync } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { KEY_FILE, extensionIdFromKey } from './extension-id.mjs'

const ROOT = join(KEY_FILE, '..')
const PRIVATE = join(ROOT, '.keys', 'extensao.pem')
const force = process.argv.includes('--forcar')

if (!force && (existsSync(KEY_FILE) || existsSync(PRIVATE))) {
  console.error('A chave já existe (extension-key.json ou .keys/extensao.pem). Use --forcar para trocar o ID.')
  process.exit(1)
}

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const spki = publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
mkdirSync(join(ROOT, '.keys'), { recursive: true })
writeFileSync(PRIVATE, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
writeFileSync(KEY_FILE, JSON.stringify({ key: spki }, null, 2) + '\n')
console.log(`ID da extensão: ${extensionIdFromKey(spki)}`)
