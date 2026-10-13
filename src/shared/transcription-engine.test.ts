// A regra que decide a situação visível do motor escolhido (Emenda 22), como função de estado.
//
// O defeito que ela corrige: até a 0.5.0 o rádio era `checked={cfg.ativa}`, então escolher a API sem
// chave não mexia em nada e a tela parecia quebrada. Agora o painel é estado de tela (o clique
// sempre o muda) e esta regra diz, debaixo da opção, em que pé está o motor e o que fazer em
// seguida. Cada caso tem um teste, porque é a frase que a pessoa lê para resolver.
import { describe, expect, it } from 'vitest'
import { t } from './i18n'
import { engineSituation, panelOfActiveEngine, type ApiEngineState, type LocalEngineState } from './transcription-engine'

const API: ApiEngineState = { ativa: false, temChave: false, temPermissao: null, provedor: 'OpenAI' }
const LOCAL: LocalEngineState = { helper: 'presente', disponivel: true, motivo: '', modelo: '/modelos/ggml-large-v3-turbo.bin' }

const api = (patch: Partial<ApiEngineState>) => engineSituation('api', { ...API, ...patch }, LOCAL)
const local = (patch: Partial<LocalEngineState>) => engineSituation('local', API, { ...LOCAL, ...patch })

describe('painel em que a página abre', () => {
  it('é o do motor que está ativo', () => {
    expect(panelOfActiveEngine(false)).toBe('local')
    expect(panelOfActiveEngine(true)).toBe('api')
  })
})

describe('motor por API', () => {
  it('sem chave: diz para colar a chave e não oferece botão (o campo da chave está logo abaixo)', () => {
    const s = api({ temChave: false, temPermissao: true })
    expect(s.kind).toBe('api-sem-chave')
    expect(s.action).toBe(null)
    expect(t(s.key, ...s.subs)).toBe('Cole a chave da API antes de ligar.')
  })

  it('sem chave vale mesmo com a configuração guardada ligada (a tela não pode mentir)', () => {
    expect(api({ ativa: true, temChave: false, temPermissao: true }).kind).toBe('api-sem-chave')
  })

  it('com chave e sem permissão: diz qual provedor falta permitir e dá o botão que pede a permissão', () => {
    const s = api({ temChave: true, temPermissao: false })
    expect(s.kind).toBe('api-sem-permissao')
    expect(s.action).toBe('pedir-permissao')
    expect(t(s.key, ...s.subs)).toBe('Falta permitir o acesso a OpenAI. Sem essa permissão, nada é enviado.')
    expect(t(s.actionKey!, ...s.actionSubs)).toBe('Permitir o acesso a OpenAI e ligar')
  })

  it('a permissão revogada vale mais que o `ativa` guardado: a tela não diz que está ligado', () => {
    expect(api({ ativa: true, temChave: true, temPermissao: false }).kind).toBe('api-sem-permissao')
  })

  it('ligado: diz que as próximas calls vão pela API, sem botão', () => {
    const s = api({ ativa: true, temChave: true, temPermissao: true })
    expect(s.kind).toBe('api-ligado')
    expect(s.tone).toBe('ok')
    expect(s.action).toBe(null)
    expect(t(s.key, ...s.subs)).toBe('Pronto: as próximas calls deste perfil são transcritas pela API.')
  })

  it('pronto e desligado por escolha: diz que nada é enviado e dá o botão de ligar', () => {
    const s = api({ ativa: false, temChave: true, temPermissao: true })
    expect(s.kind).toBe('api-desligado')
    expect(s.action).toBe('ligar')
    expect(t(s.key, ...s.subs)).toBe('Desligado: nenhuma call deste perfil é enviada para a API.')
    expect(t(s.actionKey!, ...s.actionSubs)).toBe('Ligar a transcrição por API')
  })

  it('permissão ainda não lida (null) não acusa falta de permissão', () => {
    expect(api({ ativa: true, temChave: true, temPermissao: null }).kind).toBe('api-ligado')
    expect(api({ ativa: false, temChave: true, temPermissao: null }).kind).toBe('api-desligado')
  })
})

describe('motor local', () => {
  it('helper ainda não conferido: só diz que está conferindo', () => {
    const s = local({ helper: 'verificando' })
    expect(s.kind).toBe('local-verificando')
    expect(s.tone).toBe('neutro')
    expect(t(s.key, ...s.subs)).toBe('Conferindo o helper...')
  })

  it('sem helper: diz que falta instalar e manda para o passo a passo logo abaixo', () => {
    const s = local({ helper: 'ausente' })
    expect(s.kind).toBe('local-sem-helper')
    expect(s.action).toBe(null)
    expect(t(s.key, ...s.subs)).toContain('O passo a passo está aqui embaixo')
  })

  it('pronto: diz o modelo que o helper achou', () => {
    const s = local({ disponivel: true })
    expect(s.kind).toBe('local-pronto')
    expect(s.tone).toBe('ok')
    expect(t(s.key, ...s.subs)).toBe('Pronto para transcrever neste computador, com o modelo /modelos/ggml-large-v3-turbo.bin.')
  })

  it('helper presente e motor indisponível: diz o motivo que o helper deu', () => {
    const s = local({ disponivel: false, motivo: 'modelo não encontrado' })
    expect(s.kind).toBe('local-sem-motor')
    expect(t(s.key, ...s.subs)).toBe('Falta instalar: modelo não encontrado. O passo a passo está aqui embaixo.')
  })

  it('helper presente e resposta ainda não lida (null): conferindo, sem acusar nada', () => {
    expect(local({ disponivel: null }).kind).toBe('local-verificando')
  })

  it('nenhuma situação usa âmbar nem vermelho (o único alerta da seção é o aviso de privacidade)', () => {
    const todas = [
      api({ temChave: false }),
      api({ temChave: true, temPermissao: false }),
      api({ ativa: true, temChave: true, temPermissao: true }),
      api({ temChave: true, temPermissao: true }),
      local({ helper: 'verificando' }),
      local({ helper: 'ausente' }),
      local({ disponivel: true }),
      local({ disponivel: false, motivo: 'x' }),
    ]
    expect([...new Set(todas.map((s) => s.tone))].sort()).toEqual(['acao', 'neutro', 'ok'])
  })

  it('o painel escolhido decide: o mesmo estado dá situações diferentes nos dois painéis', () => {
    const apiState: ApiEngineState = { ativa: false, temChave: true, temPermissao: true, provedor: 'OpenAI' }
    const localState: LocalEngineState = { helper: 'ausente', disponivel: null, motivo: '', modelo: '' }
    expect(engineSituation('api', apiState, localState).kind).toBe('api-desligado')
    expect(engineSituation('local', apiState, localState).kind).toBe('local-sem-helper')
  })
})
