// T2: AudioContext autoplay state vs. user activation, timers, reload, background.
const { launch, newLabPage } = require('./common');
const which = process.argv[2] || 'chrome154';
const st = (page, extra = '') => page.evaluate(`(async () => { const ac = new AudioContext(); await new Promise(r => setTimeout(r, 300)); ${extra}; return { state: ac.state, sticky: navigator.userActivation.hasBeenActive, vis: document.visibilityState }; })()`);

(async () => {
  const browser = await launch(which, (process.env.FLAGS||'').split(' ').filter(Boolean), process.env.HEADED ? false : true);
  const { ctx, page } = await newLabPage(browser);
  const out = {};
  out.a_onLoadNoGesture = await st(page);
  // Context created before gesture, then gesture, then check without/with resume from a timer.
  await page.evaluate(`window.early = new AudioContext()`);
  await page.click('#b');
  out.c_earlyCtxAfterClick_noResume = await page.evaluate(`new Promise(r => setTimeout(() => r(early.state), 500))`);
  out.c_earlyCtxResumeFromTimer = await page.evaluate(`new Promise(r => setTimeout(async () => { await early.resume(); r(early.state); }, 1000))`);
  out.b_newCtxFromTimer3sAfterClick = await page.evaluate(`new Promise(r => setTimeout(() => { const ac = new AudioContext(); setTimeout(() => r(ac.state), 300); }, 3000))`);
  // Background: open another tab in front.
  const other = await ctx.newPage(); await other.goto('about:blank'); await other.bringToFront();
  await page.waitForTimeout(1500);
  out.f_backgroundNewCtx = await st(page);
  await page.bringToFront();
  // Reload same URL (new document, no gesture in it).
  await page.reload();
  out.d_afterReload = await st(page);
  // Same-origin navigation to another path.
  await page.goto('http://localhost/other');
  out.e_afterSameOriginNav = await st(page);
  // Recorder fed by suspended context: what comes out?
  const page2 = (await newLabPage(browser)).page;
  out.g_recorderFromSuspendedCtx = await page2.evaluate(`(async () => { const ac = new AudioContext(); const o = ac.createOscillator(); const d = ac.createMediaStreamDestination(); o.connect(d); o.start(); const r = await lab.record(d.stream, 2000, {mimeType:'audio/webm;codecs=opus'}, 500); delete r.b64; delete r.chunkB64; return { acState: ac.state, ...r }; })()`);
  // Muted media element play() without gesture.
  out.h_mutedElementPlayNoGesture = await page2.evaluate(`(async () => { const a = new Audio(); a.muted = true; const ac = new AudioContext(); const d = ac.createMediaStreamDestination(); a.srcObject = d.stream; try { await a.play(); return 'played'; } catch (e) { return 'rejected: ' + e.name; } })()`);
  out.i_unmutedElementPlayNoGesture = await page2.evaluate(`(async () => { const a = new Audio(); const ac = new AudioContext(); const d = ac.createMediaStreamDestination(); a.srcObject = d.stream; try { await a.play(); return 'played'; } catch (e) { return 'rejected: ' + e.name; } })()`);
  console.log(which, JSON.stringify(out, null, 1));
  await browser.close();
})();
