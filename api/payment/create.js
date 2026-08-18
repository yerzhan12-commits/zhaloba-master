const { randomUUID } = require('crypto');
const { getResult, createOrder, PRICE_KZT } = require('../_lib/payments');
const { preparePurchase } = require('../_lib/bcc');

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

    const orderId = randomUUID();
    await createOrder({ orderId, resultId, deviceId, amountKzt: PRICE_KZT });

    const proto = req.headers['x-forwarded-proto'] || 'https';
    const origin = `${proto}://${req.headers.host}`;
    const backrefUrl = `${origin}/?payment=return&order=${orderId}`;
    const notifyUrl = `${origin}/api/payment/callback`;

    const { actionUrl, fields } = preparePurchase({
      orderId,
      amountKzt: PRICE_KZT,
      description: `Оплата обращения ${resultId.slice(0, 8)}`,
      backrefUrl,
      notifyUrl,
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
