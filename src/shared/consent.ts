// Aviso da primeira execução (Emenda 15): o que é gravado, onde fica e o consentimento dos
// participantes. Até o usuário confirmar ("Entendi" na página de boas-vindas), a gravação
// automática não começa neste perfil. A confirmação fica em chrome.storage.local (por perfil).
//
// Regra pura `autoAllowed` (testada em consent.test.ts) usada pelo SW e pelo relay: a gravação
// automática de uma plataforma vale só com a configuração ligada E o aviso confirmado.
import type { Platform } from './protocol'

export const CONSENT_KEY = 'consent'
/** Versão do aviso. Subir a versão pede a confirmação de novo (texto do aviso mudou de sentido). */
export const CONSENT_VERSION = 1

/** Página de boas-vindas (entrada do Vite em vite.config.ts). */
export const WELCOME_PAGE = 'src/welcome/index.html'

export interface ConsentRecord {
  version: number
  /** Quando foi confirmado (ms). */
  at: number
  /** "pagina": o botão "Entendi"; "atualizacao": quem já usava antes da 0.3.0 (Emenda 15). */
  via: 'pagina' | 'atualizacao'
}

export function isConsentRecord(v: unknown): v is ConsentRecord {
  if (!v || typeof v !== 'object') return false
  const r = v as Record<string, unknown>
  return typeof r.version === 'number' && typeof r.at === 'number' && (r.via === 'pagina' || r.via === 'atualizacao')
}

/** O aviso desta versão foi confirmado? */
export function consentGiven(v: unknown): boolean {
  return isConsentRecord(v) && v.version >= CONSENT_VERSION
}

/**
 * A gravação automática da plataforma pode começar? Só `false` explícito desliga a configuração
 * (o mesmo critério do relay, Emenda 10), e sem o aviso confirmado nada começa.
 */
export function autoAllowed(platform: Platform, settings: unknown, consent: unknown): boolean {
  if (!consentGiven(consent)) return false
  const s = settings && typeof settings === 'object' ? (settings as Record<string, unknown>) : {}
  return (platform === 'meet' ? s.autoMeet : s.autoTeams) !== false
}

export async function loadConsent(): Promise<ConsentRecord | null> {
  const got = await chrome.storage.local.get(CONSENT_KEY)
  const v = got?.[CONSENT_KEY]
  return isConsentRecord(v) ? v : null
}

export async function hasConsent(): Promise<boolean> {
  try {
    return consentGiven(await loadConsent())
  } catch {
    return false
  }
}

/** Grava a confirmação deste perfil. */
export async function acknowledgeConsent(via: ConsentRecord['via'] = 'pagina'): Promise<ConsentRecord> {
  const rec: ConsentRecord = { version: CONSENT_VERSION, at: Date.now(), via }
  await chrome.storage.local.set({ [CONSENT_KEY]: rec })
  return rec
}

/** Chama `cb` quando a confirmação mudar (de qualquer contexto). */
export function onConsentChanged(cb: (given: boolean) => void): () => void {
  const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area === 'local' && CONSENT_KEY in changes) cb(consentGiven(changes[CONSENT_KEY].newValue))
  }
  chrome.storage.onChanged.addListener(listener)
  return () => chrome.storage.onChanged.removeListener(listener)
}
