// ===== Ekonomi: Tukar Currency (Coin/Gems/Ticket) + Gacha Cincin + item favorit karakter =====
// Dipasang ke router auth (lib/auth.js) lewat mountEconomy(), memakai sesi/token, pembatas laju, dan
// koleksi `users` yang sama dengan toko & game. Semua aturan dijaga DI SINI (client hanya menampilkan):
//
//   - Ticket adalah mata uang ketiga (field `tickets` di `users`). Gems TIDAK bisa kembali ke Coin,
//     Ticket tidak bisa ditukar ke apa pun — konversi hanya satu arah (lihat EXCHANGE).
//   - Bonus konversi Coin -> Gems bertingkat (EXCHANGE.tiers); hitungannya murni dari config, client
//     menampilkan pratinjau dari config yang sama lewat /api/auth/economy.
//   - CHIP (field `chips` di `users`) = mata uang mode Paid di Fruit Slot (lib/slot.js). Berbeda dengan
//     Coin/Gems/Ticket, Chip DUA ARAH: beli pakai Coin (c2ch) dan jual balik ke Coin (ch2c) dengan
//     rasio sama (5 Coin = 1 Chip) — jadi untung/rugi mode Paid terasa nyata di saldo Coin. Slot Paid
//     membayar lebih besar (SLOT.paid.winMult) tapi tetap di bawah 100% RTP, jadi jual-beli Chip bukan
//     mesin uang gratis dalam jangka panjang.
//   - Gacha: biaya Ticket (single 1, multi 10x9). RNG hanya di server (crypto). Hasil non-Ring =
//     refund Gems (GACHA.refundGems per pull, bukan nilai tiketnya). Hasil Ring langsung masuk
//     `inv` (cincin-biru / cincin-merah / cincin-kuning) dan BISA diberikan ke karakter sebagai
//     hadiah istimewa (nilai exp/mood/say/tag per cincin ada di rings di bawah). Pity: pull
//     ke-GACHA.pityMax tanpa Ring dijamin Ring.
//   - Nilai hadiah cincin (exp/mood) dihitung dari biaya bersihnya: tiket 5 Gems dengan refund 4
//     per pull gagal = biaya bersih ~1 Gem (~40 Coin) per pull, rata-rata ~42 pull per cincin
//     (peluang 2% + pity 60) = ~1.700 Coin = setara ~670 EXP pada rasio toko (±0,4 EXP/coin).
//   - Atomic: setiap transaksi = SATU findOneAndUpdate dengan syarat saldo di filter (pola yang sama
//     dengan lib/shop.js), jadi saldo tidak bisa minus dan dua request bersamaan tidak membelanjakan
//     saldo yang sama dua kali. Gacha memakai filter optimistic ('gacha.pity' == nilai yang dibaca)
//     supaya dua pull paralel tidak bisa lari dari pity.
//   - Idempotency: client mengirim `idem` (UUID per konfirmasi). Koleksi `econ_txn` (index unik + TTL
//     24 jam) menjamin satu idem hanya diproses sekali — double-click/replay tidak memotong saldo dua
//     kali. Idem yang gagal (saldo kurang) dihapus lagi supaya boleh dicoba ulang.
//   - Riwayat: koleksi `econ_log` (TTL 180 hari) mencatat semua transaksi ekonomi (tukar, gacha + refund,
//     belanja). Ditampilkan di tab Tukar.
//
// Endpoint (POST, token Bearer, jawaban JSON):
//   /api/auth/economy           -> { ok, rates, gacha, rings, fav, inv, coins, gems, tickets, chips, pity, hist }
//   /api/auth/economy/exchange  -> { ok, kind, ... }   body { kind:'c2g'|'c2t'|'g2t'|'c2ch'|'ch2c', amount, idem }
//   /api/auth/economy/gacha     -> { ok, results, ... } body { pulls:1|10, idem }
//
// Field baru di `users`:  tickets (angka)  |  chips (angka, mode Paid slot)  |  gacha { pity, tot, rings }  |  inv.cincin-* (lewat lib/shop.js)

import crypto from 'node:crypto'

// ===== Semua angka ekonomi diatur di sini =====
export const EXCHANGE = {
  coinPerGem: 40,                                    // rasio dasar: 40 Coin = 1 Gem
  tiers: [                                           // bonus bertingkat berdasarkan Coin yang ditukar
    { min: 200, bonus: 0.05 },                       //   200+ Coin -> +5% Gems
    { min: 800, bonus: 0.12 },                       //   800+ Coin -> +12% Gems
    { min: 2400, bonus: 0.25 }                       // 2.400+ Coin -> +25% Gems
  ],
  coinPerTicket: 300,                                // tiket pakai Coin: sengaja mahal (alternatif)
  gemPerTicket: 5,                                   // tiket pakai Gems: opsi pembelian utama
  coinPerChip: 5,                                    // BELI chip: 5 Coin = 1 Chip (mode Paid Fruit Slot)
  chipPerCoin: 5,                                    // JUAL chip: 5 Chip = 1 Coin (rasio sama, dua arah)
  maxCoin: 1_000_000,                                // batas Coin per konversi (anti angka gila)
  maxTicket: 99,                                     // maks tiket per transaksi
  maxChip: 20_000                                    // maks Chip per transaksi (beli/jual)
}

export const GACHA = {
  single: { pulls: 1, tickets: 1 },                  // Single Pull: 1 tiket
  multi: { pulls: 10, tickets: 9 },                  // Multi Pull 10x: 9 tiket (hemat 1)
  ringChance: 0.02,                                  // peluang Ring per pull (2%)
  pityMax: 60,                                       // jaminan: pull ke-60 tanpa Ring pasti Ring
  refundGems: 4,                                     // Gems yang kembali per pull yang TIDAK dapat Ring
  rings: [                                           // varian Ring (hadiah utama) + bobotnya.
    // w = bobot keluar | tag = label kelangkaan (dipakai UI Gacha)
    // exp/mood = nilai hadiah saat DIBERIKAN ke karakter (dihitung endpoint gift lib/shop.js).
    // Cincin TIDAK dikenai bonus item favorit (sudah istimewa dari sononya); mood tetap kena
    // batas LIMITS.mood di lib/shop.js. say = kata benda di kalimat roleplay.
    { id: 'cincin-biru', name: 'Cincin Biru', w: 5, tag: 'Langka', exp: 600, mood: 12, say: 'cincin biru', desc: 'Cincin biru berkilau dari kedalaman. Hadiah istimewa untuk momen yang tak terlupakan.' },
    { id: 'cincin-merah', name: 'Cincin Merah', w: 3, tag: 'Epik', exp: 800, mood: 14, say: 'cincin merah', desc: 'Cincin merah menyala hangat. Sangat berharga — bukan hadiah sembarangan.' },
    { id: 'cincin-kuning', name: 'Cincin Kuning', w: 2, tag: 'Legendaris', exp: 1000, mood: 15, say: 'cincin kuning', desc: 'Cincin kuning legendaris yang memancarkan cahaya keemasan. Hadiah paling istimewa.' }
  ]
}

// ===== Item favorit karakter: SATU tempat, tidak ada yang lain boleh hardcode =====
// id barang = id di ITEMS (lib/shop.js). Bonus hanya kalau barang yang DIBERIKAN cocok dengan favorit
// karakternya (dihitung di endpoint gift lib/shop.js, memakai FAV_MULT di bawah).
export const FAVORITES = { furina: 'macaron', aqua: 'bir', kazuma: 'bir', darkness: 'bir', megumin: 'teh' }
export const FAV_MULT = { exp: 1.5, mood: 2 }

// ===== Perhitungan murni (diekspor untuk uji otomatis) =====
// Coin -> Gems: hanya kelipatan rasio yang terpakai (sisanya tetap milik user). Bonus dari tingkat tertinggi yang tercapai.
export function gemsForCoins(coins) {
  const c = Math.max(0, Math.floor(Number(coins) || 0))
  const base = Math.floor(c / EXCHANGE.coinPerGem)
  const used = base * EXCHANGE.coinPerGem
  const tier = [...EXCHANGE.tiers].reverse().find(t => used >= t.min) || null
  const bonus = tier ? Math.floor(base * tier.bonus) : 0
  return { used, base, bonus, pct: tier ? tier.bonus : 0, gems: base + bonus }
}

// Coin -> Chip (BELI): rasio datar tanpa bonus — sengaja simpel supaya jual-baliknya adil (rasio sama).
export function chipsForCoins(coins) {
  const c = Math.max(0, Math.floor(Number(coins) || 0))
  const chips = Math.floor(c / EXCHANGE.coinPerChip)
  return { used: chips * EXCHANGE.coinPerChip, chips }
}
// Chip -> Coin (JUAL): rasio datar, hanya kelipatan penuh yang terpakai.
export function coinsForChips(chips) {
  const c = Math.max(0, Math.floor(Number(chips) || 0))
  const coins = Math.floor(c / EXCHANGE.chipPerCoin)
  return { used: coins * EXCHANGE.chipPerCoin, coins }
}

// Satu putaran gacha (dipanggil per pull oleh rollGacha): Ring atau refund Gems.
const pickRing = () => {
  const total = GACHA.rings.reduce((s, r) => s + r.w, 0)
  let x = crypto.randomInt(0, total)
  for (const r of GACHA.rings) if ((x -= r.w) < 0) return r
  return GACHA.rings[0]
}
export function rollPull(pity) {
  const hit = pity + 1 >= GACHA.pityMax || crypto.randomInt(0, 10000) < Math.round(GACHA.ringChance * 10000)
  if (!hit) return { t: 'gems', n: GACHA.refundGems, pity: pity + 1 }
  const r = pickRing()
  return { t: 'ring', id: r.id, name: r.name, pity: 0 }
}
// Sebuah multi/single pull: RNG di server, hasil dikirim utuh ke client (client hanya mengurus animasi).
export function rollGacha(pityIn, pulls) {
  let pity = Math.max(0, Math.min(GACHA.pityMax - 1, Math.floor(Number(pityIn) || 0)))
  const results = []
  let refund = 0, rings = 0
  for (let i = 0; i < pulls; i++) {
    const r = rollPull(pity)
    results.push(r)
    pity = r.pity
    if (r.t === 'ring') rings++
    else refund += r.n
  }
  return { results, pity, rings, refund }
}

// ===== Endpoint =====
const doc = r => (r && r.value !== undefined ? r.value : r) // findOneAndUpdate: driver baru mengembalikan dokumen, driver lama { value }
const IDEM_RE = /^[\w-]{8,64}$/
const num = (x, d = NaN) => { const n = Math.floor(Number(x)); return Number.isFinite(n) ? n : d }

// Riwayat transaksi (kegagalan pencatatan tidak boleh menggagalkan transaksinya)
async function log(col, uid, kind, txt, d) {
  try {
    await (await col('econ_log')).insertOne({
      _id: `${uid}:${Date.now().toString(36)}:${crypto.randomBytes(4).toString('hex')}`,
      uid, kind, txt, coins: d?.coins ?? 0, gems: d?.gems ?? 0, tickets: d?.tickets ?? 0, chips: d?.chips ?? 0, at: new Date()
    })
  } catch { }
}

// Idempotency: true = lanjut (belum pernah dipakai), false = transaksi yang sama sudah diproses.
async function onceOnly(col, uid, idem) {
  if (!idem) return true // tanpa idem (client lama): tidak dianggap duplikat
  try { await (await col('econ_txn')).insertOne({ _id: `${uid}:${idem}`, uid, at: new Date() }); return true }
  catch (e) { if (e?.code === 11000) return false; throw e }
}
const unIdem = (col, uid, idem) => idem ? col('econ_txn').then(c => c.deleteOne({ _id: `${uid}:${idem}` })).catch(() => { }) : null

export function mountEconomy(router, { wrap, userFromReq, allow, col, ensureWallet }) {
  let ready
  const init = () => ready ??= Promise.all([
    (async () => { const c = await col('econ_txn'); await c.createIndex({ at: 1 }, { expireAfterSeconds: 86400 }) })(), // idem hanya berlaku 24 jam
    (async () => { const c = await col('econ_log'); await c.createIndex({ at: 1 }, { expireAfterSeconds: 180 * 86400 }); await c.createIndex({ uid: 1, at: -1 }) })()
  ]).catch(e => { ready = null; throw e })

  const need = async (req, res) => {
    const a = await userFromReq(req)
    if (!a) { res.status(401).json({ error: 'Sesi berakhir, masuk lagi.' }); return null }
    return a.user
  }
  const invOf = u => Object.fromEntries(GACHA.rings.map(r => [r.id, Math.max(0, Math.min(999, Math.floor(Number(u.inv?.[r.id]) || 0)))]))

  async function view(u, extra) {
    const w = await ensureWallet(u)
    const hist = await (await col('econ_log')).find({ uid: u._id }, { projection: { _id: 0, uid: 0 } }).sort({ at: -1 }).limit(12).toArray().catch(() => [])
    return {
      ok: true,
      rates: { coinPerGem: EXCHANGE.coinPerGem, tiers: EXCHANGE.tiers, coinPerTicket: EXCHANGE.coinPerTicket, gemPerTicket: EXCHANGE.gemPerTicket, maxTicket: EXCHANGE.maxTicket, coinPerChip: EXCHANGE.coinPerChip, chipPerCoin: EXCHANGE.chipPerCoin, maxChip: EXCHANGE.maxChip },
      gacha: { single: GACHA.single, multi: GACHA.multi, ringChance: GACHA.ringChance, pityMax: GACHA.pityMax, refundGems: GACHA.refundGems },
      rings: GACHA.rings.map(r => ({ id: r.id, name: r.name, tag: r.tag, exp: r.exp, mood: r.mood, desc: r.desc })),
      fav: FAVORITES, favMult: FAV_MULT,
      inv: invOf(u),
      coins: u.coins ?? w.coins, gems: u.gems ?? w.gems, tickets: u.tickets ?? w.tickets ?? 0, chips: u.chips ?? w.chips ?? 0,
      pity: { now: u.gacha?.pity || 0, max: GACHA.pityMax, tot: u.gacha?.tot || 0, rings: u.gacha?.rings || 0 },
      hist: hist.map(h => ({ kind: h.kind, txt: h.txt, coins: h.coins, gems: h.gems, tickets: h.tickets, chips: h.chips, at: h.at })),
      ...extra
    }
  }

  // ---- Ringkasan: config publik + saldo + pity + riwayat (dipakai tab Gacha & Tukar) ----
  router.post('/api/auth/economy', wrap(async (req, res) => {
    const u = await need(req, res); if (!u) return
    if (!(await allow('ec:' + u._id, 60, 60))) return res.status(429).json({ error: 'Terlalu sering, tunggu sebentar.' })
    await init()
    await ensureWallet(u)
    const fresh = (await (await col('users')).findOne({ _id: u._id })) || u // pity terbaru setelah pull baru
    res.json(await view(fresh))
  }))

  // ---- Tukar currency (satu arah: Coin->Gems, Coin->Ticket, Gems->Ticket) ----
  router.post('/api/auth/economy/exchange', wrap(async (req, res) => {
    const u = await need(req, res); if (!u) return
    if (!(await allow('ecx:' + u._id, 20, 60))) return res.status(429).json({ error: 'Terlalu sering, tunggu sebentar.' })
    await init()
    const kind = String(req.body?.kind || '')
    const amount = num(req.body?.amount)
    const idem = IDEM_RE.test(String(req.body?.idem || '')) ? String(req.body.idem) : null
    if (!['c2g', 'c2t', 'g2t', 'c2ch', 'ch2c'].includes(kind) || !Number.isFinite(amount)) return res.status(400).json({ error: 'Permintaan tidak valid.' })

    let plan // { cost, costCur, gain, gainCur, txt }
    if (kind === 'c2g') {
      if (amount < EXCHANGE.coinPerGem || amount > EXCHANGE.maxCoin) return res.status(400).json({ error: `Jumlah Coin ${EXCHANGE.coinPerGem.toLocaleString('id-ID')} sampai ${EXCHANGE.maxCoin.toLocaleString('id-ID')}.` })
      const p = gemsForCoins(amount)
      if (p.base < 1) return res.status(400).json({ error: 'Jumlah Coin belum cukup untuk 1 Gem.' })
      plan = { cost: p.used, costCur: 'coins', gain: p.gems, gainCur: 'gems', txt: `Tukar ${p.used.toLocaleString('id-ID')} Coin jadi ${p.gems} Gems` + (p.bonus ? ` (bonus +${p.bonus})` : '') }
    } else if (kind === 'c2ch' || kind === 'ch2c') {
      // Chip: dua arah, rasio datar (beli 5 Coin = 1 Chip, jual 5 Chip = 1 Coin). Untuk mode Paid Fruit Slot.
      if (kind === 'c2ch') {
        if (amount < EXCHANGE.coinPerChip || amount > EXCHANGE.maxCoin) return res.status(400).json({ error: `Jumlah Coin ${EXCHANGE.coinPerChip.toLocaleString('id-ID')} sampai ${EXCHANGE.maxCoin.toLocaleString('id-ID')}.` })
        const p = chipsForCoins(amount)
        if (p.chips < 1) return res.status(400).json({ error: `Butuh minimal ${EXCHANGE.coinPerChip} Coin untuk 1 Chip.` })
        plan = { cost: p.used, costCur: 'coins', gain: p.chips, gainCur: 'chips', txt: `Beli ${p.chips.toLocaleString('id-ID')} Chip dengan ${p.used.toLocaleString('id-ID')} Coin` }
      } else {
        if (amount < EXCHANGE.chipPerCoin || amount > EXCHANGE.maxChip) return res.status(400).json({ error: `Jumlah Chip ${EXCHANGE.chipPerCoin} sampai ${EXCHANGE.maxChip.toLocaleString('id-ID')}.` })
        const p = coinsForChips(amount)
        if (p.coins < 1) return res.status(400).json({ error: `Butuh minimal ${EXCHANGE.chipPerCoin} Chip untuk 1 Coin.` })
        plan = { cost: p.used, costCur: 'chips', gain: p.coins, gainCur: 'coins', txt: `Jual ${p.used.toLocaleString('id-ID')} Chip jadi ${p.coins.toLocaleString('id-ID')} Coin` }
      }
    } else {
      if (amount < 1 || amount > EXCHANGE.maxTicket) return res.status(400).json({ error: `Jumlah tiket 1 sampai ${EXCHANGE.maxTicket}.` })
      if (kind === 'c2t') plan = { cost: amount * EXCHANGE.coinPerTicket, costCur: 'coins', gain: amount, gainCur: 'tickets', txt: `Beli ${amount} Tiket dengan ${(amount * EXCHANGE.coinPerTicket).toLocaleString('id-ID')} Coin` }
      else plan = { cost: amount * EXCHANGE.gemPerTicket, costCur: 'gems', gain: amount, gainCur: 'tickets', txt: `Beli ${amount} Tiket dengan ${amount * EXCHANGE.gemPerTicket} Gems` }
    }

    if (!(await onceOnly(col, u._id, idem))) return res.status(409).json({ error: 'Transaksi ini sudah diproses.' })
    await ensureWallet(u)
    const users = await col('users')
    // SATU operasi atomik: saldo cukup ada di filter -> tidak bisa minus / dobel belanja
    const nu = doc(await users.findOneAndUpdate(
      { _id: u._id, [plan.costCur]: { $gte: plan.cost } },
      { $inc: { [plan.costCur]: -plan.cost, [plan.gainCur]: plan.gain } },
      { returnDocument: 'after' }
    ))
    if (!nu) {
      await unIdem(col, u._id, idem) // gagal: idem dibebaskan supaya boleh dicoba lagi
      const cur = (await users.findOne({ _id: u._id })) || u
      const nama = plan.costCur === 'coins' ? 'Coin' : plan.costCur === 'chips' ? 'Chip' : 'Gems'
      return res.status(409).json({ ...(await view(cur)), ok: false, error: `${nama} kamu belum cukup.` }) // ok ditimpa false supaya body error tidak pura-pura sukses
    }
    await log(col, u._id, kind, plan.txt, { [plan.costCur]: -plan.cost, [plan.gainCur]: plan.gain })
    res.json(await view(nu, { done: plan }))
  }))

  // ---- Gacha: RNG di server, hasil DITENTUKAN SEBELUM animasi client ----
  router.post('/api/auth/economy/gacha', wrap(async (req, res) => {
    const u = await need(req, res); if (!u) return
    if (!(await allow('gcp:' + u._id, 12, 60))) return res.status(429).json({ error: 'Terlalu sering, tunggu sebentar.' })
    await init()
    const multi = req.body?.pulls === 10
    const cost = multi ? GACHA.multi.tickets : GACHA.single.tickets
    const pulls = multi ? GACHA.multi.pulls : GACHA.single.pulls
    const idem = IDEM_RE.test(String(req.body?.idem || '')) ? String(req.body.idem) : null
    if (!(await onceOnly(col, u._id, idem))) return res.status(409).json({ error: 'Tarikan ini sudah diproses.' })
    await ensureWallet(u)
    const users = await col('users')

    // Optimistic concurrency: filter menyertakan pity yang dibaca. Dua pull paralel -> salah satu
    // harus mengulang (pity-nya sudah tidak sama), jadi pity tidak bisa "dilompati" lewat race.
    let nu = null, roll = null
    for (let attempt = 0; attempt < 3 && !nu; attempt++) {
      const cur = (await users.findOne({ _id: u._id })) || u
      const pity = cur.gacha?.pity || 0
      roll = rollGacha(pity, pulls)
      const inc = { tickets: -cost }
      const set = { 'gacha.pity': roll.pity, 'gacha.tot': (cur.gacha?.tot || 0) + pulls, 'gacha.rings': (cur.gacha?.rings || 0) + roll.rings }
      if (roll.refund) inc.gems = roll.refund
      for (const r of roll.results) if (r.t === 'ring') inc['inv.' + r.id] = (inc['inv.' + r.id] || 0) + 1
      nu = doc(await users.findOneAndUpdate(
        { _id: u._id, tickets: { $gte: cost }, 'gacha.pity': pity },
        { $inc: inc, $set: set },
        { returnDocument: 'after' }
      ))
    }
    if (!nu) {
      await unIdem(col, u._id, idem)
      const cur = (await users.findOne({ _id: u._id })) || u
      const poor = (cur.tickets || 0) < cost
      if (poor) return res.status(409).json({ ...(await view(cur)), ok: false, error: 'Tiket kamu belum cukup.' })
      return res.status(503).json({ ok: false, error: 'Server sibuk, coba tarik lagi.' }) // race pity jarang: suruh ulang
    }
    const ringsTxt = roll.rings ? `, ${roll.rings}x Ring` : ''
    await log(col, u._id, 'gacha', `Gacha x${pulls}${ringsTxt}${roll.refund ? `, refund ${roll.refund} Gems` : ''}`, { tickets: -cost, gems: roll.refund })
    res.json(await view(nu, { results: roll.results, cost, refund: roll.refund, ringsGot: roll.rings }))
  }))
}
