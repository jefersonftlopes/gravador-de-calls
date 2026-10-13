// Como instalar o motor local (Emenda 22): UMA fonte para o passo a passo que a tela mostra, para o
// prompt que o usuário cola no Claude Code, para docs/PROMPT-INSTALAR.md e para a seção do site.
//
// Por que existe: até a 0.5.0, quem escolhia "O seu computador (whisper.cpp)" sem o helper lia uma
// frase dizendo que precisa do helper local e nada mais. Instalar exigia ler o README, achar o
// modelo de 1,6 GB e rodar `npm run instalar` com o id certo. O pedido foi mostrar o passo a passo
// na própria tela e, junto, o prompt para o Claude Code fazer tudo.
//
// A regra que isto resolve: o passo a passo visível e o prompt dizem a mesma coisa porque nascem do
// MESMO array. Mudar um passo muda os quatro destinos, e o teste de tests/unit/prompt-instalar.test.ts
// falha se o arquivo do repositório ou o site saírem de sincronia.
//
// Os textos são mensagens (public/_locales), então o prompt sai no idioma da interface (Emenda 19);
// os comandos e os endereços são dados, iguais nas duas línguas. Precedente da constante com
// `labelKey`: TRANSCRIPTION_LANGUAGES e UI_LANGUAGE_OPTIONS em src/options/form.ts.
//
// Os fatos abaixo foram conferidos em 13/10/2026 nesta máquina; mudar qualquer um deles é mudar o
// passo a passo, o prompt, o documento e o site de uma vez.
import { tIn, type MessageKey, type MessageLocale } from './i18n'

/** Repositório público do projeto (o link que a tela e o prompt mostram). */
export const REPO_URL = 'https://github.com/jefersonftlopes/gravador-de-calls'
/** O mesmo repositório para o `git clone`. */
export const REPO_GIT_URL = `${REPO_URL}.git`
/** Onde o prompt manda baixar o projeto (fora da pasta do repositório de quem desenvolve). */
export const PROJECT_DIR = '~/Documents/gravador-de-calls'
/**
 * Id da extensão publicada na Chrome Web Store. Sem ele no `npm run instalar`, o helper não entra
 * no `allowed_origins` da cópia da loja e ela nunca acha o helper (Emenda 13).
 */
export const STORE_EXTENSION_ID = 'kpbjnbedejcbakdjacjmhaofidooddjp'
/** Modelo do whisper.cpp que o helper prefere (large-v3-turbo, MODEL_PREFERENCE em host/texto.mjs). */
export const MODEL_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin'
/** Tamanho exato do modelo. Um arquivo cortado faz o whisper falhar sem explicar a causa. */
export const MODEL_BYTES = 1_624_555_275
/** Pasta de modelos que o helper procura (docs/ARQUITETURA.md, Emenda 13). */
export const MODEL_DIR = '$HOME/Library/Application Support/gravador-de-calls/modelos'
/** Nome do arquivo do modelo dentro de MODEL_DIR. */
export const MODEL_FILE = 'ggml-large-v3-turbo.bin'
/** O caminho completo do modelo, entre aspas para o shell (a pasta tem espaço no nome). */
export const MODEL_PATH = `"${MODEL_DIR}/${MODEL_FILE}"`
/** O sistema para o qual o instalador do helper existe (wrapper sh em ~/Library/Application Support). */
export const INSTALLER_OS = 'mac'

/**
 * O instalador existe só para macOS. `null` é "ainda não sei" (o chrome.runtime.getPlatformInfo não
 * respondeu): aí a tela não acusa nada, para não piscar um aviso errado.
 */
export function installerAvailableOn(os: string | null): boolean {
  return os === null || os === INSTALLER_OS
}

/** Um passo da instalação: o rótulo que a tela mostra, os comandos e o que conferir depois. */
export interface InstallStep {
  id: string
  /** Rótulo em linguagem de quem não é técnico (o mesmo na tela e no prompt). */
  labelKey: MessageKey
  /** O que o Claude Code confere antes de começar o passo seguinte (só no prompt). */
  checkKey: MessageKey
  /** Comandos do passo, na ordem. Dados, não tradução. */
  commands: readonly string[]
  /** Valores do rótulo que não dependem do idioma. */
  labelSubs?: readonly string[]
  /** Valores da conferência. */
  checkSubs?: readonly string[]
  /** O rótulo leva o tamanho do modelo, que é escrito no formato do idioma. */
  labelHasModelSize?: true
}

export const INSTALL_STEPS: readonly InstallStep[] = Object.freeze([
  Object.freeze({
    id: 'mac',
    labelKey: 'stepMacLabel',
    checkKey: 'stepMacCheck',
    commands: Object.freeze(['uname -s']),
  }),
  Object.freeze({
    id: 'dependencias',
    labelKey: 'stepDepsLabel',
    checkKey: 'stepDepsCheck',
    // whisper-cpp é o nome da fórmula do Homebrew; ela entrega /opt/homebrew/bin/whisper-cli.
    commands: Object.freeze(['brew install node', 'brew install whisper-cpp', 'brew install ffmpeg']),
  }),
  Object.freeze({
    id: 'projeto',
    labelKey: 'stepProjectLabel',
    checkKey: 'stepProjectCheck',
    commands: Object.freeze([`git clone ${REPO_GIT_URL} ${PROJECT_DIR}`]),
    labelSubs: Object.freeze([PROJECT_DIR]),
    checkSubs: Object.freeze([PROJECT_DIR]),
  }),
  Object.freeze({
    id: 'modelo',
    labelKey: 'stepModelLabel',
    checkKey: 'stepModelCheck',
    commands: Object.freeze([`mkdir -p "${MODEL_DIR}"`, `curl -L --fail -o ${MODEL_PATH} ${MODEL_URL}`, `stat -f%z ${MODEL_PATH}`]),
    labelHasModelSize: true,
    checkSubs: Object.freeze([String(MODEL_BYTES)]),
  }),
  Object.freeze({
    id: 'helper',
    labelKey: 'stepHelperLabel',
    checkKey: 'stepHelperCheck',
    commands: Object.freeze([`cd ${PROJECT_DIR}`, `npm run instalar -- --id ${STORE_EXTENSION_ID}`]),
    checkSubs: Object.freeze([STORE_EXTENSION_ID]),
  }),
  Object.freeze({
    id: 'prova',
    labelKey: 'stepProofLabel',
    checkKey: 'stepProofCheck',
    commands: Object.freeze([`cd ${PROJECT_DIR}`, 'npm run teste:transcricao-real']),
  }),
  // Emenda 23: a prova anterior diz que transcreve, mas não diz onde as gravações vão cair nem onde
  // cada peça foi achada. Este é o passo que o Claude Code traduz para quem instalou.
  Object.freeze({
    id: 'verificar',
    labelKey: 'stepVerifyLabel',
    checkKey: 'stepVerifyCheck',
    commands: Object.freeze([`cd ${PROJECT_DIR}`, 'npm run verificar']),
  }),
])

/** As regras que o prompt impõe ao Claude Code, na ordem. */
export const PROMPT_RULES: readonly MessageKey[] = Object.freeze([
  'promptRuleStepByStep',
  'promptRuleBigDownload',
  'promptRuleNoNpmInstall',
  'promptRuleExplain',
  'promptRuleNoDelete',
  'promptRuleNoPassword',
])

/**
 * O que o Claude Code diz no fim (Emenda 23). Era o que ficava com a pessoa na extensão (escolher a
 * pasta e deixar o motor local escolhido); como a transcrição local já fica ligada e configurada
 * sozinha depois da instalação, o fim passou a ser uma tradução da saída do `npm run verificar`:
 * em que pasta as gravações caem, e que não há nada para digitar na extensão.
 */
export const PROMPT_END: readonly MessageKey[] = Object.freeze(['promptEndExplain', 'promptEndFolder', 'promptEndEngine'])

/**
 * "1,6 GB" (ou "1.6 GB"), no formato do idioma. Em GB decimal, que é como o download é anunciado;
 * o número exato de bytes fica na conferência do passo, para o comando comparar.
 */
export function modelSizeLabel(tag: string): string {
  const gb = MODEL_BYTES / 1e9
  let number: string
  try {
    number = new Intl.NumberFormat(tag, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(gb)
  } catch {
    number = gb.toFixed(1)
  }
  return `${number} GB`
}

/** Os valores do rótulo de um passo (o tamanho do modelo sai no formato do idioma pedido). */
export function stepLabelSubs(step: InstallStep, tag: string): string[] {
  return step.labelHasModelSize ? [modelSizeLabel(tag)] : [...(step.labelSubs ?? [])]
}

/** A etiqueta BCP47 de um idioma embutido ("pt-BR" ou "en"), para formatar números. */
export function localeTagOf(locale: MessageLocale): string {
  const tag = tIn(locale, 'localeTag')
  return tag === 'localeTag' ? locale.replace('_', '-') : tag
}

/** Indentação dos comandos dentro de um passo: bloco de código quando o texto virar markdown. */
const COMMAND_INDENT = '       '
/** Indentação das linhas de um passo (depois do "1. "). */
const STEP_INDENT = '   '

/**
 * O prompt para colar no Claude Code, no idioma pedido. Pura: o mesmo idioma dá sempre o mesmo
 * texto, e é isso que deixa o teste comparar o arquivo do repositório e o site com o código.
 *
 * Texto puro de propósito, sem cerca de código (```): o documento e o site embrulham o prompt num
 * bloco, e um bloco dentro do outro não fecha.
 */
export function installPrompt(locale: MessageLocale): string {
  const tag = localeTagOf(locale)
  const t = (key: MessageKey, ...subs: string[]) => tIn(locale, key, ...subs)
  const out: string[] = []
  out.push(t('promptTitle'), '', t('promptIntro'), '', `${t('promptRepo')} ${REPO_URL}`, '', t('promptRulesTitle'), '')
  PROMPT_RULES.forEach((key, i) => out.push(`${i + 1}. ${t(key, ...(key === 'promptRuleBigDownload' ? [modelSizeLabel(tag)] : []))}`))
  out.push('', t('promptStepsTitle'), '')
  INSTALL_STEPS.forEach((step, i) => {
    out.push(`${i + 1}. ${t(step.labelKey, ...stepLabelSubs(step, tag))}`)
    out.push(`${STEP_INDENT}${t('promptCommands')}`)
    for (const command of step.commands) out.push(`${COMMAND_INDENT}${command}`)
    out.push(`${STEP_INDENT}${t('promptCheck')} ${t(step.checkKey, ...(step.checkSubs ?? []))}`)
    out.push('')
  })
  out.push(t('promptEndTitle'), '')
  PROMPT_END.forEach((key, i) => out.push(`${i + 1}. ${t(key)}`))
  return `${out.join('\n')}\n`
}
