import axios from 'axios'

// Hitung pengunjung yang lagi buka website.
// Vercel itu serverless: tiap request bisa jatuh di instance berbeda dan memori tidak dibagi, jadi hitungan harus disimpan
// di store bersama. Dipakai Redis (REST) dari Upstash, gratis lewat Vercel Marketplace (Storage -> Upstash Redis).
// Integrasinya mengisi env otomatis: UPSTASH_REDIS_REST_URL/TOKEN atau KV_REST_API_URL/TOKEN (dua-duanya didukung).
//   - Redis diset      -> hitung beneran (dipakai di Vercel).
//   - Tidak diset, lokal -> hitung di memori (cukup untuk dev).
//   - Tidak diset, di Vercel -> null (fitur mati, UI tidak menampilkan apa-apa).
const url = (process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || '').replace(/\/$/, '')
const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || ''

export const WINDOW = 150 * 1000 // dianggap online kalau heartbeat terakhir < 150 dtk lalu (heartbeat tiap 60 dtk)
const KEY = 'neyhra:online'

// Satu EVAL = satu perintah Redis (hemat kuota): catat heartbeat, buang yang kedaluwarsa, kembalikan jumlahnya.
const SCRIPT = `redis.call('ZADD', KEYS[1], ARGV[1], ARGV[2])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[3])
redis.call('EXPIRE', KEYS[1], 600)
return redis.call('ZCARD', KEYS[1])`

const mem = new Map()

export async function ping(id) {
  const now = Date.now(), cutoff = now - WINDOW
  if (url && token) {
    const { data } = await axios.post(url, ['EVAL', SCRIPT, '1', KEY, String(now), id, String(cutoff)],
      { headers: { Authorization: `Bearer ${token}` }, timeout: 4000 })
    if (data?.error) throw new Error(data.error)
    return Number(data.result)
  }
  if (process.env.VERCEL) return null
  mem.set(id, now)
  for (const [k, t] of mem) if (t <= cutoff) mem.delete(k)
  return mem.size
}
