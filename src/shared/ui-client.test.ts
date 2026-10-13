// Resposta vazia do SW (Emenda 17): um SW de uma versão anterior não conhece o pedido e não
// responde, e o sendMessage devolve undefined. O uiCall rejeita com a mensagem que diz o que
// fazer, em vez de deixar a tela quebrar lendo `r.ok` de undefined.
import { afterEach, describe, expect, it } from 'vitest'
import { useLocale } from '../../tests/helpers/i18n-setup'
import { UiNoAnswerError, errorText, uiCall } from './ui-client'

function installChrome(answer: unknown) {
  ;(globalThis as unknown as { chrome: unknown }).chrome = { runtime: { sendMessage: async () => answer } }
}

afterEach(() => useLocale('pt_BR'))

describe('uiCall', () => {
  it('devolve a resposta do SW', async () => {
    installChrome({ ok: true })
    await expect(uiCall({ t: 'ui:tab-volume-set', tabId: 1, volume: 1.5 })).resolves.toEqual({ ok: true })
    // Uma resposta "falsa" que não é vazia passa como veio.
    installChrome({ ok: false, error: 'x' })
    await expect(uiCall({ t: 'ui:stop', sessionId: 's' })).resolves.toEqual({ ok: false, error: 'x' })
  })

  it('sem resposta (undefined ou null): rejeita com o motivo, nas duas línguas', async () => {
    installChrome(undefined)
    const e = await uiCall({ t: 'ui:tab-volume-set', tabId: 1, volume: 1.5 }).catch((x: unknown) => x)
    expect(e).toBeInstanceOf(UiNoAnswerError)
    expect(errorText(e)).toBe('o service worker da extensão não respondeu ao pedido "ui:tab-volume-set" (ele pode estar rodando uma versão anterior: recarregue a extensão)')
    installChrome(null)
    await expect(uiCall({ t: 'ui:state' })).rejects.toBeInstanceOf(UiNoAnswerError)
    useLocale('en')
    installChrome(undefined)
    await expect(uiCall({ t: 'ui:state' })).rejects.toThrow(`the extension's service worker didn't answer the "ui:state" request (it may be running an earlier version: reload the extension)`)
  })
})
