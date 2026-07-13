const BASE = '';

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${url}`, {
    credentials: 'include',
    ...options,
    headers: { 'Content-Type': 'application/json', ...options?.headers },
  });

  if (res.status === 401 || res.status === 403) {
    if (window.location.pathname !== '/login') {
      window.location.href = '/login';
    }
    throw new Error('Unauthorized');
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }

  const body = await res.json();
  if (body && typeof body === 'object' && 'success' in body && body.success === true && 'data' in body) {
    return body.data as T;
  }
  return body as T;
}

export const api = {
  get<T>(url: string): Promise<T> {
    return request<T>(url);
  },
  post<T>(url: string, body?: unknown): Promise<T> {
    return request<T>(url, {
      method: 'POST',
      body: body ? JSON.stringify(body) : undefined,
    });
  },
  put<T>(url: string, body?: unknown): Promise<T> {
    return request<T>(url, {
      method: 'PUT',
      body: body ? JSON.stringify(body) : undefined,
    });
  },
  del<T>(url: string): Promise<T> {
    return request<T>(url, { method: 'DELETE' });
  },
};

async function stockRequest<T>(url: string, token: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${url}`, {
    credentials: 'include',
    ...options,
    headers: { 'Content-Type': 'application/json', 'x-stock-token': token, ...options?.headers },
  });

  if (res.status === 401 || res.status === 403) {
    localStorage.removeItem('tbs_token');
    throw new Error('Sesi habis. Silakan login ulang.');
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }

  const body = await res.json();
  if (body && typeof body === 'object' && 'success' in body && body.success === true && 'data' in body) {
    return body.data as T;
  }
  return body as T;
}

export const stockApi = {
  get<T>(url: string, token: string): Promise<T> {
    return stockRequest<T>(url, token);
  },
  post<T>(url: string, token: string, body?: unknown): Promise<T> {
    return stockRequest<T>(url, token, {
      method: 'POST',
      body: body ? JSON.stringify(body) : undefined,
    });
  },
  put<T>(url: string, token: string, body?: unknown): Promise<T> {
    return stockRequest<T>(url, token, {
      method: 'PUT',
      body: body ? JSON.stringify(body) : undefined,
    });
  },
  del<T>(url: string, token: string): Promise<T> {
    return stockRequest<T>(url, token, {
      method: 'DELETE',
    });
  },
  patch<T>(url: string, token: string, body?: unknown): Promise<T> {
    return stockRequest<T>(url, token, {
      method: 'PATCH',
      body: body ? JSON.stringify(body) : undefined,
    });
  },
};

// ── BOM / Material API helpers ──
export const bomApi = {
  listMaterials(token: string) {
    return stockApi.get<{ materials: import('../types').BomMaterial[] }>('/api/stock/materials', token);
  },
  addMaterial(
    token: string,
    data: { name: string; unit?: string; stock_current?: number; stock_min?: number; cost_per_unit?: number },
  ) {
    return stockApi.post<{ material: import('../types').BomMaterial }>('/api/stock/materials', token, data);
  },
  updateMaterial(token: string, id: string, data: Record<string, unknown>) {
    return stockApi.put<{ material: import('../types').BomMaterial }>(`/api/stock/materials/${id}`, token, data);
  },
  deleteMaterial(token: string, id: string) {
    return stockApi.del<{ success: boolean }>(`/api/stock/materials/${id}`, token);
  },
  listRecipes(token: string, productId?: string) {
    const qs = productId ? `?product_id=${productId}` : '';
    return stockApi.get<{ recipes: import('../types').BomRecipe[] }>(`/api/stock/materials/recipes${qs}`, token);
  },
  setRecipe(token: string, data: { material_id: string; product_id?: string | null; quantity_per_order: number }) {
    return stockApi.post<{ recipe: import('../types').BomRecipe }>('/api/stock/materials/recipes', token, data);
  },
  deleteRecipe(token: string, id: string) {
    return stockApi.del<{ success: boolean }>(`/api/stock/materials/recipes/${id}`, token);
  },
  getDeductionLogs(token: string, limit = 50) {
    return stockApi.get<{ logs: import('../types').BomDeductionLog[] }>(
      `/api/stock/materials/logs?limit=${limit}`,
      token,
    );
  },
};
