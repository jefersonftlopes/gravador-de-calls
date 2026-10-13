#!/usr/bin/env node
// Publica a extensão numa pasta estável (Emenda 10), fora do dist/ de trabalho.
//
//   npm run publicar                  build + cópia para ~/Library/Application Support/
//                                     gravador-de-calls/extensao
//   node scripts/publicar.mjs --dest <pasta>   outra pasta (sem build)
//
// Por quê: os perfis do Chrome carregam a pasta escolhida no "Carregar sem compactação". Se for o
// dist/, todo `npm run build` (e o `npm run test:e2e`, que faz o build antes) apaga e reescreve os
// arquivos com nomes novos enquanto as calls estão abertas, e o `npm run dev` passa a servir o
// dist/ por localhost. Publicando aqui, o dist/ fica livre para o desenvolvimento, e a extensão dos
// perfis só muda quando você publica (fora de call) e recarrega em cada perfil. O ID continua o
// mesmo (a chave está no manifesto), então "Carregar sem compactação" nesta pasta é uma vez só.
//
// Toda correção sobe a versão (pedido do usuário em 07/10/2026: é como ele confere, no popup e em
// chrome://extensions, que a atualização chegou). Por isso a publicação guarda a versão e uma
// impressão digital do build em `publicado.json` e recusa publicar código diferente com a mesma
// versão. Republicar o mesmo build é permitido.
//
// Recarga sozinha (Emenda 17): o publicado.json leva também o identificador do build (`build`, de
// dist/versao.json, scripts/build-info.mjs). O service worker de cada perfil confere esse arquivo
// a cada minuto e, quando a versão ou o build forem outros que os dele e nada estiver em uso
// (nenhuma gravação, nenhuma aba do Meet ou do Teams, nenhum volume de aba), recarrega a extensão
// sozinho. Com algo em uso, espera, e o popup mostra o aviso com "Recarregar agora".
import { createHash } from 'node:crypto'
import { cp, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const DEFAULT_SRC = path.join(ROOT, 'dist')
export const DEFAULT_DEST =
  process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Application Support', 'gravador-de-calls', 'extensao')
    : path.join(os.homedir(), '.local', 'share', 'gravador-de-calls', 'extensao')

async function exists(p) {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

export const STAMP_FILE = 'publicado.json'
/** Gravado pelo build (scripts/build-info.mjs, BUILD_INFO_FILE): `{ version, build }`. */
export const BUILD_INFO_FILE = 'versao.json'

/** O identificador do build publicado (dist/versao.json), ou null num build sem ele. */
async function readBuildId(src) {
  try {
    const info = JSON.parse(await readFile(path.join(src, BUILD_INFO_FILE), 'utf8'))
    return typeof info.build === 'string' && info.build ? info.build : null
  } catch {
    return null
  }
}

/** Impressão digital do build: caminhos relativos e conteúdo de todos os arquivos, em ordem. */
export async function fingerprint(dir) {
  const hash = createHash('sha256')
  const walk = async (rel) => {
    const entries = (await readdir(path.join(dir, rel), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))
    for (const e of entries) {
      const r = path.join(rel, e.name)
      if (e.isDirectory()) await walk(r)
      else if (r !== STAMP_FILE) {
        hash.update(r)
        hash.update('\0')
        hash.update(await readFile(path.join(dir, r)))
        hash.update('\0')
      }
    }
  }
  await walk('')
  return hash.digest('hex')
}

async function readStamp(dest) {
  try {
    return JSON.parse(await readFile(path.join(dest, STAMP_FILE), 'utf8'))
  } catch {
    return null
  }
}

/** Troca a cópia inteira de uma vez (sem sobra de arquivo velho). Devolve a pasta publicada. */
export async function publish({ src = DEFAULT_SRC, dest = DEFAULT_DEST } = {}) {
  let manifest
  try {
    manifest = JSON.parse(await readFile(path.join(src, 'manifest.json'), 'utf8'))
  } catch {
    throw new Error(`sem manifest.json em ${src}: rode npm run build antes`)
  }
  if (!manifest.key) throw new Error('o manifesto não tem a chave: o ID da extensão mudaria em cada perfil')
  const impressao = await fingerprint(src)
  const build = await readBuildId(src)
  const anterior = await readStamp(dest)
  if (anterior && anterior.versao === manifest.version && anterior.impressao !== impressao) {
    throw new Error(
      `o código mudou e a versão continua ${manifest.version}: suba a versão antes de publicar ` +
        '(npm version patch --no-git-tag-version, depois npm run publicar), senão não dá para conferir no Chrome que a atualização chegou',
    )
  }
  const tmp = `${dest}.novo-${process.pid}`
  const old = `${dest}.velha-${process.pid}`
  await rm(tmp, { recursive: true, force: true })
  await cp(src, tmp, { recursive: true })
  await writeFile(
    path.join(tmp, STAMP_FILE),
    JSON.stringify({ versao: manifest.version, impressao, ...(build ? { build } : {}), em: new Date().toISOString() }, null, 2),
  )
  if (await exists(dest)) await rename(dest, old)
  await rename(tmp, dest)
  await rm(old, { recursive: true, force: true })
  return dest
}

/** O que o publicar diz depois de publicar (Emenda 17: os perfis recarregam sozinhos quando ociosos). */
export function publishedMessage(versao, dest) {
  return [
    `Versão ${versao} publicada em:`,
    `  ${dest}`,
    '',
    'Os perfis que já carregam esta pasta recarregam sozinhos, em até 1 minuto, quando nada estiver em uso:',
    'nenhuma gravação, nenhuma aba do Meet ou do Teams aberta e nenhum volume de aba fora de 100%.',
    'Até lá o ícone mostra ↑ e o popup avisa, com o botão "Recarregar agora" (desligado durante uma gravação).',
    'Perfis ainda com a extensão de antes da 0.3.1 não recarregam sozinhos: dessa vez, use o "Recarregar agora" do popup.',
    'Para recarregar agora: o botão do popup, ou chrome://extensions > Recarregar em cada perfil',
    '(na primeira vez, "Carregar sem compactação" nesta pasta).',
    'Recarregar a extensão encerra as gravações em andamento daquele perfil: por isso a recarga sozinha espera.',
    `Confira depois: o popup e chrome://extensions mostram ${versao}.`,
  ]
}

function parseDest(argv) {
  const i = argv.indexOf('--dest')
  return i >= 0 && argv[i + 1] ? path.resolve(argv[i + 1]) : undefined
}

if (process.argv[1] && path.basename(process.argv[1]) === 'publicar.mjs') {
  publish({ dest: parseDest(process.argv.slice(2)) })
    .then(async (dest) => {
      const { versao } = (await readStamp(dest)) ?? {}
      for (const line of publishedMessage(versao, dest)) console.log(line)
    })
    .catch((e) => {
      console.error(`Falha ao publicar: ${e.message}`)
      process.exit(1)
    })
}
