// Página que imita o Teams para o vigia, em qualquer caminho de https://teams.microsoft.com/
// (menos /__peer). Só o DOM que o script do usuário lê (docs/referencia/vigia-original.js), com os
// ids verificados ao vivo por ele (ARQUITETURA, Emenda 2): #hangup-button, #microphone-button,
// #call-duration-custom, #roster-button, o painel People com [id^="roster-title-section"]
// (aria-label "Nesta reunião (N)") e #roster-participants-search-input.
//
// Parâmetros (query):
//   n=<N>                 pessoas na reunião ao entrar (padrão 3)
//   painel=aberto         o painel People já começa aberto (padrão: fechado; o vigia abre)
//   cliques=<K>           o botão de desligar só tira da call no K-ésimo clique (padrão 1)
//   atrasoPainelMs=<ms>   o painel aparece esse tempo depois do clique em #roster-button (300)
//
// Comandos do teste (window.vigiaFx): entrar(), setN(n), encerrar() (a call some sem clique),
// fecharPainel(), sumirPor(ms) (a call some e volta sozinha). Estado: n, hangupClicks, rosterClicks, state, leftAt, endedAt.
import { INDICADOR_OBSERVER } from './indicador'

const TEAMS_UI = `
(() => {
  const q = new URLSearchParams(location.search);
  const $ = (id) => document.getElementById(id);
  const el = (tag, attrs, ...children) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v);
    for (const c of children) e.append(c);
    return e;
  };
  const cliques = Number(q.get('cliques') || 1);
  const atrasoPainel = Number(q.get('atrasoPainelMs') ?? 300);
  const fx = window.vigiaFx = {
    n: Number(q.get('n') || 3), hangupClicks: 0, rosterClicks: 0, state: 'prejoin', leftAt: null, endedAt: null, errors: [],
  };
  document.addEventListener('securitypolicyviolation', (e) => fx.errors.push('csp: ' + e.violatedDirective + ' ' + (e.sample || '')));
  const app = $('app');
  let painel = null;
  const rotulo = () => 'Nesta reunião (' + fx.n + ')';
  function abrirPainel() {
    if (painel || fx.state !== 'call') return;
    painel = el('div', { id: 'painel-people' },
      el('div', { id: 'roster-title-section-2', 'aria-label': rotulo(), role: 'heading' }, 'Nesta reunião'),
      el('input', { id: 'roster-participants-search-input', placeholder: 'Pesquisar' }),
    );
    $('lateral').replaceChildren(painel);
  }
  function fecharPainel() { painel = null; $('lateral')?.replaceChildren(); }
  function setN(n) {
    fx.n = n;
    // Também com a call fora da tela (sumirPor): a troca de sala chega já com o número novo.
    const t = painel?.querySelector('[id^="roster-title-section"]') ?? document.querySelector('[id^="roster-title-section"]');
    if (t) t.setAttribute('aria-label', rotulo());
  }
  function sair() {
    fx.leftAt = Date.now();
    fx.state = 'saiu';
    painel = null;
    app.replaceChildren(el('h1', {}, 'Você saiu da reunião'));
  }
  function encerrar() {
    fx.endedAt = Date.now();
    fx.state = 'encerrada';
    painel = null;
    app.replaceChildren(el('h1', { 'data-testid': 'calling-anon-meeting-end-screen' }, 'A reunião terminou'));
  }
  // A call some por \`ms\` e volta (a rede caiu e reconectou): as faltas têm de zerar.
  function sumirPor(ms) {
    const antes = Array.from(app.childNodes);
    app.replaceChildren();
    fx.state = 'sumiu';
    setTimeout(() => { app.replaceChildren(...antes); fx.state = 'call'; }, ms);
  }
  function entrar() {
    $('prejoin')?.remove();
    const hangup = el('button', { id: 'hangup-button', 'aria-label': 'Sair' }, 'Sair');
    hangup.addEventListener('click', () => { fx.hangupClicks++; if (fx.hangupClicks >= cliques) sair(); });
    const roster = el('button', { id: 'roster-button', 'aria-label': 'Pessoas' }, 'Pessoas');
    roster.addEventListener('click', () => {
      fx.rosterClicks++;
      if (painel) return fecharPainel();
      setTimeout(abrirPainel, atrasoPainel);
    });
    app.replaceChildren(
      el('div', { id: 'barra' },
        el('span', { id: 'call-duration-custom' }, '00:00'),
        el('button', { id: 'microphone-button', 'aria-label': 'Microfone' }, 'Mic'),
        roster,
        hangup,
      ),
      el('aside', { id: 'lateral' }),
    );
    fx.state = 'call';
    if (q.get('painel') === 'aberto') abrirPainel();
  }
  $('entrar').addEventListener('click', entrar);
  window.vigiaFx = Object.assign(fx, { entrar, setN, encerrar, fecharPainel, sumirPor });
})();
`

export function teamsVigiaPage(): string {
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><title>Reunião | Microsoft Teams</title></head>
<body>
<div id="prejoin"><h2>Escolha as opções de áudio e vídeo</h2><button id="entrar" data-tid="prejoin-join-button">Ingressar agora</button></div>
<div id="app"></div>
<script>${INDICADOR_OBSERVER}</script>
<script>${TEAMS_UI}</script>
</body></html>`
}
