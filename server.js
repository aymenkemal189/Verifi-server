try { require('dotenv').config(); } catch (_) {}
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const path = require('path');

const app = express();
app.use(express.json({ limit: '15mb' }));

// ═════════════════════ 1. ENVIRONMENT & SERVER CONFIG ═════════════════════
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

const BINANCE_BOT_TOKEN   = process.env.BINANCE_BOT_TOKEN || '';
const BINANCE_BOT_USER    = process.env.BINANCE_BOT_USERNAME || 'Binanceethopiapartnerbot';
const OFFICIAL_CHANNEL    = process.env.OFFICIAL_CHANNEL || '@Binance_ethiopa';
const ADMIN_GROUP_ID      = process.env.ADMIN_CHAT_ID || '-1004443564071';
const PUBLIC_SERVER_URL   = (process.env.PUBLIC_SERVER_URL || 'https://swap-broadcast-server.app.aletcloud.com').replace(/\/+$/, '');

const BROADCAST_BOT_TOKEN = process.env.BROADCAST_BOT_TOKEN || '';
const ADMIN_KEY           = process.env.ADMIN_KEY || 'SWAP_ADMIN_2026';
const SHEET_URL           = process.env.SHEET_URL || '';

const VERIFY_SERVER_BASE  = (process.env.VERIFY_SERVER_URL || 'https://verifiy-server.app.aletcloud.com').replace(/\/+$/, '');
const VERIFY_SECRET       = process.env.VERIFY_SECRET || process.env.VERIFY_TOKEN || '';

const TG_APP_API = `https://api.telegram.org/bot${BINANCE_BOT_TOKEN}`;
const TG_BC_API  = `https://api.telegram.org/bot${BROADCAST_BOT_TOKEN}`;

// ═════════════════════ 2. IN-MEMORY RAM CACHES (LOW DB SYNC) ═════════════════════
let configCache = { data: null, expiresAt: 0 };
let p2pAdsCache = { data: null, expiresAt: 0 };

function invalidateConfigCache() { configCache.expiresAt = 0; }
function invalidateP2PCache() { p2pAdsCache.expiresAt = 0; }

// ═════════════════════ 3. HELPERS (TIME & INTEGER MATH) ═════════════════════
function formatEAT(date = new Date()) {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Africa/Addis_Ababa',
      year: 'numeric', month: 'short', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: true
    }).format(date) + ' EAT';
  } catch {
    return date.toISOString();
  }
}

function calcOrder(usdt, price, percent = 3) {
  const grossCents = Math.round(Number(((Number(usdt) || 0) * 100).toFixed(6)));
  const pct = Number(percent) || 0;
  const feeCents = Math.round(Number(((grossCents * pct) / 100).toFixed(6)));
  const netCents = grossCents - feeCents;
  const priceCents = Math.round(Number(((Number(price) || 0) * 100).toFixed(6)));
  const etbTotal = Math.round(Number(((grossCents * priceCents) / 100).toFixed(6))) / 100;
  return { gross: grossCents / 100, fee: feeCents / 100, net: netCents / 100, etbTotal };
}

function escHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ═════════════════════ 4. CORS & MIDDLEWARE ═════════════════════
app.use(cors());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, X-Admin-Key');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Expose-Headers', 'Date');
  if (req.method === 'OPTIONS') return res.status(200).end();
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

function auth(req, res, next) {
  const key = req.headers['x-admin-key'] || req.query.key;
  if (key !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized: Invalid Admin Key' });
  next();
}

// ═════════════════════ 5. NEON POSTGRESQL POOL ═════════════════════
let pool = null;
if (process.env.DATABASE_URL) {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 6000
  });
  pool.on('error', (err) => console.error('Postgres pool error:', err.message));
} else {
  console.warn('⚠️ DATABASE_URL is not set!');
}

async function getSystemConfig() {
  const now = Date.now();
  if (configCache.data && now < configCache.expiresAt) return configCache.data;

  const fallback = {
    fx_rate: 194.00,
    stage4_min_invites: 10,
    stage4_min_deposit_usd: 16.00,
    p2p_fee_percent: 3,
    min_withdraw_usd: 2.00,
    accounts: []
  };
  if (!pool) return fallback;

  try {
    const [settingsRes, accRes] = await Promise.all([
      pool.query('SELECT key, value FROM system_settings'),
      pool.query('SELECT * FROM payment_accounts WHERE is_active = TRUE ORDER BY sort_order ASC, id ASC')
    ]);
    const map = {};
    settingsRes.rows.forEach(r => { map[r.key] = r.value; });

    const data = {
      fx_rate: parseFloat(map.fx_rate) || 194.00,
      stage4_min_invites: parseInt(map.stage4_min_invites) || 10,
      stage4_min_deposit_usd: parseFloat(map.stage4_min_deposit_usd) || 16.00,
      p2p_fee_percent: parseFloat(map.p2p_fee_percent) || 3,
      min_withdraw_usd: parseFloat(map.min_withdraw_usd) || 2.00,
      accounts: accRes.rows
    };
    configCache = { data, expiresAt: now + 60000 }; // 60s RAM Cache
    return data;
  } catch (e) {
    console.error('Config read warning:', e.message);
    return fallback;
  }
}

async function initDB() {
  if (!pool) return;
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS system_settings (key VARCHAR(64) PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO system_settings (key, value) VALUES
        ('fx_rate', '194.00'), ('stage4_min_invites', '10'), ('stage4_min_deposit_usd', '16.00'),
        ('p2p_fee_percent', '3'), ('min_withdraw_usd', '2.00')
      ON CONFLICT (key) DO NOTHING;

      CREATE TABLE IF NOT EXISTS payment_accounts (
        id SERIAL PRIMARY KEY, key_slug VARCHAR(64) UNIQUE NOT NULL,
        pool_type VARCHAR(20) NOT NULL DEFAULT 'USD_NBIYU', currency_group VARCHAR(16) NOT NULL DEFAULT 'CRYPTO',
        label TEXT NOT NULL, account_value TEXT DEFAULT '', account_holder TEXT DEFAULT 'Binance Ethiopia',
        network_type VARCHAR(32) NOT NULL DEFAULT 'EXCHANGE_ID', is_active BOOLEAN DEFAULT TRUE,
        sort_order INT DEFAULT 10, created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY, telegram_id VARCHAR(64) UNIQUE NOT NULL,
        first_name TEXT, last_name TEXT, username TEXT, phone_number VARCHAR(32) DEFAULT NULL,
        preferred_lang VARCHAR(8) DEFAULT 'en', onboarding_done INT DEFAULT 0, channel_joined INT DEFAULT 0,
        kyc_status VARCHAR(20) DEFAULT 'None', kyc_reject_reason TEXT DEFAULT NULL,
        kyc_full_name TEXT DEFAULT NULL, national_id VARCHAR(64) DEFAULT NULL,
        balance_usd NUMERIC(14, 2) DEFAULT 0.00, locked_usd NUMERIC(14, 2) DEFAULT 0.00,
        welcome_claimed INT DEFAULT 0, stage1_claimed INT DEFAULT 0, stage2_claimed INT DEFAULT 0,
        stage3_claimed INT DEFAULT 0, stage4_claimed INT DEFAULT 0,
        referred_by VARCHAR(64) DEFAULT NULL, fake_attempts INT DEFAULT 0, is_banned INT DEFAULT 0,
        last_spin_at TIMESTAMPTZ DEFAULT NULL, created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS telegram_pending_replies (
        message_id BIGINT PRIMARY KEY, target_type VARCHAR(24) NOT NULL,
        target_id TEXT NOT NULL, admin_tg_id VARCHAR(64) NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await getSystemConfig();
    console.log('✅ Neon PostgreSQL connected & config cached.');
  } catch (err) {
    console.error('❌ Database init error:', err.message);
  }
}

// ═════════════════════ 6. TELEGRAM MESSAGING & PHOTO FORWARDING ═════════════════════
async function tgCall(method, body) {
  if (!BINANCE_BOT_TOKEN) return null;
  try {
    const r = await fetch(`${TG_APP_API}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    return await r.json();
  } catch (e) {
    console.error(`TG ${method} error:`, e.message);
    return null;
  }
}

async function notifyAdminGroup(text, replyMarkup = null) {
  if (!BINANCE_BOT_TOKEN || !ADMIN_GROUP_ID) return null;
  const payload = { chat_id: ADMIN_GROUP_ID, text, parse_mode: 'HTML' };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  return tgCall('sendMessage', payload);
}

// Forward compressed base64 image directly to Telegram Group (NEVER saved in Postgres!)
async function sendBase64PhotoToGroup(dataUrl, caption, replyMarkup = null) {
  if (!BINANCE_BOT_TOKEN || !ADMIN_GROUP_ID || !dataUrl || !dataUrl.startsWith('data:image/')) {
    return notifyAdminGroup(caption, replyMarkup);
  }
  try {
    const matches = dataUrl.match(/^data:(image\/[a-zA-Z0-9+.-]+);base64,(.+)$/);
    if (!matches) return notifyAdminGroup(caption, replyMarkup);

    const mime = matches[1];
    const buffer = Buffer.from(matches[2], 'base64');
    const form = new FormData();
    form.append('chat_id', ADMIN_GROUP_ID);
    form.append('photo', new Blob([buffer], { type: mime }), 'upload.jpg');
    form.append('caption', caption.slice(0, 1020));
    form.append('parse_mode', 'HTML');
    if (replyMarkup) form.append('reply_markup', JSON.stringify(replyMarkup));

    const r = await fetch(`${TG_APP_API}/sendPhoto`, { method: 'POST', body: form });
    const d = await r.json();
    if (!d.ok) return notifyAdminGroup(caption, replyMarkup);
    return d;
  } catch (e) {
    console.error('sendPhoto error:', e.message);
    return notifyAdminGroup(caption, replyMarkup);
  }
}

// Notify User in their preferred language (EN + AM)
async function notifyUserDM(telegramId, msgEn, msgAm) {
  if (!BINANCE_BOT_TOKEN || !telegramId || String(telegramId).startsWith('guest_')) return;
  let lang = 'en';
  if (pool) {
    try {
      const r = await pool.query('SELECT preferred_lang FROM users WHERE telegram_id = $1', [telegramId.toString()]);
      if (r.rows[0]?.preferred_lang) lang = r.rows[0].preferred_lang;
    } catch (_) {}
  }
  const text = lang === 'am' ? `${msgAm}\n\n${msgEn}` : `${msgEn}\n\n${msgAm}`;
  await tgCall('sendMessage', { chat_id: telegramId.toString(), text, parse_mode: 'HTML' });
}

async function checkChannelMembership(telegramId) {
  if (!BINANCE_BOT_TOKEN) return { ok: true, joined: true };
  try {
    const d = await tgCall('getChatMember', { chat_id: OFFICIAL_CHANNEL, user_id: Number(telegramId) || telegramId });
    if (!d || !d.ok) {
      // Bot might not be admin in channel yet; log warning
      console.warn('getChatMember check warning:', d?.description);
      return { ok: false, joined: true }; // Fail-open only if bot lacks admin perms so users aren't blocked by config
    }
    const st = d.result?.status;
    const joined = ['creator', 'administrator', 'member', 'restricted'].includes(st);
    return { ok: true, joined };
  } catch {
    return { ok: false, joined: true };
  }
}

// ═════════════════════ 7. ANTI-FAKE & VERIFY SERVER (EXACT SPEC) ═════════════════════
async function recordFakeAttempt(telegramId, reason) {
  if (!pool) return 0;
  try {
    const r = await pool.query(
      `UPDATE users SET fake_attempts = fake_attempts + 1,
       is_banned = CASE WHEN fake_attempts + 1 >= 3 THEN 1 ELSE is_banned END
       WHERE telegram_id = $1 RETURNING fake_attempts, is_banned`,
      [telegramId.toString()]
    );
    if (r.rows[0]?.is_banned === 1) {
      notifyAdminGroup(`🚫 <b>AUTO-BANNED SCAMMER:</b>\nUser <code>${escHtml(telegramId)}</code> banned after 3 fake submissions.\nLast reason: ${escHtml(reason)}`);
    }
    return r.rows[0]?.fake_attempts || 1;
  } catch { return 0; }
}

// EXACT SPEC: GET https://verifiy-server.app.aletcloud.com/api/verify?token=...&ref=...&amount=... (or &sms=...)
async function verifyETBWithServer(ref, expectedAmount, smsText = '') {
  if (!VERIFY_SECRET) return { outcome: 'MANUAL' };
  try {
    const params = new URLSearchParams({ token: VERIFY_SECRET });
    if (smsText && smsText.trim().length > 15) {
      params.append('sms', smsText.trim());
    } else {
      params.append('ref', ref.trim());
      params.append('amount', String(parseFloat(expectedAmount)));
    }

    const url = `${VERIFY_SERVER_BASE}/api/verify?${params.toString()}`;
    const resp = await fetch(url, { method: 'GET' });
    const data = await resp.json();
    const st = data?.status;

    if (st === 'Verified') {
      return { outcome: 'VERIFIED', amount: parseFloat(data.amount || expectedAmount), ref: data.ref || data.transaction_id || ref };
    }
    if (st === 'Pending' || st === 'Resolving') {
      return { outcome: 'RETRY', status: st, message: `Bank/Telebirr confirmation is ${st}. Please wait 1 minute and try again.` };
    }
    if (st === 'AlreadyUsed' || st === 'InvalidAmount' || st === 'Invalid_Transaction_Type') {
      return { outcome: 'REJECT', status: st, reason: `Payment rejected (${st}).` };
    }
    if (data?.error) {
      return { outcome: 'REJECT', status: st || 'Error', reason: data.error };
    }
    return { outcome: 'MANUAL' };
  } catch (err) {
    console.warn('Verify server unreachable:', err.message);
    return { outcome: 'MANUAL' };
  }
}

async function verifyBscTransaction(txHash, expectedRecipient, expectedAmountUsd) {
  if (!/^0x[a-fA-F0-9]{64}$/.test(txHash)) {
    return { outcome: 'REJECT', reason: 'Invalid BEP-20 TxHash format (must be 66 chars starting with 0x).' };
  }
  try {
    const rpcRes = await fetch('https://bsc-dataseed.binance.org/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionReceipt', params: [txHash] })
    });
    const receipt = (await rpcRes.json())?.result;
    if (!receipt) return { outcome: 'REJECT', reason: 'BEP-20 TxHash not found on BNB Smart Chain.' };
    if (receipt.status !== '0x1') return { outcome: 'REJECT', reason: 'BEP-20 transaction failed on-chain.' };

    const TRANSFER_SIG = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
    const USDT_BSC = '0x55d398326f99059ff775485246999027b3197955';
    const USDC_BSC = '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d';
    const cleanTarget = expectedRecipient.toLowerCase().replace('0x', '').padStart(64, '0');

    let matchedUsd = 0;
    for (const log of (receipt.logs || [])) {
      const addr = (log.address || '').toLowerCase();
      if ((addr === USDT_BSC || addr === USDC_BSC) && log.topics?.[0] === TRANSFER_SIG && log.topics?.[2]?.toLowerCase() === '0x' + cleanTarget) {
        const rawWei = BigInt(log.data || '0x0');
        matchedUsd += Number(rawWei / (10n ** 16n)) / 100;
      }
    }

    if (matchedUsd <= 0) return { outcome: 'REJECT', reason: 'No USDT/USDC transfer to our BEP-20 wallet found in this hash.' };
    if (matchedUsd < expectedAmountUsd * 0.95) return { outcome: 'REJECT', reason: `On-chain amount ($${matchedUsd.toFixed(2)}) is less than claimed ($${expectedAmountUsd}).` };
    return { outcome: 'VERIFIED', amountUsd: matchedUsd };
  } catch {
    return { outcome: 'MANUAL' };
  }
}

async function verifyTronTransaction(txHash, expectedRecipient, expectedAmountUsd) {
  if (!/^[a-fA-F0-9]{64}$/.test(txHash)) {
    return { outcome: 'REJECT', reason: 'Invalid TRC-20 TxHash format (must be 64 hex chars).' };
  }
  if (!expectedRecipient.startsWith('T')) return { outcome: 'MANUAL' };
  try {
    const r = await fetch(`https://apilist.tronscanapi.com/api/transaction-info?hash=${txHash}`);
    if (!r.ok) return { outcome: 'MANUAL' };
    const data = await r.json();
    if (!data || !data.hash) return { outcome: 'REJECT', reason: 'TRC-20 transaction not found on TRON.' };
    if (data.contractRet !== 'SUCCESS') return { outcome: 'REJECT', reason: 'TRC-20 transaction failed.' };

    const USDT_TRC20 = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
    let matchedUsd = 0;
    for (const tr of (data.trc20TransferInfo || [])) {
      if (tr.contract_address === USDT_TRC20 && tr.to_address === expectedRecipient) {
        matchedUsd += Number(BigInt(tr.amount_str || '0') / 10000n) / 100;
      }
    }
    if (matchedUsd <= 0) return { outcome: 'REJECT', reason: 'No USDT transfer to our TRC-20 wallet found.' };
    if (matchedUsd < expectedAmountUsd * 0.95) return { outcome: 'REJECT', reason: `On-chain amount ($${matchedUsd.toFixed(2)}) less than claimed.` };
    return { outcome: 'VERIFIED', amountUsd: matchedUsd };
  } catch {
    return { outcome: 'MANUAL' };
  }
}

function validateExchangeOrderSyntax(ref) {
  const clean = ref.trim();
  if (clean.length < 6 || clean.length > 80) return { valid: false, reason: 'Order ID must be 6–80 characters.' };
  if (/^(test|fake|1234|0000|asdf|admin|null|undefined)/i.test(clean)) return { valid: false, reason: 'Invalid Order ID rejected.' };
  return { valid: true };
}

async function isDuplicateRefAnywhere(cleanRef) {
  const [d, s, p] = await Promise.all([
    pool.query('SELECT id FROM deposits WHERE transaction_ref = $1', [cleanRef]),
    pool.query('SELECT id FROM store_orders WHERE transaction_ref = $1', [cleanRef]),
    pool.query('SELECT id FROM p2p_trades WHERE payment_ref = $1', [cleanRef])
  ]);
  return d.rows.length > 0 || s.rows.length > 0 || p.rows.length > 0;
}

// ═════════════════════ 8. SHARED ATOMIC APPROVAL / REJECTION ACTIONS ═════════════════════

async function approveDepositById(depositId, actor = 'ADMIN_MANUAL') {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const dRes = await client.query(`SELECT * FROM deposits WHERE id = $1 AND status = 'PENDING' FOR UPDATE`, [depositId]);
    if (dRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return { ok: false, error: 'Deposit not found or already processed' };
    }
    const dep = dRes.rows[0];
    const eatNow = formatEAT();

    await client.query('UPDATE users SET balance_usd = balance_usd + $1 WHERE telegram_id = $2', [dep.amount_usd, dep.telegram_id]);
    await client.query(`UPDATE deposits SET status = 'APPROVED', verified_by = $1, eat_time = $2 WHERE id = $3`, [actor, eatNow, depositId]);
    await client.query(
      `INSERT INTO transactions (telegram_id, type, amount_usd, details) VALUES ($1, 'ADD_FUNDS', $2, $3)`,
      [dep.telegram_id, dep.amount_usd, `Approved Ref: ${dep.transaction_ref}`]
    );

    if (dep.pool_target === 'USD_NBIYU') {
      const uInfo = await client.query(`SELECT first_name, username FROM users WHERE telegram_id = $1`, [dep.telegram_id]);
      const uName = uInfo.rows[0]?.username ? `@${uInfo.rows[0].username}` : (uInfo.rows[0]?.first_name || 'User');
      const txCode = `NBY-IN-${depositId}-${Date.now().toString().slice(-4)}`;
      await client.query(
        `INSERT INTO nbiyu_ledger (tx_code, direction, telegram_id, user_name, channel, destination_account, amount_usd, tx_ref, verified_by, eat_timestamp)
         VALUES ($1, 'IN', $2, $3, $4, $5, $6, $7, $8, $9)`,
        [txCode, dep.telegram_id, uName, dep.payment_method, dep.destination_account || '', dep.amount_usd, dep.transaction_ref, actor, eatNow]
      );
    }
    await client.query('COMMIT');

    notifyUserDM(
      dep.telegram_id,
      `✅ <b>Add Funds Approved!</b>\n+$${Number(dep.amount_usd).toFixed(2)} USD has been credited to your Vault.`,
      `✅ <b>ገንዘብ ማስገባትዎ ጸድቋል!</b>\n+$${Number(dep.amount_usd).toFixed(2)} USD ወደ አካውንትዎ ገቢ ሆኗል።`
    );
    return { ok: true, deposit: dep, eatNow };
  } catch (err) {
    await client.query('ROLLBACK');
    return { ok: false, error: err.message };
  } finally {
    client.release();
  }
}

async function rejectDepositById(depositId, reason = 'Payment not received or invalid', actor = 'ADMIN') {
  const dRes = await pool.query(
    `UPDATE deposits SET status = 'REJECTED', reject_reason = $1, verified_by = $2 WHERE id = $3 AND status = 'PENDING' RETURNING *`,
    [reason, actor, depositId]
  );
  if (dRes.rowCount === 0) return { ok: false, error: 'Pending deposit not found' };
  const dep = dRes.rows[0];
  await recordFakeAttempt(dep.telegram_id, reason);

  notifyUserDM(
    dep.telegram_id,
    `❌ <b>Add Funds Rejected (#${depositId})</b>\nReason: ${escHtml(reason)}`,
    `❌ <b>ያስገቡት ክፍያ ውድቅ ተደርጓል (#${depositId})</b>\nምክንያት: ${escHtml(reason)}`
  );
  return { ok: true, deposit: dep };
}

async function approveStoreOrderById(orderId, actor = 'ADMIN') {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const oRes = await client.query(`SELECT * FROM store_orders WHERE id = $1 AND status = 'PENDING' FOR UPDATE`, [orderId]);
    if (oRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return { ok: false, error: 'Store order not found or already processed' };
    }
    const ord = oRes.rows[0];
    const eatNow = formatEAT();
    let deliveryInfo = 'Activated';

    if (ord.product_id === 'VISA' || ord.product_id === 'MASTERCARD') {
      const prefix = ord.product_id === 'MASTERCARD' ? '5326' : '4129';
      const cardNum = `${prefix} ${Math.floor(1000 + Math.random() * 9000)} ${Math.floor(1000 + Math.random() * 9000)} ${Math.floor(1000 + Math.random() * 9000)}`;
      const cvv = Math.floor(100 + Math.random() * 900).toString();
      await client.query(
        `INSERT INTO virtual_cards (order_id, telegram_id, card_type, card_number, expiry, cvv, balance_usd, status) VALUES ($1, $2, $3, $4, '12/29', $5, 0.00, 'ACTIVE')`,
        [ord.id, ord.telegram_id, ord.product_id, cardNum, cvv]
      );
      deliveryInfo = `${ord.product_id} Card: ${cardNum} | Exp: 12/29 | CVV: ${cvv}`;
    } else if (ord.product_id === 'PHONE_US') {
      const num = `+1 ${Math.floor(2000000000 + Math.random() * 8000000000)}`;
      const otp = Math.floor(100000 + Math.random() * 900000).toString();
      await client.query(
        `INSERT INTO phone_orders (order_id, telegram_id, country, service, phone_number, otp_code) VALUES ($1, $2, 'US', $3, $4, $5)`,
        [ord.id, ord.telegram_id, ord.service_details || 'General', num, otp]
      );
      deliveryInfo = `Number: ${num} | Initial Code: ${otp}`;
    }

    await client.query(
      `UPDATE store_orders SET status = 'DELIVERED', delivery_data = $1, verified_by = $2, eat_time = $3 WHERE id = $4`,
      [deliveryInfo, actor, eatNow, orderId]
    );

    if (ord.pool_target === 'USD_NBIYU') {
      await client.query(
        `INSERT INTO nbiyu_ledger (tx_code, direction, telegram_id, user_name, channel, destination_account, amount_usd, tx_ref, verified_by, eat_timestamp)
         VALUES ($1, 'IN', $2, 'Store Buyer', $3, 'Store Checkout', $4, $5, $6, $7)`,
        [`NBY-ST-${ord.id}`, ord.telegram_id, ord.payment_method, ord.price_usd, ord.transaction_ref, actor, eatNow]
      );
    }
    await client.query('COMMIT');

    notifyUserDM(
      ord.telegram_id,
      `🎉 <b>Store Order Approved (${ord.order_code})!</b>\nItem: ${escHtml(ord.product_name)}\nDetails: <code>${escHtml(deliveryInfo)}</code>`,
      `🎉 <b>የገዙት እቃ ጸድቋል (${ord.order_code})!</b>\nዝርዝር: <code>${escHtml(deliveryInfo)}</code>`
    );
    return { ok: true, order: ord, deliveryInfo };
  } catch (err) {
    await client.query('ROLLBACK');
    return { ok: false, error: err.message };
  } finally {
    client.release();
  }
}

async function rejectStoreOrderById(orderId, reason = 'Payment not verified', actor = 'ADMIN') {
  const r = await pool.query(
    `UPDATE store_orders SET status = 'REJECTED', reject_reason = $1, verified_by = $2 WHERE id = $3 AND status = 'PENDING' RETURNING *`,
    [reason, actor, orderId]
  );
  if (r.rowCount === 0) return { ok: false, error: 'Pending store order not found' };
  const ord = r.rows[0];
  await recordFakeAttempt(ord.telegram_id, reason);

  notifyUserDM(
    ord.telegram_id,
    `❌ <b>Store Order Rejected (${ord.order_code})</b>\nReason: ${escHtml(reason)}`,
    `❌ <b>የሱቅ ትዕዛዝዎ ውድቅ ተደርጓል (${ord.order_code})</b>\nምክንያት: ${escHtml(reason)}`
  );
  return { ok: true, order: ord };
}

async function approveWithdrawalById(withdrawalId, payoutRef = '', actor = 'ADMIN') {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const wRes = await client.query(`SELECT * FROM withdrawals WHERE id = $1 AND status = 'PENDING' FOR UPDATE`, [withdrawalId]);
    if (wRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return { ok: false, error: 'Pending withdrawal not found' };
    }
    const w = wRes.rows[0];
    const eatNow = formatEAT();

    await client.query(`UPDATE withdrawals SET status = 'COMPLETED', payout_ref = $1, eat_time = $2 WHERE id = $3`, [payoutRef || `WD-${withdrawalId}`, eatNow, withdrawalId]);
    if (w.pool_source === 'USD_NBIYU') {
      await client.query(
        `INSERT INTO nbiyu_ledger (tx_code, direction, telegram_id, user_name, channel, destination_account, amount_usd, tx_ref, verified_by, eat_timestamp)
         VALUES ($1, 'OUT', $2, 'Withdrawal Payout', $3, $4, $5, $6, $7, $8)`,
        [`NBY-OUT-${withdrawalId}-${Date.now().toString().slice(-4)}`, w.telegram_id, w.payment_method, w.account_number, w.amount_usd, payoutRef || `WD-${withdrawalId}`, actor, eatNow]
      );
    }
    await client.query('COMMIT');

    notifyUserDM(
      w.telegram_id,
      `💸 <b>Withdrawal Paid (#${withdrawalId})!</b>\n$${Number(w.amount_usd).toFixed(2)} USD sent to ${escHtml(w.payment_method)} (${escHtml(w.account_number)}).`,
      `💸 <b>ያወጡት ገንዘብ ተልኳል (#${withdrawalId})!</b>\n$${Number(w.amount_usd).toFixed(2)} USD ወደ ${escHtml(w.account_number)} ገቢ ተደርጓል።`
    );
    return { ok: true, withdrawal: w };
  } catch (err) {
    await client.query('ROLLBACK');
    return { ok: false, error: err.message };
  } finally {
    client.release();
  }
}

async function rejectWithdrawalById(withdrawalId, reason = 'Invalid account details', actor = 'ADMIN') {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const wRes = await client.query(`SELECT * FROM withdrawals WHERE id = $1 AND status = 'PENDING' FOR UPDATE`, [withdrawalId]);
    if (wRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return { ok: false, error: 'Pending withdrawal not found' };
    }
    const w = wRes.rows[0];
    await client.query(`UPDATE users SET balance_usd = balance_usd + $1 WHERE telegram_id = $2`, [w.amount_usd, w.telegram_id]);
    await client.query(`UPDATE withdrawals SET status = 'REJECTED', reject_reason = $1 WHERE id = $2`, [reason, withdrawalId]);
    await client.query('COMMIT');

    notifyUserDM(
      w.telegram_id,
      `↩️ <b>Withdrawal Rejected &amp; Refunded (#${withdrawalId})</b>\nReason: ${escHtml(reason)}\n$${Number(w.amount_usd).toFixed(2)} returned to your Vault.`,
      `↩️ <b>የማውጣት ጥያቄዎ ውድቅ ሆኖ ብሩ ተመልሷል (#${withdrawalId})</b>\nምክንያት: ${escHtml(reason)}`
    );
    return { ok: true, withdrawal: w };
  } catch (err) {
    await client.query('ROLLBACK');
    return { ok: false, error: err.message };
  } finally {
    client.release();
  }
}

async function reviewKycByUserId(telegramId, decision, reason = null) {
  await pool.query(
    `UPDATE users SET kyc_status = $1, kyc_reject_reason = $2 WHERE telegram_id = $3`,
    [decision, decision === 'Rejected' ? (reason || 'Documents unclear or invalid') : null, telegramId.toString()]
  );

  if (decision === 'Approved') {
    notifyUserDM(
      telegramId,
      `✅ <b>KYC Identity Approved!</b>\nYou now have full access to P2P Trading and Currency Conversion.`,
      `✅ <b>የማንነት ማረጋገጫዎ (KYC) ጸድቋል!</b>\nአሁን P2P መገበያየት ይችላሉ።`
    );
  } else {
    notifyUserDM(
      telegramId,
      `❌ <b>KYC Verification Rejected</b>\nReason: ${escHtml(reason || 'Please resubmit clearer photos')}`,
      `❌ <b>የማንነት ማረጋገጫዎ (KYC) ውድቅ ተደርጓል</b>\nምክንያት: ${escHtml(reason || 'እባክዎ ግልጽ ፎቶ ደግመው ይላኩ')}`
    );
  }
  return { ok: true };
}

async function releaseP2PTradeByCode(tradeCode, actor = 'ADMIN') {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const tRes = await client.query(`SELECT * FROM p2p_trades WHERE trade_code = $1 AND status IN ('PENDING', 'PAID', 'VERIFYING', 'DISPUTED') FOR UPDATE`, [tradeCode]);
    if (tRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return { ok: false, error: 'Trade not found or already closed' };
    }
    const trade = tRes.rows[0];
    const releaseAmt = parseFloat(trade.net_usd) > 0 ? parseFloat(trade.net_usd) : parseFloat(trade.amount_usd);

    // 1. Credit Buyer's Vault
    await client.query('UPDATE users SET balance_usd = balance_usd + $1 WHERE telegram_id = $2', [releaseAmt, trade.buyer_id]);
    // 2. Release Seller's Locked Escrow (if non-system seller)
    if (!String(trade.seller_id).startsWith('SYSTEM_')) {
      await client.query('UPDATE users SET locked_usd = GREATEST(0, locked_usd - $1) WHERE telegram_id = $2', [trade.amount_usd, trade.seller_id]);
    }
    // 3. Mark Trade Released & Queue Seller ETB Payout
    const payoutStatus = trade.seller_payout_account ? 'PENDING_PAYOUT' : 'NONE';
    await client.query(`UPDATE p2p_trades SET status = 'RELEASED', seller_payout_status = $1 WHERE trade_code = $2`, [payoutStatus, tradeCode]);

    await client.query(
      `INSERT INTO transactions (telegram_id, type, amount_usd, details) VALUES ($1, 'P2P_RELEASE', $2, $3)`,
      [trade.buyer_id, releaseAmt, `P2P Order ${tradeCode} Released`]
    );
    await client.query('COMMIT');

    notifyUserDM(
      trade.buyer_id,
      `✅ <b>P2P Order Released (${tradeCode})!</b>\n+$${releaseAmt.toFixed(2)} USDT added to your Vault.`,
      `✅ <b>የ P2P ትዕዛዝዎ ተለቋል (${tradeCode})!</b>\n+$${releaseAmt.toFixed(2)} USDT ወደ አካውንትዎ ገብቷል።`
    );
    if (!String(trade.seller_id).startsWith('SYSTEM_')) {
      notifyUserDM(
        trade.seller_id,
        `💰 <b>Your P2P Dollar Sold (${tradeCode})!</b>\nNet payout of ${Number(trade.seller_payout_etb).toLocaleString()} ETB (after 3% fee) is queued for your ${escHtml(trade.seller_payout_account)}.`,
        `💰 <b>የP2P ዶላርዎ ተሽጧል (${tradeCode})!</b>\n3% ኮሚሽን ተቀንሶ ${Number(trade.seller_payout_etb).toLocaleString()} ETB ወደ ${escHtml(trade.seller_payout_account)} ይላክልዎታል።`
      );
    }
    return { ok: true, trade, releaseAmt };
  } catch (err) {
    await client.query('ROLLBACK');
    return { ok: false, error: err.message };
  } finally {
    client.release();
  }
}

// ═════════════════════ 9. TELEGRAM GROUP WEBHOOK (INLINE APPROVE / REJECT + REASONS) ═════════════════════
app.post('/api/telegram/webhook', async (req, res) => {
  res.sendStatus(200); // Acknowledge Telegram immediately
  const update = req.body;
  if (!update || !pool) return;

  try {
    // 1. Handle Inline Button Clicks in Admin Group
    if (update.callback_query) {
      const cq = update.callback_query;
      const chatId = String(cq.message?.chat?.id || '');
      if (chatId !== String(ADMIN_GROUP_ID)) return;

      const adminTag = cq.from?.username ? `@${cq.from.username}` : (cq.from?.first_name || 'Admin');
      const parts = (cq.data || '').split(':');
      const action = parts[0];
      const targetId = parts[1];

      // Quick Approval Buttons
      if (action === 'dep_app') {
        const r = await approveDepositById(parseInt(targetId), adminTag);
        await tgCall('answerCallbackQuery', { callback_query_id: cq.id, text: r.ok ? 'Approved!' : r.error });
        if (r.ok) {
          await tgCall('editMessageCaption', { chat_id: chatId, message_id: cq.message.message_id, caption: `${cq.message.caption || ''}\n\n✅ <b>APPROVED by ${escHtml(adminTag)}</b>`, parse_mode: 'HTML' }).catch(() => {});
          await tgCall('editMessageText', { chat_id: chatId, message_id: cq.message.message_id, text: `${cq.message.text || ''}\n\n✅ <b>APPROVED by ${escHtml(adminTag)}</b>`, parse_mode: 'HTML' }).catch(() => {});
        }
      } else if (action === 'sto_app') {
        const r = await approveStoreOrderById(parseInt(targetId), adminTag);
        await tgCall('answerCallbackQuery', { callback_query_id: cq.id, text: r.ok ? 'Store Order Approved!' : r.error });
        if (r.ok) {
          await tgCall('editMessageCaption', { chat_id: chatId, message_id: cq.message.message_id, caption: `${cq.message.caption || ''}\n\n✅ <b>DELIVERED by ${escHtml(adminTag)}</b>`, parse_mode: 'HTML' }).catch(() => {});
          await tgCall('editMessageText', { chat_id: chatId, message_id: cq.message.message_id, text: `${cq.message.text || ''}\n\n✅ <b>DELIVERED by ${escHtml(adminTag)}</b>`, parse_mode: 'HTML' }).catch(() => {});
        }
      } else if (action === 'wdr_app') {
        const r = await approveWithdrawalById(parseInt(targetId), `TG-${adminTag}`, adminTag);
        await tgCall('answerCallbackQuery', { callback_query_id: cq.id, text: r.ok ? 'Marked Paid!' : r.error });
        if (r.ok) {
          await tgCall('editMessageText', { chat_id: chatId, message_id: cq.message.message_id, text: `${cq.message.text || ''}\n\n💸 <b>PAID by ${escHtml(adminTag)}</b>`, parse_mode: 'HTML' }).catch(() => {});
        }
      } else if (action === 'kyc_app') {
        await reviewKycByUserId(targetId, 'Approved');
        await tgCall('answerCallbackQuery', { callback_query_id: cq.id, text: 'KYC Approved!' });
        await tgCall('editMessageText', { chat_id: chatId, message_id: cq.message.message_id, text: `${cq.message.text || ''}\n\n✅ <b>KYC APPROVED by ${escHtml(adminTag)}</b>`, parse_mode: 'HTML' }).catch(() => {});
      } else if (action === 'p2p_rel') {
        const r = await releaseP2PTradeByCode(targetId, adminTag);
        await tgCall('answerCallbackQuery', { callback_query_id: cq.id, text: r.ok ? 'Crypto Released!' : r.error });
        if (r.ok) {
          await tgCall('editMessageCaption', { chat_id: chatId, message_id: cq.message.message_id, caption: `${cq.message.caption || ''}\n\n🔓 <b>RELEASED by ${escHtml(adminTag)}</b>`, parse_mode: 'HTML' }).catch(() => {});
          await tgCall('editMessageText', { chat_id: chatId, message_id: cq.message.message_id, text: `${cq.message.text || ''}\n\n🔓 <b>RELEASED by ${escHtml(adminTag)}</b>`, parse_mode: 'HTML' }).catch(() => {});
        }
      }
      // Show Rejection Reason Picker Menu
      else if (['dep_rej', 'sto_rej', 'wdr_rej', 'kyc_rej'].includes(action)) {
        const typeMap = { dep_rej: 'DEPOSIT', sto_rej: 'STORE', wdr_rej: 'WITHDRAW', kyc_rej: 'KYC' };
        const tType = typeMap[action];
        await tgCall('answerCallbackQuery', { callback_query_id: cq.id });
        await notifyAdminGroup(`Select rejection reason for <b>${tType} #${escHtml(targetId)}</b>:`, {
          inline_keyboard: [
            [{ text: '🚫 Fake / Not Received', callback_data: `rej_pick:${tType}:${targetId}:fake` }],
            [{ text: '🚫 Blurry / Unclear Photo', callback_data: `rej_pick:${tType}:${targetId}:blurry` }],
            [{ text: '🚫 Wrong Amount / Info', callback_data: `rej_pick:${tType}:${targetId}:amount` }],
            [{ text: '✍️ Write Custom Reason', callback_data: `rej_cust:${tType}:${targetId}` }]
          ]
        });
      }
      // Execute Quick-Pick Rejection Reason
      else if (action === 'rej_pick') {
        const [, tType, tId, reasonCode] = parts;
        const reasons = {
          fake: 'Fake receipt or payment not received.',
          blurry: 'Blurry or unclear photo. Please upload a clearer image.',
          amount: 'Incorrect amount or mismatched account details.'
        };
        const reason = reasons[reasonCode] || 'Verification failed.';
        await executeRejectionByType(tType, tId, reason, adminTag);
        await tgCall('answerCallbackQuery', { callback_query_id: cq.id, text: 'Rejected & User Notified!' });
        await tgCall('editMessageText', { chat_id: chatId, message_id: cq.message.message_id, text: `❌ <b>${tType} #${escHtml(tId)} REJECTED by ${escHtml(adminTag)}</b>\nReason: ${escHtml(reason)}`, parse_mode: 'HTML' });
      }
      // Trigger Custom Reply Reason (ForceReply)
      else if (action === 'rej_cust') {
        const [, tType, tId] = parts;
        await tgCall('answerCallbackQuery', { callback_query_id: cq.id });
        const sent = await tgCall('sendMessage', {
          chat_id: chatId,
          text: `✍️ ${escHtml(adminTag)}, reply to THIS message with the rejection reason for <b>${tType} #${escHtml(tId)}</b>:`,
          parse_mode: 'HTML',
          reply_markup: { force_reply: true, selective: true }
        });
        if (sent?.ok && sent.result?.message_id) {
          await pool.query(
            `INSERT INTO telegram_pending_replies (message_id, target_type, target_id, admin_tg_id) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
            [sent.result.message_id, tType, tId, String(cq.from.id)]
          );
        }
      }
    }

    // 2. Handle Admin Custom Rejection Reason Text Reply
    if (update.message?.reply_to_message && String(update.message.chat?.id) === String(ADMIN_GROUP_ID)) {
      const replyId = update.message.reply_to_message.message_id;
      const customReason = (update.message.text || '').trim();
      if (!customReason) return;

      const pRes = await pool.query(`DELETE FROM telegram_pending_replies WHERE message_id = $1 RETURNING *`, [replyId]);
      if (pRes.rows.length > 0) {
        const row = pRes.rows[0];
        const adminTag = update.message.from?.username ? `@${update.message.from.username}` : 'Admin';
        await executeRejectionByType(row.target_type, row.target_id, customReason, adminTag);
        await notifyAdminGroup(`❌ <b>${row.target_type} #${escHtml(row.target_id)} REJECTED by ${escHtml(adminTag)}</b>\nReason sent to user: <i>${escHtml(customReason)}</i>`);
      }
    }
  } catch (err) {
    console.error('Webhook processing error:', err.message);
  }
});

async function executeRejectionByType(tType, tId, reason, actor) {
  if (tType === 'DEPOSIT') return rejectDepositById(parseInt(tId), reason, actor);
  if (tType === 'STORE') return rejectStoreOrderById(parseInt(tId), reason, actor);
  if (tType === 'WITHDRAW') return rejectWithdrawalById(parseInt(tId), reason, actor);
  if (tType === 'KYC') return reviewKycByUserId(tId, 'Rejected', reason);
}

// ═════════════════════ 10. MINI APP REST APIS ═════════════════════

app.get('/health', (req, res) => res.status(200).send('OK'));

// 1. Config & Dynamic Accounts from DB (Cached)
app.get('/api/config', async (req, res) => {
  const cfg = await getSystemConfig();
  res.json({
    app_name: 'Binance Ethiopia Dollar Vault',
    fx_rate: cfg.fx_rate,
    stage4_min_invites: cfg.stage4_min_invites,
    stage4_min_deposit_usd: cfg.stage4_min_deposit_usd,
    p2p_fee_percent: cfg.p2p_fee_percent,
    min_withdraw_usd: cfg.min_withdraw_usd,
    min_withdraw_etb: cfg.min_withdraw_usd * cfg.fx_rate,
    bot_username: BINANCE_BOT_USER,
    channel_url: 'https://t.me/Binance_ethiopa',
    accounts: cfg.accounts
  });
});

// 2. Auth & Combined User Bootstrap (Low-Sync)
app.post('/api/auth', async (req, res) => {
  const { telegram_id, first_name, last_name, username, ref_by } = req.body;
  if (!telegram_id) return res.status(400).json({ error: 'telegram_id is required' });
  if (!pool) return res.json({ user: { balance_usd: 0.00, locked_usd: 0.00, kyc_status: 'None' }, isNew: false });

  try {
    const userResult = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [telegram_id.toString()]);
    if (userResult.rows.length === 0) {
      const validRef = (ref_by && ref_by !== telegram_id.toString()) ? ref_by : null;
      const ins = await pool.query(
        `INSERT INTO users (telegram_id, first_name, last_name, username, balance_usd, kyc_status, referred_by)
         VALUES ($1, $2, $3, $4, 0.00, 'None', $5) RETURNING *`,
        [telegram_id.toString(), first_name || 'User', last_name || '', username || '', validRef]
      );
      if (validRef) {
        await pool.query(`INSERT INTO referrals (referrer_id, referred_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [validRef, telegram_id.toString()]);
      }
      return res.json({ user: ins.rows[0], isNew: true });
    }
    if (userResult.rows[0].is_banned === 1) return res.status(403).json({ error: 'Account suspended.' });
    res.json({ user: userResult.rows[0], isNew: false });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Save Onboarding / Preferred Language
app.post('/api/user/preferences', async (req, res) => {
  const { telegram_id, preferred_lang, onboarding_done } = req.body;
  if (!telegram_id || !pool) return res.json({ ok: true });
  try {
    await pool.query(
      `UPDATE users SET preferred_lang = COALESCE($1, preferred_lang), onboarding_done = COALESCE($2, onboarding_done) WHERE telegram_id = $3`,
      [preferred_lang || null, onboarding_done !== undefined ? onboarding_done : null, telegram_id.toString()]
    );
    res.json({ ok: true });
  } catch { res.json({ ok: false }); }
});

// 3. KYC Submit (Forwards ID & Selfie Photos straight to Admin Group; zero bytes in DB)
app.post('/api/kyc/submit', async (req, res) => {
  const { telegram_id, phone_number, full_name, national_id, id_photo_base64, selfie_base64 } = req.body;
  if (!telegram_id || !phone_number || !full_name || !national_id) {
    return res.status(400).json({ error: 'All KYC fields are required' });
  }
  if (!pool) return res.status(500).json({ error: 'Database not connected' });

  try {
    await pool.query(
      `UPDATE users SET phone_number = $1, kyc_full_name = $2, national_id = $3, kyc_status = 'Pending', kyc_reject_reason = NULL WHERE telegram_id = $4`,
      [phone_number, full_name, national_id, telegram_id.toString()]
    );

    const baseCap = `🪪 <b>KYC VERIFICATION REQUEST</b>\n👤 User ID: <code>${escHtml(telegram_id)}</code>\n📛 Name: ${escHtml(full_name)}\n📱 Phone: ${escHtml(phone_number)}\n🆔 National ID: <code>${escHtml(national_id)}</code>\n🕒 ${formatEAT()}`;

    if (id_photo_base64) await sendBase64PhotoToGroup(id_photo_base64, `🪪 <b>ID Photo</b> — ${escHtml(full_name)} (<code>${escHtml(telegram_id)}</code>)`);
    if (selfie_base64) await sendBase64PhotoToGroup(selfie_base64, `🤳 <b>Selfie Holding ID</b> — ${escHtml(full_name)} (<code>${escHtml(telegram_id)}</code>)`);

    await notifyAdminGroup(baseCap, {
      inline_keyboard: [[
        { text: '✅ Approve KYC', callback_data: `kyc_app:${telegram_id}` },
        { text: '❌ Reject KYC', callback_data: `kyc_rej:${telegram_id}` }
      ]]
    });

    res.json({ success: true, kyc_status: 'Pending', message: 'Pending (waiting for admin review in Telegram)' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. Welcome Bonus ($0.50 + @Binance_ethiopa Channel Check)
app.post('/api/claim-welcome', async (req, res) => {
  const { telegram_id } = req.body;
  const BONUS_USD = 0.50;
  if (!pool) return res.status(500).json({ error: 'Database not connected' });

  try {
    const uRes = await pool.query('SELECT welcome_claimed, channel_joined, is_banned FROM users WHERE telegram_id = $1', [telegram_id.toString()]);
    if (uRes.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    if (uRes.rows[0].is_banned === 1) return res.status(403).json({ error: 'Account banned.' });
    if (uRes.rows[0].welcome_claimed === 1) return res.status(400).json({ error: 'Welcome bonus already claimed!' });

    if (uRes.rows[0].channel_joined === 0) {
      const ch = await checkChannelMembership(telegram_id);
      if (!ch.joined) {
        return res.status(400).json({ need_channel: true, channel_url: 'https://t.me/Binance_ethiopa', error: 'Please join @Binance_ethiopa channel first to claim $0.50!' });
      }
      await pool.query('UPDATE users SET channel_joined = 1 WHERE telegram_id = $1', [telegram_id.toString()]);
    }

    const update = await pool.query(
      `UPDATE users SET balance_usd = balance_usd + $1, welcome_claimed = 1 WHERE telegram_id = $2 AND welcome_claimed = 0 RETURNING balance_usd`,
      [BONUS_USD, telegram_id.toString()]
    );
    if (update.rowCount === 0) return res.status(400).json({ error: 'Already claimed!' });

    await pool.query(`INSERT INTO transactions (telegram_id, type, amount_usd, details) VALUES ($1, 'WELCOME_BONUS', $2, 'Welcome Gift')`, [telegram_id.toString(), BONUS_USD]);
    res.json({ success: true, balance_usd: parseFloat(update.rows[0].balance_usd), message: '🎉 $0.50 USD Welcome Bonus Credited!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5. Task Stages (Stage 4 = 10 Invites AND $16+ Approved Deposits)
app.post('/api/claim-stage', async (req, res) => {
  const { telegram_id, stage } = req.body;
  const stageNum = parseInt(stage);
  if (!pool) return res.status(500).json({ error: 'Database not connected' });

  try {
    const cfg = await getSystemConfig();
    const uRes = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [telegram_id.toString()]);
    if (uRes.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    const user = uRes.rows[0];
    if (user.is_banned === 1) return res.status(403).json({ error: 'Account banned.' });

    let rewardUSD = 0, col = '';
    if (stageNum === 1) {
      if (user.stage1_claimed === 1) return res.status(400).json({ error: 'Stage 1 already claimed' });
      if (REQUIRE_KYC && user.kyc_status !== 'Approved') return res.status(400).json({ error: 'Stage 1 requires Approved KYC.' });
      rewardUSD = 1.00; col = 'stage1_claimed';
    } else if (stageNum === 2) {
      if (user.stage1_claimed !== 1) return res.status(400).json({ error: 'Complete Stage 1 first' });
      if (user.stage2_claimed === 1) return res.status(400).json({ error: 'Stage 2 already claimed' });
      const depCheck = await pool.query(`SELECT COUNT(*) FROM deposits WHERE telegram_id = $1 AND status = 'APPROVED'`, [telegram_id.toString()]);
      if (parseInt(depCheck.rows[0].count) === 0) return res.status(400).json({ error: 'Stage 2 requires at least 1 approved Add Funds deposit.' });
      rewardUSD = 2.50; col = 'stage2_claimed';
    } else if (stageNum === 3) {
      if (user.stage2_claimed !== 1) return res.status(400).json({ error: 'Complete Stage 2 first' });
      if (user.stage3_claimed === 1) return res.status(400).json({ error: 'Stage 3 already claimed' });
      const refCheck = await pool.query(`SELECT COUNT(*) FROM referrals WHERE referrer_id = $1`, [telegram_id.toString()]);
      const inv = parseInt(refCheck.rows[0].count);
      if (inv < 5) return res.status(400).json({ error: `Stage 3 requires 5 active invites (${inv}/5).` });
      rewardUSD = 5.00; col = 'stage3_claimed';
    } else if (stageNum === 4) {
      if (user.stage3_claimed !== 1) return res.status(400).json({ error: 'Complete Stage 3 first' });
      if (user.stage4_claimed === 1) return res.status(400).json({ error: 'Stage 4 already claimed' });
      const [refCheck, depSum] = await Promise.all([
        pool.query(`SELECT COUNT(*) FROM referrals WHERE referrer_id = $1`, [telegram_id.toString()]),
        pool.query(`SELECT COALESCE(SUM(amount_usd), 0) AS total_usd FROM deposits WHERE telegram_id = $1 AND status = 'APPROVED'`, [telegram_id.toString()])
      ]);
      const inv = parseInt(refCheck.rows[0].count);
      const dep = parseFloat(depSum.rows[0].total_usd);
      // Both 10 invites AND $16+ deposit required
      if (inv < cfg.stage4_min_invites || dep < cfg.stage4_min_deposit_usd) {
        return res.status(400).json({
          error: `Stage 4 requires BOTH ${cfg.stage4_min_invites} invites (${inv}/${cfg.stage4_min_invites}) AND $${cfg.stage4_min_deposit_usd}+ approved deposits ($${dep.toFixed(2)}/$${cfg.stage4_min_deposit_usd}).`
        });
      }
      rewardUSD = 40.00; col = 'stage4_claimed';
    } else {
      return res.status(400).json({ error: 'Invalid stage' });
    }

    const upRes = await pool.query(
      `UPDATE users SET balance_usd = balance_usd + $1, ${col} = 1 WHERE telegram_id = $2 AND ${col} = 0 RETURNING balance_usd`,
      [rewardUSD, telegram_id.toString()]
    );
    await pool.query(`INSERT INTO transactions (telegram_id, type, amount_usd, details) VALUES ($1, 'STAGE_REWARD', $2, $3)`, [telegram_id.toString(), rewardUSD, `Stage ${stageNum} Milestone`]);
    res.json({ success: true, reward_usd: rewardUSD, balance_usd: parseFloat(upRes.rows[0].balance_usd) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 6. Add Funds (Exact Verify Server GET Spec + On-Chain + Screenshot to Telegram)
const handleAddFunds = async (req, res) => {
  const { telegram_id, currency, amount, payment_method, transaction_ref, sms_text, screenshot_base64 } = req.body;
  const cleanRef = (transaction_ref || '').trim();
  if (!telegram_id || !payment_method || (!cleanRef && !sms_text)) {
    return res.status(400).json({ error: 'Missing payment method, amount, or Transaction ID / SMS.' });
  }
  if (!pool) return res.status(500).json({ error: 'Database not connected' });

  try {
    const cfg = await getSystemConfig();
    const acc = cfg.accounts.find(a => a.key_slug === payment_method || a.label === payment_method);
    if (!acc || !acc.account_value) {
      return res.status(400).json({ error: `Payment method ${payment_method} is unavailable.` });
    }

    const uRes = await pool.query('SELECT first_name, username, is_banned FROM users WHERE telegram_id = $1', [telegram_id.toString()]);
    if (uRes.rows.length === 0) return res.status(404).json({ error: 'User not registered.' });
    if (uRes.rows[0].is_banned === 1) return res.status(403).json({ error: 'Account banned.' });
    const userLabel = uRes.rows[0].username ? `@${uRes.rows[0].username}` : uRes.rows[0].first_name;

    const effectiveRef = cleanRef || `SMS_${Date.now()}_${telegram_id}`;
    if (cleanRef && await isDuplicateRefAnywhere(cleanRef)) {
      await recordFakeAttempt(telegram_id, `Duplicate TxID reuse: ${cleanRef}`);
      return res.status(400).json({ error: 'This Transaction ID has already been used!' });
    }

    let amountVal = parseFloat(amount) || 0;
    let amountUSD = currency === 'ETB' ? (amountVal / cfg.fx_rate) : amountVal;

    let ver = { outcome: 'MANUAL' };
    if (acc.pool_type === 'ETB_OWNER') {
      ver = await verifyETBWithServer(cleanRef, amountVal, sms_text);
      if (ver.outcome === 'VERIFIED' && ver.amount) {
        amountVal = ver.amount;
        amountUSD = amountVal / cfg.fx_rate;
      }
    } else if (acc.network_type === 'ONCHAIN_BSC') {
      ver = await verifyBscTransaction(cleanRef, acc.account_value, amountUSD);
    } else if (acc.network_type === 'ONCHAIN_TRON') {
      ver = await verifyTronTransaction(cleanRef, acc.account_value, amountUSD);
    } else if (acc.network_type === 'EXCHANGE_ID') {
      const syn = validateExchangeOrderSyntax(cleanRef);
      if (!syn.valid) {
        await recordFakeAttempt(telegram_id, `Invalid Exchange ID: ${cleanRef}`);
        return res.status(400).json({ error: syn.reason });
      }
    }

    // Retryable state from Verify Server ("Pending" or "Resolving")
    if (ver.outcome === 'RETRY') {
      return res.status(200).json({ success: false, retryable: true, status: ver.status, message: ver.message });
    }

    // Hard Reject ("AlreadyUsed", "InvalidAmount", "Invalid_Transaction_Type", or bad on-chain hash)
    if (ver.outcome === 'REJECT') {
      await recordFakeAttempt(telegram_id, ver.reason);
      return res.status(400).json({ error: `❌ ${ver.reason}` });
    }

    const finalUsd = Math.round((ver.amountUsd || amountUSD) * 100) / 100;
    if (finalUsd <= 0) return res.status(400).json({ error: 'Invalid payment amount.' });

    const eatNow = formatEAT();
    const status = ver.outcome === 'VERIFIED' ? 'APPROVED' : 'PENDING';
    const verifiedBy = ver.outcome === 'VERIFIED' ? (acc.pool_type === 'ETB_OWNER' ? 'VERIFY_SERVER' : 'AUTO_ONCHAIN') : null;
    const dbRef = ver.ref || effectiveRef;

    const client = await pool.connect();
    let depositId;
    try {
      await client.query('BEGIN');
      const ins = await client.query(
        `INSERT INTO deposits (telegram_id, pool_target, currency, amount, amount_usd, fx_rate_used, payment_method, destination_account, transaction_ref, status, verified_by, eat_time)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
        [telegram_id.toString(), acc.pool_type, currency, amountVal, finalUsd, cfg.fx_rate, acc.key_slug, acc.account_value, dbRef, status, verifiedBy, eatNow]
      );
      depositId = ins.rows[0].id;

      if (status === 'APPROVED') {
        await client.query('UPDATE users SET balance_usd = balance_usd + $1 WHERE telegram_id = $2', [finalUsd, telegram_id.toString()]);
        await client.query(`INSERT INTO transactions (telegram_id, type, amount_usd, details) VALUES ($1, 'ADD_FUNDS', $2, $3)`, [telegram_id.toString(), finalUsd, `${verifiedBy}: ${acc.label}`]);
        if (acc.pool_type === 'USD_NBIYU') {
          await client.query(
            `INSERT INTO nbiyu_ledger (tx_code, direction, telegram_id, user_name, channel, destination_account, amount_usd, tx_ref, verified_by, eat_timestamp)
             VALUES ($1, 'IN', $2, $3, $4, $5, $6, $7, $8, $9)`,
            [`NBY-IN-${depositId}-${Date.now().toString().slice(-4)}`, telegram_id.toString(), userLabel, acc.label, acc.account_value, finalUsd, dbRef, verifiedBy, eatNow]
          );
        }
      }
      await client.query('COMMIT');
    } catch (txErr) {
      await client.query('ROLLBACK');
      throw txErr;
    } finally {
      client.release();
    }

    if (status === 'APPROVED') {
      notifyAdminGroup(
        `✅ <b>VERIFIED ADD FUNDS (${acc.pool_type})</b>\n👤 ${escHtml(userLabel)} (<code>${telegram_id}</code>)\n💵 <b>$${finalUsd.toFixed(2)} USD</b> (${amountVal} ${currency})\n🏦 ${escHtml(acc.label)}\n🧾 Ref: <code>${escHtml(dbRef)}</code>\n🤖 By: ${verifiedBy}\n🕒 ${eatNow}`
      );
    } else {
      const cap = `⏳ <b>PENDING ADD FUNDS #${depositId} (${acc.pool_type})</b>\n👤 ${escHtml(userLabel)} (<code>${telegram_id}</code>)\n💵 <b>$${finalUsd.toFixed(2)} USD</b> (${amountVal} ${currency})\n🏦 ${escHtml(acc.label)}\n📍 To: <code>${escHtml(acc.account_value)}</code>\n🧾 Ref: <code>${escHtml(dbRef)}</code>\n🕒 ${eatNow}`;
      const kb = { inline_keyboard: [[{ text: '✅ Approve', callback_data: `dep_app:${depositId}` }, { text: '❌ Reject', callback_data: `dep_rej:${depositId}` }]] };
      await sendBase64PhotoToGroup(screenshot_base64, cap, kb);
    }

    res.json({
      success: true,
      verified: status === 'APPROVED',
      message: status === 'APPROVED' ? `🎉 Verified! $${finalUsd.toFixed(2)} USD credited.` : 'Submitted! Waiting for admin review in Telegram.',
      deposit_id: depositId
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

app.post('/api/funds/add', handleAddFunds);
app.post('/api/deposit/submit', handleAddFunds);

// 7. Store: Separate Paid Checkout (`store_orders`)
const STORE_CATALOG = {
  VISA:       { name: 'International Virtual Visa Card', priceUsd: 1.50 },
  MASTERCARD: { name: 'International Virtual MasterCard', priceUsd: 1.50 },
  PHONE_US:   { name: 'USA (+1) Virtual Phone Number', priceUsd: 1.50 },
  TG_PREMIUM: { name: 'Telegram Premium (3 Months)', priceUsd: 10.00 },
  AUTOBOT:    { name: '30-Day Cloud Auto-Pilot', priceUsd: 2.00 }
};

app.post('/api/store/order', async (req, res) => {
  const { telegram_id, product_id, currency, payment_method, transaction_ref, sms_text, service_details, screenshot_base64 } = req.body;
  const prod = STORE_CATALOG[product_id];
  if (!prod) return res.status(400).json({ error: 'Invalid product.' });
  const cleanRef = (transaction_ref || '').trim();
  if (!telegram_id || !payment_method || (!cleanRef && !sms_text)) {
    return res.status(400).json({ error: 'Payment proof (TxID or SMS) is required.' });
  }
  if (!pool) return res.status(500).json({ error: 'Database not connected' });

  try {
    const cfg = await getSystemConfig();
    const acc = cfg.accounts.find(a => a.key_slug === payment_method || a.label === payment_method);
    if (!acc || !acc.account_value) return res.status(400).json({ error: 'Selected payment method is unavailable.' });

    const uRes = await pool.query('SELECT first_name, username, is_banned FROM users WHERE telegram_id = $1', [telegram_id.toString()]);
    if (uRes.rows[0]?.is_banned === 1) return res.status(403).json({ error: 'Account banned.' });

    if (cleanRef && await isDuplicateRefAnywhere(cleanRef)) {
      await recordFakeAttempt(telegram_id, `Duplicate Store TxID: ${cleanRef}`);
      return res.status(400).json({ error: 'This Transaction ID has already been used!' });
    }

    const expectedEtb = Math.round(prod.priceUsd * cfg.fx_rate * 100) / 100;
    let ver = { outcome: 'MANUAL' };
    if (acc.pool_type === 'ETB_OWNER') {
      ver = await verifyETBWithServer(cleanRef, expectedEtb, sms_text);
    } else if (acc.network_type === 'ONCHAIN_BSC') {
      ver = await verifyBscTransaction(cleanRef, acc.account_value, prod.priceUsd);
    } else if (acc.network_type === 'ONCHAIN_TRON') {
      ver = await verifyTronTransaction(cleanRef, acc.account_value, prod.priceUsd);
    } else if (acc.network_type === 'EXCHANGE_ID') {
      const syn = validateExchangeOrderSyntax(cleanRef);
      if (!syn.valid) return res.status(400).json({ error: syn.reason });
    }

    if (ver.outcome === 'RETRY') return res.status(200).json({ success: false, retryable: true, message: ver.message });
    if (ver.outcome === 'REJECT') {
      await recordFakeAttempt(telegram_id, ver.reason);
      return res.status(400).json({ error: `❌ ${ver.reason}` });
    }

    const orderCode = 'STR-' + Math.floor(100000 + Math.random() * 900000);
    const dbRef = ver.ref || cleanRef || `SMS_${Date.now()}`;
    const eatNow = formatEAT();

    const ins = await pool.query(
      `INSERT INTO store_orders (order_code, telegram_id, product_id, product_name, price_usd, price_etb, currency, payment_method, pool_target, transaction_ref, service_details, status, eat_time)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'PENDING', $12) RETURNING id`,
      [orderCode, telegram_id.toString(), product_id, prod.name, prod.priceUsd, expectedEtb, currency || 'ETB', acc.key_slug, acc.pool_type, dbRef, service_details || '', eatNow]
    );
    const orderId = ins.rows[0].id;

    // If auto-verified by bank/chain, fulfill right away!
    if (ver.outcome === 'VERIFIED') {
      const ful = await approveStoreOrderById(orderId, acc.pool_type === 'ETB_OWNER' ? 'VERIFY_SERVER' : 'AUTO_ONCHAIN');
      return res.json({ success: true, verified: true, message: `🎉 Payment verified! ${ful.deliveryInfo}`, order_code: orderCode });
    }

    const cap = `🛍️ <b>STORE ORDER #${orderId} (${orderCode})</b>\n📦 Product: <b>${escHtml(prod.name)}</b>\n👤 User: <code>${telegram_id}</code>\n💵 Price: $${prod.priceUsd.toFixed(2)} (${expectedEtb} ETB)\n🏦 Via: ${escHtml(acc.label)}\n🧾 Ref: <code>${escHtml(dbRef)}</code>\n🕒 ${eatNow}`;
    const kb = { inline_keyboard: [[{ text: '✅ Approve & Deliver', callback_data: `sto_app:${orderId}` }, { text: '❌ Reject', callback_data: `sto_rej:${orderId}` }]] };
    await sendBase64PhotoToGroup(screenshot_base64, cap, kb);

    res.json({ success: true, verified: false, message: `Order ${orderCode} submitted! Waiting for verification.`, order_code: orderCode });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/store/my', async (req, res) => {
  const { telegram_id } = req.query;
  if (!telegram_id || !pool) return res.json({ cards: [], orders: [], phones: [] });
  try {
    const [cards, orders, phones] = await Promise.all([
      pool.query('SELECT * FROM virtual_cards WHERE telegram_id = $1 ORDER BY id DESC', [telegram_id.toString()]),
      pool.query('SELECT * FROM store_orders WHERE telegram_id = $1 ORDER BY id DESC LIMIT 20', [telegram_id.toString()]),
      pool.query('SELECT * FROM phone_orders WHERE telegram_id = $1 ORDER BY id DESC LIMIT 20', [telegram_id.toString()])
    ]);
    res.json({ cards: cards.rows, orders: orders.rows, phones: phones.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 8. Withdrawals & User Ledger History
app.post('/api/withdraw', async (req, res) => {
  const { telegram_id, amount_usd, payment_method, account_number } = req.body;
  const amount = parseFloat(amount_usd);
  if (!pool) return res.status(500).json({ error: 'Database not connected' });

  const cfg = await getSystemConfig();
  if (!amount || amount < cfg.min_withdraw_usd) {
    return res.status(400).json({ error: `Minimum withdrawal is $${cfg.min_withdraw_usd.toFixed(2)} USD.` });
  }

  const isCrypto = /usdt|btc|eth|sol|ton|bnb|binance|bybit|okx|bitget|kucoin/i.test(payment_method || '');
  const poolSource = isCrypto ? 'USD_NBIYU' : 'ETB_OWNER';
  const eatNow = formatEAT();

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const deduct = await client.query(
      `UPDATE users SET balance_usd = balance_usd - $1 WHERE telegram_id = $2 AND balance_usd >= $1 AND is_banned = 0 RETURNING balance_usd`,
      [amount, telegram_id.toString()]
    );
    if (deduct.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Insufficient Vault balance or account banned!' });
    }

    const amountETB = Math.round(amount * cfg.fx_rate * 100) / 100;
    const wIns = await client.query(
      `INSERT INTO withdrawals (telegram_id, pool_source, amount_usd, amount_etb, payment_method, account_number, eat_time)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [telegram_id.toString(), poolSource, amount, amountETB, payment_method, account_number, eatNow]
    );
    await client.query(`INSERT INTO transactions (telegram_id, type, amount_usd, details) VALUES ($1, 'WITHDRAW', $2, $3)`, [telegram_id.toString(), amount, `Withdrawal #${wIns.rows[0].id} via ${payment_method}`]);
    await client.query('COMMIT');

    const wId = wIns.rows[0].id;
    notifyAdminGroup(
      `🚨 <b>WITHDRAWAL #${wId} (${poolSource})</b>\n👤 User: <code>${telegram_id}</code>\n💵 <b>$${amount.toFixed(2)} USD</b> (${amountETB.toLocaleString()} ETB)\n🏦 ${escHtml(payment_method)}: <code>${escHtml(account_number)}</code>\n🕒 ${eatNow}`,
      { inline_keyboard: [[{ text: '💸 Mark Paid', callback_data: `wdr_app:${wId}` }, { text: '↩️ Reject & Refund', callback_data: `wdr_rej:${wId}` }]] }
    );

    res.json({ success: true, balance_usd: parseFloat(deduct.rows[0].balance_usd), message: 'Withdrawal request submitted!' });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.get('/api/user/transactions', async (req, res) => {
  const { telegram_id } = req.query;
  if (!telegram_id || !pool) return res.json([]);
  try {
    const rows = await pool.query('SELECT * FROM transactions WHERE telegram_id = $1 ORDER BY id DESC LIMIT 25', [telegram_id.toString()]);
    res.json(rows.rows);
  } catch { res.json([]); }
});

// ═════════════════════ 11. P2P MARKETPLACE (ESCROW + SELLER PAYOUT + REFRESH + CANCEL) ═════════════════════

app.get('/api/p2p/ads', async (req, res) => {
  if (!pool) return res.json([]);
  const now = Date.now();
  if (p2pAdsCache.data && now < p2pAdsCache.expiresAt) return res.json(p2pAdsCache.data);
  try {
    const ads = await pool.query(`
      SELECT a.*, u.kyc_status FROM p2p_ads a
      LEFT JOIN users u ON a.creator_id = u.telegram_id
      WHERE a.status = 'ACTIVE' AND a.remaining_usd > 0 ORDER BY a.id DESC
    `);
    p2pAdsCache = { data: ads.rows, expiresAt: now + 15000 }; // 15s RAM cache
    res.json(ads.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/p2p/ads/create', async (req, res) => {
  const { telegram_id, creator_name, trade_type, price_etb, amount_usd, payment_methods, min_limit, max_limit, seller_payout_method, seller_payout_account } = req.body;
  if (!telegram_id || !trade_type || !price_etb || !amount_usd) return res.status(400).json({ error: 'Missing fields' });
  if (!pool) return res.status(500).json({ error: 'Database not connected' });

  const typeUpper = trade_type.toUpperCase();
  if (typeUpper === 'SELL' && (!seller_payout_method || !seller_payout_account)) {
    return res.status(400).json({ error: 'Please provide your CBE or Telebirr account to receive your Birr payout when sold!' });
  }

  try {
    const uRes = await pool.query('SELECT kyc_status, is_banned FROM users WHERE telegram_id = $1', [telegram_id.toString()]);
    if (uRes.rows[0]?.is_banned === 1) return res.status(403).json({ error: 'Account banned.' });
    if (REQUIRE_KYC && (!uRes.rows[0] || uRes.rows[0].kyc_status !== 'Approved')) {
      return res.status(403).json({ error: 'KYC verification is required before posting P2P ads.' });
    }

    const amtUSD = parseFloat(amount_usd);
    const rateETB = parseFloat(price_etb);

    if (typeUpper === 'SELL') {
      const lockRes = await pool.query(
        `UPDATE users SET balance_usd = balance_usd - $1, locked_usd = locked_usd + $1 WHERE telegram_id = $2 AND balance_usd >= $1 RETURNING balance_usd`,
        [amtUSD, telegram_id.toString()]
      );
      if (lockRes.rowCount === 0) return res.status(400).json({ error: 'Insufficient USD Vault balance for SELL ad.' });
    }

    const adRes = await pool.query(
      `INSERT INTO p2p_ads (creator_id, creator_name, trade_type, price_etb, amount_usd, remaining_usd, min_limit_etb, max_limit_etb, payment_methods, seller_payout_method, seller_payout_account)
       VALUES ($1, $2, $3, $4, $5, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [telegram_id.toString(), creator_name || 'Trader', typeUpper, rateETB, amtUSD, parseFloat(min_limit) || 250.00, parseFloat(max_limit) || 100000.00, payment_methods || 'Telebirr, CBE', seller_payout_method || null, seller_payout_account || null]
    );
    invalidateP2PCache();
    notifyAdminGroup(`📢 <b>New P2P Ad:</b> ${escHtml(creator_name)} (${typeUpper} $${amtUSD} @ ${rateETB} ETB)\n🕒 ${formatEAT()}`);
    res.json({ success: true, ad: adRes.rows[0], message: 'P2P Ad published!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/p2p/ads/cancel', async (req, res) => {
  const { telegram_id, ad_id } = req.body;
  if (!pool) return res.status(500).json({ error: 'Database not connected' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const aRes = await client.query(`SELECT * FROM p2p_ads WHERE id = $1 AND creator_id = $2 AND status = 'ACTIVE' FOR UPDATE`, [ad_id, telegram_id.toString()]);
    if (aRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Active ad not found' });
    }
    const ad = aRes.rows[0];
    if (ad.trade_type === 'SELL' && parseFloat(ad.remaining_usd) > 0) {
      await client.query(`UPDATE users SET locked_usd = GREATEST(0, locked_usd - $1), balance_usd = balance_usd + $1 WHERE telegram_id = $2`, [ad.remaining_usd, telegram_id.toString()]);
    }
    await client.query(`UPDATE p2p_ads SET status = 'CANCELLED', remaining_usd = 0 WHERE id = $1`, [ad_id]);
    await client.query('COMMIT');
    invalidateP2PCache();
    res.json({ success: true, message: 'Ad cancelled and remaining escrow unlocked.' });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.post('/api/p2p/trades/create', async (req, res) => {
  const { buyer_id, ad_id, amount_usdt, payment_method, receiving_id } = req.body;
  if (!buyer_id || !ad_id || !amount_usdt) return res.status(400).json({ error: 'Missing trade parameters' });
  if (!pool) return res.status(500).json({ error: 'Database not connected' });

  const client = await pool.connect();
  try {
    const cfg = await getSystemConfig();
    const uRes = await client.query('SELECT kyc_status, is_banned FROM users WHERE telegram_id = $1', [buyer_id.toString()]);
    if (uRes.rows[0]?.is_banned === 1) return res.status(403).json({ error: 'Account banned.' });
    if (REQUIRE_KYC && (!uRes.rows[0] || uRes.rows[0].kyc_status !== 'Approved')) {
      return res.status(403).json({ error: 'KYC verification is required before trading.' });
    }

    await client.query('BEGIN');
    const calc = calcOrder(parseFloat(amount_usdt), 0, cfg.p2p_fee_percent);
    const adRes = await client.query(
      `UPDATE p2p_ads SET remaining_usd = remaining_usd - $1 WHERE id = $2 AND status = 'ACTIVE' AND remaining_usd >= $1 RETURNING *`,
      [calc.gross, ad_id]
    );
    if (adRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Ad unavailable or insufficient USDT remaining.' });
    }
    const ad = adRes.rows[0];
    const finalCalc = calcOrder(calc.gross, parseFloat(ad.price_etb), cfg.p2p_fee_percent);
    const sellerPayoutEtb = Math.round(finalCalc.net * parseFloat(ad.price_etb) * 100) / 100;
    const sellerAccStr = ad.seller_payout_account ? `${ad.seller_payout_method || ''}: ${ad.seller_payout_account}` : null;

    const tradeCode = 'P2P-' + Math.floor(100000 + Math.random() * 900000);
    const eatNow = formatEAT();

    const tradeRes = await client.query(
      `INSERT INTO p2p_trades (trade_code, ad_id, buyer_id, seller_id, amount_usd, fee_usd, net_usd, amount_etb, seller_payout_etb, price_rate, payment_method, receiving_id, seller_payout_account, status, expires_at, eat_time)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'PENDING', NOW() + INTERVAL '15 minutes', $14) RETURNING *`,
      [tradeCode, ad.id, buyer_id.toString(), ad.creator_id, finalCalc.gross, finalCalc.fee, finalCalc.net, finalCalc.etbTotal, sellerPayoutEtb, ad.price_etb, payment_method || 'Telebirr/CBE', receiving_id || '', sellerAccStr, eatNow]
    );
    await client.query('COMMIT');
    invalidateP2PCache();

    res.json({ success: true, trade: tradeRes.rows[0], server_now: new Date().toISOString(), message: 'Order created! Complete payment within 15 minutes.' });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Lightweight Refresh Endpoint for 15-min Order Window
app.get('/api/p2p/trades/:trade_code', async (req, res) => {
  if (!pool) return res.status(404).json({ error: 'Not connected' });
  try {
    const r = await pool.query('SELECT * FROM p2p_trades WHERE trade_code = $1', [req.params.trade_code]);
    if (r.rows.length === 0) return res.status(404).json({ error: 'Order not found' });
    let trade = r.rows[0];

    if (trade.status === 'PENDING' && trade.expires_at && new Date(trade.expires_at) < new Date()) {
      const up = await pool.query(`UPDATE p2p_trades SET status = 'EXPIRED' WHERE trade_code = $1 AND status = 'PENDING' RETURNING *`, [trade.trade_code]);
      if (up.rowCount > 0) {
        trade = up.rows[0];
        await pool.query(`UPDATE p2p_ads SET remaining_usd = remaining_usd + $1 WHERE id = $2`, [trade.amount_usd, trade.ad_id]);
        invalidateP2PCache();
      }
    }
    res.json({ trade, server_now: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Mark Paid (NOT auto-approved: goes to Admin Group with screenshot for strict verification!)
app.post('/api/p2p/trades/mark-paid', async (req, res) => {
  const { trade_code, payment_ref, screenshot_base64 } = req.body;
  if (!trade_code || !payment_ref) return res.status(400).json({ error: 'Trade code and payment reference required' });
  if (!pool) return res.status(500).json({ error: 'Database not connected' });

  try {
    const tRes = await pool.query('SELECT * FROM p2p_trades WHERE trade_code = $1', [trade_code]);
    if (tRes.rows.length === 0) return res.status(404).json({ error: 'Trade not found' });
    const trade = tRes.rows[0];

    if (trade.status !== 'PENDING') return res.status(400).json({ error: `Order is already ${trade.status}.` });
    if (trade.expires_at && new Date(trade.expires_at) < new Date()) {
      await pool.query(`UPDATE p2p_trades SET status = 'EXPIRED' WHERE trade_code = $1`, [trade_code]);
      await pool.query(`UPDATE p2p_ads SET remaining_usd = remaining_usd + $1 WHERE id = $2`, [trade.amount_usd, trade.ad_id]);
      invalidateP2PCache();
      return res.status(400).json({ error: 'Order expired (15-minute window passed).' });
    }

    if (await isDuplicateRefAnywhere(payment_ref.trim())) {
      await recordFakeAttempt(trade.buyer_id, `Duplicate P2P TxID: ${payment_ref}`);
      return res.status(400).json({ error: 'This Transaction ID has already been used!' });
    }

    await pool.query(`UPDATE p2p_trades SET status = 'VERIFYING', payment_ref = $1 WHERE trade_code = $2`, [payment_ref.trim(), trade_code]);

    const cap = `🤝 <b>P2P PAYMENT PROOF (${trade_code})</b>\n👤 Buyer: <code>${trade.buyer_id}</code>\n💵 Paid: <b>${trade.amount_etb} ETB</b>\n🪙 Net Release: <b>$${trade.net_usd} USDT</b> (Fee: $${trade.fee_usd})\n🏦 Via: ${escHtml(trade.payment_method)}\n🧾 Ref: <code>${escHtml(payment_ref)}</code>\n💼 Seller Payout: ${escHtml(trade.seller_payout_account || 'System')}\n🕒 ${formatEAT()}`;
    const kb = { inline_keyboard: [[{ text: '🔓 Release Crypto', callback_data: `p2p_rel:${trade_code}` }]] };
    await sendBase64PhotoToGroup(screenshot_base64, cap, kb);

    res.json({ success: true, status: 'VERIFYING', message: 'Payment proof sent! Tap Refresh after verification.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/p2p/trades/cancel', async (req, res) => {
  const { trade_code, telegram_id } = req.body;
  if (!trade_code || !pool) return res.status(400).json({ error: 'Trade code required' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const tRes = await client.query(`SELECT * FROM p2p_trades WHERE trade_code = $1 AND status = 'PENDING' FOR UPDATE`, [trade_code]);
    if (tRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Only PENDING orders can be cancelled.' });
    }
    const trade = tRes.rows[0];
    if (telegram_id && String(trade.buyer_id) !== String(telegram_id)) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Not authorized to cancel this order.' });
    }
    await client.query(`UPDATE p2p_trades SET status = 'CANCELLED' WHERE trade_code = $1`, [trade_code]);
    await client.query(`UPDATE p2p_ads SET remaining_usd = remaining_usd + $1 WHERE id = $2`, [trade.amount_usd, trade.ad_id]);
    await client.query('COMMIT');
    invalidateP2PCache();
    res.json({ success: true, message: 'Order cancelled and liquidity restored.' });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.post('/api/p2p/trades/dispute', async (req, res) => {
  const { trade_code, reason } = req.body;
  if (!trade_code || !pool) return res.status(400).json({ error: 'Trade code required' });
  try {
    await pool.query(`UPDATE p2p_trades SET status = 'DISPUTED' WHERE trade_code = $1`, [trade_code]);
    notifyAdminGroup(`⚠️ <b>P2P DISPUTE OPENED (${escHtml(trade_code)})</b>\nReason: ${escHtml(reason || 'User opened dispute')}\n🕒 ${formatEAT()}`);
    res.json({ success: true, message: 'Dispute opened. Support notified in Telegram.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═════════════════════ 12. ADMIN PANEL APIS (ACCOUNTS, ANALYTICS, APPROVALS) ═════════════════════

// Accounts CRUD
app.get('/api/admin/accounts', auth, async (req, res) => {
  if (!pool) return res.json([]);
  const rows = await pool.query('SELECT * FROM payment_accounts ORDER BY sort_order ASC, id ASC');
  res.json(rows.rows);
});

app.post('/api/admin/accounts/add', auth, async (req, res) => {
  const { key_slug, pool_type, currency_group, label, account_value, account_holder, network_type, is_active } = req.body;
  if (!key_slug || !label) return res.status(400).json({ error: 'key_slug and label required' });
  try {
    await pool.query(
      `INSERT INTO payment_accounts (key_slug, pool_type, currency_group, label, account_value, account_holder, network_type, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [key_slug, pool_type || 'USD_NBIYU', currency_group || 'CRYPTO', label, account_value || '', account_holder || '', network_type || 'EXCHANGE_ID', is_active !== false]
    );
    invalidateConfigCache();
    res.json({ success: true, message: 'Account added!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/accounts/update', auth, async (req, res) => {
  const { id, label, account_value, account_holder, is_active } = req.body;
  if (!id) return res.status(400).json({ error: 'Account ID required' });
  try {
    await pool.query(
      `UPDATE payment_accounts SET label = COALESCE($1, label), account_value = COALESCE($2, account_value), account_holder = COALESCE($3, account_holder), is_active = COALESCE($4, is_active) WHERE id = $5`,
      [label, account_value, account_holder, is_active, id]
    );
    invalidateConfigCache();
    res.json({ success: true, message: 'Account updated!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/accounts/delete', auth, async (req, res) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ error: 'Account ID required' });
  try {
    await pool.query('DELETE FROM payment_accounts WHERE id = $1', [id]);
    invalidateConfigCache();
    res.json({ success: true, message: 'Account deleted!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Analytics & Queues
app.get('/api/admin/analytics', auth, async (req, res) => {
  if (!pool) return res.status(500).json({ error: 'DB not connected' });
  try {
    const cfg = await getSystemConfig();
    const [usersStat, etbIn, etbOut, nbiyuIn, nbiyuOut, nbiyuByChan, pendingCnts] = await Promise.all([
      pool.query(`SELECT COUNT(*) AS total_users, COUNT(*) FILTER (WHERE kyc_status='Approved') AS verified_users, COUNT(*) FILTER (WHERE kyc_status='Pending') AS pending_kycs, COUNT(*) FILTER (WHERE is_banned=1) AS banned_users, COALESCE(SUM(balance_usd),0) AS total_user_vault_usd FROM users`),
      pool.query(`SELECT COALESCE(SUM(amount),0) AS total_etb FROM deposits WHERE pool_target='ETB_OWNER' AND status='APPROVED'`),
      pool.query(`SELECT COALESCE(SUM(amount_etb),0) AS total_etb FROM withdrawals WHERE pool_source='ETB_OWNER' AND status='COMPLETED'`),
      pool.query(`SELECT COALESCE(SUM(amount_usd),0) AS total_in FROM nbiyu_ledger WHERE direction='IN'`),
      pool.query(`SELECT COALESCE(SUM(amount_usd),0) AS total_out FROM nbiyu_ledger WHERE direction='OUT'`),
      pool.query(`SELECT channel, COALESCE(SUM(CASE WHEN direction='IN' THEN amount_usd ELSE 0 END),0) AS in_usd, COALESCE(SUM(CASE WHEN direction='OUT' THEN amount_usd ELSE 0 END),0) AS out_usd, COUNT(*) AS tx_count FROM nbiyu_ledger GROUP BY channel ORDER BY in_usd DESC`),
      pool.query(`SELECT (SELECT COUNT(*) FROM deposits WHERE status='PENDING') AS pending_deposits, (SELECT COUNT(*) FROM store_orders WHERE status='PENDING') AS pending_store, (SELECT COUNT(*) FROM withdrawals WHERE status='PENDING') AS pending_withdrawals, (SELECT COUNT(*) FROM p2p_trades WHERE status IN ('PENDING','PAID','VERIFYING','DISPUTED')) AS active_p2p_trades`)
    ]);

    const nIn = parseFloat(nbiyuIn.rows[0].total_in), nOut = parseFloat(nbiyuOut.rows[0].total_out);
    const eIn = parseFloat(etbIn.rows[0].total_etb), eOut = parseFloat(etbOut.rows[0].total_etb);
    res.json({
      fx_rate: cfg.fx_rate,
      users: usersStat.rows[0],
      etb_owner_pool: { total_in_etb: eIn, total_out_etb: eOut, net_held_etb: eIn - eOut },
      nbiyu_dollar_pool: { total_in_usd: nIn, total_out_usd: nOut, net_held_usd: Math.round((nIn - nOut) * 100) / 100, by_channel: nbiyuByChan.rows },
      pending: pendingCnts.rows[0]
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/nbiyu-ledger', auth, async (req, res) => {
  if (!pool) return res.json([]);
  const rows = await pool.query('SELECT * FROM nbiyu_ledger ORDER BY id DESC LIMIT 150');
  res.json(rows.rows);
});

app.get('/api/admin/pending', auth, async (req, res) => {
  if (!pool) return res.json({});
  const [deps, stores, withs, kycs, trades] = await Promise.all([
    pool.query(`SELECT * FROM deposits WHERE status='PENDING' ORDER BY id DESC`),
    pool.query(`SELECT * FROM store_orders WHERE status='PENDING' ORDER BY id DESC`),
    pool.query(`SELECT * FROM withdrawals WHERE status='PENDING' ORDER BY id DESC`),
    pool.query(`SELECT telegram_id, first_name, username, phone_number, kyc_full_name, national_id, created_at FROM users WHERE kyc_status='Pending' ORDER BY id DESC`),
    pool.query(`SELECT * FROM p2p_trades WHERE status IN ('PENDING','PAID','VERIFYING','DISPUTED') ORDER BY id DESC`)
  ]);
  res.json({ pending_deposits: deps.rows, pending_store_orders: stores.rows, pending_withdrawals: withs.rows, pending_kycs: kycs.rows, active_p2p_trades: trades.rows });
});

app.get('/api/admin/users', auth, async (req, res) => {
  if (!pool) return res.json([]);
  const q = req.query.q ? `%${req.query.q.trim()}%` : null;
  const rows = q
    ? await pool.query(`SELECT * FROM users WHERE telegram_id ILIKE $1 OR first_name ILIKE $1 OR username ILIKE $1 ORDER BY id DESC LIMIT 50`, [q])
    : await pool.query(`SELECT * FROM users ORDER BY id DESC LIMIT 50`);
  res.json(rows.rows);
});

app.post('/api/admin/approve-deposit', auth, async (req, res) => {
  const r = await approveDepositById(req.body.deposit_id, 'ADMIN_PANEL');
  if (!r.ok) return res.status(400).json({ error: r.error });
  res.json({ success: true, message: `Deposit #${req.body.deposit_id} approved!` });
});
app.post('/api/admin/reject-deposit', auth, async (req, res) => {
  const r = await rejectDepositById(req.body.deposit_id, req.body.reason || 'Rejected by Admin', 'ADMIN_PANEL');
  if (!r.ok) return res.status(400).json({ error: r.error });
  res.json({ success: true, message: `Deposit #${req.body.deposit_id} rejected!` });
});
app.post('/api/admin/approve-store', auth, async (req, res) => {
  const r = await approveStoreOrderById(req.body.order_id, 'ADMIN_PANEL');
  if (!r.ok) return res.status(400).json({ error: r.error });
  res.json({ success: true, message: `Store order #${req.body.order_id} delivered!` });
});
app.post('/api/admin/reject-store', auth, async (req, res) => {
  const r = await rejectStoreOrderById(req.body.order_id, req.body.reason || 'Rejected by Admin', 'ADMIN_PANEL');
  if (!r.ok) return res.status(400).json({ error: r.error });
  res.json({ success: true, message: `Store order #${req.body.order_id} rejected!` });
});
app.post('/api/admin/approve-withdrawal', auth, async (req, res) => {
  const r = await approveWithdrawalById(req.body.withdrawal_id, req.body.payout_ref, 'ADMIN_PANEL');
  if (!r.ok) return res.status(400).json({ error: r.error });
  res.json({ success: true, message: 'Withdrawal marked COMPLETED!' });
});
app.post('/api/admin/reject-withdrawal', auth, async (req, res) => {
  const r = await rejectWithdrawalById(req.body.withdrawal_id, req.body.reason || 'Rejected by Admin', 'ADMIN_PANEL');
  if (!r.ok) return res.status(400).json({ error: r.error });
  res.json({ success: true, message: 'Withdrawal rejected & refunded!' });
});
app.post('/api/admin/kyc/review', auth, async (req, res) => {
  const { telegram_id, decision, reason } = req.body;
  if (!telegram_id || !['Approved', 'Rejected'].includes(decision)) return res.status(400).json({ error: 'Invalid input' });
  await reviewKycByUserId(telegram_id, decision, reason);
  res.json({ success: true, message: `KYC ${decision}` });
});
app.post('/api/admin/p2p/release', auth, async (req, res) => {
  const r = await releaseP2PTradeByCode(req.body.trade_code, 'ADMIN_PANEL');
  if (!r.ok) return res.status(400).json({ error: r.error });
  res.json({ success: true, message: `Trade ${req.body.trade_code} released!` });
});
app.post('/api/admin/set-rate', auth, async (req, res) => {
  const newRate = parseFloat(req.body.rate);
  if (!newRate || newRate <= 0) return res.status(400).json({ error: 'Valid rate required' });
  await pool.query(`INSERT INTO system_settings (key, value) VALUES ('fx_rate', $1) ON CONFLICT (key) DO UPDATE SET value = $1`, [newRate.toString()]);
  invalidateConfigCache();
  notifyAdminGroup(`⚙️ <b>Dollar Rate Updated:</b> 1 USD = <b>${newRate} ETB</b>`);
  res.json({ success: true, message: `Rate updated to 1 USD = ${newRate} ETB` });
});
app.post('/api/admin/adjust-balance', auth, async (req, res) => {
  const { telegram_id, amount_usd, action, reason } = req.body;
  const amt = parseFloat(amount_usd);
  if (!telegram_id || !amt) return res.status(400).json({ error: 'Invalid input' });
  const op = action === 'DEDUCT' ? '-' : '+';
  const up = await pool.query(`UPDATE users SET balance_usd = balance_usd ${op} $1 WHERE telegram_id = $2 RETURNING balance_usd`, [amt, telegram_id.toString()]);
  if (up.rowCount === 0) return res.status(404).json({ error: 'User not found' });
  await pool.query(`INSERT INTO transactions (telegram_id, type, amount_usd, details) VALUES ($1, 'ADMIN_ADJUST', $2, $3)`, [telegram_id.toString(), amt, reason || 'Admin adjustment']);
  res.json({ success: true, new_balance_usd: parseFloat(up.rows[0].balance_usd) });
});
app.post('/api/admin/ban-user', auth, async (req, res) => {
  const { telegram_id, banned } = req.body;
  await pool.query(`UPDATE users SET is_banned = $1, fake_attempts = 0 WHERE telegram_id = $2`, [banned ? 1 : 0, telegram_id.toString()]);
  res.json({ success: true, message: `User ${banned ? 'banned' : 'unbanned'}.` });
});

// ═════════════════════ 13. SWAP BROADCAST ENGINE (100% INTACT) ═════════════════════
let broadcastJob = { running: false, paused: false, stop: false, sent: 0, failed: 0, total: 0, startedAt: null, log: [] };

function personalise(text, username) {
  const name = (username && username !== 'None' && username !== 'undefined' && username.trim() !== '') ? username.trim() : 'ተጠቃሚ';
  return text.replace(/\{username\}/gi, name);
}
function mdToHtml(text) {
  return text
    .replace(/```([\s\S]*?)```/g, '<pre>$1</pre>')
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/_([^_\n]+)_/g, '<i>$1</i>')
    .replace(/~~([^~]+)~~/g, '<s>$1</s>')
    .replace(/\|\|([^|]+)\|\|/g, '<tg-spoiler>$1</tg-spoiler>');
}
async function sendBroadcastMsg(uid, rawText, username, photo, replyMarkup) {
  const htmlText = mdToHtml(personalise(rawText, username));
  if (photo) {
    try {
      const body = { chat_id: uid, photo, caption: htmlText, parse_mode: 'HTML' };
      if (replyMarkup) body.reply_markup = replyMarkup;
      const r = await fetch(`${TG_BC_API}/sendPhoto`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const d = await r.json();
      if (d.ok) return { success: true };
      if (d.error_code === 429) return { rateLimited: true, wait: (d.parameters?.retry_after || 3) + 1 };
    } catch (_) {}
  }
  try {
    const body = { chat_id: uid, text: htmlText, parse_mode: 'HTML' };
    if (replyMarkup) body.reply_markup = replyMarkup;
    const r = await fetch(`${TG_BC_API}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const d = await r.json();
    if (d.ok) return { success: true };
    if (d.error_code === 429) return { rateLimited: true, wait: (d.parameters?.retry_after || 3) + 1 };
    return { success: false, reason: d.description };
  } catch (e) { return { success: false, reason: e.message }; }
}
async function runBroadcast(users, text, photo, replyMarkup) {
  broadcastJob = { running: true, paused: false, stop: false, sent: 0, failed: 0, total: users.length, startedAt: new Date().toISOString(), log: [] };
  for (let i = 0; i < users.length; i++) {
    if (broadcastJob.stop) { appendLog('⏹️ Stopped at ' + i); break; }
    while (broadcastJob.paused) { await sleep(1000); if (broadcastJob.stop) break; }
    if (broadcastJob.stop) break;
    const { userId, username } = users[i];
    const result = await sendBroadcastMsg(userId, text, username || '', photo, replyMarkup);
    if (result.rateLimited) { appendLog('⚠️ Rate limited ' + result.wait + 's'); await sleep(result.wait * 1000); i--; continue; }
    if (result.success) broadcastJob.sent++;
    else { broadcastJob.failed++; appendLog('❌ ' + userId + ': ' + (result.reason || 'unknown')); }
    await sleep(35);
  }
  broadcastJob.running = false;
  appendLog('✅ Done — Sent: ' + broadcastJob.sent + ' | Failed: ' + broadcastJob.failed);
}
function appendLog(msg) { broadcastJob.log.push(msg); if (broadcastJob.log.length > 150) broadcastJob.log.shift(); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
async function fetchUsers() {
  if (!SHEET_URL) throw new Error('SHEET_URL env variable not set');
  const res = await fetch(SHEET_URL);
  if (!res.ok) throw new Error('Failed to fetch sheet: ' + res.status);
  const csv = await res.text();
  if (csv.trim().startsWith('<!DOCTYPE') || csv.includes('<html') || csv.includes('<script')) {
    throw new Error('SHEET_URL returned HTML instead of CSV.');
  }
  const lines = csv.trim().split('\n');
  if (lines.length < 2) throw new Error('Sheet is empty');
  const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, '').toLowerCase());
  let uidCol = headers.findIndex(h => ['_id', 'userid', 'user_id', 'chat_id', 'telegramid', 'telegram_id'].includes(h) || h.includes('userid') || h.includes('user_id'));
  if (uidCol === -1) uidCol = 0;
  let unameCol = headers.findIndex(h => ['username', 'user_name', 'name'].includes(h) || h.includes('username'));
  const users = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',').map(c => c.trim().replace(/^"|"$/g, ''));
    const uid = (cols[uidCol] || '').trim();
    if (uid && /^\d+$/.test(uid)) users.push({ userId: uid, username: unameCol >= 0 ? (cols[unameCol] || '').trim() : '' });
  }
  return users;
}

app.get('/status', async (req, res) => {
  const cfg = await getSystemConfig();
  res.json({
    server: 'Unified Binance ET Vault + Nbiyu Ledger + Swap Broadcast ✅',
    fx_rate: `1 USD = ${cfg.fx_rate} ETB`,
    app_bot: BINANCE_BOT_TOKEN ? '✅ Active' : '❌ Missing',
    broadcast_bot: BROADCAST_BOT_TOKEN ? '✅ Active' : '❌ Missing',
    broadcast: broadcastJob.running ? `🔄 Running — ${broadcastJob.sent}/${broadcastJob.total}` : '⏹️ Idle'
  });
});

app.post('/broadcast/start', auth, async (req, res) => {
  if (broadcastJob.running) return res.status(409).json({ error: 'Broadcast already running.' });
  const { text, photo, btnText, btnUrl, users: usersPayload, user_ids } = req.body;
  if (!text) return res.status(400).json({ error: 'text is required' });
  const replyMarkup = (btnText && btnUrl && btnUrl.startsWith('http')) ? { inline_keyboard: [[{ text: btnText, url: btnUrl }]] } : null;
  let users;
  if (Array.isArray(usersPayload) && usersPayload.length > 0) {
    users = usersPayload.map(u => ({ userId: String(u.userId || u.id || ''), username: u.username || u.name || '' })).filter(u => u.userId);
  } else if (Array.isArray(user_ids) && user_ids.length > 0) {
    users = user_ids.map(id => ({ userId: String(id), username: '' }));
  } else {
    try { users = await fetchUsers(); } catch (e) { return res.status(500).json({ error: e.message }); }
  }
  runBroadcast(users, text, photo || '', replyMarkup);
  res.json({ ok: true, message: 'Broadcast started', total: users.length });
});
app.post('/broadcast/pause', auth, (req, res) => { broadcastJob.paused = true; res.json({ ok: true, message: 'Paused' }); });
app.post('/broadcast/resume', auth, (req, res) => { broadcastJob.paused = false; res.json({ ok: true, message: 'Resumed' }); });
app.post('/broadcast/stop', auth, (req, res) => { broadcastJob.stop = true; broadcastJob.running = false; broadcastJob.paused = false; res.json({ ok: true, message: 'Stopped' }); });
app.get('/broadcast/status', auth, (req, res) => res.json({ running: broadcastJob.running, paused: broadcastJob.paused, sent: broadcastJob.sent, failed: broadcastJob.failed, total: broadcastJob.total, pct: broadcastJob.total ? Math.round((broadcastJob.sent + broadcastJob.failed) / broadcastJob.total * 100) : 0, startedAt: broadcastJob.startedAt, lastLog: broadcastJob.log.slice(-4) }));

// ═════════════════════ 14. STARTUP & WEBHOOK REGISTRATION ═════════════════════
process.on('uncaughtException', (err) => console.error('Uncaught Exception:', err.message));
process.on('unhandledRejection', (reason) => console.error('Unhandled Rejection:', reason));

app.listen(PORT, HOST, () => {
  console.log(`🚀 Unified Enterprise Server running on http://${HOST}:${PORT}`);
  initDB();
  if (BINANCE_BOT_TOKEN && PUBLIC_SERVER_URL) {
    tgCall('setWebhook', { url: `${PUBLIC_SERVER_URL}/api/telegram/webhook`, allowed_updates: ['message', 'callback_query'] })
      .then(d => console.log('🔗 Telegram Webhook Status:', d?.ok ? '✅ Active' : d?.description));
  }
});
