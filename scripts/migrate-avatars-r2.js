// Pindahkan foto profil lama (base64 di koleksi `avatars` MongoDB) ke Cloudflare R2. Aman diulang: akun yang sudah punya avatarUrl dilewati.
// Jalankan: npm run r2:migrate            (pindahkan, lalu hapus salinan di MongoDB setelah berhasil)
//           npm run r2:migrate -- --dry   (hanya hitung, tidak mengubah apa pun)
import crypto from 'node:crypto'
import { mongoEnabled, col, getClient } from '../lib/mongo.js'
import { r2Enabled, r2Put, r2Delete, r2PublicUrl } from '../lib/r2.js'

if (!mongoEnabled()) { console.error('MONGODB_URI belum diisi di .env'); process.exit(1) }
if (!r2Enabled()) { console.error('Env R2_* belum lengkap (jalankan npm run r2:test untuk melihat yang kurang)'); process.exit(1) }
const dry = process.argv.includes('--dry')
const users = await col('users'), avatars = await col('avatars')
let ok = 0, skip = 0, fail = 0
for await (const u of users.find({ av: { $exists: true }, avatarUrl: { $exists: false } }, { projection: { username: 1 } })) {
  const d = await avatars.findOne({ _id: u._id })
  if (!d?.data) { skip++; continue }
  if (dry) { ok++; continue }
  const key = `pfp/${crypto.randomBytes(12).toString('hex')}.jpg`
  try {
    await r2Put(key, Buffer.from(d.data, 'base64'), 'image/jpeg')
    await users.updateOne({ _id: u._id }, { $set: { avatarUrl: r2PublicUrl(key), avKey: key } })
    await avatars.deleteOne({ _id: u._id })
    ok++; console.log('pindah :', u.username)
  } catch (e) { fail++; console.error('gagal  :', u.username, e.message); await r2Delete(key).catch(() => {}) }
}
console.log(dry ? `(dry) akan dipindah: ${ok}, dilewati: ${skip}` : `selesai. dipindah: ${ok}, dilewati: ${skip}, gagal: ${fail}`)
await (await getClient()).close()
