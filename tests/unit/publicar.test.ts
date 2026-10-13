// Pasta estável da extensão (Emenda 10): os perfis do Chrome carregam uma cópia publicada, não o
// dist/ de trabalho, que todo build (inclusive o do npm run test:e2e) apaga e reescreve com nomes
// novos. Tudo aqui roda em pastas temporárias.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
// @ts-expect-error módulo .mjs sem tipos
import { DEFAULT_DEST, publish, publishedMessage } from '../../scripts/publicar.mjs'

const base = mkdtempSync(join(tmpdir(), 'gravador-publicar-'))
afterAll(() => rmSync(base, { recursive: true, force: true }))

function fakeBuild(dir: string, hash: string, version = '0.1.0') {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(dir, 'assets'), { recursive: true })
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Gravador de Calls', key: 'chave', version }))
  writeFileSync(join(dir, 'assets', `vigia-${hash}.js`), `// ${hash}`)
}

describe('publicar a extensão numa pasta estável', () => {
  it('a pasta padrão fica fora de ~/Documents e do dist/ de trabalho', () => {
    expect(DEFAULT_DEST).toBe(join(homedir(), 'Library', 'Application Support', 'gravador-de-calls', 'extensao'))
  })

  it('troca a cópia inteira: o mesmo caminho, só os arquivos do build novo', async () => {
    const src = join(base, 'dist')
    const dest = join(base, 'extensao')
    fakeBuild(src, 'AAAA1111')
    expect(await publish({ src, dest })).toBe(dest)
    expect(readdirSync(join(dest, 'assets'))).toEqual(['vigia-AAAA1111.js'])
    fakeBuild(src, 'BBBB2222', '0.1.1')
    expect(await publish({ src, dest })).toBe(dest)
    expect(readdirSync(join(dest, 'assets'))).toEqual(['vigia-BBBB2222.js'])
    expect(JSON.parse(readFileSync(join(dest, 'manifest.json'), 'utf8')).key).toBe('chave')
    // Nada de sobras ao lado.
    expect(readdirSync(base).sort()).toEqual(['dist', 'extensao'])
  })

  it('código novo com a mesma versão é recusado e a cópia publicada fica como estava; o mesmo build pode ser republicado', async () => {
    const src = join(base, 'dist-versao')
    const dest = join(base, 'extensao-versao')
    fakeBuild(src, 'CCCC3333', '0.2.0')
    await publish({ src, dest })
    expect(JSON.parse(readFileSync(join(dest, 'publicado.json'), 'utf8'))).toMatchObject({ versao: '0.2.0' })
    // Republicar o mesmo build: permitido.
    await publish({ src, dest })
    // Código diferente, versão igual: recusado, sem tocar no que está publicado.
    fakeBuild(src, 'DDDD4444', '0.2.0')
    await expect(publish({ src, dest })).rejects.toThrow(/suba a versão/)
    expect(readdirSync(join(dest, 'assets'))).toEqual(['vigia-CCCC3333.js'])
    // Com a versão nova, passa.
    fakeBuild(src, 'DDDD4444', '0.2.1')
    await publish({ src, dest })
    expect(readdirSync(join(dest, 'assets'))).toEqual(['vigia-DDDD4444.js'])
    expect(JSON.parse(readFileSync(join(dest, 'publicado.json'), 'utf8'))).toMatchObject({ versao: '0.2.1' })
  })

  it('o publicado.json leva o identificador do build (dist/versao.json), que o SW compara com o dele (Emenda 17)', async () => {
    const src = join(base, 'dist-build')
    const dest = join(base, 'extensao-build')
    fakeBuild(src, 'EEEE5555', '0.3.1')
    writeFileSync(join(src, 'versao.json'), JSON.stringify({ version: '0.3.1', build: 'abc123def456' }))
    await publish({ src, dest })
    expect(JSON.parse(readFileSync(join(dest, 'publicado.json'), 'utf8'))).toMatchObject({ versao: '0.3.1', build: 'abc123def456', impressao: expect.any(String) })
    // Um build sem o versao.json (de antes da 0.3.1) publica sem o campo: o SW compara só a versão.
    const old = join(base, 'dist-sem-build')
    fakeBuild(old, 'FFFF6666', '0.3.2')
    await publish({ src: old, dest })
    expect(JSON.parse(readFileSync(join(dest, 'publicado.json'), 'utf8'))).not.toHaveProperty('build')
  })

  it('depois de publicar, diz que os perfis recarregam sozinhos quando nada está em uso e como recarregar agora', () => {
    const text = (publishedMessage('0.3.1', '/tmp/x') as string[]).join('\n')
    expect(text).toContain('Versão 0.3.1 publicada em:\n  /tmp/x')
    expect(text).toMatch(/recarregam sozinhos, em até 1 minuto, quando nada estiver em uso/)
    expect(text).toMatch(/nenhuma gravação, nenhuma aba do Meet ou do Teams aberta/)
    expect(text).toContain('"Recarregar agora"')
    expect(text).toContain('chrome://extensions > Recarregar')
    expect(text).not.toMatch(/[\u2013\u2014]/)
  })

  it('recusa publicar um build sem manifesto ou sem a chave (o ID mudaria)', async () => {
    const src = join(base, 'vazio')
    mkdirSync(src, { recursive: true })
    await expect(publish({ src, dest: join(base, 'outra') })).rejects.toThrow(/manifest/)
    writeFileSync(join(src, 'manifest.json'), JSON.stringify({ manifest_version: 3 }))
    await expect(publish({ src, dest: join(base, 'outra') })).rejects.toThrow(/chave/)
    expect(existsSync(join(base, 'outra'))).toBe(false)
  })
})
