// The live game: input, loop, ghost playback.
//
// The ghost is the trick that makes a one-player app feel like a duel. The
// opponent's recorded shots are replayed in lockstep with yours on the same
// board, so you watch their ball race yours — with no server holding a live
// match open, and no opponent who has to be online at the same minute.
import * as S from '../../shared/sim.js';
import * as A from './audio.js';
import { haptic } from './tg.js';

const MAX_PULL = 22;          // arena units of drag for full power
const MIN_PULL = 2.4;         // below this a drag counts as a cancelled aim
const TRAIL_POINTS = 30;
const SETTLE_DELAY = 0.55;    // seconds to admire the result before next shot
const MAX_STEPS_PER_FRAME = 28;

function cloneState(st) {
  return {
    arena: st.arena, step: st.step, shotIndex: st.shotIndex, score: st.score,
    alive: st.alive.slice(), breakAlive: st.breakAlive.slice(),
    shots: [], cleared: st.cleared,
  };
}

export function createGame(opts) {
  const { renderer, canvas } = opts;
  let arena = null;
  let state = null;
  let ball = null;
  let phase = 'idle';          // idle | aim | flight | settle | done
  let shotsRecorded = [];
  let trail = [];
  let timeScale = 1;
  let slowMoLeft = 0;
  let settleLeft = 0;
  let running = false;
  let lastTime = 0;
  let acc = 0;

  // aiming
  let aiming = false;
  let aimStart = null;
  let aimCur = null;
  let aimView = { active: false, dirx: 0, diry: -1, pull: 0, path: null, solidPoints: 0 };
  let pointerId = null;
  // Visual/feel state only. The band is a rubber band, so the tension has to
  // be felt in steps as it stretches, not announced once at the end.
  let tensionStep = -1;
  const nudgeDir = { x: 0, y: 1 };

  // ghost
  let ghost = null;            // {state, ball, shots, idx, trail, score, visible}

  // stats for the caller
  let onEnd = opts.onEnd || (() => { });
  let onHud = opts.onHud || (() => { });
  let onShotEnd = opts.onShotEnd || (() => { });

  const events = [];

  function start(a, skin, ghostShots) {
    arena = a;
    state = S.createState(arena);
    renderer.setArena(arena, skin);
    shotsRecorded = [];
    trail = [];
    phase = 'aim';
    timeScale = 1; slowMoLeft = 0; settleLeft = 0;
    aiming = false; aimView.active = false; pointerId = null;
    ghost = null;
    if (ghostShots && ghostShots.length) {
      const gs = [];
      for (const r of ghostShots) {
        const s = S.sanitizeShot(r);
        if (s) gs.push(s);
      }
      if (gs.length) {
        ghost = {
          state: S.createState(arena), ball: null, shots: gs, idx: 0,
          trail: [], score: 0, visible: false, finished: false,
        };
      }
    }
    pushHud();
    if (!running) { running = true; lastTime = 0; requestAnimationFrame(tick); }
  }

  function stop() { running = false; phase = 'idle'; }

  function pushHud() {
    onHud({
      score: state ? state.score : 0,
      ghostScore: ghost ? ghost.state.score : null,
      shotsLeft: state ? S.MAX_SHOTS - state.shotIndex : S.MAX_SHOTS,
      targetsLeft: state ? S.targetsLeft(state) : 0,
      totalTargets: arena ? arena.targets.length : 0,
      phase,
      nudgeAvailable: phase === 'flight' && ball && ball.shot.nf < 0,
      cleared: state ? state.cleared : false,
    });
  }

  // ---------------------------------------------------------------- input
  function localPoint(e) {
    const rect = canvas.getBoundingClientRect();
    return renderer.toArena(e.clientX - rect.left, e.clientY - rect.top);
  }

  function onDown(e) {
    A.unlock();
    if (phase === 'aim') {
      if (pointerId !== null) return;
      pointerId = e.pointerId;
      aiming = true;
      aimStart = localPoint(e);
      aimCur = aimStart;
      updateAim();
      // capture can throw if the pointer is already gone (and always throws
      // for synthetic events); losing capture is survivable, a dead handler
      // is not
      try { canvas.setPointerCapture && canvas.setPointerCapture(e.pointerId); } catch (err) { }
    } else if (phase === 'flight' && ball && ball.shot.nf < 0) {
      // tap anywhere: shove the ball toward where you tapped
      const p = localPoint(e);
      const dx = p.x - ball.x, dy = p.y - ball.y;
      const len = Math.sqrt(dx * dx + dy * dy);
      if (len < 0.5) return;
      const ok = S.armNudge(ball, Math.round((dx / len) * 10000), Math.round((dy / len) * 10000));
      if (ok) {
        nudgeDir.x = dx / len; nudgeDir.y = dy / len;
        A.sNudge(); haptic('medium'); pushHud();
      }
    }
    e.preventDefault();
  }

  function onMove(e) {
    if (!aiming || e.pointerId !== pointerId) return;
    aimCur = localPoint(e);
    updateAim();
    e.preventDefault();
  }

  function onUp(e) {
    if (!aiming || e.pointerId !== pointerId) return;
    aiming = false;
    pointerId = null;
    const shot = currentAimShot();
    aimView.active = false;
    if (shot) launch(shot);
    e.preventDefault();
  }

  function onCancel() {
    aiming = false; pointerId = null; aimView.active = false;
  }

  function currentAimShot() {
    if (!aimStart || !aimCur) return null;
    const pvx = aimCur.x - aimStart.x, pvy = aimCur.y - aimStart.y;
    const len = Math.sqrt(pvx * pvx + pvy * pvy);
    if (len < MIN_PULL) return null;
    const dx = Math.round((-pvx / len) * 10000);
    const dy = Math.round((-pvy / len) * 10000);
    let pull = len / MAX_PULL;
    if (pull > 1) pull = 1;
    return S.sanitizeShot({ dx, dy, p: Math.round(pull * 1000), nf: -1, ndx: 0, ndy: 0 });
  }

  function updateAim() {
    const shot = currentAimShot();
    if (!shot) { aimView.active = false; tensionStep = -1; return; }
    const dir = Math.sqrt(shot.dx * shot.dx + shot.dy * shot.dy) || 1;
    aimView.active = true;
    aimView.dirx = shot.dx / dir;
    aimView.diry = shot.dy / dir;
    aimView.pull = shot.p / 1000;

    // one tick per quarter of draw, then a firmer one at full power
    const stepNow = aimView.pull >= 0.995 ? 4 : Math.floor(aimView.pull * 4);
    if (stepNow !== tensionStep) {
      if (stepNow > tensionStep) haptic(stepNow >= 4 ? 'rigid' : 'light');
      tensionStep = stepNow;
    }

    // Predict only to the first contact, plus a short fading hint past it.
    // Showing the whole future would remove the game.
    const st2 = cloneState(state);
    const b = S.beginShot(st2, { ...shot });
    const path = [];
    const ev = [];
    let solid = 0;
    let steps = 0;
    for (; steps < 900; steps++) {
      const r = S.stepShot(st2, b, ev);
      if ((steps % 3) === 0) path.push(b.x, b.y);
      if (ev.length) break;
      if (r !== 'flying') break;
    }
    solid = path.length / 2;
    const extra = Math.min(140, Math.max(30, Math.round(steps * 0.5)));
    for (let i = 0; i < extra; i++) {
      const r = S.stepShot(st2, b, null);
      if ((i % 3) === 0) path.push(b.x, b.y);
      if (r !== 'flying') break;
    }
    aimView.path = path;
    aimView.solidPoints = solid;
  }

  // ---------------------------------------------------------------- flow
  function launch(shot) {
    ball = S.beginShot(state, shot);
    shotsRecorded.push(shot);
    trail = [];
    phase = 'flight';
    tensionStep = -1;
    A.sLaunch(shot.p / 1000);
    haptic(shot.p > 800 ? 'heavy' : 'medium');
    // cosmetic only: tells the renderer where and how hard to kick
    const d = Math.sqrt(shot.dx * shot.dx + shot.dy * shot.dy) || 1;
    renderer.onEvent({
      t: 'launch', x: S.LAUNCH_X, y: S.LAUNCH_Y,
      dx: shot.dx / d, dy: shot.dy / d, p: shot.p / 1000,
    });

    if (ghost && !ghost.finished) {
      if (ghost.idx < ghost.shots.length && S.targetsLeft(ghost.state) > 0) {
        ghost.ball = S.beginShot(ghost.state, ghost.shots[ghost.idx]);
        ghost.trail = [];
        ghost.visible = true;
      } else {
        ghost.visible = false;
        ghost.finished = true;
      }
    }
    pushHud();
  }

  function finishCurrentShot() {
    const res = S.endShot(state, ball);
    const reason = ball.done;
    renderer.onEvent({ t: 'settle', x: ball.x, y: ball.y, reason });
    ball = null;
    phase = 'settle';
    settleLeft = SETTLE_DELAY;
    if (res.clearBonus) {
      A.sClear();
      haptic('success');
      renderer.onEvent({ t: 'clear', score: res.clearBonus });
      settleLeft = SETTLE_DELAY + 0.75;    // hold on the celebration
    }
    onShotEnd(res, reason);
    pushHud();
  }

  function advanceGhost(steps) {
    if (!ghost || ghost.finished) return;
    for (let i = 0; i < steps; i++) {
      if (!ghost.ball) break;
      const r = S.stepShot(ghost.state, ghost.ball, null);
      if (r !== 'flying') {
        S.endShot(ghost.state, ghost.ball);
        ghost.idx++;
        ghost.ball = null;
        ghost.visible = false;
        if (ghost.idx >= ghost.shots.length || S.targetsLeft(ghost.state) === 0) ghost.finished = true;
        break;
      }
    }
    if (ghost.ball) {
      ghost.trail.push(ghost.ball.x, ghost.ball.y);
      if (ghost.trail.length > TRAIL_POINTS * 2) ghost.trail.splice(0, 2);
    }
  }

  function nextShotOrEnd() {
    if (S.targetsLeft(state) === 0 || state.shotIndex >= S.MAX_SHOTS) {
      phase = 'done';
      pushHud();
      // let the ghost finish its remaining shots so the comparison is fair
      if (ghost) {
        let guard = 0;
        while (!ghost.finished && guard++ < 40) {
          if (!ghost.ball) {
            if (ghost.idx >= ghost.shots.length || S.targetsLeft(ghost.state) === 0) { ghost.finished = true; break; }
            ghost.ball = S.beginShot(ghost.state, ghost.shots[ghost.idx]);
          }
          let r = 'flying';
          let st = 0;
          while (r === 'flying' && st++ < S.MAX_SHOT_STEPS) r = S.stepShot(ghost.state, ghost.ball, null);
          S.endShot(ghost.state, ghost.ball);
          ghost.ball = null;
          ghost.idx++;
        }
        ghost.visible = false;
      }
      onEnd({
        score: state.score,
        cleared: state.cleared,
        shots: shotsRecorded.map(s => ({ dx: s.dx, dy: s.dy, p: s.p, nf: s.nf, ndx: s.ndx, ndy: s.ndy })),
        shotsUsed: state.shotIndex,
        targetsLeft: S.targetsLeft(state),
        ghostScore: ghost ? ghost.state.score : null,
        perShot: state.shots.map(r => ({ score: r.score, chain: r.chain })),
      });
    } else {
      phase = 'aim';
      pushHud();
    }
  }

  // ---------------------------------------------------------------- loop
  function tick(now) {
    if (!running) return;
    requestAnimationFrame(tick);
    if (!lastTime) { lastTime = now; return; }
    let dt = (now - lastTime) / 1000;
    lastTime = now;
    if (dt > 0.05) dt = 0.05;          // a long stall must not teleport the ball

    if (slowMoLeft > 0) {
      slowMoLeft -= dt;
      timeScale = 0.42;
      if (slowMoLeft <= 0) timeScale = 1;
    }
    const sdt = dt * timeScale;

    if (phase === 'flight' && ball) {
      acc += sdt;
      let steps = Math.floor(acc / S.DT);
      if (steps > MAX_STEPS_PER_FRAME) { steps = MAX_STEPS_PER_FRAME; acc = 0; }
      else acc -= steps * S.DT;
      events.length = 0;
      let status = 'flying';
      let tagged = 0;
      for (let i = 0; i < steps; i++) {
        status = S.stepShot(state, ball, events);
        // Stamp each new event with the velocity it left the surface at. After
        // a bounce that vector is the surface normal, which is what lets the
        // renderer aim the impact flash and the scuff. Cosmetic fields only.
        while (tagged < events.length) {
          events[tagged].bvx = ball.vx;
          events[tagged].bvy = ball.vy;
          tagged++;
        }
        if (status !== 'flying') break;
      }
      advanceGhost(steps);

      for (const ev of events) {
        if (ev.t === 'nudge') { ev.ndx = nudgeDir.x; ev.ndy = nudgeDir.y; }
        renderer.onEvent(ev);
        if (ev.t === 'target') {
          A.sTarget(ev.mult >= 4 ? 4 + (ev.mult >= 6 ? 2 : 0) : ev.mult);
          if (ev.mult >= 3 && slowMoLeft <= 0) slowMoLeft = 0.28;
          if (ev.mult >= 3) haptic(ev.mult >= 6 ? 'heavy' : 'medium');
        } else if (ev.t === 'bumper') A.sBumper();
        else if (ev.t === 'break') A.sBreak();
        else if (ev.t === 'wall') { if (ev.imp > 40) A.sWall(ev.imp); }
        else if (ev.t === 'portal') A.sPortal();
      }
      if (events.length) pushHud();

      trail.push(ball.x, ball.y);
      if (trail.length > TRAIL_POINTS * 2) trail.splice(0, 2);

      if (status !== 'flying') finishCurrentShot();
    } else if (phase === 'settle') {
      settleLeft -= dt;
      advanceGhost(Math.round(sdt / S.DT));
      if (settleLeft <= 0) nextShotOrEnd();
    }

    // mover positions for the renderer
    const offsets = new Map();
    if (arena) {
      for (const s of arena.segs) {
        if (s.kind === 'mover') offsets.set(s, S.moverOffsetAt(s, state ? state.step + (ball ? ball.s : 0) : 0));
      }
    }

    renderer.frame(sdt, {
      alive: state ? state.alive : null,
      breakAlive: state ? state.breakAlive : null,
      ball: ball ? { x: ball.x, y: ball.y, vx: ball.vx, vy: ball.vy } : (phase === 'aim' ? { x: S.LAUNCH_X, y: S.LAUNCH_Y, vx: 0, vy: 0 } : null),
      trail: ball ? trail : null,
      aim: aimView,
      ghost: ghost && ghost.visible && ghost.ball
        ? { visible: true, x: ghost.ball.x, y: ghost.ball.y, trail: ghost.trail }
        : null,
      moverOffsets: offsets,
    });
  }

  canvas.addEventListener('pointerdown', onDown, { passive: false });
  canvas.addEventListener('pointermove', onMove, { passive: false });
  canvas.addEventListener('pointerup', onUp, { passive: false });
  canvas.addEventListener('pointercancel', onCancel, { passive: false });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  return {
    start, stop,
    get phase() { return phase; },
    get score() { return state ? state.score : 0; },
    get ghostScore() { return ghost ? ghost.state.score : null; },
  };
}
