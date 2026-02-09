/**
 * Сервер для приёма платежей через ЮMoney (YooMoney) + Telegram-уведомления.
 * Запуск: npm install && node server.js
 *
 * Настройки в .env:
 *   YOOMONEY_WALLET=...       — номер вашего кошелька ЮMoney
 *   YOOMONEY_SECRET=...       — секрет для HTTP-уведомлений (из настроек кошелька)
 *   TELEGRAM_BOT_TOKEN=...    — токен Telegram-бота
 *   TELEGRAM_CHAT_ID=...      — ваш chat_id в Telegram
 *   BASE_URL=http://localhost:3000
 */

require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const https = require('https');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));

const YOOMONEY_WALLET = process.env.YOOMONEY_WALLET || '';
const YOOMONEY_SECRET = process.env.YOOMONEY_SECRET || '';
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';

// label -> { amountRub, paid }
const orders = new Map();

// ——— Telegram ———
function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log('Telegram не настроен, пропускаем отправку');
    return;
  }
  const payload = JSON.stringify({
    chat_id: TELEGRAM_CHAT_ID,
    text: text,
    parse_mode: 'HTML',
  });
  const req = https.request({
    hostname: 'api.telegram.org',
    path: `/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  }, (res) => {
    let data = '';
    res.on('data', (chunk) => { data += chunk; });
    res.on('end', () => {
      if (res.statusCode !== 200) {
        console.error('Telegram ошибка:', data);
      }
    });
  });
  req.on('error', (err) => console.error('Telegram запрос не удался:', err.message));
  req.write(payload);
  req.end();
}

// ——— ЮMoney ———
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

  const label = `pay_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  orders.set(label, { amountRub, paid: false });

  const successUrl = `${BASE_URL}/payment-success.html?orderId=${encodeURIComponent(label)}`;

  const params = new URLSearchParams({
    receiver: YOOMONEY_WALLET,
    'quickpay-form': 'shop',
    targets: `Пополнение баланса на ${amountRub} ₽`,
    paymentType: 'AC',
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
 */
app.post('/api/yoomoney-notify', (req, res) => {
  const body = req.body || {};
  console.log('ЮMoney уведомление:', JSON.stringify(body));

  if (YOOMONEY_SECRET) {
    if (!verifyYooMoneySignature(body)) {
      console.error('ЮMoney: неверная подпись');
      return res.status(400).send('bad signature');
    }
  }

  if (body.codepro === 'true') {
    console.warn('ЮMoney: платёж с кодом протекции, пропускаем');
    return res.status(200).send('OK');
  }

  const label = body.label || '';
  const amount = parseFloat(body.withdraw_amount) || parseFloat(body.amount) || 0;
  const amountRub = Math.floor(amount);

  if (label && orders.has(label)) {
    const order = orders.get(label);
    order.paid = true;
    order.amountRub = amountRub || order.amountRub;
    console.log(`ЮMoney: платёж ${label} подтверждён, сумма ${order.amountRub} ₽`);
  }

  // Отправляем уведомление в Telegram о пополнении
  const sender = body.sender || 'аноним';
  sendTelegram(
    `💰 <b>Пополнение баланса!</b>\n\n` +
    `Сумма: <b>${amountRub} ₽</b>\n` +
    `Отправитель: ${sender}\n` +
    `Метка: <code>${label}</code>\n` +
    `Время: ${new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })}`
  );

  res.status(200).send('OK');
});

/**
 * GET /api/confirm-payment?orderId=...
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

  orders.delete(orderId);
  res.json({ amount: order.amountRub });
});

/**
 * POST /api/notify-campaign
 * Уведомление в Telegram о создании/запуске кампании.
 */
app.post('/api/notify-campaign', (req, res) => {
  const data = req.body || {};
  const site = data.site || 'не указан';
  const regions = (data.regions || []).join(', ') || 'не указаны';
  const activities = (data.activities || []).join(', ') || 'не указаны';
  const businessName = data.businessName || 'без названия';
  const budget = data.budget || 'не выбран';
  const action = data.action || 'создана';

  let emoji = '📋';
  if (action === 'запущена') emoji = '🚀';
  if (action === 'удалена') emoji = '🗑';

  sendTelegram(
    `${emoji} <b>Кампания ${action}!</b>\n\n` +
    `🏢 Бизнес: <b>${businessName}</b>\n` +
    `🌐 Сайт: ${site}\n` +
    `📍 Регионы: ${regions}\n` +
    `💼 Деятельность: ${activities}\n` +
    `💵 Бюджет: <b>${budget}</b>\n` +
    `🕐 Время: ${new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })}`
  );

  res.json({ ok: true });
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
  }
  if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
    console.log(`Telegram-уведомления: включены (chat ${TELEGRAM_CHAT_ID})`);
    sendTelegram('✅ Сервер запущен и готов к работе!');
  } else {
    console.warn('Telegram не настроен — задайте TELEGRAM_BOT_TOKEN и TELEGRAM_CHAT_ID в .env');
  }
});
