// D1 access. Every query the Worker makes lives here, so the index list in
// schema.sql can be read against one file.
//
// Two conventions worth knowing:
//   * timestamps are milliseconds (the client compares seasonUntil to Date.now)
//   * `owned` is a JSON array of skin ids, read and written as text

export function profileOf(row) {
  let owned = [];
  if (row && row.owned) {
    try {
      const v = JSON.parse(row.owned);
      if (Array.isArray(v)) owned = v.filter((s) => typeof s === 'string').slice(0, 64);
    } catch (e) { owned = []; }
  }
  return {
    owned,
    skin: (row && row.skin) || 'default',
    seasonUntil: (row && row.season_until) || 0,
    stats: {
      bestScore: (row && row.best_score) || 0,
      clears: (row && row.clears) || 0,
      duelWins: (row && row.duel_wins) || 0,
      runs: (row && row.runs) || 0,
    },
  };
}

const USER_COLS = 'id, name, skin, owned, season_until, best_score, clears, duel_wins, runs';

/** Auth does both halves of its work in one round trip. */
export async function upsertUserAndTop(db, user, nowMs, dayIdx) {
  const up = db.prepare(
    `INSERT INTO users (id, name, created_at, seen_at) VALUES (?1, ?2, ?3, ?3)
     ON CONFLICT(id) DO UPDATE SET name = ?2, seen_at = ?3
     RETURNING ${USER_COLS}`,
  ).bind(user.id, user.name, nowMs);
  const top = db.prepare(
    `SELECT u.name AS name, r.score AS score
       FROM runs r JOIN users u ON u.id = r.user_id
      WHERE r.day_idx = ?1 AND r.mode = 'daily'
      ORDER BY r.score DESC LIMIT 1`,
  ).bind(dayIdx);
  const res = await db.batch([up, top]);
  const row = (res[0].results && res[0].results[0]) || null;
  const t = (res[1].results && res[1].results[0]) || null;
  return { row, top: t ? { name: t.name, score: t.score | 0 } : { name: '', score: 0 } };
}

export function getUser(db, id) {
  return db.prepare(`SELECT ${USER_COLS} FROM users WHERE id = ?1`).bind(id).first();
}

/** A user row is created at auth; this is the safety net for a lost row. */
export async function ensureUser(db, user, nowMs) {
  const row = await getUser(db, user.id);
  if (row) return row;
  return db.prepare(
    `INSERT INTO users (id, name, created_at, seen_at) VALUES (?1, ?2, ?3, ?3)
     ON CONFLICT(id) DO UPDATE SET seen_at = ?3
     RETURNING ${USER_COLS}`,
  ).bind(user.id, user.name, nowMs).first();
}

export function setSkin(db, id, skin) {
  return db.prepare('UPDATE users SET skin = ?2 WHERE id = ?1').bind(id, skin).run();
}

// ---------------------------------------------------------------- runs
export async function recordRun(db, userId, r, shotsJson, nowMs) {
  await db.batch([
    db.prepare(
      `INSERT INTO runs (user_id, day_idx, mode, duel_id, seed, level, score, cleared, shots, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
    ).bind(userId, r.dayIdx, r.mode, r.duelId || null, r.seed, r.level,
      r.score, r.cleared ? 1 : 0, shotsJson, nowMs),
    db.prepare(
      `UPDATE users SET runs = runs + 1,
                        clears = clears + ?2,
                        best_score = CASE WHEN ?3 > best_score THEN ?3 ELSE best_score END,
                        seen_at = ?4
        WHERE id = ?1`,
    ).bind(userId, r.cleared ? 1 : 0, r.score, nowMs),
  ]);
}

/**
 * Place on today's board. Anyone whose best today beats us has at least one
 * run above our score, so counting distinct users with a higher run is the
 * same answer as grouping first — and it rides the (day_idx, score) index.
 */
export async function rankToday(db, dayIdx, score) {
  const row = await db.prepare(
    `SELECT COUNT(DISTINCT user_id) AS n FROM runs
      WHERE day_idx = ?1 AND mode = 'daily' AND score > ?2`,
  ).bind(dayIdx, score).first();
  return ((row && row.n) || 0) + 1;
}

export async function leaderboard(db, scope, dayIdx) {
  const stmt = scope === 'all'
    ? db.prepare(
      `SELECT id, name, best_score AS score FROM users
        WHERE best_score > 0 ORDER BY score DESC, id ASC LIMIT 100`)
    : db.prepare(
      `SELECT r.user_id AS id, u.name AS name, MAX(r.score) AS score
         FROM runs r JOIN users u ON u.id = r.user_id
        WHERE r.day_idx = ?1 AND r.mode = 'daily'
        GROUP BY r.user_id
        ORDER BY score DESC, r.user_id ASC LIMIT 100`).bind(dayIdx);
  const res = await stmt.all();
  const rows = (res && res.results) || [];
  return rows.map((row, i) => ({
    id: row.id, name: row.name || 'Player', score: row.score | 0, rank: i + 1,
  }));
}

// ---------------------------------------------------------------- duels
export function insertDuel(db, id, userId, name, d, shotsJson, nowMs) {
  return db.prepare(
    `INSERT INTO duels (id, user_id, name, seed, level, shots, score, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
  ).bind(id, userId, name, d.seed, d.level, shotsJson, d.score, nowMs).run();
}

export function getDuel(db, id) {
  return db.prepare(
    `SELECT id, user_id, name, seed, level, shots, score, answers, best_answer
       FROM duels WHERE id = ?1`,
  ).bind(id).first();
}

/** How many times has this player already answered this duel? */
export async function duelAttempts(db, duelId, userId) {
  const row = await db.prepare(
    'SELECT COUNT(*) AS n FROM runs WHERE duel_id = ?1 AND user_id = ?2',
  ).bind(duelId, userId).first();
  return (row && row.n) || 0;
}

export async function closeAnswer(db, duelId, userId, score, win) {
  const stmts = [
    db.prepare(
      `UPDATE duels SET answers = answers + 1,
                        best_answer = CASE WHEN ?2 > best_answer THEN ?2 ELSE best_answer END
        WHERE id = ?1`,
    ).bind(duelId, score),
  ];
  if (win) {
    stmts.push(db.prepare('UPDATE users SET duel_wins = duel_wins + 1 WHERE id = ?1').bind(userId));
  }
  await db.batch(stmts);
}

// ---------------------------------------------------------------- purchases
/**
 * Claim a charge id. Returns true exactly once per charge: Telegram retries a
 * webhook until it gets a 200, so the primary key is what makes granting an
 * item idempotent.
 */
export async function claimCharge(db, chargeId, userId, item, stars, payload, nowMs) {
  const res = await db.prepare(
    `INSERT OR IGNORE INTO purchases (charge_id, user_id, item, stars, payload, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
  ).bind(chargeId, userId, item, stars, payload, nowMs).run();
  const meta = res && (res.meta || res);
  return !!(meta && meta.changes > 0);
}

export function getPurchase(db, chargeId) {
  return db.prepare(
    'SELECT charge_id, user_id, item, stars, refunded FROM purchases WHERE charge_id = ?1',
  ).bind(chargeId).first();
}

export function markRefunded(db, chargeId, nowMs) {
  return db.prepare(
    'UPDATE purchases SET refunded = 1, refunded_at = ?2 WHERE charge_id = ?1',
  ).bind(chargeId, nowMs).run();
}

/** Add a skin to `owned` and wear it. Read-modify-write: the charge id above
 *  already guarantees this runs once per purchase. */
export async function grantSkin(db, userId, skin, nowMs) {
  const row = await getUser(db, userId);
  if (!row) return false;
  const p = profileOf(row);
  if (p.owned.indexOf(skin) < 0) p.owned.push(skin);
  await db.prepare('UPDATE users SET owned = ?2, skin = ?3, seen_at = ?4 WHERE id = ?1')
    .bind(userId, JSON.stringify(p.owned), skin, nowMs).run();
  return true;
}

export async function revokeSkin(db, userId, skin, nowMs) {
  const row = await getUser(db, userId);
  if (!row) return false;
  const p = profileOf(row);
  const owned = p.owned.filter((s) => s !== skin);
  const wear = p.skin === skin ? 'default' : p.skin;
  await db.prepare('UPDATE users SET owned = ?2, skin = ?3, seen_at = ?4 WHERE id = ?1')
    .bind(userId, JSON.stringify(owned), wear, nowMs).run();
  return true;
}

/** Extend the pass from whichever is later: now, or what is left of it. */
export function grantSeason(db, userId, untilMs) {
  return db.prepare(
    `UPDATE users SET season_until = CASE WHEN season_until > ?2 THEN season_until ELSE ?2 END
      WHERE id = ?1`,
  ).bind(userId, untilMs).run();
}

export function clearSeason(db, userId) {
  return db.prepare('UPDATE users SET season_until = 0 WHERE id = ?1').bind(userId).run();
}

// ---------------------------------------------------------------- erasure
/**
 * Erase one player, which is the promise pages/privacy.html §9 makes and the
 * promise /delete in setMyCommands makes: profile, display name, scores and
 * stats, the duels they created, every run of theirs (including their answers
 * to other people's duels), and their rate-limit counters.
 *
 * Purchases stay, by design and as the policy states. They are the only record
 * a refund can be served from: refundStarPayment needs the payer's user id and
 * the charge id, and somebody who deletes their data and then asks for their
 * Stars back still has to be answerable. What stays is not personal: the
 * display name lived in users.name and duels.name, both deleted here, and the
 * invoice payload is nulled because it embedded the user id a second time.
 * What is left is charge id, user id, item, amount, date.
 *
 * Returns what was removed so the bot can say it out loud.
 */
export async function deleteUserData(db, userId) {
  const c = await db.prepare(
    `SELECT (SELECT COUNT(*) FROM users WHERE id = ?1) AS users,
            (SELECT COUNT(*) FROM runs WHERE user_id = ?1) AS runs,
            (SELECT COUNT(*) FROM runs WHERE user_id = ?1 AND duel_id IS NOT NULL) AS answers,
            (SELECT COUNT(*) FROM duels WHERE user_id = ?1) AS duels,
            (SELECT COUNT(*) FROM purchases WHERE user_id = ?1) AS purchases`,
  ).bind(userId).first();
  await db.batch([
    db.prepare('DELETE FROM runs WHERE user_id = ?1').bind(userId),
    db.prepare('DELETE FROM duels WHERE user_id = ?1').bind(userId),
    db.prepare('DELETE FROM rates WHERE user_id = ?1').bind(userId),
    db.prepare('UPDATE purchases SET payload = NULL WHERE user_id = ?1').bind(userId),
    db.prepare('DELETE FROM users WHERE id = ?1').bind(userId),
  ]);
  return {
    user: (c && c.users) || 0,
    runs: (c && c.runs) || 0,
    answers: (c && c.answers) || 0,
    duels: (c && c.duels) || 0,
    purchasesKept: (c && c.purchases) || 0,
  };
}
