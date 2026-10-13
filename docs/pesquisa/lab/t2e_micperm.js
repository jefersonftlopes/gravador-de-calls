// T2e: site has persisted mic permission (content setting ALLOW) -> AudioContext allowed without any gesture? (kAutoplayBypassForMicCamera, M148+)
const { chromium } = require('playwright');
const { BROWSERS } = require('./common'); const fs = require('fs'); const D = __dirname;
const PAGE = `<!doctype html><script>const ac = new AudioContext(); setTimeout(() => console.log('LAB', 'immediate ctx state=' + ac.state), 400); setTimeout(() => { const a2 = new AudioContext(); setTimeout(() => console.log('LAB', 'ctx created 1.5s later state=' + a2.state, 'sticky=' + navigator.userActivation.hasBeenActive), 300); }, 1500);</script>`;
(async () => {
  for (const withPerm of [false, true]) {
    const dir = `${D}/profile_t2e_${withPerm}`; fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(`${dir}/Default`, { recursive: true });
    if (withPerm) fs.writeFileSync(`${dir}/Default/Preferences`, JSON.stringify({ profile: { content_settings: { exceptions: { media_stream_mic: { 'http://localhost:8765,*': { setting: 1 } } } } } }));
    const ctx = await chromium.launchPersistentContext(dir, { executablePath: BROWSERS[process.argv[2] || 'chrome154'], headless: true });
    const page = ctx.pages()[0] || await ctx.newPage();
    page.on('console', m => m.text().startsWith('LAB') && console.log('micPermission=' + withPerm, m.text()));
    const http = require('http'); const srv = http.createServer((q, s) => { s.setHeader('content-type', 'text/html'); s.end(PAGE); }).listen(8765);
    await page.goto('http://localhost:8765/'); await page.waitForTimeout(2200); await page.goto('http://localhost:8765/again'); await page.waitForTimeout(2200);
    srv.close(); await ctx.close();
  }
})();
