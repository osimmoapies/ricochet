// HTTP plumbing: JSON bodies, errors, CORS.
//
// The client treats any non-2xx as a hard failure and a 5xx as "queue it and
// retry later" (see client/js/net.js), so a refusal must be a 4xx and a real
// outage must be a 5xx. Nothing in between.

const MAX_BODY = 32768;          // no legitimate request is bigger

/** Origins we answer to: the Pages site from env plus 127.0.0.1 for dev. */
export function allowedOrigin(origin, env) {
  if (!origin) return null;
  const list = String(env.ORIGIN || '').split(',');
  for (let i = 0; i < list.length; i++) {
    const o = list[i].trim().replace(/\/$/, '');
    if (o && o === origin) return origin;
  }
  // any port on the loopback address, http or https
  if (/^https?:\/\/127\.0\.0\.1(:\d+)?$/.test(origin)) return origin;
  return null;
}

export function corsHeaders(req, env) {
  const h = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    vary: 'Origin',
  };
  const allow = allowedOrigin(req.headers.get('origin'), env);
  if (allow) {
    h['access-control-allow-origin'] = allow;
    // authorization is not a safelisted header, so the browser preflights
    h['access-control-allow-headers'] = 'authorization, content-type';
    h['access-control-allow-methods'] = 'GET, POST, OPTIONS';
    h['access-control-max-age'] = '600';
  }
  return h;
}

export function json(data, status, req, env) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: corsHeaders(req, env),
  });
}

export function fail(status, error, req, env, extra) {
  const body = Object.assign({ error }, extra || null);
  const headers = corsHeaders(req, env);
  if (extra && extra.retryAfter) headers['retry-after'] = String(extra.retryAfter);
  return new Response(JSON.stringify(body), { status, headers });
}

export function preflight(req, env) {
  return new Response(null, { status: 204, headers: corsHeaders(req, env) });
}

/** Parse a JSON body, capped. Returns null for anything unusable. */
export async function readJson(req) {
  const len = req.headers.get('content-length');
  if (len && Number(len) > MAX_BODY) return null;
  let text;
  try { text = await req.text(); } catch (e) { return null; }
  if (!text || text.length > MAX_BODY) return null;
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch (e) { return null; }
}
