// Integridade da página (AC14, ARQUITETURA "Testes"): a página de teste mede a energia do próprio
// áudio dela, o que ela observa das APIs embrulhadas e os erros de console, com e sem a
// extensão. Os dois lados têm de bater. A extensão grava de verdade no lado "com" (prova de que
// os ganchos estavam ativos durante a medição).
import { expect, test, type BrowserContext } from '@playwright/test'
import { median } from '../helpers/audio'
import { launchWithExtension, launchWithoutExtension, swApi, type Harness, type PageError } from '../helpers/browser'

const MEASURE_MS = 12_000

interface Observed {
  db: number
  amostras: number
  fatos: Record<string, unknown>
  unhandled: string[]
  errors: string[]
  console: string[]
}

async function observe(context: BrowserContext, pageErrors: PageError[], room: string, during?: () => Promise<void>): Promise<Observed> {
  const peer = await context.newPage()
  await peer.goto(`https://meet.google.com/__peer?tom=440&sala=${room}`)
  await peer.click('#iniciar')
  await expect.poll(() => peer.evaluate(() => (window as any).fixture.state)).toBe('pronto')
  const call = await context.newPage()
  await call.goto(`https://meet.google.com/abc-defg-hij?variante=integridade&sala=${room}`)
  await expect.poll(() => call.evaluate(() => (window as any).fixture.micLive)).toBe(true)
  await call.click('#participar')
  await expect.poll(() => call.evaluate(() => (window as any).fixture.pcState), { timeout: 15_000 }).toBe('connected')
  await expect.poll(() => call.evaluate(() => (window as any).fixture.amostras.length), { timeout: 10_000 }).toBeGreaterThan(0)
  if (during) await during()
  await call.waitForTimeout(MEASURE_MS)
  await call.evaluate(() => (window as any).fixture.rejeitar())
  await call.waitForTimeout(500)
  const fx = (await call.evaluate(async () => {
    const f = (window as any).fixture
    return { amostras: f.amostras as number[], fatos: await f.fatos(), unhandled: f.unhandled, errors: f.errors }
  })) as { amostras: number[]; fatos: Record<string, unknown>; unhandled: string[]; errors: string[] }
  // Os 2 primeiros segundos ficam de fora (arranque do jitter buffer).
  const steady = fx.amostras.slice(8)
  return {
    db: median(steady),
    amostras: steady.length,
    fatos: fx.fatos,
    unhandled: fx.unhandled,
    errors: fx.errors,
    console: pageErrors.filter((e) => e.url.includes('variante=integridade')).map((e) => `${e.kind}: ${e.text}`),
  }
}

let h: Harness | undefined
let plain: Awaited<ReturnType<typeof launchWithoutExtension>> | undefined

test.afterEach(async ({}, testInfo) => {
  if (h && testInfo.status !== testInfo.expectedStatus) console.log(h.logs.join('\n'))
  await h?.close()
  await plain?.close()
  h = undefined
  plain = undefined
})

test('com e sem a extensão, a página ouve o mesmo áudio, vê as mesmas APIs e os mesmos erros', async () => {
  plain = await launchWithoutExtension()
  const sem = await observe(plain.context, plain.pageErrors, 'integ-sem')
  await plain.close()
  plain = undefined

  h = await launchWithExtension()
  const api = swApi(h.sw)
  const com = await observe(h.context, h.pageErrors, 'integ-com', async () => {
    await expect.poll(async () => (await api.activeRecordings()).length, { timeout: 10_000 }).toBe(1)
  })
  // Os ganchos estavam ativos: houve gravação durante a medição.
  expect((await api.activeRecordings()).length).toBe(1)

  console.log(`integridade: sem ${sem.db.toFixed(1)} dBFS (${sem.amostras}), com ${com.db.toFixed(1)} dBFS (${com.amostras})`)
  // O controle mede som de verdade (senão a comparação não prova nada).
  expect(sem.db).toBeGreaterThan(-20)
  expect(Math.abs(com.db - sem.db), `sem ${sem.db} x com ${com.db}`).toBeLessThanOrEqual(1)
  expect(com.fatos).toEqual(sem.fatos)
  expect(sem.fatos).toMatchObject({ instanceOf: true, ctor: true, elementoTocando: true, gumDevolvePromise: true })
  // O controle prova algo: sem a extensão, cada retorno confere e o for-in vê o addEventListener.
  expect(sem.fatos.retornos).toEqual({
    getUserMediaResolveStream: true,
    addTrackDevolveSender: true,
    addTransceiverDevolveTransceptor: true,
    trackCloneNovo: true,
    streamCloneNovo: true,
    replaceTrackDevolvePromise: true,
    replaceTrackTrocou: true,
    closeDevolveUndefined: true,
  })
  expect((sem.fatos.chaves as { pcForIn: string[] }).pcForIn).toEqual(expect.arrayContaining(['addEventListener', 'addTrack', 'close']))
  // Exatamente uma rejeição não tratada (a de getUserMedia({}) sem catch), nos dois lados.
  expect(sem.unhandled).toEqual(['TypeError'])
  expect(com.unhandled).toEqual(sem.unhandled)
  // Nada de violação de CSP/Trusted Types nem erro novo de console.
  expect(sem.errors).toEqual([])
  expect(com.errors).toEqual([])
  expect(com.console).toEqual(sem.console)
})
