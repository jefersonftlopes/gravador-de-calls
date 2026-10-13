// Motivos do helper traduzidos na extensão (Emenda 15). Em português a tradução tem de sair
// idêntica ao que o helper escreve (senão a tela mudaria para quem já usa); em inglês, o motivo
// conhecido é traduzido e o caminho, o código e o detalhe passam inteiros.
//
// Emenda 19: os motivos que o próprio SW escreve (errHelperTimeout, trOldHelper...) ficam guardados
// já traduzidos no idioma da hora (o status do helper, o lastError de uma gravação não salva, o erro
// de uma ação); a tela os reconhece nas duas línguas e os mostra no idioma que vale agora.
import { afterEach, describe, expect, it } from 'vitest'
import { localeMessages } from '../../tests/helpers/i18n-fake'
import { useLocale } from '../../tests/helpers/i18n-setup'
// @ts-expect-error módulo .mjs sem tipos
import { friendlyFsError } from '../../host/gravador-host.mjs'
import { helperReason } from './helper-reasons'
import { setLanguage, tIn, type MessageKey } from './i18n'

afterEach(() => {
  useLocale('pt_BR')
  setLanguage('auto')
})

const fsErr = (code: string, abs: string) => (friendlyFsError(Object.assign(new Error('x'), { code }), abs) as Error).message

/** Motivos como o helper escreve hoje (host/gravador-host.mjs e host/transcricao.mjs). */
const HELPER_TEXTS = [
  fsErr('EACCES', '/Users/x/Calls'),
  fsErr('EPERM', '/Users/x/Calls'),
  fsErr('ENOTDIR', '/Users/x/arquivo/Calls'),
  fsErr('EROFS', '/Volumes/CD/Calls'),
  fsErr('ENOSPC', '/Users/x/Calls'),
  fsErr('ENOENT', '/Volumes/Externo/Calls'),
  fsErr('ENOENT', '/Users/x/nao/da'),
  'whisper-cli não encontrado em /opt/x/whisper-cli (confira o caminho nas configurações)',
  'ffmpeg não encontrado (instale com: brew install ffmpeg, ou informe o caminho nas configurações)',
  'whisper-cli não encontrado (instale com: brew install whisper-cpp, ou informe o caminho nas configurações)',
  'ffmpeg não encontrado ou sem permissão de execução: /opt/ffmpeg',
  'modelo não encontrado: baixe um modelo do whisper.cpp (ggml-tiny, base, small, medium ou large, como ggml-small.bin) para ~/.cache/whisper-models ou informe o caminho nas configurações',
  'modelo não encontrado: /m/ggml-small.bin',
  'o ffmpeg não conseguiu converter o áudio',
  'o ffmpeg não conseguiu converter o áudio: Invalid data found',
  'o whisper-cli falhou (código 3): failed to load model',
  'o whisper-cli falhou (código 1)',
  'a transcrição saiu da fila sem terminar (veja o log do helper)',
  'áudio não encontrado',
  'modelo: use um caminho absoluto ou começando com ~',
  // Emenda 19: os que faltavam no worker da transcrição (host/transcricao.mjs).
  'o ffmpeg passou do tempo limite convertendo o áudio',
  'o whisper-cli passou do tempo limite',
  'o whisper-cli terminou sem escrever o resultado (JSON)',
  'a transcrição foi interrompida 3 vezes no meio; o áudio continua na pasta',
  'áudio não encontrado: audio-aba.webm',
  'motor de transcrição indisponível',
  'motor desconhecido: nuvem',
]

describe('helperReason', () => {
  it('em português, cada motivo conhecido sai igual ao texto do helper', () => {
    for (const text of HELPER_TEXTS) expect(helperReason(text)).toBe(text)
  })

  it('em inglês, todo motivo conhecido é traduzido (nenhum fica em português)', () => {
    useLocale('en')
    for (const text of HELPER_TEXTS) {
      const out = helperReason(text)
      expect(out, text).not.toBe(text)
      // "modelo:" no início é o nome do campo da configuração (identificador), não texto.
      expect(out, text).not.toMatch(/não|ção|permissão|caminho|encontrado|configurações/)
    }
  })

  it('em inglês, os valores variáveis passam inteiros', () => {
    useLocale('en')
    expect(helperReason(fsErr('EACCES', '/Users/x/Calls'))).toBe(
      'no permission to write there; on macOS, check System Settings > Privacy & Security > Files and Folders (the request comes from Google Chrome) (EACCES): /Users/x/Calls',
    )
    expect(helperReason(fsErr('ENOENT', '/Volumes/Externo/Calls'))).toBe('the disk is not connected (ENOENT): /Volumes/Externo/Calls')
    expect(helperReason('o whisper-cli falhou (código 3): failed to load model')).toBe('whisper-cli failed (code 3): failed to load model')
    expect(helperReason('ffmpeg não encontrado (instale com: brew install ffmpeg, ou informe o caminho nas configurações)')).toBe(
      'ffmpeg not found (install it with: brew install ffmpeg, or set the path in the settings)',
    )
    expect(helperReason('modelo não encontrado: /m/ggml-small.bin')).toBe('model not found: /m/ggml-small.bin')
  })

  it('em inglês, os novos do worker da transcrição levam o número e o arquivo inteiros', () => {
    useLocale('en')
    expect(helperReason('a transcrição foi interrompida 3 vezes no meio; o áudio continua na pasta')).toBe(
      'the transcription was interrupted 3 times midway; the audio is still in the folder',
    )
    expect(helperReason('áudio não encontrado: audio-aba.webm')).toBe('audio not found: audio-aba.webm')
    expect(helperReason('motor desconhecido: nuvem')).toBe('unknown engine: nuvem')
  })

  it('um motivo desconhecido aparece como veio', () => {
    useLocale('en')
    expect(helperReason('algo novo do helper')).toBe('algo novo do helper')
    expect(helperReason('')).toBe('')
    expect(helperReason(null)).toBe('')
  })
})

describe('motivos que o SW escreve, guardados no idioma da hora (Emenda 19)', () => {
  const en = localeMessages('en')
  /** As mensagens de erro do SW (err*) e o helper sem transcrição, com valores de exemplo. */
  const SW_KEYS = (Object.keys(en) as MessageKey[]).filter((k) => k.startsWith('err') || k === 'trOldHelper')
  const sample = (key: MessageKey, locale: 'pt_BR' | 'en') => tIn(locale, key, 'ping', 5000, '/Users/x/Calls')

  it('no idioma em que foram escritos, saem iguais, em toda chave', () => {
    expect(SW_KEYS.length).toBeGreaterThan(20)
    for (const key of SW_KEYS) expect(helperReason(sample(key, 'pt_BR')), key).toBe(sample(key, 'pt_BR'))
    setLanguage('en')
    for (const key of SW_KEYS) expect(helperReason(sample(key, 'en')), key).toBe(sample(key, 'en'))
  })

  it('trocado o idioma, o motivo escrito no outro sai no idioma novo, com os valores inteiros, em toda chave', () => {
    setLanguage('en')
    for (const key of SW_KEYS) expect(helperReason(sample(key, 'pt_BR')), key).toBe(sample(key, 'en'))
    setLanguage('pt_BR')
    for (const key of SW_KEYS) expect(helperReason(sample(key, 'en')), key).toBe(sample(key, 'pt_BR'))
  })

  it('os casos medidos na verificação: helper sem resposta, helper sem transcrição, gravação não salva', () => {
    setLanguage('en')
    expect(helperReason('helper não respondeu a ping em 5000 ms')).toBe('helper did not answer ping within 5000 ms')
    expect(helperReason('helper desconectou')).toBe('helper disconnected')
    expect(helperReason('o helper instalado é de uma versão sem transcrição: rode npm run instalar de novo')).toBe(
      'the installed helper is from a version without transcription: run npm run instalar again',
    )
    expect(helperReason('sem permissão para gravar em /Volumes/Externo/Calls')).toBe('no permission to write to /Volumes/Externo/Calls')
    // Um valor que também é motivo conhecido troca junto.
    expect(helperReason('download interrompido: sem motivo')).toBe('download interrupted: no reason given')
    // O motivo do helper dentro do valor também.
    expect(helperReason('offscreen não montou o arquivo (audio.webm): áudio não encontrado')).toBe(
      'the offscreen document could not build the file (audio.webm): audio not found',
    )
  })

  it('texto que só parece com um motivo fica como veio', () => {
    setLanguage('en')
    expect(helperReason('helper não respondeu')).toBe('helper não respondeu')
    expect(helperReason('xhelper desconectou')).toBe('xhelper desconectou')
    expect(helperReason('helper desconectou agora')).toBe('helper desconectou agora')
  })
})
