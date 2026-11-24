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
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

const app = express();
app.disable('x-powered-by');
app.set('etag', false);
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true, limit: '10kb' }));
app.use(cors());

// small pool + short idle time: lets the database go to sleep when nothing happens
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

// ---------- small in-memory caches (cut repeat DB + CBE calls) ----------
const ftHit = new Map();    // v2 code -> FT number (found)
const ftMiss = new Map();   // v2 code -> time of last failed CBE lookup
const pendCache = new Map(); // verify "Pending/Resolving" answers (cleared on any new/settled SMS)
const MISS_TTL = 20000;
const PEND_TTL = 4000;
function trim(map, max) { while (map.size > max) map.delete(map.keys().next().value); }

// <HELPERS>
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
        const m = isIncoming ? msg.match(/ከ\s+(.+?)\s*\(/) : msg.match(/ለ\s+(\S+)/);
        return m ? m[1].trim().slice(0, 100) : 'Telebirr Client';
    }
    const m = isIncoming ? msg.match(/from\s+([^(]+)\(/i) : msg.match(/to\s+([^(]+)\(/i);
    return m ? m[1].trim() : 'Telebirr Client';
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
    if (isIncoming && isOutgoing) { // both phrases: the first one wins
        if (outPos >= 0 && (inPos < 0 || outPos < inPos)) isIncoming = false; else isOutgoing = false;
    }
    return { msg, isCbe, bank, isIncoming, isOutgoing };
}

// Accepts: FT number, v2 code, full receipt link, Telebirr ref/receipt link, or a full SMS text
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
// </HELPERS>

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

// NOTE: CBE needs the FULL code including the "v2-" prefix.
function cbeTargets(code) {
    const raw = code.replace(/^v2-/i, '');
    const enc = encodeURIComponent;
    return [
        { name: 'api-v2',    host: 'mb.cbe.com.et', path: `/api/v1/transactions/public/transaction-detail/${enc('v2-' + raw)}`, headers: CBE_HEADERS },
        { name: 'api-raw',   host: 'mb.cbe.com.et', path: `/api/v1/transactions/public/transaction-detail/${enc(raw)}`, headers: CBE_HEADERS },
        { name: 'receipt-page', host: 'mbreciept.cbe.com.et', path: `/${enc('v2-' + raw)}`, headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'text/html,application/json' } }
    ];
}

// returns FT number or null (never returns the v2 code)
// force=true (background resolver) skips the "recently failed" shortcut
async function resolveFtNumber(v2Code, attempts = 1, force = false) {
    if (!v2Code) return null;
    if (ftHit.has(v2Code)) return ftHit.get(v2Code);
    const missAt = ftMiss.get(v2Code);
    if (!force && missAt && Date.now() - missAt < MISS_TTL) return null;
    for (let i = 0; i < attempts; i++) {
        for (const t of cbeTargets(v2Code)) {
            try {
                const r = await fetchHttps(t.host, t.path, t.headers);
                const m = r.body.match(/\b(FT[A-Z0-9]{8,15})\b/i);
                if (m) {
                    const ft = m[1].toUpperCase();
                    ftHit.set(v2Code, ft); trim(ftHit, 300); ftMiss.delete(v2Code);
                    return ft;
                }
                console.log(`CBE ${t.name} -> HTTP ${r.status}, no FT in body (${r.body.length} bytes)`);
            } catch (e) { console.log(`CBE ${t.name} failed: ${e.message}`); }
        }
        if (i < attempts - 1) await sleep(1500);
    }
    ftMiss.set(v2Code, Date.now()); trim(ftMiss, 300);
    return null;
}

// ---------- background resolver (NO polling: runs only while rows are waiting) ----------
let resolverBusy = false;
let resolverTimer = null;
const RESOLVE_EVERY = 30000;

async function settleFt(id, ft) {
    try {
        await pool.query('UPDATE cbe_transactions SET ref_no=$1 WHERE id=$2 AND ref_no IS NULL', [ft, id]);
        pendCache.clear();
        return 'Resolved';
    } catch (e) {
        if (e.code === '23505') { // FT already stored (duplicate SMS) -> drop the pending twin
            await pool.query('DELETE FROM cbe_transactions WHERE id=$1 AND ref_no IS NULL', [id]);
            return 'Duplicate';
        }
        throw e;
    }
}

// returns true if there is still work to do later
async function resolvePending() {
    if (resolverBusy) return true;
    resolverBusy = true;
    try {
        const { rows } = await pool.query(
            `SELECT id, v2_code FROM cbe_transactions
             WHERE ref_no IS NULL AND v2_code IS NOT NULL AND resolve_attempts < 40
             ORDER BY id LIMIT 10`);
        if (!rows.length) return false;
        const failed = [];
        for (const row of rows) {
            const ft = await resolveFtNumber(row.v2_code, 1, true);
            if (ft) await settleFt(row.id, ft); else failed.push(row.id);
        }
        if (failed.length) await pool.query('UPDATE cbe_transactions SET resolve_attempts = resolve_attempts+1 WHERE id = ANY($1::bigint[])', [failed]);
        return failed.length > 0 || rows.length === 10;
    } catch (e) { console.error('resolver:', e.message); return true; }
    finally { resolverBusy = false; }
}

// explicit ms = fresh work (new SMS / startup): restart from a short delay.
// no ms = retry after a failed round: delay doubles (15s, 30s, 60s ... max 5 min).
let resolveDelay = 15000;
function scheduleResolve(ms) {
    const fresh = ms !== undefined;
    if (resolverTimer) {
        if (!fresh) return;
        clearTimeout(resolverTimer);
    }
    if (fresh) resolveDelay = 15000;
    resolverTimer = setTimeout(async () => {
        resolverTimer = null;
        if (await resolvePending()) {
            resolveDelay = Math.min(resolveDelay * 2, 300000);
            scheduleResolve();
        }
    }, fresh ? ms : resolveDelay);
}

function auth(req, res) {
    if (req.query.token !== SECRET_TOKEN) { res.status(401).json({ status: 'Unauthorized' }); return false; }
    return true;
}

function authVerify(req, res) {
    const t = req.query.token;
    if (t === SECRET_TOKEN || (VERIFY_TOKEN && t === VERIFY_TOKEN)) return true;
    res.status(401).json({ status: 'Unauthorized' });
    return false;
}

// ---------- agents: ONE cached query instead of one per SMS ----------
const AGENT_TTL = 60000;
let agentCache = { list: null, at: 0 };
async function getAgents() {
    if (agentCache.list && Date.now() - agentCache.at < AGENT_TTL) return agentCache.list;
    const r = await pool.query('SELECT id, name, token, match_text FROM agents WHERE active');
    agentCache = { list: r.rows, at: Date.now() };
    return agentCache.list;
}
async function findAgentByToken(tk) {
    if (!tk) return null;
    return (await getAgents()).find(a => a.token === tk) || null;
}
async function findAgentByMsg(msg) {
    return (await getAgents()).find(a => a.match_text && msg.includes(a.match_text)) || null;
}

// ================= 1. SMS WEBHOOK =================
app.get('/webhook/sms', async (req, res) => {
    let agent = null;
    if (req.query.token !== SECRET_TOKEN) {
        try { agent = await findAgentByToken(req.query.token); }
        catch (e) { console.error(e); return res.status(500).json({ status: 'Database_Error' }); }
        if (!agent) return res.status(401).json({ status: 'Unauthorized' });
    }
    const { message } = req.query;
    if (!message) return res.status(400).json({ status: 'Error', message: 'No SMS provided' });

    const c = classify(message, req.query.sender);
    if (!c.isIncoming && !c.isOutgoing) return res.json({ status: 'Ignored', reason: 'Not a payment SMS' });

    if (!agent && c.isIncoming) { try { agent = await findAgentByMsg(c.msg); } catch (e) { console.error(e); } }
    const agentId = agent ? agent.id : null;

    const amount = extractAmount(c.msg);
    const balance = extractBalance(c.msg);
    const party = extractParty(c.msg, c.isIncoming, c.bank);
    const category = detectCategory(c.msg, c.isIncoming);
    let ref = null, v2 = null;

    if (c.isCbe) {
        ref = extractDirectFt(c.msg);
        v2 = extractV2Code(c.msg);
        if (!ref && v2) ref = await resolveFtNumber(v2, 1); // one quick try; the rest runs in background
        if (!ref && !v2) ref = 'CBE-' + crypto.createHash('sha1').update(c.msg).digest('hex').slice(0, 12).toUpperCase();
    } else {
        ref = extractTelebirrRef(c.msg);
        if (!ref) return res.json({ status: 'Ignored', reason: 'Missing Ref' });
    }
    if (!amount) return res.json({ status: 'Ignored', reason: 'Missing Amount' });

    const txType = c.isIncoming ? 'Received' : 'Transferred';
    const status = c.isIncoming ? 'Unused' : 'Sent_Locked';

    try {
        let result;
        if (c.isCbe) {
            result = await pool.query(
                `INSERT INTO cbe_transactions (tx_type, sender_name, amount, ref_no, raw_sms, status, category, balance, v2_code, agent_id)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING RETURNING id`,
                [txType, party, amount, ref, c.msg, status, category, balance, v2, agentId]);
        } else {
            result = await pool.query(
                `INSERT INTO telebirr_transactions (tx_type, sender_name, amount, ref_no, raw_sms, status, category, balance, agent_id)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING RETURNING id`,
                [txType, party, amount, ref, c.msg, status, category, balance, agentId]);
        }
        if (result.rows.length === 0) return res.json({ status: 'Duplicate', bank: c.bank, ref: ref || v2 });
        pendCache.clear(); // a new row exists now: cached "Pending" answers are stale
        if (c.isCbe && !ref) {
            scheduleResolve(3000);
            return res.json({ status: 'Saved', bank: c.bank, type: txType, amount, ref: null, resolving: true, v2 });
        }
        return res.json({ status: 'Saved', bank: c.bank, type: txType, category, ref, amount });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ status: 'Database_Error' });
    }
});

// ================= 2. CBE manual FT / pending list =================
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
            `SELECT id, v2_code, amount, sender_name, resolve_attempts AS attempts
             FROM cbe_transactions WHERE ref_no IS NULL ORDER BY id DESC LIMIT 50`);
        return res.json({ status: 'OK', count: r.rows.length, items: r.rows });
    } catch (e) { console.error(e); return res.status(500).json({ status: 'Database_Error' }); }
});

// Diagnose the CBE lookup (no database use)
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

// ================= 3. VERIFY (Dash Bingo) =================
// Success path = ONE atomic query (no BEGIN/COMMIT, no lock, no extra SELECT).
async function tryUse(table, col, val, amount) {
    const r = await pool.query(
        `UPDATE ${table} SET status='Used'
         WHERE ${col}=$1 AND tx_type='Received' AND status='Unused' AND ref_no IS NOT NULL AND ABS(amount-$2) < 0.001
         RETURNING amount, ref_no, sender_name`, [val, amount]);
    return r.rows[0] || null;
}

async function whyNot(table, col, val, bank, expected) {
    const r = await pool.query(`SELECT tx_type, ref_no, status, amount FROM ${table} WHERE ${col}=$1`, [val]);
    if (!r.rows.length) return { status: 'Pending', bank };
    const tx = r.rows[0];
    if (tx.tx_type !== 'Received') return { status: 'Invalid_Transaction_Type', bank };
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

    // clients polling a not-yet-arrived payment: answer from memory for a few seconds
    const key = inp.type + ':' + inp.value + ':' + expected;
    const hit = pendCache.get(key);
    if (hit && Date.now() - hit.t < PEND_TTL) return res.json(hit.body);

    const isTb = inp.type === 'tb';
    const table = isTb ? 'telebirr_transactions' : 'cbe_transactions';
    const bank = isTb ? 'Telebirr' : 'CBE';
    let col = (inp.type === 'v2') ? 'v2_code' : 'ref_no';
    let val = inp.value;
    const done = (tx) => res.json({ status: 'Verified', bank, amount: parseFloat(tx.amount), ref_no: tx.ref_no, from_to: tx.sender_name });

    try {
        let tx = await tryUse(table, col, val, expected);
        if (tx) return done(tx);

        if (inp.type === 'v2') { // row missing or FT not stored yet: resolve the FT right now
            const r = await pool.query('SELECT id, ref_no FROM cbe_transactions WHERE v2_code=$1', [val]);
            if (!r.rows.length || !r.rows[0].ref_no) {
                const ft = await resolveFtNumber(val, 1);
                if (ft) {
                    if (r.rows.length) await settleFt(r.rows[0].id, ft).catch(() => {});
                    col = 'ref_no'; val = ft;
                    tx = await tryUse(table, col, val, expected);
                    if (tx) return done(tx);
                }
            }
        }
        const why = await whyNot(table, col, val, bank, expected);
        if (why.status === 'Pending' || why.status === 'Resolving') { pendCache.set(key, { t: Date.now(), body: why }); trim(pendCache, 500); }
        return res.json(why);
    } catch (err) {
        console.error(err);
        return res.status(500).json({ status: 'System_Busy' });
    }
});

// ================= 4. READ-ONLY CHECK (never changes anything) =================
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
    if (!auth(req, res)) return;
    const inp = parseVerifyInput(req.query.ref, req.query.sms || req.query.text);
    if (!inp) return res.json({ status: 'Missing_Ref' });
    try {
        const t = await locate(inp);
        const r = await pool.query(`SELECT * FROM ${t.table} WHERE ${t.col} = $1`, [t.val]);
        if (!r.rows.length) return res.json({ status: 'Not_Found', bank: t.bank, looked_for: t.val });
        const x = r.rows[0];
        const out = {
            status: x.ref_no ? 'Found' : 'Found_FT_Pending', bank: t.bank, type: x.tx_type, amount: parseFloat(x.amount),
            ref_no: x.ref_no, party: x.sender_name, usage: x.status, category: x.category || null,
            balance: x.balance != null ? parseFloat(x.balance) : null, v2_code: x.v2_code || null, created_at: x.created_at || null,
            agent_id: x.agent_id || null
        };
        if (req.query.live && t.bank === 'CBE' && (x.v2_code || inp.type === 'v2')) {
            try {
                const tg = cbeTargets(x.v2_code || inp.value)[0];
                const j = JSON.parse((await fetchHttps(tg.host, tg.path, tg.headers)).body);
                out.cbe_live = { ft: j.id, amount: j.debitAmount, from: j.debitAccountNo, to: j.creditAccountNo, date: j.debitValueDate,
                    amount_matches_db: Math.abs(parseFloat(j.debitAmount) - out.amount) < 0.001 };
            } catch (e) { out.cbe_live = { error: e.message }; }
        }
        return res.json(out);
    } catch (e) { console.error(e); return res.status(500).json({ status: 'Database_Error' }); }
});

app.get('/api/recent', async (req, res) => {
    if (!auth(req, res)) return;
    const n = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 100);
    try {
        const cols = 'id, tx_type, amount, ref_no, sender_name, status, category, balance, agent_id';
        const [c, t] = await Promise.all([
            pool.query(`SELECT ${cols}, v2_code, resolve_attempts FROM cbe_transactions ORDER BY id DESC LIMIT $1`, [n]),
            pool.query(`SELECT ${cols} FROM telebirr_transactions ORDER BY id DESC LIMIT $1`, [n])
        ]);
        return res.json({ status: 'OK', cbe: c.rows, telebirr: t.rows });
    } catch (e) { console.error(e); return res.status(500).json({ status: 'Database_Error' }); }
});

// ================= 5. AGENTS REPORTS (admin SECRET_TOKEN only) =================
app.get('/api/agents', async (req, res) => {
    if (!auth(req, res)) return;
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
    if (!auth(req, res)) return;
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

// health check: never touches the database (safe for UptimeRobot / Render pings)
app.get('/', (req, res) => res.json({ status: 'ok' }));

if (require.main === module) {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
        console.log(`Unified Gateway running on port ${PORT}`);
        scheduleResolve(5000); // one check at startup; keeps running only if rows are pending
    });
}
module.exports = { classify, extractAmount, extractBalance, extractTelebirrRef, extractParty, detectCategory, extractV2Code, extractDirectFt, parseVerifyInput };
