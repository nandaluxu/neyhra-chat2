// Uji akun lama (tanpa field tickets/gacha): ensureWallet harus mengisi otomatis.
import fs from 'node:fs'
const devSrc = fs.readFileSync(new URL('../lib/dev.js', import.meta.url), 'utf8')
const hashFn = devSrc.match(/const hash53[\s\S]*?\nconst DEV_HASH/)[0].replace(/\nconst DEV_HASH$/, '')
process.env.GC_DEV_HASH = String(eval('(' + hashFn.replace('const hash53 = ', '') + ')')('uji123'))
const { MongoMemoryServer } = await import('mongodb-memory-server')
const ms = await MongoMemoryServer.create()
process.env.MONGODB_URI = ms.getUri('neyhra')
const { MongoClient } = await import('mongodb')
const { default: app } = await import('../lib/app.js')
const server = app.listen(0)
const base = 'http://127.0.0.1:' + server.address().port
const api = async (path, { token, body } = {}) => (await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body || {}) })).json()

// buat akun "lama": coins & gems ada, tickets & gacha TIDAK ada
const cl = new MongoClient(process.env.MONGODB_URI); await cl.connect()
const uid = 'lama-' + Date.now().toString(36)
await cl.db().collection('users').insertOne({ _id: uid, username: 'akunlama' + Date.now().toString(36), name: 'Lama', coins: 500, gems: 30, inv: { bunga: 2 }, createdAt: new Date() })
await cl.db().collection('auth_sessions').insertOne({ _id: (await import('node:crypto')).createHash('sha256').update('tokolama1234567890abcd').digest('hex'), userId: uid, createdAt: new Date() })
await cl.close()
const T = 'tokolama1234567890abcd'

const v = await api('/api/auth/economy', { token: T })
console.log('tiket terisi otomatis:', v.tickets === 3 ? '✓ (3)' : '✗ ' + v.tickets)
console.log('pity default:', v.pity && v.pity.now === 0 ? '✓' : '✗', JSON.stringify(v.pity))
console.log('inventory lama tetap (bunga=2):', v.inv && v.inv.bunga === 2 ? '✓' : '✗')
const g = await api('/api/auth/economy/gacha', { token: T, body: { pulls: 1, idem: 'lama0001aaaa1111' } })
console.log('gacha jalan di akun lama:', g.ok && Array.isArray(g.results) && g.results.length === 1 ? '✓' : '✗ ' + JSON.stringify(g).slice(0, 120))
const x = await api('/api/auth/economy/exchange', { token: T, body: { kind: 'c2t', amount: 1, idem: 'lama0002bbbb2222' } })
console.log('tukar jalan di akun lama:', x.ok && x.tickets === (g.tickets) + 1 ? '✓' : '✗ ' + JSON.stringify({ ok: x.ok, tickets: x.tickets, err: x.error }))
const s = await api('/api/auth/shop', { token: T })
console.log('bunga selamat setelah gacha (via shop view):', s.inv && s.inv.bunga === 2 ? '✓' : '✗ ' + JSON.stringify(s.inv))
server.close(); await ms.stop(); process.exit(0)