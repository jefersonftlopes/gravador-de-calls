// Vigia (Emendas 2 e 3): content script ISOLATED, só na frame do topo das calls. Porte do laço
// `tick` do script do usuário (docs/referencia/vigia-original.js): lê quantas pessoas estão na
// call, sai sozinho quando ela esvazia e pede ao SW para fechar a aba depois de salvar a
// gravação. Fala com o SW pelo Port "gravador:vigia" (VigiaUp/VigiaDown).
//
// O que muda em relação ao script, de propósito:
// - fechar a aba: em vez de window.close() + about:blank, manda `vigia:fechar-aba` e o SW fecha
//   com chrome.tabs.remove depois de a gravação ficar salva (até 20 s);
// - antes do primeiro clique em sair manda `vigia:saindo` (o info.json ganha saidaAutomatica);
// - no Meet, depois do clique em sair, responde o diálogo do organizador só com "sair"
//   (./dialogo.ts); se não houver um botão seguro, não clica, para de tentar e avisa o SW;
// - a configuração vem do SW (vigia:config) e vale na próxima leitura (o intervalo também);
// - o indicador mostra também de onde veio a contagem (Emenda 3);
// - "Desligar nesta call" (e a desistência no diálogo do Meet) vale até a próxima call da aba,
//   mesmo sem recarregar: parado, o vigia só confere se a call acabou (faltasParaFim leituras
//   sem ela) e voltou, e aí recomeça do zero e avisa o SW (vigia:nesta-call, Emenda 7).
// - extensão recarregada, atualizada ou desligada com a aba aberta (Emenda 10): o content script
//   antigo fica órfão, sem Port nem configuração nova. Ele confere `chrome.runtime.id` antes de
//   cada leitura e de cada clique e, órfão, para de vez (nunca clica em sair). E uma cópia nova do
//   vigia na mesma aba avisa a antiga por um evento no document, que para (o `window.__vigia` do
//   script).
// - Emenda 19: o indicador sai no idioma escolhido nas configurações e é reescrito na hora em que
//   ele muda (a mensagem mostrada é uma função da leitura, não um texto pronto), sem esperar a
//   próxima leitura.
// O resto (régua, faltas, tentativas a cada leitura, abrir o painel People no Teams, mensagens do
// indicador) é o script. Sem innerHTML: createElement + style.cssText + textContent.
import { PORT_VIGIA, SETTINGS_KEY } from '../../shared/constants'
import { platformOfHost } from '../../shared/hosts'
import { initLanguage, onLanguageChange, t } from '../../shared/i18n'
import { vigiaSourceLabel } from '../../shared/vigia-source'
import { vigiaCountLine } from '../../shared/vigia-text'
import type { Platform, VigiaCfg, VigiaDown, VigiaUp } from '../../shared/protocol'
import { contagemPara, type ContagemPlataforma } from './contagem'
import { confirmarSaidaMeet } from './dialogo'
import { criarRelogio, type Tarefa } from '../../shared/relogio'
import { criarRegua, type LeituraRegua, type Regua } from './regua'

/** Plataforma pelo host, também pelo proxy do Defender for Cloud Apps (src/shared/hosts.ts, Emenda 17). */
const platformOf = (hostname: string): Platform | null => platformOfHost(hostname)

const hora = () => new Date().toLocaleTimeString('pt-BR')
/**
 * Log do vigia. Os avisos do script original ("saindo da call", "fechando", "NÃO achei a
 * contagem") eram console.warn; numa extensão, todo console.warn de content script aparece como
 * erro em chrome://extensions, e o usuário viu um "erro" no fim de uma saída que deu certo
 * (07/10/2026). Por isso o nível 'warn' sai como console.info: continua no Console, fora da lista
 * de erros. Problema de verdade chega pelo indicador, pelo popup e pela notificação.
 */
const log = (s: string, nivel: 'log' | 'warn' = 'log') => console[nivel === 'warn' ? 'info' : 'log'](`[gravador vigia ${hora()}] ${s}`)

/** Evento no document com que uma cópia nova do vigia para a antiga (Emenda 10). */
const NOVO_VIGIA_EVENT = 'gravador:vigia-novo'

/** O contexto da extensão ainda existe? Órfão (recarregada, atualizada, desligada): false. */
function extensaoViva(): boolean {
  try {
    return typeof chrome !== 'undefined' && !!chrome.runtime?.id
  } catch {
    return false
  }
}

const BADGE_CSS =
  'position:fixed;bottom:8px;left:8px;z-index:2147483647;background:#111;color:#0f0;font:12px monospace;padding:4px 8px;border-radius:4px;opacity:.9;pointer-events:none'

/** Estado de uma rodada do vigia (o que o script guardava em variáveis do closure). */
interface Rodada {
  regua: Regua
  ultima: LeituraRegua
  viuCall: boolean
  faltas: number
  saindo: boolean
  tentativas: number
  semContagem: number
  n: number | null
  fonte: string | null
  naCall: boolean
  timer: Tarefa | null
  /** Um tick assíncrono (diálogo do Meet) ainda está rodando. */
  ocupado: boolean
  /** Já pediu para fechar a aba: não faz mais nada. */
  fechando: boolean
  /** Meet: o caminho da reunião na última leitura em call (outro código é outra call). */
  codigo: string
}

class Vigia {
  private port: chrome.runtime.Port | null = null
  private cfg: VigiaCfg | null = null
  private indicador = true
  private badge: HTMLDivElement | null = null
  private texto = ''
  /** A mensagem mostrada agora, para escrever de novo no idioma novo (Emenda 19). */
  private mensagem: (() => string) | null = null
  private rodada: Rodada | null = null
  /** "Desligar nesta call": vale até a próxima call desta aba (Emenda 7). */
  private desligadoNestaCall = false
  /** Meet sem botão seguro no diálogo: parou de tentar nesta call. */
  private desistiu = false
  /** Parado nesta call: a leitura que espera a call acabar e uma nova começar. */
  private espera: Tarefa | null = null
  /**
   * Relógio resistente (Emenda 12): no Teams logado a página cancela os timers que existiam ao
   * carregar, inclusive os do mundo isolado; as mutações do DOM religam as leituras.
   */
  private readonly relogio = criarRelogio({
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (id) => clearInterval(id as number),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id as number),
    now: () => Date.now(),
    MutationObserver,
    doc: document,
    log: (...a: unknown[]) => log(a.map(String).join(' ')),
  })
  /** Leituras seguidas sem a call desde que parou (faltasParaFim delas: a call acabou). */
  private ausentes = 0
  private readonly dom: ContagemPlataforma

  /** Órfão: a extensão foi recarregada ou atualizada; não faz mais nada nesta aba. */
  private orfao = false

  constructor(private readonly platform: Platform) {
    this.dom = contagemPara(platform)
  }

  /**
   * Para de vez (Emenda 10): extensão recarregada, atualizada ou desligada, ou uma cópia nova do
   * vigia na aba.
   */
  encerrar(motivo: string): void {
    if (this.orfao) return
    this.orfao = true
    this.parar(motivo)
    this.pararEspera()
    this.relogio.dispose()
    this.port = null
    log(`vigia desativado nesta aba: ${motivo}`, 'warn')
  }

  /** Confere o contexto da extensão; órfão, encerra. */
  private vivo(): boolean {
    if (this.orfao) return false
    if (extensaoViva()) return true
    this.encerrar('a extensão foi recarregada ou atualizada (recarregue a aba da call)')
    return false
  }

  // --- Port --------------------------------------------------------------------------------

  /** Conecta o Port (uma vez). O SW responde com a configuração e a manda de novo a cada mudança. */
  connect(): void {
    if (this.port || !this.vivo()) return
    const port = chrome.runtime.connect({ name: PORT_VIGIA })
    this.port = port
    // O SW espelha o que vale aqui (o Port pode ser novo só porque o SW reiniciou).
    port.postMessage({ t: 'vigia:nesta-call', desligado: this.paradoNestaCall() } satisfies VigiaUp)
    port.onMessage.addListener((msg: VigiaDown) => {
      try {
        this.onDown(msg)
      } catch (e) {
        log(`erro ao tratar ${msg?.t}: ${String(e)}`, 'warn')
      }
    })
    port.onDisconnect.addListener(() => {
      if (this.port !== port) return
      this.port = null
      if (!this.vivo()) return
      // O SW reiniciou: se o vigia está rodando (ou esperando a próxima call), reconecta.
      const vivo = () => (this.rodada && !this.rodada.fechando) || this.espera !== null
      if (vivo()) setTimeout(() => vivo() && this.connect(), 1000)
    })
  }

  private post(msg: VigiaUp): void {
    try {
      if (!this.port) this.connect()
      this.port?.postMessage(msg)
    } catch (e) {
      log(`não consegui falar com o SW: ${String(e)}`, 'warn')
    }
  }

  private onDown(msg: VigiaDown): void {
    switch (msg.t) {
      case 'vigia:config':
        this.cfg = msg.cfg
        this.indicador = msg.indicador
        if (!msg.autoLeave) {
          this.parar('desligado nas configurações')
          this.pararEspera()
          const p = this.port
          this.port = null
          p?.disconnect()
          return
        }
        this.mostrarIndicador()
        if (this.paradoNestaCall()) {
          if (!this.espera) this.esperarProximaCall()
        } else if (!this.rodada) this.iniciar()
        return
      case 'vigia:sair-agora': {
        // O `sairAgora` do script. Espera um tick em andamento terminar (o diálogo do Meet).
        const r = this.rodada
        if (r && !r.fechando) void this.exclusivo(r, () => this.sair('pedido manual'))
        return
      }
      case 'vigia:desligar-nesta-call':
        this.desligadoNestaCall = true
        this.parar('desligado nesta call')
        this.pararNestaCall()
        return
    }
  }

  // --- parado nesta call (Emenda 7) --------------------------------------------------------

  private paradoNestaCall(): boolean {
    return this.desligadoNestaCall || this.desistiu
  }

  /** Avisa o SW e passa a esperar a próxima call do documento. */
  private pararNestaCall(): void {
    this.post({ t: 'vigia:nesta-call', desligado: true })
    this.esperarProximaCall()
  }

  private pararEspera(): void {
    this.espera?.stop()
    this.espera = null
  }

  /**
   * Parado, o vigia não conta nem sai: só lê se está em call, no mesmo intervalo. A call acabou
   * quando faltam faltasParaFim leituras seguidas (a mesma régua do fim no script); depois disso,
   * a primeira leitura em call é uma call nova. Uma queda curta (menos leituras) é a mesma call.
   */
  private esperarProximaCall(): void {
    this.pararEspera()
    this.ausentes = 0
    const ler = () => {
      this.espera = null
      if (!this.paradoNestaCall() || !this.vivo()) return
      const faltas = this.cfg?.faltasParaFim ?? 3
      // Parado no meio da call: ela continua enquanto o botão de sair está na tela (Emenda 10).
      if (!this.dom.emCall(true)) this.ausentes++
      else if (this.ausentes >= faltas) return this.novaCall()
      else this.ausentes = 0
      this.espera = this.relogio.after((this.cfg?.intervaloSeg ?? 5) * 1000, ler)
    }
    this.espera = this.relogio.after((this.cfg?.intervaloSeg ?? 5) * 1000, ler)
  }

  private novaCall(): void {
    log('call nova nesta aba: o vigia volta a valer')
    this.desligadoNestaCall = false
    this.desistiu = false
    this.parar('call nova')
    this.post({ t: 'vigia:nesta-call', desligado: false })
    if (this.cfg) this.iniciar()
  }

  // --- indicador na página -----------------------------------------------------------------

  private mostrar(mensagem: () => string): void {
    this.mensagem = mensagem
    this.escrever()
  }

  private escrever(): void {
    // "vigia" é o nome em português; em inglês a tela chama o recurso de auto-leave (Emenda 15).
    this.texto = this.mensagem ? t('vigiaPagePrefix', this.mensagem()) : ''
    if (this.badge) this.badge.textContent = this.texto
  }

  /** O idioma mudou nas configurações (Emenda 19): o indicador troca agora, com a mesma leitura. */
  idiomaMudou(): void {
    if (this.orfao) return
    this.escrever()
  }

  private mostrarIndicador(): void {
    if (!this.indicador || !this.rodada) {
      this.badge?.remove()
      this.badge = null
      return
    }
    if (this.badge?.isConnected) return
    const badge = document.createElement('div')
    badge.style.cssText = BADGE_CSS
    badge.textContent = this.texto
    document.documentElement.appendChild(badge)
    this.badge = badge
  }

  // --- laço --------------------------------------------------------------------------------

  private iniciar(): void {
    const cfg = () => this.cfg!
    const regua = criarRegua(cfg)
    this.rodada = {
      regua,
      ultima: { limite: 1, armado: false, sair: false },
      viuCall: false,
      faltas: 0,
      saindo: false,
      tentativas: 0,
      semContagem: 0,
      n: null,
      fonte: null,
      naCall: false,
      timer: null,
      ocupado: false,
      fechando: false,
      codigo: '',
    }
    this.texto = ''
    this.mensagem = null
    this.mostrarIndicador()
    log(`vigiando a cada ${this.cfg!.intervaloSeg}s (${this.platform}, modo ${this.cfg!.modo})`)
    void this.rodar()
  }

  /** Para o laço e tira o indicador (o `parar` do script). */
  private parar(motivo: string): void {
    const r = this.rodada
    if (!r) return
    r.timer?.stop()
    r.timer = null
    r.fechando = true
    this.rodada = null
    this.badge?.remove()
    this.badge = null
    log(`parado: ${motivo}`)
  }

  private agendar(r: Rodada): void {
    if (this.rodada !== r || r.fechando || !this.cfg) return
    r.timer = this.relogio.after(this.cfg.intervaloSeg * 1000, () => void this.rodar())
  }

  /** Roda `fn` sem outro tick ou comando ao mesmo tempo nesta rodada. */
  private async exclusivo(r: Rodada, fn: () => Promise<void>): Promise<void> {
    while (r.ocupado) await new Promise((res) => setTimeout(res, 50))
    if (this.rodada !== r || r.fechando) return
    r.ocupado = true
    try {
      await fn()
    } catch (e) {
      log(`erro na leitura: ${String(e)}`, 'warn')
    } finally {
      r.ocupado = false
    }
  }

  private async rodar(): Promise<void> {
    const r = this.rodada
    if (!r || r.fechando || !this.vivo()) return
    await this.exclusivo(r, () => this.tick(r))
    if (this.rodada === r && !r.fechando) this.status(r)
    this.agendar(r)
  }

  private status(r: Rodada): void {
    this.post({
      t: 'vigia:status',
      platform: this.platform,
      naCall: r.naCall,
      n: r.n,
      fonte: r.fonte,
      pico: r.regua.pico,
      limite: r.ultima.limite,
      armado: r.ultima.armado,
      seguidas: r.regua.seguidas,
      saindo: r.saindo,
      tentativas: r.tentativas,
    })
  }

  private fecharAba(r: Rodada, motivo: 'saiu-da-call' | 'a-call-acabou'): void {
    r.timer?.stop()
    r.timer = null
    log(`fechando: ${motivo === 'saiu-da-call' ? 'saí da call' : 'a call acabou'}`, 'warn')
    this.mostrar(() => t('vigiaClosing'))
    this.status(r)
    r.fechando = true
    this.post({ t: 'vigia:fechar-aba', motivo })
  }

  private async sair(motivo: string): Promise<void> {
    const r = this.rodada
    if (!r || r.fechando) return
    r.tentativas++
    if (!r.saindo) this.post({ t: 'vigia:saindo', motivo, pico: r.regua.pico, n: r.n })
    r.saindo = true
    log(`saindo da call (tentativa ${r.tentativas}): ${motivo}`, 'warn')
    const tentativa = r.tentativas
    this.mostrar(() => `${t('vigiaLeavingAttempt', tentativa)}...`)
    const b = this.dom.botaoSair()
    if (!b) return
    // Nunca clica com a extensão recarregada: ninguém mais pode desligar este vigia.
    if (!this.vivo()) return
    b.click()
    if (this.platform !== 'meet') return
    const res = await confirmarSaidaMeet(() => this.dom.botaoSair() === null)
    if (this.rodada !== r) return
    if (res.t === 'clicou') log(`diálogo do organizador: cliquei em "${res.texto}"`, 'warn')
    if (res.t === 'inseguro') {
      // Emenda 3: nenhum botão passou nos dois testes. Não clica, para de tentar e avisa.
      const m = `não achei um "só sair" seguro no diálogo (${res.opcoes.join(' / ') || 'sem botões'})`
      log(m, 'warn')
      this.desistiu = true
      r.timer?.stop()
      r.timer = null
      r.fechando = true
      this.mostrar(() => t('vigiaCouldNotLeave'))
      this.post({ t: 'vigia:nao-consegui-sair', motivo: m })
      this.pararNestaCall()
    }
  }

  /** O `tick` do script. */
  private async tick(r: Rodada): Promise<void> {
    const cfg = this.cfg!
    const naCall = this.dom.emCall(r.viuCall)
    r.naCall = naCall

    if (r.saindo) {
      if (!this.dom.botaoSair()) return this.fecharAba(r, 'saiu-da-call')
      return this.sair('o botão de sair continua na tela') // tenta de novo a cada leitura
    }

    if (!naCall) {
      if (!r.viuCall) return this.mostrar(() => t('vigiaWaitingCall'))
      r.faltas++
      log(`a call sumiu (${r.faltas}/${cfg.faltasParaFim})`)
      const faltas = r.faltas
      const total = cfg.faltasParaFim
      this.mostrar(() => t('vigiaCallGone', faltas, total))
      if (r.faltas >= cfg.faltasParaFim) this.fecharAba(r, 'a-call-acabou')
      return
    }
    // Emenda 10: a call sumiu por pelo menos uma leitura e voltou. Pode ser outra sala no mesmo
    // documento (sala de grupo, espera retomada): o pico recomeça, para uma sala de 4 não herdar o
    // pico de 20 da reunião principal e sair na hora. Recomeçar só deixa a saída mais cautelosa.
    // No Meet, outro código de reunião na URL também é outra call.
    const codigo = this.platform === 'meet' ? location.pathname : ''
    if (r.viuCall && (r.faltas > 0 || codigo !== r.codigo)) {
      log(`a call voltou${r.faltas > 0 ? ` depois de ${r.faltas} leitura(s) sem ela` : ' com outro código'}: o pico recomeça`)
      r.regua = criarRegua(() => this.cfg!)
    }
    r.codigo = codigo
    r.viuCall = true
    r.faltas = 0

    let { n, fonte } = this.dom.contar()
    if (n == null && !this.dom.painelAberto() && this.dom.abrirPainel()) {
      log('abri o painel People para ler a contagem')
      ;({ n, fonte } = this.dom.contar())
    }
    r.n = n
    r.fonte = fonte

    const v = r.regua.ver(n)
    r.ultima = v
    if (n == null) {
      r.semContagem++
      // Indicador na página no idioma da interface (Emenda 15); o log continua com o mesmo texto.
      const vezes = r.semContagem
      const meet = this.platform === 'meet'
      const msg = () => t('vigiaNoCountPage', vezes, meet ? t('vigiaHintMeet') : t('vigiaHintTeams'))
      log(msg(), 'warn')
      this.mostrar(msg)
    } else {
      r.semContagem = 0
      // A mesma linha do popup (Emenda 16), com a fonte da contagem no fim.
      const leitura = { n, pico: r.regua.pico, limite: v.limite, armado: v.armado, seguidas: r.regua.seguidas }
      const confirmacoes = cfg.confirmacoes
      const via = fonte
      const msg = () => `${vigiaCountLine(leitura, confirmacoes)} · ${t('vigiaVia', vigiaSourceLabel(via))}`
      const blocos = this.dom.blocosDeVideo?.()
      log(`${msg()}${blocos != null ? ` (blocos de vídeo na tela: ${blocos}, só diagnóstico)` : ''}`)
      this.mostrar(msg)
    }

    if (v.sair) await this.sair(`caiu de ${r.regua.pico} para ${n ?? '?'}`)
  }
}

function autoLeaveOf(settings: unknown): boolean {
  return (settings as { autoLeave?: boolean } | undefined)?.autoLeave === true
}

async function startVigia(): Promise<void> {
  if (window.top !== window) return
  const platform = platformOf(location.hostname)
  if (!platform) return
  // Uma cópia anterior do vigia nesta aba (de antes de a extensão ser recarregada) para.
  document.dispatchEvent(new CustomEvent(NOVO_VIGIA_EVENT))
  const vigia = new Vigia(platform)
  document.addEventListener(NOVO_VIGIA_EVENT, () => vigia.encerrar('outra cópia do vigia começou nesta aba'))
  // Emenda 19: o idioma escolhido vale desde o primeiro texto do indicador, e a troca, na hora.
  onLanguageChange(() => vigia.idiomaMudou())
  await initLanguage()
  // Emenda 5: ligar o autoLeave com a call já aberta conecta o Port agora; desligar chega pelo
  // vigia:config que o SW manda a todo Port conectado.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && SETTINGS_KEY in changes && autoLeaveOf(changes[SETTINGS_KEY].newValue)) vigia.connect()
  })
  const got = await chrome.storage.local.get(SETTINGS_KEY)
  if (autoLeaveOf(got[SETTINGS_KEY])) vigia.connect()
}

void startVigia().catch((e) => console.debug('[gravador vigia] não iniciou', e))
