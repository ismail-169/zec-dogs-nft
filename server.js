const express = require('express');
const Database = require('better-sqlite3');
const cors = require('cors');
const bodyParser = require('body-parser');
const crypto = require('crypto'); // We need this to generate session IDs

const app = express();
const DB_PATH = process.env.DATABASE_PATH || 'nfts.db';
const db = new Database(DB_PATH);

app.use(cors());
app.use(bodyParser.json());
app.use(express.static('public'));

const PRICE_PER_NFT = 0.005;
const PAYMENT_ADDRESS = 't1gU211G8Msqb6EYVtdnepjZsfonxd2RR8H';
const MAX_SUPPLY = 5000;

// ENDPOINT 1: Get Mint Progress (Same as before)
app.get('/mint-progress', (req, res) => {
  const minted = db.prepare('SELECT COUNT(*) as count FROM nfts WHERE claimed = 1 AND id <= ?').get(MAX_SUPPLY).count;
  res.json({
    total: MAX_SUPPLY,
    minted: minted,
    available: MAX_SUPPLY - minted,
    percentage: ((minted / MAX_SUPPLY) * 100).toFixed(2)
  });
});

// ENDPOINT 2: Create a new payment intent
app.post('/create-payment-intent', (req, res) => {
    const { quantity } = req.body;
    
    if (!quantity || quantity < 1 || quantity > 20) {
        return res.json({ error: 'Invalid quantity (must be 1-20).' });
    }

    // Check if sold out
    const minted = db.prepare('SELECT COUNT(*) as count FROM nfts WHERE claimed = 1 AND id <= ?').get(MAX_SUPPLY).count;
    if (minted + quantity > MAX_SUPPLY) {
        return res.json({ error: `Not enough NFTs left to mint ${quantity}.`});
    }

    // Generate a unique amount
    const basePrice = PRICE_PER_NFT * quantity;
    
    // Get the next available ID from the sessions table to use as a "salt"
    // This guarantees the amount is unique
    const result = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'sessions'").get();
    const nextId = (result ? result.seq : 0) + 1;
    
    // Add the salt (e.g., 0.00000001, 0.00000002)
    const uniqueAmount = basePrice + (nextId / 100000000.0);
    const sessionId = crypto.randomBytes(16).toString('hex');

    // Save this payment intent to the database
    try {
        db.prepare(
            'INSERT INTO sessions (session_uuid, amount_due, quantity, status) VALUES (?, ?, ?, ?)'
        ).run(sessionId, uniqueAmount, quantity, 'pending');
        
        // Send the unique details back to the user
        res.json({
            success: true,
            sessionId: sessionId,
            amount: uniqueAmount.toFixed(8), // Send 8 decimal places
            paymentAddress: PAYMENT_ADDRESS
        });

    } catch (e) {
        // This will fail if the amount_due is somehow not unique
        console.error(e);
        res.json({ error: 'Failed to generate unique payment, please try again.' });
    }
});

// ENDPOINT 3: Check the status of a payment
app.get('/check-payment-status/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    
    const session = db.prepare(
        'SELECT status, assigned_cids, quantity FROM sessions WHERE session_uuid = ?'
    ).get(sessionId);

    if (!session) {
        return res.json({ status: 'error', message: 'Invalid session.' });
    }

    if (session.status === 'complete') {
        res.json({
            status: 'complete',
            items: JSON.parse(session.assigned_cids), // Send the CIDs
            quantity: session.quantity
        });
    } else {
        res.json({ status: 'pending' }); // Tell the user to keep waiting
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});