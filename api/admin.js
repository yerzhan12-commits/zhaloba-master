const { kv } = require('@vercel/kv');

function escapeHtml(str) {
  return String(str || '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

module.exports = async (req, res) => {
  const password = (req.query && req.query.password) || '';
  if (!process.env.ADMIN_PASSWORD || password !== process.env.ADMIN_PASSWORD) {
    res.status(401).send('Доступ запрещён. Добавьте ?password=... в адрес.');
    return;
  }

  try {
    const raw = await kv.lrange('wizard_log', 0, -1);
    const entries = raw.map((item) => {
      try {
        return typeof item === 'string' ? JSON.parse(item) : item;
      } catch {
        return null;
      }
    }).filter(Boolean);

    const rows = entries.map((e) => `
      <div class="entry">
        <div class="meta">${escapeHtml(e.ts)} · ${e.lang === 'kk' ? 'Қазақша' : 'Русский'}</div>
        <div class="cat">${escapeHtml(e.category)}</div>
        <details>
          <summary>Куда подавать</summary>
          <pre>${escapeHtml(e.addressee)}</pre>
        </details>
        <details>
          <summary>Черновик</summary>
          <pre>${escapeHtml(e.draft)}</pre>
        </details>
        <details>
          <summary>Сроки</summary>
          <pre>${escapeHtml(e.deadlines)}</pre>
        </details>
        <details>
          <summary>Как подать</summary>
          <pre>${escapeHtml(e.howToSubmit)}</pre>
        </details>
      </div>
    `).join('');

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(200).send(`<!DOCTYPE html>
<html lang="ru"><head><meta charset="UTF-8">
<title>Жалоба — лог обращений</title>
<style>
  body{font-family:-apple-system,sans-serif;background:#0d0d0d;color:#fff;padding:16px;max-width:720px;margin:0 auto;}
  h1{font-size:18px;color:#3987e5;margin-bottom:4px;}
  .count{color:#898781;font-size:13px;margin-bottom:16px;}
  .entry{background:#1a1a19;border:1px solid rgba(255,255,255,0.1);border-radius:12px;padding:14px;margin-bottom:12px;}
  .meta{font-size:12px;color:#898781;margin-bottom:6px;}
  .cat{font-size:15px;font-weight:600;margin-bottom:8px;}
  details{margin-top:6px;font-size:13px;}
  summary{cursor:pointer;color:#3987e5;}
  pre{white-space:pre-wrap;font-family:inherit;margin-top:6px;color:#c3c2b7;}
</style></head>
<body>
  <h1>Лог обращений — Жалоба</h1>
  <div class="count">Всего записей: ${entries.length} (новые сверху)</div>
  ${rows || '<p>Пока пусто.</p>'}
</body></html>`);
  } catch (err) {
    console.error('admin error:', err);
    res.status(500).send('Ошибка: ' + err.message);
  }
};
