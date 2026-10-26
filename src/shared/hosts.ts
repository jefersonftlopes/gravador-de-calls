// Hosts das calls: fonte única (Emenda 17). O manifesto (content_scripts e host_permissions), os
// adaptadores do MAIN world, o SW (badge, modo aba), o popup e o vigia leem daqui, para um host
// novo nunca ficar de fora de uma das partes. Sem dependências, nem de tipo: o MAIN world importa
// este arquivo, e o manifest.config.ts também (o carregador de configuração do Vite não resolve
// import sem extensão). Por isso o tipo Platform nasce aqui e o ./protocol.ts o reexporta.
//
// Proxy do Microsoft Defender for Cloud Apps (Conditional Access App Control): a empresa abre o
// Teams por um proxy que acrescenta um sufixo ao host do app, e a página da call fica em
// https://teams.cloud.microsoft.mcas.ms/ (achado de uso real em 08/10/2026). Os sufixos são o
// comercial (.mcas.ms, que unificou os regionais .cas.ms em 2020) e os de governo (.mcas-gov.us e
// .mcas-gov.ms). Pelo proxy a página é a mesma do Teams (ou do Meet), então o adaptador é o mesmo.

/** Plataformas das calls (a captura na página). ./protocol.ts reexporta. */
export type Platform = 'meet' | 'teams'

/** Hosts de cada plataforma, sem proxy. teams.cloud.microsoft é o domínio novo do Teams corporativo (set/2026). */
export const PLATFORM_HOSTS: Readonly<Record<Platform, readonly string[]>> = {
  meet: ['meet.google.com'],
  teams: ['teams.microsoft.com', 'teams.cloud.microsoft', 'teams.live.com'],
}

/** Sufixos do proxy do Defender for Cloud Apps (comercial e governo). */
export const PROXY_SUFFIXES = ['.mcas.ms', '.mcas-gov.us', '.mcas-gov.ms'] as const

/** Os hosts de uma plataforma: os simples e, para cada um, as formas pelo proxy. */
export function hostsOf(platform: Platform): string[] {
  const plain = PLATFORM_HOSTS[platform]
  return [...plain, ...plain.flatMap((h) => PROXY_SUFFIXES.map((s) => `${h}${s}`))]
}

/** Todos os hosts das calls, na ordem: Meet (simples, proxy), Teams (simples, proxy). */
export const CALL_HOSTS: readonly string[] = [...hostsOf('meet'), ...hostsOf('teams')]

/** Padrões do manifesto (content_scripts.matches e host_permissions). */
export const CALL_MATCHES: readonly string[] = CALL_HOSTS.map((h) => `https://${h}/*`)

const HOST_PLATFORM = new Map<string, Platform>(
  (Object.keys(PLATFORM_HOSTS) as Platform[]).flatMap((p) => hostsOf(p).map((h) => [h, p] as const)),
)

/** Plataforma do host (com ou sem o sufixo do proxy), ou null fora das calls. */
export function platformOfHost(hostname: string | null | undefined): Platform | null {
  if (!hostname) return null
  // DNS não diferencia maiúsculas, e um ponto final ("host.") é o mesmo host.
  return HOST_PLATFORM.get(hostname.toLowerCase().replace(/\.$/, '')) ?? null
}

/** Plataforma de uma URL https das calls, ou null (outra URL, outro protocolo, URL inválida). */
export function platformOfCallUrl(url: string | null | undefined): Platform | null {
  if (!url) return null
  try {
    const u = new URL(url)
    return u.protocol === 'https:' ? platformOfHost(u.hostname) : null
  } catch {
    return null
  }
}

/**
 * Código da reunião no caminho do Meet, com o prefixo /meet/ opcional.
 *
 * Medido numa call real em 23/10/2026: o Google passou a servir a mesma reunião em
 * /meet/<código>, e a detecção parou de reconhecer a call (o código no caminho é o primeiro dos
 * cinco sinais de "em call"). A forma antiga, /<código>, continua valendo, porque os links de
 * convite de antes abrem assim: por isso o prefixo é opcional, e não trocado.
 *
 * Mora aqui, junto dos hosts, pelo mesmo motivo da Emenda 17: três partes leem este caminho (o
 * adaptador do MAIN world, o badge do service worker e a contagem do vigia), e uma forma nova não
 * pode ficar de fora de nenhuma delas. Antes desta correção eram três cópias da mesma expressão.
 *
 * Sem a marca `g`: a expressão é compartilhada, e `lastIndex` tornaria `test` dependente da ordem.
 */
export const MEET_CODE_RE = /^\/(?:meet\/)?([a-z]{3}-[a-z]{4}-[a-z]{3})(?:\/|$)/

/** O código da reunião do Meet no caminho da URL, ou null quando o caminho não é de uma reunião. */
export function meetCodeOfPath(pathname: string | null | undefined): string | null {
  return (pathname && MEET_CODE_RE.exec(pathname)?.[1]) || null
}

export const isMeetHost = (hostname: string | null | undefined): boolean => platformOfHost(hostname) === 'meet'
export const isTeamsHost = (hostname: string | null | undefined): boolean => platformOfHost(hostname) === 'teams'
export const isCallHost = (hostname: string | null | undefined): boolean => platformOfHost(hostname) !== null
