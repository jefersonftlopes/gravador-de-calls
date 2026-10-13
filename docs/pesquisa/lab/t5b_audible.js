const { chromium } = require('playwright');
const { BROWSERS, LIB } = require('./common');
const fs = require('fs'); const D = __dirname;
(async () => {
  const ctx = await chromium.launchPersistentContext(`${D}/profile_t5b`, { executablePath: BROWSERS.cft151, headless: true,
    args: [`--disable-extensions-except=${D}/ext`, `--load-extension=${D}/ext`, '--autoplay-policy=no-user-gesture-required'] });
  let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
  await ctx.route('http://localhost/**', r => r.fulfill({ contentType: 'text/html', body: `<!doctype html><script>${LIB}</script>` }));
  const page = await ctx.newPage(); await page.goto('http://localhost/call');
  const st = () => sw.evaluate(async () => { const ts = await chrome.tabs.query({}); const t = ts.find(t => (t.url || '').startsWith('http://localhost')); return { audible: t.audible, muted: t.mutedInfo.muted }; });
  const mute = (m) => sw.evaluate(async (m) => { const ts = await chrome.tabs.query({}); const t = ts.find(t => (t.url || '').startsWith('http://localhost')); await chrome.tabs.update(t.id, { muted: m }); }, m);
  await page.evaluate(`(async () => { const p = await lab.makePair([440]); const a = new Audio(); a.volume = 0.003; a.srcObject = new MediaStream([p.recvTracks[0]]); await a.play(); })()`);
  await page.waitForTimeout(1500); console.log('unmuted, quiet playback:', JSON.stringify(await st()));
  await mute(true); await page.waitForTimeout(1500); console.log('after tab mute:', JSON.stringify(await st()));
  await mute(false); await page.waitForTimeout(1500); console.log('after unmute:', JSON.stringify(await st()));
  await ctx.close(); fs.rmSync(`${D}/profile_t5b`, { recursive: true, force: true });
})();
