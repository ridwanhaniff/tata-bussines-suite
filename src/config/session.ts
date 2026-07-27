import type { RequestHandler } from 'express';
import session from 'express-session';
import { Pool } from 'pg';
import { addLog } from './state';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const pgSession: (s: typeof session) => any = require('connect-pg-simple');

let _sessionMiddleware: RequestHandler | null = null;

declare module 'express-session' {
  interface SessionData {
    userId?: string;
    isAdmin?: boolean;
    store_name?: string;
    slug?: string;
    token?: string;
    email?: string;
    role?: string;
  }
}

export function buildSessionMiddleware(): RequestHandler {
  if (_sessionMiddleware) return _sessionMiddleware;

  const isCloud = process.env.NODE_ENV === 'production' || process.env.SPACE_ID !== undefined;

  const secret = process.env.SESSION_SECRET;
  if (!secret || secret === 'tbs-secret-32chars-ganti-ini!') {
    addLog(
      'warn',
      '[SECURITY] SESSION_SECRET menggunakan default! Set SESSION_SECRET minimal 32 karakter random di .env',
    );
  }

  const base: session.SessionOptions = {
    secret: secret || 'tbs-secret-32chars-ganti-ini!',
    resave: false,
    saveUninitialized: false,
    proxy: true,
    cookie: {
      secure: isCloud,
      httpOnly: true,
      sameSite: isCloud ? ('none' as const) : ('lax' as const),
    },
  };

  if (!process.env.DATABASE_URL) {
    addLog('warn', '[SESSION] Memory store — set DATABASE_URL untuk session persisten');
    _sessionMiddleware = session(base);
    return _sessionMiddleware;
  }

  try {
    const connUrl = process.env.DATABASE_URL;

    const pgPool = new Pool({
      connectionString: connUrl,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
      keepAlive: true,
    });

    pgPool.on('error', (err: Error) => {
      addLog('error', `[SESSION DB] Unexpected error on idle client: ${err.message}`);
    });

    addLog('info', '[SESSION] PostgreSQL pool created (keepAlive: true, max: 5, PgBouncer)');

    const PgStore = pgSession(session);
    const store = new PgStore({
      pool: pgPool,
      tableName: 'user_sessions',
      schemaName: 'public',
      createTableIfMissing: true,
      errorLog: (err: Error) => addLog('error', `[SESSION] Store error: ${err.message}`),
    });
    addLog('info', '[SESSION] PostgreSQL session store aktif');
    _sessionMiddleware = session({ ...base, store });
  } catch (err) {
    addLog('error', `[SESSION] Fallback ke memory store: ${(err as Error).message}`);
    _sessionMiddleware = session(base);
  }

  return _sessionMiddleware;
}
