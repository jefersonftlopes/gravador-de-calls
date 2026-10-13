// Adaptador do Google Meet (seletores com data em docs/pesquisa/meet-e-teams.txt).
//
// Em call = URL com código E botão de sair E ícone de legenda ou chat E sem cabeçalho de saída E
// algum PC connected com receptor de áudio vivo (a sessão exige 2 s estável). Já gravando, a
// call continua sem os ícones e com o PC se recuperando de uma queda de rede (Emenda 10). O botão de sair
// existe também em "pedindo para participar", e o Meet cria um PC descartável em toda página com
// código: nenhum dos dois, sozinho, é sinal.
// Fim = cabeçalho de saída; ou o PC que carregava áudio fechou (pc.close() embrulhado ou estado
// 'closed') sem outro PC com áudio em 5 s. O "em call falso por 15 s" é do controlador.
// Metadados (melhor esforço, nunca lançam): título do DOM relido a cada leitura do controlador
// (a cada 5 s e no fim) e guardado, descartado se for igual ao código; depois document.title sem
// o "Meet"; por fim o código. Participantes dos blocos [data-participant-id], sem o bloco do
// próprio usuário e sem rótulos de efeitos e de dispositivos, acumulados durante a call.
// O próprio nome (Emenda 20): o registro da roster com o campo 7 verdadeiro, no space da call (o
// dos blocos), com o nome completo (2), senão o exibido (29); reserva no [data-self-name] do DOM.
import type { CallMeta, EndReason } from '../../shared/protocol'
import { isMeetHost } from '../../shared/hosts'
import { createMeetSpeakers } from './meet-speakers'
import { spaceOf } from '../speakers/meet-signals'
import type { PlatformAdapter, Probe } from './types'

export const MEET_CODE_RE = /^\/([a-z]{3}-[a-z]{4}-[a-z]{3})(?:\/|$)/

const LEAVE_BUTTON = 'button[jsname="CQylAd"]'
const EXIT_HEADING = 'h1[jsname="r4nke"]'
const TITLE_SELECTORS = [
  ['NeC6gb', '[jsname="NeC6gb"]'],
  ['u6vdEc', '.u6vdEc'],
] as const
const TITLE = TITLE_SELECTORS.map(([, sel]) => sel).join(', ')
const ICONS = '.google-symbols'
const CAPTION_OR_CHAT = new Set(['closed_caption', 'closed_caption_off', 'chat'])
const PC_CLOSED_GRACE_MS = 5000
const TILE = '[data-participant-id]'
const TILE_NAME = 'span.notranslate'
const SELF = '[data-self-name]'

/** Limites do callMetaSchema (src/shared/protocol.ts): fora deles o SW descartaria a mensagem. */
export const META_LIMITS = { title: 1000, name: 300, names: 1000 } as const

/**
 * Rótulos de bloco que não são pessoas: o bloco de "Planos de fundo e efeitos" (existe até no
 * pré-join), e os nomes internos que o Meet mostra quando ainda não resolveu o participante.
 */
const JUNK_NAMES = [/visual_effects|backgrounds and effects|planos de fundo e efeitos/i, /^Google Participant \(|spaces\/|devices\//]

/** Código da reunião na URL do Meet (também pelo proxy do Defender for Cloud Apps, Emenda 17). */
export function meetCode(loc: Pick<Location, 'hostname' | 'pathname'>): string | null {
  if (!isMeetHost(loc.hostname)) return null
  return MEET_CODE_RE.exec(loc.pathname)?.[1] ?? null
}

/** O elemento está na tela? (um cabeçalho de saída montado mas escondido não conta). */
function visible(el: Element | null): boolean {
  if (!el) return false
  const check = (el as Element & { checkVisibility?: () => boolean }).checkVisibility
  return typeof check === 'function' ? check.call(el) : true
}

function exitHeadingVisible(): boolean {
  for (const el of Array.from(document.querySelectorAll(EXIT_HEADING))) if (visible(el)) return true
  return false
}

function iconTexts(): Set<string> {
  const out = new Set<string>()
  for (const el of Array.from(document.querySelectorAll(ICONS))) {
    const t = el.textContent?.trim()
    if (t) out.add(t)
  }
  return out
}

/** Tira "Meet - " do começo e " - Google Meet" do fim (com -, en dash, em dash, : ou |). */
export function stripMeetTitle(title: string): string {
  return title
    .replace(/^\s*(Google\s+)?Meet\s*[-:|\u2013\u2014]\s*/i, '')
    .replace(/\s*[-:|\u2013\u2014]\s*(Google\s+)?Meet\s*$/i, '')
    .trim()
}

/** Espaços colapsados e cortado no limite do protocolo. */
export function cleanName(raw: string | null | undefined, max: number = META_LIMITS.name): string {
  return (raw ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
}

/** Rótulo de bloco que é uma pessoa (não é efeito, dispositivo nem vazio). */
export function isPersonLabel(name: string): boolean {
  return name.length > 0 && !JUNK_NAMES.some((re) => re.test(name))
}

/** Um bloco de vídeo já lido do DOM: os rótulos dele e se é o do próprio usuário. */
export interface MeetTile {
  isSelf: boolean
  label: string
}

/**
 * Nomes dos participantes a partir dos blocos (função pura, testada com vitest): sem o bloco do
 * próprio usuário, sem rótulos que não são pessoas, sem repetição e sem o próprio nome (reserva,
 * caso o marcador do próprio usuário não esteja dentro do bloco).
 */
export function participantNames(tiles: readonly MeetTile[], selfName: string): string[] {
  const out = new Set<string>()
  for (const t of tiles) {
    if (t.isSelf) continue
    const name = cleanName(t.label)
    if (!isPersonLabel(name) || (selfName && name === selfName)) continue
    out.add(name)
  }
  return [...out]
}

/** Um bloco lido do DOM, com o id dele (o deviceId 'spaces/<s>/devices/<n>'). */
interface DomTile extends MeetTile {
  participantId: string
}

/** Lê os blocos, o próprio nome do DOM e o space da call (o dos ids dos blocos). */
function readTiles(): { tiles: DomTile[]; selfName: string; marker: boolean; space: string | null } {
  let selfName = ''
  let marker = false
  const selfTiles = new Set<Element>()
  for (const mark of Array.from(document.querySelectorAll(SELF))) {
    marker = true
    selfName ||= cleanName(mark.getAttribute('data-self-name')) || cleanName(mark.textContent)
    const tile = mark.closest(TILE)
    if (tile) selfTiles.add(tile)
  }
  const tiles: DomTile[] = []
  let space: string | null = null
  for (const el of Array.from(document.querySelectorAll(TILE))) {
    const participantId = el.getAttribute?.('data-participant-id') ?? ''
    space ??= spaceOf(participantId)
    const isSelf = selfTiles.has(el) || el.querySelector(SELF) !== null
    tiles.push({ isSelf, label: el.querySelector(TILE_NAME)?.textContent ?? '', participantId })
  }
  return { tiles, selfName, marker, space }
}

/** O que foi visto durante a call, por código de reunião (o Meet só mostra parte dos blocos). */
interface Seen {
  code: string
  domTitle: string
  /** document.title visto pela última vez em call (a tela de saída volta para "Meet"). */
  tabTitle: string
  names: Set<string>
  selfName: string
  /** Rótulo lido de cada bloco, pelo id (para tirar o do próprio usuário lido antes da roster). */
  labels: Map<string, string>
  /** O marcador [data-self-name] apareceu alguma vez (diagnóstico, Emenda 20). */
  marker: boolean
  /** O que o elemento do título mostrou de mais forte durante a call (diagnóstico, Emenda 20). */
  titleElement: TitleSignals['element']
  titleSelector: TitleSignals['selector']
}

type TitleSignals = NonNullable<CallMeta['titleSignals']>
const TITLE_STRENGTH = { ausente: 0, codigo: 1, outro: 2 } as const
/** Resultado da última avaliação de isInCall. */
let lastInCall = false
const emptySeen = (code: string): Seen => ({
  code,
  domTitle: '',
  tabTitle: '',
  names: new Set(),
  selfName: '',
  labels: new Map(),
  marker: false,
  titleElement: 'ausente',
  titleSelector: null,
})

/**
 * Diagnóstico passivo do título (Emenda 20): qual elemento respondeu e se mostrava o código. Numa
 * daily real (13/10/2026) o título caiu no código e a aba dizia "Meet: <código>"; o Meet mostra o
 * código quando não conhece o evento para aquela conta. Fica o mais forte visto na call.
 */
function noteTitleElement(s: Seen, code: string): void {
  for (const [name, sel] of TITLE_SELECTORS) {
    const text = cleanName(document.querySelector(sel)?.textContent, META_LIMITS.title)
    if (!text) continue
    const element: TitleSignals['element'] = text === code ? 'codigo' : 'outro'
    if (TITLE_STRENGTH[element] > TITLE_STRENGTH[s.titleElement]) {
      s.titleElement = element
      s.titleSelector = name
    }
    return
  }
}
let seen: Seen = emptySeen('')

function seenFor(code: string): Seen {
  if (seen.code !== code) seen = emptySeen(code)
  return seen
}

/** Zera o que foi acumulado (testes de unidade), inclusive a roster. */
export function resetMeetMemory(): void {
  lastInCall = false
  seen = emptySeen('')
  meetSpeakers.roster.reset()
}

/**
 * Título a partir das três fontes, na ordem do contrato (função pura, testada com vitest).
 * `domTitle` já é o melhor título do DOM visto até agora.
 */
export function pickMeetTitle(domTitle: string, tabTitle: string, code: string): Pick<CallMeta, 'title' | 'titleSource'> {
  const dom = cleanName(domTitle, META_LIMITS.title)
  if (dom && dom !== code) return { title: dom, titleSource: 'dom' }
  const fromTab = cleanName(stripMeetTitle(tabTitle), META_LIMITS.title)
  if (fromTab && fromTab !== code && !/^(google\s+)?meet$/i.test(fromTab)) return { title: fromTab, titleSource: 'titulo-da-aba' }
  return { title: code, titleSource: code ? 'codigo' : 'nenhum' }
}

/** Os cinco sinais de "em call" (a estabilidade de 2 s é do controlador). */
function inCallNow(probe: Probe): boolean {
  if (!meetCode(location)) return false
  if (exitHeadingVisible()) return false
  const icons = iconTexts()
  const leave = !!document.querySelector(LEAVE_BUTTON) || icons.has('call_end')
  if (!leave) return false
  let captionsOrChat = false
  for (const name of CAPTION_OR_CHAT) if (icons.has(name)) captionsOrChat = true
  return captionsOrChat && probe.connectedWithLiveAudio
}

/**
 * Já gravando (Emenda 10): os ícones de legenda e chat só servem para separar a sala de espera no
 * começo; numa janela estreita o Meet os leva para o menu "mais opções". Continua na call com a
 * URL da reunião, o botão de sair, sem a tela de saída e com um PC com áudio, conectado ou se
 * recuperando de uma queda de rede.
 */
function stillInCallNow(probe: Probe): boolean {
  if (!meetCode(location)) return false
  if (exitHeadingVisible()) return false
  const leave = !!document.querySelector(LEAVE_BUTTON) || iconTexts().has('call_end')
  return leave && (probe.connectedWithLiveAudio || probe.reconnectingWithAudio)
}

/**
 * Sinais de falante do Meet (Emenda 18): estado da página, ligado na instalação. A roster dele também
 * diz o próprio nome (Emenda 20). Exportado para os testes entregarem a roster.
 */
export const meetSpeakers = createMeetSpeakers()

export const meetAdapter: PlatformAdapter = {
  id: 'meet',
  installSpeakerSignals: (ctx) => meetSpeakers.install(ctx),
  readSpeakers: (probe) => meetSpeakers.read(probe),
  speakerAliases: () => meetSpeakers.aliases(),
  speakerDiagnostics: () => meetSpeakers.diagnostics(),
  matchesUrl: (loc) => meetCode(loc) !== null,
  seamPriority: ['receivers', 'sources', 'elements', 'output'],
  isInCall(probe: Probe) {
    const inCall = inCallNow(probe)
    lastInCall = inCall
    if (inCall) seenFor(meetCode(location) ?? '').tabTitle = document.title.slice(0, META_LIMITS.title)
    return inCall
  },
  stillInCall(probe: Probe) {
    const inCall = stillInCallNow(probe)
    lastInCall = inCall
    if (inCall) seenFor(meetCode(location) ?? '').tabTitle = document.title.slice(0, META_LIMITS.title)
    return inCall
  },
  endSignal(probe: Probe): EndReason | null {
    let reason: EndReason | null = null
    if (exitHeadingVisible()) reason = 'saiu-da-call'
    else if (probe.audioPcClosedAt !== null && !probe.connectedWithLiveAudio && probe.now - probe.audioPcClosedAt >= PC_CLOSED_GRACE_MS) {
      reason = 'call-encerrada'
    }
    // A call acabou: a releitura do fim usa a aba da última leitura em call.
    if (reason) lastInCall = false
    return reason
  },
  readMeta(): Partial<CallMeta> {
    const code = meetCode(location) ?? ''
    const s = seenFor(code)
    // Fora da call (tela de saída, fim) vale a aba da última leitura em call.
    const tabTitle = lastInCall || !s.tabTitle ? document.title.slice(0, META_LIMITS.title) : s.tabTitle
    const meta: Partial<CallMeta> = { code, url: location.href.slice(0, 4000), tabTitle }
    // Título do DOM: o Meet preenche com atraso e mostra o código quando não há evento. Guardado,
    // para uma leitura em que o elemento sumiu (outro layout) não voltar ao título da aba.
    const dom = cleanName(document.querySelector(TITLE)?.textContent, META_LIMITS.title)
    if (dom && dom !== code) s.domTitle = dom
    try {
      noteTitleElement(s, code)
    } catch {
      // diagnóstico: nunca impede o resto
    }
    const roster = meetSpeakers.roster
    let selfDevice = ''
    let fromRoster = false
    try {
      const { tiles, selfName, marker, space } = readTiles()
      // Os blocos dizem o space da call antes de escolher o registro do próprio usuário.
      if (space) roster.callSpace = space
      const self = roster.self()
      const rosterName = cleanName(self?.fullName) || cleanName(self?.displayName)
      if (self && rosterName) {
        selfDevice = self.deviceId
        fromRoster = true
        s.selfName = rosterName
      }
      if (marker) s.marker = true
      if (selfName && !fromRoster) s.selfName = selfName
      for (const t of tiles) if (t.participantId) s.labels.set(t.participantId, cleanName(t.label))
      for (const n of participantNames(tiles, s.selfName)) {
        if (s.names.size >= META_LIMITS.names) break
        s.names.add(n)
      }
    } catch {
      // melhor esforço: participantes nunca impedem o resto dos metadados
    }
    if (s.selfName) s.names.delete(s.selfName)
    // O bloco do próprio usuário pelo device (regra estrutural, sem o marcador do DOM): o rótulo
    // dele sai, inclusive o lido antes de a roster dizer quem ele é e o diferente do nome.
    const ownLabel = selfDevice ? s.labels.get(selfDevice) : undefined
    if (ownLabel) s.names.delete(ownLabel)
    return {
      ...meta,
      ...pickMeetTitle(s.domTitle, tabTitle, code),
      participants: [...s.names],
      ...(s.selfName ? { selfName: s.selfName } : {}),
      selfSignals: { roster: fromRoster, spaces: roster.spaces.size, domMarker: s.marker },
      titleSignals: {
        element: s.titleElement,
        selector: s.titleSelector,
        tabEqualsCode: code !== '' && cleanName(stripMeetTitle(tabTitle), META_LIMITS.title) === code,
      },
    }
  },
}
