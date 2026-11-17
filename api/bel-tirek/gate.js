const crypto = require('crypto');
const { kv } = require('@vercel/kv');
const { verifySession } = require('../_lib/auth');

// БЕЛ-ТІРЕК access-code gate + admin, merged into one serverless function
// to stay under the Hobby plan's 12-function limit. Two entry points in
// one file:
//
// - Public verify: POST {code, token} with no "action" field — the
//   one-code-one-device check used by the app itself (needs CORS).
// - Admin: POST {action: "add"|"reset"|"list", ...} guarded by the
//   /admin/login.html session cookie or the standalone BELTIREK_ADMIN_KEY
//   secret (used by /admin/bel-tirek.html).
//
// KV key "beltirek:code:<CODE>" = JSON {"name": string, "token": string|null}.

const ALLOWED_ORIGIN = 'https://yerzhan12-commits.github.io';

function codeKey(code) {
  return `beltirek:code:${code}`;
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function checkAdminPassword(body) {
  const expected = process.env.BELTIREK_ADMIN_KEY || '';
  const a = Buffer.from(String(body.adminPassword || ''));
  const b = Buffer.from(expected);
  return expected.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function handleVerify(req, res, body) {
  const code = String(body.code || '').trim().toUpperCase();
  const clientToken = body.token ? String(body.token) : null;
  if (!code) {
    res.status(400).json({ ok: false, error: 'bad_request' });
    return;
  }

  const raw = await kv.get(codeKey(code));
  if (!raw) {
    res.status(404).json({ ok: false, error: 'not_found' });
    return;
  }

  let entry;
  try {
    entry = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    res.status(500).json({ ok: false, error: 'server_error' });
    return;
  }

  if (!entry.token) {
    const newToken = crypto.randomUUID();
    entry.token = newToken;
    await kv.set(codeKey(code), JSON.stringify(entry));
    res.status(200).json({ ok: true, name: entry.name, token: newToken });
    return;
  }

  if (clientToken && clientToken === entry.token) {
    res.status(200).json({ ok: true, name: entry.name, token: entry.token });
    return;
  }

  res.status(409).json({ ok: false, error: 'used' });
}

async function handleAdmin(req, res, body) {
  if (!verifySession(req) && !checkAdminPassword(body)) {
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
}

module.exports = async (req, res) => {
  setCors(res);

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'method_not_allowed' });
    return;
  }

  const body = req.body || {};
  if (String(body.action || '')) {
    await handleAdmin(req, res, body);
  } else {
    await handleVerify(req, res, body);
  }
};
