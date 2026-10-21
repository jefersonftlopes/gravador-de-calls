import { describe, expect, it, vi } from 'vitest'
import { useLocale } from '../../tests/helpers/i18n-setup'
import { globalBadge, installReasonMarksTabs, isCallHostUrl, isCallTabUrl, notificationId, parseNotificationId, recordingBadge, shortcutText } from './badge'

describe('badge: abas que precisam recarregar (AC16)', () => {
  it('Meet só com o código da reunião; Teams em qualquer página dos três hosts', () => {
    expect(isCallTabUrl('https://meet.google.com/abc-defg-hij')).toBe(true)
    expect(isCallTabUrl('https://meet.google.com/abc-defg-hij?authuser=1')).toBe(true)
    expect(isCallTabUrl('https://meet.google.com/')).toBe(false)
    expect(isCallTabUrl('https://meet.google.com/landing')).toBe(false)
    expect(isCallTabUrl('https://teams.microsoft.com/v2/')).toBe(true)
    expect(isCallTabUrl('https://teams.cloud.microsoft/')).toBe(true)
    expect(isCallTabUrl('https://teams.live.com/meet/123')).toBe(true)
    expect(isCallTabUrl('https://example.com/abc-defg-hij')).toBe(false)
    expect(isCallTabUrl(undefined)).toBe(false)
    expect(isCallTabUrl('lixo')).toBe(false)
  })

  it('hosts das calls: onde os content scripts rodam (sair deles é documento novo sem os scripts)', () => {
    expect(isCallHostUrl('https://meet.google.com/')).toBe(true)
    expect(isCallHostUrl('https://meet.google.com/abc-defg-hij')).toBe(true)
    expect(isCallHostUrl('https://teams.microsoft.com/v2/')).toBe(true)
    expect(isCallHostUrl('https://teams.cloud.microsoft/')).toBe(true)
    expect(isCallHostUrl('https://teams.live.com/')).toBe(true)
    expect(isCallHostUrl('http://meet.google.com/')).toBe(false)
    expect(isCallHostUrl('https://example.com/')).toBe(false)
    expect(isCallHostUrl('https://meet.google.com.example.com/')).toBe(false)
    // Sem permissão no host, o Chrome não dá a URL da aba.
    expect(isCallHostUrl(undefined)).toBe(false)
  })

  it('a atualização do Chrome não marca nada (as abas reabrem com os content scripts)', () => {
    expect(installReasonMarksTabs('install')).toBe(true)
    expect(installReasonMarksTabs('update')).toBe(true)
    expect(installReasonMarksTabs(null)).toBe(true)
    expect(installReasonMarksTabs('chrome_update')).toBe(false)
    expect(installReasonMarksTabs('shared_module_update')).toBe(false)
  })
})

describe('badge: ids das notificações', () => {
  it('ida e volta', () => {
    expect(parseNotificationId(notificationId('sem-audio', 12, '20261006-143005-12-ab12'))).toEqual({
      kind: 'sem-audio',
      tabId: 12,
      sessionId: '20261006-143005-12-ab12',
    })
    expect(parseNotificationId(notificationId('recarregar', 7))).toEqual({ kind: 'recarregar', tabId: 7, sessionId: null })
    // A do vigia (vigia.ts) também foca a aba.
    expect(parseNotificationId('vigia-3-1791320000000')).toEqual({ kind: 'vigia', tabId: 3, sessionId: null })
    expect(parseNotificationId('outra-coisa')).toBeNull()
  })
})

describe('o fim de uma gravação e o ↻ na mesma aba (Emenda 10)', () => {
  function fakeChrome() {
    const badges: Array<[number, string]> = []
    const session = new Map<string, unknown>()
    ;(globalThis as unknown as { chrome: unknown }).chrome = {
      storage: {
        session: {
          get: async (k: string) => (session.has(k) ? { [k]: session.get(k) } : {}),
          set: async (o: Record<string, unknown>) => {
            // Um pouco de latência: é aí que a corrida aparece.
            await new Promise((r) => setTimeout(r, 5))
            for (const [k, v] of Object.entries(o)) session.set(k, v)
          },
        },
      },
      action: {
        setBadgeText: async ({ tabId, text }: { tabId: number; text: string }) => void badges.push([tabId, text]),
        setBadgeBackgroundColor: async () => {},
        setTitle: async () => {},
      },
      notifications: { create: async () => {}, clear: async () => {} },
      tabs: { query: async () => [{ id: 7, url: 'https://meet.google.com/abc-defg-hij', title: 'Daily' }], get: async () => ({ title: 'Daily' }) },
      commands: { getAll: async () => [] },
      runtime: { getURL: (p: string) => p },
    }
    return badges
  }

  it('a recuperação que fecha a gravação interrompida pelo reload não apaga o ↻ que o onInstalled acabou de pôr', async () => {
    vi.resetModules()
    const badges = fakeChrome()
    const mod = await import('./badge')
    await Promise.all([mod.markTabsOpenedBeforeInstall(['https://meet.google.com/*']), mod.clearRecordingBadge(7)])
    expect(badges.at(-1)).toEqual([7, '↻'])
    expect(await mod.tabsNeedingReload()).toEqual([7])
  })

  it('sem o ↻, o fim da gravação limpa o badge', async () => {
    vi.resetModules()
    const badges = fakeChrome()
    const mod = await import('./badge')
    await mod.clearRecordingBadge(7)
    expect(badges.at(-1)).toEqual([7, ''])
  })
})

describe('badge de quem está gravando (Emenda 25)', () => {
  it('gravando, sem a voz: REC; sem nenhum áudio: o âmbar de sempre', () => {
    expect(recordingBadge({ silent: false, mic: false })).toBe('rec')
    expect(recordingBadge({ silent: true, mic: false })).toBe('rec-sem-audio')
  })

  it('com a voz entrando no arquivo, o badge diz isso, mesmo sem áudio da call', () => {
    // A pessoa nunca pode estar sendo gravada sem sinal na tela: este sinal vence o aviso de
    // "sem áudio", que continua saindo como notificação.
    expect(recordingBadge({ silent: false, mic: true })).toBe('rec-microfone')
    expect(recordingBadge({ silent: true, mic: true })).toBe('rec-microfone')
  })
})

describe('badge global e títulos no idioma da interface (Emenda 15)', () => {
  it('gravações não salvas vêm antes do aviso; o aviso sem confirmar põe "!" azul; sem nada, o título do ícone', () => {
    expect(globalBadge(2, true)).toEqual({ text: '!', color: '#f29900', title: 'Gravador de Calls: 2 gravações ainda não salvas; abra para tentar de novo' })
    expect(globalBadge(1, false).title).toBe('Gravador de Calls: 1 gravação ainda não salva; abra para tentar de novo')
    expect(globalBadge(0, true)).toEqual({ text: '!', color: '#1a73e8', title: 'Gravador de Calls: leia e confirme o aviso para a gravação automática começar' })
    expect(globalBadge(0, false)).toEqual({ text: '', color: null, title: 'Gravador de Calls' })
  })

  it('versão publicada esperando a recarga sozinha (Emenda 17): depois das não salvas e do aviso', () => {
    expect(globalBadge(0, false, '0.3.2')).toEqual({
      text: '↑',
      color: '#7b1fa2',
      title: 'Gravador de Calls: a versão 0.3.2 foi publicada; a extensão recarrega sozinha quando nenhuma gravação nem call estiver aberta',
    })
    expect(globalBadge(1, false, '0.3.2').text).toBe('!')
    expect(globalBadge(0, true, '0.3.2').color).toBe('#1a73e8')
    expect(globalBadge(0, false, null).text).toBe('')
  })

  it('em inglês', () => {
    useLocale('en')
    try {
      expect(globalBadge(1, false).title).toBe('Gravador de Calls: 1 recording not saved yet; open to try again')
      expect(globalBadge(0, true).title).toBe('Gravador de Calls: read and confirm the notice to turn on automatic recording')
      expect(shortcutText(undefined)).toBe('no shortcut set (change it at chrome://extensions/shortcuts)')
    } finally {
      useLocale('pt_BR')
    }
  })
})

describe('idioma escolhido nas configurações: títulos do ícone e notificações (Emenda 19)', () => {
  type Title = { tabId?: number; title: string }

  /**
   * Respostas que demoram, lidas na hora de cada chamada (o teste arma no meio): `slowTab` e `gate`
   * seguram a resposta do getTitle daquela aba; `textTab` e `textGate`, o próximo setBadgeText
   * daquela aba (ou do global), uma vez só.
   */
  interface FakeOpts {
    slowTab?: number
    gate?: Promise<void>
    textTab?: number | 'global'
    textGate?: Promise<void>
  }

  /** chrome.action com título por aba (o que não tem título próprio herda o global), e as abas 1 a 4. */
  function fakeAction(opts: FakeOpts = {}) {
    const titles = new Map<number | 'global', string>()
    const texts = new Map<number | 'global', string>()
    const session = new Map<string, unknown>()
    const created: Array<{ id: string; title: string; message: string }> = []
    ;(globalThis as unknown as { chrome: unknown }).chrome = {
      action: {
        setBadgeText: async ({ tabId, text }: { tabId?: number; text: string }) => {
          const gate = opts.textGate
          if (gate && opts.textTab === (tabId ?? 'global')) {
            opts.textGate = undefined
            await gate
          }
          texts.set(tabId ?? 'global', text)
        },
        setBadgeBackgroundColor: async () => {},
        setTitle: async ({ tabId, title }: Title) => void titles.set(tabId ?? 'global', title),
        getTitle: async ({ tabId }: { tabId?: number }) => {
          // O título é lido na hora do pedido; a resposta pode demorar (slowTab).
          const title = (tabId != null ? titles.get(tabId) : undefined) ?? titles.get('global') ?? 'Gravador de Calls'
          if (tabId === opts.slowTab) await opts.gate
          return title
        },
      },
      tabs: { query: async () => [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }], get: async () => ({ title: 'Daily' }) },
      storage: {
        session: {
          get: async (k: string) => (session.has(k) ? { [k]: session.get(k) } : {}),
          set: async (o: Record<string, unknown>) => Object.entries(o).forEach(([k, v]) => session.set(k, v)),
        },
      },
      notifications: { create: async (id: string, o: { title: string; message: string }) => void created.push({ id, title: o.title, message: o.message }) },
      commands: { getAll: async () => [] },
      runtime: { getURL: (p: string) => p },
    }
    return { titles, texts, created }
  }

  /** Uma promessa e a função que a resolve. */
  function gate(): [Promise<void>, () => void] {
    let release: () => void = () => {}
    const p = new Promise<void>((r) => (release = r))
    return [p, release]
  }

  it('o estado de uma aba pelo título, em qualquer das duas línguas; o padrão e os globais não contam', async () => {
    vi.resetModules()
    const { tabStateOfTitle } = await import('./badge')
    expect(tabStateOfTitle('Gravador de Calls: gravando esta call')).toBe('rec')
    expect(tabStateOfTitle('Gravador de Calls: recording this call')).toBe('rec')
    expect(tabStateOfTitle('Gravador de Calls: recording, but no audio so far (try tab mode)')).toBe('rec-sem-audio')
    expect(tabStateOfTitle('Gravador de Calls: recarregue esta aba para gravar a call')).toBe('recarregar')
    expect(tabStateOfTitle('Gravador de Calls')).toBeNull()
    expect(tabStateOfTitle('Gravador de Calls: leia e confirme o aviso para a gravação automática começar')).toBeNull()
  })

  it('trocado o idioma, o título global e o de cada aba com REC ou ↻ vão para o idioma novo, sem prender o padrão nas outras abas', async () => {
    vi.resetModules()
    const { titles } = fakeAction()
    const i18n = await import('../shared/i18n')
    const badge = await import('./badge')
    await badge.setSaveWarning(2)
    await badge.setBadge(1, 'rec')
    await badge.setBadge(2, 'recarregar')
    await badge.setBadge(3, 'nenhum')
    expect(titles.get(1)).toBe('Gravador de Calls: gravando esta call')
    expect(titles.get('global')).toBe('Gravador de Calls: 2 gravações ainda não salvas; abra para tentar de novo')

    i18n.setLanguage('en')
    await badge.refreshActionTitles()
    expect(titles.get('global')).toBe('Gravador de Calls: 2 recordings not saved yet; open to try again')
    expect(titles.get(1)).toBe('Gravador de Calls: recording this call')
    expect(titles.get(2)).toBe('Gravador de Calls: reload this tab to record the call')
    expect(titles.get(3)).toBe('Gravador de Calls')
    // A aba 4 nunca teve título próprio: continua herdando o global.
    expect(titles.has(4)).toBe(false)

    i18n.setLanguage('pt_BR')
    await badge.refreshActionTitles()
    expect(titles.get(1)).toBe('Gravador de Calls: gravando esta call')
    expect(titles.get('global')).toBe('Gravador de Calls: 2 gravações ainda não salvas; abra para tentar de novo')
  })

  it('o registro do SW reaplica os títulos sozinho quando o idioma muda', async () => {
    vi.resetModules()
    const { titles } = fakeAction()
    const on = { addListener: () => {} }
    Object.assign((globalThis as unknown as { chrome: Record<string, unknown> }).chrome, {
      runtime: { getURL: (p: string) => p, onInstalled: on, onConnect: on },
      notifications: { onClicked: on, onButtonClicked: on, create: async () => {} },
      tabs: { query: async () => [{ id: 1 }], onUpdated: on, onRemoved: on },
    })
    const i18n = await import('../shared/i18n')
    const badge = await import('./badge')
    badge.registerBadge()
    await badge.setBadge(1, 'rec')
    i18n.setLanguage('en')
    await vi.waitFor(() => expect(titles.get(1)).toBe('Gravador de Calls: recording this call'))
  })

  it('a aba cujo badge mudou enquanto a troca lia o título antigo não volta ao estado antigo', async () => {
    vi.resetModules()
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => (release = r))
    const { titles } = fakeAction({ slowTab: 1, gate })
    const i18n = await import('../shared/i18n')
    const badge = await import('./badge')
    await badge.setBadge(1, 'rec')
    i18n.setLanguage('en')
    const refreshing = badge.refreshActionTitles()
    await new Promise((r) => setTimeout(r, 0))
    // O fim da gravação chega enquanto a troca espera o título: ele vai depois dela, na fila da aba.
    const ended = badge.setBadge(1, 'nenhum')
    release()
    await Promise.all([refreshing, ended])
    expect(titles.get(1)).toBe('Gravador de Calls')
  })

  it('um setBadge que começou antes da troca e termina depois dela não deixa a aba com o título do estado antigo', async () => {
    vi.resetModules()
    const opts: FakeOpts = {}
    const { titles, texts } = fakeAction(opts)
    const i18n = await import('../shared/i18n')
    const badge = await import('./badge')
    await badge.setBadge(1, 'rec')
    // A gravação da aba 1 acaba antes da troca de idioma, e o setBadgeText do fim demora.
    const [textGate, releaseText] = gate()
    Object.assign(opts, { textTab: 1, textGate })
    const ended = badge.setBadge(1, 'nenhum')
    i18n.setLanguage('en')
    // A troca lê o título da aba 1 enquanto o fim ainda não escreveu o dele.
    const [titleGate, releaseTitle] = gate()
    Object.assign(opts, { slowTab: 1, gate: titleGate })
    const refreshing = badge.refreshActionTitles()
    await new Promise((r) => setTimeout(r, 10))
    releaseText()
    await ended
    releaseTitle()
    await refreshing
    expect(texts.get(1)).toBe('')
    expect(titles.get(1)).toBe('Gravador de Calls')
  })

  it('o título global reaplicado na troca não perde para um badge global que começou antes dela', async () => {
    vi.resetModules()
    const opts: FakeOpts = {}
    const { titles } = fakeAction(opts)
    const i18n = await import('../shared/i18n')
    const badge = await import('./badge')
    // Uma gravação não salva começa a pôr o badge global em português, e o setBadgeText demora.
    const [textGate, releaseText] = gate()
    Object.assign(opts, { textTab: 'global', textGate })
    const warned = badge.setSaveWarning(2)
    await new Promise((r) => setTimeout(r, 0))
    i18n.setLanguage('en')
    const refreshing = badge.refreshActionTitles()
    await new Promise((r) => setTimeout(r, 10))
    releaseText()
    await Promise.all([warned, refreshing])
    expect(titles.get('global')).toBe('Gravador de Calls: 2 recordings not saved yet; open to try again')
  })

  it('o SW que acabou de acordar espera o idioma guardado antes de criar a notificação e o título', async () => {
    vi.resetModules()
    const { titles, created } = fakeAction()
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => (release = r))
    Object.assign((globalThis as unknown as { chrome: Record<string, unknown> }).chrome, {
      storage: {
        session: { get: async () => ({}), set: async () => {} },
        local: { get: async () => (await gate, { settings: { language: 'en' } }) },
        onChanged: { addListener: () => {} },
      },
    })
    const i18n = await import('../shared/i18n')
    const badge = await import('./badge')
    void i18n.initLanguage()
    const notified = badge.notifyNoAudio(5, '20261009-100000-5-ab12')
    const titled = badge.setBadge(5, 'rec-sem-audio')
    await new Promise((r) => setTimeout(r, 10))
    expect(created).toEqual([])
    release()
    await Promise.all([notified, titled])
    expect(created.map((c) => c.title)).toEqual(['No audio is coming in'])
    expect(titles.get(5)).toBe('Gravador de Calls: recording, but no audio so far (try tab mode)')
  })
})
