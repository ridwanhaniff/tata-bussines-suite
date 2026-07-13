import 'reflect-metadata';
import dotenv from 'dotenv';
dotenv.config();

import http from 'http';
import { Server } from 'socket.io';
import path from 'path';
import app from './app';
import supabase, { pgPool } from './config/supabase';
import { state, addLog, setIO, setSupabase } from './config/state';
import { PORT, SESSION_BASE_DIR } from './config/constants';
import { initWhatsApp, safeDestroyClient, setIOref, healthCheck } from './services/whatsapp';
import { sendEmergencyBroadcast } from './services/emergency';
import { resetBootStatus, restoreSessionDirFromDB } from './services/session-persistence';
import { buildSessionMiddleware } from './config/session';
import { initSchedulers } from './jobs/scheduler';

setSupabase(supabase);

// Fix Supabase schema permissions — bypass PostgREST schema denial
if (pgPool) {
  pgPool
    .query(
      `
    GRANT USAGE ON SCHEMA public TO service_role, anon, authenticated;
    GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
    GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;
    GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE ON SEQUENCES TO service_role, anon, authenticated;
  `,
    )
    .then(() => addLog('info', '[DB] Schema & sequence permissions granted'))
    .catch((err: Error) => addLog('warn', `[DB] Schema grant (non-fatal): ${err.message}`));
}

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 60000,
  pingInterval: 25000,
});

const sessionMiddleware = buildSessionMiddleware();
io.use((socket, next) => {
  sessionMiddleware(socket.request as any, {} as any, next as any);
});

io.on('connection', (socket) => {
  socket.on('register_user', (userId: string) => {
    if (userId) socket.join(userId);
  });
  socket.emit('status', {
    botStatus: state.botStatus,
    clientReady: state.clientReady,
    currentQR: state.currentQR,
    pairingCode: state.pairingCode,
  });
  socket.emit('bot_update', {
    botStatus: state.botStatus,
    clientReady: state.clientReady,
    currentQR: state.currentQR,
    pairingCode: state.pairingCode,
  });
  socket.on('wa_restart', async () => {
    addLog('info', '[SOCKET] Manual restart requested');
    await safeDestroyClient();
    state.waRetryCount = 0;
    setTimeout(() => initWhatsApp(), 2000);
  });
  socket.on('session_reset', async () => {
    addLog('info', '[SOCKET] Full session reset requested');
    await safeDestroyClient();
    const fs = await import('fs');
    if (fs.existsSync(SESSION_BASE_DIR)) {
      try {
        fs.rmSync(SESSION_BASE_DIR, { recursive: true, force: true });
      } catch {
        /* empty */
      }
    }
    await supabase.from('wa_session_backup').delete().eq('user_id', 'default');
    state.waRetryCount = 0;
    setTimeout(() => initWhatsApp(), 2000);
  });
});

setIOref(io);

process.on('uncaughtException', async (err) => {
  addLog('error', `uncaughtException: ${err.message}`);
  console.error('[FATAL] uncaughtException:', err.stack);
  await sendEmergencyBroadcast(`Uncaught exception — ${err.message}`);
  setTimeout(() => process.exit(1), 5000);
});

process.on('unhandledRejection', async (reason) => {
  addLog('error', `unhandledRejection: ${reason || 'No reason'}`);
  await sendEmergencyBroadcast(`Unhandled rejection — ${reason}`);
  setTimeout(() => process.exit(1), 5000);
});

const shutdown = async (signal: string) => {
  console.log(`\n[SYSTEM] Menerima sinyal ${signal}. Menutup proses...`);
  await sendEmergencyBroadcast(`Server shutdown — signal: ${signal}`);
  try {
    if (state.waClient) await state.waClient.destroy();
  } catch {
    /* empty */
  } finally {
    process.exit(0);
  }
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

server.listen(PORT, async () => {
  addLog('info', `[SYSTEM] Server started on port ${PORT}`);

  // Run pending migrations before accepting real traffic
  if (pgPool) {
    try {
      await pgPool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS default_channel text NOT NULL DEFAULT ''`);
      addLog('info', '[DB] Column products.default_channel added (if missing)');
    } catch (err: any) {
      addLog('warn', `[DB] Add default_channel (non-fatal): ${err.message}`);
    }
    try {
      // Prevent duplicate product names per user
      await pgPool.query(
        `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uq_products_user_name') THEN ALTER TABLE products ADD CONSTRAINT uq_products_user_name UNIQUE (user_id, name); END IF; END $$`,
      );
      addLog('info', '[DB] Constraint uq_products_user_name added (if missing)');
    } catch (err: any) {
      addLog('warn', `[DB] Add uq_products_user_name (non-fatal): ${err.message}`);
    }
    try {
      await pgPool.query(
        `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uq_users_store_name') THEN ALTER TABLE users ADD CONSTRAINT uq_users_store_name UNIQUE (store_name); END IF; END $$`,
      );
      addLog('info', '[DB] Constraint uq_users_store_name added (if missing)');
    } catch (err: any) {
      addLog('warn', `[DB] Add uq_users_store_name (non-fatal): ${err.message}`);
    }
    try {
      await pgPool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS image_url text`);
      addLog('info', '[DB] Column products.image_url added (if missing)');
    } catch (err: any) {
      addLog('warn', `[DB] Add image_url (non-fatal): ${err.message}`);
    }
    try {
      await pgPool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS channels text[] DEFAULT '{}'`);
      addLog('info', '[DB] Column products.channels added (if missing)');
    } catch (err: any) {
      addLog('warn', `[DB] Add channels (non-fatal): ${err.message}`);
    }
  }

  // Best-effort: create product-images bucket at startup
  try {
    const { data: buckets } = await supabase.storage.listBuckets();
    if (!buckets?.some((b: any) => b.name === 'product-images')) {
      await supabase.storage.createBucket('product-images', { public: true });
      addLog('info', '[STORAGE] Bucket product-images created');
    }
  } catch (err: any) {
    addLog(
      'warn',
      `[STORAGE] Bucket product-images setup (non-fatal): ${err.message}. Buat manual di Supabase dashboard jika perlu.`,
    );
  }

  resetBootStatus();

  // Verify /data writability + detect mount type for persistent storage
  try {
    const fs = await import('fs');
    const testFile = '/data/.write-test';
    fs.writeFileSync(testFile, 'ok');
    fs.unlinkSync(testFile);
    addLog('info', '[STORAGE] /data writable — data akan persist antar restart.');

    // Best-effort mount type detection
    let mountType: string | null = null;
    try {
      const procMounts = fs.readFileSync('/proc/mounts', 'utf8');
      const dataLines = procMounts.split('\n').filter((l: string) => l.includes(' /data ') || l.endsWith(' /data'));
      if (dataLines.length > 0) {
        const fields = dataLines[0].split(/\s+/);
        mountType = fields[2] || null;
        addLog('info', `[STORAGE] /data mount info: ${dataLines[0].trim()}`);
      }
    } catch {
      try {
        const { execSync } = require('child_process');
        const mountOut = execSync('mount | grep " /data "', { timeout: 5000, encoding: 'utf8' });
        if (mountOut.trim()) {
          addLog('info', `[STORAGE] /data mount info: ${mountOut.trim()}`);
          if (mountOut.includes(' type ')) {
            const m = mountOut.match(/ type (\S+)/);
            if (m) mountType = m[1];
          }
        }
      } catch {
        /* no permission for mount read */
      }
    }

    if (mountType) {
      const lower = mountType.toLowerCase();
      if (lower.includes('nfs') || lower.includes('fuse')) {
        addLog(
          'warn',
          '[STORAGE] /data terindikasi mount NFS/FUSE (kemungkinan Storage Bucket) — ada risiko file-locking/corruption untuk sesi Chromium whatsapp-web.js pada penggunaan intensif jangka panjang. Pertimbangkan Persistent Storage disk klasik untuk /data, dan gunakan bucket khusus untuk backup, bukan sesi live.',
        );
      } else {
        addLog(
          'info',
          `[STORAGE] /data filesystem type: ${mountType}${lower.includes('ext') || lower.includes('btrfs') || lower.includes('xfs') ? ' — disk klasik, aman untuk sesi WhatsApp.' : ''}`,
        );
      }
    } else {
      addLog(
        'warn',
        '[STORAGE] Tidak dapat dipastikan jenis storage /data — perlu verifikasi manual di Space Settings.',
      );
    }
  } catch {
    addLog(
      'warn',
      '[STORAGE] /data tidak writable — Persistent Storage kemungkinan BELUM aktif di Space Settings. Sesi WhatsApp akan hilang saat restart!',
    );
  }

  restoreSessionDirFromDB('default').finally(() => {
    initWhatsApp();
  });
  initSchedulers(addLog);
  setInterval(healthCheck, 30_000);
});
