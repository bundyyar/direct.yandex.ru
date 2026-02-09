/**
 * Сервер для приёма платежей через ЮMoney (YooMoney).
 * Запуск: npm install && node server.js
 *
 * Настройки в .env:
 *   YOOMONEY_WALLET=...       — номер вашего кошелька ЮMoney
 *   YOOMONEY_SECRET=...       — секрет для HTTP-уведомлений (из настроек кошелька)
 *   BASE_URL=http://localhost:3000
 *
 * В настройках кошелька ЮMoney включите HTTP-уведомления:
 *   https://yoomoney.ru/transfer/myservices/http-notification
 *   URL: https://ваш-сайт/api/yoomoney-notify
 */

require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));

const YOOMONEY_WALLET = process.env.YOOMONEY_WALLET || '';
const YOOMONEY_SECRET = process.env.YOOMONEY_SECRET || '';
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');

// label -> { amountRub, paid }
const orders = new Map();

/**
 * Проверка подписи HTTP-уведомления от ЮMoney.
 * SHA-1 от строки: notification_type&operation_id&amount&currency&datetime&sender&codepro&notification_secret&label
 */
function verifyYooMoneySignature(params) {
  const str = [
    params.notification_type,
    params.operation_id,
    params.amount,
    params.currency,
    params.datetime,
    params.sender || '',
    params.codepro,
    YOOMONEY_SECRET,
    params.label || '',
  ].join('&');
  const expected = crypto.createHash('sha1').update(str, 'utf8').digest('hex');
  return expected === params.sha1_hash;
}

/**
 * POST /api/create-payment
 * Body: { amount: number }
 * Возвращает: { paymentUrl, orderId } или { error }
 *
 * Генерирует ссылку на QuickPay ЮMoney для перевода на ваш кошелёк.
 */
app.post('/api/create-payment', (req, res) => {
  const amountRub = Math.floor(Number(req.body.amount) || 0);
  if (amountRub < 1) {
    return res.status(400).json({ error: 'Сумма должна быть не менее 1 ₽' });
  }

  if (!YOOMONEY_WALLET) {
    return res.status(500).json({
      error: 'Не настроен кошелёк ЮMoney. Задайте YOOMONEY_WALLET в .env',
    });
  }

  // Уникальная метка для отслеживания платежа
  const label = `pay_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  orders.set(label, { amountRub, paid: false });

  const successUrl = `${BASE_URL}/payment-success.html?orderId=${encodeURIComponent(label)}`;

  // Формируем URL для QuickPay ЮMoney
  const params = new URLSearchParams({
    receiver: YOOMONEY_WALLET,
    'quickpay-form': 'shop',
    targets: `Пополнение баланса на ${amountRub} ₽`,
    paymentType: 'AC',             // AC = банковская карта, PC = кошелёк ЮMoney
    sum: String(amountRub),
    label: label,
    successURL: successUrl,
  });

  const paymentUrl = `https://yoomoney.ru/quickpay/confirm?${params.toString()}`;
  return res.json({ paymentUrl, orderId: label });
});

/**
 * POST /api/yoomoney-notify
 * HTTP-уведомление от ЮMoney о входящем переводе.
 * Приходит, когда деньги зачислены на ваш кошелёк.
 */
app.post('/api/yoomoney-notify', (req, res) => {
  const body = req.body || {};

  console.log('ЮMoney уведомление:', JSON.stringify(body));

  // Проверяем подпись (если задан секрет)
  if (YOOMONEY_SECRET) {
    if (!verifyYooMoneySignature(body)) {
      console.error('ЮMoney: неверная подпись');
      return res.status(400).send('bad signature');
    }
  }

  // Защита от code-pro платежей (они требуют подтверждения)
  if (body.codepro === 'true') {
    console.warn('ЮMoney: платёж с кодом протекции, пропускаем');
    return res.status(200).send('OK');
  }

  const label = body.label || '';
  const amount = parseFloat(body.withdraw_amount) || parseFloat(body.amount) || 0;

  if (label && orders.has(label)) {
    const order = orders.get(label);
    order.paid = true;
    // Обновляем сумму на реально полученную (может отличаться из-за комиссии)
    order.amountRub = Math.floor(amount) || order.amountRub;
    console.log(`ЮMoney: платёж ${label} подтверждён, сумма ${order.amountRub} ₽`);
  } else {
    console.log(`ЮMoney: платёж с label="${label}" не найден в orders (возможно, сервер перезапускался)`);
  }

  res.status(200).send('OK');
});

/**
 * GET /api/confirm-payment?orderId=...
 * Страница успеха запрашивает сумму; заказ помечается использованным.
 * Зачисляем только если уведомление от ЮMoney уже пришло (paid = true).
 */
app.get('/api/confirm-payment', (req, res) => {
  const orderId = req.query.orderId;
  if (!orderId) {
    return res.status(400).json({ error: 'Нет orderId' });
  }

  const order = orders.get(orderId);
  if (!order) {
    return res.status(404).json({ error: 'Заказ не найден или уже использован' });
  }

  if (!order.paid) {
    return res.json({
      amount: 0,
      message: 'Ожидаем подтверждение оплаты от ЮMoney. Обновите страницу через пару секунд.',
    });
  }

  // Оплата подтверждена — удаляем заказ и возвращаем сумму
  orders.delete(orderId);
  res.json({ amount: order.amountRub });
});

app.get('/payment-success.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'payment-success.html'));
});
app.get('/payment-fail.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'payment-fail.html'));
});

app.listen(PORT, () => {
  console.log(`Сервер: ${BASE_URL}`);
  if (YOOMONEY_WALLET) {
    console.log(`Платёжная система: ЮMoney (кошелёк ${YOOMONEY_WALLET})`);
    if (!YOOMONEY_SECRET) {
      console.warn('YOOMONEY_SECRET не задан — подпись уведомлений не проверяется!');
    }
  } else {
    console.warn('⚠ Задайте YOOMONEY_WALLET в .env для приёма платежей');
  }
});
