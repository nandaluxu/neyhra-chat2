import crypto from 'node:crypto'
import { cleanItems, ITEMS } from './shop.js'
import { GACHA } from './economy.js'
import { push as notify } from './notify.js'
import { trustOk } from './transfer.js'

// ===== Marketplace antar-player: jual barang inventaris dengan harga Coin, pembeli membeli lot penuh =====
// Dipasang ke router auth (lib/auth.js) lewat mountMarket(). Berbeda dari trade (dua pihak menegosiasikan),
// marketplace = harga terbuka siapa pun boleh beli. Barang di-ESCROW saat listing (dipotong dari inventaris
// penjual): tidak bisa "jual barang yang sama dua kali", dan pembeli pasti mendapat barang yang sudah ada.
//
// Alur beli (kompensasi bertingkat, tanpa transaksi multi-dokumen):
//   1. Kunci listing: findOneAndUpdate {status:'listed'} -> 'lock' (dobel-beli/cancel hanya satu lolos)
//   2. Kredit penjual: proceeds = harga - fee (fee dibuang = sink ekonomi). Penjual akunnya bisa saja
//      sudah terhapus -> kredit tidak berdampak (matchedCount 0), listing tetap terjual.
//   3. Pembeli bayar + terima barang dalam SATU update atomik (guard saldo) -> tidak pernah bayar tanpa
//      menerima. Gagal (coin kurang) -> listing kembali 'listed' + kredit penjual dibatalkan (kompensasi).
//   4. Tandai 'sold' + catat pembeli untuk riwayat harga.
//
// Anti-manipulasi & anti-spam:
//   - Harga dibatasi MARKET.minPrice..MARKET.maxPrice per lot; listing dibatasi MARKET.pendingMax aktif
//     dan MARKET.rateMax listing baru per jam. Tidak ada batas harga per barang: harga ditentukan pasar,
//     wash-trading hanya merugikan pelakunya sendiri (fee 5% terbakar tiap transaksi).
//   - Akun penjual harus berumur (trust, anti ternak akun); akun baru tidak bisa jual.
//   - Listing hangus otomatis (MARKET.expHours): barang escrow dikembalikan penjual secara lazy saat
//     listing dibuka/dilihat penjualnya.
//
// Koleksi market (TTL 180 hari):
//   { _id: uuid, seller, sellerU, item, qty, price, feePct, status 'listed'|'lock'|'sold'|'cancel'|'expire',
//     createdAt, expAt, soldAt?, buyer?, buyerU? }
//
// Endpoint (POST, token Bearer):
//   /api/auth/market         -> { ok, rates, items, listings, prices, mine, bought }   body { item?: itemId, before? }
//   /api/auth/market/list    -> { ok, listing }   body { item, qty, price, idem }
//   /api/auth/market/buy     -> { ok, listing }   body { id, idem }
//   /api/auth/market/cancel  -> { ok }            body { id }
//
// Field baru di `users`: TIDAK ADA (semua state di koleksi market).

// ===== Angka marketplace diatur di sini =====
export const MARKET = {
  feePct: 0.05,       // 5% dari harga terpotong untuk penjual (dibuang = sink ekonomi)
  minPrice: 20,       // harga minimal per lot
  maxPrice: 100_000,  // harga maksimal per lot
  maxQty: 99,         // jumlah barang per lot (sama dengan batas beli toko)
  expHours: 168,      // listing hangus otomatis kalau tidak terjual (7 hari)
  pendingMax: 20,     // maksimal listing aktif per penjual
  rateMax: 10,        // maksimal listing baru per jam
  listLimit: 50       // listing yang ditampilkan per halaman browse
}

const TTL_DAYS = 180, PAGE = 20
const IDEM_RE = /^[\w-]{8,64}$/
const doc = r => (r && r.value !== undefined ? r.value : r)
const nf = n => Math.round(n).toLocaleString('id-ID')
const POOL = new Map([...ITEMS, ...GACHA.rings].map(i => [i.id, i]))
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

async function log(col, uid, kind, txt, d) {
  try {
    await (await col('econ_log')).insertOne({
      _id: `${uid}:${Date.now().toString(36)}:${crypto.randomBytes(4).toString('hex')}`,
      uid, kind, txt, coins: d?.coins ?? 0, gems: 0, tickets: 0, chips: 0, items: d?.items ?? 0, at: new Date()
    })
  } catch { }
}

// Hapus listing milik akun yang dihapus. Barang escrow ikut terhapus (akunnya sudah tidak ada;
// pembeli yang sedang membeli akan mendapat "listing tidak tersedia").
export async function purgeMarket(col, userId) {
  await (await col('market')).deleteMany({ $or: [{ seller: userId }, { buyer: userId }] })
}

export function mountMarket(router, { wrap, userFromReq, allow, col, ensureWallet }) {
  let ready
  const init = () => ready ??= (async () => {
    const c = await col('market')
    await c.createIndex({ status: 1, createdAt: -1 }); await c.createIndex({ seller: 1, status: 1, createdAt: -1 }); await c.createIndex({ item: 1, status: 1, soldAt: -1 }); await c.createIndex({ at: 1 }, { expireAfterSeconds: TTL_DAYS * 86400 })
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

  const pub = l => ({ id: l._id, seller: l.sellerU, item: l.item, qty: l.qty, price: l.price, fee: Math.floor(l.price * l.feePct), proceeds: l.price - Math.floor(l.price * l.feePct), status: l.status, createdAt: l.createdAt, expAt: l.expAt, ...(l.buyer ? { buyer: l.buyerU, soldAt: l.soldAt } : {}) })
  const itemName = id => POOL.get(id)?.name || id

  // hanguskan listing kedaluwarsa milik penjual (lazy) + kembalikan escrow-nya
  async function expireMine(uid) {
    const c = await col('market')
    const dead = await c.find({ seller: uid, status: 'listed', expAt: { $lt: new Date() } }, { projection: { item: 1, qty: 1 } }).toArray()
    for (const d of dead) {
      const ok = doc(await c.findOneAndUpdate({ _id: d._id, status: 'listed' }, { $set: { status: 'expire' } }, { returnDocument: 'after' }))
      if (ok) await (await usersCol()).updateOne({ _id: uid }, { $inc: { ['inv.' + d.item]: d.qty } }).catch(() => { })
    }
  }

  // ---- Browse + harga + listing saya ----
  router.post('/api/auth/market', wrap(async (req, res) => {
    const u = await need(req, res); if (!u) return
    if (!(await allow('mkt:' + u._id, 60, 60))) return res.status(429).json({ error: 'Terlalu sering, tunggu sebentar.' })
    await init()
    await expireMine(u._id)
    const itemId = POOL.has(String(req.body?.item || '')) ? String(req.body.item) : null
    const now = new Date()
    const [listings, prices, mine, bought] = await Promise.all([
      (await col('market')).find({ status: 'listed', expAt: { $gt: now }, ...(itemId ? { item: itemId } : {}) }).sort({ createdAt: -1 }).limit(MARKET.listLimit).toArray(),
      itemId ? (await col('market')).find({ item: itemId, status: 'sold' }).sort({ soldAt: -1 }).limit(10).toArray() : [],
      (await col('market')).find({ seller: u._id }).sort({ createdAt: -1 }).limit(PAGE).toArray(),
      (await col('market')).find({ buyer: u._id, status: 'sold' }).sort({ soldAt: -1 }).limit(PAGE).toArray()
    ])
    const invOf = x => Object.fromEntries(Object.keys(x.inv || {}).map(id => [id, Math.max(0, Math.min(999, Math.floor(Number(x.inv[id]) || 0)))]))
    res.json({
      ok: true,
      rates: { ...MARKET },
      trust: trustOk(u),
      item: itemId, itemName: itemId ? itemName(itemId) : null,
      items: [...ITEMS, ...GACHA.rings].map(i => ({ id: i.id, name: i.name, price: i.price })), // harga toko sebagai patokan
      coins: u.coins, inv: invOf(u),
      listings: listings.map(pub), prices: prices.map(p => ({ price: p.price, qty: p.qty, at: p.soldAt, seller: p.sellerU })),
      mine: mine.map(pub), bought: bought.map(pub)
    })
  }))

  // ---- Pasang listing (escrow barang saat pasang) ----
  router.post('/api/auth/market/list', wrap(async (req, res) => {
    const u = await need(req, res); if (!u) return
    if (!(await allow('mktl:' + u._id, MARKET.rateMax, 3600))) return res.status(429).json({ error: `Maksimal ${MARKET.rateMax} listing baru per jam.` })
    await init()
    const itemId = String(req.body?.item || '')
    const qty = Math.floor(Number(req.body?.qty))
    const price = Math.floor(Number(req.body?.price))
    const idem = IDEM_RE.test(String(req.body?.idem || '')) ? String(req.body.idem) : null
    if (!POOL.has(itemId) || !Number.isInteger(qty) || qty < 1 || qty > MARKET.maxQty) return res.status(400).json({ error: `Pilih barang dan jumlahnya (1-${MARKET.maxQty}).` })
    if (!Number.isFinite(price) || price < MARKET.minPrice || price > MARKET.maxPrice) return res.status(400).json({ error: `Harga ${nf(MARKET.minPrice)} sampai ${nf(MARKET.maxPrice)} Coin per lot.` })
    if (!trustOk(u)) return res.status(403).json({ error: 'Butuh akun berumur cukup untuk berjualan (anti akun cadangan).' })

    // batas listing aktif
    const active = await (await col('market')).countDocuments({ seller: u._id, status: { $in: ['listed', 'lock'] } })
    if (active >= MARKET.pendingMax) return res.status(429).json({ error: `Maksimal ${MARKET.pendingMax} listing aktif. Batal/hanguskan dulu.` })

    if (!(await onceOnly(u._id, idem))) return res.status(409).json({ error: 'Listing ini sudah diproses.' })

    // escrow: potong barang penjual SEKALIGUS atomik (guard stok di filter)
    const users = await usersCol()
    const escrowed = doc(await users.findOneAndUpdate(
      { _id: u._id, ['inv.' + itemId]: { $gte: qty } },
      { $inc: { ['inv.' + itemId]: -qty } },
      { returnDocument: 'after' }
    ))
    if (!escrowed) {
      await unIdem(u._id, idem)
      return res.status(409).json({ ok: false, error: `Stok ${itemName(itemId)} kamu belum cukup.` })
    }

    const myName = u.name || u.username
    const l = {
      _id: crypto.randomUUID(), seller: u._id, sellerU: myName, item: itemId, qty, price, feePct: MARKET.feePct,
      status: 'listed', createdAt: new Date(), expAt: new Date(Date.now() + MARKET.expHours * 3600e3)
    }
    try { await (await col('market')).insertOne(l) }
    catch (e) { // gagal menyimpan -> kembalikan escrow, bebaskan idem
      await users.updateOne({ _id: u._id }, { $inc: { ['inv.' + itemId]: qty } }).catch(() => { })
      await unIdem(u._id, idem)
      throw e
    }
    res.json({ ok: true, listing: pub(l), inv: escrowed.inv, coins: escrowed.coins })
  }))

  // ---- Beli lot penuh ----
  router.post('/api/auth/market/buy', wrap(async (req, res) => {
    const u = await need(req, res); if (!u) return
    if (!(await allow('mktb:' + u._id, 15, 60))) return res.status(429).json({ error: 'Terlalu sering, tunggu sebentar.' })
    await init()
    const id = String(req.body?.id || '')
    const idem = IDEM_RE.test(String(req.body?.idem || '')) ? String(req.body.idem) : null
    if (!UUID.test(id)) return res.status(400).json({ error: 'Permintaan tidak valid.' })
    if (!(await onceOnly(u._id, idem))) return res.status(409).json({ error: 'Pembelian ini sudah diproses.' })
    await ensureWallet(u)
    const users = await usersCol()
    const mcol = await col('market')

    // 1) kunci listing (dobel-beli/cancel/expiry hanya satu yang lolos)
    const l = doc(await mcol.findOneAndUpdate(
      { _id: id, status: 'listed', expAt: { $gt: new Date() } },
      { $set: { status: 'lock' } },
      { returnDocument: 'after' }
    ))
    if (!l) { await unIdem(u._id, idem); return res.status(409).json({ error: 'Listing sudah terjual, dibatalkan, atau hangus.' }) }
    const relist = () => mcol.updateOne({ _id: id, status: 'lock' }, { $set: { status: 'listed' } }).catch(() => { })

    // tidak bisa beli listing sendiri (harga tidak bisa "dicuci" bolak-balik antar akun sendiri)
    if (String(l.seller) === String(u._id)) { await relist(); await unIdem(u._id, idem); return res.status(400).json({ error: 'Tidak bisa membeli listing milik sendiri.' }) }

    // 2) kredit penjual dulu (proceeds = harga - fee). Penjual terhapus -> update tidak berdampak.
    const fee = Math.floor(l.price * l.feePct), proceeds = l.price - fee
    await users.updateOne({ _id: l.seller }, { $inc: { coins: proceeds } }).catch(() => { })
    const uncredit = () => users.updateOne({ _id: l.seller }, { $inc: { coins: -proceeds } }).catch(() => { })

    // 3) pembeli: bayar + terima barang SATU update atomik (guard saldo + batas simpanan)
    const buyer = doc(await users.findOneAndUpdate(
      { _id: u._id, coins: { $gte: l.price }, ['inv.' + l.item]: { $not: { $gt: 999 - l.qty } } },
      { $inc: { coins: -l.price, ['inv.' + l.item]: l.qty } },
      { returnDocument: 'after' }
    ))
    if (!buyer) {
      await uncredit(); await relist(); await unIdem(u._id, idem)
      const cur = (await users.findOne({ _id: u._id })) || u
      return res.status(409).json({ ok: false, coins: cur.coins, error: (cur.coins ?? 0) < l.price ? 'Coin kamu belum cukup.' : 'Simpananmu penuh untuk barang ini (maks 999).' })
    }

    // 4) selesai + catat
    const done = doc(await mcol.findOneAndUpdate(
      { _id: id, status: 'lock' },
      { $set: { status: 'sold', soldAt: new Date(), buyer: u._id, buyerU: u.name || u.username } },
      { returnDocument: 'after' }
    ))
    const myName = u.name || u.username
    await log(col, u._id, 'market-buy', `Beli ${l.qty} ${itemName(l.item)} dari ${l.sellerU} di market`, { coins: -l.price, items: l.qty })
    await log(col, l.seller, 'market-sell', `Laku: ${l.qty} ${itemName(l.item)} ke ${myName} (terima ${nf(proceeds)} Coin, fee ${nf(fee)})`, { coins: proceeds, items: l.qty })
    await notify(col, l.seller, 'market', `Listingmu LAKU: ${l.qty} ${itemName(l.item)} terjual ${nf(l.price)} Coin ke ${myName} (terima ${nf(proceeds)} Coin setelah fee).`, { u: myName })
    await notify(col, u._id, 'market', `Pembelian market: ${l.qty} ${itemName(l.item)} dari ${l.sellerU} seharga ${nf(l.price)} Coin.`)
    res.json({ ok: true, listing: pub(done || l), coins: buyer.coins, got: { item: l.item, qty: l.qty }, paid: l.price })
  }))

  // ---- Batalkan listing (hanya penawar, hanya yang masih listed) -> escrow kembali ----
  router.post('/api/auth/market/cancel', wrap(async (req, res) => {
    const u = await need(req, res); if (!u) return
    if (!(await allow('mktc:' + u._id, 20, 60))) return res.status(429).json({ error: 'Terlalu sering, tunggu sebentar.' })
    await init()
    const id = String(req.body?.id || '')
    if (!UUID.test(id)) return res.status(400).json({ error: 'Permintaan tidak valid.' })
    const l = doc(await (await col('market')).findOneAndUpdate(
      { _id: id, status: 'listed', seller: u._id },
      { $set: { status: 'cancel' } },
      { returnDocument: 'after' }
    ))
    if (!l) return res.status(409).json({ error: 'Listing tidak ditemukan atau sudah tidak bisa dibatalkan.' })
    await (await usersCol()).updateOne({ _id: u._id }, { $inc: { ['inv.' + l.item]: l.qty } }).catch(() => { })
    res.json({ ok: true })
  }))
}
