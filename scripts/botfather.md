# РИКОШЕТ — @BotFather и @app_moderation_bot

Пошаговый чек-лист публикации. Выполнять сверху вниз, ничего не пропуская.

**Правила по токену.** Токен бота — это полный доступ к боту. В этом файле он
всегда переменная `$BOT_TOKEN`, никогда — текстом. Не вставляйте его в код, в
`wrangler.toml`, в git и в чаты. Если он где-то засветился: @BotFather →
`/revoke` и заново.

Загрузить токен в текущую сессию терминала так, чтобы он не попал в историю
команд:

```bash
read -rs BOT_TOKEN && export BOT_TOKEN   # вставьте токен, Enter; на экране ничего не покажется
curl -sS "https://api.telegram.org/bot$BOT_TOKEN/getMe"   # проверка: "ok":true и username бота
```

Серверная копия токена живёт только в секретах Cloudflare:

```bash
cd worker && wrangler secret put BOT_TOKEN
```

---

## 0. Что подготовить заранее

| что | значение |
|---|---|
| URL игры (HTTPS) | `https://<user>.github.io/<repo>/client/` |
| Лендинг | `https://<user>.github.io/<repo>/` |
| Условия использования | `https://<user>.github.io/<repo>/terms.html` |
| Политика конфиденциальности | `https://<user>.github.io/<repo>/privacy.html` |
| URL вебхука | `https://<worker>.<subdomain>.workers.dev/webhook/<WEBHOOK_SECRET>` |
| Адрес воркера для клиента | `WORKER_ORIGIN=https://<worker>.<subdomain>.workers.dev` при сборке |
| Контакт поддержки | e-mail и @username (в страницах пока заглушки — заменить) |
| Картинка для Mini App | BotFather сам напишет нужный размер в своём вопросе (на момент написания просит 640×360) |

Страницы должны открываться **до** обращения к модерации: проверьте каждую
ссылку в браузере телефона.

---

## 1. Создать бота

1. Открыть [@BotFather](https://t.me/BotFather) → `/newbot`.
2. Имя (видно в чате): `РИКОШЕТ`.
3. Username: должен заканчиваться на `bot`, например `ricochet_duel_bot`.
   Запомните его — он подставляется в `pages/index.html` вместо
   `REPLACE_BOT`.
4. BotFather пришлёт токен. Сразу:
   - `read -rs BOT_TOKEN && export BOT_TOKEN` (см. выше);
   - `wrangler secret put BOT_TOKEN` в каталоге `worker/`;
   - удалить сообщение с токеном из чата.
5. Проверка: `curl -sS "https://api.telegram.org/bot$BOT_TOKEN/getMe"` →
   `"ok":true`.

Воркеру нужны шесть значений, и по `worker/wrangler.toml` все они ставятся как
секреты из каталога `worker/`: `BOT_TOKEN`, `TOKEN_SECRET`, `WEBHOOK_SECRET`,
`ORIGIN` (разрешённые origin через запятую, без слеша на конце),
`BOT_USERNAME` (без `@`), `OWNER_ID` (ваш числовой id — только он слушается
командой `/refund`). Для локального `wrangler dev` те же имена кладутся в
`worker/.dev.vars`.

## 2. Имя, описание, аватар

В @BotFather (каждая команда спрашивает, какого бота менять):

6. `/setname` → `РИКОШЕТ`
7. `/setabouttext` → короткий текст профиля (держите коротким, BotFather сам
   скажет, если не влезло):
   > Дуэль на одну точность. Одна арена в день, 5 выстрелов, один толчок.
8. `/setdescription` → текст на пустом экране чата:
   > РИКОШЕТ — дуэль на точность в Telegram. Одна арена в день для всех: 5
   > выстрелов и один толчок мяча в полёте. Сравни счёт с другом. Бесплатно;
   > за Stars продаётся только косметика и пропуск на 30 дней.
9. `/setuserpic` → квадратный аватар.
10. `/setdescription` и `/setabouttext` стоит задать и на английском через
    @BotFather (он предложит выбрать язык) либо через API
    `setMyDescription` / `setMyShortDescription` с `language_code`.

## 3. Команды бота

Три команды обязательны для нашей схемы: `/start` (вход и диплинк дуэли),
`/paysupport` (оплата и возвраты), `/delete` (удаление данных).

Можно через @BotFather `/setcommands`, но надёжнее — через API, потому что так
задаются сразу русский и английский варианты.

Английский (значение по умолчанию для всех языков):

```bash
curl -sS -X POST "https://api.telegram.org/bot$BOT_TOKEN/setMyCommands" \
  -H 'content-type: application/json' \
  -d '{"commands":[
        {"command":"start","description":"Play RICOCHET"},
        {"command":"paysupport","description":"Payments and Stars refunds"},
        {"command":"delete","description":"Delete my data"}
      ]}'
```

Русский:

```bash
curl -sS -X POST "https://api.telegram.org/bot$BOT_TOKEN/setMyCommands" \
  -H 'content-type: application/json' \
  -d '{"language_code":"ru","commands":[
        {"command":"start","description":"Играть в РИКОШЕТ"},
        {"command":"paysupport","description":"Оплата и возвраты Stars"},
        {"command":"delete","description":"Удалить мои данные"}
      ]}'
```

Проверка:

```bash
curl -sS "https://api.telegram.org/bot$BOT_TOKEN/getMyCommands" | python3 -m json.tool
curl -sS "https://api.telegram.org/bot$BOT_TOKEN/getMyCommands?language_code=ru" | python3 -m json.tool
```

`/start` должен отвечать текстом с кнопкой запуска игры и ссылками на
«Условия» и «Политику» — модерация любит видеть их в первом же сообщении.

Воркер обрабатывает ещё `/terms`, `/help`, `/play` и `/refund` (последняя —
только для `OWNER_ID`). В публичный список их не добавляем: `/refund` — ваш
инструмент, а не игрока. `/delete` реализован в `worker/src/webhook.js` в два
шага: сама команда только спрашивает, удаляет лишь `/delete confirm`
(или «подтверждаю» / «да»). Записи о платежах остаются обезличенными — иначе
возврат звёзд стал бы невозможен, и это прописано в «Политике».

## 4. Создать Mini App

11. @BotFather → `/newapp` → выбрать бота.
12. Title: `РИКОШЕТ`.
13. Short description: одна строка, то же, что в `/setabouttext`.
14. Фото (BotFather напишет требуемый размер в своём вопросе). GIF-демо
    необязательна — можно ответить `/empty`.
15. **Web App URL**: `https://<user>.github.io/<repo>/client/`
    (только HTTPS; `http://` и IP-адреса не принимаются).
16. Short name для прямой ссылки, например `play`. После этого игра
    открывается по `https://t.me/<bot>/play`, а диплинк дуэли —
    `https://t.me/<bot>/play?startapp=d_<id>`.
17. Менять URL позже: `/myapps` → приложение → Edit Web App URL. Там же
    правятся название, описание и картинки.

Адрес воркера внутрь клиента BotFather не передаёт — он подставляется при
сборке через `WORKER_ORIGIN` (см. конец раздела 7). Без этого игра откроется,
но лидеров, дуэлей и магазина в ней не будет.

Ссылка `https://t.me/<bot>?startapp` (без short name) открывает приложение из
кнопки меню бота — её и использует `pages/index.html`. Обе формы рабочие;
выберите одну и поставьте её на лендинг.

## 5. Кнопка меню

18. @BotFather → `/setmenubutton` → выбрать бота → задать URL
    `https://<user>.github.io/<repo>/client/` и подпись кнопки, например
    `Играть`.
19. Проверить: в чате с ботом слева от поля ввода появилась кнопка, она
    открывает игру внутри Telegram.

## 6. Inline-режим (для шаринга дуэли)

Игра отправляет карточку вызова через подготовленное сообщение
(`savePreparedInlineMessage` на сервере + `shareMessage` в клиенте).

20. @BotFather → `/setinline` → выбрать бота → placeholder, например
    `счёт в РИКОШЕТ…`.
21. По желанию `/setinlinefeedback` → `Enabled` (приходит
    `chosen_inline_result`, полезно для статистики; можно оставить
    отключённым).

> Не проверено живьём, нужен ли включённый inline-режим именно для
> `savePreparedInlineMessage`. Включить его всё равно безвредно, а шаринг без
> него стоит протестировать отдельно.

## 7. Вебхук с секретом

Секрет — произвольная строка 1–256 символов из `A–Z a–z 0–9 _ -`. Telegram
присылает её в заголовке `X-Telegram-Bot-Api-Secret-Token` при каждом запросе;
воркер сравнивает и отбрасывает всё, что не сошлось.

Воркер (`worker/src/index.js`, состояние на 22.10.2026) ждёт вебхук по пути
`/webhook/<WEBHOOK_SECRET>`, то есть **тот же секрет стоит и в URL, и в
`secret_token`**. Если воркер с тех пор переписали — сверьте путь перед тем,
как вызывать `setWebhook`.

22. Сгенерировать и положить в секреты воркера (одно и то же значение!):

```bash
WEBHOOK_SECRET="$(openssl rand -hex 32)"      # 64 символа из [0-9a-f] — допустимый набор
printf '%s\n' "$WEBHOOK_SECRET"               # скопировать
cd worker && wrangler secret put WEBHOOK_SECRET   # вставить то же значение
```

23. Сообщить вебхук Telegram:

```bash
WORKER_HOST="<worker>.<subdomain>.workers.dev"

curl -sS -X POST "https://api.telegram.org/bot$BOT_TOKEN/setWebhook" \
  -H 'content-type: application/json' \
  -d "$(cat <<JSON
{
  "url": "https://$WORKER_HOST/webhook/$WEBHOOK_SECRET",
  "secret_token": "$WEBHOOK_SECRET",
  "allowed_updates": ["message","callback_query","inline_query","chosen_inline_result","pre_checkout_query","my_chat_member"],
  "drop_pending_updates": true,
  "max_connections": 20
}
JSON
)"
```

`successful_payment` приходит внутри обновления `message`, отдельного типа в
`allowed_updates` для него нет — поэтому `message` в списке обязателен.

24. Проверка:

```bash
curl -sS "https://api.telegram.org/bot$BOT_TOKEN/getWebhookInfo" | python3 -m json.tool
```

Смотреть: `url` совпадает, `pending_update_count` падает до нуля,
`last_error_message` пустое. Если там 401/403 — воркер не принял секрет.

25. Откат / переключение на другой воркер:

```bash
curl -sS -X POST "https://api.telegram.org/bot$BOT_TOKEN/deleteWebhook" \
  -H 'content-type: application/json' -d '{"drop_pending_updates":true}'
```

**Сразу после того, как узнали адрес воркера — пересоберите клиент.** Клиент
на GitHub Pages и воркер на `workers.dev` — разные домены, адрес зашит в
`client/js/config.js` заглушкой. Подставляет его сборка:

```bash
WORKER_ORIGIN=https://<worker>.<subdomain>.workers.dev bash scripts/deploy.sh
```

Скрипт правит только копию в `dist/`, исходник остаётся с заглушкой (на
localhost клиенту нужен `/api`), и проверяет, что подстановка удалась. Без
`WORKER_ORIGIN` опубликованная игра работает офлайн: без лидеров, дуэлей и
магазина — покупки в таком билде невозможны, и модерации показывать нечего.
Вторая половина — переменная `ORIGIN` воркера: в ней должен быть
`https://<user>.github.io`, иначе браузер заблокирует запросы по CORS.

## 8. Платежи в Stars

26. Для цифровых товаров за Stars отдельный платёжный провайдер и
    `provider_token` не нужны: валюта `XTR`.
27. Ссылка на оплату создаётся на сервере методом `createInvoiceLink`
    (`currency: "XTR"`, `prices: [{label, amount}]`, где `amount` — число
    звёзд), клиент открывает её через `openInvoice`. Для пропуска добавляется
    `subscription_period: 2592000` (30 дней) — то же значение, что в
    `client/js/skins.js`.
28. На `pre_checkout_query` воркер обязан ответить
    `answerPreCheckoutQuery` сразу, не ожидая базы: окно очень короткое, и
    при опоздании платёж отменяется.
29. По `successful_payment` — выдать предмет и сохранить
    `telegram_payment_charge_id`: без него возврат невозможен.
30. Возврат: `refundStarPayment` с `user_id` и
    `telegram_payment_charge_id`.
31. `/paysupport` должен отвечать осмысленным текстом: как попросить возврат,
    что указать, срок ответа (в «Условиях» заявлено 7 дней) и ссылка на
    `terms.html`.
32. Подписка на пропуск отменяется пользователем в самом Telegram; воркер
    узнаёт об окончании по приходу/неприходу следующего платежа. Не обещайте в
    боте отмену «изнутри игры».

## 9. Юридические страницы

33. Ссылки на `terms.html` и `privacy.html` разместить минимум в трёх местах:
    в ответе `/start`, в описании Mini App и на лендинге (уже сделано в
    `pages/index.html`).
34. Если в вашем @BotFather есть пункт `Bot Settings → Privacy Policy` —
    укажите там URL политики. Если такого пункта нет, достаточно ссылок из
    пункта 33.

> Наличие и точное название пункта «Privacy Policy» в @BotFather не
> проверено — проверьте в меню своего бота и сделайте по факту.

35. В обеих страницах заменить заглушки: `support@example.com`,
    `@your_support_username`, применимое право, надзорный орган и срок
    хранения записей о платежах. Все такие места помечены комментарием
    `<!-- TODO: owner must replace -->`:

```bash
grep -rn "TODO: owner must replace\|example.com\|your_support_username\|REPLACE_BOT" pages/
```

## 10. Подача в @app_moderation_bot

Публикация Mini App проходит через [@app_moderation_bot](https://t.me/app_moderation_bot).
Он ведёт диалог по шагам; точные вопросы и их порядок могут отличаться от
версии к версии, поэтому ниже — **что держать под рукой**, а не стенограмма.

36. Перед подачей убедиться, что всё это уже работает:
    - игра открывается по `https://t.me/<bot>/<shortname>` и внутри кнопки
      меню, без белого экрана и без ошибок в консоли;
    - `/start`, `/paysupport`, `/delete` отвечают;
    - `terms.html` и `privacy.html` открываются и в них нет заглушек;
    - покупка на малую сумму проходит, предмет выдаётся, возврат работает.
37. Подготовить материалы:
    - ссылку на бота и на Mini App;
    - название и короткое описание (RU + EN);
    - 3–5 скриншотов игры с телефона;
    - ссылки на «Условия» и «Политику»;
    - контакт поддержки (e-mail и @username);
    - формулировку монетизации: **только косметика и пропуск на 30 дней за
      Telegram Stars; никаких ставок, лутбоксов и платных случайных награ́д**;
    - возрастное ограничение: 13+ или выше, если страна требует больше.
38. Открыть @app_moderation_bot → `/start` → выбрать свой бот/приложение и
    отвечать на его вопросы, подставляя подготовленное из пункта 37.
39. Если придёт отказ — в нём указывают причину; исправить, проверить ссылки
    и подать снова. Чаще всего это недоступная страница, пустой `/start` или
    непонятное описание того, за что берутся деньги.

> Что именно спрашивает @app_moderation_bot (список полей, нужны ли
> скриншоты, какие категории) мы не проверяли и не придумываем. Считайте
> пункт 37 списком заготовок.

## 11. Финальная проверка

```bash
curl -sS "https://api.telegram.org/bot$BOT_TOKEN/getMe"           | python3 -m json.tool
curl -sS "https://api.telegram.org/bot$BOT_TOKEN/getWebhookInfo"  | python3 -m json.tool
curl -sS "https://api.telegram.org/bot$BOT_TOKEN/getMyCommands"   | python3 -m json.tool
curl -sS "https://<worker>.<subdomain>.workers.dev/api/health"    | python3 -m json.tool
```

Руками с телефона:

40. `https://t.me/<bot>?startapp` → игра открылась, арена дня загрузилась.
41. Сыграть забег → счёт появился в таблице лидеров.
42. Создать дуэль → переслать другу → его запуск по ссылке открывает ту же
    дуэль.
43. Купить самый дешёвый скин → он выдан; `/paysupport` отвечает; возврат
    через `refundStarPayment` вернул Stars.
44. `/delete` → данные ушли, таблица лидеров без вашего имени.
45. Потерять связь на середине забега → счёт не потерялся (офлайн-очередь) и
    дошёл при следующем запуске.

## 12. Безопасность, коротко

- Токен — только в `wrangler secret` и в переменной окружения оболочки.
- Секрет вебхука проверять на каждом запросе, иначе любой может прислать
  поддельный платёж.
- `initData` проверять подписью на сервере; не верить `initDataUnsafe`.
- Счёт считать на сервере (`runMatch`), клиенту не верить.
- Если токен утёк: @BotFather → `/revoke`, затем `wrangler secret put
  BOT_TOKEN` и `setWebhook` заново.
