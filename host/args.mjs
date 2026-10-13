// Utilidades compartilhadas por instalar.mjs e desinstalar.mjs.
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

export const HOST_NAME = 'com.enkode.gravador_calls'
/** Pasta do helper no repositório (a fonte; o Chrome executa a cópia instalada, Emenda 10). */
export const HOST_DIR = path.dirname(fileURLToPath(import.meta.url))
export const HOST_SCRIPT = path.join(HOST_DIR, 'gravador-host.mjs')
export const HOST_FILE = 'gravador-host.mjs'
/**
 * Arquivos do helper copiados na instalação (Emenda 13): o helper, o módulo da transcrição, o
 * texto compartilhado com a extensão (Emenda 21) e o worker destacado que ele abre. O primeiro é o
 * que o wrapper executa. Sem o texto.mjs a cópia instalada não sobe (o transcricao.mjs o importa).
 */
export const HOST_FILES = [HOST_FILE, 'transcricao.mjs', 'texto.mjs', 'transcrever.mjs']
export const WRAPPER_FILE = 'gravador-host.sh'

/**
 * Onde o helper é instalado (Emenda 10): fora de ~/Documents, ~/Desktop e ~/Downloads, que o macOS
 * protege (TCC) e que o Chrome de marca, como processo responsável pelo helper, pode não ter
 * permissão para ler. Também desliga o helper da pasta do repositório (mover o repo não o quebra).
 */
export function defaultBinDir() {
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'gravador-de-calls', 'bin')
  return path.join(os.homedir(), '.local', 'share', 'gravador-de-calls', 'bin')
}

export const DEFAULT_WRAPPER = path.join(defaultBinDir(), WRAPPER_FILE)

/** Log padrão do helper (o stderr dele): o motivo de ele não abrir fica escrito em algum lugar. */
export function defaultLogFile() {
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Logs', 'gravador-de-calls', 'helper.log')
  return path.join(os.homedir(), '.local', 'state', 'gravador-de-calls', 'helper.log')
}

/** Pasta de manifestos de native messaging do Chrome de marca, por usuário. */
export function defaultManifestDir() {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts')
  }
  if (process.platform === 'linux') return path.join(os.homedir(), '.config', 'google-chrome', 'NativeMessagingHosts')
  throw new Error('sistema não suportado: no Windows o manifesto vai no registro (não implementado)')
}

/** Lê `--chave valor` e `--chave=valor`. Uma chave repetida vira lista (`--id a --id b`). */
export function parseArgs(argv) {
  const out = {}
  const put = (k, v) => {
    if (!(k in out)) out[k] = v
    else out[k] = [...(Array.isArray(out[k]) ? out[k] : [out[k]]), v]
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const eq = a.indexOf('=')
    if (eq > 0) put(a.slice(2, eq), a.slice(eq + 1))
    else if (argv[i + 1] && !argv[i + 1].startsWith('--')) put(a.slice(2), argv[++i])
    else put(a.slice(2), true)
  }
  return out
}

/** `--id a,b --id c` vira ['a', 'b', 'c'] (sem repetidos). */
export function listArg(value) {
  const raw = value === undefined || value === true ? [] : Array.isArray(value) ? value : [value]
  return [...new Set(raw.flatMap((v) => String(v).split(',')).map((v) => v.trim()).filter(Boolean))]
}

export function resolvePath(p) {
  if (p === '~') return os.homedir()
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2))
  return path.resolve(p)
}
