import crypto from 'node:crypto'
import { ensureIndexes } from './mongo.js'
import { dayNum } from './bonus.js'
import { track } from './quests.js'
import { bump } from './leaderboard.js'

// Minigame 2048. Papan, tile baru (acak), skor, dan hadiah diputuskan di sini; client (public/g2048.js) hanya menampilkan
// dan mengirim arah geser. Dipasang ke router auth (lib/auth.js) lewat mountG2048(), jadi memakai sesi/token, pembatas laju,
// dan koleksi `users` yang sama dengan game lain.
//
// Aturan: papan 4x4, geser ke atas/bawah/kiri/kanan, dua tile sama bergabung jadi dua kali lipat. Tiap geser yang menggeser
// sesuatu memunculkan satu tile baru (2 dengan peluang 90%, 4 dengan 10%). Tile 2048 = menang (permainan boleh lanjut demi skor).
// Selesai kalau papan penuh dan tidak ada gabungan yang mungkin.
//
// Hadiah: tiap tile target (128, 256, ...) yang BARU pertama kali tercapai dalam satu permainan memberi coin sekali.
//   Total coin dari 2048 dibatasi per hari (WIB) supaya tidak bisa di-farm lewat skrip.
//
// Endpoint (POST, token Bearer, jawaban JSON):
//   /api/auth/g2048        -> { ok, cfg, daily:{coins,cap}, best, game|null, coins, gems }   keadaan terakhir (pulihkan layar)
//   /api/auth/g2048/start  -> { ok, ... }  permainan baru (yang belum selesai dibuang)
//   /api/auth/g2048/move   -> { ok, moved, spawn:{r,c,v}|null, gain:[{tile,coin}], capped, ... }   body { d: 'up'|'down'|'left'|'right' }
//
// Koleksi `game_state`  { _id: "<userId>:g2048", userId, b:[16 angka], score, moves, over, won, max, claimed:[tile...], earned, exp }  (TTL 24 jam)
// Field tambahan di `users`  g48Day, g48Coins (coin dari 2048 di hari itu), g48Best (skor terbaik), g48Max (tile terbesar)

// ===== Atur permainan & hadiah di sini =====
export const G2048 = {
  size: 4,
  rewards: { 128: 10, 256: 25, 512: 60, 1024: 120, 2048: 250 }, // coin sekali per tile target per permainan
  dailyCoins: 400                                                // batas total coin dari 2048 per hari (WIB). Lewat itu tetap bisa main, tanpa coin
}
const N = G2048.size, CELLS = N * N, TTL_MS = 24 * 3600e3
const DIRS = new Set(['up', 'down', 'left', 'right'])

// ---------- logika papan (murni, dipakai juga oleh tes) ----------
// geser satu baris ke arah awal indeks. Mengembalikan { line, score }
export function slideLine(line) {
  const t = line.filter(Boolean), out = []
  let score = 0
  for (let i = 0; i < t.length; i++) {
    if (t[i] === t[i + 1]) { out.push(t[i] * 2); score += t[i] * 2; i++ } else out.push(t[i])
  }
  while (out.length < N) out.push(0)
  return { line: out, score }
}
// indeks sel untuk baris/kolom ke-k menurut arah, urut dari sisi tujuan geser
function lineIdx(d, k) {
  const a = []
  for (let i = 0; i < N; i++) {
    if (d === 'left') a.push(k * N + i)
    else if (d === 'right') a.push(k * N + (N - 1 - i))
    else if (d === 'up') a.push(i * N + k)
    else a.push((N - 1 - i) * N + k)
  }
  return a
}
export function moveBoard(b, d) {
  const nb = b.slice()
  let score = 0, moved = false
  for (let k = 0; k < N; k++) {
    const idx = lineIdx(d, k), r = slideLine(idx.map(i => b[i]))
    score += r.score
    idx.forEach((ci, j) => { if (nb[ci] !== r.line[j]) moved = true; nb[ci] = r.line[j] })
  }
  return { b: nb, score, moved }
}
export const canMove = b => b.includes(0) || ['up', 'left'].some(d => moveBoard(b, d).moved) // gabungan horizontal & vertikal cukup dicek dari dua arah
function spawn(b) {
  const empty = []
  b.forEach((v, i) => { if (!v) empty.push(i) })
  if (!empty.length) return null
  const i = empty[crypto.randomInt(empty.length)], v = crypto.randomInt(10) === 0 ? 4 : 2
  b[i] = v
  return { r: Math.floor(i / N), c: i % N, v }
}
export function newBoard() { const b = new Array(CELLS).fill(0); spawn(b); spawn(b); return b }

export function mountG2048(router, { wrap, userFromReq, allow, col, ensureWallet, ensureIndexes: ensureIdx = ensureIndexes }) { // ensureIdx bisa disuntik (tes tanpa MongoDB)
  const doc = r => (r && r.value !== undefined ? r.value : r) // findOneAndUpdate: driver baru mengembalikan dokumen, driver lama { value }
  let idx
  const ready = () => idx ??= ensureIdx('game_state', [[{ exp: 1 }, { expireAfterSeconds: 0 }]]).catch(e => { idx = null; throw e })
  const need = async (req, res) => {
    const a = await userFromReq(req)
    if (!a) { res.status(401).json({ error: 'Sesi berakhir, masuk lagi.' }); return null }
    await ready()
    return a.user
  }
  const sid = u => u._id + ':g2048'
  const coinsToday = u => (u.g48Day === dayNum(Date.now()) ? u.g48Coins || 0 : 0)

  const gameView = s => s ? { active: !s.over, over: !!s.over, won: !!s.won, b: s.b, score: s.score || 0, moves: s.moves || 0, max: s.max || 0, earned: s.earned || 0 } : null
  async function view(u, s) {
    const w = await ensureWallet(u)
    return {
      ok: true,
      cfg: { size: N, rewards: G2048.rewards },
      daily: { coins: coinsToday(u), cap: G2048.dailyCoins },
      best: u.g48Best || 0, bestTile: u.g48Max || 0,
      game: gameView(s), coins: w.coins, gems: w.gems
    }
  }

  router.post('/api/auth/g2048', wrap(async (req, res) => {
    const u = await need(req, res); if (!u) return
    if (!(await allow('g48:' + u._id, 60, 60))) return res.status(429).json({ error: 'Terlalu sering, tunggu sebentar.' })
    res.json(await view(u, await (await col('game_state')).findOne({ _id: sid(u) })))
  }))

  router.post('/api/auth/g2048/start', wrap(async (req, res) => {
    const u = await need(req, res); if (!u) return
    if (!(await allow('g48s:' + u._id, 20, 60))) return res.status(429).json({ error: 'Terlalu sering, tunggu sebentar.' })
    const s = { _id: sid(u), userId: u._id, b: newBoard(), score: 0, moves: 0, over: false, won: false, max: 2, claimed: [], earned: 0, exp: new Date(Date.now() + TTL_MS) }
    await (await col('game_state')).replaceOne({ _id: s._id }, s, { upsert: true })
    res.json(await view(u, s))
  }))

  router.post('/api/auth/g2048/move', wrap(async (req, res) => {
    const u = await need(req, res); if (!u) return
    if (!(await allow('g48m:' + u._id, 400, 60))) return res.status(429).json({ error: 'Terlalu cepat, tunggu sebentar.' })
    const d = String(req.body?.d || '')
    if (!DIRS.has(d)) return res.status(400).json({ error: 'Arah tidak dikenal.' })
    const states = await col('game_state'), s = await states.findOne({ _id: sid(u) })
    if (!s || s.over) return res.status(409).json({ error: 'Mulai permainan baru dulu.' })

    const m = moveBoard(s.b, d)
    if (!m.moved) return res.json({ ...(await view(u, s)), moved: false, spawn: null, gain: [], capped: false }) // geseran tidak mengubah apa pun: tidak ada tile baru

    const nb = m.b, sp = spawn(nb)
    const score = (s.score || 0) + m.score, max = Math.max(s.max || 0, ...nb), over = !canMove(nb)
    const won = !!s.won || max >= 2048
    const fresh = Object.keys(G2048.rewards).map(Number).filter(t => max >= t && !(s.claimed || []).includes(t))
    // penjaga atomik: hanya satu geseran yang lolos untuk tiap nomor langkah, jadi dua permintaan bersamaan tidak bisa mengklaim ganda
    const ns = doc(await states.findOneAndUpdate(
      { _id: s._id, over: false, moves: s.moves || 0 },
      { $set: { b: nb, score, max, over, won }, $inc: { moves: 1 }, $addToSet: { claimed: { $each: fresh } } },
      { returnDocument: 'after' }
    ))
    if (!ns) return res.status(409).json({ error: 'Permainan berubah, geser lagi.' })

    const users = await col('users'), today = dayNum(Date.now())
    let cu = u, gain = [], capped = false
    if (fresh.length) {
      await ensureWallet(u)
      await users.updateOne({ _id: u._id, g48Day: { $ne: today } }, { $set: { g48Day: today, g48Coins: 0 } }) // hari baru: reset hitungan
      let left = G2048.dailyCoins
      const now = doc(await users.findOne({ _id: u._id })); if (now && now.g48Day === today) left = Math.max(0, G2048.dailyCoins - (now.g48Coins || 0))
      for (const t of fresh) {
        const prize = Math.min(G2048.rewards[t], left)
        if (prize <= 0) { capped = true; continue }
        // batas harian dijaga atomik di filter: dua tile target bersamaan / dua perangkat tidak bisa melewati batas
        const nu = doc(await users.findOneAndUpdate(
          { _id: u._id, g48Day: today, g48Coins: { $lte: G2048.dailyCoins - prize } },
          { $inc: { coins: prize, g48Coins: prize } }, { returnDocument: 'after' }
        ))
        if (nu) { cu = nu; left -= prize; gain.push({ tile: t, coin: prize }); ns.earned = (ns.earned || 0) + prize } else capped = true
      }
      if (gain.length) await states.updateOne({ _id: s._id }, { $set: { earned: ns.earned } })
    }

    // skor terbaik & tile terbesar (hanya naik)
    const set = {}
    if (score > (cu.g48Best || 0)) set.g48Best = score
    if (max > (cu.g48Max || 0)) set.g48Max = max
    if (Object.keys(set).length) { await users.updateOne({ _id: u._id }, { $set: set }); cu = { ...cu, ...set } }

    // peringkat + misi: permainan selesai tercatat sekali; "menang" (tile 2048) tercatat sekali per permainan
    if (over) await bump(col, u._id, { g48Played: 1 })
    const justWon = won && !s.won
    if (justWon) await bump(col, u._id, { g48Won: 1 })
    const nq = justWon ? await track(col, cu, 'win') : []

    res.json({ ...(await view(cu, ns)), moved: true, spawn: sp, gain, capped, ...(nq.length ? { nq } : {}) })
  }))
}
