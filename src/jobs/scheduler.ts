import cron from 'node-cron';
import os from 'os';
import path from 'path';
import fs from 'fs';
import supabase from '../config/supabase';
import { state } from '../config/state';
import * as stockManager from '../utils/stockManager';
import { formatRupiah } from '../utils/helpers';
import { SESSION_BASE_DIR } from '../config/constants';
import { runBackup } from './backup';

let _addLog: ((level: string, msg: string) => void) | null = null;
const logInfo = (...args: any[]) => {
  if (_addLog) _addLog('info', args.join(' '));
  else console.log(...args);
};
const logWarn = (...args: any[]) => {
  if (_addLog) _addLog('warn', args.join(' '));
  else console.warn(...args);
};
const logError = (...args: any[]) => {
  if (_addLog) _addLog('error', args.join(' '));
  else console.error(...args);
};

async function autoCleanCache(): Promise<void> {
  logInfo('[CACHE] Starting Chromium cache cleanup...');
  const sessionBaseDir = process.env.WA_SESSION_DIR || SESSION_BASE_DIR;
  const trashFolders = ['Cache', 'Code Cache', 'GPUCache', 'CacheStorage'];
  const protectedPatterns = [
    'IndexedDB',
    'Local Storage',
    'Session Storage',
    'Cookies',
    'Preferences',
    'Secure Preferences',
    'Local State',
    '.ldb',
  ];

  function getDirSize(dirPath: string): number {
    let size = 0;
    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        if (entry.isFile()) size += fs.statSync(fullPath).size;
        else if (entry.isDirectory()) size += getDirSize(fullPath);
      }
    } catch {
      /* ignore */
    }
    return size;
  }

  function cleanDir(dirPath: string, depth = 0): void {
    if (!fs.existsSync(dirPath) || depth > 5) return;
    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        if (protectedPatterns.some((p) => entry.name.includes(p))) continue;
        if (entry.isDirectory()) {
          if (trashFolders.includes(entry.name)) {
            try {
              const dirSize = getDirSize(fullPath);
              fs.rmSync(fullPath, { recursive: true, force: true });
              const mb = (dirSize / 1024 / 1024).toFixed(1);
              if (dirSize > 0) logInfo(`[CACHE] Deleted: ${entry.name} (${mb} MB)`);
            } catch (e: any) {
              logWarn(`[CACHE] Failed to delete ${entry.name}: ${e.message}`);
            }
          } else {
            cleanDir(fullPath, depth + 1);
          }
        }
      }
    } catch (err: any) {
      logWarn(`[CACHE] Error reading ${dirPath}: ${err.message}`);
    }
  }

  cleanDir(sessionBaseDir);
  logInfo('[CACHE] Chromium cache cleanup complete. Session credentials protected.');
}

const INSTANCE_ID = `${os.hostname()}-${process.pid}-${Date.now()}`;
const activeLocks = new Set<string>();

async function acquireLock(jobName: string, durationMinutes = 5): Promise<boolean> {
  const lockKey = `lock:${jobName}`;
  if (activeLocks.has(lockKey)) {
    logInfo(`[LOCK] ${jobName} already locked in memory`);
    return false;
  }
  try {
    const expiresAt = new Date(Date.now() + durationMinutes * 60 * 1000);
    const { data, error } = (await supabase
      .from('scheduler_locks')
      .insert([
        {
          job_name: jobName,
          locked_at: new Date().toISOString(),
          locked_by: INSTANCE_ID,
          expires_at: expiresAt.toISOString(),
        },
      ])
      .select()
      .single()) as any;
    if (error) {
      if (error.code === '23505') {
        const { data: stale } = (await supabase
          .from('scheduler_locks')
          .select('*')
          .eq('job_name', jobName)
          .single()) as any;
        if (stale && new Date(stale.expires_at) < new Date()) {
          await supabase.from('scheduler_locks').delete().eq('job_name', jobName).eq('locked_by', stale.locked_by);
          logInfo(`[LOCK] ${jobName} reclaimed expired lock`);
          const { data: retryData, error: retryErr } = (await supabase
            .from('scheduler_locks')
            .insert([
              {
                job_name: jobName,
                locked_at: new Date().toISOString(),
                locked_by: INSTANCE_ID,
                expires_at: new Date(Date.now() + durationMinutes * 60 * 1000).toISOString(),
              },
            ])
            .select()
            .single()) as any;
          if (retryErr) {
            logInfo(`[LOCK] ${jobName} retry failed: ${retryErr.message}`);
            return false;
          }
          if (retryData && retryData.locked_by === INSTANCE_ID) {
            activeLocks.add(lockKey);
            logInfo(`[LOCK] ✅ ${jobName} acquired after reclaim`);
            return true;
          }
        }
      }
      logInfo(`[LOCK] ${jobName} locked by another instance`);
      return false;
    }
    if (data && data.locked_by === INSTANCE_ID) {
      activeLocks.add(lockKey);
      logInfo(`[LOCK] ✅ ${jobName} acquired by ${INSTANCE_ID}`);
      return true;
    }
    return false;
  } catch (err: any) {
    logError(`[LOCK] Error acquiring ${jobName}:`, err.message);
    return false;
  }
}

async function releaseLock(jobName: string): Promise<void> {
  const lockKey = `lock:${jobName}`;
  activeLocks.delete(lockKey);
  try {
    await supabase.from('scheduler_locks').delete().eq('job_name', jobName).eq('locked_by', INSTANCE_ID);
    logInfo(`[LOCK] ✅ ${jobName} released`);
  } catch (err: any) {
    logError(`[LOCK] Error releasing ${jobName}:`, err.message);
  }
}

async function executeWithLock(jobName: string, fn: () => Promise<void>, durationMinutes = 5): Promise<void> {
  const acquired = await acquireLock(jobName, durationMinutes);
  if (!acquired) return;
  try {
    await fn();
  } catch (err: any) {
    logError(`[JOB] ${jobName} error:`, err.message);
  } finally {
    await releaseLock(jobName);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function sendReport(
  client: any,
  userId: string,
  storeName: string,
  periodStr: string,
  timeFilterIso: string,
): Promise<boolean> {
  if (!client) {
    client = state.waClient;
    if (!client) {
      logWarn('[SCHEDULER] WA client null, skip sendReport');
      return false;
    }
  }
  if (!state.clientReady) {
    logWarn('[SCHEDULER] WA client not ready, skip sendReport');
    return false;
  }
  try {
    const { data: trans, error } = (await supabase
      .from('transactions')
      .select('type, amount')
      .eq('user_id', userId)
      .gte('created_at', timeFilterIso)) as any;
    if (error) throw new Error(error.message);
    if (!trans || trans.length === 0) return false;
    let masuk = 0,
      keluar = 0;
    trans.forEach((t: any) => {
      const v = Number(t.amount) || 0;
      if (t.type === 'masuk') masuk += v;
      else keluar += v;
    });
    const saldo = masuk - keluar;
    const teks = `📊 *Laporan ${periodStr}*\n🏪 ${storeName}\n${'─'.repeat(26)}\n🟢 Masuk  : ${formatRupiah(masuk)}\n🔴 Keluar : ${formatRupiah(keluar)}\n${'─'.repeat(26)}\n${saldo >= 0 ? `💰 *Saldo: ${formatRupiah(saldo)}*` : `🔴 *Defisit: -${formatRupiah(Math.abs(saldo))}*`}\n📋 Total ${trans.length} transaksi`;
    await client.sendMessage(userId, teks);
    return true;
  } catch (err: any) {
    logError(`[ERROR] sendReport [${userId}]: ${err.message}`);
    return false;
  }
}

async function sendUpgradeNotification(
  client: any,
  userId: string,
  storeName: string,
  status: string,
  expiresAt?: string,
): Promise<boolean> {
  if (!client) {
    client = state.waClient;
    if (!client) {
      logWarn('[SCHEDULER] WA client null, skip sendUpgradeNotification');
      return false;
    }
  }
  if (!state.clientReady) {
    logWarn('[SCHEDULER] WA client not ready, skip sendUpgradeNotification');
    return false;
  }
  try {
    let msg = '';
    if (status === 'unlimited') {
      msg = `🎉 *Selamat Bos ${storeName}!*\n\nPembayaran *UNLIMITED* telah diverifikasi admin.\nAkun Anda kini *UNLIMITED* 💎 *selamanya*!\n\n✅ Yang Anda dapatkan:\n   • Transaksi tanpa batas per hari\n   • Semua laporan otomatis\n   • Stock opname enterprise unlimited\n   • Tidak perlu perpanjang lagi\n\nTerima kasih telah mempercayai kami! 🙏`;
    } else {
      const exp = expiresAt
        ? new Date(expiresAt).toLocaleDateString('id-ID', { day: '2-digit', month: 'long', year: 'numeric' } as any)
        : '—';
      msg = `🎉 *Selamat Bos ${storeName}!*\n\nPembayaran *PRO Bulanan* telah diverifikasi admin.\nAkun kini *PRO* ⭐ aktif hingga *${exp}*!\n\n✅ Yang Anda dapatkan:\n   • Transaksi tanpa batas per hari\n   • Laporan mingguan & bulanan otomatis\n   • Stock opname lengkap\n\nKetik *Paket* untuk perpanjang kapan saja.\nTerima kasih telah mempercayai kami! 🙏`;
    }
    await client.sendMessage(userId, msg);
    logInfo(`[NOTIF] Upgrade notification → ${storeName} (${userId}) [${status}]`);
    return true;
  } catch (err: any) {
    const errStack = err?.stack || err?.message || String(err);
    logError(`[ERROR] sendUpgradeNotification [${userId}]: ${errStack}`);
    if (errStack.includes('ExecutionContext') || errStack === 't: t') {
      if (state.clientReady) {
        state.clientReady = false;
        logWarn('[WA] sendUpgradeNotification — page execution context destroyed, set clientReady=false');
      }
    }
    return false;
  }
}

const upgradeRetries = new Map<string, number>();

async function checkAndNotifyUpgrades(client: any): Promise<void> {
  if (!client) {
    client = state.waClient;
    if (!client) {
      logWarn('[SCHEDULER] WA client null, skip checkAndNotifyUpgrades');
      return;
    }
  }
  if (!state.clientReady) {
    logWarn('[SCHEDULER] WA client not ready, skip checkAndNotifyUpgrades');
    return;
  }
  try {
    const { data: users, error } = (await supabase
      .from('users')
      .select('id, store_name, status, subscription_expires_at')
      .in('status', ['pro', 'unlimited'])
      .eq('upgrade_notified', false)) as any;
    if (error) {
      logError(`[ERROR] checkAndNotifyUpgrades: ${error.message}`);
      return;
    }
    if (!users || users.length === 0) return;
    for (const u of users) {
      const sent = await sendUpgradeNotification(client, u.id, u.store_name, u.status, u.subscription_expires_at);
      if (sent) {
        await supabase.from('users').update({ upgrade_notified: true }).eq('id', u.id);
        upgradeRetries.delete(u.id);
      } else {
        const retry = (upgradeRetries.get(u.id) || 0) + 1;
        if (retry >= 3) {
          logWarn(`[NOTIF] Marking ${u.store_name} (${u.id}) upgrade_notified=true after ${retry} failed attempts`);
          await supabase.from('users').update({ upgrade_notified: true }).eq('id', u.id);
          upgradeRetries.delete(u.id);
        } else {
          upgradeRetries.set(u.id, retry);
        }
      }
      await sleep(300);
    }
  } catch (err: any) {
    logError(`[ERROR] checkAndNotifyUpgrades: ${err.message}`);
  }
}

async function checkExpiredSubscriptions(client: any): Promise<void> {
  if (!client) {
    client = state.waClient;
    if (!client) {
      logWarn('[SCHEDULER] WA client null, skip checkExpiredSubscriptions');
      return;
    }
  }
  try {
    const now = new Date().toISOString();
    const { data: expired, error } = (await supabase
      .from('users')
      .select('id, store_name')
      .eq('status', 'pro')
      .lt('subscription_expires_at', now)) as any;
    if (error) {
      logError(`[ERROR] checkExpired: ${error.message}`);
      return;
    }
    if (!expired || expired.length === 0) return;
    logInfo(`[CRON] ${expired.length} user pro expired — downgrade ke demo.`);
    for (const u of expired) {
      await supabase.from('users').update({ status: 'demo', upgrade_notified: false }).eq('id', u.id);
      try {
        await client.sendMessage(
          u.id,
          `⚠️ *Langganan PRO Habis - ${u.store_name}*\n\nAkun Anda kembali ke mode *DEMO* (5 transaksi/hari).\n\nKetik *Paket* untuk perpanjang langganan. 🙏`,
        );
      } catch {
        /* ignore */
      }
      await sleep(500);
    }
  } catch (err: any) {
    logError(`[ERROR] checkExpiredSubscriptions: ${err.message}`);
  }
}

const broadcastHistory = new Map<string, number>();

async function broadcastMessage(
  client: any,
  message: string,
  target = 'all',
): Promise<{ sent: number; failed: number; total: number; skipped?: boolean }> {
  if (!client) {
    client = state.waClient;
    if (!client) {
      logWarn('[SCHEDULER] WA client null, skip broadcastMessage');
      return { sent: 0, failed: 0, total: 0 };
    }
  }
  try {
    const hash = `${message.substring(0, 50)}-${target}`;
    const lastSent = broadcastHistory.get(hash);
    if (lastSent && Date.now() - lastSent < 10 * 60 * 1000) {
      logInfo(`[BROADCAST] Duplicate detected within 10min — skip`);
      return { sent: 0, failed: 0, total: 0, skipped: true };
    }
    let query: any = supabase.from('users').select('id, store_name');
    if (target !== 'all') query = query.eq('status', target);
    const { data: users, error } = await query;
    if (error) throw new Error(error.message);
    if (!users || users.length === 0) return { sent: 0, failed: 0, total: 0 };
    let sent = 0,
      failed = 0;
    for (const u of users) {
      try {
        const text = message.replace(/\{nama_toko\}/gi, u.store_name);
        await client.sendMessage(u.id, text);
        sent++;
      } catch {
        failed++;
      }
      await sleep(1200);
    }
    broadcastHistory.set(hash, Date.now());
    if (broadcastHistory.size > 100) {
      const oldest = Array.from(broadcastHistory.keys()).slice(0, 50);
      oldest.forEach((k) => broadcastHistory.delete(k));
    }
    logInfo(`[BROADCAST] Selesai: ${sent} OK, ${failed} gagal, total ${users.length}`);
    return { sent, failed, total: users.length };
  } catch (err: any) {
    logError(`[ERROR] broadcastMessage: ${err.message}`);
    return { sent: 0, failed: 0, total: 0 };
  }
}

async function processBroadcastPending(client: any): Promise<void> {
  if (!client) {
    client = state.waClient;
    if (!client) {
      logWarn('[SCHEDULER] WA client null, skip processBroadcastPending');
      return;
    }
  }
  try {
    const { data, error } = (await supabase
      .from('settings')
      .select('value')
      .eq('key', 'broadcast_pending')
      .single()) as any;
    if (error || !data?.value || data.value === 'null') return;
    let req: any;
    try {
      req = JSON.parse(data.value);
    } catch {
      return;
    }
    if (!req?.message || !req?.timestamp) return;
    if (Date.now() - req.timestamp > 5 * 60 * 1000) {
      await supabase.from('settings').update({ value: 'null' }).eq('key', 'broadcast_pending');
      return;
    }
    await supabase.from('settings').update({ value: 'null' }).eq('key', 'broadcast_pending');
    const result = await broadcastMessage(client, req.message, req.target || 'all');
    if (result.skipped) {
      logInfo(`[BROADCAST] Skipped duplicate`);
      return;
    }
    logInfo(`[BROADCAST] Hasil: ${JSON.stringify(result)}`);
    await supabase
      .from('settings')
      .upsert({ key: 'broadcast_last_result', value: JSON.stringify({ ...result, at: new Date().toISOString() }) });
  } catch (err: any) {
    logError(`[ERROR] processBroadcastPending: ${err.message}`);
  }
}

async function sendMorningGreeting(client: any): Promise<void> {
  if (!client) {
    client = state.waClient;
    if (!client) {
      logWarn('[SCHEDULER] WA client null, skip sendMorningGreeting');
      return;
    }
  }
  if (!state.clientReady) {
    logWarn('[SCHEDULER] WA client not ready, skip sendMorningGreeting');
    return;
  }
  logInfo('[CRON] Sapaan Pagi...');
  try {
    const { data: users, error } = (await supabase
      .from('users')
      .select('id, store_name')
      .in('onboarding_status', ['active_user'])
      .in('status', ['demo', 'pro', 'unlimited'])) as any;
    if (error) throw new Error(error.message);
    if (!users || users.length === 0) return;
    const greetings = [
      (name: string) =>
        `🌅 *Selamat pagi Bos ${name}!*\n\nSemoga hari ini penuh berkah dan transaksi yang lancar ya! 💪\n\nJangan lupa catat setiap pemasukan & pengeluaran hari ini.\nContoh: *Jual kopi 50rb* atau *Beli bahan 120rb*`,
      (name: string) =>
        `☀️ *Pagi Bos ${name}!*\n\nToko sudah siap buka? Yuk mulai hari dengan semangat! 🚀\n\nIngat, setiap transaksi kecil tetap penting dicatat.\nKetik *Bantuan* jika butuh panduan.`,
      (name: string) =>
        `🌤️ *Good morning Bos ${name}!*\n\nHari baru, semangat baru! Bismillah buat rezeki hari ini. 🙏\n\nTata siap membantu catat keuangan toko Anda seharian penuh.\nMulai dengan: *Jual [item] [nominal]*`,
      (name: string) =>
        `🌞 *Selamat pagi Bos ${name}!*\n\nSemoga dagangan hari ini laris manis ya! 🛒✨\n\nYuk catat transaksi pertama hari ini — sehebat apapun\nusaha Anda, catatan keuangan yang rapi bikin lebih tenang. 💰`,
    ];
    let sent = 0;
    for (const u of users) {
      try {
        const dayOfWeek = new Date().getDay();
        const greetFn = greetings[dayOfWeek % greetings.length];
        await client.sendMessage(u.id, greetFn(u.store_name));
        sent++;
      } catch (err: any) {
        logError(`[CRON] morning greeting failed for ${u.id}: ${err.message}`);
      }
      await sleep(600);
    }
    logInfo(`[CRON] Sapaan Pagi selesai: ${sent}/${users.length} terkirim.`);
  } catch (err: any) {
    logError(`[CRON] Sapaan Pagi error: ${err.message}`);
  }
}

async function sendEveningReminder(client: any): Promise<void> {
  if (!client) {
    client = state.waClient;
    if (!client) {
      logWarn('[SCHEDULER] WA client null, skip sendEveningReminder');
      return;
    }
  }
  if (!state.clientReady) {
    logWarn('[SCHEDULER] WA client not ready, skip sendEveningReminder');
    return;
  }
  logInfo('[CRON] Pengingat Sore...');
  try {
    const { data: users, error } = (await supabase
      .from('users')
      .select('id, store_name')
      .in('onboarding_status', ['active_user'])
      .in('status', ['demo', 'pro', 'unlimited'])) as any;
    if (error) throw new Error(error.message);
    if (!users || users.length === 0) return;
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const userIds = users.map((u: any) => u.id);
    const { data: activeTx } = (await supabase
      .from('transactions')
      .select('user_id')
      .in('user_id', userIds)
      .gte('created_at', todayStart.toISOString())) as any;
    const activeUserIds = new Set((activeTx || []).map((t: any) => t.user_id));
    let reminded = 0,
      skipped = 0;
    for (const u of users) {
      if (activeUserIds.has(u.id)) {
        skipped++;
        continue;
      }
      try {
        await client.sendMessage(
          u.id,
          `🌆 *Halo Bos ${u.store_name}!*\n\nKami lihat hari ini belum ada transaksi yang tercatat. 📭\n\nMungkin terlupa? Yuk catat sekarang sebelum lupa:\n📥 Masuk : *Jual kopi 50rb*\n📤 Keluar: *Beli bahan 120rb*\n\nCatatan yang rapi hari ini bikin laporan malam nanti lebih akurat. 📊`,
        );
        reminded++;
      } catch (err: any) {
        logError(`[CRON] evening reminder failed for ${u.id}: ${err.message}`);
        skipped++;
      }
      await sleep(600);
    }
    logInfo(`[CRON] Pengingat Sore: ${reminded} diingatkan, ${skipped} dilewati.`);
  } catch (err: any) {
    logError(`[CRON] Pengingat Sore error: ${err.message}`);
  }
}

async function checkStockAlerts(client: any): Promise<void> {
  if (!client) {
    client = state.waClient;
    if (!client) {
      logWarn('[SCHEDULER] WA client null, skip checkStockAlerts');
      return;
    }
  }
  if (!state.clientReady) {
    logWarn('[SCHEDULER] WA client not ready, skip checkStockAlerts');
    return;
  }
  logInfo('[CRON] Stock Alert Checker...');
  try {
    const result = await stockManager.getPendingAlerts(null!);
    const byUser: Record<string, any[]> = {};
    (result.alerts || []).forEach((alert: any) => {
      if (!byUser[alert.user_id]) byUser[alert.user_id] = [];
      byUser[alert.user_id].push(alert);
    });
    const userIds = Object.keys(byUser);
    if (userIds.length === 0) return;
    const { data: allUsers } = (await supabase
      .from('users')
      .select('id, store_name, status, dashboard_token, store_slug')
      .in('id', userIds)) as any;
    const userMap: Record<string, any> = {};
    (allUsers || []).forEach((u: any) => {
      userMap[u.id] = u;
    });
    let sent = 0;
    for (const [userId, alerts] of Object.entries(byUser)) {
      try {
        const user = userMap[userId];
        if (!user || !['pro', 'unlimited'].includes(user.status)) continue;
        let msg = `⚠️ *Stock Alert - ${user.store_name}*\n\n`;
        (alerts as any[]).forEach((a: any) => {
          const p = a.products;
          if (a.alert_type === 'out_of_stock') {
            msg += `🔴 *${p.name}* (${p.sku})\n   Stock HABIS!\n\n`;
          } else {
            msg += `⚠️ *${p.name}* (${p.sku})\n   Stock: ${stockManager.formatQty(p.stock_current, p.unit)} ${p.unit} (min: ${stockManager.formatQty(p.stock_min, p.unit)})\n\n`;
          }
        });
        const appUrl = (process.env.APP_URL || 'https://nickridwan-tata-business-suite.hf.space').replace(/\/+$/, '');
        if (user.dashboard_token) {
          const slug = user.store_slug || userId.replace('@', '%40');
          msg += `📊 Kelola stok di:\n${appUrl}/stock/${slug}?token=${user.dashboard_token}`;
        } else {
          msg += `Ketik *Dashboard* di WA untuk akses portal stok.`;
        }
        await client.sendMessage(userId, msg);
        sent++;
      } catch (e: any) {
        logError(`[STOCK] Alert send error ${userId}:`, e.message);
      }
      await sleep(800);
    }
    logInfo(`[CRON] Stock alerts sent: ${sent}`);
  } catch (err: any) {
    logError(`[CRON] Stock alert error: ${err.message}`);
  }
}

const overdueNotified = new Set<string>();

async function checkOverduePiutang(client: any): Promise<void> {
  if (!client) {
    client = state.waClient;
    if (!client) {
      logWarn('[SCHEDULER] WA client null, skip checkOverduePiutang');
      return;
    }
  }
  if (!state.clientReady) {
    logWarn('[SCHEDULER] WA client not ready, skip checkOverduePiutang');
    return;
  }
  logInfo('[CRON] Cek Piutang Jatuh Tempo...');
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayEnd = new Date(today);
    todayEnd.setDate(todayEnd.getDate() + 1);

    const { data: debts, error } = (await supabase
      .from('receivables')
      .select('id, user_id, nama_pelanggan, nominal_piutang, jatuh_tempo')
      .eq('status_lunas', false)
      .not('jatuh_tempo', 'is', null)
      .gte('jatuh_tempo', today.toISOString())
      .lt('jatuh_tempo', todayEnd.toISOString())) as any;
    if (error) {
      logError(`[CRON] checkPiutangDue query: ${error.message}`);
      return;
    }
    if (!debts || debts.length === 0) {
      logInfo('[CRON] Tidak ada piutang jatuh tempo hari ini');
      return;
    }

    const byUser: Record<string, any[]> = {};
    debts.forEach((d: any) => {
      if (!byUser[d.user_id]) byUser[d.user_id] = [];
      byUser[d.user_id].push(d);
    });

    const { data: allUsers } = (await supabase
      .from('users')
      .select('id, store_name')
      .in('id', Object.keys(byUser))) as any;
    const userMap: Record<string, any> = {};
    (allUsers || []).forEach((u: any) => {
      userMap[u.id] = u;
    });

    let sent = 0;
    for (const [userId, userDebts] of Object.entries(byUser)) {
      const todayKey = `${userId}-${today.toISOString().slice(0, 10)}`;
      if (overdueNotified.has(todayKey)) continue;

      try {
        const user = userMap[userId];
        if (!user) continue;
        const total = userDebts.reduce((sum: number, d: any) => sum + Number(d.nominal_piutang), 0);
        let msg = `⚠️ *Pengingat Piutang - ${user.store_name}*\n\nAda *${userDebts.length}* piutang jatuh tempo hari ini:\n\n`;
        userDebts.slice(0, 10).forEach((d: any) => {
          const due = new Date(d.jatuh_tempo).toLocaleDateString('id-ID');
          msg += `• *${d.nama_pelanggan}* — ${formatRupiah(Number(d.nominal_piutang))}\n  Jatuh tempo: ${due}\n\n`;
        });
        if (userDebts.length > 10) msg += `...dan ${userDebts.length - 10} piutang lainnya\n\n`;
        msg += `Total: ${formatRupiah(total)}\n\nKetik *Piutang* untuk detail.`;
        await client.sendMessage(userId, msg);
        overdueNotified.add(todayKey);
        sent++;
      } catch (e: any) {
        logError(`[CRON] Overdue notify error ${userId}: ${e.message}`);
      }
      await sleep(500);
    }
    logInfo(`[CRON] Piutang due notified: ${sent}/${Object.keys(byUser).length}`);
  } catch (err: any) {
    logError(`[CRON] checkPiutangDue error: ${err.message}`);
  }
}

const hutangOverdueNotified = new Set<string>();

async function checkOverdueHutang(client: any): Promise<void> {
  if (!client) {
    client = state.waClient;
    if (!client) {
      logWarn('[SCHEDULER] WA client null, skip checkOverdueHutang');
      return;
    }
  }
  if (!state.clientReady) {
    logWarn('[SCHEDULER] WA client not ready, skip checkOverdueHutang');
    return;
  }
  logInfo('[CRON] Cek Hutang Jatuh Tempo...');
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayEnd = new Date(today);
    todayEnd.setDate(todayEnd.getDate() + 1);

    const { data: hutangs, error } = (await supabase
      .from('payables')
      .select('id, user_id, nama_supplier, nominal_hutang, jumlah_dibayar, jatuh_tempo')
      .eq('status_lunas', false)
      .not('jatuh_tempo', 'is', null)
      .gte('jatuh_tempo', today.toISOString())
      .lt('jatuh_tempo', todayEnd.toISOString())) as any;
    if (error) {
      logError(`[CRON] checkHutangDue query: ${error.message}`);
      return;
    }
    if (!hutangs || hutangs.length === 0) {
      logInfo('[CRON] Tidak ada hutang jatuh tempo hari ini');
      return;
    }

    const byUser: Record<string, any[]> = {};
    hutangs.forEach((h: any) => {
      if (!byUser[h.user_id]) byUser[h.user_id] = [];
      byUser[h.user_id].push(h);
    });

    const { data: allUsers } = (await supabase
      .from('users')
      .select('id, store_name')
      .in('id', Object.keys(byUser))) as any;
    const userMap: Record<string, any> = {};
    (allUsers || []).forEach((u: any) => {
      userMap[u.id] = u;
    });

    let sent = 0;
    for (const [userId, userHutangs] of Object.entries(byUser)) {
      const todayKey = `${userId}-hutang-${today.toISOString().slice(0, 10)}`;
      if (hutangOverdueNotified.has(todayKey)) continue;

      try {
        const user = userMap[userId];
        if (!user) continue;
        const total = userHutangs.reduce(
          (sum: number, h: any) => sum + Number(h.nominal_hutang) - Number(h.jumlah_dibayar || 0),
          0,
        );
        let msg = `⏰ *Pengingat Hutang — ${user.store_name}*\n\nAda *${userHutangs.length}* hutang jatuh tempo hari ini:\n\n`;
        userHutangs.slice(0, 10).forEach((h: any) => {
          const due = new Date(h.jatuh_tempo).toLocaleDateString('id-ID');
          const sisa = Number(h.nominal_hutang) - Number(h.jumlah_dibayar || 0);
          msg += `• *${h.nama_supplier}* — ${formatRupiah(Math.max(0, sisa))}\n  Jatuh tempo: ${due}\n\n`;
        });
        if (userHutangs.length > 10) msg += `...dan ${userHutangs.length - 10} hutang lainnya\n\n`;
        msg += `Total: ${formatRupiah(Math.max(0, total))}\n\nSegera bayar ya Bos agar hubungan dengan supplier tetap baik. 🙏`;
        await client.sendMessage(userId, msg);
        hutangOverdueNotified.add(todayKey);
        sent++;
      } catch (e: any) {
        logError(`[CRON] Hutang overdue notify error ${userId}: ${e.message}`);
      }
      await sleep(500);
    }
    logInfo(`[CRON] Hutang due notified: ${sent}/${Object.keys(byUser).length}`);
  } catch (err: any) {
    logError(`[CRON] checkHutangDue error: ${err.message}`);
  }
}

const expiryNotified = new Set<string>();

async function checkExpiryWarning(client: any): Promise<void> {
  if (!client) {
    client = state.waClient;
    if (!client) {
      logWarn('[SCHEDULER] WA client null, skip checkExpiryWarning');
      return;
    }
  }
  if (!state.clientReady) {
    logWarn('[SCHEDULER] WA client not ready, skip checkExpiryWarning');
    return;
  }
  logInfo('[CRON] Cek Peringatan Expiry...');
  try {
    const now = new Date();
    const todayKey = now.toISOString().slice(0, 10);

    for (const days of [7, 3, 1]) {
      const target = new Date();
      target.setDate(target.getDate() + days);
      const end = new Date(target);
      end.setHours(23, 59, 59, 999);
      target.setHours(0, 0, 0, 0);

      const { data: users } = (await supabase
        .from('users')
        .select('id, store_name, subscription_expires_at')
        .eq('status', 'pro')
        .gte('subscription_expires_at', target.toISOString())
        .lte('subscription_expires_at', end.toISOString())) as any;

      if (!users || users.length === 0) continue;

      for (const u of users) {
        const notifyKey = `${u.id}-${days}d-${todayKey}`;
        if (expiryNotified.has(notifyKey)) continue;

        try {
          const expDate = new Date(u.subscription_expires_at).toLocaleDateString('id-ID', {
            day: '2-digit',
            month: 'long',
            year: 'numeric',
          } as any);
          await client.sendMessage(
            u.id,
            `⚠️ *Peringatan Langganan PRO*\n\nHalo ${u.store_name}, langganan PRO Anda akan berakhir dalam *${days} hari*.\n\n📅 Tanggal berakhir: ${expDate}\n\nSetelah itu akun kembali ke mode *DEMO* (5 transaksi/hari).\n\nKetik *Paket* untuk perpanjang sekarang! 🔄`,
          );
          expiryNotified.add(notifyKey);
        } catch (e: any) {
          logError(`[CRON] Expiry notify error ${u.id}: ${e.message}`);
        }
        await sleep(300);
      }
    }
  } catch (err: any) {
    logError(`[CRON] checkExpiryWarning error: ${err.message}`);
  }
}

async function cleanupOldData(): Promise<void> {
  logInfo('[CRON] Cleanup old data...');
  try {
    const { error: msgErr } = (await supabase.rpc('cleanup_processed_messages')) as any;
    if (msgErr) logError('[CLEANUP] message_processed error:', msgErr.message);
    const { error: lockErr } = (await supabase.rpc('cleanup_expired_locks')) as any;
    if (lockErr) logError('[CLEANUP] locks error:', lockErr.message);
    logInfo('[CRON] Cleanup done.');
  } catch (err: any) {
    logError(`[CRON] Cleanup error: ${err.message}`);
  }
}

async function sendDailyCombined(client: any, userId: string, storeName: string, storeSlug?: string): Promise<boolean> {
  if (!client) {
    client = state.waClient;
    if (!client) {
      logWarn('[SCHEDULER] WA client null, skip sendDailyCombined');
      return false;
    }
  }
  if (!state.clientReady) {
    logWarn('[SCHEDULER] WA client not ready, skip sendDailyCombined');
    return false;
  }
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayISO = today.toISOString();
    const { data: trans } = (await supabase
      .from('transactions')
      .select('type, amount, description')
      .eq('user_id', userId)
      .gte('created_at', todayISO)) as any;
    if (!trans || trans.length === 0) return false;
    let masuk = 0, keluar = 0, hpp = 0;
    const channelTotals: Record<string, number> = {};
    trans.forEach((t: any) => {
      const v = Number(t.amount) || 0;
      if (t.type === 'masuk') {
        masuk += v;
        const chMatch = t.description?.match(/\((Tokopedia|TikTok Shop|Lazada|Shopee)\)/i);
        const ch = chMatch ? chMatch[1] : 'Offline';
        channelTotals[ch] = (channelTotals[ch] || 0) + v;
      } else {
        keluar += v;
      }
    });
    const { data: stockOutTx } = (await supabase
      .from('transactions')
      .select('price_buy, quantity')
      .eq('user_id', userId)
      .eq('reference_type', 'stock_out')
      .gte('created_at', todayISO)) as any;
    (stockOutTx || []).forEach((t: any) => {
      hpp += (Number(t.quantity) || 0) * (Number(t.price_buy) || 0);
    });
    const laba = masuk - hpp - keluar;
    const { data: movements } = (await supabase
      .from('stock_movements')
      .select('quantity, products(name)')
      .eq('user_id', userId)
      .eq('type', 'out')
      .gte('created_at', todayISO)
      .order('created_at', { ascending: false })
      .limit(50)) as any;
    const productSales: Record<string, number> = {};
    (movements || []).forEach((m: any) => {
      const name = m.products?.name || 'Unknown';
      productSales[name] = (productSales[name] || 0) + (Number(m.quantity) || 0);
    });
    const topProducts = Object.entries(productSales)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);
    const saldo = masuk - keluar;
    const channelLines =
      Object.entries(channelTotals)
        .sort((a, b) => b[1] - a[1])
        .map(([ch, total]) => `  • ${ch}: ${formatRupiah(total)}`)
        .join('\n') || '  • Belum ada penjualan hari ini';
    const productLines =
      topProducts.length > 0
        ? topProducts.map(([name, qty]) => `  ${name} — ${qty} pcs`).join('\n')
        : '  Belum ada';
    const appUrl = (process.env.APP_URL || 'https://nickridwan-tata-business-suite.hf.space').replace(/\/+$/, '');
    const slug = storeSlug || userId.replace('@', '%40');
    const msg = `📊 *Laporan Harian — ${storeName}*\n${'─'.repeat(26)}\n🟢 Pemasukan : ${formatRupiah(masuk)}\n🔴 Pengeluaran : ${formatRupiah(keluar)}${'─'.repeat(26)}\n${saldo >= 0 ? `💰 *Saldo: ${formatRupiah(saldo)}*` : `🔴 *Defisit: -${formatRupiah(Math.abs(saldo))}*`}\n\n📈 *Laba Bersih: ${formatRupiah(laba)}*\n\n🛒 *SUMBER PENJUALAN:*\n${channelLines}\n\n📦 *PRODUK TERLARIS:*\n${productLines}\n\n📋 ${trans.length} transaksi hari ini\n\nDetail: ${appUrl}/stock/${slug}`;
    await client.sendMessage(userId, msg);
    return true;
  } catch (err: any) {
    logError(`[DAILY] ${userId}: ${err.message}`);
    return false;
  }
}

function initSchedulers(addLogFn?: (level: string, msg: string) => void): void {
  if (addLogFn) _addLog = addLogFn;
  const tz = { timezone: 'Asia/Jakarta' as const };

  const getClient = () => state.waClient;

  cron.schedule(
    '0 21 * * *',
    () => {
      executeWithLock(
        'daily-report',
        async () => {
          logInfo('[CRON] Laporan Harian (21:00)...');
          try {
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            const { data: users } = (await supabase
              .from('users')
              .select('id, store_name, store_slug')
              .eq('onboarding_status', 'active_user')
              .in('status', ['demo', 'pro', 'unlimited'])) as any;
            if (!users) return;
            let ok = 0;
            for (const u of users) {
              if (await sendDailyCombined(getClient(), u.id, u.store_name, u.store_slug)) ok++;
              await sleep(300);
            }
            logInfo(`[CRON] Harian selesai: ${ok}/${users.length}`);
          } catch (e: any) {
            logError(`[CRON] Harian: ${e.message}`);
          }
        },
        60,
      );
    },
    tz,
  );

  cron.schedule(
    '0 21 * * 6',
    () => {
      executeWithLock(
        'weekly-report',
        async () => {
          logInfo('[CRON] Laporan Mingguan...');
          try {
            const lw = new Date();
            lw.setDate(lw.getDate() - 7);
            lw.setHours(0, 0, 0, 0);
            const { data: users } = (await supabase
              .from('users')
              .select('id, store_name')
              .in('status', ['pro', 'unlimited'])) as any;
            if (!users) return;
            let ok = 0;
            for (const u of users) {
              if (await sendReport(getClient(), u.id, u.store_name, 'Mingguan', lw.toISOString())) ok++;
              await sleep(300);
            }
            logInfo(`[CRON] Mingguan selesai: ${ok}/${users.length}`);
          } catch (e: any) {
            logError(`[CRON] Mingguan: ${e.message}`);
          }
        },
        60,
      );
    },
    tz,
  );

  cron.schedule(
    '0 21 1 * *',
    () => {
      executeWithLock(
        'monthly-report',
        async () => {
          logInfo('[CRON] Laporan Bulanan...');
          try {
            const lm = new Date();
            lm.setMonth(lm.getMonth() - 1);
            lm.setDate(1);
            lm.setHours(0, 0, 0, 0);
            const { data: users } = (await supabase
              .from('users')
              .select('id, store_name')
              .in('status', ['pro', 'unlimited'])) as any;
            if (!users) return;
            let ok = 0;
            for (const u of users) {
              if (await sendReport(getClient(), u.id, u.store_name, 'Bulanan', lm.toISOString())) ok++;
              await sleep(300);
            }
            logInfo(`[CRON] Bulanan selesai: ${ok}/${users.length}`);
          } catch (e: any) {
            logError(`[CRON] Bulanan: ${e.message}`);
          }
        },
        60,
      );
    },
    tz,
  );

  cron.schedule(
    '5 0 * * *',
    () => {
      executeWithLock(
        'check-expired',
        async () => {
          await checkExpiredSubscriptions(getClient());
        },
        10,
      );
    },
    tz,
  );
  cron.schedule('* * * * *', () => {
    executeWithLock(
      'upgrade-notify',
      async () => {
        await checkAndNotifyUpgrades(getClient());
      },
      2,
    );
  });
  cron.schedule('*/5 * * * *', () => {
    executeWithLock(
      'broadcast',
      async () => {
        await processBroadcastPending(getClient());
      },
      5,
    );
  });
  cron.schedule(
    '0 6 * * *',
    () => {
      executeWithLock(
        'morning-greeting',
        async () => {
          await sendMorningGreeting(getClient());
        },
        60,
      );
    },
    tz,
  );
  cron.schedule(
    '0 16 * * *',
    () => {
      executeWithLock(
        'evening-reminder',
        async () => {
          await sendEveningReminder(getClient());
        },
        60,
      );
    },
    tz,
  );
  cron.schedule(
    '0 7 * * *',
    () => {
      executeWithLock(
        'stock-alerts',
        async () => {
          await checkStockAlerts(getClient());
        },
        30,
      );
    },
    tz,
  );
  cron.schedule(
    '0 8 * * *',
    () => {
      executeWithLock(
        'piutang-due',
        async () => {
          await checkOverduePiutang(getClient());
        },
        30,
      );
    },
    tz,
  );
  cron.schedule(
    '0 22 * * *',
    () => {
      executeWithLock(
        'expiry-warning',
        async () => {
          await checkExpiryWarning(getClient());
        },
        30,
      );
    },
    tz,
  );
  cron.schedule(
    '0 8 * * *',
    () => {
      executeWithLock(
        'hutang-due',
        async () => {
          await checkOverdueHutang(getClient());
        },
        30,
      );
    },
    tz,
  );
  cron.schedule(
    '0 3 * * *',
    () => {
      executeWithLock(
        'cleanup',
        async () => {
          await cleanupOldData();
          try {
            if (typeof autoCleanCache === 'function') await autoCleanCache();
          } catch (cacheErr: any) {
            logError(`[CRON] Cache cleanup error: ${cacheErr.message}`);
          }
          try {
            await (supabase.rpc('cleanup_old_behaviors') as any);
          } catch (_: any) {
            logError('[CRON] cleanup_old_behaviors RPC failed:', _.message);
          }
        },
        10,
      );
    },
    tz,
  );

  cron.schedule(
    '0 2 * * *',
    () => {
      executeWithLock(
        'db-backup',
        async () => {
          logInfo('[BACKUP] Memulai backup database...');
          const result = await runBackup();
          if (result.success) {
            logInfo(`[BACKUP] ✅ Backup berhasil (${((result.size || 0) / 1024 / 1024).toFixed(1)} MB)`);
          } else {
            logError(`[BACKUP] ❌ Backup gagal: ${result.error}`);
          }
        },
        30,
      );
    },
    tz,
  );

  const selfPing = async () => {
    const appUrl = process.env.APP_URL || '';
    if (!appUrl) return;
    try {
      const http = appUrl.startsWith('https') ? await import('https') : await import('http');
      await new Promise<void>((resolve, reject) => {
        const req = (http as any).get(`${appUrl}/ping`, { timeout: 10_000 }, (res: any) => {
          logInfo(`[PING] Self-ping OK → ${res.statusCode}`);
          resolve();
        });
        req.on('error', reject);
        req.on('timeout', () => {
          req.destroy();
          reject(new Error('timeout'));
        });
      });
    } catch (err: any) {
      logWarn(`[PING] Self-ping gagal: ${err.message}`);
    }
  };

  cron.schedule(
    '*/20 * * * *',
    () => {
      selfPing();
    },
    tz,
  );
  setTimeout(selfPing, 30_000);

  logInfo('[SISTEM] ✅ Scheduler aktif dengan mutex lock:');
  logInfo('  - Laporan Harian (21:00) | Mingguan (Sabtu 21:00) | Bulanan (tgl 1, 21:00)');
  logInfo('  - Sapaan pagi (06:00) | Pengingat sore (16:00)');
  logInfo('  - Expiry check (00:05) | Expiry warning (22:00) | Upgrade notif (tiap 1 min)');
  logInfo('  - Broadcast (tiap 5 min) | Hutang due (08:00) | Piutang due (08:00)');
  logInfo('  - Stock alerts (07:00) | Self-ping (tiap 20 min) | DB Backup (02:00)');
  logInfo('  - Smart Learning cleanup (stale 90-day behaviors)');
}

export { initSchedulers, sendReport, sendUpgradeNotification, broadcastMessage, autoCleanCache };
