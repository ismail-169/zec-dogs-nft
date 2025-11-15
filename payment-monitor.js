const axios = require('axios');
const Database = require('better-sqlite3');
const DB_PATH = process.env.DATABASE_PATH || 'nfts.db';
const db = new Database(DB_PATH);

const PAYMENT_ADDRESS = 't1gU211G8Msqb6EYVtdnepjZsfonxd2RR8H';
const MAX_SUPPLY = 5000;
const SCAN_INTERVAL_MS = 120000; // 2 minutes
const BLOCK_PAUSE_MS = 250;

// 5 GETBLOCK FREE TIER APIS - READY TO USE!
const API_ENDPOINTS = [
    {
        name: 'zec-c532b',
        url: 'https://go.getblock.io/c532b1037c924be386735ccbcd2f3afa',
        dailyLimit: 50000,
        cuUsedToday: 0,
        lastReset: new Date().toDateString(),
        enabled: true,
        failCount: 0
    },
    {
        name: 'zec-cacd8',
        url: 'https://go.getblock.io/cacd8cc301134aa6b4815883955b230d',
        dailyLimit: 50000,
        cuUsedToday: 0,
        lastReset: new Date().toDateString(),
        enabled: true,
        failCount: 0
    },
    {
        name: 'zec-3f3c1',
        url: 'https://go.getblock.io/3f3c14fa367842f988b5d10b912bf275',
        dailyLimit: 50000,
        cuUsedToday: 0,
        lastReset: new Date().toDateString(),
        enabled: true,
        failCount: 0
    },
    {
        name: 'zec-7f77d',
        url: 'https://go.getblock.io/7f77d2bce9c14f97abe6f1b0c3b7c444',
        dailyLimit: 50000,
        cuUsedToday: 0,
        lastReset: new Date().toDateString(),
        enabled: true,
        failCount: 0
    },
    {
        name: 'zec-42851',
        url: 'https://go.getblock.io/42851929b20140a2b6f4f3f70e99d323',
        dailyLimit: 50000,
        cuUsedToday: 0,
        lastReset: new Date().toDateString(),
        enabled: true,
        failCount: 0
    }
];

// Adaptive settings
let MEMPOOL_SCAN_INTERVAL_MS = 120000; // Start at 2 minutes
const MAX_MEMPOOL_TXS_TO_CHECK = 150; // Balanced setting for 5 APIs

let pendingPayments = new Map();
let recentlyCheckedTxs = new Set();

/**
 * Smart API selector - chooses best available API
 */
function selectBestApi() {
    const today = new Date().toDateString();
    
    // Reset daily counters if new day
    API_ENDPOINTS.forEach(api => {
        if (api.lastReset !== today) {
            api.cuUsedToday = 0;
            api.lastReset = today;
            api.failCount = 0;
            api.enabled = true;
            console.log(`📅 Reset daily counter for ${api.name}`);
        }
    });
    
    // Find APIs with available capacity
    const availableApis = API_ENDPOINTS.filter(api => 
        api.enabled && 
        api.cuUsedToday < api.dailyLimit * 0.9 && // Keep 10% buffer
        api.failCount < 3
    );
    
    if (availableApis.length === 0) {
        console.error('❌ ALL APIs exhausted or disabled!');
        console.error('   This should not happen with 5 APIs (250K CU/day total)');
        console.error('   Check your usage patterns or add more APIs');
        return null;
    }
    
    // Select API with most remaining capacity
    const bestApi = availableApis.reduce((best, current) => {
        const bestRemaining = best.dailyLimit - best.cuUsedToday;
        const currentRemaining = current.dailyLimit - current.cuUsedToday;
        return currentRemaining > bestRemaining ? current : best;
    });
    
    return bestApi;
}

/**
 * Enhanced RPC call with multi-API support
 */
async function rpcCall(method, params, estimatedCU = 10) {
    const maxRetries = API_ENDPOINTS.length;
    
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        const api = selectBestApi();
        
        if (!api) {
            console.error('❌ No available APIs - waiting for daily reset');
            return null;
        }
        
        try {
            const response = await axios.post(api.url, {
                jsonrpc: '2.0',
                method: method,
                params: params,
                id: 1
            }, { timeout: 10000 });
            
            if (response.data.error) {
                console.error(`RPC Error on ${api.name}:`, response.data.error.message);
                api.failCount++;
                
                // Try next API
                continue;
            }
            
            // Success! Update usage
            api.cuUsedToday += estimatedCU;
            api.failCount = 0; // Reset fail count on success
            
            // Log usage periodically (every ~1000 CU)
            if (api.cuUsedToday % 1000 < estimatedCU) {
                const remaining = api.dailyLimit - api.cuUsedToday;
                const percentUsed = ((api.cuUsedToday / api.dailyLimit) * 100).toFixed(1);
                console.log(`📊 ${api.name}: ${api.cuUsedToday}/${api.dailyLimit} CU (${percentUsed}%) - ${remaining} remaining`);
            }
            
            return response.data.result;
            
        } catch (err) {
            console.error(`${api.name} failed: ${err.message}`);
            api.failCount++;
            
            // Disable API if too many failures
            if (api.failCount >= 3) {
                api.enabled = false;
                console.error(`❌ ${api.name} DISABLED after 3 failures`);
            }
            
            // Try next API
            continue;
        }
    }
    
    // All APIs failed
    console.error('❌ All APIs failed for this request');
    return null;
}

/**
 * Get total available capacity across all APIs
 */
function getTotalAvailableCapacity() {
    let total = 0;
    let enabled = 0;
    API_ENDPOINTS.forEach(api => {
        if (api.enabled) {
            enabled++;
            total += Math.max(0, api.dailyLimit - api.cuUsedToday);
        }
    });
    return { total, enabledApis: enabled };
}

/**
 * Adjust scan aggressiveness based on available API capacity
 */
function adjustScanSettings() {
    const { total: availableCU, enabledApis } = getTotalAvailableCapacity();
    const totalCapacity = enabledApis * 50000;
    const usagePercent = totalCapacity > 0 ? ((totalCapacity - availableCU) / totalCapacity) * 100 : 0;
    
    if (usagePercent > 80) {
        MEMPOOL_SCAN_INTERVAL_MS = 300000; // 5 minutes
        console.log(`⚠️  API capacity at ${usagePercent.toFixed(1)}% - slowing to 5min intervals`);
    } else if (usagePercent > 60) {
        MEMPOOL_SCAN_INTERVAL_MS = 180000; // 3 minutes
    } else if (usagePercent > 40) {
        MEMPOOL_SCAN_INTERVAL_MS = 120000; // 2 minutes
    } else {
        MEMPOOL_SCAN_INTERVAL_MS = 60000; // 1 minute
    }
}

function loadPendingPayments() {
    const sessions = db.prepare(
        'SELECT session_uuid, amount_due, quantity FROM sessions WHERE status IN (?, ?)'
    ).all('pending', 'payment_pending');
    
    pendingPayments.clear();
    for (const session of sessions) {
        pendingPayments.set(session.amount_due.toFixed(8), {
            sessionId: session.session_uuid,
            quantity: session.quantity
        });
    }
    console.log(`Tracking ${pendingPayments.size} pending payments.`);
}

async function scanMempool() {
    if (pendingPayments.size === 0) {
        console.log('💭 No pending payments - skipping mempool scan');
        return;
    }

    console.log('\n💭 Scanning mempool for pending payments...');
    
    // Check available capacity before scanning
    const { total: availableCU, enabledApis } = getTotalAvailableCapacity();
    console.log(`📊 Available: ${availableCU} CU across ${enabledApis} APIs`);
    
    if (availableCU < 5000) {
        console.log('⚠️  Low API capacity - skipping mempool scan');
        return;
    }

    try {
        const mempoolTxids = await rpcCall('getrawmempool', [], 5);
        
        if (!mempoolTxids || mempoolTxids.length === 0) {
            console.log('   Mempool is empty.');
            return;
        }

        const uncheckedTxids = mempoolTxids.filter(txid => !recentlyCheckedTxs.has(txid));
        
        // Adjust how many to check based on available capacity
        const maxToCheck = Math.min(MAX_MEMPOOL_TXS_TO_CHECK, Math.floor(availableCU / 20));
        const txidsToCheck = uncheckedTxids.slice(0, maxToCheck);
        
        console.log(`   Checking ${txidsToCheck.length} transactions (${mempoolTxids.length} total in mempool)...`);

        let foundCount = 0;

        for (const txid of txidsToCheck) {
            const tx = await rpcCall('getrawtransaction', [txid, 1], 10);
            
            if (!tx || !tx.vout) {
                recentlyCheckedTxs.add(txid);
                continue;
            }

            for (const vout of tx.vout) {
                if (vout.scriptPubKey && vout.scriptPubKey.addresses?.includes(PAYMENT_ADDRESS)) {
                    const amountPaid = vout.value.toFixed(8);
                    
                    if (pendingPayments.has(amountPaid)) {
                        const session = pendingPayments.get(amountPaid);
                        
                        console.log(`\n💰 FOUND PENDING ZEC DOGS PAYMENT IN MEMPOOL!`);
                        console.log(`   Txid: ${txid}`);
                        console.log(`   Amount: ${amountPaid} ZEC`);
                        console.log(`   Session: ${session.sessionId}`);
                        
                        markPaymentPending(session.sessionId, txid, amountPaid);
                        foundCount++;
                    }
                }
            }

            recentlyCheckedTxs.add(txid);
            await new Promise(r => setTimeout(r, 100));
        }

        // Cleanup cache
        if (recentlyCheckedTxs.size > 500) {
            const txidsArray = Array.from(recentlyCheckedTxs);
            recentlyCheckedTxs = new Set(txidsArray.slice(-500));
        }

        console.log(`   ✅ Checked ${txidsToCheck.length} transactions, found ${foundCount} payments`);
        
        // Adjust settings for next scan
        adjustScanSettings();

    } catch (err) {
        console.error('Mempool scan error:', err.message);
    }
}

function markPaymentPending(sessionId, txid, amount) {
    try {
        const session = db.prepare('SELECT status FROM sessions WHERE session_uuid = ?').get(sessionId);
        
        if (!session) {
            console.error(`   ⚠️ Session ${sessionId} not found!`);
            return;
        }

        if (session.status === 'pending') {
            db.prepare(`
                UPDATE sessions 
                SET status = 'payment_pending', 
                    payment_txid = ?,
                    updated_at = CURRENT_TIMESTAMP
                WHERE session_uuid = ?
            `).run(txid, sessionId);
            
            console.log(`   ✅ Session marked as PAYMENT_PENDING (won't expire)`);
            console.log(`   ⏳ Waiting for confirmation...`);
        } else {
            console.log(`   ℹ️  Session already in '${session.status}' state`);
        }
    } catch (err) {
        console.error(`   ❌ Error: ${err.message}`);
    }
}

async function scanBlock(blockHeight) {
    const blockHash = await rpcCall('getblockhash', [blockHeight], 5);
    if (!blockHash) return;

    const block = await rpcCall('getblock', [blockHash, 2], 30);
    if (!block) return;

    console.log(`🔍 Scanning block ${blockHeight} (${block.tx.length} txs)...`);

    for (const tx of block.tx) {
        for (const vout of tx.vout) {
            if (vout.scriptPubKey.addresses?.includes(PAYMENT_ADDRESS)) {
                const amountPaid = vout.value.toFixed(8);
                
                if (pendingPayments.has(amountPaid)) {
                    console.log(`\n🎉 FOUND CONFIRMED ZEC DOGS PAYMENT!`);
                    console.log(`   Txid: ${tx.txid}`);
                    console.log(`   Amount: ${amountPaid} ZEC`);
                    console.log(`   Block: ${blockHeight}`);
                    
                    const session = pendingPayments.get(amountPaid);
                    fulfillOrder(session, tx.txid, amountPaid);
                    pendingPayments.delete(amountPaid);
                }
            }
        }
    }
}

function fulfillOrder(session, txid, amountPaid) {
    try {
        db.transaction(() => {
            const nfts = db.prepare(`
                SELECT cid FROM nfts 
                WHERE session_id = ? AND claimed = 0 AND id <= ?
            `).all(session.sessionId, MAX_SUPPLY);

            if (nfts.length < session.quantity) {
                console.error(`❌ Not enough NFTs for session ${session.sessionId}`);
                db.prepare('UPDATE nfts SET session_id = NULL WHERE session_id = ? AND claimed = 0')
                    .run(session.sessionId);
                db.prepare('UPDATE sessions SET status = ? WHERE session_uuid = ?')
                    .run('failed', session.sessionId);
                return;
            }

            const assignedCids = nfts.map(n => n.cid);
            db.prepare('UPDATE sessions SET status = ?, payment_txid = ?, assigned_cids = ? WHERE session_uuid = ?')
                .run('complete', txid, JSON.stringify(assignedCids), session.sessionId);
            db.prepare('UPDATE nfts SET claimed = 1 WHERE session_id = ? AND claimed = 0')
                .run(session.sessionId);
            
            console.log(`   ✅ Order fulfilled: ${session.quantity} NFTs → Session ${session.sessionId}`);
            console.log(`   📦 Assigned CIDs: ${assignedCids.join(', ').substring(0, 100)}...`);
        })();
    } catch (err) {
        console.error(`❌ Fulfillment error: ${err.message}`);
        console.error(err.stack);
    }
}

async function monitorBlocks() {
    console.log('\n⏰ Running block scan...');
    loadPendingPayments();

    if (pendingPayments.size === 0) {
        console.log('No pending payments. Waiting...');
        return;
    }

    const currentHeight = await rpcCall('getblockcount', [], 5);
    if (!currentHeight) {
        console.log('Failed to get block height. Retrying later.');
        return;
    }

    let lastScannedRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('last_scanned_payment_block');
    if (!lastScannedRow) {
        const startHeight = currentHeight - 100;
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
        db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(height, 'last_scanned_payment_block');
        await new Promise(r => setTimeout(r, BLOCK_PAUSE_MS));
    }

    console.log(`\n✅ Block scan complete!`);
}

let mempoolInterval;

async function start() {
    console.log('🚀 Starting ZEC DOGS Payment Monitor (5-API SYSTEM)...');
    console.log('💰 Payment Address:', PAYMENT_ADDRESS);
    console.log(`🔄 Using ${API_ENDPOINTS.length} API endpoints`);
    console.log(`📊 Total capacity: ${API_ENDPOINTS.length * 50000} CU/day (250K!)`);
    console.log('');
    
    // Show API status
    API_ENDPOINTS.forEach((api, i) => {
        const status = api.enabled ? '✅' : '❌';
        console.log(`   ${status} ${api.name}: ${api.url.substring(0, 50)}...`);
    });
    console.log('');
    
    db.exec(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`);
    
    try {
        db.exec(`ALTER TABLE sessions ADD COLUMN updated_at DATETIME DEFAULT CURRENT_TIMESTAMP`);
        console.log('✅ Database schema updated');
    } catch (err) {
        // Column already exists
    }
    
    console.log('⏳ Running initial scans...\n');
    
    await monitorBlocks();
    await scanMempool();
    
    console.log('\n⚙️  Starting scheduled scans...');
    setInterval(monitorBlocks, SCAN_INTERVAL_MS);
    
    const startMempoolScans = () => {
        if (mempoolInterval) clearInterval(mempoolInterval);
        mempoolInterval = setInterval(scanMempool, MEMPOOL_SCAN_INTERVAL_MS);
        console.log(`⚙️  Mempool scan interval: ${MEMPOOL_SCAN_INTERVAL_MS / 1000}s`);
    };
    
    startMempoolScans();
    
    // Re-adjust interval every 5 minutes
    setInterval(() => {
        adjustScanSettings();
        startMempoolScans();
    }, 5 * 60 * 1000);
    
    console.log('\n✅ ZEC DOGS Payment Monitor is running!');
    console.log('📊 Monitoring payment sessions 24/7...\n');
}

start();