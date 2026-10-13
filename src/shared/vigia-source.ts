// De onde o vigia leu a contagem (Emenda 15).
//
// A fonte viaja no protocolo (`VigiaStatus.fonte`) e no log como o texto em português que a
// camada de DOM do vigia escreve (src/content/vigia/contagem.ts): é dado, conferido pelos testes.
// A tradução acontece na ponta, ao mostrar (indicador na página e popup), como nos motivos do
// helper (helper-reasons.ts). Em português o rótulo sai igual ao dado.
import { t, type MessageKey } from './i18n'

export const FONTE_PAINEL_PEOPLE = 'painel People'
export const FONTE_TEXTO_DA_PAGINA = 'texto da página'
export const FONTE_BOTAO_PESSOAS = 'botão de pessoas'
export const FONTE_PAINEL_PESSOAS = 'painel de pessoas'
export const FONTE_BOTAO_PESSOAS_ANTIGO = 'botão de pessoas (interface antiga)'

const SOURCE_KEY: Record<string, MessageKey> = {
  [FONTE_PAINEL_PEOPLE]: 'vigiaSrcTeamsPanel',
  [FONTE_TEXTO_DA_PAGINA]: 'vigiaSrcPageText',
  [FONTE_BOTAO_PESSOAS]: 'vigiaSrcPeopleButton',
  [FONTE_PAINEL_PESSOAS]: 'vigiaSrcPeoplePanel',
  [FONTE_BOTAO_PESSOAS_ANTIGO]: 'vigiaSrcPeopleButtonOld',
}

/** O rótulo da fonte no idioma da interface (uma fonte desconhecida aparece como veio). */
export function vigiaSourceLabel(fonte: string | null | undefined): string {
  if (!fonte) return String(fonte)
  const key = SOURCE_KEY[fonte]
  return key ? t(key) : fonte
}
