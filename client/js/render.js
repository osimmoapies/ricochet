// Canvas 2D renderer.
//
// Three decisions carry the frame rate on a cheap Android inside Telegram's
// WebView, where the GPU is weak and the compositor is already busy:
//   1. the arena is baked into two offscreen layers — a backdrop that drifts
//      slightly behind the action, and the solid furniture in front of it
//   2. every lit object is a sprite baked once per resize (see fx.js) and
//      blitted; `ctx.shadowBlur` and `ctx.filter` are never touched in the
//      frame path, and no gradient is built per frame
//   3. devicePixelRatio is capped, and drops further if frames start slipping
//
// Art direction: cold vacuum, one accent. Cyan is energy the player owns,
// amber is energy the board hands back, violet is a portal, and the opponent
// is a hollow steel ghost that can never be mistaken for your own ball.
import { ARENA_W, ARENA_H, BALL_R, LAUNCH_X, LAUNCH_Y } from '../../shared/sim.js';
import { t } from './i18n.js';
import {
  PAL, rgba, glowSprite, bakeSprites, createFx, reducedMotion, rrPath, FONT,
} from './fx.js';

const OVERSCAN = 16;            // device px of backdrop hidden off-screen, for parallax

export function createRenderer(canvas) {
  const ctx = canvas.getContext('2d', { alpha: false });
  let cw = 0, ch = 0, scale = 1, ox = 0, oy = 0, dpr = 1;
  let arena = null, skin = null;
  let bgLayer = null, fgLayer = null;
  let spr = null;
  let time = 0;

  const fx = createFx();

  // transient visual state
  const bumperHits = [];        // {i, t}
  const deaths = [];            // popped targets {i, t}
  const brokenAt = [];          // breakable index -> time it died (for the ember)
  let shakeAmp = 0, shakeT = 0;
  let flash = 0, flashColor = PAL.tgt;
  let targetPulse = [];
  let settleBall = null;        // {x, y, t}
  let launchFx = 0;
  let chainGlow = 0;

  // adaptive resolution
  let slowFrames = 0, dprTarget = 0;

  // ------------------------------------------------------------ geometry
  function SX(x) { return ox + x * scale; }
  function SY(y) { return oy + y * scale; }
  function toScreen(x, y) { return { x: SX(x), y: SY(y) }; }
  /** screen pixels (CSS) -> arena units; input code needs this */
  function toArena(px, py) {
    return { x: (px * dpr - ox) / scale, y: (py * dpr - oy) / scale };
  }

  function resize() {
    const rect = canvas.getBoundingClientRect();
    const want = Math.min(window.devicePixelRatio || 1, 2);
    if (!dprTarget) dprTarget = want;
    dpr = dprTarget;
    cw = Math.max(1, Math.round((rect.width || window.innerWidth) * dpr));
    ch = Math.max(1, Math.round((rect.height || window.innerHeight) * dpr));
    canvas.width = cw;
    canvas.height = ch;
    scale = Math.min(cw / ARENA_W, ch / ARENA_H);
    ox = (cw - ARENA_W * scale) / 2;
    oy = (ch - ARENA_H * scale) / 2;
    bakeAll();
  }

  function setArena(a, sk) {
    arena = a;
    skin = sk || skin;
    targetPulse = a.targets.map((_, i) => (i * 0.37) % 1);
    bumperHits.length = 0; deaths.length = 0; brokenAt.length = 0;
    settleBall = null; launchFx = 0; chainGlow = 0;
    flash = 0; shakeAmp = 0;
    fx.reset();
    bakeAll();
  }

  // ------------------------------------------------------------ bakery
  function bakeAll() {
    if (!cw || !ch) return;
    spr = bakeSprites(arena, scale, skin, BALL_R);
    bakeBackdrop();
    bakeFurniture();
  }

  /** Deep space: gradient, two nebulae, a starfield and the measuring grid. */
  function bakeBackdrop() {
    const w = cw + OVERSCAN * 2, h = ch + OVERSCAN * 2;
    bgLayer = document.createElement('canvas');
    bgLayer.width = w; bgLayer.height = h;
    const g = bgLayer.getContext('2d');

    const grad = g.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, PAL.bg1);
    grad.addColorStop(0.55, '#060c1c');
    grad.addColorStop(1, PAL.bg0);
    g.fillStyle = grad;
    g.fillRect(0, 0, w, h);

    // two cold nebulae give the black something to be darker than
    for (const n of [
      { x: w * 0.2, y: h * 0.18, r: w * 0.7, c: 'rgba(40,96,190,0.16)' },
      { x: w * 0.9, y: h * 0.74, r: w * 0.8, c: 'rgba(96,52,170,0.11)' },
    ]) {
      const ng = g.createRadialGradient(n.x, n.y, 0, n.x, n.y, n.r);
      ng.addColorStop(0, n.c);
      ng.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = ng;
      g.fillRect(0, 0, w, h);
    }

    // starfield: three sizes so the eye reads depth, not noise
    let s = 123456789;
    const rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
    const count = Math.round((w * h) / (9000 * dpr));
    for (let i = 0; i < count; i++) {
      const x = rnd() * w, y = rnd() * h;
      const q = rnd();
      const r = (q > 0.97 ? 1.7 : q > 0.82 ? 1.1 : 0.65) * dpr;
      const a = 0.12 + q * 0.5;
      g.fillStyle = q > 0.93 ? rgba(PAL.tgt, a * 0.8) : `rgba(214,230,255,${a})`;
      g.beginPath(); g.arc(x, y, r, 0, 6.2832); g.fill();
    }

    // the grid belongs to the backdrop, so it drifts with it
    g.translate(OVERSCAN, OVERSCAN);
    g.strokeStyle = PAL.grid;
    g.lineWidth = Math.max(1, scale * 0.07);
    g.beginPath();
    for (let x = 10; x < ARENA_W; x += 10) {
      g.moveTo(SX(x), SY(0)); g.lineTo(SX(x), SY(ARENA_H));
    }
    for (let y = 10; y < ARENA_H; y += 10) {
      g.moveTo(SX(0), SY(y)); g.lineTo(SX(ARENA_W), SY(y));
    }
    g.stroke();
  }

  /** Everything solid: the frame, the walls, the mover rails, the launcher. */
  function bakeFurniture() {
    fgLayer = document.createElement('canvas');
    fgLayer.width = cw; fgLayer.height = ch;
    const g = fgLayer.getContext('2d');
    const x0 = SX(1), y0 = SY(1), x1 = SX(ARENA_W - 1), y1 = SY(ARENA_H - 1);
    const W = x1 - x0, H = y1 - y0;

    // --- everything outside the play field sinks away
    g.fillStyle = 'rgba(2,4,10,0.78)';
    g.fillRect(0, 0, cw, ch);
    g.globalCompositeOperation = 'destination-out';
    rrPath(g, x0, y0, W, H, scale * 1.6);
    g.fillStyle = '#000';
    g.fill();
    g.globalCompositeOperation = 'source-over';

    // --- vignette inside the field, so the centre is where the eye goes
    const vg = g.createRadialGradient(
      x0 + W / 2, y0 + H * 0.46, Math.min(W, H) * 0.2,
      x0 + W / 2, y0 + H * 0.5, Math.max(W, H) * 0.72,
    );
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, 'rgba(1,3,9,0.34)');
    g.save();
    rrPath(g, x0, y0, W, H, scale * 1.6);
    g.clip();
    g.fillStyle = vg;
    g.fillRect(x0, y0, W, H);
    g.restore();

    if (!arena) return;

    // --- frame with an inner glow: a lit containment edge, drawn once
    const inner = g.createLinearGradient(0, y0, 0, y0 + Math.min(H, scale * 26));
    inner.addColorStop(0, rgba(PAL.frame, 0.22));
    inner.addColorStop(1, rgba(PAL.frame, 0));
    g.save();
    rrPath(g, x0, y0, W, H, scale * 1.6); g.clip();
    g.fillStyle = inner; g.fillRect(x0, y0, W, Math.min(H, scale * 26));
    g.restore();

    g.strokeStyle = rgba(PAL.frame, 0.1);
    g.lineWidth = Math.max(2, scale * 0.9);
    rrPath(g, x0, y0, W, H, scale * 1.6); g.stroke();
    g.strokeStyle = rgba(PAL.frame, 0.6);
    g.lineWidth = Math.max(1, scale * 0.2);
    rrPath(g, x0, y0, W, H, scale * 1.6); g.stroke();

    // --- mover rails: the telegraph. You can see where it will be.
    for (const m of arena.movers) {
      g.strokeStyle = rgba(PAL.moverHi, 0.1);
      g.lineWidth = Math.max(1, BALL_R * 2 * scale);
      g.lineCap = 'round';
      g.beginPath();
      g.moveTo(SX((m.ax + m.bx) / 2), SY((m.ay + m.by) / 2));
      g.lineTo(SX((m.ax + m.bx) / 2 + m.dx), SY((m.ay + m.by) / 2 + m.dy));
      g.stroke();
      g.strokeStyle = rgba(PAL.moverHi, 0.3);
      g.lineWidth = Math.max(1, scale * 0.14);
      for (const p of [[m.ax, m.ay], [m.bx, m.by]]) {
        g.beginPath();
        g.moveTo(SX(p[0]), SY(p[1]));
        g.lineTo(SX(p[0] + m.dx), SY(p[1] + m.dy));
        g.stroke();
      }
    }

    // --- static walls, baked as cold steel slabs
    const thick = BALL_R * 2.1 * scale;
    for (const s of arena.segs) {
      if (s.kind !== 'wall') continue;
      const len = Math.hypot(s.bx - s.ax, s.by - s.ay) * scale;
      const slab = spr.slab(len, thick, s.shield ? 'shield' : 'wall', 0);
      g.save();
      g.translate(SX(s.ax), SY(s.ay));
      g.rotate(Math.atan2(s.by - s.ay, s.bx - s.ax));
      g.drawImage(slab.c, -slab.ox, -slab.oy);
      g.restore();
    }

    // --- launcher: a rail, two posts, and the shadow of a sight line
    const bx = SX(LAUNCH_X), by = SY(LAUNCH_Y);
    g.strokeStyle = rgba(PAL.frame, 0.1);
    g.lineWidth = Math.max(1, scale * 0.12);
    g.beginPath();
    g.arc(bx, by, scale * 9, Math.PI * 1.12, Math.PI * 1.88);
    g.stroke();

    g.fillStyle = rgba('#17213c', 0.95);
    rrPath(g, bx - scale * 8, by + scale * 2.1, scale * 16, scale * 2.4, scale * 1.2);
    g.fill();
    g.strokeStyle = rgba(PAL.wallHi, 0.5);
    g.lineWidth = Math.max(1, scale * 0.14);
    rrPath(g, bx - scale * 8, by + scale * 2.1, scale * 16, scale * 2.4, scale * 1.2);
    g.stroke();
    for (const sx of [-6.4, 6.4]) {
      g.fillStyle = rgba('#2b3a62', 1);
      rrPath(g, bx + scale * sx - scale * 0.6, by - scale * 0.6, scale * 1.2, scale * 3.2, scale * 0.6);
      g.fill();
      g.fillStyle = rgba(PAL.frame, 0.55);
      g.beginPath(); g.arc(bx + scale * sx, by - scale * 0.5, scale * 0.52, 0, 6.2832); g.fill();
    }
  }

  // ------------------------------------------------------------ effects in
  function burst(x, y, n, hue, speed, size) { fx.burst(x, y, n, hue, speed, size); }

  function shake(amp) {
    if (reducedMotion()) return;
    if (amp > shakeAmp) { shakeAmp = amp; shakeT = 0; }
  }

  function tint(v, color) {
    flash = Math.min(1.4, flash + v);
    if (color) flashColor = color;
  }

  /** Feed sim events here; purely cosmetic, nothing read back by the game. */
  function onEvent(ev) {
    switch (ev.t) {
      case 'launch': {
        launchFx = 1;
        fx.ring(ev.x, ev.y, BALL_R * 1.2, BALL_R * 7, 0.34, spr ? spr.glowColor : PAL.tgt, 0.5);
        fx.spray(ev.x, ev.y, 14, 200, 34 * (0.4 + ev.p), 1.0, -ev.dx, -ev.dy, 1.5);
        fx.debris(ev.x, ev.y + BALL_R, 5, '#2b3a62', 16, 0.7, 26);
        shake(0.3 + ev.p * 0.35);
        break;
      }
      case 'target': {
        const tg = arena && arena.targets[ev.i];
        const r = tg ? tg.r : 3;
        deaths.push({ x: ev.x, y: ev.y, r, i: ev.i, t: 0, mult: ev.mult });
        fx.ring(ev.x, ev.y, r * 0.8, r * (3.4 + ev.mult * 0.5), 0.46, PAL.tgt, 0.55);
        fx.burst(ev.x, ev.y, 14 + ev.mult * 2, 188, 26, 1.3);
        fx.pop(ev.x, ev.y - r * 2.4, '+' + ev.gained, ev.mult > 1 ? '×' + ev.mult : '',
          ev.mult >= 3 ? PAL.gold : '#eafaff');
        shake(ev.mult >= 3 ? 0.9 + Math.min(1.4, ev.mult * 0.22) : 0.55);
        tint(0.05 + 0.035 * ev.mult, ev.mult >= 3 ? PAL.gold : PAL.tgt);
        if (ev.mult >= 3) {
          chainGlow = 1;
          fx.banner(t('chain').toUpperCase() + ' ×' + ev.mult, PAL.gold);
        }
        break;
      }
      case 'bumper': {
        bumperHits.push({ i: ev.i, t: 0 });
        const b = arena && arena.bumpers[ev.i];
        fx.ring(ev.x, ev.y, b ? b.r : 3, (b ? b.r : 3) * 2.6, 0.32, PAL.bumpHi, 0.45);
        fx.burst(ev.x, ev.y, 9, 38, 24, 1.1);
        shake(0.5);
        break;
      }
      case 'break': {
        fx.debris(ev.x, ev.y, 10, '#7a5426', 22, 1.0, 34);
        fx.burst(ev.x, ev.y, 8, 30, 20, 1.1);
        fx.ring(ev.x, ev.y, 0.6, 5.5, 0.3, PAL.brkEdge, 0.4);
        brokenAt.push({ x: ev.x, y: ev.y, t: 0 });
        shake(0.6);
        break;
      }
      case 'wall': {
        const imp = ev.imp || 0;
        if (imp > 35) {
          // the scuff runs along the wall: its direction is the normal turned
          // a quarter turn, and the normal is where the ball went afterwards
          const vx = ev.bvx || 0, vy = ev.bvy || -1;
          const l = Math.hypot(vx, vy) || 1;
          const a = Math.atan2(vy / l, vx / l);
          fx.ring(ev.x, ev.y, 0.4, 2.2 + imp / 45, 0.26, '#bcd8ff', 0.3, [a - 1.0, a + 1.0]);
        }
        if (imp > 55) fx.spray(ev.x, ev.y, 3, 205, 13, 0.7, ev.bvx || 0, ev.bvy || -1, 1.6);
        if (imp > 110) shake(0.3);
        break;
      }
      case 'portal':
        fx.ring(ev.x, ev.y, 0.5, 7, 0.4, PAL.portalA, 0.45);
        fx.burst(ev.x, ev.y, 12, 272, 26, 1.2);
        break;
      case 'nudge':
        fx.ring(ev.x, ev.y, BALL_R, BALL_R * 5, 0.3, spr ? spr.glowColor : PAL.tgt, 0.4);
        fx.spray(ev.x, ev.y, 9, skin ? skin.hue : 190, 20, 1.0, -(ev.ndx || 0), -(ev.ndy || 1), 1.3);
        break;
      case 'settle':
        settleBall = { x: ev.x, y: ev.y, t: 0 };
        break;
      case 'clear': {
        fx.ring(ARENA_W / 2, ARENA_H / 2, 2, ARENA_W * 1.1, 0.75, PAL.tgt, 1.2);
        fx.ring(ARENA_W / 2, ARENA_H / 2, 2, ARENA_W * 0.7, 0.55, '#ffffff', 0.6);
        for (let i = 0; i < 4; i++) {
          fx.debris(10 + i * 26, 18, 9, i % 2 ? PAL.gold : PAL.tgt, 30, 1.5, 26);
        }
        fx.banner(t('clear'), PAL.mint);
        tint(0.5, PAL.mint);
        shake(1.8);
        break;
      }
      default: break;
    }
  }

  function stepEffects(dt) {
    time += dt;
    fx.step(dt);
    for (let i = bumperHits.length - 1; i >= 0; i--) {
      bumperHits[i].t += dt * 3.2;
      if (bumperHits[i].t >= 1) bumperHits.splice(i, 1);
    }
    for (let i = deaths.length - 1; i >= 0; i--) {
      deaths[i].t += dt * 3.4;
      if (deaths[i].t >= 1) deaths.splice(i, 1);
    }
    for (let i = brokenAt.length - 1; i >= 0; i--) {
      brokenAt[i].t += dt * 2.2;
      if (brokenAt[i].t >= 1) brokenAt.splice(i, 1);
    }
    if (settleBall) {
      settleBall.t += dt * 1.6;
      if (settleBall.t >= 1) settleBall = null;
    }
    shakeT += dt;
    shakeAmp *= Math.pow(0.0009, dt);
    if (shakeAmp < 0.02) shakeAmp = 0;
    flash *= Math.pow(0.0035, dt);
    launchFx *= Math.pow(0.0001, dt);
    chainGlow *= Math.pow(0.02, dt);
    for (let i = 0; i < targetPulse.length; i++) targetPulse[i] = (targetPulse[i] + dt * 0.4) % 1;
  }

  function drawGlow(g, x, y, r, color, alpha) {
    g.globalAlpha = alpha;
    g.drawImage(glowSprite(color), x - r, y - r, r * 2, r * 2);
    g.globalAlpha = 1;
  }

  // ------------------------------------------------------------ frame
  function frame(dt, view) {
    if (!arena || !bgLayer || !fgLayer) return;
    stepEffects(dt);

    const t0 = performance.now();
    const g = ctx;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalCompositeOperation = 'source-over';
    g.globalAlpha = 1;

    let sx = 0, sy = 0;
    if (shakeAmp > 0) {
      const f = shakeAmp * scale * 0.55;
      sx = Math.sin(shakeT * 61) * f;
      sy = Math.cos(shakeT * 47) * f;
    }

    // backdrop drifts at a third of the shake: cheap, real parallax
    g.drawImage(bgLayer, -OVERSCAN + sx * 0.3, -OVERSCAN + sy * 0.3);
    g.drawImage(fgLayer, sx, sy);

    g.save();
    g.translate(sx, sy);

    // ---------------------------------------------------------- breakables
    for (let i = 0; i < arena.breakables.length; i++) {
      if (view.breakAlive && !view.breakAlive[i]) continue;
      const s = arena.breakables[i];
      const b = spr.breakables[i];
      if (!b) continue;
      g.save();
      g.translate(SX(s.ax), SY(s.ay));
      g.rotate(b.ang);
      g.drawImage(b.spr.c, -b.spr.ox, -b.spr.oy);
      g.restore();
    }
    g.globalCompositeOperation = 'lighter';
    for (const e of brokenAt) {
      drawGlow(g, SX(e.x), SY(e.y), scale * 7 * (1 - e.t), PAL.brkEdge, (1 - e.t) * 0.4);
    }
    g.globalCompositeOperation = 'source-over';

    // ---------------------------------------------------------- movers
    for (let i = 0; i < arena.movers.length; i++) {
      const s = arena.movers[i];
      const m = spr.movers[i];
      if (!m) continue;
      const off = view.moverOffsets && view.moverOffsets.get(s);
      const dx = off ? off.x : 0, dy = off ? off.y : 0;
      g.save();
      g.translate(SX(s.ax + dx), SY(s.ay + dy));
      g.rotate(m.ang);
      g.drawImage(m.spr.c, -m.spr.ox, -m.spr.oy);
      g.restore();
      g.globalCompositeOperation = 'lighter';
      drawGlow(g, SX((s.ax + s.bx) / 2 + dx), SY((s.ay + s.by) / 2 + dy), scale * 8, PAL.moverHi, 0.1);
      g.globalCompositeOperation = 'source-over';
    }

    // ---------------------------------------------------------- portals
    for (let i = 0; i < arena.portals.length; i++) {
      const p = arena.portals[i];
      const px = SX(p.x), py = SY(p.y);
      const r = p.r * scale;
      const col = i === 0 ? PAL.portalA : PAL.portalB;
      g.globalCompositeOperation = 'lighter';
      drawGlow(g, px, py, r * 2.8, col, 0.42);
      g.strokeStyle = rgba(col, 0.85);
      g.lineWidth = Math.max(1, scale * 0.28);
      for (let k = 0; k < 3; k++) {
        const ph = time * (1.0 + k * 0.55) * (i ? -1 : 1) + i * 2 + k;
        const rr = r * (0.42 + 0.27 * k) * (1 + 0.07 * Math.sin(ph * 2));
        g.beginPath();
        g.arc(px, py, rr, ph, ph + 4.3);
        g.stroke();
      }
      g.globalCompositeOperation = 'source-over';
    }

    // ---------------------------------------------------------- bumpers
    for (let i = 0; i < arena.bumpers.length; i++) {
      const b = arena.bumpers[i];
      const s = spr.bumpers[i];
      if (!s) continue;
      const px = SX(b.x), py = SY(b.y);
      let hot = 0;
      for (const h of bumperHits) if (h.i === i) hot = Math.max(hot, 1 - h.t);
      const k = 1 + hot * 0.22;
      g.globalCompositeOperation = 'lighter';
      drawGlow(g, px, py, b.r * scale * 2.7, PAL.bump, 0.22 + hot * 0.55);
      g.globalCompositeOperation = 'source-over';
      const rr = s.r * k;
      g.drawImage(s.c, px - rr, py - rr, rr * 2, rr * 2);
    }

    // ---------------------------------------------------------- targets
    for (let i = 0; i < arena.targets.length; i++) {
      if (view.alive && !view.alive[i]) continue;
      const tg = arena.targets[i];
      const px = SX(tg.x), py = SY(tg.y);
      const pulse = 0.5 + 0.5 * Math.sin(targetPulse[i] * 6.2832);
      g.globalCompositeOperation = 'lighter';
      drawGlow(g, px, py, tg.r * scale * 3.0, PAL.tgt, 0.2 + pulse * 0.15);
      const ring = spr.targetRings[i];
      if (ring) {
        const a = time * 0.5 + i;
        g.save();
        g.translate(px, py);
        g.rotate(a);
        g.globalAlpha = 0.5 + pulse * 0.4;
        g.drawImage(ring.c, -ring.r, -ring.r);
        g.restore();
        g.globalAlpha = 1;
      }
      g.globalCompositeOperation = 'source-over';
      const core = spr.targets[i];
      if (core) {
        const rr = core.r * (1 + pulse * 0.05);
        g.drawImage(core.c, px - rr, py - rr, rr * 2, rr * 2);
      }
    }

    // ---------------------------------------------------------- popped targets
    g.globalCompositeOperation = 'lighter';
    for (const d of deaths) {
      const k = d.t;
      const rr = d.r * scale * (1 + k * 1.5);
      drawGlow(g, SX(d.x), SY(d.y), rr * 2.2, '#ffffff', (1 - k) * 0.55);
    }
    g.globalCompositeOperation = 'source-over';

    // ---------------------------------------------------------- ghost
    if (view.ghost && view.ghost.visible) {
      const gt = view.ghost;
      if (gt.trail && gt.trail.length >= 6) drawGhostTrail(g, gt.trail);
      const px = SX(gt.x), py = SY(gt.y);
      g.globalCompositeOperation = 'lighter';
      drawGlow(g, px, py, BALL_R * scale * 2.6, PAL.ghost, 0.22);
      g.globalCompositeOperation = 'source-over';
      g.globalAlpha = 0.8;
      g.drawImage(spr.ghost.c, px - spr.ghost.r, py - spr.ghost.r);
      g.globalAlpha = 1;
    }

    // ---------------------------------------------------------- aim
    let ballX = view.ball ? view.ball.x : LAUNCH_X;
    let ballY = view.ball ? view.ball.y : LAUNCH_Y;
    if (view.aim && view.aim.active) {
      const pull = view.aim.pull;
      ballX = LAUNCH_X - view.aim.dirx * (1.4 + pull * 5.4);
      ballY = LAUNCH_Y - view.aim.diry * (1.4 + pull * 5.4);
      drawAim(g, view.aim, ballX, ballY);
    }

    // ---------------------------------------------------------- trail + ball
    if (view.ball) {
      const vx = view.ball.vx, vy = view.ball.vy;
      const sp = Math.sqrt(vx * vx + vy * vy);
      if (view.trail && view.trail.length >= 6) drawTrail(g, view.trail, sp);
      drawBall(g, ballX, ballY, vx, vy, sp);
    } else if (settleBall) {
      const k = 1 - settleBall.t;
      g.globalCompositeOperation = 'lighter';
      drawGlow(g, SX(settleBall.x), SY(settleBall.y), BALL_R * scale * 3 * k, spr.glowColor, 0.4 * k);
      g.globalCompositeOperation = 'source-over';
      g.globalAlpha = k;
      g.drawImage(spr.ball.c, SX(settleBall.x) - spr.ball.r, SY(settleBall.y) - spr.ball.r);
      g.globalAlpha = 1;
    }

    // ---------------------------------------------------------- particles
    fx.draw(g, SX, SY, scale);

    g.globalCompositeOperation = 'source-over';
    g.globalAlpha = 1;
    g.restore();

    // ---------------------------------------------------------- full-screen
    if (flash > 0.012) {
      g.globalCompositeOperation = 'lighter';
      g.fillStyle = rgba(flashColor, Math.min(0.34, flash * 0.3));
      g.fillRect(0, 0, cw, ch);
      g.globalCompositeOperation = 'source-over';
    }
    fx.drawBanner(g, cw / 2, oy + ARENA_H * 0.33 * scale, scale);

    // ---------------------------------------------------------- budget
    const cost = performance.now() - t0;
    if (cost > 12) slowFrames++; else if (slowFrames > 0) slowFrames--;
    if (slowFrames > 45) {
      slowFrames = 0;
      if (fxBudget > 0.5) { fxBudget = 0.5; fx.setBudget(fxBudget); }
      else if (dprTarget > 1) { dprTarget = Math.max(1, dprTarget - 0.5); resize(); }
    }
  }
  let fxBudget = 1;

  // ------------------------------------------------------------ pieces
  /**
   * The trail is two tapered polygons, not a stack of strokes: one fill for
   * the body and one for the hot core. It shortens as the ball slows, which
   * is the clearest read of "this shot is running out of energy".
   */
  function drawTrail(g, pts, speed) {
    const total = pts.length / 2;
    const keep = Math.max(4, Math.round(total * (0.3 + 0.7 * Math.min(1, speed / 170))));
    const start = total - keep;
    const n = keep;
    if (n < 3) return;

    const maxW = BALL_R * scale * 1.0;
    const px = new Float32Array(n), py = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      px[i] = SX(pts[(start + i) * 2]);
      py[i] = SY(pts[(start + i) * 2 + 1]);
    }

    g.globalCompositeOperation = 'lighter';
    for (let pass = 0; pass < 2; pass++) {
      const wMul = pass === 0 ? 1 : 0.42;
      g.fillStyle = pass === 0
        ? rgba(spr.trail[1] || spr.trail[0], 0.3)
        : rgba(spr.trail[0], 0.65);
      g.beginPath();
      // forward along one side
      for (let i = 0; i < n; i++) {
        const [nx, ny] = normalAt(px, py, i, n);
        const w = maxW * wMul * (i / (n - 1));
        if (i === 0) g.moveTo(px[i] + nx * w, py[i] + ny * w);
        else g.lineTo(px[i] + nx * w, py[i] + ny * w);
      }
      // and back along the other
      for (let i = n - 1; i >= 0; i--) {
        const [nx, ny] = normalAt(px, py, i, n);
        const w = maxW * wMul * (i / (n - 1));
        g.lineTo(px[i] - nx * w, py[i] - ny * w);
      }
      g.closePath();
      g.fill();
    }
    g.globalCompositeOperation = 'source-over';
  }

  function normalAt(px, py, i, n) {
    const a = i > 0 ? i - 1 : 0;
    const b = i < n - 1 ? i + 1 : n - 1;
    let dx = px[b] - px[a], dy = py[b] - py[a];
    const l = Math.hypot(dx, dy) || 1;
    dx /= l; dy /= l;
    return [-dy, dx];
  }

  /** The ghost leaves dots, never a solid line: a different material. */
  function drawGhostTrail(g, pts) {
    const n = pts.length / 2;
    g.globalCompositeOperation = 'source-over';
    g.fillStyle = rgba(PAL.ghost, 0.3);
    for (let i = 1; i < n; i += 2) {
      const k = i / (n - 1);
      const r = BALL_R * scale * 0.42 * k;
      if (r < 0.4) continue;
      g.globalAlpha = 0.1 + k * 0.35;
      g.beginPath(); g.arc(SX(pts[i * 2]), SY(pts[i * 2 + 1]), r, 0, 6.2832); g.fill();
    }
    g.globalAlpha = 1;
  }

  function drawBall(g, x, y, vx, vy, sp) {
    const px = SX(x), py = SY(y);
    const hot = Math.min(1, sp / 200);
    g.globalCompositeOperation = 'lighter';
    drawGlow(g, px, py, BALL_R * scale * (2.8 + hot * 1.8), spr.glowColor, 0.45 + hot * 0.32);
    if (launchFx > 0.02) {
      drawGlow(g, px, py, BALL_R * scale * 6 * launchFx, '#ffffff', launchFx * 0.4);
    }
    g.globalCompositeOperation = 'source-over';
    const r = spr.ball.r;
    if (sp > 40) {
      // stretch along the direction of travel: weight you can see
      const a = Math.atan2(vy, vx);
      const k = 1 + Math.min(0.42, sp / 520);
      g.save();
      g.translate(px, py);
      g.rotate(a);
      g.scale(k, 1 / Math.sqrt(k));
      g.drawImage(spr.ball.c, -r, -r);
      g.restore();
    } else {
      g.drawImage(spr.ball.c, px - r, py - r);
    }
  }

  function drawAim(g, aim, bx, by) {
    const L = { x: SX(LAUNCH_X), y: SY(LAUNCH_Y) };
    const B = { x: SX(bx), y: SY(by) };
    const pull = aim.pull;

    // --- slingshot bands from the two posts
    g.globalCompositeOperation = 'source-over';
    g.lineCap = 'round';
    for (const off of [-6.4, 6.4]) {
      g.strokeStyle = rgba('#8fc4ff', 0.3 + pull * 0.45);
      g.lineWidth = Math.max(1.4, scale * (0.46 - pull * 0.16));
      g.beginPath();
      g.moveTo(SX(LAUNCH_X + off), SY(LAUNCH_Y - 0.5));
      g.lineTo(B.x, B.y);
      g.stroke();
    }

    // --- predicted path: solid to the first contact, dotted and fading after
    if (aim.path && aim.path.length >= 4) {
      const n = aim.path.length / 2;
      const solid = Math.max(1, aim.solidPoints | 0);
      g.globalCompositeOperation = 'lighter';
      g.strokeStyle = rgba('#cdeaff', 0.55 + pull * 0.3);
      g.lineWidth = Math.max(1, scale * 0.26);
      g.beginPath();
      for (let i = 0; i < Math.min(solid, n); i++) {
        const x = SX(aim.path[i * 2]), y = SY(aim.path[i * 2 + 1]);
        if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
      }
      g.stroke();

      const rest = n - solid;
      if (rest > 1) {
        const stride = Math.max(1, Math.round(rest / 26));
        for (let i = solid; i < n; i += stride) {
          const k = 1 - (i - solid) / rest;
          const a = k * k * 0.5;
          if (a < 0.02) continue;
          g.fillStyle = rgba('#cdeaff', a);
          const r = scale * 0.22 * (0.4 + k * 0.8);
          g.beginPath();
          g.arc(SX(aim.path[i * 2]), SY(aim.path[i * 2 + 1]), r, 0, 6.2832);
          g.fill();
        }
      }
    }

    // --- power ring on the drawn-back ball
    g.globalCompositeOperation = 'lighter';
    const r = BALL_R * scale * 2.1;
    g.strokeStyle = rgba('#17304f', 0.9);
    g.lineWidth = Math.max(1.6, scale * 0.32);
    g.beginPath(); g.arc(B.x, B.y, r, 0, 6.2832); g.stroke();
    g.strokeStyle = pull > 0.94 ? '#ff6b6b' : pull > 0.7 ? PAL.gold : PAL.tgt;
    g.beginPath();
    g.arc(B.x, B.y, r, -1.5708, -1.5708 + 6.2832 * pull);
    g.stroke();
    g.globalCompositeOperation = 'source-over';

    // keep the launch socket readable under the drawn-back ball
    g.fillStyle = rgba('#0a1426', 0.55);
    g.beginPath(); g.arc(L.x, L.y, BALL_R * scale * 0.8, 0, 6.2832); g.fill();
  }

  return {
    resize, setArena, frame, onEvent, toArena, toScreen, burst, shake,
    get scale() { return scale; },
    get dpr() { return dpr; },
    flashNow(v) { tint(v, PAL.mint); },
  };
}
