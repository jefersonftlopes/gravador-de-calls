// Camada de DOM do vigia, uma implementação por plataforma com a mesma interface (Emenda 3).
//
// Teams: exatamente os seletores e a regex do script do usuário (docs/referencia/vigia-original.js):
// #hangup-button, #microphone-button, #call-duration-custom, [id^="roster-title-section"],
// #roster-participants-search-input e #roster-button (o vigia abre o painel People se precisar).
//
// Meet (Emendas 3 e 6; seletores com data em docs/pesquisa/vigia-meet-2026-10-06.json):
// - em call: os mesmos sinais do adaptador (src/main-world/platforms/meet.ts): URL com código,
//   botão de sair E ícone de legenda ou chat E sem o cabeçalho de saída h1[jsname="r4nke"]; depois
//   de ver a call, os ícones deixam de ser exigidos (Emenda 10);
// - sair: button[jsname="CQylAd"] ou o botão cujo ícone .google-symbols tem o texto call_end;
// - contagem: [data-avatar-count] (selo ao lado dos avatares, interface desde dez/2025; inteiro
//   > 0, inclui você, então "sozinho" é 1 como no Teams); reserva só com o painel de pessoas JÁ
//   aberto (nomes únicos de [role="listitem"][data-participant-id] dentro de [role="list"], só da
//   seção de quem está na call, sem as linhas de apresentação e de áudio mesclado); último
//   recurso, a interface antiga;
// - `abrirPainel` nunca clica (o painel divide espaço com o chat) e devolve false;
// - blocos de vídeo ([data-participant-id] fora da lista) nunca disparam saída: só diagnóstico.
import { meetCodeOfPath } from '../../shared/hosts'
import type { Platform } from '../../shared/protocol'
import { FONTE_BOTAO_PESSOAS, FONTE_BOTAO_PESSOAS_ANTIGO, FONTE_PAINEL_PEOPLE, FONTE_PAINEL_PESSOAS, FONTE_TEXTO_DA_PAGINA } from '../../shared/vigia-source'

export interface Contagem {
  n: number | null
  /** "botão de pessoas", "painel de pessoas", "painel People", "texto da página"... */
  fonte: string | null
}

export interface ContagemPlataforma {
  /**
   * Está na call? `jaNaCall`: a rodada já viu a call (Emenda 10). No Meet os ícones de legenda e
   * chat só separam a sala de espera no começo; numa janela estreita eles vão para o menu "mais
   * opções" e a call continua.
   */
  emCall(jaNaCall?: boolean): boolean
  botaoSair(): HTMLElement | null
  painelAberto(): boolean
  /** Abre o painel de pessoas (uma vez) para conseguir contar. Devolve se clicou em algo. No Meet, nunca. */
  abrirPainel(): boolean
  contar(): Contagem
  /** Só diagnóstico: blocos de vídeo na tela (Meet). Nunca entra na régua. */
  blocosDeVideo?(): number
}

const $ = (s: string): HTMLElement | null => document.querySelector<HTMLElement>(s)

// ---------------------------------------------------------------------------------------------
// Teams: o script, sem mudar seletor nem regex
// ---------------------------------------------------------------------------------------------

/** Regex do script para o título do painel People ("In this meeting (N)", "Nesta reunião (N)"). */
export const RE_NA_REUNIAO = /(?:in this meeting|in the meeting|nesta reuni[aã]o|na reuni[aã]o|em reuni[aã]o)\D{0,20}?(\d{1,4})/i
/** Reserva do script: a mesma frase no começo de uma linha do texto da página. */
export const RE_TEXTO_PAGINA = /^\s*(?:in this meeting|nesta reuni[aã]o|na reuni[aã]o)\s*\((\d{1,4})\)/im

/** Contagem no aria-label + texto de um [id^="roster-title-section"] (null se não casar). */
export function contagemDoTitulo(texto: string): number | null {
  const m = texto.match(RE_NA_REUNIAO)
  return m ? +m[1] : null
}

export function contagemDoTextoDaPagina(texto: string): number | null {
  const m = texto.match(RE_TEXTO_PAGINA)
  return m ? +m[1] : null
}

export const teams: ContagemPlataforma = {
  botaoSair: () => $('#hangup-button'),
  emCall: () => !!($('#hangup-button') || $('#microphone-button') || $('#call-duration-custom')),
  painelAberto: () => !!($('#roster-participants-search-input') || $('[id^="roster-title-section"]')),
  abrirPainel() {
    const b = $('#roster-button')
    if (!b) return false
    b.click()
    return true
  },
  contar() {
    for (const el of Array.from(document.querySelectorAll('[id^="roster-title-section"]'))) {
      const n = contagemDoTitulo((el.getAttribute('aria-label') || '') + ' ' + el.textContent)
      if (n != null) return { n, fonte: FONTE_PAINEL_PEOPLE }
    }
    const n = contagemDoTextoDaPagina(document.body?.innerText ?? '')
    if (n != null) return { n, fonte: FONTE_TEXTO_DA_PAGINA }
    return { n: null, fonte: null }
  },
}

// ---------------------------------------------------------------------------------------------
// Meet
// ---------------------------------------------------------------------------------------------

const MEET_LEAVE = 'button[jsname="CQylAd"]'
const MEET_EXIT_HEADING = 'h1[jsname="r4nke"]'
const MEET_CAPTION_OR_CHAT = new Set(['closed_caption', 'closed_caption_off', 'chat'])
const MEET_PANEL_ROWS = '[role="list"] [role="listitem"][data-participant-id]'
const MEET_ROW = '[role="listitem"][data-participant-id]'
/**
 * Rótulo da seção "na call" do painel (localizado; pt-BR sem fonte, palpite). Emenda 10: as linhas
 * de "Aguardando para participar" e "Também convidados" têm a mesma marcação e ficam de fora.
 */
const RE_SECAO_NA_CALL = /^(in call|in the call|na chamada|na call|em chamada|nesta chamada|contributors|colaboradores)$/i

/**
 * Quais linhas contam, a partir das seções ([role="region"]) do painel que têm linhas de pessoas
 * (função pura, testada com vitest). Sem seção: todas (interface sem seções). Uma seção só: ela
 * (quem aguarda ou foi convidado sempre vem junto de quem está na call). Várias: a da call, pelo
 * rótulo; sem achar qual é, null (não conta, para não sair por gente que nem entrou).
 */
export function linhasDasSecoes<T>(secoes: ReadonlyArray<{ label: string; linhas: T[] }>, semSecao: T[]): T[] | null {
  if (secoes.length === 0) return semSecao
  if (secoes.length === 1) return secoes[0].linhas
  const naCall = secoes.find((s) => RE_SECAO_NA_CALL.test(s.label.trim()))
  return naCall ? naCall.linhas : null
}

function linhasDoPainelNaCall(): HTMLElement[] | null {
  const secoes = Array.from(document.querySelectorAll<HTMLElement>('[role="region"]'))
    .map((r) => ({ label: r.getAttribute('aria-label') ?? '', linhas: Array.from(r.querySelectorAll<HTMLElement>(MEET_ROW)) }))
    .filter((r) => r.linhas.length > 0)
  return linhasDasSecoes(secoes, Array.from(document.querySelectorAll<HTMLElement>(MEET_PANEL_ROWS)))
}

/** Valor de [data-avatar-count]: só inteiro > 0 vale (inclui você). */
export function contagemDoSelo(valor: string | null): number | null {
  if (valor == null || valor.trim() === '') return null
  const n = Number(valor)
  return Number.isInteger(n) && n > 0 ? n : null
}

/** Linha de apresentação ("Apresentação", "Presentation", "apresentação de Fulano", "Apresentando"). */
const RE_APRESENTACAO = /^(apresenta[çc][ãa]o|presentation|apresentando)(\s+(de|d[ao]|of)\s+.+)?$|^.+\s+\((apresenta[çc][ãa]o|presentation)\)$|'s presentation$/i
const RE_AUDIO_MESCLADO = /[áa]udio mesclado|merged audio|adaptive audio group/i

export interface LinhaDoPainel {
  /** aria-label da linha (o nome de exibição no Meet). */
  label: string
  /** Texto visível da linha. */
  text: string
}

/** Nome de exibição de uma linha do painel, ou null se ela não é uma pessoa. */
export function nomeDaLinha(l: LinhaDoPainel): string | null {
  const label = l.label.trim()
  const primeira = l.text.trim().split('\n')[0]?.trim() ?? ''
  const nome = label || primeira
  if (!nome) return null
  if (RE_AUDIO_MESCLADO.test(label) || RE_AUDIO_MESCLADO.test(l.text)) return null
  if (RE_APRESENTACAO.test(nome) || (primeira && RE_APRESENTACAO.test(primeira))) return null
  return nome
}

/** Pessoas únicas no painel (sem apresentações nem áudio mesclado). 0 vira null (não conta). */
export function contagemDoPainel(linhas: readonly LinhaDoPainel[]): number | null {
  const nomes = new Set<string>()
  for (const l of linhas) {
    const nome = nomeDaLinha(l)
    if (nome) nomes.add(nome.toLocaleLowerCase('pt-BR'))
  }
  return nomes.size > 0 ? nomes.size : null
}

/** Interface antiga: "People - 3 joined", badge com o número. */
export function contagemAntiga(texto: string | null): number | null {
  const m = /(\d+)/.exec(texto ?? '')
  if (!m) return null
  const n = Number(m[1])
  return n > 0 ? n : null
}

function visivel(el: Element): boolean {
  const check = (el as Element & { checkVisibility?: () => boolean }).checkVisibility
  return typeof check === 'function' ? check.call(el) : true
}

function iconesMeet(): Set<string> {
  const out = new Set<string>()
  for (const el of Array.from(document.querySelectorAll('.google-symbols'))) {
    const t = el.textContent?.trim()
    if (t) out.add(t)
  }
  return out
}

function botaoSairMeet(): HTMLElement | null {
  const b = $(MEET_LEAVE)
  if (b) return b
  for (const el of Array.from(document.querySelectorAll('.google-symbols'))) {
    if (el.textContent?.trim() !== 'call_end') continue
    const btn = el.closest<HTMLElement>('button, [role="button"]')
    if (btn) return btn
  }
  return null
}

export const meet: ContagemPlataforma = {
  botaoSair: botaoSairMeet,
  emCall(jaNaCall = false) {
    if (!meetCodeOfPath(location.pathname)) return false
    for (const h of Array.from(document.querySelectorAll(MEET_EXIT_HEADING))) if (visivel(h)) return false
    if (!botaoSairMeet()) return false
    if (jaNaCall) return true
    const icones = iconesMeet()
    for (const nome of MEET_CAPTION_OR_CHAT) if (icones.has(nome)) return true
    return false
  },
  painelAberto: () => document.querySelector(MEET_PANEL_ROWS) !== null,
  // Nunca abre: o painel de pessoas e o chat dividem o mesmo espaço (Emendas 3 e 6).
  abrirPainel: () => false,
  contar() {
    for (const el of Array.from(document.querySelectorAll('[data-avatar-count]'))) {
      const n = contagemDoSelo(el.getAttribute('data-avatar-count'))
      if (n != null) return { n, fonte: FONTE_BOTAO_PESSOAS }
    }
    const linhas = (linhasDoPainelNaCall() ?? []).map((el) => ({
      label: el.getAttribute('aria-label') ?? '',
      text: el.innerText ?? el.textContent ?? '',
    }))
    const doPainel = contagemDoPainel(linhas)
    if (doPainel != null) return { n: doPainel, fonte: FONTE_PAINEL_PESSOAS }
    const antigos: Array<() => number | null> = [
      () => contagemAntiga($('button[aria-label^="People - "]')?.getAttribute('aria-label') ?? null),
      () => contagemAntiga($('div.egzc7c')?.textContent ?? null),
      () => contagemAntiga($('.uGOf1d')?.textContent ?? null),
    ]
    for (const ler of antigos) {
      const n = ler()
      if (n != null) return { n, fonte: FONTE_BOTAO_PESSOAS_ANTIGO }
    }
    return { n: null, fonte: null }
  },
  blocosDeVideo: () => document.querySelectorAll('[data-participant-id]:not([role="listitem"])').length,
}

export function contagemPara(platform: Platform): ContagemPlataforma {
  return platform === 'meet' ? meet : teams
}
