// Bot webhook: the four things a Stars game must get right.
//
//  1. /start must open the Mini App in one tap, carrying a duel id if there
//     is one, because a duel link that lands on a text wall is a lost player.
//     It also has to show Terms and Privacy — moderation looks for them in the
//     very first message.
//  2. pre_checkout_query must be answered inside 10 s or Telegram cancels the
//     payment on the player's behalf.
//  3. successful_payment may arrive more than once (Telegram redelivers until
//     it sees a 200), so granting has to be keyed on the charge id.
//  4. /delete must really delete. pages/privacy.html §9 and setMyCommands both
//     promise it, so it is not optional — but it asks first, because one typed
//     word must never wipe a profile by accident.

import { answerPreCheckout, refundStarPayment, sendMessage } from './telegram.js';
import { parsePayload, SEASON_PERIOD } from './prices.js';
import * as DB from './db.js';

const START_BODY = 'РИКОШЕТ — одна арена в день, 5 выстрелов, один толчок в полёте.\n' +
  'Счёт сравнивается с друзьями. Жми кнопку.\n\n' +
  'One arena a day, 5 shots, one mid-flight nudge. Tap to play.';

const DUEL_TEXT = 'Тебя вызвали на дуэль. Та же арена, те же 5 выстрелов — побей счёт.\n\n' +
  'You have been challenged. Same arena, same 5 shots.';

// Wording tracks pages/privacy.html §9: what goes, what stays, and why.
const DELETE_ASK =
  'Удалить все ваши данные в РИКОШЕТ?\n' +
  'Удалим: профиль, отображаемое имя, счёт и статистику, созданные дуэли и все ваши прогоны. ' +
  'Имя исчезнет из таблицы лидеров.\n' +
  'Останутся только записи о платежах (номер платежа, сумма, предмет, дата) — без имени; ' +
  'они нужны для возвратов и отчётности.\n' +
  'Удаление не отменяет подписку на пропуск: отмените её в Telegram — Настройки → Мои звёзды → Подписки. ' +
  'Если считаете, что нужен возврат, напишите /paysupport до удаления.\n' +
  'Подтвердите командой: /delete confirm\n\n' +
  'Delete all your РИКОШЕТ data?\n' +
  'We will delete: your profile, display name, score and stats, the duels you created and all ' +
  'your runs. Your name disappears from the leaderboard.\n' +
  'Only the minimal payment records stay (charge id, amount, item, date) — with no name; they are ' +
  'needed for refunds and accounting.\n' +
  'Deleting does not cancel the pass subscription: cancel it in Telegram — Settings → My Stars → ' +
  'Subscriptions. If you think a refund is due, write /paysupport before deleting.\n' +
  'Confirm with: /delete confirm';

const DELETE_NOTHING =
  'Данных не найдено — удалять нечего. Если вы покупали что-то раньше, записи о платежах ' +
  'остаются без имени для возвратов.\n\n' +
  'No data found — nothing to delete. If you bought something earlier, the nameless payment ' +
  'records stay for refunds.';

function deleteDoneText(r) {
  return 'Готово, данные удалены: профиль, прогонов — ' + r.runs + ' (из них ответов на дуэли — ' +
    r.answers + '), созданных дуэлей — ' + r.duels + '. Имени в таблице лидеров больше нет.\n' +
    'Оставлено записей о платежах: ' + r.purchasesKept + ' — только номер платежа, сумма, ' +
    'предмет и дата, без имени: без них невозможен возврат Stars.\n' +
    'Подписка на пропуск, если она активна, отменяется только в Telegram: Настройки → Мои звёзды → ' +
    'Подписки. Зайдёте снова — начнёте с чистого профиля.\n\n' +
    'Done, your data is deleted: profile, ' + r.runs + ' runs (' + r.answers + ' of them duel ' +
    'answers), ' + r.duels + ' duels you created. Your name is off the leaderboard.\n' +
    'Kept: ' + r.purchasesKept + ' payment records — charge id, amount, item and date only, with ' +
    'no name: without them a Stars refund is impossible.\n' +
    'An active pass subscription can only be cancelled inside Telegram: Settings → My Stars → ' +
    'Subscriptions. Open the game again and you start from a clean profile.';
}

const PAYSUPPORT_TEXT =
  'Оплата — Telegram Stars. Товар (скин или пропуск) выдаётся сразу после платежа.\n' +
  'Возврат: напиши сюда номер платежа (telegram_payment_charge_id) из чека Telegram, ' +
  'и мы вернём Stars, если товар не выдался или был куплен по ошибке. ' +
  'Пропуск на 30 дней можно отменить в Telegram в любой момент: Настройки → Мои звёзды → Подписки.\n\n' +
  'Payments are in Telegram Stars. Items are granted immediately. For a refund send the ' +
  'telegram_payment_charge_id from your Telegram receipt. The 30-day pass can be cancelled ' +
  'any time in Telegram: Settings → My Stars → Subscriptions.';

function botUsername(env) {
  return String(env.BOT_USERNAME || '').replace(/^@/, '');
}

function deepLink(env, duelId) {
  const u = botUsername(env);
  return 'https://t.me/' + u + '?startapp=' + (duelId ? 'd_' + duelId : 'play');
}

/** Where terms.html and privacy.html are published (scripts/deploy.sh puts
 *  them at the site root, next to client/). PAGES_URL may carry a path, which
 *  ORIGIN cannot, so it wins when both are set. */
function pagesBase(env) {
  const raw = String((env && (env.PAGES_URL || env.ORIGIN)) || '')
    .split(',')[0].trim().replace(/\/+$/, '');
  return /^https:\/\/[^\s]+$/.test(raw) ? raw : '';
}

export function legalLines(env) {
  const b = pagesBase(env);
  if (!b) return '';
  return '\n\nУсловия / Terms: ' + b + '/terms.html' +
    '\nПолитика / Privacy: ' + b + '/privacy.html' +
    '\nУдалить данные / Delete data: /delete';
}

function startText(env) { return START_BODY + legalLines(env); }

function playMarkup(env, duelId) {
  // A duel has to travel as a start_param, which only a t.me link carries.
  if (duelId) {
    return { inline_keyboard: [[{ text: '🎯 Принять дуэль', url: deepLink(env, duelId) }]] };
  }
  // A web_app button needs the Mini App's full URL, which is not the CORS
  // origin (the app lives under /<repo>/client/). Without MINIAPP_URL set we
  // use the t.me link: Telegram already knows where the app is.
  const app = String((env && env.MINIAPP_URL) || '').trim().replace(/\/+$/, '');
  if (/^https:\/\/[^\s]+$/.test(app)) {
    return { inline_keyboard: [[{ text: '🎯 Играть', web_app: { url: app } }]] };
  }
  return { inline_keyboard: [[{ text: '🎯 Играть', url: deepLink(env, null) }]] };
}

function commandOf(text, env) {
  const m = /^\/([A-Za-z_]+)(?:@(\S+))?(?:\s+(.*))?$/.exec(String(text || '').trim());
  if (!m) return null;
  const at = m[2];
  if (at && at.toLowerCase() !== botUsername(env).toLowerCase()) return null;
  return { cmd: m[1].toLowerCase(), arg: (m[3] || '').trim() };
}

// ---------------------------------------------------------------- payments
async function grant(env, userId, name, pay, nowMs) {
  const parsed = parsePayload(pay.invoice_payload);
  if (!parsed) return { ok: false, error: 'bad_payload' };
  const chargeId = String(pay.telegram_payment_charge_id || '');
  if (!chargeId) return { ok: false, error: 'no_charge_id' };

  await DB.ensureUser(env.DB, { id: userId, name: name || 'Player' }, nowMs);
  const fresh = await DB.claimCharge(
    env.DB, chargeId, userId, parsed.item, pay.total_amount | 0, pay.invoice_payload, nowMs);
  if (!fresh) return { ok: true, duplicate: true, item: parsed.item };

  if (parsed.kind === 'pass') {
    const exp = Number(pay.subscription_expiration_date);
    const until = Number.isFinite(exp) && exp > 0 ? exp * 1000 : nowMs + SEASON_PERIOD * 1000;
    await DB.grantSeason(env.DB, userId, until);
  } else {
    await DB.grantSkin(env.DB, userId, parsed.item, nowMs);
  }
  return { ok: true, duplicate: false, item: parsed.item };
}

async function onPreCheckout(env, q) {
  const parsed = parsePayload(q.invoice_payload);
  const from = q.from && q.from.id;
  // the payload is ours and was minted for this very user
  if (!parsed || !from || parsed.userId !== from) {
    await answerPreCheckout(env.BOT_TOKEN, q.id, false, 'Этот счёт больше не действителен.');
    return;
  }
  if (q.currency !== 'XTR' || (q.total_amount | 0) !== parsed.price) {
    await answerPreCheckout(env.BOT_TOKEN, q.id, false, 'Цена изменилась, открой магазин заново.');
    return;
  }
  await answerPreCheckout(env.BOT_TOKEN, q.id, true);
}

// ---------------------------------------------------------------- erasure
/**
 * Two steps on purpose. /delete explains and asks; only /delete confirm (or
 * "/delete подтверждаю") erases. A single word in a chat is too easy to send
 * by accident, and this one is not undoable.
 */
async function onDeleteCommand(env, msg, arg) {
  const from = msg.from && msg.from.id;
  if (!from) return;
  const word = String(arg || '').toLowerCase();
  if (word !== 'confirm' && word !== 'подтверждаю' && word !== 'да') {
    await sendMessage(env.BOT_TOKEN, msg.chat.id, DELETE_ASK);
    return;
  }
  const r = await DB.deleteUserData(env.DB, from);
  const nothing = !r.user && !r.runs && !r.duels;
  await sendMessage(env.BOT_TOKEN, msg.chat.id, nothing ? DELETE_NOTHING : deleteDoneText(r));
}

async function onRefundCommand(env, msg, chargeId, nowMs) {
  const owner = Number(env.OWNER_ID);
  const from = msg.from && msg.from.id;
  if (!Number.isFinite(owner) || owner <= 0 || from !== owner) return;   // silence, not a hint
  if (!/^[\w.:-]{1,128}$/.test(chargeId)) {
    await sendMessage(env.BOT_TOKEN, msg.chat.id, 'Нужен номер платежа: /refund <charge_id>');
    return;
  }
  const p = await DB.getPurchase(env.DB, chargeId);
  if (!p) {
    await sendMessage(env.BOT_TOKEN, msg.chat.id, 'Платёж не найден: ' + chargeId);
    return;
  }
  if (p.refunded) {
    await sendMessage(env.BOT_TOKEN, msg.chat.id, 'Уже возвращён.');
    return;
  }
  const r = await refundStarPayment(env.BOT_TOKEN, p.user_id, chargeId);
  if (!r.ok) {
    await sendMessage(env.BOT_TOKEN, msg.chat.id, 'Telegram отказал: ' + r.error);
    return;
  }
  await DB.markRefunded(env.DB, chargeId, nowMs);
  if (p.item === 'season') await DB.clearSeason(env.DB, p.user_id);
  else await DB.revokeSkin(env.DB, p.user_id, p.item, nowMs);
  await sendMessage(env.BOT_TOKEN, msg.chat.id,
    'Возврат сделан: ' + p.item + ', ' + p.stars + ' ⭐, игрок ' + p.user_id);
}

// ---------------------------------------------------------------- entry
/**
 * Never throws. Returns {ok:false} only for failures a redelivery can fix —
 * the router turns that into a 500 and Telegram tries the update again, which
 * is safe because granting is keyed on the charge id.
 */
export async function handleUpdate(update, env, nowMs) {
  try {
    if (update.pre_checkout_query) {
      await onPreCheckout(env, update.pre_checkout_query);
      return { ok: true };
    }
    const msg = update.message;
    if (!msg || !msg.chat) return { ok: true };

    if (msg.successful_payment) {
      const from = msg.from && msg.from.id;
      const name = msg.from ? (msg.from.first_name || msg.from.username || 'Player') : 'Player';
      const res = await grant(env, from, name, msg.successful_payment, nowMs);
      if (res.ok && !res.duplicate) {
        await sendMessage(env.BOT_TOKEN, msg.chat.id,
          'Готово: ' + res.item + ' активирован. Открой игру.', playMarkup(env, null));
      }
      // a payload we did not mint will never parse, so asking for a retry is
      // pointless; only thrown (infrastructure) failures are worth repeating
      return { ok: true };
    }

    const c = commandOf(msg.text, env);
    if (!c) return { ok: true };
    if (c.cmd === 'start') {
      const m = /^d_([0-9A-Za-z]{6,24})$/.exec(c.arg);
      const duelId = m ? m[1] : null;
      await sendMessage(env.BOT_TOKEN, msg.chat.id,
        duelId ? DUEL_TEXT + legalLines(env) : startText(env), playMarkup(env, duelId));
      return { ok: true };
    }
    if (c.cmd === 'paysupport') {
      await sendMessage(env.BOT_TOKEN, msg.chat.id, PAYSUPPORT_TEXT + legalLines(env));
      return { ok: true };
    }
    if (c.cmd === 'terms' || c.cmd === 'privacy') {
      const links = legalLines(env);
      await sendMessage(env.BOT_TOKEN, msg.chat.id, links
        ? 'Документы игры / Game documents:' + links
        : PAYSUPPORT_TEXT);
      return { ok: true };
    }
    if (c.cmd === 'delete') {
      await onDeleteCommand(env, msg, c.arg);
      return { ok: true };
    }
    if (c.cmd === 'refund') {
      await onRefundCommand(env, msg, c.arg, nowMs);
      return { ok: true };
    }
    if (c.cmd === 'help' || c.cmd === 'play') {
      await sendMessage(env.BOT_TOKEN, msg.chat.id, startText(env), playMarkup(env, null));
    }
    return { ok: true };
  } catch (e) {
    console.log('webhook error', (e && e.message) || e);
    return { ok: false };
  }
}
