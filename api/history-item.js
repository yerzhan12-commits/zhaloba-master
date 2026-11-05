const { getResult, saveResult, pickPreviewFields, resolvePrice, getPriceForMode } = require('./_lib/payments');

// GET — полная карточка одного прошлого обращения из истории, доступна только
// тому же устройству, которое её создало (сверяем deviceId, сохранённый вместе
// с результатом, с заголовком запроса), чтобы угадывание чужого resultId не
// открывало чужой готовый текст.
//
// POST — админский обход оплаты (для демо-видео и личного пользования, без
// реальной оплаты через эквайринг). Объединён с этим же файлом, а не вынесен
// отдельно, из-за лимита в 12 serverless-функций на Hobby-плане Vercel.
// Доступен только с правильным токеном (переменная окружения ADMIN_TOKEN в
// Vercel, никогда не хранится в коде). Токен сверяется строго — пустая/
// отсутствующая переменная окружения никогда не считается совпадением, даже
// если клиент случайно прислал пустую строку.
module.exports = async (req, res) => {
  if (req.method === 'GET') {
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
      // api/wizard.js — там же обрезается ответ клиенту), поэтому здесь так же
      // нужно урезать до превью-полей, иначе неоплаченная запись из истории
      // отдаст готовый текст обращения в обход пейволла.
      const payload = stored.unlocked ? stored.result : pickPreviewFields(stored.result);
      const { amountKzt, creditAppliedKzt } = await resolvePrice(stored.mode, deviceId);

      res.status(200).json({
        resultId,
        unlocked: stored.unlocked,
        mode: stored.mode || 'complaint',
        result: payload,
        priceKzt: amountKzt,
        creditAppliedKzt,
      });
    } catch (err) {
      console.error('history item error:', err);
      res.status(500).json({ error: err.message || 'internal error' });
    }
    return;
  }

  if (req.method === 'POST') {
    const adminToken = process.env.ADMIN_TOKEN;
    const providedToken = req.headers['x-admin-token'];
    if (!adminToken || typeof providedToken !== 'string' || providedToken !== adminToken) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }

    const resultId = req.body && req.body.resultId;
    if (typeof resultId !== 'string' || !resultId.trim()) {
      res.status(400).json({ error: 'resultId is required' });
      return;
    }

    try {
      const stored = await getResult(resultId);
      if (!stored) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      if (!stored.unlocked) {
        stored.unlocked = true;
        await saveResult(resultId, stored);
      }
      res.status(200).json({ resultId, unlocked: true, mode: stored.mode || 'complaint', result: stored.result, priceKzt: getPriceForMode(stored.mode) });
    } catch (err) {
      console.error('admin unlock error:', err);
      res.status(500).json({ error: err.message || 'internal error' });
    }
    return;
  }

  res.status(405).json({ error: 'Method not allowed' });
};
