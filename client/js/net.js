// API client.
//
// Two things it must get right on a phone hotspot: never block the game on a
// request, and never silently lose a score. A failed submit goes into a local
// queue and is retried on the next launch, so a run played in a lift still
// counts when the signal comes back.
import * as TG from './tg.js';
import { API_BASE, API_CONFIGURED } from './config.js';

const BASE = API_BASE;
const QUEUE_KEY = 'ric.queue.v1';
const TOKEN_KEY = 'ric.token.v1';

let token = null;
let authPromise = null;
export let serverTimeSkew = 0;

function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { } }

async function raw(path, opts = {}, timeoutMs = 9000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const headers = { 'content-type': 'application/json' };
    if (token) headers.authorization = 'Bearer ' + token;
    const res = await fetch(BASE + path, {
      method: opts.method || 'GET',
      headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: ctrl.signal,
      cache: 'no-store',
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
    if (!res.ok) {
      const err = new Error((data && data.error) || ('http ' + res.status));
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

/** Trade initData for a short-lived token. initData itself expires in an hour. */
export function auth(force) {
  if (authPromise && !force) return authPromise;
  authPromise = (async () => {
    if (!API_CONFIGURED) throw new Error('api not configured');
    const cached = lsGet(TOKEN_KEY);
    if (cached && !force) {
      try {
        const parsed = JSON.parse(cached);
        if (parsed.exp > Date.now() / 1000 + 60) {
          token = parsed.token;
          return parsed.payload;
        }
      } catch (e) { }
    }
    const data = await raw('/auth', { method: 'POST', body: { initData: TG.initData() } });
    token = data.token;
    if (data.serverTime) serverTimeSkew = data.serverTime * 1000 - Date.now();
    lsSet(TOKEN_KEY, JSON.stringify({ token: data.token, exp: data.exp, payload: data }));
    return data;
  })();
  authPromise.catch(() => { authPromise = null; });
  return authPromise;
}

async function call(path, opts) {
  if (!token) await auth();
  try {
    return await raw(path, opts);
  } catch (e) {
    if (e.status === 401) {
      token = null; authPromise = null;
      await auth(true);
      return raw(path, opts);
    }
    throw e;
  }
}

export const api = {
  daily: () => call('/daily'),
  profile: () => call('/profile'),
  leaderboard: (scope) => call('/leaderboard?scope=' + encodeURIComponent(scope || 'today')),
  submitRun: (body) => call('/run', { method: 'POST', body }),
  duelCreate: (body) => call('/duel/create', { method: 'POST', body }),
  duelGet: (id) => call('/duel/' + encodeURIComponent(id)),
  duelAnswer: (id, body) => call('/duel/' + encodeURIComponent(id) + '/answer', { method: 'POST', body }),
  share: (body) => call('/share', { method: 'POST', body }),
  invoice: (body) => call('/shop/invoice', { method: 'POST', body }),
  equip: (body) => call('/shop/equip', { method: 'POST', body }),
};

// ---------------------------------------------------------------- offline queue
function readQueue() {
  try { return JSON.parse(lsGet(QUEUE_KEY) || '[]'); } catch (e) { return []; }
}
function writeQueue(q) { lsSet(QUEUE_KEY, JSON.stringify(q.slice(-20))); }

export function enqueue(path, body) {
  const q = readQueue();
  q.push({ path, body, at: Date.now() });
  writeQueue(q);
}

export function queueSize() { return readQueue().length; }

/** Fire-and-forget retry of everything that failed earlier. */
export async function flushQueue() {
  const q = readQueue();
  if (!q.length) return { sent: 0 };
  const left = [];
  let sent = 0;
  for (const item of q) {
    try {
      await call(item.path, { method: 'POST', body: item.body });
      sent++;
    } catch (e) {
      // keep it for next time, unless the server rejected it outright
      if (!e.status || e.status >= 500 || e.status === 0) left.push(item);
    }
  }
  writeQueue(left);
  return { sent, left: left.length };
}

/** Submit a run; if the network is gone, keep it and report that honestly. */
export async function submitRunSafe(body) {
  try {
    return { ok: true, data: await api.submitRun(body) };
  } catch (e) {
    if (!e.status || e.status >= 500) {
      enqueue('/run', body);
      return { ok: false, queued: true, error: e.message };
    }
    return { ok: false, queued: false, error: (e.data && e.data.error) || e.message };
  }
}
