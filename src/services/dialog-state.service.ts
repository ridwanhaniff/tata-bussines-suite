export type DialogType =
  | 'tx_confirmation'
  | 'classification'
  | 'product_selection'
  | 'pay_hutang'
  | 'receive_piutang'
  | 'retur_jual'
  | 'retur_beli'
  | 'undo_confirmation'
  | 'keluar_channel';

export interface DialogState {
  type: DialogType;
  data: any;
  timestamp: number;
}

const DIALOG_TTL = 5 * 60 * 1000;
const CLEANUP_INTERVAL = 60_000;

const dialogs = new Map<string, DialogState[]>();

export function getActiveCount(): number {
  let count = 0;
  for (const [, states] of dialogs) {
    count += states.length;
  }
  return count;
}

function getOrCreate(sender: string): DialogState[] {
  let arr = dialogs.get(sender);
  if (!arr) {
    arr = [];
    dialogs.set(sender, arr);
  }
  return arr;
}

function pruneExpired(arr: DialogState[]): DialogState[] {
  const now = Date.now();
  const valid = arr.filter((d) => now - d.timestamp < DIALOG_TTL);
  return valid;
}

export function setDialog(sender: string, type: DialogType, data: Record<string, unknown>): void {
  const arr = getOrCreate(sender);
  const existing = arr.find((d) => d.type === type);
  if (existing) {
    existing.data = data;
    existing.timestamp = Date.now();
  } else {
    arr.push({ type, data, timestamp: Date.now() });
  }
}

export function getDialog(sender: string, type: DialogType): DialogState | null {
  const arr = dialogs.get(sender);
  if (!arr) return null;
  const valid = pruneExpired(arr);
  if (valid.length !== arr.length) dialogs.set(sender, valid);
  return valid.find((d) => d.type === type) ?? null;
}

export function hasDialog(sender: string, type?: DialogType): boolean {
  const arr = dialogs.get(sender);
  if (!arr) return false;
  const valid = pruneExpired(arr);
  if (valid.length !== arr.length) dialogs.set(sender, valid);
  if (!type) return valid.length > 0;
  return valid.some((d) => d.type === type);
}

export function getNextDialog(sender: string): DialogState | null {
  const arr = dialogs.get(sender);
  if (!arr) return null;
  const valid = pruneExpired(arr);
  if (valid.length !== arr.length) dialogs.set(sender, valid);
  return valid[0] ?? null;
}

export function getExpiredDialogTypes(sender: string): DialogType[] {
  const arr = dialogs.get(sender);
  if (!arr) return [];
  const now = Date.now();
  const expired = arr.filter((d) => now - d.timestamp >= DIALOG_TTL);
  if (expired.length > 0) {
    dialogs.set(sender, arr.filter((d) => now - d.timestamp < DIALOG_TTL));
  }
  return expired.map((d) => d.type);
}

export function removeDialog(sender: string, type?: DialogType): void {
  if (!type) {
    dialogs.delete(sender);
    return;
  }
  const arr = dialogs.get(sender);
  if (!arr) return;
  const remaining = arr.filter((d) => d.type !== type);
  if (remaining.length === 0) dialogs.delete(sender);
  else dialogs.set(sender, remaining);
}

export function clearAllDialogs(sender: string): void {
  dialogs.delete(sender);
}

const PRIORITY_ORDER: DialogType[] = [
  'tx_confirmation',
  'pay_hutang',
  'receive_piutang',
  'retur_jual',
  'retur_beli',
  'undo_confirmation',
  'keluar_channel',
  'product_selection',
  'classification',
];

export function sortedDialogs(sender: string): DialogState[] {
  const arr = dialogs.get(sender);
  if (!arr) return [];
  const valid = pruneExpired(arr);
  if (valid.length !== arr.length) dialogs.set(sender, valid);
  return valid.sort(
    (a, b) => PRIORITY_ORDER.indexOf(a.type) - PRIORITY_ORDER.indexOf(b.type),
  );
}

setInterval(() => {
  for (const [sender, arr] of dialogs) {
    const valid = pruneExpired(arr);
    if (valid.length === 0) dialogs.delete(sender);
    else if (valid.length !== arr.length) dialogs.set(sender, valid);
  }
  if (dialogs.size > 5000) {
    const keys = Array.from(dialogs.keys()).slice(0, 1000);
    keys.forEach((k) => dialogs.delete(k));
  }
}, CLEANUP_INTERVAL).unref();
