const { getOrder, getResult, markOrderPaid, markOrderFailed } = require('../_lib/payments');
const { checkOrderStatus } = require('../_lib/bcc');

// Фронтенд опрашивает этот эндпоинт после возврата с платёжной страницы банка.
// Если вебхук (payment/callback.js) ещё не дошёл — сами дёргаем TRTYPE=90 как
// fallback, чтобы опрос с фронтенда мог завершить сценарий даже без вебхука.
module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const deviceId = req.headers['x-device-id'];
  const orderId = req.query && req.query.order;
  if (typeof deviceId !== 'string' || !deviceId.trim() || typeof orderId !== 'string' || !orderId.trim()) {
    res.status(400).json({ error: 'order and X-Device-Id are required' });
    return;
  }

  try {
    let order = await getOrder(orderId);
    if (!order || order.deviceId !== deviceId) {
      res.status(404).json({ error: 'order not found' });
      return;
    }

    if (order.status === 'pending') {
      try {
        const { approved } = await checkOrderStatus(orderId);
        order = approved ? await markOrderPaid(orderId) : order;
        // Осознанно НЕ помечаем как failed по одному неуспешному опросу —
        // платёж мог быть ещё не завершён на стороне банка в этот момент;
        // фронтенд просто продолжит поллинг. failed выставляет только вебхук.
      } catch (checkErr) {
        console.error('payment status fallback check error:', checkErr);
      }
    }

    if (order.status !== 'paid') {
      res.status(200).json({ status: order.status });
      return;
    }

    const stored = await getResult(order.resultId);
    res.status(200).json({ status: 'paid', result: stored ? stored.result : null });
  } catch (err) {
    console.error('payment status error:', err);
    res.status(500).json({ error: err.message || 'internal error' });
  }
};
