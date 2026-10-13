// Configurações por perfil do Chrome em chrome.storage.local, com os padrões do ESPEC.
//
// - `settings`: tudo o que o usuário edita (profileLabel, autoMeet, autoTeams, minSeconds,
//   autoLeave, vigiaIndicador, vigia, language). O `language` (Emenda 19) também é lido sem zod
//   por src/shared/i18n.ts (`languageOf`), para o content script do vigia não carregar os schemas.
// - `profileId`: chave própria, gerada UMA vez pelo SW (ensureProfileId) e nunca sobrescrita por
//   um salvamento das configurações. É o dono das sessões no helper (Emenda 1).
// - A raiz das gravações NÃO fica aqui: é do helper (get-config/set-root), vale para todos os
//   perfis. Os testes trocam a raiz pelo config.json do helper (GRAVADOR_CONFIG no wrapper).
import { DEFAULT_API_TRANSCRIPTION, normalizeApiTranscription } from './api-transcription'
import { PROFILE_ID_KEY, RECENT_KEY, SETTINGS_KEY } from './constants'
import { settingsSchema, type RecentRecording, type Settings, type VigiaCfg } from './protocol'

export { PROFILE_ID_KEY, RECENT_KEY, SETTINGS_KEY }
export const RECENT_MAX = 20

/** Raiz padrão do helper quando o config.json não existe (o helper aplica; aqui só para a UI). */
export const DEFAULT_ROOT = '~/Documents/Gravações de calls'

/** Os seis números do script original (docs/referencia/vigia-original.js). */
export const SCRIPT_VIGIA = {
  intervaloSeg: 5,
  fracao: 0.3,
  minimo: 2,
  picoParaQueda: 4,
  confirmacoes: 4,
  faltasParaFim: 3,
} as const satisfies Omit<VigiaCfg, 'modo' | 'quantidade'>

/**
 * Padrão do vigia (Emenda 16): o modo `proporcao` com os números do script, que é o comportamento
 * de antes do modo existir. Uma configuração guardada sem `modo` (de antes da 0.3.1) é lida assim,
 * com os números dela: quem já usava continua com a mesma regra.
 */
export const DEFAULT_VIGIA: VigiaCfg = {
  modo: 'proporcao',
  quantidade: 2,
  ...SCRIPT_VIGIA,
}

export const DEFAULT_SETTINGS: Settings = {
  profileId: '',
  profileLabel: '',
  autoMeet: true,
  autoTeams: true,
  minSeconds: 30,
  autoLeave: false,
  vigiaIndicador: true,
  vigia: DEFAULT_VIGIA,
  // Emenda 19: segue o idioma do Chrome, como antes da 0.4.1.
  language: 'auto',
  // Emenda 21: motor por API desligado, como em toda configuração guardada antes da 0.5.0.
  apiTranscription: DEFAULT_API_TRANSCRIPTION,
}

/** Mescla o que estiver salvo com os padrões; campos inválidos voltam ao padrão. */
export function normalizeSettings(raw: unknown, profileId = ''): Settings {
  const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const vigiaRaw = obj.vigia && typeof obj.vigia === 'object' ? obj.vigia : {}
  // Emenda 21: o motor por API nasce desligado; um campo inválido (ou a seção inteira ausente, no
  // que foi guardado antes da 0.5.0) volta ao padrão sem derrubar os outros campos.
  const merged = { ...DEFAULT_SETTINGS, ...obj, vigia: { ...DEFAULT_VIGIA, ...vigiaRaw }, apiTranscription: normalizeApiTranscription(obj.apiTranscription), profileId }
  const parsed = settingsSchema.safeParse(merged)
  if (parsed.success) return parsed.data
  const out: Settings = { ...DEFAULT_SETTINGS, vigia: { ...DEFAULT_VIGIA }, apiTranscription: { ...DEFAULT_API_TRANSCRIPTION }, profileId }
  for (const key of Object.keys(DEFAULT_SETTINGS) as Array<keyof Settings>) {
    if (key === 'vigia' || key === 'profileId' || key === 'apiTranscription') continue
    const field = settingsSchema.shape[key].safeParse((merged as Record<string, unknown>)[key])
    if (field.success) (out as unknown as Record<string, unknown>)[key] = field.data
  }
  const vigia = settingsSchema.shape.vigia.safeParse(merged.vigia)
  if (vigia.success) out.vigia = vigia.data
  else {
    for (const key of Object.keys(DEFAULT_VIGIA) as Array<keyof VigiaCfg>) {
      const field = settingsSchema.shape.vigia.shape[key].safeParse((merged.vigia as Record<string, unknown>)[key])
      if (field.success) (out.vigia as unknown as Record<string, unknown>)[key] = field.data
    }
    // Campos válidos um a um, mas a combinação sairia de uma call no pico: a regra volta à do
    // script (Emenda 10).
    if (!settingsSchema.shape.vigia.safeParse(out.vigia).success) {
      out.vigia = { ...out.vigia, fracao: DEFAULT_VIGIA.fracao, minimo: DEFAULT_VIGIA.minimo, picoParaQueda: DEFAULT_VIGIA.picoParaQueda }
    }
  }
  out.apiTranscription = merged.apiTranscription
  return out
}

export async function loadSettings(): Promise<Settings> {
  const got = await chrome.storage.local.get([SETTINGS_KEY, PROFILE_ID_KEY])
  const id = typeof got[PROFILE_ID_KEY] === 'string' ? (got[PROFILE_ID_KEY] as string) : ''
  return normalizeSettings(got[SETTINGS_KEY], id)
}

/** Salva as configurações do perfil. O profileId não é tocado. */
export async function saveSettings(settings: Omit<Settings, 'profileId'> | Settings): Promise<Settings> {
  const clean = normalizeSettings(settings)
  const { profileId: _ignored, ...rest } = clean
  await chrome.storage.local.set({ [SETTINGS_KEY]: rest })
  return loadSettings()
}

let ensuring: Promise<string> | null = null

/**
 * Garante o profileId deste perfil (só o SW chama). Gera um UUID na primeira vez e nunca mais
 * troca. Serializado no próprio SW, então não há dois geradores.
 */
export function ensureProfileId(): Promise<string> {
  ensuring ??= (async () => {
    const got = await chrome.storage.local.get(PROFILE_ID_KEY)
    const current = got[PROFILE_ID_KEY]
    if (typeof current === 'string' && current) return current
    const id = crypto.randomUUID()
    await chrome.storage.local.set({ [PROFILE_ID_KEY]: id })
    return id
  })()
  return ensuring
}

/** Chama `cb` sempre que as configurações mudarem (de qualquer contexto). */
export function onSettingsChanged(cb: (s: Settings) => void): () => void {
  const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area === 'local' && (SETTINGS_KEY in changes || PROFILE_ID_KEY in changes)) void loadSettings().then(cb)
  }
  chrome.storage.onChanged.addListener(listener)
  return () => chrome.storage.onChanged.removeListener(listener)
}

export async function loadRecent(): Promise<RecentRecording[]> {
  const got = await chrome.storage.local.get(RECENT_KEY)
  const list = got[RECENT_KEY]
  return Array.isArray(list) ? (list as RecentRecording[]) : []
}

export async function pushRecent(item: RecentRecording): Promise<void> {
  const list = (await loadRecent()).filter((r) => r.sessionId !== item.sessionId)
  list.unshift(item)
  await chrome.storage.local.set({ [RECENT_KEY]: list.slice(0, RECENT_MAX) })
}
