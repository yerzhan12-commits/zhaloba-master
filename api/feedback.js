const { kv } = require('@vercel/kv');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const { rating, comment, mode, lang } = req.body || {};
  if (rating !== 'up' && rating !== 'down') {
    res.status(400).json({ error: 'rating must be "up" or "down"' });
    return;
  }

  try {
    await kv.lpush('feedback_log', JSON.stringify({
      ts: new Date().toISOString(),
      rating,
      comment: typeof comment === 'string' ? comment.slice(0, 1000) : '',
      mode: mode === 'review' ? 'review' : 'complaint',
      lang: lang === 'kk' ? 'kk' : 'ru',
    }));
  } catch (err) {
    console.error('feedback log error:', err);
  }

  res.status(200).json({ ok: true });
};
