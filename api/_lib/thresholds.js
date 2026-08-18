// Пороги, завязанные на МРП (месячный расчётный показатель) — меняются раз в
// год вместе с республиканским бюджетом. Вместо того чтобы модель сама
// прикидывала сумму в тенге (риск ошибки/устаревшей цифры), считаем точную
// сумму здесь кодом от текущего MRP_KZT и подставляем готовый текст в промпт.
// Тот же паттерн и множители, что в bankrot-master/api/_lib/bankruptcy.js —
// держать оба файла в синхроне при изменении множителей законом.

const BANKRUPTCY_NO_PROPERTY_MRP_MULTIPLIER = 1600;
const SPOUSAL_LOAN_CONSENT_MRP_MULTIPLIER = 1000;

function formatKzt(amount) {
  return `${Math.round(amount).toLocaleString('ru-RU')} ₸`;
}

function computeMrpThresholdText(multiplier, mrpKzt) {
  const mrp = Number(mrpKzt);
  if (!Number.isFinite(mrp) || mrp <= 0) {
    return `порог в тенге меняется каждый год вместе с МРП — текущее значение МРП не задано в настройках сервера, не называй уверенно конкретную сумму в тенге, формулируй только через кратность МРП (${multiplier}-кратный размер МРП)`;
  }
  const amount = multiplier * mrp;
  return `на сегодня это ровно ${formatKzt(amount)} (при текущем МРП = ${formatKzt(mrp)}) — эту сумму можно называть уверенно, она посчитана от актуального МРП, а не по памяти`;
}

function getBankruptcyThresholdText(mrpKzt) {
  return computeMrpThresholdText(BANKRUPTCY_NO_PROPERTY_MRP_MULTIPLIER, mrpKzt);
}

function getSpousalLoanConsentThresholdText(mrpKzt) {
  return computeMrpThresholdText(SPOUSAL_LOAN_CONSENT_MRP_MULTIPLIER, mrpKzt);
}

module.exports = {
  BANKRUPTCY_NO_PROPERTY_MRP_MULTIPLIER,
  SPOUSAL_LOAN_CONSENT_MRP_MULTIPLIER,
  getBankruptcyThresholdText,
  getSpousalLoanConsentThresholdText,
};
