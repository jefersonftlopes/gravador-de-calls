// Boas-vindas e aviso da primeira execução (Emenda 15). Abre sozinha na instalação (SW,
// src/background/welcome.ts) e a partir do popup e das configurações. Diz o que é gravado (só o
// áudio dos outros participantes, nunca o microfone), onde fica (Downloads/<pasta>), que nada sai
// do computador e que gravar pode exigir o consentimento de todos. "Entendi" grava a confirmação
// deste perfil em chrome.storage.local; o SW e o relay ouvem a mudança e a gravação automática
// passa a valer, inclusive nas abas de call já abertas.
import { useEffect, useState, type ReactNode } from 'react'
import { acknowledgeConsent, consentGiven, loadConsent, onConsentChanged, type ConsentRecord } from '../shared/consent'
import { helperReason } from '../shared/helper-reasons'
import { downloadsFolderName, t } from '../shared/i18n'
import { useLanguage } from '../shared/page-language'
import { formatDateTime } from '../popup/format'

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2 rounded-xl border border-neutral-200 p-4 dark:border-neutral-700">
      <h2 className="text-base font-semibold">{title}</h2>
      <ul className="list-disc space-y-1 pl-5">{children}</ul>
    </section>
  )
}

export function Welcome() {
  // Emenda 19: o idioma trocado nas configurações vale na hora, com a página aberta.
  useLanguage()
  // undefined: ainda lendo; null: sem confirmação.
  const [consent, setConsent] = useState<ConsentRecord | null | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  // Só o motivo; a frase sai a cada render, no idioma que vale (Emenda 19).
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const read = () =>
      loadConsent()
        .then(setConsent)
        .catch(() => setConsent(null))
    void read()
    // Confirmado em outra aba (a página aberta duas vezes): esta acompanha.
    return onConsentChanged(() => void read())
  }, [])

  const acknowledge = async () => {
    setBusy(true)
    setError(null)
    try {
      setConsent(await acknowledgeConsent('pagina'))
    } catch (e) {
      setError(String((e as Error)?.message ?? e))
    } finally {
      setBusy(false)
    }
  }

  const given = consent !== undefined && consentGiven(consent)

  return (
    <main data-testid="boas-vindas" className="mx-auto max-w-2xl space-y-4 p-6 text-sm text-neutral-900 dark:text-neutral-100">
      <header className="flex items-center gap-3">
        <img src={chrome.runtime.getURL('icons/icon48.png')} alt="" width={48} height={48} />
        <div>
          <h1 className="text-xl font-semibold">{t('welcomeTitle')}</h1>
          <p className="text-neutral-600 dark:text-neutral-400">{t('welcomeIntro')}</p>
        </div>
      </header>

      <Block title={t('welcomeWhatTitle')}>
        <li>{t('welcomeWhatRemote')}</li>
        <li className="font-medium">{t('welcomeWhatNoMic')}</li>
        <li>{t('welcomeWhatAuto')}</li>
      </Block>

      <Block title={t('welcomeWhereTitle')}>
        <li data-testid="onde-fica">{t('welcomeWhereDownloads', downloadsFolderName())}</li>
        <li>{t('welcomeWhereNothingLeaves')}</li>
      </Block>

      <Block title={t('welcomeConsentTitle')}>
        <li>{t('welcomeConsentLaw')}</li>
        <li>{t('welcomeConsentAdvice')}</li>
      </Block>

      <p>
        <a className="text-blue-700 underline hover:no-underline dark:text-blue-400" href={t('privacyUrl')} target="_blank" rel="noreferrer">
          {t('optPrivacyLink')}
        </a>
      </p>

      {consent === undefined ? null : given ? (
        <p data-testid="confirmado" className="rounded-md bg-green-50 p-3 text-green-900 dark:bg-green-950 dark:text-green-200">
          {t('welcomeAcked')} {consent && t('welcomeAckedAt', formatDateTime(consent.at))}
        </p>
      ) : (
        <div className="space-y-2">
          <button
            type="button"
            data-testid="entendi"
            disabled={busy}
            className="rounded-md bg-blue-600 px-5 py-2 font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            onClick={() => void acknowledge()}
          >
            {t('welcomeAck')}
          </button>
          <p className="text-neutral-600 dark:text-neutral-400">{t('welcomeAckHint')}</p>
        </div>
      )}
      {error !== null && <p className="text-red-700 dark:text-red-400">{t('welcomeAckError', helperReason(error))}</p>}
    </main>
  )
}
