// O Port nativo ocioso fecha sozinho (Emenda 20): sem isto, o processo do helper que o Chrome abriu
// continuava vivo com o código antigo depois de um `npm run instalar`.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

interface FakeNativePort {
  posted: Array<{ id: number; op: string }>
  disconnect: ReturnType<typeof vi.fn>
  reply(id: number, extra?: Record<string, unknown>): void
}

let ports: FakeNativePort[] = []

function installChrome() {
  ports = []
  vi.stubGlobal('chrome', {
    ...(globalThis as unknown as { chrome: object }).chrome,
    runtime: {
      ...((globalThis as unknown as { chrome?: { runtime?: object } }).chrome?.runtime ?? {}),
      lastError: undefined,
      connectNative: vi.fn(() => {
        const msgListeners: Array<(m: unknown) => void> = []
        const p: FakeNativePort = {
          posted: [],
          disconnect: vi.fn(),
          reply: (id, extra = {}) => msgListeners.forEach((l) => l({ id, ok: true, ...extra })),
        }
        ports.push(p)
        return {
          postMessage: (m: { id: number; op: string }) => p.posted.push(m),
          disconnect: p.disconnect,
          onMessage: { addListener: (l: (m: unknown) => void) => msgListeners.push(l) },
          onDisconnect: { addListener: () => {} },
        }
      }),
    },
  })
}

type SinkHost = typeof import('./sink-host')

async function load(): Promise<SinkHost> {
  vi.resetModules()
  installChrome()
  return import('./sink-host')
}

/** Faz um pedido e responde na hora pelo Port falso. */
async function roundTrip(mod: SinkHost, op: 'ping' | 'get-config' = 'get-config') {
  const pr = mod.hostRequest({ op } as Parameters<SinkHost['hostRequest']>[0], 60_000)
  const p = ports.at(-1)!
  p.reply(p.posted.at(-1)!.id, { version: '0.5.0', root: '/raiz', writable: true })
  return pr
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('Port ocioso do helper (Emenda 20)', () => {
  it('sem gravação, fecha 30 s depois da última resposta, e o pedido seguinte abre outro processo', async () => {
    const mod = await load()
    expect((await roundTrip(mod)).ok).toBe(true)
    await vi.advanceTimersByTimeAsync(mod.IDLE_RELEASE_MS - 1)
    expect(ports[0].disconnect).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(ports[0].disconnect).toHaveBeenCalledTimes(1)
    await roundTrip(mod)
    expect(chrome.runtime.connectNative).toHaveBeenCalledTimes(2)
    expect(ports).toHaveLength(2)
  })

  it('com uma gravação em andamento, não fecha', async () => {
    const mod = await load()
    let recording = true
    mod.keepHostWhile(() => recording)
    await roundTrip(mod)
    await vi.advanceTimersByTimeAsync(mod.IDLE_RELEASE_MS * 3)
    expect(ports[0].disconnect).not.toHaveBeenCalled()
    // A gravação acabou: a próxima resposta arma de novo e o Port fecha depois de 30 s.
    recording = false
    await roundTrip(mod)
    await vi.advanceTimersByTimeAsync(mod.IDLE_RELEASE_MS)
    expect(ports[0].disconnect).toHaveBeenCalledTimes(1)
  })

  it('um pedido pendente segura o Port (o helper ainda está trabalhando)', async () => {
    const mod = await load()
    void mod.hostRequest({ op: 'get-config' }, 120_000)
    await vi.advanceTimersByTimeAsync(mod.IDLE_RELEASE_MS * 2)
    expect(ports[0].disconnect).not.toHaveBeenCalled()
  })

  it('um pedido novo adia o fechamento (o popup aberto pergunta a cada 2 s)', async () => {
    const mod = await load()
    await roundTrip(mod)
    for (let k = 0; k < 10; k++) {
      await vi.advanceTimersByTimeAsync(2000)
      await roundTrip(mod)
    }
    await vi.advanceTimersByTimeAsync(mod.IDLE_RELEASE_MS - 1000)
    expect(ports[0].disconnect).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1000)
    expect(ports[0].disconnect).toHaveBeenCalledTimes(1)
    expect(ports).toHaveLength(1)
  })

  it('um pedido que passou do tempo também arma o fechamento', async () => {
    const mod = await load()
    const r = mod.hostRequest({ op: 'get-config' }, 5000)
    await vi.advanceTimersByTimeAsync(5000)
    expect((await r).ok).toBe(false)
    await vi.advanceTimersByTimeAsync(mod.IDLE_RELEASE_MS)
    expect(ports[0].disconnect).toHaveBeenCalledTimes(1)
  })
})
