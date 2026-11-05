const { kv } = require('@vercel/kv');
const { randomUUID } = require('crypto');

const PRICE_KZT = 4900; // обращение
const LAWSUIT_PRICE_KZT = 6900; // административный иск — объём и глубина анализа заметно больше (ст.131, подсудность, госпошлина, доказывание)
const CONSULT_PRICE_KZT = 999; // «Разобраться в АППК» — лёгкая консультация без составления документа
const CONSULT_CREDIT_KZT = 500; // зачитывается в обращение/иск, если до этого была оплачена консультация
const CONSULT_CREDIT_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 дней на то, чтобы воспользоваться зачётом
const RESULT_TTL_SECONDS = 60 * 60 * 24 * 5; // 5 дней — пользователь должен быть предупреждён об этом в интерфейсе
const HISTORY_MAX_ITEMS = 30; // максимум записей "Моих обращений" на устройство

function getPriceForMode(mode) {
  if (mode === 'lawsuit') return LAWSUIT_PRICE_KZT;
  if (mode === 'consult') return CONSULT_PRICE_KZT;
  return PRICE_KZT;
}

// Поля, которые видно ДО оплаты — доказывают человеку, что ИИ реально
// разобрался в его ситуации (куда/почему/сроки/как подать/самопроверка),
// но не отдают сам готовый текст и список доказательств — ради них и платят.
const PREVIEW_FIELDS = ['category', 'addressee', 'addresseeReasoning', 'deadlines', 'howToSubmit', 'draftQualityCheck'];

function pickPreviewFields(result) {
  const out = {};
  for (const key of PREVIEW_FIELDS) {
    if (result && result[key] !== undefined) out[key] = result[key];
  }
  return out;
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
function consultCreditKey(deviceId) {
  return `device:${deviceId}:consult_credit`;
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

// Зачёт выдаётся один раз после оплаченной консультации (см. markOrderPaid)
// и живёт CONSULT_CREDIT_TTL_SECONDS, пока не использован в обращении/иске.
async function grantConsultCredit(deviceId) {
  const data = { amountKzt: CONSULT_CREDIT_KZT, used: false, createdAt: new Date().toISOString() };
  await kv.set(consultCreditKey(deviceId), JSON.stringify(data), { ex: CONSULT_CREDIT_TTL_SECONDS });
}

async function getConsultCredit(deviceId) {
  const raw = await kv.get(consultCreditKey(deviceId));
  const data = parseMaybeJson(raw);
  if (!data || data.used) return null;
  return data;
}

async function consumeConsultCredit(deviceId) {
  const raw = await kv.get(consultCreditKey(deviceId));
  const data = parseMaybeJson(raw);
  if (!data || data.used) return;
  data.used = true;
  await kv.set(consultCreditKey(deviceId), JSON.stringify(data), { ex: CONSULT_CREDIT_TTL_SECONDS });
}

// Единая точка расчёта цены — используется и для отображения (wizard.js,
// history-item.js), и для реального списания (payment/create.js), чтобы
// цифра на экране и реально списанная сумма никогда не разошлись. Зачёт
// применим только к обращению/иску, не к самой консультации.
async function resolvePrice(mode, deviceId) {
  const base = getPriceForMode(mode);
  if (mode !== 'complaint' && mode !== 'lawsuit') {
    return { amountKzt: base, creditAppliedKzt: 0 };
  }
  const credit = await getConsultCredit(deviceId);
  if (!credit) return { amountKzt: base, creditAppliedKzt: 0 };
  const creditAppliedKzt = Math.min(credit.amountKzt, base);
  return { amountKzt: base - creditAppliedKzt, creditAppliedKzt };
}

// Составление обращения всегда платное (бесплатная первая попытка убрана —
// проверка полученного ответа от госоргана остаётся бесплатной отдельно,
// см. isReview в wizard.js, туда эта функция вообще не вызывается).
async function lockResultForPayment({ deviceId, lang, result, mode }) {
  const resultId = randomUUID();
  const stored = {
    deviceId,
    lang,
    mode: mode || 'complaint',
    result,
    unlocked: false,
    createdAt: new Date().toISOString(),
  };
  await kv.set(resultKey(resultId), JSON.stringify(stored), { ex: RESULT_TTL_SECONDS });
  await addToDeviceHistory(deviceId, resultId);

  return { resultId, unlocked: false };
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

async function createOrder({ orderId, resultId, deviceId, amountKzt, creditAppliedKzt }) {
  const order = {
    resultId,
    deviceId,
    amountKzt,
    creditAppliedKzt: creditAppliedKzt || 0,
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
  const wasAlreadyPaid = order.status === 'paid';
  if (!wasAlreadyPaid) {
    order.status = 'paid';
    order.paidAt = new Date().toISOString();
    await kv.set(orderKey(orderId), JSON.stringify(order), { ex: RESULT_TTL_SECONDS });
  }

  const stored = await getResult(order.resultId);
  if (stored && !stored.unlocked) {
    stored.unlocked = true;
    await saveResult(order.resultId, stored);
  }

  // Зачёт выдаём/списываем только при ПЕРВОМ реальном переходе в "paid" —
  // повторные вызовы (ретраи вебхука, ручная перепроверка) не должны ни
  // выдавать второй зачёт, ни заново "открывать" уже использованный.
  if (!wasAlreadyPaid) {
    if (stored && stored.mode === 'consult') {
      await grantConsultCredit(order.deviceId);
    }
    if (order.creditAppliedKzt > 0) {
      await consumeConsultCredit(order.deviceId);
    }
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
  LAWSUIT_PRICE_KZT,
  CONSULT_PRICE_KZT,
  CONSULT_CREDIT_KZT,
  RESULT_TTL_SECONDS,
  PREVIEW_FIELDS,
  pickPreviewFields,
  getPriceForMode,
  resolvePrice,
  getConsultCredit,
  lockResultForPayment,
  getResult,
  saveResult,
  getDeviceHistory,
  createOrder,
  getOrder,
  markOrderPaid,
  markOrderFailed,
};
