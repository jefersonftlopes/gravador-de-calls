// Diálogo do organizador no Meet (Emenda 3). Para quem organiza com o controle de organizador
// ligado, o clique em sair (button[jsname="CQylAd"]) só abre um diálogo com "sair" e "encerrar
// para todos". O primeiro clique nunca encerra para todos: o risco está todo no segundo.
//
// Regra: esperar até ~2 s por [role="dialog"], [role="alertdialog"] ou [data-mdc-dialog-action] e
// clicar só no botão cujo texto ou aria-label (aparado) bate com a lista de "só sair" E cujo
// texto e aria-label não batem com a lista de "encerrar". [data-mdc-dialog-action="Pd96ce"] é só
// uma dica: ele também passa pelos dois testes. Se nenhum botão passar, não clica em nada.

/** "Só sair", frase inteira (en e pt-BR). */
export const RE_SO_SAIR = /^(just leave( the call)?|leave meeting|leave call|apenas sair( da chamada)?|sair da reuni[aã]o|sair da chamada)$/i
/** Qualquer sinal de "encerrar para todos". */
export const RE_ENCERRAR = /everyone|for all|todos|encerrar|^end /i

const DIALOGOS = '[role="dialog"], [role="alertdialog"]'
const BOTOES = 'button, [role="button"], [data-mdc-dialog-action]'
export const ESPERA_DIALOGO_MS = 2000
const PASSO_MS = 100

export interface OpcaoDoDialogo {
  text: string
  label: string
}

const limpar = (s: string) => s.replace(/\s+/g, ' ').trim()

/** O botão passa nos dois testes? (texto OU aria-label é "só sair", e NENHUM dos dois é "encerrar"). */
export function ehSoSair(o: OpcaoDoDialogo): boolean {
  const text = limpar(o.text)
  const label = limpar(o.label)
  const soSair = RE_SO_SAIR.test(text) || RE_SO_SAIR.test(label)
  const encerra = (text !== '' && RE_ENCERRAR.test(text)) || (label !== '' && RE_ENCERRAR.test(label))
  return soSair && !encerra
}

/** Índice da opção segura para clicar, ou null se nenhuma passa nos dois testes. */
export function escolherSoSair(opcoes: readonly OpcaoDoDialogo[]): number | null {
  const i = opcoes.findIndex(ehSoSair)
  return i >= 0 ? i : null
}

export type ResultadoDialogo =
  | { t: 'sem-dialogo' }
  | { t: 'clicou'; texto: string }
  | { t: 'inseguro'; opcoes: string[] }

function visivel(el: Element): boolean {
  const check = (el as Element & { checkVisibility?: () => boolean }).checkVisibility
  return typeof check === 'function' ? check.call(el) : true
}

/** Botões dos diálogos visíveis agora, mais os [data-mdc-dialog-action] soltos. */
function botoesDoDialogo(): HTMLElement[] {
  const out = new Set<HTMLElement>()
  for (const d of Array.from(document.querySelectorAll<HTMLElement>(DIALOGOS))) {
    if (!visivel(d)) continue
    for (const b of Array.from(d.querySelectorAll<HTMLElement>(BOTOES))) if (visivel(b)) out.add(b)
  }
  for (const b of Array.from(document.querySelectorAll<HTMLElement>('[data-mdc-dialog-action]'))) if (visivel(b)) out.add(b)
  return [...out]
}

function haDialogo(): boolean {
  for (const d of Array.from(document.querySelectorAll(DIALOGOS))) if (visivel(d)) return true
  return botoesDoDialogo().length > 0
}

const opcaoDe = (b: HTMLElement): OpcaoDoDialogo => ({ text: b.innerText ?? b.textContent ?? '', label: b.getAttribute('aria-label') ?? '' })

/**
 * Depois do clique em sair: espera um diálogo por até `esperaMs`. Sem diálogo, a saída já
 * aconteceu (ou acontece sozinha). Com diálogo, clica só no "só sair"; se nenhum botão passa,
 * não clica em nada e devolve "inseguro".
 */
export async function confirmarSaidaMeet(saiu: () => boolean, esperaMs = ESPERA_DIALOGO_MS): Promise<ResultadoDialogo> {
  const t0 = Date.now()
  let viuDialogo = false
  for (;;) {
    // Participante comum: o clique já tirou da call (o botão de sair sumiu). Vale mesmo com um
    // [role="dialog"] alheio na tela (o balão do botão de pessoas, por exemplo): para quem
    // organiza, o botão de sair continua na tela enquanto o diálogo dele está aberto.
    if (saiu()) return { t: 'sem-dialogo' }
    const dialogo = haDialogo()
    if (dialogo) {
      viuDialogo = true
      const botoes = botoesDoDialogo()
      const i = escolherSoSair(botoes.map(opcaoDe))
      if (i != null) {
        const b = botoes[i]
        const texto = limpar(opcaoDe(b).text) || limpar(opcaoDe(b).label)
        b.click()
        return { t: 'clicou', texto }
      }
    }
    if (Date.now() - t0 >= esperaMs) break
    await new Promise((r) => setTimeout(r, PASSO_MS))
  }
  // Um diálogo que apareceu e sumiu sozinho não foi respondido por nós: a próxima leitura vê se
  // o botão de sair continua na tela, como no script.
  if (!viuDialogo || !haDialogo()) return { t: 'sem-dialogo' }
  return { t: 'inseguro', opcoes: botoesDoDialogo().map((b) => limpar(opcaoDe(b).text) || limpar(opcaoDe(b).label)) }
}
