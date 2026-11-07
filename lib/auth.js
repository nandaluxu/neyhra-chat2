import express from 'express'
import crypto from 'node:crypto'
import { promisify } from 'node:util'
import { mongoEnabled, col, ensureIndexes } from './mongo.js'
import { mountBonus } from './bonus.js'
import { mountGames } from './games.js'
import { mountPic } from './picgame.js'
import { mountProfile, purgeProfile } from './profile.js'

// Login sederhana, tujuannya satu: memindahkan data obrolan antar perangkat. Bukan sistem keamanan tingkat tinggi.
// Koleksi MongoDB:
//   users         { _id, username (huruf kecil, unik), name (tampilan), salt, hash, coins, gems, createdAt }
//                 + bonus (lib/bonus.js): bonusDay, bonusN, refCode (unik), invited, refBy, refAt
//                 + profil (lib/profile.js): name (boleh diubah), bio, av (versi foto). Koleksi lain: avatars (foto), follows (ikuti/diikuti)
//                 coins/gems = saldo akun. Akun baru dapat START_COINS & START_GEMS. Hanya server yang boleh mengubahnya (client cuma membaca lewat /api/auth/me).
//   auth_sessions { _id: sha256(token), userId, createdAt }   -> kedaluwarsa otomatis (TTL) 60 hari
//   userdata      { _id: userId, data: "<JSON string>", size, updatedAt }
//   auth_rl       { _id: kunci, n, exp }                      -> pembatas laju, hapus otomatis (TTL)
// Password di-hash scrypt + salt acak. Token sesi acak 256-bit, yang disimpan di DB cuma hash-nya.
// Semua endpoint POST (kecuali tak ada yang GET), token lewat header Authorization: Bearer <token>.

const scrypt = promisify(crypto.scrypt)
const SESSION_DAYS = 60
const MAX_DATA = 3.5 * 1024 * 1024 // Vercel membatasi body request ±4,5 MB
const USER_RE = /^[a-z0-9_.-]{3,20}$/
const START_COINS = 150, START_GEMS = 10 // saldo awal akun baru

const sha = s => crypto.createHash('sha256').update(s).digest('hex')
const newToken = () => crypto.randomBytes(32).toString('base64url')
const hashPw = async (pw, salt) => (await scrypt(pw, salt, 64)).toString('hex')
const ip = req => String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim().slice(0, 64) || 'unknown'

let ready
const init = () => ready ??= Promise.all([
  ensureIndexes('users', [[{ username: 1 }, { unique: true }], [{ refCode: 1 }, { unique: true, sparse: true }], [{ createdAt: -1 }]]), // createdAt: daftar "Baru bergabung" di tab Profil
  ensureIndexes('auth_sessions', [[{ createdAt: 1 }, { expireAfterSeconds: SESSION_DAYS * 86400 }], [{ userId: 1 }]]),
  ensureIndexes('auth_rl', [[{ exp: 1 }, { expireAfterSeconds: 0 }]])
]).catch(e => { ready = null; throw e })

// Pembatas laju berbasis Mongo (serverless tidak punya memori bersama). true = masih boleh.
async function allow(key, limit, windowSec) {
  const win = Math.floor(Date.now() / (windowSec * 1000))
  const r = await (await col('auth_rl')).findOneAndUpdate(
    { _id: `${key}:${win}` },
    { $inc: { n: 1 }, $setOnInsert: { exp: new Date((win + 2) * windowSec * 1000) } },
    { upsert: true, returnDocument: 'after' }
  )
  return (r?.n ?? r?.value?.n ?? 1) <= limit
}

async function userFromReq(req) {
  const m = /^Bearer ([\w-]{20,64})$/.exec(req.headers.authorization || '')
  if (!m) return null
  const s = await (await col('auth_sessions')).findOne({ _id: sha(m[1]) })
  if (!s) return null
  const u = await (await col('users')).findOne({ _id: s.userId })
  return u ? { user: u, sid: s._id } : null
}

async function startSession(userId) {
  const token = newToken()
  await (await col('auth_sessions')).insertOne({ _id: sha(token), userId, createdAt: new Date() })
  return token
}

// akun lama (dibuat sebelum ada saldo): isi saldo awal sekali saja. Filter $exists menjaga saldo yang sudah ada tidak tertimpa.
async function ensureWallet(u) {
  let { coins, gems } = u
  if (typeof coins !== 'number') { coins = START_COINS; await (await col('users')).updateOne({ _id: u._id, coins: { $exists: false } }, { $set: { coins } }) }
  if (typeof gems !== 'number') { gems = START_GEMS; await (await col('users')).updateOne({ _id: u._id, gems: { $exists: false } }, { $set: { gems } }) }
  return { coins, gems }
}

const router = express.Router()
router.use('/api/auth', express.json({ limit: '4mb' })) // lebih besar dari batas global (50 KB) karena push membawa data obrolan

// semua endpoint butuh Mongo; kalau belum diisi -> { enabled: false } supaya UI menyembunyikan fitur
router.use('/api/auth', async (req, res, next) => {
  if (!mongoEnabled()) return res.json({ enabled: false })
  try { await init(); next() } catch { res.status(503).json({ error: 'Database tidak bisa dihubungi.' }) }
})

const wrap = fn => async (req, res) => {
  try { await fn(req, res) } catch (e) { console.error('auth:', e?.message); res.status(500).json({ error: 'Terjadi kesalahan di server.' }) }
}
const cred = b => {
  const username = String(b?.username ?? '').trim().toLowerCase(), password = String(b?.password ?? '')
  return { username, password, name: String(b?.username ?? '').trim() }
}

router.post('/api/auth/register', wrap(async (req, res) => {
  const { username, password, name } = cred(req.body)
  if (!USER_RE.test(username)) return res.status(400).json({ error: 'Username 3-20 karakter: huruf, angka, titik, strip, atau garis bawah.' })
  if (password.length < 6 || password.length > 100) return res.status(400).json({ error: 'Password minimal 6 karakter.' })
  if (!(await allow('reg:' + ip(req), 5, 3600))) return res.status(429).json({ error: 'Terlalu banyak percobaan, coba lagi nanti.' })
  const salt = crypto.randomBytes(16).toString('hex')
  const doc = { _id: crypto.randomUUID(), username, name: name.slice(0, 20), salt, hash: await hashPw(password, salt), coins: START_COINS, gems: START_GEMS, createdAt: new Date() }
  try { await (await col('users')).insertOne(doc) }
  catch (e) { if (e?.code === 11000) return res.status(409).json({ error: 'Username sudah dipakai.' }); throw e }
  res.json({ ok: true, token: await startSession(doc._id), uid: doc._id, gid: gcSenderId(doc._id), name: doc.name, coins: doc.coins, gems: doc.gems })
}))

router.post('/api/auth/login', wrap(async (req, res) => {
  const { username, password } = cred(req.body)
  if (!USER_RE.test(username) || !password || password.length > 100) return res.status(401).json({ error: 'Username atau password salah.' })
  if (!(await allow('log:' + ip(req), 20, 600)) || !(await allow('logu:' + username, 10, 600))) return res.status(429).json({ error: 'Terlalu banyak percobaan, coba lagi beberapa menit lagi.' })
  const u = await (await col('users')).findOne({ username })
  const hash = await hashPw(password, u?.salt || '0'.repeat(32)) // tetap hitung walau user tidak ada (waktu respons seragam)
  const ok = u && crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(u.hash, 'hex'))
  if (!ok) return res.status(401).json({ error: 'Username atau password salah.' })
  res.json({ ok: true, token: await startSession(u._id), uid: u._id, gid: gcSenderId(u._id), name: u.name })
}))

router.post('/api/auth/me', wrap(async (req, res) => {
  const a = await userFromReq(req)
  if (!a) return res.status(401).json({ error: 'Sesi berakhir, masuk lagi.' })
  const d = await (await col('userdata')).findOne({ _id: a.user._id }, { projection: { size: 1, updatedAt: 1 } })
  const { coins, gems } = await ensureWallet(a.user)
  // Tautkan cid browser ini ke akun (maks 30 terakhir) supaya pesan Chat Global lama yang dikirim dari browser mana pun milik akun ini tetap terbaca "saya".
  // Hanya dicatat kalau token sah; daftar ini cuma dikirim balik ke pemilik akun (tidak pernah tampil di publik).
  const cid = typeof req.body?.clientId === 'string' && /^[\w-]{8,64}$/.test(req.body.clientId) ? req.body.clientId : null
  let cids = Array.isArray(a.user.gcids) ? a.user.gcids : []
  if (cid && !cids.includes(cid)) { cids = [...cids, cid].slice(-30); await (await col('users')).updateOne({ _id: a.user._id }, { $set: { gcids: cids } }) }
  res.json({ ok: true, uid: a.user._id, gid: gcSenderId(a.user._id), username: a.user.username, cids, name: a.user.name, coins, gems, cloud: d ? { size: d.size, updatedAt: d.updatedAt } : null })
}))

router.post('/api/auth/logout', wrap(async (req, res) => {
  const a = await userFromReq(req)
  if (a) await (await col('auth_sessions')).deleteOne({ _id: a.sid })
  res.json({ ok: true })
}))

router.post('/api/auth/pull', wrap(async (req, res) => {
  const a = await userFromReq(req)
  if (!a) return res.status(401).json({ error: 'Sesi berakhir, masuk lagi.' })
  const d = await (await col('userdata')).findOne({ _id: a.user._id })
  res.json({ ok: true, data: d?.data || null, updatedAt: d?.updatedAt || null })
}))

router.post('/api/auth/push', wrap(async (req, res) => {
  const a = await userFromReq(req)
  if (!a) return res.status(401).json({ error: 'Sesi berakhir, masuk lagi.' })
  if (!(await allow('push:' + a.user._id, 30, 60))) return res.status(429).json({ error: 'Terlalu sering, tunggu sebentar.' })
  const d = req.body?.data
  if (!d || typeof d !== 'object' || d.app !== 'neyhra-chat' || !Array.isArray(d.chars)) return res.status(400).json({ error: 'Data tidak valid.' })
  const json = JSON.stringify(d), size = Buffer.byteLength(json)
  if (size > MAX_DATA) return res.status(413).json({ error: 'Data terlalu besar untuk disimpan (maks ±3,5 MB). Hapus obrolan lama dulu.' })
  const updatedAt = new Date()
  await (await col('userdata')).updateOne({ _id: a.user._id }, { $set: { data: json, size, updatedAt } }, { upsert: true })
  res.json({ ok: true, size, updatedAt })
}))

// hapus akun + semua data cloud-nya (butuh password)
router.post('/api/auth/delete', wrap(async (req, res) => {
  const a = await userFromReq(req)
  if (!a) return res.status(401).json({ error: 'Sesi berakhir, masuk lagi.' })
  const pw = String(req.body?.password ?? '')
  const hash = await hashPw(pw, a.user.salt)
  if (!pw || !crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(a.user.hash, 'hex'))) return res.status(401).json({ error: 'Password salah.' })
  await Promise.all([(await col('users')).deleteOne({ _id: a.user._id }), (await col('userdata')).deleteOne({ _id: a.user._id }), (await col('auth_sessions')).deleteMany({ userId: a.user._id }), purgeProfile(col, a.user._id, a.user.avKey)])
  res.json({ ok: true })
}))

mountBonus(router, { wrap, userFromReq, allow, col, ensureWallet, ip }) // /api/auth/bonus | claim | redeem
mountGames(router, { wrap, userFromReq, allow, col, ensureWallet }) // /api/auth/game | game/start | game/guess
mountPic(router, { wrap, userFromReq, allow, col, ensureWallet }) // /api/auth/pic | pic/start | pic/guess | pic/hint
mountProfile(router, { wrap, userFromReq, allow, col, ensureIndexes }) // /api/auth/profile | profile/edit | follow | follows | users | avatar/:username

// Dipakai fitur lain yang butuh akun Bearer di luar /api/auth (Skenario Skrip: lib/scenario.js)
export const bearerUser = userFromReq

// Id pengirim Chat Global untuk akun: SAMA di semua browser/perangkat, jadi satu orang tidak terbaca sebagai beberapa orang. Hash satu arah dari uid
// (uid tidak pernah tampil di publik). Format lolos validasi senderId di browser/server (/^[\w-]{8,64}$/).
export const gcSenderId = uid => 'a' + crypto.createHash('sha256').update('neyhra-gc:' + uid).digest('hex').slice(0, 32)
export { allow }

export const authRouter = router
