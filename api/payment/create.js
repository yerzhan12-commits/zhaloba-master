const { randomInt } = require('crypto');
const { getResult, createOrder, PRICE_KZT } = require('../_lib/payments');
const { preparePurchase } = require('../_lib/bcc');

// Банк требует, чтобы ORDER было ЧИСТО ЦИФРОВЫМ и уникальным (не UUID с
// буквами/дефисами, как было раньше — вероятная причина ошибки -2 в
// тестах). 13 цифр timestamp + 3 случайные цифры = 16 цифр, тот же формат
// подходит и для MERCH_RN_ID (банк требует ровно 16 алфавитно-цифровых
// символов — см. bcc.js).
function generateNumericOrderId() {
  const suffix = String(randomInt(0, 1000)).padStart(3, '0');
  return `${Date.now()}${suffix}`;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const deviceId = req.headers['x-device-id'];
  if (typeof deviceId !== 'string' || !deviceId.trim()) {
    res.status(400).json({ error: 'X-Device-Id header is required' });
    return;
  }

  const { resultId } = req.body || {};
  if (typeof resultId !== 'string' || !resultId.trim()) {
    res.status(400).json({ error: 'resultId is required' });
    return;
  }

  try {
    const stored = await getResult(resultId);
    if (!stored || stored.deviceId !== deviceId) {
      res.status(404).json({ error: 'Результат не найден' });
      return;
    }
    if (stored.unlocked) {
      res.status(200).json({ alreadyUnlocked: true });
      return;
    }

    const orderId = generateNumericOrderId();
    await createOrder({ orderId, resultId, deviceId, amountKzt: PRICE_KZT });

    const proto = req.headers['x-forwarded-proto'] || 'https';
    const origin = `${proto}://${req.headers.host}`;
    // Ведёт на api/payment/return.js, а не сразу на статическую страницу —
    // банк может вернуть пользователя запросом POST, а статика отдаёт 405
    // на POST. return.js принимает любой метод и сам делает редирект.
    const backrefUrl = `${origin}/api/payment/return?order=${orderId}`;
    const notifyUrl = `${origin}/api/payment/callback`;

    // Банк требует CLIENT_IP как обязательное поле для TRTYPE=1 (3DS-операции).
    // На Vercel реальный IP клиента приходит в x-forwarded-for (первый адрес
    // в списке — сам клиент, остальные — прокси между ним и нами).
    const forwardedFor = req.headers['x-forwarded-for'];
    const clientIp = (typeof forwardedFor === 'string' ? forwardedFor.split(',')[0].trim() : null)
      || req.socket?.remoteAddress
      || '0.0.0.0';

    const { actionUrl, fields } = preparePurchase({
      orderId,
      amountKzt: PRICE_KZT,
      description: `Оплата обращения ${resultId.slice(0, 8)}`,
      backrefUrl,
      notifyUrl,
      clientIp,
    });

    // actionUrl/fields — банк требует, чтобы это POST-ился со страницы
    // браузера пользователя, а не проксировался нашим сервером (см. bcc.js).
    res.status(200).json({ orderId, actionUrl, fields });
  } catch (err) {
    console.error('payment create error:', err);
    const status = err.code === 'BCC_NOT_CONFIGURED' ? 503 : 500;
    res.status(status).json({ error: err.message || 'internal error' });
  }
};
