// Like + komentar untuk halaman detail karakter (public/cdetail.js). Berlaku untuk karakter bawaan maupun AI buatan user yang boleh dilihat si pemanggil.
//
// Koleksi MongoDB (dibuat otomatis):
//   char_likes    { _id: "<charId>:<userId>", charId, userId, at }        satu like per akun per karakter (id gabungan = tidak bisa dobel)
//   char_comments { _id: "<18 hex>", charId, userId, text (maks 300), at }
//   Index: char_likes {charId}, {userId}; char_comments {charId, at:-1}, {userId}.
//
// Endpoint (POST, semua di /api/auth/...). Membaca boleh tanpa login (tamu); menulis butuh token Bearer.
//   charsocial   { char }                    -> { ok, likes, liked, comments }       jumlah like/komentar + apakah akun ini sudah like
//   charlike     { char, on }                -> { ok, liked, likes }                 like / batal like (login)
//   charcomments { char, before? }           -> { ok, items, more, next }            20 per halaman, terbaru dulu (kursor `before` = ms)
//   charcomment  { char, text }              -> { ok, item, comments }               kirim komentar (login, maks 300 huruf)
//   charcomment/delete { id }                -> { ok, comments }                     hapus: penulisnya, atau pemilik AI buatan itu (login)
//   item = { id, text, at (ms), user:{username,name,avatar}, mine, canDelete }
//
// Keamanan: karakter harus ada dan boleh dipakai pemanggil (canUseChar) — AI privat orang lain tidak bisa disukai/dikomentari.
// Teks komentar hanya ditampilkan lewat textContent di client. Pembatas laju per akun (tulis) dan per IP (baca tamu).
// Dibersihkan saat akun dihapus (purgeCharSocial) dan saat AI buatan dihapus (purgeCharsSocial).

import crypto from 'node:crypto'
import { loadChars, canUseChar } from './chars.js'
import { avatarOf } from './profile.js'

const CHAR_RE = /^[\w-]{1,64}$/, CID_RE = /^[0-9a-f]{18}$/
const MAX_TEXT = 300, PAGE = 20
const ipOf = req => String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim().slice(0, 64) || 'unknown'
const cleanComment = s => String(s ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, MAX_TEXT)

// Hapus semua like & komentar milik satu akun (dipanggil saat akun dihapus)
export async function purgeCharSocial(col, userId) {
  await Promise.all([(await col('char_likes')).deleteMany({ userId }), (await col('char_comments')).deleteMany({ userId })]).catch(e => console.error('[charsocial] purge gagal:', e?.message))
}
// Hapus like & komentar untuk karakter yang dihapus (AI buatan user)
export async function purgeCharsSocial(col, charIds) {
  if (!charIds?.length) return
  await Promise.all([(await col('char_likes')).deleteMany({ charId: { $in: charIds } }), (await col('char_comments')).deleteMany({ charId: { $in: charIds } })]).catch(e => console.error('[charsocial] purge karakter gagal:', e?.message))
}

export function mountCharSocial(router, { wrap, userFromReq, allow, col, ensureIndexes }) {
  let ready
  const init = () => ready ??= Promise.all([
    ensureIndexes('char_likes', [[{ charId: 1 }], [{ userId: 1 }]]),
    ensureIndexes('char_comments', [[{ charId: 1, at: -1 }], [{ userId: 1 }]])
  ]).catch(e => { ready = null; throw e })
  const noAuth = res => res.status(401).json({ error: 'Sesi berakhir, masuk lagi.' })
  const me = req => userFromReq(req).catch(() => null) // login opsional

  // karakter harus ada dan boleh dilihat si pemanggil
  const target = async (req, res, a) => {
    const id = String(req.body?.char ?? '')
    if (!CHAR_RE.test(id)) { res.status(400).json({ error: 'Karakter tidak valid.' }); return null }
    const c = (await loadChars(id)).find(x => x.id === id)
    if (!c || !canUseChar(c, a?.user?._id || null)) { res.status(404).json({ error: 'Karakter tidak ditemukan.' }); return null }
    return c
  }
  const counts = async id => {
    const [likes, comments] = await Promise.all([(await col('char_likes')).countDocuments({ charId: id }), (await col('char_comments')).countDocuments({ charId: id })])
    return { likes, comments }
  }
  const toItems = async (docs, a, c) => {
    const ids = [...new Set(docs.map(d => d.userId))]
    const us = ids.length ? await (await col('users')).find({ _id: { $in: ids } }, { projection: { username: 1, name: 1, av: 1, avatarUrl: 1 } }).toArray() : []
    const m = new Map(us.map(u => [u._id, { username: u.username || '', name: u.name || u.username || '', avatar: avatarOf(u) }]))
    const uid = a?.user?._id || null, owner = !!uid && !!c?.custom && c.ownerId === uid
    return docs.map(d => ({
      id: d._id, text: d.text, at: new Date(d.at).getTime(), user: m.get(d.userId) || { username: '', name: 'Akun dihapus', avatar: '' },
      mine: !!uid && d.userId === uid, canDelete: !!uid && (d.userId === uid || owner)
    }))
  }

  router.post('/api/auth/charsocial', wrap(async (req, res) => {
    if (!(await allow('csr:' + ipOf(req), 180, 60))) return res.status(429).json({ error: 'Terlalu sering, tunggu sebentar.' })
    await init()
    const a = await me(req), c = await target(req, res, a); if (!c) return
    const [n, mine] = await Promise.all([counts(c.id), a ? (await col('char_likes')).findOne({ _id: `${c.id}:${a.user._id}` }, { projection: { _id: 1 } }) : null])
    res.json({ ok: true, ...n, liked: !!mine })
  }))

  router.post('/api/auth/charlike', wrap(async (req, res) => {
    const a = await userFromReq(req); if (!a) return noAuth(res)
    if (!(await allow('csl:' + a.user._id, 60, 60))) return res.status(429).json({ error: 'Terlalu sering, tunggu sebentar.' })
    await init()
    const c = await target(req, res, a); if (!c) return
    const likes = await col('char_likes'), id = `${c.id}:${a.user._id}`, on = req.body?.on === true
    if (on) {
      try { await likes.insertOne({ _id: id, charId: c.id, userId: a.user._id, at: new Date() }) }
      catch (e) { if (e?.code !== 11000) throw e } // sudah like: tidak apa-apa
    } else await likes.deleteOne({ _id: id })
    res.json({ ok: true, liked: on, likes: await likes.countDocuments({ charId: c.id }) })
  }))

  router.post('/api/auth/charcomments', wrap(async (req, res) => {
    if (!(await allow('csr:' + ipOf(req), 180, 60))) return res.status(429).json({ error: 'Terlalu sering, tunggu sebentar.' })
    await init()
    const a = await me(req), c = await target(req, res, a); if (!c) return
    const before = Number(req.body?.before)
    const q = { charId: c.id, ...(Number.isFinite(before) && before > 0 ? { at: { $lt: new Date(before) } } : {}) }
    const docs = await (await col('char_comments')).find(q).sort({ at: -1 }).limit(PAGE + 1).toArray()
    const more = docs.length > PAGE, page = more ? docs.slice(0, PAGE) : docs
    res.json({ ok: true, items: await toItems(page, a, c), more, next: more ? new Date(page[page.length - 1].at).getTime() : 0 })
  }))

  router.post('/api/auth/charcomment', wrap(async (req, res) => {
    const a = await userFromReq(req); if (!a) return noAuth(res)
    if (!(await allow('csw:' + a.user._id, 8, 60)) || !(await allow('csw3:' + a.user._id, 60, 3600))) return res.status(429).json({ error: 'Terlalu sering berkomentar, coba lagi nanti.' })
    await init()
    const c = await target(req, res, a); if (!c) return
    const text = cleanComment(req.body?.text)
    if (!text) return res.status(400).json({ error: 'Komentar tidak boleh kosong.' })
    const doc = { _id: crypto.randomBytes(9).toString('hex'), charId: c.id, userId: a.user._id, text, at: new Date() }
    await (await col('char_comments')).insertOne(doc)
    const [item] = await toItems([doc], a, c)
    res.json({ ok: true, item, comments: (await counts(c.id)).comments })
  }))

  router.post('/api/auth/charcomment/delete', wrap(async (req, res) => {
    const a = await userFromReq(req); if (!a) return noAuth(res)
    if (!(await allow('csd:' + a.user._id, 60, 600))) return res.status(429).json({ error: 'Terlalu sering, tunggu sebentar.' })
    await init()
    const id = String(req.body?.id ?? '')
    if (!CID_RE.test(id)) return res.status(404).json({ error: 'Komentar tidak ditemukan.' })
    const comments = await col('char_comments'), d = await comments.findOne({ _id: id })
    if (!d) return res.status(404).json({ error: 'Komentar tidak ditemukan.' })
    const c = (await loadChars(d.charId)).find(x => x.id === d.charId)
    const owner = !!c?.custom && c.ownerId === a.user._id
    if (d.userId !== a.user._id && !owner) return res.status(403).json({ error: 'Tidak bisa menghapus komentar ini.' })
    await comments.deleteOne({ _id: id })
    res.json({ ok: true, comments: await comments.countDocuments({ charId: d.charId }) })
  }))
}
