import { useState, useEffect, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useStockStore } from '../../store/stockStore';
import { stockApi, bomApi } from '../../services/api';
import { Modal } from '../../components/Modal';
import { ConfirmModal } from '../../components/ConfirmModal';
import { RupiahInput } from '../../components/RupiahInput';
import { Badge } from '../../components/Badge';
import { TableSkeleton } from '../../components/LoadingSkeleton';
import { toast } from '../../components/Toast';
import { fmtRp, fmtQty, UNIT_OPTIONS } from '../../lib/utils';
import type { Product, BomMaterial, BomRecipe } from '../../types';
import {
  Plus, Edit2, Trash2, Search, Globe, AlertTriangle,
  RefreshCw, Package, X, ChevronLeft, ChevronRight, Check, Image
} from 'lucide-react';
import { DownloadButton } from '../../components/DownloadButton';

const CATEGORY_KEYWORDS: Record<string, string[]> = {
  'Makanan & Minuman': ['makanan', 'minuman', 'kopi', 'teh', 'susu', 'roti', 'kue', 'snack', 'cemilan', 'sembako', 'beras', 'gula', 'minyak', 'bumbu', 'mie', 'sarden', 'saos', 'kecap', 'kripik', 'keripik', 'coklat', 'permen', 'biskuit', 'wafer', 'selai', 'madu', 'saos', 'kecap', 'sambal', 'bawang', 'telur', 'tepung', 'kornet', 'daging', 'ayam', 'ikan', 'tahu', 'tempe'],
  'Pakaian & Aksesoris': ['baju', 'kemeja', 'kaos', 'celana', 'rok', 'dress', 'jaket', 'sepatu', 'sandal', 'tas', 'topi', 'sarung', 'hijab', 'jilbab', 'kerudung', 'kaos kaki', 'kacamata', 'jam tangan', 'ikat pinggang', 'dompet', 'ransel'],
  'Elektronik': ['lampu', 'kabel', 'charger', 'baterai', 'adaptor', 'kipas', 'setrika', 'rice cooker', 'blender', 'tv', 'televisi', 'radio', 'speaker', 'earphone', 'headset', 'mouse', 'keyboard', 'flashdisk', 'memory', 'hardisk', 'monitor', 'laptop', 'komputer', 'hp', 'handphone', 'ponsel', 'sim card', 'pulsa', 'listrik', 'saklar', 'stop kontak'],
  'Rumah Tangga': ['sapu', 'pel', 'ember', 'panci', 'wajan', 'piring', 'gelas', 'sendok', 'garpu', 'taplak', 'keset', 'gayung', 'baskom', 'talenan', 'pisau dapur', 'serbet', 'lap', 'tempat sampah', 'gantungan', 'hanger'],
  'Kesehatan & Kecantikan': ['sabun', 'shampoo', 'pasta gigi', 'sikat gigi', 'lotion', 'parfum', 'masker', 'vitamin', 'obat', 'kosmetik', 'bedak', 'lipstik', 'eyeliner', 'sunscreen', 'deodoran', 'pembalut', 'popok', 'tisu basah', 'minyak kayu putih', 'minyak angin', 'betadine', 'plester', 'perban', 'hand sanitizer'],
  'ATK & Kantor': ['buku', 'pulpen', 'pensil', 'penghapus', 'kertas', 'stapler', 'amplop', 'map', 'lem', 'gunting', 'penggaris', 'spidol', 'crayon', 'cat air', 'stabilo', 'klip', 'paper clip', 'lakban', 'selotip', 'binder', 'ordner', 'rak', 'meja', 'kursi kantor'],
  'Otomotif': ['oli', 'ban', 'bearing', 'kampas', 'busi', 'aki', 'lampu mobil', 'wiper', 'filter', 'knalpot', 'helm', 'spion', 'stang', 'velg', 'ban dalam', 'tambal', 'kunci', 'kunci pas', 'obeng', 'tang'],
  'Olahraga': ['bola', 'raket', 'matras', 'dumbbell', 'sepeda', 'sepatu olahraga', 'kaos olahraga', 'raket', 'shuttlecock', 'net', 'pelampung', 'kacamata renang', 'treadmill', 'yoga', 'jogging', 'lari'],
  'Mainan & Hobi': ['boneka', 'lego', 'puzzle', 'kartu', 'lilin', 'playdoh', 'mobil mobilan', 'remote control', 'drone', 'yoyo', 'kelereng', 'congklak', 'rubik', 'slime'],
  'Perlengkapan Bayi': ['popok', 'susu formula', 'botol dot', 'stroller', 'baby walker', 'guling', 'bantal bayi', 'selimut bayi', 'bedong', 'gurita', 'minyak telon', 'baby oil', 'bedak bayi', 'shampoo bayi'],
  'Bahan Bangunan': ['semen', 'pasir', 'bata', 'cat', 'paku', 'triplek', 'besi', 'baja ringan', 'keramik', 'granit', 'pipa', 'paralon', 'seng', 'asbes', 'gypsum', 'kayu', 'kusen', 'jendela', 'pintu', 'engsel', 'gembok'],
  'Pertanian & Peternakan': ['pupuk', 'benih', 'pestisida', 'polybag', 'pot', 'tanah', 'kompos', 'sekop', 'cangkul', 'selang', 'pakan ternak', 'obat ternak', 'kandang', 'pakan ikan'],
  'Alat Musik': ['gitar', 'keyboard', 'drum', 'senar', 'mikrofon', 'amplifier', 'pianika', 'seruling', 'angklung', 'rebana', 'gendang'],
  'Buku & Media': ['buku tulis', 'novel', 'komik', 'majalah', 'koran', 'buku bacaan', 'buku pelajaran', 'buku agama', 'buku resep', 'kalender', 'poster'],
  'Perlengkapan Hewan': ['kandang', 'pakan', 'pasir kucing', 'mainan kucing', 'kalung anjing', 'tali', 'mangkok', 'grooming', 'shampoo hewan'],
  'Lainnya': [],
};

function detectCategory(name: string): string {
  const lower = name.toLowerCase();
  for (const [cat, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    if (keywords.length === 0) continue;
    if (keywords.some(kw => lower.includes(kw))) return cat;
  }
  return '';
}

export function ProductsPage() {
  const { token } = useStockStore();
  const user = useStockStore(s => s.user);
  const [search, setSearch] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [editProduct, setEditProduct] = useState<Product | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [form, setForm] = useState({ sku: '', name: '', category: '', unit: '', price_buy: '', price_sell: '', stock_min: '', default_channel: '', channels: [] as string[] });
  const [saving, setSaving] = useState(false);
  const [categoryTouched, setCategoryTouched] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [productImage, setProductImage] = useState<string | null>(null);
  const [imageChanged, setImageChanged] = useState(false);

  // wizard state (create only)
  const [wizardStep, setWizardStep] = useState(1);
  const [stockInitial, setStockInitial] = useState('');
  const [bomRows, setBomRows] = useState<Array<{ material_id: string; quantity: string }>>([]);

  // edit mode BOM
  const [showRecipes, setShowRecipes] = useState(false);
  const [recipeForm, setRecipeForm] = useState({ material_id: '', quantity_per_order: '' });

  const productsQuery = useQuery({
    queryKey: ['products-page', token],
    queryFn: () => stockApi.get<{ products: Product[] }>('/api/stock/products', token!),
    enabled: !!token,
    staleTime: 30_000,
    gcTime: 60_000,
    select: (data) => data.products ?? [],
  });

  const channelsQuery = useQuery({
    queryKey: ['settings-channels', token],
    queryFn: () => stockApi.get<{ settings?: { active_channels?: string[] } }>('/api/stock/settings', token!),
    enabled: !!token,
    staleTime: 60_000,
    select: (data) => data.settings?.active_channels ?? ['offline', 'whatsapp', 'shopee', 'tokopedia', 'lazada', 'tiktok shop'],
  });

  const materialsQuery = useQuery({
    queryKey: ['materials-for-recipes', token],
    queryFn: () => bomApi.listMaterials(token!),
    enabled: !!token,
    staleTime: 30_000,
  });

  const recipesQuery = useQuery({
    queryKey: ['recipes', token, editProduct?.id],
    queryFn: () => bomApi.listRecipes(token!, editProduct?.id || undefined),
    enabled: !!token && showRecipes && !!editProduct,
    staleTime: 10_000,
    select: (data) => data.recipes ?? [],
  });

  const products = productsQuery.data ?? [];
  const activeChannels = channelsQuery.data ?? [];
  const allMaterials = (materialsQuery.data?.materials ?? []) as BomMaterial[];
  const productRecipes = recipesQuery.data as BomRecipe[] | undefined;
  const loading = productsQuery.isPending || channelsQuery.isPending;
  const error = productsQuery.isError || channelsQuery.isError;

  const isDemo = user?.status === 'demo';
  const demoLimitReached = isDemo && products.length >= 3;

  const filtered = products.filter((p) =>
    p.name.toLowerCase().includes(search.toLowerCase()) ||
    p.sku.toLowerCase().includes(search.toLowerCase()),
  );

  // auto-detect category when name changes (only if not manually touched)
  useEffect(() => {
    if (!categoryTouched && !editProduct) {
      const detected = detectCategory(form.name);
      if (detected !== form.category) {
        setForm(prev => ({ ...prev, category: detected }));
      }
    }
  }, [form.name]);

  const IMAGE_MAX_WIDTH = 800;
  const IMAGE_QUALITY = 0.7;

  function handleImageSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) { toast.error('Hanya file gambar'); return; }
    if (file.size > 10 * 1024 * 1024) { toast.error('File maksimal 10MB'); return; }
    const reader = new FileReader();
    reader.onload = (ev) => {
      const img = new window.Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        let { width, height } = img;
        if (width > IMAGE_MAX_WIDTH) {
          height = (height * IMAGE_MAX_WIDTH) / width;
          width = IMAGE_MAX_WIDTH;
        }
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d')!;
        ctx.drawImage(img, 0, 0, width, height);
        const compressed = canvas.toDataURL('image/jpeg', IMAGE_QUALITY);
        setProductImage(compressed);
        setImageChanged(true);
      };
      img.src = ev.target?.result as string;
    };
    reader.readAsDataURL(file);
  }

  function handleRemoveImage() {
    setProductImage(null);
    setImageChanged(true);
  }

  function resetWizard() {
    setWizardStep(1);
    setStockInitial('');
    setBomRows([]);
    setCategoryTouched(false);
    setProductImage(null);
    setImageChanged(false);
    setFieldErrors({});
  }

  function openCreate() {
    setEditProduct(null);
    setForm({ sku: '', name: '', category: '', unit: '', price_buy: '', price_sell: '', stock_min: '', default_channel: '', channels: [] });
    resetWizard();
    setShowModal(true);
  }

  function openEdit(p: Product) {
    setEditProduct(p);
    setForm({
      sku: p.sku,
      name: p.name,
      category: p.category || '',
      unit: p.unit || '',
      price_buy: p.price_buy?.toString() || '',
      price_sell: p.price_sell.toString(),
      stock_min: p.stock_min?.toString() || '',
      default_channel: p.default_channel || '',
      channels: p.channels || [],
    });
    resetWizard();
    setProductImage(p.image_url || null);
    setImageChanged(false);
    setShowModal(true);
  }

  function validateBase(): boolean {
    const errs: Record<string, string> = {};
    if (!form.name.trim()) errs.name = 'Nama produk harus diisi';
    if (!form.sku.trim()) errs.sku = 'SKU harus diisi';
    if (!form.price_sell.trim()) errs.price_sell = 'Harga jual harus diisi';
    setFieldErrors(errs);
    return Object.keys(errs).length === 0;
  }

  function nextStep() {
    if (wizardStep === 1 && !validateBase()) return;
    setFieldErrors({});
    setWizardStep(s => Math.min(s + 1, 3));
  }

  function prevStep() {
    setWizardStep(s => Math.max(s - 1, 1));
  }

  async function handleSave() {
    if (!token || saving) return;
    if (!validateBase()) return;
    setSaving(true);
    try {
      if (editProduct) {
        // ── Edit: image → product ──
        if (imageChanged) {
          await stockApi.post(`/api/stock/products/${editProduct.id}/image`, token, { image_base64: productImage });
        }
        await stockApi.put(`/api/stock/products/${editProduct.id}`, token, {
          sku: form.sku,
          name: form.name,
          category: form.category || undefined,
          unit: form.unit || undefined,
          price_buy: form.price_buy ? Number(form.price_buy) : undefined,
          price_sell: Number(form.price_sell),
          stock_min: form.stock_min ? Number(form.stock_min) : undefined,
          default_channel: form.default_channel || '',
          channels: form.channels,
        });
        toast('Produk diupdate');
        setShowModal(false);
        productsQuery.refetch();
        return;
      }

      // ── Create: product → image → BOM ──
      const body: Record<string, unknown> = {
        sku: form.sku,
        name: form.name,
        category: form.category || undefined,
        unit: form.unit || undefined,
        price_buy: form.price_buy ? Number(form.price_buy) : undefined,
        price_sell: Number(form.price_sell),
        stock_min: form.stock_min ? Number(form.stock_min) : undefined,
        default_channel: form.default_channel || '',
        channels: form.channels,
        stock_initial: Number(stockInitial) || 0,
      };
      const result = await stockApi.post<{ product: Product }>('/api/stock/products', token, body);
      const newProduct = result.product;

      // Image upload
      if (productImage) {
        await stockApi.post(`/api/stock/products/${newProduct.id}/image`, token, { image_base64: productImage });
      }

      // BOM recipes
      const validRows = bomRows.filter(r => r.material_id && r.quantity);
      for (const row of validRows) {
        await bomApi.setRecipe(token, {
          material_id: row.material_id,
          product_id: newProduct.id,
          quantity_per_order: Number(row.quantity),
        });
      }

      toast('Produk dibuat');
      setShowModal(false);
      productsQuery.refetch();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Gagal simpan produk');
    } finally {
      setSaving(false);
    }
  }

  async function confirmDelete(id: string) {
    try {
      await stockApi.del(`/api/stock/products/${id}`, token!);
      toast('Produk dihapus');
      productsQuery.refetch();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Gagal hapus produk');
    }
  }

  async function addRecipe() {
    if (!token || !editProduct) return;
    if (!recipeForm.material_id || !recipeForm.quantity_per_order) {
      toast.error('Pilih material dan isi jumlah');
      return;
    }
    try {
      await bomApi.setRecipe(token, { material_id: recipeForm.material_id, product_id: editProduct.id, quantity_per_order: Number(recipeForm.quantity_per_order) });
      toast('Resep ditambahkan');
      setRecipeForm({ material_id: '', quantity_per_order: '' });
      recipesQuery.refetch();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Gagal tambah resep');
    }
  }

  async function deleteRecipe(id: string) {
    try {
      await bomApi.deleteRecipe(token!, id);
      toast('Resep dihapus');
      recipesQuery.refetch();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Gagal hapus resep');
    }
  }

  function addBomRow() {
    setBomRows(prev => [...prev, { material_id: '', quantity: '' }]);
  }

  function removeBomRow(index: number) {
    setBomRows(prev => prev.filter((_, i) => i !== index));
  }

  function updateBomRow(index: number, field: 'material_id' | 'quantity', value: string) {
    setBomRows(prev => prev.map((row, i) => i === index ? { ...row, [field]: value } : row));
  }

  const handleClose = useCallback(() => {
    setShowModal(false);
    setEditProduct(null);
    resetWizard();
  }, []);

  function stockStatus(stock: number, min: number | null): string {
    if (stock <= 0) return 'habis';
    if (min && stock <= min) return 'menipis';
    return 'aman';
  }

  // ── Wizard step indicator ──
  const wizardTabs = ['Informasi', 'Stok Awal', 'Bahan Baku'];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '1rem' }}>
        <div>
          <h2 style={{ fontSize: '1.5rem', fontWeight: 800 }}>Produk</h2>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.875rem' }}>Kelola produk Anda</p>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          <button className="btn btn-primary btn-sm" onClick={openCreate}
            disabled={demoLimitReached}
            title={demoLimitReached ? 'Demo terbatas 3 produk. Upgrade ke PRO!' : ''}
            style={demoLimitReached ? { opacity: 0.5, cursor: 'not-allowed' } : {}}>
            <Plus size={16} /> Tambah Produk
          </button>
          <DownloadButton url="/api/stock/export/produk" filename="ProdukStok.xlsx" />
        </div>
        {isDemo && (
          <div className="demo-banner" style={{ width: '100%' }}>
            <span className="demo-banner__text">🔒 Demo: maksimal 3 produk. {products.length}/3 digunakan.</span>
            <a href="https://wa.me/6283121376756?text=Halo%20saya%20ingin%20upgrade%20Tata%20Business%20Suite%20ke%20PRO"
               target="_blank" rel="noopener noreferrer"
               style={{ marginLeft: '0.5rem', fontWeight: 700, color: '#fff', whiteSpace: 'nowrap' }}>
               Upgrade →
            </a>
          </div>
        )}
      </div>

      <div className="input-icon-wrap" style={{ maxWidth: 300 }}>
        <Search size={16} />
        <input
          className="input input-sm"
          placeholder="Cari nama/SKU..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {loading ? (
        <TableSkeleton rows={8} cols={7} />
      ) : error ? (
        <div className="card card-p" style={{ textAlign: 'center', padding: '3rem', borderColor: 'var(--danger)', borderWidth: 2 }}>
          <AlertTriangle size={36} style={{ color: 'var(--danger)', marginBottom: '1rem' }} />
          <div style={{ fontSize: '1.1rem', fontWeight: 700, marginBottom: '0.5rem' }}>Gagal Memuat Data</div>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem', maxWidth: 400, margin: '0 auto 1rem' }}>
            Server penyimpanan data sedang tidak dapat dijangkau. Silakan coba lagi.
          </p>
          <button className="btn btn-primary btn-sm" onClick={() => productsQuery.refetch()}>
            <RefreshCw size={14} /> Coba Lagi
          </button>
        </div>
      ) : filtered.length === 0 ? (
        <div className="card card-p" style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-muted)' }}>
          {products.length === 0 ? 'Belum ada produk. Klik "Tambah Produk" untuk memulai.' : 'Tidak ditemukan'}
        </div>
      ) : (
        <div className="tbl-wrap">
          <table>
            <thead>
              <tr>
                <th style={{ width: 48 }}>Gambar</th>
                <th>SKU</th>
                <th>Nama</th>
                <th>Kategori</th>
                <th>Channel</th>
                <th>Harga Beli</th>
                <th>Stok</th>
                <th>Harga Jual</th>
                <th>Status</th>
                <th>Aksi</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((p) => (
                <tr key={p.id}>
                  <td>
                    {p.image_url ? (
                      <img src={p.image_url} alt={p.name}
                        style={{ width: 40, height: 40, borderRadius: 4, objectFit: 'cover' }}
                        onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                      />
                    ) : (
                      <div style={{ width: 40, height: 40, borderRadius: 4, background: 'var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.6rem', color: 'var(--text-muted)' }}>
                        -
                      </div>
                    )}
                  </td>
                  <td style={{ fontFamily: 'monospace', fontSize: '0.8rem' }}>{p.sku}</td>
                  <td style={{ fontWeight: 600 }}>{p.name}</td>
                  <td style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>{p.category || '-'}</td>
                  <td style={{ fontSize: '0.8rem' }}>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.25rem' }}>
                      {p.channels && p.channels.length > 0 ? p.channels.map(ch => (
                        <span key={ch} className="badge badge-green" style={{ alignItems: 'center', gap: '0.2rem', fontSize: '0.7rem' }}>
                          <Globe size={10} /> {ch}
                        </span>
                      )) : (
                        <span style={{ color: 'var(--text-muted)' }}>Semua</span>
                      )}
                    </div>
                  </td>
                  <td style={{ fontWeight: 600, color: (p.price_buy ?? 0) === 0 ? 'var(--danger)' : 'var(--text)', fontSize: '0.8rem' }}>
                    {fmtRp(p.price_buy ?? 0)}
                  </td>
                  <td>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <div className="progress" style={{ width: 80 }}>
                        <div
                          className="progress-fill"
                          style={{
                            width: `${Math.min(((p.stock_current ?? 0) / Math.max(p.stock_min || 10, 1)) * 100, 100)}%`,
                            background: (p.stock_current ?? 0) <= 0 ? 'var(--danger)' : (p.stock_min && (p.stock_current ?? 0) <= p.stock_min ? 'var(--warning)' : 'var(--primary)'),
                          }}
                        />
                      </div>
                      {fmtQty(p.stock_current, p.unit)}
                    </div>
                  </td>
                  <td style={{ fontWeight: 600 }}>{fmtRp(p.price_sell)}</td>
                  <td>
                    <Badge variant={stockStatus(p.stock_current, p.stock_min)}>
                      {stockStatus(p.stock_current, p.stock_min) === 'aman' ? 'Aman' : stockStatus(p.stock_current, p.stock_min) === 'menipis' ? 'Menipis' : 'Habis'}
                    </Badge>
                  </td>
                  <td>
                    <div className="row-actions">
                      <button className="btn btn-ghost btn-sm" onClick={() => openEdit(p)}>
                        <Edit2 size={14} />
                      </button>
                      <button className="btn btn-ghost btn-sm" onClick={() => setDeleteConfirmId(p.id)} style={{ color: 'var(--danger)' }}>
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Modal: Create (wizard) / Edit ── */}
      <Modal
        open={showModal}
        onClose={handleClose}
        title={editProduct ? 'Edit Produk' : 'Tambah Produk'}
        footer={
          editProduct ? (
            <>
              <button className="btn btn-secondary" onClick={handleClose}>Batal</button>
              <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
                {saving ? 'Menyimpan...' : 'Simpan'}
              </button>
            </>
          ) : wizardStep === 3 ? (
            <>
              <button className="btn btn-secondary" onClick={prevStep}>
                <ChevronLeft size={14} /> Kembali
              </button>
              <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
                {saving ? 'Menyimpan...' : <><Check size={14} /> Simpan</>}
              </button>
            </>
          ) : (
            <>
              {wizardStep > 1 && (
                <button className="btn btn-secondary" onClick={prevStep}>
                  <ChevronLeft size={14} /> Kembali
                </button>
              )}
              <button className="btn btn-primary" onClick={nextStep}>
                Lanjut <ChevronRight size={14} />
              </button>
            </>
          )
        }
      >
        {!editProduct && (
          <div style={{ display: 'flex', gap: '0.25rem', marginBottom: '1rem' }}>
            {wizardTabs.map((label, i) => (
              <div
                key={label}
                style={{
                  flex: 1, textAlign: 'center', padding: '0.4rem 0', fontSize: '0.75rem', fontWeight: 600,
                  borderRadius: '6px',
                  background: wizardStep === i + 1 ? 'var(--primary)' : 'transparent',
                  color: wizardStep === i + 1 ? '#fff' : 'var(--text-muted)',
                  border: wizardStep === i + 1 ? 'none' : '1px solid var(--border)',
                  transition: 'all 0.2s',
                }}
              >
                {i + 1}. {label}
              </div>
            ))}
          </div>
        )}

        {/* ── Step 1: Informasi Produk ── */}
        {(!editProduct && wizardStep === 1) || editProduct ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <div className="form-row">
              <div className="form-group">
                <label className="form-label">SKU *</label>
                <input className="input" value={form.sku} onChange={(e) => { setForm({ ...form, sku: e.target.value }); setFieldErrors(prev => ({ ...prev, sku: '' })); }} />
                {fieldErrors.sku && <span style={{ fontSize: '0.75rem', color: 'var(--danger)' }}>{fieldErrors.sku}</span>}
              </div>
              <div className="form-group">
                <label className="form-label">Nama Produk *</label>
                <input className="input" value={form.name} onChange={(e) => { setForm({ ...form, name: e.target.value }); setFieldErrors(prev => ({ ...prev, name: '' })); }} />
                {fieldErrors.name && <span style={{ fontSize: '0.75rem', color: 'var(--danger)' }}>{fieldErrors.name}</span>}
              </div>
            </div>
            <div className="form-group">
              <label className="form-label">Kategori</label>
              <input
                className="input"
                value={form.category}
                onChange={(e) => { setForm({ ...form, category: e.target.value }); setCategoryTouched(true); }}
                placeholder="Otomatis terdeteksi dari nama"
              />
              {!categoryTouched && form.category && (
                <span style={{ fontSize: '0.75rem', color: 'var(--primary)', marginTop: '0.2rem', display: 'block' }}>
                  Terdeteksi otomatis dari nama produk
                </span>
              )}
            </div>
            <div className="form-row">
              <div className="form-group">
                <label className="form-label">Satuan</label>
                <select className="input" value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })}>
                  <option value="">— Pilih satuan —</option>
                  {form.unit && !UNIT_OPTIONS.includes(form.unit as any) && <option value={form.unit}>{form.unit} (kustom)</option>}
                  {UNIT_OPTIONS.map((u) => <option key={u} value={u}>{u}</option>)}
                </select>
              </div>
              <div className="form-group">
                <label className="form-label">Harga Beli</label>
                <RupiahInput value={form.price_buy} onChange={(v) => setForm({ ...form, price_buy: v })} />
              </div>
            </div>
            <div className="form-row">
              <div className="form-group">
                <label className="form-label">Harga Jual *</label>
                <RupiahInput value={form.price_sell} onChange={(v) => { setForm({ ...form, price_sell: v }); setFieldErrors(prev => ({ ...prev, price_sell: '' })); }} />
                {fieldErrors.price_sell && <span style={{ fontSize: '0.75rem', color: 'var(--danger)' }}>{fieldErrors.price_sell}</span>}
              </div>
              <div className="form-group">
                <label className="form-label">Channel Tersedia</label>
                {(() => {
                  const marketplace = activeChannels.filter((ch: string) =>
                    ['tokopedia', 'shopee', 'lazada', 'tiktok shop', 'tiktok'].includes(ch.toLowerCase()),
                  );
                  const lainnya = activeChannels.filter((ch: string) =>
                    !['tokopedia', 'shopee', 'lazada', 'tiktok shop', 'tiktok'].includes(ch.toLowerCase()),
                  );
                  const renderChips = (chs: string[]) => (
                    <div className="channel-chips">
                      {chs.map((ch) => {
                        const selected = form.channels.includes(ch);
                        return (
                          <div
                            key={ch}
                            className={`channel-chip${selected ? ' active' : ''}`}
                            onClick={() =>
                              setForm(prev => ({
                                ...prev,
                                channels: selected
                                  ? prev.channels.filter((c: string) => c !== ch)
                                  : [...prev.channels, ch],
                              }))
                            }
                          >
                            {ch.charAt(0).toUpperCase() + ch.slice(1)}
                          </div>
                        );
                      })}
                    </div>
                  );
                  return (
                    <div style={{ padding: '0.5rem 0' }}>
                      {marketplace.length > 0 && (
                        <>
                          <div className="channel-group-label">Online Marketplace</div>
                          {renderChips(marketplace)}
                        </>
                      )}
                      {lainnya.length > 0 && (
                        <>
                          <div className="channel-group-label">Offline &amp; Lainnya</div>
                          {renderChips(lainnya)}
                        </>
                      )}
                    </div>
                  );
                })()}
              </div>
            </div>
            <div className="form-group">
              <label className="form-label">Stok Minimal</label>
              <input className="input" type="number" value={form.stock_min} onChange={(e) => setForm({ ...form, stock_min: e.target.value })} placeholder="Untuk peringatan stok menipis" />
            </div>

            {/* Gambar Produk */}
            <div className="form-group">
              <label className="form-label">Gambar Produk</label>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                {productImage ? (
                  <div style={{ position: 'relative' }}>
                    <img src={productImage} alt="Preview"
                      style={{ width: 80, height: 80, borderRadius: 8, objectFit: 'cover', border: '1px solid var(--border)' }}
                    />
                    <button
                      onClick={handleRemoveImage}
                      style={{
                        position: 'absolute', top: -6, right: -6, width: 20, height: 20, borderRadius: '50%',
                        border: 'none', background: 'var(--danger)', color: '#fff', cursor: 'pointer',
                        display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.7rem',
                      }}
                    >
                      <X size={12} />
                    </button>
                  </div>
                ) : (
                  <div
                    onClick={() => document.getElementById('product-image-input')?.click()}
                    style={{
                      width: 80, height: 80, borderRadius: 8, border: '2px dashed var(--border)',
                      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                      cursor: 'pointer', color: 'var(--text-muted)', fontSize: '0.7rem', gap: '0.25rem',
                      transition: 'border-color 0.2s',
                    }}
                    onMouseEnter={(e) => { (e.target as HTMLElement).style.borderColor = 'var(--primary)'; }}
                    onMouseLeave={(e) => { (e.target as HTMLElement).style.borderColor = 'var(--border)'; }}
                  >
                    <Image size={20} />
                    Upload
                  </div>
                )}
              </div>
              <input
                id="product-image-input"
                type="file"
                accept="image/*"
                style={{ display: 'none' }}
                onChange={handleImageSelect}
              />
              <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)', display: 'block', marginTop: '0.25rem' }}>
                JPEG/PNG, maks 10MB. 1 gambar per produk.
              </span>
            </div>

            {/* BOM management inline for edit mode */}
            {editProduct && (
              <>
                <hr style={{ margin: '0.5rem 0', borderColor: 'var(--border)' }} />
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <label className="form-label" style={{ margin: 0, fontWeight: 700 }}>Resep BOM (Bahan Baku)</label>
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => { setShowRecipes(!showRecipes); if (!showRecipes) recipesQuery.refetch(); }}
                    style={{ fontSize: '0.8rem' }}
                  >
                    <Package size={14} /> {showRecipes ? 'Tutup' : 'Atur Resep'}
                  </button>
                </div>
                {showRecipes && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', padding: '0.75rem', background: 'rgba(0,0,0,0.02)', borderRadius: 8, border: '1px solid var(--border)' }}>
                    <div className="form-row" style={{ alignItems: 'end' }}>
                      <div className="form-group" style={{ flex: 2 }}>
                        <label className="form-label" style={{ fontSize: '0.75rem' }}>Material</label>
                        <select className="input input-sm" value={recipeForm.material_id} onChange={(e) => setRecipeForm({ ...recipeForm, material_id: e.target.value })}>
                          <option value="">— Pilih material —</option>
                          {allMaterials.map((m) => (
                            <option key={m.id} value={m.id}>
                              {m.name} ({fmtQty(m.stock_current, m.unit)} {m.unit})
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="form-group" style={{ flex: 1 }}>
                        <label className="form-label" style={{ fontSize: '0.75rem' }}>Jumlah per Produk</label>
                        <input className="input input-sm" type="number" step="0.01" min="0" value={recipeForm.quantity_per_order} onChange={(e) => setRecipeForm({ ...recipeForm, quantity_per_order: e.target.value })} />
                      </div>
                      <button className="btn btn-primary btn-sm" onClick={addRecipe} style={{ marginBottom: 1 }}>
                        <Plus size={14} />
                      </button>
                    </div>
                    {!recipesQuery.isPending && productRecipes && productRecipes.length > 0 && (
                      <table style={{ fontSize: '0.8rem' }}>
                        <thead>
                          <tr>
                            <th style={{ padding: '0.25rem 0.5rem', textAlign: 'left' }}>Material</th>
                            <th style={{ padding: '0.25rem 0.5rem', textAlign: 'right' }}>Jumlah</th>
                            <th style={{ padding: '0.25rem 0.5rem', textAlign: 'right' }}></th>
                          </tr>
                        </thead>
                        <tbody>
                          {productRecipes.map((r) => {
                            const mat = (r as any).bom_materials as BomMaterial | undefined;
                            return (
                              <tr key={r.id}>
                                <td style={{ padding: '0.25rem 0.5rem', fontWeight: 600 }}>{mat?.name || 'Unknown'}</td>
                                <td style={{ padding: '0.25rem 0.5rem', textAlign: 'right' }}>{r.quantity_per_order} {mat?.unit || ''}</td>
                                <td style={{ padding: '0.25rem 0.5rem', textAlign: 'right' }}>
                                  <button className="btn btn-ghost btn-sm" onClick={() => deleteRecipe(r.id)} style={{ color: 'var(--danger)', padding: '0.15rem' }}>
                                    <X size={12} />
                                  </button>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    )}
                    {!recipesQuery.isPending && (!productRecipes || productRecipes.length === 0) && (
                      <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textAlign: 'center', margin: '0.5rem 0' }}>
                        Belum ada resep untuk produk ini.
                      </p>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        ) : null}

        {/* ── Step 2: Stok Awal (create only) ── */}
        {!editProduct && wizardStep === 2 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', padding: '0.5rem 0' }}>
            <div className="form-group">
              <label className="form-label">Stok Awal</label>
              <input
                className="input"
                type="number"
                min="0"
                value={stockInitial}
                onChange={(e) => setStockInitial(e.target.value)}
                placeholder="0"
              />
              <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                Jumlah stok saat pertama kali produk ditambahkan. Biarkan 0 jika belum ada stok.
              </span>
            </div>
          </div>
        )}

        {/* ── Step 3: BOM (create only) ── */}
        {!editProduct && wizardStep === 3 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', padding: '0.5rem 0' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <label className="form-label" style={{ margin: 0, fontWeight: 700 }}>Bahan Baku (Resep)</label>
              <button className="btn btn-ghost btn-sm" onClick={addBomRow}>
                <Plus size={14} /> Tambah Baris
              </button>
            </div>

            {bomRows.length === 0 && (
              <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', textAlign: 'center', padding: '1rem 0' }}>
                Belum ada bahan baku. Klik "Tambah Baris" untuk menambahkan.
              </p>
            )}

            {bomRows.map((row, index) => (
              <div key={index} className="form-row" style={{ alignItems: 'end' }}>
                <div className="form-group" style={{ flex: 2 }}>
                  <label className="form-label" style={{ fontSize: '0.75rem' }}>Material</label>
                  <select
                    className="input input-sm"
                    value={row.material_id}
                    onChange={(e) => updateBomRow(index, 'material_id', e.target.value)}
                  >
                    <option value="">— Pilih material —</option>
                    {allMaterials.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name} ({fmtQty(m.stock_current, m.unit)} {m.unit})
                      </option>
                    ))}
                  </select>
                </div>
                <div className="form-group" style={{ flex: 1 }}>
                  <label className="form-label" style={{ fontSize: '0.75rem' }}>Jumlah per Produk</label>
                  <input
                    className="input input-sm"
                    type="number" step="0.01" min="0"
                    value={row.quantity}
                    onChange={(e) => updateBomRow(index, 'quantity', e.target.value)}
                    placeholder="1"
                  />
                </div>
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => removeBomRow(index)}
                  style={{ color: 'var(--danger)', marginBottom: 1 }}
                >
                  <X size={14} />
                </button>
              </div>
            ))}

            {allMaterials.length === 0 && (
              <div className="card card-p" style={{ background: 'rgba(245,158,11,0.08)', border: '1px solid var(--warning)', textAlign: 'center', fontSize: '0.8rem' }}>
                Belum ada bahan baku. <a href="/stock/materials" style={{ fontWeight: 700 }}>Tambahkan material</a> terlebih dahulu.
              </div>
            )}
          </div>
        )}
      </Modal>

      <ConfirmModal
        open={!!deleteConfirmId}
        title="Hapus Produk"
        message="Yakin ingin menghapus produk ini? Tindakan ini tidak dapat dibatalkan."
        confirmLabel="Hapus"
        danger
        onConfirm={() => {
          if (deleteConfirmId) confirmDelete(deleteConfirmId);
          setDeleteConfirmId(null);
        }}
        onCancel={() => setDeleteConfirmId(null)}
      />
    </div>
  );
}
