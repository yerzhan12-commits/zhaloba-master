const crypto = require('crypto');
const { kv } = require('@vercel/kv');

// Admin endpoint for БЕЛ-ТІРЕК access codes: add / reset / list.
// Protected by BELTIREK_ADMIN_KEY — a dedicated secret (set once in the
// Vercel dashboard, separate from ADMIN_PASSWORD used for /admin/login.html),
// sent in the request body since this is meant to be called from a
// terminal/script, not a browser session.

function codeKey(code) {
  return `beltirek:code:${code}`;
}

function checkAdminPassword(body) {
  const expected = process.env.BELTIREK_ADMIN_KEY || '';
  const a = Buffer.from(String(body.adminPassword || ''));
  const b = Buffer.from(expected);
  return expected.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'method_not_allowed' });
    return;
  }

  const body = req.body || {};
  if (!checkAdminPassword(body)) {
    res.status(403).json({ ok: false, error: 'forbidden' });
    return;
  }

  const action = String(body.action || '');

  if (action === 'add') {
    const code = String(body.code || '').trim().toUpperCase();
    const name = String(body.name || '').trim();
    if (!code || !name) {
      res.status(400).json({ ok: false, error: 'bad_request' });
      return;
    }
    await kv.set(codeKey(code), JSON.stringify({ name, token: null }));
    res.status(200).json({ ok: true, code, name });
    return;
  }

  if (action === 'reset') {
    const code = String(body.code || '').trim().toUpperCase();
    const raw = await kv.get(codeKey(code));
    if (!raw) {
      res.status(404).json({ ok: false, error: 'not_found' });
      return;
    }
    const entry = typeof raw === 'string' ? JSON.parse(raw) : raw;
    entry.token = null;
    await kv.set(codeKey(code), JSON.stringify(entry));
    res.status(200).json({ ok: true });
    return;
  }

  if (action === 'list') {
    const keys = await kv.keys('beltirek:code:*');
    const codes = [];
    for (const key of keys) {
      const raw = await kv.get(key);
      if (!raw) continue;
      const entry = typeof raw === 'string' ? JSON.parse(raw) : raw;
      codes.push({ code: key.replace('beltirek:code:', ''), name: entry.name, active: !!entry.token });
    }
    res.status(200).json({ ok: true, codes });
    return;
  }

  res.status(400).json({ ok: false, error: 'bad_action' });
};
