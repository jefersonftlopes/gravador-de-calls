// T6c: MediaRecorder DIRECTLY on a remote track (no WebAudio): timeline when sender stops RTP for 3 s, and when the page element is paused.
const { launch, newLabPage } = require('./common'); const fs = require('fs'); const { execSync } = require('child_process'); const D = __dirname;
const sh = (c) => { try { return execSync(c + ' 2>&1').toString(); } catch (e) { return String(e.stdout || e); } };
(async () => {
  const b = await launch('chrome154', ['--autoplay-policy=no-user-gesture-required']); const { page } = await newLabPage(b);
  const r = await page.evaluate(`(async () => { const p = await lab.makePair([440]);
    const a = new Audio(); a.muted = true; a.srcObject = new MediaStream([p.recvTracks[0]]); await a.play();
    const recP = lab.record(new MediaStream([p.recvTracks[0]]), 10000, { mimeType: 'audio/webm;codecs=opus' }, 1000);
    await lab.sleep(2000); const s = p.pc1.getSenders()[0]; await s.replaceTrack(null); await lab.sleep(3000); await s.replaceTrack(p.sendTracks[0]);
    const r = await recP; delete r.chunkB64; return r; })()`);
  const f = `${D}/t6c_direct.webm`; fs.writeFileSync(f, Buffer.from(r.b64, 'base64'));
  console.log('direct-on-track decoded', (sh(`ffmpeg -hide_banner -nostats -i ${f} -f null -`).match(/time=(\S+)/g) || []).pop(), 'wall 10s');
  console.log('silences', (sh(`ffmpeg -hide_banner -nostats -i ${f} -af silencedetect=n=-50dB:d=0.5 -f null -`).match(/silence_(start|end): [\d.]+/g) || []).join(' '));
  await b.close();
})();
