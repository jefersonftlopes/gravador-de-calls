// Motor de transcrição por API (Emenda 21): as partes puras.
// - a configuração por perfil nasce desligada e não aceita um endereço de outra origem;
// - a chave NUNCA sai de src/shared/api-key.ts e só aparece no cabeçalho Authorization;
// - cada limite da retenção (tentativas, idade, tamanho total) tem um caso próprio;
// - a classificação dos erros: 401 não repete, 429 e 5xx repetem, rede repete, acima de 25 MB não.
import { describe, expect, it } from 'vitest'
import {
  API_ENGINE_ID,
  API_PROVIDERS,
  API_RETENTION,
  API_UPLOAD_FILENAME,
  DEFAULT_API_TRANSCRIPTION,
  OPENAI_MAX_BYTES,
  TEST_API_ORIGIN,
  allowedApiOrigins,
  applyRetention,
  declaredApiOrigins,
  authHeaders,
  backoffFor,
  classifyApiError,
  dollarsPerHour,
  endpointOf,
  isAllowedEndpoint,
  languageFromApiJson,
  maxBytesOf,
  modelOf,
  multipartFields,
  normalizeApiTranscription,
  optionalApiOrigins,
  originPatternOf,
  providerOf,
  retriesAlone,
  segmentsFromApiJson,
} from './api-transcription'
import { API_KEY_MAX, apiKeyHint } from './api-key'
import { apiTranscriptionSchema, settingsSchema } from './protocol'
import { DEFAULT_SETTINGS, normalizeSettings } from './settings'

const cfg = (over: Partial<typeof DEFAULT_API_TRANSCRIPTION> = {}) => ({ ...DEFAULT_API_TRANSCRIPTION, ...over })

describe('configuração do motor por API', () => {
  it('nasce desligada, no provedor declarado, e o modelo padrão é o que devolve os tempos', () => {
    expect(DEFAULT_API_TRANSCRIPTION.ativa).toBe(false)
    expect(DEFAULT_SETTINGS.apiTranscription).toEqual(DEFAULT_API_TRANSCRIPTION)
    // whisper-1 é o único do OpenAI que devolve os tempos de cada trecho; sem tempos não dá para
    // casar a fala com o falantes.json nem manter os nomes de quem falou (Emenda 18).
    expect(modelOf(cfg())).toBe('whisper-1')
    expect(endpointOf(cfg())).toBe('https://api.openai.com/v1/audio/transcriptions')
    expect(maxBytesOf(cfg())).toBe(OPENAI_MAX_BYTES)
    expect(OPENAI_MAX_BYTES).toBe(25 * 1024 * 1024)
  })

  it('o id do motor aparece no info.json e tem rótulo próprio no cabeçalho do transcricao.md', () => {
    expect(API_ENGINE_ID).toBe('openai-api')
  })

  it('a configuração é por perfil: vai dentro de Settings, e um campo a mais não passa', () => {
    expect(settingsSchema.shape.apiTranscription).toBeDefined()
    // `strict()`: nada de uma chave entrando de carona na configuração.
    expect(apiTranscriptionSchema.safeParse({ ...DEFAULT_API_TRANSCRIPTION, chave: 'sk-teste' }).success).toBe(false)
    expect(apiTranscriptionSchema.safeParse(DEFAULT_API_TRANSCRIPTION).success).toBe(true)
  })

  it('normaliza: campo inválido volta ao padrão, e a seção ausente (antes da 0.5.0) fica desligada', () => {
    expect(normalizeApiTranscription(undefined)).toEqual(DEFAULT_API_TRANSCRIPTION)
    expect(normalizeApiTranscription({ ativa: 'sim', provedor: 'outro', idioma: 'PORTUGUES' })).toEqual(DEFAULT_API_TRANSCRIPTION)
    expect(normalizeApiTranscription({ ativa: true, idioma: 'pt' })).toMatchObject({ ativa: true, idioma: 'pt' })
    // Um objeto guardado com algo parecido com uma chave: o campo é simplesmente ignorado.
    expect(normalizeApiTranscription({ ativa: true, chave: 'sk-vazada' })).not.toHaveProperty('chave')
  })

  it('normalizeSettings aceita a seção ausente e mantém os outros campos (configuração antiga)', () => {
    const s = normalizeSettings({ profileLabel: 'Trabalho', minSeconds: 42 })
    expect(s.apiTranscription).toEqual(DEFAULT_API_TRANSCRIPTION)
    expect(s.profileLabel).toBe('Trabalho')
    expect(s.minSeconds).toBe(42)
    // Uma seção inválida não derruba o resto.
    const bad = normalizeSettings({ profileLabel: 'Trabalho', apiTranscription: { ativa: 'talvez', endpoint: 'ftp://x/' } })
    expect(bad.apiTranscription).toEqual(DEFAULT_API_TRANSCRIPTION)
    expect(bad.profileLabel).toBe('Trabalho')
  })
})

describe('endereço e origem (permissão de host)', () => {
  it('só uma origem declarada é aceita, e ela é a mesma do optional_host_permissions', () => {
    expect(API_PROVIDERS.map((p) => p.origem)).toContain('https://api.openai.com/*')
    expect(originPatternOf('https://api.openai.com/v1/audio/transcriptions')).toBe('https://api.openai.com/*')
    expect(originPatternOf('https://api.exemplo.com/v1/audio/transcriptions')).toBeNull()
    expect(isAllowedEndpoint('https://api.openai.com/v1/audio/transcriptions')).toBe(true)
  })

  it('recusa endereço que não seja de uma origem declarada: http de fora, outro esquema, lixo', () => {
    expect(originPatternOf('http://api.openai.com/v1/audio/transcriptions')).toBeNull()
    expect(originPatternOf('ftp://api.openai.com/x')).toBeNull()
    expect(originPatternOf('file:///etc/passwd')).toBeNull()
    expect(originPatternOf('não é uma url')).toBeNull()
    expect(originPatternOf('https://api.openai.com.mau.example/v1')).toBeNull()
  })

  it('no pacote da loja sobra só https; no build de desenvolvimento entra o servidor falso dos testes', () => {
    expect(allowedApiOrigins(true)).toEqual(['https://api.openai.com/*'])
    expect(allowedApiOrigins(true).every((o) => o.startsWith('https://'))).toBe(true)
    expect(allowedApiOrigins(false)).toContain(TEST_API_ORIGIN)
    // O servidor falso é loopback: nunca sai da máquina de quem roda os testes.
    expect(TEST_API_ORIGIN).toBe('http://127.0.0.1/*')
    // A origem do provedor é SEMPRE opcional (pedida na hora de ligar); o loopback dos testes é
    // que entra no manifesto do build de desenvolvimento, e nada entra no da loja.
    expect(optionalApiOrigins()).toEqual(['https://api.openai.com/*'])
    expect(declaredApiOrigins(true)).toEqual([])
    expect(declaredApiOrigins(false)).toEqual([TEST_API_ORIGIN])
  })

  it('um endpoint configurado para o servidor falso vale no desenvolvimento (porta qualquer)', () => {
    // Os padrões de host do Chrome ignoram a porta, então um padrão só serve a qualquer porta.
    expect(originPatternOf('http://127.0.0.1:8123/v1/audio/transcriptions')).toBe('http://127.0.0.1/*')
    expect(normalizeApiTranscription({ endpoint: 'http://127.0.0.1:8123/v1/audio/transcriptions' }).endpoint).toBe('http://127.0.0.1:8123/v1/audio/transcriptions')
    // Um endereço fora das origens declaradas não é guardado.
    expect(normalizeApiTranscription({ endpoint: 'https://api.mau.example/v1' }).endpoint).toBe('')
  })

  it('o provedor desconhecido cai no padrão', () => {
    expect(providerOf('nao-existe').id).toBe(API_PROVIDERS[0].id)
  })
})

describe('a chave só aparece no cabeçalho Authorization', () => {
  const KEY = 'sk-proj-chave-falsa-de-teste-0000'

  it('o cabeçalho é o único lugar com a chave: nem o multipart, nem a URL, nem o modelo', () => {
    const c = cfg({ ativa: true, idioma: 'pt' })
    expect(authHeaders(KEY)).toEqual({ Authorization: `Bearer ${KEY}` })
    const fields = multipartFields(c)
    expect(JSON.stringify(fields)).not.toContain(KEY)
    expect(endpointOf(c)).not.toContain(KEY)
    expect(JSON.stringify(c)).not.toContain(KEY)
    // A chave não entra em query string: um proxy registraria a URL inteira.
    expect(endpointOf(c)).not.toMatch(/[?&]/)
  })

  it('o multipart pede os tempos de cada trecho e o idioma só quando não é automático', () => {
    expect(multipartFields(cfg())).toEqual([
      ['model', 'whisper-1'],
      ['response_format', 'verbose_json'],
      ['timestamp_granularities[]', 'segment'],
    ])
    expect(multipartFields(cfg({ idioma: 'pt' }))).toContainEqual(['language', 'pt'])
    expect(API_UPLOAD_FILENAME).toBe('audio.webm')
  })

  it('a dica da tela nunca mostra a chave inteira', () => {
    const hint = apiKeyHint(KEY)
    expect(hint).not.toContain(KEY)
    expect(hint).toBe('••••0000')
    expect(hint.includes(KEY.slice(0, 8))).toBe(false)
    expect(apiKeyHint('')).toBe('')
    expect(API_KEY_MAX).toBeGreaterThan(50)
  })
})

describe('retenção do áudio guardado', () => {
  const job = (over: Partial<{ sessionId: string; bytes: number; createdAt: number; attempts: number }> = {}) => ({
    sessionId: 's',
    bytes: 1024,
    createdAt: 1000,
    attempts: 0,
    ...over,
  })

  it('os três limites existem com nome e valor', () => {
    expect(API_RETENTION.maxAttempts).toBe(5)
    expect(API_RETENTION.maxAgeMs).toBe(24 * 60 * 60_000)
    expect(API_RETENTION.maxTotalBytes).toBe(300 * 1024 * 1024)
  })

  it('tentativas: na última que falhar, o áudio sai', () => {
    const now = 2000
    const r = applyRetention([job({ sessionId: 'a', attempts: API_RETENTION.maxAttempts - 1 }), job({ sessionId: 'b', attempts: API_RETENTION.maxAttempts })], now)
    expect(r.keep.map((j) => j.sessionId)).toEqual(['a'])
    expect(r.drop).toEqual([{ job: expect.objectContaining({ sessionId: 'b' }), reason: 'tentativas' }])
  })

  it('idade: passou do prazo, o áudio sai (nada fica guardado para sempre)', () => {
    const now = 1_000_000_000
    const velha = job({ sessionId: 'velha', createdAt: now - API_RETENTION.maxAgeMs - 1 })
    const nova = job({ sessionId: 'nova', createdAt: now - API_RETENTION.maxAgeMs + 1 })
    const r = applyRetention([velha, nova], now)
    expect(r.keep.map((j) => j.sessionId)).toEqual(['nova'])
    expect(r.drop).toEqual([{ job: velha, reason: 'idade' }])
  })

  it('tamanho total: estourando, a mais antiga sai e a que acabou de gravar fica', () => {
    const now = 10_000
    const metade = Math.ceil(API_RETENTION.maxTotalBytes * 0.6)
    const antiga = job({ sessionId: 'antiga', bytes: metade, createdAt: 1000 })
    const recente = job({ sessionId: 'recente', bytes: metade, createdAt: 9000 })
    const r = applyRetention([antiga, recente], now)
    expect(r.keep.map((j) => j.sessionId)).toEqual(['recente'])
    expect(r.drop).toEqual([{ job: antiga, reason: 'espaco' }])
  })

  it('dentro dos limites, tudo fica, em ordem de gravação', () => {
    const r = applyRetention([job({ sessionId: 'b', createdAt: 2000 }), job({ sessionId: 'a', createdAt: 1000 })], 3000)
    expect(r.keep.map((j) => j.sessionId)).toEqual(['a', 'b'])
    expect(r.drop).toEqual([])
  })

  it('a espera entre as tentativas cresce e para no maior valor', () => {
    expect(backoffFor(0)).toBe(0)
    expect(backoffFor(1)).toBe(API_RETENTION.backoffMs[0])
    expect(backoffFor(2)).toBe(API_RETENTION.backoffMs[1])
    expect(backoffFor(99)).toBe(API_RETENTION.backoffMs.at(-1))
    const waits = [1, 2, 3, 4, 5].map(backoffFor)
    expect(waits).toEqual([...waits].sort((a, b) => a - b))
  })
})

describe('classificação dos erros', () => {
  it('401 e 403 são configuração e NÃO repetem sozinhos', () => {
    expect(classifyApiError(401)).toBe('config')
    expect(classifyApiError(403)).toBe('config')
    expect(retriesAlone('config')).toBe(false)
  })

  it('429 e 5xx repetem com espera; erro de rede repete', () => {
    expect(classifyApiError(429)).toBe('limite')
    expect(classifyApiError(500)).toBe('servidor')
    expect(classifyApiError(503)).toBe('servidor')
    expect(classifyApiError(null)).toBe('rede')
    for (const k of ['limite', 'servidor', 'rede'] as const) expect(retriesAlone(k), k).toBe(true)
  })

  it('áudio grande e pedido recusado não repetem', () => {
    expect(classifyApiError(413)).toBe('grande')
    expect(classifyApiError(400)).toBe('pedido')
    expect(classifyApiError(404)).toBe('pedido')
    expect(retriesAlone('grande')).toBe(false)
    expect(retriesAlone('pedido')).toBe(false)
  })
})

describe('resposta do provedor', () => {
  it('lê os trechos com tempo do verbose_json e descarta os vazios', () => {
    const json = {
      language: 'portuguese',
      segments: [
        { start: 0, end: 2.5, text: ' primeira frase. ' },
        { start: 2.6, end: 4, text: '   ' },
        { start: 4, end: 6, text: 'segunda frase.' },
        { start: 'x', end: 7, text: 'sem tempo' },
      ],
    }
    expect(segmentsFromApiJson(json)).toEqual([
      { start: 0, end: 2.5, text: 'primeira frase.' },
      { start: 4, end: 6, text: 'segunda frase.' },
    ])
    expect(languageFromApiJson(json, cfg())).toBe('portuguese')
    expect(languageFromApiJson({}, cfg({ idioma: 'pt' }))).toBe('pt')
  })

  it('uma resposta só com texto vira um trecho sem tempo (não perde a fala)', () => {
    expect(segmentsFromApiJson({ text: 'uma frase' })).toEqual([{ start: 0, end: 0, text: 'uma frase' }])
    expect(segmentsFromApiJson(null)).toEqual([])
    expect(segmentsFromApiJson({ segments: 'nada' })).toEqual([])
  })

  it('o custo por hora sai dos dados do provedor (para a tela dizer em uma frase)', () => {
    expect(dollarsPerHour(cfg())).toBeCloseTo(0.36, 2)
  })
})
