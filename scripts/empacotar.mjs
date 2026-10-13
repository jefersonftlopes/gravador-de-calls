#!/usr/bin/env node
// Pacote para a Chrome Web Store (Emenda 13): build sem a chave de desenvolvimento num zip em
// artifacts/ (fora do git). Não envia nada para a loja; o que ainda falta está em docs/LOJA.md.
//
//   npm run empacotar      build com GRAVADOR_LOJA=1 em artifacts/loja/extensao e
//                          artifacts/gravador-de-calls-<versão>.zip
//
// O build de desenvolvimento (npm run build, npm run publicar) continua com a chave: o ID da
// extensão instalada sem compactação nunca muda. A loja recusa um manifesto com "key" e dá o ID
// dela; por isso este script falha se a chave ainda estiver no manifesto. Os mapas de fonte (.map)
// ficam fora do zip.
//
// Emenda 15: GRAVADOR_LOJA=1 também tira os ganchos de teste do service worker
// (globalThis.__gravador) e põe o site em homepage_url. O script confere as duas coisas e as
// mensagens da língua padrão antes de zipar.
import { spawnSync } from 'node:child_process'
import { readdir, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { crc32, deflateRawSync } from 'node:zlib'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const ARTIFACTS = path.join(ROOT, 'artifacts')
export const STORE_DIR = path.join(ARTIFACTS, 'loja', 'extensao')

/** Confere o manifesto do pacote da loja. Lança com o motivo. */
export function checkStoreManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') throw new Error('manifest.json ilegível')
  if ('key' in manifest) throw new Error('o manifesto do pacote da loja ainda tem "key": a Chrome Web Store recusa (o build não usou GRAVADOR_LOJA=1?)')
  if (manifest.manifest_version !== 3) throw new Error('o pacote precisa ser Manifest V3')
  if (typeof manifest.version !== 'string' || !/^\d+(\.\d+){0,3}$/.test(manifest.version)) throw new Error(`versão inválida: ${manifest.version}`)
  if (typeof manifest.homepage_url !== 'string' || !manifest.homepage_url.startsWith('https://')) {
    throw new Error('o manifesto do pacote da loja precisa de homepage_url com https (o site da política de privacidade)')
  }
}

/** `__gravador` sozinho: o gancho de teste do SW (o `__gravador__` da ponte MAIN <-> relay é outra coisa). */
export const TEST_HOOK_RE = /__gravador(?!__)/

/** Confere os arquivos do pacote: mensagens da língua padrão e nenhum gancho de teste. Lança com o motivo. */
export async function checkStoreFiles(src, manifest, files) {
  if (manifest.default_locale && !files.includes(`_locales/${manifest.default_locale}/messages.json`)) {
    throw new Error(`falta _locales/${manifest.default_locale}/messages.json (default_locale do manifesto)`)
  }
  for (const name of files.filter((f) => f.endsWith('.js'))) {
    if (TEST_HOOK_RE.test(await readFile(path.join(src, name), 'utf8'))) throw new Error(`o pacote ainda tem o gancho de teste __gravador em ${name} (o build não usou GRAVADOR_LOJA=1?)`)
  }
}

/** Arquivos do pacote (caminhos relativos com /), sem mapas de fonte, em ordem. */
export async function listFiles(dir, rel = '') {
  const out = []
  for (const e of (await readdir(path.join(dir, rel), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const r = rel ? `${rel}/${e.name}` : e.name
    if (e.isDirectory()) out.push(...(await listFiles(dir, r)))
    else if (!r.endsWith('.map') && e.name !== '.DS_Store') out.push(r)
  }
  return out
}

/**
 * Zip mínimo (deflate, sem dependências), suficiente para a loja: cabeçalho local, diretório
 * central e fim do diretório, datas fixas (o mesmo build dá o mesmo zip).
 */
export function buildZip(entries) {
  const locals = []
  const centrals = []
  let offset = 0
  const DOS_TIME = 0
  const DOS_DATE = (2026 - 1980) << 9 | 1 << 5 | 1
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8')
    const deflated = deflateRawSync(data, { level: 9 })
    const useDeflate = deflated.length < data.length
    const body = useDeflate ? deflated : data
    const crc = crc32(data) >>> 0
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6) // nomes em UTF-8
    local.writeUInt16LE(useDeflate ? 8 : 0, 8)
    local.writeUInt16LE(DOS_TIME, 10)
    local.writeUInt16LE(DOS_DATE, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)
    locals.push(local, nameBuf, body)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(useDeflate ? 8 : 0, 10)
    central.writeUInt16LE(DOS_TIME, 12)
    central.writeUInt16LE(DOS_DATE, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, nameBuf)
    offset += local.length + nameBuf.length + body.length
  }
  const centralBuf = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralBuf.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, centralBuf, end])
}

/** Zipa a pasta do build da loja depois de conferir o manifesto. Devolve o caminho do zip. */
export async function pack({ src = STORE_DIR, outDir = ARTIFACTS } = {}) {
  const manifest = JSON.parse(await readFile(path.join(src, 'manifest.json'), 'utf8'))
  checkStoreManifest(manifest)
  const files = await listFiles(src)
  await checkStoreFiles(src, manifest, files)
  const entries = []
  for (const name of files) entries.push({ name, data: await readFile(path.join(src, name)) })
  await mkdir(outDir, { recursive: true })
  const zip = path.join(outDir, `gravador-de-calls-${manifest.version}.zip`)
  await writeFile(zip, buildZip(entries))
  return { zip, files: files.length, bytes: (await stat(zip)).size, version: manifest.version }
}

function buildForStore() {
  const vite = path.join(ROOT, 'node_modules', '.bin', 'vite')
  const r = spawnSync(vite, ['build', '--outDir', STORE_DIR, '--emptyOutDir'], { cwd: ROOT, stdio: 'inherit', env: { ...process.env, GRAVADOR_LOJA: '1' } })
  if (r.status !== 0) throw new Error(`o build da loja falhou (código ${r.status})`)
}

if (process.argv[1] && path.basename(process.argv[1]) === 'empacotar.mjs') {
  ;(async () => {
    await rm(STORE_DIR, { recursive: true, force: true })
    buildForStore()
    const r = await pack()
    console.log(`Pacote da loja (versão ${r.version}, ${r.files} arquivos, ${(r.bytes / 1024).toFixed(0)} KB):\n  ${r.zip}`)
    console.log('Sem a chave de desenvolvimento: instalado pela loja, o ID será outro (npm run instalar -- --id <id da loja>).')
    console.log('Antes de enviar, confira docs/LOJA.md.')
  })().catch((e) => {
    console.error(`Falha ao empacotar: ${e.message}`)
    process.exit(1)
  })
}
