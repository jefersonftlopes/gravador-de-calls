// Tipo dos handlers do documento offscreen. Cada fatia preenche só o seu arquivo:
//   ./blob.ts  destino downloads (fatia de durabilidade): offscreen:blob-url, offscreen:revoke
//   ./tab.ts   modo aba (fatia do modo aba): offscreen:tab-start, offscreen:tab-stop, offscreen:tab-replay
//   ./mic.ts   microfone por aba (Emenda 25): offscreen:mic-start, offscreen:mic-gate, offscreen:mic-stop
// O roteador (./offscreen.ts) junta os dois e o TypeScript confere que todo OffscreenReq tem dono.
import type { OffscreenReq, OffscreenResMap } from '../shared/protocol'

export type OffscreenType = OffscreenReq['t']

export type OffscreenHandler<K extends OffscreenType> = (req: Extract<OffscreenReq, { t: K }>) => Promise<OffscreenResMap[K]>

export type OffscreenHandlers<K extends OffscreenType> = { [P in K]: OffscreenHandler<P> }

export const notYet = { ok: false, error: 'ainda não implementado' } as const
