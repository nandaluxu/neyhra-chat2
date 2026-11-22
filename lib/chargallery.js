// Galeri karakter: tab "Galeri" di halaman detail karakter (public/cdetail.js). Pengguna yang login bisa menambah foto yang terkait
// karakter itu, lewat UNGGAH FILE (dikecilkan di browser jadi JPEG) atau lewat URL gambar (https). Semua orang (termasuk tamu) boleh melihat.
//
// Koleksi MongoDB (dibuat otomatis):
//   char_gallery { _id: "<18 hex>", charId, userId, kind: "file" | "url", url, key?, at }
//                 file -> url = alamat R2 (key = nama objek di bucket) atau, kalau R2 belum dikonfigurasi, /api/auth/galleryimg/<id>
//                 url  -> url = alamat gambar luar apa adanya (server TIDAK mengunduhnya; hanya browser yang memuat)
//   gallery_img  { _id: <id char_gallery>, data: "<JPEG base64>" }   HANYA mode cadangan (R2 belum dikonfigurasi)
//   Index: char_gallery {charId, at:-1}, {userId}.
//
// Endpoint (POST, semua di /api/auth/...). Membaca boleh tanpa login; menulis butuh token Bearer.
//   chargallery        { char, before? }          -> { ok, items, more, next, total }   24 per halaman, terbaru dulu (kursor `before` = ms)
//   chargallery/add    { char, image? | url? }    -> { ok, item, total }                image = data URL JPEG (maks 400 KB); url = https://... (maks 500 huruf)
//   chargallery/delete { id }                     -> { ok, total }                      penguggah, atau pemilik AI buatan itu
//   GET galleryimg/:id                            -> JPEG (hanya mode cadangan tanpa R2)
//   item = { id, url, kind, at (ms), user:{username,name,avatar}, mine, canDelete }
//
// Keamanan: karakter harus ada & boleh dipakai pemanggil (canUseChar). URL luar wajib https, tanpa user:pass@, bukan localhost/IP lokal,
// dan hanya dipakai sebagai src <img> di client (referrerPolicy no-referrer). File harus JPEG valid. Batas per akun per karakter + pembatas laju.

import crypto from 'node:crypto'
import { loadChars, canUseChar } from './chars.js'
import { avatarOf } from './profile.js'
import { r2Enabled, r2Put, r2Delete, r2PublicUrl } from './r2.js'

const CHAR_RE = /^[\w-]{1,64}$/, GID_RE = /^[0-9a-f]{18}$/
const PAGE = 24, IMG_MAX = 400 * 1024, URL_MAX = 500, PER_USER_CHAR = 12
const ipOf = req => String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim().slice(0, 64) || 'unknown'

// data URL JPEG -> Buffer, atau null kalau bukan JPEG yang wajar (sama ketatnya dengan foto profil)
function jpegBuffer(dataUrl) {
  const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/]+={0,2})$/.exec(String(dataUrl ?? ''))
  if (!m) return null
  const b = Buffer.from(m[1], 'base64')
  if (b.length < 500 || b.length > IMG_MAX) return null
  if (!(b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff)) return null
  if (!(b[b.length - 2] === 0xff && b[b.length - 1] === 0xd9)) return null
  return b
}

// URL gambar luar: https saja, tanpa kredensial, bukan host lokal/privat. Mengembalikan alamat bersih atau '' kalau ditolak.
function cleanUrl(s) {
  const raw = String(s ?? '').trim()
  if (!raw || raw.length > URL_MAX || /[\s\u0000-\u001f]/.test(raw)) return ''
  let u; try { u = new URL(raw) } catch { return '' }
  if (u.protocol !== 'https:' || u.username || u.password) return ''
  const host = u.hostname.toLowerCase()
  if (!host.includes('.') || host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return ''
  if (/^\[/.test(host) || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return '' // IP literal (IPv4/IPv6) ditolak
  return u.href
}

// Hapus semua foto galeri milik satu akun (dipanggil saat akun dihapus)
export async function purgeGallery(col, userId) {
  await purgeWhere(col, { userId })
}
// Hapus galeri untuk karakter yang dihapus (AI buatan user)
export async function purgeCharsGallery(col, charIds) {
  if (!charIds?.length) return
  await purgeWhere(col, { charId: { $in: charIds } })
}
async function purgeWhere(col, filter) {
  try {
    const g = await col('char_gallery'), rows = await g.find(filter, { projection: { key: 1 } }).toArray()
    if (r2Enabled()) for (const r of rows) if (r.key) await r2Delete(r.key).catch(e => console.error('[r2] hapus galeri gagal:', e.message))
    if (rows.length) await (await col('gallery_img')).deleteMany({ _id: { $in: rows.map(r => r._id) } })
    await g.deleteMany(filter)
  } catch (e) { console.error('[chargallery] purge gagal:', e?.message) }
}

export function mountCharGallery(router, { wrap, userFromReq, allow, col, ensureIndexes }) {
  let ready
  const init = () => ready ??= ensureIndexes('char_gallery', [[{ charId: 1, at: -1 }], [{ userId: 1 }]]).catch(e => { ready = null; throw e })
  const noAuth = res => res.status(401).json({ error: 'Sesi berakhir, masuk lagi.' })
  const me = req => userFromReq(req).catch(() => null) // login opsional untuk membaca

  const target = async (req, res, a) => {
    const id = String(req.body?.char ?? '')
    if (!CHAR_RE.test(id)) { res.status(400).json({ error: 'Karakter tidak valid.' }); return null }
    const c = (await loadChars(id)).find(x => x.id === id)
    if (!c || !canUseChar(c, a?.user?._id || null)) { res.status(404).json({ error: 'Karakter tidak ditemukan.' }); return null }
    return c
  }
  const total = async id => (await col('char_gallery')).countDocuments({ charId: id })
  const toItems = async (docs, a, c) => {
    const ids = [...new Set(docs.map(d => d.userId))]
    const us = ids.length ? await (await col('users')).find({ _id: { $in: ids } }, { projection: { username: 1, name: 1, av: 1, avatarUrl: 1 } }).toArray() : []
    const m = new Map(us.map(u => [u._id, { username: u.username || '', name: u.name || u.username || '', avatar: avatarOf(u) }]))
    const uid = a?.user?._id || null, owner = !!uid && !!c?.custom && c.ownerId === uid
    return docs.map(d => ({
      id: d._id, url: d.url, kind: d.kind, at: new Date(d.at).getTime(), user: m.get(d.userId) || { username: '', name: 'Akun dihapus', avatar: '' },
      mine: !!uid && d.userId === uid, canDelete: !!uid && (d.userId === uid || owner)
    }))
  }

  router.post('/api/auth/chargallery', wrap(async (req, res) => {
    if (!(await allow('cgr:' + ipOf(req), 180, 60))) return res.status(429).json({ error: 'Terlalu sering, tunggu sebentar.' })
    await init()
    const a = await me(req), c = await target(req, res, a); if (!c) return
    const before = Number(req.body?.before)
    const q = { charId: c.id, ...(Number.isFinite(before) && before > 0 ? { at: { $lt: new Date(before) } } : {}) }
    const docs = await (await col('char_gallery')).find(q).sort({ at: -1 }).limit(PAGE + 1).toArray()
    const more = docs.length > PAGE, page = more ? docs.slice(0, PAGE) : docs
    res.json({ ok: true, items: await toItems(page, a, c), more, next: more ? new Date(page[page.length - 1].at).getTime() : 0, total: await total(c.id) })
  }))

  router.post('/api/auth/chargallery/add', wrap(async (req, res) => {
    const a = await userFromReq(req); if (!a) return noAuth(res)
    if (!(await allow('cgw:' + a.user._id, 6, 60)) || !(await allow('cgw2:' + a.user._id, 40, 3600))) return res.status(429).json({ error: 'Terlalu sering menambah foto, coba lagi nanti.' })
    await init()
    const c = await target(req, res, a); if (!c) return
    const g = await col('char_gallery')
    if ((await g.countDocuments({ charId: c.id, userId: a.user._id })) >= PER_USER_CHAR) return res.status(400).json({ error: `Batas ${PER_USER_CHAR} foto per orang untuk karakter ini. Hapus yang lama dulu.` })

    const _id = crypto.randomBytes(9).toString('hex'), doc = { _id, charId: c.id, userId: a.user._id, at: new Date() }
    let newKey = ''
    if (req.body?.image != null) {
      const buf = jpegBuffer(req.body.image)
      if (!buf) return res.status(400).json({ error: 'Foto tidak valid (harus JPEG, maks 400 KB).' })
      doc.kind = 'file'
      if (r2Enabled()) {
        newKey = `gallery/${crypto.randomBytes(12).toString('hex')}.jpg`
        try { await r2Put(newKey, buf, 'image/jpeg') }
        catch (e) { console.error('[r2] unggah galeri gagal:', e.message); return res.status(502).json({ error: 'Gagal menyimpan foto. Cek pengaturan R2 di server.' }) }
        doc.url = r2PublicUrl(newKey); doc.key = newKey
      } else {
        await (await col('gallery_img')).updateOne({ _id }, { $set: { data: buf.toString('base64') } }, { upsert: true })
        doc.url = `/api/auth/galleryimg/${_id}`
      }
    } else {
      const url = cleanUrl(req.body?.url)
      if (!url) return res.status(400).json({ error: 'URL tidak valid. Pakai alamat gambar yang diawali https://' })
      doc.kind = 'url'; doc.url = url
    }
    try { await g.insertOne(doc) }
    catch (e) { // database gagal: jangan tinggalkan objek yatim
      if (newKey) await r2Delete(newKey).catch(() => {})
      await (await col('gallery_img')).deleteOne({ _id }).catch(() => {})
      throw e
    }
    const [item] = await toItems([doc], a, c)
    res.json({ ok: true, item, total: await total(c.id) })
  }))

  router.post('/api/auth/chargallery/delete', wrap(async (req, res) => {
    const a = await userFromReq(req); if (!a) return noAuth(res)
    if (!(await allow('cgd:' + a.user._id, 60, 600))) return res.status(429).json({ error: 'Terlalu sering, tunggu sebentar.' })
    await init()
    const id = String(req.body?.id ?? '')
    if (!GID_RE.test(id)) return res.status(404).json({ error: 'Foto tidak ditemukan.' })
    const g = await col('char_gallery'), d = await g.findOne({ _id: id })
    if (!d) return res.status(404).json({ error: 'Foto tidak ditemukan.' })
    const c = (await loadChars(d.charId)).find(x => x.id === d.charId)
    const owner = !!c?.custom && c.ownerId === a.user._id
    if (d.userId !== a.user._id && !owner) return res.status(403).json({ error: 'Tidak bisa menghapus foto ini.' })
    await g.deleteOne({ _id: id })
    if (d.key && r2Enabled()) await r2Delete(d.key).catch(e => console.error('[r2] hapus galeri gagal:', e.message))
    if (d.kind === 'file' && !d.key) await (await col('gallery_img')).deleteOne({ _id: id }).catch(() => {})
    res.json({ ok: true, total: await total(d.charId) })
  }))

  // hanya mode cadangan (R2 belum dikonfigurasi): foto di MongoDB
  router.get('/api/auth/galleryimg/:id', wrap(async (req, res) => {
    const id = String(req.params.id ?? '')
    if (!GID_RE.test(id)) return res.status(404).end()
    const d = await (await col('gallery_img')).findOne({ _id: id })
    if (!d?.data) return res.status(404).end()
    res.set({ 'Content-Type': 'image/jpeg', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'public, max-age=31536000, immutable' }) // id acak & tidak pernah dipakai ulang
    res.send(Buffer.from(d.data, 'base64'))
  }))
}
