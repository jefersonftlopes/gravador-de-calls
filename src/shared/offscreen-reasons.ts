// Motivos de falha que o documento offscreen devolve ao SW, traduzidos na extensão (Emenda 15).
//
// O offscreen só tem a API chrome.runtime (sem chrome.i18n), então ele continua escrevendo o
// motivo em português e o SW o troca pela mensagem no idioma da interface antes de mandar à tela
// ou gravar no registro, como os motivos do helper (helper-reasons.ts). Os valores variáveis
// (sessão, erro do navegador) passam inteiros. Um motivo desconhecido (o erro cru do navegador,
// que já vem em inglês) aparece como veio. Em português a tradução é igual ao texto do offscreen.
import { t } from './i18n'

const RULES: Array<{ re: RegExp; render(m: RegExpExecArray): string }> = [
  { re: /^esta aba já está sendo gravada$/, render: () => t('errTabAlreadyRecording') },
  { re: /^a captura da aba veio sem áudio$/, render: () => t('errTabNoAudio') },
  { re: /^a aba não tem captura para reaproveitar$/, render: () => t('errTabNoCaptureToReuse') },
  { re: /^getUserMedia da aba: (.*)$/s, render: (m) => t('errTabGetUserMedia', m[1]) },
  { re: /^volume inválido$/, render: () => t('errInvalidVolume') },
  { re: /^sessão (\S+) sem info\.json pendente$/, render: (m) => t('errBlobNoInfo', m[1]) },
  { re: /^sessão (\S+) sem chunks no IndexedDB$/, render: (m) => t('errBlobNoChunks', m[1]) },
]

/** O motivo do offscreen no idioma da interface (ou como veio, se não for um motivo conhecido). */
export function offscreenReason(text: string | null | undefined): string {
  if (!text) return text ?? ''
  for (const rule of RULES) {
    const m = rule.re.exec(text)
    if (m) return rule.render(m)
  }
  return text
}
