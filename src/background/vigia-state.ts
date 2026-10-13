// Último estado do vigia por aba (lido pelo popup e pelas sessões, sem import circular).
import type { VigiaStatus } from '../shared/protocol'

const statuses = new Map<number, VigiaStatus>()

export function setVigiaStatus(tabId: number, status: VigiaStatus): void {
  statuses.set(tabId, status)
}

export function clearVigiaStatus(tabId: number): void {
  statuses.delete(tabId)
}

export function vigiaStatusOf(tabId: number): VigiaStatus | null {
  return statuses.get(tabId) ?? null
}

export function allVigiaStatuses(): Array<{ tabId: number; status: VigiaStatus }> {
  return [...statuses].map(([tabId, status]) => ({ tabId, status }))
}
