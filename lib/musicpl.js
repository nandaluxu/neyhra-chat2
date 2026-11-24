import crypto from 'node:crypto'

// ===== Playlist musik PUBlik: bagikan playlist lokal ke server, dapat kode tetap =====
// Dipasang lib/auth.js: mountMusicPl(router, { wrap, userFromReq, allow, col, ensureIndexes }).
// Frontend: public/music.js (menu titik-tiga di playlist). Koleksi MongoDB:
//   music_pl { _id: kode, uid, pid (id playlist lokal), username, name, songs, n, updatedAt }
// Alur:
//   - "Jadikan Publik"  -> POST /api/auth/pl/share  { pid, name, songs } -> { ok, code }
//     Kode STABIL per playlist (uid+pid): bagikan lagi setelah edit -> kode tetap, isi terbaru.
//   - "Jadikan Private" -> POST /api/auth/pl/unshare { pid } -> { ok } (kode dihapus, link mati)
//   - Buka link /music?pl=KODE (tanpa login) -> GET /api/auth/pl/get?code=KODE -> { ok, name, by, songs }
//   - GET /api/auth/pl/list -> daftar playlist publik (seksi "Pilihan Orang Lain"); milik sendiri ikut
//     ber-flag mine:true + pid — klien menyembunyikan yang masih ada di "Playlist kamu" (tidak dobel),
//     sisanya ber-badge "Kamu" supaya pemilik selalu bisa menemukan & memulihkan playlistnya
// Akun dihapus -> purgeMusicPl(col, uid) ikut membersihkan semua kode miliknya (dipanggil lib/auth.js).
// Playlist tetap milik pembuatnya (localStorage); server cuma menyimpan salanan untuk dibagikan.
// CADANGAN PER AKUN (music_plstore { _id: uid, pls, del, updatedAt }): 'Keluar' menghapus seluruh localStorage perangkat,
// termasuk daftar playlist ('mpl'), jadi tanpa cadangan playlist hilang setiap logout/login. Klien mendorong seluruh
// daftar playlist (privat maupun publik) ke sini dan menariknya lagi saat masuk:
//   POST /api/auth/pl/mine/pull -> { ok, uid, pls|null, del, updatedAt }
//   POST /api/auth/pl/mine/push { pls, del } -> { ok, updatedAt }   (digabung di klien: id sama = yang `u` terbaru menang)

const CODE_RE = /^[a-z0-9]{6,12}$/
const MAX_SONGS = 250 // muat dalam batas body JSON global (50kb) meski judul/thumb panjang
const newCode = () => crypto.randomBytes(8).toString('base64url').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8) || crypto.randomBytes(4).toString('hex')

const cleanSongs = raw => (Array.isArray(raw) ? raw : [])
  .filter(s => s && /^[\w-]{11}$/.test(String(s.id)))
  .slice(0, MAX_SONGS)
  .map(s => ({
    id: String(s.id),
    title: String(s.title || '').slice(0, 120),
    artist: String(s.artist || '').slice(0, 120),
    album: String(s.album || '').slice(0, 120),
    dur: Math.max(0, Math.round(Number(s.dur) || 0)),
    thumb: String(s.thumb || '').slice(0, 300)
  }))

// ---- cadangan akun: bentuk playlist lengkap (lebih longgar dari salinan publik: sampai 500 lagu, 50 playlist) ----
const MAX_STORE_PL = 50, MAX_STORE_SONGS = 500, MAX_STORE_BYTES = 3_500_000
const PID_RE = /^[\w-]{1,40}$/
const cleanStore = raw => (Array.isArray(raw) ? raw : []).filter(p => p && PID_RE.test(String(p.id))).slice(0, MAX_STORE_PL).map(p => ({
  id: String(p.id),
  name: String(p.name || 'Playlist').trim().slice(0, 60) || 'Playlist',
  pub: CODE_RE.test(String(p.pub || '')) ? String(p.pub) : '',
  u: Math.max(0, Math.round(Number(p.u) || 0)),
  songs: (Array.isArray(p.songs) ? p.songs : []).filter(s => s && PID_RE.test(String(s.id))).slice(0, MAX_STORE_SONGS).map(s => ({
    id: String(s.id),
    title: String(s.title || '').slice(0, 120),
    artist: String(s.artist || '').slice(0, 120),
    album: String(s.album || '').slice(0, 120),
    dur: Math.max(0, Math.round(Number(s.dur) || 0)),
    thumb: String(s.thumb || '').slice(0, 300),
    ch: String(s.ch || '').slice(0, 80)
  }))
}))
// nisan hapus: id playlist -> waktu dihapus (supaya playlist yang dihapus di satu perangkat tidak "hidup lagi" dari perangkat lain)
const cleanDel = raw => {
  const o = {}
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw).slice(0, 200)) if (PID_RE.test(k) && Number(v) > 0) o[k] = Math.round(Number(v))
  }
  return o
}

export function mountMusicPl(router, { wrap, userFromReq, allow, col, ensureIndexes }) {
  // indeks unik {uid,pid} dipasang malas di dalam handler (bukan saat mount): tanpa MongoDB
  // (dev lokal) server tetap boot; userFromReq sukses = Mongo pasti hidup di titik ini.
  const idx = () => ensureIndexes && ensureIndexes('music_pl', [[{ uid: 1, pid: 1 }, { unique: true }]])

  // bagikan / perbarui playlist -> kode tetap per playlist
  router.post('/api/auth/pl/share', wrap(async (req, res) => {
    const a = await userFromReq(req)
    if (!a) return res.status(401).json({ error: 'Masuk dulu untuk membagikan playlist.' })
    if (!(await allow('plshare:' + a.user._id, 20, 60))) return res.status(429).json({ error: 'Terlalu sering, tunggu sebentar.' })
    const b = req.body || {}
    const pid = String(b.pid || ''), name = String(b.name || '').trim().slice(0, 60)
    if (!/^[\w-]{1,40}$/.test(pid) || !name) return res.status(400).json({ error: 'Data playlist tidak valid.' })
    const songs = cleanSongs(b.songs)
    if (!songs.length) return res.status(400).json({ error: 'Playlist masih kosong — tambahkan lagu dulu.' })
    idx()
    const c = await col('music_pl')
    const key = { uid: a.user._id, pid }
    const old = await c.findOne(key)
    const code = (old && CODE_RE.test(String(old._id))) ? old._id : newCode()
    await c.updateOne({ _id: code, uid: a.user._id }, { $set: { pid, username: a.user.username, name, songs, n: songs.length, updatedAt: new Date() } }, { upsert: true })
    // sisa salinan lama dengan pid sama tapi kode beda (jarang, mis. kode tabrakan): bersihkan
    await c.deleteMany({ uid: a.user._id, pid, _id: { $ne: code } })
    res.json({ ok: true, code })
  }))

  // jadikan private: hapus kode dari server (link lama berhenti bekerja)
  router.post('/api/auth/pl/unshare', wrap(async (req, res) => {
    const a = await userFromReq(req)
    if (!a) return res.status(401).json({ error: 'Masuk dulu.' })
    if (!(await allow('plshare:' + a.user._id, 20, 60))) return res.status(429).json({ error: 'Terlalu sering, tunggu sebentar.' })
    const pid = String((req.body || {}).pid || '')
    if (!/^[\w-]{1,40}$/.test(pid)) return res.status(400).json({ error: 'Data playlist tidak valid.' })
    idx()
    await (await col('music_pl')).deleteMany({ uid: a.user._id, pid })
    res.json({ ok: true })
  }))

  // daftar playlist publik untuk seksi "Pilihan Orang Lain" (beranda musik). Tanpa login juga boleh.
  // Playlist milik sendiri IKUT, ber-flag mine:true + pid. Dulu disaring lewat token ($ne uid) dengan
  // asumsi "sudah ada di Playlist kamu" — tapi Playlist kamu cuma localStorage per perangkat, jadi
  // kalau pemilik buka dari perangkat/browser lain (atau storage terhapus), playlistnya tidak
  // terlihat di mana pun padahal akun lain masih melihatnya. Klien yang menyembunyikan entri mine
  // yang playlist lokalnya masih ada (biar tidak dobel) dan menampilkan sisanya ber-badge "Kamu".
  // Ringan: tanpa isi lagu; uid cuma dipakai untuk menghitung mine, tidak dikirim ke klien.
  router.get('/api/auth/pl/list', wrap(async (req, res) => {
    if (!(await allow('plget:' + String(req.query.clientId || req.headers['x-forwarded-for'] || '').slice(0, 40), 30, 60))) return res.status(429).json({ error: 'Terlalu sering, tunggu sebentar' })
    res.set('Cache-Control', 'no-store')
    let me = null; try { me = await userFromReq(req) } catch {} /* token salah/kadaluarsa -> anggap tamu */
    const mine = !!(me && me.user)
    const d = await (await col('music_pl')).find({ 'songs.0': { $exists: true } }, { projection: { uid: 1, name: 1, username: 1, pid: 1, n: 1, updatedAt: 1, songs: { $slice: 1 } } })
      .sort({ updatedAt: -1 }).limit(24).toArray()
    res.json({ ok: true, pls: d.map(x => ({ code: x._id, name: x.name, by: x.username || '', n: x.n || (x.songs && x.songs.length) || 0, cover: (x.songs && x.songs[0] && x.songs[0].thumb) || '', pid: String(x.pid || ''), mine: !!(mine && x.uid === me.user._id) })) })
  }))

  // ===== cadangan seluruh playlist milik akun (privat + publik) supaya selamat dari Keluar / ganti perangkat =====
  router.post('/api/auth/pl/mine/pull', wrap(async (req, res) => {
    const a = await userFromReq(req)
    if (!a) return res.status(401).json({ error: 'Sesi berakhir, masuk lagi.' })
    if (!(await allow('plstore:' + a.user._id, 60, 60))) return res.status(429).json({ error: 'Terlalu sering, tunggu sebentar.' })
    res.set('Cache-Control', 'no-store')
    const d = await (await col('music_plstore')).findOne({ _id: a.user._id })
    res.json({ ok: true, uid: String(a.user._id), pls: d ? d.pls : null, del: d ? d.del || {} : {}, updatedAt: d ? d.updatedAt : null })
  }))

  router.post('/api/auth/pl/mine/push', wrap(async (req, res) => {
    const a = await userFromReq(req)
    if (!a) return res.status(401).json({ error: 'Sesi berakhir, masuk lagi.' })
    if (!(await allow('plstore:' + a.user._id, 60, 60))) return res.status(429).json({ error: 'Terlalu sering, tunggu sebentar.' })
    const b = req.body || {}
    if (!Array.isArray(b.pls)) return res.status(400).json({ error: 'Data playlist tidak valid.' })
    const pls = cleanStore(b.pls), del = cleanDel(b.del)
    if (Buffer.byteLength(JSON.stringify(pls)) > MAX_STORE_BYTES) return res.status(413).json({ error: 'Playlist terlalu besar untuk dicadangkan ke akun. Kurangi isi playlist.' })
    const updatedAt = new Date()
    await (await col('music_plstore')).updateOne({ _id: a.user._id }, { $set: { pls, del, updatedAt } }, { upsert: true })
    res.json({ ok: true, updatedAt })
  }))

  // ambil playlist publik lewat kode (tanpa login: siapa pun yang punya link)
  router.get('/api/auth/pl/get', wrap(async (req, res) => {
    const code = String(req.query.code || '').toLowerCase()
    if (!CODE_RE.test(code)) return res.status(400).json({ error: 'Kode playlist tidak valid.' })
    if (!(await allow('plget:' + String(req.query.clientId || req.headers['x-forwarded-for'] || '').slice(0, 40), 30, 60))) return res.status(429).json({ error: 'Terlalu sering, tunggu sebentar' })
    res.set('Cache-Control', 'no-store')
    const d = await (await col('music_pl')).findOne({ _id: code })
    if (!d) return res.status(404).json({ error: 'Playlist tidak ditemukan — mungkin sudah dijadikan private.' })
    res.json({ ok: true, name: d.name, by: d.username || '', n: d.n || d.songs.length, songs: d.songs, updatedAt: d.updatedAt })
  }))
}

// bersihkan semua kode milik satu akun (akun dihapus -> dipanggil lib/auth.js)
export async function purgeMusicPl(col, uid) {
  try { await (await col('music_pl')).deleteMany({ uid }) } catch {}
  try { await (await col('music_plstore')).deleteOne({ _id: uid }) } catch {}
}
