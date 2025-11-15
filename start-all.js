const { spawn } = require('child_process');
const fs = require('fs');

const DB_PATH = process.env.DATABASE_PATH || './nfts.db';
const PORT = process.env.PORT || 3000;

console.log('🚀 Starting Zec Dogs NFT Platform...');
console.log('📊 Database:', DB_PATH);
console.log('🌐 Port:', PORT);
console.log('');

// Check if database exists, if not create it
if (!fs.existsSync(DB_PATH)) {
    console.log('📦 First run - Setting up database...\n');
    
    const { execSync } = require('child_process');
    
    try {
        execSync('node setup-db.js', { stdio: 'inherit', env: { ...process.env, DATABASE_PATH: DB_PATH } });
        execSync('node import-nfts.js', { stdio: 'inherit', env: { ...process.env, DATABASE_PATH: DB_PATH } });
        console.log('\n✅ Database setup complete!\n');
    } catch (err) {
        console.error('❌ Setup failed:', err.message);
        process.exit(1);
    }
}

// Start all services
const services = [
    { name: 'Server', script: 'server.js', color: '\x1b[36m' },
    { name: 'Payment', script: 'payment-monitor.js', color: '\x1b[33m' },
    { name: 'Tracker', script: 'track-inscriptions.js', color: '\x1b[35m' }
];

services.forEach(service => {
    const proc = spawn('node', [service.script], {
        env: { ...process.env, DATABASE_PATH: DB_PATH, PORT: PORT }
    });
    
    proc.stdout.on('data', (data) => {
        console.log(`${service.color}[${service.name}]${'\x1b[0m'} ${data.toString().trim()}`);
    });
    
    proc.stderr.on('data', (data) => {
        console.error(`${service.color}[${service.name}]${'\x1b[0m'} ${data.toString().trim()}`);
    });
    
    proc.on('close', (code) => {
        console.log(`${service.color}[${service.name}]${'\x1b[0m'} Exited with code ${code}`);
        if (code !== 0) {
            console.log('⚠️ Service crashed, but others continue running');
        }
    });
});

console.log('✅ All services started!\n');