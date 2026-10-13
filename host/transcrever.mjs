#!/usr/bin/env node
// Worker de transcrição (Emenda 13): processo destacado que o helper abre quando enfileira uma
// gravação. Sobrevive ao Chrome fechar (o helper o abre com detached + unref), pega a trava da
// fila (só um worker por vez, então nunca dois whisper ao mesmo tempo), retoma o que sobrou de um
// worker anterior e processa um trabalho por vez, com prioridade baixa. A saída vai para o log do
// helper (o stderr herdado).
//
//   node host/transcrever.mjs      usa o config.json do helper (GRAVADOR_CONFIG ou o padrão)
import * as os from 'node:os'
import * as path from 'node:path'
import { configPath, readConfig } from './gravador-host.mjs'
import { runWorker } from './transcricao.mjs'

const log = (msg) => process.stderr.write(`${new Date().toISOString()} gravador-transcricao[${process.pid}]: ${msg}\n`)

async function main() {
  try {
    // Prioridade baixa: a próxima call (e o resto da máquina) vem antes. Os filhos (ffmpeg e
    // whisper) herdam.
    os.setPriority(10)
  } catch {
    // sem permissão para mudar: segue com a normal
  }
  const configDir = path.dirname(configPath())
  const processed = await runWorker(configDir, { readConfig, log })
  if (processed > 0) log(`fila vazia depois de ${processed} trabalho(s)`)
}

main().catch((e) => {
  log(`erro: ${e?.stack ?? e}`)
  process.exitCode = 1
})
