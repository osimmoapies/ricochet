// The daily arena.
//
// Everyone in the world plays the same board each day, which is what makes a
// leaderboard mean anything and what makes "I got 4820, beat it" a real
// challenge instead of a boast about a private level. Derived from the date
// with integer math only, so the client can compute it offline and still
// agree with the server.
export const DAY_MS = 86400000;

/** Days since 1970-01-01 in UTC. */
export function dayIndex(ms) {
  return Math.floor((ms === undefined ? Date.now() : ms) / DAY_MS);
}

export function dayKey(dayIdx) {
  const d = new Date(dayIdx * DAY_MS);
  const m = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  return `${d.getUTCFullYear()}-${m < 10 ? '0' : ''}${m}-${day < 10 ? '0' : ''}${day}`;
}

/** A stable, well-spread seed per day. */
export function dailySeed(dayIdx) {
  let h = (dayIdx | 0) ^ 0x9e3779b9;
  h = (h ^ (h >>> 16)) >>> 0;
  h = (h * 0x85ebca6b) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  h = (h * 0xc2b2ae35) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h | 0;
}

/** Difficulty walks through the seven tiers so the week never feels the same. */
export function dailyLevel(dayIdx) {
  const m = ((dayIdx % 7) + 7) % 7;
  return m;
}

export function daily(ms) {
  const idx = dayIndex(ms);
  return { dayIdx: idx, date: dayKey(idx), seed: dailySeed(idx), level: dailyLevel(idx) };
}

/** Seed for a one-off practice or duel board. */
export function randomSeed() {
  const a = (Date.now() & 0x7fffffff);
  const b = Math.floor(Math.random() * 0x7fffffff);
  let h = (a ^ (b * 0x9e3779b9)) >>> 0;
  h = (h ^ (h >>> 15)) >>> 0;
  h = (h * 0x2545f491) >>> 0;
  return h | 0;
}
