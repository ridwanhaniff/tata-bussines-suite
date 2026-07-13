import crypto from 'crypto';
import { MessageMedia } from 'whatsapp-web.js';

import supabase from '../config/supabase';
import { sendReport } from '../jobs/scheduler';
import { transcribeAudio, extractTextFromImage } from '../utils/mediaProcessor';
import * as stockManager from '../utils/stockManager';
import * as transactionRecorder from '../utils/transactionRecorder';
import accountingEngine from '../utils/accountingEngine';
import * as geminiRouter from '../utils/geminiRouter';
import {
  parseCurrency,
  parseQuantity,
  formatPhone,
  formatRupiah,
  getDailyTransactionCount,
  getEffectiveStatus,
  getDaysRemaining,
  buildStatusMessage,
  fuzzyMatchKeywords,
} from '../utils/helpers';
import { PACKAGES, PAYMENT } from '../config/packages';
import {
  KW_KELUAR,
  KW_MASUK,
  KW_STATUS,
  KW_LAPORAN,
  KW_BANTUAN,
  KW_UPGRADE,
  KW_BATAL,
  KW_STOCK,
  KW_PRODUCT,
  KW_DASHBOARD,
  KW_BAHAN,
  KW_BAHAN_MASUK,
  KW_BAHAN_KELUAR,
  KW_RESEP,
} from '../config/keywords';
import { addLog } from '../config/state';
import { circuitIsOpen, circuitRecordSuccess, circuitRecordFailure } from '../services/circuit-breaker';
import {
  sanitizeError,
  isMessageProcessed,
  markMessageProcessed,
  onboardingStates,
  graduatedVirtualUsers,
  safeReply,
  getMaintenanceMode,
  invalidateMaintenanceCache,
  withSenderLock,
} from '../config/message-state';
import {
  setDialog,
  getDialog,
  hasDialog,
  removeDialog,
  clearAllDialogs,
  getNextDialog,
  getExpiredDialogTypes,
  sortedDialogs,
} from '../services/dialog-state.service';
import { generateUniqueSlug } from '../utils/slug';
import {
  handleStockList,
  handleStockInfo,
  handleStockReport,
  handleBahanList,
  handleBahanMasuk,
  handleBahanKeluar,
  handleResep,
} from './stock-handler';
import {
  handleInvoiceCommand,
  handleSetBankCommand,
  generateInvoiceNumber,
  normalizeWaNumber,
  getBankCache,
  setBankCache,
  generateInvoicePDF,
} from './invoice-handler';
import { handleOnboardingStep } from './onboarding';

async function handleStockInOutCommand(
  msg: any,
  user: any,
  productQuery: string,
  quantityStr: string,
  type: 'in' | 'out',
): Promise<boolean> {
  const qty = parseFloat(quantityStr.replace(',', '.'));
  if (isNaN(qty) || qty <= 0) {
    await safeReply(
      msg,
      `⚠️ Jumlah tidak valid: *${quantityStr}*.\nContoh: *${type === 'in' ? 'Masuk' : 'Keluar'} kopi 10*`,
    );
    return true;
  }
  const searchRes = await stockManager.searchProductByName(user.id, productQuery);
  if (!searchRes.success || !searchRes.products || searchRes.products.length === 0) {
    await safeReply(
      msg,
      `⚠️ Produk "*${productQuery}*" tidak ditemukan.\nKetik *Stock list* untuk lihat daftar produk.`,
    );
    return true;
  }
  const product = searchRes.products[0] as any;

  if (type === 'out') {
    const chs: string[] = (product.channels || []).filter((c: any) => c && typeof c === 'string');
    if (chs.length > 1) {
      setDialog(user.id, 'keluar_channel', {
        productId: product.id,
        productName: product.name,
        qty,
        unit: product.unit,
        channels: chs,
      });
      const list = chs.map((c, i) => `${i + 1}. ${c}`).join('\n');
      await safeReply(
        msg,
        `⚠️ *${product.name}* punya *${chs.length} channel* penjualan.\n\nPilih channel:\n\n${list}\n\nBalas *angka 1-${chs.length}* untuk memilih, atau *Batal* untuk membatalkan.`,
      );
      return true;
    }
    const channel = chs.length === 1 ? chs[0] : product.default_channel || 'Offline';
    return await executeStockAdjustment(msg, user, product, qty, type, channel);
  }

  return await executeStockAdjustment(msg, user, product, qty, type, 'Offline');
}

async function executeStockAdjustment(
  msg: any,
  user: any,
  product: any,
  qty: number,
  type: 'in' | 'out',
  channel: string,
): Promise<boolean> {
  const note = type === 'in' ? 'Restok via WA' : 'Penjualan via WA';
  const res = await transactionRecorder.recordStockAdjustment({
    userId: user.id,
    productId: product.id,
    type,
    quantity: qty,
    note,
    channel,
    recordTransaction: type === 'out',
  });
  if (!res.success) {
    await safeReply(msg, `❌ *Gagal*\n\n${res.error}`);
    return true;
  }
  const d = res.data as any;
  const label = type === 'in' ? 'Stok Masuk' : 'Terjual';

  let bomText = '';
  if (type === 'out') {
    try {
      const bomResult = await stockManager.deductPackaging(user.id, qty, note, product.id);
      if (bomResult.deducted && bomResult.deducted.length > 0) {
        bomText =
          '\n\n📦 *Bahan terpakai*:\n' +
          bomResult.deducted
            .map((b: any) => `• ${b.name}: -${stockManager.formatQty(b.deducted, b.unit)} ${b.unit}`)
            .join('\n');
      }
      if (bomResult.warnings && bomResult.warnings.length > 0) {
        bomText += '\n⚠️ ' + bomResult.warnings.join('\n⚠️ ');
      }
    } catch (bomErr: any) {
      addLog('error', `[BOM] deductPackaging error di WA command '${type}': ${bomErr.message}`);
    }
  }

  await safeReply(
    msg,
    `✅ *${label}* ${product.name}\n\n` +
      `${stockManager.formatQty(d.stockBefore, d.product.unit)} ${d.product.unit} → ` +
      `${stockManager.formatQty(d.stockAfter, d.product.unit)} ${d.product.unit}${bomText}`,
  );
  return true;
}

async function showUpgradeMenu(msg: any, user: any, effectiveStatus: string): Promise<void> {
  if (effectiveStatus === 'unlimited') {
    await safeReply(
      msg,
      `💎 Bos *${user.store_name}* sudah berlangganan *UNLIMITED* selamanya!\nSemua fitur sudah aktif tanpa batas. Terima kasih! 🙏`,
    );
    return;
  }
  let currentInfo = '';
  if (effectiveStatus === 'pro') {
    const sisa = getDaysRemaining(user);
    currentInfo = `\n📌 Status sekarang: *PRO* — sisa *${sisa} hari*\n`;
  }
  await safeReply(
    msg,
    `💰 *Pilih Paket - ${user.store_name}*\n${currentInfo}\n━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `⭐ *1. PRO Bulanan — ${PACKAGES.pro.priceStr}*\n${PACKAGES.pro.features.map((f: string) => `   ✅ ${f}`).join('\n')}` +
      `\n\n💎 *2. UNLIMITED Selamanya — ${PACKAGES.unlimited.priceStr}*\n${PACKAGES.unlimited.features.map((f: string) => `   ✅ ${f}`).join('\n')}` +
      `\n━━━━━━━━━━━━━━━━━━━━━━━\nKetik *Pilih 1* untuk PRO Bulanan\nKetik *Pilih 2* untuk UNLIMITED Selamanya`,
  );
}

async function handlePackageSelection(msg: any, sender: string, user: any, body: string): Promise<boolean> {
  let pkg: any = null;
  if (body === 'pilih 1' || body === 'pilih pro' || body === '1' || body === 'paket 1') pkg = PACKAGES.pro;
  if (body === 'pilih 2' || body === 'pilih unlimited' || body === '2' || body === 'paket 2') pkg = PACKAGES.unlimited;
  if (!pkg) return false;

  const { error } = (await supabase
    .from('users')
    .update({ is_upgrading: true, upgrade_package: pkg.key })
    .eq('id', sender)) as any;
  if (error) throw new Error(`Gagal set upgrade: ${error.message}`);

  await safeReply(
    msg,
    `${pkg.emoji} *${pkg.label} - ${user.store_name}*\n\n` +
      `Transfer sebesar *${pkg.priceStr}* ke:\n💳 *${PAYMENT.bank} — ${PAYMENT.account}*\n   a/n ${PAYMENT.name}\n\n` +
      `Setelah transfer, *kirim foto bukti* di sini.\nAdmin akan verifikasi dalam 1×24 jam. ✅\n\nKetik *Batal* untuk membatalkan.`,
  );
  return true;
}

async function handleTransferProof(msg: any, client: any, sender: string, user: any): Promise<void> {
  let media: any = await msg.downloadMedia().catch(() => null);
  if (!media) {
    await safeReply(msg, '❌ Gagal mengunduh gambar. Coba kirim ulang ya Bos.\n\nAtau ketik Batal untuk membatalkan.');
    return;
  }

  const pkg = user.upgrade_package && PACKAGES[user.upgrade_package] ? PACKAGES[user.upgrade_package] : PACKAGES.pro;

  const { error: upErr } = (await supabase
    .from('upgrades')
    .insert([{ user_id: sender, package: pkg.key, status: 'pending' }])) as any;
  if (upErr) throw new Error(`Gagal simpan upgrade: ${upErr.message}`);

  (await supabase.from('users').update({ is_upgrading: false, upgrade_package: null }).eq('id', sender)) as any;

  try {
    const admin: string = client.info?.wid?._serialized;
    if (admin) {
      await client.sendMessage(admin, media, {
        caption: `🚨 *PERMINTAAN UPGRADE ${pkg.label.toUpperCase()}*\n🏪 Toko   : ${user.store_name}\n📱 WA     : ${formatPhone(sender)}\n💰 Paket  : ${pkg.label} (${pkg.priceStr})\n🕐 Waktu  : ${new Date().toLocaleString('id-ID')}`,
      });
    }
    media = null;
  } catch (e: any) {
    addLog('warn', `[WARN] Gagal kirim bukti ke admin: ${e.message}`);
  }

  await safeReply(
    msg,
    `✅ *Bukti transfer diterima!*\n\nPaket      : *${pkg.label}*\nNominal    : *${pkg.priceStr}*\n\nAdmin akan memverifikasi dalam 1×24 jam.\nNotifikasi otomatis dikirim saat akun aktif. 🚀`,
  );
}

async function lookupBehavior(
  userId: string,
  keyword: string,
): Promise<{ classified_as: string; confidence: number } | null> {
  try {
    const { data, error } = (await supabase
      .from('user_behavior_logs')
      .select('classified_as, confidence')
      .eq('user_id', userId)
      .eq('keyword', keyword.toLowerCase())
      .maybeSingle()) as any;
    if (error || !data) return null;
    return data;
  } catch (_: any) {
    addLog('error', '[BEHAVIOR] getBehavior error: ' + _.message);
    return null;
  }
}

async function saveBehavior(
  userId: string,
  keyword: string,
  classifiedAs: string,
  source = 'user_confirm',
): Promise<void> {
  try {
    (await supabase.rpc('upsert_behavior', {
      p_user_id: userId,
      p_keyword: keyword.toLowerCase(),
      p_classified_as: classifiedAs,
      p_source: source,
    })) as any;
  } catch (err: any) {
    addLog('error', `[LEARNING] Failed to save behavior: ${err.message}`);
  }
}

function extractAmbiguousKeywords(body: string): string[] {
  const allKeywords = new Set([...KW_KELUAR, ...KW_MASUK]);
  const words = body.split(/\s+/);
  const candidates: string[] = [];
  for (const w of words) {
    const lower = w.toLowerCase();
    if (allKeywords.has(lower)) continue;
    if (parseCurrency(w) !== null) continue;
    if (parseQuantity(w) !== null) continue;
    if (lower.length < 2 || lower.length > 30) continue;
    if (/^\d/.test(lower)) continue;
    candidates.push(lower);
  }
  return candidates;
}

async function postTrxJournal(userId: string, type: string, amount: number, description: string, referenceId?: string) {
  try {
    if (type === 'masuk') {
      await accountingEngine.postJournal({
        userId,
        referenceType: 'manual',
        referenceId,
        description: description || 'Pemasukan',
        lines: [
          { accountCode: '1101', debit: amount, credit: 0, description: 'Penerimaan' },
          { accountCode: '4101', debit: 0, credit: amount, description: 'Pendapatan' },
        ],
      });
    } else if (type === 'keluar') {
      await accountingEngine.postJournal({
        userId,
        referenceType: 'manual',
        referenceId,
        description: description || 'Pengeluaran',
        lines: [
          { accountCode: '6105', debit: amount, credit: 0, description: 'Beban operasional' },
          { accountCode: '1101', debit: 0, credit: amount, description: 'Pembayaran' },
        ],
      });
    }
  } catch (e: any) {
    addLog('error', `[MSG] postJournal error: ${e.message}`);
    throw e;
  }
}

async function findProductInMessage(userId: string, body: string): Promise<{ id: number; name: string } | null> {
  try {
    const { data: products } = (await supabase
      .from('products')
      .select('id, name')
      .eq('user_id', userId)
      .eq('is_active', true)) as any;
    if (!products || products.length === 0) return null;
    const bodyLower = body.toLowerCase();
    for (const p of products) {
      if (p.name && bodyLower.includes(p.name.toLowerCase())) return p;
    }
    return null;
  } catch (_: any) {
    addLog('error', '[MSG] matchProductByName error: ' + _.message);
    return null;
  }
}

function getDashboardUrl(): string {
  return (process.env.APP_URL || 'https://nickridwan-tata-business-suite.hf.space').replace(/\/+$/, '');
}

const geminiCache = new Map<string, { result: any; ts: number }>();
const GEMINI_CACHE_TTL = 24 * 60 * 60 * 1000;

async function classifyTransactionWithGemini(text: string): Promise<any> {
  if (!process.env.OPENROUTER_API_KEY || process.env.OPENROUTER_API_KEY === 'DUMMY_KEY') return null;

  const cacheKey = text.toLowerCase().trim().slice(0, 200);
  const cached = geminiCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < GEMINI_CACHE_TTL) {
    addLog('info', '[GEMINI-CACHE] Hit for: ' + cacheKey.slice(0, 60));
    return cached.result;
  }

  try {
    const result = await geminiRouter.processMessageWithGemini(text);
    if (!result || !result.intent) return null;

    let type: string | null = null;
    let pembukuan: string | null = null;
    if (result.intent === 'pemasukan') type = 'masuk';
    else if (result.intent === 'pengeluaran') type = 'keluar';
    else if (result.intent === 'buat_invoice') return { type: '__invoice__', intent: 'buat_invoice', raw: result };
    else if (result.intent === 'hutang') pembukuan = 'hutang_dagang';
    else if (result.intent === 'bayar_hutang') return { type: '__bayar_hutang__', intent: 'bayar_hutang', raw: result };
    else if (result.intent === 'terima_piutang')
      return { type: '__terima_piutang__', intent: 'terima_piutang', raw: result };
    else if (result.intent === 'retur_jual') return { type: '__retur_jual__', intent: 'retur_jual', raw: result };
    else if (result.intent === 'retur_beli') return { type: '__retur_beli__', intent: 'retur_beli', raw: result };
    else if (Object.keys(transactionRecorder.PEMBUKUAN_COA_MAP).includes(result.intent)) pembukuan = result.intent;
    else return null;

    const out = {
      type,
      pembukuan,
      items: result.items || [],
      customerName: result.customer_name || null,
      statusPayment: result.status_pembayaran || 'tunai',
      catatan: result.catatan || null,
    };
    geminiCache.set(cacheKey, { result: out, ts: Date.now() });
    if (geminiCache.size > 500) {
      const entries = Array.from(geminiCache.entries()).sort((a, b) => a[1].ts - b[1].ts);
      const toRemove = entries.slice(0, entries.length - 400);
      toRemove.forEach(([k]) => geminiCache.delete(k));
    }
    return out;
  } catch (err: any) {
    addLog('error', '[GEMINI] Classification failed: ' + sanitizeError(err));
    return null;
  }
}

async function handleTransaction(
  msg: any,
  sender: string,
  user: any,
  effectiveStatus: string,
  rawBody: string,
  body: string,
  client: any,
): Promise<boolean> {
  let type: string | null = null,
    amount: number | null = null;
  const descWords: string[] = [];

  const wordBoundaryInSet = (s: string, set: readonly string[]) =>
    set.some((k: string) => new RegExp('\\b' + k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i').test(s));
  const exactMasuk = wordBoundaryInSet(body, KW_MASUK) || fuzzyMatchKeywords(body, KW_MASUK);
  const exactKeluar = wordBoundaryInSet(body, KW_KELUAR) || fuzzyMatchKeywords(body, KW_KELUAR);

  if (exactMasuk && !exactKeluar) type = 'masuk';
  else if (exactKeluar && !exactMasuk) type = 'keluar';
  else if (exactMasuk && exactKeluar) {
    const countMasuk = KW_MASUK.filter((k) =>
      new RegExp('\\b' + k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i').test(body),
    ).length;
    const countKeluar = KW_KELUAR.filter((k) =>
      new RegExp('\\b' + k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i').test(body),
    ).length;
    // Tie-break: default ke 'masuk' kalau count sama — perlu dikonfirmasi ke pemilik produk apakah ini memang disengaja
    type = countMasuk >= countKeluar ? 'masuk' : 'keluar';
  }

  let matchedProductKeyword: string | null = null;
  if (!type) {
    try {
      const { data: products } = (await supabase
        .from('products')
        .select('name')
        .eq('user_id', sender)
        .eq('is_active', true)) as any;
      if (products) {
        for (const p of products) {
          if (p.name && body.includes(p.name.toLowerCase())) {
            type = 'masuk';
            matchedProductKeyword = p.name.toLowerCase();
            break;
          }
        }
      }
    } catch (_: any) {
      addLog('error', '[MSG] keyword matching error: ' + _.message);
    }
  }

  if (!type) {
    const ambiguousWords = extractAmbiguousKeywords(body);
    for (const word of ambiguousWords) {
      const learned = await lookupBehavior(sender, word);
      if (learned && learned.confidence >= 50) {
        type = learned.classified_as;
        descWords.push(`[${word}→${type}]`);
        break;
      }
    }
  }

  const candidates: { val: number; word: string }[] = [];
  for (const word of rawBody.split(/\s+/)) {
    const val = parseCurrency(word);
    if (val !== null) candidates.push({ val, word });
    else descWords.push(word);
  }

  if (candidates.length > 0) {
    const withPrefix = candidates.find((c) => /^(rp|:)/i.test(c.word));
    amount = withPrefix ? withPrefix.val : Math.max(...candidates.map((c) => c.val));
  }

  if (type && !amount) {
    const ex = type === 'keluar' ? '*beli stok sembako 200rb*' : '*Jualan 25rb*';
    await safeReply(
      msg,
      `❌ *Nominalnya belum ada Bos.*\n\nContoh yang benar: ${ex}\n\nFormat angka yang didukung:\n• 20rb  • 50k  • 1.5jt  • 20.000  • 1000000`,
    );
    return true;
  }

  if (!type && amount) {
    const geminiResult = await classifyTransactionWithGemini(body);
    if (geminiResult && geminiResult.type === '__invoice__')
      return await handleInvoiceCommand(msg, sender, user, rawBody, client);
    if (geminiResult && geminiResult.intent === 'bayar_hutang') {
      return await handlePayHutang(msg, sender, user, amount!, geminiResult, rawBody, client);
    }
    if (geminiResult && geminiResult.intent === 'terima_piutang') {
      return await handleTerimaPiutang(msg, sender, user, amount!, geminiResult, rawBody, client);
    }
    if (geminiResult && geminiResult.intent === 'retur_jual') {
      return await handleReturJual(msg, sender, user, amount!, geminiResult, rawBody, client);
    }
    if (geminiResult && geminiResult.intent === 'retur_beli') {
      return await handleReturBeli(msg, sender, user, amount!, geminiResult, rawBody, client);
    }
    if (geminiResult && geminiResult.pembukuan) {
      const finalDesc =
        (
          geminiResult.catatan ||
          geminiResult.items
            ?.map((i: any) => i.nama_barang)
            .filter(Boolean)
            .join(', ') ||
          rawBody
        ).trim() || 'Tanpa keterangan';
      const coaMap = transactionRecorder.PEMBUKUAN_COA_MAP[geminiResult.pembukuan];
      const pembukuanLabel = coaMap?.label || geminiResult.pembukuan;
      const result = await transactionRecorder.recordPembukuan({
        userId: sender,
        tipe: geminiResult.pembukuan,
        amount: amount!,
        description: finalDesc,
        customerName: geminiResult.customerName || null,
      });
      if (result.success) {
        await safeReply(
          msg,
          `✅ *Pembukuan Berhasil Dicatat!*\n\n📋 Tipe : ${pembukuanLabel}\n💵 Nominal : ${formatRupiah(amount)}\n${geminiResult.customerName ? `👤 Pihak : ${geminiResult.customerName}\n` : ''}📝 Keterangan : ${finalDesc}`,
        );
        return true;
      }
      await safeReply(msg, `❌ Gagal mencatat pembukuan: ${result.error}`);
      return true;
    }
    if (geminiResult && geminiResult.type) {
      type = geminiResult.type;
      if (geminiResult.customerName) descWords.push(`[${geminiResult.customerName}]`);
      if (geminiResult.catatan) descWords.push(geminiResult.catatan);
    }
  }

  if (!type && amount) {
    const ambiguousWords = extractAmbiguousKeywords(body);
    if (ambiguousWords.length > 0) {
      setDialog(sender, 'classification', { amount, rawBody, body, ambiguousWord: ambiguousWords[0], descWords });
      await safeReply(
        msg,
        `🤔 *Konfirmasi Tipe Transaksi*\n\nSaya menemukan kata "*${ambiguousWords[0]}*" dengan nominal ${formatRupiah(amount)}.\n\nIni termasuk:\n📥 *Masuk* (pemasukan/penjualan)\n📤 *Keluar* (pengeluaran/pembelian)\n\nBalas *Masuk* atau *Keluar* untuk mengonfirmasi.\nKetik *Batal* untuk membatalkan.`,
      );
      return true;
    }
    await safeReply(
      msg,
      `❌ *Tipe transaksinya belum jelas Bos.*\n\n📥 Masuk : *jual nasi goreng ${formatRupiah(amount)}*\n📤 Keluar: *beli stok kopi ${formatRupiah(amount)}*`,
    );
    return true;
  }

  if (!type && !amount) return false;

  if (effectiveStatus === 'demo') {
    const todayCount = await getDailyTransactionCount(sender);
    if (todayCount >= 5) {
      await safeReply(
        msg,
        `⚠️ *Limit Harian Demo Habis!*\n\nSudah *${todayCount} transaksi* hari ini.\nLimit reset otomatis besok pukul 00:00.\n\n💡 Ketik *Paket* untuk upgrade tanpa batas.`,
      );
      return true;
    }
  }

  const finalDesc =
    descWords
      .filter((w: string) => {
        const wl = w.toLowerCase();
        return !KW_KELUAR.includes(wl) && !KW_MASUK.includes(wl) && parseCurrency(w) === null;
      })
      .join(' ')
      .trim() || 'Tanpa keterangan';

  const matchedProduct = await findProductInMessage(sender, body);

  if (matchedProduct) {
    const tipeEmoji = type === 'masuk' ? '📥' : '📤';
    const tipeLabel = type === 'masuk' ? 'MASUK' : 'KELUAR';
    setDialog(sender, 'tx_confirmation', {
      type,
      amount,
      description: finalDesc,
      product: matchedProduct,
      effectiveStatus,
    });
    await safeReply(
      msg,
      `📋 *Konfirmasi Transaksi*\n\n${tipeEmoji} *${tipeLabel}*\n💵 Jumlah : ${formatRupiah(amount!)}\n📦 Produk : ${matchedProduct.name}\n📝 Ket    : ${finalDesc}\n\nBalas *Ya* untuk mencatat.\nBalas *Batal* untuk membatalkan.`,
    );
    return true;
  }

  let productList: any[] = [];
  try {
    const { data: allProducts } = (await supabase
      .from('products')
      .select('id, name')
      .eq('user_id', sender)
      .eq('is_active', true)
      .order('name', { ascending: true })) as any;
    productList = allProducts || [];
  } catch (_: any) {
    addLog('error', '[MSG] productList fetch failed: ' + _.message);
  }

  if (productList.length === 0) {
    const dashUrl = getDashboardUrl();
    const slug = user.store_slug || 'dashboard';
    await safeReply(
      msg,
      `❌ *Transaksi Ditolak*\n\nBelum ada produk terdaftar di inventori.\n\n📋 *Cara Mendaftar Produk:*\n1. Buka Dashboard Web:\n   ${dashUrl}/stock/${slug}\n2. Tambah produk beserta HPP awal\n3. Coba catat transaksi lagi\n\n💡 _Semua transaksi wajib merujuk produk yang terdaftar._`,
    );
    return true;
  }

  const tipeEmoji = type === 'masuk' ? '📥' : '📤';
  const tipeLabel = type === 'masuk' ? 'MASUK' : 'KELUAR';
  let listText = productList
    .slice(0, 15)
    .map((p: any, i: number) => `   ${i + 1}. ${p.name}`)
    .join('\n');
  if (productList.length > 15) listText += `\n   _...dan ${productList.length - 15} produk lainnya_`;

  setDialog(sender, 'product_selection', {
    type,
    amount,
    description: finalDesc,
    products: productList.slice(0, 15),
    effectiveStatus,
  });
  await safeReply(
    msg,
    `🤔 *Produk mana yang dimaksud?*\n\n${tipeEmoji} ${tipeLabel} — ${formatRupiah(amount!)}\n\nPilih produk:\n${listText}\n\nBalas *angka* untuk memilih produk.\nBalas *Batal* untuk membatalkan.`,
  );
  return true;
}

async function handleDashboardRequest(msg: any, sender: string, user: any): Promise<boolean> {
  const appUrl = (process.env.APP_URL || 'https://nickridwan-tata-business-suite.hf.space').replace(/\/+$/, '');

  let { data: userData } = (await supabase
    .from('users')
    .select('dashboard_token, dashboard_token_created_at, store_slug')
    .eq('id', sender)
    .maybeSingle()) as any;

  let token = userData?.dashboard_token;
  let slug = userData?.store_slug;

  if (!slug) {
    slug = await generateUniqueSlug(user.store_name || 'Toko Saya', supabase, sender);
    (await supabase.from('users').update({ store_slug: slug }).eq('id', sender)) as any;
  }

  if (!token) {
    token = crypto.randomBytes(16).toString('hex');
    (await supabase
      .from('users')
      .update({ dashboard_token: token, dashboard_token_created_at: new Date().toISOString() })
      .eq('id', sender)) as any;
  }

  const link = `${appUrl}/stock/${slug}?token=${token}`;

  await safeReply(
    msg,
    `📊 *Dashboard Stok — ${user.store_name}*\n_Tata Business Suite_\n\n` +
      `Akses dashboard stok Anda di sini:\n🔗 ${link}\n\n` +
      `✅ *Fitur dashboard:*\n` +
      `   • Tambah, edit & hapus produk\n` +
      `   • Catat stok masuk & keluar\n` +
      `   • Stock opname (hitung fisik)\n` +
      `   • Laporan & riwayat lengkap\n\n` +
      `⚠️ Jaga kerahasiaan link ini.\n` +
      `(Disarankan Buka website di pc/laptop.)\n\n` +
      `Ketik *Token baru* jika link bermasalah.`,
  );
  return true;
}

async function handleNewToken(msg: any, sender: string, user: any): Promise<boolean> {
  const appUrl = (process.env.APP_URL || 'https://nickridwan-tata-business-suite.hf.space').replace(/\/+$/, '');
  const token = crypto.randomBytes(16).toString('hex');
  (await supabase
    .from('users')
    .update({ dashboard_token: token, dashboard_token_created_at: new Date().toISOString() })
    .eq('id', sender)) as any;

  let { data: userData } = (await supabase.from('users').select('store_slug').eq('id', sender).maybeSingle()) as any;
  let slug = userData?.store_slug;
  if (!slug) {
    slug = await generateUniqueSlug(user.store_name || 'Toko Saya', supabase, sender);
    (await supabase.from('users').update({ store_slug: slug }).eq('id', sender)) as any;
  }

  const link = `${appUrl}/stock/${slug}?token=${token}`;
  await safeReply(
    msg,
    `🔑 *Link Dashboard Baru — Tata Business Suite*\n\n` +
      `Link lama sudah tidak berlaku.\n\n` +
      `Link baru Anda:\n🔗 ${link}\n\n` +
      `Simpan link ini. Jangan bagikan ke orang lain.\n` +
      `(Disarankan Buka website di pc/laptop.)`,
  );
  return true;
}

async function checkAndRegisterUser(sender: string, rawBody: string, msg: any): Promise<{ user: any; isNew: boolean }> {
  if (circuitIsOpen()) {
    addLog('warn', '[NEW USER] DB circuit open — returning virtual user');
    return { user: buildVirtualUser(sender, rawBody), isNew: true };
  }

  let { data: user, error: dbErr } = (await supabase.from('users').select('*').eq('id', sender).maybeSingle()) as any;

  if (dbErr && dbErr.code !== 'PGRST116') {
    const errMsg = sanitizeError(dbErr);
    if (errMsg.includes('[SUPABASE ERROR]')) circuitRecordFailure();
    addLog('error', '[MESSAGE HANDLER ERROR] DB query failed: ' + errMsg);
    return { user: buildVirtualUser(sender, rawBody), isNew: true };
  }

  if (user) {
    circuitRecordSuccess();
    return { user, isNew: false };
  }

  const isDaftar = rawBody.match(/^daftar\s+(.+)/i);

  if (!isDaftar) {
    addLog('info', `[NEW USER] Unknown sender, awaiting registration: ${sender}`);
    return { user: { id: sender, onboarding_status: 'unregistered' }, isNew: true };
  }

  let storeName = isDaftar[1].trim().substring(0, 50);
  if (!storeName) storeName = 'Toko Saya';

  // Check if store_name already taken
  const { data: nameTaken } = (await supabase
    .from('users')
    .select('id')
    .eq('store_name', storeName)
    .maybeSingle()) as any;
  if (nameTaken) {
    storeName = storeName + ' ' + Math.random().toString(36).substring(2, 5).toUpperCase();
    addLog('info', `[NEW USER] store_name taken, renamed to "${storeName}"`);
  }

  addLog('info', `[NEW USER] Registering: ${sender} as "${storeName}"`);

  const slug = await generateUniqueSlug(storeName, supabase);

  const newUser: any = {
    id: sender,
    store_name: storeName,
    store_slug: slug,
    status: 'demo',
    is_upgrading: false,
    upgrade_package: null,
    subscription_expires_at: null,
    dashboard_token: null,
  };

  let insErr: any;
  for (let attempt = 0; attempt < 3; attempt++) {
    const { error: e } = (await supabase.from('users').insert([newUser])) as any;
    insErr = e;
    if (!insErr) break;
    if (insErr.code === '23505') {
      const { data: existing } = (await supabase.from('users').select('*').eq('id', sender).maybeSingle()) as any;
      if (existing) {
        circuitRecordSuccess();
        return { user: existing, isNew: false };
      }
      continue;
    }
    break;
  }
  if (insErr) {
    const errMsg = sanitizeError(insErr);
    if (errMsg.includes('[SUPABASE ERROR]')) circuitRecordFailure();
    addLog('error', '[MESSAGE HANDLER ERROR] Insert failed: ' + errMsg);
    return { user: buildVirtualUser(sender, rawBody), isNew: true };
  }

  circuitRecordSuccess();
  newUser.onboarding_status = 'new_user';
  return { user: newUser, isNew: true };
}

function buildVirtualUser(sender: string, rawBody: string): any {
  let storeName = 'Toko Saya';
  const daftarMatch = rawBody?.match?.(/^daftar\s+(.+)/i);
  if (daftarMatch) storeName = daftarMatch[1].trim().substring(0, 50);
  return {
    id: sender,
    store_name: storeName,
    store_slug: null,
    status: 'demo',
    onboarding_status: 'new_user',
    is_upgrading: false,
    upgrade_package: null,
    subscription_expires_at: null,
    dashboard_token: null,
  };
}

async function handleMessage(msg: any, client: any): Promise<any> {
  if (!msg) {
    addLog('debug', '[MSG] Skip — null msg');
    return;
  }
  if (msg.from === 'status@broadcast') {
    addLog('debug', '[MSG] Skip — status broadcast');
    return;
  }
  if (msg.from.includes('@g.us')) {
    addLog('debug', `[MSG] Skip — group msg from ${msg.from}`);
    return;
  }
  if (msg.from.includes('-')) {
    addLog('debug', '[MSG] Skip — broadcast list');
    return;
  }
  if (msg.fromMe) {
    addLog('debug', '[MSG] Skip — fromMe');
    return;
  }

  const sender: string = msg.from;

  // Serialize per-sender to prevent race conditions on dialog maps
  return await withSenderLock(sender, async () => {
    if (msg.id && msg.id._serialized) {
      const isDuplicate = await isMessageProcessed(msg.id._serialized);
      if (isDuplicate) {
        addLog('info', `[DEDUP] Message ${msg.id._serialized} already processed — skip`);
        return;
      }
    }

    const rawBody: string = (msg.body || '').trim();
    let body: string = rawBody.toLowerCase();

    if (!rawBody && !msg.hasMedia) return;

    try {
      const maint = await getMaintenanceMode();
      if (maint?.active) {
        await safeReply(msg, maint.message);
        return;
      }

      const { user, isNew } = await checkAndRegisterUser(sender, rawBody, msg);

      if (isNew && !body.startsWith('daftar ')) {
        await safeReply(
          msg,
          `Halo! 👋 Tata di sini.\n` +
            `Sepertinya ini kali pertama nomor kamu terdaftar di sistem.\n\n` +
            `Selamat datang di *Tata Business Suite*! 🎉\n\n` +
            `Tata siap bantu kamu catat keuangan & stok toko dengan mudah.\n\n` +
            `Sebelum mulai, atur nama tokomu dulu ya:\n` +
            `📝 Ketik: *Daftar [Nama Toko]*\n` +
            `Contoh: *Daftar Warung Jaya*\n\n` +
            `Atau ketik *Bantuan* untuk lihat semua menu. 😊`,
        );
        return;
      }

      msg
        .getChat?.()
        .then((c: any) => c?.sendStateTyping())
        .catch(() => {});

      const isGraduatedVirtualUser = graduatedVirtualUsers.has(sender);
      if (
        (user?.onboarding_status === 'new_user' || user?.onboarding_status === 'onboarding') &&
        !isGraduatedVirtualUser
      ) {
        try {
          const handled = await handleOnboardingStep(msg, sender, user, body, client);
          if (handled) return;
        } catch (obErr: any) {
          addLog('error', '[ONBOARDING] State machine error: ' + obErr.message);
          await safeReply(msg, `⚠️ _Sesi panduan terganggu. Ketik *Batal* untuk ulang dari awal._`);
          return;
        }
      }

      const effectiveStatus = getEffectiveStatus(user);

      if (!user?.is_upgrading && msg.hasMedia) {
        const mime = (msg.type || '').toLowerCase();
        const isAudio = mime === 'ptt' || mime === 'audio';
        const isImage = mime === 'image';

        if (isAudio || isImage) {
          const loadingMsg = isAudio
            ? '🎙️ Sedang transkripsi suara... sebentar ya Bos.'
            : '📸 Sedang memindai struk... sebentar ya Bos.';
          await safeReply(msg, loadingMsg);

          try {
            let media: any = await msg.downloadMedia().catch(() => null);
            if (!media) {
              await safeReply(msg, '❌ Gagal mengunduh file. Coba kirim ulang ya Bos.');
            } else {
              let result: any = null;
              if (isAudio) result = await transcribeAudio(media);
              else result = await extractTextFromImage(media);
              media = null;

              if (!result.success) {
                const errMsg = isAudio
                  ? `❌ *Gagal memproses voice note*\n\n${result.error}\n\nCoba ketik pesannya langsung ya Bos.`
                  : `❌ *Gagal memindai struk*\n\n${result.error}\n\nTips:\n• Foto harus terang & tidak buram\n• Arahkan kamera tegak lurus\n• Pastikan tulisan terbaca jelas`;
                await safeReply(msg, errMsg);
              } else if (!result.hasTransaction || result.confidence < 25) {
                const preview = result.text.substring(0, 120).replace(/\n/g, ' ');
                const hint = isAudio
                  ? `💬 Terdengar: "_${preview}..._"\n\nSaya tidak mendeteksi transaksi keuangan di sana Bos. Coba sebut nominalnya dengan jelas, contoh: "jual nasi goreng dua puluh lima ribu".`
                  : `📄 Teks terdeteksi: "_${preview}..._"\n\nSaya tidak menemukan info transaksi di struk ini Bos. Coba ketik manual, contoh: *Jual 150rb*.`;
                await safeReply(msg, hint);
              } else {
                const txHandled = await handleTransaction(
                  msg,
                  sender,
                  user,
                  effectiveStatus,
                  result.text,
                  result.text.toLowerCase(),
                  client,
                );
                if (!txHandled) {
                  const preview = result.text.substring(0, 100).replace(/\n/g, ' ');
                  await safeReply(
                    msg,
                    `📋 *Teks berhasil dibaca:*\n${preview}\n\nTapi saya belum bisa otomatis mencatat transaksinya Bos.\nCoba ketik manual: *Jual 150rb* atau *Beli bahan 75rb*`,
                  );
                }
              }
              result = null;
            }
          } catch (err: any) {
            addLog('error', `[MEDIA] Unhandled error: ${err.message} ${err.stack}`);
            await safeReply(
              msg,
              `⚠️ Ada gangguan saat memproses ${isAudio ? 'voice note' : 'foto'} Bos.\nCoba kirim ulang, atau ketik pesannya langsung.`,
            );
          }
          return;
        }
        if (!rawBody) {
          await safeReply(
            msg,
            `📎 *File tidak didukung*\n\nSaya hanya bisa memproses:\n🎙️ Voice note (pesan suara)\n📸 Foto struk/nota\n\nAtau ketik pesan teks langsung, contoh: *jual nasi goreng 25rb*`,
          );
          return;
        }
      }

      if (user?.is_upgrading && msg.hasMedia) {
        handleTransferProof(msg, client, sender, user);
        return;
      }

      if (user?.is_upgrading && !msg.hasMedia) {
        const isGlobalCmd =
          KW_STATUS.some((k: string) => body === k) ||
          fuzzyMatchKeywords(body, KW_STATUS) ||
          KW_LAPORAN.some((k: string) => body === k || body.startsWith(k)) ||
          fuzzyMatchKeywords(body, KW_LAPORAN) ||
          KW_BANTUAN.some((k: string) => body === k) ||
          fuzzyMatchKeywords(body, KW_BANTUAN);
        if (!isGlobalCmd) {
          if (KW_BATAL.some((k: string) => body === k || body.includes(k))) {
            (await supabase
              .from('users')
              .update({ is_upgrading: false, upgrade_package: null })
              .eq('id', sender)) as any;
            await safeReply(msg, `✅ Proses upgrade dibatalkan.\n\nKetik *Paket* kapan saja untuk memulai lagi.`);
            return;
          }
          const pkgKey = user?.upgrade_package && PACKAGES[user.upgrade_package] ? user.upgrade_package : null;
          if (!pkgKey) {
            (await supabase
              .from('users')
              .update({ is_upgrading: false, upgrade_package: null })
              .eq('id', sender)) as any;
            await safeReply(msg, `⚠️ Sesi upgrade tidak ditemukan Bos.\n\nKetik *Paket* untuk memilih paket lagi.`);
            return;
          }
          const pkg = PACKAGES[pkgKey];
          await safeReply(
            msg,
            `📸 *Bos, kirim foto bukti transfer dulu ya!*\n\nPaket dipilih : *${pkg.label}*\nNominal       : *${pkg.priceStr}*\n\nTransfer ke:\n💳 *${PAYMENT.bank} — ${PAYMENT.account}*\n   a/n ${PAYMENT.name}\n\nAtau ketik *Batal* untuk membatalkan.`,
          );
          return;
        }
      }

      function escapeRegex(s: string): string {
        return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      }
      function shouldBypassDialogs(bodyText: string): boolean {
        if (/\b(?:tagih|kirim\s+tagihan|minta\s+bayar|buat\s+(?:invoice|tagihan|bon)|invoice|nagih)\b/i.test(bodyText))
          return true;
        if (/\b(?:setbank|atur\s+rekening|setting\s+bank|set\s+bank)\b/i.test(bodyText)) return true;
        if (
          KW_DASHBOARD.some((k: string) => new RegExp('\\b' + escapeRegex(k) + '\\b', 'i').test(bodyText)) ||
          fuzzyMatchKeywords(bodyText, KW_DASHBOARD)
        )
          return true;
        if (
          KW_STATUS.some((k: string) => new RegExp('\\b' + escapeRegex(k) + '\\b', 'i').test(bodyText)) ||
          fuzzyMatchKeywords(bodyText, KW_STATUS)
        )
          return true;
        if (
          KW_LAPORAN.some((k: string) => new RegExp('\\b' + escapeRegex(k) + '\\b', 'i').test(bodyText)) ||
          fuzzyMatchKeywords(bodyText, KW_LAPORAN)
        )
          return true;
        if (
          KW_BANTUAN.some((k: string) => new RegExp('\\b' + escapeRegex(k) + '\\b', 'i').test(bodyText)) ||
          fuzzyMatchKeywords(bodyText, KW_BANTUAN)
        )
          return true;
        if (
          KW_UPGRADE.some((k: string) => new RegExp('\\b' + escapeRegex(k) + '\\b', 'i').test(bodyText)) ||
          fuzzyMatchKeywords(bodyText, KW_UPGRADE)
        )
          return true;
        if (/\b(?:paket)\b/i.test(bodyText)) return true;
        return false;
      }

      const expiredTypes = getExpiredDialogTypes(sender);
      if (expiredTypes.length > 0) {
        await safeReply(msg, '⏰ Waktu konfirmasi habis. Silakan ulangi dari awal.');
        return;
      }

      if (hasDialog(sender) && !shouldBypassDialogs(body)) {
        if (KW_BATAL.some((k: string) => body === k)) {
          clearAllDialogs(sender);
          await safeReply(msg, '✅ Semua proses dibatalkan.');
          return;
        }

        const active = sortedDialogs(sender);
        if (active.length === 0) return;
        const d = active[0];

        if (d.type === 'tx_confirmation') {
          const txConf = d.data;
          const isYes = ['ya', 'ya sudah', 'iya', 'oke', 'ok', 'yes', 'y', '1', 'catat', 'simpan'].includes(body);
          if (isYes) {
            removeDialog(sender, 'tx_confirmation');
            if (txConf.effectiveStatus === 'demo') {
              const todayCount = await getDailyTransactionCount(sender);
              if (todayCount >= 5) {
                await safeReply(
                  msg,
                  `⚠️ *Limit Harian Demo Habis!*\n\nSudah *${todayCount} transaksi* hari ini.\nLimit reset otomatis besok pukul 00:00.\n\n💡 Ketik *Paket* untuk upgrade tanpa batas.`,
                );
                return;
              }
            }
            const trxResult = await transactionRecorder.recordTransactionWithJournal(
              sender,
              txConf.type,
              txConf.amount,
              txConf.description,
              txConf.product.id,
              txConf.effectiveStatus === 'demo',
            );
            if (!trxResult.success) throw new Error(`Gagal simpan transaksi: ${trxResult.error}`);
            const emoji = txConf.type === 'masuk' ? '✅' : '💸';
            const tipeLabel = txConf.type === 'masuk' ? '📥 MASUK' : '📤 KELUAR';
            let extraInfo = '';
            if (txConf.effectiveStatus === 'demo') {
              const todayCount = await getDailyTransactionCount(sender);
              const sisa = 5 - todayCount;
              extraInfo = `\n\n⏳ Sisa kuota hari ini: *${sisa} transaksi*`;
            }
            await safeReply(
              msg,
              `${emoji} *Berhasil Dicatat!*\n\n${tipeLabel}\n💵 Jumlah : ${formatRupiah(txConf.amount)}\n📦 Produk : ${txConf.product!.name}\n📝 Ket    : ${txConf.description}${extraInfo}`,
            );
            return;
          }
          await safeReply(msg, '⚠️ Balas *Ya* untuk mencatat atau *Batal* untuk membatalkan.');
          return;
        }

        if (d.type === 'pay_hutang') {
          const h = d.data;
          const isYes = ['ya', 'iya', 'oke', 'ok', 'yes', 'y', '1'].includes(body);
          if (isYes) {
            removeDialog(sender, 'pay_hutang');
            const result = await transactionRecorder.recordPayPayable({
              userId: sender,
              payableId: h.payableId,
              amount: h.amount,
            });
            if (!result.success) throw new Error(`Gagal bayar hutang: ${result.error}`);
            const dt = result.data as any;
            await safeReply(
              msg,
              `✅ *Pembayaran Hutang Berhasil!*\n\n🏢 Supplier : ${h.supplier}\n💵 Dibayar : ${formatRupiah(h.amount)}${dt.lunas ? '\n✅ *LUNAS!*' : `\n⚠️ Sisa : ${formatRupiah(dt.sisaBaru)}`}`,
            );
            return;
          }
          await safeReply(msg, '⚠️ Balas *Ya* untuk membayar atau *Batal* untuk membatalkan.');
          return;
        }

        if (d.type === 'receive_piutang') {
          const p = d.data;
          const isYes = ['ya', 'iya', 'oke', 'ok', 'yes', 'y', '1'].includes(body);
          if (isYes) {
            removeDialog(sender, 'receive_piutang');
            const result = await transactionRecorder.recordReceiveReceivable({
              userId: sender,
              debtId: p.debtId,
              amount: p.amount,
            });
            if (!result.success) throw new Error(`Gagal terima piutang: ${result.error}`);
            const dt = result.data as any;
            await safeReply(
              msg,
              `✅ *Penerimaan Piutang Berhasil!*\n\n👤 Customer : ${p.customer}\n💵 Diterima : ${formatRupiah(p.amount)}${dt.lunas ? '\n✅ *LUNAS!*' : `\n⚠️ Sisa : ${formatRupiah(dt.sisaBaru)}`}`,
            );
            return;
          }
          await safeReply(msg, '⚠️ Balas *Ya* untuk menerima atau *Batal* untuk membatalkan.');
          return;
        }

        if (d.type === 'retur_jual') {
          const rj = d.data;
          const isYes = ['ya', 'iya', 'oke', 'ok', 'yes', 'y', '1'].includes(body);
          if (isYes) {
            removeDialog(sender, 'retur_jual');
            const result = await transactionRecorder.recordSalesReturn({
              userId: sender,
              originalTransactionId: rj.originalTransactionId,
              productId: rj.productId,
              quantity: rj.quantity,
              priceSell: rj.priceSell,
              priceBuy: rj.priceBuy,
              returnReason: rj.returnReason,
              statusBayar: rj.statusBayar,
              channel: rj.channel,
              customerName: rj.customerName,
            });
            if (!result.success) throw new Error(`Gagal retur penjualan: ${result.error}`);
            await safeReply(
              msg,
              `✅ *Retur Penjualan Berhasil!*\n\n📦 Produk : ${rj.productName} x ${rj.quantity}\n💵 Nilai : ${formatRupiah(rj.quantity * rj.priceSell)}\n📝 Alasan : ${rj.returnReason}`,
            );
            return;
          }
          await safeReply(msg, '⚠️ Balas *Ya* untuk memproses retur atau *Batal* untuk membatalkan.');
          return;
        }

        if (d.type === 'retur_beli') {
          const rb = d.data;
          const isYes = ['ya', 'iya', 'oke', 'ok', 'yes', 'y', '1'].includes(body);
          if (isYes) {
            removeDialog(sender, 'retur_beli');
            const result = await transactionRecorder.recordPurchaseReturn({
              userId: sender,
              originalTransactionId: rb.originalTransactionId,
              productId: rb.productId,
              quantity: rb.quantity,
              priceBuy: rb.priceBuy,
              returnReason: rb.returnReason,
              statusBayar: rb.statusBayar,
              supplierName: rb.supplierName,
            });
            if (!result.success) throw new Error(`Gagal retur pembelian: ${result.error}`);
            await safeReply(
              msg,
              `✅ *Retur Pembelian Berhasil!*\n\n📦 Produk : ${rb.productName} x ${rb.quantity}\n💵 Nilai : ${formatRupiah(rb.quantity * rb.priceBuy)}\n📝 Alasan : ${rb.returnReason}`,
            );
            return;
          }
          await safeReply(msg, '⚠️ Balas *Ya* untuk memproses retur atau *Batal* untuk membatalkan.');
          return;
        }

        if (d.type === 'undo_confirmation') {
          const ud = d.data;
          const isYes = ['ya', 'iya', 'oke', 'ok', 'yes', 'y', '1'].includes(body);
          if (isYes) {
            removeDialog(sender, 'undo_confirmation');
            const result = await transactionRecorder.reverseTransaction(sender, ud.transactionId);
            if (!result.success) throw new Error(`Gagal undo: ${result.error}`);
            const dt = result.data as any;
            await safeReply(
              msg,
              `✅ *Transaksi Berhasil Dibatalkan!*\n\n📄 ${dt.description || 'Transaksi dibatalkan'}\n💵 ${formatRupiah(ud.amount)}\n📦 ${ud.productName}\n\nStok dikembalikan.`,
            );
            return;
          }
          await safeReply(msg, '⚠️ Balas *Ya* untuk membatalkan transaksi atau *Batal* untuk membatalkan.');
          return;
        }

        if (d.type === 'keluar_channel') {
          const kc = d.data;
          const idx = parseInt(body) - 1;
          const cancelWords = ['batal', 'cancel', '0', 'gak', 'nggak', 'tidak'];
          if (cancelWords.includes(body)) {
            removeDialog(sender, 'keluar_channel');
            await safeReply(msg, '❌ *Dibatalkan*');
            return;
          }
          const nameMatch = kc.channels.find((c: string) => body.toLowerCase().includes(c.toLowerCase()));
          let selectedChannel: string | null = null;
          if (!isNaN(idx) && idx >= 0 && idx < kc.channels.length) {
            selectedChannel = kc.channels[idx];
          } else if (nameMatch) {
            selectedChannel = nameMatch;
          }
          if (selectedChannel) {
            removeDialog(sender, 'keluar_channel');
            const product = { id: kc.productId, name: kc.productName };
            const result = await executeStockAdjustment(msg, { id: sender }, product, kc.qty, 'out', selectedChannel);
            return;
          }
          await safeReply(
            msg,
            `⚠️ Pilihan tidak valid. Balas *angka 1-${kc.channels.length}* untuk memilih channel, atau *Batal* untuk membatalkan.`,
          );
          return;
        }

        if (d.type === 'product_selection') {
          const sel = d.data;
          const choiceIdx = parseInt(body) - 1;
          if (!isNaN(choiceIdx) && choiceIdx >= 0 && choiceIdx < sel.products.length) {
            const selectedProduct = sel.products[choiceIdx];
            removeDialog(sender, 'product_selection');
            if (sel.effectiveStatus === 'demo') {
              const todayCount = await getDailyTransactionCount(sender);
              if (todayCount >= 5) {
                await safeReply(
                  msg,
                  `⚠️ *Limit Harian Demo Habis!*\n\nSudah *${todayCount} transaksi* hari ini.\nLimit reset otomatis besok pukul 00:00.\n\n💡 Ketik *Paket* untuk upgrade tanpa batas.`,
                );
                return;
              }
            }
            const trxResult = await transactionRecorder.recordTransactionWithJournal(
              sender,
              sel.type,
              sel.amount,
              sel.description,
              selectedProduct.id,
              sel.effectiveStatus === 'demo',
            );
            if (!trxResult.success) throw new Error(`Gagal simpan transaksi: ${trxResult.error}`);
            const emoji = sel.type === 'masuk' ? '✅' : '💸';
            const tipeLabel = sel.type === 'masuk' ? '📥 MASUK' : '📤 KELUAR';
            let extraInfo = '';
            if (sel.effectiveStatus === 'demo') {
              const todayCount = await getDailyTransactionCount(sender);
              const sisa = 5 - todayCount;
              extraInfo = `\n\n⏳ Sisa kuota hari ini: *${sisa} transaksi*`;
            }
            await safeReply(
              msg,
              `${emoji} *Berhasil Dicatat!*\n\n${tipeLabel}\n💵 Jumlah : ${formatRupiah(sel.amount)}\n📦 Produk : ${selectedProduct.name}\n📝 Ket    : ${sel.description}${extraInfo}`,
            );
            return;
          }
          const nameMatch = sel.products.find((p: any) => body.toLowerCase().includes(p.name.toLowerCase()));
          if (nameMatch) {
            removeDialog(sender, 'product_selection');
            if (sel.effectiveStatus === 'demo') {
              const todayCount = await getDailyTransactionCount(sender);
              if (todayCount >= 5) {
                await safeReply(msg, `⚠️ *Limit Harian Demo Habis!*\n\nSudah *${todayCount} transaksi* hari ini.`);
                return;
              }
            }
            const trxResult = await transactionRecorder.recordTransactionWithJournal(
              sender,
              sel.type,
              sel.amount,
              sel.description,
              nameMatch.id,
              sel.effectiveStatus === 'demo',
            );
            if (!trxResult.success) throw new Error(`Gagal simpan transaksi: ${trxResult.error}`);
            const emoji = sel.type === 'masuk' ? '✅' : '💸';
            const tipeLabel = sel.type === 'masuk' ? '📥 MASUK' : '📤 KELUAR';
            await safeReply(
              msg,
              `${emoji} *Berhasil Dicatat!*\n\n${tipeLabel}\n💵 Jumlah : ${formatRupiah(sel.amount)}\n📦 Produk : ${nameMatch.name}\n📝 Ket    : ${sel.description}`,
            );
            return;
          }
          await safeReply(
            msg,
            `\u26a0\ufe0f Pilihan tidak valid. Balas *angka 1-${sel.products.length}* untuk memilih produk, atau *Batal* untuk membatalkan.`,
          );
          return;
        }

        if (d.type === 'classification') {
          const cDialog = d.data;
          let confirmedType: string | null = null;
          if (body === 'masuk' || body === 'pemasukan' || body === '1') confirmedType = 'masuk';
          else if (body === 'keluar' || body === 'pengeluaran' || body === '2') confirmedType = 'keluar';

          if (confirmedType) {
            await saveBehavior(sender, cDialog.ambiguousWord, confirmedType, 'user_confirm');
            removeDialog(sender, 'classification');

            if (effectiveStatus === 'demo') {
              const todayCount = await getDailyTransactionCount(sender);
              if (todayCount >= 5) {
                await safeReply(
                  msg,
                  `\u26a0\ufe0f *Limit Harian Demo Habis!*\n\nSudah *${todayCount} transaksi* hari ini.\nLimit reset otomatis besok pukul 00:00.\n\n\ud83d\udca1 Ketik *Paket* untuk upgrade tanpa batas.`,
                );
                return;
              }
            }

            const finalDesc =
              cDialog.descWords
                .filter((w: string) => {
                  const wl = w.toLowerCase();
                  return !KW_KELUAR.includes(wl) && !KW_MASUK.includes(wl) && parseCurrency(w) === null;
                })
                .join(' ')
                .trim() || cDialog.ambiguousWord;

            const matchedProductCD = await findProductInMessage(sender, cDialog.body || cDialog.rawBody || '');
            if (matchedProductCD) {
              const trxResult = await transactionRecorder.recordTransactionWithJournal(
                sender,
                confirmedType,
                cDialog.amount,
                finalDesc,
                String(matchedProductCD.id),
                effectiveStatus === 'demo',
              );
              if (!trxResult.success) throw new Error(`Gagal simpan transaksi: ${trxResult.error}`);

              const emoji = confirmedType === 'masuk' ? '✅' : '\ud83d\udcb8';
              const tipeLabel = confirmedType === 'masuk' ? '\ud83d\udce5 MASUK' : '\ud83d\udce4 KELUAR';
              let extraInfo = `\n\n\ud83e\udde0 _Saya akan mengingat "${cDialog.ambiguousWord}" sebagai ${confirmedType} untuk selanjutnya._`;
              if (effectiveStatus === 'demo') {
                const todayCount = await getDailyTransactionCount(sender);
                const sisa = 5 - todayCount;
                extraInfo += `\n\u23f3 Sisa kuota hari ini: *${sisa} transaksi*`;
              }
              await safeReply(
                msg,
                `${emoji} *Berhasil Dicatat!*\n\n${tipeLabel}\n\ud83d\udcb5 Jumlah : ${formatRupiah(cDialog.amount)}\n\ud83d\udce6 Produk : ${matchedProductCD.name}\n\ud83d\udcdd Ket    : ${finalDesc}${extraInfo}`,
              );
              return;
            }

            let productListCD: any[] = [];
            try {
              const { data: allProds } = (await supabase
                .from('products')
                .select('id, name')
                .eq('user_id', sender)
                .eq('is_active', true)
                .order('name', { ascending: true })) as any;
              productListCD = allProds || [];
            } catch (_: any) {
              addLog('error', '[MSG] productListCD fetch failed: ' + _.message);
            }

            if (productListCD.length === 0) {
              const dashUrl = getDashboardUrl();
              const slug = user.store_slug || 'dashboard';
              await safeReply(
                msg,
                `\u274c *Transaksi Ditolak*\n\nBelum ada produk terdaftar di inventori.\n\n\ud83d\udccb Daftarkan produk di Dashboard:\n   ${dashUrl}/stock/${slug}\n\n\ud83d\udca1 _Semua transaksi wajib merujuk produk yang terdaftar._`,
              );
              return;
            }

            const tipeEmojiCD = confirmedType === 'masuk' ? '\ud83d\udce5' : '\ud83d\udce4';
            const tipeLabelCD = confirmedType === 'masuk' ? 'MASUK' : 'KELUAR';
            let listTextCD = productListCD
              .slice(0, 15)
              .map((p: any, i: number) => `   ${i + 1}. ${p.name}`)
              .join('\n');
            if (productListCD.length > 15) listTextCD += `\n   _...dan ${productListCD.length - 15} produk lainnya_`;

            setDialog(sender, 'product_selection', {
              type: confirmedType,
              amount: cDialog.amount,
              description: finalDesc,
              products: productListCD.slice(0, 15),
              effectiveStatus,
            });
            await safeReply(
              msg,
              `\ud83e\udd14 *Produk mana yang dimaksud?*\n\n${tipeEmojiCD} ${tipeLabelCD} \u2014 ${formatRupiah(cDialog.amount)}\n\nPilih produk:\n${listTextCD}\n\nBalas *angka* untuk memilih produk.\nBalas *Batal* untuk membatalkan.`,
            );
            return;
          }
          await safeReply(msg, '\u26a0\ufe0f Jawaban tidak valid. Balas *Masuk* atau *Keluar* untuk mengonfirmasi.');
          return;
        }
      }

      if (KW_DASHBOARD.some((k: string) => body === k || body.includes(k)) || fuzzyMatchKeywords(body, KW_DASHBOARD))
        return handleDashboardRequest(msg, sender, user);
      if (body === 'token baru' || body === 'reset token' || body === 'link baru')
        return handleNewToken(msg, sender, user);

      // Stock list / daftar produk
      if (
        /^(?:stock|stok|daftar)\s+(?:list|produk|barang|stok)/i.test(body) ||
        /^(?:list|daftar)\s+(?:produk|barang|stok|stock)/i.test(body)
      ) {
        await handleStockList(msg, user);
        return;
      }

      // Stock info [SKU] / info stok [SKU]
      if (
        /^(?:stock|stok|info)\s+(?:info|detail)\s+/i.test(body) ||
        /^info\s+(?:stok|stock|produk|barang)\s+/i.test(body)
      ) {
        await handleStockInfo(msg, user, rawBody);
        return;
      }

      // Stock report / laporan stok
      if (
        /^(?:stock|laporan|report)\s+(?:stok|stock|report)\s*$/i.test(body) ||
        body === 'laporan stok' ||
        body === 'stock report'
      ) {
        if (!['pro', 'unlimited'].includes(effectiveStatus)) {
          await safeReply(
            msg,
            `🔒 *Laporan Stok*\n\nTersedia untuk paket *PRO* & *UNLIMITED*.\n\nKetik *Paket* untuk upgrade.`,
          );
          return;
        }
        await handleStockReport(msg, user);
        return;
      }

      if (
        KW_STOCK.some((k: string) => body.includes(k)) ||
        KW_DASHBOARD.some((k: string) => body === k || body.includes(k)) ||
        fuzzyMatchKeywords(body, KW_DASHBOARD)
      ) {
        if (['pro', 'unlimited'].includes(effectiveStatus)) {
          const parts = body.split(/\s+/);
          if (parts.length >= 2) {
            const possibleSku = parts.find((w: string) => /^[A-Z0-9\-]{3,}/i.test(w));
            if (possibleSku) {
              const prodResult = (await stockManager.getProduct(sender, possibleSku)) as any;
              if (prodResult.success) {
                const p: any = prodResult.product;
                const stock = parseFloat(p.stock_current);
                const min = parseFloat(p.stock_min);
                let statusIcon = stock <= 0 ? '🔴' : stock <= min ? '⚠️' : '🟢';
                await safeReply(
                  msg,
                  `${statusIcon} *${p.name}*\n\n` +
                    `SKU  : ${p.sku}\n` +
                    `Stok : *${stockManager.formatQty(stock, p.unit)} ${p.unit}*\n` +
                    `Min  : ${stockManager.formatQty(min, p.unit)} ${p.unit}\n\n` +
                    `Untuk kelola stok lengkap, buka dashboard:\n` +
                    `Ketik *Dashboard* untuk dapat link.`,
                );
                return;
              }
            }
          }
          return handleDashboardRequest(msg, sender, user);
        } else {
          await safeReply(
            msg,
            `🔒 *Fitur Stock Opname*\n\nTersedia untuk paket *PRO* & *UNLIMITED*.\n\nKetik *Paket* untuk upgrade.`,
          );
          return;
        }
      }

      if (KW_UPGRADE.some((k: string) => body === k) || body === 'paket' || fuzzyMatchKeywords(body, KW_UPGRADE)) {
        showUpgradeMenu(msg, user, effectiveStatus);
        return;
      }
      if (body.startsWith('pilih ')) {
        const handled = await handlePackageSelection(msg, sender, user, body);
        if (handled) return;
      }
      if (KW_BATAL.some((k: string) => body === k) || fuzzyMatchKeywords(body, KW_BATAL)) {
        await safeReply(msg, `Tidak ada proses yang sedang berjalan Bos. 😊\n\nKetik *Bantuan* untuk melihat menu.`);
        return;
      }

      // ── TIER 1 — Direct expense commands (gaji, listrik, sewa, dll) ──
      const ACCOUNT_LABELS: Record<string, string> = {
        '1101': 'Kas',
        '1102': 'Piutang Dagang',
        '1201': 'Inventori (Barang)',
        '2101': 'Hutang Dagang',
        '3101': 'Modal Pemilik',
        '3102': 'Prive (Pribadi)',
        '4101': 'Pendapatan Penjualan',
        '5101': 'Harga Pokok Penjualan (HPP)',
        '6101': 'Beban Gaji',
        '6102': 'Beban Sewa',
        '6103': 'Beban Listrik & Air',
        '6104': 'Beban Transport',
        '6105': 'Beban Operasional',
      };
      const BEBAN_REGEX_MAP: Record<string, RegExp> = {
        beban_gaji: /^(?:gaji|gajian|upah)\s+/i,
        beban_sewa: /^(?:sewa|kontrak|sewa tempat|sewa gedung|sewa ruko)\s+/i,
        beban_listrik_air: /^(?:listrik|air|pln|pdam|tagihan listrik|token listrik)\s+/i,
        beban_transport: /^(?:transport|bensin|ojek|ongkir|kirim|pengiriman|bbm)\s+/i,
        beban_operasional: /^(?:operasional|atk|kebersihan|logistik|perlengkapan)\s+/i,
        modal: /^(?:setor modal|modal|tambah modal|investasi|setor)\s+/i,
        prive: /^(?:prive|ambil|ambil uang|pribadi|tarik)\s+/i,
      };
      const bebanEntry = Object.entries(BEBAN_REGEX_MAP).find(([_, re]) => re.test(body));
      if (bebanEntry) {
        const [tipe] = bebanEntry;
        const bebanAmount = parseCurrency(rawBody);
        if (!bebanAmount || bebanAmount <= 0) {
          const map = transactionRecorder.PEMBUKUAN_COA_MAP[tipe];
          await safeReply(msg, `Berapa nominal ${map?.label || tipe}? Contoh: *${tipe.replace(/_/g, ' ')} 500.000*`);
          return;
        }
        if (!['pro', 'unlimited'].includes(effectiveStatus)) {
          await safeReply(
            msg,
            `🔒 Fitur Pembukuan tersedia untuk paket *PRO* & *UNLIMITED*.\n\nKetik *Paket* untuk upgrade.`,
          );
          return;
        }
        const bebanResult = await transactionRecorder.recordPembukuan({
          userId: sender,
          tipe,
          amount: bebanAmount,
          description: body,
        });
        if (bebanResult.success) {
          const map = transactionRecorder.PEMBUKUAN_COA_MAP[tipe];
          const debitLabel = (map && ACCOUNT_LABELS[map.debit]) || map?.debit || 'Kas';
          const creditLabel = (map && ACCOUNT_LABELS[map.credit]) || map?.credit || 'Kas';
          await safeReply(
            msg,
            `✅ *${map?.label || tipe} Dicatat*\n\n` +
              `💵 Nominal: ${formatRupiah(bebanAmount)}\n\n` +
              `📒 *Debit*:  ${debitLabel} — ${formatRupiah(bebanAmount)}\n` +
              `📒 *Kredit*: ${creditLabel} — ${formatRupiah(bebanAmount)}\n\n` +
              `Ketik *Laporan* untuk rekap harian.`,
          );
        } else {
          await safeReply(msg, `❌ Gagal: ${bebanResult.error}`);
        }
        return;
      }

      // ── "stok [produk]" — Cek stock produk by name ──
      const stokSearch = body.match(/^stok\s+(.+)/i);
      if (stokSearch) {
        const searchQuery = stokSearch[1].trim().toLowerCase();
        try {
          const { data: products } = (await supabase
            .from('products')
            .select('name, stock_current, stock_min, unit')
            .eq('user_id', sender)
            .ilike('name', `%${searchQuery}%`)
            .eq('is_active', true)
            .limit(5)) as any;
          if (!products || products.length === 0) {
            await safeReply(
              msg,
              `❌ Produk "${searchQuery}" tidak ditemukan.\n\nKetik *Stock list* untuk lihat semua produk.`,
            );
            return;
          }
          let stokText = `📦 *Stok — ${searchQuery}*\n${'─'.repeat(20)}\n`;
          products.forEach((p: any) => {
            const icon = p.stock_current <= 0 ? '🔴' : p.stock_min && p.stock_current <= p.stock_min ? '🟡' : '🟢';
            stokText += `\n${icon} *${p.name}*: ${p.stock_current} ${p.unit || ''}`;
            if (p.stock_min) stokText += ` (min ${p.stock_min})`;
          });
          await safeReply(msg, stokText);
        } catch (e: any) {
          addLog('error', `[STOK] Error: ${e.message}`);
          await safeReply(msg, `❌ Gagal cek stok. Coba lagi nanti.`);
        }
        return;
      }

      // ── "stok habis" / "stok kritis" ──
      if (body === 'stok habis' || body === 'stok kritis' || body === 'stock habis') {
        try {
          const { data: allProducts } = (await supabase
            .from('products')
            .select('name, stock_current, stock_min, unit')
            .eq('user_id', sender)
            .eq('is_active', true)
            .order('stock_current', { ascending: true })
            .limit(20)) as any;
          const kritis = (allProducts || []).filter((p: any) => !p.stock_min || p.stock_current <= p.stock_min);
          if (kritis.length === 0) {
            await safeReply(msg, `✅ Stok aman. Semua produk tersedia cukup.`);
            return;
          }
          let kritisText = `⚠️ *Stok Kritis*\n${'─'.repeat(20)}\n`;
          kritis.forEach((p: any) => {
            const icon = p.stock_current <= 0 ? '🔴' : '🟡';
            kritisText += `\n${icon} *${p.name}*: ${p.stock_current} ${p.unit || ''}${p.stock_min ? ` (min ${p.stock_min})` : ''}`;
          });
          await safeReply(msg, kritisText);
        } catch (e: any) {
          addLog('error', `[STOK-KRITIS] Error: ${e.message}`);
          await safeReply(msg, `❌ Gagal cek stok kritis.`);
        }
        return;
      }

      // ── "rekap" / "ringkasan" — 1 command lihat kondisi bisnis ──
      if (body === 'rekap' || body === 'ringkasan' || body === 'rekapan') {
        try {
          const { data: allTrans } = (await supabase
            .from('transactions')
            .select('type, amount')
            .eq('user_id', sender)) as any;
          let totalMasuk = 0,
            totalKeluar = 0;
          (allTrans || []).forEach((t: any) => {
            const v = Number(t.amount) || 0;
            if (t.type === 'masuk') totalMasuk += v;
            else totalKeluar += v;
          });
          const rekapSaldo = totalMasuk - totalKeluar;

          const { data: hutangData } = (await supabase
            .from('payables')
            .select('nominal_hutang, jumlah_dibayar')
            .eq('user_id', sender)
            .eq('status_lunas', false)) as any;
          const totalHutang = (hutangData || []).reduce(
            (s: number, h: any) => s + Number(h.nominal_hutang) - Number(h.jumlah_dibayar || 0),
            0,
          );

          const { data: prodData } = (await supabase
            .from('products')
            .select('stock_current, stock_min')
            .eq('user_id', sender)
            .eq('is_active', true)) as any;
          const kritisCount = (prodData || []).filter((p: any) => p.stock_min && p.stock_current <= p.stock_min).length;
          const habisCount = (prodData || []).filter((p: any) => p.stock_current <= 0).length;

          const todayStart = new Date();
          todayStart.setHours(0, 0, 0, 0);
          const { data: todayTrx } = (await supabase
            .from('transactions')
            .select('amount')
            .eq('user_id', sender)
            .gte('created_at', todayStart.toISOString())) as any;
          const omzetHariIni = (todayTrx || []).reduce((s: number, t: any) => s + (Number(t.amount) || 0), 0);

          let rekapText =
            `📊 *REKAP BISNIS — ${user.store_name}*\n` +
            `${'─'.repeat(24)}\n\n` +
            `💰 *Saldo Kas:* ${formatRupiah(rekapSaldo)}\n` +
            `📈 *Omzet Hari Ini:* ${formatRupiah(omzetHariIni)}\n` +
            `💳 *Total Hutang:* ${formatRupiah(totalHutang)}\n` +
            `📦 Stok Kritis: ${kritisCount} produk 🟡\n` +
            `🔴 Stok Habis: ${habisCount} produk\n\n` +
            `${'─'.repeat(24)}\n\n` +
            `Ketik *Laporan* untuk detail transaksi hari ini.`;
          await safeReply(msg, rekapText);
        } catch (e: any) {
          addLog('error', `[REKAP] Error: ${e.message}`);
          await safeReply(msg, `❌ Gagal memuat rekap. Coba lagi nanti.`);
        }
        return;
      }

      if (
        body === 'saldo' ||
        body === 'cek saldo' ||
        body === 'berea saldo' ||
        body === 'saldo berapa' ||
        body === 'kas' ||
        body === 'cek kas'
      ) {
        try {
          const { data: trans } = (await supabase
            .from('transactions')
            .select('type, amount')
            .eq('user_id', sender)) as any;
          let totalMasuk = 0,
            totalKeluar = 0;
          (trans || []).forEach((t: any) => {
            const v = Number(t.amount) || 0;
            if (t.type === 'masuk') totalMasuk += v;
            else totalKeluar += v;
          });
          const saldo = totalMasuk - totalKeluar;
          await safeReply(
            msg,
            `💰 *Saldo Kas — ${user.store_name}*\n` +
              `${'─'.repeat(24)}\n\n` +
              `🟢 Pemasukan: ${formatRupiah(totalMasuk)}\n` +
              `🔴 Pengeluaran: ${formatRupiah(totalKeluar)}\n\n` +
              `${'─'.repeat(24)}\n` +
              `${saldo >= 0 ? `✅ *Saldo: ${formatRupiah(saldo)}*` : `🔴 *Defisit: -${formatRupiah(Math.abs(saldo))}*`}\n\n` +
              `Ketik *Laporan* untuk detail harian.`,
          );
        } catch (e: any) {
          addLog('error', `[SALDO] Error: ${e.message}`);
          await safeReply(msg, `❌ Gagal cek saldo. Coba lagi nanti Bos.`);
        }
        return;
      }

      if (body === 'hutang' || body === 'cek hutang' || body === 'hutang supplier' || body === 'utang') {
        try {
          if (!['pro', 'unlimited'].includes(effectiveStatus)) {
            await safeReply(
              msg,
              `🔒 *Fitur Hutang*\n\nTersedia untuk paket *PRO* & *UNLIMITED*.\n\nKetik *Paket* untuk upgrade.`,
            );
            return;
          }
          const { data: list } = (await supabase
            .from('payables')
            .select('*')
            .eq('user_id', sender)
            .eq('status_lunas', false)
            .order('jatuh_tempo', { ascending: true })) as any;
          if (!list || list.length === 0) {
            await safeReply(msg, `✅ *Hutang — ${user.store_name}*\n\nTidak ada hutang ke supplier saat ini.`);
            return;
          }
          const now = new Date();
          const total = list.reduce(
            (s: number, h: any) => s + Number(h.nominal_hutang) - Number(h.jumlah_dibayar || 0),
            0,
          );
          let text = `💳 *Hutang ke Supplier — ${user.store_name}*\n` + `${'─'.repeat(24)}\n`;
          list.slice(0, 10).forEach((h: any) => {
            const sisa = Number(h.nominal_hutang) - Number(h.jumlah_dibayar || 0);
            const overdue = h.jatuh_tempo && new Date(h.jatuh_tempo) < now ? ' ⏰' : '';
            text += `\n• *${h.nama_supplier}*${overdue}\n  Sisa: ${formatRupiah(Math.max(0, sisa))}`;
            if (h.jatuh_tempo) text += `\n  Jatuh tempo: ${new Date(h.jatuh_tempo).toLocaleDateString('id-ID')}`;
          });
          if (list.length > 10) text += `\n\n...dan ${list.length - 10} hutang lainnya`;
          text += `\n\n${'─'.repeat(24)}\nTotal: *${formatRupiah(Math.max(0, total))}*\n\nKetik *Dashboard* untuk kelola hutang via web.`;
          await safeReply(msg, text);
        } catch (e: any) {
          addLog('error', `[HUTANG] Error: ${e.message}`);
          await safeReply(msg, `❌ Gagal cek hutang. Coba lagi nanti Bos.`);
        }
        return;
      }

      // ── Cek Piutang ──
      if (body === 'piutang' || body === 'cek piutang') {
        try {
          if (!['pro', 'unlimited'].includes(effectiveStatus)) {
            await safeReply(
              msg,
              `🔒 *Fitur Piutang*\n\nTersedia untuk paket *PRO* & *UNLIMITED*.\n\nKetik *Paket* untuk upgrade.`,
            );
            return;
          }
          const { data: list } = (await supabase
            .from('receivables')
            .select('*')
            .eq('user_id', sender)
            .eq('status_lunas', false)
            .order('jatuh_tempo', { ascending: true })) as any;
          if (!list || list.length === 0) {
            await safeReply(msg, `✅ *Piutang — ${user.store_name}*\n\nTidak ada piutang dari pelanggan saat ini.`);
            return;
          }
          const now = new Date();
          const total = list.reduce((s: number, r: any) => s + Number(r.nominal_piutang), 0);
          let text = `💳 *Piutang dari Pelanggan — ${user.store_name}*\n` + `${'─'.repeat(24)}\n`;
          list.slice(0, 10).forEach((r: any) => {
            const overdue = r.jatuh_tempo && new Date(r.jatuh_tempo) < now ? ' ⏰' : '';
            text += `\n• *${r.nama_pelanggan}*${overdue}\n  Piutang: ${formatRupiah(Number(r.nominal_piutang))}`;
            if (r.jatuh_tempo) text += `\n  Jatuh tempo: ${new Date(r.jatuh_tempo).toLocaleDateString('id-ID')}`;
          });
          if (list.length > 10) text += `\n\n...dan ${list.length - 10} piutang lainnya`;
          text += `\n\n${'─'.repeat(24)}\nTotal: *${formatRupiah(Math.max(0, total))}*\n\nKetik *Dashboard* untuk kelola piutang via web.`;
          await safeReply(msg, text);
        } catch (e: any) {
          addLog('error', `[PIUTANG] Error: ${e.message}`);
          await safeReply(msg, `❌ Gagal cek piutang. Coba lagi nanti Bos.`);
        }
        return;
      }

      // ── Laporan Laba Rugi ──
      if (body === 'laba rugi' || body === 'laba' || body === 'profit loss' || body === 'laba bersih') {
        try {
          const todayStart = new Date();
          todayStart.setHours(0, 0, 0, 0);
          const { data: trans } = (await supabase
            .from('transactions')
            .select('type, amount, quantity, price_buy, reference_type')
            .eq('user_id', sender)
            .gte('created_at', todayStart.toISOString())) as any;
          if (!trans || trans.length === 0) {
            await safeReply(msg, `📊 *Laba Rugi Hari Ini — ${user.store_name}*\n\nBelum ada transaksi hari ini.`);
            return;
          }
          let omzet = 0,
            hpp = 0,
            beban = 0;
          trans.forEach((t: any) => {
            const v = Number(t.amount) || 0;
            if (t.type === 'masuk' && t.reference_type !== 'modal') omzet += v;
            else if (t.type === 'keluar') beban += v;
            if ((t.reference_type === 'stock_out' || t.reference_type === 'cashier') && t.quantity && t.price_buy) {
              hpp += Number(t.quantity) * Number(t.price_buy);
            }
          });
          const laba = omzet - hpp - beban;
          await safeReply(
            msg,
            `📊 *Laba Rugi Hari Ini — ${user.store_name}*\n` +
              `${'─'.repeat(24)}\n\n` +
              `📈 Omzet:\t${formatRupiah(omzet)}\n` +
              `📉 HPP:\t${formatRupiah(hpp)}\n` +
              `📤 Beban:\t${formatRupiah(beban)}\n\n` +
              `${'─'.repeat(24)}\n` +
              `${laba >= 0 ? `✅ *Laba Bersih: ${formatRupiah(laba)}*` : `🔴 *Rugi: -${formatRupiah(Math.abs(laba))}*`}\n\n` +
              `Ketik *Laporan* untuk detail transaksi.`,
          );
        } catch (e: any) {
          addLog('error', `[LABARUGI] Error: ${e.message}`);
          await safeReply(msg, `❌ Gagal memuat laba rugi. Coba lagi nanti.`);
        }
        return;
      }

      if (KW_STATUS.some((k: string) => body === k) || fuzzyMatchKeywords(body, KW_STATUS)) {
        let statusBlock = '';
        if (effectiveStatus === 'demo') {
          const todayCount = await getDailyTransactionCount(sender);
          statusBlock = `🎯 *Status:* 🆓 FREE DEMO\n📊 *Kuota:* ${todayCount}/5 transaksi hari ini\n\n💡 _Ketik *Paket* untuk upgrade ke fitur penuh._`;
        } else if (effectiveStatus === 'pro') {
          const sisa = getDaysRemaining(user);
          statusBlock = `🎯 *Status:* ⭐ PRO BULANAN\n📅 *Masa Aktif:* Sisa ${sisa} hari lagi`;
        } else {
          statusBlock = `🎯 *Status:* 💎 UNLIMITED SELAMANYA`;
        }
        const statusMessage =
          `ℹ️ *INFO AKUN — ${user.store_name.toUpperCase()}*\n` +
          `${'─'.repeat(24)}\n\n` +
          `🏪 *Toko:* ${user.store_name}\n` +
          `📱 *WhatsApp:* ${formatPhone(sender)}\n\n` +
          `${statusBlock}\n\n` +
          `${'─'.repeat(24)}\n` +
          `_Gunakan bot ini untuk mempermudah pencatatan bisnis Anda. Semangat, Bos!_`;
        await safeReply(msg, statusMessage);
        return;
      }

      if (KW_LAPORAN.some((k: string) => body === k || body.startsWith(k)) || fuzzyMatchKeywords(body, KW_LAPORAN)) {
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);
        const sent = await sendReport(client, sender, user.store_name, 'Harian (Manual)', todayStart.toISOString());
        if (!sent) {
          await safeReply(
            msg,
            `📊 *LAPORAN — ${user.store_name.toUpperCase()}*\n` +
              `${'─'.repeat(24)}\n\n` +
              `Belum ada transaksi tercatat untuk hari ini, Bos.\n\n` +
              `💡 *Tips:*\n` +
              `Mulai catat transaksi dengan mengetik langsung:\n` +
              `Contoh: *Keluar Barang 10*`,
          );
          return;
        }
        return;
      }

      if (KW_BANTUAN.some((k: string) => body === k) || fuzzyMatchKeywords(body, KW_BANTUAN)) {
        let statusNote = '';
        if (effectiveStatus === 'demo') {
          const todayCount = await getDailyTransactionCount(sender);
          statusNote = `⚠️ _Mode DEMO: ${todayCount}/5 transaksi hari ini._`;
        } else if (effectiveStatus === 'pro') {
          const sisa = getDaysRemaining(user);
          statusNote = `⭐ _PRO aktif, sisa ${sisa} hari._`;
        } else {
          statusNote = `💎 _UNLIMITED aktif selamanya._`;
        }
        await safeReply(
          msg,
          `Halo! 👋 Ini buku saku asisten digitalmu. Mau catat apa hari ini?\n\n` +
            `${statusNote}\n\n` +
            `💰 *CATAT UANG & JUALAN*\n` +
            `• Catat penjualan (kurangi stok):\n` +
            `  *Keluar [barang] [jumlah]*\n` +
            `  Contoh: *Keluar vitamin 2*\n` +
            `• Catat pemasukan uang tanpa stok:\n` +
            `  *[keterangan] [nominal]*\n` +
            `  Contoh: *Jualan 25rb*\n` +
            `• Catat pengeluaran toko? Ketik:\n` +
            `  *Beli [keterangan] [nominal]*\n` +
            `  Contoh: *Beli lakban 30rb*\n\n` +
            `🧾 *KIRIM TAGIHAN (INVOICE)*\n` +
            `• Ketik: *Tagih [nominal] ke [nomor WA]*\n` +
            `  Contoh: *Tagih 150rb ke 08123456789*\n\n` +
            `📦 *CEK GUDANG*\n` +
            `• *Stock list* ➡️ Lihat sisa semua barang\n` +
            `• *Masuk [produk] [jumlah]* ➡️ Restok barang\n` +
            `• *Keluar [produk] [jumlah]* ➡️ Catat penjualan (kurangi stok)\n\n` +
            `📋 *LAINNYA*\n` +
            `• *Dashboard* — Akses dashboard web\n` +
            `• *Token baru* — Reset link dashboard jika bocor\n` +
            `• *Laporan* — Rekap transaksi hari ini\n` +
            `• *Piutang* — Cek daftar piutang\n` +
            `• *Laba rugi* — Lihat laba rugi\n` +
            `• *Status* — Info & status akun\n` +
            `• *Paket* — Opsi upgrade & langganan\n\n` +
            `💡 *TIPS:* Angka bisa diketik bebas, contoh: *20rb*, *1.5jt*, *20000*.`,
        );
        return;
      }

      const setbankIntent = /\b(?:setbank|atur\s+rekening|setting\s+bank|set\s+bank)\b/i.test(body);
      if (setbankIntent) return handleSetBankCommand(msg, sender, user, rawBody);

      const tagihIntent = /\b(?:tagih|kirim\s+tagihan|minta\s+bayar|buat\s+(?:invoice|tagihan|bon)|invoice|nagih)\b/i;
      if (tagihIntent.test(body)) return handleInvoiceCommand(msg, sender, user, rawBody, client);

      const stockInMatch = rawBody.match(
        /^(?:masuk|restock|tambah\s+stok)\s+(.+?)\s+(\d+(?:[.,]\d+)?)(?:\s+(pcs|kg|gram|liter|buah|bungkus|pack|box|dus|karton|sak|meter|cm|mm))?$/i,
      );
      if (stockInMatch) {
        await handleStockInOutCommand(msg, user, stockInMatch[1].trim(), stockInMatch[2], 'in');
        return;
      }

      const stockOutMatch = rawBody.match(
        /^(?:keluar|kurang\s+stok)\s+(.+?)\s+(\d+(?:[.,]\d+)?)(?:\s+(pcs|kg|gram|liter|buah|bungkus|pack|box|dus|karton|sak|meter|cm|mm))?$/i,
      );
      if (stockOutMatch) {
        await handleStockInOutCommand(msg, user, stockOutMatch[1].trim(), stockOutMatch[2], 'out');
        return;
      }

      const bahanListIntent =
        KW_BAHAN.some((k) => body === k || body === k + ' list' || body === 'daftar ' + k) ||
        fuzzyMatchKeywords(body, KW_BAHAN);
      if (bahanListIntent && body !== 'bahan masuk' && body !== 'bahan keluar') {
        await handleBahanList(msg, user);
        return;
      }

      const bahanMasukMatch = rawBody.match(/^(?:bahan|material)\s+(?:masuk|restock)\s+(.+?)\s+(\d+(?:[.,]\d+)?)/i);
      if (bahanMasukMatch) {
        await handleBahanMasuk(msg, user, bahanMasukMatch[1].trim(), bahanMasukMatch[2]);
        return;
      }

      const bahanKeluarMatch = rawBody.match(/^(?:bahan|material)\s+(?:keluar|terpakai)\s+(.+?)\s+(\d+(?:[.,]\d+)?)/i);
      if (bahanKeluarMatch) {
        await handleBahanKeluar(msg, user, bahanKeluarMatch[1].trim(), bahanKeluarMatch[2]);
        return;
      }

      const resepMatch = rawBody.match(/^(?:resep|bom|komposisi)\s+(.+)/i);
      if (resepMatch) {
        await handleResep(msg, user, resepMatch[1].trim());
        return;
      }

      // ── Undo Transaksi ──
      if (body === 'undo' || body === 'undo transaksi' || body === 'batalkan transaksi' || body === 'rollback') {
        try {
          const { data: lastTx } = (await supabase
            .from('transactions')
            .select('id, type, amount, product_id, quantity, price_sell, price_buy, created_at, description')
            .eq('user_id', sender)
            .order('created_at', { ascending: false })
            .limit(1)) as any;
          if (!lastTx || lastTx.length === 0) {
            await safeReply(msg, `⚠️ Tidak ada transaksi yang bisa dibatalkan.`);
            return;
          }
          const tx = lastTx[0];
          const createdAt = new Date(tx.created_at).getTime();
          if (Date.now() - createdAt > 5 * 60 * 1000) {
            await safeReply(
              msg,
              `⏰ *Transaksi sudah lebih dari 5 menit.*\n\nUndo hanya bisa untuk transaksi < 5 menit yang lalu.\nHapus manual via Dashboard web.`,
            );
            return;
          }
          const { data: product } = (await supabase
            .from('products')
            .select('name')
            .eq('id', tx.product_id)
            .single()) as any;
          const productName = product?.name || `Produk #${tx.product_id}`;
          setDialog(sender, 'undo_confirmation', {
            transactionId: String(tx.id),
            type: tx.type,
            amount: tx.amount,
            productId: String(tx.product_id),
            productName,
            quantity: tx.quantity,
            priceSell: tx.price_sell,
            priceBuy: tx.price_buy,
            description: tx.description,
          });
          await safeReply(
            msg,
            `📋 *Konfirmasi Batalkan Transaksi*\n\n` +
              `📄 Transaksi terakhir:\n` +
              `${tx.type === 'masuk' ? '📥 MASUK' : '📤 KELUAR'} ${productName}\n` +
              `💵 Jumlah: ${formatRupiah(tx.amount)}\n` +
              `📝 Ket: ${tx.description || '-'}\n\n` +
              `Balas *Ya* untuk membatalkan transaksi.\n` +
              `Balas *Batal* untuk membatalkan.`,
          );
        } catch (e: any) {
          addLog('error', `[UNDO] Error: ${e.message}`);
          await safeReply(msg, `❌ Gagal memproses undo. Coba lagi nanti.`);
        }
        return;
      }

      // ── Menu angka — cek SEBELUM handleTransaction biar "1" ga kedeteksi sebagai nominal Rp 1 ──
      if (/^[1-4]$/.test(body)) {
        if (body === '1') {
          await safeReply(
            msg,
            `💰 *Catat Transaksi — ${user.store_name}*\n\n` +
              `Ketik langsung, contoh:\n\n` +
              `📥 Pemasukan: *Jualan 25rb*\n` +
              `📤 Pengeluaran: *beli stok kopi 500rb*\n` +
              `📦 Penjualan (kurangi stok): *Keluar barang 10*\n\n` +
              `🧾 Tagihan: *tagih 150rb ke 08123456*\n\n` +
              `Ketik *Bantuan* untuk panduan lengkap.`,
          );
          return;
        }
        if (body === '2') {
          const todayStart = new Date();
          todayStart.setHours(0, 0, 0, 0);
          const sent = await sendReport(client, sender, user.store_name, 'Harian (Manual)', todayStart.toISOString());
          if (!sent) {
            await safeReply(msg, `📊 Belum ada transaksi hari ini, Bos.\n\n` + `Mulai catat: *Keluar barang 10*`);
            return;
          }
          return;
        }
        if (body === '3') {
          const statusMsg = buildStatusMessage(user, effectiveStatus, sender);
          await safeReply(msg, statusMsg);
          return;
        }
        if (body === '4') {
          let statusNote = '';
          if (effectiveStatus === 'demo') {
            const todayCount = await getDailyTransactionCount(sender);
            statusNote = `⚠️ _Mode DEMO: ${todayCount}/5 transaksi hari ini._`;
          } else if (effectiveStatus === 'pro') {
            const sisa = getDaysRemaining(user);
            statusNote = `⭐ _PRO aktif, sisa ${sisa} hari._`;
          } else {
            statusNote = `💎 _UNLIMITED aktif selamanya._`;
          }
          await safeReply(
            msg,
            `Halo! 👋 Ini buku saku asisten digitalmu. Mau catat apa hari ini?\n\n` +
              `${statusNote}\n\n` +
              `💰 *CATAT UANG & JUALAN*\n` +
              `• Catat penjualan (kurangi stok):\n  *Keluar [barang] [jumlah]*\n  Contoh: *Keluar vitamin 2*\n` +
              `• Catat pemasukan uang tanpa stok:\n  *[keterangan] [nominal]*\n  Contoh: *Jualan 25rb*\n` +
              `• Catat pengeluaran toko? Ketik:\n  *Beli [keterangan] [nominal]*\n  Contoh: *Beli lakban 30rb*\n\n` +
              `🧾 *KIRIM TAGIHAN (INVOICE)*\n` +
              `• Ketik: *Tagih [nominal] ke [nomor WA]*\n  Contoh: *Tagih 150rb ke 08123456789*\n\n` +
              `📦 *CEK GUDANG*\n` +
              `• *Stock list* ➡️ Lihat sisa semua barang\n` +
              `• *Masuk [produk] [jumlah]* ➡️ Restok barang\n` +
              `• *Keluar [produk] [jumlah]* ➡️ Catat penjualan (kurangi stok)\n\n` +
              `📋 *LAINNYA*\n` +
              `• *Dashboard* — Akses dashboard web\n` +
              `• *Token baru* — Reset link dashboard jika bocor\n` +
              `• *Laporan* — Rekap transaksi hari ini\n` +
              `• *Piutang* — Cek daftar piutang\n` +
              `• *Laba rugi* — Lihat laba rugi\n` +
              `• *Status* — Info & status akun\n` +
              `• *Paket* — Opsi upgrade & langganan\n\n` +
              `💡 *TIPS:* Angka bisa diketik bebas, contoh: *20rb*, *1.5jt*, *20000*.`,
          );
          return;
        }
      }

      const txHandled = await handleTransaction(msg, sender, user, effectiveStatus, rawBody, body, client);
      if (txHandled) return;

      await safeReply(
        msg,
        `Waduh, Tata agak bingung nih sama ketikannya 😅\n\n` +
          `Coba pakai cara simpel aja ya bos:\n\n` +
          `🟢 *Jualan 25rb* — ada pemasukan\n` +
          `🔴 *Beli gula 20rb* — bos belanja\n` +
          `📦 *Keluar barang 10* — catat penjualan (kurangi stok)\n\n` +
          `Atau ketik *Bantuan* untuk contekan lengkapnya.`,
      );
      return;
    } catch (err: any) {
      const errMsg = sanitizeError(err);
      if (errMsg.includes('[SUPABASE ERROR]')) circuitRecordFailure();
      const errType =
        errMsg.includes('Database') || errMsg.includes('Gagal daftar')
          ? '[MESSAGE HANDLER ERROR: New User]'
          : '[MESSAGE HANDLER ERROR]';
      addLog('error', `${errType}: ${errMsg}`, { sender, body: body?.substring(0, 200) });
      await safeReply(msg, `Maaf ya, sistem Tata sedang sedikit sibuk 🙏\nMohon tunggu sebentar dan coba lagi ya!`);
    }
  });
}

export { handleMessage, invalidateMaintenanceCache };

// ── Retur Jual / Retur Beli Handlers ──

const pendingReturJual = new Map<
  string,
  {
    originalTransactionId: string;
    productId: string;
    productName: string;
    quantity: number;
    priceSell: number;
    priceBuy: number;
    returnReason: string;
    customerName: string;
    statusBayar: string;
    channel: string;
    timestamp: number;
  }
>();
const pendingReturBeli = new Map<
  string,
  {
    originalTransactionId: string;
    productId: string;
    productName: string;
    quantity: number;
    priceBuy: number;
    returnReason: string;
    supplierName: string;
    statusBayar: string;
    timestamp: number;
  }
>();

async function handleReturJual(
  msg: any,
  sender: string,
  user: any,
  amount: number,
  geminiResult: any,
  rawBody: string,
  client: any,
): Promise<boolean> {
  const items = geminiResult?.raw?.items || geminiResult?.items || [];
  const item = items[0] || {};
  const productName = item.nama_barang || '';
  const qty = item.qty || 0;
  const reason = geminiResult?.raw?.catatan || geminiResult?.catatan || 'Retur penjualan';

  if (!productName || !qty) {
    await safeReply(msg, '❌ Format retur tidak jelas. Contoh: *retur 2 kopi dari Pak Budi rusak*');
    return true;
  }

  const { data: products } = (await supabase
    .from('products')
    .select('id, name, price_buy, price_sell')
    .eq('user_id', sender)
    .eq('is_active', true)
    .ilike('name', `%${productName}%`)
    .limit(5)) as any;

  if (!products || products.length === 0) {
    await safeReply(msg, `❌ Produk "${productName}" tidak ditemukan. Pastikan nama produk benar.`);
    return true;
  }

  const product = products[0];
  const customerName = geminiResult?.raw?.customer_name || geminiResult?.customerName || 'Customer';
  const priceSell = parseFloat(product.price_sell) || 0;
  const priceBuy = parseFloat(product.price_buy) || 0;
  const returnAmount = qty * priceSell;

  const { data: transactions } = (await supabase
    .from('transactions')
    .select('id, status_bayar, customer_name')
    .eq('user_id', sender)
    .eq('product_id', product.id)
    .eq('type', 'masuk')
    .order('created_at', { ascending: false })
    .limit(5)) as any;

  const originalTx =
    transactions?.find((t: any) => {
      if (customerName !== 'Customer' && t.customer_name) {
        return t.customer_name.toLowerCase().includes(customerName.toLowerCase());
      }
      return true;
    }) || transactions?.[0];

  if (!originalTx) {
    await safeReply(msg, `❌ Transaksi penjualan original untuk ${product.name} tidak ditemukan.`);
    return true;
  }

  const statusBayar = originalTx.status_bayar === 'piutang' ? 'piutang' : 'tunai';

  setDialog(sender, 'retur_jual', {
    originalTransactionId: String(originalTx.id),
    productId: String(product.id),
    productName: product.name,
    quantity: qty,
    priceSell,
    priceBuy,
    returnReason: reason,
    customerName,
    statusBayar,
    channel: 'Offline',
  });

  await safeReply(
    msg,
    `📋 *Konfirmasi Retur Penjualan*\n\n📦 Produk : ${product.name} × ${qty}\n💵 Nilai Retur : ${formatRupiah(returnAmount)}\n📝 Alasan : ${reason}\n👤 Customer : ${customerName}\n💳 Status : ${statusBayar === 'piutang' ? 'Piutang' : 'Tunai (refund)'}\n\nBalas *Ya* untuk memproses retur.\nBalas *Batal* untuk membatalkan.`,
  );
  return true;
}

async function handleReturBeli(
  msg: any,
  sender: string,
  user: any,
  amount: number,
  geminiResult: any,
  rawBody: string,
  client: any,
): Promise<boolean> {
  const items = geminiResult?.raw?.items || geminiResult?.items || [];
  const item = items[0] || {};
  const productName = item.nama_barang || '';
  const qty = item.qty || 0;
  const reason = geminiResult?.raw?.catatan || geminiResult?.catatan || 'Retur pembelian';

  if (!productName || !qty) {
    await safeReply(msg, '❌ Format retur tidak jelas. Contoh: *retur beli 5 kopi kualitas buruk*');
    return true;
  }

  const { data: products } = (await supabase
    .from('products')
    .select('id, name, price_buy')
    .eq('user_id', sender)
    .eq('is_active', true)
    .ilike('name', `%${productName}%`)
    .limit(5)) as any;

  if (!products || products.length === 0) {
    await safeReply(msg, `❌ Produk "${productName}" tidak ditemukan.`);
    return true;
  }

  const product = products[0];
  const supplierName = geminiResult?.raw?.customer_name || geminiResult?.customerName || 'Supplier';
  const priceBuy = parseFloat(product.price_buy) || 0;
  const returnAmount = qty * priceBuy;

  const { data: transactions } = (await supabase
    .from('transactions')
    .select('id, status_bayar')
    .eq('user_id', sender)
    .eq('product_id', product.id)
    .eq('type', 'keluar')
    .order('created_at', { ascending: false })
    .limit(5)) as any;

  const originalTx = transactions?.[0];
  if (!originalTx) {
    await safeReply(msg, `❌ Transaksi pembelian original untuk ${product.name} tidak ditemukan.`);
    return true;
  }

  const statusBayar = originalTx.status_bayar === 'hutang' ? 'hutang' : 'tunai';

  setDialog(sender, 'retur_beli', {
    originalTransactionId: String(originalTx.id),
    productId: String(product.id),
    productName: product.name,
    quantity: qty,
    priceBuy,
    returnReason: reason,
    supplierName,
    statusBayar,
  });

  await safeReply(
    msg,
    `📋 *Konfirmasi Retur Pembelian*\n\n📦 Produk : ${product.name} × ${qty}\n💵 Nilai Retur : ${formatRupiah(returnAmount)}\n📝 Alasan : ${reason}\n🏢 Supplier : ${supplierName}\n💳 Status : ${statusBayar === 'hutang' ? 'Hutang (kurangi hutang)' : 'Tunai (refund)'}\n\nBalas *Ya* untuk memproses retur.\nBalas *Batal* untuk membatalkan.`,
  );
  return true;
}

// ── Pay Hutang / Receive Piutang Handlers ──

async function handlePayHutang(
  msg: any,
  sender: string,
  user: any,
  amount: number,
  geminiResult: any,
  rawBody: string,
  client: any,
): Promise<boolean> {
  const { data: hutangs, error } = (await supabase
    .from('payables')
    .select('id, nama_supplier, nominal_hutang, jumlah_dibayar, status_lunas')
    .eq('user_id', sender)
    .eq('status_lunas', false)
    .order('jatuh_tempo', { ascending: true })) as any;
  if (error || !hutangs?.length) {
    await safeReply(msg, '✅ Tidak ada hutang yang perlu dibayar.');
    return true;
  }
  // Find exact match or pick the first unpaid
  const supplierName = geminiResult.raw?.customer_name || geminiResult.customerName || hutangs[0].nama_supplier;
  const target =
    hutangs.find((h: any) => h.nama_supplier.toLowerCase().includes(supplierName.toLowerCase())) || hutangs[0];
  const sisa = (parseFloat(target.nominal_hutang) || 0) - (parseFloat(target.jumlah_dibayar) || 0);
  const bayar = Math.min(amount, sisa);
  setDialog(sender, 'pay_hutang', { payableId: target.id, amount: bayar, supplier: target.nama_supplier });
  await safeReply(
    msg,
    `📋 *Konfirmasi Bayar Hutang*\n\n🏢 Supplier : ${target.nama_supplier}\n💵 Sisa Hutang : ${formatRupiah(sisa)}\n💳 Akan Dibayar : ${formatRupiah(bayar)}${bayar < sisa ? `\n⚠️ Sisa setelah bayar: ${formatRupiah(sisa - bayar)}` : '\n✅ *LUNAS!*'}\n\nBalas *Ya* untuk mengonfirmasi.\nBalas *Batal* untuk membatalkan.`,
  );
  return true;
}

async function handleTerimaPiutang(
  msg: any,
  sender: string,
  user: any,
  amount: number,
  geminiResult: any,
  rawBody: string,
  client: any,
): Promise<boolean> {
  const { data: piutangs, error } = (await supabase
    .from('receivables')
    .select('id, nama_pelanggan, nominal_piutang, status_lunas')
    .eq('user_id', sender)
    .eq('status_lunas', false)
    .order('jatuh_tempo', { ascending: true })) as any;
  if (error || !piutangs?.length) {
    await safeReply(msg, '✅ Tidak ada piutang yang perlu ditagih.');
    return true;
  }
  const customerName = geminiResult.raw?.customer_name || geminiResult.customerName || piutangs[0].nama_pelanggan;
  const target =
    piutangs.find((d: any) => d.nama_pelanggan.toLowerCase().includes(customerName.toLowerCase())) || piutangs[0];
  const sisa = parseFloat(target.nominal_piutang) || 0;
  const terima = Math.min(amount, sisa);
  setDialog(sender, 'receive_piutang', { debtId: target.id, amount: terima, customer: target.nama_pelanggan });
  await safeReply(
    msg,
    `📋 *Konfirmasi Terima Piutang*\n\n👤 Customer : ${target.nama_pelanggan}\n💵 Sisa Piutang : ${formatRupiah(sisa)}\n💳 Akan Diterima : ${formatRupiah(terima)}${terima < sisa ? `\n⚠️ Sisa setelah bayar: ${formatRupiah(sisa - terima)}` : '\n✅ *LUNAS!*'}\n\nBalas *Ya* untuk mengonfirmasi.\nBalas *Batal* untuk membatalkan.`,
  );
  return true;
}
