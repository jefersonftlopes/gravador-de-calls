// Régua do vigia (Emenda 2): porte fiel de `criarRegua` do script do usuário
// (docs/referencia/vigia-original.js). Função pura, testada com vitest (regua.test.ts compara
// com o próprio código do script, lido do arquivo de referência).
//
//   pico     = maior contagem já vista
//   armado   = pico >= 2
//   limite   = limiteDoPico(pico, cfg) (src/shared/vigia-rule.ts; no modo `proporcao` é o do
//              script: pico >= picoParaQueda ? max(minimo, floor(pico * fracao)) : 1)
//   seguidas = leituras seguidas com n <= limite (leitura null não zera nem conta)
//   sair     = (armado e n === 1) ou seguidas >= confirmacoes
//
// Diferenças do script: a configuração é lida a cada leitura (o script lia o CFG global uma
// vez), então "mudou a configuração com a call aberta: o vigia aplica na próxima leitura"
// (Emenda 2) vale sem zerar o pico; e o limite depende do modo escolhido (Emenda 16). No modo
// `proporcao` a régua é igual à do script, leitura a leitura.
import type { VigiaCfg } from '../../shared/protocol'
import { limiteDoPico } from '../../shared/vigia-rule'

export { limiteDoPico }

export interface LeituraRegua {
  limite: number
  armado: boolean
  sair: boolean
}

export interface Regua {
  readonly pico: number
  readonly seguidas: number
  ver(n: number | null): LeituraRegua
}

export function criarRegua(cfg: VigiaCfg | (() => VigiaCfg)): Regua {
  const atual = typeof cfg === 'function' ? cfg : () => cfg
  let pico = 0
  let seguidas = 0
  return {
    get pico() {
      return pico
    },
    get seguidas() {
      return seguidas
    },
    ver(n) {
      const c = atual()
      if (n != null) pico = Math.max(pico, n)
      const armado = pico >= 2
      const limite = limiteDoPico(pico, c)
      if (n != null) seguidas = armado && n <= limite ? seguidas + 1 : 0
      const sozinho = armado && n === 1
      return { limite, armado, sair: sozinho || seguidas >= c.confirmacoes }
    },
  }
}
