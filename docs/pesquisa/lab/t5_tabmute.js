// T5: Chrome tab mute (chrome.tabs.update muted:true, same path as "Mute site"/tab audio indicator): does remote WebRTC audio still reach WebAudio + MediaRecorder?
const { chromium } = require('playwright');
const { BROWSERS, LIB } = require('./common');
const fs = require('fs'); const { execSync } = require('child_process');
const D = __dirname;
(async () => {
  const ctx = await chromium.launchPersistentContext(`${D}/profile_t5`, { executablePath: BROWSERS.cft151, headless: true,
    args: [`--disable-extensions-except=${D}/ext`, `--load-extension=${D}/ext`, '--autoplay-policy=no-user-gesture-required'] });
  let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
  await ctx.route('http://localhost/**', r => r.fulfill({ contentType: 'text/html', body: `<!doctype html><script>${LIB}</script>` }));
  const page = await ctx.newPage(); await page.goto('http://localhost/call');
  const mute = (m) => sw.evaluate(async (m) => { const ts = await chrome.tabs.query({}); const t = ts.find(t => (t.url || '').startsWith('http://localhost')); await chrome.tabs.update(t.id, { muted: m }); const u = await chrome.tabs.get(t.id); return { muted: u.mutedInfo, audible: u.audible }; }, m);
  console.log('mute ->', JSON.stringify(await mute(true)));
  const res = await page.evaluate(`(async () => {
    const acS = new AudioContext(); const p = await lab.makePair([440], acS);
    // page-style playback: UNMUTED element (tab is muted, so nothing should be heard)
    const a = new Audio(); a.srcObject = new MediaStream([p.recvTracks[0]]); await a.play();
    const tap = await lab.measure(p.recvTracks[0], 2500);
    const ac = new AudioContext(); const d = ac.createMediaStreamDestination(); ac.createMediaStreamSource(new MediaStream([p.recvTracks[0]])).connect(d);
    window.__p = p;
    const rec = await lab.record(d.stream, 3000, { mimeType: 'audio/webm;codecs=opus' });
    return { tap, ctxTime: ac.currentTime.toFixed(2), recSize: rec.size, b64: rec.b64 };
  })()`);
  fs.writeFileSync(`${D}/t5_muted.webm`, Buffer.from(res.b64, 'base64'));
  const vd = execSync(`ffmpeg -hide_banner -nostats -i ${D}/t5_muted.webm -af volumedetect -f null - 2>&1`).toString().match(/mean_volume: [-\d.]+ dB/)[0];
  const dur = (execSync(`ffmpeg -hide_banner -nostats -i ${D}/t5_muted.webm -f null - 2>&1`).toString().match(/time=(\S+)/g) || []).pop();
  console.log('while tab muted: tap', JSON.stringify(res.tap), 'ctxTime', res.ctxTime, 'recSize', res.recSize, vd, dur);
  const st = await sw.evaluate(async () => { const ts = await chrome.tabs.query({}); const t = ts.find(t => (t.url || '').startsWith('http://localhost')); return { audible: t.audible, mutedInfo: t.mutedInfo }; });
  console.log('tab state while muted & element playing:', JSON.stringify(st));
  await ctx.close();
  fs.rmSync(`${D}/profile_t5`, { recursive: true, force: true });
})();
