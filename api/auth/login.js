const crypto = require('crypto');
const { createSessionCookie } = require('../_lib/auth');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
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
