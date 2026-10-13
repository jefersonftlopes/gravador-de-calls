// Aviso de versão diferente (Emenda 17), no popup e nas configurações: o perfil ainda roda o SW de
// uma versão anterior à do disco (ou o SW viu uma publicação nova e espera para recarregar). O
// botão "Recarregar agora" chama chrome.runtime.reload(); com uma gravação em andamento ele fica
// desligado, com o porquê, porque recarregar a extensão encerra a gravação.
//
// Também aqui: `useUnhandledUiErrors`, a rede de segurança das telas para uma rejeição que nenhum
// ponto tratou (um uiCall sem resposta numa seção que não mostra erro próprio). A mensagem aparece
// em vez de sumir no console.
import { useEffect, useState } from 'react'
import { helperReason } from './helper-reasons'
import { t } from './i18n'
import type { AutoReloadState, BuildInfo } from './protocol'
import { errorText } from './ui-client'
import { BAKED, autoReloadWaitLabel, loadedManifestVersion, versionSkew, versionSkewText } from './version'

export function VersionBanner({ worker, update, recording }: { worker: BuildInfo | undefined; update: AutoReloadState | null | undefined; recording: boolean }) {
  const skew = versionSkew(BAKED, worker, loadedManifestVersion(), update)
  if (!skew) return null
  const waiting = update && !update.gaveUp && update.waiting.length > 0 ? update.waiting.map(autoReloadWaitLabel).join(', ') : null
  return (
    <section data-testid="aviso-versao" className="space-y-1 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-950 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100">
      <p data-testid="aviso-versao-texto">{versionSkewText(skew)}</p>
      {waiting && <p data-testid="aviso-versao-esperando">{t('versionAutoWaiting', waiting)}</p>}
      {update?.gaveUp && <p data-testid="aviso-versao-desistiu">{t('versionGaveUp')}</p>}
      <button
        type="button"
        data-testid="recarregar-extensao"
        disabled={recording}
        className="rounded-md bg-amber-700 px-3 py-1 font-medium text-white hover:bg-amber-800 disabled:opacity-60"
        onClick={() => chrome.runtime.reload()}
      >
        {t('versionReloadNow')}
      </button>
      {recording && <p data-testid="recarregar-bloqueado">{t('versionReloadBlocked')}</p>}
    </section>
  )
}

/**
 * Rejeições que ninguém tratou nesta tela, como texto para mostrar (a última). Guarda só o motivo e
 * monta a frase a cada render (Emenda 19): trocado o idioma, a raiz da tela redesenha e a mensagem
 * troca junto, inclusive o motivo que o uiCall ou o SW escreveram no idioma de antes.
 */
export function useUnhandledUiErrors(): string | null {
  const [reason, setReason] = useState<string | null>(null)
  useEffect(() => {
    const onRejection = (e: PromiseRejectionEvent) => {
      e.preventDefault()
      setReason(errorText(e.reason))
    }
    window.addEventListener('unhandledrejection', onRejection)
    return () => window.removeEventListener('unhandledrejection', onRejection)
  }, [])
  return reason === null ? null : t('uiUnexpectedError', helperReason(reason))
}
