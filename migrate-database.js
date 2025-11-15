const Database = require('better-sqlite3');
const DB_PATH = process.env.DATABASE_PATH || 'nfts.db';

console.log('🔧 Running database migration for mempool monitoring...\n');

const db = new Database(DB_PATH);

try {
    // Check if column already exists
    const tableInfo = db.prepare("PRAGMA table_info(sessions)").all();
    const hasUpdatedAt = tableInfo.some(col => col.name === 'updated_at');
    
    if (hasUpdatedAt) {
        console.log('✅ Column "updated_at" already exists - no migration needed!');
    } else {
        // Add the updated_at column
        db.exec(`ALTER TABLE sessions ADD COLUMN updated_at DATETIME DEFAULT CURRENT_TIMESTAMP`);
        console.log('✅ Successfully added "updated_at" column to sessions table!');
        
        // Update existing rows
        db.exec(`UPDATE sessions SET updated_at = created_at WHERE updated_at IS NULL`);
        console.log('✅ Updated existing sessions with created_at timestamp');
    }
    
    // Display current session states
    console.log('\n📊 Current Session States:');
    const stats = db.prepare(`
        SELECT status, COUNT(*) as count 
        FROM sessions 
        GROUP BY status
    `).all();
    
    if (stats.length === 0) {
        console.log('   No sessions in database');
    } else {
        stats.forEach(stat => {
            console.log(`   ${stat.status}: ${stat.count}`);
        });
    }
    
    console.log('\n✅ Migration complete! You can now start the improved monitoring system.');
    
} catch (err) {
    console.error('❌ Migration failed:', err.message);
    console.error(err.stack);
    process.exit(1);
} finally {
    db.close();
}