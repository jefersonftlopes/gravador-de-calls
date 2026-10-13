// T6b: 45 s recording from a graph that never touches ac.destination (SilentSinkSuspender kicks in at 30 s) and from sinkId:{type:'none'}.
const { chromium } = require('playwright');
const { BROWSERS, LIB } = require('./common');
const fs = require('fs'); const { execSync } = require('child_process'); const D = __dirname;
const sh = (c) => { try { return execSync(c + ' 2>&1').toString(); } catch (e) { return String(e.stdout || e); } };
(async () => {
  const browser = await chromium.launch({ executablePath: BROWSERS[process.argv[2] || 'chrome154'], headless: true });
  const ctx = await browser.newContext();
  await ctx.route('http://localhost/**', r => r.fulfill({ contentType: 'text/html', body: `<!doctype html><button id=b>x</button><script>${LIB}
    window.noneState = (() => { try { const ac = new AudioContext({ sinkId: { type: 'none' } }); return new Promise(r => setTimeout(() => r(ac.state + ' sinkId=' + JSON.stringify(ac.sinkId)), 300)); } catch (e) { return 'throws ' + e.name; } })();
  </script>` }));
  const page = await ctx.newPage(); await page.goto('http://localhost/x');
  await page.waitForTimeout(600);
  // read without gesture-granting evaluate: use console
  page.on('console', m => m.text().startsWith('LAB') && console.log(m.text()));
  await page.addScriptTag({ content: `noneState.then(s => console.log('LAB sinkId none, no gesture ->', s))` });
  await page.waitForTimeout(500);
  await page.click('#b');
  for (const mode of ['default-no-destination', 'sinkId-none']) {
    const r = await page.evaluate(`(async () => { const ac = ${mode === 'sinkId-none' ? "new AudioContext({ sinkId: { type: 'none' } })" : 'new AudioContext()'};
      const o = ac.createOscillator(); o.frequency.value = 300; const d = new MediaStreamAudioDestinationNode(ac, { channelCount: 1, channelCountMode: 'explicit' }); o.connect(d); o.start();
      const t0 = performance.now(); const r = await lab.record(d.stream, 45000, { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 32000 }, 5000);
      r.wall = ((performance.now() - t0) / 1000).toFixed(2); r.ctxTime = ac.currentTime.toFixed(2); r.state = ac.state; delete r.chunkB64; return r; })()`);
    const f = `${D}/t6b_${mode}.webm`; fs.writeFileSync(f, Buffer.from(r.b64, 'base64'));
    const dec = (sh(`ffmpeg -hide_banner -nostats -i ${f} -f null -`).match(/time=(\S+)/g) || []).pop();
    const sil = (sh(`ffmpeg -hide_banner -nostats -i ${f} -af silencedetect=n=-50dB:d=0.2 -f null -`).match(/silence_(start|end): [\d.]+/g) || []).join(' ') || 'none';
    console.log(mode, 'state', r.state, 'wall', r.wall, 'ctxTime', r.ctxTime, 'decoded', dec, 'chunks', r.nChunks, 'silences', sil);
  }
  await browser.close();
})();
