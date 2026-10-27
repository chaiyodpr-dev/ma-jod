// Runs inside the meeting page (via page.addInitScript) before any of the
// page's own scripts. It taps every place the meeting's sound can come from,
// mixes it into one stream and records it with MediaRecorder:
//
//   - remote audio tracks from RTCPeerConnection ("rtc"),
//   - streams the page attaches to <audio>/<video> elements ("element"),
//   - anything the page plays through Web Audio into a speaker ("webaudio").
//
// The new Teams web client can decode audio itself and play it through Web
// Audio, leaving the WebRTC track silent, so the WebRTC hook alone is not
// enough. Every source gets a level meter, reported every 15 s as an
// "audio-level" event, so a silent recording shows which tap stayed quiet.
//
// Chunks are handed back to Node through window.__majodChunk, which the bot
// exposes with page.exposeFunction.
//
// Keep this function self-contained: Playwright serialises it to a string,
// so it cannot reference anything outside its own body.
export function captureInit({ timesliceMs = 10_000, levelIntervalMs = 15_000 } = {}) {
  if (window.__majod) return;

  const state = {
    ctx: null,
    dest: null,
    recorder: null,
    sources: [],
    trackIds: new Set(),
    bytes: 0,
    startedAt: null,
    pending: Promise.resolve(),
  };
  window.__majod = state;
  const emit = (e) => window.__majodEvent?.(e);
  // Teams sometimes reloads the page (e.g. when the meeting starts); each
  // load starts a fresh capture, so make the reloads visible in the log.
  if (window.top === window) emit({ type: 'page-loaded', url: location.href.split('?')[0] });

  const toBase64 = (bytes) => {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(s);
  };

  // Our own Web Audio nodes must not be picked up by the connect() hook below.
  const ours = new WeakSet();
  const nativeConnect = AudioNode.prototype.connect;
  const connect = (from, to) => nativeConnect.call(from, to);

  const ensureMixer = () => {
    if (state.ctx) return;
    state.ctx = new AudioContext();
    state.dest = state.ctx.createMediaStreamDestination();
    ours.add(state.ctx);
  };

  const startRecorder = () => {
    const rec = new MediaRecorder(state.dest.stream, { mimeType: 'audio/webm;codecs=opus' });
    rec.ondataavailable = (e) => {
      if (!e.data || e.data.size === 0) return;
      state.bytes += e.data.size;
      // Chain so chunks reach Node in order, and stop() can wait for the last one.
      state.pending = state.pending
        .then(() => e.data.arrayBuffer())
        .then((buf) => window.__majodChunk(toBase64(new Uint8Array(buf))))
        .catch((err) => console.error('[ma-jod] chunk failed', err));
    };
    rec.start(timesliceMs);
    state.recorder = rec;
    state.startedAt = new Date().toISOString();
    emit({ type: 'recording-started', at: state.startedAt });
    setInterval(reportLevels, levelIntervalMs);
  };

  // Peak level (dBFS) of each source since the last report.
  const reportLevels = () => {
    const levels = state.sources.map((s) => {
      const db = s.peak > 0 ? Math.round(20 * Math.log10(s.peak)) : null;
      s.peak = 0;
      return { kind: s.kind, id: s.id, peakDb: db, muted: s.track?.muted, state: s.track?.readyState };
    });
    // Keep the mixer running; a suspended context feeds the recorder nothing.
    if (state.ctx.state !== 'running') state.ctx.resume().catch(() => {});
    emit({
      type: 'audio-level',
      ctx: state.ctx.state,
      recorder: state.recorder?.state,
      bytes: state.bytes,
      sources: levels,
    });
  };

  // The bot's own (fake) microphone must never end up in the recording.
  const localIds = new Set();
  const gum = navigator.mediaDevices?.getUserMedia?.bind(navigator.mediaDevices);
  if (gum) {
    navigator.mediaDevices.getUserMedia = async (...args) => {
      const stream = await gum(...args);
      stream.getTracks().forEach((t) => localIds.add(t.id));
      return stream;
    };
  }

  const addTrack = (track, kind) => {
    if (!track || track.kind !== 'audio' || state.trackIds.has(track.id) || localIds.has(track.id)) return;
    state.trackIds.add(track.id);
    ensureMixer();
    state.ctx.resume().catch(() => {});

    const stream = new MediaStream([track]);
    // Chrome may deliver silence for a remote WebRTC track that is not
    // attached to a media element; a muted element keeps it flowing.
    if (kind !== 'webaudio') {
      const sink = new Audio();
      sink.muted = true;
      sink.srcObject = stream;
      sink.play().catch(() => {});
    }

    const node = state.ctx.createMediaStreamSource(stream);
    const analyser = state.ctx.createAnalyser();
    analyser.fftSize = 2048;
    ours.add(node);
    ours.add(analyser);
    connect(node, state.dest);
    connect(node, analyser);

    const source = { kind, id: track.id, track, peak: 0 };
    const buf = new Float32Array(analyser.fftSize);
    setInterval(() => {
      analyser.getFloatTimeDomainData(buf);
      for (const v of buf) source.peak = Math.max(source.peak, Math.abs(v));
    }, 250);
    state.sources.push(source);

    emit({ type: 'audio-track', kind, id: track.id, total: state.trackIds.size });
    if (!state.recorder) startRecorder();
  };

  state.stop = () =>
    new Promise((resolve) => {
      const rec = state.recorder;
      if (!rec || rec.state === 'inactive') return resolve();
      rec.addEventListener('stop', () => resolve(), { once: true });
      rec.stop();
    }).then(() => state.pending);

  // 1. WebRTC remote tracks.
  const Native = window.RTCPeerConnection;
  if (Native) {
    function Patched(...args) {
      const pc = new Native(...args);
      pc.addEventListener('track', (e) => addTrack(e.track, 'rtc'));
      return pc;
    }
    Patched.prototype = Native.prototype;
    Object.setPrototypeOf(Patched, Native);
    window.RTCPeerConnection = Patched;
    if (window.webkitRTCPeerConnection) window.webkitRTCPeerConnection = Patched;
  }

  // 2. Streams the page plays through <audio>/<video>.
  const srcObject = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'srcObject');
  Object.defineProperty(HTMLMediaElement.prototype, 'srcObject', {
    ...srcObject,
    set(value) {
      if (value instanceof MediaStream) {
        value.getAudioTracks().forEach((t) => addTrack(t, 'element'));
        value.addEventListener?.('addtrack', (e) => addTrack(e.track, 'element'));
      }
      return srcObject.set.call(this, value);
    },
  });

  // 3. Anything the page sends to a Web Audio speaker. Each page context gets
  // one extra MediaStream destination that mirrors its speaker output.
  const mirrors = new WeakMap();
  AudioNode.prototype.connect = function (target, ...rest) {
    const result = nativeConnect.call(this, target, ...rest);
    try {
      if (target instanceof AudioDestinationNode && !ours.has(this.context)) {
        let mirror = mirrors.get(this.context);
        if (!mirror) {
          mirror = this.context.createMediaStreamDestination();
          mirrors.set(this.context, mirror);
          addTrack(mirror.stream.getAudioTracks()[0], 'webaudio');
        }
        nativeConnect.call(this, mirror, rest[0] ?? 0);
      }
    } catch (err) {
      console.error('[ma-jod] web audio tap failed', err);
    }
    return result;
  };
}
