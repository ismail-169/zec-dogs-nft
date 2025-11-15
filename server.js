const express = require('express');
const Database = require('better-sqlite3');
const cors = require('cors');
const bodyParser = require('body-parser');
const crypto = require('crypto');

const app = express();
const DB_PATH = process.env.DATABASE_PATH || 'nfts.db';
const db = new Database(DB_PATH);

app.use(cors());
app.use(bodyParser.json());
app.use(express.static('public'));

const PRICE_PER_NFT = 0.005;
const PAYMENT_ADDRESS = 't1gU211G8Msqb6EYVtdnepjZsfonxd2RR8H';
const MAX_SUPPLY = 5000;
const SESSION_TIMEOUT_MINUTES = 5; // Sessions expire after 5 minutes

// Cleanup expired sessions on startup and periodically
function cleanupExpiredSessions() {
    try {
        db.transaction(() => {
            // Get expired sessions that never completed payment
            const expiredSessions = db.prepare(`
                SELECT session_uuid FROM sessions 
                WHERE status = 'pending' 
                AND datetime(created_at, '+${SESSION_TIMEOUT_MINUTES} minutes') < datetime('now')
            `).all();

            if (expiredSessions.length > 0) {
                console.log(`🧹 Cleaning up ${expiredSessions.length} expired sessions...`);
                
                // Release reserved NFTs
                const releaseStmt = db.prepare('UPDATE nfts SET session_id = NULL WHERE session_id = ? AND claimed = 0');
                
                // Delete expired sessions
                const deleteStmt = db.prepare('DELETE FROM sessions WHERE session_uuid = ?');
                
                for (const session of expiredSessions) {
                    releaseStmt.run(session.session_uuid);
                    deleteStmt.run(session.session_uuid);
                }
                
                console.log(`✅ Released ${expiredSessions.length} reserved NFT batches`);
            }
        })();
    } catch (err) {
        console.error('Error cleaning up sessions:', err);
    }
}

// Run cleanup on startup and every 1 minute
cleanupExpiredSessions();
setInterval(cleanupExpiredSessions, 1 * 60 * 1000);

// ENDPOINT 1: Get Mint Progress
app.get('/mint-progress', (req, res) => {
    try {
        const minted = db.prepare('SELECT COUNT(*) as count FROM nfts WHERE claimed = 1 AND id <= ?').get(MAX_SUPPLY).count;
        const reserved = db.prepare('SELECT COUNT(*) as count FROM nfts WHERE session_id IS NOT NULL AND claimed = 0 AND id <= ?').get(MAX_SUPPLY).count;
        
        res.json({
            total: MAX_SUPPLY,
            minted: minted,
            reserved: reserved,
            available: MAX_SUPPLY - minted - reserved,
            percentage: ((minted / MAX_SUPPLY) * 100).toFixed(2)
        });
    } catch (err) {
        console.error('Error getting mint progress:', err);
        res.status(500).json({ error: 'Failed to get mint progress' });
    }
});

// ENDPOINT 2: Create a new payment intent (WITH RACE CONDITION PROTECTION)
app.post('/create-payment-intent', (req, res) => {
    const { quantity } = req.body;
    
    if (!quantity || quantity < 1 || quantity > 20) {
        return res.json({ error: 'Invalid quantity (must be 1-20).' });
    }

    try {
        // Use a transaction to ensure atomicity and prevent race conditions
        const result = db.transaction(() => {
            // Check available NFTs (not claimed AND not reserved)
            const availableCount = db.prepare(`
                SELECT COUNT(*) as count 
                FROM nfts 
                WHERE claimed = 0 
                AND session_id IS NULL 
                AND id <= ?
            `).get(MAX_SUPPLY).count;
            
            if (availableCount < quantity) {
                throw new Error(`Only ${availableCount} NFTs remaining. Cannot mint ${quantity}.`);
            }

            // Generate unique amount INSIDE transaction to prevent duplicates
            const basePrice = PRICE_PER_NFT * quantity;
            const seqResult = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'sessions'").get();
            const nextId = (seqResult ? seqResult.seq : 0) + 1;
            const uniqueAmount = basePrice + (nextId / 100000000.0);
            const sessionId = crypto.randomBytes(16).toString('hex');

            // Insert session immediately
            db.prepare(`
                INSERT INTO sessions (session_uuid, amount_due, quantity, status) 
                VALUES (?, ?, ?, ?)
            `).run(sessionId, uniqueAmount, quantity, 'pending');
            
            // RESERVE the NFTs immediately by setting session_id
            // This prevents over-selling if multiple people try to mint at once
            db.prepare(`
                UPDATE nfts 
                SET session_id = ? 
                WHERE id IN (
                    SELECT id FROM nfts 
                    WHERE claimed = 0 
                    AND session_id IS NULL 
                    AND id <= ? 
                    ORDER BY RANDOM()
                    LIMIT ?
                )
            `).run(sessionId, MAX_SUPPLY, quantity);
            
            // Verify we actually reserved the right amount
            const reservedCount = db.prepare(
                'SELECT COUNT(*) as count FROM nfts WHERE session_id = ?'
            ).get(sessionId).count;
            
            if (reservedCount !== quantity) {
                throw new Error('Failed to reserve NFTs. Please try again.');
            }
            
            return { sessionId, uniqueAmount };
        })();
        
        console.log(`💳 Created payment session ${result.sessionId} for ${quantity} NFTs (${result.uniqueAmount.toFixed(8)} ZEC)`);
        
        res.json({
            success: true,
            sessionId: result.sessionId,
            amount: result.uniqueAmount.toFixed(8),
            paymentAddress: PAYMENT_ADDRESS
        });

    } catch (e) {
        console.error('Payment intent creation error:', e);
        res.json({ error: e.message || 'Failed to generate payment session.' });
    }
});

// ENDPOINT 3: Check the status of a payment
app.get('/check-payment-status/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    
    try {
        const session = db.prepare(`
            SELECT status, assigned_cids, quantity, created_at 
            FROM sessions 
            WHERE session_uuid = ?
        `).get(sessionId);

        if (!session) {
            return res.json({ status: 'error', message: 'Invalid session.' });
        }

        // Check if session has expired
        const createdAt = new Date(session.created_at);
        const now = new Date();
        const minutesElapsed = (now - createdAt) / (1000 * 60);
        
        if (session.status === 'pending' && minutesElapsed > SESSION_TIMEOUT_MINUTES) {
            return res.json({ 
                status: 'expired', 
                message: 'Payment session expired. Please start a new mint.' 
            });
        }

        if (session.status === 'complete') {
            // Parse assigned CIDs and format as objects for frontend
            const assignedCids = JSON.parse(session.assigned_cids);
            res.json({
                status: 'complete',
                items: assignedCids.map(cid => ({ cid })), // Format as objects
                quantity: session.quantity
            });
        } else {
            res.json({ status: 'pending' });
        }
    } catch (err) {
        console.error('Error checking payment status:', err);
        res.json({ status: 'error', message: 'Failed to check payment status.' });
    }
});

// ENDPOINT 4: Health check
app.get('/health', (req, res) => {
    try {
        // Test database connection
        db.prepare('SELECT 1').get();
        res.json({ status: 'healthy', timestamp: new Date().toISOString() });
    } catch (err) {
        res.status(500).json({ status: 'unhealthy', error: err.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Server running on port ${PORT}`);
    console.log(`📊 Monitoring ${MAX_SUPPLY} NFTs`);
    console.log(`💰 Price: ${PRICE_PER_NFT} ZEC per NFT`);
    console.log(`⏰ Session timeout: ${SESSION_TIMEOUT_MINUTES} minutes`);
});