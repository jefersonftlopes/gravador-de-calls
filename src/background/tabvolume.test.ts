// Volume por aba no SW (tabvolume.ts, Emenda 14) com o Chrome e o offscreen trocados por falsos:
// as decisões de abrir, ajustar e desfazer a captura, o limite de 0..2, a captura que o Chrome
// encerrou, o offscreen sem resposta, os ouvintes que esquecem o volume e dois pedidos ao mesmo
// tempo.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useLocale } from '../../tests/helpers/i18n-setup'

const fake = vi.hoisted(() => ({
  captured: [] as Array<{ tabId: number; status: string }>,
  offscreen: [] as Array<Record<string, unknown>>,
  streamIds: 0,
  /** Estado da captura no offscreen (offscreen:tab-audio). */
  audio: { mode: null as 'volume' | 'gravando' | null, volume: 1 },
  /** O offscreen não responde ao offscreen:tab-audio (documento sendo recriado, por exemplo). */
  audioDown: false,
  /** Outra extensão (o Volume Master) segura a captura da aba: o Chrome recusa a nossa (Emenda 17). */
  otherExtension: false,
  /** Ouvintes que o tabvolume.ts registrou no Chrome falso. */
  onRemoved: [] as Array<(tabId: number) => void>,
  onStatusChanged: [] as Array<(info: { tabId: number; status: string }) => void>,
}))

vi.mock('./offscreen-doc', () => ({
  ensureOffscreen: async () => {},
  sendToOffscreen: async (req: Record<string, unknown>) => {
    fake.offscreen.push(req)
    const v = req.volume as number
    switch (req.t) {
      case 'offscreen:tab-audio':
        if (fake.audioDown) throw new Error('Could not establish connection. Receiving end does not exist.')
        return { mode: fake.audio.mode, volume: fake.audio.volume, replay: true, gain: fake.audio.volume }
      case 'offscreen:tab-volume-start':
        fake.audio = { mode: 'volume', volume: v }
        fake.captured = [{ tabId: req.tabId as number, status: 'active' }]
        return { ok: true }
      case 'offscreen:tab-volume':
        fake.audio.volume = v
        return { ok: true }
      case 'offscreen:tab-volume-stop':
        if (fake.audio.mode === 'volume') {
          fake.audio = { mode: null, volume: 1 }
          fake.captured = []
        } else fake.audio.volume = 1
        return { ok: true }
      default:
        return { ok: true }
    }
  },
}))

const TAB = 7

function installChrome() {
  ;(globalThis as unknown as { chrome: unknown }).chrome = {
    tabs: { onRemoved: { addListener: (fn: (tabId: number) => void) => void fake.onRemoved.push(fn) } },
    tabCapture: {
      onStatusChanged: { addListener: (fn: (info: { tabId: number; status: string }) => void) => void fake.onStatusChanged.push(fn) },
      getCapturedTabs: async () => fake.captured,
      getMediaStreamId: async ({ targetTabId }: { targetTabId: number }) => {
        // O Chrome recusa uma segunda captura da mesma aba.
        if (fake.otherExtension || fake.captured.some((c) => c.tabId === targetTabId)) throw new Error('Cannot capture a tab with an active stream.')
        fake.streamIds++
        await new Promise((r) => setTimeout(r, 20))
        return `stream-${fake.streamIds}`
      },
    },
  }
}

async function load() {
  vi.resetModules()
  installChrome()
  return import('./tabvolume')
}

const types = () => fake.offscreen.map((m) => m.t).filter((t) => t !== 'offscreen:tab-audio')

beforeEach(() => {
  fake.captured = []
  fake.offscreen = []
  fake.streamIds = 0
  fake.audio = { mode: null, volume: 1 }
  fake.audioDown = false
  fake.otherExtension = false
  fake.onRemoved = []
  fake.onStatusChanged = []
})

describe('volume por aba no SW (Emenda 14)', () => {
  it('outra extensão segurando a captura da aba: o erro diz o que fazer, nas duas línguas (Emenda 17)', async () => {
    const mod = await load()
    fake.otherExtension = true
    expect(await mod.setTabVolume(TAB, 1.5)).toEqual({
      ok: false,
      error: 'Outra extensão (por exemplo, o Volume Master) já está capturando o som desta aba. Desligue essa extensão em chrome://extensions, ou feche e reabra a aba, e tente de novo.',
    })
    useLocale('en')
    try {
      const r = await mod.setTabVolume(TAB, 1.5)
      expect(r).toMatchObject({ ok: false })
      expect('error' in r && r.error).toMatch(/^Another extension \(for example, Volume Master\) is already capturing this tab's sound\./)
    } finally {
      useLocale('pt_BR')
    }
    expect(types(), 'nada foi aberto no offscreen').toEqual([])
  })

  it('sem captura: 100% não faz nada; outro valor abre uma captura só de volume', async () => {
    const mod = await load()
    expect(await mod.setTabVolume(TAB, 1)).toEqual({ ok: true, volume: 1, active: false, mode: null })
    expect(fake.streamIds).toBe(0)
    expect(types()).toEqual([])
    expect(await mod.setTabVolume(TAB, 1.5)).toEqual({ ok: true, volume: 1.5, active: true, mode: 'volume' })
    expect(fake.streamIds).toBe(1)
    expect(fake.offscreen.at(-1)).toEqual({ target: 'offscreen', t: 'offscreen:tab-volume-start', tabId: TAB, streamId: 'stream-1', volume: 1.5 })
    expect(mod.rememberedTabVolume(TAB)).toBe(1.5)
    expect(await mod.getTabVolume(TAB)).toEqual({ volume: 1.5, active: true, mode: 'volume' })
  })

  it('só de volume: outro valor ajusta; 100% desfaz a captura e o SW esquece o volume', async () => {
    const mod = await load()
    await mod.setTabVolume(TAB, 1.5)
    expect(await mod.setTabVolume(TAB, 0.3)).toMatchObject({ ok: true, volume: 0.3, active: true })
    expect(fake.offscreen.at(-1)).toEqual({ target: 'offscreen', t: 'offscreen:tab-volume', tabId: TAB, volume: 0.3 })
    expect(fake.streamIds, 'ajustar não abre outra captura').toBe(1)
    expect(await mod.setTabVolume(TAB, 1)).toEqual({ ok: true, volume: 1, active: false, mode: null })
    expect(fake.offscreen.at(-1)).toEqual({ target: 'offscreen', t: 'offscreen:tab-volume-stop', tabId: TAB })
    expect(mod.rememberedTabVolume(TAB)).toBeUndefined()
    expect(await mod.getTabVolume(TAB)).toEqual({ volume: 1, active: false, mode: null })
  })

  it('com o modo aba gravando, 100% só muda o ganho: nunca para a gravação', async () => {
    const mod = await load()
    fake.captured = [{ tabId: TAB, status: 'active' }]
    fake.audio = { mode: 'gravando', volume: 0.3 }
    expect(await mod.setTabVolume(TAB, 1)).toMatchObject({ ok: true, volume: 1, active: true, mode: 'gravando' })
    expect(types()).toEqual(['offscreen:tab-volume'])
    expect(fake.streamIds).toBe(0)
    expect(await mod.setTabVolume(TAB, 0.5)).toMatchObject({ ok: true, mode: 'gravando' })
    expect(types()).toEqual(['offscreen:tab-volume', 'offscreen:tab-volume'])
  })

  it('limita a 0..2 e recusa o que não é número finito', async () => {
    const mod = await load()
    expect(await mod.setTabVolume(TAB, 5)).toMatchObject({ ok: true, volume: 2 })
    expect(fake.offscreen.find((m) => m.t === 'offscreen:tab-volume-start')).toMatchObject({ volume: 2 })
    expect(await mod.setTabVolume(TAB, -1)).toMatchObject({ ok: true, volume: 0 })
    expect(fake.offscreen.at(-1)).toMatchObject({ t: 'offscreen:tab-volume', volume: 0 })
    expect(await mod.setTabVolume(TAB, Number.NaN)).toEqual({ ok: false, error: 'volume inválido' })
  })

  it('captura encerrada pelo Chrome (a faixa terminou): o volume é esquecido e o popup vê 100%', async () => {
    const mod = await load()
    await mod.setTabVolume(TAB, 1.5)
    fake.captured = []
    fake.audio = { mode: null, volume: 1 }
    expect(await mod.getTabVolume(TAB)).toEqual({ volume: 1, active: false, mode: null })
    expect(mod.rememberedTabVolume(TAB)).toBeUndefined()
  })

  it('depois de o SW reiniciar, o volume vem do offscreen', async () => {
    const mod = await load()
    fake.captured = [{ tabId: TAB, status: 'active' }]
    fake.audio = { mode: 'volume', volume: 0.45 }
    expect(await mod.getTabVolume(TAB)).toEqual({ volume: 0.45, active: true, mode: 'volume' })
    expect(mod.rememberedTabVolume(TAB)).toBe(0.45)
  })

  it('dois pedidos ao mesmo tempo numa aba sem captura abrem uma captura só', async () => {
    const mod = await load()
    const [a, b] = await Promise.all([mod.setTabVolume(TAB, 1.5), mod.setTabVolume(TAB, 0.5)])
    expect(a).toMatchObject({ ok: true, mode: 'volume' })
    expect(b).toMatchObject({ ok: true, volume: 0.5 })
    expect(fake.streamIds).toBe(1)
    expect(types()).toEqual(['offscreen:tab-volume-start', 'offscreen:tab-volume'])
  })
  it('offscreen sem resposta com a aba capturada: vale o volume lembrado, e 100% desfaz em vez de pedir outra captura', async () => {
    const mod = await load()
    await mod.setTabVolume(TAB, 1.5)
    fake.audioDown = true
    expect(await mod.getTabVolume(TAB)).toEqual({ volume: 1.5, active: true, mode: 'volume' })
    expect(await mod.setTabVolume(TAB, 1)).toEqual({ ok: true, volume: 1, active: false, mode: null })
    expect(fake.offscreen.at(-1)).toEqual({ target: 'offscreen', t: 'offscreen:tab-volume-stop', tabId: TAB })
    expect(fake.streamIds, 'o Chrome recusaria a segunda captura').toBe(1)
  })

  it('offscreen sem resposta e nada lembrado: sem modo, como antes', async () => {
    const mod = await load()
    fake.captured = [{ tabId: TAB, status: 'active' }]
    fake.audioDown = true
    expect(await mod.getTabVolume(TAB)).toEqual({ volume: 1, active: false, mode: null })
  })

  it('aba fechada e captura parada pelo Chrome fazem o SW esquecer o volume', async () => {
    const mod = await load()
    mod.registerTabVolume()
    await mod.setTabVolume(TAB, 1.5)
    fake.onRemoved.forEach((fn) => fn(TAB))
    expect(mod.rememberedTabVolume(TAB)).toBeUndefined()
    await mod.setTabVolume(TAB, 0.5)
    expect(mod.rememberedTabVolume(TAB)).toBe(0.5)
    fake.onStatusChanged.forEach((fn) => fn({ tabId: TAB, status: 'active' }))
    expect(mod.rememberedTabVolume(TAB), 'ativa não esquece').toBe(0.5)
    fake.onStatusChanged.forEach((fn) => fn({ tabId: TAB, status: 'stopped' }))
    expect(mod.rememberedTabVolume(TAB)).toBeUndefined()
  })
})
