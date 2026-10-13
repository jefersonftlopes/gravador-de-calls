// Erro do getMediaStreamId traduzido (Emenda 17): "Cannot capture a tab with an active stream."
// (outra extensão, como o Volume Master, segurando a captura da aba) vira o que fazer, nas duas
// línguas; qualquer outro erro continua com o texto do Chrome. E o gancho de teste que força a
// falha vale para um pedido só.
import { afterEach, describe, expect, it } from 'vitest'
import { useLocale } from '../../tests/helpers/i18n-setup'
import { captureErrorMessage, failTabStreamId, tabStreamId } from './capture-id'

const BUSY_PT = 'Outra extensão (por exemplo, o Volume Master) já está capturando o som desta aba. Desligue essa extensão em chrome://extensions, ou feche e reabra a aba, e tente de novo.'
const BUSY_EN = "Another extension (for example, Volume Master) is already capturing this tab's sound. Turn that extension off in chrome://extensions, or close and reopen the tab, and try again."
const CHROME_TEXT = 'Cannot capture a tab with an active stream.'

let calls = 0
function installChrome(fail: string | null) {
  calls = 0
  ;(globalThis as unknown as { chrome: unknown }).chrome = {
    tabCapture: {
      getMediaStreamId: async () => {
        calls++
        if (fail) throw new Error(fail)
        return 'stream-1'
      },
    },
  }
}

afterEach(() => {
  useLocale('pt_BR')
  failTabStreamId(null)
})

describe('erro da captura da aba', () => {
  it('a aba com uma captura ativa vira a mensagem do que fazer, em português e em inglês', () => {
    expect(captureErrorMessage(new Error(CHROME_TEXT))).toBe(BUSY_PT)
    expect(captureErrorMessage(CHROME_TEXT)).toBe(BUSY_PT)
    expect(captureErrorMessage(new Error('Error: cannot capture a tab with an active stream'))).toBe(BUSY_PT)
    useLocale('en')
    expect(captureErrorMessage(new Error(CHROME_TEXT))).toBe(BUSY_EN)
  })

  it('outro erro continua com o texto do Chrome', () => {
    expect(captureErrorMessage(new Error('Extension has not been invoked for the current page (see activeTab permission).'))).toBe(
      'captura de aba negada: Extension has not been invoked for the current page (see activeTab permission).',
    )
    useLocale('en')
    expect(captureErrorMessage(new Error('Tab not found'))).toBe('tab capture denied: Tab not found')
  })

  it('tabStreamId devolve o ID ou o erro já traduzido', async () => {
    installChrome(null)
    expect(await tabStreamId(3)).toEqual({ ok: true, streamId: 'stream-1' })
    installChrome(CHROME_TEXT)
    expect(await tabStreamId(3)).toEqual({ ok: false, error: BUSY_PT })
  })

  it('o gancho de teste faz só o próximo pedido falhar, sem chegar ao Chrome', async () => {
    installChrome(null)
    failTabStreamId(CHROME_TEXT)
    expect(await tabStreamId(3)).toEqual({ ok: false, error: BUSY_PT })
    expect(calls).toBe(0)
    expect(await tabStreamId(3)).toEqual({ ok: true, streamId: 'stream-1' })
    expect(calls).toBe(1)
  })
})
