import supabase, { pgPool } from '../config/supabase';
import { addLog, getIO } from '../config/state';
import { sanitizeError } from './errors';

import { withTransaction } from './db';
import { syncInventory } from './inventory';
import type { PoolClient } from 'pg';

// ── Helpers ──
function formatQty(qty: number, unit: string): string {
  const num = parseFloat(String(qty)) || 0;
  if (['kg', 'liter', 'gram', 'ml'].includes(unit)) {
    return num.toFixed(2).replace(/\.?0+$/, '');
  }
  return Math.floor(num).toString();
}

// ── Product Management ──

interface AddProductData {
  sku?: string;
  name: string;
  category?: string;
  unit?: string;
  priceBuy?: number;
  priceSell?: number;
  stockInitial?: number;
  stockMin?: number;
  description?: string;
  supplier?: string;
  location?: string;
  defaultChannel?: string;
  channels?: string[];
}

interface UpdateProductData {
  name?: string;
  category?: string;
  unit?: string;
  price_buy?: number;
  price_sell?: number;
  stock_min?: number;
  description?: string;
  is_active?: boolean;
}

interface StockMovementData {
  type: string;
  quantity: number;
  stockBefore: number;
  stockAfter: number;
  referenceType?: string;
  referenceId?: string;
  note?: string;
  createdBy?: string;
}

interface Result {
  success: boolean;
  error?: string;
  [key: string]: unknown;
}

async function addProduct(
  userId: string,
  data: AddProductData,
): Promise<{ success: boolean; product?: unknown; error?: string }> {
  const { sku, name, category, unit, priceBuy, priceSell, stockInitial, stockMin, description, supplier, location, defaultChannel, channels } = data;
  if (!name) {
    return { success: false, error: 'Nama produk wajib diisi.' };
  }
  const effectiveSku = (sku || name).toUpperCase().replace(/\s+/g, '-').slice(0, 50);
  try {
    return await withTransaction(async (client) => {
      const prod = await client.query(
        `INSERT INTO products (user_id, sku, name, category, unit, price_buy, price_sell, stock_current, stock_min, description, supplier, location, default_channel, channels)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         RETURNING *`,
        [
          userId,
          effectiveSku,
          name,
          category || 'Umum',
          unit || 'pcs',
          priceBuy || 0,
          priceSell || 0,
          stockInitial || 0,
          stockMin || 0,
          description || null,
          supplier || null,
          location || null,
          defaultChannel || '',
          channels || [],
        ],
      );
      const product = prod.rows[0];
      const initialStock = stockInitial || 0;
      if (initialStock > 0) {
        await client.query(
          `INSERT INTO stock_movements (user_id, product_id, type, quantity, stock_before, stock_after, reference_type, note, created_by)
           VALUES ($1, $2, 'in', $3, 0, $3, 'initial', 'Stock awal saat produk ditambahkan', 'system')`,
          [userId, product.id, initialStock],
        );
      }
      await syncInventory(userId, String(product.id), initialStock, 'Utama', client);
      return { success: true, product, error: undefined };
    });
  } catch (err: any) {
    if (err?.code === '23505' || (err.message && err.message.includes('duplicate key'))) {
      addLog('warn', `[STOCK] addProduct: SKU "${effectiveSku}" sudah digunakan`);
      return { success: false, error: `SKU "${effectiveSku}" sudah digunakan. Gunakan SKU lain.` };
    }
    addLog('error', '[STOCK] addProduct error: ' + (err.message || err));
    return { success: false, error: sanitizeError(err) };
  }
}

async function updateProduct(
  userId: string,
  productId: string,
  updates: UpdateProductData,
): Promise<{ success: boolean; product?: unknown; error?: string }> {
  try {
    const allowed = ['name', 'category', 'unit', 'price_buy', 'price_sell', 'stock_min', 'description', 'is_active'];
    const payload: Record<string, unknown> = {};
    Object.keys(updates).forEach((k) => {
      if (allowed.includes(k)) payload[k] = (updates as any)[k];
    });
    if (Object.keys(payload).length === 0) {
      return { success: false, error: 'Tidak ada data yang diupdate.' };
    }
    const { data, error } = await supabase
      .from('products')
      .update(payload)
      .eq('id', productId)
      .eq('user_id', userId)
      .select()
      .single();
    if (error) throw error;
    return { success: true, product: data, error: undefined };
  } catch (err: any) {
    return { success: false, error: sanitizeError(err) };
  }
}

async function deleteProduct(userId: string, productId: string): Promise<{ success: boolean; error?: string }> {
  try {
    const { error } = await supabase
      .from('products')
      .update({ is_active: false })
      .eq('id', productId)
      .eq('user_id', userId);
    if (error) throw error;
    return { success: true, error: undefined };
  } catch (err: any) {
    return { success: false, error: sanitizeError(err) };
  }
}

async function getProduct(
  userId: string,
  skuOrId: string,
): Promise<{ success: boolean; product?: unknown; error?: string }> {
  try {
    let query = supabase.from('products').select('*').eq('user_id', userId);
    if (isNaN(Number(skuOrId))) {
      query = (query as any).eq('sku', skuOrId.toUpperCase());
    } else {
      query = (query as any).eq('id', parseInt(skuOrId));
    }
    const { data, error } = await (query as any).single();
    if (error) throw error;
    return { success: true, product: data, error: undefined };
  } catch (err: any) {
    return { success: false, error: sanitizeError(err) };
  }
}

// ── Smart Product Search ──

async function searchProductByName(
  userId: string,
  query: string,
): Promise<{ success: boolean; products: unknown[]; error?: string }> {
  try {
    if (!query || query.trim().length < 2) {
      return { success: false, products: [], error: 'Kata kunci pencarian minimal 2 karakter.' };
    }
    const searchTerm = query.trim();
    const safeTerm = searchTerm.replace(/[%_]/g, '\\$&');
    const { data, error } = await supabase
      .from('products')
      .select('*')
      .eq('user_id', userId)
      .eq('is_active', true)
      .ilike('name', `%${safeTerm}%`)
      .order('name', { ascending: true })
      .limit(5);
    if (error) throw error;
    return { success: true, products: data || [], error: undefined };
  } catch (err: any) {
    addLog('error', '[STOCK] searchProductByName error: ' + err.message);
    return { success: false, products: [], error: sanitizeError(err) };
  }
}

// ── Stock Movement ──

async function logStockMovement(userId: string, productId: string, data: StockMovementData): Promise<boolean> {
  try {
    const { error } = await supabase.from('stock_movements').insert([
      {
        user_id: userId,
        product_id: productId,
        type: data.type,
        quantity: data.quantity,
        stock_before: data.stockBefore,
        stock_after: data.stockAfter,
        reference_type: data.referenceType,
        reference_id: data.referenceId,
        note: data.note,
        created_by: data.createdBy || 'system',
      },
    ] as any);
    if (error) {
      addLog('error', '[STOCK] logStockMovement error: ' + error.message);
      return false;
    }
    return true;
  } catch (err: any) {
    addLog('error', '[STOCK] logStockMovement exception: ' + err.message);
    return false;
  }
}

async function getStockHistory(
  userId: string,
  productId: string,
  limit = 50,
): Promise<{ success: boolean; movements?: unknown[]; error?: string }> {
  try {
    const { data, error } = await supabase
      .from('stock_movements')
      .select('*')
      .eq('user_id', userId)
      .eq('product_id', productId)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw error;
    return { success: true, movements: data || [], error: undefined };
  } catch (err: any) {
    return { success: false, error: sanitizeError(err) };
  }
}

// ── Stock Alerts ──

async function createStockAlert(
  userId: string,
  productId: string,
  alertType: string,
  stockLevel: number,
): Promise<void> {
  try {
    const { data: recent } = (await supabase
      .from('stock_alerts')
      .select('id')
      .eq('product_id', productId)
      .eq('user_id', userId)
      .eq('alert_type', alertType)
      .is('resolved_at', null)
      .gte('alerted_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
      .maybeSingle()) as any;
    if (recent) return;
    await supabase.from('stock_alerts').insert([
      {
        user_id: userId,
        product_id: productId,
        alert_type: alertType,
        stock_level: stockLevel,
      },
    ] as any);

    const io = getIO();
    if (io) {
      try {
        const { data: prod } = await supabase.from('products').select('name').eq('id', productId).single();
        io.to(userId).emit('stock_alert', { userId, productId, alertType, stockLevel, products: prod || null });
      } catch {
        io.to(userId).emit('stock_alert', { userId, productId, alertType, stockLevel });
      }
    }
  } catch (err: any) {
    addLog('error', '[STOCK] createStockAlert error: ' + err.message);
  }
}

async function resolveStockAlerts(productId: string, userId?: string): Promise<void> {
  try {
    let query: any = supabase
      .from('stock_alerts')
      .update({ resolved_at: new Date().toISOString() })
      .eq('product_id', productId)
      .is('resolved_at', null);
    if (userId) query = query.eq('user_id', userId);
    await query;
  } catch (err: any) {
    addLog('error', '[STOCK] resolveStockAlerts error: ' + err.message);
  }
}

async function getPendingAlerts(userId: string): Promise<{ success: boolean; alerts?: any[]; error?: string }> {
  try {
    let query: any = supabase
      .from('stock_alerts')
      .select('*, products (id, sku, name, unit, stock_current, stock_min)')
      .is('resolved_at', null)
      .order('alerted_at', { ascending: false });
    if (userId) query = query.eq('user_id', userId);
    const { data, error } = await query;
    if (error) throw error;
    return { success: true, alerts: data || [], error: undefined };
  } catch (err: any) {
    try {
      const pool = pgPool;
      if (!pool) return { success: false, error: sanitizeError(err) };
      const { rows } = await pool.query(
        `SELECT sa.id, sa.product_id, sa.alert_type, sa.stock_level, sa.alerted_at, sa.resolved_at,
                row_to_json(p.*) AS products
         FROM stock_alerts sa
         LEFT JOIN products p ON p.id = sa.product_id AND p.user_id = sa.user_id
         WHERE sa.user_id = $1 AND sa.resolved_at IS NULL
         ORDER BY sa.alerted_at DESC`,
        [userId],
      );
      const alerts = rows.map((r: any) => ({
        ...r,
        alert_type: r.alert_type,
        products: r.products,
      }));
      return { success: true, alerts, error: undefined };
    } catch (pgErr: any) {
      addLog('error', '[STOCK] getPendingAlerts pgPool fallback error: ' + pgErr.message);
      return { success: false, error: sanitizeError(err) };
    }
  }
}

// ── Stock Report ──

async function generateStockReport(userId: string): Promise<Result> {
  try {
    const { data: products, error } = await supabase
      .from('products')
      .select('*')
      .eq('user_id', userId)
      .eq('is_active', true)
      .order('category', { ascending: true })
      .order('name', { ascending: true });
    if (error) throw error;
    let totalValue = 0;
    const byCategory: Record<string, { count: number; value: number; items: unknown[] }> = {};
    (products || []).forEach((p: any) => {
      const value = parseFloat(p.stock_current) * parseFloat(p.price_buy);
      totalValue += value;
      if (!byCategory[p.category]) {
        byCategory[p.category] = { count: 0, value: 0, items: [] };
      }
      byCategory[p.category].count++;
      byCategory[p.category].value += value;
      byCategory[p.category].items.push(p);
    });
    return { success: true, totalProducts: products.length, totalValue, byCategory, products, error: undefined };
  } catch (err: any) {
    return { success: false, error: sanitizeError(err) };
  }
}

// ── BOM ──

interface AddMaterialData {
  name: string;
  unit?: string;
  stockCurrent?: number;
  stockMin?: number;
  costPerUnit?: number;
}

async function addMaterial(
  userId: string,
  data: AddMaterialData,
): Promise<{ success: boolean; material?: unknown; error?: string }> {
  const { name, unit, stockCurrent, stockMin, costPerUnit } = data;
  if (!name) return { success: false, error: 'Nama material wajib diisi.' };
  try {
    const { data: material, error } = await supabase
      .from('bom_materials')
      .insert([{ user_id: userId, name, unit: unit || 'pcs', stock_current: parseFloat(String(stockCurrent)) || 0, stock_min: parseFloat(String(stockMin)) || 0, cost_per_unit: parseFloat(String(costPerUnit)) || 0 }])
      .select()
      .single();
    if (error) throw error;
    return { success: true, material, error: undefined };
  } catch (err: any) {
    if (!pgPool) return { success: false, error: sanitizeError(err) };
    try {
      const result = await pgPool.query(
        `INSERT INTO bom_materials (user_id, name, unit, stock_current, stock_min, cost_per_unit) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [userId, name, unit || 'pcs', parseFloat(String(stockCurrent)) || 0, parseFloat(String(stockMin)) || 0, parseFloat(String(costPerUnit)) || 0],
      );
      return { success: true, material: result.rows[0], error: undefined };
    } catch (pgErr: any) {
      addLog('error', '[BOM] addMaterial pgPool fallback error: ' + pgErr.message);
      return { success: false, error: sanitizeError(pgErr) };
    }
  }
}

async function listMaterials(userId: string): Promise<{ success: boolean; materials?: unknown[]; error?: string }> {
  try {
    const { data, error } = await supabase
      .from('bom_materials')
      .select('*')
      .eq('user_id', userId)
      .eq('is_active', true)
      .order('name', { ascending: true });
    if (error) throw error;
    return { success: true, materials: data || [], error: undefined };
  } catch (err: any) {
    if (!pgPool) return { success: false, error: sanitizeError(err) };
    try {
      const result = await pgPool.query(
        `SELECT * FROM bom_materials WHERE user_id = $1 AND is_active = true ORDER BY name ASC`,
        [userId],
      );
      return { success: true, materials: result.rows || [], error: undefined };
    } catch (pgErr: any) {
      return { success: false, error: sanitizeError(pgErr) };
    }
  }
}

async function updateMaterial(
  userId: string,
  materialId: string,
  data: Partial<AddMaterialData>,
): Promise<{ success: boolean; material?: unknown; error?: string }> {
  const updates: string[] = [];
  const params: any[] = [];
  let idx = 1;
  if (data.name !== undefined) { updates.push(`name = $${idx++}`); params.push(data.name); }
  if (data.unit !== undefined) { updates.push(`unit = $${idx++}`); params.push(data.unit); }
  if (data.stockCurrent !== undefined) { updates.push(`stock_current = $${idx++}`); params.push(parseFloat(String(data.stockCurrent))); }
  if (data.stockMin !== undefined) { updates.push(`stock_min = $${idx++}`); params.push(parseFloat(String(data.stockMin))); }
  if (data.costPerUnit !== undefined) { updates.push(`cost_per_unit = $${idx++}`); params.push(parseFloat(String(data.costPerUnit))); }
  updates.push(`updated_at = now()`);
  params.push(userId, materialId);
  const setClause = updates.join(', ');
  try {
    const result = await pgPool!.query(
      `UPDATE bom_materials SET ${setClause} WHERE user_id = $${idx++} AND id = $${idx} RETURNING *`,
      params,
    );
    if (result.rows.length === 0) return { success: false, error: 'Material tidak ditemukan' };
    return { success: true, material: result.rows[0], error: undefined };
  } catch (err: any) {
    addLog('error', '[BOM] updateMaterial error: ' + err.message);
    return { success: false, error: sanitizeError(err) };
  }
}

async function deleteMaterial(userId: string, materialId: string): Promise<{ success: boolean; error?: string }> {
  try {
    const { error } = await supabase
      .from('bom_materials')
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq('id', materialId)
      .eq('user_id', userId);
    if (error) throw error;
    return { success: true, error: undefined };
  } catch (err: any) {
    if (!pgPool) return { success: false, error: sanitizeError(err) };
    try {
      await pgPool.query(
        `UPDATE bom_materials SET is_active = false, updated_at = now() WHERE id = $1 AND user_id = $2`,
        [materialId, userId],
      );
      return { success: true, error: undefined };
    } catch (pgErr: any) {
      return { success: false, error: sanitizeError(pgErr) };
    }
  }
}

async function setRecipe(
  userId: string,
  materialId: string,
  qtyPerOrder: number,
  productId: string | null = null,
): Promise<{ success: boolean; recipe?: unknown; error?: string }> {
  const qty = parseFloat(String(qtyPerOrder));
  if (isNaN(qty) || qty <= 0) {
    return { success: false, error: 'Jumlah per order harus lebih dari 0.' };
  }
  try {
    const { data: existing } = (await supabase
      .from('bom_recipes')
      .select('id')
      .eq('user_id', userId)
      .eq('material_id', materialId)
      .eq('product_id', productId)
      .maybeSingle()) as any;
    let recipe: unknown;
    let error: any;
    if (existing) {
      const result = await supabase
        .from('bom_recipes')
        .update({ quantity_per_order: qty, auto_deduct: true })
        .eq('id', existing.id)
        .select()
        .single();
      recipe = result.data;
      error = result.error;
    } else {
      const result = await supabase
        .from('bom_recipes')
        .insert([{ user_id: userId, material_id: materialId, product_id: productId, quantity_per_order: qty, auto_deduct: true }])
        .select()
        .single();
      recipe = result.data;
      error = result.error;
    }
    if (error) throw error;
    return { success: true, recipe, error: undefined };
  } catch (err: any) {
    if (!pgPool) return { success: false, error: sanitizeError(err) };
    try {
      const existing = await pgPool.query(
        `SELECT id FROM bom_recipes WHERE user_id = $1 AND material_id = $2 AND (product_id = $3 OR (product_id IS NULL AND $3 IS NULL))`,
        [userId, materialId, productId],
      );
      let recipe;
      if (existing.rows.length > 0) {
        const r = await pgPool.query(
          `UPDATE bom_recipes SET quantity_per_order = $1, auto_deduct = true WHERE id = $2 RETURNING *`,
          [qty, existing.rows[0].id],
        );
        recipe = r.rows[0];
      } else {
        const r = await pgPool.query(
          `INSERT INTO bom_recipes (user_id, material_id, product_id, quantity_per_order, auto_deduct) VALUES ($1, $2, $3, $4, true) RETURNING *`,
          [userId, materialId, productId, qty],
        );
        recipe = r.rows[0];
      }
      return { success: true, recipe, error: undefined };
    } catch (pgErr: any) {
      addLog('error', '[BOM] setRecipe pgPool fallback error: ' + pgErr.message);
      return { success: false, error: sanitizeError(pgErr) };
    }
  }
}

async function getRecipes(
  userId: string,
  productId?: string | null,
): Promise<{ success: boolean; recipes: unknown[]; error?: string }> {
  try {
    let query = supabase
      .from('bom_recipes')
      .select('*, bom_materials(id, name, unit, stock_current, stock_min)')
      .eq('user_id', userId)
      .eq('auto_deduct', true);
    if (productId) query = query.eq('product_id', productId);
    if (productId === null) query = query.is('product_id', null);
    const { data, error } = await query.order('created_at', { ascending: true });
    if (error) throw error;
    return { success: true, recipes: data || [], error: undefined };
  } catch (err: any) {
    if (!pgPool) return { success: false, recipes: [], error: sanitizeError(err) };
    try {
      let sql = `SELECT r.*, row_to_json(m.*) as bom_materials FROM bom_recipes r JOIN bom_materials m ON m.id = r.material_id WHERE r.user_id = $1 AND r.auto_deduct = true`;
      const params: any[] = [userId];
      let idx = 2;
      if (productId !== undefined) {
        sql += ` AND (r.product_id = $${idx} OR r.product_id IS NULL)`;
        params.push(productId);
        idx++;
      }
      sql += ` ORDER BY r.created_at ASC`;
      const result = await pgPool.query(sql, params);
      const recipes = result.rows.map((r: any) => {
        if (typeof r.bom_materials === 'string') r.bom_materials = JSON.parse(r.bom_materials);
        return r;
      });
      return { success: true, recipes, error: undefined };
    } catch (pgErr: any) {
      return { success: false, recipes: [], error: sanitizeError(pgErr) };
    }
  }
}

async function listRecipes(userId: string): Promise<{ success: boolean; recipes: unknown[]; error?: string }> {
  try {
    const { data, error } = await supabase
      .from('bom_recipes')
      .select('*, bom_materials(id, name, unit, stock_current, stock_min)')
      .eq('user_id', userId)
      .order('created_at', { ascending: true });
    if (error) throw error;
    return { success: true, recipes: data || [], error: undefined };
  } catch (err: any) {
    if (!pgPool) return { success: false, recipes: [], error: sanitizeError(err) };
    try {
      const result = await pgPool.query(
        `SELECT r.*, row_to_json(m.*) as bom_materials FROM bom_recipes r JOIN bom_materials m ON m.id = r.material_id WHERE r.user_id = $1 ORDER BY r.created_at ASC`,
        [userId],
      );
      return { success: true, recipes: result.rows.map((r: any) => { if (typeof r.bom_materials === 'string') r.bom_materials = JSON.parse(r.bom_materials); return r; }), error: undefined };
    } catch (pgErr: any) {
      return { success: false, recipes: [], error: sanitizeError(pgErr) };
    }
  }
}

async function deleteRecipe(userId: string, recipeId: string): Promise<{ success: boolean; error?: string }> {
  try {
    const { error } = await supabase.from('bom_recipes').delete().eq('id', recipeId).eq('user_id', userId);
    if (error) throw error;
    return { success: true, error: undefined };
  } catch (err: any) {
    if (!pgPool) return { success: false, error: sanitizeError(err) };
    try {
      await pgPool.query(`DELETE FROM bom_recipes WHERE id = $1 AND user_id = $2`, [recipeId, userId]);
      return { success: true, error: undefined };
    } catch (pgErr: any) {
      return { success: false, error: sanitizeError(pgErr) };
    }
  }
}

async function getDeductionLogs(
  userId: string,
  limit = 50,
): Promise<{ success: boolean; logs: unknown[]; error?: string }> {
  try {
    const { data, error } = await supabase
      .from('bom_deduction_logs')
      .select('*, bom_materials(id, name, unit)')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw error;
    return { success: true, logs: data || [], error: undefined };
  } catch (err: any) {
    if (!pgPool) return { success: false, logs: [], error: sanitizeError(err) };
    try {
      const result = await pgPool.query(
        `SELECT l.*, row_to_json(m.*) as bom_materials FROM bom_deduction_logs l JOIN bom_materials m ON m.id = l.material_id WHERE l.user_id = $1 ORDER BY l.created_at DESC LIMIT $2`,
        [userId, limit],
      );
      const logs = result.rows.map((r: any) => { if (typeof r.bom_materials === 'string') r.bom_materials = JSON.parse(r.bom_materials); return r; });
      return { success: true, logs, error: undefined };
    } catch (pgErr: any) {
      return { success: false, logs: [], error: sanitizeError(pgErr) };
    }
  }
}

async function deductPackaging(
  userId: string,
  orderQty = 1,
  referenceNote = '',
  productId?: string,
): Promise<{ success: boolean; deducted: any[]; warnings: string[]; error?: string }> {
  const deducted: any[] = [];
  const warnings: string[] = [];
  try {
    const recipeResult = await getRecipes(userId, productId);
    if (!recipeResult.success || (recipeResult.recipes as any[]).length === 0) {
      return { success: true, deducted, warnings: ['Belum ada resep BOM diatur.'] };
    }
    for (const recipe of recipeResult.recipes as any[]) {
      const material = recipe.bom_materials;
      if (!material) continue;
      const MAX_BOM_RETRIES = 3;
      for (let bomAttempt = 0; bomAttempt < MAX_BOM_RETRIES; bomAttempt++) {
        const { data: freshMaterial } = (await supabase
          .from('bom_materials')
          .select('stock_current')
          .eq('id', material.id)
          .single()) as any;
        const currentStock = freshMaterial
          ? parseFloat(freshMaterial.stock_current) || 0
          : parseFloat(material.stock_current) || 0;
        const qtyNeeded = parseFloat(recipe.quantity_per_order) * orderQty;
        const stockBefore = currentStock;
        const stockAfter = stockBefore - qtyNeeded;
        const updateResult = (await supabase
          .from('bom_materials')
          .update({ stock_current: Math.max(0, stockAfter), updated_at: new Date().toISOString() })
          .eq('id', material.id)
          .eq('user_id', userId)
          .eq('stock_current', stockBefore)) as any;
        const updateErr = updateResult.error;
        const updateCount = updateResult.count;
        if (updateErr) {
          warnings.push(`Gagal kurangi ${material.name}: ${updateErr.message}`);
          break;
        }
        if (updateCount === 0 && bomAttempt < MAX_BOM_RETRIES - 1) {
          await new Promise((r) => setTimeout(r, 30 * (bomAttempt + 1)));
          continue;
        }
        await supabase.from('bom_deduction_logs').insert([
          {
            user_id: userId,
            material_id: material.id,
            quantity: qtyNeeded,
            stock_before: stockBefore,
            stock_after: Math.max(0, stockAfter),
            reference_type: 'sale',
            reference_note: referenceNote,
          },
        ] as any);
        deducted.push({
          name: material.name,
          deducted: qtyNeeded,
          stockBefore,
          stockAfter: Math.max(0, stockAfter),
          unit: material.unit,
        });
        if (stockAfter <= 0) warnings.push(`⚠️ Material *${material.name}* HABIS! Segera restock.`);
        else if (stockAfter <= parseFloat(material.stock_min))
          warnings.push(`⚠️ Material *${material.name}* menipis (sisa ${formatQty(stockAfter, material.unit)} ${material.unit}).`);
        break;
      }
    }
    return { success: true, deducted, warnings, error: undefined };
  } catch (err: any) {
    addLog('error', '[BOM] deductPackaging error: ' + err.message);
    return { success: false, deducted, warnings, error: sanitizeError(err) };
  }
}

export {
  addProduct,
  updateProduct,
  deleteProduct,
  getProduct,
  searchProductByName,
  getStockHistory,
  getPendingAlerts,
  resolveStockAlerts,
  generateStockReport,
  formatQty,
  addMaterial,
  listMaterials,
  updateMaterial,
  deleteMaterial,
  setRecipe,
  getRecipes,
  listRecipes,
  deleteRecipe,
  getDeductionLogs,
  deductPackaging,
};
