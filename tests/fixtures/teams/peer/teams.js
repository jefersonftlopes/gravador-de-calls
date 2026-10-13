// teams: participante remoto do Teams falso. Manda duas faixas, como o servidor de mídia do Teams:
// a mistura principal num stream `mainAudio` (tom `tom`, padrão 440 Hz) e uma faixa redundante
// num stream `dominantSpeaker-1` (tom `dominante`, padrão 660 Hz), que a extensão não pode gravar.
//
//   ?mudo=1         a faixa principal vai em silêncio (caminho WASM do Teams: o som de verdade
//                   chega por outro caminho, montado pela página)
//   ?dominante=0    a faixa redundante vai em silêncio
//
// O id do stream do outro lado sai do `a=msid` da resposta. A resposta é reescrita só no que vai
// para a página da call (o `localDescription` desta instância), trocando o id de cada stream pelo
// rótulo do Teams; a descrição aplicada aqui fica a original.
const domFreq = Number(peer.q.get('dominante')) || 660;
const domGain = peer.q.get('dominante') === '0' ? 0 : 0.5;
const mainGain = peer.q.get('mudo') === '1' ? 0 : 0.5;
let main = null;
let dom = null;
const tom = (ac, f, g) => {
  const osc = new OscillatorNode(ac, { frequency: f });
  const gain = new GainNode(ac, { gain: g });
  const dest = new MediaStreamAudioDestinationNode(ac, { channelCount: 1 });
  osc.connect(gain).connect(dest);
  osc.start();
  return dest.stream.getAudioTracks()[0];
};
peer.opts.makeTrack = (ac, f) => {
  main = tom(ac, f, mainGain);
  dom = tom(ac, domFreq, domGain);
  return main;
};
let domStream = null;
// O stream da faixa redundante é criado aqui (o id é conhecido); o da principal é criado pela
// página do participante, então todo outro stream da resposta é o principal. (O id da faixa no
// `a=msid` não serve: para a faixa ligada depois da oferta ele não bate com o da faixa, medido
// no CfT 151.)
function rotular(sdp) {
  const novo = new Map();
  for (const m of sdp.matchAll(/msid:(\S+) (\S+)/g)) novo.set(m[1], m[1] === domStream.id ? 'dominantSpeaker-1' : 'mainAudio');
  let out = sdp;
  for (const [antigo, r] of novo) out = out.split(antigo).join(r);
  return out;
}
peer.opts.onPc = (pc) => {
  // Antes da resposta: a faixa redundante fica com a primeira linha de áudio da oferta (a do
  // microfone da página) e a principal, adicionada depois pela página do participante, com a
  // linha só de recepção que a página da call também oferece.
  domStream = new MediaStream([dom]);
  pc.addTrack(dom, domStream);
  const getter = Object.getOwnPropertyDescriptor(RTCPeerConnection.prototype, 'localDescription').get;
  Object.defineProperty(pc, 'localDescription', {
    configurable: true,
    get() {
      const d = getter.call(pc);
      return d ? new RTCSessionDescription({ type: d.type, sdp: rotular(d.sdp) }) : d;
    },
  });
};
