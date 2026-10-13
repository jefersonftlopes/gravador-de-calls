// Configurações (AC9, AC15, AC17, AC18).
// - Pasta das gravações: é do helper e vale para TODOS os perfis. Lida pelo ping do helper (que
//   devolve a raiz do config.json, como o get-config) e trocada com check-root e depois set-root;
//   "Escolher..." abre o seletor do macOS pelo helper (choose-folder).
// - O resto é deste perfil (chrome.storage.local): nome do perfil, gravação automática por
//   plataforma, duração mínima, sair e fechar sozinho (vigia): a chave, "Quando sair" em três
//   escolhas por extenso, a confirmação em segundos, o exemplo ao vivo, o indicador na página e os
//   números raros em "Ajustes finos" (Emenda 16).
// - Transcrição (Emenda 13): também é do helper e vale para todos os perfis. Ligar ou desligar,
//   motor, modelo (caminho ou "Escolher..." pelo seletor do macOS; vazio, o helper procura),
//   idioma, e a linha que diz se dá para transcrever e, se não, por quê. Formulário próprio
//   (react-hook-form), salvo no helper por "Salvar transcrição".
// - Atalho do modo aba como o Chrome mostra (chrome.commands.getAll) e onde trocar.
// - Como instalar o helper.
// - Emenda 15: sem o helper (o jeito normal da loja), a pasta diz só "Salvando em Downloads/<pasta>"
//   e a escolha da pasta, a transcrição e o helper ficam juntos em "Avançado", como recursos
//   opcionais que exigem o helper local. Com o helper (instalado, mesmo que não abra), a página é a
//   de antes. Todos os textos passam por t().
// - Emenda 19: o idioma da interface no topo (preferência geral). Mudar o seletor troca o idioma
//   da página na hora e salva sozinho, sem o Salvar do formulário e sem perder o que já foi digitado
//   nos outros campos; as mensagens guardadas na tela são funções, para trocarem junto.
//
// A página não fala com o SW em laço: uma leitura ao abrir e uma por ação (o teste de queda do
// SW usa esta página para derrubar o SW, e um laço o acordaria).
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useForm, type FieldValues, type Path, type UseFormReturn } from 'react-hook-form'
import type { HelperStatus, Settings, TranscriptionConfig, TranscriptionSettingsState, UiLanguage, UiState, VigiaModo } from '../shared/protocol'
import { apiKeyHint, clearApiKey, loadApiKey, saveApiKey } from '../shared/api-key'
import {
  DEFAULT_API_TRANSCRIPTION,
  dollarsPerHour,
  endpointOf,
  isAllowedEndpoint,
  maxBytesOf,
  originPatternOf,
  providerOf,
  type ApiTranscriptionConfig,
} from '../shared/api-transcription'
import { WELCOME_PAGE } from '../shared/consent'
import { downloadsPath, helperProblem } from '../shared/helper-status'
import { helperReason } from '../shared/helper-reasons'
import { currentMessageLocale, downloadsFolderName, messageLocale, onLanguageChange, setLanguage, t, uiLanguage } from '../shared/i18n'
import { INSTALL_STEPS, REPO_URL, installPrompt, installerAvailableOn, stepLabelSubs } from '../shared/instalar-local'
import { engineSituation, panelOfActiveEngine, type EnginePanel, type EngineTone } from '../shared/transcription-engine'
import { useLanguage } from '../shared/page-language'
import { profileFolder } from '../shared/naming'
import { DEFAULT_SETTINGS, DEFAULT_VIGIA, loadSettings } from '../shared/settings'
import { uiCall } from '../shared/ui-client'
import { opcoesDeConfirmacao, opcoesDeFracao } from '../shared/vigia-rule'
import { vigiaExample } from '../shared/vigia-text'
import { VersionBanner, useUnhandledUiErrors } from '../shared/VersionBanner'
import {
  TRANSCRIPTION_LANGUAGES,
  UI_LANGUAGE_OPTIONS,
  VIGIA_FINE_FIELDS,
  cleanProfileForm,
  confirmLabel,
  profileFormDefaults,
  fractionLabel,
  cleanTranscriptionForm,
  profileFormResolver,
  profileFormSchema,
  transcriptionFormResolver,
  type ProfileForm,
} from './form'

const TAB_COMMAND = 'gravar-aba'

const input = 'rounded-md border border-neutral-300 bg-white px-2 py-1 dark:border-neutral-600 dark:bg-neutral-800'
const button = 'rounded-md border border-neutral-300 px-3 py-1 hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-600 dark:hover:bg-neutral-800'

function Section({ title, children, testId }: { title: string; children: ReactNode; testId?: string }) {
  return (
    <section data-testid={testId} className="space-y-3 rounded-xl border border-neutral-200 p-4 dark:border-neutral-700">
      <h2 className="text-base font-semibold">{title}</h2>
      {children}
    </section>
  )
}

function FieldError({ message }: { message?: string }) {
  return message ? <span className="block text-xs text-red-700 dark:text-red-400">{message}</span> : null
}

/**
 * Mensagem de uma ação na tela. O texto é uma função, lida a cada render: trocado o idioma
 * (Emenda 19), a mensagem que já está na tela troca junto.
 */
type RootMessage = { ok: boolean; text: () => string } | null

/** As configurações guardadas deste perfil, como o ui:save-settings recebe. */
type StoredSettings = Omit<Settings, 'profileId'>

/** Os campos com erro (`vigia.fracao`...), para validar de novo. */
function errorPaths(errors: object, prefix = ''): string[] {
  return Object.entries(errors).flatMap(([key, value]) => {
    if (key === 'ref' || !value || typeof value !== 'object') return []
    const path = prefix ? `${prefix}.${key}` : key
    return typeof (value as { message?: unknown }).message === 'string' ? [path] : errorPaths(value as object, path)
  })
}

/**
 * Emenda 19: o resolver escreve a mensagem de cada campo no idioma da hora em que validou. Trocado o
 * idioma, os campos que estão com erro são validados de novo, e a mensagem troca junto.
 */
function useRetranslatedErrors<T extends FieldValues>(form: UseFormReturn<T>): void {
  const errors = useRef(form.formState.errors)
  errors.current = form.formState.errors
  const { trigger } = form
  useEffect(
    () =>
      onLanguageChange(() => {
        const names = errorPaths(errors.current)
        if (names.length) void trigger(names as Path<T>[])
      }),
    [trigger],
  )
}

/** Um valor em dólares no formato do idioma da interface ("0,36" em português, "0.36" em inglês). */
function formatMoney(value: number): string {
  try {
    return new Intl.NumberFormat(messageLocale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value)
  } catch {
    return value.toFixed(2)
  }
}

/** Rejeição do uiCall como a resposta de falha da API (o mesmo do botão do modo aba no popup). */
const asFailure = (e: unknown) => ({ ok: false as const, error: String((e as Error)?.message ?? e) })

function RootSection({ helper, onRootChanged }: { helper: HelperStatus | null; onRootChanged: (root: string) => void }) {
  const [path, setPath] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<RootMessage>(null)

  useEffect(() => {
    if (helper?.root) setPath(helper.root)
  }, [helper?.root])

  const apply = async (candidate: string) => {
    const wanted = candidate.trim()
    if (!wanted) return setMessage({ ok: false, text: () => t('rootTypePath') })
    setBusy(true)
    setMessage(null)
    try {
      // A mensagem que não chega ao SW (ou o SW caindo no meio) vira o mesmo erro na tela: sem o
      // catch, a página ficava muda e a promessa sem tratamento.
      const check = await uiCall({ t: 'ui:check-root', path: wanted }).catch(asFailure)
      if (!check.ok) return setMessage({ ok: false, text: () => t('rootCannotWrite', helperReason(check.error)) })
      const set = await uiCall({ t: 'ui:set-root', path: wanted }).catch(asFailure)
      if (!set.ok || !set.root) return setMessage({ ok: false, text: () => t('rootCannotSave', helperReason(set.error)) })
      setPath(set.root)
      onRootChanged(set.root)
      setMessage({ ok: true, text: () => t('rootSaved') })
    } finally {
      setBusy(false)
    }
  }

  const choose = async () => {
    setBusy(true)
    setMessage(null)
    const r = await uiCall({ t: 'ui:choose-folder' }).catch(asFailure)
    setBusy(false)
    if (r.ok && r.path) {
      setPath(r.path)
      await apply(r.path)
    } else if (r.error !== 'cancelado') setMessage({ ok: false, text: () => t('pickerCannotOpen', r.error ? helperReason(r.error) : t('errUnknown')) })
  }

  if (!helper) return <p className="text-neutral-600 dark:text-neutral-400">{t('helperChecking')}</p>
  if (!helper.ok) {
    const problem = helperProblem(helper)
    // Instalado, mas não abre: problema de verdade de quem instalou o helper (aviso de antes).
    if (problem.kind === 'nao-abre')
      return (
        <p data-testid="sem-helper" data-helper={problem.kind} className="rounded-md bg-amber-100 p-2 text-amber-900 dark:bg-amber-950 dark:text-amber-200">
          {problem.text}
        </p>
      )
    // Sem helper (Emenda 15): o uso normal, sem tom de erro.
    return (
      <div data-testid="sem-helper" data-helper={problem.kind} className="space-y-1">
        <p data-testid="salvando-downloads">{t('optSavingToDownloads', downloadsFolderName())}</p>
        <p className="text-neutral-600 dark:text-neutral-400">{t('optSavingToDownloadsHint')}</p>
      </div>
    )
  }
  return (
    <div className="space-y-2">
      <label className="block space-y-1">
        <span className="block text-neutral-700 dark:text-neutral-300">{t('rootLabel')}</span>
        <div className="flex flex-wrap gap-2">
          <input
            aria-label={t('optSectionFolder')}
            className={`${input} min-w-64 flex-1 font-mono`}
            value={path}
            onChange={(e) => setPath(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void apply(path)
            }}
          />
          <button type="button" className={button} disabled={busy} onClick={() => void apply(path)}>
            {t('rootUse')}
          </button>
          <button type="button" className={button} disabled={busy} onClick={() => void choose()}>
            {t('rootChoose')}
          </button>
        </div>
      </label>
      {!helper.writable && <p className="text-amber-800 dark:text-amber-300">{t('rootNotWritable')}</p>}
      {message && (
        <p data-testid="pasta-mensagem" className={message.ok ? 'text-green-700 dark:text-green-400' : 'text-red-700 dark:text-red-400'}>
          {message.text()}
        </p>
      )}
    </div>
  )
}

const EMPTY_TRANSCRIPTION: TranscriptionConfig = { ativa: true, motor: 'whisper-cpp', modelo: '', idioma: 'auto', whisperCli: '', ffmpeg: '' }

/** Linha "dá para transcrever?" com o que o helper achou ou o motivo. */
function TranscriptionAvailability({ state }: { state: TranscriptionSettingsState }) {
  const d = state.detalhes
  if (!state.disponivel)
    return (
      <p data-testid="transcricao-disponivel" data-disponivel="nao" className="rounded-md bg-amber-100 p-2 text-amber-900 dark:bg-amber-950 dark:text-amber-200">
        {t('trAvailNo', state.motivo ? helperReason(state.motivo) : t('reasonUnknown'))}
      </p>
    )
  return (
    <p data-testid="transcricao-disponivel" data-disponivel="sim" className="break-all text-green-700 dark:text-green-400">
      {t('trAvailYes')} <span className="font-mono">{d.modelo}</span>
      {d.whisperCli && (
        <>
          {' '}
          · whisper-cli: <span className="font-mono">{d.whisperCli}</span>
        </>
      )}
    </p>
  )
}

function LocalTranscriptionSection({
  helper,
  state,
  loadError,
  onReload,
}: {
  helper: HelperStatus | null
  state: TranscriptionSettingsState | null
  loadError: string | null
  onReload: () => Promise<void>
}) {
  const transcriptionForm = useForm<TranscriptionConfig>({
    defaultValues: EMPTY_TRANSCRIPTION,
    resolver: transcriptionFormResolver,
  })
  const { register, handleSubmit, reset, setValue, watch, formState } = transcriptionForm
  useRetranslatedErrors(transcriptionForm)
  const [message, setMessage] = useState<RootMessage>(null)
  const [choosing, setChoosing] = useState(false)
  const errors = formState.errors
  const idioma = watch('idioma')

  // Emenda 22: quem lê o `ui:transcription` é a seção de cima, porque a linha da situação tem de
  // ficar junto da opção escolhida. O formulário acompanha a leitura que chegou lá.
  useEffect(() => {
    if (state) reset(state.config)
  }, [state, reset])

  const onSubmit = handleSubmit(async (values) => {
    const r = await uiCall({ t: 'ui:set-transcription', patch: cleanTranscriptionForm(values) }).catch(asFailure)
    if (!r.ok) return setMessage({ ok: false, text: () => t('trCannotSave', helperReason(r.error)) })
    setMessage({ ok: true, text: () => t('trSaved') })
    await onReload()
  })

  const chooseModel = async () => {
    setChoosing(true)
    const r = await uiCall({ t: 'ui:choose-model' }).catch(asFailure)
    setChoosing(false)
    if (r.ok && r.path) setValue('modelo', r.path, { shouldDirty: true, shouldValidate: true })
    else if (r.error !== 'cancelado') setMessage({ ok: false, text: () => t('pickerCannotOpen', r.error ? helperReason(r.error) : t('errUnknown')) })
  }

  if (!helper) return <p className="text-neutral-600 dark:text-neutral-400">{t('helperChecking')}</p>
  // Sem o helper (ou com ele instalado e sem abrir), o motor local não tem como transcrever: a
  // seção continua aqui, e o motor por API, logo acima, é o que funciona sem instalar nada.
  if (!helper.ok)
    return (
      <p data-testid="transcricao-sem-helper" className="text-neutral-600 dark:text-neutral-400">
        {t('optAdvancedTranscription')}
      </p>
    )
  if (loadError)
    return (
      <p data-testid="transcricao-erro" className="rounded-md bg-amber-100 p-2 text-amber-900 dark:bg-amber-950 dark:text-amber-200">
        {t('trLoadError', helperReason(loadError))}
      </p>
    )
  if (!state) return <p className="text-neutral-600 dark:text-neutral-400">{t('trReading')}</p>
  const known = TRANSCRIPTION_LANGUAGES.map((l) => ({ value: l.value, label: t(l.labelKey) }))
  const languages = known.some((l) => l.value === idioma) ? known : [...known, { value: idioma, label: idioma }]

  return (
    <form className="space-y-3" onSubmit={onSubmit} noValidate data-testid="form-transcricao">
      <label className="flex items-start gap-2">
        <input type="checkbox" className="mt-0.5" {...register('ativa')} />
        <span>
          <span className="font-medium">{t('trAutoLabel')}</span>
          <span className="block text-neutral-600 dark:text-neutral-400">{t('trAutoHint')}</span>
        </span>
      </label>
      <label className="block space-y-1">
        <span className="block">{t('trEngine')}</span>
        <select aria-label={t('trEngineAria')} className={input} {...register('motor')}>
          {state.motores.map((m) => (
            <option key={m.id} value={m.id}>
              {m.rotulo}
            </option>
          ))}
        </select>
      </label>
      <label className="block space-y-1">
        <span className="block">{t('trModelLabel')}</span>
        <div className="flex flex-wrap gap-2">
          <input aria-label={t('trModelAria')} placeholder={t('trModelPlaceholder')} className={`${input} min-w-64 flex-1 font-mono`} aria-invalid={!!errors.modelo} {...register('modelo')} />
          <button type="button" className={button} disabled={choosing} onClick={() => void chooseModel()}>
            {t('trChooseModel')}
          </button>
        </div>
        <FieldError message={errors.modelo?.message} />
      </label>
      <label className="block space-y-1">
        <span className="block">{t('trLanguageLabel')}</span>
        <select aria-label={t('trLanguageAria')} className={input} aria-invalid={!!errors.idioma} {...register('idioma')}>
          {languages.map((l) => (
            <option key={l.value} value={l.value}>
              {l.label}
            </option>
          ))}
        </select>
        <FieldError message={errors.idioma?.message} />
      </label>
      <details className="rounded-md border border-neutral-200 p-2 dark:border-neutral-700">
        <summary className="cursor-pointer font-medium">{t('trAdvanced')}</summary>
        <div className="mt-3 space-y-2">
          <label className="block space-y-1">
            <span className="block">{t('trWhisperLabel')}</span>
            <input aria-label={t('trWhisperAria')} className={`${input} w-full font-mono`} aria-invalid={!!errors.whisperCli} {...register('whisperCli')} />
            <FieldError message={errors.whisperCli?.message} />
          </label>
          <label className="block space-y-1">
            <span className="block">{t('trFfmpegLabel')}</span>
            <input aria-label={t('trFfmpegAria')} className={`${input} w-full font-mono`} aria-invalid={!!errors.ffmpeg} {...register('ffmpeg')} />
            <FieldError message={errors.ffmpeg?.message} />
          </label>
        </div>
      </details>
      <TranscriptionAvailability state={state} />
      <div className="flex items-center gap-3">
        <button type="submit" disabled={!formState.isDirty || formState.isSubmitting} className="rounded-md bg-blue-600 px-4 py-1.5 font-medium text-white hover:bg-blue-700 disabled:opacity-50">
          {t('trSave')}
        </button>
        {message && (
          <p data-testid="transcricao-mensagem" className={message.ok ? 'text-green-700 dark:text-green-400' : 'text-red-700 dark:text-red-400'}>
            {message.text()}
          </p>
        )}
      </div>
    </form>
  )
}

/** Classe da linha da situação por tom. Sem âmbar e sem vermelho (ver EngineTone). */
const TONE_CLASS: Record<EngineTone, string> = {
  ok: 'text-green-700 dark:text-green-400',
  acao: 'rounded-md bg-blue-50 p-2 text-blue-950 dark:bg-blue-950 dark:text-blue-100',
  neutro: 'text-neutral-600 dark:text-neutral-400',
}

/**
 * Como instalar o motor local, no painel dele (Emenda 22): o que vai ser instalado, em linguagem de
 * quem não é técnico, e o prompt para colar no Claude Code. Fechado por padrão (precedente: os
 * acordeões "Avançado" e "Endereço da API", no mesmo arquivo).
 *
 * A lista e o prompt nascem do mesmo array (src/shared/instalar-local.ts), então não há dois textos
 * para manter em sincronia.
 */
function LocalSetupDetails({ os }: { os: string | null }) {
  const [copyMessage, setCopyMessage] = useState<RootMessage>(null)
  const block = useRef<HTMLPreElement>(null)
  const tag = messageLocale()
  const prompt = installPrompt(currentMessageLocale())

  /** O texto do bloco selecionado, para quem não tem a área de transferência disponível copiar à mão. */
  const selectBlock = () => {
    const node = block.current
    const selection = window.getSelection()
    if (!node || !selection) return
    const range = document.createRange()
    range.selectNodeContents(node)
    selection.removeAllRanges()
    selection.addRange(range)
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(prompt)
      setCopyMessage({ ok: true, text: () => t('trSetupCopied') })
    } catch {
      // Sem permissão, sem foco no documento, ou um navegador que recusa: o texto fica selecionado.
      selectBlock()
      setCopyMessage({ ok: false, text: () => t('trSetupCopyFailed') })
    }
  }

  return (
    <details data-testid="passo-a-passo" className="rounded-md border border-neutral-200 p-2 dark:border-neutral-700">
      <summary className="cursor-pointer font-medium">{t('trSetupSummary')}</summary>
      <div className="mt-3 space-y-3">
        {/* O instalador existe só para macOS. Quem decide é o chrome.runtime.getPlatformInfo, não
            o texto do navegador. */}
        {!installerAvailableOn(os) && (
          <p data-testid="passo-a-passo-so-mac" className="text-neutral-700 dark:text-neutral-300">
            {t('trSetupMacOnly', os ?? '')}
          </p>
        )}
        <p>{t('trSetupIntro')}</p>
        <ol data-testid="passo-a-passo-lista" className="list-decimal space-y-1 pl-6">
          {INSTALL_STEPS.map((step) => (
            <li key={step.id}>{t(step.labelKey, ...stepLabelSubs(step, tag))}</li>
          ))}
        </ol>
        <div className="space-y-1">
          <span className="block font-medium">{t('trSetupPromptLabel')}</span>
          <p className="text-neutral-600 dark:text-neutral-400">{t('trSetupPromptHint')}</p>
          <pre
            ref={block}
            data-testid="passo-a-passo-prompt"
            className="max-h-80 overflow-auto rounded-md bg-neutral-100 p-2 font-mono text-xs break-words whitespace-pre-wrap select-text dark:bg-neutral-800"
          >
            {prompt}
          </pre>
          <div className="flex flex-wrap items-center gap-3">
            <button type="button" className={button} data-testid="passo-a-passo-copiar" onClick={() => void copy()}>
              {t('trSetupCopy')}
            </button>
            {copyMessage && (
              <span
                data-testid="passo-a-passo-copiado"
                className={copyMessage.ok ? 'text-green-700 dark:text-green-400' : 'text-neutral-700 dark:text-neutral-300'}
              >
                {copyMessage.text()}
              </span>
            )}
          </div>
        </div>
        <p>
          <a className="text-blue-700 underline hover:no-underline dark:text-blue-400" href={REPO_URL} target="_blank" rel="noreferrer">
            {t('trSetupRepo')}
          </a>
        </p>
      </div>
    </details>
  )
}

/**
 * Transcrição (Emendas 21 e 22): a escolha do motor funciona com e sem o helper.
 *
 * - "O seu computador (whisper.cpp)" é o motor local, o padrão de sempre, e exige o helper.
 * - "A API da OpenAI, com a sua chave" roda dentro da extensão e funciona sem instalar nada.
 *
 * Emenda 22, a separação que corrige o defeito: o clique no rádio muda o PAINEL na hora, sempre, sem
 * depender de chave, de permissão nem do helper (ver src/shared/transcription-engine.ts). O motor
 * realmente ativo continua sendo `Settings.apiTranscription.ativa`, que só vira true com a chave
 * guardada e a permissão concedida. Debaixo da opção escolhida fica a linha que diz em que pé está e
 * o botão que resolve, junto do clique, e cada painel mostra só o que é dele.
 */
function TranscriptionSection({ helper }: { helper: HelperStatus | null }) {
  const [cfg, setCfg] = useState<ApiTranscriptionConfig | null>(null)
  const [keyHint, setKeyHint] = useState('')
  const [keyField, setKeyField] = useState('')
  const [message, setMessage] = useState<RootMessage>(null)
  const [busy, setBusy] = useState(false)
  // Emenda 22: o painel escolhido é estado de TELA, e começa no motor ativo.
  const [panel, setPanel] = useState<EnginePanel | null>(null)
  // chrome.permissions.contains da origem do endereço; null até a leitura responder.
  const [granted, setGranted] = useState<boolean | null>(null)
  // chrome.runtime.getPlatformInfo: o instalador do helper existe só para macOS.
  const [os, setOs] = useState<string | null>(null)
  // A leitura do motor local mora aqui, porque a linha da situação fica junto da opção.
  const [local, setLocal] = useState<TranscriptionSettingsState | null>(null)
  const [localError, setLocalError] = useState<string | null>(null)
  const provider = providerOf(cfg?.provedor ?? DEFAULT_API_TRANSCRIPTION.provedor)

  // Uma leitura ao abrir (a página não fala com o SW em laço). A chave é lida direto do storage
  // deste perfil, e só a dica (os quatro últimos caracteres) entra no estado da tela.
  useEffect(() => {
    void loadSettings().then((s) => {
      setCfg(s.apiTranscription)
      setPanel((p) => p ?? panelOfActiveEngine(s.apiTranscription.ativa))
    })
    void loadApiKey().then((k) => setKeyHint(apiKeyHint(k)))
    void chrome.runtime.getPlatformInfo().then((info) => setOs(info.os)).catch(() => setOs(null))
  }, [])

  // A permissão é da ORIGEM do endereço que vale: trocar o endereço troca a permissão a conferir.
  const origin = cfg ? originPatternOf(endpointOf(cfg)) : null
  useEffect(() => {
    if (!origin) return setGranted(null)
    let live = true
    void chrome.permissions
      .contains({ origins: [origin] })
      .then((has) => {
        if (live) setGranted(has)
      })
      .catch(() => {
        if (live) setGranted(null)
      })
    return () => {
      live = false
    }
  }, [origin])

  const loadLocal = async () => {
    const r = await uiCall({ t: 'ui:transcription' }).catch(asFailure)
    if (!r.ok) return setLocalError(r.error)
    setLocalError(null)
    setLocal(r.state)
  }

  useEffect(() => {
    if (helper?.ok) void loadLocal()
    // Uma leitura ao abrir e uma por ação (a página não fala com o SW em laço).
  }, [helper?.ok])

  /** Troca a configuração do motor por API neste perfil (chrome.storage.local, como o idioma). */
  const save = async (next: ApiTranscriptionConfig): Promise<boolean> => {
    const { profileId: _id, ...current } = await loadSettings()
    const r = await uiCall({ t: 'ui:save-settings', settings: { ...current, apiTranscription: next } }).catch(asFailure)
    if (!r.ok) {
      setMessage({ ok: false, text: () => t('trApiCannotSave', r.error ? helperReason(r.error) : t('errUnknown')) })
      return false
    }
    setCfg(next)
    return true
  }

  const saveKey = async () => {
    const key = keyField.trim()
    if (!key) return
    setBusy(true)
    try {
      await saveApiKey(key)
      setKeyField('')
      setKeyHint(apiKeyHint(key))
      setMessage({ ok: true, text: () => t('trApiKeySaved', apiKeyHint(key)) })
    } catch (e) {
      const erro = String((e as Error)?.message ?? e)
      setMessage({ ok: false, text: () => t('trApiKeyCannotSave', erro) })
    } finally {
      setBusy(false)
    }
  }

  const clearKey = async () => {
    setBusy(true)
    try {
      await clearApiKey()
      setKeyHint('')
      setKeyField('')
      // Sem chave nada é enviado; o motor é desligado, para a tela não mentir.
      if (cfg?.ativa) await save({ ...cfg, ativa: false })
      setMessage({ ok: true, text: () => t('trApiKeyCleared') })
    } finally {
      setBusy(false)
    }
  }

  /**
   * Liga o motor por API: precisa da chave e da permissão de host, nesta ordem. Chamada no clique do
   * usuário (o Chrome só concede permissão de host num gesto), e sem nenhum `await` antes do
   * `chrome.permissions.request`. Uma permissão já concedida resolve na hora, sem diálogo.
   */
  const enableApi = async () => {
    if (!cfg) return
    if (!keyHint) return setMessage({ ok: false, text: () => t('trApiKeyMissing') })
    const wanted = originPatternOf(endpointOf(cfg))
    if (!wanted) return setMessage({ ok: false, text: () => t('apiErrEndpoint', endpointOf(cfg)) })
    setBusy(true)
    try {
      const ok = await chrome.permissions.request({ origins: [wanted] }).catch(() => false)
      setGranted(ok)
      if (!ok) return setMessage({ ok: false, text: () => t('trApiPermissionDenied', provider.rotulo) })
      if (await save({ ...cfg, ativa: true })) setMessage({ ok: true, text: () => t('trApiReady') })
    } finally {
      setBusy(false)
    }
  }

  const disableApi = async () => {
    if (!cfg || !cfg.ativa) return
    setBusy(true)
    try {
      if (await save({ ...cfg, ativa: false })) setMessage({ ok: true, text: () => t('trApiOff') })
    } finally {
      setBusy(false)
    }
  }

  /**
   * O clique no rádio. Ele muda o painel SEMPRE, na hora: é esta linha que corrige o defeito de
   * clicar e nada se mexer. Escolher o computador desliga o motor por API (escolha explícita de não
   * mandar áudio para fora); escolher a API tenta ligar, e quando falta chave ou permissão nada é
   * ligado e nada é salvo, e a linha da situação diz o que falta.
   */
  const choosePanel = (next: EnginePanel) => {
    setPanel(next)
    setMessage(null)
    if (next === 'local') void disableApi()
    else if (keyHint) void enableApi()
  }

  const changeLanguage = async (idioma: string) => {
    if (!cfg) return
    if (await save({ ...cfg, idioma })) setMessage({ ok: true, text: () => t('trApiSaved') })
  }

  const changeEndpoint = async (endpoint: string) => {
    if (!cfg) return
    const clean = endpoint.trim()
    if (clean && !isAllowedEndpoint(clean)) return setMessage({ ok: false, text: () => t('apiErrEndpoint', clean) })
    if (await save({ ...cfg, endpoint: clean })) setMessage({ ok: true, text: () => t('trApiSaved') })
  }

  if (!cfg || !panel) return <p className="text-neutral-600 dark:text-neutral-400">{t('trReading')}</p>
  const known = TRANSCRIPTION_LANGUAGES.map((l) => ({ value: l.value, label: t(l.labelKey) }))
  const languages = known.some((l) => l.value === cfg.idioma) ? known : [...known, { value: cfg.idioma, label: cfg.idioma }]
  const situation = engineSituation(
    panel,
    { ativa: cfg.ativa, temChave: !!keyHint, temPermissao: granted, provedor: provider.rotulo },
    {
      helper: !helper ? 'verificando' : helper.ok ? 'presente' : 'ausente',
      disponivel: localError ? false : local ? local.disponivel : null,
      motivo: localError ? helperReason(localError) : local?.motivo ? helperReason(local.motivo) : t('reasonUnknown'),
      modelo: local?.detalhes.modelo ?? '',
    },
  )

  /** A linha que diz em que pé está o motor escolhido, com o botão que resolve o que falta. */
  const situationLine = (
    <div className="space-y-2 pl-6" data-testid="motor-situacao-caixa">
      <p data-testid="motor-situacao" data-situacao={situation.kind} className={TONE_CLASS[situation.tone]}>
        {t(situation.key, ...situation.subs)}
      </p>
      {situation.action && situation.actionKey && (
        <button type="button" className={button} data-testid="motor-situacao-acao" data-acao={situation.action} disabled={busy} onClick={() => void enableApi()}>
          {t(situation.actionKey, ...situation.actionSubs)}
        </button>
      )}
    </div>
  )

  return (
    <div className="space-y-4" data-testid="transcricao-motor" data-motor={cfg.ativa ? 'api' : 'local'} data-painel={panel}>
      <fieldset className="space-y-2">
        <legend className="font-medium">{t('trEngineChoice')}</legend>
        <label className="flex items-start gap-2">
          <input
            type="radio"
            className="mt-1"
            name="motor-transcricao"
            data-testid="motor-local"
            checked={panel === 'local'}
            onChange={() => choosePanel('local')}
          />
          <span>
            {t('trEngineLocal')}
            <span className="block text-neutral-600 dark:text-neutral-400">{t('trEngineLocalHint')}</span>
          </span>
        </label>
        {panel === 'local' && situationLine}
        <label className="flex items-start gap-2">
          <input type="radio" className="mt-1" name="motor-transcricao" data-testid="motor-api" checked={panel === 'api'} onChange={() => choosePanel('api')} />
          <span>
            {t('trEngineApi')}
            <span className="block text-neutral-600 dark:text-neutral-400">{t('trEngineApiHint')}</span>
          </span>
        </label>
        {panel === 'api' && situationLine}
      </fieldset>

      {panel === 'api' ? (
        <div className="space-y-4" data-testid="painel-api">
          {/* O aviso aparece ANTES de ligar: ele é a razão de a escolha existir. */}
          <p data-testid="transcricao-api-privacidade" className="rounded-md bg-amber-100 p-2 text-amber-900 dark:bg-amber-950 dark:text-amber-200">
            {t('trApiPrivacy')}
          </p>
          <p className="text-neutral-600 dark:text-neutral-400">
            <span data-testid="transcricao-api-custo">{t('trApiCost', formatMoney(dollarsPerHour(cfg)))}</span>{' '}
            <span data-testid="transcricao-api-limite">{t('trApiLimit', `${Math.round(maxBytesOf(cfg) / (1024 * 1024))} MB`)}</span>
          </p>

          <div className="space-y-1">
            <span className="block font-medium">{t('trApiKeyLabel')}</span>
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="password"
                aria-label={t('trApiKeyAria')}
                autoComplete="off"
                placeholder={keyHint || 'sk-...'}
                className={`${input} min-w-64 flex-1 font-mono`}
                value={keyField}
                disabled={busy}
                onChange={(e) => setKeyField(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void saveKey()
                }}
              />
              <button type="button" className={button} disabled={busy || !keyField.trim()} onClick={() => void saveKey()}>
                {t('trApiKeySave')}
              </button>
              {keyHint && (
                <button type="button" className={button} data-testid="transcricao-api-apagar-chave" disabled={busy} onClick={() => void clearKey()}>
                  {t('trApiKeyClear')}
                </button>
              )}
            </div>
            {keyHint && (
              <p data-testid="transcricao-api-chave" className="text-neutral-600 dark:text-neutral-400">
                {t('trApiKeySaved', keyHint)}
              </p>
            )}
            <p className="text-neutral-600 dark:text-neutral-400">{t('trApiKeyHint')}</p>
            <p>
              <a className="text-blue-700 underline hover:no-underline dark:text-blue-400" href={provider.chaveUrl} target="_blank" rel="noreferrer">
                {t('trApiKeyLink')}
              </a>
            </p>
          </div>

          <label className="block space-y-1">
            <span className="block">{t('trLanguageLabel')}</span>
            <select aria-label={t('trApiLanguageAria')} className={input} value={cfg.idioma} disabled={busy} onChange={(e) => void changeLanguage(e.target.value)}>
              {languages.map((l) => (
                <option key={l.value} value={l.value}>
                  {l.label}
                </option>
              ))}
            </select>
          </label>

          <details className="rounded-md border border-neutral-200 p-2 dark:border-neutral-700">
            <summary className="cursor-pointer font-medium">{t('trApiEndpointLabel')}</summary>
            <div className="mt-3 space-y-1">
              <input
                aria-label={t('trApiEndpointAria')}
                className={`${input} w-full font-mono`}
                defaultValue={cfg.endpoint}
                placeholder={provider.endpoint}
                disabled={busy}
                onBlur={(e) => void changeEndpoint(e.target.value)}
              />
              <p className="text-neutral-600 dark:text-neutral-400">{t('trApiEndpointHint')}</p>
            </div>
          </details>
        </div>
      ) : (
        <div className="space-y-4" data-testid="painel-local">
          <LocalSetupDetails os={os} />
          <div data-testid="transcricao-local" className="space-y-2">
            <LocalTranscriptionSection helper={helper} state={local} loadError={localError} onReload={loadLocal} />
          </div>
        </div>
      )}

      {message && (
        <p data-testid="transcricao-api-mensagem" className={message.ok ? 'text-green-700 dark:text-green-400' : 'text-red-700 dark:text-red-400'}>
          {message.text()}
        </p>
      )}
    </div>
  )
}

function ShortcutSection() {
  const [shortcut, setShortcut] = useState<string | null>(null)
  useEffect(() => {
    void chrome.commands.getAll().then((cmds) => setShortcut(cmds.find((c) => c.name === TAB_COMMAND)?.shortcut ?? ''))
  }, [])
  return (
    <div className="space-y-2">
      <p>{t('shortcutIntro')}</p>
      <p>
        {t('shortcutLabel')}{' '}
        <kbd data-testid="atalho" className="rounded border border-neutral-300 px-1.5 py-0.5 font-mono dark:border-neutral-600">
          {shortcut === null ? '...' : shortcut || t('shortcutNone')}
        </kbd>
      </p>
      <button type="button" className={button} onClick={() => void chrome.tabs.create({ url: 'chrome://extensions/shortcuts' })}>
        {t('shortcutChange')}
      </button>
    </div>
  )
}

/**
 * Emenda 10: o Chrome não fixa sozinho uma extensão carregada sem compactação, e sem fixar o REC,
 * o ↻ e o alerta âmbar ficam escondidos no menu de extensões durante a call.
 */
function PinHint() {
  const [pinned, setPinned] = useState<boolean | null>(null)
  useEffect(() => {
    // Chrome 91+; os tipos do @types/chrome só têm a forma com callback.
    const action = chrome.action as unknown as { getUserSettings?: () => Promise<{ isOnToolbar?: boolean }> } | undefined
    if (typeof action?.getUserSettings !== 'function') return
    void Promise.resolve(action.getUserSettings())
      .then((s) => setPinned(s?.isOnToolbar === true))
      .catch(() => setPinned(null))
  }, [])
  if (pinned !== false) return null
  return (
    <p data-testid="fixar-icone" className="rounded-md bg-blue-50 p-3 text-blue-900 dark:bg-blue-950 dark:text-blue-200">
      {t('pinHint')}
    </p>
  )
}

/** Como instalar o helper (para quem usa o código-fonte; ainda não distribuído pela loja). */
function HelperInstall() {
  return (
    <div className="space-y-1">
      <p>{t('helperHowTo')}</p>
      <pre className="rounded-md bg-neutral-100 p-2 font-mono text-xs dark:bg-neutral-800">npm run instalar</pre>
      <p className="text-neutral-600 dark:text-neutral-400">
        {t('helperHowToHint')} <span className="font-mono">npm run desinstalar</span>.
      </p>
    </div>
  )
}

const MODE_ALONE = 'modo-sozinho'
const MODE_PROPORTION = 'modo-proporcao'
const MODE_COUNT = 'modo-quantidade'

/**
 * "Sair e fechar a call sozinho" (Emenda 16): a chave, "Quando sair" em três escolhas escritas por
 * extenso, quanto tempo confirmar, o exemplo que acompanha as escolhas (calculado com a mesma
 * regra do vigia) e os números raros em "Ajustes finos". O formulário guarda os valores de negócio
 * (modo, fração, quantidade, confirmações); o tempo e o exemplo são derivados deles.
 */
function LeaveRule({ form }: { form: UseFormReturn<ProfileForm> }) {
  const { register, watch, setValue, formState } = form
  const errors = formState.errors.vigia
  const autoLeave = watch('autoLeave')
  const vigia = watch('vigia')
  const parsed = profileFormSchema.shape.vigia.safeParse(vigia)
  const interval = Number.isFinite(vigia.intervaloSeg) && vigia.intervaloSeg >= 1 ? vigia.intervaloSeg : DEFAULT_VIGIA.intervaloSeg
  const num = { valueAsNumber: true } as const
  // Mexer no controle de uma escolha também marca a escolha.
  const choose = (modo: VigiaModo) => setValue('vigia.modo', modo, { shouldDirty: true })
  const restoreFine = () => {
    for (const f of VIGIA_FINE_FIELDS) setValue(`vigia.${f.key}`, DEFAULT_VIGIA[f.key], { shouldDirty: true, shouldValidate: true })
  }

  return (
    <>
      <label className="flex items-start gap-2">
        <input type="checkbox" className="mt-0.5" {...register('autoLeave')} />
        <span>
          <span className="font-medium">{t('optAutoLeave')}</span>
          <span className="block text-neutral-600 dark:text-neutral-400">{t('optAutoLeaveHint')}</span>
        </span>
      </label>

      <div data-testid="regra-saida" data-ligado={autoLeave ? 'sim' : 'nao'} className={`space-y-3 pl-6 ${autoLeave ? '' : 'opacity-60'}`}>
        <fieldset className="space-y-2">
          <legend className="mb-1 font-medium">{t('optLeaveWhen')}</legend>
          <div className="flex items-start gap-2">
            <input id={MODE_ALONE} type="radio" value="sozinho" className="mt-2" {...register('vigia.modo')} />
            <label htmlFor={MODE_ALONE} className="leading-7">
              {t('optModeAlone')}
            </label>
          </div>
          <div className="flex items-start gap-2">
            <input id={MODE_PROPORTION} type="radio" value="proporcao" className="mt-2" aria-label={t('optModeProportionName')} {...register('vigia.modo')} />
            <div className="leading-7">
              <label htmlFor={MODE_PROPORTION}>{t('optModeProportionLead')} {t('optModeProportionBefore')}</label>{' '}
              <select
                aria-label={t('optFractionAria')}
                className={`${input} py-0.5`}
                {...register('vigia.fracao', { setValueAs: Number, onChange: () => choose('proporcao') })}
                onFocus={() => choose('proporcao')}
              >
                {opcoesDeFracao(vigia.fracao).map((f) => (
                  <option key={f} value={String(f)}>
                    {fractionLabel(f)}
                  </option>
                ))}
              </select>{' '}
              <label htmlFor={MODE_PROPORTION}>{t('optModeProportionAfter')}</label>
              <FieldError message={errors?.fracao?.message} />
            </div>
          </div>
          <div className="flex items-start gap-2">
            <input id={MODE_COUNT} type="radio" value="quantidade" className="mt-2" aria-label={t('optModeCountName')} {...register('vigia.modo')} />
            <div className="leading-7">
              <label htmlFor={MODE_COUNT}>{t('optModeCountBefore')}</label>{' '}
              <input
                type="number"
                min={1}
                max={50}
                step={1}
                aria-label={t('optCountAria')}
                aria-invalid={!!errors?.quantidade}
                className={`${input} w-16 py-0.5`}
                {...register('vigia.quantidade', { ...num, onChange: () => choose('quantidade') })}
                onFocus={() => choose('quantidade')}
              />{' '}
              <label htmlFor={MODE_COUNT}>{t('optModeCountAfter')}</label>
              <FieldError message={errors?.quantidade?.message} />
            </div>
          </div>
        </fieldset>

        {vigia.modo !== 'sozinho' && (
          <label className="block space-y-1">
            <span className="block font-medium">{t('optConfirmLabel')}</span>
            <select className={input} {...register('vigia.confirmacoes', { setValueAs: Number })}>
              {opcoesDeConfirmacao(interval, vigia.confirmacoes).map((o) => (
                <option key={o.confirmacoes} value={String(o.confirmacoes)}>
                  {confirmLabel(o.segundos)}
                </option>
              ))}
            </select>
            <span className="block text-neutral-600 dark:text-neutral-400">{t('optConfirmHint')}</span>
          </label>
        )}

        <p data-testid="vigia-exemplo" aria-live="polite" className="rounded-md bg-blue-50 p-2 text-blue-950 dark:bg-blue-950 dark:text-blue-100">
          {parsed.success ? vigiaExample(parsed.data) : t('optExampleInvalid')}
        </p>

        <label className="flex items-center gap-2">
          <input type="checkbox" {...register('vigiaIndicador')} />
          {t('optVigiaIndicator')}
        </label>

        <details className="rounded-md border border-neutral-200 p-2 dark:border-neutral-700">
          <summary className="cursor-pointer font-medium">{t('optVigiaAdvanced')}</summary>
          <div className="mt-3 space-y-3">
            {VIGIA_FINE_FIELDS.map((f) => (
              <label key={f.key} className="block space-y-1">
                <span className="block">{t(f.labelKey)}</span>
                <input
                  type="number"
                  step={f.step}
                  aria-label={t(f.labelKey)}
                  aria-invalid={!!errors?.[f.key]}
                  className={`${input} w-20`}
                  {...register(`vigia.${f.key}`, { ...num, deps: f.key === 'minimo' ? ['vigia.picoParaQueda'] : undefined })}
                />
                <FieldError message={errors?.[f.key]?.message} />
                <span className="block text-xs text-neutral-600 dark:text-neutral-400">{t(f.hintKey)}</span>
              </label>
            ))}
          </div>
          <button type="button" className={`${button} mt-3`} onClick={restoreFine}>
            {t('optVigiaRestore')}
          </button>
        </details>
      </div>
    </>
  )
}

/**
 * Idioma da interface (Emenda 19): o seletor mostra o idioma que vale nesta página (o do
 * i18n.ts, que acompanha o que está guardado) e não faz parte do formulário. Os nomes das línguas
 * aparecem na própria língua; "Automático" no idioma atual.
 */
function LanguageSection({ onChange, message }: { onChange: (language: UiLanguage) => void; message: RootMessage }) {
  const language = useLanguage()
  return (
    <div className="space-y-1">
      <select
        aria-label={t('optSectionLanguage')}
        data-testid="idioma"
        className={input}
        value={language}
        onChange={(e) => onChange(e.currentTarget.value as UiLanguage)}
      >
        {UI_LANGUAGE_OPTIONS.map((o) => (
          <option key={o.value} value={o.value} lang={o.lang}>
            {o.name ?? t(o.labelKey)}
          </option>
        ))}
      </select>
      <p className="text-neutral-600 dark:text-neutral-400">{t('optLanguageHint')}</p>
      {message && (
        <p data-testid="idioma-mensagem" className={message.ok ? 'text-green-700 dark:text-green-400' : 'text-red-700 dark:text-red-400'}>
          {message.text()}
        </p>
      )}
    </div>
  )
}

export function Options() {
  // Emenda 19: a página inteira redesenha no idioma novo; o formulário guarda o que foi digitado.
  useLanguage()
  const form = useForm<ProfileForm>({
    defaultValues: profileFormDefaults(DEFAULT_SETTINGS),
    resolver: profileFormResolver,
  })
  const { register, handleSubmit, reset, resetField, getValues, watch, formState } = form
  useRetranslatedErrors(form)
  const [helper, setHelper] = useState<HelperStatus | null>(null)
  // Emenda 17: versão do SW e gravações em andamento, da mesma leitura única do ui:state.
  const [running, setRunning] = useState<Pick<UiState, 'worker' | 'update'> & { recording: boolean } | null>(null)
  const unhandled = useUnhandledUiErrors()
  const [loaded, setLoaded] = useState(false)
  const [message, setMessage] = useState<RootMessage>(null)
  const [labelMessage, setLabelMessage] = useState<RootMessage>(null)
  const [languageMessage, setLanguageMessage] = useState<RootMessage>(null)
  const label = watch('profileLabel')
  const errors = formState.errors

  useEffect(() => {
    void loadSettings().then((s) => {
      reset(profileFormDefaults(s))
      setLoaded(true)
    })
    void uiCall({ t: 'ui:state' })
      .then((s) => {
        setHelper(s.helper)
        setRunning({ worker: s.worker, update: s.update, recording: s.active.length > 0 })
      })
      .catch((e) => setHelper({ ok: false, version: null, root: null, writable: false, error: String(e?.message ?? e) }))
  }, [reset])

  // Cada salvamento lê o que está guardado e troca só o que é dele, um por vez (Emenda 19): o nome
  // do perfil sai do campo justamente quando o clique vai para o seletor do idioma, e os dois
  // salvamentos juntos não podem desfazer um ao outro. `change` devolve null quando não há o que
  // salvar.
  const saveQueue = useRef<Promise<unknown>>(Promise.resolve())
  const saveStored = (change: (current: StoredSettings) => StoredSettings | null) => {
    const run = saveQueue.current.then(async () => {
      const { profileId: _id, ...current } = await loadSettings()
      const next = change(current)
      return next ? uiCall({ t: 'ui:save-settings', settings: next }).catch(asFailure) : null
    })
    saveQueue.current = run.catch(() => {})
    return run
  }

  // Emenda 10: o nome do perfil (que vira a primeira pasta) é salvo ao sair do campo, como a pasta,
  // sem depender do Salvar lá embaixo. As outras mudanças do formulário continuam esperando o Salvar.
  const saveLabel = async () => {
    const label = getValues('profileLabel').trim()
    if (!profileFormSchema.shape.profileLabel.safeParse(label).success) return
    const r = await saveStored((current) => (current.profileLabel === label ? null : { ...current, profileLabel: label }))
    if (!r) return
    if (r.ok) resetField('profileLabel', { defaultValue: label })
    const error = r.ok ? '' : (r.error ?? '')
    setLabelMessage(r.ok ? { ok: true, text: () => t('optLabelSaved') } : { ok: false, text: () => t('optLabelCannotSave', error ? helperReason(error) : t('errUnknown')) })
  }

  // Emenda 19: o idioma vale na hora nesta página e é salvo sozinho; o SW, o popup, as boas-vindas
  // e o vigia trocam pelo storage. Sem salvar, a página volta ao idioma de antes e diz por quê.
  const changeLanguage = async (next: UiLanguage) => {
    const previous = uiLanguage()
    setLanguage(next)
    setLanguageMessage(null)
    const r = await saveStored((current) => ({ ...current, language: next }))
    if (r?.ok) return setLanguageMessage({ ok: true, text: () => t('optLanguageSaved') })
    setLanguage(previous)
    const error = r?.error ?? ''
    setLanguageMessage({ ok: false, text: () => t('optLanguageCannotSave', error ? helperReason(error) : t('errUnknown')) })
  }

  // Sair da página com mudanças não salvas pede confirmação (o Salvar fica no fim da página).
  useEffect(() => {
    if (!formState.isDirty) return
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [formState.isDirty])

  const onSubmit = handleSubmit(async (values) => {
    const clean = cleanProfileForm(values)
    // O idioma (Emenda 19) e a transcrição por API (Emenda 21) não são do formulário: fica o guardado.
    const r = (await saveStored((current) => ({ ...clean, language: current.language, apiTranscription: current.apiTranscription })))!
    if (r.ok) reset(clean)
    const error = r.ok ? '' : (r.error ?? '')
    setMessage(r.ok ? { ok: true, text: () => t('optSaved') } : { ok: false, text: () => t('optCannotSave', error ? helperReason(error) : t('errUnknown')) })
  })

  const num = { valueAsNumber: true } as const
  const rootShown = helper?.ok ? helper.root : downloadsPath()
  const folder = profileFolder(label)
  // Emenda 15: sem helper instalado, a escolha da pasta, a transcrição e o helper vão para "Avançado".
  const noHelper = !!helper && !helper.ok && helperProblem(helper).kind === 'nao-instalado'

  return (
    <main className="mx-auto max-w-2xl space-y-4 p-6 text-sm text-neutral-900 dark:text-neutral-100">
      <header>
        <h1 className="text-xl font-semibold">
          {t('extName')}{' '}
          <span data-testid="versao" className="text-sm font-normal text-neutral-500 dark:text-neutral-400">
            v{chrome.runtime.getManifest().version}
          </span>
        </h1>
        <p className="text-neutral-600 dark:text-neutral-400">{noHelper ? t('optHeaderHintNoHelper') : t('optHeaderHint')}</p>
        <p className="mt-1 flex flex-wrap gap-x-4 text-xs">
          <a data-testid="link-aviso" className="text-blue-700 underline hover:no-underline dark:text-blue-400" href={chrome.runtime.getURL(WELCOME_PAGE)} target="_blank" rel="noreferrer">
            {t('optConsentLink')}
          </a>
          <a data-testid="link-privacidade" className="text-blue-700 underline hover:no-underline dark:text-blue-400" href={t('privacyUrl')} target="_blank" rel="noreferrer">
            {t('optPrivacyLink')}
          </a>
        </p>
      </header>

      {running && <VersionBanner worker={running.worker} update={running.update} recording={running.recording} />}
      {unhandled && (
        <p data-testid="erro-inesperado" className="text-xs text-red-700 dark:text-red-400">
          {unhandled}
        </p>
      )}

      <Section title={t('optSectionLanguage')} testId="secao-idioma">
        <LanguageSection onChange={(l) => void changeLanguage(l)} message={languageMessage} />
      </Section>

      <PinHint />

      <Section title={t('optSectionFolder')} testId="secao-pasta">
        <RootSection helper={helper} onRootChanged={(root) => setHelper((h) => (h ? { ...h, root, writable: true } : h))} />
      </Section>

      <form className="space-y-4" onSubmit={onSubmit} noValidate>
        <Section title={t('optSectionProfile')}>
          <label className="block space-y-1">
            <span className="block font-medium">{t('optProfileName')}</span>
            <input className={`${input} w-56`} aria-invalid={!!errors.profileLabel} {...register('profileLabel', { onBlur: () => void saveLabel() })} />
            <FieldError message={errors.profileLabel?.message} />
            {labelMessage && (
              <span data-testid="perfil-mensagem" className={`block text-xs ${labelMessage.ok ? 'text-green-700 dark:text-green-400' : 'text-red-700 dark:text-red-400'}`}>
                {labelMessage.text()}
              </span>
            )}
            <span className="block text-neutral-600 dark:text-neutral-400">{t('optProfileHint')}</span>
          </label>
          <p data-testid="previa-pasta" className="break-all rounded-md bg-neutral-100 p-2 font-mono text-xs dark:bg-neutral-800">
            {rootShown}/{folder ? `${folder}/` : ''}
            {t('optPreviewPattern')}
          </p>
        </Section>

        <Section title={t('optSectionAuto')}>
          <label className="flex items-center gap-2">
            <input type="checkbox" {...register('autoMeet')} />
            {t('optAutoMeet')}
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" {...register('autoTeams')} />
            {t('optAutoTeams')}
          </label>
          <label className="block space-y-1">
            <span className="block">{t('optMinSeconds')}</span>
            <input type="number" min={0} className={`${input} w-24`} aria-invalid={!!errors.minSeconds} {...register('minSeconds', num)} />
            <FieldError message={errors.minSeconds?.message} />
            <span className="block text-neutral-600 dark:text-neutral-400">{t('optMinSecondsHint')}</span>
          </label>
        </Section>

        <Section title={t('optSectionLeave')} testId="secao-sair">
          <LeaveRule form={form} />
        </Section>

        <div className="flex items-center gap-3">
          <button type="submit" disabled={!loaded || !formState.isDirty || formState.isSubmitting} className="rounded-md bg-blue-600 px-4 py-1.5 font-medium text-white hover:bg-blue-700 disabled:opacity-50">
            {t('optSave')}
          </button>
          {message && (
            <p data-testid="salvar-mensagem" className={message.ok ? 'text-green-700 dark:text-green-400' : 'text-red-700 dark:text-red-400'}>
              {message.text()}
            </p>
          )}
        </div>
      </form>

      {/* Emenda 21: a seção existe com e sem o helper, porque o motor por API funciona sem ele. */}
      <Section title={t('optSectionTranscription')} testId="secao-transcricao">
        <TranscriptionSection helper={helper} />
      </Section>

      <Section title={t('optSectionTabMode')}>
        <ShortcutSection />
      </Section>

      {noHelper ? (
        <Section title={t('optSectionAdvanced')} testId="secao-avancado">
          <p className="text-neutral-600 dark:text-neutral-400">{t('optAdvancedIntro', downloadsFolderName())}</p>
          <details className="rounded-md border border-neutral-200 p-2 dark:border-neutral-700">
            {/* Emenda 21: a transcrição saiu daqui e virou seção própria, porque o motor por API
                funciona sem o helper. O que exige o helper é a pasta escolhida e o motor local. */}
            <summary className="cursor-pointer font-medium">
              {t('optSectionFolder')}, {t('optSectionHelper').toLowerCase()}
            </summary>
            <div className="mt-3 space-y-3">
              <p data-testid="pasta-avancado">{t('optAdvancedFolder')}</p>
              <div data-testid="secao-helper" className="space-y-1">
                <p data-testid="helper-status">{t('helperStatusAbsent', downloadsPath())}</p>
                {/* O pacote da loja não tem a pasta do projeto nem o npm: a instrução de instalar é de
                    quem usa o código-fonte (Emenda 15). */}
                {!__STORE_BUILD__ && <HelperInstall />}
              </div>
            </div>
          </details>
        </Section>
      ) : (
        <Section title={t('optSectionHelper')} testId="secao-helper">
          {helper?.ok ? (
            <p data-testid="helper-status">{t('helperStatusInstalled', helper.version ?? '')}</p>
          ) : helper && helperProblem(helper).kind === 'nao-abre' ? (
            <p data-testid="helper-status">{t('helperStatusNotOpening', helperReason(helper.error), downloadsPath())}</p>
          ) : (
            <p data-testid="helper-status">{t('helperStatusAbsent', downloadsPath())}</p>
          )}
          <HelperInstall />
        </Section>
      )}
    </main>
  )
}
