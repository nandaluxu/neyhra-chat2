import crypto from 'node:crypto'
import { push as notify } from './notify.js'
import { trustOk } from './transfer.js'

// ===== Sistem Pencurian antar-player (robbery): gameplay sosial berisiko =====
// Dipasang ke router auth (lib/auth.js) lewat mountRobbery(). Pemain mencoba mencuri Coin DOMPET
// pemain lain (saldo Bank di lib/bank.js TIDAK tersentuh). Desainnya menjaga pemain baru tetap aman:
//
//   - Target sah hanya dompet >= ROB.pocketMin (500): akun baru (150 coin) & pemain tipis tidak bisa dijarah.
//   - Pencuri juga harus punya dompet >= ROB.stake (200): kalau gagal dia bayar ganti rugi ke korban,
//     jadi mencuri sambil bokek itu bunuh diri sendiri.
//   - Perisai (shield): beli 24 jam dengan GEMS (sink premium yang selama ini cuma bisa beli tiket),
//     memblokir semua percobaan. Perisai bertumpuk (waktu ditambah, tidak ditimpa).
//   - Wanted (status buronan): berhasil +1, gagal +2 pada PENCIURI. Wanted membuat peluang orang lain
//     mencuri kamu naik (+5% per poin), meluruh 1 poin tiap ROB.wantedDecayH jam (lazy saat dibaca).
//   - Cooldown ROB.cdMin antar percobaan + maks ROB.dailyMax percobaan/hari (WIB): spam dan ternak akun
//     tidak menguntungkan (curian 5-15% dompet kecil = receh, dan tiap akun baru cuma bawa 150 coin).
//   - Gagal = pencuri bayar ganti rugi ke korban (pindah antar pemain, BUKAN faucet). Berhasil =
//     wanted tetap naik (kejahatan meninggalkan jejak).
//   - Atomic: percobaan dicatat dengan SATU findOneAndUpdate ber-syarat (cooldown+kuota harian tidak
//     bisa dilompati dua tab paralel); potong korban dulu dengan syarat saldo di filter (tidak bisa
//     minus/dobel), baru kredit pencuri; langkah kedua gagal -> korban dikembalikan (kompensasi).
//   - Riwayat: koleksi rob_log (TTL 180 hari) + econ_log pihak-pihak (kind rob-win/rob-gain/rob-fine)
//     supaya tetap muncul di riwayat ekonomi + notifikasi ke korban untuk SEMUA hasil.
//
// Endpoint (POST, token Bearer):
//   /api/auth/rob         -> { ok, stats, cd, daily, wanted, shield, rates, hist }
//   /api/auth/rob/attempt -> { ok, out:'win'|'fail'|'shield', ... }   body { username }
//   /api/auth/rob/shield  -> { ok, shieldUntil, gems }                (beli perisai 24 jam)
//
// Field baru di `users`: rob { lastAt, day, n, win, fail, got, fine, lost, back, wanted, wantedAt, shieldUntil }
//   got = coin hasil curian | fine = ganti rugi yang pernah dibayar (sebagai pencuri)
//   lost = coin hilang dijarah | back = ganti rugi yang diterima (sebagai korban)

// ===== Angka pencurian diatur di sini =====
export const ROB = {
  baseChance: 0.35,       // peluang dasar berhasil
  pocketMin: 500,         // dompet korban minimal ini agar bisa jadi target
  stake: 200,             // dompet pencuri minimal ini untuk mencoba
  stealPct: [0.05, 0.15], // rentang persen dompet korban yang diambil saat berhasil
  maxStolen: 5000,        // plafon curian sekali berhasil
  cdMin: 30,              // jeda antar percobaan (menit)
  dailyMax: 5,            // maksimal percobaan per hari (WIB)
  wantedMax: 10,          // plafon wanted
  wantedDecayH: 6,        // wanted luruh 1 poin tiap jam ini
  wantedPerWin: 1,        // wanted +1 kalau berhasil
  wantedPerFail: 2,       // wanted +2 kalau gagal
  shieldGems: 5,           // harga perisai (gems)
  shieldHours: 24         // durasi perisai (jam)
}

const TTL_DAYS = 180
const nf = n => Math.round(n).toLocaleString('id-ID')
const doc = r => (r && r.value !== undefined ? r.value : r)

// peluang berhasil mengincor target: dasar + wanted TARGET (makin buronan makin gampang dijarah)
export const chanceFor = wanted => Math.min(0.8, ROB.baseChance + Math.min(ROB.wantedMax, Math.max(0, wanted)) * 0.05)

// nilai curian yang diincar: persen acak dari dompet korban (diputuskan server sebelum hasil)
export const rollSteal = pocket => Math.max(1, Math.min(ROB.maxStolen, Math.round(pocket * (ROB.stealPct[0] + Math.random() * (ROB.stealPct[1] - ROB.stealPct[0])))))

// wanted sekarang setelah peluruhan (jam sejak wantedAt): -1 poin tiap wantedDecayH jam
export const wantedNow = rob => {
  const w = Math.max(0, Math.min(ROB.wantedMax, Math.floor(Number(rob?.wanted) || 0)))
  if (!w) return 0
  const at = rob?.wantedAt?.getTime?.() || 0
  return Math.max(0, w - Math.floor(Math.max(0, Date.now() - at) / (ROB.wantedDecayH * 3600e3)))
}

// ganti rugi saat gagal: setengah dari nilai yang diincar, dikunci 25..500
export const fineFor = attempted => Math.min(500, Math.max(25, Math.round(attempted / 2)))

// Hapus data pencurian yang menyebut satu akun (dipanggil saat akun dihapus)
export async function purgeRob(col, userId) {
  await (await col('rob_log')).deleteMany({ $or: [{ atk: userId }, { vic: userId }] })
}

export function mountRobbery(router, { wrap, userFromReq, allow, col, ensureWallet }) {
  let ready
  const init = () => ready ??= (async () => {
    const c = await col('rob_log')
    await c.createIndex({ atk: 1, at: -1 }); await c.createIndex({ vic: 1, at: -1 }); await c.createIndex({ at: 1 }, { expireAfterSeconds: TTL_DAYS * 86400 })
  })().catch(e => { ready = null; throw e })
  const need = async (req, res) => {
    const a = await userFromReq(req)
    if (!a) { res.status(401).json({ error: 'Sesi berakhir, masuk lagi.' }); return null }
    return a.user
  }
  const todayNum = () => Math.floor((Date.now() + 7 * 3600e3) / 86400e3) // hari WIB (pola dayNum di lib/bonus.js)

  // catat ke rob_log (riwayat pencurian) + econ_log kedua pihak (ikut riwayat ekonomi) — best-effort
  async function log(col, atk, vic, out, amt, fine) {
    try { await (await col('rob_log')).insertOne({ _id: `${atk}:${Date.now().toString(36)}:${crypto.randomBytes(4).toString('hex')}`, atk, vic, out, amt, fine, at: new Date() }) } catch { }
    try {
      const k = { win: ['rob-gain', 'rob-lost'], fail: ['rob-fine', 'rob-back'], shield: ['rob-fine', 'rob-back'] }[out] || ['rob', 'rob']
      await (await col('econ_log')).insertMany([
        { _id: `${atk}:${Date.now().toString(36)}:${crypto.randomBytes(4).toString('hex')}`, uid: atk, kind: k[0], txt: `Pencurian ke ${vic} (${out})`, coins: out === 'win' ? amt : -fine, at: new Date() },
        { _id: `${vic}:${Date.now().toString(36)}:${crypto.randomBytes(4).toString('hex')}`, uid: vic, kind: k[1], txt: `Jadi target pencurian (${out})`, coins: out === 'win' ? -amt : fine, at: new Date() }
      ])
    } catch { }
  }

  // wanted terluruhan -> disimpan balik (lazy decay) + jangkar waktu dilakukan ulang (supaya pembacaan
  // berikutnya tidak meluruhkan dua kali), kembalikan dokumen terbaru
  async function decayWanted(u) {
    const cur = Math.max(0, Math.floor(Number(u.rob?.wanted) || 0)), w = wantedNow(u.rob)
    if (w >= cur) return u
    const nu = doc(await (await col('users')).findOneAndUpdate({ _id: u._id }, { $set: { 'rob.wanted': w, ...(w ? { 'rob.wantedAt': new Date() } : {}) } }, { returnDocument: 'after' }))
    return nu || u
  }

  async function statsOf(u) {
    await init()
    const fresh = await decayWanted(u)
    const rob = fresh.rob || {}, day = todayNum()
    const dayN = (rob.day === day ? rob.n : 0)
    const cdLeft = Math.max(0, (rob.lastAt || 0) + ROB.cdMin * 60e3 - Date.now())
    const hist = await (await col('rob_log')).find({ $or: [{ atk: fresh._id }, { vic: fresh._id }] }).sort({ at: -1 }).limit(15).toArray()
    const ids = [...new Set(hist.flatMap(h => [h.atk, h.vic]))]
    const us = ids.length ? await (await col('users')).find({ _id: { $in: ids } }, { projection: { username: 1, name: 1 } }).toArray() : []
    const byId = new Map(us.map(x => [x._id, x.name || x.username]))
    const myName = fresh.name || fresh.username
    return {
      ok: true,
      me: myName,
      stats: { win: rob.win || 0, fail: rob.fail || 0, got: rob.got || 0, fine: rob.fine || 0, lost: rob.lost || 0, back: rob.back || 0, wanted: wantedNow(rob), wantedMax: ROB.wantedMax, chanceOfMe: chanceFor(wantedNow(rob)) },
      cd: { leftMs: cdLeft, min: ROB.cdMin },
      daily: { used: dayN, max: ROB.dailyMax },
      shield: { until: rob.shieldUntil || 0, gems: ROB.shieldGems, hours: ROB.shieldHours },
      rates: { ...ROB, chanceAt0: ROB.baseChance },
      hist: hist.map(h => ({ at: h.at, out: h.out, amt: h.amt, fine: h.fine, role: h.atk === fresh._id ? 'atk' : 'vic', other: byId.get(h.atk === fresh._id ? h.vic : h.atk) || 'Pengguna' }))
    }
  }

  // ---- Ringkasan + riwayat ----
  router.post('/api/auth/rob', wrap(async (req, res) => {
    const u = await need(req, res); if (!u) return
    if (!(await allow('rob:' + u._id, 60, 60))) return res.status(429).json({ error: 'Terlalu sering, tunggu sebentar.' })
    res.json(await statsOf(u))
  }))

  // ---- Beli perisai (GEMS -> kebal pencurian, bisa bertumpuk) ----
  router.post('/api/auth/rob/shield', wrap(async (req, res) => {
    const u = await need(req, res); if (!u) return
    if (!(await allow('robs:' + u._id, 10, 3600))) return res.status(429).json({ error: 'Terlalu sering, tunggu sebentar.' })
    await init()
    const until = Math.max(Date.now(), Number(u.rob?.shieldUntil) || 0) + ROB.shieldHours * 3600e3
    const nu = doc(await (await col('users')).findOneAndUpdate(
      { _id: u._id, gems: { $gte: ROB.shieldGems } },
      { $inc: { gems: -ROB.shieldGems }, $set: { 'rob.shieldUntil': until } },
      { returnDocument: 'after' }
    ))
    if (!nu) return res.status(409).json({ ok: false, error: `Butuh ${ROB.shieldGems} Gems untuk perisai.`, gems: u.gems })
    await notify(col, u._id, 'rob', `Perisai anti-maling aktif ${ROB.shieldHours} jam (sampai ${new Date(until).toLocaleString('id-ID')}).`)
    res.json({ ok: true, shieldUntil: until, gems: nu.gems })
  }))

  // ---- Mencoba mencuri dompet pemain lain ----
  router.post('/api/auth/rob/attempt', wrap(async (req, res) => {
    const u = await need(req, res); if (!u) return
    if (!(await allow('roba:' + u._id, 12, 60))) return res.status(429).json({ error: 'Terlalu sering, tunggu sebentar.' })
    await init()
    const users = await col('users')

    // gerbang pencuri (cepat, dari data yang dibaca; yang atomik ada di stamp di bawah)
    if (!trustOk(u)) return res.status(403).json({ error: 'Butuh akun berumur cukup untuk mencuri (anti akun cadangan).' })
    const rob = u.rob || {}, day = todayNum(), now = Date.now()
    const cdLeft = Math.max(0, (rob.lastAt || 0) + ROB.cdMin * 60e3 - now)
    if (cdLeft > 0) return res.status(429).json({ error: `Tunggu cooldown ${Math.ceil(cdLeft / 60000)} menit lagi.` })
    if (rob.day === day && (rob.n || 0) >= ROB.dailyMax) return res.status(429).json({ error: `Maksimal ${ROB.dailyMax} percobaan per hari.` })
    const pocket = Math.max(0, Math.floor(Number(u.coins) || 0))
    if (pocket < ROB.stake) return res.status(400).json({ error: `Dompetmu harus punya minimal ${nf(ROB.stake)} Coin untuk mencuri (jaga modal ganti rugi).` })

    // target
    const to = String(req.body?.username || '').trim().toLowerCase()
    if (!to) return res.status(400).json({ error: 'Isi username target.' })
    const t = await users.findOne({ username: to })
    if (!t) return res.status(404).json({ error: 'Target tidak ditemukan.' })
    if (String(t._id) === String(u._id)) return res.status(400).json({ error: 'Tidak bisa mencuri dari diri sendiri.' })
    const tPocket = Math.max(0, Math.floor(Number(t.coins) || 0))
    if (tPocket < ROB.pocketMin) return res.status(400).json({ error: `Dompet ${t.name || t.username} terlalu tipis untuk diincar (target minimal ${nf(ROB.pocketMin)} Coin di dompet).` })

    // catat percobaan + cooldown SATU update atomik. Syarat di filter ($exists untuk lastAt yang
    // belum ada, $ne untuk hari yang belum ada) membuat dua tab paralel hanya satu yang lolos.
    const freshDay = (rob.day || 0) !== day
    const stamp = doc(await users.findOneAndUpdate(
      { _id: u._id, $and: [
        { $or: [{ 'rob.day': { $ne: day } }, { 'rob.n': { $lt: ROB.dailyMax } }] },
        { $or: [{ 'rob.lastAt': { $exists: false } }, { 'rob.lastAt': { $lt: now - ROB.cdMin * 60e3 } }] }
      ] },
      freshDay ? { $set: { 'rob.lastAt': now, 'rob.day': day, 'rob.n': 1 } } : { $set: { 'rob.lastAt': now }, $inc: { 'rob.n': 1 } },
      { returnDocument: 'after' }
    ))
    if (!stamp) return res.status(429).json({ error: 'Percobaanmu masih di cooldown atau kuota hari ini habis.' })

    // target: luruhkan wanted-nya dulu (lazy) supaya peluang dihitung dari nilai yang benar
    const tF = await decayWanted(t)

    const tName = t.name || t.username, myName = u.name || u.username
    const tWanted = wantedNow(tF.rob)                      // wanted target setelah luruh lazy
    const attempted = rollSteal(tPocket)                        // nilai incian (diputuskan server)
    const shielded = (Number(t.rob?.shieldUntil) || 0) > now     // perisai korban aktif
    const chance = chanceFor(tWanted)                            // wanted korban menaikkan peluang
    const win = !shielded && Math.random() < chance

    // HASIL 1: berhasil -> korban kehilangan nilai incian (potong atomik), pencuri menerima penuh
    if (win) {
      const vic = doc(await users.findOneAndUpdate(
        { _id: t._id, coins: { $gte: attempted } },
        { $inc: { coins: -attempted, 'rob.lost': attempted } },
        { returnDocument: 'after' }
      ))
      if (vic) {
        const got = doc(await users.findOneAndUpdate(
          { _id: u._id },
          { $inc: { coins: attempted, 'rob.win': 1, 'rob.got': attempted, 'rob.wanted': ROB.wantedPerWin }, $max: { 'rob.wantedAt': new Date() } },
          { returnDocument: 'after' }
        ))
        if (!got) await users.updateOne({ _id: t._id }, { $inc: { coins: attempted } }).catch(() => { }) // sangat jarang: korban dikembalikan
        await log(col, u._id, t._id, 'win', attempted, 0)
        await notify(col, t._id, 'rob', `${myName} berhasil mencuri ${nf(attempted)} Coin dari dompetmu! Coin di Bank aman dari pencurian.`, { u: myName })
        return res.json({ ok: true, out: 'win', stolen: attempted, coins: got?.coins, wanted: wantedNow(got?.rob) })
      }
    }

    // HASIL 2: gagal (termasuk terhalang perisai) -> pencuri bayar ganti rugi ke korban.
    // Fine tidak pernah lebih dari dompet pencuri; kalau dompetnya keburu habis (race), hangus tanpa fine.
    const fine = Math.min(fineFor(attempted), pocket)
    const paid = doc(await users.findOneAndUpdate(
      { _id: u._id, coins: { $gte: fine } },
      { $inc: { coins: -fine, 'rob.fail': 1, 'rob.fine': fine, 'rob.wanted': ROB.wantedPerFail }, $max: { 'rob.wantedAt': new Date() } },
      { returnDocument: 'after' }
    ))
    if (paid && fine > 0) {
      await users.updateOne({ _id: t._id }, { $inc: { coins: fine, 'rob.back': fine } })
      await log(col, u._id, t._id, shielded ? 'shield' : 'fail', attempted, fine)
      await notify(col, t._id, 'rob', shielded
        ? `Perisaimu menggagalkan ${myName} yang mencoba mencuri ${nf(attempted)} Coin — dia terpaksa bayar ganti rugi ${nf(fine)} Coin ke kamu.`
        : `${myName} mencoba mencuri ${nf(attempted)} Coin darimu tapi GAGAL — dia ketahuan dan membayar ganti rugi ${nf(fine)} Coin ke kamu.`, { u: myName })
      return res.json({ ok: true, out: shielded ? 'shield' : 'fail', fine, attempted, coins: paid.coins, wanted: wantedNow(paid.rob) })
    }
    await log(col, u._id, t._id, shielded ? 'shield' : 'fail', attempted, 0)
    await notify(col, t._id, 'rob', `${myName} mencoba mencuri ${nf(attempted)} Coin darimu tapi gagal (dompetnya kosong untuk ganti rugi).`)
    return res.json({ ok: true, out: 'fail', fine: 0, attempted, coins: paid?.coins ?? u.coins, wanted: wantedNow(paid?.rob || u.rob) })
  }))
}
