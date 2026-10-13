// Shared lab helpers: loopback WebRTC page served from http://localhost (secure context).
const { chromium } = require('playwright');

const BROWSERS = {
  chrome154: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  cft151: `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
};

// In-page library injected into every test page.
const LIB = `
window.lab = {};
lab.sleep = (ms) => new Promise(r => setTimeout(r, ms));
// Create a loopback pair; sender sends N oscillator tracks with the given freqs.
lab.makePair = async (freqs, acS) => {
  acS = acS || new AudioContext();
  const pc1 = new RTCPeerConnection(), pc2 = new RTCPeerConnection();
  pc1.onicecandidate = e => e.candidate && pc2.addIceCandidate(e.candidate);
  pc2.onicecandidate = e => e.candidate && pc1.addIceCandidate(e.candidate);
  const oscs = [], sendTracks = [];
  for (const f of freqs) {
    const o = acS.createOscillator(); o.frequency.value = f;
    const d = acS.createMediaStreamDestination(); o.connect(d); o.start();
    oscs.push(o); const t = d.stream.getAudioTracks()[0]; sendTracks.push(t);
    pc1.addTrack(t, new MediaStream([t]));
  }
  const recv = [];
  const got = new Promise(res => { pc2.ontrack = e => { recv.push(e); if (recv.length === freqs.length) res(); }; });
  const offer = await pc1.createOffer(); await pc1.setLocalDescription(offer);
  await pc2.setRemoteDescription(offer);
  const ans = await pc2.createAnswer(); await pc2.setLocalDescription(ans);
  await pc1.setRemoteDescription(ans);
  await got;
  return { pc1, pc2, acS, oscs, sendTracks, recvEvents: recv, recvTracks: pc2.getReceivers().map(r => r.track) };
};
// Measure RMS of a track through WebAudio (analyser not connected to destination: no sound).
lab.measure = async (track, ms = 3000, ac) => {
  ac = ac || new AudioContext();
  const src = ac.createMediaStreamSource(new MediaStream([track]));
  const an = ac.createAnalyser(); an.fftSize = 2048; src.connect(an);
  const buf = new Float32Array(an.fftSize); let max = 0, samples = 0;
  const t0 = performance.now();
  while (performance.now() - t0 < ms) {
    await lab.sleep(100); an.getFloatTimeDomainData(buf);
    let s = 0; for (const v of buf) s += v * v; const rms = Math.sqrt(s / buf.length);
    max = Math.max(max, rms); samples++;
  }
  return { maxRms: +max.toFixed(4), acState: ac.state, samples };
};
lab.blobToB64 = (blob) => new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result.split(',')[1]); fr.readAsDataURL(blob); });
lab.record = async (stream, ms, opts = {}, timeslice) => {
  const mr = new MediaRecorder(stream, opts); const chunks = []; const times = [];
  mr.ondataavailable = e => { chunks.push(e.data); times.push([Math.round(performance.now()), e.data.size]); };
  const stopped = new Promise(r => mr.onstop = r);
  let err = null; mr.onerror = e => { err = String(e.error || e); };
  timeslice ? mr.start(timeslice) : mr.start();
  await lab.sleep(ms); mr.stop(); await stopped;
  const blob = new Blob(chunks, { type: mr.mimeType });
  return { mimeType: mr.mimeType, size: blob.size, nChunks: chunks.length, times, err, b64: await lab.blobToB64(blob), chunkB64: timeslice ? await Promise.all(chunks.map(lab.blobToB64)) : null };
};
`;

async function launch(which, args = [], headless = true) {
  const browser = await chromium.launch({ executablePath: BROWSERS[which], headless, args });
  return browser;
}

async function newLabPage(browser, extraHtml = '') {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.route('http://localhost/**', r => r.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body><button id="b">join</button><script>${LIB}</script>${extraHtml}</body></html>` }));
  await page.goto('http://localhost/test');
  return { ctx, page };
}

module.exports = { launch, newLabPage, BROWSERS, LIB };
