import axios from 'axios'

// Hitung pengunjung yang lagi buka website.
// Vercel itu serverless: tiap request bisa jatuh di instance berbeda dan memori tidak dibagi, jadi hitungan harus disimpan
// di store bersama. Dipakai Redis (REST) dari Upstash, gratis lewat Vercel Marketplace (Storage -> Upstash Redis).
// Integrasinya mengisi env otomatis: UPSTASH_REDIS_REST_URL/TOKEN atau KV_REST_API_URL/TOKEN (dua-duanya didukung).
//   - Redis diset      -> hitung beneran (dipakai di Vercel).
//   - Tidak diset, lokal -> hitung di memori (cukup untuk dev).
//   - Tidak diset, di Vercel -> null (fitur mati, UI tidak menampilkan apa-apa).
// Nama env bisa beda-beda (tergantung integrasi / prefix yang dipilih di Vercel), jadi dicari yang mirip, bukan satu nama kaku:
//   URL   : nilai https://...upstash.io (REST), atau variabel yang berakhiran REST_URL / REST_API_URL
//   TOKEN : variabel berakhiran REST_TOKEN / REST_API_TOKEN / _TOKEN (bukan READ_ONLY)
//   Cadangan: kalau cuma ada URL redis (rediss://default:TOKEN@host:6379), host + password-nya dipakai sebagai REST URL + token (di Upstash sama).
export function redisConfig(env = process.env) {
  const keys = Object.keys(env).filter(k => env[k])
  const pick = re => keys.find(k => re.test(k) && !/READ_ONLY/i.test(k))
  let url = '', token = ''
  const uk = ['UPSTASH_REDIS_REST_URL', 'KV_REST_API_URL'].find(k => env[k]) || pick(/REST(_API)?_URL$/i)
    || keys.find(k => /^https:\/\/[^\s]*upstash\.io\/?$/i.test(env[k].trim()))
  if (uk) url = env[uk].trim()
  const tk = ['UPSTASH_REDIS_REST_TOKEN', 'KV_REST_API_TOKEN'].find(k => env[k]) || pick(/(UPSTASH|REDIS|KV).*TOKEN$/i)
  if (tk) token = env[tk].trim()
  if (!url || !token) {
    const rk = keys.find(k => /^rediss?:\/\//i.test(env[k].trim()) && /@/.test(env[k]))
    if (rk) try { const u = new URL(env[rk].trim()); url ||= `https://${u.hostname}`; token ||= decodeURIComponent(u.password) } catch {}
  }
  return { url: url.replace(/\/$/, ''), token }
}
const { url, token } = redisConfig()

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
