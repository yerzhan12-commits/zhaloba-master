const { kv } = require('@vercel/kv');

// БЕЛ-ТІРЕК access-code gate — same one-code-one-device model as ТІЗЕ's
// Cloudflare Worker, just riding on this project's existing Vercel KV
// instead of standing up a separate Worker + KV namespace.
//
// KV key "beltirek:code:<CODE>" = JSON {"name": string, "token": string|null}.
// token === null means the code has not been activated on any device yet.
// First successful call "burns" the code to that device's token;
// subsequent calls from other devices (different/missing token) are rejected.

const ALLOWED_ORIGIN = 'https://yerzhan12-commits.github.io';

function codeKey(code) {
  return `beltirek:code:${code}`;
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
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
    const newToken = require('crypto').randomUUID();
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
};
