// Every sound is synthesised in the browser. No audio files at all: the game
// downloads in one go on a phone hotspot, and there is nothing to decode on a
// cheap Android where a few hundred kB of mp3 costs a visible stutter.
let ctx = null;
let master = null;
let enabled = true;
let unlocked = false;

export function setEnabled(v) {
  enabled = !!v;
  if (master) master.gain.value = enabled ? 0.9 : 0;
}
export function isEnabled() { return enabled; }

// Mobile browsers only allow audio to start inside a user gesture.
export function unlock() {
  if (unlocked) return;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = enabled ? 0.9 : 0;
    master.connect(ctx.destination);
    if (ctx.state === 'suspended') ctx.resume();
    unlocked = true;
  } catch (e) { /* silence is acceptable, a crash is not */ }
}

function now() { return ctx ? ctx.currentTime : 0; }

function env(node, t0, attack, decay, peak) {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.linearRampToValueAtTime(peak, t0 + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + decay);
  node.connect(g);
  g.connect(master);
  return g;
}

function tone(freq, t0, dur, type, peak, bendTo) {
  if (!ctx || !enabled) return;
  const o = ctx.createOscillator();
  o.type = type || 'sine';
  o.frequency.setValueAtTime(freq, t0);
  if (bendTo) o.frequency.exponentialRampToValueAtTime(bendTo, t0 + dur);
  env(o, t0, 0.004, dur, peak);
  o.start(t0);
  o.stop(t0 + dur + 0.05);
}

// One shared noise buffer: allocating per hit churns memory on low-end devices.
let noiseBuf = null;
function noise(t0, dur, peak, freq, q) {
  if (!ctx || !enabled) return;
  if (!noiseBuf) {
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 0.4, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    let s = 1;
    for (let i = 0; i < d.length; i++) {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      d[i] = (s / 0x3fffffff) - 1;
    }
  }
  const src = ctx.createBufferSource();
  src.buffer = noiseBuf;
  src.loop = true;
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = freq;
  bp.Q.value = q || 1.2;
  src.connect(bp);
  env(bp, t0, 0.002, dur, peak);
  src.start(t0);
  src.stop(t0 + dur + 0.05);
}

// --- game sounds -----------------------------------------------------------
export function sLaunch(power) {
  if (!ctx) return;
  const t0 = now();
  noise(t0, 0.17, 0.22, 420 + power * 700, 0.8);
  tone(130 + power * 90, t0, 0.14, 'triangle', 0.16, 70);
}

export function sWall(impact) {
  if (!ctx) return;
  const k = impact < 10 ? 10 : (impact > 180 ? 180 : impact);
  const v = 0.04 + (k / 180) * 0.16;
  noise(now(), 0.05, v, 900 + k * 7, 2.2);
}

export function sBreak() {
  if (!ctx) return;
  const t0 = now();
  noise(t0, 0.13, 0.2, 1700, 0.7);
  tone(300, t0, 0.1, 'square', 0.07, 120);
}

export function sBumper() {
  if (!ctx) return;
  const t0 = now();
  tone(520, t0, 0.1, 'triangle', 0.17, 980);
  noise(t0, 0.05, 0.08, 2400, 2);
}

// Pitch climbs with the chain: the sound itself tells you the combo is alive.
export function sTarget(chain) {
  if (!ctx) return;
  const c = chain < 1 ? 1 : (chain > 8 ? 8 : chain);
  const base = 523.25;                       // C5
  const semis = [0, 4, 7, 11, 12, 16, 19, 24][c - 1];
  const f = base * Math.pow(2, semis / 12);
  const t0 = now();
  tone(f, t0, 0.16, 'sine', 0.2);
  tone(f * 2, t0 + 0.005, 0.1, 'sine', 0.07);
  noise(t0, 0.04, 0.05, 3200, 3);
}

export function sNudge() {
  if (!ctx) return;
  const t0 = now();
  tone(760, t0, 0.09, 'sawtooth', 0.1, 1500);
  noise(t0, 0.04, 0.06, 1500, 1.5);
}

export function sPortal() {
  if (!ctx) return;
  const t0 = now();
  tone(300, t0, 0.22, 'sine', 0.12, 1800);
}

export function sClear() {
  if (!ctx) return;
  const t0 = now();
  const notes = [523.25, 659.25, 783.99, 1046.5];
  notes.forEach((f, i) => {
    tone(f, t0 + i * 0.075, 0.42, 'sine', 0.16);
    tone(f * 2, t0 + i * 0.075, 0.2, 'triangle', 0.05);
  });
}

export function sFail() {
  if (!ctx) return;
  const t0 = now();
  tone(220, t0, 0.3, 'sine', 0.13, 110);
  tone(164, t0 + 0.08, 0.3, 'triangle', 0.09, 82);
}

export function sWin() {
  if (!ctx) return;
  const t0 = now();
  [392, 523.25, 659.25, 783.99, 1046.5].forEach((f, i) => {
    tone(f, t0 + i * 0.09, 0.5, 'sine', 0.17);
  });
}

export function sTick() {
  if (!ctx) return;
  noise(now(), 0.02, 0.05, 2000, 3);
}

export function sBuy() {
  if (!ctx) return;
  const t0 = now();
  [659.25, 987.77, 1318.5].forEach((f, i) => tone(f, t0 + i * 0.07, 0.3, 'sine', 0.17));
}
