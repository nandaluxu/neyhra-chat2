import crypto from 'node:crypto'

// Bonus akun: klaim harian (siklus 7 hari) + kode referal. Semua hadiah dan saldo diputuskan di sini, client cuma menampilkan.
// Dipasang ke router auth (lib/auth.js) lewat mountBonus(), jadi memakai sesi/token, pembatas laju, dan koleksi `users` yang sama.
//
// Endpoint (POST, token Bearer, semua jawaban JSON):
//   /api/auth/bonus   -> { ok, refCode, invited, redeemed, ref:{inviter,invitee}, daily:{rewards,claimedDays,claimedToday,claimDay,resetMs}, coins, gems }
//   /api/auth/claim   -> { ok, reward, daily, coins, gems }        klaim hadiah hari ini (sekali sehari)
//   /api/auth/redeem  -> { ok, reward, coins, gems }  body { code } pakai kode referal teman (sekali per akun)
//
// Field tambahan di dokumen `users`:
//   bonusDay  nomor hari WIB terakhir klaim (bilangan bulat)    bonusN  hari ke-berapa yang terakhir diklaim (1..7)
//   refCode   kode referal milik user (unik, dibuat saat pertama kali buka tab Bonus)
//   invited   jumlah teman yang memakai kodenya                  refBy   _id pemilik kode yang dia pakai (ada = sudah pernah redeem)

// ===== Atur hadiah di sini =====
export const DAILY = [{ c: 50 }, { c: 75 }, { c: 100 }, { c: 125 }, { c: 150 }, { c: 200 }, { g: 5 }] // hari 1..7, lalu mengulang dari hari 1
export const REF = { inviter: { c: 100, g: 3 }, invitee: { c: 100, g: 2 } }                          // hadiah pemilik kode / pemakai kode
const REF_MAX_REWARDED = 50 // pemilik kode paling banyak dapat hadiah dari 50 teman (anti ternak akun). Temannya tetap dapat hadiah.

const WIB = 7 * 3600e3, DAY = 86400e3
export const dayNum = ms => Math.floor((ms + WIB) / DAY) // hari berganti pukul 00.00 WIB
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // tanpa I, O, 0, 1 supaya tidak tertukar saat diketik
const newCode = () => Array.from({ length: 8 }, () => CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]).join('')
const fixed = r => ({ ...(r.c ? { c: r.c } : {}), ...(r.g ? { g: r.g } : {}) })

// keadaan klaim harian untuk tampilan. claimedDays = hari yang sudah terklaim di siklus ini, claimDay = hari yang berikutnya bisa/akan diklaim.
export function dailyView(u, now = Date.now()) {
  const today = dayNum(now), total = DAILY.length
  const last = Number.isInteger(u.bonusDay) ? u.bonusDay : -99
  let n = Number.isInteger(u.bonusN) ? Math.max(0, Math.min(total, u.bonusN)) : 0
  const claimedToday = last === today
  if (!claimedToday && (last !== today - 1 || n >= total)) n = 0 // ada hari terlewat, atau siklus 7 hari sudah tuntas -> mulai lagi dari hari 1
  return {
    rewards: DAILY.map(fixed),
    claimedDays: n,
    claimedToday,
    claimDay: n < total ? n + 1 : 1,
    resetMs: (today + 1) * DAY - WIB - now // sampai pergantian hari berikutnya (00.00 WIB)
  }
}

// deps: { wrap, userFromReq, allow, col, ensureWallet, ip } dari lib/auth.js
export function mountBonus(router, { wrap, userFromReq, allow, col, ensureWallet, ip }) {
  const need = async (req, res) => {
    const a = await userFromReq(req)
    if (!a) { res.status(401).json({ error: 'Sesi berakhir, masuk lagi.' }); return null }
    return a.user
  }
  const doc = r => (r && r.value !== undefined ? r.value : r) // findOneAndUpdate: driver baru mengembalikan dokumen, driver lama { value }

  async function ensureRefCode(u) {
    if (u.refCode) return u.refCode
    const users = await col('users')
    for (let i = 0; i < 6; i++) {
      const code = newCode()
      try {
        const r = await users.updateOne({ _id: u._id, refCode: { $exists: false } }, { $set: { refCode: code } })
        if (r.modifiedCount) return code
        return (await users.findOne({ _id: u._id }, { projection: { refCode: 1 } }))?.refCode || code // permintaan lain sudah membuatnya lebih dulu
      } catch (e) { if (e?.code !== 11000) throw e } // kode bentrok (sangat jarang) -> coba kode lain
    }
    throw new Error('Gagal membuat kode referal')
  }

  router.post('/api/auth/bonus', wrap(async (req, res) => {
    const u = await need(req, res); if (!u) return
    const [w, refCode] = [await ensureWallet(u), await ensureRefCode(u)]
    res.json({ ok: true, refCode, invited: u.invited || 0, redeemed: !!u.refBy, ref: { inviter: fixed(REF.inviter), invitee: fixed(REF.invitee) }, daily: dailyView(u), coins: w.coins, gems: w.gems })
  }))

  router.post('/api/auth/claim', wrap(async (req, res) => {
    const u = await need(req, res); if (!u) return
    if (!(await allow('claim:' + u._id, 20, 60))) return res.status(429).json({ error: 'Terlalu sering, tunggu sebentar.' })
    await ensureWallet(u) // akun lama tanpa saldo: isi saldo awal dulu supaya $inc di bawah tidak menggantikannya
    const now = Date.now(), v = dailyView(u, now)
    if (v.claimedToday) return res.status(409).json({ error: 'Hari ini sudah diklaim.' })
    const reward = fixed(DAILY[v.claimDay - 1]), today = dayNum(now)
    // $ne di filter = penjaga atomik: dua klaim bersamaan (dua tab/perangkat) hanya satu yang lolos
    const nu = doc(await (await col('users')).findOneAndUpdate(
      { _id: u._id, bonusDay: { $ne: today } },
      { $set: { bonusDay: today, bonusN: v.claimDay }, $inc: { coins: reward.c || 0, gems: reward.g || 0 } },
      { returnDocument: 'after' }
    ))
    if (!nu) return res.status(409).json({ error: 'Hari ini sudah diklaim.' })
    res.json({ ok: true, reward, daily: dailyView(nu, now), coins: nu.coins, gems: nu.gems })
  }))

  router.post('/api/auth/redeem', wrap(async (req, res) => {
    const u = await need(req, res); if (!u) return
    const code = String(req.body?.code ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
    if (code.length < 4 || code.length > 12) return res.status(400).json({ error: 'Kode tidak valid.' })
    if (!(await allow('redeem:' + u._id, 8, 3600)) || !(await allow('redeemip:' + ip(req), 10, 86400))) return res.status(429).json({ error: 'Terlalu banyak percobaan, coba lagi nanti.' })
    if (u.refBy) return res.status(409).json({ error: 'Kamu sudah pernah memakai kode referal.' })
    const users = await col('users')
    const inviter = await users.findOne({ refCode: code }, { projection: { _id: 1, invited: 1 } })
    if (!inviter) return res.status(404).json({ error: 'Kode tidak ditemukan.' })
    if (String(inviter._id) === String(u._id)) return res.status(400).json({ error: 'Kamu tidak bisa memakai kodemu sendiri.' })
    await ensureWallet(u)
    const give = REF.invitee
    // penjaga atomik: refBy belum ada. Hadiah teman dibayar di sini, lalu pemilik kode.
    const nu = doc(await users.findOneAndUpdate(
      { _id: u._id, refBy: { $exists: false } },
      { $set: { refBy: inviter._id, refAt: new Date() }, $inc: { coins: give.c || 0, gems: give.g || 0 } },
      { returnDocument: 'after' }
    ))
    if (!nu) return res.status(409).json({ error: 'Kamu sudah pernah memakai kode referal.' })
    const rewarded = (inviter.invited || 0) < REF_MAX_REWARDED
    try {
      await users.updateOne({ _id: inviter._id }, { $inc: { invited: 1, ...(rewarded ? { coins: REF.inviter.c || 0, gems: REF.inviter.g || 0 } : {}) } })
    } catch (e) { console.error('bonus: gagal memberi hadiah ke pemilik kode:', e?.message) }
    res.json({ ok: true, reward: fixed(give), coins: nu.coins, gems: nu.gems })
  }))
}
