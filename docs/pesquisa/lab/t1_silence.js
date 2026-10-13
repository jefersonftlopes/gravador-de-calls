// T1: is a remote WebRTC track silent in WebAudio / MediaRecorder unless attached to a media element?
const { launch, newLabPage } = require('./common');
const fs = require('fs'); const { execSync } = require('child_process');
const which = process.argv[2] || 'chrome154';

const CASES = {
  noElement: `const p = await lab.makePair([440]); return await lab.measure(p.recvTracks[0]);`,
  mutedElementPlayed: `const p = await lab.makePair([440]); const a = new Audio(); a.muted = true; a.srcObject = new MediaStream([p.recvTracks[0]]); await a.play(); return await lab.measure(p.recvTracks[0]);`,
  mutedElementNotPlayed: `const p = await lab.makePair([440]); const a = new Audio(); a.muted = true; a.srcObject = new MediaStream([p.recvTracks[0]]); return await lab.measure(p.recvTracks[0]);`,
  volume0ElementPlayed: `const p = await lab.makePair([440]); const a = new Audio(); a.volume = 0; a.srcObject = new MediaStream([p.recvTracks[0]]); await a.play(); return await lab.measure(p.recvTracks[0]);`,
  mutedAutoplayAttrInDom: `const p = await lab.makePair([440]); const a = document.createElement('audio'); a.muted = true; a.autoplay = true; document.body.appendChild(a); a.srcObject = new MediaStream([p.recvTracks[0]]); return await lab.measure(p.recvTracks[0]);`,
  // Page plays track A of the same PC; we tap track B (no element for B).
  otherTrackSamePcPlayed: `const p = await lab.makePair([440, 880]); const a = new Audio(); a.muted = true; a.srcObject = new MediaStream([p.recvTracks[0]]); await a.play(); return { tapped: await lab.measure(p.recvTracks[1]) };`,
  // Page plays a track from a DIFFERENT pc; we tap a track of another pc.
  otherPcPlayed: `const p1 = await lab.makePair([440]); const p2 = await lab.makePair([880]); const a = new Audio(); a.muted = true; a.srcObject = new MediaStream([p1.recvTracks[0]]); await a.play(); return { tapped: await lab.measure(p2.recvTracks[0]) };`,
  // Element paused after play: does the tap keep working?
  elementPausedAfter: `const p = await lab.makePair([440]); const a = new Audio(); a.muted = true; a.srcObject = new MediaStream([p.recvTracks[0]]); await a.play(); const before = await lab.measure(p.recvTracks[0], 1500); a.pause(); await lab.sleep(500); const after = await lab.measure(p.recvTracks[0], 2000); return {before, after};`,
  hasTrackSourceApi: `const ac = new AudioContext(); return { createMediaStreamTrackSource: typeof ac.createMediaStreamTrackSource, MediaStreamTrackAudioSourceNode: typeof window.MediaStreamTrackAudioSourceNode };`,
  recorderNoElement: `const p = await lab.makePair([440]); return await lab.record(new MediaStream([p.recvTracks[0]]), 3000, {mimeType:'audio/webm;codecs=opus'});`,
  recorderMutedElement: `const p = await lab.makePair([440]); const a = new Audio(); a.muted = true; a.srcObject = new MediaStream([p.recvTracks[0]]); await a.play(); return await lab.record(new MediaStream([p.recvTracks[0]]), 3000, {mimeType:'audio/webm;codecs=opus'});`,
};

function volumedetect(file) {
  try {
    const out = execSync(`ffmpeg -hide_banner -nostats -i ${file} -af volumedetect -f null - 2>&1`).toString();
    const m = out.match(/mean_volume: ([-\d.]+) dB/); const x = out.match(/max_volume: ([-\d.]+) dB/);
    return { mean_dB: m && +m[1], max_dB: x && +x[1] };
  } catch (e) { return { ffmpegError: String(e.stdout || e).slice(-300) }; }
}

(async () => {
  const only = process.argv[3];
  for (const [name, body] of Object.entries(CASES)) {
    if (only && !only.split(',').includes(name)) continue;
    const browser = await launch(which, ['--autoplay-policy=no-user-gesture-required']);
    try {
      const { page } = await newLabPage(browser);
      const res = await page.evaluate(`(async () => { ${body} })()`);
      if (res && res.b64) {
        const f = `${__dirname}/out_${which}_${name}.webm`; fs.writeFileSync(f, Buffer.from(res.b64, 'base64'));
        delete res.b64; delete res.chunkB64; res.audio = volumedetect(f);
      }
      console.log(which, name, JSON.stringify(res));
    } catch (e) { console.log(which, name, 'ERROR', e.message.split('\n')[0]); }
    await browser.close();
  }
})();
