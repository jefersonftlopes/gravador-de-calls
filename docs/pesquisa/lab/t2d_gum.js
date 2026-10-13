// T2d: no gesture, but document is capturing mic (getUserMedia live) -> AudioContext state?
const { chromium } = require('playwright');
const { BROWSERS } = require('./common');
const PAGE = `<!doctype html><script>
const a0 = new AudioContext();
setTimeout(() => console.log('LAB before gUM: state=' + a0.state + ' sticky=' + navigator.userActivation.hasBeenActive), 200);
setTimeout(async () => {
  const s = await navigator.mediaDevices.getUserMedia({ audio: true });
  setTimeout(() => { const a1 = new AudioContext(); setTimeout(async () => {
    console.log('LAB mic live, new ctx: state=' + a1.state + ' | old ctx: ' + a0.state);
    await a0.resume(); console.log('LAB old ctx after resume() w/o gesture: ' + a0.state);
    s.getTracks().forEach(t => t.stop());
    setTimeout(() => { const a2 = new AudioContext(); setTimeout(() => console.log('LAB mic stopped, new ctx: ' + a2.state), 300); }, 500);
  }, 300); }, 300);
}, 600);
</script>`;
(async () => {
  const browser = await chromium.launch({ executablePath: BROWSERS[process.argv[2] || 'chrome154'], headless: true, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  const ctx = await browser.newContext();
  await ctx.route('http://localhost/**', r => r.fulfill({ contentType: 'text/html', body: PAGE }));
  const page = await ctx.newPage();
  page.on('console', m => m.text().startsWith('LAB') && console.log(m.text()));
  await page.goto('http://localhost/x'); await page.waitForTimeout(3500);
  await browser.close();
})();
