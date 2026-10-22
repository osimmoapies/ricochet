// node tools/balance.mjs [arenas]
//
// The only question that matters for a 1v1 duel: does the better player win?
//
// Two simulated humans play the same board. Each plans (searches a fan of
// shots, the way a person eyeballs a line), executes with a shaky finger, and
// may spend the one mid-flight nudge. The strong player plans deeper, reads
// the flight better and shakes less.
//
//   WIN RATE  < 60%  slot machine, nobody respects a loss
//             > 90%  a newcomer never wins once and leaves
//             70-85% the band we want
//   HEADROOM  strong vs flailing: the ceiling there is to climb
//   NUDGE GAIN how much the mid-flight correction is worth — the skill channel
//              that survives a shaky finger
import { generateArena, createState, simulateShot, sanitizeShot, targetsLeft, MAX_SHOTS, MAX_SHOT_STEPS }
  from '../shared/sim.js';

const N_ARENAS = Number(process.argv[2] || 24);
const DUELS_PER_ARENA = 4;

let seedState = 20261022;
const rnd = () => {
  seedState = (seedState * 1103515245 + 12345) & 0x7fffffff;
  return seedState / 0x7fffffff;
};
const gauss = () => {
  let u = 0, v = 0;
  while (u === 0) u = rnd();
  while (v === 0) v = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};
const DEG = Math.PI / 180;

function aimInt(angle) {
  return { dx: Math.round(Math.sin(angle) * 10000), dy: Math.round(-Math.cos(angle) * 10000) };
}
function cloneState(st) {
  return {
    arena: st.arena, step: st.step, shotIndex: st.shotIndex, score: st.score,
    alive: st.alive.slice(), breakAlive: st.breakAlive.slice(), shots: [], cleared: st.cleared,
  };
}
function trial(st, shot) {
  const c = cloneState(st);
  simulateShot(c, shot, null, null);
  return c;
}

const DIRS8 = [];
for (let i = 0; i < 8; i++) {
  const a = (i * 2 * Math.PI) / 8;
  DIRS8.push({ dx: Math.round(Math.cos(a) * 10000), dy: Math.round(Math.sin(a) * 10000) });
}

/**
 * A simulated person.
 *   angles/powers : how thoroughly they plan the launch
 *   jitterDeg     : how badly the finger betrays the plan
 *   nudgeFrames   : how many moments mid-flight they consider
 *   nudgeDirs     : how many directions they weigh
 *   nudgeJitterDeg: error on the nudge direction
 *   nudgeUse      : chance they remember to use it at all
 */
function play(arena, skill, opts = {}) {
  let st = createState(arena);
  let nudgeGain = 0;
  for (let s = 0; s < MAX_SHOTS && targetsLeft(st) > 0; s++) {
    // --- plan the launch
    let best = null;
    for (let i = 0; i < skill.angles; i++) {
      const angle = skill.angles === 1 ? 0 : -1.3 + (2.6 * i) / (skill.angles - 1);
      const a = aimInt(angle);
      for (let j = 0; j < skill.powers; j++) {
        const p = skill.powers === 1 ? 600 : Math.round((1000 * j) / (skill.powers - 1));
        const after = trial(st, sanitizeShot({ dx: a.dx, dy: a.dy, p, nf: -1, ndx: 0, ndy: 0 }));
        if (!best || after.score > best.score) best = { score: after.score, angle, p };
      }
    }
    if (!best) break;

    // --- execute with a shaky hand
    const angle = best.angle + gauss() * skill.jitterDeg * DEG;
    let p = best.p + gauss() * skill.powerJitter * 1000;
    if (p < 0) p = 0; if (p > 1000) p = 1000;
    p = Math.round(p);
    const a = aimInt(angle);
    const launched = { dx: a.dx, dy: a.dy, p, nf: -1, ndx: 0, ndy: 0 };
    const plain = trial(st, sanitizeShot(launched));

    // --- read the flight and spend the nudge
    let chosen = plain;
    let chosenShot = launched;
    if (!opts.noNudge && skill.nudgeFrames > 0 && rnd() < skill.nudgeUse) {
      let bestN = null;
      for (let f = 0; f < skill.nudgeFrames; f++) {
        const frame = 60 + Math.round((f * (MAX_SHOT_STEPS * 0.45)) / skill.nudgeFrames);
        for (let d = 0; d < skill.nudgeDirs; d++) {
          const di = DIRS8[Math.round((d * 8) / skill.nudgeDirs) % 8];
          const cand = { ...launched, nf: frame, ndx: di.dx, ndy: di.dy };
          const after = trial(st, sanitizeShot(cand));
          if (!bestN || after.score > bestN.score) bestN = { score: after.score, shot: cand, frame, di };
        }
      }
      if (bestN && bestN.score > plain.score) {
        // the intention is right, the execution is late and off-axis
        const jd = Math.atan2(bestN.di.dy, bestN.di.dx) + gauss() * skill.nudgeJitterDeg * DEG;
        const frame = Math.max(48, bestN.frame + Math.round(gauss() * skill.nudgeLagSteps));
        const real = {
          ...launched, nf: frame,
          ndx: Math.round(Math.cos(jd) * 10000), ndy: Math.round(Math.sin(jd) * 10000),
        };
        const after = trial(st, sanitizeShot(real));
        if (after.score > plain.score) {
          nudgeGain += after.score - plain.score;
          chosen = after; chosenShot = real;
        }
      }
    }
    st = chosen;
    st.shots = [];
  }
  return { score: st.score, nudgeGain };
}

const STRONG = {
  angles: 44, powers: 4, jitterDeg: 0.6, powerJitter: 0.03,
  nudgeFrames: 7, nudgeDirs: 8, nudgeJitterDeg: 10, nudgeLagSteps: 6, nudgeUse: 0.95,
};
const WEAK = {
  angles: 9, powers: 3, jitterDeg: 3.0, powerJitter: 0.12,
  nudgeFrames: 2, nudgeDirs: 4, nudgeJitterDeg: 35, nudgeLagSteps: 24, nudgeUse: 0.5,
};
const FLAIL = {
  angles: 1, powers: 1, jitterDeg: 60, powerJitter: 0.5,
  nudgeFrames: 0, nudgeDirs: 0, nudgeJitterDeg: 90, nudgeLagSteps: 60, nudgeUse: 0,
};

let wins = 0, draws = 0, duels = 0;
let sumStrong = 0, sumWeak = 0, sumFlail = 0, nFlail = 0;
let sumStrongNoNudge = 0, gainStrong = 0, gainWeak = 0;
let blowouts = 0;

for (let n = 0; n < N_ARENAS; n++) {
  const arena = generateArena((n * 2654435761 + 7) | 0, n % 7);
  for (let d = 0; d < DUELS_PER_ARENA; d++) {
    const a = play(arena, STRONG);
    const b = play(arena, WEAK);
    sumStrong += a.score; sumWeak += b.score; duels++;
    gainStrong += a.nudgeGain; gainWeak += b.nudgeGain;
    if (a.score > b.score) wins++; else if (a.score === b.score) draws++;
    if (b.score > 0 && a.score / b.score > 3) blowouts++;
  }
  sumStrongNoNudge += play(arena, STRONG, { noNudge: true }).score;
  sumFlail += play(arena, FLAIL).score; nFlail++;
}

const pct = (x) => (x * 100).toFixed(1) + '%';
const avgStrong = sumStrong / duels, avgWeak = sumWeak / duels, avgFlail = sumFlail / nFlail;
console.log(`arenas ${N_ARENAS}, duels ${duels}`);
console.log(`avg score   strong ${avgStrong.toFixed(0)} | weak ${avgWeak.toFixed(0)} | flailing ${avgFlail.toFixed(0)}`);
console.log(`WIN RATE    strong beats weak ${pct(wins / duels)}   (draws ${draws})  <- want 70-85%`);
console.log(`HEADROOM    x${(avgStrong / avgFlail).toFixed(2)}  <- want >= 2.0`);
console.log(`SKILL GAP   strong / weak = x${(avgStrong / avgWeak).toFixed(2)}`);
console.log(`NUDGE GAIN  strong +${pct(gainStrong / duels / avgStrong)} of score | weak +${pct(gainWeak / duels / avgWeak)}`);
console.log(`            strong without nudge ${(sumStrongNoNudge / nFlail).toFixed(0)} vs with ${avgStrong.toFixed(0)}`);
console.log(`BLOWOUTS    strong wins by >3x in ${pct(blowouts / duels)}  <- want <= 25%`);
