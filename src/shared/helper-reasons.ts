// Motivos que o helper escreve em português (host/gravador-host.mjs, host/transcricao.mjs),
// traduzidos na extensão (Emenda 15). E, desde a Emenda 19, os que o próprio SW escreve.
//
// O helper não muda nesta versão (ele ainda não vai pela loja, e quem o tem instalado pode estar
// numa versão anterior), então em vez de mandar o idioma da interface a cada pedido, cada motivo
// conhecido vira um código estável (a chave da mensagem) reconhecido pelo texto, e os valores
// variáveis (caminho, código de erro, programa) passam inteiros. Um motivo desconhecido aparece
// como veio. Em português a tradução de cada motivo é igual ao texto do helper (o teste confere).
//
// Emenda 19: o SW escreve os motivos dele (errHelperTimeout, trOldHelper...) no idioma da hora, e
// alguns ficam guardados assim: o status do helper (cache de 15 s), o lastError de uma gravação não
// salva, o erro de uma ação na tela. Trocado o idioma, eles são reconhecidos pelo texto, nas duas
// línguas (recognizeMessage), e saem no idioma novo; os valores passam pelo mesmo helperReason.
import { MESSAGE_KEYS, recognizeMessage, t, type MessageKey } from './i18n'

interface Rule {
  re: RegExp
  /** Monta o texto traduzido a partir dos grupos da expressão. */
  render(m: RegExpExecArray): string
}

/** Códigos do Node em friendlyFsError: `<motivo> (<código>): <caminho>`. */
const FS_REASON_KEY: Record<string, MessageKey> = {
  EACCES: 'hrNoPermission',
  EPERM: 'hrNoPermission',
  ENOTDIR: 'hrNotAFolder',
  EEXIST: 'hrNotAFolder',
  EROFS: 'hrReadOnly',
  ENOSPC: 'hrDiskFull',
}

/** Detalhe opcional depois de ": " (a linha do erro do programa), que passa inteiro. */
const withDetail = (text: string, detail: string | undefined) => (detail ? `${text}: ${detail}` : text)

const RULES: Rule[] = [
  {
    re: /^.+ \((EACCES|EPERM|ENOTDIR|EEXIST|EROFS|ENOSPC|ENOENT)\): (.+)$/s,
    render: (m) => {
      const [, code, abs] = m
      const key = code === 'ENOENT' ? (abs.startsWith('/Volumes/') ? 'hrDiskNotConnected' : 'hrCannotCreate') : FS_REASON_KEY[code]
      return `${t(key)} (${code}): ${abs}`
    },
  },
  { re: /^(whisper-cli|ffmpeg) não encontrado em (.+) \(confira o caminho nas configurações\)$/s, render: (m) => t('hrProgramNotFoundAt', m[1], m[2]) },
  {
    re: /^(whisper-cli|ffmpeg) não encontrado \(instale com: brew install (\S+), ou informe o caminho nas configurações\)$/,
    render: (m) => t('hrProgramNotFoundInstall', m[1], m[2]),
  },
  { re: /^(whisper-cli|ffmpeg) não encontrado ou sem permissão de execução: (.+)$/s, render: (m) => t('hrProgramNotExecutable', m[1], m[2]) },
  { re: /^modelo não encontrado: baixe um modelo do whisper\.cpp /, render: () => t('hrModelMissing') },
  { re: /^modelo não encontrado: (.+)$/s, render: (m) => t('hrModelNotFoundAt', m[1]) },
  { re: /^o ffmpeg não conseguiu converter o áudio(?:: (.+))?$/s, render: (m) => withDetail(t('hrFfmpegFailed'), m[1]) },
  { re: /^o whisper-cli falhou \(código (-?\d+|null)\)(?:: (.+))?$/s, render: (m) => withDetail(t('hrWhisperFailed', m[1]), m[2]) },
  { re: /^a transcrição saiu da fila sem terminar \(veja o log do helper\)$/, render: () => t('hrLeftQueue') },
  { re: /^áudio não encontrado$/, render: () => t('hrAudioMissing') },
  { re: /^(modelo|whisperCli|ffmpeg): use um caminho absoluto ou começando com ~$/, render: (m) => t('hrAbsolutePath', m[1]) },
  // Emenda 19: os do worker da transcrição que faltavam (host/transcricao.mjs).
  { re: /^o ffmpeg passou do tempo limite convertendo o áudio$/, render: () => t('hrFfmpegTimeout') },
  { re: /^o whisper-cli passou do tempo limite$/, render: () => t('hrWhisperTimeout') },
  { re: /^o whisper-cli terminou sem escrever o resultado \(JSON\)$/, render: () => t('hrWhisperNoJson') },
  { re: /^a transcrição foi interrompida (\d+) vezes no meio; o áudio continua na pasta$/, render: (m) => t('hrInterrupted', m[1]) },
  { re: /^áudio não encontrado: (.+)$/s, render: (m) => t('hrAudioMissingFile', m[1]) },
  { re: /^motor de transcrição indisponível$/, render: () => t('hrEngineUnavailable') },
  { re: /^motor desconhecido: (.+)$/s, render: (m) => t('hrUnknownEngine', m[1]) },
]

/** Os motivos que o SW escreve: os erros (err*) e o do helper sem transcrição. */
const SW_REASON_KEYS = MESSAGE_KEYS.filter((key) => key.startsWith('err') || key === 'trOldHelper')

/** O motivo do helper ou do SW no idioma da interface (ou como veio, se não for um motivo conhecido). */
export function helperReason(text: string | null | undefined): string {
  if (!text) return text ?? ''
  for (const rule of RULES) {
    const m = rule.re.exec(text)
    if (m) return rule.render(m)
  }
  // Cada valor é mais curto que o texto (a mensagem tem texto fixo), então a recursão termina.
  const known = recognizeMessage(text, SW_REASON_KEYS)
  if (known) return t(known.key, ...known.subs.map(helperReason))
  return text
}
