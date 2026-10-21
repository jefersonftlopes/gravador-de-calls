// mic-processado (Emenda 25, o risco da Emenda 24 seção F): a página pede o microfone e envia à
// call uma faixa DERIVADA dele, não a faixa do getUserMedia. É o que um cliente com cancelamento de
// ruído próprio faz: o grafo processa o áudio e o que entra no RTCRtpSender é a saída do grafo.
//
//   getUserMedia -> createMediaStreamSource -> GainNode -> MediaStreamAudioDestinationNode
//                                                           \-> a faixa que vai para o PC
//
// Consequência medida: a faixa do getUserMedia não está em sender nenhum, então o portão do mudo
// fecha por `sem-sender` a call toda. Sem a faixa da página num sender não existe sinal de mudo, e
// a regra é não gravar. Este é o caso em que NADA do microfone pode ser gravado.
//
// A Ana "fala" pelo 'dcrpc' (o falantes.json só existe com alguém falando), como na variante mudo.
//   fx.estado()      o que a PÁGINA vê da faixa do getUserMedia e do sender
sala.opts.onRemote = (track, streams) => ui.playRemote(track, streams);
// A faixa do getUserMedia NÃO é enviada: quem vai para o PC é a derivada do grafo (beforeOffer).
sala.opts.sendMic = false;
sala.opts.beforeOffer = (pc) => {
  fx.dcrpc = pc.createDataChannel('dcrpc');
  if (derivada) pc.addTrack(derivada, new MediaStream([derivada]));
};
const tile = (id, name, self) =>
  ui.el('div', { 'data-participant-id': id }, ui.el('span', { class: 'notranslate' }, name), ...(self ? [ui.el('div', { 'data-self-name': name })] : []));

/** A faixa do getUserMedia (a de verdade do aparelho), que NUNCA vai para o PC. */
let faixa = null;
/** A faixa derivada, que vai para o PC no lugar dela. */
let derivada = null;

sala.micReady.then(() => {
  const mic = sala.mic();
  faixa = mic.getAudioTracks()[0];
  const ctx = new AudioContext();
  const destino = ctx.createMediaStreamDestination();
  // O "processamento": um ganho, só para a faixa que sai do grafo ser outra.
  ctx.createMediaStreamSource(mic).connect(new GainNode(ctx, { gain: 1 })).connect(destino);
  derivada = destino.stream.getAudioTracks()[0];
  fx.micPronto = true;
});

const senderDaCall = () => (sala.pc ? sala.pc.getSenders().find((s) => s.track && s.track.kind === 'audio') : null);

fx.estado = () => {
  const s = senderDaCall();
  return {
    readyState: faixa ? faixa.readyState : null,
    enabled: faixa ? faixa.enabled : null,
    muted: faixa ? faixa.muted : null,
    // Falso de propósito: quem está num sender é a derivada, não a faixa do getUserMedia.
    enviando: Boolean(s && s.track === faixa),
    enviandoDerivada: Boolean(s && derivada && s.track === derivada),
  };
};

ui.$('participar').addEventListener('click', () => {
  ui.enterCall();
  ui.palco.append(ui.el('div', { id: 'grade' }, tile('spaces/sala1/devices/1', 'Alex Lima', true)));
  fetch('/$rpc/google.rtc.meetings.v1.MeetingSpaceService/SyncMeetingSpaceCollections', { method: 'POST', body: 'x' })
    .then((r) => r.text())
    .then((t) => { fx.rosterBuscada = t.length > 0; })
    .catch((e) => fx.errors.push('roster: ' + e.message));
  sala.start();
});
