// Adaptador do Microsoft Teams web (seletores com data em docs/pesquisa/meet-e-teams.txt e os
// verificados ao vivo pelo usuário na Emenda 2).
//
// Em call = objeto da call do Teams (MAIN world) no estado 3 (Connected). Sem objeto (ou sem
// estado legível): controle de call na tela (#hangup-button e variantes, #microphone-button,
// #call-duration-custom) E nenhum marcador de pré-join, lobby ou tela de fim E algum PC
// connected com áudio remoto vivo. A barra com o botão de desligar também aparece no lobby, por
// isso o objeto vem primeiro e a reserva pelo DOM exige o PC.
// Espera = estado 4 ou 5 (continua gravando e marca o período).
// Fim = estado 6 ou 7; tela de fim da reunião anônima; ou, sem estado de call conectada, botão
// de desligar ausente por 5 s com a faixa principal encerrada. O "em call falso por 15 s" é do
// controlador.
// Receptores: se alguma faixa remota vem num stream `mainAudio*`, só elas entram (o Teams manda
// também faixas redundantes `dominantSpeaker-*`, cujo áudio já está na mistura).
// Memória dos metadados: é da reunião, não da aba (a aba do Teams v2 vive o dia todo e passa por
// várias reuniões). Ela é zerada quando a identidade muda (thread do objeto, thread da URL ou
// código curto diferente do guardado), quando um pré-join aparece depois de um período em call e
// quando outra call começa depois de um fim. O fim é visto aqui mesmo (estado 6/7, tela de fim,
// 15 s fora da call), não só pelo endSignal: a sessão também acaba pelo popup ou pelo controlador.
import type { CallMeta, EndReason } from '../../shared/protocol'
import type { RemoteAudioTrack } from '../capture/registry'
import { isTeamsHost } from '../../shared/hosts'
import { META_LIMITS, cleanName } from './meet'
import { createTeamsSpeakers } from './teams-speakers'
import type { PlatformAdapter, Probe } from './types'

/** CallState do Teams (build 26091712215, 2026-10-06). */
export const CALL_STATE = { connected: 3, localHold: 4, remoteHold: 5, disconnecting: 6, disconnected: 7, inLobby: 10 } as const
/** participant.state: esperando no lobby (não está na call). */
const PARTICIPANT_IN_LOBBY = 7

const HANGUP = '#hangup-button, [data-tid="hangup-main-btn"], [data-inp="hangup-button"], [data-tid="call-hangup"]'
const IN_CALL_CONTROLS = `${HANGUP}, #microphone-button, #call-duration-custom`
const PREJOIN = '[data-tid="prejoin-join-button"], [data-tid="prejoin-display-name-input"], button[data-tid="joinOnWeb"], [data-tid="calling-prejoin-screen"]'
const LOBBY = '[data-tid="calling-lobby-screen"], [data-tid="calling-connecting-screen"]'
const END_SCREEN = '[data-testid="calling-anon-meeting-end-screen"]'
const HEADER_TITLE = '[data-tid="meeting-header-title"]'
const ROSTER_ROW = '[data-cid="roster-participant"]'
const ROSTER_SECTIONS = ['participantsInCall-', 'attendeesInMeeting-']
const HANGUP_GONE_MS = 5000
/** Fora da call por tanto tempo, depois de ter estado nela: a call acabou (o mesmo do controlador). */
const OUT_OF_CALL_END_MS = 15000

const THREAD_RE = /19:meeting_[A-Za-z0-9_-]+@thread\.v2/
const SHORT_CODE_RE = /\/meet\/(\d{10,15})(?=[/?#&]|$)/
const TAB_SUFFIX_RE = /\s*\|\s*Microsoft Teams\s*$/i
/** document.title de casca, sem o assunto da reunião. */
const SHELL_TITLES = [/^microsoft teams( meeting)?$/i, /^reuni[aã]o do microsoft teams$/i]

/** O que lemos do objeto da call do Teams (tudo opcional: é interno e muda sem aviso). */
export interface TeamsCallLike {
  state?: unknown
  threadId?: unknown
  participants?: unknown
  localSignalingParticipant?: unknown
}

type TeamsWindow = {
  callingDebug?: { observableCall?: unknown }
  msteamscalling?: { deref?: () => { callingService?: { getActiveCall?: () => unknown } } | undefined }
}

/**
 * Objeto da call ativa: `callingDebug.observableCall` (reuniões leves, anônimas) ou
 * `msteamscalling.deref().callingService.getActiveCall()` (v2). Nunca lança.
 */
export function activeCall(win: unknown): TeamsCallLike | null {
  try {
    const w = win as TeamsWindow
    const call = w.callingDebug?.observableCall ?? w.msteamscalling?.deref?.()?.callingService?.getActiveCall?.()
    return call !== null && typeof call === 'object' ? (call as TeamsCallLike) : null
  } catch {
    return null
  }
}

/** Estado numérico da call, ou null se não houver objeto ou o campo não for número. */
export function callState(call: TeamsCallLike | null): number | null {
  try {
    const s = call?.state
    return typeof s === 'number' && Number.isFinite(s) ? s : null
  } catch {
    return null
  }
}

function readString(obj: unknown, key: string): string {
  try {
    const v = obj !== null && typeof obj === 'object' ? (obj as Record<string, unknown>)[key] : undefined
    return typeof v === 'string' ? v : ''
  } catch {
    return ''
  }
}

/** Itens de `participants`, seja array, iterável (Map, Set) ou objeto simples. */
function listOf(value: unknown): unknown[] {
  try {
    if (Array.isArray(value)) return value
    if (value instanceof Map) return [...value.values()]
    if (value !== null && typeof value === 'object') {
      const it = (value as { [Symbol.iterator]?: unknown })[Symbol.iterator]
      if (typeof it === 'function') return [...(value as Iterable<unknown>)]
      return Object.values(value as object)
    }
  } catch {
    // nada
  }
  return []
}

/**
 * Nomes dos participantes remotos do objeto da call (função pura): sem quem está no lobby
 * (state 7), sem nome vazio, sem repetição. `participants` só tem os remotos.
 */
export function callParticipantNames(call: TeamsCallLike | null): string[] {
  const out = new Set<string>()
  for (const p of listOf(call?.participants)) {
    try {
      if ((p as { state?: unknown }).state === PARTICIPANT_IN_LOBBY) continue
    } catch {
      continue
    }
    const name = cleanName(readString(p, 'displayName'))
    if (name) out.add(name)
  }
  return [...out]
}

export function callSelfName(call: TeamsCallLike | null): string {
  try {
    return cleanName(readString(call?.localSignalingParticipant, 'displayName'))
  } catch {
    return ''
  }
}

/** Nome de uma linha do painel de pessoas pelo `data-tid` (só as seções de quem está na call). */
export function rosterName(dataTid: string | null): string {
  for (const prefix of ROSTER_SECTIONS) {
    if (dataTid?.startsWith(prefix)) return cleanName(dataTid.slice(prefix.length))
  }
  return ''
}

/**
 * Seções do aplicativo que o Teams v2 põe no título da aba ("Chat | Fulano | Microsoft Teams",
 * "Calendário | Microsoft Teams"): não são o assunto da reunião. Emenda 10.
 */
const APP_SECTIONS = /^(chat|bate-papo|calend[aá]rio|calendar|atividade|activity|equipes|teams|chamadas|calls|reuni[aã]o|meeting|meet|arquivos|files|aplicativos|apps)$/i
const UNREAD_PREFIX_RE = /^\(\d+\)\s*/

/**
 * document.title sem o sufixo " | Microsoft Teams", sem a contagem de não lidas e sem as seções do
 * aplicativo; vazio se for só a casca.
 */
export function stripTeamsTitle(title: string): string {
  const parts = title
    .replace(TAB_SUFFIX_RE, '')
    .split('|')
    .map((p, i) => (i === 0 ? p.replace(UNREAD_PREFIX_RE, '') : p).trim())
    .filter((p) => p && !APP_SECTIONS.test(p) && !/^microsoft teams$/i.test(p))
  const t = cleanName(parts.join(' | '), META_LIMITS.title)
  return SHELL_TITLES.some((re) => re.test(t)) ? '' : t
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

/** ID longo (thread) e código curto (/meet/<dígitos>) a partir da URL e do objeto da call. */
export function teamsIds(href: string, call: TeamsCallLike | null): { meetingId: string; code: string } {
  const url = safeDecode(href)
  const fromCall = readString(call, 'threadId')
  const meetingId = (fromCall || THREAD_RE.exec(url)?.[0] || '').slice(0, 500)
  const code = SHORT_CODE_RE.exec(url)?.[1] ?? ''
  return { meetingId, code }
}

/**
 * Filtro dos receptores (Emenda 5): se alguma faixa vem num stream cujo id começa com
 * `mainAudio` (sem diferenciar maiúsculas), só essas; senão, todas.
 */
export function filterMainAudio(all: readonly RemoteAudioTrack[]): readonly RemoteAudioTrack[] {
  const isMain = (r: RemoteAudioTrack) => {
    try {
      if (r.streams.some((s) => typeof s.id === 'string' && s.id.toLowerCase().startsWith('mainaudio'))) return true
      return typeof r.track.id === 'string' && r.track.id.toLowerCase().startsWith('mainaudio')
    } catch {
      return false
    }
  }
  const main = all.filter(isMain)
  return main.length > 0 ? main : all
}

function present(selector: string): boolean {
  return document.querySelector(selector) !== null
}

/**
 * O que foi visto desta reunião (título do cabeçalho lido já no pré-join, ids, participantes).
 * Zerado pelas regras do comentário do topo.
 */
interface Seen {
  headerTitle: string
  /** document.title visto pela última vez com a call conectada (depois do fim ele vira "Chat"...). */
  tabTitle: string
  /** Thread pelo objeto da call e pela URL, guardados à parte: cada fonte só é comparada com ela mesma. */
  threadFromCall: string
  threadFromUrl: string
  code: string
  names: Set<string>
  selfName: string
}
const fresh = (): Seen => ({ headerTitle: '', tabTitle: '', threadFromCall: '', threadFromUrl: '', code: '', names: new Set(), selfName: '' })
let seen: Seen = fresh()
/** A última call terminou (fim visto): a próxima call começa a memória do zero. */
let ended = false
/** Esteve em call desde a última vez que a memória foi zerada. */
let hadCall = false
let lastInCall = false
let outOfCallSince: number | null = null
let hangupGoneSince: number | null = null

function forget(): void {
  seen = fresh()
  ended = false
  hadCall = false
  outOfCallSince = null
}

/** Zera a memória (testes de unidade). */
export function resetTeamsMemory(): void {
  forget()
  lastInCall = false
  hangupGoneSince = null
}

/** Valor novo e não vazio, diferente do guardado (também não vazio): é outra reunião. */
const differs = (stored: string, now: string) => stored !== '' && now !== '' && stored !== now

/** Lê o que dá para guardar já antes da call (pré-join, lobby) e a cada leitura. */
function observe(call: TeamsCallLike | null): void {
  const prejoin = present(PREJOIN)
  if (prejoin && (ended || hadCall)) forget()
  // Objeto de uma call já desligada (6/7) é resto da anterior: o id dele não identifica a próxima.
  const state = callState(call)
  const stale = state === CALL_STATE.disconnecting || state === CALL_STATE.disconnected
  const fromCall = stale ? '' : teamsIds('', call).meetingId
  const fromUrl = teamsIds(location.href, null)
  if (differs(seen.threadFromCall, fromCall) || differs(seen.threadFromUrl, fromUrl.meetingId) || differs(seen.code, fromUrl.code)) forget()
  if (fromCall) seen.threadFromCall = fromCall
  if (fromUrl.meetingId) seen.threadFromUrl = fromUrl.meetingId
  if (fromUrl.code) seen.code = fromUrl.code
  const header = document.querySelector(HEADER_TITLE)
  const headerTitle = cleanName(header?.getAttribute('title') || header?.textContent, META_LIMITS.title)
  // No pré-join o cabeçalho é o desta reunião, inclusive quando não há nenhum.
  if (headerTitle || prejoin) seen.headerTitle = headerTitle
}

function domInCall(probe: Probe): boolean {
  if (present(END_SCREEN) || present(PREJOIN) || present(LOBBY)) return false
  return present(IN_CALL_CONTROLS) && probe.connectedWithLiveAudio
}

/** Sinais de falante do Teams (Emenda 18): estado da página, ligado na instalação. */
const speakers = createTeamsSpeakers()

export const teamsAdapter: PlatformAdapter = {
  id: 'teams',
  installSpeakerSignals: (ctx) => speakers.install(ctx),
  readSpeakers(probe) {
    const call = activeCall(window)
    return speakers.read(probe, call, callSelfName(call) || seen.selfName)
  },
  speakerAliases: () => speakers.aliases(activeCall(window)),
  // Os hosts do Teams e as formas pelo proxy do Defender for Cloud Apps (src/shared/hosts.ts).
  matchesUrl: (loc) => isTeamsHost(loc.hostname),
  seamPriority: ['elements', 'receivers', 'sources', 'output'],
  filterReceiverTracks: filterMainAudio,
  isInCall(probe: Probe) {
    const call = activeCall(window)
    observe(call)
    const state = callState(call)
    const inCall = state !== null ? state === CALL_STATE.connected : domInCall(probe)
    const holding = state === CALL_STATE.localHold || state === CALL_STATE.remoteHold
    if (inCall && !lastInCall) {
      hangupGoneSince = null
      if (ended) {
        // Outra call na mesma aba sem pré-join (ex.: chamada recebida): memória nova.
        forget()
        observe(call)
      }
    }
    // O fim visto daqui, para quando a sessão acabou sem o endSignal (popup, "fora da call").
    if (hadCall && !inCall) {
      if (state === CALL_STATE.disconnecting || state === CALL_STATE.disconnected || present(END_SCREEN)) ended = true
      if (holding) outOfCallSince = null
      else {
        outOfCallSince ??= probe.now
        if (probe.now - outOfCallSince >= OUT_OF_CALL_END_MS) ended = true
      }
    }
    if (inCall) {
      hadCall = true
      outOfCallSince = null
      seen.tabTitle = document.title.slice(0, META_LIMITS.title)
    }
    lastInCall = inCall
    return inCall
  },
  isOnHold(): boolean {
    const state = callState(activeCall(window))
    return state === CALL_STATE.localHold || state === CALL_STATE.remoteHold
  },
  endSignal(probe: Probe): EndReason | null {
    const state = callState(activeCall(window))
    let reason: EndReason | null = null
    if (state === CALL_STATE.disconnecting || state === CALL_STATE.disconnected) reason = 'saiu-da-call'
    else if (present(END_SCREEN)) reason = 'saiu-da-call'
    else {
      // Botão de desligar ausente por 5 s com a faixa principal encerrada. Só vale quando o
      // objeto não diz que a call está conectada ou em espera (aí quem manda é o objeto).
      const objectSaysInCall = state === CALL_STATE.connected || state === CALL_STATE.localHold || state === CALL_STATE.remoteHold
      if (objectSaysInCall || present(HANGUP)) hangupGoneSince = null
      else {
        hangupGoneSince ??= probe.now
        if (probe.now - hangupGoneSince >= HANGUP_GONE_MS && !probe.connectedWithLiveAudio) reason = 'call-encerrada'
      }
    }
    if (reason) {
      ended = true
      // A call acabou: a releitura do fim usa a aba da última leitura em call.
      lastInCall = false
      hangupGoneSince = null
    }
    return reason
  },
  readMeta(): Partial<CallMeta> {
    const call = activeCall(window)
    observe(call)
    const s = seen
    try {
      const self = callSelfName(call)
      if (self) s.selfName = self
      const names = callParticipantNames(call)
      if (names.length === 0) {
        // Reserva: o painel de pessoas, quando está aberto.
        for (const row of Array.from(document.querySelectorAll(ROSTER_ROW))) {
          const n = rosterName(row.getAttribute('data-tid'))
          if (n) names.push(n)
        }
      }
      for (const n of names) {
        if (s.names.size >= META_LIMITS.names) break
        s.names.add(n)
      }
    } catch {
      // melhor esforço
    }
    if (s.selfName) s.names.delete(s.selfName)
    // Fora da call (espera, fim) vale a aba da última leitura em call: depois de desligar, o Teams
    // volta para "Chat | Microsoft Teams", que não é o título da reunião.
    const tabTitle = lastInCall || !s.tabTitle ? document.title.slice(0, META_LIMITS.title) : s.tabTitle
    const fromTab = stripTeamsTitle(tabTitle)
    const title: Pick<CallMeta, 'title' | 'titleSource'> = s.headerTitle
      ? { title: s.headerTitle, titleSource: 'dom' }
      : fromTab
        ? { title: fromTab, titleSource: 'titulo-da-aba' }
        : { title: s.code, titleSource: s.code ? 'codigo' : 'nenhum' }
    return {
      url: location.href.slice(0, 4000),
      tabTitle,
      code: s.code,
      meetingId: (s.threadFromCall || s.threadFromUrl).slice(0, 500),
      ...title,
      participants: [...s.names],
      ...(s.selfName ? { selfName: s.selfName } : {}),
    }
  },
}
