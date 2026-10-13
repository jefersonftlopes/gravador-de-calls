// Como instalar o motor local (Emenda 22): a fonte única do passo a passo e do prompt.
// - o prompt é puro: o mesmo idioma dá sempre o mesmo texto (é isso que deixa o teste do
//   docs/PROMPT-INSTALAR.md e do site comparar o arquivo com o código);
// - ele sai nas duas línguas e, nas duas, traz os fatos que não podem faltar: o id da extensão da
//   loja, o endereço do repositório, o endereço do modelo, a proibição do npm install e a prova final;
// - todo rótulo e toda conferência de um passo existem nas duas línguas e saem com os valores.
import { describe, expect, it } from 'vitest'
import { MESSAGE_LOCALES, tIn, type MessageLocale } from './i18n'
import {
  INSTALL_STEPS,
  MODEL_BYTES,
  MODEL_URL,
  PROJECT_DIR,
  PROMPT_END,
  PROMPT_RULES,
  REPO_GIT_URL,
  REPO_URL,
  STORE_EXTENSION_ID,
  installPrompt,
  installerAvailableOn,
  localeTagOf,
  modelSizeLabel,
  stepLabelSubs,
} from './instalar-local'

describe('passos da instalação', () => {
  it('toda chave de rótulo e de conferência existe nas duas línguas', () => {
    const faltando: string[] = []
    for (const locale of MESSAGE_LOCALES) {
      for (const step of INSTALL_STEPS) {
        for (const key of [step.labelKey, step.checkKey]) if (tIn(locale, key) === key) faltando.push(`${locale}:${key}`)
      }
      for (const key of [...PROMPT_RULES, ...PROMPT_END]) if (tIn(locale, key) === key) faltando.push(`${locale}:${key}`)
    }
    expect(faltando).toEqual([])
  })

  it('os sete passos estão na ordem em que a pessoa os executa, e cada um tem comando', () => {
    // A conferência final (Emenda 23) é o último: ela só faz sentido com tudo já instalado.
    expect(INSTALL_STEPS.map((s) => s.id)).toEqual(['mac', 'dependencias', 'projeto', 'modelo', 'helper', 'prova', 'verificar'])
    for (const step of INSTALL_STEPS) expect(step.commands.length, step.id).toBeGreaterThan(0)
  })

  it('o rótulo e a conferência saem com os valores (nada de $1 sobrando nem de valor vazio)', () => {
    for (const locale of MESSAGE_LOCALES) {
      const tag = localeTagOf(locale)
      for (const step of INSTALL_STEPS) {
        const label = tIn(locale, step.labelKey, ...stepLabelSubs(step, tag))
        const check = tIn(locale, step.checkKey, ...(step.checkSubs ?? []))
        expect(label, `${locale}:${step.labelKey}`).not.toMatch(/\$[1-9]/)
        expect(check, `${locale}:${step.checkKey}`).not.toMatch(/\$[1-9]/)
      }
      expect(tIn(locale, 'stepProjectLabel', PROJECT_DIR)).toContain(PROJECT_DIR)
      expect(tIn(locale, 'stepModelCheck', String(MODEL_BYTES))).toContain('1624555275')
      expect(tIn(locale, 'stepHelperCheck', STORE_EXTENSION_ID)).toContain(STORE_EXTENSION_ID)
    }
  })

  it('o tamanho do modelo sai no formato de cada idioma', () => {
    expect(modelSizeLabel('pt-BR')).toBe('1,6 GB')
    expect(modelSizeLabel('en')).toBe('1.6 GB')
    // Um idioma que o Intl não conhece não derruba a tela.
    expect(modelSizeLabel('nao-existe')).toBe('1.6 GB')
    expect(localeTagOf('pt_BR')).toBe('pt-BR')
    expect(localeTagOf('en')).toBe('en')
  })

  it('o instalador existe só para macOS, e "ainda não sei" não acusa nada', () => {
    expect(installerAvailableOn('mac')).toBe(true)
    expect(installerAvailableOn(null)).toBe(true)
    for (const os of ['win', 'linux', 'cros', 'android', 'openbsd', 'fuchsia']) expect(installerAvailableOn(os), os).toBe(false)
  })
})

describe('prompt para o Claude Code', () => {
  it('é puro: o mesmo idioma dá sempre o mesmo texto, e os dois idiomas dão textos diferentes', () => {
    expect(installPrompt('pt_BR')).toBe(installPrompt('pt_BR'))
    expect(installPrompt('en')).toBe(installPrompt('en'))
    expect(installPrompt('pt_BR')).not.toBe(installPrompt('en'))
  })

  const fatos: Array<[string, (p: string, locale: MessageLocale) => void]> = [
    ['o id da extensão da loja', (p) => expect(p).toContain(`npm run instalar -- --id ${STORE_EXTENSION_ID}`)],
    ['o endereço do repositório', (p) => expect(p).toContain(REPO_URL)],
    ['o git clone do repositório na pasta do projeto', (p) => expect(p).toContain(`git clone ${REPO_GIT_URL} ${PROJECT_DIR}`)],
    ['o endereço do modelo', (p) => expect(p).toContain(MODEL_URL)],
    ['o tamanho exato do modelo', (p) => expect(p).toContain(String(MODEL_BYTES))],
    ['a proibição do npm install', (p) => expect(p).toMatch(/npm install/)],
    ['a prova final', (p) => expect(p).toContain('npm run teste:transcricao-real')],
    // Emenda 23: sem este comando, quem instalou não sabe onde as gravações vão cair.
    ['a conferência final', (p) => expect(p).toContain('npm run verificar')],
    ['o pedido de traduzir a saída da conferência', (p, locale) => expect(p).toContain(tIn(locale, 'promptEndExplain'))],
    ['a frase de que não há nada para configurar na extensão', (p, locale) => expect(p).toContain(tIn(locale, 'promptEndEngine'))],
    [
      'os três brew install',
      (p) => {
        for (const formula of ['node', 'whisper-cpp', 'ffmpeg']) expect(p, formula).toContain(`brew install ${formula}`)
      },
    ],
    ['a pasta dos modelos', (p) => expect(p).toContain('Library/Application Support/gravador-de-calls/modelos')],
    ['o tamanho do download em linguagem humana', (p, locale) => expect(p).toContain(modelSizeLabel(localeTagOf(locale)))],
  ]

  for (const locale of MESSAGE_LOCALES) {
    for (const [nome, confere] of fatos) {
      it(`${locale}: traz ${nome}`, () => confere(installPrompt(locale), locale))
    }

    it(`${locale}: traz as seis regras, os sete passos numerados e as três coisas que ele diz no fim`, () => {
      const prompt = installPrompt(locale)
      const tag = localeTagOf(locale)
      expect(prompt.startsWith(tIn(locale, 'promptTitle'))).toBe(true)
      for (const key of PROMPT_RULES) {
        const texto = tIn(locale, key, modelSizeLabel(tag))
        expect(prompt, key).toContain(texto)
      }
      INSTALL_STEPS.forEach((step, i) => {
        expect(prompt, step.id).toContain(`${i + 1}. ${tIn(locale, step.labelKey, ...stepLabelSubs(step, tag))}`)
        for (const command of step.commands) expect(prompt, command).toContain(command)
      })
      for (const key of PROMPT_END) expect(prompt, key).toContain(tIn(locale, key))
      // Nenhum valor ficou sem troca no texto final.
      expect(prompt).not.toMatch(/\$[1-9]/)
    })

    it(`${locale}: cada comando fica numa linha só, indentada, e o texto não abre bloco de código`, () => {
      const prompt = installPrompt(locale)
      const linhas = prompt.split('\n')
      for (const step of INSTALL_STEPS) {
        for (const command of step.commands) expect(linhas, command).toContain(`       ${command}`)
      }
      // O documento e o site embrulham o prompt num bloco: uma cerca aqui dentro fecharia o de fora.
      expect(prompt).not.toContain('```')
      expect(prompt.endsWith('\n')).toBe(true)
    })

    // O fim do prompt manda a pessoa procurar duas frases NA TELA, entre aspas. Quem reescrever o
    // rótulo da opção ou a situação "pronto" sem olhar o prompt deixaria a instrução mentindo, e
    // ela estaria lendo uma tela que não diz mais aquilo. Este teste é esse laço.
    it(`${locale}: as frases que o prompt manda conferir na tela são as frases da tela`, () => {
      const citadas = [...tIn(locale, 'promptEndEngine').matchAll(/"([^"]+)"/g)].map((m) => m[1])
      expect(citadas, 'o fim do prompt cita a opção e a situação').toHaveLength(2)
      const [opcao, situacao] = citadas
      expect(tIn(locale, 'trEngineLocal'), 'rótulo da opção do computador').toContain(opcao)
      expect(tIn(locale, 'trSitLocalReady'), 'situação de pronto para transcrever').toContain(situacao)
    })
  }
})
