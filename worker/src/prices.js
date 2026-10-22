// The shop, server side.
//
// Copied by hand from client/js/skins.js. The client asks for an item id and
// nothing else: a price that travels over the wire is a price a player can
// edit, so the only numbers that reach Telegram come from this file.
// Keep in step with skins.js when a skin is added.

export const SEASON_PERIOD = 2592000;        // 30 days — the only value Stars allows

export const ITEMS = {
  violet: { price: 50, kind: 'skin', title: 'Violet', desc: 'РИКОШЕТ: skin "Violet"' },
  gold: { price: 75, kind: 'skin', title: 'Gold', desc: 'РИКОШЕТ: skin "Gold"' },
  toxic: { price: 75, kind: 'skin', title: 'Toxic', desc: 'РИКОШЕТ: skin "Toxic"' },
  ice: { price: 100, kind: 'skin', title: 'Ice', desc: 'РИКОШЕТ: skin "Ice"' },
  void: { price: 150, kind: 'skin', title: 'Void', desc: 'РИКОШЕТ: skin "Void"' },
  plasma: { price: 250, kind: 'skin', title: 'Plasma', desc: 'РИКОШЕТ: skin "Plasma"' },
  season: {
    price: 299, kind: 'pass', title: 'Season pass',
    desc: 'РИКОШЕТ: every skin for 30 days, renews monthly',
  },
};

export const FREE_SKINS = ['default'];

// Earned, not bought: same thresholds as skins.js `unlock`.
export const EARNED_SKINS = {
  ember: { type: 'score', value: 4000 },
  mint: { type: 'clears', value: 10 },
  duelist: { type: 'duelWins', value: 10 },
};

export const ALL_SKINS = [
  'default', 'ember', 'mint', 'duelist',
  'violet', 'gold', 'toxic', 'ice', 'void', 'plasma',
];

function has(obj, k) { return typeof k === 'string' && Object.prototype.hasOwnProperty.call(obj, k); }

export function itemDef(id) { return has(ITEMS, id) ? ITEMS[id] : null; }

/**
 * Invoice parameters for Bot API createInvoiceLink. `body` is the raw client
 * request: only its `item` is read, so a smuggled `price` changes nothing.
 */
export function buildInvoice(body, userId, nonce) {
  const id = body && typeof body.item === 'string' ? body.item : '';
  const def = itemDef(id);
  if (!def) return { ok: false, error: 'unknown_item' };
  const params = {
    title: def.title,
    description: def.desc,
    payload: id + ':' + userId + ':' + nonce,
    currency: 'XTR',
    prices: [{ label: def.title, amount: def.price }],
  };
  if (def.kind === 'pass') params.subscription_period = SEASON_PERIOD;
  return { ok: true, item: id, price: def.price, kind: def.kind, params };
}

/** Invoice payload -> who bought what. Rejects anything we did not mint. */
export function parsePayload(payload) {
  if (typeof payload !== 'string' || payload.length > 128) return null;
  const parts = payload.split(':');
  if (parts.length !== 3) return null;
  const def = itemDef(parts[0]);
  if (!def) return null;
  const userId = Number(parts[1]);
  if (!Number.isSafeInteger(userId) || userId <= 0) return null;
  if (!/^[0-9A-Za-z]{1,32}$/.test(parts[2])) return null;
  return { item: parts[0], kind: def.kind, price: def.price, userId, nonce: parts[2] };
}

/**
 * May this player wear this skin? Mirrors isUnlocked() in client/js/skins.js:
 * free, bought, earned by stats, or covered by a live season pass.
 */
export function canEquip(skinId, user, nowMs) {
  if (typeof skinId !== 'string' || ALL_SKINS.indexOf(skinId) < 0) return false;
  if (FREE_SKINS.indexOf(skinId) >= 0) return true;
  const owned = user && Array.isArray(user.owned) ? user.owned : [];
  if (owned.indexOf(skinId) >= 0) return true;
  if (has(EARNED_SKINS, skinId)) {
    const rule = EARNED_SKINS[skinId];
    const st = (user && user.stats) || {};
    if (rule.type === 'score') return (st.bestScore || 0) >= rule.value;
    if (rule.type === 'clears') return (st.clears || 0) >= rule.value;
    if (rule.type === 'duelWins') return (st.duelWins || 0) >= rule.value;
    return false;
  }
  const until = (user && user.seasonUntil) || 0;
  const def = itemDef(skinId);
  if (def && def.kind === 'skin' && until > (nowMs === undefined ? Date.now() : nowMs)) return true;
  return false;
}
