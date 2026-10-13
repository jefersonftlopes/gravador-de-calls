// O documento offscreen é um só por extensão (chrome.offscreen permite um). Serve às duas fatias
// que precisam dele: o destino downloads (montar o Blob, BLOBS) e o modo aba (getUserMedia da
// captura de aba e tocar o som de volta, USER_MEDIA + AUDIO_PLAYBACK). Ninguém chama
// chrome.offscreen.createDocument fora daqui: um segundo createDocument lança.
import type { OffscreenReq, OffscreenResMap } from '../shared/protocol'

/** Caminho do documento no pacote (vite.config.ts, rollupOptions.input.offscreen). */
export const OFFSCREEN_PATH = 'src/offscreen/offscreen.html'

// Literais (e não chrome.offscreen.Reason.*): nada de chrome.* no carregamento do módulo.
const REASONS = ['BLOBS', 'USER_MEDIA', 'AUDIO_PLAYBACK'] as chrome.offscreen.Reason[]

let creating: Promise<void> | null = null

async function exists(): Promise<boolean> {
  const url = chrome.runtime.getURL(OFFSCREEN_PATH)
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT' as chrome.runtime.ContextType], documentUrls: [url] })
  return contexts.length > 0
}

/**
 * Garante o documento offscreen aberto. Idempotente e seguro para chamadas simultâneas: quem
 * chega durante a criação espera a mesma promessa; se outra criação ganhou a corrida, o erro de
 * "só um documento" é engolido depois de conferir que ele existe.
 */
export async function ensureOffscreen(): Promise<void> {
  if (await exists()) return
  creating ??= chrome.offscreen
    .createDocument({
      url: OFFSCREEN_PATH,
      reasons: REASONS,
      justification: 'Montar o arquivo da gravação para Downloads e gravar a aba no modo aba.',
    })
    .catch(async (e: unknown) => {
      if (!(await exists())) throw e
    })
    .finally(() => {
      creating = null
    })
  await creating
}

/** Manda uma mensagem ao offscreen (abrindo-o se preciso) e devolve a resposta tipada. */
export async function sendToOffscreen<K extends OffscreenReq['t']>(req: Extract<OffscreenReq, { t: K }>): Promise<OffscreenResMap[K]> {
  await ensureOffscreen()
  return (await chrome.runtime.sendMessage(req)) as OffscreenResMap[K]
}
