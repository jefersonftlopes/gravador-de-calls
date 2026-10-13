// Transcrição com os falantes (Emenda 18): cada segmento do whisper com o participante de maior
// sobreposição (empate, sem sobreposição, nunca você), parágrafo novo na troca de falante, as linhas
// da sua fala (que não é gravada) na ordem do tempo, o .srt com o nome, os nomes saneados, e a saída
// idêntica à da 0.3.1 (golden) sem o falantes.json. No fim, o worker de verdade com o whisper falso
// lendo o falantes.json da pasta.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import daily from '../fixtures/falantes/daily-meet-anonimizada.json'
import { fakeSegments, fakeTranscriptionConfig, makeFakeTools } from '../helpers/fake-transcricao'
import {
  assignSpeakers,
  buildMarkdown,
  buildSrt,
  checkUnnamedSources,
  enqueueTranscription,
  mergeSegments,
  runWorker,
  selfLines,
  speakerTimelineFrom,
  // @ts-expect-error módulo .mjs sem tipos
} from '../../host/transcricao.mjs'

const base = mkdtempSync(join(tmpdir(), 'gravador-falantes-'))
afterAll(() => rmSync(base, { recursive: true, force: true }))

const INFO = { titulo: 'Daily do time', plataforma: 'meet', inicio: '2026-10-06T14:30:05-03:00', duracaoSegundos: 60, participantes: ['Ana Souza', 'Bruno Lima'] }
const iv = (nome: string, deS: number, ateS: number, voce = false) => ({ nome, de: deS * 1000, ate: ateS * 1000, fonte: voce ? 'microfone' : 'dsh', ...(voce ? { voce: true } : {}) })
const file = (intervalos: unknown[], extra: Record<string, unknown> = {}) => ({ versao: 1, audio: 'audio.webm', atrasoMs: 1500, intervalos, pessoas: [], textos: { voceNaoGravada: '(sua fala não é gravada)' }, ...extra })
const seg = (start: number, end: number, text: string) => ({ start, end, text })

describe('speakerTimelineFrom', () => {
  it('lê os intervalos em segundos; sem participante, de outro áudio ou inválido, null', () => {
    const tl = speakerTimelineFrom(file([iv('Ana Souza', 1, 4), iv('Você', 5, 8, true)]), 'audio.webm')
    expect(tl.remote).toEqual([{ nome: 'Ana Souza', start: 1, end: 4, voce: false }])
    expect(tl.self).toEqual([{ nome: 'Você', start: 5, end: 8, voce: true }])
    expect(tl.naoGravada).toBe('(sua fala não é gravada)')
    expect(speakerTimelineFrom(file([iv('Você', 5, 8, true)]), 'audio.webm')).toBeNull()
    expect(speakerTimelineFrom(file([iv('Ana Souza', 1, 4)]), 'audio-aba.webm')).toBeNull()
    expect(speakerTimelineFrom({ versao: 2, intervalos: [] }, 'audio.webm')).toBeNull()
    expect(speakerTimelineFrom(null, 'audio.webm')).toBeNull()
    expect(speakerTimelineFrom(file([{ nome: 'X', de: 5, ate: 1 }, iv('Ana Souza', 1, 2)]), 'audio.webm').remote).toHaveLength(1)
  })
})

describe('assignSpeakers', () => {
  const tl = speakerTimelineFrom(
    file([iv('Ana Souza', 0, 10), iv('Bruno Lima', 9, 20), iv('Carla Dias', 30, 32), iv('Davi Rocha', 30, 40), iv('Você', 20, 30, true)]),
    'audio.webm',
  )

  it('o de maior sobreposição; sem sobreposição, sem nome; nunca você', () => {
    const out = assignSpeakers([seg(1, 5, 'a'), seg(8, 12, 'b'), seg(22, 28, 'c'), seg(50, 55, 'd')], tl)
    expect(out.map((s: { speaker?: string }) => s.speaker ?? null)).toEqual(['Ana Souza', 'Bruno Lima', null, null])
  })

  it('empate na sobreposição: o de intervalo mais longo', () => {
    const [s] = assignSpeakers([seg(30, 32, 'empate')], tl)
    expect(s.speaker).toBe('Davi Rocha')
  })

  it('sem linha do tempo, os segmentos saem como estão', () => {
    const segs = [seg(0, 1, 'a')]
    expect(assignSpeakers(segs, null)).toBe(segs)
  })
})

describe('texto com os falantes', () => {
  const tl = speakerTimelineFrom(
    file([iv('Ana Souza', 2.5, 8.5), iv('Bruno Lima', 8.5, 14.5), iv('Você', 14.5, 19.5, true), iv('Ana Souza', 19.5, 26), iv('Você', 26, 26.5, true)]),
    'audio.webm',
  )
  const segments = assignSpeakers([seg(3, 5, 'Bom dia a todos.'), seg(5.1, 6, 'Vamos começar.'), seg(9, 12, 'Obrigado, Ana.'), seg(20.5, 22, 'Voltando ao assunto.')], tl)

  it('a troca de falante começa outro parágrafo, mesmo sem pausa', () => {
    const p = mergeSegments([seg(0, 2, 'um'), { ...seg(2, 3, 'dois'), speaker: 'A' }, { ...seg(3, 4, 'três'), speaker: 'A' }, { ...seg(4, 5, 'quatro'), speaker: 'B' }])
    expect(p.map((x: { text: string; speaker?: string }) => [x.speaker ?? null, x.text])).toEqual([
      [null, 'um'],
      ['A', 'dois três'],
      ['B', 'quatro'],
    ])
  })

  it('transcricao.md: "[mm:ss] Nome: texto" e a sua fala na ordem do tempo', () => {
    const md = buildMarkdown({ info: INFO, segments, language: 'pt', motor: 'whisper-cpp', model: 'm.bin', speakers: tl })
    const body = md.split('---\n')[1].trim().split('\n').filter(Boolean)
    expect(body).toEqual([
      '[00:03] Ana Souza: Bom dia a todos. Vamos começar.',
      '[00:09] Bruno Lima: Obrigado, Ana.',
      '[00:14] Você: (sua fala não é gravada)',
      '[00:20] Ana Souza: Voltando ao assunto.',
    ])
  })

  it('a sua fala coberta pela call, ou curta demais, não vira linha', () => {
    const t2 = speakerTimelineFrom(file([iv('Ana Souza', 0, 10), iv('Você', 1, 9, true), iv('Você', 20, 20.6, true), iv('Você', 30, 34, true)]), 'audio.webm')
    const lines = selfLines(t2, [seg(0, 9, 'fala longa'), seg(31, 31.5, 'curto')])
    expect(lines.map((l: { start: number }) => l.start)).toEqual([30])
  })

  it('transcricao.srt com o nome de quem falou', () => {
    expect(buildSrt(segments.slice(2, 4))).toBe('1\n00:00:09,000 --> 00:00:12,000\nBruno Lima: Obrigado, Ana.\n\n2\n00:00:20,500 --> 00:00:22,000\nAna Souza: Voltando ao assunto.\n')
  })

  it('nomes vindos da página: sem quebra de linha nem marcas de direção; no .md, sem markdown nem HTML; no .srt, sem tag', () => {
    const t2 = speakerTimelineFrom(
      file([iv('<img src=x onerror=alert(1)>', 0, 2), iv('[link](https://evil.example)', 2, 4), iv('**neg**\u2028\r\n# título', 4, 6), iv('Ana\u202e Souza\u0007', 6, 8)]),
      'audio.webm',
    )
    expect(t2.remote.map((i: { nome: string }) => i.nome)).toEqual(['<img src=x onerror=alert(1)>', '[link](https://evil.example)', '**neg** # título', 'Ana Souza'])
    const segs = assignSpeakers([seg(0.5, 1.5, 'fala1'), seg(2.5, 3.5, 'fala2'), seg(4.5, 5.5, 'fala3'), seg(6.5, 7.5, 'fala4')], t2)
    const body = buildMarkdown({ info: INFO, segments: segs, language: 'pt', motor: 'whisper-cpp', model: 'm.bin', speakers: t2 }).split('---\n')[1].trim().split('\n').filter(Boolean)
    expect(body).toEqual([
      '[00:00] \\<img src=x onerror=alert(1)\\>: fala1',
      '[00:02] \\[link\\](https://evil.example): fala2',
      '[00:04] \\*\\*neg\\*\\* # título: fala3',
      '[00:06] Ana Souza: fala4',
    ])
    expect(buildSrt(segs.slice(0, 1))).toBe('1\n00:00:00,500 --> 00:00:01,500\n\u2039img src=x onerror=alert(1)\u203a: fala1\n')
  })

  // Golden: a saída da 0.3.1 (host/transcricao.mjs de d325254), copiada aqui como texto, com
  // segmentos fora de ordem, dois com o mesmo início, um parágrafo longo e uma pausa medida.
  const L = 'Fala longa. '.repeat(60).trim()
  const GOLDEN_SEGS = [seg(10, 12, L), seg(5, 6, 'Antes.'), seg(5, 5.5, 'Mesmo início.'), seg(13, 14, 'Depois da longa.'), seg(30, 31, 'Depois da pausa.')]
  const HEADER =
    '# Daily do time\n\n- **Plataforma:** Google Meet\n- **Data:** 06/10/2026 14:30\n- **Duração:** 1 min 00 s\n- **Participantes:** Ana Souza, Bruno Lima\n- **Transcrição:** whisper.cpp (local), modelo m.bin, idioma pt\n\n---\n\n'
  const GOLDEN_MD = `${HEADER}[00:10] ${L}\n\n[00:05] Antes. Mesmo início.\n\n[00:13] Depois da longa.\n\n[00:30] Depois da pausa.\n`
  const GOLDEN_SRT = `1\n00:00:10,000 --> 00:00:12,000\n${L}\n\n2\n00:00:05,000 --> 00:00:06,000\nAntes.\n\n3\n00:00:05,000 --> 00:00:05,500\nMesmo início.\n\n4\n00:00:13,000 --> 00:00:14,000\nDepois da longa.\n\n5\n00:00:30,000 --> 00:00:31,000\nDepois da pausa.\n`

  it('sem o falantes.json, o .md e o .srt são os da 0.3.1, byte a byte', () => {
    const args = { info: INFO, language: 'pt', motor: 'whisper-cpp', model: 'm.bin', pauses: [{ start: 14, end: 29 }] }
    expect(buildMarkdown({ ...args, segments: GOLDEN_SEGS })).toBe(GOLDEN_MD)
    expect(buildMarkdown({ ...args, segments: assignSpeakers(GOLDEN_SEGS, null), speakers: null })).toBe(GOLDEN_MD)
    expect(buildSrt(assignSpeakers(GOLDEN_SEGS, null))).toBe(GOLDEN_SRT)
    expect(buildMarkdown({ ...args, segments: [] })).toBe(`${HEADER}_Nenhuma fala reconhecida na gravação._\n`)
    expect(buildSrt([])).toBe('')
  })

  it('com o falantes.json, a sua linha entra no lugar do tempo sem reordenar os parágrafos de antes', () => {
    const t3 = speakerTimelineFrom(file([iv('Ana Souza', 4, 30), iv('Você', 20, 25, true)]), 'audio.webm')
    const md = buildMarkdown({ info: INFO, language: 'pt', motor: 'whisper-cpp', model: 'm.bin', pauses: [{ start: 14, end: 29 }], segments: assignSpeakers(GOLDEN_SEGS, t3), speakers: t3 })
    expect(md.split('---\n')[1].trim().split('\n').filter(Boolean)).toEqual([
      `[00:10] Ana Souza: ${L}`,
      '[00:05] Ana Souza: Antes. Mesmo início.',
      '[00:13] Ana Souza: Depois da longa.',
      '[00:20] Você: (sua fala não é gravada)',
      // A Ana acaba em 30 s: o segmento de 30 a 31 s não tem sobreposição com ninguém.
      '[00:30] Depois da pausa.',
    ])
  })
})

describe('worker com o falantes.json da pasta', () => {
  it('o .md e o .srt saem com os nomes (whisper falso com segmentos em tempos conhecidos)', async () => {
    const configDir = join(base, 'config')
    const root = join(base, 'Gravações')
    mkdirSync(configDir, { recursive: true })
    const tools = makeFakeTools(join(base, 'ferramentas'))
    const configFile = join(configDir, 'config.json')
    writeFileSync(configFile, JSON.stringify({ root, transcricao: fakeTranscriptionConfig(tools) }))
    fakeSegments(tools, [
      [3, 6, 'Bom dia a todos.'],
      [9, 12, 'Obrigado, Ana.'],
      [20.5, 22, 'Voltando ao assunto.'],
    ])
    const folder = join(root, '2026-10', '2026-10-06 14h30 - Daily (Meet)')
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, 'audio.webm'), 'áudio')
    writeFileSync(join(folder, 'info.json'), JSON.stringify({ versao: 1, ...INFO, perfil: null }))
    writeFileSync(join(folder, 'falantes.json'), JSON.stringify(file([iv('Ana Souza', 2.5, 8.5), iv('Bruno Lima', 8.5, 14.5), iv('Você', 14.5, 19.5, true), iv('Ana Souza', 19.5, 26)])))
    const readConfig = async () => JSON.parse(readFileSync(configFile, 'utf8'))
    await enqueueTranscription(configDir, folder, (await readConfig()).transcricao)
    await runWorker(configDir, { readConfig })
    const md = readFileSync(join(folder, 'transcricao.md'), 'utf8')
    expect(md).toContain('[00:03] Ana Souza: Bom dia a todos.\n\n[00:09] Bruno Lima: Obrigado, Ana.\n\n[00:14] Você: (sua fala não é gravada)\n\n[00:20] Ana Souza: Voltando ao assunto.\n')
    expect(readFileSync(join(folder, 'transcricao.srt'), 'utf8')).toContain('00:00:09,000 --> 00:00:12,000\nBruno Lima: Obrigado, Ana.\n')
  })

  it('Emenda 19: o info.json com idiomaInterface en dá o cabeçalho em inglês, com a sua linha no texto do falantes.json', async () => {
    const configDir = join(base, 'config-en')
    const root = join(base, 'Gravações-en')
    mkdirSync(configDir, { recursive: true })
    const tools = makeFakeTools(join(base, 'ferramentas-en'))
    const configFile = join(configDir, 'config.json')
    writeFileSync(configFile, JSON.stringify({ root, transcricao: fakeTranscriptionConfig(tools) }))
    fakeSegments(tools, [
      [3, 6, 'Good morning.'],
      [20.5, 22, 'Back to the topic.'],
    ])
    const folder = join(root, '2026-10', '2026-10-06 14h30 - Daily (Meet)')
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, 'audio.webm'), 'áudio')
    writeFileSync(join(folder, 'info.json'), JSON.stringify({ versao: 1, ...INFO, perfil: null, idiomaInterface: 'en' }))
    writeFileSync(join(folder, 'falantes.json'), JSON.stringify(file([iv('Ana Souza', 2.5, 8.5), iv('You', 14.5, 19.5, true)], { textos: { voceNaoGravada: '(your speech is not recorded)' } })))
    const readConfig = async () => JSON.parse(readFileSync(configFile, 'utf8'))
    await enqueueTranscription(configDir, folder, (await readConfig()).transcricao)
    await runWorker(configDir, { readConfig })
    const md = readFileSync(join(folder, 'transcricao.md'), 'utf8')
    expect(md).toMatch(/^# .+\n\n- \*\*Platform:\*\* Google Meet\n- \*\*Date:\*\* /)
    expect(md).toContain('- **Participants:** ')
    expect(md).toContain('- **Transcription:** whisper.cpp (local), model ')
    expect(md).toContain('[00:03] Ana Souza: Good morning.\n\n[00:14] You: (your speech is not recorded)\n\n[00:20] Back to the topic.\n')
    expect(md).not.toMatch(/Plataforma|Participantes|Transcrição|Duração/)
  })
})

describe('fonte sem nome que acompanha quem fala (Emenda 20)', () => {
  /**
   * O falantes.json da daily real anonimizada como a 0.4.1 o escreveu: a fonte sem nome com o rótulo
   * "Participante 1", sem `semNome`, e as pessoas por letra.
   */
  const dailyFile = (ghost = 'Participante 1', extra: Record<string, unknown> = {}) =>
    file(
      daily.intervalos.map((i) => (i.quem === 'voce' ? { nome: 'Você', de: i.de, ate: i.ate, fonte: 'microfone', voce: true } : { nome: i.quem === 'fantasma' ? ghost : `Pessoa ${i.quem}`, de: i.de, ate: i.ate, fonte: 'csrc' })),
      extra,
    )
  type Seg = { start: number; end: number; text: string; speaker?: string }
  /** Um trecho do whisper por intervalo nomeado de 1 s ou mais, no tempo dele (quem falou é sabido). */
  const known = daily.intervalos.filter((i) => i.quem !== 'voce' && i.quem !== 'fantasma' && i.ate - i.de >= 1000).map((i) => ({ ...seg(i.de / 1000, i.ate / 1000, 'texto'), quem: `Pessoa ${i.quem}` }))
  const count = (out: Seg[]) => out.reduce<Record<string, number>>((m, s) => ((m[s.speaker ?? '(sem)'] = (m[s.speaker ?? '(sem)'] ?? 0) + 1), m), {})

  it('o falantes.json de antes (rótulo "Participante 1"): a fonte sai e cada trecho fica com quem falou', () => {
    const tl = speakerTimelineFrom(dailyFile(), 'audio.webm')
    expect(tl.remote.some((i: { nome: string }) => i.nome === 'Participante 1')).toBe(false)
    expect(tl.descartadas).toHaveLength(1)
    expect(tl.descartadas[0]).toMatchObject({ nome: 'Participante 1', pessoasCobertas: 6, sombra: true })
    expect(tl.descartadas[0].segundos).toBeCloseTo(399.5, 1)
    expect(tl.descartadas[0].coberturaPct).toBeCloseTo(98.7, 1)
    expect(tl.descartadas[0].presencaPct).toBeCloseTo(99.2, 1)
    const out: Seg[] = assignSpeakers(known, tl)
    expect(out.every((s) => s.speaker?.startsWith('Pessoa '))).toBe(true)
    // 40 de 41: num trecho, a fala de uma pessoa cabe inteira dentro da de outra (o empate vai para o
    // intervalo mais longo, regra da Emenda 18).
    expect(out.filter((s, n) => s.speaker === known[n].quem)).toHaveLength(known.length - 1)
    // Sem a regra (a mesma fonte com um nome que não é rótulo nosso), ela levava quase tudo.
    const before: Seg[] = assignSpeakers(known, speakerTimelineFrom(dailyFile('Fantasma'), 'audio.webm'))
    expect(count(before).Fantasma).toBeGreaterThan(known.length * 0.8)
  })

  it('a marca semNome da 0.4.2 vale com qualquer rótulo', () => {
    const tl = speakerTimelineFrom(dailyFile('Desconhecido 1', { pessoas: [{ nome: 'Desconhecido 1', segundos: 399.5, semNome: true }] }), 'audio.webm')
    expect(tl.descartadas.map((d: { nome: string }) => d.nome)).toEqual(['Desconhecido 1'])
    expect(tl.remote.some((i: { nome: string }) => i.nome === 'Desconhecido 1')).toBe(false)
  })

  it('em inglês ("Participant 1") também sai', () => {
    expect(speakerTimelineFrom(dailyFile('Participant 1'), 'audio.webm').descartadas.map((d: { nome: string }) => d.nome)).toEqual(['Participant 1'])
  })

  it('pessoa sem nome que fala sozinha e duas pessoas que às vezes falam juntas ficam', () => {
    const tl = speakerTimelineFrom(file([iv('Ana Souza', 0, 10), iv('Participante 1', 9, 20), iv('Ana Souza', 20, 30), iv('Participante 1', 29, 40), iv('Participante 2', 50, 60)]), 'audio.webm')
    expect(tl.descartadas).toEqual([])
    expect(new Set(tl.remote.map((i: { nome: string }) => i.nome))).toEqual(new Set(['Ana Souza', 'Participante 1', 'Participante 2']))
  })

  it('quem só faz interjeições por cima de 3 pessoas fica (presença baixa); quem fala muito com a nomeada por cima também (cobertura baixa)', () => {
    const interj = speakerTimelineFrom(
      file([iv('Ana Souza', 0, 30), iv('Participante 1', 10, 11), iv('Bruno Lima', 30, 60), iv('Participante 1', 40, 41), iv('Carla Dias', 60, 90), iv('Participante 1', 70, 71)]),
      'audio.webm',
    )
    expect(interj.descartadas).toEqual([])
    const long = speakerTimelineFrom(file([iv('Participante 1', 0, 60), iv('Ana Souza', 20, 22), iv('Ana Souza', 40, 43)]), 'audio.webm')
    expect(long.descartadas).toEqual([])
    expect(long.remote).toHaveLength(3)
  })

  it('uma pessoa com nome nunca sai, mesmo andando junto de todo mundo', () => {
    const tl = speakerTimelineFrom(file([iv('Ana Souza', 0, 10), iv('Carla Dias', 0, 10), iv('Bruno Lima', 10, 20), iv('Carla Dias', 10, 20)]), 'audio.webm')
    expect(tl.descartadas).toEqual([])
    expect(tl.remote).toHaveLength(4)
  })

  it('as medidas batem com as da extensão (mesmos limiares)', () => {
    const remote = [{ nome: 'Ana', start: 1, end: 9 }, { nome: 'X', start: 1, end: 9.25 }, { nome: 'Ana', start: 12, end: 30 }, { nome: 'X', start: 12.25, end: 30 }]
    const [c] = checkUnnamedSources(remote, new Set(['X']))
    expect(c.coberturaPct).toBeCloseTo(99.04, 1)
    expect(c.presencaPct).toBeCloseTo(99.04, 1)
    expect(c).toMatchObject({ pessoasCobertas: 1, sombra: true })
  })

  it('o worker transcreve de novo uma gravação de antes: o .md sai sem a fonte sem nome', async () => {
    const configDir = join(base, 'config-sombra')
    const root = join(base, 'Gravações-sombra')
    mkdirSync(configDir, { recursive: true })
    const tools = makeFakeTools(join(base, 'ferramentas-sombra'))
    const configFile = join(configDir, 'config.json')
    writeFileSync(configFile, JSON.stringify({ root, transcricao: fakeTranscriptionConfig(tools) }))
    fakeSegments(
      tools,
      known.slice(0, 12).map((s, n) => [s.start, s.end, `trecho ${n + 1}.`]),
    )
    const folder = join(root, '2026-10', '2026-10-13 09h02 - Daily (Meet)')
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, 'audio.webm'), 'áudio')
    writeFileSync(join(folder, 'info.json'), JSON.stringify({ versao: 1, ...INFO, perfil: null }))
    writeFileSync(join(folder, 'falantes.json'), JSON.stringify(dailyFile()))
    const readConfig = async () => JSON.parse(readFileSync(configFile, 'utf8'))
    await enqueueTranscription(configDir, folder, (await readConfig()).transcricao)
    const lines: string[] = []
    await runWorker(configDir, { readConfig, log: (l: string) => lines.push(l) })
    const md = readFileSync(join(folder, 'transcricao.md'), 'utf8')
    expect(md).not.toContain('Participante 1')
    for (const s of known.slice(0, 12)) expect(md).toContain(`${s.quem}: `)
    expect(lines.some((l) => l.includes('fonte sem nome fora da linha do tempo'))).toBe(true)
  })
})
