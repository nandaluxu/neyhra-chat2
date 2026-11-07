// Uji Cloudflare R2: unggah objek kecil -> buka lewat alamat publik -> hapus. Memastikan 5 env R2_* benar dan bucket bisa dibaca publik.
// Jalankan: npm run r2:test   (butuh R2_* di .env)
import { r2Config, r2Put, r2Delete, r2PublicUrl } from '../lib/r2.js'

const c = r2Config()
if (!c) {
  const need = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET', 'R2_PUBLIC_URL'].filter(k => !process.env[k])
  console.error('Env belum lengkap, yang kosong:', need.join(', ')); process.exit(1)
}
console.log('endpoint :', c.endpoint, '| bucket:', c.bucket, '| publik:', c.publicUrl)
const key = `_selftest/${Date.now()}.txt`, body = Buffer.from('neyhra r2 ok')
try {
  await r2Put(key, body, 'text/plain', 'no-store'); console.log('unggah   : ok')
} catch (e) {
  console.error('unggah   : GAGAL ->', e.message)
  console.error(/403|SignatureDoesNotMatch|InvalidAccessKeyId/.test(e.message) ? 'Cek Access Key / Secret / Account ID, dan token harus punya izin "Object Read & Write" untuk bucket ini.' : /404|NoSuchBucket/.test(e.message) ? 'Nama bucket salah atau tidak ada di akun ini.' : '')
  process.exit(1)
}
let pub = false
try {
  const r = await fetch(r2PublicUrl(key), { cache: 'no-store' }), t = r.ok ? await r.text() : ''
  pub = r.ok && t === body.toString(); console.log('baca publik:', pub ? 'ok' : `GAGAL (HTTP ${r.status})`)
  if (!pub) console.error('Bucket belum bisa dibaca publik atau R2_PUBLIC_URL salah. Aktifkan Public Development URL / Custom Domain di pengaturan bucket.')
} catch (e) { console.error('baca publik: GAGAL ->', e.message) }
try { await r2Delete(key); console.log('hapus    : ok') } catch (e) { console.error('hapus    : GAGAL ->', e.message) }
process.exit(pub ? 0 : 1)
