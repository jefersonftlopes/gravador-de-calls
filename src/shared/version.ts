// Versão que cada parte da extensão está rodando (Emenda 17).
//
// Numa extensão carregada sem compactação, o Chrome guarda o script do service worker até a
// extensão ser recarregada, mas lê as páginas (popup, configurações) do disco a cada abertura.
// Depois de publicar, o popup novo conversava com o SW antigo, que não conhecia os pedidos novos
// (achado de uso real em 08/10/2026: SW 0.1.2 com o popup 0.3.0, e o volume não fazia nada). Por
// isso cada bundle leva a versão e o identificador do build (`__APP_VERSION__` e `__BUILD_ID__`,
// do vite.config.ts), o SW devolve os dele no ui:state, e as telas comparam.
import { t } from './i18n'
import type { AutoReloadState, AutoReloadWait, BuildInfo } from './protocol'

/** O que este bundle é (./baked.ts). */
export { BAKED } from './baked'

/** Uma versão rodando diferente da que está no disco: `running` null quando o SW nem diz a dele. */
export interface VersionSkew {
  running: string | null
  available: string
}

/** O rótulo de um build: só a versão, ou a versão com o build quando as duas versões são iguais. */
function label(b: BuildInfo, other: BuildInfo): string {
  return b.version === other.version && b.build !== other.build ? `${b.version} (${b.build.slice(0, 7)})` : b.version
}

const same = (a: BuildInfo, b: BuildInfo) => a.version === b.version && a.build === b.build

/**
 * Compara a página (`page`, o bundle desta tela), o SW (`worker`, do ui:state; ausente num SW
 * anterior à 0.3.1), o manifesto que o Chrome carregou (`manifestVersion`) e a publicação que o
 * SW viu e ainda não está rodando (`update`). Devolve null quando está tudo igual.
 */
export function versionSkew(page: BuildInfo, worker: BuildInfo | null | undefined, manifestVersion: string | null | undefined, update?: AutoReloadState | null): VersionSkew | null {
  if (worker && update?.published && !same(update.published, worker)) return { running: label(worker, update.published), available: label(update.published, worker) }
  if (!worker) return { running: manifestVersion && manifestVersion !== page.version ? manifestVersion : null, available: page.version }
  if (!same(worker, page)) return { running: label(worker, page), available: label(page, worker) }
  if (manifestVersion && manifestVersion !== page.version) return { running: manifestVersion, available: page.version }
  return null
}

/** O texto do aviso de versão. */
export function versionSkewText(skew: VersionSkew): string {
  return skew.running ? t('versionSkew', skew.running, skew.available) : t('versionSkewUnknown', skew.available)
}

/** O que segura a recarga sozinha, no idioma da interface. */
export function autoReloadWaitLabel(wait: AutoReloadWait): string {
  switch (wait) {
    case 'gravando':
      return t('autoReloadWaitRecording')
    case 'salvando':
      return t('autoReloadWaitSaving')
    case 'call-aberta':
      return t('autoReloadWaitCall')
    case 'volume':
      return t('autoReloadWaitVolume')
    case 'iniciando-captura':
      return t('autoReloadWaitStarting')
    case 'configuracoes-abertas':
      return t('autoReloadWaitOptions')
  }
}

/** A versão do manifesto que o Chrome carregou (null fora da extensão). */
export function loadedManifestVersion(): string | null {
  try {
    return chrome.runtime.getManifest().version
  } catch {
    return null
  }
}
