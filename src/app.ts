import express from 'express';
import path from 'path';
import fs from 'fs';
import { buildSessionMiddleware } from './config/session';
import supabase from './config/supabase';
import { requireAdmin } from './middleware/auth';
import healthRoutes from './routes/health';
import authRoutes from './routes/auth';
import staticRoutes from './routes/static-files';
import apiRoutes from './routes/api';

const originalMkdirSync = fs.mkdirSync;
fs.mkdirSync = function (this: any, p: any, options?: any) {
  try {
    return originalMkdirSync.apply(this, arguments as any);
  } catch (err: any) {
    if (err.code === 'EEXIST') return p;
    throw err;
  }
} as typeof fs.mkdirSync;

const app = express();

app.use(buildSessionMiddleware());
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));

app.use((req, _res, next) => {
  if (req.url !== req.url.replace(/\/\/+/g, '/')) req.url = req.url.replace(/\/\/+/g, '/');
  next();
});

app.use((err: any, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (err.type === 'entity.too.large') {
    return res.status(413).json({
      success: false,
      error: 'Ukuran file terlalu besar. Maksimal 2MB setelah kompresi.',
      code: 'PAYLOAD_TOO_LARGE',
    });
  }
  next(err);
});

app.use(healthRoutes);
app.use(authRoutes);
app.use(staticRoutes);
app.use(apiRoutes);

const distDir = path.join(__dirname, '../public/dist');
const distIndex = path.join(distDir, 'index.html');
if (fs.existsSync(distIndex)) {
  app.use('/assets', express.static(path.join(distDir, 'assets')));
  app.get('/login', (req, res) => res.sendFile(distIndex));
  app.get('/admin', requireAdmin, (req, res) => res.sendFile(distIndex));
  app.get('/admin/{*path}', requireAdmin, (req, res) => res.sendFile(distIndex));
  app.get('/stock/{*path}', (req, res) => res.sendFile(distIndex));
  console.log('[APP] React SPA build detected — serving new frontend');
}

app.use(express.static(path.join(__dirname, '../public')));

app.set('supabase', supabase);

export default app;
