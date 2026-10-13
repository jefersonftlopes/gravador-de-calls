// Ponte MAIN world <-> relay (ISOLATED).
//
// O tráfego (chunks de áudio a cada 5 s, diagnóstico, metadados) passa por um MessagePort, não
// por window.postMessage: todo listener de 'message' da página (Meet, Teams) veria cada chunk, o
// que é um risco para o AC14 e expõe o áudio a scripts da página. Pela janela só passa o aperto
// de mão, uma ou duas mensagens por frame:
//
//   relay -> janela  { __gravador__: 1, dir: 'down', t: 'bridge:ready' }   (relay acabou de subir)
//   MAIN  -> janela  { __gravador__: 1, dir: 'up', t: 'bridge:open' } + MessagePort transferido
//   relay -> porta   { t: 'bridge:ack' }
//   MAIN  -> porta   { t: 'bridge:confirm' }   (o relay passa a ignorar qualquer outro bridge:open)
//   depois, nos dois sentidos pela porta: { dir: 'up' | 'down', msg }
//
// Os dois scripts rodam no document_start sem ordem garantida entre os mundos. Se o MAIN sobe
// primeiro, o relay recebe o open (o evento é assíncrono) ou, se perder, manda o ready e o MAIN
// abre outra porta. Enquanto o relay não confirma, o MAIN guarda as mensagens numa fila e nada é
// mandado por uma porta que ainda pode ser trocada (então nada se perde na troca).
import { BRIDGE_ACK, BRIDGE_CONFIRM, BRIDGE_MARK, BRIDGE_OPEN, BRIDGE_READY, BRIDGE_VERSION, isDownType } from '../shared/constants'
import type { Down, Up } from '../shared/protocol'
import type { Originals } from './originals'

export interface Bridge {
  send(msg: Up): void
  onDown(cb: (msg: Down) => void): () => void
}

/** Fila máxima antes do relay confirmar (sem relay não há para quem mandar; descarta as velhas). */
const OUTBOX_MAX = 500

export function createBridge(orig: Originals, log: (...a: unknown[]) => void): Bridge {
  const w = orig.win
  const listeners = new Set<(msg: Down) => void>()
  const outbox: Up[] = []
  let port: MessagePort | null = null
  let acked = false
  // Origem opaca (about:blank herdado, sandbox) vira "null", que postMessage não aceita como alvo.
  // O destino é a própria janela, então '*' não expõe nada a mais nesse caso.
  const target = () => (w.location.origin && w.location.origin !== 'null' ? w.location.origin : '*')

  const portPost = (p: MessagePort, data: unknown) => {
    if (orig.portPostMessage) (orig.portPostMessage as (this: MessagePort, m: unknown) => void).call(p, data)
    else p.postMessage(data)
  }

  const flush = () => {
    if (!port || !acked) return
    for (const msg of outbox.splice(0)) portPost(port, { dir: 'up', msg })
  }

  const onPortMessage = (from: MessagePort) => (ev: Event) => {
    try {
      if (from !== port) return
      const data = (ev as MessageEvent).data as Record<string, unknown> | null
      if (!data || typeof data !== 'object') return
      if (data.t === BRIDGE_ACK) {
        if (acked) return
        acked = true
        // Confirma antes de tudo: a partir daqui o relay não troca mais de porta, nem se um
        // script da página mandar um bridge:open próprio pela janela.
        portPost(from, { t: BRIDGE_CONFIRM })
        flush()
        return
      }
      if (data.dir !== 'down') return
      const msg = data.msg as Down | undefined
      if (!msg || typeof msg !== 'object' || !isDownType(msg.t)) return
      for (const cb of listeners) {
        try {
          cb(msg)
        } catch (err) {
          log('bridge listener', err)
        }
      }
    } catch (err) {
      log('bridge porta', err)
    }
  }

  const open = () => {
    const MC = orig.MessageChannel
    if (!MC) {
      log('MessageChannel indisponível: sem ponte')
      return
    }
    try {
      port?.close()
    } catch {
      // nada
    }
    const ch = new MC()
    port = ch.port1
    acked = false
    const add = orig.portAddEventListener ?? ch.port1.addEventListener
    ;(add as (this: MessagePort, t: string, l: (e: Event) => void) => void).call(ch.port1, 'message', onPortMessage(ch.port1))
    if (orig.portStart) (orig.portStart as (this: MessagePort) => void).call(ch.port1)
    else ch.port1.start()
    const post = orig.postMessage as (this: Window, message: unknown, targetOrigin: string, transfer: Transferable[]) => void
    post.call(w, { [BRIDGE_MARK]: BRIDGE_VERSION, dir: 'up', t: BRIDGE_OPEN }, target(), [ch.port2])
  }

  // O relay subiu depois de nós e perdeu o open: abre outra porta (só se a atual não foi
  // confirmada; uma porta confirmada pode ter mensagens a caminho e não pode ser trocada).
  orig.addEventListener.call(w, 'message', (ev: Event) => {
    try {
      const e = ev as MessageEvent
      if (e.source !== w) return
      const data = e.data as Record<string, unknown> | null
      if (!data || typeof data !== 'object' || data[BRIDGE_MARK] !== BRIDGE_VERSION) return
      if (data.dir === 'down' && data.t === BRIDGE_READY && !acked) open()
    } catch (err) {
      log('bridge ready', err)
    }
  })

  try {
    open()
  } catch (e) {
    log('bridge open', e)
  }

  return {
    send(msg) {
      try {
        if (port && acked) portPost(port, { dir: 'up', msg })
        else {
          outbox.push(msg)
          if (outbox.length > OUTBOX_MAX) outbox.shift()
        }
      } catch (e) {
        log('bridge send', e)
      }
    },
    onDown(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
  }
}

export { blobToBase64 } from '../shared/base64'
