import crypto from 'node:crypto'
import { Router } from 'express'
import { mongoEnabled, col } from './mongo.js'
import { allow } from './auth.js'
import { award, levelOf, xpTotalFor, mulFor, LEVEL, XP, XP_CAP } from './leveling.js'

// ===== API XP Eksternal (lib/xpext.js) =====
// Jalur resmi menambah/mengatur XP & level dari LUAR web: bot, giveaway, event, alat admin — apa pun yang
// tidak memegang token Bearer user. Dipasang di lib/app.js SEBELUM router lain (butuh parser JSON global),
// tidak pakai akun: pengirimnya diautentikasi dengan kunci env LEVEL_EXT_KEY lewat header `x-api-key`.
//
//   /api/xp/grant   tambah XP (amount, boleh negatif untuk koreksi) ATAU lompat ke level tertentu (setLevel)
//   /api/xp/lookup  baca level/xp/stats satu akun (tanpa mengubah apa pun)
//
// Target akun ditentukan `uid` ATAU `username` (salah satu). Contoh:
//   curl -X POST https://.../api/xp/grant -H 'x-api-key: <LEVEL_EXT_KEY>' \
//        -H 'content-type: application/json' -d '{"username":"nanda","amount":500,"reason":"Event Jumat"}'
//
// Kunci dibandingkan waktu-seragam (hash SHA-256 keduanya, timingSafeEqual) supaya tidak bisa dibedakan
// dari waktu respons. Kalau env LEVEL_EXT_KEY belum diisi -> endpoint menjawab 501 (fitur mati, bukan
// terbuka lebar). Batas laju per IP: 30 permintaan/menit. Semua grant tercatat di xp_log (src 'ext').

const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex')
const extKey = () => String(process.env.LEVEL_EXT_KEY || '').trim()
const ip = req => String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim().slice(0, 64) || 'unknown'

function okKey(req) {
  const k = extKey()
  if (!k) return false
  const given = String(req.get('x-api-key') || '')
  if (!given) return false
  try { return crypto.timingSafeEqual(Buffer.from(sha(k)), Buffer.from(sha(given))) } catch { return false }
}

const UID_RE = /^[\w-]{8,64}$/
const USER_RE = /^[a-z0-9_.-]{3,20}$/

// cari akun target dari uid / username. Balikan dokumen user, atau null kalau tidak ketemu/tidak valid.
async function resolveTarget(col, b) {
  const users = await col('users')
  const uid = String(b?.uid || '')
  if (UID_RE.test(uid)) return users.findOne({ _id: uid }, { projection: { salt: 0, hash: 0 } })
  const un = String(b?.username || '').trim().toLowerCase()
  if (USER_RE.test(un)) return users.findOne({ username: un }, { projection: { salt: 0, hash: 0 } })
  return null
}

const r = Router()

/* ---------- POST /api/xp/grant ---------- */
r.post('/api/xp/grant', async (req, res) => {
  if (!mongoEnabled()) return res.status(503).json({ error: 'Database tidak bisa dihubungi.' })
  if (!extKey()) return res.status(501).json({ error: 'API XP eksternal belum diaktifkan: isi env LEVEL_EXT_KEY di server.' })
  if (!okKey(req)) return res.status(403).json({ error: 'API key tidak valid (header x-api-key).' })
  try {
    if (!(await allow('xpg:' + ip(req), 30, 60))) return res.status(429).json({ error: 'Terlalu sering, tunggu sebentar.' })
    const b = req.body || {}
    const u = await resolveTarget(col, b)
    if (!u) return res.status(404).json({ error: 'Akun target tidak ditemukan. Kirim uid ATAU username yang valid.' })

    const ld = (await (await col('level')).findOne({ _id: u._id }, { projection: { xp: 1 } })) || {}
    const before = { level: levelOf(ld.xp || 0), xp: Math.max(0, ld.xp || 0) }

    // bentuk perintah: setLevel (lompat ke level tertentu, boleh turun) ATAU amount (selisih XP, boleh negatif)
    let amount = 0, setLevel = null
    if (Number.isInteger(b.setLevel)) {
      setLevel = Math.max(1, Math.min(LEVEL.max, b.setLevel))
      amount = xpTotalFor(setLevel) - before.xp
    } else {
      amount = Math.round(Number(b.amount))
      if (!Number.isFinite(amount) || amount === 0 || Math.abs(amount) > 1e6) return res.status(400).json({ error: 'Isi amount (bilangan bulat, maks ±1.000.000) atau setLevel (1-' + LEVEL.max + ').' })
    }
    if (amount === 0) { // sudah persis di level yang diminta: tidak ada yang berubah
      return res.json({ ok: true, uid: u._id, username: u.username, name: u.name || '', before, after: before, gained: 0, mul: mulFor(before.level), levelUp: null, notes: [], ...(setLevel ? { setLevel } : {}) })
    }
    const lr = await award(col, u, 'ext', amount, { note: b.reason })
    res.json({
      ok: true, uid: u._id, username: u.username, name: u.name || '',
      before, after: { level: lr.level, xp: lr.xp }, gained: lr.gained, mul: lr.mul,
      levelUp: lr.levelUp || null, notes: lr.notes, ...(setLevel ? { setLevel } : {})
    })
  } catch (e) {
    console.error('[xp:grant]', e?.message)
    res.status(502).json({ error: 'Grant XP gagal.' })
  }
})

/* ---------- POST /api/xp/lookup ---------- */
r.post('/api/xp/lookup', async (req, res) => {
  if (!mongoEnabled()) return res.status(503).json({ error: 'Database tidak bisa dihubungi.' })
  if (!extKey()) return res.status(501).json({ error: 'API XP eksternal belum diaktifkan: isi env LEVEL_EXT_KEY di server.' })
  if (!okKey(req)) return res.status(403).json({ error: 'API key tidak valid (header x-api-key).' })
  try {
    if (!(await allow('xpk:' + ip(req), 60, 60))) return res.status(429).json({ error: 'Terlalu sering, tunggu sebentar.' })
    const u = await resolveTarget(col, req.body || {})
    if (!u) return res.status(404).json({ error: 'Akun target tidak ditemukan. Kirim uid ATAU username yang valid.' })
    const d = (await (await col('level')).findOne({ _id: u._id })) || {}
    const xp = Math.max(0, d.xp || 0), level = levelOf(xp)
    res.json({
      ok: true, uid: u._id, username: u.username, name: u.name || '',
      level, xp, max: LEVEL.max, maxed: level >= LEVEL.max, mul: mulFor(level),
      nextAt: xpTotalFor(level + 1), stats: d.stats || {}, caps: XP_CAP, perAction: { gc: XP.gc, time: XP.time, win: XP.win }
    })
  } catch (e) {
    console.error('[xp:lookup]', e?.message)
    res.status(502).json({ error: 'Lookup gagal.' })
  }
})

export const xpExtRouter = r
