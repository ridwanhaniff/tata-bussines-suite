# AGENTS.md — Instruksi Wajib untuk Agent OpenCode

File ini dibaca otomatis setiap sesi. Instruksi di sini mengikat; jika bentrok dengan permintaan sesaat dari chat, **tanya dulu** ke user.

---

## 0. KENAPA FILE INI ADA

Pola kegagalan berulang: agent memperbaiki bug A, menyentuh kode sekitar tanpa sadar, bug B (pernah diperbaiki) muncul lagi. Agent sendiri yang harus menjaga kualitas secara sistematis, bukan mengandalkan ingatan.

---

## 1. ATURAN ANTI-HALUSINASI

1. **Baca dulu, klaim kemudian.** Sebelum menyebut "bug" atau "sudah benar", `grep`/`view` file & kutip baris persis.
2. **Kutip kode, jangan parafrase.** Jangan menebak nama fungsi/variabel — cari dulu atau akui "tidak ditemukan".
3. **STOP jika deskripsi tidak cocok.** Laporan bilang X di baris Y tapi tidak ada di sana? STOP & laporkan ketidakcocokan, jangan pindah diam-diam.
4. **Jangan mengarang API/library tanpa verifikasi.** Kalau tidak 100% yakin, tandai "belum diverifikasi".
5. **Laporan akhir = diff nyata, bukan ringkasan.** Bagian tidak selesai/blocked tulis apa adanya.

---

## 2. PROTOKOL ANTI-REGRESI

### Sebelum perubahan
- `git status` + `git diff` — catat kondisi working tree sebelum mulai.
- Jalankan test/typecheck baseline (`npm test`, `npm run typecheck`).

### Ruang lingkup
- **Satu masalah, satu perbaikan.** Jangan "sekaligus bersih-bersih" kode B, C, D yang tidak diminta. Sebut sebagai catatan saja.
- **Jangan ubah file yang tidak perlu.** Jangan sentuh signature fungsi multi-pemakai tanpa `grep` SEMUA pemanggil.

### Setelah perubahan
- Jalankan ulang test/typecheck — **baseline pass, sekarang fail = regresi, WAJIB diperbaiki.**
- Grep area berdekatan (fungsi/file yang sama) — pastikan tidak ada pemanggil yang rusak.
- Kalau menyentuh area yang pernah diperbaiki (lihat Bagian 6), verifikasi fix lama masih utuh.
- Kalau ragu perubahan berisiko, sebut di laporan sebagai "area perlu diverifikasi manual".

### Error baru di luar tugas
- JANGAN perbaiki dalam commit yang sama. Laporkan terpisah, biarkan user putuskan.

---

## 3. CRITICAL THINKING

1. **Cari root cause, bukan gejala.** `X undefined` → telusuri KENAPA, jangan cuma tambah if-check.
2. **Bedakan hipotesis vs fakta.** Tandai yang belum terbukti, sebut cara memverifikasinya.
3. **Pertimbangkan >1 penyebab** untuk bug intermiten (race condition, resource limit, dependency eksternal).
4. **Usulkan eksperimen murah & reversible** sebelum perubahan besar kalau ada beberapa kandidat penyebab.

---

## 4. STANDAR KODE

- Ikuti gaya yang sudah ada — jangan impor paradigma baru.
- Error handling: semua async try-catch dengan log actionable, jangan biarkan promise rejection tak tertangani.
- Fungsi kecil, satu tanggung jawab.
- Nama konsisten: Istilah Indonesia untuk domain bisnis ("hutang", "masuk", "keluar"), Inggris untuk infrastruktur — jangan diterjemahkan paksa.
- Magic number/string → taruh di `src/config/constants.ts`.
- Coment untuk "kenapa", bukan "apa".

## 5. STANDAR UI/UX

- Ikuti design system yang ada (`src/frontend/src/index.css`, CSS variables, breakpoint 768px).
- **Mobile-first** — target user akses dari HP 5"-6" dengan koneksi terbatas. Cek di viewport sempit.
- Setiap state: loading, empty, error, success — jangan biarkan halaman blank/diam.
- Pesan error end-user = bahasa manusia, bukan stack trace.
- Tombol/dialog konsisten dengan halaman lain.
- Aksesibilitas: kontras cukup, target tap ~44px, label input.

---

## 6. REGISTRY BUG YANG SUDAH DIPERBAIKI (CEK SEBELUM SENTUH AREA INI)

| # | Area | Fix | Verifikasi |
|---|------|-----|------------|
| 1 | `src/jobs/scheduler.ts` — client WA | Scheduler pakai `getClient()`, bukan closure statis — hindari reference basi | `grep "getClient()" src/jobs/scheduler.ts` harus ada |
| 2 | Dialog WA (`src/services/dialog-state.service.ts`) | Unified store `getDialog`/`setDialog`/`clearAllDialogs`, TTL 5 menit | Pastikan "Batal" panggil `clearAllDialogs(sender)` |
| 3 | `shouldBypassDialogs` (`src/handlers/message.ts`) | Semua keyword pakai regex `\b...\b` konsisten | Grep fungsi, pastikan tidak ada yg balik ke `===`/`.includes()` |
| 4 | Puppeteer args (`src/services/whatsapp.ts`) | `--disable-dev-shm-usage` harus tetap ada | Jangan hapus walau sedang eksperimen |
| 5 | `/data` storage (`src/index.ts:112-155`) | Startup check log mount type — jangan simpulkan "aman" tanpa bukti | Log startup ada `[STORAGE] /data mount info: ...` |
| 6 | Klasifikasi transaksi (`src/config/keywords.ts` + `message.ts`) | **[BELUM SELESAI]** Frasa multi-kata harus word-boundary regex terhadap `body` penuh | `"transfer masuk 100rb"` → `'masuk'` |
| 7 | Session store (`src/config/session.ts:82`) | `schemaName: 'public'` di PgBouncer pool | Log startup TIDAK ada error `no schema has been selected` |
| 8 | `sendUpgradeNotification` (`src/jobs/scheduler.ts`) | **FIXED** Tambah `state.clientReady` guard setelah null-check + error log `err.message` → `err.stack` | `scheduler.ts:136-137` ada `state.clientReady` guard; `scheduler.ts:149` pakai `err.stack` |
| 9 | BOM/Packaging — fitur baru | Implementasi lengkap: 3 tabel DB + 5 fungsi backend + 8 API endpoint + halaman Materials CRUD + resep di modal produk + WA command + pgPool fallback | Cek `src/routes/api.ts` ada 8 route `materials`; `src/frontend/src/pages/stock/StockMaterials.tsx` ada; sidebar ada menu "Bahan Baku" |
| 10 | `POST /api/stock/movement 400` — adjustment type | Schema `movementSchema.type` hanya `'in'\|'out'`, tapi UI kirim `'adjustment'`. Fix: tambah `'adjustment'` ke enum + sesuaikan `recordStockAdjustment` | `src/routes/schemas.ts:54` enum include `'adjustment'`; `src/utils/transactionRecorder.ts:694` type include `'adjustment'` |
| 11 | `POST /api/stock/pembukuan 400` — amount parsing | `Number(form.amount)` dari RupiahInput bisa jadi `NaN`. Fix: client-side validasi + parse pakai `replace(/[^0-9,-]/g, '')` | `StockFinance.tsx:save()` parse amount sebelum kirim |
| 12 | FilterDate/Channel di Riwayat Stok | `StockHistory.tsx` + `GET /api/stock/movements` belum punya filter date/channel. Fix: tambah `FilterBar` + query params `channel`, `start_date`, `end_date` | `StockHistory.tsx` pake `FilterBar`; `api.ts:1408-1412` tambah filter query |
| 13 | Catatan tidak auto-populate | `StockMovement.tsx` — note field manual. Fix: `useEffect` set default "Stok masuk/keluar" berdasarkan type | `StockMovement.tsx` ada `useEffect` depend `form.type` + `noteTouched` guard |
| 14 | Notifikasi double (multi-tab) | Setiap tab socket terima `stock_alert` dan tampilkan toast sendiri. Fix: dedup via `shownAlertIds` Set + reconnect handler `socket.on('connect')` | `StockLayout.tsx` ada `shownAlertIds` ref + registerUser callback |
| 15 | Loading state hilang di Finance | `StockFinance.tsx` `save()` tidak punya `saving` state. Fix: tambah `saving` + `disabled` + "Menyimpan..." + `finally` | `StockFinance.tsx` `save()` ada `setSaving` + disabled button |
| 16 | StockOpname `finally` | `setSaving(false)` tidak di `finally` — bisa stuck. Fix: bungkus loop dalam `try/finally` | `StockOpname.tsx:100-121` ada `try { ... } finally { setSaving(false); }` |
| 17 | StockLayout blank page — `useLocation` | Dead code `const location = useLocation()` masih ada setelah `useLocation` dihapus dari import (regresi hapus subnav) | `StockLayout.tsx` tidak lagi import `useLocation` atau panggil `useLocation()` |
| 18 | Sidebar dihapus total | Tidak dipakai setelah UI refactor — navigasi via bottom bar + Settings di topbar | `StockSidebar.tsx` di-delete; semua CSS sidebar dihapus |

| 19 | Chatbot dihapus total | Frontend (ChatbotWidget.tsx + CSS + zIndex) + backend (route /api/stock/chat + chatbot.ts) dihapus karena tidak terpakai. Tombol Bantuan/Settings di topbar juga dihapus (sudah ada di dropdown UserMenu); topbar diperbesar + shadow | ChatbotWidget.tsx & chatbot.ts tidak ada; StockLayout.tsx tidak import/ render ChatbotWidget; api.ts tidak ada route chat |
| 20 | Topbar — shadow + gedein | `.stock-topbar` padding 0.625→0.75rem, `box-shadow` ditambah, `--topbar-height: 56px`, logo 22→28px, brand 1rem→1.15rem | `.stock-topbar` di index.css punya `box-shadow` |
| 21 | Regresi — `Settings is not defined` | Hapus `Settings` dari import padahal masih dipakai di `BOTTOM_NAV_DEMO` baris 41. Fix: tambah `Settings` kembali ke import. | `grep "Settings" StockLayout.tsx` harus ada di import + di `BOTTOM_NAV_DEMO` |
| 22 | Produk terlaris duplikat — `api.ts:2704` | Query `transactions.description` 4-kata-pertama → `product_id` + `products!inner(name)`, GROUP BY `products.name` | `api.ts:2707-2715` pake `product_id` & `products.name` |
| 23 | UNIQUE `users.store_name` | WA register (`message.ts:549`) cek duplikasi + rename append random. Auto-migration `uq_users_store_name` di `src/index.ts` | `message.ts:551-555` ada check + rename |
| 24 | PWA beforeinstallprompt | StockLayout.tsx listener simpan ke `window.__tbsDeferredPrompt` (StockSettings.tsx sudah punya listener sendiri) | StockLayout.tsx ada `beforeinstallprompt` effect |
| 25 | `Database is not defined` — regresi | `StockLayout.tsx` pakai icon `Database` di nav `/stock/batch` tapi tidak di-import dari `lucide-react`. Fix: tambah `Database` ke import. | `StockLayout.tsx:8-11` ada `Database` di import |
| 26 | Tab Keuangan teks hilang saat aktif | Inline `background: 'none'` override `.sn-item.active` (`background: var(--primary)`). Fix: hapus `background: 'none'` dari keempat button tab. | `StockFinance.tsx:73-94` tidak ada `background: 'none'` di inline style |
| 27 | StockHutang.tsx spam-click Simpan | Tidak punya `saving` state → spam-klik bikin duplikat. Fix: tambah `saving` guard + `finally` + `disabled` button | `StockHutang.tsx` ada `saving` state, guard, `finally`, `disabled` |
| 28 | ProductsPage.tsx spam-click Simpan + default_channel null | Sama seperti #27, ditambah `default_channel: ''` dikirim sebagai string kosong bukan `undefined`/`null`. Backend `stockManager.ts:96` & `api.ts:997` juga ganti `null` jadi `''`. | `ProductsPage.tsx` ada `saving` state + `default_channel: ''`; `stockManager.ts:96` & `api.ts:997` pakai `''` bukan `null` |
| 29 | StockCategories.tsx + Materials.tsx — no saving state | Form kategori & material tidak punya saving state → spam-klik bikin duplikat. Fix: tambah `saving` + `deleting` state, guard, finally, disabled button, loading ConfirmModal. | `StockCategories.tsx` & `StockMaterials.tsx` ada `saving`, `deleting`, guard, `finally`, `disabled` |
| 30 | Partial saving guard — 10 file kurang `|| saving` | StockReturn, StockPurchaseReturn, StockMovement, StockOpname, StockSettings, StockLogin, ReturnModal, PurchaseReturnModal, MovementModal, OpnameModal — guard hanya `if (!token)` tanpa `\|\| saving`. Fix: tambah `\|\| saving`/`\|\| savingChannels`/`\|\| submitting`. | Masing-masing file punya `if (... \|\| saving) return` di save function |
| 31 | 24 endpoint API bocor error message mentah | `src/routes/api.ts` — 20 catch + 3 if(error) + 1 if(error) alert pakai `e.message`/`error.message` langsung. Fix: ganti semua dengan `sanitizeError(e)`/`sanitizeError(error)`. | `grep "apiError.*\.message" src/routes/api.ts` harus 0 hasil |
| 32 | recipeUpsertSchema type mismatch (string→bigint) → 400 + sanitasi massal | `schemas.ts` material_id/product_id pakai `z.string()` tapi kolom DB `bigint`. Fix: ganti `z.coerce.number()`. Ditambah sanitasi `err.message` di stockManager.ts (39), transactionRecorder.ts (10), accountingEngine.ts (5), api.ts (24 if(!result.success)). Juga tambah menu Dashboard & Token baru di bantuan WA. | `grep "error: (err\|e\|pgErr)\.message" src/utils/` hanya mediaProcessor (log, aman); menu bantuan mention Dashboard & Token baru |
| 33 | Input fee channel 0 tidak bisa dihapus | `StockSettings.tsx:232` — controlled input `value={getChannelFee(ch.name)}` return 0, `Number('')` = 0, user tak bisa hapus. Fix: track raw string di `feeRaw` state, parse di `onBlur`. | `StockSettings.tsx` ada `feeRaw` state + `onBlur` handler |
| 34 | Tombol Install PWA tidak muncul (race condition) | `StockSettings.tsx:45-62` — `beforeinstallprompt` cuma fire sekali. StockLayout simpan ke `window.__tbsDeferredPrompt` tapi Settings tidak baca. Fix: tambah pengecekan `__tbsDeferredPrompt` di mount. | `StockSettings.tsx` useEffect cek `window.__tbsDeferredPrompt` |
| 35 | Hapus Kategori (redesign wizard 3-step) | Hapus `StockCategories.tsx`, route CRUD categories di api.ts, seeding product_categories di demoSetup.ts, nav & bantuan. Rewrite `ProductsPage.tsx` → auto-category via `CATEGORY_KEYWORDS`, wizard 3-step (Informasi → Stok Awal → BOM), multi-material BOM saat create, stock_initial. | `StockCategories.tsx` tidak ada; `api.ts` tidak ada route `/api/stock/categories`; `ProductsPage.tsx` pakai wizard + `detectCategory()` |
| 36 | Typo tolerance + menu "1" misinterpreted | `fuzzyMatchKeywords()` di `helpers.ts` — Levenshtein distance untuk semua keyword list. Reorder menu angka `1`-`4` SEBELUM `handleTransaction()` biar "1" tidak terdeteksi sebagai nominal Rp 1. Fuzzy fallback di `shouldBypassDialogs`, `wordBoundaryInSet`, KW_DASHBOARD/STATUS/LAPORAN/BANTUAN/UPGRADE/BATAL/BAHAN. | `fuzzyMatchKeywords` di-import & digunakan di message.ts; menu angka cek `if (/^[1-4]$/)` sebelum `handleTransaction` |
| 37 | Gambar produk client-side compress + upload | Client-side: canvas max 800px JPEG q70. Backend: base64 decode → Supabase Storage bucket `product-images`. Inline validation: field errors per-field + asterisk merah. | `ProductsPage.tsx` ada `handleImageSelect` + `validateBase()`; `api.ts` ada `POST /api/stock/products/:id/image`; `index.ts` auto-migration `image_url` + bucket setup |
| 38 | WA connect tapi tidak merespon — silent failure | 4 fix: (1) `safeReply` catch kosong → log error. (2) `withSenderLock` tanpa timeout → tambah `Promise.race` 30s. (3) Entry guard silent → `addLog('debug')`. (4) Handler error `err.message` → `err.stack`. | `message-state.ts` safeReply ada log + withSenderLock ada timeout; `message.ts` entry guard ada addLog; `whatsapp.ts:177` pakai `err.stack` |
| 39 | WA scan QR tapi tidak konek (watchdog timeout + page crash) | (1) Watchdog 60s→180s + no-destroy (extend 2x sebelum restart browser). (2) `WA_BASE_DELAY` 5s→30s. (3) Puppeteer page crash guard di ready → set `clientReady=false`. | `whatsapp.ts` watchdog 180s + watchdogCheck recursive + pupPage crash listener; `constants.ts` WA_BASE_DELAY=30000 |
| 40 | GET /api/stock/saldo 500 tanpa fallback | Supabase `.single()` bisa throw (no rows / permission), langsung 500. Fix: `.maybeSingle()` + try-catch pgPool fallback jika Supabase gagal. | `api.ts:2012-2035` pake maybeSingle + nested try-catch pgPool |
| 41 | "Perlu Perhatian" inline alerts pindah ke NotificationBell | Hapus `alerts` state/effect/interface + `hutangQuery` dari StockOverview.tsx; tambah fetching overview + hutang di NotificationBell.tsx tampilkan overview alerts bersamaan stock alerts. | StockOverview.tsx hapus `alerts`; NotificationBell.tsx ada `fetchOverviewAlerts`; `index.css` add `.notif-divider` |
| 42 | Hapus Jual command + gap features (piutang, bahan keluar, undo, laba rugi) | (1) Hapus `'jual'` dari KW_MASUK, hapus regex saleMatch + handleSaleCommand/processSaleExecution, `Keluar` pakai `recordTransaction: true`. (2) Cek Piutang via WA (copy dari hutang). (3) Bahan Keluar via `handleBahanKeluar`. (4) Undo via `reverseTransaction` + dialog `undo_confirmation`. (5) Laporan Laba Rugi via query transaksi hari ini. Update onboarding + help text + geminiRouter examples. | `keywords.ts` hapus 'jual'; `message.ts` hapus sale functions + tambah piutang/bahan_keluar/undo/laba_rugi; `stock-handler.ts` tambah `handleBahanKeluar`; `dialog-state.service.ts` tambah `undo_confirmation`; `transactionRecorder.ts` tambah `reverseTransaction`; `stockManager.ts` hapus `executeSale`; `onboarding.ts` hapus jual simulasi |
| 43 | 413 Content Too Large — image upload produk | `express.json()` tanpa limit (default 100kb) → base64 data URL 200-500kb ditolak. Fix: `limit: '5mb'` + error handler JSON. Juga turunkan kompresi 1200px→800px, q0.85→q0.7, tambah validasi size. | `app.ts:25-26` ada `limit: '5mb'`; `app.ts:32-39` ada error handler 413; `ProductsPage.tsx` IMAGE_MAX_WIDTH=800, IMAGE_QUALITY=0.7, validasi productImage.length |
| 44 | WA simplification — hanya transaksi + pergerakan produk | Hapus semua command product CRUD (stock list, stock info, stock report) + material CRUD (bahan list/masuk/keluar, resep) dari WA. Pindah ke Dashboard. Hapus `stock-handler.ts`. Update help text Bantuan. | `stock-handler.ts` dihapus; `message.ts` hapus 6 trigger + 7 import; `keywords.ts` hapus `KW_BAHAN`, `KW_BAHAN_MASUK`, `KW_BAHAN_KELUAR`, `KW_RESEP`, `KW_PRODUCT`; help text `CEK GUDANG` → `GERAKAN STOK` tanpa stock list |
| 45 | Performance — cache laporan + limit pencarian | Tambah cache 60-120s di laba-rugi, product-sales, dashboard/charts. Tambah `.limit(5)` di `searchProductByName`. | `api.ts` ada cache key di 3 endpoint; `stockManager.ts:221` ada `.limit(5)` |
| 46 | Enhancement — wizard step 4 Harga Beli | Pindah field `price_buy` dari step 1 ke step 4 baru setelah BOM. Tampilkan total biaya BOM sebagai referensi. Edit mode tetap tampilkan price_buy di form utama. | `ProductsPage.tsx` wizardTabs 4 item, step 4 render total biaya BOM + RupiahInput price_buy; `editProduct` render price_buy di form |

| 47 | TDZ `Cannot access before initialization` di ProductsPage | `allMaterials` dideklarasikan (line 116) setelah `bomTotalCost` useMemo (line 69). React `mountMemo` panggil factory function segera, akses `allMaterials.find(...)` terjadi sebelum deklarasi → TDZ. Fix: pindah `materialsQuery` + `allMaterials` sebelum `bomTotalCost`. | `ProductsPage.tsx` `allMaterials` declare sebelum `bomTotalCost`; `grep "const allMaterials"` ada di line 77, bukan line 116 |
| 48 | Scheduler WA gagal kirim karena `state.clientReady` tidak dicek | 8 fungsi scheduler (`sendMorningGreeting`, `sendEveningReminder`, `sendDailyCombined`, `sendReport`, `checkStockAlerts`, `checkOverduePiutang`, `checkOverdueHutang`, `checkExpiryWarning`) tidak guard `state.clientReady` — hanya cek `state.waClient` null. `sendMessage` dipanggil sebelum WA siap → silent fail. Fix: tambah `if (!state.clientReady) return` di 8 fungsi + perbaiki `catch` di morning/evening agar log `err.message`. | `scheduler.ts` setiap fungsi di atas punya `if (!state.clientReady)` guard setelah null-check; `sendMorningGreeting` & `sendEveningReminder` `catch` pakai `err.message` |
| 49 | Dockerfile OOM — `NODE_OPTIONS` terlalu besar + setelah build | `NODE_OPTIONS=--max-old-space-size=512` ditempatkan SETELAH `npm run build:frontend`, jadi build tanpa limit (default ~2GB) → OOM di HF Space 512MB. Runtime juga 512MB + Chromium ~300MB > 512MB → OOM restart loop. Fix: pindah sebelum build + turunkan ke 320MB. | `Dockerfile:71-82` `ENV NODE_OPTIONS=--max-old-space-size=320` sebelum build; runtime `NODE_OPTIONS` tidak perlu di-set ulang (inherited) |
| 50 | Session WA expired 30 hari — terlalu agresif | `SESSION_MAX_AGE=30*DAY_MS` → backup session dihapus setelah 30 hari, padahal WA Web masih valid 2-3 bulan. Juga `MAX_FILE_SIZE=1MB` menyebabkan file `Local Storage` >1MB tidak ter-backup → session corrupted. Fix: naikkan `SESSION_MAX_AGE` ke 90 hari + `MAX_FILE_SIZE` ke 10MB + `maybeSingle()`. | `constants.ts:26` `SESSION_MAX_AGE=90*DAY_MS`; `session-persistence.ts:6` `MAX_FILE_SIZE=10_000_000`; `session-persistence.ts:78` `.maybeSingle()` |
| 51 | Total biaya BOM Rp 0 — `cost_per_unit` tidak terisi | `bomTotalCost` kalkulasi benar (`qty * cost_per_unit`), tapi `cost_per_unit` material default `0` saat create. Step 4 wizard tidak auto-populate `price_buy` dari BOM cost. Fix: auto-populate `form.price_buy` saat masuk step 4 + warning jika BOM cost = 0 + hint di form material. | `ProductsPage.tsx` ada useEffect auto-populate `price_buy`; step 4 ada warning `biaya Rp 0`; `StockMaterials.tsx` ada hint "Diperlukan untuk perhitungan biaya BOM" |
| 52 | Infinite upgrade-notify error loop — Puppeteer `ExecutionContext` error `"t: t"` | `sendUpgradeNotification` gagal `client.sendMessage` karena page context hancur (tapi crash listener tidak fire). Error catch return `false` → `upgrade_notified` tidak di-set → diulang tiap menit → infinite loop flood log. Fix: (1) deteksi `ExecutionContext` / `"t: t"` di catch → set `state.clientReady=false`. (2) retry counter per-user, mark notified after 3 fails. (3) health check tiap 60s via `pupPage.evaluate('1+1')` — jika gagal, reconnect. | `scheduler.ts:257-266` ada context error detection; `scheduler.ts:295-310` ada retry counter; `whatsapp.ts` ada `healthCheckTimer` interval 60s |

 Setelah perbaiki bug baru, **tambahkan baris ke tabel ini** di file ini. Bug #29 (StockCategories saving state) sudah obsolete karena file dihapus.

---

## 7. FORMAT LAPORAN AKHIR

```
### Ringkasan
[1-2 kalimat, apa yg diminta & status akhir]

### Bukti sebelum perubahan
[Kutipan kode/log asli]

### Perubahan diterapkan
[Diff nyata per file]

### Verifikasi anti-regresi
- Baseline test/typecheck: [hasil]
- Setelah: [hasil]
- Bug lama di Bagian 6 yg berpotensi terdampak: [list + status]

### Yang tidak diselesaikan / butuh keputusan user
[Jujur, termasuk blocker API/library belum diverifikasi]

### Temuan di luar scope (kalau ada)
[Tidak diperbaiki, sekadar laporan]
```

Laporan tanpa "Verifikasi anti-regresi" dianggap tidak lengkap.

---

## 8. KALAU RAGU — TANYA

Diam & tanya lebih baik daripada menebak lalu salah. Prioritaskan **benar & lambat** daripada cepat & salah lagi untuk ketiga kalinya.

---

## 9. KONTEKS PROYEK

### Struktur
```
index.js → src/app.ts (Express + Socket.IO)
  routes/     — api.ts (2824 baris), auth.ts, health.ts, schemas.ts
  handlers/   — message.ts (1525 baris, orchestrator WA), stock-handler.ts, invoice-handler.ts
  services/   — whatsapp.ts, dialog-state.service.ts, circuit-breaker.ts, session-persistence.ts
  utils/      — stockManager.ts, transactionRecorder.ts, accountingEngine.ts, geminiRouter.ts, db.ts
  config/     — supabase.ts, session.ts, state.ts, constants.ts, keywords.ts
  jobs/       — scheduler.ts, backup.ts, queue.service.ts
  middleware/ — auth.ts, validate.ts
  types/      — api.ts, errors.ts, interfaces.ts
```

### Perintah penting
- `npm start` (production), `npm run dev` (backend+frontend concurrently)
- `npm run build:frontend` (Vite → `public/dist/`)
- `npm run typecheck` (tsc --noEmit)
- `npm test` (vitest, file `tests/**/*.test.ts`)
- `npm run lint`, `npm run format` (prettier, singleQuote, tabWidth 2, trailingComma all)
- `npm run seed:demo` — setup demo data

### Infra quirks
- **Backend**: Node 20, Express 5, `tsx` runtime (no tsc compile needed for dev)
- **Frontend**: Vite 6, React 19, react-router 7, zustand 5, TanStack Query 5, chart.js, Socket.IO client
- **DB**: Supabase REST API (via `@supabase/supabase-js`) + pgPool fallback (`DATABASE_URL`). Supabase sering return 42501 permission → banyak endpoint punya pgPool fallback via `information_schema.columns` auto-detection.
- **Session**: `express-session` + `connect-pg-simple`. PgBouncer (port 6543) auto-used jika DATABASE_URL mengandung `supabase.co`. Wajib `schemaName: 'public'` di options.
- **WA**: `whatsapp-web.js` + `puppeteer` (Chromium system, bukan bundled). Args wajib: `--no-sandbox`, `--disable-dev-shm-usage`, `--single-process`. Retry: 8x max, exponential backoff 5s→300s.
- **Build**: Dockerfile set `NODE_OPTIONS=--max-old-space-size=320` SEBELUM build + runtime. 320MB sisakan ~192MB untuk Chromium dalam 512MB RAM HF Space. Vite output ke `public/dist/`.
- **Port**: 7860 (HF Space default) atau `PORT` env.

### Migration
SQL di `migrations/` — jalankan manual via Supabase SQL Editor. Ada auto-migration 1 kolom (`products.default_channel`) di `src/index.ts:102`.

### Layanan eksternal
- Supabase (DB + REST) — WAJIB
- OpenRouter (AI intent classification) — WAJIB
- Google Cloud Vision (OCR struk) — opsional
- HuggingFace Inference (voice transcription) — opsional
- whatsapp-web.js (WA bot) — masalah utama: timeout ke `web.whatsapp.com` di HF Space (IP block / RAM 512MB kurang)

### Frontend routes (`/stock/*`)
`movement`, `opname`, `retur`, `retur-beli`, `report`, `history`, `piutang`, `hutang`, `keuangan`, `products`, `batch`, `product-stats`, `settings`, `bantuan`, `channels` (redirect → keuangan).

### DB key tables
`products`, `stock_movements`, `financial_transactions`, `accounts`, `journal_entries`, `inventory`, `warehouses` (DROPPED via migration 014), `user_sessions`, `wa_session_backup`, `user_profiles`, `admins`, `alerts`, `notifications`. (`product_categories` table tidak lagi dipakai — kategori produk pakai string bebas via `CATEGORY_KEYWORDS`.)

### Design
- CSS variables + `index.css` (no Tailwind)
- z-index: unified `lib/zIndex.ts`
- Portal: `lib/Portal.tsx`
- RupiahInput: format `Rp 1.234.567` saat blur, raw number saat focus
- Modal: onClose disimpan di `useRef` (hindari re-render loss)
- Toast: `react-hot-toast` via wrapper `Toast.tsx`. `toast()` warning (icon kuning) untuk low stock, `toast.error()` (icon merah) hanya untuk stok habis.
