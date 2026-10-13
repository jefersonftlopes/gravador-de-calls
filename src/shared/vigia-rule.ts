// Regra de saída do vigia (Emenda 16, 0.3.1): o limite de pessoas para sair em cada modo, e as
// escolhas que as configurações oferecem. Pura e sem zod: roda no vigia (content script), no
// popup e nas configurações, e é testada em src/content/vigia/regua.test.ts e vigia-rule.test.ts.
//
// O limite é o número de pessoas (contando você) com que o vigia sai, depois das confirmações.
// Limite 1 quer dizer "só sozinho". Ficar sozinho depois de a call ter 2 ou mais sai na hora em
// qualquer modo; isso é da régua (regua.ts), não daqui.
import type { VigiaCfg } from './protocol'

/** Limite de quando o modo ainda não vale para a call: só sai sozinho. */
const SO_SOZINHO = 1

/**
 * Limite de saída para um pico.
 * - `proporcao` (o `limite` do script): numa call que chegou a `picoParaQueda`,
 *   max(minimo, floor(pico * fracao)); abaixo disso, só sozinho.
 * - `quantidade`: numa call que já teve mais que `quantidade` pessoas, `quantidade`; senão,
 *   só sozinho (uma call que nunca passou de 3 não sai "com 3 ou menos" no pico).
 * - `sozinho`: sempre só sozinho.
 * Um modo desconhecido segue a regra do script, que é o que valia antes do modo existir.
 */
export function limiteDoPico(pico: number, cfg: VigiaCfg): number {
  if (cfg.modo === 'sozinho') return SO_SOZINHO
  if (cfg.modo === 'quantidade') return pico > cfg.quantidade ? cfg.quantidade : SO_SOZINHO
  return pico >= cfg.picoParaQueda ? Math.max(cfg.minimo, Math.floor(pico * cfg.fracao)) : SO_SOZINHO
}

/** As frações oferecidas em "quando sair boa parte das pessoas" (0,3 é a do script). */
export const FRACAO_ESCOLHAS: readonly number[] = [0.75, 0.5, 0.3, 0.25]

/** Os tempos oferecidos em "confirmar antes de sair", em segundos (0 é "na hora"). */
export const CONFIRMAR_SEGUNDOS: readonly number[] = [0, 10, 20, 30]

/** Leituras seguidas que dão esse tempo de confirmação (pelo menos 1: "na hora"). */
export function confirmacoesPara(segundos: number, intervaloSeg: number): number {
  return segundos <= 0 ? 1 : Math.max(1, Math.round(segundos / intervaloSeg))
}

/** Quanto tempo as confirmações levam, em segundos (1 leitura é "na hora": 0). */
export function segundosDeConfirmacao(confirmacoes: number, intervaloSeg: number): number {
  return confirmacoes <= 1 ? 0 : Number((confirmacoes * intervaloSeg).toFixed(1))
}

/**
 * As opções de "confirmar antes de sair" para um intervalo de leitura, como número de
 * confirmações (o valor que o formulário guarda) e os segundos que ele dá. A configuração atual
 * entra mesmo fora da lista (um intervalo diferente, ou o número escolhido à mão antes).
 */
export function opcoesDeConfirmacao(intervaloSeg: number, atual: number): Array<{ confirmacoes: number; segundos: number }> {
  const valores = new Set(CONFIRMAR_SEGUNDOS.map((s) => confirmacoesPara(s, intervaloSeg)))
  if (Number.isInteger(atual) && atual >= 1) valores.add(atual)
  return [...valores].sort((a, b) => a - b).map((c) => ({ confirmacoes: c, segundos: segundosDeConfirmacao(c, intervaloSeg) }))
}

/** As frações oferecidas, com a atual quando ela não for uma delas. */
export function opcoesDeFracao(atual: number): number[] {
  const lista = [...FRACAO_ESCOLHAS]
  if (Number.isFinite(atual) && atual > 0 && atual < 1 && !lista.includes(atual)) lista.push(atual)
  return lista.sort((a, b) => b - a)
}

/** O pico do exemplo das configurações: 10 pessoas, ou mais quando o modo só vale acima disso. */
export function picoDoExemplo(cfg: VigiaCfg): number {
  if (cfg.modo === 'quantidade') return Math.max(10, cfg.quantidade * 2)
  if (cfg.modo === 'proporcao') return Math.max(10, cfg.picoParaQueda)
  return 10
}
