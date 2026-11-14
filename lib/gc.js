import express, { Router } from 'express'
import crypto from 'node:crypto'
import * as store from './gcstore.js'
import { bearerUser, gcSenderId, allow as authAllow } from './auth.js'
import { r2Enabled, r2Put, r2Delete, r2PublicUrl } from './r2.js'
import { col, ensureIndexes, mongoEnabled } from './mongo.js'

/* ===== Chat Global: API backend =====
   Semua endpoint POST (konsisten dengan API lain di lib/app.js). Tanpa CORS karena satu domain
   dengan frontend. Ringkasan:
     POST /api/gc/sync     heartbeat presence + pesan baru (feed Redis; ditambal dari Mongo kalau klien tertinggal) + tombstone
     POST /api/gc/history  riwayat dari MongoDB, per halaman (kursor `before` = {ts, id}), terbaru dulu lalu mundur
     POST /api/gc/send     kirim pesan: simpan ke MongoDB (penyimpanan utama), lalu taruh ke feed Redis (id & ts dibuat server; rate-limit)
     POST /api/gc/upload   unggah 1 gambar (JPEG mentah, wajib login) ke Cloudflare R2 -> { key, img }; key dipakai di /send (imgKey)
     POST /api/gc/delete   hapus pesan / semua (hanya kode dev yang sah): hapus di Mongo + tombstone di Redis

   Pembagian tugas: MongoDB = seluruh riwayat (koleksi gc_messages). Redis = presence, rate-limit, dan feed 10 pesan terbaru untuk polling.
   Prinsip: client tidak dipercaya. senderId divalidasi formatnya, teks dipangkas di server, id & timestamp dibuat server,
   dan penghapusan wajib lolos cek kode dev di sini (bukan sekadar flag dari client). */

const r = Router()

const CID = /^[\w-]{8,64}$/            // sama seperti validasi clientId di /api/online
const MID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/ // hanya id buatan server
const ID_RE = /^[0-9a-zA-Z_-]{1,64}$/

// Sama seperti cleanName di lib/app.js (nama masuk tampilan publik -> buang karakter berbahaya)
const cleanName = n => String(n ?? '').replace(/[\u0000-\u001f<>\[\]{}`]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 24)
// Teks pesan: buang karakter kontrol (kecuali \n \t) dan baris kosong beruntun. Panjang dicek per kode unicode
// (sama seperti penghitung karakter di UI, emoji = 1); lebih dari 256 ditolak, bukan dipangkas, supaya tidak
// pernah menghasilkan teks terpotong di tengah surrogate pair.
const cleanText = t => String(t ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/\n{3,}/g, '\n\n').trim()
const textLen = t => [...t].length

// cyrb53 + norm: sama persis seperti GX.hash di browser (public/group.js) -> kode dev divalidasi tanpa auth baru.
const hash53 = (str, seed = 0) => {
  let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed
  for (let i = 0, c; i < str.length; i++) { c = str.charCodeAt(i); h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677); }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return 4294967296 * (2097151 & h2) + (h1 >>> 0)
}
const normCode = s => String(s || '').trim().toLowerCase().replace(/\s+/g, '')
// Default = hash kode dev yang sama dengan DEV_SECRET di index.html. Bisa diganti lewat env GC_DEV_HASH
// (misal untuk pengujian lokal) tanpa menyentuh kode frontend.
const DEV_HASH = Number(process.env.GC_DEV_HASH) || 3608493969801461
const okDev = code => { try { return hash53(normCode(code)) === DEV_HASH } catch { return false } }

// Interval polling adaptif (dikirim ke client supaya bisa diatur dari env tanpa deploy ulang frontend):
// saat ada aktivitas client memakai burst, lalu melambat ke base.
const POLL_BASE = Math.min(Math.max(parseInt(process.env.GC_POLL_BASE) || 10000, 3000), 60000)
const POLL_BURST = Math.min(Math.max(parseInt(process.env.GC_POLL_BURST) || 3000, 1500), POLL_BASE)

const noStore = (req, res, next) => { res.set('Cache-Control', 'no-store'); next() }
const ready = () => store.enabled && mongoEnabled()
const disabled = res => res.json({ enabled: false, error: 'Chat global butuh Redis (presence) dan MongoDB (riwayat), lihat README' })

// Koleksi riwayat: _id = id pesan (UUID buatan server). Index {ts,_id} menurun = urutan halaman riwayat.
// Dokumen: { _id, senderId, senderName, text, ts, replyTo (id pesan yang dibalas | null), au?, av? }
const msgCol = async () => { await ensureIndexes('gc_messages', [[{ ts: -1, _id: -1 }]]); return col('gc_messages') }
// img = alamat publik gambar di R2 (+ iw/ih = ukuran untuk menyisakan ruang di bubble); imgKey (nama objek) TIDAK dikirim ke client.
const pub = d => ({ id: d._id, senderId: d.senderId, senderName: d.senderName, text: d.text, ts: d.ts, replyTo: d.replyTo || null, ...(d.au ? { au: d.au, av: d.av } : {}), ...(d.img ? { img: d.img, ...(d.iw ? { iw: d.iw, ih: d.ih } : {}) } : {}) })
const IMG_KEY = /^gc\/[0-9a-f]{24}\.jpg$/
const IMG_MAX = 700 * 1024 // client mengecilkan ke <= ±1280 px JPEG; batas keras di server
const dim = v => { const n = parseInt(v); return Number.isInteger(n) && n >= 1 && n <= 4096 ? n : 0 }
const PAGE_DEF = 30, PAGE_MAX = 50
const badId = id => typeof id !== 'string' || !CID.test(id)

/* ---------- POST /api/gc/sync ---------- */
r.post('/api/gc/sync', noStore, async (req, res) => {
  if (!ready()) return disabled(res)
  const { clientId, since, tombSince } = req.body || {}
  if (badId(clientId)) return res.status(400).json({ error: 'Request tidak valid' })
  try {
    const now = Date.now(), sinceMs = Math.max(0, parseInt(since) || 0)
    const out = await store.sync(clientId, now, sinceMs, Math.max(0, parseInt(tombSince) || 0))
    if (out.rl) return res.status(429).json({ error: 'Terlalu sering' })
    let msgs = out.msgs.map(s => { try { return JSON.parse(s) } catch { return null } }).filter(Boolean), more = false
    // Feed Redis cuma 10 pesan. Kalau pesan tertuanya di feed lebih baru dari `since`, klien mungkin kehilangan pesan
    // di antaranya (terdorong keluar oleh LTRIM, push feed gagal, atau feed baru terisi sebagian setelah TTL)
    // -> tambal dari Mongo (urut naik; kalau masih ada sisanya `more` = true dan klien polling lagi lebih cepat).
    if (sinceMs > 0 && out.oldest > sinceMs) {
      try {
        const docs = await (await msgCol()).find({ ts: { $gt: sinceMs } }).sort({ ts: 1, _id: 1 }).limit(PAGE_MAX + 1).toArray()
        more = docs.length > PAGE_MAX; msgs = docs.slice(0, PAGE_MAX).map(pub)
      } catch (e) { console.error('[gc:sync:gap]', e.message) } // Mongo gagal: tetap beri pesan dari feed Redis
    }
    res.json({
      enabled: true,
      count: out.count || 0,
      msgs, more,
      wm: out.wm ? Number(out.wm) : 0,
      tombs: out.tombs || [],
      devHash: DEV_HASH,
      poll: { base: POLL_BASE, burst: POLL_BURST }
    })
  } catch (e) {
    console.error('[gc:sync]', e.message)
    res.status(502).json({ error: 'Sinkronisasi gagal' })
  }
})

/* ---------- POST /api/gc/history ---------- */
// Riwayat dari MongoDB. Tanpa `before` = halaman terbaru; dengan `before` = {ts, id} (pesan tertua yang sudah dimiliki klien) =
// halaman yang lebih lama. `msgs` selalu urut naik. `t0` = waktu server SEBELUM query: klien memakainya sebagai titik awal
// tombstone, jadi penghapusan yang terjadi sesudahnya tetap sampai lewat /sync.
r.post('/api/gc/history', noStore, async (req, res) => {
  if (!ready()) return disabled(res)
  const { clientId, before, limit } = req.body || {}
  if (badId(clientId)) return res.status(400).json({ error: 'Request tidak valid' })
  if (before != null && !(Number.isInteger(before.ts) && before.ts > 0 && typeof before.id === 'string' && MID.test(before.id))) return res.status(400).json({ error: 'Request tidak valid' })
  const lim = Math.min(Math.max(parseInt(limit) || PAGE_DEF, 1), PAGE_MAX)
  try {
    const t0 = Date.now()
    if (!(await store.allow('hist', clientId, t0))) return res.status(429).json({ error: 'Terlalu sering' })
    const wm = await store.wm()
    const cond = []
    if (before) cond.push({ $or: [{ ts: { $lt: before.ts } }, { ts: before.ts, _id: { $lt: before.id } }] })
    if (wm) cond.push({ ts: { $gt: wm } }) // pesan di bawah watermark "hapus semua" tidak ditampilkan
    const docs = await (await msgCol()).find(cond.length > 1 ? { $and: cond } : cond[0] || {}).sort({ ts: -1, _id: -1 }).limit(lim + 1).toArray()
    res.json({ enabled: true, msgs: docs.slice(0, lim).reverse().map(pub), more: docs.length > lim, t0, wm })
  } catch (e) {
    console.error('[gc:history]', e.message)
    res.status(502).json({ error: 'Riwayat gagal dimuat' })
  }
})

/* ---------- POST /api/gc/upload ---------- */
// Body = byte JPEG mentah (Content-Type: image/jpeg), BUKAN JSON (parser JSON global 50 KB tidak menyentuhnya). Wajib login (Bearer) + dibatasi laju,
// supaya bucket R2 tidak bisa dipenuhi anonim. Hanya JPEG (dicek byte awal): client selalu mengubah gambar jadi JPEG lewat canvas.
r.post('/api/gc/upload', noStore, express.raw({ type: 'image/jpeg', limit: IMG_MAX }), async (req, res) => {
  if (!ready()) return disabled(res)
  if (!r2Enabled()) return res.status(501).json({ error: 'Kirim gambar belum aktif di server (Cloudflare R2 belum diatur).', imgOff: true })
  try {
    let acct = null
    try { acct = (await bearerUser(req))?.user || null } catch { acct = null }
    if (!acct) return res.status(401).json({ error: 'Masuk dulu untuk mengirim gambar.' })
    const buf = req.body
    if (!Buffer.isBuffer(buf) || buf.length < 200 || buf.length > IMG_MAX || buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff) return res.status(400).json({ error: 'Gambar tidak valid (harus JPEG, maks 700 KB).' })
    if (!(await authAllow('gcimg:' + acct._id, 8, 60))) return res.status(429).json({ error: 'Terlalu sering kirim gambar, tunggu sebentar.' })
    const key = `gc/${crypto.randomBytes(12).toString('hex')}.jpg`
    await r2Put(key, buf, 'image/jpeg')
    res.json({ ok: true, key, img: r2PublicUrl(key) })
  } catch (e) {
    console.error('[gc:upload]', e.message)
    res.status(e?.type === 'entity.too.large' ? 413 : 502).json({ error: e?.type === 'entity.too.large' ? 'Gambar terlalu besar.' : 'Gambar gagal diunggah' })
  }
})

/* ---------- POST /api/gc/send ---------- */
r.post('/api/gc/send', noStore, async (req, res) => {
  if (!ready()) return disabled(res)
  const { clientId, name, text, replyTo, imgKey, iw, ih } = req.body || {}
  if (badId(clientId)) return res.status(400).json({ error: 'Request tidak valid' })
  const t = cleanText(text)
  const key = typeof imgKey === 'string' && IMG_KEY.test(imgKey) ? imgKey : null // pesan gambar: teks (caption) boleh kosong
  if ((!t && !key) || textLen(t) > 256) return res.status(400).json({ error: 'Pesan tidak valid (1-256 karakter)' })
  if (imgKey != null && !key) return res.status(400).json({ error: 'Gambar tidak valid' })
  if (key && !r2Enabled()) return res.status(501).json({ error: 'Kirim gambar belum aktif di server.', imgOff: true })
  try {
    // Kalau pengirim masuk akun (token Bearer sah): nama = nama profil, dan au/av = username + versi foto profil (client membuat alamat fotonya sendiri).
    // Tanpa token / token tidak sah / Mongo mati: tetap bisa kirim sebagai tamu dengan nama dari body.
    let acct = null
    if (req.headers.authorization) { try { acct = (await bearerUser(req))?.user || null } catch { acct = null } }
    const m = {
      id: crypto.randomUUID(),
      senderId: acct ? gcSenderId(acct._id) : clientId, // masuk akun: id tetap per akun (dari token sah, tidak bisa dipalsukan client); tamu: clientId tervalidasi.
      senderName: (acct && cleanName(acct.name)) || cleanName(name) || 'Tamu',
      text: t,
      ts: Date.now(),              // timestamp server (client tidak menentukan urutan)
      replyTo: typeof replyTo === 'string' && MID.test(replyTo) ? replyTo : null // disiapkan untuk fitur balas pesan (belum ada UI); tidak dicek keberadaannya
    }
    if (acct && (acct.av || acct.avatarUrl)) { m.au = acct.username; m.av = acct.av || 1 }
    if (key) {
      if (!acct) return res.status(401).json({ error: 'Masuk dulu untuk mengirim gambar.' })
      m.img = r2PublicUrl(key); if (dim(iw) && dim(ih)) { m.iw = dim(iw); m.ih = dim(ih) } // alamat dibangun server dari key tervalidasi, bukan URL dari client
    }
    if (!(await store.allow('send', m.senderId, m.ts))) return res.status(429).json({ error: 'Terlalu sering kirim pesan, tunggu sebentar' }) // sebelum menulis ke Mongo
    const { id, ...rest } = m
    await (await msgCol()).insertOne({ _id: id, ...rest, ...(key ? { imgKey: key } : {}) }) // penyimpanan utama; gagal -> pesan dianggap gagal terkirim
    try { await store.push(m, m.ts) } catch (e) { console.error('[gc:send:feed]', e.message) } // feed realtime; riwayat sudah aman di Mongo
    res.json({ m })
  } catch (e) {
    console.error('[gc:send]', e.message)
    res.status(502).json({ error: 'Pesan gagal dikirim' })
  }
})

// Hapus objek gambar di R2 (best-effort: gagal hanya dicatat, pesan di Mongo sudah terhapus). Bertahap 10 sekaligus.
async function rmImgs(keys) {
  const ks = (keys || []).filter(k => typeof k === 'string' && IMG_KEY.test(k))
  for (let i = 0; i < ks.length; i += 10) await Promise.allSettled(ks.slice(i, i + 10).map(r2Delete))
}

/* ---------- POST /api/gc/delete (Mode dev) ---------- */
// Hanya menerima kode dev yang hash-nya cocok (mekanisme yang sama dengan pembuka Mode dev di browser).
// Pesan dihapus dari MongoDB (jadi tidak muncul lagi di riwayat) + tombstone/watermark di Redis supaya klien yang
// sedang online ikut membuangnya lewat /sync.
r.post('/api/gc/delete', noStore, async (req, res) => {
  if (!ready()) return disabled(res)
  const { code, id, all } = req.body || {}
  if (!okDev(code)) return res.status(403).json({ error: 'Kode dev salah' })
  try {
    const now = Date.now(), c = await msgCol()
    if (all) {
      const withImg = await c.find({ ts: { $lte: now }, imgKey: { $exists: true } }, { projection: { imgKey: 1 } }).toArray().catch(() => [])
      await c.deleteMany({ ts: { $lte: now } })
      await rmImgs(withImg.map(d => d.imgKey)) // gambar di R2 ikut dihapus (best-effort)
      // Watermark di Redis = koordinasi best-effort: Mongo (sumber kebenaran) sudah terhapus, jadi kegagalan Redis
      // tidak membatalkan penghapusan. Klien yang online tetap diberi watermark supaya ikut membersihkan tampilannya.
      try { await store.clear(now) } catch (e) { console.error('[gc:delete:clear]', e.message) }
      return res.json({ ok: 1, wm: now })
    }
    if (typeof id !== 'string' || !ID_RE.test(id)) return res.status(400).json({ error: 'Request tidak valid' })
    const one = await c.findOne({ _id: id }, { projection: { imgKey: 1 } }).catch(() => null)
    await c.deleteOne({ _id: id })
    if (one?.imgKey) await rmImgs([one.imgKey])
    try { await store.tomb(id, now) } catch (e) { console.error('[gc:delete:tomb]', e.message) } // idem: best-effort
    res.json({ ok: 1, tombs: [id] })
  } catch (e) {
    console.error('[gc:delete]', e.message)
    res.status(502).json({ error: 'Penghapusan gagal' })
  }
})

export const gcRouter = r
