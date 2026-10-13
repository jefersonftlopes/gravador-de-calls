// Instalação dos ganchos no MAIN world (chamada pelo hook.iife.ts). Separada do ponto de entrada
// para o vitest conseguir exercitar a regra 1 numa janela falsa: nada aqui pode lançar para a
// página, nem quando falta alguma API básica na frame.
import { HOOK_SYMBOL } from '../shared/constants'
import { installRegistry } from './capture/registry'
import { installSeams } from './capture/seams'
import { createBridge } from './bridge'
import { captureOriginals, makeLog } from './originals'
import { meetAdapter } from './platforms/meet'
import { teamsAdapter } from './platforms/teams'
import type { PlatformAdapter } from './platforms/types'
import { startSessionController } from './session'
import { platformOfHost } from '../shared/hosts'

/** Adaptador pelo host (o simples ou o do proxy do Defender for Cloud Apps, Emenda 17). */
export function pickAdapter(hostname: string): PlatformAdapter | null {
  const platform = platformOfHost(hostname)
  if (platform === 'meet') return meetAdapter
  if (platform === 'teams') return teamsAdapter
  return null
}

export type InstallResult = 'instalado' | 'ja-instalado' | 'sem-plataforma' | 'falhou'

/** Log de reserva quando nem o console original deu para capturar. */
const noop = () => {}

export function installHook(win: Window = window): InstallResult {
  try {
    const w = win as unknown as Record<symbol, unknown>
    const mark = Symbol.for(HOOK_SYMBOL)
    if (w[mark]) return 'ja-instalado'
    Object.defineProperty(w, mark, { value: true, enumerable: false, configurable: false, writable: false })
  } catch {
    return 'falhou'
  }
  let log: (...a: unknown[]) => void = noop
  try {
    const orig = captureOriginals(win)
    log = makeLog(orig)
    const registry = installRegistry(orig, log)
    const seams = installSeams(orig, registry, log)
    // O adaptador sai do host; o gate fino (código da reunião na URL) é reavaliado a cada 1 s,
    // porque o Meet e o Teams são SPAs.
    const adapter = pickAdapter(win.location.hostname)
    if (!adapter) return 'sem-plataforma'
    registry.setTrackFilter(adapter.filterReceiverTracks?.bind(adapter))
    // Emenda 18: escuta passiva dos sinais de falante. Falhar aqui não impede a gravação.
    try {
      adapter.installSpeakerSignals?.({ orig, registry, log })
    } catch (e) {
      log('sinais de falante', e)
    }
    const bridge = createBridge(orig, log)
    startSessionController({ orig, log, adapter, registry, seams, bridge })
    return 'instalado'
  } catch (e) {
    try {
      log('falha ao instalar', e)
    } catch {
      // nada: regra 1
    }
    return 'falhou'
  }
}
