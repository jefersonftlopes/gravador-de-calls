// T1b: can getStats() tell whether anything is pulling (playing out) a remote audio track?
const { launch, newLabPage } = require('./common');
(async () => {
  for (const withEl of [false, true]) {
    const b = await launch('chrome154', ['--autoplay-policy=no-user-gesture-required']); const { page } = await newLabPage(b);
    const r = await page.evaluate(`(async () => { const p = await lab.makePair([440]);
      if (${withEl}) { const a = new Audio(); a.muted = true; a.srcObject = new MediaStream([p.recvTracks[0]]); }
      const snap = async () => { const s = await p.pc2.getReceivers()[0].getStats(); let o; s.forEach(x => { if (x.type === 'inbound-rtp') o = { packetsReceived: x.packetsReceived, totalSamplesReceived: x.totalSamplesReceived, totalAudioEnergy: +(x.totalAudioEnergy||0).toFixed(3), concealedSamples: x.concealedSamples }; }); return o; };
      const a = await snap(); await lab.sleep(2000); const b = await snap(); return { t0: a, t2s: b }; })()`);
    console.log('primingElement=' + withEl, JSON.stringify(r));
    await b.close();
  }
})();
