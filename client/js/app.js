// Bootstrap and screen flow.
//
// The whole app is built to work with no server at all: if /api is missing or
// the hotspot is down, the daily arena is derived locally from the date, the
// best score lives in CloudStorage, and the game is fully playable. The server
// only adds the leaderboard, duels and the shop. That is deliberate — a mini
// app whose first screen depends on a round-trip loses players on a slow phone.
import * as S from '../../shared/sim.js';
import { daily, randomSeed } from '../../shared/daily.js';
import * as TG from './tg.js';
import * as A from './audio.js';
import { t, setLang, getLang } from './i18n.js';
import { createRenderer } from './render.js';
import { createGame } from './game.js';
import { SKINS, SEASON_PASS, skinById, skinName, isUnlocked, unlockProgress } from './skins.js';
import { auth, api, submitRunSafe, flushQueue, queueSize } from './net.js';
import { API_CONFIGURED } from './config.js';
import { createLogo, rollNumber, reducedMotion } from './fx.js';

const $ = (id) => document.getElementById(id);
const stage = $('stage');

let renderer = null;
let game = null;
let online = false;
let profile = {
  owned: [], skin: 'default', sound: true, seasonUntil: 0,
  stats: { bestScore: 0, clears: 0, duelWins: 0, runs: 0 },
};
let dailyInfo = daily();
let currentMode = 'daily';     // daily | practice | duel
let currentArena = null;
let currentDuel = null;        // {id, name, score, shots}
let lastRun = null;
let topToday = null;
const logos = { boot: null, menu: null };

// ---------------------------------------------------------------- layout
function applyViewport() {
  const W = window.Telegram && window.Telegram.WebApp;
  let h = (W && (W.viewportStableHeight || W.viewportHeight)) || window.innerHeight;
  if (!h || h < 200) h = window.innerHeight;
  document.documentElement.style.setProperty('--app-h', h + 'px');
  const sa = TG.safeArea();
  document.documentElement.style.setProperty('--sa-top', (sa.top || 0) + 'px');
  document.documentElement.style.setProperty('--sa-bottom', (sa.bottom || 0) + 'px');
  if (renderer) renderer.resize();
  if (logos.boot) logos.boot.redraw();
  if (logos.menu) logos.menu.redraw();
}

// ---------------------------------------------------------------- screens
// Nothing in this app is an instant swap. A screen fades and scales out while
// the next one rises in with its children staggered, which is what makes a
// menu feel built rather than generated. The CSS owns the motion; this only
// owns the class flipping and the timers that undo it.
const SCREENS = ['boot', 'menu', 'result', 'leaders', 'shop', 'how'];
const ENTER_MS = 820;          // longest stagger (0.33s delay + 0.42s) plus slack
const LEAVE_MS = 190;
const screenTimers = new Map();

/** `name` null means "the game itself is on screen". */
function setScreen(name) {
  for (const s of SCREENS) {
    const el = $(s);
    const timer = screenTimers.get(s);
    if (s === name) {
      if (timer) clearTimeout(timer);
      el.classList.remove('leaving');
      const wasHidden = el.classList.contains('hidden');
      el.classList.remove('hidden');
      if (wasHidden || !el.classList.contains('entering')) {
        el.classList.remove('entering');
        void el.offsetWidth;                 // restart the animation
        el.classList.add('entering');
      }
      el.scrollTop = 0;
      screenTimers.set(s, setTimeout(() => {
        el.classList.remove('entering');
        screenTimers.delete(s);
      }, ENTER_MS));
    } else if (!el.classList.contains('hidden')) {
      if (timer) clearTimeout(timer);
      el.classList.remove('entering');
      el.classList.add('leaving');
      screenTimers.set(s, setTimeout(() => {
        el.classList.add('hidden');
        el.classList.remove('leaving');
        screenTimers.delete(s);
      }, reducedMotion() ? 0 : LEAVE_MS));
    }
  }
  // the mark only animates on the screen that is showing it
  if (logos.boot) (name === 'boot' ? logos.boot.play() : logos.boot.stop());
  if (logos.menu) (name === 'menu' ? logos.menu.play() : logos.menu.stop());
}

function show(name) {
  setScreen(name);
  $('hud').classList.add('hidden');
  $('hud').classList.remove('entering');
  TG.backButton(name !== 'menu' && name !== 'boot', goBack);
}

function showGame() {
  setScreen(null);
  const hud = $('hud');
  hud.classList.remove('hidden', 'entering');
  void hud.offsetWidth;
  hud.classList.add('entering');
  setTimeout(() => hud.classList.remove('entering'), 400);
  TG.backButton(true, goBack);
}

function goBack() { openMenu(); }

let toastTimer = null;
let toastHide = null;
function toast(msg, ms) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  void el.offsetWidth;
  el.classList.add('show');
  clearTimeout(toastTimer);
  clearTimeout(toastHide);
  toastTimer = setTimeout(() => {
    el.classList.remove('show');
    toastHide = setTimeout(() => el.classList.add('hidden'), 300);
  }, ms || 2200);
}

function applyTexts() {
  document.querySelectorAll('[data-t]').forEach((el) => {
    const k = el.getAttribute('data-t');
    const s = t(k);
    if (s) el.textContent = s;
  });
  document.documentElement.lang = getLang();
}

/** Replay the score-bump animation; it has to be restartable to be felt. */
function bump(el) {
  if (reducedMotion()) return;
  el.classList.remove('bump');
  void el.offsetWidth;
  el.classList.add('bump');
}

// ---------------------------------------------------------------- hud
let hudScoreShown = 0;
function renderHud(h) {
  const scoreEl = $('hudScore');
  if (h.score !== hudScoreShown) {
    // the number climbs instead of jumping, and the digits kick when it does
    rollNumber(scoreEl, h.score, h.score > hudScoreShown ? 420 : 0);
    if (h.score > hudScoreShown) bump(scoreEl);
    hudScoreShown = h.score;
  }

  const dots = $('hudShots');
  if (dots.childElementCount !== S.MAX_SHOTS) {
    dots.innerHTML = '';
    for (let i = 0; i < S.MAX_SHOTS; i++) dots.appendChild(document.createElement('i'));
  }
  for (let i = 0; i < S.MAX_SHOTS; i++) {
    const d = dots.children[i];
    d.classList.toggle('live', i < h.shotsLeft);
    d.classList.toggle('spent', i >= h.shotsLeft);
  }
  $('hudTargets').textContent = h.targetsLeft;
  $('hudTotal').textContent = h.totalTargets;

  const gb = $('hudGhostBox');
  if (h.ghostScore === null || h.ghostScore === undefined) gb.classList.add('hidden');
  else {
    gb.classList.remove('hidden');
    rollNumber($('hudGhost'), h.ghostScore, 420);
    $('hudGhostName').textContent = currentDuel ? (currentDuel.name || t('duel')) : t('ghostOn');
  }

  const hint = $('hudHint');
  if (h.phase === 'aim') {
    hint.textContent = t('tapToAim');
    hint.classList.remove('pulse');
  } else if (h.phase === 'flight') {
    hint.textContent = h.nudgeAvailable ? t('tapToNudge') : t('nudgeUsed');
    hint.classList.toggle('pulse', !!h.nudgeAvailable);
  } else {
    hint.textContent = '';
    hint.classList.remove('pulse');
  }
}

// ---------------------------------------------------------------- flow
function startRun(mode, opts = {}) {
  currentMode = mode;
  currentDuel = opts.duel || null;
  let seed, level;
  if (mode === 'daily') { seed = dailyInfo.seed; level = dailyInfo.level; }
  else if (mode === 'duel') { seed = opts.duel.seed; level = opts.duel.level; }
  else { seed = randomSeed(); level = Math.floor(Math.random() * 7); }

  currentArena = S.generateArena(seed, level);
  currentArena.__seed = seed;
  currentArena.__level = level;
  hudScoreShown = 0;
  $('hudScore').dataset.v = '0';
  $('hudScore').textContent = '0';
  $('hudGhost').dataset.v = '0';
  showGame();
  A.unlock();
  game.start(currentArena, skinById(profile.skin), opts.duel ? opts.duel.shots : null);
}

function onShotEnd(res) {
  if (res.hits && res.hits.length >= 3) TG.haptic('heavy');
  else if (res.hits && res.hits.length) TG.haptic('medium');
  else TG.haptic('light');
}

let revealTimer = null;
async function onRunEnd(run) {
  lastRun = run;
  profile.stats.runs = (profile.stats.runs || 0) + 1;
  if (run.score > (profile.stats.bestScore || 0)) profile.stats.bestScore = run.score;
  if (run.cleared) profile.stats.clears = (profile.stats.clears || 0) + 1;

  const verdict = $('resVerdict');
  const hasGhost = run.ghostScore !== null && run.ghostScore !== undefined;
  if (hasGhost) {
    const win = run.score > run.ghostScore;
    const draw = run.score === run.ghostScore;
    verdict.textContent = draw ? t('draw') : win ? t('youWin') : t('youLose');
    verdict.className = 'res-verdict ' + (draw ? '' : win ? 'win' : 'lose');
    if (win) { profile.stats.duelWins = (profile.stats.duelWins || 0) + 1; A.sWin(); TG.haptic('success'); }
    else if (!draw) { A.sFail(); TG.haptic('error'); }
  } else {
    verdict.textContent = run.cleared ? t('clear') : t('score');
    verdict.className = 'res-verdict' + (run.cleared ? ' win' : '');
    if (run.cleared) { A.sWin(); TG.haptic('success'); }
  }

  // Verdict, then your number climbing, then theirs, then the detail: the
  // reveal order is the order the player cares about.
  $('resScore').dataset.v = '0';
  $('resScore').textContent = '0';
  $('resVsBox').classList.toggle('hidden', !hasGhost);
  $('resTheirBox').classList.toggle('hidden', !hasGhost);
  if (hasGhost) {
    $('resTheir').dataset.v = '0';
    $('resTheir').textContent = '0';
    $('resTheirName').textContent = currentDuel ? (currentDuel.name || t('theirScore')) : t('ghostOn');
  }
  clearTimeout(revealTimer);
  revealTimer = setTimeout(() => {
    rollNumber($('resScore'), run.score, 760);
    if (hasGhost) setTimeout(() => rollNumber($('resTheir'), run.ghostScore, 620), 260);
  }, 260);

  const bits = [];
  const best = run.perShot && run.perShot.length
    ? run.perShot.reduce((m, s) => Math.max(m, s.chain || 0), 0) : 0;
  if (best >= 2) bits.push(t('chain') + ' x' + best);
  if (run.cleared) bits.push(t('noTargets'));
  bits.push(run.shotsUsed + '/' + S.MAX_SHOTS + ' ' + t('shots').toLowerCase());
  $('resMeta').textContent = bits.join(' · ');

  saveProfileLocal();
  show('result');

  // The score goes to the server for verification; the UI never waits on it.
  // The gate is API_CONFIGURED, not `online`: someone who opens the app in a
  // lift fails auth at boot, and gating on that would drop the run on the floor
  // instead of queueing it. submitRunSafe queues anything it cannot send.
  if (API_CONFIGURED && currentMode !== 'practice') {
    const body = {
      mode: currentMode,
      seed: currentArena.__seed,
      level: currentArena.__level,
      shots: run.shots,
      clientScore: run.score,
      duelId: currentDuel ? currentDuel.id : undefined,
    };
    const r = await submitRunSafe(body);
    if (r.ok && r.data) {
      if (r.data.rank) $('resMeta').textContent += ' · ' + t('rank') + ' ' + r.data.rank;
      if (r.data.score !== undefined && r.data.score !== run.score) {
        // The server replayed the inputs and got a different number. That is
        // either a cheat or a bug on our side; either way the server wins.
        rollNumber($('resScore'), r.data.score, 400);
        toast(t('sendError'));
      }
    } else if (r.queued) {
      toast(t('offline'));
    } else if (r.error) {
      toast(t('sendError') + ': ' + r.error);
    }
  }
}

// ---------------------------------------------------------------- profile
const LOCAL_KEY = 'ric.profile.v1';
function saveProfileLocal() {
  try { localStorage.setItem(LOCAL_KEY, JSON.stringify(profile)); } catch (e) { }
  TG.cloudSet('p', JSON.stringify({
    skin: profile.skin, sound: profile.sound, stats: profile.stats,
  }));
}
async function loadProfileLocal() {
  try {
    const s = localStorage.getItem(LOCAL_KEY);
    if (s) Object.assign(profile, JSON.parse(s));
  } catch (e) { }
  const cloud = await TG.cloudGet('p');
  if (cloud) {
    try {
      const c = JSON.parse(cloud);
      if (c.stats && (c.stats.bestScore || 0) > (profile.stats.bestScore || 0)) {
        profile.stats = { ...profile.stats, ...c.stats };
      }
      if (c.skin) profile.skin = c.skin;
      if (c.sound !== undefined) profile.sound = c.sound;
    } catch (e) { }
  }
  A.setEnabled(profile.sound !== false);
}

function refreshMenu() {
  $('statBest').textContent = profile.stats.bestScore ? profile.stats.bestScore : '—';
  $('statTop').textContent = topToday && topToday.score ? topToday.score : '—';
  $('btnSound').textContent = A.isEnabled() ? '🔊' : '🔇';
}

function openMenu() {
  if (game) game.stop();
  refreshMenu();
  show('menu');
}

// ---------------------------------------------------------------- leaderboard
async function openLeaders(scope) {
  show('leaders');
  const list = $('leaderList');
  list.innerHTML = '<div class="empty">' + t('loading') + '…</div>';
  document.querySelectorAll('#leaders .tab').forEach((b) => {
    b.classList.toggle('active', b.getAttribute('data-scope') === scope);
  });
  if (!online) { list.innerHTML = '<div class="empty">' + t('offline') + '</div>'; return; }
  try {
    const data = await api.leaderboard(scope);
    const rows = (data && data.rows) || [];
    if (!rows.length) { list.innerHTML = '<div class="empty">' + t('empty') + '</div>'; return; }
    list.innerHTML = '';
    const me = TG.user();
    rows.forEach((r, i) => {
      const el = document.createElement('div');
      el.className = 'lrow' + (i < 3 ? ' top' : '') + (me && r.id === me.id ? ' me' : '');
      // every field from the wire goes in as text, never as markup
      el.innerHTML = '<span class="rank"></span><span class="name"></span><span class="pts"></span>';
      el.querySelector('.rank').textContent = (r.rank | 0) || i + 1;
      el.querySelector('.name').textContent = String(r.name || t('you')).slice(0, 32);
      el.querySelector('.pts').textContent = r.score | 0;
      list.appendChild(el);
    });
  } catch (e) {
    list.innerHTML = '<div class="empty">' + t('sendError') + '</div>';
  }
}

// ---------------------------------------------------------------- shop
function renderShop() {
  const grid = $('skinGrid');
  grid.innerHTML = '';
  for (const sk of SKINS) {
    const unlocked = isUnlocked(sk, profile);
    const equipped = profile.skin === sk.id;
    const el = document.createElement('div');
    el.className = 'skin' + (equipped ? ' on' : '') + (unlocked ? '' : ' locked');
    let label;
    if (equipped) label = t('equipped');
    else if (unlocked) label = t('equip');
    else if (sk.unlock) {
      const p = unlockProgress(sk, profile);
      label = p.have + '/' + p.need;
    } else label = sk.price + ' ⭐';
    el.innerHTML = '<div class="orb"></div><span class="nm"></span><span class="pr"></span><button></button>';
    const orb = el.querySelector('.orb');
    orb.style.background = `radial-gradient(circle at 35% 30%, ${sk.core}, ${sk.glow} 55%, rgba(0,0,0,0.4))`;
    orb.style.boxShadow = `0 0 14px ${sk.glow}99`;
    el.querySelector('.nm').textContent = skinName(sk, getLang());
    el.querySelector('.pr').textContent = sk.price > 0 && !unlocked ? sk.price + ' ⭐'
      : sk.unlock && !unlocked ? t('rank') : (unlocked ? t('owned') : '');
    const btn = el.querySelector('button');
    btn.textContent = label;
    btn.disabled = equipped || (!unlocked && !!sk.unlock);
    btn.onclick = () => (unlocked ? equipSkin(sk) : buySkin(sk));
    grid.appendChild(el);
  }
  const hasPass = profile.seasonUntil && profile.seasonUntil > Date.now();
  $('btnPass').textContent = hasPass ? t('owned') : SEASON_PASS.price + ' ⭐';
  $('btnPass').disabled = !!hasPass;
}

function equipSkin(sk) {
  profile.skin = sk.id;
  A.sTick();
  TG.haptic('select');
  saveProfileLocal();
  renderShop();
  if (online) api.equip({ skin: sk.id }).catch(() => { });
}

async function buySkin(sk) {
  if (!online) { toast(t('offline')); return; }
  try {
    const { invoiceLink } = await api.invoice({ item: sk.id });
    const status = await TG.openInvoice(invoiceLink);
    if (status === 'paid') {
      A.sBuy(); TG.haptic('success');
      profile.owned.push(sk.id);
      profile.skin = sk.id;
      saveProfileLocal();
      renderShop();
      // the webhook is the source of truth; re-read it shortly after
      setTimeout(syncProfile, 2500);
    } else if (status === 'failed') toast(t('sendError'));
  } catch (e) {
    toast(t('sendError'));
  }
}

async function buyPass() {
  if (!online) { toast(t('offline')); return; }
  try {
    const { invoiceLink } = await api.invoice({ item: SEASON_PASS.id });
    const status = await TG.openInvoice(invoiceLink);
    if (status === 'paid') { A.sBuy(); TG.haptic('success'); setTimeout(syncProfile, 2500); }
  } catch (e) { toast(t('sendError')); }
}

async function syncProfile() {
  if (!online) return;
  try {
    const p = await api.profile();
    if (p) {
      if (p.owned) profile.owned = p.owned;
      if (p.seasonUntil) profile.seasonUntil = p.seasonUntil;
      if (p.skin) profile.skin = p.skin;
      if (p.stats) profile.stats = { ...profile.stats, ...p.stats };
      saveProfileLocal();
      renderShop();
      refreshMenu();
    }
  } catch (e) { }
}

// ---------------------------------------------------------------- challenge
async function challenge() {
  if (!lastRun) return;
  if (!online) { toast(t('offline')); return; }
  const btn = $('btnChallenge');
  btn.disabled = true;
  try {
    const d = await api.duelCreate({
      seed: currentArena.__seed,
      level: currentArena.__level,
      shots: lastRun.shots,
      score: lastRun.score,
    });
    if (d.preparedId) {
      const ok = await TG.shareMessage(d.preparedId);
      if (!ok && d.deepLink) TG.openTelegramLink(shareUrl(d.deepLink, lastRun.score));
    } else if (d.deepLink) {
      TG.openTelegramLink(shareUrl(d.deepLink, lastRun.score));
    }
  } catch (e) {
    toast(t('sendError'));
  } finally {
    btn.disabled = false;
  }
}

function shareUrl(deepLink, score) {
  const text = t('duelText', { score });
  return 'https://t.me/share/url?url=' + encodeURIComponent(deepLink) +
    '&text=' + encodeURIComponent(text);
}

// ---------------------------------------------------------------- boot
async function openDuelFromParam(param) {
  const id = param.slice(2);
  try {
    const d = await api.duelGet(id);
    if (!d || !d.shots) { openMenu(); return; }
    startRun('duel', {
      duel: { id, seed: d.seed, level: d.level, shots: d.shots, name: d.name, score: d.score },
    });
  } catch (e) {
    toast(t('sendError'));
    openMenu();
  }
}

function bootStep(pct, label) {
  $('bootBar').style.width = pct + '%';
  if (label !== undefined) $('bootSub').textContent = label;
}

async function boot() {
  const bootT0 = performance.now();
  setLang(TG.languageCode());
  applyTexts();
  TG.boot();
  applyViewport();

  logos.boot = createLogo($('logoBoot'));
  logos.menu = createLogo($('logoMenu'));
  logos.boot.play();
  bootStep(12, t('loading') + '…');

  renderer = createRenderer(stage);
  renderer.resize();
  game = createGame({
    renderer, canvas: stage,
    onHud: renderHud, onEnd: onRunEnd, onShotEnd,
  });

  bootStep(35);
  await loadProfileLocal();
  bootStep(55);

  // server is optional; a failure here must not block play
  try {
    const a = await auth();
    online = true;
    if (a.profile) {
      profile.owned = a.profile.owned || [];
      profile.seasonUntil = a.profile.seasonUntil || 0;
      if (a.profile.skin) profile.skin = a.profile.skin;
      if (a.profile.stats) profile.stats = { ...profile.stats, ...a.profile.stats };
    }
    if (a.daily) dailyInfo = a.daily;
    if (a.topToday) topToday = a.topToday;
    if (queueSize()) flushQueue().catch(() => { });
  } catch (e) {
    online = false;
  }
  bootStep(100, t('tagline'));

  if (TG.inTelegram && TG.version && !TG.isFullscreen()) {
    // fullscreen is a real win on a 5-inch screen, and harmless if unsupported
    TG.fullscreen(true);
    setTimeout(applyViewport, 350);
  }
  $('btnHome').classList.toggle('hidden', !TG.inTelegram);

  // Hold the boot screen long enough for the mark to finish tracing its
  // ricochet. Locally the load takes 40 ms, and a title that flashes past
  // reads as a glitch rather than as a game starting up.
  const minBoot = reducedMotion() ? 250 : 1500;
  const wait = minBoot - (performance.now() - bootT0);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));

  const param = TG.startParam();
  if (param && param.indexOf('d_') === 0 && online) {
    $('bootSub').textContent = t('loading') + '…';
    show('boot');
    await openDuelFromParam(param);
  } else {
    openMenu();
    if (!profile.stats.runs) show('how');
  }
}

// ---------------------------------------------------------------- wiring
$('btnDaily').onclick = () => startRun('daily');
$('btnPractice').onclick = () => startRun('practice');
$('btnLeaders').onclick = () => openLeaders('today');
$('btnLeadersBack').onclick = openMenu;
$('btnShop').onclick = () => { renderShop(); show('shop'); };
$('btnShopBack').onclick = openMenu;
$('btnPass').onclick = buyPass;
$('btnHow').onclick = () => show('how');
$('btnHowOk').onclick = () => { if (profile.stats.runs) openMenu(); else startRun('daily'); };
$('btnAgain').onclick = () => startRun(currentMode === 'duel' ? 'practice' : currentMode);
$('btnMenu').onclick = openMenu;
$('btnChallenge').onclick = challenge;
$('btnHome').onclick = () => { if (!TG.addToHomeScreen()) toast('—'); };
$('btnSound').onclick = () => {
  A.unlock();
  profile.sound = !A.isEnabled();
  A.setEnabled(profile.sound);
  A.sTick();
  saveProfileLocal();
  refreshMenu();
};
document.querySelectorAll('#leaders .tab').forEach((b) => {
  b.onclick = () => openLeaders(b.getAttribute('data-scope'));
});

window.addEventListener('resize', applyViewport);
TG.onEvent('viewportChanged', applyViewport);
TG.onEvent('safeAreaChanged', applyViewport);
TG.onEvent('fullscreenChanged', applyViewport);
window.addEventListener('pointerdown', () => A.unlock(), { once: true });

boot().catch((e) => {
  $('bootSub').textContent = t('sendError') + ': ' + (e && e.message ? e.message : e);
});
