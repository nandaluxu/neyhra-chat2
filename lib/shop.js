import { loadChars } from './chars.js'

// Toko + Inventory: beli hadiah pakai coin, lalu berikan ke karakter untuk menaikkan hubungan (EXP).
// Dipasang ke router auth (lib/auth.js) lewat mountShop(), jadi memakai sesi/token, pembatas laju, dan koleksi `users` yang sama dengan bonus & game.
//
// Aturan yang dijaga di server (client cuma menampilkan):
//   - Saldo coin dan isi inventory hanya berubah lewat endpoint ini. Beli = kurangi coin + tambah barang dalam SATU operasi atomik
//     (findOneAndUpdate dengan syarat saldo/stok di filter), jadi dua request bersamaan tidak bisa membelanjakan coin yang sama dua kali
//     dan inventory tidak bisa minus.
//   - Memberi hadiah = kurangi barang (atomik, syarat stok di filter). EXP/mood yang didapat dihitung di sini dari tabel ITEMS dan dikirim balik;
//     client yang menambahkannya ke `rel:<id>` (EXP hubungan memang disimpan di browser, lihat lib/relation.js).
//
// Endpoint (POST, token Bearer, jawaban JSON):
//   /api/auth/shop        -> { ok, items, inv, max, coins, gems }
//   /api/auth/shop/buy    -> { ok, ... }              body { items: { bunga: 2, coklat: 1 } }
//   /api/auth/shop/gift   -> { ok, exp, mood, gift, ... }   body { char, items: { ... } }  (beberapa jenis & jumlah sekaligus)
//
// Field baru di `users`:  inv  { <idBarang>: jumlah }   (dibuat otomatis saat pertama beli)

// ===== Atur barang di sini =====
//   price = harga (coin) | exp = tambahan EXP hubungan per 1 barang | mood = tambahan mood per 1 barang
//   say   = kata benda di kalimat roleplay ("2 bunga")
// Kurva EXP ada di lib/relation.js (Lv 1->6 = 170 EXP, Lv 1->30 = 2.030). Rasio sekarang ±0,4 EXP per coin: dengan penghasilan coin dari minigame,
// hadiah setara dengan batas EXP harian obrolan (DAILY_CAP) dan tidak bisa dipakai untuk melompati hubungan.
export const ITEMS = [
  { id: 'bunga',  name: 'Bunga',  price: 75,  exp: 30, mood: 3, say: 'bunga',  desc: 'Setangkai bunga manis untuk membuka hati.' },
  { id: 'coklat', name: 'Coklat', price: 120, exp: 50, mood: 5, say: 'coklat', desc: 'Coklat enak, selalu jadi hadiah favorit.' },
  { id: 'eskrim', name: 'Eskrim', price: 125, exp: 53, mood: 5, say: 'eskrim', desc: 'Eskrim dingin yang bikin hari jadi cerah.' }
]
export const LIMITS = { qty: 99, inv: 999, mood: 15 } // qty = maks per jenis per transaksi, inv = maks simpanan per jenis, mood = maks tambahan mood per hadiah
const BY_ID = new Map(ITEMS.map(i => [i.id, i]))
const pub = i => ({ id: i.id, name: i.name, price: i.price, exp: i.exp, mood: i.mood, desc: i.desc })

// { id: n } atau [{id, n}] -> [{ item, n }] yang pasti valid, atau null kalau ada yang tidak sah / kosong
export function cleanItems(raw) {
  const pairs = Array.isArray(raw) ? raw.map(x => [x?.id, x?.n]) : raw && typeof raw === 'object' ? Object.entries(raw) : null
  if (!pairs || pairs.length === 0 || pairs.length > ITEMS.length) return null
  const seen = new Set(), out = []
  for (const [id, n] of pairs) {
    const item = BY_ID.get(id)
    if (!item || seen.has(id) || !Number.isInteger(n) || n < 1 || n > LIMITS.qty) return null
    seen.add(id); out.push({ item, n })
  }
  return out
}
const sentence = list => list.map(({ item, n }) => `${n} ${item.say}`).join(', ').replace(/, ([^,]*)$/, ' dan $1')

// Satu kalimat kejadian untuk AI (dipakai /api/chat). null = bukan hadiah yang sah (bentuk dicek ulang di sini, bukan dipercaya dari client).
export function giftLine(raw) {
  const list = cleanItems(raw?.items)
  if (!list) return null
  return `[Kejadian: user memberikan hadiah kepadamu: ${sentence(list)}. Tanggapi sebagai dirimu sendiri sesuai kepribadian dan tahap hubungan kalian (jangan lebih akrab daripada tahap hubungan saat ini). Beri reaksi natural: terima kasih, malu, gengsi, atau senang sesuai wataknya, sebut hadiahnya, 1-3 kalimat saja.]`
}

export function mountShop(router, { wrap, userFromReq, allow, col, ensureWallet }) {
  const doc = r => (r && r.value !== undefined ? r.value : r) // findOneAndUpdate: driver baru mengembalikan dokumen, driver lama { value }
  const need = async (req, res) => {
    const a = await userFromReq(req)
    if (!a) { res.status(401).json({ error: 'Sesi berakhir, masuk lagi.' }); return null }
    return a.user
  }
  const invOf = u => Object.fromEntries(ITEMS.map(i => [i.id, Math.max(0, Math.min(LIMITS.inv, Math.floor(Number(u.inv?.[i.id]) || 0)))]))
  async function view(u, extra) {
    const w = await ensureWallet(u)
    return { ok: true, items: ITEMS.map(pub), inv: invOf(u), max: { qty: LIMITS.qty, inv: LIMITS.inv }, coins: u.coins ?? w.coins, gems: u.gems ?? w.gems, ...extra }
  }
  const limited = (res, ok) => ok || (res.status(429).json({ error: 'Terlalu sering, tunggu sebentar.' }), false)

  router.post('/api/auth/shop', wrap(async (req, res) => {
    const u = await need(req, res); if (!u) return
    if (!limited(res, await allow('sh:' + u._id, 60, 60))) return
    res.json(await view(u))
  }))

  router.post('/api/auth/shop/buy', wrap(async (req, res) => {
    const u = await need(req, res); if (!u) return
    if (!limited(res, await allow('shb:' + u._id, 30, 60))) return
    const list = cleanItems(req.body?.items)
    if (!list) return res.status(400).json({ error: `Pilih barang dan jumlahnya (1-${LIMITS.qty}).` })
    const total = list.reduce((s, { item, n }) => s + item.price * n, 0)
    await ensureWallet(u) // akun lama tanpa saldo: isi saldo awal dulu supaya $inc tidak menggantikannya
    const users = await col('users')
    const filter = { _id: u._id, coins: { $gte: total } }, inc = { coins: -total }
    for (const { item, n } of list) { filter['inv.' + item.id] = { $not: { $gt: LIMITS.inv - n } }; inc['inv.' + item.id] = n } // $not/$gt: juga cocok kalau barangnya belum pernah dimiliki
    const nu = doc(await users.findOneAndUpdate(filter, { $inc: inc }, { returnDocument: 'after' }))
    if (!nu) { // gagal: cari tahu kenapa dari data terbaru
      const cur = await users.findOne({ _id: u._id }) || u
      const poor = (cur.coins ?? 0) < total
      return res.status(409).json({ error: poor ? 'Coin kamu belum cukup.' : `Simpanan penuh (maks ${LIMITS.inv} per barang).`, ...(await view(cur)) })
    }
    res.json(await view(nu, { bought: list.map(({ item, n }) => ({ id: item.id, n })), spent: total }))
  }))

  router.post('/api/auth/shop/gift', wrap(async (req, res) => {
    const u = await need(req, res); if (!u) return
    if (!limited(res, await allow('shg:' + u._id, 30, 60))) return
    const list = cleanItems(req.body?.items)
    if (!list) return res.status(400).json({ error: `Pilih barang dan jumlahnya (1-${LIMITS.qty}).` })
    const charId = String(req.body?.char || '')
    if (!(await loadChars()).some(c => c.id === charId)) return res.status(400).json({ error: 'Karakter tidak valid.' })
    const users = await col('users')
    const filter = { _id: u._id }, inc = {}
    for (const { item, n } of list) { filter['inv.' + item.id] = { $gte: n }; inc['inv.' + item.id] = -n }
    const nu = doc(await users.findOneAndUpdate(filter, { $inc: inc }, { returnDocument: 'after' }))
    if (!nu) return res.status(409).json({ error: 'Barangmu tidak cukup.', ...(await view(await users.findOne({ _id: u._id }) || u)) })
    const exp = list.reduce((s, { item, n }) => s + item.exp * n, 0)
    const mood = Math.min(LIMITS.mood, list.reduce((s, { item, n }) => s + item.mood * n, 0))
    res.json(await view(nu, { exp, mood, gift: list.map(({ item, n }) => ({ id: item.id, n })) }))
  }))
}
