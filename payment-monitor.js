const axios = require('axios');
const Database = require('better-sqlite3');
const bs58 = require('bs58'); // Keep for parsing if needed, though not for payment
const DB_PATH = process.env.DATABASE_PATH || 'nfts.db';
const db = new Database(DB_PATH);

const GETBLOCK_URL = 'https://go.getblock.io/c532b1037c924be386735ccbcd2f3afa';
const PAYMENT_ADDRESS = 't1gU211G8Msqb6EYVtdnepjZsfonxd2RR8H';
const MAX_SUPPLY = 5000;
const SCAN_INTERVAL_MS = 120000; // 2 minutes
const BLOCK_PAUSE_MS = 250;

// This object will hold all pending sessions: { "0.01501234": { sessionId, quantity } }
let pendingPayments = new Map();

/**
 * Loads all pending payment amounts from the DB into memory
 */
function loadPendingPayments() {
    console.log('Syncing pending payments from database...');
    const sessions = db.prepare('SELECT session_uuid, amount_due, quantity FROM sessions WHERE status = ?').all('pending');
    pendingPayments.clear();
    for (const session of sessions) {
        // Use a string key for the map to ensure exact matching
        pendingPayments.set(session.amount_due.toFixed(8), {
            sessionId: session.session_uuid,
            quantity: session.quantity
        });
    }
    console.log(`Tracking ${pendingPayments.size} pending payments.`);
}

async function rpcCall(method, params) {
    try {
        const response = await axios.post(GETBLOCK_URL, {
            jsonrpc: '2.0',
            method: method,
            params: params,
            id: 1
        }, { timeout: 10000 });
        if (response.data.error) {
            console.error('RPC Error:', response.data.error);
            return null;
        }
        return response.data.result;
    } catch (err) {
        return null;
    }
}

/**
 * Scans a single block for payments to our address
 */
async function scanBlock(blockHeight) {
    const blockHash = await rpcCall('getblockhash', [blockHeight]);
    if (!blockHash) return;

    const block = await rpcCall('getblock', [blockHash, 2]); // Verbosity 2 for full tx data
    if (!block) return;

    console.log(`🔍 Scanning block ${blockHeight} (${block.tx.length} txs)...`);

    // Loop through all transactions locally
    for (const tx of block.tx) {
        for (const vout of tx.vout) {
            // Check if payment was sent to our main address
            if (vout.scriptPubKey.addresses?.includes(PAYMENT_ADDRESS)) {
                
                const amountPaid = vout.value.toFixed(8);
                
                // Check if this amount matches a pending payment
                if (pendingPayments.has(amountPaid)) {
                    console.log(`\n🎉 FOUND ZEC DOGS PAYMENT!`);
                    console.log(`   Txid: ${tx.txid}`);
                    console.log(`   Amount: ${amountPaid} ZEC`);
                    
                    const session = pendingPayments.get(amountPaid);
                    
                    // Fulfill the order
                    fulfillOrder(session, tx.txid, amountPaid);
                    
                    // Remove from memory so it's not processed again
                    pendingPayments.delete(amountPaid);
                }
            }
        }
    }
}

/**
 * Fulfills an order: claims NFTs and updates the session
 */
function fulfillOrder(session, txid, amountPaid) {
    try {
        // Use a transaction for database integrity
        db.transaction(() => {
            // 1. Get random, unclaimed NFTs
            const nfts = db.prepare(
                'SELECT cid FROM nfts WHERE claimed = 0 AND id <= ? ORDER BY RANDOM() LIMIT ?'
            ).all(MAX_SUPPLY, session.quantity);

            if (nfts.length < session.quantity) {
                console.error(`✗ CRITICAL ERROR: Not enough NFTs left for session ${session.sessionId}. Refunding required.`);
                // In a real system, you'd flag this for a refund.
                return;
            }

            const assignedCids = nfts.map(n => n.cid);

            // 2. Update the session to 'complete'
            db.prepare(
                'UPDATE sessions SET status = ?, payment_txid = ?, assigned_cids = ? WHERE session_uuid = ?'
            ).run('complete', txid, JSON.stringify(assignedCids), session.sessionId);

            // 3. Mark the NFTs as 'claimed'
            const updateNftStmt = db.prepare('UPDATE nfts SET claimed = 1, session_id = ? WHERE cid = ?');
            for (const cid of assignedCids) {
                updateNftStmt.run(session.sessionId, cid);
            }
            
            console.log(`   ✅ Order for ${session.quantity} NFTs (Session ${session.sessionId}) fulfilled!`);
        })();

    } catch (err) {
        console.error(`✗ CRITICAL ERROR during fulfillment: ${err.message}`);
    }
}

/**
 * Main monitoring loop
 */
async function monitorPayments() {
    console.log('\n⏰ Running payment scan...');
    loadPendingPayments(); // Refresh pending payments list

    if (pendingPayments.size === 0) {
        console.log('No pending payments to track. Waiting...');
        return;
    }

    const currentHeight = await rpcCall('getblockcount', []);
    if (!currentHeight) {
        console.log('Failed to get block height. Retrying later.');
        return;
    }

    let lastScannedRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('last_scanned_payment_block');
    if (!lastScannedRow) {
        const startHeight = currentHeight - 100; // Start 100 blocks back
        db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)')
          .run('last_scanned_payment_block', startHeight);
        lastScannedRow = { value: startHeight };
    }

    const startBlock = parseInt(lastScannedRow.value) + 1;
    
    if (startBlock > currentHeight) {
        console.log('📊 Already fully synced. Waiting for new blocks.');
        return;
    }

    console.log(`📊 Current block: ${currentHeight}`);
    console.log(`📊 Scanning from: ${startBlock}`);
    
    for (let height = startBlock; height <= currentHeight; height++) {
        await scanBlock(height);
        db.prepare('UPDATE settings SET value = ? WHERE key = ?')
          .run(height, 'last_scanned_payment_block');
        await new Promise(r => setTimeout(r, BLOCK_PAUSE_MS));
    }

    console.log(`\n✅ Payment scan complete!`);
}

async function start() {
    console.log('🚀 Starting Zec Dogs Payment Monitor...');
    db.exec(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`);
    await monitorPayments();
    setInterval(monitorPayments, SCAN_INTERVAL_MS);
}

start();