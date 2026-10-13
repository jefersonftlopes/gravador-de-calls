// T2c: does a browser-initiated reload (Cmd+R / page.reload) keep autoplay allowance after a click?
const { chromium } = require('playwright');
const { BROWSERS } = require('./common');
const PAGE = `<!doctype html><button id="b">join</button><script>
const ac = new AudioContext(); setTimeout(() => console.log('LAB', location.search, 'state=' + ac.state, 'sticky=' + navigator.userActivation.hasBeenActive), 300);
</script>`;
(async () => {
  const browser = await chromium.launch({ executablePath: BROWSERS[process.argv[2] || 'chrome154'], headless: true });
  const ctx = await browser.newContext();
  await ctx.route('http://localhost/**', r => r.fulfill({ contentType: 'text/html', body: PAGE }));
  const page = await ctx.newPage();
  page.on('console', m => m.text().startsWith('LAB') && console.log(m.text()));
  await page.goto('http://localhost/x?a'); await page.waitForTimeout(800);
  await page.click('#b'); await page.waitForTimeout(500);
  console.log('-- page.reload() (browser-initiated reload)'); await page.reload(); await page.waitForTimeout(800);
  console.log('-- page.reload() again without new click'); await page.reload(); await page.waitForTimeout(800);
  console.log('-- keyboard Meta+R'); await page.click('#b'); await page.keyboard.press('Meta+R').catch(()=>{}); await page.waitForTimeout(1200);
  await browser.close();
})();
