// Checks the recording pipeline without Teams: two RTCPeerConnections inside
// one page loop an oscillator tone to each other (or the page plays a tone
// through Web Audio), and captureInit must record it into a playable WebM file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { captureInit } from '../src/capture.js';

const LOOPBACK_PAGE = `<!doctype html><audio id="out" autoplay></audio><script>
  window.startCall = async () => {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const dest = ctx.createMediaStreamDestination();
    osc.connect(dest); osc.start();
    const a = new RTCPeerConnection(), b = new RTCPeerConnection();
    a.onicecandidate = (e) => e.candidate && b.addIceCandidate(e.candidate);
    b.onicecandidate = (e) => e.candidate && a.addIceCandidate(e.candidate);
    b.ontrack = (e) => { document.getElementById('out').srcObject = e.streams[0]; };
    dest.stream.getTracks().forEach((t) => a.addTrack(t, dest.stream));
    await a.setLocalDescription(await a.createOffer());
    await b.setRemoteDescription(a.localDescription);
    await b.setLocalDescription(await b.createAnswer());
    await a.setRemoteDescription(b.localDescription);
  };
  // Plays a tone straight to the speakers, the way a client that decodes
  // audio itself would, with no WebRTC track or media element involved.
  window.playWebAudio = () => {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    osc.connect(ctx.destination); osc.start();
  };
</script>`;

async function record(startFn) {
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  try {
    const page = await browser.newPage();
    const chunks = [];
    const events = [];
    await page.exposeFunction('__majodChunk', (b64) => chunks.push(Buffer.from(b64, 'base64')));
    await page.exposeFunction('__majodEvent', (e) => events.push(e));
    await page.addInitScript(captureInit, { timesliceMs: 1000 });
    await page.route('http://majod.test/', (r) => r.fulfill({ contentType: 'text/html', body: LOOPBACK_PAGE }));
    await page.goto('http://majod.test/');

    await page.evaluate(startFn);
    await page.waitForTimeout(4000);
    await page.evaluate(() => window.__majod.stop());

    assert.ok(events.some((e) => e.type === 'recording-started'), 'recording should start');
    return { chunks, events };
  } finally {
    await browser.close();
  }
}

function assertAudible(chunks) {
  assert.ok(chunks.length >= 2, `expected several chunks, got ${chunks.length}`);

  const file = join(mkdtempSync(join(tmpdir(), 'majod-')), 'audio.webm');
  writeFileSync(file, Buffer.concat(chunks));
  const probe = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', file])
    .toString()
    .trim();
  assert.equal(probe, 'opus');

  // The tone must actually be in the file, not silence.
  const stats = spawnSync('ffmpeg', ['-hide_banner', '-i', file, '-af', 'volumedetect', '-f', 'null', '-']).stderr.toString();
  const meanDb = Number(/mean_volume: (-?[\d.]+) dB/.exec(stats)?.[1]);
  assert.ok(meanDb > -40, `audio looks silent (mean ${meanDb} dB)`);
}

test('records remote WebRTC audio to a playable webm', { timeout: 60_000 }, async () => {
  const { chunks } = await record(() => window.startCall());
  assertAudible(chunks);
});

test('records audio the page plays through Web Audio', { timeout: 60_000 }, async () => {
  const { chunks, events } = await record(() => window.playWebAudio());
  assert.ok(events.some((e) => e.type === 'audio-track' && e.kind === 'webaudio'), 'web audio tap should attach');
  assertAudible(chunks);
});
