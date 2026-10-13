// Decisão do toggle do modo aba (tabcapture.ts) com o SW, o IndexedDB e o offscreen trocados por
// falsos: os casos que o ponta a ponta não alcança de forma determinística.
// - logo depois de o SW reiniciar (a sessão só no IndexedDB), parar acha a sessão lá e, se o
//   offscreen não tinha a captura, o SW fecha a sessão pelo prazo de ORPHAN_STOP_MS;
// - um registro "gravando" que sobrou de uma queda num tabId reusado não vira um "parar";
// - dois toggles ao mesmo tempo dão um só início;
// - a devolução do som começa ligada e o popup troca (Emendas 11 e 12);
// - a aba com a captura só de volume (Emenda 14): o toggle começa o modo aba em cima dela, sem
//   outro getMediaStreamId; sem o volume, a captura sem sessão continua sendo um "parar"; e o
//   volume e o toggle ao mesmo tempo passam pela mesma fila (uma captura só).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ActiveRecording } from '../shared/protocol'
import { useLocale } from '../../tests/helpers/i18n-setup'

const fake = vi.hoisted(() => ({
  active: [] as Array<Partial<ActiveRecording>>,
  stored: [] as Array<{ sessionId: string; kind: string; tabId: number; status: string }>,
  captured: [] as Array<{ tabId: number; status: string }>,
  offscreen: [] as Array<Record<string, unknown>>,
  stopped: [] as string[],
  created: [] as Array<Record<string, unknown>>,
  streamIds: 0,
  /** Resposta do relay à pergunta da saída da página (undefined: aba sem relay). */
  pageOutput: undefined as { especifica: boolean } | undefined,
  /** Modo da captura da aba no offscreen (offscreen:tab-audio). Emenda 14. */
  audioMode: null as 'volume' | 'gravando' | null,
  /** Respostas do offscreen ao tab-start, na ordem (sem nada: ok). */
  tabStartReplies: [] as Array<{ ok: boolean; error?: string }>,
  /** O offscreen falso guarda a captura que abriu (getCapturedTabs e tab-audio passam a vê-la). */
  stateful: false,
  /** Outra extensão (o Volume Master, por exemplo) segura a captura da aba. Emenda 17. */
  otherExtension: false,
}))

vi.mock('./idb', () => ({
  listSessions: async (status?: string) => fake.stored.filter((r) => !status || r.status === status),
  getSession: async (id: string) => fake.stored.find((r) => r.sessionId === id),
}))
vi.mock('./offscreen-doc', () => ({
  ensureOffscreen: async () => {},
  sendToOffscreen: async (req: Record<string, unknown>) => {
    fake.offscreen.push(req)
    if (req.t === 'offscreen:tab-audio') return { mode: fake.audioMode, volume: fake.audioMode ? 0.3 : 1, replay: true, gain: fake.audioMode ? 0.3 : 1 }
    if (req.t === 'offscreen:tab-start') {
      const r = fake.tabStartReplies.shift() ?? { ok: true }
      if (fake.stateful && r.ok) {
        fake.captured = [{ tabId: req.tabId as number, status: 'active' }]
        fake.audioMode = 'gravando'
      }
      return r
    }
    if (req.t === 'offscreen:tab-volume-start' && fake.stateful) {
      fake.captured = [{ tabId: req.tabId as number, status: 'active' }]
      fake.audioMode = 'volume'
    }
    return { ok: true }
  },
}))
vi.mock('./sessions', () => ({
  activeRecordings: () => fake.active,
  createSession: async (opts: Record<string, unknown>) => {
    fake.created.push(opts)
    return { sessionId: `nova-${fake.created.length}` }
  },
  onPageSessionEnded: () => () => {},
  stopSession: async (id: string) => {
    fake.stopped.push(id)
    return true
  },
}))
vi.mock('./testing', () => ({ registerTestHooks: () => {} }))

const TAB = 7

function installChrome() {
  ;(globalThis as unknown as { chrome: unknown }).chrome = {
    tabCapture: {
      getCapturedTabs: async () => fake.captured,
      getMediaStreamId: async ({ targetTabId }: { targetTabId: number }) => {
        // O Chrome recusa uma segunda captura da mesma aba (também a de outra extensão).
        if (fake.otherExtension) throw new Error('Cannot capture a tab with an active stream.')
        if (fake.stateful && fake.captured.some((c) => c.tabId === targetTabId)) throw new Error('Cannot capture a tab with an active stream.')
        fake.streamIds++
        // O Chrome demora um pouco para entregar o ID: dá tempo de um segundo toggle chegar.
        await new Promise((r) => setTimeout(r, 20))
        return `stream-${fake.streamIds}`
      },
    },
    tabs: {
      get: async (tabId: number) => ({ id: tabId, title: 'Tom de teste', url: 'https://outro-site.test/__tom' }),
      sendMessage: async () => {
        if (!fake.pageOutput) throw new Error('Could not establish connection. Receiving end does not exist.')
        return fake.pageOutput
      },
      onRemoved: { addListener: () => {} },
    },
    commands: { onCommand: { addListener: () => {} } },
  }
}

async function load() {
  vi.resetModules()
  installChrome()
  return import('./tabcapture')
}

beforeEach(() => {
  fake.active = []
  fake.stored = []
  fake.captured = []
  fake.offscreen = []
  fake.stopped = []
  fake.created = []
  fake.streamIds = 0
  fake.pageOutput = undefined
  fake.audioMode = null
  fake.tabStartReplies = []
  fake.stateful = false
  fake.otherExtension = false
})

afterEach(() => {
  vi.useRealTimers()
  useLocale('pt_BR')
})

describe('toggle do modo aba', () => {
  it('outra extensão segurando a captura da aba: o erro diz o que fazer, nas duas línguas, e nada começa (Emenda 17)', async () => {
    const mod = await load()
    fake.otherExtension = true
    expect(await mod.toggleTabCapture(TAB)).toEqual({
      ok: false,
      error: 'Outra extensão (por exemplo, o Volume Master) já está capturando o som desta aba. Desligue essa extensão em chrome://extensions, ou feche e reabra a aba, e tente de novo.',
    })
    expect(fake.created, 'nenhuma sessão').toEqual([])
    expect(fake.offscreen.filter((r) => r.t === 'offscreen:tab-start')).toEqual([])
    useLocale('en')
    const r = await mod.toggleTabCapture(TAB)
    expect(r).toMatchObject({ ok: false })
    expect('error' in r && r.error).toMatch(/^Another extension \(for example, Volume Master\) is already capturing this tab's sound\./)
  })

  it('logo depois de o SW reiniciar, parar acha a sessão no IndexedDB e a fecha se o offscreen não tinha a captura', async () => {
    const mod = await load()
    vi.useFakeTimers()
    // A sessão não voltou à memória do SW, mas está no IndexedDB e o Chrome vê a aba capturada.
    fake.stored = [{ sessionId: 'S-aba', kind: 'aba', tabId: TAB, status: 'gravando' }]
    fake.captured = [{ tabId: TAB, status: 'active' }]
    expect(await mod.toggleTabCapture(TAB)).toEqual({ ok: true })
    expect(fake.streamIds, 'virou um início').toBe(0)
    expect(fake.offscreen).toEqual([{ target: 'offscreen', t: 'offscreen:tab-stop', tabId: TAB, reason: 'parado-pelo-usuario' }])
    // O offscreen respondeu, mas nenhum session:end chegou (ele não tinha a captura): a sessão
    // continua "gravando" e o SW fecha com o que já chegou, passado o prazo.
    await vi.advanceTimersByTimeAsync(11_000)
    expect(fake.stopped).toEqual([])
    await vi.advanceTimersByTimeAsync(2_000)
    expect(fake.stopped).toEqual(['S-aba'])
  })

  it('a sessão saiu de "gravando" dentro do prazo: o SW não fecha nada', async () => {
    const mod = await load()
    vi.useFakeTimers()
    fake.stored = [{ sessionId: 'S-aba', kind: 'aba', tabId: TAB, status: 'gravando' }]
    fake.captured = [{ tabId: TAB, status: 'active' }]
    expect(await mod.toggleTabCapture(TAB)).toEqual({ ok: true })
    fake.stored[0].status = 'finalizando'
    await vi.advanceTimersByTimeAsync(13_000)
    expect(fake.stopped).toEqual([])
  })

  it('um registro "gravando" que sobrou de uma queda num tabId reusado não vira "parar": a aba nova começa a gravar', async () => {
    const mod = await load()
    fake.stored = [{ sessionId: 'S-velha', kind: 'aba', tabId: TAB, status: 'gravando' }]
    fake.captured = []
    expect(await mod.toggleTabCapture(TAB)).toEqual({ ok: true })
    expect(fake.streamIds).toBe(1)
    expect(fake.created).toHaveLength(1)
    expect(fake.offscreen.map((r) => r.t)).toEqual(['offscreen:tab-start'])
    expect(fake.stopped).toEqual([])
  })

  it('dois toggles ao mesmo tempo dão um só início, com o mesmo resultado', async () => {
    const mod = await load()
    const [a, b] = await Promise.all([mod.toggleTabCapture(TAB), mod.toggleTabCapture(TAB)])
    expect(a).toEqual({ ok: true })
    expect(b).toEqual(a)
    expect(fake.streamIds).toBe(1)
    expect(fake.created).toHaveLength(1)
  })

  it('fora dos hosts das calls a plataforma é "outro" e o título e a URL da aba (activeTab) vão nos metadados', async () => {
    const mod = await load()
    expect(await mod.toggleTabCapture(TAB)).toEqual({ ok: true })
    expect(fake.created[0]).toMatchObject({
      kind: 'aba',
      platform: 'outro',
      meta: { url: 'https://outro-site.test/__tom', tabTitle: 'Tom de teste', title: 'Tom de teste', titleSource: 'titulo-da-aba' },
    })
    expect(mod.platformOfUrl('https://meet.google.com/abc-defg-hij')).toBe('meet')
    expect(mod.platformOfUrl('https://teams.cloud.microsoft/v2/')).toBe('teams')
    // Pelo proxy do Defender for Cloud Apps (Emenda 17), a mesma plataforma.
    expect(mod.platformOfUrl('https://teams.cloud.microsoft.mcas.ms/v2/')).toBe('teams')
    expect(mod.platformOfUrl('https://teams.microsoft.com.mcas-gov.us/')).toBe('teams')
    expect(mod.platformOfUrl('https://meet.google.com.mcas.ms/abc-defg-hij')).toBe('meet')
    expect(mod.platformOfUrl('https://app.zoom.us/wc/123')).toBe('outro')
    // Sem permissão o Chrome não dá a URL: só pode ser fora dos hosts das calls.
    expect(mod.platformOfUrl(undefined)).toBe('outro')
  })

  it('devolução: começa ligada mesmo com a página numa saída própria (Emenda 12); o popup troca', async () => {
    const mod = await load()
    fake.pageOutput = { especifica: true }
    expect(await mod.toggleTabCapture(TAB)).toEqual({ ok: true })
    expect(fake.offscreen.find((m) => m.t === 'offscreen:tab-start')).toMatchObject({ replay: true })
    expect(mod.tabReplay(TAB)).toBe(true)
    expect(await mod.setTabReplay(TAB, false)).toEqual({ ok: true })
    expect(fake.offscreen.at(-1)).toEqual({ target: 'offscreen', t: 'offscreen:tab-replay', tabId: TAB, on: false })
    expect(mod.tabReplay(TAB)).toBe(false)
    // Aba fora do modo aba: nada a trocar.
    expect((await mod.setTabReplay(99, true)).ok).toBe(false)
  })

  it('com a captura só de volume, o toggle começa o modo aba em cima dela, sem outro getMediaStreamId (Emenda 14)', async () => {
    const mod = await load()
    fake.captured = [{ tabId: TAB, status: 'active' }]
    fake.audioMode = 'volume'
    expect(await mod.toggleTabCapture(TAB)).toEqual({ ok: true })
    expect(fake.streamIds, 'o Chrome recusaria uma segunda captura da aba').toBe(0)
    expect(fake.created).toHaveLength(1)
    const startReq = fake.offscreen.find((m) => m.t === 'offscreen:tab-start')!
    expect(startReq).toMatchObject({ tabId: TAB, sessionId: 'nova-1', replay: true })
    expect(startReq.streamId).toBeUndefined()
    expect(fake.offscreen.some((m) => m.t === 'offscreen:tab-stop'), 'virou um parar').toBe(false)
  })

  it('a captura de volume que sumiu entre a decisão e o início: o SW pede um ID novo e grava', async () => {
    const mod = await load()
    fake.captured = [{ tabId: TAB, status: 'active' }]
    fake.audioMode = 'volume'
    fake.tabStartReplies = [{ ok: false, error: 'a aba não tem captura para reaproveitar' }]
    expect(await mod.toggleTabCapture(TAB)).toEqual({ ok: true })
    expect(fake.streamIds).toBe(1)
    const starts = fake.offscreen.filter((m) => m.t === 'offscreen:tab-start')
    expect(starts.map((m) => m.streamId)).toEqual([undefined, 'stream-1'])
    expect(fake.stopped).toEqual([])
  })

  it('a falha do offscreen chega ao popup no idioma da interface (Emenda 15), e a sessão é descartada', async () => {
    useLocale('en')
    const mod = await load()
    fake.tabStartReplies = [{ ok: false, error: 'a captura da aba veio sem áudio' }]
    expect(await mod.toggleTabCapture(TAB)).toEqual({ ok: false, error: 'the tab capture came without audio' })
    expect(fake.stopped).toEqual(['nova-1'])
    // Um erro cru do navegador passa como veio.
    fake.tabStartReplies = [{ ok: false, error: 'AbortError: x' }]
    expect(await mod.toggleTabCapture(TAB)).toEqual({ ok: false, error: 'AbortError: x' })
  })

  it('aba capturada sem sessão e sem volume (captura órfã) continua sendo um parar', async () => {
    const mod = await load()
    fake.captured = [{ tabId: TAB, status: 'active' }]
    fake.audioMode = null
    expect(await mod.toggleTabCapture(TAB)).toEqual({ ok: true })
    expect(fake.streamIds).toBe(0)
    expect(fake.created).toEqual([])
    expect(fake.offscreen.map((m) => m.t)).toEqual(['offscreen:tab-audio', 'offscreen:tab-stop'])
  })
  it('volume e toggle ao mesmo tempo numa aba sem captura: a mesma fila, uma captura só (Emenda 14)', async () => {
    const mod = await load()
    const volume = await import('./tabvolume')
    fake.stateful = true
    const [v, t] = await Promise.all([volume.setTabVolume(TAB, 0.5), mod.toggleTabCapture(TAB)])
    expect(v).toMatchObject({ ok: true, mode: 'volume' })
    expect(t).toEqual({ ok: true })
    expect(fake.streamIds, 'duas capturas da mesma aba ao mesmo tempo').toBe(1)
    // O toggle veio depois na fila: entrou na captura de volume.
    expect(fake.offscreen.find((m) => m.t === 'offscreen:tab-start')!.streamId).toBeUndefined()
    expect(fake.created).toHaveLength(1)
  })

  it('toggle e volume ao mesmo tempo: o modo aba abre a captura e o volume só ajusta o ganho', async () => {
    const mod = await load()
    const volume = await import('./tabvolume')
    fake.stateful = true
    const [t, v] = await Promise.all([mod.toggleTabCapture(TAB), volume.setTabVolume(TAB, 0.5)])
    expect(t).toEqual({ ok: true })
    expect(v).toMatchObject({ ok: true, mode: 'gravando' })
    expect(fake.streamIds).toBe(1)
    expect(fake.offscreen.find((m) => m.t === 'offscreen:tab-start')!.streamId).toBe('stream-1')
    expect(fake.offscreen.some((m) => m.t === 'offscreen:tab-volume-start'), 'segunda captura').toBe(false)
    expect(fake.offscreen.at(-1)).toEqual({ target: 'offscreen', t: 'offscreen:tab-volume', tabId: TAB, volume: 0.5 })
  })
})
