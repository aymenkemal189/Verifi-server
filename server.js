require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const https = require('https');
const crypto = require('crypto');

const SECRET_TOKEN = process.env.SECRET_TOKEN;
if (!SECRET_TOKEN && require.main === module) {
    console.error('SECRET_TOKEN env var is missing. Set it in Render > Environment.');
    process.exit(1);
}
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || '';

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cors());

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 6,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 10000
});
pool.on('error', (e) => console.error('pool error:', e.message));
process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e && e.message));

const CBE_HEADERS = {
    'X-App-ID': 'd1292e42-7400-49de-a2d3-9731caa4c819',
    'X-App-Version': '0a01980b-9859-1369-8198-59f403820000',
    'Accept': 'application/json',
    'User-Agent': 'Mozilla/5.0'
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const param = (req, k) => {
    const q = req.query && req.query[k];
    if (q !== undefined && q !== '') return q;
    const b = req.body && req.body[k];
    return (b !== undefined && b !== '') ? b : undefined;
};

function extractToken(req) {
    const authHdr = req.headers && req.headers.authorization;
    if (authHdr && /^Bearer\s+/i.test(authHdr)) return authHdr.replace(/^Bearer\s+/i, '').trim();
    if (req.headers && req.headers['x-token']) return String(req.headers['x-token']).trim();
    const t = param(req, 'token');
    return t ? String(t).trim() : '';
}

// ================= SMS PARSING & ACCOUNT MATCHING =================
const AM_IN = /ተቀብለዋል|ገቢ ሆኗል/;
const AM_OUT = /ከፍለዋል|ልከዋል|አስተላልፈዋል|ገዝተዋል|ተላልፏል/;
const NUM = '([0-9,]+(?:\\.[0-9]{1,2})?)';

function stripBalance(msg) {
    return msg.replace(/(?:ቀሪ\s*ሂሳብ|balance)[^0-9]{0,15}[0-9,]+(?:\.[0-9]{1,2})?\s*(?:ብር|ETB|Birr)?/ig, ' ');
}

function extractAmount(msg) {
    if (!msg) return 0;
    const m = stripBalance(msg);
    const match = m.match(new RegExp('(?:received|transferred|paid|credited|debited)\\s+(?:ETB|Birr)\\s*' + NUM, 'i'))
        || m.match(new RegExp('(?:received|transferred|paid|credited|debited)\\s+' + NUM + '\\s*(?:ETB|Birr)', 'i'))
        || m.match(new RegExp('(?:ETB|Birr)\\s*' + NUM, 'i'))
        || m.match(new RegExp(NUM + '\\s*ብር'));
    return match ? parseFloat(match[1].replace(/,/g, '')) : 0;
}

function extractBalance(msg) {
    const m = msg.match(/(?:ቀሪ\s*ሂሳብ|balance(?: is)?)[^0-9]{0,15}([0-9,]+(?:\.[0-9]{1,2})?)/i);
    return m ? parseFloat(m[1].replace(/,/g, '')) : null;
}

function extractTelebirrRef(msg) {
    const am = msg.match(/(?:የግብይት|የሂሳብ\s*እንቅስቃሴ)\s*ቁጥርዎ\s*([A-Z0-9]{8,14})/i);
    if (am) return am[1].toUpperCase();
    const en = msg.match(/transaction\s*(?:number|no|id)\s*(?:is)?[\s:]*([A-Z0-9]{10,12})\b/i);
    return en ? en[1].toUpperCase() : null;
}

function extractDirectFt(msg) {
    const m = msg.match(/\b(FT[A-Z0-9]{8,15})\b/i);
    return m ? m[1].toUpperCase() : null;
}

function normV2(code) { return 'v2-' + String(code).replace(/^v2-/i, ''); }

function extractV2Code(msg) {
    const m = msg.match(/cbe\.com\.et\/(v2-[A-Za-z0-9_-]+)/i);
    return m ? normV2(m[1]) : null;
}

function extractParty(msg, isIncoming, bank) {
    if (bank === 'CBE') {
        for (const g of msg.matchAll(/\(([^)]+)\)/g)) {
            if (/[A-Za-z]{3,}/.test(g[1]) && !/%/.test(g[1])) return g[1].trim().slice(0, 100);
        }
        const f = isIncoming ? msg.match(/from\s+([A-Za-z0-9\s*]+)/i) : msg.match(/to\s+([A-Za-z0-9\s*]+)/i);
        return f ? f[1].trim().slice(0, 100) : 'CBE Client';
    }
    if (AM_IN.test(msg) || AM_OUT.test(msg)) {
        const m = isIncoming ? msg.match(/ከ\s+(.+?)\s*\(/) : msg.match(/ለ\s+([^\s(]+)/);
        return m ? m[1].trim().slice(0, 100) : 'Telebirr Client';
    }
    const m = isIncoming ? msg.match(/from\s+([^(]+)\(/i) : msg.match(/to\s+([^(]+)\(/i);
    return m ? m[1].trim().slice(0, 100) : 'Telebirr Client';
}

function extractRecipientAccount(msg, isIncoming, bank) {
    if (!msg) return null;
    if (bank === 'CBE') {
        if (!isIncoming) {
            const m1 = msg.match(/\bto\s+(?:account\s*)?(?:no\.?\s*)?([0-9][0-9*]{4,18}[0-9])\b/i);
            if (m1) return m1[1].trim();
            const m2 = msg.match(/\bto\s+[^(\n]{1,60}\(\s*([0-9][0-9*]{4,18}[0-9])\s*\)/i);
            if (m2) return m2[1].trim();
            const m3 = msg.match(/\(([0-9*]{5,18})\)/);
            if (m3 && /\d{2,}/.test(m3[1])) return m3[1].trim();
        } else {
            const m = msg.match(/\bfrom\s+(?:account\s*)?([0-9][0-9*]{4,18}[0-9])\b/i);
            if (m) return m[1].trim();
        }
        return null;
    }
    const pParen = msg.match(/\(((?:\+?251|0)?[79][0-9*]{4,11}[0-9])\)/);
    if (pParen) return pParen[1].replace(/^\+/, '');
    if (!isIncoming) {
        const pAm = msg.match(/ለ\s*(?:\S+\s+)?\(?((?:\+?251|0)?[79][0-9*]{4,11}[0-9])\)?/);
        if (pAm) return pAm[1].replace(/^\+/, '');
        const pEn = msg.match(/\bto\s+(?:[A-Za-z.\s]{1,40})?((?:\+?251|0)?[79][0-9*]{4,11}[0-9])\b/i);
        if (pEn) return pEn[1].replace(/^\+/, '');
    } else {
        const pIn = msg.match(/(?:from|ከ)\s+(?:[A-Za-z.\s]{1,40})?((?:\+?251|0)?[79][0-9*]{4,11}[0-9])\b/i);
        if (pIn) return pIn[1].replace(/^\+/, '');
    }
    return null;
}

function normalizePhoneCore(val) {
    const clean = String(val || '').replace(/[\s\-+]/g, '');
    if (/^251[79]\d{8}$/.test(clean)) return clean.slice(3);
    if (/^0[79]\d{8}$/.test(clean)) return clean.slice(1);
    if (/^[79]\d{8}$/.test(clean)) return clean;
    return null;
}

function normalizeAccountMasked(val) {
    let s = String(val || '').replace(/[\s\-+]/g, '');
    if (!s) return '';
    if (s.startsWith('251') && s.length >= 8) s = s.slice(3);
    else if (/^0[79]/.test(s) && s.length >= 6) s = s.slice(1);
    return s;
}

function accountsMatch(smsAcc, reqAcc) {
    const aRaw = String(smsAcc || '').replace(/[\s\-+]/g, '');
    const bRaw = String(reqAcc || '').replace(/[\s\-+]/g, '');
    if (!aRaw || !bRaw) return false;
    if (aRaw === bRaw) return true;

    const aPhone = normalizePhoneCore(aRaw);
    const bPhone = normalizePhoneCore(bRaw);
    if (aPhone && bPhone) return aPhone === bPhone;

    const aNorm = normalizeAccountMasked(aRaw);
    const bNorm = normalizeAccountMasked(bRaw);
    if (aNorm === bNorm) return true;

    const matchMask = (masked, plain) => {
        if (!masked.includes('*') || plain.includes('*')) return false;
        const parts = masked.split(/\*+/);
        if (parts.length !== 2) return false;
        const [pre, suf] = parts;
        const isEthPhone = /^[79]\d{8}$/.test(plain);
        const minSuf = isEthPhone ? 3 : 4;
        if (suf.length < minSuf) return false;
        if (!pre && suf.length < 4) return false;
        return plain.startsWith(pre) && plain.endsWith(suf) && plain.length >= pre.length + suf.length;
    };

    return matchMask(aNorm, bNorm) || matchMask(bNorm, aNorm) || matchMask(aRaw, bRaw) || matchMask(bRaw, aRaw);
}

function detectCategory(msg, isIncoming) {
    if (isIncoming) return 'Received';
    if (/has been debited with ETB\s*[0-9,.]+\s*including Service charge/i.test(msg) && !/to account/i.test(msg)) return 'ATM/Card';
    if (/አየር\s*ሰዓት|የአየር|airtime|recharge|top\s*up/i.test(msg)) return 'Airtime';
    if (/ኢንተርኔት|ዳታ|ጥቅል|data|package|bundle/i.test(msg)) return 'Data';
    if (/ከፍለዋል|paid|purchase/i.test(msg)) return 'Payment';
    return 'Transfer';
}

function classify(message, sender) {
    const msg = String(message || '').replace(/\r?\n/g, ' ').trim();
    const snd = String(sender || '');
    let isCbe;
    if (/^\s*127\s*$|telebirr/i.test(snd)) isCbe = false;
    else if (/cbe/i.test(snd)) isCbe = true;
    else isCbe = /cbe\.com\.et|\bFT[A-Z0-9]{8,15}\b|from account\s+[0-9*]+|banking with CBE/i.test(msg);
    const bank = isCbe ? 'CBE' : 'Telebirr';
    const outEn = isCbe ? /you have (?:successfully )?transferred|has been debited|a debit transaction/i : /you have (?:successfully )?transferred|you have paid/i;
    const inEn = isCbe ? /you have received|has been credited|a credit transaction/i : /you have received/i;
    const inPos = msg.search(inEn), outPos = msg.search(outEn);
    let isIncoming = inEn.test(msg) || (!isCbe && AM_IN.test(msg));
    let isOutgoing = outEn.test(msg) || (!isCbe && AM_OUT.test(msg));
    if (isIncoming && isOutgoing) {
        if (outPos >= 0 && (inPos < 0 || outPos < inPos)) isIncoming = false; else isOutgoing = false;
    }
    return { msg, isCbe, bank, isIncoming, isOutgoing };
}

function parseVerifyInput(refIn, smsIn) {
    const text = String(smsIn || refIn || '').trim();
    if (!text) return null;
    const long = text.length > 30;
    const amount = long ? extractAmount(text) : 0;
    const ft = extractDirectFt(text);
    if (ft) return { type: 'ft', value: ft, amount };
    if (/^CBE-[A-Z0-9]{8,16}$/i.test(text)) return { type: 'ft', value: text.toUpperCase(), amount };
    const v2 = text.match(/\b(v2-[A-Za-z0-9_-]{6,})/i);
    if (v2) return { type: 'v2', value: normV2(v2[1]), amount };
    const rc = text.match(/receipt\/([A-Z0-9]{8,14})\b/i);
    const tb = rc ? rc[1].toUpperCase() : extractTelebirrRef(text) || (/^[A-Za-z0-9]{8,14}$/.test(text) ? text.toUpperCase() : null);
    return tb ? { type: 'tb', value: tb, amount } : null;
}

// ================= CBE RECEIPT RESOLVER =================
function fetchHttps(hostname, path, headers) {
    return new Promise((resolve, reject) => {
        const req = https.request({
            hostname, path, method: 'GET', headers: headers || CBE_HEADERS, rejectUnauthorized: false, timeout: 6000
        }, (res) => {
            let data = '';
            res.on('data', c => { if (data.length < 300000) data += c; });
            res.on('end', () => resolve({ status: res.statusCode, body: data }));
        });
        req.on('timeout', () => req.destroy(new Error('timeout')));
        req.on('error', reject);
        req.end();
    });
}

function cbeTargets(code) {
    const raw = code.replace(/^v2-/i, '');
    const enc = encodeURIComponent;
    return [
        { name: 'api-v2', host: 'mb.cbe.com.et', path: `/api/v1/transactions/public/transaction-detail/${enc('v2-' + raw)}`, headers: CBE_HEADERS },
        { name: 'api-raw', host: 'mb.cbe.com.et', path: `/api/v1/transactions/public/transaction-detail/${enc(raw)}`, headers: CBE_HEADERS },
        { name: 'receipt-page', host: 'mbreciept.cbe.com.et', path: `/${enc('v2-' + raw)}`, headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'text/html,application/json' } }
    ];
}

async function resolveFtNumber(v2Code, attempts = 1) {
    if (!v2Code) return null;
    for (let i = 0; i < attempts; i++) {
        for (const t of cbeTargets(v2Code)) {
            try {
                const r = await fetchHttps(t.host, t.path, t.headers);
                const m = r.body.match(/\b(FT[A-Z0-9]{8,15})\b/i);
                if (m) return m[1].toUpperCase();
            } catch (_) {}
        }
        if (i < attempts - 1) await sleep(1500);
    }
    return null;
}

let resolverBusy = false;
let resolverTimer = null;
const RESOLVE_EVERY = 30000;

async function settleFt(id, ft) {
    try {
        const u = await pool.query(
            'UPDATE cbe_transactions SET ref_no=$1 WHERE id=$2 AND ref_no IS NULL RETURNING v2_code, claimed_txn_id',
            [ft, id]
        );
        if (u.rows.length && u.rows[0].claimed_txn_id) {
            await pool.query(
                "UPDATE withdrawal_requests SET matched_ref=$1 WHERE txn_id=$2 AND matched_bank='CBE'",
                [ft, u.rows[0].claimed_txn_id]
            ).catch(() => {});
        }
        return 'Resolved';
    } catch (e) {
        if (e.code === '23505') {
            await pool.query('DELETE FROM cbe_transactions WHERE id=$1 AND ref_no IS NULL', [id]);
            return 'Duplicate';
        }
        throw e;
    }
}

async function resolvePending() {
    if (resolverBusy) return true;
    resolverBusy = true;
    try {
        const { rows } = await pool.query(
            `SELECT id, v2_code FROM cbe_transactions
             WHERE ref_no IS NULL AND v2_code IS NOT NULL AND resolve_attempts < 40
             ORDER BY id LIMIT 10`
        );
        if (!rows.length) return false;
        const failed = [];
        for (const row of rows) {
            const ft = await resolveFtNumber(row.v2_code, 1);
            if (ft) await settleFt(row.id, ft); else failed.push(row.id);
        }
        if (failed.length) {
            await pool.query('UPDATE cbe_transactions SET resolve_attempts = resolve_attempts+1 WHERE id = ANY($1::bigint[])', [failed]);
        }
        return failed.length > 0 || rows.length === 10;
    } catch (e) {
        console.error('resolver:', e.message);
        return true;
    } finally {
        resolverBusy = false;
    }
}

function scheduleResolve(ms = RESOLVE_EVERY) {
    if (resolverTimer) return;
    resolverTimer = setTimeout(async () => {
        resolverTimer = null;
        if (await resolvePending()) scheduleResolve();
    }, ms);
}

// ================= AUTH & AGENT CACHE =================
const AGENT_TTL = 60000;
let agentCache = { list: null, at: 0 };
function invalidateAgentCache() { agentCache = { list: null, at: 0 }; }

async function getAgents(includeInactive = false) {
    if (!includeInactive && agentCache.list && Date.now() - agentCache.at < AGENT_TTL) return agentCache.list;
    const r = await pool.query('SELECT id, name, token, match_text, phone, cbe_account, notes, active, created_at FROM agents ORDER BY id');
    const active = r.rows.filter(a => a.active);
    agentCache = { list: active, at: Date.now() };
    return includeInactive ? r.rows : active;
}

async function findAgentByToken(tk) {
    if (!tk) return null;
    return (await getAgents(false)).find(a => a.token === tk) || null;
}

async function findAgentByMsg(msg) {
    return (await getAgents(false)).find(a => a.match_text && msg.includes(a.match_text)) || null;
}

async function getAgentNameById(id) {
    if (!id) return 'Owner';
    const all = await getAgents(true);
    const a = all.find(x => Number(x.id) === Number(id));
    return a ? a.name : 'Agent #' + id;
}

function auth(req, res) {
    if (extractToken(req) !== SECRET_TOKEN) {
        res.status(401).json({ status: 'Unauthorized' });
        return false;
    }
    return true;
}

function authVerify(req, res) {
    const t = extractToken(req);
    if (t && (t === SECRET_TOKEN || (VERIFY_TOKEN && t === VERIFY_TOKEN))) return true;
    res.status(401).json({ status: 'Unauthorized' });
    return false;
}

async function authOwnerOrAgent(req, res, allowVerifyToken = false) {
    const t = extractToken(req);
    if (!t) { res.status(401).json({ status: 'Unauthorized' }); return null; }
    if (t === SECRET_TOKEN) return { role: 'owner', agent: null };
    if (allowVerifyToken && VERIFY_TOKEN && t === VERIFY_TOKEN) return { role: 'owner', agent: null };
    try {
        const agent = await findAgentByToken(t);
        if (!agent) { res.status(401).json({ status: 'Unauthorized' }); return null; }
        return { role: 'agent', agent };
    } catch (e) {
        console.error(e);
        res.status(500).json({ status: 'Database_Error' });
        return null;
    }
}

// ================= AUTO-MATCH WITHDRAWALS =================
async function tryAutoMatchOpenWithdrawal({ table, txId, bank, amount, recipientAccount, ref, agentId }) {
    if (!recipientAccount) return null;
    const { rows } = await pool.query(
        `SELECT id, txn_id, player_username, recipient_account, bank, agent_id
         FROM withdrawal_requests
         WHERE status = 'Open'
           AND ABS(amount - $1) < 0.01
           AND (bank IS NULL OR LOWER(bank) = LOWER($2))
           AND (agent_id IS NULL OR $3::int IS NULL OR agent_id = $3::int)
         ORDER BY created_at ASC, id ASC
         LIMIT 25`,
        [amount, bank, agentId || null]
    );
    const match = rows.find(r => accountsMatch(recipientAccount, r.recipient_account));
    if (!match) return null;

    const claimed = await pool.query(
        `UPDATE ${table}
         SET status = 'Payout_Verified',
             claimed_by = COALESCE(NULLIF($2, ''), claimed_by),
             claimed_txn_id = $3,
             claimed_at = NOW()
         WHERE id = $1 AND tx_type = 'Transferred' AND status = 'Sent_Locked'
         RETURNING id, claimed_by, claimed_txn_id, claimed_at`,
        [txId, match.player_username || '', match.txn_id]
    );
    if (!claimed.rows.length) return null;

    await pool.query(
        `UPDATE withdrawal_requests
         SET status = 'Verified', matched_ref = $2, matched_bank = $3, agent_id = COALESCE($4, agent_id), verified_at = NOW()
         WHERE id = $1`,
        [match.id, ref || null, bank, agentId || null]
    );
    return {
        claimed_by: claimed.rows[0].claimed_by || null,
        claimed_txn_id: claimed.rows[0].claimed_txn_id,
        claimed_at: claimed.rows[0].claimed_at
    };
}

// ================= 1. SMS WEBHOOK (GET or POST) =================
async function handleWebhookSms(req, res) {
    const actor = await authOwnerOrAgent(req, res, false);
    if (!actor) return;

    const message = param(req, 'message');
    const sender = param(req, 'sender');
    if (!message) return res.status(400).json({ status: 'Error', message: 'No SMS provided' });

    const c = classify(message, sender);
    if (!c.isIncoming && !c.isOutgoing) return res.json({ status: 'Ignored', reason: 'Not a payment SMS' });

    let agent = actor.agent;
    if (!agent && c.isIncoming) {
        try { agent = await findAgentByMsg(c.msg); } catch (e) { console.error(e); }
    }
    const agentId = agent ? agent.id : null;
    const agentLabel = agent ? agent.name : 'Owner';

    const amount = extractAmount(c.msg);
    const balance = extractBalance(c.msg);
    const party = extractParty(c.msg, c.isIncoming, c.bank);
    const recipientAccount = extractRecipientAccount(c.msg, c.isIncoming, c.bank);
    const category = detectCategory(c.msg, c.isIncoming);
    let ref = null, v2 = null;

    if (c.isCbe) {
        ref = extractDirectFt(c.msg);
        v2 = extractV2Code(c.msg);
        if (!ref && v2) ref = await resolveFtNumber(v2, 1);
        if (!ref && !v2) ref = 'CBE-' + crypto.createHash('sha1').update(c.msg).digest('hex').slice(0, 12).toUpperCase();
    } else {
        ref = extractTelebirrRef(c.msg);
        if (!ref) return res.json({ status: 'Ignored', reason: 'Missing Ref', bank: c.bank, type: c.isIncoming ? 'Received' : 'Transferred' });
    }
    if (!amount) return res.json({ status: 'Ignored', reason: 'Missing Amount', bank: c.bank, ref: ref || v2 || null });

    const txType = c.isIncoming ? 'Received' : 'Transferred';
    const initialStatus = c.isIncoming ? 'Unused' : 'Sent_Locked';
    const table = c.isCbe ? 'cbe_transactions' : 'telebirr_transactions';

    try {
        let result;
        if (c.isCbe) {
            result = await pool.query(
                `INSERT INTO cbe_transactions (tx_type, sender_name, amount, ref_no, raw_sms, status, category, balance, v2_code, recipient_account, agent_id)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING RETURNING id`,
                [txType, party, amount, ref, c.msg, initialStatus, category, balance, v2, recipientAccount, agentId]
            );
        } else {
            result = await pool.query(
                `INSERT INTO telebirr_transactions (tx_type, sender_name, amount, ref_no, raw_sms, status, category, balance, recipient_account, agent_id)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING RETURNING id`,
                [txType, party, amount, ref, c.msg, initialStatus, category, balance, recipientAccount, agentId]
            );
        }

        if (result.rows.length === 0) {
            const lookupCol = ref ? 'ref_no' : 'v2_code';
            const lookupVal = ref || v2;
            const ex = await pool.query(
                `SELECT t.status, t.claimed_by, t.claimed_txn_id, t.agent_id, a.name AS agent_name
                 FROM ${table} t LEFT JOIN agents a ON a.id = t.agent_id
                 WHERE t.${lookupCol} = $1 LIMIT 1`,
                [lookupVal]
            ).catch(() => ({ rows: [] }));
            const row = ex.rows[0];
            return res.json({
                status: 'Duplicate',
                bank: c.bank,
                type: txType,
                category,
                ref: ref || v2,
                amount,
                balance,
                party,
                recipient_account: recipientAccount,
                agent: row?.agent_name || agentLabel,
                agent_id: row?.agent_id ?? agentId,
                usage: row?.status || initialStatus,
                claimed_by: row?.claimed_by || null,
                claimed_txn_id: row?.claimed_txn_id || null
            });
        }

        const insertedId = result.rows[0].id;
        let finalUsage = initialStatus;
        let autoMatched = null;
        if (!c.isIncoming) {
            autoMatched = await tryAutoMatchOpenWithdrawal({
                table, txId: insertedId, bank: c.bank, amount,
                recipientAccount, ref: ref || v2, agentId
            }).catch((e) => { console.error('auto-match:', e.message); return null; });
            if (autoMatched) finalUsage = 'Payout_Verified';
        }

        if (c.isCbe && !ref) {
            scheduleResolve(3000);
            return res.json({
                status: 'Saved',
                bank: c.bank,
                type: txType,
                category,
                amount,
                balance,
                party,
                recipient_account: recipientAccount,
                agent: agentLabel,
                agent_id: agentId,
                usage: finalUsage,
                claimed_by: autoMatched?.claimed_by || null,
                claimed_txn_id: autoMatched?.claimed_txn_id || null,
                ref: null,
                resolving: true,
                v2
            });
        }

        return res.json({
            status: 'Saved',
            bank: c.bank,
            type: txType,
            category,
            ref,
            amount,
            balance,
            party,
            recipient_account: recipientAccount,
            agent: agentLabel,
            agent_id: agentId,
            usage: finalUsage,
            claimed_by: autoMatched?.claimed_by || null,
            claimed_txn_id: autoMatched?.claimed_txn_id || null
        });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ status: 'Database_Error' });
    }
}
app.get('/webhook/sms', handleWebhookSms);
app.post('/webhook/sms', handleWebhookSms);

// ================= 2. CBE MANUAL FT / PENDING LIST =================
app.get('/api/cbe/resolve', async (req, res) => {
    if (!auth(req, res)) return;
    const m = String(req.query.v2 || '').match(/v2-[A-Za-z0-9_-]+/i);
    const ft = String(req.query.ft || '').trim().toUpperCase();
    if (!m) return res.json({ status: 'Missing_V2' });
    if (!/^FT[A-Z0-9]{8,15}$/.test(ft)) return res.json({ status: 'Invalid_FT' });
    try {
        const r = await pool.query('SELECT id FROM cbe_transactions WHERE v2_code=$1 AND ref_no IS NULL', [normV2(m[0])]);
        if (!r.rows.length) return res.json({ status: 'Not_Pending' });
        return res.json({ status: await settleFt(r.rows[0].id, ft), ref_no: ft });
    } catch (e) { console.error(e); return res.status(500).json({ status: 'Database_Error' }); }
});

app.get('/api/cbe/pending', async (req, res) => {
    if (!auth(req, res)) return;
    try {
        const r = await pool.query(
            `SELECT id, v2_code, amount, sender_name, agent_id, resolve_attempts AS attempts
             FROM cbe_transactions WHERE ref_no IS NULL ORDER BY id DESC LIMIT 50`
        );
        return res.json({ status: 'OK', count: r.rows.length, items: r.rows });
    } catch (e) { console.error(e); return res.status(500).json({ status: 'Database_Error' }); }
});

app.get('/api/cbe/debug', async (req, res) => {
    if (!auth(req, res)) return;
    const m = String(req.query.v2 || '').match(/v2-[A-Za-z0-9_-]+/i);
    if (!m) return res.json({ status: 'Missing_V2' });
    const out = [];
    for (const t of cbeTargets(m[0])) {
        try {
            const r = await fetchHttps(t.host, t.path, t.headers);
            const ft = r.body.match(/\b(FT[A-Z0-9]{8,15})\b/i);
            out.push({ target: t.name, http: r.status, bytes: r.body.length, ft: ft ? ft[1].toUpperCase() : null, body: r.body.replace(/\s+/g, ' ').slice(0, 400) });
        } catch (e) { out.push({ target: t.name, error: e.message }); }
    }
    return res.json({ status: 'OK', results: out });
});

// ================= 3. DEPOSIT VERIFY (HuluBet) =================
async function tryUse(table, col, val, amount, claimedBy, claimedTxnId) {
    const r = await pool.query(
        `UPDATE ${table}
         SET status = 'Used',
             claimed_by = COALESCE(NULLIF($3, ''), claimed_by),
             claimed_txn_id = COALESCE(NULLIF($4, ''), claimed_txn_id),
             claimed_at = NOW()
         WHERE ${col} = $1
           AND tx_type = 'Received'
           AND status = 'Unused'
           AND ref_no IS NOT NULL
           AND ABS(amount - $2) < 0.01
         RETURNING amount, ref_no, sender_name, agent_id, claimed_by, claimed_txn_id`,
        [val, amount, claimedBy || '', claimedTxnId || '']
    );
    return r.rows[0] || null;
}

async function whyNot(table, col, val, bank, expected) {
    const r = await pool.query(
        `SELECT t.tx_type, t.ref_no, t.status, t.amount, t.claimed_by, t.claimed_txn_id, t.agent_id, a.name AS agent_name
         FROM ${table} t LEFT JOIN agents a ON a.id = t.agent_id
         WHERE t.${col} = $1`,
        [val]
    );
    if (!r.rows.length) return { status: 'Pending', bank };
    const tx = r.rows[0];
    if (tx.tx_type !== 'Received') return { status: 'Invalid_Transaction_Type', bank };
    if (!tx.ref_no) return { status: 'Resolving', bank };
    if (tx.status !== 'Unused') {
        return {
            status: 'AlreadyUsed',
            bank,
            claimed_by: tx.claimed_by || null,
            claimed_txn_id: tx.claimed_txn_id || null,
            agent_id: tx.agent_id || null,
            agent: tx.agent_name || (tx.agent_id ? 'Agent #' + tx.agent_id : 'Owner')
        };
    }
    return { status: 'InvalidAmount', expected, actual: parseFloat(tx.amount), bank };
}

async function handleVerifyDeposit(req, res) {
    if (!authVerify(req, res)) return;
    const inp = parseVerifyInput(param(req, 'ref'), param(req, 'sms') || param(req, 'text'));
    if (!inp) return res.json({ status: 'Missing_Ref' });

    let expected = parseFloat(param(req, 'amount'));
    if (isNaN(expected) && inp.amount) expected = inp.amount;
    if (isNaN(expected) || expected <= 0) return res.json({ status: 'Missing_Amount' });

    const claimedBy = String(param(req, 'claimed_by') || param(req, 'player') || '').trim();
    const claimedTxnId = String(param(req, 'claimed_txn_id') || param(req, 'txn_id') || '').trim();

    const isTb = inp.type === 'tb';
    const table = isTb ? 'telebirr_transactions' : 'cbe_transactions';
    const bank = isTb ? 'Telebirr' : 'CBE';
    let col = (inp.type === 'v2') ? 'v2_code' : 'ref_no';
    let val = inp.value;

    const done = async (tx) => res.json({
        status: 'Verified',
        bank,
        amount: parseFloat(tx.amount),
        ref_no: tx.ref_no,
        from_to: tx.sender_name,
        agent_id: tx.agent_id || null,
        agent: await getAgentNameById(tx.agent_id),
        claimed_by: tx.claimed_by || claimedBy || null,
        claimed_txn_id: tx.claimed_txn_id || claimedTxnId || null
    });

    try {
        let tx = await tryUse(table, col, val, expected, claimedBy, claimedTxnId);
        if (tx) return await done(tx);

        if (inp.type === 'v2') {
            const r = await pool.query('SELECT id, ref_no FROM cbe_transactions WHERE v2_code=$1', [val]);
            if (!r.rows.length || !r.rows[0].ref_no) {
                const ft = await resolveFtNumber(val, 1);
                if (ft) {
                    if (r.rows.length) await settleFt(r.rows[0].id, ft).catch(() => {});
                    col = 'ref_no'; val = ft;
                    tx = await tryUse(table, col, val, expected, claimedBy, claimedTxnId);
                    if (tx) return await done(tx);
                }
            }
        }
        return res.json(await whyNot(table, col, val, bank, expected));
    } catch (err) {
        console.error(err);
        return res.status(500).json({ status: 'System_Busy' });
    }
}
app.get('/api/verify', handleVerifyDeposit);
app.post('/api/verify', handleVerifyDeposit);

// ================= 4. WITHDRAWAL VERIFY & REQUESTS (HuluBet) =================
async function claimOutgoingRow(table, rowId, claimedBy, claimedTxnId) {
    const r = await pool.query(
        `UPDATE ${table}
         SET status = 'Payout_Verified',
             claimed_by = COALESCE(NULLIF($2, ''), claimed_by),
             claimed_txn_id = COALESCE(NULLIF($3, ''), claimed_txn_id),
             claimed_at = NOW()
         WHERE id = $1 AND tx_type = 'Transferred' AND status = 'Sent_Locked'
         RETURNING id, tx_type, amount, ref_no, sender_name, recipient_account, agent_id, claimed_by, claimed_txn_id, claimed_at`,
        [rowId, claimedBy || '', claimedTxnId || '']
    );
    return r.rows[0] || null;
}

async function handleVerifyWithdrawal(req, res) {
    if (!authVerify(req, res)) return;

    const txnId = String(param(req, 'txn_id') || param(req, 'claimed_txn_id') || '').trim();
    const claimedBy = String(param(req, 'claimed_by') || param(req, 'player') || '').trim();
    const recipientAcc = String(param(req, 'recipient_account') || param(req, 'account') || param(req, 'phone') || '').trim();
    const refIn = param(req, 'ref') || param(req, 'sms') || param(req, 'text');
    const bankIn = String(param(req, 'bank') || '').trim();
    const agentIdRaw = parseInt(param(req, 'agent_id'), 10);
    const agentId = isNaN(agentIdRaw) ? null : agentIdRaw;
    const strictAccount = String(param(req, 'strict_account') || 'true').toLowerCase() !== 'false';
    const windowHours = Math.min(Math.max(parseInt(param(req, 'window_hours'), 10) || 72, 1), 720);
    const sinceRaw = param(req, 'since');
    const sinceDate = sinceRaw && !isNaN(Date.parse(sinceRaw)) ? new Date(sinceRaw) : null;

    let expected = parseFloat(param(req, 'amount'));
    const hasExpected = !isNaN(expected) && expected > 0;

    try {
        // Mode A: Manual ref / full SMS provided
        if (refIn) {
            const inp = parseVerifyInput(refIn, refIn);
            if (!inp) return res.json({ status: 'Invalid_Ref' });
            if (!hasExpected && inp.amount > 0) expected = inp.amount;

            const t = await locate(inp);
            const found = await pool.query(`SELECT * FROM ${t.table} WHERE ${t.col} = $1 LIMIT 1`, [t.val]);
            if (!found.rows.length) return res.json({ status: 'Pending', bank: t.bank });
            const row = found.rows[0];
            if (row.tx_type !== 'Transferred') return res.json({ status: 'Invalid_Transaction_Type', bank: t.bank });
            if (row.status === 'Payout_Verified') {
                return res.json({
                    status: row.claimed_txn_id && txnId && row.claimed_txn_id === txnId ? 'Verified' : 'Already_Verified',
                    bank: t.bank,
                    ref_no: row.ref_no || row.v2_code,
                    amount: parseFloat(row.amount),
                    recipient_account: row.recipient_account || null,
                    agent_id: row.agent_id || null,
                    agent: await getAgentNameById(row.agent_id),
                    claimed_by: row.claimed_by || null,
                    claimed_txn_id: row.claimed_txn_id || null
                });
            }
            if (row.status !== 'Sent_Locked') return res.json({ status: 'Invalid_Status', usage: row.status, bank: t.bank });
            if (!isNaN(expected) && expected > 0 && Math.abs(parseFloat(row.amount) - expected) >= 0.01) {
                return res.json({ status: 'InvalidAmount', expected, actual: parseFloat(row.amount), bank: t.bank });
            }
            if (strictAccount && recipientAcc && row.recipient_account && !accountsMatch(row.recipient_account, recipientAcc)) {
                return res.json({
                    status: 'Account_Mismatch',
                    expected_account: recipientAcc,
                    sms_account: row.recipient_account,
                    bank: t.bank
                });
            }

            const claimed = await claimOutgoingRow(t.table, row.id, claimedBy, txnId);
            if (!claimed) return res.json({ status: 'Already_Verified', bank: t.bank });

            if (txnId) {
                await pool.query(
                    `UPDATE withdrawal_requests
                     SET status = 'Verified', matched_ref = $2, matched_bank = $3, agent_id = COALESCE($4, agent_id), verified_at = NOW()
                     WHERE txn_id = $1`,
                    [txnId, claimed.ref_no || row.v2_code || null, t.bank, claimed.agent_id]
                );
            }

            return res.json({
                status: 'Verified',
                bank: t.bank,
                ref_no: claimed.ref_no || row.v2_code,
                amount: parseFloat(claimed.amount),
                party: claimed.sender_name,
                recipient_account: claimed.recipient_account || null,
                agent_id: claimed.agent_id || null,
                agent: await getAgentNameById(claimed.agent_id),
                claimed_by: claimed.claimed_by || null,
                claimed_txn_id: claimed.claimed_txn_id || null,
                verified_at: claimed.claimed_at
            });
        }

        // Mode B: Auto-match by amount + recipient_account
        if (isNaN(expected) || expected <= 0) return res.json({ status: 'Missing_Amount' });
        if (!recipientAcc) return res.json({ status: 'Missing_Recipient_Account' });

        const tables = [];
        if (!bankIn || /telebirr/i.test(bankIn)) tables.push({ bank: 'Telebirr', table: 'telebirr_transactions' });
        if (!bankIn || /cbe/i.test(bankIn)) tables.push({ bank: 'CBE', table: 'cbe_transactions' });
        if (!tables.length) return res.json({ status: 'Invalid_Bank' });

        for (const t of tables) {
            const { rows } = await pool.query(
                `SELECT id, amount, ref_no, ${t.bank === 'CBE' ? 'v2_code,' : ''} sender_name, recipient_account, agent_id, created_at
                 FROM ${t.table}
                 WHERE tx_type = 'Transferred'
                   AND status = 'Sent_Locked'
                   AND ABS(amount - $1) < 0.01
                   AND created_at >= NOW() - make_interval(hours => $2)
                   AND ($3::timestamptz IS NULL OR created_at >= $3::timestamptz)
                   AND ($4::int IS NULL OR agent_id = $4::int)
                 ORDER BY created_at DESC, id DESC
                 LIMIT 30`,
                [expected, windowHours, sinceDate, agentId]
            );
            const matched = rows.find(r => r.recipient_account && accountsMatch(r.recipient_account, recipientAcc));
            if (!matched) continue;

            const claimed = await claimOutgoingRow(t.table, matched.id, claimedBy, txnId);
            if (!claimed) continue;

            if (txnId) {
                await pool.query(
                    `UPDATE withdrawal_requests
                     SET status = 'Verified', matched_ref = $2, matched_bank = $3, agent_id = COALESCE($4, agent_id), verified_at = NOW()
                     WHERE txn_id = $1`,
                    [txnId, claimed.ref_no || matched.v2_code || null, t.bank, claimed.agent_id]
                );
            }

            return res.json({
                status: 'Verified',
                bank: t.bank,
                ref_no: claimed.ref_no || matched.v2_code || null,
                amount: parseFloat(claimed.amount),
                party: claimed.sender_name,
                recipient_account: claimed.recipient_account || null,
                agent_id: claimed.agent_id || null,
                agent: await getAgentNameById(claimed.agent_id),
                claimed_by: claimed.claimed_by || null,
                claimed_txn_id: claimed.claimed_txn_id || null,
                verified_at: claimed.claimed_at
            });
        }

        return res.json({ status: 'Pending', expected, recipient_account: recipientAcc, bank: bankIn || 'Any' });
    } catch (e) {
        console.error(e);
        return res.status(500).json({ status: 'Database_Error' });
    }
}
app.get('/api/verify-withdrawal', handleVerifyWithdrawal);
app.post('/api/verify-withdrawal', handleVerifyWithdrawal);

async function handleWithdrawalRequest(req, res) {
    if (!authVerify(req, res)) return;
    const txnId = String(param(req, 'txn_id') || '').trim();
    const amount = parseFloat(param(req, 'amount'));
    const recipientAcc = String(param(req, 'recipient_account') || param(req, 'account') || param(req, 'phone') || '').trim();
    const bankIn = String(param(req, 'bank') || '').trim() || null;
    const playerUsername = String(param(req, 'player_username') || param(req, 'claimed_by') || '').trim() || null;
    const agentIdRaw = parseInt(param(req, 'agent_id'), 10);
    const agentId = isNaN(agentIdRaw) ? null : agentIdRaw;

    if (!txnId) return res.json({ status: 'Missing_Txn_Id' });
    if (isNaN(amount) || amount <= 0) return res.json({ status: 'Missing_Amount' });
    if (!recipientAcc) return res.json({ status: 'Missing_Recipient_Account' });

    try {
        const tables = [];
        if (!bankIn || /telebirr/i.test(bankIn)) tables.push({ bank: 'Telebirr', table: 'telebirr_transactions' });
        if (!bankIn || /cbe/i.test(bankIn)) tables.push({ bank: 'CBE', table: 'cbe_transactions' });

        for (const t of tables) {
            const { rows } = await pool.query(
                `SELECT id, amount, ref_no, ${t.bank === 'CBE' ? 'v2_code,' : ''} sender_name, recipient_account, agent_id
                 FROM ${t.table}
                 WHERE tx_type = 'Transferred'
                   AND status = 'Sent_Locked'
                   AND ABS(amount - $1) < 0.01
                   AND created_at >= NOW() - INTERVAL '48 hours'
                   AND ($2::int IS NULL OR agent_id = $2::int)
                 ORDER BY created_at DESC, id DESC LIMIT 25`,
                [amount, agentId]
            );
            const matched = rows.find(r => r.recipient_account && accountsMatch(r.recipient_account, recipientAcc));
            if (!matched) continue;

            const claimed = await claimOutgoingRow(t.table, matched.id, playerUsername || '', txnId);
            if (!claimed) continue;

            await pool.query(
                `INSERT INTO withdrawal_requests (txn_id, bank, amount, recipient_account, player_username, agent_id, status, matched_ref, matched_bank, verified_at)
                 VALUES ($1,$2,$3,$4,$5,$6,'Verified',$7,$8,NOW())
                 ON CONFLICT (txn_id) DO UPDATE
                 SET status='Verified', matched_ref=EXCLUDED.matched_ref, matched_bank=EXCLUDED.matched_bank,
                     agent_id=COALESCE(EXCLUDED.agent_id, withdrawal_requests.agent_id), verified_at=NOW()`,
                [txnId, bankIn, amount, recipientAcc, playerUsername, claimed.agent_id || agentId, claimed.ref_no || matched.v2_code || null, t.bank]
            );

            return res.json({
                status: 'Already_Matched_Verified',
                txn_id: txnId,
                bank: t.bank,
                ref_no: claimed.ref_no || matched.v2_code || null,
                amount: parseFloat(claimed.amount),
                recipient_account: claimed.recipient_account || null,
                agent_id: claimed.agent_id || null,
                agent: await getAgentNameById(claimed.agent_id),
                claimed_by: claimed.claimed_by || null,
                claimed_txn_id: claimed.claimed_txn_id
            });
        }

        await pool.query(
            `INSERT INTO withdrawal_requests (txn_id, bank, amount, recipient_account, player_username, agent_id, status)
             VALUES ($1,$2,$3,$4,$5,$6,'Open')
             ON CONFLICT (txn_id) DO UPDATE
             SET bank=COALESCE(EXCLUDED.bank, withdrawal_requests.bank),
                 amount=EXCLUDED.amount,
                 recipient_account=EXCLUDED.recipient_account,
                 player_username=COALESCE(EXCLUDED.player_username, withdrawal_requests.player_username),
                 agent_id=COALESCE(EXCLUDED.agent_id, withdrawal_requests.agent_id)`,
            [txnId, bankIn, amount, recipientAcc, playerUsername, agentId]
        );
        return res.json({ status: 'Queued', txn_id: txnId, bank: bankIn, amount, recipient_account: recipientAcc });
    } catch (e) {
        console.error(e);
        return res.status(500).json({ status: 'Database_Error' });
    }
}
app.get('/api/withdrawal-request', handleWithdrawalRequest);
app.post('/api/withdrawal-request', handleWithdrawalRequest);

app.get('/api/check-withdrawal', async (req, res) => {
    if (!authVerify(req, res)) return;
    const txnId = String(param(req, 'txn_id') || '').trim();
    if (!txnId) return res.json({ status: 'Missing_Txn_Id' });
    try {
        const r = await pool.query(
            `SELECT w.*, a.name AS agent_name
             FROM withdrawal_requests w LEFT JOIN agents a ON a.id = w.agent_id
             WHERE w.txn_id = $1`,
            [txnId]
        );
        if (r.rows.length) {
            const x = r.rows[0];
            return res.json({
                status: x.status === 'Verified' ? 'Verified' : x.status,
                txn_id: x.txn_id,
                bank: x.matched_bank || x.bank,
                amount: parseFloat(x.amount),
                recipient_account: x.recipient_account,
                claimed_by: x.player_username || null,
                claimed_txn_id: x.txn_id,
                ref_no: x.matched_ref || null,
                agent_id: x.agent_id || null,
                agent: x.agent_name || (x.agent_id ? 'Agent #' + x.agent_id : 'Owner'),
                verified_at: x.verified_at || null
            });
        }
        const tRes = await pool.query(
            `SELECT 'CBE' AS bank, ref_no, amount, recipient_account, claimed_by, claimed_txn_id, agent_id, claimed_at
             FROM cbe_transactions WHERE claimed_txn_id = $1
             UNION ALL
             SELECT 'Telebirr' AS bank, ref_no, amount, recipient_account, claimed_by, claimed_txn_id, agent_id, claimed_at
             FROM telebirr_transactions WHERE claimed_txn_id = $1
             LIMIT 1`,
            [txnId]
        );
        if (!tRes.rows.length) return res.json({ status: 'Not_Found', txn_id: txnId });
        const row = tRes.rows[0];
        return res.json({
            status: 'Verified',
            txn_id: txnId,
            bank: row.bank,
            amount: parseFloat(row.amount),
            recipient_account: row.recipient_account || null,
            claimed_by: row.claimed_by || null,
            claimed_txn_id: row.claimed_txn_id,
            ref_no: row.ref_no,
            agent_id: row.agent_id || null,
            agent: await getAgentNameById(row.agent_id),
            verified_at: row.claimed_at || null
        });
    } catch (e) {
        console.error(e);
        return res.status(500).json({ status: 'Database_Error' });
    }
});

// ================= 5. READ-ONLY CHECK & RECENT (Owner OR Agent) =================
async function locate(inp) {
    if (inp.type === 'tb') return { table: 'telebirr_transactions', col: 'ref_no', val: inp.value, bank: 'Telebirr' };
    const o = { table: 'cbe_transactions', bank: 'CBE', col: 'ref_no', val: inp.value };
    if (inp.type === 'v2') {
        o.col = 'v2_code';
        const r = await pool.query('SELECT id, ref_no FROM cbe_transactions WHERE v2_code=$1', [inp.value]);
        if (!r.rows.length || !r.rows[0].ref_no) {
            const ft = await resolveFtNumber(inp.value, 1);
            if (ft) { if (r.rows.length) await settleFt(r.rows[0].id, ft).catch(() => {}); o.col = 'ref_no'; o.val = ft; }
        }
    }
    return o;
}

app.get('/api/check', async (req, res) => {
    const actor = await authOwnerOrAgent(req, res, true);
    if (!actor) return;
    const inp = parseVerifyInput(req.query.ref, req.query.sms || req.query.text);
    if (!inp) return res.json({ status: 'Missing_Ref' });

    try {
        const t = await locate(inp);
        const whereAgent = actor.agent ? 'AND t.agent_id = $2' : '';
        const args = actor.agent ? [t.val, actor.agent.id] : [t.val];
        const r = await pool.query(
            `SELECT t.*, a.name AS agent_name
             FROM ${t.table} t LEFT JOIN agents a ON a.id = t.agent_id
             WHERE t.${t.col} = $1 ${whereAgent} LIMIT 1`,
            args
        );
        if (!r.rows.length) return res.json({ status: 'Not_Found', bank: t.bank, looked_for: t.val });
        const x = r.rows[0];
        const out = {
            status: x.ref_no ? 'Found' : 'Found_FT_Pending',
            bank: t.bank,
            type: x.tx_type,
            amount: parseFloat(x.amount),
            ref: x.ref_no || x.v2_code || null,
            ref_no: x.ref_no,
            party: x.sender_name,
            recipient_account: x.recipient_account || null,
            usage: x.status,
            category: x.category || null,
            balance: x.balance != null ? parseFloat(x.balance) : null,
            v2_code: x.v2_code || null,
            created_at: x.created_at || null,
            agent_id: x.agent_id || null,
            agent: x.agent_name || (x.agent_id ? 'Agent #' + x.agent_id : 'Owner'),
            claimed_by: x.claimed_by || null,
            claimed_txn_id: x.claimed_txn_id || null,
            claimed_at: x.claimed_at || null
        };
        if (req.query.live && t.bank === 'CBE' && (x.v2_code || inp.type === 'v2')) {
            try {
                const tg = cbeTargets(x.v2_code || inp.value)[0];
                const j = JSON.parse((await fetchHttps(tg.host, tg.path, tg.headers)).body);
                out.cbe_live = {
                    ft: j.id, amount: j.debitAmount, from: j.debitAccountNo, to: j.creditAccountNo, date: j.debitValueDate,
                    amount_matches_db: Math.abs(parseFloat(j.debitAmount) - out.amount) < 0.001
                };
            } catch (e) { out.cbe_live = { error: e.message }; }
        }
        return res.json(out);
    } catch (e) { console.error(e); return res.status(500).json({ status: 'Database_Error' }); }
});

app.get('/api/recent', async (req, res) => {
    const actor = await authOwnerOrAgent(req, res, true);
    if (!actor) return;
    const n = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    const filterAgent = actor.agent ? 'WHERE t.agent_id = $2' : '';
    const args = actor.agent ? [n, actor.agent.id] : [n];

    try {
        const baseCols = 't.id, t.tx_type, t.amount, t.ref_no, t.sender_name, t.recipient_account, t.status, t.category, t.balance, t.claimed_by, t.claimed_txn_id, t.claimed_at, t.agent_id, t.created_at, a.name AS agent_name';
        const [c, tb] = await Promise.all([
            pool.query(`SELECT ${baseCols}, t.v2_code, t.resolve_attempts FROM cbe_transactions t LEFT JOIN agents a ON a.id = t.agent_id ${filterAgent} ORDER BY t.id DESC LIMIT $1`, args),
            pool.query(`SELECT ${baseCols} FROM telebirr_transactions t LEFT JOIN agents a ON a.id = t.agent_id ${filterAgent} ORDER BY t.id DESC LIMIT $1`, args)
        ]);

        const mapRow = (bank) => (row) => ({
            id: row.id,
            bank,
            tx_type: row.tx_type,
            type: row.tx_type,
            amount: parseFloat(row.amount),
            ref_no: row.ref_no,
            ref: row.ref_no || row.v2_code || null,
            sender_name: row.sender_name,
            party: row.sender_name,
            recipient_account: row.recipient_account || null,
            status: row.status,
            usage: row.status,
            category: row.category || null,
            balance: row.balance != null ? parseFloat(row.balance) : null,
            v2_code: row.v2_code || null,
            claimed_by: row.claimed_by || null,
            claimed_txn_id: row.claimed_txn_id || null,
            claimed_at: row.claimed_at || null,
            agent_id: row.agent_id || null,
            agent: row.agent_name || (row.agent_id ? 'Agent #' + row.agent_id : 'Owner'),
            created_at: row.created_at
        });

        const cbeRows = c.rows.map(mapRow('CBE'));
        const tbRows = tb.rows.map(mapRow('Telebirr'));
        const items = [...cbeRows, ...tbRows]
            .sort((a, b) => new Date(b.created_at) - new Date(a.created_at) || b.id - a.id)
            .slice(0, n);

        return res.json({
            status: 'OK',
            role: actor.role,
            agent: actor.agent ? actor.agent.name : 'Owner',
            agent_id: actor.agent ? actor.agent.id : null,
            items,
            cbe: cbeRows,
            telebirr: tbRows
        });
    } catch (e) { console.error(e); return res.status(500).json({ status: 'Database_Error' }); }
});

// ================= 6. AGENT MANAGEMENT (SECRET_TOKEN or VERIFY_TOKEN) =================
app.get('/api/admin/agents', async (req, res) => {
    if (!authVerify(req, res)) return;
    try {
        const rows = await getAgents(true);
        return res.json({ status: 'OK', agents: rows });
    } catch (e) { console.error(e); return res.status(500).json({ status: 'Database_Error' }); }
});

async function handleCreateAgent(req, res) {
    if (!authVerify(req, res)) return;
    const name = String(param(req, 'name') || '').trim().slice(0, 80);
    if (!name) return res.status(400).json({ status: 'Missing_Name' });
    const token = String(param(req, 'new_token') || param(req, 'agent_token') || ('ag_' + crypto.randomBytes(16).toString('hex'))).trim();
    const matchText = String(param(req, 'match_text') || param(req, 'matchText') || '').trim() || null;
    const phone = String(param(req, 'phone') || '').trim() || null;
    const cbeAccount = String(param(req, 'cbe_account') || param(req, 'cbeAccount') || '').trim() || null;
    const notes = String(param(req, 'notes') || '').trim() || null;

    try {
        const r = await pool.query(
            `INSERT INTO agents (name, token, match_text, phone, cbe_account, notes, active)
             VALUES ($1,$2,$3,$4,$5,$6,TRUE)
             RETURNING id, name, token, match_text, phone, cbe_account, notes, active, created_at`,
            [name, token, matchText, phone, cbeAccount, notes]
        );
        invalidateAgentCache();
        return res.json({ status: 'OK', agent: r.rows[0] });
    } catch (e) {
        if (e.code === '23505') return res.status(409).json({ status: 'Duplicate_Token_Or_Name' });
        console.error(e);
        return res.status(500).json({ status: 'Database_Error' });
    }
}
app.post('/api/admin/agents', handleCreateAgent);
app.get('/api/admin/agents/create', handleCreateAgent);
app.post('/api/admin/agents/create', handleCreateAgent);

async function handleToggleAgent(req, res) {
    if (!authVerify(req, res)) return;
    const id = parseInt(param(req, 'id'), 10);
    if (isNaN(id)) return res.status(400).json({ status: 'Missing_Agent_Id' });
    const explicit = param(req, 'active');
    try {
        const r = explicit !== undefined
            ? await pool.query('UPDATE agents SET active = $2 WHERE id = $1 RETURNING id, name, active', [id, String(explicit) === 'true' || explicit === true])
            : await pool.query('UPDATE agents SET active = NOT active WHERE id = $1 RETURNING id, name, active', [id]);
        if (!r.rows.length) return res.status(404).json({ status: 'Not_Found' });
        invalidateAgentCache();
        return res.json({ status: 'OK', agent: r.rows[0] });
    } catch (e) { console.error(e); return res.status(500).json({ status: 'Database_Error' }); }
}
app.get('/api/admin/agents/toggle', handleToggleAgent);
app.post('/api/admin/agents/toggle', handleToggleAgent);

async function handleRotateAgentToken(req, res) {
    if (!authVerify(req, res)) return;
    const id = parseInt(param(req, 'id'), 10);
    if (isNaN(id)) return res.status(400).json({ status: 'Missing_Agent_Id' });
    const newToken = String(param(req, 'new_token') || param(req, 'agent_token') || ('ag_' + crypto.randomBytes(16).toString('hex'))).trim();
    try {
        const r = await pool.query('UPDATE agents SET token = $2 WHERE id = $1 RETURNING id, name, token, active', [id, newToken]);
        if (!r.rows.length) return res.status(404).json({ status: 'Not_Found' });
        invalidateAgentCache();
        return res.json({ status: 'OK', agent: r.rows[0] });
    } catch (e) { console.error(e); return res.status(500).json({ status: 'Database_Error' }); }
}
app.get('/api/admin/agents/rotate-token', handleRotateAgentToken);
app.post('/api/admin/agents/rotate-token', handleRotateAgentToken);

async function handleUpdateAgent(req, res) {
    if (!authVerify(req, res)) return;
    const id = parseInt(param(req, 'id'), 10);
    if (isNaN(id)) return res.status(400).json({ status: 'Missing_Agent_Id' });
    try {
        const r = await pool.query(
            `UPDATE agents
             SET name = COALESCE(NULLIF($2, ''), name),
                 match_text = COALESCE($3, match_text),
                 phone = COALESCE($4, phone),
                 cbe_account = COALESCE($5, cbe_account),
                 notes = COALESCE($6, notes)
             WHERE id = $1
             RETURNING id, name, token, match_text, phone, cbe_account, notes, active`,
            [
                id,
                param(req, 'name') || '',
                param(req, 'match_text') ?? param(req, 'matchText') ?? null,
                param(req, 'phone') ?? null,
                param(req, 'cbe_account') ?? param(req, 'cbeAccount') ?? null,
                param(req, 'notes') ?? null
            ]
        );
        if (!r.rows.length) return res.status(404).json({ status: 'Not_Found' });
        invalidateAgentCache();
        return res.json({ status: 'OK', agent: r.rows[0] });
    } catch (e) { console.error(e); return res.status(500).json({ status: 'Database_Error' }); }
}
app.get('/api/admin/agents/update', handleUpdateAgent);
app.post('/api/admin/agents/update', handleUpdateAgent);

// ================= 7. AGENT REPORTS (Owner SECRET_TOKEN or VERIFY_TOKEN) =================
app.get('/api/agents', async (req, res) => {
    if (!authVerify(req, res)) return;
    try {
        const r = await pool.query(
            `SELECT a.id, a.name, a.phone, a.cbe_account, a.active,
                    COALESCE(SUM(t.amount) FILTER (WHERE t.tx_type = 'Received'), 0) AS total_in,
                    COUNT(t.tx_id) FILTER (WHERE t.tx_type = 'Received') AS count_in,
                    COALESCE(SUM(t.amount) FILTER (WHERE t.tx_type = 'Received' AND (t.created_at AT TIME ZONE 'Africa/Addis_Ababa')::date = (NOW() AT TIME ZONE 'Africa/Addis_Ababa')::date), 0) AS today_in,
                    COALESCE(SUM(t.amount) FILTER (WHERE t.tx_type = 'Transferred'), 0) AS total_out,
                    COUNT(t.tx_id) FILTER (WHERE t.tx_type = 'Transferred') AS count_out,
                    COALESCE(SUM(t.amount) FILTER (WHERE t.tx_type = 'Transferred' AND t.status = 'Payout_Verified'), 0) AS verified_out,
                    COALESCE(SUM(t.amount) FILTER (WHERE t.tx_type = 'Transferred' AND (t.created_at AT TIME ZONE 'Africa/Addis_Ababa')::date = (NOW() AT TIME ZONE 'Africa/Addis_Ababa')::date), 0) AS today_out
             FROM agents a LEFT JOIN agent_transactions t ON t.agent_id = a.id
             GROUP BY a.id ORDER BY a.id`
        );
        return res.json({ status: 'OK', agents: r.rows });
    } catch (e) { console.error(e); return res.status(500).json({ status: 'Database_Error' }); }
});

app.get('/api/agent/deposits', async (req, res) => {
    if (!authVerify(req, res)) return;
    const id = parseInt(req.query.agent, 10);
    if (isNaN(id)) return res.json({ status: 'Missing_Agent' });
    const n = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 500);
    const from = req.query.from || '1970-01-01';
    const to = req.query.to || '2999-12-31';
    try {
        const r = await pool.query(
            `SELECT bank, tx_id, amount, ref_no, sender_name, balance, status, claimed_by, claimed_txn_id, created_at
             FROM agent_deposits
             WHERE agent_id = $1
               AND (created_at AT TIME ZONE 'Africa/Addis_Ababa')::date BETWEEN $2::date AND $3::date
             ORDER BY created_at DESC LIMIT $4`,
            [id, from, to, n]
        );
        const total = r.rows.reduce((s, x) => s + parseFloat(x.amount), 0);
        return res.json({ status: 'OK', agent: id, count: r.rows.length, total, items: r.rows });
    } catch (e) { console.error(e); return res.status(500).json({ status: 'Database_Error' }); }
});

app.get('/api/agent/transactions', async (req, res) => {
    if (!authVerify(req, res)) return;
    const id = parseInt(req.query.agent, 10);
    if (isNaN(id)) return res.json({ status: 'Missing_Agent' });
    const n = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
    const from = req.query.from || '1970-01-01';
    const to = req.query.to || '2999-12-31';
    try {
        const r = await pool.query(
            `SELECT bank, tx_id, tx_type, amount, ref_no, sender_name, recipient_account, balance, status, claimed_by, claimed_txn_id, created_at
             FROM agent_transactions
             WHERE agent_id = $1
               AND (created_at AT TIME ZONE 'Africa/Addis_Ababa')::date BETWEEN $2::date AND $3::date
             ORDER BY created_at DESC LIMIT $4`,
            [id, from, to, n]
        );
        return res.json({ status: 'OK', agent: id, count: r.rows.length, items: r.rows });
    } catch (e) { console.error(e); return res.status(500).json({ status: 'Database_Error' }); }
});

// health check: never touches the database
app.get('/', (req, res) => res.json({ status: 'ok', service: 'HuluBet Verify Gateway' }));

if (require.main === module) {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
        console.log(`Unified Gateway running on port ${PORT}`);
        scheduleResolve(5000);
    });
}
module.exports = {
    classify, extractAmount, extractBalance, extractTelebirrRef, extractParty,
    extractRecipientAccount, accountsMatch, normalizePhoneCore,
    detectCategory, extractV2Code, extractDirectFt, parseVerifyInput
};
