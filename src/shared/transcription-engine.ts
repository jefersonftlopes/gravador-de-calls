// Qual motor de transcrição a tela está configurando, e em que pé ele está (Emenda 22).
//
// O defeito que isto corrige: até a 0.5.0 o rádio do motor era controlado por
// `Settings.apiTranscription.ativa`, então ele significava duas coisas ao mesmo tempo, "o que eu
// quero configurar" e "o que está ativo". Clicar em "A API da OpenAI, com a sua chave" sem a chave
// guardada não mexia em nada: o `enableApi` saía na primeira linha, `ativa` continuava false, o
// rádio voltava sozinho para "O seu computador" e a única pista era um parágrafo no fim da seção.
// Quem clicava concluía que o rádio estava quebrado.
//
// A separação:
// - `EnginePanel` é estado de TELA. O clique sempre o muda, na hora, sem depender de chave, de
//   permissão nem do helper.
// - `Settings.apiTranscription.ativa` continua sendo o motor realmente ativo, e só vira true com a
//   chave guardada e a permissão de host concedida. Nada do comportamento de envio muda: as quatro
//   portas da Emenda 21 (motor desligado, sem chave, sem permissão, endereço fora da origem
//   declarada) ficam como estão.
//
// `engineSituation` é a regra pura que decide o que aparece DEBAIXO da opção escolhida: uma frase e,
// quando há o que fazer, um botão. Ela é função de estado, então o teste mede cada caso sem browser.
import type { MessageKey } from './i18n'

/** O painel que a tela está mostrando (estado de tela, não o motor ativo). */
export type EnginePanel = 'local' | 'api'

/** O painel em que a página abre: o do motor que está ativo. */
export function panelOfActiveEngine(apiAtiva: boolean): EnginePanel {
  return apiAtiva ? 'api' : 'local'
}

/** Em que pé está o motor do painel escolhido. */
export type EngineSituationKind =
  | 'api-ligado'
  | 'api-sem-chave'
  | 'api-sem-permissao'
  | 'api-desligado'
  | 'local-pronto'
  | 'local-sem-helper'
  | 'local-sem-motor'
  | 'local-verificando'

/**
 * Tom da frase. Nunca âmbar nem vermelho: o que falta instalar é o uso normal de quem baixou da
 * loja, não um erro (Emenda 15). O único alerta da seção continua sendo o aviso de privacidade do
 * motor por API, e `tests/e2e/interface.spec.ts` cobra que não haja outro.
 */
export type EngineTone = 'ok' | 'acao' | 'neutro'

/** O botão que resolve o que falta, quando existe. Os dois pedem a permissão e ligam o motor. */
export type EngineAction = 'pedir-permissao' | 'ligar' | null

export interface EngineSituation {
  kind: EngineSituationKind
  tone: EngineTone
  key: MessageKey
  subs: string[]
  action: EngineAction
  /** Rótulo do botão (quando há botão). */
  actionKey: MessageKey | null
  actionSubs: string[]
}

/** O que a tela sabe do motor por API. A chave em si nunca chega aqui: só se ela existe. */
export interface ApiEngineState {
  /** `Settings.apiTranscription.ativa`: o motor realmente ativo. */
  ativa: boolean
  /** Há chave guardada neste perfil? (a tela só recebe a dica, `apiKeyHint`) */
  temChave: boolean
  /** `chrome.permissions.contains` da origem do endereço; `null` enquanto não foi lido. */
  temPermissao: boolean | null
  /** Nome do provedor, para a frase da permissão (nome próprio, não traduzido). */
  provedor: string
}

/** O que a tela sabe do motor local (o helper e o que ele achou). */
export interface LocalEngineState {
  /** `verificando` até o ui:state responder. */
  helper: 'verificando' | 'ausente' | 'presente'
  /** `transcription-status.disponivel`; `null` enquanto o helper não respondeu. */
  disponivel: boolean | null
  /** O motivo do helper, JÁ no idioma da interface (quem traduz é quem chama, com helperReason). */
  motivo: string
  /** O modelo que o helper achou. */
  modelo: string
}

/**
 * A situação do painel escolhido. A ordem das conferências é a ordem em que a pessoa resolve, e a
 * permissão vem antes de `ativa` de propósito: uma permissão revogada em chrome://extensions deixa
 * `ativa` true no storage, o service worker não envia nada (porta da Emenda 21) e a tela não pode
 * dizer que está ligado.
 */
export function engineSituation(panel: EnginePanel, api: ApiEngineState, local: LocalEngineState): EngineSituation {
  const none: Pick<EngineSituation, 'action' | 'actionKey' | 'actionSubs'> = { action: null, actionKey: null, actionSubs: [] }
  if (panel === 'api') {
    if (!api.temChave) return { kind: 'api-sem-chave', tone: 'acao', key: 'trApiKeyMissing', subs: [], ...none }
    if (api.temPermissao === false)
      return {
        kind: 'api-sem-permissao',
        tone: 'acao',
        key: 'trSitApiNoPermission',
        subs: [api.provedor],
        action: 'pedir-permissao',
        actionKey: 'trSitGrant',
        actionSubs: [api.provedor],
      }
    if (api.ativa) return { kind: 'api-ligado', tone: 'ok', key: 'trApiReady', subs: [], ...none }
    return { kind: 'api-desligado', tone: 'acao', key: 'trApiOff', subs: [], action: 'ligar', actionKey: 'trSitTurnOn', actionSubs: [] }
  }
  if (local.helper === 'verificando') return { kind: 'local-verificando', tone: 'neutro', key: 'helperChecking', subs: [], ...none }
  if (local.helper === 'ausente') return { kind: 'local-sem-helper', tone: 'acao', key: 'trSitLocalNoHelper', subs: [], ...none }
  if (local.disponivel === true) return { kind: 'local-pronto', tone: 'ok', key: 'trSitLocalReady', subs: [local.modelo], ...none }
  if (local.disponivel === false) return { kind: 'local-sem-motor', tone: 'acao', key: 'trSitLocalMissing', subs: [local.motivo], ...none }
  return { kind: 'local-verificando', tone: 'neutro', key: 'helperChecking', subs: [], ...none }
}
