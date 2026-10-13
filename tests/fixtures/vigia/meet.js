// Variante do Meet para o vigia (servida por ./routes.ts com meetPage de ../meet/page.ts): o
// corpo de uma função com `sala`, `ui`, `fx` e `q` no escopo. Imita o que o vigia lê no Meet
// (docs/pesquisa/vigia-meet-2026-10-06.json): o selo [data-avatar-count] ao lado dos avatares
// (inclui você), o botão de sair button[jsname="CQylAd"] com o ícone call_end, o ícone de legenda,
// blocos de vídeo [data-participant-id] (menos que o total, como no Meet) e, quando pedido, o
// diálogo do organizador.
//
// Parâmetros (query): n=<N> (padrão 3); selo=nao (sem [data-avatar-count]);
// dialogo=organizador ("Encerrar a reunião para todos" + "Sair da reunião", nesta ordem, 300 ms
// depois do clique) | ambiguo (nenhum botão é um "só sair" seguro); balao=1 (um
// div[role="dialog"] alheio, o balão do botão de pessoas da interface nova, fica visível desde a
// entrada e continua na tela depois da saída).
// Comandos (window.vigiaFx): setN(n), abrirPainel(nomes, esperando?) (o usuário abre o painel de pessoas),
// encerrar() (a call some sem clique), sumirLegenda() (janela estreita: o ícone de legenda vai
// para o menu "mais opções" e a call continua). Estado: n, leaveClicks, dialogClicks, encerrouParaTodos,
// peopleButtonClicks, leftAt.
const opt = { n: Number(q.get('n') || 3), selo: q.get('selo') !== 'nao', dialogo: q.get('dialogo') || 'nenhum', balao: q.get('balao') === '1' };
const vf = (window.vigiaFx = {
  n: opt.n, leaveClicks: 0, dialogClicks: [], encerrouParaTodos: false, peopleButtonClicks: 0, leftAt: null, dialogShownAt: null,
});
sala.opts.onRemote = (track, streams) => ui.playRemote(track, streams);
const el = ui.el;

function sair() {
  vf.leftAt = Date.now();
  ui.left();
}

let dialogo = null;
function mostrarDialogo() {
  if (dialogo) return;
  const botao = (attrs, texto, acao) => {
    const b = el('button', attrs, texto);
    b.addEventListener('click', () => { vf.dialogClicks.push(texto + (attrs['aria-label'] ? ' [' + attrs['aria-label'] + ']' : '')); acao(); });
    return b;
  };
  const paraTodos = () => { vf.encerrouParaTodos = true; sair(); };
  const fechar = () => { dialogo?.remove(); dialogo = null; };
  const filhos = opt.dialogo === 'organizador'
    ? [
        el('h2', {}, 'Sair da reunião?'),
        botao({ 'data-mdc-dialog-action': 'A9Emjd' }, 'Encerrar a reunião para todos', paraTodos),
        botao({ 'data-mdc-dialog-action': 'Pd96ce' }, 'Sair da reunião', sair),
      ]
    : [
        el('h2', {}, 'Tem certeza?'),
        botao({ 'aria-label': 'Encerrar a reunião para todos' }, 'Sair da reunião', paraTodos),
        botao({ 'data-mdc-dialog-action': 'Pd96ce' }, 'Encerrar para todos', paraTodos),
        botao({}, 'Cancelar', fechar),
      ];
  dialogo = el('div', { role: 'dialog', 'aria-modal': 'true', jscontroller: 'ZakeSe' }, ...filhos);
  ui.palco.append(dialogo);
  vf.dialogShownAt = Date.now();
}

const selo = el('span', { 'data-avatar-count': String(opt.n) }, String(opt.n));
function setN(n) {
  vf.n = n;
  selo.setAttribute('data-avatar-count', String(n));
  selo.textContent = String(n);
}

let painel = null;
// esperando: linhas de "Aguardando para participar" (o organizador vê quem bate na porta), numa
// seção própria do painel, com a mesma marcação das linhas de quem está na call.
function abrirPainel(nomes, esperando) {
  const linha = (nome, i) =>
    el('div', { role: 'listitem', 'data-participant-id': 'spaces/x/devices/' + i, 'aria-label': nome }, el('span', { class: 'notranslate' }, nome));
  const linhas = nomes.map(linha);
  const filhos = esperando && esperando.length
    ? [
        el('div', { role: 'region', 'aria-label': 'Aguardando para participar' }, el('div', { role: 'list' }, ...esperando.map((n, i) => linha(n, 100 + i)))),
        el('div', { role: 'region', 'aria-label': 'Na chamada' }, el('div', { role: 'list', 'aria-label': 'Participantes' }, ...linhas)),
      ]
    : [el('div', { role: 'list', 'aria-label': 'Participantes' }, ...linhas)];
  if (painel) painel.replaceChildren(...filhos);
  else {
    painel = el('aside', { id: 'painel-pessoas' }, ...filhos);
    ui.palco.append(painel);
  }
}

ui.$('participar').addEventListener('click', () => {
  ui.$('prejoin')?.remove();
  const sairBtn = el('button', { jsname: 'CQylAd', 'aria-label': 'Sair da chamada' }, ui.icon('call_end'));
  sairBtn.addEventListener('click', () => {
    vf.leaveClicks++;
    if (opt.dialogo === 'nenhum') sair();
    else setTimeout(mostrarDialogo, 300);
  });
  // Botão de pessoas da interface nova: abre um balão no Meet. O vigia nunca pode clicar nele.
  const pessoas = el('div', { role: 'button', 'aria-label': 'Pessoas', 'aria-haspopup': 'dialog' }, ui.icon('people'));
  if (opt.selo) pessoas.append(selo);
  pessoas.addEventListener('click', () => vf.peopleButtonClicks++);
  ui.palco.replaceChildren(
    el('div', { jsname: 'NeC6gb', class: 'u6vdEc' }, 'Daily do time'),
    pessoas,
    el('div', { 'data-participant-id': 'spaces/x/devices/a' }, 'bloco A'),
    el('div', { 'data-participant-id': 'spaces/x/devices/b' }, 'bloco B'),
    el('button', { 'aria-label': 'Legendas' }, ui.icon('closed_caption_off')),
    sairBtn,
  );
  // Fora do palco: a saída troca o palco, mas o balão continua (é o caso que importa).
  if (opt.balao) document.body.append(el('div', { role: 'dialog', 'aria-label': opt.n + ' pessoas na chamada' }, el('span', {}, 'Alex Lima e mais ' + (opt.n - 1))));
  document.title = 'Meet - Daily do time';
  fx.state = 'call';
  sala.start();
});

function sumirLegenda() {
  for (const i of Array.from(document.querySelectorAll('.google-symbols'))) if (/^closed_caption/.test(i.textContent)) i.closest('button').remove();
}

Object.assign(vf, { setN, abrirPainel, encerrar: sair, sumirLegenda });
