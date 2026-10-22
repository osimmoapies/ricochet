// Bot API calls. One helper, no retries: a webhook that hangs on a retry is
// worse than a webhook that gives up, and Telegram redelivers updates anyway.

const API = 'https://api.telegram.org/bot';

export async function callBot(token, method, body, timeoutMs) {
  if (!token) return { ok: false, error: 'server_misconfigured' };
  try {
    const res = await fetch(API + token + '/' + method, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
      signal: AbortSignal.timeout(timeoutMs || 8000),
    });
    const data = await res.json();
    if (!data || data.ok !== true) {
      return { ok: false, error: (data && data.description) || ('http ' + res.status) };
    }
    return { ok: true, result: data.result };
  } catch (e) {
    return { ok: false, error: (e && e.message) || 'fetch_failed' };
  }
}

export function sendMessage(token, chatId, text, replyMarkup) {
  const body = {
    chat_id: chatId,
    text,
    link_preview_options: { is_disabled: true },
  };
  if (replyMarkup) body.reply_markup = replyMarkup;
  return callBot(token, 'sendMessage', body);
}

export function answerPreCheckout(token, id, ok, errorMessage) {
  const body = { pre_checkout_query_id: id, ok: !!ok };
  if (!ok) body.error_message = errorMessage || 'Payment could not be verified.';
  return callBot(token, 'answerPreCheckoutQuery', body, 5000);
}

export function createInvoiceLink(token, params) {
  return callBot(token, 'createInvoiceLink', params);
}

export function refundStarPayment(token, userId, chargeId) {
  return callBot(token, 'refundStarPayment', {
    user_id: userId, telegram_payment_charge_id: chargeId,
  });
}

/**
 * A message the player can forward into any chat with one tap (Mini App
 * method shareMessage). Must be prepared for the exact user who will share it.
 */
export function savePreparedInlineMessage(token, userId, duelId, score, deepLink) {
  return callBot(token, 'savePreparedInlineMessage', {
    user_id: userId,
    result: {
      type: 'article',
      id: ('d' + duelId).slice(0, 64),
      title: 'РИКОШЕТ — дуэль',
      description: score + ' очков. Побей.',
      input_message_content: {
        message_text: 'РИКОШЕТ: ' + score + ' очков за 5 выстрелов. Побей мой счёт.\n' + deepLink,
        link_preview_options: { is_disabled: false },
      },
      reply_markup: { inline_keyboard: [[{ text: 'Принять дуэль', url: deepLink }]] },
    },
    allow_user_chats: true,
    allow_group_chats: true,
    allow_channel_chats: false,
    allow_bot_chats: false,
  }, 6000);
}
