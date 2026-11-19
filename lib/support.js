import crypto from 'node:crypto'
import { dayNum } from './bonus.js'
import { trustOk } from './transfer.js'
import { push as notify } from './notify.js'

// ===== Dukung kreator: kirim Gems ke pembuat sebuah AI (tombol "Dukung" di halaman detail karakter) =====
// Kenapa BUKAN lewat lib/transfer.js: transfer hanya untuk Coin/barang, memotong fee 5%, dan Gems sengaja tidak bisa ditransfer.
// Dukungan ini kebalikannya: yang dikirim Gems, penerima mendapat SELURUH jumlah (tanpa biaya platform).
//
// Karena Gems tidak punya fee/sink, pagar anti-ternak-akun (lihat catatan di lib/transfer.js) dipasang di sini:
//   - pengirim harus akun berumur minimal ECON_TRUST_HOURS (trustOk, default 24 jam)
//   - batas per kiriman (min 1, maks SUPPORT.max) dan batas total per hari WIB (SUPPORT.dayMax)
//   - tidak bisa mendukung diri sendiri; pembatas laju per akun
//   - atomic: satu findOneAndUpdate ber-syarat saldo untuk potong pengirim; kalau penerima gagal ditambah, potongan dikembalikan
//   - idempotent lewat `idem` (econ_txn), sama seperti lib/transfer.js
//
// Koleksi `supports` { _id, from, to, charId, amount, at } — "Dukungan diterima" = jumlah dokumen dengan `to` = pembuat.
// Riwayat saldo: econ_log kind 'support-out' / 'support-in' (field gems) + notifikasi (type 'sys') ke penerima.
//
// Endpoint (POST):
//   /api/auth/support/info  { username }                      (login opsional) -> { ok, received, isMe, gems?, trust?, dayLeft?, rates }
//   /api/auth/support/send  { to: username, amount, char?, idem }   (login) -> { ok, gems, received, done: { to, amount }, dayLeft }
export const SUPPORT = { presets: [5, 20, 50], min: 1, max: 1000, dayMax: 1000 }

const DAY = 86400e3, WIB = 7 * 3600e3
const IDEM_RE = /^[\w-]{8,64}$/
const CHAR_RE = /^[\w.-]{1,64}$/
const doc = r => (r && r.value !== undefined ? r.value : r)
const nf = n => Math.round(n).toLocaleString('id-ID')
const startOfDay = () => (dayNum(Date.now()) * DAY) - WIB

async function log(col, uid, kind, txt, gems) {
  try {
    await (await col('econ_log')).insertOne({
      _id: `${uid}:${Date.now().toString(36)}:${crypto.randomBytes(4).toString('hex')}`,
      uid, kind, txt, coins: 0, gems, tickets: 0, chips: 0, items: 0, at: new Date()
    })
  } catch { }
}
async function onceOnly(col, uid, idem) {
  if (!idem) return true
  try { await (await col('econ_txn')).insertOne({ _id: `${uid}:${idem}`, uid, at: new Date() }); return true }
  catch (e) { if (e?.code === 11000) return false; throw e }
}
const unIdem = (col, uid, idem) => idem ? col('econ_txn').then(c => c.deleteOne({ _id: `${uid}:${idem}` })).catch(() => { }) : null

// Hapus semua dukungan yang terkait satu akun (dipanggil saat akun dihapus di lib/auth.js)
export async function purgeSupport(col, userId) {
  await (await col('supports')).deleteMany({ $or: [{ from: userId }, { to: userId }] })
}

export function mountSupport(router, { wrap, userFromReq, allow, col, ensureWallet, ensureIndexes }) {
  let ready
  const init = () => ready ??= ensureIndexes('supports', [[{ to: 1 }], [{ from: 1, at: -1 }]]).catch(e => { ready = null; throw e })
  const ipOf = req => String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim().slice(0, 64) || 'unknown'
  const sentToday = async uid => {
    const rows = await (await col('supports')).find({ from: uid, at: { $gte: new Date(startOfDay()) } }, { projection: { amount: 1 } }).toArray()
    return rows.reduce((s, r) => s + (r.amount || 0), 0)
  }
  const receivedOf = async uid => (await col('supports')).countDocuments({ to: uid })
  const rates = () => ({ presets: SUPPORT.presets, min: SUPPORT.min, max: SUPPORT.max, dayMax: SUPPORT.dayMax })
  const findTarget = async name => {
    const t = String(name || '').trim().toLowerCase()
    return /^[a-z0-9_.-]{3,20}$/.test(t) ? (await col('users')).findOne({ username: t }) : null
  }

  router.post('/api/auth/support/info', wrap(async (req, res) => {
    const a = await userFromReq(req).catch(() => null)
    if (!(await allow('sinf:' + (a?.user?._id || ipOf(req)), 120, 60))) return res.status(429).json({ error: 'Terlalu sering, tunggu sebentar.' })
    await init()
    const t = await findTarget(req.body?.username)
    if (!t) return res.status(404).json({ error: 'Pembuat tidak ditemukan.' })
    const out = { ok: true, received: await receivedOf(t._id), isMe: !!a && String(a.user._id) === String(t._id), rates: rates() }
    if (a) {
      const w = await ensureWallet(a.user)
      out.gems = a.user.gems ?? w.gems
      out.trust = trustOk(a.user)
      out.dayLeft = Math.max(0, SUPPORT.dayMax - await sentToday(a.user._id))
    }
    res.json(out)
  }))

  router.post('/api/auth/support/send', wrap(async (req, res) => {
    const a = await userFromReq(req)
    if (!a) return res.status(401).json({ error: 'Sesi berakhir, masuk lagi.' })
    const u = a.user
    if (!(await allow('sups:' + u._id, 10, 60))) return res.status(429).json({ error: 'Terlalu sering, tunggu sebentar.' })
    await init()
    const amount = Math.floor(Number(req.body?.amount))
    const idem = IDEM_RE.test(String(req.body?.idem || '')) ? String(req.body.idem) : null
    const charId = CHAR_RE.test(String(req.body?.char || '')) ? String(req.body.char) : ''
    if (!Number.isFinite(amount) || amount < SUPPORT.min) return res.status(400).json({ error: `Jumlah dukungan minimal ${SUPPORT.min} Gems.` })
    if (amount > SUPPORT.max) return res.status(400).json({ error: `Jumlah dukungan maksimal ${nf(SUPPORT.max)} Gems per kiriman.` })
    const t = await findTarget(req.body?.to)
    if (!t) return res.status(404).json({ error: 'Pembuat tidak ditemukan.' })
    if (String(t._id) === String(u._id)) return res.status(400).json({ error: 'Tidak bisa mendukung diri sendiri.' })
    if (!trustOk(u)) return res.status(403).json({ error: 'Dukungan butuh akun berumur minimal 24 jam (anti akun cadangan).' })
    const used = await sentToday(u._id)
    if (used + amount > SUPPORT.dayMax) return res.status(429).json({ error: `Batas dukungan harian ${nf(SUPPORT.dayMax)} Gems (sisa ${nf(Math.max(0, SUPPORT.dayMax - used))}).` })
    await ensureWallet(u); await ensureWallet(t)
    if (!(await onceOnly(col, u._id, idem))) return res.status(409).json({ error: 'Dukungan ini sudah diproses.' })

    const users = await col('users')
    // 1) potong pengirim: satu update atomik ber-syarat saldo
    const nu = doc(await users.findOneAndUpdate({ _id: u._id, gems: { $gte: amount } }, { $inc: { gems: -amount } }, { returnDocument: 'after' }))
    if (!nu) {
      await unIdem(col, u._id, idem)
      const cur = (await users.findOne({ _id: u._id })) || u
      return res.status(409).json({ ok: false, error: 'Gems kamu belum cukup.', gems: cur.gems ?? 0 })
    }
    // 2) tambahkan SELURUH jumlah ke penerima (tanpa fee). Gagal (akun hilang) -> kembalikan potongan pengirim.
    const r = await users.updateOne({ _id: t._id }, { $inc: { gems: amount } })
    if (!r.matchedCount) {
      await users.updateOne({ _id: u._id }, { $inc: { gems: amount } }).catch(() => { })
      await unIdem(col, u._id, idem)
      return res.status(404).json({ error: 'Pembuat tidak ditemukan.' })
    }
    // 3) catat + notifikasi penerima (best-effort)
    const fromName = u.name || u.username, toName = t.name || t.username
    await (await col('supports')).insertOne({ _id: `${u._id}:${Date.now().toString(36)}:${crypto.randomBytes(4).toString('hex')}`, from: u._id, to: t._id, charId, amount, at: new Date() }).catch(e => console.error('[support] catat gagal:', e?.message))
    await log(col, u._id, 'support-out', `Dukungan ke ${toName}: ${nf(amount)} Gems`, -amount)
    await log(col, t._id, 'support-in', `Dukungan dari ${fromName}: ${nf(amount)} Gems`, amount)
    await notify(col, t._id, 'sys', `${fromName} mendukungmu ${nf(amount)} Gems 💗`)
    res.json({ ok: true, gems: nu.gems, received: await receivedOf(t._id), done: { to: toName, amount }, dayLeft: Math.max(0, SUPPORT.dayMax - used - amount) })
  }))
}
