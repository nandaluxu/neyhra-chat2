// ===== Minigame Fruit Slot: mesin slot buah 3x3 arcade + combo 1-7 + Bonus Session =====
// Dipasang ke router auth (lib/auth.js) lewat mountSlot(), memakai sesi/token, pembatas laju, dan
// koleksi `users` yang sama dengan game & ekonomi lain. Semua hasil (grid, kemenangan, combo, bonus,
// saldo) diputuskan DI SINI; client hanya mengurus animasi. Virtual point (VP) adalah mata uang
// permainan yang TERPISAH dari coin/gems: tidak bisa dibeli dan tidak bisa ditukar ke apa pun.
//
//   - Papan 3x3 (3 gulungan). Garis bayar: 3 baris + 2 diagonal (SLOT.lines). Bayaran per garis =
//     pay simbol x (taruhan / jumlah garis). Simbol dengan `pay2` (Ceri) juga membayar kalau muncul
//     2 di satu garis — cara klasik menaikkan frekuensi menang supaya combo terasa.
//   - COMBO 1-7: menang (bayaran > 0) menaikkan combo +1, kalah me-reset ke 0. Combo 7 membuka
//     BONUS SESSION: 3 ronde, tanpa biaya VP, reward dari pool khusus (kelipatan taruhan saat
//     combo 7 tercapai), total dimasukkan SEKALI ke saldo setelah ronde ke-3.
//   - RNG 100% server (crypto.randomInt). Hasil spin DITENTUKAN SEBELUM animasi: respons memuat
//     grid final; client hanya memutarkan gulungannya.
//   - Atomic & anti-curang: satu spin = SATU findOneAndUpdate dengan syarat saldo + combo yang
//     dibaca di filter (pola optimistic yang sama dengan gacha lib/economy.js), jadi saldo tidak
//     bisa minus, dua request paralel tidak membelanjakan saldo yang sama, dan combo tidak bisa
//     dilompati lewat race. Ronde bonus maju satu-satu lewat filter 'slot.bonus.r' == ronde yang
//     dibaca: reward total hanya dikredit SEKALI. Spin ditolak selama bonus berjalan.
//   - Saldo VP habis? Isi ulang gratis (SLOT.refill) — sekali per masa tenang, hanya kalau saldo
//     di bawah taruhan terkecil. Server yang menjamin waktunya (slot.refAt).
//
// Endpoint (POST, token Bearer, jawaban JSON):
//   /api/auth/slot          -> { ok, cfg, bal, combo, bonus, spins, wins, best, refillAt, hist }   body { clear?:true } (clear = buang bonus yang sudah selesai)
//   /api/auth/slot/spin     -> { ok, grid, lines, win, bet, bal, combo, bonusHit, ... }            body { bet }
//   /api/auth/slot/bonus    -> { ok, r, reward, sym, total, done, bal, log }                      satu ronde bonus
//   /api/auth/slot/refill   -> { ok, bal, refillAt }                                              isi ulang VP gratis
//
// Field baru di `users`:  slot { bal, combo, bonus, spins, wins, best, refAt }
// Koleksi `game_state` (sudah ada, TTL 24 jam):  _id "<userId>:slot" { hist: [20 terakhir] }

import crypto from 'node:crypto'

// ===== Semua angka permainan diatur di sini (satu tempat) =====
export const SLOT = {
  // w = bobot kemunculan | pay3 = bayaran 3-sejenis per garis (x taruhan garis) | pay2 = bayaran 2-sejenis
  symbols: [
    { id: 'cherry', name: 'Ceri', w: 26, pay3: 11, pay2: 1 },
    { id: 'lemon', name: 'Lemon', w: 20, pay3: 17 },
    { id: 'orange', name: 'Jeruk', w: 16, pay3: 25 },
    { id: 'grape', name: 'Anggur', w: 13, pay3: 35 },
    { id: 'strawberry', name: 'Stroberi', w: 10, pay3: 50 },
    { id: 'watermelon', name: 'Semangka', w: 8, pay3: 88 },
    { id: 'seven', name: 'Tujuh', w: 5, pay3: 175 },
    { id: 'diamond', name: 'Berlian', w: 3, pay3: 420 }
  ],
  lines: 5,                                   // 3 baris + 2 diagonal; taruhan garis = taruhan / 5
  bets: [10, 25, 50, 100, 250, 500],          // pilihan taruhan per putaran (VP). Harus habis dibagi `lines`
  start: 1000,                                // saldo VP awal
  refill: { amount: 1000, cooldownMin: 15 },  // isi ulang gratis saat bangkrut: sekali per masa tenang
  comboMax: 7,                                // combo 7 = Bonus Session
  bonus: {
    rounds: 3,
    // pool reward ronde bonus: w = bobot, m = kelipatan TARIHAN saat combo 7 tercapai, sym = simbol tampilan (kosmetik)
    pool: [
      { w: 20, m: 2, sym: 'lemon' },
      { w: 28, m: 4, sym: 'orange' },
      { w: 28, m: 6, sym: 'grape' },
      { w: 17, m: 10, sym: 'watermelon' },
      { w: 6, m: 15, sym: 'seven' },
      { w: 2, m: 25, sym: 'diamond' }
    ]
  },
  histMax: 20                                 // riwayat putaran yang disimpan (ditampilkan di Pengaturan)
}

// sel papan: index = baris*3 + kolom (0..8). Garis: 3 baris + 2 diagonal.
export const LINE_CELLS = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 4, 8], [2, 4, 6]]
const SYM = Object.fromEntries(SLOT.symbols.map((s, i) => [s.id, i]))
const W_TOTAL = SLOT.symbols.reduce((s, x) => s + x.w, 0)
// nilai awal field `slot` di users (dipakai mountSlot dan pendaftaran akun baru di lib/auth.js)
export const slotStart = () => ({ bal: SLOT.start, combo: 0, bonus: null, spins: 0, wins: 0, best: 0, refAt: 0 })

// ===== Perhitungan murni (diekspor untuk uji otomatis & simulasi) =====
// Satu grid 9 sel (isi = index simbol). RNG hanya lewat sini (crypto).
export function rollGrid() {
  const g = []
  for (let i = 0; i < 9; i++) {
    let x = crypto.randomInt(0, W_TOTAL)
    let k = SLOT.symbols.length - 1
    for (let j = 0; j < SLOT.symbols.length; j++) { if ((x -= SLOT.symbols[j].w) < 0) { k = j; break } }
    g.push(k)
  }
  return g
}

// Hitung kemenangan sebuah grid: garis mana yang menang + total bayaran (VP). Murni dari config.
export function evalGrid(grid, bet) {
  const lineBet = bet / SLOT.lines
  const lines = []
  let win = 0
  LINE_CELLS.forEach((cells, li) => {
    const a = grid[cells[0]], b = grid[cells[1]], c = grid[cells[2]]
    if (a === b && b === c) {
      const pay = SLOT.symbols[a].pay3 * lineBet
      win += pay
      lines.push({ line: li, sym: a, kind: 3, pay })
    } else {
      // 2-sejenis: hanya simbol yang punya pay2 (Ceri), di posisi mana pun pada garis itu
      for (let s = 0; s < SLOT.symbols.length; s++) {
        const cfg = SLOT.symbols[s]
        if (!cfg.pay2) continue
        const n = cells.reduce((t, i) => t + (grid[i] === s ? 1 : 0), 0)
        if (n >= 2) {
          const pay = cfg.pay2 * lineBet
          win += pay
          lines.push({ line: li, sym: s, kind: 2, pay })
        }
      }
    }
  })
  return { win, lines }
}

// Combo berikutnya: menang naik +1 (maks comboMax), kalah reset 0.
export const comboNext = (combo, win) => (win > 0 ? Math.min(SLOT.comboMax, (combo || 0) + 1) : 0)

// Satu ronde bonus: reward dari pool (x taruhan saat combo 7) + simbol tampilannya.
export function rollBonusRound(bet) {
  const total = SLOT.bonus.pool.reduce((s, p) => s + p.w, 0)
  let x = crypto.randomInt(0, total), pick = SLOT.bonus.pool[0]
  for (const p of SLOT.bonus.pool) { if ((x -= p.w) < 0) { pick = p; break } }
  return { reward: pick.m * bet, sym: SYM[pick.sym] ?? 0 }
}

// ===== Endpoint =====
const doc = r => (r && r.value !== undefined ? r.value : r) // findOneAndUpdate: driver baru mengembalikan dokumen, driver lama { value }
const TTL_MS = 24 * 3600e3
const slotDefault = slotStart
const symId = i => SLOT.symbols[i]?.id || SLOT.symbols[0].id

export function mountSlot(router, { wrap, userFromReq, allow, col, ensureWallet }) {
  const need = async (req, res) => {
    const a = await userFromReq(req)
    if (!a) { res.status(401).json({ error: 'Sesi berakhir, masuk lagi.' }); return null }
    return a.user
  }
  const sid = u => u._id + ':slot'

  // akun lama (dan akun baru via /api/auth/slot pertama): pastikan field `slot` ada isinya.
  // $exists menjaga progres yang sudah ada tidak tertimpa.
  async function ensureSlot(u) {
    if (u.slot && typeof u.slot.bal === 'number') return u.slot
    await (await col('users')).updateOne({ _id: u._id, slot: { $exists: false } }, { $set: { slot: slotDefault() } }).catch(() => { })
    return { ...slotDefault(), ...(u.slot || {}) }
  }

  // bentuk bonus untuk client (bet ikut supaya resume tahu patokannya; log = reward per ronde)
  const bonusView = b => (b && b.r != null ? { r: b.r, total: b.total || 0, bet: b.bet || 0, log: Array.isArray(b.log) ? b.log : [], done: !!b.done, rounds: SLOT.bonus.rounds } : null)

  async function histGet(u) {
    const s = await (await col('game_state')).findOne({ _id: sid(u) }).catch(() => null)
    const h = Array.isArray(s?.hist) ? s.hist : []
    return h.slice(-SLOT.histMax).reverse().map(x => ({ g: String(x.g || ''), bet: x.bet || 0, win: x.win || 0, combo: x.combo || 0, at: x.at }))
  }
  const histPush = (u, h) => (async () => {
    await (await col('game_state')).updateOne(
      { _id: sid(u) },
      { $push: { hist: { $each: [h], $slice: -SLOT.histMax } }, $set: { exp: new Date(Date.now() + TTL_MS) } },
      { upsert: true }
    ).catch(() => { }) // riwayat kosmetik: kegagalan tidak boleh menggagalkan spin
  })()

  async function view(u, extra) {
    await ensureWallet(u) // akun lama tanpa coins/gems tetap rapi (slot sendiri tidak memakainya)
    const slot = await ensureSlot(u)
    const now = Date.now()
    return {
      ok: true,
      cfg: {
        symbols: SLOT.symbols.map(s => ({ id: s.id, name: s.name, pay3: s.pay3, ...(s.pay2 ? { pay2: s.pay2 } : {}) })),
        lines: SLOT.lines, bets: SLOT.bets, start: SLOT.start,
        comboMax: SLOT.comboMax, bonusRounds: SLOT.bonus.rounds,
        refill: { amount: SLOT.refill.amount, cooldownMin: SLOT.refill.cooldownMin }
      },
      bal: slot.bal ?? 0, combo: slot.combo || 0, bonus: bonusView(slot.bonus),
      spins: slot.spins || 0, wins: slot.wins || 0, best: slot.best || 0,
      refillAt: slot.refAt ? slot.refAt + SLOT.refill.cooldownMin * 60e3 : 0,
      refillReady: (slot.bal ?? 0) < Math.min(...SLOT.bets) && now >= (slot.refAt ? slot.refAt + SLOT.refill.cooldownMin * 60e3 : 0),
      hist: await histGet(u),
      ...extra
    }
  }

  // ---- Keadaan (dipakai saat masuk layar & memulihkan Bonus Session / ringkasan) ----
  router.post('/api/auth/slot', wrap(async (req, res) => {
    const u = await need(req, res); if (!u) return
    if (!(await allow('slt:' + u._id, 60, 60))) return res.status(429).json({ error: 'Terlalu sering, tunggu sebentar.' })
    const users = await col('users')
    let cur = u
    if (req.body?.clear && u.slot?.bonus?.done) { // bonus sudah diringkas pemain: bersihkan supaya bisa spin lagi
      cur = doc(await users.findOneAndUpdate({ _id: u._id, 'slot.bonus.done': true }, { $set: { 'slot.bonus': null } }, { returnDocument: 'after' })) || u
    }
    res.json(await view(cur))
  }))

  // ---- Spin: validasi -> RNG -> evaluasi -> POTONG saldo + combo dalam SATU operasi atomik ----
  router.post('/api/auth/slot/spin', wrap(async (req, res) => {
    const u = await need(req, res); if (!u) return
    if (!(await allow('slts:' + u._id, 240, 60))) return res.status(429).json({ error: 'Terlalu sering, tunggu sebentar.' }) // 4 spin/dtk berkelanjutan: antrean 10x turbo tidak terblok, server tetap aman
    const bet = Number(req.body?.bet)
    if (!SLOT.bets.includes(bet)) return res.status(400).json({ error: 'Taruhan tidak valid.' })
    const users = await col('users')
    await ensureSlot(u)

    // Optimistic concurrency: filter menyertakan combo (dan bonus null) yang dibaca. Dua spin
    // paralel -> salah satu harus mengulang, jadi combo tidak bisa dilompati lewat race.
    let nu = null, out = null
    for (let attempt = 0; attempt < 3 && !nu; attempt++) {
      const cur = (attempt ? await users.findOne({ _id: u._id }) : u) || u
      const slot = { ...slotDefault(), ...(cur.slot || {}) }
      if (slot.bonus) return res.status(409).json({ error: 'Selesaikan Bonus Session dulu.' })
      if (slot.bal < bet) return res.status(409).json({ ...(await view(cur)), ok: false, error: 'Saldo virtual point kamu belum cukup.' })
      const grid = rollGrid()
      const ev = evalGrid(grid, bet)
      const combo = comboNext(slot.combo, ev.win)
      const bonusHit = combo >= SLOT.comboMax
      const set = { 'slot.combo': combo }
      if (bonusHit) set['slot.bonus'] = { r: 0, total: 0, bet, log: [] } // taruhan terkunci saat combo 7 tercapai
      const inc = { 'slot.bal': ev.win - bet, 'slot.spins': 1 }
      if (ev.win > 0) inc['slot.wins'] = 1
      nu = doc(await users.findOneAndUpdate(
        { _id: u._id, 'slot.bal': { $gte: bet }, 'slot.combo': slot.combo, 'slot.bonus': null },
        { $inc: inc, $set: set, $max: { 'slot.best': ev.win } },
        { returnDocument: 'after' }
      ))
      if (nu) out = { grid, ev, combo, bonusHit }
    }
    if (!nu) return res.status(503).json({ ok: false, error: 'Server sibuk, coba putar lagi.' }) // race combo jarang: suruh ulang

    await histPush(u, { g: out.grid.join(''), bet, win: out.ev.win, combo: out.combo, at: Date.now() })
    res.json({
      ...(await view(nu)),
      grid: out.grid.map(symId),                       // hasil FINAL (ditentukan sebelum animasi)
      lines: out.ev.lines.map(l => ({ ...l, sym: symId(l.sym) })),
      win: out.ev.win, bet, combo: out.combo, bonusHit: out.bonusHit
    })
  }))

  // ---- Satu ronde Bonus Session: reward dari pool, ronde maju satu; ronde terakhir mengkredit TOTAL sekali ----
  router.post('/api/auth/slot/bonus', wrap(async (req, res) => {
    const u = await need(req, res); if (!u) return
    if (!(await allow('sltb:' + u._id, 30, 60))) return res.status(429).json({ error: 'Terlalu sering, tunggu sebentar.' })
    const users = await col('users')
    const cur = (await users.findOne({ _id: u._id })) || u
    const b = cur.slot?.bonus
    if (!b || b.done || b.r >= SLOT.bonus.rounds) return res.status(409).json({ ...(await view(cur)), ok: false, error: 'Bonus Session tidak sedang berjalan.' })
    const round = rollBonusRound(b.bet)
    const log = [...(Array.isArray(b.log) ? b.log : []), round.reward]
    const total = (b.total || 0) + round.reward
    const final = b.r + 1 >= SLOT.bonus.rounds
    // filter 'slot.bonus.r' == ronde yang dibaca: dua permintaan paralel tidak bisa memajukan ronde
    // yang sama dua kali, dan penggandaan total tidak mungkin. Ronde terakhir: saldo += TOTAL dan
    // combo reset 0 (progression baru setelah bonus) di operasi YANG SAMA.
    const nu = doc(await users.findOneAndUpdate(
      { _id: u._id, 'slot.bonus.r': b.r },
      final
        ? { $inc: { 'slot.bal': total }, $set: { 'slot.bonus': { r: b.r + 1, total, bet: b.bet, log, done: true }, 'slot.combo': 0 } }
        : { $inc: { 'slot.bonus.r': 1, 'slot.bonus.total': round.reward }, $push: { 'slot.bonus.log': round.reward } },
      { returnDocument: 'after' }
    ))
    if (!nu) return res.status(409).json({ ...(await view(cur)), ok: false, error: 'Ronde bonus sudah maju, muat ulang.' })
    await histPush(u, { g: 'bonus', bet: 0, win: round.reward, combo: SLOT.comboMax, at: Date.now() })
    res.json({ ...(await view(nu)), ok: true, r: b.r + 1, reward: round.reward, sym: symId(round.sym), total, done: final, bal: nu.slot?.bal ?? 0, log })
  }))

  // ---- Isi ulang VP gratis: hanya kalau bangkrut (saldo < taruhan terkecil) dan masa tenang sudah lewat ----
  router.post('/api/auth/slot/refill', wrap(async (req, res) => {
    const u = await need(req, res); if (!u) return
    if (!(await allow('sltr:' + u._id, 4, 3600))) return res.status(429).json({ error: 'Terlalu sering, tunggu sebentar.' })
    const users = await col('users')
    await ensureSlot(u)
    const minBet = Math.min(...SLOT.bets), now = Date.now()
    const nu = doc(await users.findOneAndUpdate(
      { _id: u._id, 'slot.bal': { $lt: minBet }, 'slot.refAt': { $lte: now - SLOT.refill.cooldownMin * 60e3 } },
      { $set: { 'slot.bal': SLOT.refill.amount, 'slot.refAt': now } },
      { returnDocument: 'after' }
    ))
    if (!nu) {
      const cur = (await users.findOne({ _id: u._id })) || u
      const tunggu = Math.max(0, Math.ceil(((cur.slot?.refAt || 0) + SLOT.refill.cooldownMin * 60e3 - now) / 60e3))
      return res.status(409).json({ ...(await view(cur)), ok: false, error: (cur.slot?.bal ?? 0) >= minBet ? 'Saldo kamu masih cukup untuk bermain.' : `Isi ulang tersedia lagi dalam ${tunggu} menit.` })
    }
    res.json({ ...(await view(nu)), ok: true, refilled: SLOT.refill.amount })
  }))
}
