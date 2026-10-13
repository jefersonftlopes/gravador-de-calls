// Sessões no SW com o IndexedDB, o helper, o downloads e o chrome.* trocados por falsos em memória:
// o que os testes ponta a ponta não alcançam ou alcançam devagar.
// - a sessão do modo aba pareada é acordada quando a página termina, salva, descartada ou com
//   falha ao salvar (antes, só a salva acordava, e o modo aba ficava "finalizando" para sempre);
// - a saída automática do vigia vai para o info.json e pode ser desfeita;
// - "chegando áudio agora" no popup (AC11) a partir do último diagnóstico;
// - recuperação (AC10): outro boot do navegador, aba que sumiu, 30 s sem session:resume, alarme,
//   runtime.onStartup e a sessão que ficou "interrompida" sem finalizar;
// - staging do helper (Emenda 1): só o do próprio dono, órfão parado vira "Gravação recuperada";
// - lacunas, duração mínima (AC15), autoDiscardable e o helper que some e volta.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CaptureDiag, InfoJson, SessionKind } from '../shared/protocol'
import { useLocale } from '../../tests/helpers/i18n-setup'
import type { ChunkRecord, SessionRecord } from './idb'

const fake = vi.hoisted(() => ({
  sessions: new Map<string, unknown>(),
  chunks: new Map<string, unknown>(),
  /** Todos os status gravados por sessão, em ordem. */
  statusLog: new Map<string, string[]>(),
  /** Tipos de sessão cujo salvamento falha (o helper não existe aqui; tudo vai para downloads). */
  failSave: new Set<string>(),
  saved: [] as Array<{ kind: string; sessionId: string; relDir: string; info: unknown; extras?: Array<{ nome: string; texto: string }> }>,
  /** Helper falso: começa desligado (os casos antigos salvam por downloads). */
  helper: {
    up: false,
    failAppends: false,
    next: new Map<string, number>(),
    appended: [] as Array<[string, number]>,
    finalized: [] as Array<{ sessionId: string; relDir: string; info: Record<string, unknown>; extras?: Array<{ nome: string; texto: string }> }>,
    discarded: [] as string[],
    staging: [] as unknown[],
    /** Para cada begin: o registro da sessão já estava no IndexedDB naquela hora? */
    beginSawRecord: [] as Array<[string, boolean]>,
    /** Sessões que o helper já finalizou (a lápide do índice): sessionId -> pasta. */
    done: new Map<string, string>(),
    writable: true,
    /** Emenda 20: a condição que o sessions.ts registrou para segurar o Port ocioso do helper. */
    keep: null as null | (() => boolean),
  },
  /** chrome.storage.session: limpar simula o Chrome fechando ou caindo. */
  sessionArea: new Map<string, unknown>(),
  /** Abas que existem (chrome.tabs.get). */
  tabs: new Set<number>(),
  tabUpdates: [] as Array<[number, Record<string, unknown>]>,
  alarms: new Map<string, unknown>(),
  /** Ouvintes registrados em chrome.alarms.onAlarm e chrome.runtime.onStartup. */
  onAlarm: [] as Array<(a: { name: string }) => void>,
  onStartup: [] as Array<() => void>,
  /** Cada setBadge do SW, em ordem. */
  badges: [] as Array<[number, string]>,
  /** Falhas injetadas no IndexedDB: quantas gravações de chunk (e de sessão) ainda falham. */
  failChunkWrites: 0,
  failSessionWrites: 0,
  /** Sessões apagadas do IndexedDB (deleteSession). */
  deletedSessions: [] as string[],
  /** Avisos de "não foi possível salvar" (quantas pendentes em cada um). */
  saveFailedNotices: [] as number[],
  /** chrome.storage.local.consent: o aviso da primeira execução (Emenda 15). Confirmado por padrão. */
  consent: { version: 1, at: 0, via: 'pagina' } as unknown,
  /** chrome.storage.local.settings (o motor por API da Emenda 21 entra por aqui). */
  settings: { minSeconds: 30 } as Record<string, unknown>,
  /** Emenda 21: cada queueApiTranscription, com quantos chunks ainda havia no IndexedDB. */
  apiQueued: [] as Array<{ sessionId: string; savedPath: string; sink: string; audio: string; chunks: number; falantes: boolean }>,
}))

vi.mock('./idb', () => {
  const clone = <T>(v: T): T => structuredClone(v)
  const ofSession = (id: string) => [...fake.chunks.entries()].filter(([k]) => k.startsWith(`${id}|`))
  const logStatus = (rec: SessionRecord) => {
    const l = fake.statusLog.get(rec.sessionId) ?? []
    if (l.at(-1) !== rec.status) l.push(rec.status)
    fake.statusLog.set(rec.sessionId, l)
  }
  return {
    putSession: async (rec: SessionRecord) => {
      if (fake.failSessionWrites > 0) {
        fake.failSessionWrites--
        throw new DOMException('falha de escrita (teste)', 'UnknownError')
      }
      logStatus(rec)
      fake.sessions.set(rec.sessionId, clone(rec))
    },
    getSession: async (id: string) => {
      const r = fake.sessions.get(id)
      return r === undefined ? undefined : clone(r)
    },
    listSessions: async (status?: string) =>
      [...fake.sessions.values()].filter((r) => !status || (r as SessionRecord).status === status).map(clone),
    deleteSession: async (id: string) => {
      fake.deletedSessions.push(id)
      fake.sessions.delete(id)
    },
    putChunkAndSession: async (chunk: ChunkRecord, rec: SessionRecord) => {
      if (fake.failChunkWrites > 0) {
        fake.failChunkWrites--
        throw new DOMException('QuotaExceededError (teste)', 'QuotaExceededError')
      }
      logStatus(rec)
      fake.chunks.set(`${chunk.sessionId}|${chunk.seq}`, chunk)
      fake.sessions.set(rec.sessionId, clone(rec))
    },
    getChunks: async (id: string) => ofSession(id).map(([, v]) => v as ChunkRecord).sort((a, b) => a.seq - b.seq),
    deleteChunks: async (id: string) => {
      for (const [k] of ofSession(id)) fake.chunks.delete(k)
    },
  }
})

vi.mock('./sink-host', () => {
  const h = fake.helper
  const off = { ok: false, version: null, root: null, writable: false, error: 'sem helper' }
  const no = { id: 0, ok: false, error: 'sem helper' }
  const status = () => (h.up ? { ok: true, version: '0.1.0', root: '/raiz', writable: h.writable, error: null } : off)
  return {
    host: {
      begin: async (sessionId: string) => {
        h.beginSawRecord.push([sessionId, fake.sessions.has(sessionId)])
        if (!h.up) return no
        if (h.done.has(sessionId)) return { id: 0, ok: true, done: true, path: h.done.get(sessionId), root: '/raiz' }
        if (!h.next.has(sessionId)) h.next.set(sessionId, 0)
        return { id: 0, ok: true, root: '/raiz' }
      },
      append: async (sessionId: string, _file: string, seq: number) => {
        if (!h.up || h.failAppends) return no
        const expected = h.next.get(sessionId)
        if (expected === undefined) return { id: 0, ok: false, error: 'sessão sem begin' }
        if (seq !== expected) return { id: 0, ok: false, error: 'fora de ordem', expected }
        h.next.set(sessionId, seq + 1)
        h.appended.push([sessionId, seq])
        return { id: 0, ok: true, nextSeq: seq + 1 }
      },
      finalize: async (sessionId: string, relDir: string, info: Record<string, unknown>, _merge?: boolean, extras?: Array<{ nome: string; texto: string }>, semTranscricao?: boolean) => {
        if (!h.up) return no
        if (h.done.has(sessionId)) return { id: 0, ok: true, path: h.done.get(sessionId) }
        h.finalized.push({ sessionId, relDir, info, ...(extras?.length ? { extras } : {}), ...(semTranscricao ? { semTranscricao } : {}) })
        h.next.delete(sessionId)
        h.done.set(sessionId, `/raiz/${relDir}`)
        return { id: 0, ok: true, path: `/raiz/${relDir}` }
      },
      discard: async (sessionId: string) => {
        if (!h.up) return no
        h.discarded.push(sessionId)
        if (h.done.has(sessionId)) return { id: 0, ok: true, done: true, path: h.done.get(sessionId) }
        h.next.delete(sessionId)
        return { id: 0, ok: true }
      },
      listStaging: async () => (h.up ? { id: 0, ok: true, sessions: h.staging } : no),
      reveal: async () => no,
    },
    hostStatus: status,
    pingHost: async () => status(),
    releaseHost: () => {},
    keepHostWhile: (fn: () => boolean) => {
      h.keep = fn
    },
    setHostIdleMs: () => {},
  }
})

vi.mock('./api-transcription', () => ({
  // Emenda 21: a fila do motor por API. Aqui só se registra a chamada e quantos chunks AINDA havia
  // no IndexedDB naquele instante: ela tem de acontecer antes do deleteChunks.
  queueApiTranscription: async (args: { rec: { sessionId: string; file: string }; savedPath: string; sink: string; speakers: unknown }) => {
    const n = [...fake.chunks.keys()].filter((k) => k.startsWith(`${args.rec.sessionId}|`)).length
    fake.apiQueued.push({ sessionId: args.rec.sessionId, savedPath: args.savedPath, sink: args.sink, audio: args.rec.file, chunks: n, falantes: args.speakers !== null })
    return { queued: true }
  },
}))

vi.mock('./sink-downloads', () => ({
  saveViaDownloads: async (rec: SessionRecord, relDir: string, info: unknown, extras?: Array<{ nome: string; texto: string }>) => {
    if (fake.failSave.has(rec.kind)) throw new Error('downloads falhou')
    fake.saved.push({ kind: rec.kind, sessionId: rec.sessionId, relDir, info, ...(extras?.length ? { extras } : {}) })
    return { path: `Gravações de calls/${relDir}`, downloadId: fake.saved.length }
  },
}))

vi.mock('./badge', () => ({
  setBadge: async (tabId: number, state: string) => void fake.badges.push([tabId, state]),
  clearRecordingBadge: async (tabId: number) => void fake.badges.push([tabId, 'nenhum']),
  notifySaveFailed: async (pending: number) => void fake.saveFailedNotices.push(pending),
  setSaveWarning: async () => {},
  notifyNoAudio: async () => {},
}))

interface FakePort {
  name: string
  sender: chrome.runtime.MessageSender
  sent: Array<Record<string, unknown>>
  /** O SW chamou port.disconnect() (o relay reconecta e reenvia o que não teve ack). */
  disconnected: boolean
  emit(msg: unknown): void
  postMessage(msg: Record<string, unknown>): void
  disconnect(): void
  onMessage: { addListener(cb: (m: unknown) => void): void }
  onDisconnect: { addListener(cb: () => void): void }
}

const EXT = 'chrome-extension://gravador/'
let connectListeners: Array<(p: FakePort) => void> = []

function installChrome() {
  connectListeners = []
  ;(globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: {
      onConnect: { addListener: (cb: (p: FakePort) => void) => connectListeners.push(cb) },
      onStartup: { addListener: (cb: () => void) => void fake.onStartup.push(cb) },
      getURL: (p = '') => EXT + p,
      getManifest: () => ({ version: '0.1.0' }),
    },
    storage: {
      local: {
        get: async () => ({ settings: fake.settings, profileId: 'perfil-teste', ...(fake.consent ? { consent: fake.consent } : {}) }),
        set: async () => {},
      },
      session: {
        get: async (key: string) => (fake.sessionArea.has(key) ? { [key]: fake.sessionArea.get(key) } : {}),
        set: async (items: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(items)) fake.sessionArea.set(k, v)
        },
      },
    },
    tabs: {
      update: async (tabId: number, props: Record<string, unknown>) => {
        fake.tabUpdates.push([tabId, props])
        return {}
      },
      get: async (tabId: number) => {
        if (!fake.tabs.has(tabId)) throw new Error(`No tab with id: ${tabId}.`)
        return { id: tabId }
      },
    },
    alarms: {
      onAlarm: { addListener: (cb: (a: { name: string }) => void) => void fake.onAlarm.push(cb) },
      create: async (name: string, info: unknown) => void fake.alarms.set(name, info),
      clear: async (name: string) => fake.alarms.delete(name),
    },
  }
}

function connect(name: string, sender: chrome.runtime.MessageSender): FakePort {
  const onMsg: Array<(m: unknown) => void> = []
  const port: FakePort = {
    name,
    sender,
    sent: [],
    disconnected: false,
    emit: (m) => onMsg.forEach((cb) => cb(m)),
    postMessage(m) {
      port.sent.push(m)
    },
    disconnect() {
      port.disconnected = true
    },
    onMessage: { addListener: (cb) => void onMsg.push(cb) },
    onDisconnect: { addListener() {} },
  }
  for (const cb of connectListeners) cb(port)
  return port
}

const T0 = Date.UTC(2026, 9, 6, 17, 30, 0)
const TAB = 7
const b64 = btoa('webm')

type Sessions = typeof import('./sessions')

async function load(): Promise<Sessions> {
  vi.resetModules()
  fake.onAlarm.length = 0
  fake.onStartup.length = 0
  installChrome()
  const mod = await import('./sessions')
  mod.registerSessionPorts()
  return mod
}

/** Abre uma sessão de página na aba TAB pelo Port do relay e manda um chunk. */
async function pageSession(): Promise<{ port: FakePort; sessionId: string }> {
  const port = connect('gravador:sessao', { tab: { id: TAB } as chrome.tabs.Tab, frameId: 0, url: 'https://meet.google.com/abc-defg-hij' })
  port.emit({ t: 'session:start', localId: 'frame-1', platform: 'meet', startedAt: T0, meta: { title: 'Daily', code: 'abc-defg-hij' } })
  const accepted = await vi.waitFor(() => {
    const m = port.sent.find((x) => x.t === 'session:accepted')
    if (!m) throw new Error('sem session:accepted')
    return m
  })
  const sessionId = String(accepted.sessionId)
  port.emit({ t: 'session:chunk', sessionId, seq: 0, data: b64, bytes: 4, at: T0 + 1000 })
  await vi.waitFor(() => expect(port.sent.some((x) => x.t === 'chunk:ack' && x.sessionId === sessionId)).toBe(true))
  return { port, sessionId }
}

/** Sessão do modo aba pareada com a página, com um chunk, como o offscreen faria. */
async function tabSession(mod: Sessions, pairedSessionId: string): Promise<{ port: FakePort; sessionId: string }> {
  const rec = await mod.createSession({
    tabId: TAB,
    frameId: 0,
    platform: 'meet',
    kind: 'aba',
    localId: 'aba-1',
    startedAt: T0,
    meta: { title: 'Daily', code: 'abc-defg-hij' },
    port: null,
    pairedSessionId,
  })
  const port = connect('gravador:aba', { url: `${EXT}src/offscreen/offscreen.html` })
  port.emit({ t: 'session:chunk', sessionId: rec.sessionId, seq: 0, data: b64, bytes: 4, at: T0 + 1000 })
  await vi.waitFor(() => expect(port.sent.some((x) => x.t === 'chunk:ack')).toBe(true))
  return { port, sessionId: rec.sessionId }
}

const end = (port: FakePort, sessionId: string, seconds: number, reason = 'saiu-da-call') =>
  port.emit({ t: 'session:end', sessionId, endedAt: T0 + seconds * 1000, reason, lastSeq: 0 })

const statusOf = (id: string) => (fake.sessions.get(id) as SessionRecord | undefined)?.status
const savedOf = (kind: SessionKind) => fake.saved.filter((s) => s.kind === kind)

beforeEach(() => {
  fake.consent = { version: 1, at: 0, via: 'pagina' }
  fake.sessions.clear()
  fake.chunks.clear()
  fake.statusLog.clear()
  fake.failSave.clear()
  fake.saved.length = 0
  Object.assign(fake.helper, { up: false, failAppends: false, writable: true })
  fake.helper.next.clear()
  fake.helper.done.clear()
  fake.helper.appended.length = 0
  fake.helper.finalized.length = 0
  fake.helper.discarded.length = 0
  fake.helper.staging = []
  fake.helper.beginSawRecord.length = 0
  fake.sessionArea.clear()
  fake.tabs.clear()
  fake.tabs.add(TAB)
  fake.tabUpdates.length = 0
  fake.alarms.clear()
  fake.badges.length = 0
  fake.failChunkWrites = 0
  fake.failSessionWrites = 0
  fake.deletedSessions.length = 0
  fake.saveFailedNotices.length = 0
  fake.settings = { minSeconds: 30 }
  fake.apiQueued.length = 0
})

afterEach(() => {
  vi.useRealTimers()
})

describe('modo aba pareado com a página', () => {
  it('página salva: o modo aba, que esperava, salva depois dela', async () => {
    const mod = await load()
    const page = await pageSession()
    const tab = await tabSession(mod, page.sessionId)
    end(tab.port, tab.sessionId, 60, 'parado-pelo-usuario')
    await vi.waitFor(() => expect(statusOf(tab.sessionId)).toBe('finalizando'))
    expect(savedOf('aba')).toEqual([])
    end(page.port, page.sessionId, 60)
    await vi.waitFor(() => expect(statusOf(tab.sessionId)).toBe('salva'))
    expect(statusOf(page.sessionId)).toBe('salva')
    expect(fake.saved.map((s) => s.kind)).toEqual(['pagina', 'aba'])
  })

  it('página descartada (curta): o modo aba é acordado e salva na pasta própria', async () => {
    const mod = await load()
    const page = await pageSession()
    const tab = await tabSession(mod, page.sessionId)
    end(tab.port, tab.sessionId, 60, 'parado-pelo-usuario')
    await vi.waitFor(() => expect(statusOf(tab.sessionId)).toBe('finalizando'))
    end(page.port, page.sessionId, 5)
    await vi.waitFor(() => expect(statusOf(page.sessionId)).toBe('descartada'))
    await vi.waitFor(() => expect(statusOf(tab.sessionId)).toBe('salva'))
    expect(savedOf('pagina')).toEqual([])
    expect(savedOf('aba')).toHaveLength(1)
  })

  it('a página falhou ao salvar: o modo aba é acordado e salva sozinho (a página fica para a recuperação)', async () => {
    const mod = await load()
    fake.failSave.add('pagina')
    const page = await pageSession()
    const tab = await tabSession(mod, page.sessionId)
    end(tab.port, tab.sessionId, 60, 'parado-pelo-usuario')
    await vi.waitFor(() => expect(statusOf(tab.sessionId)).toBe('finalizando'))
    end(page.port, page.sessionId, 60)
    await vi.waitFor(() => expect(statusOf(tab.sessionId)).toBe('salva'))
    expect(statusOf(page.sessionId)).toBe('finalizando')
    expect(fake.chunks.has(`${page.sessionId}|0`)).toBe(true)
  })

  it('os dois fins chegam juntos: o modo aba termina salvo de qualquer jeito', async () => {
    const mod = await load()
    const page = await pageSession()
    const tab = await tabSession(mod, page.sessionId)
    end(tab.port, tab.sessionId, 60, 'parado-pelo-usuario')
    end(page.port, page.sessionId, 5)
    await vi.waitFor(() => expect(statusOf(tab.sessionId)).toBe('salva'))
    expect(statusOf(page.sessionId)).toBe('descartada')
  })
})

describe('saída automática do vigia no info.json', () => {
  it('setAutoLeave vira motivoFim saida-automatica e saidaAutomatica; null desfaz', async () => {
    const mod = await load()
    const a = await pageSession()
    await mod.setAutoLeave(TAB, { motivo: 'caiu de 8 para 2', pico: 8, na: 2, em: T0 + 50_000 })
    end(a.port, a.sessionId, 60)
    await vi.waitFor(() => expect(statusOf(a.sessionId)).toBe('salva'))
    const info = fake.saved[0].info as InfoJson
    expect(info.motivoFim).toBe('saida-automatica')
    expect(info.saidaAutomatica).toMatchObject({ motivo: 'caiu de 8 para 2', pico: 8, na: 2 })

    fake.saved.length = 0
    const b = await pageSession()
    await mod.setAutoLeave(TAB, { motivo: 'sozinho', pico: 3, na: 1, em: T0 + 50_000 })
    await mod.setAutoLeave(TAB, null)
    end(b.port, b.sessionId, 60)
    await vi.waitFor(() => expect(statusOf(b.sessionId)).toBe('salva'))
    const info2 = fake.saved[0].info as InfoJson
    expect(info2.motivoFim).toBe('saiu-da-call')
    expect(info2.saidaAutomatica).toBeUndefined()
  })
})

describe('espera para fechar a aba (AC18)', () => {
  it('sem sessão na aba resolve na hora; salva resolve true', async () => {
    const mod = await load()
    expect(await mod.waitTabSessionSaved(TAB, 50)).toBe(true)
    const page = await pageSession()
    end(page.port, page.sessionId, 60)
    expect(await mod.waitTabSessionSaved(TAB, 5_000)).toBe(true)
    expect(statusOf(page.sessionId)).toBe('salva')
  })

  it('salvar travado: desiste no limite e devolve false (o vigia fecha a aba pelo limite de 20 s)', async () => {
    const mod = await load()
    const page = await pageSession()
    // Ainda gravando: espera o limite e devolve false.
    let t0 = Date.now()
    expect(await mod.waitTabSessionSaved(TAB, 300)).toBe(false)
    expect(Date.now() - t0).toBeGreaterThanOrEqual(300)
    // A finalização trava em "finalizando" (helper lento): também para no limite.
    mod.testing.delayFinalize(60_000)
    try {
      end(page.port, page.sessionId, 60)
      await vi.waitFor(() => expect(statusOf(page.sessionId)).toBe('finalizando'))
      t0 = Date.now()
      expect(await mod.waitTabSessionSaved(TAB, 300)).toBe(false)
      const waited = Date.now() - t0
      expect(waited).toBeGreaterThanOrEqual(300)
      expect(waited).toBeLessThan(2_000)
    } finally {
      mod.testing.delayFinalize(0)
    }
  })
})

describe('espera para fechar a aba com a gravação que não salvou (Emenda 10)', () => {
  it('a tentativa falhou: devolve false assim que ela termina, esperando desde antes ou começando depois', async () => {
    const mod = await load()
    fake.failSave.add('pagina')
    const page = await pageSession()
    const t0 = Date.now()
    const waiting = mod.waitTabSessionSaved(TAB, 5_000)
    end(page.port, page.sessionId, 60)
    expect(await waiting).toBe(false)
    expect(Date.now() - t0, 'esperou o limite inteiro por uma falha que já tinha acontecido').toBeLessThan(3_000)
    expect(statusOf(page.sessionId)).toBe('finalizando')
    // Começando depois da falha: não diz que salvou.
    expect(await mod.waitTabSessionSaved(TAB, 5_000)).toBe(false)
  }, 15_000)
})

describe('chegando áudio agora (AC11)', () => {
  const diag = (at: number, silentForMs: number | null): CaptureDiag => {
    const seam = { sources: 1, dbfs: -20, speech: silentForMs !== null && silentForMs <= 1000 }
    return {
      at,
      ctxState: 'running',
      initial: 'receivers',
      selected: 'receivers',
      switches: [],
      seams: { receivers: seam, elements: seam, sources: seam, output: seam },
      pcs: { open: 1, connected: 1 },
      remoteAudioTracks: 1,
      primed: 0,
      chunks: 1,
      bytes: 4,
      everHadSpeech: silentForMs !== null,
      silentForMs,
      recorderState: 'recording',
      holds: [],
    }
  }

  it('liveAudio soma a idade do diagnóstico ao silêncio informado', async () => {
    const { liveAudio, AUDIO_NOW_MS } = await load()
    expect(liveAudio(null, 0)).toEqual({ audioNow: false, silentForMs: null })
    expect(liveAudio(diag(1000, null), 2000)).toEqual({ audioNow: false, silentForMs: null })
    expect(liveAudio(diag(1000, 200), 4000)).toEqual({ audioNow: true, silentForMs: 3200 })
    expect(liveAudio(diag(1000, 200), 1000 + AUDIO_NOW_MS)).toEqual({ audioNow: false, silentForMs: AUDIO_NOW_MS + 200 })
    // Relógio da página um pouco à frente: a idade não fica negativa.
    expect(liveAudio(diag(5000, 300), 4000)).toEqual({ audioNow: true, silentForMs: 300 })
  })

  it('activeRecordings traz audioNow e silentForMs do último session:diag', async () => {
    const mod = await load()
    const a = await pageSession()
    expect(mod.activeRecordings()[0]).toMatchObject({ audioNow: false, silentForMs: null })
    a.port.emit({ t: 'session:diag', sessionId: a.sessionId, diag: diag(Date.now(), 100) })
    await vi.waitFor(() => expect(mod.activeRecordings()[0]).toMatchObject({ audioNow: true }))
    expect(mod.activeRecordings()[0].silentForMs).toBeGreaterThanOrEqual(100)
  })
})

const chunk = (port: FakePort, sessionId: string, seq: number, atSec: number) =>
  port.emit({ t: 'session:chunk', sessionId, seq, data: b64, bytes: 4, at: T0 + atSec * 1000 })
const acked = (port: FakePort, sessionId: string, seq: number) =>
  vi.waitFor(() => expect(port.sent.some((x) => x.t === 'chunk:ack' && x.sessionId === sessionId && x.seq === seq)).toBe(true))
const recOf = (id: string) => fake.sessions.get(id) as SessionRecord
const infoOf = (sessionId: string) => (fake.saved.find((s) => s.sessionId === sessionId)?.info ?? null) as InfoJson | null

/** Página gravando há 40 s (dois chunks), pronta para o SW "cair". */
async function longSession(): Promise<{ port: FakePort; sessionId: string }> {
  const page = await pageSession()
  chunk(page.port, page.sessionId, 1, 40)
  await acked(page.port, page.sessionId, 1)
  return page
}

describe('recuperação (AC10)', () => {
  it('sessão de outro boot do navegador vira interrompida e é salva na hora, com o que havia', async () => {
    await load()
    const page = await longSession()
    // O Chrome caiu e abriu de novo: storage.session vazio, SW novo, o tabId velho pode até existir.
    fake.sessionArea.clear()
    const mod = await load()
    await mod.recoverSessions()
    await vi.waitFor(() => expect(statusOf(page.sessionId)).toBe('salva'))
    expect(fake.statusLog.get(page.sessionId)).toEqual(['gravando', 'interrompida', 'finalizando', 'salva'])
    const info = infoOf(page.sessionId)!
    expect(info).toMatchObject({ status: 'interrompida', motivoFim: 'interrompida', lacunas: [], duracaoSegundos: 40 })
    expect(fake.chunks.size).toBe(0)
  })

  it('mesmo boot e a aba sumiu: interrompida na hora', async () => {
    await load()
    const page = await longSession()
    fake.tabs.delete(TAB)
    const mod = await load()
    await mod.recoverSessions()
    await vi.waitFor(() => expect(statusOf(page.sessionId)).toBe('salva'))
    expect(infoOf(page.sessionId)).toMatchObject({ status: 'interrompida' })
  })

  it('mesmo boot e aba viva: espera 30 s por session:resume e só então vira interrompida', async () => {
    await load()
    const page = await longSession()
    const mod = await load()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await mod.recoverSessions()
    await vi.advanceTimersByTimeAsync(29_000)
    expect(statusOf(page.sessionId)).toBe('gravando')
    // Uma segunda passada (o alarme) não reinicia a espera.
    await mod.recoverSessions()
    await vi.advanceTimersByTimeAsync(2_000)
    vi.useRealTimers()
    await vi.waitFor(() => expect(statusOf(page.sessionId)).toBe('salva'))
    expect(infoOf(page.sessionId)).toMatchObject({ status: 'interrompida', motivoFim: 'interrompida' })
  })

  it('mesmo boot e o relay volta com session:resume: a gravação continua na mesma sessão', async () => {
    await load()
    const page = await longSession()
    const mod = await load()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await mod.recoverSessions()
    await vi.advanceTimersByTimeAsync(5_000)
    const port = connect('gravador:sessao', { tab: { id: TAB } as chrome.tabs.Tab, frameId: 0, url: 'https://meet.google.com/abc-defg-hij' })
    port.emit({ t: 'session:resume', localId: 'frame-1', sessionId: page.sessionId, nextSeq: 2 })
    await vi.advanceTimersByTimeAsync(40_000)
    expect(statusOf(page.sessionId)).toBe('gravando')
    vi.useRealTimers()
    chunk(port, page.sessionId, 2, 45)
    await acked(port, page.sessionId, 2)
    end(port, page.sessionId, 46)
    await vi.waitFor(() => expect(statusOf(page.sessionId)).toBe('salva'))
    expect(infoOf(page.sessionId)).toMatchObject({ status: 'concluida', motivoFim: 'saiu-da-call', lacunas: [] })
  })

  it('o RECOVER_ALARM existe enquanto há sessão aberta e sai depois de salvar', async () => {
    await load()
    const page = await longSession()
    expect(fake.alarms.get('gravador:recuperar')).toEqual({ periodInMinutes: 1 })
    end(page.port, page.sessionId, 41)
    await vi.waitFor(() => expect(statusOf(page.sessionId)).toBe('salva'))
    await vi.waitFor(() => expect(fake.alarms.has('gravador:recuperar')).toBe(false))
  })

  it('falhou ao salvar: fica "finalizando" com os chunks e a próxima passada salva', async () => {
    const mod = await load()
    fake.failSave.add('pagina')
    const page = await longSession()
    end(page.port, page.sessionId, 41)
    await vi.waitFor(() => expect(recOf(page.sessionId)?.lastError).toBe('downloads falhou'))
    expect(statusOf(page.sessionId)).toBe('finalizando')
    expect(fake.alarms.has('gravador:recuperar')).toBe(true)
    fake.failSave.clear()
    await mod.recoverSessions()
    await vi.waitFor(() => expect(statusOf(page.sessionId)).toBe('salva'))
    expect(infoOf(page.sessionId)).toMatchObject({ status: 'concluida', motivoFim: 'saiu-da-call' })
  })

  it('o SW morreu entre marcar "interrompida" e finalizar: a passada seguinte salva', async () => {
    await load()
    const page = await longSession()
    // Como ficou no IndexedDB: interrompida, com os chunks, sem ninguém cuidando.
    const stored = recOf(page.sessionId)
    fake.sessions.set(page.sessionId, { ...stored, status: 'interrompida' })
    const mod = await load()
    await mod.recoverSessions()
    await vi.waitFor(() => expect(statusOf(page.sessionId)).toBe('salva'))
    expect(infoOf(page.sessionId)).toMatchObject({ status: 'interrompida', motivoFim: 'interrompida', duracaoSegundos: 40 })
    expect(fake.chunks.size).toBe(0)
  })

  it('runtime.onStartup e o RECOVER_ALARM disparam a passada (o Chrome abriu depois de cair)', async () => {
    await load()
    const page = await longSession()
    fake.sessionArea.clear()
    const mod = await load()
    mod.registerSessionAlarms()
    expect(fake.onStartup).toHaveLength(1)
    expect(fake.onAlarm).toHaveLength(1)
    // Outro alarme qualquer não faz nada.
    fake.onAlarm[0]({ name: 'outro' })
    await new Promise((r) => setTimeout(r, 50))
    expect(statusOf(page.sessionId)).toBe('gravando')
    fake.onStartup[0]()
    await vi.waitFor(() => expect(statusOf(page.sessionId)).toBe('salva'))
    expect(infoOf(page.sessionId)).toMatchObject({ status: 'interrompida' })

    // O alarme sozinho também: outra sessão de outro boot.
    fake.saved.length = 0
    await load()
    const other = await longSession()
    fake.sessionArea.clear()
    const mod2 = await load()
    mod2.registerSessionAlarms()
    fake.onAlarm[0]({ name: mod2.RECOVER_ALARM })
    await vi.waitFor(() => expect(statusOf(other.sessionId)).toBe('salva'))
  })
})

describe('staging do helper na recuperação (Emenda 1)', () => {
  it('o registro existe no IndexedDB antes do begin (o staging nunca nasce órfão)', async () => {
    fake.helper.up = true
    await load()
    const page = await pageSession()
    expect(fake.helper.beginSawRecord[0]).toEqual([page.sessionId, true])
  })

  it('só o do próprio dono: órfão parado vira "Gravação recuperada", sobra de sessão salva é apagada', async () => {
    fake.helper.up = true
    await load()
    const saved = await longSession()
    end(saved.port, saved.sessionId, 41)
    await vi.waitFor(() => expect(statusOf(saved.sessionId)).toBe('salva'))
    const old = Date.now() - 11 * 60_000
    const files = [{ file: 'audio.webm', bytes: 1000, nextSeq: 3 }]
    fake.helper.staging = [
      { sessionId: '20261006-143000-9-abcd', owner: 'perfil-teste', files, createdAt: old, updatedAt: old },
      // Um helper que não filtrasse pelo dono: o SW confere de novo e não toca.
      { sessionId: '20261006-143000-3-bbbb', owner: 'perfil-b', files, createdAt: old, updatedAt: old },
      // Órfão ainda recente (pode ser um início em andamento): fica.
      { sessionId: '20261006-143000-4-cccc', owner: 'perfil-teste', files, createdAt: Date.now(), updatedAt: Date.now() },
      // Órfão vazio parado: só apaga.
      { sessionId: '20261006-143000-5-dddd', owner: 'perfil-teste', files: [], createdAt: old, updatedAt: old },
      { sessionId: saved.sessionId, owner: 'perfil-teste', files, createdAt: old, updatedAt: old },
    ]
    fake.helper.finalized.length = 0
    fake.helper.discarded.length = 0
    const mod = await load()
    await mod.recoverSessions()
    expect(fake.helper.finalized.map((f) => [f.sessionId, f.relDir])).toEqual([['20261006-143000-9-abcd', '2026-10/2026-10-06 14h30 - Gravação recuperada']])
    expect(fake.helper.finalized[0].info).toMatchObject({ status: 'interrompida', motivoFim: 'interrompida', semRegistro: true, sessao: '20261006-143000-9-abcd' })
    expect(fake.helper.discarded.sort()).toEqual(['20261006-143000-5-dddd', saved.sessionId].sort())
  })
})

describe('staging que sobrou depois de salvar por downloads (helper some e volta)', () => {
  it('uma mensagem atrasada da sessão já salva não impede a passada de apagar a sobra no helper', async () => {
    const mod = await load()
    const page = await pageSession()
    end(page.port, page.sessionId, 41)
    await vi.waitFor(() => expect(statusOf(page.sessionId)).toBe('salva'))
    expect(fake.saved.map((x) => x.sessionId)).toEqual([page.sessionId])
    // O relay ainda manda um diagnóstico (ou reenvia um chunk) depois de a sessão ser salva: o SW
    // relê o registro do IndexedDB para tratar a mensagem.
    page.port.emit({ t: 'session:chunk', sessionId: page.sessionId, seq: 0, data: b64, bytes: 4, at: T0 + 1000 })
    await vi.waitFor(() => expect(page.port.sent.filter((x) => x.t === 'chunk:ack').length).toBe(2))
    // O helper volta com o staging parcial da sessão: a passada seguinte apaga a sobra.
    fake.helper.up = true
    const old = Date.now() - 60_000
    fake.helper.staging = [{ sessionId: page.sessionId, owner: 'perfil-teste', files: [{ file: 'audio.webm', bytes: 4, nextSeq: 1 }], createdAt: old, updatedAt: old }]
    await mod.recoverSessions()
    expect(fake.helper.discarded).toEqual([page.sessionId])
  })
})

describe('lacunas, duração mínima, autoDiscardable e helper', () => {
  it('chunk que pulou e chunks anunciados que nunca chegaram viram lacunas', async () => {
    await load()
    const page = await pageSession()
    chunk(page.port, page.sessionId, 2, 40)
    await acked(page.port, page.sessionId, 2)
    page.port.emit({ t: 'session:end', sessionId: page.sessionId, endedAt: T0 + 45_000, reason: 'saiu-da-call', lastSeq: 4 })
    await vi.waitFor(() => expect(statusOf(page.sessionId)).toBe('salva'), { timeout: 10_000 })
    expect(infoOf(page.sessionId)!.lacunas).toEqual([
      { fromSeq: 1, toSeq: 1 },
      { fromSeq: 3, toSeq: 4 },
    ])
  }, 15_000)

  it('mais curta que minSeconds: discard no helper, IndexedDB limpo, status descartada, nada salvo', async () => {
    fake.helper.up = true
    await load()
    const page = await pageSession()
    end(page.port, page.sessionId, 29)
    await vi.waitFor(() => expect(statusOf(page.sessionId)).toBe('descartada'))
    expect(fake.helper.discarded).toEqual([page.sessionId])
    expect(fake.helper.finalized).toEqual([])
    expect(fake.saved).toEqual([])
    expect(fake.chunks.size).toBe(0)
  })

  it('autoDiscardable false enquanto grava e true só quando a última gravação da aba termina', async () => {
    const mod = await load()
    const page = await pageSession()
    const tab = await tabSession(mod, page.sessionId)
    expect(fake.tabUpdates).toEqual([
      [TAB, { autoDiscardable: false }],
      [TAB, { autoDiscardable: false }],
    ])
    end(page.port, page.sessionId, 60)
    await vi.waitFor(() => expect(statusOf(page.sessionId)).toBe('salva'))
    expect(fake.tabUpdates.at(-1)).toEqual([TAB, { autoDiscardable: false }])
    end(tab.port, tab.sessionId, 61, 'parado-pelo-usuario')
    await vi.waitFor(() => expect(statusOf(tab.sessionId)).toBe('salva'))
    expect(fake.tabUpdates.at(-1)).toEqual([TAB, { autoDiscardable: true }])
  })

  it('o helper some no meio e volta antes do fim: os chunks que faltam são reenviados, em ordem', async () => {
    fake.helper.up = true
    await load()
    const page = await pageSession()
    await vi.waitFor(() => expect(fake.helper.appended).toEqual([[page.sessionId, 0]]))
    fake.helper.failAppends = true
    for (const seq of [1, 2, 3]) {
      chunk(page.port, page.sessionId, seq, 10 * seq)
      await acked(page.port, page.sessionId, seq)
    }
    fake.helper.failAppends = false
    chunk(page.port, page.sessionId, 4, 40)
    await acked(page.port, page.sessionId, 4)
    end(page.port, page.sessionId, 41)
    await vi.waitFor(() => expect(statusOf(page.sessionId)).toBe('salva'))
    expect(fake.helper.appended.map(([, seq]) => seq)).toEqual([0, 1, 2, 3, 4])
    expect(fake.helper.finalized.map((f) => f.sessionId)).toEqual([page.sessionId])
    expect(fake.saved).toEqual([])
    expect(recOf(page.sessionId).sink).toBe('host')
  })

  it('o helper some no meio e não volta: salva por downloads com todos os chunks do IndexedDB', async () => {
    fake.helper.up = true
    await load()
    const page = await pageSession()
    fake.helper.up = false
    chunk(page.port, page.sessionId, 1, 40)
    await acked(page.port, page.sessionId, 1)
    end(page.port, page.sessionId, 41)
    await vi.waitFor(() => expect(statusOf(page.sessionId)).toBe('salva'))
    expect(fake.saved.map((s) => s.sessionId)).toEqual([page.sessionId])
    expect(infoOf(page.sessionId)).toMatchObject({ helper: null, lacunas: [], status: 'concluida' })
    expect(recOf(page.sessionId).sink).toBe('downloads')
  })
})

describe('modo aba e a sessão de página na mesma aba (Emenda 7)', () => {
  /** Sessão do modo aba sem par (começou antes da call), ligada ao Port do offscreen só pelo resume. */
  async function unpairedTab(mod: Sessions): Promise<{ port: FakePort; sessionId: string }> {
    const rec = await mod.createSession({ tabId: TAB, frameId: 0, platform: 'meet', kind: 'aba', localId: 'aba-1', startedAt: T0, meta: {}, port: null })
    const port = connect('gravador:aba', { url: `${EXT}src/offscreen/offscreen.html` })
    port.emit({ t: 'session:resume', localId: rec.sessionId, sessionId: rec.sessionId, nextSeq: 0 })
    return { port, sessionId: rec.sessionId }
  }

  it('o Port do offscreen se liga à sessão pelo resume, antes do primeiro chunk: parar chega ao offscreen', async () => {
    const mod = await load()
    const tab = await unpairedTab(mod)
    await new Promise((r) => setTimeout(r, 20))
    expect(await mod.stopSession(tab.sessionId)).toBe(true)
    expect(tab.port.sent).toContainEqual({ t: 'session:stop', sessionId: tab.sessionId, reason: 'user' })
    // Não finalizou sozinho (sem Port finalizaria na hora e o offscreen seguiria capturando).
    expect(statusOf(tab.sessionId)).toBe('gravando')
  })

  it('o resume do modo aba não vira a sessão de página da aba: a call que começa depois não o encerra', async () => {
    const mod = await load()
    const tab = await unpairedTab(mod)
    await vi.waitFor(() => expect(mod.activeRecordings().map((r) => r.sessionId)).toContain(tab.sessionId))
    await new Promise((r) => setTimeout(r, 20))
    const page = await pageSession()
    await new Promise((r) => setTimeout(r, 50))
    expect(statusOf(tab.sessionId)).toBe('gravando')
    expect(mod.activeRecordings().map((r) => r.sessionId).sort()).toEqual([page.sessionId, tab.sessionId].sort())
    // E o Port do relay não retoma a sessão do modo aba (cada Port retoma só o seu tipo).
    page.port.emit({ t: 'session:resume', localId: 'frame-1', sessionId: tab.sessionId, nextSeq: 0 })
    await new Promise((r) => setTimeout(r, 20))
    expect(await mod.stopSession(tab.sessionId)).toBe(true)
    expect(page.port.sent.filter((m) => m.t === 'session:stop')).toEqual([])
    expect(tab.port.sent.filter((m) => m.t === 'session:stop')).toHaveLength(1)
  })

  it('o modo aba sem par termina durante a call: o REC continua na aba até a página terminar', async () => {
    const mod = await load()
    const tab = await unpairedTab(mod)
    tab.port.emit({ t: 'session:chunk', sessionId: tab.sessionId, seq: 0, data: b64, bytes: 4, at: T0 + 1000 })
    await vi.waitFor(() => expect(tab.port.sent.some((x) => x.t === 'chunk:ack')).toBe(true))
    const page = await pageSession()
    const mark = fake.badges.length
    end(tab.port, tab.sessionId, 60, 'parado-pelo-usuario')
    await vi.waitFor(() => expect(statusOf(tab.sessionId)).toBe('salva'))
    expect(fake.badges.slice(mark).filter(([t, st]) => t === TAB && st === 'nenhum'), 'o REC sumiu com a página ainda gravando').toEqual([])
    expect(fake.tabUpdates.filter(([t, u]) => t === TAB && u.autoDiscardable === true)).toEqual([])
    end(page.port, page.sessionId, 60)
    await vi.waitFor(() => expect(statusOf(page.sessionId)).toBe('salva'))
    expect(fake.badges.at(-1)).toEqual([TAB, 'nenhum'])
  })
})

describe('IndexedDB que falha (Emenda 10)', () => {
  const acksOf = (port: FakePort, sessionId: string) => port.sent.filter((x) => x.t === 'chunk:ack' && x.sessionId === sessionId).map((x) => x.seq)

  it('uma falha passageira no chunk 0 é tentada de novo: nada se perde e o cabeçalho continua no arquivo', async () => {
    await load()
    const port = connect('gravador:sessao', { tab: { id: TAB } as chrome.tabs.Tab, frameId: 0, url: 'https://meet.google.com/abc-defg-hij' })
    port.emit({ t: 'session:start', localId: 'frame-1', platform: 'meet', startedAt: T0, meta: { title: 'Daily' } })
    const sessionId = String((await vi.waitFor(() => port.sent.find((x) => x.t === 'session:accepted') ?? Promise.reject(new Error('sem accepted')))).sessionId)
    fake.failChunkWrites = 1
    for (const seq of [0, 1, 2]) chunk(port, sessionId, seq, 5 * (seq + 1))
    await vi.waitFor(() => expect(acksOf(port, sessionId)).toEqual([0, 1, 2]), { timeout: 5_000 })
    expect([...fake.chunks.keys()].sort()).toEqual([0, 1, 2].map((q) => `${sessionId}|${q}`))
    port.emit({ t: 'session:end', sessionId, endedAt: T0 + 60_000, reason: 'saiu-da-call', lastSeq: 2 })
    await vi.waitFor(() => expect(statusOf(sessionId)).toBe('salva'))
    expect(infoOf(sessionId)).toMatchObject({ lacunas: [], status: 'concluida' })
  })

  it('falha que persiste: sem ack e sem avançar o seq; o SW derruba o Port, o relay reenvia e o arquivo sai inteiro', async () => {
    await load()
    const port = connect('gravador:sessao', { tab: { id: TAB } as chrome.tabs.Tab, frameId: 0, url: 'https://meet.google.com/abc-defg-hij' })
    port.emit({ t: 'session:start', localId: 'frame-1', platform: 'meet', startedAt: T0, meta: { title: 'Daily' } })
    const sessionId = String((await vi.waitFor(() => port.sent.find((x) => x.t === 'session:accepted') ?? Promise.reject(new Error('sem accepted')))).sessionId)
    fake.failChunkWrites = 100
    for (const seq of [0, 1, 2]) chunk(port, sessionId, seq, 5 * (seq + 1))
    await vi.waitFor(() => expect(port.disconnected).toBe(true), { timeout: 10_000 })
    // Nenhum ack: os três continuam no relay. E nada virou lacuna.
    expect(acksOf(port, sessionId)).toEqual([])
    expect(recOf(sessionId)?.nextSeq ?? 0).toBe(0)
    // O IndexedDB volta; o relay reconecta e reenvia em ordem, como faz depois de um Port caído.
    fake.failChunkWrites = 0
    const again = connect('gravador:sessao', { tab: { id: TAB } as chrome.tabs.Tab, frameId: 0, url: 'https://meet.google.com/abc-defg-hij' })
    again.emit({ t: 'session:resume', localId: 'frame-1', sessionId, nextSeq: 0 })
    for (const seq of [0, 1, 2]) chunk(again, sessionId, seq, 5 * (seq + 1))
    await vi.waitFor(() => expect(acksOf(again, sessionId)).toEqual([0, 1, 2]), { timeout: 5_000 })
    again.emit({ t: 'session:end', sessionId, endedAt: T0 + 60_000, reason: 'saiu-da-call', lastSeq: 2 })
    await vi.waitFor(() => expect(statusOf(sessionId)).toBe('salva'))
    expect(infoOf(sessionId)).toMatchObject({ lacunas: [], status: 'concluida' })
    expect(infoOf(sessionId)!.arquivos[0].bytes).toBe(12)
  }, 20_000)

  it('o primeiro registro da sessão não grava: o MAIN world recebe uma resposta (aceita depois de tentar de novo)', async () => {
    await load()
    fake.failSessionWrites = 1
    const port = connect('gravador:sessao', { tab: { id: TAB } as chrome.tabs.Tab, frameId: 0, url: 'https://meet.google.com/abc-defg-hij' })
    port.emit({ t: 'session:start', localId: 'frame-1', platform: 'meet', startedAt: T0, meta: { title: 'Daily' } })
    await vi.waitFor(() => expect(port.sent.some((x) => x.t === 'session:accepted' || x.t === 'session:rejected')).toBe(true), { timeout: 5_000 })
    expect(port.sent.find((x) => x.t === 'session:accepted' || x.t === 'session:rejected')?.t).toBe('session:accepted')
  })

  it('o registro nunca grava: a frame recebe session:rejected em vez de gravar no vazio', async () => {
    await load()
    fake.failSessionWrites = 100
    const port = connect('gravador:sessao', { tab: { id: TAB } as chrome.tabs.Tab, frameId: 0, url: 'https://meet.google.com/abc-defg-hij' })
    port.emit({ t: 'session:start', localId: 'frame-1', platform: 'meet', startedAt: T0, meta: { title: 'Daily' } })
    await vi.waitFor(() => expect(port.sent.some((x) => x.t === 'session:rejected')).toBe(true), { timeout: 8_000 })
  }, 10_000)
})

describe('streaming para o helper volta a funcionar no meio da call (Emenda 10)', () => {
  const appendedOf = (sessionId: string) => fake.helper.appended.filter(([id]) => id === sessionId).map(([, seq]) => seq)

  it('depois de o SW reiniciar, os chunks seguintes voltam a ir para o helper durante a call', async () => {
    fake.helper.up = true
    await load()
    const page = await pageSession()
    for (const seq of [1, 2]) {
      chunk(page.port, page.sessionId, seq, 5 * seq)
      await acked(page.port, page.sessionId, seq)
    }
    await vi.waitFor(() => expect(appendedOf(page.sessionId)).toEqual([0, 1, 2]))
    // O SW reinicia (crash, DevTools, Port nativo que caiu): o relay volta com resume.
    await load()
    const port = connect('gravador:sessao', { tab: { id: TAB } as chrome.tabs.Tab, frameId: 0, url: 'https://meet.google.com/abc-defg-hij' })
    port.emit({ t: 'session:resume', localId: 'frame-1', sessionId: page.sessionId, nextSeq: 3 })
    for (let seq = 3; seq < 30; seq++) {
      chunk(port, page.sessionId, seq, 5 * seq)
      await acked(port, page.sessionId, seq)
    }
    await vi.waitFor(() => expect(appendedOf(page.sessionId).length).toBe(30))
    expect(appendedOf(page.sessionId)).toEqual([...Array(30).keys()])
  })

  it('um append que falhou no meio (helper ocupado) não deixa o resto da call para o fim', async () => {
    fake.helper.up = true
    await load()
    const page = await pageSession()
    await vi.waitFor(() => expect(appendedOf(page.sessionId)).toEqual([0]))
    fake.helper.failAppends = true
    chunk(page.port, page.sessionId, 1, 5)
    await acked(page.port, page.sessionId, 1)
    await new Promise((r) => setTimeout(r, 20))
    fake.helper.failAppends = false
    for (let seq = 2; seq < 20; seq++) {
      chunk(page.port, page.sessionId, seq, 5 * seq)
      await acked(page.port, page.sessionId, seq)
    }
    await vi.waitFor(() => expect(appendedOf(page.sessionId)).toEqual([...Array(20).keys()]))
    page.port.emit({ t: 'session:end', sessionId: page.sessionId, endedAt: T0 + 120_000, reason: 'saiu-da-call', lastSeq: 19 })
    await vi.waitFor(() => expect(statusOf(page.sessionId)).toBe('salva'))
    expect(appendedOf(page.sessionId)).toEqual([...Array(20).keys()])
    expect(fake.helper.finalized.map((f) => f.sessionId)).toEqual([page.sessionId])
  })

  it('a sessão que começou em downloads (ping que falhou há pouco) passa para o helper quando ele responde', async () => {
    fake.helper.up = false
    await load()
    const page = await pageSession()
    expect(recOf(page.sessionId).sink).toBe('downloads')
    fake.helper.up = true
    for (let seq = 1; seq < 5; seq++) {
      chunk(page.port, page.sessionId, seq, 5 * seq)
      await acked(page.port, page.sessionId, seq)
    }
    await vi.waitFor(() => expect(appendedOf(page.sessionId)).toEqual([0, 1, 2, 3, 4]))
    page.port.emit({ t: 'session:end', sessionId: page.sessionId, endedAt: T0 + 60_000, reason: 'saiu-da-call', lastSeq: 4 })
    await vi.waitFor(() => expect(statusOf(page.sessionId)).toBe('salva'))
    expect(recOf(page.sessionId).sink).toBe('host')
    expect(fake.saved).toEqual([])
  })
})

describe('salvar de novo depois de o helper já ter salvo (Emenda 10)', () => {
  it('o SW morreu entre o finalize do helper e o "salva": a recuperação usa a mesma pasta, sem segunda cópia', async () => {
    fake.helper.up = true
    await load()
    const page = await longSession()
    end(page.port, page.sessionId, 41)
    await vi.waitFor(() => expect(statusOf(page.sessionId)).toBe('salva'))
    const first = recOf(page.sessionId).savedPath
    expect(fake.helper.finalized).toHaveLength(1)
    // Como ficou no IndexedDB quando o Chrome fechou logo depois do finalize: "finalizando", com os chunks.
    fake.sessions.set(page.sessionId, { ...recOf(page.sessionId), status: 'finalizando', savedPath: null, hostFlushedSeq: 0 })
    for (const seq of [0, 1]) fake.chunks.set(`${page.sessionId}|${seq}`, { sessionId: page.sessionId, seq, data: new Blob(['webm']), at: T0 })
    const appendsBefore = fake.helper.appended.length
    const mod = await load()
    await mod.recoverSessions()
    await vi.waitFor(() => expect(statusOf(page.sessionId)).toBe('salva'))
    expect(fake.helper.finalized).toHaveLength(1)
    expect(recOf(page.sessionId).savedPath).toBe(first)
    expect(fake.helper.appended.length).toBe(appendsBefore)
    expect(fake.chunks.size).toBe(0)
  })
})

describe('destino no início (Emenda 10)', () => {
  it('helper que responde mas não consegue gravar na raiz: a sessão começa em downloads', async () => {
    fake.helper.up = true
    fake.helper.writable = false
    await load()
    const page = await pageSession()
    expect(recOf(page.sessionId).sink).toBe('downloads')
  })
})

describe('falha ao salvar aparece (Emenda 10)', () => {
  it('helper e downloads falham: a sessão aparece como pendente com o erro, avisa uma vez, e some quando salva', async () => {
    const mod = await load()
    fake.failSave.add('pagina')
    const page = await longSession()
    end(page.port, page.sessionId, 41)
    await vi.waitFor(() => expect(recOf(page.sessionId)?.lastError).toBe('downloads falhou'))
    expect(mod.pendingSaves()).toEqual([
      expect.objectContaining({ sessionId: page.sessionId, title: 'Daily', platform: 'meet', error: 'downloads falhou' }),
    ])
    expect(fake.saveFailedNotices).toEqual([1])
    // A próxima tentativa (o alarme, ou "Tentar agora" no popup) também falha: não avisa de novo.
    await mod.recoverSessions()
    await new Promise((r) => setTimeout(r, 50))
    expect(fake.saveFailedNotices).toEqual([1])
    fake.failSave.clear()
    await mod.recoverSessions()
    await vi.waitFor(() => expect(statusOf(page.sessionId)).toBe('salva'))
    expect(mod.pendingSaves()).toEqual([])
  })
})

describe('registros com dados da call não ficam para sempre (Emenda 10)', () => {
  it('descartada (mais curta que o mínimo): o registro perde título, URL, participantes e diagnóstico na hora', async () => {
    await load()
    const page = await pageSession()
    end(page.port, page.sessionId, 5)
    await vi.waitFor(() => expect(statusOf(page.sessionId)).toBe('descartada'))
    const rec = recOf(page.sessionId)
    expect(rec.meta).toEqual({})
    expect(rec.diag).toBeNull()
  })

  it('salvas e descartadas com mais de 7 dias saem do IndexedDB na recuperação; as recentes e as abertas ficam', async () => {
    await load()
    const old = await longSession()
    end(old.port, old.sessionId, 41)
    await vi.waitFor(() => expect(statusOf(old.sessionId)).toBe('salva'))
    const recent = await longSession()
    end(recent.port, recent.sessionId, 41)
    await vi.waitFor(() => expect(statusOf(recent.sessionId)).toBe('salva'))
    const eightDays = 8 * 24 * 3600_000
    fake.sessions.set(old.sessionId, { ...recOf(old.sessionId), endedAt: Date.now() - eightDays, startedAt: Date.now() - eightDays - 60_000 })
    const open = await longSession()
    const mod = await load()
    await mod.recoverSessions()
    expect(fake.deletedSessions).toEqual([old.sessionId])
    expect(fake.sessions.has(recent.sessionId)).toBe(true)
    expect(fake.sessions.has(open.sessionId)).toBe(true)
  })
})

describe('aviso da primeira execução (Emenda 15)', () => {
  const start = (port: FakePort) => port.emit({ t: 'session:start', localId: 'frame-1', platform: 'meet', startedAt: T0, meta: { title: 'Daily' } })
  const answer = (port: FakePort) => port.sent.find((x) => x.t === 'session:accepted' || x.t === 'session:rejected')

  it('sem o aviso confirmado: o hello diz que nada grava sozinho e um session:start é recusado', async () => {
    fake.consent = undefined
    await load()
    const port = connect('gravador:sessao', { tab: { id: TAB } as chrome.tabs.Tab, frameId: 0, url: 'https://meet.google.com/abc-defg-hij' })
    port.emit({ t: 'hello', frameUrl: 'https://meet.google.com/abc-defg-hij', isTop: true, platform: 'meet', hookVersion: '0.1.0', hookedAt: 0 })
    await vi.waitFor(() => expect(port.sent.find((x) => x.t === 'settings')).toEqual({ t: 'settings', autoMeet: false, autoTeams: false }))
    start(port)
    await vi.waitFor(() => expect(answer(port)).toBeTruthy())
    expect(answer(port)).toMatchObject({ t: 'session:rejected', reason: 'no-consent' })
    expect(fake.sessions.size).toBe(0)
  })

  it('confirmado: o hello libera as duas plataformas e a sessão abre', async () => {
    await load()
    const port = connect('gravador:sessao', { tab: { id: TAB } as chrome.tabs.Tab, frameId: 0, url: 'https://meet.google.com/abc-defg-hij' })
    port.emit({ t: 'hello', frameUrl: 'https://meet.google.com/abc-defg-hij', isTop: true, platform: 'meet', hookVersion: '0.1.0', hookedAt: 0 })
    await vi.waitFor(() => expect(port.sent.find((x) => x.t === 'settings')).toEqual({ t: 'settings', autoMeet: true, autoTeams: true }))
    start(port)
    await vi.waitFor(() => expect(answer(port)).toBeTruthy())
    expect(answer(port)?.t).toBe('session:accepted')
  })
})

describe('últimas gravações (Emenda 19)', () => {
  it('a gravação sem título nem código entra nas últimas sem título: o popup diz "Sem título" no idioma de quando mostra', async () => {
    await load()
    const recent: unknown[] = []
    const local = (globalThis as unknown as { chrome: { storage: { local: { set: (o: Record<string, unknown>) => Promise<void> } } } }).chrome.storage.local
    local.set = async (o) => void (o.recent && recent.push(o.recent))
    const port = connect('gravador:sessao', { tab: { id: TAB } as chrome.tabs.Tab, frameId: 0, url: 'https://teams.microsoft.com/v2/' })
    port.emit({ t: 'session:start', localId: 'frame-1', platform: 'teams', startedAt: T0, meta: {} })
    const accepted = await vi.waitFor(() => {
      const m = port.sent.find((x) => x.t === 'session:accepted')
      if (!m) throw new Error('sem session:accepted')
      return m
    })
    const sessionId = String(accepted.sessionId)
    port.emit({ t: 'session:chunk', sessionId, seq: 0, data: b64, bytes: 4, at: T0 + 1000 })
    await vi.waitFor(() => expect(port.sent.some((x) => x.t === 'chunk:ack')).toBe(true))
    end(port, sessionId, 40)
    await vi.waitFor(() => expect(statusOf(sessionId)).toBe('salva'))
    expect(recent.at(-1)).toEqual([expect.objectContaining({ sessionId, title: '' })])
    // O info.json e a pasta continuam com o "Sem título" do idioma da gravação.
    expect((savedOf('pagina')[0].info as InfoJson).titulo).toBe('Sem título')
  })

  it('com título, as últimas levam o título saneado, como antes', async () => {
    await load()
    const recent: unknown[] = []
    const local = (globalThis as unknown as { chrome: { storage: { local: { set: (o: Record<string, unknown>) => Promise<void> } } } }).chrome.storage.local
    local.set = async (o) => void (o.recent && recent.push(o.recent))
    const { port, sessionId } = await pageSession()
    end(port, sessionId, 40)
    await vi.waitFor(() => expect(statusOf(sessionId)).toBe('salva'))
    expect(recent.at(-1)).toEqual([expect.objectContaining({ sessionId, title: 'Daily' })])
  })
})

describe('o Port ocioso do helper (Emenda 20)', () => {
  it('a condição registrada segura o Port só enquanto há gravação', async () => {
    fake.helper.up = true
    await load()
    expect(fake.helper.keep?.()).toBe(false)
    const { port, sessionId } = await pageSession()
    expect(fake.helper.keep?.()).toBe(true)
    end(port, sessionId, 40)
    await vi.waitFor(() => expect(statusOf(sessionId)).toBe('salva'))
    expect(fake.helper.keep?.()).toBe(false)
  })
})

describe('o próprio nome e os diagnósticos no info.json (Emenda 20)', () => {
  it('o nome que chegou depois sai dos participantes juntados, e o info.json leva voceSinais e tituloSinais', async () => {
    fake.helper.up = true
    await load()
    const { port, sessionId } = await pageSession()
    // Primeira leitura: a roster ainda não disse quem é o usuário, e o bloco dele entrou.
    port.emit({ t: 'session:meta', sessionId, meta: { participants: ['Alex Lima', 'Ana Souza'], selfSignals: { roster: false, spaces: 0, domMarker: false } } })
    port.emit({
      t: 'session:meta',
      sessionId,
      meta: {
        participants: ['Ana Souza', 'Bruno Lima'],
        selfName: 'Alex Lima',
        selfSignals: { roster: true, spaces: 2, domMarker: false },
        titleSignals: { element: 'codigo', selector: 'NeC6gb', tabEqualsCode: true },
      },
    })
    await vi.waitFor(() => expect((fake.sessions.get(sessionId) as SessionRecord).meta.selfName).toBe('Alex Lima'))
    end(port, sessionId, 40)
    await vi.waitFor(() => expect(statusOf(sessionId)).toBe('salva'))
    const [f] = fake.helper.finalized.filter((x) => x.sessionId === sessionId)
    expect(f.info).toMatchObject({
      participantes: ['Ana Souza', 'Bruno Lima'],
      voce: 'Alex Lima',
      voceSinais: { roster: true, espacos: 2, marcadorDom: false },
      tituloSinais: { elemento: 'codigo', seletor: 'NeC6gb', abaIgualCodigo: true },
    })
  })

  it('o diagnóstico de CSRC do lote final chega ao falantes.json só com os números: um campo a mais (um nome) sai, e o lote vale', async () => {
    fake.helper.up = true
    await load()
    const { port, sessionId } = await pageSession()
    const fonte = { csrc: 42, leiturasAtiva: 10, receptores: 1, resolvida: false, mesmoPacoteComNomeada: 9, ignorada: 'mais-alto' }
    const iv = { nome: 'Ana Souza', de: 1000, ate: 5000, fonte: 'csrc' }
    port.emit({ t: 'session:speakers', sessionId, from: 0, intervals: [iv], diagnostico: { csrc: { receptores: 3, fontes: [{ ...fonte, nome: 'Ana Souza' }], extra: 'x' }, outro: 1 } })
    await vi.waitFor(() => expect((fake.sessions.get(sessionId) as SessionRecord).speakers?.diagnostico).toBeTruthy())
    expect((fake.sessions.get(sessionId) as SessionRecord).speakers?.intervals).toHaveLength(1)
    end(port, sessionId, 40)
    await vi.waitFor(() => expect(statusOf(sessionId)).toBe('salva'))
    const [f] = fake.helper.finalized.filter((x) => x.sessionId === sessionId)
    const file = JSON.parse(f.extras![0].texto)
    expect(file.diagnostico).toEqual({ csrc: { receptores: 3, fontes: [fonte] } })
    expect(JSON.stringify(file.diagnostico)).not.toContain('Ana')
  })

  it('sem os sinais (Teams, versão anterior), o info.json não ganha o campo', async () => {
    fake.helper.up = true
    await load()
    const { port, sessionId } = await pageSession()
    end(port, sessionId, 40)
    await vi.waitFor(() => expect(statusOf(sessionId)).toBe('salva'))
    const [f] = fake.helper.finalized.filter((x) => x.sessionId === sessionId)
    expect(f.info).not.toHaveProperty('voceSinais')
    expect(f.info).not.toHaveProperty('tituloSinais')
    expect(f.info).toMatchObject({ voce: '' })
  })
})

describe('falantes (Emenda 18)', () => {
  const iv = (nome: string, de: number, ate: number, extra: Record<string, unknown> = {}) => ({ nome, de, ate, fonte: 'dsh', ...extra })
  const KEY = '\u0001csrc:2331'

  async function recordWithSpeakers(helperUp: boolean, afterLoad?: () => Promise<void>) {
    fake.helper.up = helperUp
    await load()
    await afterLoad?.()
    const { port, sessionId } = await pageSession()
    port.emit({ t: 'session:speakers', sessionId, from: 0, intervals: [iv('Ana Souza', 2500, 8000)] })
    // Lote seguinte: a Ana ainda aberta foi reenviada, mais o CSRC sem nome e a sua fala.
    port.emit({
      t: 'session:speakers',
      sessionId,
      from: 0,
      intervals: [iv('Ana Souza', 2500, 8500), iv(KEY, 9000, 14_000, { fonte: 'csrc' }), iv('', 15_000, 19_000, { voce: true, fonte: 'microfone' })],
    })
    // Um lote inválido (termina antes de começar) é descartado pelo zod.
    port.emit({ t: 'session:speakers', sessionId, from: 0, intervals: [iv('X', 5000, 1000)] })
    // O alias chegou depois (a roster).
    port.emit({ t: 'session:speakers', sessionId, from: 3, intervals: [], aliases: { [KEY]: 'Bruno Lima' } })
    await vi.waitFor(() => expect((fake.sessions.get(sessionId) as SessionRecord).speakers?.aliases[KEY]).toBe('Bruno Lima'))
    end(port, sessionId, 40)
    await vi.waitFor(() => expect(statusOf(sessionId)).toBe('salva'))
    return sessionId
  }

  const expectedPeople = [
    { nome: 'Ana Souza', segundos: 6 },
    { nome: 'Bruno Lima', segundos: 5 },
    { nome: 'Você', segundos: 4, voce: true },
  ]

  it('o helper recebe o falantes.json e o info.json leva o resumo', async () => {
    const sessionId = await recordWithSpeakers(true)
    const [f] = fake.helper.finalized.filter((x) => x.sessionId === sessionId)
    expect(f.info.falantes).toEqual({ arquivo: 'falantes.json', pessoas: expectedPeople, fontes: ['dsh', 'csrc', 'microfone'] })
    expect(f.extras?.map((x) => x.nome)).toEqual(['falantes.json'])
    const file = JSON.parse(f.extras![0].texto)
    expect(file).toMatchObject({ versao: 1, audio: 'audio.webm', atrasoMs: 1500, pessoas: expectedPeople, textos: { voceNaoGravada: '(sua fala não é gravada)' } })
    expect(file.intervalos.map((i: { nome: string; de: number; ate: number }) => [i.nome, i.de, i.ate])).toEqual([
      ['Ana Souza', 2500, 8500],
      ['Bruno Lima', 9000, 14_000],
      ['Você', 15_000, 19_000],
    ])
  })

  it('no automático, o info.json sai sem idiomaInterface, como antes da 0.4.1: o helper escreve o cabeçalho em português (Emenda 19)', async () => {
    const sessionId = await recordWithSpeakers(true)
    const [f] = fake.helper.finalized.filter((x) => x.sessionId === sessionId)
    expect(f.info).not.toHaveProperty('idiomaInterface')
  })

  it('no automático num Chrome em inglês, também sem idiomaInterface: o cabeçalho continua em português, como antes (Emenda 19)', async () => {
    useLocale('en')
    try {
      const sessionId = await recordWithSpeakers(true)
      const [f] = fake.helper.finalized.filter((x) => x.sessionId === sessionId)
      expect(f.info).not.toHaveProperty('idiomaInterface')
      // Os rótulos dos falantes seguem o Chrome, como na 0.4.0.
      expect((f.info as unknown as InfoJson).falantes?.pessoas.at(-1)).toEqual({ nome: 'You', segundos: 4, voce: true })
    } finally {
      useLocale('pt_BR')
    }
  })

  it('com Português (Brasil) escolhido: idiomaInterface pt-BR (Emenda 19)', async () => {
    const sessionId = await recordWithSpeakers(true, async () => (await import('../shared/i18n')).setLanguage('pt_BR'))
    const [f] = fake.helper.finalized.filter((x) => x.sessionId === sessionId)
    expect(f.info.idiomaInterface).toBe('pt-BR')
  })

  it('com inglês escolhido num Chrome em português: idiomaInterface en, "You" e o texto da sua fala em inglês (Emenda 19)', async () => {
    let i18n: typeof import('../shared/i18n') | undefined
    // O mesmo módulo que o sessions.ts carregou (o load() começa um registro novo).
    const sessionId = await recordWithSpeakers(true, async () => {
      i18n = await import('../shared/i18n')
      i18n.setLanguage('en')
    })
    const [f] = fake.helper.finalized.filter((x) => x.sessionId === sessionId)
    expect(f.info.idiomaInterface).toBe('en')
    expect((f.info as unknown as InfoJson).falantes?.pessoas.at(-1)).toEqual({ nome: 'You', segundos: 4, voce: true })
    const file = JSON.parse(f.extras![0].texto)
    expect(file.textos).toEqual({ voceNaoGravada: '(your speech is not recorded)' })
    // A pasta em Downloads continua no idioma do Chrome (a reserva não divide as gravações).
    expect(i18n!.downloadsFolderName()).toBe('Gravações de calls')
  })

  it('sem helper, o falantes.json vai pelos downloads junto do info.json', async () => {
    const sessionId = await recordWithSpeakers(false)
    const [s] = fake.saved.filter((x) => x.sessionId === sessionId)
    expect((s.info as InfoJson).falantes?.pessoas).toEqual(expectedPeople)
    expect(s.extras?.map((x) => x.nome)).toEqual(['falantes.json'])
  })

  it('sem falante de participante (só o microfone), nem falantes.json nem resumo', async () => {
    await load()
    const { port, sessionId } = await pageSession()
    port.emit({ t: 'session:speakers', sessionId, from: 0, intervals: [iv('', 0, 30_000, { voce: true, fonte: 'microfone' })] })
    await vi.waitFor(() => expect((fake.sessions.get(sessionId) as SessionRecord).speakers?.intervals).toHaveLength(1))
    end(port, sessionId, 40)
    await vi.waitFor(() => expect(statusOf(sessionId)).toBe('salva'))
    const [s] = fake.saved.filter((x) => x.sessionId === sessionId)
    expect((s.info as InfoJson).falantes).toBeUndefined()
    expect(s.extras).toBeUndefined()
  })

  it('lote que chega depois de salva ou descartada não mexe no registro', async () => {
    const sessionId = await recordWithSpeakers(true)
    const before = structuredClone((fake.sessions.get(sessionId) as SessionRecord).speakers)
    expect(before?.intervals).toHaveLength(3)
    const port = connect('gravador:sessao', { tab: { id: TAB } as chrome.tabs.Tab, frameId: 0, url: 'https://meet.google.com/abc-defg-hij' })
    port.emit({ t: 'session:speakers', sessionId, from: 0, intervals: [iv('Intruso', 0, 1000)], aliases: { [KEY]: 'Outro nome' } })
    await new Promise((r) => setTimeout(r, 50))
    expect((fake.sessions.get(sessionId) as SessionRecord).speakers).toEqual(before)

    await load()
    const { port: p2, sessionId: curta } = await pageSession()
    end(p2, curta, 5)
    await vi.waitFor(() => expect(statusOf(curta)).toBe('descartada'))
    p2.emit({ t: 'session:speakers', sessionId: curta, from: 0, intervals: [iv('Ana Souza', 0, 3000)] })
    await new Promise((r) => setTimeout(r, 50))
    expect((fake.sessions.get(curta) as SessionRecord).speakers).toBeNull()
  })

  it('descartada por ser curta: a linha do tempo (nomes) some do perfil', async () => {
    await load()
    const { port, sessionId } = await pageSession()
    port.emit({ t: 'session:speakers', sessionId, from: 0, intervals: [iv('Ana Souza', 0, 3000)] })
    await vi.waitFor(() => expect((fake.sessions.get(sessionId) as SessionRecord).speakers?.intervals).toHaveLength(1))
    end(port, sessionId, 5)
    await vi.waitFor(() => expect(statusOf(sessionId)).toBe('descartada'))
    expect((fake.sessions.get(sessionId) as SessionRecord).speakers).toBeNull()
  })
})

describe('transcrição por API no finalize (Emenda 21)', () => {
  const API_ON = { minSeconds: 30, apiTranscription: { ativa: true, provedor: 'openai', endpoint: '', modelo: '', idioma: 'auto' } }

  /** Grava uma call de página e a termina. */
  async function recordAndEnd(): Promise<string> {
    const { port, sessionId } = await pageSession()
    end(port, sessionId, 60)
    await vi.waitFor(() => expect(statusOf(sessionId)).toBe('salva'))
    return sessionId
  }

  it('motor desligado (o padrão): o finalize não manda semTranscricao e nada é guardado para a API', async () => {
    fake.helper.up = true
    await load()
    const sessionId = await recordAndEnd()
    expect(fake.apiQueued).toEqual([])
    expect(fake.helper.finalized[0]).not.toHaveProperty('semTranscricao')
    expect(fake.helper.finalized[0].sessionId).toBe(sessionId)
  })

  it('motor ligado: o helper não põe a pasta na fila do motor local, e o áudio é guardado ANTES do deleteChunks', async () => {
    fake.settings = API_ON
    fake.helper.up = true
    await load()
    const sessionId = await recordAndEnd()
    expect(fake.helper.finalized[0]).toMatchObject({ semTranscricao: true })
    expect(fake.apiQueued).toEqual([
      { sessionId, savedPath: expect.stringContaining('/raiz/'), sink: 'host', audio: 'audio.webm', chunks: 1, falantes: false },
    ])
    // E só depois os chunks saem do IndexedDB: a fila da API é a última a ver o áudio.
    expect([...fake.chunks.keys()].filter((k) => k.startsWith(`${sessionId}|`))).toEqual([])
  })

  it('motor ligado sem helper: a gravação vai para Downloads e o áudio é guardado igual', async () => {
    fake.settings = API_ON
    await load()
    const sessionId = await recordAndEnd()
    expect(savedOf('pagina')).toHaveLength(1)
    expect(fake.apiQueued).toEqual([
      { sessionId, savedPath: expect.stringContaining('Gravações de calls/'), sink: 'downloads', audio: 'audio.webm', chunks: 1, falantes: false },
    ])
  })

  it('gravação descartada por ser curta: nada é guardado para a API', async () => {
    fake.settings = API_ON
    fake.helper.up = true
    await load()
    const { port, sessionId } = await pageSession()
    end(port, sessionId, 5)
    await vi.waitFor(() => expect(statusOf(sessionId)).toBe('descartada'))
    expect(fake.apiQueued).toEqual([])
  })
})
