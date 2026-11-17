import crypto from 'node:crypto'
import path from 'node:path'
import { readFile, readdir, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { ensureIndexes } from './mongo.js'
import { dayNum } from './bonus.js'
import { track } from './quests.js'
import { bump } from './leaderboard.js'

// Minigame Word Search. Kata dibaca dari data/wordS.json. Papan, posisi kata, penilaian pilihan, waktu, petunjuk, dan hadiah
// diputuskan di sini; client (public/wordsearch.js) hanya menampilkan dan mengirim garis yang dipilih pemain.
// Dipasang ke router auth (lib/auth.js) lewat mountWordSearch(), jadi memakai sesi/token, pembatas laju, dan koleksi `users` yang sama dengan game lain.
//
// Aturan: papan huruf WS.size x WS.size berisi WS.words kata tersembunyi di 8 arah (mendatar, menurun, diagonal, boleh terbalik).
//   Pemain menarik garis dari huruf pertama ke huruf terakhir sebuah kata. Selesai kalau semua kata ketemu.
//   Waktu dihitung server (dari start, dikurangi lama jeda). Buka huruf / buka kata menambah penalti waktu.
//   Hadiah coin turun seiring waktu efektif (waktu + penalti), dengan batas kemenangan berhadiah per hari (WIB) supaya tidak bisa di-farm.
//
// Endpoint (POST, token Bearer, jawaban JSON):
//   /api/auth/ws         -> { ok, cfg, daily:{wins,cap}, best, game|null, coins, gems }   keadaan terakhir (pulihkan layar)
//   /api/auth/ws/start   -> { ok, ... }                      papan baru (yang belum selesai dibuang)
//   /api/auth/ws/select  -> { ok, hit, word?, ... }          body { a:[r,c], b:[r,c] }  garis dari kotak a ke kotak b
//   /api/auth/ws/hint    -> { ok, hint:{kind, cell?|word?} } body { kind:'letter'|'word' }
//   /api/auth/ws/pause   -> { ok, ... }                      body { on: true|false }
//
// Format data/wordS.json: array string ["KUCING","MEJA",...] ATAU array objek [{ "word": "KUCING" }, ...] ATAU { "words": [...] }.
//   Huruf besar/kecil, aksen, spasi dan tanda baca diabaikan (hanya A-Z yang dipakai). Kata di luar panjang WS.minLen..WS.size dilewati.
//
// Koleksi `game_state`  { _id: "<userId>:ws", userId, rows:[string], words:[{w,r,c,dr,dc,f,rv,gr}], nf, t0, paused, pausedAt, pausedMs, pen, hl:[[r,c]], hw, hn, over, won, endAt, effMs, reward, exp }  (TTL 24 jam)
// Field tambahan di `users`  wsDay, wsWins (kemenangan berhadiah hari ini), wsBest (waktu efektif terbaik, ms)

// ===== Atur permainan & hadiah di sini =====
export const WS = {
  size: 10,                 // papan size x size (juga batas panjang kata)
  words: 8,                 // jumlah kata per papan
  minLen: 3,                // kata lebih pendek dari ini dilewati
  hintLetterSec: 10,        // penalti waktu: buka huruf
  hintWordSec: 30,          // penalti waktu: buka kata
  reward: { base: 80, freeSec: 60, perSec: 0.4, min: 15 }, // coin = base - perSec * (waktu efektif - freeSec), tidak kurang dari min
  dailyWins: 8              // maksimal kemenangan BERHADIAH per hari (WIB). Lewat itu tetap bisa main, tanpa coin
}
const N = WS.size, TTL_MS = 24 * 3600e3
const DIRS8 = [[0, 1], [1, 0], [1, 1], [-1, 1], [0, -1], [-1, 0], [-1, -1], [1, -1]]
const DATA = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data')
const A_Z = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'

export const prizeFor = effMs => {
  const R = WS.reward, over = Math.max(0, effMs / 1000 - R.freeSec)
  return Math.max(R.min, Math.round(R.base - R.perSec * over))
}

// ---------- daftar kata: dibaca dari file, di-cache, dibaca ulang otomatis kalau file berubah ----------
const norm = t => String(t ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z]/g, '')
async function wordFile() {
  const exact = path.join(DATA, 'wordS.json')
  try { await stat(exact); return exact } catch { /* coba nama lain (beda huruf besar/kecil) */ }
  const names = await readdir(DATA).catch(() => [])
  const hit = names.find(f => /^word(s|search)?\.json$/i.test(f))
  return hit ? path.join(DATA, hit) : null
}
function extract(raw) {
  if (Array.isArray(raw)) return raw
  if (raw && typeof raw === 'object') {
    for (const k of ['words', 'word', 'kata', 'list', 'data', 'items']) if (Array.isArray(raw[k])) return raw[k]
    const vals = Object.values(raw)
    if (vals.length && vals.every(Array.isArray)) return vals.flat() // { kategori: [kata...] }
  }
  return []
}
const wordOf = e => typeof e === 'string' ? e : e && typeof e === 'object' ? (e.word ?? e.kata ?? e.text ?? e.jawaban ?? e.w ?? '') : ''
let cache = null
async function dictionary() {
  const file = await wordFile()
  if (!file) return []
  const mt = (await stat(file)).mtimeMs
  if (cache && cache.file === file && cache.mt === mt) return cache.list
  const raw = JSON.parse(await readFile(file, 'utf8'))
  const list = [...new Set(extract(raw).map(e => norm(wordOf(e))).filter(w => w.length >= WS.minLen && w.length <= N))]
  cache = { file, mt, list }
  return list
}

// ---------- pembuat papan ----------
const rnd = n => crypto.randomInt(n)
function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = rnd(i + 1);[a[i], a[j]] = [a[j], a[i]] } return a }
const rev = w => [...w].reverse().join('')

function pickWords(pool, n) { // tidak ada kata yang jadi bagian kata lain (termasuk terbalik), supaya tidak ambigu
  const out = []
  for (const w of shuffle(pool.slice())) {
    if (out.length >= n) break
    const r = rev(w)
    if (out.some(x => x.includes(w) || w.includes(x) || x.includes(r) || r.includes(x))) continue
    out.push(w)
  }
  return out
}
function place(words) {
  const g = new Array(N * N).fill(''), pl = []
  for (const w of [...words].sort((a, b) => b.length - a.length)) {
    let ok = false
    for (let t = 0; t < 300 && !ok; t++) {
      const [dr, dc] = DIRS8[rnd(8)], r0 = rnd(N), c0 = rnd(N)
      const r1 = r0 + dr * (w.length - 1), c1 = c0 + dc * (w.length - 1)
      if (r1 < 0 || r1 >= N || c1 < 0 || c1 >= N) continue
      let fit = true
      for (let i = 0; i < w.length; i++) { const ch = g[(r0 + dr * i) * N + c0 + dc * i]; if (ch && ch !== w[i]) { fit = false; break } }
      if (!fit) continue
      for (let i = 0; i < w.length; i++) g[(r0 + dr * i) * N + c0 + dc * i] = w[i]
      pl.push({ w, r: r0, c: c0, dr, dc }); ok = true
    }
    if (!ok) return null
  }
  return { g, pl }
}
function count(g, w) { // berapa kali kata muncul di papan (8 arah)
  let n = 0
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) for (const [dr, dc] of DIRS8) {
    const r1 = r + dr * (w.length - 1), c1 = c + dc * (w.length - 1)
    if (r1 < 0 || r1 >= N || c1 < 0 || c1 >= N) continue
    let ok = true
    for (let i = 0; i < w.length; i++) if (g[(r + dr * i) * N + c + dc * i] !== w[i]) { ok = false; break }
    if (ok) n++
  }
  return n
}
export function buildPuzzle(pool) {
  let last = null
  for (let a = 0; a < 30; a++) {
    const words = pickWords(pool, WS.words)
    if (!words.length) return null
    const p = place(words); if (!p) continue
    const mix = words.join('')
    for (let f = 0; f < 15; f++) {
      const g = p.g.map(ch => ch || (rnd(100) < 55 ? mix[rnd(mix.length)] : A_Z[rnd(26)]))
      last = { g, pl: p.pl }
      // kata yang tidak sengaja muncul dua kali tetap sah dicari (server menilai dari huruf), tapi diusahakan unik supaya adil
      if (words.every(w => count(g, w) === (w === rev(w) ? 2 : 1))) return last
    }
  }
  return last
}

// ---------- waktu ----------
const elapsed = (s, now) => Math.max(0, (s.endAt || (s.paused ? s.pausedAt : now)) - s.t0 - (s.pausedMs || 0))

export function mountWordSearch(router, { wrap, userFromReq, allow, col, ensureWallet, ensureIndexes: ensureIdx = ensureIndexes }) {
  const doc = r => (r && r.value !== undefined ? r.value : r) // findOneAndUpdate: driver baru mengembalikan dokumen, driver lama { value }
  let idx
  const ready = () => idx ??= ensureIdx('game_state', [[{ exp: 1 }, { expireAfterSeconds: 0 }]]).catch(e => { idx = null; throw e })
  const need = async (req, res) => {
    const a = await userFromReq(req)
    if (!a) { res.status(401).json({ error: 'Sesi berakhir, masuk lagi.' }); return null }
    await ready()
    return a.user
  }
  const sid = u => u._id + ':ws'
  const winsToday = u => (u.wsDay === dayNum(Date.now()) ? u.wsWins || 0 : 0)
  const bad = (res, code, error) => res.status(code).json({ error })
  const freshExp = () => new Date(Date.now() + TTL_MS)

  const gameView = (s, now = Date.now()) => s ? {
    active: !s.over, over: !!s.over, paused: !!s.paused && !s.over,
    n: N, rows: s.rows,
    // posisi kata HANYA dikirim untuk kata yang sudah ketemu
    words: s.words.map(x => ({ w: x.w, found: !!x.f, revealed: !!x.rv, at: x.f ? x.gr : null })),
    marks: s.hl || [], found: s.nf || 0, total: s.words.length,
    ms: elapsed(s, now), pen: s.pen || 0, hints: s.hn || 0,
    reward: s.reward || 0, capped: !!s.capped, newBest: !!s.newBest
  } : null
  async function view(u, s) {
    const w = await ensureWallet(u)
    return {
      ok: true,
      cfg: { size: N, words: WS.words, hintLetterSec: WS.hintLetterSec, hintWordSec: WS.hintWordSec, reward: WS.reward },
      daily: { wins: winsToday(u), cap: WS.dailyWins }, best: u.wsBest || 0,
      game: gameView(s), coins: w.coins, gems: w.gems
    }
  }
  const getState = async u => (await col('game_state')).findOne({ _id: sid(u) })

  // semua kata ketemu -> tutup permainan sekali (penjaga atomik) lalu bayar hadiah. Mengembalikan { state, user, nq }
  async function finish(u, s, states) {
    const now = Date.now(), eff = elapsed(s, now) + (s.pen || 0)
    const fin = doc(await states.findOneAndUpdate(
      { _id: s._id, over: false, nf: s.words.length },
      { $set: { over: true, won: true, endAt: now, effMs: eff } }, { returnDocument: 'after' }))
    if (!fin) return { state: s, user: u, nq: [] } // permintaan lain sudah menutupnya
    const users = await col('users'), today = dayNum(now)
    await ensureWallet(u)
    let cu = u, reward = 0, capped = false
    await users.updateOne({ _id: u._id, wsDay: { $ne: today } }, { $set: { wsDay: today, wsWins: 0 } }) // hari baru: reset hitungan
    const prize = prizeFor(eff)
    // batas harian dijaga atomik di filter: dua permainan selesai bersamaan tidak bisa melewati batas
    const nu = doc(await users.findOneAndUpdate(
      { _id: u._id, wsDay: today, wsWins: { $lt: WS.dailyWins } },
      { $inc: { coins: prize, wsWins: 1 } }, { returnDocument: 'after' }))
    if (nu) { cu = nu; reward = prize } else capped = true
    const newBest = !(cu.wsBest > 0) || eff < cu.wsBest
    if (newBest) { await users.updateOne({ _id: u._id }, { $set: { wsBest: eff } }); cu = { ...cu, wsBest: eff } }
    fin.reward = reward; fin.capped = capped; fin.newBest = newBest
    await states.updateOne({ _id: s._id }, { $set: { reward, capped, newBest } })
    await bump(col, u._id, { wsWon: 1 })
    const nq = await track(col, cu, 'win')
    return { state: fin, user: cu, nq }
  }
  const reply = async (res, u, s, extra = {}, nq = []) => res.json({ ...(await view(u, s)), ...extra, ...(nq.length ? { nq } : {}) })

  router.post('/api/auth/ws', wrap(async (req, res) => {
    const u = await need(req, res); if (!u) return
    if (!(await allow('ws:' + u._id, 60, 60))) return bad(res, 429, 'Terlalu sering, tunggu sebentar.')
    await reply(res, u, await getState(u))
  }))

  router.post('/api/auth/ws/start', wrap(async (req, res) => {
    const u = await need(req, res); if (!u) return
    if (!(await allow('wss:' + u._id, 20, 60))) return bad(res, 429, 'Terlalu sering, tunggu sebentar.')
    const pool = await dictionary()
    if (pool.length < 1) return bad(res, 503, 'Daftar kata belum tersedia (data/wordS.json kosong atau tidak ditemukan).')
    const p = buildPuzzle(pool)
    if (!p) return bad(res, 503, 'Gagal menyusun papan dari daftar kata. Coba lagi.')
    const rows = Array.from({ length: N }, (_, r) => p.g.slice(r * N, r * N + N).join(''))
    const words = p.pl.map(x => ({ w: x.w, r: x.r, c: x.c, dr: x.dr, dc: x.dc, f: false, rv: false, gr: null })).sort((a, b) => a.w.localeCompare(b.w))
    const s = { _id: sid(u), userId: u._id, rows, words, nf: 0, t0: Date.now(), paused: false, pausedAt: 0, pausedMs: 0, pen: 0, hl: [], hw: -1, hn: 0, over: false, won: false, reward: 0, exp: freshExp() }
    await (await col('game_state')).replaceOne({ _id: s._id }, s, { upsert: true })
    await reply(res, u, s)
  }))

  router.post('/api/auth/ws/select', wrap(async (req, res) => {
    const u = await need(req, res); if (!u) return
    if (!(await allow('wsm:' + u._id, 300, 60))) return bad(res, 429, 'Terlalu cepat, tunggu sebentar.')
    const cell = v => Array.isArray(v) && v.length === 2 && v.every(x => Number.isInteger(x) && x >= 0 && x < N) ? v : null
    const a = cell(req.body?.a), b = cell(req.body?.b)
    if (!a || !b) return bad(res, 400, 'Pilihan tidak valid.')
    const states = await col('game_state'), s = await states.findOne({ _id: sid(u) })
    if (!s || s.over) return bad(res, 409, 'Mulai permainan baru dulu.')
    if (s.paused) return bad(res, 409, 'Permainan sedang dijeda.')

    const lr = Math.abs(b[0] - a[0]), lc = Math.abs(b[1] - a[1])
    if ((lr || lc) && (lr === 0 || lc === 0 || lr === lc)) {
      const dr = Math.sign(b[0] - a[0]), dc = Math.sign(b[1] - a[1]), len = Math.max(lr, lc) + 1
      let str = ''
      for (let i = 0; i < len; i++) str += s.rows[a[0] + dr * i][a[1] + dc * i]
      const rs = rev(str), i = s.words.findIndex(x => !x.f && (x.w === str || x.w === rs))
      if (i >= 0) {
        const fwd = s.words[i].w === str
        const gr = fwd ? [a[0], a[1], dr, dc] : [b[0], b[1], -dr, -dc] // selalu dinyatakan searah huruf pertama kata
        const k = 'words.' + i + '.'
        let ns = doc(await states.findOneAndUpdate(
          { _id: s._id, over: false, paused: false, [k + 'f']: false },
          { $set: { [k + 'f']: true, [k + 'gr']: gr, exp: freshExp() }, $inc: { nf: 1 } }, { returnDocument: 'after' }))
        if (!ns) return bad(res, 409, 'Permainan berubah, coba lagi.')
        await bump(col, u._id, { wsWords: 1 })
        let cu = u, nq = []
        if (ns.nf >= ns.words.length) { const f = await finish(u, ns, states); ns = f.state; cu = f.user; nq = f.nq }
        return reply(res, cu, ns, { hit: true, word: s.words[i].w }, nq)
      }
    }
    await reply(res, u, s, { hit: false })
  }))

  router.post('/api/auth/ws/hint', wrap(async (req, res) => {
    const u = await need(req, res); if (!u) return
    if (!(await allow('wsh:' + u._id, 60, 60))) return bad(res, 429, 'Terlalu cepat, tunggu sebentar.')
    const kind = String(req.body?.kind || '')
    if (kind !== 'letter' && kind !== 'word') return bad(res, 400, 'Jenis petunjuk tidak dikenal.')
    const states = await col('game_state'), s = await states.findOne({ _id: sid(u) })
    if (!s || s.over) return bad(res, 409, 'Mulai permainan baru dulu.')
    if (s.paused) return bad(res, 409, 'Permainan sedang dijeda.')
    const left = s.words.map((x, i) => ({ x, i })).filter(o => !o.x.f)
    if (!left.length) return bad(res, 409, 'Semua kata sudah ketemu.')
    const hl = s.hl || [], has = (r, c) => hl.some(p => p[0] === r && p[1] === c)
    const cellsOf = x => Array.from({ length: x.w.length }, (_, i) => [x.r + x.dr * i, x.c + x.dc * i])

    if (kind === 'letter') {
      // kata yang sedang diberi petunjuk dulu; kalau sudah ketemu / semua hurufnya terbuka, ambil kata lain acak
      const open = left.filter(o => cellsOf(o.x).some(([r, c]) => !has(r, c)))
      if (!open.length) return bad(res, 409, 'Huruf awal semua kata yang tersisa sudah terbuka.')
      const cur = open.find(o => o.i === s.hw), pick = cur || open[rnd(open.length)]
      const next = cellsOf(pick.x).find(([r, c]) => !has(r, c))
      const ns = doc(await states.findOneAndUpdate(
        { _id: s._id, over: false, paused: false, hn: s.hn || 0 }, // penjaga atomik: dua klik bersamaan tidak membuka dua huruf
        { $push: { hl: next }, $set: { hw: pick.i, exp: freshExp() }, $inc: { hn: 1, pen: WS.hintLetterSec * 1000 } }, { returnDocument: 'after' }))
      if (!ns) return bad(res, 409, 'Permainan berubah, coba lagi.')
      return reply(res, u, ns, { hint: { kind, cell: next } })
    }
    const cur = left.find(o => o.i === s.hw), pick = cur || left[rnd(left.length)], k = 'words.' + pick.i + '.', x = pick.x
    let ns = doc(await states.findOneAndUpdate(
      { _id: s._id, over: false, paused: false, [k + 'f']: false },
      { $set: { [k + 'f']: true, [k + 'rv']: true, [k + 'gr']: [x.r, x.c, x.dr, x.dc], hw: -1, exp: freshExp() }, $inc: { nf: 1, hn: 1, pen: WS.hintWordSec * 1000 } }, { returnDocument: 'after' }))
    if (!ns) return bad(res, 409, 'Permainan berubah, coba lagi.')
    let cu = u, nq = []
    if (ns.nf >= ns.words.length) { const f = await finish(u, ns, states); ns = f.state; cu = f.user; nq = f.nq }
    return reply(res, cu, ns, { hint: { kind, word: x.w } }, nq)
  }))

  router.post('/api/auth/ws/pause', wrap(async (req, res) => {
    const u = await need(req, res); if (!u) return
    if (!(await allow('wsp:' + u._id, 60, 60))) return bad(res, 429, 'Terlalu sering, tunggu sebentar.')
    const on = req.body?.on === true || req.body?.on === 'true'
    const states = await col('game_state'), s = await states.findOne({ _id: sid(u) })
    if (!s || s.over) return bad(res, 409, 'Tidak ada permainan yang berjalan.')
    const now = Date.now()
    let ns = s
    if (on && !s.paused) ns = doc(await states.findOneAndUpdate({ _id: s._id, over: false, paused: false }, { $set: { paused: true, pausedAt: now, exp: freshExp() } }, { returnDocument: 'after' })) || s
    else if (!on && s.paused) ns = doc(await states.findOneAndUpdate({ _id: s._id, over: false, paused: true, pausedAt: s.pausedAt }, { $set: { paused: false, pausedAt: 0, exp: freshExp() }, $inc: { pausedMs: Math.max(0, now - s.pausedAt) } }, { returnDocument: 'after' })) || s
    await reply(res, u, ns)
  }))
}
