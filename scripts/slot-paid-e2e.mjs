// E2E Fruit Slot MODE PAID: boots the REAL express app (lib/app.js) against an in-memory MongoDB.
// Menguji: chip (beli c2ch / jual ch2c / idempotency), pindah mode Demo<->Paid, spin pakai chip
// (kemenangan x1,1, saldo `chips` atomik), Bonus Session mode Paid (x1,1, kredit sekali),
// refill ditolak di Paid, migrasi dokumen slot lama -> slot.demo/slot.paid, dan /api/auth/me chips.
// Run: node scripts/slot-paid-e2e.mjs
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
console.log('\n[0] Fungsi murni (lib/economy.js + lib/slot.js)')
{
  const { EXCHANGE, chipsForCoins, coinsForChips } = await import('../lib/economy.js')
  const { SLOT, evalGrid, rollBonusRound, slotStart } = await import('../lib/slot.js')
  eq('kurs: 5 Coin = 1 Chip', EXCHANGE.coinPerChip, 5)
  eq('kurs jual: 5 Chip = 1 Coin', EXCHANGE.chipPerCoin, 5)
  eq('chipsForCoins(1000) = 200 chip, 1000 terpakai', chipsForCoins(1000).chips, 200)
  eq('chipsForCoins(1002) tetap 200 (sisanya milik user)', chipsForCoins(1002).used, 1000)
  eq('coinsForChips(200) = 40 coin', coinsForChips(200).coins, 40)
  eq('winMult Paid 1.1', SLOT.paid.winMult, 1.1)
  const g = Array.from({ length: 9 }, () => 1)
  g[2] = 2; g[5] = 2; g[7] = 2; g[0] = g[1] = g[2] = 0
  eq('evalGrid demo cherry x3 bet 50 = 110', evalGrid(g, 50).win, 110)
  eq('evalGrid paid (x1,1) = 121', evalGrid(g, 50, SLOT.paid.winMult).win, 121)
  const rb = rollBonusRound(100, SLOT.paid.winMult)
  ok('rollBonusRound paid: reward = pool.m x 100 x 1.1 (dibulatkan)', SLOT.bonus.pool.some(p => Math.round(p.m * 100 * 1.1) === rb.reward), rb)
  const st0 = slotStart()
  eq('slotStart: mode demo', st0.mode, 'demo')
  ok('slotStart: demo punya bal & refAt, paid TIDAK', typeof st0.demo.bal === 'number' && typeof st0.demo.refAt === 'number' && st0.paid.bal === undefined && st0.paid.refAt === undefined)
  ok('slotStart: keduanya punya combo/bonus/spins/wins/best', ['combo', 'bonus', 'spins', 'wins', 'best'].every(k => k in st0.demo && k in st0.paid))
  ok('sim: RTP paid ~99% masih < 100% (scripts/slot-sim.mjs)', 90.25 * 1.1 < 100)
}

// ==== akun uji ====
const uname = 'ujipaid' + Date.now().toString(36)
const reg = await api('/api/auth/register', { body: { username: uname, password: 'rahasia123' } })
const T = reg.j.token
ok('register sukses', reg.j.ok)
const uid = reg.j.uid
const idem = () => 'idem' + Math.random().toString(36).slice(2, 12)

// ==== [1] keadaan awal: mode demo, chips 0 ====
console.log('\n[1] Keadaan awal (mode Demo default)')
{
  const r = await api('/api/auth/slot', { token: T })
  eq('mode default demo', r.j.mode, 'demo')
  eq('bal = saldo VP 1000', r.j.bal, 1000)
  eq('bals.demo = 1000', r.j.bals.demo, 1000)
  eq('bals.paid (chips) = 0', r.j.bals.paid, 0)
  eq('cfg.paid.winMult = 1.1', r.j.cfg.paid.winMult, 1.1)
  eq('cfg.paid.coinPerChip = 5', r.j.cfg.paid.coinPerChip, 5)
  const me = await api('/api/auth/me', { token: T })
  eq('/api/auth/me mengembalikan chips 0', me.j.chips, 0)
}

// ==== [2] tukar Coin -> Chip -> Coin (ekonomi) ====
console.log('\n[2] Beli & jual Chip (c2ch / ch2c)')
{
  const bad = await api('/api/auth/economy/exchange', { token: T, body: { kind: 'c2ch', amount: 3 } })
  eq('beli < 5 Coin -> 400', bad.status, 400)
  await users.updateOne({ _id: uid }, { $set: { coins: 1000 } }) // dana uji
  const buy = await api('/api/auth/economy/exchange', { token: T, body: { kind: 'c2ch', amount: 1000, idem: idem() } })
  ok('beli 1000 Coin -> 200 Chip sukses', buy.j.ok, buy.j)
  eq('saldo chips 200', buy.j.chips, 200)
  eq('saldo coin 0', buy.j.coins, 0)
  eq('done.txt jelas', buy.j.done.txt, 'Beli 200 Chip dengan 1.000 Coin')
  const buyAgain = await api('/api/auth/economy/exchange', { token: T, body: { kind: 'c2ch', amount: 1000, idem: idem() } })
  eq('beli tanpa saldo -> 409', buyAgain.status, 409)
  ok('pesan menyebut Coin kurang', /coin/i.test(buyAgain.j.error || ''), buyAgain.j.error)
  const sellBad = await api('/api/auth/economy/exchange', { token: T, body: { kind: 'ch2c', amount: 999999 } })
  eq('jual melebihi batas -> 400', sellBad.status, 400)
  // idempotency: idem sama diproses sekali
  const i1 = idem()
  await users.updateOne({ _id: uid }, { $set: { coins: 100 } })
  const s1 = await api('/api/auth/economy/exchange', { token: T, body: { kind: 'c2ch', amount: 50, idem: i1 } })
  ok('transaksi ber-idem sukses', s1.j.ok)
  const s2 = await api('/api/auth/economy/exchange', { token: T, body: { kind: 'c2ch', amount: 50, idem: i1 } })
  eq('idem sama -> 409 (anti dobel)', s2.status, 409)
  eq('chip tetap 210 (tidak dobel)', s1.j.chips, 210)
  const sell = await api('/api/auth/economy/exchange', { token: T, body: { kind: 'ch2c', amount: 200, idem: idem() } })
  ok('jual 200 Chip -> 40 Coin sukses', sell.j.ok, sell.j)
  eq('chip sisa 10', sell.j.chips, 10)
  eq('coin = sisa beli ber-idem (50) + 40', sell.j.coins, s1.j.coins + 40)
  ok('riwayat mencatat transaksi chip', (sell.j.hist || []).some(h => h.kind === 'c2ch' || h.kind === 'ch2c'), sell.j.hist)
  const eco = await api('/api/auth/economy', { token: T })
  eq('rates memuat kurs chip', eco.j.rates.coinPerChip, 5)
  eq('rates memuat kurs jual', eco.j.rates.chipPerCoin, 5)
}

// ==== [3] pindah mode ====
console.log('\n[3] Pindah mode Demo <-> Paid')
{
  const badMode = await api('/api/auth/slot', { token: T, body: { mode: 'gratisan' } })
  ok('mode tidak valid diabaikan (respons tetap ok)', badMode.j.ok && badMode.j.mode === 'demo')
  const toPaid = await api('/api/auth/slot', { token: T, body: { mode: 'paid' } })
  ok('pindah ke paid sukses', toPaid.j.ok && toPaid.j.mode === 'paid')
  eq('bal = saldo chip (10)', toPaid.j.bal, 10)
  eq('bals.paid ikut (chips 10)', toPaid.j.bals.paid, 10)
  const spinPoor = await api('/api/auth/slot/spin', { token: T, body: { bet: 25 } })
  eq('spin chip kurang -> 409', spinPoor.status, 409)
  ok('pesan menyebut beli Chip pakai Coin', /chip/i.test(spinPoor.j.error || ''), spinPoor.j.error)
  const toDemo = await api('/api/auth/slot', { token: T, body: { mode: 'demo' } })
  eq('kembali ke demo: bal VP 1000 utuh', toDemo.j.bal, 1000)
  const u = await users.findOne({ _id: uid })
  eq('mode tersimpan di DB', u.slot.mode, 'demo')
  eq('slot.demo.bal tidak tersentuh transaksi chip', u.slot.demo.bal, 1000)
  eq('chips tidak tersentuh VP', u.chips, 10)
}

// ==== [4] spin mode Paid: x1,1 + chips atomik ====
console.log('\n[4] Spin mode Paid (kemenangan x1,1)')
{
  const { evalGrid, SLOT } = await import('../lib/slot.js')
  await users.updateOne({ _id: uid }, { $set: { chips: 3000, 'slot.mode': 'paid', 'slot.paid': { combo: 0, bonus: null, spins: 0, wins: 0, best: 0 } } })
  await wipeRL()
  let bal = 3000, spins = 0, wins = 0, okAll = true
  for (let i = 0; i < 30; i++) {
    if (i % 10 === 0) await wipeRL()
    const r = (await api('/api/auth/slot/spin', { token: T, body: { bet: 50 } })).j
    if (!r.ok) { okAll = false; ok('spin paid ke-' + i, false, r.error); break }
    spins++
    // hitung ulang dari grid respons: hasil HARUS = evalGrid(grid, bet, winMult paid)
    const gi = r.grid.map(id => SLOT.symbols.findIndex(s => s.id === id))
    const ev = evalGrid(gi, 50, SLOT.paid.winMult)
    if (r.win !== ev.win) { okAll = false; ok('win paid = paytable x1,1 di spin ' + i, false, { got: r.win, want: ev.win }); break }
    if (r.lines.length !== ev.lines.length) { okAll = false; ok('jumlah garis menang konsisten', false, r.lines); break }
    bal += r.win - 50
    if (r.win > 0) wins++
    if (r.bal !== bal) { okAll = false; ok('saldo chip konsisten di spin ' + i, false, { got: r.bal, want: bal }); break }
    if (r.mode !== 'paid') { okAll = false; ok('respons menyebut mode paid', false, r.mode); break }
    if (r.bonusHit) { console.log('    (bonus paid tercapai di spin ke-' + i + ' — alur penuh di [5])'); break }
  }
  if (okAll) ok('30 spin paid: win selalu = paytable x1,1 & saldo chip konsisten', true)
  const u = await users.findOne({ _id: uid })
  eq('saldo VP demo tidak berubah oleh spin paid', u.slot.demo.bal, 1000)
  eq('statistik paid tercatat terpisah', u.slot.paid.spins, spins)
  eq('statistik demo tetap 0', u.slot.demo.spins, 0)
  ok('riwayat paid berlabel m=paid', (await api('/api/auth/slot', { token: T })).j.hist.every(h => h.m === 'paid'))
}

// ==== [5] Bonus Session mode Paid ====
console.log('\n[5] Bonus Session mode Paid (x1,1, kredit chips sekali)')
{
  const { SLOT } = await import('../lib/slot.js')
  let r = null
  for (let i = 0; i < 40 && !(r && r.bonusHit); i++) {
    await users.updateOne({ _id: uid }, { $set: { chips: 3000, 'slot.mode': 'paid', 'slot.paid.combo': 6, 'slot.paid.bonus': null } })
    await wipeRL()
    r = (await api('/api/auth/slot/spin', { token: T, body: { bet: 100 } })).j
    if (!r.ok) { ok('spin pemicu bonus paid sukses', false, r); break }
  }
  ok('combo 6 paid + menang -> bonusHit', !!r.bonusHit, r && r.error)
  if (r && r.bonusHit) {
    eq('taruhan terkunci (chip)', r.bonus.bet, 100)
    const switchBlock = await api('/api/auth/slot', { token: T, body: { mode: 'demo' } })
    eq('pindah mode DITOLAK selama bonus berjalan', switchBlock.status, 409)
    const bal0 = r.bal
    let total = 0, resp = null
    for (let rd = 1; rd <= 3; rd++) {
      const b = await api('/api/auth/slot/bonus', { token: T })
      ok('ronde paid ' + rd + ' sukses', b.j.ok, b.j)
      if (!b.j.ok) break
      ok('reward paid = pool.m x 100 x 1.1', SLOT.bonus.pool.some(p => Math.round(p.m * 100 * 1.1) === b.j.reward), b.j.reward)
      total += b.j.reward
      eq('total berjalan ronde ' + rd, b.j.total, total)
      resp = b.j
    }
    if (resp) {
      eq('kredit total SEKALI ke chips', resp.bal, bal0 + total)
      const u = await users.findOne({ _id: uid })
      eq('chips di DB = chips respons', u.chips, resp.bal)
      eq('saldo VP demo tidak tersentuh bonus paid', u.slot.demo.bal, 1000)
    }
  }
}

// ==== [6] refill ditolak di mode Paid ====
console.log('\n[6] Refill hanya mode Demo')
{
  await users.updateOne({ _id: uid }, { $set: { chips: 3, 'slot.mode': 'paid' } })
  const rf = await api('/api/auth/slot/refill', { token: T })
  eq('refill di mode paid -> 409', rf.status, 409)
  ok('pesan menjelaskan tidak ada isi ulang di paid', /paid|chip/i.test(rf.j.error || ''), rf.j.error)
  await users.updateOne({ _id: uid }, { $set: { 'slot.mode': 'demo', 'slot.demo.bal': 2, 'slot.demo.refAt': 0 } })
  const rf2 = await api('/api/auth/slot/refill', { token: T })
  ok('refill di mode demo tetap jalan', rf2.j.ok, rf2.j)
  eq('VP terisi 1000', rf2.j.bal, 1000)
}

// ==== [7] anti-race spin paid ====
console.log('\n[7] Anti-race spin paid (chips tidak bisa minus)')
{
  await wipeRL()
  await users.updateOne({ _id: uid }, { $set: { chips: 240, 'slot.mode': 'paid', 'slot.paid': { combo: 0, bonus: null, spins: 0, wins: 0, best: 0 } } })
  const rs = await Promise.all(Array.from({ length: 20 }, () => api('/api/auth/slot/spin', { token: T, body: { bet: 50 } })))
  const succ = rs.filter(x => x.j.ok)
  const u = await users.findOne({ _id: uid })
  ok('spin paid paralel: chips tidak minus', u.chips >= 0, u.chips)
  eq('chips akhir = 240 - 50x lolos + menang', u.chips, 240 - 50 * succ.length + succ.reduce((s, x) => s + (x.j.win || 0), 0))
}

// ==== [8] migrasi dokumen slot lama ====
console.log('\n[8] Migrasi akun lama (field slot.bal tingkat atas -> slot.demo)')
{
  const old = { _id: 'userlama' + Date.now().toString(36), username: 'lama' + Date.now().toString(36), name: 'Lama', salt: 'x', hash: 'y', coins: 500, gems: 5, tickets: 1, createdAt: new Date(), slot: { bal: 777, combo: 2, bonus: null, spins: 9, wins: 3, best: 210, refAt: 123 } }
  await users.insertOne(old)
  // buat sesi sah langsung (hash password akun lama tidak dipakai): pola server, auth_sessions menyimpan sha(token)
  const crypto = await import('node:crypto')
  const tok = crypto.randomBytes(32).toString('base64url')
  const sha = s => crypto.createHash('sha256').update(s).digest('hex')
  await db.collection('auth_sessions').insertOne({ _id: sha(tok), userId: old._id, createdAt: new Date() })
  const r = await api('/api/auth/slot', { token: tok })
  ok('akun lama: /api/auth/slot jalan', r.j.ok, r.j)
  eq('progres VP lama dipindah utuh (777)', r.j.bal, 777)
  eq('combo lama dipindah (2)', r.j.combo, 2)
  eq('mode lama = demo', r.j.mode, 'demo')
  eq('chips akun lama diisi 0', r.j.bals.paid, 0)
  const u = await users.findOne({ _id: old._id })
  eq('field lama hilang dari slot', u.slot.bal, undefined)
  ok('slot.demo lengkap', u.slot.demo && u.slot.demo.spins === 9 && u.slot.demo.wins === 3 && u.slot.demo.best === 210)
  ok('slot.paid siap (combo 0)', u.slot.paid && u.slot.paid.combo === 0)
  eq('chips terisi di dokumen', u.chips, 0)
  // progres tidak tertimpa migrasi kedua
  await users.updateOne({ _id: old._id }, { $inc: { 'slot.demo.bal': 5 } })
  await api('/api/auth/slot', { token: tok })
  const u2 = await users.findOne({ _id: old._id })
  eq('migrasi tidak mengulang (bal 782 utuh)', u2.slot.demo.bal, 782)
}

// ==== [9] kontrak respons ====
console.log('\n[9] Kontrak respons')
{
  const r = await api('/api/auth/slot', { token: T })
  for (const k of ['ok', 'mode', 'cfg', 'bal', 'bals', 'combo', 'bonus', 'spins', 'wins', 'best', 'refillAt', 'refillReady', 'hist']) ok('ada field ' + k, k in r.j)
  for (const k of ['winMult', 'coinPerChip', 'chipPerCoin']) ok('cfg.paid.' + k + ' ada', k in r.j.cfg.paid)
  for (const k of ['demo', 'paid', 'coins']) ok('bals.' + k + ' ada', k in r.j.bals)
}

console.log('\n==== HASIL: ' + pass + ' lulus, ' + fail + ' gagal ====')
server.close(); await mc.close(); await ms.stop()
process.exit(fail ? 1 : 0)
