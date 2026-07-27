import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { Pool, type Pool as PgPool } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const url: string | undefined = process.env.SUPABASE_URL;
const key: string | undefined = process.env.SUPABASE_KEY;

if (!url || !key) {
  console.error('\n[ERROR] SUPABASE_URL dan SUPABASE_KEY wajib diisi di file .env\n');
  process.exit(1);
}
if (!url.startsWith('https://')) {
  console.error('\n[ERROR] SUPABASE_URL tidak valid. Harus diawali https://\n');
  process.exit(1);
}

const supabase: SupabaseClient = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
  realtime: { params: { eventsPerSecond: 10 } },
  db: { schema: 'public' },
});

let pgPool: PgPool | null = null;
const dbUrl = process.env.DATABASE_URL;
if (dbUrl) {
  const connUrl = dbUrl;
  const poolMax = Math.min(50, Math.max(2, parseInt(process.env.DB_POOL_MAX || '20', 10)));
  pgPool = new Pool({
    connectionString: connUrl,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
    max: poolMax,
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 30000,
    query_timeout: 15000,
    statement_timeout: 10000,
    allowExitOnIdle: false,
    family: 4,
  } as any);
  pgPool.on('error', (err: Error) => console.error('[DB POOL] Error:', err.message));
  pgPool.on('acquire', (_client: any) => {
    const poolSize = pgPool?.totalCount ?? 0;
    if (poolSize > poolMax * 0.8) {
      console.warn(`[DB POOL] Near capacity: ${poolSize}/${poolMax}`);
    }
  });
  setInterval(() => {
    pgPool?.query('SELECT 1').catch((err: Error) => console.error('[DB POOL] Health check fail:', err.message));
  }, 60000).unref();
  console.log(`[CONFIG] Direct pg pool siap. Max: ${poolMax} koneksi.`);
} else {
  console.log('[CONFIG] DATABASE_URL tidak tersedia — pg pool tidak dibuat.');
}

console.log('[CONFIG] Supabase client siap.');

export default supabase;
export { pgPool };
