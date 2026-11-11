// ===== Minigame Fruit Slot: mesin slot buah 3x3 arcade + combo 1-7 + Bonus Session + mode Demo/Paid =====
// Dipasang ke router auth (lib/auth.js) lewat mountSlot(), memakai sesi/token, pembatas laju, dan
// koleksi `users` yang sama dengan game & ekonomi lain. Semua hasil (grid, kemenangan, combo, bonus,
// saldo) diputuskan DI SINI; client hanya mengurus animasi.
//
//   - DUA MODE (slot.mode, dipilih pemain, default 'demo'):
//       * DEMO = virtual point (VP) gratis: saldo awal 1.000, isi ulang gratis saat bangkrut
//         (sekali per masa tenang). VP tidak bisa dibeli dan tidak bisa ditukar ke apa pun.
//       * PAID = beneran bayar pakai CHIP (field `chips`, dibeli dari Coin lewat /api/auth/economy
//         c2ch, bisa dijual balik ch2c — rasio sama 5 Coin = 1 Chip). TANPA isi ulang gratis.
//         Semua kemenangan dikali SLOT.paid.winMult (bayar lebih besar supaya untungnya terasa),
//         total RTP tetap < 100% (sim: scripts/slot-sim.mjs) jadi bukan mesin uang gratis.
//     Balance VP dan progres combo/bonus/statistik DIPISAH PER MODE (slot.demo / slot.paid);
//     saldo mode Paid = `chips` (satu-satunya saldo yang dipakai ekonomi juga).
//   - Papan 3x3 (3 gulungan). Garis bayar: 3 baris + 2 diagonal (SLOT.lines). Bayaran per garis =
//     pay simbol x (taruhan / jumlah garis) x winMult mode. Simbol dengan `pay2` (Ceri) juga membayar
//     kalau muncul 2 di satu garis — cara klasik menaikkan frekuensi menang supaya combo terasa.
//   - COMBO 1-7: menang (bayaran > 0) menaikkan combo +1, kalah me-reset ke 0. Combo 7 membuka
//     BONUS SESSION: 3 ronde, tanpa biaya, reward dari pool khusus (kelipatan taruhan saat
//     combo 7 tercapai), total dimasukkan SEKALI ke saldo setelah ronde ke-3.
//   - RNG 100% server (crypto.randomInt). Hasil spin DITENTUKAN SEBELUM animasi: respons memuat
//     grid final; client hanya memutarkan gulungannya.
//   - Atomic & anti-curang: satu spin = SATU findOneAndUpdate dengan syarat saldo + combo yang
//     dibaca di filter (pola optimistic yang sama dengan gacha lib/economy.js), jadi saldo tidak
//     bisa minus, dua request paralel tidak membelanjakan saldo yang sama, dan combo tidak bisa
//     dilompati lewat race. Ronde bonus maju satu-satu lewat filter 'slot.<mode>.bonus.r' == ronde
//     yang dibaca: reward total hanya dikredit SEKALI. Spin ditolak selama bonus berjalan.
//
// Endpoint (POST, token Bearer, jawaban JSON):
//   /api/auth/slot          -> { ok, mode, bal, bals, cfg, combo, bonus, spins, wins, best, refillAt, hist }  body { clear?:true, mode?:'demo'|'paid' }
//   /api/auth/slot/spin     -> { ok, grid, lines, win, bet, bal, combo, bonusHit, ... }            body { bet }
//   /api/auth/slot/bonus    -> { ok, r, reward, sym, total, done, bal, log }                       satu ronde bonus
//   /api/auth/slot/refill   -> { ok, bal, refillAt }                                              isi ulang VP gratis (hanya mode Demo)
//
// Field `users`:  slot { mode, demo { bal, combo, bonus, spins, wins, best, refAt }, paid { combo, bonus, spins, wins, best } }
// Dokumen slot lama (field bal/combo/... langsung di bawah `slot`) DIPINDAHKAN ke slot.demo
// sekali saja saat /api/auth/slot pertama (migrasi atomik, progres lama tetap utuh).
// Koleksi `game_state` (sudah ada, TTL 24 jam):  _id "<userId>:slot" { hist: [20 terakhir] }

import crypto from 'node:crypto'
import { EXCHANGE } from './economy.js'

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
  bets: [10, 25, 50, 100, 250, 500],          // pilihan taruhan per putaran (VP / Chip). Harus habis dibagi `lines`
  start: 1000,                                // saldo VP awal (mode Demo)
  refill: { amount: 1000, cooldownMin: 15 },  // isi ulang gratis saat bangkrut: sekali per masa tenang (hanya Demo)
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
  // Mode Paid: pengganda kemenangan. RTP Demo ~90% -> Paid ~99% (tetap < 100%, diukur scripts/slot-sim.mjs):
  // menang terasa lebih besar (ini "untung"-nya), tapi jual-beli chip bukan mesin uang gratis jangka panjang.
  paid: { winMult: 1.1 },
  histMax: 20                                 // riwayat putaran yang disimpan (ditampilkan di Pengaturan)
}

// sel papan: index = baris*3 + kolom (0..8). Garis: 3 baris + 2 diagonal.
export const LINE_CELLS = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 4, 8], [2, 4, 6]]
const SYM = Object.fromEntries(SLOT.symbols.map((s, i) => [s.id, i]))
const W_TOTAL = SLOT.symbols.reduce((s, x) => s + x.w, 0)

// nilai awal sub-dokumen per mode. `paid` tanpa bal (saldo mode Paid = `chips`) dan tanpa refAt (tidak ada isi ulang).
const demoStart = () => ({ bal: SLOT.start, combo: 0, bonus: null, spins: 0, wins: 0, best: 0, refAt: 0 })
const paidStart = () => ({ combo: 0, bonus: null, spins: 0, wins: 0, best: 0 })
// nilai awal field `slot` di users (dipakai mountSlot dan pendaftaran akun baru di lib/auth.js)
export const slotStart = () => ({ mode: 'demo', demo: demoStart(), paid: paidStart() })

// awalan path Mongo per mode: progres combo/bonus/statistik di slot.demo / slot.paid,
// saldo mode Demo = slot.demo.bal, saldo mode Paid = chips (dipakai ekonomi juga).
const SUB = m => (m === 'paid' ? 'slot.paid' : 'slot.demo')
const BAL = m => (m === 'paid' ? 'chips' : 'slot.demo.bal')
const modeOf = s => (s && s.mode === 'paid' ? 'paid' : 'demo')
const winMult = m => (m === 'paid' ? SLOT.paid.winMult : 1)

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

// Hitung kemenangan sebuah grid: garis mana yang menang + total bayaran. Murni dari config.
// mult = pengganda kemenangan mode (Demo 1, Paid SLOT.paid.winMult); dibulatkan per garis supaya rapi.
export function evalGrid(grid, bet, mult = 1) {
  const lineBet = bet / SLOT.lines
  const lines = []
  let win = 0
  LINE_CELLS.forEach((cells, li) => {
    const a = grid[cells[0]], b = grid[cells[1]], c = grid[cells[2]]
    if (a === b && b === c) {
      const pay = Math.round(SLOT.symbols[a].pay3 * lineBet * mult)
      win += pay
      lines.push({ line: li, sym: a, kind: 3, pay })
    } else {
      // 2-sejenis: hanya simbol yang punya pay2 (Ceri), di posisi mana pun pada garis itu
      for (let s = 0; s < SLOT.symbols.length; s++) {
        const cfg = SLOT.symbols[s]
        if (!cfg.pay2) continue
        const n = cells.reduce((t, i) => t + (grid[i] === s ? 1 : 0), 0)
        if (n >= 2) {
          const pay = Math.round(cfg.pay2 * lineBet * mult)
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

// Satu ronde bonus: reward dari pool (x taruhan saat combo 7, x winMult mode) + simbol tampilannya.
export function rollBonusRound(bet, mult = 1) {
  const total = SLOT.bonus.pool.reduce((s, p) => s + p.w, 0)
  let x = crypto.randomInt(0, total), pick = SLOT.bonus.pool[0]
  for (const p of SLOT.bonus.pool) { if ((x -= p.w) < 0) { pick = p; break } }
  return { reward: Math.round(pick.m * bet * mult), sym: SYM[pick.sym] ?? 0 }
}

// ===== Endpoint =====
const doc = r => (r && r.value !== undefined ? r.value : r) // findOneAndUpdate: driver baru mengembalikan dokumen, driver lama { value }
const TTL_MS = 24 * 360e3
const symId = i => SLOT.symbols[i]?.id || SLOT.symbols[0].id

export function mountSlot(router, { wrap, userFromReq, allow, col, ensureWallet }) {
  const need = async (req, res) => {
    const a = await userFromReq(req)
    if (!a) { res.status(401).json({ error: 'Sesi berakhir, masuk lagi.' }); return null }
    return a.user
  }
  const sid = u => u._id + ':slot'

  // Pastikan field `slot` berbentuk mode-demo/paid. Akun lama (field bal/combo/... langsung di
  // bawah `slot`) DIPINDAHKAN ke slot.demo dalam SATU update atomik (filter $exists menjaga progres
  // yang sudah termigrasi tidak diganggu). Tidak pernah menimpa `chips` (milik ekonomi).
  async function ensureSlot(u) {
    const s = u.slot
    if (s && typeof s.demo?.bal === 'number') return { ...slotStart(), ...s }
    const old = s || {}
    const demo = {
      bal: typeof old.bal === 'number' ? old.bal : SLOT.start,
      combo: old.combo || 0, bonus: old.bonus ?? null,
      spins: old.spins || 0, wins: old.wins || 0, best: old.best || 0, refAt: old.refAt || 0
    }
    const nu = { mode: modeOf(old), demo, paid: { ...paidStart(), ...(s?.paid || {}) } }
    await (await col('users')).updateOne(
      { _id: u._id, 'slot.demo': { $exists: false } },
      {
        $set: { 'slot.mode': nu.mode, 'slot.demo': demo, 'slot.paid': nu.paid },
        $unset: { 'slot.bal': '', 'slot.combo': '', 'slot.bonus': '', 'slot.spins': '', 'slot.wins': '', 'slot.best': '', 'slot.refAt': '' }
      }
    ).catch(() => { })
    return nu
  }

  // bentuk bonus untuk client (bet ikut supaya resume tahu patokannya; log = reward per ronde)
  const bonusView = b => (b && b.r != null ? { r: b.r, total: b.total || 0, bet: b.bet || 0, log: Array.isArray(b.log) ? b.log : [], done: !!b.done, rounds: SLOT.bonus.rounds } : null)

  async function histGet(u) {
    const s = await (await col('game_state')).findOne({ _id: sid(u) }).catch(() => null)
    const h = Array.isArray(s?.hist) ? s.hist : []
    return h.slice(-SLOT.histMax).reverse().map(x => ({ g: String(x.g || ''), bet: x.bet || 0, win: x.win || 0, combo: x.combo || 0, at: x.at, m: x.m === 'paid' ? 'paid' : 'demo' }))
  }
  const histPush = (u, h) => (async () => {
    await (await col('game_state')).updateOne(
      { _id: sid(u) },
      { $push: { hist: { $each: [h], $slice: -SLOT.histMax } }, $set: { exp: new Date(Date.now() + TTL_MS) } },
      { upsert: true }
    ).catch(() => { }) // riwayat kosmetik: kegagalan tidak boleh menggagalkan spin
  })()

  async function view(u, extra) {
    await ensureWallet(u) // akun lama tanpa coins/gems/chips tetap rapi
    const slot = await ensureSlot(u)
    const m = modeOf(slot)
    const sub = m === 'paid' ? { ...paidStart(), ...(slot.paid || {}) } : { ...demoStart(), ...(slot.demo || {}) }
    const bal = m === 'paid' ? (u.chips ?? 0) : (sub.bal ?? 0)
    const now = Date.now()
    return {
      ok: true,
      mode: m,
      cfg: {
        symbols: SLOT.symbols.map(s => ({ id: s.id, name: s.name, pay3: s.pay3, ...(s.pay2 ? { pay2: s.pay2 } : {}) })),
        lines: SLOT.lines, bets: SLOT.bets, start: SLOT.start,
        comboMax: SLOT.comboMax, bonusRounds: SLOT.bonus.rounds,
        refill: { amount: SLOT.refill.amount, cooldownMin: SLOT.refill.cooldownMin },
        paid: { winMult: SLOT.paid.winMult, coinPerChip: EXCHANGE.coinPerChip, chipPerCoin: EXCHANGE.chipPerCoin }
      },
      bal,
      bals: { demo: typeof slot.demo?.bal === 'number' ? slot.demo.bal : SLOT.start, paid: u.chips ?? 0, coins: u.coins ?? 0 },
      combo: sub.combo || 0, bonus: bonusView(sub.bonus),
      spins: sub.spins || 0, wins: sub.wins || 0, best: sub.best || 0,
      refillAt: sub.refAt ? sub.refAt + SLOT.refill.cooldownMin * 60e3 : 0,
      refillReady: m !== 'paid' && (sub.bal ?? 0) < Math.min(...SLOT.bets) && now >= (sub.refAt ? sub.refAt + SLOT.refill.cooldownMin * 60e3 : 0),
      hist: await histGet(u),
      ...extra
    }
  }

  // ---- Keadaan (dipakai saat masuk layar & memulihkan Bonus Session / ringkasan) ----
  // body { clear:true } = buang bonus yang sudah selesai. body { mode } = pindah mode Demo <-> Paid
  // (ditolak selama Bonus Session mode yang sekarang masih berjalan).
  router.post('/api/auth/slot', wrap(async (req, res) => {
    const u = await need(req, res); if (!u) return
    if (!(await allow('slt:' + u._id, 60, 60))) return res.status(429).json({ error: 'Terlalu sering, tunggu sebentar.' })
    const users = await col('users')
    const want = req.body?.mode
    let cur = u
    if (want === 'demo' || want === 'paid') {
      const slot = await ensureSlot(cur)
      const from = modeOf(slot)
      if (want !== from) {
        // Pindah mode hanya kalau Bonus Session mode lama TIDAK sedang berjalan (null atau sudah done).
        // Filter 'slot.mode' menjaga dua permintaan paralel tidak saling menimpa.
        const nu = doc(await users.findOneAndUpdate(
          { _id: u._id, 'slot.mode': from, $or: [{ [SUB(from) + '.bonus']: null }, { [SUB(from) + '.bonus.done']: true }] },
          { $set: { 'slot.mode': want } },
          { returnDocument: 'after' }
        ))
        if (!nu) return res.status(409).json({ ...(await view(cur)), ok: false, error: 'Selesaikan Bonus Session dulu sebelum pindah mode.' })
        cur = nu
      }
    } else if (req.body?.clear && u.slot?.[modeOf(u.slot)]?.bonus?.done) { // bonus sudah diringkas pemain: bersihkan supaya bisa spin lagi
      const m = modeOf(u.slot)
      cur = doc(await users.findOneAndUpdate({ _id: u._id, [SUB(m) + '.bonus.done']: true }, { $set: { [SUB(m) + '.bonus']: null } }, { returnDocument: 'after' })) || u
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
    if (typeof u.chips !== 'number') await ensureWallet(u) // mode Paid butuh field chips ada (akun lama)

    // Optimistic concurrency: filter menyertakan combo (dan bonus null) yang dibaca. Dua spin
    // paralel -> salah satu harus mengulang, jadi combo tidak bisa dilompati lewat race.
    let nu = null, out = null
    for (let attempt = 0; attempt < 3 && !nu; attempt++) {
      const cur = (attempt ? await users.findOne({ _id: u._id }) : u) || u
      const m = modeOf(cur.slot)
      const sub = m === 'paid' ? { ...paidStart(), ...(cur.slot?.paid || {}) } : { ...demoStart(), ...(cur.slot?.demo || {}) }
      const bal = m === 'paid' ? (cur.chips ?? 0) : sub.bal
      if (sub.bonus) return res.status(409).json({ error: 'Selesaikan Bonus Session dulu.' })
      if (bal < bet) return res.status(409).json({ ...(await view(cur)), ok: false, error: m === 'paid' ? 'Chip kamu belum cukup — beli Chip pakai Coin dulu.' : 'Saldo virtual point kamu belum cukup.' })
      const mult = winMult(m)
      const grid = rollGrid()
      const ev = evalGrid(grid, bet, mult)
      const combo = comboNext(sub.combo, ev.win)
      const bonusHit = combo >= SLOT.comboMax
      const set = { [SUB(m) + '.combo']: combo }
      if (bonusHit) set[SUB(m) + '.bonus'] = { r: 0, total: 0, bet, log: [] } // taruhan terkunci saat combo 7 tercapai
      const inc = { [BAL(m)]: ev.win - bet, [SUB(m) + '.spins']: 1 }
      if (ev.win > 0) inc[SUB(m) + '.wins'] = 1
      nu = doc(await users.findOneAndUpdate(
        { _id: u._id, [BAL(m)]: { $gte: bet }, [SUB(m) + '.combo']: sub.combo, [SUB(m) + '.bonus']: null },
        { $inc: inc, $set: set, $max: { [SUB(m) + '.best']: ev.win } },
        { returnDocument: 'after' }
      ))
      if (nu) out = { m, grid, ev, combo, bonusHit }
    }
    if (!nu) return res.status(503).json({ ok: false, error: 'Server sibuk, coba putar lagi.' }) // race combo jarang: suruh ulang

    await histPush(u, { g: out.grid.join(''), bet, win: out.ev.win, combo: out.combo, at: Date.now(), m: out.m })
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
    const m = modeOf(cur.slot)
    const b = (m === 'paid' ? cur.slot?.paid : cur.slot?.demo)?.bonus
    if (!b || b.done || b.r >= SLOT.bonus.rounds) return res.status(409).json({ ...(await view(cur)), ok: false, error: 'Bonus Session tidak sedang berjalan.' })
    const round = rollBonusRound(b.bet, winMult(m))
    const log = [...(Array.isArray(b.log) ? b.log : []), round.reward]
    const total = (b.total || 0) + round.reward
    const final = b.r + 1 >= SLOT.bonus.rounds
    // filter 'slot.<mode>.bonus.r' == ronde yang dibaca: dua permintaan paralel tidak bisa memajukan
    // ronde yang sama dua kali, dan penggandaan total tidak mungkin. Ronde terakhir: saldo += TOTAL
    // dan combo reset 0 (progresi baru setelah bonus) di operasi YANG SAMA.
    const nu = doc(await users.findOneAndUpdate(
      { _id: u._id, [SUB(m) + '.bonus.r']: b.r },
      final
        ? { $inc: { [BAL(m)]: total }, $set: { [SUB(m) + '.bonus']: { r: b.r + 1, total, bet: b.bet, log, done: true }, [SUB(m) + '.combo']: 0 } }
        : { $inc: { [SUB(m) + '.bonus.r']: 1, [SUB(m) + '.bonus.total']: round.reward }, $push: { [SUB(m) + '.bonus.log']: round.reward } },
      { returnDocument: 'after' }
    ))
    if (!nu) return res.status(409).json({ ...(await view(cur)), ok: false, error: 'Ronde bonus sudah maju, muat ulang.' })
    await histPush(u, { g: 'bonus', bet: 0, win: round.reward, combo: SLOT.comboMax, at: Date.now(), m })
    res.json({ ...(await view(nu)), ok: true, r: b.r + 1, reward: round.reward, sym: symId(round.sym), total, done: final, bal: m === 'paid' ? (nu.chips ?? 0) : (nu.slot?.demo?.bal ?? 0), log })
  }))

  // ---- Isi ulang VP gratis (HANYA mode Demo): butuh bangkrut + masa tenang sudah lewat ----
  router.post('/api/auth/slot/refill', wrap(async (req, res) => {
    const u = await need(req, res); if (!u) return
    if (!(await allow('sltr:' + u._id, 4, 3600))) return res.status(429).json({ error: 'Terlalu sering, tunggu sebentar.' })
    const users = await col('users')
    const slot = await ensureSlot(u)
    if (modeOf(slot) === 'paid') return res.status(409).json({ ...(await view(u)), ok: false, error: 'Mode Paid tidak ada isi ulang gratis — beli Chip pakai Coin.' })
    const minBet = Math.min(...SLOT.bets), now = Date.now()
    const nu = doc(await users.findOneAndUpdate(
      { _id: u._id, 'slot.demo.bal': { $lt: minBet }, 'slot.demo.refAt': { $lte: now - SLOT.refill.cooldownMin * 60e3 } },
      { $set: { 'slot.demo.bal': SLOT.refill.amount, 'slot.demo.refAt': now } },
      { returnDocument: 'after' }
    ))
    if (!nu) {
      const cur = (await users.findOne({ _id: u._id })) || u
      const d = cur.slot?.demo
      const tunggu = Math.max(0, Math.ceil(((d?.refAt || 0) + SLOT.refill.cooldownMin * 60e3 - now) / 60e3))
      return res.status(409).json({ ...(await view(cur)), ok: false, error: (d?.bal ?? 0) >= minBet ? 'Saldo kamu masih cukup untuk bermain.' : `Isi ulang tersedia lagi dalam ${tunggu} menit.` })
    }
    res.json({ ...(await view(nu)), ok: true, refilled: SLOT.refill.amount })
  }))
}
