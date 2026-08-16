/* Fully synthesized sound effects via the Web Audio API — no asset files.
 * All sounds are built from oscillators + gain envelopes so the whole
 * game runs from this one small file.
 */

const SetAudio = (() => {
  let ctx = null;
  let muted = localStorage.getItem("set_muted") === "1";

  function ensureContext() {
    if (!ctx) {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (ctx.state === "suspended") ctx.resume();
    return ctx;
  }

  // Unlock audio on the first user gesture, per browser autoplay policy.
  function unlock() {
    ensureContext();
    window.removeEventListener("pointerdown", unlock);
    window.removeEventListener("keydown", unlock);
  }
  window.addEventListener("pointerdown", unlock, { once: true });
  window.addEventListener("keydown", unlock, { once: true });

  function tone(freq, startOffset, duration, { type = "sine", gain = 0.18, glideTo = null } = {}) {
    if (muted) return;
    const c = ensureContext();
    const t0 = c.currentTime + startOffset;
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (glideTo) osc.frequency.exponentialRampToValueAtTime(glideTo, t0 + duration);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
    osc.connect(g).connect(c.destination);
    osc.start(t0);
    osc.stop(t0 + duration + 0.02);
  }

  function noiseWhoosh(startOffset, duration) {
    if (muted) return;
    const c = ensureContext();
    const t0 = c.currentTime + startOffset;
    const bufferSize = Math.floor(c.sampleRate * duration);
    const buffer = c.createBuffer(1, bufferSize, c.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1;
    const src = c.createBufferSource();
    src.buffer = buffer;
    const filter = c.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.setValueAtTime(500, t0);
    filter.frequency.exponentialRampToValueAtTime(2200, t0 + duration);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.12, t0 + duration * 0.3);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
    src.connect(filter).connect(g).connect(c.destination);
    src.start(t0);
    src.stop(t0 + duration + 0.02);
  }

  return {
    isMuted: () => muted,
    setMuted(value) {
      muted = value;
      localStorage.setItem("set_muted", value ? "1" : "0");
    },
    click() {
      tone(720, 0, 0.06, { type: "square", gain: 0.08 });
    },
    buzzIn() {
      tone(440, 0, 0.09, { type: "triangle", gain: 0.16 });
      tone(660, 0.08, 0.14, { type: "triangle", gain: 0.16 });
    },
    tick(urgent) {
      tone(urgent ? 1000 : 800, 0, 0.05, { type: "square", gain: 0.07 });
    },
    validSet() {
      [523.25, 659.25, 783.99].forEach((f, i) => tone(f, i * 0.07, 0.22, { type: "sine", gain: 0.16 }));
    },
    invalidSet() {
      tone(220, 0, 0.28, { type: "sawtooth", gain: 0.14, glideTo: 110 });
    },
    deal() {
      noiseWhoosh(0, 0.22);
    },
    gameOver() {
      [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => tone(f, i * 0.12, 0.3, { type: "sine", gain: 0.15 }));
    },
  };
})();

document.addEventListener("DOMContentLoaded", () => {
  const btn = document.getElementById("mute-toggle");
  if (!btn) return;
  const sync = () => btn.setAttribute("aria-pressed", SetAudio.isMuted() ? "true" : "false");
  sync();
  btn.addEventListener("click", () => {
    SetAudio.setMuted(!SetAudio.isMuted());
    sync();
  });

  // "M" toggles mute from anywhere on the page (home or room), driven
  // through the same button so aria-pressed and the icon swap stay in
  // sync regardless of which path triggered it.
  document.addEventListener("keydown", (e) => {
    if (e.key.toLowerCase() !== "m" || e.metaKey || e.ctrlKey || e.altKey) return;
    const tag = (e.target.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea") return;
    btn.click();
  });
});
