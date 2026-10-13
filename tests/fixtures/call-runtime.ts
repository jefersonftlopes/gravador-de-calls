// Parte comum das páginas falsas de call (Meet hoje; Teams na fatia do Teams): microfone falso
// mandado como envio, um RTCPeerConnection com o participante remoto (outra aba no mesmo host,
// tests/fixtures/peer-page.ts) e sinalização por BroadcastChannel.
//
// Expõe na página:
//   window.fixture  estado observado pelos testes (pcState, remoteTrack, micLive, errors...) e o
//                   que chegou aos listeners de 'message' da página (AC14: a ponte da extensão só
//                   pode aparecer ali no aperto de mão, nunca com áudio ou sessão).
//                   errors também recebe toda violação de CSP (securitypolicyviolation), inclusive
//                   as de Trusted Types disparadas por código da extensão que o try/catch dela
//                   engoliu; unhandled recebe o nome de cada rejeição não tratada.
//   window.sala     { q, fx, ch, opts, pc, start(), leave(), mic(), micReady }. A variante ajusta `opts` antes de
//                   chamar start():
//                     sendMic       manda o microfone falso com addTrack (padrão true)
//                     useOntrack    ouve a faixa remota pelo setter ontrack (padrão true)
//                     offerOptions  opções do createOffer (ex.: { offerToReceiveAudio: true })
//                     beforeOffer   (pc) => void, para DataChannel, transceptores etc.
//                     onRemote      (track, streams) => void, faixa remota recebida (ontrack)
//                     onConnected   (pc) => void, quando o PC fica 'connected'
//
// Sem innerHTML: a página roda com require-trusted-types-for 'script', igual ao Meet e ao Teams.
export const CALL_RUNTIME = `
(() => {
  const q = new URLSearchParams(location.search);
  const code = location.pathname.slice(1);
  const ch = new BroadcastChannel('sala-' + (q.get('sala') || code));
  const fx = window.fixture = {
    variant: q.get('variante') || 'normal', state: 'prejoin', pcState: 'none', remoteTrack: false, micLive: false,
    errors: [], unhandled: [], gravadorMessages: [], otherMessages: 0,
  };
  document.addEventListener('securitypolicyviolation', (e) => {
    fx.errors.push('csp: ' + e.violatedDirective + ' ' + (e.sample || '') + ' ' + (e.sourceFile || ''));
  });
  window.addEventListener('unhandledrejection', (e) => {
    fx.unhandled.push((e.reason && e.reason.name) || String(e.reason));
  });
  window.addEventListener('message', (e) => {
    const d = e.data;
    if (d && typeof d === 'object' && '__gravador__' in d) {
      fx.gravadorMessages.push({ t: d.t ?? null, dir: d.dir ?? null, temMsg: 'msg' in d, msgT: (d.msg && d.msg.t) || null });
    } else fx.otherMessages++;
  });
  const opts = { sendMic: true, useOntrack: true, offerOptions: undefined, beforeOffer: null, onRemote: null, onConnected: null };
  let mic = null, id = null, peerReady = false, wantCall = false;
  const guard = (where, fn) => { try { fn(); } catch (e) { fx.errors.push(where + ': ' + e.message); } };

  const micReady = navigator.mediaDevices.getUserMedia({ audio: true }).then((s) => {
    mic = s; fx.micLive = s.getAudioTracks()[0]?.readyState === 'live';
  }).catch((e) => fx.errors.push('gum: ' + e.message));

  async function connect() {
    await micReady;
    id = Math.random().toString(36).slice(2);
    const pc = sala.pc = new RTCPeerConnection();
    pc.onicecandidate = (e) => { if (e.candidate) ch.postMessage({ type: 'cand-from-call', id, c: e.candidate.toJSON() }); };
    pc.onconnectionstatechange = () => {
      fx.pcState = pc.connectionState;
      if (pc.connectionState === 'connected' && opts.onConnected) guard('onConnected', () => opts.onConnected(pc));
    };
    if (opts.useOntrack) {
      pc.ontrack = (e) => { fx.remoteTrack = true; if (opts.onRemote) guard('onRemote', () => opts.onRemote(e.track, e.streams)); };
    }
    if (opts.sendMic && mic) for (const t of mic.getAudioTracks()) pc.addTrack(t, mic);
    if (opts.beforeOffer) guard('beforeOffer', () => opts.beforeOffer(pc));
    await pc.setLocalDescription(await pc.createOffer(opts.offerOptions));
    ch.postMessage({ type: 'offer', id, sdp: pc.localDescription.toJSON() });
  }

  ch.onmessage = async (ev) => {
    const m = ev.data;
    const pc = sala.pc;
    try {
      if (m.type === 'peer-ready') { peerReady = true; if (wantCall && !pc) connect(); }
      else if (m.type === 'answer' && pc && m.id === id) await pc.setRemoteDescription(m.sdp);
      else if (m.type === 'cand-from-peer' && pc && m.id === id) await pc.addIceCandidate(m.c);
    } catch (e) { fx.errors.push(String(e.message)); }
  };

  function start() { wantCall = true; ch.postMessage({ type: 'hello-call' }); if (peerReady && !sala.pc) connect(); }
  function leave() {
    if (sala.pc) { ch.postMessage({ type: 'bye', id }); sala.pc.close(); fx.pcState = 'closed'; sala.pc = null; }
  }
  // Emenda 18: o microfone falso, para a variante ligar e desligar a "sua fala" (track.enabled).
  const sala = window.sala = { q, fx, ch, opts, pc: null, start, leave, micReady, mic: () => mic };
})();
`
