import crypto from 'node:crypto'
import { ensureIndexes } from './mongo.js'
import { dayNum } from './bonus.js'
import { track } from './quests.js'
import { bump } from './leaderboard.js'

// Minigame yang bisa menghasilkan coin. Semua hasil (angka rahasia, penilaian tebakan, hadiah, saldo) diputuskan di sini;
// client cuma menampilkan. Dipasang ke router auth (lib/auth.js) lewat mountGames(), jadi memakai sesi/token, pembatas laju,
// dan koleksi `users` yang sama dengan bonus.
//
// Game 1: TEBAK ANGKA. Server memilih angka rahasia 1-100, pemain punya 7 tebakan dan tiap tebakan dijawab "lebih besar/kecil".
//   Dengan cara membagi dua, angka selalu bisa ketemu dalam 7 tebakan. Makin sedikit tebakan, makin besar hadiah.
//
// Endpoint (POST, token Bearer, jawaban JSON):
//   /api/auth/game        -> { ok, cfg, daily:{wins,cap}, game|null, coins, gems }   keadaan terakhir (untuk memulihkan layar)
//   /api/auth/game/start  -> { ok, ... }  sama seperti di atas, permainan baru (yang belum selesai dibuang)
//   /api/auth/game/guess  -> { ok, result:'up'|'down'|'win'|'lose', reward, capped, ... }   body { n }
//
// Koleksi baru `game_state`  { _id: "<userId>:guess", userId, secret, hist:[{n, r}], done, won, reward, exp }   (TTL 24 jam, hapus otomatis)
// Field tambahan di `users`  gameDay (hari WIB terakhir menang berhadiah), gameWins (jumlah kemenangan berhadiah di hari itu)

// ===== Atur permainan & hadiah di sini =====
export const GUESS = {
  min: 1, max: 100,
  rewards: [50, 50, 50, 40, 30, 20, 10], // coin menurut jumlah tebakan yang dipakai (indeks 0 = menang di tebakan ke-1). Panjang array = jumlah tebakan maksimal
  dailyWins: 5                           // maksimal kemenangan BERHADIAH per hari (WIB). Setelah itu tetap bisa main, tanpa hadiah (anti farming)
}
const TRIES = GUESS.rewards.length
const TTL_MS = 24 * 3600e3

export function mountGames(router, { wrap, userFromReq, allow, col, ensureWallet }) {
  const doc = r => (r && r.value !== undefined ? r.value : r) // findOneAndUpdate: driver baru mengembalikan dokumen, driver lama { value }
  let idx
  const ready = () => idx ??= ensureIndexes('game_state', [[{ exp: 1 }, { expireAfterSeconds: 0 }]]).catch(e => { idx = null; throw e })
  const need = async (req, res) => {
    const a = await userFromReq(req)
    if (!a) { res.status(401).json({ error: 'Sesi berakhir, masuk lagi.' }); return null }
    await ready()
    return a.user
  }
  const sid = u => u._id + ':guess'

  // rentang yang masih mungkin, dari riwayat tebakan
  function range(hist) {
    let lo = GUESS.min, hi = GUESS.max
    for (const h of hist) { if (h.r === 'up') lo = Math.max(lo, h.n + 1); else if (h.r === 'down') hi = Math.min(hi, h.n - 1) }
    return { lo, hi }
  }
  const winsToday = u => (u.gameDay === dayNum(Date.now()) ? u.gameWins || 0 : 0)

  // bentuk permainan untuk client. Angka rahasia HANYA dikirim kalau permainan sudah kalah.
  function gameView(s) {
    if (!s) return null
    const hist = s.hist || [], r = range(hist)
    return { active: !s.done, won: !!s.won, tries: hist.length, hist, lo: r.lo, hi: r.hi, reward: s.reward || 0, ...(s.done && !s.won ? { secret: s.secret } : {}) }
  }
  async function view(u, s) {
    const w = await ensureWallet(u)
    return { ok: true, cfg: { min: GUESS.min, max: GUESS.max, rewards: GUESS.rewards }, daily: { wins: winsToday(u), cap: GUESS.dailyWins }, game: gameView(s), coins: w.coins, gems: w.gems }
  }

  router.post('/api/auth/game', wrap(async (req, res) => {
    const u = await need(req, res); if (!u) return
    if (!(await allow('gm:' + u._id, 60, 60))) return res.status(429).json({ error: 'Terlalu sering, tunggu sebentar.' })
    res.json(await view(u, await (await col('game_state')).findOne({ _id: sid(u) })))
  }))

  router.post('/api/auth/game/start', wrap(async (req, res) => {
    const u = await need(req, res); if (!u) return
    if (!(await allow('gms:' + u._id, 20, 60))) return res.status(429).json({ error: 'Terlalu sering, tunggu sebentar.' })
    const s = { _id: sid(u), userId: u._id, secret: GUESS.min + crypto.randomInt(GUESS.max - GUESS.min + 1), hist: [], done: false, won: false, reward: 0, exp: new Date(Date.now() + TTL_MS) }
    await (await col('game_state')).replaceOne({ _id: s._id }, s, { upsert: true })
    res.json(await view(u, s))
  }))

  router.post('/api/auth/game/guess', wrap(async (req, res) => {
    const u = await need(req, res); if (!u) return
    if (!(await allow('gmg:' + u._id, 60, 60))) return res.status(429).json({ error: 'Terlalu sering, tunggu sebentar.' })
    const n = Number(req.body?.n)
    if (!Number.isInteger(n) || n < GUESS.min || n > GUESS.max) return res.status(400).json({ error: `Tebak angka bulat ${GUESS.min}-${GUESS.max}.` })
    const states = await col('game_state'), s = await states.findOne({ _id: sid(u) })
    if (!s || s.done) return res.status(409).json({ error: 'Mulai permainan baru dulu.' })
    const tries = s.hist.length
    if (s.hist.some(h => h.n === n)) return res.status(400).json({ error: 'Angka itu sudah kamu tebak.' })
    const r = n === s.secret ? 'win' : n < s.secret ? 'up' : 'down' // 'up' = angkanya LEBIH BESAR dari tebakan
    const used = tries + 1, done = r === 'win' || used >= TRIES
    // penjaga atomik: hanya satu tebakan yang lolos untuk tiap jumlah tebakan, jadi dua permintaan bersamaan tidak bisa menang dua kali
    const ns = doc(await states.findOneAndUpdate(
      { _id: s._id, done: false, hist: { $size: tries } },
      { $push: { hist: { n, r } }, $set: { done, won: r === 'win' } },
      { returnDocument: 'after' }
    ))
    if (!ns) return res.status(409).json({ error: 'Permainan berubah, tebak lagi.' })

    await bump(col, u._id, { guessTries: 1, ...(done ? { guessPlayed: 1 } : {}), ...(r === 'win' ? { guessWon: 1 } : {}) }) // peringkat: tebakan dijawab / permainan / menang
    let reward = 0, capped = false, cu = u
    if (r === 'win') {
      const users = await col('users'), today = dayNum(Date.now()), prize = GUESS.rewards[used - 1]
      await ensureWallet(u) // akun lama tanpa saldo: isi saldo awal dulu supaya $inc tidak menggantikannya
      await users.updateOne({ _id: u._id, gameDay: { $ne: today } }, { $set: { gameDay: today, gameWins: 0 } }) // hari baru: reset hitungan
      const nu = doc(await users.findOneAndUpdate({ _id: u._id, gameDay: today, gameWins: { $lt: GUESS.dailyWins } }, { $inc: { coins: prize, gameWins: 1 } }, { returnDocument: 'after' }))
      if (nu) { reward = prize; cu = nu; ns.reward = prize; await states.updateOne({ _id: s._id }, { $set: { reward: prize } }) }
      else { capped = true; cu = await users.findOne({ _id: u._id }) || u }
    }
    // misi harian + piala: menang tercatat walau hadiahnya sudah mentok batas harian (menangnya tetap menang)
    const nq = r === 'win' ? await track(col, cu, 'win') : []
    res.json({ ...(await view(cu, ns)), result: r === 'win' ? 'win' : done ? 'lose' : r, reward, capped, ...(nq.length ? { nq } : {}) })
  }))
}
