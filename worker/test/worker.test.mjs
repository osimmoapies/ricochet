// Worker tests. Plain node, no framework, no network, no bot token:
//   node worker/test/worker.test.mjs
//
// Everything under test is a pure function pulled out of the request handlers
// (auth.js, score.js, prices.js, ratelimit.js), so the Worker runtime is not
// needed — only Web Crypto, which node has as a global, exactly like Workers.
//
// What these tests are actually defending:
//   * a run is scored by replaying it, so the client's number cannot lie
//   * a run must be on today's board, so a chosen seed cannot be farmed
//   * initData and our token must be forged-proof to the last byte
//   * prices come from the server, never from the wire

import {
  verifyInitData, signToken, verifyToken, hmac, hex, equalConstTime,
  dataCheckString, bearer, b64urlFromBytes, TOKEN_TTL,
} from '../src/auth.js';
import { validateRun, validateDuel, replay, resolveBoard, clampLevel } from '../src/score.js';
import { buildInvoice, parsePayload, canEquip, ITEMS, SEASON_PERIOD } from '../src/prices.js';
import { hit, LIMITS, windowStart } from '../src/ratelimit.js';
import { handleUpdate } from '../src/webhook.js';
import * as DB from '../src/db.js';
import * as worker from '../src/index.js';
import { daily, dailySeed, dailyLevel, dayIndex } from '../../shared/daily.js';
import { MAX_SHOTS } from '../../shared/sim.js';

const enc = new TextEncoder();
const FAKE_TOKEN = '7000000000:AAFakeBotTokenForTestsOnly-not-a-real-secret';
const SECRET = 'test-token-secret-0123456789abcdef';
const NOW = 1761100000000;          // fixed clock: 2025-10-22T03:06:40Z
const USER = { id: 424242, first_name: 'Осим', last_name: 'Т', username: 'osim' };

let passed = 0;
let failed = 0;
const failures = [];

function ok(cond, name) {
  if (cond) { passed++; return true; }
  failed++; failures.push(name);
  console.log('  FAIL  ' + name);
  return false;
}
function eq(got, want, name) {
  const good = got === want;
  if (!good) console.log('        got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want));
  return ok(good, name);
}
function section(s) { console.log('\n== ' + s); }

// ---------------------------------------------------------------- helpers
/** Build initData the way Telegram does, signed with a fake bot token. */
async function makeInitData(botToken, fields) {
  const pairs = Object.keys(fields).map((k) => [k, String(fields[k])]);
  const dcs = pairs.slice()
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map((p) => p[0] + '=' + p[1]).join('\n');
  const secret = await hmac(enc.encode('WebAppData'), enc.encode(botToken));
  const hash = hex(await hmac(secret, enc.encode(dcs)));
  const q = new URLSearchParams();
  for (const [k, v] of pairs) q.append(k, v);
  q.append('hash', hash);
  return q.toString();
}

function flipHexChar(s, i) {
  const c = s[i];
  const next = c === 'f' ? 'e' : (parseInt(c, 16) + 1).toString(16);
  return s.slice(0, i) + next + s.slice(i + 1);
}

/** One character of a base64url blob changed, nothing else. */
function flipB64Char(s, i) {
  const c = s[i];
  const next = c === 'A' ? 'B' : (c >= 'a' && c < 'z') ? String.fromCharCode(c.charCodeAt(0) + 1) : 'A';
  return s.slice(0, i) + next + s.slice(i + 1);
}

/**
 * Enough of D1 to run db.js for real: tables are Maps, statements are matched
 * by the SQL db.js actually sends. Not a SQL engine — if db.js changes a query
 * the match fails loudly instead of quietly passing.
 */
function fakeD1() {
  const T = { users: new Map(), runs: [], duels: new Map(), purchases: new Map(), rates: new Map() };
  const seen = [];

  function userRow(id, name, now) {
    return {
      id, name, skin: 'default', owned: '[]', season_until: 0,
      best_score: 0, clears: 0, duel_wins: 0, runs: 0, created_at: now, seen_at: now,
    };
  }
  const pick = (u) => ({
    id: u.id, name: u.name, skin: u.skin, owned: u.owned, season_until: u.season_until,
    best_score: u.best_score, clears: u.clears, duel_wins: u.duel_wins, runs: u.runs,
  });

  const HANDLERS = [
    // --- users
    [/^INSERT INTO users .*DO UPDATE SET name = \?2, seen_at = \?3/, (a) => {
      const u = T.users.get(a[0]);
      if (u) { u.name = a[1]; u.seen_at = a[2]; } else T.users.set(a[0], userRow(a[0], a[1], a[2]));
      return { rows: [pick(T.users.get(a[0]))] };
    }],
    [/^INSERT INTO users .*DO UPDATE SET seen_at = \?3/, (a) => {
      const u = T.users.get(a[0]);
      if (u) u.seen_at = a[2]; else T.users.set(a[0], userRow(a[0], a[1], a[2]));
      return { rows: [pick(T.users.get(a[0]))] };
    }],
    [/^SELECT id, name, skin, owned, season_until, best_score, clears, duel_wins, runs FROM users WHERE id = \?1/,
      (a) => ({ rows: T.users.has(a[0]) ? [pick(T.users.get(a[0]))] : [] })],
    [/^UPDATE users SET skin = \?2 WHERE id = \?1/, (a) => {
      const u = T.users.get(a[0]); if (u) u.skin = a[1];
      return { changes: u ? 1 : 0 };
    }],
    [/^UPDATE users SET runs = runs \+ 1/, (a) => {
      const u = T.users.get(a[0]);
      if (u) {
        u.runs++; u.clears += a[1];
        if (a[2] > u.best_score) u.best_score = a[2];
        u.seen_at = a[3];
      }
      return { changes: u ? 1 : 0 };
    }],
    [/^UPDATE users SET owned = \?2, skin = \?3, seen_at = \?4 WHERE id = \?1/, (a) => {
      const u = T.users.get(a[0]);
      if (u) { u.owned = a[1]; u.skin = a[2]; u.seen_at = a[3]; }
      return { changes: u ? 1 : 0 };
    }],
    [/^UPDATE users SET season_until = CASE/, (a) => {
      const u = T.users.get(a[0]);
      if (u && a[1] > u.season_until) u.season_until = a[1];
      return { changes: u ? 1 : 0 };
    }],
    [/^UPDATE users SET season_until = 0 WHERE id = \?1/, (a) => {
      const u = T.users.get(a[0]); if (u) u.season_until = 0;
      return { changes: u ? 1 : 0 };
    }],
    [/^UPDATE users SET duel_wins = duel_wins \+ 1 WHERE id = \?1/, (a) => {
      const u = T.users.get(a[0]); if (u) u.duel_wins++;
      return { changes: u ? 1 : 0 };
    }],
    [/^DELETE FROM users WHERE id = \?1/, (a) => {
      const had = T.users.delete(a[0]);
      return { changes: had ? 1 : 0 };
    }],
    // --- runs
    [/^INSERT INTO runs \(/, (a) => {
      T.runs.push({
        user_id: a[0], day_idx: a[1], mode: a[2], duel_id: a[3], seed: a[4],
        level: a[5], score: a[6], cleared: a[7], shots: a[8], created_at: a[9],
      });
      return { changes: 1 };
    }],
    [/^SELECT COUNT\(\*\) AS n FROM runs WHERE duel_id = \?1 AND user_id = \?2/, (a) => ({
      rows: [{ n: T.runs.filter((r) => r.duel_id === a[0] && r.user_id === a[1]).length }],
    })],
    [/^SELECT COUNT\(DISTINCT user_id\) AS n FROM runs/, (a) => {
      const ids = new Set(T.runs
        .filter((r) => r.day_idx === a[0] && r.mode === 'daily' && r.score > a[1])
        .map((r) => r.user_id));
      return { rows: [{ n: ids.size }] };
    }],
    [/^SELECT u\.name AS name, r\.score AS score FROM runs r JOIN users u/, (a) => {
      const rows = T.runs
        .filter((r) => r.day_idx === a[0] && r.mode === 'daily' && T.users.has(r.user_id))
        .sort((x, y) => y.score - x.score)
        .map((r) => ({ name: T.users.get(r.user_id).name, score: r.score }));
      return { rows: rows.slice(0, 1) };
    }],
    [/^SELECT r\.user_id AS id, u\.name AS name, MAX\(r\.score\) AS score/, (a) => {
      const best = new Map();
      for (const r of T.runs) {
        if (r.day_idx !== a[0] || r.mode !== 'daily' || !T.users.has(r.user_id)) continue;
        if (!best.has(r.user_id) || r.score > best.get(r.user_id)) best.set(r.user_id, r.score);
      }
      const rows = [...best].map(([id, score]) => ({ id, name: T.users.get(id).name, score }));
      rows.sort((x, y) => y.score - x.score || x.id - y.id);
      return { rows: rows.slice(0, 100) };
    }],
    [/^SELECT id, name, best_score AS score FROM users/, () => {
      const rows = [...T.users.values()].filter((u) => u.best_score > 0)
        .map((u) => ({ id: u.id, name: u.name, score: u.best_score }));
      rows.sort((x, y) => y.score - x.score || x.id - y.id);
      return { rows: rows.slice(0, 100) };
    }],
    [/^DELETE FROM runs WHERE user_id = \?1/, (a) => {
      const before = T.runs.length;
      T.runs = T.runs.filter((r) => r.user_id !== a[0]);
      return { changes: before - T.runs.length };
    }],
    // --- duels
    [/^INSERT INTO duels \(/, (a) => {
      T.duels.set(a[0], {
        id: a[0], user_id: a[1], name: a[2], seed: a[3], level: a[4],
        shots: a[5], score: a[6], answers: 0, best_answer: 0, created_at: a[7],
      });
      return { changes: 1 };
    }],
    [/^SELECT id, user_id, name, seed, level, shots, score, answers, best_answer\s+FROM duels WHERE id = \?1/,
      (a) => ({ rows: T.duels.has(a[0]) ? [T.duels.get(a[0])] : [] })],
    [/^UPDATE duels SET answers = answers \+ 1/, (a) => {
      const d = T.duels.get(a[0]);
      if (d) { d.answers++; if (a[1] > d.best_answer) d.best_answer = a[1]; }
      return { changes: d ? 1 : 0 };
    }],
    [/^DELETE FROM duels WHERE user_id = \?1/, (a) => {
      let n = 0;
      for (const [id, d] of [...T.duels]) if (d.user_id === a[0]) { T.duels.delete(id); n++; }
      return { changes: n };
    }],
    // --- purchases
    [/^INSERT OR IGNORE INTO purchases \(/, (a) => {
      if (T.purchases.has(a[0])) return { changes: 0 };
      T.purchases.set(a[0], {
        charge_id: a[0], user_id: a[1], item: a[2], stars: a[3],
        payload: a[4], refunded: 0, refunded_at: null, created_at: a[5],
      });
      return { changes: 1 };
    }],
    [/^SELECT charge_id, user_id, item, stars, refunded FROM purchases WHERE charge_id = \?1/,
      (a) => ({ rows: T.purchases.has(a[0]) ? [T.purchases.get(a[0])] : [] })],
    [/^UPDATE purchases SET refunded = 1/, (a) => {
      const p = T.purchases.get(a[0]);
      if (p) { p.refunded = 1; p.refunded_at = a[1]; }
      return { changes: p ? 1 : 0 };
    }],
    [/^UPDATE purchases SET payload = NULL WHERE user_id = \?1/, (a) => {
      let n = 0;
      for (const p of T.purchases.values()) if (p.user_id === a[0]) { p.payload = null; n++; }
      return { changes: n };
    }],
    // --- deletion counts
    [/^SELECT \(SELECT COUNT\(\*\) FROM users WHERE id = \?1\) AS users/, (a) => ({
      rows: [{
        users: T.users.has(a[0]) ? 1 : 0,
        runs: T.runs.filter((r) => r.user_id === a[0]).length,
        answers: T.runs.filter((r) => r.user_id === a[0] && r.duel_id).length,
        duels: [...T.duels.values()].filter((d) => d.user_id === a[0]).length,
        purchases: [...T.purchases.values()].filter((p) => p.user_id === a[0]).length,
      }],
    })],
    // --- rates
    [/^INSERT INTO rates \(/, (a) => {
      const k = a[0] + '|' + a[1] + '|' + a[2];
      const n = (T.rates.get(k) || 0) + 1;
      T.rates.set(k, n);
      return { rows: [{ count: n }] };
    }],
    [/^DELETE FROM rates WHERE user_id = \?1/, (a) => {
      let n = 0;
      for (const k of [...T.rates.keys()]) {
        if (k.slice(0, k.indexOf('|')) === String(a[0])) { T.rates.delete(k); n++; }
      }
      return { changes: n };
    }],
  ];

  function run(sql, args) {
    const flat = String(sql).replace(/\s+/g, ' ').trim();
    seen.push(flat);
    for (const [re, fn] of HANDLERS) if (re.test(flat)) return fn(args) || {};
    throw new Error('fakeD1 has no handler for: ' + flat.slice(0, 90));
  }

  const api = {
    tables: T,
    seen,
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async first() { const r = run(sql, args); return (r.rows && r.rows[0]) || null; },
            async all() { const r = run(sql, args); return { results: r.rows || [] }; },
            async run() { const r = run(sql, args); return { meta: { changes: r.changes || 0 } }; },
          };
        },
        async first() { const r = run(sql, []); return (r.rows && r.rows[0]) || null; },
        async all() { const r = run(sql, []); return { results: r.rows || [] }; },
        async run() { const r = run(sql, []); return { meta: { changes: r.changes || 0 } }; },
      };
    },
    async batch(stmts) {
      const out = [];
      for (const s of stmts) {
        const r = await s.all();
        out.push({ results: r.results, meta: { changes: r.results.length } });
      }
      return out;
    },
  };
  return api;
}

/** Catch every Bot API call instead of making it. No network, ever. */
function stubFetch(sent) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    let body = null;
    try { body = JSON.parse(init && init.body); } catch (e) { body = null; }
    sent.push({ method: String(url).split('/').pop(), body });
    return new Response(JSON.stringify({ ok: true, result: { id: 'prepared1' } }),
      { headers: { 'content-type': 'application/json' } });
  };
  return () => { globalThis.fetch = original; };
}

/** A shot list that really scores on the given board (search, not a guess). */
function findScoringShots(seed, level) {
  let best = null;
  for (let p = 1000; p >= 400; p -= 300) {
    for (let dx = -24; dx <= 24; dx += 3) {
      const shots = [{ dx, dy: -40, p, nf: -1, ndx: 0, ndy: 0 }];
      const r = replay(seed, level, shots);
      if (r && (!best || r.score > best.score)) best = { shots, score: r.score };
      if (best && best.score > 0 && p === 1000) break;
    }
    if (best && best.score > 0) break;
  }
  return best;
}

// ---------------------------------------------------------------- main
async function main() {
  const d = daily(NOW);

  section('initData validation');
  {
    const good = await makeInitData(FAKE_TOKEN, {
      auth_date: Math.floor(NOW / 1000) - 30,
      query_id: 'AAEtest',
      user: JSON.stringify(USER),
    });
    const v = await verifyInitData(good, FAKE_TOKEN, { now: NOW });
    ok(v.ok, 'correct initData passes with a fake bot token');
    eq(v.user && v.user.id, USER.id, 'user id is read out of initData');
    eq(v.user && v.user.name, 'Осим Т', 'display name is first + last');

    // the hash field itself, one hex digit different
    const q = new URLSearchParams(good);
    const tampered = good.replace(q.get('hash'), flipHexChar(q.get('hash'), 10));
    const t1 = await verifyInitData(tampered, FAKE_TOKEN, { now: NOW });
    ok(!t1.ok, 'tampered hash fails');
    eq(t1.error, 'bad_signature', 'tampered hash is reported as a bad signature');

    // a field changed while keeping the original hash (the real attack)
    const swapped = good.replace(encodeURIComponent(JSON.stringify(USER)),
      encodeURIComponent(JSON.stringify({ ...USER, id: 999999 })));
    const t2 = await verifyInitData(swapped, FAKE_TOKEN, { now: NOW });
    ok(!t2.ok, 'changing the user id while keeping the hash fails');

    const other = await verifyInitData(good, FAKE_TOKEN + 'x', { now: NOW });
    ok(!other.ok, 'initData signed for another bot token fails');

    const old = await makeInitData(FAKE_TOKEN, {
      auth_date: Math.floor(NOW / 1000) - 25 * 3600,
      user: JSON.stringify(USER),
    });
    const e1 = await verifyInitData(old, FAKE_TOKEN, { now: NOW });
    ok(!e1.ok, 'auth_date older than 24h fails');
    eq(e1.error, 'expired', 'an old auth_date is reported as expired');

    const stillFresh = await makeInitData(FAKE_TOKEN, {
      auth_date: Math.floor(NOW / 1000) - 23 * 3600,
      user: JSON.stringify(USER),
    });
    ok((await verifyInitData(stillFresh, FAKE_TOKEN, { now: NOW })).ok,
      '23h-old auth_date still passes');

    const noUser = await makeInitData(FAKE_TOKEN, { auth_date: Math.floor(NOW / 1000) });
    eq((await verifyInitData(noUser, FAKE_TOKEN, { now: NOW })).error, 'no_user',
      'initData without a user is refused');
    eq((await verifyInitData('', FAKE_TOKEN, { now: NOW })).error, 'bad_init_data',
      'empty initData is refused');
    eq((await verifyInitData('user=x&hash=zz', FAKE_TOKEN, { now: NOW })).error, 'bad_init_data',
      'a non-hex hash is refused before any crypto runs');
    eq((await verifyInitData(good, '', { now: NOW })).error, 'server_misconfigured',
      'a missing bot token is a server error, not a pass');

    const dcs = dataCheckString('b=2&hash=ff&a=1&c=3');
    eq(dcs.dcs, 'a=1\nb=2\nc=3', 'data-check-string is sorted by key and excludes hash');
    eq(dcs.hash, 'ff', 'hash is pulled out of the data-check-string');
  }

  section('constant-time compare');
  {
    ok(equalConstTime('abc', 'abc'), 'equal strings compare equal');
    ok(!equalConstTime('abc', 'abd'), 'one different character compares unequal');
    ok(!equalConstTime('abc', 'abcd'), 'different lengths compare unequal');
    ok(!equalConstTime(undefined, 'abc'), 'a non-string compares unequal');
  }

  section('our bearer token');
  {
    const nowSec = Math.floor(NOW / 1000);
    const exp = nowSec + TOKEN_TTL;
    const token = await signToken({ id: USER.id, name: 'Осим', exp }, SECRET);
    const p = await verifyToken(token, SECRET, nowSec);
    ok(p && p.id === USER.id, 'a token we signed verifies');
    eq(p && p.exp, exp, 'the expiry survives the round trip');
    eq(TOKEN_TTL, 12 * 3600, 'token lifetime is 12 h');

    const dot = token.indexOf('.');
    const body = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    ok(await verifyToken(flipB64Char(body, 3) + '.' + sig, SECRET, nowSec) === null,
      'a flipped byte in the payload fails');
    ok(await verifyToken(body + '.' + flipB64Char(sig, 3), SECRET, nowSec) === null,
      'a flipped byte in the signature fails');
    ok(await verifyToken(token, SECRET + 'x', nowSec) === null,
      'a token signed with another secret fails');
    ok(await verifyToken(token, SECRET, exp + 1) === null, 'an expired token fails');
    ok(await verifyToken(body, SECRET, nowSec) === null, 'a token without a signature fails');
    ok(await verifyToken('', SECRET, nowSec) === null, 'an empty token fails');

    // a payload forged without the key, correctly shaped
    const forged = b64urlFromBytes(enc.encode(JSON.stringify({ id: 1, name: 'x', exp })));
    ok(await verifyToken(forged + '.' + sig, SECRET, nowSec) === null,
      'a forged payload with a stolen signature fails');

    eq(bearer({ get: () => 'Bearer abc.def' }), 'abc.def', 'bearer token is read from the header');
    eq(bearer({ get: () => 'Basic abc' }), '', 'a non-bearer authorization header is ignored');
  }

  section('run replay and anti-cheat');
  {
    const found = findScoringShots(d.seed, d.level);
    ok(found && found.score > 0, 'found a shot that scores on today\'s board (score ' +
      (found ? found.score : 0) + ')');

    const inflated = validateRun({
      mode: 'daily', seed: d.seed, level: d.level,
      shots: found.shots, clientScore: 999999,
    }, NOW, null);
    ok(inflated.ok, 'a legitimate daily run is accepted');
    eq(inflated.score, found.score, 'an inflated clientScore is replaced by the replayed score');
    ok(inflated.score < 999999, 'the claimed score is not what gets stored');
    ok(inflated.inflated, 'the inflated claim is flagged');

    const honest = validateRun({
      mode: 'daily', seed: d.seed, level: d.level,
      shots: found.shots, clientScore: found.score,
    }, NOW, null);
    ok(honest.ok && !honest.inflated, 'an honest claim is not flagged');
    eq(honest.dayIdx, d.dayIdx, 'the run is filed under today');

    // yesterday's board: the seed is real, just not today's
    const stale = validateRun({
      mode: 'daily', seed: dailySeed(d.dayIdx - 1), level: dailyLevel(d.dayIdx - 1),
      shots: found.shots, clientScore: 10,
    }, NOW, null);
    ok(!stale.ok, 'a daily seed that is not today\'s is rejected');
    eq(stale.error, 'stale_seed', 'the stale seed is named as the reason');

    const wrongLevel = validateRun({
      mode: 'daily', seed: d.seed, level: (d.level + 1) % 7,
      shots: found.shots, clientScore: 10,
    }, NOW, null);
    eq(wrongLevel.error, 'bad_level', 'today\'s seed with the wrong level is rejected');

    const madeUp = validateRun({
      mode: 'daily', seed: 12345, level: 0, shots: found.shots, clientScore: 10,
    }, NOW, null);
    eq(madeUp.error, 'stale_seed', 'an invented seed is rejected');

    eq(validateRun({ mode: 'practice', seed: 1, level: 0, shots: found.shots }, NOW, null).error,
      'bad_mode', 'an unknown mode is rejected');
    eq(resolveBoard({ mode: 'duel' }, NOW, null).error, 'unknown_duel',
      'duel mode without a stored duel is rejected');

    // malformed shot lists
    const bad = [
      ['a string instead of an array', 'nope'],
      ['no shots at all', []],
      ['too many shots', new Array(MAX_SHOTS + 1).fill({ dx: 1, dy: -1, p: 500 })],
      ['a null element', [{ dx: 1, dy: -1, p: 500 }, null]],
      ['a nested array', [[1, 2, 3]]],
      ['a zero aim vector', [{ dx: 0, dy: 0, p: 500 }]],
      ['an out-of-range aim', [{ dx: 99999, dy: -1, p: 500 }]],
      ['a missing shots field', undefined],
    ];
    for (const [name, shots] of bad) {
      const r = validateRun({ mode: 'daily', seed: d.seed, level: d.level, shots, clientScore: 1 },
        NOW, null);
      ok(!r.ok && r.error === 'bad_shots', 'malformed shots rejected: ' + name);
    }

    // a duel is played on the stored board, not on one the client names
    const duelRow = { seed: d.seed, level: d.level, score: 10 };
    const asDuel = validateRun({ mode: 'duel', shots: found.shots, clientScore: 5 }, NOW, duelRow);
    ok(asDuel.ok, 'a duel answer is accepted');
    eq(asDuel.score, found.score, 'the duel answer is scored on the stored seed');
    eq(validateRun({ mode: 'duel', seed: d.seed + 1, shots: found.shots }, NOW, duelRow).error,
      'bad_seed', 'a duel answer claiming another board is rejected');

    // creating a duel: the ghost score is replayed too
    const dv = validateDuel({ seed: d.seed, level: d.level, shots: found.shots, score: 999999 }, NOW);
    ok(dv.ok, 'a duel with valid shots is accepted');
    eq(dv.score, found.score, 'the stored duel score is the replayed one');
    ok(dv.inflated, 'an inflated duel score is flagged');
    eq(validateDuel({ seed: 1, level: 0, shots: 'nope' }, NOW).error, 'bad_shots',
      'a duel with malformed shots is rejected');

    eq(clampLevel(99), 6, 'level is clamped to the top tier');
    eq(clampLevel(-3), 0, 'level is clamped to the bottom tier');
    eq(dayIndex(NOW), d.dayIdx, 'day index agrees with the daily board');

    // determinism: the same inputs replay to the same score
    eq(replay(d.seed, d.level, found.shots).score, found.score, 'a replay is reproducible');
  }

  section('prices are server-side');
  {
    // the client's body carries a price, an amount and a prices array: all junk
    const hostile = {
      item: 'gold', price: 1, amount: 1, stars: 1,
      prices: [{ label: 'Gold', amount: 1 }], currency: 'RUB',
      subscription_period: 60,
    };
    const inv = buildInvoice(hostile, USER.id, 'nonce123');
    ok(inv.ok, 'a known item builds an invoice');
    eq(inv.params.prices[0].amount, ITEMS.gold.price, 'the price comes from the server table');
    eq(inv.params.prices[0].amount, 75, 'gold is 75 Stars, as in skins.js');
    eq(inv.params.currency, 'XTR', 'currency is XTR whatever the client asked for');
    eq(inv.params.prices.length, 1, 'the client cannot add price lines');
    eq(inv.params.subscription_period, undefined, 'a skin is not a subscription');
    eq(inv.price, 75, 'the resolved price is reported back');

    const pass = buildInvoice({ item: 'season', price: 1 }, USER.id, 'nonce123');
    eq(pass.params.prices[0].amount, 299, 'the season pass is 299 Stars');
    eq(pass.params.subscription_period, 2592000, 'the pass uses subscription_period 2592000');
    eq(SEASON_PERIOD, 2592000, 'the season period constant is exactly 30 days');

    eq(buildInvoice({ item: 'default' }, 1, 'n1').error, 'unknown_item',
      'a free skin cannot be bought');
    eq(buildInvoice({ item: 'ember' }, 1, 'n1').error, 'unknown_item',
      'an earned skin cannot be bought');
    eq(buildInvoice({ item: '__proto__' }, 1, 'n1').error, 'unknown_item',
      'a prototype key is not an item');
    eq(buildInvoice({ item: 'toString' }, 1, 'n1').error, 'unknown_item',
      'an inherited property is not an item');
    eq(buildInvoice({}, 1, 'n1').error, 'unknown_item', 'a missing item is refused');

    // the payload is what pre_checkout_query trusts
    const parsed = parsePayload(inv.params.payload);
    ok(parsed !== null, 'our own invoice payload parses');
    eq(parsed.item, 'gold', 'the payload names the item');
    eq(parsed.userId, USER.id, 'the payload names the buyer');
    eq(parsed.price, 75, 'the payload resolves to the server price');
    ok(parsePayload('gold:424242') === null, 'a short payload is refused');
    ok(parsePayload('ghost:424242:nonce') === null, 'an unknown item in a payload is refused');
    ok(parsePayload('gold:0:nonce') === null, 'user id 0 in a payload is refused');
    ok(parsePayload('gold:424242:no nce') === null, 'a payload with a space is refused');
    ok(parsePayload(null) === null, 'a missing payload is refused');
  }

  section('equip rules mirror the client');
  {
    const bare = { owned: [], seasonUntil: 0, stats: { bestScore: 0, clears: 0, duelWins: 0 } };
    ok(canEquip('default', bare, NOW), 'the free skin is always equippable');
    ok(!canEquip('gold', bare, NOW), 'an unpaid skin is refused');
    ok(canEquip('gold', { ...bare, owned: ['gold'] }, NOW), 'a bought skin is allowed');
    ok(!canEquip('ember', bare, NOW), 'an earned skin is refused below the threshold');
    ok(canEquip('ember', { ...bare, stats: { bestScore: 4000 } }, NOW),
      'ember unlocks at 4000 points');
    ok(canEquip('mint', { ...bare, stats: { clears: 10 } }, NOW), 'mint unlocks at 10 clears');
    ok(canEquip('duelist', { ...bare, stats: { duelWins: 10 } }, NOW),
      'duelist unlocks at 10 duel wins');
    ok(canEquip('plasma', { ...bare, seasonUntil: NOW + 1000 }, NOW),
      'a live season pass covers paid skins');
    ok(!canEquip('plasma', { ...bare, seasonUntil: NOW - 1000 }, NOW),
      'an expired season pass covers nothing');
    ok(!canEquip('ember', { ...bare, seasonUntil: NOW + 1000 }, NOW),
      'the pass does not shortcut an earned skin');
    ok(!canEquip('nosuchskin', { ...bare, owned: ['nosuchskin'] }, NOW),
      'an unknown skin id is refused even if claimed as owned');
    ok(!canEquip('__proto__', bare, NOW), 'a prototype key is not a skin');
  }

  section('rate limits');
  {
    // minimal stand-in for D1: prepare().bind().first() with a counter
    function fakeDb() {
      const rows = new Map();
      return {
        calls: 0,
        prepare(sql) {
          const self = this;
          return {
            bind(...args) {
              return {
                async first() {
                  self.calls++;
                  const key = args.slice(0, 3).join('|');
                  const n = (rows.get(key) || 0) + 1;
                  rows.set(key, n);
                  return { count: n };
                },
              };
            },
          };
        },
      };
    }

    const db = fakeDb();
    let last = null;
    for (let i = 0; i < LIMITS.run.max; i++) last = await hit(db, 7, 'run', NOW);
    ok(last.ok, 'runs up to the hourly limit are allowed');
    const over = await hit(db, 7, 'run', NOW);
    ok(!over.ok && over.error === 'rate_limited', 'run number 61 in an hour is refused');
    ok(over.retryAfter > 0, 'a refusal says when to come back');

    const nextHour = await hit(db, 7, 'run', NOW + LIMITS.run.windowMs);
    ok(nextHour.ok, 'the next window starts fresh');
    ok((await hit(db, 8, 'run', NOW)).ok, 'another player is counted separately');

    const d2 = fakeDb();
    let dl = null;
    for (let i = 0; i < LIMITS.duel.max; i++) dl = await hit(d2, 7, 'duel', NOW);
    ok(dl.ok, 'duel creations up to the daily limit are allowed');
    ok(!(await hit(d2, 7, 'duel', NOW)).ok, 'duel creation 31 in a day is refused');
    eq(LIMITS.run.max, 60, 'the run limit is 60/hour');
    eq(LIMITS.duel.max, 30, 'the duel limit is 30/day');
    eq(windowStart('run', NOW) % LIMITS.run.windowMs, 0, 'windows are aligned');
    ok(windowStart('nope', NOW) === null, 'an unknown bucket has no window');

    const broken = { prepare() { throw new Error('d1 is down'); } };
    const closed = await hit(broken, 7, 'run', NOW);
    ok(!closed.ok, 'a broken counter fails closed, not open');
    ok(!(await hit(db, 7, 'nosuchbucket', NOW)).ok, 'an unknown bucket is refused');
  }

  section('router wiring (no database touched)');
  {
    // env.DB explodes if anything reaches it: these routes must not need it,
    // and the one that does must fail closed instead of letting the run through
    const deadDb = {
      prepare() { throw new Error('d1 is down'); },
      batch() { throw new Error('d1 is down'); },
    };
    const env = {
      DB: deadDb,
      TOKEN_SECRET: SECRET,
      BOT_TOKEN: FAKE_TOKEN,
      ORIGIN: 'https://example.github.io',
      BOT_USERNAME: 'ricochet_bot',
      WEBHOOK_SECRET: 'wh-secret-path',
      OWNER_ID: '424242',
    };
    const nowSec = Math.floor(Date.now() / 1000);
    const token = await signToken({ id: USER.id, name: 'Осим', exp: nowSec + TOKEN_TTL }, SECRET);
    const auth = { authorization: 'Bearer ' + token, 'content-type': 'application/json' };
    const call = (path, init) => worker.default.fetch(
      new Request('https://api.example.workers.dev' + path, init), env, { waitUntil() {} });

    const pre = await call('/api/run', {
      method: 'OPTIONS', headers: { origin: 'https://example.github.io' },
    });
    eq(pre.status, 204, 'OPTIONS is answered with 204');
    eq(pre.headers.get('access-control-allow-origin'), 'https://example.github.io',
      'the configured origin is allowed');
    ok((pre.headers.get('access-control-allow-headers') || '').indexOf('authorization') >= 0,
      'the preflight allows the authorization header');

    const dev = await call('/api/run', {
      method: 'OPTIONS', headers: { origin: 'http://127.0.0.1:8787' },
    });
    eq(dev.headers.get('access-control-allow-origin'), 'http://127.0.0.1:8787',
      '127.0.0.1 is allowed for local dev');
    const evil = await call('/api/run', {
      method: 'OPTIONS', headers: { origin: 'https://evil.example' },
    });
    ok(!evil.headers.get('access-control-allow-origin'), 'an unknown origin gets no CORS header');

    const health = await call('/api/health');
    eq(health.status, 200, '/api/health answers without a token');

    const noToken = await call('/api/profile');
    eq(noToken.status, 401, 'a missing token is 401 so the client re-auths');
    eq((await noToken.json()).error, 'unauthorized', 'the 401 names the reason');

    const badToken = await call('/api/profile', { headers: { authorization: 'Bearer nope.nope' } });
    eq(badToken.status, 401, 'a junk token is 401');

    const dailyRes = await call('/api/daily', { headers: auth });
    eq(dailyRes.status, 200, '/api/daily answers with a valid token');
    const dj = await dailyRes.json();
    eq(dj.seed, daily(Date.now()).seed, '/api/daily hands out today\'s seed');

    eq((await call('/api/auth', { headers: auth })).status, 405,
      'GET on /api/auth is 405');
    eq((await call('/api/nothing', { headers: auth })).status, 404, 'an unknown path is 404');

    // the rate limiter is the first thing /api/run does, and D1 is dead here
    const run = await call('/api/run', {
      method: 'POST', headers: auth,
      body: JSON.stringify({ mode: 'daily', seed: 1, level: 0, shots: [], clientScore: 1 }),
    });
    eq(run.status, 429, 'a run fails closed when the limiter cannot be written');
    eq((await run.json()).error, 'rate_limited', 'the 429 names the reason');
    ok(run.headers.get('retry-after'), 'the 429 carries retry-after');

    const wh = await call('/webhook/wrong-path', { method: 'POST', body: '{}' });
    eq(wh.status, 404, 'a wrong webhook path is 404');
    const whGet = await call('/webhook/wh-secret-path');
    eq(whGet.status, 404, 'GET on the webhook path is 404');
    // Telegram sends X-Telegram-Bot-Api-Secret-Token on every update once the
    // webhook is registered with a secret_token, so the header is required, not
    // optional: without it the secret URL alone would be enough to forge a
    // successful_payment. A request that is missing it is simply not from us.
    const whBare = await call('/webhook/wh-secret-path', { method: 'POST', body: '{"update_id":1}' });
    eq(whBare.status, 404, 'an update without the secret header is 404, not accepted');
    const whOk = await call('/webhook/wh-secret-path', {
      method: 'POST',
      headers: { 'x-telegram-bot-api-secret-token': 'wh-secret-path' },
      body: '{"update_id":1}',
    });
    eq(whOk.status, 200, 'an update Telegram can retry is acknowledged');

    const noSecret = await worker.default.fetch(
      new Request('https://api.example.workers.dev/webhook/', { method: 'POST', body: '{}' }),
      Object.assign({}, env, { WEBHOOK_SECRET: '' }), { waitUntil() {} });
    eq(noSecret.status, 404, 'an unset WEBHOOK_SECRET exposes no webhook');

    const noDb = await worker.default.fetch(
      new Request('https://api.example.workers.dev/api/daily', { headers: auth }),
      Object.assign({}, env, { DB: null }), { waitUntil() {} });
    eq(noDb.status, 500, 'a missing D1 binding is a 500, not a silent pass');
  }

  section('/delete really deletes (in-memory D1, no network)');
  {
    const db = fakeD1();
    const sent = [];
    const restore = stubFetch(sent);
    const last = () => (sent.length ? sent[sent.length - 1] : null);
    try {
      const env = {
        DB: db,
        TOKEN_SECRET: SECRET,
        BOT_TOKEN: FAKE_TOKEN,
        ORIGIN: 'https://example.github.io',
        PAGES_URL: 'https://example.github.io/ricochet',
        BOT_USERNAME: 'ricochet_bot',
        WEBHOOK_SECRET: 'wh-secret-path',
        OWNER_ID: '1',
      };
      const d = daily(NOW);
      const me = { id: USER.id, name: 'Осим Т' };
      const msg = (text, from) => ({
        update_id: 1,
        message: { message_id: 1, chat: { id: from || me.id }, from: { id: from || me.id, first_name: 'Осим' }, text },
      });

      // a lived-in account: profile, three runs (one of them a duel answer),
      // two duels of our own, one paid purchase, one rate-limit counter
      await DB.upsertUserAndTop(db, me, NOW, d.dayIdx);
      await DB.recordRun(db, me.id, {
        dayIdx: d.dayIdx, mode: 'daily', duelId: null, seed: d.seed, level: d.level,
        score: 1200, cleared: false,
      }, '[]', NOW);
      await DB.recordRun(db, me.id, {
        dayIdx: d.dayIdx, mode: 'daily', duelId: null, seed: d.seed, level: d.level,
        score: 2400, cleared: true,
      }, '[]', NOW);
      await DB.insertDuel(db, 'abc123', me.id, me.name,
        { seed: d.seed, level: d.level, score: 2400 }, '[]', NOW);
      await DB.insertDuel(db, 'def456', me.id, me.name,
        { seed: d.seed, level: d.level, score: 2400 }, '[]', NOW);
      await DB.recordRun(db, me.id, {
        dayIdx: d.dayIdx, mode: 'duel', duelId: 'zzz999', seed: 7, level: 2,
        score: 900, cleared: false,
      }, '[]', NOW);
      await DB.claimCharge(db, 'chg_1', me.id, 'gold', 75, 'r1:gold:' + me.id + ':75:nonce', NOW);
      await hit(db, me.id, 'run', NOW);

      const before = await DB.leaderboard(db, 'today', d.dayIdx);
      eq(before.length, 1, 'the seeded player is on today\'s board before deleting');

      // 1. no confirmation: explain and change nothing
      const asked = await handleUpdate(msg('/delete'), env, NOW);
      ok(asked.ok, '/delete without a word is handled, not an error');
      const askText = (last() && last().body.text) || '';
      ok(askText.indexOf('/delete confirm') >= 0, 'the first /delete asks for /delete confirm');
      ok(askText.indexOf('Удалить все ваши данные') >= 0, 'the question is asked in Russian');
      ok(askText.indexOf('Delete all your') >= 0, 'the same message asks in English');
      ok(askText.indexOf('/paysupport') >= 0, 'the question points at /paysupport first, as the policy does');
      eq(db.tables.users.size, 1, 'asking deletes no user');
      eq(db.tables.runs.length, 3, 'asking deletes no runs');
      eq(db.tables.duels.size, 2, 'asking deletes no duels');

      // 2. confirmed: the player is gone
      const done = await handleUpdate(msg('/delete confirm'), env, NOW);
      ok(done.ok, '/delete confirm is handled');
      const doneText = (last() && last().body.text) || '';
      eq(db.tables.users.size, 0, 'the users row is deleted');
      eq(db.tables.runs.length, 0, 'every run of theirs is deleted');
      eq(db.tables.duels.size, 0, 'the duels they created are deleted');
      eq(db.tables.rates.size, 0, 'their rate-limit counters are deleted');
      ok(doneText.indexOf('данные удалены') >= 0, 'the receipt is in Russian');
      ok(doneText.indexOf('your data is deleted') >= 0, 'and in English, same message');
      ok(doneText.indexOf('прогонов — 3') >= 0, 'the receipt counts the runs it deleted');
      ok(doneText.indexOf('ответов на дуэли — 1') >= 0, 'and says how many were duel answers');
      ok(doneText.indexOf('возврат Stars') >= 0, 'the receipt says why payment records stay');

      // 3. purchases survive, anonymised
      const kept = db.tables.purchases.get('chg_1');
      eq(db.tables.purchases.size, 1, 'the purchase row survives for refunds');
      eq(kept.charge_id, 'chg_1', 'the charge id is kept — refundStarPayment needs it');
      eq(kept.stars, 75, 'the amount is kept');
      eq(kept.item, 'gold', 'the item is kept');
      eq(kept.user_id, me.id, 'the payer id is kept, because a refund is addressed to it');
      eq(kept.payload, null, 'the invoice payload is nulled, it embedded the user id twice');
      const names = JSON.stringify([...db.tables.purchases.values()]);
      ok(names.indexOf('Осим') < 0, 'no display name is left anywhere in the kept records');

      const after = await DB.leaderboard(db, 'today', d.dayIdx);
      eq(after.length, 0, 'the name is off today\'s board');
      eq((await DB.leaderboard(db, 'all', d.dayIdx)).length, 0, 'and off the all-time board');

      // 4. a second delete is a no-op, not a crash
      const again = await handleUpdate(msg('/delete confirm'), env, NOW);
      ok(again.ok, 'a second /delete confirm is handled');
      const againText = (last() && last().body.text) || '';
      ok(againText.indexOf('удалять нечего') >= 0, 'it says there is nothing left (ru)');
      ok(againText.indexOf('nothing to delete') >= 0, 'and in English');
      eq(db.tables.purchases.size, 1, 'the second delete does not touch the payment records');

      // 5. the game still works for them: a clean profile, no crash
      const fresh = await DB.ensureUser(db, me, NOW + 1000);
      const p = DB.profileOf(fresh);
      eq(p.stats.bestScore, 0, 'ensureUser after deletion gives a zero best score');
      eq(p.stats.runs, 0, 'and zero runs');
      eq(p.stats.duelWins, 0, 'and zero duel wins');
      eq(p.owned.length, 0, 'and nothing owned');
      eq(p.skin, 'default', 'and the default skin');
      eq(p.seasonUntil, 0, 'and no pass');

      // the real path the client takes: POST /api/auth must rebuild the row
      db.tables.users.clear();
      const initData = await makeInitData(FAKE_TOKEN, {
        auth_date: Math.floor(Date.now() / 1000) - 10,
        query_id: 'AAEtest',
        user: JSON.stringify(USER),
      });
      const res = await worker.default.fetch(
        new Request('https://api.example.workers.dev/api/auth', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ initData }),
        }), env, { waitUntil() {} });
      eq(res.status, 200, 'a deleted player can open the Mini App again');
      const body = await res.json();
      eq(body.profile.stats.bestScore, 0, '/api/auth hands back an empty profile, not a crash');
      eq(body.profile.skin, 'default', 'with the default skin');
      eq(body.topToday.score, 0, 'and an empty top-of-the-day');
      eq(db.tables.users.size, 1, 'the row is recreated on the way in');

      // 6. the Russian confirmation word works too
      const other = 777000;
      await DB.upsertUserAndTop(db, { id: other, name: 'Друг' }, NOW, d.dayIdx);
      ok(db.tables.users.has(other), 'a second player exists');
      await handleUpdate(msg('/delete подтверждаю', other), env, NOW);
      ok(!db.tables.users.has(other), '"/delete подтверждаю" counts as confirmation');
      ok(db.tables.users.has(USER.id), 'and it deleted only the player who asked');

      // 7. /start carries the legal links moderation looks for
      await handleUpdate(msg('/start'), env, NOW);
      const startText = (last() && last().body.text) || '';
      ok(startText.indexOf('https://example.github.io/ricochet/terms.html') >= 0,
        '/start links the Terms page');
      ok(startText.indexOf('https://example.github.io/ricochet/privacy.html') >= 0,
        '/start links the Privacy page');
      ok(startText.indexOf('/delete') >= 0, '/start tells them how to delete their data');
      ok(sent.every((s) => s.method !== 'getUpdates'), 'no Bot API call escaped the stub');
    } finally {
      restore();
    }
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) {
    console.log('failures:');
    for (const f of failures) console.log('  - ' + f);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.log('harness crashed: ' + (e && e.stack ? e.stack : e));
  process.exitCode = 1;
});
