const { getOrder, markOrderPaid, markOrderFailed } = require('../_lib/payments');
const { checkOrderStatus, extractOrderIdFromNotify } = require('../_lib/bcc');

// Webhook (NOTIFY_URL) от банка. Мы намеренно НЕ доверяем полям запроса
// напрямую — только достаём ORDER и сразу перепроверяем реальный статус
// через TRTYPE=90 (checkOrderStatus), подписывая запрос своим же ключом.
// Так код устойчив, даже если точный набор полей в теле вебхука понят не
// на 100% — авторитетный ответ мы всё равно берём у банка напрямую, а не
// доверяем содержимому присланного запроса.
module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const orderId = extractOrderIdFromNotify(req.body);
    if (!orderId) {
      res.status(400).json({ error: 'ORDER field missing in notification' });
      return;
    }

    const order = await getOrder(orderId);
    if (!order) {
      res.status(404).json({ error: 'order not found' });
      return;
    }

    const { approved } = await checkOrderStatus(orderId);
    if (approved) {
      await markOrderPaid(orderId);
    } else {
      await markOrderFailed(orderId);
    }

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('payment callback error:', err);
    res.status(500).json({ error: err.message || 'internal error' });
  }
};
