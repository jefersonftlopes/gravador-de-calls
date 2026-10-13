// Adaptador do Teams numa janela falsa: objeto da call nas duas formas conhecidas, reserva pelo
// DOM, fim por estado, por tela e por botão sumido, metadados e o filtro `mainAudio`.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RemoteAudioTrack } from '../capture/registry'
import {
  activeCall,
  callParticipantNames,
  callSelfName,
  callState,
  filterMainAudio,
  resetTeamsMemory,
  rosterName,
  stripTeamsTitle,
  teamsAdapter,
  teamsIds,
  type TeamsCallLike,
} from './teams'
import type { Probe } from './types'

class FakeEl {
  constructor(readonly attrs: Record<string, string> = {}, readonly textContent = '') {}
  getAttribute(name: string): string | null {
    return this.attrs[name] ?? null
  }
}

/** Documento falso: cada seletor simples aponta para os elementos "na tela". */
class FakeDoc {
  title = 'Microsoft Teams meeting | Microsoft Teams'
  readonly els = new Map<string, FakeEl[]>()
  show(selector: string, el = new FakeEl()) {
    this.els.set(selector, [...(this.els.get(selector) ?? []), el])
  }
  hide(selector: string) {
    this.els.delete(selector)
  }
  querySelectorAll(list: string): FakeEl[] {
    return list.split(',').flatMap((s) => this.els.get(s.trim()) ?? [])
  }
  querySelector(list: string): FakeEl | null {
    return this.querySelectorAll(list)[0] ?? null
  }
}

let doc: FakeDoc
let win: Record<string, unknown>
const loc = { hostname: 'teams.microsoft.com', href: 'https://teams.microsoft.com/meet/1234567890123?p=abc' }

const probe = (over: Partial<Probe> = {}): Probe => ({
  now: 0,
  pcsOpen: 1,
  pcsConnected: 1,
  connectedWithLiveAudio: true,
  reconnectingWithAudio: false,
  liveRemoteAudioTracks: 1,
  audioPcClosedAt: null,
  ...over,
})

function v2(call: TeamsCallLike | undefined) {
  win.msteamscalling = { deref: () => ({ callingService: { getActiveCall: () => call } }) }
}

beforeEach(() => {
  resetTeamsMemory()
  doc = new FakeDoc()
  win = {}
  loc.href = 'https://teams.microsoft.com/meet/1234567890123?p=abc'
  vi.stubGlobal('document', doc)
  vi.stubGlobal('window', win)
  vi.stubGlobal('location', loc)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('objeto da call', () => {
  it('lê as duas formas conhecidas e nunca lança', () => {
    const call = { state: 3 }
    expect(activeCall({ callingDebug: { observableCall: call } })).toBe(call)
    expect(activeCall({ msteamscalling: { deref: () => ({ callingService: { getActiveCall: () => call } }) } })).toBe(call)
    // callingDebug vence quando os dois existem (reuniões leves).
    const other = { state: 7 }
    expect(activeCall({ callingDebug: { observableCall: call }, msteamscalling: { deref: () => ({ callingService: { getActiveCall: () => other } }) } })).toBe(call)
    expect(activeCall({})).toBeNull()
    expect(activeCall({ msteamscalling: { deref: () => undefined } })).toBeNull()
    expect(activeCall({ msteamscalling: { deref: () => ({ callingService: { getActiveCall: () => 'x' } }) } })).toBeNull()
    const throwing = {
      get callingDebug(): never {
        throw new Error('getter da página')
      },
    }
    expect(activeCall(throwing)).toBeNull()
    expect(activeCall({ msteamscalling: { deref: () => { throw new Error('WeakRef morta') } } })).toBeNull()
  })

  it('estado só quando é número', () => {
    expect(callState({ state: 3 })).toBe(3)
    expect(callState({ state: '3' })).toBeNull()
    expect(callState({})).toBeNull()
    expect(callState(null)).toBeNull()
    const throwing = {
      get state(): never {
        throw new Error('x')
      },
    }
    expect(callState(throwing)).toBeNull()
  })

  it('participantes: sem o lobby (state 7), sem nome vazio, sem repetição; aceita array, Map e objeto', () => {
    const list = [
      { displayName: 'Ana Souza', state: 3 },
      { displayName: ' Bruno  Lima ', state: 3 },
      { displayName: 'No lobby', state: 7 },
      { displayName: '', state: 3 },
      { state: 3 },
      null,
      { displayName: 'Ana Souza', state: 3 },
    ]
    expect(callParticipantNames({ participants: list })).toEqual(['Ana Souza', 'Bruno Lima'])
    expect(callParticipantNames({ participants: new Map([['a', { displayName: 'Carla' }]]) })).toEqual(['Carla'])
    expect(callParticipantNames({ participants: { a: { displayName: 'Davi' } } })).toEqual(['Davi'])
    expect(callParticipantNames({ participants: 42 })).toEqual([])
    expect(callParticipantNames(null)).toEqual([])
    expect(callSelfName({ localSignalingParticipant: { displayName: 'Alex Lima' } })).toBe('Alex Lima')
    expect(callSelfName({})).toBe('')
  })
})

describe('metadados puros', () => {
  it('título da aba sem o sufixo, e a casca não é título', () => {
    expect(stripTeamsTitle('Planejamento | Microsoft Teams')).toBe('Planejamento')
    expect(stripTeamsTitle('Microsoft Teams meeting | Microsoft Teams')).toBe('')
    expect(stripTeamsTitle('Microsoft Teams')).toBe('')
    expect(stripTeamsTitle('Reunião do Microsoft Teams | Microsoft Teams')).toBe('')
    // Emenda 10: as seções do Teams v2 no título da aba não são o assunto da reunião.
    expect(stripTeamsTitle('Daily | Calendário')).toBe('Daily')
  })

  it('título do Teams v2 com várias partes: tira as seções do aplicativo e fica com o que sobrar (Emenda 10)', () => {
    expect(stripTeamsTitle('Chat | Daily do time | Microsoft Teams')).toBe('Daily do time')
    expect(stripTeamsTitle('Chat | Fulano de Tal | Microsoft Teams')).toBe('Fulano de Tal')
    expect(stripTeamsTitle('Calendário | Microsoft Teams')).toBe('')
    expect(stripTeamsTitle('Calendar | Microsoft Teams')).toBe('')
    expect(stripTeamsTitle('Atividade | Microsoft Teams')).toBe('')
    expect(stripTeamsTitle('Reunião | Microsoft Teams')).toBe('')
    expect(stripTeamsTitle('Projeto X | Sprint 5 | Microsoft Teams')).toBe('Projeto X | Sprint 5')
    expect(stripTeamsTitle('(2) Chat | Daily | Microsoft Teams')).toBe('Daily')
  })

  it('ID longo e código curto pela URL (codificada ou não) e pelo objeto', () => {
    const thread = '19:meeting_NjQ2ZmFrZS10ZWFtcw@thread.v2'
    expect(teamsIds('https://teams.microsoft.com/meet/1234567890123?p=abc', null)).toEqual({ meetingId: '', code: '1234567890123' })
    expect(teamsIds('https://teams.microsoft.com/v2/#/meet/98765432101?p=x', null).code).toBe('98765432101')
    expect(teamsIds(`https://teams.cloud.microsoft/l/meetup-join/${encodeURIComponent(thread)}/0?context=%7B%7D`, null)).toEqual({ meetingId: thread, code: '' })
    expect(teamsIds('https://teams.microsoft.com/v2/', { threadId: '19:meeting_doObjeto@thread.v2' }).meetingId).toBe('19:meeting_doObjeto@thread.v2')
    expect(teamsIds('https://teams.microsoft.com/meet/123', null).code).toBe('')
    expect(teamsIds('https://teams.microsoft.com/%E0%A4%A', null)).toEqual({ meetingId: '', code: '' })
  })

  it('linhas do painel: só as seções de quem está na call', () => {
    expect(rosterName('participantsInCall-Ana Souza')).toBe('Ana Souza')
    expect(rosterName('attendeesInMeeting-Bruno')).toBe('Bruno')
    expect(rosterName('participantsInLobby-Visitante')).toBe('')
    expect(rosterName('participantsFromThread-Outro')).toBe('')
    expect(rosterName(null)).toBe('')
  })
})

describe('filtro mainAudio (Emenda 5)', () => {
  const rt = (trackId: string, ...streamIds: string[]): RemoteAudioTrack =>
    ({ track: { id: trackId, kind: 'audio' } as MediaStreamTrack, streams: streamIds.map((id) => ({ id }) as MediaStream) })

  it('com stream mainAudio, só ele; os dominantSpeaker saem', () => {
    const main = rt('t1', 'mainAudio')
    const dom = rt('t2', 'dominantSpeaker-1')
    const dom2 = rt('t3', 'dominantSpeaker-2')
    expect(filterMainAudio([dom, main, dom2])).toEqual([main])
  })

  it('sem diferenciar maiúsculas, e pelo id da faixa como reserva', () => {
    const a = rt('t1', 'MAINAUDIO-0')
    const b = rt('mainaudio-track')
    const c = rt('t3', 'outro')
    expect(filterMainAudio([a, b, c])).toEqual([a, b])
  })

  it('sem nenhum mainAudio, todas (não grava silêncio se o rótulo mudar)', () => {
    const all = [rt('t1', 'x'), rt('t2')]
    expect(filterMainAudio(all)).toEqual(all)
  })
})

describe('em call, espera e fim', () => {
  it('objeto da call decide: só o estado 3 é em call; 4 e 5 são espera', () => {
    const call = { state: 10 }
    v2(call)
    // A barra com o botão de desligar existe no lobby: com objeto, não importa.
    doc.show('#hangup-button')
    expect(teamsAdapter.isInCall(probe())).toBe(false)
    call.state = 2
    expect(teamsAdapter.isInCall(probe())).toBe(false)
    call.state = 3
    expect(teamsAdapter.isInCall(probe({ connectedWithLiveAudio: false }))).toBe(true)
    for (const s of [4, 5]) {
      call.state = s
      expect(teamsAdapter.isInCall(probe())).toBe(false)
      expect(teamsAdapter.isOnHold!(probe())).toBe(true)
    }
    call.state = 3
    expect(teamsAdapter.isOnHold!(probe())).toBe(false)
  })

  it('sem objeto: controle de call, sem pré-join nem lobby, e PC com áudio', () => {
    expect(teamsAdapter.isInCall(probe())).toBe(false)
    for (const control of ['#hangup-button', '[data-tid="hangup-main-btn"]', '#microphone-button', '#call-duration-custom']) {
      doc = new FakeDoc()
      vi.stubGlobal('document', doc)
      doc.show(control)
      expect(teamsAdapter.isInCall(probe()), control).toBe(true)
      expect(teamsAdapter.isInCall(probe({ connectedWithLiveAudio: false })), `${control} sem PC`).toBe(false)
    }
    for (const marker of ['[data-tid="prejoin-join-button"]', '[data-tid="prejoin-display-name-input"]', 'button[data-tid="joinOnWeb"]', '[data-tid="calling-lobby-screen"]', '[data-testid="calling-anon-meeting-end-screen"]']) {
      doc.show(marker)
      expect(teamsAdapter.isInCall(probe()), marker).toBe(false)
      doc.hide(marker)
    }
    // Objeto sem estado legível: vale o DOM.
    v2({ state: undefined })
    expect(teamsAdapter.isInCall(probe())).toBe(true)
  })

  it('fim pelo estado 6 ou 7 e pela tela de fim da reunião anônima', () => {
    const call = { state: 3 }
    v2(call)
    doc.show('#hangup-button')
    expect(teamsAdapter.endSignal(probe())).toBeNull()
    call.state = 6
    expect(teamsAdapter.endSignal(probe())).toBe('saiu-da-call')
    call.state = 7
    expect(teamsAdapter.endSignal(probe())).toBe('saiu-da-call')
    v2(undefined)
    expect(teamsAdapter.endSignal(probe())).toBeNull()
    doc.show('[data-testid="calling-anon-meeting-end-screen"]')
    expect(teamsAdapter.endSignal(probe())).toBe('saiu-da-call')
  })

  it('fim pelo botão de desligar ausente por 5 s com a faixa principal encerrada', () => {
    doc.show('#hangup-button')
    expect(teamsAdapter.endSignal(probe({ now: 0 }))).toBeNull()
    doc.hide('#hangup-button')
    // Sem o botão, mas com áudio vivo: não é fim (o controlador cuida do "15 s fora da call").
    expect(teamsAdapter.endSignal(probe({ now: 1000 }))).toBeNull()
    expect(teamsAdapter.endSignal(probe({ now: 7000 }))).toBeNull()
    // Faixa encerrada, mas o botão sumiu há menos de 5 s.
    expect(teamsAdapter.endSignal(probe({ now: 5999, connectedWithLiveAudio: false }))).toBeNull()
    expect(teamsAdapter.endSignal(probe({ now: 6000, connectedWithLiveAudio: false }))).toBe('call-encerrada')
  })

  it('o botão voltando zera a contagem; com o objeto dizendo conectado, o botão não importa', () => {
    expect(teamsAdapter.endSignal(probe({ now: 0, connectedWithLiveAudio: false }))).toBeNull()
    doc.show('#hangup-button')
    expect(teamsAdapter.endSignal(probe({ now: 3000, connectedWithLiveAudio: false }))).toBeNull()
    doc.hide('#hangup-button')
    expect(teamsAdapter.endSignal(probe({ now: 7000, connectedWithLiveAudio: false }))).toBeNull()
    expect(teamsAdapter.endSignal(probe({ now: 12_000, connectedWithLiveAudio: false }))).toBe('call-encerrada')

    resetTeamsMemory()
    const call = { state: 4 }
    v2(call)
    expect(teamsAdapter.endSignal(probe({ now: 0, connectedWithLiveAudio: false }))).toBeNull()
    expect(teamsAdapter.endSignal(probe({ now: 60_000, connectedWithLiveAudio: false }))).toBeNull()
  })
})

describe('readMeta', () => {
  const thread = '19:meeting_UGxhbmVqYW1lbnRv@thread.v2'

  it('título do cabeçalho lido no pré-join e guardado depois que ele some; ids e participantes', () => {
    const call = {
      state: 10,
      threadId: thread,
      participants: [{ displayName: 'Ana Souza', state: 3 }, { displayName: 'Visitante', state: 7 }],
      localSignalingParticipant: { displayName: 'Alex Lima' },
    }
    doc.show('[data-tid="prejoin-join-button"]')
    doc.show('[data-tid="meeting-header-title"]', new FakeEl({ title: 'Planejamento trimestral' }, 'Planejament...'))
    expect(teamsAdapter.isInCall(probe())).toBe(false)
    // Na call: o cabeçalho sumiu, a URL não tem mais o código, a aba é a casca.
    doc.els.clear()
    loc.href = 'https://teams.microsoft.com/v2/'
    v2(call)
    call.state = 3
    expect(teamsAdapter.isInCall(probe())).toBe(true)
    expect(teamsAdapter.readMeta()).toEqual({
      url: 'https://teams.microsoft.com/v2/',
      tabTitle: 'Microsoft Teams meeting | Microsoft Teams',
      code: '1234567890123',
      meetingId: thread,
      title: 'Planejamento trimestral',
      titleSource: 'dom',
      participants: ['Ana Souza'],
      selfName: 'Alex Lima',
    })
    // Participantes se acumulam; o próprio nome nunca entra.
    call.participants = [{ displayName: 'Carla Dias', state: 3 }, { displayName: 'Alex Lima', state: 3 }]
    expect(teamsAdapter.readMeta().participants).toEqual(['Ana Souza', 'Carla Dias'])
  })

  it('sem cabeçalho, o título da aba é o da call, não o da tela depois de desligar', () => {
    const call = { state: 3, participants: [] }
    v2(call)
    doc.title = 'Suporte | Microsoft Teams'
    expect(teamsAdapter.isInCall(probe())).toBe(true)
    expect(teamsAdapter.readMeta()).toMatchObject({ title: 'Suporte', titleSource: 'titulo-da-aba', tabTitle: 'Suporte | Microsoft Teams' })
    call.state = 7
    doc.title = 'Chat | Microsoft Teams'
    // O controlador relê no fim sem chamar isInCall de novo.
    expect(teamsAdapter.endSignal(probe())).toBe('saiu-da-call')
    expect(teamsAdapter.readMeta()).toMatchObject({ title: 'Suporte', titleSource: 'titulo-da-aba', tabTitle: 'Suporte | Microsoft Teams' })
    expect(teamsAdapter.isInCall(probe())).toBe(false)
    expect(teamsAdapter.readMeta()).toMatchObject({ title: 'Suporte', titleSource: 'titulo-da-aba', tabTitle: 'Suporte | Microsoft Teams' })
  })

  it('sem cabeçalho: título da aba; sem os dois: o código; painel de pessoas como reserva', () => {
    doc.title = 'Suporte | Microsoft Teams'
    expect(teamsAdapter.readMeta()).toMatchObject({ title: 'Suporte', titleSource: 'titulo-da-aba', code: '1234567890123' })
    doc.title = 'Microsoft Teams meeting | Microsoft Teams'
    doc.show('[data-cid="roster-participant"]', new FakeEl({ 'data-tid': 'participantsInCall-Ana Souza' }))
    doc.show('[data-cid="roster-participant"]', new FakeEl({ 'data-tid': 'participantsInLobby-Visitante' }))
    doc.show('[data-cid="roster-participant"]', new FakeEl({ 'data-tid': 'attendeesInMeeting-Bruno Lima' }))
    expect(teamsAdapter.readMeta()).toMatchObject({ title: '1234567890123', titleSource: 'codigo', participants: ['Ana Souza', 'Bruno Lima'] })
    loc.href = 'https://teams.live.com/light-meetings/launch?agent=web'
    resetTeamsMemory()
    expect(teamsAdapter.readMeta()).toMatchObject({ title: '', titleSource: 'nenhum', code: '' })
  })

  it('depois de um fim, um pré-join novo zera a memória da call anterior', () => {
    const call = { state: 3, threadId: thread, participants: [{ displayName: 'Ana Souza' }] }
    v2(call)
    doc.show('[data-tid="meeting-header-title"]', new FakeEl({ title: 'Primeira' }))
    teamsAdapter.isInCall(probe())
    expect(teamsAdapter.readMeta()).toMatchObject({ title: 'Primeira', participants: ['Ana Souza'] })
    call.state = 7
    expect(teamsAdapter.endSignal(probe())).toBe('saiu-da-call')
    // O fim ainda relê os metadados da mesma call (o controlador manda o último session:meta).
    expect(teamsAdapter.readMeta()).toMatchObject({ title: 'Primeira', participants: ['Ana Souza'] })
    // Depois de desligar a aba volta para o chat: vale a aba da última leitura em call.
    doc.title = 'Chat | Microsoft Teams'
    expect(teamsAdapter.isInCall(probe())).toBe(false)
    expect(teamsAdapter.readMeta()).toMatchObject({ tabTitle: 'Microsoft Teams meeting | Microsoft Teams' })
    // Outra reunião na mesma aba.
    doc.els.clear()
    v2(undefined)
    loc.href = 'https://teams.microsoft.com/meet/5555555555?p=x'
    doc.title = 'Microsoft Teams meeting | Microsoft Teams'
    doc.show('[data-tid="prejoin-join-button"]')
    teamsAdapter.isInCall(probe())
    expect(teamsAdapter.readMeta()).toMatchObject({ title: '5555555555', titleSource: 'codigo', code: '5555555555', meetingId: '', participants: [] })
  })

  it('outra call sem pré-join depois de um fim também começa do zero', () => {
    const call = { state: 3, threadId: thread, participants: [{ displayName: 'Ana Souza' }] }
    v2(call)
    teamsAdapter.isInCall(probe())
    expect(teamsAdapter.readMeta().participants).toEqual(['Ana Souza'])
    call.state = 7
    teamsAdapter.endSignal(probe())
    expect(teamsAdapter.isInCall(probe())).toBe(false)
    const next = { state: 3, threadId: '19:meeting_outra@thread.v2', participants: [{ displayName: 'Bruno Lima' }] }
    v2(next)
    expect(teamsAdapter.isInCall(probe())).toBe(true)
    expect(teamsAdapter.readMeta()).toMatchObject({ meetingId: '19:meeting_outra@thread.v2', participants: ['Bruno Lima'] })
  })
})

describe('memória por reunião (a aba do Teams passa por várias)', () => {
  const threadA = '19:meeting_UHJpbWVpcmE@thread.v2'
  const threadB = '19:meeting_U2VndW5kYQ@thread.v2'

  /** Call A em curso: cabeçalho "Primeira" lido no pré-join, Ana na call. */
  function callA() {
    doc.show('[data-tid="prejoin-join-button"]')
    doc.show('[data-tid="meeting-header-title"]', new FakeEl({ title: 'Primeira' }))
    expect(teamsAdapter.isInCall(probe({ now: 0 }))).toBe(false)
    doc.els.clear()
    const call = { state: 3, threadId: threadA, participants: [{ displayName: 'Ana Souza', state: 3 }] }
    v2(call)
    doc.title = 'Microsoft Teams meeting | Microsoft Teams'
    expect(teamsAdapter.isInCall(probe({ now: 1000 }))).toBe(true)
    expect(teamsAdapter.readMeta()).toMatchObject({ title: 'Primeira', titleSource: 'dom', participants: ['Ana Souza'], meetingId: threadA })
    return call
  }

  it('call que some sem endSignal e pré-join de outra: nada da anterior passa adiante', () => {
    callA()
    // A sessão acabou por fora (popup ou "fora da call"): o objeto some sem o endSignal ser chamado.
    v2(undefined)
    expect(teamsAdapter.isInCall(probe({ now: 2000, connectedWithLiveAudio: false }))).toBe(false)
    loc.href = 'https://teams.microsoft.com/meet/5555555555?p=x'
    doc.title = 'Reunião B | Microsoft Teams'
    doc.show('[data-tid="prejoin-join-button"]')
    expect(teamsAdapter.isInCall(probe({ now: 3000 }))).toBe(false)
    doc.els.clear()
    v2({ state: 3, threadId: threadB, participants: [{ displayName: 'Bruno Lima', state: 3 }] })
    expect(teamsAdapter.isInCall(probe({ now: 4000 }))).toBe(true)
    const meta = teamsAdapter.readMeta()
    expect(meta).toMatchObject({ title: 'Reunião B', titleSource: 'titulo-da-aba', participants: ['Bruno Lima'], meetingId: threadB, code: '5555555555' })
  })

  it('pré-join depois de uma call, mesmo sem id nenhum que mude, começa do zero', () => {
    callA()
    v2(undefined)
    expect(teamsAdapter.isInCall(probe({ now: 2000, connectedWithLiveAudio: false }))).toBe(false)
    // A próxima reunião entra por um link sem código nem thread na URL.
    loc.href = 'https://teams.microsoft.com/v2/'
    doc.show('[data-tid="prejoin-join-button"]')
    expect(teamsAdapter.isInCall(probe({ now: 3000 }))).toBe(false)
    doc.els.clear()
    v2({ state: 3, participants: [{ displayName: 'Bruno Lima', state: 3 }] })
    doc.title = 'Reunião B | Microsoft Teams'
    expect(teamsAdapter.isInCall(probe({ now: 4000 }))).toBe(true)
    expect(teamsAdapter.readMeta()).toMatchObject({ title: 'Reunião B', participants: ['Bruno Lima'], meetingId: '', code: '' })
  })

  it('parado pelo popup: o fim (estado 7) visto só pelo isInCall zera a próxima call, mesmo sem pré-join nem ids', () => {
    const call = callA()
    // O controlador não chama endSignal depois que o usuário parou; só isInCall continua.
    call.state = 7
    expect(teamsAdapter.isInCall(probe({ now: 2000 }))).toBe(false)
    v2({ state: 3, participants: [{ displayName: 'Bruno Lima', state: 3 }] })
    doc.title = 'Suporte | Microsoft Teams'
    expect(teamsAdapter.isInCall(probe({ now: 3000 }))).toBe(true)
    expect(teamsAdapter.readMeta()).toMatchObject({ title: 'Suporte', titleSource: 'titulo-da-aba', participants: ['Bruno Lima'], meetingId: '' })
  })

  it('tela de fim vista só pelo isInCall também conta como fim', () => {
    callA()
    v2(undefined)
    doc.show('[data-testid="calling-anon-meeting-end-screen"]')
    expect(teamsAdapter.isInCall(probe({ now: 2000 }))).toBe(false)
    doc.els.clear()
    v2({ state: 3, participants: [{ displayName: 'Bruno Lima', state: 3 }] })
    expect(teamsAdapter.isInCall(probe({ now: 3000 }))).toBe(true)
    expect(teamsAdapter.readMeta()).toMatchObject({ titleSource: 'codigo', participants: ['Bruno Lima'] })
  })

  it('15 s fora da call depois de estar nela é fim; menos que isso, ou em espera, é a mesma call', () => {
    // Sem objeto (reserva pelo DOM) e sem ids na URL.
    loc.href = 'https://teams.microsoft.com/v2/'
    doc.show('#hangup-button')
    doc.show('[data-cid="roster-participant"]', new FakeEl({ 'data-tid': 'participantsInCall-Ana Souza' }))
    doc.title = 'Primeira | Microsoft Teams'
    expect(teamsAdapter.isInCall(probe({ now: 0 }))).toBe(true)
    expect(teamsAdapter.readMeta()).toMatchObject({ title: 'Primeira', participants: ['Ana Souza'] })
    // Reconexão de 14 s: a mesma call.
    expect(teamsAdapter.isInCall(probe({ now: 1000, connectedWithLiveAudio: false }))).toBe(false)
    expect(teamsAdapter.isInCall(probe({ now: 15_000, connectedWithLiveAudio: false }))).toBe(false)
    expect(teamsAdapter.isInCall(probe({ now: 16_000 }))).toBe(true)
    expect(teamsAdapter.readMeta()).toMatchObject({ title: 'Primeira', participants: ['Ana Souza'] })
    // Fora por 15 s: a próxima call é outra.
    expect(teamsAdapter.isInCall(probe({ now: 17_000, connectedWithLiveAudio: false }))).toBe(false)
    expect(teamsAdapter.isInCall(probe({ now: 32_000, connectedWithLiveAudio: false }))).toBe(false)
    doc.els.clear()
    doc.show('#hangup-button')
    doc.show('[data-cid="roster-participant"]', new FakeEl({ 'data-tid': 'participantsInCall-Bruno Lima' }))
    doc.title = 'Segunda | Microsoft Teams'
    expect(teamsAdapter.isInCall(probe({ now: 33_000 }))).toBe(true)
    expect(teamsAdapter.readMeta()).toMatchObject({ title: 'Segunda', participants: ['Bruno Lima'] })

    // Espera longa (estado 4) não é fim.
    resetTeamsMemory()
    const call = { state: 3, threadId: threadA, participants: [{ displayName: 'Ana Souza', state: 3 }] }
    v2(call)
    expect(teamsAdapter.isInCall(probe({ now: 0 }))).toBe(true)
    expect(teamsAdapter.readMeta().participants).toEqual(['Ana Souza'])
    call.state = 4
    expect(teamsAdapter.isInCall(probe({ now: 1000 }))).toBe(false)
    expect(teamsAdapter.isInCall(probe({ now: 120_000 }))).toBe(false)
    call.state = 3
    call.participants = [{ displayName: 'Carla Dias', state: 3 }]
    expect(teamsAdapter.isInCall(probe({ now: 121_000 }))).toBe(true)
    expect(teamsAdapter.readMeta().participants).toEqual(['Ana Souza', 'Carla Dias'])
  })

  it('pré-join abandonado: o cabeçalho, o código e a thread dele não ficam para o pré-join seguinte', () => {
    doc.show('[data-tid="prejoin-join-button"]')
    doc.show('[data-tid="meeting-header-title"]', new FakeEl({ title: 'Primeira' }))
    // Desistiu já com o objeto da call criado (estado 2, conectando), sem nunca entrar.
    v2({ state: 2, threadId: threadA, participants: [] })
    teamsAdapter.isInCall(probe())
    expect(teamsAdapter.readMeta()).toMatchObject({ title: 'Primeira', code: '1234567890123', meetingId: threadA })
    // Outra reunião, outro código, pré-join sem cabeçalho e sem objeto ainda.
    v2(undefined)
    loc.href = 'https://teams.microsoft.com/meet/5555555555?p=x'
    doc.hide('[data-tid="meeting-header-title"]')
    teamsAdapter.isInCall(probe())
    expect(teamsAdapter.readMeta()).toMatchObject({ title: '5555555555', titleSource: 'codigo', code: '5555555555', meetingId: '' })
    // Sem id nenhum na URL: no pré-join, o cabeçalho que some leva o título junto (não fica preso o
    // de uma reunião aberta antes).
    loc.href = 'https://teams.microsoft.com/v2/'
    doc.show('[data-tid="meeting-header-title"]', new FakeEl({ title: 'Segunda' }))
    teamsAdapter.isInCall(probe())
    doc.hide('[data-tid="meeting-header-title"]')
    teamsAdapter.isInCall(probe())
    expect(teamsAdapter.readMeta()).toMatchObject({ title: '5555555555', titleSource: 'codigo' })
  })

  it('outra thread no objeto, sem fim nenhum no meio, é outra reunião', () => {
    callA()
    v2({ state: 3, threadId: threadB, participants: [{ displayName: 'Bruno Lima', state: 3 }] })
    expect(teamsAdapter.isInCall(probe({ now: 2000 }))).toBe(true)
    expect(teamsAdapter.readMeta()).toMatchObject({ titleSource: 'codigo', participants: ['Bruno Lima'], meetingId: threadB })
  })

  it('a mesma reunião guarda a memória: thread da URL e do objeto são fontes à parte, e o objeto 6/7 da anterior não conta', () => {
    // Pré-join pelo link com a thread na URL; o objeto da call anterior ainda está lá, desligado.
    loc.href = `https://teams.microsoft.com/l/meetup-join/${encodeURIComponent(threadA)}/0`
    v2({ state: 7, threadId: '19:meeting_YW50ZXJpb3I@thread.v2', participants: [] })
    doc.show('[data-tid="prejoin-join-button"]')
    doc.show('[data-tid="meeting-header-title"]', new FakeEl({ title: 'Primeira' }))
    expect(teamsAdapter.isInCall(probe({ now: 0 }))).toBe(false)
    // Lobby: objeto novo, com a thread escrita de outro jeito que a da URL.
    doc.els.clear()
    doc.show('[data-tid="calling-lobby-screen"]')
    const call = { state: 10, threadId: '19:meeting_UHJpbWVpcmE@thread.v2;messageid=0', participants: [] as unknown[] }
    v2(call)
    expect(teamsAdapter.isInCall(probe({ now: 1000 }))).toBe(false)
    doc.els.clear()
    loc.href = 'https://teams.microsoft.com/v2/'
    call.state = 3
    call.participants = [{ displayName: 'Ana Souza', state: 3 }]
    expect(teamsAdapter.isInCall(probe({ now: 2000 }))).toBe(true)
    expect(teamsAdapter.readMeta()).toMatchObject({ title: 'Primeira', titleSource: 'dom', participants: ['Ana Souza'] })
  })
})
