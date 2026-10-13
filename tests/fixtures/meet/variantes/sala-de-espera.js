// sala-de-espera: "pedindo para participar". Conecta o PC e recebe (e toca) o áudio remoto já no
// carregamento, mostra o botão de sair (que existe também nessa tela), mas nunca o ícone de
// legenda: não pode gravar.
sala.opts.onRemote = (track, streams) => ui.playRemote(track, streams);
ui.palco.replaceChildren(ui.el('p', {}, 'Pedindo para participar...'), ui.leaveButton());
fx.state = 'espera';
sala.start();
