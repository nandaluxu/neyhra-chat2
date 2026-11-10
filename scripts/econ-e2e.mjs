// E2E Ekonomi: boots the REAL express app (lib/app.js) against an in-memory MongoDB, then runs
// the spec checklist (Coin/Gems/Ticket, tukar bertingkat, gacha single/multi, pity, refund, shop
// kategori, favorit x1.5/x2, idempotency, atomicity). Run: node scripts/econ-e2e.mjs
import fs from 'node:fs'
// hash dev diambil dari lib/dev.js sendiri (ekstraksi runtime) supaya tidak pernah berbeda
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

// ==== pure functions ====
console.log('\n[0] Fungsi murni (lib/economy.js)')
{
  const { gemsForCoins, rollGacha } = await import('../lib/economy.js')
  eq('40 Coin = 1 Gem tanpa bonus', gemsForCoins(40).gems, 1)
  eq('199 Coin -> 4 Gem + sisa coin tidak terpakai', gemsForCoins(199).used, 160)
  eq('tier 200+ -> +5% (200c: base 5, bonus 0)', gemsForCoins(200).bonus, 0) // 5*0.05=0.25 -> floor 0
  eq('tier 800+ -> +12% (800c: base 20, bonus 2)', gemsForCoins(800).bonus, 2)
  eq('tier 2400+ -> +25% (2400c: base 60, bonus 15)', gemsForCoins(2400).bonus, 15)
  eq('total 2400c = 75 gems', gemsForCoins(2400).gems, 75)
  ok('pity 59 -> pull berikut DIJAMIN ring (60x)', rollGacha(59, 1).results[0].t === 'ring')
  let ringHit = false
  for (let i = 0; i < 400 && !ringHit; i++) ringHit = rollGacha(0, 1).results[0].t === 'ring' // c2% ~ 400 percobaan
  ok('RNG 2%: ring pernah keluar tanpa pity (prob. gagal ~0,3%)', ringHit)
  const multi = rollGacha(0, 10)
  eq('multi 10x menghasilkan 10 hasil', multi.results.length, 10)
  eq('refund = 4 gems per kartu gagal', multi.refund, 4 * multi.results.filter(r => r.t === 'gems').length)
}

// ==== akun uji ====
const uname = 'uji' + Date.now().toString(36)
const reg = await api('/api/auth/register', { body: { username: uname, password: 'rahasia123' } })
const T = reg.j.token
ok('register sukses', reg.j.ok)
eq('akun baru dapat 3 tiket awal', reg.j.tickets, 3)

console.log('\n[1] Coin → Gems (bonus bertingkat)')
await api('/api/auth/dev/grant', { token: T, body: { code: 'uji123', coins: 100000, gems: 0 } })
{
  const r = await api('/api/auth/economy/exchange', { token: T, body: { kind: 'c2g', amount: 800, idem: 'aaaa1111bbbb2222' } })
  ok('tukar 800 Coin sukses', r.j.ok, r.j)
  eq('gems naik 22 (20 dasar + 2 bonus)', r.j.gems, 10 + 22)
  eq('coin berkurang 800', r.j.coins, 150 + 100000 - 800)
  const r2 = await api('/api/auth/economy/exchange', { token: T, body: { kind: 'c2g', amount: 2400, idem: 'cccc1111dddd2222' } })
  eq('bonus tier tertinggi: 2400c -> +75 gems total', r2.j.gems, 10 + 22 + 75)
  ok('riwayat mencatat penukaran', (r2.j.hist || []).some(h => h.kind === 'c2g'))
}

console.log('\n[2] Gems TIDAK bisa kembali ke Coin / Ticket tidak bisa ditukar')
{
  const r = await api('/api/auth/economy/exchange', { token: T, body: { kind: 'g2c', amount: 5 } })
  eq('kind g2c ditolak (400)', r.status, 400)
  const r2 = await api('/api/auth/economy/exchange', { token: T, body: { kind: 't2g', amount: 1 } })
  eq('kind t2g ditolak (400)', r2.status, 400)
  const r3 = await api('/api/auth/economy/exchange', { token: T, body: { kind: 'c2g', amount: -100 } })
  eq('jumlah negatif ditolak', r3.status, 400)
  const r4 = await api('/api/auth/economy/exchange', { token: T, body: { kind: 'c2g', amount: 99_999_999 } })
  eq('jumlah di atas batas ditolak', r4.status, 400)
}

console.log('\n[3] Beli Tiket: Coin & Gems')
{
  const c = (await api('/api/auth/economy', { token: T })).j
  const r1 = await api('/api/auth/economy/exchange', { token: T, body: { kind: 'c2t', amount: 2, idem: 'tktc0001aaaa1111' } })
  ok('Coin -> Tiket sukses', r1.j.ok, r1.j)
  eq('2 tiket x 300 coin terpotong', r1.j.coins, c.coins - 600)
  eq('tiket bertambah 2', r1.j.tickets, c.tickets + 2)
  const r2 = await api('/api/auth/economy/exchange', { token: T, body: { kind: 'g2t', amount: 3, idem: 'tktg0001aaaa1111' } })
  eq('3 tiket x 5 gems terpotong', r2.j.gems, r1.j.gems - 15)
  eq('tiket bertambah 3 lagi', r2.j.tickets, r1.j.tickets + 3)
}

console.log('\n[4] Gacha single & multi')
{
  const before = (await api('/api/auth/economy', { token: T })).j
  const r = await api('/api/auth/economy/gacha', { token: T, body: { pulls: 1, idem: 'gcha0001aaaa1111' } })
  ok('single pull sukses', r.j.ok, r.j)
  eq('single pull = 1 hasil', (r.j.results || []).length, 1)
  eq('single pull potong 1 tiket', r.j.tickets, before.tickets - 1)
  // pastikan tiket cukup untuk multi (butuh 9)
  const t0 = (await api('/api/auth/economy', { token: T })).j
  if (t0.tickets < 9) await api('/api/auth/economy/exchange', { token: T, body: { kind: 'g2t', amount: 9 - t0.tickets, idem: 'topup001aaaa1111' } })
  const t1 = (await api('/api/auth/economy', { token: T })).j
  const r10 = await api('/api/auth/economy/gacha', { token: T, body: { pulls: 10, idem: 'gcha0002bbbb2222' } })
  ok('multi pull sukses', r10.j.ok, r10.j)
  eq('multi pull = 10 hasil', (r10.j.results || []).length, 10)
  eq('multi pull potong 9 tiket (hemat 1)', r10.j.tickets, t1.tickets - 9)
  const rings = (r10.j.results || []).filter(x => x.t === 'ring'), gems = (r10.j.results || []).filter(x => x.t === 'gems')
  if (rings.length) {
    eq('ring masuk inventory', rings.reduce((s, x) => s + (r10.j.inv[x.id] || 0), 0) >= rings.length, true)
    ok('riwayat gacha mencatat ring', (r10.j.hist || []).some(h => h.kind === 'gacha' && h.txt.includes('Ring')))
  } else ok('10x tanpa ring: refund tercatat 4/kartu', (r10.j.hist || []).some(h => h.kind === 'gacha' && h.txt.includes('refund 40 Gems')))
  eq('refund gems sesuai aturan (4 per kartu gagal)', r10.j.refund, 4 * gems.length)
}

console.log('\n[5] Shop: kategori, item, beli')
{
  const v = await api('/api/auth/shop', { token: T })
  ok('shop view sukses', v.j.ok, v.j)
  eq('ada 3 kategori', (v.j.cats || []).length, 3)
  eq('ada 16 barang', (v.j.items || []).length, 16)
  ok('semua barang punya kategori', (v.j.items || []).every(i => v.j.cats.some(c => c.id === i.cat)))
  eq('config favorit ikut terkirim', v.j.fav && v.j.fav.furina, 'macaron')
  const b = await api('/api/auth/shop/buy', { token: T, body: { items: { macaron: 2, bir: 3 }, idem: 'beli0001aaaa1111' } })
  ok('beli sukses', b.j.ok, b.j)
  const c = (await api('/api/auth/economy', { token: T })).j
  eq('saldo coin terpotong benar (2x140 + 3x160 = 760)', b.j.coins, v.j.coins - 760)
  eq('inventory macaron = 2', b.j.inv.macaron, 2)
  eq('inventory bir = 3', b.j.inv.bir, 3)
}

console.log('\n[6] Gift favorit vs biasa')
{
  // Aqua: favorit = bir (3 stok). Furina: favorit = macaron.
  const fav = await api('/api/auth/shop/gift', { token: T, body: { char: 'aqua', items: { bir: 2 } } })
  ok('gift favorit sukses', fav.j.ok, fav.j)
  eq('EXP favorit = 64 x 2 x 1.5 = 192', fav.j.exp, Math.round(64 * 2 * 1.5))
  eq('Mood favorit = 6 x 2 x 2 = 24 -> cap 15', fav.j.mood, 15)
  ok('respon menandai favorit (favHit)', !!fav.j.favHit && fav.j.favHit.item === 'bir')
  const norm = await api('/api/auth/shop/gift', { token: T, body: { char: 'aqua', items: { macaron: 1 } } })
  eq('EXP non-favorit normal (55)', norm.j.exp, 55)
  eq('Mood non-favorit normal (5)', norm.j.mood, 5)
  ok('non-favorit tidak menandai favHit', !norm.j.favHit)
  // campuran favorit + biasa: beli roti dulu, lalu berikan macaron (favorit Furina) + roti (biasa)
  await api('/api/auth/shop/buy', { token: T, body: { items: { roti: 1 }, idem: 'beli0002cccc3333' } })
  const mix = await api('/api/auth/shop/gift', { token: T, body: { char: 'furina', items: { macaron: 1, roti: 1 } } })
  ok('gift campuran sukses', mix.j.ok, mix.j)
  eq('campuran: hanya bagian favorit yang dibonus (55x1.5 + 24)', mix.j.exp, Math.round(55 * 1.5) + 24)
  const kurang = await api('/api/auth/shop/gift', { token: T, body: { char: 'furina', items: { bir: 99 } } })
  eq('stok kurang ditolak', kurang.status, 409)
}

console.log('\n[7] Idempotency & anti-eksploitasi')
{
  const before = (await api('/api/auth/economy', { token: T })).j
  const d = { kind: 'c2t', amount: 1, idem: 'dupe0001aaaa1111' }
  const r1 = await api('/api/auth/economy/exchange', { token: T, body: d })
  const r2 = await api('/api/auth/economy/exchange', { token: T, body: d })
  ok('transaksi pertama sukses', r1.j.ok)
  eq('idem yang sama ditolak (409)', r2.status, 409)
  eq('tiket hanya bertambah 1 (bukan 2)', r1.j.tickets, before.tickets + 1)
  const poor = await api('/api/auth/economy/exchange', { token: T, body: { kind: 'c2g', amount: 99999999, idem: 'poor0001aaaa1111' } })
  eq('saldo kurang ditolak', poor.status, 400)
  const gems = (await api('/api/auth/economy', { token: T })).j.gems
  const noGem = await api('/api/auth/economy/exchange', { token: T, body: { kind: 'g2t', amount: 99, idem: 'nogm0001aaaa1111' } })
  eq('beli 99 tiket dengan gems kurang ditolak', noGem.status, 409)
  eq('gems tidak berubah setelah gagal', (await api('/api/auth/economy', { token: T })).j.gems, gems)
}

console.log('\n[8] Race: dua pull paralel dengan tiket cuma cukup satu')
{
  // set tiket jadi pas 1 lewat dua akun? ganti: akun baru khusus race
  const u = 'race' + Date.now().toString(36)
  const t2 = (await api('/api/auth/register', { body: { username: u, password: 'rahasia123' } })).j.token // 3 tiket
  await api('/api/auth/dev/grant', { token: t2, body: { code: 'uji123', coins: 0, gems: 0 } })
  // pakai 2 tiket dulu biar sisa 1
  await api('/api/auth/economy/gacha', { token: t2, body: { pulls: 1, idem: 'rc000001aaaa1111' } })
  await api('/api/auth/economy/gacha', { token: t2, body: { pulls: 1, idem: 'rc000002bbbb2222' } })
  const [a, b] = await Promise.all([
    api('/api/auth/economy/gacha', { token: t2, body: { pulls: 1, idem: 'rc000003cccc3333' } }),
    api('/api/auth/economy/gacha', { token: t2, body: { pulls: 1, idem: 'rc000004dddd4444' } })
  ])
  const statuses = [a.status, b.status].sort()
  ok('salah satu pull paralel sukses, satunya 409', statuses[0] === 200 && statuses[1] === 409, statuses)
  const v = await api('/api/auth/economy', { token: t2 })
  eq('tiket tidak minus (0)', v.j.tickets, 0)
  eq('total tarikan hanya +1 (bukan 2)', v.j.pity.tot, 3)
}

console.log('\n[9] Persistensi (baca ulang dari server)')
{
  const v = await api('/api/auth/economy', { token: T })
  ok('semua data masih ada saat dibaca ulang', v.j.ok)
  ok('riwayat transaksi lengkap (tukar+gacha+beli)', ['c2g', 'c2t', 'g2t', 'gacha', 'buy'].every(k => (v.j.hist || []).some(h => h.kind === k)), v.j.hist && v.j.hist.map(h => h.kind))
  const s = await api('/api/auth/shop', { token: T })
  ok('inventory persisten (macaron masih terpakai dari gift)', (s.j.inv.macaron || 0) === 0) // 2 beli - 1 gift furina - 1 gift aqua(nonfav) = 0
}

console.log('\n' + '='.repeat(52))
console.log(`HASIL: ${pass} lulus, ${fail} gagal`)
server.close(); await ms.stop()
process.exit(fail ? 1 : 0)
