// Máquina de estados da sessão desta frame (docs/ARQUITETURA.md, "Sessão na frame").
//
//   idle -> candidate (em call, esperando 2 s estável) -> recording -> finishing -> done
//
// Depois de done (ou de uma recusa do SW), só volta a idle quando os sinais de "em call" caem:
// assim uma nova call na mesma aba abre outra sessão, mas a mesma call não reabre em laço.
import { HOOK_VERSION, MAX_SPEAKER_INTERVALS, MIXER_DELAY_MS } from '../shared/constants'
import type { CallMeta, CaptureDiag, Down, EndReason, HoldPeriod, SeamDiag, SeamId, SpeakerDiagnostics } from '../shared/protocol'
import { SEAM_IDS } from '../shared/constants'
import { ARBITRATION_TICK_MS, arbitrate, hasSpeech, initialArbitration, type ArbitrationState } from './capture/arbitration'
import { DELAY_SEC, createMixer, type Mixer } from './capture/mixer'
import { createRecorder, type Recorder, type RecorderChunk } from './capture/recorder'
import type { Registry } from './capture/registry'
import type { SeamSet } from './capture/seams'
import { criarRelogio, type Tarefa } from '../shared/relogio'
import { createTimeline, type SpeakerReading, type Timeline } from './speakers/timeline'
import { blobToBase64, type Bridge } from './bridge'
import type { Originals } from './originals'
import type { PlatformAdapter, Probe, SpeakerProbe } from './platforms/types'

export const TICK_MS = 1000
export const STABLE_MS = 2000
export const NOT_IN_CALL_END_MS = 15000
export const META_EVERY_MS = 5000
export const DIAG_EVERY_MS = 5000
/** Quanto esperar o SW aceitar a sessão no fim antes de desistir de mandar os chunks. */
const ACCEPT_WAIT_MS = 5000
/** Sincronizar fontes do mixer a cada N ticks da arbitragem (1 s). */
const SYNC_EVERY_TICKS = 4
/** Lote da linha do tempo dos falantes (Emenda 18), junto do diagnóstico. */
export const SPEAKERS_EVERY_MS = 5000
/**
 * Microfone acima disto conta como você falando (Emenda 18). Mais alto que o limiar de fala dos
 * seams (-55): o microfone tem ruído de fundo e o cancelamento de eco deixa um resto da call.
 * Opinião, a medir numa call real.
 */
export const MIC_SPEECH_DBFS = -45

export type SessionState = 'idle' | 'candidate' | 'recording' | 'finishing' | 'done' | 'rejected'

export interface SessionDeps {
  orig: Originals
  log: (...a: unknown[]) => void
  adapter: PlatformAdapter
  registry: Registry
  seams: SeamSet
  bridge: Bridge
}

export interface SessionController {
  readonly state: SessionState
  dispose(): void
}

interface Active {
  localId: string
  sessionId: string | null
  startedAt: number
  mixer: Mixer
  recorder: Recorder
  arb: ArbitrationState
  /** Laço da arbitragem no relógio resistente (Emenda 12). */
  arbTask: Tarefa
  arbTicks: number
  /** Chunks já codificados esperando o session:accepted. */
  pending: Array<{ seq: number; data: string; bytes: number; at: number }>
  /** Fila que mantém a ordem da codificação base64. */
  encodeQueue: Promise<void>
  chunks: number
  bytes: number
  lastMetaJson: string
  lastMetaAt: number
  lastDiagAt: number
  notInCallSince: number | null
  lastSpeechAt: number | null
  /** Períodos em espera (Teams 4/5): continua gravando (silêncio) e marca o período. */
  holds: HoldPeriod[]
  /** Emenda 18: linha do tempo dos falantes (criada quando o gravador começa). */
  speakers: Timeline | null
  lastSpeakersAt: number
  /** Último `aliases` mandado (só manda de novo quando muda). */
  aliasesJson: string
  /** O áudio dos outros (seam selecionado, ao vivo) tinha fala na última medida; null: não se sabe. */
  remoteSpeech: boolean | null
}

function randomId(): string {
  const a = new Uint8Array(8)
  crypto.getRandomValues(a)
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('')
}

export function startSessionController(deps: SessionDeps): SessionController {
  const { orig, log, adapter, registry, seams, bridge } = deps
  // Relógio resistente (Emenda 12): no Teams logado o setInterval criado aqui no document_start
  // morre quando a página carrega; as mutações do DOM e os chunks do gravador religam o laço.
  const relogio = criarRelogio({
    setInterval: orig.setInterval,
    clearInterval: (id) => orig.clearInterval(id as number),
    setTimeout: orig.setTimeout,
    clearTimeout: (id) => orig.clearTimeout(id as number),
    now: orig.now,
    MutationObserver: orig.MutationObserver,
    doc: orig.win.document,
    log,
  })
  let state: SessionState = 'idle'
  let lastLogged = ''
  /** Loga a mudança de estado e os sinais (só quando mudam), em nível debug. */
  const trace = (probe: Probe | null, inCall: boolean) => {
    const line = `${state} emCall=${inCall} pcs=${probe?.pcsOpen ?? '-'} conectados=${probe?.pcsConnected ?? '-'} audioVivo=${probe?.connectedWithLiveAudio ?? '-'} permitido=${allowed}`
    if (line !== lastLogged) log(line)
    lastLogged = line
  }
  let candidateSince = 0
  let active: Active | null = null
  let allowed = true
  let helloSent = false

  const sendHello = () => {
    if (helloSent) return
    helloSent = true
    bridge.send({
      t: 'hello',
      frameUrl: location.href,
      isTop: window.top === window,
      platform: adapter.id,
      hookVersion: HOOK_VERSION,
      hookedAt: orig.now(),
    })
  }

  const readMeta = (): Partial<CallMeta> => {
    try {
      return adapter.readMeta()
    } catch (e) {
      log('readMeta', e)
      return { url: location.href }
    }
  }

  // --- Down -----------------------------------------------------------------------------------
  bridge.onDown((msg: Down) => {
    try {
      switch (msg.t) {
        case 'settings':
          allowed = adapter.id === 'meet' ? msg.autoMeet : msg.autoTeams
          break
        case 'session:accepted':
          if (active && active.localId === msg.localId && !active.sessionId) {
            active.sessionId = msg.sessionId
            for (const c of active.pending.splice(0)) bridge.send({ t: 'session:chunk', sessionId: msg.sessionId, ...c })
          }
          break
        case 'session:rejected':
          if (active && active.localId === msg.localId) {
            log('sessão recusada pelo SW:', msg.reason)
            teardown()
            state = 'rejected'
          }
          break
        case 'session:stop':
          if (active && active.sessionId === msg.sessionId) void finish('parado-pelo-usuario')
          break
        case 'chunk:ack':
          // Os acks são do relay (ele guarda os chunks sem confirmação); nada a fazer aqui.
          break
      }
    } catch (e) {
      log('onDown', e)
    }
  })

  // --- Gravação -------------------------------------------------------------------------------
  const onChunk = (c: RecorderChunk) => {
    // O chunk (a cada 5 s, pelo MediaRecorder, que a página não cancela) também confere o relógio.
    relogio.kick()
    const a = active
    if (!a) return
    a.chunks++
    a.bytes += c.blob.size
    a.encodeQueue = a.encodeQueue
      .then(async () => {
        const data = await blobToBase64(c.blob)
        const item = { seq: c.seq, data, bytes: c.blob.size, at: c.at }
        if (a.sessionId) bridge.send({ t: 'session:chunk', sessionId: a.sessionId, ...item })
        else a.pending.push(item)
      })
      .catch((e) => log('codificar chunk', e))
  }

  const syncSources = (a: Active) => {
    for (const seam of seams.all) {
      try {
        a.mixer.sync(seam.id, seam.sources())
      } catch (e) {
        log('sync seam', seam.id, e)
      }
    }
  }

  // Fonte nova num seam (evento 'track', srcObject, createMediaStreamSource...): sincroniza o
  // mixer já, sem esperar o polling de 1 s. Fora da pilha da página (setTimeout 0) e agrupado.
  let syncQueued = false
  seams.onChange(() => {
    if (syncQueued || !active) return
    syncQueued = true
    orig.setTimeout(() => {
      syncQueued = false
      const a = active
      if (a && state === 'recording') syncSources(a)
    }, 0)
  })

  const arbTick = () => {
    const a = active
    if (!a) return
    try {
      if (a.arbTicks++ % SYNC_EVERY_TICKS === 0) syncSources(a)
      const now = orig.now()
      const measures = a.mixer.measure()
      const r = arbitrate(a.arb, measures, now)
      a.arb = r.state
      if (r.change) {
        a.mixer.select(r.change.to)
        log('seam', r.change.from, '->', r.change.to)
      }
      a.remoteSpeech = a.arb.selected ? hasSpeech(measures[a.arb.selected]) : null
      if (a.remoteSpeech) a.lastSpeechAt = now
    } catch (e) {
      a.remoteSpeech = null
      log('arbitragem', e)
    }
    sampleSpeakers(a)
  }

  // --- Falantes (Emenda 18) -------------------------------------------------------------------
  const speakerProbe = (a: Active, now: number): SpeakerProbe => ({
    now,
    contributingSources: () => registry.contributingSources(),
    ...(a.remoteSpeech === null ? {} : { remoteSpeech: a.remoteSpeech }),
  })

  /** Quem fala agora (adaptador) e se você fala (microfone), no mesmo laço de 250 ms. */
  const sampleSpeakers = (a: Active) => {
    const tl = a.speakers
    if (!tl || state !== 'recording') return
    const now = orig.now()
    let reading: SpeakerReading | null = null
    try {
      reading = adapter.readSpeakers?.(speakerProbe(a, now)) ?? null
    } catch (e) {
      log('falantes', e)
    }
    try {
      tl.sample(now, reading)
    } catch (e) {
      log('linha do tempo', e)
    }
    try {
      tl.sampleSelf(now, a.mixer.measureMic(registry.localMicTracks()) > MIC_SPEECH_DBFS)
    } catch (e) {
      log('microfone', e)
    }
  }

  const readAliases = (): Record<string, string> => {
    try {
      return adapter.speakerAliases?.() ?? {}
    } catch (e) {
      log('aliases', e)
      return {}
    }
  }

  const readDiagnostics = (): SpeakerDiagnostics | null => {
    try {
      return adapter.speakerDiagnostics?.() ?? null
    } catch (e) {
      log('diagnóstico dos falantes', e)
      return null
    }
  }

  /** Manda os intervalos que mudaram (ou, com `full`, todos a partir do 0, no fim). */
  const sendSpeakers = (a: Active, full = false) => {
    const tl = a.speakers
    if (!a.sessionId || !tl) return
    const now = orig.now()
    const aliases = readAliases()
    const aliasesJson = JSON.stringify(aliases)
    const aliasesChanged = aliasesJson !== a.aliasesJson
    // batch() sempre, para o próximo lote começar do ponto certo também depois de um `full`.
    let b = tl.batch(now)
    if (full) b = { from: 0, intervals: tl.all(now) }
    if (!b && !aliasesChanged) return
    a.aliasesJson = aliasesJson
    // Emenda 20: o diagnóstico só no lote final (a linha inteira), que é o que chega ao arquivo.
    const diagnostico = full ? readDiagnostics() : null
    bridge.send({
      t: 'session:speakers',
      sessionId: a.sessionId,
      from: b?.from ?? tl.size,
      intervals: b?.intervals ?? [],
      ...(Object.keys(aliases).length ? { aliases } : {}),
      ...(diagnostico ? { diagnostico } : {}),
    })
  }

  const begin = () => {
    const mixer = createMixer(orig, log)
    if (!mixer) {
      state = 'rejected'
      return
    }
    const a: Active = {
      localId: randomId(),
      sessionId: null,
      startedAt: 0,
      mixer,
      recorder: null as unknown as Recorder,
      arb: initialArbitration(adapter.seamPriority),
      arbTask: { stop() {} },
      arbTicks: 0,
      pending: [],
      encodeQueue: Promise.resolve(),
      chunks: 0,
      bytes: 0,
      lastMetaJson: '',
      lastMetaAt: 0,
      lastDiagAt: 0,
      notInCallSince: null,
      lastSpeechAt: null,
      holds: [],
      speakers: null,
      lastSpeakersAt: 0,
      aliasesJson: '{}',
      remoteSpeech: null,
    }
    active = a
    const recorder = createRecorder(orig, mixer.stream, onChunk, log)
    if (!recorder) {
      mixer.close()
      active = null
      state = 'rejected'
      return
    }
    a.recorder = recorder
    syncSources(a)
    arbTick()
    recorder.start()
    a.startedAt = orig.now()
    a.speakers = createTimeline({ startedAt: a.startedAt, delayMs: MIXER_DELAY_MS, maxIntervals: MAX_SPEAKER_INTERVALS })
    a.lastSpeakersAt = a.startedAt
    a.arbTask = relogio.every(ARBITRATION_TICK_MS, arbTick)
    state = 'recording'
    sendHello()
    const meta = readMeta()
    a.lastMetaJson = JSON.stringify(meta)
    a.lastMetaAt = a.startedAt
    a.lastDiagAt = a.startedAt
    bridge.send({ t: 'session:start', localId: a.localId, platform: adapter.id, startedAt: a.startedAt, meta })
    log('gravando', a.localId)
  }

  const teardown = () => {
    const a = active
    if (!a) return
    a.arbTask.stop()
    try {
      void a.recorder?.stop()
    } catch {
      // nada
    }
    a.mixer.close()
    active = null
  }

  const waitAccepted = async (a: Active) => {
    const t0 = orig.now()
    while (!a.sessionId && state !== 'rejected' && orig.now() - t0 < ACCEPT_WAIT_MS) {
      await relogio.sleep(100)
    }
  }

  const finish = async (reason: EndReason) => {
    const a = active
    if (!a || state !== 'recording') return
    state = 'finishing'
    log('fim', reason)
    // Emenda 18: os sinais ao vivo depois deste instante cairiam depois do fim do áudio gravado
    // (o gravador ainda grava o atraso do mixer): a linha do tempo fecha aqui.
    try {
      a.speakers?.closeAll(orig.now())
    } catch (e) {
      log('fechar falantes', e)
    }
    try {
      // O seletor fica depois do atraso: espera o atraso para não cortar a última fala.
      await relogio.sleep(DELAY_SEC * 1000)
      a.arbTask.stop()
      const lastSeq = await a.recorder.stop()
      const endedAt = orig.now()
      await a.encodeQueue
      await waitAccepted(a)
      if (a.sessionId) {
        // ARQUITETURA, Meet: o título é relido "de novo no fim". Vale para os dois adaptadores:
        // eles só implementam readMeta(), e quem decide quando ler é este controlador. Fora da URL
        // de call (a SPA navegou) a página já é outra: vale a última leitura feita na call, senão
        // o código, a URL e o título da aba do info.json viravam os da página nova.
        if (adapter.matchesUrl(location)) sendMetaIfChanged(a)
        sendDiag(a)
        // A linha inteira no fim: um lote perdido (SW que reiniciou no meio) é refeito aqui.
        sendSpeakers(a, true)
        bridge.send({ t: 'session:end', sessionId: a.sessionId, endedAt, reason, lastSeq })
      }
    } catch (e) {
      log('finish', e)
    } finally {
      a.mixer.close()
      if (active === a) active = null
      state = 'done'
    }
  }

  /** Relê os metadados e manda session:meta se mudaram desde o último envio. */
  const sendMetaIfChanged = (a: Active) => {
    if (!a.sessionId) return
    const meta = readMeta()
    const json = JSON.stringify(meta)
    if (json === a.lastMetaJson) return
    a.lastMetaJson = json
    bridge.send({ t: 'session:meta', sessionId: a.sessionId, meta })
  }

  const sendDiag = (a: Active) => {
    if (!a.sessionId) return
    const m = a.mixer.measure()
    const now = orig.now()
    const seamsDiag = {} as Record<SeamId, SeamDiag>
    for (const id of SEAM_IDS) {
      const at = a.arb.lastSpeechAt[id]
      seamsDiag[id] = { sources: m[id].sources, dbfs: Math.round(m[id].dbfs * 10) / 10, speech: at !== null && now - at <= 1000 }
    }
    const probe = registry.probe()
    const diag: CaptureDiag = {
      at: now,
      ctxState: a.mixer.ctxState(),
      initial: a.arb.initial,
      selected: a.arb.selected,
      switches: a.arb.switches,
      seams: seamsDiag,
      pcs: { open: probe.pcsOpen, connected: probe.pcsConnected },
      remoteAudioTracks: probe.liveRemoteAudioTracks,
      primed: seams.primedCount(),
      chunks: a.chunks,
      bytes: a.bytes,
      everHadSpeech: a.arb.everHadSpeech,
      silentForMs: a.lastSpeechAt === null ? null : now - a.lastSpeechAt,
      recorderState: a.recorder.state,
      holds: a.holds,
    }
    bridge.send({ t: 'session:diag', sessionId: a.sessionId, diag })
  }

  // --- Laço de 1 s ----------------------------------------------------------------------------
  const tick = () => {
    try {
      // O hello do DOMContentLoaded sai por um setTimeout que a página pode ter cancelado.
      if (!helloSent) sendHello()
      const urlOk = adapter.matchesUrl(location)
      if (state === 'recording' && active) {
        if (!urlOk) return void finish('navegou')
        const probe: Probe = registry.probe()
        const end = adapter.endSignal(probe)
        if (end) return void finish(end)
        const now = probe.now
        const onHold = adapter.isOnHold?.(probe) ?? false
        const openHold = active.holds.at(-1)?.to === null ? active.holds.at(-1)! : null
        if (onHold && !openHold) active.holds.push({ from: now, to: null })
        if (!onHold && openHold) openHold.to = now
        // Em espera a call não está "conectada", mas não acabou: não conta para o fim por ausência.
        // Já gravando vale o stillInCall do adaptador, mais frouxo que o do começo (Emenda 10).
        const inCall = onHold || (adapter.stillInCall ? adapter.stillInCall(probe) : adapter.isInCall(probe))
        if (inCall) active.notInCallSince = null
        else {
          active.notInCallSince ??= now
          if (now - active.notInCallSince >= NOT_IN_CALL_END_MS) return void finish('fora-da-call')
        }
        if (now - active.lastMetaAt >= META_EVERY_MS && active.sessionId) {
          active.lastMetaAt = now
          sendMetaIfChanged(active)
        }
        if (now - active.lastDiagAt >= DIAG_EVERY_MS) {
          active.lastDiagAt = now
          sendDiag(active)
        }
        if (now - active.lastSpeakersAt >= SPEAKERS_EVERY_MS) {
          active.lastSpeakersAt = now
          sendSpeakers(active)
        }
        return
      }
      if (state === 'finishing') return
      if (!urlOk) {
        if (state !== 'idle') state = 'idle'
        return
      }
      const probe = registry.probe()
      const inCall = adapter.isInCall(probe)
      trace(probe, inCall)
      if (state === 'done' || state === 'rejected') {
        if (!inCall) state = 'idle'
        return
      }
      if (state === 'idle') {
        if (inCall && allowed) {
          state = 'candidate'
          candidateSince = probe.now
        }
        return
      }
      if (state === 'candidate') {
        if (!inCall || !allowed) state = 'idle'
        else if (probe.now - candidateSince >= STABLE_MS) begin()
      }
    } catch (e) {
      log('tick', e)
    }
  }
  const tickTask = relogio.every(TICK_MS, tick)

  // pagehide: não dá para esperar o último dataavailable; avisa o fim com o que já saiu.
  orig.addEventListener.call(orig.win, 'pagehide', () => {
    try {
      const a = active
      if (!a || (state !== 'recording' && state !== 'finishing')) return
      a.recorder.requestData()
      try {
        // O gravador para agora, sem gravar o atraso do mixer: o áudio acaba em agora - startedAt, e
        // a linha do tempo não passa disso (o que começou ao vivo no último 1,5 s não está no áudio).
        // Depois, a linha inteira: depois do pagehide não há outro lote para refazer um que se perdeu.
        const now = orig.now()
        a.speakers?.closeAll(now, now - a.startedAt)
        sendSpeakers(a, true)
      } catch (e) {
        log('falantes no pagehide', e)
      }
      if (a.sessionId) {
        bridge.send({ t: 'session:end', sessionId: a.sessionId, endedAt: orig.now(), reason: 'pagehide', lastSeq: a.recorder.lastSeq })
      }
    } catch (e) {
      log('pagehide', e)
    }
  })

  // O hello também sai logo que a página carrega (o relay já está ouvindo no document_start).
  const helloSoon = () => orig.setTimeout(sendHello, 0)
  if (document.readyState === 'loading') orig.addEventListener.call(orig.win, 'DOMContentLoaded', helloSoon, { once: true })
  else helloSoon()

  return {
    get state() {
      return state
    },
    dispose() {
      tickTask.stop()
      teardown()
      relogio.dispose()
    },
  }
}
