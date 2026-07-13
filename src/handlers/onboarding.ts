import supabase from '../config/supabase';
import { addLog } from '../config/state';
import { safeReply, onboardingStates, graduatedVirtualUsers, ONBOARDING_TTL } from '../config/message-state';
import { parseCurrency, formatRupiah } from '../utils/helpers';
import type { Message } from 'whatsapp-web.js';

const OB_KW_BATAL = ['batal', 'cancel', 'skip', 'keluar', 'stop'];

function getBiteSizedMenu(storeName: string): string {
  return (
    `📋 *Menu Utama — ${storeName}*\n\n` +
    `Balas *angka* untuk memilih:\n\n` +
    `1️⃣ Catat Transaksi\n` +
    `2️⃣ Lihat Laporan Hari Ini\n` +
    `3️⃣ Cek Status Akun\n` +
    `4️⃣ Bantuan & Panduan\n\n` +
    `💡 *Tips:* Ketik langsung juga bisa!\n` +
    `Contoh: *Keluar nasi goreng 1* atau *beli stok kopi 500rb*`
  );
}

async function handleOnboardingStep(
  msg: Message,
  sender: string,
  user: any,
  body: string,
  client: any,
): Promise<boolean> {
  let state = onboardingStates.get(sender);

  if (!state) {
    state = { step: 0, timestamp: Date.now() };
    onboardingStates.set(sender, state);
  }

  if (Date.now() - state.timestamp > ONBOARDING_TTL) {
    onboardingStates.delete(sender);
    await safeReply(
      msg,
      `⏰ *Waktu Simulasi Habis*\n\n` +
        `Tenang Bos, kita mulai lagi ya!\n\n` +
        `👇 Balas angka *1* untuk mulai simulasi.`,
    );
    onboardingStates.set(sender, { step: 0, timestamp: Date.now() });
    return true;
  }

  if (OB_KW_BATAL.some((k) => body === k)) {
    onboardingStates.set(sender, { step: 0, timestamp: Date.now() });
    await safeReply(msg, `🔄 *Oke Bos, kita ulang dari awal ya!*\n\n` + `👇 Balas angka *1* untuk mulai simulasi.`);
    return true;
  }

  if (state.step === 0) {
    const yesWords = ['1', 'mulai', 'siap', 'ya', 'iya', 'oke', 'ok', 'gas', 'yuk', 'lanjut', 'yes', 'y'];
    if (yesWords.includes(body)) {
      await safeReply(
        msg,
        `🎮 *Selamat Datang di Tata Business Suite!*\n\n` +
          `Halo Bos *${user.store_name}*! 👋\n\n` +
          `Yuk belajar pakai Tata dalam 30 detik!\n\n` +
          `👇 *Balas dengan angka 1*\n` +
          `untuk mulai simulasi.`,
      );
      onboardingStates.set(sender, { step: 1, timestamp: Date.now() });
    } else {
      await safeReply(
        msg,
        `Halo Bos! 👋 Kalau mau mulai belajar pakai Tata,\n` +
          `balas *1* atau *Mulai* ya!\n\n` +
          `Atau ketik *Bantuan* untuk lihat semua menu.`,
      );
    }
    return true;
  }

  if (state.step === 1) {
    if (body === '1') {
      await safeReply(
        msg,
        `🎯 *Simulasi Penjualan*\n\n` +
          `Anggap Bos baru saja menjual 1 porsi nasi goreng.\n\n` +
          `👇 *Ketik persis di bawah ini:*\n\n` +
          `*Keluar nasi goreng 1*`,
      );
      onboardingStates.set(sender, { step: 2, timestamp: Date.now() });
    } else {
      await safeReply(msg, `☝️ Balas angka *1* untuk mulai simulasi ya Bos!`);
    }
    return true;
  }

  if (state.step === 2) {
    const keluarMatch = body.match(/^(?:keluar|kurang\s+stok)\s+/i);
    if (keluarMatch) {
      await safeReply(
        msg,
        `✅ *Hebat! Penjualan Tercatat!*\n\n` +
          `📦 Stok nasi goreng berkurang 1 pcs\n` +
          `💰 Omzet tercatat Rp 25.000\n\n` +
          `_(Ini hanya contoh, tidak tercatat di data asli)_\n\n` +
          `👇 Sekarang coba catat pengeluaran.\n` +
          `Ketik persis di bawah ini:\n\n` +
          `*beli stok kopi 500rb*`,
      );
      onboardingStates.set(sender, { step: 3, timestamp: Date.now() });
    } else {
      await safeReply(
        msg,
        `🤔 Hampir benar Bos!\n\n` + `Pastikan diawali kata *Keluar* ya.\n\n` + `👇 Coba ketik: *Keluar nasi goreng 1*`,
      );
    }
    return true;
  }

  if (state.step === 3) {
    const buyMatch = body.match(/^(?:beli|belanja|bayar)\s+/i);
    if (buyMatch) {
      const amountMatch = rawBodyMatch(body);
      const amount = amountMatch ? parseCurrency(amountMatch) : 5000;
      const amountStr = amount ? formatRupiah(amount) : 'Rp 5.000';
      const words = body.split(/\s+/);
      const desc =
        words.filter((w: string) => parseCurrency(w) === null && !/^(beli|belanja|bayar)$/i.test(w)).join(' ') ||
        'gula';
      await safeReply(
        msg,
        `🎉 *Mantap! Pengeluaran Tercatat!*\n\n` +
          `📤 KELUAR\n` +
          `💵 Jumlah: ${amountStr}\n` +
          `📝 Ket: ${desc}\n\n` +
          `_(Ini hanya contoh, tidak tercatat di data asli)_`,
      );
      onboardingStates.set(sender, { step: 4, timestamp: Date.now() });
      setTimeout(async () => {
        try {
          await graduateOnboarding(msg, sender, user, client);
        } catch (_: any) {
          addLog('error', '[ONBOARD] graduateOnboarding failed: ' + _.message);
        }
      }, 1500);
    } else {
      await safeReply(
        msg,
        `🤔 Hampir benar Bos!\n\n` + `Pastikan diawali kata *beli* ya.\n\n` + `👇 Coba ketik: *beli stok kopi 500rb*`,
      );
    }
    return true;
  }

  if (state.step === 4) {
    await safeReply(msg, `⏳ Sebentar ya Bos, sedang menyelesaikan setup...`);
    return true;
  }

  return true;
}

function rawBodyMatch(body: string): string | null {
  const words = body.split(/\s+/);
  for (const w of words) {
    const val = parseCurrency(w);
    if (val !== null) return w;
  }
  return null;
}

async function graduateOnboarding(msg: Message, sender: string, user: any, client: any): Promise<void> {
  onboardingStates.delete(sender);

  try {
    await supabase.rpc('complete_onboarding', { p_user_id: sender });
  } catch {
    /* ignore */
  }
  try {
    await supabase
      .from('users')
      .update({
        onboarding_status: 'completed',
        onboarding_completed_at: new Date().toISOString(),
      })
      .eq('id', sender);
  } catch {
    /* ignore */
  }

  if (user && !user.created_at && !user.updated_at) {
    graduatedVirtualUsers.set(sender, Date.now());
  }

  await safeReply(
    msg,
    `🎉 *Selamat Bos ${user.store_name}!*\n\n` +
      `Bos sudah siap menggunakan Tata! 🚀\n\n` +
      getBiteSizedMenu(user.store_name),
  );
}

export { handleOnboardingStep };
