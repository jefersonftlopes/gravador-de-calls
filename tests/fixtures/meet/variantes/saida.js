// saida (AC5, seam "output"): nenhuma mídia WebRTC com som. O PC existe e está conectado (o
// participante usa ?variante=pcm&pcm= e manda só silêncio), a página toca o receptor mudo no
// <audio>, e o tom sai só por AudioBufferSourceNode -> GainNode -> destination do AudioContext da
// página, como um cliente que decodifica em JS/WASM e toca pelo WebAudio. Só o seam "output" (o
// tee do AudioNode.connect) vê o tom.
function tomEmLaco(ctx, freq) {
  // 1 s de seno com número inteiro de ciclos: o laço não tem emenda.
  const buf = new AudioBuffer({ length: ctx.sampleRate, numberOfChannels: 1, sampleRate: ctx.sampleRate });
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = 0.5 * Math.sin((2 * Math.PI * freq * i) / ctx.sampleRate);
  const src = new AudioBufferSourceNode(ctx, { buffer: buf, loop: true });
  return src;
}

sala.opts.onRemote = (track, streams) => ui.playRemote(track, streams);
ui.$('participar').addEventListener('click', () => {
  const ctx = new AudioContext();
  const src = tomEmLaco(ctx, Number(q.get('tom')) || 440);
  const ganho = new GainNode(ctx, { gain: 1 });
  src.connect(ganho).connect(ctx.destination);
  src.start();
  fx.tomEm = Date.now();
  ui.enterCall();
  sala.start();
});
