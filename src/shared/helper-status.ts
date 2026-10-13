// O que as telas dizem sobre o helper (Emenda 10). O popup e as configurações mostram o mesmo
// diagnóstico: "não instalado" (o Chrome não acha o manifesto) é diferente de "instalado, mas não
// abre" (o node fixado no wrapper sumiu, o wrapper perdeu a execução, o manifesto aponta para uma
// pasta que mudou), e o erro do Chrome aparece para não esconder o motivo.
//
// Emenda 15: sem o helper é o jeito normal de usar a extensão da loja. "Não instalado" diz só onde
// as gravações ficam (Downloads/<pasta no idioma da interface>), sem tom de erro.
import type { HelperStatus } from './protocol'
import { helperReason } from './helper-reasons'
import { downloadsFolderName, t } from './i18n'

export type HelperProblemKind = 'ok' | 'verificando' | 'nao-instalado' | 'nao-abre' | 'sem-permissao'

/** Mensagem do Chrome quando o manifesto do host não existe. */
const NOT_FOUND_RE = /native messaging host not found/i
/** Estado inicial do SW antes do primeiro ping (sink-host.ts). */
const NOT_CHECKED = 'ainda não verificado'

/** "Downloads/Gravações de calls" (ou "Downloads/Call recordings"). */
export function downloadsPath(): string {
  return `Downloads/${downloadsFolderName()}`
}

export function helperProblem(h: HelperStatus): { kind: HelperProblemKind; text: string } {
  const folder = downloadsFolderName()
  if (h.ok) {
    if (h.writable) return { kind: 'ok', text: '' }
    return { kind: 'sem-permissao', text: t('helperNoWrite', h.root ?? t('helperCurrentFolder'), folder) }
  }
  const error = (h.error ?? '').trim()
  if (error === NOT_CHECKED) return { kind: 'verificando', text: t('helperChecking') }
  if (!error || NOT_FOUND_RE.test(error)) return { kind: 'nao-instalado', text: t('helperAbsent', folder) }
  // O erro que o SW escreveu no idioma da hora (Emenda 19) sai no que vale agora.
  return { kind: 'nao-abre', text: t('helperNotOpening', helperReason(error), folder) }
}
