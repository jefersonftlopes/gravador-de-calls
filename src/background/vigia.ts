// Lado SW do vigia (Emendas 2 e 3): Port "gravador:vigia" vindo do content script ISOLATED da
// frame do topo das calls.
// - manda a configuração (vigia:config) ao conectar e quando ela muda;
// - vigia:saindo: marca a sessão de página da aba como saída automática (info.json);
// - vigia:fechar-aba: espera a gravação da aba ficar SALVA (info.json escrito; até 20 s) e fecha
//   a aba com chrome.tabs.remove (nada de window.close() nem about:blank). Emenda 4;
// - vigia:nao-consegui-sair: desfaz a marca de saída automática e avisa por notificação;
// - vigia:nesta-call: o content script diz se está parado nesta call (desligado pelo popup ou
//   desistiu de sair) ou se voltou a valer numa call nova do mesmo documento (Emenda 7);
// - popup (Emenda 6): ui-api.ts só chama as funções exportadas daqui (vigiaTabState,
//   vigiaStatuses, vigiaCommand), então a fatia do vigia muda o comportamento sem tocar na
//   interface, e a interface lê o vigia sem tocar neste arquivo.
// - ganchos de teste (Emenda 5): vigiaEventos (o que o SW fez: saindo, fechou, aviso),
//   vigiaCommand e vigiaTabState, os mesmos caminhos do popup.
import { PORT_VIGIA } from '../shared/constants'
import { languageReady, t } from '../shared/i18n'
import { parseVigiaUp, type Settings, type VigiaDown, type VigiaStatus, type VigiaTabState } from '../shared/protocol'
import { loadSettings } from '../shared/settings'
import { setAutoLeave, waitTabSessionSaved } from './sessions'
import { registerTestHooks } from './testing'
import { allVigiaStatuses, clearVigiaStatus, setVigiaStatus, vigiaStatusOf } from './vigia-state'

export const CLOSE_WAIT_MS = 20_000

/** Abas que já pediram para fechar (o content script manda uma vez, mas o SW não confia). */
const closing = new Set<number>()

/**
 * O que o lado SW do vigia fez, em memória e só para leitura (gancho de teste `vigiaEventos`):
 * fecha-aba com quanto esperou e se foi depois de salvar, saídas marcadas, avisos mostrados.
 */
export interface VigiaEvento {
  t: 'saindo' | 'fechou' | 'aviso'
  tabId: number
  at: number
  motivo: string
  /** fechou: a espera terminou com a gravação salva (false: pelo limite de 20 s). */
  depoisDeSalvar?: boolean
  esperouMs?: number
  /** aviso: a notificação foi criada (false: o Chrome recusou). */
  notificou?: boolean
}
const eventos: VigiaEvento[] = []
const EVENTOS_MAX = 100
function registrar(e: VigiaEvento): void {
  eventos.push(e)
  if (eventos.length > EVENTOS_MAX) eventos.shift()
}

const ports = new Map<number, chrome.runtime.Port>()
/**
 * Abas em que o vigia está parado nesta call (Emenda 7). Quem sabe é o content script: ele manda
 * vigia:nesta-call ao conectar e a cada mudança, inclusive quando uma call nova começa no mesmo
 * documento. O Port caindo (a aba navegou ou fechou) também tira.
 */
const disabledForCall = new Set<number>()
const log = (...a: unknown[]) => console.debug('[gravador vigia]', ...a)

function send(port: chrome.runtime.Port | undefined, msg: VigiaDown): boolean {
  if (!port) return false
  try {
    port.postMessage(msg)
    return true
  } catch {
    return false
  }
}

function configMsg(s: Settings): VigiaDown {
  return { t: 'vigia:config', autoLeave: s.autoLeave, indicador: s.vigiaIndicador, cfg: s.vigia }
}

async function closeTabAfterSave(tabId: number, motivo: string): Promise<void> {
  if (closing.has(tabId)) return
  closing.add(tabId)
  const t0 = Date.now()
  try {
    const safe = await waitTabSessionSaved(tabId, CLOSE_WAIT_MS)
    log('fechando a aba', tabId, motivo, safe ? 'depois de salvar' : 'sem a gravação salva (limite de 20 s ou falha ao salvar)')
    registrar({ t: 'fechou', tabId, at: Date.now(), motivo, depoisDeSalvar: safe, esperouMs: Date.now() - t0 })
    await chrome.tabs.remove(tabId).catch((e) => log('tabs.remove', e))
  } finally {
    closing.delete(tabId)
  }
}

async function notifyCouldNotLeave(tabId: number, motivo: string): Promise<void> {
  let ok = true
  // Emenda 19: o aviso sai no idioma escolhido mesmo com o SW acabando de acordar.
  await languageReady()
  try {
    await chrome.notifications.create(`vigia-${tabId}-${Date.now()}`, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: t('extName'),
      message: t('notifVigiaMessage'),
    })
  } catch (e) {
    ok = false
    log('notificação', e)
  }
  registrar({ t: 'aviso', tabId, at: Date.now(), motivo, notificou: ok })
}

export function registerVigiaPorts(): void {
  registerTestHooks({
    vigiaEventos: () => eventos.map((e) => ({ ...e })),
    vigiaCommand: (tabId: number, cmd: 'sair-agora' | 'desligar-nesta-call') => vigiaCommand(tabId, cmd),
    vigiaTabState: (tabId: number) => vigiaTabState(tabId),
  })
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== PORT_VIGIA) return
    const tabId = port.sender?.tab?.id
    if (tabId == null || (port.sender?.frameId ?? 0) !== 0) {
      port.disconnect()
      return
    }
    ports.set(tabId, port)
    // Até o vigia:nesta-call que o content script manda logo ao conectar.
    disabledForCall.delete(tabId)
    void loadSettings().then((s) => send(port, configMsg(s)))
    port.onMessage.addListener((raw: unknown) => {
      const msg = parseVigiaUp(raw)
      if (!msg) return
      switch (msg.t) {
        case 'vigia:status': {
          const { t: _t, ...status } = msg
          setVigiaStatus(tabId, status)
          break
        }
        case 'vigia:saindo':
          registrar({ t: 'saindo', tabId, at: Date.now(), motivo: msg.motivo })
          void setAutoLeave(tabId, { motivo: msg.motivo, pico: msg.pico, na: msg.n, em: Date.now() })
          break
        case 'vigia:fechar-aba':
          void closeTabAfterSave(tabId, msg.motivo)
          break
        case 'vigia:nao-consegui-sair':
          // Não saiu: o fim da gravação volta a ser o da plataforma, não "saida-automatica".
          void setAutoLeave(tabId, null)
          void notifyCouldNotLeave(tabId, msg.motivo)
          break
        case 'vigia:nesta-call':
          if (msg.desligado) {
            disabledForCall.add(tabId)
            // A última leitura (às vezes "saindo") não vale mais enquanto ele estiver parado.
            clearVigiaStatus(tabId)
          } else disabledForCall.delete(tabId)
          break
      }
    })
    port.onDisconnect.addListener(() => {
      if (ports.get(tabId) !== port) return
      ports.delete(tabId)
      disabledForCall.delete(tabId)
      clearVigiaStatus(tabId)
    })
  })
}

export function broadcastVigiaConfig(s: Settings): void {
  for (const port of ports.values()) send(port, configMsg(s))
}

/** Comando do popup para o vigia da aba. Devolve se chegou a um vigia conectado. */
export function vigiaCommand(tabId: number, cmd: 'sair-agora' | 'desligar-nesta-call'): boolean {
  const ok = send(ports.get(tabId), cmd === 'sair-agora' ? { t: 'vigia:sair-agora' } : { t: 'vigia:desligar-nesta-call' })
  if (ok && cmd === 'desligar-nesta-call') disabledForCall.add(tabId)
  return ok
}

/** ui:vigia-status: o vigia de uma aba, como o popup mostra. */
export function vigiaTabState(tabId: number): VigiaTabState {
  return { connected: ports.has(tabId), disabledForCall: disabledForCall.has(tabId), status: vigiaStatusOf(tabId) }
}

/** ui:state: o vigia de todas as abas com leitura. */
export function vigiaStatuses(): Array<{ tabId: number; status: VigiaStatus }> {
  return allVigiaStatuses()
}
