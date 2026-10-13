// Repetição em laço do whisper e o segmento sem falante (Emenda 20). Os tempos e as pausas vêm de
// uma daily real (13/10/2026), nos 40 s em que o whisper repetiu uma frase quatro vezes e esticou a
// cópia de outra por cima do silêncio da fala do próprio usuário; os textos são placeholders.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { fakeSegments, fakeTranscriptionConfig, makeFakeTools } from '../helpers/fake-transcricao'
import {
  collapseInside,
  collapseRepeats,
  enqueueTranscription,
  fillSpeakerGaps,
  runWorker,
  // @ts-expect-error módulo .mjs sem tipos
} from '../../host/transcricao.mjs'

type Seg = { start: number; end: number; text: string; speaker?: string }
const seg = (start: number, end: number, text: string, speaker?: string): Seg => ({ start, end, text, ...(speaker ? { speaker } : {}) })

const A = 'Texto de exemplo um.'
const D = 'Frase de teste com seis palavras.'
/** As pausas que o ffmpeg mediu ali (a do meio é a fala do próprio usuário, que não é gravada). */
const PAUSAS = [
  { start: 414.63, end: 441.03 },
  { start: 441.38, end: 443.68 },
]
const LACO: Seg[] = [
  seg(408.98, 409.68, A),
  seg(409.68, 410.52, 'Palavra.'),
  seg(410.52, 410.96, 'Outra.'),
  seg(410.96, 412.92, A),
  seg(412.92, 413.66, A),
  seg(413.66, 414.32, A),
  seg(414.32, 414.74, A),
  seg(431.66, 443.64, D),
  seg(443.64, 445.7, D),
]

describe('collapseRepeats (Emenda 20)', () => {
  it('o laço da daily real: fica A, as duas palavras e a cópia de D com fala fora do silêncio', () => {
    const out: Seg[] = collapseRepeats(LACO, PAUSAS)
    expect(out.map((s) => [s.start, s.text])).toEqual([
      [408.98, A],
      [409.68, 'Palavra.'],
      [410.52, 'Outra.'],
      [443.64, D],
    ])
  })

  it('"Tchau" três vezes e "Bom dia" duas, sem silêncio, ficam: podem ser pessoas diferentes', () => {
    const tchau = [seg(10, 10.5, 'Tchau.'), seg(10.5, 11, 'Tchau!'), seg(11, 11.6, 'tchau')]
    expect(collapseRepeats(tchau, [])).toHaveLength(3)
    const bomDia = [seg(0, 1, 'Bom dia.'), seg(1, 2, 'Bom dia!')]
    expect(collapseRepeats(bomDia, PAUSAS)).toHaveLength(2)
  })

  it('uma palavra repetida com uma das cópias quase toda no silêncio medido cai', () => {
    const out: Seg[] = collapseRepeats([seg(413.5, 414.5, 'Beleza.'), seg(414.5, 425, 'Beleza.')], PAUSAS)
    expect(out.map((s) => s.start)).toEqual([413.5])
  })

  it('a mesma frase dita de novo bem depois (mais de 10 s) fica', () => {
    const out: Seg[] = collapseRepeats([seg(0, 2, A), seg(2, 4, 'Palavra.'), seg(20, 22, A)], [])
    expect(out).toHaveLength(3)
  })

  it('sem repetição, sai igual', () => {
    const fala = [seg(0, 2, 'Bom dia a todos.'), seg(2, 4, 'Vamos começar.'), seg(4, 6, 'Quem quer falar primeiro?')]
    expect(collapseRepeats(fala, PAUSAS)).toEqual(fala)
  })
})

describe('collapseInside (Emenda 20)', () => {
  it('a frase repetida 3 ou mais vezes fica uma; a palavra, 4 ou mais', () => {
    expect(collapseInside('Eu digo isso. Eu digo isso. Eu digo isso. E depois outra coisa.')).toBe('Eu digo isso. E depois outra coisa.')
    expect(collapseInside('bom bom bom bom bom bom bom bom bom bom bom bom bom')).toBe('bom')
    expect(collapseInside('não, não, não')).toBe('não, não, não')
    expect(collapseInside('muito muito bom')).toBe('muito muito bom')
    expect(collapseInside('a b a b')).toBe('a b a b')
  })

  it('o collapseRepeats também tira o laço de dentro de cada segmento', () => {
    expect(collapseRepeats([seg(0, 3, 'Eu digo isso. Eu digo isso. Eu digo isso.')], []).map((s: Seg) => s.text)).toEqual(['Eu digo isso.'])
  })
})

describe('fillSpeakerGaps (Emenda 20)', () => {
  it('o segmento sem falante entre dois do mesmo, a até 1 s, herda; com vizinhos diferentes ou longe, não', () => {
    const out: Seg[] = fillSpeakerGaps([seg(477.3, 494.7, 'antes', 'Pessoa F'), seg(494.76, 494.98, 'Então'), seg(494.98, 496.5, 'depois', 'Pessoa F')])
    expect(out[1].speaker).toBe('Pessoa F')
    expect(fillSpeakerGaps([seg(0, 1, 'a', 'Ana'), seg(1, 2, 'b'), seg(2, 3, 'c', 'Bruno')])[1].speaker).toBeUndefined()
    expect(fillSpeakerGaps([seg(0, 1, 'a', 'Ana'), seg(2.5, 3, 'b'), seg(3, 4, 'c', 'Ana')])[1].speaker).toBeUndefined()
    expect(fillSpeakerGaps([seg(1, 2, 'b'), seg(2, 3, 'c', 'Ana')])[0].speaker).toBeUndefined()
  })
})

describe('worker com a repetição (Emenda 20)', () => {
  const base = mkdtempSync(join(tmpdir(), 'gravador-repeticao-'))
  afterAll(() => rmSync(base, { recursive: true, force: true }))

  it('o .md e o .srt saem sem as cópias, com as pausas do ffmpeg falso', async () => {
    const configDir = join(base, 'config')
    const root = join(base, 'Gravações')
    mkdirSync(configDir, { recursive: true })
    const tools = makeFakeTools(join(base, 'ferramentas'))
    const configFile = join(configDir, 'config.json')
    writeFileSync(configFile, JSON.stringify({ root, transcricao: fakeTranscriptionConfig(tools) }))
    fakeSegments(
      tools,
      LACO.map((s) => [s.start, s.end, s.text]),
    )
    writeFileSync(join(tools.dir, 'silencios.txt'), PAUSAS.map((p) => `[silencedetect @ 0x1] silence_start: ${p.start}\n[silencedetect @ 0x1] silence_end: ${p.end} | silence_duration: ${(p.end - p.start).toFixed(2)}\n`).join(''))
    const folder = join(root, '2026-10', '2026-10-13 09h02 - Daily (Meet)')
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, 'audio.webm'), 'áudio')
    writeFileSync(join(folder, 'info.json'), JSON.stringify({ versao: 1, titulo: 'Daily', plataforma: 'meet', inicio: '2026-10-13T09:02:01-03:00', duracaoSegundos: 517, participantes: [], perfil: null }))
    const readConfig = async () => JSON.parse(readFileSync(configFile, 'utf8'))
    await enqueueTranscription(configDir, folder, (await readConfig()).transcricao)
    await runWorker(configDir, { readConfig })
    const md = readFileSync(join(folder, 'transcricao.md'), 'utf8')
    expect(md.split(A)).toHaveLength(2)
    expect(md.split(D)).toHaveLength(2)
    const srt = readFileSync(join(folder, 'transcricao.srt'), 'utf8')
    expect(srt.trim().split(/\n\n+/)).toHaveLength(4)
    expect(srt).toContain(`00:07:23,640 --> 00:07:25,700\n${D}`)
  })

  it('o trecho num buraco curto da linha do tempo herda o falante dos dois vizinhos no .md', async () => {
    const configDir = join(base, 'config-buraco')
    const root = join(base, 'Gravações-buraco')
    mkdirSync(configDir, { recursive: true })
    const tools = makeFakeTools(join(base, 'ferramentas-buraco'))
    const configFile = join(configDir, 'config.json')
    writeFileSync(configFile, JSON.stringify({ root, transcricao: fakeTranscriptionConfig(tools) }))
    // Os tempos do único caso real: a Pessoa F até 494,00 s, uma interjeição de 0,25 s de outra
    // pessoa, e a Pessoa F de novo a partir de 495,00 s; o "Então" cai no buraco.
    fakeSegments(tools, [
      [490, 494.76, 'Primeira parte da frase.'],
      [494.76, 494.98, 'Então,'],
      [494.98, 496.56, 'segunda parte da frase.'],
    ])
    const folder = join(root, '2026-10', '2026-10-13 09h02 - Daily (Meet)')
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, 'audio.webm'), 'áudio')
    writeFileSync(join(folder, 'info.json'), JSON.stringify({ versao: 1, titulo: 'Daily', plataforma: 'meet', inicio: '2026-10-13T09:02:01-03:00', duracaoSegundos: 517, participantes: [], perfil: null }))
    const iv = (nome: string, de: number, ate: number) => ({ nome, de, ate, fonte: 'csrc' })
    writeFileSync(
      join(folder, 'falantes.json'),
      JSON.stringify({ versao: 1, audio: 'audio.webm', atrasoMs: 1500, intervalos: [iv('Pessoa F', 477_250, 494_000), iv('Pessoa B', 494_500, 494_750), iv('Pessoa F', 495_000, 496_750)], pessoas: [], textos: { voceNaoGravada: '(sua fala não é gravada)' } }),
    )
    const readConfig = async () => JSON.parse(readFileSync(configFile, 'utf8'))
    await enqueueTranscription(configDir, folder, (await readConfig()).transcricao)
    await runWorker(configDir, { readConfig })
    const md = readFileSync(join(folder, 'transcricao.md'), 'utf8')
    expect(md).toContain('[08:10] Pessoa F: Primeira parte da frase. Então, segunda parte da frase.\n')
  })
})
