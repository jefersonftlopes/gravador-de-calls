// Página falsa de reunião do Meet em https://meet.google.com/<código>?variante=<nome>&sala=<sala>.
//
// Imita os marcadores de DOM que o adaptador usa (com data em docs/pesquisa/meet-e-teams.txt),
// montados só quando a tela correspondente aparece, como o Meet faz: botão de sair
// button[jsname="CQylAd"] com ícone call_end, ícone de legenda closed_caption_off, título
// [jsname="NeC6gb"] e, ao sair, o cabeçalho h1[jsname="r4nke"].
//
// O comportamento de cada variante mora num arquivo próprio em ./variantes/<nome>.js (lido por
// ../routes.ts a cada pedido). Uma variante nova é só um arquivo novo: nada daqui muda. O arquivo
// é o corpo de uma função com `sala` (../call-runtime.ts), `ui` (abaixo), `fx` e `q` no escopo.
//
//   ui.$(id), ui.el(tag, attrs, ...filhos), ui.icon(nome), ui.palco
//   ui.leaveButton()   botão de sair do Meet; o clique chama ui.left()
//   ui.enterCall()     tira o pré-join e monta título, legenda e botão de sair (fx.state = 'call')
//   ui.left()          sai: fecha o PC e mostra o cabeçalho de saída (fx.state = 'saiu')
//   ui.playRemote(track, streams)  toca a faixa remota no <audio id="remoto"> (padrão do Meet)
import { CALL_RUNTIME } from '../call-runtime'

const MEET_UI = `
(() => {
  const { sala } = window;
  const fx = sala.fx;
  const $ = (id) => document.getElementById(id);
  const el = (tag, attrs, ...children) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v);
    for (const c of children) e.append(c);
    return e;
  };
  const icon = (name) => el('i', { class: 'google-symbols' }, name);
  const palco = $('palco');
  function left() {
    sala.leave();
    $('remoto').srcObject = null;
    palco.replaceChildren(el('h1', { jsname: 'r4nke', class: 'roSPhc' }, 'Você saiu da reunião'));
    document.title = 'Meet';
    fx.state = 'saiu';
  }
  const leaveButton = () => {
    const b = el('button', { jsname: 'CQylAd', 'aria-label': 'Sair da chamada' }, icon('call_end'));
    b.addEventListener('click', left);
    return b;
  };
  function enterCall() {
    $('prejoin')?.remove();
    palco.replaceChildren(
      el('div', { jsname: 'NeC6gb', class: 'u6vdEc' }, 'Daily do time'),
      el('button', { 'aria-label': 'Legendas' }, icon('closed_caption_off')),
      leaveButton(),
    );
    document.title = 'Meet - Daily do time';
    fx.state = 'call';
  }
  function playRemote(track, streams) {
    const a = $('remoto');
    a.srcObject = (streams && streams[0]) || new MediaStream([track]);
    a.play().catch((err) => fx.errors.push('play: ' + err.message));
  }
  window.ui = { $, el, icon, palco, leaveButton, enterCall, left, playRemote };
})();
`

export function meetPage(variantJs: string): string {
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><title>Meet</title></head>
<body>
<div id="prejoin">
  <h2>Pronto para participar?</h2>
  <button id="participar">Participar agora</button>
</div>
<div id="palco"></div>
<audio id="remoto" autoplay></audio>
<script>${CALL_RUNTIME}</script>
<script>${MEET_UI}</script>
<script>
(() => {
  const { sala, ui } = window;
  const fx = sala.fx;
  const q = sala.q;
${variantJs}
})();
</script>
</body></html>`
}
