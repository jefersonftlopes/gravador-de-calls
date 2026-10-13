// Popup (AC11, AC12, AC17, AC18): gravações em andamento (plataforma, título, tempo, se está
// chegando áudio agora, parar), o vigia da aba atual com "Sair agora" e "Desligar nesta call",
// o modo aba da aba atual, as últimas gravações com "Mostrar no Finder" e o estado da transcrição
// de cada uma (Emenda 13: "transcrevendo...", "Abrir transcrição" ou o motivo da falha), a linha do
// helper e o lembrete de dar nome ao perfil. E o volume da aba atual (Emenda 14), em qualquer
// página http ou https e em qualquer aba que a extensão ainda esteja capturando por causa do volume.
//
// A aba "atual" é a ativa da janela; aberto como página numa aba (o teste faz assim, Emenda 5),
// `?tabId=<n>` diz qual aba o popup está olhando.
//
// Emenda 19: as mensagens das ações guardadas na tela são funções, lidas a cada render, e o motivo
// que o SW mandou passa pelo helperReason: trocado o idioma, a mensagem inteira troca junto.
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { ActiveRecording, Platform, RecentRecording, RecentTranscription, TranscriptionUiState, UiState, VigiaTabState } from '../shared/protocol'
import { WELCOME_PAGE } from '../shared/consent'
import { helperProblem } from '../shared/helper-status'
import { helperReason } from '../shared/helper-reasons'
import { platformOfHost } from '../shared/hosts'
import { t, type MessageKey } from '../shared/i18n'
import { useLanguage } from '../shared/page-language'
import { canReveal } from '../shared/recent'
import { errorText, uiCall } from '../shared/ui-client'
import { VersionBanner, useUnhandledUiErrors } from '../shared/VersionBanner'
import { vigiaSourceLabel } from '../shared/vigia-source'
import { VOLUME_MAX, VOLUME_MIN, VOLUME_STEP, volumeEligibleUrl, volumeLabel } from '../shared/volume'
import { audioStatus, formatDuration, formatElapsed, formatStart, platformLabel, shortPath, transcriptionNotice, transcriptionOf, vigiaLine, type AudioTone } from './format'

const REFRESH_MS = 1000

/** Mensagem de uma ação na tela, lida a cada render (Emenda 19): troca junto com o idioma. */
type Shown = { text: () => string } | null

/** O motivo que veio do SW no idioma que vale agora; sem motivo, a mensagem `fallback`. */
const reasonOr = (error: string | null | undefined, fallback: MessageKey) => (error ? helperReason(error) : t(fallback))

/** O texto do erro de uma resposta que falhou (ou de uma rejeição convertida nela). */
const errorOf = (r: object) => ('error' in r && typeof r.error === 'string' ? r.error : undefined)

interface CurrentTab {
  id: number
  title: string
  platform: Platform | null
  /** Página http ou https: o volume desta aba vale para ela (Emenda 14). */
  volumeOk: boolean
}

/** Plataforma da aba pelo host (também pelo proxy do Defender for Cloud Apps). URL sem permissão de host chega vazia. */
function platformOfUrl(url: string | undefined): Platform | null {
  if (!url) return null
  try {
    return platformOfHost(new URL(url).hostname)
  } catch {
    return null
  }
}

async function findCurrentTab(): Promise<CurrentTab | null> {
  const fromQuery = Number(new URLSearchParams(location.search).get('tabId'))
  let tab: chrome.tabs.Tab | undefined
  try {
    if (Number.isInteger(fromQuery) && fromQuery > 0) tab = await chrome.tabs.get(fromQuery)
    else [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  } catch {
    return null
  }
  if (tab?.id == null) return null
  // Páginas da própria extensão (o popup aberto numa aba) não são "a aba atual".
  if (tab.url?.startsWith(chrome.runtime.getURL(''))) return null
  return { id: tab.id, title: tab.title ?? '', platform: platformOfUrl(tab.url), volumeOk: volumeEligibleUrl(tab.url) }
}

const TONE_CLASS: Record<AudioTone, string> = {
  ok: 'text-green-700 dark:text-green-400',
  aviso: 'text-amber-700 dark:text-amber-400',
  alerta: 'text-red-700 dark:text-red-400',
}

const DOT_CLASS: Record<AudioTone, string> = {
  ok: 'bg-green-600',
  aviso: 'bg-amber-500',
  alerta: 'bg-red-600',
}

function RecordingItem({
  rec,
  isCurrentTab,
  now,
  onStop,
  stopping,
  stopError,
}: {
  rec: ActiveRecording
  isCurrentTab: boolean
  now: number
  onStop: () => void
  stopping: boolean
  stopError: (() => string) | undefined
}) {
  const audio = audioStatus(rec, now)
  const [replay, setReplay] = useState(rec.replay)
  const [replayError, setReplayError] = useState<Shown>(null)
  useEffect(() => setReplay(rec.replay), [rec.replay])
  const toggleReplay = async () => {
    const on = !replay
    setReplayError(null)
    const r = await uiCall({ t: 'ui:tab-replay', tabId: rec.tabId, on }).catch((e: unknown) => ({ ok: false, error: String((e as Error)?.message ?? e) }))
    if (r.ok) setReplay(on)
    else {
      const error = errorOf(r)
      setReplayError({ text: () => reasonOr(error, 'popupReplayFailed') })
    }
  }
  return (
    <li data-testid="gravacao" data-session={rec.sessionId} className="flex items-center gap-3 rounded-lg border border-neutral-200 p-2 dark:border-neutral-700">
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium" title={rec.title || t('untitled')}>
          {rec.title || t('untitled')}
        </p>
        <p className="flex flex-wrap items-center gap-x-2 text-xs text-neutral-600 dark:text-neutral-400">
          <span data-testid="plataforma">{platformLabel(rec.platform)}</span>
          <span aria-hidden>·</span>
          <span data-testid="tempo" className="tabular-nums">
            {formatElapsed(now - rec.startedAt)}
          </span>
          {isCurrentTab && (
            <>
              <span aria-hidden>·</span>
              <span>{t('popupThisTab')}</span>
            </>
          )}
          {rec.kind === 'aba' && <span className="rounded bg-neutral-200 px-1 dark:bg-neutral-700">{t('tabModeTag')}</span>}
        </p>
        <p data-testid="audio" data-audio-now={rec.audioNow ? 'sim' : 'nao'} className={`flex items-center gap-1 text-xs ${TONE_CLASS[audio.tone]}`}>
          <span aria-hidden className={`inline-block size-2 rounded-full ${DOT_CLASS[audio.tone]}`} />
          {audio.text}
        </p>
        {rec.kind === 'aba' && replay !== undefined && (
          <button
            type="button"
            data-testid="devolucao"
            data-replay={replay ? 'sim' : 'nao'}
            className="text-left text-xs text-blue-700 underline hover:no-underline dark:text-blue-400"
            onClick={toggleReplay}
          >
            {replay ? t('popupReplayOff') : t('popupReplayOn')}
          </button>
        )}
        {replayError && <p className="text-xs text-red-700 dark:text-red-400">{t('popupReplayError', replayError.text())}</p>}
        {stopError && (
          <p data-testid="parar-erro" className="text-xs text-red-700 dark:text-red-400">
            {t('popupStopError', stopError())}
          </p>
        )}
      </div>
      <button
        type="button"
        disabled={stopping}
        className="shrink-0 rounded-md bg-red-600 px-3 py-1 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-60"
        onClick={onStop}
      >
        {stopping ? t('popupStopping') : t('popupStop')}
      </button>
    </li>
  )
}

function VigiaPanel({ tabId, vigia, confirmacoes }: { tabId: number; vigia: VigiaTabState | null; confirmacoes: number }) {
  const [message, setMessage] = useState<Shown>(null)

  const command = async (cmd: 'ui:vigia-sair-agora' | 'ui:vigia-desligar') => {
    const r = await uiCall({ t: cmd, tabId })
    const error = r.ok ? undefined : r.error
    setMessage(r.ok ? (cmd === 'ui:vigia-sair-agora' ? { text: () => t('vigiaLeaving') } : null) : { text: () => t('popupFailed', reasonOr(error, 'errUnknown')) })
  }

  let body: ReactNode
  if (!vigia) body = <p className="text-neutral-600 dark:text-neutral-400">{t('vigiaReading')}</p>
  else if (vigia.disabledForCall) body = <p>{t('vigiaOffForCall')}</p>
  else if (!vigia.connected) body = <p className="text-amber-800 dark:text-amber-300">{t('vigiaNotActive')}</p>
  else {
    const s = vigia.status
    body = (
      <>
        <p data-testid="vigia-linha" className="text-xs font-medium tabular-nums">
          {s ? vigiaLine(s, { confirmacoes }) : t('vigiaWaitingFirst')}
        </p>
        {s?.fonte && (
          <p data-testid="vigia-fonte" className="text-xs text-neutral-600 dark:text-neutral-400">
            {t('vigiaSource', vigiaSourceLabel(s.fonte), platformLabel(s.platform))}
          </p>
        )}
        {s?.saindo && <p className="text-xs text-red-700 dark:text-red-400">{t('vigiaLeavingAttempt', s.tentativas)}</p>}
        <div className="mt-2 flex gap-2">
          <button type="button" className="rounded-md bg-neutral-800 px-3 py-1 text-xs font-medium text-white hover:bg-neutral-900 dark:bg-neutral-200 dark:text-neutral-900" onClick={() => command('ui:vigia-sair-agora')}>
            {t('vigiaLeaveNow')}
          </button>
          <button type="button" className="rounded-md border border-neutral-300 px-3 py-1 text-xs hover:bg-neutral-100 dark:border-neutral-600 dark:hover:bg-neutral-800" onClick={() => command('ui:vigia-desligar')}>
            {t('vigiaTurnOffForCall')}
          </button>
        </div>
      </>
    )
  }
  return (
    <section data-testid="vigia" className="rounded-lg border border-neutral-200 p-2 dark:border-neutral-700">
      <h2 className="mb-1 text-xs font-semibold uppercase tracking-wide text-neutral-500">{t('vigiaHeading')}</h2>
      {body}
      {message && <p className="mt-1 text-xs">{message.text()}</p>}
    </section>
  )
}

function TabCaptureButton({ tab, active }: { tab: CurrentTab; active: ActiveRecording | undefined }) {
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<Shown>(null)
  const toggle = async () => {
    setBusy(true)
    setMessage(null)
    const r = await uiCall({ t: 'ui:tab-capture', tabId: tab.id }).catch((e) => ({ ok: false, error: String(e?.message ?? e) }))
    setBusy(false)
    if (!r.ok) {
      const error = errorOf(r)
      setMessage({ text: () => t('tabModeError', reasonOr(error, 'tabModeNotPossible')) })
    }
  }
  return (
    <section>
      <button
        type="button"
        disabled={busy}
        className="w-full rounded-md border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-100 disabled:opacity-60 dark:border-neutral-600 dark:hover:bg-neutral-800"
        onClick={toggle}
      >
        {active ? t('tabModeStop') : t('tabModeStart')}
      </button>
      {message && (
        <p data-testid="modo-aba-erro" className="mt-1 text-xs text-red-700 dark:text-red-400">
          {message.text()}
        </p>
      )}
    </section>
  )
}

/** Espera depois do último movimento do controle antes de mandar o volume ao SW. */
const VOLUME_DEBOUNCE_MS = 120

const toPercent = (v: number) => Math.round(v * 100)

/**
 * Volume desta aba (Emenda 14), no estilo do Volume Master: de 0% a 200%, aplicado ao vivo. Nunca
 * mexe em gravação; fora de 100% o som da aba sai pela saída padrão do computador.
 *
 * `eligible`: página http ou https, onde o volume pode começar. Fora delas (chrome://, about:,
 * PDF, URL que o popup não vê), a seção só aparece se a aba ainda está com a captura de volume (a
 * captura sobrevive à navegação), para o usuário poder ajustar ou voltar a 100% dali mesmo.
 */
function TabVolume({ tabId, eligible }: { tabId: number; eligible: boolean }) {
  // Valor do controle em porcentagem (null: ainda lendo o SW).
  const [percent, setPercent] = useState<number | null>(null)
  // A aba estava com a captura da extensão quando o popup abriu (fica até o popup fechar, para a
  // seção não sumir debaixo do clique no 100%).
  const [captured, setCaptured] = useState(false)
  const [message, setMessage] = useState<Shown>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Valor movido que ainda não foi ao SW (null: nada pendente).
  const pending = useRef<number | null>(null)

  const apply = async (p: number) => {
    const r = await uiCall({ t: 'ui:tab-volume-set', tabId, volume: p / 100 }).catch((e: unknown) => ({ ok: false, error: String((e as Error)?.message ?? e) }))
    if (r.ok) {
      setMessage(null)
      return
    }
    const error = errorOf(r)
    setMessage({ text: () => t('volumeError', reasonOr(error, 'errUnknown')) })
    // Volta ao valor que vale de verdade.
    const cur = await uiCall({ t: 'ui:tab-volume-get', tabId }).catch(() => null)
    if (cur) setPercent(toPercent(cur.volume))
  }

  /** Manda já o valor pendente (soltar o controle, tecla solta, popup fechando). */
  const flush = () => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    const p = pending.current
    pending.current = null
    // O sendMessage sai na hora: chega ao SW mesmo com o popup fechando.
    if (p !== null) void apply(p)
  }

  useEffect(() => {
    uiCall({ t: 'ui:tab-volume-get', tabId })
      .then((r) => {
        setPercent(toPercent(r.volume))
        if (r.active) setCaptured(true)
      })
      .catch((e: unknown) => {
        // Sem resposta do SW (versão anterior, Emenda 17): o controle fica em 100% e o motivo aparece.
        setPercent(100)
        const error = errorText(e)
        setMessage({ text: () => t('volumeError', helperReason(error)) })
      })
    // Fechar o popup antes do fim da espera não perde o último valor. O `flush` deste render manda
    // para esta aba (o pendente é do controle desta aba).
    window.addEventListener('pagehide', flush)
    return () => {
      window.removeEventListener('pagehide', flush)
      flush()
    }
  }, [tabId])

  const change = (p: number, now = false) => {
    setPercent(p)
    pending.current = p
    if (now) return flush()
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(flush, VOLUME_DEBOUNCE_MS)
  }

  if (!eligible && !captured) return null

  return (
    <section data-testid="volume" className="rounded-lg border border-neutral-200 p-2 dark:border-neutral-700">
      <h2 className="mb-1 text-xs font-semibold uppercase tracking-wide text-neutral-500">{t('volumeHeading')}</h2>
      <div className="flex items-center gap-2">
        <input
          type="range"
          aria-label={t('volumeHeading')}
          data-testid="volume-controle"
          min={toPercent(VOLUME_MIN)}
          max={toPercent(VOLUME_MAX)}
          step={toPercent(VOLUME_STEP)}
          value={percent ?? 100}
          disabled={percent === null}
          className="min-w-0 flex-1 accent-blue-700"
          onChange={(e) => change(Number(e.currentTarget.value))}
          onPointerUp={flush}
          onKeyUp={flush}
        />
        <span data-testid="volume-valor" className="w-11 text-right text-xs tabular-nums">
          {percent === null ? '...' : volumeLabel(percent / 100)}
        </span>
        <button
          type="button"
          disabled={percent === null || percent === 100}
          className="shrink-0 rounded-md border border-neutral-300 px-2 py-0.5 text-xs hover:bg-neutral-100 disabled:opacity-60 dark:border-neutral-600 dark:hover:bg-neutral-800"
          onClick={() => change(100, true)}
        >
          100%
        </button>
      </div>
      <p className="mt-1 text-xs text-neutral-600 dark:text-neutral-400">
        {t('volumeDefaultOutput')}
      </p>
      {!eligible && (
        <p data-testid="volume-fora" className="mt-1 text-xs text-neutral-600 dark:text-neutral-400">
          {t('volumeOutsideSite')}
        </p>
      )}
      {message && (
        <p data-testid="volume-erro" className="mt-1 text-xs text-red-700 dark:text-red-400">
          {message.text()}
        </p>
      )}
    </section>
  )
}

function TranscriptionLine({ rec, state }: { rec: RecentRecording; state: RecentTranscription | 'precisa-helper' }) {
  const [message, setMessage] = useState<Shown>(null)
  const open = async () => {
    const r = await uiCall({ t: 'ui:open-transcript', sessionId: rec.sessionId }).catch((e: unknown) => ({ ok: false, error: String((e as Error)?.message ?? e) }))
    const error = errorOf(r)
    setMessage(r.ok ? null : { text: () => t('trCouldNotOpen', reasonOr(error, 'errUnknown')) })
  }
  if (state === 'precisa-helper')
    return (
      <p data-testid="transcricao" data-status="precisa-helper" className="text-xs text-neutral-600 dark:text-neutral-400">
        {t('trNeedsHelper')}
      </p>
    )
  return (
    <div data-testid="transcricao" data-status={state.status} className="text-xs">
      {state.status === 'pendente' &&
        (state.espera ? (
          <p className="text-amber-800 dark:text-amber-300">{t('trWaiting', helperReason(state.espera))}</p>
        ) : (
          <p className="text-neutral-600 dark:text-neutral-400">{t('trQueued')}</p>
        ))}
      {state.status === 'transcrevendo' && <p className="text-neutral-600 dark:text-neutral-400">{t('trRunning')}</p>}
      {state.status === 'pronta' && (
        <p className="flex items-center gap-2 text-green-700 dark:text-green-400">
          {t('trReady')}
          <button type="button" className="text-blue-700 underline hover:no-underline dark:text-blue-400" onClick={() => void open()}>
            {t('trOpen')}
          </button>
        </p>
      )}
      {state.status === 'falhou' && <p className="text-red-700 dark:text-red-400">{t('trFailed', state.erro ? helperReason(state.erro) : t('reasonUnknown'))}</p>}
      {message && <p className="text-red-700 dark:text-red-400">{message.text()}</p>}
    </div>
  )
}

function RecentItem({ rec, transcription }: { rec: RecentRecording; transcription: TranscriptionUiState | null }) {
  const [message, setMessage] = useState<Shown>(null)
  const reveal = async () => {
    const r = await uiCall({ t: 'ui:reveal', sessionId: rec.sessionId }).catch((e: unknown) => ({ ok: false, error: errorText(e) }))
    const error = errorOf(r)
    setMessage(r.ok ? null : { text: () => t('popupFailed', reasonOr(error, 'errUnknown')) })
  }
  const tr = transcriptionOf(rec, transcription)
  return (
    <li data-testid="recente" data-session={rec.sessionId} className="py-1.5">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate" title={rec.path}>
            {rec.title || t('untitled')}
          </p>
          <p className="text-xs text-neutral-600 dark:text-neutral-400">
            {platformLabel(rec.platform)} · {formatStart(rec.startedAt)} · {formatDuration(rec.durationSeconds)}
            {rec.kind === 'aba' && ` · ${t('tabModeTag')}`}
            {rec.sink === 'downloads' && ` · ${t('recentInDownloads')}`}
            {rec.status === 'interrompida' && <span className="text-amber-700 dark:text-amber-400"> · {t('recentInterrupted')}</span>}
          </p>
        </div>
        {canReveal(rec) && (
          <button type="button" className="shrink-0 text-xs text-blue-700 underline hover:no-underline dark:text-blue-400" onClick={reveal}>
            {t('recentReveal')}
          </button>
        )}
      </div>
      {tr && <TranscriptionLine rec={rec} state={tr} />}
      {message && <p className="text-xs text-red-700 dark:text-red-400">{message.text()}</p>}
    </li>
  )
}

/** Emenda 10: gravações que terminaram e ainda não foram salvas, com o motivo e "Tentar agora". */
function PendingSaves({ pending, onRetried }: { pending: UiState['pendingSaves']; onRetried: () => void }) {
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<Shown>(null)
  const retry = async () => {
    setBusy(true)
    setMessage(null)
    const r = await uiCall({ t: 'ui:retry-saves' }).catch((e) => ({ ok: false, pending: -1, error: String(e?.message ?? e) }))
    setBusy(false)
    const saved = r.ok && r.pending === 0
    setMessage({ text: () => (saved ? t('pendingSaved') : t('pendingNotYet')) })
    onRetried()
  }
  return (
    <section data-testid="nao-salvas" className="rounded-lg border border-amber-300 bg-amber-50 p-2 text-xs text-amber-950 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100">
      <h2 className="mb-1 font-semibold">{t('pendingHeading')}</h2>
      <p className="mb-1">{t('pendingKeep')}</p>
      <ul className="space-y-1">
        {pending.map((p) => (
          <li key={p.sessionId} data-session={p.sessionId}>
            <span className="font-medium">{p.title || t('untitled')}</span> ({platformLabel(p.platform)}, {formatStart(p.startedAt)}): {helperReason(p.error)}
          </li>
        ))}
      </ul>
      <button type="button" disabled={busy} className="mt-2 rounded-md bg-amber-700 px-3 py-1 font-medium text-white hover:bg-amber-800 disabled:opacity-60" onClick={() => void retry()}>
        {busy ? t('pendingTrying') : t('pendingRetry')}
      </button>
      {message && <p className="mt-1">{message.text()}</p>}
    </section>
  )
}

function TranscriptionNotice({ transcription }: { transcription: TranscriptionUiState | null }) {
  const text = transcriptionNotice(transcription)
  if (!text) return null
  return (
    <p data-testid="transcricao-aviso" className="text-xs text-amber-800 dark:text-amber-300">
      {text}
    </p>
  )
}

function HelperLine({ helper }: { helper: UiState['helper'] }) {
  // Emenda 10: "não instalado" e "instalado, mas não abre" têm soluções diferentes. Emenda 15: sem
  // helper é o uso normal da loja, então "não instalado" diz só onde salva, sem tom de alerta.
  const problem = helperProblem(helper)
  if (problem.kind === 'nao-instalado' || problem.kind === 'verificando')
    return (
      <p data-testid="helper" data-helper={problem.kind} className="text-xs text-neutral-600 dark:text-neutral-400">
        {problem.text}
      </p>
    )
  if (problem.kind !== 'ok')
    return (
      <p data-testid="helper" data-helper={problem.kind} className="text-xs text-amber-800 dark:text-amber-300">
        {problem.text}
      </p>
    )
  return (
    <p data-testid="helper" data-helper="ok" className="truncate text-xs text-neutral-600 dark:text-neutral-400" title={helper.root ?? ''}>
      {t('popupSavingIn')} <span className="font-mono">{shortPath(helper.root ?? '')}</span> {t('popupHelperVersion', helper.version ?? '')}
    </p>
  )
}

export function Popup() {
  // Emenda 19: o idioma trocado nas configurações vale na hora, com o popup aberto.
  useLanguage()
  const [state, setState] = useState<UiState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<CurrentTab | null>(null)
  const [vigia, setVigia] = useState<VigiaTabState | null>(null)
  const [stopping, setStopping] = useState<Set<string>>(new Set())
  const [stopErrors, setStopErrors] = useState<Record<string, () => string>>({})
  const [now, setNow] = useState(Date.now())
  const unhandled = useUnhandledUiErrors()

  useEffect(() => {
    void findCurrentTab().then(setTab)
  }, [])

  const watchVigia = !!state?.settings.autoLeave && !!tab?.platform

  const refresh = useCallback(() => {
    setNow(Date.now())
    uiCall({ t: 'ui:state' })
      .then((s) => {
        setState(s)
        setError(null)
      })
      .catch((e) => setError(String(e?.message ?? e)))
    if (watchVigia && tab)
      uiCall({ t: 'ui:vigia-status', tabId: tab.id })
        .then(setVigia)
        .catch(() => setVigia(null))
  }, [watchVigia, tab])

  useEffect(() => {
    refresh()
    const timer = setInterval(refresh, REFRESH_MS)
    return () => clearInterval(timer)
  }, [refresh])

  const stop = async (sessionId: string) => {
    setStopping((s) => new Set(s).add(sessionId))
    setStopErrors(({ [sessionId]: _old, ...rest }) => rest)
    const r = await uiCall({ t: 'ui:stop', sessionId }).catch((e: unknown) => ({ ok: false, error: String((e as Error)?.message ?? e) }))
    if (!r.ok) {
      // Não parou: o botão volta e o motivo aparece no item (senão ficaria em "Parando..." para sempre).
      setStopping((s) => {
        const next = new Set(s)
        next.delete(sessionId)
        return next
      })
      const error = errorOf(r)
      setStopErrors((e) => ({ ...e, [sessionId]: () => reasonOr(error, 'popupStopRefused') }))
    }
    refresh()
  }

  if (error && !state) return <main className="w-[360px] p-4 text-sm text-red-700">{helperReason(error)}</main>
  if (!state) return <main className="w-[360px] p-4 text-sm">{t('popupLoading')}</main>

  const tabSession = tab ? state.active.find((a) => a.tabId === tab.id && a.kind === 'aba') : undefined

  return (
    <main className="w-[360px] space-y-3 bg-white p-3 text-sm text-neutral-900 dark:bg-neutral-900 dark:text-neutral-100">
      <header className="flex items-center justify-between">
        <h1 className="text-base font-semibold">
          {t('extName')}{' '}
          <span data-testid="versao" className="text-xs font-normal text-neutral-500 dark:text-neutral-400">
            v{chrome.runtime.getManifest().version}
          </span>
        </h1>
        <button type="button" className="text-xs text-blue-700 underline hover:no-underline dark:text-blue-400" onClick={() => chrome.runtime.openOptionsPage()}>
          {t('popupSettings')}
        </button>
      </header>

      {/* Emenda 17: o SW rodando é de outra versão que a do disco (ou uma publicação nova espera). */}
      <VersionBanner worker={state.worker} update={state.update} recording={state.active.length > 0} />

      {unhandled && (
        <p data-testid="erro-inesperado" className="text-xs text-red-700 dark:text-red-400">
          {unhandled}
        </p>
      )}

      {state.consentGiven === false && (
        <section data-testid="aviso-consentimento" className="rounded-md bg-blue-50 p-2 text-xs text-blue-900 dark:bg-blue-950 dark:text-blue-200">
          <p>{t('popupConsentNeeded')}</p>
          <button
            type="button"
            className="mt-1 rounded-md bg-blue-700 px-3 py-1 font-medium text-white hover:bg-blue-800"
            onClick={() => void chrome.tabs.create({ url: chrome.runtime.getURL(WELCOME_PAGE) })}
          >
            {t('popupConsentOpen')}
          </button>
        </section>
      )}

      {!state.settings.profileLabel && (
        <p data-testid="lembrete-perfil" className="rounded-md bg-blue-50 p-2 text-xs text-blue-900 dark:bg-blue-950 dark:text-blue-200">
          {t('popupProfileReminderBefore')}{' '}
          <button type="button" className="underline" onClick={() => chrome.runtime.openOptionsPage()}>
            {t('popupProfileReminderLink')}
          </button>
          {t('popupProfileReminderAfter')}
        </p>
      )}

      {tab && state.reloadTabs?.includes(tab.id) && (
        <p data-testid="recarregar-aba" className="rounded-md bg-blue-50 p-2 text-xs text-blue-900 dark:bg-blue-950 dark:text-blue-200">
          {t('popupReloadTab')}
        </p>
      )}

      <section>
        <h2 className="mb-1 text-xs font-semibold uppercase tracking-wide text-neutral-500">{t('popupRecordingNow')}</h2>
        {state.active.length === 0 ? (
          <p className="text-neutral-600 dark:text-neutral-400">{t('popupNoneActive')}</p>
        ) : (
          <ul className="space-y-2">
            {state.active.map((a) => (
              <RecordingItem key={a.sessionId} rec={a} isCurrentTab={a.tabId === tab?.id} now={now} stopping={stopping.has(a.sessionId)} stopError={stopErrors[a.sessionId]} onStop={() => void stop(a.sessionId)} />
            ))}
          </ul>
        )}
      </section>

      {state.pendingSaves?.length > 0 && <PendingSaves pending={state.pendingSaves} onRetried={refresh} />}

      {watchVigia && tab && <VigiaPanel tabId={tab.id} vigia={vigia} confirmacoes={state.settings.vigia.confirmacoes} />}

      {tab && <TabCaptureButton tab={tab} active={tabSession} />}

      {tab && <TabVolume tabId={tab.id} eligible={tab.volumeOk} />}

      <section>
        <h2 className="mb-1 text-xs font-semibold uppercase tracking-wide text-neutral-500">{t('popupRecentHeading')}</h2>
        {state.recent.length === 0 ? (
          <p className="text-neutral-600 dark:text-neutral-400">{t('popupNothingYet')}</p>
        ) : (
          <ul className="divide-y divide-neutral-200 dark:divide-neutral-700">
            {state.recent.slice(0, 5).map((r) => (
              <RecentItem key={r.sessionId} rec={r} transcription={state.transcription ?? null} />
            ))}
          </ul>
        )}
      </section>

      <footer className="space-y-1 border-t border-neutral-200 pt-2 dark:border-neutral-700">
        <HelperLine helper={state.helper} />
        <TranscriptionNotice transcription={state.transcription ?? null} />
      </footer>
    </main>
  )
}
