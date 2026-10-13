const { chromium } = require('playwright');
const { BROWSERS, LIB } = require('./common'); const fs = require('fs'); const D = __dirname;
(async () => {
  const browser = await chromium.launch({ executablePath: BROWSERS.chrome154, headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  const ctx = await browser.newContext();
  const wav = fs.readFileSync(`${D}/speech32.webm`).toString('base64');
  await ctx.route('http://localhost/**', r => r.fulfill({ contentType: 'text/html', body: `<!doctype html><script>${LIB}</script>` }));
  const page = await ctx.newPage(); await page.goto('http://localhost/x');
  for (const br of [16000, 32000, 64000]) {
    const r = await page.evaluate(`(async () => { const ac = new AudioContext(); const bytes = Uint8Array.from(atob('${wav}'), c => c.charCodeAt(0));
      const buf = await ac.decodeAudioData(bytes.buffer); const s = ac.createBufferSource(); s.buffer = buf;
      const d = new MediaStreamAudioDestinationNode(ac, { channelCount: 1, channelCountMode: 'explicit' }); s.connect(d); s.start();
      const r = await lab.record(d.stream, Math.ceil(buf.duration * 1000) + 500, { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: ${br} }, 5000); delete r.chunkB64; return r; })()`);
    fs.writeFileSync(`${D}/chrome_speech_${br / 1000}k.webm`, Buffer.from(r.b64, 'base64')); console.log(br, r.size, r.nChunks);
  }
  await browser.close();
})();
