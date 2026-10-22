// Per-user rate limits, counted in D1.
//
// Fixed windows, one row per user per bucket per window: a single upsert with
// RETURNING, which is cheaper than any read-then-write and needs no KV. The
// free tier is 100k requests a day for the whole game, so a single phone
// hammering /run has to be stopped early.
//
// Fail closed on purpose: if the counter cannot be written we answer 429. A
// broken limiter that lets everything through is worse than a busy signal.

export const LIMITS = {
  run: { max: 60, windowMs: 3600000 },       // 60 runs/hour
  duel: { max: 30, windowMs: 86400000 },     // 30 duel creations/day
};

export function windowStart(bucket, nowMs) {
  const lim = Object.prototype.hasOwnProperty.call(LIMITS, bucket) ? LIMITS[bucket] : null;
  if (!lim) return null;
  return Math.floor(nowMs / lim.windowMs) * lim.windowMs;
}

/**
 * Count one event. `db` is a D1 database (or anything with the same
 * prepare/bind/first shape, which is what the tests use).
 */
export async function hit(db, userId, bucket, nowMs) {
  const lim = Object.prototype.hasOwnProperty.call(LIMITS, bucket) ? LIMITS[bucket] : null;
  if (!lim) return { ok: false, error: 'rate_limited', retryAfter: 60 };
  const ws = windowStart(bucket, nowMs);
  const retryAfter = Math.ceil((ws + lim.windowMs - nowMs) / 1000) || 1;
  try {
    const row = await db.prepare(
      `INSERT INTO rates (user_id, bucket, window_start, count) VALUES (?1, ?2, ?3, 1)
       ON CONFLICT(user_id, bucket, window_start) DO UPDATE SET count = count + 1
       RETURNING count`,
    ).bind(userId, bucket, ws).first();
    const count = row && Number.isFinite(row.count) ? row.count : lim.max + 1;
    if (count > lim.max) return { ok: false, error: 'rate_limited', retryAfter };
    return { ok: true, count, left: lim.max - count };
  } catch (e) {
    return { ok: false, error: 'rate_limited', retryAfter: 60 };
  }
}
