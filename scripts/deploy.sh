#!/usr/bin/env bash
#
# РИКОШЕТ — release build.
#
# What it does, in order:
#   1. checks that node and wrangler are installed;
#   2. runs both test suites and ABORTS if either fails;
#   3. builds dist/ for GitHub Pages (client/ + shared/ + pages/);
#   4. proves the client's ../../shared/... imports still resolve inside dist/;
#   5. prints the exact commands for `wrangler deploy` and for publishing
#      dist/ to the gh-pages branch.
#
# What it never does: deploy, push, commit, or touch anything outside dist/.
# Re-running it is safe: dist/ is rebuilt from scratch every time.
#
# Env knobs:
#   WORKER_ORIGIN=https://...    the deployed Worker's origin. Bakes it into
#                                dist/client/js/config.js (the copy only, never
#                                the source). Without it the published client
#                                runs offline-only: no leaderboard, duels or
#                                shop. A trailing slash is stripped, and /api is
#                                appended unless you already ended with it.
#   DIST_DIR=/some/path          build somewhere else (default: <repo>/dist)
#   ALLOW_MISSING_WRANGLER=1     warn instead of aborting when wrangler is absent
#                                (the build itself does not need wrangler)
#
# Typical release:
#   WORKER_ORIGIN=https://ricochet.<subdomain>.workers.dev bash scripts/deploy.sh
#
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
DIST="${DIST_DIR:-$ROOT/dist}"
MARKER=".ricochet-build"           # proof that dist/ is ours before we rm -rf it

if [ -t 1 ]; then
  B=$'\033[1m'; DIM=$'\033[2m'; R=$'\033[31m'; G=$'\033[32m'; Y=$'\033[33m'; C=$'\033[36m'; Z=$'\033[0m'
else
  B=''; DIM=''; R=''; G=''; Y=''; C=''; Z=''
fi

step() { printf '\n%s==>%s %s%s%s\n' "$C" "$Z" "$B" "$1" "$Z"; }
ok()   { printf '    %sok%s  %s\n' "$G" "$Z" "$1"; }
info() { printf '    %s%s%s\n' "$DIM" "$1" "$Z"; }
warn() { printf '    %swarn%s %s\n' "$Y" "$Z" "$1"; }
die()  { printf '\n%sabort:%s %s\n\n' "$R" "$Z" "$1" >&2; exit 1; }

# ----------------------------------------------------------------- 0. sanity
step "0/6  source tree"
for d in client shared pages tests; do
  [ -d "$ROOT/$d" ] || die "missing $d/ — run this from a full checkout"
done
[ -f "$ROOT/client/js/app.js" ]  || die "missing client/js/app.js"
[ -f "$ROOT/shared/sim.js" ]     || die "missing shared/sim.js"
[ -f "$ROOT/tests/sim.test.mjs" ]    || die "missing tests/sim.test.mjs"
[ -f "$ROOT/tests/golden.test.mjs" ] || die "missing tests/golden.test.mjs"
ok "repo root: $ROOT"

case "$DIST" in
  "$ROOT"|"$ROOT/"|/|"") die "DIST_DIR must not be the repo root or /" ;;
  "$ROOT/client"*|"$ROOT/shared"*|"$ROOT/pages"*|"$ROOT/tests"*|"$ROOT/worker"*|"$ROOT/tools"*)
    die "DIST_DIR must not sit inside a source directory" ;;
esac
ok "build dir: $DIST"

# ------------------------------------------------------------------ 1. tools
step "1/6  tools"
command -v node >/dev/null 2>&1 || die "node is not installed (needed for the tests and the build check)"
ok "node $(node --version)"

if command -v wrangler >/dev/null 2>&1; then
  ok "wrangler $(wrangler --version 2>/dev/null | head -n1 | tr -d '\r')"
else
  if [ "${ALLOW_MISSING_WRANGLER:-0}" = "1" ]; then
    warn "wrangler not found — continuing because ALLOW_MISSING_WRANGLER=1"
    warn "the dist/ build does not need it; the worker cannot be deployed without it"
  else
    die "wrangler is not installed.
    Install it once with:  npm i -g wrangler    (or use: npx wrangler <cmd>)
    To build dist/ only, re-run as:  ALLOW_MISSING_WRANGLER=1 $0"
  fi
fi

# ------------------------------------------------------------------ 2. tests
# The physics is frozen by hashes in tests/golden.json. If golden fails, the
# build is wrong, not the test — never ship past this point.
step "2/6  tests (a failure here stops the release)"
# attack.test.mjs is the adversarial suite: forged Telegram signatures, stolen
# tokens, inflated scores, free skins. It imports worker/src, so it only runs
# when the worker is in the tree.
SUITES="sim golden"
if [ -f "$ROOT/tests/attack.test.mjs" ] && [ -d "$ROOT/worker/src" ]; then
  SUITES="$SUITES attack"
else
  warn "skipping tests/attack.test.mjs (needs worker/src) — anti-cheat unverified in this build"
fi
RAN=""
for t in $SUITES; do
  printf '    %srunning tests/%s.test.mjs%s\n' "$DIM" "$t" "$Z"
  if out="$(cd "$ROOT" && node "tests/$t.test.mjs" 2>&1)"; then
    ok "tests/$t.test.mjs — $(printf '%s' "$out" | tail -n1)"
    RAN="$RAN $t"
  else
    printf '%s\n' "$out" | tail -n 25
    die "tests/$t.test.mjs failed — nothing was built, nothing was deployed"
  fi
done

# The Worker suite guards the payment and webhook paths, so a release must not
# go out while it is red either. It lives under worker/, not tests/.
if [ -f "$ROOT/worker/test/worker.test.mjs" ]; then
  printf '    %srunning worker/test/worker.test.mjs%s\n' "$DIM" "$Z"
  if out="$(cd "$ROOT" && node worker/test/worker.test.mjs 2>&1)"; then
    ok "worker/test/worker.test.mjs — $(printf '%s' "$out" | tail -n1)"
    RAN="$RAN worker"
  else
    printf '%s\n' "$out" | tail -n 25
    die "worker tests failed — nothing was built, nothing was deployed"
  fi
else
  warn "no worker/test/worker.test.mjs — the payment path is unverified in this build"
fi
RAN="${RAN# }"

# ------------------------------------------------------------------ 3. build
# Layout matters. client/js/app.js does:  import * as S from '../../shared/sim.js'
# From client/js/ that is two levels up, i.e. the repo root. So dist/ must keep
# the same two-level shape:
#
#   dist/
#     index.html        <- pages/index.html (landing, site root)
#     terms.html        <- pages/terms.html
#     privacy.html      <- pages/privacy.html
#     client/js/app.js  --(../../shared/sim.js)-->  dist/shared/sim.js
#     shared/sim.js
#
# Flattening client/ into the site root would break that import.
step "3/6  build dist/"
if [ -e "$DIST" ]; then
  if [ -f "$DIST/$MARKER" ]; then
    rm -rf "$DIST"
    info "removed the previous build"
  elif [ -d "$DIST" ] && [ -z "$(ls -A "$DIST" 2>/dev/null)" ]; then
    rmdir "$DIST"
  else
    die "$DIST exists and was not built by this script — move it away first"
  fi
fi

mkdir -p "$DIST"
printf 'built by scripts/deploy.sh — safe to delete\n' > "$DIST/$MARKER"
cp -R "$ROOT/client" "$DIST/client"
cp -R "$ROOT/shared" "$DIST/shared"
ok "client/ -> dist/client/   ($(find "$DIST/client" -type f | wc -l | tr -d ' ') files)"
ok "shared/ -> dist/shared/   ($(find "$DIST/shared" -type f | wc -l | tr -d ' ') files)"

shopt -s nullglob
page_count=0
for p in "$ROOT"/pages/*; do
  cp -R "$p" "$DIST/"
  page_count=$((page_count + 1))
done
shopt -u nullglob
[ "$page_count" -gt 0 ] || die "pages/ is empty — terms.html and privacy.html are required for publishing"
ok "pages/*  -> dist/          ($page_count entries)"

for must in index.html terms.html privacy.html; do
  [ -f "$DIST/$must" ] || die "dist/$must is missing — @app_moderation_bot needs the legal pages"
done

# GitHub Pages runs Jekyll by default, which silently drops files and folders
# whose names start with an underscore. .nojekyll turns that off.
: > "$DIST/.nojekyll"
ok ".nojekyll written (GitHub Pages serves the files verbatim)"

# --- where the published client looks for the Worker ------------------------
# client/js/config.js holds one placeholder constant:
#   const PRODUCTION_API = 'https://REPLACE_WORKER_SUBDOMAIN.workers.dev/api';
# WORKER_ORIGIN rewrites that line in the dist COPY only. The source keeps the
# placeholder on purpose: localhost development uses '/api', and the next
# developer must still see that the address is unset.
CFG="$DIST/client/js/config.js"
API_LINE_RE="^const PRODUCTION_API = '"
API_SUMMARY="not set — OFFLINE-ONLY build"

if [ ! -f "$CFG" ]; then
  warn "dist/client/js/config.js not found — nothing to rewrite."
  warn "If client/js/config.js was renamed, this part of the script needs updating."
  API_SUMMARY="config.js missing — not rewritten"
elif [ -n "${WORKER_ORIGIN:-}" ]; then
  origin="${WORKER_ORIGIN%/}"
  case "$origin" in
    *[!A-Za-z0-9:/._-]*) die "WORKER_ORIGIN has characters that do not belong in a URL: $WORKER_ORIGIN" ;;
  esac
  case "$origin" in
    https://*) : ;;
    *) die "WORKER_ORIGIN must start with https:// — Telegram Mini Apps and GitHub Pages both require TLS (got: $WORKER_ORIGIN)" ;;
  esac
  case "$origin" in
    */api) api_url="$origin" ;;          # already points at the API path
    *)     api_url="$origin/api" ;;
  esac

  grep -q "$API_LINE_RE" "$CFG" \
    || die "no PRODUCTION_API line in dist/client/js/config.js — client/js/config.js changed shape, update this script"

  # BSD sed has no reliable in-place flag across platforms: write, then move.
  # '|' as the delimiter because the replacement is a URL full of '/'.
  sed "s|^const PRODUCTION_API = '[^']*';|const PRODUCTION_API = '$api_url';|" "$CFG" > "$CFG.tmp" \
    && mv -f "$CFG.tmp" "$CFG"

  api_line="$(grep -n "$API_LINE_RE" "$CFG" | head -n1)"
  case "$api_line" in
    *REPLACE_WORKER_SUBDOMAIN*)
      die "rewrite failed: dist/client/js/config.js still has the placeholder in PRODUCTION_API ($api_line)" ;;
  esac
  case "$api_line" in
    *"'$api_url';"*) : ;;
    *) die "rewrite failed: $api_url is not in dist/client/js/config.js ($api_line)" ;;
  esac
  ok "API origin baked into dist: $api_url"
  info "dist/client/js/config.js:$api_line"

  # The literal also lives in the API_CONFIGURED guard a few lines below, and
  # it must stay: that guard is what keeps an unconfigured build offline-only.
  left="$(grep -c 'REPLACE_WORKER_SUBDOMAIN' "$CFG" | tr -d ' ')"
  info "placeholder still on $left line(s) of the dist copy — the API_CONFIGURED guard, expected"

  grep -q "REPLACE_WORKER_SUBDOMAIN" "$ROOT/client/js/config.js" \
    || die "source client/js/config.js lost its placeholder — this script must never write to client/"
  ok "source client/js/config.js untouched"
  API_SUMMARY="$api_url"
else
  printf '\n    %s!!  WORKER_ORIGIN is not set — the published client will run OFFLINE-ONLY%s\n' "$Y" "$Z"
  warn "no leaderboard, no duels, no shop, no purchases: client/js/net.js refuses"
  warn "to call the placeholder address, so every screen falls back to offline."
  warn "The daily arena and practice still work."
  warn "To fix it, deploy the Worker and re-run:"
  warn "  WORKER_ORIGIN=https://<worker>.<subdomain>.workers.dev bash scripts/deploy.sh"
fi

# ----------------------------------------------------------------- 4. verify
step "4/6  verify dist/ (relative imports, pages, no secrets)"
RIC_DIST="$DIST" node - <<'NODE' || die "dist/ layout is broken — see the failures above"
const fs = require('fs');
const path = require('path');
const dist = fs.realpathSync(process.env.RIC_DIST);

const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.m?js$/.test(e.name)) files.push(p);
  }
})(dist);

const patterns = [
  /\bfrom\s*['"](\.[^'"]+)['"]/g,     // import x from './y.js'
  /\bimport\s*['"](\.[^'"]+)['"]/g,   // import './y.js'
  /\bimport\s*\(\s*['"](\.[^'"]+)['"]/g,
];

let checked = 0, bad = 0;
for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');
  for (const re of patterns) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(src)) !== null) {
      const spec = m[1];
      const target = path.resolve(path.dirname(file), spec);
      const rel = (p) => path.relative(dist, p) || '.';
      checked++;
      if (!target.startsWith(dist + path.sep)) {
        bad++;
        console.log(`    FAIL ${rel(file)} -> ${spec} escapes dist/`);
      } else if (!fs.existsSync(target)) {
        bad++;
        console.log(`    FAIL ${rel(file)} -> ${spec} (no such file: ${rel(target)})`);
      } else {
        console.log(`    ok  ${rel(file)}  ->  ${rel(target)}`);
      }
    }
  }
}

// The one import the whole layout exists for.
const anchor = path.join(dist, 'client', 'js', 'app.js');
const shared = path.resolve(path.dirname(anchor), '../../shared/sim.js');
if (!fs.existsSync(anchor) || !fs.existsSync(shared)) {
  console.log('    FAIL client/js/app.js + ../../shared/sim.js do not both exist');
  bad++;
} else {
  console.log('    ok  anchor: client/js/app.js  ../../shared/sim.js  resolves to shared/sim.js');
}

console.log(`    ${checked} relative imports checked, ${bad} broken`);
process.exit(bad ? 1 : 0);
NODE

# Nothing in a published build may carry a token. Bot tokens look like
# 1234567890:AA... ; Cloudflare tokens and private keys are caught too.
if grep -REn --binary-files=without-match \
     -e '[0-9]{8,12}:[A-Za-z0-9_-]{30,}' \
     -e 'CLOUDFLARE_API_TOKEN[[:space:]]*=[[:space:]]*[A-Za-z0-9_-]{10,}' \
     -e 'BEGIN [A-Z ]*PRIVATE KEY' \
     "$DIST" >/dev/null 2>&1; then
  grep -REn --binary-files=without-match \
     -e '[0-9]{8,12}:[A-Za-z0-9_-]{30,}' \
     -e 'CLOUDFLARE_API_TOKEN[[:space:]]*=[[:space:]]*[A-Za-z0-9_-]{10,}' \
     -e 'BEGIN [A-Z ]*PRIVATE KEY' \
     "$DIST" | head -n 5
  die "something that looks like a secret is inside dist/ — remove it before publishing"
fi
ok "no token-shaped strings in dist/"

info "client API base in this build: $API_SUMMARY"
case "$API_SUMMARY" in
  https://*)
    warn "cross-origin setup: the Worker must allow this site in its ORIGIN var,"
    warn "e.g. ORIGIN = \"https://<user>.github.io\" in worker/wrangler.toml,"
    warn "otherwise the browser blocks every /api call on CORS." ;;
esac

# ------------------------------------------------------- 5. next commands
step "5/6  next commands — copy/paste, nothing below was executed"

if [ -f "$ROOT/worker/wrangler.toml" ] || [ -f "$ROOT/worker/wrangler.jsonc" ] || [ -f "$ROOT/worker/wrangler.json" ]; then
  info "found a wrangler config in worker/"
else
  warn "worker/ has no wrangler config yet — the block below is the shape to create"
fi

cat <<'EOF'

  --- A. Cloudflare Worker + D1 -------------------------------------------
  cd worker

  # first time only
  wrangler d1 create ricochet                 # put database_id into wrangler.toml
                                              # (it still says REPLACE_WITH_D1_DATABASE_ID)
  wrangler d1 execute ricochet --remote --file=./schema.sql

  # all six are secrets per worker/wrangler.toml — never in a file, never in git
  wrangler secret put BOT_TOKEN               # from @BotFather
  wrangler secret put TOKEN_SECRET            # openssl rand -hex 32
  wrangler secret put WEBHOOK_SECRET          # also the webhook URL path segment
  wrangler secret put ORIGIN                  # https://<user>.github.io  (CORS)
  wrangler secret put BOT_USERNAME            # without the @
  wrangler secret put OWNER_ID                # your telegram numeric id
  # local dev reads worker/.dev.vars instead (git-ignored, same names)

  wrangler deploy                             # prints the workers.dev URL
  wrangler tail                               # live logs while you test
  curl -sS https://<worker>.<subdomain>.workers.dev/api/health

  # then rebuild the client against that URL — otherwise it stays offline-only:
  cd .. && WORKER_ORIGIN=https://<worker>.<subdomain>.workers.dev bash scripts/deploy.sh

  --- B. GitHub Pages (publishes dist/, run from the repo root) ------------
  # one worktree, reused on every release; nothing touches your working tree
  git worktree add ../ricochet-ghpages gh-pages 2>/dev/null \
    || git worktree add -b gh-pages ../ricochet-ghpages

  rsync -a --delete --exclude '.git' dist/ ../ricochet-ghpages/
  git -C ../ricochet-ghpages add -A
  git -C ../ricochet-ghpages commit -m "deploy $(date +%Y-%m-%d)" || echo "nothing changed"
  git -C ../ricochet-ghpages push -u origin gh-pages

  # then, once: GitHub repo -> Settings -> Pages -> Branch: gh-pages, folder / (root)

  --- C. Telegram ----------------------------------------------------------
  # Mini App URL (https, must match what you set in @BotFather):
  #   https://<user>.github.io/<repo>/client/
  # Landing / legal pages for @app_moderation_bot:
  #   https://<user>.github.io/<repo>/
  #   https://<user>.github.io/<repo>/terms.html
  #   https://<user>.github.io/<repo>/privacy.html
  # Full checklist: scripts/botfather.md

EOF

origin="$(git -C "$ROOT" remote get-url origin 2>/dev/null || true)"
if [ -n "$origin" ]; then
  info "git origin: $origin"
else
  warn "no git remote 'origin' yet — add one before step B:"
  warn "  git -C $ROOT remote add origin git@github.com:<user>/<repo>.git"
fi
if ! git -C "$ROOT" rev-parse HEAD >/dev/null 2>&1; then
  warn "this repo has no commits yet — commit before step B"
fi

# --------------------------------------------------------------- 6. summary
step "6/6  summary"
printf '    %s%-22s%s %s\n' "$B" "tests" "$Z" "passed: $RAN"
printf '    %s%-22s%s %s\n' "$B" "built" "$Z" "$DIST"
printf '    %s%-22s%s %s\n' "$B" "site root" "$Z" "index.html, terms.html, privacy.html, .nojekyll"
printf '    %s%-22s%s %s\n' "$B" "game" "$Z" "dist/client/  (imports resolve to dist/shared/)"
printf '    %s%-22s%s %s\n' "$B" "API base" "$Z" "$API_SUMMARY"
printf '    %s%-22s%s %s\n' "$B" "bytes" "$Z" "$(du -sh "$DIST" | awk '{print $1}')"
printf '    %s%-22s%s %s\n' "$B" "deployed" "$Z" "NO — this script only prints the commands above"
printf '    %s%-22s%s %s\n' "$B" "pushed" "$Z" "NO"
printf '\n%sdone.%s Review the two blocks above, then run them by hand.\n\n' "$G" "$Z"
