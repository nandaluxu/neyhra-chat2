import crypto from 'node:crypto'
import path from 'node:path'
import { readFile, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { ensureIndexes } from './mongo.js'
import { dayNum } from './bonus.js'
import { track } from './quests.js'
import { bump } from './leaderboard.js'

// Game "Tebak Gambar". Soal dibaca dari data/tebakgambar.json (lihat bentuknya di README). Jawaban, penilaian, hadiah, dan saldo
// diputuskan di sini; client cuma menampilkan. Dipasang ke router auth (lib/auth.js) lewat mountPic().
//
// Endpoint (POST, token Bearer, jawaban JSON):
//   /api/auth/pic         -> { ok, cfg, daily:{wins,cap}, total, game|null, coins, gems }   keadaan terakhir (memulihkan layar)
//   /api/auth/pic/start   -> { ok, ... }  soal baru. Kalau soal yang lama belum selesai, soal itu yang dikembalikan.
//                            body { skip:true } = lewati soal yang sedang dimainkan, ambil soal lain (tanpa hadiah)
//   /api/auth/pic/guess   -> { ok, result:'win'|'wrong'|'lose', reward, capped, ... }   body { t }
//   /api/auth/pic/hint    -> { ok, ... }  buka petunjuk (isi "deskripsi" soal), hadiah soal itu dikurangi
//
// Koleksi `game_state` (sama dengan Tebak Angka, TTL 24 jam): { _id: "<userId>:pic", userId, id, hist:[{t}], hint, done, won, reward, exp }
// Field tambahan di `users`: picDay, picWins (kemenangan berhadiah hari ini, WIB), picDone (id soal yang sudah selesai/dilewati)
// Jawaban dan deskripsi TIDAK dikirim ke client sampai soal selesai (deskripsi juga dikirim kalau petunjuk dibuka).

// ===== Atur game & hadiah di sini =====
export const PIC = {
  tries: 5,          // jumlah kesempatan menjawab per soal
  base: 40,          // coin kalau benar di jawaban pertama
  perWrong: 5,       // pengurangan coin per jawaban salah sebelumnya
  min: 10,           // coin paling sedikit untuk jawaban benar (tanpa petunjuk)
  hintMult: 0.5,     // kalau petunjuk dibuka, coin dikali ini (dibulatkan, tidak kurang dari `hintMin`)
  hintMin: 5,
  dailyWins: 10      // maksimal kemenangan BERHADIAH per hari (WIB). Setelah itu tetap bisa main, tanpa hadiah (anti farming)
}
const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'tebakgambar.json')
const TTL_MS = 24 * 3600e3
const MAX_DONE = 5000 // batas panjang daftar soal selesai per user

const norm = t => String(t ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z0-9]/g, '')
export const prizeFor = (wrong, hint) => {
  const p = Math.max(PIC.min, PIC.base - PIC.perWrong * wrong)
  return hint ? Math.max(PIC.hintMin, Math.round(p * PIC.hintMult)) : p
}

// ---- soal: dibaca dari file, di-cache, dibaca ulang otomatis kalau file berubah (enak buat lokal). Entri yang rusak dilewati.
let cache = null
async function questions() {
  const mt = (await stat(FILE)).mtimeMs
  if (cache && cache.mt === mt) return cache.list
  const raw = JSON.parse(await readFile(FILE, 'utf8'))
  const arr = Array.isArray(raw) ? raw : Array.isArray(raw?.soal) ? raw.soal : []
  const seen = new Set(), list = []
  arr.forEach((e, i) => {
    const id = Number.isInteger(e?.index) ? e.index : i
    const img = String(e?.img ?? '').trim(), ans = String(e?.jawaban ?? '').trim(), key = norm(ans)
    if (seen.has(id) || !/^https?:\/\/\S+$/i.test(img) || !key || ans.length > 60) return
    seen.add(id)
    const words = ans.split(/\s+/).map(w => norm(w).length).filter(Boolean) // pola huruf per kata, mis. [9, 4]
    list.push({ id, img, answer: ans.toUpperCase(), key, pattern: words, clue: String(e?.deskripsi ?? '').trim().slice(0, 300) })
  })
  cache = { mt, list }
  return list
}

export function mountPic(router, { wrap, userFromReq, allow, col, ensureWallet }) {
  const doc = r => (r && r.value !== undefined ? r.value : r) // findOneAndUpdate: driver baru mengembalikan dokumen, driver lama { value }
  let idx
  const ready = () => idx ??= ensureIndexes('game_state', [[{ exp: 1 }, { expireAfterSeconds: 0 }]]).catch(e => { idx = null; throw e })
  const need = async (req, res) => {
    const a = await userFromReq(req)
    if (!a) { res.status(401).json({ error: 'Sesi berakhir, masuk lagi.' }); return null }
    await ready()
    return a.user
  }
  const sid = u => u._id + ':pic'
  const winsToday = u => (u.picDay === dayNum(Date.now()) ? u.picWins || 0 : 0)
  const byId = (list, id) => list.find(q => q.id === id)

  // bentuk soal untuk client. Jawaban hanya dikirim kalau soal sudah selesai, petunjuk hanya kalau sudah dibuka atau soal selesai.
  function gameView(s, list) {
    const q = s && byId(list, s.id)
    if (!q) return null
    const hist = (s.hist || []).map(h => ({ t: h.t })), wrong = hist.length - (s.won ? 1 : 0)
    return {
      active: !s.done, won: !!s.won, id: q.id, img: q.img, pattern: q.pattern, tries: hist.length, maxTries: PIC.tries, hist,
      hasClue: !!q.clue, hint: !!s.hint, prize: prizeFor(Math.max(0, wrong), !!s.hint), reward: s.reward || 0,
      ...(s.hint || s.done ? { clue: q.clue } : {}),
      ...(s.done ? { answer: q.answer } : {})
    }
  }
  async function view(u, s, list) {
    const w = await ensureWallet(u)
    return { ok: true, cfg: { tries: PIC.tries, base: PIC.base, min: PIC.min }, daily: { wins: winsToday(u), cap: PIC.dailyWins }, total: list.length, game: gameView(s, list), coins: w.coins, gems: w.gems }
  }
  const noQ = res => res.status(503).json({ error: 'Belum ada soal tebak gambar.' })
  const done = u => (Array.isArray(u.picDone) ? u.picDone : [])

  router.post('/api/auth/pic', wrap(async (req, res) => {
    const u = await need(req, res); if (!u) return
    if (!(await allow('pc:' + u._id, 60, 60))) return res.status(429).json({ error: 'Terlalu sering, tunggu sebentar.' })
    const list = await questions()
    res.json(await view(u, await (await col('game_state')).findOne({ _id: sid(u) }), list))
  }))

  router.post('/api/auth/pic/start', wrap(async (req, res) => {
    const u = await need(req, res); if (!u) return
    if (!(await allow('pcs:' + u._id, 30, 60))) return res.status(429).json({ error: 'Terlalu sering, tunggu sebentar.' })
    const list = await questions(); if (!list.length) return noQ(res)
    const states = await col('game_state'), users = await col('users')
    const cur = await states.findOne({ _id: sid(u) }), curQ = cur && !cur.done ? byId(list, cur.id) : null
    if (curQ && !req.body?.skip) return res.json(await view(u, cur, list)) // soal lama belum selesai: lanjutkan, bukan ganti
    let skipped = u
    if (curQ) skipped = doc(await users.findOneAndUpdate({ _id: u._id }, { $addToSet: { picDone: curQ.id } }, { returnDocument: 'after' })) || u // dilewati = tidak muncul lagi
    let seen = new Set(done(skipped))
    let pool = list.filter(q => !seen.has(q.id) && q.id !== curQ?.id)
    if (!pool.length) { // semua soal sudah selesai: mulai putaran baru (hadiah tetap dibatasi batas harian)
      await users.updateOne({ _id: u._id }, { $set: { picDone: [] } }); seen = new Set()
      pool = list.length > 1 ? list.filter(q => q.id !== curQ?.id) : list
    }
    const q = pool[crypto.randomInt(pool.length)]
    const s = { _id: sid(u), userId: u._id, id: q.id, hist: [], hint: false, done: false, won: false, reward: 0, exp: new Date(Date.now() + TTL_MS) }
    await states.replaceOne({ _id: s._id }, s, { upsert: true })
    res.json(await view(skipped, s, list))
  }))

  router.post('/api/auth/pic/hint', wrap(async (req, res) => {
    const u = await need(req, res); if (!u) return
    if (!(await allow('pch:' + u._id, 30, 60))) return res.status(429).json({ error: 'Terlalu sering, tunggu sebentar.' })
    const list = await questions(), states = await col('game_state')
    const s = await states.findOne({ _id: sid(u) })
    if (!s || s.done || !byId(list, s.id)) return res.status(409).json({ error: 'Mulai soal dulu.' })
    const q = byId(list, s.id)
    if (!q.clue) return res.status(409).json({ error: 'Soal ini tidak punya petunjuk.' })
    const ns = doc(await states.findOneAndUpdate({ _id: s._id, done: false }, { $set: { hint: true } }, { returnDocument: 'after' })) || s
    res.json(await view(u, ns, list))
  }))

  router.post('/api/auth/pic/guess', wrap(async (req, res) => {
    const u = await need(req, res); if (!u) return
    if (!(await allow('pcg:' + u._id, 60, 60))) return res.status(429).json({ error: 'Terlalu sering, tunggu sebentar.' })
    const raw = String(req.body?.t ?? '').trim(), key = norm(raw)
    if (!key || raw.length > 80) return res.status(400).json({ error: 'Isi jawabanmu dulu.' })
    const list = await questions(), states = await col('game_state')
    const s = await states.findOne({ _id: sid(u) }), q = s && byId(list, s.id)
    if (!s || s.done || !q) return res.status(409).json({ error: 'Mulai soal dulu.' })
    if (s.hist.some(h => norm(h.t) === key)) return res.status(400).json({ error: 'Jawaban itu sudah kamu coba.' })
    const tries = s.hist.length, used = tries + 1, win = key === q.key, fin = win || used >= PIC.tries
    // penjaga atomik: hanya satu jawaban yang lolos untuk tiap jumlah percobaan, jadi dua permintaan bersamaan tidak bisa menang dua kali
    const ns = doc(await states.findOneAndUpdate(
      { _id: s._id, done: false, hist: { $size: tries } },
      { $push: { hist: { t: raw.slice(0, 40) } }, $set: { done: fin, won: win } },
      { returnDocument: 'after' }
    ))
    if (!ns) return res.status(409).json({ error: 'Soal berubah, coba lagi.' })

    await bump(col, u._id, { picTries: 1, ...(fin ? { picPlayed: 1 } : {}), ...(win ? { picWon: 1 } : {}) }) // peringkat
    let reward = 0, capped = false, cu = u
    const users = await col('users')
    if (win) {
      const today = dayNum(Date.now()), prize = prizeFor(tries, !!s.hint)
      await ensureWallet(u) // akun lama tanpa saldo: isi saldo awal dulu supaya $inc tidak menggantikannya
      await users.updateOne({ _id: u._id, picDay: { $ne: today } }, { $set: { picDay: today, picWins: 0 } }) // hari baru: reset hitungan
      const nu = doc(await users.findOneAndUpdate({ _id: u._id, picDay: today, picWins: { $lt: PIC.dailyWins } }, { $inc: { coins: prize, picWins: 1 } }, { returnDocument: 'after' }))
      if (nu) { reward = prize; cu = nu; ns.reward = prize; await states.updateOne({ _id: s._id }, { $set: { reward: prize } }) }
      else { capped = true; cu = await users.findOne({ _id: u._id }) || u }
    }
    if (fin) await users.updateOne({ _id: u._id, [`picDone.${MAX_DONE}`]: { $exists: false } }, { $addToSet: { picDone: q.id } }) // selesai (benar atau habis kesempatan): tidak muncul lagi sampai semua soal habis
    // misi harian + piala: menang tercatat walau hadiahnya sudah mentok batas harian
    const nq = win ? await track(col, cu, 'win') : []
    res.json({ ...(await view(cu, ns, list)), result: win ? 'win' : fin ? 'lose' : 'wrong', reward, capped, ...(nq.length ? { nq } : {}) })
  }))
}
