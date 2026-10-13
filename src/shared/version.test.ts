// Versão rodando x versão no disco (Emenda 17): a regra que decide o aviso do popup e das
// configurações, e os textos nas duas línguas. O caso do achado de uso real: o SW 0.1.2 (sem o
// campo `worker`, que só existe a partir da 0.3.1) com o popup novo.
import { afterEach, describe, expect, it } from 'vitest'
import { useLocale } from '../../tests/helpers/i18n-setup'
import type { AutoReloadState } from './protocol'
import { BAKED, autoReloadWaitLabel, versionSkew, versionSkewText } from './version'

const page = { version: '0.3.1', build: 'aaaaaaaaaaaa' }

afterEach(() => useLocale('pt_BR'))

describe('versionSkew', () => {
  it('tudo igual: sem aviso', () => {
    expect(versionSkew(page, { ...page }, '0.3.1')).toBeNull()
    expect(versionSkew(page, { ...page }, '0.3.1', null)).toBeNull()
  })

  it('SW antigo sem o campo worker: a versão do manifesto carregado, ou "uma anterior" quando nem ela difere', () => {
    expect(versionSkew(page, undefined, '0.1.2')).toEqual({ running: '0.1.2', available: '0.3.1' })
    expect(versionSkew(page, undefined, '0.3.1')).toEqual({ running: null, available: '0.3.1' })
    expect(versionSkew(page, undefined, null)).toEqual({ running: null, available: '0.3.1' })
  })

  it('SW de outra versão, ou da mesma versão com outro build', () => {
    expect(versionSkew(page, { version: '0.3.0', build: 'bbbbbbbbbbbb' }, '0.3.0')).toEqual({ running: '0.3.0', available: '0.3.1' })
    expect(versionSkew(page, { version: '0.3.1', build: 'bbbbbbbbbbbb' }, '0.3.1')).toEqual({ running: '0.3.1 (bbbbbbb)', available: '0.3.1 (aaaaaaa)' })
  })

  it('SW igual à página, mas o manifesto carregado é outro', () => {
    expect(versionSkew(page, { ...page }, '0.3.0')).toEqual({ running: '0.3.0', available: '0.3.1' })
  })

  it('publicação nova que o SW viu e ainda não está rodando (recarga sozinha esperando)', () => {
    const update: AutoReloadState = { published: { version: '0.3.2', build: 'cccccccccccc' }, waiting: ['gravando'], gaveUp: false }
    expect(versionSkew(page, { ...page }, '0.3.1', update)).toEqual({ running: '0.3.1', available: '0.3.2' })
  })

  it('o bundle sabe a própria versão (a do package.json)', () => {
    expect(BAKED.version).toMatch(/^\d+\.\d+\.\d+$/)
    expect(BAKED.build).toBe('vitest')
  })
})

describe('textos do aviso', () => {
  it('em português e em inglês, com e sem a versão que roda', () => {
    expect(versionSkewText({ running: '0.1.2', available: '0.3.1' })).toBe('Este perfil ainda está com a versão 0.1.2 da extensão rodando. Recarregue a extensão para usar a versão 0.3.1.')
    expect(versionSkewText({ running: null, available: '0.3.1' })).toBe('Este perfil ainda está com uma versão anterior da extensão rodando. Recarregue a extensão para usar a versão 0.3.1.')
    expect(autoReloadWaitLabel('call-aberta')).toBe('aba do Meet ou do Teams aberta')
    expect(autoReloadWaitLabel('iniciando-captura')).toBe('captura de aba começando')
    expect(autoReloadWaitLabel('configuracoes-abertas')).toBe('página de configurações aberta')
    useLocale('en')
    expect(versionSkewText({ running: '0.1.2', available: '0.3.1' })).toBe('This profile is still running version 0.1.2 of the extension. Reload the extension to use version 0.3.1.')
    expect(versionSkewText({ running: null, available: '0.3.1' })).toBe('This profile is still running an earlier version of the extension. Reload the extension to use version 0.3.1.')
    expect(autoReloadWaitLabel('iniciando-captura')).toBe('a tab capture starting')
    expect(autoReloadWaitLabel('configuracoes-abertas')).toBe('the settings page open')
    for (const w of ['gravando', 'salvando', 'call-aberta', 'volume', 'iniciando-captura', 'configuracoes-abertas'] as const) expect(autoReloadWaitLabel(w), w).not.toBe('')
  })
})
