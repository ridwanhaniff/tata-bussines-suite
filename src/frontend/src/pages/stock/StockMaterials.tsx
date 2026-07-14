import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useStockStore } from '../../store/stockStore';
import { bomApi } from '../../services/api';
import { Modal } from '../../components/Modal';
import { ConfirmModal } from '../../components/ConfirmModal';
import { RupiahInput } from '../../components/RupiahInput';
import { Badge } from '../../components/Badge';
import { TableSkeleton } from '../../components/LoadingSkeleton';
import { toast } from '../../components/Toast';
import { fmtRp, fmtQty, UNIT_OPTIONS } from '../../lib/utils';
import type { BomMaterial } from '../../types';
import { Plus, Edit2, Trash2, Search, AlertTriangle, RefreshCw, Package } from 'lucide-react';

export function StockMaterials() {
  const { token } = useStockStore();
  const [search, setSearch] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [editMat, setEditMat] = useState<BomMaterial | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [form, setForm] = useState({ name: '', unit: 'pcs', stock_current: '', stock_min: '', cost_per_unit: '' });
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const materialsQuery = useQuery({
    queryKey: ['materials', token],
    queryFn: () => bomApi.listMaterials(token!),
    enabled: !!token,
    staleTime: 30_000,
    gcTime: 60_000,
    select: (data) => data.materials ?? [],
  });

  const materials = materialsQuery.data ?? [];
  const loading = materialsQuery.isPending;
  const error = materialsQuery.isError;

  const filtered = materials.filter((m) =>
    m.name.toLowerCase().includes(search.toLowerCase()),
  );

  function openCreate() {
    setEditMat(null);
    setForm({ name: '', unit: 'pcs', stock_current: '', stock_min: '', cost_per_unit: '' });
    setShowModal(true);
  }

  function openEdit(m: BomMaterial) {
    setEditMat(m);
    setForm({
      name: m.name,
      unit: m.unit,
      stock_current: m.stock_current.toString(),
      stock_min: m.stock_min.toString(),
      cost_per_unit: m.cost_per_unit.toString(),
    });
    setShowModal(true);
  }

  async function save() {
    if (!token || saving) return;
    setSaving(true);
    try {
      if (editMat) {
        await bomApi.updateMaterial(token, editMat.id, {
          name: form.name,
          unit: form.unit || 'pcs',
          stock_current: form.stock_current ? Number(form.stock_current) : undefined,
          stock_min: form.stock_min ? Number(form.stock_min) : undefined,
          cost_per_unit: form.cost_per_unit ? Number(form.cost_per_unit) : undefined,
        });
        toast('Material diupdate');
      } else {
        await bomApi.addMaterial(token, {
          name: form.name,
          unit: form.unit || 'pcs',
          stock_current: form.stock_current ? Number(form.stock_current) : 0,
          stock_min: form.stock_min ? Number(form.stock_min) : 0,
          cost_per_unit: form.cost_per_unit ? Number(form.cost_per_unit) : 0,
        });
        toast('Material ditambahkan');
      }
      setShowModal(false);
      materialsQuery.refetch();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Gagal simpan material');
    } finally {
      setSaving(false);
    }
  }

  async function confirmDelete(id: string) {
    if (!token || deleting) return;
    setDeleting(true);
    try {
      await bomApi.deleteMaterial(token!, id);
      toast('Material dihapus');
      materialsQuery.refetch();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Gagal hapus material');
    } finally {
      setDeleting(false);
    }
  }

  function stockStatus(stock: number, min: number): string {
    if (stock <= 0) return 'habis';
    if (min > 0 && stock <= min) return 'menipis';
    return 'aman';
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '1rem' }}>
        <div>
          <h2 style={{ fontSize: '1.5rem', fontWeight: 800 }}>Bahan Baku</h2>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.875rem' }}>Kelola material produksi & kemasan</p>
        </div>
        <button className="btn btn-primary btn-sm" onClick={openCreate}>
          <Plus size={16} /> Tambah Material
        </button>
      </div>

      <div style={{ position: 'relative', maxWidth: 300 }}>
        <Search size={16} style={{ position: 'absolute', left: '0.75rem', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
        <input
          className="input input-sm"
          placeholder="Cari material..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ paddingLeft: '2rem' }}
        />
      </div>

      {loading ? (
        <TableSkeleton rows={6} cols={5} />
      ) : error ? (
        <div className="card card-p" style={{ textAlign: 'center', padding: '3rem', borderColor: 'var(--danger)', borderWidth: 2 }}>
          <AlertTriangle size={36} style={{ color: 'var(--danger)', marginBottom: '1rem' }} />
          <div style={{ fontSize: '1.1rem', fontWeight: 700, marginBottom: '0.5rem' }}>Gagal Memuat Data</div>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem', maxWidth: 400, margin: '0 auto 1rem' }}>
            Server penyimpanan data sedang tidak dapat dijangkau.
          </p>
          <button className="btn btn-primary btn-sm" onClick={() => materialsQuery.refetch()}>
            <RefreshCw size={14} /> Coba Lagi
          </button>
        </div>
      ) : filtered.length === 0 ? (
        <div className="card card-p" style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-muted)' }}>
          {materials.length === 0 ? 'Belum ada material. Klik "Tambah Material" untuk memulai.' : 'Tidak ditemukan'}
        </div>
      ) : (
        <div className="tbl-wrap">
          <table>
            <thead>
              <tr>
                <th>Nama</th>
                <th>Satuan</th>
                <th>Stok</th>
                <th>Biaya/satuan</th>
                <th>Stok Minimal</th>
                <th>Status</th>
                <th>Aksi</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((m) => (
                <tr key={m.id}>
                  <td style={{ fontWeight: 600 }}>{m.name}</td>
                  <td style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>{m.unit}</td>
                  <td>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <div className="progress" style={{ width: 80 }}>
                        <div
                          className="progress-fill"
                          style={{
                            width: `${Math.min(((m.stock_current ?? 0) / Math.max(m.stock_min || 10, 1)) * 100, 100)}%`,
                            background: (m.stock_current ?? 0) <= 0 ? 'var(--danger)' : (m.stock_min && (m.stock_current ?? 0) <= m.stock_min ? 'var(--warning)' : 'var(--primary)'),
                          }}
                        />
                      </div>
                      {fmtQty(m.stock_current, m.unit)}
                    </div>
                  </td>
                  <td style={{ fontWeight: 600, fontSize: '0.8rem' }}>{fmtRp(m.cost_per_unit)}</td>
                  <td style={{ fontSize: '0.8rem' }}>{m.stock_min > 0 ? fmtQty(m.stock_min, m.unit) : '-'}</td>
                  <td>
                    <Badge variant={stockStatus(m.stock_current, m.stock_min)}>
                      {stockStatus(m.stock_current, m.stock_min) === 'aman' ? 'Aman' : stockStatus(m.stock_current, m.stock_min) === 'menipis' ? 'Menipis' : 'Habis'}
                    </Badge>
                  </td>
                  <td>
                    <div className="row-actions">
                      <button className="btn btn-ghost btn-sm" onClick={() => openEdit(m)}>
                        <Edit2 size={14} />
                      </button>
                      <button className="btn btn-ghost btn-sm" onClick={() => setDeleteId(m.id)} style={{ color: 'var(--danger)' }}>
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

      <Modal
        open={showModal}
        onClose={() => setShowModal(false)}
        title={editMat ? 'Edit Material' : 'Tambah Material'}
        footer={
          <>
            <button className="btn btn-secondary" onClick={() => setShowModal(false)}>Batal</button>
            <button className="btn btn-primary" onClick={save} disabled={saving}>{saving ? 'Menyimpan...' : 'Simpan'}</button>
          </>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <div className="form-group">
            <label className="form-label">Nama Material</label>
            <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required placeholder="Kain Cotton, Benang, Kancing..." />
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
              <label className="form-label">Biaya per Satuan</label>
              <RupiahInput value={form.cost_per_unit} onChange={(v) => setForm({ ...form, cost_per_unit: v })} />
              <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: '0.15rem', display: 'block' }}>
                Diperlukan untuk perhitungan biaya BOM produk
              </span>
            </div>
          </div>
          <div className="form-row">
            <div className="form-group">
              <label className="form-label">Stok Saat Ini</label>
              <input className="input" type="number" value={form.stock_current} onChange={(e) => setForm({ ...form, stock_current: e.target.value })} />
            </div>
            <div className="form-group">
              <label className="form-label">Stok Minimal</label>
              <input className="input" type="number" value={form.stock_min} onChange={(e) => setForm({ ...form, stock_min: e.target.value })} placeholder="Untuk peringatan" />
            </div>
          </div>
        </div>
      </Modal>

      <ConfirmModal
        open={!!deleteId}
        title="Hapus Material"
        message="Yakin ingin menghapus material ini? Material akan dinonaktifkan, data resep tetap tersimpan."
        confirmLabel="Hapus"
        danger
        loading={deleting}
        onConfirm={() => {
          if (deleteId) confirmDelete(deleteId);
          setDeleteId(null);
        }}
        onCancel={() => setDeleteId(null)}
      />
    </div>
  );
}
