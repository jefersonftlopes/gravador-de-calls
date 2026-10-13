// Transcrição no SW (Emenda 13): o estado que o popup recebe sai do helper (transcription-status),
// por sessão das últimas gravações salvas pelo helper; um helper de antes da 0.2.0 vira um motivo
// que diz o que fazer; a mudança das configurações passa pelo zod antes de ir ao helper.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HelperStatus, HostRes, RecentRecording } from '../shared/protocol'

const calls: Array<{ op: string; arg: unknown }> = []
let statusRes: HostRes = { id: 1, ok: true }
let setRes: HostRes = { id: 1, ok: true }

vi.mock('./sink-host', () => ({
  host: {
    transcriptionStatus: async (paths: string[]) => {
      calls.push({ op: 'transcription-status', arg: paths })
      return statusRes
    },
    setTranscription: async (patch: unknown) => {
      calls.push({ op: 'set-transcription', arg: patch })
      return setRes
    },
    openFile: async (path: string) => {
      calls.push({ op: 'open-file', arg: path })
      return { id: 1, ok: true }
    },
  },
}))

/** chrome.storage.local falso: as configurações deste perfil (o motor por API, Emenda 21). */
const storage = new Map<string, unknown>()
globalThis.chrome = {
  ...(globalThis.chrome ?? {}),
  storage: {
    local: {
      get: async (keys: string | string[]) => {
        const list = typeof keys === 'string' ? [keys] : keys
        const out: Record<string, unknown> = {}
        for (const k of list) if (storage.has(k)) out[k] = storage.get(k)
        return out
      },
      set: async (items: Record<string, unknown>) => {
        for (const [k, v] of Object.entries(items)) storage.set(k, v)
      },
      remove: async (k: string) => void storage.delete(k),
    },
    onChanged: { addListener: () => {}, removeListener: () => {} },
  },
  downloads: { show: () => {} },
} as unknown as typeof chrome

const { clearTranscriptionCache, openTranscript, setTranscription, transcriptionForPopup } = await import('./transcription')

const helperOk: HelperStatus = { ok: true, version: '0.2.0', root: '/raiz', writable: true, error: null }
const rec = (sessionId: string, over: Partial<RecentRecording> = {}): RecentRecording => ({
  sessionId,
  platform: 'meet',
  kind: 'pagina',
  title: sessionId,
  startedAt: 0,
  endedAt: 1,
  durationSeconds: 60,
  path: `/raiz/2026-10/${sessionId}`,
  sink: 'host',
  status: 'concluida',
  ...over,
})

beforeEach(() => {
  calls.length = 0
  storage.clear()
  clearTranscriptionCache()
})

/** Liga o motor por API neste perfil (Emenda 21). */
const apiOn = () => storage.set('settings', { apiTranscription: { ativa: true, provedor: 'openai', endpoint: '', modelo: '', idioma: 'auto' } })
/** O estado que o motor por API guardou de cada gravação. */
const apiState = (states: Record<string, unknown>) => storage.set('apiTranscriptionState', states)

describe('transcrição no popup', () => {
  it('sem helper: null, sem perguntar nada', async () => {
    expect(await transcriptionForPopup([rec('a')], { ...helperOk, ok: false })).toBeNull()
    expect(calls).toEqual([])
  })

  it('estado por sessão, só das salvas pelo helper, com o caminho do transcricao.md quando pronta', async () => {
    statusRes = {
      id: 1,
      ok: true,
      ativa: true,
      disponivel: true,
      motivo: null,
      recentes: [
        { path: '/raiz/2026-10/a', transcricao: { status: 'pronta' } },
        { path: '/raiz/2026-10/b', transcricao: { status: 'falhou', erro: 'modelo não encontrado: /m.bin' } },
        { path: '/raiz/2026-10/c', transcricao: null },
        // A principal é a do modo aba (entrou depois na pasta da página): abre o .md dela.
        { path: '/raiz/2026-10/e', transcricao: { status: 'pronta', arquivos: ['transcricao-aba.md', 'transcricao-aba.srt'] } },
        // Esperando o motor: o motivo vai junto; um "espera" fora do pendente não.
        { path: '/raiz/2026-10/f', transcricao: { status: 'pendente', espera: 'modelo não encontrado: /m.bin' } },
        { path: '/raiz/2026-10/g', transcricao: { status: 'transcrevendo', espera: 'resto velho' } },
      ],
    }
    const st = await transcriptionForPopup([rec('a'), rec('b'), rec('c'), rec('d', { sink: 'downloads', path: 'Gravações de calls/x' }), rec('e'), rec('f'), rec('g')], helperOk)
    expect(calls).toEqual([{ op: 'transcription-status', arg: ['/raiz/2026-10/a', '/raiz/2026-10/b', '/raiz/2026-10/c', '/raiz/2026-10/e', '/raiz/2026-10/f', '/raiz/2026-10/g'] }])
    expect(st).toEqual({
      suportada: true,
      ativa: true,
      disponivel: true,
      motivo: null,
      porSessao: {
        a: { status: 'pronta', arquivo: '/raiz/2026-10/a/transcricao.md' },
        b: { status: 'falhou', erro: 'modelo não encontrado: /m.bin' },
        e: { status: 'pronta', arquivo: '/raiz/2026-10/e/transcricao-aba.md' },
        f: { status: 'pendente', espera: 'modelo não encontrado: /m.bin' },
        g: { status: 'transcrevendo' },
      },
    })
    // O popup pergunta a cada 1 s: a resposta fica guardada um pouco.
    await transcriptionForPopup([rec('a'), rec('b'), rec('c'), rec('d', { sink: 'downloads', path: 'Gravações de calls/x' }), rec('e'), rec('f'), rec('g')], helperOk)
    expect(calls).toHaveLength(1)
  })

  it('helper de antes da 0.2.0 (operação desconhecida): diz para reinstalar', async () => {
    statusRes = { id: 1, ok: false, error: 'operação desconhecida: transcription-status' }
    expect(await transcriptionForPopup([rec('a')], helperOk)).toEqual({ suportada: false, ativa: false, disponivel: false, motivo: 'o helper instalado é de uma versão sem transcrição: rode npm run instalar de novo', porSessao: {} })
  })
})

describe('configurações e abrir', () => {
  it('a mudança passa pelo zod: campo desconhecido ou caminho relativo não chega ao helper', async () => {
    expect(await setTranscription({ root: '/' })).toMatchObject({ ok: false })
    expect(await setTranscription({ modelo: 'relativo.bin' })).toMatchObject({ ok: false, error: expect.stringContaining('caminho absoluto') })
    expect(calls).toEqual([])
    setRes = { id: 1, ok: true, transcricao: { ativa: false } }
    expect(await setTranscription({ ativa: false })).toEqual({ ok: true, config: { ativa: false } })
    expect(calls).toEqual([{ op: 'set-transcription', arg: { ativa: false } }])
  })

  it('abrir usa o caminho da gravação salva, nunca o de quem pede; Downloads não tem transcrição', async () => {
    statusRes = { id: 1, ok: true, recentes: [{ path: '/raiz/2026-10/a', transcricao: { status: 'pronta', arquivos: ['transcricao.md', 'transcricao.srt'] } }] }
    expect(await openTranscript(rec('a'))).toEqual({ ok: true })
    expect(calls).toEqual([
      { op: 'transcription-status', arg: ['/raiz/2026-10/a'] },
      { op: 'open-file', arg: '/raiz/2026-10/a/transcricao.md' },
    ])
    // O nome do arquivo sai do info.json (a do modo aba), nunca um nome qualquer.
    calls.length = 0
    statusRes = { id: 1, ok: true, recentes: [{ path: '/raiz/2026-10/a', transcricao: { status: 'pronta', arquivos: ['transcricao-aba.srt', 'transcricao-aba.md'] } }] }
    await openTranscript(rec('a'))
    expect(calls.at(-1)).toEqual({ op: 'open-file', arg: '/raiz/2026-10/a/transcricao-aba.md' })
    statusRes = { id: 1, ok: true, recentes: [{ path: '/raiz/2026-10/a', transcricao: { status: 'pronta', arquivos: ['../../fora.md', 'info.json'] } }] }
    await openTranscript(rec('a'))
    expect(calls.at(-1)).toEqual({ op: 'open-file', arg: '/raiz/2026-10/a/transcricao.md' })
    calls.length = 0
    expect(await openTranscript(rec('d', { sink: 'downloads' }))).toEqual({ ok: false, error: 'a transcrição precisa do helper local' })
    expect(await openTranscript(undefined)).toEqual({ ok: false, error: 'gravação não encontrada' })
  })
})

describe('transcrição por API no popup (Emenda 21)', () => {
  const helperOff: HelperStatus = { ok: false, version: null, root: null, writable: false, error: 'sem helper' }

  it('sem helper e com o motor por API ligado: o estado vem da extensão (antes era null)', async () => {
    apiOn()
    apiState({ s1: { status: 'pronta', downloadId: 7 } })
    const st = await transcriptionForPopup([rec('s1', { sink: 'downloads', path: 'Gravações de calls/2026-10/call' })], helperOff)
    expect(st).toMatchObject({ suportada: true, ativa: true, disponivel: true, motor: 'api' })
    expect(st?.porSessao.s1).toMatchObject({ status: 'pronta', downloadId: 7 })
    // Sem helper, nada é perguntado a ele.
    expect(calls).toEqual([])
  })

  it('sem helper e sem o motor por API: continua null (o popup não fala de transcrição)', async () => {
    expect(await transcriptionForPopup([rec('s1', { sink: 'downloads' })], helperOff)).toBeNull()
  })

  it('com helper e o motor por API ligado: o estado da extensão vale mais que o do helper', async () => {
    apiOn()
    apiState({ s1: { status: 'pronta', arquivo: '/raiz/2026-10/s1/transcricao.md' } })
    statusRes = {
      id: 1,
      ok: true,
      ativa: false,
      disponivel: false,
      motivo: 'modelo não encontrado',
      recentes: [{ path: '/raiz/2026-10/s1', transcricao: { status: 'pendente', espera: 'modelo não encontrado' } }],
    } as unknown as HostRes
    const st = await transcriptionForPopup([rec('s1')], helperOff.ok ? helperOff : helperOk)
    expect(st).toMatchObject({ motor: 'api', ativa: true, disponivel: true, motivo: null })
    expect(st?.porSessao.s1).toMatchObject({ status: 'pronta' })
  })

  it('"Abrir transcrição" de uma gravação em Downloads mostra o arquivo no Finder', async () => {
    apiOn()
    apiState({ s1: { status: 'pronta', downloadId: 42 } })
    const mostrados: number[] = []
    ;(globalThis.chrome as unknown as { downloads: { show: (id: number) => void } }).downloads.show = (id) => mostrados.push(id)
    expect(await openTranscript(rec('s1', { sink: 'downloads', path: 'Gravações de calls/2026-10/call' }))).toEqual({ ok: true })
    expect(mostrados).toEqual([42])
    // Sem o downloadId guardado (uma gravação de antes), continua o motivo de sempre.
    apiState({})
    expect(await openTranscript(rec('s2', { sink: 'downloads', path: 'x' }))).toMatchObject({ ok: false })
  })
})
