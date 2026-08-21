const crypto = require('crypto');

const SESSION_COOKIE = 'admin_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 часов

function isProd() {
  return process.env.VERCEL_ENV === 'production' || process.env.NODE_ENV === 'production';
}

function sign(payload) {
  const secret = process.env.SESSION_SECRET || '';
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

function createSessionCookie() {
  const expiry = Date.now() + SESSION_TTL_MS;
  const payload = String(expiry);
  const sig = sign(payload);
  const value = Buffer.from(`${payload}.${sig}`).toString('base64url');
  return `${SESSION_COOKIE}=${value}; HttpOnly; ${isProd() ? 'Secure; ' : ''}SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`;
}

function clearSessionCookie() {
  return `${SESSION_COOKIE}=; HttpOnly; ${isProd() ? 'Secure; ' : ''}SameSite=Strict; Path=/; Max-Age=0`;
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  return Object.fromEntries(
    header
      .split(';')
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => {
        const idx = p.indexOf('=');
        return idx === -1 ? [p, ''] : [p.slice(0, idx), p.slice(idx + 1)];
      }),
  );
}

function verifySession(req) {
  const raw = parseCookies(req)[SESSION_COOKIE];
  if (!raw) return false;

  let decoded;
  try {
    decoded = Buffer.from(raw, 'base64url').toString('utf8');
  } catch {
    return false;
  }

  const dot = decoded.lastIndexOf('.');
  if (dot < 0) return false;
  const payload = decoded.slice(0, dot);
  const sig = decoded.slice(dot + 1);
  const expected = sign(payload);

  const sigBuf = Buffer.from(sig, 'hex');
  const expBuf = Buffer.from(expected, 'hex');
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return false;

  const expiry = Number(payload);
  return Number.isFinite(expiry) && Date.now() < expiry;
}

module.exports = { createSessionCookie, clearSessionCookie, verifySession, SESSION_COOKIE };
