// РИКОШЕТ — the whole server.
//
// Contract: client/js/net.js. Field names there are the field names here; the
// client is already written and must not be touched.
//
// Shape of the thing: the Mini App is playable with this Worker switched off
// (the daily board is derived from the date on both sides), so every handler
// here is allowed to be strict. A refused run is a 4xx the client reports, an
// outage is a 5xx the client queues and retries.
//
// Budget: Cloudflare free tier, 10 ms CPU per request. One replayed run was
// measured at p95 1.35 ms, so /run has room; nothing else here does real work.

import { bearer, signToken, verifyToken, verifyInitData, equalConstTime, TOKEN_TTL } from './auth.js';
import { validateRun, validateDuel } from './score.js';
import { buildInvoice, canEquip } from './prices.js';
import { hit } from './ratelimit.js';
import { createInvoiceLink, savePreparedInlineMessage } from './telegram.js';
import { handleUpdate } from './webhook.js';
import { fail, json, preflight, readJson } from './http.js';
import * as DB from './db.js';
import { daily } from '../../shared/daily.js';
import { sanitizeShot } from '../../shared/sim.js';

const DUEL_ID = /^[0-9A-Za-z]{6,24}$/;
const ID_ALPHA = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

function randomId(n) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  let s = '';
  for (let i = 0; i < n; i++) s += ID_ALPHA[b[i] % ID_ALPHA.length];
  return s;
}

function cleanShots(shots) {
  const out = [];
  for (let i = 0; i < shots.length; i++) {
    const s = sanitizeShot(shots[i]);
    if (!s) return null;
    out.push(s);
  }
  return out;
}

function duelDeepLink(env, id) {
  const u = String(env.BOT_USERNAME || '').replace(/^@/, '');
  return 'https://t.me/' + u + '?startapp=d_' + id;
}

// ---------------------------------------------------------------- auth
async function currentUser(req, env, nowMs) {
  const tok = bearer(req.headers);
  if (!tok) return null;
  return verifyToken(tok, env.TOKEN_SECRET, Math.floor(nowMs / 1000));
}

async function apiAuth(req, env, nowMs) {
  const body = await readJson(req);
  if (!body || typeof body.initData !== 'string') return fail(400, 'bad_body', req, env);
  const v = await verifyInitData(body.initData, env.BOT_TOKEN, { now: nowMs });
  if (!v.ok) return fail(v.error === 'server_misconfigured' ? 500 : 401, v.error, req, env);

  const d = daily(nowMs);
  const exp = Math.floor(nowMs / 1000) + TOKEN_TTL;
  const token = await signToken({ id: v.user.id, name: v.user.name, exp }, env.TOKEN_SECRET);
  const { row, top } = await DB.upsertUserAndTop(env.DB, v.user, nowMs, d.dayIdx);
  return json({
    token,
    exp,
    serverTime: Math.floor(nowMs / 1000),
    profile: DB.profileOf(row),
    daily: d,
    topToday: top,
  }, 200, req, env);
}

// ---------------------------------------------------------------- runs
/** Shared by POST /api/run and POST /api/duel/:id/answer. */
async function submitRun(req, env, nowMs, who, body, duelIdFromPath) {
  const rl = await hit(env.DB, who.id, 'run', nowMs);
  if (!rl.ok) return fail(429, rl.error, req, env, { retryAfter: rl.retryAfter });

  let duelId = duelIdFromPath || null;
  if (!duelId && body.duelId !== undefined && body.duelId !== null) {
    if (typeof body.duelId !== 'string' || !DUEL_ID.test(body.duelId)) {
      return fail(400, 'bad_duel_id', req, env);
    }
    duelId = body.duelId;
  }
  const isDuel = body.mode === 'duel';
  let duel = null;
  if (isDuel && duelId) {
    duel = await DB.getDuel(env.DB, duelId);
    if (!duel) return fail(404, 'unknown_duel', req, env);
  }

  const v = validateRun(body, nowMs, duel);
  if (!v.ok) return fail(400, v.error, req, env);

  const shots = cleanShots(body.shots);
  if (!shots) return fail(400, 'bad_shots', req, env);

  await DB.recordRun(env.DB, who.id, {
    dayIdx: v.dayIdx, mode: v.mode, duelId: isDuel ? duelId : null,
    seed: v.seed, level: v.level, score: v.score, cleared: v.cleared,
  }, JSON.stringify(shots), nowMs);

  const out = { score: v.score, cleared: v.cleared };
  if (v.mode === 'daily') out.rank = await DB.rankToday(env.DB, v.dayIdx, v.score);

  if (duel) {
    // one duel win per duel per player: the count includes the run just stored
    const attempts = await DB.duelAttempts(env.DB, duelId, who.id);
    const win = attempts <= 1 && who.id !== duel.user_id && v.score > (duel.score | 0);
    await DB.closeAnswer(env.DB, duelId, who.id, v.score, win);
    out.theirScore = duel.score | 0;
    out.duelWin = win;
  }
  return json(out, 200, req, env);
}

// ---------------------------------------------------------------- duels
async function duelCreate(req, env, nowMs, who) {
  const body = await readJson(req);
  if (!body) return fail(400, 'bad_body', req, env);
  const rl = await hit(env.DB, who.id, 'duel', nowMs);
  if (!rl.ok) return fail(429, rl.error, req, env, { retryAfter: rl.retryAfter });

  const v = validateDuel(body, nowMs);
  if (!v.ok) return fail(400, v.error, req, env);
  const shots = cleanShots(body.shots);
  if (!shots) return fail(400, 'bad_shots', req, env);

  const id = randomId(12);
  await DB.insertDuel(env.DB, id, who.id, who.name, v, JSON.stringify(shots), nowMs);

  const link = duelDeepLink(env, id);
  const out = { id, deepLink: link, score: v.score };
  // A prepared message gives the player a native share sheet; if Telegram
  // says no we still hand back the link and the client falls back to it.
  const prep = await savePreparedInlineMessage(env.BOT_TOKEN, who.id, id, v.score, link);
  if (prep.ok && prep.result && prep.result.id) out.preparedId = prep.result.id;
  return json(out, 200, req, env);
}

async function duelGet(req, env, nowMs, id) {
  if (!DUEL_ID.test(id)) return fail(400, 'bad_duel_id', req, env);
  const row = await DB.getDuel(env.DB, id);
  if (!row) return fail(404, 'unknown_duel', req, env);
  let shots = [];
  try { shots = JSON.parse(row.shots) || []; } catch (e) { shots = []; }
  return json({
    seed: row.seed | 0,
    level: row.level | 0,
    shots,
    name: row.name || 'Player',
    score: row.score | 0,
  }, 200, req, env);
}

// ---------------------------------------------------------------- shop
async function shopInvoice(req, env, nowMs, who) {
  const body = await readJson(req);
  if (!body) return fail(400, 'bad_body', req, env);
  const inv = buildInvoice(body, who.id, randomId(8));
  if (!inv.ok) return fail(400, inv.error, req, env);
  const r = await createInvoiceLink(env.BOT_TOKEN, inv.params);
  if (!r.ok || typeof r.result !== 'string') return fail(502, 'telegram_failed', req, env);
  return json({ invoiceLink: r.result, item: inv.item, price: inv.price }, 200, req, env);
}

async function shopEquip(req, env, nowMs, who) {
  const body = await readJson(req);
  if (!body || typeof body.skin !== 'string') return fail(400, 'bad_body', req, env);
  const row = await DB.ensureUser(env.DB, who, nowMs);
  const profile = DB.profileOf(row);
  if (!canEquip(body.skin, profile, nowMs)) return fail(403, 'not_owned', req, env);
  await DB.setSkin(env.DB, who.id, body.skin);
  return json({ ok: true, skin: body.skin }, 200, req, env);
}

// ---------------------------------------------------------------- router
export default {
  async fetch(req, env, ctx) {
    const nowMs = Date.now();
    const url = new URL(req.url);
    const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname;

    // webhook first: it is not a browser caller, so no CORS and no token
    if (path === '/webhook' || path.indexOf('/webhook/') === 0) {
      const secret = env.WEBHOOK_SECRET || '';
      const given = path.slice('/webhook/'.length);
      const header = req.headers.get('x-telegram-bot-api-secret-token') || '';
      if (req.method !== 'POST' || !secret || !equalConstTime(given, secret)) {
        return new Response('not found', { status: 404 });
      }
      // The header is required, not optional. Telegram always sends it when
      // setWebhook was given secret_token, which scripts/botfather.md makes
      // mandatory. Accepting a request without it would mean the URL alone is
      // the whole secret, and URLs leak through logs and proxies — enough to
      // forge a successful_payment and hand out paid skins for free.
      if (!equalConstTime(header, secret)) return new Response('not found', { status: 404 });
      let update = null;
      try { update = await req.json(); } catch (e) { update = null; }
      if (!update || typeof update !== 'object') return new Response('ok', { status: 200 });
      // Awaited, not deferred: a 500 makes Telegram redeliver the update, and
      // granting is keyed on the charge id, so a redelivery is free. Deferring
      // would turn a failed grant into a paid player with nothing.
      const r = await handleUpdate(update, env, nowMs);
      return new Response(r && r.ok === false ? 'retry' : 'ok', { status: r && r.ok === false ? 500 : 200 });
    }

    if (req.method === 'OPTIONS') return preflight(req, env);

    if (path === '/api/health') {
      return json({ ok: true, serverTime: Math.floor(nowMs / 1000) }, 200, req, env);
    }

    try {
      if (!env.DB) return fail(500, 'server_misconfigured', req, env);
      if (!env.TOKEN_SECRET) return fail(500, 'server_misconfigured', req, env);

      if (path === '/api/auth') {
        if (req.method !== 'POST') return fail(405, 'bad_method', req, env);
        return await apiAuth(req, env, nowMs);
      }

      // everything below needs our bearer token; a 401 makes the client
      // re-auth once and retry, which is exactly what net.js does
      const who = await currentUser(req, env, nowMs);
      if (!who) return fail(401, 'unauthorized', req, env);

      if (path === '/api/daily' && req.method === 'GET') {
        const d = daily(nowMs);
        return json(Object.assign({ serverTime: Math.floor(nowMs / 1000) }, d), 200, req, env);
      }

      if (path === '/api/profile' && req.method === 'GET') {
        const row = await DB.ensureUser(env.DB, who, nowMs);
        return json(DB.profileOf(row), 200, req, env);
      }

      if (path === '/api/run' && req.method === 'POST') {
        const body = await readJson(req);
        if (!body) return fail(400, 'bad_body', req, env);
        return await submitRun(req, env, nowMs, who, body, null);
      }

      if (path === '/api/leaderboard' && req.method === 'GET') {
        const scope = url.searchParams.get('scope') === 'all' ? 'all' : 'today';
        const rows = await DB.leaderboard(env.DB, scope, daily(nowMs).dayIdx);
        return json({ scope, rows }, 200, req, env);
      }

      if (path === '/api/duel/create' && req.method === 'POST') {
        return await duelCreate(req, env, nowMs, who);
      }

      if (path.indexOf('/api/duel/') === 0) {
        const rest = path.slice('/api/duel/'.length);
        if (req.method === 'GET' && rest.indexOf('/') < 0) {
          return await duelGet(req, env, nowMs, rest);
        }
        if (req.method === 'POST' && rest.slice(-7) === '/answer') {
          const id = rest.slice(0, -7);
          if (!DUEL_ID.test(id)) return fail(400, 'bad_duel_id', req, env);
          const body = await readJson(req);
          if (!body) return fail(400, 'bad_body', req, env);
          body.mode = 'duel';
          if (body.clientScore === undefined) body.clientScore = body.score;
          return await submitRun(req, env, nowMs, who, body, id);
        }
        return fail(404, 'not_found', req, env);
      }

      if (path === '/api/shop/invoice' && req.method === 'POST') {
        return await shopInvoice(req, env, nowMs, who);
      }

      if (path === '/api/shop/equip' && req.method === 'POST') {
        return await shopEquip(req, env, nowMs, who);
      }

      if (path === '/api/share' && req.method === 'POST') {
        // net.js exposes it; sharing itself happens in the client via the
        // Telegram SDK, so there is nothing to do but acknowledge
        return json({ ok: true }, 200, req, env);
      }

      return fail(404, 'not_found', req, env);
    } catch (e) {
      // 5xx on purpose: the client queues the run and retries it later
      console.log('error', path, (e && e.message) || e);
      return fail(500, 'server_error', req, env);
    }
  },
};
