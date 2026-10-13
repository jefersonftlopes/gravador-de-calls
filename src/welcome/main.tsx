import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '../shared/styles.css'
import { t } from '../shared/i18n'
import { preparePageLanguage } from '../shared/page-language'
import { Welcome } from './Welcome'

// O idioma escolhido nas configurações já antes do primeiro render, e trocado na hora (Emenda 19).
void preparePageLanguage(() => t('welcomeTitle')).then(() =>
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <Welcome />
    </StrictMode>,
  ),
)
