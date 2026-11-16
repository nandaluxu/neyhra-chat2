// Test end-to-end CATUR MULTIPLAYER (lib/chessmp.js) TANPA MongoDB asli: pakai mock koleksi in-memory
// yang mengimplementasikan operasi Mongo yang benar-benar dipakai modul ini ($set/$inc/$unset/$setOnInsert,
// upsert, findOneAndUpdate atomik, find+sort+skip+limit, $or/$ne/$exists/$lt, dot-path).
// Jalankan: node scripts/chessmp-e2e.mjs
import express from 'express'

/* ---------- Mock Mongo ---------- */
const clone = d => (d && typeof d === 'object') ? JSON.parse(JSON.stringify(d)) : d
const getPath = (o, p) => p.split('.').reduce((a, k) => (a == null ? undefined : a[k]), o)
const setPath = (o, p, v) => { const ks = p.split('.'); const last = ks.pop(); let t = o; for (const k of ks) { if (t[k] == null || typeof t[k] !== 'object') t[k] = {}; t = t[k] } t[last] = v }
const delPath = (o, p) => { const ks = p.split('.'); const last = ks.pop(); const t = ks.reduce((a, k) => (a == null ? undefined : a[k]), o); if (t && typeof t === 'object') delete t[last] }

function match(d, q) {
  if (!q || typeof q !== 'object') return true
  for (const [k, v] of Object.entries(q)) {
    if (k === '$or') { if (!v.some(x => match(d, x))) return false; continue }
    if (k === '$and') { if (!v.every(x => match(d, x))) return false; continue }
    const cur = getPath(d, k)
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const [op, val] of Object.entries(v)) {
        if (op === '$ne' && cur === val) return false
        if (op === '$exists' && (val ? cur === undefined : cur !== undefined)) return false
        if (op === '$lt' && !(cur < val)) return false
        if (op === '$gt' && !(cur > val)) return false
        if (op === '$in' && !val.includes(cur)) return false
        if (op === '$gte' && !(cur >= val)) return false
        if (op === '$lte' && !(cur <= val)) return false
      }
      continue
    }
    if (cur !== v) return false
  }
  return true
}
function applyUpdate(d, upd) {
  for (const [op, spec] of Object.entries(upd)) {
    if (op === '$set') for (const [k, v] of Object.entries(spec)) setPath(d, k, clone(v))
    else if (op === '$unset') for (const k of Object.keys(spec)) delPath(d, k)
    else if (op === '$inc') for (const [k, v] of Object.entries(spec)) setPath(d, k, (getPath(d, k) ?? 0) + v)
    else if (op === '$setOnInsert') { /* ditangani saat insert */ }
    else if (op === '$push') for (const [k, v] of Object.entries(spec)) {
      const arr = getPath(d, k) ?? (setPath(d, k, []), getPath(d, k))
      let items = Array.isArray(v) && v.$each ? v.$each : [v]
      if (v.$slice != null) items = items.slice(v.$slice)
      arr.push(...clone(items))
    }
  }
  return d
}
class MemCol {
  constructor(name) { this.name = name; this.docs = new Map() }
  async insertOne(d) { if (this.docs.has(d._id)) { const e = new Error('dup'); e.code = 11000; throw e } this.docs.set(d._id, clone(d)); return { acknowledged: true } }
  async findOne(q) { for (const d of this.docs.values()) if (match(d, q)) return clone(d); return null }
  async findOneAndUpdate(q, upd, opts = {}) {
    for (const [id, d] of this.docs) {
      if (match(d, q)) {
        const before = clone(d)
        applyUpdate(d, upd)
        return opts.returnDocument === 'before' ? before : clone(d)
      }
    }
    if (opts.upsert) {
      const fresh = {}
      for (const [k, v] of Object.entries(q)) if (typeof v !== 'object' || v === null) setPath(fresh, k, clone(v))
      if (upd.$setOnInsert) for (const [k, v] of Object.entries(upd.$setOnInsert)) setPath(fresh, k, clone(v))
      applyUpdate(fresh, upd)
      if (fresh._id === undefined) fresh._id = 'mock-' + Math.random().toString(36).slice(2)
      this.docs.set(fresh._id, fresh)
      return opts.returnDocument === 'before' ? null : clone(fresh)
    }
    return null
  }
  async updateOne(q, upd, opts = {}) { return this.findOneAndUpdate(q, upd, { ...opts, returnDocument: 'after' }).then(() => ({ acknowledged: true, matchedCount: 1 })) }
  async deleteOne(q) { let n = 0; for (const [id, d] of this.docs) if (match(d, q)) { this.docs.delete(id); n++ } return { deletedCount: n } }
  find(q, opts = {}) {
    const self = this
    let rows = [...self.docs.values()].filter(d => match(d, q)).map(clone)
    const projection = opts.projection
    if (projection) for (const r of rows) for (const k of Object.keys(projection)) if (projection[k] === 0) delPath(r, k)
    return {
      sort(s) { if (s) for (const [k, dir] of Object.entries(s).reverse()) rows.sort((a, b) => (getPath(a, k) > getPath(b, k) ? dir : -(dir))); return this },
      skip(n) { rows = rows.slice(n); return this },
      limit(n) { rows = rows.slice(0, n); return this },
      async toArray() { return rows }
    }
  }
}
const cols = {}
const col = async name => cols[name] ??= new MemCol(name)
const ensureIndexes = async () => { }

/* ---------- Server test ---------- */
process.env.CHESS_MP_DEPTH = '2' // dangkal supaya test cepat; di produksi default 3
const { mountChessMp } = await import('../lib/chessmp.js')

const USERS = {
  tokNanda: { _id: 'u-nanda', username: 'nanda', name: 'Nanda' },
  tokLuxu: { _id: 'u-luxu', username: 'luxu', name: 'Luxu' },
  tokReze: { _id: 'u-reze', username: 'reze', name: 'Reze' }
}
const userFromReq = async req => {
  const m = /^Bearer (\w+)$/.exec(req.headers.authorization || '')
  return m && USERS[m[1]] ? { user: USERS[m[1]], sid: 's' } : null
}
const wrap = fn => async (req, res) => { try { await fn(req, res) } catch (e) { console.error('test-wrap:', e); res.status(500).json({ error: 'err', msg: String(e?.message) }) } }
const allow = async () => true

const router = express.Router()
router.use(express.json({ limit: '1mb' }))
mountChessMp(router, { wrap, userFromReq, allow, col, ensureIndexes })
const app = express()
app.use(router)

const server = app.listen(0)
const PORT = server.address().port
const BASE = `http://127.0.0.1:${PORT}`
const call = async (tok, path, body) => {
  const r = await fetch(BASE + path, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + tok }, body: JSON.stringify(body ?? {}) })
  return { status: r.status, json: await r.json().catch(() => null) }
}
let PASS = 0, FAIL = 0
const ok = (cond, name, extra) => { if (cond) { PASS++; console.log('  ✓', name) } else { FAIL++; console.log('  ✗ GAGAL:', name, extra !== undefined ? JSON.stringify(extra)?.slice(0, 300) : '') } }
const SAMPLES = {} // respons nyata untuk CHESS_FRONTEND_SPEC.md
const keep = (name, r) => { SAMPLES[name] = r }

try {
  console.log('== 1. Ruang tantangan ==')
  let r = await call('tokNanda', '/api/auth/mp/room', { color: 'w' })
  ok(r.status === 200 && r.json.ok && /^[A-Z2-9]{6}$/.test(r.json.code) && r.json.color === 'w', 'host buat ruang (putih)', r.json)
  const code1 = r.json.code
  keep('room', r.json)

  r = await call('tokNanda', '/api/auth/mp/room/status', { code: code1 })
  ok(r.json.status === 'open', 'status ruang masih open', r.json)

  r = await call('tokNanda', '/api/auth/mp/join', { code: code1 })
  ok(r.status === 400, 'host tidak bisa join ruangnya sendiri', r.json)

  console.log('== 2. Join & mulai permainan ==')
  r = await call('tokLuxu', '/api/auth/mp/join', { code: code1 })
  ok(r.status === 200 && r.json.ok && r.json.game.status === 'active', 'tamu join -> permainan aktif', r.json)
  const gameId = r.json.game.id
  ok(r.json.game.you === 'b' && r.json.game.turn === 'w', 'tamu jadi hitam, giliran putih', r.json.game)
  keep('join', r.json)
  r = await call('tokNanda', '/api/auth/mp/game', { id: gameId })
  const nMoves = r.json.game.moves ? Object.values(r.json.game.moves).reduce((a, b) => a + b.length, 0) : 0
  ok(nMoves === 20, 'putih dapat 20 langkah sah pertama (10 kotak asal)', nMoves)
  ok(r.json.game.board === 'rnbqkbnrpppppppp' + '.'.repeat(32) + 'PPPPPPPPRNBQKBNR', 'papan posisi awal', r.json.game.board)
  keep('game', r.json)

  r = await call('tokNanda', '/api/auth/mp/room/status', { code: code1 })
  ok(r.json.status === 'matched' && r.json.gameId === gameId, 'host lihat ruang matched + gameId', r.json)

  r = await call('tokReze', '/api/auth/mp/game', { id: gameId })
  ok(r.status === 404, 'bukan peserta tidak bisa lihat game', r.status)

  console.log('== 3. Validasi langkah ==')
  r = await call('tokLuxu', '/api/auth/mp/move', { id: gameId, from: 52, to: 36 })
  ok(r.status === 409, 'bukan giliran -> 409', r.json)
  r = await call('tokNanda', '/api/auth/mp/move', { id: gameId, from: 0, to: 56 }) // a8->a1: kotak kosong/tdk ada bidak sendiri
  ok(r.status === 400, 'langkah tidak sah -> 400', r.json)
  r = await call('tokNanda', '/api/auth/mp/move', { id: gameId, from: 52, to: 20 }) // e2->e5 (melompati bidak)
  ok(r.status === 400, 'pion tidak boleh melompat -> 400', r.json)

  console.log('== 4. Fool\'s mate (f3 e5 g4 Qh4#) ==')
  const seq = [
    ['tokNanda', 53, 37, 'f3'],   // f2-f3 (f2 = 53? f2: file f(5) rank2 -> (8-2)*8+5=53; f3 = (8-3)*8+5=45? hitung ulang di bawah
  ]
  // indeks: sq = (8-rank)*8 + fileIdx. f2=(8-2)*8+5=53, f3=(8-3)*8+5=45, e7=(8-7)*8+4=12, e5=(8-5)*8+4=28, g2=(8-2)*8+6=54, g4=(8-4)*8+6=38, d8=(8-8)*8+3=3, h4=(8-4)*8+7=39
  const MOVES = [
    { tok: 'tokNanda', from: 53, to: 45, san: 'f3' },
    { tok: 'tokLuxu', from: 12, to: 28, san: 'e5' },
    { tok: 'tokNanda', from: 54, to: 38, san: 'g4' },
    { tok: 'tokLuxu', from: 3, to: 39, san: 'Qh4#' }
  ]
  let lastMove = null
  for (const mv of MOVES) {
    r = await call(mv.tok, '/api/auth/mp/move', { id: gameId, from: mv.from, to: mv.to })
    ok(r.status === 200 && r.json.move && r.json.move.san === mv.san, `langkah ${mv.san} diterima (SAN ${mv.san})`, r.json.move || r.json)
    lastMove = r
  }
  keep('move_mate', lastMove.json)
  ok(lastMove.json.game.status === 'done' && lastMove.json.game.result.won === 'b' && lastMove.json.game.result.reason === 'mate' && lastMove.json.game.result.score === '0-1', 'permainan selesai: hitam menang skakmat 0-1', lastMove.json.game.result)
  ok(/\[Event "Neyhra Multiplayer Chess"\]/.test(lastMove.json.game.pgn) && /1\. f3 e5 2\. g4 Qh4# 0-1/.test(lastMove.json.game.pgn), 'PGN benar (header + movetek + hasil)', lastMove.json.game.pgn)
  console.log('--- PGN ---\n' + lastMove.json.game.pgn + '------------')

  console.log('== 5. Sinkronisasi ==')
  r = await call('tokNanda', '/api/auth/mp/sync', { id: gameId, ply: 2 })
  ok(r.status === 200 && r.json.ply === 4 && r.json.newMoves && r.json.newMoves.length === 2 && r.json.newMoves[0].san === 'g4', 'sync mengirim langkah baru sejak ply 2', r.json.newMoves)
  keep('sync', r.json)

  console.log('== 6. Daftar permainan & statistik ==')
  r = await call('tokLuxu', '/api/auth/mp/games', {})
  ok(r.status === 200 && r.json.games.length === 1 && r.json.games[0].result.won === 'b', 'daftar game Luxu', r.json.games)
  keep('games', r.json)
  r = await call('tokLuxu', '/api/auth/mp/stats', {})
  ok(r.json.stats.played === 1 && r.json.stats.won === 1 && r.json.stats.winRate === 100, 'stats Luxu: main 1 menang 1', r.json.stats)
  keep('stats', r.json)
  r = await call('tokNanda', '/api/auth/mp/stats', {})
  ok(r.json.stats.played === 1 && r.json.stats.lost === 1, 'stats Nanda: main 1 kalah 1', r.json.stats)

  console.log('== 7. Review (analisis) ==')
  r = await call('tokNanda', '/api/auth/mp/review', { id: gameId })
  ok(r.status === 200 && r.json.ok && r.json.review.moves.length === 4, 'review terhitung: 4 langkah', r.status)
  const rev = r.json.review
  ok(rev.ev.length === 5, 'grafik evaluasi: 5 titik (ply+1)', rev.ev.length)
  ok(rev.moves[2].san === 'g4' && (rev.moves[2].label === 'Blunder' || rev.moves[2].label === 'Mistake'), 'g4 terdeteksi Blunder/Mistake', rev.moves[2])
  ok(typeof rev.accuracy.w === 'number' && typeof rev.accuracy.b === 'number', 'akurasi kedua pemain ada', rev.accuracy)
  ok(rev.counts.w && rev.counts.b && rev.moves.every(m => ['Best', 'Great', 'Excellent', 'Mistake', 'Miss', 'Blunder'].includes(m.label)), 'semua label dari daftar yang valid', rev.counts)
  ok(rev.moves.every(m => m.bestSan && m.bestUci), 'rekomendasi best move tiap langkah', rev.moves.map(m => m.bestSan))
  keep('review', r.json)
  console.log('  review:', JSON.stringify({ ev: rev.ev, accuracy: rev.accuracy, counts: rev.counts, labels: rev.moves.map(m => m.san + '=' + m.label) }))

  r = await call('tokNanda', '/api/auth/mp/stats', {})
  ok(r.json.stats.accGames === 1 && r.json.stats.accuracy !== null && r.json.stats.labels.blunder >= 1, 'stats nanda terupdate label blunder + akurasi', r.json.stats)

  console.log('== 8. Replay ==')
  r = await call('tokNanda', '/api/auth/mp/replay', { id: gameId })
  ok(r.status === 200 && r.json.positions.length === 4 && r.json.initial.fen === 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', 'replay: 4 posisi + FEN awal', r.json.initial)
  ok(r.json.positions[3].fen.startsWith('rnb1kbnr/pppp1ppp/8/4p3/6Pq'), 'replay: posisi terakhir = posisi mati', r.json.positions[3].fen)
  ok(r.json.meta.pgn.includes('Qh4#'), 'replay: meta bawa PGN', r.json.meta.pgn?.slice(0, 60))
  keep('replay', r.json)

  console.log('== 9. Hint (game aktif) ==')
  r = await call('tokNanda', '/api/auth/mp/room', { color: 'b' })
  const code2 = r.json.code
  r = await call('tokReze', '/api/auth/mp/join', { code: code2 })
  const gameId2 = r.json.game.id // host Nanda hitam, Reze putih
  r = await call('tokReze', '/api/auth/mp/hint', { id: gameId2 })
  ok(r.status === 200 && r.json.best && r.json.best.san && r.json.best.uci && r.json.best.from >= 0, 'hint untuk putih: dapat langkah terbaik', r.json)
  keep('hint', r.json)

  console.log('== 10. Tawaran seri ==')
  r = await call('tokReze', '/api/auth/mp/draw', { id: gameId2, act: 'offer' })
  ok(r.status === 200 && r.json.draw && r.json.draw.mine === true, 'Reze menawarkan seri', r.json)
  r = await call('tokNanda', '/api/auth/mp/sync', { id: gameId2, ply: 0 })
  ok(r.json.draw && r.json.draw.by === 'w' && r.json.draw.mine === false, 'Nanda melihat tawaran dari lawan', r.json.draw)
  r = await call('tokNanda', '/api/auth/mp/draw', { id: gameId2, act: 'accept' })
  ok(r.status === 200 && r.json.game.status === 'done' && r.json.game.result.score === '1/2-1/2' && r.json.game.result.reason === 'agreement', 'seri disepakati 1/2-1/2', r.json.game?.result)
  keep('draw_accept', r.json)
  r = await call('tokNanda', '/api/auth/mp/stats', {})
  ok(r.json.stats.played === 2 && r.json.stats.drawn === 1, 'stats Nanda: seri tercatat', r.json.stats)
  r = await call('tokReze', '/api/auth/mp/stats', {})
  ok(r.json.stats.played === 1 && r.json.stats.drawn === 1, 'stats Reze: seri tercatat', r.json.stats)

  console.log('== 11. Batal (< 2 langkah) & menyerah ==')
  r = await call('tokNanda', '/api/auth/mp/room', { color: 'w' })
  const code3 = r.json.code
  r = await call('tokReze', '/api/auth/mp/join', { code: code3 })
  const gameId3 = r.json.game.id
  r = await call('tokNanda', '/api/auth/mp/resign', { id: gameId3 })
  ok(r.status === 200 && r.json.game.status === 'aborted', 'resign < 2 langkah = batal (aborted)', r.json.game?.status)
  r = await call('tokReze', '/api/auth/mp/stats', {})
  ok(r.json.stats.played === 1, 'game batal TIDAK masuk statistik', r.json.stats)

  r = await call('tokNanda', '/api/auth/mp/room', { color: 'w' })
  const code4 = r.json.code
  r = await call('tokReze', '/api/auth/mp/join', { code: code4 })
  const gameId4 = r.json.game.id
  await call('tokNanda', '/api/auth/mp/move', { id: gameId4, from: 52, to: 36 }) // e4
  await call('tokReze', '/api/auth/mp/move', { id: gameId4, from: 12, to: 28 })  // e5
  r = await call('tokReze', '/api/auth/mp/resign', { id: gameId4 })
  ok(r.status === 200 && r.json.game.status === 'done' && r.json.game.result.won === 'w' && r.json.game.result.reason === 'resign', 'menyerah setelah 2 langkah: lawan menang', r.json.game?.result)
  r = await call('tokReze', '/api/auth/mp/review', { id: gameId4 })
  ok(r.status === 200 && r.json.review.moves.length === 2, 'review game resign juga bisa', r.status)

  console.log('== 12. Statistik pemain lain & join ulang ==')
  await (await col('users')).insertOne({ _id: 'u-reze', username: 'reze', name: 'Reze' })
  r = await call('tokNanda', '/api/auth/mp/stats', { user: 'reze' })
  ok(r.status === 200 && r.json.user.username === 'reze' && r.json.stats.played === 2 && r.json.stats.lost === 1, 'stats pemain lain lewat username', r.json.stats)
  r = await call('tokNanda', '/api/auth/mp/stats', { user: 'takada' })
  ok(r.status === 404, 'username tak dikenal -> 404', r.status)
  r = await call('tokLuxu', '/api/auth/mp/join', { code: code1 })
  ok(r.status === 409, 'ruang yang sudah matched tidak bisa dijoin lagi', r.json)
  r = await call('tokLuxu', '/api/auth/mp/join', { code: 'ZZZZZZ' })
  ok(r.status === 404, 'kode salah -> 404', r.json)
  r = await call('tokNanda', '/api/auth/mp/cancel', { code: 'QQQQQQ' })
  ok(r.status === 200 && r.json.ok, 'cancel ruang tak dikenal tetap ok (idempoten)', r.json)

  console.log(`\nHASIL: ${PASS} lulus, ${FAIL} gagal`)
  const fs = await import('node:fs')
  fs.writeFileSync(new URL('./chessmp-sample-responses.json', import.meta.url), JSON.stringify(SAMPLES, null, 2))
  console.log('Contoh respons disimpan: scripts/chessmp-sample-responses.json')
} finally {
  server.close()
}
process.exit(FAIL ? 1 : 0)
