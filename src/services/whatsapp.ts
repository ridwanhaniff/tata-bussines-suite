import { Client, LocalAuth } from 'whatsapp-web.js';
import qrcodeWeb from 'qrcode';
import { state, addLog, setIO, getIO, getSupabase } from '../config/state';
import { WA_MAX_RETRIES, WA_BASE_DELAY, WA_MAX_DELAY, SESSION_BASE_DIR } from '../config/constants';
import { saveSessionDirToDB } from './session-persistence';
import { sendEmergencyBroadcast } from './emergency';

let ioRef: any = null;

function setIOref(io: any): void {
  ioRef = io;
  setIO(io);
}

function getWaRetryDelay(): number {
  const delay = Math.min(WA_BASE_DELAY * Math.pow(2, state.waRetryCount), WA_MAX_DELAY);
  state.waRetryCount++;
  return delay;
}

function resetWaRetryCount(): void {
  state.waRetryCount = 0;
}

async function safeDestroyClient(): Promise<void> {
  if (!state.waClient) return;
  if (sessionBackupTimer) { clearInterval(sessionBackupTimer); sessionBackupTimer = null; }
  if (healthCheckTimer) { clearInterval(healthCheckTimer); healthCheckTimer = null; }
  state.waDestroyLock = true;
  try {
    await Promise.race([
      state.waClient.destroy(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('destroy timeout')), 15_000)),
    ]);
    addLog('info', '[WA] Client destroyed cleanly');
  } catch (e: any) {
    addLog('warn', `[WA] Destroy warning: ${e.message}`);
  } finally {
    state.waClient = null;
    state.waDestroyLock = false;
  }
  killChromeProcesses();
}

function killChromeProcesses(): void {
  try {
    const { execSync } = require('child_process');
    if (process.platform === 'win32') {
      execSync('taskkill /F /IM chrome.exe 2>nul', { stdio: 'ignore' });
    } else {
      execSync('pkill chromium 2>/dev/null; pkill chrome 2>/devnull', { stdio: 'ignore' });
    }
  } catch { /* cleanup not available or no matches */ }
}

let retryTimer: ReturnType<typeof setTimeout> | null = null;
let sessionBackupTimer: ReturnType<typeof setInterval> | null = null;
let watchdogTimer: ReturnType<typeof setTimeout> | null = null;
let healthCheckTimer: ReturnType<typeof setInterval> | null = null;
let watchdogExtendedCount = 0;
let lastDisconnectAt = 0;
let lastDisconnectAlert = 0;
const WA_ALERT_COOLDOWN = 300_000;
const WA_WATCHDOG_TIMEOUT = 180_000;
const WA_WATCHDOG_EXTEND_LIMIT = 2;

function scheduleRetry(delayMs: number): void {
  if (retryTimer) { addLog('info', '[WA] Retry already scheduled — skipping duplicate'); return; }
  retryTimer = setTimeout(() => {
    retryTimer = null;
    initWhatsApp();
  }, delayMs);
}

async function initWhatsApp(): Promise<void> {
  if (state.isInitializing) { addLog('warn', '[WA] Already initializing — skipping duplicate'); return; }
  state.isInitializing = true;
  state.clientReady = false;
  state.botStatus = 'Initializing';

  try {
    addLog('info', '[WA] Initializing WhatsApp client...');

    const sessionDir = SESSION_BASE_DIR;
    const fs = require('fs');
    const path = require('path');

    // Remove Chrome lock files to avoid "browser is already running" error
    const lockFiles = ['SingletonLock', 'SingletonSocket', 'SingletonCookie'];
    for (const file of lockFiles) {
      const fp = path.join(sessionDir, file);
      try { fs.unlinkSync(fp); } catch { }
    }

    const hasSession = fs.existsSync(sessionDir);

    const puppeteerOpts: Record<string, any> = {
      headless: true,
      args: [
        '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas', '--no-first-run', '--no-zygote',
        '--disable-gpu', '--single-process',
      ],
    };
    if (process.env.PUPPETEER_EXEC_PATH) {
      puppeteerOpts.executablePath = process.env.PUPPETEER_EXEC_PATH;
      addLog('info', `[WA] Using Chrome at: ${process.env.PUPPETEER_EXEC_PATH}`);
    }

    const client = new Client({
      authStrategy: new LocalAuth({ dataPath: sessionDir }),
      puppeteer: puppeteerOpts,
    });

    client.on('qr', async (qr: string) => {
      state.botStatus = 'QR_READY';
      state.currentQR = qr;
      try { state.pairingCode = await qrcodeWeb.toDataURL(qr); } catch (err: any) {
        addLog('error', '[WA] Gagal generate QR image: ' + (err?.message || err));
      }
      addLog('info', '[WA] QR code received');
      if (ioRef) ioRef.emit('bot_update', { currentQR: qr, pairingCode: state.pairingCode, clientReady: false, botStatus: state.botStatus });
    });

    client.on('authenticated', () => {
      state.botStatus = 'Authenticated';
      addLog('info', '[WA] Authenticated successfully');
    });

    client.on('auth_failure', (msg: string) => {
      state.botStatus = 'AUTH_FAILED';
      addLog('error', `[WA] Auth failure: ${msg}`);
      if (ioRef) ioRef.emit('auth_failure', msg);
      safeDestroyClient().then(() => scheduleRetry(5000));
    });

    client.on('ready', async () => {
      if (watchdogTimer) { clearTimeout(watchdogTimer); watchdogTimer = null; }
      watchdogExtendedCount = 0;
      state.clientReady = true;
      state.waClient = client;
      state.botStatus = 'Ready';
      state.isBotRunning = true;
      state.currentQR = '';
      state.pairingCode = '';
      state.emergencySent = false;
      resetWaRetryCount();

      addLog('info', '[WA] Client ready');
      if (ioRef) ioRef.emit('ready');

      try {
        let adminWa = process.env.ADMIN_WA_NUMBER || null;
        if (!adminWa) {
          const supabase = getSupabase();
          if (supabase) {
            const { data: adminProfile } = await supabase
              .from('user_profiles').select('admin_wa_number')
              .not('admin_wa_number', 'is', null).limit(1).single() as any;
            if (adminProfile?.admin_wa_number) adminWa = adminProfile.admin_wa_number;
          }
        }
        if (adminWa) {
          const target = adminWa.includes('@') ? adminWa : `${adminWa.replace(/[^0-9]/g, '')}@c.us`;
          const downtime = lastDisconnectAt ? `\n⏱️ Downtime: ${Math.round((Date.now() - lastDisconnectAt) / 1000)} detik` : '';
          await client.sendMessage(target, `✅ *Tata Business Suite*\nBot WhatsApp siap digunakan!${downtime}\n🕐 ${new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' } as any)}`);
        }
      } catch { }

      lastDisconnectAt = 0;
      try { await saveSessionDirToDB('default'); } catch { }
      if (sessionBackupTimer) clearInterval(sessionBackupTimer);
      sessionBackupTimer = setInterval(() => {
        saveSessionDirToDB('default').catch(() => {});
      }, 300_000); // every 5 minutes
      state.isInitializing = false;

      // Monitor Puppeteer page for crashes → set clientReady false agar scheduler skip jobs
      const pupPage = (client as any).pupPage;
      if (pupPage) {
        pupPage.on('error', (err: Error) => {
          addLog('error', `[WA] Puppeteer page error: ${err.message}`);
          state.clientReady = false;
        });
        pupPage.on('pageerror', (err: Error) => {
          addLog('error', `[WA] Puppeteer page runtime error: ${err.message}`);
          state.clientReady = false;
        });
        pupPage.on('crash', () => {
          addLog('error', '[WA] Puppeteer page crashed!');
          state.clientReady = false;
        });
        pupPage.on('close', () => {
          addLog('warn', '[WA] Puppeteer page closed');
          state.clientReady = false;
        });
      }

      // Periodic health check — detect zombie page where evaluate silently fails
      if (healthCheckTimer) clearInterval(healthCheckTimer);
      healthCheckTimer = setInterval(async () => {
        try {
          const pp = (client as any).pupPage;
          if (!pp || pp.isClosed()) {
            addLog('warn', '[WA] Health check — page closed, scheduling reconnect');
            state.clientReady = false;
            safeDestroyClient().then(() => scheduleRetry(2000));
            return;
          }
          await pp.evaluate('1+1');
        } catch {
          addLog('warn', '[WA] Health check — page evaluate failed, execution context destroyed');
          state.clientReady = false;
          safeDestroyClient().then(() => scheduleRetry(2000));
        }
      }, 60_000);
    });

    client.on('message', async (msg: any) => {
      try {
        const { handleMessage } = require('../handlers/message');
        await handleMessage(msg, client);
      } catch (err: any) { addLog('error', `[WA] handleMessage error: ${err.stack || err.message}`); }
    });

    client.on('disconnected', async (reason: string) => {
      addLog('warn', `[WA] Disconnected: ${reason}`);
      lastDisconnectAt = Date.now();
      await safeDestroyClient();
      state.clientReady = false;
      state.botStatus = 'Disconnected';
      state.isBotRunning = false;
      if (ioRef) ioRef.emit('disconnected', reason);
      if (reason === 'LOGOUT') {
        if (Date.now() - lastDisconnectAlert > WA_ALERT_COOLDOWN) {
          lastDisconnectAlert = Date.now();
          sendEmergencyBroadcast(`WhatsApp disconnected — ${reason}`).catch(() => {});
        }
        return scheduleRetry(2000);
      }
      if (reason === 'REMOTE' || reason === 'NAVIGATION') return scheduleRetry(2000);
      try { await saveSessionDirToDB('default'); } catch { }
      return scheduleRetry(2000);
    });

    state.waClient = client;
    addLog('info', '[WA] Client initialization started...');

    function watchdogCheck() {
      if (!state.clientReady) {
        if (watchdogExtendedCount < WA_WATCHDOG_EXTEND_LIMIT) {
          watchdogExtendedCount++;
          addLog('warn', `[WA] Watchdog — client not ready after ${WA_WATCHDOG_TIMEOUT * (watchdogExtendedCount) / 1000}s total, extending (${watchdogExtendedCount}/${WA_WATCHDOG_EXTEND_LIMIT}) — browser tetap hidup`);
          watchdogTimer = setTimeout(watchdogCheck, WA_WATCHDOG_TIMEOUT);
          return;
        }
        addLog('warn', `[WA] Watchdog — client not ready after ${WA_WATCHDOG_TIMEOUT * (WA_WATCHDOG_EXTEND_LIMIT + 1) / 1000}s, restarting browser`);
        watchdogExtendedCount = 0;
        state.isInitializing = false;
        safeDestroyClient().then(() => {
          if (state.waRetryCount <= WA_MAX_RETRIES) {
            const delay = getWaRetryDelay();
            addLog('info', `[WA] Watchdog reconnect attempt ${state.waRetryCount}/${WA_MAX_RETRIES} in ${Math.round(delay / 1000)}s`);
            scheduleRetry(delay);
          } else {
            addLog('error', `[WA] Max retry (${WA_MAX_RETRIES}) reached via watchdog`);
            sendEmergencyBroadcast('WhatsApp gagal konek setelah watchdog timeout').catch(() => {});
            safeDestroyClient().then(() => {
              setTimeout(() => { state.waRetryCount = 0; state.emergencySent = false; initWhatsApp(); }, 60_000);
            });
          }
        });
      }
    }
    watchdogTimer = setTimeout(watchdogCheck, WA_WATCHDOG_TIMEOUT);

    client.initialize().catch((err: Error) => {
      state.isInitializing = false;
      state.botStatus = 'ERROR';
      addLog('error', `[WA] initialize failed (async): ${err.message}`);
      if (state.waRetryCount <= WA_MAX_RETRIES) {
        const delay = getWaRetryDelay();
        addLog('info', `[WA] Reconnect attempt ${state.waRetryCount}/${WA_MAX_RETRIES} in ${Math.round(delay / 1000)}s`);
        safeDestroyClient().then(() => scheduleRetry(delay));
      } else {
        addLog('error', `[WA] Max retry (${WA_MAX_RETRIES}) reached`);
        sendEmergencyBroadcast(`WhatsApp gagal konek setelah ${WA_MAX_RETRIES} kali percobaan`).catch(() => {});
        safeDestroyClient().then(() => {
          addLog('info', '[WA] Full reset scheduled in 60s');
          setTimeout(() => { state.waRetryCount = 0; state.emergencySent = false; initWhatsApp(); }, 60_000);
        });
      }
    });
  } catch (err: any) {
    state.isInitializing = false;
    state.botStatus = 'ERROR';
    addLog('error', `[WA] Init error: ${err.message}`);
    const delay = getWaRetryDelay();
    if (state.waRetryCount <= WA_MAX_RETRIES) {
      addLog('info', `[WA] Reconnect attempt ${state.waRetryCount}/${WA_MAX_RETRIES} in ${Math.round(delay / 1000)}s`);
      await safeDestroyClient();
      scheduleRetry(delay);
    } else {
      addLog('error', `[WA] Max retry (${WA_MAX_RETRIES}) reached — attempting full session reset`);
      sendEmergencyBroadcast(`WhatsApp gagal konek setelah ${WA_MAX_RETRIES} kali percobaan — session reset`).catch(() => {});
      await safeDestroyClient();
      addLog('info', '[WA] Full reset scheduled in 60s');
      setTimeout(() => { state.waRetryCount = 0; state.emergencySent = false; initWhatsApp(); }, 60_000);
    }
  }
}

function healthCheck(): void {
  if (state.clientReady || state.isInitializing || retryTimer) return;
  if (state.waRetryCount > WA_MAX_RETRIES) return;
  const since = lastDisconnectAt ? `${Math.round((Date.now() - lastDisconnectAt) / 1000)}s sejak disconnect` : 'unknown state';
  addLog('warn', `[HEALTH] WA not ready (${since}) — triggering reconnect`);
  initWhatsApp();
}

export { initWhatsApp, safeDestroyClient, scheduleRetry, getWaRetryDelay, resetWaRetryCount, setIOref, healthCheck };
