import { Router } from 'express'
import crypto from 'node:crypto'
import * as store from './gcstore.js'
import { bearerUser, gcSenderId } from './auth.js'

/* ===== Chat Global: API backend =====
   Semua endpoint POST (konsisten dengan API lain di lib/app.js). Tanpa CORS karena satu domain
   dengan frontend. Ringkasan:
     POST /api/gc/sync    heartbeat presence + peer + pesan baru (fallback Redis) + signaling + tombstone
     POST /api/gc/send    kirim pesan (server yang membuat id, ts, dan tanda tangan; rate-limit)
     POST /api/gc/signal  signaling WebRTC (penawaran/jawaban/kandidat ICE) antar peer yang tercatat hidup
     POST /api/gc/delete  hapus pesan / semua (hanya kode dev yang sah; menghasilkan tombstone persisten)

   Prinsip: client tidak dipercaya. senderId divalidasi formatnya, teks dipangkas di server,
   id & timestamp dibuat server, pesan ditandatangani kunci ECDSA supaya pesan P2P bisa diverifikasi
   browser penerima, dan penghapusan wajib lolos cek kode dev di sini (bukan sekadar flag dari client). */

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
const disabled = res => res.json({ enabled: false, error: 'Redis belum terpasang (lihat README: indikator online / Upstash)' })
const badId = id => typeof id !== 'string' || !CID.test(id)

/* ---------- POST /api/gc/sync ---------- */
r.post('/api/gc/sync', noStore, async (req, res) => {
  if (!store.enabled) return disabled(res)
  const { clientId, since, tombSince } = req.body || {}
  if (badId(clientId)) return res.status(400).json({ error: 'Request tidak valid' })
  try {
    const now = Date.now()
    const out = await store.sync(clientId, now, Math.max(0, parseInt(since) || 0), Math.max(0, parseInt(tombSince) || 0))
    if (out.rl) return res.status(429).json({ error: 'Terlalu sering' })
    const msgs = out.msgs.map(s => { try { return JSON.parse(s) } catch { return null } }).filter(Boolean)
    const sigs = out.sigs.map(s => { try { return JSON.parse(s) } catch { return null } }).filter(Boolean)
    res.json({
      enabled: true,
      peers: (out.peers || []).filter(p => p !== clientId).slice(0, 8),
      count: out.count || 0,
      msgs, sigs,
      wm: out.wm ? Number(out.wm) : 0,
      tombs: out.tombs || [],
      pub: await store.pubKey(),
      devHash: DEV_HASH,
      poll: { base: POLL_BASE, burst: POLL_BURST }
    })
  } catch (e) {
    console.error('[gc:sync]', e.message)
    res.status(502).json({ error: 'Sinkronisasi gagal' })
  }
})

/* ---------- POST /api/gc/send ---------- */
r.post('/api/gc/send', noStore, async (req, res) => {
  if (!store.enabled) return disabled(res)
  const { clientId, name, text } = req.body || {}
  if (badId(clientId)) return res.status(400).json({ error: 'Request tidak valid' })
  const t = cleanText(text)
  if (!t || textLen(t) > 256) return res.status(400).json({ error: 'Pesan tidak valid (1-256 karakter)' })
  try {
    // Kalau pengirim masuk akun (token Bearer sah): nama = nama profil, dan au/av = username + versi foto profil (client membuat alamat fotonya sendiri).
    // Tanpa token / token tidak sah / Mongo mati: tetap bisa kirim sebagai tamu dengan nama dari body.
    let acct = null
    if (req.headers.authorization) { try { acct = (await bearerUser(req))?.user || null } catch { acct = null } }
    const m = {
      id: crypto.randomUUID(),
      senderId: acct ? gcSenderId(acct._id) : clientId, // masuk akun: id tetap per akun (dari token sah, tidak bisa dipalsukan client); tamu: clientId tervalidasi. Ikut tertanda tangan.
      senderName: (acct && cleanName(acct.name)) || cleanName(name) || 'Tamu',
      text: t,
      ts: Date.now()               // timestamp server (client tidak menentukan urutan)
    }
    m.sig = await store.sign(m)    // tanda tangan hanya untuk kolom di atas; au/av ditambahkan sesudahnya (hiasan tampilan)
    if (acct && (acct.av || acct.avatarUrl)) { m.au = acct.username; m.av = acct.av || 1 }
    const ok = await store.send(m, Date.now())
    if (!ok) return res.status(429).json({ error: 'Terlalu sering kirim pesan, tunggu sebentar' })
    res.json({ m })
  } catch (e) {
    console.error('[gc:send]', e.message)
    res.status(502).json({ error: 'Pesan gagal dikirim' })
  }
})

/* ---------- POST /api/gc/signal ---------- */
// Frame signaling WebRTC. `from` wajib punya heartbeat presence segar; `to` juga harus pengguna ruang yang
// aktif -> identitas yang diklaim client tidak diterima begitu saja. Payload dibatasi ukurannya.
r.post('/api/gc/signal', noStore, async (req, res) => {
  if (!store.enabled) return disabled(res)
  const { from, to, t, d } = req.body || {}
  if (badId(from) || badId(to) || from === to) return res.status(400).json({ error: 'Request tidak valid' })
  if (!['o', 'a', 'i'].includes(t)) return res.status(400).json({ error: 'Tipe signal tidak dikenal' })
  let payload
  try { payload = JSON.stringify({ f: from, t, d }) } catch { return res.status(400).json({ error: 'Request tidak valid' }) }
  if (payload.length > 4096) return res.status(400).json({ error: 'Signal terlalu besar' })
  if (t !== 'i' && (typeof d !== 'string' || d.length > 3600)) return res.status(400).json({ error: 'Signal tidak valid' })
  try {
    const ok = await store.signal(from, to, payload, Date.now())
    if (ok === -1) return res.status(403).json({ error: 'Pengirim belum tercatat di ruang chat' })
    if (ok === -2) return res.status(429).json({ error: 'Terlalu sering' })
    res.json({ ok: 1 })
  } catch (e) {
    console.error('[gc:signal]', e.message)
    res.status(502).json({ error: 'Signal gagal' })
  }
})

/* ---------- POST /api/gc/delete (Mode dev) ---------- */
// Hanya menerima kode dev yang hash-nya cocok (mekanisme yang sama dengan pembuka Mode dev di browser).
// Hasilnya tombstone persisten: id pesan masuk ZSET (60 hari) atau watermark "hapus semua" — pesan yang
// sudah dihapus tidak boleh muncul lagi dari IndexedDB, Redis, maupun transfer P2P manapun.
r.post('/api/gc/delete', noStore, async (req, res) => {
  if (!store.enabled) return disabled(res)
  const { code, id, all } = req.body || {}
  if (!okDev(code)) return res.status(403).json({ error: 'Kode dev salah' })
  try {
    const now = Date.now()
    if (all) {
      const wm = await store.clear(now)
      return res.json({ ok: 1, wm })
    }
    if (typeof id !== 'string' || !ID_RE.test(id)) return res.status(400).json({ error: 'Request tidak valid' })
    await store.tomb(id, now)
    res.json({ ok: 1, tombs: [id] })
  } catch (e) {
    console.error('[gc:delete]', e.message)
    res.status(502).json({ error: 'Penghapusan gagal' })
  }
})

export const gcRouter = r
