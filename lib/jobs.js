import crypto from 'node:crypto'
import { dayNum } from './bonus.js'
import { push as notify } from './notify.js'

// ===== Pekerjaan part-time: faucet coin harian yang terkontrol + alasan balik tiap beberapa jam =====
// Dipasang ke router auth (lib/auth.js) lewat mountJobs(). Desain: 4 pekerjaan dengan jeda berbeda —
// pemain memilih ritme sendiri (sering-receh atau jarang-lebih besar). Shift dikerjakan SEKALI SAAT
// ditekan (tanpa menunggu timer di server, cocok untuk serverless), hasil langsung.
//
// Keseimbangan faucet (dibanding klaim harian 50-200 coin + misi 40-100):
//   - Barista   : ~20 menit jeda, 30-50 coin  -> maks teoretis jika disiplin ~2.000/hari, TAPI
//   - Kuota harian JOB.dailyMax = 8 shift/hari (WIB) membatasi semua pekerjaan gabungan
//     -> penghasilan realistis 240-480 coin/hari untuk pemain paling rajin. Sebanding klaim+misir.
//   - Chance JOB.bonusChance (10%): shift "bonus" digaji 2x (variasi kecil yang bikin balik cek).
//
// Atomic & race-safe: state satu dokumen users.job { day, n, last:{<jobId>:ms} } diubah dengan
// findOneAndUpdate ber-syarat (optimistic seperti gacha pity di lib/economy.js): dua shift paralel
// (dua tab) hanya satu yang lolos; cooldown/jeda dijaga di filter, bukan di client.
//
// Endpoint (POST, token Bearer):
//   /api/auth/jobs      -> { ok, jobs:[...siap/jeda], daily, hist }
//   /api/auth/jobs/work -> { ok, job, pay, bonus, coins }   body { id }
//
// Field baru di `users`: job { day, n, last: { <jobId>: timestamp } }

// ===== Pekerjaan diatur di sini (tambahkan baris baru = tambah pekerjaan) =====
export const JOBS = [
  { id: 'barista', name: 'Barista', icon: 'coffee', cdMin: 20, pay: [30, 50], desc: 'Meracik kopi di kafe karakter favoritmu. Shift pendek, sering bisa diulang.' },
  { id: 'kurir', name: 'Kurir', icon: 'box', cdMin: 45, pay: [45, 75], desc: 'Antar paket keliling kota. Butuh fokus, bayarannya lebih baik.' },
  { id: 'satpam', name: 'Satpam', icon: 'shield', cdMin: 90, pay: [80, 130], desc: 'Jaga lapak malam. Shift panjang sekali dua kali sehari, tapi digaji besar.' },
  { id: 'pembersih', name: 'Pembersih Aset', icon: 'spark', cdMin: 180, pay: [150, 240], desc: 'Sapu bersih aset kolektor langka. Sekali sehari, bayaran terbesar.' }
]
export const JOB = { dailyMax: 8, bonusChance: 0.1 }

const JOB_IDS = new Set(JOBS.map(j => j.id))
const nf = n => Math.round(n).toLocaleString('id-ID')
const doc = r => (r && r.value !== undefined ? r.value : r)
const payOf = j => j.pay[0] + crypto.randomInt(j.pay[1] - j.pay[0] + 1)

async function log(col, uid, kind, txt, d) {
  try {
    await (await col('econ_log')).insertOne({
      _id: `${uid}:${Date.now().toString(36)}:${crypto.randomBytes(4).toString('hex')}`,
      uid, kind, txt, coins: d?.coins ?? 0, gems: 0, tickets: 0, chips: 0, at: new Date()
    })
  } catch { }
}

export function mountJobs(router, { wrap, userFromReq, allow, col, ensureWallet }) {
  const need = async (req, res) => {
    const a = await userFromReq(req)
    if (!a) { res.status(401).json({ error: 'Sesi berakhir, masuk lagi.' }); return null }
    return a.user
  }

  // daftar pekerjaan untuk tampilan: siap dikerjakan atau sisa jeda (ms) tiap pekerjaan
  const listView = u => {
    const job = u.job || {}, now = Date.now()
    return JOBS.map(j => {
      const last = Number(job.last?.[j.id]) || 0
      return { id: j.id, name: j.name, icon: j.icon, desc: j.desc, cdMin: j.cdMin, pay: j.pay, cdLeft: Math.max(0, last + j.cdMin * 60e3 - now) }
    })
  }

  // ---- Daftar + status hari ini ----
  router.post('/api/auth/jobs', wrap(async (req, res) => {
    const u = await need(req, res); if (!u) return
    if (!(await allow('job:' + u._id, 60, 60))) return res.status(429).json({ error: 'Terlalu sering, tunggu sebentar.' })
    const w = await ensureWallet(u)
    const job = u.job || {}, today = dayNum(Date.now())
    const hist = await (await col('econ_log')).find({ uid: u._id, kind: 'job' }).sort({ at: -1 }).limit(10).toArray().catch(() => [])
    res.json({
      ok: true,
      jobs: listView(u),
      daily: { used: job.day === today ? job.n : 0, max: JOB.dailyMax, bonusChance: JOB.bonusChance },
      coins: u.coins ?? w.coins,
      hist: hist.map(h => ({ txt: h.txt, coins: h.coins, at: h.at }))
    })
  }))

  // ---- Kerjakan satu shift ----
  router.post('/api/auth/jobs/work', wrap(async (req, res) => {
    const u = await need(req, res); if (!u) return
    if (!(await allow('jobw:' + u._id, 20, 60))) return res.status(429).json({ error: 'Terlalu sering, tunggu sebentar.' })
    const id = String(req.body?.id || '')
    const j = JOBS.find(x => x.id === id)
    if (!j) return res.status(400).json({ error: 'Pekerjaan tidak valid.' })
    await ensureWallet(u)
    const users = await col('users')
    const today = dayNum(Date.now()), now = Date.now()

    // up to 3 percobaan optimistic (pola gacha di lib/economy.js): baca state -> update dengan
    // syarat state yang persis sama -> kalau kebalapan (dua tab), ulangi baca. Dua shift paralel hanya satu lolos.
    let nu = null, pay = 0, bonus = false
    for (let attempt = 0; attempt < 3 && !nu; attempt++) {
      const cur = (await users.findOne({ _id: u._id })) || u
      const job = cur.job || {}
      const usedToday = job.day === today ? job.n : 0
      if (usedToday >= JOB.dailyMax) return res.status(429).json({ error: `Kuota kerja harian habis (${JOB.dailyMax} shift/hari). Balik lagi besok.` })
      const last = Number(job.last?.[j.id]) || 0
      const cdLeft = last + j.cdMin * 60e3 - now
      if (cdLeft > 0) return res.status(429).json({ error: `Pekerjaan ini belum siap: tunggu ${Math.ceil(cdLeft / 60000)} menit lagi.` })

      pay = payOf(j)
      bonus = Math.random() < JOB.bonusChance
      if (bonus) pay *= 2
      nu = job.day === today
        // masih hari yang sama: jaga jumlah shift yang dibaca (race antar tab) + jeda di filter
        ? doc(await users.findOneAndUpdate(
            { _id: u._id, 'job.day': today, 'job.n': job.n ?? 0 },
            { $set: { [`job.last.${j.id}`]: now }, $inc: { 'job.n': 1, coins: pay } },
            { returnDocument: 'after' }))
        // hari baru / belum pernah kerja: reset harian (guard: hari di DB masih bukan hari ini)
        : doc(await users.findOneAndUpdate(
            { _id: u._id, $or: [{ 'job.day': { $ne: today } }, { 'job.day': { $exists: false } }] },
            { $set: { [`job.last.${j.id}`]: now, 'job.day': today, 'job.n': 1 }, $inc: { coins: pay } },
            { returnDocument: 'after' }))
    }
    if (!nu) return res.status(503).json({ ok: false, error: 'Server sibuk, coba kerjakan lagi.' })

    await log(col, u._id, 'job', `Kerja ${j.name}${bonus ? ' (shift bonus 2x)' : ''}: +${nf(pay)} coin`, { coins: pay })
    if (bonus) await notify(col, u._id, 'sys', `Shift bonus! Gaji ${j.name} hari ini digaji dobel: +${nf(pay)} Coin.`)
    res.json({ ok: true, job: j.id, name: j.name, pay, bonus, coins: nu.coins, daily: { used: (nu.job?.n) || 1, max: JOB.dailyMax } })
  }))
}
