// Cliente tipado da API do SW, usado pelo popup e pelas configurações.
//
// Emenda 17: uma resposta vazia vira erro. Um SW de uma versão anterior (o Chrome guarda o script
// do SW de uma extensão sem compactação até ela ser recarregada) não conhece os pedidos novos e
// não responde: o sendMessage devolve undefined, e o popup quebrava em silêncio lendo `r.ok`
// ("Cannot read properties of undefined"). Agora a promessa é rejeitada com uma mensagem que diz
// o que fazer, e cada tela a mostra como mostra as outras falhas.
import { t } from './i18n'
import type { UiReq, UiResMap } from './protocol'

/** O SW não respondeu ao pedido (versão anterior, ou nenhum ouvinte). */
export class UiNoAnswerError extends Error {
  constructor(readonly request: string) {
    super(t('errWorkerNoAnswer', request))
    this.name = 'UiNoAnswerError'
  }
}

export async function uiCall<K extends UiReq['t']>(req: Extract<UiReq, { t: K }>): Promise<UiResMap[K]> {
  const res = (await chrome.runtime.sendMessage(req)) as UiResMap[K] | undefined | null
  if (res === undefined || res === null) throw new UiNoAnswerError(req.t)
  return res
}

/** Mensagem de uma rejeição (do uiCall ou do navegador), para mostrar na tela. */
export function errorText(e: unknown): string {
  return String((e as Error)?.message ?? e)
}
