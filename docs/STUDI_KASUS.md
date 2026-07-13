# Studi Kasus: RumahKain Fashion — Brand Owner Fashion

## Profil Bisnis

**Toko:** RumahKain
**Pemilik:** Sarah (owner + 2 karyawan)
**Produk:** Kemeja Pria, Dress Wanita, Blouse
**Channel:** Offline (butik), Tokopedia, Shopee
**Bahan Baku:** Kain Katun (meter), Kain Sutra (meter), Benang (pcs), Kancing (pcs)
**Modal Awal:** Rp 15.000.000
**Paket:** PRO

---

## Setup Awal via WA

Sarah kirim WA `daftar RumahKain` → sistem buat akun + generate token.
Sarah kirim `dashboard` → dapat link `https://tata.app/rumahkain?token=xxx`.
Buka dashboard → Settings → aktifkan channel: Offline, Tokopedia, Shopee.

---

## Skenario 1: Setup Produk & Resep BOM

### Dashboard — Tambah Produk & Bahan Baku

**Produk:**

| Produk | Harga Beli | Harga Jual | Stok Awal | Satuan | Channels | Default Channel |
|--------|-----------|-----------|-----------|--------|---------|-----------------|
| Kemeja Pria | Rp 75.000 | Rp 150.000 | 50 | pcs | Tokopedia, Shopee, Offline | Tokopedia |
| Dress Wanita | Rp 120.000 | Rp 250.000 | 30 | pcs | Tokopedia, Offline | Offline |
| Blouse | Rp 60.000 | Rp 130.000 | 40 | pcs | Shopee, Tokopedia, Offline | Shopee |

**Bahan Baku (via Dashboard → Bahan Baku):**

| Material | Stok | Satuan | Biaya/satuan |
|----------|------|--------|-------------|
| Kain Katun | 150 | meter | Rp 35.000 |
| Kain Sutra | 80 | meter | Rp 55.000 |
| Benang | 200 | pcs | Rp 2.000 |
| Kancing | 500 | pcs | Rp 500 |

**Resep (BOM) — per produk:**
- **Kemeja Pria**: Kain Katun 1.5m + Benang 2pcs + Kancing 8pcs
- **Dress Wanita**: Kain Sutra 2m + Benang 3pcs
- **Blouse**: Kain Katun 1m + Benang 2pcs + Kancing 4pcs

**Jurnal Awal — Modal & Stok:**
```
Pembelian stok awal 50 Kemeja @Rp75.000 = Rp 3.750.000
Pembelian stok awal 30 Dress @Rp120.000 = Rp 3.600.000
Pembelian stok awal 40 Blouse @Rp60.000 = Rp 3.600.000
Total modal inventori                  = Rp 10.950.000
Sisa kas                               = Rp 4.050.000

Jurnal:
Debit 1201 (Inventori)     Rp 10.950.000
Kredit 3101 (Modal)        Rp 15.000.000
Kredit 1101 (Kas)          Rp  4.050.000
```

---

## Skenario 2: Transaksi via WA — Keluar 2 Kemeja (Multi-Channel Dialog)

### WA Chat — Tahap 1: Input
```
Sarah: "Keluar kemeja 2"
```

### Proses Sistem — `handleStockInOutCommand` di `message.ts:23-75`:

**Step 1 — Parsing:** regex `keluar (kemeja) (2)`
- Qty: 2 pcs

**Step 2 — Cari Produk:**
```sql
SELECT * FROM products WHERE name ILIKE '%kemeja%' AND user_id = 'xxx'
```
✅ Cocok: **Kemeja Pria** (channels = ["Tokopedia", "Shopee", "Offline"], default_channel = "Tokopedia")

**Step 3 — Channel Dialog (karena channels.length > 1):**
```
📤 Sistem set dialog 'keluar_channel' dengan data:
   { productId, productName: "Kemeja Pria", qty: 2, channels: ["Tokopedia", "Shopee", "Offline"] }

📲 Bot reply:
```

### WA Chat — Tahap 2: Dialog Channel
```
⚠️ *Kemeja Pria* punya *3 channel* penjualan.

Pilih channel:

1. Tokopedia
2. Shopee
3. Offline

Balas *angka 1-3* untuk memilih, atau *Batal* untuk membatalkan.
```

### WA Chat — Tahap 3: Pilih Channel
```
Sarah: "1"
```

### Step 4 — Eksekusi (`executeStockAdjustment` → `recordStockAdjustment`):

**A. Lock & Cek Stok**
```sql
SELECT stock_current = 50 FROM products WHERE id = 'prod-1' FOR UPDATE
```
✅ Stok cukup (50 ≥ 2)

**B. Update Stok Produk**
```sql
UPDATE products SET stock_current = 50 - 2 = 48 WHERE id = 'prod-1'
```

**C. Insert Stock Movement**
```sql
INSERT INTO stock_movements (type='out', quantity=2, stock_before=50, stock_after=48,
                             reference_type='manual', channel='Tokopedia')
```

**D. Jurnal Double-Entry (otomatis karena `recordTransaction: true`):**

| Account | Debit | Credit | Keterangan |
|---------|-------|--------|------------|
| 1101 (Kas) | Rp 294.000 | 0 | Penerimaan penjualan (bersih) |
| 6105 (Beban Operasional) | Rp 6.000 | 0 | Beban admin Tokopedia 2% |
| 4101 (Pendapatan Penjualan) | 0 | Rp 300.000 | Penjualan via Tokopedia |
| 5101 (HPP) | Rp 150.000 | 0 | HPP 2×Rp75.000 |
| 1201 (Inventori) | 0 | Rp 150.000 | Pengurangan inventori |

**E. Insert Transaksi (di `transactions` table)**
```sql
INSERT INTO transactions (type='masuk', channel='Tokopedia', amount=300.000,
                          quantity=2, price_sell=150.000, price_buy=75.000,
                          profit=300.000 - (2×75.000) - (2%×300.000) = 144.000,
                          hpp=150.000)
```

**F. Deduksi BOM** (non-blocking, setelah transaksi utama):
```
Resep Kemeja Pria:
- Kain Katun: -1.5m × 2 = -3m → sisa 147m
- Benang: -2pcs × 2 = -4pcs → sisa 196pcs
- Kancing: -8pcs × 2 = -16pcs → sisa 484pcs
```

### Step 5 — Balasan WA (dari `executeStockAdjustment`):
```
✅ *Terjual* Kemeja Pria

50 pcs → 48 pcs

📦 *Bahan terpakai*:
• Kain Katun: -3 meter
• Benang: -4 pcs
• Kancing: -16 pcs
```

### Verifikasi di Dashboard

- **Omzet hari ini:** Rp 300.000
- **Kas:** Rp 4.344.000 (4.050.000 + 294.000)
- **Kemeja Pria:** stok 48 pcs
- **Kain Katun:** 147m, **Benang:** 196 pcs, **Kancing:** 484 pcs

Dashboard → `/stock/keuangan` (tab Ringkasan):
```
Laba Rugi:

  Revenue: Rp 300.000 (2 kemeja × Rp 150.000)
  HPP:    (Rp 150.000) (2 × Rp 75.000)
  Biaya Admin: (Rp 6.000) (2% Tokopedia)
  Laba Bersih: Rp 144.000
```

---

## Skenario 3: Transaksi via Dashboard — Stok Masuk (Restock)

### Flow Dashboard

1. Buka `/stock/movement` atau klik FAB
2. Pilih "Stok Masuk"
3. Pilih produk "Kemeja Pria", jumlah: 20
4. Catatan: "Restock dari supplier"
5. Klik "Catat Pergerakan Stok"

**Proses backend:**
```
POST /api/stock/movement
→ stockManager.recordMovement(userId, { product_id, type:'in', quantity:20 })
   → UPDATE products SET stock_current = 48 + 20 = 68
   → INSERT stock_movements (type='in', quantity=20, stock_before=48, stock_after=68)

Jurnal:
Debit 1201 (Inventori)     Rp 1.500.000
Kredit 3101 (Modal)        Rp 1.500.000
```

WA juga bisa: `masuk kemeja 20` → sama hasilnya.

---

## Skenario 4: Pengeluaran via WA — Bayar Gaji Karyawan

```
Sarah: "gaji 1.500.000"
```

**Proses:** regex `/^gaji\s+/i` → matched di `BEBAN_REGEX_MAP`

```
POST /api/stock/pembukuan → recordPembukuan(type='beban_gaji', amount=1.500.000)

Jurnal:
Debit 6101 (Beban Gaji)    Rp 1.500.000
Kredit 1101 (Kas)          Rp 1.500.000
```

WA balas:
```
✅ Gaji karyawan Rp 1.500.000 tercatat!
💳 Sisa kas: Rp 2.844.000
```

---

## Skenario 5: Undo Transaksi — Membatalkan Transaksi yang Salah

### Latar Belakang

Sarah sadar 2 Kemeja keluar ke Tokopedia hari ini seharusnya **1 pcs** (bukan 2). Dia undo transaksinya.

### WA Chat
```
Sarah: "undo"
```

**Proses:**
1. Sistem cari transaksi terakhir Sarah → `transactions` DESC limit 1
2. Dialog konfirmasi:

```
⚠️ Batalkan transaksi terakhir?

💵 Rp 300.000 — Penjualan 2 pcs: Kemeja Pria [mov:xxx]
📅 Baru saja

Balas *Ya* untuk membatalkan atau *Batal*.
```

3. Sarah: `"Ya"`

4. Sistem panggil `reverseTransaction(sender, transactionId)`:
   - Balik stok: Kemeja Pria 48 → 50
   - Hapus jurnal (insert jurnal reversal)
   - Tandai transaksi asli sebagai `voided`

5. WA balas:
```
✅ *Transaksi Berhasil Dibatalkan!*

📄 Penjualan 2 pcs: Kemeja Pria [mov:xxx]
💵 Rp 300.000
📦 Kemeja Pria

Stok dikembalikan.
```

### Verifikasi
- **Kemeja Pria:** stok kembali 50 pcs
- **Kas:** kembali Rp 4.050.000
- **Kain Katun:** kembali 150m (BOM juga di-reverse)

---

## Skenario 6: Retur — Pelanggan Komplain

### WA — Retur Barang
```
Sarah: "retur kemeja 1 rusak"
```

**Proses:**
1. Gemini klasifikasi intent → `retur_jual`
2. Dialog: "Retur penjualan 1 Kemeja Pria, alasan: rusak. Lanjut? (iya/tidak)"
3. Sarah: "iya"
4. Sistem panggil `recordSalesReturn`:
   - Balik stok: Kemeja Pria 50 → 51
   - Insert retur transaction
   - Jurnal retur:

   | Account | Debit | Credit |
   |---------|-------|--------|
   | 4102 (Retur Penjualan) | Rp 150.000 | 0 |
   | 1101 (Kas) | 0 | Rp 150.000 |
   | 1201 (Inventori) | Rp 75.000 | 0 |
   | 5101 (HPP) | 0 | Rp 75.000 |

5. WA balas:
```
✅ *Retur Penjualan Berhasil!*

📦 Produk : Kemeja Pria x 1
💵 Nilai : Rp 150.000
📝 Alasan : rusak
```

---

## Skenario 7: Cek Bisnis via WA — Pagi Hari

### WA Commands & Response

```
Sarah: "rekap"
```

```
📊 Rekap Bisnis — RumahKain
📅 7 hari terakhir

💰 Omzet: Rp 2.450.000
📥 Transaksi: 12 pemasukan
💳 Kas: Rp 4.320.000

📦 Stok Menipis: —
🔴 Stok Habis: —

⭐ Produk Terlaris:
1. Kemeja Pria: 8 terjual
2. Blouse: 3 terjual
3. Dress Wanita: 1 terjual

Ketik *Laporan* untuk detail lengkap.
```

```
Sarah: "stock list"
```

```
📦 Daftar Produk — RumahKain

1. Kemeja Pria
   SKU: KEMEJA-01 | 68 pcs
   Jual: Rp 150.000

2. Dress Wanita
   SKU: DRESS-01 | 30 pcs
   Jual: Rp 250.000

3. Blouse
   SKU: BLOUSE-01 | 39 pcs
   Jual: Rp 130.000

Ketik *Stock info [SKU]* untuk detail produk.
Ketik *Dashboard* untuk kelola stok via web.
```

```
Sarah: "bahan list"
```

```
📦 Bahan Baku — RumahKain

• Kain Katun: 146 meter
• Kain Sutra: 80 meter
• Benang: 194 pcs
• Kancing: 484 pcs

Ketik *Bahan masuk [nama] [jumlah]* untuk restock.
```

---

## Skenario 8: Dashboard — Laporan Keuangan Akhir Bulan

### `/stock/keuangan` — Tab Ringkasan (Laba Rugi)

```
Laba Rugi — Juli 2026
═══════════════════════

PENDAPATAN
  Penjualan Offline      Rp  8.500.000
  Penjualan Tokopedia    Rp  5.200.000
  Penjualan Shopee       Rp  3.100.000
  Retur Penjualan       (Rp   450.000)
  ─────────────────────────────────
  Total Pendapatan       Rp 16.350.000

HARGA POKOK PENJUALAN
  HPP Offline           (Rp  3.800.000)
  HPP Tokopedia         (Rp  2.600.000)
  HPP Shopee            (Rp  1.550.000)
  ─────────────────────────────────
  Total HPP             (Rp  7.950.000)

LABA KOTOR              Rp  8.400.000

BEBAN USAHA
  Gaji Karyawan         (Rp  3.000.000)
  Sewa Tempat           (Rp  1.500.000)
  Listrik & Air          (Rp   350.000)
  Transport              (Rp   200.000)
  Admin Fee Marketplace  (Rp   165.000)
  Operasional            (Rp   400.000)
  ─────────────────────────────────
  Total Beban           (Rp  5.615.000)

LABA BERSIH             Rp  2.785.000
```

### `/stock/keuangan` — Channel Profitability

```
Profitability per Channel
══════════════════════════

Offline:     Omzet Rp 8.5jt | HPP Rp 3.8jt | Laba Rp 4.7jt | Margin 55%
Tokopedia:   Omzet Rp 5.2jt | HPP Rp 2.6jt | Laba Rp 2.6jt | Margin 50%
Shopee:      Omzet Rp 3.1jt | HPP Rp 1.5jt | Laba Rp 1.6jt | Margin 52%

💡 Offline paling menguntungkan (tanpa admin fee)!
```

### `/stock/keuangan` — Neraca

```
NERACA — 31 Juli 2026

ASET
  Kas                      Rp  8.350.000
  Piutang Dagang           Rp    500.000
  Inventori (Barang)       Rp  5.800.000
  ─────────────────────────────────
  Total Aset               Rp 14.650.000

KEWAJIBAN
  Hutang Dagang            Rp        0
  ─────────────────────────────────
  Total Kewajiban          Rp        0

MODAL
  Modal Awal               Rp 15.000.000
  Laba Ditahan             Rp  2.785.000
  Prive (Pribadi)         (Rp  3.000.000)
  ─────────────────────────────────
  Total Modal              Rp 14.785.000

PASIVA (Kewajiban + Modal) Rp 14.785.000
```

---

## Skenario 9: Dashboard — Analisis Produk & Stok

### `/stock/batch`

```
Ringkasan Data
═══════════════
Total Produk:      3
Total Stok:        137 pcs
Nilai Inventori:   Rp 6.450.000
Stok Menipis:      0
Stok Habis:        0

Produk Termahal:   Dress Wanita (Rp 250.000)
Produk Terlaris:   Kemeja Pria (10 terjual)
```

### `/stock/product-stats`

```
Statistik Produk
════════════════

Kemeja Pria     | Harga: Rp 150.000 | Margin: 50%  | Terjual: 10 | Revenue: Rp 1.500.000
Dress Wanita    | Harga: Rp 250.000 | Margin: 52%  | Terjual: 3  | Revenue: Rp 750.000
Blouse          | Harga: Rp 130.000 | Margin: 54%  | Terjual: 4  | Revenue: Rp 520.000

💡 Kemeja Pria kontribusi 54% revenue — produk unggulan!
```

### `/stock/report`

```
Ekspor → Download Excel:
- Laporan Laba Rugi.xlsx
- Laporan Neraca.xlsx
- Laporan Arus Kas.xlsx
- Daftar Produk.xlsx
```

---

## Skenario 10: Opname Stok (Akhir Bulan)

### Dashboard → `/stock/opname`

Sarah buka Opname, sistem tampilkan stok sistem:
- Kemeja Pria: 68 (sistem: 70) → **hasil fisik: -2**
- Dress Wanita: 30 (sistem: 30) → ✅ cocok
- Blouse: 39 (sistem: 40) → **hasil fisik: -1**

Koreksi otomatis:
```
Penyesuaian Kemeja Pria: -2 pcs (sistem 70, fisik 68)
Penyesuaian Blouse: -1 pcs (sistem 40, fisik 39)

Jurnal Koreksi:
Debit 5101 (HPP)         Rp 150.000 + Rp 60.000 = Rp 210.000
Kredit 1201 (Inventori)  Rp 210.000
```

---

## Skenario 11: Fitur Lanjutan via WA

### Cek Piutang
```
Sarah: "cek piutang"
```

```
📋 *Daftar Piutang*

1. Bu Maya        | Rp 500.000 | Jatuh tempo: 3 hari lagi ⚠️
2. Toko Sri       | Rp 200.000 | Jatuh tempo: 10 hari lagi
3. Pak Budi       | Rp 150.000 | Jatuh tempo: 2 hari lagi ⚠️

Total Piutang: Rp 850.000
```

### Bahan Keluar Manual
```
Sarah: "bahan keluar kain katun 5"
```

Sistem panggil `handleBahanKeluar` di `stock-handler.ts:164`:

```
✅ *Bahan Keluar* Kain Katun

150 meter → 145 meter
```

### Laporan Laba Rugi via WA
```
Sarah: "laba rugi"
```

```
📊 *Laba Rugi — RumahKain*
📅 Hari ini

💰 Pendapatan: Rp 0
📦 HPP: Rp 0
💼 Laba Kotor: Rp 0
📉 Beban: Rp 0
✅ *Laba Bersih: Rp 0*

💡 Ketik *Laporan* untuk rekap 7 hari.
```

---

## Ringkasan Dampak Tata Business Suite

### Sebelum Pakai Tata (Manual)

| Aktivitas | Cara Lama | Waktu | Masalah |
|-----------|-----------|-------|---------|
| Catat penjualan | Buku nota + kalkulator | 5 menit/transaksi | Sering lupa, salah hitung |
| Stok barang | Cek fisik lemari | 30 menit/hari | Kehabisan stok tanpa tahu |
| Hitung laba | Akhir bulan + Excel | 1 hari | Salah, tidak akurat |
| Rekap per channel | Manual pisah-pisah | 2 jam | Tidak tahu channel mana yang untung |
| Cek hutang/piutang | Tanya ke pembukuan | 15 menit | Sering telat tagih |
| Bahan baku habis | Baru tahu pas produksi | — | Produksi terhambat |
| Laporan keuangan | Minta ke akuntan | Rp 500rb/bln | Keluar biaya tambahan |

### Sesudah Pakai Tata (Real-time)

| Aktivitas | Cara Baru | Waktu | Dampak |
|-----------|-----------|-------|--------|
| Catat penjualan | WA: "Keluar kemeja 2" → dialog pilih channel | 10 detik | Otomatis kurangi stok + catat keuangan + deduksi BOM |
| Cek stok | WA: "stok kemeja" | 2 detik | Langsung tahu sisa + peringatan jika mau habis |
| Cek laba | Dashboard `/stock/keuangan` | 10 detik | Laba kotor, laba bersih, per channel real-time |
| Channel profit | Dashboard automatic | Real-time | Tahu Tokopedia lebih untung daripada Shopee |
| Hutang/piutang | WA: "cek hutang" / "terima piutang 500rb" | 5 detik | Tidak ada yang terlewat |
| Restok bahan | WA: "bahan masuk kain 50" | 5 detik | Stok bahan selalu update |
| Opname stok | Dashboard → scan barcode | 10 menit | Deteksi selisih, koreksi otomatis |
| Laporan P&L | Generate otomatis | Real-time | Tanpa biaya akuntan |
| Undo transaksi | WA: "undo" | 5 detik | Batalkan transaksi salah + balikin stok |
| Laporan Laba Rugi | WA: "laba rugi" | 2 detik | Cek laba hari ini tanpa buka dashboard |

### Dampak Finansial (Estimasi Bulanan)

| Item | Manual | Pakai Tata | Hemat |
|------|--------|-----------|-------|
| Waktu catat transaksi | 25 jam | 2 jam | 23 jam |
| Kesalahan stok | Rp 500.000 (selisih) | Rp 0 (terkontrol) | Rp 500.000 |
| Biaya akuntan | Rp 500.000 | Rp 0 (auto) | Rp 500.000 |
| Kehilangan penjualan (stok habis) | Rp 1.000.000 | Rp 200.000 (notifikasi) | Rp 800.000 |
| Keterlambatan tagih piutang | Rp 500.000 | Rp 100.000 (terpantau) | Rp 400.000 |
| **Total** | **Rp 2.500.000 + 25 jam** | **Rp 300.000 + 2 jam** | **Rp 2.200.000 + 23 jam** |

---

## Arsitektur Ujung ke Ujung (Ringkasan Teknis)

```
┌──────────────┐     ┌─────────────────┐     ┌──────────────────┐
│  WhatsApp     │────▶│  message.ts      │────▶│  stockManager     │
│  Pengguna     │     │  (orchestrator)  │     │  .searchProduct   │
└──────────────┘     │  + stock-handler  │     └────────┬─────────┘
                     │  + dialog-state   │              │
                     └─────────────────┘              ▼
┌──────────────┐     ┌─────────────────┐     ┌──────────────────┐
│  Browser      │────▶│  api.ts          │────▶│  transaction      │
│  Dashboard    │     │  (REST routes)   │     │  Recorder         │
└──────────────┘     └─────────────────┘     │  .recordStockAdj  │
                     ┌───────────────┐        └────────┬─────────┘
                     │  circuit-     │                 │
                     │  breaker.ts   │        ┌────────▼─────────┐
                     └───────────────┘        │  accounting       │
                                              │  Engine           │
                     ┌───────────────┐        │  .insertJournal   │
                     │  validate.ts  │        └────────┬─────────┘
                     │  (Zod schema) │                 │
                     └───────────────┘                 ▼
                                              ┌──────────────────┐
                                              │  PostgreSQL       │
                                              │  (via pgPool      │
                                              │   + Supabase)     │
                                              └──────────────────┘
```

### Alur Data Satu Transaksi "Keluar kemeja 2" → pilih channel "Tokopedia":

```
1. WA Message: "Keluar kemeja 2"
   ↓
2. message.ts: regex parse → product="kemeja", qty=2, type='out'
   ↓
3. handleStockInOutCommand
   → stockManager.searchProductByName("kemeja") → Kemeja Pria
   → channels = ["Tokopedia", "Shopee", "Offline"]
   → channels.length > 1 → setDialog('keluar_channel', { productId, qty, channels })
   → reply "Pilih channel 1-3"
   ↓
4. User reply: "1"
   → dialog handler keluar_channel → channel = "Tokopedia"
   ↓
5. executeStockAdjustment → recordStockAdjustment (dalam DB transaction)
   ├── SELECT product FOR UPDATE → cek stok
   ├── UPDATE products SET stock_current = 48
   ├── INSERT stock_movements (out, 2 pcs)
   ├── resolveChannel("Tokopedia") → { coaCode: '4101', adminFeePct: 2% }
   ├── INSERT jurnal (5 baris: Kas, Beban Admin, Penjualan, HPP, Inventori)
   ├── INSERT transactions (masuk, amount=300.000, profit=144.000)
   └── [jika ada hutang/piutang] → INSERT receivables
   ↓
6. deductPackaging (non-blocking, setelah transaksi)
   ├── getResep → { Kain Katun: 1.5m, Benang: 2pcs, Kancing: 8pcs }
   ├── UPDATE bom_materials SET stock_current -= 3, -= 4, -= 16
   └── INSERT bom_deduction_logs
   ↓
7. Balasan WA:
   "✅ *Terjual* Kemeja Pria
    50 pcs → 48 pcs
    📦 *Bahan terpakai*:
    • Kain Katun: -3 meter
    • Benang: -4 pcs
    • Kancing: -16 pcs"
   ↓
8. Dashboard real-time update (socket.io):
   ├── Overview → kas, omzet update
   ├── Products → stok 48
   ├── Materials → Kain 147m
   ├── Laba Rugi → +Rp 300.000 revenue
   └── Channel Profitability → Tokopedia +Rp 294.000
```

---

> Dari satu pesan WA `"Keluar kemeja 2"` dilanjut `"1"` (pilih channel), sistem mencatat **8 hal sekaligus**: transaksi, stok, jurnal akuntansi, BOM deduction, channel profitability, laba rugi, rekap dashboard, dan notifikasi real-time. Semua tanpa perlu buka laptop atau aplikasi.
