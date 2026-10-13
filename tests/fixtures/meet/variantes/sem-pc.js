// sem-pc: depois do clique, todo o DOM de "em call" aparece (título, legenda, botão de sair), e a
// página cria um PC com o microfone e uma linha só de recepção, mas ninguém responde à oferta: o
// PC nunca conecta. A faixa do receptor existe e está "live" (muda), o que não basta. Não pode
// gravar.
ui.$('participar').addEventListener('click', async () => {
  ui.enterCall();
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    const pc = new RTCPeerConnection();
    for (const t of s.getAudioTracks()) pc.addTrack(t, s);
    pc.addTransceiver('audio', { direction: 'recvonly' });
    await pc.setLocalDescription(await pc.createOffer());
    fx.semPc = pc;
    fx.pcState = pc.connectionState;
    fx.receptorVivo = pc.getReceivers().some((r) => r.track && r.track.kind === 'audio' && r.track.readyState === 'live');
  } catch (e) {
    fx.errors.push('sem-pc: ' + e.message);
  }
});
