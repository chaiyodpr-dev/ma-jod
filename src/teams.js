// Drives the Microsoft Teams web client as an anonymous guest.
//
// Teams changes its markup often, so every step tries a few selectors
// (data-tid attributes first, then accessible names in English). The browser
// is forced to en-US so the text-based fallbacks match. When a step breaks,
// the bot saves a screenshot next to the recording; start debugging there.

const SEL = {
  continueInBrowser: [
    'button[data-tid="joinOnWeb"]',
    'role=button[name=/continue on this browser|join on the web instead|use the web app instead/i]',
  ],
  nameInput: [
    'input[data-tid="prejoin-display-name-input"]',
    'input[placeholder*="name" i]',
  ],
  // The toggles are <input type=checkbox role=switch>; :checked reads the live property.
  micOn: [
    'input[data-tid="toggle-mute"]:checked',
    '[data-tid="toggle-mute"][aria-checked="true"]',
    'role=switch[name=/mute mic|microphone/i][checked=true]',
  ],
  cameraOn: [
    'input[data-tid="toggle-video"]:checked',
    '[data-tid="toggle-video"][aria-checked="true"]',
    'role=switch[name=/camera|video/i][checked=true]',
  ],
  joinNow: [
    'button[data-tid="prejoin-join-button"]',
    'role=button[name=/^join now$/i]',
  ],
  inMeeting: [
    '#hangup-button',
    '[data-tid="hangup-main-btn"]',
    'role=button[name=/^leave/i]',
  ],
};

const LOBBY_TEXT = /someone (in the meeting )?(should|will) let you in (soon|shortly)|waiting for (the organizer|someone) to let you in/i;
const CONNECT_FAILED_TEXT = /sorry, we couldn't connect you|we couldn't connect you/i;
const DENIED_TEXT = /you've been denied|sorry, but you were denied access|no one responded to your request/i;
const ENDED_TEXT = /the meeting has ended|meeting ended|you've been removed|you were removed|you left the meeting|thanks for joining/i;
const ALONE_TEXT = /you're the only one here|waiting for others to join/i;

// Selectors mix CSS and Playwright's role engine, so they are combined with
// locator.or() rather than a CSS comma list.
const anyOf = (page, selectors) => selectors.map((s) => page.locator(s)).reduce((a, b) => a.or(b)).first();

/** First locator among `selectors` that becomes visible within `timeout` ms, or null. */
async function firstVisible(page, selectors, timeout) {
  const any = anyOf(page, selectors);
  try {
    await any.waitFor({ state: 'visible', timeout });
    return any;
  } catch {
    return null;
  }
}

async function isVisible(page, selectors) {
  return anyOf(page, selectors).isVisible().catch(() => false);
}

async function bodyText(page) {
  return page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
}

/**
 * Teams only accepts letters, numbers, spaces and - ' . _ @ in a guest name
 * and keeps "Join now" disabled otherwise, so drop anything else.
 */
export function sanitizeName(name) {
  return name.replace(/[^\p{L}\p{M}\p{N} \-'._@]/gu, ' ').replace(/\s+/g, ' ').trim();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Opens the meeting link, fills the guest name, turns mic and camera off and
 * asks to join. Resolves once the bot is inside the meeting.
 * Throws if the lobby wait times out or the organizer denies entry.
 */
export async function joinMeeting(page, { url, botName, lobbyTimeoutMs, log }) {
  log({ type: 'opening', url });
  await page.goto(url, { waitUntil: 'domcontentloaded' });

  // The launcher page offers the desktop app first; pick the browser.
  const cont = await firstVisible(page, SEL.continueInBrowser, 30_000);
  if (cont) {
    await cont.click();
    log({ type: 'continue-in-browser' });
  }

  const name = await firstVisible(page, SEL.nameInput, 60_000);
  if (!name) throw new Error('pre-join screen did not appear (name box not found)');
  const guestName = sanitizeName(botName);
  if (guestName !== botName) log({ type: 'name-sanitized', from: botName, to: guestName });
  await name.fill(guestName);

  for (const toggle of [SEL.micOn, SEL.cameraOn]) {
    const on = await firstVisible(page, toggle, 2000);
    // The switch input sits under its styled track, so a plain click is intercepted.
    if (on) await on.click({ force: true }).catch(() => {});
  }

  const join = await firstVisible(page, SEL.joinNow, 10_000);
  if (!join) throw new Error('"Join now" button not found');
  if (!(await join.isEnabled({ timeout: 5000 }).catch(() => false))) {
    throw new Error('"Join now" is disabled (Teams rejected the guest name?)');
  }
  await join.click();
  log({ type: 'join-clicked' });

  const deadline = Date.now() + lobbyTimeoutMs;
  let announcedLobby = false;
  while (Date.now() < deadline) {
    if (await isVisible(page, SEL.inMeeting)) {
      log({ type: 'in-meeting' });
      return;
    }
    const text = await bodyText(page);
    if (DENIED_TEXT.test(text)) throw new Error('organizer denied entry');
    if (CONNECT_FAILED_TEXT.test(text)) throw new Error("Teams could not connect the call (\"Sorry, we couldn't connect you\")");
    if (!announcedLobby && LOBBY_TEXT.test(text)) {
      announcedLobby = true;
      log({ type: 'in-lobby' });
    }
    await sleep(2000);
  }
  throw new Error(`not admitted within ${Math.round(lobbyTimeoutMs / 60000)} min`);
}

/**
 * Polls until the meeting is over: Teams says it ended or removed us, the
 * call controls disappear, or the bot has been alone for `aloneTimeoutMs`.
 * Returns the reason.
 */
export async function waitForEnd(page, { aloneTimeoutMs, maxDurationMs, shouldStop, log }) {
  const started = Date.now();
  let aloneSince = null;
  let missingControls = 0;
  while (true) {
    if (shouldStop()) return 'stopped';
    if (Date.now() - started > maxDurationMs) return 'max-duration';

    const text = await bodyText(page);
    if (ENDED_TEXT.test(text)) return 'meeting-ended';

    // Controls can blink out during re-renders; require a few misses in a row.
    missingControls = (await isVisible(page, SEL.inMeeting)) ? 0 : missingControls + 1;
    if (missingControls >= 3) return 'left-meeting';

    if (ALONE_TEXT.test(text)) {
      aloneSince ??= Date.now();
      if (Date.now() - aloneSince > aloneTimeoutMs) return 'alone';
    } else if (aloneSince) {
      aloneSince = null;
      log({ type: 'others-present' });
    }
    await sleep(5000);
  }
}

export async function leaveMeeting(page) {
  const leave = anyOf(page, SEL.inMeeting);
  if (await leave.isVisible().catch(() => false)) {
    await leave.click({ timeout: 5000 }).catch(() => {});
  }
}
