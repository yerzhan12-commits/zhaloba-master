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

  // Каждый опрос идёт на один и тот же URL (тот же order в query) — без
  // явного запрета кэширования CDN/браузер может отдавать старый ответ
  // вместо реального обращения к банку, из-за чего подтверждение
  // "зависает" даже когда платёж уже прошёл.
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');

  const deviceId = req.headers['x-device-id'];
  const orderId = req.query && req.query.order;
  if (typeof deviceId !== 'string' || !deviceId.trim() || typeof orderId !== 'string' || !orderId.trim()) {
    res.status(400).json({ error: 'order and X-Device-Id are required' });
    return;
  }

  try {
    let order = await getOrder(orderId);
    if (!order || order.deviceId !== deviceId) {
      // Временная диагностика: видно, что именно не совпало — заказ вообще
      // не нашёлся в KV, или deviceId разный.
      res.status(404).json({
        error: 'order not found',
        debug: { found: !!order, orderDeviceId: order ? order.deviceId : null, requestDeviceId: deviceId },
      });
      return;
    }

    let debugInfo = null;
    if (order.status === 'pending') {
      try {
        const { approved, raw } = await checkOrderStatus(orderId);
        // Подстраховка: если approved почему-то не совпал с RC="00" в raw
        // (наблюдали расхождение один раз, причина не до конца ясна) —
        // всё равно считаем оплаченным, если RC прямо говорит "00".
        const rcLoose = raw ? String(raw.RC == null ? '' : raw.RC).normalize('NFKC') : '';
        const reallyApproved = approved || (rcLoose.includes('00') && !rcLoose.includes('-'));
        order = reallyApproved ? await markOrderPaid(orderId) : order;
        // Осознанно НЕ помечаем как failed по одному неуспешному опросу —
        // платёж мог быть ещё не завершён на стороне банка в этот момент;
        // фронтенд просто продолжит поллинг. failed выставляет только вебхук.
        const rcCharCodes = raw && raw.RC ? Array.from(String(raw.RC)).map((c) => c.charCodeAt(0)) : null;
        debugInfo = { checked: true, approved, reallyApproved, rcCharCodes, raw };
      } catch (checkErr) {
        console.error('payment status fallback check error:', checkErr);
        debugInfo = { checked: false, error: checkErr.message };
      }
    }

    if (order.status !== 'paid') {
      // debug временно возвращаем всегда (не только при ошибке) — чтобы
      // разобраться, почему подтверждение зависает; уберём после диагностики.
      res.status(200).json({ status: order.status, debug: debugInfo });
      return;
    }

    const stored = await getResult(order.resultId);
    res.status(200).json({ status: 'paid', result: stored ? stored.result : null });
  } catch (err) {
    console.error('payment status error:', err);
    res.status(500).json({ error: err.message || 'internal error', debug: { stack: err.stack } });
  }
};
