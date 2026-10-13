// Protocolo do helper: framing stdio, raiz no config.json, ordem do append, dono por sessão,
// finalize com reserva sem corrida (dois processos), merge e info.json por último.
// O helper roda como processo de verdade (o mesmo que o Chrome abre).
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { fakeTranscriptionConfig, FAKE_TEXT, makeFakeTools } from '../helpers/fake-transcricao'
// @ts-expect-error módulo .mjs sem tipos
import { enqueueTranscription } from '../../host/transcricao.mjs'
// @ts-expect-error módulo .mjs sem tipos
import { acceptedExtras, MAX_EXTRA_BYTES } from '../../host/gravador-host.mjs'

const HOST = resolve(dirname(fileURLToPath(import.meta.url)), '../../host/gravador-host.mjs')

class HostClient {
  private child: ChildProcessWithoutNullStreams
  private buf = Buffer.alloc(0)
  readonly waiting = new Map<number, (v: Record<string, any>) => void>()
  private nextId = 1

  constructor(configFile: string, env: Record<string, string> = {}, { detached = false } = {}) {
    this.child = spawn(process.execPath, [HOST, 'chrome-extension://teste/'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, GRAVADOR_CONFIG: configFile, ...env },
      // detached: grupo de processos próprio, para o teste matar o helper como o Chrome mata.
      detached,
    })
    this.child.stdout.on('data', (d: Buffer) => {
      this.buf = Buffer.concat([this.buf, d])
      while (this.buf.length >= 4) {
        const len = this.buf.readUInt32LE(0)
        if (this.buf.length < 4 + len) break
        const msg = JSON.parse(this.buf.subarray(4, 4 + len).toString('utf8'))
        this.buf = this.buf.subarray(4 + len)
        this.waiting.get(msg.id)?.(msg)
        this.waiting.delete(msg.id)
      }
    })
  }

  writeRaw(b: Buffer) {
    this.child.stdin.write(b)
  }

  frame(obj: unknown): Buffer {
    const json = Buffer.from(JSON.stringify(obj))
    const head = Buffer.alloc(4)
    head.writeUInt32LE(json.length, 0)
    return Buffer.concat([head, json])
  }

  call(req: Record<string, unknown>): Promise<Record<string, any>> {
    const id = this.nextId++
    return new Promise((res) => {
      this.waiting.set(id, res)
      this.writeRaw(this.frame({ id, ...req }))
    })
  }

  close() {
    this.child.stdin.end()
  }

  get pid(): number {
    return this.child.pid as number
  }

  exited(): Promise<void> {
    return this.child.exitCode !== null || this.child.signalCode !== null ? Promise.resolve() : new Promise((r) => this.child.once('exit', () => r()))
  }
}

let base: string
let root: string
let config: string
let host: HostClient
const b64 = (s: string) => Buffer.from(s).toString('base64')
const OWNER_A = 'perfil-a'
const OWNER_B = 'perfil-b'

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'gravador-host-'))
  root = join(base, 'Gravações de calls')
  config = join(base, 'config', 'config.json')
  // Transcrição desligada nestes testes (a padrão é ligada e descobriria o whisper e o modelo de
  // verdade desta máquina); os da transcrição têm o bloco próprio lá embaixo.
  mkdirSync(dirname(config), { recursive: true })
  writeFileSync(config, JSON.stringify({ transcricao: { ativa: false } }))
  host = new HostClient(config)
})
afterAll(() => {
  host.close()
  rmSync(base, { recursive: true, force: true })
})

describe('gravador-host', () => {
  it('responde ao ping com a versão e a raiz padrão quando o config.json não tem raiz', async () => {
    const r = await host.call({ op: 'ping' })
    expect(r).toMatchObject({ ok: true, version: '0.5.0', configPath: config })
    expect(r.root.endsWith(join('Documents', 'Gravações de calls'))).toBe(true)
  })

  it('aceita frames partidos e vários frames num write só', async () => {
    const both = Buffer.concat([host.frame({ id: 900, op: 'ping' }), host.frame({ id: 901, op: 'ping' })])
    const p1 = new Promise((res) => host.waiting.set(900, res))
    const p2 = new Promise((res) => host.waiting.set(901, res))
    host.writeRaw(both.subarray(0, 3))
    await new Promise((r) => setTimeout(r, 20))
    host.writeRaw(both.subarray(3))
    expect(await p1).toMatchObject({ id: 900, ok: true })
    expect(await p2).toMatchObject({ id: 901, ok: true })
  })

  it('recusa operação desconhecida', async () => {
    expect((await host.call({ op: 'formatar-disco' })).ok).toBe(false)
  })

  it('set-root valida, cria e grava no config.json; get-config e ping passam a usar', async () => {
    const r = await host.call({ op: 'set-root', path: root })
    expect(r).toMatchObject({ ok: true, root })
    expect(statSync(root).isDirectory()).toBe(true)
    expect(JSON.parse(readFileSync(config, 'utf8')).root).toBe(root)
    expect(await host.call({ op: 'get-config' })).toMatchObject({ ok: true, root, configPath: config })
    expect(await host.call({ op: 'ping' })).toMatchObject({ ok: true, root, writable: true })
  })

  it('check-root só valida (não muda a raiz)', async () => {
    const other = join(base, 'outra')
    expect(await host.call({ op: 'check-root', path: other })).toMatchObject({ ok: true, root: other, writable: true })
    expect((await host.call({ op: 'get-config' })).root).toBe(root)
    expect((await host.call({ op: 'check-root', path: 'relativo/sem/til' })).ok).toBe(false)
  })

  it('append exige ordem estrita e devolve o esperado', async () => {
    expect((await host.call({ op: 'begin', sessionId: 's1', owner: OWNER_A })).ok).toBe(true)
    let r = await host.call({ op: 'append', sessionId: 's1', file: 'audio.webm', seq: 1, data: b64('B') })
    expect(r).toMatchObject({ ok: false, expected: 0 })
    r = await host.call({ op: 'append', sessionId: 's1', file: 'audio.webm', seq: 0, data: b64('AAA') })
    expect(r).toMatchObject({ ok: true, nextSeq: 1, bytes: 3 })
    // Reenvio do mesmo seq (ack perdido): recusado com o esperado, sem duplicar bytes.
    r = await host.call({ op: 'append', sessionId: 's1', file: 'audio.webm', seq: 0, data: b64('AAA') })
    expect(r).toMatchObject({ ok: false, expected: 1 })
    r = await host.call({ op: 'append', sessionId: 's1', file: 'audio.webm', seq: 1, data: b64('BB') })
    expect(r).toMatchObject({ ok: true, nextSeq: 2, bytes: 5 })
    expect(readFileSync(join(root, '.gravando', 's1', 'audio.webm.part'), 'utf8')).toBe('AAABB')
  })

  it('list-staging só mostra as sessões do próprio dono, com o dono do owner.json e as datas', async () => {
    const t0 = Date.now()
    await host.call({ op: 'begin', sessionId: 's-de-b', owner: OWNER_B })
    const a = await host.call({ op: 'list-staging', owner: OWNER_A })
    expect(a.sessions).toEqual([
      { sessionId: 's1', owner: OWNER_A, files: [{ file: 'audio.webm', bytes: 5, nextSeq: 2 }], createdAt: expect.any(Number), updatedAt: expect.any(Number) },
    ])
    // updatedAt é o último mtime do staging (o último append), nunca antes do owner.json.
    const partMtime = statSync(join(root, '.gravando', 's1', 'audio.webm.part')).mtimeMs
    expect(a.sessions[0].updatedAt).toBeGreaterThanOrEqual(Math.floor(partMtime) - 1)
    expect(a.sessions[0].updatedAt).toBeGreaterThanOrEqual(a.sessions[0].createdAt)
    const b = await host.call({ op: 'list-staging', owner: OWNER_B })
    expect(b.sessions.map((x: { sessionId: string; owner: string }) => [x.sessionId, x.owner])).toEqual([['s-de-b', OWNER_B]])
    expect(b.sessions[0].files).toEqual([])
    expect(b.sessions[0].createdAt).toBeGreaterThanOrEqual(t0 - 1000)
    // Dono que não existe: nada.
    expect((await host.call({ op: 'list-staging', owner: 'perfil-c' })).sessions).toEqual([])
    await host.call({ op: 'discard', sessionId: 's-de-b' })
  })

  it('trocar a raiz no meio não perde a sessão aberta', async () => {
    await host.call({ op: 'begin', sessionId: 's-velha', owner: OWNER_A })
    await host.call({ op: 'append', sessionId: 's-velha', file: 'audio.webm', seq: 0, data: b64('V') })
    const nova = join(base, 'raiz-nova')
    await host.call({ op: 'set-root', path: nova })
    const r = await host.call({ op: 'append', sessionId: 's-velha', file: 'audio.webm', seq: 1, data: b64('W') })
    expect(r).toMatchObject({ ok: true, bytes: 2 })
    const f = await host.call({ op: 'finalize', sessionId: 's-velha', relDir: '2026-10/velha (Meet)', info: {} })
    // A gravação termina na raiz em que começou.
    expect(f.path).toBe(join(root, '2026-10', 'velha (Meet)'))
    await host.call({ op: 'set-root', path: root })
  })

  it('append trunca lixo deixado por uma queda entre o write e o sidecar', async () => {
    await host.call({ op: 'begin', sessionId: 's-queda', owner: OWNER_A })
    await host.call({ op: 'append', sessionId: 's-queda', file: 'audio.webm', seq: 0, data: b64('12') })
    const part = join(root, '.gravando', 's-queda', 'audio.webm.part')
    appendFileSync(part, 'LIXO')
    const r = await host.call({ op: 'append', sessionId: 's-queda', file: 'audio.webm', seq: 1, data: b64('34') })
    expect(r).toMatchObject({ ok: true, bytes: 4 })
    expect(readFileSync(part, 'utf8')).toBe('1234')
    await host.call({ op: 'discard', sessionId: 's-queda' })
  })

  it('finalize move os arquivos, renomeia o .part e escreve info.json por último', async () => {
    const relDir = '2026-10/2026-10-06 14h30 - Daily (Meet)'
    const r = await host.call({ op: 'finalize', sessionId: 's1', relDir, info: { titulo: 'Daily' } })
    expect(r.ok).toBe(true)
    const dir = join(root, '2026-10', '2026-10-06 14h30 - Daily (Meet)')
    expect(r.path).toBe(dir)
    expect(readdirSync(dir).sort()).toEqual(['audio.webm', 'info.json'])
    expect(readFileSync(join(dir, 'audio.webm'), 'utf8')).toBe('AAABB')
    expect(JSON.parse(readFileSync(join(dir, 'info.json'), 'utf8'))).toEqual({ titulo: 'Daily' })
    expect(existsSync(join(root, '.gravando', 's1'))).toBe(false)
    expect(statSync(join(dir, 'info.json')).mtimeMs).toBeGreaterThanOrEqual(statSync(join(dir, 'audio.webm')).mtimeMs)
  })

  it('Emenda 18: finalize escreve o falantes.json antes do info.json e recusa outros nomes', async () => {
    await host.call({ op: 'begin', sessionId: 's-falantes', owner: OWNER_A })
    await host.call({ op: 'append', sessionId: 's-falantes', file: 'audio.webm', seq: 0, data: b64('F') })
    const texto = JSON.stringify({ versao: 1, intervalos: [] })
    const r = await host.call({
      op: 'finalize',
      sessionId: 's-falantes',
      relDir: '2026-10/2026-10-06 15h00 - Falantes (Meet)',
      info: { titulo: 'Falantes' },
      extras: [
        { nome: 'falantes.json', texto },
        { nome: '../fora.json', texto: 'x' },
        { nome: 'info.json', texto: '{"falso":true}' },
        { nome: 'outro.txt', texto: 'x' },
      ],
    })
    expect(r.ok).toBe(true)
    expect(readdirSync(r.path).sort()).toEqual(['audio.webm', 'falantes.json', 'info.json'])
    expect(readFileSync(join(r.path, 'falantes.json'), 'utf8')).toBe(texto)
    expect(JSON.parse(readFileSync(join(r.path, 'info.json'), 'utf8'))).toEqual({ titulo: 'Falantes' })
    expect(existsSync(join(root, '2026-10', 'fora.json'))).toBe(false)
    expect(statSync(join(r.path, 'info.json')).mtimeMs).toBeGreaterThanOrEqual(statSync(join(r.path, 'falantes.json')).mtimeMs)
  })

  it('Emenda 18: os extras têm limite de tamanho, em bytes e não em caracteres', () => {
    expect(MAX_EXTRA_BYTES).toBe(8 * 1024 * 1024)
    const noLimite = 'a'.repeat(MAX_EXTRA_BYTES)
    expect(acceptedExtras([{ nome: 'falantes.json', texto: noLimite }])).toHaveLength(1)
    expect(acceptedExtras([{ nome: 'falantes.json', texto: `${noLimite}a` }])).toEqual([])
    // Metade dos caracteres, mas cada "é" tem 2 bytes: um byte acima do limite.
    expect(acceptedExtras([{ nome: 'falantes.json', texto: `${'é'.repeat(MAX_EXTRA_BYTES / 2)}a` }])).toEqual([])
    expect(acceptedExtras([{ nome: 'falantes.json', texto: 42 }, null, 'x'])).toEqual([])
    expect(acceptedExtras(undefined)).toEqual([])
  })

  it('colisão de nome vira " (2)" e depois " (3)"', async () => {
    for (const [sid, expected] of [
      ['s2', ' (2)'],
      ['s3', ' (3)'],
    ] as const) {
      await host.call({ op: 'begin', sessionId: sid, owner: OWNER_A })
      await host.call({ op: 'append', sessionId: sid, file: 'audio.webm', seq: 0, data: b64(sid) })
      const r = await host.call({ op: 'finalize', sessionId: sid, relDir: '2026-10/2026-10-06 14h30 - Daily (Meet)', info: {} })
      expect(r.path).toBe(join(root, '2026-10', `2026-10-06 14h30 - Daily (Meet)${expected}`))
    }
  })

  it('dois helpers (dois perfis) finalizando o mesmo nome ao mesmo tempo não colidem', async () => {
    const other = new HostClient(config)
    try {
      const relDir = 'Trabalho/2026-10/2026-10-06 15h00 - Mesma call (Teams)'
      const clients = [host, other, host, other]
      const ids = ['c1', 'c2', 'c3', 'c4']
      await Promise.all(ids.map((sid, i) => clients[i].call({ op: 'begin', sessionId: sid, owner: i % 2 ? OWNER_B : OWNER_A })))
      await Promise.all(ids.map((sid, i) => clients[i].call({ op: 'append', sessionId: sid, file: 'audio.webm', seq: 0, data: b64(sid) })))
      const results = await Promise.all(ids.map((sid, i) => clients[i].call({ op: 'finalize', sessionId: sid, relDir, info: { sid } })))
      expect(results.every((r) => r.ok)).toBe(true)
      const paths = results.map((r) => r.path as string)
      expect(new Set(paths).size).toBe(4)
      const parent = join(root, 'Trabalho', '2026-10')
      expect(readdirSync(parent).sort()).toEqual([
        '2026-10-06 15h00 - Mesma call (Teams)',
        '2026-10-06 15h00 - Mesma call (Teams) (2)',
        '2026-10-06 15h00 - Mesma call (Teams) (3)',
        '2026-10-06 15h00 - Mesma call (Teams) (4)',
      ])
      // Cada pasta tem o áudio e o info.json da MESMA sessão.
      for (const p of paths) {
        const info = JSON.parse(readFileSync(join(p, 'info.json'), 'utf8'))
        expect(readFileSync(join(p, 'audio.webm'), 'utf8')).toBe(info.sid)
      }
    } finally {
      other.close()
    }
  })

  it('corrida: dois helpers chamando finalize no mesmo instante, rodada após rodada, nunca dividem a pasta', async () => {
    // Cada rodada: uma sessão em cada processo, mesmo relDir, os dois finalize escritos no stdin
    // dos dois processos no mesmo tick. Com "existe? então cria" os dois escolheriam o mesmo nome
    // e um audio.webm sobrescreveria o outro; com mkdir não recursivo, um ganha e o outro vai
    // para " (2)".
    const other = new HostClient(config)
    try {
      for (let round = 0; round < 12; round++) {
        const relDir = `corrida/2026-10/2026-10-06 16h${String(round).padStart(2, '0')} - Mesma call (Meet)`
        const sids = [`r${round}-a`, `r${round}-b`]
        const clients = [host, other]
        await Promise.all(sids.map((sid, i) => clients[i].call({ op: 'begin', sessionId: sid, owner: i ? OWNER_B : OWNER_A })))
        await Promise.all(sids.map((sid, i) => clients[i].call({ op: 'append', sessionId: sid, file: 'audio.webm', seq: 0, data: b64(sid) })))
        const results = await Promise.all(sids.map((sid, i) => clients[i].call({ op: 'finalize', sessionId: sid, relDir, info: { sid } })))
        expect(results.map((r) => r.ok), `rodada ${round}`).toEqual([true, true])
        const parent = join(root, 'corrida', '2026-10')
        const base = `2026-10-06 16h${String(round).padStart(2, '0')} - Mesma call (Meet)`
        expect(results.map((r) => r.path).sort(), `rodada ${round}`).toEqual([join(parent, base), join(parent, `${base} (2)`)])
        for (const r of results) {
          const sid = JSON.parse(readFileSync(join(r.path, 'info.json'), 'utf8')).sid
          expect(readdirSync(r.path).sort(), `rodada ${round}`).toEqual(['audio.webm', 'info.json'])
          expect(readFileSync(join(r.path, 'audio.webm'), 'utf8'), `rodada ${round}`).toBe(sid)
        }
      }
    } finally {
      other.close()
    }
  })

  it('merge põe os arquivos dentro da pasta existente (modo aba junto da página)', async () => {
    await host.call({ op: 'begin', sessionId: 's-aba', owner: OWNER_A })
    await host.call({ op: 'append', sessionId: 's-aba', file: 'audio-aba.webm', seq: 0, data: b64('ABA') })
    const relDir = '2026-10/2026-10-06 14h30 - Daily (Meet)'
    const r = await host.call({ op: 'finalize', sessionId: 's-aba', relDir, info: { arquivos: 2 }, merge: true })
    const dir = join(root, '2026-10', '2026-10-06 14h30 - Daily (Meet)')
    expect(r).toMatchObject({ ok: true, path: dir })
    expect(readdirSync(dir).sort()).toEqual(['audio-aba.webm', 'audio.webm', 'info.json'])
    expect(readFileSync(join(dir, 'audio-aba.webm'), 'utf8')).toBe('ABA')
    expect(JSON.parse(readFileSync(join(dir, 'info.json'), 'utf8'))).toEqual({ arquivos: 2 })
    expect(existsSync(join(root, '.gravando', 's-aba'))).toBe(false)
  })

  it('recusa caminhos e nomes perigosos', async () => {
    await host.call({ op: 'begin', sessionId: 's4', owner: OWNER_A })
    for (const relDir of ['../fora', '/abs/olute', 'a//b', 'a/./b', '']) {
      const r = await host.call({ op: 'finalize', sessionId: 's4', relDir, info: {} })
      expect(r.ok, relDir).toBe(false)
    }
    expect((await host.call({ op: 'begin', sessionId: '../x', owner: OWNER_A })).ok).toBe(false)
    expect((await host.call({ op: 'begin', sessionId: 's5', owner: '../dono' })).ok).toBe(false)
    expect((await host.call({ op: 'append', sessionId: 's4', file: '../x', seq: 0, data: '' })).ok).toBe(false)
  })

  it('discard apaga o staging e o índice', async () => {
    const r = await host.call({ op: 'discard', sessionId: 's4' })
    expect(r.ok).toBe(true)
    expect(existsSync(join(root, '.gravando', 's4'))).toBe(false)
    expect(existsSync(join(dirname(config), 'sessoes', 's4.json'))).toBe(false)
  })

  it('config.json ilegível volta para a raiz padrão sem quebrar', async () => {
    const saved = readFileSync(config, 'utf8')
    writeFileSync(config, '{ isto não é json')
    const r = await host.call({ op: 'get-config' })
    expect(r.ok).toBe(true)
    expect(r.root.endsWith(join('Documents', 'Gravações de calls'))).toBe(true)
    writeFileSync(config, saved)
  })
})

describe('gravador-host: uso real (Emenda 10)', () => {
  it('finalize repetido depois de terminar (o SW morreu antes de marcar "salva") devolve a mesma pasta, sem " (2)"', async () => {
    await host.call({ op: 'begin', sessionId: 's-dup', owner: OWNER_A })
    await host.call({ op: 'append', sessionId: 's-dup', file: 'audio.webm', seq: 0, data: b64('DUP') })
    const relDir = '2026-10/2026-10-07 09h00 - Repetida (Meet)'
    const first = await host.call({ op: 'finalize', sessionId: 's-dup', relDir, info: { n: 1 } })
    expect(first).toMatchObject({ ok: true })
    // A recuperação refaz o caminho inteiro: begin, append do zero, finalize.
    const again = await host.call({ op: 'begin', sessionId: 's-dup', owner: OWNER_A })
    expect(again).toMatchObject({ ok: true, done: true, path: first.path })
    expect(existsSync(join(root, '.gravando', 's-dup'))).toBe(false)
    const second = await host.call({ op: 'finalize', sessionId: 's-dup', relDir, info: { n: 2 } })
    expect(second).toMatchObject({ ok: true, path: first.path })
    expect(readdirSync(join(root, '2026-10')).filter((d) => d.includes('Repetida'))).toEqual(['2026-10-07 09h00 - Repetida (Meet)'])
    expect(readFileSync(join(first.path, 'audio.webm'), 'utf8')).toBe('DUP')
  })

  it('finalize interrompido depois de reservar a pasta (sem info.json): o seguinte usa a mesma pasta', async () => {
    await host.call({ op: 'begin', sessionId: 's-meio', owner: OWNER_A })
    await host.call({ op: 'append', sessionId: 's-meio', file: 'audio.webm', seq: 0, data: b64('MEIO') })
    // Como o helper deixa o índice depois de reservar o destino e antes de mover os arquivos.
    const target = join(root, '2026-10', '2026-10-07 09h30 - Interrompida (Meet)')
    mkdirSync(target, { recursive: true })
    const idxFile = join(dirname(config), 'sessoes', 's-meio.json')
    writeFileSync(idxFile, JSON.stringify({ ...JSON.parse(readFileSync(idxFile, 'utf8')), target }))
    const r = await host.call({ op: 'finalize', sessionId: 's-meio', relDir: '2026-10/2026-10-07 09h30 - Interrompida (Meet)', info: { ok: 1 } })
    expect(r).toMatchObject({ ok: true, path: target })
    expect(readdirSync(join(root, '2026-10')).filter((d) => d.includes('Interrompida'))).toEqual(['2026-10-07 09h30 - Interrompida (Meet)'])
    expect(readdirSync(target).sort()).toEqual(['audio.webm', 'info.json'])
  })

  it('pasta recusada vem com o motivo em português e o código entre parênteses', async () => {
    const file = join(base, 'um-arquivo')
    writeFileSync(file, 'x')
    const r = await host.call({ op: 'check-root', path: join(file, 'sub') })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/passa por um arquivo/)
    expect(r.error).toMatch(/\(ENOTDIR\)/)
  })

  it.runIf(process.platform === 'darwin')('o seletor de pasta aberto não segura os appends e o ping do mesmo perfil', async () => {
    const bin = join(base, 'bin-falso')
    mkdirSync(bin, { recursive: true })
    const fakeOsa = join(bin, 'osascript')
    writeFileSync(fakeOsa, '#!/bin/sh\nsleep 2\necho /tmp/escolhida\n')
    chmodSync(fakeOsa, 0o755)
    const slow = new HostClient(config, { PATH: `${bin}:${process.env.PATH}` })
    try {
      const t0 = Date.now()
      const chosen = slow.call({ op: 'choose-folder', prompt: 'Escolha' }).then((r) => ({ r, ms: Date.now() - t0 }))
      await new Promise((r) => setTimeout(r, 100))
      const ping = await slow.call({ op: 'ping' })
      const pingMs = Date.now() - t0
      expect(ping.ok).toBe(true)
      expect(pingMs, `ping respondeu em ${pingMs} ms com o seletor aberto`).toBeLessThan(1500)
      const c = await chosen
      expect(c.r).toMatchObject({ ok: true, path: '/tmp/escolhida' })
      expect(c.ms).toBeGreaterThanOrEqual(1900)
    } finally {
      slow.close()
    }
  })
})

describe('gravador-host: transcrição (Emenda 13)', () => {
  let tbase: string
  let troot: string
  let tconfig: string
  let th: HostClient
  let tools: ReturnType<typeof makeFakeTools>
  let seq = 0

  beforeAll(async () => {
    tbase = mkdtempSync(join(tmpdir(), 'gravador-host-transcricao-'))
    troot = join(tbase, 'Gravações')
    tconfig = join(tbase, 'config', 'config.json')
    tools = makeFakeTools(join(tbase, 'ferramentas'))
    mkdirSync(dirname(tconfig), { recursive: true })
    writeFileSync(tconfig, JSON.stringify({ root: troot, transcricao: fakeTranscriptionConfig(tools) }))
    // Abrir com o aplicativo padrão vira um script que só anota o caminho.
    const opener = join(tbase, 'abrir.sh')
    writeFileSync(opener, `#!/bin/sh\necho "$1" >> ${JSON.stringify(join(tbase, 'abertos.log'))}\n`)
    chmodSync(opener, 0o755)
    th = new HostClient(tconfig, { GRAVADOR_OPEN_CMD: opener })
    expect(await th.call({ op: 'set-root', path: troot })).toMatchObject({ ok: true })
  })
  afterAll(() => {
    th.close()
    rmSync(tbase, { recursive: true, force: true })
  })

  /** Uma gravação de verdade pelo helper (begin, append, finalize). */
  async function record(title: string, info: Record<string, unknown> = {}) {
    const sid = `t${++seq}`
    await th.call({ op: 'begin', sessionId: sid, owner: OWNER_A })
    await th.call({ op: 'append', sessionId: sid, file: 'audio.webm', seq: 0, data: b64(`áudio ${title}`) })
    const r = await th.call({ op: 'finalize', sessionId: sid, relDir: `2026-10/2026-10-07 10h${String(seq).padStart(2, '0')} - ${title} (Meet)`, info: { versao: 1, titulo: title, plataforma: 'meet', inicio: '2026-10-07T10:00:00-03:00', duracaoSegundos: 60, participantes: [], ...info } })
    expect(r).toMatchObject({ ok: true })
    return r.path as string
  }

  const infoOf = (dir: string) => JSON.parse(readFileSync(join(dir, 'info.json'), 'utf8'))
  /** Whisper falsos que já rodaram antes do teste atual (o log é do bloco inteiro). */
  let callsBefore = 0
  const seqCalls = () => callsBefore
  const countCalls = () => (existsSync(tools.calls) ? readFileSync(tools.calls, 'utf8').trim().split('\n').filter((l) => l.startsWith('inicio')).length : 0)
  beforeEach(() => {
    callsBefore = countCalls()
  })

  async function waitFila(expected: unknown[]) {
    const t0 = Date.now()
    for (;;) {
      const fila = (await th.call({ op: 'transcription-status' })).fila
      if (JSON.stringify(fila) === JSON.stringify(expected)) return
      if (Date.now() - t0 > 15_000) throw new Error(`fila: ${JSON.stringify(fila)}`)
      await new Promise((r) => setTimeout(r, 100))
    }
  }

  async function waitStatus(dir: string, status: string) {
    const t0 = Date.now()
    while (infoOf(dir).transcricao?.status !== status) {
      if (Date.now() - t0 > 15_000) throw new Error(`transcrição não ficou ${status}: ${JSON.stringify(infoOf(dir).transcricao)}`)
      await new Promise((r) => setTimeout(r, 100))
    }
  }

  it('get-config traz a transcrição e os motores; set-transcription valida e grava sem perder a raiz', async () => {
    const cfg = await th.call({ op: 'get-config' })
    expect(cfg).toMatchObject({ ok: true, root: troot, transcricao: { ativa: true, motor: 'whisper-cpp', idioma: 'auto', modelo: tools.model }, motores: [{ id: 'whisper-cpp', rotulo: 'whisper.cpp (local)' }] })
    expect(await th.call({ op: 'set-transcription', patch: { idioma: 'pt' } })).toMatchObject({ ok: true, transcricao: { idioma: 'pt', ativa: true } })
    expect(JSON.parse(readFileSync(tconfig, 'utf8'))).toMatchObject({ root: troot, transcricao: { idioma: 'pt' } })
    for (const [patch, error] of [
      [{ motor: 'nuvem' }, /motor desconhecido/],
      [{ modelo: join(tbase, 'nao.bin') }, /modelo não encontrado/],
      [{ ffmpeg: 'ffmpeg' }, /caminho absoluto/],
      [{ root: '/' }, /campo desconhecido/],
      [null, /falta a mudança/],
    ] as const) {
      const r = await th.call({ op: 'set-transcription', patch })
      expect(r.ok, JSON.stringify(patch)).toBe(false)
      expect(r.error).toMatch(error)
    }
    expect(JSON.parse(readFileSync(tconfig, 'utf8')).transcricao).toMatchObject({ idioma: 'pt', motor: 'whisper-cpp' })
    await th.call({ op: 'set-transcription', patch: { idioma: 'auto' } })
  })

  it('finalize com a transcrição ligada: o worker destacado escreve transcricao.md e .srt e o info.json fica pronta', async () => {
    const dir = await record('Planejamento', { perfil: 'Trabalho' })
    // Logo depois do finalize a pasta já está na fila (ou o worker já pegou).
    expect(['pendente', 'transcrevendo', 'pronta']).toContain(infoOf(dir).transcricao.status)
    await waitStatus(dir, 'pronta')
    expect(readdirSync(dir).sort()).toEqual(['audio.webm', 'info.json', 'transcricao.md', 'transcricao.srt'])
    expect(readFileSync(join(dir, 'transcricao.md'), 'utf8')).toContain(`[00:00] ${FAKE_TEXT}`)
    // Uma pasta fora da raiz com info.json: o helper não lê.
    mkdirSync(join(tbase, 'fora'), { recursive: true })
    writeFileSync(join(tbase, 'fora', 'info.json'), JSON.stringify({ transcricao: { status: 'pronta' } }))
    const st = await th.call({ op: 'transcription-status', paths: [dir, join(tbase, 'fora')] })
    expect(st).toMatchObject({ ok: true, ativa: true, disponivel: true, motivo: null, modeloEncontrado: tools.model, fila: [] })
    expect(st.recentes).toEqual([
      { path: dir, transcricao: expect.objectContaining({ status: 'pronta', arquivos: ['transcricao.md', 'transcricao.srt'] }) },
      { path: join(tbase, 'fora'), transcricao: null },
    ])
  })

  it('modo aba entrando na pasta (merge): a transcrição da página fica e o áudio do modo aba é transcrito também, sem refazer a da página', async () => {
    writeFileSync(join(tools.dir, 'eco'), '')
    try {
      const dir = await record('Com aba')
      await waitStatus(dir, 'pronta')
      const before = infoOf(dir).transcricao
      expect(before).toMatchObject({ audio: 'audio.webm', arquivos: ['transcricao.md', 'transcricao.srt'] })
      const relDir = dir.slice(troot.length + 1)
      await th.call({ op: 'begin', sessionId: 'aba-merge', owner: OWNER_A })
      await th.call({ op: 'append', sessionId: 'aba-merge', file: 'audio-aba.webm', seq: 0, data: b64('ABA') })
      const r = await th.call({ op: 'finalize', sessionId: 'aba-merge', relDir, info: { versao: 1, titulo: 'Com aba', arquivos: 2 }, merge: true })
      expect(r).toMatchObject({ ok: true, path: dir })
      // O finalize não perde o estado da página, e o áudio do modo aba entra na fila como principal.
      expect(infoOf(dir)).toMatchObject({ arquivos: 2, transcricoes: { 'audio.webm': before } })
      expect(['pendente', 'transcrevendo', 'pronta']).toContain(infoOf(dir).transcricao.status)
      expect(infoOf(dir).transcricao.audio).toBe('audio-aba.webm')
      await waitStatus(dir, 'pronta')
      const info = infoOf(dir)
      expect(info.transcricao).toMatchObject({ audio: 'audio-aba.webm', arquivos: ['transcricao-aba.md', 'transcricao-aba.srt'] })
      expect(info.transcricoes['audio.webm']).toEqual(before)
      expect(readFileSync(join(dir, 'transcricao-aba.md'), 'utf8')).toContain('[00:00] ABA segunda frase.')
      expect(readFileSync(join(dir, 'transcricao.md'), 'utf8')).toContain('[00:00] áudio Com aba segunda frase.')
      // A da página não rodou de novo: dois whisper ao todo nesta pasta (página e aba).
      expect(countCalls()).toBe(seqCalls() + 2)
      // O popup abre o .md da principal.
      const st = await th.call({ op: 'transcription-status', paths: [dir] })
      expect(st.recentes[0].transcricao).toMatchObject({ status: 'pronta', arquivos: ['transcricao-aba.md', 'transcricao-aba.srt'] })
      expect(await th.call({ op: 'open-file', path: join(dir, 'transcricao-aba.md') })).toMatchObject({ ok: true })
      expect(readFileSync(join(tbase, 'abertos.log'), 'utf8').trim()).toBe(realpathSync(join(dir, 'transcricao-aba.md')))
      rmSync(join(tbase, 'abertos.log'))
      await waitFila([])

      // Um segundo modo aba na mesma pasta (audio-aba (2).webm): só ele entra na fila; a página e a
      // primeira aba continuam prontas (o merge não perde o estado de nenhum áudio).
      await th.call({ op: 'begin', sessionId: 'aba-merge-2', owner: OWNER_A })
      await th.call({ op: 'append', sessionId: 'aba-merge-2', file: 'audio-aba.webm', seq: 0, data: b64('ABA2') })
      expect(await th.call({ op: 'finalize', sessionId: 'aba-merge-2', relDir, info: { versao: 1, titulo: 'Com aba', arquivos: 3 }, merge: true })).toMatchObject({ ok: true, path: dir })
      await waitStatus(dir, 'pronta')
      const third = infoOf(dir)
      expect(third.transcricao).toMatchObject({ audio: 'audio-aba (2).webm', arquivos: ['transcricao-aba-2.md', 'transcricao-aba-2.srt'] })
      expect(third.transcricoes['audio.webm']).toEqual(before)
      expect(third.transcricoes['audio-aba.webm']).toEqual(info.transcricao)
      expect(readFileSync(join(dir, 'transcricao-aba-2.md'), 'utf8')).toContain('[00:00] ABA2 segunda frase.')
      expect(countCalls()).toBe(seqCalls() + 3)
      await waitFila([])
    } finally {
      rmSync(join(tools.dir, 'eco'), { force: true })
    }
  })

  it('transcrição desligada: o finalize não põe nada na fila e não aparece transcrição', async () => {
    await th.call({ op: 'set-transcription', patch: { ativa: false } })
    try {
      const dir = await record('Sem transcrição')
      await new Promise((r) => setTimeout(r, 1000))
      expect(readdirSync(dir).sort()).toEqual(['audio.webm', 'info.json'])
      expect(infoOf(dir).transcricao).toBeUndefined()
      expect((await th.call({ op: 'transcription-status' })).fila).toEqual([])
    } finally {
      await th.call({ op: 'set-transcription', patch: { ativa: true } })
    }
  })

  it('transcription-status diz por que não dá para transcrever', async () => {
    const saved = readFileSync(tconfig, 'utf8')
    writeFileSync(tconfig, JSON.stringify({ root: troot, transcricao: { ...fakeTranscriptionConfig(tools), whisperCli: join(tbase, 'sem-whisper') } }))
    try {
      const st = await th.call({ op: 'transcription-status' })
      expect(st).toMatchObject({ ok: true, disponivel: false, motivo: expect.stringMatching(/whisper-cli não encontrado em .*sem-whisper/) })
    } finally {
      writeFileSync(tconfig, saved)
    }
  })

  /** config.json próprio (fila própria, nenhum worker do bloco rodando nela), na mesma raiz. */
  function isolatedConfig(name: string, transcricao: Record<string, unknown>): string {
    const cfg = join(tbase, name, 'config.json')
    mkdirSync(dirname(cfg), { recursive: true })
    writeFileSync(cfg, JSON.stringify({ root: troot, transcricao }))
    return cfg
  }

  /** Uma pasta como o finalize deixa (áudio e info.json), sem passar pelo helper. */
  function folderOf(name: string): string {
    const dir = join(troot, '2026-10', `2026-10-07 11h00 - ${name} (Meet)`)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'audio.webm'), 'áudio')
    writeFileSync(join(dir, 'info.json'), JSON.stringify({ versao: 1, titulo: name, plataforma: 'meet', inicio: '2026-10-07T11:00:00-03:00', duracaoSegundos: 60, participantes: [] }))
    return dir
  }

  it('ao abrir, o helper retoma a fila que sobrou (o Mac desligou no meio), sem esperar outra call', async () => {
    // Uma pasta pronta e um trabalho na fila, sem nenhum worker rodando.
    const cfg = isolatedConfig('config-retoma', fakeTranscriptionConfig(tools))
    const dir = folderOf('Sobrou')
    expect(await enqueueTranscription(dirname(cfg), dir, {})).toMatchObject({ queued: true })
    await new Promise((r) => setTimeout(r, 500))
    expect(infoOf(dir).transcricao.status).toBe('pendente')
    const fresh = new HostClient(cfg)
    try {
      await waitStatus(dir, 'pronta')
    } finally {
      fresh.close()
    }
  })

  it('ao abrir com a transcrição desligada, o helper não retoma a fila', async () => {
    const cfg = isolatedConfig('config-retoma-desligada', fakeTranscriptionConfig(tools, { ativa: false }))
    const dir = folderOf('Sobrou desligada')
    expect(await enqueueTranscription(dirname(cfg), dir, {})).toMatchObject({ queued: true })
    const fresh = new HostClient(cfg)
    try {
      expect(await fresh.call({ op: 'ping' })).toMatchObject({ ok: true })
      await new Promise((r) => setTimeout(r, 1500))
      expect(infoOf(dir).transcricao.status).toBe('pendente')
      expect(countCalls()).toBe(seqCalls())
      // Ligar pelas configurações abre o worker na hora para o que estava esperando.
      expect(await fresh.call({ op: 'set-transcription', patch: { ativa: true } })).toMatchObject({ ok: true })
      await waitStatus(dir, 'pronta')
    } finally {
      fresh.close()
    }
  })

  it('sem o whisper-cli o finalize não abre worker: a call espera na fila com o motivo, e corrigir o caminho transcreve', async () => {
    const cfg = isolatedConfig('config-espera', fakeTranscriptionConfig(tools, { whisperCli: join(tbase, 'sem-whisper') }))
    const h2 = new HostClient(cfg)
    try {
      await h2.call({ op: 'begin', sessionId: 'espera-1', owner: OWNER_A })
      await h2.call({ op: 'append', sessionId: 'espera-1', file: 'audio.webm', seq: 0, data: b64('áudio que espera') })
      const r = await h2.call({ op: 'finalize', sessionId: 'espera-1', relDir: '2026-10/2026-10-07 12h00 - Espera (Meet)', info: { versao: 1, titulo: 'Espera', plataforma: 'meet', inicio: '2026-10-07T12:00:00-03:00', duracaoSegundos: 60, participantes: [] } })
      const dir = r.path as string
      expect(infoOf(dir).transcricao).toMatchObject({ status: 'pendente', espera: expect.stringMatching(/whisper-cli não encontrado em .*sem-whisper/) })
      expect(existsSync(join(dirname(cfg), 'fila', 'worker.lock'))).toBe(false)
      const st = await h2.call({ op: 'transcription-status', paths: [dir] })
      expect(st).toMatchObject({ disponivel: false, fila: [expect.objectContaining({ audio: 'audio.webm' })] })
      expect(st.recentes[0].transcricao).toMatchObject({ status: 'pendente', espera: expect.stringMatching(/whisper-cli não encontrado/) })
      expect(await h2.call({ op: 'set-transcription', patch: { whisperCli: tools.whisperCli } })).toMatchObject({ ok: true })
      await waitStatus(dir, 'pronta')
      expect(infoOf(dir).transcricao.espera).toBeUndefined()
    } finally {
      h2.close()
    }
  })

  it('o worker continua quando o Chrome mata o helper (e o grupo dele) no meio da transcrição', async () => {
    const cfg = isolatedConfig('config-destacado', fakeTranscriptionConfig(tools))
    writeFileSync(join(tools.dir, 'espera'), '1.5')
    const h2 = new HostClient(cfg, {}, { detached: true })
    try {
      await h2.call({ op: 'begin', sessionId: 'destacado-1', owner: OWNER_A })
      await h2.call({ op: 'append', sessionId: 'destacado-1', file: 'audio.webm', seq: 0, data: b64('áudio') })
      const r = await h2.call({ op: 'finalize', sessionId: 'destacado-1', relDir: '2026-10/2026-10-07 13h00 - Destacado (Meet)', info: { versao: 1, titulo: 'Destacado', plataforma: 'meet', inicio: '2026-10-07T13:00:00-03:00', duracaoSegundos: 60, participantes: [] } })
      const dir = r.path as string
      await waitStatus(dir, 'transcrevendo')
      process.kill(-h2.pid, 'SIGKILL')
      await h2.exited()
      await waitStatus(dir, 'pronta')
    } finally {
      rmSync(join(tools.dir, 'espera'), { force: true })
    }
  })

  it('transcription-status mostra falhou para um pendente cujo trabalho saiu da fila (erro de disco no worker)', async () => {
    const dir = folderOf('Perdida')
    const info = infoOf(dir)
    const t = { status: 'pendente', motor: 'whisper-cpp', modelo: null, idioma: 'auto', audio: 'audio.webm', inicio: null, fim: null, duracaoProcessamentoSeg: null, arquivos: [] }
    writeFileSync(join(dir, 'info.json'), JSON.stringify({ ...info, transcricao: t }))
    // Recente (o instante entre marcar o info.json e gravar o trabalho): continua pendente.
    expect((await th.call({ op: 'transcription-status', paths: [dir] })).recentes[0].transcricao.status).toBe('pendente')
    const old = new Date(Date.now() - 60_000)
    utimesSync(join(dir, 'info.json'), old, old)
    expect((await th.call({ op: 'transcription-status', paths: [dir] })).recentes[0].transcricao).toMatchObject({ status: 'falhou', erro: expect.stringMatching(/saiu da fila sem terminar/) })
  })

  it('open-file só abre transcricao.md/.srt dentro da raiz', async () => {
    const dir = await record('Abrir')
    await waitStatus(dir, 'pronta')
    const md = realpathSync(join(dir, 'transcricao.md'))
    expect(await th.call({ op: 'open-file', path: join(dir, 'transcricao.md') })).toMatchObject({ ok: true, path: md })
    expect(readFileSync(join(tbase, 'abertos.log'), 'utf8').trim().split('\n')).toEqual([md])

    // Fora da raiz, mesmo com o nome certo.
    const outside = join(tbase, 'fora', 'transcricao.md')
    mkdirSync(dirname(outside), { recursive: true })
    writeFileSync(outside, 'x')
    const cases: Array<[string, RegExp]> = [
      [outside, /fora da pasta das gravações/],
      // ../ que sai da raiz.
      [join(troot, '..', 'fora', 'transcricao.md'), /fora da pasta das gravações/],
      // Arquivo da gravação que não é a transcrição.
      [join(dir, 'info.json'), /só abre a transcrição/],
      [join(dir, 'audio.webm'), /só abre a transcrição/],
      [join(dir, 'nao-existe.md'), /não existe/],
      ['', /caminho vazio/],
    ]
    // Symlink dentro da raiz apontando para fora.
    const link = join(dir, 'transcricao-link.md')
    symlinkSync(outside, link)
    cases.push([link, /fora da pasta das gravações/])
    // Pasta irmã cujo nome começa com o da raiz ("<raiz> outra"): não é a raiz.
    const irma = join(`${troot} outra`, '2026-10', 'x', 'transcricao.md')
    mkdirSync(dirname(irma), { recursive: true })
    writeFileSync(irma, 'x')
    writeFileSync(join(dirname(irma), 'info.json'), JSON.stringify({ transcricao: { status: 'pronta' } }))
    cases.push([irma, /fora da pasta das gravações/])
    expect((await th.call({ op: 'transcription-status', paths: [dirname(irma)] })).recentes).toEqual([{ path: dirname(irma), transcricao: null }])
    for (const [p, error] of cases) {
      const r = await th.call({ op: 'open-file', path: p })
      expect(r.ok, p).toBe(false)
      expect(r.error, p).toMatch(error)
    }
    expect(readFileSync(join(tbase, 'abertos.log'), 'utf8').trim().split('\n')).toEqual([md])
  })
})

describe('gravador-host: a transcrição que a extensão fez (Emenda 21)', () => {
  let abase: string
  let aroot: string
  let aconfig: string
  let ah: HostClient
  let atools: ReturnType<typeof makeFakeTools>
  let seq = 0

  beforeAll(async () => {
    abase = mkdtempSync(join(tmpdir(), 'gravador-host-api-'))
    aroot = join(abase, 'Gravações')
    aconfig = join(abase, 'config', 'config.json')
    atools = makeFakeTools(join(abase, 'ferramentas'))
    mkdirSync(dirname(aconfig), { recursive: true })
    // Motor LOCAL ligado (com os programas falsos): é o que faz o `semTranscricao` significar algo.
    // Sem ele ligado, o finalize nem olharia a fila e a guarda passaria sem ser exercitada.
    writeFileSync(aconfig, JSON.stringify({ root: aroot, transcricao: fakeTranscriptionConfig(atools) }))
    // Abrir com o aplicativo padrão vira um script que só anota o caminho (nunca o `open` de verdade).
    const opener = join(abase, "abrir.sh")
    writeFileSync(opener, "#!/bin/sh\necho \"$1\" >> " + JSON.stringify(join(abase, "abertos.log")) + "\n")
    chmodSync(opener, 0o755)
    ah = new HostClient(aconfig, { GRAVADOR_OPEN_CMD: opener })
    expect(await ah.call({ op: 'set-root', path: aroot })).toMatchObject({ ok: true })
  })
  afterAll(() => {
    ah.close()
    rmSync(abase, { recursive: true, force: true })
  })

  async function record(title: string, { semTranscricao = false } = {}) {
    const sid = `a${++seq}`
    await ah.call({ op: 'begin', sessionId: sid, owner: OWNER_A })
    await ah.call({ op: 'append', sessionId: sid, file: 'audio.webm', seq: 0, data: b64(`áudio ${title}`) })
    const r = await ah.call({
      op: 'finalize',
      sessionId: sid,
      relDir: `2026-10/2026-10-13 09h${String(seq).padStart(2, '0')} - ${title} (Meet)`,
      info: { versao: 1, titulo: title, plataforma: 'meet', inicio: '2026-10-13T09:00:00-03:00', duracaoSegundos: 60, participantes: [] },
      ...(semTranscricao ? { semTranscricao: true } : {}),
    })
    expect(r).toMatchObject({ ok: true })
    return r.path as string
  }

  const infoOf = (dir: string) => JSON.parse(readFileSync(join(dir, 'info.json'), 'utf8'))

  const ARQUIVOS = [
    { nome: 'transcricao.md', texto: '# Daily\n\n[00:00] Ana Souza: bom dia\n' },
    { nome: 'transcricao.srt', texto: '1\n00:00:00,000 --> 00:00:02,000\nAna Souza: bom dia\n' },
  ]

  const ESTADO = {
    status: 'pronta',
    motor: 'openai-api',
    modelo: 'whisper-1',
    idioma: 'portuguese',
    audio: 'audio.webm',
    inicio: '2026-10-13T09:10:00.000Z',
    fim: '2026-10-13T09:10:04.000Z',
    duracaoProcessamentoSeg: 4,
    arquivos: ['transcricao.md', 'transcricao.srt'],
  }

  it('escreve os arquivos na pasta e grava o estado no info.json, no mesmo formato do motor local', async () => {
    const dir = await record('Com API', { semTranscricao: true })
    const r = await ah.call({ op: 'transcription-write', path: dir, audio: 'audio.webm', arquivos: ARQUIVOS, transcricao: ESTADO })
    expect(r).toMatchObject({ ok: true, arquivos: ['transcricao.md', 'transcricao.srt'], registrado: true })
    expect(readFileSync(join(dir, 'transcricao.md'), 'utf8')).toContain('[00:00] Ana Souza: bom dia')
    expect(readFileSync(join(dir, 'transcricao.srt'), 'utf8')).toContain('Ana Souza: bom dia')
    const info = infoOf(dir)
    expect(info.transcricao).toMatchObject(ESTADO)
    expect(info.transcricoes['audio.webm']).toMatchObject(ESTADO)
    // O resto do info.json continua o da gravação.
    expect(info).toMatchObject({ titulo: 'Com API', plataforma: 'meet' })
    // Nada pela metade: nenhum temporário ficou na pasta.
    expect(readdirSync(dir).filter((f) => f.includes('.tmp-'))).toEqual([])
    // E o popup abre o arquivo pelo open-file de sempre.
    expect(await ah.call({ op: 'open-file', path: join(dir, 'transcricao.md') })).toMatchObject({ ok: true })
    expect(readFileSync(join(abase, 'abertos.log'), 'utf8').trim()).toBe(realpathSync(join(dir, 'transcricao.md')))
  })

  it('semTranscricao: o finalize não põe a pasta na fila do motor local; sem ele, põe', async () => {
    // Com a guarda: nada na fila e nada no info.json, nem depois de um tempo de sobra.
    const dir = await record('Sem fila local', { semTranscricao: true })
    await new Promise((r) => setTimeout(r, 1500))
    expect(infoOf(dir).transcricao).toBeUndefined()
    const st = await ah.call({ op: 'transcription-status', paths: [dir] })
    expect(st.fila.filter((j: { pasta: string }) => j.pasta === dir)).toEqual([])
    // Sem a guarda (o motor local é o de sempre): o helper transcreve, como na Emenda 13.
    const outro = await record('Com fila local')
    const t0 = Date.now()
    let estado
    do {
      estado = infoOf(outro).transcricao?.status
      if (estado === 'pronta') break
      await new Promise((r) => setTimeout(r, 100))
    } while (Date.now() - t0 < 20_000)
    expect(estado, 'o motor local devia ter transcrito esta').toBe('pronta')
    expect(readdirSync(outro).sort()).toContain('transcricao.md')
  })

  it('recusa um nome que não é da transcrição e uma pasta fora da raiz', async () => {
    const dir = await record('Guardas', { semTranscricao: true })
    expect(await ah.call({ op: 'transcription-write', path: dir, audio: 'audio.webm', arquivos: [{ nome: 'info.json', texto: '{}' }] })).toMatchObject({
      ok: false,
      error: expect.stringContaining('só escreve a transcrição'),
    })
    expect(await ah.call({ op: 'transcription-write', path: dir, audio: 'audio.webm', arquivos: [{ nome: '../fora.md', texto: 'x' }] })).toMatchObject({ ok: false })
    expect(await ah.call({ op: 'transcription-write', path: join(abase, 'fora-da-raiz'), audio: 'audio.webm', arquivos: ARQUIVOS })).toMatchObject({
      ok: false,
      error: expect.stringContaining('não existe'),
    })
    const irma = join(abase, 'Gravações outra')
    mkdirSync(irma, { recursive: true })
    expect(await ah.call({ op: 'transcription-write', path: irma, audio: 'audio.webm', arquivos: ARQUIVOS })).toMatchObject({
      ok: false,
      error: expect.stringContaining('fora da pasta das gravações'),
    })
    // Nada do que foi recusado apareceu na pasta.
    expect(readdirSync(dir).sort()).toEqual(['audio.webm', 'info.json'])
  })

  it('recusa um texto grande demais e um áudio com nome inválido', async () => {
    const dir = await record('Limites', { semTranscricao: true })
    expect(await ah.call({ op: 'transcription-write', path: dir, audio: 'audio.webm', arquivos: [{ nome: 'transcricao.md', texto: 'x'.repeat(MAX_EXTRA_BYTES + 1) }] })).toMatchObject({
      ok: false,
      error: expect.stringContaining('grande demais'),
    })
    expect(await ah.call({ op: 'transcription-write', path: dir, audio: '../fora.webm', arquivos: ARQUIVOS })).toMatchObject({ ok: false })
    expect(readdirSync(dir).sort()).toEqual(['audio.webm', 'info.json'])
  })

  it('sem o estado, só escreve os arquivos (é assim que uma falha é registrada sem arquivo)', async () => {
    const dir = await record('Só estado', { semTranscricao: true })
    const erro = { status: 'falhou', motor: 'openai-api', modelo: null, idioma: '', audio: 'audio.webm', inicio: null, fim: null, duracaoProcessamentoSeg: null, arquivos: [], erro: 'o provedor recusou a chave da API' }
    expect(await ah.call({ op: 'transcription-write', path: dir, audio: 'audio.webm', arquivos: [], transcricao: erro })).toMatchObject({ ok: true, arquivos: [], registrado: true })
    expect(infoOf(dir).transcricao).toMatchObject({ status: 'falhou', erro: 'o provedor recusou a chave da API' })
    expect(readdirSync(dir).sort()).toEqual(['audio.webm', 'info.json'])
  })
})
