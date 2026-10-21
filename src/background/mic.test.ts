// A máquina do gravador de microfone por aba (Emenda 25), com o resto trocado por falsos: o que o
// ponta a ponta não alcança de forma determinística.
//
// - desligado no perfil (o padrão): a sessão de página não abre gravação nenhuma, nenhum comando vai
//   para o offscreen, nenhum getUserMedia é pedido;
// - ligado: a sessão nasce `kind: 'microfone'` pareada com a da página, e o gravador é preparado SEM
//   abrir o microfone (nada de permissão até o portão abrir);
// - o portão só é comandado quando MUDA (um relato igual não manda nada), com o `waitMs` da regra;
// - duas abas gravando ao mesmo tempo são comandadas separadamente;
// - a aba que para de relatar tem o portão fechado pelo vigia;
// - a abertura que falha (sem permissão) não liga nada;
// - o badge só diz MIC enquanto a voz está entrando.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MicTrackState } from '../shared/protocol'
import { MIC_REPORT_STALE_MS } from '../shared/mic-route'
import { MIXER_DELAY_MS } from '../shared/constants'

const fake = vi.hoisted(() => ({
  micRecording: false,
  created: [] as Array<Record<string, unknown>>,
  offscreen: [] as Array<Record<string, unknown>>,
  stopped: [] as string[],
  badges: [] as Array<[number, boolean]>,
  stored: new Map<string, Record<string, unknown>>(),
  /** Respostas do offscreen ao mic-gate, na ordem (sem nada: ok). */
  gateReplies: [] as Array<{ ok: boolean; error?: string }>,
  micStartOk: true,
  /** Ouvintes que o registerMic instalou. */
  onStarted: [] as Array<(e: { tabId: number; sessionId: string; startedAt: number }) => void>,
  onEnded: [] as Array<(e: { tabId: number; sessionId: string; reason: string }) => void>,
  onReport: [] as Array<(e: { tabId: number; tracks: MicTrackState[]; sinceMs: number }) => void>,
  onSettings: [] as Array<(s: { micRecording: boolean }) => void>,
  /** O que o SW diz estar gravando agora (activeRecordings). */
  active: [] as Array<{ sessionId: string; tabId: number; kind: string; startedAt: number }>,
}))

vi.mock('../shared/settings', () => ({
  loadSettings: async () => ({ micRecording: fake.micRecording }),
  onSettingsChanged: (cb: (s: { micRecording: boolean }) => void) => void fake.onSettings.push(cb),
}))
vi.mock('./idb', () => ({
  getSession: async (id: string) => fake.stored.get(id),
  putSession: async (rec: Record<string, unknown>) => void fake.stored.set(rec.sessionId as string, rec),
}))
vi.mock('./offscreen-doc', () => ({
  sendToOffscreen: async (req: Record<string, unknown>) => {
    fake.offscreen.push(req)
    if (req.t === 'offscreen:mic-start') return fake.micStartOk ? { ok: true } : { ok: false, error: 'offscreen fora' }
    if (req.t === 'offscreen:mic-gate') return fake.gateReplies.shift() ?? { ok: true }
    return { ok: true }
  },
}))
vi.mock('./sessions', () => ({
  activeRecordings: () => fake.active,
  createSession: async (opts: Record<string, unknown>) => {
    fake.created.push(opts)
    const rec = { ...opts, sessionId: `mic-${fake.created.length}`, platform: 'meet' }
    fake.stored.set(rec.sessionId, rec)
    return rec
  },
  stopSession: async (id: string) => void fake.stopped.push(id),
  markMicOpened: async (id: string) => {
    const rec = fake.stored.get(id)
    if (rec) fake.stored.set(id, { ...rec, micEverOpen: true })
  },
  onPageSessionStarted: (cb: (e: never) => void) => void fake.onStarted.push(cb as never),
  onPageSessionEnded: (cb: (e: never) => void) => void fake.onEnded.push(cb as never),
  onMicReport: (cb: (e: never) => void) => void fake.onReport.push(cb as never),
  setMicRecordingBadge: async (tabId: number, on: boolean) => void fake.badges.push([tabId, on]),
}))
vi.mock('./testing', () => ({ registerTestHooks: () => {} }))

const TAB = 7
const OUTRA = 9
const aberta = (over: Partial<MicTrackState> = {}): MicTrackState => ({ readyState: 'live', enabled: true, muted: false, sender: 1, ...over })

let mic: typeof import('./mic')

async function carregar() {
  vi.resetModules()
  ;(globalThis as unknown as { chrome: unknown }).chrome = { tabs: { onRemoved: { addListener: () => {} } } }
  // A sessão de página que o startMic lê para saber a plataforma.
  fake.stored.set('pagina-1', { sessionId: 'pagina-1', platform: 'meet' })
  fake.stored.set('pagina-2', { sessionId: 'pagina-2', platform: 'teams' })
  mic = await import('./mic')
  mic.registerMic()
}

/** A sessão de página desta aba começou (o SW aceitou). */
const comecar = async (tabId: number, sessionId = 'pagina-1', startedAt = 1000) => {
  for (const cb of fake.onStarted) cb({ tabId, sessionId, startedAt })
  await vi.waitFor(() => expect(fake.offscreen.some((r) => r.t === 'offscreen:mic-start' && r.tabId === tabId) || !fake.micRecording).toBe(true))
  await Promise.resolve()
}

/** Um relato de estado das faixas daquela aba. */
const relatar = async (tabId: number, tracks: MicTrackState[], sinceMs = 250) => {
  for (const cb of fake.onReport) cb({ tabId, tracks, sinceMs })
  await vi.waitFor(() => expect(true).toBe(true))
  await new Promise((r) => setTimeout(r, 0))
}

const portoes = () => fake.offscreen.filter((r) => r.t === 'offscreen:mic-gate').map((r) => ({ tabId: r.tabId, open: r.open, waitMs: r.waitMs }))

beforeEach(async () => {
  vi.useRealTimers()
  fake.micRecording = false
  fake.created = []
  fake.offscreen = []
  fake.stopped = []
  fake.badges = []
  fake.gateReplies = []
  fake.micStartOk = true
  fake.stored = new Map()
  fake.onStarted = []
  fake.onEnded = []
  fake.onReport = []
  fake.onSettings = []
  fake.active = []
  await carregar()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('desligado no perfil (o padrão)', () => {
  it('a sessão de página não abre gravação de microfone nenhuma', async () => {
    await comecar(TAB)
    await relatar(TAB, [aberta()])
    expect(fake.created).toEqual([])
    expect(fake.offscreen).toEqual([])
    expect(fake.badges).toEqual([])
  })
})

describe('ligado no perfil', () => {
  beforeEach(() => {
    fake.micRecording = true
  })

  it('a sessão nasce microfone, pareada com a da página, e o gravador é preparado sem abrir o microfone', async () => {
    await comecar(TAB, 'pagina-1', 1000)
    expect(fake.created).toHaveLength(1)
    expect(fake.created[0]).toMatchObject({ tabId: TAB, kind: 'microfone', pairedSessionId: 'pagina-1', platform: 'meet', port: null })
    // Nenhum portão: o getUserMedia só acontece quando o portão abre.
    expect(fake.offscreen.map((r) => r.t)).toEqual(['offscreen:mic-start'])
    expect(fake.offscreen[0]).toMatchObject({ tabId: TAB, sessionId: 'mic-1' })
    // O desvio em relação à sessão de página fica no registro (vai no desvioMs do info.json).
    expect(typeof fake.stored.get('mic-1')?.micSkewMs).toBe('number')
  })

  it('o offscreen que não prepara o gravador desfaz a sessão', async () => {
    fake.micStartOk = false
    await comecar(TAB)
    await vi.waitFor(() => expect(fake.stopped).toEqual(['mic-1']))
    await relatar(TAB, [aberta()])
    expect(portoes()).toEqual([])
  })

  it('o portão abre com a faixa aberta e o waitMs da regra, e o badge passa a dizer MIC', async () => {
    await comecar(TAB)
    await relatar(TAB, [aberta()])
    await vi.waitFor(() => expect(portoes()).toEqual([{ tabId: TAB, open: true, waitMs: MIXER_DELAY_MS }]))
    expect(fake.badges).toEqual([[TAB, true]])
    expect(mic.micRecordingOn(TAB)).toBe(true)
    expect(fake.stored.get('mic-1')?.micEverOpen).toBe(true)
  })

  it('um relato igual não manda comando nenhum (só a troca comanda)', async () => {
    await comecar(TAB)
    await relatar(TAB, [aberta()])
    await vi.waitFor(() => expect(portoes()).toHaveLength(1))
    await relatar(TAB, [aberta()])
    await relatar(TAB, [aberta()])
    expect(portoes()).toHaveLength(1)
  })

  it('mutar fecha o portão descontando a idade da leitura, e desmutar abre de novo', async () => {
    await comecar(TAB)
    await relatar(TAB, [aberta()])
    await vi.waitFor(() => expect(portoes()).toHaveLength(1))
    await relatar(TAB, [aberta({ enabled: false })], 250)
    await vi.waitFor(() => expect(portoes()).toHaveLength(2))
    expect(portoes()[1]).toEqual({ tabId: TAB, open: false, waitMs: MIXER_DELAY_MS - 250 })
    expect(fake.badges.at(-1)).toEqual([TAB, false])
    await relatar(TAB, [aberta()])
    await vi.waitFor(() => expect(portoes()).toHaveLength(3))
    expect(portoes()[2]).toEqual({ tabId: TAB, open: true, waitMs: MIXER_DELAY_MS })
  })

  it('sem faixa observável o portão nunca abre (o caso da faixa processada)', async () => {
    await comecar(TAB)
    await relatar(TAB, [])
    await relatar(TAB, [aberta({ sender: null })])
    await new Promise((r) => setTimeout(r, 20))
    expect(portoes()).toEqual([])
    expect(mic.micRecordingOn(TAB)).toBe(false)
    expect(fake.stored.get('mic-1')?.micEverOpen).toBeUndefined()
  })

  it('duas abas gravando ao mesmo tempo são comandadas separadamente', async () => {
    await comecar(TAB, 'pagina-1')
    await comecar(OUTRA, 'pagina-2')
    expect(fake.created.map((c) => c.pairedSessionId)).toEqual(['pagina-1', 'pagina-2'])
    await relatar(TAB, [aberta()])
    await relatar(OUTRA, [aberta({ sender: 2 })])
    await vi.waitFor(() => expect(portoes()).toHaveLength(2))
    expect(portoes()).toEqual([
      { tabId: TAB, open: true, waitMs: MIXER_DELAY_MS },
      { tabId: OUTRA, open: true, waitMs: MIXER_DELAY_MS },
    ])
    // Uma muta: só a dela fecha.
    await relatar(TAB, [aberta({ enabled: false })])
    await vi.waitFor(() => expect(portoes()).toHaveLength(3))
    expect(portoes()[2]).toMatchObject({ tabId: TAB, open: false })
    expect(mic.micRecordingOn(OUTRA)).toBe(true)
  })

  it('a aba que para de relatar tem o portão fechado pelo vigia', async () => {
    await comecar(TAB)
    await relatar(TAB, [aberta()])
    await vi.waitFor(() => expect(portoes()).toHaveLength(1))
    // O relógio anda: o relato fica velho, e o vigia de 1 s fecha sem nenhum relato novo.
    const real = Date.now
    try {
      const t0 = real()
      Date.now = () => t0 + MIC_REPORT_STALE_MS + 1000
      await vi.waitFor(() => expect(portoes()).toHaveLength(2), { timeout: 5000 })
      expect(portoes()[1]).toEqual({ tabId: TAB, open: false, waitMs: 0 })
    } finally {
      Date.now = real
    }
  })

  it('a abertura que falha (sem permissão) não liga nada, e o badge não muda', async () => {
    fake.gateReplies = [{ ok: false, error: 'Permission dismissed' }]
    await comecar(TAB)
    await relatar(TAB, [aberta()])
    await vi.waitFor(() => expect(portoes()).toHaveLength(1))
    expect(mic.micRecordingOn(TAB)).toBe(false)
    expect(fake.badges).toEqual([])
    expect(fake.stored.get('mic-1')?.micEverOpen).toBeUndefined()
  })

  it('a sessão de página que termina para o microfone e apaga o badge', async () => {
    await comecar(TAB)
    await relatar(TAB, [aberta()])
    await vi.waitFor(() => expect(portoes()).toHaveLength(1))
    for (const cb of fake.onEnded) cb({ tabId: TAB, sessionId: 'pagina-1', reason: 'saiu-da-call' })
    await vi.waitFor(() => expect(fake.offscreen.some((r) => r.t === 'offscreen:mic-stop')).toBe(true))
    expect(fake.offscreen.at(-1)).toMatchObject({ t: 'offscreen:mic-stop', tabId: TAB, reason: 'saiu-da-call' })
    await vi.waitFor(() => expect(fake.badges.at(-1)).toEqual([TAB, false]))
    expect(mic.micRecordingOn(TAB)).toBe(false)
  })

  it('desligar no meio da call para a gravação da voz na hora', async () => {
    await comecar(TAB)
    await relatar(TAB, [aberta()])
    await vi.waitFor(() => expect(portoes()).toHaveLength(1))
    fake.micRecording = false
    for (const cb of fake.onSettings) cb({ micRecording: false })
    await vi.waitFor(() => expect(fake.offscreen.some((r) => r.t === 'offscreen:mic-stop')).toBe(true))
    expect(mic.micRecordingOn(TAB)).toBe(false)
    await vi.waitFor(() => expect(fake.badges.at(-1)).toEqual([TAB, false]))
  })

  it('ligar no meio da call passa a gravar a voz nas calls que já estão gravando', async () => {
    // A escolha estava desligada quando a call começou: nada foi criado.
    fake.micRecording = false
    await comecar(TAB, 'pagina-1', 1000)
    expect(fake.created).toEqual([])
    // Agora ele liga nas configurações.
    fake.micRecording = true
    fake.active = [{ sessionId: 'pagina-1', tabId: TAB, kind: 'pagina', startedAt: 1000 }]
    for (const cb of fake.onSettings) cb({ micRecording: true })
    await vi.waitFor(() => expect(fake.created).toHaveLength(1))
    expect(fake.created[0]).toMatchObject({ tabId: TAB, kind: 'microfone', pairedSessionId: 'pagina-1' })
    // O arquivo começa agora, e o desvio em relação à sessão de página diz o quanto depois.
    expect((fake.stored.get('mic-1')?.micSkewMs as number) > 0).toBe(true)
    await relatar(TAB, [aberta()])
    await vi.waitFor(() => expect(portoes()).toHaveLength(1))
  })

  it('dois começos na mesma aba dão uma gravação só', async () => {
    for (const cb of fake.onStarted) cb({ tabId: TAB, sessionId: 'pagina-1', startedAt: 1000 })
    for (const cb of fake.onStarted) cb({ tabId: TAB, sessionId: 'pagina-1', startedAt: 1000 })
    await vi.waitFor(() => expect(fake.offscreen.filter((r) => r.t === 'offscreen:mic-start')).toHaveLength(1))
    await new Promise((r) => setTimeout(r, 20))
    expect(fake.created).toHaveLength(1)
  })
})
