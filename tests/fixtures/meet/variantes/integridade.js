// integridade (AC14): igual à "normal", mas a própria página mede o que ela recebe e expõe o que
// ela consegue observar das APIs embrulhadas. O teste roda esta variante com e sem a extensão, e
// as duas medições têm de bater.
//
//   fx.amostras        energia (dBFS) da faixa remota a cada 250 ms, medida pela página com o
//                      AudioContext DELA (createMediaStreamSource -> AnalyserNode, sem destino)
//   fx.fatos()         o que a página vê das APIs: instanceof, constructor, nome/length dos
//                      métodos, se são construtíveis, se o elemento toca, o que cada método
//                      embrulhado devolve (regra 1: o mesmo objeto que o original devolveria) e
//                      quais propriedades são enumeráveis (Object.keys, for-in). Assíncrona: o
//                      teste faz `await fx.fatos()`.
//   fx.rejeitar()      chama getUserMedia({}) (TypeError) sem tratar e com tratamento; a página
//                      tem de ver exatamente um unhandledrejection, como sem a extensão
let ctx = null;
fx.amostras = [];

function medir(stream) {
  try {
    const src = ctx.createMediaStreamSource(stream);
    const an = new AnalyserNode(ctx, { fftSize: 2048 });
    src.connect(an);
    const buf = new Float32Array(an.fftSize);
    setInterval(() => {
      an.getFloatTimeDomainData(buf);
      let s = 0;
      for (const v of buf) s += v * v;
      const rms = Math.sqrt(s / buf.length);
      fx.amostras.push(rms > 0 ? 20 * Math.log10(rms) : -200);
    }, 250);
  } catch (e) {
    fx.errors.push('medir: ' + e.message);
  }
}

sala.opts.onRemote = (track, streams) => {
  ui.playRemote(track, streams);
  medir((streams && streams[0]) || new MediaStream([track]));
};

const construtivel = (f) => {
  try {
    new f();
    return 'construiu';
  } catch (e) {
    return e.constructor.name;
  }
};
const assinatura = (f) => [f.name, f.length, 'prototype' in f, construtivel(f)];

// Regra 1 (ARQUITETURA): cada embrulho devolve exatamente o que o original devolveu. Num PC de
// rascunho (o da call não é tocado), cada item é um booleano que vale true sem a extensão; o
// teste exige o mesmo resultado com ela. O microfone falso entra como envio, como na call.
async function retornos() {
  const out = {};
  const pc = new RTCPeerConnection();
  const parar = [];
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    out.getUserMediaResolveStream = s instanceof MediaStream && Object.getPrototypeOf(s) === MediaStream.prototype;
    const t = s.getAudioTracks()[0];
    parar.push(...s.getTracks());
    const sender = pc.addTrack(t, s);
    out.addTrackDevolveSender = sender instanceof RTCRtpSender && pc.getSenders().includes(sender) && sender.track === t;
    const tr = pc.addTransceiver('audio');
    out.addTransceiverDevolveTransceptor = tr instanceof RTCRtpTransceiver && pc.getTransceivers().includes(tr);
    const c = t.clone();
    parar.push(c);
    out.trackCloneNovo = c instanceof MediaStreamTrack && c !== t && c.id !== t.id && c.kind === t.kind;
    const sc = s.clone();
    parar.push(...sc.getTracks());
    out.streamCloneNovo = sc instanceof MediaStream && sc !== s && sc.id !== s.id && sc.getTracks().length === s.getTracks().length;
    const p = sender.replaceTrack(c);
    out.replaceTrackDevolvePromise = p instanceof Promise && Object.getPrototypeOf(p) === Promise.prototype;
    await p;
    out.replaceTrackTrocou = sender.track === c;
  } catch (e) {
    out.erro = e.name + ': ' + e.message;
  }
  out.closeDevolveUndefined = pc.close() === undefined;
  for (const t of parar) t.stop();
  return out;
}

// Enumerabilidade: operações e atributos WebIDL são enumeráveis, inclusive os herdados (o
// addEventListener do PC vem de EventTarget.prototype). Object.keys dos protótipos embrulhados
// (redefinir uma chave própria não muda a ordem) e o for-in de um PC (ordenado: o embrulho do
// addEventListener vira chave própria de RTCPeerConnection.prototype e muda de posição, diferença
// aceita na Emenda 5; o que não pode mudar é ele continuar enumerável).
function chaves(pc) {
  const semAddEventListener = (ks) => ks.filter((k) => k !== 'addEventListener');
  const forIn = [];
  for (const k in pc) forIn.push(k);
  return {
    pcProto: semAddEventListener(Object.keys(RTCPeerConnection.prototype)),
    eventTarget: Object.keys(EventTarget.prototype),
    sender: Object.keys(RTCRtpSender.prototype),
    mediaDevices: Object.keys(MediaDevices.prototype),
    track: Object.keys(MediaStreamTrack.prototype),
    stream: Object.keys(MediaStream.prototype),
    pcForIn: forIn.sort(),
    pcInstancia: Object.keys(pc),
  };
}

// Seams "elements", "sources" e "output": os embrulhos do setter srcObject, de
// createMediaStreamSource e de AudioNode.connect/disconnect, no mesmo formato de retornos() e
// chaves(). Num contexto de rascunho (fechado no fim): cada item vale true, ou o nome do erro, sem
// a extensão, e tem de valer o mesmo com ela. Também em fx.retornosAudio, para o teste dos seams
// conferir os valores sem precisar entrar na call.
async function retornosAudio() {
  const out = {};
  const ctx = new AudioContext();
  const outro = new AudioContext();
  const erro = (f) => {
    try {
      f();
      return 'sem erro';
    } catch (e) {
      return e.name;
    }
  };
  try {
    const stream = ctx.createMediaStreamDestination().stream;
    const src = ctx.createMediaStreamSource(stream);
    out.createMediaStreamSourceDevolveNo = src instanceof MediaStreamAudioSourceNode && src.mediaStream === stream && src.context === ctx;
    const g = ctx.createGain();
    out.connectDevolveDestino = src.connect(g) === g;
    out.connectNoDestinationDevolveDestination = g.connect(ctx.destination) === ctx.destination;
    out.connectParamDevolveUndefined = src.connect(g.gain) === undefined;
    out.disconnectNoDevolveUndefined = g.disconnect(ctx.destination) === undefined;
    out.disconnectDevolveUndefined = src.disconnect() === undefined;
    out.connectOutroContexto = erro(() => g.connect(outro.destination));
    out.connectSaidaInvalida = erro(() => g.connect(ctx.destination, 5));
    out.disconnectNaoLigado = erro(() => g.disconnect(ctx.destination));
    out.disconnectSaidaInvalida = erro(() => g.disconnect(7));
    const a = document.createElement('audio');
    a.srcObject = stream;
    out.srcObjectDevolveOMesmo = a.srcObject === stream;
    a.srcObject = null;
    out.srcObjectNulo = a.srcObject === null;
    out.srcObjectInvalido = erro(() => {
      a.srcObject = {};
    });
  } catch (e) {
    out.erro = e.name + ': ' + e.message;
  }
  await ctx.close();
  await outro.close();
  return out;
}
fx.retornosAudio = retornosAudio;

function chavesAudio() {
  return {
    audioNode: Object.keys(AudioNode.prototype),
    audioContext: Object.keys(AudioContext.prototype),
    baseAudioContext: Object.keys(BaseAudioContext.prototype),
    media: Object.keys(HTMLMediaElement.prototype),
  };
}

fx.fatos = async () => {
  const PC = RTCPeerConnection;
  const pc = sala.pc;
  const proto = PC.prototype;
  const a = ui.$('remoto');
  return {
    instanceOf: pc instanceof PC,
    ctor: pc.constructor === PC,
    proto: Object.getPrototypeOf(pc) === proto,
    protoCtor: proto.constructor === PC,
    nome: [PC.name, PC.length],
    generateCertificate: typeof PC.generateCertificate,
    metodos: ['addTrack', 'addTransceiver', 'close', 'getReceivers', 'getSenders', 'createOffer', 'addEventListener'].map((n) => [n, ...assinatura(proto[n])]),
    ontrack: assinatura(Object.getOwnPropertyDescriptor(proto, 'ontrack').set),
    getUserMedia: assinatura(MediaDevices.prototype.getUserMedia),
    getDisplayMedia: assinatura(MediaDevices.prototype.getDisplayMedia),
    trackClone: assinatura(MediaStreamTrack.prototype.clone),
    streamClone: assinatura(MediaStream.prototype.clone),
    replaceTrack: assinatura(RTCRtpSender.prototype.replaceTrack),
    gumDevolvePromise: (() => {
      const p = navigator.mediaDevices.getUserMedia({ audio: true });
      p.then((s) => s.getTracks().forEach((t) => t.stop()), () => {});
      return p instanceof Promise && Object.getPrototypeOf(p) === Promise.prototype;
    })(),
    retornos: await retornos(),
    chaves: chaves(pc),
    elementoTocando: !a.paused && a.readyState >= 2,
    pcEstado: pc.connectionState,
    contextoDaPagina: ctx && ctx.state,
    seamsMetodos: [
      ['connect', ...assinatura(AudioNode.prototype.connect)],
      ['disconnect', ...assinatura(AudioNode.prototype.disconnect)],
      ['createMediaStreamSource', ...assinatura(AudioContext.prototype.createMediaStreamSource)],
    ],
    srcObject: assinatura(Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'srcObject').set),
    srcObjectGet: assinatura(Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'srcObject').get),
    seamsRetornos: await retornosAudio(),
    seamsChaves: chavesAudio(),
  };
};

fx.rejeitar = () => {
  // Sem tratar: o unhandledrejection da página tem de disparar (uma vez).
  navigator.mediaDevices.getUserMedia({});
  // Tratada: nada dispara.
  navigator.mediaDevices.getUserMedia({}).catch(() => {});
};

ui.$('participar').addEventListener('click', () => {
  // O contexto da página nasce no gesto, como no Meet.
  ctx = new AudioContext();
  ui.enterCall();
  sala.start();
});
