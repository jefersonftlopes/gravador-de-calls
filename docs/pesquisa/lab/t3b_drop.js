// T3b: what if one middle chunk is lost in transit? And 2 recorders' first chunks: header size.
const { launch, newLabPage } = require('./common'); const fs = require('fs'); const { execSync } = require('child_process'); const D = __dirname;
const sh = (c) => { try { return execSync(c + ' 2>&1').toString(); } catch (e) { return String(e.stdout || e); } };
(async () => {
  const b = await launch('chrome154', ['--autoplay-policy=no-user-gesture-required']); const { page } = await newLabPage(b);
  const r = await page.evaluate(`(async () => { const ac = new AudioContext(); const o = ac.createOscillator(); o.frequency.value = 300;
    const d = new MediaStreamAudioDestinationNode(ac, { channelCount: 1, channelCountMode: 'explicit' }); o.connect(d); o.start();
    return await lab.record(d.stream, 10000, { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 32000 }, 1000); })()`);
  const parts = r.chunkB64.map(x => Buffer.from(x, 'base64'));
  console.log('nChunks', parts.length, 'sizes', parts.map(p => p.length).join(','));
  fs.writeFileSync(`${D}/t3b_drop5.webm`, Buffer.concat(parts.filter((_, i) => i !== 5)));
  const out = sh(`ffmpeg -hide_banner -nostats -i ${D}/t3b_drop5.webm -f null -`);
  console.log('drop chunk 5 -> decoded', (out.match(/time=(\S+)/g) || []).pop(), '| errors:', (out.match(/\[.*?(error|invalid|Invalid|corrupt).*$/gim) || []).slice(0, 3).join(' || ') || 'none');
  await b.close();
})();
