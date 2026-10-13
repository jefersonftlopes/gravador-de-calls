import { describe, expect, it } from 'vitest'
import type { TranscriptionUiState, VigiaStatus } from '../shared/protocol'
import { audioStatus, formatDuration, formatElapsed, shortPath, transcriptionNotice, transcriptionOf, vigiaLine } from './format'

const status = (over: Partial<VigiaStatus> = {}): VigiaStatus => ({
  platform: 'teams',
  naCall: true,
  n: 5,
  fonte: 'painel People',
  pico: 8,
  limite: 2,
  armado: true,
  seguidas: 0,
  saindo: false,
  tentativas: 0,
  ...over,
})

describe('popup: tempo', () => {
  it('relógio do tempo decorrido', () => {
    expect(formatElapsed(7_400)).toBe('0:07')
    expect(formatElapsed(754_000)).toBe('12:34')
    expect(formatElapsed(3_723_000)).toBe('1:02:03')
    expect(formatElapsed(-5)).toBe('0:00')
  })

  it('duração das últimas gravações', () => {
    expect(formatDuration(45)).toBe('45 s')
    expect(formatDuration(720)).toBe('12 min')
    expect(formatDuration(3900)).toBe('1 h 05 min')
  })
})

describe('popup: está chegando áudio agora (AC11)', () => {
  const base = { startedAt: 0, hasAudio: true, audioNow: true, silentForMs: 300 }
  it('fala recente', () => {
    expect(audioStatus(base, 30_000)).toEqual({ text: 'chegando áudio', tone: 'ok' })
  })
  it('já teve fala, mas parou', () => {
    expect(audioStatus({ ...base, audioNow: false, silentForMs: 25_000 }, 90_000)).toEqual({ text: 'sem áudio há 0:25', tone: 'aviso' })
  })
  it('nunca teve fala: aviso antes de 60 s e alerta com o modo aba depois', () => {
    const never = { ...base, hasAudio: false, audioNow: false, silentForMs: null }
    expect(audioStatus(never, 59_999).tone).toBe('aviso')
    expect(audioStatus(never, 60_000)).toEqual({ text: 'nenhum áudio desde o início: experimente o modo aba', tone: 'alerta' })
  })
})

describe('popup: linha do vigia (Emenda 16)', () => {
  it('com limite, sem queda', () => {
    expect(vigiaLine(status(), { confirmacoes: 4 })).toBe('5 na call · pico 8 · sai com 2 ou menos')
  })
  it('queda em andamento', () => {
    expect(vigiaLine(status({ n: 2, seguidas: 2 }), { confirmacoes: 4 })).toBe('2 na call · pico 8 · sai com 2 ou menos · confirmando 2/4')
  })
  it('limite 1: só sozinho', () => {
    expect(vigiaLine(status({ n: 3, pico: 3, limite: 1 }), { confirmacoes: 4 })).toBe('3 na call · pico 3 · sai se você ficar sozinho')
  })
  it('desarmado (pico abaixo de 2)', () => {
    expect(vigiaLine(status({ n: 1, pico: 1, limite: 1, armado: false }), { confirmacoes: 4 })).toBe('1 na call · pico 1 · sai se você ficar sozinho (espera alguém entrar)')
  })
  it('sem contagem e fora da call', () => {
    expect(vigiaLine(status({ n: null }), { confirmacoes: 4 })).toBe('sem contagem agora · pico 8')
    expect(vigiaLine(status({ naCall: false }), { confirmacoes: 4 })).toBe('fora da call')
  })
})

describe('popup: caminho', () => {
  it('encurta a pasta pessoal', () => {
    expect(shortPath('/Users/alex/Documents/Gravações de calls')).toBe('~/Documents/Gravações de calls')
    expect(shortPath('/Volumes/Disco/calls')).toBe('/Volumes/Disco/calls')
  })
})

describe('popup: transcrição das últimas gravações (Emenda 13)', () => {
  const st = (porSessao: TranscriptionUiState['porSessao'], ativa = true): TranscriptionUiState => ({ suportada: true, ativa, disponivel: true, motivo: null, porSessao })
  it('salva pelo helper: o estado do info.json daquela sessão', () => {
    const t = st({ s1: { status: 'pronta', arquivo: '/r/a/transcricao.md' }, s2: { status: 'falhou', erro: 'modelo não encontrado' } })
    expect(transcriptionOf({ sessionId: 's1', sink: 'host' }, t)).toEqual({ status: 'pronta', arquivo: '/r/a/transcricao.md' })
    expect(transcriptionOf({ sessionId: 's2', sink: 'host' }, t)).toEqual({ status: 'falhou', erro: 'modelo não encontrado' })
    expect(transcriptionOf({ sessionId: 'antiga', sink: 'host' }, t)).toBeNull()
  })
  it('salva em Downloads com o helper presente: avisa que precisa do helper, menos quando a transcrição está desligada', () => {
    expect(transcriptionOf({ sessionId: 's1', sink: 'downloads' }, st({}))).toBe('precisa-helper')
    expect(transcriptionOf({ sessionId: 's1', sink: 'downloads' }, st({}, false))).toBeNull()
  })
  it('sem helper nenhum (o uso normal da loja, Emenda 15): nada em cada gravação, a transcrição é recurso avançado', () => {
    expect(transcriptionOf({ sessionId: 's1', sink: 'downloads' }, null)).toBeNull()
  })
  it('aviso geral: helper sem transcrição, ou ligada sem o motor; nada quando está tudo certo, desligada ou sem helper', () => {
    expect(transcriptionNotice(null)).toBeNull()
    expect(transcriptionNotice(st({}))).toBeNull()
    expect(transcriptionNotice({ ...st({}, false), disponivel: false, motivo: 'whisper-cli não encontrado' })).toBeNull()
    expect(transcriptionNotice({ suportada: false, ativa: false, disponivel: false, motivo: 'o helper instalado é de uma versão sem transcrição: rode npm run instalar de novo', porSessao: {} })).toBe(
      'Sem transcrição: o helper instalado é de uma versão sem transcrição: rode npm run instalar de novo.',
    )
    expect(transcriptionNotice({ ...st({}), disponivel: false, motivo: 'modelo não encontrado: /m.bin' })).toBe(
      'Transcrição indisponível: modelo não encontrado: /m.bin. As calls ficam na fila até isso ser resolvido.',
    )
  })
})

describe('transcrição por API no popup (Emenda 21)', () => {
  const base = { suportada: true, ativa: true, disponivel: true, motivo: null } as const

  it('uma gravação em Downloads transcrita pela API mostra o estado dela, não "precisa do helper"', () => {
    const tr = { ...base, motor: 'api' as const, porSessao: { s1: { status: 'pronta' as const } } }
    expect(transcriptionOf({ sessionId: 's1', sink: 'downloads' }, tr)).toEqual({ status: 'pronta' })
    // Uma gravação de antes de o motor ser ligado não tem estado: nada é dito dela.
    expect(transcriptionOf({ sessionId: 's2', sink: 'downloads' }, tr)).toBeNull()
  })

  it('com o motor local ligado, a gravação em Downloads continua dizendo que precisa do helper', () => {
    const tr = { ...base, porSessao: {} }
    expect(transcriptionOf({ sessionId: 's1', sink: 'downloads' }, tr)).toBe('precisa-helper')
  })

  it('o aviso do rodapé não fala do motor local quando quem transcreve é a API', () => {
    expect(transcriptionNotice({ ...base, motor: 'api', ativa: true, disponivel: false, motivo: 'modelo não encontrado', porSessao: {} })).toBeNull()
    // Sem o motor por API, o aviso de sempre continua.
    expect(transcriptionNotice({ ...base, disponivel: false, motivo: 'modelo não encontrado', porSessao: {} })).toContain('modelo não encontrado')
  })
})
