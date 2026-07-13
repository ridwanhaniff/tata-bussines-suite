function getLocale(): string {
  try {
    return localStorage.getItem('i18nextLng') || 'id-ID';
  } catch {
    return 'id-ID';
  }
}

function locale(): string {
  const lng = getLocale();
  if (lng === 'en') return 'en-US';
  return 'id-ID';
}

export function fmtRp(value: number): string {
  if (typeof value !== 'number' || isNaN(value)) return 'Rp0';
  return new Intl.NumberFormat(locale(), {
    style: 'currency',
    currency: 'IDR',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value);
}

export function fmtCurrency(value: number, currency = 'IDR'): string {
  if (typeof value !== 'number' || isNaN(value)) return `${currency}0`;
  return new Intl.NumberFormat(locale(), {
    style: 'currency',
    currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value);
}

export function fmtQty(value: number, unit?: string | null): string {
  if (typeof value !== 'number' || isNaN(value)) return '0';
  const decimals = unit && ['kg', 'liter', 'gram', 'ml'].includes(unit) ? 2 : 0;
  return value.toLocaleString(locale(), {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

export function fmtDate(dateStr: string | null | undefined): string {
  if (!dateStr) return '-';
  return new Date(dateStr).toLocaleDateString(locale(), {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export function fmtDateTime(dateStr: string | null | undefined): string {
  if (!dateStr) return '-';
  return new Date(dateStr).toLocaleString(locale(), {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function escapeHTML(str: string): string {
  const div = document.createElement('div');
  div.appendChild(document.createTextNode(str));
  return div.innerHTML;
}

export const UNIT_OPTIONS = [
  'pcs',
  'kg',
  'gram',
  'liter',
  'ml',
  'meter',
  'cm',
  'inch',
  'box',
  'pack',
  'dus',
  'karton',
  'botol',
  'sachet',
  'kaleng',
  'toples',
  'biji',
  'buah',
  'pasang',
  'lusin',
  'rim',
  'rol',
  'ikat',
  'batang',
  'lembar',
  'helai',
  'ton',
  'kuintal',
  'ons',
  'ekor',
  'porsi',
  'gelas',
  'cangkir',
  'sendok',
  'bungkus',
] as const;

export type UnitOption = (typeof UNIT_OPTIONS)[number];

export function debounce<T extends (...args: unknown[]) => void>(
  fn: T,
  wait: number,
): (...args: Parameters<T>) => void {
  let timeout: ReturnType<typeof setTimeout>;
  return (...args: Parameters<T>) => {
    clearTimeout(timeout);
    timeout = setTimeout(() => fn(...args), wait);
  };
}

export function clsx(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(' ');
}
