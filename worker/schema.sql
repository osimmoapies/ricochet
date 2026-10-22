-- РИКОШЕТ — D1 schema.
--
-- Safe to re-run: every statement is IF NOT EXISTS.
--   wrangler d1 execute ricochet --remote --file=worker/schema.sql
--
-- Timestamps are milliseconds. `day_idx` is days since 1970-01-01 UTC, the
-- same integer shared/daily.js derives, so the daily board and the daily
-- leaderboard are keyed by the same number on both sides.

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,          -- Telegram user id
  name          TEXT    NOT NULL DEFAULT 'Player',
  skin          TEXT    NOT NULL DEFAULT 'default',
  owned         TEXT    NOT NULL DEFAULT '[]',  -- JSON array of skin ids
  season_until  INTEGER NOT NULL DEFAULT 0,     -- ms; pass is live while > now
  best_score    INTEGER NOT NULL DEFAULT 0,
  clears        INTEGER NOT NULL DEFAULT 0,
  duel_wins     INTEGER NOT NULL DEFAULT 0,
  runs          INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL DEFAULT 0,
  seen_at       INTEGER NOT NULL DEFAULT 0
);

-- all-time leaderboard: best score per player, straight off the index
CREATE INDEX IF NOT EXISTS users_best ON users (best_score DESC, id ASC);

CREATE TABLE IF NOT EXISTS runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL,
  day_idx     INTEGER NOT NULL,
  mode        TEXT    NOT NULL,              -- 'daily' | 'duel'
  duel_id     TEXT,                          -- set when the run answers a duel
  seed        INTEGER NOT NULL,
  level       INTEGER NOT NULL,
  score       INTEGER NOT NULL,              -- server's replayed score, never the client's
  cleared     INTEGER NOT NULL DEFAULT 0,
  shots       TEXT    NOT NULL,              -- JSON, sanitised; replays the run
  created_at  INTEGER NOT NULL
);

-- today's leaderboard and the rank query both filter by day and sort by score
CREATE INDEX IF NOT EXISTS runs_day_score ON runs (day_idx, score DESC);
-- the same query groups by player; this keeps the grouping off a table scan
CREATE INDEX IF NOT EXISTS runs_day_user_score ON runs (day_idx, user_id, score DESC);
-- "has this player already answered this duel" (one win per duel per player)
CREATE INDEX IF NOT EXISTS runs_duel_user ON runs (duel_id, user_id);
CREATE INDEX IF NOT EXISTS runs_user_created ON runs (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS duels (
  id           TEXT    PRIMARY KEY,          -- 12 chars, [0-9A-Za-z]; travels in startapp=d_<id>
  user_id      INTEGER NOT NULL,
  name         TEXT    NOT NULL DEFAULT 'Player',
  seed         INTEGER NOT NULL,
  level        INTEGER NOT NULL,
  shots        TEXT    NOT NULL,             -- the ghost the challenged player races
  score        INTEGER NOT NULL,             -- replayed, so a duel cannot be an unbeatable lie
  answers      INTEGER NOT NULL DEFAULT 0,
  best_answer  INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS duels_user_created ON duels (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS purchases (
  charge_id    TEXT    PRIMARY KEY,          -- telegram_payment_charge_id: the idempotency key
  user_id      INTEGER NOT NULL,
  item         TEXT    NOT NULL,
  stars        INTEGER NOT NULL DEFAULT 0,
  payload      TEXT,
  refunded     INTEGER NOT NULL DEFAULT 0,
  refunded_at  INTEGER,
  created_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS purchases_user ON purchases (user_id, created_at DESC);

-- Rate limits: one row per player per bucket per fixed window.
CREATE TABLE IF NOT EXISTS rates (
  user_id       INTEGER NOT NULL,
  bucket        TEXT    NOT NULL,            -- 'run' (60/h) | 'duel' (30/day)
  window_start  INTEGER NOT NULL,
  count         INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, bucket, window_start)
);

-- old windows are dead weight; delete them whenever it is convenient:
--   DELETE FROM rates WHERE window_start < <now_ms> - 172800000;
CREATE INDEX IF NOT EXISTS rates_window ON rates (window_start);
