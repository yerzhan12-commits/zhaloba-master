const { getResult, saveResult, PRICE_KZT } = require('./_lib/payments');

// Админский обход оплаты — нужен для записи демо-видео и личного пользования
// без реальной оплаты через эквайринг. Доступен только с правильным токеном
// (переменная окружения ADMIN_TOKEN в Vercel, никогда не хранится в коде).
// Токен сверяется строго — пустая/отсутствующая переменная окружения никогда
// не считается совпадением, даже если клиент случайно прислал пустую строку.
module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

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
    res.status(200).json({ resultId, unlocked: true, result: stored.result, priceKzt: PRICE_KZT });
  } catch (err) {
    console.error('admin unlock error:', err);
    res.status(500).json({ error: err.message || 'internal error' });
  }
};
