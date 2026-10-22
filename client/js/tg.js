// Telegram WebApp wrapper.
//
// Every call is version-gated with isVersionAtLeast, because a Mini App runs
// inside whatever Telegram build the player happens to have — an old Android
// client will throw on requestFullscreen and take the whole game down with
// it. Outside Telegram (plain browser, local dev) every method degrades to a
// no-op so the game still runs.
const W = (typeof window !== 'undefined' && window.Telegram && window.Telegram.WebApp) || null;

export const inTelegram = !!(W && W.initData !== undefined);

function at(v) {
  try { return W && W.isVersionAtLeast && W.isVersionAtLeast(v); } catch (e) { return false; }
}
function tryCall(fn) {
  try { return fn(); } catch (e) { return undefined; }
}

export const version = W ? W.version : '0';
export const platform = W ? W.platform : 'web';

export function initData() { return W ? W.initData || '' : ''; }
export function user() {
  return (W && W.initDataUnsafe && W.initDataUnsafe.user) || null;
}
export function startParam() {
  return (W && W.initDataUnsafe && W.initDataUnsafe.start_param) || '';
}
export function languageCode() {
  const u = user();
  if (u && u.language_code) return u.language_code;
  return (typeof navigator !== 'undefined' && navigator.language) || 'en';
}

export function boot() {
  if (!W) return;
  tryCall(() => W.ready());
  tryCall(() => W.expand());
  if (at('6.1')) {
    tryCall(() => W.setHeaderColor('#060912'));
    tryCall(() => W.setBackgroundColor('#060912'));
  }
  if (at('7.10')) tryCall(() => W.setBottomBarColor('#060912'));
  if (at('7.7')) tryCall(() => W.disableVerticalSwipes());
  if (at('6.2')) tryCall(() => W.enableClosingConfirmation());
  if (at('8.0')) {
    tryCall(() => W.lockOrientation('portrait'));
  }
}

/** Fullscreen is a win on a small phone but only exists on 8.0+. */
export function fullscreen(on) {
  if (!at('8.0')) return false;
  return tryCall(() => { on ? W.requestFullscreen() : W.exitFullscreen(); return true; }) || false;
}
export function isFullscreen() { return !!(W && W.isFullscreen); }

export function safeArea() {
  const z = { top: 0, bottom: 0, left: 0, right: 0 };
  if (!W) return z;
  const a = W.safeAreaInset || z;
  const b = W.contentSafeAreaInset || z;
  return {
    top: (a.top || 0) + (b.top || 0),
    bottom: (a.bottom || 0) + (b.bottom || 0),
    left: (a.left || 0) + (b.left || 0),
    right: (a.right || 0) + (b.right || 0),
  };
}

export function onEvent(name, cb) {
  if (W && W.onEvent) tryCall(() => W.onEvent(name, cb));
}

export function haptic(kind) {
  if (!W || !W.HapticFeedback || !at('6.1')) return;
  tryCall(() => {
    const h = W.HapticFeedback;
    if (kind === 'success' || kind === 'error' || kind === 'warning') h.notificationOccurred(kind);
    else if (kind === 'select') h.selectionChanged();
    else h.impactOccurred(kind || 'light');
  });
}

export function backButton(visible, cb) {
  // BackButton landed in 6.1; on 6.0 the SDK only logs a warning and does
  // nothing, so gate it or every screen change prints to the console.
  if (!W || !W.BackButton || !at('6.1')) return;
  tryCall(() => {
    if (cb) W.BackButton.onClick(cb);
    visible ? W.BackButton.show() : W.BackButton.hide();
  });
}

export function close() { if (W) tryCall(() => W.close()); }

// --- CloudStorage: 1024 keys per user, values up to 4096 chars.
// Used only for preferences and a local best score; anything that decides a
// leaderboard lives on the server, where the player cannot edit it.
export function cloudGet(key) {
  return new Promise((res) => {
    if (!W || !W.CloudStorage || !at('6.9')) return res(null);
    tryCall(() => W.CloudStorage.getItem(key, (err, val) => res(err ? null : val))) || res(null);
  });
}
export function cloudSet(key, value) {
  return new Promise((res) => {
    if (!W || !W.CloudStorage || !at('6.9')) return res(false);
    tryCall(() => W.CloudStorage.setItem(key, String(value).slice(0, 4096), (err, ok) => res(!err && ok))) || res(false);
  });
}

/** Stars invoice. Returns 'paid' | 'cancelled' | 'failed' | 'pending'. */
export function openInvoice(url) {
  return new Promise((res) => {
    if (!W || !at('6.1')) return res('failed');
    const done = tryCall(() => {
      W.openInvoice(url, (status) => res(status));
      return true;
    });
    if (!done) res('failed');
  });
}

/**
 * Share a result card into a chat. Needs a message prepared by the bot
 * (savePreparedInlineMessage), which is why the id comes from our API.
 */
export function shareMessage(preparedId) {
  return new Promise((res) => {
    if (!at('8.0') || !W.shareMessage) return res(false);
    const done = tryCall(() => { W.shareMessage(preparedId, (ok) => res(!!ok)); return true; });
    if (!done) res(false);
  });
}

export function shareToStory(mediaUrl, params) {
  if (!at('7.8') || !W.shareToStory) return false;
  return !!tryCall(() => { W.shareToStory(mediaUrl, params || {}); return true; });
}

export function openTelegramLink(url) {
  if (W && W.openTelegramLink) return !!tryCall(() => { W.openTelegramLink(url); return true; });
  if (typeof window !== 'undefined') window.open(url, '_blank');
  return true;
}

export function addToHomeScreen() {
  if (!at('8.0') || !W.addToHomeScreen) return false;
  return !!tryCall(() => { W.addToHomeScreen(); return true; });
}

export function showAlert(msg) {
  if (W && W.showAlert) return tryCall(() => W.showAlert(msg));
  if (typeof window !== 'undefined') window.alert(msg);
}

export function requestWriteAccess() {
  return new Promise((res) => {
    if (!W || !W.requestWriteAccess) return res(false);
    const done = tryCall(() => { W.requestWriteAccess((ok) => res(!!ok)); return true; });
    if (!done) res(false);
  });
}
