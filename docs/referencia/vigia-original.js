// Script original do usuário ("vigia"), usado no console do Teams até 06/10/2026.
// Referência para o porte em src/content/vigia/: a extensão deve reproduzir este comportamento.
(() => {
  const CFG = Object.assign({
    intervaloSeg: 5,    // confere a cada 5s
    fracao: 0.3,        // em call de 4+, sai quando sobrar <= 30% do pico...
    minimo: 2,          // ...ou <= 2 pessoas, o que for maior
    picoParaQueda: 4,   // abaixo disso, só sai quando ficar sozinho
    confirmacoes: 4,    // na queda proporcional, leituras abaixo do limite antes de agir (~20s); sozinho sai na hora
    faltasParaFim: 3,   // leituras sem a call para considerar que ela acabou
  }, window.VIGIA_CFG || {});

  if (window.__vigia) window.__vigia.parar();

  const $ = s => document.querySelector(s);
  const hora = () => new Date().toLocaleTimeString('pt-BR');
  const log = (s, nivel = 'log') => console[nivel](`[vigia ${hora()}] ${s}`);
  const RE_NA_REUNIAO = /(?:in this meeting|in the meeting|nesta reuni[aã]o|na reuni[aã]o|em reuni[aã]o)\D{0,20}?(\d{1,4})/i;

  const botaoSair = () => $('#hangup-button');
  const emCall = () => !!($('#hangup-button') || $('#microphone-button') || $('#call-duration-custom'));
  const painelAberto = () => !!($('#roster-participants-search-input') || $('[id^="roster-title-section"]'));

  function contar() {
    for (const el of document.querySelectorAll('[id^="roster-title-section"]')) {
      const m = ((el.getAttribute('aria-label') || '') + ' ' + el.textContent).match(RE_NA_REUNIAO);
      if (m) return { n: +m[1], fonte: 'painel People' };
    }
    const m = document.body.innerText.match(/^\s*(?:in this meeting|nesta reuni[aã]o|na reuni[aã]o)\s*\((\d{1,4})\)/im);
    if (m) return { n: +m[1], fonte: 'texto da página' };
    return { n: null, fonte: null };
  }

  function criarRegua() {
    let pico = 0, seguidas = 0;
    return {
      get pico() { return pico; },
      get seguidas() { return seguidas; },
      ver(n) {
        if (n != null) pico = Math.max(pico, n);
        const armado = pico >= 2;
        const limite = pico >= CFG.picoParaQueda ? Math.max(CFG.minimo, Math.floor(pico * CFG.fracao)) : 1;
        if (n != null) seguidas = armado && n <= limite ? seguidas + 1 : 0;
        const sozinho = armado && n === 1;
        return { limite, armado, sair: sozinho || seguidas >= CFG.confirmacoes };
      },
    };
  }

  const badge = document.createElement('div');
  badge.style.cssText = 'position:fixed;bottom:8px;left:8px;z-index:2147483647;background:#111;color:#0f0;font:12px monospace;padding:4px 8px;border-radius:4px;opacity:.9;pointer-events:none';
  document.documentElement.appendChild(badge);
  const mostrar = s => { badge.textContent = 'vigia: ' + s; };

  let regua = criarRegua(), viuCall = false, faltas = 0, saindo = false, tentativas = 0, semContagem = 0;

  function fecharAba(motivo) {
    clearInterval(timer);
    log(`fechando: ${motivo}`, 'warn');
    mostrar('fechando...');
    window.close();
    setTimeout(() => location.replace('about:blank'), 1500);
  }

  function sair(motivo) {
    tentativas++;
    saindo = true;
    log(`saindo da call (tentativa ${tentativas}): ${motivo}`, 'warn');
    mostrar(`saindo da call (tentativa ${tentativas})...`);
    const b = botaoSair();
    if (b) b.click();
  }

  function tick() {
    const naCall = emCall();

    if (saindo) {
      if (!botaoSair()) return fecharAba('saí da call');
      return sair('o botão Leave continua na tela');   // tenta de novo a cada leitura
    }

    if (!naCall) {
      if (!viuCall) return mostrar('esperando a call começar...');
      faltas++;
      log(`a call sumiu (${faltas}/${CFG.faltasParaFim})`);
      mostrar(`a call sumiu (${faltas}/${CFG.faltasParaFim})`);
      if (faltas >= CFG.faltasParaFim) fecharAba('a call acabou');
      return;
    }
    viuCall = true;
    faltas = 0;

    let { n, fonte } = contar();
    if (n == null && !painelAberto() && $('#roster-button')) {
      $('#roster-button').click();
      log('abri o painel People para ler a contagem');
      ({ n, fonte } = contar());
    }

    const v = regua.ver(n);
    if (n == null) {
      semContagem++;
      const msg = `NÃO achei a contagem (${semContagem}x): o painel People está aberto?`;
      log(msg, 'warn');
      mostrar(msg);
    } else {
      semContagem = 0;
      const msg = `${n} na call | pico ${regua.pico} | sai com <= ${v.limite}${v.armado ? '' : ' (desarmado)'}${regua.seguidas ? ` | queda ${regua.seguidas}/${CFG.confirmacoes}` : ''}`;
      log(`${msg} (via ${fonte})`);
      mostrar(msg);
    }

    if (v.sair) sair(`caiu de ${regua.pico} para ${n ?? '?'}`);
  }

  const timer = setInterval(tick, CFG.intervaloSeg * 1000);
  window.__vigia = {
    parar() { clearInterval(timer); badge.remove(); log('parado'); },
    status: () => ({ ...contar(), naCall: emCall(), painelAberto: painelAberto(), pico: regua.pico, seguidas: regua.seguidas, saindo, CFG }),
    sairAgora: () => sair('pedido manual'),
  };
  log(`vigiando a cada ${CFG.intervaloSeg}s`);
  tick();
})();
