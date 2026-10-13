// Atalhos dos testes ponta a ponta do vigia (tests/e2e/vigia*.spec.ts).
import type { BrowserContext, Page } from '@playwright/test'
import type { Settings, VigiaCfg, VigiaTabState } from '../../../src/shared/protocol'
import { DEFAULT_VIGIA } from '../../../src/shared/settings'
import { swApi, type Harness } from '../../helpers/browser'

/** Os números do script, com uma leitura por segundo (intervaloSeg é o único que muda). */
export const VIGIA_RAPIDO: VigiaCfg = { ...DEFAULT_VIGIA, intervaloSeg: 1 }
export const INTERVALO_MS = VIGIA_RAPIDO.intervaloSeg * 1000

export const LIGADO: Partial<Omit<Settings, 'profileId'>> = { autoLeave: true, vigia: VIGIA_RAPIDO }

export interface Leitura {
  at: number
  text: string | null
  fixed: boolean
}

const relatos = new WeakMap<Page, Leitura[]>()

/**
 * Abre uma aba que manda cada texto do indicador para o teste (window.vigiaReport), antes de
 * navegar. A sequência continua legível depois que o vigia fecha a aba.
 */
export async function novaAba(context: BrowserContext): Promise<Page> {
  const page = await context.newPage()
  const seen: Leitura[] = []
  relatos.set(page, seen)
  await page.exposeFunction('vigiaReport', (e: Leitura) => {
    seen.push(e)
  })
  return page
}

/** Textos do indicador na ordem em que apareceram (aba aberta com novaAba). */
export async function indicador(page: Page): Promise<Leitura[]> {
  const seen = relatos.get(page)
  if (!seen) throw new Error('abra a aba com novaAba() para acompanhar o indicador')
  return [...seen]
}

export async function ultimoTexto(page: Page): Promise<string | null> {
  return (await indicador(page)).at(-1)?.text ?? null
}

export function fx<T = Record<string, unknown>>(page: Page): Promise<T> {
  return page.evaluate(() => {
    const v = (window as unknown as { vigiaFx: Record<string, unknown> }).vigiaFx
    return Object.fromEntries(Object.entries(v).filter(([, x]) => typeof x !== 'function')) as never
  })
}

/** Resolve com a hora em que a aba fechou (o SW chamou chrome.tabs.remove). */
export function quandoFechar(page: Page, timeout = 30_000): Promise<number> {
  return page.waitForEvent('close', { timeout }).then(() => Date.now())
}

export async function tabIdOf(h: Harness, page: Page): Promise<number> {
  const id = await h.sw.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url === u)?.id ?? null, page.url())
  if (id == null) throw new Error(`aba não encontrada: ${page.url()}`)
  return id
}

export interface VigiaEvento {
  t: 'saindo' | 'fechou' | 'aviso'
  tabId: number
  at: number
  motivo: string
  depoisDeSalvar?: boolean
  esperouMs?: number
  notificou?: boolean
}

export function vigiaEventos(h: Harness): Promise<VigiaEvento[]> {
  return swApi(h.sw).testing<VigiaEvento[]>('vigiaEventos')
}

export function vigiaTabState(h: Harness, tabId: number): Promise<VigiaTabState> {
  return swApi(h.sw).testing<VigiaTabState>('vigiaTabState', tabId)
}

export function vigiaCommand(h: Harness, tabId: number, cmd: 'sair-agora' | 'desligar-nesta-call'): Promise<boolean> {
  return swApi(h.sw).testing<boolean>('vigiaCommand', tabId, cmd)
}

/** Grava as configurações do perfil pelo SW (como a página de opções faria). */
export async function setSettings(h: Harness, s: Partial<Omit<Settings, 'profileId'>>): Promise<void> {
  await h.sw.evaluate(async (more) => {
    const cur = ((await chrome.storage.local.get('settings')).settings ?? {}) as object
    await chrome.storage.local.set({ settings: { ...cur, ...more } })
  }, s)
}
