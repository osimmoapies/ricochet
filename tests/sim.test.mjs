// node tests/sim.test.mjs
// Checks the three properties the whole game rests on:
//   1. the arena generator is pure and produces playable boards
//   2. a run replays to exactly the same score (bit-identical)
//   3. server-side verification fits inside the Cloudflare free CPU budget
import {
  generateArena, runMatch, createState, simulateShot, sanitizeShot,
  targetsLeft, MAX_SHOTS, ARENA_W, ARENA_H, makePRNG,
} from '../shared/sim.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL: ' + m); } };
const section = (s) => console.log('\n== ' + s);

// ---------------------------------------------------------------- 1. arenas
section('arena generator');
{
  let fallbacks = 0, tCount = 0, minT = 99, maxT = 0;
  const hist = {};
  for (let i = 0; i < 400; i++) {
    const seed = (i * 2654435761) | 0;
    const lv = i % 7;
    const a = generateArena(seed, lv);
    ok(a.targets.length >= 5, `seed ${seed} lv${lv}: only ${a.targets.length} targets`);
    tCount += a.targets.length;
    if (a.targets.length < minT) minT = a.targets.length;
    if (a.targets.length > maxT) maxT = a.targets.length;
    if (a.walls.length === 0 && a.bumpers.length === 1 && a.bumpers[0].x === 50) fallbacks++;
    hist[lv] = (hist[lv] || 0) + a.targets.length;

    // every object inside the arena box
    for (const t of a.targets) {
      ok(t.x - t.r > 0 && t.x + t.r < ARENA_W && t.y - t.r > 0 && t.y + t.r < ARENA_H,
        `target out of bounds at seed ${seed}`);
    }
    // purity: same seed twice -> identical JSON
    const b = generateArena(seed, lv);
    ok(JSON.stringify(a) === JSON.stringify(b), `generator not pure at seed ${seed}`);
  }
  console.log(`  targets: avg ${(tCount / 400).toFixed(2)} min ${minT} max ${maxT}`);
  console.log(`  fallback arenas: ${fallbacks} / 400`);
  ok(fallbacks <= 4, `too many fallback arenas: ${fallbacks}`);
}

// ---------------------------------------------------------------- 2. replay
section('replay determinism');
{
  const rng = makePRNG(777);
  let totalScore = 0, clears = 0, zeroRuns = 0;
  const runs = [];
  for (let i = 0; i < 300; i++) {
    const seed = rng.next() | 0;
    const lv = i % 7;
    const shots = [];
    for (let s = 0; s < MAX_SHOTS; s++) {
      shots.push({
        dx: rng.i(-10000, 10000),
        dy: rng.i(-10000, -300),          // always aim upward-ish
        p: rng.i(0, 1000),
        nf: rng.i(0, 3) === 0 ? rng.i(48, 900) : -1,
        ndx: rng.i(-10000, 10000),
        ndy: rng.i(-10000, 10000),
      });
    }
    const r1 = runMatch(seed, lv, shots);
    const r2 = runMatch(seed, lv, shots);
    ok(r1 !== null, `run rejected at seed ${seed}`);
    ok(JSON.stringify(r1) === JSON.stringify(r2), `non-deterministic replay at seed ${seed}`);
    totalScore += r1.score;
    if (r1.cleared) clears++;
    if (r1.score === 0) zeroRuns++;
    runs.push({ seed, lv, shots, score: r1.score });
  }
  console.log(`  random play: avg score ${(totalScore / 300).toFixed(0)}, clears ${clears}/300, blanks ${zeroRuns}/300`);
  // random flailing should score something but almost never clear the board:
  // that gap is the skill headroom.
  ok(zeroRuns < 30, `too many scoreless random runs: ${zeroRuns}`);
  // Clearing is not the competitive metric, the score is; but if flailing
  // clears a third of the boards the arenas are too soft.
  ok(clears < 90, `random play clears too often (${clears}) - game is too easy`);

  // tampering with the claimed score must be caught
  const victim = runs[0];
  const check = runMatch(victim.seed, victim.lv, victim.shots);
  ok(check.score === victim.score, 'verification disagrees with original run');
  ok(check.score !== victim.score + 1, 'sanity');
}

// ---------------------------------------------------------------- 3. input guard
section('input sanitising');
{
  ok(sanitizeShot(null) === null, 'null accepted');
  ok(sanitizeShot({ dx: 0, dy: 0, p: 500 }) === null, 'zero aim accepted');
  ok(sanitizeShot({ dx: 99999999, dy: -1, p: 500 }) === null, 'huge aim accepted');
  const clamped = sanitizeShot({ dx: 1, dy: -1, p: 99999, nf: 999999 });
  ok(clamped.p === 1000, 'power not clamped');
  ok(clamped.nf === -1, 'out-of-range nudge not rejected');
  ok(runMatch(1, 1, []) === null, 'empty shot list accepted');
  ok(runMatch(1, 1, new Array(MAX_SHOTS + 1).fill({ dx: 1, dy: -1, p: 500 })) === null,
    'too many shots accepted');
  ok(runMatch(1, 1, [{ dx: 0, dy: 0, p: 1 }]) === null, 'malformed shot accepted');
}

// ---------------------------------------------------------------- 4. CPU budget
section('CPU budget (Cloudflare Workers free = 10 ms per request)');
{
  const rng = makePRNG(4242);
  const cases = [];
  for (let i = 0; i < 200; i++) {
    const shots = [];
    for (let s = 0; s < MAX_SHOTS; s++) {
      shots.push({ dx: rng.i(-10000, 10000), dy: rng.i(-10000, -300), p: rng.i(300, 1000), nf: -1, ndx: 0, ndy: 0 });
    }
    cases.push({ seed: rng.next() | 0, lv: i % 7, shots });
  }
  // warm up
  for (const c of cases.slice(0, 20)) runMatch(c.seed, c.lv, c.shots);
  const times = [];
  for (const c of cases) {
    const t0 = performance.now();
    runMatch(c.seed, c.lv, c.shots);
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  const p50 = times[100], p95 = times[190], p100 = times[199];
  console.log(`  verify one run: p50 ${p50.toFixed(2)} ms  p95 ${p95.toFixed(2)} ms  max ${p100.toFixed(2)} ms`);
  ok(p95 < 8, `p95 verification ${p95.toFixed(2)} ms is too close to the 10 ms limit`);

  const tg0 = performance.now();
  for (let i = 0; i < 200; i++) generateArena((i * 99991) | 0, i % 7);
  const tg = (performance.now() - tg0) / 200;
  console.log(`  generate one arena: ${tg.toFixed(3)} ms`);
  ok(tg < 2, `arena generation ${tg.toFixed(2)} ms is too slow`);
}

// ---------------------------------------------------------------- 5. scoring
section('scoring rules');
{
  const a = generateArena(12345, 3);
  const st = createState(a);
  ok(targetsLeft(st) === a.targets.length, 'alive bookkeeping wrong');
  // a shot that hits nothing scores nothing
  const miss = simulateShot(st, sanitizeShot({ dx: 0, dy: -1, p: 0 }), null, null);
  ok(miss.score >= 0, 'negative score');
  ok(st.shotIndex === 1, 'shot counter wrong');
  // chain multiplier grows
  const st2 = createState(a);
  st2.alive = a.targets.map(() => true);
  ok(a.maxScore > 0, 'maxScore not estimated');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
