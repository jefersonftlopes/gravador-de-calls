#!/usr/bin/env node
// O estado real da instalação da transcrição local (Emenda 23), em frases que quem não é técnico
// entende. É o último passo do prompt de docs/PROMPT-INSTALAR.md: depois de instalar tudo, quem
// colou o prompt no Claude Code precisa saber o que ficou pronto e, principalmente, EM QUE PASTA
// as gravações vão cair. Sem este comando, o Claude Code teria que adivinhar olhando arquivo por
// arquivo, e adivinhação é o que dá errado na mão de quem não é técnico.
//
//   npm run verificar            as frases
//   npm run verificar -- --json  o mesmo estado como JSON, para automatizar
//
// SÓ LÊ. Nunca escreve, nunca instala, nunca baixa nada: nem o config.json, nem a pasta das
// gravações, nem o manifesto do Chrome são tocados. Saída do processo: 0 quando dá para
// transcrever, 1 quando falta alguma peça (assim quem automatiza não precisa interpretar texto).
//
// A chave da API (Emenda 21) NÃO é lida nem impressa aqui: ela mora no chrome.storage do perfil,
// fora do alcance deste comando, e o estado abaixo é montado campo por campo, nunca espalhando o
// config.json inteiro (que pode ter campos de uma versão mais nova). tests/unit/verificar.test.ts
// prova isso com uma chave falsa gravada no config.json.
//
// A descoberta das peças é a MESMA do helper (findExecutable, findModel, modelDirs, readConfig):
// se ela mudar, este comando acompanha sozinho, em vez de dizer uma coisa e o helper outra.
//
// Idioma: português. Não há precedente de escolher idioma fora da extensão (`src/`): todo script de
// `scripts/`, todo texto de `host/` e até os motivos que o helper grava no `info.json` são em
// português, e é a extensão que traduz o que aparece na tela (Emendas 15 e 19). Decisão declarada.
import { existsSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { HOST_FILE, HOST_FILES, HOST_NAME, defaultBinDir, defaultManifestDir, parseArgs } from '../host/args.mjs'
import { DEFAULT_ROOT, HOST_VERSION, configPath, expandHome, readConfig } from '../host/gravador-host.mjs'
import { findExecutable, findModel, modelDirs } from '../host/transcricao.mjs'

/** Versão do JSON da saída: quem automatiza sabe com qual formato está falando. */
export const STATE_VERSION = 1

/** A versão do helper copiado está escrita no próprio arquivo (o Chrome executa a cópia, Emenda 10). */
const VERSION_RE = /HOST_VERSION\s*=\s*'([^']+)'/

/** `chrome-extension://<id>/` vira `<id>`; o que não tiver essa forma fica como está. */
function extensionId(origin) {
  const m = /^chrome-extension:\/\/([^/]+)\/?$/.exec(String(origin ?? ''))
  return m ? m[1] : String(origin ?? '')
}

async function statOrNull(p) {
  try {
    return await fs.stat(p)
  } catch {
    return null
  }
}

/** "1,6 GB": o tamanho do modelo no formato de quem lê (o comando fala português). */
export function gbLabel(bytes) {
  return `${new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(bytes / 1e9)} GB`
}

/** O manifesto de native messaging: existe? para quais extensões? */
async function readManifest(manifestDir) {
  const arquivo = path.join(manifestDir, `${HOST_NAME}.json`)
  try {
    const raw = JSON.parse(await fs.readFile(arquivo, 'utf8'))
    const origens = Array.isArray(raw?.allowed_origins) ? raw.allowed_origins : []
    return { arquivo, instalado: true, ids: origens.map(extensionId), programa: typeof raw?.path === 'string' ? raw.path : null, erro: null }
  } catch (e) {
    const faltou = e?.code === 'ENOENT'
    return { arquivo, instalado: false, ids: [], programa: null, erro: faltou ? null : `não deu para ler o manifesto: ${e?.message ?? e}` }
  }
}

/** A cópia do helper que o Chrome executa: todos os arquivos estão lá? em que versão? */
async function readHelper(binDir) {
  const arquivosFaltando = HOST_FILES.filter((f) => !existsSync(path.join(binDir, f)))
  let versao = null
  try {
    versao = VERSION_RE.exec(await fs.readFile(path.join(binDir, HOST_FILE), 'utf8'))?.[1] ?? null
  } catch {
    // sem a cópia: arquivosFaltando já diz
  }
  return {
    pasta: binDir,
    instalado: arquivosFaltando.length === 0,
    arquivosFaltando,
    versao,
    versaoProjeto: HOST_VERSION,
    mesmaVersao: versao === HOST_VERSION,
  }
}

/**
 * O estado inteiro, montado campo por campo.
 *
 * As pastas entram por parâmetro, para o teste rodar num HOME falso sem tocar na instalação de
 * verdade: `home`, `manifestDir`, `binDir`, e `env`, `fallbackDirs` e `modelDirs` com o mesmo nome
 * e o mesmo papel que têm no `ctx` do motor (`createEngine`, host/transcricao.mjs). Sem parâmetro,
 * tudo sai da descoberta do helper.
 */
export async function collectState({ env = process.env, home = os.homedir(), manifestDir = defaultManifestDir(), binDir = defaultBinDir(), fallbackDirs, modelDirs: dirsParam } = {}) {
  const cfg = await readConfig()
  const tr = cfg.transcricao
  const arquivoConfig = configPath()
  const configDir = path.dirname(arquivoConfig)

  const pasta = expandHome(cfg.root)
  const gravacoes = {
    pasta,
    // A raiz padrão vale quando o config.json não escolheu outra (porque não existe, ou porque é
    // essa mesma): nos dois casos a frase para a pessoa é a mesma.
    origem: cfg.root === DEFAULT_ROOT ? 'padrao' : 'config',
    existe: Boolean((await statOrNull(pasta))?.isDirectory()),
    config: arquivoConfig,
    temConfig: existsSync(arquivoConfig),
  }

  const pastas = dirsParam ?? modelDirs({ home, configDir })
  const modeloAchado = await findModel({ configured: tr.modelo, dirs: pastas, idioma: tr.idioma })
  const bytes = modeloAchado.path ? ((await statOrNull(modeloAchado.path))?.size ?? null) : null
  const modelo = {
    caminho: modeloAchado.path ?? null,
    bytes,
    gb: bytes === null ? null : gbLabel(bytes),
    configurado: Boolean(tr.modelo),
    motivo: modeloAchado.motivo ?? null,
    // Onde ele procurou: a pessoa precisa saber onde pôr o arquivo, não só que não achou.
    pastas: tr.modelo ? [] : pastas,
  }

  const programa = async (names, configured, label) => {
    const r = await findExecutable(names, { configured, env, fallbackDirs, label })
    return { caminho: r.path ?? null, configurado: Boolean(configured), motivo: r.motivo ?? null }
  }
  const whisperCli = await programa(['whisper-cli', 'whisper-cpp'], tr.whisperCli, 'whisper-cli')
  const ffmpeg = await programa(['ffmpeg'], tr.ffmpeg, 'ffmpeg')

  const manifesto = await readManifest(manifestDir)
  const helper = await readHelper(binDir)
  const transcricao = { ativa: tr.ativa, motor: tr.motor, idioma: tr.idioma }

  const faltando = []
  if (!manifesto.instalado) faltando.push('a ligação entre o Chrome e o programa que transcreve')
  if (!helper.instalado) faltando.push('o programa que transcreve, copiado para fora do projeto')
  else if (!helper.mesmaVersao) faltando.push(`o programa que transcreve está na versão ${helper.versao ?? 'desconhecida'} e o projeto está na ${HOST_VERSION}`)
  if (!whisperCli.caminho) faltando.push('o whisper-cli')
  if (!ffmpeg.caminho) faltando.push('o ffmpeg')
  if (!modelo.caminho) faltando.push('o modelo de reconhecimento de fala')
  if (!transcricao.ativa) faltando.push('a transcrição automática, que está desligada')

  return { versao: STATE_VERSION, pronto: faltando.length === 0, faltando, manifesto, helper, gravacoes, modelo, whisperCli, ffmpeg, transcricao }
}

/** Uma frase por peça, na ordem em que a pessoa se pergunta por elas. */
export function lines(state) {
  const { manifesto, helper, gravacoes, modelo, whisperCli, ffmpeg, transcricao } = state
  const out = ['Gravador de Calls: como está a transcrição neste computador.', '']

  if (manifesto.instalado) {
    const quantas = manifesto.ids.length === 1 ? '1 extensão' : `${manifesto.ids.length} extensões`
    out.push(`A ligação com o Chrome está instalada, para ${quantas}: ${manifesto.ids.join(', ') || '(nenhuma)'}.`)
  } else {
    out.push(`A ligação com o Chrome não está instalada: o arquivo ${manifesto.arquivo} não existe. É o que o "npm run instalar" escreve.`)
    if (manifesto.erro) out.push(`  ${manifesto.erro}`)
  }

  if (!helper.instalado) {
    out.push(`O programa que transcreve não está instalado em ${helper.pasta} (falta ${helper.arquivosFaltando.join(', ')}). É o que o "npm run instalar" copia.`)
  } else if (helper.mesmaVersao) {
    out.push(`O programa que transcreve está instalado na versão ${helper.versao}, a mesma deste projeto.`)
  } else {
    out.push(`O programa que transcreve está instalado na versão ${helper.versao ?? 'desconhecida'}, e este projeto está na ${helper.versaoProjeto}: rode "npm run instalar" de novo para atualizar a cópia.`)
  }

  out.push(
    gravacoes.origem === 'padrao'
      ? `As gravações vão cair em ${gravacoes.pasta}, que é a pasta padrão (o arquivo de configuração não escolheu outra).`
      : `As gravações vão cair em ${gravacoes.pasta}, que é a pasta escolhida no arquivo de configuração ${gravacoes.config}.`,
  )
  if (!gravacoes.existe) out.push('  Essa pasta ainda não existe: ela é criada sozinha na primeira call gravada.')

  if (modelo.caminho) {
    out.push(`O modelo de reconhecimento de fala está em ${modelo.caminho}, com ${modelo.gb}.`)
  } else {
    out.push(`O modelo de reconhecimento de fala não foi encontrado: ${modelo.motivo}`)
    if (modelo.pastas.length) {
      out.push('  Procurei nestas pastas:')
      for (const dir of modelo.pastas) out.push(`  - ${dir}`)
    }
  }

  for (const [nome, prog] of [
    ['whisper-cli', whisperCli],
    ['ffmpeg', ffmpeg],
  ]) {
    out.push(prog.caminho ? `O ${nome} está em ${prog.caminho}.` : `O ${nome} não foi encontrado: ${prog.motivo}`)
  }

  out.push(
    transcricao.ativa
      ? 'A transcrição automática está ligada, e é assim que ela já vem: não há nada para digitar na extensão.'
      : 'A transcrição automática está desligada nas configurações da extensão, em Transcrição.',
  )

  out.push('')
  if (state.pronto) {
    out.push(`Tudo pronto: as suas calls vão ser transcritas neste computador, e as gravações vão cair em ${gravacoes.pasta}.`)
  } else {
    const coisas = state.faltando.length === 1 ? 'Falta 1 coisa' : `Faltam ${state.faltando.length} coisas`
    out.push(`${coisas}: ${state.faltando.join('; ')}.`)
  }
  return out
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const state = await collectState()
  console.log(args.json ? JSON.stringify(state, null, 2) : lines(state).join('\n'))
  process.exit(state.pronto ? 0 : 1)
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)
if (invokedDirectly) {
  main().catch((e) => {
    console.error(`não deu para conferir: ${e?.message ?? e}`)
    process.exit(1)
  })
}
