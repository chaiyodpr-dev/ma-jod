#!/usr/bin/env node
// Usage: node src/bot.js <teams-meeting-link> [options]
//
// Joins the meeting as a guest, records everything the meeting plays into
// recordings/<timestamp>/audio.webm, and leaves when the meeting ends.
// Progress is printed as JSON lines and also written to events.jsonl.

import { appendFileSync, mkdirSync, createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
import { captureInit } from './capture.js';
import { joinMeeting, waitForEnd, leaveMeeting } from './teams.js';

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    name: { type: 'string', default: 'Ma-Jod AI (บันทึกประชุม)' },
    out: { type: 'string', default: 'recordings' },
    'lobby-minutes': { type: 'string', default: '10' },
    'alone-minutes': { type: 'string', default: '3' },
    'max-minutes': { type: 'string', default: '180' },
    headful: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

const url = positionals[0];
if (opts.help || !url) {
  console.log(`Usage: node src/bot.js <teams-meeting-link> [options]

  --name <text>          Name shown in the meeting (default: "${opts.name}")
  --out <dir>            Where recordings go (default: recordings)
  --lobby-minutes <n>    Give up if not admitted within n minutes (default: 10)
  --alone-minutes <n>    Leave after being alone for n minutes (default: 3)
  --max-minutes <n>      Hard stop after n minutes (default: 180)
  --headful              Show the browser window (for debugging)`);
  process.exit(url ? 0 : 1);
}

const minutes = (key) => Number(opts[key]) * 60_000;
const runDir = join(opts.out, new Date().toISOString().replace(/[:.]/g, '-'));
mkdirSync(runDir, { recursive: true });

const log = (event) => {
  const line = JSON.stringify({ at: new Date().toISOString(), ...event });
  console.log(line);
  appendFileSync(join(runDir, 'events.jsonl'), line + '\n');
};

let stopRequested = false;
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    if (stopRequested) process.exit(130);
    stopRequested = true;
    log({ type: 'stop-requested', signal: sig });
  });
}

const browser = await chromium.launch({
  headless: !opts.headful,
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    '--disable-blink-features=AutomationControlled',
  ],
});
// Headless Chromium announces itself as "HeadlessChrome"; Teams may refuse it.
const userAgent = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${browser.version()} Safari/537.36`;
const context = await browser.newContext({
  userAgent,
  locale: 'en-US',
  viewport: { width: 1280, height: 800 },
  permissions: ['microphone', 'camera'],
});
const page = await context.newPage();

const audioPath = join(runDir, 'audio.webm');
const audio = createWriteStream(audioPath);
let audioBytes = 0;
await page.exposeFunction('__majodChunk', (b64) => {
  const buf = Buffer.from(b64, 'base64');
  audioBytes += buf.length;
  audio.write(buf);
});
await page.exposeFunction('__majodEvent', (e) => log(e));
await page.addInitScript(captureInit, { timesliceMs: 10_000 });

let exitCode = 0;
try {
  await joinMeeting(page, { url, botName: opts.name, lobbyTimeoutMs: minutes('lobby-minutes'), log });
  const reason = await waitForEnd(page, {
    aloneTimeoutMs: minutes('alone-minutes'),
    maxDurationMs: minutes('max-minutes'),
    shouldStop: () => stopRequested,
    log,
  });
  log({ type: 'meeting-over', reason });
} catch (err) {
  exitCode = 1;
  log({ type: 'error', message: err.message });
  await page.screenshot({ path: join(runDir, 'error.png'), fullPage: true }).catch(() => {});
} finally {
  await page.evaluate(() => window.__majod?.stop()).catch(() => {});
  await leaveMeeting(page);
  await browser.close();
  await new Promise((r) => audio.end(r));
  log({ type: 'done', audio: audioBytes > 0 ? audioPath : null, bytes: audioBytes });
}
process.exit(exitCode);
