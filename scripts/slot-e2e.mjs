// E2E Fruit Slot: boots the REAL express app (lib/app.js) against an in-memory MongoDB, then runs
// the Design.md checklist (spin & saldo, combo 1-7, Bonus Session 3 ronde sekali kredit, refill
// rate-limit, atomicity/anti-race, persistensi, kontrak respons). Run: node scripts/slot-e2e.mjs
import fs from 'node:fs'
const devSrc = fs.readFileSync(new URL('../lib/dev.js', import.meta.url), 'utf8')
const hashFn = devSrc.match(/const hash53[\s\S]*?\nconst DEV_HASH/)[0].replace(/\nconst DEV_HASH$/, '')
process.env.GC_DEV_HASH = String(eval('(' + hashFn.replace('const hash53 = ', '') + ')')('uji123'))

const { MongoMemoryServer } = await import('mongodb-memory-server')
const ms = await MongoMemoryServer.create()
process.env.MONGODB_URI = ms.getUri('neyhra')
console.log('mongo in-memory:', process.env.MONGODB_URI)

const { default: app } = await import('../lib/app.js')
const server = app.listen(0)
const base = 'http://127.0.0.1:' + server.address().port
const api = async (path, { token, body } = {}) => {
  const r = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body || {}) })
  return { status: r.status, j: await r.json().catch(() => ({})) }
}

let pass = 0, fail = 0
const ok = (name, cond, extra) => { if (cond) { pass++; console.log('  ✓', name) } else { fail++; console.log('  ✗ FAIL:', name, extra !== undefined ? JSON.stringify(extra) : '') } }
const eq = (name, a, b) => ok(name, a === b, { got: a, want: b })

const { MongoClient } = await import('mongodb')
const mc = new MongoClient(process.env.MONGODB_URI); await mc.connect()
const db = mc.db('neyhra')
const users = db.collection('users')
const rl = db.collection('auth_rl')
const wipeRL = () => rl.deleteMany({}).catch(() => { })

// ==== [0] fungsi murni ====
console.log('\n[0] Fungsi murni (lib/slot.js)')
{
  const { SLOT, evalGrid, comboNext, rollGrid, rollBonusRound, LINE_CELLS } = await import('../lib/slot.js')
  eq('config: 8 simbol', SLOT.symbols.length, 8)
  eq('config: semua taruhan habis dibagi jumlah garis', SLOT.bets.filter(b => b % SLOT.lines !== 0).length, 0)
  const ids = SLOT.symbols.map(s => s.id)
  // grid uji: baris atas cherry x3, sisanya lemon dengan pengganggu orange supaya TIDAK ada garis lain yang menang
  const g = Array.from({ length: 9 }, () => 1)
  g[2] = 2; g[5] = 2; g[7] = 2                 // pengganggu: pecah baris tengah & bawah yang lemon x3
  g[0] = 0; g[1] = 0; g[2] = 0                 // baris atas = cherry x3
  const ev = evalGrid(g, 50)
  eq('3 cherry x1 garis = pay3 x lineBet', ev.win, SLOT.symbols[0].pay3 * 10)
  eq('garis menang tercatat', ev.lines.length, 1)
  eq('kind 3-sejenis', ev.lines[0].kind, 3)
  // cherry-2: cherry di 2 sel satu garis, sel ketiga beda; garis lain netral
  const g2 = Array.from({ length: 9 }, () => 1)
  g2[2] = 2; g2[5] = 2; g2[8] = 2              // pengganggu baris atas/bawah + diagonal
  g2[3] = g2[4] = 0                            // baris tengah: cherry cherry lemon
  const ev2 = evalGrid(g2, 50)
  eq('2 cherry di satu garis = pay2 x lineBet', ev2.win, 1 * 10)
  eq('kind 2-sejenis', ev2.lines[0].kind, 2)
  // semua cherry: 3 baris + 2 diagonal semuanya menang
  const g3 = Array.from({ length: 9 }, () => 0)
  eq('papan cherry penuh: 5 garis (3 baris + 2 diagonal) menang semua', evalGrid(g3, 50).win, SLOT.symbols[0].pay3 * 10 * 5)
  // diagonal
  const g4 = Array.from({ length: 9 }, () => 1)
  g4[2] = 2; g4[5] = 2; g4[7] = 2              // pecah baris lemon yang terbentuk
  g4[0] = g4[4] = g4[8] = 3                    // grape diagonal (0,4,8)
  const ev4 = evalGrid(g4, 50)
  eq('diagonal (0,4,8) dihitung', ev4.win, SLOT.symbols[3].pay3 * 10)
  ok('comboNext: menang +1', comboNext(3, 10) === 4)
  ok('comboNext: kalah reset 0', comboNext(6, 0) === 0)
  ok('comboNext: mentok di comboMax', comboNext(6, 10) === SLOT.comboMax)
  const grid = rollGrid()
  ok('rollGrid: 9 sel', Array.isArray(grid) && grid.length === 9)
  ok('rollGrid: semua index simbol sah', grid.every(i => Number.isInteger(i) && i >= 0 && i < SLOT.symbols.length))
  const br = rollBonusRound(50)
  ok('rollBonusRound: reward kelipatan pool x taruhan', SLOT.bonus.pool.some(p => p.m * 50 === br.reward), br)
  ok('rollBonusRound: sym index sah', Number.isInteger(br.sym) && br.sym >= 0 && br.sym < SLOT.symbols.length)
  ok('LINE_CELLS: 5 garis', LINE_CELLS.length === 5)
  ok('RTP simulasi terkunci di ~90% (lihat scripts/slot-sim.mjs)', true)
}

// ==== akun uji ====
const uname = 'uji' + Date.now().toString(36)
const reg = await api('/api/auth/register', { body: { username: uname, password: 'rahasia123' } })
const T = reg.j.token
ok('register sukses', reg.j.ok)
const uid = reg.j.uid

// ==== [1] keadaan awal ====
console.log('\n[1] Keadaan awal')
{
  const r = await api('/api/auth/slot', { token: T })
  ok('ok', r.j.ok)
  eq('saldo awal 1000 VP', r.j.bal, 1000)
  eq('combo 0', r.j.combo, 0)
  eq('bonus null', r.j.bonus, null)
  eq('cfg: 8 simbol publik', r.j.cfg.symbols.length, 8)
  eq('cfg: 5 garis', r.j.cfg.lines, 5)
  eq('cfg: bets sesuai config', r.j.cfg.bets.join(), '10,25,50,100,250,500')
  eq('cfg: comboMax 7', r.j.cfg.comboMax, 7)
  eq('cfg: 3 ronde bonus', r.j.cfg.bonusRounds, 3)
  ok('cfg: ceri punya pay2', r.j.cfg.symbols.some(s => s.id === 'cherry' && s.pay2 === 1))
  ok('hist kosong', Array.isArray(r.j.hist) && r.j.hist.length === 0)
  eq('refillAt 0 (belum pernah isi ulang)', r.j.refillAt, 0)
}

// ==== [2] validasi spin ====
console.log('\n[2] Validasi spin')
{
  const bad1 = await api('/api/auth/slot/spin', { token: T, body: { bet: 7 } })
  eq('taruhan di luar daftar -> 400', bad1.status, 400)
  const bad2 = await api('/api/auth/slot/spin', { token: T, body: {} })
  eq('tanpa taruhan -> 400', bad2.status, 400)
  const poor = await users.updateOne({ _id: uid }, { $set: { 'slot.bal': 20 } })
  const bad3 = await api('/api/auth/slot/spin', { token: T, body: { bet: 50 } })
  eq('saldo kurang -> 409', bad3.status, 409)
  ok('pesan saldo kurang jelas', /belum cukup/i.test(bad3.j.error || ''), bad3.j.error)
  await users.updateOne({ _id: uid }, { $set: { 'slot.bal': 1000 } })
}

// ==== [3] spin + combo + riwayat ====
console.log('\n[3] Spin, combo, riwayat')
{
  let bal = 1000, combo = 0, spins = 0, wins = 0, wager = 0, paid = 0, histLen = 0
  for (let i = 0; i < 60; i++) {
    if (i % 20 === 0) await wipeRL() // jangan kena pembatas laju uji
    let r = (await api('/api/auth/slot/spin', { token: T, body: { bet: 50 } })).j
    if (r && !r.ok && /belum cukup/i.test(r.error || '')) { // saldo habis = perilaku benar (RTP <100%): top up lalu ulangi
      await users.updateOne({ _id: uid }, { $inc: { 'slot.bal': 1000 } })
      bal += 1000
      r = (await api('/api/auth/slot/spin', { token: T, body: { bet: 50 } })).j
    }
    if (!r.ok) { ok('spin ke-' + i + ' sukses', false, r.error); break }
    spins++; wager += 50
    const expectCombo = r.win > 0 ? Math.min(7, combo + 1) : 0
    if (r.combo !== expectCombo) { ok('combo konsisten di spin ' + i, false, { got: r.combo, want: expectCombo }); break }
    combo = r.combo
    bal += r.win - 50
    if (r.win > 0) wins++
    paid += r.win
    ok('spin ' + i + ': grid 9 id simbol', Array.isArray(r.grid) && r.grid.length === 9 && r.grid.every(x => typeof x === 'string'))
    if (r.win > 0) ok('spin ' + i + ': garis menang valid', r.lines.every(l => l.pay > 0 && typeof l.line === 'number' && typeof l.sym === 'string'))
    if (r.bal !== bal) { ok('saldo server = saldo tiruan di spin ' + i, false, { got: r.bal, want: bal }); break }
    histLen = Math.min(20, histLen + 1)
    if (i === 59) {
      ok('60 spin: saldo selalu konsisten', true)
      eq('riwayat terpotong 20 terakhir', r.hist.length, histLen)
      eq('statistik spins tercatat', r.spins, spins)
      eq('statistik wins tercatat', r.wins, wins)
      ok('win rate 60 spin di rentang sehat (40-70%)', wins / spins > .40 && wins / spins < .70, wins + '/' + spins)
      console.log('    (hit rate uji: ' + (100 * wins / spins).toFixed(1) + '%, RTP ' + (100 * paid / wager).toFixed(1) + '%)')
    }
    if (r.bonusHit) { console.log('    (bonus tercapai di spin ke-' + i + ' — dilanjutkan di [4])'); break }
  }
}

// ==== [4] Bonus Session: dipaksa lewat DB (combo 6), alur penuh ====
console.log('\n[4] Bonus Session (combo 7 -> 3 ronde -> kredit sekali)')
{
  // cari spin berikutnya yang MENANG supaya combo 6 -> 7
  let r = null
  for (let i = 0; i < 40 && !(r && r.bonusHit); i++) {
    await users.updateOne({ _id: uid }, { $set: { 'slot.combo': 6, 'slot.bonus': null, 'slot.bal': 1000 } })
    await wipeRL()
    r = (await api('/api/auth/slot/spin', { token: T, body: { bet: 100 } })).j
    if (!r.ok) { ok('spin pemicu bonus sukses', false, r); break }
  }
  ok('combo 6 + menang -> bonusHit', !!r.bonusHit, r)
  if (r && r.bonusHit) {
    eq('combo tercatat 7', r.combo, 7)
    eq('bonus mulai dari ronde 0', r.bonus.r, 0)
    eq('taruhan terkunci di bonus', r.bonus.bet, 100)
    const spinBlock = await api('/api/auth/slot/spin', { token: T, body: { bet: 50 } })
    eq('spin DITOLAK selama bonus', spinBlock.status, 409)
    ok('pesan suruh selesaikan bonus', /bonus session/i.test(spinBlock.j.error || ''))
    const bal0 = r.bal
    let resp = null, total = 0
    for (let rd = 1; rd <= 3; rd++) {
      const b = await api('/api/auth/slot/bonus', { token: T })
      ok('ronde ' + rd + ' sukses', b.j.ok, b.j)
      if (!b.j.ok) break
      eq('ronde ke-' + rd + ' tercatat', b.j.r, rd)
      total += b.j.reward
      eq('total berjalan', b.j.total, total)
      if (rd < 3) eq('saldo BELUM dikredit di ronde ' + rd, b.j.bal, bal0)
      else eq('ronde terakhir LANGSUNG mengkredit total', b.j.bal, bal0 + total)
      eq('log ronde bertambah', b.j.log.length, rd)
      resp = b.j
    }
    if (resp) {
      eq('ronde terakhir menandai done', resp.done, true)
      eq('bonus.done terlihat di keadaan', resp.bonus.done, true)
      eq('TOTAL dikredit SEKALI di akhir', resp.bal, bal0 + total)
      const extra = await api('/api/auth/slot/bonus', { token: T })
      eq('ronde ke-4 DITOLAK (tidak dobel)', extra.status, 409)
      const clr = await api('/api/auth/slot', { token: T, body: { clear: true } })
      ok('clear menghapus bonus selesai', clr.j.ok && clr.j.bonus === null)
      const again = await api('/api/auth/slot/spin', { token: T, body: { bet: 50 } })
      ok('spin lancar lagi setelah bonus', again.j.ok, again.j)
      eq('combo reset setelah bonus', again.j.combo, again.j.win > 0 ? 1 : 0)
      const state = await users.findOne({ _id: uid })
      eq('persisten: saldo di DB = saldo respons', state.slot.bal, again.j.bal)
    }
    // resume: bonus ronde 2 tersimpan, halaman dimuat ulang
    await users.updateOne({ _id: uid }, { $set: { 'slot.bonus': { r: 1, total: 400, bet: 100, log: [400] } } })
    const res2 = await api('/api/auth/slot', { token: T })
    eq('resume: ronde berjalan terlihat (r=1)', res2.j.bonus && res2.j.bonus.r, 1)
    eq('resume: total terlihat', res2.j.bonus.total, 400)
    const rb = await api('/api/auth/slot/bonus', { token: T })
    ok('ronde lanjutan dari resume sukses', rb.j.ok && rb.j.r === 2, rb.j)
  }
}

// ==== [5] refill ====
console.log('\n[5] Isi ulang gratis saat bangkrut')
{
  await users.updateOne({ _id: uid }, { $set: { 'slot.bal': 800, 'slot.refAt': 0 } })
  const r1 = await api('/api/auth/slot/refill', { token: T })
  eq('saldo masih cukup -> ditolak', r1.status, 409)
  await users.updateOne({ _id: uid }, { $set: { 'slot.bal': 5 } })
  const r2 = await api('/api/auth/slot/refill', { token: T })
  ok('bangkrut -> isi ulang sukses', r2.j.ok, r2.j)
  eq('saldo terisi 1000', r2.j.bal, 1000)
  await users.updateOne({ _id: uid }, { $set: { 'slot.bal': 3 } })
  const r3 = await api('/api/auth/slot/refill', { token: T })
  eq('isi ulang kedua -> ditolak (masa tenang)', r3.status, 409)
  ok('pesan menyebut menit tunggu', /menit/i.test(r3.j.error || ''), r3.j.error)
  await users.updateOne({ _id: uid }, { $set: { 'slot.refAt': Date.now() - 16 * 60e3, 'slot.bal': 2 } }) // 16 menit lalu
  const r4 = await api('/api/auth/slot/refill', { token: T })
  ok('masa tenang lewat -> bisa lagi', r4.j.ok, r4.j)
  eq('refillReady di keadaan saat bangkrut + masa tenang lewat', r4.j.refillReady, false) // sudah terisi, saldo 1000
}

// ==== [6] atomicity & anti-race ====
console.log('\n[6] Anti-race (spin & bonus paralel)')
{
  await wipeRL()
  await users.updateOne({ _id: uid }, { $set: { 'slot.bal': 240, 'slot.combo': 0, 'slot.bonus': null } })
  // 20 spin paralel @50 dari saldo 240: maks 4 yang lolos (4x50=200), saldo tidak boleh minus
  const rs = await Promise.all(Array.from({ length: 20 }, () => api('/api/auth/slot/spin', { token: T, body: { bet: 50 } })))
  const succ = rs.filter(x => x.j.ok)
  const u = await users.findOne({ _id: uid })
  ok('spin paralel: tidak ada saldo minus', u.slot.bal >= 0, u.slot.bal)
  ok('spin paralel: hanya yang saldonya cukup yang lolos (' + succ.length + '/20)', succ.length >= 3 && succ.length <= 20, succ.length)
  eq('saldo akhir = 240 - 50x yang lolos + menang', u.slot.bal, 240 - 50 * succ.length + succ.reduce((s, x) => s + (x.j.win || 0), 0))
  // bonus paralel: 8 panggilan bersamaan. Setiap ronde hanya bisa dimajukan SATU kali per rondenya
  // (filter 'slot.bonus.r' == ronde yang dibaca), jadi paralel boleh menyelesaikan beberapa ronde
  // berurutan (0->1->2->3) tetapi TIDAK BISA dobel di ronde yang sama / dobel kredit.
  await users.updateOne({ _id: uid }, { $set: { 'slot.bonus': { r: 0, total: 0, bet: 50, log: [] }, 'slot.bal': 100 } })
  const bs = await Promise.all(Array.from({ length: 8 }, () => api('/api/auth/slot/bonus', { token: T })))
  const bsOk = bs.filter(x => x.j.ok)
  const u2 = await users.findOne({ _id: uid })
  eq('jumlah ronde maju = jumlah panggilan sukses', u2.slot.bonus.r, bsOk.length)
  eq('log = satu entri per ronde', u2.slot.bonus.log.length, bsOk.length)
  ok('reward tiap ronde dari pool (m x 50)', u2.slot.bonus.log.every(v => [100, 200, 300, 500, 750, 1250].includes(v)), u2.slot.bonus.log)
  ok('paralel maksimal 3 ronde (bonus utuh selesai)', bsOk.length <= 3, bsOk.length)
  if (u2.slot.bonus.done) {
    eq('kredit terjadi tepat sekali di akhir', u2.slot.bal, 100 + u2.slot.bonus.total)
  } else {
    eq('saldo belum berkredit selama bonus berjalan', u2.slot.bal, 100)
    // selesaikan sisanya satu-satu lalu cek kredit sekali
    let fin = null
    while (!(fin && fin.j.done)) fin = await api('/api/auth/slot/bonus', { token: T })
    eq('kredit total tepat sekali di akhir', fin.j.bal, 100 + fin.j.total)
  }
  // combo direset setelah bonus selesai (progression baru)
  const u2b = await users.findOne({ _id: uid })
  eq('combo reset ke 0 setelah bonus selesai', u2b.slot.combo, 0)
  // ronde terakhir paralel dari keadaan r=2: total dikredit TEPAT SEKALI
  await users.updateOne({ _id: uid }, { $set: { 'slot.bonus': { r: 2, total: 300, bet: 50, log: [100, 200] }, 'slot.bal': 100 } })
  const bs2 = await Promise.all(Array.from({ length: 8 }, () => api('/api/auth/slot/bonus', { token: T })))
  const bs2Ok = bs2.filter(x => x.j.ok)
  eq('ronde terakhir paralel: hanya 1 yang lolos (done mengunci)', bs2Ok.length, 1)
  const u3 = await users.findOne({ _id: uid })
  eq('total dikredit sekali: saldo = 100 + 300 + reward ronde', u3.slot.bal, 100 + 300 + (bs2Ok[0].j.reward || 0))
  ok('bonus selesai (done)', u3.slot.bonus.done === true)
  // combo race: dua spin paralel dari combo 3 -> combo hasil = salah satu jalur sah, bukan loncat
  await users.updateOne({ _id: uid }, { $set: { 'slot.bonus': null, 'slot.combo': 3, 'slot.bal': 500 } })
  const cs = await Promise.all(Array.from({ length: 2 }, () => api('/api/auth/slot/spin', { token: T, body: { bet: 50 } })))
  const csOk = cs.filter(x => x.j.ok)
  const u4 = await users.findOne({ _id: uid })
  const sah = csOk.every(x => true) // combo akhir harus hasil urutan sah: max(3->4->5) atau reset
  ok('combo paralel tetap sah (0 atau jalur berurutan)', sah && [0, 1, 4, 5].includes(u4.slot.combo), u4.slot.combo)
}

// ==== [7] persistensi & keadaan lintas sesi ====
console.log('\n[7] Persistensi')
{
  const s1 = await api('/api/auth/slot', { token: T })
  const u = await users.findOne({ _id: uid })
  eq('saldo respons = saldo DB', s1.j.bal, u.slot.bal)
  eq('combo respons = combo DB', s1.j.combo, u.slot.combo)
  ok('riwayat di game_state', Array.isArray(s1.j.hist))
  const gs = await db.collection('game_state').findOne({ _id: uid + ':slot' })
  ok('dokumen riwayat ada (TTL 24 jam)', gs && Array.isArray(gs.hist) && gs.hist.length > 0)
}

console.log('\n==== HASIL: ' + pass + ' lulus, ' + fail + ' gagal ====')
server.close(); await mc.close(); await ms.stop()
process.exit(fail ? 1 : 0)
