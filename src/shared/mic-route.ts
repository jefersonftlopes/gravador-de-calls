// Roteamento da voz do usuário entre as abas (Emenda 25): QUAIS abas gravam o microfone agora, e
// QUANDO a troca vale no áudio. Pura e sem zod, como ./mic-gate.ts, ./vigia-rule.ts e ./speakers.ts:
// roda no service worker (src/background/mic.ts) e no vitest sem navegador nenhum.
//
// Por que existe: o nosso getUserMedia dá UM microfone para o navegador inteiro, não um por aba. Com
// três ou quatro calls abertas ao mesmo tempo (o motivo de a extensão existir), a voz dele pertence
// à aba cujo ENVIO está vivo:
//
// - uma aba com o portão aberto: só ela recebe a voz;
// - duas abas com o portão aberto ao mesmo tempo: as duas calls estão de fato ouvindo ele, e as
//   duas recebem a voz (não há como escolher uma, e esconder de uma delas seria mentir);
// - nenhuma aba com o portão aberto: ninguém recebe, e nada é gravado.
//
// Quem diz se o microfone está aberto numa aba é o portão da Emenda 24 (./mic-gate.ts), lido das
// faixas da PÁGINA daquela aba. O nosso getUserMedia é independente da página, então sem a faixa da
// página não existe sinal de mudo: aí o portão fecha por `sem-faixa` e NÃO se grava. Melhor não
// gravar do que gravar sem saber se a pessoa está muda.
//
// O PADRÃO É FECHADO também aqui: um relato que parou de chegar (aba em segundo plano travada, frame
// que morreu, SW que perdeu o Port) vale no máximo MIC_REPORT_STALE_MS e depois conta como fechado.
import { MIXER_DELAY_MS } from './constants'
import { micGateDecide, type MicGateReason, type MicTrackState } from './mic-gate'

/**
 * O que uma aba relatou: o estado observado de cada faixa de microfone dela
 * (`registry.micGateInputs()`), e não a decisão, para quem decide ser um só.
 */
export interface MicTabReport {
  tabId: number
  tracks: readonly MicTrackState[]
  /** Instante em que o relato chegou (`Date.now()` do SW). */
  at: number
  /**
   * Tempo entre esta leitura e a anterior, na frame. É o quanto a troca pode ter acontecido ANTES
   * desta leitura, e é o que deixa um fechamento valer para o áudio de trás.
   */
  sinceMs: number
}

/**
 * Quanto tempo um relato vale. A frame manda um a cada MIC_REPORT_EVERY_MS (1 s) mesmo sem troca,
 * então três relatos perdidos fecham o portão.
 */
export const MIC_REPORT_STALE_MS = 3000

/** Intervalo do relato de rotina da frame (sem troca nenhuma). */
export const MIC_REPORT_EVERY_MS = 1000

export interface MicTabRoute {
  tabId: number
  open: boolean
  /** A condição que fechou (./mic-gate.ts); `null` quando abriu. */
  reason: MicGateReason | null
  /** Quanto esperar antes de aplicar no grafo de áudio (ver `micEdgeWaitMs`). */
  waitMs: number
}

export interface MicRouteDecision {
  /** Uma entrada por aba relatada, em ordem crescente de tabId. */
  tabs: MicTabRoute[]
  /** As abas que recebem a voz agora, em ordem crescente. */
  open: number[]
}

/**
 * Quanto esperar antes de ligar ou desligar o nó do microfone daquela aba, para a troca valer no
 * áudio de `delayMs` atrás.
 *
 * O gravador do microfone fica depois de um atraso de `delayMs` (o mesmo do mixer da call), então o
 * que chega nele agora é o áudio de `delayMs` atrás. Precedente: o seletor do mixer
 * (src/main-world/capture/mixer.ts) também fica depois do atraso, e por isso uma troca de fonte
 * vale para o áudio de até 1,5 s atrás.
 *
 * - FECHAR: a pessoa mutou em algum instante entre a leitura anterior e esta. O pior caso (o mais
 *   antigo) é a leitura anterior, `ageMs` atrás, então desligar em `delayMs - ageMs` corta o áudio
 *   a partir dali: nada do trecho mudo entra no arquivo, e o preço é perder até `delayMs` de fala
 *   legítima antes do mudo. Um relato velho (sem idade confiável) desliga na hora, que corta mais.
 * - ABRIR: o contrário. A pessoa desmutou em algum instante entre as duas leituras, e o pior caso
 *   (o que grava o que não devia) é a leitura anterior; esperar `delayMs` inteiro liga o nó no
 *   áudio de AGORA, então nada de antes do desmudo entra. O preço é perder o começo da primeira
 *   palavra (até uma leitura).
 *
 * Nos dois lados o erro cai para o lado de gravar menos, que é o lado seguro.
 */
export function micEdgeWaitMs(open: boolean, ageMs: number, delayMs: number = MIXER_DELAY_MS): number {
  const limit = Math.max(0, delayMs)
  if (open) return limit
  const age = Number.isFinite(ageMs) && ageMs > 0 ? ageMs : 0
  return Math.max(0, Math.min(limit, limit - age))
}

/**
 * A decisão de roteamento: para cada aba que relatou, se ela grava a voz agora e quando a troca
 * vale. Sem estado: quem compara com o que já está aplicado (e só manda comando quando muda) é o
 * src/background/mic.ts.
 */
export function micRouteDecide(reports: readonly MicTabReport[], now: number, delayMs: number = MIXER_DELAY_MS): MicRouteDecision {
  const tabs: MicTabRoute[] = []
  for (const r of [...reports].sort((a, b) => a.tabId - b.tabId)) {
    // Relato velho: o padrão é fechado, e sem idade confiável a troca vale na hora (corta mais).
    const stale = !Number.isFinite(r.at) || now - r.at > MIC_REPORT_STALE_MS
    if (stale) {
      tabs.push({ tabId: r.tabId, open: false, reason: 'desconhecido', waitMs: 0 })
      continue
    }
    const d = micGateDecide(r.tracks)
    tabs.push({ tabId: r.tabId, open: d.open, reason: d.reason, waitMs: micEdgeWaitMs(d.open, r.sinceMs, delayMs) })
  }
  return { tabs, open: tabs.filter((t) => t.open).map((t) => t.tabId) }
}

/**
 * `settings.micRecording` lido do objeto cru, sem zod: o relay (src/content/relay.ts) não carrega
 * os schemas, e o padrão de um perfil que nunca ligou o recurso (ou de qualquer configuração
 * guardada antes da 0.6.0) é DESLIGADO. Precedente: `autoAllowed` em ./consent.ts e `languageOf`
 * em ./i18n.ts, que leem as mesmas configurações do mesmo jeito.
 */
export function micRecordingOf(raw: unknown): boolean {
  return !!raw && typeof raw === 'object' && (raw as { micRecording?: unknown }).micRecording === true
}
