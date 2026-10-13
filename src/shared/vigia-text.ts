// Textos do vigia que dependem da regra (Emenda 16), no idioma da interface: a linha da contagem
// (popup e indicador na página, a mesma frase nos dois) e o exemplo das configurações. Testados em
// src/shared/vigia-text.test.ts.
import { t } from './i18n'
import type { VigiaCfg } from './protocol'
import { limiteDoPico, picoDoExemplo, segundosDeConfirmacao } from './vigia-rule'

export interface LinhaDoVigia {
  n: number
  pico: number
  limite: number
  armado: boolean
  seguidas: number
}

/**
 * "6 na call · pico 10 · sai com 5 ou menos", ou "... · sai se você ficar sozinho" quando o limite
 * é 1 (modo sozinho, ou a call ainda não chegou ao ponto em que o modo vale), com
 * "(espera alguém entrar)" antes de a call ter 2 pessoas e "· confirmando 2/4" durante a queda.
 */
export function vigiaCountLine(s: LinhaDoVigia, confirmacoes: number): string {
  const base = s.limite <= 1 ? t('vigiaLineAlone', s.n, s.pico) : t('vigiaLine', s.n, s.pico, s.limite)
  const desarmado = s.armado ? '' : ` ${t('vigiaDisarmed')}`
  const queda = s.seguidas ? ` · ${t('vigiaDrop', s.seguidas, confirmacoes)}` : ''
  return `${base}${desarmado}${queda}`
}

/** "depois de 20 s confirmando" ou "sem esperar". */
function espera(cfg: VigiaCfg): string {
  const s = segundosDeConfirmacao(cfg.confirmacoes, cfg.intervaloSeg)
  return s > 0 ? t('vigiaWaitSeconds', s) : t('vigiaWaitNow')
}

/**
 * A frase de exemplo das configurações, calculada com a mesma regra do vigia:
 * "Exemplo: numa call que chegou a 10 pessoas, o vigia sai quando restarem 5 ou menos, depois de
 * 20 s confirmando. Se você ficar sozinho, sai na hora." e, quando o modo só vale a partir de um
 * tamanho de call, o que acontece abaixo dele.
 */
export function vigiaExample(cfg: VigiaCfg): string {
  const pico = picoDoExemplo(cfg)
  const limite = limiteDoPico(pico, cfg)
  if (limite <= 1) return t('vigiaExampleAlone', pico)
  const frase = t('vigiaExampleLimit', pico, limite, espera(cfg))
  // Até quantas pessoas a call ainda não armou o modo (aí só sai sozinho).
  const ateOnde = cfg.modo === 'quantidade' ? cfg.quantidade : cfg.modo === 'proporcao' ? cfg.picoParaQueda - 1 : 0
  return ateOnde >= 2 ? `${frase} ${t('vigiaExampleSmall', ateOnde)}` : frase
}
