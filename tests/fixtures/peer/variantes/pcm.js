// pcm: participante remoto que manda o tom por um RTCDataChannel em PCM (o caminho "decoy" do
// Meet e o WASM do Teams), com o PC carregando silêncio ou um tom só em parte do tempo.
//
// Parâmetros na URL do participante (tempos em ms contados da abertura do DataChannel; cada
// trecho é "de-ate", "de-" vai até o fim; vários trechos separados por vírgula):
//   pcm=<trechos>    quando o tom vai pelo DataChannel (padrão "0-": o tempo todo). Fora dos
//                    trechos vão zeros, para o fluxo não parar. "pcm=" vazio: só zeros.
//   pcTom=<trechos>  quando o tom vai pelo PC (padrão vazio: o PC carrega silêncio o tempo todo)
//
// A página da call cria o DataChannel ("pcm") antes da oferta. Aqui ele chega pelo ondatachannel.
// O PCM é Float32 mono a 48 kHz, em pedaços de ~10 ms, gerados pelo relógio de parede (o timer
// pode atrasar, a quantidade de amostras não). peer.fx.marcos guarda o Date.now() de cada início e
// fim de trecho, para o teste comparar com a troca de seam.
const RATE = 48000;
const trechos = (txt) => (txt || '').split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
  const [de, ate] = s.split('-');
  return { de: Number(de) || 0, ate: ate === undefined || ate === '' ? Infinity : Number(ate) };
});
const pcmTrechos = trechos(peer.q.has('pcm') ? peer.q.get('pcm') : '0-');
const pcTrechos = trechos(peer.q.get('pcTom'));
const fx = peer.fx;
fx.marcos = { dcAberto: null, pcm: pcmTrechos.map((t) => ({ ...t })), pc: pcTrechos.map((t) => ({ ...t })), amostras: 0 };
let pcGain = null;
let ac = null;

peer.opts.makeTrack = (ctx, f) => {
  ac = ctx;
  const osc = new OscillatorNode(ctx, { frequency: f });
  pcGain = new GainNode(ctx, { gain: 0 });
  const dest = new MediaStreamAudioDestinationNode(ctx, { channelCount: 1 });
  osc.connect(pcGain).connect(dest);
  osc.start();
  return dest.stream.getAudioTracks()[0];
};

const dentro = (lista, ms) => lista.some((t) => ms >= t.de && ms < t.ate);

function enviar(dc) {
  const t0 = performance.now();
  const wall0 = Date.now();
  fx.marcos.dcAberto = wall0;
  for (const t of fx.marcos.pcm) { t.deEm = wall0 + t.de; t.ateEm = t.ate === Infinity ? null : wall0 + t.ate; }
  for (const t of fx.marcos.pc) { t.deEm = wall0 + t.de; t.ateEm = t.ate === Infinity ? null : wall0 + t.ate; }
  // Tom no PC: agendado no relógio do AudioContext, com precisão de amostra.
  if (pcGain) {
    const base = ac.currentTime;
    for (const t of pcTrechos) {
      pcGain.gain.setValueAtTime(0.5, base + t.de / 1000);
      if (t.ate !== Infinity) pcGain.gain.setValueAtTime(0, base + t.ate / 1000);
    }
  }
  let n = 0;
  const timer = setInterval(() => {
    if (dc.readyState !== 'open') { clearInterval(timer); return; }
    const due = Math.floor(((performance.now() - t0) / 1000) * RATE) - n;
    if (due <= 0) return;
    // Não deixa a fila do DataChannel crescer sem limite se a página parar de ler.
    if (dc.bufferedAmount > 4 * 1024 * 1024) { n += due; return; }
    for (let off = 0; off < due; off += 480) {
      const len = Math.min(480, due - off);
      const buf = new Float32Array(len);
      for (let i = 0; i < len; i++) {
        const k = n + off + i;
        if (dentro(pcmTrechos, (k / RATE) * 1000)) buf[i] = 0.5 * Math.sin((2 * Math.PI * peer.freq * k) / RATE);
      }
      dc.send(buf.buffer);
    }
    n += due;
    fx.marcos.amostras = n;
  }, 10);
}

peer.opts.onPc = (pc) => {
  pc.ondatachannel = (e) => {
    const dc = e.channel;
    dc.binaryType = 'arraybuffer';
    if (dc.readyState === 'open') enviar(dc);
    else dc.onopen = () => enviar(dc);
  };
};
