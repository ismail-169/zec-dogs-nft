const Database = require('better-sqlite3');
const DB_PATH = process.env.DATABASE_PATH || 'nfts.db';
const db = new Database(DB_PATH);

// This table holds the 5000 NFTs
db.exec(`
  CREATE TABLE IF NOT EXISTS nfts (
    id INTEGER PRIMARY KEY,
    filename TEXT,
    cid TEXT,
    mimeType TEXT,
    claimed BOOLEAN DEFAULT 0,
    
    -- Link to the session that claimed it
    session_id TEXT,
    
    -- Inscription tracking (NEW!)
    inscriptionTxid TEXT,
    inscribedAt DATETIME
  )
`);

// This table tracks payment intents and their status
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    
    -- A unique ID we give the user's browser
    session_uuid TEXT UNIQUE, 
    
    -- The exact, unique amount they must pay
    amount_due REAL UNIQUE NOT NULL, 
    
    -- 'pending', 'complete'
    status TEXT DEFAULT 'pending', 
    
    quantity INTEGER,
    
    -- The payment txid, once found
    payment_txid TEXT, 
    
    -- The CIDs we assigned, stored as a JSON string
    assigned_cids TEXT, 
    
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// This table is for the monitor scripts
db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  )
`);

// Create indexes for faster searching
db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_amount ON sessions(amount_due)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_uuid ON sessions(session_uuid)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_nfts_claimed ON nfts(claimed)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_nfts_cid ON nfts(cid)`);

console.log('✅ Database tables created successfully!');
db.close();