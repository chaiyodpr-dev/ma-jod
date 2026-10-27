// Runs inside the meeting page (via page.addInitScript) before any of the
// page's own scripts. It hooks RTCPeerConnection so every remote audio track
// the meeting receives is mixed into one stream and recorded with
// MediaRecorder. Chunks are handed back to Node through window.__majodChunk,
// which the bot exposes with page.exposeFunction.
//
// Keep this function self-contained: Playwright serialises it to a string,
// so it cannot reference anything outside its own body.
export function captureInit({ timesliceMs = 10_000 } = {}) {
  if (window.__majod) return;

  const state = {
    ctx: null,
    dest: null,
    recorder: null,
    trackIds: new Set(),
    startedAt: null,
    pending: Promise.resolve(),
  };
  window.__majod = state;

  const toBase64 = (bytes) => {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(s);
  };

  const startRecorder = () => {
    const rec = new MediaRecorder(state.dest.stream, { mimeType: 'audio/webm;codecs=opus' });
    rec.ondataavailable = (e) => {
      if (!e.data || e.data.size === 0) return;
      // Chain so chunks reach Node in order, and stop() can wait for the last one.
      state.pending = state.pending
        .then(() => e.data.arrayBuffer())
        .then((buf) => window.__majodChunk(toBase64(new Uint8Array(buf))))
        .catch((err) => console.error('[ma-jod] chunk failed', err));
    };
    rec.start(timesliceMs);
    state.recorder = rec;
    state.startedAt = new Date().toISOString();
    window.__majodEvent?.({ type: 'recording-started', at: state.startedAt });
  };

  const addTrack = (track) => {
    if (track.kind !== 'audio' || state.trackIds.has(track.id)) return;
    state.trackIds.add(track.id);
    if (!state.ctx) {
      state.ctx = new AudioContext();
      state.dest = state.ctx.createMediaStreamDestination();
    }
    state.ctx.resume().catch(() => {});
    state.ctx.createMediaStreamSource(new MediaStream([track])).connect(state.dest);
    window.__majodEvent?.({ type: 'audio-track', id: track.id, total: state.trackIds.size });
    if (!state.recorder) startRecorder();
  };

  state.stop = () =>
    new Promise((resolve) => {
      const rec = state.recorder;
      if (!rec || rec.state === 'inactive') return resolve();
      rec.addEventListener('stop', () => resolve(), { once: true });
      rec.stop();
    }).then(() => state.pending);

  const Native = window.RTCPeerConnection;
  if (!Native) return;
  function Patched(...args) {
    const pc = new Native(...args);
    pc.addEventListener('track', (e) => addTrack(e.track));
    return pc;
  }
  Patched.prototype = Native.prototype;
  Object.setPrototypeOf(Patched, Native);
  window.RTCPeerConnection = Patched;
  if (window.webkitRTCPeerConnection) window.webkitRTCPeerConnection = Patched;
}
