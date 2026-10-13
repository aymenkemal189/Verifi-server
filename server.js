require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors());

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

const SECRET_TOKEN = process.env.SECRET_TOKEN || 'Verifi_Prod_9842_Aymen_X9!2026';

function extractAmount(msg) {
    const match = msg.match(/(?:received|transferred|paid)\s+(?:ETB|Birr)\s*([0-9,]+(?:\.[0-9]{1,2})?)/i) 
               || msg.match(/(?:received|transferred|paid)\s+([0-9,]+(?:\.[0-9]{1,2})?)\s*(?:ETB|Birr)/i);
    return match ? parseFloat(match[1].replace(/,/g, '')) : 0;
}

function extractRef(msg) {
    const match = msg.match(/transaction\s*(?:number|no|id)\s*(?:is)?[\s:]*([A-Z0-9]{10,12})\b/i);
    return match ? match[1].toUpperCase() : null;
}

function extractSender(msg, isIncoming) {
    const m = isIncoming ? msg.match(/from\s+([^(]+)\(/i) : msg.match(/to\s+([^(]+)\(/i);
    return m ? m[1].trim() : (isIncoming ? 'Telebirr Sender' : 'Telebirr Receiver');
}

// 1. MACRODROID SMS መቀበያ
app.get('/webhook/sms', async (req, res) => {
    const { token, message } = req.query;

    if (token !== SECRET_TOKEN) return res.status(401).json({ status: 'Unauthorized' });
    if (!message) return res.status(400).json({ status: 'Error', message: 'No SMS provided' });

    const msg = message.replace(/\r?\n/g, " ").trim();
    const isIncoming = /you have received/i.test(msg);
    const isOutgoing = /you have transferred|you have paid/i.test(msg);

    if (!isIncoming && !isOutgoing) return res.json({ status: 'Ignored' });

    const amount = extractAmount(msg);
    const ref = extractRef(msg);
    const partyName = extractSender(msg, isIncoming);

    if (!amount || !ref) return res.json({ status: 'Ignored', reason: 'Missing Amount or Ref' });

    const txType = isIncoming ? 'Received' : 'Transferred';
    const initialStatus = isIncoming ? 'Unused' : 'Sent_Locked';

    try {
        const query = `
            INSERT INTO telebirr_transactions (tx_type, sender_name, amount, ref_no, raw_sms, status)
            VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT (ref_no) DO NOTHING
            RETURNING id;
        `;
        const values = [txType, partyName, amount, ref, msg, initialStatus];
        const result = await pool.query(query, values);

        if (result.rows.length === 0) return res.json({ status: 'Duplicate', ref });
        return res.json({ status: 'Saved', type: txType, ref, amount });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ status: 'Database_Error' });
    }
});

// 2. DASH BINGO ማረጋገጫ
app.get('/api/verify', async (req, res) => {
    const { token, ref, amount } = req.query;

    if (token !== SECRET_TOKEN) return res.status(401).json({ status: 'Unauthorized' });
    
    const expectedAmount = parseFloat(amount);
    const searchRef = (ref || '').trim().toUpperCase();

    if (!searchRef) return res.json({ status: 'Missing_Ref' });
    if (isNaN(expectedAmount) || expectedAmount <= 0) return res.json({ status: 'Missing_Amount' });

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        const checkQuery = `SELECT * FROM telebirr_transactions WHERE ref_no = $1 FOR UPDATE`;
        const result = await client.query(checkQuery, [searchRef]);

        if (result.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.json({ status: 'Pending' });
        }

        const tx = result.rows[0];

        if (tx.tx_type !== 'Received') {
            await client.query('ROLLBACK');
            return res.json({ status: 'Invalid_Transaction_Type' });
        }

        if (tx.status !== 'Unused') {
            await client.query('ROLLBACK');
            return res.json({ status: 'AlreadyUsed' });
        }

        const actualAmount = parseFloat(tx.amount);
        if (Math.abs(actualAmount - expectedAmount) > 0.001) {
            await client.query('ROLLBACK');
            return res.json({ status: 'InvalidAmount', expected: expectedAmount, actual: actualAmount });
        }

        const updateQuery = `UPDATE telebirr_transactions SET status = 'Used' WHERE id = $1`;
        await client.query(updateQuery, [tx.id]);

        await client.query('COMMIT');
        return res.json({ status: 'Verified', amount: actualAmount, ref_no: searchRef });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error(err);
        return res.status(500).json({ status: 'System_Busy' });
    } finally {
        client.release();
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
