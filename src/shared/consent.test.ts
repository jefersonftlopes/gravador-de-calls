// Aviso da primeira execução (Emenda 15): sem confirmar, nenhuma plataforma grava sozinha; com a
// confirmação, vale a configuração de cada uma. E o que o SW faz em cada motivo do onInstalled
// (a atualização só confirma sozinha para quem vem de antes da 0.3.0, a versão do aviso).
import { beforeEach, describe, expect, it } from 'vitest'
import { consentActionFor, onInstalledConsent, versionBefore } from '../background/welcome'
import { CONSENT_VERSION, autoAllowed, consentGiven } from './consent'

const ok = { version: CONSENT_VERSION, at: 1, via: 'pagina' }

describe('autoAllowed', () => {
  it('sem confirmação: nada grava sozinho, mesmo com as duas plataformas ligadas', () => {
    for (const consent of [undefined, null, {}, { version: 1 }, { ...ok, via: 'outro' }, 'sim', true]) {
      expect(autoAllowed('meet', { autoMeet: true, autoTeams: true }, consent), JSON.stringify(consent)).toBe(false)
      expect(autoAllowed('teams', { autoMeet: true, autoTeams: true }, consent)).toBe(false)
    }
  })

  it('confirmado: vale a configuração de cada plataforma (só false explícito desliga)', () => {
    expect(autoAllowed('meet', { autoMeet: true }, ok)).toBe(true)
    expect(autoAllowed('meet', { autoMeet: false }, ok)).toBe(false)
    expect(autoAllowed('teams', { autoMeet: false }, ok)).toBe(true)
    expect(autoAllowed('teams', undefined, ok)).toBe(true)
    expect(autoAllowed('teams', { autoTeams: false }, { ...ok, via: 'atualizacao' })).toBe(false)
  })

  it('uma versão antiga do aviso não vale', () => {
    expect(consentGiven({ ...ok, version: CONSENT_VERSION - 1 })).toBe(false)
    expect(consentGiven(ok)).toBe(true)
  })
})

describe('onInstalled e o aviso', () => {
  it('instalação nova abre a página; o resto sem a versão anterior não faz nada', () => {
    expect(consentActionFor('install', false)).toBe('abrir-pagina')
    expect(consentActionFor('install', false, '0.2.1')).toBe('abrir-pagina')
    expect(consentActionFor('chrome_update', false)).toBe('nada')
    expect(consentActionFor('update', false)).toBe('nada')
    expect(consentActionFor('install', true)).toBe('nada')
    expect(consentActionFor('update', true, '0.2.1')).toBe('nada')
  })

  it('atualização: só quem vem de antes da 0.3.0 (sem aviso) fica confirmado', () => {
    for (const prev of ['0.2.1', '0.1', '0.2.9.9', '0.0.1']) expect(consentActionFor('update', false, prev), prev).toBe('confirmar')
    // Quem instalou já com o aviso e não confirmou continua sem gravação automática quando o
    // Chrome atualiza a extensão sozinho (ou quando a pasta descompactada é recarregada).
    for (const prev of ['0.3.0', '0.3', '0.3.1', '1.0', '0.10.0', 'x', '']) expect(consentActionFor('update', false, prev), prev).toBe('nada')
  })

  it('versionBefore compara por número, não por texto', () => {
    expect(versionBefore('0.2.1', '0.3.0')).toBe(true)
    expect(versionBefore('0.9', '0.10')).toBe(true)
    expect(versionBefore('0.10', '0.9')).toBe(false)
    expect(versionBefore('0.3', '0.3.0')).toBe(false)
    expect(versionBefore('0.3.0', '0.3.0')).toBe(false)
    expect(versionBefore('0.3.0.1', '0.3.0')).toBe(false)
    expect(versionBefore('0.2.x', '0.3.0')).toBe(false)
  })
})

describe('onInstalledConsent (chrome falso)', () => {
  let stored: Record<string, unknown>
  let created: string[]

  beforeEach(() => {
    stored = {}
    created = []
    ;(globalThis as unknown as { chrome: unknown }).chrome = {
      runtime: { getURL: (p: string) => `chrome-extension://x/${p}` },
      storage: {
        local: {
          get: async (k: string) => (k in stored ? { [k]: stored[k] } : {}),
          set: async (v: Record<string, unknown>) => void Object.assign(stored, v),
        },
      },
      tabs: { create: async ({ url }: { url: string }) => void created.push(url) },
    }
  })

  it('atualização da 0.3.0 sem o aviso confirmado: não confirma nem abre nada', async () => {
    await onInstalledConsent({ reason: 'update', previousVersion: '0.3.0' })
    expect(stored).toEqual({})
    expect(created).toEqual([])
  })

  it('atualização da 0.2.1: confirma como "atualizacao"', async () => {
    await onInstalledConsent({ reason: 'update', previousVersion: '0.2.1' })
    expect(stored.consent).toMatchObject({ version: CONSENT_VERSION, via: 'atualizacao' })
    expect(created).toEqual([])
  })

  it('instalação: abre a página de boas-vindas e não confirma', async () => {
    await onInstalledConsent({ reason: 'install' })
    expect(created).toEqual(['chrome-extension://x/src/welcome/index.html'])
    expect(stored).toEqual({})
  })
})
