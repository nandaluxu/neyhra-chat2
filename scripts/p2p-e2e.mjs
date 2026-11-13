// E2E Player-to-Player Economy: menyalakan app ASLI (lib/app.js) + MongoDB in-memory, lalu menguji:
// notification center, transfer antar-player (fee/idem/race/batas harian/anti-ternak-akun), bank (bunga
// lazy + setor/tarik), pencurian (gerbang/cooldown/kuota/perisai/kekekalan coin), trading (escrow saat
// accept + kompensasi), marketplace (escrow saat listing + dobel-beli), pekerjaan (cooldown/kuota harian),
// dan purge akun. Run: node scripts/p2p-e2e.mjs (butuh `npm i --no-save mongodb-memory-server`).
//
// Fixture langsung lewat Mongo (pola scripts/econ-e2e.mjs): createdAt dinaik-tuakan supaya akun dianggap
// "berumur" (gerbang anti-ternak), koleksi auth_rl dibersihkan di titik-titik tertentu supaya pembatas
// laju registrasi/aksi yang ketat (dirancang untuk produksi) tidak mengganggu pengujian.
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
const { MongoClient } = await import('mongodb')
const mc = new MongoClient(process.env.MONGODB_URI); await mc.connect()
const db = mc.db()

let pass = 0, fail = 0
const ok = (name, cond, extra) => { if (cond) { pass++; console.log('  ✓', name) } else { fail++; console.log('  ✗ FAIL:', name, extra !== undefined ? JSON.stringify(extra) : '') } }
const eq = (name, a, b) => ok(name, a === b, { got: a, want: b })
const near = (name, a, lo, hi) => ok(name, a >= lo && a <= hi, { got: a, range: [lo, hi] })
const usersC = db.collection('users')
const wait = ms => new Promise(r => setTimeout(r, ms))
const rl = () => db.collection('auth_rl').deleteMany({}).catch(() => { }) // fixture: reset pembatas laju

const TS = Date.now().toString(36)
const reg = async (name) => (await api('/api/auth/register', { body: { username: name, password: 'rahasia123' } })).j
const newAcc = async (name) => { await rl(); return { ...await reg(name + TS), username: name + TS } } // register selalu lolos (limit 5/jam di produksi); respons register tidak memuat username -> ditempel balik
const bal = async (tok) => (await api('/api/auth/me', { token: tok })).j
const setOld = async uname => { await usersC.updateOne({ username: uname }, { $set: { createdAt: new Date(Date.now() - 25 * 3600e3) } }) } // "akun terpercaya" (umur > 24 jam)
const grant = async (tok, coins, gems) => api('/api/auth/dev/grant', { token: tok, body: { code: 'uji123', coins, gems } })

// ==== [0] Fungsi murni ====
console.log('\n[0] Fungsi murni (lib/transfer.js, lib/robbery.js)')
{
  const { netFor, TRANSFER } = await import('../lib/transfer.js')
  eq('fee 5%: 1000 -> net 950, fee 50', netFor(1000).net, 950)
  eq('fee dibulatkan ke bawah', netFor(101).fee, 5)
  eq('fee transfer minimal (100 coin) = 5', netFor(TRANSFER.minCoin).fee, 5)
  const { chanceFor, fineFor, wantedNow, rollSteal } = await import('../lib/robbery.js')
  eq('peluang dasar 35%', chanceFor(0), 0.35)
  eq('wanted 10 -> peluang dibatasi maks 80%', chanceFor(10), 0.8)
  near('incian 5-15% dari dompet 1000 (50-150)', rollSteal(1000), 50, 150)
  near('incian plafon 5000', rollSteal(1e9), 5000, 5000)
  eq('ganti rugi 100 -> 50 (setengah)', fineFor(100), 50)
  eq('ganti rugi dikunci minimum 25', fineFor(10), 25)
  eq('ganti rugi plafon 500', fineFor(1e9), 500)
  eq('wanted meluruh 1/6jam: 3 poin & 7 jam -> 2', wantedNow({ wanted: 3, wantedAt: new Date(Date.now() - 7 * 3600e3) }), 2)
  eq('wanted 0 tetap 0', wantedNow({ wanted: 0 }), 0)
}

// ==== akun uji: A (pengirim utama), B (penerima/bank), C & D (trader/market), E (market) ====
const A = await newAcc('alfa'), B = await newAcc('bravo'), C = await newAcc('charlie'), D = await newAcc('delta'), E = await newAcc('echo')
for (const x of [A, B, C, D, E]) await setOld(x.username) // semua berumur > 24 jam
await grant(A.token, 200000, 0); await grant(B.token, 10000, 0); await grant(C.token, 50000, 0); await grant(D.token, 50000, 0)
const A0 = (await bal(A.token)).coins, B0 = (await bal(B.token)).coins
ok('akun uji siap (A 200k+, B 10k+)', A0 >= 200000 && B0 >= 10000, { A0, B0 })

// ==== [1] Notification center ====
console.log('\n[1] Pusat notifikasi (lib/notify.js)')
await rl()
{
  // transfer kecil supaya B dapat notifikasi (sekaligus pemanasan transfer)
  const t = await api('/api/auth/transfer/send', { token: A.token, body: { to: B.username, coins: 1000, idem: 'ntf00001aaaa1111' } })
  ok('transfer uji notifikasi sukses', t.j.ok, t.j)
  const v = await api('/api/auth/notify', { token: B.token })
  ok('B punya notifikasi', (v.j.items || []).length > 0, v.j)
  ok('notifikasi transfer-in ada', (v.j.items || []).some(x => x.type === 'transfer-in'), v.j.items)
  eq('jumlah belum-baca tercatat', v.j.unread > 0, true)
  ok('id & seen ada di item', (v.j.items || []).every(x => x.id && x.seen === false))
  const s = await api('/api/auth/notify/seen', { token: B.token, body: { id: v.j.items[0].id } })
  eq('tandai satu terbaca', s.j.unread, v.j.unread - 1)
  const bad = await api('/api/auth/notify/seen', { token: B.token, body: { id: 'hack-hack-hack' } })
  eq('id tidak dikenal ditolak (400)', bad.status, 400)
  const s2 = await api('/api/auth/notify/seen', { token: B.token, body: { all: true } })
  eq('tandai semua: belum-baca 0', s2.j.unread, 0)
}

// ==== [2] Transfer antar-player ====
console.log('\n[2] Transfer (lib/transfer.js)')
let ACoins = 0
await rl()
{
  // 2a: transfer coin dengan fee
  const bA = (await bal(A.token)).coins, bB = (await bal(B.token)).coins
  const r = await api('/api/auth/transfer/send', { token: A.token, body: { to: B.username, coins: 5000, idem: 'trf00001aaaa1111' } })
  ok('transfer 5000 sukses', r.j.ok, r.j)
  eq('fee 5% tercatat (250)', r.j.done.fee, 250)
  eq('penerima dapat 4750 bersih', r.j.done.net, 4750)
  eq('A berkurang pas 5000', (await bal(A.token)).coins, bA - 5000)
  eq('B bertambah pas 4750', (await bal(B.token)).coins, bB + 4750)
  ACoins = (await bal(A.token)).coins

  // 2b: transfer barang (beli dulu)
  await api('/api/auth/shop/buy', { token: A.token, body: { items: { macaron: 5, bir: 2 }, idem: 'trfshop1aaaa1111' } })
  const iv = (await api('/api/auth/shop', { token: A.token })).j.inv
  const bBinv = (await api('/api/auth/shop', { token: B.token })).j.inv
  const r2 = await api('/api/auth/transfer/send', { token: A.token, body: { to: B.username, items: { macaron: 3 }, idem: 'trf00002bbbb2222' } })
  ok('transfer 3 macaron sukses', r2.j.ok, r2.j)
  eq('A kehilangan 3 macaron', (await api('/api/auth/shop', { token: A.token })).j.inv.macaron, iv.macaron - 3)
  eq('B menerima 3 macaron', (await api('/api/auth/shop', { token: B.token })).j.inv.macaron, (bBinv.macaron || 0) + 3)

  // 2c: campuran coin + barang
  const bA2 = (await bal(A.token)).coins, bB2 = (await bal(B.token)).coins
  const r3 = await api('/api/auth/transfer/send', { token: A.token, body: { to: B.username, coins: 400, items: { bir: 1 }, idem: 'trf00003cccc3333' } })
  ok('transfer campuran sukses', r3.j.ok, r3.j)
  eq('campuran: A berkurang pas 400', (await bal(A.token)).coins, bA2 - 400)
  eq('campuran: B dapat 380 (fee 20)', (await bal(B.token)).coins, bB2 + 380)
  eq('campuran: bir pindah', (await api('/api/auth/shop', { token: B.token })).j.inv.bir, (bBinv.bir || 0) + 1)

  // 2d: validasi & batas
  await rl()
  eq('coin < minimum (100) ditolak', (await api('/api/auth/transfer/send', { token: A.token, body: { to: B.username, coins: 50, idem: 'trf00004dddd4444' } })).status, 400)
  eq('penerima tak dikenal (404)', (await api('/api/auth/transfer/send', { token: A.token, body: { to: 'nobody' + TS, coins: 500, idem: 'trf00005eeee5555' } })).status, 404)
  eq('transfer ke diri sendiri ditolak', (await api('/api/auth/transfer/send', { token: A.token, body: { to: A.username, coins: 500, idem: 'trf00006ffff6666' } })).status, 400)
  eq('transfer kosong ditolak', (await api('/api/auth/transfer/send', { token: A.token, body: { to: B.username, idem: 'trf00007gggg7777' } })).status, 400)
  eq('barang palsu ditolak eksplisit', (await api('/api/auth/transfer/send', { token: A.token, body: { to: B.username, items: { tidakada: 1 }, idem: 'trf00008hhhh8888' } })).status, 400)
  eq('saldo kurang ditolak (409)', (await api('/api/auth/transfer/send', { token: B.token, body: { to: A.username, coins: 30000, idem: 'trf00009iiii9999' } })).status, 409)

  // 2e: akun baru (tak berumur) tidak boleh transfer keluar
  const F = await newAcc('foxtrot')
  eq('akun < 24 jam ditolak (403, anti ternak)', (await api('/api/auth/transfer/send', { token: F.token, body: { to: B.username, coins: 100, idem: 'trf00010jjjj1010' } })).status, 403)

  // 2f: idempotency
  await rl()
  const d = { to: B.username, coins: 600, idem: 'trfdupe1aaaa1111' }
  const r1 = await api('/api/auth/transfer/send', { token: A.token, body: d })
  const r2d = await api('/api/auth/transfer/send', { token: A.token, body: d })
  ok('transfer pertama sukses', r1.j.ok)
  eq('idem sama ditolak (409)', r2d.status, 409)

  // 2g: batas harian coin 100.000 (hari ini A sudah keluar 1000+5000+400+600 = 7000)
  await rl()
  const rbig = await api('/api/auth/transfer/send', { token: A.token, body: { to: C.username, coins: 92000, idem: 'trf00011kkkk1111' } })
  eq('92.000 masih muat (total jadi 99.000)', rbig.status, 200)
  const rover = await api('/api/auth/transfer/send', { token: A.token, body: { to: C.username, coins: 5000, idem: 'trf00012llll2222' } })
  eq('melebihi batas harian ditolak (429)', rover.status, 429)
  eq('batas harian tampil di ringkasan', (await api('/api/auth/transfer', { token: A.token })).j.daily.coinLeft, 1000)

  // 2h: riwayat econ_log dua pihak
  const histB = (await api('/api/auth/economy', { token: B.token })).j.hist
  ok('riwayat B mencatat transfer-in', (histB || []).some(h => h.kind === 'transfer-in'), histB && histB.map(h => h.kind))
  const histA = (await api('/api/auth/economy', { token: A.token })).j.hist
  ok('riwayat A mencatat transfer-out', (histA || []).some(h => h.kind === 'transfer-out'), histA && histA.map(h => h.kind))

  // 2i: race dua transfer paralel, saldo hanya cukup satu
  const G = await newAcc('golf'); await setOld(G.username); await grant(G.token, 1000, 0)
  const H = await newAcc('hotel'); await setOld(H.username)
  await rl()
  const [x1, x2] = await Promise.all([
    api('/api/auth/transfer/send', { token: G.token, body: { to: H.username, coins: 600, idem: 'trf00013mmmm3333' } }),
    api('/api/auth/transfer/send', { token: G.token, body: { to: H.username, coins: 600, idem: 'trf00014nnnn4444' } })
  ])
  const st = [x1.status, x2.status].sort()
  ok('race: satu sukses satu 409', st[0] === 200 && st[1] === 409, st)
  eq('G tidak minus (sisa 150+1000-600 = 550)', (await bal(G.token)).coins, 550)
  eq('H menerima 570 bersih (satu kali saja)', (await bal(H.token)).coins, 150 + 570)
}

// ==== [3] Bank ====
console.log('\n[3] Bank (lib/bank.js)')
await rl()
{
  const v = await api('/api/auth/bank', { token: B.token })
  ok('ringkasan bank sukses', v.j.ok, v.j)
  eq('bunga 0,5%/hari terkirim', v.j.rates.interestPct, 0.005)
  const dep = await api('/api/auth/bank/deposit', { token: B.token, body: { amount: 5000 } })
  ok('setor 5000 sukses', dep.j.ok, dep.j)
  eq('bank B = 5000', dep.j.bank, 5000)
  eq('dompet berkurang 5000', dep.j.coins, (await bal(B.token)).coins)
  const small = await api('/api/auth/bank/deposit', { token: B.token, body: { amount: 10 } })
  eq('setor < minimum (100) ditolak', small.status, 400)
  eq('setor lebih dari dompet ditolak (409)', (await api('/api/auth/bank/deposit', { token: B.token, body: { amount: 20000 } })).status, 409)

  // bunga lazy: tandai hari terakhir = kemarin -> bunga masuk sekali
  await usersC.updateOne({ username: B.username }, { $set: { bankIntDay: (await import('../lib/bonus.js')).dayNum(Date.now()) - 1 } })
  const v2 = await api('/api/auth/bank', { token: B.token })
  eq('bunga masuk: 5000*0,5% = 25', v2.j.bank, 5025)
  const v3 = await api('/api/auth/bank', { token: B.token })
  eq('bunga tidak dobel di hari yang sama', v3.j.bank, 5025)

  const wd = await api('/api/auth/bank/withdraw', { token: B.token, body: { amount: 1025 } })
  ok('tarik 1025 sukses', wd.j.ok, wd.j)
  eq('bank sisa 4000', wd.j.bank, 4000)
  eq('dompet bertambah 1025', wd.j.coins, (await bal(B.token)).coins)
  eq('tarik lebih dari saldo ditolak', (await api('/api/auth/bank/withdraw', { token: B.token, body: { amount: 9999 } })).status, 409)

  // notifikasi bunga masuk ke pusat notifikasi
  ok('notifikasi bunga tercatat', (await api('/api/auth/notify', { token: B.token })).j.items.some(x => x.type === 'bank'))
}

// ==== [4] Robbery ====
console.log('\n[4] Pencurian (lib/robbery.js)')
await rl()
{
  // 4a: gerbang-gerbang
  eq('mencuri dari diri sendiri ditolak', (await api('/api/auth/rob/attempt', { token: A.token, body: { username: A.username } })).status, 400)
  eq('target tak dikenal (404)', (await api('/api/auth/rob/attempt', { token: A.token, body: { username: 'nobody' + TS } })).status, 404)
  const poor = await newAcc('india') // dompet 150 < pocketMin 500
  eq('target terlalu tipis ditolak (400)', (await api('/api/auth/rob/attempt', { token: A.token, body: { username: poor.username } })).status, 400)
  await grant(poor.token, 10000, 0) // sekarang targetnya kaya, tapi pencurinya bokek (150 < stake 200)
  const poorAtk = await newAcc('juliet'); await setOld(poorAtk.username) // berumur supaya yang diuji adalah gerbang modal, bukan gerbang umur
  eq('pencuri bokek ditolak (400)', (await api('/api/auth/rob/attempt', { token: poorAtk.token, body: { username: poor.username } })).status, 400)
  const fresh = await newAcc('kilo')
  eq('pencuri akun baru ditolak (403)', (await api('/api/auth/rob/attempt', { token: fresh.token, body: { username: poor.username } })).status, 403)

  // 4b: satu percobaan sungguhan — invariant: total coin kedua pihak TIDAK berubah (hanya berpindah)
  const bA = (await bal(A.token)).coins, bB = (await bal(B.token)).coins // B: dompet > 500 & tanpa perisai
  const r = await api('/api/auth/rob/attempt', { token: A.token, body: { username: B.username } })
  ok('percobaan sah menghasilkan out', ['win', 'fail', 'shield'].includes(r.j.out), r.j)
  const aA = (await bal(A.token)).coins, aB = (await bal(B.token)).coins
  eq('pencurian memindahkan coin, tidak mencipta (total sama)', aA + aB, bA + bB)
  const v = await api('/api/auth/rob', { token: A.token })
  ok('statistik pencuri tercatat', v.j.stats.win + v.j.stats.fail >= 1, v.j.stats)
  ok('riwayat rob tercatat', (v.j.hist || []).length >= 1)
  ok('korban dapat notifikasi', (await api('/api/auth/notify', { token: B.token })).j.items.some(x => x.type === 'rob'))

  // 4c: cooldown langsung
  eq('percobaan kedua langsung kena cooldown (429)', (await api('/api/auth/rob/attempt', { token: A.token, body: { username: B.username } })).status, 429)

  // 4d: kuota harian (rob.n = 5) -> 429 walau cooldown sudah lewat
  const day = Math.floor((Date.now() + 7 * 3600e3) / 86400e3)
  await usersC.updateOne({ username: A.username }, { $set: { 'rob.day': day, 'rob.n': 5, 'rob.lastAt': Date.now() - 31 * 60e3 } })
  eq('kuota harian habis (429)', (await api('/api/auth/rob/attempt', { token: A.token, body: { username: B.username } })).status, 429)

  // 4e: perisai menang deterministik
  await grant(B.token, 0, 10)
  const gemsBefore = (await bal(B.token)).gems
  const sh = await api('/api/auth/rob/shield', { token: B.token })
  ok('beli perisai dengan 5 gems sukses', sh.j.ok, sh.j)
  eq('gems terpotong 5', (await bal(B.token)).gems, gemsBefore - 5)
  await usersC.updateOne({ username: A.username }, { $set: { 'rob.n': 4, 'rob.lastAt': Date.now() - 31 * 60e3 } })
  const bA2 = (await bal(A.token)).coins, bB2 = (await bal(B.token)).coins
  const rsh = await api('/api/auth/rob/attempt', { token: A.token, body: { username: B.username } })
  eq('perisai: hasil shield (deterministik)', rsh.j.out, 'shield')
  eq('perisai: ganti rugi pindah ke korban (total tetap)', (await bal(A.token)).coins + (await bal(B.token)).coins, bA2 + bB2)
  ok('ganti rugi dibayar pencuri', (rsh.j.fine || 0) >= 25, rsh.j)
  await usersC.updateOne({ username: fresh.username }, { $set: { gems: 2 } })
  eq('gems kurang ditolak (409)', (await api('/api/auth/rob/shield', { token: fresh.token })).status, 409)

  // 4f: wanted meluruh saat dibaca
  await usersC.updateOne({ username: A.username }, { $set: { 'rob.wanted': 3, 'rob.wantedAt': new Date(Date.now() - 7 * 3600e3) } })
  const vw = await api('/api/auth/rob', { token: A.token })
  eq('wanted 3 & 7 jam -> terbaca 2', vw.j.stats.wanted, 2)
}

// ==== [5] Trading ====
console.log('\n[5] Trading (lib/trade.js)')
await rl()
{
  // inventaris untuk trading
  await api('/api/auth/shop/buy', { token: C.token, body: { items: { roti: 10 }, idem: 'trdbuyc1aaaa1111' } })
  await api('/api/auth/shop/buy', { token: D.token, body: { items: { teh: 10 }, idem: 'trdbuyd1bbbb2222' } })

  // 5a: buat penawaran C -> D: 3 roti + 200 coin <> 2 teh
  const cr = await api('/api/auth/trade/create', { token: C.token, body: { to: D.username, offer: { coins: 200, items: { roti: 3 } }, want: { items: { teh: 2 } }, idem: 'trd00001cccc3333' } })
  ok('penawaran dibuat', cr.j.ok, cr.j)
  const v = await api('/api/auth/trade', { token: D.token })
  ok('penawaran masuk terlihat D', (v.j.incoming || []).length >= 1, v.j)
  eq('penawar tidak kehilangan barang saat membuat', (await api('/api/auth/shop', { token: C.token })).j.inv.roti, 10)

  // 5b: accept — escrow & tukar
  const cCoins = (await bal(C.token)).coins, dCoins = (await bal(D.token)).coins
  const tr = v.j.incoming[0]
  const ac = await api('/api/auth/trade/accept', { token: D.token, body: { id: tr.id } })
  ok('penawaran diterima', ac.j.ok, ac.j)
  eq('C kehilangan 200 coin', (await bal(C.token)).coins, cCoins - 200)
  eq('D dapat 200 coin', (await bal(D.token)).coins, dCoins + 200)
  eq('C menerima 2 teh', (await api('/api/auth/shop', { token: C.token })).j.inv.teh, 2)
  eq('C kehilangan 3 roti', (await api('/api/auth/shop', { token: C.token })).j.inv.roti, 7)
  eq('D kehilangan 2 teh', (await api('/api/auth/shop', { token: D.token })).j.inv.teh, 8)
  ok('notifikasi trade-done ke penawar', (await api('/api/auth/notify', { token: C.token })).j.items.some(x => x.type === 'trade-done'))

  // 5c: stok penerima kurang saat accept -> penawaran tetap pending, tidak ada yang berubah
  const cr2 = await api('/api/auth/trade/create', { token: C.token, body: { to: D.username, offer: { coins: 100, items: { roti: 2 } }, want: { items: { teh: 99 } }, idem: 'trd00002dddd4444' } })
  ok('penawaran kedua dibuat', cr2.j.ok, cr2.j)
  const ac2 = await api('/api/auth/trade/accept', { token: D.token, body: { id: cr2.j.trade.id } })
  eq('accept tanpa stok ditolak (409)', ac2.status, 409)
  eq('penawaran tetap menunggu', (await api('/api/auth/trade', { token: D.token })).j.incoming.some(t => t.id === cr2.j.trade.id), true)
  eq('coin C tidak berubah', (await bal(C.token)).coins, cCoins - 200)
  eq('roti C masih 7 (tidak terpotong saat gagal)', (await api('/api/auth/shop', { token: C.token })).j.inv.roti, 7)

  // 5d: pembatalan oleh penawar
  const cx = await api('/api/auth/trade/cancel', { token: C.token, body: { id: cr2.j.trade.id } })
  ok('pembatalan sukses', cx.j.ok, cx.j)
  eq('batal oleh penerima ditolak', (await api('/api/auth/trade/cancel', { token: D.token, body: { id: cr2.j.trade.id } })).status, 409)
  eq('accept setelah batal ditolak', (await api('/api/auth/trade/accept', { token: D.token, body: { id: cr2.j.trade.id } })).status, 409)

  // 5e: kedaluwarsa
  const cr3 = await api('/api/auth/trade/create', { token: C.token, body: { to: D.username, offer: { items: { roti: 1 } }, want: { coins: 50 }, idem: 'trd00003eeee5555' } })
  await db.collection('trades').updateOne({ _id: cr3.j.trade.id }, { $set: { expAt: new Date(Date.now() - 1000) } })
  eq('accept penawaran hangus ditolak', (await api('/api/auth/trade/accept', { token: D.token, body: { id: cr3.j.trade.id } })).status, 409)
  const vC = await api('/api/auth/trade', { token: C.token })
  eq('listing hangus ditandai expire', vC.j.done.some(t => t.id === cr3.j.trade.id && t.status === 'expire'), true)

  // 5f: barang penawar habis saat accept
  const cr4 = await api('/api/auth/trade/create', { token: C.token, body: { to: D.username, offer: { items: { roti: 5 } }, want: { items: { teh: 1 } }, idem: 'trd00004ffff6666' } })
  ok('penawaran keempat dibuat', cr4.j.ok, cr4.j)
  await api('/api/auth/transfer/send', { token: C.token, body: { to: E.username, items: { roti: 7 }, idem: 'trdtrf01aaaa7777' } })
  const ac4 = await api('/api/auth/trade/accept', { token: D.token, body: { id: cr4.j.trade.id } })
  eq('accept saat penawar kehabisan stok ditolak (409)', ac4.status, 409)
  eq('penawar tidak kehilangan apa pun saat gagal', (await api('/api/auth/shop', { token: C.token })).j.inv.roti, 0)
  eq('penerima tidak kehilangan teh', (await api('/api/auth/shop', { token: D.token })).j.inv.teh, 8)

  // 5g: race double-accept
  await rl()
  const cr5 = await api('/api/auth/trade/create', { token: C.token, body: { to: D.username, offer: { coins: 10 }, want: { items: { teh: 1 } }, idem: 'trd00005gggg8888' } })
  ok('penawaran kelima dibuat', cr5.j.ok, cr5.j)
  const [y1, y2] = await Promise.all([
    api('/api/auth/trade/accept', { token: D.token, body: { id: cr5.j.trade.id } }),
    api('/api/auth/trade/accept', { token: D.token, body: { id: cr5.j.trade.id } })
  ])
  const stt = [y1.status, y2.status].sort()
  ok('race accept: satu sukses satu 409', stt[0] === 200 && stt[1] === 409, stt)
  eq('teh D berkurang tepat 1', (await api('/api/auth/shop', { token: D.token })).j.inv.teh, 7)

  // 5h: gerbang pembuatan
  eq('trade ke diri sendiri ditolak', (await api('/api/auth/trade/create', { token: C.token, body: { to: C.username, offer: { coins: 10 }, want: { coins: 10 }, idem: 'trd00006hhhh1010' } })).status, 400)
  eq('coin di atas batas ditolak', (await api('/api/auth/trade/create', { token: C.token, body: { to: D.username, offer: { coins: 60000 }, want: { coins: 0 }, idem: 'trd00007iiii1111' } })).status, 400)
  eq('barang palsu ditolak', (await api('/api/auth/trade/create', { token: C.token, body: { to: D.username, offer: { items: { palsu: 1 } }, want: { coins: 10 }, idem: 'trd00008jjjj2222' } })).status, 400)
  eq('akun baru tak boleh menawarkan (403)', (await api('/api/auth/trade/create', { token: (await newAcc('mike')).token, body: { to: D.username, offer: { coins: 10 }, want: { coins: 5 }, idem: 'trd00009kkkk3333' } })).status, 403)
}

// ==== [6] Marketplace ====
console.log('\n[6] Marketplace (lib/market.js)')
await rl()
{
  // 6a: listing dengan escrow
  await api('/api/auth/shop/buy', { token: D.token, body: { items: { apel: 12 }, idem: 'mktbuy01aaaa1111' } })
  const inv0 = (await api('/api/auth/shop', { token: D.token })).j.inv.apel
  const lr = await api('/api/auth/market/list', { token: D.token, body: { item: 'apel', qty: 10, price: 700, idem: 'mkt00002bbbb2222' } })
  ok('listing dibuat', lr.j.ok, lr.j)
  eq('escrow: apel D langsung berkurang', (await api('/api/auth/shop', { token: D.token })).j.inv.apel, inv0 - 10)
  const v = await api('/api/auth/market', { token: A.token })
  ok('listing tampil di browse', (v.j.listings || []).some(l => l.id === lr.j.listing.id), v.j.listings && v.j.listings.map(l => l.item))
  eq('fee listing terlihat (35)', lr.j.listing.fee, 35)
  eq('proceeds penjual terlihat (665)', lr.j.listing.proceeds, 665)

  // 6b: beli
  const bA = (await bal(A.token)).coins, bD = (await bal(D.token)).coins
  const buy = await api('/api/auth/market/buy', { token: A.token, body: { id: lr.j.listing.id, idem: 'mkt00003cccc3333' } })
  ok('pembelian sukses', buy.j.ok, buy.j)
  eq('pembeli bayar 700', (await bal(A.token)).coins, bA - 700)
  eq('penjual terima 665 (fee 35 dibuang)', (await bal(D.token)).coins, bD + 665)
  eq('pembeli menerima 10 apel', (await api('/api/auth/shop', { token: A.token })).j.inv.apel, 10)
  eq('listing jadi sold', (await api('/api/auth/market', { token: A.token })).j.mine.length >= 0 && (await api('/api/auth/market', { token: D.token })).j.mine.some(l => l.id === lr.j.listing.id && l.status === 'sold'), true)
  ok('notifikasi penjual: market', (await api('/api/auth/notify', { token: D.token })).j.items.some(x => x.type === 'market'))

  // 6c: harga historis muncul untuk item
  const vp = await api('/api/auth/market', { token: A.token, body: { item: 'apel' } })
  ok('riwayat harga apel tercatat', (vp.j.prices || []).some(p => p.price === 700 && p.qty === 10), vp.j.prices)
  eq('browse terfilter benar', vp.j.item, 'apel')

  // 6d: pembeli bokek -> listing tetap listed, penjual tidak dikredit
  await grant(E.token, 1000, 0) // E butuh modal beli pisang untuk listing uji ini
  await api('/api/auth/shop/buy', { token: E.token, body: { items: { pisang: 5 }, idem: 'mktbuy02eeee5555' } })
  const lr2 = await api('/api/auth/market/list', { token: E.token, body: { item: 'pisang', qty: 5, price: 5000, idem: 'mkt00005ffff6666' } })
  ok('listing pisang dibuat', lr2.j.ok, lr2.j)
  const F = await newAcc('oscar') // pembeli segar, dompet 150 coin (tanpa gerbang umur: beli boleh)
  const bE0 = (await bal(E.token)).coins
  const poor = await api('/api/auth/market/buy', { token: F.token, body: { id: lr2.j.listing.id, idem: 'mkt00006gggg7777' } })
  eq('pembelian dengan coin kurang ditolak (409)', poor.status, 409)
  eq('penjual tidak dikredit saat gagal', (await bal(E.token)).coins, bE0)
  eq('listing gagal-beli masih bisa dibatalkan', (await api('/api/auth/market/cancel', { token: E.token, body: { id: lr2.j.listing.id } })).j.ok, true)
  eq('escrow pisang kembali ke E', (await api('/api/auth/shop', { token: E.token })).j.inv.pisang, 5)

  // 6e: race dobel-beli: satu pembeli menang, fee terbakar tepat sekali
  await rl()
  await api('/api/auth/market/list', { token: D.token, body: { item: 'apel', qty: 2, price: 120, idem: 'mkt00007hhhh8888' } }) // listing kedua dari sisa apel D
  const vD = await api('/api/auth/market', { token: D.token })
  const l7 = (vD.j.mine || []).find(l => l.status === 'listed' && l.item === 'apel' && l.qty === 2)
  ok('listing kedua ada (sisa apel D)', !!l7, vD.j.mine)
  if (l7) {
    const bA2 = (await bal(A.token)).coins, bC = (await bal(C.token)).coins, bD2 = (await bal(D.token)).coins
    const [z1, z2] = await Promise.all([
      api('/api/auth/market/buy', { token: A.token, body: { id: l7.id, idem: 'mkt00008iiii9999' } }),
      api('/api/auth/market/buy', { token: C.token, body: { id: l7.id, idem: 'mkt00009jjjj1010' } })
    ])
    const stz = [z1.status, z2.status].sort()
    ok('race beli: satu sukses satu 409', stz[0] === 200 && stz[1] === 409, stz)
    // konservasi: pembeli -120, penjual +114 (fee 6 dibuang) -> total berkurang tepat 6
    eq('konservasi ekonomi (fee terbakar tepat 6)', (await bal(A.token)).coins + (await bal(C.token)).coins + (await bal(D.token)).coins, bA2 + bC + bD2 - 6)
  }

  // 6f: listing kedaluwarsa -> escrow kembali saat dilihat penjual
  const lr3 = await api('/api/auth/market/list', { token: D.token, body: { item: 'teh', qty: 1, price: 60, idem: 'mkt00010kkkk1111' } })
  await db.collection('market').updateOne({ _id: lr3.j.listing.id }, { $set: { expAt: new Date(Date.now() - 1000) } })
  const invBefore = (await api('/api/auth/shop', { token: D.token })).j.inv.teh
  const vD2 = await api('/api/auth/market', { token: D.token })
  eq('listing hangus dijadikan expire', (vD2.j.mine || []).some(l => l.id === lr3.j.listing.id && l.status === 'expire'), true)
  eq('escrow kembali ke penjual', (await api('/api/auth/shop', { token: D.token })).j.inv.teh, invBefore + 1)

  // 6g: gerbang
  eq('harga di bawah minimum (20) ditolak', (await api('/api/auth/market/list', { token: D.token, body: { item: 'teh', qty: 1, price: 10, idem: 'mkt00011llll2222' } })).status, 400)
  eq('stok kurang ditolak saat listing', (await api('/api/auth/market/list', { token: D.token, body: { item: 'teh', qty: 99, price: 1000, idem: 'mkt00012mmmm3333' } })).status, 409)
  eq('akun baru tak boleh berjualan (403)', (await api('/api/auth/market/list', { token: (await newAcc('papa')).token, body: { item: 'teh', qty: 1, price: 100, idem: 'mkt00013nnnn4444' } })).status, 403)
  eq('id listing palsu ditolak', (await api('/api/auth/market/buy', { token: A.token, body: { id: 'bukan-uuid', idem: 'mkt00014oooo5555' } })).status, 400)
}

// ==== [7] Jobs ====
console.log('\n[7] Pekerjaan (lib/jobs.js)')
await rl()
{
  const v = await api('/api/auth/jobs', { token: B.token })
  ok('daftar pekerjaan terkirim (4)', (v.j.jobs || []).length === 4, v.j)
  ok('semua siap dikerjakan (cd 0)', v.j.jobs.every(j => j.cdLeft === 0))
  const bCoins = (await bal(B.token)).coins
  const w = await api('/api/auth/jobs/work', { token: B.token, body: { id: 'barista' } })
  ok('kerja barista sukses', w.j.ok, w.j)
  near('gaji barista 30-50 (atau 2x bonus)', w.j.pay, 30, 100)
  eq('coin masuk pas', (await bal(B.token)).coins, bCoins + w.j.pay)
  eq('kerja ulang langsung kena jeda (429)', (await api('/api/auth/jobs/work', { token: B.token, body: { id: 'barista' } })).status, 429)
  eq('kerja pekerjaan lain masih bisa', (await api('/api/auth/jobs/work', { token: B.token, body: { id: 'kurir' } })).j.ok, true)
  eq('id pekerjaan palsu ditolak (400)', (await api('/api/auth/jobs/work', { token: B.token, body: { id: 'presiden' } })).status, 400)
  // kuota harian
  const day = (await import('../lib/bonus.js')).dayNum(Date.now())
  await usersC.updateOne({ username: B.username }, { $set: { 'job.day': day, 'job.n': 8 } })
  eq('kuota 8 shift habis (429)', (await api('/api/auth/jobs/work', { token: B.token, body: { id: 'satpam' } })).status, 429)
  ok('riwayat kerja tercatat di econ_log', (await api('/api/auth/jobs', { token: B.token })).j.hist.some(h => h.coins > 0))
}

// ==== [8] Hapus akun membersihkan data baru ====
console.log('\n[8] Purge akun')
await rl()
{
  const Z = await newAcc('zulu'); await setOld(Z.username); await grant(Z.token, 5000, 0)
  await api('/api/auth/shop/buy', { token: Z.token, body: { items: { roti: 1 }, idem: 'prgbuy01aaaa1111' } })
  await api('/api/auth/market/list', { token: Z.token, body: { item: 'roti', qty: 1, price: 50, idem: 'prg00001bbbb2222' } }) // listing Z
  await api('/api/auth/trade/create', { token: Z.token, body: { to: D.username, offer: { coins: 100 }, want: { coins: 50 }, idem: 'prg00002cccc3333' } }) // trade Z
  await api('/api/auth/transfer/send', { token: Z.token, body: { to: B.username, coins: 200, idem: 'prg00003dddd4444' } }) // notifikasi Z
  const del = await api('/api/auth/delete', { token: Z.token, body: { password: 'rahasia123' } })
  eq('hapus akun sukses', del.j.ok, true)
  const uid = Z.uid
  await wait(300)
  eq('notifikasi Z terhapus', await db.collection('notif').countDocuments({ uid }), 0)
  eq('listing market Z terhapus', await db.collection('market').countDocuments({ seller: uid }), 0)
  eq('penawaran trade Z terhapus', await db.collection('trades').countDocuments({ from: uid }), 0)
  eq('akun Z benar-benar hilang', await usersC.countDocuments({ _id: uid }), 0)
}

// ==== [9] Regresi cepat: fitur ekonomi lama tidak rusak ====
console.log('\n[9] Regresi cepat (fitur lama)')
await rl()
{
  const v = await api('/api/auth/economy', { token: A.token })
  ok('economy view lama tetap jalan', v.j.ok, v.j)
  const r = await api('/api/auth/economy/exchange', { token: A.token, body: { kind: 'c2g', amount: 400, idem: 'reg00001aaaa1111' } })
  ok('exchange lama tetap jalan', r.j.ok, r.j)
  const s = await api('/api/auth/shop', { token: A.token })
  ok('shop lama tetap jalan', s.j.ok, s.j)
  const b = await api('/api/auth/bonus', { token: A.token })
  ok('bonus lama tetap jalan', b.j.ok, b.j)
  const q = await api('/api/auth/quests', { token: A.token })
  ok('quests lama tetap jalan', q.j.ok, q.j)
}

console.log('\n' + '='.repeat(52))
console.log(`HASIL: ${pass} lulus, ${fail} gagal`)
server.close(); await mc.close(); await ms.stop()
process.exit(fail ? 1 : 0)
