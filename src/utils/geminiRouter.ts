import { addLog } from '../config/state';

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1/chat/completions';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

const TEXT_MODELS = [
  'qwen/qwen3-coder:free',
  'nvidia/nemotron-3-super-120b-a12b:free',
  'meta-llama/llama-3.3-70b-instruct:free',
];

const VISION_MODELS = [
  'nvidia/nemotron-nano-12b-v2-vl:free',
  'meta-llama/llama-3.3-70b-instruct:free',
  'qwen/qwen3-coder:free',
];

const MAX_RETRIES_PER_MODEL = 1;
const REQUEST_TIMEOUT_MS = 30_000;

interface Message {
  role: 'system' | 'user' | 'assistant';
  content: string | Array<{ type: string; text?: string; image_url?: { url: string } }>;
}

interface ClassificationResult {
  intent: string;
  items?: Array<{ nama_barang: string; qty: number; harga_satuan?: number }>;
  status_pembayaran: string;
  customer_name?: string;
  catatan?: string;
}

interface ExtendedError extends Error {
  status?: number;
}

const responseSchema = {
  type: 'object',
  properties: {
    intent: {
      type: 'string',
      description:
        "Tujuan atau intent dari input. Pilih salah satu: 'pemasukan', 'pengeluaran', 'barang_rusak', 'cek_stok', 'laporan_laba', 'buat_invoice', 'beban_gaji', 'beban_sewa', 'beban_listrik_air', 'beban_transport', 'beban_operasional', 'modal', 'prive', 'piutang', 'bayar_hutang', 'terima_piutang', 'hutang_dagang', 'hutang_lancar', 'hutang_gaji', 'hutang_sewa', 'hutang_listrik_air', 'hutang_transport', 'hutang_operasional', 'hutang', 'retur_jual', 'retur_beli', 'lainnya'",
      enum: [
        'pemasukan',
        'pengeluaran',
        'barang_rusak',
        'cek_stok',
        'laporan_laba',
        'buat_invoice',
        'beban_gaji',
        'beban_sewa',
        'beban_listrik_air',
        'beban_transport',
        'beban_operasional',
        'modal',
        'prive',
        'piutang',
        'bayar_hutang',
        'terima_piutang',
        'hutang_dagang',
        'hutang_lancar',
        'hutang_gaji',
        'hutang_sewa',
        'hutang_listrik_air',
        'hutang_transport',
        'hutang_operasional',
        'hutang',
        'retur_jual',
        'retur_beli',
        'lainnya',
      ],
    },
    items: {
      type: 'array',
      description:
        'Daftar barang jika intent adalah pemasukan, pengeluaran, atau barang rusak. Kosongkan jika intent laporan/cek stok.',
      items: {
        type: 'object',
        properties: {
          nama_barang: { type: 'string' },
          qty: { type: 'integer' },
          harga_satuan: { type: 'number', description: 'Harga per unit, opsional' },
        },
        required: ['nama_barang', 'qty'],
      },
    },
    status_pembayaran: {
      type: 'string',
      description: 'Apakah transaksi ini tunai atau piutang/kasbon?',
      enum: ['tunai', 'piutang'],
    },
    customer_name: {
      type: 'string',
      description: 'Nama pelanggan atau vendor, wajib diisi jika piutang atau buat invoice.',
    },
    catatan: {
      type: 'string',
      description: 'Catatan tambahan atau rangkuman.',
    },
  },
  required: ['intent', 'status_pembayaran'],
};

const SYSTEM_PROMPT = `Anda adalah asisten akuntansi cerdas. Analisis pesan dan/atau nota gambar berikut. 
Ekstrak intent transaksi, daftar barang, status pembayaran, serta nama customer_name.

PANDUAN KLASIFIKASI INTENT:
- 'pemasukan' — Penjualan tunai atau pemasukan uang. Contoh: "jualan 25rb", "pemasukan 500rb dari toko", "Keluar barang 10".
- 'pengeluaran' — Pembelian/restok yang mengurangi uang tapi menambah stok. Contoh: "beli 10 dus mie 250rb", "restok 5 box air mineral".
- 'barang_rusak' — Barang rusak, kadaluarsa, atau hilang. Contoh: "5 pcs oli tumpah", "2 dus mie kadaluarsa".
- 'cek_stok' — Menanyakan stok barang. Contoh: "cek stok oli", "berapa stok buku tulis".
- 'laporan_laba' — Meminta laporan keuangan. Contoh: "laporan laba hari ini", "berapa omzet minggu ini".
- 'buat_invoice' — Membuat invoice/faktur. Contoh: "buat invoice untuk Budi", "faktur penjualan".
- 'beban_gaji' — Pengeluaran untuk gaji/upah karyawan. Contoh: "gaji karyawan Mei 5jt", "bayar upah 3 orang 4,5jt".
- 'beban_sewa' — Pembayaran sewa tempat, gedung, atau ruko. Contoh: "bayar sewa ruko 2jt", "sewa tempat 1,5jt".
- 'beban_listrik_air' — Pembayaran tagihan listrik, PDAM, atau utilitas. Contoh: "bayar listrik toko 500rb", "tagihan pdam 250rb".
- 'beban_transport' — Biaya transportasi, bensin, ojek online, ongkir. Contoh: "bensin 100rb", "ongkir barang 50rb".
- 'beban_operasional' — Biaya operasional lainnya seperti ATK, perlengkapan, kebersihan. Contoh: "beli atk 200rb", "operasional 300rb".
- 'modal' — Setoran modal/investasi ke bisnis. Contoh: "setor modal 10jt", "investasi 5jt", "tambah modal".
- 'prive' — Penarikan pribadi pemilik. Contoh: "ambil prive 1jt", "tarik untuk pribadi 500rb".
- 'piutang' — Penjualan yang belum dibayar (dibayar belakangan). Contoh: "jualan ke Budi 2 dus mie 50rb piutang", "tagih nanti".
- 'bayar_hutang' — Pembayaran hutang ke supplier. Contoh: "bayar hutang 120rb ke Supplier XYZ", "lunasi hutang 500rb".
- 'terima_piutang' — Menerima pembayaran piutang dari customer. Contoh: "terima pembayaran 100rb dari Pak Budi", "piutang lunas".
- 'hutang_dagang' — Hutang ke supplier untuk pembelian stok barang dagangan. Contoh: "beli stok dari Toko X 500rb hutang dagang".
- 'hutang_lancar' — Hutang jangka pendek non-dagang (general). Contoh: "pinjam 2jt untuk operasional".
- 'hutang_gaji' — Hutang gaji/upah karyawan yang belum dibayar. Contoh: "gaji 3 orang 4,5jt belum dibayar".
- 'hutang_sewa' — Hutang sewa tempat yang belum dibayar. Contoh: "sewa ruko 2jt hutang".
- 'hutang_listrik_air' — Hutang listrik/air yang belum dibayar. Contoh: "listrik 500rb hutang".
- 'hutang_transport' — Hutang transportasi yang belum dibayar. Contoh: "ongkir 50rb hutang".
- 'hutang_operasional' — Hutang biaya operasional lainnya. Contoh: "operasional 300rb hutang".
- 'hutang' — Pembelian yang belum dibayar ke supplier (sinonim hutang_dagang). Contoh: "beli stok dari Toko X 500rb hutang".
- 'retur_jual' — Barang dikembalikan oleh customer (sales return). Contoh: "retur 2 kopi dari Pak Budi rusak", "customer return 3 pcs".
- 'retur_beli' — Barang dikembalikan ke supplier (purchase return). Contoh: "retur beli 5 kopi kualitas buruk", "kembalikan barang ke supplier".
- 'lainnya' — Input yang tidak masuk kategori di atas.

ATURAN:
- status_pembayaran: 'tunai' jika langsung bayar, 'piutang' jika bayar nanti/kasbon.
- customer_name: isi jika ada nama pelanggan/vendor disebut.
- items: hanya untuk intent pemasukan/pengeluaran/barang_rusak yang menyebut produk.
- Jika ada gambar nota struk, baca sebagai OCR dengan intent otomatis 'pengeluaran'.
- Koreksi typo nama barang jika diperlukan.

BALAS HANYA DENGAN JSON VALID. Jangan tambahkan markdown, penjelasan, atau teks lain di luar JSON.`;

async function callOpenRouter(model: string, messages: Message[]): Promise<any> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const body = {
      model,
      messages,
      response_format: {
        type: 'json_schema' as const,
        json_schema: {
          name: 'transaction_intent',
          strict: true,
          schema: responseSchema,
        },
      },
      temperature: 0.1,
      max_tokens: 1024,
    };

    const resp = await fetch(OPENROUTER_BASE_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': process.env.APP_URL || 'https://localhost',
        'X-Title': 'Tata Business Suite',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!resp.ok) {
      const errBody = await resp.text().catch(() => '');
      const err = new Error(`OpenRouter ${resp.status}: ${errBody.slice(0, 200)}`) as ExtendedError;
      err.status = resp.status;
      throw err;
    }

    const data: any = await resp.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error('OpenRouter: empty response content');
    }

    const jsonStr = (content as string)
      .replace(/```json\s*/gi, '')
      .replace(/```\s*/g, '')
      .trim();
    return JSON.parse(jsonStr);
  } catch (err) {
    clearTimeout(timeout);
    if ((err as Error).name === 'AbortError') {
      throw new Error(`OpenRouter: request timeout after ${REQUEST_TIMEOUT_MS}ms`);
    }
    throw err;
  }
}

async function callWithFallback(models: string[], messages: Message[], label: string): Promise<any> {
  let lastError: Error | null = null;

  for (const model of models) {
    for (let attempt = 0; attempt < MAX_RETRIES_PER_MODEL; attempt++) {
      try {
        const result = await callOpenRouter(model, messages);
        if (attempt > 0 || models.indexOf(model) > 0) {
          addLog('info', `[AI-ROUTER] ${label}: succeeded with ${model} (attempt ${attempt + 1})`);
        }
        return result;
      } catch (err) {
        lastError = err as Error;
        const status = (err as ExtendedError).status;
        const retryable = status === 429 || status === 503 || status === 502 || (status || 0) >= 500;
        addLog(
          'warn',
          `[AI-ROUTER] ${label}: ${model} failed (${(err as Error).message})${retryable ? '' : ' — non-retryable'}`,
        );
        if (!retryable) break;
        if (attempt < MAX_RETRIES_PER_MODEL - 1) {
          await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
        }
      }
    }
  }

  addLog('error', `[AI-ROUTER] ${label}: all models failed`);
  throw lastError || new Error('All AI models failed');
}

async function callGeminiDirect(
  promptText: string,
  imageBuffer: Buffer | null,
  mimeType: string,
  label: string,
): Promise<ClassificationResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
    
    const parts: any[] = [{ text: SYSTEM_PROMPT + '\n\nPesan user: "' + promptText + '"' }];
    
    if (imageBuffer) {
      parts.push({
        inlineData: {
          mimeType: mimeType,
          data: imageBuffer.toString('base64'),
        },
      });
    }

    const body = {
      contents: [
        {
          role: 'user',
          parts: parts,
        },
      ],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: responseSchema,
        temperature: 0.1,
      },
    };

    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!resp.ok) {
      const errBody = await resp.text().catch(() => '');
      const err = new Error(`Gemini API ${resp.status}: ${errBody.slice(0, 200)}`) as ExtendedError;
      err.status = resp.status;
      throw err;
    }

    const data: any = await resp.json();
    const content = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!content) {
      throw new Error('Gemini API: empty response content');
    }

    const jsonStr = content.trim();
    return JSON.parse(jsonStr);
  } catch (err) {
    clearTimeout(timeout);
    if ((err as Error).name === 'AbortError') {
      throw new Error(`Gemini API: request timeout after ${REQUEST_TIMEOUT_MS}ms`);
    }
    throw err;
  }
}

async function processMessageWithGemini(
  promptText: string,
  imageBuffer: Buffer | null = null,
  mimeType = 'image/jpeg',
): Promise<ClassificationResult> {
  if (!OPENROUTER_API_KEY && !GEMINI_API_KEY) {
    throw new Error('Neither OPENROUTER_API_KEY nor GEMINI_API_KEY is set in environment');
  }

  const label = imageBuffer ? 'Vision/OCR' : 'Text classification';

  if (GEMINI_API_KEY) {
    addLog('info', `[AI-ROUTER] Using Gemini API directly (${GEMINI_MODEL})`);
    return callGeminiDirect(promptText, imageBuffer, mimeType, label);
  }

  const userPrompt = `Pesan user: "${promptText}"`;

  let messages: Message[];
  if (imageBuffer) {
    const base64 = imageBuffer.toString('base64');
    messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          { type: 'text', text: userPrompt },
          { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64}` } },
        ],
      },
    ];
    return callWithFallback(VISION_MODELS, messages, label);
  } else {
    messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ];
    return callWithFallback(TEXT_MODELS, messages, label);
  }
}

export { processMessageWithGemini };
