// Recarga sozinha da cópia publicada (Emenda 17): a regra pura e a conferência do SW com o
// Chrome, o IndexedDB e as sessões trocados por falsos. Recarrega só com a publicação diferente do
// código embutido e nada em uso; espera com gravação, gravação sendo salva, aba do Meet ou do
// Teams, volume de aba, captura sendo pedida (a fila de verdade do ./tabvolume.ts) ou a página de
// configurações aberta; e não entra em laço quando o código do disco continua o anterior.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AutoReloadInputs } from './auto-reload'

const fake = vi.hoisted(() => ({
  stamp: null as unknown,
  stampStatus: 200,
  active: [] as Array<{ sessionId: string }>,
  pending: [] as Array<{ sessionId: string }>,
  idb: {} as Record<string, Array<{ sessionId: string }>>,
  tabs: [] as Array<{ id: number; url: string }>,
  captured: [] as Array<{ tabId: number; status: string }>,
  storage: {} as Record<string, unknown>,
  reloads: 0,
  alarms: new Set<string>(),
  queries: [] as unknown[],
  /** Contextos da extensão (chrome.runtime.getContexts). */
  contexts: [] as Array<{ contextType: string; documentUrl?: string }>,
}))

vi.mock('./sessions', () => ({
  activeRecordings: () => fake.active,
  pendingSaves: () => fake.pending,
}))
vi.mock('./idb', () => ({
  listSessions: async (status: string) => fake.idb[status] ?? [],
}))

function installChrome() {
  ;(globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: {
      getURL: (p: string) => `chrome-extension://id/${p}`,
      getContexts: async (f: { contextTypes?: string[] }) => fake.contexts.filter((c) => !f.contextTypes || f.contextTypes.includes(c.contextType)),
      reload: () => {
        fake.reloads++
      },
    },
    tabs: {
      query: async (q: { url: string[] }) => {
        fake.queries.push(q)
        return fake.tabs
      },
    },
    tabCapture: { getCapturedTabs: async () => fake.captured },
    storage: {
      local: {
        get: async (k: string) => (k in fake.storage ? { [k]: fake.storage[k] } : {}),
        set: async (o: Record<string, unknown>) => void Object.assign(fake.storage, o),
      },
    },
    alarms: {
      create: async (name: string) => void fake.alarms.add(name),
      clear: async (name: string) => fake.alarms.delete(name),
      onAlarm: { addListener: () => {} },
    },
  }
  ;(globalThis as unknown as { fetch: unknown }).fetch = async (url: string) => {
    expect(url).toBe('chrome-extension://id/publicado.json')
    if (fake.stamp === null) throw new TypeError('Failed to fetch')
    return { ok: fake.stampStatus === 200, json: async () => fake.stamp }
  }
}

async function load() {
  vi.resetModules()
  installChrome()
  return import('./auto-reload')
}

beforeEach(() => {
  fake.stamp = null
  fake.stampStatus = 200
  fake.active = []
  fake.pending = []
  fake.idb = {}
  fake.tabs = []
  fake.captured = []
  fake.storage = {}
  fake.reloads = 0
  fake.alarms = new Set()
  fake.queries = []
  fake.contexts = []
})

const BAKED = { version: '0.3.1', build: 'vitest' }
const idle = (over: Partial<AutoReloadInputs> = {}): AutoReloadInputs => ({
  baked: BAKED,
  stamp: { versao: '0.3.2', build: 'novo' },
  recordings: 0,
  saving: 0,
  callTabs: 0,
  capturedTabs: 0,
  startingCaptures: 0,
  optionsPages: 0,
  lastAttempt: null,
  ...over,
})

describe('decideAutoReload', () => {
  it('sem publicação (loja, dist/) ou em dia: nada', async () => {
    const { decideAutoReload } = await load()
    expect(decideAutoReload(idle({ stamp: null }))).toEqual({ action: 'nada', why: 'sem-publicacao' })
    expect(decideAutoReload(idle({ stamp: { versao: '0.3.1', build: 'vitest' } }))).toEqual({ action: 'nada', why: 'em-dia' })
    // Publicação de antes da 0.3.1 (sem build): só a versão conta.
    expect(decideAutoReload(idle({ stamp: { versao: '0.3.1' } }))).toEqual({ action: 'nada', why: 'em-dia' })
  })

  it('outra versão, ou a mesma versão com outro build, e nada em uso: recarregar', async () => {
    const { decideAutoReload } = await load()
    expect(decideAutoReload(idle())).toEqual({ action: 'recarregar', published: { version: '0.3.2', build: 'novo' }, key: '0.3.2+novo' })
    expect(decideAutoReload(idle({ stamp: { versao: '0.3.1', build: 'outro' } }))).toMatchObject({ action: 'recarregar' })
    // Uma versão mais velha publicada também é outra: o disco manda.
    expect(decideAutoReload(idle({ stamp: { versao: '0.3.0', impressao: 'abc' } }))).toMatchObject({ action: 'recarregar', key: '0.3.0+abc' })
  })

  it('algo em uso: espera, dizendo o quê', async () => {
    const { decideAutoReload } = await load()
    expect(decideAutoReload(idle({ recordings: 1 }))).toEqual({ action: 'esperar', published: { version: '0.3.2', build: 'novo' }, waiting: ['gravando'] })
    expect(decideAutoReload(idle({ saving: 1 }))).toMatchObject({ action: 'esperar', waiting: ['salvando'] })
    expect(decideAutoReload(idle({ callTabs: 2 }))).toMatchObject({ action: 'esperar', waiting: ['call-aberta'] })
    expect(decideAutoReload(idle({ capturedTabs: 1 }))).toMatchObject({ action: 'esperar', waiting: ['volume'] })
    expect(decideAutoReload(idle({ startingCaptures: 1 }))).toMatchObject({ action: 'esperar', waiting: ['iniciando-captura'] })
    expect(decideAutoReload(idle({ optionsPages: 1 }))).toMatchObject({ action: 'esperar', waiting: ['configuracoes-abertas'] })
    expect(decideAutoReload(idle({ recordings: 1, callTabs: 1, capturedTabs: 1, saving: 1, startingCaptures: 1, optionsPages: 1 }))).toMatchObject({
      waiting: ['gravando', 'salvando', 'call-aberta', 'volume', 'iniciando-captura', 'configuracoes-abertas'],
    })
  })

  it('já recarregou para esta mesma publicação: desiste (sem laço); uma publicação nova tenta de novo', async () => {
    const { decideAutoReload } = await load()
    const lastAttempt = { key: '0.3.2+novo', at: 1, from: '0.3.1', to: '0.3.2' }
    expect(decideAutoReload(idle({ lastAttempt }))).toEqual({ action: 'desistir', published: { version: '0.3.2', build: 'novo' } })
    expect(decideAutoReload(idle({ lastAttempt, stamp: { versao: '0.3.3', build: 'x' } }))).toMatchObject({ action: 'recarregar' })
  })

  it('parseStamp aceita só um carimbo com versão', async () => {
    const { parseStamp } = await load()
    expect(parseStamp({ versao: '0.3.2', impressao: 'abc', build: 'b', em: 'x' })).toEqual({ versao: '0.3.2', impressao: 'abc', build: 'b', em: 'x' })
    expect(parseStamp({ versao: '0.3.2', build: '' })).toEqual({ versao: '0.3.2' })
    for (const bad of [null, 'x', {}, { versao: 3 }, { versao: 'abc' }]) expect(parseStamp(bad)).toBeNull()
  })
})

describe('checkPublishedVersion (o SW)', () => {
  it('sem publicado.json: nada, e o alarme sai', async () => {
    const mod = await load()
    fake.alarms.add(mod.AUTO_RELOAD_ALARM)
    expect(await mod.checkPublishedVersion()).toEqual({ action: 'nada', why: 'sem-publicacao' })
    expect(fake.alarms.has(mod.AUTO_RELOAD_ALARM)).toBe(false)
    expect(fake.reloads).toBe(0)
  })

  it('publicação nova e nada em uso: grava a tentativa e recarrega; com o mesmo código depois da recarga, não recarrega de novo', async () => {
    const mod = await load()
    fake.stamp = { versao: '0.3.2', build: 'novo', impressao: 'i' }
    expect(await mod.checkPublishedVersion()).toMatchObject({ action: 'recarregar' })
    expect(fake.reloads).toBe(1)
    expect(fake.storage[mod.AUTO_RELOAD_KEY]).toMatchObject({ key: '0.3.2+novo', from: expect.any(String), to: '0.3.2' })
    expect(fake.alarms.has(mod.AUTO_RELOAD_ALARM)).toBe(true)
    // As abas consultadas são as dos hosts das calls, com o proxy.
    expect((fake.queries[0] as { url: string[] }).url).toContain('https://teams.cloud.microsoft.mcas.ms/*')
    // O SW "novo" sobe com o mesmo código (o publicado.json não bate com o disco).
    const again = await load()
    expect(await again.checkPublishedVersion()).toMatchObject({ action: 'desistir' })
    expect(fake.reloads).toBe(1)
    expect(again.autoReloadState()).toMatchObject({ gaveUp: true })
  })

  it('com gravação (na memória ou só no IndexedDB), gravação por salvar, aba de call ou volume: espera e não recarrega', async () => {
    const mod = await load()
    fake.stamp = { versao: '0.3.2', build: 'novo' }
    fake.active = [{ sessionId: 'a' }]
    expect(await mod.checkPublishedVersion()).toMatchObject({ action: 'esperar', waiting: ['gravando'] })
    fake.active = []
    fake.idb = { gravando: [{ sessionId: 'b' }] }
    expect(await mod.checkPublishedVersion()).toMatchObject({ action: 'esperar', waiting: ['gravando'] })
    fake.idb = { finalizando: [{ sessionId: 'c' }] }
    expect(await mod.checkPublishedVersion()).toMatchObject({ action: 'esperar', waiting: ['salvando'] })
    fake.idb = {}
    fake.tabs = [{ id: 3, url: 'https://teams.cloud.microsoft.mcas.ms/v2/' }]
    expect(await mod.checkPublishedVersion()).toMatchObject({ action: 'esperar', waiting: ['call-aberta'] })
    fake.tabs = []
    fake.captured = [{ tabId: 4, status: 'active' }]
    expect(await mod.checkPublishedVersion()).toMatchObject({ action: 'esperar', waiting: ['volume'] })
    expect(mod.autoReloadState()).toEqual({ published: { version: '0.3.2', build: 'novo' }, waiting: ['volume'], gaveUp: false })
    expect(fake.reloads).toBe(0)
    // Tudo livre: na próxima conferência (o alarme), recarrega.
    fake.captured = [{ tabId: 4, status: 'stopped' }]
    expect(await mod.checkPublishedVersion()).toMatchObject({ action: 'recarregar' })
    expect(fake.reloads).toBe(1)
  })

  it('captura sendo pedida (atalho ou popup, antes de a sessão existir): espera, e recarrega quando a fila da aba esvazia', async () => {
    const mod = await load()
    // O mesmo módulo que o auto-reload carregou (a fila de verdade do volume e do modo aba).
    const tv = await import('./tabvolume')
    fake.stamp = { versao: '0.3.2', build: 'novo' }
    let release!: () => void
    const held = tv.withTabLock(9, () => new Promise<void>((r) => (release = r)))
    expect(await mod.checkPublishedVersion()).toMatchObject({ action: 'esperar', waiting: ['iniciando-captura'] })
    expect(fake.reloads).toBe(0)
    release()
    await held
    await new Promise((r) => setTimeout(r, 0))
    expect(await mod.checkPublishedVersion()).toMatchObject({ action: 'recarregar' })
    expect(fake.reloads).toBe(1)
  })

  it('página de configurações aberta: espera (recarregar fecharia a página e o que não foi salvo); outras páginas da extensão não seguram', async () => {
    const mod = await load()
    fake.stamp = { versao: '0.3.2', build: 'novo' }
    fake.contexts = [
      { contextType: 'BACKGROUND', documentUrl: undefined },
      { contextType: 'TAB', documentUrl: 'chrome-extension://id/src/options/index.html' },
    ]
    expect(await mod.checkPublishedVersion()).toMatchObject({ action: 'esperar', waiting: ['configuracoes-abertas'] })
    fake.contexts = [
      { contextType: 'TAB', documentUrl: 'chrome-extension://id/src/popup/index.html?tabId=3' },
      { contextType: 'OFFSCREEN_DOCUMENT', documentUrl: 'chrome-extension://id/src/offscreen/index.html' },
    ]
    expect(await mod.checkPublishedVersion()).toMatchObject({ action: 'recarregar' })
    expect(fake.reloads).toBe(1)
  })
})
