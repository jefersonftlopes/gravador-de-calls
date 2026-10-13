// npm run transcrever (Emenda 20): uma gravação de antes da 0.4.2, já transcrita com "Participante 1"
// em quase todo trecho, transcrita de novo pelo helper deste repositório, com o whisper falso.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import daily from '../fixtures/falantes/daily-meet-anonimizada.json'
import { fakeSegments, fakeTranscriptionConfig, makeFakeTools } from '../helpers/fake-transcricao'
import { ROOT } from '../helpers/paths'

const base = mkdtempSync(join(tmpdir(), 'gravador-transcrever-'))
afterAll(() => rmSync(base, { recursive: true, force: true }))

describe('npm run transcrever (Emenda 20)', () => {
  it('troca o .md de uma pasta já pronta pelo de agora, sem a fonte sem nome; o áudio e o falantes.json ficam', () => {
    const configDir = join(base, 'config')
    const root = join(base, 'Gravações')
    mkdirSync(configDir, { recursive: true })
    const tools = makeFakeTools(join(base, 'ferramentas'))
    const configFile = join(configDir, 'config.json')
    writeFileSync(configFile, JSON.stringify({ root, transcricao: fakeTranscriptionConfig(tools) }))
    const named = daily.intervalos.filter((i) => i.quem !== 'voce' && i.quem !== 'fantasma' && i.ate - i.de >= 1000).slice(0, 6)
    fakeSegments(
      tools,
      named.map((i, n) => [i.de / 1000, i.ate / 1000, `trecho ${n + 1}.`]),
    )
    const folder = join(root, '2026-10', '2026-10-13 09h02 - Daily (Meet)')
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, 'audio.webm'), 'áudio')
    const falantes = JSON.stringify({
      versao: 1,
      audio: 'audio.webm',
      atrasoMs: 1500,
      intervalos: daily.intervalos.map((i) => ({ nome: i.quem === 'voce' ? 'Você' : i.quem === 'fantasma' ? 'Participante 1' : `Pessoa ${i.quem}`, de: i.de, ate: i.ate, fonte: i.quem === 'voce' ? 'microfone' : 'csrc', ...(i.quem === 'voce' ? { voce: true } : {}) })),
      pessoas: [],
      textos: { voceNaoGravada: '(sua fala não é gravada)' },
    })
    writeFileSync(join(folder, 'falantes.json'), falantes)
    const pronta = { status: 'pronta', motor: 'whisper-cpp', audio: 'audio.webm', arquivos: ['transcricao.md', 'transcricao.srt'] }
    writeFileSync(join(folder, 'info.json'), JSON.stringify({ versao: 1, titulo: 'Daily', plataforma: 'meet', inicio: '2026-10-13T09:02:01-03:00', duracaoSegundos: 517, participantes: [], perfil: null, transcricao: pronta, transcricoes: { 'audio.webm': pronta } }))
    writeFileSync(join(folder, 'transcricao.md'), '[00:03] Participante 1: texto antigo\n')

    const out = execFileSync(process.execPath, [join(ROOT, 'scripts', 'transcrever-de-novo.mjs'), folder], { env: { ...process.env, GRAVADOR_CONFIG: configFile }, encoding: 'utf8' })
    expect(out).toContain(`pronta: ${join(folder, 'transcricao.md')}`)
    const md = readFileSync(join(folder, 'transcricao.md'), 'utf8')
    expect(md).not.toContain('Participante 1')
    expect(md).toContain('Pessoa ')
    expect(readFileSync(join(folder, 'audio.webm'), 'utf8')).toBe('áudio')
    expect(readFileSync(join(folder, 'falantes.json'), 'utf8')).toBe(falantes)
    expect(JSON.parse(readFileSync(join(folder, 'info.json'), 'utf8')).transcricao.status).toBe('pronta')
  })

  it('sem pasta, diz como usar e sai com erro', () => {
    expect(() => execFileSync(process.execPath, [join(ROOT, 'scripts', 'transcrever-de-novo.mjs')], { encoding: 'utf8', stdio: 'pipe' })).toThrow(/Uso: npm run transcrever/)
  })
})
