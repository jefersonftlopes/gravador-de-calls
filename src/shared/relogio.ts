// Relógio resistente (Emenda 12).
//
// Medido numa call real do Teams logado (07/10/2026, 0.1.1): o setInterval que a extensão cria no
// document_start rodou uma vez e morreu quando o Teams carregou, e a detecção nunca viu a call.
// Um timer criado no meio da call, pelo console, funcionou. Num experimento no Chrome for Testing,
// uma página que cancela todos os timers por força bruta mata os da extensão nos dois mundos (MAIN
// e ISOLATED): os timers são da janela, e a página pode cancelar qualquer id.
//
// Por isso cada tarefa tem duas fontes de tempo:
//  - o setInterval/setTimeout de sempre (o caminho normal);
//  - um MutationObserver no documento: a página da call muda o DOM o tempo todo (relógio da call,
//    blocos de vídeo, botões), e um callback de mutação não é cancelável por clearInterval. A cada
//    lote de mutações (no máximo um a cada KICK_MIN_MS) o relógio confere as tarefas: a periódica
//    atrasada roda na hora e ganha um timer novo; a de uma vez vencida dispara.
// kick() faz a mesma conferência a partir de outra fonte (ex.: o chunk do gravador, a cada 5 s).
//
// Sem dependência do chrome.* nem de globais: o MAIN world passa os originais capturados no
// document_start (a página pode trocar os dela depois); o mundo isolado passa os seus.

export interface RelogioDeps {
  setInterval: (fn: () => void, ms: number) => unknown
  clearInterval: (id: unknown) => void
  setTimeout: (fn: () => void, ms: number) => unknown
  clearTimeout: (id: unknown) => void
  now: () => number
  /** Construtor do MutationObserver (sem ele, só os timers). */
  MutationObserver?: typeof MutationObserver
  /** Nó observado (o document). */
  doc?: Node
  log?: (...a: unknown[]) => void
}

export interface Tarefa {
  stop(): void
}

export interface Relogio {
  /** Roda `fn` a cada `ms`, sobrevivendo ao cancelamento do timer pela página. */
  every(ms: number, fn: () => void): Tarefa
  /** Roda `fn` uma vez depois de `ms` (pelo timer ou, se ele sumir, pela conferência). */
  after(ms: number, fn: () => void): Tarefa
  sleep(ms: number): Promise<void>
  /** Confere as tarefas agora (fonte de tempo que não é timer). */
  kick(): void
  /** Quantas vezes um timer periódico foi recriado porque a página o cancelou. */
  readonly religados: number
  dispose(): void
}

/** Intervalo mínimo entre duas conferências disparadas por mutação ou kick. */
export const KICK_MIN_MS = 250
/**
 * Atraso a partir do qual a periódica conta como morta: 3 períodos, nunca menos de 3 s (aba em
 * segundo plano alinha os timers a 1 s, e isso não é timer cancelado).
 */
export function prazoDeMorte(ms: number): number {
  return Math.max(ms * 3, 3000)
}

interface Periodica {
  ms: number
  fn: () => void
  id: unknown
  ultima: number
  parada: boolean
}

interface Unica {
  vence: number
  fn: () => void
  id: unknown
  feita: boolean
}

export function criarRelogio(deps: RelogioDeps): Relogio {
  const log = deps.log ?? (() => {})
  const periodicas = new Set<Periodica>()
  const unicas = new Set<Unica>()
  let religados = 0
  let ultimoKick = Number.NEGATIVE_INFINITY
  let observer: MutationObserver | null = null

  const rodar = (p: Periodica) => {
    if (p.parada) return
    p.ultima = deps.now()
    try {
      p.fn()
    } catch (e) {
      log('relógio: tarefa', e)
    }
  }
  const armar = (p: Periodica) => {
    p.id = deps.setInterval(() => rodar(p), p.ms)
  }
  const disparar = (u: Unica) => {
    if (u.feita) return
    u.feita = true
    unicas.delete(u)
    try {
      deps.clearTimeout(u.id)
    } catch {
      // nada
    }
    try {
      u.fn()
    } catch (e) {
      log('relógio: tarefa', e)
    }
  }

  const conferir = () => {
    const agora = deps.now()
    for (const p of periodicas) {
      if (p.parada || agora - p.ultima < prazoDeMorte(p.ms)) continue
      // Deveria ter rodado e não rodou: a página cancelou o timer. Outro id, e roda já.
      try {
        deps.clearInterval(p.id)
      } catch {
        // nada
      }
      armar(p)
      religados++
      log('relógio da página parou; tarefa religada', `${p.ms} ms`, `(${religados})`)
      rodar(p)
    }
    for (const u of [...unicas]) if (agora >= u.vence) disparar(u)
  }

  const kick = () => {
    const agora = deps.now()
    if (agora - ultimoKick < KICK_MIN_MS) return
    ultimoKick = agora
    conferir()
  }

  try {
    if (deps.MutationObserver && deps.doc) {
      observer = new deps.MutationObserver(() => kick())
      observer.observe(deps.doc, { childList: true, subtree: true, characterData: true })
    }
  } catch (e) {
    observer = null
    log('relógio: sem MutationObserver', e)
  }

  const every = (ms: number, fn: () => void): Tarefa => {
    const p: Periodica = { ms, fn, id: undefined, ultima: deps.now(), parada: false }
    periodicas.add(p)
    armar(p)
    return {
      stop() {
        p.parada = true
        periodicas.delete(p)
        try {
          deps.clearInterval(p.id)
        } catch {
          // nada
        }
      },
    }
  }

  const after = (ms: number, fn: () => void): Tarefa => {
    const u: Unica = { vence: deps.now() + ms, fn, id: undefined, feita: false }
    unicas.add(u)
    u.id = deps.setTimeout(() => disparar(u), ms)
    return {
      stop() {
        u.feita = true
        unicas.delete(u)
        try {
          deps.clearTimeout(u.id)
        } catch {
          // nada
        }
      },
    }
  }

  return {
    every,
    after,
    sleep: (ms) => new Promise<void>((resolve) => void after(ms, resolve)),
    kick,
    get religados() {
      return religados
    },
    dispose() {
      try {
        observer?.disconnect()
      } catch {
        // nada
      }
      observer = null
      for (const p of [...periodicas]) {
        p.parada = true
        try {
          deps.clearInterval(p.id)
        } catch {
          // nada
        }
      }
      periodicas.clear()
      for (const u of [...unicas]) {
        u.feita = true
        try {
          deps.clearTimeout(u.id)
        } catch {
          // nada
        }
      }
      unicas.clear()
    },
  }
}
