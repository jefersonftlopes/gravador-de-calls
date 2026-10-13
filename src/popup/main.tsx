import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '../shared/styles.css'
import { t } from '../shared/i18n'
import { preparePageLanguage } from '../shared/page-language'
import { Popup } from './Popup'

// Idioma e título da página no idioma da interface (Emenda 15), o escolhido nas configurações já
// antes do primeiro render e trocado na hora junto com ele (Emenda 19).
void preparePageLanguage(() => t('extName')).then(() =>
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <Popup />
    </StrictMode>,
  ),
)
