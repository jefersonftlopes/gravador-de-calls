import { describe, expect, it } from 'vitest'
import { useLocale } from '../../tests/helpers/i18n-setup'
import { DEFAULT_SETTINGS } from '../shared/settings'
import { profileFormResolver, transcriptionFormResolver, type ProfileForm } from './form'

// O idioma (Emenda 19) e a transcrição por API (Emenda 21) não são do formulário: cada um é
// salvo na hora em que muda.
const { profileId: _id, language: _language, apiTranscription: _api, ...defaults } = DEFAULT_SETTINGS

async function resolve(values: ProfileForm) {
  return profileFormResolver(values, undefined, { fields: {}, shouldUseNativeValidation: false })
}

describe('formulário das configurações', () => {
  it('aceita os padrões e tira os espaços do nome do perfil', async () => {
    const r = await resolve({ ...defaults, profileLabel: '  Trabalho  ' })
    expect(r.errors).toEqual({})
    expect(r.values).toEqual({ ...defaults, profileLabel: 'Trabalho' })
  })

  it('erros em português, aninhados como o react-hook-form espera', async () => {
    const r = await resolve({
      ...defaults,
      minSeconds: Number.NaN,
      profileLabel: 'x'.repeat(61),
      vigia: { ...defaults.vigia, intervaloSeg: 0, confirmacoes: 2.5, fracao: 2 },
    })
    expect(r.values).toEqual({})
    const e = r.errors as Record<string, any>
    expect(e.minSeconds.message).toBe('digite um número')
    expect(e.profileLabel.message).toBe('no máximo 60 caracteres')
    expect(e.vigia.intervaloSeg.message).toBe('no mínimo 1')
    expect(e.vigia.confirmacoes.message).toBe('use um número inteiro')
    expect(e.vigia.fracao.message).toBe('no máximo 1')
  })
})

describe('regra de saída que sairia de uma call no pico (Emenda 10)', () => {
  it('pico mínimo da queda igual ao mínimo de pessoas: recusado (uma call de 2 sairia com as 2 presentes)', async () => {
    const r = await resolve({ ...defaults, vigia: { ...defaults.vigia, picoParaQueda: 2 } })
    expect(r.values).toEqual({})
    expect((r.errors as Record<string, any>).vigia.picoParaQueda.message).toMatch(/maior que/)
  })

  it('fração 1: recusada (a call sairia sem ninguém ter saído)', async () => {
    const r = await resolve({ ...defaults, vigia: { ...defaults.vigia, fracao: 1 } })
    expect((r.errors as Record<string, any>).vigia.fracao.message).toMatch(/menor que 1/)
  })

  it('mínimo maior que o pico mínimo: recusado', async () => {
    const r = await resolve({ ...defaults, vigia: { ...defaults.vigia, minimo: 5, picoParaQueda: 4 } })
    expect((r.errors as Record<string, any>).vigia.picoParaQueda.message).toMatch(/maior que/)
  })
})

describe('quando sair (Emenda 16)', () => {
  it('aceita os três modos', async () => {
    for (const modo of ['sozinho', 'proporcao', 'quantidade'] as const) {
      const r = await resolve({ ...defaults, vigia: { ...defaults.vigia, modo, quantidade: 5 } })
      expect(r.errors, modo).toEqual({})
      expect((r.values as ProfileForm).vigia.modo).toBe(modo)
    }
  })

  it('quantidade fora de 1 a 50 ou vazia: uma frase só, em palavras simples', async () => {
    for (const quantidade of [0, 51, 2.5, Number.NaN]) {
      const r = await resolve({ ...defaults, vigia: { ...defaults.vigia, modo: 'quantidade', quantidade } })
      expect((r.errors as Record<string, any>).vigia.quantidade.message, String(quantidade)).toBe('escolha de 1 a 50 pessoas')
    }
  })

  it('a mensagem do pico fala com os rótulos de "Ajustes finos"', async () => {
    const r = await resolve({ ...defaults, vigia: { ...defaults.vigia, minimo: 4, picoParaQueda: 4 } })
    expect((r.errors as Record<string, any>).vigia.picoParaQueda.message).toBe('use um número maior que o de "sair também quando restarem até" (4); senão o vigia sairia de uma call cheia')
  })
})

describe('formulário da transcrição (Emenda 13)', () => {
  const base = { ativa: true, motor: 'whisper-cpp', modelo: '', idioma: 'auto', whisperCli: '', ffmpeg: '' }
  const resolveT = (v: typeof base) => transcriptionFormResolver(v, undefined, { fields: {}, shouldUseNativeValidation: false })
  it('aceita modelo vazio (descobrir sozinho) e tira os espaços dos caminhos', async () => {
    expect((await resolveT({ ...base, modelo: '  ~/modelos/ggml-small.bin ' })).values).toEqual({ ...base, modelo: '~/modelos/ggml-small.bin' })
    expect((await resolveT(base)).errors).toEqual({})
  })
  it('recusa caminho relativo e idioma fora do formato, com a mensagem em português', async () => {
    const r = await resolveT({ ...base, modelo: 'ggml-small.bin', idioma: 'Português', ffmpeg: 'bin/ffmpeg' })
    const e = r.errors as Record<string, any>
    expect(e.modelo.message).toBe('use um caminho absoluto ou começando com ~')
    expect(e.ffmpeg.message).toBe('use um caminho absoluto ou começando com ~')
    expect(e.idioma.message).toBe('use auto ou um código de idioma como pt ou en')
  })
})

describe('mensagens do formulário em inglês (Emenda 15)', () => {
  it('as do zod e as próprias do schema (que o SW escreve em português) saem no idioma da interface', async () => {
    useLocale('en')
    try {
      const r = await resolve({ ...defaults, minSeconds: Number.NaN, profileLabel: 'x'.repeat(61), vigia: { ...defaults.vigia, confirmacoes: 2.5 } })
      const e = r.errors as Record<string, any>
      expect(e.minSeconds.message).toBe('type a number')
      expect(e.profileLabel.message).toBe('at most 60 characters')
      expect(e.vigia.confirmacoes.message).toBe('use a whole number')
      // As regras da combinação (superRefine) só rodam com os campos válidos.
      const c = (await resolve({ ...defaults, vigia: { ...defaults.vigia, fracao: 1, picoParaQueda: 2 } })).errors as Record<string, any>
      expect(c.vigia.fracao.message).toBe('use a fraction below 1 (with 1, it would leave with nobody gone)')
      expect(c.vigia.picoParaQueda.message).toBe('use a number larger than "also leave when at most this many remain" (2); otherwise it would leave a full call')
      const q = (await resolve({ ...defaults, vigia: { ...defaults.vigia, modo: 'quantidade', quantidade: 0 } })).errors as Record<string, any>
      expect(q.vigia.quantidade.message).toBe('choose from 1 to 50 people')
      const base = { ativa: true, motor: 'whisper-cpp', modelo: 'rel.bin', idioma: 'Português', whisperCli: '', ffmpeg: '' }
      const t = (await transcriptionFormResolver(base, undefined, { fields: {}, shouldUseNativeValidation: false })).errors as Record<string, any>
      expect(t.modelo.message).toBe('use an absolute path or one starting with ~')
      expect(t.idioma.message).toBe('use auto or a language code such as pt or en')
    } finally {
      useLocale('pt_BR')
    }
  })
})
