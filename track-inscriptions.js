const axios = require('axios');
const Database = require('better-sqlite3');
const bs58 = require('bs58');
const DB_PATH = process.env.DATABASE_PATH || 'nfts.db';
const db = new Database(DB_PATH);

const GETBLOCK_URL = 'https://go.getblock.io/c532b1037c924be386735ccbcd2f3afa';
const MAX_SUPPLY = 5000;
const SCAN_INTERVAL_MS = 120000; // 2 minutes
const BLOCK_PAUSE_MS = 250; // Pause 250ms between each block

// --- FIX ---
// Load CIDs from the correct 'cid' column, not 'imageCid'
const collectionCids = db.prepare('SELECT cid FROM nfts WHERE id <= ?').all(MAX_SUPPLY).map(n => n.cid);
const cidSet = new Set(collectionCids);
console.log(`📋 Tracking ${cidSet.size} unique Zec Dogs CIDs`);

/**
 * Parses the hex data from a Zinc OP_RETURN to find an IPFS CID
 * @param {string} hexString - The hex data from scriptPubKey
 * @returns {string|null} - The extracted CID (Qm...) or null
 */
function parseZincInscription(hexString) {
    try {
        const hex = hexString.replace(/\s/g, '');
        const buffer = Buffer.from(hex, 'hex');

        // 7A = Zinc Magic Byte
        // 11 = Zinc Mint Op (from your test tx)
        // 00 = IPFS Content Protocol
        if (buffer[0] !== 0x7A || buffer[1] !== 0x11 || buffer[2] !== 0x00) {
            return null; // Not a Zinc IPFS mint
        }

        // Extract CID bytes (34 bytes for CIDv0, starting at offset 3)
        const cidBytes = buffer.slice(3, 37);

        // Convert to base58 (Qm... format)
        const cid = bs58.encode(cidBytes);
        return cid;

    } catch (err) {
        return null; // Error parsing
    }
}

/**
 * Makes an RPC call to the GetBlock API
 * @param {string} method - The RPC method (e.g., "getblockcount")
 * @param {Array} params - The parameters for the method
 * @returns {Promise<any>} - The result from the RPC call
 */
async function rpcCall(method, params) {
    try {
        const response = await axios.post(GETBLOCK_URL, {
            jsonrpc: '2.0',
            method: method,
            params: params,
            id: 1
        }, { timeout: 10000 }); // 10 second timeout

        if (response.data.error) {
            console.error('RPC Error:', response.data.error);
            return null;
        }
        return response.data.result;

    } catch (err) {
        console.error(`Request failed for ${method}:`, err.message);
        return null;
    }
}

/**
 * Scans a single block for Zec Dogs inscriptions
 * @param {number} blockHeight - The height of the block to scan
 */
async function scanBlock(blockHeight) {
    const blockHash = await rpcCall('getblockhash', [blockHeight]);
    if (!blockHash) {
        console.log(`- Failed to get hash for block ${blockHeight}`);
        return 0;
    }

    // Use verbosity 2 to get ALL transaction data in one call
    const block = await rpcCall('getblock', [blockHash, 2]);
    if (!block) {
        console.log(`- Failed to get block data for ${blockHeight}`);
        return 0;
    }

    console.log(`🔍 Scanning block ${blockHeight} (${block.tx.length} txs)...`);
    let found = 0;

    // Loop through all transactions LOCALLY (no API calls)
    for (const tx of block.tx) {
        for (const vout of tx.vout) {
            if (vout.scriptPubKey.type === 'nulldata') {
                const hex = vout.scriptPubKey.hex;
                const cid = parseZincInscription(hex);

                // Check if this CID is in our collection
                if (cid && cidSet.has(cid)) {
                    console.log(`\n🎉 FOUND ZEC DOGS INSCRIPTION!`);
                    console.log(`   Txid: ${tx.txid}`);
                    console.log(`   CID: ${cid}`);

                    // --- FIX ---
                    // Query using the correct 'cid' column
                    const nft = db.prepare('SELECT id, inscriptionTxid FROM nfts WHERE cid = ?').get(cid);
                    
                    if (nft && !nft.inscriptionTxid) {
                        // --- FIX ---
                        // Update using the correct 'cid' column
                        db.prepare('UPDATE nfts SET inscriptionTxid = ?, inscribedAt = CURRENT_TIMESTAMP WHERE cid = ?')
                          .run(tx.txid, cid);
                        console.log(`   ✅ Database updated for NFT #${nft.id}!`);
                        found++;
                    } else if (nft && nft.inscriptionTxid) {
                        console.log(`   ... (Already tracked)`);
                    }
                }
            }
        }
    }
    return found;
}

/**
 * Main monitoring loop
 */
async function monitorInscriptions() {
    console.log('\n⏰ Running scan...');
    const currentHeight = await rpcCall('getblockcount', []);
    if (!currentHeight) {
        console.log('Failed to get block height. Retrying later.');
        return;
    }

    // Get last scanned height from database
    let lastScannedRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('last_scanned_block');
    if (!lastScannedRow) {
        // Start from 100 blocks ago to catch recent inscriptions
        const startHeight = currentHeight - 100;
        db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)')
          .run('last_scanned_block', startHeight);
        lastScannedRow = { value: startHeight };
    }

    const startBlock = parseInt(lastScannedRow.value) + 1;

    if (startBlock > currentHeight) {
        console.log('📊 Already fully synced. Waiting for new blocks.');
        return;
    }
    
    console.log(`📊 Current block: ${currentHeight}`);
    console.log(`📊 Scanning from: ${startBlock}`);

    let totalFound = 0;
    for (let height = startBlock; height <= currentHeight; height++) {
        const found = await scanBlock(height);
        totalFound += found;

        // Save progress after every block
        db.prepare('UPDATE settings SET value = ? WHERE key = ?')
          .run(height, 'last_scanned_block');

        // Pause to be nice to the API
        await new Promise(r => setTimeout(r, BLOCK_PAUSE_MS));
    }

    console.log(`\n✅ Scan complete! Found ${totalFound} new Zec Dogs inscriptions.`);
}

/**
 * Main function to start the tracker
 */
async function start() {
    console.log('🚀 Starting Zec Dogs Inscription Tracker...');

    // Create settings table if it doesn't exist
    db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT
      )
    `);

    // Run the first scan immediately
    await monitorInscriptions();

    // Run again every 2 minutes
    setInterval(monitorInscriptions, SCAN_INTERVAL_MS);
}

start();