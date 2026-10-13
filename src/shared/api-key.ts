// A chave da API do provedor de transcrição (Emenda 21). Arquivo pequeno de propósito: é o ÚNICO
// lugar que lê e escreve a chave.
//
// Decisões, que os testes cobram:
// - a chave mora numa chave de armazenamento PRÓPRIA (`apiTranscriptionKey`), nunca dentro de
//   `settings`: assim ela não passa pelo ui:save-settings (que manda o objeto inteiro), não vai
//   para o ui:state, não entra no info.json e não aparece em nenhuma mensagem de erro;
// - quem escreve é a página de configurações, direto no chrome.storage.local, como o idioma faz
//   desde a Emenda 19 (`saveStored`): a chave não passa por mensagem nenhuma ao service worker;
// - quem lê é só o service worker, no instante de montar o cabeçalho Authorization;
// - as telas nunca recebem a chave: `apiKeyHint` devolve só o fim dela, para a pessoa reconhecer
//   qual colou.
import { API_KEY_STORAGE_KEY } from './constants'

export { API_KEY_STORAGE_KEY }

/** Uma chave maior que isto não é uma chave (evita guardar um arquivo colado por engano). */
export const API_KEY_MAX = 400

/** A chave guardada neste perfil ('' quando não há). Só o service worker chama. */
export async function loadApiKey(): Promise<string> {
  try {
    const got = await chrome.storage.local.get(API_KEY_STORAGE_KEY)
    const v = got[API_KEY_STORAGE_KEY]
    return typeof v === 'string' ? v.trim() : ''
  } catch {
    return ''
  }
}

/** Guarda a chave neste perfil. Vazio apaga (o mesmo caminho do botão "Apagar a chave"). */
export async function saveApiKey(key: string): Promise<void> {
  const clean = key.trim().slice(0, API_KEY_MAX)
  if (!clean) return clearApiKey()
  await chrome.storage.local.set({ [API_KEY_STORAGE_KEY]: clean })
}

export async function clearApiKey(): Promise<void> {
  await chrome.storage.local.remove(API_KEY_STORAGE_KEY)
}

/**
 * O que a tela mostra de uma chave guardada: nunca a chave inteira. Só o tamanho e os quatro
 * últimos caracteres, que bastam para a pessoa reconhecer qual chave colou.
 */
export function apiKeyHint(key: string): string {
  const k = key.trim()
  if (!k) return ''
  return `••••${k.slice(-4)}`
}

/** Chama `cb` quando a chave deste perfil for guardada ou apagada (de qualquer contexto). */
export function onApiKeyChanged(cb: () => void): () => void {
  const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area === 'local' && API_KEY_STORAGE_KEY in changes) cb()
  }
  chrome.storage.onChanged.addListener(listener)
  return () => chrome.storage.onChanged.removeListener(listener)
}
