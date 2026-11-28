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
// how long /api/verify waits for a late SMS before answering "Pending" (seconds, 0 = off)
const VERIFY_WAIT = Math.min(Math.max(parseInt(process.env.VERIFY_WAIT_SECONDS || '5', 10) || 0, 0), 20);

const app = express();
app.disable('x-powered-by');
app.set('etag', false);
app.set('trust proxy', 1);
app.use(express.json({ limit: '20kb' }));
app.use(express.urlencoded({ extended: true, limit: '20kb' }));
app.use(cors());

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DB_SSL === 'off' ? false : { rejectUnauthorized: false },
    max: 3,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 10000,
    query_timeout: 10000
});
pool.on('error', (e) => console.error('pool error:', e.message));
process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e && e.message));
const inflight = new Map();   // identical concurrent verify requests share one DB run
// when the DB queue is long, answer fast so HuluBet retries later; the SMS webhook is never shed
app.use(['/api/verify', '/api/verify-withdrawal', '/api/withdrawal-request', '/api/check-withdrawal'],
    (req, res, next) => (pool.waitingCount > 8 ? res.status(503).json({ status: 'System_Busy' }) : next()));

const BANKS = [['CBE', 'cbe_transactions'], ['Telebirr', 'telebirr_transactions']];
const NON_HB = ['ATM/Card', 'Airtime', 'Data', 'Bill'];   // saved for agent audit only, never verified
const str = (v) => String(v ?? '').trim();
const clamp = (n, a, b) => Math.min(Math.max(n, a), b);
const bodyOf = (req) => (req.body && typeof req.body === 'object' ? req.body : {});

// ================= PARSING =================
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
    const x = m.match(new RegExp('(?:received|transferred|withdraw(?:n)?|paid|credited|debited)\\s+(?:ETB|Birr)\\s*' + NUM, 'i'))
        || m.match(new RegExp('(?:received|transferred|withdraw(?:n)?|paid|credited|debited)\\s+' + NUM + '\\s*(?:ETB|Birr)', 'i'))
        || m.match(new RegExp('(?:ETB|Birr)\\s*' + NUM, 'i'))
        || m.match(new RegExp(NUM + '\\s*ብር'));
    return x ? parseFloat(x[1].replace(/,/g, '')) : 0;
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
const normV2 = (c) => 'v2-' + String(c).replace(/^v2-/i, '');
function extractV2Code(msg) {
    const m = msg.match(/cbe\.com\.et\/(v2-[A-Za-z0-9_-]+)/i);
    return m ? normV2(m[1]) : null;
}
// receiver of an OUTGOING transfer only
function extractRecipientAccount(msg, isCbe) {
    if (isCbe) {
        const m = msg.match(/to\s+account\s+([0-9*]{4,20})/i) || msg.match(/account\s+([0-9*]{4,20})/i);
        return m ? m[1].trim() : null;
    }
    const tb = msg.match(/\(([0-9*+]{6,16})\)/);
    return tb ? tb[1].trim() : null;
}
const last4 = (s) => String(s || '').replace(/\D/g, '').slice(-4);

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
    if (/\bATM\b|withdraw\s+ETB|has been debited with ETB\s*[0-9,.]+\s*including Service charge/i.test(msg) && !/to account/i.test(msg)) return 'ATM/Card';
    if (/አየር\s*ሰዓት|የአየር|\bairtime\b|\brecharge\b|\btop\s*up\b/i.test(msg)) return 'Airtime';
    if (/ኢንተርኔት|ዳታ|ጥቅል|\bdata\b|\bpackage\b|\bbundle\b/i.test(msg)) return 'Data';
    if (/ethio\s*telecom\s*bill|\belectric|water\s*bill|\butility\b|\bdstv\b|\bticket\b|\btax\b/i.test(msg)) return 'Bill';
    if (/ከፍለዋል|\bpaid\b|\bpurchase\b/i.test(msg)) return 'Payment';
    return 'Transfer';
}

function classify(message, sender) {
    const msg = String(message || '').replace(/\r?\n/g, ' ').trim();
    const snd = String(sender || '');
    let isCbe;
    if (/^\s*127\s*$|telebirr/i.test(snd)) isCbe = false;
    else if (/cbe/i.test(snd)) isCbe = true;
    else isCbe = /cbe\.com\.et|\bFT[A-Z0-9]{8,15}\b|from account\s+[0-9*]+|banking with CBE/i.test(msg);
    const outEn = isCbe ? /you have (?:successfully )?transferred|has been debited|a debit transaction/i
        : /you have (?:successfully )?transferred|you have paid|request to withdraw\s+ETB/i;
    const inEn = isCbe ? /you have received|has been credited|a credit transaction/i : /you have received/i;
    const inPos = msg.search(inEn), outPos = msg.search(outEn);
    let isIncoming = inEn.test(msg) || (!isCbe && AM_IN.test(msg));
    let isOutgoing = outEn.test(msg) || (!isCbe && AM_OUT.test(msg));
    if (isIncoming && isOutgoing) {
        if (outPos >= 0 && (inPos < 0 || outPos < inPos)) isIncoming = false; else isOutgoing = false;
    }
    return { msg, isCbe, bank: isCbe ? 'CBE' : 'Telebirr', isIncoming, isOutgoing };
}

function parseVerifyInput(refIn, smsIn) {
    const text = String(smsIn || refIn || '').trim();
    if (!text) return null;
    const amount = text.length > 30 ? extractAmount(text) : 0;
    const ft = extractDirectFt(text);
    if (ft) return { type: 'ft', value: ft, amount };
    const v2 = text.match(/\b(v2-[A-Za-z0-9_-]{6,})/i);
    if (v2) return { type: 'v2', value: normV2(v2[1]), amount };
    const rc = text.match(/receipt\/([A-Z0-9]{8,14})\b/i);
    const tb = rc ? rc[1].toUpperCase() : extractTelebirrRef(text) || (/^[A-Za-z0-9]{8,14}$/.test(text) ? text.toUpperCase() : null);
    return tb ? { type: 'tb', value: tb, amount } : null;
}

// ================= FUZZY NAME MATCH (typos, first/full name) =================
function nameTokens(n) {
    const c = String(n || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\b(?:ato|wro|mr|mrs|ms|dr|eng)\b/g, ' ').replace(/\s+/g, ' ').trim();
    return c ? c.split(' ').filter(t => t.length >= 2) : [];
}
function lev(a, b) {
    if (a === b) return 0;
    const m = a.length, n = b.length;
    if (!m) return n;
    if (!n) return m;
    const dp = Array.from({ length: n + 1 }, (_, j) => j);
    for (let i = 1; i <= m; i++) {
        let prev = dp[0]; dp[0] = i;
        for (let j = 1; j <= n; j++) {
            const t = dp[j];
            dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j], dp[j - 1]);
            prev = t;
        }
    }
    return dp[n];
}
function tokSim(a, b) {
    if (a === b) return 1;
    if (a.length >= 3 && b.startsWith(a)) return 0.92;
    if (b.length >= 3 && a.startsWith(b)) return 0.90;
    const max = Math.max(a.length, b.length), d = lev(a, b);
    return d <= (max <= 4 ? 1 : 2) ? Math.max(0.65, 1 - d / (max + 1)) : 0;
}
function scoreName(reqName, candParty) {
    const rt = nameTokens(reqName), ct = nameTokens(candParty);
    if (!rt.length || !ct.length) return 0;
    const rj = rt.join(''), cj = ct.join('');
    if (rj === cj) return 1;
    if (rj.length >= 6 && cj.startsWith(rj)) return 0.95;
    let total = 0, hit = 0;
    rt.forEach((r, i) => {
        let best = 0;
        ct.forEach((c, j) => { const s = tokSim(r, c); if (s) best = Math.max(best, s + (i === 0 && j === 0 ? 0.08 : 0)); });
        if (best) { hit++; total += best; }
    });
    const need = rt.length <= 2 ? rt.length : Math.ceil(rt.length * 0.75);
    if (!ct.some(c => tokSim(rt[0], c)) || hit < need) return 0;
    return Math.min(1, total / rt.length);
}

// ================= CACHES =================
let agentCache = { list: null, at: 0 };
async function getAgents() {
    if (agentCache.list && Date.now() - agentCache.at < 120000) return agentCache.list;
    const r = await pool.query('SELECT id, name, token, match_text, active FROM agents ORDER BY id');
    agentCache = { list: r.rows, at: Date.now() };
    return agentCache.list;
}
const dropAgentCache = () => { agentCache = { list: null, at: 0 }; };
async function findAgentByToken(tk) { return tk ? (await getAgents()).find(a => a.active && a.token === tk) || null : null; }
async function findAgentByMsg(msg) { return (await getAgents()).find(a => a.active && a.match_text && msg.includes(a.match_text)) || null; }
async function nameMap() {
    const l = await getAgents().catch(() => []);
    return (id) => !id ? 'Owner' : ((l.find(a => a.id === id) || {}).name || 'Agent ' + id);
}

const recentCache = new Map();
const dropRecent = () => recentCache.clear();

const ftHit = new Map(), ftMiss = new Map();
function trimMap(m, max) { while (m.size > max) m.delete(m.keys().next().value); }

// ================= WAITERS: verify waits for a late SMS without polling the DB =================
const waiters = new Map();
let waiting = 0;
function waitFor(keys, ms) {
    keys = keys.filter(Boolean);
    if (!keys.length || waiting >= 200) return Promise.resolve(false);
    return new Promise((resolve) => {
        waiting++;
        const w = { done: false };
        w.finish = (v) => {
            if (w.done) return;
            w.done = true; waiting--; clearTimeout(w.t);
            keys.forEach(k => { const s = waiters.get(k); if (s) { s.delete(w); if (!s.size) waiters.delete(k); } });
            resolve(v);
        };
        w.t = setTimeout(() => w.finish(false), ms);
        keys.forEach(k => { if (!waiters.has(k)) waiters.set(k, new Set()); waiters.get(k).add(w); });
    });
}
function notify(keys) {
    keys.filter(Boolean).forEach(k => { const s = waiters.get(k); if (s) [...s].forEach(w => w.finish(true)); });
}

// ================= SCHEMA (automatic, safe to re-run) =================
async function ensureSchema() {
    await pool.query(`CREATE TABLE IF NOT EXISTS agents (
        id SERIAL PRIMARY KEY, name TEXT NOT NULL, token TEXT UNIQUE NOT NULL, match_text TEXT,
        active BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS cbe_transactions (
        id SERIAL PRIMARY KEY, tx_type TEXT NOT NULL, sender_name TEXT, amount NUMERIC(14,2) NOT NULL,
        ref_no TEXT UNIQUE, raw_sms TEXT, status TEXT NOT NULL DEFAULT 'Unused', category TEXT, balance NUMERIC,
        v2_code TEXT UNIQUE, resolve_attempts INTEGER NOT NULL DEFAULT 0, agent_id INTEGER,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS telebirr_transactions (
        id SERIAL PRIMARY KEY, tx_type TEXT NOT NULL, sender_name TEXT, amount NUMERIC(14,2) NOT NULL,
        ref_no TEXT NOT NULL UNIQUE, raw_sms TEXT, status TEXT NOT NULL DEFAULT 'Unused', category TEXT, balance NUMERIC,
        agent_id INTEGER, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    const common = ['agent_id INTEGER', 'recipient_account TEXT', 'claimed_by TEXT', 'claimed_txn_id TEXT',
        'claimed_at TIMESTAMPTZ', 'category TEXT', 'balance NUMERIC', 'created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()'];
    for (const [, t] of BANKS) for (const c of common) await pool.query(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS ${c}`);
    await pool.query('ALTER TABLE cbe_transactions ADD COLUMN IF NOT EXISTS v2_code TEXT');
    await pool.query('ALTER TABLE cbe_transactions ADD COLUMN IF NOT EXISTS resolve_attempts INTEGER NOT NULL DEFAULT 0');
    // allow the statuses Payout_Verified / Audit_Only if an old CHECK constraint exists
    await pool.query(`DO $$ DECLARE r record; BEGIN
        FOR r IN SELECT conname, conrelid::regclass AS t FROM pg_constraint
                 WHERE contype='c' AND conrelid IN ('cbe_transactions'::regclass,'telebirr_transactions'::regclass)
                 AND pg_get_constraintdef(oid) ILIKE '%status%'
        LOOP EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', r.t, r.conname); END LOOP; END $$;`);
    await pool.query(`CREATE TABLE IF NOT EXISTS agent_daily_audit (
        audit_date DATE NOT NULL, agent_id INTEGER NOT NULL DEFAULT 0, bank TEXT NOT NULL,
        total_in NUMERIC(14,2) NOT NULL DEFAULT 0, total_out NUMERIC(14,2) NOT NULL DEFAULT 0,
        atm_out NUMERIC(14,2) NOT NULL DEFAULT 0, airtime_bill_out NUMERIC(14,2) NOT NULL DEFAULT 0,
        tx_count INTEGER NOT NULL DEFAULT 0, last_balance NUMERIC(14,2),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (audit_date, agent_id, bank))`);
    const idx = [
        'CREATE INDEX IF NOT EXISTS idx_cbe_v2 ON cbe_transactions (v2_code)',
        `CREATE INDEX IF NOT EXISTS idx_cbe_locked ON cbe_transactions (amount) WHERE status = 'Sent_Locked'`,
        `CREATE INDEX IF NOT EXISTS idx_tb_locked ON telebirr_transactions (amount) WHERE status = 'Sent_Locked'`,
        `CREATE UNIQUE INDEX IF NOT EXISTS uq_cbe_wid ON cbe_transactions (claimed_txn_id) WHERE status = 'Payout_Verified'`,
        `CREATE UNIQUE INDEX IF NOT EXISTS uq_tb_wid ON telebirr_transactions (claimed_txn_id) WHERE status = 'Payout_Verified'`
    ];
    for (const sql of idx) await pool.query(sql).catch(e => console.error('index skipped:', e.message));
    const v = await pool.query("SELECT to_regclass('agent_deposits') AS r");
    if (!v.rows[0].r) {
        await pool.query(`CREATE VIEW agent_deposits AS
            SELECT 'CBE'::text AS bank, id AS tx_id, amount, ref_no, sender_name, balance, status, created_at, agent_id
              FROM cbe_transactions WHERE tx_type='Received' AND agent_id IS NOT NULL
            UNION ALL
            SELECT 'Telebirr'::text, id, amount, ref_no, sender_name, balance, status, created_at, agent_id
              FROM telebirr_transactions WHERE tx_type='Received' AND agent_id IS NOT NULL`)
            .catch(e => console.error('view skipped:', e.message));
    }
    console.log('schema ready');
}

// ================= RETENTION: daily rollup, then prune old rows =================
let lastPrune = 0;
async function runAuditAndPrune(days = RETENTION_DAYS) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        for (const [bank, table] of BANKS) {
            const del = await client.query(
                `DELETE FROM ${table} WHERE created_at < NOW() - ($1 || ' days')::interval
                   AND status IN ('Used','Unused','Payout_Verified','Audit_Only')
                 RETURNING COALESCE(agent_id,0) AS agent_id, tx_type, category, amount, balance,
                           (created_at AT TIME ZONE 'Africa/Addis_Ababa')::date AS d`, [String(days)]);
            const b = new Map();
            for (const r of del.rows) {
                const k = r.d + '|' + r.agent_id;
                if (!b.has(k)) b.set(k, { d: r.d, a: r.agent_id, i: 0, o: 0, atm: 0, bill: 0, n: 0, bal: null });
                const x = b.get(k), amt = parseFloat(r.amount || 0);
                x.n++;
                if (r.tx_type === 'Received') x.i += amt;
                else { x.o += amt; if (r.category === 'ATM/Card') x.atm += amt; else if (['Airtime', 'Data', 'Bill'].includes(r.category)) x.bill += amt; }
                if (r.balance != null) x.bal = parseFloat(r.balance);
            }
            for (const x of b.values()) {
                await client.query(
                    `INSERT INTO agent_daily_audit (audit_date, agent_id, bank, total_in, total_out, atm_out, airtime_bill_out, tx_count, last_balance)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
                     ON CONFLICT (audit_date, agent_id, bank) DO UPDATE SET
                       total_in = agent_daily_audit.total_in + EXCLUDED.total_in, total_out = agent_daily_audit.total_out + EXCLUDED.total_out,
                       atm_out = agent_daily_audit.atm_out + EXCLUDED.atm_out, airtime_bill_out = agent_daily_audit.airtime_bill_out + EXCLUDED.airtime_bill_out,
                       tx_count = agent_daily_audit.tx_count + EXCLUDED.tx_count,
                       last_balance = COALESCE(EXCLUDED.last_balance, agent_daily_audit.last_balance), updated_at = NOW()`,
                    [x.d, x.a, bank, x.i, x.o, x.atm, x.bill, x.n, x.bal]);
            }
        }
        await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); console.error('prune error:', e.message); }
    finally { client.release(); }
}
function maybePrune() {
    if (Date.now() - lastPrune > 86400000) { lastPrune = Date.now(); setTimeout(() => runAuditAndPrune().catch(() => {}), 5000); }
}

// ================= CBE FT RESOLVER (runs only while rows are waiting) =================
function fetchHttps(hostname, path, headers) {
    return new Promise((resolve, reject) => {
        const req = https.request({ hostname, path, method: 'GET', headers, rejectUnauthorized: false, timeout: 5000 }, (res) => {
            let d = '';
            res.on('data', c => { if (d.length < 300000) d += c; });
            res.on('end', () => resolve({ status: res.statusCode, body: d }));
        });
        req.on('timeout', () => req.destroy(new Error('timeout')));
        req.on('error', reject);
        req.end();
    });
}
const CBE_H = {
    'X-App-ID': 'd1292e42-7400-49de-a2d3-9731caa4c819', 'X-App-Version': '0a01980b-9859-1369-8198-59f403820000',
    'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0'
};
function cbeTargets(code) {
    const raw = code.replace(/^v2-/i, ''), e = encodeURIComponent;
    return [
        { name: 'api-v2', host: 'mb.cbe.com.et', path: `/api/v1/transactions/public/transaction-detail/${e('v2-' + raw)}`, headers: CBE_H },
        { name: 'api-raw', host: 'mb.cbe.com.et', path: `/api/v1/transactions/public/transaction-detail/${e(raw)}`, headers: CBE_H },
        { name: 'receipt', host: 'mbreciept.cbe.com.et', path: `/${e('v2-' + raw)}`, headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'text/html,application/json' } }
    ];
}
async function resolveFtNumber(v2, force = false) {
    if (!v2) return null;
    if (ftHit.has(v2)) return ftHit.get(v2);
    const miss = ftMiss.get(v2);
    if (!force && miss && Date.now() - miss < 20000) return null;
    for (const t of cbeTargets(v2)) {
        try {
            const r = await fetchHttps(t.host, t.path, t.headers);
            const m = r.body.match(/\b(FT[A-Z0-9]{8,15})\b/i);
            if (m) { const ft = m[1].toUpperCase(); ftHit.set(v2, ft); trimMap(ftHit, 300); ftMiss.delete(v2); return ft; }
        } catch (_) {}
    }
    ftMiss.set(v2, Date.now()); trimMap(ftMiss, 300);
    return null;
}
async function settleFt(id, ft, v2) {
    try {
        await pool.query('UPDATE cbe_transactions SET ref_no=$1 WHERE id=$2 AND ref_no IS NULL', [ft, id]);
        dropRecent(); notify([ft, v2]);
        return 'Resolved';
    } catch (e) {
        if (e.code === '23505') { await pool.query('DELETE FROM cbe_transactions WHERE id=$1 AND ref_no IS NULL', [id]); return 'Duplicate'; }
        throw e;
    }
}
let resolverBusy = false, resolverTimer = null, resolveDelay = 15000;
async function resolvePending() {
    if (resolverBusy) return true;
    resolverBusy = true;
    try {
        const { rows } = await pool.query(
            `SELECT id, v2_code FROM cbe_transactions
             WHERE ref_no IS NULL AND v2_code IS NOT NULL AND resolve_attempts < 40
               AND COALESCE(category,'Transfer') NOT IN ('ATM/Card','Airtime','Data','Bill')
             ORDER BY id LIMIT 10`);
        if (!rows.length) return false;
        const failed = [];
        for (const r of rows) {
            const ft = await resolveFtNumber(r.v2_code, true);
            if (ft) await settleFt(r.id, ft, r.v2_code); else failed.push(r.id);
        }
        if (failed.length) await pool.query('UPDATE cbe_transactions SET resolve_attempts = resolve_attempts+1 WHERE id = ANY($1::int[])', [failed]);
        return failed.length > 0 || rows.length === 10;
    } catch (e) { console.error('resolver:', e.message); return true; }
    finally { resolverBusy = false; }
}
function scheduleResolve(ms) {
    const fresh = ms !== undefined;
    if (resolverTimer) { if (!fresh) return; clearTimeout(resolverTimer); }
    if (fresh) resolveDelay = 15000;
    resolverTimer = setTimeout(async () => {
        resolverTimer = null;
        if (await resolvePending()) { resolveDelay = Math.min(resolveDelay * 2, 300000); scheduleResolve(); }
    }, fresh ? ms : resolveDelay);
}

// ================= AUTH =================
const tokenOf = (req) => String(req.query.token || bodyOf(req).token || req.get('x-verify-token') || '');
const isOwnerToken = (t) => !!t && (t === SECRET_TOKEN || (!!VERIFY_TOKEN && t === VERIFY_TOKEN));
function authAdmin(req, res) {
    const t = tokenOf(req);
    if (!t || t !== SECRET_TOKEN) { res.status(401).json({ status: 'Unauthorized' }); return false; }
    return true;
}
function authVerify(req, res) {
    if (isOwnerToken(tokenOf(req))) return true;
    res.status(401).json({ status: 'Unauthorized' });
    return false;
}
async function roleOf(req) {
    const t = tokenOf(req);
    if (isOwnerToken(t)) return { isOwner: true, agentId: null, name: 'Owner' };
    const a = await findAgentByToken(t);
    return a ? { isOwner: false, agentId: a.id, name: a.name } : null;
}

// ================= 1. SMS WEBHOOK (GET or POST) =================
async function handleWebhook(req, res) {
    const q = { ...req.query, ...bodyOf(req) };
    const token = str(q.token);
    let agent = null;
    if (!isOwnerToken(token)) {
        try { agent = await findAgentByToken(token); }
        catch (e) { console.error(e); return res.status(500).json({ status: 'Database_Error' }); }
        if (!agent) return res.status(401).json({ status: 'Unauthorized' });
    }
    const message = q.message || q.raw_sms;
    if (!message) return res.status(400).json({ status: 'Error', message: 'No SMS provided' });

    const c = classify(message, q.sender);
    if (!c.isIncoming && !c.isOutgoing) return res.json({ status: 'Ignored', reason: 'Not a payment SMS' });
    if (!agent && c.isIncoming) { try { agent = await findAgentByMsg(c.msg); } catch (_) {} }
    const agentId = agent ? agent.id : null, agentLabel = agent ? agent.name : 'Owner';

    const amount = extractAmount(c.msg), balance = extractBalance(c.msg);
    const party = extractParty(c.msg, c.isIncoming, c.bank);
    const recipient = c.isOutgoing ? extractRecipientAccount(c.msg, c.isCbe) : null;
    const category = detectCategory(c.msg, c.isIncoming);
    const eligible = !NON_HB.includes(category);

    let ref = null, v2 = null;
    if (c.isCbe) {
        ref = extractDirectFt(c.msg);
        v2 = extractV2Code(c.msg);
        if (!ref && !v2) ref = 'CBE-' + crypto.createHash('sha1').update(c.msg).digest('hex').slice(0, 12).toUpperCase();
    } else {
        ref = extractTelebirrRef(c.msg);
        if (!ref) return res.json({ status: 'Ignored', reason: 'Missing Ref' });
    }
    if (!amount) return res.json({ status: 'Ignored', reason: 'Missing Amount' });

    const txType = c.isIncoming ? 'Received' : 'Transferred';
    const status = !eligible ? 'Audit_Only' : (c.isIncoming ? 'Unused' : 'Sent_Locked');
    try {
        const r = c.isCbe
            ? await pool.query(
                `INSERT INTO cbe_transactions (tx_type, sender_name, amount, ref_no, raw_sms, status, category, balance, v2_code, agent_id, recipient_account)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING RETURNING id`,
                [txType, party, amount, ref, c.msg, status, category, balance, v2, agentId, recipient])
            : await pool.query(
                `INSERT INTO telebirr_transactions (tx_type, sender_name, amount, ref_no, raw_sms, status, category, balance, agent_id, recipient_account)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING RETURNING id`,
                [txType, party, amount, ref, c.msg, status, category, balance, agentId, recipient]);
        const base = { bank: c.bank, type: txType, category, amount, balance, party, recipient_account: recipient, agent: agentLabel };
        if (!r.rows.length) return res.json({ status: 'Duplicate', ref: ref || v2, ...base });
        dropRecent(); maybePrune();
        notify([ref, v2]);                                   // wakes any player waiting for this payment
        if (c.isCbe && !ref && eligible) { scheduleResolve(2000); return res.json({ status: 'Saved', ref: null, resolving: true, v2, ...base }); }
        return res.json({ status: 'Saved', ref, ...base });
    } catch (e) { console.error(e); return res.status(500).json({ status: 'Database_Error' }); }
}
app.get('/webhook/sms', handleWebhook);
app.post('/webhook/sms', handleWebhook);

// ================= 2. DEPOSIT VERIFY =================
async function claimDeposit(table, col, val, amount, by, txn) {
    const r = await pool.query(
        `UPDATE ${table} SET status='Used', claimed_by=$3, claimed_txn_id=$4, claimed_at=NOW()
         WHERE ${col}=$1 AND tx_type='Received' AND status='Unused' AND ref_no IS NOT NULL
           AND COALESCE(category,'Received') NOT IN ('ATM/Card','Airtime','Data','Bill') AND ABS(amount-$2) < 0.01
         RETURNING amount, ref_no, sender_name, agent_id`, [val, amount, by, txn]);
    return r.rows[0] || null;
}
async function whyNot(table, col, val, bank, expected) {
    const r = await pool.query(`SELECT tx_type, ref_no, status, amount, category FROM ${table} WHERE ${col}=$1 LIMIT 1`, [val]);
    if (!r.rows.length) return { status: 'Pending', bank };
    const x = r.rows[0];
    if (NON_HB.includes(x.category) || x.tx_type !== 'Received') return { status: 'Invalid_Transaction_Type', bank };
    if (!x.ref_no) return { status: 'Resolving', bank };
    if (x.status !== 'Unused') return { status: 'AlreadyUsed', bank };
    return { status: 'InvalidAmount', expected, actual: parseFloat(x.amount), bank };
}
async function tryDeposit(inp, expected, by, txn) {
    const isTb = inp.type === 'tb';
    const table = isTb ? 'telebirr_transactions' : 'cbe_transactions', bank = isTb ? 'Telebirr' : 'CBE';
    let col = inp.type === 'v2' ? 'v2_code' : 'ref_no', val = inp.value;
    let tx = await claimDeposit(table, col, val, expected, by, txn);
    if (tx) return { tx, bank };
    if (inp.type === 'v2') {
        const r = await pool.query('SELECT id, ref_no FROM cbe_transactions WHERE v2_code=$1 LIMIT 1', [val]);
        if (!r.rows.length || !r.rows[0].ref_no) {
            const ft = await resolveFtNumber(val);
            if (ft) {
                if (r.rows.length) await settleFt(r.rows[0].id, ft, val).catch(() => {});
                col = 'ref_no'; val = ft;
                tx = await claimDeposit(table, col, val, expected, by, txn);
                if (tx) return { tx, bank };
            }
        }
    }
    return { why: await whyNot(table, col, val, bank, expected), keys: [inp.value, val] };
}
app.get('/api/verify', async (req, res) => {
    if (!authVerify(req, res)) return;
    const inp = parseVerifyInput(req.query.ref, req.query.sms || req.query.text);
    if (!inp) return res.json({ status: 'Missing_Ref' });
    let expected = parseFloat(req.query.amount);
    if (isNaN(expected) && inp.amount) expected = inp.amount;
    if (isNaN(expected) || expected <= 0) return res.json({ status: 'Missing_Amount' });
    const by = str(req.query.username || req.query.claimed_by).slice(0, 100) || null;
    const txn = str(req.query.txn_id || req.query.claimed_txn_id).slice(0, 100) || null;
    const wait = req.query.wait !== undefined ? clamp(parseInt(req.query.wait) || 0, 0, 20) : VERIFY_WAIT;
    const key = [inp.type, inp.value, expected, by || '', txn || ''].join(':');
    try {
        let p = inflight.get(key);
        if (!p) {
            p = (async () => {
                let r = await tryDeposit(inp, expected, by, txn);
                if (r.why && (r.why.status === 'Pending' || r.why.status === 'Resolving') && wait > 0) {
                    if (await waitFor(r.keys, wait * 1000)) r = await tryDeposit(inp, expected, by, txn);
                }
                if (!r.tx) return r.why;
                dropRecent();
                const nm = await nameMap();
                return { status: 'Verified', bank: r.bank, amount: parseFloat(r.tx.amount), ref_no: r.tx.ref_no,
                    from_to: r.tx.sender_name, agent: nm(r.tx.agent_id), agent_id: r.tx.agent_id || null, claimed_by: by };
            })();
            inflight.set(key, p);
            p.finally(() => inflight.delete(key)).catch(() => {});
        }
        return res.json(await p);
    } catch (e) { console.error(e); return res.status(500).json({ status: 'System_Busy' }); }
});

// ================= 3. WITHDRAWAL VERIFY (ref, or name/account + amount) =================
const MIN_SCORE = 0.75;
async function lockPayout(table, id, wid, by) {
    try {
        const r = await pool.query(
            `UPDATE ${table} SET status='Payout_Verified', claimed_txn_id=$2, claimed_by=$3, claimed_at=NOW()
             WHERE id=$1 AND tx_type='Transferred' AND status='Sent_Locked'
             RETURNING amount, ref_no, sender_name, agent_id, recipient_account, claimed_txn_id`, [id, wid, by]);
        return r.rows[0] || null;
    } catch (e) { if (e.code === '23505') return 'dup'; throw e; }
}
function allSameRecipient(rows) {
    if (!rows || rows.length <= 1) return false;
    const accts = rows.map(r => last4(r.recipient_account)).filter(Boolean);
    const names = rows.map(r => String(r.sender_name || '').toLowerCase().replace(/\s+/g, ' ').trim()).filter(Boolean);
    const sameAcct = accts.length === rows.length && new Set(accts).size === 1;
    const sameName = names.length === rows.length && new Set(names).size === 1;
    return sameAcct || sameName;
}
async function handleWithdrawal(req, res, lock) {
    if (!authVerify(req, res)) return;
    const q = { ...req.query, ...bodyOf(req) };
    const ref = str(q.ref), name = str(q.name || q.customer_name || q.full_name || q.recipient_name);
    const account = str(q.account || q.recipient || q.phone);
    const wid = str(q.withdrawal_id || q.txn_id).slice(0, 100) || null;
    const by = str(q.processed_by || q.username || q.claimed_by).slice(0, 100) || null;
    const expected = parseFloat(q.amount), bankF = str(q.bank).toLowerCase();
    const hours = clamp(parseInt(q.hours) || 72, 1, 720);
    const agentF = q.agent_id ? parseInt(q.agent_id, 10) : null;
    let sinceMs = Number(q.since);
    if (!Number.isFinite(sinceMs) || sinceMs <= 0) sinceMs = 0; else if (sinceMs < 1e12) sinceMs *= 1000;
    if (!(expected > 0)) return res.json({ status: 'Missing_Amount' });
    if (!ref && !name && !account) return res.json({ status: 'Missing_Params', message: 'Provide ref OR name/account + amount' });
    try {
        const nm = await nameMap();
        const body = (status, bank, u, extra) => ({ status, bank, amount: parseFloat(u.amount), ref_no: u.ref_no, party: u.sender_name,
            agent: nm(u.agent_id), recipient_account: u.recipient_account || null, claimed_txn_id: u.claimed_txn_id || wid, ...extra });

        if (wid) for (const [bn, t] of BANKS) {   // same withdrawal asked twice -> same answer
            const p = await pool.query(`SELECT amount, ref_no, sender_name, agent_id, recipient_account, claimed_txn_id FROM ${t} WHERE claimed_txn_id=$1 AND status='Payout_Verified' LIMIT 1`, [wid]);
            if (p.rows.length) return res.json(body('Payout_Verified', bn, p.rows[0], { already_verified: true }));
        }

        let target = null;   // { table, bank, row, score }
        if (ref) {
            const inp = parseVerifyInput(ref, null);
            if (!inp) return res.json({ status: 'Missing_Ref' });
            const [bank, table] = inp.type === 'tb' ? BANKS[1] : BANKS[0];
            const col = inp.type === 'v2' ? 'v2_code' : 'ref_no';
            const f = await pool.query(`SELECT id, tx_type, status, category, amount, ref_no, sender_name, agent_id, recipient_account, claimed_txn_id FROM ${table} WHERE ${col}=$1 LIMIT 1`, [inp.value]);
            if (!f.rows.length) return res.json({ status: 'Not_Found', bank });
            const row = f.rows[0];
            if (NON_HB.includes(row.category) || row.tx_type !== 'Transferred') return res.json({ status: 'Invalid_Transaction_Type', bank });
            if (Math.abs(parseFloat(row.amount) - expected) >= 0.01) return res.json({ status: 'InvalidAmount', expected, actual: parseFloat(row.amount), bank });
            if (row.status === 'Payout_Verified') return res.json({ status: 'AlreadyVerified', bank, ref_no: row.ref_no, claimed_txn_id: row.claimed_txn_id });
            if (row.status !== 'Sent_Locked') return res.json({ status: 'Invalid_Status', actual_status: row.status, bank });
            target = { table, bank, row, score: 1 };
        } else {
            const list = bankF === 'cbe' ? [BANKS[0]] : bankF === 'telebirr' ? [BANKS[1]] : BANKS;
            const cands = [];
            for (const [bank, table] of list) {
                const hasAg = agentF !== null && !isNaN(agentF);
                const r = await pool.query(
                    `SELECT id, amount, ref_no, sender_name, agent_id, recipient_account, created_at FROM ${table}
                     WHERE status='Sent_Locked' AND tx_type='Transferred' AND ABS(amount-$1) < 0.01
                       AND created_at >= NOW() - ($2 || ' hours')::interval ${hasAg ? 'AND agent_id=$3' : ''}
                     ORDER BY id DESC LIMIT 25`, hasAg ? [expected, String(hours), agentF] : [expected, String(hours)]);
                for (const row of r.rows) {
                    let score = name ? scoreName(name, row.sender_name) : 0;
                    if (account && row.recipient_account) {
                        score = last4(account) === last4(row.recipient_account) ? Math.min(1, (score || 0.8) + 0.2) : 0;
                    }
                    if (score >= MIN_SCORE) cands.push({ table, bank, row, score });
                }
            }
            if (!cands.length) return res.json({ status: 'Not_Found', amount: expected, looked_for_name: name || null });
            const ts = (x) => (x.row.created_at ? new Date(x.row.created_at).getTime() : 0);
            cands.sort((a, b) => b.score - a.score || ts(b) - ts(a) || b.row.id - a.row.id);   // best score, then newest
            let top = cands.filter(x => cands[0].score - x.score < 0.05);
            if (sinceMs) {
                const recent = top.filter(x => !x.row.created_at || ts(x) >= sinceMs - 120000);
                if (recent.length) top = recent;
            }
            if (top.length > 1) {
                if ((name || account) && allSameRecipient(top.map(x => x.row))) top = [top[0]];   // same person: take the newest
                else return res.json({ status: 'Ambiguous', count: top.length, refs: top.slice(0, 5).map(x => x.row.ref_no) });
            }
            target = top[0];
        }

        if (!lock) return res.json(body('Match_Found', target.bank, target.row, { match_score: Number(target.score.toFixed(2)) }));
        const u = await lockPayout(target.table, target.row.id, wid, by);
        if (u === 'dup') return res.json({ status: 'AlreadyVerified', bank: target.bank });
        if (!u) return res.json({ status: 'System_Busy', message: 'Payout was claimed concurrently; retry' });
        dropRecent();
        return res.json(body('Payout_Verified', target.bank, u, { match_score: Number(target.score.toFixed(2)) }));
    } catch (e) { console.error(e); return res.status(500).json({ status: 'Database_Error' }); }
}
app.get('/api/verify-withdrawal', (req, res) => handleWithdrawal(req, res, true));
app.post('/api/verify-withdrawal', (req, res) => handleWithdrawal(req, res, true));
app.post('/api/withdrawal-request', (req, res) => handleWithdrawal(req, res, true));
app.get('/api/check-withdrawal', (req, res) => handleWithdrawal(req, res, false));

// ================= 4. RECENT / CHECK (owner sees all, agent sees own) =================
async function locate(inp) {
    if (inp.type === 'tb') return { table: 'telebirr_transactions', col: 'ref_no', val: inp.value, bank: 'Telebirr' };
    const o = { table: 'cbe_transactions', bank: 'CBE', col: inp.type === 'v2' ? 'v2_code' : 'ref_no', val: inp.value };
    if (inp.type === 'v2') {
        const r = await pool.query('SELECT id, ref_no FROM cbe_transactions WHERE v2_code=$1 LIMIT 1', [inp.value]);
        if (!r.rows.length || !r.rows[0].ref_no) {
            const ft = await resolveFtNumber(inp.value);
            if (ft) { if (r.rows.length) await settleFt(r.rows[0].id, ft, inp.value).catch(() => {}); o.col = 'ref_no'; o.val = ft; }
        }
    }
    return o;
}
app.get('/api/check', async (req, res) => {
    const role = await roleOf(req).catch(() => null);
    if (!role) return res.status(401).json({ status: 'Unauthorized' });
    const inp = parseVerifyInput(req.query.ref, req.query.sms || req.query.text);
    if (!inp) return res.json({ status: 'Missing_Ref' });
    try {
        const t = await locate(inp);
        const r = await pool.query(`SELECT * FROM ${t.table} WHERE ${t.col}=$1 ${role.isOwner ? '' : 'AND agent_id=$2'} LIMIT 1`,
            role.isOwner ? [t.val] : [t.val, role.agentId]);
        if (!r.rows.length) return res.json({ status: 'Not_Found', bank: t.bank, looked_for: t.val });
        const x = r.rows[0], nm = await nameMap();
        return res.json({
            status: x.ref_no ? 'Found' : 'Found_FT_Pending', bank: t.bank, type: x.tx_type, amount: parseFloat(x.amount),
            ref_no: x.ref_no, party: x.sender_name, usage: x.status, category: x.category || null,
            balance: x.balance != null ? parseFloat(x.balance) : null, v2_code: x.v2_code || null, created_at: x.created_at || null,
            agent_id: x.agent_id || null, agent: nm(x.agent_id), recipient_account: x.recipient_account || null,
            claimed_by: x.claimed_by || null, claimed_txn_id: x.claimed_txn_id || null, claimed_at: x.claimed_at || null
        });
    } catch (e) { console.error(e); return res.status(500).json({ status: 'Database_Error' }); }
});
app.get('/api/recent', async (req, res) => {
    const role = await roleOf(req).catch(() => null);
    if (!role) return res.status(401).json({ status: 'Unauthorized' });
    const n = clamp(parseInt(req.query.limit) || 20, 1, 100);
    const key = (role.isOwner ? 'o' : role.agentId) + ':' + n;
    const hit = recentCache.get(key);
    if (hit && Date.now() - hit.at < 8000) return res.json(hit.payload);
    try {
        const nm = await nameMap();
        const cols = 'id, tx_type, amount, ref_no, sender_name, status, category, balance, agent_id, claimed_by, claimed_txn_id, claimed_at, recipient_account, created_at';
        const where = role.isOwner ? '' : 'WHERE agent_id=$2', params = role.isOwner ? [n] : [n, role.agentId];
        const [c, t] = await Promise.all([
            pool.query(`SELECT ${cols}, v2_code, resolve_attempts FROM cbe_transactions ${where} ORDER BY id DESC LIMIT $1`, params),
            pool.query(`SELECT ${cols} FROM telebirr_transactions ${where} ORDER BY id DESC LIMIT $1`, params)
        ]);
        const dec = (rows, bank) => rows.map(r => ({ ...r, bank, usage: r.status, agent: nm(r.agent_id) }));
        const payload = { status: 'OK', role: role.name, agent: role.name, cbe: dec(c.rows, 'CBE'), telebirr: dec(t.rows, 'Telebirr') };
        recentCache.set(key, { at: Date.now(), payload }); trimMap(recentCache, 50);
        return res.json(payload);
    } catch (e) { console.error(e); return res.status(500).json({ status: 'Database_Error' }); }
});

// ================= 5. ADMIN (SECRET_TOKEN) =================
// "Why didn't this deposit verify?"  /api/why?token=SECRET&ref=REF&amount=150
app.get('/api/why', async (req, res) => {
    if (!authAdmin(req, res)) return;
    const inp = parseVerifyInput(req.query.ref, req.query.sms || req.query.text);
    if (!inp) return res.json({ status: 'Missing_Ref' });
    try {
        const t = await locate(inp);
        const r = await pool.query(`SELECT tx_type, status, category, amount, ref_no, agent_id, claimed_by, created_at FROM ${t.table} WHERE ${t.col}=$1 LIMIT 1`, [t.val]);
        if (!r.rows.length) return res.json({ status: 'NoSmsYet', bank: t.bank, looked_for: t.val,
            hint: 'Server never received this SMS: check AK Finance token/URL, Test Connection, and that the SMS was forwarded.' });
        const x = r.rows[0], want = parseFloat(req.query.amount);
        return res.json({ status: 'SmsFound', bank: t.bank, row: x, checks: {
            is_received: x.tx_type === 'Received', unused: x.status === 'Unused', ref_ready: !!x.ref_no,
            eligible_category: !NON_HB.includes(x.category), amount_matches: isNaN(want) ? 'amount not given' : Math.abs(parseFloat(x.amount) - want) < 0.01 } });
    } catch (e) { console.error(e); return res.status(500).json({ status: 'Database_Error' }); }
});

async function createAgent(req, res) {
    if (!authAdmin(req, res)) return;
    const q = { ...req.query, ...bodyOf(req) };
    const name = str(q.name).slice(0, 60), matchText = str(q.match_text).slice(0, 100) || null;
    if (!name) return res.status(400).json({ status: 'Missing_Name' });
    const token = 'ag_' + crypto.randomBytes(18).toString('hex');
    try {
        const r = await pool.query('INSERT INTO agents (name, token, match_text, active) VALUES ($1,$2,$3,TRUE) RETURNING id, name, token, match_text, active', [name, token, matchText]);
        dropAgentCache();
        return res.json({ status: 'OK', agent: r.rows[0], webhook_url: `${req.protocol}://${req.get('host')}/webhook/sms?token=${token}` });
    } catch (e) { console.error(e); return res.status(500).json({ status: 'Database_Error' }); }
}
app.post('/api/admin/agents', createAgent);
app.get('/api/admin/agents/create', createAgent);
app.get('/api/admin/agents', async (req, res) => {
    if (!authAdmin(req, res)) return;
    try { return res.json({ status: 'OK', agents: (await pool.query('SELECT id, name, token, match_text, active, created_at FROM agents ORDER BY id')).rows }); }
    catch (e) { console.error(e); return res.status(500).json({ status: 'Database_Error' }); }
});
async function toggleAgent(req, res) {
    if (!authAdmin(req, res)) return;
    const id = parseInt(bodyOf(req).id || req.query.id, 10);
    if (isNaN(id)) return res.status(400).json({ status: 'Missing_Id' });
    try {
        const r = await pool.query('UPDATE agents SET active = NOT active WHERE id=$1 RETURNING id, name, active', [id]);
        dropAgentCache();
        return res.json({ status: 'OK', agent: r.rows[0] || null });
    } catch (e) { console.error(e); return res.status(500).json({ status: 'Database_Error' }); }
}
app.post('/api/admin/agents/toggle', toggleAgent);
app.get('/api/admin/agents/toggle', toggleAgent);

app.get('/api/admin/audit-prune', async (req, res) => {
    if (!authAdmin(req, res)) return;
    const days = Math.max(parseInt(req.query.days || String(RETENTION_DAYS), 10) || RETENTION_DAYS, 1);
    await runAuditAndPrune(days);
    return res.json({ status: 'OK', retention_days: days });
});
app.get('/api/admin/daily-audit', async (req, res) => {
    if (!authAdmin(req, res)) return;
    try { return res.json({ status: 'OK', items: (await pool.query('SELECT * FROM agent_daily_audit ORDER BY audit_date DESC, agent_id LIMIT 200')).rows }); }
    catch (e) { console.error(e); return res.status(500).json({ status: 'Database_Error' }); }
});
app.get('/api/agents', async (req, res) => {
    if (!authAdmin(req, res)) return;
    try {
        const r = await pool.query(
            `SELECT a.id, a.name, a.active, COALESCE(SUM(d.amount),0) AS total_in, COUNT(d.tx_id) AS count_in,
                    COALESCE(SUM(d.amount) FILTER (WHERE (d.created_at AT TIME ZONE 'Africa/Addis_Ababa')::date = (NOW() AT TIME ZONE 'Africa/Addis_Ababa')::date),0) AS today_in
             FROM agents a LEFT JOIN agent_deposits d ON d.agent_id = a.id GROUP BY a.id ORDER BY a.id`);
        return res.json({ status: 'OK', agents: r.rows });
    } catch (e) { console.error(e); return res.status(500).json({ status: 'Database_Error' }); }
});
app.get('/api/agent/deposits', async (req, res) => {
    if (!authAdmin(req, res)) return;
    const id = parseInt(req.query.agent);
    if (isNaN(id)) return res.json({ status: 'Missing_Agent' });
    const n = clamp(parseInt(req.query.limit) || 50, 1, 500);
    try {
        const r = await pool.query(
            `SELECT bank, tx_id, amount, ref_no, sender_name, balance, status, created_at FROM agent_deposits
             WHERE agent_id=$1 AND (created_at AT TIME ZONE 'Africa/Addis_Ababa')::date BETWEEN $2::date AND $3::date
             ORDER BY created_at DESC LIMIT $4`, [id, req.query.from || '1970-01-01', req.query.to || '2999-12-31', n]);
        return res.json({ status: 'OK', agent: id, count: r.rows.length, total: r.rows.reduce((s, x) => s + parseFloat(x.amount), 0), items: r.rows });
    } catch (e) { console.error(e); return res.status(500).json({ status: 'Database_Error' }); }
});
app.get('/api/cbe/resolve', async (req, res) => {
    if (!authAdmin(req, res)) return;
    const m = str(req.query.v2).match(/v2-[A-Za-z0-9_-]+/i), ft = str(req.query.ft).toUpperCase();
    if (!m) return res.json({ status: 'Missing_V2' });
    if (!/^FT[A-Z0-9]{8,15}$/.test(ft)) return res.json({ status: 'Invalid_FT' });
    try {
        const r = await pool.query('SELECT id FROM cbe_transactions WHERE v2_code=$1 AND ref_no IS NULL', [normV2(m[0])]);
        if (!r.rows.length) return res.json({ status: 'Not_Pending' });
        return res.json({ status: await settleFt(r.rows[0].id, ft, normV2(m[0])), ref_no: ft });
    } catch (e) { console.error(e); return res.status(500).json({ status: 'Database_Error' }); }
});
app.get('/api/cbe/pending', async (req, res) => {
    if (!authAdmin(req, res)) return;
    try {
        const r = await pool.query(`SELECT id, v2_code, amount, sender_name, resolve_attempts AS attempts FROM cbe_transactions
            WHERE ref_no IS NULL AND COALESCE(category,'Transfer') NOT IN ('ATM/Card','Airtime','Data','Bill') ORDER BY id DESC LIMIT 50`);
        return res.json({ status: 'OK', count: r.rows.length, items: r.rows });
    } catch (e) { console.error(e); return res.status(500).json({ status: 'Database_Error' }); }
});

// admin: connection pool + database size (open: /api/health?token=SECRET)
app.get('/api/health', async (req, res) => {
    if (!authAdmin(req, res)) return;
    try {
        const sz = await pool.query('SELECT pg_database_size(current_database()) AS bytes');
        const t = await pool.query(`SELECT relname, reltuples::bigint AS approx_rows FROM pg_class
            WHERE relname IN ('cbe_transactions','telebirr_transactions','agent_daily_audit')`);
        return res.json({ status: 'OK', pool: { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount },
            waiting_verifies: waiting, inflight: inflight.size, db_mb: Math.round(sz.rows[0].bytes / 1048576), tables: t.rows });
    } catch (e) { console.error(e); return res.status(500).json({ status: 'Database_Error' }); }
});

// health check: never touches the database
app.get('/', (req, res) => res.json({ status: 'ok' }));

if (require.main === module) {
    const PORT = process.env.PORT || 3000;
    ensureSchema()
        .then(() => app.listen(PORT, () => { console.log(`Gateway on port ${PORT}`); scheduleResolve(5000); }))
        .catch((e) => { console.error('Startup schema error:', e); process.exit(1); });
}
module.exports = { classify, extractAmount, extractBalance, extractTelebirrRef, extractParty, detectCategory, extractV2Code, extractDirectFt, extractRecipientAccount, parseVerifyInput, scoreName, lev };
