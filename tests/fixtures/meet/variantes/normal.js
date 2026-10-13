// normal: a faixa remota vai para um <audio> (padrão do Meet). Ao clicar em "Participar agora"
// monta os marcadores de "em call" e conecta ao participante remoto. O microfone falso (1000 Hz)
// é mandado como envio, que a extensão precisa excluir.
sala.opts.onRemote = (track, streams) => ui.playRemote(track, streams);
ui.$('participar').addEventListener('click', () => {
  ui.enterCall();
  sala.start();
});
