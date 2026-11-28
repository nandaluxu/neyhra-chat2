// Uji end-to-end sistem Level Akun (lib/leveling.js + lib/xpext.js + semua hook-nya).
// Jalan tanpa MongoDB/Redis terpasang: memakai mongodb-memory-server (unduh binari sekali ke .mdbin/).
//   node scripts/level-e2e.mjs
// Urutan: fungsi murni -> register -> /api/auth/level -> API eksternal (key salah/benar, amount, setLevel,
// negatif) -> multiplier hadiah Tebak Angka (menang lewat /api/auth/game) -> cap harian gc -> gerbang time +
// heartbeat /api/online -> piala alv* -> board Level Akun -> notifikasi -> purge lewat /api/auth/delete.
import assert from 'node:assert'

process.env.LEVEL_EXT_KEY = 'test-ext-key-123'
process.env.MONGODB_DB = 'neyhra-level-test'
process.env.MONGOMS_DOWNLOAD_DIR ??= new URL('../.mdbin/', import.meta.url).pathname // cache binari di luar git

const { MongoMemoryServer } = await import('mongodb-memory-server')
const mongod = await MongoMemoryServer.create()
process.env.MONGODB_URI = mongod.getUri()

// app.js / mongo.js membaca env saat modul dimuat -> impor dinamis SETELAH env siap
const { default: app } = await import('../lib/app.js')
const { levelOf, xpTotalFor, mulFor, award, XP, XP_CAP } = await import('../lib/leveling.js')
const { col } = await import('../lib/mongo.js')
const { MongoClient } = await import('mongodb')
const dbc = new MongoClient(process.env.MONGODB_URI)
await dbc.connect()
const db = dbc.db('neyhra-level-test')

const server = app.listen(0, '127.0.0.1')
await new Promise(r => server.once('listening', r))
const BASE = `http://127.0.0.1:${server.address().port}`
const B = h => ({ 'content-type': 'application/json', ...(h || {}) })
const post = async (path, body, headers) => {
  const r = await fetch(BASE + path, { method: 'POST', headers: B(headers), body: JSON.stringify(body ?? {}) })
  return { status: r.status, j: await r.json().catch(() => null) }
}
let n = 0, fail = 0
const t = (name, fn) => Promise.resolve().then(fn).then(() => console.log(`  ok ${++n} ${name}`)).catch(e => { fail++; console.error(`  GAGAL ${++n} ${name}:`, e.message) })

console.log('== fungsi murni ==')
await t('kurva XP (base 80, step 40)', () => {
  assert.equal(xpTotalFor(1), 0); assert.equal(xpTotalFor(2), 80); assert.equal(xpTotalFor(3), 200)
  assert.equal(xpTotalFor(4), 360); assert.equal(xpTotalFor(5), 560); assert.equal(xpTotalFor(10), 2160)
  assert.equal(xpTotalFor(100), 201960)
})
await t('levelOf: 0->1, 79->1, 80->2, mentok di 100', () => {
  assert.equal(levelOf(0), 1); assert.equal(levelOf(79), 1); assert.equal(levelOf(80), 2)
  assert.equal(levelOf(201960), 100); assert.equal(levelOf(999999), 100)
})
await t('mulFor: 1.0 di level 1, 1.48 di 25, mentok 2.5', () => {
  assert.equal(mulFor(1), 1); assert.equal(mulFor(25), 1.48); assert.equal(mulFor(50), 1.98)
  assert.equal(mulFor(76), 2.5); assert.equal(mulFor(120), 2.5)
})

console.log('== daftar akun & tampilan level ==')
let tok = '', uid = ''
await t('register -> token + saldo awal', async () => {
  const r = await post('/api/auth/register', { username: 'leveltest', password: 'rahasia123' })
  assert.equal(r.status, 200); assert.ok(r.j.token); tok = r.j.token; uid = r.j.uid
  assert.equal(r.j.coins, 150)
})
await t('/api/auth/level: level 1, xp 0, mul 1, tanpa riwayat', async () => {
  const r = await post('/api/auth/level', {}, { authorization: `Bearer ${tok}` })
  assert.equal(r.status, 200)
  assert.equal(r.j.level, 1); assert.equal(r.j.xp, 0); assert.equal(r.j.mul.now, 1)
  assert.equal(r.j.maxed, false); assert.equal(r.j.need, 80); assert.deepEqual(r.j.hist, [])
  assert.equal(r.j.daily.gc.cap, XP_CAP.gc); assert.equal(r.j.daily.time.cap, XP_CAP.time)
  assert.equal(r.j.daily.win.cap, XP_CAP.win); assert.ok(r.j.daily.resetMs > 0)
  assert.equal(r.j.top.length, 0)
})

console.log('== API eksternal /api/xp ==')
await t('tanpa env key endpoint tidak terbuka (di sini key sudah diset)', async () => {
  const r = await post('/api/xp/grant', { username: 'leveltest', amount: 10 })
  assert.equal(r.status, 403) // key belum dikirim
})
await t('key salah -> 403', async () => {
  const r = await post('/api/xp/grant', { username: 'leveltest', amount: 10 }, { 'x-api-key': 'salah' })
  assert.equal(r.status, 403)
})
await t('target tidak ketemu -> 404', async () => {
  const r = await post('/api/xp/grant', { username: 'nobody', amount: 10 }, { 'x-api-key': process.env.LEVEL_EXT_KEY })
  assert.equal(r.status, 404)
})
await t('amount tidak valid -> 400', async () => {
  const r = await post('/api/xp/grant', { username: 'leveltest', amount: 'abc' }, { 'x-api-key': process.env.LEVEL_EXT_KEY })
  assert.equal(r.status, 400)
})
await t('grant +500 XP: naik ke level 4, hadiah level-up masuk saldo', async () => {
  const r = await post('/api/xp/grant', { username: 'leveltest', amount: 500, reason: 'e2e test' }, { 'x-api-key': process.env.LEVEL_EXT_KEY })
  assert.equal(r.status, 200)
  assert.deepEqual(r.j.before, { level: 1, xp: 0 })
  assert.deepEqual(r.j.after, { level: 4, xp: 500 })
  assert.equal(r.j.gained, 500); assert.equal(r.j.mul, 1.06)
  assert.deepEqual(r.j.levelUp, { from: 1, to: 4, reward: { c: 135, g: 0 } })
  const u = await db.collection('users').findOne({ _id: uid })
  assert.equal(u.coins, 150 + 135)
})
await t('lookup: level/xp/stats terbaca', async () => {
  const r = await post('/api/xp/lookup', { uid }, { 'x-api-key': process.env.LEVEL_EXT_KEY })
  assert.equal(r.status, 200)
  assert.equal(r.j.level, 4); assert.equal(r.j.xp, 500); assert.equal(r.j.mul, 1.06)
  assert.equal(r.j.stats.ext, 500); assert.equal(r.j.username, 'leveltest')
})
await t('grant negatif: xp tidak minus, level ikut turun tanpa hadiah', async () => {
  const r = await post('/api/xp/grant', { username: 'leveltest', amount: -600 }, { 'x-api-key': process.env.LEVEL_EXT_KEY })
  assert.equal(r.status, 200)
  assert.equal(r.j.after.level, 1); assert.equal(r.j.after.xp, 0) // max(0, 500-600)
  assert.equal(r.j.levelUp, null)
  const u = await db.collection('users').findOne({ _id: uid })
  assert.equal(u.coins, 150 + 135) // tidak berubah
})
await t('setLevel 10: lompat ke level 10 + hadiah semua level terlewati', async () => {
  const r = await post('/api/xp/grant', { username: 'leveltest', setLevel: 10 }, { 'x-api-key': process.env.LEVEL_EXT_KEY })
  assert.equal(r.status, 200)
  assert.equal(r.j.setLevel, 10); assert.equal(r.j.after.level, 10); assert.equal(r.j.after.xp, 2160)
  assert.deepEqual(r.j.levelUp, { from: 1, to: 10, reward: { c: 540, g: 10 } })
  const u = await db.collection('users').findOne({ _id: uid })
  assert.equal(u.coins, 150 + 135 + 540 + 100) // + piala alv10 "Pemain Setia" (+100 coin) yang ikut terbuka
  assert.equal(u.gems, 10 + 10)
})
await t('setLevel ke level yang sama: tanpa perubahan', async () => {
  const r = await post('/api/xp/grant', { username: 'leveltest', setLevel: 10 }, { 'x-api-key': process.env.LEVEL_EXT_KEY })
  assert.equal(r.status, 200); assert.equal(r.j.gained, 0); assert.deepEqual(r.j.after, { level: 10, xp: 2160 })
})
await t('/api/auth/me memuat level', async () => {
  const r = await post('/api/auth/me', {}, { authorization: `Bearer ${tok}` })
  assert.equal(r.j.level, 10)
})
await t('xp_log terisi (src ext + note)', async () => {
  const rows = await db.collection('xp_log').find({ uid }).sort({ at: -1 }).limit(3).toArray()
  assert.ok(rows.length >= 3)
  assert.ok(rows.every(x => ['ext'].includes(x.src)))
  assert.equal(rows.find(x => x.note)?.note, 'e2e test')
})

console.log('== piala level akun (alv*) ==')
await t('/api/auth/quests: alv10 sudah terbuka, alv25/alv50 belum', async () => {
  const r = await post('/api/auth/quests', {}, { authorization: `Bearer ${tok}` })
  assert.equal(r.status, 200)
  const a = id => r.j.ach.find(x => x.id === id)
  assert.equal(a('alv10').got, true); assert.equal(a('alv10').v, 10)
  assert.equal(a('alv25').got, false); assert.equal(a('alv50').got, false)
})
await t('notifikasi level-up masuk Pusat Notifikasi', async () => {
  const r = await post('/api/auth/notify', {}, { authorization: `Bearer ${tok}` })
  const items = r.j.items.filter(x => x.type === 'level')
  assert.ok(items.length >= 2) // "Naik ke Level 10!" + pengaturan ulang
  assert.ok(items.some(x => /Naik ke Level 10/.test(x.txt)))
})

console.log('== menang minigame: XP + pengali hadiah ==')
await t('tebak angka: hadiah dikali pengali level (200 x 1.18 = 236)', async () => {
  const st = await post('/api/auth/game/start', {}, { authorization: `Bearer ${tok}` })
  assert.equal(st.status, 200)
  assert.equal(st.j.mul, 1.18) // level 10 -> 1 + 0.02*9
  const s = await db.collection('game_state').findOne({ _id: `${uid}:guess` })
  const r = await post('/api/auth/game/guess', { n: s.secret }, { authorization: `Bearer ${tok}` })
  assert.equal(r.status, 200); assert.equal(r.j.result, 'win')
  assert.equal(r.j.reward, Math.floor(200 * 1.18)) // rewards[0] = 200
  const lvl = await post('/api/auth/level', {}, { authorization: `Bearer ${tok}` })
  assert.equal(lvl.j.daily.win.xp, XP.win) // 15 XP untuk 1 kemenangan
  assert.equal(lvl.j.sources.win.xp, XP.win)
  assert.ok(lvl.j.hist.some(h => h.src === 'win' && h.amt === XP.win))
})

console.log('== cap harian & gerbang waktu ==')
await t('cap gc: 30 pesan dapat XP, ke-31 mentok', async () => {
  const u = await db.collection('users').findOne({ _id: uid })
  let gained = 0, capped = 0
  for (let i = 0; i < 32; i++) {
    const lr = await award(col, u, 'gc', XP.gc)
    if (lr.gained) gained += lr.gained; else if (lr.capped) capped++
  }
  assert.equal(gained, XP_CAP.gc) // tepat 150
  assert.ok(capped >= 1)
  const lvl = await post('/api/auth/level', {}, { authorization: `Bearer ${tok}` })
  assert.equal(lvl.j.daily.gc.xp, XP_CAP.gc)
})
await t('gerbang time: pertama dapat, langsung kedua tidak, 4 menit kemudian dapat lagi', async () => {
  const u = await db.collection('users').findOne({ _id: uid })
  const a1 = await award(col, u, 'time', XP.time)
  assert.equal(a1.gained, 1)
  const a2 = await award(col, u, 'time', XP.time)
  assert.equal(a2.gained, 0) // terlalu rapat
  await db.collection('level').updateOne({ _id: uid }, { $set: { lastBeat: Date.now() - 5 * 60 * 1000 } })
  const a3 = await award(col, u, 'time', XP.time)
  assert.equal(a3.gained, 1)
  await db.collection('level').updateOne({ _id: uid }, { $set: { lastBeat: Date.now() - 5 * 60 * 1000, 'cap.time': XP_CAP.time } })
  const a4 = await award(col, u, 'time', XP.time)
  assert.equal(a4.gained, 0) // mentok cap harian waktu-main
})
await t('heartbeat /api/online memakai akun: lv hanya muncul saat XP bertambah', async () => {
  await db.collection('level').updateOne({ _id: uid }, { $set: { lastBeat: Date.now() - 5 * 60 * 1000, 'cap.time': 0 } }) // gerbang + cap longgar
  const h1 = await post('/api/online', { clientId: 'e2e-client-0001' }, { authorization: `Bearer ${tok}` })
  assert.equal(h1.status, 200); assert.ok(h1.j.lv, 'heartbeat pertama harus membawa lv')
  assert.ok(h1.j.lv.level >= 10)
  const h2 = await post('/api/online', { clientId: 'e2e-client-0001' }, { authorization: `Bearer ${tok}` })
  assert.equal(h2.j.lv, undefined, 'heartbeat berikutnya (gerbang 4 menit) tidak membawa lv')
  const h3 = await post('/api/online', { clientId: 'e2e-client-0002' }) // tamu: tetap online, tanpa XP
  assert.equal(h3.status, 200); assert.equal(h3.j.lv, undefined)
})
await t('hari berganti -> cap harian reset', async () => {
  await db.collection('level').updateOne({ _id: uid }, { $set: { capDay: 0 } }) // paksa "hari lalu"
  const u = await db.collection('users').findOne({ _id: uid })
  const lr = await award(col, u, 'gc', XP.gc)
  assert.equal(lr.gained, XP.gc) // cap direset oleh award()
  const lvl = await post('/api/auth/level', {}, { authorization: `Bearer ${tok}` })
  assert.equal(lvl.j.daily.gc.xp, XP.gc)
})

console.log('== peringkat & pembersihan ==')
await t('board "Level Akun" muncul di /api/auth/lb (Lainnya)', async () => {
  const r = await post('/api/auth/lb', { cat: 'other', sub: 'level' }, { authorization: `Bearer ${tok}` })
  assert.equal(r.status, 200)
  assert.equal(r.j.sub, 'level'); assert.equal(r.j.unit, 'level')
  assert.ok(r.j.rows.length >= 1); assert.ok(r.j.rows.some(x => x.v >= 10))
  assert.ok(r.j.rows.some(x => x.me))
  const cfgSub = r.j.cfg.find(c => c.id === 'other').subs.find(s => s.id === 'level')
  assert.ok(cfgSub, 'cfg harus mengumumkan sub level supaya UI lama otomatis menampilkannya')
})
await t('hapus akun -> dokumen level & xp_log ikut terhapus', async () => {
  const reg = await post('/api/auth/register', { username: 'leveltest2', password: 'rahasia123' })
  const tok2 = reg.j.token, uid2 = reg.j.uid
  await post('/api/xp/grant', { uid: uid2, amount: 300 }, { 'x-api-key': process.env.LEVEL_EXT_KEY })
  assert.ok(await db.collection('level').findOne({ _id: uid2 }))
  const del = await post('/api/auth/delete', { password: 'rahasia123' }, { authorization: `Bearer ${tok2}` })
  assert.equal(del.status, 200)
  assert.equal(await db.collection('level').findOne({ _id: uid2 }), null)
  assert.equal(await db.collection('xp_log').findOne({ uid: uid2 }), null)
})

console.log(`\n${fail ? `${fail} GAGAL` : 'SEMUA LULUS'} dari ${n} asersi`)
await server.close(); await dbc.close(); await mongod.stop()
process.exit(fail ? 1 : 0)
