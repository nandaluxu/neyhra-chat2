import crypto from 'node:crypto'
import { cleanItems } from './shop.js'
import { dayNum } from './bonus.js'
import { push as notify } from './notify.js'

// ===== Transfer antar-player: kirim Coin dan/atau barang inventaris ke pemain lain =====
// Dipasang ke router auth (lib/auth.js) lewat mountTransfer(). Semua aturan dijaga DI SINI:
//
//   - Gems SENGAJA TIDAK BISA ditransfer: Gems adalah mata uang "premium" yang datangnya dari
//     achievements/referal/klaim harian. Kalau bisa ditransfer, ternak akun baru (10 Gems awal
//     per akun) jadi mesin pengganda saldo. Coin & item inventaris cukup untuk kebutuhan
//     berbagi antar teman. (Kalau suatu saat mau dibuka, tambahkan kind di sini + fee lebih besar.)
//   - Fee TRANSFER.feePct dipotong dari jumlah yang DITERIMA dan dibuang (sink ekonomi):
//     transfer tidak menciptakan coin baru, tapi biayanya menjaga transfer tidak jadi jalur
//     utama gerakan saldo (yang justru membuat robbery/trade/market bermakna).
//   - Anti ternak akun: akun pengirim harus berumur minimal TRUST_HOURS jam (createdAt).
//     Akun baru juga hanya punya 150 coin; batas min transfer 100 coin + fee membuatnya
//     tidak menguntungkan. Daily cap membatasi volume per hari.
//   - Atomic & idempotent seperti lib/economy.js: idem (econ_txn) + satu findOneAndUpdate
//     ber-syarat saldo untuk potong pengirim; penambahan ke penerima divalidasi batas inv
//     (maks 999 per barang). Kalau penerima penuh, potongan pengirim dikembalikan (kompensasi).
//   - Riwayat: econ_log untuk KEDUA pihak (kind 'transfer-out' / 'transfer-in') + notifikasi
//     masuk ke kedua pihak.
//
// Endpoint (POST, token Bearer):
//   /api/auth/transfer        -> { ok, rates, coins, gems, inv, hist, daily:{...} }  (ringkasan + batas)
//   /api/auth/transfer/send  -> { ok, to, coins, inv, fee, daily }  body { to: username, coins, items: {id:n}, idem }
//
// Field baru di `users`: TIDAK ADA (saldo tetap coins/inv; hitungan daily dibaca dari econ_log hari ini).

// ===== Angka transfer diatur di sini =====
export const TRANSFER = {
  feePct: 0.05,          // 5% dipotong dari penerima (dibuang = sink)
  minCoin: 100,          // minimal transfer coin (agar akun baru 150 coin tidak layak ternak)
  maxCoin: 100_000,      // maksimal coin per transfer
  dayCoin: 100_000,      // maksimal total coin keluar per hari (WIB)
  dayItem: 200,          // maksimal total item keluar per hari
  maxKinds: 8            // maksimal jenis barang berbeda per transfer
}
// Umur akun minimal untuk aksi ekonomi keluar (transfer/trade/market/rob). Default 24 jam;
// bisa diubah lewat env ECON_TRUST_HOURS (0 = matikan) tanpa deploy ulang.
const TRUST_MS = (() => { const h = parseFloat(process.env.ECON_TRUST_HOURS); return Number.isFinite(h) ? h * 3600e3 : 24 * 3600e3 })()
export const trustOk = u => TRUST_MS <= 0 || (u.createdAt?.getTime?.() || 0) <= Date.now() - TRUST_MS

const WIB = 7 * 3600e3, DAY = 86400e3
const IDEM_RE = /^[\w-]{8,64}$/
const doc = r => (r && r.value !== undefined ? r.value : r)
const nf = n => Math.round(n).toLocaleString('id-ID')

// Berapa coin yang benar-benar sampai ke penerima (fee dipotong dari penerima, dibuang).
export const netFor = coins => { const c = Math.max(0, Math.floor(coins)); return { fee: Math.floor(c * TRANSFER.feePct), net: c - Math.floor(c * TRANSFER.feePct) } }

// Riwayat transaksi (pola log() di lib/economy.js: kegagalan pencatatan tidak menggagalkan transaksi).
// `items` (jumlah barang keluar) hanya dipakai kind transfer-out untuk batas harian.
async function log(col, uid, kind, txt, d) {
  try {
    await (await col('econ_log')).insertOne({
      _id: `${uid}:${Date.now().toString(36)}:${crypto.randomBytes(4).toString('hex')}`,
      uid, kind, txt, coins: d?.coins ?? 0, gems: d?.gems ?? 0, tickets: d?.tickets ?? 0, chips: d?.chips ?? 0, items: d?.items ?? 0, at: new Date()
    })
  } catch { }
}

// Idempotency (pola onceOnly di lib/economy.js): sekali konfirmasi = sekali proses
async function onceOnly(col, uid, idem) {
  if (!idem) return true
  try { await (await col('econ_txn')).insertOne({ _id: `${uid}:${idem}`, uid, at: new Date() }); return true }
  catch (e) { if (e?.code === 11000) return false; throw e }
}
const unIdem = (col, uid, idem) => idem ? col('econ_txn').then(c => c.deleteOne({ _id: `${uid}:${idem}` })).catch(() => { }) : null

export function mountTransfer(router, { wrap, userFromReq, allow, col, ensureWallet }) {
  const need = async (req, res) => {
    const a = await userFromReq(req)
    if (!a) { res.status(401).json({ error: 'Sesi berakhir, masuk lagi.' }); return null }
    return a.user
  }
  const invOf = u => Object.fromEntries(Object.keys(u.inv || {}).map(id => [id, Math.max(0, Math.min(999, Math.floor(Number(u.inv[id]) || 0)))]))
  const startOfDay = () => (dayNum(Date.now()) * DAY) - WIB

  // total coin/item keluar hari ini (WIB) milik uid, dari econ_log kind transfer-out (field items = jumlah barang;
  // coins di log selalu NEGATIF untuk transfer-out -> pakai nilai mutlaknya)
  const outToday = async uid => {
    const rows = await (await col('econ_log')).find({ uid, kind: 'transfer-out', at: { $gte: new Date(startOfDay()) } }, { projection: { coins: 1, items: 1 } }).toArray()
    return { coins: rows.reduce((s, r) => s + Math.abs(r.coins || 0), 0), items: rows.reduce((s, r) => s + Math.max(0, r.items || 0), 0) }
  }

  async function view(u, extra) {
    const w = await ensureWallet(u)
    const used = await outToday(u._id)
    return {
      ok: true,
      rates: { feePct: TRANSFER.feePct, minCoin: TRANSFER.minCoin, maxCoin: TRANSFER.maxCoin, dayCoin: TRANSFER.dayCoin, dayItem: TRANSFER.dayItem, maxKinds: TRANSFER.maxKinds, trustHours: Math.round(TRUST_MS / 3600e3) },
      trust: trustOk(u),
      coins: u.coins ?? w.coins, gems: u.gems ?? w.gems, inv: invOf(u),
      daily: { coins: used.coins, coinLeft: Math.max(0, TRANSFER.dayCoin - used.coins), items: used.items, itemLeft: Math.max(0, TRANSFER.dayItem - used.items) },
      ...extra
    }
  }

  // ---- Ringkasan + batas (dipakai layar Transfer) ----
  router.post('/api/auth/transfer', wrap(async (req, res) => {
    const u = await need(req, res); if (!u) return
    if (!(await allow('trf:' + u._id, 60, 60))) return res.status(429).json({ error: 'Terlalu sering, tunggu sebentar.' })
    res.json(await view(u))
  }))

  // ---- Kirim transfer ----
  router.post('/api/auth/transfer/send', wrap(async (req, res) => {
    const u = await need(req, res); if (!u) return
    if (!(await allow('trfs:' + u._id, 10, 60))) return res.status(429).json({ error: 'Terlalu sering, tunggu sebentar.' })
    const users = await col('users')

    const to = String(req.body?.to || '').trim().toLowerCase()
    const coins = Math.floor(Number(req.body?.coins ?? 0)) // coin boleh tidak dikirim (transfer murni barang)
    const rawItems = req.body?.items
    const list = rawItems == null ? [] : cleanItems(rawItems, true) // barang toko + cincin gacha boleh ditransfer (hadiah antar teman)
    if (rawItems != null && !list) return res.status(400).json({ error: 'Isi barang yang valid (id dan jumlahnya).' })
    const idem = IDEM_RE.test(String(req.body?.idem || '')) ? String(req.body.idem) : null

    // validasi bentuk
    if (!to) return res.status(400).json({ error: 'Isi username penerima.' })
    if (!Number.isFinite(coins) || coins < 0) return res.status(400).json({ error: 'Jumlah coin tidak valid.' })
    if (coins > 0 && coins < TRANSFER.minCoin) return res.status(400).json({ error: `Transfer coin minimal ${nf(TRANSFER.minCoin)}.` })
    if (coins > TRANSFER.maxCoin) return res.status(400).json({ error: `Transfer coin maksimal ${nf(TRANSFER.maxCoin)}.` })
    if (list && list.length > TRANSFER.maxKinds) return res.status(400).json({ error: `Maksimal ${TRANSFER.maxKinds} jenis barang per transfer.` })
    if ((!list || list.length === 0) && coins === 0) return res.status(400).json({ error: 'Transfer kosong: isi coin atau barang.' })

    // cari penerima (username sudah lowercase di koleksi)
    const t = await users.findOne({ username: to })
    if (!t) return res.status(404).json({ error: 'Penerima tidak ditemukan.' })
    if (String(t._id) === String(u._id)) return res.status(400).json({ error: 'Tidak bisa transfer ke diri sendiri.' })
    await ensureWallet(t)

    // anti ternak akun: pengirim harus akun terpercaya
    if (!trustOk(u)) return res.status(403).json({ error: `Aksi ekonomi antar-player butuh akun berumur minimal ${Math.round(TRUST_MS / 3600e3)} jam (anti akun cadangan).` })

    // batas harian (WIB) sebelum idem dipasang
    const used = await outToday(u._id)
    if (used.coins + coins > TRANSFER.dayCoin) return res.status(429).json({ error: `Batas harian transfer coin ${nf(TRANSFER.dayCoin)} (sisa ${nf(Math.max(0, TRANSFER.dayCoin - used.coins))}).` })
    const itemCount = list ? list.reduce((s, x) => s + x.n, 0) : 0
    if (used.items + itemCount > TRANSFER.dayItem) return res.status(429).json({ error: `Batas harian transfer barang ${TRANSFER.dayItem} item.` })

    const { fee, net } = netFor(coins)
    const fromName = u.name || u.username, toName = t.name || t.username
    const listTxt = list ? list.map(({ item, n }) => `${n} ${item.name}`).join(', ') : ''
    const txt = `Transfer ke ${toName}` + (coins ? `: ${nf(coins)} Coin` : '') + (listTxt ? (coins ? ' + ' : ': ') + listTxt : '')

    if (!(await onceOnly(col, u._id, idem))) return res.status(409).json({ error: 'Transfer ini sudah diproses.' })
    await ensureWallet(u)

    // 1) potong pengirim: SATU update atomik ber-syarat saldo/stok (pola lib/shop.js)
    const filter = { _id: u._id }, inc = {}
    if (coins > 0) { filter.coins = { $gte: coins }; inc.coins = -coins }
    for (const { item, n } of list || []) { filter['inv.' + item.id] = { $gte: n }; inc['inv.' + item.id] = -n }
    const nu = doc(await users.findOneAndUpdate(filter, { $inc: inc }, { returnDocument: 'after' }))
    if (!nu) {
      await unIdem(col, u._id, idem)
      const cur = (await users.findOne({ _id: u._id })) || u
      const poor = coins > 0 && (cur.coins ?? 0) < coins
      const lack = (list || []).find(({ item, n }) => (Number(cur.inv?.[item.id]) || 0) < n)
      return res.status(409).json({ ...(await view(cur)), ok: false, error: poor ? 'Coin kamu belum cukup.' : lack ? `Stok ${lack.item.name} kamu belum cukup.` : 'Transfer gagal, coba lagi.' })
    }

    // 2) tambahkan ke penerima: coin bersih + barang (batas simpanan 999 per barang dijaga di filter).
    //    Gagal (simpanan penuh) -> kembalikan potongan pengirim (kompensasi), idem dibebaskan.
    const rfilter = { _id: t._id }, rinc = { coins: net }
    for (const { item, n } of list || []) { rfilter['inv.' + item.id] = { $not: { $gt: 999 - n } }; rinc['inv.' + item.id] = n }
    const rt = doc(await users.findOneAndUpdate(rfilter, { $inc: rinc }, { returnDocument: 'after' }))
    if (!rt) {
      const back = {}
      if (coins > 0) back.coins = coins
      for (const { item, n } of list || []) back['inv.' + item.id] = n
      await users.updateOne({ _id: u._id }, { $inc: back }).catch(() => { })
      await unIdem(col, u._id, idem)
      return res.status(409).json({ ...(await view(nu)), ok: false, error: `Simpanan ${toName} penuh (maks 999 per barang). Transfer dibatalkan.` })
    }

    // 3) catat + notifikasi kedua pihak (best-effort)
    await log(col, u._id, 'transfer-out', txt, { coins: -coins, items: itemCount })
    await log(col, t._id, 'transfer-in', `Transfer dari ${fromName}` + (coins ? `: ${nf(net)} Coin` + (fee ? ` (fee ${nf(fee)})` : '') : '') + (listTxt ? (coins ? ' + ' : ': ') + listTxt : ''), { coins: net, items: itemCount })
    await notify(col, t._id, 'transfer-in', `${fromName} mengirim transfer` + (coins ? ` ${nf(net)} Coin` : '') + (listTxt ? (coins ? ' + ' : ' ') + listTxt : ''), { u: fromName })
    await notify(col, u._id, 'transfer-out', `Transfer ke ${toName} terkirim` + (coins ? ` (${nf(coins)} Coin)` : '') + (listTxt ? ' + barang' : ''))

    res.json(await view(nu, { done: { to: toName, coins, fee, net, items: (list || []).map(({ item, n }) => ({ id: item.id, n })) } }))
  }))
}
