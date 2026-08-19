const { getDeviceHistory } = require('./_lib/payments');

// Список прошлых обращений этого устройства ("Мои обращения") — без каких-либо
// личных данных, только анонимный X-Device-Id из localStorage браузера.
module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const deviceId = req.headers['x-device-id'];
  if (typeof deviceId !== 'string' || !deviceId.trim()) {
    res.status(400).json({ error: 'X-Device-Id is required' });
    return;
  }

  try {
    const history = await getDeviceHistory(deviceId);
    res.status(200).json({ history });
  } catch (err) {
    console.error('history list error:', err);
    res.status(500).json({ error: err.message || 'internal error' });
  }
};
