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
const RETENTION_DAYS = Math.max(parseInt(process.env.RETENTION_DAYS || '30', 10) || 30, 7);

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors());

// Small pool + short idle timeout so DB connections are never exhausted
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 4,
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
const NON_HULUBET_CATEGORIES = ['ATM/Card', 'Airtime', 'Data', 'Bill'];

// ================= PARSING HELPERS =================
const AM_IN = /ተቀብለዋል|ገቢ ሆኗል/;
const AM_OUT = /ከፍለዋል|ልከዋል|አስተላልፈዋል|ገዝተዋል|ተላልፏል|ወጪ ሆኗል/;
const NUM = '([0-9,]+(?:\\.[0-9]{1,2})?)';

function stripBalanceAndFees(msg) {
    return msg
        .replace(/(?:ቀሪ\s*ሂሳብ|current\s*(?:account\s*)?balance|balance(?:\s*is)?)[^0-9]{0,20}[0-9,]+(?:\.[0-9]{1,2})?\s*(?:ብር|ETB|Birr)?/ig, ' ')
        .replace(/(?:service\s*(?:fee|charge)|vat\s*\(?\d*%?\)?|disaster\s*recovery\s*\(?\d*%?\)?)[^0-9]{0,25}[0-9,]+(?:\.[0-9]{1,2})?\s*(?:ብር|ETB|Birr)?/ig, ' ');
}

function extractAmount(msg) {
    if (!msg) return 0;
    const m = stripBalanceAndFees(msg);
    const match = m.match(new RegExp('(?:received|transferred|withdraw(?:n)?|paid|credited|debited)\\s+(?:ETB|Birr)\\s*' + NUM, 'i'))
        || m.match(new RegExp('(?:received|transferred|withdraw(?:n)?|paid|credited|debited)\\s+' + NUM + '\\s*(?:ETB|Birr)', 'i'))
        || m.match(new RegExp('(?:ETB|Birr)\\s*' + NUM, 'i'))
        || m.match(new RegExp(NUM + '\\s*ብር'));
    return match ? parseFloat(match[1].replace(/,/g, '')) : 0;
}

function extractBalance(msg) {
    const m = msg.match(/(?:ቀሪ\s*ሂሳብ|current\s*(?:account\s*)?balance|balance(?:\s*is)?)[^0-9]{0,15}([0-9,]+(?:\.[0-9]{1,2})?)/i);
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

function extractRecipientAccount(msg, isCbe) {
    if (isCbe) {
        const m = msg.match(/to\s+account\s+([0-9*]{4,20})/i) || msg.match(/account\s+([0-9*]{4,20})/i);
        return m ? m[1].trim() : null;
    }
    const tb = msg.match(/\(([0-9*+]{6,16})\)/);
    return tb ? tb[1].trim() : null;
}

function extractParty(msg, isIncoming, bank) {
    if (bank === 'CBE') {
        for (const g of msg.matchAll(/\(([^)]+)\)/g)) {
            if (/[A-Za-z]{3,}/.test(g[1]) && !/%/.test(g[1])) return g[1].trim().slice(0, 100);
        }
        const f = isIncoming ? msg.match(/from\s+([A-Za-z0-9\s*]+)/i) : msg.match(/to\s+([A-Za-z0-9\s*]+)/i);
        return f ? f[1].trim().slice(0, 100) : 'CBE Client';
    }
    if (/withdraw/i.test(msg) && /ATM/i.test(msg)) {
        const atm = msg.match(/using\s+(.+?\s+ATM)\b/i);
        return atm ? atm[1].trim().slice(0, 100) : 'Telebirr ATM';
    }
    if (AM_IN.test(msg) || AM_OUT.test(msg)) {
        const m = isIncoming ? msg.match(/ከ\s+(.+?)\s*\(/) : msg.match(/ለ\s+(\S+)/);
        return m ? m[1].trim().slice(0, 100) : 'Telebirr Client';
    }
    const m = isIncoming ? msg.match(/from\s+([^(]+)\(/i) : msg.match(/to\s+([^(]+)\(/i);
    return m ? m[1].trim().slice(0, 100) : 'Telebirr Client';
}

function detectCategory(msg, isIncoming) {
    if (isIncoming) return 'Received';
    if (/\bATM\b|withdraw\s+ETB|has been debited with ETB\s*[0-9,.]+\s*including Service charge/i.test(msg) && !/to account/i.test(msg)) {
        return 'ATM/Card';
    }
    if (/አየር\s*ሰዓት|የአየር|airtime|recharge|top\s*up/i.test(msg)) return 'Airtime';
    if (/ኢንተርኔት|ዳታ|ጥቅል|data|package|bundle/i.test(msg)) return 'Data';
    if (/ethio\s*telecom\s*bill|electric|water\s*bill|utility|dstv|ticket|tax/i.test(msg)) return 'Bill';
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
    const outEn = isCbe
        ? /you have (?:successfully )?transferred|has been debited|a debit transaction/i
        : /you have (?:successfully )?transferred|you have paid|request to withdraw\s+ETB/i;
    const inEn = isCbe
        ? /you have received|has been credited|a credit transaction/i
        : /you have received/i;
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
    const v2 = text.match(/\b(v2-[A-Za-z0-9_-]{6,})/i);
    if (v2) return { type: 'v2', value: normV2(v2[1]), amount };
    const rc = text.match(/receipt\/([A-Z0-9]{8,14})\b/i);
    const tb = rc ? rc[1].toUpperCase() : extractTelebirrRef(text) || (/^[A-Za-z0-9]{8,14}$/.test(text) ? text.toUpperCase() : null);
    return tb ? { type: 'tb', value: tb, amount } : null;
}

// ================= FUZZY NAME MATCHER (1-2 TYPOS + FIRST/FULL NAME) =================
function normalizeNameTokens(name) {
    const cleaned = String(name || '')
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\b(?:ato|wro|mr|mrs|ms|dr|eng)\b/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    return cleaned ? cleaned.split(' ').filter(t => t.length >= 2) : [];
}

function levenshtein(a, b) {
    if (a === b) return 0;
    const m = a.length, n = b.length;
    if (m === 0) return n;
    if (n === 0) return m;
    const dp = Array.from({ length: n + 1 }, (_, j) => j);
    for (let i = 1; i <= m; i++) {
        let prev = dp[0];
        dp[0] = i;
        for (let j = 1; j <= n; j++) {
            const tmp = dp[j];
            if (a[i - 1] === b[j - 1]) dp[j] = prev;
            else dp[j] = 1 + Math.min(prev, dp[j], dp[j - 1]);
            prev = tmp;
        }
    }
    return dp[n];
}

function tokenSimilarity(a, b) {
    if (a === b) return { ok: true, score: 1.0 };
    if (a.length >= 3 && b.startsWith(a)) return { ok: true, score: 0.92 };
    if (b.length >= 3 && a.startsWith(b)) return { ok: true, score: 0.90 };
    const maxLen = Math.max(a.length, b.length);
    const maxAllowedDist = maxLen <= 4 ? 1 : 2;
    const dist = levenshtein(a, b);
    if (dist <= maxAllowedDist) {
        return { ok: true, score: Math.max(0.65, 1 - dist / (maxLen + 1)) };
    }
    return { ok: false, score: 0 };
}

function scoreNameMatch(requestedName, candidateParty) {
    const reqTokens = normalizeNameTokens(requestedName);
    const candTokens = normalizeNameTokens(candidateParty);
    if (!reqTokens.length || !candTokens.length) return { matched: false, score: 0 };

    const reqJoin = reqTokens.join('');
    const candJoin = candTokens.join('');
    if (reqJoin === candJoin) return { matched: true, score: 1.0 };
    if (reqJoin.length >= 6 && candJoin.startsWith(reqJoin)) return { matched: true, score: 0.95 };

    let totalScore = 0;
    let matchedCount = 0;
    for (let i = 0; i < reqTokens.length; i++) {
        const rt = reqTokens[i];
        let best = 0;
        for (let j = 0; j < candTokens.length; j++) {
            const sim = tokenSimilarity(rt, candTokens[j]);
            if (sim.ok) {
                const posBonus = (i === 0 && j === 0) ? 0.08 : 0;
                best = Math.max(best, sim.score + posBonus);
            }
        }
        if (best > 0) {
            matchedCount++;
            totalScore += best;
        }
    }

    const firstMatched = candTokens.some(ct => tokenSimilarity(reqTokens[0], ct).ok);
    const requiredMatches = reqTokens.length <= 2 ? reqTokens.length : Math.ceil(reqTokens.length * 0.75);
    if (!firstMatched || matchedCount < requiredMatches) {
        return { matched: false, score: 0 };
    }
    return { matched: true, score: totalScore / reqTokens.length };
}

// ================= IN-MEMORY CACHES (MINIMIZE DB CALLS) =================
const AGENT_TTL = 120000;
let agentCache = { list: null, at: 0 };
async function getAgents(force = false) {
    if (!force && agentCache.list && Date.now() - agentCache.at < AGENT_TTL) return agentCache.list;
    const r = await pool.query('SELECT id, name, token, match_text, active FROM agents WHERE active = TRUE ORDER BY id');
    agentCache = { list: r.rows, at: Date.now() };
    return agentCache.list;
}
function invalidateAgentCache() { agentCache = { list: null, at: 0 }; }
async function findAgentByToken(tk) {
    if (!tk) return null;
    return (await getAgents()).find(a => a.token === tk) || null;
}
async function findAgentByMsg(msg) {
    return (await getAgents()).find(a => a.match_text && msg.includes(a.match_text)) || null;
}

const RECENT_TTL = 8000;
const recentCache = new Map();
function invalidateRecentCache() { recentCache.clear(); }

// ================= SCHEMA BOOTSTRAP (RUNS ONCE ON STARTUP) =================
let schemaReady = false;
async function ensureSchema() {
    if (schemaReady) return;
    await pool.query(`
        CREATE TABLE IF NOT EXISTS agents (
            id SERIAL PRIMARY KEY,
            name TEXT NOT NULL,
            token TEXT UNIQUE NOT NULL,
            match_text TEXT,
            active BOOLEAN NOT NULL DEFAULT TRUE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        ALTER TABLE cbe_transactions ADD COLUMN IF NOT EXISTS agent_id INTEGER;
        ALTER TABLE cbe_transactions ADD COLUMN IF NOT EXISTS recipient_account TEXT;
        ALTER TABLE cbe_transactions ADD COLUMN IF NOT EXISTS claimed_by TEXT;
        ALTER TABLE cbe_transactions ADD COLUMN IF NOT EXISTS claimed_txn_id TEXT;
        ALTER TABLE cbe_transactions ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

        ALTER TABLE telebirr_transactions ADD COLUMN IF NOT EXISTS agent_id INTEGER;
        ALTER TABLE telebirr_transactions ADD COLUMN IF NOT EXISTS recipient_account TEXT;
        ALTER TABLE telebirr_transactions ADD COLUMN IF NOT EXISTS claimed_by TEXT;
        ALTER TABLE telebirr_transactions ADD COLUMN IF NOT EXISTS claimed_txn_id TEXT;
        ALTER TABLE telebirr_transactions ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

        CREATE TABLE IF NOT EXISTS agent_daily_audit (
            audit_date DATE NOT NULL,
            agent_id INTEGER NOT NULL DEFAULT 0,
            bank TEXT NOT NULL,
            total_in NUMERIC(14,2) NOT NULL DEFAULT 0,
            total_out NUMERIC(14,2) NOT NULL DEFAULT 0,
            atm_out NUMERIC(14,2) NOT NULL DEFAULT 0,
            airtime_bill_out NUMERIC(14,2) NOT NULL DEFAULT 0,
            tx_count INTEGER NOT NULL DEFAULT 0,
            last_balance NUMERIC(14,2),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (audit_date, agent_id, bank)
        );
        CREATE INDEX IF NOT EXISTS idx_cbe_payout_lookup ON cbe_transactions (status, tx_type, amount) WHERE status = 'Sent_Locked';
        CREATE INDEX IF NOT EXISTS idx_tb_payout_lookup ON telebirr_transactions (status, tx_type, amount) WHERE status = 'Sent_Locked';
    `);
    schemaReady = true;
}

// ================= RETENTION PRUNE WITH DAILY AUDIT ROLLUP =================
let lastAuditPruneAt = 0;
async function runAuditAndPrune(days = RETENTION_DAYS) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        for (const [bank, table] of [['CBE', 'cbe_transactions'], ['Telebirr', 'telebirr_transactions']]) {
            const del = await client.query(
                `DELETE FROM ${table}
                 WHERE created_at < NOW() - ($1 || ' days')::interval
                   AND status IN ('Used', 'Unused', 'Payout_Verified', 'Audit_Only')
                 RETURNING COALESCE(agent_id, 0) AS agent_id, tx_type, category, amount, balance, (created_at AT TIME ZONE 'Africa/Addis_Ababa')::date AS d`,
                [String(days)]
            );
            const buckets = new Map();
            for (const row of del.rows) {
                const k = `${row.d}|${row.agent_id}`;
                if (!buckets.has(k)) {
                    buckets.set(k, { d: row.d, agentId: row.agent_id, inAmt: 0, outAmt: 0, atmAmt: 0, billAmt: 0, count: 0, bal: null });
                }
                const b = buckets.get(k);
                const amt = parseFloat(row.amount || 0);
                b.count += 1;
                if (row.tx_type === 'Received') b.inAmt += amt;
                else {
                    b.outAmt += amt;
                    if (row.category === 'ATM/Card') b.atmAmt += amt;
                    else if (row.category === 'Airtime' || row.category === 'Data' || row.category === 'Bill') b.billAmt += amt;
                }
                if (row.balance !== null && row.balance !== undefined) b.bal = parseFloat(row.balance);
            }
            for (const b of buckets.values()) {
                await client.query(
                    `INSERT INTO agent_daily_audit (audit_date, agent_id, bank, total_in, total_out, atm_out, airtime_bill_out, tx_count, last_balance, updated_at)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
                     ON CONFLICT (audit_date, agent_id, bank) DO UPDATE SET
                       total_in = agent_daily_audit.total_in + EXCLUDED.total_in,
                       total_out = agent_daily_audit.total_out + EXCLUDED.total_out,
                       atm_out = agent_daily_audit.atm_out + EXCLUDED.atm_out,
                       airtime_bill_out = agent_daily_audit.airtime_bill_out + EXCLUDED.airtime_bill_out,
                       tx_count = agent_daily_audit.tx_count + EXCLUDED.tx_count,
                       last_balance = COALESCE(EXCLUDED.last_balance, agent_daily_audit.last_balance),
                       updated_at = NOW()`,
                    [b.d, b.agentId, bank, b.inAmt, b.outAmt, b.atmAmt, b.billAmt, b.count, b.bal]
                );
            }
        }
        await client.query('COMMIT');
        lastAuditPruneAt = Date.now();
    } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('audit/prune error:', e.message);
    } finally {
        client.release();
    }
}

function maybeScheduleDailyPrune() {
    if (Date.now() - lastAuditPruneAt > 24 * 60 * 60 * 1000) {
        lastAuditPruneAt = Date.now();
        setTimeout(() => runAuditAndPrune().catch(() => {}), 5000);
    }
}

// ================= CBE RECEIPT RESOLVER (ZERO IDLE DB POLLING) =================
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
            } catch (e) {}
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
        await pool.query('UPDATE cbe_transactions SET ref_no=$1 WHERE id=$2 AND ref_no IS NULL', [ft, id]);
        invalidateRecentCache();
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
    if (resolverBusy) return false;
    resolverBusy = true;
    try {
        const { rows } = await pool.query(
            `SELECT id, v2_code FROM cbe_transactions
             WHERE ref_no IS NULL AND v2_code IS NOT NULL AND resolve_attempts < 40
               AND COALESCE(category, 'Transfer') NOT IN ('ATM/Card', 'Airtime', 'Data', 'Bill')
             ORDER BY id LIMIT 10`);
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
        return false;
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

// ================= AUTH HELPERS =================
function readToken(req) {
    return req.query.token || req.body?.token || '';
}

function authAdmin(req, res) {
    if (readToken(req) !== SECRET_TOKEN) { res.status(401).json({ status: 'Unauthorized' }); return false; }
    return true;
}

function authVerify(req, res) {
    const t = readToken(req);
    if (t === SECRET_TOKEN || (VERIFY_TOKEN && t === VERIFY_TOKEN)) return true;
    res.status(401).json({ status: 'Unauthorized' });
    return false;
}

async function resolveRoleByToken(token) {
    if (!token) return null;
    if (token === SECRET_TOKEN || (VERIFY_TOKEN && token === VERIFY_TOKEN)) {
        return { isOwner: true, agentId: null, agentName: 'Owner' };
    }
    const agent = await findAgentByToken(token);
    if (agent) {
        return { isOwner: false, agentId: agent.id, agentName: agent.name };
    }
    return null;
}

// ================= 1. SMS WEBHOOK (GET OR POST) =================
async function handleWebhookSms(req, res) {
    const token = readToken(req);
    let agent = null;
    if (token !== SECRET_TOKEN && (!VERIFY_TOKEN || token !== VERIFY_TOKEN)) {
        try { agent = await findAgentByToken(token); }
        catch (e) { console.error(e); return res.status(500).json({ status: 'Database_Error' }); }
        if (!agent) return res.status(401).json({ status: 'Unauthorized' });
    }

    const message = req.query.message ?? req.body?.message;
    const sender = req.query.sender ?? req.body?.sender;
    if (!message) return res.status(400).json({ status: 'Error', message: 'No SMS provided' });

    const c = classify(message, sender);
    if (!c.isIncoming && !c.isOutgoing) {
        return res.json({ status: 'Ignored', reason: 'Not a payment SMS' });
    }

    if (!agent && c.isIncoming) {
        try { agent = await findAgentByMsg(c.msg); } catch (e) {}
    }
    const agentId = agent ? agent.id : null;
    const agentLabel = agent ? agent.name : 'Owner';

    const amount = extractAmount(c.msg);
    const balance = extractBalance(c.msg);
    const party = extractParty(c.msg, c.isIncoming, c.bank);
    const recipientAccount = extractRecipientAccount(c.msg, c.isCbe);
    const category = detectCategory(c.msg, c.isIncoming);
    const isHuluBetEligible = !NON_HULUBET_CATEGORIES.includes(category);

    let ref = null, v2 = null;
    if (c.isCbe) {
        ref = extractDirectFt(c.msg);
        v2 = extractV2Code(c.msg);
        if (!ref && v2 && isHuluBetEligible) ref = await resolveFtNumber(v2, 1);
        if (!ref && !v2) ref = 'CBE-' + crypto.createHash('sha1').update(c.msg).digest('hex').slice(0, 12).toUpperCase();
    } else {
        ref = extractTelebirrRef(c.msg);
        if (!ref) return res.json({ status: 'Ignored', reason: 'Missing Ref' });
    }
    if (!amount) return res.json({ status: 'Ignored', reason: 'Missing Amount' });

    const txType = c.isIncoming ? 'Received' : 'Transferred';
    // ATM/Airtime/Data/Bill are saved in DB for Agent cash/balance audit ('Audit_Only'),
    // NEVER exposed to HuluBet deposit/withdrawal verification APIs.
    const status = !isHuluBetEligible ? 'Audit_Only' : (c.isIncoming ? 'Unused' : 'Sent_Locked');

    try {
        let result;
        if (c.isCbe) {
            result = await pool.query(
                `INSERT INTO cbe_transactions (tx_type, sender_name, amount, ref_no, raw_sms, status, category, balance, v2_code, agent_id, recipient_account)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING RETURNING id`,
                [txType, party, amount, ref, c.msg, status, category, balance, v2, agentId, recipientAccount]
            );
        } else {
            result = await pool.query(
                `INSERT INTO telebirr_transactions (tx_type, sender_name, amount, ref_no, raw_sms, status, category, balance, agent_id, recipient_account)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING RETURNING id`,
                [txType, party, amount, ref, c.msg, status, category, balance, agentId, recipientAccount]
            );
        }

        if (result.rows.length === 0) {
            return res.json({
                status: 'Duplicate', bank: c.bank, type: txType, category, ref: ref || v2,
                amount, balance, party, recipient_account: recipientAccount, agent: agentLabel
            });
        }

        invalidateRecentCache();
        maybeScheduleDailyPrune();

        if (c.isCbe && !ref && isHuluBetEligible) {
            scheduleResolve(3000);
            return res.json({
                status: 'Saved', bank: c.bank, type: txType, category, amount, balance,
                party, recipient_account: recipientAccount, agent: agentLabel,
                ref: null, resolving: true, v2
            });
        }
        return res.json({
            status: 'Saved', bank: c.bank, type: txType, category, ref, amount,
            balance, party, recipient_account: recipientAccount, agent: agentLabel
        });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ status: 'Database_Error' });
    }
}
app.get('/webhook/sms', handleWebhookSms);
app.post('/webhook/sms', handleWebhookSms);

// ================= 2. DEPOSIT VERIFICATION (/api/verify) =================
async function tryUseDeposit(table, col, val, amount, claimedBy) {
    const r = await pool.query(
        `UPDATE ${table}
         SET status='Used', claimed_by=COALESCE($3, claimed_by)
         WHERE ${col}=$1 AND tx_type='Received' AND status='Unused'
           AND COALESCE(category, 'Received') NOT IN ('ATM/Card', 'Airtime', 'Data', 'Bill')
           AND ref_no IS NOT NULL AND ABS(amount-$2) < 0.01
         RETURNING amount, ref_no, sender_name, agent_id`,
        [val, amount, claimedBy || null]
    );
    return r.rows[0] || null;
}

async function whyDepositNotMatched(table, col, val, bank, expected) {
    const r = await pool.query(`SELECT tx_type, ref_no, status, amount, category FROM ${table} WHERE ${col}=$1`, [val]);
    if (!r.rows.length) return { status: 'Pending', bank };
    const tx = r.rows[0];
    if (NON_HULUBET_CATEGORIES.includes(tx.category) || tx.tx_type !== 'Received') {
        return { status: 'Invalid_Transaction_Type', bank };
    }
    if (!tx.ref_no) return { status: 'Resolving', bank };
    if (tx.status !== 'Unused') return { status: 'AlreadyUsed', bank };
    return { status: 'InvalidAmount', expected, actual: parseFloat(tx.amount), bank };
}

app.get('/api/verify', async (req, res) => {
    if (!authVerify(req, res)) return;
    const inp = parseVerifyInput(req.query.ref, req.query.sms || req.query.text);
    if (!inp) return res.json({ status: 'Missing_Ref' });
    let expected = parseFloat(req.query.amount);
    if (isNaN(expected) && inp.amount) expected = inp.amount;
    if (isNaN(expected) || expected <= 0) return res.json({ status: 'Missing_Amount' });

    const claimedBy = (req.query.username || req.query.claimed_by || '').toString().trim() || null;
    const isTb = inp.type === 'tb';
    const table = isTb ? 'telebirr_transactions' : 'cbe_transactions';
    const bank = isTb ? 'Telebirr' : 'CBE';
    let col = (inp.type === 'v2') ? 'v2_code' : 'ref_no';
    let val = inp.value;

    const done = async (tx) => {
        invalidateRecentCache();
        let agentName = 'Owner';
        if (tx.agent_id) {
            const ag = (await getAgents().catch(() => [])).find(a => a.id === tx.agent_id);
            if (ag) agentName = ag.name;
        }
        return res.json({
            status: 'Verified', bank, amount: parseFloat(tx.amount),
            ref_no: tx.ref_no, from_to: tx.sender_name, agent: agentName, agent_id: tx.agent_id || null
        });
    };

    try {
        let tx = await tryUseDeposit(table, col, val, expected, claimedBy);
        if (tx) return await done(tx);

        if (inp.type === 'v2') {
            const r = await pool.query('SELECT id, ref_no FROM cbe_transactions WHERE v2_code=$1', [val]);
            if (!r.rows.length || !r.rows[0].ref_no) {
                const ft = await resolveFtNumber(val, 1);
                if (ft) {
                    if (r.rows.length) await settleFt(r.rows[0].id, ft).catch(() => {});
                    col = 'ref_no'; val = ft;
                    tx = await tryUseDeposit(table, col, val, expected, claimedBy);
                    if (tx) return await done(tx);
                }
            }
        }
        return res.json(await whyDepositNotMatched(table, col, val, bank, expected));
    } catch (err) {
        console.error(err);
        return res.status(500).json({ status: 'System_Busy' });
    }
});

// ================= 3. WITHDRAWAL VERIFICATION (REF OR FUZZY NAME + AMOUNT) =================
async function handleVerifyWithdrawal(req, res, lockMatch) {
    if (!authVerify(req, res)) return;

    const refRaw = (req.query.ref || req.body?.ref || '').toString().trim();
    const customerName = (req.query.name || req.query.customer_name || req.query.full_name || req.query.recipient_name || req.body?.name || req.body?.customer_name || '').toString().trim();
    const withdrawalId = (req.query.withdrawal_id || req.query.txn_id || req.body?.withdrawal_id || req.body?.txn_id || '').toString().trim() || null;
    const bankFilter = (req.query.bank || req.body?.bank || '').toString().trim().toLowerCase();
    const expected = parseFloat(req.query.amount ?? req.body?.amount);
    const hours = Math.min(Math.max(parseInt(req.query.hours || req.body?.hours || '72', 10) || 72, 1), 720);
    const agentIdFilter = req.query.agent_id ? parseInt(req.query.agent_id, 10) : null;

    if (!refRaw && (!customerName || isNaN(expected) || expected <= 0)) {
        return res.json({ status: 'Missing_Params', message: 'Provide ref OR (name + amount)' });
    }

    const agents = await getAgents().catch(() => []);
    const agentNameFor = (aid) => {
        if (!aid) return 'Owner';
        const ag = agents.find(a => a.id === aid);
        return ag ? ag.name : `Agent ${aid}`;
    };

    try {
        if (withdrawalId) {
            for (const [bName, tbl] of [['CBE', 'cbe_transactions'], ['Telebirr', 'telebirr_transactions']]) {
                const prev = await pool.query(
                    `SELECT id, amount, ref_no, sender_name, agent_id, claimed_txn_id FROM ${tbl} WHERE claimed_txn_id=$1 AND status='Payout_Verified' LIMIT 1`,
                    [withdrawalId]
                );
                if (prev.rows.length) {
                    const p = prev.rows[0];
                    return res.json({
                        status: 'Payout_Verified', already_verified: true, bank: bName,
                        amount: parseFloat(p.amount), ref_no: p.ref_no, party: p.sender_name,
                        agent: agentNameFor(p.agent_id), claimed_txn_id: p.claimed_txn_id
                    });
                }
            }
        }

        if (refRaw) {
            const inp = parseVerifyInput(refRaw, null);
            if (!inp) return res.json({ status: 'Missing_Ref' });
            const isTb = inp.type === 'tb';
            const table = isTb ? 'telebirr_transactions' : 'cbe_transactions';
            const bank = isTb ? 'Telebirr' : 'CBE';
            const col = inp.type === 'v2' ? 'v2_code' : 'ref_no';

            const found = await pool.query(
                `SELECT id, tx_type, status, category, amount, ref_no, sender_name, agent_id, claimed_txn_id FROM ${table} WHERE ${col}=$1 LIMIT 1`,
                [inp.value]
            );
            if (!found.rows.length) return res.json({ status: 'Not_Found', bank });
            const row = found.rows[0];
            if (NON_HULUBET_CATEGORIES.includes(row.category) || row.tx_type !== 'Transferred') {
                return res.json({ status: 'Invalid_Transaction_Type', bank });
            }
            if (!isNaN(expected) && expected > 0 && Math.abs(parseFloat(row.amount) - expected) >= 0.01) {
                return res.json({ status: 'InvalidAmount', expected, actual: parseFloat(row.amount), bank });
            }
            if (row.status === 'Payout_Verified') {
                return res.json({ status: 'AlreadyVerified', bank, ref_no: row.ref_no, claimed_txn_id: row.claimed_txn_id });
            }
            if (row.status !== 'Sent_Locked') {
                return res.json({ status: 'Invalid_Status', actual_status: row.status, bank });
            }
            if (!lockMatch) {
                return res.json({
                    status: 'Match_Found', bank, amount: parseFloat(row.amount),
                    ref_no: row.ref_no, party: row.sender_name, agent: agentNameFor(row.agent_id), match_score: 1.0
                });
            }
            const upd = await pool.query(
                `UPDATE ${table} SET status='Payout_Verified', claimed_txn_id=COALESCE($2, claimed_txn_id), claimed_by=COALESCE($3, claimed_by)
                 WHERE id=$1 AND status='Sent_Locked' RETURNING amount, ref_no, sender_name, agent_id, claimed_txn_id`,
                [row.id, withdrawalId, customerName || null]
            );
            if (!upd.rows.length) return res.json({ status: 'AlreadyVerified', bank });
            invalidateRecentCache();
            const u = upd.rows[0];
            return res.json({
                status: 'Payout_Verified', bank, amount: parseFloat(u.amount),
                ref_no: u.ref_no, party: u.sender_name, agent: agentNameFor(u.agent_id),
                claimed_txn_id: u.claimed_txn_id, match_score: 1.0
            });
        }

        const tables = bankFilter === 'cbe'
            ? [['CBE', 'cbe_transactions']]
            : bankFilter === 'telebirr'
                ? [['Telebirr', 'telebirr_transactions']]
                : [['CBE', 'cbe_transactions'], ['Telebirr', 'telebirr_transactions']];

        const candidates = [];
        for (const [bName, tbl] of tables) {
            const q = await pool.query(
                `SELECT id, amount, ref_no, sender_name, agent_id, created_at
                 FROM ${tbl}
                 WHERE status = 'Sent_Locked'
                   AND tx_type = 'Transferred'
                   AND COALESCE(category, 'Transfer') NOT IN ('ATM/Card', 'Airtime', 'Data', 'Bill')
                   AND ABS(amount - $1) < 0.01
                   AND created_at >= NOW() - ($2 || ' hours')::interval
                   ${agentIdFilter !== null && !isNaN(agentIdFilter) ? 'AND agent_id = $3' : ''}
                 ORDER BY id DESC LIMIT 25`,
                agentIdFilter !== null && !isNaN(agentIdFilter) ? [expected, String(hours), agentIdFilter] : [expected, String(hours)]
            );
            for (const r of q.rows) {
                const m = scoreNameMatch(customerName, r.sender_name);
                if (m.matched) {
                    candidates.push({ table: tbl, bank: bName, row: r, score: m.score });
                }
            }
        }

        if (!candidates.length) {
            return res.json({ status: 'Not_Found', amount: expected, looked_for_name: customerName });
        }

        candidates.sort((a, b) => b.score - a.score || a.row.id - b.row.id);
        const best = candidates[0];

        if (!lockMatch) {
            return res.json({
                status: 'Match_Found', bank: best.bank, amount: parseFloat(best.row.amount),
                ref_no: best.row.ref_no, party: best.row.sender_name,
                agent: agentNameFor(best.row.agent_id), match_score: Number(best.score.toFixed(2)),
                candidates_count: candidates.length
            });
        }

        const upd = await pool.query(
            `UPDATE ${best.table}
             SET status='Payout_Verified', claimed_txn_id=COALESCE($2, claimed_txn_id), claimed_by=COALESCE($3, claimed_by)
             WHERE id=$1 AND status='Sent_Locked'
             RETURNING amount, ref_no, sender_name, agent_id, claimed_txn_id`,
            [best.row.id, withdrawalId, customerName]
        );
        if (!upd.rows.length) {
            return res.json({ status: 'System_Busy', message: 'Matched payout was claimed concurrently; retry' });
        }
        invalidateRecentCache();
        const u = upd.rows[0];
        return res.json({
            status: 'Payout_Verified', bank: best.bank, amount: parseFloat(u.amount),
            ref_no: u.ref_no, party: u.sender_name, agent: agentNameFor(u.agent_id),
            claimed_txn_id: u.claimed_txn_id, match_score: Number(best.score.toFixed(2))
        });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ status: 'Database_Error' });
    }
}

app.get('/api/verify-withdrawal', (req, res) => handleVerifyWithdrawal(req, res, true));
app.post('/api/verify-withdrawal', (req, res) => handleVerifyWithdrawal(req, res, true));
app.get('/api/check-withdrawal', (req, res) => handleVerifyWithdrawal(req, res, false));

// ================= 4. RECENT & CHECK (OWNER SEES ALL, AGENT SEES OWN) =================
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
    const role = await resolveRoleByToken(readToken(req)).catch(() => null);
    if (!role) return res.status(401).json({ status: 'Unauthorized' });
    const inp = parseVerifyInput(req.query.ref, req.query.sms || req.query.text);
    if (!inp) return res.json({ status: 'Missing_Ref' });

    try {
        const t = await locate(inp);
        const r = await pool.query(
            role.isOwner
                ? `SELECT * FROM ${t.table} WHERE ${t.col} = $1 LIMIT 1`
                : `SELECT * FROM ${t.table} WHERE ${t.col} = $1 AND agent_id = $2 LIMIT 1`,
            role.isOwner ? [t.val] : [t.val, role.agentId]
        );
        if (!r.rows.length) return res.json({ status: 'Not_Found', bank: t.bank, looked_for: t.val });
        const x = r.rows[0];
        const agents = await getAgents().catch(() => []);
        const ag = x.agent_id ? agents.find(a => a.id === x.agent_id) : null;
        return res.json({
            status: x.ref_no ? 'Found' : 'Found_FT_Pending',
            bank: t.bank, type: x.tx_type, amount: parseFloat(x.amount),
            ref_no: x.ref_no, party: x.sender_name, usage: x.status, category: x.category || null,
            balance: x.balance != null ? parseFloat(x.balance) : null,
            v2_code: x.v2_code || null, created_at: x.created_at || null,
            agent_id: x.agent_id || null, agent: ag ? ag.name : 'Owner',
            claimed_by: x.claimed_by || null, claimed_txn_id: x.claimed_txn_id || null
        });
    } catch (e) { console.error(e); return res.status(500).json({ status: 'Database_Error' }); }
});

app.get('/api/recent', async (req, res) => {
    const role = await resolveRoleByToken(readToken(req)).catch(() => null);
    if (!role) return res.status(401).json({ status: 'Unauthorized' });

    const n = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 100);
    const cacheKey = `${role.isOwner ? 'owner' : role.agentId}:${n}`;
    const cached = recentCache.get(cacheKey);
    if (cached && Date.now() - cached.at < RECENT_TTL) {
        return res.json(cached.payload);
    }

    try {
        const agents = await getAgents().catch(() => []);
        const nameOf = (aid) => {
            if (!aid) return 'Owner';
            const found = agents.find(a => a.id === aid);
            return found ? found.name : `Agent ${aid}`;
        };
        const cols = 'id, tx_type, amount, ref_no, sender_name, status, category, balance, agent_id, claimed_by, claimed_txn_id, recipient_account, created_at';
        const whereSql = role.isOwner ? '' : 'WHERE agent_id = $2';
        const params = role.isOwner ? [n] : [n, role.agentId];
        const [c, t] = await Promise.all([
            pool.query(`SELECT ${cols}, v2_code, resolve_attempts FROM cbe_transactions ${whereSql} ORDER BY id DESC LIMIT $1`, params),
            pool.query(`SELECT ${cols} FROM telebirr_transactions ${whereSql} ORDER BY id DESC LIMIT $1`, params)
        ]);
        const cRows = c.rows.map(r => ({ ...r, bank: 'CBE', usage: r.status, agent: nameOf(r.agent_id) }));
        const tRows = t.rows.map(r => ({ ...r, bank: 'Telebirr', usage: r.status, agent: nameOf(r.agent_id) }));
        const payload = { status: 'OK', role: role.agentName, agent: role.agentName, cbe: cRows, telebirr: tRows };
        recentCache.set(cacheKey, { at: Date.now(), payload });
        return res.json(payload);
    } catch (e) { console.error(e); return res.status(500).json({ status: 'Database_Error' }); }
});

// ================= 5. ADMIN AGENTS, AUDIT REPORTS & CBE HELPERS =================
app.get('/api/admin/agents', async (req, res) => {
    if (!authAdmin(req, res)) return;
    try {
        const r = await pool.query('SELECT id, name, token, match_text, active, created_at FROM agents ORDER BY id');
        return res.json({ status: 'OK', agents: r.rows });
    } catch (e) { console.error(e); return res.status(500).json({ status: 'Database_Error' }); }
});

app.post('/api/admin/agents', async (req, res) => {
    if (!authAdmin(req, res)) return;
    const name = String(req.body?.name || req.query.name || '').trim();
    const matchText = String(req.body?.match_text || req.query.match_text || '').trim() || null;
    if (!name) return res.status(400).json({ status: 'Missing_Name' });
    const token = 'ag_' + crypto.randomBytes(18).toString('hex');
    try {
        const r = await pool.query(
            'INSERT INTO agents (name, token, match_text, active) VALUES ($1, $2, $3, TRUE) RETURNING id, name, token, match_text, active',
            [name, token, matchText]
        );
        invalidateAgentCache();
        return res.json({ status: 'OK', agent: r.rows[0] });
    } catch (e) { console.error(e); return res.status(500).json({ status: 'Database_Error' }); }
});

app.post('/api/admin/agents/toggle', async (req, res) => {
    if (!authAdmin(req, res)) return;
    const id = parseInt(req.body?.id || req.query.id, 10);
    if (isNaN(id)) return res.status(400).json({ status: 'Missing_Id' });
    try {
        const r = await pool.query('UPDATE agents SET active = NOT active WHERE id=$1 RETURNING id, name, active', [id]);
        invalidateAgentCache();
        return res.json({ status: 'OK', agent: r.rows[0] || null });
    } catch (e) { console.error(e); return res.status(500).json({ status: 'Database_Error' }); }
});

app.get('/api/admin/audit-prune', async (req, res) => {
    if (!authAdmin(req, res)) return;
    const days = Math.max(parseInt(req.query.days || String(RETENTION_DAYS), 10) || RETENTION_DAYS, 1);
    await runAuditAndPrune(days);
    return res.json({ status: 'OK', retention_days: days });
});

app.get('/api/admin/daily-audit', async (req, res) => {
    if (!authAdmin(req, res)) return;
    try {
        const r = await pool.query('SELECT * FROM agent_daily_audit ORDER BY audit_date DESC, agent_id LIMIT 200');
        return res.json({ status: 'OK', items: r.rows });
    } catch (e) { console.error(e); return res.status(500).json({ status: 'Database_Error' }); }
});

app.get('/api/agents', async (req, res) => {
    if (!authAdmin(req, res)) return;
    try {
        const r = await pool.query(
            `SELECT a.id, a.name, a.active,
                    COALESCE(SUM(d.amount),0) AS total_in,
                    COUNT(d.tx_id) AS count_in,
                    COALESCE(SUM(d.amount) FILTER (WHERE (d.created_at AT TIME ZONE 'Africa/Addis_Ababa')::date = (NOW() AT TIME ZONE 'Africa/Addis_Ababa')::date),0) AS today_in
             FROM agents a LEFT JOIN agent_deposits d ON d.agent_id = a.id
             GROUP BY a.id ORDER BY a.id`);
        return res.json({ status: 'OK', agents: r.rows });
    } catch (e) { console.error(e); return res.status(500).json({ status: 'Database_Error' }); }
});

app.get('/api/agent/deposits', async (req, res) => {
    if (!authAdmin(req, res)) return;
    const id = parseInt(req.query.agent);
    if (isNaN(id)) return res.json({ status: 'Missing_Agent' });
    const n = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 500);
    const from = req.query.from || '1970-01-01';
    const to = req.query.to || '2999-12-31';
    try {
        const r = await pool.query(
            `SELECT bank, tx_id, amount, ref_no, sender_name, balance, status, created_at
             FROM agent_deposits
             WHERE agent_id = $1
               AND (created_at AT TIME ZONE 'Africa/Addis_Ababa')::date BETWEEN $2::date AND $3::date
             ORDER BY created_at DESC LIMIT $4`, [id, from, to, n]);
        const total = r.rows.reduce((s, x) => s + parseFloat(x.amount), 0);
        return res.json({ status: 'OK', agent: id, count: r.rows.length, total, items: r.rows });
    } catch (e) { console.error(e); return res.status(500).json({ status: 'Database_Error' }); }
});

app.get('/api/cbe/resolve', async (req, res) => {
    if (!authAdmin(req, res)) return;
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
    if (!authAdmin(req, res)) return;
    try {
        const r = await pool.query(
            `SELECT id, v2_code, amount, sender_name, resolve_attempts AS attempts
             FROM cbe_transactions WHERE ref_no IS NULL AND COALESCE(category,'Transfer') NOT IN ('ATM/Card','Airtime','Data','Bill')
             ORDER BY id DESC LIMIT 50`);
        return res.json({ status: 'OK', count: r.rows.length, items: r.rows });
    } catch (e) { console.error(e); return res.status(500).json({ status: 'Database_Error' }); }
});

app.get('/api/cbe/debug', async (req, res) => {
    if (!authAdmin(req, res)) return;
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

// Health check: NEVER touches DB
app.get('/', (req, res) => res.json({ status: 'ok' }));

if (require.main === module) {
    const PORT = process.env.PORT || 3000;
    ensureSchema()
        .then(() => {
            app.listen(PORT, () => {
                console.log(`Unified Gateway running on port ${PORT}`);
                scheduleResolve(5000);
            });
        })
        .catch((err) => {
            console.error('Startup schema error:', err);
            process.exit(1);
        });
}

module.exports = {
    classify, extractAmount, extractBalance, extractTelebirrRef,
    extractParty, detectCategory, extractV2Code, extractDirectFt,
    parseVerifyInput, scoreNameMatch, levenshtein
};
