// Independent acceptance check for the whole project.
// Run with: node tools/verify.mjs
// It trusts nothing the agents reported; it re-derives every claim from files.
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// tools/verify.mjs -> project root, so the check travels with the repo
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const R = (p) => path.join(ROOT, p);
const read = (p) => fs.readFileSync(R(p), 'utf8');
const exists = (p) => fs.existsSync(R(p));

const stripJsEarly = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/([^:])\/\/.*$/gm, '$1');
let pass = 0, fail = 0, warn = 0;
const F = [];
function ok(name) { pass++; console.log('  ok   ' + name); }
function bad(name, detail) { fail++; F.push(name + (detail ? ' — ' + detail : '')); console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); }
function soft(name, detail) { warn++; console.log('  warn ' + name + (detail ? ' — ' + detail : '')); }
function section(s) { console.log('\n== ' + s); }

// ---------------------------------------------------------------- 1. files
section('files present');
const MUST = [
  'shared/sim.js', 'shared/daily.js',
  'client/index.html', 'client/css/app.css',
  'client/js/app.js', 'client/js/game.js', 'client/js/render.js',
  'client/js/net.js', 'client/js/tg.js', 'client/js/i18n.js',
  'client/js/audio.js', 'client/js/skins.js',
  'tests/sim.test.mjs', 'tests/golden.test.mjs', 'tests/golden.json',
];
for (const f of MUST) exists(f) ? ok(f) : bad('missing ' + f);
const WANT = [
  'worker/src/index.js', 'worker/schema.sql', 'worker/wrangler.toml',
  'pages/terms.html', 'pages/privacy.html', 'pages/index.html',
  'scripts/deploy.sh', 'scripts/botfather.md', 'README.md',
];
for (const f of WANT) exists(f) ? ok(f) : soft('not written yet: ' + f);

// ---------------------------------------------------------------- 2. physics frozen
section('physics unchanged (the leaderboard depends on it)');
for (const cmd of ['node tests/sim.test.mjs', 'node tests/golden.test.mjs', 'node tests/attack.test.mjs']) {
  try {
    const out = execSync(cmd, { cwd: ROOT, encoding: 'utf8', timeout: 300000 });
    const tail = out.trim().split('\n').slice(-1)[0];
    if (/0 failed|reproduce exactly|0 BROKEN/.test(out)) ok(cmd + ' -> ' + tail);
    else bad(cmd, tail);
  } catch (e) {
    bad(cmd, (e.stdout || '').trim().split('\n').slice(-2).join(' / ') || e.message);
  }
}

// ---------------------------------------------------------------- 3. syntax
section('syntax of every module');
const mods = [];
for (const dir of ['client/js', 'shared', 'worker/src', 'worker/test']) {
  if (!exists(dir)) continue;
  for (const f of fs.readdirSync(R(dir))) if (/\.(js|mjs)$/.test(f)) mods.push(path.join(dir, f));
}
const tmp = fs.mkdtempSync('/tmp/ricchk-');
for (const m of mods) {
  const dst = path.join(tmp, m.replace(/[\/]/g, '_').replace(/\.(js|mjs)$/, '.mjs'));
  fs.writeFileSync(dst, read(m));
  try { execSync(`node --check ${JSON.stringify(dst)}`, { encoding: 'utf8' }); ok('parse ' + m); }
  catch (e) { bad('parse ' + m, String(e.stderr || e.message).split('\n')[1] || ''); }
}

// ---------------------------------------------------------------- 4. client wiring
section('client wiring');
const html = read('client/index.html');
const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
for (const f of ['client/js/app.js', 'client/js/game.js', 'client/js/render.js']) {
  if (!exists(f)) continue;
  const src = read(f);
  const used = new Set([...src.matchAll(/getElementById\('([^']+)'\)|\$\('([^']+)'\)/g)].map((m) => m[1] || m[2]));
  const miss = [...used].filter((u) => !ids.has(u));
  miss.length ? bad(f + ' references unknown ids', miss.join(', ')) : ok(f + ': all ' + used.size + ' ids exist in index.html');
}
// imports resolve, and namespace members exist
function exportsOf(file) {
  const t = fs.readFileSync(file, 'utf8');
  const s = new Set();
  if (/export\s+default/.test(t)) s.add('default');
  for (const e of t.matchAll(/export\s+(?:async\s+)?(?:function|const|let|class)\s+(\w+)/g)) s.add(e[1]);
  for (const e of t.matchAll(/export\s*\{([^}]+)\}/g)) e[1].split(',').forEach((x) => s.add(x.trim().split(/\s+as\s+/).pop()));
  return s;
}
for (const f of mods.filter((m) => m.startsWith('client/js') || m.startsWith('worker'))) {
  // comments mention file names like worker.test.mjs; they are not member access
  const src = stripJsEarly(read(f));
  const dir = path.dirname(R(f));
  const re = /import\s*\*\s*as\s*(\w+)\s*from\s*'([^']+)'|import\s*\{([^}]+)\}\s*from\s*'([^']+)'/g;
  let m, problems = [];
  while ((m = re.exec(src))) {
    const spec = m[2] || m[4];
    if (!spec.startsWith('.')) continue;
    const target = path.resolve(dir, spec);
    if (!fs.existsSync(target)) { problems.push('missing ' + spec); continue; }
    const ex = exportsOf(target);
    if (m[3]) {
      for (const n of m[3].split(',').map((s) => s.trim().split(/\s+as\s+/)[0]).filter(Boolean))
        if (!ex.has(n)) problems.push(spec + ' has no export ' + n);
    } else {
      for (const u of src.matchAll(new RegExp('\\b' + m[1] + '\\.(\\w+)', 'g')))
        if (!ex.has(u[1])) problems.push(spec + ' has no ' + m[1] + '.' + u[1]);
    }
  }
  problems.length ? bad('imports in ' + f, [...new Set(problems)].join('; ')) : ok('imports ok: ' + f);
}

// ---------------------------------------------------------------- 5. renderer contract
section('renderer contract game.js depends on');
if (exists('client/js/render.js')) {
  const r = read('client/js/render.js');
  const need = ['resize', 'setArena', 'frame', 'onEvent', 'toArena', 'toScreen', 'burst', 'shake', 'flashNow'];
  const miss = need.filter((n) => !new RegExp('(^|[^\\w])' + n + '\\s*[,:(]').test(r));
  miss.length ? bad('render.js lost API members', miss.join(', ')) : ok('render.js still exposes ' + need.length + ' required members');
}

// ---------------------------------------------------------------- 6. phone-safe rendering
// A mention in a comment is not a usage; strip comments before judging.
const stripJs = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/([^:])\/\/.*$/gm, '$1');
const stripCss = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');
section('phone performance rules');
if (exists('client/js/render.js')) {
  const r = stripJs(read('client/js/render.js'));
  const sb = (r.match(/shadowBlur/g) || []).length;
  sb === 0 ? ok('no shadowBlur anywhere in render.js') : soft('shadowBlur used ' + sb + 'x — check it is not per-frame');
  /createRadialGradient/.test(r) && !/cache|sprite/i.test(r)
    ? soft('gradients created without an obvious cache')
    : ok('gradients appear cached/baked');
}
const css = exists('client/css/app.css') ? stripCss(read('client/css/app.css')) : '';
/100vh/.test(css) ? bad('css uses 100vh', 'Telegram viewport lies; use --app-h') : ok('no 100vh in css');
/--app-h/.test(css) ? ok('css uses --app-h') : bad('css missing --app-h');
/prefers-reduced-motion/.test(css) ? ok('honours prefers-reduced-motion') : soft('no prefers-reduced-motion block');

// ---------------------------------------------------------------- 7. no network assets
section('zero remote assets (hotspot rule)');
const remote = [];
for (const f of ['client/index.html', 'client/css/app.css']) {
  if (!exists(f)) continue;
  for (const m of (f.endsWith('.css') ? stripCss(read(f)) : read(f)).matchAll(/https?:\/\/[^"')\s]+/g)) {
    // XML namespaces are identifiers, not downloads
    if (/^https?:\/\/www\.w3\.org\//.test(m[0])) continue;
    if (!/telegram\.org\/js\/telegram-web-app\.js/.test(m[0])) remote.push(f + ': ' + m[0]);
  }
}
remote.length ? bad('remote assets found', remote.join(' | ')) : ok('only the Telegram SDK is fetched remotely');

// ---------------------------------------------------------------- 8. i18n discipline
section('i18n');
if (exists('client/js/i18n.js')) {
  const i = read('client/js/i18n.js');
  const keysOf = (lang) => {
    const m = i.match(new RegExp(lang + ':\\s*\\{([\\s\\S]*?)\\n  \\}'));
    return m ? new Set([...m[1].matchAll(/^\s{4}([a-zA-Z0-9_]+):/gm)].map((x) => x[1])) : null;
  };
  const ru = keysOf('ru'), en = keysOf('en'), tg = keysOf('tg');
  if (ru && en && tg) {
    const d = [...ru].filter((k) => !en.has(k) || !tg.has(k));
    d.length ? bad('i18n keys missing in en/tg', d.join(', ')) : ok('ru/en/tg have the same ' + ru.size + ' keys');
  } else soft('could not parse i18n dictionaries');
  // keys used but not defined
  const defined = ru || new Set();
  const usedKeys = new Set();
  for (const f of ['client/js/app.js', 'client/js/game.js']) {
    if (!exists(f)) continue;
    for (const m of read(f).matchAll(/\bt\('([^']+)'/g)) usedKeys.add(m[1]);
  }
  for (const m of html.matchAll(/data-t="([^"]+)"/g)) usedKeys.add(m[1]);
  const undef = [...usedKeys].filter((k) => !defined.has(k));
  undef.length ? bad('i18n keys used but not defined', undef.join(', ')) : ok('all ' + usedKeys.size + ' used keys defined');
}

// ---------------------------------------------------------------- 9. server safety
section('server safety');
if (exists('worker/src')) {
  const files = fs.readdirSync(R('worker/src')).map((f) => 'worker/src/' + f);
  const all = stripJs(files.map(read).join('\n'));
  /node:crypto|require\(/.test(all) ? bad('worker uses node APIs', 'Workers need Web Crypto / ESM') : ok('worker avoids node-only APIs');
  /\b\d{8,10}:[A-Za-z0-9_-]{30,}/.test(all) ? bad('A BOT TOKEN LOOKS HARDCODED') : ok('no bot token literal');
  /runMatch\(/.test(all) ? ok('server replays runs with runMatch') : bad('server never calls runMatch', 'scores would be unverified');
  /clientScore/.test(all) && !/clientScore\s*(===|!==|==|!=)/.test(all) ? soft('clientScore read but not compared') : null;
  /XTR/.test(all) ? ok('invoices use XTR') : soft('no XTR currency found');
  /2592000/.test(all) ? ok('subscription period 2592000 present') : soft('season pass period not found');
  /timingSafe|constant|ConstTime|crypto\.subtle\.verify/.test(all) ? ok('hash comparison looks deliberate') : soft('check hash comparison is constant-time');
}
if (exists('worker/test/worker.test.mjs')) {
  try {
    const out = execSync('node worker/test/worker.test.mjs', { cwd: ROOT, encoding: 'utf8', timeout: 120000 });
    /fail(ed)?:?\s*0|0 failed/i.test(out) || !/fail/i.test(out)
      ? ok('worker tests: ' + out.trim().split('\n').slice(-1)[0])
      : bad('worker tests report failures', out.trim().split('\n').slice(-3).join(' / '));
  } catch (e) { bad('worker tests crashed', (e.stdout || e.message).toString().trim().split('\n').slice(-2).join(' / ')); }
}

// ---------------------------------------------------------------- 10. packaging
section('packaging');
if (exists('scripts/deploy.sh')) {
  try { execSync('bash -n scripts/deploy.sh', { cwd: ROOT }); ok('deploy.sh parses'); }
  catch (e) { bad('deploy.sh syntax', String(e.stderr || e.message)); }
  const d = read('scripts/deploy.sh');
  /golden\.test/.test(d) ? ok('deploy.sh gates on the golden tests') : bad('deploy.sh does not run the golden tests');
  /set -euo pipefail/.test(d) ? ok('deploy.sh is strict') : soft('deploy.sh not set -euo pipefail');
}
for (const p of ['pages/terms.html', 'pages/privacy.html', 'pages/index.html']) {
  if (!exists(p)) continue;
  const t = read(p);
  const open = (t.match(/<(?!\/|!|br|meta|link|img|input|hr)([a-z][a-z0-9]*)\b[^>]*?(?<!\/)>/gi) || []).length;
  const close = (t.match(/<\/[a-z][a-z0-9]*>/gi) || []).length;
  Math.abs(open - close) > 2 ? soft(p + ' tag balance off (' + open + ' open / ' + close + ' close)') : ok(p + ' tag balance fine');
  /http:\/\//.test(t.replace(/http:\/\/www\.w3\.org/g, '')) ? soft(p + ' has a plain-http link') : null;
}

// ---------------------------------------------------------------- verdict
console.log('\n================ ' + pass + ' ok, ' + warn + ' warn, ' + fail + ' FAIL');
if (fail) { console.log('\nblocking:'); F.forEach((f) => console.log(' - ' + f)); }
process.exit(fail ? 1 : 0);
