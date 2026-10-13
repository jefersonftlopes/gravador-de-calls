#!/usr/bin/env node
// Remove o manifesto do helper, o wrapper e a cópia do helper (Emenda 10: o helper instalado é
// uma cópia, na pasta do wrapper).
//
//   npm run desinstalar                    Chrome de marca (pasta padrão do usuário)
//   npm run desinstalar -- --dir <pasta>   outra pasta de manifestos
//   opção: --wrapper <arquivo.sh> apaga esse wrapper (e o helper ao lado dele)
//
// Fica no disco, de propósito: a configuração e os índices do helper
// (~/Library/Application Support/gravador-de-calls/config.json e sessoes/), as gravações e o
// staging de uma gravação interrompida em <raiz>/.gravando/ (README, "Desinstalar").
import { rm, rmdir } from 'node:fs/promises'
import * as path from 'node:path'
import { DEFAULT_WRAPPER, HOST_DIR, HOST_FILES, HOST_NAME, defaultManifestDir, parseArgs, resolvePath } from './args.mjs'

export async function uninstall({ dir, wrapper } = {}) {
  const manifestPath = path.join(resolvePath(dir ?? defaultManifestDir()), `${HOST_NAME}.json`)
  await rm(manifestPath, { force: true })
  const wrapperPath = resolvePath(wrapper ?? DEFAULT_WRAPPER)
  await rm(wrapperPath, { force: true })
  const binDir = path.dirname(wrapperPath)
  // Nunca apaga a fonte do repositório (wrapper antigo, de antes da Emenda 10, ficava em host/).
  if (path.resolve(binDir) !== path.resolve(HOST_DIR)) for (const f of HOST_FILES) await rm(path.join(binDir, f), { force: true })
  await rmdir(path.dirname(wrapperPath)).catch(() => {})
  return { manifestPath, wrapperPath }
}

if (process.argv[1] && path.basename(process.argv[1]) === 'desinstalar.mjs') {
  const args = parseArgs(process.argv.slice(2))
  uninstall({ dir: args.dir, wrapper: args.wrapper })
    .then((r) => console.log(`Helper removido.\n  manifesto: ${r.manifestPath}\n  wrapper:   ${r.wrapperPath}`))
    .catch((e) => {
      console.error(`Falha ao desinstalar: ${e.message}`)
      process.exit(1)
    })
}
