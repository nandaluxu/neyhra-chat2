import { dayNum } from './bonus.js'
import { push as notify } from './notify.js'

// ===== Bank: simpanan aman dari pencurian + bunga harian kecil =====
// Dipasang ke router auth (lib/auth.js) lewat mountBank(). Berpasangan dengan sistem pencurian
// (lib/robbery.js): coin di dompet (`coins`) bisa dicuri pemain lain, coin di Bank (`bank`) TIDAK.
// Jadi Bank = satu-satunya perlindungan pasif; perisai (lib/robbery.js) adalah perlindungan aktif.
//
// Aturan yang dijaga di sini (client hanya menampilkan):
//   - Setor/tarik atomik lewat findOneAndUpdate ber-syarat saldo (pola lib/economy.js): dompet
//     tidak bisa minus, saldo bank tidak bisa minus, dua request bersamaan tidak bisa dobel.
//   - Bunga: 0,5% per hari (WIB) dari saldo bank, maks BANK.interestMax per hari, dihitung LAZY
//     pada aksi/tampilan pertama hari itu (penjaga atomik bankIntDay != hari ini). Faucet kecil
//     ini disengaja sebagai alasan balik tiap hari, nilainya jauh di bawah klaim harian.
//   - Bunga masuk ke saldo bank (ikut aman pencurian), bukan ke dompet.
//
// Endpoint (POST, token Bearer):
//   /api/auth/bank         -> { ok, bank, coins, rates, lastRob? }                       body { }
//   /api/auth/bank/deposit -> { ok, bank, coins }                                       body { amount }
//   /api/auth/bank/withdraw -> { ok, bank, coins }                                      body { amount }
//
// Field baru di `users`: bank (angka, saldo aman) | bankIntDay (nomor hari WIB terakhir berbunga)

// ===== Angka bank diatur di sini =====
export const BANK = {
  minDeposit: 100,        // minimal setor (biar tidak transaksi remeh-remeh)
  maxDeposit: 500_000,    // maksimal setor sekali
  maxWithdraw: 500_000,   // maksimal tarik sekali
  interestPct: 0.005,     // 0,5% per hari
  interestMax: 200        // plafon bunga per hari
}

const nf = n => Math.round(n).toLocaleString('id-ID')
const doc = r => (r && r.value !== undefined ? r.value : r)
const todayNum = () => dayNum(Date.now())

export function mountBank(router, { wrap, userFromReq, allow, col, ensureWallet }) {
  const need = async (req, res) => {
    const a = await userFromReq(req)
    if (!a) { res.status(401).json({ error: 'Sesi berakhir, masuk lagi.' }); return null }
    return a.user
  }

  // Bunga lazy: hari berganti (WIB) + saldo > 0 -> kredit bunga sekali per hari. Penjaga
  // bankIntDay != today membuat dua request paralel hanya satu yang berbunga.
  // Mengembalikan dokumen user TERBARU (saldo bank setelah bunga).
  async function accrue(u) {
    const day = todayNum()
    const bank = Math.max(0, Math.floor(Number(u.bank) || 0))
    if (!bank || u.bankIntDay === day) return u
    const interest = Math.min(BANK.interestMax, Math.floor(bank * BANK.interestPct))
    if (interest <= 0) { // tetap tandai hari ini supaya tidak dihitung terus
      const nu = doc(await (await col('users')).findOneAndUpdate({ _id: u._id, bankIntDay: { $ne: day } }, { $set: { bankIntDay: day } }, { returnDocument: 'after' }))
      return nu || u
    }
    const nu = doc(await (await col('users')).findOneAndUpdate(
      { _id: u._id, bankIntDay: { $ne: day }, bank: { $gte: 0 } },
      { $set: { bankIntDay: day }, $inc: { bank: interest } },
      { returnDocument: 'after' }
    ))
    if (nu) {
      await notify(col, u._id, 'bank', `Bunga bank harian masuk: +${nf(interest)} Coin (saldo aman ${nf(nu.bank)}).`)
      return nu
    }
    return u // hari sudah berganti lewat request lain: baca ulang saja
  }

  async function view(u, extra) {
    const w = await ensureWallet(u)
    return { ok: true, bank: Math.max(0, Math.floor(Number(u.bank) || 0)), coins: u.coins ?? w.coins, rates: { ...BANK }, pocketNote: 'Coin di dompet bisa jadi target pencurian; saldo Bank aman.', ...extra }
  }

  // ---- Ringkasan: saldo + bunga hari ini sudah/lumrah ----
  router.post('/api/auth/bank', wrap(async (req, res) => {
    const u = await need(req, res); if (!u) return
    if (!(await allow('bnk:' + u._id, 60, 60))) return res.status(429).json({ error: 'Terlalu sering, tunggu sebentar.' })
    const fresh = await accrue(u)
    res.json(await view(fresh, { interest: { day: todayNum() === (fresh.bankIntDay || 0), pct: BANK.interestPct, max: BANK.interestMax } }))
  }))

  // ---- Setor: dompet -> bank ----
  router.post('/api/auth/bank/deposit', wrap(async (req, res) => {
    const u = await need(req, res); if (!u) return
    if (!(await allow('bnkd:' + u._id, 20, 60))) return res.status(429).json({ error: 'Terlalu sering, tunggu sebentar.' })
    const amount = Math.floor(Number(req.body?.amount))
    if (!Number.isFinite(amount) || amount < BANK.minDeposit) return res.status(400).json({ error: `Setor minimal ${nf(BANK.minDeposit)} Coin.` })
    if (amount > BANK.maxDeposit) return res.status(400).json({ error: `Setor maksimal ${nf(BANK.maxDeposit)} Coin sekali aksi.` })
    const users = await col('users')
    const nu = doc(await users.findOneAndUpdate(
      { _id: u._id, coins: { $gte: amount } },
      { $inc: { coins: -amount, bank: amount } },
      { returnDocument: 'after' }
    ))
    if (!nu) {
      const cur = (await users.findOne({ _id: u._id })) || u
      return res.status(409).json({ ...(await view(cur)), ok: false, error: 'Coin di dompet kamu belum cukup.' })
    }
    res.json(await view(nu, { done: { kind: 'deposit', amount } }))
  }))

  // ---- Tarik: bank -> dompet ----
  router.post('/api/auth/bank/withdraw', wrap(async (req, res) => {
    const u = await need(req, res); if (!u) return
    if (!(await allow('bnkw:' + u._id, 20, 60))) return res.status(429).json({ error: 'Terlalu sering, tunggu sebentar.' })
    const amount = Math.floor(Number(req.body?.amount))
    if (!Number.isFinite(amount) || amount < 1 || amount > BANK.maxWithdraw) return res.status(400).json({ error: `Tarik 1 sampai ${nf(BANK.maxWithdraw)} Coin.` })
    const users = await col('users')
    const nu = doc(await users.findOneAndUpdate(
      { _id: u._id, bank: { $gte: amount } },
      { $inc: { bank: -amount, coins: amount } },
      { returnDocument: 'after' }
    ))
    if (!nu) {
      const cur = (await users.findOne({ _id: u._id })) || u
      return res.status(409).json({ ...(await view(cur)), ok: false, error: 'Saldo bank kamu belum cukup.' })
    }
    res.json(await view(nu, { done: { kind: 'withdraw', amount } }))
  }))
}
