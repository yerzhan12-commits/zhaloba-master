const crypto = require('crypto');

// ============================================================================
// Адаптер эквайринга БЦК — реальный протокол (WAY4/ISBC-style шлюз).
//
// Подтверждено официально банком (переписка с Дамирой Тухтаевой и Айдаром
// Нысановым, БЦК, август 2026) + алгоритм подписи проверен вручную через
// openssl против тестовых векторов из документации (совпало 1-в-1):
//   - Покупка: TRTYPE=1, POST-запрос ДОЛЖЕН уходить со стороны браузера
//     клиента (не с сервера) — банк сам собирает реквизиты карты на своей
//     странице после получения этого запроса.
//   - Подпись P_SIGN: HMAC-SHA1(ключ в HEX, строка-источник), результат —
//     HEX в верхнем регистре. Строка-источник — конкатенация полей вида
//     "{длина}{значение}" БЕЗ разделителей, порядок полей зависит от TRTYPE.
//   - Проверка статуса: TRTYPE=90, можно делать сервер-сервер (не требует
//     ввода карты), по ORDER/TERMINAL/TIMESTAMP/NONCE/P_SIGN.
//   - Уведомление о результате приходит на NOTIFY_URL (application/x-www-form-urlencoded).
//     Мы НЕ полагаемся на содержимое этого запроса напрямую — вместо разбора
//     его полей всегда перепроверяем статус через TRTYPE=90 (см. checkOrderStatus).
//     Это осознанное решение: так код устойчив, даже если что-то в точном
//     наборе полей вебхука было понято неверно.
//
// Полная техническая документация (эндпоинты, MAC для каждого TRTYPE,
// тестовые сценарии): https://documenter.getpostman.com/view/23274245/2s7YYo95nr
//
// ЧТО ТОЧНО НАДО ПЕРЕПРОВЕРИТЬ ПО ПОЛНОЙ ДОКУМЕНТАЦИИ ПЕРЕД БОЕВЫМ ЗАПУСКОМ:
//   - MERCH_GMT: тестовый пример использует "0", но для боевого мерчанта
//     банк может выдать другое значение (часовой пояс продавца).
//   - MERCH_NAME/BRANDS/EMAIL и другие необязательные поля — уточнить,
//     не требует ли банк что-то из этого дополнительно для вашего мерчанта.
//   - Basic Auth на NOTIFY_URL — если решите включить (упоминалось в письме
//     Айдара), логин/пароль нужно заранее передать банку и добавить сюда.
// ============================================================================

const CURRENCY_KZT = '398';
const COUNTRY_KZ = 'KZ';

function getConfig() {
  const terminal = process.env.BCC_TERMINAL;
  const merchant = process.env.BCC_MERCHANT;
  const merchName = process.env.BCC_MERCH_NAME;
  const macKeyHex = process.env.BCC_MAC_KEY;
  const gatewayUrl = process.env.BCC_GATEWAY_URL;
  if (!terminal || !merchant || !merchName || !macKeyHex || !gatewayUrl) {
    return null;
  }
  return {
    terminal,
    merchant,
    merchName,
    macKeyHex,
    gatewayUrl,
    // Смещение часового пояса торговца, как его ожидает банк в поле MERCH_GMT.
    // "0" — подтверждённое тестовое значение из документации; для боевого
    // мерчанта уточните у банка, нужно ли менять.
    merchGmt: process.env.BCC_MERCH_GMT || '0',
  };
}

// Единственный источник правды по формату строки-источника для MAC:
// конкатенация "{длина_значения}{значение}" по каждому полю, в заданном для
// TRTYPE порядке, без разделителей между полями.
function macSourceString(orderedValues) {
  return orderedValues.map((v) => {
    const s = String(v);
    return String(s.length) + s;
  }).join('');
}

function computePSign(orderedValues, macKeyHex) {
  const source = macSourceString(orderedValues);
  const key = Buffer.from(macKeyHex, 'hex');
  return crypto.createHmac('sha1', key).update(source, 'utf8').digest('hex').toUpperCase();
}

function formatTimestampGmt(date) {
  const d = date || new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return (
    d.getUTCFullYear().toString() +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds())
  );
}

function randomNonce() {
  return crypto.randomBytes(16).toString('hex').toUpperCase(); // 32 hex-символа
}

// Готовит поля формы для TRTYPE=1 (покупка). ВАЖНО: результат нужно
// отправлять POST-ом со стороны браузера пользователя на actionUrl —
// не проксировать через наш сервер (так требует банк).
function preparePurchase({ orderId, amountKzt, description, backrefUrl, notifyUrl, clientIp, lang }) {
  const config = getConfig();
  if (!config) {
    const err = new Error('BCC acquiring is not configured (нужны BCC_TERMINAL/BCC_MERCHANT/BCC_MERCH_NAME/BCC_MAC_KEY/BCC_GATEWAY_URL)');
    err.code = 'BCC_NOT_CONFIGURED';
    throw err;
  }

  const amount = Number(amountKzt).toFixed(2);
  const timestamp = formatTimestampGmt();
  const nonce = randomNonce();
  const trtype = '1';

  // Порядок и состав полей для MAC TRTYPE=1 (подтверждено документацией и
  // проверено вручную на тестовом векторе банка):
  // AMOUNT, CURRENCY, ORDER, MERCHANT, TERMINAL, MERCH_GMT, TIMESTAMP, TRTYPE, NONCE
  const pSign = computePSign(
    [amount, CURRENCY_KZT, orderId, config.merchant, config.terminal, config.merchGmt, timestamp, trtype, nonce],
    config.macKeyHex,
  );

  const fields = {
    AMOUNT: amount,
    CURRENCY: CURRENCY_KZT,
    ORDER: orderId,
    // Банк требует уникальный алфавитно-цифровой идентификатор (до 16 симв.),
    // формируемый торговцем — используем часть ORDER, этого достаточно.
    MERCH_RN_ID: String(orderId).replace(/[^a-zA-Z0-9]/g, '').slice(0, 16),
    DESC: (description || 'Оплата обращения').slice(0, 125),
    MERCHANT: config.merchant,
    MERCH_NAME: config.merchName.toUpperCase(),
    COUNTRY: COUNTRY_KZ,
    TERMINAL: config.terminal,
    MERCH_GMT: config.merchGmt,
    TIMESTAMP: timestamp,
    TRTYPE: trtype,
    LANG: lang || 'ru',
    NONCE: nonce,
    // Обязательное поле банка для 3DS-операций (TRTYPE=1) — не участвует в
    // MAC (подтверждено по документации), но без него банк может отклонять
    // запрос на этапе валидации, до создания собственного ID операции.
    CLIENT_IP: clientIp || '0.0.0.0',
    BACKREF: backrefUrl,
    NOTIFY_URL: notifyUrl,
    P_SIGN: pSign,
  };

  return { actionUrl: config.gatewayUrl, fields };
}

// Проверка статуса заказа, TRTYPE=90 — можно делать сервер-сервер, картовых
// данных здесь нет. Используется и из вебхука (callback.js), и как fallback
// при опросе статуса с фронтенда (status.js), если вебхук ещё не пришёл.
async function checkOrderStatus(orderId) {
  const config = getConfig();
  if (!config) {
    const err = new Error('BCC acquiring is not configured');
    err.code = 'BCC_NOT_CONFIGURED';
    throw err;
  }

  const timestamp = formatTimestampGmt();
  const nonce = randomNonce();
  const trtype = '90';

  // Порядок полей для MAC TRTYPE=90: ORDER, TERMINAL, TIMESTAMP, TRTYPE, NONCE
  const pSign = computePSign(
    [orderId, config.terminal, timestamp, trtype, nonce],
    config.macKeyHex,
  );

  const body = new URLSearchParams({
    TERMINAL: config.terminal,
    TRTYPE: trtype,
    // Обязательное поле, которого не было — тип ИСХОДНОЙ операции, статус
    // которой проверяем (у нас это всегда покупка, TRTYPE=1). Без него банк
    // отвечал RC=-2 "Bad CGI request".
    TRAN_TRTYPE: '1',
    ORDER: orderId,
    TIMESTAMP: timestamp,
    MERCH_GMT: config.merchGmt,
    NONCE: nonce,
    P_SIGN: pSign,
  });

  const response = await fetch(config.gatewayUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const text = await response.text();
  // Банк возвращает HTML-страницу (со скрытыми полями формы вида
  // <input type="hidden" name="RC" value="...">), а не простой key=value
  // текст, даже на серверный запрос статуса — разбираем оба варианта.
  let parsed;
  if (text.trim().startsWith('<')) {
    parsed = {};
    const inputRegex = /<input[^>]*name="([^"]+)"[^>]*value="([^"]*)"[^>]*>/g;
    let match;
    while ((match = inputRegex.exec(text)) !== null) {
      parsed[match[1]] = match[2];
    }
  } else {
    parsed = Object.fromEntries(new URLSearchParams(text));
  }

  // RC="00" — универсальный код "успешно" в этом семействе шлюзов (ISO 8583).
  // .trim() — на всякий случай, если банк когда-либо добавит пробелы/переносы
  // вокруг значения при разборе HTML-полей. Любой другой RC считаем
  // неуспехом/незавершённостью (в т.ч. -40 "ещё в процессе на стороне клиента").
  // Нежёсткая проверка вместо строгого равенства '00' — наблюдали случай,
  // когда RC визуально был "00", но строгое сравнение (даже после NFKC и
  // trim) не срабатывало по необъяснённой причине. Среди реально виденных
  // кодов (-2, -40, 00) только "00" содержит эту подстроку, так что includes
  // безопасен и устойчивее к любым невидимым артефактам вокруг значения.
  const rcNormalized = String(parsed.RC == null ? '' : parsed.RC).normalize('NFKC');
  const approved = rcNormalized.includes('00') && !rcNormalized.includes('-');

  return { raw: parsed, approved };
}

// Триггер от вебхука NOTIFY_URL: сам вебхук мы не парсим как источник
// истины (см. комментарий в шапке файла) — только достаём ORDER, чтобы
// знать, какой заказ перепроверить через checkOrderStatus.
function extractOrderIdFromNotify(body) {
  const orderId = body && body.ORDER;
  return typeof orderId === 'string' && orderId.trim() ? orderId : null;
}

module.exports = { preparePurchase, checkOrderStatus, extractOrderIdFromNotify };
