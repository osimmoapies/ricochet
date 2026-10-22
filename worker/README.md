# РИКОШЕТ — worker

Cloudflare Worker + D1. Serves `/api/*` for the Mini App and `/webhook/<secret>`
for the bot. Zero npm dependencies: the only tool needed is `wrangler`.

The game is playable with this Worker switched off (the daily board is derived
from the date on both sides), so a failed deploy breaks the leaderboard, duels
and the shop — not the game.

## Files

| file | what it is |
|---|---|
| `src/index.js` | router, CORS, the whole request surface |
| `src/auth.js` | initData validation + our 12 h bearer token (Web Crypto only) |
| `src/score.js` | board resolution + authoritative replay through `shared/sim.js` |
| `src/prices.js` | Stars price table, copied from `client/js/skins.js` |
| `src/ratelimit.js` | 60 runs/hour, 30 duels/day, counted in D1, fails closed |
| `src/db.js` | every D1 query |
| `src/telegram.js` | Bot API calls |
| `src/webhook.js` | `/start`, payments, refunds, `/delete` |
| `schema.sql` | D1 tables and indices, safe to re-run |
| `test/worker.test.mjs` | `node worker/test/worker.test.mjs` — no network, no token |

## Tests first

From the repository root:

```sh
node worker/test/worker.test.mjs      # worker: auth, replay, prices, limits, /delete
node tests/sim.test.mjs               # physics (owned by another file set)
node tests/golden.test.mjs            # physics is still byte-identical
node tests/attack.test.mjs            # adversarial suite, must stay 0 BROKEN
```

No network, no bot token, no D1. Run them before every deploy: they are the
only check that the server still scores a run the same way the phone did.

## Deploy, in order

Wrangler itself is a download (~30 MB on first use) — do it on real Wi-Fi, not
on the phone hotspot. Either `npm i -g wrangler` once, or prefix every command
below with `npx`.

```sh
# 0. from the repository root
cd worker

# 1. log in (opens a browser tab once, on the machine you deploy from)
wrangler login

# 2. create the database and paste the printed database_id into wrangler.toml
wrangler d1 create ricochet

# 3. tables and indices (re-runnable)
wrangler d1 execute ricochet --remote --file=./schema.sql

# 4. edit wrangler.toml [vars] — plain configuration, visible in the dashboard
#    and in a diff: ORIGIN, BOT_USERNAME, OWNER_ID, PAGES_URL, MINIAPP_URL.
#    Every one of them ships with a REPLACE placeholder; OWNER_ID = "0" means
#    /refund answers nobody.

# 5. the three real secrets, one prompt each — never in a file, never in git
wrangler secret put BOT_TOKEN        # from @BotFather
wrangler secret put TOKEN_SECRET     # openssl rand -hex 32
wrangler secret put WEBHOOK_SECRET   # openssl rand -hex 16

# 6. ship it
wrangler deploy

# 7. sanity check (replace with the URL wrangler printed)
curl -s https://ricochet.<subdomain>.workers.dev/api/health
#    -> {"ok":true,"serverTime":...}

# 8. point the bot at the webhook (same value as WEBHOOK_SECRET twice:
#    once in the path, once as the header Telegram will send back)
curl -s -X POST "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" \
  -H 'content-type: application/json' \
  -d '{"url":"https://ricochet.<subdomain>.workers.dev/webhook/<WEBHOOK_SECRET>",
       "secret_token":"<WEBHOOK_SECRET>",
       "allowed_updates":["message","pre_checkout_query"],
       "drop_pending_updates":true}'

# 9. verify Telegram accepted it
curl -s "https://api.telegram.org/bot<BOT_TOKEN>/getWebhookInfo"
```

Then in @BotFather: `/newapp` (or `/setmenubutton`) pointing at the same
`ORIGIN`, and `/setcommands` with at least:

```
start - Играть
paysupport - Оплата и возвраты
delete - Удалить мои данные
```

`paysupport` is not optional — Telegram requires a payment-support reply from
any bot that takes Stars. `delete` is not optional either: `pages/privacy.html`
§9 promises it, and moderation checks promises.

`allowed_updates` above is deliberately only `message` and `pre_checkout_query`
— `/delete` confirms with a typed word, not a button, so no `callback_query` is
needed. (`successful_payment` arrives inside a `message`.)

## Local dev

```sh
cd worker
printf 'BOT_TOKEN=xxx\nTOKEN_SECRET=dev\nWEBHOOK_SECRET=dev\nORIGIN=http://127.0.0.1:5173\nBOT_USERNAME=ricochet_bot\nOWNER_ID=0\nPAGES_URL=http://127.0.0.1:5173\n' > .dev.vars
wrangler d1 execute ricochet --local --file=./schema.sql
wrangler dev --ip 127.0.0.1 --port 8787
```

`.dev.vars` holds live values and must stay out of git. Nothing binds to
anything but 127.0.0.1.

## Two things to know before it works end to end

1. **Same-origin API.** `client/js/net.js` calls `BASE = '/api'`, i.e. the
   client's own origin. On GitHub Pages that path does not exist, and CORS
   never even enters the picture — the request 404s at Pages. Either serve the
   client from this Worker (add an `assets` binding or a route on one
   hostname), or change `BASE` in the client to the Worker URL. Changing the
   client is somebody else's file; this Worker already sends the CORS headers
   for the cross-origin case (`ORIGIN` plus 127.0.0.1).
2. **Stars payouts.** Whether Stars can be withdrawn in Tajikistan is still
   the open question in `STATE.md`. The shop code is complete either way, but
   it is only revenue if Fragment pays out.

## Housekeeping

Old rate-limit windows are dead rows; delete them whenever convenient:

```sh
wrangler d1 execute ricochet --remote \
  --command "DELETE FROM rates WHERE window_start < strftime('%s','now')*1000 - 172800000"
```

Refunds: a player sends their `telegram_payment_charge_id` to the bot, you send
`/refund <charge_id>` from the owner account. That calls `refundStarPayment`,
marks the purchase refunded and takes the item back.

## Data deletion (`/delete`)

Two steps, on purpose: `/delete` explains and asks, `/delete confirm` (also
`/delete подтверждаю` or `/delete да`) erases. One typed word must never wipe a
profile by accident, and this is not undoable.

What `DB.deleteUserData` removes: the `users` row (profile, display name, score,
stats), every `runs` row of theirs including answers to other people's duels,
the `duels` they created, and their `rates` counters. What it keeps: the
`purchases` rows, with `payload` nulled — charge id, payer id, item, amount and
date only, no name. `refundStarPayment` needs the payer id and the charge id, so
a refund asked for after a deletion still has to be answerable. That is the same
promise `pages/privacy.html` §9 makes to the player.

Deleting is not a subscription cancellation — the 30-day pass can only be
stopped by the player in Telegram (Settings → My Stars → Subscriptions). The
bot's reply says so, in Russian and English, in one message.

Reopening the Mini App after a deletion is a normal first visit: `/api/auth`
recreates the row through `upsertUserAndTop`, `ensureUser` is the safety net on
the other routes, and the profile comes back empty. Covered by the last section
of `test/worker.test.mjs`, which runs `db.js` against an in-memory D1 fake.
