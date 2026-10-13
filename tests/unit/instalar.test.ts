// Instalação do helper (Emenda 10): o Chrome de marca abre o helper com as permissões de
// privacidade do macOS (TCC) do próprio Chrome, então nada que o Chrome executa pode morar em
// ~/Documents; e o node fixado pelo caminho com versão (nvm, Homebrew Cellar) some numa
// atualização. Tudo aqui roda em pastas temporárias: nunca nos caminhos padrão do usuário.
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
// @ts-expect-error módulo .mjs sem tipos
import { install } from '../../host/instalar.mjs'
// @ts-expect-error módulo .mjs sem tipos
import { defaultBinDir, defaultLogFile, HOST_DIR, listArg, parseArgs } from '../../host/args.mjs'
// @ts-expect-error módulo .mjs sem tipos
import { uninstall } from '../../host/desinstalar.mjs'

const base = mkdtempSync(join(tmpdir(), 'gravador-instalar-'))
afterAll(() => rmSync(base, { recursive: true, force: true }))

/** Manda um ping pelo wrapper, como o Chrome faria, e devolve a resposta. */
function pingThrough(wrapper: string, env: Record<string, string>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', [wrapper, 'chrome-extension://teste/'], { env: { ...process.env, ...env } })
    let buf = Buffer.alloc(0)
    child.on('exit', (code) => reject(new Error(`o wrapper saiu com ${code} sem responder`)))
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('o helper não respondeu'))
    }, 4000)
    child.stdout.on('data', (d: Buffer) => {
      buf = Buffer.concat([buf, d])
      if (buf.length < 4 || buf.length < 4 + buf.readUInt32LE(0)) return
      clearTimeout(timer)
      resolve(JSON.parse(buf.subarray(4, 4 + buf.readUInt32LE(0)).toString('utf8')))
      child.stdin.end()
    })
    const json = Buffer.from(JSON.stringify({ id: 1, op: 'ping' }))
    const head = Buffer.alloc(4)
    head.writeUInt32LE(json.length, 0)
    child.stdin.write(Buffer.concat([head, json]))
  })
}

describe('instalar o helper', () => {
  it('os caminhos padrão ficam fora de ~/Documents (TCC do Chrome)', () => {
    expect(defaultBinDir().startsWith(join(homedir(), 'Documents'))).toBe(false)
    expect(defaultLogFile().startsWith(join(homedir(), 'Documents'))).toBe(false)
    expect(defaultBinDir()).toBe(join(homedir(), 'Library', 'Application Support', 'gravador-de-calls', 'bin'))
  })

  it('copia o helper para a pasta do wrapper: o manifesto e o wrapper não apontam para a pasta do repositório', async () => {
    const bin = join(base, 'bin')
    const r = await install({ dir: join(base, 'nmh'), wrapper: join(bin, 'gravador-host.sh'), id: 'a'.repeat(32), log: join(base, 'helper.log'), config: join(base, 'config.json') })
    const manifest = JSON.parse(readFileSync(r.manifestPath, 'utf8'))
    expect(manifest.path).toBe(join(bin, 'gravador-host.sh'))
    expect(existsSync(join(bin, 'gravador-host.mjs'))).toBe(true)
    const wrapper = readFileSync(join(bin, 'gravador-host.sh'), 'utf8')
    expect(wrapper).not.toContain(HOST_DIR)
    expect(wrapper).toContain(join(bin, 'gravador-host.mjs'))
  })

  it('copia também o módulo da transcrição, o texto compartilhado e o worker (Emendas 13 e 21), e o helper copiado abre', async () => {
    const bin = join(base, 'bin-transcricao')
    await install({ dir: join(base, 'nmh-t'), wrapper: join(bin, 'gravador-host.sh'), id: 'a'.repeat(32), log: join(base, 't.log'), config: join(base, 'config.json') })
    for (const f of ['gravador-host.mjs', 'transcricao.mjs', 'texto.mjs', 'transcrever.mjs']) expect(existsSync(join(bin, f)), f).toBe(true)
    expect(await pingThrough(join(bin, 'gravador-host.sh'), {})).toMatchObject({ id: 1, ok: true, version: '0.5.0' })
  })

  it('IDs a mais (a cópia da loja) entram em allowed_origins junto com o principal', async () => {
    const ids = ['b'.repeat(32), 'c'.repeat(32)]
    const r = await install({ dir: join(base, 'nmh-ids'), wrapper: join(base, 'bin-ids', 'gravador-host.sh'), id: 'a'.repeat(32), extraIds: [...ids, 'a'.repeat(32)], log: join(base, 'ids.log') })
    expect(JSON.parse(readFileSync(r.manifestPath, 'utf8')).allowed_origins).toEqual(['a', 'b', 'c'].map((c) => `chrome-extension://${c.repeat(32)}/`))
    await expect(install({ dir: join(base, 'nmh-ids2'), wrapper: join(base, 'bin-ids2', 'gravador-host.sh'), id: 'a'.repeat(32), extraIds: ['nao-e-id'] })).rejects.toThrow(/ID de extensão inválido/)
    // Linha de comando: --id repetido ou separado por vírgula.
    expect(listArg(parseArgs(['--id', 'x,y', '--id', 'z', '--dir', 'd']).id)).toEqual(['x', 'y', 'z'])
    expect(listArg(parseArgs(['--dir', 'd']).id)).toEqual([])
  })

  it('o node gravado na instalação sumiu (nvm uninstall, brew upgrade): o wrapper acha outro e o helper abre', async () => {
    const bin = join(base, 'bin-sem-node')
    const log = join(base, 'sem-node.log')
    await install({ dir: join(base, 'nmh2'), wrapper: join(bin, 'gravador-host.sh'), id: 'a'.repeat(32), log, config: join(base, 'config.json'), node: '/nao/existe/v22.23.2/bin/node' })
    const res = await pingThrough(join(bin, 'gravador-host.sh'), {})
    expect(res).toMatchObject({ id: 1, ok: true })
  })

  it('sem nenhum node, o motivo vai para o log do helper', async () => {
    const bin = join(base, 'bin-nenhum')
    const log = join(base, 'nenhum.log')
    await install({ dir: join(base, 'nmh3'), wrapper: join(bin, 'gravador-host.sh'), id: 'a'.repeat(32), log, config: join(base, 'config.json'), node: '/nao/existe/node', fallbacks: false })
    await pingThrough(join(bin, 'gravador-host.sh'), { PATH: '/usr/bin:/bin' }).catch(() => null)
    expect(readFileSync(log, 'utf8')).toMatch(/node não encontrado/)
  })

  it('desinstalar tira o manifesto, o wrapper e a cópia do helper', async () => {
    const bin = join(base, 'bin-remover')
    await install({ dir: join(base, 'nmh4'), wrapper: join(bin, 'gravador-host.sh'), id: 'a'.repeat(32), log: join(base, 'r.log') })
    await uninstall({ dir: join(base, 'nmh4'), wrapper: join(bin, 'gravador-host.sh') })
    expect(existsSync(join(base, 'nmh4', 'com.enkode.gravador_calls.json'))).toBe(false)
    expect(existsSync(join(bin, 'gravador-host.sh'))).toBe(false)
    expect(existsSync(join(bin, 'gravador-host.mjs'))).toBe(false)
    expect(existsSync(join(bin, 'transcricao.mjs'))).toBe(false)
    expect(existsSync(join(bin, 'texto.mjs'))).toBe(false)
    expect(existsSync(join(bin, 'transcrever.mjs'))).toBe(false)
  })
})
