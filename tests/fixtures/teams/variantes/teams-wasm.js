// teams-wasm: caminho do codec WASM do Teams. A faixa `mainAudio` do receptor chega em silêncio
// (o participante remoto usa ?mudo=1) e o som de verdade é montado pela página: um
// MediaStreamTrackGenerator (o "unmixedAudioProvider" do Teams) recebe o PCM decodificado, passa
// pelo AudioContext da página até um MediaStreamDestination, e o <audio> do body toca esse stream.
// Aqui o PCM é um tom de 440 Hz gerado na própria página (no Teams, sai do decodificador WASM).
ui.opts.objeto = 'v2';
ui.opts.fim = 'estado';
ui.opts.tocarPrincipal = false;
const RATE = 48000;
const FRAME = 480; // 10 ms
let ac = null;
let writer = null;
let gerados = 0;
let t0 = 0;
function escrever() {
  // Mantém o gerador ~200 ms à frente do relógio.
  const alvo = Math.floor(((performance.now() - t0) / 1000 + 0.2) * RATE);
  while (gerados < alvo) {
    const data = new Float32Array(FRAME);
    for (let i = 0; i < FRAME; i++) data[i] = 0.5 * Math.sin((2 * Math.PI * 440 * (gerados + i)) / RATE);
    const frame = new AudioData({ format: 'f32-planar', sampleRate: RATE, numberOfFrames: FRAME, numberOfChannels: 1, timestamp: Math.round((gerados / RATE) * 1e6), data });
    writer.write(frame).catch((e) => fx.errors.push('gerador: ' + e.message));
    gerados += FRAME;
  }
}
function decodificador() {
  const gen = new MediaStreamTrackGenerator({ kind: 'audio' });
  writer = gen.writable.getWriter();
  t0 = performance.now();
  setInterval(escrever, 20);
  ac = new AudioContext({ sampleRate: RATE });
  const src = ac.createMediaStreamSource(new MediaStream([gen]));
  const dest = ac.createMediaStreamDestination();
  src.connect(dest);
  const a = document.createElement('audio');
  a.autoplay = true;
  document.body.append(a);
  a.srcObject = dest.stream;
  a.play().catch((err) => fx.errors.push('play: ' + err.message));
  fx.wasm = true;
}
const admitirOriginal = ui.admitir;
ui.admitir = () => {
  admitirOriginal();
  try { decodificador(); } catch (e) { fx.errors.push('decodificador: ' + e.message); }
};
ui.prejoin();
