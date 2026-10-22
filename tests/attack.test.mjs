// My own attack on the server, written without reading the agent's own tests.
// If any of these breaks, the leaderboard and the money are worthless.
import crypto from 'node:crypto';
import * as S from '../shared/sim.js';
import { daily, dailySeed, dayIndex } from '../shared/daily.js';
import { verifyInitData, signToken, verifyToken, equalConstTime, INITDATA_MAX_AGE }
  from '../worker/src/auth.js';
import { validateRun, replay } from '../worker/src/score.js';
import { buildInvoice, canEquip, SEASON_PERIOD } from '../worker/src/prices.js';
import * as DB from '../worker/src/db.js';

let pass = 0, fail = 0;
const T = async (name, fn) => {
  try { await fn(); pass++; console.log('  held   ' + name); }
  catch (e) { fail++; console.log('  BROKEN ' + name + ' -- ' + e.message); }
};
const must = (c, m) => { if (!c) throw new Error(m); };

// A legitimate initData built with my own crypto, so the server is not
// blessing itself with its own helpers.
const TOKEN = '123456:FAKE_TOKEN_FOR_TESTS_ONLY';
function makeInitData(fields) {
  const pairs = Object.entries(fields).sort(([a], [b]) => (a < b ? -1 : 1));
  const dcs = pairs.map(([k, v]) => k + '=' + v).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(TOKEN).digest();
  const hash = crypto.createHmac('sha256', secret).update(dcs).digest('hex');
  return new URLSearchParams([...pairs, ['hash', hash]]).toString();
}
const nowSec = Math.floor(Date.now() / 1000);
const goodFields = {
  auth_date: String(nowSec),
  query_id: 'AAE',
  user: JSON.stringify({ id: 777, first_name: 'Osim', language_code: 'ru' }),
};

console.log('\n== Telegram signature');
await T('a correctly signed initData is accepted', async () => {
  const r = await verifyInitData(makeInitData(goodFields), TOKEN);
  must(r.ok, 'rejected a valid signature: ' + JSON.stringify(r));
  must(r.user && r.user.id === 777, 'user id not parsed');
});
await T('a flipped character in the hash is rejected', async () => {
  const s = makeInitData(goodFields);
  const h = s.slice(-64);
  const flipped = (h[0] === 'a' ? 'b' : 'a') + h.slice(1);
  const r = await verifyInitData(s.slice(0, -64) + flipped, TOKEN);
  must(!r.ok, 'accepted a tampered hash');
});
await T('editing the user id without resigning is rejected', async () => {
  const s = makeInitData(goodFields).replace(encodeURIComponent('"id":777'), encodeURIComponent('"id":1'));
  const r = await verifyInitData(s, TOKEN);
  must(!r.ok, 'accepted a forged user id');
});
await T('initData signed by another bot token is rejected', async () => {
  const r = await verifyInitData(makeInitData(goodFields), '999:OTHER');
  must(!r.ok, 'accepted a signature from another bot');
});
await T('initData older than the window is rejected', async () => {
  const old = { ...goodFields, auth_date: String(nowSec - Math.floor(INITDATA_MAX_AGE / 1000) - 60) };
  const r = await verifyInitData(makeInitData(old), TOKEN);
  must(!r.ok, 'accepted stale initData (replay attack)');
});
await T('an extra unsigned field is rejected', async () => {
  const r = await verifyInitData(makeInitData(goodFields) + '&is_premium=1', TOKEN);
  must(!r.ok, 'accepted an injected field');
});
await T('empty and garbage initData are rejected', async () => {
  for (const bad of ['', 'hash=', 'hash=zz', 'user=x&hash=' + 'a'.repeat(64)]) {
    const r = await verifyInitData(bad, TOKEN);
    must(!r.ok, 'accepted garbage: ' + JSON.stringify(bad));
  }
});

console.log('\n== our own session token');
const SECRET = 'test-secret';
await T('a token we issued verifies', async () => {
  const tok = await signToken({ id: 777, name: 'Osim', exp: nowSec + 600 }, SECRET);
  const v = await verifyToken(tok, SECRET, nowSec);
  must(v && v.id === 777, 'did not verify our own token');
});
await T('every single-byte mutation of the token fails', async () => {
  const tok = await signToken({ id: 777, name: 'Osim', exp: nowSec + 600 }, SECRET);
  let accepted = 0;
  for (let i = 0; i < tok.length; i += 7) {
    const c = tok[i] === 'A' ? 'B' : 'A';
    const bad = tok.slice(0, i) + c + tok.slice(i + 1);
    if (bad === tok) continue;
    if (await verifyToken(bad, SECRET, nowSec)) accepted++;
  }
  must(accepted === 0, accepted + ' mutated tokens were accepted');
});
await T('an expired token fails', async () => {
  const tok = await signToken({ id: 777, name: 'Osim', exp: nowSec - 1 }, SECRET);
  must(!(await verifyToken(tok, SECRET, nowSec)), 'accepted an expired token');
});
await T('a token signed with another secret fails', async () => {
  const tok = await signToken({ id: 777, name: 'Osim', exp: nowSec + 600 }, 'other');
  must(!(await verifyToken(tok, SECRET, nowSec)), 'accepted a foreign signature');
});
await T('becoming another user by editing the payload fails', async () => {
  const tok = await signToken({ id: 777, name: 'Osim', exp: nowSec + 600 }, SECRET);
  const [body, sig] = tok.split('.');
  const json = Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString();
  const forged = Buffer.from(json.replace('777', '888')).toString('base64url');
  must(!(await verifyToken(forged + '.' + sig, SECRET, nowSec)), 'accepted an edited payload');
});
await T('constant-time compare is actually correct', () => {
  must(equalConstTime('abc', 'abc'), 'equal strings not equal');
  must(!equalConstTime('abc', 'abd'), 'different strings equal');
  must(!equalConstTime('abc', 'ab'), 'different lengths equal');
  must(!equalConstTime('abc', null), 'null accepted');
});

console.log('\n== score cannot be inflated');
const d = daily();
let shots = null, realScore = 0;
for (let a = 0; a < 4000 && !shots; a++) {
  const ang = -1.4 + (2.8 * (a % 80)) / 79;
  const cand = [];
  for (let i = 0; i < S.MAX_SHOTS; i++) {
    cand.push({
      dx: Math.round(Math.sin(ang + i * 0.07) * 9000) || 1,
      dy: -Math.round(Math.abs(Math.cos(ang + i * 0.07)) * 9000) || -1,
      p: 400 + ((a * 37 + i * 211) % 600), nf: -1, ndx: 0, ndy: 0,
    });
  }
  const r = S.runMatch(d.seed, d.level, cand);
  if (r && r.score > 200) { shots = cand; realScore = r.score; }
}
must(shots, 'could not find a scoring run to attack with');
console.log('  (attacking with a real run worth ' + realScore + ' points)');

const body = () => ({ mode: 'daily', seed: d.seed, level: d.level, shots, clientScore: realScore });
await T('an honest run is accepted at the server-computed score', () => {
  const v = validateRun(body(), Date.now(), null);
  must(v.ok !== false, 'honest run rejected: ' + JSON.stringify(v).slice(0, 120));
  must(v.score === realScore, 'server score ' + v.score + ' != replay ' + realScore);
});
await T('claiming 999999 points returns the real score instead', () => {
  const v = validateRun({ ...body(), clientScore: 999999 }, Date.now(), null);
  must(v.score === realScore, 'server believed the client: ' + v.score);
});
await T('a score field smuggled in at top level is ignored', () => {
  const v = validateRun({ ...body(), score: 999999, rank: 1 }, Date.now(), null);
  must(v.score === realScore, 'top-level score leaked through: ' + v.score);
});
await T("yesterday's board is rejected in daily mode", () => {
  const v = validateRun({ ...body(), seed: dailySeed(dayIndex() - 1) }, Date.now(), null);
  must(v.ok === false, 'accepted a stale daily seed - the daily board is forgeable');
});
await T('a hand-picked custom seed is rejected in daily mode', () => {
  const v = validateRun({ ...body(), seed: 12345 }, Date.now(), null);
  must(v.ok === false, 'accepted an arbitrary daily seed');
});
await T('an easier level on the daily board is rejected', () => {
  const v = validateRun({ ...body(), level: (d.level + 3) % 7 }, Date.now(), null);
  must(v.ok === false, 'level substitution not checked');
});
await T('more than MAX_SHOTS shots is rejected', () => {
  const v = validateRun({ ...body(), shots: [...shots, ...shots] }, Date.now(), null);
  must(v.ok === false, 'accepted ' + shots.length * 2 + ' shots, limit is ' + S.MAX_SHOTS);
});
await T('junk the wire can actually carry is rejected', () => {
  // JSON cannot carry NaN or Infinity, so only test what a real request can
  // contain. Out-of-range numbers are clamped by design, identically on both
  // sides, so a clamped shot is legal - only structural junk must be refused.
  for (const bad of [null, [], 'x', 42, {}, [{}], [null], [[]], ['shot'],
    [{ dx: 0, dy: 0, p: 0, nf: -1 }],
    Array(99).fill({ dx: 1, dy: -1, p: 500, nf: -1 })]) {
    const v = validateRun({ ...body(), shots: bad }, Date.now(), null);
    must(v.ok === false, 'accepted structural junk: ' + JSON.stringify(bad).slice(0, 60));
  }
});
await T('loosely typed shots become ordinary weak shots, not exploits', () => {
  // dx:null -> 0 and dx:'5' -> 5 under the integer coercion both sides share,
  // so the direction stays well defined and client and server still agree.
  // Rejecting them would mean editing shared/sim.js, which the golden hashes
  // freeze - that would void every leaderboard score to block an input worth
  // a handful of points. So the requirement is: deterministic and small.
  const good = S.runMatch(d.seed, d.level, shots).score;
  for (const junk of [[{ dx: null, dy: 1, p: 1, nf: -1 }],
    [{ dx: '5', dy: '5', p: '5', nf: '-1' }], [{ dx: { a: 1 }, dy: 1, p: 1, nf: -1 }]]) {
    const a = validateRun({ ...body(), shots: junk }, Date.now(), null);
    if (a.ok === false) continue;
    const b = validateRun({ ...body(), shots: junk }, Date.now(), null);
    must(a.score === b.score, 'the same junk scored ' + a.score + ' then ' + b.score);
    must(a.score < good, 'a coerced one-shot run (' + a.score + ') beat a real five-shot run (' + good + ')');
  }
});
await T('2000 random junk payloads: never a crash, never a fake score', () => {
  const pool = [0, 1, -1, 1e9, -1e9, 0.5, 1e-9, '', '0', 'abc', null, true, false,
    {}, [], [1], 10000, -10000, 10001, 1000, 1001, 47, 48, 1439, 1440];
  let rnd = 123456789;
  const pick = () => { rnd = (rnd * 1103515245 + 12345) & 0x7fffffff; return pool[rnd % pool.length]; };
  let rejected = 0, scored = 0;
  for (let i = 0; i < 2000; i++) {
    const n = 1 + (i % 7);
    const junk = [];
    for (let k = 0; k < n; k++) junk.push({ dx: pick(), dy: pick(), p: pick(), nf: pick(), ndx: pick(), ndy: pick() });
    let v;
    try { v = validateRun({ ...body(), shots: junk }, Date.now(), null); }
    catch (e) { throw new Error('crashed on junk #' + i + ': ' + e.message); }
    if (v.ok === false) { rejected++; continue; }
    must(Number.isInteger(v.score), 'non-integer score from junk #' + i + ': ' + v.score);
    must(v.score >= 0 && v.score < 1e7, 'absurd score from junk #' + i + ': ' + v.score);
    scored++;
  }
  console.log('         (' + rejected + ' refused, ' + scored + ' clamped to a legal low-score run)');
});
await T('replay is stable across repeated calls', () => {
  const a = replay(d.seed, d.level, shots);
  const b = replay(d.seed, d.level, shots);
  must(a && b && a.score === b.score, 'replay is not stable');
});

console.log('\n== prices come from the server');
await T('the client cannot set its own price', () => {
  const inv = buildInvoice({ item: 'violet', price: 1, amount: 1, prices: [{ amount: 1 }] }, 777, 'n');
  must(inv && inv.ok !== false, 'could not build a legitimate invoice');
  const m = JSON.stringify(inv).match(/"amount":(\d+)/);
  must(m && Number(m[1]) > 1, 'a client price of 1 star leaked in: ' + JSON.stringify(inv).slice(0, 160));
});
await T('an unknown item is refused', () => {
  const inv = buildInvoice({ item: 'free_everything' }, 777, 'n');
  must(!inv || inv.ok === false, 'accepted an item that does not exist');
});
await T('the season pass uses exactly 2592000', () => {
  must(SEASON_PERIOD === 2592000, 'wrong subscription period: ' + SEASON_PERIOD);
  must(JSON.stringify(buildInvoice({ item: 'season' }, 777, 'n')).includes('2592000'), 'pass invoice missing the period');
});
// The server never hands canEquip a raw row; it parses it first. Attack the
// real path, row -> profileOf -> canEquip, so a parsing bug cannot hide here.
const row = (o) => ({
  owned: JSON.stringify(o.owned || []), skin: o.skin || 'default',
  season_until: o.seasonUntil || 0, best_score: o.bestScore || 0,
  clears: o.clears || 0, duel_wins: o.duelWins || 0,
});
const may = (skin, o, now) => canEquip(skin, DB.profileOf(row(o)), now || Date.now());

await T('you cannot equip a paid skin you never bought', () => {
  must(!may('violet', {}), 'equipped a paid skin for free');
  must(may('default', {}), 'cannot equip the free skin');
  must(may('violet', { owned: ['violet'] }), 'a bought skin is refused');
});
await T('an earned skin needs the achievement, not a claim', () => {
  must(!may('mint', {}), 'gave an earned skin to a user with no progress');
  must(!may('mint', { clears: 9 }), 'gave mint away one clear early');
  must(may('mint', { clears: 10 }), 'refused mint to someone with 10 clears');
  must(!may('ember', { bestScore: 3999 }), 'gave ember away one point early');
  must(may('ember', { bestScore: 4000 }), 'refused ember at exactly 4000');
  must(!may('duelist', { duelWins: 9 }), 'gave duelist away one win early');
  must(may('duelist', { duelWins: 10 }), 'refused duelist at 10 wins');
});
await T('a lapsed season pass stops unlocking skins', () => {
  const now = Date.now();
  must(may('plasma', { seasonUntil: now + 60000 }, now), 'an active pass does not unlock');
  must(!may('plasma', { seasonUntil: now - 1 }, now), 'an expired pass still unlocks - free skins forever');
});
await T('a corrupted owned column fails closed', () => {
  for (const junk of ['', 'null', '{}', 'not json', '[1,2,3]', '["violet"']) {
    const p = DB.profileOf({ owned: junk, skin: 'default' });
    must(Array.isArray(p.owned), 'owned is not an array for input ' + JSON.stringify(junk));
    must(!canEquip('violet', p, Date.now()), 'junk owned column unlocked a paid skin: ' + JSON.stringify(junk));
  }
});
await T('an unknown skin id can never be equipped', () => {
  must(!may('../../etc/passwd', { owned: ['../../etc/passwd'] }), 'accepted a path as a skin id');
  must(!may('', {}), 'accepted an empty skin id');
});

console.log('\n== the bot webhook cannot be forged');
const worker = (await import('../worker/src/index.js')).default;
const WH = 'wh-secret-value';
const envFor = () => ({
  WEBHOOK_SECRET: WH, BOT_TOKEN: TOKEN, TOKEN_SECRET: SECRET,
  OWNER_ID: '1', BOT_USERNAME: 'test_bot', ORIGIN: 'https://example.org',
  DB: { prepare() { throw new Error('the webhook must not reach the database here'); } },
});
const post = (url, headers, body) => worker.fetch(
  new Request(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body || {}) }), envFor(), { waitUntil() {} });

await T('a forged update with the right URL but no secret header is refused', async () => {
  const r = await post('https://api.test/webhook/' + WH, {}, {
    message: { chat: { id: 1 }, from: { id: 1 }, text: '/start' },
  });
  must(r.status === 404, 'accepted a forged update without the header (status ' + r.status + ')');
});
await T('a wrong secret header is refused', async () => {
  const r = await post('https://api.test/webhook/' + WH,
    { 'x-telegram-bot-api-secret-token': 'wrong' },
    { message: { chat: { id: 1 }, from: { id: 1 }, text: '/start' } });
  must(r.status === 404, 'accepted a wrong header (status ' + r.status + ')');
});
await T('a wrong secret path is refused', async () => {
  const r = await post('https://api.test/webhook/nope',
    { 'x-telegram-bot-api-secret-token': WH },
    { message: { chat: { id: 1 }, from: { id: 1 }, text: '/start' } });
  must(r.status === 404, 'accepted a wrong path (status ' + r.status + ')');
});
await T('a faked successful_payment cannot grant a skin without the header', async () => {
  // This is the attack that matters: it would hand out paid skins for free.
  const r = await post('https://api.test/webhook/' + WH, {}, {
    message: {
      chat: { id: 1 }, from: { id: 999 },
      successful_payment: {
        currency: 'XTR', total_amount: 250, invoice_payload: 'plasma:999:n',
        telegram_payment_charge_id: 'forged_charge_1',
      },
    },
  });
  must(r.status === 404, 'a forged payment was processed (status ' + r.status + ')');
});
await T('GET on the webhook is refused even with both secrets', async () => {
  const r = await worker.fetch(
    new Request('https://api.test/webhook/' + WH, { method: 'GET',
      headers: { 'x-telegram-bot-api-secret-token': WH } }), envFor(), { waitUntil() {} });
  must(r.status === 404, 'accepted a GET (status ' + r.status + ')');
});
await T('an empty WEBHOOK_SECRET fails closed instead of opening up', async () => {
  const env = { ...envFor(), WEBHOOK_SECRET: '' };
  const r = await worker.fetch(new Request('https://api.test/webhook/',
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }),
    env, { waitUntil() {} });
  must(r.status === 404, 'an unset secret opened the webhook (status ' + r.status + ')');
});

console.log('\n================ ' + pass + ' held, ' + fail + ' BROKEN');
process.exit(fail ? 1 : 0);
