// Telegram initData validation and our own session tokens.
//
// Everything here is HMAC-SHA256 over Web Crypto only: a Worker has no
// node:crypto, and the exact same code has to run under plain `node` in the
// tests. No dependencies, no dynamic imports.
//
// Why a token at all: initData is signed once when the Mini App opens and
// Telegram expects it to be treated as short-lived, so every later request
// carries a 12 h bearer token of ours instead of replaying initData.

export const TOKEN_TTL = 12 * 3600;        // seconds
export const INITDATA_MAX_AGE = 24 * 3600 * 1000;
const CLOCK_SLACK = 5 * 60 * 1000;         // tolerate a slightly fast phone

const enc = new TextEncoder();
const dec = new TextDecoder();

// ---------------------------------------------------------------- base64url
export function b64urlFromBytes(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlToBytes(str) {
  const s = String(str).replace(/-/g, '+').replace(/_/g, '/');
  const pad = s.length % 4 === 0 ? '' : '===='.slice(s.length % 4);
  const bin = atob(s + pad);                 // throws on garbage; callers catch
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function hex(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    s += (b < 16 ? '0' : '') + b.toString(16);
  }
  return s;
}

// ---------------------------------------------------------------- hmac
export async function hmac(keyBytes, msgBytes) {
  const key = await crypto.subtle.importKey(
    'raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, msgBytes));
}

/** Length is public, contents are not: no early exit on the first bad char. */
export function equalConstTime(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

// ---------------------------------------------------------------- initData
/**
 * Split initData into its hash and the data-check-string Telegram signs:
 * every field except `hash`, sorted by key, joined by \n as `key=value`.
 */
export function dataCheckString(initData) {
  const q = new URLSearchParams(initData);
  let hash = '';
  const pairs = [];
  for (const [k, v] of q) {
    if (k === 'hash') { hash = v; continue; }
    pairs.push([k, v]);
  }
  pairs.sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
  return { hash, dcs: pairs.map((p) => p[0] + '=' + p[1]).join('\n') };
}

function cleanName(s, fallback) {
  const t = String(s === undefined || s === null ? '' : s)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 32);
  return t || fallback;
}

function userFromParams(initData) {
  const q = new URLSearchParams(initData);
  const raw = q.get('user');
  if (!raw) return null;
  let u;
  try { u = JSON.parse(raw); } catch (e) { return null; }
  if (!u || typeof u.id !== 'number' || !Number.isSafeInteger(u.id) || u.id <= 0) return null;
  const first = u.first_name ? String(u.first_name) : '';
  const last = u.last_name ? String(u.last_name) : '';
  const name = cleanName((first + ' ' + last).trim() || u.username || '', 'Player');
  return { id: u.id, name, lang: u.language_code ? String(u.language_code).slice(0, 8) : '' };
}

/**
 * Validate initData against the bot token.
 * secret = HMAC_SHA256(key "WebAppData", msg BOT_TOKEN)
 * hash   = HMAC_SHA256(key secret,       msg dataCheckString)
 */
export async function verifyInitData(initData, botToken, opts) {
  const o = opts || {};
  if (typeof initData !== 'string' || !initData || initData.length > 4096) {
    return { ok: false, error: 'bad_init_data' };
  }
  if (!botToken) return { ok: false, error: 'server_misconfigured' };

  const { hash, dcs } = dataCheckString(initData);
  if (!/^[0-9a-f]{64}$/.test(hash)) return { ok: false, error: 'bad_init_data' };

  const q = new URLSearchParams(initData);
  const authDate = Number(q.get('auth_date'));
  if (!Number.isFinite(authDate) || authDate <= 0) return { ok: false, error: 'bad_init_data' };

  const now = o.now === undefined ? Date.now() : o.now;
  const maxAge = o.maxAgeMs === undefined ? INITDATA_MAX_AGE : o.maxAgeMs;
  const age = now - authDate * 1000;
  if (age > maxAge) return { ok: false, error: 'expired' };
  if (age < -CLOCK_SLACK) return { ok: false, error: 'bad_init_data' };

  const secret = await hmac(enc.encode('WebAppData'), enc.encode(botToken));
  const mac = hex(await hmac(secret, enc.encode(dcs)));
  if (!equalConstTime(mac, hash)) return { ok: false, error: 'bad_signature' };

  const user = userFromParams(initData);
  if (!user) return { ok: false, error: 'no_user' };
  return { ok: true, user, authDate };
}

// ---------------------------------------------------------------- our token
/** base64url(JSON payload) + "." + base64url(HMAC(secret, payload)). */
export async function signToken(payload, secret) {
  if (!secret) throw new Error('no token secret');
  const body = b64urlFromBytes(enc.encode(JSON.stringify(payload)));
  const sig = b64urlFromBytes(await hmac(enc.encode(secret), enc.encode(body)));
  return body + '.' + sig;
}

/** Returns the payload, or null for any failure: bad sig, junk, or expired. */
export async function verifyToken(token, secret, nowSec) {
  if (typeof token !== 'string' || !token || token.length > 1024 || !secret) return null;
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return null;
  if (token.indexOf('.', dot + 1) !== -1) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const want = b64urlFromBytes(await hmac(enc.encode(secret), enc.encode(body)));
  if (!equalConstTime(sig, want)) return null;
  let payload;
  try { payload = JSON.parse(dec.decode(b64urlToBytes(body))); } catch (e) { return null; }
  if (!payload || typeof payload !== 'object') return null;
  if (!Number.isSafeInteger(payload.id) || payload.id <= 0) return null;
  if (!Number.isFinite(payload.exp)) return null;
  const now = nowSec === undefined ? Math.floor(Date.now() / 1000) : nowSec;
  if (payload.exp <= now) return null;
  return { id: payload.id, name: cleanName(payload.name, 'Player'), exp: payload.exp };
}

/** Pull the bearer token out of a request's headers. */
export function bearer(headers) {
  const h = (headers && headers.get ? headers.get('authorization') : '') || '';
  const m = /^Bearer\s+(\S+)$/.exec(h.trim());
  return m ? m[1] : '';
}
