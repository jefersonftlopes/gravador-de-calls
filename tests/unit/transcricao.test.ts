// Transcrição (Emenda 13), partes puras e descoberta: texto do transcricao.md e do .srt a partir
// do JSON do whisper-cli, junção de segmentos em parágrafos, tempo de call longa, transcrição
// vazia, descoberta de programas e modelos (com binários falsos em pastas temporárias) e a
// validação da configuração.
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  applyTranscriptionPatch,
  buildMarkdown,
  buildSrt,
  createEngine,
  findExecutable,
  findModel,
  formatClock,
  formatDuration,
  formatLocalStart,
  markdownLanguage,
  mergeSegments,
  normalizeTranscriptionConfig,
  rankModel,
  segmentsFromWhisperJson,
  silencesFromFfmpeg,
  speechText,
  dropInventedSegments,
  transcriptStem,
  // @ts-expect-error módulo .mjs sem tipos
} from '../../host/transcricao.mjs'

const base = mkdtempSync(join(tmpdir(), 'gravador-transcricao-'))
afterAll(() => rmSync(base, { recursive: true, force: true }))

type Seg = { start: number; end: number; text: string }

const whisperJson = (segs: Array<[number, number, string]>) => ({
  result: { language: 'pt' },
  transcription: segs.map(([from, to, text]) => ({ offsets: { from, to }, text })),
})

const INFO = {
  titulo: 'Daily do time',
  plataforma: 'meet',
  inicio: '2026-10-06T14:30:05-03:00',
  duracaoSegundos: 1956,
  participantes: ['Ana Souza', 'Bruno Lima'],
  perfil: 'Trabalho',
}

describe('texto da transcrição', () => {
  it('tira as marcas que o whisper escreve no lugar de fala: [Música] (o silêncio em português), (aplausos), ♪', () => {
    const segs = segmentsFromWhisperJson(
      whisperJson([
        [0, 10000, ' [Música]'],
        [10000, 11000, ' [ Silêncio ]'],
        [11000, 12000, ' (música)'],
        [12000, 13000, ' ♪ ♪'],
        [13000, 14000, ' *risos*'],
        [14000, 15000, ' [MUSIC] Bom dia. [Aplausos]'],
        [15000, 16000, ' ...'],
        [16000, 17000, ' Custou (uns) 10 reais.'],
      ]),
    )
    expect(segs).toEqual([
      { start: 14, end: 15, text: 'Bom dia.' },
      { start: 16, end: 17, text: 'Custou (uns) 10 reais.' },
    ])
    expect(speechText(' [Música] ')).toBe('')
    // Gravação só de silêncio: o whisper real escreve "[Música]"; o .md diz que não houve fala.
    const md = buildMarkdown({ info: INFO, segments: segmentsFromWhisperJson(whisperJson([[0, 10000, ' [Música]']])), language: 'pt', motor: 'whisper-cpp', model: 'm.bin' })
    expect(md).toContain('_Nenhuma fala reconhecida na gravação._')
    expect(md).not.toContain('[00:00]')
  })

  it('pausas medidas pelo ffmpeg (silencedetect) quebram o parágrafo mesmo com os segmentos do whisper colados', () => {
    const stderr = [
      'Input #0, matroska,webm, from audio.webm:',
      '[silencedetect @ 0x6000] silence_start: 4.41',
      '[silencedetect @ 0x6000] silence_end: 8.41 | silence_duration: 4',
      '[silencedetect @ 0x6000] silence_start: 20.5',
      '[silencedetect @ 0x6000] silence_end: 21.1 | silence_duration: 0.6',
      '[silencedetect @ 0x6000] silence_start: 30',
    ].join('\n')
    const pauses = silencesFromFfmpeg(stderr)
    expect(pauses).toEqual([
      { start: 4.41, end: 8.41 },
      { start: 20.5, end: 21.1 },
      { start: 30, end: Number.POSITIVE_INFINITY },
    ])
    // Como o whisper.cpp 1.9 devolve (medido com a fala do say e 4 s de silêncio no meio).
    const segs: Seg[] = [
      { start: 0, end: 8.8, text: 'Bom dia, vamos revisar os indicadores de vendas do trimestre.' },
      { start: 8.8, end: 13.16, text: 'Depois do silêncio, falamos sobre contratação de novos analistas.' },
      { start: 13.16, end: 22, text: 'Uma pausa curta não quebra.' },
    ]
    expect(mergeSegments(segs).map((p: Seg) => p.start)).toEqual([0])
    expect(mergeSegments(segs, undefined, pauses).map((p: Seg) => p.start)).toEqual([0, 8.8])
    // Silêncio no começo do segmento, com a fala depois dele no mesmo segmento: não é pausa entre os dois.
    expect(mergeSegments([{ start: 0, end: 6, text: 'Oi.' }, { start: 6, end: 8, text: 'Tudo bem?' }], undefined, [{ start: 0, end: 3 }]).length).toBe(1)
    const md = buildMarkdown({ info: INFO, segments: segs, language: 'pt', motor: 'whisper-cpp', model: 'm.bin', pauses })
    expect(md).toContain('[00:00] Bom dia, vamos revisar os indicadores de vendas do trimestre.\n\n[00:08] Depois do silêncio')
  })

  it('segmento curto inventado em cima de silêncio medido sai; fala de verdade fica, mesmo esticada por cima do silêncio', () => {
    // Medido com uma gravação muda de 10 s: o whisper small com idioma auto escreveu "you".
    const muda = silencesFromFfmpeg('[silencedetect @ 0x1] silence_start: 0\n[silencedetect @ 0x1] silence_end: 10 | silence_duration: 10')
    expect(dropInventedSegments([{ start: 0, end: 2.06, text: 'you' }], muda)).toEqual([])
    // Sem o silence_end (ffmpeg antigo): o silêncio vai até o fim.
    expect(silencesFromFfmpeg('silence_start: 3.5')).toEqual([{ start: 3.5, end: Number.POSITIVE_INFINITY }])
    const fala = [
      { start: 0, end: 8.8, text: 'Bom dia, vamos revisar os indicadores de vendas do trimestre.' },
      { start: 8.8, end: 13.16, text: 'Depois do silêncio, falamos sobre contratação.' },
      { start: 20, end: 21, text: 'Ok.' },
      { start: 30, end: 33, text: 'Uma frase longa de verdade dita bem baixinho no meio do silêncio.' },
    ]
    const pausas = [
      { start: 4.41, end: 8.41 },
      { start: 13.2, end: 40 },
    ]
    // "Ok." dentro do silêncio cai; a frase longa (mais de 6 palavras) fica; as faladas ficam.
    expect(dropInventedSegments(fala, pausas).map((s: Seg) => s.text)).toEqual([fala[0].text, fala[1].text, fala[3].text])
    expect(dropInventedSegments(fala, [])).toEqual(fala)
  })

  it('nome da transcrição de cada áudio da pasta', () => {
    expect(transcriptStem('audio.webm')).toBe('transcricao')
    expect(transcriptStem('audio-aba.webm')).toBe('transcricao-aba')
    expect(transcriptStem('audio-aba (2).webm')).toBe('transcricao-aba-2')
  })

  it('lê os segmentos do JSON do whisper-cli (offsets em ms), sem vazios nem [BLANK_AUDIO]', () => {
    const segs = segmentsFromWhisperJson(
      whisperJson([
        [0, 2500, ' Bom dia a todos.'],
        [2500, 3000, '   '],
        [3000, 5000, ' [BLANK_AUDIO]'],
        [5000, 7200, '  Vamos   começar.'],
      ]),
    )
    expect(segs).toEqual([
      { start: 0, end: 2.5, text: 'Bom dia a todos.' },
      { start: 5, end: 7.2, text: 'Vamos começar.' },
    ])
  })

  it('usa os timestamps em texto quando não há offsets', () => {
    expect(segmentsFromWhisperJson({ transcription: [{ timestamps: { from: '00:01:02,500', to: '01:00:00,000' }, text: 'oi' }] })).toEqual([{ start: 62.5, end: 3600, text: 'oi' }])
  })

  it('junta pedaços curtos e seguidos num parágrafo e quebra na pausa longa', () => {
    const segs: Seg[] = [
      { start: 0, end: 1.2, text: 'Então,' },
      { start: 1.3, end: 2.0, text: 'o orçamento' },
      { start: 2.1, end: 4.0, text: 'fechou ontem.' },
      { start: 9.0, end: 10.0, text: 'Outra pauta.' },
    ]
    expect(mergeSegments(segs)).toEqual([
      { start: 0, end: 4.0, text: 'Então, o orçamento fechou ontem.' },
      { start: 9.0, end: 10.0, text: 'Outra pauta.' },
    ])
  })

  it('quebra o parágrafo grande no fim de uma frase, e no limite duro mesmo sem pontuação', () => {
    const frase = 'a'.repeat(299) + '.'
    const segs: Seg[] = [
      { start: 0, end: 1, text: frase },
      { start: 1, end: 2, text: 'continua' },
    ]
    expect(mergeSegments(segs).map((p: Seg) => p.text)).toEqual([frase, 'continua'])
    const semPonto = Array.from({ length: 10 }, (_, i) => ({ start: i, end: i + 1, text: 'b'.repeat(99) }))
    expect(mergeSegments(semPonto).length).toBeGreaterThan(1)
    for (const p of mergeSegments(semPonto)) expect(p.text.length).toBeLessThanOrEqual(800)
  })

  it('formata o tempo como [mm:ss] e, em call longa, [h:mm:ss]', () => {
    expect(formatClock(0)).toBe('00:00')
    expect(formatClock(65.9)).toBe('01:05')
    expect(formatClock(3725)).toBe('62:05')
    expect(formatClock(3725, true)).toBe('1:02:05')
    expect(formatClock(59, true)).toBe('0:00:59')
  })

  it('transcricao.md: cabeçalho com título, plataforma, data local, duração, participantes e perfil, e a fala com o tempo', () => {
    const segments = segmentsFromWhisperJson(whisperJson([[0, 2000, ' Bom dia.'], [65000, 67000, ' Próximo assunto.']]))
    const md = buildMarkdown({ info: INFO, segments, language: 'pt', motor: 'whisper-cpp', model: 'ggml-small.bin' })
    expect(md).toContain('# Daily do time\n')
    expect(md).toContain('- **Plataforma:** Google Meet')
    expect(md).toContain('- **Data:** 06/10/2026 14:30')
    expect(md).toContain('- **Duração:** 32 min 36 s')
    expect(md).toContain('- **Participantes:** Ana Souza, Bruno Lima')
    expect(md).toContain('- **Perfil:** Trabalho')
    expect(md).toContain('- **Transcrição:** whisper.cpp (local), modelo ggml-small.bin, idioma pt')
    expect(md).toContain('[00:00] Bom dia.\n')
    expect(md).toContain('[01:05] Próximo assunto.\n')
  })

  it('call de uma hora ou mais usa [h:mm:ss] em todos os parágrafos', () => {
    const segments = [
      { start: 3, end: 5, text: 'Começo.' },
      { start: 3700, end: 3702, text: 'Fim.' },
    ]
    const md = buildMarkdown({ info: { ...INFO, duracaoSegundos: 3710 }, segments, language: 'pt', motor: 'whisper-cpp', model: 'm.bin' })
    expect(md).toContain('[0:00:03] Começo.')
    expect(md).toContain('[1:01:40] Fim.')
    expect(md).toContain('- **Duração:** 1 h 01 min')
    // Sem a duração no info.json (gravação interrompida), quem decide é o fim da fala.
    const semDuracao = buildMarkdown({ info: { ...INFO, duracaoSegundos: 0 }, segments, language: 'pt', motor: 'whisper-cpp', model: 'm.bin' })
    expect(semDuracao).toContain('[0:00:03] Começo.')
    expect(buildMarkdown({ info: { ...INFO, duracaoSegundos: 0 }, segments: segments.slice(0, 1), language: 'pt', motor: 'whisper-cpp', model: 'm.bin' })).toContain('[00:03] Começo.')
  })

  it('transcrição do áudio do modo aba diz de qual áudio é', () => {
    const md = buildMarkdown({ info: INFO, segments: [], language: 'pt', motor: 'whisper-cpp', model: 'm.bin', audio: 'audio-aba.webm' })
    expect(md).toContain('- **Áudio:** audio-aba.webm (modo aba)')
    expect(buildMarkdown({ info: INFO, segments: [], language: 'pt', motor: 'whisper-cpp', model: 'm.bin' })).not.toContain('Áudio:')
  })

  it('transcrição vazia diz que não houve fala; sem perfil não há a linha; título vazio vira Sem título', () => {
    const md = buildMarkdown({ info: { ...INFO, perfil: null, titulo: '', participantes: [] }, segments: [], language: 'pt', motor: 'whisper-cpp', model: 'm.bin' })
    expect(md).toContain('# Sem título')
    expect(md).toContain('_Nenhuma fala reconhecida na gravação._')
    expect(md).toContain('- **Participantes:** não identificados')
    expect(md).not.toContain('Perfil')
    expect(buildSrt([])).toBe('')
  })

  it('transcricao.srt: um bloco por segmento original, com HH:MM:SS,mmm', () => {
    const srt = buildSrt([
      { start: 0, end: 2.5, text: 'Bom dia.' },
      { start: 3661.25, end: 3662, text: 'Depois de uma hora.' },
    ])
    expect(srt).toBe('1\n00:00:00,000 --> 00:00:02,500\nBom dia.\n\n2\n01:01:01,250 --> 01:01:02,000\nDepois de uma hora.\n')
  })

  it('data e duração do cabeçalho', () => {
    expect(formatLocalStart('2026-01-02T09:05:00+01:00')).toBe('02/01/2026 09:05')
    expect(formatLocalStart(undefined)).toBe('desconhecida')
    expect(formatDuration(45)).toBe('45 s')
    expect(formatDuration(3600)).toBe('1 h 00 min')
  })
})

describe('cabeçalho do transcricao.md no idioma da interface (Emenda 19)', () => {
  const segments = [
    { start: 0, end: 2, text: 'Good morning.' },
    { start: 65, end: 67, text: 'Next topic.' },
  ]
  const args = { segments, language: 'en', motor: 'whisper-cpp', model: 'ggml-small.bin' }

  it('idiomaInterface en: os rótulos, a data como o popup mostra e a linha da fala vazia em inglês', () => {
    const md = buildMarkdown({ ...args, info: { ...INFO, idiomaInterface: 'en' } })
    expect(md).toBe(
      [
        '# Daily do time',
        '',
        '- **Platform:** Google Meet',
        '- **Date:** Oct 6, 2026, 2:30 PM',
        '- **Duration:** 32 min 36 s',
        '- **Participants:** Ana Souza, Bruno Lima',
        '- **Profile:** Trabalho',
        '- **Transcription:** whisper.cpp (local), model ggml-small.bin, language en',
        '',
        '---',
        '',
        '[00:00] Good morning.',
        '',
        '[01:05] Next topic.',
        '',
      ].join('\n'),
    )
    const empty = buildMarkdown({ ...args, segments: [], audio: 'audio-aba.webm', info: { ...INFO, idiomaInterface: 'en', titulo: '', participantes: [], plataforma: 'outro' } })
    expect(empty).toContain('# Untitled\n')
    expect(empty).toContain('- **Platform:** Other site')
    expect(empty).toContain('- **Participants:** not identified')
    expect(empty).toContain('- **Audio:** audio-aba.webm (tab mode)')
    expect(empty).toContain('_No speech recognized in the recording._')
    expect(empty).not.toMatch(/Plataforma|Participantes|Sem título|Nenhuma fala|modo aba/)
  })

  it('sem o campo (info.json de antes da 0.4.1), com pt-BR ou com um valor desconhecido: português, igual ao de antes', () => {
    const before = buildMarkdown({ ...args, info: INFO })
    expect(before).toContain('- **Plataforma:** Google Meet')
    expect(before).toContain('- **Data:** 06/10/2026 14:30')
    expect(before).toContain('- **Transcrição:** whisper.cpp (local), modelo ggml-small.bin, idioma en')
    for (const idiomaInterface of ['pt-BR', 'es', 'EN', 'constructor', '__proto__', 42, null]) {
      expect(buildMarkdown({ ...args, info: { ...INFO, idiomaInterface } }), String(idiomaInterface)).toBe(before)
    }
    expect(markdownLanguage(undefined)).toBe('pt-BR')
    expect(markdownLanguage({ idiomaInterface: 'en' })).toBe('en')
  })

  it('a data em inglês: meia-noite e meio-dia no relógio de 12 h, e desconhecida', () => {
    expect(formatLocalStart('2026-01-02T00:05:00+01:00', 'en')).toBe('Jan 2, 2026, 12:05 AM')
    expect(formatLocalStart('2026-12-31T12:00:00-03:00', 'en')).toBe('Dec 31, 2026, 12:00 PM')
    expect(formatLocalStart('2026-07-04T23:59:00Z', 'en')).toBe('Jul 4, 2026, 11:59 PM')
    expect(formatLocalStart(undefined, 'en')).toBe('unknown')
  })
})

/** Cria um executável sh que só sai com 0. */
function fakeBin(dir: string, name: string): string {
  mkdirSync(dir, { recursive: true })
  const p = join(dir, name)
  writeFileSync(p, '#!/bin/sh\nexit 0\n')
  chmodSync(p, 0o755)
  return p
}

describe('descoberta', () => {
  it('acha o executável no PATH antes das pastas de reserva, e nas de reserva quando o PATH não tem', async () => {
    const a = join(base, 'path-a')
    const reserva = join(base, 'reserva')
    fakeBin(reserva, 'whisper-cli')
    expect(await findExecutable(['whisper-cli'], { env: { PATH: a }, fallbackDirs: [reserva] })).toEqual({ path: join(reserva, 'whisper-cli') })
    const noPath = fakeBin(a, 'whisper-cli')
    expect(await findExecutable(['whisper-cli'], { env: { PATH: a }, fallbackDirs: [reserva] })).toEqual({ path: noPath })
  })

  it('ignora arquivo sem permissão de execução e diz como instalar quando não acha', async () => {
    const d = join(base, 'sem-x')
    mkdirSync(d, { recursive: true })
    writeFileSync(join(d, 'ffmpeg'), 'x')
    const r = await findExecutable(['ffmpeg'], { env: { PATH: d }, fallbackDirs: [] })
    expect(r.path).toBeNull()
    expect(r.motivo).toMatch(/ffmpeg não encontrado.*brew install ffmpeg/)
  })

  it('caminho configurado vale sozinho: errado é erro, sem cair no PATH', async () => {
    const d = join(base, 'cfg')
    fakeBin(d, 'whisper-cli')
    const r = await findExecutable(['whisper-cli'], { configured: join(d, 'nao-existe'), env: { PATH: d }, fallbackDirs: [] })
    expect(r.path).toBeNull()
    expect(r.motivo).toMatch(/whisper-cli não encontrado em .*nao-existe/)
  })

  it('modelo: prefere large-v3-turbo > large-v3 > large-v2 > large-v1 > large > medium > small > base > tiny, o multilíngue ao .en e o cheio ao quantizado', async () => {
    const order = ['large-v3-turbo', 'large-v3', 'large-v2', 'large-v1', 'large', 'medium', 'small', 'base', 'tiny']
    for (let i = 1; i < order.length; i++) expect(rankModel(`ggml-${order[i - 1]}.bin`), order[i]).toBeLessThan(rankModel(`ggml-${order[i]}.bin`))
    expect(rankModel('ggml-small.bin')).toBeLessThan(rankModel('ggml-small-q5_1.bin'))
    expect(rankModel('ggml-small.en.bin', 'auto')).toBeNull()
    expect(rankModel('ggml-small.en.bin', 'en')).toBeGreaterThan(rankModel('ggml-small.bin', 'en'))
    expect(rankModel('for-tests-ggml-tiny.bin')).toBeNull()
    expect(rankModel('ggml-silero-v5.1.2.bin')).toBeNull()
    // Só o tiny na pasta: é o que serve (antes a descoberta o ignorava e dizia que não havia modelo).
    const soTiny = join(base, 'modelos-tiny')
    mkdirSync(soTiny, { recursive: true })
    writeFileSync(join(soTiny, 'ggml-tiny.bin'), 'x')
    expect(await findModel({ dirs: [soTiny] })).toEqual({ path: join(soTiny, 'ggml-tiny.bin') })

    const d1 = join(base, 'modelos-1')
    const d2 = join(base, 'modelos-2')
    mkdirSync(d1, { recursive: true })
    mkdirSync(d2, { recursive: true })
    for (const f of ['ggml-small.bin', 'ggml-base.bin', 'leia-me.txt']) writeFileSync(join(d1, f), 'x')
    for (const f of ['ggml-large-v3-turbo-q5_0.bin', 'ggml-medium.en.bin']) writeFileSync(join(d2, f), 'x')
    expect(await findModel({ dirs: [d1, d2, join(base, 'nao-existe')] })).toEqual({ path: join(d2, 'ggml-large-v3-turbo-q5_0.bin') })
    expect(await findModel({ dirs: [d1] })).toEqual({ path: join(d1, 'ggml-small.bin') })
    const none = await findModel({ dirs: [join(base, 'nao-existe')] })
    expect(none.path).toBeNull()
    expect(none.motivo).toMatch(/modelo não encontrado/)
    expect(await findModel({ configured: join(d1, 'ggml-base.bin'), dirs: [d2] })).toEqual({ path: join(d1, 'ggml-base.bin') })
    expect((await findModel({ configured: join(d1, 'sumiu.bin'), dirs: [d2] })).motivo).toMatch(/modelo não encontrado: .*sumiu\.bin/)
  })

  it('motor whisper-cpp: available() diz o que achou e, se faltar algo, o motivo em português', async () => {
    const bin = join(base, 'motor-bin')
    const models = join(base, 'motor-modelos')
    mkdirSync(models, { recursive: true })
    fakeBin(bin, 'ffmpeg')
    const ctx = { env: { PATH: bin }, fallbackDirs: [], modelDirs: [models] }
    let av = await createEngine({}, ctx).available()
    expect(av).toMatchObject({ ok: false, motivo: expect.stringMatching(/whisper-cli não encontrado/) })
    fakeBin(bin, 'whisper-cli')
    av = await createEngine({}, ctx).available()
    expect(av).toMatchObject({ ok: false, motivo: expect.stringMatching(/modelo não encontrado/) })
    writeFileSync(join(models, 'ggml-base.bin'), 'x')
    av = await createEngine({}, ctx).available()
    expect(av).toEqual({ ok: true, detalhes: { whisperCli: join(bin, 'whisper-cli'), ffmpeg: join(bin, 'ffmpeg'), modelo: join(models, 'ggml-base.bin') } })
  })
})

describe('configuração', () => {
  it('padrões: ativa, whisper-cpp, idioma auto, modelo descoberto; campos inválidos voltam ao padrão', () => {
    expect(normalizeTranscriptionConfig(undefined)).toEqual({ ativa: true, motor: 'whisper-cpp', modelo: '', idioma: 'auto', whisperCli: '', ffmpeg: '' })
    expect(normalizeTranscriptionConfig({ ativa: false, motor: 'nuvem', idioma: 'Português', modelo: ' ~/m.bin ' })).toEqual({
      ativa: false,
      motor: 'whisper-cpp',
      modelo: '~/m.bin',
      idioma: 'auto',
      whisperCli: '',
      ffmpeg: '',
    })
  })

  it('valida cada campo da mudança com mensagem em português', async () => {
    const cur = normalizeTranscriptionConfig({})
    await expect(applyTranscriptionPatch(cur, { idioma: 'pt' })).resolves.toMatchObject({ idioma: 'pt', ativa: true })
    await expect(applyTranscriptionPatch(cur, { ativa: 'sim' })).rejects.toThrow(/verdadeiro ou falso/)
    await expect(applyTranscriptionPatch(cur, { motor: 'nuvem' })).rejects.toThrow(/motor desconhecido/)
    await expect(applyTranscriptionPatch(cur, { idioma: 'pt-BR' })).rejects.toThrow(/idioma inválido/)
    await expect(applyTranscriptionPatch(cur, { modelo: 'relativo.bin' })).rejects.toThrow(/caminho absoluto/)
    await expect(applyTranscriptionPatch(cur, { modelo: join(base, 'nao.bin') })).rejects.toThrow(/modelo não encontrado/)
    await expect(applyTranscriptionPatch(cur, { whisperCli: join(base, 'nao') })).rejects.toThrow(/whisper-cli não encontrado/)
    await expect(applyTranscriptionPatch(cur, { root: '/' })).rejects.toThrow(/campo desconhecido/)
    const m = join(base, 'ok.bin')
    writeFileSync(m, 'x')
    await expect(applyTranscriptionPatch(cur, { modelo: m, ativa: false })).resolves.toMatchObject({ modelo: m, ativa: false })
    await expect(applyTranscriptionPatch(cur, { modelo: '' })).resolves.toMatchObject({ modelo: '' })
  })

  it('um caminho que sumiu depois de salvo não impede salvar o resto nem desligar (a tela manda tudo)', async () => {
    const sumiu = join(base, 'modelo-que-sumiu.bin')
    const cur = normalizeTranscriptionConfig({ ativa: true, modelo: sumiu, whisperCli: join(base, 'whisper-que-sumiu') })
    const tudo = { ...cur, ativa: false }
    await expect(applyTranscriptionPatch(cur, tudo)).resolves.toMatchObject({ ativa: false, modelo: sumiu })
    await expect(applyTranscriptionPatch(cur, { ...cur, idioma: 'pt' })).resolves.toMatchObject({ idioma: 'pt' })
    // Um caminho novo continua conferido.
    await expect(applyTranscriptionPatch(cur, { ...tudo, modelo: join(base, 'outro-que-nao-existe.bin') })).rejects.toThrow(/modelo não encontrado/)
  })
})
