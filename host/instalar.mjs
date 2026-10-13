#!/usr/bin/env node
// Instala o helper de native messaging para o Chrome.
//
//   npm run instalar                       Chrome de marca (pasta padrão do usuário)
//   npm run instalar -- --dir <pasta>      outra pasta de manifestos, por exemplo
//                                          <user-data-dir>/NativeMessagingHosts nos testes
//   opções: --wrapper <arquivo.sh>  (padrão ~/Library/Application Support/gravador-de-calls/bin/
//                                    gravador-host.sh; o helper é copiado para a mesma pasta)
//           --id <id da extensão>   (pode repetir ou separar por vírgula) IDs A MAIS em allowed_origins,
//                                    por exemplo o da cópia instalada pela Chrome Web Store. O ID de
//                                    desenvolvimento (derivado de extension-key.json) entra sempre.
//           --log <arquivo>         (stderr do helper; padrão ~/Library/Logs/gravador-de-calls/helper.log)
//           --config <config.json>  (o wrapper exporta GRAVADOR_CONFIG: raiz própria, para testes)
//           --node <binário>        (padrão: o node que rodou a instalação)
//
// Um manifesto só atende todos os perfis do Chrome (o ID da extensão é fixo). A raiz das
// gravações fica no config.json do helper e vale para todos os perfis.
//
// Emenda 10:
// - o helper é COPIADO para fora do repositório (a pasta do wrapper). O Chrome de marca abre o
//   helper e o macOS (TCC) trata o Chrome como o responsável: ler um script em ~/Documents pede a
//   permissão "Pasta Documentos" do Chrome, no meio da primeira call, ou falha calado. E mover o
//   repositório não quebra mais o helper. Rode `npm run instalar` de novo depois de atualizar o
//   projeto, para a cópia acompanhar.
// - o wrapper existe porque o Chrome abre o helper sem o PATH do terminal. Ele tenta o node da
//   instalação e, se ele sumiu (nvm uninstall, brew upgrade com limpeza), os caminhos estáveis
//   (/opt/homebrew/bin/node, /usr/local/bin/node, o default do nvm, o node do PATH). Sem nenhum,
//   escreve o motivo no log e sai.
import { chmod, copyFile, mkdir, writeFile } from 'node:fs/promises'
import * as path from 'node:path'
import { extensionId } from '../scripts/extension-id.mjs'
import { DEFAULT_WRAPPER, HOST_DIR, HOST_FILE, HOST_FILES, HOST_NAME, defaultLogFile, defaultManifestDir, listArg, parseArgs, resolvePath } from './args.mjs'

const shellQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`

/** Corpo do wrapper (sh). `fallbacks: false` só nos testes (prova o caminho sem node). */
export function wrapperScript({ node, script, log, config, fallbacks = true }) {
  const candidates = [shellQuote(node)]
  if (fallbacks) candidates.push('/opt/homebrew/bin/node', '/usr/local/bin/node', '"$NVM_DEFAULT"', '"$(command -v node 2>/dev/null)"')
  return [
    '#!/bin/sh',
    '# Gerado por host/instalar.mjs. O Chrome abre este arquivo para falar com o helper.',
    '# Rode `npm run instalar` de novo depois de atualizar o projeto ou o Node.',
    ...(config ? [`GRAVADOR_CONFIG=${shellQuote(config)}`, 'export GRAVADOR_CONFIG'] : []),
    `LOG=${shellQuote(log)}`,
    'mkdir -p "$(dirname "$LOG")" 2>/dev/null',
    'NVM_DEFAULT=""',
    ...(fallbacks
      ? [
          'if [ -r "$HOME/.nvm/alias/default" ]; then',
          '  V=$(cat "$HOME/.nvm/alias/default"); V=${V#v}',
          '  for N in "$HOME/.nvm/versions/node/v$V"*/bin/node; do [ -x "$N" ] && NVM_DEFAULT="$N"; done',
          'fi',
        ]
      : []),
    `for NODE in ${candidates.join(' ')}; do`,
    `  if [ -n "$NODE" ] && [ -x "$NODE" ]; then exec "$NODE" ${shellQuote(script)} "$@" 2>>"$LOG"; fi`,
    'done',
    `echo "$(date '+%Y-%m-%d %H:%M:%S') gravador-host: node não encontrado (era ${String(node).replace(/["$`\\]/g, '')}). Rode npm run instalar de novo." >>"$LOG"`,
    'exit 127',
    '',
  ].join('\n')
}

/**
 * `id` troca o ID principal (os testes usam um falso); `extraIds` entram junto em allowed_origins
 * (a cópia da loja tem outro ID e usa o mesmo helper).
 */
export async function install({ dir, wrapper, id, extraIds = [], log, config, node, fallbacks } = {}) {
  const manifestDir = resolvePath(dir ?? defaultManifestDir())
  const wrapperPath = resolvePath(wrapper ?? DEFAULT_WRAPPER)
  const binDir = path.dirname(wrapperPath)
  const ids = [...new Set([id ?? extensionId(), ...extraIds])]
  for (const extId of ids) if (!/^[a-p]{32}$/.test(extId)) throw new Error(`ID de extensão inválido: ${extId}`)

  await mkdir(binDir, { recursive: true })
  const script = path.join(binDir, HOST_FILE)
  // O helper importa o módulo da transcrição e abre o worker pelo caminho ao lado dele (Emenda 13).
  if (path.resolve(binDir) !== path.resolve(HOST_DIR)) for (const f of HOST_FILES) await copyFile(path.join(HOST_DIR, f), path.join(binDir, f))
  await writeFile(
    wrapperPath,
    wrapperScript({ node: node ?? process.execPath, script, log: resolvePath(log ?? defaultLogFile()), config: config ? resolvePath(config) : null, fallbacks }),
  )
  await chmod(wrapperPath, 0o755)

  const manifest = {
    name: HOST_NAME,
    description: 'Gravador de Calls: grava as calls na pasta escolhida',
    path: wrapperPath,
    type: 'stdio',
    allowed_origins: ids.map((extId) => `chrome-extension://${extId}/`),
  }
  await mkdir(manifestDir, { recursive: true })
  const manifestPath = path.join(manifestDir, `${HOST_NAME}.json`)
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
  return { manifestPath, wrapperPath, script, extensionId: ids[0], extensionIds: ids }
}

if (process.argv[1] && path.basename(process.argv[1]) === 'instalar.mjs') {
  const args = parseArgs(process.argv.slice(2))
  install({ dir: args.dir, wrapper: args.wrapper, extraIds: listArg(args.id), log: args.log, config: args.config, node: args.node })
    .then((r) => {
      console.log(`Helper instalado.\n  manifesto: ${r.manifestPath}\n  wrapper:   ${r.wrapperPath}\n  helper:    ${r.script}\n  extensão:  ${r.extensionIds.join(', ')}`)
      console.log('Não precisa recarregar a extensão. Um perfil com o popup ou as configurações abertos passa para esta versão até 30 s depois de fechá-los; uma gravação em andamento termina com a versão de antes, e a próxima já usa esta.')
      console.log('Rode este comando de novo depois de atualizar o projeto, mover a pasta dele ou trocar a versão do Node.')
    })
    .catch((e) => {
      console.error(`Falha ao instalar: ${e.message}`)
      process.exit(1)
    })
}
