import crypto from 'node:crypto'

// Penyimpanan objek Cloudflare R2 (kompatibel S3), dipakai untuk foto profil (lib/profile.js).
// Tanpa library tambahan: permintaan ditandatangani sendiri dengan AWS Signature V4 dan dikirim lewat fetch bawaan Node.
//
// Env (semua wajib supaya R2 aktif; kalau ada yang kosong, foto profil memakai MongoDB seperti sebelumnya):
//   R2_ACCOUNT_ID         ID akun Cloudflare (dipakai membentuk alamat https://<id>.r2.cloudflarestorage.com)
//   R2_ACCESS_KEY_ID      Access Key ID dari R2 API Token
//   R2_SECRET_ACCESS_KEY  Secret Access Key dari R2 API Token
//   R2_BUCKET             nama bucket
//   R2_PUBLIC_URL         alamat publik bucket (r2.dev atau domain sendiri), tanpa garis miring di akhir
//   R2_ENDPOINT           (opsional) ganti alamat API, mis. bucket jurisdiksi EU: https://<id>.eu.r2.cloudflarestorage.com

const sha = d => crypto.createHash('sha256').update(d).digest('hex')
const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest()
const enc = s => encodeURIComponent(s).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase())

export function r2Config(env = process.env) {
  const t = v => String(v ?? '').trim().replace(/^["']|["']$/g, '') // spasi/baris baru/tanda kutip yang ikut ke-paste di dashboard Vercel
  const acc = (t(env.R2_ACCOUNT_ID).match(/[a-f0-9]{32}/i) || [t(env.R2_ACCOUNT_ID)])[0] // kalau yang ditempel alamat S3 API lengkap, ambil ID-nya saja
  const accessKey = t(env.R2_ACCESS_KEY_ID), secretKey = t(env.R2_SECRET_ACCESS_KEY), bucket = t(env.R2_BUCKET), ep = t(env.R2_ENDPOINT)
  let pub = t(env.R2_PUBLIC_URL)
  if (!acc || !accessKey || !secretKey || !bucket || !pub) return null
  if (!/^https?:\/\//i.test(pub)) pub = 'https://' + pub
  const endpoint = (ep || `https://${acc}.r2.cloudflarestorage.com`).replace(/\/+$/, '')
  return { accessKey, secretKey, bucket, endpoint, host: new URL(endpoint).host, publicUrl: pub.replace(/\/+$/, '') }
}
export const r2Enabled = () => !!r2Config()
export const r2PublicUrl = key => { const c = r2Config(); return c ? `${c.publicUrl}/${key.split('/').map(enc).join('/')}` : '' }

// AWS Signature V4. `headers` = header tambahan (nama huruf kecil) yang ikut ditandatangani; host, x-amz-date, x-amz-content-sha256 ditambahkan di sini.
export function signV4({ method, host, path, query = '', headers = {}, payloadHash, amzDate, region = 'auto', service = 's3', accessKey, secretKey }) {
  const day = amzDate.slice(0, 8)
  const h = { ...headers, host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate }
  const names = Object.keys(h).sort()
  const canonHeaders = names.map(n => `${n}:${String(h[n]).trim().replace(/\s+/g, ' ')}\n`).join('')
  const signed = names.join(';')
  const uri = path.split('/').map(enc).join('/')
  const canon = [method, uri, query, canonHeaders, signed, payloadHash].join('\n')
  const scope = `${day}/${region}/${service}/aws4_request`
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha(canon)].join('\n')
  const key = hmac(hmac(hmac(hmac('AWS4' + secretKey, day), region), service), 'aws4_request')
  const signature = crypto.createHmac('sha256', key).update(toSign).digest('hex')
  return { signature, headers: { ...h, authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signed}, Signature=${signature}` } }
}

async function send(method, key, body, extra = {}) {
  const c = r2Config(); if (!c) throw new Error('R2 belum dikonfigurasi')
  const path = `/${c.bucket}/${key}`
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '') // 20260101T120000Z
  const { headers } = signV4({ method, host: c.host, path, headers: extra, payloadHash: sha(body ?? ''), amzDate, accessKey: c.accessKey, secretKey: c.secretKey })
  delete headers.host // fetch mengisi sendiri dari URL
  const res = await fetch(c.endpoint + path.split('/').map(enc).join('/'), { method, headers, body, signal: AbortSignal.timeout(15000) })
  if (!res.ok && !(method === 'DELETE' && res.status === 404)) {
    const t = (await res.text().catch(() => '')).slice(0, 300)
    const err = new Error(`R2 ${method} ${res.status}: ${t}`); err.status = res.status; throw err
  }
}

// key tanpa awalan garis miring, mis. "pfp/abc.jpg"
export const r2Put = (key, buf, contentType, cacheControl = 'public, max-age=31536000, immutable') =>
  send('PUT', key, buf, { 'content-type': contentType, 'cache-control': cacheControl })
export const r2Delete = key => send('DELETE', key)
