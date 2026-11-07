// Uji MongoDB: tulis -> baca -> ubah -> hapus, lalu ulang 200x untuk membuktikan write/delete terus-menerus aman.
// Jalankan: npm run db:test   (butuh MONGODB_URI di .env)
import { mongoEnabled, col, pingMongo, getClient } from '../lib/mongo.js'

if (!mongoEnabled()) { console.error('MONGODB_URI belum diisi di .env'); process.exit(1) }
console.log('ping:', await pingMongo(), 'ms')

const c = await col('_selftest')
const tag = 'test-' + Date.now()
const { insertedId } = await c.insertOne({ tag, n: 1, createdAt: new Date() })
console.log('insert  :', insertedId.toString())
await c.updateOne({ _id: insertedId }, { $inc: { n: 1 } })
console.log('update  :', (await c.findOne({ _id: insertedId })).n === 2 ? 'ok' : 'GAGAL')
console.log('delete  :', (await c.deleteOne({ _id: insertedId })).deletedCount === 1 ? 'ok' : 'GAGAL')

const t = Date.now()
for (let i = 0; i < 200; i++) { const r = await c.insertOne({ tag, i }); await c.deleteOne({ _id: r.insertedId }) }
console.log('200x tulis+hapus:', Date.now() - t, 'ms, sisa dokumen:', await c.countDocuments({ tag }))
await (await getClient()).close()
