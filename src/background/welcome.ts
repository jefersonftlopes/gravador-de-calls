// Página de boas-vindas e aviso da primeira execução no SW (Emenda 15).
//
// - Instalação nova: abre a página de boas-vindas (src/welcome), onde o usuário lê o que é gravado
//   e confirma com "Entendi". Até lá a gravação automática não começa (sessions.ts e relay.ts).
// - Atualização vinda de uma versão anterior à 0.3.0 (sem aviso): quem já usava nunca viu o aviso
//   e grava calls de verdade; parar a gravação automática dele no meio de um dia de calls seria
//   pior que o aviso. A confirmação fica dada ("atualizacao"), e a página continua a um clique nas
//   configurações.
// - Qualquer outra atualização (da 0.3.0 em diante, ou sem a versão anterior) não confirma nada:
//   quem instalou já com o aviso e não clicou "Entendi" continua sem gravação automática, mesmo
//   que o Chrome atualize a extensão sozinho. O badge e o popup continuam pedindo a confirmação.
import { WELCOME_PAGE, acknowledgeConsent, hasConsent } from '../shared/consent'

const log = (...a: unknown[]) => console.debug('[gravador boas-vindas]', ...a)

export function welcomeUrl(): string {
  return chrome.runtime.getURL(WELCOME_PAGE)
}

/** Primeira versão com o aviso da primeira execução (Emenda 15). */
export const CONSENT_SINCE_VERSION = '0.3.0'

/**
 * `a` < `b` em versões do manifesto do Chrome (até 4 inteiros separados por ponto). Uma versão
 * que não é desse formato não é comparável: devolve false (na dúvida, nada é confirmado).
 */
export function versionBefore(a: string, b: string): boolean {
  const parse = (v: string) => (/^\d+(\.\d+){0,3}$/.test(v) ? v.split('.').map(Number) : null)
  const x = parse(a)
  const y = parse(b)
  if (!x || !y) return false
  for (let i = 0; i < 4; i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0)
    if (d !== 0) return d < 0
  }
  return false
}

/** O que fazer com o aviso em cada motivo do runtime.onInstalled. */
export function consentActionFor(reason: string, given: boolean, previousVersion?: string): 'abrir-pagina' | 'confirmar' | 'nada' {
  if (given) return 'nada'
  if (reason === 'install') return 'abrir-pagina'
  // Só quem vem de antes do aviso: sem a versão anterior não há como saber, então nada.
  if (reason === 'update' && previousVersion && versionBefore(previousVersion, CONSENT_SINCE_VERSION)) return 'confirmar'
  return 'nada'
}

/** Recebe os detalhes inteiros do runtime.onInstalled: o motivo sozinho não basta (Emenda 15). */
export async function onInstalledConsent(details: { reason: string; previousVersion?: string }): Promise<void> {
  try {
    const action = consentActionFor(details.reason, await hasConsent(), details.previousVersion)
    if (action === 'abrir-pagina') await chrome.tabs.create({ url: welcomeUrl() })
    else if (action === 'confirmar') await acknowledgeConsent('atualizacao')
  } catch (e) {
    log('aviso da primeira execução', e)
  }
}
