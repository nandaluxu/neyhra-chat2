// Profil akun: nama tampilan, bio, foto, ikuti/diikuti, pencarian akun. Dipakai tab Profil (public/profile.js).
// Dipasang ke router auth (lib/auth.js) lewat mountProfile, jadi semua endpoint ada di /api/auth/* dan memakai token Bearer yang sama.
//
// Data di MongoDB:
//   users    + name (boleh diubah), bio (maks 120), av (angka versi foto; tidak ada = belum punya foto),
//              avatarUrl (alamat foto di Cloudflare R2) dan avKey (nama objek di bucket, untuk menghapus yang lama)
//   avatars  { _id: userId, data: "<JPEG base64>", v }              HANYA mode cadangan (R2 belum dikonfigurasi) dan foto lama sebelum pindah ke R2
//
// Foto profil: 256x256 JPEG, maks 100 KB (dikecilkan di browser). Kalau env R2_* lengkap (lib/r2.js) foto diunggah ke bucket R2 dan
// alamat publiknya disimpan di users.avatarUrl. Kalau tidak, foto disimpan di koleksi avatars seperti dulu. Client selalu memakai
// kolom `avatar` (alamat lengkap) dari respons profil, jadi tidak perlu tahu foto ada di mana.
//   follows  { _id: "<pengikut>:<diikuti>", follower, followee, createdAt }   _id gabungan = satu pasangan tidak bisa dobel
//
// Endpoint (POST kecuali dicatat):
//   profile        { username? }                          profil sendiri / akun lain
//   profile/edit   { name?, bio?, avatar? }               avatar = data URL JPEG, atau null untuk menghapus
//   follow         { username, on }                       ikuti / berhenti mengikuti
//   follows        { username?, kind, before? }           daftar pengikut / mengikuti, 20 per halaman (kursor `before` = ms)
//   users          { q? }                                 cari username (awalan), kosong = akun terbaru
//   GET avatar/:username?v=                               foto profil (JPEG) untuk foto yang masih di MongoDB; yang di R2 dialihkan ke alamat R2

import crypto from 'node:crypto'
import { r2Enabled, r2Put, r2Delete, r2PublicUrl } from './r2.js'

const USER_RE = /^[a-z0-9_.-]{3,20}$/
const NAME_MAX = 20, BIO_MAX = 120, AV_MAX = 100 * 1024, PAGE = 20

export const cleanName = s => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX)
export const cleanBio = s => String(s ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ')
  .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, BIO_MAX)

// data URL JPEG -> Buffer, atau null kalau bukan JPEG yang wajar
export function avatarBuffer(dataUrl) {
  const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/]+={0,2})$/.exec(String(dataUrl ?? ''))
  if (!m) return null
  const b = Buffer.from(m[1], 'base64')
  if (b.length < 200 || b.length > AV_MAX) return null
  if (!(b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff)) return null // tanda awal JPEG
  if (!(b[b.length - 2] === 0xff && b[b.length - 1] === 0xd9)) return null // tanda akhir JPEG
  return b
}

// alamat foto untuk client: R2 kalau ada, kalau tidak foto lama di MongoDB (lewat GET avatar/:username), kalau tidak ada '' (pakai huruf awal nama)
export const avatarOf = u => u.avatarUrl || (u.av ? `/api/auth/avatar/${encodeURIComponent(u.username)}?v=${u.av}` : '')

const esc = s => s.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')

// Hapus data profil milik satu akun (dipanggil saat akun dihapus)
export async function purgeProfile(col, userId, avKey) {
  if (avKey && r2Enabled()) await r2Delete(avKey).catch(e => console.error('[r2] hapus foto gagal:', e.message))
  await Promise.all([
    (await col('avatars')).deleteOne({ _id: userId }),
    (await col('follows')).deleteMany({ $or: [{ follower: userId }, { followee: userId }] })
  ])
}

export function mountProfile(router, { wrap, userFromReq, allow, col, ensureIndexes }) {
  let ready
  const init = () => ready ??= ensureIndexes('follows', [[{ follower: 1, createdAt: -1 }], [{ followee: 1, createdAt: -1 }]]).catch(e => { ready = null; throw e })
  const noAuth = res => res.status(401).json({ error: 'Sesi berakhir, masuk lagi.' })

  const view = async (target, meId) => {
    const follows = await col('follows'), isMe = target._id === meId
    const [followers, following, a, b] = await Promise.all([
      follows.countDocuments({ followee: target._id }),
      follows.countDocuments({ follower: target._id }),
      isMe ? null : follows.findOne({ _id: `${meId}:${target._id}` }, { projection: { _id: 1 } }),
      isMe ? null : follows.findOne({ _id: `${target._id}:${meId}` }, { projection: { _id: 1 } })
    ])
    return { username: target.username, name: target.name, bio: target.bio || '', av: target.av || 0, joined: target.createdAt, avatar: avatarOf(target), invited: target.invited || 0, followers, following, isMe, isFollowing: !!a, followsMe: !!b }
  }
  // akun yang dimaksud body.username (kosong = diri sendiri); null = tidak ada
  const targetOf = async (me, name) => {
    const un = String(name ?? '').trim().toLowerCase()
    if (!un || un === me.username) return me
    if (!USER_RE.test(un)) return null
    return (await col('users')).findOne({ username: un })
  }
  const flags = async (meId, ids) => {
    if (!ids.length) return new Set()
    const rows = await (await col('follows')).find({ follower: meId, followee: { $in: ids } }, { projection: { followee: 1 } }).toArray()
    return new Set(rows.map(r => r.followee))
  }
  const item = (u, meId, mine) => ({ username: u.username, name: u.name, av: u.av || 0, avatar: avatarOf(u), isMe: u._id === meId, isFollowing: mine.has(u._id) })

  // buang foto lama milik user: objek di R2 (kalau ada) dan sisa di koleksi avatars
  async function dropAvatar(u) {
    if (u.avKey && r2Enabled()) await r2Delete(u.avKey).catch(e => console.error('[r2] hapus foto gagal:', e.message))
    await (await col('avatars')).deleteOne({ _id: u._id })
  }

  router.post('/api/auth/profile', wrap(async (req, res) => {
    const a = await userFromReq(req); if (!a) return noAuth(res)
    if (!(await allow('prof:' + a.user._id, 120, 60))) return res.status(429).json({ error: 'Terlalu sering, tunggu sebentar.' })
    await init()
    const t = await targetOf(a.user, req.body?.username)
    if (!t) return res.status(404).json({ error: 'Akun tidak ditemukan.' })
    res.json({ ok: true, profile: await view(t, a.user._id) })
  }))

  router.post('/api/auth/profile/edit', wrap(async (req, res) => {
    const a = await userFromReq(req); if (!a) return noAuth(res)
    if (!(await allow('pedit:' + a.user._id, 20, 3600))) return res.status(429).json({ error: 'Terlalu sering mengubah profil, coba lagi nanti.' })
    await init()
    const b = req.body || {}, set = {}, unset = {}
    const oldKey = a.user.avKey // foto lama, dicatat sebelum diubah
    if ('name' in b) {
      const n = cleanName(b.name)
      if (!n) return res.status(400).json({ error: 'Nama tidak boleh kosong.' })
      set.name = n
    }
    if ('bio' in b) { const bio = cleanBio(b.bio); if (bio) set.bio = bio; else unset.bio = '' }
    let newKey = ''
    if ('avatar' in b) {
      if (b.avatar === null) {
        await dropAvatar(a.user); unset.av = ''; unset.avatarUrl = ''; unset.avKey = ''
      } else {
        if (!(await allow('pav:' + a.user._id, 10, 3600))) return res.status(429).json({ error: 'Terlalu sering mengganti foto, coba lagi nanti.' })
        const buf = avatarBuffer(b.avatar)
        if (!buf) return res.status(400).json({ error: 'Foto tidak valid (harus JPEG, maks 100 KB).' })
        const v = Date.now()
        if (r2Enabled()) {
          newKey = `pfp/${crypto.randomBytes(12).toString('hex')}.jpg` // nama acak: alamat tidak bisa ditebak dan tidak perlu cache-busting
          try { await r2Put(newKey, buf, 'image/jpeg') }
          catch (e) { console.error('[r2] unggah foto gagal:', e.message); return res.status(502).json({ error: 'Gagal menyimpan foto' + (e.status ? ` (kode R2: ${e.status}). Cek pengaturan R2 di server.` : ' (server tidak bisa menghubungi R2). Cek pengaturan R2 di server.') }) }
          set.avatarUrl = r2PublicUrl(newKey); set.avKey = newKey; set.av = v
        } else {
          await (await col('avatars')).updateOne({ _id: a.user._id }, { $set: { data: buf.toString('base64'), v } }, { upsert: true })
          set.av = v; unset.avatarUrl = ''; unset.avKey = ''
        }
      }
    }
    const upd = {}; if (Object.keys(set).length) upd.$set = set; if (Object.keys(unset).length) upd.$unset = unset
    const users = await col('users')
    try { if (upd.$set || upd.$unset) await users.updateOne({ _id: a.user._id }, upd) }
    catch (e) { if (newKey) await r2Delete(newKey).catch(() => {}); throw e } // database gagal: jangan tinggalkan objek yatim di bucket
    if (newKey) { // foto baru sudah tercatat: buang foto lama (R2 dan sisa di MongoDB), kegagalan di sini tidak mengganggu
      if (oldKey && oldKey !== newKey) await r2Delete(oldKey).catch(e => console.error('[r2] hapus foto lama gagal:', e.message))
      await (await col('avatars')).deleteOne({ _id: a.user._id }).catch(() => {})
    }
    const fresh = await users.findOne({ _id: a.user._id })
    res.json({ ok: true, profile: await view(fresh, a.user._id) })
  }))

  router.post('/api/auth/follow', wrap(async (req, res) => {
    const a = await userFromReq(req); if (!a) return noAuth(res)
    if (!(await allow('follow:' + a.user._id, 60, 60))) return res.status(429).json({ error: 'Terlalu sering, tunggu sebentar.' })
    await init()
    const un = String(req.body?.username ?? '').trim().toLowerCase()
    const t = USER_RE.test(un) ? await (await col('users')).findOne({ username: un }) : null
    if (!t) return res.status(404).json({ error: 'Akun tidak ditemukan.' })
    if (t._id === a.user._id) return res.status(400).json({ error: 'Tidak bisa mengikuti diri sendiri.' })
    const follows = await col('follows'), id = `${a.user._id}:${t._id}`, on = req.body?.on === true
    if (on) {
      try { await follows.insertOne({ _id: id, follower: a.user._id, followee: t._id, createdAt: new Date() }) }
      catch (e) { if (e?.code !== 11000) throw e } // sudah mengikuti: tidak apa-apa
    } else await follows.deleteOne({ _id: id })
    res.json({ ok: true, isFollowing: on, followers: await follows.countDocuments({ followee: t._id }) })
  }))

  router.post('/api/auth/follows', wrap(async (req, res) => {
    const a = await userFromReq(req); if (!a) return noAuth(res)
    if (!(await allow('flist:' + a.user._id, 120, 60))) return res.status(429).json({ error: 'Terlalu sering, tunggu sebentar.' })
    await init()
    const kind = req.body?.kind === 'following' ? 'following' : req.body?.kind === 'followers' ? 'followers' : ''
    if (!kind) return res.status(400).json({ error: 'Permintaan tidak valid.' })
    const t = await targetOf(a.user, req.body?.username)
    if (!t) return res.status(404).json({ error: 'Akun tidak ditemukan.' })
    const q = kind === 'followers' ? { followee: t._id } : { follower: t._id }
    const before = Number(req.body?.before)
    if (Number.isFinite(before) && before > 0) q.createdAt = { $lt: new Date(before) }
    const docs = await (await col('follows')).find(q).sort({ createdAt: -1 }).limit(PAGE + 1).toArray()
    const more = docs.length > PAGE, page = docs.slice(0, PAGE)
    const ids = page.map(d => kind === 'followers' ? d.follower : d.followee)
    const us = ids.length ? await (await col('users')).find({ _id: { $in: ids } }, { projection: { username: 1, name: 1, av: 1, avatarUrl: 1 } }).toArray() : []
    const byId = new Map(us.map(u => [u._id, u])), mine = await flags(a.user._id, ids)
    res.json({ ok: true, items: ids.map(id => byId.get(id)).filter(Boolean).map(u => item(u, a.user._id, mine)), more, next: more ? page[page.length - 1].createdAt.getTime() : 0 })
  }))

  router.post('/api/auth/users', wrap(async (req, res) => {
    const a = await userFromReq(req); if (!a) return noAuth(res)
    if (!(await allow('usearch:' + a.user._id, 90, 60))) return res.status(429).json({ error: 'Terlalu sering mencari, tunggu sebentar.' })
    await init()
    const q = String(req.body?.q ?? '').toLowerCase().replace(/[^a-z0-9_.-]/g, '').slice(0, 20)
    const users = await col('users')
    const cur = q
      ? users.find({ username: { $regex: '^' + esc(q) } }, { projection: { username: 1, name: 1, av: 1, avatarUrl: 1 } }).sort({ username: 1 })
      : users.find({ _id: { $ne: a.user._id } }, { projection: { username: 1, name: 1, av: 1, avatarUrl: 1 } }).sort({ createdAt: -1 })
    const rows = await cur.limit(PAGE).toArray(), mine = await flags(a.user._id, rows.map(u => u._id))
    res.json({ ok: true, items: rows.map(u => item(u, a.user._id, mine)) })
  }))

  router.get('/api/auth/avatar/:username', wrap(async (req, res) => {
    const un = String(req.params.username ?? '').toLowerCase()
    if (!USER_RE.test(un)) return res.status(404).end()
    const u = await (await col('users')).findOne({ username: un }, { projection: { av: 1, avatarUrl: 1 } })
    if (u?.avatarUrl) return res.redirect(302, u.avatarUrl) // foto di R2
    if (!u?.av) return res.status(404).end()
    const d = await (await col('avatars')).findOne({ _id: u._id })
    if (!d?.data) return res.status(404).end()
    res.set({ 'Content-Type': 'image/jpeg', 'X-Content-Type-Options': 'nosniff', // alamat memuat ?v=<versi>, jadi aman di-cache lama
      'Cache-Control': req.query.v ? 'public, max-age=31536000, immutable' : 'public, max-age=300' })
    res.send(Buffer.from(d.data, 'base64'))
  }))
}
