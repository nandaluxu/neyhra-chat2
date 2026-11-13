import crypto from 'node:crypto'
import { cleanItems, ITEMS } from './shop.js'
import { GACHA } from './economy.js'
import { push as notify } from './notify.js'
import { trustOk } from './transfer.js'

// ===== Trading antar-player: tawarkan barang+coin, terima barang+coin (dua pihak harus setuju) =====
// Dipasang ke router auth (lib/auth.js) lewat mountTrade(). Berbeda dari transfer (langsung kirim),
// trade = penawaran yang harus DITERIMA pemain kedua. Barang/coin TIDAK ditahan saat membuat penawaran;
// barang di-escrow (dipotong dari kedua pemain) SAAT penawaran diterima, lalu saling dikirim.
//
// Urutan accept (kompensasi bertingkat, tanpa transaksi multi-dokumen — pola konsisten dengan
// lib/referral di bonus.js, atomik per dokumen dengan syarat di filter):
//   1. Kunci trade: findOneAndUpdate {status:'pending'} -> 'lock' (dobel-accept/cancel hanya satu lolos)
//   2. Potong PENAWAR (offer: items+coins) dengan guard stok/saldo. Gagal -> status kembali 'pending'.
//   3. Potong PENERIMA (want: items+coins) dengan guard stok/saldo. Gagal -> penawar dikembalikan
//      penuh (kompensasi), status kembali 'pending' (dia boleh top-up lalu accept ulang).
//   4. Kirim masing-masing ke lawannya ($inc + guard batas simpanan 999). Gagal batas simpanan ->
//      semua dikembalikan ke kedua pemain (kompensasi penuh), status 'pending' lagi.
//   5. Tandai 'done'. Kegagalan langkah 5 (koneksi terputus) hanya meninggalkan status 'lock':
//      layar trade menandainya "sedang diproses" dan bisa dilaporkan — langkah 4 sudah tuntas.
//
// Anti-abuse:
//   - Akun penawar & penerima harus berumur (trust, anti ternak akun).
//   - Maks TRADE.pendingMax penawaran aktif per pemain, TRADE.rateMax pembuatan/jam, exp otomatis.
//   - Stok di-revalidasi saat accept (barang yang sudah dihabiskan/dipindahtangankan -> penawaran
//     gagal dengan pesan jelas, tidak bisa "jual barang yang sudah tidak dimiliki").
//   - Coin per sisi 0..TRADE.maxCoin (boleh trade murni barang <-> barang).
//   - Cincin gacha boleh masuk trade (hadiah antar teman, sama seperti transfer).
//
// Koleksi trades (TTL 180 hari, riwayat):
//   { _id: uuid, from, fromU, to, toU, offer {coins, items:{}}, want {coins, items:{}},
//     status 'pending'|'lock'|'done'|'cancel'|'expire', createdAt, expAt, doneAt?, seenAt? }
//
// Endpoint (POST, token Bearer):
//   /api/auth/trade          -> { ok, incoming, outgoing, done, rates }            halaman trade saya
//   /api/auth/trade/create   -> { ok, trade }   body { to, offer:{coins, items}, want:{coins, items}, idem }
//   /api/auth/trade/accept   -> { ok, trade }   body { id }                        (hanya penerima)
//   /api/auth/trade/cancel   -> { ok }          body { id }                        (hanya penawar)
//
// Field baru di `users`: TIDAK ADA (semua state di koleksi trades).

// ===== Angka trading diatur di sini =====
export const TRADE = {
  maxCoin: 50_000,      // maksimal coin per sisi per trade
  maxKinds: 8,           // maksimal jenis barang berbeda per sisi
  expHours: 48,         // penawaran hangus otomatis kalau tidak diterima
  pendingMax: 5,        // maksimal penawaran aktif (sebagai penawar) saat bersamaan
  rateMax: 10           // maksimal pembuatan penawaran per jam
}

const TTL_DAYS = 180, PAGE = 20
const IDEM_RE = /^[\w-]{8,64}$/
const doc = r => (r && r.value !== undefined ? r.value : r)
const nf = n => Math.round(n).toLocaleString('id-ID')
// pool barang untuk teks & pemetaan id -> definisi (barang toko + cincin gacha); id trade sudah tervalidasi saat create
const POOL = new Map([...ITEMS, ...GACHA.rings].map(i => [i.id, i]))

async function log(col, uid, kind, txt, d) {
  try {
    await (await col('econ_log')).insertOne({
      _id: `${uid}:${Date.now().toString(36)}:${crypto.randomBytes(4).toString('hex')}`,
      uid, kind, txt, coins: d?.coins ?? 0, gems: 0, tickets: 0, chips: 0, items: d?.items ?? 0, at: new Date()
    })
  } catch { }
}

// Hapus penawaran yang menyebut akun yang dihapus (penerima yang sedang menunggu akan melihat "hangus")
export async function purgeTrade(col, userId) {
  await (await col('trades')).deleteMany({ $or: [{ from: userId }, { to: userId }] })
}

export function mountTrade(router, { wrap, userFromReq, allow, col, ensureWallet }) {
  let ready
  const init = () => ready ??= (async () => {
    const c = await col('trades')
    await c.createIndex({ to: 1, status: 1, createdAt: -1 }); await c.createIndex({ from: 1, status: 1, createdAt: -1 }); await c.createIndex({ at: 1 }, { expireAfterSeconds: TTL_DAYS * 86400 })
  })().catch(e => { ready = null; throw e })
  const need = async (req, res) => {
    const a = await userFromReq(req)
    if (!a) { res.status(401).json({ error: 'Sesi berakhir, masuk lagi.' }); return null }
    return a.user
  }
  const usersCol = () => col('users')

  async function onceOnly(uid, idem) {
    if (!idem) return true
    try { await (await col('econ_txn')).insertOne({ _id: `${uid}:${idem}`, uid, at: new Date() }); return true }
    catch (e) { if (e?.code === 11000) return false; throw e }
  }
  const unIdem = (uid, idem) => idem ? col('econ_txn').then(c => c.deleteOne({ _id: `${uid}:${idem}` })).catch(() => { }) : null

  // bentuk sisi trade: { coins >= 0, items valid }. null kalau tidak sah. coins boleh tidak dikirim (murni barang).
  const side = raw => {
    const coins = Math.floor(Number(raw?.coins ?? 0))
    if (!Number.isFinite(coins) || coins < 0 || coins > TRADE.maxCoin) return null
    const list = cleanItems(raw?.items, true) // cincin boleh
    if (list && list.length > TRADE.maxKinds) return null
    if (!list && raw?.items != null) return null // bentuk items tidak dikenal
    return { coins, items: list || [], itemCount: (list || []).reduce((s, x) => s + x.n, 0) }
  }
  // sisi tersimpan di dokumen trade ({coins, items:[{id,n}]}) -> bentuk kerja {coins, items:[{item,n}]}
  const of = s => ({ coins: s.coins || 0, items: (s.items || []).map(x => ({ item: POOL.get(x.id), n: x.n })).filter(x => x.item), itemCount: (s.items || []).reduce((t, x) => t + x.n, 0) })
  const sideTxt = s => (s.coins ? nf(s.coins) + ' Coin' : '') + (s.items.length ? (s.coins ? ' + ' : '') + s.items.map(({ item, n }) => `${n} ${item.name}`).join(', ') : '') || 'kosong'

  // potong SATU pemain untuk satu sisi (offer=apa yang dia bayarkan), guard stok/saldo -> null kalau kurang
  const debit = async (uid, s) => {
    const filter = { _id: uid }, inc = {}
    if (s.coins > 0) { filter.coins = { $gte: s.coins }; inc.coins = -s.coins }
    for (const { item, n } of s.items) { filter['inv.' + item.id] = { $gte: n }; inc['inv.' + item.id] = -n }
    return doc(await (await usersCol()).findOneAndUpdate(filter, { $inc: inc }, { returnDocument: 'after' }))
  }
  // kirim SATU pemain hasil sisi lawan (masuk inv dengan batas 999), null kalau penuh
  const credit = async (uid, s) => {
    const filter = { _id: uid }, inc = { coins: s.coins }
    for (const { item, n } of s.items) { filter['inv.' + item.id] = { $not: { $gt: 999 - n } }; inc['inv.' + item.id] = n }
    return doc(await (await usersCol()).findOneAndUpdate(filter, { $inc: inc }, { returnDocument: 'after' }))
  }
  // kembalikan potongan (kompensasi) — $inc balik, tidak butuh guard
  const refund = (uid, s) => usersCol().then(c => c.updateOne({ _id: uid }, { $inc: { ...(s.coins ? { coins: s.coins } : {}), ...Object.fromEntries(s.items.map(({ item, n }) => ['inv.' + item.id, n])) } })).catch(() => { })

  // tampilan publik satu trade
  const pub = t => ({ id: t._id, from: t.fromU, to: t.toU, offer: { coins: t.offer.coins, items: t.offer.items }, want: { coins: t.want.coins, items: t.want.items }, status: t.status, createdAt: t.createdAt, expAt: t.expAt, doneAt: t.doneAt || null })

  // tandai hangus penawaran kedaluwarsa milik uid (lazy) -> hitung ulang daftar
  async function expireMine(uid) {
    await (await col('trades')).updateMany({ from: uid, status: 'pending', expAt: { $lt: new Date() } }, { $set: { status: 'expire' } })
    await (await col('trades')).updateMany({ to: uid, status: 'pending', expAt: { $lt: new Date() } }, { $set: { status: 'expire' } })
  }

  // ---- Halaman trade saya ----
  router.post('/api/auth/trade', wrap(async (req, res) => {
    const u = await need(req, res); if (!u) return
    if (!(await allow('trd:' + u._id, 60, 60))) return res.status(429).json({ error: 'Terlalu sering, tunggu sebentar.' })
    await init()
    await expireMine(u._id)
    const all = await (await col('trades')).find({ $or: [{ from: u._id }, { to: u._id }] }).sort({ createdAt: -1 }).limit(PAGE * 3).toArray()
    const pending = all.filter(t => t.status === 'pending' || t.status === 'lock')
    const invOf = x => Object.fromEntries(Object.keys(x.inv || {}).map(id => [id, Math.max(0, Math.min(999, Math.floor(Number(x.inv[id]) || 0)))]))
    res.json({
      ok: true,
      rates: { ...TRADE },
      trust: trustOk(u),
      coins: u.coins, gems: u.gems, inv: invOf(u),
      incoming: pending.filter(t => t.to === u._id).map(pub),
      outgoing: pending.filter(t => t.from === u._id).map(pub),
      done: all.filter(t => t.status !== 'pending' && t.status !== 'lock').slice(0, PAGE).map(pub)
    })
  }))

  // ---- Buat penawaran ----
  router.post('/api/auth/trade/create', wrap(async (req, res) => {
    const u = await need(req, res); if (!u) return
    if (!(await allow('trdc:' + u._id, TRADE.rateMax, 3600))) return res.status(429).json({ error: `Maksimal ${TRADE.rateMax} penawaran baru per jam.` })
    await init()
    const usersC = await usersCol()
    const to = String(req.body?.to || '').trim().toLowerCase()
    const offer = side(req.body?.offer), want = side(req.body?.want)
    const idem = IDEM_RE.test(String(req.body?.idem || '')) ? String(req.body.idem) : null
    if (!to) return res.status(400).json({ error: 'Isi username pemain tujuan.' })
    if (!offer || !want) return res.status(400).json({ error: `Isi penawaran dengan benar (coin maksimal ${nf(TRADE.maxCoin)}, maks ${TRADE.maxKinds} jenis barang per sisi).` })
    if (offer.coins === 0 && offer.itemCount === 0 && want.coins === 0 && want.itemCount === 0) return res.status(400).json({ error: 'Penawaran kosong di kedua sisi.' })

    const t = await (await usersC).findOne({ username: to })
    if (!t) return res.status(404).json({ error: 'Pemain tujuan tidak ditemukan.' })
    if (String(t._id) === String(u._id)) return res.status(400).json({ error: 'Tidak bisa trade dengan diri sendiri.' })
    if (!trustOk(u) || !trustOk(t)) return res.status(403).json({ error: 'Kedua akun harus berumur cukup (anti akun cadangan).' })
    await ensureWallet(u); await ensureWallet(t)

    // stok PENAWAR dicek saat membuat (cepat menolak): yang sebenarnya dijaga lagi saat accept.
    const cur = (await (await usersC).findOne({ _id: u._id })) || u
    if (offer.coins > 0 && (cur.coins ?? 0) < offer.coins) return res.status(409).json({ error: 'Coin kamu untuk penawaran ini belum cukup.' })
    const lack = offer.items.find(({ item, n }) => (Number(cur.inv?.[item.id]) || 0) < n)
    if (lack) return res.status(409).json({ error: `Stok ${lack.item.name} kamu belum cukup untuk penawaran ini.` })

    // batas penawaran aktif
    const active = await (await col('trades')).countDocuments({ from: u._id, status: { $in: ['pending', 'lock'] } })
    if (active >= TRADE.pendingMax) return res.status(429).json({ error: `Maksimal ${TRADE.pendingMax} penawaran aktif. Selesaikan/batalkan dulu.` })

    if (!(await onceOnly(u._id, idem))) return res.status(409).json({ error: 'Penawaran ini sudah diproses.' })
    const myName = u.name || u.username, tName = t.name || t.username
    const tr = {
      _id: crypto.randomUUID(), from: u._id, fromU: myName, to: t._id, toU: tName,
      offer: { coins: offer.coins, items: offer.items.map(({ item, n }) => ({ id: item.id, n })) },
      want: { coins: want.coins, items: want.items.map(({ item, n }) => ({ id: item.id, n })) },
      status: 'pending', createdAt: new Date(), expAt: new Date(Date.now() + TRADE.expHours * 3600e3)
    }
    try { await (await col('trades')).insertOne(tr) }
    catch (e) { await unIdem(u._id, idem); throw e }
    await notify(col, t._id, 'trade', `${myName} menawarkan trade: ${sideTxt(offer)} <> ${sideTxt(want)}.`, { u: myName })
    res.json({ ok: true, trade: pub(tr) })
  }))

  // ---- Terima penawaran (hanya penerima; escrow + saling kirim dengan kompensasi penuh) ----
  router.post('/api/auth/trade/accept', wrap(async (req, res) => {
    const u = await need(req, res); if (!u) return
    if (!(await allow('trda:' + u._id, 12, 60))) return res.status(429).json({ error: 'Terlalu sering, tunggu sebentar.' })
    await init()
    const id = String(req.body?.id || '')
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) return res.status(400).json({ error: 'Permintaan tidak valid.' })
    await ensureWallet(u)

    // 1) kunci trade: pending -> lock (dobel accept/cancel hanya satu yang lolos; kedaluwarsa juga ditolak)
    const tr = doc(await (await col('trades')).findOneAndUpdate(
      { _id: id, status: 'pending', to: u._id, expAt: { $gt: new Date() } },
      { $set: { status: 'lock' } },
      { returnDocument: 'after' }
    ))
    if (!tr) {
      const old = await (await col('trades')).findOne({ _id: id })
      return res.status(409).json({ error: old && old.to === u._id ? (old.status === 'pending' ? 'Penawaran sudah hangus (lewat ' + TRADE.expHours + ' jam).' : `Penawaran sudah ${old.status === 'lock' ? 'sedang diproses' : old.status === 'done' ? 'selesai' : 'dibatalkan'}.`) : 'Penawaran tidak ditemukan.' })
    }
    const back2pending = () => col('trades').then(c => c.updateOne({ _id: id, status: 'lock' }, { $set: { status: 'pending' } })).catch(() => { })

    // sisi-sisi untuk dipotong/dikirim (definisi barang penuh dari POOL)
    const offerS = of(tr.offer), wantS = of(tr.want)

    // 2) potong penawar (offer). Gagal -> status balik pending, penawar disuruh isi ulang stoknya.
    const fromU = doc(await debit(tr.from, offerS))
    if (!fromU) { await back2pending(); return res.status(409).json({ error: 'Penawar tidak lagi punya barang/coin yang ditawarkan. Penawaran dibiarkan menunggu (dia bisa memperbaiki stok).' }) }

    // 3) potong penerima (want). Gagal -> penawar dikembalikan penuh, status balik pending.
    const toU = doc(await debit(u._id, wantS))
    if (!toU) {
      await refund(tr.from, offerS)
      await back2pending()
      return res.status(409).json({ error: 'Barang/coin kamu untuk menerima penawaran ini belum cukup. Penawaran dibiarkan menunggu.' })
    }

    // 4) saling kirim (guard batas simpanan). Gagal penuh -> semua dikembalikan, status balik pending.
    const give1 = doc(await credit(tr.from, wantS))    // penawar menerima want
    const give2 = give1 ? doc(await credit(u._id, offerS)) : null // penerima menerima offer
    if (!give1 || !give2) {
      await refund(tr.from, offerS); await refund(u._id, wantS)
      if (give1) await refund(tr.from, wantS) // give1 berhasil -> want yang sudah masuk dikembalikan
      await back2pending()
      return res.status(409).json({ error: 'Simpanan salah satu pihak penuh (maks 999 per barang). Semua dikembalikan, penawaran menunggu.' })
    }

    // 5) selesai
    const done = doc(await (await col('trades')).findOneAndUpdate({ _id: id, status: 'lock' }, { $set: { status: 'done', doneAt: new Date() } }, { returnDocument: 'after' }))
    const myName = u.name || u.username
    await log(col, u._id, 'trade-in', `Trade dengan ${tr.fromU}: dapat ${sideTxt(offerS)}, bayar ${sideTxt(wantS)}`, { coins: offerS.coins - wantS.coins, items: offerS.itemCount })
    await log(col, tr.from, 'trade-out', `Trade dengan ${myName}: dapat ${sideTxt(wantS)}, bayar ${sideTxt(offerS)}`, { coins: wantS.coins - offerS.coins, items: wantS.itemCount })
    await notify(col, tr.from, 'trade-done', `${myName} MENERIMA penawaranmu: ${sideTxt(offerS)} <> ${sideTxt(wantS)}.`)
    await notify(col, u._id, 'trade-done', `Trade dengan ${tr.fromU} selesai: dapat ${sideTxt(offerS)}, bayar ${sideTxt(wantS)}.`)
    res.json({ ok: true, trade: pub(done || tr), coins: give2.coins, got: sideTxt(offerS), paid: sideTxt(wantS) })
  }))

  // ---- Batalkan penawaran (hanya penawar, hanya yang masih pending) ----
  router.post('/api/auth/trade/cancel', wrap(async (req, res) => {
    const u = await need(req, res); if (!u) return
    if (!(await allow('trdx:' + u._id, 20, 60))) return res.status(429).json({ error: 'Terlalu sering, tunggu sebentar.' })
    await init()
    const id = String(req.body?.id || '')
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) return res.status(400).json({ error: 'Permintaan tidak valid.' })
    const tr = doc(await (await col('trades')).findOneAndUpdate(
      { _id: id, status: 'pending', from: u._id },
      { $set: { status: 'cancel' } },
      { returnDocument: 'after' }
    ))
    if (!tr) return res.status(409).json({ error: 'Penawaran tidak ditemukan atau sudah tidak bisa dibatalkan.' })
    await notify(col, tr.to, 'trade', `${u.name || u.username} membatalkan penawaran trade (${sideTxt(of(tr.offer))} <> ${sideTxt(of(tr.want))}).`)
    res.json({ ok: true })
  }))
}
