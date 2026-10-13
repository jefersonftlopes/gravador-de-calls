// ID da captura da aba (chrome.tabCapture.getMediaStreamId), pedido pelo modo aba (tabcapture.ts)
// e pelo volume desta aba (tabvolume.ts), com o erro do Chrome traduzido para o que o usuário pode
// fazer (Emenda 17).
//
// O Chrome só deixa uma captura por aba. Outra extensão que capture a aba (o Volume Master, por
// exemplo, que nunca a solta) faz o pedido falhar com "Cannot capture a tab with an active
// stream." (achado de uso real em 08/10/2026). A mensagem crua não diz o que fazer; a traduzida diz.
import { t } from '../shared/i18n'

/** Texto do Chrome quando a aba já tem uma captura (de outra extensão ou de uma captura nossa perdida). */
export const ACTIVE_STREAM_RE = /cannot capture a tab with an active stream/i

/** O erro do getMediaStreamId no idioma da interface, dizendo o que fazer quando há como. */
export function captureErrorMessage(raw: unknown): string {
  const text = String((raw as Error)?.message ?? raw ?? '').trim()
  if (ACTIVE_STREAM_RE.test(text)) return t('errCaptureBusy')
  return t('errCaptureDenied', text)
}

/** Gancho de teste (failTabStreamId): o próximo pedido falha com esta mensagem do Chrome. */
let nextFailure: string | null = null

/** Arma (ou desarma, com null) a falha do próximo getMediaStreamId. Só os testes chamam. */
export function failTabStreamId(message: string | null): void {
  nextFailure = message
}

/** Pede o ID da captura da aba ao Chrome; a falha volta já traduzida. */
export async function tabStreamId(tabId: number): Promise<{ ok: true; streamId: string } | { ok: false; error: string }> {
  try {
    if (nextFailure !== null) {
      const message = nextFailure
      nextFailure = null
      throw new Error(message)
    }
    return { ok: true, streamId: await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }) }
  } catch (e) {
    return { ok: false, error: captureErrorMessage(e) }
  }
}
