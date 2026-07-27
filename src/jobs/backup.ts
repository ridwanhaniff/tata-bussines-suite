import { spawn } from 'child_process';
import fs from 'fs';

// HF Storage Bucket untuk backup database (dapat dikonfigurasi via HF_BACKUP_BUCKET)
const BACKUP_BUCKET = process.env.HF_BACKUP_BUCKET || '';
const BACKUP_DIR = '/data/backups';
const API_BASE = 'https://huggingface.co/api/storage';

function pad(n: number): string {
  return n.toString().padStart(2, '0');
}

function formatDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

async function uploadToBucket(filePath: string, remotePath: string): Promise<boolean> {
  const token = process.env.HF_TOKEN;
  if (!token) {
    console.error('[BACKUP] HF_TOKEN tidak diset — upload ke bucket gagal');
    return false;
  }
  if (!BACKUP_BUCKET) {
    console.error('[BACKUP] HF_BACKUP_BUCKET tidak diset — skip upload ke bucket');
    return false;
  }

  const url = `${API_BASE}/${encodeURIComponent(BACKUP_BUCKET)}/${remotePath}`;
  const fileBuffer = fs.readFileSync(filePath);

  try {
    const response = await fetch(url, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/octet-stream',
      },
      body: fileBuffer,
    });

    if (response.ok) {
      console.log(`[BACKUP] Upload berhasil: ${remotePath} (${(fileBuffer.length / 1024 / 1024).toFixed(1)} MB)`);
      return true;
    }

    const body = await response.text().catch(() => '');
    console.error(`[BACKUP] Upload gagal: HTTP ${response.status} — ${body}`);
    return false;
  } catch (err: any) {
    console.error(`[BACKUP] Upload error: ${err.message}`);
    return false;
  }
}

async function runBackup(): Promise<{ success: boolean; error?: string; size?: number }> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    return { success: false, error: 'DATABASE_URL tidak diset' };
  }

  const now = new Date();
  const timestamp = formatDate(now);
  const fileName = `backup-${timestamp}.sql`;
  const localPath = `${BACKUP_DIR}/${fileName}`;
  const remotePath = `backups/${fileName}`;

  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
  }

  const pgDumpVersion = await new Promise<boolean>((resolve) => {
    const proc = spawn('pg_dump', ['--version'], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000 });
    proc.on('close', (code) => resolve(code === 0));
    proc.on('error', () => resolve(false));
  });

  if (!pgDumpVersion) {
    return { success: false, error: 'pg_dump tidak ditemukan — install postgresql-client di container' };
  }

  const dumpResult = await new Promise<{ success: boolean; error?: string; size?: number }>((resolve) => {
    const proc = spawn('pg_dump', ['--no-owner', '--no-acl', '--compress=9', '-f', localPath, dbUrl], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 300_000,
      env: { ...process.env, PGPASSWORD: '' },
    });

    let stderr = '';
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on('close', (code) => {
      if (code === 0 && fs.existsSync(localPath)) {
        const stat = fs.statSync(localPath);
        console.log(`[BACKUP] pg_dump sukses: ${fileName} (${(stat.size / 1024 / 1024).toFixed(1)} MB)`);
        resolve({ success: true, size: stat.size });
      } else {
        const errMsg = stderr || `pg_dump exit code ${code}`;
        console.error(`[BACKUP] pg_dump gagal: ${errMsg}`);
        resolve({ success: false, error: errMsg });
      }
    });

    proc.on('error', (err) => {
      resolve({ success: false, error: err.message });
    });
  });

  if (!dumpResult.success) {
    try {
      fs.unlinkSync(localPath);
    } catch {
      /* ignore */
    }
    return dumpResult;
  }

  const uploaded = await uploadToBucket(localPath, remotePath);

  try {
    fs.unlinkSync(localPath);
  } catch {
    /* ignore */
  }

  if (!uploaded) {
    return { success: false, error: 'Upload ke bucket gagal (file dump lokal sudah dihapus)' };
  }

  return { success: true, size: dumpResult.size };
}

export { runBackup };
