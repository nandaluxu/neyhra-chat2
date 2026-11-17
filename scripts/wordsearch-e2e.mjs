// Tes server Word Search (lib/wordsearch.js) tanpa MongoDB sungguhan: Mongo palsu di memori. Jalankan: node scripts/wordsearch-e2e.mjs
// Mencakup: papan valid (semua kata benar-benar ada), pilihan salah/benar (maju & mundur), anti-ganda, penalti petunjuk,
// jeda, hadiah + batas harian, waktu terbaik, kata tersembunyi tidak bocor ke client.
import { mountWordSearch, WS, prizeFor } from '../lib/wordsearch.js'
const stores = {}
const get = (o, p) => p.split('.').reduce((a, k) => (a == null ? a : a[k]), o)
const set = (o, p, v) => { const ks = p.split('.'); let a = o; ks.slice(0, -1).forEach(k => { a = a[k] ??= {} }); a[ks.at(-1)] = v }
const match = (d, f) => Object.entries(f).every(([k, c]) => {
  const v = get(d, k)
  if (c && typeof c === 'object' && !Array.isArray(c)) return Object.entries(c).every(([op, x]) => op === '$ne' ? v !== x : op === '$lt' ? v < x : op === '$lte' ? v <= x : false)
  return JSON.stringify(v) === JSON.stringify(c)
})
const apply = (d, u) => {
  for (const [k, v] of Object.entries(u.$set || {})) set(d, k, v)
  for (const [k, v] of Object.entries(u.$inc || {})) set(d, k, (get(d, k) || 0) + v)
  for (const [k, v] of Object.entries(u.$push || {})) (get(d, k) || set(d, k, []) || get(d, k)).push(v)
}
const col = async name => {
  const s = stores[name] ??= []
  return {
    findOne: async f => { const d = s.find(x => match(x, f)); return d ? structuredClone(d) : null },
    replaceOne: async (f, doc) => { const i = s.findIndex(x => match(x, f)); if (i >= 0) s[i] = structuredClone(doc); else s.push(structuredClone(doc)) },
    updateOne: async (f, u) => { const d = s.find(x => match(x, f)); if (d) apply(d, u) },
    findOneAndUpdate: async (f, u) => { const d = s.find(x => match(x, f)); if (!d) return null; apply(d, u); return structuredClone(d) }
  }
}
const routes = {}, router = { post: (p, h) => { routes[p] = h } }
stores.users = [{ _id: 'u1', coins: 100, gems: 5 }]
mountWordSearch(router, { wrap: h => h, userFromReq: async () => ({ user: structuredClone(stores.users[0]) }), allow: async () => true, col, ensureWallet: async () => ({ coins: stores.users[0].coins, gems: 5 }), ensureIndexes: async () => {} })
const call = async (p, body = {}) => { let out; const res = { status(c) { this.c = c; return this }, json(o) { out = { c: this.c || 200, ...o } } }; await routes['/api/auth/ws' + p]({ body, headers: {} }, res); return out }
const ok = (c, m) => { if (!c) throw new Error('GAGAL: ' + m); console.log('ok  ' + m) }
const gs = () => stores.game_state.find(x => x._id === 'u1:ws')
const N = WS.size, cells = w => Array.from({ length: w.w.length }, (_, i) => [w.r + w.dr * i, w.c + w.dc * i])
const end = w => [w.r + w.dr * (w.w.length - 1), w.c + w.dc * (w.w.length - 1)]

let r = await call('/start')
ok(r.ok && r.game.active && r.game.rows.length === N && r.game.rows.every(x => x.length === N), 'start: papan ' + N + 'x' + N)
ok(r.game.words.length === WS.words && r.game.words.every(x => !x.found && x.at === null), 'kata ' + WS.words + ', posisi tidak bocor ke client')
ok(!JSON.stringify(r).includes('"dr"'), 'respons tidak memuat arah/posisi kata')
// setiap kata benar-benar ada di papan sesuai posisi server
ok(gs().words.every(w => cells(w).map(([a, b]) => gs().rows[a][b]).join('') === w.w), 'semua kata tertulis di posisi aslinya')
ok(new Set(gs().words.map(w => w.w)).size === WS.words, 'tidak ada kata ganda')

// pilihan salah / bukan garis lurus / di luar papan
r = await call('/select', { a: [0, 0], b: [1, 2] }); ok(r.ok && r.hit === false, 'bukan garis lurus -> tidak kena')
r = await call('/select', { a: [0, 0], b: [0, 0] }); ok(r.hit === false, 'satu kotak -> tidak kena')
r = await call('/select', { a: [0, 0], b: [99, 0] }); ok(r.c === 400, 'di luar papan -> 400')
r = await call('/select', { a: 'x', b: [0, 0] }); ok(r.c === 400, 'bentuk salah -> 400')

// kata benar: maju
const ws = gs().words
let w0 = ws[0]
r = await call('/select', { a: [w0.r, w0.c], b: end(w0) })
ok(r.hit && r.word === w0.w && r.game.found === 1, 'kata pertama ketemu (maju)')
ok(r.game.words.find(x => x.w === w0.w).found && r.game.words.find(x => x.w === w0.w).at.length === 4, 'kata ketemu memuat posisi')
r = await call('/select', { a: [w0.r, w0.c], b: end(w0) }); ok(r.hit === false && r.game.found === 1, 'kata yang sama tidak dihitung dua kali')
// kata benar: mundur (ujung ke pangkal)
let w1 = ws[1]
r = await call('/select', { a: end(w1), b: [w1.r, w1.c] })
ok(r.hit && r.word === w1.w && r.game.found === 2, 'kata kedua ketemu (ditarik terbalik)')
const gr = gs().words[1].gr; ok(gr[0] === w1.r && gr[1] === w1.c && gr[2] === w1.dr && gr[3] === w1.dc, 'garis tersimpan searah huruf pertama')

// petunjuk huruf
const penBefore = gs().pen || 0
r = await call('/hint', { kind: 'letter' })
ok(r.ok && r.hint.cell && r.game.marks.length === 1 && r.game.pen === penBefore + WS.hintLetterSec * 1000, 'buka huruf: 1 sel + penalti ' + WS.hintLetterSec + ' dtk')
const left = gs().words.filter(x => !x.f), tgt = left.find(x => x.w && cells(x).some(([a, b]) => a === r.hint.cell[0] && b === r.hint.cell[1])); ok(!!tgt, 'huruf yang dibuka milik kata yang belum ketemu')
r = await call('/hint', { kind: 'letter' }); ok(r.game.marks.length === 2, 'buka huruf lagi: kata yang sama, huruf berikutnya')
r = await call('/hint', { kind: 'zzz' }); ok(r.c === 400, 'jenis petunjuk salah -> 400')

// jeda
r = await call('/pause', { on: true }); ok(r.game.paused, 'jeda aktif')
r = await call('/select', { a: [0, 0], b: [0, 1] }); ok(r.c === 409, 'pilihan ditolak saat jeda')
r = await call('/hint', { kind: 'letter' }); ok(r.c === 409, 'petunjuk ditolak saat jeda')
const t1 = (await call('')).game.ms; await new Promise(x => setTimeout(x, 120)); const t2 = (await call('')).game.ms
ok(t1 === t2, 'waktu berhenti selama jeda')
r = await call('/pause', { on: false }); ok(!r.game.paused && gs().pausedMs >= 100, 'lanjut: lama jeda dikeluarkan dari waktu')

// buka kata
r = await call('/hint', { kind: 'word' })
ok(r.hint.word && r.game.words.find(x => x.w === r.hint.word).revealed, 'buka kata: kata ditandai dibuka')
ok(r.game.pen === (WS.hintLetterSec * 2 + WS.hintWordSec) * 1000, 'penalti total benar')

// selesaikan sisanya -> menang + hadiah
for (const w of gs().words.filter(x => !x.f)) r = await call('/select', { a: [w.r, w.c], b: end(w) })
ok(r.game.over && r.game.found === WS.words, 'semua kata ketemu -> selesai')
ok(r.game.reward === prizeFor(gs().effMs) && stores.users[0].coins === 100 + r.game.reward, 'hadiah ' + r.game.reward + ' coin masuk saldo')
ok(stores.users[0].wsWins === 1 && stores.users[0].wsBest === gs().effMs, 'wsWins=1 dan waktu terbaik tersimpan (' + gs().effMs + ' ms, termasuk penalti)')
ok(gs().effMs >= (WS.hintLetterSec * 2 + WS.hintWordSec) * 1000, 'waktu efektif memuat penalti')
r = await call('/select', { a: [0, 0], b: [0, 1] }); ok(r.c === 409, 'pilihan ditolak setelah selesai')
r = await call('/hint', { kind: 'word' }); ok(r.c === 409, 'petunjuk ditolak setelah selesai')

// batas harian
const bank = stores.users[0].coins
for (let i = 1; i < WS.dailyWins + 2; i++) {
  await call('/start')
  let q; for (const w of gs().words) q = await call('/select', { a: [w.r, w.c], b: end(w) })
  if (i < WS.dailyWins) ok(q.game.reward > 0, 'game ' + (i + 1) + ' berhadiah')
  else if (i === WS.dailyWins) ok(q.game.reward === 0 && q.game.capped, 'game ke-' + (i + 1) + ' melewati batas harian: tanpa hadiah')
}
ok(stores.users[0].wsWins === WS.dailyWins, 'wsWins berhenti di batas ' + WS.dailyWins)
ok(stores.users[0].coins > bank, 'saldo naik hanya dari game berhadiah')
ok(prizeFor(0) === WS.reward.base && prizeFor(1e9) === WS.reward.min, 'rumus hadiah: base di waktu cepat, min di waktu sangat lama')
console.log('\nSEMUA TES LULUS')
