// elemento-gerado (AC5, seam "elements"): o formato do Teams no caminho WASM. O receptor WebRTC
// carrega silêncio e a página não o toca em nenhum elemento. O áudio real chega por um
// RTCDataChannel em PCM (participante com ?variante=pcm), vai para um MediaStreamTrackGenerator,
// passa pelo AudioContext da página até um MediaStreamDestination e toca num <audio> criado e
// posto no body (srcObject = destino.stream).
//
// O gerador entra no contexto pelo CONSTRUTOR de MediaStreamAudioSourceNode (não por
// createMediaStreamSource) e o destino é de stream, não o AudioDestinationNode: assim só o seam
// "elements" vê o tom, e o teste prova esse seam sozinho.
//
//   fx.pcm, fx.tomEm   como na variante decoy
const RATE = 48000;
const PREBUFFER = Math.round(0.15 * RATE);
const QUADRO = 480;
fx.pcm = { recebidas: 0, escritas: 0, faltas: 0, faltasEm: [], inicioEm: null };
fx.tomEm = null;

// Tocador com buffer de jitter: guarda o que chega e escreve no gerador no ritmo do relógio,
// completando com zeros se faltar (como um decodificador de verdade faria).
function tocadorPcm(writer) {
  const fila = [];
  let naFila = 0;
  let t0 = 0;
  let escritas = 0;
  const tirar = (n) => {
    const out = new Float32Array(n);
    let k = 0;
    while (k < n && fila.length) {
      const c = fila[0];
      const m = Math.min(n - k, c.length);
      out.set(c.subarray(0, m), k);
      k += m;
      if (m === c.length) fila.shift();
      else fila[0] = c.subarray(m);
    }
    naFila -= k;
    if (k < n) {
      fx.pcm.faltas += n - k;
      // Quando faltou (para o teste cruzar com uma queda do tom no arquivo).
      if (fx.pcm.faltasEm.length < 500) fx.pcm.faltasEm.push(Date.now());
    }
    return out;
  };
  // Quadros fixos de 10 ms (480 amostras), como um decodificador entrega. Medido no CfT 151:
  // quadros de tamanho variável (o que o timer deixasse) saem do gerador com falhas de fase, e o
  // tom de 440 Hz cai de -6 para -16 a -29 dBFS até no áudio da própria página.
  setInterval(() => {
    if (!t0) {
      if (naFila < PREBUFFER) return;
      t0 = performance.now();
      fx.pcm.inicioEm = Date.now();
    }
    while (Math.floor(((performance.now() - t0) / 1000) * RATE) - escritas >= QUADRO) {
      const data = tirar(QUADRO);
      if (fx.tomEm === null && data.some((v) => Math.abs(v) > 0.05)) fx.tomEm = Date.now();
      try {
        writer.write(new AudioData({ format: 'f32-planar', sampleRate: RATE, numberOfFrames: QUADRO, numberOfChannels: 1, timestamp: Math.round((escritas / RATE) * 1e6), data }));
      } catch (e) {
        fx.errors.push('AudioData: ' + e.message);
      }
      escritas += QUADRO;
    }
    fx.pcm.escritas = escritas;
  }, 5);
  return (buf) => {
    fila.push(new Float32Array(buf));
    naFila += buf.byteLength / 4;
    fx.pcm.recebidas++;
  };
}

let receber = null;
sala.opts.onRemote = () => {};
sala.opts.beforeOffer = (pc) => {
  const dc = pc.createDataChannel('pcm', { ordered: true });
  dc.binaryType = 'arraybuffer';
  dc.onmessage = (e) => { if (receber) receber(e.data); };
};

ui.$('participar').addEventListener('click', () => {
  const ctx = new AudioContext();
  const gen = new MediaStreamTrackGenerator({ kind: 'audio' });
  const src = new MediaStreamAudioSourceNode(ctx, { mediaStream: new MediaStream([gen]) });
  const destino = ctx.createMediaStreamDestination();
  src.connect(destino);
  const a = document.createElement('audio');
  a.autoplay = true;
  a.id = 'gerado';
  document.body.append(a);
  a.srcObject = destino.stream;
  a.play().catch((err) => fx.errors.push('play gerado: ' + err.message));
  receber = tocadorPcm(gen.writable.getWriter());
  ui.enterCall();
  sala.start();
});
