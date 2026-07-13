import fs from 'fs';
import path from 'path';

// Server
export const PORT: number = parseInt(process.env.PORT || '7860', 10);

// Time constants (ms)
export const DAY_MS = 24 * 60 * 60 * 1000;
export const HOUR_MS = 60 * 60 * 1000;
export const MINUTE_MS = 60 * 1000;

// WA retry
export const WA_MAX_RETRIES = 8;
export const WA_BASE_DELAY = 30_000;
export const WA_MAX_DELAY = 300_000;

// Circuit breaker
export const CIRCUIT_COOLDOWN_MS = 60_000;
export const CIRCUIT_FAILURE_THRESHOLD = 5;

// Cache TTL
export const CACHE_TTL_DEFAULT = 30_000;
export const CACHE_MAX_SIZE = 500;

// Session
export const SESSION_MAX_AGE = 30 * DAY_MS;

// Broadcast
export const BROADCAST_DEDUP_WINDOW = 10 * MINUTE_MS;
export const BROADCAST_INTERVAL = 1200;

// Dialog auto-eviction
export const DIALOG_TTL = 2 * MINUTE_MS;

// Pagination
export const HIST_PAGE_LIMIT = 30;

// Session directories (whitelist / blacklist for session persistence)
export const SESSION_DIR_WHITELIST: string[] = [
  'Default',
  'Session-WhatsApp',
  'Crashpad',
  'GrShaderCache',
  'ShaderCache',
  'Dictionaries',
  'Safe Browsing',
  'FileSystem',
  'Sessions',
  'Sync Data',
  'Local Extension Settings',
  'Network Action Predictor',
  'Origin Trials',
  'Site Characteristics Helper',
  'Session Storage',
  'Extensions',
  'Platform Notifications',
  'Subresource Filter',
  'Trust Tokens',
  'Component Updater',
  'Optimization Hints',
  'OnDeviceHeadSuggest',
  'Crowd Deny',
  'Certificate Revocation',
  'Download Service',
  'TrialData',
  'First Party Sets',
  'Privacy Sandbox',
  'Segmentation Platform',
  'SharedStorage',
];

export const SESSION_DIR_BLACKLIST: string[] = [
  'Code Cache',
  'GPUCache',
  'CacheStorage',
  'Service Worker',
  'sw.js',
  '.com.google.Chrome',
];

export const SESSION_BASE_DIR: string =
  process.env.WA_SESSION_DIR ||
  (fs.existsSync('/data') ? '/data/.wwebjs_auth' : path.join(__dirname, '../../.wwebjs_auth'));
