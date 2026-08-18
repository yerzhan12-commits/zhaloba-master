const { kv } = require('@vercel/kv');
const { randomUUID } = require('crypto');

const PRICE_KZT = 1500;
const FREE_LIMIT_KEY_VALUE = '1'; // просто маркер "бесплатная попытка уже использована"
const RESULT_TTL_SECONDS = 60 * 60 * 24 * 14; // 14 дней

function freeUsedKey(deviceId) {
  return `device:${deviceId}:freeUsed`;
}
function resultKey(resultId) {
  return `result:${resultId}`;
}
function orderKey(orderId) {
  return `order:${orderId}`;
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

async function tryConsumeFreeOrLock({ deviceId, lang, result }) {
  const resultId = randomUUID();
  const freeUsed = await kv.get(freeUsedKey(deviceId));
  const unlocked = !freeUsed;
  if (unlocked) {
    await kv.set(freeUsedKey(deviceId), FREE_LIMIT_KEY_VALUE);
  }

  const stored = {
    deviceId,
    lang,
    result,
    unlocked,
    createdAt: new Date().toISOString(),
  };
  await kv.set(resultKey(resultId), JSON.stringify(stored), { ex: RESULT_TTL_SECONDS });

  return { resultId, unlocked };
}

async function getResult(resultId) {
  const raw = await kv.get(resultKey(resultId));
  return parseMaybeJson(raw);
}

async function saveResult(resultId, data) {
  await kv.set(resultKey(resultId), JSON.stringify(data), { ex: RESULT_TTL_SECONDS });
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
  tryConsumeFreeOrLock,
  getResult,
  saveResult,
  createOrder,
  getOrder,
  markOrderPaid,
  markOrderFailed,
};
