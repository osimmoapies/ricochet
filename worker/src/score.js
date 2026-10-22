// Authoritative scoring.
//
// The client's number is a hint, never a fact. Every submitted run is replayed
// here through the same shared/sim.js the phone ran, on a board whose seed the
// server derives itself. Two things a cheat needs are therefore both closed:
// you cannot submit a score for a board nobody else played, and you cannot
// submit a score the inputs do not produce.

import { runMatch, MAX_SHOTS } from '../../shared/sim.js';
import { daily, dayIndex } from '../../shared/daily.js';

export const MAX_LEVEL = 6;

export function clampLevel(v) {
  const n = v | 0;
  return n < 0 ? 0 : (n > MAX_LEVEL ? MAX_LEVEL : n);
}

/**
 * Which board is this run allowed to be on?
 *   daily — today's seed and level, recomputed here; a client-supplied seed
 *           that is not today's is the whole thing we are guarding against
 *           (yesterday's easy board, or a hand-picked generous one).
 *   duel  — the seed stored with the duel, not the one in the body.
 */
export function resolveBoard(body, nowMs, duel) {
  const mode = body && typeof body.mode === 'string' ? body.mode : '';
  if (mode === 'daily') {
    const d = daily(nowMs);
    if ((body.seed | 0) !== d.seed) return { ok: false, error: 'stale_seed' };
    if ((body.level | 0) !== d.level) return { ok: false, error: 'bad_level' };
    return { ok: true, mode, seed: d.seed, level: d.level, dayIdx: d.dayIdx };
  }
  if (mode === 'duel') {
    if (!duel) return { ok: false, error: 'unknown_duel' };
    const seed = duel.seed | 0;
    const level = clampLevel(duel.level);
    // the client must have played the board it was handed
    if (body.seed !== undefined && (body.seed | 0) !== seed) return { ok: false, error: 'bad_seed' };
    return { ok: true, mode, seed, level, dayIdx: dayIndex(nowMs) };
  }
  return { ok: false, error: 'bad_mode' };
}

/** Shot lists arrive from the wire; shape-check before sim.js sees them. */
export function replay(seed, level, shots) {
  if (!Array.isArray(shots) || shots.length === 0 || shots.length > MAX_SHOTS) return null;
  for (let i = 0; i < shots.length; i++) {
    const s = shots[i];
    if (!s || typeof s !== 'object' || Array.isArray(s)) return null;
  }
  return runMatch(seed, level, shots);      // null on anything sanitizeShot hates
}

/**
 * Full check for POST /api/run and a duel answer.
 * On success `score` is the replayed score, which is what gets stored and
 * returned — the client knows to overwrite its own display with it.
 */
export function validateRun(body, nowMs, duel) {
  const board = resolveBoard(body, nowMs, duel);
  if (!board.ok) return board;
  const res = replay(board.seed, board.level, body && body.shots);
  if (!res) return { ok: false, error: 'bad_shots' };
  const claimed = body && Number.isFinite(body.clientScore) ? body.clientScore | 0 : null;
  return {
    ok: true,
    mode: board.mode,
    seed: board.seed,
    level: board.level,
    dayIdx: board.dayIdx,
    score: res.score,
    cleared: res.cleared,
    shotsUsed: res.shotsUsed,
    claimed,
    inflated: claimed !== null && claimed > res.score,
  };
}

/** A duel is stored only if its own inputs really produce its own score. */
export function validateDuel(body, nowMs) {
  if (!body) return { ok: false, error: 'bad_body' };
  const seed = body.seed | 0;
  if (seed === 0 && body.seed !== 0) return { ok: false, error: 'bad_seed' };
  const level = clampLevel(body.level);
  const res = replay(seed, level, body.shots);
  if (!res) return { ok: false, error: 'bad_shots' };
  const claimed = Number.isFinite(body.score) ? body.score | 0 : null;
  return {
    ok: true,
    seed,
    level,
    dayIdx: dayIndex(nowMs),
    score: res.score,
    cleared: res.cleared,
    claimed,
    inflated: claimed !== null && claimed > res.score,
  };
}
