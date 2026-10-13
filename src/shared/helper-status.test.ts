// O que as telas dizem sobre o helper (Emenda 10): "não instalado" e "instalado, mas não abre" são
// problemas diferentes, com soluções diferentes, e o erro de verdade aparece.
import { afterEach, describe, expect, it } from 'vitest'
import { helperProblem } from './helper-status'
import { setLanguage } from './i18n'

afterEach(() => setLanguage('auto'))

const off = (error: string) => ({ ok: false, version: null, root: null, writable: false, error })

describe('helperProblem', () => {
  it('sem o manifesto: não instalado', () => {
    expect(helperProblem(off('Specified native messaging host not found.'))).toMatchObject({ kind: 'nao-instalado' })
  })

  it('o Chrome acha o manifesto mas o helper não abre (node sumiu, wrapper sem execução, repositório movido): manda reinstalar e mostra o erro', () => {
    for (const e of ['Native host has exited.', 'Failed to start native messaging host.', 'Error when communicating with the native messaging host.', 'helper não respondeu a ping em 5000 ms']) {
      const p = helperProblem(off(e))
      expect(p.kind, e).toBe('nao-abre')
      expect(p.text).toContain(e)
      expect(p.text).toContain('npm run instalar')
    }
  })

  it('Emenda 19: o motivo que o SW guardou em português sai no idioma escolhido depois, sem frase misturada', () => {
    setLanguage('en')
    const p = helperProblem(off('helper não respondeu a ping em 5000 ms'))
    expect(p.kind).toBe('nao-abre')
    expect(p.text).toContain('(helper did not answer ping within 5000 ms)')
    expect(p.text).not.toMatch(/não|respondeu/)
  })

  it('o helper abre mas não consegue gravar na pasta: diz isso, não "não instalado"', () => {
    expect(helperProblem({ ok: true, version: '0.1.0', root: '/Volumes/Externo/Calls', writable: false, error: null })).toMatchObject({ kind: 'sem-permissao' })
  })

  it('tudo certo', () => {
    expect(helperProblem({ ok: true, version: '0.1.0', root: '/x', writable: true, error: null })).toEqual({ kind: 'ok', text: '' })
  })
})
