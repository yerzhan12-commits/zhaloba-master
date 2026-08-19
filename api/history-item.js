const { getResult, PRICE_KZT } = require('./_lib/payments');

// Полная карточка одного прошлого обращения из истории — доступна только тому
// же устройству, которое её создало (сверяем deviceId, сохранённый вместе с
// результатом, с заголовком запроса), чтобы угадывание чужого resultId не
// открывало чужой черновик.
module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const deviceId = req.headers['x-device-id'];
  const resultId = req.query && req.query.resultId;
  if (typeof deviceId !== 'string' || !deviceId.trim() || typeof resultId !== 'string' || !resultId.trim()) {
    res.status(400).json({ error: 'resultId and X-Device-Id are required' });
    return;
  }

  try {
    const stored = await getResult(resultId);
    if (!stored || stored.deviceId !== deviceId) {
      res.status(404).json({ error: 'not found' });
      return;
    }

    // Хранилище держит полный результат даже для неоплаченных записей (см.
    // api/wizard.js — там же обрезается только ответ клиенту), поэтому здесь
    // так же нужно урезать до category, иначе неоплаченная запись из истории
    // отдаст черновик в обход пейволла.
    const payload = stored.unlocked ? stored.result : { category: stored.result && stored.result.category };

    res.status(200).json({
      resultId,
      unlocked: stored.unlocked,
      result: payload,
      priceKzt: PRICE_KZT,
    });
  } catch (err) {
    console.error('history item error:', err);
    res.status(500).json({ error: err.message || 'internal error' });
  }
};
