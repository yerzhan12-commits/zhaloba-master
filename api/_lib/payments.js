const { kv } = require('@vercel/kv');
const { randomUUID } = require('crypto');

const PRICE_KZT = 1500;
const FREE_LIMIT_KEY_VALUE = '1'; // просто маркер "бесплатная попытка уже использована"
const RESULT_TTL_SECONDS = 60 * 60 * 24 * 5; // 5 дней — пользователь должен быть предупреждён об этом в интерфейсе
const HISTORY_MAX_ITEMS = 30; // максимум записей "Моих обращений" на устройство

// Мягкая защита от обхода бесплатной попытки через очистку localStorage —
// не блокирует полностью (общие IP семей/офисов не должны страдать), но
// ограничивает масштаб: не больше IP_FREE_LIMIT бесплатных разблокировок с
// одного IP за IP_FREE_WINDOW_SECONDS. Проверяется только когда deviceId
// выглядит "свежим" — если по deviceId уже использовано, IP не трогаем.
const IP_FREE_LIMIT = 2;
const IP_FREE_WINDOW_SECONDS = 60 * 60 * 24; // 24 часа

function freeUsedKey(deviceId) {
  return `device:${deviceId}:freeUsed`;
}
function ipFreeCountKey(ip) {
  return `ip:${ip}:freeCount`;
}
function resultKey(resultId) {
  return `result:${resultId}`;
}
function orderKey(orderId) {
  return `order:${orderId}`;
}
function historyKey(deviceId) {
  return `device:${deviceId}:history`;
}

async function consumeIpFreeQuota(ip) {
  const count = await kv.incr(ipFreeCountKey(ip));
  if (count === 1) {
    await kv.expire(ipFreeCountKey(ip), IP_FREE_WINDOW_SECONDS);
  }
  return count <= IP_FREE_LIMIT;
}

// @vercel/kv в разных версиях может вернуть как готовый объект, так и сырую
// JSON-строку — так же осторожно с этим уже обходится admin.js.
function parseMaybeJson(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return raw;
}

async function tryConsumeFreeOrLock({ deviceId, ip, lang, result }) {
  const resultId = randomUUID();
  const freeUsedByDevice = await kv.get(freeUsedKey(deviceId));
  let unlocked = !freeUsedByDevice;

  if (unlocked && ip) {
    const ipOk = await consumeIpFreeQuota(ip);
    if (!ipOk) unlocked = false; // IP уже выбрал свою квоту бесплатных за окно
  }

  if (unlocked) {
    await kv.set(freeUsedKey(deviceId), FREE_LIMIT_KEY_VALUE);
    // Бесплатная попытка целиком уходит клиенту прямо сейчас и оседает только
    // в его localStorage — на сервере её сознательно не храним и не заносим
    // в историю устройства, хранить/показывать в "Мои обращения" нечего,
    // это не оплаченный результат.
    return { resultId, unlocked };
  }

  const stored = {
    deviceId,
    lang,
    result,
    unlocked,
    createdAt: new Date().toISOString(),
  };
  await kv.set(resultKey(resultId), JSON.stringify(stored), { ex: RESULT_TTL_SECONDS });
  await addToDeviceHistory(deviceId, resultId);

  return { resultId, unlocked };
}

async function getResult(resultId) {
  const raw = await kv.get(resultKey(resultId));
  return parseMaybeJson(raw);
}

async function saveResult(resultId, data) {
  await kv.set(resultKey(resultId), JSON.stringify(data), { ex: RESULT_TTL_SECONDS });
}

// Список resultId по устройству — чтобы пользователь при повторном входе видел
// историю своих обращений ("Мои обращения"), а не только последний результат
// из localStorage. Список живёт не дольше самих результатов (см. RESULT_TTL_SECONDS)
// — записи из истории, у которых сам результат уже истёк, просто отфильтровываются.
async function addToDeviceHistory(deviceId, resultId) {
  const key = historyKey(deviceId);
  await kv.lpush(key, resultId);
  await kv.ltrim(key, 0, HISTORY_MAX_ITEMS - 1);
  await kv.expire(key, RESULT_TTL_SECONDS);
}

async function getDeviceHistory(deviceId) {
  const ids = await kv.lrange(historyKey(deviceId), 0, -1);
  const items = await Promise.all(ids.map(async (resultId) => {
    const stored = await getResult(resultId);
    if (!stored) return null; // запись протухла или ещё не встречалась (защита от подделки id)
    return {
      resultId,
      createdAt: stored.createdAt,
      unlocked: stored.unlocked,
      category: (stored.result && stored.result.category) || null,
    };
  }));
  return items.filter(Boolean);
}

async function createOrder({ orderId, resultId, deviceId, amountKzt }) {
  const order = {
    resultId,
    deviceId,
    amountKzt,
    status: 'pending',
    createdAt: new Date().toISOString(),
  };
  await kv.set(orderKey(orderId), JSON.stringify(order), { ex: RESULT_TTL_SECONDS });
  return order;
}

async function getOrder(orderId) {
  const raw = await kv.get(orderKey(orderId));
  return parseMaybeJson(raw);
}

async function markOrderPaid(orderId) {
  const order = await getOrder(orderId);
  if (!order) return null;
  if (order.status !== 'paid') {
    order.status = 'paid';
    order.paidAt = new Date().toISOString();
    await kv.set(orderKey(orderId), JSON.stringify(order), { ex: RESULT_TTL_SECONDS });
  }

  const stored = await getResult(order.resultId);
  if (stored && !stored.unlocked) {
    stored.unlocked = true;
    await saveResult(order.resultId, stored);
  }
  return order;
}

async function markOrderFailed(orderId) {
  const order = await getOrder(orderId);
  if (!order) return null;
  if (order.status === 'paid') return order; // никогда не понижаем уже оплаченный заказ
  order.status = 'failed';
  await kv.set(orderKey(orderId), JSON.stringify(order), { ex: RESULT_TTL_SECONDS });
  return order;
}

module.exports = {
  PRICE_KZT,
  RESULT_TTL_SECONDS,
  tryConsumeFreeOrLock,
  getResult,
  saveResult,
  getDeviceHistory,
  createOrder,
  getOrder,
  markOrderPaid,
  markOrderFailed,
};
