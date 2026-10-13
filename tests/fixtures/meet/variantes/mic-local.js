// mic-local (AC3 em todos os seams): a página toca o PRÓPRIO microfone (1000 Hz) por todos os
// caminhos que os seams "elements", "sources" e "output" escutam, e o tom remoto (440 Hz) só sai
// pelo WebAudio, como na variante saida. O PC existe e carrega silêncio (participante com
// ?variante=pcm&pcm=). Se a exclusão das faixas locais falhar em qualquer seam, ele tem som, é de
// prioridade maior que "output" no Meet, e a arbitragem grava o microfone.
//
// Caminhos do microfone (cada um prova uma regra):
//   1. <audio id="mic-elemento">.srcObject = stream do getUserMedia           elements: faixa local
//   2. createMediaStreamSource(mic) -> destination                             sources e output
//   3. GainNode ligado no destination ANTES; depois createMediaStreamSource(clone do mic) -> ganho
//                                                                              output: contaminação
//                                                                              que chega depois
//   4. createMediaStreamSource(mic) -> MediaStreamDestination -> <audio id="mic-processado">
//                                                                              elements: saída de
//                                                                              grafo com faixa local
//   fx.micDb   energia do microfone medida pela página (prova que ele tem som de verdade)
function tomEmLaco(ctx, freq) {
  const buf = new AudioBuffer({ length: ctx.sampleRate, numberOfChannels: 1, sampleRate: ctx.sampleRate });
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = 0.5 * Math.sin((2 * Math.PI * freq * i) / ctx.sampleRate);
  return new AudioBufferSourceNode(ctx, { buffer: buf, loop: true });
}
fx.micDb = [];

function tocar(id, stream) {
  const a = document.createElement('audio');
  a.id = id;
  a.autoplay = true;
  document.body.append(a);
  a.srcObject = stream;
  a.play().catch((err) => fx.errors.push('play ' + id + ': ' + err.message));
}

sala.opts.onRemote = () => {};
ui.$('participar').addEventListener('click', async () => {
  const ctx = new AudioContext();
  const tom = tomEmLaco(ctx, Number(q.get('tom')) || 440);
  tom.connect(new GainNode(ctx, { gain: 1 })).connect(ctx.destination);
  tom.start();
  ui.enterCall();
  sala.start();
  try {
    const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
    const faixa = mic.getAudioTracks()[0];
    tocar('mic-elemento', mic);
    ctx.createMediaStreamSource(mic).connect(ctx.destination);
    const ganho = ctx.createGain();
    ganho.connect(ctx.destination);
    ctx.createMediaStreamSource(new MediaStream([faixa.clone()])).connect(ganho);
    const processado = ctx.createMediaStreamDestination();
    ctx.createMediaStreamSource(mic).connect(processado);
    tocar('mic-processado', processado.stream);
    const an = new AnalyserNode(ctx, { fftSize: 2048 });
    ctx.createMediaStreamSource(mic).connect(an);
    const b = new Float32Array(an.fftSize);
    setInterval(() => {
      an.getFloatTimeDomainData(b);
      let s = 0;
      for (const v of b) s += v * v;
      const rms = Math.sqrt(s / b.length);
      fx.micDb.push(rms > 0 ? 20 * Math.log10(rms) : -200);
    }, 500);
  } catch (e) {
    fx.errors.push('mic-local: ' + e.message);
  }
});
