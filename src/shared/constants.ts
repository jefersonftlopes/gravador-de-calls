// Constantes de runtime do protocolo, sem dependências (o MAIN world importa este arquivo).
// Os tipos e os schemas zod ficam em ./protocol.ts.
// Com extensão por exceção declarada: este arquivo entra na cadeia que o manifest.config.ts carrega,
// e o carregador nativo de configuração do Vite exige a extensão nela (ver api-transcription.ts).
import type { DownType, EndReason, SeamId, UpType } from './protocol.ts'

/** Marca das mensagens do aperto de mão MAIN <-> ISOLATED (window.postMessage). */
export const BRIDGE_MARK = '__gravador__'
/** Versão do protocolo da ponte (valor de `__gravador__`). */
export const BRIDGE_VERSION = 1
/**
 * Aperto de mão da ponte MAIN <-> relay (src/main-world/bridge.ts): só estas mensagens passam
 * por window.postMessage; o resto vai pelo MessagePort transferido no open.
 */
export const BRIDGE_OPEN = 'bridge:open'
export const BRIDGE_READY = 'bridge:ready'
export const BRIDGE_ACK = 'bridge:ack'
/** MAIN -> relay, pela porta: "recebi o ack e vou usar esta porta". Depois disso o relay trava nela. */
export const BRIDGE_CONFIRM = 'bridge:confirm'
/** Port do relay (gravações da página). */
export const PORT_SESSION = 'gravador:sessao'
/** Port do offscreen (gravações do modo aba). */
export const PORT_TAB = 'gravador:aba'
/** Port do vigia (sair e fechar a call sozinho, Emendas 2 e 3). */
export const PORT_VIGIA = 'gravador:vigia'
/** Nome do helper de native messaging. */
export const HOST_NAME = 'com.enkode.gravador_calls'
/** Versão do script do MAIN world, reportada no `hello`. */
export const HOOK_VERSION = '0.1.0'
/** Marca de instalação única por realm no MAIN world. */
export const HOOK_SYMBOL = 'gravador.hook'

/** Chaves do chrome.storage.local. */
export const SETTINGS_KEY = 'settings'
export const PROFILE_ID_KEY = 'profileId'
export const RECENT_KEY = 'recent'
/**
 * Emenda 21: a chave da API de transcrição, numa chave de armazenamento PRÓPRIA, fora de
 * `settings`. Assim ela não passa pelo ui:save-settings (que manda o objeto inteiro das
 * configurações), não vai para o ui:state, não entra no info.json e não aparece em erro nenhum.
 */
export const API_KEY_STORAGE_KEY = 'apiTranscriptionKey'
/** Emenda 21: o estado da transcrição por API de cada gravação recente (o que o popup mostra). */
export const API_TRANSCRIPTION_STATE_KEY = 'apiTranscriptionState'

/** Formato e parâmetros fixos da gravação. */
export const RECORDING_MIME = 'audio/webm;codecs=opus'
export const RECORDING_KBPS = 32
export const RECORDING_TIMESLICE_MS = 5000
/**
 * Atraso da linha do mixer (src/main-world/capture/mixer.ts): o áudio gravado sai este tanto
 * depois do sinal ao vivo. A linha do tempo dos falantes é deslocada por ele (Emenda 18).
 */
export const MIXER_DELAY_MS = 1500

/** Linha do tempo dos falantes (Emenda 18): de onde veio cada intervalo. */
export const SPEAKER_SOURCES = ['csrc', 'dcrpc', 'dsh', 'dom', 'microfone'] as const
/** Arquivo da linha do tempo na pasta da call (o helper só aceita este nome a mais no finalize). */
export const SPEAKERS_FILE = 'falantes.json'
/** Limite de intervalos de uma gravação (uma call de horas com troca a cada poucos segundos cabe). */
export const MAX_SPEAKER_INTERVALS = 20000
/**
 * Prefixo das chaves provisórias de quem fala sem nome ainda (CSRC sem a roster): nunca aparece
 * num nome exibido. O SW troca pelo nome que chegou depois (`aliases`) ou por "Participante N".
 */
export const SPEAKER_KEY_PREFIX = '\u0001'

export const SEAM_IDS: readonly SeamId[] = ['receivers', 'elements', 'sources', 'output']

/** Nome de cada seam no info.json. */
export const SEAM_LABELS: Record<SeamId, string> = {
  receivers: 'receptores',
  elements: 'elementos',
  sources: 'fontes',
  output: 'saída',
}

export const END_REASONS = [
  'saida-automatica',
  'saiu-da-call',
  'call-encerrada',
  'fora-da-call',
  'aba-fechada',
  'navegou',
  'pagehide',
  'parado-pelo-usuario',
  'interrompida',
  'erro',
] as const satisfies readonly EndReason[]

export const UP_TYPES = [
  'hello',
  'session:start',
  'session:resume',
  'session:chunk',
  'session:meta',
  'session:diag',
  'session:speakers',
  'session:end',
] as const satisfies readonly UpType[]

export const DOWN_TYPES = [
  'session:accepted',
  'session:rejected',
  'chunk:ack',
  'session:stop',
  'settings',
] as const satisfies readonly DownType[]

/** Modos da regra de saída do vigia (Emenda 16). */
export const VIGIA_MODOS = ['sozinho', 'proporcao', 'quantidade'] as const

/**
 * Idioma da interface escolhido nas configurações (Emenda 19): `auto` segue o idioma do Chrome
 * (chrome.i18n, como antes da 0.4.1); os outros são as pastas de public/_locales.
 */
export const UI_LANGUAGES = ['auto', 'pt_BR', 'en'] as const

/** SW -> relay da frame do topo: a página toca o som num dispositivo de saída próprio? (Emenda 11) */
export const PAGE_OUTPUT_QUERY = 'gravador:saida-da-pagina'

/** Checagem leve (sem zod) usada pelo relay e pelo MAIN world. */
export function isUpType(t: unknown): t is UpType {
  return typeof t === 'string' && (UP_TYPES as readonly string[]).includes(t)
}
export function isDownType(t: unknown): t is DownType {
  return typeof t === 'string' && (DOWN_TYPES as readonly string[]).includes(t)
}
