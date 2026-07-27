# Tata Business Suite v2.0.0

Sistem otomasi manajemen stok dan integrasi WhatsApp bot berbasis AI untuk UKM Indonesia.

## Fitur

- **WhatsApp Bot** — Catat transaksi masuk/keluar, cek stok, laporan harian via chat
- **AI Intent Classification** — NLP untuk memahami pesan natural (Gemini / OpenRouter)
- **OCR Struk** — Scan foto struk belanja via Google Cloud Vision
- **Voice Note** — Transkripsi audio via Whisper (HuggingFace)
- **Manajemen Stok** — Produk, BOM/packaging, opname, alert minimum stock
- **Double-Entry Accounting** — Jurnal, neraca, laba-rugi, trial balance
- **Invoice PDF** — Kirim tagihan profesional dengan PDF
- **Web Dashboard** — 9 halaman: overview, financial, produk, movement, opname, report, history, piutang, pembukuan
- **Multi-Level Subscription** — Demo (5 transaksi/hari), PRO (30 hari), UNLIMITED (seumur hidup)

## Tech Stack

- **Runtime:** Node.js 20+, Express 5, TypeScript (tsx)
- **Database:** PostgreSQL via Supabase
- **AI:** Google Gemini / OpenRouter (Qwen, Nemotron, Llama)
- **WA:** whatsapp-web.js + Puppeteer + Chromium
- **Session:** express-session + pgSession (connect-pg-simple)
- **Realtime:** Socket.IO
- **Frontend:** React 19 + Vite + Zustand + TanStack Query

## Deploy ke Railway (Rekomendasi)

1. Fork repo ini ke GitHub
2. Buat project baru di [Railway](https://railway.app) → "Deploy from GitHub repo"
3. Railway otomatis deteksi `Dockerfile` dan build
4. Set environment variables (lihat bagian di bawah)
5. APP_URL: isi URL Railway kamu setelah deploy pertama (format: `https://xxx.up.railway.app`)

```bash
# Persistent storage untuk WhatsApp session — tambahkan Volume di Railway:
# Mount path: /data
```

## Setup Local

1. Clone & install:
```bash
git clone https://github.com/ridwanhaniff/tata-bussines-suite.git
cd tata-bussines-suite
npm install
```

2. Copy `.env.example` ke `.env` dan isi semua variabel:
```bash
cp .env.example .env
```

3. Jalankan migrasi database dari folder `migrations/` di Supabase SQL Editor

4. Start:
```bash
npm run dev      # Development (backend + frontend)
npm start        # Production (tsx langsung)
```

## Environment Variables

| Variable | Wajib | Keterangan |
|---|---|---|
| `SUPABASE_URL` | ✅ | URL project Supabase |
| `SUPABASE_KEY` | ✅ | Service role key |
| `DATABASE_URL` | ✅ | Connection string PostgreSQL (untuk session) |
| `SESSION_SECRET` | ✅ | Minimal 32 karakter random |
| `APP_URL` | ✅ | URL Railway kamu (untuk link WA dashboard) |
| `GEMINI_API_KEY` | ✅* | Google Gemini API key (*atau OPENROUTER_API_KEY) |
| `OPENROUTER_API_KEY` | ✅* | OpenRouter API key (alternatif Gemini) |
| `GOOGLE_VISION_CREDENTIALS_JSON` | ⬜ | JSON key Google Vision (OCR struk, paste raw JSON) |
| `HF_TOKEN` | ⬜ | HuggingFace token (voice transcription + backup) |
| `HF_BACKUP_BUCKET` | ⬜ | HF Dataset repo untuk backup database |
| `ADMIN_WA_NUMBER` | ⬜ | Nomor WA admin untuk notifikasi error darurat |
| `PAYMENT_BANK` | ⬜ | Nama bank untuk info pembayaran WA |
| `PAYMENT_ACCOUNT` | ⬜ | No rekening |
| `PAYMENT_NAME` | ⬜ | Nama pemilik rekening |

> ⚠️ **PORT** jangan diset manual — Railway inject otomatis via environment

## Scripts

| Script | Keterangan |
|---|---|
| `npm start` | Jalankan production (tsx) |
| `npm run dev` | Jalankan development (backend + frontend watch) |
| `npm test` | Jalankan unit test (vitest) |
| `npm run build:frontend` | Build Vite SPA ke public/dist |
| `npm run typecheck` | TypeScript check tanpa compile |
| `npm run seed:demo` | Seed data demo |

## Architecture

```
index.js → src/index.ts (server entry)
  src/app.ts (Express + Socket.IO setup)
  ├── routes/
  │   ├── api.ts        — REST endpoints (2800+ baris)
  │   ├── auth.ts       — Login/logout
  │   └── health.ts     — Health check /ping
  ├── handlers/
  │   ├── message.ts    — WA message handler (orchestrator)
  │   └── invoice-handler.ts
  ├── services/
  │   ├── whatsapp.ts          — WA client + Puppeteer
  │   ├── session-persistence.ts
  │   ├── dialog-state.service.ts
  │   └── emergency.ts
  ├── utils/
  │   ├── geminiRouter.ts      — AI intent classification
  │   ├── mediaProcessor.ts    — OCR & voice transcription
  │   ├── accountingEngine.ts  — Double-entry accounting
  │   ├── transactionRecorder.ts
  │   ├── stockManager.ts
  │   └── helpers.ts
  ├── config/
  │   ├── supabase.ts
  │   ├── session.ts
  │   ├── state.ts
  │   ├── constants.ts
  │   └── keywords.ts
  └── jobs/
      ├── scheduler.ts   — Cron: laporan harian, alert stok
      ├── backup.ts      — Backup DB ke HF bucket
      └── queue.service.ts
```

## Deployment

### Railway (Docker)
Railway otomatis baca `Dockerfile`. Tidak perlu `railway.json`.
Tambahkan **Volume** di Railway → Mount path `/data` untuk persistent WhatsApp session.

### Local Docker Compose
```bash
docker compose up --build
```
