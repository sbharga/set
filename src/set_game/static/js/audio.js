/* Fully synthesized sound effects via the Web Audio API — no asset files.
 * All sounds are built from oscillators + gain envelopes so the whole
 * game runs from this one small file.
 */

const SetAudio = (() => {
  let ctx = null;
  let unavailable = false;
  let muted = false;
  try {
    muted = localStorage.getItem("set_muted") === "1";
  } catch (_error) {
    // Sound still works when browser storage is unavailable.
  }

  function ensureContext() {
    if (unavailable) return null;
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) {
      unavailable = true;
      return null;
    }
    try {
      if (!ctx) ctx = new AudioContext();
      if (ctx.state === "suspended") {
        const resumed = ctx.resume();
        if (resumed && typeof resumed.catch === "function") resumed.catch(() => {});
      }
      // Effects requested while autoplay policy still blocks audio are dropped.
      return ctx.state === "running" ? ctx : null;
    } catch (_error) {
      ctx = null;
      return null;
    }
  }

  // Unlock audio on the first user gesture, per browser autoplay policy.
  function unlock() {
    const context = ensureContext();
    if (context) {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    }
  }
  window.addEventListener("pointerdown", unlock);
  window.addEventListener("keydown", unlock);

  function tone(
    freq,
    startOffset,
    duration,
    { type = "sine", gain = 0.18, glideTo = null } = {},
  ) {
    if (muted) return;
    const c = ensureContext();
    if (!c) return;
    try {
      const t0 = c.currentTime + startOffset;
      const osc = c.createOscillator();
      const g = c.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, t0);
      if (glideTo)
        osc.frequency.exponentialRampToValueAtTime(glideTo, t0 + duration);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(gain, t0 + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
      osc.connect(g).connect(c.destination);
      osc.start(t0);
      osc.stop(t0 + duration + 0.02);
    } catch (_error) {
      // Audio failures must never interrupt game rendering or timers.
    }
  }

  function noiseWhoosh(startOffset, duration) {
    if (muted) return;
    const c = ensureContext();
    if (!c) return;
    try {
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
    } catch (_error) {
      // Audio failures must never interrupt game rendering or timers.
    }
  }

  return {
    isMuted: () => muted,
    setMuted(value) {
      muted = value;
      try {
        localStorage.setItem("set_muted", value ? "1" : "0");
      } catch (_error) {
        // Keep the preference for this page when storage is unavailable.
      }
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
      [523.25, 659.25, 783.99].forEach((f, i) =>
        tone(f, i * 0.07, 0.22, { type: "sine", gain: 0.16 }),
      );
    },
    invalidSet() {
      tone(220, 0, 0.28, { type: "sawtooth", gain: 0.14, glideTo: 110 });
    },
    deal() {
      noiseWhoosh(0, 0.22);
    },
    gameOver() {
      [523.25, 659.25, 783.99, 1046.5].forEach((f, i) =>
        tone(f, i * 0.12, 0.3, { type: "sine", gain: 0.15 }),
      );
    },
  };
})();

document.addEventListener("DOMContentLoaded", () => {
  const btn = document.getElementById("mute-toggle");
  if (!btn) return;
  const label = document.getElementById("sound-label");
  const sync = () => {
    const muted = SetAudio.isMuted();
    btn.setAttribute("aria-pressed", muted ? "true" : "false");
    if (label) label.textContent = muted ? "Sound off" : "Sound on";
  };
  sync();
  btn.addEventListener("click", () => {
    SetAudio.setMuted(!SetAudio.isMuted());
    sync();
  });
  window.addEventListener("storage", (event) => {
    if (event.key !== "set_muted") return;
    SetAudio.setMuted(event.newValue === "1");
    sync();
  });

  // "M" toggles mute from anywhere on the page (home or room), driven
  // through the same button so aria-pressed and the icon swap stay in
  // sync regardless of which path triggered it.
  document.addEventListener("keydown", (e) => {
    if (e.key.toLowerCase() !== "m" || e.metaKey || e.ctrlKey || e.altKey)
      return;
    if (!document.getElementById("how-to-play-modal")?.hidden) return;
    const target = e.target;
    const tag = (target.tagName || "").toLowerCase();
    if (
      tag === "input" ||
      tag === "textarea" ||
      tag === "select" ||
      target.isContentEditable
    )
      return;
    btn.click();
  });
});
