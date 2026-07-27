import { Router } from 'express';
import path from 'path';
import fs from 'fs';
import bcrypt from 'bcryptjs';
import supabase, { pgPool } from '../config/supabase';
import { addLog } from '../config/state';

const loginHtml = path.join(__dirname, '../../public/login.html');
const spaIndex = path.join(__dirname, '../../public/dist/index.html');

const router = Router();

router.get('/login', (req, res) => {
  if ((req.session as any)?.authenticated) {
    res.redirect('/admin');
    return;
  }
  res.setHeader('Cache-Control', 'no-store');
  if (fs.existsSync(loginHtml)) {
    res.sendFile(loginHtml);
    return;
  }
  if (fs.existsSync(spaIndex)) {
    res.sendFile(spaIndex);
    return;
  }
  res.status(404).send('Login page not found');
});

router.post('/admin/login', async (req, res) => {
  const { email, username, password } = req.body || {};
  const userEmail = email || username;
  if (!userEmail || !password) {
    res.status(400).json({ success: false, error: 'Email dan password wajib' });
    return;
  }

  try {
    if (!pgPool) {
      addLog('error', '[AUTH] pgPool tidak tersedia — DATABASE_URL tidak di-set');
      res.status(500).json({ success: false, error: 'Database tidak tersedia' });
      return;
    }

    const { rows } = await pgPool.query('SELECT email, password_hash, role FROM admins WHERE email = $1', [userEmail]);
    const admin = rows?.[0] || null;

    if (!admin) {
      addLog('warn', `[AUTH] Login gagal untuk ${userEmail}: admin tidak ditemukan`);
      res.status(401).json({ success: false, error: 'Email atau password salah' });
      return;
    }

    if (!bcrypt.compareSync(password, admin.password_hash)) {
      addLog('warn', `[AUTH] Login gagal untuk ${userEmail}: password salah`);
      res.status(401).json({ success: false, error: 'Email atau password salah' });
      return;
    }

    (req.session as any).authenticated = true;
    (req.session as any).email = admin.email;
    (req.session as any).role = admin.role;

    (req.session as any).save((err?: Error) => {
      if (err) {
        addLog('error', `[AUTH] Session save error: ${err.message}`);
        res.status(500).json({ success: false, error: 'Gagal menyimpan session' });
        return;
      }
      res.json({ success: true, email: admin.email, role: admin.role });
    });
  } catch (e: any) {
    addLog('error', `[AUTH] Login error: ${e.message}`);
    res.status(500).json({ success: false, error: 'Terjadi kesalahan server' });
  }
});

router.get('/api/admin/me', (req, res) => {
  const session = req.session as any;
  if (session?.authenticated) {
    res.json({ authenticated: true, email: session.email, role: session.role });
    return;
  }
  res.status(401).json({ authenticated: false });
});

router.post('/admin/logout', (req, res) => {
  req.session?.destroy(() => {
    res.clearCookie('connect.sid', { path: '/' });
    res.json({ success: true });
  });
});

export default router;
