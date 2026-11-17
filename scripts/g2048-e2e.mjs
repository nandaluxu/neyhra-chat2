// Tes server 2048 (lib/g2048.js) tanpa MongoDB sungguhan: Mongo palsu di memori. Jalankan: node scripts/g2048-e2e.mjs
// Mencakup: konsistensi papan server vs logika geser, langkah ditolak setelah selesai, hadiah per tile (sekali per permainan),
// batas coin harian, dan kemenangan 2048.
import { mountG2048, moveBoard, canMove } from '../lib/g2048.js'
// ---- Mongo palsu minimal (cukup untuk operasi yang dipakai modul)
const stores = {}
const match = (d, f) => Object.entries(f).every(([k, c]) => {
  const v = d[k]
  if (c && typeof c === 'object' && !Array.isArray(c)) return Object.entries(c).every(([op, x]) => op === '$ne' ? v !== x : op === '$lte' ? v <= x : false)
  return JSON.stringify(v) === JSON.stringify(c)
})
const apply = (d, u) => {
  for (const [k, v] of Object.entries(u.$set || {})) d[k] = v
  for (const [k, v] of Object.entries(u.$inc || {})) d[k] = (d[k] || 0) + v
  for (const [k, v] of Object.entries(u.$addToSet || {})) { d[k] ||= []; for (const x of v.$each) if (!d[k].includes(x)) d[k].push(x) }
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
const routes = {}
const router = { post: (p, h) => { routes[p] = h } }
const user = { _id: 'u1', coins: 100, gems: 5 }
stores.users = [user]
mountG2048(router, { wrap: h => h, userFromReq: async () => ({ user: structuredClone(stores.users[0]) }), allow: async () => true, col, ensureWallet: async u => ({ coins: stores.users[0].coins, gems: 5 }), ensureIndexes: async () => {} })
const call = async (p, body = {}) => { let out; const res = { status(c) { this.c = c; return this }, json(o) { out = { c: this.c || 200, ...o } } }; await routes['/api/auth/g2048' + p]({ body, headers: {} }, res); return out }

let r = await call('/start'); if (!r.ok || !r.game.active) throw new Error('start')
const sid = 'u1:g2048'
const gs = () => stores.game_state.find(x => x._id === sid)
// ---- 1. gerakan acak sampai selesai: server selalu konsisten dengan moveBoard
let moved = 0, dirs = ['up', 'left', 'down', 'right']
for (let i = 0; i < 4000 && gs() && !gs().over; i++) {
  const before = gs().b.slice(), d = dirs[i % 4]
  const exp = moveBoard(before, d)
  r = await call('/move', { d })
  if (r.moved !== exp.moved) throw new Error('moved mismatch')
  if (r.moved) { moved++; const a = r.game.b.slice(); if (r.spawn) a[r.spawn.r * 4 + r.spawn.c] = 0; if (JSON.stringify(a) !== JSON.stringify(exp.b)) throw new Error('board mismatch') }
  else if (JSON.stringify(r.game.b) !== JSON.stringify(before)) throw new Error('board berubah tanpa gerak')
}
console.log('permainan selesai?', gs().over, 'langkah', moved, 'skor', gs().score, 'tile max', gs().max, 'coin dari game', gs().earned)
if (gs().over !== canMove(gs().b) === false && !gs().over) throw new Error('over flag')
// langkah setelah selesai ditolak
r = await call('/move', { d: 'up' }); if (r.c !== 409) throw new Error('harus 409 setelah selesai, dapat ' + r.c)
r = await call('/move', { d: 'nyasar' }); if (r.c !== 400) throw new Error('arah buruk harus 400')

// ---- 2. hadiah tile: papan rekayasa agar tile 128 -> 256 -> 512 tercapai berurutan
stores.users[0].coins = 100; delete stores.users[0].g48Day; delete stores.users[0].g48Coins
await call('/start')
const set = (b, extra = {}) => Object.assign(gs(), { b, moves: gs().moves, ...extra })
const pad = a => a.concat(new Array(16 - a.length).fill(0))
set(pad([64,64,0,0, 0,0,0,0, 0,0,0,0]), { max: 64, claimed: [] })
r = await call('/move', { d: 'left' })
if (!r.gain.length || r.gain[0].tile !== 128 || r.gain[0].coin !== 10) throw new Error('hadiah 128: ' + JSON.stringify(r.gain))
if (stores.users[0].coins !== 110) throw new Error('saldo 110, dapat ' + stores.users[0].coins)
// gabung lagi tanpa tile baru target => tidak ada hadiah ganda untuk 128
set(pad([128,128,0,0, 0,0,0,0]), { })
r = await call('/move', { d: 'left' })
if (r.gain.length !== 1 || r.gain[0].tile !== 256) throw new Error('hadiah 256: ' + JSON.stringify(r.gain))
set(pad([2,2,0,0]).map((v,i)=> i===4?4:v), {}) // tile 256 sudah tidak ada di papan, max tetap 256: tidak boleh klaim ulang
r = await call('/move', { d: 'left' }); if (r.gain.length) throw new Error('klaim ganda!')
// lompat 2 target sekaligus (kasus langka) -> keduanya dibayar
set(pad([512,512,0,0]), { max: 256, claimed: [128,256] })
r = await call('/move', { d: 'left' })
if (r.gain.map(x=>x.tile).join() !== '512,1024') throw new Error('lompat target: ' + JSON.stringify(r.gain))
console.log('hadiah per tile OK, saldo', stores.users[0].coins)

// ---- 3. batas harian
stores.users[0].g48Coins = 395
await call('/start')
set(pad([64,64]), { max: 64, claimed: [] })
r = await call('/move', { d: 'left' })
if (!r.gain.length || r.gain[0].coin !== 5) throw new Error('harus terpotong sisa batas 5: ' + JSON.stringify(r.gain))
if (stores.users[0].g48Coins !== 400) throw new Error('g48Coins ' + stores.users[0].g48Coins)
set(pad([128,128]), { })
r = await call('/move', { d: 'left' })
if (r.gain.length || !r.capped) throw new Error('harus capped: ' + JSON.stringify(r))
console.log('batas harian OK; skor terbaik tersimpan:', stores.users[0].g48Best, 'tile terbesar:', stores.users[0].g48Max)

// ---- 4. menang 2048 tercatat sekali
await call('/start'); set(pad([1024,1024]), { max: 512, claimed: [128,256,512,1024] }); stores.users[0].g48Coins = 0
r = await call('/move', { d: 'left' }); if (!r.game.won || r.gain[0].tile !== 2048) throw new Error('menang: ' + JSON.stringify(r))
console.log('menang 2048 OK, hadiah', r.gain[0].coin)
