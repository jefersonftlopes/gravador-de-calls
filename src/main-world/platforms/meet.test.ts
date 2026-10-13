import { afterEach, describe, expect, it, vi } from 'vitest'
import { rosterResponseBase64 } from '../../../tests/helpers/protobuf'
import { cleanName, isPersonLabel, meetAdapter, meetCode, meetSpeakers, participantNames, pickMeetTitle, resetMeetMemory, stripMeetTitle } from './meet'

describe('meetCode', () => {
  it('só aceita o caminho com código de reunião', () => {
    const at = (pathname: string, hostname = 'meet.google.com') => meetCode({ hostname, pathname })
    expect(at('/abc-defg-hij')).toBe('abc-defg-hij')
    expect(at('/abc-defg-hij/')).toBe('abc-defg-hij')
    for (const p of ['/', '/landing', '/new', '/lookup/abc', '/unsupported', '/__peer', '/abc-defg-hijk', '/ABC-DEFG-HIJ']) {
      expect(at(p), p).toBeNull()
    }
    expect(at('/abc-defg-hij', 'evil.example.com')).toBeNull()
  })
})

describe('stripMeetTitle', () => {
  it('tira o prefixo e o sufixo do Meet com qualquer separador', () => {
    expect(stripMeetTitle('Meet - Daily do time')).toBe('Daily do time')
    expect(stripMeetTitle('Meet \u2013 Daily do time')).toBe('Daily do time')
    expect(stripMeetTitle('Daily do time \u2014 Google Meet')).toBe('Daily do time')
    expect(stripMeetTitle('Google Meet: Planejamento')).toBe('Planejamento')
    expect(stripMeetTitle('Meet')).toBe('Meet')
  })
})

describe('pickMeetTitle', () => {
  it('DOM primeiro, depois a aba, por fim o código; o que for igual ao código não é título', () => {
    expect(pickMeetTitle('Daily do time', 'Meet - outra', 'abc-defg-hij')).toEqual({ title: 'Daily do time', titleSource: 'dom' })
    // O Meet mostra o código no lugar do título quando não há evento.
    expect(pickMeetTitle('abc-defg-hij', 'Meet - Planejamento', 'abc-defg-hij')).toEqual({ title: 'Planejamento', titleSource: 'titulo-da-aba' })
    expect(pickMeetTitle('abc-defg-hij', 'Meet - abc-defg-hij', 'abc-defg-hij')).toEqual({ title: 'abc-defg-hij', titleSource: 'codigo' })
    expect(pickMeetTitle('', 'Meet', 'abc-defg-hij')).toEqual({ title: 'abc-defg-hij', titleSource: 'codigo' })
    expect(pickMeetTitle('', 'Google Meet', '')).toEqual({ title: '', titleSource: 'nenhum' })
  })

  it('respeita o limite do protocolo', () => {
    expect(pickMeetTitle('x'.repeat(5000), '', 'abc-defg-hij').title).toHaveLength(1000)
  })
})

describe('participantes do Meet', () => {
  it('rótulos que não são pessoas ficam de fora', () => {
    for (const junk of ['', 'visual_effects', 'visual_effectsPlanos de fundo e efeitos', 'Backgrounds and effects', 'Google Participant (spaces/a/devices/1)', 'spaces/abc/devices/9', 'devices/12']) {
      expect(isPersonLabel(cleanName(junk)), junk).toBe(false)
    }
    for (const ok of ['Ana Souza', 'José da Silva (Convidado)', 'Spaces Team']) expect(isPersonLabel(ok), ok).toBe(true)
  })

  it('sem o bloco do próprio usuário, sem repetição e com espaços colapsados', () => {
    const tiles = [
      { isSelf: true, label: 'Alex Lima' },
      { isSelf: false, label: '  Ana   Souza ' },
      { isSelf: false, label: 'Ana Souza' },
      { isSelf: false, label: 'Bruno Lima' },
      { isSelf: false, label: 'visual_effects' },
      { isSelf: false, label: 'Google Participant (x)' },
    ]
    expect(participantNames(tiles, 'Alex Lima')).toEqual(['Ana Souza', 'Bruno Lima'])
  })

  it('o bloco do próprio usuário fica de fora mesmo com um rótulo diferente do nome', () => {
    expect(participantNames([{ isSelf: true, label: 'Você' }, { isSelf: false, label: 'Ana' }], 'Alex Lima')).toEqual(['Ana'])
    expect(participantNames([{ isSelf: true, label: 'Alex (apresentando)' }], '')).toEqual([])
  })

  it('o próprio nome fica de fora mesmo se o marcador não estiver dentro do bloco', () => {
    expect(participantNames([{ isSelf: false, label: 'Alex Lima' }, { isSelf: false, label: 'Ana' }], 'Alex Lima')).toEqual(['Ana'])
  })
})

/** Bloco de participante falso: o rótulo em span.notranslate e, se for o próprio, a marca [data-self-name]. */
interface FakeTile {
  label: string
  self?: string
  /** data-participant-id (o deviceId). */
  id?: string
}

/** document falso com título do DOM, blocos de participante e o título da aba (só o que readMeta lê). */
function fakeMeetDoc(state: { title: string; domTitle: string | null; tiles: FakeTile[] }) {
  const tileEls = () =>
    state.tiles.map((t) => {
      const mark = t.self === undefined ? null : { getAttribute: () => t.self!, textContent: t.self!, closest: () => tile }
      const tile = {
        mark,
        getAttribute: (name: string) => (name === 'data-participant-id' ? t.id ?? null : null),
        querySelector: (sel: string) => (sel === 'span.notranslate' ? { textContent: t.label } : sel === '[data-self-name]' ? mark : null),
      }
      return tile
    })
  return {
    get title() {
      return state.title
    },
    querySelector: (sel: string) => (sel.includes('NeC6gb') && state.domTitle !== null ? { textContent: state.domTitle } : null),
    querySelectorAll: (sel: string) => {
      const tiles = tileEls()
      if (sel === '[data-participant-id]') return tiles
      if (sel === '[data-self-name]') return tiles.flatMap((t) => (t.mark ? [t.mark] : []))
      return []
    },
  }
}

const meetAt = (code: string) => ({ hostname: 'meet.google.com', pathname: `/${code}`, href: `https://meet.google.com/${code}` })

describe('readMeta do Meet', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    resetMeetMemory()
  })

  it('o próprio nome sai dos participantes mesmo quando o bloco dele foi lido antes de a marca aparecer', () => {
    const state = { title: 'Meet - Daily', domTitle: 'Daily', tiles: [{ label: 'Alex Lima' }, { label: 'Ana Souza' }] as FakeTile[] }
    vi.stubGlobal('document', fakeMeetDoc(state))
    vi.stubGlobal('location', meetAt('abc-defg-hij'))
    // Primeira leitura: o bloco do usuário ainda sem [data-self-name], então o rótulo dele entra.
    expect(meetAdapter.readMeta().participants).toEqual(['Alex Lima', 'Ana Souza'])
    // A marca aparece: o nome acumulado antes sai, e vira `selfName`.
    state.tiles = [{ label: 'Alex Lima', self: 'Alex Lima' }, { label: 'Ana Souza' }]
    const meta = meetAdapter.readMeta()
    expect(meta.participants).toEqual(['Ana Souza'])
    expect(meta.selfName).toBe('Alex Lima')
  })

  it('a memória é da reunião: outro código no mesmo documento começa sem título, participantes nem nome', () => {
    const state: { title: string; domTitle: string | null; tiles: FakeTile[] } = {
      title: 'Meet - Daily do time',
      domTitle: 'Daily do time',
      tiles: [{ label: 'Alex Lima', self: 'Alex Lima' }, { label: 'Ana Souza' }],
    }
    vi.stubGlobal('document', fakeMeetDoc(state))
    vi.stubGlobal('location', meetAt('abc-defg-hij'))
    expect(meetAdapter.readMeta()).toMatchObject({ title: 'Daily do time', titleSource: 'dom', participants: ['Ana Souza'], selfName: 'Alex Lima' })
    // A mesma aba (SPA) vai para outra reunião, ainda sem título no DOM e sem a marca do usuário.
    vi.stubGlobal('location', meetAt('xyz-abcd-efg'))
    state.title = 'Meet - xyz-abcd-efg'
    state.domTitle = null
    state.tiles = [{ label: 'Bruno Lima' }]
    const meta = meetAdapter.readMeta()
    expect(meta).toMatchObject({ code: 'xyz-abcd-efg', title: 'xyz-abcd-efg', titleSource: 'codigo', participants: ['Bruno Lima'] })
    expect(meta.selfName).toBeUndefined()
  })

  it('guarda o título do DOM quando o elemento some (outro layout) e quando a aba volta a ser "Meet"', () => {
    let titleEl: { textContent: string } | null = { textContent: 'abc-defg-hij' }
    const doc = {
      title: 'Meet - abc-defg-hij',
      querySelector: (sel: string) => (sel.includes('NeC6gb') ? titleEl : null),
      querySelectorAll: () => [],
    }
    vi.stubGlobal('document', doc)
    vi.stubGlobal('location', { hostname: 'meet.google.com', pathname: '/abc-defg-hij', href: 'https://meet.google.com/abc-defg-hij' })
    // O elemento mostra o código: não é título.
    expect(meetAdapter.readMeta()).toMatchObject({ title: 'abc-defg-hij', titleSource: 'codigo' })
    titleEl = { textContent: 'Revisão de arquitetura' }
    expect(meetAdapter.readMeta()).toMatchObject({ title: 'Revisão de arquitetura', titleSource: 'dom' })
    titleEl = null
    doc.title = 'Meet'
    expect(meetAdapter.readMeta()).toMatchObject({ title: 'Revisão de arquitetura', titleSource: 'dom', code: 'abc-defg-hij' })
  })

  it('a aba da última leitura em call vale depois da tela de saída (que volta para "Meet")', () => {
    const icons = ['call_end', 'closed_caption_off'].map((t) => ({ textContent: t }))
    let exit: object[] = []
    const doc = {
      title: 'Meet - Daily do time',
      querySelector: () => null,
      querySelectorAll: (sel: string) => (sel === '.google-symbols' ? icons : sel === 'h1[jsname="r4nke"]' ? exit : []),
    }
    vi.stubGlobal('document', doc)
    vi.stubGlobal('location', { hostname: 'meet.google.com', pathname: '/abc-defg-hij', href: 'https://meet.google.com/abc-defg-hij' })
    const probe = { now: 0, pcsOpen: 1, pcsConnected: 1, connectedWithLiveAudio: true, reconnectingWithAudio: false, liveRemoteAudioTracks: 1, audioPcClosedAt: null }
    expect(meetAdapter.isInCall(probe)).toBe(true)
    expect(meetAdapter.readMeta()).toMatchObject({ tabTitle: 'Meet - Daily do time', title: 'Daily do time', titleSource: 'titulo-da-aba' })
    // Saiu: o cabeçalho de saída aparece e a aba vira "Meet". O controlador relê no fim.
    exit = [{}]
    doc.title = 'Meet'
    expect(meetAdapter.endSignal(probe)).toBe('saiu-da-call')
    expect(meetAdapter.readMeta()).toMatchObject({ tabTitle: 'Meet - Daily do time', title: 'Daily do time', titleSource: 'titulo-da-aba' })
    expect(meetAdapter.isInCall(probe)).toBe(false)
    expect(meetAdapter.readMeta()).toMatchObject({ tabTitle: 'Meet - Daily do time', title: 'Daily do time' })
  })
})

describe('diagnóstico do título (Emenda 20)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    resetMeetMemory()
  })

  it('o elemento com o código e a aba "Meet: <código>" (o formato visto na daily real); depois um título, que fica', () => {
    let el: { textContent: string } | null = { textContent: 'abc-defg-hij' }
    const doc = { title: 'Meet: abc-defg-hij', querySelector: (sel: string) => (sel.includes('NeC6gb') ? el : null), querySelectorAll: () => [] }
    vi.stubGlobal('document', doc)
    vi.stubGlobal('location', meetAt('abc-defg-hij'))
    expect(meetAdapter.readMeta()).toMatchObject({ titleSource: 'codigo', titleSignals: { element: 'codigo', selector: 'NeC6gb', tabEqualsCode: true } })
    el = { textContent: 'Daily do time' }
    expect(meetAdapter.readMeta().titleSignals).toEqual({ element: 'outro', selector: 'NeC6gb', tabEqualsCode: true })
    // Um layout sem o elemento, ou o código de novo, não apaga o mais forte visto.
    el = null
    expect(meetAdapter.readMeta().titleSignals).toMatchObject({ element: 'outro', selector: 'NeC6gb' })
    el = { textContent: 'abc-defg-hij' }
    expect(meetAdapter.readMeta().titleSignals).toMatchObject({ element: 'outro', selector: 'NeC6gb' })
  })

  it('sem elemento nenhum: ausente; pelo seletor antigo (.u6vdEc), diz qual foi', () => {
    vi.stubGlobal('document', { title: 'Meet - Planejamento', querySelector: () => null, querySelectorAll: () => [] })
    vi.stubGlobal('location', meetAt('abc-defg-hij'))
    expect(meetAdapter.readMeta().titleSignals).toEqual({ element: 'ausente', selector: null, tabEqualsCode: false })
    resetMeetMemory()
    vi.stubGlobal('document', { title: 'Meet - abc-defg-hij', querySelector: (sel: string) => (sel === '.u6vdEc' ? { textContent: 'abc-defg-hij' } : null), querySelectorAll: () => [] })
    expect(meetAdapter.readMeta().titleSignals).toEqual({ element: 'codigo', selector: 'u6vdEc', tabEqualsCode: true })
  })
})

describe('o próprio nome pela roster (Emenda 20)', () => {
  const EU = 'spaces/abc/devices/1'
  const ANA = 'spaces/abc/devices/2'
  afterEach(() => {
    vi.unstubAllGlobals()
    resetMeetMemory()
  })

  it('sem o marcador do DOM: o nome completo da roster vira selfName, e o bloco dele sai pelo device', async () => {
    await meetSpeakers.onRosterText(rosterResponseBase64([{ deviceId: EU, name: 'Alex Lima', displayName: 'Alex', self: true }, { deviceId: ANA, name: 'Ana Souza' }]))
    vi.stubGlobal('document', fakeMeetDoc({ title: 'Meet: abc-defg-hij', domTitle: null, tiles: [{ label: 'Alex Lima', id: EU }, { label: 'Ana Souza', id: ANA }] }))
    vi.stubGlobal('location', meetAt('abc-defg-hij'))
    expect(meetAdapter.readMeta()).toMatchObject({ selfName: 'Alex Lima', participants: ['Ana Souza'], selfSignals: { roster: true, spaces: 1, domMarker: false } })
  })

  it('o bloco dele lido antes da roster, com um rótulo diferente do nome, sai quando a roster chega', async () => {
    const state = { title: 'Meet: abc-defg-hij', domTitle: null, tiles: [{ label: 'Alex (apresentando)', id: EU }, { label: 'Ana Souza', id: ANA }] as FakeTile[] }
    vi.stubGlobal('document', fakeMeetDoc(state))
    vi.stubGlobal('location', meetAt('abc-defg-hij'))
    expect(meetAdapter.readMeta()).toMatchObject({ participants: ['Alex (apresentando)', 'Ana Souza'], selfSignals: { roster: false, spaces: 0, domMarker: false } })
    expect(meetAdapter.readMeta().selfName).toBeUndefined()
    await meetSpeakers.onRosterText(rosterResponseBase64([{ deviceId: EU, name: 'Alex Lima', self: true }]))
    state.tiles = [{ label: 'Ana Souza', id: ANA }]
    expect(meetAdapter.readMeta()).toMatchObject({ selfName: 'Alex Lima', participants: ['Ana Souza'] })
  })

  it('com a mesma conta em outra call, vale o registro do space dos blocos', async () => {
    await meetSpeakers.onRosterText(rosterResponseBase64([{ deviceId: 'spaces/outra/devices/4', name: 'Conta em outra call', self: true }]))
    await meetSpeakers.onRosterText(rosterResponseBase64([{ deviceId: EU, name: 'Alex Lima', self: true }]))
    vi.stubGlobal('document', fakeMeetDoc({ title: 'Meet: abc-defg-hij', domTitle: null, tiles: [{ label: 'Ana Souza', id: ANA }] }))
    vi.stubGlobal('location', meetAt('abc-defg-hij'))
    expect(meetAdapter.readMeta()).toMatchObject({ selfName: 'Alex Lima', selfSignals: { roster: true, spaces: 2 } })
  })

  it('sem o campo 7, a reserva é o [data-self-name] do DOM, como antes', async () => {
    await meetSpeakers.onRosterText(rosterResponseBase64([{ deviceId: ANA, name: 'Ana Souza' }]))
    vi.stubGlobal('document', fakeMeetDoc({ title: 'Meet - Daily', domTitle: 'Daily', tiles: [{ label: 'Alex Lima', self: 'Alex Lima', id: EU }, { label: 'Ana Souza', id: ANA }] }))
    vi.stubGlobal('location', meetAt('abc-defg-hij'))
    expect(meetAdapter.readMeta()).toMatchObject({ selfName: 'Alex Lima', participants: ['Ana Souza'], selfSignals: { roster: false, spaces: 1, domMarker: true } })
  })

  it('a roster vale mais que o marcador do DOM', async () => {
    await meetSpeakers.onRosterText(rosterResponseBase64([{ deviceId: EU, name: 'Alex Lima', displayName: 'Alex', self: true }]))
    vi.stubGlobal('document', fakeMeetDoc({ title: 'Meet - Daily', domTitle: 'Daily', tiles: [{ label: 'Você', self: 'Alex', id: EU }, { label: 'Ana Souza', id: ANA }] }))
    vi.stubGlobal('location', meetAt('abc-defg-hij'))
    expect(meetAdapter.readMeta()).toMatchObject({ selfName: 'Alex Lima', participants: ['Ana Souza'] })
  })
})

describe('continua na call enquanto grava (Emenda 10)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    resetMeetMemory()
  })

  const base = { now: 0, pcsOpen: 1, pcsConnected: 1, liveRemoteAudioTracks: 1, audioPcClosedAt: null }
  const connected = { ...base, connectedWithLiveAudio: true, reconnectingWithAudio: false }
  const reconnecting = { ...base, pcsConnected: 0, connectedWithLiveAudio: false, reconnectingWithAudio: true }
  const gone = { ...base, pcsConnected: 0, connectedWithLiveAudio: false, reconnectingWithAudio: false }

  function doc(icons: string[], exit = false) {
    return {
      title: 'Meet - Daily do time',
      querySelector: () => null,
      querySelectorAll: (sel: string) =>
        sel === '.google-symbols' ? icons.map((t) => ({ textContent: t })) : sel === 'h1[jsname="r4nke"]' && exit ? [{}] : [],
    }
  }

  it('sem os ícones de legenda e chat (janela estreita, menu "mais opções"): para começar não vale, para continuar vale', () => {
    vi.stubGlobal('location', meetAt('abc-defg-hij'))
    vi.stubGlobal('document', doc(['call_end']))
    expect(meetAdapter.isInCall(connected)).toBe(false)
    expect(meetAdapter.stillInCall!(connected)).toBe(true)
  })

  it('PC reconectando (VPN, troca de Wi-Fi) com a tela da call: continua', () => {
    vi.stubGlobal('location', meetAt('abc-defg-hij'))
    vi.stubGlobal('document', doc(['call_end', 'closed_caption_off']))
    expect(meetAdapter.isInCall(reconnecting)).toBe(false)
    expect(meetAdapter.stillInCall!(reconnecting)).toBe(true)
  })

  it('sem PC com áudio, sem botão de sair ou com a tela de saída: não continua', () => {
    vi.stubGlobal('location', meetAt('abc-defg-hij'))
    vi.stubGlobal('document', doc(['call_end', 'closed_caption_off']))
    expect(meetAdapter.stillInCall!(gone)).toBe(false)
    vi.stubGlobal('document', doc(['closed_caption_off']))
    expect(meetAdapter.stillInCall!(connected)).toBe(false)
    vi.stubGlobal('document', doc(['call_end', 'closed_caption_off'], true))
    expect(meetAdapter.stillInCall!(connected)).toBe(false)
    vi.stubGlobal('location', { hostname: 'meet.google.com', pathname: '/landing', href: 'https://meet.google.com/landing' })
    vi.stubGlobal('document', doc(['call_end', 'closed_caption_off']))
    expect(meetAdapter.stillInCall!(connected)).toBe(false)
  })
})
