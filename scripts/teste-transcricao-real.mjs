#!/usr/bin/env node
// Teste REAL da transcrição (Emenda 13), fora do npm test: fala em português gerada pelo `say` do
// macOS, convertida para WebM/Opus como uma gravação de verdade, transcrita pelo worker de verdade
// (host/transcrever.mjs) com o whisper-cli e o ffmpeg de verdade desta máquina.
//
//   npm run teste:transcricao-real
//   GRAVADOR_MODELO=<ggml-*.bin> npm run teste:transcricao-real    outro modelo
//
// Tudo numa pasta temporária, com um config.json próprio (GRAVADOR_CONFIG): não toca na
// configuração do helper instalado, na fila dele nem na pasta das gravações. Nunca baixa modelo:
// sem GRAVADOR_MODELO, usa o que a descoberta do helper achar (~/.cache/whisper-models...).
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { enqueueTranscription, findExecutable, findModel, modelDirs } from '../host/transcricao.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const FRASE = 'Bom dia a todos. Hoje vamos falar sobre o orçamento do projeto e o cronograma da próxima semana. Depois, cada pessoa conta o que fez ontem.'
const ESPERADAS = ['orçamento', 'projeto', 'cronograma', 'semana', 'ontem']

function fail(msg) {
  console.error(`FALHOU: ${msg}`)
  process.exit(1)
}

/** Uma voz do português do Brasil (Luciana se houver). */
function ptVoice() {
  const list = execFileSync('say', ['-v', '?'], { encoding: 'utf8' })
  const pt = list.split('\n').filter((l) => /\bpt_BR\b/.test(l))
  const luciana = pt.find((l) => l.startsWith('Luciana'))
  const line = luciana ?? pt[0]
  if (!line) fail('nenhuma voz pt_BR no say do macOS')
  return line.split(/\s{2,}|\s\(/)[0].trim()
}

async function main() {
  if (process.platform !== 'darwin') fail('este teste usa o say do macOS')
  const ffmpeg = await findExecutable(['ffmpeg'], { label: 'ffmpeg' })
  if (!ffmpeg.path) fail(ffmpeg.motivo)
  const whisper = await findExecutable(['whisper-cli', 'whisper-cpp'], { label: 'whisper-cli' })
  if (!whisper.path) fail(whisper.motivo)
  const model = await findModel({ configured: process.env.GRAVADOR_MODELO ?? '', dirs: modelDirs(), idioma: 'pt' })
  if (!model.path) fail(model.motivo)

  const base = mkdtempSync(path.join(tmpdir(), 'gravador-transcricao-real-'))
  const keep = Boolean(process.env.GRAVADOR_MANTER_TMP)
  try {
    const configDir = path.join(base, 'config')
    const root = path.join(base, 'Gravações')
    const folder = path.join(root, '2026-10', '2026-10-07 10h00 - Teste real (Meet)')
    mkdirSync(configDir, { recursive: true })
    mkdirSync(folder, { recursive: true })
    const configFile = path.join(configDir, 'config.json')
    const transcricao = { ativa: true, motor: 'whisper-cpp', modelo: model.path, idioma: 'pt', whisperCli: whisper.path, ffmpeg: ffmpeg.path }
    writeFileSync(configFile, JSON.stringify({ root, transcricao }, null, 2))

    const voice = ptVoice()
    const aiff = path.join(base, 'fala.aiff')
    execFileSync('say', ['-v', voice, '-o', aiff, FRASE])
    // Como a gravação de verdade: WebM/Opus mono 32 kbps.
    execFileSync(ffmpeg.path, ['-nostdin', '-v', 'error', '-y', '-i', aiff, '-ac', '1', '-c:a', 'libopus', '-b:a', '32k', path.join(folder, 'audio.webm')])
    const dur = Number(execFileSync(ffmpeg.path.replace(/ffmpeg$/, 'ffprobe'), ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path.join(folder, 'audio.webm')], { encoding: 'utf8' }).trim()) || 0
    writeFileSync(
      path.join(folder, 'info.json'),
      JSON.stringify({ versao: 1, titulo: 'Teste real', plataforma: 'meet', inicio: '2026-10-07T10:00:00-03:00', duracaoSegundos: Math.round(dur), participantes: ['Voz sintética'], perfil: null }, null, 2),
    )

    console.log(`voz: ${voice} | áudio: ${dur.toFixed(1)} s | whisper-cli: ${whisper.path} | modelo: ${model.path}`)
    const q = await enqueueTranscription(configDir, folder, transcricao)
    if (!q.queued) fail(`não entrou na fila: ${q.motivo}`)

    const t0 = Date.now()
    const worker = spawn(process.execPath, [path.join(ROOT, 'host', 'transcrever.mjs')], { env: { ...process.env, GRAVADOR_CONFIG: configFile }, stdio: ['ignore', 'inherit', 'inherit'] })
    const code = await new Promise((r) => worker.on('close', r))
    const secs = ((Date.now() - t0) / 1000).toFixed(1)
    if (code !== 0) fail(`o worker saiu com ${code}`)

    const info = JSON.parse(readFileSync(path.join(folder, 'info.json'), 'utf8'))
    console.log(`info.json transcricao: ${JSON.stringify(info.transcricao)}`)
    if (info.transcricao?.status !== 'pronta') fail(`status ${info.transcricao?.status}: ${info.transcricao?.erro ?? ''}`)
    const md = readFileSync(path.join(folder, 'transcricao.md'), 'utf8')
    const srt = readFileSync(path.join(folder, 'transcricao.srt'), 'utf8')
    if (!existsSync(path.join(folder, 'audio.webm'))) fail('o áudio sumiu')
    console.log(`--- transcricao.md (worker em ${secs} s) ---\n${md}--- transcricao.srt ---\n${srt}`)
    const lower = md.toLowerCase()
    const achadas = ESPERADAS.filter((w) => lower.includes(w))
    console.log(`palavras esperadas encontradas: ${achadas.length}/${ESPERADAS.length} (${achadas.join(', ')})`)
    if (achadas.length < 3) fail('a transcrição não tem as palavras esperadas')
    console.log('OK: transcrição real pronta.')
  } finally {
    if (keep) console.log(`pasta mantida: ${base}`)
    else rmSync(base, { recursive: true, force: true })
  }
}

main().catch((e) => fail(e?.stack ?? String(e)))
