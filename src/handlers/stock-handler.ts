import * as stockManager from '../utils/stockManager';
import { formatRupiah } from '../utils/helpers';
import { safeReply } from '../config/message-state';
import type { Message } from 'whatsapp-web.js';

async function handleStockList(msg: Message, user: any): Promise<boolean> {
  const result = await stockManager.listProducts(user.id, { active: true });

  if (!result.success) {
    await safeReply(msg, `❌ ${result.error}`);
    return true;
  }

  if (!result.products || result.products.length === 0) {
    await safeReply(
      msg,
      `📦 *Stock Kosong*\n\n` +
        `Belum ada produk terdaftar.\n\n` +
        `Tambah produk dengan:\n` +
        `*Tambah produk [SKU] [Nama] ...*\n\n` +
        `Ketik *Bantuan Stock* untuk panduan Tata.`,
    );
    return true;
  }

  let text = `📦 *Daftar Produk - ${user.store_name}*\n\n`;

  (result.products as any[]).forEach((p: any, i: number) => {
    const stock = stockManager.formatQty(p.stock_current, p.unit);
    const alert = parseFloat(p.stock_current) <= parseFloat(p.stock_min) ? ' ⚠️' : '';

    text += `${i + 1}. *${p.name}*${alert}\n`;
    text += `   SKU: ${p.sku} | ${stock} ${p.unit}\n`;
    text += `   Jual: ${formatRupiah(p.price_sell)}\n\n`;
  });

  text += `Ketik *Stock info [SKU]* untuk detail produk.\nKetik *Dashboard* untuk kelola stok via web (tambah/kurang/opname).`;

  await safeReply(msg, text);
  return true;
}

async function handleStockInfo(msg: Message, user: any, rawBody: string): Promise<boolean> {
  const parts = rawBody.split(/\s+/);
  const skuOrId = parts[2];

  if (!skuOrId) {
    await safeReply(msg, `❌ Format: *Stock info [SKU]*\n\nContoh: Stock info BRS-01`);
    return true;
  }

  const result = await stockManager.getProduct(user.id, skuOrId);

  if (!result.success) {
    await safeReply(msg, `❌ Produk "${skuOrId}" tidak ditemukan.\n\nKetik *Stock list* untuk lihat semua produk.`);
    return true;
  }

  const p = result.product as any;
  const stock = stockManager.formatQty(p.stock_current, p.unit);
  const min = stockManager.formatQty(p.stock_min, p.unit);
  const value = parseFloat(p.stock_current) * parseFloat(p.price_buy);

  let alert = '';
  if (parseFloat(p.stock_current) <= 0) {
    alert = '\n\n🔴 *STOCK HABIS!*';
  } else if (parseFloat(p.stock_current) <= parseFloat(p.stock_min)) {
    alert = '\n\n⚠️ *Stock di bawah minimum!*';
  }

  await safeReply(
    msg,
    `📦 *Detail Produk*\n\n` +
      `SKU      : ${p.sku}\n` +
      `Nama     : ${p.name}\n` +
      `Kategori : ${p.category}\n` +
      `Satuan   : ${p.unit}\n\n` +
      `💵 Harga Beli : ${formatRupiah(p.price_buy)}\n` +
      `💰 Harga Jual : ${formatRupiah(p.price_sell)}\n\n` +
      `📊 Stock      : ${stock} ${p.unit}\n` +
      `⚠️ Minimum    : ${min} ${p.unit}\n` +
      `💎 Nilai Stock: ${formatRupiah(value)}` +
      alert +
      `\n\n` +
      `💡 Kelola stok (tambah/kurangi/opname) via web:\n` +
      `Ketik *Dashboard* untuk dapat link akses.`,
  );
  return true;
}

async function handleStockReport(msg: Message, user: any): Promise<boolean> {
  const result = await stockManager.generateStockReport(user.id);

  if (!result.success) {
    await safeReply(msg, `❌ ${result.error}`);
    return true;
  }

  if ((result as any).totalProducts === 0) {
    await safeReply(msg, `📦 Belum ada produk terdaftar.`);
    return true;
  }

  let text = `📊 *Laporan Stock - ${user.store_name}*\n\n`;
  text += `Total Produk: ${(result as any).totalProducts}\n`;
  text += `Nilai Stock : ${formatRupiah((result as any).totalValue)}\n\n`;

  text += `*Per Kategori:*\n`;
  Object.entries((result as any).byCategory || {}).forEach(([cat, data]: [string, any]) => {
    text += `\n${cat} (${data.count} item)\n`;
    text += `Nilai: ${formatRupiah(data.value)}\n`;
  });

  await safeReply(msg, text);
  return true;
}

async function handleBahanList(msg: Message, user: any): Promise<boolean> {
  const result = await stockManager.listMaterials(user.id);
  if (!result.success || !result.materials || result.materials.length === 0) {
    await safeReply(
      msg,
      `📦 *Bahan Baku*\n\nBelum ada material terdaftar.\nTambah via dashboard: *Produk → Bahan Baku*`,
    );
    return true;
  }
  const mats = result.materials as any[];
  let text = `📦 *Bahan Baku - ${user.store_name}*\n\n`;
  mats.forEach((m: any) => {
    const status =
      parseFloat(m.stock_current) <= 0
        ? ' ❌ HABIS'
        : parseFloat(m.stock_current) <= parseFloat(m.stock_min)
          ? ' ⚠️'
          : '';
    text += `• *${m.name}*: ${stockManager.formatQty(m.stock_current, m.unit)} ${m.unit}${status}\n`;
  });
  text += `\nKetik *Bahan masuk [nama] [jumlah]* untuk restock.`;
  await safeReply(msg, text);
  return true;
}

async function handleBahanMasuk(msg: Message, user: any, materialQuery: string, qtyStr: string): Promise<boolean> {
  const qty = parseFloat(qtyStr.replace(',', '.'));
  if (isNaN(qty) || qty <= 0) {
    await safeReply(msg, `⚠️ Jumlah tidak valid: *${qtyStr}*. Contoh: *Bahan masuk kain 50*`);
    return true;
  }
  const list = await stockManager.listMaterials(user.id);
  if (!list.success || !list.materials || list.materials.length === 0) {
    await safeReply(msg, `⚠️ Belum ada material terdaftar. Tambah via dashboard.`);
    return true;
  }
  const match = (list.materials as any[]).find((m: any) => m.name.toLowerCase().includes(materialQuery.toLowerCase()));
  if (!match) {
    await safeReply(msg, `⚠️ Material "${materialQuery}" tidak ditemukan.\nKetik *Bahan list* untuk lihat daftar.`);
    return true;
  }
  const stockBefore = parseFloat(match.stock_current) || 0;
  const stockAfter = stockBefore + qty;
  const result = await stockManager.updateMaterial(user.id, match.id, {
    stockCurrent: stockAfter,
  } as any);
  if (!result.success) {
    await safeReply(msg, `❌ Gagal update stok: ${result.error}`);
    return true;
  }
  await safeReply(
    msg,
    `✅ *${match.name}*: ${stockManager.formatQty(stockBefore, match.unit)} → ${stockManager.formatQty(stockAfter, match.unit)} ${match.unit}`,
  );
  return true;
}

async function handleBahanKeluar(msg: Message, user: any, materialQuery: string, qtyStr: string): Promise<boolean> {
  const qty = parseFloat(qtyStr.replace(',', '.'));
  if (isNaN(qty) || qty <= 0) {
    await safeReply(msg, `⚠️ Jumlah tidak valid: *${qtyStr}*. Contoh: *Bahan keluar kain 10*`);
    return true;
  }
  const list = await stockManager.listMaterials(user.id);
  if (!list.success || !list.materials || list.materials.length === 0) {
    await safeReply(msg, `⚠️ Belum ada material terdaftar. Tambah via dashboard.`);
    return true;
  }
  const match = (list.materials as any[]).find((m: any) => m.name.toLowerCase().includes(materialQuery.toLowerCase()));
  if (!match) {
    await safeReply(msg, `⚠️ Material "${materialQuery}" tidak ditemukan.\nKetik *Bahan list* untuk lihat daftar.`);
    return true;
  }
  const stockBefore = parseFloat(match.stock_current) || 0;
  if (stockBefore < qty) {
    await safeReply(
      msg,
      `⚠️ Stok ${match.name} tidak cukup. Tersedia: ${stockManager.formatQty(stockBefore, match.unit)} ${match.unit}`,
    );
    return true;
  }
  const stockAfter = stockBefore - qty;
  const result = await stockManager.updateMaterial(user.id, match.id, {
    stockCurrent: stockAfter,
  } as any);
  if (!result.success) {
    await safeReply(msg, `❌ Gagal update stok: ${result.error}`);
    return true;
  }
  await safeReply(
    msg,
    `✅ *${match.name}*: ${stockManager.formatQty(stockBefore, match.unit)} → ${stockManager.formatQty(stockAfter, match.unit)} ${match.unit}`,
  );
  return true;
}

async function handleResep(msg: Message, user: any, productQuery: string): Promise<boolean> {
  const prodResult = await stockManager.searchProductByName(user.id, productQuery);
  if (!prodResult.success || !prodResult.products || prodResult.products.length === 0) {
    await safeReply(msg, `⚠️ Produk "*${productQuery}*" tidak ditemukan.`);
    return true;
  }
  const product = prodResult.products[0] as any;
  const recipeResult = await stockManager.getRecipes(user.id, product.id);
  if (!recipeResult.success || (recipeResult.recipes as any[]).length === 0) {
    await safeReply(
      msg,
      `📋 *Resep ${product.name}*\n\nBelum ada resep BOM untuk produk ini.\nAtur via dashboard: *Produk → ${product.name} → Atur Resep*`,
    );
    return true;
  }
  const recipes = recipeResult.recipes as any[];
  let text = `📋 *Resep ${product.name}*\n\n`;
  let totalCost = 0;
  recipes.forEach((r: any) => {
    const mat = r.bom_materials;
    if (!mat) return;
    const amt = parseFloat(r.quantity_per_order);
    const cost = amt * parseFloat(mat.cost_per_unit || 0);
    totalCost += cost;
    text += `• *${mat.name}*: ${amt} ${mat.unit} (${formatRupiah(cost)})\n`;
  });
  text += `\n💰 Total biaya bahan: ${formatRupiah(totalCost)}`;
  text += `\n💰 Harga jual: ${formatRupiah(product.price_sell)}`;
  text += `\n📊 Margin: ${formatRupiah(product.price_sell - totalCost)}`;
  await safeReply(msg, text);
  return true;
}

export {
  handleStockList,
  handleStockInfo,
  handleStockReport,
  handleBahanList,
  handleBahanMasuk,
  handleBahanKeluar,
  handleResep,
};
