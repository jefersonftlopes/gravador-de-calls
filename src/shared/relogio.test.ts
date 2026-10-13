// Relógio resistente (Emenda 12): a página cancela os timers da extensão (o Teams logado faz isso
// ao carregar) e as tarefas continuam, puxadas pelas mutações do DOM.
import { describe, expect, it } from 'vitest'
import { KICK_MIN_MS, criarRelogio, prazoDeMorte } from './relogio'

/** Timers falsos com relógio manual e um "cancelar tudo" como o da página. */
function ambiente() {
  let agora = 0
  let proximoId = 1
  const timers = new Map<number, { fn: () => void; ms: number; quando: number; repete: boolean }>()
  let mutacao: (() => void) | null = null
  const deps = {
    now: () => agora,
    setInterval: (fn: () => void, ms: number) => {
      const id = proximoId++
      timers.set(id, { fn, ms, quando: agora + ms, repete: true })
      return id
    },
    setTimeout: (fn: () => void, ms: number) => {
      const id = proximoId++
      timers.set(id, { fn, ms, quando: agora + ms, repete: false })
      return id
    },
    clearInterval: (id: unknown) => void timers.delete(id as number),
    clearTimeout: (id: unknown) => void timers.delete(id as number),
    MutationObserver: class {
      constructor(cb: () => void) {
        mutacao = cb
      }
      observe() {}
      disconnect() {
        mutacao = null
      }
    } as unknown as typeof MutationObserver,
    doc: {} as Node,
  }
  const avancar = (ms: number) => {
    const fim = agora + ms
    for (;;) {
      let prox: [number, { fn: () => void; ms: number; quando: number; repete: boolean }] | null = null
      for (const e of timers) if (e[1].quando <= fim && (!prox || e[1].quando < prox[1].quando)) prox = e
      if (!prox) break
      const [id, t] = prox
      agora = t.quando
      if (t.repete) t.quando += t.ms
      else timers.delete(id)
      t.fn()
    }
    agora = fim
  }
  return {
    deps,
    avancar,
    /** A página cancela todos os timers (força bruta). */
    cancelarTudo: () => timers.clear(),
    mutar: () => mutacao?.(),
    get timers() {
      return timers.size
    },
  }
}

describe('relógio resistente', () => {
  it('periódica normal: roda pelo timer', () => {
    const amb = ambiente()
    const r = criarRelogio(amb.deps)
    let n = 0
    r.every(1000, () => n++)
    amb.avancar(3500)
    expect(n).toBe(3)
    expect(r.religados).toBe(0)
  })

  it('a página cancela os timers: a primeira mutação depois do prazo religa e roda, e o timer novo segue sozinho', () => {
    const amb = ambiente()
    const r = criarRelogio(amb.deps)
    let n = 0
    r.every(1000, () => n++)
    amb.avancar(1000)
    expect(n).toBe(1)
    amb.cancelarTudo()
    amb.avancar(10_000)
    expect(n, 'sem timer e sem mutação, nada roda').toBe(1)
    amb.mutar()
    expect(n).toBe(2)
    expect(r.religados).toBe(1)
    amb.avancar(3000)
    expect(n, 'o timer novo voltou a rodar').toBe(5)
  })

  it('mutação antes do prazo de morte não religa (a tarefa só está entre dois ticks)', () => {
    const amb = ambiente()
    const r = criarRelogio(amb.deps)
    let n = 0
    r.every(1000, () => n++)
    amb.avancar(500)
    amb.mutar()
    expect(n).toBe(0)
    expect(r.religados).toBe(0)
    expect(prazoDeMorte(1000)).toBe(3000)
    expect(prazoDeMorte(250)).toBe(3000)
  })

  it('kick tem limite de frequência: dentro de KICK_MIN_MS a conferência é ignorada', () => {
    const amb = ambiente()
    const r = criarRelogio(amb.deps)
    r.kick()
    let feito = 0
    r.after(50, () => feito++)
    amb.cancelarTudo()
    amb.avancar(100)
    r.kick()
    expect(feito, `menos de ${KICK_MIN_MS} ms desde o último kick`).toBe(0)
    amb.avancar(KICK_MIN_MS)
    r.kick()
    expect(feito).toBe(1)
  })

  it('after e sleep vencem pela conferência quando o timer some', async () => {
    const amb = ambiente()
    const r = criarRelogio(amb.deps)
    let feito = 0
    r.after(2000, () => feito++)
    let acordou = false
    void r.sleep(2000).then(() => (acordou = true))
    amb.cancelarTudo()
    amb.avancar(2500)
    expect(feito).toBe(0)
    amb.mutar()
    await Promise.resolve()
    expect(feito).toBe(1)
    expect(acordou).toBe(true)
    // Uma vez só, mesmo com outra conferência depois.
    amb.avancar(1000)
    amb.mutar()
    expect(feito).toBe(1)
  })

  it('stop e dispose param tudo e não deixam timer', () => {
    const amb = ambiente()
    const r = criarRelogio(amb.deps)
    let n = 0
    const t = r.every(1000, () => n++)
    r.after(500, () => n++)
    t.stop()
    r.dispose()
    amb.avancar(5000)
    amb.mutar()
    expect(n).toBe(0)
    expect(amb.timers).toBe(0)
  })

  it('erro numa tarefa não derruba o relógio', () => {
    const amb = ambiente()
    const erros: unknown[] = []
    const r = criarRelogio({ ...amb.deps, log: (...a: unknown[]) => erros.push(a) })
    let n = 0
    r.every(1000, () => {
      n++
      throw new Error('falhou')
    })
    amb.avancar(2000)
    expect(n).toBe(2)
    expect(erros.length).toBe(2)
  })
})
