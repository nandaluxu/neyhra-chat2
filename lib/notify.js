import crypto from 'node:crypto'

// ===== Pusat Notifikasi: satu tempat semua kejadian ekonomi/sosial antar-player muncul =====
// Dipasang ke router auth (lib/auth.js) lewat mountNotify(), jadi memakai sesi/token dan pembatas laju
// yang sama dengan fitur lain. Tidak butuh Redis (MongoDB saja) supaya jalan di semua deployment.
//
// Siapa yang menulis notifikasi:
//   - track() di lib/quests.js: misi selesai + piala baru -> ikut tercatat di sini (best-effort).
//   - lib/transfer.js  : kirim/terima transfer.
//   - lib/trade.js     : penawaran masuk, diterima, ditolak, dibatalkan.
//   - lib/market.js    : barang laku terjual, pembelian, listing batal.
//   - lib/robbery.js   : menjadi target pencurian (berhasil/gagal/digagalkan perisai).
//   - lib/bank.js      : bunga harian masuk.
// Semua penulis memakai push() di bawah; kegagalan menulis tidak pernah menggagalkan aksi utamanya.
//
// Koleksi `notif`:
//   { _id: "<uid>:<rand>", uid, type, txt, at, seen: false, m?: meta kecil untuk client (aksi cepat) }
//   Index { uid: 1, at: -1 } untuk halaman + { seen: 1 } untuk hitung belum-baca. TTL 90 hari.
//
// Endpoint (POST, token Bearer):
//   /api/auth/notify        -> { ok, items, more, next, unread, nq? }   body { before? }   30 per halaman
//   /api/auth/notify/seen  -> { ok, unread }                            body { id? | all: true }
//
// `type` yang bisa muncul (client boleh menampilkan ikon/warna berbeda):
//   quest | ach | transfer-in | transfer-out | trade | trade-done | market | rob | bank | sys

const TTL_DAYS = 90, PAGE = 30

// Push notifikasi untuk satu user. Best-effort: error ditelan (dikonsol) supaya pemanggil tidak rungket.
export async function push(col, uid, type, txt, meta) {
  try {
    txt = String(txt || '').slice(0, 200)
    if (!txt) return
    await (await col('notif')).insertOne({
      _id: `${uid}:${Date.now().toString(36)}:${crypto.randomBytes(4).toString('hex')}`,
      uid, type, txt, at: new Date(), seen: false, ...(meta && typeof meta === 'object' ? { m: meta } : {})
    })
  } catch (e) { console.error('[notify] push gagal:', e?.message) }
}

// Hapus semua notifikasi milik satu akun (dipanggil saat akun dihapus di lib/auth.js)
export async function purgeNotify(col, userId) {
  await (await col('notif')).deleteMany({ uid: userId })
}

export function mountNotify(router, { wrap, userFromReq, allow, col, ensureIndexes }) {
  let ready
  const init = () => ready ??= ensureIndexes('notif', [[{ uid: 1, at: -1 }], [{ seen: 1 }], [{ at: 1 }, { expireAfterSeconds: TTL_DAYS * 86400 }]]).catch(e => { ready = null; throw e })
  const need = async (req, res) => {
    const a = await userFromReq(req)
    if (!a) { res.status(401).json({ error: 'Sesi berakhir, masuk lagi.' }); return null }
    return a.user
  }
  const view = n => ({ id: n._id, type: n.type, txt: n.txt, at: n.at, seen: !!n.seen, ...(n.m ? { m: n.m } : {}) })

  // Daftar notifikasi terbaru dulu. `before` = timestamp item terbawah halaman sebelumnya (kursor).
  router.post('/api/auth/notify', wrap(async (req, res) => {
    const u = await need(req, res); if (!u) return
    if (!(await allow('ntf:' + u._id, 60, 60))) return res.status(429).json({ error: 'Terlalu sering, tunggu sebentar.' })
    await init()
    const before = Number(req.body?.before)
    const q = { uid: u._id, ...(Number.isFinite(before) && before > 0 ? { at: { $lt: new Date(before) } } : {}) }
    const docs = await (await col('notif')).find(q).sort({ at: -1 }).limit(PAGE + 1).toArray()
    const unread = await (await col('notif')).countDocuments({ uid: u._id, seen: false })
    const more = docs.length > PAGE, page = docs.slice(0, PAGE)
    res.json({ ok: true, items: page.map(view), more, next: more ? page[page.length - 1].at.getTime() : 0, unread })
  }))

  // Tandai sudah dibaca: satu id, atau semua sekaligus ({ all: true }).
  router.post('/api/auth/notify/seen', wrap(async (req, res) => {
    const u = await need(req, res); if (!u) return
    if (!(await allow('ntfs:' + u._id, 60, 60))) return res.status(429).json({ error: 'Terlalu sering, tunggu sebentar.' })
    await init()
    if (req.body?.all === true) {
      await (await col('notif')).updateMany({ uid: u._id, seen: false }, { $set: { seen: true } })
    } else {
      const id = String(req.body?.id || '')
      // id notifikasi selalu berawalan "<uid>:" -> cukup cek prefiks, bukan cocokkan _id mentah dari client
      if (!id.startsWith(u._id + ':') || !/^[\w:-]{10,80}$/.test(id)) return res.status(400).json({ error: 'Permintaan tidak valid.' })
      await (await col('notif')).updateOne({ _id: id, uid: u._id }, { $set: { seen: true } })
    }
    const unread = await (await col('notif')).countDocuments({ uid: u._id, seen: false })
    res.json({ ok: true, unread })
  }))
}
