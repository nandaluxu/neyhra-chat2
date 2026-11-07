import { MongoClient } from 'mongodb'

// Koneksi MongoDB untuk fitur-fitur BARU (login sederhana, persona buatan user, dst).
// Redis (online.js, gcstore.js) tidak disentuh sama sekali, tetap jalan seperti sebelumnya.
//
// Env (cukup salah satu):
//   MONGODB_URI  -> mongodb+srv://user:pass@cluster.mongodb.net/neyhra  (atau mongodb://...)
//   MONGODB_DB   -> nama database (opsional; default: nama di URI, kalau tidak ada -> "neyhra")
// Nama env dicari yang mirip (sama seperti redisConfig), karena integrasi Vercel/Atlas bisa memberi prefix sendiri.
//
// Tanpa URI -> mongoEnabled() false, getDb() melempar error, fitur yang butuh Mongo harus menjawab "tidak aktif".

export function mongoUri(env = process.env) {
  const keys = Object.keys(env).filter(k => env[k])
  const k = ['MONGODB_URI', 'MONGO_URL', 'MONGODB_URL'].find(n => env[n]) || keys.find(n => /^mongodb(\+srv)?:\/\/\S+$/i.test(env[n].trim()))
  return k ? env[k].trim() : ''
}

const URI = mongoUri()
export const mongoEnabled = () => !!URI

// Serverless (Vercel): instance bisa dipakai ulang antar request, jadi klien disimpan di globalThis
// supaya tidak bikin koneksi baru tiap request (Atlas gratis cuma kuat ±500 koneksi).
const G = globalThis.__neyhraMongo ??= { client: null, promise: null }

export async function getClient() {
  if (!URI) throw new Error('MongoDB belum dikonfigurasi (isi env MONGODB_URI)')
  if (G.client) return G.client
  G.promise ??= new MongoClient(URI, {
    maxPoolSize: 5,                   // serverless: kecil saja
    serverSelectionTimeoutMS: 5000,   // gagal cepat, jangan menggantung sampai maxDuration
    connectTimeoutMS: 5000,
    appName: 'neyhra-chat'
  }).connect().then(c => (G.client = c)).catch(e => { G.promise = null; throw e }) // gagal -> boleh dicoba lagi di request berikutnya
  return G.promise
}

export async function getDb() {
  const c = await getClient()
  return c.db(process.env.MONGODB_DB || undefined) // undefined -> pakai nama db dari URI (default "test" kalau URI tak menyebut)
}

// Pintasan: const users = await col('users'); await users.insertOne({...})
export async function col(name) {
  return (await getDb()).collection(name)
}

// Cek koneksi: dipakai /api/db/health. Tidak menulis apa pun.
export async function pingMongo() {
  const t = Date.now()
  await (await getDb()).command({ ping: 1 })
  return Date.now() - t
}

// Daftarkan index sekali per instance. Contoh pemakaian nanti:
//   await ensureIndexes('users', [[{ username: 1 }, { unique: true }]])
//   await ensureIndexes('sessions', [[{ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 30 }]])  // TTL: dihapus otomatis
const done = new Set()
export async function ensureIndexes(name, specs) {
  if (done.has(name)) return
  const c = await col(name)
  for (const [keys, opts] of specs) await c.createIndex(keys, opts)
  done.add(name)
}
