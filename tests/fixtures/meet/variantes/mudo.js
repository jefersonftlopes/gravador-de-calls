// mudo (Emenda 24): Meet com o microfone falso ENVIADO ao PC (como em call-runtime.ts) e as quatro
// formas de mutar que um aplicativo de call usa, uma por vez, para medir o portão do microfone
// (src/shared/mic-gate.ts). A variante nunca grava o microfone: ela só muda o estado da faixa e do
// sender, e quem conta é o diagnóstico que o SW escreve no falantes.json.
//
// Quem fala na call vem do 'dcrpc' (o canal que a página cria, como na variante falantes), porque
// o falantes.json só existe quando a plataforma disse que alguém falou.
//
//   fx.mutar(forma) e fx.desmutar(forma), com forma em:
//     'enabled'  track.enabled = false             desmutar: = true
//     'stop'     track.stop()                      desmutar: getUserMedia novo + replaceTrack
//     'replace'  sender.replaceTrack(null)         desmutar: replaceTrack(a mesma faixa)
//     'remove'   pc.removeTrack(sender)            desmutar: pc.addTrack(a mesma faixa)
//   fx.estado()  o que a PÁGINA vê da faixa e do sender (prova que ela mutou de verdade, sem
//                depender do que a extensão observou)
sala.opts.onRemote = (track, streams) => ui.playRemote(track, streams);
sala.opts.beforeOffer = (pc) => { fx.dcrpc = pc.createDataChannel('dcrpc'); };
const tile = (id, name, self) =>
  ui.el('div', { 'data-participant-id': id }, ui.el('span', { class: 'notranslate' }, name), ...(self ? [ui.el('div', { 'data-self-name': name })] : []));

/** A faixa de microfone que a página está usando agora (troca no 'stop'). */
let faixa = null;
/** O sender guardado entre mutar e desmutar (depois do mudo ele não tem mais faixa). */
let guardado = null;
sala.micReady.then(() => { faixa = sala.mic().getAudioTracks()[0]; fx.micPronto = true; });

const senderDoMic = () => (sala.pc ? sala.pc.getSenders().find((s) => s.track && s.track.kind === 'audio') : null);

fx.estado = () => {
  const s = senderDoMic() || guardado;
  return {
    readyState: faixa ? faixa.readyState : null,
    enabled: faixa ? faixa.enabled : null,
    muted: faixa ? faixa.muted : null,
    enviando: Boolean(s && s.track === faixa),
  };
};

fx.mutar = async (forma) => {
  if (forma === 'enabled') faixa.enabled = false;
  else if (forma === 'stop') faixa.stop();
  else if (forma === 'replace') { guardado = senderDoMic(); await guardado.replaceTrack(null); }
  else if (forma === 'remove') { guardado = senderDoMic(); sala.pc.removeTrack(guardado); }
  else throw new Error('forma desconhecida: ' + forma);
  return fx.estado();
};

fx.desmutar = async (forma) => {
  if (forma === 'enabled') faixa.enabled = true;
  else if (forma === 'stop') {
    // Como um aplicativo de verdade faz depois de parar a captura: pede o microfone de novo e põe
    // a faixa nova no sender que já existe.
    const nova = await navigator.mediaDevices.getUserMedia({ audio: true });
    const sender = senderDoMic();
    faixa = nova.getAudioTracks()[0];
    await sender.replaceTrack(faixa);
  } else if (forma === 'replace') await guardado.replaceTrack(faixa);
  else if (forma === 'remove') sala.pc.addTrack(faixa);
  else throw new Error('forma desconhecida: ' + forma);
  return fx.estado();
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
