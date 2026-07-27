const { Pool } = require('pg');

const connUrl = 'postgresql://postgres:CFhjvBVp0a3IB7aM@db.vteiwlymkwrbznapmsbo.supabase.co:6543/postgres?pgbouncer=true';
const pool = new Pool({
  connectionString: connUrl,
  connectionTimeoutMillis: 5000,
});

pool.query('SELECT 1')
  .then(() => {
    console.log('Success 6543');
    process.exit(0);
  })
  .catch(err => {
    console.error('Failed 6543:', err.message);
    process.exit(1);
  });
