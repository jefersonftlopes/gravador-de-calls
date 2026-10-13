// A fila, a retenção e o envio do motor de transcrição por API (Emenda 21), com o IndexedDB, o
// chrome.* e o fetch trocados por falsos em memória.
//
// O que está provado aqui:
// - NADA é enviado com o motor desligado, sem a chave, sem a permissão de host, ou com um endereço
//   que não é de uma origem declarada;
// - a chave aparece SÓ no cabeçalho Authorization de uma requisição que de fato sai;
// - 401 não repete e apaga o áudio guardado; 429 e 5xx repetem com espera crescente; erro de rede
//   repete; acima do limite por requisição, nem entra na fila;
// - cada limite da retenção apaga o áudio e deixa a gravação com um motivo legível;
// - o transcricao.md sai com os nomes de quem falou, pelas mesmas funções do helper;
// - a fila sobrevive ao service worker: ela vive no IndexedDB e o alarme existe enquanto há fila.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { InfoJson, SpeakersFile } from '../shared/protocol'
import { API_RETENTION, DEFAULT_API_TRANSCRIPTION } from '../shared/api-transcription'
import type { ApiAudioRecord } from './idb'

const KEY = 'sk-proj-chave-falsa-de-teste-9999'

const fake = vi.hoisted(() => ({
  audio: new Map<string, unknown>(),
  chunks: new Map<string, Array<{ sessionId: string; seq: number; data: Blob; at: number }>>(),
  /** Cada requisição que SAIU: url, cabeçalhos e os campos do multipart. */
  sent: [] as Array<{ url: string; headers: Record<string, string>; fields: Array<[string, string]>; fileBytes: number }>,
  /** Respostas que o fetch falso devolve, em ordem (a última vale para as seguintes). */
  replies: [] as Array<{ status: number } | { json: unknown } | 'rede'>,
  /** O que o transcript-sink escreveu: pasta, arquivos e o estado do info.json. */
  written: [] as Array<{ savedPath: string; sink: string; files: Array<{ nome: string; texto: string }>; transcricao?: unknown; audioAindaGuardado: boolean }>,
  /** O writeTranscript falha uma vez (disco, pasta sem permissão). */
  failWrites: 0,
  helper: { ok: false, version: null as string | null },
  alarms: new Set<string>(),
  permissions: new Set<string>(),
  storage: new Map<string, unknown>(),
}))

vi.mock('./idb', () => ({
  putApiAudio: async (rec: ApiAudioRecord) => void fake.audio.set(rec.sessionId, { ...rec }),
  getApiAudio: async (id: string) => fake.audio.get(id),
  listApiAudio: async () => [...fake.audio.values()],
  deleteApiAudio: async (id: string) => void fake.audio.delete(id),
  getChunks: async (id: string) => fake.chunks.get(id) ?? [],
}))

vi.mock('./sink-host', () => ({
  hostStatus: () => (fake.helper.ok ? { ok: true, version: fake.helper.version, root: '/raiz', writable: true, error: null } : { ok: false, version: null, root: null, writable: false, error: 'sem helper' }),
  host: {},
}))

vi.mock('./transcript-sink', () => ({
  writeTranscript: async (job: { sessionId: string; savedPath: string; sink: string }, files: Array<{ nome: string; texto: string }>, transcricao?: unknown) => {
    if (fake.failWrites > 0) {
      fake.failWrites--
      throw new Error('disco cheio (teste)')
    }
    // A ordem importa: o áudio guardado só pode sair DEPOIS de a saída estar escrita.
    fake.written.push({ savedPath: job.savedPath, sink: job.sink, files, ...(transcricao ? { transcricao } : {}), audioAindaGuardado: fake.audio.has(job.sessionId) })
    const md = files.find((f) => f.nome.endsWith('.md'))
    return { path: md ? `${job.savedPath}/${md.nome}` : null }
  },
}))

const mod = async () => import('./api-transcription')

/**
 * Põe na fila e espera a passada que o finalize dispara sem esperar (no produto o finalize não
 * pode travar na rede; aqui o teste precisa do resultado).
 */
async function queue(m: Awaited<ReturnType<typeof mod>>, args: Parameters<Awaited<ReturnType<typeof mod>>['queueApiTranscription']>[0]) {
  const r = await m.queueApiTranscription(args)
  await m.runApiQueue()
  return r
}

/** FormData falso: o Node tem o de verdade, mas assim o teste lê os campos sem depender dele. */
class FakeFormData {
  entries: Array<[string, unknown, string?]> = []
  append(name: string, value: unknown, filename?: string) {
    this.entries.push([name, value, filename])
  }
}

function setupChrome() {
  fake.storage.clear()
  globalThis.chrome = {
    storage: {
      local: {
        get: async (keys: string | string[]) => {
          const list = typeof keys === 'string' ? [keys] : keys
          const out: Record<string, unknown> = {}
          for (const k of list) if (fake.storage.has(k)) out[k] = fake.storage.get(k)
          return out
        },
        set: async (items: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(items)) fake.storage.set(k, v)
        },
        remove: async (k: string) => void fake.storage.delete(k),
      },
      onChanged: { addListener: () => {}, removeListener: () => {} },
    },
    alarms: {
      create: async (name: string) => void fake.alarms.add(name),
      clear: async (name: string) => void fake.alarms.delete(name),
      onAlarm: { addListener: () => {} },
    },
    permissions: {
      contains: async ({ origins }: { origins: string[] }) => origins.every((o) => fake.permissions.has(o)),
    },
    runtime: { onStartup: { addListener: () => {} } },
  } as unknown as typeof chrome
}

const info: InfoJson = {
  versao: 1,
  sessao: 's1',
  perfil: null,
  plataforma: 'meet',
  titulo: 'Daily do time',
  tituloFonte: 'dom',
  codigo: 'abc-defg-hij',
  idReuniao: '',
  url: 'https://meet.google.com/abc-defg-hij',
  tituloDaAba: 'Daily do time',
  inicio: '2026-10-13T09:00:00-03:00',
  fim: '2026-10-13T09:10:00-03:00',
  duracaoSegundos: 600,
  fuso: 'America/Sao_Paulo',
  participantes: ['Ana Souza', 'Bruno Lima'],
  voce: 'Carla',
  arquivos: [{ nome: 'audio.webm', tipo: 'pagina', bytes: 100, formato: 'audio/webm;codecs=opus', kbps: 32 }],
  captura: { fonteInicial: 'receivers', fonteFinal: 'receivers', trocas: [], contextoAudio: 'running', teveAudio: true },
  esperas: [],
  lacunas: [],
  status: 'concluida',
  motivoFim: 'saiu-da-call',
  extensao: '0.5.0',
  helper: null,
} as unknown as InfoJson

const speakers: SpeakersFile = {
  versao: 1,
  audio: 'audio.webm',
  atrasoMs: 1500,
  intervalos: [
    { nome: 'Ana Souza', de: 0, ate: 3000, fonte: 'csrc' },
    { nome: 'Bruno Lima', de: 3000, ate: 6000, fonte: 'csrc' },
  ],
  pessoas: [
    { nome: 'Ana Souza', segundos: 3 },
    { nome: 'Bruno Lima', segundos: 3 },
  ],
  textos: { voceNaoGravada: '(sua fala não é gravada)' },
} as unknown as SpeakersFile

const API_JSON = {
  language: 'portuguese',
  segments: [
    { start: 0, end: 2.5, text: 'bom dia a todos' },
    { start: 3.2, end: 5.8, text: 'bom dia, vamos começar' },
  ],
}

async function setSettings(over: Partial<typeof DEFAULT_API_TRANSCRIPTION> = {}) {
  fake.storage.set('settings', { apiTranscription: { ...DEFAULT_API_TRANSCRIPTION, ativa: true, ...over } })
}

function putChunks(sessionId: string, bytes: number) {
  fake.chunks.set(sessionId, [{ sessionId, seq: 0, data: new Blob([new Uint8Array(bytes)]), at: 0 }])
}

function queueArgs(sessionId = 's1', sink: 'host' | 'downloads' = 'host') {
  return { rec: { sessionId, file: 'audio.webm' }, info, speakers, savedPath: sink === 'host' ? '/raiz/2026-10/call' : 'Gravações de calls/2026-10/call', sink } as const
}

const stateOf = (id: string) => (fake.storage.get('apiTranscriptionState') as Record<string, { status: string; erro?: string; espera?: string; arquivo?: string }> | undefined)?.[id]

beforeEach(async () => {
  vi.resetModules()
  fake.audio.clear()
  fake.chunks.clear()
  fake.sent.length = 0
  fake.replies.length = 0
  fake.written.length = 0
  fake.failWrites = 0
  fake.helper = { ok: false, version: null }
  fake.alarms.clear()
  fake.permissions.clear()
  setupChrome()
  // A permissão de host concedida é o caso comum; cada teste que a nega limpa esta linha.
  fake.permissions.add('https://api.openai.com/*')
  await setSettings()
  // @ts-expect-error o FormData falso basta para o que o envio faz
  globalThis.FormData = FakeFormData
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const body = init.body as unknown as FakeFormData
    const file = body.entries.find((e) => e[0] === 'file')
    fake.sent.push({
      url: String(url),
      headers: init.headers as Record<string, string>,
      fields: body.entries.filter((e) => e[0] !== 'file').map((e) => [e[0], String(e[1])] as [string, string]),
      fileBytes: (file?.[1] as Blob | undefined)?.size ?? 0,
    })
    const reply = fake.replies.length > 1 ? fake.replies.shift()! : (fake.replies[0] ?? { json: API_JSON })
    if (reply === 'rede') throw new TypeError('Failed to fetch')
    if ('status' in reply) return { ok: false, status: reply.status, json: async () => ({}) } as unknown as Response
    return { ok: true, status: 200, json: async () => reply.json } as unknown as Response
  }) as unknown as typeof fetch
})

afterEach(() => {
  vi.useRealTimers()
})

describe('nada é enviado sem as condições', () => {
  it('motor desligado: não guarda áudio, não entra na fila, nada sai', async () => {
    await setSettings({ ativa: false })
    // Com áudio e com chave: o que impede é a guarda, não a falta de material.
    putChunks('s1', 2048)
    fake.storage.set('apiTranscriptionKey', KEY)
    const m = await mod()
    expect(await m.queueApiTranscription(queueArgs())).toEqual({ queued: false })
    await m.runApiQueue()
    expect(fake.audio.size).toBe(0)
    expect(fake.sent).toEqual([])
    expect(fake.written).toEqual([])
  })

  it('sem a permissão de host concedida, a gravação espera na fila e NADA sai', async () => {
    fake.permissions.clear()
    putChunks('s1', 2048)
    fake.storage.set('apiTranscriptionKey', KEY)
    const m = await mod()
    await queue(m, queueArgs())
    expect(fake.sent).toEqual([])
    expect(fake.audio.size).toBe(1)
    expect(stateOf('s1')).toMatchObject({ status: 'pendente' })
    expect(stateOf('s1')?.espera).toContain('permissão')
  })

  it('sem a chave, a gravação espera na fila e NADA sai; colar a chave depois transcreve', async () => {
    putChunks('s1', 2048)
    const m = await mod()
    await queue(m, queueArgs())
    expect(fake.sent).toEqual([])
    expect(stateOf('s1')?.espera).toContain('chave')
    fake.storage.set('apiTranscriptionKey', KEY)
    await m.runApiQueue()
    expect(fake.sent).toHaveLength(1)
    expect(stateOf('s1')).toMatchObject({ status: 'pronta' })
  })

  it('um endereço de outra origem guardado à mão nunca é usado (volta ao do provedor)', async () => {
    fake.storage.set('settings', { apiTranscription: { ...DEFAULT_API_TRANSCRIPTION, ativa: true, endpoint: 'https://api.mau.example/v1' } })
    putChunks('s1', 2048)
    fake.storage.set('apiTranscriptionKey', KEY)
    const m = await mod()
    await queue(m, queueArgs())
    expect(fake.sent.map((r) => r.url)).toEqual(['https://api.openai.com/v1/audio/transcriptions'])
    expect(JSON.stringify(fake.sent)).not.toContain('mau.example')
  })

  it('com o helper instalado numa versão anterior, nada é guardado nem enviado (os dois motores escreveriam a mesma pasta)', async () => {
    fake.helper = { ok: true, version: '0.4.2' }
    putChunks('s1', 2048)
    fake.storage.set('apiTranscriptionKey', KEY)
    const m = await mod()
    const r = await queue(m, queueArgs())
    expect(r.queued).toBe(false)
    expect(fake.audio.size).toBe(0)
    expect(stateOf('s1')).toMatchObject({ status: 'falhou' })
    expect(stateOf('s1')?.erro).toContain('npm run instalar')
  })

  it('com o helper 0.5.0 (ou sem helper), o motor funciona', async () => {
    const { atLeastVersion, helperFitsApiEngine, HOST_MIN_FOR_API } = await mod()
    expect(HOST_MIN_FOR_API).toBe('0.5.0')
    expect(atLeastVersion('0.5.0', '0.5.0')).toBe(true)
    expect(atLeastVersion('0.5.1', '0.5.0')).toBe(true)
    expect(atLeastVersion('0.10.0', '0.5.0')).toBe(true)
    expect(atLeastVersion('0.4.9', '0.5.0')).toBe(false)
    expect(atLeastVersion(null, '0.5.0')).toBe(false)
    expect(helperFitsApiEngine().ok).toBe(true)
    fake.helper = { ok: true, version: '0.5.0' }
    expect(helperFitsApiEngine().ok).toBe(true)
  })

  it('acima do limite por requisição: não entra na fila, não é cortado, e a gravação diz por quê', async () => {
    putChunks('s1', 26 * 1024 * 1024)
    fake.storage.set('apiTranscriptionKey', KEY)
    const m = await mod()
    const r = await queue(m, queueArgs())
    expect(r.queued).toBe(false)
    expect(fake.audio.size).toBe(0)
    expect(fake.sent).toEqual([])
    expect(stateOf('s1')?.erro).toMatch(/longa demais|25 MB/)
  })
})

describe('envio que dá certo', () => {
  beforeEach(() => {
    putChunks('s1', 4096)
    fake.storage.set('apiTranscriptionKey', KEY)
  })

  it('a chave vai SÓ no cabeçalho Authorization: não está na URL nem no multipart', async () => {
    const m = await mod()
    await queue(m, queueArgs())
    expect(fake.sent).toHaveLength(1)
    const [req] = fake.sent
    expect(req.headers).toEqual({ Authorization: `Bearer ${KEY}` })
    expect(req.url).toBe('https://api.openai.com/v1/audio/transcriptions')
    expect(req.url).not.toContain(KEY)
    expect(JSON.stringify(req.fields)).not.toContain(KEY)
    // E nada da chave sobra no estado guardado, que é o que o popup lê.
    expect(JSON.stringify([...fake.storage.entries()].filter(([k]) => k !== 'apiTranscriptionKey'))).not.toContain(KEY)
    expect(JSON.stringify(fake.written)).not.toContain(KEY)
  })

  it('o multipart leva o modelo com tempos, o formato verbose_json e o áudio', async () => {
    const m = await mod()
    await queue(m, queueArgs())
    expect(fake.sent[0].fields).toEqual([
      ['model', 'whisper-1'],
      ['response_format', 'verbose_json'],
      ['timestamp_granularities[]', 'segment'],
    ])
    expect(fake.sent[0].fileBytes).toBe(4096)
  })

  it('o transcricao.md e o .srt saem com os nomes de quem falou, e o áudio guardado é apagado', async () => {
    const m = await mod()
    await queue(m, queueArgs())
    expect(fake.written).toHaveLength(2)
    const saida = fake.written.find((w) => w.files.length === 2)!
    expect(saida.files.map((f) => f.nome)).toEqual(['transcricao.md', 'transcricao.srt'])
    const md = saida.files[0].texto
    expect(md).toContain('# Daily do time')
    expect(md).toContain('- **Transcrição:** OpenAI API, modelo whisper-1, idioma portuguese')
    expect(md).toContain('[00:00] Ana Souza: bom dia a todos')
    expect(md).toContain('[00:03] Bruno Lima: bom dia, vamos começar')
    expect(saida.files[1].texto).toContain('Ana Souza: bom dia a todos')
    // O estado vai para o info.json no mesmo formato que o helper usa.
    const registro = fake.written.find((w) => w.transcricao)!.transcricao as Record<string, unknown>
    expect(registro).toMatchObject({ status: 'pronta', motor: 'openai-api', modelo: 'whisper-1', audio: 'audio.webm', arquivos: ['transcricao.md', 'transcricao.srt'] })
    // O áudio guardado sai só DEPOIS de a saída estar escrita.
    expect(saida.audioAindaGuardado).toBe(true)
    expect(fake.audio.size).toBe(0)
    expect(stateOf('s1')).toMatchObject({ status: 'pronta', arquivo: '/raiz/2026-10/call/transcricao.md' })
  })

  it('sem falantes, a transcrição sai sem nomes (como no motor local)', async () => {
    const m = await mod()
    await queue(m, { ...queueArgs(), speakers: null })
    const saida = fake.written.find((w) => w.files.length === 2)!
    expect(saida.files[0].texto).toContain('[00:00] bom dia a todos')
    expect(saida.files[0].texto).not.toContain('Ana Souza:')
  })

  it('salva em Downloads: a saída vai pelo mesmo caminho e o info.json não é reescrito', async () => {
    const m = await mod()
    await queue(m, queueArgs('s1', 'downloads'))
    expect(fake.written.map((w) => w.sink)).toEqual(['downloads'])
    expect(fake.written[0].transcricao).toBeUndefined()
    expect(stateOf('s1')).toMatchObject({ status: 'pronta' })
  })
})

describe('erros tratados de formas diferentes', () => {
  beforeEach(() => {
    putChunks('s1', 4096)
    fake.storage.set('apiTranscriptionKey', KEY)
  })

  it('401 é erro de configuração: não repete sozinho e o áudio guardado sai', async () => {
    fake.replies.push({ status: 401 })
    const m = await mod()
    await queue(m, queueArgs())
    expect(fake.sent).toHaveLength(1)
    expect(stateOf('s1')).toMatchObject({ status: 'falhou' })
    expect(stateOf('s1')?.erro).toContain('chave')
    expect(fake.audio.size).toBe(0)
    // Uma passada nova não manda de novo: não há mais o que mandar.
    await m.runApiQueue()
    expect(fake.sent).toHaveLength(1)
  })

  it('429 repete com espera, e a tentativa seguinte transcreve', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    fake.replies.push({ status: 429 }, { json: API_JSON })
    const m = await mod()
    await queue(m, queueArgs())
    expect(fake.sent).toHaveLength(1)
    expect(stateOf('s1')).toMatchObject({ status: 'pendente' })
    expect(stateOf('s1')?.espera).toContain('esperar')
    const job = fake.audio.get('s1') as ApiAudioRecord
    expect(job.attempts).toBe(1)
    expect(job.nextAt).toBe(1_000_000 + API_RETENTION.backoffMs[0])
    // Antes da hora, não manda de novo.
    await m.runApiQueue()
    expect(fake.sent).toHaveLength(1)
    vi.setSystemTime(1_000_000 + API_RETENTION.backoffMs[0])
    await m.runApiQueue()
    expect(fake.sent).toHaveLength(2)
    expect(stateOf('s1')).toMatchObject({ status: 'pronta' })
  })

  it('5xx repete com espera crescente', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(2_000_000)
    fake.replies.push({ status: 503 })
    const m = await mod()
    await queue(m, queueArgs())
    expect(stateOf('s1')?.espera).toContain('503')
    expect((fake.audio.get('s1') as ApiAudioRecord).nextAt).toBe(2_000_000 + API_RETENTION.backoffMs[0])
    vi.setSystemTime(2_000_000 + API_RETENTION.backoffMs[0])
    await m.runApiQueue()
    expect((fake.audio.get('s1') as ApiAudioRecord).attempts).toBe(2)
    expect((fake.audio.get('s1') as ApiAudioRecord).nextAt).toBe(2_000_000 + API_RETENTION.backoffMs[0] + API_RETENTION.backoffMs[1])
  })

  it('erro de rede repete, e o motivo do navegador não aparece na tela', async () => {
    fake.replies.push('rede')
    const m = await mod()
    await queue(m, queueArgs())
    expect(stateOf('s1')).toMatchObject({ status: 'pendente' })
    expect(stateOf('s1')?.espera).toContain('provedor')
    expect(stateOf('s1')?.espera).not.toContain('Failed to fetch')
    expect(fake.audio.size).toBe(1)
  })

  it('400 (pedido recusado) não repete sozinho', async () => {
    fake.replies.push({ status: 400 })
    const m = await mod()
    await queue(m, queueArgs())
    expect(stateOf('s1')).toMatchObject({ status: 'falhou' })
    expect(fake.audio.size).toBe(0)
  })

  it('a saída que não dá para escrever guarda o áudio e tenta de novo', async () => {
    fake.failWrites = 1
    const m = await mod()
    await queue(m, queueArgs())
    expect(stateOf('s1')).toMatchObject({ status: 'pendente' })
    expect(fake.audio.size).toBe(1)
    const job = fake.audio.get('s1') as ApiAudioRecord
    fake.audio.set('s1', { ...job, nextAt: 0 })
    await m.runApiQueue()
    expect(stateOf('s1')).toMatchObject({ status: 'pronta' })
  })
})

describe('retenção: nada fica guardado para sempre', () => {
  const job = (over: Partial<ApiAudioRecord>): ApiAudioRecord =>
    ({
      sessionId: 'x',
      blob: new Blob([new Uint8Array(1024)]),
      bytes: 1024,
      audio: 'audio.webm',
      savedPath: '/raiz/2026-10/call',
      sink: 'host',
      info,
      speakers: null,
      createdAt: Date.now(),
      attempts: 0,
      nextAt: 0,
      lastError: null,
      ...over,
    }) as ApiAudioRecord

  beforeEach(() => {
    fake.storage.set('apiTranscriptionKey', KEY)
  })

  it('tentativas esgotadas: o áudio é apagado e a gravação fica com o motivo e a última falha', async () => {
    fake.audio.set('a', job({ sessionId: 'a', attempts: API_RETENTION.maxAttempts, lastError: 'o provedor respondeu com erro (503)' }))
    const m = await mod()
    await m.runApiQueue()
    expect(fake.audio.size).toBe(0)
    expect(fake.sent).toEqual([])
    expect(stateOf('a')).toMatchObject({ status: 'falhou' })
    expect(stateOf('a')?.erro).toContain('503')
  })

  it('idade máxima: o áudio é apagado com o motivo', async () => {
    fake.audio.set('b', job({ sessionId: 'b', createdAt: Date.now() - API_RETENTION.maxAgeMs - 1000 }))
    const m = await mod()
    await m.runApiQueue()
    expect(fake.audio.size).toBe(0)
    expect(stateOf('b')?.erro).toMatch(/\d+ h/)
  })

  it('tamanho total: a mais antiga sai e a mais nova continua na fila', async () => {
    const metade = Math.ceil(API_RETENTION.maxTotalBytes * 0.6)
    fake.audio.set('velha', job({ sessionId: 'velha', bytes: metade, createdAt: Date.now() - 60_000 }))
    fake.audio.set('nova', job({ sessionId: 'nova', bytes: metade, createdAt: Date.now() }))
    const m = await mod()
    await m.runApiQueue()
    // A velha sai pelo limite, sem ser enviada; a nova é a que fica e vai para a API.
    expect(fake.sent).toHaveLength(1)
    expect(stateOf('velha')?.erro).toContain('MB')
    expect(stateOf('velha')).toMatchObject({ status: 'falhou' })
    expect(stateOf('nova')).toMatchObject({ status: 'pronta' })
    expect(fake.audio.size).toBe(0)
  })
})

describe('durabilidade', () => {
  it('a fila vive no IndexedDB e o alarme existe enquanto há fila', async () => {
    putChunks('s1', 4096)
    const m = await mod()
    const { API_ALARM, apiQueueSize } = m
    await m.queueApiTranscription(queueArgs())
    await m.runApiQueue()
    // Sem a chave, o trabalho fica guardado: é esta fila que sobrevive ao SW.
    expect(await apiQueueSize()).toBe(1)
    expect(fake.alarms.has(API_ALARM)).toBe(true)

    // O service worker morre: o módulo é carregado de novo, sem nenhum estado em memória.
    vi.resetModules()
    const novo = await mod()
    expect(await novo.apiQueueSize()).toBe(1)
    fake.storage.set('apiTranscriptionKey', KEY)
    await novo.runApiQueue()
    expect(fake.sent).toHaveLength(1)
    expect(await novo.apiQueueSize()).toBe(0)
    // Fila vazia: o alarme sai (nada acorda o SW sem motivo).
    expect(fake.alarms.has(API_ALARM)).toBe(false)
  })

  it('duas passadas ao mesmo tempo não mandam o mesmo áudio duas vezes', async () => {
    putChunks('s1', 4096)
    fake.storage.set('apiTranscriptionKey', KEY)
    const m = await mod()
    await queue(m, queueArgs())
    await Promise.all([m.runApiQueue(), m.runApiQueue(), m.runApiQueue()])
    expect(fake.sent).toHaveLength(1)
  })
})
