// Relay e o aviso da primeira execução (Emenda 15): a mudança de configuração lida do
// chrome.storage (o caminho que funciona com o SW dormindo) só libera a gravação automática no
// MAIN world com o aviso confirmado. O relay de verdade, com a janela e o chrome falsos e o MAIN
// world representado pela outra ponta de um MessageChannel.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { BRIDGE_ACK, BRIDGE_MARK, BRIDGE_OPEN, BRIDGE_VERSION, SETTINGS_KEY } from '../shared/constants'
import { CONSENT_KEY, CONSENT_VERSION } from '../shared/consent'

type Changes = Record<string, { newValue?: unknown; oldValue?: unknown }>

const stored: Record<string, unknown> = {}
let onChanged: ((changes: Changes, area: string) => void) | null = null
const windowListeners: Array<(ev: unknown) => void> = []
const fakeWindow: Record<string, unknown> = {
  location: { origin: 'https://meet.google.com' },
  addEventListener: (type: string, fn: (ev: unknown) => void) => {
    if (type === 'message') windowListeners.push(fn)
  },
  postMessage: () => {},
}
fakeWindow.top = fakeWindow

const channel = new MessageChannel()
/** O que o MAIN world recebeu do relay. */
const received: Array<Record<string, unknown>> = []

/** Espera a condição (as mensagens do MessageChannel chegam numa volta seguinte do laço). */
async function until(cond: () => boolean, ms = 2000) {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('tempo esgotado')
    await new Promise((r) => setTimeout(r, 5))
  }
}

const confirmed = { version: CONSENT_VERSION, at: 1, via: 'pagina' }

beforeAll(async () => {
  ;(globalThis as unknown as { window: unknown }).window = fakeWindow
  ;(globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: { connect: () => ({ onMessage: { addListener() {} }, onDisconnect: { addListener() {} }, postMessage() {} }), onMessage: { addListener() {} } },
    storage: {
      onChanged: { addListener: (fn: typeof onChanged) => void (onChanged = fn) },
      local: {
        get: async (keys: string[]) => Object.fromEntries(keys.filter((k) => k in stored).map((k) => [k, stored[k]])),
      },
    },
  }
  await import('./relay')
  channel.port1.onmessage = (ev: MessageEvent) => received.push(ev.data as Record<string, unknown>)
  // Aperto de mão como o MAIN world faz (src/main-world/bridge.ts).
  for (const fn of windowListeners) fn({ source: fakeWindow, data: { [BRIDGE_MARK]: BRIDGE_VERSION, dir: 'up', t: BRIDGE_OPEN }, ports: [channel.port2] })
  await until(() => received.some((m) => m.t === BRIDGE_ACK))
})

afterAll(() => {
  channel.port1.close()
  channel.port2.close()
  delete (globalThis as unknown as { window?: unknown }).window
})

beforeEach(() => {
  received.length = 0
  for (const k of Object.keys(stored)) delete stored[k]
})

/** Simula a gravação no storage (o valor fica lá e o onChanged dispara) e espera o settings no MAIN. */
async function change(key: string, value: unknown) {
  stored[key] = value
  onChanged!({ [key]: { newValue: value } }, 'local')
  await expect.poll(() => received.filter((m) => (m.msg as { t?: string } | undefined)?.t === 'settings').length).toBe(1)
  return received.find((m) => (m.msg as { t?: string }).t === 'settings')!.msg
}

describe('relay: configuração lida do storage e o aviso', () => {
  it('ligar as plataformas sem o aviso confirmado: o MAIN recebe as duas desligadas', async () => {
    expect(await change(SETTINGS_KEY, { autoMeet: true, autoTeams: true })).toEqual({ t: 'settings', autoMeet: false, autoTeams: false })
  })

  it('um aviso de versão antiga também não vale', async () => {
    stored[CONSENT_KEY] = { ...confirmed, version: CONSENT_VERSION - 1 }
    expect(await change(SETTINGS_KEY, { autoMeet: true, autoTeams: true })).toEqual({ t: 'settings', autoMeet: false, autoTeams: false })
  })

  it('com o aviso confirmado no storage, vale a configuração de cada plataforma', async () => {
    stored[CONSENT_KEY] = confirmed
    expect(await change(SETTINGS_KEY, { autoMeet: false, autoTeams: true })).toEqual({ t: 'settings', autoMeet: false, autoTeams: true })
  })

  it('confirmar o aviso com a configuração já gravada libera a gravação automática', async () => {
    stored[SETTINGS_KEY] = { autoMeet: true, autoTeams: false }
    expect(await change(CONSENT_KEY, confirmed)).toEqual({ t: 'settings', autoMeet: true, autoTeams: false })
  })

  it('mudança em outra área ou em outra chave não manda nada', async () => {
    onChanged!({ [SETTINGS_KEY]: { newValue: { autoMeet: true } } }, 'sync')
    onChanged!({ outra: { newValue: 1 } }, 'local')
    await new Promise((r) => setTimeout(r, 50))
    expect(received).toEqual([])
  })
})
