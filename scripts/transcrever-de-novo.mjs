#!/usr/bin/env node
// Transcreve de novo uma gravação já salva (Emenda 20) com o helper deste repositório. Serve para
// uma call gravada antes da 0.4.2 sair com os nomes certos (sem a fonte sem nome que acompanhava
// quem fala) e sem a repetição em laço do whisper. Troca o transcricao.md e o .srt da pasta; o
// áudio, o info.json (só o estado da transcrição muda) e o falantes.json ficam como estão. Usa a
// configuração da transcrição do helper (GRAVADOR_CONFIG ou a padrão, a mesma das configurações).
//
//   npm run transcrever -- "<pasta da call>" ["<outra pasta>"...]
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { configPath, readConfig } from '../host/gravador-host.mjs'
import { enqueueTranscription, transcriptStem } from '../host/transcricao.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

async function main() {
  const folders = process.argv.slice(2).map((f) => path.resolve(f))
  if (!folders.length) {
    console.error('Uso: npm run transcrever -- "<pasta da call>" ["<outra pasta>"...]')
    process.exit(2)
  }
  const cfg = (await readConfig())?.transcricao
  const configDir = path.dirname(configPath())
  let queued = 0
  for (const folder of folders) {
    if (!existsSync(path.join(folder, 'info.json'))) {
      console.error(`sem info.json, fica de fora: ${folder}`)
      continue
    }
    const r = await enqueueTranscription(configDir, folder, cfg, { redo: true })
    if (r.queued) queued++
    console.log(r.queued ? `na fila: ${folder}` : `não entrou na fila (${r.motivo}): ${folder}`)
  }
  if (!queued) process.exit(1)
  // O worker deste repositório, com a trava da fila: se o do helper já estiver rodando, ele pega
  // os trabalhos e este sai na hora.
  const worker = spawn(process.execPath, [path.join(ROOT, 'host', 'transcrever.mjs')], { env: process.env, stdio: ['ignore', 'inherit', 'inherit'] })
  const code = await new Promise((resolve) => worker.on('close', resolve))
  if (code !== 0) process.exit(code ?? 1)
  for (const folder of folders) {
    const md = path.join(folder, `${transcriptStem('audio.webm')}.md`)
    if (existsSync(md)) console.log(`pronta: ${md}`)
  }
}

main().catch((e) => {
  console.error(`falhou: ${e?.message ?? e}`)
  process.exit(1)
})
