// T3: MediaRecorder behaviour: mime support, multiple audio tracks, timeslice chunk concatenation, duration, mono/bitrate.
// T6: mixing graph timeline when remote source goes silent/muted/ended, dynamic add/remove of sources.
const { launch, newLabPage } = require('./common');
const fs = require('fs'); const { execSync } = require('child_process');
const which = process.argv[2] || 'chrome154';
const D = __dirname;
const sh = (c) => { try { return execSync(c + ' 2>&1').toString(); } catch (e) { return String(e.stdout || e); } };
const save = (name, b64) => { const f = `${D}/${name}`; fs.writeFileSync(f, Buffer.from(b64, 'base64')); return f; };
const probe = (f) => sh(`ffprobe -hide_banner -v error -show_entries format=duration,bit_rate:stream=codec_name,channels,sample_rate,duration -of compact ${f}`).trim();
const decodedDur = (f) => (sh(`ffmpeg -hide_banner -nostats -i ${f} -f null - `).match(/time=(\S+)/g) || []).pop();
// Energy at a given frequency via ffmpeg bandpass + volumedetect.
const bandDb = (f, hz) => +(sh(`ffmpeg -hide_banner -nostats -i ${f} -af "bandpass=f=${hz}:width_type=q:w=20,volumedetect" -f null -`).match(/mean_volume: ([-\d.]+)/) || [])[1];
// Silence map.
const silences = (f) => (sh(`ffmpeg -hide_banner -nostats -i ${f} -af silencedetect=n=-50dB:d=0.5 -f null -`).match(/silence_(start|end): [\d.]+/g) || []).join(' ');

(async () => {
  const browser = await launch(which, ['--autoplay-policy=no-user-gesture-required']);
  const { page } = await newLabPage(browser);

  // 3a: isTypeSupported matrix.
  const types = ['audio/webm', 'audio/webm;codecs=opus', 'audio/webm;codecs=pcm', 'audio/mp4', 'audio/mp4;codecs=opus', 'audio/mp4;codecs=mp4a.40.2', 'audio/ogg', 'audio/ogg;codecs=opus', 'audio/wav', 'audio/x-matroska;codecs=opus', 'audio/mpeg', 'audio/aac', 'audio/flac'];
  const sup = await page.evaluate(`(${JSON.stringify(types)}).map(t => [t, MediaRecorder.isTypeSupported(t)])`);
  console.log('isTypeSupported', JSON.stringify(Object.fromEntries(sup)));
  const ua = await page.evaluate('navigator.userAgent'); console.log('UA', ua);

  // 3b: stream with TWO audio tracks (440 Hz and 880 Hz): which one is recorded?
  let r = await page.evaluate(`(async () => { const ac = new AudioContext(); const mk = f => { const o = ac.createOscillator(); o.frequency.value = f; const d = ac.createMediaStreamDestination(); o.connect(d); o.start(); return d.stream.getAudioTracks()[0]; };
    const s = new MediaStream([mk(440), mk(880)]); return await lab.record(s, 2500, {mimeType:'audio/webm;codecs=opus'}); })()`);
  let f = save('t3_twotracks.webm', r.b64);
  console.log('twoTracks', 'band440=', bandDb(f, 440), 'band880=', bandDb(f, 880), '|', probe(f));

  // 3c: timeslice chunks + duration metadata + mono + bitrate.
  r = await page.evaluate(`(async () => { const ac = new AudioContext(); const o = ac.createOscillator(); o.frequency.value = 300;
    const d = new MediaStreamAudioDestinationNode(ac, { channelCount: 1, channelCountMode: 'explicit' }); o.connect(d); o.start();
    return await lab.record(d.stream, 12000, {mimeType:'audio/webm;codecs=opus', audioBitsPerSecond: 32000}, 5000); })()`);
  f = save('t3_sliced.webm', r.b64);
  console.log('sliced', 'nChunks=', r.nChunks, 'sizes=', JSON.stringify(r.times.map(t => t[1])), '|', probe(f), '| decoded', decodedDur(f));
  // Chunk 2 alone (no header) and chunks 0+1 only (truncated file e.g. crash mid-call).
  const parts = r.chunkB64.map(b => Buffer.from(b, 'base64'));
  fs.writeFileSync(`${D}/t3_chunk1_alone.webm`, parts[1]);
  fs.writeFileSync(`${D}/t3_first2.webm`, Buffer.concat(parts.slice(0, 2)));
  console.log('chunk1 alone:', probe(`${D}/t3_chunk1_alone.webm`).slice(0, 160));
  console.log('first2 (truncated):', probe(`${D}/t3_first2.webm`), '| decoded', decodedDur(`${D}/t3_first2.webm`));
  // Remux fix.
  sh(`ffmpeg -y -hide_banner -v error -i ${f} -c copy ${D}/t3_sliced_remux.webm`);
  console.log('remux -c copy:', probe(`${D}/t3_sliced_remux.webm`));
  console.log('ebml header first chunk hex:', parts[0].slice(0, 4).toString('hex'), ' chunk1 first bytes:', parts[1].slice(0, 4).toString('hex'));

  // 3d: adding a track to the recorded MediaStream during recording.
  r = await page.evaluate(`(async () => { const ac = new AudioContext(); const mk = f => { const o = ac.createOscillator(); o.frequency.value = f; const d = ac.createMediaStreamDestination(); o.connect(d); o.start(); return d.stream.getAudioTracks()[0]; };
    const s = new MediaStream([mk(440)]); const mr = new MediaRecorder(s); let err = null, state = []; mr.onerror = e => err = (e.error && e.error.name) || 'error'; mr.start(500);
    await lab.sleep(800); s.addTrack(mk(880)); await lab.sleep(1200); state.push(mr.state); try { mr.stop(); } catch (e) { state.push('stopThrew ' + e.name); } await lab.sleep(300); return { err, state }; })()`);
  console.log('addTrackDuringRecording', JSON.stringify(r));

  // 6a: remote source: sender stops sending (replaceTrack(null)) for 3s mid-recording, plus dynamic add/remove of sources in mixer.
  r = await page.evaluate(`(async () => {
    const p = await lab.makePair([440, 880]);
    const keep = p.recvTracks.map(t => { const a = new Audio(); a.muted = true; a.srcObject = new MediaStream([t]); a.play(); return a; });
    const ac = new AudioContext(); const dest = new MediaStreamAudioDestinationNode(ac, { channelCount: 1, channelCountMode: 'explicit' });
    const ev = []; const t0 = performance.now(); const T = () => ((performance.now() - t0) / 1000).toFixed(2);
    p.recvTracks.forEach((t, i) => { t.onmute = () => ev.push(T() + ' track' + i + ' mute'); t.onunmute = () => ev.push(T() + ' track' + i + ' unmute'); t.onended = () => ev.push(T() + ' track' + i + ' ended'); });
    const src0 = ac.createMediaStreamSource(new MediaStream([p.recvTracks[0]])); src0.connect(dest);
    const recP = lab.record(dest.stream, 14000, { mimeType: 'audio/webm;codecs=opus' }, 1000);
    await lab.sleep(2000); const sender0 = p.pc1.getSenders()[0]; await sender0.replaceTrack(null); ev.push(T() + ' sender0 replaceTrack(null)');
    await lab.sleep(3000); await sender0.replaceTrack(p.sendTracks[0]); ev.push(T() + ' sender0 restored');
    await lab.sleep(1000); const src1 = ac.createMediaStreamSource(new MediaStream([p.recvTracks[1]])); src1.connect(dest); ev.push(T() + ' added src1 (880)');
    await lab.sleep(2000); src0.disconnect(); ev.push(T() + ' removed src0 (440)');
    await lab.sleep(2000); p.pc2.getTransceivers()[1].stop(); ev.push(T() + ' transceiver1 stopped (track1 ends)');
    const r = await recP; r.ev = ev; r.ctxRate = ac.sampleRate; return r; })()`);
  f = save('t6_timeline.webm', r.b64);
  console.log('timeline events', JSON.stringify(r.ev));
  console.log('timeline file', probe(f), '| decoded', decodedDur(f));
  console.log('timeline silences(-50dB,>0.5s):', silences(f));
  // Per-window band energy (440 vs 880), 1s windows.
  const win = [];
  for (let s = 0; s < 14; s += 1) { sh(`ffmpeg -y -hide_banner -v error -ss ${s} -t 1 -i ${f} ${D}/w.wav`); win.push(`${s}s:440=${bandDb(`${D}/w.wav`, 440)}/880=${bandDb(`${D}/w.wav`, 880)}`); }
  console.log('windows', win.join(' '));
  await browser.close();
})();
