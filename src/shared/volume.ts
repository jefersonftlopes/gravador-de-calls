// Volume por aba (Emenda 14): regras puras usadas pelo popup, pelo SW e pelo offscreen.
//
// O volume é um fator de ganho: 1 é o som original da aba (100%), 0 é mudo e 2 é o dobro (200%).
// Ele só mexe no que o usuário ouve; nenhuma gravação passa por ele.

export const VOLUME_MIN = 0
export const VOLUME_MAX = 2
/** Passo do controle do popup (5%). */
export const VOLUME_STEP = 0.05
/** O som original da aba: nesse valor, sem modo aba, a captura de volume é desfeita. */
export const VOLUME_NATIVE = 1

/**
 * Volume pedido como fator de 0 a 2, arredondado ao centésimo (o controle anda de 5 em 5%).
 * Número que não é finito (NaN, Infinity, texto) não vale: null.
 */
export function clampVolume(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null
  const c = Math.min(VOLUME_MAX, Math.max(VOLUME_MIN, v))
  return Math.round(c * 100) / 100
}

/** É o som original (100%)? Tolera o arredondamento do controle. */
export function isNativeVolume(v: number): boolean {
  return Math.abs(v - VOLUME_NATIVE) < 0.005
}

/** Ganho que se ouve: a devolução do modo aba desligada cala a aba, qualquer que seja o volume. */
export function audibleGain(volume: number, replay: boolean): number {
  return replay ? volume : 0
}

/**
 * O volume pode começar nesta aba? Só páginas http e https: o Chrome não captura chrome://,
 * páginas de extensão nem a loja. URL desconhecida (sem permissão nem activeTab) também fica de
 * fora. Uma aba que já está com o volume mostra o controle mesmo fora delas (a captura sobrevive à
 * navegação; ver TabVolume no popup).
 */
export function volumeEligibleUrl(url: string | undefined): boolean {
  if (!url) return false
  try {
    const { protocol } = new URL(url)
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

/** Texto do valor no popup: 1.5 vira "150%". */
export function volumeLabel(v: number): string {
  return `${Math.round(v * 100)}%`
}

/** Modo da captura de uma aba no offscreen (Emenda 14). */
export type TabAudioMode = 'volume' | 'gravando'

/** O que o SW faz com um volume novo, dado o que a aba tem agora. */
export type VolumeAction = 'nada' | 'iniciar' | 'ajustar' | 'parar'

/**
 * Decisão do SW para um volume novo (Emenda 14):
 * - sem captura: 100% não faz nada; outro valor abre uma captura só de volume;
 * - captura só de volume: 100% desfaz a captura (a aba volta ao caminho de som dela); outro valor ajusta;
 * - modo aba gravando: sempre só ajusta o ganho (100% nunca para a gravação).
 */
export function decideVolume(mode: TabAudioMode | null, volume: number): VolumeAction {
  if (mode === 'gravando') return 'ajustar'
  if (mode === 'volume') return isNativeVolume(volume) ? 'parar' : 'ajustar'
  return isNativeVolume(volume) ? 'nada' : 'iniciar'
}
