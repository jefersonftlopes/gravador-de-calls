// pedindo-para-participar: o pré-join tem "Pedir para participar". Depois do clique, a tela de
// espera mostra o próprio bloco, os botões de microfone e câmera e o botão de sair (aqui só pelo
// ícone call_end, sem o jsname), o PC conecta e o áudio remoto já toca. Sem ícone de legenda nem
// de chat: não pode gravar. fx.admitir() é o anfitrião deixando entrar (monta a tela da call).
sala.opts.onRemote = (track, streams) => ui.playRemote(track, streams);
const pedir = ui.$('participar');
pedir.textContent = 'Pedir para participar';
pedir.addEventListener('click', () => {
  ui.$('prejoin').remove();
  const sair = ui.el('button', { 'aria-label': 'Cancelar pedido' }, ui.icon('call_end'));
  sair.addEventListener('click', ui.left);
  ui.palco.replaceChildren(
    ui.el('p', {}, 'Pedindo para participar...'),
    ui.el('div', { 'data-participant-id': 'spaces/x/devices/eu' }, ui.el('span', { class: 'notranslate' }, 'Alex Lima'), ui.el('div', { 'data-self-name': 'Alex Lima' })),
    ui.el('button', { 'aria-label': 'Microfone' }, ui.icon('mic')),
    ui.el('button', { 'aria-label': 'Câmera' }, ui.icon('videocam')),
    sair,
  );
  fx.state = 'espera';
  sala.start();
});
fx.admitir = () => ui.enterCall();
