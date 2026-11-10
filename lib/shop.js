import { loadChars } from './chars.js'
import { track } from './quests.js'
import { FAVORITES, FAV_MULT, GACHA } from './economy.js'

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
//   cat = kategori (CATS di bawah) | price = harga (coin) | exp = tambahan EXP hubungan per 1 barang
//   mood = tambahan mood per 1 barang | say = kata benda di kalimat roleplay ("2 bunga")
// Kurva EXP ada di lib/relation.js (Lv 1->6 = 170 EXP, Lv 1->30 = 2.030). Rasio sekarang ±0,4 EXP per coin: dengan penghasilan coin dari minigame,
// hadiah setara dengan batas EXP harian obrolan (DAILY_CAP) dan tidak bisa dipakai untuk melompati hubungan.
// Item favorit karakter (bonus EXP/Mood) dikonfigurasi di FAVORITES (lib/economy.js), bukan di sini.
export const CATS = [
  { id: 'food', name: 'Makanan', desc: 'Camilan dan makanan mengenyangkan.' },
  { id: 'drinks', name: 'Minuman', desc: 'Minuman dingin dan hangat.' },
  { id: 'gift', name: 'Hadiah', desc: 'Hadiah klasik untuk membuka hati.' }
]
export const ITEMS = [
  { id: 'macaron', cat: 'food', name: 'Macaron', price: 140, exp: 55, mood: 5, say: 'macaron', desc: 'Macaron manis berwarna-warni, renyah di luar, lembut di dalam.' },
  { id: 'roti', cat: 'food', name: 'Roti', price: 60, exp: 24, mood: 2, say: 'roti', desc: 'Roti hangat yang baru keluar dari oven.' },
  { id: 'hamburger', cat: 'food', name: 'Hamburger', price: 150, exp: 60, mood: 6, say: 'hamburger', desc: 'Hamburger juicy dengan sayuran segar.' },
  { id: 'pancake', cat: 'food', name: 'Pancake', price: 110, exp: 44, mood: 4, say: 'pancake', desc: 'Pancake lembut disiram sirup maple.' },
  { id: 'pisang', cat: 'food', name: 'Pisang', price: 40, exp: 16, mood: 1, say: 'pisang', desc: 'Pisang matang, manis alami dan menyehatkan.' },
  { id: 'apel', cat: 'food', name: 'Apel', price: 50, exp: 20, mood: 2, say: 'apel', desc: 'Apel merah segar, renyah saat digigit.' },
  { id: 'semangka', cat: 'food', name: 'Semangka', price: 65, exp: 26, mood: 3, say: 'semangka', desc: 'Irisan semangka dingin, segar di siang hari.' },
  { id: 'taco', cat: 'food', name: 'Taco', price: 130, exp: 52, mood: 5, say: 'taco', desc: 'Taco renyah berisi daging dan salsa pedas.' },
  { id: 'strawberry', cat: 'food', name: 'Stroberi', price: 90, exp: 36, mood: 4, say: 'stroberi', desc: 'Stroberi manis merah, cocok dibagikan berdua.' },
  { id: 'ceri', cat: 'food', name: 'Ceri', price: 70, exp: 28, mood: 3, say: 'ceri', desc: 'Sepasang ceri manis dengan tangkai hijau.' },
  { id: 'kopi', cat: 'drinks', name: 'Kopi', price: 85, exp: 34, mood: 3, say: 'kopi', desc: 'Kopi hangat untuk menemani ngobrol.' },
  { id: 'bir', cat: 'drinks', name: 'Bir', price: 160, exp: 64, mood: 6, say: 'bir', desc: 'Bir dingin berbusa lembut. Terlalu banyak bikin mabuk.' },
  { id: 'teh', cat: 'drinks', name: 'Teh', price: 80, exp: 32, mood: 3, say: 'teh', desc: 'Teh hangat yang menenangkan.' },
  { id: 'bunga', cat: 'gift', name: 'Bunga', price: 75, exp: 30, mood: 3, say: 'bunga', desc: 'Setangkai bunga manis untuk membuka hati.' },
  { id: 'coklat', cat: 'gift', name: 'Coklat', price: 120, exp: 50, mood: 5, say: 'coklat', desc: 'Coklat enak, selalu jadi hadiah favorit.' },
  { id: 'eskrim', cat: 'gift', name: 'Eskrim', price: 125, exp: 53, mood: 5, say: 'eskrim', desc: 'Eskrim dingin yang bikin hari jadi cerah.' }
]
export const LIMITS = { qty: 99, inv: 999, mood: 15 } // qty = maks per jenis per transaksi, inv = maks simpanan per jenis, mood = maks tambahan mood per hadiah
const BY_ID = new Map(ITEMS.map(i => [i.id, i]))
const pub = i => ({ id: i.id, cat: i.cat, name: i.name, price: i.price, exp: i.exp, mood: i.mood, desc: i.desc })

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
// char (objek karakter) dipakai untuk menandai item favoritnya supaya AI bereaksi lebih senang (FAVORITES di lib/economy.js).
export function giftLine(raw, char) {
  const list = cleanItems(raw?.items)
  if (!list) return null
  const favId = char ? FAVORITES[char.id] : null
  const favHit = favId && list.some(({ item }) => item.id === favId)
  return `[Kejadian: user memberikan hadiah kepadamu: ${sentence(list)}. Tanggapi sebagai dirimu sendiri sesuai kepribadian dan tahap hubungan kalian (jangan lebih akrab daripada tahap hubungan saat ini). Beri reaksi natural: terima kasih, malu, gengsi, atau senang sesuai wataknya, sebut hadiahnya, 1-3 kalimat saja.${favHit ? ' Salah satu hadiah itu adalah barang FAVORITMU, tunjukkan kesenangan yang jelas lebih besar (boleh lebih antusias dari biasanya, tetap sesuai watak).' : ''}]`
}

export function mountShop(router, { wrap, userFromReq, allow, col, ensureWallet }) {
  const doc = r => (r && r.value !== undefined ? r.value : r) // findOneAndUpdate: driver baru mengembalikan dokumen, driver lama { value }
  const need = async (req, res) => {
    const a = await userFromReq(req)
    if (!a) { res.status(401).json({ error: 'Sesi berakhir, masuk lagi.' }); return null }
    return a.user
  }
  const invOf = u => Object.fromEntries([...ITEMS, ...GACHA.rings].map(i => [i.id, Math.max(0, Math.min(LIMITS.inv, Math.floor(Number(u.inv?.[i.id]) || 0)))])) // cincin gacha ikut terhitung (tidak bisa diberikan, hanya dikoleksi)
  async function view(u, extra) {
    const w = await ensureWallet(u)
    return { ok: true, items: ITEMS.map(pub), cats: CATS, rings: GACHA.rings.map(r => ({ id: r.id, name: r.name })), fav: FAVORITES, favMult: FAV_MULT, inv: invOf(u), max: { qty: LIMITS.qty, inv: LIMITS.inv }, coins: u.coins ?? w.coins, gems: u.gems ?? w.gems, tickets: u.tickets ?? w.tickets ?? 0, ...extra }
  }
  const limited = (res, ok) => ok || (res.status(429).json({ error: 'Terlalu sering, tunggu sebentar.' }), false)
  const IDEM_RE = /^[\w-]{8,64}$/ // idempotency (lihat lib/economy.js): sekali konfirmasi = sekali proses
  async function onceOnly(uid, idem) {
    if (!idem) return true
    try { await (await col('econ_txn')).insertOne({ _id: `${uid}:${idem}`, uid, at: new Date() }); return true }
    catch (e) { if (e?.code === 11000) return false; throw e }
  }

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
    const idem = IDEM_RE.test(String(req.body?.idem || '')) ? String(req.body.idem) : null
    if (!(await onceOnly(u._id, idem))) return res.status(409).json({ error: 'Pembelian ini sudah diproses.' })
    const total = list.reduce((s, { item, n }) => s + item.price * n, 0)
    await ensureWallet(u) // akun lama tanpa saldo: isi saldo awal dulu supaya $inc tidak menggantikannya
    const users = await col('users')
    const filter = { _id: u._id, coins: { $gte: total } }, inc = { coins: -total }
    for (const { item, n } of list) { filter['inv.' + item.id] = { $not: { $gt: LIMITS.inv - n } }; inc['inv.' + item.id] = n } // $not/$gt: juga cocok kalau barangnya belum pernah dimiliki
    const nu = doc(await users.findOneAndUpdate(filter, { $inc: inc }, { returnDocument: 'after' }))
    if (!nu) { // gagal: cari tahu kenapa dari data terbaru
      if (idem) await col('econ_txn').then(c => c.deleteOne({ _id: `${u._id}:${idem}` })).catch(() => { }) // idem dibebaskan supaya bisa dicoba lagi
      const cur = await users.findOne({ _id: u._id }) || u
      const poor = (cur.coins ?? 0) < total
      return res.status(409).json({ ...(await view(cur)), ok: false, error: poor ? 'Coin kamu belum cukup.' : `Simpanan penuh (maks ${LIMITS.inv} per barang).` })
    }
    try { await (await col('econ_log')).insertOne({ _id: `${u._id}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 10)}`, uid: u._id, kind: 'buy', txt: `Beli ${sentence(list)}`, coins: -total, gems: 0, tickets: 0, at: new Date() }) } catch { }
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
    if (!nu) return res.status(409).json({ ...(await view(await users.findOne({ _id: u._id }) || u)), ok: false, error: 'Barangmu tidak cukup.' })
    // Item favorit: EXP x FAV_MULT.exp, Mood x FAV_MULT.mood — HANYA untuk barang yang cocok dengan
    // favorit karakternya (FAVORITES di lib/economy.js, satu tempat). Campur favorit + biasa: bonusnya
    // hanya kena bagian barang favoritnya. Batas mood tetap dipakai setelah multiplier.
    const favId = FAVORITES[charId] || null
    let expRaw = 0, moodRaw = 0, favHit = false
    for (const { item, n } of list) {
      const fav = favId === item.id
      if (fav) favHit = true
      expRaw += item.exp * n * (fav ? FAV_MULT.exp : 1)
      moodRaw += item.mood * n * (fav ? FAV_MULT.mood : 1)
    }
    const exp = Math.round(expRaw)
    const mood = Math.min(LIMITS.mood, Math.round(moodRaw))
    // misi harian + piala: sekali per pemberian hadiah (berapapun isinya)
    const nq = await track(col, nu, 'gift')
    // favHit = penanda hadiah ini mengandung item favorit (beda dari `fav` = peta konfigurasi di view)
    res.json(await view(nu, { exp, mood, gift: list.map(({ item, n }) => ({ id: item.id, n })), ...(favHit ? { favHit: { item: favId, exp: FAV_MULT.exp, mood: FAV_MULT.mood } } : {}), ...(nq.length ? { nq } : {}) }))
  }))
}
