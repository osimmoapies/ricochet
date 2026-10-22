// Where the client looks for the server.
//
// The client is static (GitHub Pages) and the server is a Cloudflare Worker on
// a different domain, so '/api' only works while developing on localhost. One
// constant decides it, and deploy.sh can rewrite it, so nothing else in the
// code has to know the hostname.
//
// Precedence, highest first:
//   1. window.RIC_API_BASE  — set it from the console to test against a branch
//   2. localhost / 127.0.0.1 → '/api' (same-origin, no CORS while developing)
//   3. API_BASE below       — production
//
// TODO (owner): after `wrangler deploy`, replace the placeholder with the real
// Worker origin, e.g. 'https://ricochet.<your-subdomain>.workers.dev/api'.
// Until then the game still plays: every screen degrades to offline mode and
// the score queue keeps runs for the next launch.
const PRODUCTION_API = 'https://REPLACE_WORKER_SUBDOMAIN.workers.dev/api';

function pick() {
  if (typeof window === 'undefined') return '/api';
  if (window.RIC_API_BASE) return String(window.RIC_API_BASE).replace(/\/+$/, '');
  const h = location.hostname;
  if (h === '127.0.0.1' || h === 'localhost' || h === '' || h === '::1') return '/api';
  return PRODUCTION_API.replace(/\/+$/, '');
}

export const API_BASE = pick();

/** True while the server address is still the placeholder: stay offline-only. */
export const API_CONFIGURED = API_BASE.indexOf('REPLACE_WORKER_SUBDOMAIN') === -1;
