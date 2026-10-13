// Pacote da Chrome Web Store (Emenda 13): o manifesto do pacote não pode ter a chave de
// desenvolvimento, os mapas de fonte ficam fora e o zip abre com o unzip do sistema. Tudo em pasta
// temporária; o build de verdade é o npm run empacotar.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
// @ts-expect-error módulo .mjs sem tipos
import { checkStoreManifest, pack } from '../../scripts/empacotar.mjs'

const base = mkdtempSync(join(tmpdir(), 'gravador-empacotar-'))
afterAll(() => rmSync(base, { recursive: true, force: true }))

const manifest = { manifest_version: 3, name: 'Gravador de Calls', version: '0.2.0', homepage_url: 'https://gravador-de-calls.vercel.app' }

describe('empacotar para a loja', () => {
  it('recusa o manifesto com a chave de desenvolvimento, versão inválida ou MV2', () => {
    expect(() => checkStoreManifest(manifest)).not.toThrow()
    expect(() => checkStoreManifest({ ...manifest, key: 'MIIB...' })).toThrow(/ainda tem "key"/)
    expect(() => checkStoreManifest({ ...manifest, version: '0.2.0-beta' })).toThrow(/versão inválida/)
    expect(() => checkStoreManifest({ ...manifest, manifest_version: 2 })).toThrow(/Manifest V3/)
    // Emenda 15: o site da política de privacidade.
    expect(() => checkStoreManifest({ ...manifest, homepage_url: undefined })).toThrow(/homepage_url/)
    expect(() => checkStoreManifest({ ...manifest, homepage_url: 'http://x' })).toThrow(/homepage_url/)
  })

  it('zipa a pasta sem os mapas de fonte; o zip abre e confere no unzip', async () => {
    const src = join(base, 'build')
    mkdirSync(join(src, 'assets'), { recursive: true })
    writeFileSync(join(src, 'manifest.json'), JSON.stringify(manifest))
    writeFileSync(join(src, 'assets', 'a.js'), 'console.log("ação")\n'.repeat(200))
    writeFileSync(join(src, 'assets', 'a.js.map'), '{}')
    writeFileSync(join(src, 'icone.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const r = await pack({ src, outDir: join(base, 'out') })
    expect(r).toMatchObject({ version: '0.2.0', files: 3, zip: join(base, 'out', 'gravador-de-calls-0.2.0.zip') })
    expect(execFileSync('unzip', ['-Z1', r.zip], { encoding: 'utf8' }).trim().split('\n').sort()).toEqual(['assets/a.js', 'icone.png', 'manifest.json'])
    execFileSync('unzip', ['-tq', r.zip])
    expect(execFileSync('unzip', ['-p', r.zip, 'assets/a.js'], { encoding: 'utf8' })).toBe('console.log("ação")\n'.repeat(200))
  })

  it('não empacota um build com o gancho de teste __gravador nem sem as mensagens da língua padrão (Emenda 15)', async () => {
    const src = join(base, 'com-gancho')
    mkdirSync(join(src, 'assets'), { recursive: true })
    mkdirSync(join(src, '_locales', 'en'), { recursive: true })
    writeFileSync(join(src, 'manifest.json'), JSON.stringify({ ...manifest, default_locale: 'en' }))
    writeFileSync(join(src, '_locales', 'en', 'messages.json'), '{}')
    // A marca da ponte MAIN <-> relay não é o gancho.
    writeFileSync(join(src, 'assets', 'relay.js'), 'const m = "__gravador__"\n')
    await expect(pack({ src, outDir: join(base, 'out3') })).resolves.toMatchObject({ files: 3 })
    writeFileSync(join(src, 'assets', 'sw.js'), 'Object.assign(globalThis, { __gravador: {} })\n')
    await expect(pack({ src, outDir: join(base, 'out3') })).rejects.toThrow(/gancho de teste __gravador em assets\/sw\.js/)
    rmSync(join(src, 'assets', 'sw.js'))
    rmSync(join(src, '_locales'), { recursive: true })
    await expect(pack({ src, outDir: join(base, 'out3') })).rejects.toThrow(/_locales\/en\/messages\.json/)
  })

  it('não empacota um build com a chave', async () => {
    const src = join(base, 'com-chave')
    mkdirSync(src, { recursive: true })
    writeFileSync(join(src, 'manifest.json'), JSON.stringify({ ...manifest, key: 'x' }))
    await expect(pack({ src, outDir: join(base, 'out2') })).rejects.toThrow(/ainda tem "key"/)
  })
})
