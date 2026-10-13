// T2b: autoplay without Playwright evaluate() (evaluate injects userGesture:true). All logic runs in page scripts; results via console.
const { chromium } = require('playwright');
const { BROWSERS } = require('./common');
const which = process.argv[2] || 'chrome154';
const PAGE = `<!doctype html><html><body><button id="b">join</button><script>
const tag = location.search || '?first';
const log = (...a) => console.log('LAB', tag, ...a);
const ac0 = new AudioContext();
setTimeout(() => log('onload', 'state=' + ac0.state, 'sticky=' + navigator.userActivation.hasBeenActive, 'vis=' + document.visibilityState), 300);
ac0.onstatechange = () => log('ac0 statechange ->', ac0.state, 'sticky=' + navigator.userActivation.hasBeenActive);
document.getElementById('b').onclick = () => {
  log('clicked', 'ac0(no resume)=' + ac0.state);
  setTimeout(() => ac0.resume().then(() => log('ac0 resume() from timer 1s after click ->', ac0.state)), 1000);
  setTimeout(() => { const ac1 = new AudioContext(); setTimeout(() => log('new ctx from timer 3s after click ->', ac1.state), 300); }, 3000);
  if (tag === '?first') setTimeout(() => location.reload(), 9000); // renderer-initiated reload, no transient activation
  if (tag === '?first') setTimeout(() => {}, 0);
};
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') setTimeout(() => { const ac = new AudioContext(); setTimeout(() => log('new ctx while hidden ->', ac.state, 'vis=' + document.visibilityState), 300); }, 1000);
});
// Unmuted element play() without gesture (fresh doc).
setTimeout(() => { const a = new Audio(); a.srcObject = new AudioContext().createMediaStreamDestination().stream; a.play().then(() => log('unmuted element play() -> resolved'), e => log('unmuted element play() -> rejected', e.name)); }, 500);
</script></body></html>`;

(async () => {
  const flags = (process.env.FLAGS || '').split(' ').filter(Boolean);
  const browser = await chromium.launch({ executablePath: BROWSERS[which], headless: !process.env.HEADED, args: flags });
  const ctx = await browser.newContext();
  await ctx.route('http://localhost/**', r => r.fulfill({ contentType: 'text/html', body: PAGE }));
  const page = await ctx.newPage();
  page.on('console', m => { if (m.text().startsWith('LAB')) console.log(m.text()); });
  await page.goto('http://localhost/x?first');
  await page.waitForTimeout(1500);
  await page.click('#b');
  await page.waitForTimeout(5000);
  const other = await ctx.newPage(); await other.goto('about:blank'); await other.bringToFront();
  await page.waitForTimeout(2500);
  await page.bringToFront();
  await page.waitForTimeout(4000); // renderer-initiated reload happens ~9s after click
  console.log('--- now browser-initiated navigation to ?third (like a reload from the omnibox/restore)');
  await page.goto('http://localhost/x?third');
  await page.waitForTimeout(1500);
  await browser.close();
})();
