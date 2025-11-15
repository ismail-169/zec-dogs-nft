const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DB_PATH = process.env.DATABASE_PATH || 'nfts.db';
const db = new Database(DB_PATH);

let nfts;

// Try environment variable first (for Railway)
if (process.env.NFTS_DATA_BASE64) {
    console.log('📦 Loading NFTs from environment variable...');
    const buffer = Buffer.from(process.env.NFTS_DATA_BASE64, 'base64');
    nfts = JSON.parse(buffer.toString('utf8'));
} else {
    // Try file locations (for local dev)
    const possiblePaths = [
        path.join(__dirname, 'data', 'nfts.json'),
        path.join(__dirname, '..', 'pinata-upload', 'nfts.json')
    ];
    
    let nftsPath;
    for (const p of possiblePaths) {
        if (fs.existsSync(p)) {
            nftsPath = p;
            break;
        }
    }
    
    if (!nftsPath) {
        console.error('❌ ERROR: nfts.json not found!');
        process.exit(1);
    }
    
    console.log('📂 Loading NFTs from:', nftsPath);
    nfts = JSON.parse(fs.readFileSync(nftsPath, 'utf8'));
}

const stmt = db.prepare('INSERT INTO nfts (id, filename, cid, mimeType, claimed) VALUES (?, ?, ?, ?, 0)');

const insertMany = db.transaction((nfts) => {
  let importedCount = 0;
  for (const nft of nfts) {
    if (nft.id <= 5000) {
        stmt.run(nft.id, nft.filename, nft.cid, nft.mimeType);
        importedCount++;
    }
  }
  return importedCount;
});

const count = insertMany(nfts);

console.log(`✅ Imported ${count} NFTs!`);
db.close();