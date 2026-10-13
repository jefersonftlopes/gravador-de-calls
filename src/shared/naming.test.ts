import { afterEach, describe, expect, it } from 'vitest'
import { useLocale } from '../../tests/helpers/i18n-setup'
import {
  MAX_COMPONENT_BYTES,
  callFolderName,
  displayTitle,
  makeSessionId,
  profileFolder,
  recordingRelDir,
  sanitizeComponent,
  truncateBytes,
  utf8Bytes,
} from './naming'

afterEach(() => useLocale('pt_BR'))

// Datas em hora local, como a extensão usa.
const at = new Date(2026, 9, 6, 14, 30, 5)

describe('sanitizeComponent', () => {
  it('troca os caracteres proibidos pelo Chromium por substitutos legíveis', () => {
    expect(sanitizeComponent('Daily: time')).toBe('Daily - time')
    expect(sanitizeComponent('Q3/Q4 e a\\b|c')).toBe('Q3-Q4 e a-b-c')
    expect(sanitizeComponent('Reunião às 14:30')).toBe('Reunião às 14h30')
    expect(sanitizeComponent('o "plano" <novo>? *já*')).toBe("o 'plano' novo já")
    const out = sanitizeComponent('a:b/c*d?e"f<g>h|i\\j')
    expect(out).not.toMatch(/["*/:<>?\\|]/)
  })

  it('remove caracteres de controle e de formatação e junta espaços', () => {
    expect(sanitizeComponent('linha1\nlinha2\t\tfim')).toBe('linha1 linha2 fim')
    expect(sanitizeComponent('zero​width‍joiner')).toBe('zero width joiner')
    expect(sanitizeComponent('nao￾caractere﷐')).toBe('naocaractere')
    expect(sanitizeComponent('\u0000\u0007bip')).toBe('bip')
  })

  it('tira espaço, ponto e til das pontas', () => {
    expect(sanitizeComponent('  .~título~.  ')).toBe('título')
    expect(sanitizeComponent('.oculto')).toBe('oculto')
    expect(sanitizeComponent('nome.')).toBe('nome')
    expect(sanitizeComponent('~ . ~')).toBe('')
  })

  it('evita os nomes reservados do Windows', () => {
    for (const name of ['CON', 'prn', 'Aux', 'NUL', 'COM1', 'lpt9', 'CLOCK$', 'CONIN$', 'conout$', 'con.txt']) {
      const out = sanitizeComponent(name)
      expect(out.startsWith('_'), name).toBe(true)
    }
    expect(sanitizeComponent('desktop.ini')).toBe('_desktop.ini')
    expect(sanitizeComponent('Thumbs.db')).toBe('_Thumbs.db')
    expect(sanitizeComponent('CONSOLE')).toBe('CONSOLE')
    expect(sanitizeComponent('COM10')).toBe('COM10')
  })

  it('neutraliza extensões perigosas no fim', () => {
    expect(sanitizeComponent('atalho.lnk')).toBe('atalho.ln_')
    expect(sanitizeComponent('pagina.URL')).toBe('pagina.UR_')
  })

  it('respeita o limite de bytes UTF-8 sem partir grafemas', () => {
    const long = 'ação '.repeat(100)
    const out = sanitizeComponent(long)
    expect(utf8Bytes(out)).toBeLessThanOrEqual(MAX_COMPONENT_BYTES)
    expect(out.endsWith(' ')).toBe(false)
    const emoji = '👩‍💻'.repeat(40)
    const cut = truncateBytes(emoji, 30)
    expect(utf8Bytes(cut)).toBeLessThanOrEqual(30)
    // Nenhum surrogate solto.
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(cut)).toBe(false)
  })
})

describe('displayTitle', () => {
  it('usa o título, depois o código, depois "Sem título"', () => {
    expect(displayTitle('Daily do time', 'abc-defg-hij')).toBe('Daily do time')
    expect(displayTitle('   ', 'abc-defg-hij')).toBe('abc-defg-hij')
    expect(displayTitle('', '')).toBe('Sem título')
    expect(displayTitle(null, undefined)).toBe('Sem título')
    expect(displayTitle('...', null)).toBe('Sem título')
  })
})

describe('callFolderName e recordingRelDir', () => {
  it('monta o formato "AAAA-MM/AAAA-MM-DD HHhMM - <título> (<Meet|Teams>)"', () => {
    expect(recordingRelDir({ startedAt: at, title: 'Daily do time', code: 'abc-defg-hij', platform: 'meet' })).toBe(
      '2026-10/2026-10-06 14h30 - Daily do time (Meet)',
    )
    expect(recordingRelDir({ startedAt: at, title: 'Planejamento: Q4/2026', platform: 'teams' })).toBe(
      '2026-10/2026-10-06 14h30 - Planejamento - Q4-2026 (Teams)',
    )
    // Modo aba fora dos hosts das calls (Emenda 7).
    expect(recordingRelDir({ startedAt: at, title: 'Zoom Meeting', platform: 'outro' })).toBe('2026-10/2026-10-06 14h30 - Zoom Meeting (Outro site)')
  })

  it('usa o código quando não há título e "Sem título" quando não há nada', () => {
    expect(callFolderName({ startedAt: at, title: '', code: 'abc-defg-hij', platform: 'meet' })).toBe(
      '2026-10-06 14h30 - abc-defg-hij (Meet)',
    )
    expect(callFolderName({ startedAt: at, title: undefined, code: undefined, platform: 'teams' })).toBe(
      '2026-10-06 14h30 - Sem título (Teams)',
    )
  })

  it('em inglês (Emenda 15), "Untitled" e "(Other site)"; Meet e Teams não mudam', () => {
    useLocale('en')
    expect(callFolderName({ startedAt: at, title: undefined, code: undefined, platform: 'teams' })).toBe('2026-10-06 14h30 - Untitled (Teams)')
    expect(recordingRelDir({ startedAt: at, title: 'Zoom Meeting', platform: 'outro' })).toBe('2026-10/2026-10-06 14h30 - Zoom Meeting (Other site)')
    expect(recordingRelDir({ startedAt: at, title: 'Daily', platform: 'meet' })).toBe('2026-10/2026-10-06 14h30 - Daily (Meet)')
    expect(displayTitle('', '')).toBe('Untitled')
  })

  it('corta o título longo mas mantém o sufixo da plataforma', () => {
    const name = callFolderName({ startedAt: at, title: 'Reunião muito longa '.repeat(20), platform: 'meet' })
    expect(utf8Bytes(name)).toBeLessThanOrEqual(MAX_COMPONENT_BYTES)
    expect(name.endsWith(' (Meet)')).toBe(true)
    expect(name).not.toMatch(/ {2}| \(Meet\)$.* \(Meet\)/)
    expect(name.includes('  ')).toBe(false)
  })

  it('nunca produz caracteres proibidos', () => {
    const rel = recordingRelDir({ startedAt: at, title: '1:1 <João> / "Ana" | ok?', platform: 'meet' })
    const [, folder] = rel.split('/')
    expect(folder).not.toMatch(/["*/:<>?\\|]/)
    expect(folder).toBe("2026-10-06 14h30 - 1 - 1 João - 'Ana' - ok (Meet)")
  })

  it('usa zero à esquerda em mês, dia, hora e minuto', () => {
    const early = new Date(2026, 0, 2, 3, 4)
    expect(recordingRelDir({ startedAt: early, title: 'x', platform: 'meet' })).toBe('2026-01/2026-01-02 03h04 - x (Meet)')
  })
})

describe('perfil (Emenda 1)', () => {
  it('vira a primeira pasta quando tem nome', () => {
    expect(recordingRelDir({ startedAt: at, title: 'Daily', platform: 'teams', profileLabel: 'Trabalho' })).toBe(
      'Trabalho/2026-10/2026-10-06 14h30 - Daily (Teams)',
    )
  })

  it('sem nome (vazio, espaços ou só caracteres inválidos) não cria o nível', () => {
    for (const label of ['', '   ', null, undefined, '...', '~']) {
      expect(recordingRelDir({ startedAt: at, title: 'Daily', platform: 'meet', profileLabel: label })).toBe(
        '2026-10/2026-10-06 14h30 - Daily (Meet)',
      )
    }
  })

  it('é saneado como os outros nomes (nada de "/" virar subpasta)', () => {
    expect(profileFolder('Cliente/Projeto: RH')).toBe('Cliente-Projeto - RH')
    expect(profileFolder('CON')).toBe('_CON')
    expect(recordingRelDir({ startedAt: at, title: 'x', platform: 'meet', profileLabel: 'a/b' }).split('/')).toHaveLength(3)
  })
})

describe('makeSessionId', () => {
  it('segue AAAAMMDD-HHmmss-<tabId>-<4 hex>', () => {
    expect(makeSessionId(at, 42, () => 0.5)).toBe('20261006-143005-42-8000')
    expect(makeSessionId(at, 7, () => 0)).toBe('20261006-143005-7-0000')
    expect(makeSessionId(at, 7)).toMatch(/^20261006-143005-7-[0-9a-f]{4}$/)
  })
})
