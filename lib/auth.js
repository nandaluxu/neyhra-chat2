import express from 'express'
import crypto from 'node:crypto'
import { promisify } from 'node:util'
import axios from 'axios'
import { mongoEnabled, col, ensureIndexes } from './mongo.js'
import { mountBonus } from './bonus.js'
import { mountQuests, purgeQuests } from './quests.js'
import { mountGames } from './games.js'
import { mountPic } from './picgame.js'
import { mountChess } from './chess.js'
import { mountShop } from './shop.js'
import { mountEconomy } from './economy.js'
import { mountSlot, slotStart } from './slot.js'
import { mountDev } from './dev.js'
import { mountProfile, purgeProfile } from './profile.js'
import { googleClientId, verifyGoogleIdToken } from './google.js'
import { r2Enabled, r2Put, r2PublicUrl } from './r2.js'

// Login sederhana, tujuannya satu: memindahkan data obrolan antar perangkat. Bukan sistem keamanan tingkat tinggi.
// Koleksi MongoDB:
//   users         { _id, username (huruf kecil, unik), name (tampilan), salt, hash, coins, gems, createdAt }
//                 + bonus (lib/bonus.js): bonusDay, bonusN, refCode (unik), invited, refBy, refAt
//                 + profil (lib/profile.js): name (boleh diubah), bio, av (versi foto). Koleksi lain: avatars (foto), follows (ikuti/diikuti)
//                 coins/gems = saldo akun. Akun baru dapat START_COINS & START_GEMS. Hanya server yang boleh mengubahnya (client cuma membaca lewat /api/auth/me).
//                 + Google (lib/google.js): googleSub (id tetap dari Google, unik), googleEmail, pendingName (true = username masih otomatis 'g_xxxx', belum dipilih user). Akun Google murni tidak punya salt/hash.
//   auth_sessions { _id: sha256(token), userId, createdAt }   -> kedaluwarsa otomatis (TTL) 60 hari
//   userdata      { _id: userId, data: "<JSON string>", size, updatedAt }
//   auth_rl       { _id: kunci, n, exp }                      -> pembatas laju, hapus otomatis (TTL)
// Password di-hash scrypt + salt acak. Token sesi acak 256-bit, yang disimpan di DB cuma hash-nya.
// Semua endpoint POST (kecuali tak ada yang GET), token lewat header Authorization: Bearer <token>.

const scrypt = promisify(crypto.scrypt)
const SESSION_DAYS = 60
const MAX_DATA = 3.5 * 1024 * 1024 // Vercel membatasi body request ±4,5 MB
const USER_RE = /^[a-z0-9_.-]{3,20}$/
const START_COINS = 150, START_GEMS = 10, START_TICKETS = 3, START_CHIPS = 0 // saldo awal akun baru (3 tiket = bisa langsung coba gacha; chip = mode Paid slot, mulai dari 0)

const sha = s => crypto.createHash('sha256').update(s).digest('hex')
const newToken = () => crypto.randomBytes(32).toString('base64url')
const hashPw = async (pw, salt) => (await scrypt(pw, salt, 64)).toString('hex')
const ip = req => String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim().slice(0, 64) || 'unknown'

let ready
const init = () => ready ??= Promise.all([
  ensureIndexes('users', [[{ username: 1 }, { unique: true }], [{ refCode: 1 }, { unique: true, sparse: true }], [{ googleSub: 1 }, { unique: true, sparse: true }], [{ createdAt: -1 }]]), // createdAt: daftar "Baru bergabung" di tab Profil
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
// Termasuk `tickets` + `gacha` (lib/economy.js) untuk akun yang dibuat sebelum sistem ekonomi ada.
async function ensureWallet(u) {
  let { coins, gems, tickets, chips } = u
  if (typeof coins !== 'number') { coins = START_COINS; await (await col('users')).updateOne({ _id: u._id, coins: { $exists: false } }, { $set: { coins } }) }
  if (typeof gems !== 'number') { gems = START_GEMS; await (await col('users')).updateOne({ _id: u._id, gems: { $exists: false } }, { $set: { gems } }) }
  if (typeof tickets !== 'number') { tickets = START_TICKETS; await (await col('users')).updateOne({ _id: u._id, tickets: { $exists: false } }, { $set: { tickets } }) }
  if (typeof chips !== 'number') { chips = START_CHIPS; await (await col('users')).updateOne({ _id: u._id, chips: { $exists: false } }, { $set: { chips } }) }
  if (!u.gacha) await (await col('users')).updateOne({ _id: u._id, gacha: { $exists: false } }, { $set: { gacha: { pity: 0, tot: 0, rings: 0 } } }).catch(() => { })
  return { coins, gems, tickets, chips }
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
  const doc = { _id: crypto.randomUUID(), username, name: name.slice(0, 20), salt, hash: await hashPw(password, salt), coins: START_COINS, gems: START_GEMS, tickets: START_TICKETS, chips: START_CHIPS, gacha: { pity: 0, tot: 0, rings: 0 }, slot: slotStart(), createdAt: new Date() }
  try { await (await col('users')).insertOne(doc) }
  catch (e) { if (e?.code === 11000) return res.status(409).json({ error: 'Username sudah dipakai.' }); throw e }
  res.json({ ok: true, token: await startSession(doc._id), uid: doc._id, gid: gcSenderId(doc._id), name: doc.name, coins: doc.coins, gems: doc.gems, tickets: doc.tickets })
}))

router.post('/api/auth/login', wrap(async (req, res) => {
  const { username, password } = cred(req.body)
  if (!USER_RE.test(username) || !password || password.length > 100) return res.status(401).json({ error: 'Username atau password salah.' })
  if (!(await allow('log:' + ip(req), 20, 600)) || !(await allow('logu:' + username, 10, 600))) return res.status(429).json({ error: 'Terlalu banyak percobaan, coba lagi beberapa menit lagi.' })
  const u = await (await col('users')).findOne({ username })
  const hash = await hashPw(password, u?.salt || '0'.repeat(32)) // tetap hitung walau user tidak ada (waktu respons seragam)
  const ok = u && u.hash && crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(u.hash, 'hex'))
  if (!ok) return res.status(401).json({ error: 'Username atau password salah.' })
  res.json({ ok: true, token: await startSession(u._id), uid: u._id, gid: gcSenderId(u._id), name: u.name })
}))

/* ---------- Login Google ---------- */
// Dibaca browser sebelum login untuk menampilkan tombol Google (Client ID itu publik, bukan rahasia).
router.get('/api/auth/config', (req, res) => res.json({ google: googleClientId() || null }))

const gName = g => (String(g.name || '').trim() || String(g.email || '').split('@')[0] || 'Pengguna').slice(0, 20)
/* Foto profil Google -> foto profil akun BARU (pola penyimpanan sama dengan unggahan di lib/profile.js:
   R2 kalau env-nya lengkap, kalau tidak koleksi avatars). Best-effort: akun tetap jadi walau fotonya gagal
   diunduh/bukan JPEG — foto profil Google kadang PNG, yang begitu dilewati saja (pakai default huruf awal nama).
   Akun LAMA tidak pernah disentuh supaya pfp yang sudah dipilih user tidak tertimpa. */
async function grabGoogleAvatar(userId, url) {
  try {
    if (!/^https:\/\//.test(String(url || ''))) return
    const big = String(url).replace(/=s\d+[^/]*$/, '=s256-c') // minta versi 256 px (pola akhiran URL foto Google)
    const r = await axios.get(big, { timeout: 5000, responseType: 'arraybuffer', maxContentLength: 3 * 1024 * 1024, headers: { 'User-Agent': 'neyhra-chat2/1.0' } })
    const buf = Buffer.from(r.data)
    if (buf.length < 100 || buf[0] !== 0xff || buf[1] !== 0xd8) return // bukan JPEG: lewati
    const v = Date.now(), users = await col('users')
    if (r2Enabled()) {
      const key = `pfp/${crypto.randomBytes(12).toString('hex')}.jpg`
      await r2Put(key, buf, 'image/jpeg')
      await users.updateOne({ _id: userId }, { $set: { avatarUrl: r2PublicUrl(key), avKey: key, av: v } })
    } else {
      await (await col('avatars')).updateOne({ _id: userId }, { $set: { data: buf.toString('base64'), v } }, { upsert: true })
      await users.updateOne({ _id: userId }, { $set: { av: v } })
    }
  } catch (e) { console.error('auth:google pfp gagal:', e?.message) }
}
async function googleIdentity(req, res) {
  const cid = googleClientId()
  if (!cid) { res.status(501).json({ error: 'Login Google belum diaktifkan di server (env GOOGLE_CLIENT_ID).' }); return null }
  if (!(await allow('goo:' + ip(req), 30, 600))) { res.status(429).json({ error: 'Terlalu banyak percobaan, coba lagi beberapa menit lagi.' }); return null }
  try { return await verifyGoogleIdToken(req.body?.credential, cid) }
  catch (e) { console.error('auth:google', e?.code || '', e?.message); res.status(401).json({ error: 'Token Google tidak valid atau kedaluwarsa. Coba lagi.' }); return null }
}

// Masuk dengan Google: akun yang sudah tertaut -> masuk; belum ada -> dibuat baru (username otomatis, user diminta memilih setelah masuk).
router.post('/api/auth/google', wrap(async (req, res) => {
  const g = await googleIdentity(req, res); if (!g) return
  const users = await col('users')
  let u = await users.findOne({ googleSub: g.sub }), isNew = false
  for (let i = 0; i < 4 && !u; i++) {
    const doc = { _id: crypto.randomUUID(), username: 'g_' + crypto.randomBytes(5).toString('hex'), name: gName(g), googleSub: g.sub, googleEmail: g.email, pendingName: true, coins: START_COINS, gems: START_GEMS, tickets: START_TICKETS, chips: START_CHIPS, gacha: { pity: 0, tot: 0, rings: 0 }, slot: slotStart(), createdAt: new Date() }
    try { await users.insertOne(doc); u = doc; isNew = true }
    catch (e) { if (e?.code !== 11000) throw e; u = await users.findOne({ googleSub: g.sub }) } // dua tab login bersamaan, atau username acak bentrok: ulangi
  }
  if (!u) return res.status(500).json({ error: 'Gagal membuat akun, coba lagi.' })
  if (isNew && g.picture) await grabGoogleAvatar(u._id, g.picture) // akun baru: pfp Google dipakai sebagai foto profil (akun lama tidak diubah)
  const w = await ensureWallet(u)
  res.json({ ok: true, token: await startSession(u._id), uid: u._id, gid: gcSenderId(u._id), name: u.name, coins: w.coins, gems: w.gems, tickets: w.tickets, needUsername: !!u.pendingName })
}))

// Tautkan Google ke akun yang sedang masuk (akun lama). Satu Google = satu akun.
router.post('/api/auth/google/link', wrap(async (req, res) => {
  const a = await userFromReq(req)
  if (!a) return res.status(401).json({ error: 'Sesi berakhir, masuk lagi.' })
  const g = await googleIdentity(req, res); if (!g) return
  const users = await col('users')
  const other = await users.findOne({ googleSub: g.sub }, { projection: { _id: 1 } })
  if (other && other._id !== a.user._id) return res.status(409).json({ error: 'Akun Google ini sudah tertaut ke akun lain.' })
  try { await users.updateOne({ _id: a.user._id }, { $set: { googleSub: g.sub, googleEmail: g.email } }) }
  catch (e) { if (e?.code === 11000) return res.status(409).json({ error: 'Akun Google ini sudah tertaut ke akun lain.' }); throw e }
  res.json({ ok: true, email: g.email })
}))

// Lepas tautan Google. Hanya kalau akun punya password (kalau tidak, user terkunci dari akunnya sendiri).
router.post('/api/auth/google/unlink', wrap(async (req, res) => {
  const a = await userFromReq(req)
  if (!a) return res.status(401).json({ error: 'Sesi berakhir, masuk lagi.' })
  if (!a.user.hash) return res.status(400).json({ error: 'Akun ini belum punya password, jadi Google tidak bisa dilepas.' })
  await (await col('users')).updateOne({ _id: a.user._id }, { $unset: { googleSub: '', googleEmail: '' } })
  res.json({ ok: true })
}))

// Pilih username (sekali) setelah daftar lewat Google. Sebelumnya username berupa 'g_xxxxxxxxxx'.
router.post('/api/auth/username', wrap(async (req, res) => {
  const a = await userFromReq(req)
  if (!a) return res.status(401).json({ error: 'Sesi berakhir, masuk lagi.' })
  if (!a.user.pendingName) return res.status(400).json({ error: 'Username sudah ditetapkan.' })
  const username = String(req.body?.username ?? '').trim().toLowerCase()
  if (!USER_RE.test(username)) return res.status(400).json({ error: 'Username 3-20 karakter: huruf, angka, titik, strip, atau garis bawah.' })
  if (!(await allow('un:' + a.user._id, 15, 600))) return res.status(429).json({ error: 'Terlalu banyak percobaan, coba lagi nanti.' })
  try { await (await col('users')).updateOne({ _id: a.user._id, pendingName: true }, { $set: { username }, $unset: { pendingName: '' } }) }
  catch (e) { if (e?.code === 11000) return res.status(409).json({ error: 'Username sudah dipakai.' }); throw e }
  res.json({ ok: true, username })
}))

router.post('/api/auth/me', wrap(async (req, res) => {
  const a = await userFromReq(req)
  if (!a) return res.status(401).json({ error: 'Sesi berakhir, masuk lagi.' })
  const d = await (await col('userdata')).findOne({ _id: a.user._id }, { projection: { size: 1, updatedAt: 1 } })
  const { coins, gems, tickets, chips } = await ensureWallet(a.user)
  // Tautkan cid browser ini ke akun (maks 30 terakhir) supaya pesan Chat Global lama yang dikirim dari browser mana pun milik akun ini tetap terbaca "saya".
  // Hanya dicatat kalau token sah; daftar ini cuma dikirim balik ke pemilik akun (tidak pernah tampil di publik).
  const cid = typeof req.body?.clientId === 'string' && /^[\w-]{8,64}$/.test(req.body.clientId) ? req.body.clientId : null
  let cids = Array.isArray(a.user.gcids) ? a.user.gcids : []
  if (cid && !cids.includes(cid)) { cids = [...cids, cid].slice(-30); await (await col('users')).updateOne({ _id: a.user._id }, { $set: { gcids: cids } }) }
  res.json({ ok: true, uid: a.user._id, gid: gcSenderId(a.user._id), username: a.user.username, cids, name: a.user.name, coins, gems, tickets, chips, hasPassword: !!a.user.hash, pendingName: !!a.user.pendingName, google: a.user.googleSub ? { linked: true, email: a.user.googleEmail || '' } : { linked: false }, cloud: d ? { size: d.size, updatedAt: d.updatedAt } : null })
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
  if (a.user.hash) {
    const pw = String(req.body?.password ?? '')
    const hash = await hashPw(pw, a.user.salt)
    if (!pw || !crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(a.user.hash, 'hex'))) return res.status(401).json({ error: 'Password salah.' })
  } else if (String(req.body?.confirm ?? '').trim().toLowerCase() !== a.user.username) { // akun Google murni tidak punya password: konfirmasi dengan mengetik username
    return res.status(401).json({ error: 'Username konfirmasi salah.' })
  }
  await Promise.all([(await col('users')).deleteOne({ _id: a.user._id }), (await col('userdata')).deleteOne({ _id: a.user._id }), (await col('auth_sessions')).deleteMany({ userId: a.user._id }), purgeProfile(col, a.user._id, a.user.avKey), purgeQuests(col, a.user._id)])
  res.json({ ok: true })
}))

mountBonus(router, { wrap, userFromReq, allow, col, ensureWallet, ip }) // /api/auth/bonus | claim | redeem (streak ikut di sini)
mountQuests(router, { wrap, userFromReq, allow, col, ensureWallet }) // /api/auth/quests (misi harian + piala + peringkat mingguan)
mountGames(router, { wrap, userFromReq, allow, col, ensureWallet }) // /api/auth/game | game/start | game/guess
mountPic(router, { wrap, userFromReq, allow, col, ensureWallet }) // /api/auth/pic | pic/start | pic/guess | pic/hint
mountChess(router, { wrap, userFromReq, allow, col, ensureWallet }) // /api/auth/chess | chess/start | chess/move | chess/resign
mountShop(router, { wrap, userFromReq, allow, col, ensureWallet }) // /api/auth/shop | shop/buy | shop/gift
mountEconomy(router, { wrap, userFromReq, allow, col, ensureWallet }) // /api/auth/economy | economy/exchange | economy/gacha (lib/economy.js)
mountSlot(router, { wrap, userFromReq, allow, col, ensureWallet }) // /api/auth/slot | slot/spin | slot/bonus | slot/refill (lib/slot.js) — Fruit Slot minigame
mountDev(router, { wrap, userFromReq, allow, col, ensureWallet }) // /api/auth/dev/grant (Mode dev: tambah coin & gems)
mountProfile(router, { wrap, userFromReq, allow, col, ensureIndexes }) // /api/auth/profile | profile/edit | follow | follows | users | avatar/:username

// Dipakai fitur lain yang butuh akun Bearer di luar /api/auth (Skenario Skrip: lib/scenario.js)
export const bearerUser = userFromReq

// Id pengirim Chat Global untuk akun: SAMA di semua browser/perangkat, jadi satu orang tidak terbaca sebagai beberapa orang. Hash satu arah dari uid
// (uid tidak pernah tampil di publik). Format lolos validasi senderId di browser/server (/^[\w-]{8,64}$/).
export const gcSenderId = uid => 'a' + crypto.createHash('sha256').update('neyhra-gc:' + uid).digest('hex').slice(0, 32)
export { allow }

export const authRouter = router
