// "Participante remoto": outra aba no mesmo host (servida em /__peer de todos os hosts de call,
// ver ./routes.ts). Toca um tom pelo RTCPeerConnection e mede o microfone que recebe da página da
// call (prova que o microfone falso é um envio de verdade). Sinalização por BroadcastChannel
// (mesma origem, mesmo perfil).
//
// Variantes opcionais em ./peer/variantes/<nome>.js (`?variante=<nome>`), lidas por ./routes.ts:
// o arquivo é o corpo de uma função com `peer` = { q, fx, ch, opts, freq } no escopo, rodado
// antes do clique em "Iniciar participante". Pontos de extensão:
//   opts.makeTrack(ac, freq)  devolve a faixa que vai no PC (padrão: tom de `freq` Hz a 0,5)
//   opts.onPc(pc)             chamado com cada PC novo, antes da resposta (DataChannel etc.)
export function peerPage(variantJs = ''): string {
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><title>Participante remoto</title></head>
<body>
<button id="iniciar">Iniciar participante</button>
<p id="estado">parado</p>
<script>
(() => {
  const q = new URLSearchParams(location.search);
  const freq = Number(q.get('tom')) || 440;
  const ch = new BroadcastChannel('sala-' + (q.get('sala') || 'x'));
  const fx = window.fixture = { state: 'parado', micRms: 0, calls: 0, errors: [] };
  const opts = {
    makeTrack(ac, f) {
      const osc = new OscillatorNode(ac, { frequency: f });
      const gain = new GainNode(ac, { gain: 0.5 });
      const dest = new MediaStreamAudioDestinationNode(ac, { channelCount: 1 });
      osc.connect(gain).connect(dest);
      osc.start();
      return dest.stream.getAudioTracks()[0];
    },
    onPc: null,
  };
  window.peer = { q, fx, ch, opts, freq };
  let ac = null, tone = null, pc = null, currentId = null, analyser = null;
  const setState = (s) => { fx.state = s; document.getElementById('estado').textContent = s; };

  document.getElementById('iniciar').addEventListener('click', () => {
    ac = new AudioContext();
    tone = opts.makeTrack(ac, freq);
    window.peer.ac = ac;
    setState('pronto');
    ch.postMessage({ type: 'peer-ready' });
  });

  // Mede o microfone recebido (com um <audio> mudo por causa do crbug 40094084).
  const watchMic = (track) => {
    const a = new Audio(); a.muted = true; a.srcObject = new MediaStream([track]);
    const src = new MediaStreamAudioSourceNode(ac, { mediaStream: new MediaStream([track]) });
    analyser = new AnalyserNode(ac, { fftSize: 2048 });
    src.connect(analyser);
    const buf = new Float32Array(analyser.fftSize);
    setInterval(() => {
      analyser.getFloatTimeDomainData(buf);
      let s = 0; for (const v of buf) s += v * v;
      fx.micRms = Math.max(fx.micRms, Math.sqrt(s / buf.length));
    }, 200);
  };

  ch.onmessage = async (ev) => {
    const m = ev.data;
    try {
      if (m.type === 'hello-call' && tone) ch.postMessage({ type: 'peer-ready' });
      if (m.type === 'offer') {
        if (!tone) return;
        if (pc) pc.close();
        currentId = m.id; fx.calls++;
        pc = new RTCPeerConnection();
        pc.onicecandidate = (e) => { if (e.candidate) ch.postMessage({ type: 'cand-from-peer', id: m.id, c: e.candidate.toJSON() }); };
        pc.ontrack = (e) => watchMic(e.track);
        if (opts.onPc) opts.onPc(pc);
        await pc.setRemoteDescription(m.sdp);
        pc.addTrack(tone, new MediaStream([tone]));
        await pc.setLocalDescription(await pc.createAnswer());
        ch.postMessage({ type: 'answer', id: m.id, sdp: pc.localDescription.toJSON() });
        setState('em-call');
      } else if (m.type === 'cand-from-call' && pc && m.id === currentId) {
        await pc.addIceCandidate(m.c);
      } else if (m.type === 'bye' && pc && m.id === currentId) {
        pc.close(); pc = null; setState('pronto');
      }
    } catch (e) { fx.errors.push(String(e.message)); setState('erro: ' + e.message); }
  };
})();
</script>
<script>
(() => {
  const { peer } = window;
${variantJs}
})();
</script>
</body></html>`
}
