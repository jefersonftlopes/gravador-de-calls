// Página falsa de reunião do Teams web, servida em qualquer caminho dos três hosts do Teams
// (./routes.ts), com `?variante=<nome>&sala=<sala>`.
//
// Imita o que o adaptador do Teams lê (seletores com data em docs/pesquisa/meet-e-teams.txt e na
// Emenda 2), montado só quando a tela correspondente aparece:
//   pré-join  [data-tid="calling-prejoin-screen"], [data-tid="meeting-header-title"][title],
//             [data-tid="prejoin-display-name-input"], [data-tid="prejoin-join-button"]
//   lobby     [data-tid="calling-lobby-screen"] e a barra da call (#microphone-button,
//             #hangup-button), que no Teams de verdade também aparece no lobby; o PC já conecta
//             e o áudio remoto já toca
//   na call   barra com #call-duration-custom, #roster-button, #microphone-button, #hangup-button
//   fim       conforme `opts.fim`: estado 6 e depois 7 no objeto da call, tela de fim da reunião
//             anônima [data-testid="calling-anon-meeting-end-screen"], ou só a barra sumindo
// e um objeto da call falso com `state`, `threadId`, `participants` e `localSignalingParticipant`,
// exposto como no v2 (`window.msteamscalling.deref().callingService.getActiveCall()`) ou como nas
// reuniões leves (`window.callingDebug.observableCall`), conforme `opts.objeto`.
//
// Áudio: a página oferece duas linhas de áudio (o microfone falso como envio e uma só de
// recepção) e o participante remoto (./peer/teams.js) manda o tom principal num stream
// `mainAudio` e um tom redundante num stream `dominantSpeaker-1`. Como o Teams, a página toca só
// o `mainAudio`, num <audio> criado e posto no fim do <body>.
//
// Cada variante mora em ./variantes/<nome>.js: o corpo de uma função com `sala`
// (../call-runtime.ts), `ui` (abaixo), `fx` e `q` no escopo. Ela ajusta `ui.opts` e chama
// `ui.prejoin()` (ou monta a tela que quiser).
//
//   ui.opts      objeto: 'v2' | 'leve' | 'nenhum'; titulo; cabecalho (bool); tituloDaAbaNaCall
//                (string ou null para a casca); threadId; voce; participantes ([{ displayName,
//                state }]); fim: 'estado' | 'tela' | 'dom'; tocarPrincipal (bool)
//   ui.prejoin() ui.lobby() ui.admitir() ui.espera() ui.retomar() ui.desligar()
//   ui.sumirControles()  tira a barra da call e mantém o PC e o áudio (para o "fora da call")
//   ui.trocarParticipantes(lista)  troca `participants` do objeto e as linhas do painel
//   ui.call      o objeto da call falso (null antes do lobby)
import { CALL_RUNTIME } from '../call-runtime'

const TEAMS_UI = `
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
  const app = $('app');
  const SHELL = 'Microsoft Teams meeting | Microsoft Teams';
  const opts = {
    objeto: 'v2',
    titulo: 'Planejamento trimestral',
    cabecalho: true,
    tituloDaAbaNaCall: null,
    threadId: '19:meeting_UGxhbmVqYW1lbnRvLWZhbHNv@thread.v2',
    voce: 'Alex Lima',
    participantes: [
      { id: '8:orgid:ana', displayName: 'Ana Souza', state: 3 },
      { id: '8:orgid:bruno', displayName: 'Bruno Lima', state: 3 },
      { id: '8:orgid:lobby', displayName: 'Visitante no lobby', state: 7 },
      { id: '8:orgid:vazio', displayName: '', state: 3 },
    ],
    fim: 'estado',
    tocarPrincipal: true,
  };
  let call = null;
  fx.streams = [];
  fx.mainAudio = false;
  fx.dominantSpeaker = false;

  function expose() {
    if (opts.objeto === 'v2') {
      window.msteamscalling = { deref: () => ({ callingService: { getActiveCall: () => call || undefined } }) };
    } else if (opts.objeto === 'leve') {
      window.callingDebug = { get observableCall() { return call || undefined; } };
    }
  }

  // O Teams toca o stream escolhido num <audio> que ele mesmo cria e põe no body.
  let audio = null;
  function tocar(stream) {
    if (!audio) {
      audio = document.createElement('audio');
      audio.autoplay = true;
      document.body.append(audio);
    }
    audio.srcObject = stream;
    audio.play().catch((err) => fx.errors.push('play: ' + err.message));
  }
  sala.opts.beforeOffer = (pc) => pc.addTransceiver('audio', { direction: 'recvonly' });
  sala.opts.onRemote = (track, streams) => {
    const s = streams && streams[0];
    fx.streams.push(s ? s.id : null);
    if (s && /^mainaudio/i.test(s.id)) {
      fx.mainAudio = true;
      if (opts.tocarPrincipal) tocar(s);
    } else fx.dominantSpeaker = true;
  };

  function toolbar(inCall) {
    const hangup = el('button', { id: 'hangup-button', 'aria-label': 'Sair' }, 'Sair');
    hangup.addEventListener('click', desligar);
    const kids = [el('button', { id: 'microphone-button', 'aria-label': 'Microfone' }, 'Mic'), hangup];
    if (inCall) kids.unshift(el('span', { id: 'call-duration-custom' }, '00:01'), el('button', { id: 'roster-button', 'aria-label': 'Pessoas' }, 'Pessoas'));
    return el('div', { id: 'barra', role: 'toolbar' }, ...kids);
  }

  function roster(list) {
    return el('div', { id: 'painel' }, ...list.map((p) => el('div', {
      'data-cid': 'roster-participant',
      'data-tid': (p.state === 7 ? 'participantsInLobby-' : 'participantsInCall-') + p.displayName,
      'aria-label': p.displayName,
    }, p.displayName)));
  }

  function prejoin() {
    const kids = [];
    if (opts.cabecalho) kids.push(el('span', { 'data-tid': 'meeting-header-title', title: opts.titulo }, opts.titulo));
    const join = el('button', { id: 'participar', 'data-tid': 'prejoin-join-button' }, 'Participar agora');
    join.addEventListener('click', lobby);
    kids.push(el('input', { 'data-tid': 'prejoin-display-name-input', value: opts.voce }), join);
    app.replaceChildren(el('div', { 'data-tid': 'calling-prejoin-screen' }, ...kids));
    document.title = SHELL;
    expose();
    fx.state = 'prejoin';
  }

  function lobby() {
    call = { state: 2, threadId: opts.threadId, participants: [], localSignalingParticipant: { id: '8:orgid:eu', displayName: opts.voce } };
    ui.call = call;
    app.replaceChildren(el('div', { 'data-tid': 'calling-lobby-screen' }, el('p', {}, 'Alguém da reunião vai deixar você entrar em breve')), toolbar(false));
    call.state = 10;
    fx.state = 'lobby';
    sala.start();
  }

  function admitir() {
    if (call) {
      call.state = 3;
      call.participants = opts.participantes.slice();
    }
    app.replaceChildren(el('div', { id: 'palco' }, 'Vídeo da reunião'), toolbar(true), roster(opts.objeto === 'nenhum' ? opts.participantes : []));
    document.title = opts.tituloDaAbaNaCall || SHELL;
    fx.state = 'call';
  }

  function trocarParticipantes(list) {
    if (call) call.participants = list.slice();
    $('painel')?.replaceWith(roster(opts.objeto === 'nenhum' ? list : []));
  }

  function espera() { if (call) call.state = 4; fx.state = 'espera'; }
  function retomar() { if (call) call.state = 3; fx.state = 'call'; }

  function desligar() {
    fx.desligouEm = Date.now();
    if (audio) audio.srcObject = null;
    sala.leave();
    if (opts.fim === 'estado') {
      call.state = 6;
      setTimeout(() => { call.state = 7; }, 300);
      app.replaceChildren(el('div', { id: 'chat' }, 'Chat'));
      document.title = 'Chat | Microsoft Teams';
    } else if (opts.fim === 'tela') {
      call = null;
      ui.call = null;
      app.replaceChildren(el('div', { 'data-testid': 'calling-anon-meeting-end-screen' }, el('h2', {}, 'A reunião terminou'),
        el('button', { 'data-testid': 'anon-meeting-end-screen-rejoin-button' }, 'Entrar novamente')));
      document.title = SHELL;
    } else {
      $('barra')?.remove();
      $('painel')?.remove();
    }
    fx.state = 'saiu';
  }

  function sumirControles() {
    $('barra')?.remove();
    fx.state = 'sem-controles';
  }

  const ui = window.ui = { $, el, app, opts, call: null, prejoin, lobby, admitir, espera, retomar, desligar, sumirControles, trocarParticipantes };
})();
`

export function teamsPage(variantJs: string): string {
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><title>Microsoft Teams</title></head>
<body>
<div id="app"></div>
<script>${CALL_RUNTIME}</script>
<script>${TEAMS_UI}</script>
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
