// Pacote da Chrome Web Store (Emenda 15): o build com GRAVADOR_LOJA=1 sai sem a chave, sem o
// gancho de teste `globalThis.__gravador` e sem o registro de ganchos, com o site em homepage_url,
// com as duas línguas em _locales, sem código remoto, e com o resto do manifesto igual ao do build
// de desenvolvimento. Os dois builds vão para pastas temporárias (o dist/ não é tocado).
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ROOT } from '../helpers/paths'

const base = mkdtempSync(join(tmpdir(), 'gravador-pacote-loja-'))
const STORE = join(base, 'loja')
const DEV = join(base, 'dev')

function build(outDir: string, store: boolean) {
  const env = { ...process.env }
  if (store) env.GRAVADOR_LOJA = '1'
  else delete env.GRAVADOR_LOJA
  const r = spawnSync(join(ROOT, 'node_modules', '.bin', 'vite'), ['build', '--outDir', outDir, '--emptyOutDir', '--logLevel', 'error'], { cwd: ROOT, env, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`vite build falhou: ${r.stderr}`)
}

function files(dir: string, ext: RegExp): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...files(p, ext))
    else if (ext.test(name)) out.push(p)
  }
  return out
}

const manifestOf = (dir: string) => JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as Record<string, unknown>
/** `__gravador` sozinho (o `__gravador__` da ponte MAIN <-> relay é outra coisa). */
const HOOK_RE = /__gravador(?!__)/
/** O teste do zod que vê se pode compilar com Function() (zod/v4/core/util.js, `allowsEval`), minificado. */
const ZOD_EVAL_PROBE = /try\{return Function\(``\),!0\}catch\{return!1\}/g
const withHook = (dir: string) => files(dir, /\.js$/).filter((f) => HOOK_RE.test(readFileSync(f, 'utf8'))).map((f) => relative(dir, f))

beforeAll(() => {
  build(STORE, true)
  build(DEV, false)
}, 120_000)
afterAll(() => rmSync(base, { recursive: true, force: true }))

describe('pacote da loja (GRAVADOR_LOJA=1)', () => {
  it('sem a chave e com o site em homepage_url; o de desenvolvimento continua com a chave e sem homepage_url', () => {
    const store = manifestOf(STORE)
    const dev = manifestOf(DEV)
    expect(store).not.toHaveProperty('key')
    expect(store.homepage_url).toBe('https://gravador-de-calls.vercel.app')
    expect(dev).toHaveProperty('key')
    expect(dev).not.toHaveProperty('homepage_url')
  })

  it('nenhum arquivo do pacote da loja tem o gancho __gravador (o de desenvolvimento tem)', () => {
    expect(withHook(DEV).length).toBeGreaterThan(0)
    expect(withHook(STORE)).toEqual([])
    // O registro dos ganchos também some: nenhum nome de gancho de teste sobra no código.
    const sw = files(STORE, /\.js$/).map((f) => readFileSync(f, 'utf8')).join('\n')
    for (const name of ['holdPersistAt', 'fakeVigiaTabState', 'markTabsOpenedBeforeInstall', 'noAudioAlertMs', 'fakeWorkerVersion', 'dropUiRequests', 'failTabStreamId', 'fakeAutoReload']) expect(sw, name).not.toContain(name)
  })

  it('recarga sozinha só fora da loja (Emenda 17): o pacote da loja nem lê o publicado.json; os dois têm o versao.json', () => {
    const js = (dir: string) => files(dir, /\.js$/).map((f) => readFileSync(f, 'utf8')).join('\n')
    expect(js(DEV)).toContain('publicado.json')
    expect(js(STORE)).not.toContain('publicado.json')
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }
    for (const dir of [DEV, STORE]) {
      const info = JSON.parse(readFileSync(join(dir, 'versao.json'), 'utf8')) as { version: string; build: string }
      expect(info.version).toBe(pkg.version)
      expect(info.build).toMatch(/^[0-9a-f]{12}$/)
      // O build embutido no código é o mesmo do versao.json.
      expect(js(dir)).toContain(info.build)
    }
  })

  it('o resto do manifesto é igual ao de desenvolvimento (nomes de arquivo com hash à parte)', () => {
    const strip = (m: Record<string, unknown>) => {
      // As permissões de host têm teste próprio: o build de desenvolvimento leva também o loopback
      // do servidor falso dos testes (Emenda 21).
      const { key: _k, homepage_url: _h, background: _b, content_scripts: cs, web_accessible_resources: _w, optional_host_permissions: _o, host_permissions: _hp, ...rest } = m
      const scripts = (cs as Array<Record<string, unknown>>).map(({ js: _js, ...c }) => c)
      return { ...rest, content_scripts: scripts }
    }
    expect(strip(manifestOf(STORE))).toEqual(strip(manifestOf(DEV)))
  })

  it('traduzido: default_locale en, __MSG_ no nome, descrição, título e atalho, e as duas línguas em _locales', () => {
    const m = manifestOf(STORE) as { name: string; description: string; default_locale: string; action: { default_title: string }; commands: Record<string, { description: string }> }
    expect(m.default_locale).toBe('en')
    expect(m.name).toBe('__MSG_extName__')
    expect(m.description).toBe('__MSG_extDescription__')
    expect(m.action.default_title).toBe('__MSG_actionTitle__')
    expect(m.commands['gravar-aba'].description).toBe('__MSG_commandTabMode__')
    for (const l of ['en', 'pt_BR']) expect(existsSync(join(STORE, '_locales', l, 'messages.json')), l).toBe(true)
    expect(existsSync(join(STORE, 'src', 'welcome', 'index.html'))).toBe(true)
  })

  it('sem código remoto (Manifest V3): nenhum script de fora, importScripts, import() de URL, eval ou Function()', () => {
    for (const f of files(STORE, /\.html$/)) expect(readFileSync(f, 'utf8'), relative(STORE, f)).not.toMatch(/<script[^>]+src=["']?(https?:)?\/\//i)
    let probes = 0
    for (const f of files(STORE, /\.js$/)) {
      const raw = readFileSync(f, 'utf8')
      // O único Function() permitido é o teste do zod (`allowsEval`), que com `jitless` nem roda
      // (src/shared/zod.ts): o arquivo que o tem tem de ligar o jitless antes dos schemas.
      const code = raw.replace(ZOD_EVAL_PROBE, () => {
        probes++
        return ''
      })
      if (code !== raw) expect(raw, `${relative(STORE, f)}: o zod sem jitless`).toMatch(/\(\{jitless:!0\}\)/)
      expect(code, relative(STORE, f)).not.toMatch(/importScripts\s*\(|import\(\s*["'`]https?:|\beval\s*\(|\bFunction\s*\(/)
    }
    // O zod é usado (SW e telas): se o teste dele sumir do pacote, esta conferência precisa mudar.
    expect(probes).toBeGreaterThan(0)
  })

  it('o relay (content script em toda frame das calls) não carrega o zod', () => {
    const relay = readFileSync(join(STORE, 'src', 'content', 'relay.js'), 'utf8')
    expect(relay).not.toMatch(ZOD_EVAL_PROBE)
    expect(relay).not.toContain('jitless')
  })

  it('as permissões são as revisadas na Emenda 15 (docs/LOJA.md tem a justificativa de cada uma)', () => {
    const m = manifestOf(STORE) as { permissions: string[]; host_permissions: string[] }
    expect([...m.permissions].sort()).toEqual(['activeTab', 'alarms', 'downloads', 'nativeMessaging', 'notifications', 'offscreen', 'storage', 'tabCapture', 'unlimitedStorage'])
    // Emenda 17: os quatro hosts das calls e, para cada um, as formas pelo proxy do Defender for Cloud Apps.
    expect(m.host_permissions).toEqual([
      'https://meet.google.com/*',
      'https://meet.google.com.mcas.ms/*',
      'https://meet.google.com.mcas-gov.us/*',
      'https://meet.google.com.mcas-gov.ms/*',
      'https://teams.microsoft.com/*',
      'https://teams.cloud.microsoft/*',
      'https://teams.live.com/*',
      'https://teams.microsoft.com.mcas.ms/*',
      'https://teams.microsoft.com.mcas-gov.us/*',
      'https://teams.microsoft.com.mcas-gov.ms/*',
      'https://teams.cloud.microsoft.mcas.ms/*',
      'https://teams.cloud.microsoft.mcas-gov.us/*',
      'https://teams.cloud.microsoft.mcas-gov.ms/*',
      'https://teams.live.com.mcas.ms/*',
      'https://teams.live.com.mcas-gov.us/*',
      'https://teams.live.com.mcas-gov.ms/*',
    ])
    const doc = readFileSync(join(ROOT, 'docs', 'LOJA.md'), 'utf8')
    for (const p of m.permissions) expect(doc, p).toContain(`\`${p}\``)
  })

  it('listagens e políticas de privacidade justificam todas as permissões do manifesto, e só elas', () => {
    const m = manifestOf(STORE) as { permissions: string[]; host_permissions: string[] }
    const docs = ['docs/loja/listagem-en.md', 'docs/loja/listagem-pt_BR.md', 'site/privacidade.html', 'site/en/privacy.html']
    // Nomes de permissão conhecidos do Chrome que a extensão não pede: não podem aparecer como justificadas.
    const notRequested = ['tabs', 'scripting', 'webRequest', 'cookies', 'history', 'identity', 'clipboardRead', 'debugger']
    for (const f of docs) {
      const text = readFileSync(join(ROOT, f), 'utf8')
      for (const p of m.permissions) expect(text, `${f}: ${p}`).toMatch(new RegExp(`(\`|<code>)${p}(\`|</code>)`))
      for (const p of notRequested) expect(text, `${f}: ${p}`).not.toMatch(new RegExp(`(\`|<code>)${p}(\`|</code>)`))
    }
    for (const f of docs.slice(0, 2)) {
      const text = readFileSync(join(ROOT, f), 'utf8')
      for (const h of m.host_permissions) expect(text, `${f}: ${h}`).toContain(h)
    }
    // As políticas falam dos hosts pelo nome (e do proxy do Defender for Cloud Apps, Emenda 17).
    for (const f of docs.slice(2)) {
      const text = readFileSync(join(ROOT, f), 'utf8')
      for (const h of ['meet.google.com', 'teams.microsoft.com', 'teams.cloud.microsoft', 'teams.live.com', '.mcas.ms', '.mcas-gov.us', '.mcas-gov.ms', 'Defender for Cloud Apps'])
        expect(text, `${f}: ${h}`).toContain(h)
    }
  })

  it('a permissão opcional da API de transcrição: só api.openai.com na loja, nada de https://*/* (Emenda 21)', () => {
    const store = manifestOf(STORE) as { optional_host_permissions: string[] }
    const dev = manifestOf(DEV) as { optional_host_permissions: string[] }
    expect(store.optional_host_permissions).toEqual(['https://api.openai.com/*'])
    // Nada de curinga, e nenhuma origem que não seja https no pacote da loja.
    for (const o of store.optional_host_permissions) {
      expect(o.startsWith('https://'), o).toBe(true)
      expect(o, o).not.toMatch(/^https:\/\/\*/)
    }
    // Os dois builds pedem a mesma permissão opcional; o loopback do servidor falso dos testes
    // entra em host_permissions do build de desenvolvimento, nunca no pacote da loja.
    expect(dev.optional_host_permissions).toEqual(['https://api.openai.com/*'])
    const storeHosts = (manifestOf(STORE) as { host_permissions: string[] }).host_permissions
    const devHosts = (manifestOf(DEV) as { host_permissions: string[] }).host_permissions
    expect(storeHosts).not.toContain('http://127.0.0.1/*')
    expect(storeHosts.every((h) => h.startsWith('https://'))).toBe(true)
    expect(devHosts).toEqual([...storeHosts, 'http://127.0.0.1/*'])
    const doc = readFileSync(join(ROOT, 'docs', 'LOJA.md'), 'utf8')
    for (const o of store.optional_host_permissions) expect(doc, o).toContain(o)
  })

  it('o site do homepage_url e a política citada nas listagens existem em site/', () => {
    const home = (manifestOf(STORE) as { homepage_url: string }).homepage_url
    for (const [lang, page, file] of [['en', '/en/privacy', 'site/en/privacy.html'], ['pt_BR', '/privacidade', 'site/privacidade.html']] as const) {
      expect(existsSync(join(ROOT, file)), file).toBe(true)
      expect(readFileSync(join(ROOT, 'docs', 'loja', `listagem-${lang}.md`), 'utf8'), lang).toContain(`${home}${page}`)
    }
  })
})
