import crypto from 'crypto';
import { pgPool } from '../config/supabase';
import supabase from '../config/supabase';
import accountingEngine from './accountingEngine';

const DAY_MS = 86400000;

export async function setupDemoAccount() {
  const pool = pgPool;
  if (!pool) return { error: 'Database tidak tersedia' };

  // Check if demo already exists
  const { data: existing } = (await supabase
    .from('users')
    .select('id, store_name, dashboard_token, store_slug')
    .eq('store_slug', 'demo')
    .maybeSingle()) as any;
  if (existing) {
    const baseUrl = process.env.PUBLIC_URL || 'https://tata-suite.up.railway.app';
    return {
      success: true,
      exists: true,
      loginUrl: `${baseUrl}/stock/${existing.store_slug}?token=${existing.dashboard_token}`,
      token: existing.dashboard_token,
      slug: existing.store_slug,
      storeName: existing.store_name,
    };
  }

  // Create user with proper random UUID
  const userId = crypto.randomUUID();
  const token = crypto.randomUUID().replace(/-/g, '');
  const slug = 'demo';
  const storeName = 'Demo Store';

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(
      `INSERT INTO users (id, store_name, store_slug, status, dashboard_token, onboarding_status, metadata)
       VALUES ($1, $2, $3, 'pro', $4, 'completed', $5)`,
      [
        userId,
        storeName,
        slug,
        token,
        JSON.stringify({ active_channels: ['offline', 'whatsapp', 'shopee', 'tokopedia'] }),
      ],
    );

    // COA
    try {
      await client.query('SELECT seed_default_coa($1)', [userId]);
      await client.query('SELECT seed_default_coa_mapping($1)', [userId]);
    } catch {
      const coa = [
        ['1101', 'Kas / Bank', 'asset', 'debit'],
        ['1102', 'Piutang Dagang', 'asset', 'debit'],
        ['1201', 'Inventori', 'asset', 'debit'],
        ['1301', 'Aset Tetap', 'asset', 'debit'],
        ['1302', 'Akumulasi Penyusutan', 'asset', 'credit'],
        ['2101', 'Hutang Dagang', 'liability', 'credit'],
        ['2102', 'Hutang Pajak', 'liability', 'credit'],
        ['3101', 'Modal Pemilik', 'equity', 'credit'],
        ['3102', 'Prive (Pribadi)', 'equity', 'debit'],
        ['3103', 'Laba Ditahan', 'equity', 'credit'],
        ['4101', 'Penjualan Offline', 'revenue', 'credit'],
        ['4102', 'Penjualan Tokopedia', 'revenue', 'credit'],
        ['4103', 'Penjualan TikTok Shop', 'revenue', 'credit'],
        ['4104', 'Penjualan Lazada', 'revenue', 'credit'],
        ['4105', 'Penjualan Shopee', 'revenue', 'credit'],
        ['5101', 'Harga Pokok Penjualan', 'cogs', 'debit'],
        ['6101', 'Beban Gaji', 'expense', 'debit'],
        ['6102', 'Beban Sewa', 'expense', 'debit'],
        ['6103', 'Beban Listrik & Air', 'expense', 'debit'],
        ['6104', 'Beban Transport', 'expense', 'debit'],
        ['6105', 'Beban Operasional Lainnya', 'expense', 'debit'],
        ['6106', 'Beban Penyusutan', 'expense', 'debit'],
      ];
      for (const [code, name, type, nb] of coa) {
        await client.query(
          `INSERT INTO chart_of_accounts (user_id, code, name, type, normal_balance)
           VALUES ($1, $2, $3, $4, $5) ON CONFLICT (user_id, code) DO NOTHING`,
          [userId, code, name, type, nb],
        );
      }
      const mapping = [
        ['beban_gaji', '6101', '1101'],
        ['beban_sewa', '6102', '1101'],
        ['beban_listrik_air', '6103', '1101'],
        ['beban_transport', '6104', '1101'],
        ['beban_operasional', '6105', '1101'],
        ['modal', '1101', '3101'],
        ['prive', '3102', '1101'],
        ['piutang', '1102', '4101'],
        ['hutang_dagang', '1201', '2101'],
        ['hutang_lancar', '6105', '2101'],
      ];
      for (const [tipe, debit, credit] of mapping) {
        await client.query(
          `INSERT INTO transaction_type_coa (user_id, tipe, coa_debit, coa_credit)
           VALUES ($1, $2, $3, $4) ON CONFLICT (user_id, tipe) DO NOTHING`,
          [userId, tipe, debit, credit],
        );
      }
    }

    // Products
    const products = [
      {
        name: 'Kopi Arabica 250g',
        cat: 'Konsumsi',
        unit: 'pcs',
        buy: 25000,
        sell: 45000,
        stock: 48,
        min: 10,
        channel: 'offline',
      },
      {
        name: 'Kopi Robusta 250g',
        cat: 'Konsumsi',
        unit: 'pcs',
        buy: 20000,
        sell: 35000,
        stock: 35,
        min: 10,
        channel: 'offline',
      },
      {
        name: 'Gula Aren 500g',
        cat: 'Konsumsi',
        unit: 'pcs',
        buy: 12000,
        sell: 22000,
        stock: 60,
        min: 15,
        channel: 'offline',
      },
      {
        name: 'Susu UHT 1L',
        cat: 'Konsumsi',
        unit: 'pcs',
        buy: 15000,
        sell: 28000,
        stock: 24,
        min: 8,
        channel: 'offline',
      },
      {
        name: 'Teh Hijau 50 kantong',
        cat: 'Konsumsi',
        unit: 'pcs',
        buy: 8000,
        sell: 15000,
        stock: 40,
        min: 10,
        channel: 'offline',
      },
      {
        name: 'Sabun Cuci Piring',
        cat: 'Rumah Tangga',
        unit: 'pcs',
        buy: 7000,
        sell: 13000,
        stock: 90,
        min: 20,
        channel: 'shopee',
      },
      {
        name: 'Deterjen 1kg',
        cat: 'Rumah Tangga',
        unit: 'pcs',
        buy: 14000,
        sell: 25000,
        stock: 30,
        min: 10,
        channel: 'shopee',
      },
      {
        name: 'Pembersih Lantai',
        cat: 'Rumah Tangga',
        unit: 'pcs',
        buy: 10000,
        sell: 18000,
        stock: 45,
        min: 10,
        channel: 'shopee',
      },
      {
        name: 'Tisu 200 lembar',
        cat: 'Rumah Tangga',
        unit: 'pcs',
        buy: 5000,
        sell: 10000,
        stock: 100,
        min: 25,
        channel: 'tokopedia',
      },
      {
        name: 'Beras Premium 5kg',
        cat: 'Sembako',
        unit: 'pcs',
        buy: 55000,
        sell: 75000,
        stock: 20,
        min: 5,
        channel: 'offline',
      },
      {
        name: 'Minyak Goreng 2L',
        cat: 'Sembako',
        unit: 'pcs',
        buy: 28000,
        sell: 42000,
        stock: 25,
        min: 8,
        channel: 'offline',
      },
      {
        name: 'Telur 1kg',
        cat: 'Sembako',
        unit: 'pcs',
        buy: 22000,
        sell: 32000,
        stock: 15,
        min: 5,
        channel: 'offline',
      },
      {
        name: 'Tepung Terigu 1kg',
        cat: 'Sembako',
        unit: 'pcs',
        buy: 9000,
        sell: 15000,
        stock: 40,
        min: 10,
        channel: 'tokopedia',
      },
      {
        name: 'Mie Instant (karton)',
        cat: 'Sembako',
        unit: 'pcs',
        buy: 85000,
        sell: 110000,
        stock: 12,
        min: 3,
        channel: 'tokopedia',
      },
      {
        name: 'Pulsa Listrik 50rb',
        cat: 'Elektronik',
        unit: 'pcs',
        buy: 48000,
        sell: 50000,
        stock: 999,
        min: 50,
        channel: 'offline',
      },
    ];
    const productIds: number[] = [];
    for (const p of products) {
      const r = await client.query(
        `INSERT INTO products (user_id, sku, name, category, unit, price_buy, price_sell, stock_current, stock_min, default_channel)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT DO NOTHING RETURNING id`,
        [
          userId,
          `SKU-${p.name.replace(/\s+/g, '-')}`,
          p.name,
          p.cat,
          p.unit,
          p.buy,
          p.sell,
          p.stock,
          p.min,
          p.channel || null,
        ],
      );
      if (r.rows.length > 0) productIds.push(r.rows[0].id);
    }

    // Stock movements
    const prodRows = await client.query('SELECT id, name, stock_current, price_buy FROM products WHERE user_id = $1', [
      userId,
    ]);
    for (const row of prodRows.rows) {
      const stk = Number(row.stock_current);
      if (stk > 0) {
        await client.query(
          `INSERT INTO stock_movements (user_id, product_id, type, quantity, stock_before, stock_after, note, created_by)
           VALUES ($1, $2, 'in', $3, 0, $3, 'Stok awal (setup)', 'system')`,
          [userId, row.id, stk],
        );
      }
    }
    // Sync inventory table
    for (const row of prodRows.rows) {
      const stk = Number(row.stock_current);
      if (stk > 0) {
        await client.query(
          `INSERT INTO inventory (user_id, product_id, quantity, warehouse)
           VALUES ($1, $2, $3, 'Utama')
           ON CONFLICT (user_id, product_id, warehouse)
           DO UPDATE SET quantity = EXCLUDED.quantity`,
          [userId, row.id, stk],
        );
      }
    }

    // Transactions
    const now = new Date();
    const prodPrices = await client.query('SELECT id, name, price_buy, price_sell FROM products WHERE user_id = $1', [
      userId,
    ]);
    const pp = prodPrices.rows;
    const channels = ['Offline', 'Offline', 'Offline', 'Tokopedia', 'Shopee'];
    const customers = ['Budi', 'Siti', 'Ahmad', 'Rina', 'Dedi', 'Maya', 'Irfan', 'Nina', 'Eko', 'Dewi'];

    for (let day = 1; day <= 25; day++) {
      const txCount = 1 + Math.floor(Math.random() * 3);
      for (let t = 0; t < txCount; t++) {
        const prod = pp[Math.floor(Math.random() * pp.length)];
        const qty = 1 + Math.floor(Math.random() * 5);
        const ps = Number(prod.price_sell);
        const pb = Number(prod.price_buy);
        const total = ps * qty;
        const profit = (ps - pb) * qty;
        const ch = channels[Math.floor(Math.random() * channels.length)];
        const cust = customers[Math.floor(Math.random() * customers.length)];
        const txDate = new Date(now);
        txDate.setDate(txDate.getDate() - (25 - day));
        txDate.setHours(8 + Math.floor(Math.random() * 11), Math.floor(Math.random() * 60));

        await client.query(
          `INSERT INTO transactions (user_id, type, amount, description, product_id, quantity, price_sell, price_buy, profit, channel, customer_name, status_bayar, reference_type, created_at)
           VALUES ($1, 'masuk', $2, $3, $4, $5, $6, $7, $8, $9, $10, 'tunai', 'cashier', $11)`,
          [
            userId,
            total,
            `Penjualan ${qty} ${prod.name}`,
            prod.id,
            qty,
            ps,
            pb,
            profit,
            ch,
            cust,
            txDate.toISOString(),
          ],
        );
      }
    }

    const expenses = [
      { desc: 'Sewa tempat bulan ini', amount: 1500000, dateOffset: 1 },
      { desc: 'Listrik & air', amount: 450000, dateOffset: 3 },
      { desc: 'Gaji pegawai', amount: 2000000, dateOffset: 2 },
      { desc: 'Transportasi', amount: 150000, dateOffset: 5 },
      { desc: 'Beli kantong plastik', amount: 75000, dateOffset: 7 },
    ];
    for (const exp of expenses) {
      const expDate = new Date(now);
      expDate.setDate(expDate.getDate() - exp.dateOffset);
      await client.query(
        `INSERT INTO transactions (user_id, type, amount, description, channel, created_at)
         VALUES ($1, 'keluar', $2, $3, 'Offline', $4)`,
        [userId, exp.amount, exp.desc, expDate.toISOString()],
      );
    }

    // Hutang
    const debts = [
      { supplier: 'PT Sembako Sejahtera', amount: 2500000, paid: 1000000, dueDays: 14 },
      { supplier: 'UD Kopi Nusantara', amount: 1200000, paid: 0, dueDays: 7 },
    ];
    for (const d of debts) {
      const dueDate = new Date(now);
      dueDate.setDate(dueDate.getDate() + d.dueDays);
      await client.query(
        `INSERT INTO payables (user_id, nama_supplier, nominal_hutang, jumlah_dibayar, status_lunas, jatuh_tempo)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [userId, d.supplier, d.amount, d.paid, false, dueDate.toISOString()],
      );
    }

    // Piutang
    const receivables = [
      { customer: 'Toko Maju Jaya', amount: 800000, dueDays: 10 },
      { customer: 'Warung Sejahtera', amount: 350000, dueDays: 5 },
    ];
    for (const r of receivables) {
      const dueDate = new Date(now);
      dueDate.setDate(dueDate.getDate() + r.dueDays);
      await client.query(
        `INSERT INTO receivables (user_id, nama_pelanggan, nominal_piutang, status_lunas, jatuh_tempo)
         VALUES ($1, $2, $3, false, $4)`,
        [userId, r.customer, r.amount, dueDate.toISOString()],
      );
    }

    await client.query('COMMIT');

    // Journal entries (after COMMIT so supabase sees the transactions)
    const channelAccounts: Record<string, string> = {
      Offline: '4101',
      Tokopedia: '4102',
      'TikTok Shop': '4103',
      Lazada: '4104',
      Shopee: '4105',
    };
    const { data: txRows } = await supabase
      .from('transactions')
      .select('id, type, amount, channel, quantity, price_buy, description, created_at')
      .eq('user_id', userId)
      .throwOnError();
    let journalCount = 0;
    for (const tx of (txRows as any[]) || []) {
      const amt = Number(tx.amount) || 0;
      if (amt <= 0) continue;
      if (tx.type === 'masuk') {
        const revCode = channelAccounts[tx.channel] || '4101';
        const modal = (Number(tx.quantity) || 0) * (Number(tx.price_buy) || 0);
        const j = await accountingEngine.postJournal({
          userId,
          entryDate: tx.created_at ? new Date(tx.created_at) : undefined,
          referenceType: 'sale',
          referenceId: tx.id,
          description: `Penjualan via ${tx.channel || 'Offline'}`,
          lines: [
            { accountCode: '1101', debit: amt, credit: 0, description: 'Penerimaan penjualan' },
            { accountCode: revCode, debit: 0, credit: amt, description: `Penjualan via ${tx.channel || 'Offline'}` },
            { accountCode: '5101', debit: modal, credit: 0, description: 'HPP penjualan' },
            { accountCode: '1201', debit: 0, credit: modal, description: 'Pengurangan inventori' },
          ],
        });
        if (j.success) journalCount++;
      } else if (tx.type === 'keluar') {
        const expenseAccounts: Record<string, string> = {
          sewa: '6102',
          listrik: '6103',
          gaji: '6101',
          transport: '6104',
          kantong: '6105',
        };
        const desc = (tx.description || '').toLowerCase();
        let expCode = '6105';
        for (const [keyword, code] of Object.entries(expenseAccounts)) {
          if (desc.includes(keyword)) {
            expCode = code;
            break;
          }
        }
        const j = await accountingEngine.postJournal({
          userId,
          entryDate: tx.created_at ? new Date(tx.created_at) : undefined,
          referenceType: 'expense',
          referenceId: tx.id,
          description: tx.description || 'Pengeluaran',
          lines: [
            { accountCode: expCode, debit: amt, credit: 0, description: tx.description || 'Beban' },
            { accountCode: '1101', debit: 0, credit: amt, description: 'Pembayaran beban' },
          ],
        });
        if (j.success) journalCount++;
      }
    }

    // Modal journal
    const invTotal = prodRows.rows.reduce((s: number, r: any) => s + Number(r.stock_current) * Number(r.price_buy), 0);
    const modalJ = await accountingEngine.postJournal({
      userId,
      entryDate: new Date(now.getTime() - 30 * DAY_MS),
      referenceType: 'modal',
      description: 'Modal awal dan setoran pemilik',
      lines: [
        { accountCode: '1101', debit: 10000000, credit: 0, description: 'Setoran modal tunai' },
        { accountCode: '3101', debit: 0, credit: 10000000, description: 'Modal pemilik' },
        { accountCode: '1201', debit: invTotal, credit: 0, description: 'Persediaan awal' },
        { accountCode: '3101', debit: 0, credit: invTotal, description: 'Modal pemilik (inventori)' },
      ],
    });
    if (modalJ.success) journalCount++;

    // Piutang journals
    for (const r of receivables) {
      const dueDate = new Date(now);
      dueDate.setDate(dueDate.getDate() + r.dueDays);
      const pj = await accountingEngine.postJournal({
        userId,
        entryDate: dueDate,
        referenceType: 'receivable',
        description: `Piutang ${r.customer}`,
        lines: [
          { accountCode: '1102', debit: r.amount, credit: 0, description: `Piutang ${r.customer}` },
          { accountCode: '4101', debit: 0, credit: r.amount, description: `Penjualan kredit ${r.customer}` },
        ],
      });
      if (pj.success) journalCount++;
    }

    // Hutang journals
    for (const d of debts) {
      const dueDate = new Date(now);
      dueDate.setDate(dueDate.getDate() + d.dueDays);
      const hj = await accountingEngine.postJournal({
        userId,
        entryDate: dueDate,
        referenceType: 'payable',
        description: `Hutang ${d.supplier}`,
        lines: [
          { accountCode: '5101', debit: d.amount, credit: 0, description: `Pembelian dari ${d.supplier}` },
          { accountCode: '2101', debit: 0, credit: d.amount, description: `Hutang dagang ${d.supplier}` },
        ],
      });
      if (hj.success) journalCount++;
    }

    // Closing entry
    const { data: coaRows } = (await supabase
      .from('chart_of_accounts')
      .select('code, type, normal_balance, balance')
      .eq('user_id', userId)
      .eq('is_active', true)) as any;
    const closingLines: any[] = [];
    let totalDebitCl = 0,
      totalCreditCl = 0;
    let netIncome = 0;
    for (const acct of coaRows || []) {
      const bal = Number(acct.balance) || 0;
      if (bal === 0) continue;
      if (acct.type === 'revenue') {
        closingLines.push({ accountCode: acct.code, debit: bal, credit: 0, description: `Penutupan ${acct.name}` });
        totalDebitCl += bal;
        netIncome += bal;
      } else if (acct.type === 'cogs' || acct.type === 'expense') {
        closingLines.push({ accountCode: acct.code, debit: 0, credit: bal, description: `Penutupan ${acct.name}` });
        totalCreditCl += bal;
        netIncome -= bal;
      }
    }
    if (netIncome > 0) {
      closingLines.push({
        accountCode: '3103',
        debit: 0,
        credit: netIncome,
        description: 'Laba bersih ke Laba Ditahan',
      });
      totalCreditCl += netIncome;
    } else if (netIncome < 0) {
      closingLines.push({
        accountCode: '3103',
        debit: Math.abs(netIncome),
        credit: 0,
        description: 'Rugi bersih (dikurangi dari Laba Ditahan)',
      });
      totalDebitCl += Math.abs(netIncome);
    }
    if (closingLines.length > 0 && Math.abs(totalDebitCl - totalCreditCl) < 0.01) {
      const closingJ = await accountingEngine.postJournal({
        userId,
        entryDate: new Date(),
        referenceType: 'closing',
        description: 'Jurnal penutup periode — laba bersih ke Laba Ditahan',
        lines: closingLines,
      });
      if (closingJ.success) journalCount++;
    }

    const baseUrl = process.env.PUBLIC_URL || 'https://tata-suite.up.railway.app';
    return {
      success: true,
      exists: false,
      loginUrl: `${baseUrl}/stock/${slug}?token=${token}`,
      token,
      slug,
      storeName,
      journalCount,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    return { error: err instanceof Error ? err.message : 'Gagal setup demo' };
  } finally {
    client.release();
  }
}
