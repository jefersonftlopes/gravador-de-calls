// Tradução (Emenda 15): as duas línguas têm as mesmas chaves e os mesmos valores ($1, $2...),
// toda chave usada no código existe, os textos não têm travessão, e t()/tp() trocam os valores e
// escolhem o plural pela regra do idioma. Emenda 19: o formatador das mensagens embutidas com a
// semântica medida do chrome.i18n, o idioma escolhido (auto, pt_BR, en) em t(), tp() e
// messageLocale(), a pasta de Downloads presa ao idioma do Chrome, e a leitura e a troca do idioma.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fakeGetMessage, localeMessages, type Locale } from '../../tests/helpers/i18n-fake'
import { useLocale } from '../../tests/helpers/i18n-setup'
import { ROOT } from '../../tests/helpers/paths'
import { downloadsFolderName, formatMessage, languageOf, messageLocale, onLanguageChange, recognizeMessage, setLanguage, t, tIn, tp, uiLanguage, type MessageKey } from './i18n'

const en = localeMessages('en')
const pt = localeMessages('pt_BR')

/** Os $1..$9 de uma mensagem, em ordem e sem repetição. */
const slots = (message: string) => [...new Set([...message.matchAll(/\$([1-9])/g)].map((m) => m[1]))].sort()

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p))
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.ts$/.test(name)) out.push(p)
  }
  return out
}

/**
 * Chaves usadas no código: t('chave'...), tp('base'...), labelKey: 'chave' (tabelas de rótulos) e
 * __MSG_chave__ no manifesto. Uma chamada com chave que não é literal não passa (o teste exige o
 * literal para poder conferir).
 */
function usedKeys(): Map<string, string[]> {
  const used = new Map<string, string[]>()
  const add = (key: string, where: string) => used.set(key, [...(used.get(key) ?? []), where])
  const files = [...sourceFiles(join(ROOT, 'src')), join(ROOT, 'manifest.config.ts')]
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    const where = relative(ROOT, file)
    for (const m of text.matchAll(/\bt\(\s*'([A-Za-z0-9_]+)'/g)) add(m[1], where)
    for (const m of text.matchAll(/\btp\(\s*'([A-Za-z0-9_]+)'/g)) {
      add(`${m[1]}_one`, where)
      add(`${m[1]}_other`, where)
    }
    for (const m of text.matchAll(/labelKey: '([A-Za-z0-9_]+)'/g)) add(m[1], where)
    for (const m of text.matchAll(/__MSG_([A-Za-z0-9_]+)__/g)) add(m[1], where)
  }
  return used
}

afterEach(() => {
  useLocale('pt_BR')
  setLanguage('auto')
})

describe('mensagens: en e pt_BR', () => {
  it('as duas línguas têm exatamente as mesmas chaves', () => {
    expect(Object.keys(pt).filter((k) => !(k in en)), 'só em pt_BR').toEqual([])
    expect(Object.keys(en).filter((k) => !(k in pt)), 'só em en').toEqual([])
  })

  it('cada mensagem tem os mesmos valores ($1, $2...) nas duas línguas e nenhuma está vazia', () => {
    for (const key of Object.keys(en)) {
      expect(slots(pt[key].message), key).toEqual(slots(en[key].message))
      expect(en[key].message.trim(), key).not.toBe('')
      expect(pt[key].message.trim(), key).not.toBe('')
    }
  })

  it('toda chave usada no código existe nas duas línguas', () => {
    const used = usedKeys()
    expect(used.size).toBeGreaterThan(100)
    const missing = [...used].filter(([k]) => !(k in en) || !(k in pt)).map(([k, files]) => `${k} (${files.join(', ')})`)
    expect(missing).toEqual([])
  })

  it('nenhuma mensagem sobra sem uso (as lidas por tabela contam pelo literal da chave)', () => {
    const used = usedKeys()
    const literals = new Set<string>()
    for (const file of sourceFiles(join(ROOT, 'src'))) for (const m of readFileSync(file, 'utf8').matchAll(/'([A-Za-z0-9_]+)'/g)) literals.add(m[1])
    expect(Object.keys(en).filter((k) => !used.has(k) && !literals.has(k))).toEqual([])
  })

  it('sem travessão nem meia-risca, e a descrição cabe no limite da loja (132)', () => {
    for (const [key, v] of [...Object.entries(en), ...Object.entries(pt)]) expect(v.message, key).not.toMatch(/[\u2013\u2014]/)
    expect(en.extDescription.message.length).toBeLessThanOrEqual(132)
    expect(pt.extDescription.message.length).toBeLessThanOrEqual(132)
  })

  it('plural: toda base com _one tem _other', () => {
    for (const key of Object.keys(en).filter((k) => k.endsWith('_one'))) expect(en, key).toHaveProperty(key.replace(/_one$/, '_other'))
  })
})

describe('t() e tp()', () => {
  it('troca os valores e devolve a chave quando a mensagem não existe', () => {
    expect(t('durationHours', 1, '05')).toBe('1 h 05 min')
    expect(t('nao-existe' as never)).toBe('nao-existe')
  })

  it('segue o idioma: pasta de Downloads e locale das mensagens', () => {
    expect(downloadsFolderName()).toBe('Gravações de calls')
    expect(messageLocale()).toBe('pt-BR')
    useLocale('en')
    expect(downloadsFolderName()).toBe('Call recordings')
    expect(messageLocale()).toBe('en')
    expect(t('popupRecordingNow')).toBe('Recording now')
  })

  it('plural pela regra de cada idioma: em inglês 0 é plural, em português 0 e 1 são singular', () => {
    useLocale('en')
    expect(tp('badgePendingSaves', 1)).toBe('Gravador de Calls: 1 recording not saved yet; open to try again')
    expect(tp('badgePendingSaves', 2)).toBe('Gravador de Calls: 2 recordings not saved yet; open to try again')
    expect(tp('badgePendingSaves', 0)).toContain('0 recordings')
    useLocale('pt_BR')
    expect(tp('badgePendingSaves', 1)).toBe('Gravador de Calls: 1 gravação ainda não salva; abra para tentar de novo')
    expect(tp('badgePendingSaves', 3)).toBe('Gravador de Calls: 3 gravações ainda não salvas; abra para tentar de novo')
    expect(tp('badgePendingSaves', 0)).toContain('0 gravação ainda')
  })

  it('fora da extensão (sem chrome.i18n) devolve a chave em vez de quebrar', () => {
    const saved = globalThis.chrome
    globalThis.chrome = { i18n: undefined } as unknown as typeof chrome
    try {
      expect(t('popupStop')).toBe('popupStop')
    } finally {
      globalThis.chrome = saved
    }
  })
})

describe('formatMessage: a semântica do chrome.i18n (medida no Chrome for Testing 151)', () => {
  const entry = (message: string, placeholders?: Record<string, { content: string }>) => ({ message, placeholders })

  it('$1..$9 viram os valores, na ordem que a mensagem pede, e um valor pode repetir', () => {
    expect(formatMessage(entry('$2 de $1, $2 de novo'), ['a', 'b'])).toBe('b de a, b de novo')
    expect(formatMessage(entry('$1$2$3$4$5$6$7$8$9'), ['1', '2', '3', '4', '5', '6', '7', '8', '9'])).toBe('123456789')
    // Um valor só pode ir como texto, não lista.
    expect(formatMessage(entry('oi $1'), 'Ana')).toBe('oi Ana')
  })

  it('valor que falta vira vazio; sem valores, os $n somem', () => {
    expect(formatMessage(entry('$1 e $2.'), ['só um'])).toBe('só um e .')
    expect(formatMessage(entry('[$1]'))).toBe('[]')
  })

  it('$$ vira $, e $$1 é um $ seguido do texto "1"', () => {
    expect(formatMessage(entry('custa $$5'), [])).toBe('custa $5')
    expect(formatMessage(entry('$$1'), ['x'])).toBe('$1')
    expect(formatMessage(entry('$ sozinho e $0'), ['x'])).toBe('$ sozinho e $0')
  })

  it('placeholders com nome viram o content (sem diferenciar maiúsculas), que pode levar $n', () => {
    const e = entry('Olá, $NOME$! Você tem $Total$.', { nome: { content: '$1' }, TOTAL: { content: '$2 mensagens' } })
    expect(formatMessage(e, ['Ana', '3'])).toBe('Olá, Ana! Você tem 3 mensagens.')
    // Placeholder que não existe fica como está.
    expect(formatMessage(entry('$OUTRO$ fica'), [])).toBe('$OUTRO$ fica')
  })

  it('sem a mensagem, texto vazio (o t() troca pela chave)', () => {
    expect(formatMessage(undefined, ['x'])).toBe('')
    expect(formatMessage({} as never)).toBe('')
  })

  it('o chrome.i18n falso dos testes é o mesmo formatador, sobre as mensagens de verdade', () => {
    for (const locale of ['en', 'pt_BR'] as Locale[]) {
      const get = fakeGetMessage(locale)
      for (const key of Object.keys(en)) {
        expect(get(key, ['A', 'B', 'C', 'D']), `${locale} ${key}`).toBe(formatMessage(localeMessages(locale)[key], ['A', 'B', 'C', 'D']))
      }
      expect(get('nao-existe')).toBe('')
    }
  })
})

describe('idioma escolhido nas configurações (Emenda 19)', () => {
  const ALL = Object.keys(en) as MessageKey[]
  const SUBS = ['7', 'x', 'y', 'z'] as const

  it('o escolhido dá exatamente o texto que o Chrome daria nesse idioma, em toda chave', () => {
    // Chrome em português, escolhido inglês (e o contrário): cada mensagem igual à do chrome.i18n
    // do outro idioma, com os mesmos valores.
    for (const [chrome, chosen] of [['pt_BR', 'en'], ['en', 'pt_BR']] as Array<[Locale, Locale]>) {
      useLocale(chosen)
      setLanguage('auto')
      const expected = ALL.map((k) => t(k, ...SUBS))
      useLocale(chrome)
      setLanguage(chosen)
      expect(ALL.map((k) => t(k, ...SUBS)), `Chrome ${chrome}, escolhido ${chosen}`).toEqual(expected)
      expect(ALL.map((k) => tIn(chosen, k, ...SUBS))).toEqual(expected)
    }
  })

  it('auto segue o Chrome; pt_BR e en valem mesmo com o Chrome no outro idioma', () => {
    useLocale('pt_BR')
    expect([uiLanguage(), messageLocale(), t('popupRecordingNow')]).toEqual(['auto', 'pt-BR', 'Gravando agora'])
    setLanguage('en')
    expect([uiLanguage(), messageLocale(), t('popupRecordingNow'), t('durationHours', 1, '05')]).toEqual(['en', 'en', 'Recording now', '1 h 05 min'])
    useLocale('en')
    setLanguage('pt_BR')
    expect([messageLocale(), t('popupRecordingNow')]).toEqual(['pt-BR', 'Gravando agora'])
    setLanguage('auto')
    expect([messageLocale(), t('popupRecordingNow')]).toEqual(['en', 'Recording now'])
  })

  it('chave inexistente devolve a chave nos três', () => {
    for (const l of ['auto', 'pt_BR', 'en'] as const) {
      setLanguage(l)
      expect(t('nao-existe' as never)).toBe('nao-existe')
    }
  })

  it('plural pela regra do idioma escolhido, não a do Chrome', () => {
    useLocale('pt_BR')
    setLanguage('en')
    // Em inglês o 0 é plural.
    expect(tp('badgePendingSaves', 0)).toBe('Gravador de Calls: 0 recordings not saved yet; open to try again')
    expect(tp('badgePendingSaves', 1)).toBe('Gravador de Calls: 1 recording not saved yet; open to try again')
    useLocale('en')
    setLanguage('pt_BR')
    // Em português o 0 é singular.
    expect(tp('badgePendingSaves', 0)).toBe('Gravador de Calls: 0 gravação ainda não salva; abra para tentar de novo')
    expect(tp('badgePendingSaves', 2)).toBe('Gravador de Calls: 2 gravações ainda não salvas; abra para tentar de novo')
  })

  it('a pasta em Downloads segue o idioma do Chrome, qualquer que seja o escolhido', () => {
    useLocale('pt_BR')
    setLanguage('en')
    expect(downloadsFolderName()).toBe('Gravações de calls')
    useLocale('en')
    setLanguage('pt_BR')
    expect(downloadsFolderName()).toBe('Call recordings')
  })

  it('languageOf: ausente, desconhecido ou de outro tipo vira auto', () => {
    expect(languageOf(undefined)).toBe('auto')
    expect(languageOf({})).toBe('auto')
    expect(languageOf({ language: 'es' })).toBe('auto')
    expect(languageOf({ language: 'pt-BR' })).toBe('auto')
    expect(languageOf({ language: 1 })).toBe('auto')
    expect(languageOf('en')).toBe('auto')
    expect(languageOf({ language: 'en' })).toBe('en')
    expect(languageOf({ language: 'pt_BR' })).toBe('pt_BR')
  })

  it('onLanguageChange: avisa só quando muda, um ouvinte que falha não impede os outros, e para de ouvir', () => {
    const seen: string[] = []
    const off = onLanguageChange((l) => seen.push(`a:${l}`))
    const offBad = onLanguageChange(() => {
      throw new Error('quebrado')
    })
    const offB = onLanguageChange((l) => seen.push(`b:${l}`))
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {})
    setLanguage('en')
    setLanguage('en')
    off()
    setLanguage('pt_BR')
    offBad()
    offB()
    setLanguage('auto')
    expect(seen).toEqual(['a:en', 'b:en', 'b:pt_BR'])
    expect(debug).toHaveBeenCalledTimes(2)
    debug.mockRestore()
  })
})

describe('recognizeMessage: o texto que já saiu de uma mensagem (Emenda 19)', () => {
  const keys = Object.keys(en) as MessageKey[]

  it('em toda chave e nas duas línguas, reconhece a chave e os valores, e formatar de novo dá o mesmo texto', () => {
    for (const locale of ['en', 'pt_BR'] as const) {
      for (const key of keys) {
        const text = tIn(locale, key, '/Users/x/Calls', 'ping 5', 'três', '4', '5', '6', '7', '8', '9')
        const got = recognizeMessage(text, [key])
        expect(got?.key, `${locale} ${key}`).toBe(key)
        expect(tIn(locale, key, ...got!.subs), `${locale} ${key}`).toBe(text)
      }
    }
  })

  it('só o texto inteiro conta, e só entre as chaves pedidas', () => {
    const timeout = tIn('pt_BR', 'errHelperTimeout', 'ping', 5000)
    expect(recognizeMessage(timeout, ['errHelperTimeout'])).toEqual({ key: 'errHelperTimeout', subs: ['ping', '5000'] })
    expect(recognizeMessage(`${timeout}.`, ['errHelperTimeout'])).toBeNull()
    expect(recognizeMessage(`x${timeout}`, ['errHelperTimeout'])).toBeNull()
    expect(recognizeMessage(timeout, ['errHelperDisconnected'])).toBeNull()
    // Caracteres de expressão regular no texto fixo valem como texto.
    expect(recognizeMessage('the offscreen document could not build the file (a.webm): x', ['errBlobUrl'])).toEqual({ key: 'errBlobUrl', subs: ['a.webm', 'x'] })
    expect(recognizeMessage('the offscreen document could not build the file Xa.webmY: x', ['errBlobUrl'])).toBeNull()
  })
})

describe('initLanguage e languageReady (Emenda 19)', () => {
  type Listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => void

  /** Um módulo novo (o estado do idioma é por contexto) com um chrome.storage falso. */
  async function fresh(stored: unknown, opts: { slow?: boolean; fail?: boolean } = {}) {
    vi.resetModules()
    const listeners: Listener[] = []
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => (release = r))
    globalThis.chrome = {
      storage: {
        local: {
          get: async () => {
            if (opts.slow) await gate
            if (opts.fail) throw new Error('storage fora')
            return stored === undefined ? {} : { settings: stored }
          },
        },
        onChanged: { addListener: (l: Listener) => listeners.push(l) },
      },
    } as unknown as typeof chrome
    const mod = await import('./i18n')
    const change = (newValue: unknown, area = 'local') => listeners.forEach((l) => l({ settings: { newValue } as chrome.storage.StorageChange }, area))
    return { mod, listeners, change, release }
  }

  it('lê o guardado, uma vez, e passa a ouvir as mudanças do storage local', async () => {
    const { mod, listeners, change } = await fresh({ language: 'en', autoLeave: true })
    expect(mod.uiLanguage()).toBe('auto')
    const p = mod.initLanguage()
    expect(mod.initLanguage()).toBe(p)
    expect(listeners).toHaveLength(1)
    expect(await p).toBe('en')
    expect(await mod.languageReady()).toBe('en')
    expect(mod.t('popupRecordingNow')).toBe('Recording now')
    change({ language: 'pt_BR' })
    expect(mod.uiLanguage()).toBe('pt_BR')
    // Outra área do storage não conta; settings sem o campo é auto.
    change({ language: 'en' }, 'sync')
    expect(mod.uiLanguage()).toBe('pt_BR')
    change({ autoLeave: false })
    expect(mod.uiLanguage()).toBe('auto')
  })

  it('o SW acordado por uma mudança: a mudança que chega antes da leitura vale mais que ela', async () => {
    const { mod, change, release } = await fresh({ language: 'pt_BR' }, { slow: true })
    const p = mod.initLanguage()
    let done = false
    void mod.languageReady().then(() => (done = true))
    await Promise.resolve()
    expect(done).toBe(false)
    change({ language: 'en' })
    release()
    expect(await p).toBe('en')
    expect(mod.uiLanguage()).toBe('en')
  })

  it('um texto pedido no meio da leitura espera por ela (languageReady)', async () => {
    const { mod, release } = await fresh({ language: 'en' }, { slow: true })
    void mod.initLanguage()
    const text = mod.languageReady().then(() => mod.t('notifNoAudioTitle'))
    release()
    expect(await text).toBe(mod.tIn('en', 'notifNoAudioTitle'))
    expect(await text).not.toBe(mod.tIn('pt_BR', 'notifNoAudioTitle'))
  })

  it('sem storage, storage com erro ou configuração antiga sem o campo: auto, sem rejeitar', async () => {
    let r = await fresh(undefined)
    expect(await r.mod.initLanguage()).toBe('auto')
    r = await fresh({ profileLabel: 'Trabalho' })
    expect(await r.mod.initLanguage()).toBe('auto')
    r = await fresh({ language: 'en' }, { fail: true })
    expect(await r.mod.initLanguage()).toBe('auto')
    vi.resetModules()
    globalThis.chrome = {} as typeof chrome
    const bare = await import('./i18n')
    expect(await bare.initLanguage()).toBe('auto')
    // Sem initLanguage, languageReady resolve na hora.
    vi.resetModules()
    const none = await import('./i18n')
    expect(await none.languageReady()).toBe('auto')
  })

  it('um storage que não responde não segura os textos: depois de 2 s, fica no que já vale', async () => {
    vi.useFakeTimers()
    try {
      const { mod } = await fresh({ language: 'en' }, { slow: true })
      const p = mod.initLanguage()
      await vi.advanceTimersByTimeAsync(2000)
      expect(await p).toBe('auto')
    } finally {
      vi.useRealTimers()
    }
  })
})
