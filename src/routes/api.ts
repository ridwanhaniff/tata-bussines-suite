import express, { Request, Response, NextFunction } from 'express';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';

import supabase, { pgPool } from '../config/supabase';
import { state, addLog, getIO } from '../config/state';
import { DAY_MS } from '../config/constants';
import { cacheGet, cacheSet, cacheInvalidate } from '../config/cache';
import { circuitIsOpen, circuitRecordSuccess, circuitRecordFailure } from '../services/circuit-breaker';
import { sanitizeError } from '../utils/errors';
import { syncInventory } from '../utils/inventory';
import { apiSuccess, apiError, apiSuccessPaginated } from '../utils/api-response';
import { ErrorCode } from '../types/errors';
import { validate } from '../middleware/validate';
import {
  waAuthSchema,
  movementSchema,
  pembukuanSchema,
  hutangSchema,
  productCreateSchema,
  pairingCodeSchema,
  maintenanceSchema,
  updateUserStatusSchema,
  broadcastSchema,
  settingUpdateSchema,
  salesReturnSchema,
  purchaseReturnSchema,
  opnameCreateSchema,
  opnameDetailSchema,
  materialCreateSchema,
  recipeUpsertSchema,

} from './schemas';
import qrcode from 'qrcode';
import * as stockManager from '../utils/stockManager';
import accountingEngine from '../utils/accountingEngine';
import * as transactionRecorder from '../utils/transactionRecorder';
import { generateExcel } from '../utils/excelExport';
import { setupDemoAccount } from '../utils/demoSetup';
import { withTransaction } from '../utils/db';
import { checkDemoTransactionLimit } from '../utils/helpers';

const router = express.Router();

interface StockRequest extends Request {
  stockUser?: any;
  stockUserId?: string;
}

function isAdmin(req: Request, res: Response, next: NextFunction): void {
  if (req.session && (req.session as any).authenticated) return next();
  if (req.xhr || req.headers.accept?.includes('application/json') || req.path.startsWith('/api/')) {
    apiError(res, 'Unauthorized', ErrorCode.AUTH_INVALID, 401);
    return;
  }
  res.redirect('/login');
}

async function stockAuth(req: StockRequest, res: Response, next: NextFunction): Promise<void> {
  if (req.stockUser) {
    next();
    return;
  }
  const token =
    req.query.token ||
    (Array.isArray(req.headers['x-stock-token']) ? req.headers['x-stock-token'][0] : req.headers['x-stock-token']);
  if (!token) {
    apiError(res, 'Token wajib', ErrorCode.AUTH_INVALID, 401);
    return;
  }
  if (circuitIsOpen()) {
    apiError(res, 'Database sedang sibuk. Coba lagi sebentar.', ErrorCode.DB_ERROR, 503);
    return;
  }

  try {
    let user: any = null;
    const { data: supabaseUser, error } = (await supabase
      .from('users')
      .select('id, store_name, status, dashboard_token')
      .eq('dashboard_token', token)
      .maybeSingle()) as any;
    if (error) {
      const errMsg = sanitizeError(error);
      addLog('error', `[AUTH] Supabase SDK gagal query users: ${errMsg} — fallback ke pgPool...`);
      if (errMsg.includes('[SUPABASE ERROR]')) circuitRecordFailure();
      if (pgPool) {
        try {
          const pgResult = await pgPool.query(
            `SELECT id, store_name, status, dashboard_token FROM users WHERE dashboard_token = $1 LIMIT 1`,
            [token],
          );
          if (pgResult.rows.length > 0) {
            user = pgResult.rows[0];
            addLog('info', `[AUTH] Fallback pgPool sukses untuk user ${user.id}`);
          }
        } catch (pgErr: any) {
          addLog('error', `[AUTH] Fallback pgPool juga gagal: ${sanitizeError(pgErr)}`);
        }
      }
      if (!user) {
        apiError(res, 'Token tidak valid', ErrorCode.AUTH_INVALID, 401);
        return;
      }
    } else {
      user = supabaseUser;
    }
    if (!user) {
      apiError(res, 'Token tidak valid atau sudah kadaluarsa', ErrorCode.AUTH_INVALID, 401);
      return;
    }
    circuitRecordSuccess();
    req.stockUser = user;
    req.stockUserId = user.id;
    if (pgPool) {
      pgPool.query('SELECT set_config($1, $2, true)', ['app.user_id', user.id]).catch(() => {});
    }
    next();
  } catch (e: any) {
    const errMsg = sanitizeError(e);
    if (errMsg.includes('[SUPABASE ERROR]')) circuitRecordFailure();
    apiError(res, 'Auth gagal', ErrorCode.AUTH_INVALID, 401);
  }
}

// Middleware: blokir akses laporan & fitur PRO untuk user demo
const RESTRICTED_REPORT_PATHS = [
  '/api/stock/laba-rugi',
  '/api/stock/neraca',
  '/api/stock/general-ledger',
  '/api/stock/trial-balance',
  '/api/stock/cashflow',
  '/api/stock/report',
  '/api/stock/channels',
  '/api/stock/jurnal',
  '/api/stock/coa',
  '/api/stock/pembukuan',
  '/api/stock/piutang',
  '/api/stock/hutang',
];

async function checkDemoAccess(req: StockRequest, res: Response, next: NextFunction) {
  if (req.stockUser?.status === 'demo') {
    const blocked = RESTRICTED_REPORT_PATHS.some((p) => req.path.startsWith(p));
    if (blocked) {
      apiError(res, 'Fitur terbatas untuk demo. Upgrade ke PRO untuk akses penuh!', ErrorCode.UPGRADE_REQUIRED, 403);
      return;
    }
  }
  next();
}

// Apply demo access check to restricted stock routes
router.use('/api/stock/laba-rugi', stockAuth, checkDemoAccess);
router.use('/api/stock/neraca', stockAuth, checkDemoAccess);
router.use('/api/stock/general-ledger', stockAuth, checkDemoAccess);
router.use('/api/stock/trial-balance', stockAuth, checkDemoAccess);
router.use('/api/stock/cashflow', stockAuth, checkDemoAccess);
router.use('/api/stock/report', stockAuth, checkDemoAccess);
router.use('/api/stock/channels', stockAuth, checkDemoAccess);
router.use('/api/stock/jurnal', stockAuth, checkDemoAccess);
router.use('/api/stock/coa', stockAuth, checkDemoAccess);
router.use('/api/stock/pembukuan', stockAuth, checkDemoAccess);
router.use('/api/stock/piutang', stockAuth, checkDemoAccess);
router.use('/api/stock/hutang', stockAuth, checkDemoAccess);

const MAX_STR_LEN = 255;

function requireBody(...fields: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const missing = fields.filter((f) => {
      const val = (req.body as any)[f];
      return val === undefined || val === null || (typeof val === 'string' && !val.trim());
    });
    if (missing.length) {
      apiError(res, `Parameter wajib: ${missing.join(', ')}`, ErrorCode.VALIDATION, 400);
      return;
    }
    next();
  };
}

function sanitizeString(val: any, maxLen = MAX_STR_LEN): string {
  if (typeof val !== 'string') return '';
  return val.trim().slice(0, maxLen);
}

router.get('/api/admin/users', isAdmin, async (req: Request, res: Response) => {
  try {
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(100, parseInt(req.query.limit as string) || 20);
    const search = ((req.query.search as string) || '').trim();
    const status = (req.query.status as string) || 'all';

    let query: any = supabase.from('users').select('*', { count: 'exact' });
    if (status !== 'all') query = query.eq('status', status);
    if (search) {
      const safeSearch = search.replace(/[%_(),.]/g, '');
      query = query.or(`store_name.ilike.%${safeSearch}%,id.ilike.%${safeSearch}%`);
    }
    const { data, error, count } = await query
      .order('created_at', { ascending: false })
      .range((page - 1) * limit, page * limit - 1);
    if (error) throw error;
    apiSuccess(res, {
      users: data || [],
      meta: { page, limit, total: count || 0, totalPages: Math.ceil((count || 0) / limit) },
    });
  } catch (err: any) {
    apiError(res, sanitizeError(err), ErrorCode.INTERNAL, 500);
  }
});

router.post(
  '/api/admin/user/:id/status',
  isAdmin,
  validate(updateUserStatusSchema),
  async (req: Request, res: Response) => {
    const { id } = req.params;
    const { status } = req.body;
    try {
      const updates: any = {
        status,
        upgrade_notified: false,
        is_upgrading: false,
        upgrade_package: null,
        subscription_expires_at: status === 'pro' ? new Date(Date.now() + 30 * DAY_MS).toISOString() : null,
      };
      const { error } = (await supabase.from('users').update(updates).eq('id', id)) as any;
      if (error) throw error;
      if (state.clientReady && state.waClient) {
        const notifs: Record<string, string> = {
          demo: 'ℹ️ Status akun Anda diubah ke DEMO (5 transaksi/hari).',
          pro: '🎉 Selamat! Akun PRO aktif 30 hari. ⭐',
          unlimited: '💎 Selamat! Akun UNLIMITED aktif seumur hidup!',
        };
        state.waClient
          .sendMessage(id, notifs[status])
          .catch((e: any) => addLog('warn', `WA notif gagal: ${e.message}`));
      }
      addLog('info', `User ${id} → ${status}`);
      const io = getIO();
      if (io) io.emit('user_updated', { id, status });
      apiSuccess(res, { status });
    } catch (err: any) {
      apiError(res, sanitizeError(err), ErrorCode.INTERNAL, 500);
    }
  },
);

router.post('/api/admin/maintenance', isAdmin, validate(maintenanceSchema), async (req: Request, res: Response) => {
  const { enabled } = req.body;
  try {
    (await supabase.from('settings').upsert({ key: 'maintenance_mode', value: String(Boolean(enabled)) })) as any;
    state.maintenanceMode = Boolean(enabled);
    addLog('info', `Maintenance: ${state.maintenanceMode ? 'ON' : 'OFF'}`);
    apiSuccess(res, { maintenance: state.maintenanceMode });
  } catch (err: any) {
    apiError(res, sanitizeError(err), ErrorCode.INTERNAL, 500);
  }
});

router.post('/api/admin/broadcast', isAdmin, validate(broadcastSchema), async (req: Request, res: Response) => {
  const { message, target } = req.body;
  if (!state.clientReady || !state.waClient) {
    apiError(res, 'Bot belum online', ErrorCode.UPGRADE_REQUIRED, 503);
    return;
  }
  try {
    let query: any = supabase.from('users').select('id, store_name');
    if (target && target !== 'all') query = query.eq('status', target);
    const { data: users, error } = await query;
    if (error) throw error;
    const jobId = Date.now().toString();
    const job: any = { id: jobId, total: users.length, sent: 0, failed: 0, status: 'running', target: target || 'all' };
    (state.activeBroadcasts as Map<string, any>).set(jobId, job);
    processBroadcast(jobId, users, message);
    addLog('info', `Broadcast dimulai → ${users.length} user`);
    apiSuccess(res, { jobId, total: users.length });
  } catch (err: any) {
    apiError(res, sanitizeError(err), ErrorCode.INTERNAL, 500);
  }
});

async function processBroadcast(jobId: string, users: any[], message: string): Promise<void> {
  const ab = state.activeBroadcasts as Map<string, any>;
  const job = ab.get(jobId);
  const io = getIO();
  let firstError: string | null = null;
  for (let i = 0; i < users.length; i++) {
    try {
      const text = message.replace(/\{nama\}/gi, users[i].store_name).replace(/\{nama_toko\}/gi, users[i].store_name);
      if (state.waClient) await state.waClient.sendMessage(users[i].id, text);
      job.sent++;
    } catch (err: any) {
      job.failed++;
      if (!firstError) firstError = err.message || String(err);
    }
    if (i % 5 === 0 || i === users.length - 1) {
      job.progress = Math.round(((i + 1) / users.length) * 100);
      if (io)
        io.emit('broadcast_progress', {
          jobId,
          current: i + 1,
          total: users.length,
          sent: job.sent,
          failed: job.failed,
        });
    }
    await new Promise((r) => setTimeout(r, 1200));
  }
  job.status = 'completed';
  job.completedAt = new Date().toISOString();
  if (io) io.emit('broadcast_complete', { jobId, ...job });
  addLog(
    'info',
    `Broadcast selesai: ${job.sent} terkirim, ${job.failed} gagal${firstError ? ` (error: ${firstError})` : ''}`,
  );
}

router.post('/api/admin/pairing-code', isAdmin, validate(pairingCodeSchema), async (req: Request, res: Response) => {
  const { phoneNumber } = req.body;
  if (!state.waClient) {
    apiError(res, 'Sistem WhatsApp belum siap.', ErrorCode.UPGRADE_REQUIRED, 503);
    return;
  }
  if (state.clientReady) {
    apiError(res, 'Bot sudah online.', ErrorCode.UPGRADE_REQUIRED, 400);
    return;
  }
  try {
    const cleanNumber = phoneNumber.replace(/[^0-9]/g, '');
    const code = await state.waClient.requestPairingCode(cleanNumber);
    state.pairingCode = code;
    (state as any).botStatus = 'Menunggu Tautan Pairing';
    addLog('info', `Pairing code digenerate: ${code} untuk ${cleanNumber}`);
    const io = getIO();
    if (io)
      io.emit('bot_update', {
        botStatus: state.botStatus,
        currentQR: state.currentQR,
        pairingCode: state.pairingCode,
        clientReady: false,
      });
    apiSuccess(res, { code });
  } catch (err: any) {
    addLog('error', `Gagal pairing code: ${err.message}`);
    apiError(res, 'Gagal meminta kode pairing. Coba gunakan QR atau restart bot.', ErrorCode.INTERNAL, 500);
  }
});

router.get('/api/admin/status', isAdmin, (req: Request, res: Response) => {
  apiSuccess(res, {
    botStatus: state.botStatus,
    clientReady: state.clientReady,
    currentQR: state.currentQR,
    pairingCode: state.pairingCode,
    maintenance: state.maintenanceMode,
  });
});

router.get('/api/admin/qr-image', isAdmin, async (req: Request, res: Response) => {
  const raw = state.currentQR;
  if (!raw) {
    apiError(res, 'Tidak ada QR code tersedia.', ErrorCode.NOT_FOUND, 404);
    return;
  }
  try {
    const pairingCode = await qrcode.toDataURL(raw);
    state.pairingCode = pairingCode;
    apiSuccess(res, { pairingCode });
  } catch (err: any) {
    addLog('error', '[API] Gagal generate QR image: ' + (err?.message || err));
    apiError(res, 'Gagal generate QR image.', ErrorCode.INTERNAL, 500);
  }
});

router.post('/api/admin/seed-demo', isAdmin, async (_req: Request, res: Response) => {
  try {
    const { seedDemo, DEMO_SLUG, DEMO_TOKEN, DEMO_STORE } = require('../scripts/seed-demo');
    await seedDemo();
    addLog('info', '[SEED] Demo data seeded via admin panel');
    apiSuccess(res, {
      log: [`URL: /stock/${DEMO_SLUG}?token=${DEMO_TOKEN}`, `Token: ${DEMO_TOKEN}`, `Store: ${DEMO_STORE}`],
    });
  } catch (err: any) {
    addLog('error', `[SEED] Gagal: ${err.message}`);
    apiError(res, sanitizeError(err), ErrorCode.INTERNAL, 500);
  }
});

router.post('/api/admin/test-bot', isAdmin, async (req: Request, res: Response) => {
  const targetNumber = req.body.targetNumber || process.env.STOCK_UID || '58360586100825@lid';
  const scenario = req.body.scenario || 'all';
  const testScenarios = [
    {
      name: 'A. Salam & Sapaan',
      messages: [
        { input: 'halo', expectedReply: 'Menu bantuan / panduan' },
        { input: 'pagi', expectedReply: 'Menu bantuan / panduan' },
        { input: 'test', expectedReply: 'Menu bantuan / panduan' },
      ],
    },
    {
      name: 'B. Status & Info Akun',
      messages: [
        { input: 'status', expectedReply: 'Info akun + status langganan' },
        { input: 'info', expectedReply: 'Info akun + status langganan' },
        { input: 'saldo', expectedReply: 'Info akun + status langganan' },
      ],
    },
    {
      name: 'C. Laporan',
      messages: [
        { input: 'laporan', expectedReply: 'Laporan harian (transaksi masuk/keluar)' },
        { input: 'rekap', expectedReply: 'Laporan harian' },
      ],
    },
    {
      name: 'D. Bantuan & Menu',
      messages: [
        { input: 'bantuan', expectedReply: 'Panduan lengkap bot' },
        { input: 'help', expectedReply: 'Panduan lengkap bot' },
        { input: '?', expectedReply: 'Panduan lengkap bot' },
        { input: '1', expectedReply: 'Menu catat transaksi' },
        { input: '2', expectedReply: 'Laporan hari ini' },
        { input: '3', expectedReply: 'Status akun' },
        { input: '4', expectedReply: 'Bantuan & panduan' },
      ],
    },
    {
      name: 'E. Transaksi Masuk (Interaktif)',
      messages: [
        { input: 'masuk 15rb', expectedReply: '🤔 Produk mana? (product selection)' },
        { input: 'jual nasi goreng 25rb', expectedReply: '📋 Konfirmasi Transaksi (Ya/Batal)' },
        { input: 'laku roti 10000', expectedReply: '📋 Konfirmasi atau 🤔 Produk mana?' },
        { input: 'dapat bonus 5jt tunai', expectedReply: '📋 Konfirmasi Transaksi' },
        { input: 'terima transfer 200rb', expectedReply: '📋 Konfirmasi Transaksi' },
      ],
    },
    {
      name: 'F. Transaksi Keluar (Interaktif)',
      messages: [
        { input: 'keluar 50rb', expectedReply: '🤔 Produk mana? (product selection)' },
        { input: 'beli stok kopi 500rb', expectedReply: '📋 Konfirmasi Transaksi (Ya/Batal)' },
        { input: 'bayar sewa tempat 2jt', expectedReply: '📋 Konfirmasi atau 🤔 Produk mana?' },
        { input: 'gaji karyawan 3jt', expectedReply: '📋 Konfirmasi Transaksi' },
        { input: 'bensin pertamax 50rb', expectedReply: '📋 Konfirmasi Transaksi' },
      ],
    },
    {
      name: 'G. Typo & Double Command',
      messages: [
        { input: 'beli stock', expectedReply: 'Transaksi keluar (beli menang, bukan dashboard stock)' },
        { input: 'jual laporan', expectedReply: 'Transaksi masuk (jual menang, bukan laporan)' },
        { input: 'masuk keluar 15rb', expectedReply: 'Tipe ambigu → tanya user (Masuk/Keluar)' },
      ],
    },
    {
      name: 'H. Kasir / Sale Regex',
      messages: [
        { input: 'jual kopi 2', expectedReply: 'Kasir flow — cek stok & eksekusi' },
        { input: 'laku nasi goreng 3', expectedReply: 'Kasir flow' },
        { input: 'jual es teh manis 5', expectedReply: 'Kasir flow' },
      ],
    },
    {
      name: 'I. Tagihan (Auto-Invoice)',
      messages: [
        { input: 'tagih 150rb ke 08123456789', expectedReply: 'Invoice terkirim + PDF' },
        { input: 'tagih', expectedReply: 'Panduan format tagihan' },
      ],
    },
    {
      name: 'J. Bank Profile',
      messages: [
        { input: 'setbank BCA 8670662536 Hanan', expectedReply: 'Bank profile tersimpan' },
        { input: 'setbank', expectedReply: 'Panduan format setbank' },
      ],
    },
    {
      name: 'K. Upgrade & Paket',
      messages: [
        { input: 'paket', expectedReply: 'Menu upgrade PRO/UNLIMITED' },
        { input: 'upgrade', expectedReply: 'Menu upgrade' },
      ],
    },
    {
      name: 'L. Dashboard & Stock',
      messages: [
        { input: 'dashboard', expectedReply: 'Link dashboard + token' },
        { input: 'link stok', expectedReply: 'Link dashboard + token' },
        { input: 'token baru', expectedReply: 'Token baru + link baru' },
      ],
    },
    {
      name: 'M. Catch-All (Pesan Tidak Dikenal)',
      messages: [
        { input: 'asdfghjkl', expectedReply: 'Maaf belum paham + panduan singkat' },
        { input: 'cuaca hari ini', expectedReply: 'Maaf belum paham + panduan singkat' },
      ],
    },
    {
      name: 'N. Konfirmasi & Batal',
      messages: [
        { input: 'ya', expectedReply: 'Jika ada konfirmasi pending → catat transaksi' },
        { input: 'batal', expectedReply: 'Batalkan proses yang sedang berjalan' },
        { input: 'cancel', expectedReply: 'Batalkan proses' },
      ],
    },
  ];
  let selectedScenarios = testScenarios;
  if (scenario !== 'all') {
    const found = testScenarios.find((s) => s.name.toLowerCase().includes(scenario.toLowerCase()));
    if (found) selectedScenarios = [found];
    else {
      apiError(
        res,
        `Scenario "${scenario}" not found. Available: ${testScenarios.map((s) => s.name).join(', ')}`,
        ErrorCode.VALIDATION,
        400,
      );
      return;
    }
  }
  let testMsg = `🧪 *TEST BOT — ${selectedScenarios.length} Skenario*\n━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
  for (const s of selectedScenarios) {
    testMsg += `*${s.name}*\n`;
    for (const m of s.messages) testMsg += `  📝 "${m.input}" → ${m.expectedReply}\n`;
    testMsg += '\n';
  }
  testMsg += `━━━━━━━━━━━━━━━━━━━━━━━\nTotal: ${selectedScenarios.reduce((sum: number, s: any) => sum + s.messages.length, 0)} test cases\nKirim pesan di atas ke bot untuk testing langsung.`;
  let waSent = false;
  if (state.clientReady && state.waClient) {
    try {
      await state.waClient.sendMessage(targetNumber, testMsg);
      waSent = true;
    } catch (e: any) {
      addLog('error', `[TEST-BOT] Failed to send WA: ${e.message}`);
    }
  }
  apiSuccess(res, {
    waSent,
    targetNumber,
    scenarios: selectedScenarios.length,
    totalTests: selectedScenarios.reduce((sum: number, s: any) => sum + s.messages.length, 0),
    testPlan: selectedScenarios,
    message: testMsg,
  });
});

router.get('/api/stock/verify', stockAuth, (req: StockRequest, res: Response) => {
  apiSuccess(res, { id: req.stockUser.id, store_name: req.stockUser.store_name, status: req.stockUser.status });
});

// ── WA Login: user logs in with their WA number to get their dashboard token ──
router.post('/api/stock/auth/wa', validate(waAuthSchema), async (req: Request, res: Response) => {
  const rawWa: string = (req.body.whatsapp || '')
    .toString()
    .trim()
    .replace(/[\s\-]/g, '');
  let normalized = rawWa;
  if (normalized.startsWith('0')) normalized = '62' + normalized.slice(1);
  if (!normalized.startsWith('62')) normalized = '62' + normalized;

  const candidateIds = [`${normalized}@c.us`, `${normalized}@s.whatsapp.net`, normalized, rawWa];

  try {
    // Search user by any of the candidate IDs
    const { data: user, error } = (await supabase
      .from('users')
      .select('id, store_name, status, dashboard_token')
      .in('id', candidateIds)
      .maybeSingle()) as any;

    if (error) {
      apiError(res, 'Terjadi kesalahan server', ErrorCode.DB_ERROR, 500);
      return;
    }

    if (!user) {
      apiError(
        res,
        'Nomor WhatsApp tidak terdaftar. Kirim pesan "Daftar" ke bot WhatsApp Tata untuk mendaftar terlebih dahulu.',
        ErrorCode.NOT_FOUND,
        404,
      );
      return;
    }

    if (!user.dashboard_token) {
      apiError(
        res,
        'Akun Anda belum memiliki token dashboard. Kirim pesan "Dashboard" ke bot WhatsApp Tata.',
        ErrorCode.UPGRADE_REQUIRED,
        403,
      );
      return;
    }

    apiSuccess(res, {
      token: user.dashboard_token,
      user: { id: user.id, store_name: user.store_name, status: user.status },
    });
  } catch (e: any) {
    apiError(res, sanitizeError(e), ErrorCode.INTERNAL, 500);
  }
});

// ── User Settings (active_channels, preferences) ──
router.get('/api/stock/settings', stockAuth, async (req: StockRequest, res: Response) => {
  const userId = req.stockUser!.id;
  try {
    const [{ data: userData, error: userErr }, { data: chData, error: chErr }] = await Promise.all([
      supabase.from('users').select('metadata').eq('id', userId).maybeSingle() as any,
      supabase
        .from('sales_channels')
        .select('name, coa_code, admin_fee_pct')
        .eq('user_id', userId)
        .eq('is_active', true) as any,
    ]);
    if (userErr) throw userErr;
    const settings = (userData?.metadata as any) || {};
    const channels = (chData || []).map((r: any) => ({
      name: r.name,
      coa_code: r.coa_code,
      admin_fee_pct: Number(r.admin_fee_pct) || 0,
    }));
    apiSuccess(res, { settings, channels });
  } catch (e: any) {
    apiError(res, sanitizeError(e), ErrorCode.INTERNAL, 500);
  }
});

router.post('/api/stock/settings', stockAuth, async (req: StockRequest, res: Response) => {
  const userId = req.stockUser!.id;
  const updates = req.body;
  if (!updates || typeof updates !== 'object') {
    apiError(res, 'Body tidak valid', ErrorCode.VALIDATION, 400);
    return;
  }
  try {
    // Merge metadata
    const { data: existing } = (await supabase.from('users').select('metadata').eq('id', userId).maybeSingle()) as any;
    const currentMeta = (existing?.metadata as any) || {};
    const { channel_fees, ...metaUpdates } = updates;
    const newMeta = { ...currentMeta, ...metaUpdates };
    const { error: metaErr } = (await supabase.from('users').update({ metadata: newMeta }).eq('id', userId)) as any;
    if (metaErr) throw metaErr;

    // Update channel fees in sales_channels
    if (Array.isArray(channel_fees)) {
      for (const cf of channel_fees) {
        if (!cf.name) continue;
        const feePct = Math.min(100, Math.max(0, Number(cf.admin_fee_pct) || 0));
        const { data: existing } = (await supabase
          .from('sales_channels')
          .select('id')
          .eq('user_id', userId)
          .eq('name', cf.name)
          .maybeSingle()) as any;
        if (existing) {
          (await supabase.from('sales_channels').update({ admin_fee_pct: feePct }).eq('id', existing.id)) as any;
        }
      }
    }

    apiSuccess(res, { settings: newMeta });
  } catch (e: any) {
    apiError(res, sanitizeError(e), ErrorCode.INTERNAL, 500);
  }
});

router.get('/api/stock/batch', stockAuth, async (req: StockRequest, res: Response) => {
  const userId = req.stockUser!.id;
  const batchCacheKey = `batch:${userId}`;
  const cached = cacheGet(batchCacheKey);
  if (cached) {
    apiSuccess(res, cached);
    return;
  }
  try {
    const [prodResult, movResult, alertResult] = await Promise.all([
      supabase
        .from('products')
        .select(
          'id, sku, name, category, unit, stock_current, stock_min, price_buy, price_sell, supplier, location, notes',
        )
        .eq('user_id', userId)
        .eq('is_active', true)
        .order('name', { ascending: true }),
      supabase
        .from('stock_movements')
        .select('*, products(id, sku, name, unit)')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(8),
      supabase
        .from('stock_alerts')
        .select('*, products(id, sku, name, unit, stock_current, stock_min)')
        .eq('user_id', userId)
        .is('resolved_at', null)
        .order('alerted_at', { ascending: false })
        .limit(10),
    ]);
    const products = (prodResult as any).data || [];
    const movements = (movResult as any).data || [];
    const alerts = (alertResult as any).data || [];
    let totalValue = 0,
      lowStock = 0,
      outStock = 0;
    const byCategory: Record<string, any> = {};
    products.forEach((p: any) => {
      const stock = parseFloat(p.stock_current) || 0;
      const min = parseFloat(p.stock_min) || 0;
      const val = stock * (parseFloat(p.price_buy) || 0);
      totalValue += val;
      if (stock <= 0) outStock++;
      else if (stock <= min) lowStock++;
      const cat = p.category || 'Umum';
      if (!byCategory[cat]) byCategory[cat] = { count: 0, value: 0 };
      byCategory[cat].count++;
      byCategory[cat].value += val;
    });
    const result = {
      products,
      summary: { total: products.length, active: products.length, totalValue, lowStock, outStock, byCategory, alerts },
      recentMovements: movements,
    };
    cacheSet(batchCacheKey, result, 45_000);
    apiSuccess(res, result);
  } catch (e: any) {
    apiError(res, sanitizeError(e), ErrorCode.INTERNAL, 500);
  }
});

router.get('/api/stock/summary', stockAuth, async (req: StockRequest, res: Response) => {
  const userId = req.stockUser!.id;
  const cacheKey = `summary:${userId}`;
  const cached = cacheGet(cacheKey);
  if (cached) {
    apiSuccess(res, cached);
    return;
  }
  try {
    const { data: products } = (await supabase
      .from('products')
      .select('id, category, stock_current, stock_min, price_buy, unit')
      .eq('user_id', userId)
      .eq('is_active', true)) as any;
    let totalValue = 0,
      lowStock = 0,
      outStock = 0;
    const byCategory: Record<string, any> = {};
    (products || []).forEach((p: any) => {
      const stock = parseFloat(p.stock_current) || 0;
      const min = parseFloat(p.stock_min) || 0;
      const val = stock * (parseFloat(p.price_buy) || 0);
      totalValue += val;
      if (stock <= 0) outStock++;
      else if (stock <= min) lowStock++;
      const cat = p.category || 'Umum';
      if (!byCategory[cat]) byCategory[cat] = { count: 0, value: 0 };
      byCategory[cat].count++;
      byCategory[cat].value += val;
    });
    const { data: alertData } = (await supabase
      .from('stock_alerts')
      .select('*, products(id, sku, name, unit, stock_current, stock_min)')
      .eq('user_id', userId)
      .is('resolved_at', null)
      .order('alerted_at', { ascending: false })
      .limit(10)) as any;
    const result = {
      total: (products || []).length,
      active: (products || []).length,
      totalValue,
      lowStock,
      outStock,
      byCategory,
      alerts: alertData || [],
    };
    cacheSet(cacheKey, result, 60_000);
    apiSuccess(res, result);
  } catch (e: any) {
    apiError(res, sanitizeError(e), ErrorCode.INTERNAL, 500);
  }
});

router.get('/api/stock/products', stockAuth, async (req: StockRequest, res: Response) => {
  const userId = req.stockUser!.id;
  const page = Math.max(1, parseInt(req.query.page as string) || 0);
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit as string) || 200));
  const search = ((req.query.search as string) || '').trim().toLowerCase();
  const category = (req.query.category as string) || '';
  const status = (req.query.status as string) || '';
  const sort = (req.query.sort as string) || 'name';

  const fromIdx = page > 0 ? (page - 1) * limit : 0;
  const toIdx = page > 0 ? page * limit - 1 : 0;

  try {
    let query: any = supabase
      .from('products')
      .select(
        'id, sku, name, category, unit, stock_current, stock_min, price_buy, price_sell, default_channel, image_url, channels, supplier, location, notes, is_active',
        { count: 'exact' },
      )
      .eq('user_id', userId)
      .eq('is_active', true);
    if (search) {
      const safeSearch = search.replace(/[%_(),.]/g, '');
      query = query.or(`name.ilike.%${safeSearch}%,sku.ilike.%${safeSearch}%`);
    }
    if (category) query = query.eq('category', category);
    if (status === 'out') query = query.lte('stock_current', 0);
    else if (status === 'low') query = query.gt('stock_current', 0).filter('stock_current', 'lte', 'stock_min');
    else if (status === 'ok') query = query.filter('stock_current', 'gt', 'stock_min');
    if (sort === 'stock_asc') query = query.order('stock_current', { ascending: true });
    else if (sort === 'stock_desc') query = query.order('stock_current', { ascending: false });
    else if (sort === 'value_desc') query = query.order('stock_current', { ascending: false });
    else query = query.order('name', { ascending: true });
    if (page > 0) query = query.range(fromIdx, toIdx);
    const { data, error, count } = await query;
    if (error) throw error;
    if (sort === 'value_desc' && data && page === 0)
      data.sort((a: any, b: any) => b.price_buy * b.stock_current - a.price_buy * a.stock_current);
    apiSuccess(res, { products: data || [], total: count || 0, page, limit });
  } catch (e: any) {
    const errMsg = sanitizeError(e);
    addLog('error', `[PRODUCTS] Supabase SDK error: ${errMsg} — fallback ke pg pool...`);

    // Fallback: direct pg query
    if (pgPool && userId) {
      try {
        const hasDefaultChannel = (await pgPool.query(
          `SELECT column_name FROM information_schema.columns WHERE table_name='products' AND column_name='default_channel'`,
        )).rows.length > 0;
        const cols = `id, sku, name, category, unit, stock_current, stock_min, price_buy, price_sell${hasDefaultChannel ? ', default_channel' : ''}, image_url, channels, supplier, location, notes, is_active`;
        let sql = `SELECT ${cols} FROM products WHERE user_id = $1 AND is_active = true`;
        const params: any[] = [userId];
        let paramIdx = 2;
        if (search) {
          const safe = search.replace(/[%_(),.]/g, '');
          sql += ` AND (name ILIKE $${paramIdx} OR sku ILIKE $${paramIdx})`;
          params.push(`%${safe}%`);
          paramIdx++;
        }
        if (category) { sql += ` AND category = $${paramIdx}`; params.push(category); paramIdx++; }
        if (status === 'out') { sql += ` AND stock_current <= 0`; }
        else if (status === 'low') { sql += ` AND stock_current > 0 AND stock_current <= stock_min`; }
        else if (status === 'ok') { sql += ` AND stock_current > stock_min`; }

        const countResult = await pgPool.query(`SELECT COUNT(*) FROM (${sql}) sub`, params);
        const total = parseInt(countResult.rows[0]?.count || '0', 10);

        if (sort === 'stock_asc') sql += ` ORDER BY stock_current ASC`;
        else if (sort === 'stock_desc') sql += ` ORDER BY stock_current DESC`;
        else if (sort === 'value_desc') sql += ` ORDER BY (price_buy * stock_current) DESC`;
        else sql += ` ORDER BY name ASC`;

        if (page > 0) {
          sql += ` LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`;
          params.push(limit, fromIdx);
          paramIdx += 2;
        }

        const result = await pgPool.query(sql, params);
        addLog('info', `[PRODUCTS] Fallback pg pool sukses — ${total} produk`);
        apiSuccess(res, { products: result.rows || [], total, page, limit });
        return;
      } catch (pgErr: any) {
        const pgMsg = sanitizeError(pgErr);
        addLog('error', `[PRODUCTS] Fallback pg pool juga gagal: ${pgMsg}`);
      }
    }

    apiError(res, errMsg, ErrorCode.INTERNAL, 500);
  }
});

router.post('/api/stock/products', stockAuth, requireBody('name'), validate(productCreateSchema), async (req: StockRequest, res: Response) => {
  const userId = req.stockUser!.id;

  // Demo: maksimal 3 produk
  if (req.stockUser?.status === 'demo') {
    const { count } = (await supabase
      .from('products')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)) as any;
    if (count >= 3) {
      apiError(
        res,
        'Demo terbatas 3 produk. Upgrade ke PRO untuk produk tak terbatas!',
        ErrorCode.UPGRADE_REQUIRED,
        403,
      );
      return;
    }
  }

  const name = sanitizeString(req.body.name, 150);
  const sku = sanitizeString(req.body.sku, 50);
  const category = sanitizeString(req.body.category, 50);
  const unit = sanitizeString(req.body.unit, 20);
  const supplier = sanitizeString(req.body.supplier, 100);
  const location = sanitizeString(req.body.location, 100);
  const notes = sanitizeString(req.body.notes, 500);
  const defaultChannel = sanitizeString(req.body.default_channel, 30);
  const channels: string[] = Array.isArray(req.body.channels) ? req.body.channels.map((c: string) => sanitizeString(c, 30)).filter(Boolean) : [];
  const priceBuy = req.body.price_buy ?? req.body.priceBuy;
  const priceSell = req.body.price_sell ?? req.body.priceSell;
  const stockInitial = req.body.stock_initial ?? req.body.stockInitial;
  const stockMin = req.body.stock_min ?? req.body.stockMin;
  try {
    const result = await stockManager.addProduct(userId, {
      sku,
      name,
      category,
      unit,
      supplier,
      location,
      defaultChannel,
      channels,
      priceBuy: parseFloat(priceBuy) || 0,
      priceSell: parseFloat(priceSell) || 0,
      stockInitial: parseFloat(stockInitial) || 0,
      stockMin: parseFloat(stockMin) || 0,
      description: notes,
    });
    if (!result.success) {
      apiError(res, sanitizeError(result.error!));
      return;
    }
    const newProduct = result.product as any;
    // Jurnal stok awal
    const initStock = parseFloat(stockInitial) || 0;
    const initPrice = parseFloat(priceBuy) || parseFloat(newProduct.price_buy) || 0;
    if (initStock > 0 && initPrice > 0) {
      try {
        const { data: initMov } = (await supabase
          .from('stock_movements')
          .select('id')
          .eq('user_id', userId)
          .eq('product_id', newProduct.id)
          .eq('reference_type', 'initial')
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle()) as any;
        if (initMov) {
          await withTransaction(async (client) => {
            await accountingEngine.insertJournalViaClient(client, userId, {
              referenceType: 'stock_initial',
              referenceId: String(initMov.id),
              description: `Stok Awal ${initStock} ${newProduct.unit}: ${newProduct.name}`,
              lines: [
                { accountCode: '1201', debit: initStock * initPrice, credit: 0, description: 'Penambahan inventori' },
                { accountCode: '3101', debit: 0, credit: initStock * initPrice, description: 'Modal inventori' },
              ],
            });
          });
        }
      } catch (jErr: any) {
        addLog('error', '[PRODUCT] Gagal bikin jurnal stok awal: ' + jErr.message);
      }
    }
    cacheInvalidate(userId);
    apiSuccess(res, { product: result.product });
  } catch (e: any) {
    apiError(res, sanitizeError(e), ErrorCode.INTERNAL, 500);
  }
});

router.put('/api/stock/products/:productId', stockAuth, async (req: StockRequest, res: Response) => {
  const userId = req.stockUser!.id;
  const { productId } = req.params;
  const name = sanitizeString(req.body.name, 150);
  const category = sanitizeString(req.body.category, 50);
  const unit = sanitizeString(req.body.unit, 20);
  const supplier = sanitizeString(req.body.supplier, 100);
  const location = sanitizeString(req.body.location, 100);
  const notes = sanitizeString(req.body.notes, 500);
  const defaultChannel = sanitizeString(req.body.default_channel, 30);
  const channels: string[] = Array.isArray(req.body.channels) ? req.body.channels.map((c: string) => sanitizeString(c, 30)).filter(Boolean) : [];
  const { price_buy, price_sell, stock_min } = req.body;
  try {
    const { error } = (await supabase
      .from('products')
      .update({
        name,
        category,
        unit,
        price_buy: parseFloat(price_buy) || 0,
        price_sell: parseFloat(price_sell) || 0,
        stock_min: parseFloat(stock_min) || 0,
        supplier,
        location,
        notes,
        default_channel: defaultChannel || '',
        channels,
      })
      .eq('id', productId)
      .eq('user_id', userId)) as any;
    if (error) throw error;
    cacheInvalidate(userId);
    apiSuccess(res, {});
  } catch (e: any) {
    apiError(res, sanitizeError(e), ErrorCode.INTERNAL, 500);
  }
});

router.delete('/api/stock/products/:productId', stockAuth, async (req: StockRequest, res: Response) => {
  const userId = req.stockUser!.id;
  try {
    const result = await stockManager.deleteProduct(userId, String(req.params.productId));
    if (!result.success) {
      apiError(res, sanitizeError(result.error) || 'Gagal', ErrorCode.VALIDATION, 400);
      return;
    }
    cacheInvalidate(userId);
    apiSuccess(res, { success: true });
  } catch (e: any) {
    apiError(res, sanitizeError(e), ErrorCode.INTERNAL, 500);
  }
});

// ── Product Image ──
router.post('/api/stock/products/:productId/image', stockAuth, async (req: StockRequest, res: Response) => {
  const userId = req.stockUser!.id;
  const productId = String(req.params.productId);
  const { image_base64 } = req.body;
  try {
    if (!image_base64) {
      // Remove image
      const { data: prod } = await supabase.from('products').select('image_url').eq('id', productId).eq('user_id', userId).maybeSingle() as any;
      if (prod?.image_url) {
        const oldPath = prod.image_url.split('/public/')[1] || '';
        if (oldPath) await supabase.storage.from('product-images').remove([oldPath]);
      }
      await supabase.from('products').update({ image_url: null }).eq('id', productId).eq('user_id', userId) as any;
      apiSuccess(res, { image_url: null });
      return;
    }
    // Decode base64 → buffer
    const matches = image_base64.match(/^data:image\/([\w]+);base64,(.+)$/);
    if (!matches) { apiError(res, 'Format gambar tidak valid'); return; }
    const ext = matches[1] === 'jpeg' ? 'jpg' : matches[1];
    const buffer = Buffer.from(matches[2], 'base64');
    if (buffer.length > 2 * 1024 * 1024) { apiError(res, 'Gambar maksimal 2MB'); return; }
    // Upload to Supabase Storage
    const filePath = `${userId}/${productId}.${ext}`;
    // Remove old file first
    const { data: oldProd } = await supabase.from('products').select('image_url').eq('id', productId).eq('user_id', userId).maybeSingle() as any;
    if (oldProd?.image_url) {
      const oldPath = oldProd.image_url.split('/public/')[1] || '';
      if (oldPath) await supabase.storage.from('product-images').remove([oldPath]).catch(() => {});
    }
    const { error: uploadErr } = await supabase.storage.from('product-images').upload(filePath, buffer, {
      contentType: `image/${ext}`,
      upsert: true,
    }) as any;
    if (uploadErr) { apiError(res, `Gagal upload: ${sanitizeError(uploadErr)}`); return; }
    const { data: pubUrl } = supabase.storage.from('product-images').getPublicUrl(filePath) as any;
    const imageUrl = pubUrl?.publicUrl || `${process.env.SUPABASE_URL}/storage/v1/object/public/product-images/${filePath}`;
    await supabase.from('products').update({ image_url: imageUrl }).eq('id', productId).eq('user_id', userId) as any;
    apiSuccess(res, { image_url: imageUrl });
  } catch (e: any) {
    apiError(res, sanitizeError(e), ErrorCode.INTERNAL, 500);
  }
});

// ── BOM / Materials ──

router.get('/api/stock/materials', stockAuth, async (req: StockRequest, res: Response) => {
  const userId = req.stockUser!.id;
  try {
    const result = await stockManager.listMaterials(userId);
    if (!result.success) { apiError(res, sanitizeError(result.error) || 'Gagal', ErrorCode.INTERNAL, 500); return; }
    apiSuccess(res, { materials: result.materials || [] });
  } catch (e: any) {
    apiError(res, sanitizeError(e), ErrorCode.INTERNAL, 500);
  }
});

router.post('/api/stock/materials', stockAuth, requireBody('name'), validate(materialCreateSchema), async (req: StockRequest, res: Response) => {
  const userId = req.stockUser!.id;
  const { name, unit, stock_current, stock_min, cost_per_unit } = req.body;
  try {
    const result = await stockManager.addMaterial(userId, {
      name: sanitizeString(name),
      unit: unit || 'pcs',
      stockCurrent: stock_current,
      stockMin: stock_min,
      costPerUnit: cost_per_unit,
    });
    if (!result.success) { apiError(res, sanitizeError(result.error) || 'Gagal', ErrorCode.VALIDATION, 400); return; }
    apiSuccess(res, { material: result.material });
  } catch (e: any) {
    apiError(res, sanitizeError(e), ErrorCode.INTERNAL, 500);
  }
});

router.put('/api/stock/materials/:materialId', stockAuth, async (req: StockRequest, res: Response) => {
  const userId = req.stockUser!.id;
  try {
    const result = await stockManager.updateMaterial(userId, String(req.params.materialId), {
      name: req.body.name ? sanitizeString(req.body.name) : undefined,
      unit: req.body.unit || undefined,
      stockCurrent: req.body.stock_current !== undefined ? Number(req.body.stock_current) : undefined,
      stockMin: req.body.stock_min !== undefined ? Number(req.body.stock_min) : undefined,
      costPerUnit: req.body.cost_per_unit !== undefined ? Number(req.body.cost_per_unit) : undefined,
    });
    if (!result.success) { apiError(res, sanitizeError(result.error) || 'Gagal', ErrorCode.VALIDATION, 400); return; }
    apiSuccess(res, { material: result.material });
  } catch (e: any) {
    apiError(res, sanitizeError(e), ErrorCode.INTERNAL, 500);
  }
});

router.delete('/api/stock/materials/:materialId', stockAuth, async (req: StockRequest, res: Response) => {
  const userId = req.stockUser!.id;
  try {
    const result = await stockManager.deleteMaterial(userId, String(req.params.materialId));
    if (!result.success) { apiError(res, sanitizeError(result.error) || 'Gagal', ErrorCode.VALIDATION, 400); return; }
    apiSuccess(res, { success: true });
  } catch (e: any) {
    apiError(res, sanitizeError(e), ErrorCode.INTERNAL, 500);
  }
});

// ── BOM Recipes ──

router.get('/api/stock/materials/recipes', stockAuth, async (req: StockRequest, res: Response) => {
  const userId = req.stockUser!.id;
  const productId = req.query.product_id as string | undefined;
  try {
    const result = productId
      ? await stockManager.getRecipes(userId, productId)
      : await stockManager.listRecipes(userId);
    if (!result.success) { apiError(res, sanitizeError(result.error) || 'Gagal', ErrorCode.INTERNAL, 500); return; }
    apiSuccess(res, { recipes: result.recipes || [] });
  } catch (e: any) {
    apiError(res, sanitizeError(e), ErrorCode.INTERNAL, 500);
  }
});

router.post('/api/stock/materials/recipes', stockAuth, requireBody('material_id'), validate(recipeUpsertSchema), async (req: StockRequest, res: Response) => {
  const userId = req.stockUser!.id;
  const { material_id, product_id, quantity_per_order } = req.body;
  try {
    const result = await stockManager.setRecipe(userId, material_id, quantity_per_order, product_id || null);
    if (!result.success) { apiError(res, sanitizeError(result.error) || 'Gagal', ErrorCode.VALIDATION, 400); return; }
    apiSuccess(res, { recipe: result.recipe });
  } catch (e: any) {
    apiError(res, sanitizeError(e), ErrorCode.INTERNAL, 500);
  }
});

router.delete('/api/stock/materials/recipes/:recipeId', stockAuth, async (req: StockRequest, res: Response) => {
  const userId = req.stockUser!.id;
  try {
    const result = await stockManager.deleteRecipe(userId, String(req.params.recipeId));
    if (!result.success) { apiError(res, sanitizeError(result.error) || 'Gagal', ErrorCode.VALIDATION, 400); return; }
    apiSuccess(res, { success: true });
  } catch (e: any) {
    apiError(res, sanitizeError(e), ErrorCode.INTERNAL, 500);
  }
});

// ── BOM Deduction Logs ──

router.get('/api/stock/materials/logs', stockAuth, async (req: StockRequest, res: Response) => {
  const userId = req.stockUser!.id;
  const limit = Math.min(parseInt(String(req.query.limit)) || 50, 200);
  try {
    const result = await stockManager.getDeductionLogs(userId, limit);
    if (!result.success) { apiError(res, sanitizeError(result.error) || 'Gagal', ErrorCode.INTERNAL, 500); return; }
    apiSuccess(res, { logs: result.logs || [] });
  } catch (e: any) {
    apiError(res, sanitizeError(e), ErrorCode.INTERNAL, 500);
  }
});

router.post('/api/stock/movement', stockAuth, validate(movementSchema), async (req: StockRequest, res: Response) => {
  const userId = req.stockUser!.id;
  const product_id = String(req.body.product_id);
  const type = req.body.type as 'in' | 'out' | 'adjustment';
  const quantity = parseFloat(String(req.body.quantity));
  const note = sanitizeString(req.body.note, 500);
  const unit_price = req.body.unit_price;
  const channel = req.body.channel ? String(req.body.channel) : 'Offline';
  try {
    const demoCheck = await checkDemoTransactionLimit(userId, req.stockUser?.status || 'demo');
    if (!demoCheck.ok) {
      apiError(res, demoCheck.error!, ErrorCode.UPGRADE_REQUIRED, 403);
      return;
    }

    const result = await transactionRecorder.recordStockAdjustment({
      userId,
      productId: product_id,
      type,
      quantity,
      note: note || undefined,
      unitPrice: unit_price != null ? parseFloat(String(unit_price)) : undefined,
      channel,
      createdVia: 'dashboard',
      recordTransaction: type === 'out',
    });
    if (!result.success) {
      apiError(res, sanitizeError(result.error) || 'Gagal', ErrorCode.VALIDATION, 400);
      return;
    }

    const d = result.data as any;
    const rp = d.product;
    if (d.stockAfter <= rp.stock_min && d.stockAfter > 0) {
      supabase
        .from('stock_alerts')
        .insert([{ user_id: userId, product_id, alert_type: 'low_stock', stock_level: d.stockAfter }] as any)
        .then(() => {
          const io = getIO();
          if (io)
            io.to(userId).emit('stock_alert', {
              userId,
              productId: product_id,
              alertType: 'low_stock',
              stockLevel: d.stockAfter,
              products: { name: rp?.name },
            });
        })
        .then(null, () => {});
    } else if (d.stockAfter <= 0) {
      supabase
        .from('stock_alerts')
        .insert([{ user_id: userId, product_id, alert_type: 'out_of_stock', stock_level: d.stockAfter }] as any)
        .then(() => {
          const io = getIO();
          if (io)
            io.to(userId).emit('stock_alert', {
              userId,
              productId: product_id,
              alertType: 'out_of_stock',
              stockLevel: d.stockAfter,
              products: { name: rp?.name },
            });
        })
        .then(null, () => {});
    }
    if (type === 'in' && d.stockAfter > rp.stock_min) {
      supabase
        .from('stock_alerts')
        .update({ resolved_at: new Date().toISOString() })
        .eq('product_id', product_id)
        .eq('user_id', userId)
        .is('resolved_at', null)
        .then(() => {})
        .then(null, () => {});
    }
    cacheInvalidate(userId);
    apiSuccess(res, { stockBefore: d.stockBefore, stockAfter: d.stockAfter });
  } catch (e: any) {
    apiError(res, sanitizeError(e), ErrorCode.INTERNAL, 500);
  }
});

router.delete('/api/stock/movement/:id', stockAuth, async (req: StockRequest, res: Response) => {
  const userId = req.stockUser!.id;
  try {
    const { data: mov } = (await supabase
      .from('stock_movements')
      .select('*')
      .eq('id', req.params.id)
      .eq('user_id', userId)
      .single()) as any;
    if (!mov) {
      apiError(res, 'Tidak ditemukan', 404);
      return;
    }
    const reverseType = mov.type === 'in' ? 'out' : 'in';
    await withTransaction(async (client) => {
      const prod = await client.query(
        `SELECT id, name, stock_current, stock_min, unit FROM products WHERE id = $1 AND user_id = $2 FOR UPDATE`,
        [mov.product_id, userId],
      );
      if (prod.rows.length === 0) throw new Error('Produk tidak ditemukan');
      const p = prod.rows[0];
      const stockBefore = parseFloat(p.stock_current) || 0;
      const stockAfter = reverseType === 'in' ? stockBefore + mov.quantity : stockBefore - mov.quantity;
      if (stockAfter < 0) throw new Error('Stok tidak cukup setelah reversal');
      await client.query(`UPDATE products SET stock_current = $1 WHERE id = $2 AND user_id = $3`, [
        stockAfter,
        mov.product_id,
        userId,
      ]);
      await syncInventory(userId, String(mov.product_id), stockAfter, 'Utama', client);
      await client.query(`DELETE FROM stock_movements WHERE id = $1 AND user_id = $2`, [mov.id, userId]);

      // Reverse original journal entries by querying them
      const refType = mov.type === 'in' ? 'stock_in' : 'stock_out';
      const je = await client.query(
        `SELECT id FROM journal_entries WHERE reference_type = $1 AND reference_id = $2 AND user_id = $3`,
        [refType, String(mov.id), userId],
      );
      if (je.rows.length > 0) {
        const jl = await client.query(
          `SELECT account_code, debit, credit, description FROM journal_lines WHERE entry_id = $1`,
          [je.rows[0].id],
        );
        const reversalLines = jl.rows.map((l: any) => ({
          accountCode: l.account_code,
          debit: parseFloat(l.credit) || 0,
          credit: parseFloat(l.debit) || 0,
          description: `Reverse ${l.description || ''}`,
        }));
        await accountingEngine.insertJournalViaClient(client, userId, {
          referenceType: 'stock_reversal',
          referenceId: String(mov.id),
          description: `Reverse ${mov.type === 'in' ? 'Stok Masuk' : 'Penjualan'} ${mov.quantity} ${p.unit}: ${p.name}`,
          lines: reversalLines,
        });
      }

      // Delete linked transaction record (stock_out only)
      if (mov.type === 'out') {
        await client.query(
          `DELETE FROM transactions WHERE user_id = $1 AND reference_type = 'stock_out' AND description LIKE $2`,
          [userId, `%[mov:${mov.id}]%`],
        );
      }

      // Resolve any stock alerts for this product
      await client.query(
        `UPDATE stock_alerts SET resolved_at = NOW() WHERE product_id = $1 AND user_id = $2 AND resolved_at IS NULL`,
        [mov.product_id, userId],
      );
    });
    cacheInvalidate(userId);
    apiSuccess(res, {});
  } catch (e: any) {
    apiError(res, sanitizeError(e), ErrorCode.INTERNAL, 500);
  }
});

router.get('/api/stock/movements', stockAuth, async (req: StockRequest, res: Response) => {
  const limit = Math.min(100, parseInt(req.query.limit as string) || 30);
  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const userId = req.stockUser!.id;
  try {
    let query: any = supabase
      .from('stock_movements')
      .select('*, products(id, sku, name, unit)', { count: 'exact' })
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .range((page - 1) * limit, page * limit - 1);
    if (req.query.product_id) query = query.eq('product_id', req.query.product_id);
    if (req.query.type) query = query.eq('type', req.query.type);
    const { data, error, count } = await query;
    if (error) throw error;
    apiSuccess(res, { movements: data || [], total: count || 0, page, limit });
  } catch (e: any) {
    try {
      const pool = pgPool;
      if (!pool) throw e;
      let where = 'user_id = $1';
      const params: any[] = [userId];
      let paramIdx = 2;
      if (req.query.product_id) { where += ` AND product_id = $${paramIdx++}`; params.push(req.query.product_id); }
      if (req.query.type) { where += ` AND type = $${paramIdx++}`; params.push(req.query.type); }
      const offset = (page - 1) * limit;
      const [{ rows }, { rows: countRows }] = await Promise.all([
        pool.query(
          `SELECT sm.*, row_to_json(p.*) AS products
           FROM stock_movements sm
           LEFT JOIN products p ON p.id = sm.product_id AND p.user_id = sm.user_id
           WHERE ${where}
           ORDER BY sm.created_at DESC LIMIT $${paramIdx++} OFFSET $${paramIdx++}`,
          [...params, limit, offset],
        ),
        pool.query(`SELECT COUNT(*) AS total FROM stock_movements WHERE ${where}`, params.slice(0, paramIdx - 2)),
      ]);
      const total = parseInt(countRows[0]?.total) || 0;
      apiSuccess(res, { movements: rows || [], total, page, limit });
    } catch (pgErr: any) {
      apiError(res, sanitizeError(e), ErrorCode.INTERNAL, 500);
    }
  }
});

router.get('/api/stock/report', stockAuth, async (req: StockRequest, res: Response) => {
  const userId = req.stockUser!.id;
  const days = Math.min(365, parseInt(req.query.days as string) || 30);
  const limit = Math.min(1000, Math.max(10, parseInt(req.query.limit as string) || 500));
  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const since = new Date(Date.now() - days * DAY_MS).toISOString();
  try {
    const [movQuery, totalsQuery] = await Promise.all([
      supabase
        .from('stock_movements')
        .select('*, products(id, name, sku, unit)', { count: 'exact' })
        .eq('user_id', userId)
        .gte('created_at', since)
        .order('created_at', { ascending: false })
        .range((page - 1) * limit, page * limit - 1),
      supabase
        .from('stock_movements')
        .select('type, quantity, product_id, products(id, name, sku, unit, price_buy, price_sell, category)')
        .eq('user_id', userId)
        .gte('created_at', since),
    ]);
    const movs = (movQuery as any).data || [];
    const totalCount = (movQuery as any).count || 0;
    const allMovs = (totalsQuery as any).data || [];
    let totalIn = 0,
      totalOut = 0,
      totalAdj = 0;
    const outByProduct: Record<string, any> = {};
    const salesByCategoryMap: Record<string, any> = {};
    allMovs.forEach((m: any) => {
      const qty = parseFloat(m.quantity) || 0;
      const unitPrice = m.products
        ? m.type === 'in'
          ? parseFloat(m.products.price_buy) || 0
          : parseFloat(m.products.price_sell) || 0
        : 0;
      const val = qty * unitPrice;
      if (m.type === 'in') totalIn += val;
      else if (m.type === 'out') totalOut += val;
      else if (m.type === 'adjustment') totalAdj++;
      if (m.type === 'out' && m.products) {
        const key = m.product_id;
        if (!outByProduct[key]) outByProduct[key] = { ...m.products, total: 0 };
        outByProduct[key].total += qty;
        const cat = m.products.category || 'Umum';
        if (!salesByCategoryMap[cat]) salesByCategoryMap[cat] = { category: cat, qty: 0, revenue: 0 };
        salesByCategoryMap[cat].qty += qty;
        salesByCategoryMap[cat].revenue += qty * (parseFloat(m.products.price_sell) || 0);
      }
    });
    const maxOut = Math.max(...Object.values(outByProduct).map((p: any) => p.total), 1);
    const topOut = Object.values(outByProduct)
      .sort((a: any, b: any) => b.total - a.total)
      .slice(0, 8)
      .map((p: any) => ({ ...p, pct: Math.round((p.total / maxOut) * 100) }));
    const catCacheKey = `report-cat:${userId}`;
    let byCategory: Record<string, any> = cacheGet(catCacheKey) as any;
    if (!byCategory) {
      const { data: products } = (await supabase
        .from('products')
        .select('category, stock_current, price_buy')
        .eq('user_id', userId)
        .eq('is_active', true)) as any;
      byCategory = {};
      (products || []).forEach((p: any) => {
        const cat = p.category || 'Umum';
        const val = parseFloat(p.stock_current) * parseFloat(p.price_buy);
        if (!byCategory[cat]) byCategory[cat] = { count: 0, value: 0 };
        byCategory[cat].count++;
        byCategory[cat].value += val;
      });
      cacheSet(catCacheKey, byCategory, 120_000);
    }
    const maxSalesCat = Math.max(...Object.values(salesByCategoryMap).map((c: any) => c.revenue), 1);
    const salesByCategory = Object.values(salesByCategoryMap)
      .sort((a: any, b: any) => b.revenue - a.revenue)
      .map((c: any) => ({ ...c, pct: Math.round((c.revenue / maxSalesCat) * 100) }));
    apiSuccess(res, { totalIn, totalOut, totalAdj, count: totalCount, topOut, byCategory, salesByCategory, page, limit, total: totalCount });
  } catch (e: any) {
    apiError(res, sanitizeError(e), ErrorCode.INTERNAL, 500);
  }
});

router.get('/api/stock/cashflow', stockAuth, async (req: StockRequest, res: Response) => {
  const userId = req.stockUser!.id;
  const days = Math.min(90, parseInt(req.query.days as string) || 30);
  const cacheKey = `cashflow:${userId}:${days}`;
  const cached = cacheGet(cacheKey);
  if (cached) {
    apiSuccess(res, cached);
    return;
  }
  try {
    const since = new Date(Date.now() - days * DAY_MS).toISOString();
    const { data: jeRows } = (await supabase
      .from('journal_entries')
      .select('id, entry_date')
      .eq('user_id', userId)
      .gte('entry_date', since)) as any;
    let cashInflow: Record<string, number> = {};
    let cashOutflow: Record<string, number> = {};
    if (jeRows?.length) {
      const { data: jlRows } = (await supabase
        .from('journal_lines')
        .select('entry_id, account_code, debit, credit')
        .in(
          'entry_id',
          jeRows.map((e: any) => e.id),
        )
        .eq('account_code', '1101')) as any;
      const dateMap: Record<string, string> = {};
      jeRows.forEach((e: any) => {
        dateMap[e.id] = e.entry_date?.slice(0, 10);
      });
      (jlRows || []).forEach((l: any) => {
        const key = dateMap[l.entry_id];
        if (!key) return;
        if (Number(l.debit) > 0) cashInflow[key] = (cashInflow[key] || 0) + Number(l.debit);
        if (Number(l.credit) > 0) cashOutflow[key] = (cashOutflow[key] || 0) + Number(l.credit);
      });
    }
    const dailyMap: Record<string, any> = {};
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      dailyMap[key] = { date: key, masuk: 0, keluar: 0 };
    }
    Object.keys(cashInflow).forEach((key) => {
      if (dailyMap[key]) dailyMap[key].masuk = cashInflow[key];
    });
    Object.keys(cashOutflow).forEach((key) => {
      if (dailyMap[key]) dailyMap[key].keluar = cashOutflow[key];
    });
    const result = Object.values(dailyMap);
    cacheSet(cacheKey, result, 120_000);
    apiSuccess(res, result);
  } catch (e: any) {
    apiError(res, sanitizeError(e), ErrorCode.INTERNAL, 500);
  }
});

router.get('/api/stock/overview', stockAuth, async (req: StockRequest, res: Response) => {
  const userId = req.stockUser!.id;
  const period = (req.query.period as string) || 'month';
  const startDateParam = req.query.startDate as string | undefined;
  const endDateParam = req.query.endDate as string | undefined;
  const cacheKey =
    startDateParam && endDateParam
      ? `overview:${userId}:custom:${startDateParam}:${endDateParam}`
      : `overview:${userId}:${period}`;
  const cached = cacheGet(cacheKey);
  if (cached) {
    apiSuccess(res, cached);
    return;
  }
  const periods: Record<string, number> = { day: 1, week: 7, month: 30, all: 365 };
  const days = periods[period] || 30;
  try {
    const since =
      startDateParam && endDateParam
        ? new Date(startDateParam).toISOString()
        : new Date(Date.now() - days * DAY_MS).toISOString();
    const until =
      startDateParam && endDateParam
        ? new Date(endDateParam + 'T23:59:59.999Z').toISOString()
        : new Date().toISOString();
    const [transResult, stockResult] = await Promise.all([
      supabase
        .from('transactions')
        .select('type, amount, reference_type')
        .eq('user_id', userId)
        .gte('created_at', since)
        .lte('created_at', until),
      supabase
        .from('products')
        .select('stock_current, stock_min, price_buy')
        .eq('user_id', userId)
        .eq('is_active', true),
    ]);
    const trans = (transResult as any).data || [];
    const products = (stockResult as any).data || [];
    let omzet = 0,
      pengeluaran = 0,
      piutang = 0;
    trans.forEach((t: any) => {
      const v = Number(t.amount) || 0;
      if (t.type === 'masuk' && t.reference_type !== 'modal' && t.reference_type !== 'receivable') omzet += v;
      else if (t.type === 'keluar' || t.type === 'barang_rusak') pengeluaran += v;
      if (t.reference_type === 'receivable') piutang += t.type === 'masuk' ? v : -v;
    });
    let totalNilaiStok = 0;
    let stokHabis = 0,
      stokMenipis = 0;
    products.forEach((p: any) => {
      const stk = parseFloat(p.stock_current) || 0;
      const min = parseFloat(p.stock_min) || 0;
      totalNilaiStok += stk * (parseFloat(p.price_buy) || 0);
      if (stk <= 0) stokHabis++;
      else if (min > 0 && stk <= min) stokMenipis++;
    });
    const { data: cashierSales } = (await supabase
      .from('transactions')
      .select('price_buy, quantity')
      .eq('user_id', userId)
      .in('reference_type', ['cashier', 'stock_out'])
      .gte('created_at', since)
      .lte('created_at', until)) as any;
    let hpp = 0;
    (cashierSales || []).forEach((t: any) => {
      hpp += (Number(t.quantity) || 0) * (Number(t.price_buy) || 0);
    });
    const labaBersih = omzet - hpp - pengeluaran;
    const profitMargin = omzet > 0 ? (labaBersih / omzet) * 100 : 0;
    const result = {
      total_omzet: omzet,
      total_hpp: hpp,
      total_pengeluaran: pengeluaran,
      laba_bersih: labaBersih,
      profit_margin: profitMargin,
      nilai_inventori: totalNilaiStok,
      piutang: Math.max(0, piutang),
      total_product: products.length,
      stok_habis: stokHabis,
      stok_menipis: stokMenipis,
      period: days,
    };
    cacheSet(cacheKey, result, 120_000);
    apiSuccess(res, result);
  } catch (e: any) {
    apiError(res, sanitizeError(e), ErrorCode.INTERNAL, 500);
  }
});

router.get('/api/stock/product-stats', stockAuth, async (req: StockRequest, res: Response) => {
  const userId = req.stockUser!.id;
  try {
    const { data: products } = (await supabase
      .from('products')
      .select('id, sku, name, category, unit, stock_current, stock_min, price_buy, price_sell')
      .eq('user_id', userId)
      .eq('is_active', true)) as any;
    if (!products) {
      apiSuccess(res, { products: [] });
      return;
    }
    const result = products
      .map((p: any) => {
        const buy = parseFloat(p.price_buy) || 0,
          sell = parseFloat(p.price_sell) || 0,
          stock = parseFloat(p.stock_current) || 0;
        const profitPerUnit = sell - buy;
        const margin = sell > 0 ? Math.round((profitPerUnit / sell) * 100) : 0;
        const stockValue = stock * buy;
        return { ...p, profitPerUnit, margin, stockValue };
      })
      .sort((a: any, b: any) => b.stockValue - a.stockValue);
    apiSuccess(res, { products: result });
  } catch (e: any) {
    apiError(res, sanitizeError(e), ErrorCode.INTERNAL, 500);
  }
});

// ── Real Sales Data (riil, dari transaksi, bukan teoritis) ──
router.get('/api/stock/product-sales', stockAuth, async (req: StockRequest, res: Response) => {
  const userId = req.stockUser!.id;
  const days = Math.min(365, parseInt(req.query.days as string) || 30);
  const since = new Date(Date.now() - days * DAY_MS).toISOString();
  try {
    const { data: sales } = (await supabase
      .from('transactions')
      .select(`
        product_id,
        amount,
        quantity,
        hpp,
        profit,
        products!inner(id, name, sku, category, unit, price_sell, price_buy)
      `)
      .eq('user_id', userId)
      .eq('type', 'masuk')
      .in('reference_type', ['cashier', 'stock_out'])
      .gte('created_at', since)
      .not('product_id', 'is', null)) as any;

    const byProduct: Record<string, any> = {};
    (sales || []).forEach((t: any) => {
      const p = t.products;
      if (!p) return;
      const pid = String(t.product_id);
      if (!byProduct[pid]) {
        byProduct[pid] = {
          id: pid,
          name: p.name,
          sku: p.sku,
          category: p.category || 'Umum',
          unit: p.unit,
          price_sell: Number(p.price_sell) || 0,
          price_buy: Number(p.price_buy) || 0,
          qty: 0,
          revenue: 0,
          hpp: 0,
          profit: 0,
          txCount: 0,
        };
      }
      const r = byProduct[pid];
      r.qty += Number(t.quantity) || 1;
      r.revenue += Number(t.amount) || 0;
      r.hpp += Number(t.hpp) || 0;
      r.profit += Number(t.profit) || 0;
      r.txCount++;
    });

    const products = Object.values(byProduct)
      .map((p: any) => ({
        ...p,
        avgMargin: p.revenue > 0 ? Math.round((p.profit / p.revenue) * 100) : 0,
      }))
      .sort((a: any, b: any) => b.revenue - a.revenue);

    const byCategoryMap: Record<string, any> = {};
    products.forEach((p: any) => {
      const cat = p.category;
      if (!byCategoryMap[cat]) {
        byCategoryMap[cat] = { category: cat, qty: 0, revenue: 0, hpp: 0, profit: 0, productCount: 0 };
      }
      byCategoryMap[cat].qty += p.qty;
      byCategoryMap[cat].revenue += p.revenue;
      byCategoryMap[cat].hpp += p.hpp;
      byCategoryMap[cat].profit += p.profit;
      byCategoryMap[cat].productCount++;
    });

    const summary = {
      totalRevenue: products.reduce((s: number, p: any) => s + p.revenue, 0),
      totalHPP: products.reduce((s: number, p: any) => s + p.hpp, 0),
      totalProfit: products.reduce((s: number, p: any) => s + p.profit, 0),
      totalQty: products.reduce((s: number, p: any) => s + p.qty, 0),
      totalProducts: products.length,
    };

    apiSuccess(res, {
      summary,
      products,
      byCategory: Object.values(byCategoryMap).sort((a: any, b: any) => b.revenue - a.revenue),
    });
  } catch (e: any) {
    apiError(res, sanitizeError(e), ErrorCode.INTERNAL, 500);
  }
});

router.get('/api/stock/laba-rugi', stockAuth, async (req: StockRequest, res: Response) => {
  const userId = req.stockUser!.id;
  try {
    const days = Math.min(365, parseInt(req.query.days as string) || 30);
    const channel = (req.query.channel as string) || '';
    const endDate = new Date().toISOString();
    const startDate = new Date(Date.now() - days * DAY_MS).toISOString();
    if (channel) {
      const since = startDate;
      const { data: trans } = (await supabase
        .from('transactions')
        .select('type, reference_type, amount, price_buy, quantity')
        .eq('user_id', userId)
        .eq('channel', channel)
        .gte('created_at', since)) as any;
      let revenue = 0,
        expense = 0,
        hpp = 0;
      (trans || []).forEach((t: any) => {
        const v = Number(t.amount) || 0;
        if (t.type === 'masuk' && t.reference_type !== 'modal') revenue += v;
        else if (t.type === 'keluar') expense += v;
        if (t.reference_type === 'cashier') {
          hpp += (Number(t.quantity) || 0) * (Number(t.price_buy) || 0);
        }
      });
      const labaBersih = revenue - hpp - expense;
      apiSuccess(res, {
        rows: [
          { account_code: 'TRX', account_name: `Transaksi ${channel}`, account_type: 'revenue', total: revenue },
          { account_code: 'HPP', account_name: 'Harga Pokok Penjualan', account_type: 'cogs', total: hpp },
          { account_code: 'BIAYA', account_name: 'Biaya Operasional', account_type: 'expense', total: expense },
        ],
        totalRevenue: revenue,
        totalCOGS: hpp,
        totalExpense: expense,
        labaKotor: revenue - hpp,
        labaBersih,
      });
      return;
    }
    const result = await accountingEngine.getLabaRugi(userId, startDate, endDate);
    if (!result.success) {
      apiError(res, result.error || 'Gagal memuat data', ErrorCode.INTERNAL, 500);
      return;
    }
    apiSuccess(res, result.data);
  } catch (e: any) {
    apiError(res, sanitizeError(e), ErrorCode.INTERNAL, 500);
  }
});

router.get('/api/stock/channels', stockAuth, async (req: StockRequest, res: Response) => {
  const userId = req.stockUser!.id;
  const days = Math.min(90, parseInt(req.query.days as string) || 30);
  const cacheKey = `channels:${userId}:${days}`;
  const cached = cacheGet(cacheKey);
  if (cached) {
    apiSuccess(res, cached);
    return;
  }
  try {
    const since = new Date(Date.now() - days * DAY_MS).toISOString();
    const { data: trans } = (await supabase
      .from('transactions')
      .select('amount, channel')
      .eq('user_id', userId)
      .eq('type', 'masuk')
      .gte('created_at', since)) as any;
    const channels: Record<string, number> = {};
    (trans || []).forEach((t: any) => {
      const v = Number(t.amount) || 0;
      const ch = t.channel || 'Offline';
      channels[ch] = (channels[ch] || 0) + v;
    });
    cacheSet(cacheKey, channels, 120_000);
    apiSuccess(res, channels);
  } catch (e: any) {
    apiError(res, sanitizeError(e), ErrorCode.INTERNAL, 500);
  }
});

// ── Channel Profitability Analysis ──

router.get('/api/stock/channel-profitability', stockAuth, async (req: StockRequest, res: Response) => {
  const userId = req.stockUser!.id;
  const days = Math.min(365, parseInt(req.query.days as string) || 30);
  try {
    const since = new Date(Date.now() - days * DAY_MS).toISOString();
    const { data: trans } = (await supabase
      .from('transactions')
      .select('channel, type, reference_type, amount, price_buy, quantity')
      .eq('user_id', userId)
      .gte('created_at', since)) as any;

    const channelMap: Record<string, { revenue: number; hpp: number }> = {};
    (trans || []).forEach((t: any) => {
      const ch = t.channel || 'Offline';
      if (!channelMap[ch]) channelMap[ch] = { revenue: 0, hpp: 0 };
      const v = Number(t.amount) || 0;
      if (t.type === 'masuk' && t.reference_type !== 'modal' && t.reference_type !== 'receivable') {
        channelMap[ch].revenue += v;
      }
      if (t.reference_type === 'cashier' || t.reference_type === 'stock_out') {
        const qty = Number(t.quantity) || 0;
        const buy = Number(t.price_buy) || 0;
        channelMap[ch].hpp += qty * buy;
      }
    });

    const result = Object.entries(channelMap)
      .map(([channel, data]) => {
        const netProfit = data.revenue - data.hpp;
        const margin = data.revenue > 0 ? (netProfit / data.revenue) * 100 : 0;
        return { channel, revenue: data.revenue, hpp: data.hpp, netProfit, margin: Math.round(margin * 10) / 10 };
      })
      .sort((a, b) => b.revenue - a.revenue);

    apiSuccess(res, result);
  } catch (e: any) {
    apiError(res, sanitizeError(e), ErrorCode.INTERNAL, 500);
  }
});

router.get('/api/stock/piutang', stockAuth, async (req: StockRequest, res: Response) => {
  const userId = req.stockUser!.id;
  const statusFilter = (req.query.status as string) || 'all';
  try {
    const { data: debtsData } = await supabase
      .from('receivables')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    const list: any[] = ((debtsData as any[]) || []).map((d: any) => ({
      nama: d.nama_pelanggan,
      status: d.status_lunas ? 'paid' : 'unpaid',
      tanggal: d.created_at || d.jatuh_tempo,
      jumlah: Math.abs(Number(d.nominal_piutang) || 0),
    }));

    let filtered = list;
    if (statusFilter === 'paid') filtered = list.filter((i) => i.status === 'paid');
    else if (statusFilter === 'unpaid') filtered = list.filter((i) => i.status === 'unpaid');
    filtered.sort((a, b) => b.jumlah - a.jumlah);

    const belumLunas = filtered.filter((i) => i.status === 'unpaid').reduce((s, i) => s + i.jumlah, 0);
    const sudahLunas = filtered.filter((i) => i.status === 'paid').reduce((s, i) => s + i.jumlah, 0);

    apiSuccess(res, {
      totalPiutang: belumLunas,
      belumLunas,
      sudahLunas,
      jumlahTagihan: filtered.length,
      list: filtered,
    });
  } catch (e: any) {
    apiError(res, sanitizeError(e), ErrorCode.INTERNAL, 500);
  }
});

router.put('/api/stock/transactions/:id', stockAuth, async (req: StockRequest, res: Response) => {
  const userId = req.stockUser!.id;
  const { id } = req.params;
  const { type, amount, description } = req.body;
  try {
    if (description != null) {
      const desc = sanitizeString(description, 500);
      const { error } = (await supabase
        .from('transactions')
        .update({ description: desc })
        .eq('id', id)
        .eq('user_id', userId)) as any;
      if (error) throw error;
      cacheInvalidate(userId);
      apiSuccess(res, {});
    } else {
      apiError(res, 'Hanya deskripsi yang bisa diubah. Untuk mengubah nominal/tipe, hapus dan buat ulang.', 400);
    }
  } catch (e: any) {
    apiError(res, sanitizeError(e), ErrorCode.INTERNAL, 500);
  }
});

router.delete('/api/stock/transactions/:id', stockAuth, async (req: StockRequest, res: Response) => {
  const userId = req.stockUser!.id;
  const { id } = req.params;
  try {
    const { data: tx, error: txErr } = (await supabase
      .from('transactions')
      .select('*')
      .eq('id', id)
      .eq('user_id', userId)
      .single()) as any;
    if (txErr || !tx) {
      apiError(res, 'Transaksi tidak ditemukan', 404);
      return;
    }

    await withTransaction(async (client) => {
      // Reverse stock effect if applicable (with FOR UPDATE lock)
      if (tx.product_id && tx.quantity && Number(tx.quantity) > 0) {
        const prod = await client.query(
          `SELECT id, name, stock_current FROM products WHERE id = $1 AND user_id = $2 FOR UPDATE`,
          [tx.product_id, userId],
        );
        if (prod.rows.length > 0) {
          const newStock = parseFloat(prod.rows[0].stock_current) + Number(tx.quantity);
          await client.query(`UPDATE products SET stock_current = $1 WHERE id = $2 AND user_id = $3`, [
            newStock,
            tx.product_id,
            userId,
          ]);
          await syncInventory(userId, String(tx.product_id), newStock, 'Utama', client);
        }
      }

      // Reverse journal entries linked to this transaction
      const refTypes = ['sale', 'expense', 'manual', 'pembukuan', 'modal', 'receivable', 'stock_out', 'damaged_goods'];
      for (const refType of refTypes) {
        const je = await client.query(
          `SELECT id FROM journal_entries WHERE reference_type = $1 AND reference_id = $2 AND user_id = $3`,
          [refType, String(id), userId],
        );
        if (je.rows.length > 0) {
          const jl = await client.query(
            `SELECT account_code, debit, credit, description FROM journal_lines WHERE entry_id = $1`,
            [je.rows[0].id],
          );
          const reversalLines = jl.rows.map((l: any) => ({
            accountCode: l.account_code,
            debit: parseFloat(l.credit) || 0,
            credit: parseFloat(l.debit) || 0,
            description: `Reverse ${l.description || ''}`,
          }));
          await accountingEngine.insertJournalViaClient(client, userId, {
            referenceType: 'tx_reversal',
            referenceId: String(id),
            description: `Reverse transaksi: ${tx.description || ''}`,
            lines: reversalLines,
          });
          break;
        }
      }

      // Delete the transaction
      await client.query(`DELETE FROM transactions WHERE id = $1 AND user_id = $2`, [id, userId]);

      // Resolve stock alerts
      if (tx.product_id) {
        await client.query(
          `UPDATE stock_alerts SET resolved_at = NOW() WHERE product_id = $1 AND user_id = $2 AND resolved_at IS NULL`,
          [tx.product_id, userId],
        );
      }
    });
    cacheInvalidate(userId);
    apiSuccess(res, {});
  } catch (e: any) {
    apiError(res, sanitizeError(e), ErrorCode.INTERNAL, 500);
  }
});

router.get('/api/stock/saldo', stockAuth, async (req: StockRequest, res: Response) => {
  const userId = req.stockUser!.id;
  try {
    if (!pgPool) {
      apiError(res, 'Database tidak tersedia', ErrorCode.DB_ERROR, 500);
      return;
    }
    const [jlResult] = await Promise.all([
      pgPool.query(
        `SELECT
          COALESCE(SUM(jl.debit), 0) as total_masuk,
          COALESCE(SUM(jl.credit), 0) as total_keluar
         FROM journal_lines jl
         JOIN journal_entries je ON je.id = jl.entry_id
         WHERE jl.account_code = '1101' AND je.user_id = $1`,
        [userId],
      ),
    ]);
    // Ambil saldo dari Supabase, fallback ke pgPool jika gagal
    let saldo = 0;
    try {
      const { data: coa, error: coaErr } = await supabase
        .from('chart_of_accounts').select('balance').eq('user_id', userId).eq('code', '1101').maybeSingle() as any;
      if (coa && !coaErr) saldo = Number(coa.balance) || 0;
      else throw coaErr || new Error('No data');
    } catch {
      try {
        const pgSaldo = await pgPool.query(
          `SELECT balance FROM chart_of_accounts WHERE user_id = $1 AND code = '1101'`, [userId]
        );
        if (pgSaldo.rows.length > 0) saldo = Number(pgSaldo.rows[0].balance) || 0;
      } catch { /* saldo tetap 0 */ }
    }
    const { total_masuk, total_keluar } = jlResult.rows[0];
    apiSuccess(res, { saldo, totalMasuk: Number(total_masuk), totalKeluar: Number(total_keluar) });
  } catch (e: any) {
    apiError(res, sanitizeError(e), ErrorCode.INTERNAL, 500);
  }
});

router.get('/api/stock/pembukuan', stockAuth, async (req: StockRequest, res: Response) => {
  const userId = req.stockUser!.id;
  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const limit = Math.min(100, parseInt(req.query.limit as string) || 30);
  const startDate = (req.query.start_date as string) || undefined;
  const endDate = (req.query.end_date as string) || undefined;
  try {
    let query: any = supabase
      .from('transactions')
      .select('*, products(name, sku, unit)', { count: 'exact' })
      .eq('user_id', userId);
    if (startDate) query = query.gte('created_at', startDate);
    if (endDate) query = query.lte('created_at', endDate + 'T23:59:59.999Z');
    query = query.order('created_at', { ascending: false }).range((page - 1) * limit, page * limit - 1);
    const { data: trans, error, count } = (await query) as any;
    if (error) throw error;

    let aggQuery: any = supabase.from('transactions').select('type, amount').eq('user_id', userId);
    if (startDate) aggQuery = aggQuery.gte('created_at', startDate);
    if (endDate) aggQuery = aggQuery.lte('created_at', endDate + 'T23:59:59.999Z');
    const { data: aggRows, error: aggError } = (await aggQuery) as any;
    if (aggError) throw aggError;

    let totalMasuk = 0,
      totalKeluar = 0;
    (aggRows || []).forEach((t: any) => {
      if (t.type === 'masuk') totalMasuk += Number(t.amount) || 0;
      else totalKeluar += Number(t.amount) || 0;
    });
    const { data: products } = (await supabase
      .from('products')
      .select('id, name')
      .eq('user_id', userId)
      .eq('is_active', true)
      .order('name')) as any;
    let journal: any[] = [];
    try {
      const { data: je } = (await supabase
        .from('journal_entries')
        .select('id')
        .eq('user_id', userId)
        .gte('created_at', new Date(Date.now() - 30 * DAY_MS).toISOString())
        .order('created_at', { ascending: false })
        .limit(50)) as any;
      if (je?.length) {
        const { data: jl } = (await supabase
          .from('journal_lines')
          .select('*')
          .in(
            'entry_id',
            je.map((e: any) => e.id),
          )) as any;
        journal = jl || [];
      }
    } catch {
      journal = [];
    }
    apiSuccess(res, {
      transaksi: trans || [],
      total: count || 0,
      page,
      limit,
      totalMasuk,
      totalKeluar,
      products: products || [],
      journalEntries: journal || [],
    });
  } catch (e: any) {
    apiError(res, sanitizeError(e), ErrorCode.INTERNAL, 500);
  }
});

router.post('/api/stock/pembukuan', stockAuth, validate(pembukuanSchema), async (req: StockRequest, res: Response) => {
  const userId = req.stockUser!.id;
  const type = sanitizeString(req.body.type, 20);
  const description = sanitizeString(req.body.description, 500);
  const amount = parseFloat(req.body.amount);
  const customerName = sanitizeString(req.body.customerName, 100);
  const coaDebit = sanitizeString(req.body.coaDebit, 10) || undefined;
  const coaCredit = sanitizeString(req.body.coaCredit, 10) || undefined;
  const channel = sanitizeString(req.body.channel, 50) || undefined;
  try {
    const result = await transactionRecorder.recordPembukuan({
      userId,
      tipe: type,
      amount,
      description,
      customerName: customerName || undefined,
      coaDebit,
      coaCredit,
      channel,
    });
    if (!result.success) {
      apiError(res, sanitizeError(result.error!));
      return;
    }
    cacheInvalidate(userId);
    apiSuccess(res, {});
  } catch (e: any) {
    apiError(res, sanitizeError(e), ErrorCode.INTERNAL, 500);
  }
});

router.get('/api/stock/hutang', stockAuth, async (req: StockRequest, res: Response) => {
  const userId = req.stockUser!.id;
  const days = Math.min(365, parseInt(req.query.days as string) || 90);
  const statusFilter = (req.query.status as string) || 'all';
  try {
    let query: any = supabase
      .from('payables')
      .select('*')
      .eq('user_id', userId)
      .order('jatuh_tempo', { ascending: true })
      .limit(200);
    if (days < 365) {
      const since = new Date(Date.now() - days * DAY_MS).toISOString();
      query = query.gte('created_at', since);
    }
    const { data: list, error } = await query;
    if (error) throw error;

    let filtered = list || [];
    if (statusFilter === 'unpaid') filtered = filtered.filter((i: any) => !i.status_lunas);
    else if (statusFilter === 'paid') filtered = filtered.filter((i: any) => i.status_lunas);
    else if (statusFilter === 'overdue') {
      const now = new Date().toISOString();
      filtered = filtered.filter((i: any) => !i.status_lunas && i.jatuh_tempo && i.jatuh_tempo < now);
    }

    const totalHutang = filtered.reduce(
      (s: number, i: any) => s + Number(i.nominal_hutang) - Number(i.jumlah_dibayar || 0),
      0,
    );
    const belumLunas = filtered
      .filter((i: any) => !i.status_lunas)
      .reduce((s: number, i: any) => s + Number(i.nominal_hutang) - Number(i.jumlah_dibayar || 0), 0);
    const sudahLunas = filtered
      .filter((i: any) => i.status_lunas)
      .reduce((s: number, i: any) => s + Number(i.nominal_hutang), 0);

    apiSuccess(res, {
      totalHutang: Math.max(0, totalHutang),
      belumLunas: Math.max(0, belumLunas),
      sudahLunas,
      jumlahTagihan: filtered.length,
      list: filtered,
    });
  } catch (e: any) {
    apiError(res, sanitizeError(e), ErrorCode.INTERNAL, 500);
  }
});

router.post('/api/stock/hutang', stockAuth, validate(hutangSchema), async (req: StockRequest, res: Response) => {
  const userId = req.stockUser!.id;
  const nama_supplier = sanitizeString(req.body.nama_supplier, 150);
  const nominal_hutang = parseFloat(req.body.nominal_hutang);
  const deskripsi = sanitizeString(req.body.deskripsi, 500) || `Hutang ke ${nama_supplier}`;
  const jatuh_tempo = req.body.jatuh_tempo || null;
  try {
    const result = await transactionRecorder.recordPembukuan({
      userId,
      tipe: 'hutang_dagang',
      amount: nominal_hutang,
      description: deskripsi,
      customerName: nama_supplier,
    });
    if (!result.success) {
      apiError(res, sanitizeError(result.error) || 'Gagal', ErrorCode.VALIDATION, 400);
      return;
    }
    if (jatuh_tempo) {
      const { data: latest } = (await supabase
        .from('payables')
        .select('id')
        .eq('user_id', userId)
        .eq('nama_supplier', nama_supplier)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()) as any;
      if (latest?.id) {
        (await supabase.from('payables').update({ jatuh_tempo }).eq('id', latest.id)) as any;
      }
    }
    cacheInvalidate(userId);
    apiSuccess(res, { hutang: result.data });
  } catch (e: any) {
    apiError(res, sanitizeError(e), ErrorCode.INTERNAL, 500);
  }
});

router.put('/api/stock/hutang/:id', stockAuth, async (req: StockRequest, res: Response) => {
  const userId = req.stockUser!.id;
  const { id } = req.params;
  const { nominal_hutang, jumlah_dibayar, status_lunas, jatuh_tempo, deskripsi } = req.body;
  try {
    const updates: Record<string, unknown> = {};
    if (nominal_hutang != null) updates.nominal_hutang = parseFloat(String(nominal_hutang));
    if (jumlah_dibayar != null) updates.jumlah_dibayar = parseFloat(String(jumlah_dibayar));
    if (status_lunas != null) updates.status_lunas = Boolean(status_lunas);
    if (jatuh_tempo !== undefined) updates.jatuh_tempo = jatuh_tempo || null;
    if (deskripsi !== undefined) updates.deskripsi = sanitizeString(deskripsi, 500);
    if (Object.keys(updates).length === 0) {
      apiError(res, 'Tidak ada perubahan');
      return;
    }
    const { error } = (await supabase
      .from('payables')
      .update(updates)
      .eq('id', id)
      .eq('user_id', userId)) as any;
    if (error) throw error;
    cacheInvalidate(userId);
    apiSuccess(res, {});
  } catch (e: any) {
    apiError(res, sanitizeError(e), ErrorCode.INTERNAL, 500);
  }
});

router.delete('/api/stock/hutang/:id', stockAuth, async (req: StockRequest, res: Response) => {
  const userId = req.stockUser!.id;
  try {
    const { error } = (await supabase
      .from('payables')
      .delete()
      .eq('id', req.params.id)
      .eq('user_id', userId)) as any;
    if (error) throw error;
    cacheInvalidate(userId);
    apiSuccess(res, {});
  } catch (e: any) {
    apiError(res, sanitizeError(e), ErrorCode.INTERNAL, 500);
  }
});

router.post('/api/stock/hutang/:id/bayar', stockAuth, async (req: StockRequest, res: Response) => {
  const userId = req.stockUser!.id;
  const amount = parseFloat(req.body.amount);
  if (!amount || amount <= 0) { apiError(res, 'Jumlah bayar harus > 0'); return; }
  try {
    const result = await transactionRecorder.recordPayPayable({
      userId, payableId: String(req.params.id), amount,
      description: String(req.body.description || ''),
    });
    if (!result.success) { apiError(res, sanitizeError(result.error!), 400); return; }
    cacheInvalidate(userId);
    apiSuccess(res, result.data);
  } catch (e: any) { apiError(res, sanitizeError(e), ErrorCode.INTERNAL, 500); }
});

router.post('/api/stock/piutang/:id/terima', stockAuth, async (req: StockRequest, res: Response) => {
  const userId = req.stockUser!.id;
  const amount = parseFloat(req.body.amount);
  if (!amount || amount <= 0) { apiError(res, 'Jumlah terima harus > 0'); return; }
  try {
    const result = await transactionRecorder.recordReceiveReceivable({
      userId, debtId: String(req.params.id), amount,
      description: String(req.body.description || ''),
    });
    if (!result.success) { apiError(res, sanitizeError(result.error!), 400); return; }
    cacheInvalidate(userId);
    apiSuccess(res, result.data);
  } catch (e: any) { apiError(res, sanitizeError(e), ErrorCode.INTERNAL, 500); }
});

// ── Returns ──
router.post('/api/stock/return/sales', stockAuth, validate(salesReturnSchema), async (req: StockRequest, res: Response) => {
  const userId = req.stockUser!.id;
  try {
    const result = await transactionRecorder.recordSalesReturn({ ...req.body, userId });
    if (!result.success) { apiError(res, sanitizeError(result.error!), 400); return; }
    cacheInvalidate(userId);
    apiSuccess(res, result.data);
  } catch (e: any) { apiError(res, sanitizeError(e), ErrorCode.INTERNAL, 500); }
});

router.post('/api/stock/return/purchase', stockAuth, validate(purchaseReturnSchema), async (req: StockRequest, res: Response) => {
  const userId = req.stockUser!.id;
  try {
    const result = await transactionRecorder.recordPurchaseReturn({ ...req.body, userId });
    if (!result.success) { apiError(res, sanitizeError(result.error!), 400); return; }
    cacheInvalidate(userId);
    apiSuccess(res, result.data);
  } catch (e: any) { apiError(res, sanitizeError(e), ErrorCode.INTERNAL, 500); }
});

router.get('/api/stock/returns', stockAuth, async (req: StockRequest, res: Response) => {
  const userId = req.stockUser!.id;
  const type = req.query.type as string || 'all';
  try {
    let query: any = supabase
      .from('transactions')
      .select('*, products(id, sku, name, unit)')
      .eq('user_id', userId)
      .in('type', ['sales_return', 'purchase_return'])
      .order('created_at', { ascending: false })
      .limit(100);
    if (type === 'sales_return') query = query.eq('type', 'sales_return');
    if (type === 'purchase_return') query = query.eq('type', 'purchase_return');
    const { data, error } = await query;
    if (error) throw error;
    apiSuccess(res, (data as any[]) || []);
  } catch (e: any) { apiError(res, sanitizeError(e), ErrorCode.INTERNAL, 500); }
});

// ── Stock Opname ──
router.post('/api/stock/opname', stockAuth, validate(opnameCreateSchema), async (req: StockRequest, res: Response) => {
  const userId = req.stockUser!.id;
  const { warehouse, notes } = req.body;
  try {
    const { data, error } = await supabase.from('stock_opnames').insert([
      { user_id: userId, warehouse: warehouse || 'Utama', notes, status: 'draft', created_by: req.stockUser!.name || 'system' },
    ]).select().single();
    if (error) throw error;
    apiSuccess(res, data, 201);
  } catch (e: any) { apiError(res, sanitizeError(e), ErrorCode.INTERNAL, 500); }
});

router.get('/api/stock/opname', stockAuth, async (req: StockRequest, res: Response) => {
  const userId = req.stockUser!.id;
  try {
    const { data, error } = await supabase
      .from('stock_opnames')
      .select('*, details:opname_details(*)')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(20);
    if (error) throw error;
    apiSuccess(res, (data as any[]) || []);
  } catch (e: any) { apiError(res, sanitizeError(e), ErrorCode.INTERNAL, 500); }
});

router.get('/api/stock/opname/:id', stockAuth, async (req: StockRequest, res: Response) => {
  const userId = req.stockUser!.id;
  try {
    const { data, error } = await supabase
      .from('stock_opnames')
      .select('*, details:opname_details(*, products(id, sku, name, unit))')
      .eq('id', req.params.id)
      .eq('user_id', userId)
      .single();
    if (error) throw error;
    apiSuccess(res, data);
  } catch (e: any) { apiError(res, sanitizeError(e), ErrorCode.INTERNAL, 500); }
});

router.post('/api/stock/opname/:id/details', stockAuth, validate(opnameDetailSchema), async (req: StockRequest, res: Response) => {
  const userId = req.stockUser!.id;
  const opnameId = req.params.id;
  const { productId, actualQty, systemQty: reqSystemQty, notes } = req.body;
  try {
    const { data: opname } = await supabase.from('stock_opnames').select('status').eq('id', opnameId).eq('user_id', userId).single();
    if (!opname) { apiError(res, 'Opname tidak ditemukan', 404); return; }
    if (opname.status === 'completed') { apiError(res, 'Opname sudah selesai', 400); return; }

    const actualSystemQty = reqSystemQty != null ? reqSystemQty : await (async () => {
      const { data: prod } = await supabase.from('products').select('stock_current').eq('id', productId).eq('user_id', userId).single();
      return (prod as any)?.stock_current || 0;
    })();

    const { data, error } = await supabase.from('opname_details').insert([
      { opname_id: opnameId, product_id: productId, system_qty: actualSystemQty, actual_qty: actualQty, notes },
    ]).select().single();
    if (error) throw error;
    apiSuccess(res, data, 201);
  } catch (e: any) { apiError(res, sanitizeError(e), ErrorCode.INTERNAL, 500); }
});

router.post('/api/stock/opname/:id/complete', stockAuth, async (req: StockRequest, res: Response) => {
  const userId = req.stockUser!.id;
  const opnameId = req.params.id;
  try {
    const { data: opname } = await supabase.from('stock_opnames').select('status, warehouse').eq('id', opnameId).eq('user_id', userId).single();
    if (!opname) { apiError(res, 'Opname tidak ditemukan', 404); return; }
    if (opname.status === 'completed') { apiError(res, 'Opname sudah selesai', 400); return; }

    const { data: details } = await supabase
      .from('opname_details')
      .select('*, products(id, price_buy)')
      .eq('opname_id', opnameId);

    if (!details || details.length === 0) { apiError(res, 'Tidak ada detail opname', 400); return; }

    const items = (details as any[]).map((d: any) => ({
      productId: d.product_id,
      systemQty: d.system_qty,
      actualQty: d.actual_qty,
      priceBuy: d.products?.price_buy || 0,
      varianceType: d.actual_qty < d.system_qty ? 'shortage' as const : 'overage' as const,
    }));

    const result = await transactionRecorder.recordInventoryAdjustment({
      userId, opnameId: String(opnameId), items, notes: `Opname ${opname.warehouse}`,
    });
    if (!result.success) { apiError(res, sanitizeError(result.error!), 400); return; }

    await supabase.from('stock_opnames').update({ status: 'completed', completed_at: new Date().toISOString() }).eq('id', opnameId);
    cacheInvalidate(userId);
    apiSuccess(res, result.data);
  } catch (e: any) { apiError(res, sanitizeError(e), ErrorCode.INTERNAL, 500); }
});

// ── Inventory Adjustment (quick, without opname session) ──
router.post('/api/stock/adjustment', stockAuth, async (req: StockRequest, res: Response) => {
  const userId = req.stockUser!.id;
  const { items, notes } = req.body;
  if (!items || !Array.isArray(items) || items.length === 0) { apiError(res, 'items required'); return; }
  try {
    const result = await transactionRecorder.recordInventoryAdjustment({ userId, items, notes });
    if (!result.success) { apiError(res, sanitizeError(result.error!), 400); return; }
    cacheInvalidate(userId);
    apiSuccess(res, result.data);
  } catch (e: any) { apiError(res, sanitizeError(e), ErrorCode.INTERNAL, 500); }
});

router.get('/api/stock/coa', stockAuth, async (req: StockRequest, res: Response) => {
  const userId = req.stockUser!.id;
  try {
    const result = await accountingEngine.getCoA(userId);
    if (!result.success) {
      apiError(res, result.error || 'Gagal memuat data', ErrorCode.INTERNAL, 500);
      return;
    }
    apiSuccess(res, { accounts: result.data });
  } catch (e: any) {
    apiError(res, sanitizeError(e), ErrorCode.INTERNAL, 500);
  }
});

router.get('/api/stock/neraca', stockAuth, async (req: StockRequest, res: Response) => {
  const userId = req.stockUser!.id;
  const endDate = (req.query.end_date as string) || undefined;
  try {
    const result = await accountingEngine.getBalanceSheet(userId, endDate);
    if (!result.success) {
      apiError(res, result.error || 'Gagal memuat data', ErrorCode.INTERNAL, 500);
      return;
    }
    apiSuccess(res, result.data);
  } catch (e: any) {
    apiError(res, sanitizeError(e), ErrorCode.INTERNAL, 500);
  }
});

router.get('/api/stock/jurnal', stockAuth, async (req: StockRequest, res: Response) => {
  const userId = req.stockUser!.id;
  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const limit = Math.min(200, parseInt(req.query.limit as string) || 50);
  try {
    const {
      data: entries,
      error,
      count,
    } = (await supabase
      .from('journal_entries')
      .select('*', { count: 'exact' })
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .range((page - 1) * limit, page * limit - 1)) as any;
    if (error) throw error;

    const result = (entries || []).map((e: any) => ({ ...e, lines: [] }));
    if (result.length) {
      const entryIds = result.map((e: any) => e.id);
      const { data: lines } = (await supabase.from('journal_lines').select('*').in('entry_id', entryIds)) as any;
      const codeMap: Record<string, string> = {};
      const codes = [...new Set((lines || []).map((l: any) => l.account_code).filter(Boolean))];
      if (codes.length) {
        const { data: coa } = (await supabase
          .from('chart_of_accounts')
          .select('code, name')
          .in('code', codes)
          .eq('user_id', userId)) as any;
        (coa || []).forEach((a: any) => {
          codeMap[a.code] = a.name;
        });
      }
      const lineMap: Record<string, any[]> = {};
      (lines || []).forEach((l: any) => {
        if (!lineMap[l.entry_id]) lineMap[l.entry_id] = [];
        lineMap[l.entry_id].push({ ...l, account_name: codeMap[l.account_code] || l.account_code });
      });
      result.forEach((e: any) => {
        e.lines = lineMap[e.id] || [];
      });
    }

    apiSuccess(res, { list: result, total: count || 0, page, limit });
  } catch (e: any) {
    apiError(res, sanitizeError(e), ErrorCode.INTERNAL, 500);
  }
});

router.get('/api/stock/general-ledger', stockAuth, async (req: StockRequest, res: Response) => {
  const userId = req.stockUser!.id;
  const days = Math.min(365, parseInt(req.query.days as string) || 90);
  const from = new Date(Date.now() - days * DAY_MS).toISOString();
  const accountCode = (req.query.account as string) || (req.query.account_code as string);
  try {
    let account: any = null;
    if (accountCode) {
      const { data: acct } = (await supabase
        .from('chart_of_accounts')
        .select('*')
        .eq('user_id', userId)
        .eq('code', accountCode)
        .single()) as any;
      account = acct;
      if (!account) {
        apiSuccess(res, { account: null, entries: [] });
        return;
      }
    }

    const { data: entryRows } = (await supabase
      .from('journal_entries')
      .select('id, entry_date, reference_type, description')
      .eq('user_id', userId)
      .gte('created_at', from)
      .order('created_at', { ascending: false })
      .limit(500)) as any;
    if (!entryRows?.length) {
      apiSuccess(res, { account, entries: [] });
      return;
    }

    const entryIds = entryRows.map((e: any) => e.id);
    const entryMap: Record<string, any> = {};
    entryRows.forEach((e: any) => {
      entryMap[e.id] = e;
    });

    let query: any = supabase.from('journal_lines').select('*').in('entry_id', entryIds);
    if (accountCode) query = query.eq('account_code', accountCode);
    const { data: lines, error } = await query;
    if (error) throw error;

    const entries = (lines || []).map((l: any) => {
      const entry = entryMap[l.entry_id] || {};
      return {
        debit: l.debit,
        credit: l.credit,
        entry_date: entry.entry_date,
        reference_type: entry.reference_type,
        description: l.description || entry.description || '',
      };
    });

    apiSuccess(res, { account, entries });
  } catch (e: any) {
    apiError(res, sanitizeError(e), ErrorCode.INTERNAL, 500);
  }
});

router.get('/api/stock/trial-balance', stockAuth, async (req: StockRequest, res: Response) => {
  const userId = req.stockUser!.id;
  try {
    const result = await accountingEngine.getTrialBalance(userId);
    if (!result.success) {
      apiError(res, result.error || 'Gagal memuat data', ErrorCode.INTERNAL, 500);
      return;
    }
    apiSuccess(res, result.data);
  } catch (e: any) {
    apiError(res, sanitizeError(e), ErrorCode.INTERNAL, 500);
  }
});

router.get('/api/stock/dashboard/charts', stockAuth, async (req: StockRequest, res: Response) => {
  const userId = req.stockUser!.id;
  const days = Math.min(90, parseInt(req.query.days as string) || 30);
  const channel = (req.query.channel as string) || '';
  try {
    const since = new Date(Date.now() - days * DAY_MS).toISOString();
    let query: any = supabase
      .from('transactions')
      .select('type, amount, description, created_at')
      .eq('user_id', userId)
      .gte('created_at', since)
      .order('created_at', { ascending: true });
    if (channel) query = query.eq('channel', channel);
    const { data: trans } = (await query) as any;

    const dailyMap: Record<string, { revenue: number; expense: number }> = {};
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      dailyMap[d.toISOString().slice(0, 10)] = { revenue: 0, expense: 0 };
    }
    (trans || []).forEach((t: any) => {
      const key = t.created_at.slice(0, 10);
      if (dailyMap[key]) {
        const v = Number(t.amount) || 0;
        if (t.type === 'masuk') dailyMap[key].revenue += v;
        else dailyMap[key].expense += v;
      }
    });
    const labels = Object.keys(dailyMap);
    const revenue = Object.values(dailyMap).map((d: any) => d.revenue);
    const expense = Object.values(dailyMap).map((d: any) => d.expense);

    const expenseMap: Record<string, number> = {};
    (trans || [])
      .filter((t: any) => t.type === 'keluar')
      .forEach((t: any) => {
        const d = (t.description || '').toLowerCase();
        let cat = 'Lainnya';
        if (d.includes('gaji')) cat = 'Gaji';
        else if (d.includes('sewa')) cat = 'Sewa';
        else if (d.includes('listrik') || d.includes('air')) cat = 'Listrik & Air';
        else if (d.includes('transport') || d.includes('bensin')) cat = 'Transportasi';
        else if (d.includes('produk') || d.includes('beli')) cat = 'Pembelian Stok';
        expenseMap[cat] = (expenseMap[cat] || 0) + (Number(t.amount) || 0);
      });
    const expenseLabels = Object.keys(expenseMap);
    const expenseValues = Object.values(expenseMap);

    const { data: prodTrans } = (await supabase
      .from('transactions')
      .select('product_id, amount, quantity, products!inner(name)')
      .eq('user_id', userId)
      .eq('type', 'masuk')
      .not('product_id', 'is', null)
      .gte('created_at', since)
      .limit(1000)) as any;
    const productMap: Record<string, { revenue: number; qty: number }> = {};
    (prodTrans || []).forEach((t: any) => {
      const name = t.products?.name || 'Unknown';
      productMap[name] = productMap[name] || { revenue: 0, qty: 0 };
      productMap[name].revenue += Number(t.amount) || 0;
      productMap[name].qty += Number(t.quantity) || 1;
    });
    const topProducts = Object.entries(productMap)
      .map(([name, data]) => ({ name, ...data }))
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 5);

    apiSuccess(res, { labels, revenue, expense, expenseLabels, expenseValues, topProducts });
  } catch (e: any) {
    apiError(res, sanitizeError(e), ErrorCode.INTERNAL, 500);
  }
});

router.get('/api/stock/alerts', stockAuth, async (req: StockRequest, res: Response) => {
  const userId = req.stockUser!.id;
  try {
    const result = await stockManager.getPendingAlerts(userId);
    if (!result.success) {
      apiError(res, result.error || 'Gagal memuat notifikasi', ErrorCode.INTERNAL, 500);
      return;
    }
    apiSuccess(res, { alerts: result.alerts || [] });
  } catch (e: any) {
    apiError(res, sanitizeError(e), ErrorCode.INTERNAL, 500);
  }
});

router.patch('/api/stock/alerts/read', stockAuth, async (req: StockRequest, res: Response) => {
  const userId = req.stockUser!.id;
  try {
    const { error } = await supabase
      .from('stock_alerts')
      .update({ resolved_at: new Date().toISOString() })
      .eq('user_id', userId)
      .is('resolved_at', null);
    if (error) {
      if (pgPool) {
        await pgPool.query(
          `UPDATE stock_alerts SET resolved_at = NOW() WHERE user_id = $1 AND resolved_at IS NULL`,
          [userId],
        );
      } else {
        apiError(res, sanitizeError(error), ErrorCode.DB_ERROR, 500);
        return;
      }
    }
    apiSuccess(res, { success: true });
  } catch (e: any) {
    apiError(res, sanitizeError(e), ErrorCode.INTERNAL, 500);
  }
});

// ── Excel Export ──

router.get('/api/stock/export/laba-rugi', stockAuth, async (req: StockRequest, res: Response) => {
  const userId = req.stockUser!.id;
  const days = parseInt(req.query.days as string) || 30;
  const channel = (req.query.channel as string) || '';
  try {
    let rows: any[];
    let totalRevenue = 0,
      totalCOGS = 0,
      totalExpense = 0;
    if (channel) {
      const since = new Date(Date.now() - days * DAY_MS).toISOString();
      const { data: trans } = (await supabase
        .from('transactions')
        .select('type, reference_type, amount, price_buy, quantity')
        .eq('user_id', userId)
        .eq('channel', channel)
        .gte('created_at', since)) as any;
      let revenue = 0,
        expense = 0,
        hpp = 0;
      (trans || []).forEach((t: any) => {
        const v = Number(t.amount) || 0;
        if (t.type === 'masuk' && t.reference_type !== 'modal') revenue += v;
        else if (t.type === 'keluar') expense += v;
        if (t.reference_type === 'cashier') hpp += (Number(t.quantity) || 0) * (Number(t.price_buy) || 0);
      });
      totalRevenue = revenue;
      totalCOGS = hpp;
      totalExpense = expense;
      rows = [
        { Kode: 'TRX', Akun: `Transaksi ${channel}`, Tipe: 'Pendapatan', Jumlah: revenue },
        { Kode: 'HPP', Akun: 'Harga Pokok Penjualan', Tipe: 'HPP', Jumlah: hpp },
        { Kode: 'BIAYA', Akun: 'Biaya Operasional', Tipe: 'Beban', Jumlah: expense },
        { Kode: 'LABA', Akun: 'Laba Bersih', Tipe: '-', Jumlah: revenue - hpp - expense },
      ];
    } else {
      const result = await accountingEngine.getLabaRugi(
        userId,
        new Date(Date.now() - days * DAY_MS).toISOString(),
        new Date().toISOString(),
      );
      if (!result.success || !result.data) {
        apiError(res, 'Gagal muat data', ErrorCode.INTERNAL, 500);
        return;
      }
      const d = result.data;
      totalRevenue = d.totalRevenue;
      totalCOGS = d.totalCOGS;
      totalExpense = d.totalExpense;
      rows = d.rows.map((r: any) => ({
        Kode: r.account_code,
        Akun: r.account_name,
        Tipe: r.account_type === 'revenue' ? 'Pendapatan' : r.account_type === 'cogs' ? 'HPP' : 'Beban',
        Jumlah: r.total,
      }));
    }
    rows.push({ Kode: '', Akun: 'Laba Bersih', Tipe: '', Jumlah: totalRevenue - totalCOGS - totalExpense });
    const buf = await generateExcel(
      [
        {
          name: 'Laba Rugi',
          columns: [
            { header: 'Kode', key: 'Kode', width: 12 },
            { header: 'Akun', key: 'Akun', width: 30 },
            { header: 'Tipe', key: 'Tipe', width: 15 },
            { header: 'Jumlah', key: 'Jumlah', width: 18 },
          ],
          rows,
        },
      ],
      `LabaRugi-${days}d.xlsx`,
    );
    res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.set('Content-Disposition', `attachment; filename="LabaRugi-${days}d.xlsx"`);
    res.send(buf);
  } catch (e: any) {
    apiError(res, sanitizeError(e), ErrorCode.INTERNAL, 500);
  }
});

router.get('/api/stock/export/neraca', stockAuth, async (req: StockRequest, res: Response) => {
  const userId = req.stockUser!.id;
  try {
    const result = await accountingEngine.getBalanceSheet(userId);
    if (!result.success || !result.data) {
      apiError(res, 'Gagal muat data', ErrorCode.INTERNAL, 500);
      return;
    }
    const d = result.data;
    const rows: Record<string, any>[] = [];
    (d.aset?.items || []).forEach((i: any) =>
      rows.push({ Kode: i.code, Akun: i.name, Kelompok: 'Aset', Jumlah: i.absolute }),
    );
    (d.liabilitas?.items || []).forEach((i: any) =>
      rows.push({ Kode: i.code, Akun: i.name, Kelompok: 'Liabilitas', Jumlah: i.absolute }),
    );
    (d.ekuitas?.items || []).forEach((i: any) =>
      rows.push({ Kode: i.code, Akun: i.name, Kelompok: 'Ekuitas', Jumlah: i.absolute }),
    );
    const buf = await generateExcel(
      [
        {
          name: 'Neraca',
          columns: [
            { header: 'Kode', key: 'Kode', width: 12 },
            { header: 'Akun', key: 'Akun', width: 30 },
            { header: 'Kelompok', key: 'Kelompok', width: 15 },
            { header: 'Jumlah', key: 'Jumlah', width: 18 },
          ],
          rows,
        },
      ],
      'Neraca.xlsx',
    );
    res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.set('Content-Disposition', 'attachment; filename="Neraca.xlsx"');
    res.send(buf);
  } catch (e: any) {
    apiError(res, sanitizeError(e), ErrorCode.INTERNAL, 500);
  }
});

router.get('/api/stock/export/arus-kas', stockAuth, async (req: StockRequest, res: Response) => {
  const userId = req.stockUser!.id;
  const days = parseInt(req.query.days as string) || 30;
  try {
    const since = new Date(Date.now() - days * DAY_MS).toISOString();
    const { data: trans } = (await supabase
      .from('transactions')
      .select('created_at, type, amount, channel, description')
      .eq('user_id', userId)
      .gte('created_at', since)
      .order('created_at', { ascending: false })) as any;
    const rows = (trans || []).map((t: any) => ({
      Tanggal: new Date(t.created_at).toLocaleDateString('id-ID'),
      Tipe: t.type === 'masuk' ? 'Pemasukan' : 'Pengeluaran',
      Keterangan: t.description || '',
      Channel: t.channel || '-',
      Jumlah: t.type === 'masuk' ? Number(t.amount) : -Number(t.amount),
    }));
    const buf = await generateExcel(
      [
        {
          name: 'Arus Kas',
          columns: [
            { header: 'Tanggal', key: 'Tanggal', width: 14 },
            { header: 'Tipe', key: 'Tipe', width: 14 },
            { header: 'Keterangan', key: 'Keterangan', width: 35 },
            { header: 'Channel', key: 'Channel', width: 14 },
            { header: 'Jumlah', key: 'Jumlah', width: 18 },
          ],
          rows,
        },
      ],
      `ArusKas-${days}d.xlsx`,
    );
    res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.set('Content-Disposition', `attachment; filename="ArusKas-${days}d.xlsx"`);
    res.send(buf);
  } catch (e: any) {
    apiError(res, sanitizeError(e), ErrorCode.INTERNAL, 500);
  }
});

router.get('/api/stock/export/pembukuan', stockAuth, async (req: StockRequest, res: Response) => {
  const userId = req.stockUser!.id;
  const days = parseInt(req.query.days as string) || 30;
  const channel = (req.query.channel as string) || '';
  const search = (req.query.search as string) || '';
  try {
    let query: any = supabase
      .from('transactions')
      .select('created_at, type, amount, description, channel, customer_name')
      .eq('user_id', userId)
      .gte('created_at', new Date(Date.now() - days * DAY_MS).toISOString())
      .order('created_at', { ascending: false });
    if (channel) query = query.eq('channel', channel);
    if (search) {
      const safe = search.replace(/[%_]/g, '');
      query = query.or(`description.ilike.%${safe}%,customer_name.ilike.%${safe}%`);
    }
    const { data: trans } = (await query) as any;
    const rows = (trans || []).map((t: any) => ({
      Tanggal: new Date(t.created_at).toLocaleDateString('id-ID'),
      Tipe: t.type === 'masuk' ? 'Pemasukan' : 'Pengeluaran',
      Keterangan: t.description || '',
      Channel: t.channel || '-',
      Pelanggan: t.customer_name || '-',
      Jumlah: Number(t.amount),
    }));
    const buf = await generateExcel(
      [
        {
          name: 'Pembukuan',
          columns: [
            { header: 'Tanggal', key: 'Tanggal', width: 14 },
            { header: 'Tipe', key: 'Tipe', width: 14 },
            { header: 'Keterangan', key: 'Keterangan', width: 35 },
            { header: 'Channel', key: 'Channel', width: 14 },
            { header: 'Pelanggan', key: 'Pelanggan', width: 18 },
            { header: 'Jumlah', key: 'Jumlah', width: 18 },
          ],
          rows,
        },
      ],
      'Pembukuan.xlsx',
    );
    res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.set('Content-Disposition', 'attachment; filename="Pembukuan.xlsx"');
    res.send(buf);
  } catch (e: any) {
    apiError(res, sanitizeError(e), ErrorCode.INTERNAL, 500);
  }
});

router.get('/api/stock/export/produk', stockAuth, async (req: StockRequest, res: Response) => {
  const userId = req.stockUser!.id;
  try {
    const { data: products } = (await supabase
      .from('products')
      .select('sku, name, category, unit, price_buy, price_sell, stock_current, stock_min, default_channel')
      .eq('user_id', userId)
      .eq('is_active', true)
      .order('name')) as any;
    const rows = (products || []).map((p: any) => ({
      SKU: p.sku,
      Nama: p.name,
      Kategori: p.category || '-',
      Satuan: p.unit || '-',
      'Harga Beli': p.price_buy || 0,
      'Harga Jual': p.price_sell || 0,
      Stok: p.stock_current || 0,
      'Stok Min': p.stock_min || 0,
      Channel: p.default_channel || 'Semua',
    }));
    const buf = await generateExcel(
      [
        {
          name: 'Produk',
          columns: [
            { header: 'SKU', key: 'SKU', width: 16 },
            { header: 'Nama', key: 'Nama', width: 28 },
            { header: 'Kategori', key: 'Kategori', width: 14 },
            { header: 'Satuan', key: 'Satuan', width: 10 },
            { header: 'Harga Beli', key: 'Harga Beli', width: 14 },
            { header: 'Harga Jual', key: 'Harga Jual', width: 14 },
            { header: 'Stok', key: 'Stok', width: 10 },
            { header: 'Stok Min', key: 'Stok Min', width: 10 },
            { header: 'Channel', key: 'Channel', width: 14 },
          ],
          rows,
        },
      ],
      'Produk.xlsx',
    );
    res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.set('Content-Disposition', 'attachment; filename="Produk.xlsx"');
    res.send(buf);
  } catch (e: any) {
    apiError(res, sanitizeError(e), ErrorCode.INTERNAL, 500);
  }
});

// ── Demo Account Setup (one-time) ──

router.post('/api/stock/demo/setup', async (req: Request, res: Response) => {
  try {
    const result = await setupDemoAccount();
    if (result.error) {
      apiError(res, result.error, ErrorCode.INTERNAL, 500);
      return;
    }
    apiSuccess(res, result);
  } catch (e: any) {
    apiError(res, sanitizeError(e), ErrorCode.INTERNAL, 500);
  }
});

export default router;
