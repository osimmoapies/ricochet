// Cosmetics. Three of them are earned by playing, so a player who never pays
// still has something to chase — and a reason to be here on day seven, which
// is when a shop starts to matter at all.
//
// Prices are in Telegram Stars. For scale: 1000 Stars withdraw to about
// $1.30, so a 75-Star skin is roughly 10 cents of real revenue. The pricing
// job is to be an easy yes, not to be expensive.

export const SKINS = [
  {
    id: 'default', name: { ru: 'Искра', en: 'Spark', tg: 'Шарора' },
    price: 0, core: '#ffffff', glow: '#7df9ff', trail: ['#7df9ff', '#3a6fff'], hue: 190,
  },
  {
    id: 'ember', name: { ru: 'Угли', en: 'Ember', tg: 'Ахгар' },
    price: 0, unlock: { type: 'score', value: 4000 },
    core: '#fff3d0', glow: '#ff9a3c', trail: ['#ffcf6b', '#ff4d2e'], hue: 25,
  },
  {
    id: 'mint', name: { ru: 'Мята', en: 'Mint', tg: 'Пудина' },
    price: 0, unlock: { type: 'clears', value: 10 },
    core: '#f2fff8', glow: '#3cffa8', trail: ['#9dffd0', '#13c47a'], hue: 150,
  },
  {
    id: 'duelist', name: { ru: 'Дуэлянт', en: 'Duelist', tg: 'Дуэлчӣ' },
    price: 0, unlock: { type: 'duelWins', value: 10 },
    core: '#ffffff', glow: '#ff5c8a', trail: ['#ff9ab5', '#c21d5c'], hue: 340,
  },
  {
    id: 'violet', name: { ru: 'Фиалка', en: 'Violet', tg: 'Бунафша' },
    price: 50, core: '#f6ecff', glow: '#b06bff', trail: ['#d9b3ff', '#6d2bd9'], hue: 272,
  },
  {
    id: 'gold', name: { ru: 'Золото', en: 'Gold', tg: 'Тилло' },
    price: 75, core: '#fffbe8', glow: '#ffd34d', trail: ['#ffe9a3', '#e0a000'], hue: 46,
  },
  {
    id: 'toxic', name: { ru: 'Кислота', en: 'Toxic', tg: 'Кислота' },
    price: 75, core: '#f4ffe0', glow: '#c6ff2e', trail: ['#e6ff8f', '#79b400'], hue: 76,
  },
  {
    id: 'ice', name: { ru: 'Лёд', en: 'Ice', tg: 'Ях' },
    price: 100, core: '#ffffff', glow: '#9fe8ff', trail: ['#e3f8ff', '#1f9fd8'], hue: 196,
    extra: 'frost',
  },
  {
    id: 'void', name: { ru: 'Пустота', en: 'Void', tg: 'Холигӣ' },
    price: 150, core: '#1b1030', glow: '#8a2be2', trail: ['#6a0dad', '#1b1030'], hue: 280,
    extra: 'inverted',
  },
  {
    id: 'plasma', name: { ru: 'Плазма', en: 'Plasma', tg: 'Плазма' },
    price: 250, core: '#ffffff', glow: '#ff2ec4', trail: ['#ff8ae0', '#2effd5'], hue: 310,
    extra: 'rainbow',
  },
];

export const SEASON_PASS = {
  id: 'season', price: 299, period: 2592000,   // 30 days, the only value Stars allows
};

export function skinById(id) {
  for (const s of SKINS) if (s.id === id) return s;
  return SKINS[0];
}

export function skinName(s, lang) {
  return s.name[lang] || s.name.en;
}

/** Is this skin available to the player right now? */
export function isUnlocked(skin, profile) {
  if (skin.price === 0 && !skin.unlock) return true;
  if (profile.owned && profile.owned.indexOf(skin.id) >= 0) return true;
  if (profile.seasonUntil && profile.seasonUntil > Date.now() && skin.price > 0) return true;
  if (skin.unlock) {
    const st = profile.stats || {};
    if (skin.unlock.type === 'score') return (st.bestScore || 0) >= skin.unlock.value;
    if (skin.unlock.type === 'clears') return (st.clears || 0) >= skin.unlock.value;
    if (skin.unlock.type === 'duelWins') return (st.duelWins || 0) >= skin.unlock.value;
  }
  return false;
}

export function unlockProgress(skin, profile) {
  if (!skin.unlock) return null;
  const st = profile.stats || {};
  const have = skin.unlock.type === 'score' ? (st.bestScore || 0)
    : skin.unlock.type === 'clears' ? (st.clears || 0)
      : (st.duelWins || 0);
  return { have, need: skin.unlock.value, type: skin.unlock.type };
}
