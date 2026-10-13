// decoy (AC5, seam "sources"): o receptor WebRTC carrega silêncio, como o Meet já fez, e a página
// ainda o toca no <audio> (o elemento existe e fica mudo de verdade). O áudio real chega por um
// RTCDataChannel em PCM (participante com ?variante=pcm) e a página toca por
// MediaStreamTrackGenerator -> createMediaStreamSource -> destination do AudioContext dela.
// O seam "receivers" fica mudo; "sources" (e "output") têm o tom.
//
//   fx.pcm       { recebidas, escritas, faltas, faltasEm, inicioEm }: o que o tocador de PCM fez
//                (faltasEm: Date.now() de cada quadro completado com zeros)
//   fx.tomEm     Date.now() da primeira amostra com som escrita no gerador (começo da fala)
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
sala.opts.onRemote = (track, streams) => ui.playRemote(track, streams);
sala.opts.beforeOffer = (pc) => {
  const dc = pc.createDataChannel('pcm', { ordered: true });
  dc.binaryType = 'arraybuffer';
  dc.onmessage = (e) => { if (receber) receber(e.data); };
};

ui.$('participar').addEventListener('click', () => {
  // O contexto da página nasce no gesto, como no Meet.
  const ctx = new AudioContext();
  const gen = new MediaStreamTrackGenerator({ kind: 'audio' });
  const src = ctx.createMediaStreamSource(new MediaStream([gen]));
  src.connect(ctx.destination);
  receber = tocadorPcm(gen.writable.getWriter());
  ui.enterCall();
  sala.start();
});
