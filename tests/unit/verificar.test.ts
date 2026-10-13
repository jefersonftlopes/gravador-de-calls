// npm run verificar (Emenda 23): o estado real da instalação da transcrição local, em frases.
//
// Tudo aqui roda num HOME falso numa pasta temporária, com um config.json próprio
// (GRAVADOR_CONFIG) e com o whisper-cli e o ffmpeg falsos: nunca na instalação de verdade, nunca na
// pasta das gravações. A descoberta recebe as pastas por parâmetro (`home`, `manifestDir`,
// `binDir`, `env`, `fallbackDirs`, `modelDirs`, o mesmo `ctx` do motor), e é isso que deixa o teste
// provar os casos que faltam numa máquina que tem tudo instalado.
//
// O comando SÓ LÊ: o último teste prova que nada apareceu no HOME falso depois de rodar.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
// @ts-expect-error módulo .mjs sem tipos
import { HOST_FILES, HOST_NAME } from '../../host/args.mjs'
// @ts-expect-error módulo .mjs sem tipos
import { HOST_VERSION } from '../../host/gravador-host.mjs'
import { collectState, gbLabel, type VerifyState } from '../../scripts/verificar.mjs'
import { makeFakeTools } from '../helpers/fake-transcricao'
import { ROOT } from '../helpers/paths'

const base = mkdtempSync(join(tmpdir(), 'gravador-verificar-'))
afterAll(() => rmSync(base, { recursive: true, force: true }))

const SCRIPT = join(ROOT, 'scripts', 'verificar.mjs')
/** A chave da API nunca passa por este comando: um valor FALSO no config.json prova isso. */
const CHAVE_FALSA = 'sk-chave-falsa-que-nunca-existiu-0123456789'

interface Caso {
  home: string
  configFile: string
  manifestDir: string
  binDir: string
  modelDir: string
  tools: ReturnType<typeof makeFakeTools>
}

/**
 * Um caso de teste: HOME falso com a pasta do manifesto, a pasta da cópia do helper, a pasta dos
 * modelos e os programas falsos. `opts` escolhe o que FALTA.
 */
function caso(
  nome: string,
  { manifesto = true, helper = true, modelo = true, raiz = '', config = true, ativa = true, versaoHelper = HOST_VERSION as string } = {},
): Caso {
  const home = join(base, nome)
  const suporte = join(home, 'Library', 'Application Support')
  const binDir = join(suporte, 'gravador-de-calls', 'bin')
  const modelDir = join(suporte, 'gravador-de-calls', 'modelos')
  const manifestDir = join(suporte, 'Google', 'Chrome', 'NativeMessagingHosts')
  const configFile = join(suporte, 'gravador-de-calls', 'config.json')
  for (const d of [binDir, modelDir, manifestDir]) mkdirSync(d, { recursive: true })
  const tools = makeFakeTools(join(home, 'ferramentas'))

  if (manifesto) {
    writeFileSync(
      join(manifestDir, `${HOST_NAME}.json`),
      JSON.stringify({ name: HOST_NAME, path: join(binDir, 'gravador-host.sh'), type: 'stdio', allowed_origins: ['chrome-extension://kpbjnbedejcbakdjacjmhaofidooddjp/'] }),
    )
  }
  if (helper) {
    // A cópia que o Chrome executa (sem rodar npm run instalar): os arquivos do HOST_FILES, e a
    // versão lida do próprio arquivo, como o comando faz.
    for (const f of HOST_FILES as string[]) writeFileSync(join(binDir, f), f === 'gravador-host.mjs' ? `export const HOST_VERSION = '${versaoHelper}'\n` : '// cópia\n')
  }
  if (modelo) writeFileSync(join(modelDir, 'ggml-large-v3-turbo.bin'), 'modelo falso')
  if (config) {
    writeFileSync(
      configFile,
      JSON.stringify({
        ...(raiz ? { root: raiz } : {}),
        transcricao: { ativa, motor: 'whisper-cpp', modelo: '', idioma: 'auto', whisperCli: tools.whisperCli, ffmpeg: tools.ffmpeg },
        // Um campo que esta versão não conhece, como o de uma versão mais nova gravaria. O comando
        // monta o estado campo por campo, então ele nunca sai na saída.
        chaveApiFalsaDeTeste: CHAVE_FALSA,
      }),
    )
  }
  return { home, configFile, manifestDir, binDir, modelDir, tools }
}

/**
 * O estado pelas pastas do caso, sem depender do que esta máquina tem instalado: o PATH e as pastas
 * dos modelos e de reserva entram por parâmetro, e o config.json pelo GRAVADOR_CONFIG (o mesmo
 * caminho que o helper e os outros testes usam para apontar para outro config.json), restaurado no
 * fim. É isso que deixa provar "sem o whisper-cli" numa máquina que tem o whisper instalado.
 */
async function estado(c: Caso, extra: Record<string, unknown> = {}): Promise<VerifyState> {
  const antes = process.env.GRAVADOR_CONFIG
  process.env.GRAVADOR_CONFIG = c.configFile
  try {
    return await collectState({
      home: c.home,
      manifestDir: c.manifestDir,
      binDir: c.binDir,
      modelDirs: [c.modelDir],
      env: { PATH: c.tools.dir },
      fallbackDirs: [],
      ...extra,
    })
  } finally {
    if (antes === undefined) delete process.env.GRAVADOR_CONFIG
    else process.env.GRAVADOR_CONFIG = antes
  }
}

/** Roda o comando de verdade (a saída do processo só existe no processo). */
function rodar(c: Caso, args: string[] = []): { out: string; code: number } {
  try {
    const out = execFileSync(process.execPath, [SCRIPT, ...args], {
      // O HOME falso vale para os dois lados: o configPath() e as pastas da descoberta.
      env: { HOME: c.home, PATH: `${c.tools.dir}:/usr/bin:/bin`, GRAVADOR_CONFIG: c.configFile },
      encoding: 'utf8',
    })
    return { out, code: 0 }
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string }
    return { out: `${err.stdout ?? ''}${err.stderr ?? ''}`, code: err.status ?? -1 }
  }
}

/** Todo arquivo e pasta dentro do HOME falso, para provar que nada foi criado. */
function arvore(dir: string): string[] {
  const out: string[] = []
  const anda = (p: string) => {
    for (const e of readdirSync(p, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(p, e.name)
      out.push(relative(dir, full).split(sep).join('/') + (e.isDirectory() ? '/' : ''))
      if (e.isDirectory()) anda(full)
    }
  }
  anda(dir)
  return out
}

describe('npm run verificar', () => {
  it('com tudo instalado, diz o que achou de cada peça e sai com 0', async () => {
    const c = caso('tudo')
    const s = await estado(c)
    expect(s.pronto).toBe(true)
    expect(s.faltando).toEqual([])
    expect(s.manifesto.instalado).toBe(true)
    expect(s.manifesto.ids).toEqual(['kpbjnbedejcbakdjacjmhaofidooddjp'])
    expect(s.helper).toMatchObject({ instalado: true, versao: HOST_VERSION, versaoProjeto: HOST_VERSION, mesmaVersao: true })
    expect(s.modelo.caminho).toBe(join(c.modelDir, 'ggml-large-v3-turbo.bin'))
    expect(s.whisperCli.caminho).toBe(c.tools.whisperCli)
    expect(s.ffmpeg.caminho).toBe(c.tools.ffmpeg)
    expect(s.transcricao.ativa).toBe(true)

    const { out, code } = rodar(c)
    expect(code).toBe(0)
    // Frases, não despejo de JSON: a última linha é o veredicto, e ela diz a pasta das gravações.
    expect(out).toContain('A ligação com o Chrome está instalada, para 1 extensão: kpbjnbedejcbakdjacjmhaofidooddjp.')
    expect(out).toContain(`O programa que transcreve está instalado na versão ${HOST_VERSION}, a mesma deste projeto.`)
    expect(out).toContain('A transcrição automática está ligada, e é assim que ela já vem: não há nada para digitar na extensão.')
    expect(out.trimEnd().split('\n').at(-1)).toBe(`Tudo pronto: as suas calls vão ser transcritas neste computador, e as gravações vão cair em ${join(c.home, 'Documents', 'Gravações de calls')}.`)
    expect(out).not.toContain('{')
  })

  it('sem o modelo, sai com 1 e diz em que pastas procurou', async () => {
    const c = caso('sem-modelo', { modelo: false })
    const s = await estado(c)
    expect(s.pronto).toBe(false)
    expect(s.faltando).toEqual(['o modelo de reconhecimento de fala'])
    expect(s.modelo.caminho).toBeNull()
    expect(s.modelo.motivo).toMatch(/modelo não encontrado/)
    expect(s.modelo.pastas).toContain(c.modelDir)

    const { out, code } = rodar(c)
    expect(code).toBe(1)
    expect(out).toContain('O modelo de reconhecimento de fala não foi encontrado: baixe um modelo do whisper.cpp')
    // O assunto já está na frase: o motivo do helper não repete "modelo não encontrado" dentro dela.
    expect(out).not.toContain('não foi encontrado: modelo não encontrado')
    expect(out).toContain('Procurei nestas pastas:')
    expect(out).toContain(`  - ${c.modelDir}`)
    expect(out).toContain('Falta 1 coisa: o modelo de reconhecimento de fala.')
  })

  it('sem o whisper-cli, sai com 1 e diz como instalar', async () => {
    const c = caso('sem-whisper')
    rmSync(c.tools.whisperCli)
    const s = await estado(c)
    expect(s.pronto).toBe(false)
    expect(s.whisperCli).toMatchObject({ caminho: null, configurado: true })
    expect(s.whisperCli.motivo).toMatch(/whisper-cli não encontrado em/)
    // O ffmpeg continua achado: o comando diz peça por peça, não "deu erro".
    expect(s.ffmpeg.caminho).toBe(c.tools.ffmpeg)
    expect(s.faltando).toEqual(['o whisper-cli'])

    const { out, code } = rodar(c)
    expect(code).toBe(1)
    expect(out).toContain('O whisper-cli não foi encontrado:')
    expect(out).toContain(`O ffmpeg está em ${c.tools.ffmpeg}.`)
  })

  it('sem o manifesto, sai com 1 e diz que é o npm run instalar que o escreve', async () => {
    const c = caso('sem-manifesto', { manifesto: false })
    const s = await estado(c)
    expect(s.pronto).toBe(false)
    expect(s.manifesto).toMatchObject({ instalado: false, ids: [], erro: null })
    expect(s.faltando).toEqual(['a ligação entre o Chrome e o programa que transcreve'])

    const { out, code } = rodar(c)
    expect(code).toBe(1)
    expect(out).toContain(`A ligação com o Chrome não está instalada: o arquivo ${join(c.manifestDir, `${HOST_NAME}.json`)} não existe.`)
    expect(out).toContain('npm run instalar')
  })

  it('sem a cópia do helper, e com uma cópia de outra versão, diz para rodar o npm run instalar', async () => {
    const semHelper = await estado(caso('sem-helper', { helper: false }))
    expect(semHelper.helper).toMatchObject({ instalado: false, versao: null })
    expect(semHelper.helper.arquivosFaltando).toEqual(HOST_FILES)
    expect(semHelper.faltando).toContain('o programa que transcreve, copiado para fora do projeto')

    const velho = caso('helper-velho', { versaoHelper: '0.4.2' })
    const s = await estado(velho)
    expect(s.helper).toMatchObject({ instalado: true, versao: '0.4.2', mesmaVersao: false })
    expect(s.faltando).toEqual([`o programa que transcreve está na versão 0.4.2 e o projeto está na ${HOST_VERSION}`])
    expect(rodar(velho).out).toContain(`está instalado na versão 0.4.2, e este projeto está na ${HOST_VERSION}: rode "npm run instalar" de novo`)
  })

  it('com a transcrição desligada no config.json, sai com 1 e diz onde ligar', async () => {
    const c = caso('desligada', { ativa: false })
    const s = await estado(c)
    expect(s.transcricao.ativa).toBe(false)
    expect(s.faltando).toEqual(['a transcrição automática, que está desligada'])
    const { out, code } = rodar(c)
    expect(code).toBe(1)
    expect(out).toContain('A transcrição automática está desligada nas configurações da extensão, em Transcrição.')
  })

  it('com uma raiz própria no config.json, a pasta das gravações é a dele', async () => {
    const raiz = join(base, 'raiz-escolhida', 'Calls')
    const c = caso('raiz-propria', { raiz })
    const s = await estado(c)
    expect(s.gravacoes).toMatchObject({ pasta: raiz, origem: 'config', existe: false, temConfig: true })
    const { out } = rodar(c)
    expect(out).toContain(`As gravações vão cair em ${raiz}, que é a pasta escolhida no arquivo de configuração ${c.configFile}.`)
    expect(out).toContain('Essa pasta ainda não existe: ela é criada sozinha na primeira call gravada.')
    expect(out).not.toContain('que é a pasta padrão')
  })

  it('sem config.json, a pasta das gravações é a padrão, e ele diz que é a padrão', async () => {
    const c = caso('sem-config', { config: false })
    // Sem config.json o helper não sabe onde estão os programas: o PATH do caso resolve.
    const s = await estado(c)
    // No processo do teste o `~` da raiz padrão é o HOME de verdade (quem expande é o `expandHome`
    // do helper, reusado de propósito); o HOME falso vale no comando rodado abaixo.
    expect(s.gravacoes).toMatchObject({ origem: 'padrao', temConfig: false, config: c.configFile })
    expect(s.gravacoes.pasta.endsWith(join('Documents', 'Gravações de calls'))).toBe(true)
    expect(s.pronto).toBe(true)
    const { out, code } = rodar(c)
    expect(code).toBe(0)
    expect(out).toContain(`As gravações vão cair em ${join(c.home, 'Documents', 'Gravações de calls')}, que é a pasta padrão (o arquivo de configuração não escolheu outra).`)
  })

  it('--json imprime o mesmo estado na forma que quem automatiza espera', async () => {
    const c = caso('json')
    const { out, code } = rodar(c, ['--json'])
    expect(code).toBe(0)
    const s = JSON.parse(out) as VerifyState
    expect(s.versao).toBe(1)
    expect(Object.keys(s)).toEqual(['versao', 'pronto', 'faltando', 'manifesto', 'helper', 'gravacoes', 'modelo', 'whisperCli', 'ffmpeg', 'transcricao'])
    expect(s).toMatchObject({
      pronto: true,
      faltando: [],
      manifesto: { arquivo: join(c.manifestDir, `${HOST_NAME}.json`), instalado: true, ids: ['kpbjnbedejcbakdjacjmhaofidooddjp'], erro: null },
      helper: { pasta: c.binDir, instalado: true, arquivosFaltando: [], versao: HOST_VERSION, versaoProjeto: HOST_VERSION, mesmaVersao: true },
      gravacoes: { pasta: join(c.home, 'Documents', 'Gravações de calls'), origem: 'padrao', existe: false, config: c.configFile, temConfig: true },
      modelo: { caminho: join(c.modelDir, 'ggml-large-v3-turbo.bin'), bytes: statSync(join(c.modelDir, 'ggml-large-v3-turbo.bin')).size, configurado: false, motivo: null },
      whisperCli: { caminho: c.tools.whisperCli, configurado: true, motivo: null },
      ffmpeg: { caminho: c.tools.ffmpeg, configurado: true, motivo: null },
      transcricao: { ativa: true, motor: 'whisper-cpp', idioma: 'auto' },
    })
    // O tamanho em GB sai no formato de quem lê (o comando fala português).
    expect(gbLabel(1_624_555_275)).toBe('1,6 GB')
  })

  it('a chave da API nunca aparece na saída, nem nas frases nem no JSON', async () => {
    const c = caso('sem-segredo')
    // O config.json do caso tem o valor falso; o helper devolve o arquivo inteiro em readConfig.
    expect(readFileSync(c.configFile, 'utf8')).toContain(CHAVE_FALSA)
    const s = await estado(c)
    expect(JSON.stringify(s)).not.toContain(CHAVE_FALSA)
    expect(JSON.stringify(s)).not.toContain('chaveApiFalsaDeTeste')
    for (const args of [[], ['--json']]) {
      const { out } = rodar(c, args)
      expect(out, args.join(' ')).not.toContain(CHAVE_FALSA)
      expect(out, args.join(' ')).not.toContain('chaveApi')
    }
  })

  it('só lê: depois de rodar, nada apareceu no HOME falso', async () => {
    const c = caso('so-le', { modelo: false, manifesto: false })
    const antes = arvore(c.home)
    expect(rodar(c).code).toBe(1)
    expect(rodar(c, ['--json']).code).toBe(1)
    expect(arvore(c.home)).toEqual(antes)
    // E nenhuma das pastas que o comando nomeia foi criada (o config.json, a raiz, o manifesto).
    expect(antes).not.toContain('Documents/')
  })
})
