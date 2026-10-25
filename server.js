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

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors());

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

const CBE_HEADERS = {
    'X-App-ID': 'd1292e42-7400-49de-a2d3-9731caa4c819',
    'X-App-Version': '0a01980b-9859-1369-8198-59f403820000',
    'Accept': 'application/json',
    'User-Agent': 'Mozilla/5.0'
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

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

// every known way to turn a v2 receipt code into an FT number
function cbeTargets(code) {
    const raw = code.replace(/^v2-/i, '');
    const enc = encodeURIComponent;
    return [
        { name: 'api-raw',   host: 'mb.cbe.com.et', path: `/api/v1/transactions/public/transaction-detail/${enc(raw)}`, headers: CBE_HEADERS },
        { name: 'api-v2',    host: 'mb.cbe.com.et', path: `/api/v1/transactions/public/transaction-detail/${enc('v2-' + raw)}`, headers: CBE_HEADERS },
        { name: 'receipt-page', host: 'mbreciept.cbe.com.et', path: `/${enc('v2-' + raw)}`, headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'text/html,application/json' } }
    ];
}

// returns FT number or null (never returns the v2 code)
async function resolveFtNumber(v2Code, attempts = 1) {
    if (!v2Code) return null;
    for (let i = 0; i < attempts; i++) {
        for (const t of cbeTargets(v2Code)) {
            try {
                const r = await fetchHttps(t.host, t.path, t.headers);
                const m = r.body.match(/\b(FT[A-Z0-9]{8,15})\b/i);
                if (m) return m[1].toUpperCase();
                console.log(`CBE ${t.name} -> HTTP ${r.status}, no FT in body (${r.body.length} bytes)`);
            } catch (e) { console.log(`CBE ${t.name} failed: ${e.message}`); }
        }
        if (i < attempts - 1) await sleep(1500);
    }
    return null;
}

// ---------- background resolver for CBE rows still waiting for FT ----------
let resolverBusy = false;
async function settleFt(id, ft) {
    try {
        await pool.query('UPDATE cbe_transactions SET ref_no=$1 WHERE id=$2 AND ref_no IS NULL', [ft, id]);
        return 'Resolved';
    } catch (e) {
        if (e.code === '23505') { // FT already stored (duplicate SMS) -> drop the pending twin
            await pool.query('DELETE FROM cbe_transactions WHERE id=$1 AND ref_no IS NULL', [id]);
            return 'Duplicate';
        }
        throw e;
    }
}
async function resolvePending() {
    if (resolverBusy) return;
    resolverBusy = true;
    try {
        const { rows } = await pool.query(
            `SELECT id, v2_code FROM cbe_transactions
             WHERE ref_no IS NULL AND v2_code IS NOT NULL AND COALESCE(resolve_attempts,0) < 40
             ORDER BY id LIMIT 10`);
        for (const row of rows) {
            const ft = await resolveFtNumber(row.v2_code, 1);
            if (ft) await settleFt(row.id, ft);
            else await pool.query('UPDATE cbe_transactions SET resolve_attempts = COALESCE(resolve_attempts,0)+1 WHERE id=$1', [row.id]);
        }
    } catch (e) { console.error('resolver:', e.message); }
    finally { resolverBusy = false; }
}

function auth(req, res) {
    if (req.query.token !== SECRET_TOKEN) { res.status(401).json({ status: 'Unauthorized' }); return false; }
    return true;
}

// ================= 1. SMS WEBHOOK =================
app.get('/webhook/sms', async (req, res) => {
    if (!auth(req, res)) return;
    const { message } = req.query;
    if (!message) return res.status(400).json({ status: 'Error', message: 'No SMS provided' });

    const c = classify(message, req.query.sender);
    if (!c.isIncoming && !c.isOutgoing) return res.json({ status: 'Ignored', reason: 'Not a payment SMS' });

    const amount = extractAmount(c.msg);
    const balance = extractBalance(c.msg);
    const party = extractParty(c.msg, c.isIncoming, c.bank);
    const category = detectCategory(c.msg, c.isIncoming);
    let ref = null, v2 = null;

    if (c.isCbe) {
        ref = extractDirectFt(c.msg);
        v2 = extractV2Code(c.msg);
        if (!ref && v2) ref = await resolveFtNumber(v2, 1); // one quick try; the rest runs in background
        if (!ref && !v2) ref = 'CBE-' + crypto.createHash('sha1').update(c.msg).digest('hex').slice(0, 12).toUpperCase(); // no FT/link (ATM, fees): stable key from the SMS text
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
                `INSERT INTO cbe_transactions (tx_type, sender_name, amount, ref_no, raw_sms, status, category, balance, v2_code)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING RETURNING id`,
                [txType, party, amount, ref, c.msg, status, category, balance, v2]);
        } else {
            result = await pool.query(
                `INSERT INTO telebirr_transactions (tx_type, sender_name, amount, ref_no, raw_sms, status, category, balance)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING RETURNING id`,
                [txType, party, amount, ref, c.msg, status, category, balance]);
        }
        if (result.rows.length === 0) return res.json({ status: 'Duplicate', bank: c.bank, ref: ref || v2 });
        if (c.isCbe && !ref) {
            setTimeout(resolvePending, 3000);
            return res.json({ status: 'Saved', bank: c.bank, type: txType, amount, ref: null, resolving: true, v2 });
        }
        return res.json({ status: 'Saved', bank: c.bank, type: txType, category, ref, amount });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ status: 'Database_Error' });
    }
});

// ================= 2. CBE manual FT / pending list =================
// Paste the FT from the CBE app: /api/cbe/resolve?token=..&v2=<code or full link>&ft=FT26298NXW57
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
            `SELECT id, v2_code, amount, sender_name, COALESCE(resolve_attempts,0) AS attempts
             FROM cbe_transactions WHERE ref_no IS NULL ORDER BY id DESC LIMIT 50`);
        return res.json({ status: 'OK', count: r.rows.length, items: r.rows });
    } catch (e) { console.error(e); return res.status(500).json({ status: 'Database_Error' }); }
});

// Diagnose the CBE lookup: /api/cbe/debug?token=..&v2=<code or link>
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
// ref = FT | v2 code | receipt link | Telebirr ref   (or sms = the full SMS text)
app.get('/api/verify', async (req, res) => {
    if (!auth(req, res)) return;
    const inp = parseVerifyInput(req.query.ref, req.query.sms || req.query.text);
    if (!inp) return res.json({ status: 'Missing_Ref' });
    let expectedAmount = parseFloat(req.query.amount);
    if (isNaN(expectedAmount) && inp.amount) expectedAmount = inp.amount;
    if (isNaN(expectedAmount) || expectedAmount <= 0) return res.json({ status: 'Missing_Amount' });

    let table, col, val, bankName;
    try {
        if (inp.type === 'tb') { table = 'telebirr_transactions'; col = 'ref_no'; val = inp.value; bankName = 'Telebirr'; }
        else {
            table = 'cbe_transactions'; bankName = 'CBE';
            if (inp.type === 'ft') { col = 'ref_no'; val = inp.value; }
            else { // v2: use the stored row, or resolve the FT right now
                col = 'v2_code'; val = inp.value;
                const r = await pool.query('SELECT id, ref_no FROM cbe_transactions WHERE v2_code=$1', [val]);
                if (!r.rows.length || !r.rows[0].ref_no) {
                    const ft = await resolveFtNumber(val, 1);
                    if (ft) {
                        if (r.rows.length) await settleFt(r.rows[0].id, ft).catch(() => {});
                        col = 'ref_no'; val = ft;
                    }
                }
            }
        }
    } catch (e) { console.error(e); return res.status(500).json({ status: 'System_Busy' }); }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await client.query(`SELECT * FROM ${table} WHERE ${col} = $1 FOR UPDATE`, [val]);
        if (result.rows.length === 0) { await client.query('ROLLBACK'); return res.json({ status: 'Pending', bank: bankName }); }
        const tx = result.rows[0];
        if (tx.tx_type !== 'Received') { await client.query('ROLLBACK'); return res.json({ status: 'Invalid_Transaction_Type', bank: bankName }); }
        if (!tx.ref_no) { await client.query('ROLLBACK'); return res.json({ status: 'Resolving', bank: bankName }); }
        if (tx.status !== 'Unused') { await client.query('ROLLBACK'); return res.json({ status: 'AlreadyUsed', bank: bankName }); }
        const actualAmount = parseFloat(tx.amount);
        if (Math.abs(actualAmount - expectedAmount) > 0.001) {
            await client.query('ROLLBACK');
            return res.json({ status: 'InvalidAmount', expected: expectedAmount, actual: actualAmount, bank: bankName });
        }
        await client.query(`UPDATE ${table} SET status = 'Used' WHERE id = $1`, [tx.id]);
        await client.query('COMMIT');
        return res.json({ status: 'Verified', bank: bankName, amount: actualAmount, ref_no: tx.ref_no, from_to: tx.sender_name });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error(err);
        return res.status(500).json({ status: 'System_Busy' });
    } finally {
        client.release();
    }
});

app.get('/', (req, res) => res.json({ status: 'ok' }));

if (require.main === module) {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
        console.log(`Unified Gateway running on port ${PORT}`);
        setInterval(resolvePending, 20000);
        setTimeout(resolvePending, 5000);
    });
}
module.exports = { classify, extractAmount, extractBalance, extractTelebirrRef, extractParty, detectCategory, extractV2Code, extractDirectFt, parseVerifyInput };
