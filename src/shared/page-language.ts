// Idioma das páginas da extensão (popup, configurações, boas-vindas), Emenda 19.
//
// - `preparePageLanguage(title)`: espera o idioma guardado antes do primeiro render (a página não
//   pisca no idioma do Chrome para depois trocar), põe o `<html lang>` e o título, e os refaz a
//   cada troca de idioma.
// - `useLanguage()`: o componente que chama redesenha quando o idioma muda. As raízes de cada
//   página chamam; os filhos redesenham junto (nenhum é memoizado), e o estado do React, como o
//   que o usuário já digitou no formulário, continua.
// Fica fora de i18n.ts porque aquele arquivo vai também no SW e no content script do vigia, que
// não têm React nem documento.
import { useSyncExternalStore } from 'react'
import { initLanguage, messageLocale, onLanguageChange, uiLanguage, type UiLanguage } from './i18n'

export async function preparePageLanguage(title: () => string): Promise<void> {
  await initLanguage()
  const apply = () => {
    document.documentElement.lang = messageLocale()
    document.title = title()
  }
  apply()
  onLanguageChange(apply)
}

export function useLanguage(): UiLanguage {
  return useSyncExternalStore(onLanguageChange, uiLanguage)
}
