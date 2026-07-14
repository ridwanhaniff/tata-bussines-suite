import fs from 'fs';
import path from 'path';
import { state, addLog, getSupabase } from '../config/state';
import { SESSION_DIR_WHITELIST, SESSION_DIR_BLACKLIST, SESSION_BASE_DIR, SESSION_MAX_AGE } from '../config/constants';

const MAX_FILE_SIZE = 10_000_000; // skip files > 10MB

interface DirEntry {
  path: string;
  type: 'dir' | 'file';
  content?: string | null; // base64 for files
}

function isSafeEntry(name: string): boolean {
  if (SESSION_DIR_BLACKLIST.some((p: string) => name.includes(p))) return false;
  return true;
}

function walkDir(dirPath: string, basePath: string): DirEntry[] {
  const results: DirEntry[] = [];
  if (!fs.existsSync(dirPath)) return results;
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      const relativePath = path.relative(basePath, fullPath);
      if (!isSafeEntry(entry.name)) continue;

      if (entry.isDirectory()) {
        if (SESSION_DIR_WHITELIST.includes(entry.name) || entry.name.startsWith('Session-')) {
          results.push({ path: relativePath, type: 'dir' });
          results.push(...walkDir(fullPath, basePath));
        }
      } else if (entry.isFile()) {
        const entry_: DirEntry = { path: relativePath, type: 'file', content: null };
        try {
          const stat = fs.statSync(fullPath);
          if (stat.size <= MAX_FILE_SIZE) {
            entry_.content = fs.readFileSync(fullPath, { encoding: 'base64' });
          }
        } catch { /* skip content */ }
        results.push(entry_);
      }
    }
  } catch { /* ignore */ }
  return results;
}

async function saveSessionDirToDB(userId: string): Promise<void> {
  const supabase = getSupabase();
  if (!supabase) return;
  try {
    const baseDir = SESSION_BASE_DIR;
    if (!fs.existsSync(baseDir)) return;

    const manifest = walkDir(baseDir, baseDir);
    const { error } = await supabase
      .from('wa_session_backup')
      .upsert({
        user_id: userId,
        manifest: JSON.stringify(manifest),
        updated_at: new Date().toISOString(),
      } as any);
    if (error) addLog('error', `[SESSION] Save manifest error: ${error.message}`);
  } catch (err: any) {
    addLog('error', `[SESSION] Save manifest exception: ${err.message}`);
  }
}

async function restoreSessionDirFromDB(userId: string): Promise<boolean> {
  const supabase = getSupabase();
  if (!supabase) return false;
  try {
    const { data, error } = await supabase
      .from('wa_session_backup')
      .select('manifest, updated_at')
      .eq('user_id', userId)
      .maybeSingle() as any;
    if (error || !data || !data.manifest) return false;

    if (data.updated_at) {
      const sessionAge = Date.now() - new Date(data.updated_at).getTime();
      if (sessionAge > SESSION_MAX_AGE) {
        addLog('warn', `[SESSION] Session expired (age: ${Math.round(sessionAge / 86400000)} days) — forcing fresh login`);
        await supabase.from('wa_session_backup').delete().eq('user_id', userId);
        return false;
      }
    }

    const manifest: DirEntry[] = typeof data.manifest === 'string' ? JSON.parse(data.manifest) : data.manifest;
    if (!Array.isArray(manifest) || manifest.length === 0) return false;

    const baseDir = SESSION_BASE_DIR;
    if (!fs.existsSync(baseDir)) fs.mkdirSync(baseDir, { recursive: true });

    let fileCount = 0, dirCount = 0;
    for (const entry of manifest) {
      const fullPath = path.join(baseDir, entry.path);
      if (entry.type === 'dir') {
        if (!fs.existsSync(fullPath)) { fs.mkdirSync(fullPath, { recursive: true }); dirCount++; }
      } else if (entry.type === 'file' && entry.content) {
        try {
          const dir = path.dirname(fullPath);
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(fullPath, Buffer.from(entry.content, 'base64'));
          fileCount++;
        } catch { /* skip file */ }
      }
    }
    addLog('info', `[SESSION] Restored from DB: ${dirCount} dirs, ${fileCount} files`);
    return true;
  } catch (err: any) {
    addLog('error', `[SESSION] Restore from DB error: ${err.message}`);
    return false;
  }
}

async function resetBootStatus(): Promise<void> {
  const supabase = getSupabase();
  if (!supabase) return;
  try {
    await supabase.from('bot_status')
      .update({ status: 'offline', updated_at: new Date().toISOString() })
      .eq('status', 'active');
  } catch { /* ignore */ }
}

async function saveSessionToDB(sessionData: string | Record<string, unknown>): Promise<void> {
  const supabase = getSupabase();
  if (!supabase) return;
  try {
    await supabase.from('wa_session_backup').upsert({
      user_id: 'default',
      session_data: typeof sessionData === 'string' ? sessionData : JSON.stringify(sessionData),
      updated_at: new Date().toISOString(),
    } as any);
  } catch (err: any) {
    addLog('error', `[SESSION] Save session error: ${err.message}`);
  }
}

export {
  walkDir, saveSessionDirToDB, restoreSessionDirFromDB,
  resetBootStatus, saveSessionToDB,
};
