// Relay no mundo ISOLATED (document_start, todas as frames): MAIN world <-> service worker.
//
// - Com o MAIN world fala por um MessagePort que o MAIN transfere no aperto de mão
//   (src/main-world/bridge.ts): a página não vê o tráfego. Pela porta aceita só `dir: 'up'` de
//   tipos conhecidos.
// - Para o SW usa um Port "gravador:sessao" por frame, aberto na primeira mensagem.
// - Guarda em memória os chunks sem `chunk:ack` e, se o Port cair (o SW pode reiniciar),
//   reconecta, manda `hello` + `session:resume` e reenvia os pendentes em ordem.
// - Repassa ao MAIN world toda mudança de autoMeet/autoTeams lida do chrome.storage (Emenda 10):
//   o broadcast do SW só alcança os Ports da vida atual do SW, e uma aba ociosa não tem Port
//   depois que o SW dorme. A confirmação do aviso da primeira execução (Emenda 15) também conta:
//   sem ela, nenhuma plataforma grava sozinha.
import {
  BRIDGE_ACK,
  BRIDGE_CONFIRM,
  BRIDGE_MARK,
  BRIDGE_OPEN,
  BRIDGE_READY,
  BRIDGE_VERSION,
  PAGE_OUTPUT_QUERY,
  PORT_SESSION,
  SETTINGS_KEY,
  isDownType,
  isUpType,
} from '../shared/constants'
import { CONSENT_KEY, autoAllowed } from '../shared/consent'
import type { Down, PageOutputAnswer, Up } from '../shared/protocol'
import { pageUsesSpecificOutput } from './saida'

type ChunkMsg = Extract<Up, { t: 'session:chunk' }>
type EndMsg = Extract<Up, { t: 'session:end' }>

interface Tracked {
  localId: string
  start: Extract<Up, { t: 'session:start' }>
  sessionId: string | null
  /** Último seq enviado ao SW. */
  lastSentSeq: number
  unacked: Map<number, ChunkMsg>
  end: EndMsg | null
}

const RECONNECT_MS = [250, 500, 1000, 2000, 4000]

let port: chrome.runtime.Port | null = null
let hello: Extract<Up, { t: 'hello' }> | null = null
let reconnectAttempt = 0
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let dead = false
const byLocal = new Map<string, Tracked>()
const bySession = new Map<string, Tracked>()

function log(...args: unknown[]) {
  console.debug('[gravador relay]', ...args)
}

/** Porta para o MAIN world (a mais recente que ele abriu, até ele confirmar uma). */
let mainPort: MessagePort | null = null
/**
 * O MAIN confirmou `mainPort` (bridge:confirm). Depois disso nenhum bridge:open troca a porta:
 * o MAIN nunca reabre uma porta confirmada, então um open novo só pode vir de outro script da
 * página, e aceitá-lo cortaria a sessão em silêncio.
 */
let mainLocked = false

function toMain(msg: Down) {
  try {
    mainPort?.postMessage({ dir: 'down', msg })
  } catch (e) {
    log('toMain', e)
  }
}

/** Alguma sessão desta frame ainda precisa do SW (gravando, com pendentes ou com o fim a mandar). */
function hasPendingWork(): boolean {
  return byLocal.size > 0
}

function connect(): chrome.runtime.Port | null {
  if (port) return port
  if (dead) return null
  try {
    port = chrome.runtime.connect({ name: PORT_SESSION })
  } catch (e) {
    // Extensão recarregada ou removida: este content script ficou órfão.
    dead = true
    log('sem extensão', e)
    return null
  }
  port.onMessage.addListener(onDown)
  port.onDisconnect.addListener(() => {
    void chrome.runtime.lastError
    port = null
    if (hasPendingWork()) scheduleReconnect()
  })
  return port
}

function scheduleReconnect() {
  if (reconnectTimer || dead) return
  const delay = RECONNECT_MS[Math.min(reconnectAttempt, RECONNECT_MS.length - 1)]
  reconnectAttempt++
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    if (port) return
    const p = connect()
    if (!p) return
    resync(p)
  }, delay)
}

/** Depois de reconectar: hello, resume de cada sessão, reenvio dos pendentes e do fim. */
function resync(p: chrome.runtime.Port) {
  try {
    if (hello) p.postMessage(hello)
    for (const t of [...byLocal.values()]) {
      // Início sem resposta: manda de novo (o SW deduplica por aba + localId).
      if (!t.sessionId) {
        p.postMessage(t.start)
        continue
      }
      const pending = [...t.unacked.keys()].sort((a, b) => a - b)
      const nextSeq = pending.length ? pending[0] : t.lastSentSeq + 1
      p.postMessage({ t: 'session:resume', localId: t.localId, sessionId: t.sessionId, nextSeq } satisfies Up)
      for (const seq of pending) p.postMessage(t.unacked.get(seq)!)
      if (t.end) {
        p.postMessage(t.end)
        maybeForget(t)
      }
    }
    reconnectAttempt = 0
  } catch (e) {
    log('resync', e)
    port = null
    scheduleReconnect()
  }
}

function send(msg: Up) {
  const reconnecting = !port && byLocal.size > 0
  const p = connect()
  if (!p) return
  // Port caiu e ninguém reconectou ainda: antes da mensagem nova, resume + pendentes em ordem.
  if (reconnecting && msg.t !== 'session:start') resync(p)
  try {
    p.postMessage(msg)
  } catch (e) {
    log('postMessage', e)
    port = null
    scheduleReconnect()
  }
}

function maybeForget(t: Tracked) {
  if (t.end && t.unacked.size === 0) {
    byLocal.delete(t.localId)
    if (t.sessionId) bySession.delete(t.sessionId)
  }
}

function onUp(msg: Up) {
  switch (msg.t) {
    case 'hello':
      hello = msg
      break
    case 'session:start': {
      const t: Tracked = { localId: msg.localId, start: msg, sessionId: null, lastSentSeq: -1, unacked: new Map(), end: null }
      byLocal.set(msg.localId, t)
      break
    }
    case 'session:chunk': {
      const t = bySession.get(msg.sessionId)
      if (t) {
        t.unacked.set(msg.seq, msg)
        t.lastSentSeq = Math.max(t.lastSentSeq, msg.seq)
      }
      break
    }
    case 'session:end': {
      const t = bySession.get(msg.sessionId)
      if (t) t.end = msg
      send(msg)
      // Sem pendentes, o fim já foi: esquece (senão o relay acordaria o SW à toa depois).
      if (t) maybeForget(t)
      return
    }
    default:
      break
  }
  send(msg)
}

function onDown(raw: unknown) {
  const msg = raw as Down
  if (!msg || typeof msg !== 'object' || !isDownType(msg.t)) return
  switch (msg.t) {
    case 'session:accepted': {
      const t = byLocal.get(msg.localId)
      if (t) {
        t.sessionId = msg.sessionId
        bySession.set(msg.sessionId, t)
      }
      break
    }
    case 'session:rejected':
      byLocal.delete(msg.localId)
      break
    case 'chunk:ack': {
      const t = bySession.get(msg.sessionId)
      if (t) {
        t.unacked.delete(msg.seq)
        maybeForget(t)
      }
      break
    }
    default:
      break
  }
  toMain(msg)
}

function onMainMessage(from: MessagePort) {
  return (ev: MessageEvent) => {
    if (from !== mainPort) return
    const data = ev.data as Record<string, unknown> | null
    if (!data || typeof data !== 'object') return
    if (data.t === BRIDGE_CONFIRM) {
      mainLocked = true
      return
    }
    if (data.dir !== 'up') return
    const msg = data.msg as Up | undefined
    if (!msg || typeof msg !== 'object' || !isUpType(msg.t)) return
    try {
      onUp(msg)
    } catch (e) {
      log('onUp', e)
    }
  }
}

// Aperto de mão: o MAIN world abre a porta e a transfere pela janela.
window.addEventListener('message', (ev: MessageEvent) => {
  if (ev.source !== window) return
  const data = ev.data as Record<string, unknown> | null
  if (!data || typeof data !== 'object' || data[BRIDGE_MARK] !== BRIDGE_VERSION) return
  if (data.dir !== 'up' || data.t !== BRIDGE_OPEN) return
  if (mainLocked) {
    log('bridge:open depois da porta confirmada: ignorado')
    return
  }
  const p = ev.ports?.[0]
  if (!p) return
  try {
    mainPort?.close()
  } catch {
    // nada
  }
  mainPort = p
  p.onmessage = onMainMessage(p)
  p.postMessage({ t: BRIDGE_ACK })
})

// Emenda 10: a gravação automática religada nas configurações tem de valer na aba que já estava
// aberta, mesmo com o SW dormindo (sem Port, o settings do SW não chega). Só `false` explícito
// desliga, como nos padrões das configurações.
try {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !(SETTINGS_KEY in changes || CONSENT_KEY in changes)) return
    // A mudança traz só a chave que mudou: a outra é lida do storage.
    void chrome.storage.local
      .get([SETTINGS_KEY, CONSENT_KEY])
      .then((got) => {
        const settings = SETTINGS_KEY in changes ? changes[SETTINGS_KEY].newValue : got[SETTINGS_KEY]
        const consent = CONSENT_KEY in changes ? changes[CONSENT_KEY].newValue : got[CONSENT_KEY]
        toMain({ t: 'settings', autoMeet: autoAllowed('meet', settings, consent), autoTeams: autoAllowed('teams', settings, consent) })
      })
      .catch((e) => log('storage.local', e))
  })
} catch (e) {
  log('storage.onChanged', e)
}

// Emenda 11: antes do modo aba o SW pergunta se a página toca num dispositivo de saída próprio.
// Só a frame do topo responde (o SW pergunta com frameId 0); o DOM é o mesmo nos dois mundos.
try {
  chrome.runtime.onMessage.addListener((msg: unknown, _sender, sendResponse) => {
    if (window.top !== window || !msg || (msg as { t?: unknown }).t !== PAGE_OUTPUT_QUERY) return false
    let especifica = false
    try {
      especifica = pageUsesSpecificOutput(Array.from(document.querySelectorAll<HTMLMediaElement>('audio, video')))
    } catch (e) {
      log('saída da página', e)
    }
    const answer: PageOutputAnswer = { especifica }
    sendResponse(answer)
    return false
  })
} catch (e) {
  log('runtime.onMessage', e)
}

// Se o MAIN world subiu antes e o open se perdeu, ele abre outra porta ao ver isto.
window.postMessage({ [BRIDGE_MARK]: BRIDGE_VERSION, dir: 'down', t: BRIDGE_READY }, window.location.origin === 'null' ? '*' : window.location.origin)
