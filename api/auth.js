const crypto = require('crypto');
const { createSessionCookie, clearSessionCookie } = require('./_lib/auth');

// Объединённый login/logout — раньше это были два отдельных файла
// (api/auth/login.js, api/auth/logout.js), но Vercel Hobby ограничивает
// деплой 12 serverless-функциями, а с БЕЛ-ТІРЕК их стало 13.
module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const action = (req.query && req.query.action) || 'login';

  if (action === 'logout') {
    res.setHeader('Set-Cookie', clearSessionCookie());
    res.status(200).json({ ok: true });
    return;
  }

  const { password } = req.body || {};
  const expected = process.env.ADMIN_PASSWORD || '';

  const a = Buffer.from(String(password || ''));
  const b = Buffer.from(expected);
  const match = expected.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);

  if (!match) {
    res.status(401).json({ error: 'invalid password' });
    return;
  }

  res.setHeader('Set-Cookie', createSessionCookie());
  res.status(200).json({ ok: true });
};
