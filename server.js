/**
 * Сервер для приёма платежей через ЮMoney + Telegram-уведомления.
 */

require('dotenv').config();
var express = require('express');
var crypto = require('crypto');
var https = require('https');
var path = require('path');

var app = express();
var PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

var YOOMONEY_WALLET = process.env.YOOMONEY_WALLET || '';
var YOOMONEY_SECRET = process.env.YOOMONEY_SECRET || '';
var BASE_URL = (process.env.BASE_URL || 'http://localhost:' + PORT).replace(/\/$/, '');
var TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
var TG_CHAT = process.env.TELEGRAM_CHAT_ID || '';

var orders = new Map();

// ——— Telegram ———
function sendTelegram(text) {
  if (!TG_TOKEN || !TG_CHAT) {
    console.log('Telegram not configured, skipping');
    return;
  }
  var url = 'https://api.telegram.org/bot' + TG_TOKEN + '/sendMessage';
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TG_CHAT, text: text })
  })
  .then(function(r) { return r.json(); })
  .then(function(data) {
    if (data.ok) {
      console.log('Telegram sent OK');
    } else {
      console.error('Telegram error:', JSON.stringify(data));
    }
  })
  .catch(function(e) {
    console.error('Telegram fetch failed:', e.message);
  });
}

// ——— ЮMoney ———
function verifyYooMoneySignature(params) {
  var str = [
    params.notification_type,
    params.operation_id,
    params.amount,
    params.currency,
    params.datetime,
    params.sender || '',
    params.codepro,
    YOOMONEY_SECRET,
    params.label || ''
  ].join('&');
  var expected = crypto.createHash('sha1').update(str, 'utf8').digest('hex');
  return expected === params.sha1_hash;
}

// POST /api/create-payment
app.post('/api/create-payment', function(req, res) {
  var amountRub = Math.floor(Number(req.body.amount) || 0);
  if (amountRub < 1) {
    return res.status(400).json({ error: 'Сумма должна быть не менее 1 руб' });
  }
  if (!YOOMONEY_WALLET) {
    return res.status(500).json({ error: 'YOOMONEY_WALLET not set' });
  }

  var label = 'pay_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  orders.set(label, { amountRub: amountRub, paid: false });

  var successUrl = BASE_URL + '/payment-success.html?orderId=' + encodeURIComponent(label);

  var params = new URLSearchParams({
    receiver: YOOMONEY_WALLET,
    'quickpay-form': 'shop',
    targets: 'Balance top-up ' + amountRub + ' RUB',
    paymentType: 'AC',
    sum: String(amountRub),
    label: label,
    successURL: successUrl
  });

  var paymentUrl = 'https://yoomoney.ru/quickpay/confirm?' + params.toString();
  return res.json({ paymentUrl: paymentUrl, orderId: label });
});

// POST /api/yoomoney-notify
app.post('/api/yoomoney-notify', function(req, res) {
  var body = req.body || {};
  console.log('YooMoney notify:', JSON.stringify(body));

  if (YOOMONEY_SECRET) {
    if (!verifyYooMoneySignature(body)) {
      return res.status(400).send('bad signature');
    }
  }

  if (body.codepro === 'true') {
    return res.status(200).send('OK');
  }

  var label = body.label || '';
  var amount = parseFloat(body.withdraw_amount) || parseFloat(body.amount) || 0;

  if (label && orders.has(label)) {
    var order = orders.get(label);
    order.paid = true;
    order.amountRub = Math.floor(amount) || order.amountRub;
    console.log('Payment confirmed:', label, order.amountRub);
  }

  res.status(200).send('OK');
});

// GET /api/confirm-payment
app.get('/api/confirm-payment', function(req, res) {
  var orderId = req.query.orderId;
  if (!orderId) {
    return res.status(400).json({ error: 'No orderId' });
  }

  var order = orders.get(orderId);
  if (!order) {
    return res.status(404).json({ error: 'Order not found' });
  }

  if (!order.paid) {
    return res.json({ amount: 0, message: 'Waiting for YooMoney confirmation...' });
  }

  orders.delete(orderId);
  return res.json({ amount: order.amountRub });
});

// POST /api/notify-campaign — Telegram notification on campaign launch
app.post('/api/notify-campaign', function(req, res) {
  console.log('notify-campaign called, body:', JSON.stringify(req.body));
  var data = req.body || {};
  var site = data.site || 'not specified';
  var amount = data.amountCharged || 0;

  var msg = 'Новый заказ!\n\nСайт: ' + site + '\nСписано: ' + amount + ' руб.';
  console.log('Sending telegram:', msg);

  sendTelegram(msg);
  return res.json({ ok: true });
});

// GET /api/test — simple debug (no telegram call)
app.get('/api/test', function(req, res) {
  return res.json({ ok: true, token: TG_TOKEN ? TG_TOKEN.slice(0, 6) : 'EMPTY', chat: TG_CHAT || 'EMPTY', time: Date.now() });
});

// GET /api/test-telegram — sends message and returns result
app.get('/api/test-telegram', function(req, res) {
  try {
    if (!TG_TOKEN || !TG_CHAT) {
      return res.json({ ok: false, error: 'not configured' });
    }
    var url = 'https://api.telegram.org/bot' + TG_TOKEN + '/sendMessage';
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT, text: 'Test from Render!' })
    })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      res.json({ ok: true, tg: data });
    })
    .catch(function(e) {
      res.json({ ok: false, error: e.message });
    });
  } catch(e) {
    res.json({ ok: false, error: e.message, stack: e.stack });
  }
});

// Static files — AFTER all API routes
app.use(express.static(__dirname));

// Global error handler
app.use(function(err, req, res, next) {
  console.error('Express error:', err);
  res.status(500).json({ error: err.message || 'Unknown error' });
});

app.listen(PORT, function() {
  console.log('Server: ' + BASE_URL);
  console.log('TG_TOKEN: ' + (TG_TOKEN ? 'set' : 'NOT SET'));
  console.log('TG_CHAT: ' + (TG_CHAT ? 'set' : 'NOT SET'));
  console.log('YOOMONEY_WALLET: ' + (YOOMONEY_WALLET ? 'set' : 'NOT SET'));
});
