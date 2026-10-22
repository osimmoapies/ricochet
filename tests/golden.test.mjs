// node tests/golden.test.mjs        -> check
// node tests/golden.test.mjs --save -> re-bless after a deliberate change
//
// The leaderboard is only meaningful while the physics stays frozen: change a
// restitution constant and every stored score becomes a different game. This
// test pins 150 runs by hash. If it fails you either broke the sim, or you
// changed it on purpose and every published score is now void.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { generateArena, runMatch, makePRNG } from '../shared/sim.js';

const FILE = new URL('./golden.json', import.meta.url);

function hash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

function build() {
  const rng = makePRNG(20261022);
  const out = [];
  for (let i = 0; i < 150; i++) {
    const seed = rng.next() | 0;
    const lv = i % 7;
    const shots = [];
    for (let s = 0; s < 5; s++) {
      shots.push({
        dx: rng.i(-10000, 10000), dy: rng.i(-10000, -200), p: rng.i(0, 1000),
        nf: rng.i(0, 2) === 0 ? rng.i(48, 1200) : -1,
        ndx: rng.i(-10000, 10000), ndy: rng.i(-10000, 10000),
      });
    }
    const r = runMatch(seed, lv, shots);
    const a = generateArena(seed, lv);
    out.push({
      seed, lv,
      arena: hash(JSON.stringify(a)),
      run: hash(JSON.stringify(r)),
      score: r.score,
    });
  }
  return out;
}

const fresh = build();

if (process.argv.includes('--save') || !existsSync(FILE)) {
  writeFileSync(FILE, JSON.stringify(fresh, null, 0));
  console.log(`blessed ${fresh.length} golden runs`);
  process.exit(0);
}

const old = JSON.parse(readFileSync(FILE, 'utf8'));
let bad = 0;
if (old.length !== fresh.length) {
  console.log(`golden file has ${old.length} entries, test builds ${fresh.length}`);
  process.exit(1);
}
for (let i = 0; i < old.length; i++) {
  const a = old[i], b = fresh[i];
  if (a.arena !== b.arena || a.run !== b.run || a.score !== b.score) {
    if (bad < 6) {
      console.log(`  drift at seed ${a.seed} lv${a.lv}: score ${a.score} -> ${b.score}` +
        (a.arena !== b.arena ? '  [arena changed]' : '') +
        (a.run !== b.run && a.arena === b.arena ? '  [physics changed]' : ''));
    }
    bad++;
  }
}
if (bad) {
  console.log(`\nFAIL: ${bad}/${old.length} golden runs drifted.`);
  console.log('If the change was deliberate: node tests/golden.test.mjs --save');
  console.log('and reset the leaderboards, because the old scores are from another game.');
  process.exit(1);
}
console.log(`golden: ${old.length}/${old.length} runs reproduce exactly`);
