// so-construtor: o PC só passa pelo construtor. Nada de setter ontrack, addEventListener('track'),
// addTrack ou addTransceiver (todos embrulhados pela extensão, e cada um registraria o PC por
// conta própria): a oferta pede áudio com offerToReceiveAudio e a faixa remota sai de
// getReceivers() quando o PC conecta. Só o Proxy do construtor (regra 7) registra este PC.
sala.opts.sendMic = false;
sala.opts.useOntrack = false;
sala.opts.offerOptions = { offerToReceiveAudio: true };
sala.opts.onConnected = (pc) => {
  const track = pc.getReceivers().map((r) => r.track).find((t) => t && t.kind === 'audio');
  if (!track) return fx.errors.push('so-construtor: sem faixa remota');
  fx.remoteTrack = true;
  ui.playRemote(track, null);
};
ui.$('participar').addEventListener('click', () => {
  ui.enterCall();
  sala.start();
});
