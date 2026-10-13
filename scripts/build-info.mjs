// Versão e identificador do build, embutidos em todo bundle (Emenda 17) e gravados em
// dist/versao.json, que o npm run publicar copia para o publicado.json.
//
// O identificador é o hash das ENTRADAS do build (src/ sem os testes, public/, o manifesto, as
// configurações do Vite e as dependências travadas), não da saída: a saída contém o próprio
// identificador. Assim o mesmo código sempre dá o mesmo identificador (republicar o mesmo build
// continua permitido), e qualquer mudança no que vai para o pacote dá outro. O service worker
// compara o dele com o do publicado.json para saber que está rodando um código antigo.
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Arquivos que entram no build, além de src/ e public/. */
const ROOT_FILES = ['manifest.config.ts', 'vite.config.ts', 'package.json', 'package-lock.json', 'extension-key.json', 'tsconfig.json']

function walk(dir, out) {
  for (const name of readdirSync(dir).sort()) {
    if (name.startsWith('.')) continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (!/\.test\.tsx?$/.test(name)) out.push(p)
  }
  return out
}

/** Hash curto das entradas do build (12 hex). `store`: o pacote da loja sai diferente do de desenvolvimento. */
export function buildId({ root = ROOT, store = false } = {}) {
  const hash = createHash('sha256')
  hash.update(store ? 'loja\0' : 'dev\0')
  const files = [...walk(join(root, 'src'), []), ...walk(join(root, 'public'), []), ...ROOT_FILES.map((f) => join(root, f))]
  for (const f of files) {
    hash.update(relative(root, f))
    hash.update('\0')
    hash.update(readFileSync(f))
    hash.update('\0')
  }
  return hash.digest('hex').slice(0, 12)
}

/** `{ version, build }` do código atual (version do package.json). */
export function buildInfo({ root = ROOT, store = false } = {}) {
  const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  return { version, build: buildId({ root, store }) }
}

/** Nome do arquivo com `{ version, build }` na raiz do build. */
export const BUILD_INFO_FILE = 'versao.json'
