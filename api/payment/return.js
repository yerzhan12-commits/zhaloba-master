// Обработчик BACKREF — банк может вернуть пользователя запросом POST (после
// экрана "Транзакция успешно проведена" / "Ошибка транзакции"), а не GET.
// Статическая index.html принимает только GET, отсюда была ошибка 405.
// Здесь принимаем любой метод, достаём order из query-строки (она часть
// самого URL, не зависит от метода запроса) и редиректим на реальный SPA.
module.exports = async (req, res) => {
  const orderId = req.query && req.query.order;
  const target = orderId
    ? `/?payment=return&order=${encodeURIComponent(orderId)}`
    : '/';
  res.writeHead(302, { Location: target });
  res.end();
};
