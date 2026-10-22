// Art assets and effects, all generated in code.
//
// Nothing here is downloaded: every sprite is painted once into an offscreen
// canvas at the current device scale and then blitted. That is the whole
// performance strategy for a cheap Android inside the Telegram WebView —
// `ctx.shadowBlur` is a software blur per draw call and a `createRadialGradient`
// per frame is a texture upload per frame, so both are banned from the frame
// path and live only inside the bakery below.
//
// Three exports matter to the rest of the app:
//   bakeSprites()  — the sprite set, rebuilt on resize
//   createFx()     — particles, rings, score pops, banners
//   createLogo()   — the РИКОШЕТ mark: a ball that ricochets into the symbol

// ---------------------------------------------------------------- palette
// Same numbers as the CSS custom properties in app.css. One accent (cyan) for
// energy the player owns, amber for energy the board gives back, a steel
// ghost for the opponent that can never read as "yours".
export const PAL = {
  void: '#03050c',
  bg0: '#02040a',
  bg1: '#0b1430',
  bg2: '#050a16',
  grid: 'rgba(96,146,226,0.085)',
  frame: '#6e9ae0',

  wall: '#26355f',
  wallHi: '#8fb2ea',
  wallLo: '#070c18',
  shieldHi: '#9cbcf0',

  brk: '#6b4a21',
  brkHot: '#c27a2a',
  brkEdge: '#ffc06a',
  brkCrack: '#120a02',

  mover: '#0e3744',
  moverHi: '#4fd6e8',

  bump: '#ffb347',
  bumpHi: '#fff0c8',
  bumpLo: '#a9540c',

  portalA: '#a678ff',
  portalB: '#7fa0ff',

  tgt: '#5be9ff',
  tgtCore: '#f0ffff',
  tgtDeep: '#06465e',

  ghost: '#9bb0d4',
  ink: '#dbe8ff',
  gold: '#ffd66a',
  rose: '#ff5c8a',
  mint: '#6effa8',
};

export function rgba(hex, a) {
  if (hex[0] !== '#') return hex;
  let h = hex.slice(1);
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const n = parseInt(h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

// ---------------------------------------------------------------- motion safety
let rmQuery = null;
export function reducedMotion() {
  if (rmQuery === null) {
    rmQuery = (typeof matchMedia === 'function')
      ? matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
  }
  return !!rmQuery.matches;
}

// ---------------------------------------------------------------- canvas helpers
function mk(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.ceil(w));
  c.height = Math.max(1, Math.ceil(h));
  return c;
}

/** Rounded rect path without ctx.roundRect, which old WebViews lack. */
export function rrPath(g, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  g.beginPath();
  g.moveTo(x + rr, y);
  g.lineTo(x + w - rr, y);
  g.arcTo(x + w, y, x + w, y + rr, rr);
  g.lineTo(x + w, y + h - rr);
  g.arcTo(x + w, y + h, x + w - rr, y + h, rr);
  g.lineTo(x + rr, y + h);
  g.arcTo(x, y + h, x, y + h - rr, rr);
  g.lineTo(x, y + rr);
  g.arcTo(x, y, x + rr, y, rr);
  g.closePath();
}

// A tiny deterministic generator so a given block always cracks the same way.
function prng(seed) {
  let s = (seed * 2654435761) >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

// ---------------------------------------------------------------- glow sprites
// One 128px radial sprite per colour, blitted with 'lighter'. Scaling a
// cached bitmap is free next to building a gradient every frame.
const glowCache = new Map();
export function glowSprite(color) {
  let c = glowCache.get(color);
  if (c) return c;
  const size = 128, h = size / 2;
  c = mk(size, size);
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(h, h, 0, h, h, h);
  grad.addColorStop(0, rgba(color, 0.95));
  grad.addColorStop(0.14, rgba(color, 0.55));
  grad.addColorStop(0.36, rgba(color, 0.17));
  grad.addColorStop(0.68, rgba(color, 0.035));
  grad.addColorStop(1, rgba(color, 0));
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  glowCache.set(color, c);
  return c;
}

// ---------------------------------------------------------------- sprite bakery
function ballSprite(skin, r) {
  const pad = Math.max(2, r * 0.6);
  const size = (r + pad) * 2;
  const c = mk(size, size);
  const g = c.getContext('2d');
  const cx = size / 2, cy = size / 2;
  const core = (skin && skin.core) || '#ffffff';
  const glow = (skin && skin.glow) || PAL.tgt;

  const grad = g.createRadialGradient(cx - r * 0.32, cy - r * 0.36, r * 0.08, cx, cy, r);
  grad.addColorStop(0, '#ffffff');
  grad.addColorStop(0.3, core);
  grad.addColorStop(1, glow);
  g.fillStyle = grad;
  g.beginPath(); g.arc(cx, cy, r, 0, 6.2832); g.fill();

  // rim light: the single cue that makes a flat disc read as a sphere
  g.strokeStyle = rgba('#ffffff', 0.7);
  g.lineWidth = Math.max(0.7, r * 0.14);
  g.beginPath(); g.arc(cx, cy, r * 0.93, -2.5, 0.3); g.stroke();
  return { c, r: r + pad };
}

function ghostSprite(r) {
  const pad = Math.max(2, r * 0.8);
  const size = (r + pad) * 2;
  const c = mk(size, size);
  const g = c.getContext('2d');
  const cx = size / 2, cy = size / 2;
  // hollow: the silhouette does the work, so the ghost is unmistakable even
  // at a glance in the corner of the eye
  g.fillStyle = rgba(PAL.ghost, 0.16);
  g.beginPath(); g.arc(cx, cy, r * 0.95, 0, 6.2832); g.fill();
  g.strokeStyle = rgba(PAL.ghost, 0.75);
  g.lineWidth = Math.max(1, r * 0.3);
  g.beginPath(); g.arc(cx, cy, r * 0.8, 0, 6.2832); g.stroke();
  return { c, r: r + pad };
}

function targetSprite(r) {
  const pad = Math.max(2, r * 0.35);
  const size = (r + pad) * 2;
  const c = mk(size, size);
  const g = c.getContext('2d');
  const cx = size / 2, cy = size / 2;

  const grad = g.createRadialGradient(cx - r * 0.25, cy - r * 0.3, r * 0.06, cx, cy, r);
  grad.addColorStop(0, PAL.tgtCore);
  grad.addColorStop(0.42, PAL.tgt);
  grad.addColorStop(1, PAL.tgtDeep);
  g.fillStyle = grad;
  g.beginPath(); g.arc(cx, cy, r, 0, 6.2832); g.fill();

  // aperture: a dark iris turns the dot into something aimed at
  g.strokeStyle = rgba('#03202c', 0.55);
  g.lineWidth = Math.max(1, r * 0.17);
  g.beginPath(); g.arc(cx, cy, r * 0.56, 0, 6.2832); g.stroke();

  g.fillStyle = '#ffffff';
  g.beginPath(); g.arc(cx, cy, r * 0.2, 0, 6.2832); g.fill();

  g.strokeStyle = rgba('#dffcff', 0.85);
  g.lineWidth = Math.max(0.8, r * 0.1);
  g.beginPath(); g.arc(cx, cy, r * 0.97, 0, 6.2832); g.stroke();
  return { c, r: r + pad };
}

/** The rotating reticle that says "hit me" without a word of UI. */
function targetRingSprite(r) {
  const R = r * 1.62;
  const size = R * 2;
  const c = mk(size, size);
  const g = c.getContext('2d');
  const cx = size / 2, cy = size / 2;
  const rr = r * 1.34;
  g.strokeStyle = rgba(PAL.tgt, 0.6);
  g.lineWidth = Math.max(1, r * 0.13);
  g.lineCap = 'round';
  for (let k = 0; k < 3; k++) {
    const a = (k * 6.2832) / 3;
    g.beginPath(); g.arc(cx, cy, rr, a - 0.34, a + 0.34); g.stroke();
  }
  return { c, r: R };
}

function bumperSprite(r) {
  const pad = Math.max(2, r * 0.4);
  const size = (r + pad) * 2;
  const c = mk(size, size);
  const g = c.getContext('2d');
  const cx = size / 2, cy = size / 2;

  const grad = g.createRadialGradient(cx, cy - r * 0.42, r * 0.1, cx, cy, r);
  grad.addColorStop(0, PAL.bumpHi);
  grad.addColorStop(0.45, PAL.bump);
  grad.addColorStop(1, PAL.bumpLo);
  g.fillStyle = grad;
  g.beginPath(); g.arc(cx, cy, r, 0, 6.2832); g.fill();

  // charged coil: four nubs read as stored energy rather than decoration
  g.strokeStyle = rgba('#3b1a00', 0.45);
  g.lineWidth = Math.max(1, r * 0.13);
  for (let k = 0; k < 4; k++) {
    const a = (k * 6.2832) / 4 + 0.78;
    g.beginPath();
    g.moveTo(cx + Math.cos(a) * r * 0.42, cy + Math.sin(a) * r * 0.42);
    g.lineTo(cx + Math.cos(a) * r * 0.78, cy + Math.sin(a) * r * 0.78);
    g.stroke();
  }
  g.strokeStyle = rgba(PAL.bumpHi, 0.9);
  g.lineWidth = Math.max(1, r * 0.14);
  g.beginPath(); g.arc(cx, cy, r * 0.94, 0, 6.2832); g.stroke();
  return { c, r: r + pad };
}

/**
 * A slab sprite for one segment, drawn horizontally; the caller rotates it.
 * `kind` picks the material: cold steel, warm cracked block, charged rail.
 */
function slabSprite(lenPx, thickPx, kind, seed) {
  const pad = Math.ceil(thickPx * 0.9 + 3);
  const w = Math.ceil(lenPx) + pad * 2;
  const h = Math.ceil(thickPx) + pad * 2;
  const c = mk(w, h);
  const g = c.getContext('2d');
  const x = pad, y = pad, bw = lenPx, bh = thickPx;
  const r = bh / 2;

  if (kind === 'break') {
    const grad = g.createLinearGradient(0, y, 0, y + bh);
    grad.addColorStop(0, '#a9793a');
    grad.addColorStop(0.5, PAL.brk);
    grad.addColorStop(1, '#2a1b08');
    rrPath(g, x, y, bw, bh, r);
    g.fillStyle = grad; g.fill();

    // heat trapped in the block: it is about to break, and it looks it
    const hot = g.createLinearGradient(x, 0, x + bw, 0);
    hot.addColorStop(0, rgba(PAL.brkHot, 0.0));
    hot.addColorStop(0.5, rgba(PAL.brkHot, 0.5));
    hot.addColorStop(1, rgba(PAL.brkHot, 0.0));
    g.fillStyle = hot;
    rrPath(g, x, y + bh * 0.3, bw, bh * 0.4, bh * 0.2); g.fill();

    const rnd = prng(seed + 7);
    g.strokeStyle = rgba(PAL.brkCrack, 0.85);
    g.lineWidth = Math.max(0.8, bh * 0.1);
    g.lineCap = 'round';
    const n = 3;
    for (let i = 0; i < n; i++) {
      const sx = x + bw * (0.18 + 0.64 * (i + rnd() * 0.6) / n);
      g.beginPath();
      g.moveTo(sx, y + bh * 0.04);
      g.lineTo(sx + (rnd() - 0.5) * bh * 0.9, y + bh * 0.45);
      g.lineTo(sx + (rnd() - 0.5) * bh * 1.2, y + bh * 0.96);
      g.stroke();
    }
    g.strokeStyle = rgba(PAL.brkEdge, 0.55);
    g.lineWidth = Math.max(0.8, bh * 0.1);
    rrPath(g, x, y, bw, bh, r); g.stroke();
  } else if (kind === 'mover') {
    const grad = g.createLinearGradient(0, y, 0, y + bh);
    grad.addColorStop(0, '#2d8699');
    grad.addColorStop(1, '#09303c');
    rrPath(g, x, y, bw, bh, r);
    g.fillStyle = grad; g.fill();
    g.strokeStyle = rgba(PAL.moverHi, 0.9);
    g.lineWidth = Math.max(1, bh * 0.16);
    g.beginPath();
    g.moveTo(x + r, y + bh * 0.22); g.lineTo(x + bw - r, y + bh * 0.22);
    g.stroke();
    // chevrons: which way this thing is about to go
    g.strokeStyle = rgba(PAL.moverHi, 0.4);
    g.lineWidth = Math.max(0.8, bh * 0.12);
    for (let i = 0; i < 2; i++) {
      const cx2 = x + bw * (0.36 + i * 0.28);
      g.beginPath();
      g.moveTo(cx2 - bh * 0.22, y + bh * 0.42);
      g.lineTo(cx2 + bh * 0.1, y + bh * 0.62);
      g.lineTo(cx2 - bh * 0.22, y + bh * 0.82);
      g.stroke();
    }
  } else {
    // cold steel: light from above, shadow below, no glow at all
    const grad = g.createLinearGradient(0, y, 0, y + bh);
    grad.addColorStop(0, kind === 'shield' ? '#53689f' : '#4a5d93');
    grad.addColorStop(0.42, PAL.wall);
    grad.addColorStop(1, PAL.wallLo);
    rrPath(g, x, y, bw, bh, r);
    g.fillStyle = grad; g.fill();
    g.strokeStyle = rgba(kind === 'shield' ? PAL.shieldHi : PAL.wallHi, 0.95);
    g.lineWidth = Math.max(1, bh * 0.16);
    g.beginPath();
    g.moveTo(x + r * 0.6, y + bh * 0.16); g.lineTo(x + bw - r * 0.6, y + bh * 0.16);
    g.stroke();
    g.strokeStyle = rgba('#000000', 0.45);
    g.beginPath();
    g.moveTo(x + r * 0.6, y + bh * 0.9); g.lineTo(x + bw - r * 0.6, y + bh * 0.9);
    g.stroke();
    g.strokeStyle = rgba('#0a1020', 0.9);
    g.lineWidth = Math.max(1, bh * 0.1);
    rrPath(g, x, y, bw, bh, r); g.stroke();
    if (kind === 'shield') {
      g.strokeStyle = rgba(PAL.shieldHi, 0.3);
      g.lineWidth = Math.max(0.7, bh * 0.08);
      for (let i = 0; i < bw; i += bh * 0.75) {
        g.beginPath();
        g.moveTo(x + i, y + bh * 0.28);
        g.lineTo(x + i + bh * 0.4, y + bh * 0.78);
        g.stroke();
      }
    }
  }
  return { c, ox: pad, oy: h / 2 };
}

/**
 * Bake everything that depends on the device scale. Called on resize and
 * whenever the arena or skin changes; never inside the frame path.
 */
export function bakeSprites(arena, scale, skin, ballR) {
  const r = ballR * scale;
  const out = {
    ball: ballSprite(skin, r),
    ghost: ghostSprite(r),
    targets: [],
    targetRings: [],
    bumpers: [],
    breakables: [],
    movers: [],
    glowColor: (skin && skin.glow) || PAL.tgt,
    trail: (skin && skin.trail) || ['#7df9ff', '#3a6fff'],
  };
  if (!arena) return out;

  for (const t of arena.targets) {
    out.targets.push(targetSprite(t.r * scale));
    out.targetRings.push(targetRingSprite(t.r * scale));
  }
  for (const b of arena.bumpers) out.bumpers.push(bumperSprite(b.r * scale));

  const thick = ballR * 2.0 * scale;
  for (let i = 0; i < arena.breakables.length; i++) {
    const s = arena.breakables[i];
    const len = Math.hypot(s.bx - s.ax, s.by - s.ay) * scale;
    out.breakables.push({
      spr: slabSprite(len, thick * 0.92, 'break', i + 1),
      ang: Math.atan2(s.by - s.ay, s.bx - s.ax),
    });
  }
  for (let i = 0; i < arena.movers.length; i++) {
    const s = arena.movers[i];
    const len = Math.hypot(s.bx - s.ax, s.by - s.ay) * scale;
    out.movers.push({
      spr: slabSprite(len, thick, 'mover', i + 31),
      ang: Math.atan2(s.by - s.ay, s.bx - s.ax),
    });
  }
  out.slab = slabSprite;          // walls are baked straight into the backdrop
  return out;
}

// ---------------------------------------------------------------- effects
/**
 * Particles, rings, score pops and banners. Everything lives in arena units
 * so the whole system survives a resize without a single conversion.
 */
export function createFx() {
  const sparks = [];
  const shards = [];
  const rings = [];
  const pops = [];
  let banner = null;
  let budget = 1;

  function cap() { return reducedMotion() ? 70 : 260; }

  function burst(x, y, n, hue, speed, size) {
    const k = reducedMotion() ? 0.35 : budget;
    const count = Math.max(1, Math.round(n * k));
    for (let i = 0; i < count; i++) {
      const a = Math.random() * 6.2832;
      const sp = speed * (0.35 + Math.random() * 0.95);
      sparks.push({
        x, y,
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        life: 1, decay: 1.5 + Math.random() * 1.7,
        size: size * (0.55 + Math.random() * 0.85),
        hue,
      });
    }
    const m = cap();
    if (sparks.length > m) sparks.splice(0, sparks.length - m);
  }

  /** A directional spray — launch dust, wall scuff, bumper discharge. */
  function spray(x, y, n, hue, speed, size, dx, dy, spread) {
    const k = reducedMotion() ? 0.35 : budget;
    const base = Math.atan2(dy, dx);
    const count = Math.max(1, Math.round(n * k));
    for (let i = 0; i < count; i++) {
      const a = base + (Math.random() - 0.5) * spread;
      const sp = speed * (0.4 + Math.random() * 0.9);
      sparks.push({
        x, y,
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        life: 1, decay: 1.8 + Math.random() * 1.8,
        size: size * (0.5 + Math.random() * 0.8),
        hue,
      });
    }
    const m = cap();
    if (sparks.length > m) sparks.splice(0, sparks.length - m);
  }

  /** Tumbling chips: breakable debris and the clear-the-board confetti. */
  function debris(x, y, n, color, speed, size, gravity) {
    const k = reducedMotion() ? 0.3 : budget;
    const count = Math.max(1, Math.round(n * k));
    for (let i = 0; i < count; i++) {
      const a = Math.random() * 6.2832;
      const sp = speed * (0.3 + Math.random());
      shards.push({
        x, y,
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        rot: Math.random() * 6.2832,
        spin: (Math.random() - 0.5) * 14,
        life: 1, decay: 0.7 + Math.random() * 0.8,
        w: size * (0.6 + Math.random() * 0.9),
        h: size * (0.3 + Math.random() * 0.5),
        g: gravity || 0,
        color,
      });
    }
    if (shards.length > 150) shards.splice(0, shards.length - 150);
  }

  function ring(x, y, r0, r1, dur, color, width, arc) {
    rings.push({ x, y, r0, r1, t: 0, dur, color, width, arc: arc || null });
    if (rings.length > 26) rings.shift();
  }

  function pop(x, y, text, sub, color) {
    pops.push({ x, y, text, sub: sub || '', color, t: 0, dur: 1.05 });
    if (pops.length > 12) pops.shift();
  }

  function showBanner(text, color) {
    banner = { text, color, t: 0, dur: reducedMotion() ? 0.9 : 1.25 };
  }

  function reset() {
    sparks.length = 0; shards.length = 0; rings.length = 0; pops.length = 0;
    banner = null;
  }

  function step(dt) {
    for (let i = sparks.length - 1; i >= 0; i--) {
      const p = sparks[i];
      p.life -= dt * p.decay;
      if (p.life <= 0) { sparks.splice(i, 1); continue; }
      p.x += p.vx * dt; p.y += p.vy * dt;
      p.vx *= 0.94; p.vy *= 0.94;
    }
    for (let i = shards.length - 1; i >= 0; i--) {
      const p = shards[i];
      p.life -= dt * p.decay;
      if (p.life <= 0) { shards.splice(i, 1); continue; }
      p.vy += p.g * dt;
      p.x += p.vx * dt; p.y += p.vy * dt;
      p.vx *= 0.97; p.vy *= 0.985;
      p.rot += p.spin * dt;
    }
    for (let i = rings.length - 1; i >= 0; i--) {
      rings[i].t += dt;
      if (rings[i].t >= rings[i].dur) rings.splice(i, 1);
    }
    for (let i = pops.length - 1; i >= 0; i--) {
      pops[i].t += dt;
      pops[i].y -= dt * 9;
      if (pops[i].t >= pops[i].dur) pops.splice(i, 1);
    }
    if (banner) {
      banner.t += dt;
      if (banner.t >= banner.dur) banner = null;
    }
  }

  /**
   * `px`/`py` map arena units to device pixels; `s` is pixels per unit.
   * The caller has already applied the shake translate.
   */
  function draw(g, px, py, s) {
    // --- rings: the single clearest "something happened here" cue
    g.globalCompositeOperation = 'lighter';
    for (const r of rings) {
      const k = r.t / r.dur;
      const rad = (r.r0 + (r.r1 - r.r0) * (1 - (1 - k) * (1 - k))) * s;
      const a = (1 - k) * (1 - k);
      g.strokeStyle = rgba(r.color, a * 0.9);
      g.lineWidth = Math.max(0.6, r.width * s * (1 - k * 0.7));
      g.beginPath();
      if (r.arc) g.arc(px(r.x), py(r.y), rad, r.arc[0], r.arc[1]);
      else g.arc(px(r.x), py(r.y), rad, 0, 6.2832);
      g.stroke();
    }

    // --- sparks
    for (const p of sparks) {
      const a = p.life * p.life;
      g.fillStyle = `hsla(${p.hue},100%,${56 + p.life * 30}%,${a})`;
      const rr = p.size * s * (0.3 + p.life * 0.9);
      g.beginPath(); g.arc(px(p.x), py(p.y), rr, 0, 6.2832); g.fill();
    }

    // --- debris
    g.globalCompositeOperation = 'source-over';
    for (const p of shards) {
      const a = Math.min(1, p.life * 1.6);
      g.save();
      g.translate(px(p.x), py(p.y));
      g.rotate(p.rot);
      g.globalAlpha = a;
      g.fillStyle = p.color;
      g.fillRect(-p.w * s * 0.5, -p.h * s * 0.5, p.w * s, p.h * s);
      g.restore();
    }
    g.globalAlpha = 1;

    // --- score pops
    for (const p of pops) {
      const k = p.t / p.dur;
      const a = k < 0.12 ? k / 0.12 : Math.max(0, 1 - (k - 0.12) / 0.88);
      const sc = k < 0.16 ? 0.5 + 0.6 * (k / 0.16) : 1.1 - 0.1 * ((k - 0.16) / 0.84);
      const size = s * 3.3 * sc;
      g.save();
      g.globalAlpha = a;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      // a dark halo, because the number lands on top of its own explosion
      g.lineJoin = 'round';
      g.strokeStyle = 'rgba(2,6,16,0.75)';
      g.lineWidth = Math.max(2, size * 0.2);
      g.font = `800 ${size.toFixed(1)}px ${FONT}`;
      g.strokeText(p.text, px(p.x), py(p.y));
      g.fillStyle = p.color;
      g.fillText(p.text, px(p.x), py(p.y));
      if (p.sub) {
        g.font = `800 ${(size * 0.82).toFixed(1)}px ${FONT}`;
        g.lineWidth = Math.max(2, size * 0.17);
        g.strokeText(p.sub, px(p.x), py(p.y) + size * 0.92);
        g.fillStyle = PAL.gold;
        g.fillText(p.sub, px(p.x), py(p.y) + size * 0.92);
      }
      g.restore();
    }
  }

  /** Banners sit in screen space, so they are drawn outside the shake. */
  function drawBanner(g, cx, cy, s) {
    if (!banner) return;
    const k = banner.t / banner.dur;
    const a = k < 0.1 ? k / 0.1 : Math.max(0, 1 - (k - 0.1) / 0.9);
    const sc = k < 0.18 ? 0.72 + 0.4 * (k / 0.18) : 1.12 - 0.12 * ((k - 0.18) / 0.82);
    const size = s * 5.0 * sc;
    g.save();
    g.globalAlpha = a;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = `800 ${size.toFixed(1)}px ${FONT}`;
    g.fillStyle = rgba('#000000', 0.35);
    g.fillText(banner.text, cx, cy + size * 0.06);
    g.fillStyle = banner.color;
    g.fillText(banner.text, cx, cy);
    g.restore();
  }

  return {
    burst, spray, debris, ring, pop, banner: showBanner, reset, step, draw, drawBanner,
    setBudget(v) { budget = v; },
    get load() { return sparks.length + shards.length; },
  };
}

export const FONT = '-apple-system, "SF Pro Text", Roboto, system-ui, sans-serif';

// ---------------------------------------------------------------- the mark
// РИКОШЕТ drawn in code: a ball enters the frame, takes three bounces off the
// inside of a steel ring, and the path it burns is the logo. Nothing is
// downloaded and nothing is an image file.
const LOGO_PATH = [
  [16, 22], [84, 44], [19, 66], [78, 88],
];

export function createLogo(canvas, opts = {}) {
  const ctx = canvas.getContext('2d');
  let w = 0, h = 0, u = 1, dpr = 1;
  let raf = 0, t0 = 0, running = false;
  const loop = opts.loop !== false;
  const period = opts.period || 4.6;
  const accent = opts.color || PAL.tgt;

  // cumulative lengths so the ball travels at a constant speed
  const segs = [];
  let total = 0;
  for (let i = 1; i < LOGO_PATH.length; i++) {
    const d = Math.hypot(LOGO_PATH[i][0] - LOGO_PATH[i - 1][0], LOGO_PATH[i][1] - LOGO_PATH[i - 1][1]);
    segs.push(d); total += d;
  }

  function measure() {
    const rect = canvas.getBoundingClientRect();
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cw = Math.max(1, Math.round((rect.width || 92) * dpr));
    const chh = Math.max(1, Math.round((rect.height || 92) * dpr));
    if (cw === w && chh === h) return;
    w = cw; h = chh;
    canvas.width = w; canvas.height = h;
    u = Math.min(w, h) / 100;
  }

  function at(dist) {
    let d = dist;
    for (let i = 0; i < segs.length; i++) {
      if (d <= segs[i]) {
        const k = segs[i] === 0 ? 0 : d / segs[i];
        return [
          LOGO_PATH[i][0] + (LOGO_PATH[i + 1][0] - LOGO_PATH[i][0]) * k,
          LOGO_PATH[i][1] + (LOGO_PATH[i + 1][1] - LOGO_PATH[i][1]) * k,
          i,
        ];
      }
      d -= segs[i];
    }
    const n = LOGO_PATH.length - 1;
    return [LOGO_PATH[n][0], LOGO_PATH[n][1], segs.length - 1];
  }

  function paint(time) {
    measure();
    const g = ctx;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, w, h);
    const X = (v) => (w - 100 * u) / 2 + v * u;
    const Y = (v) => (h - 100 * u) / 2 + v * u;

    // phase 0..1 draws the path, then it rests lit
    const draw = Math.min(1, time / 1.15);
    const settle = Math.max(0, Math.min(1, (time - 1.15) / 0.5));
    const breathe = 0.5 + 0.5 * Math.sin(time * 1.6);

    // --- the ring: cold, solid, the arena itself
    g.lineWidth = 2.2 * u;
    g.strokeStyle = rgba(PAL.wallHi, 0.5 + settle * 0.3);
    rrPath(g, X(6), Y(6), 88 * u, 88 * u, 26 * u);
    g.stroke();

    g.globalCompositeOperation = 'lighter';
    g.lineWidth = 1 * u;
    g.strokeStyle = rgba(accent, 0.1 + settle * 0.14 * breathe);
    rrPath(g, X(6), Y(6), 88 * u, 88 * u, 26 * u);
    g.stroke();

    // --- the burned path
    const head = total * draw;
    g.lineCap = 'round';
    g.lineJoin = 'round';
    for (let pass = 0; pass < 2; pass++) {
      g.lineWidth = (pass === 0 ? 7 : 2.6) * u;
      g.strokeStyle = pass === 0
        ? rgba(accent, 0.1 + settle * 0.08)
        : rgba('#ffffff', 0.55 + settle * 0.35);
      g.beginPath();
      g.moveTo(X(LOGO_PATH[0][0]), Y(LOGO_PATH[0][1]));
      let d = head;
      for (let i = 0; i < segs.length && d > 0; i++) {
        const k = Math.min(1, d / segs[i]);
        g.lineTo(
          X(LOGO_PATH[i][0] + (LOGO_PATH[i + 1][0] - LOGO_PATH[i][0]) * k),
          Y(LOGO_PATH[i][1] + (LOGO_PATH[i + 1][1] - LOGO_PATH[i][1]) * k),
        );
        d -= segs[i];
      }
      g.stroke();
    }

    // --- bounce flares, lit as the head passes them
    let acc = 0;
    for (let i = 0; i < segs.length; i++) {
      acc += segs[i];
      if (i === segs.length - 1) break;
      const since = head - acc;
      if (since < 0) continue;
      const fa = Math.max(0.25, 1 - since / 26);
      const p = LOGO_PATH[i + 1];
      const spr = glowSprite(accent);
      const rr = (5 + (1 - fa) * 4) * u;
      g.globalAlpha = fa * 0.8;
      g.drawImage(spr, X(p[0]) - rr * 2, Y(p[1]) - rr * 2, rr * 4, rr * 4);
      g.globalAlpha = 1;
    }

    // --- the ball
    const [bx, by] = at(head);
    const spr = glowSprite(accent);
    const gr = (9 + breathe * 1.6 * settle) * u;
    g.drawImage(spr, X(bx) - gr, Y(by) - gr, gr * 2, gr * 2);
    g.globalCompositeOperation = 'source-over';
    g.fillStyle = '#ffffff';
    g.beginPath(); g.arc(X(bx), Y(by), 3.6 * u, 0, 6.2832); g.fill();
  }

  function frame(now) {
    if (!running) return;
    if (!t0) t0 = now;
    let time = (now - t0) / 1000;
    if (loop && time > period) { t0 = now; time = 0; }
    paint(time);
    raf = requestAnimationFrame(frame);
  }

  return {
    play() {
      if (running) return;
      if (reducedMotion()) { measure(); paint(2.2); return; }
      running = true; t0 = 0;
      raf = requestAnimationFrame(frame);
    },
    stop() { running = false; if (raf) cancelAnimationFrame(raf); raf = 0; },
    redraw() { measure(); paint(running ? 2.2 : 2.2); },
  };
}

// ---------------------------------------------------------------- score roll
/**
 * Roll a number up digit by digit. Used for the HUD score and the result
 * screen, where the number landing is half the reward.
 */
export function rollNumber(el, to, ms) {
  const target = Math.round(to) || 0;
  const from = Number(el.dataset.v || 0) || 0;
  el.dataset.v = String(target);
  if (el._roll) { cancelAnimationFrame(el._roll); el._roll = 0; }
  if (from === target || reducedMotion() || !ms) { el.textContent = target; return; }
  const dur = ms;
  const t0 = performance.now();
  const tick = (now) => {
    const k = Math.min(1, (now - t0) / dur);
    const e = 1 - Math.pow(1 - k, 3);
    el.textContent = Math.round(from + (target - from) * e);
    if (k < 1) el._roll = requestAnimationFrame(tick);
    else { el._roll = 0; el.textContent = target; }
  };
  el._roll = requestAnimationFrame(tick);
}
