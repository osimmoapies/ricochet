// РИКОШЕТ — deterministic physics core.
//
// This module is the single source of truth for the game. The exact same file
// runs in the browser and inside the Cloudflare Worker, so a run submitted by
// a client can be replayed server-side and scored again. If the two disagree,
// the run is a cheat.
//
// Determinism rules obeyed throughout:
//   * only + - * / and Math.sqrt  (all exactly specified by IEEE-754)
//   * никогда Math.sin/cos/atan2/pow/random — they are platform-dependent
//   * all external input arrives as integers and is normalised here
//   * iteration order over colliders is fixed by array index
//
// Units: arena is 100 x 160 (portrait), seconds are real seconds.

export const ARENA_W = 100;
export const ARENA_H = 160;

export const BALL_R = 1.7;
export const DT = 1 / 240;              // physics step
export const STEPS_PER_FRAME = 4;       // 60 fps rendering
export const MAX_SHOT_STEPS = 240 * 6;  // hard stop for one shot: 6 s
export const MAX_SHOTS = 5;

export const LAUNCH_X = 50;
export const LAUNCH_Y = 150.5;

// --- Energy economy. This is the whole game balance in nine numbers.
// Walls EAT energy, so a shot only lives for a handful of bounces: spraying
// the ball around cannot clear a board. Bumpers and targets GIVE energy back,
// so the long runs belong to players who plan a route through them.
const MIN_SPEED = 13;       // below this the shot is over
const MAX_SPEED = 240;
const DRAG = 0.99925;       // per step
const POWER_MIN = 70;
const POWER_MAX = 152;

const REST_WALL = 0.88;
const REST_BREAK = 0.82;
const REST_BUMPER = 1.36;   // the energy source
const TARGET_BOOST = 1.045; // a chain sustains itself

const NUDGE_IMPULSE = 30;
const NUDGE_MIN_STEP = 48;  // 0.2 s of flight before a nudge is allowed

const PORTAL_COOLDOWN = 36;

// Near-miss assist. Without it a 0.2 degree aiming error — finer than a finger
// on glass can manage — threw away half the score, which makes the game feel
// like a slot machine. A target tugs at a ball that is already closing on it,
// so "almost" becomes "hit" and the skill moves from pixel-aiming to routing.
const GRACE = 2.7;          // reach of the tug beyond the surfaces
const PULL_ACCEL = 640;     // units / s^2 at point-blank range

export const CHAIN_CAP = 8;
// Chains pay super-linearly. A five-in-one-shot run is worth 22x a single
// target, not 5x: planning a route is the skill the game is about, so it has
// to dominate the scoreboard.
export const CHAIN_MULT = [1, 2, 4, 6, 9, 12, 16, 20];
export const CLEAR_BONUS_PER_SHOT = 350;

// ---------------------------------------------------------------- PRNG
// xorshift32. Integer only, identical in every JS engine.
export function makePRNG(seed) {
  let s = seed | 0;
  if (s === 0) s = 0x9e3779b9;
  return {
    next() {
      s ^= s << 13; s |= 0;
      s ^= s >>> 17;
      s ^= s << 5; s |= 0;
      return s >>> 0;
    },
    // float in [0,1) with 24 bits of entropy
    f() { return (this.next() >>> 8) / 16777216; },
    // integer in [lo, hi]
    i(lo, hi) { return lo + (this.next() % (hi - lo + 1)); },
    range(lo, hi) { return lo + (hi - lo) * this.f(); },
  };
}

// ---------------------------------------------------------------- geometry
function segClosest(ax, ay, bx, by, px, py) {
  const ex = bx - ax, ey = by - ay;
  const len2 = ex * ex + ey * ey;
  let t = 0;
  if (len2 > 0) {
    t = ((px - ax) * ex + (py - ay) * ey) / len2;
    if (t < 0) t = 0; else if (t > 1) t = 1;
  }
  return { x: ax + ex * t, y: ay + ey * t, t };
}

// Does segment P1->P2 intersect segment P3->P4? Used only by the generator.
function segHitsSeg(x1, y1, x2, y2, x3, y3, x4, y4) {
  const d = (x2 - x1) * (y4 - y3) - (y2 - y1) * (x4 - x3);
  if (d === 0) return false;
  const u = ((x3 - x1) * (y4 - y3) - (y3 - y1) * (x4 - x3)) / d;
  const v = ((x3 - x1) * (y2 - y1) - (y3 - y1) * (x2 - x1)) / d;
  return u > 0 && u < 1 && v > 0 && v < 1;
}

function segNearSeg(x1, y1, x2, y2, x3, y3, x4, y4, pad) {
  if (segHitsSeg(x1, y1, x2, y2, x3, y3, x4, y4)) return true;
  const p = pad * pad;
  let c = segClosest(x1, y1, x2, y2, x3, y3);
  if ((c.x - x3) * (c.x - x3) + (c.y - y3) * (c.y - y3) < p) return true;
  c = segClosest(x1, y1, x2, y2, x4, y4);
  if ((c.x - x4) * (c.x - x4) + (c.y - y4) * (c.y - y4) < p) return true;
  c = segClosest(x3, y3, x4, y4, x1, y1);
  if ((c.x - x1) * (c.x - x1) + (c.y - y1) * (c.y - y1) < p) return true;
  c = segClosest(x3, y3, x4, y4, x2, y2);
  if ((c.x - x2) * (c.x - x2) + (c.y - y2) * (c.y - y2) < p) return true;
  return false;
}

// ---------------------------------------------------------------- arena
// A mover is a segment that slides on a triangle wave. Its offset is a pure
// function of the step index, so it replays identically.
function moverOffset(m, step) {
  const period = m.period;              // steps for a full there-and-back
  let phase = (step + m.phase) % period;
  const half = period / 2;
  let k = phase < half ? phase / half : 2 - phase / half;   // 0..1..0
  return { x: m.dx * k, y: m.dy * k };
}

/** Renderer needs a mover's current position; same pure function as physics. */
export function moverOffsetAt(m, step) { return moverOffset(m, step); }

function moverVelocity(m, step) {
  const a = moverOffset(m, step);
  const b = moverOffset(m, step + 1);
  return { x: (b.x - a.x) / DT, y: (b.y - a.y) / DT };
}

const BORDER_PAD = 1.0;

function borderSegments() {
  const p = BORDER_PAD;
  return [
    { ax: p, ay: p, bx: ARENA_W - p, by: p, kind: 'wall' },                       // top
    { ax: ARENA_W - p, ay: p, bx: ARENA_W - p, by: ARENA_H - p, kind: 'wall' },   // right
    { ax: ARENA_W - p, ay: ARENA_H - p, bx: p, by: ARENA_H - p, kind: 'wall' },   // bottom
    { ax: p, ay: ARENA_H - p, bx: p, by: p, kind: 'wall' },                       // left
  ];
}

// Reachability by mirror images: a target hittable directly, or after one
// bounce off a side/top wall, is visible in a straight line from the launcher
// reflected across that wall. Cheap, exact for one bounce, and deterministic.
function mirrorPoints() {
  const L = BORDER_PAD, R = ARENA_W - BORDER_PAD, T = BORDER_PAD;
  return [
    { x: LAUNCH_X, y: LAUNCH_Y },          // direct
    { x: 2 * L - LAUNCH_X, y: LAUNCH_Y },  // via left wall
    { x: 2 * R - LAUNCH_X, y: LAUNCH_Y },  // via right wall
    { x: LAUNCH_X, y: 2 * T - LAUNCH_Y },  // via top wall
  ];
}

function lineBlocked(segs, x1, y1, x2, y2, skipIdx) {
  for (let i = 0; i < segs.length; i++) {
    if (i === skipIdx) continue;
    const s = segs[i];
    if (segHitsSeg(x1, y1, x2, y2, s.ax, s.ay, s.bx, s.by)) return true;
  }
  return false;
}

const LAUNCH_KEEPOUT = 13;   // nothing may sit on top of the launcher

function tooCloseToLaunch(x, y, r) {
  const dx = x - LAUNCH_X, dy = y - LAUNCH_Y;
  return dx * dx + dy * dy < (LAUNCH_KEEPOUT + r) * (LAUNCH_KEEPOUT + r);
}

/**
 * Build the arena for a seed. Pure function: same seed -> same arena, byte for
 * byte, on any engine. Difficulty rises with `level` (0..n) which the caller
 * derives from the seed's day index or match tier.
 */
export function generateArena(seed, level = 1) {
  const rng = makePRNG(seed ^ 0x5bf03635);
  const lv = level < 0 ? 0 : (level > 6 ? 6 : level);

  for (let attempt = 0; attempt < 24; attempt++) {
    const segs = borderSegments();
    const walls = [];
    const breakables = [];
    const targets = [];
    const bumpers = [];
    const portals = [];
    const movers = [];

    // --- the shield: one wall guaranteed to cast a shadow over the middle of
    // the board, so every arena has at least one target with no direct line.
    {
      const sy = rng.range(52, 104);
      const half = rng.range(13, 23);
      const sx = rng.range(16 + half, ARENA_W - 16 - half);
      const tilt = rng.range(-0.35, 0.35);
      const w = {
        ax: sx - half, ay: sy - half * tilt,
        bx: sx + half, by: sy + half * tilt,
        kind: 'wall', shield: true,
      };
      walls.push(w); segs.push(w);
    }

    // --- interior walls
    const nWalls = 2 + ((lv + attempt) % 3);
    for (let i = 0; i < nWalls; i++) {
      for (let tries = 0; tries < 20; tries++) {
        const cx = rng.range(14, ARENA_W - 14);
        const cy = rng.range(18, ARENA_H - 42);
        const half = rng.range(8, 20);
        // orientation from an integer choice -> no trig needed
        const o = rng.i(0, 3);
        let ax, ay, bx, by;
        if (o === 0) { ax = cx - half; ay = cy; bx = cx + half; by = cy; }
        else if (o === 1) { ax = cx; ay = cy - half; bx = cx; by = cy + half; }
        else if (o === 2) { ax = cx - half * 0.7; ay = cy - half * 0.7; bx = cx + half * 0.7; by = cy + half * 0.7; }
        else { ax = cx - half * 0.7; ay = cy + half * 0.7; bx = cx + half * 0.7; by = cy - half * 0.7; }
        if (ax < 6 || bx < 6 || ax > ARENA_W - 6 || bx > ARENA_W - 6) continue;
        if (ay < 6 || by < 6 || ay > ARENA_H - 24 || by > ARENA_H - 24) continue;
        if (tooCloseToLaunch(ax, ay, 0) || tooCloseToLaunch(bx, by, 0)) continue;
        let bad = false;
        for (const w of walls) {
          if (segNearSeg(ax, ay, bx, by, w.ax, w.ay, w.bx, w.by, 7)) { bad = true; break; }
        }
        if (bad) continue;
        const w = { ax, ay, bx, by, kind: 'wall' };
        walls.push(w); segs.push(w);
        break;
      }
    }

    // --- breakable blocks (score fodder, open new lines)
    const nBreak = lv >= 2 ? rng.i(1, 2 + (lv >= 4 ? 2 : 0)) : 0;
    for (let i = 0; i < nBreak; i++) {
      for (let tries = 0; tries < 20; tries++) {
        const cx = rng.range(12, ARENA_W - 12);
        const cy = rng.range(20, ARENA_H - 45);
        const half = rng.range(5, 9);
        const horiz = rng.i(0, 1) === 0;
        const ax = horiz ? cx - half : cx, ay = horiz ? cy : cy - half;
        const bx = horiz ? cx + half : cx, by = horiz ? cy : cy + half;
        if (tooCloseToLaunch(cx, cy, half)) continue;
        let bad = false;
        for (const s of segs) {
          if (s.kind === 'wall' && segNearSeg(ax, ay, bx, by, s.ax, s.ay, s.bx, s.by, 5)) { bad = true; break; }
        }
        if (bad) continue;
        const b = { ax, ay, bx, by, kind: 'break', hp: 1 };
        breakables.push(b); segs.push(b);
        break;
      }
    }

    // --- movers
    const nMovers = lv >= 3 ? rng.i(1, lv >= 5 ? 2 : 1) : 0;
    for (let i = 0; i < nMovers; i++) {
      for (let tries = 0; tries < 20; tries++) {
        const cx = rng.range(22, ARENA_W - 22);
        const cy = rng.range(26, ARENA_H - 50);
        const half = rng.range(7, 12);
        const horiz = rng.i(0, 1) === 0;
        const ax = horiz ? cx - half : cx, ay = horiz ? cy : cy - half;
        const bx = horiz ? cx + half : cx, by = horiz ? cy : cy + half;
        const travel = rng.range(12, 24);
        const m = {
          ax, ay, bx, by, kind: 'mover',
          dx: horiz ? 0 : travel, dy: horiz ? travel : 0,
          period: rng.i(260, 460) * 2,
          phase: rng.i(0, 500),
        };
        if (tooCloseToLaunch(cx, cy, half + travel)) continue;
        let bad = false;
        for (const s of segs) {
          if (segNearSeg(ax, ay, bx, by, s.ax, s.ay, s.bx, s.by, travel + 6)) { bad = true; break; }
        }
        if (bad) continue;
        movers.push(m); segs.push(m);
        break;
      }
    }

    // --- bumpers (pinball kickers: the chain engine)
    const nBump = 1 + (lv >= 2 ? rng.i(0, 2) : rng.i(0, 1));
    for (let i = 0; i < nBump; i++) {
      for (let tries = 0; tries < 24; tries++) {
        const r = rng.range(2.4, 3.4);
        const x = rng.range(10 + r, ARENA_W - 10 - r);
        const y = rng.range(22, ARENA_H - 46);
        if (tooCloseToLaunch(x, y, r)) continue;
        let bad = false;
        for (const s of segs) {
          const c = segClosest(s.ax, s.ay, s.bx, s.by, x, y);
          const d2 = (c.x - x) * (c.x - x) + (c.y - y) * (c.y - y);
          if (d2 < (r + BALL_R * 2 + 1.5) * (r + BALL_R * 2 + 1.5)) { bad = true; break; }
        }
        if (bad) continue;
        for (const b of bumpers) {
          const d2 = (b.x - x) * (b.x - x) + (b.y - y) * (b.y - y);
          if (d2 < (r + b.r + 9) * (r + b.r + 9)) { bad = true; break; }
        }
        if (bad) continue;
        bumpers.push({ x, y, r });
        break;
      }
    }

    // --- portal pair
    if (lv >= 4 && rng.i(0, 2) === 0) {
      const pr = 3.0;
      const cand = [];
      for (let tries = 0; tries < 40 && cand.length < 2; tries++) {
        const x = rng.range(9 + pr, ARENA_W - 9 - pr);
        const y = rng.range(16, ARENA_H - 40);
        if (tooCloseToLaunch(x, y, pr + 6)) continue;
        let bad = false;
        for (const s of segs) {
          const c = segClosest(s.ax, s.ay, s.bx, s.by, x, y);
          const d2 = (c.x - x) * (c.x - x) + (c.y - y) * (c.y - y);
          if (d2 < (pr + BALL_R * 2 + 2) * (pr + BALL_R * 2 + 2)) { bad = true; break; }
        }
        for (const b of bumpers) {
          const d2 = (b.x - x) * (b.x - x) + (b.y - y) * (b.y - y);
          if (d2 < (pr + b.r + 8) * (pr + b.r + 8)) bad = true;
        }
        if (bad) continue;
        if (cand.length === 1) {
          const d2 = (cand[0].x - x) * (cand[0].x - x) + (cand[0].y - y) * (cand[0].y - y);
          if (d2 < 45 * 45) continue;
        }
        cand.push({ x, y, r: pr });
      }
      if (cand.length === 2) { portals.push(cand[0], cand[1]); }
    }

    // --- targets
    const nTargets = 6 + (lv >= 1 ? rng.i(0, 1) : 0) + (lv >= 3 ? 1 : 0) + (lv >= 5 ? 1 : 0);
    const mirrors = mirrorPoints();
    let needBounce = 0;
    for (let i = 0; i < nTargets; i++) {
      // The first two slots insist on a shadowed spot. If 48 tries cannot find
      // one we take whatever fits rather than throwing the arena away.
      const insistShadow = i < 2;
      for (let tries = 0; tries < 60; tries++) {
        const r = rng.range(2.2, 3.5);
        const x = rng.range(8 + r, ARENA_W - 8 - r);
        const y = rng.range(12, ARENA_H - 38);
        if (tooCloseToLaunch(x, y, r)) continue;
        let bad = false;
        for (const s of segs) {
          const c = segClosest(s.ax, s.ay, s.bx, s.by, x, y);
          const d2 = (c.x - x) * (c.x - x) + (c.y - y) * (c.y - y);
          if (d2 < (r + BALL_R + 1.2) * (r + BALL_R + 1.2)) { bad = true; break; }
        }
        if (bad) continue;
        for (const b of bumpers) {
          const d2 = (b.x - x) * (b.x - x) + (b.y - y) * (b.y - y);
          if (d2 < (r + b.r + 2.5) * (r + b.r + 2.5)) { bad = true; break; }
        }
        if (bad) continue;
        for (const p of portals) {
          const d2 = (p.x - x) * (p.x - x) + (p.y - y) * (p.y - y);
          if (d2 < (r + p.r + 3) * (r + p.r + 3)) { bad = true; break; }
        }
        if (bad) continue;
        for (const t of targets) {
          const d2 = (t.x - x) * (t.x - x) + (t.y - y) * (t.y - y);
          if (d2 < (r + t.r + 4.5) * (r + t.r + 4.5)) { bad = true; break; }
        }
        if (bad) continue;

        // reachable within one bounce?
        let direct = false, viaBounce = false;
        for (let m = 0; m < mirrors.length; m++) {
          if (!lineBlocked(segs, mirrors[m].x, mirrors[m].y, x, y, -1)) {
            if (m === 0) direct = true; else viaBounce = true;
          }
        }
        if (!direct && !viaBounce) continue;
        if (insistShadow && direct && tries < 48) continue;
        if (!direct) needBounce++;

        // smaller target = more points
        targets.push({ x, y, r, value: 60 + ((3.6 - r) * 140 | 0) });
        break;
      }
    }

    // Quality gate: enough targets fitted, and the board is not a pushover.
    const enough = targets.length >= nTargets - 1 && targets.length >= 5;
    const interesting = lv === 0 || needBounce >= 1 || attempt >= 6;
    if (enough && interesting) {
      return {
        seed, level: lv, needBounce,
        segs, walls, breakables, movers, bumpers, portals, targets,
        maxScore: estimateMaxScore(targets),
      };
    }
  }

  // Fallback that can never fail: plain box with a ring of targets.
  const segs = borderSegments();
  const targets = [];
  for (let i = 0; i < 6; i++) {
    targets.push({ x: 18 + i * 12.8, y: 40 + (i % 2) * 22, r: 2.6, value: 160 });
  }
  return {
    seed, level: lv, segs, walls: [], breakables: [], movers: [],
    bumpers: [{ x: 50, y: 95, r: 3.0 }], portals: [], targets,
    maxScore: estimateMaxScore(targets),
  };
}

function estimateMaxScore(targets) {
  // Perfect run: every target in one chain, all shots left over.
  const sorted = targets.slice().sort((a, b) => a.value - b.value);
  let s = 0;
  for (let i = 0; i < sorted.length; i++) {
    const mult = CHAIN_MULT[(i + 1 > CHAIN_CAP ? CHAIN_CAP : i + 1) - 1];
    s += sorted[sorted.length - 1 - i].value * mult;
  }
  return s + CLEAR_BONUS_PER_SHOT * (MAX_SHOTS - 1);
}

// ---------------------------------------------------------------- shot input
/**
 * A shot as it travels over the wire: integers only.
 *   dx, dy : aim direction, any magnitude, normalised here (-10000..10000)
 *   p      : power 0..1000
 *   nf     : step index of the mid-flight nudge, or -1 for none
 *   ndx,ndy: nudge direction
 */
export function sanitizeShot(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const dx = raw.dx | 0, dy = raw.dy | 0;
  if (dx === 0 && dy === 0) return null;
  if (dx < -10000 || dx > 10000 || dy < -10000 || dy > 10000) return null;
  let p = raw.p | 0;
  if (p < 0) p = 0; if (p > 1000) p = 1000;
  let nf = raw.nf === undefined || raw.nf === null ? -1 : raw.nf | 0;
  if (nf < NUDGE_MIN_STEP || nf >= MAX_SHOT_STEPS) nf = -1;
  let ndx = raw.ndx | 0, ndy = raw.ndy | 0;
  if (nf >= 0 && ndx === 0 && ndy === 0) nf = -1;
  if (ndx < -10000 || ndx > 10000 || ndy < -10000 || ndy > 10000) nf = -1;
  return { dx, dy, p, nf, ndx, ndy };
}

function normalize(dx, dy) {
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len === 0) return { x: 0, y: -1 };
  return { x: dx / len, y: dy / len };
}

// ---------------------------------------------------------------- state
export function createState(arena) {
  return {
    arena,
    step: 0,                 // global step counter (movers depend on it)
    shotIndex: 0,
    score: 0,
    alive: arena.targets.map(() => true),
    breakAlive: arena.breakables.map(() => true),
    shots: [],               // per-shot results
    cleared: false,
  };
}

export function targetsLeft(st) {
  let n = 0;
  for (let i = 0; i < st.alive.length; i++) if (st.alive[i]) n++;
  return n;
}

/**
 * Start a shot. Returns the live ball; feed it to stepShot.
 *
 * Live play and server replay share this one stepper, which is the whole
 * point: a trajectory the player saw on their phone is reproduced exactly in
 * the Worker. Two implementations would drift and every honest player would
 * look like a cheat.
 */
export function beginShot(st, shot) {
  const dir = normalize(shot.dx, shot.dy);
  const power = POWER_MIN + (POWER_MAX - POWER_MIN) * (shot.p / 1000);
  return {
    shot,
    x: LAUNCH_X, y: LAUNCH_Y,
    vx: dir.x * power, vy: dir.y * power,
    portalCool: 0,
    nudged: false,
    chain: 0,
    shotScore: 0,
    hits: [],
    s: 0,
    done: null,
  };
}

/** The earliest step at which a live player may spend the nudge. */
export const NUDGE_FIRST_STEP = NUDGE_MIN_STEP;

/**
 * Arm the mid-flight nudge from live input. Writes into the shot record, so
 * the submitted shot replays identically on the server.
 */
export function armNudge(ball, ndx, ndy) {
  if (ball.nudged || ball.shot.nf >= 0 || ball.done) return false;
  if (ndx === 0 && ndy === 0) return false;
  const at = ball.s < NUDGE_MIN_STEP ? NUDGE_MIN_STEP : ball.s;
  if (at >= MAX_SHOT_STEPS) return false;
  ball.shot.nf = at;
  ball.shot.ndx = ndx | 0;
  ball.shot.ndy = ndy | 0;
  return true;
}

/**
 * Advance one physics step. Returns 'flying' | 'slow' | 'clear' | 'timeout'.
 * `events` (optional) collects impacts for sound and particles.
 */
export function stepShot(st, ball, events) {
  if (ball.done) return ball.done;
  const a = st.arena;
  const shot = ball.shot;
  let { x, y, vx, vy } = ball;
  const s = ball.s;
  {
    const gstep = st.step + s;
    let portalCool = ball.portalCool;
    let nudged = ball.nudged;
    let chain = ball.chain;
    let shotScore = ball.shotScore;
    const hits = ball.hits;

    // mid-flight nudge
    if (!nudged && shot.nf === s) {
      const nd = normalize(shot.ndx, shot.ndy);
      vx += nd.x * NUDGE_IMPULSE;
      vy += nd.y * NUDGE_IMPULSE;
      nudged = true;
      if (events) events.push({ t: 'nudge', s, x, y });
    }

    // drag + speed clamp
    vx *= DRAG; vy *= DRAG;
    let sp2 = vx * vx + vy * vy;
    if (sp2 > MAX_SPEED * MAX_SPEED) {
      const k = MAX_SPEED / Math.sqrt(sp2);
      vx *= k; vy *= k; sp2 = MAX_SPEED * MAX_SPEED;
    }

    x += vx * DT; y += vy * DT;

    // ---- segments
    for (let i = 0; i < a.segs.length; i++) {
      const sg = a.segs[i];
      if (sg.kind === 'break') {
        const bi = a.breakables.indexOf(sg);
        if (bi >= 0 && !st.breakAlive[bi]) continue;
      }
      let ax = sg.ax, ay = sg.ay, bx = sg.bx, by = sg.by;
      let mvx = 0, mvy = 0;
      if (sg.kind === 'mover') {
        const off = moverOffset(sg, gstep);
        ax += off.x; ay += off.y; bx += off.x; by += off.y;
        const mv = moverVelocity(sg, gstep);
        mvx = mv.x; mvy = mv.y;
      }
      const c = segClosest(ax, ay, bx, by, x, y);
      let nx = x - c.x, ny = y - c.y;
      let d2 = nx * nx + ny * ny;
      if (d2 >= BALL_R * BALL_R) continue;
      let d = Math.sqrt(d2);
      if (d < 0.0001) {
        // dead centre on the segment: use its perpendicular
        const ex = bx - ax, ey = by - ay;
        const el = Math.sqrt(ex * ex + ey * ey) || 1;
        nx = -ey / el; ny = ex / el; d = 0.0001;
      } else { nx /= d; ny /= d; }

      x += nx * (BALL_R - d + 0.002);
      y += ny * (BALL_R - d + 0.002);

      // reflect relative to the segment's own motion
      const rvx = vx - mvx, rvy = vy - mvy;
      const dot = rvx * nx + rvy * ny;
      if (dot < 0) {
        const rest = sg.kind === 'break' ? REST_BREAK : REST_WALL;
        const jx = rvx - 2 * dot * nx, jy = rvy - 2 * dot * ny;
        vx = jx * rest + mvx; vy = jy * rest + mvy;
        const imp = -dot;
        if (events) events.push({ t: sg.kind === 'break' ? 'break' : 'wall', s, x, y, imp });
        if (sg.kind === 'break') {
          const bi = a.breakables.indexOf(sg);
          if (bi >= 0) {
            st.breakAlive[bi] = false;
            shotScore += 40;
          }
        }
      }
    }

    // ---- bumpers
    for (let i = 0; i < a.bumpers.length; i++) {
      const b = a.bumpers[i];
      let nx = x - b.x, ny = y - b.y;
      const rr = BALL_R + b.r;
      let d2 = nx * nx + ny * ny;
      if (d2 >= rr * rr) continue;
      let d = Math.sqrt(d2);
      if (d < 0.0001) { nx = 0; ny = -1; d = 0.0001; } else { nx /= d; ny /= d; }
      x += nx * (rr - d + 0.002); y += ny * (rr - d + 0.002);
      const dot = vx * nx + vy * ny;
      if (dot < 0) {
        vx = (vx - 2 * dot * nx) * REST_BUMPER;
        vy = (vy - 2 * dot * ny) * REST_BUMPER;
        shotScore += 25;
        if (events) events.push({ t: 'bumper', s, x, y, i, imp: -dot });
      }
    }

    // ---- portals
    if (portalCool > 0) portalCool--;
    else if (a.portals.length === 2) {
      for (let i = 0; i < 2; i++) {
        const p = a.portals[i], q = a.portals[1 - i];
        const nx = x - p.x, ny = y - p.y;
        if (nx * nx + ny * ny < p.r * p.r) {
          const sp = Math.sqrt(vx * vx + vy * vy) || 1;
          x = q.x + (vx / sp) * (q.r + BALL_R + 0.3);
          y = q.y + (vy / sp) * (q.r + BALL_R + 0.3);
          portalCool = PORTAL_COOLDOWN;
          if (events) events.push({ t: 'portal', s, x, y, i });
          break;
        }
      }
    }

    // ---- target attraction (near-miss assist)
    for (let i = 0; i < a.targets.length; i++) {
      if (!st.alive[i]) continue;
      const t = a.targets[i];
      const tx = t.x - x, ty = t.y - y;
      const rr = BALL_R + t.r;
      const d2 = tx * tx + ty * ty;
      const reach = rr + GRACE;
      if (d2 >= reach * reach || d2 <= 0.0001) continue;
      const d = Math.sqrt(d2);
      const ux = tx / d, uy = ty / d;
      if (vx * ux + vy * uy <= 0) continue;        // only while closing in
      let k = 1 - (d - rr) / GRACE;
      if (k > 1) k = 1; else if (k < 0) k = 0;
      vx += ux * PULL_ACCEL * k * DT;
      vy += uy * PULL_ACCEL * k * DT;
    }

    // ---- targets (pass-through, chain multiplier)
    for (let i = 0; i < a.targets.length; i++) {
      if (!st.alive[i]) continue;
      const t = a.targets[i];
      const nx = x - t.x, ny = y - t.y;
      const rr = BALL_R + t.r;
      if (nx * nx + ny * ny >= rr * rr) continue;
      st.alive[i] = false;
      chain++;
      const mult = CHAIN_MULT[(chain > CHAIN_CAP ? CHAIN_CAP : chain) - 1];
      const gained = t.value * mult;
      shotScore += gained;
      hits.push({ i, mult, gained, step: s });
      vx *= TARGET_BOOST; vy *= TARGET_BOOST;
      if (events) events.push({ t: 'target', s, x: t.x, y: t.y, i, mult, gained });
    }

    // ---- write the live state back
    ball.x = x; ball.y = y; ball.vx = vx; ball.vy = vy;
    ball.portalCool = portalCool;
    ball.nudged = nudged;
    ball.chain = chain;
    ball.shotScore = shotScore;
    ball.s = s + 1;

    // ---- end conditions
    if (sp2 < MIN_SPEED * MIN_SPEED) { ball.done = 'slow'; return 'slow'; }
    if (targetsLeft(st) === 0) { ball.done = 'clear'; return 'clear'; }
    if (ball.s >= MAX_SHOT_STEPS) { ball.done = 'timeout'; return 'timeout'; }
    return 'flying';
  }
}

/** Close out a finished shot and fold its score into the run. */
export function endShot(st, ball) {
  st.step += ball.s;
  return finishShot(st, ball.shot, ball.shotScore, ball.hits, ball.chain, ball.s,
    ball.done || 'timeout');
}

/**
 * Simulate one shot to completion. This is the server's path and the
 * reference for everything: it is nothing but beginShot + stepShot in a loop.
 * `trace` (optional) receives [x,y,...] samples for ghost replay.
 */
export function simulateShot(st, shot, trace, events) {
  const ball = beginShot(st, shot);
  for (;;) {
    const r = stepShot(st, ball, events);
    if (trace && (ball.s & 1) === 0) trace.push(ball.x, ball.y);
    if (r !== 'flying') break;
  }
  return endShot(st, ball);
}

function finishShot(st, shot, shotScore, hits, chain, steps, reason) {
  st.shotIndex++;
  st.score += shotScore;
  const res = { shot, score: shotScore, hits, chain, steps, reason };
  st.shots.push(res);
  if (targetsLeft(st) === 0 && !st.cleared) {
    st.cleared = true;
    const left = MAX_SHOTS - st.shotIndex;
    const bonus = CLEAR_BONUS_PER_SHOT * (left < 0 ? 0 : left);
    st.score += bonus;
    res.clearBonus = bonus;
  }
  return res;
}

// ---------------------------------------------------------------- full run
/**
 * Replay a whole run from its inputs. This is the authoritative scorer: the
 * Worker calls it with the client's shots and compares the result.
 * Returns null if the input list is malformed.
 */
export function runMatch(seed, level, rawShots) {
  if (!Array.isArray(rawShots) || rawShots.length === 0 || rawShots.length > MAX_SHOTS) return null;
  const shots = [];
  for (const r of rawShots) {
    const s = sanitizeShot(r);
    if (!s) return null;
    shots.push(s);
  }
  const arena = generateArena(seed, level);
  const st = createState(arena);
  for (const s of shots) {
    if (targetsLeft(st) === 0) break;
    simulateShot(st, s, null, null);
  }
  return {
    score: st.score,
    cleared: st.cleared,
    shotsUsed: st.shotIndex,
    targetsLeft: targetsLeft(st),
    perShot: st.shots.map(r => ({ score: r.score, chain: r.chain, steps: r.steps })),
    maxScore: arena.maxScore,
  };
}
