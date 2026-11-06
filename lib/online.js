import axios from 'axios'
import net from 'node:net'
import tls from 'node:tls'

// Hitung pengunjung yang lagi buka website.
// Vercel itu serverless: tiap request bisa jatuh di instance berbeda dan memori tidak dibagi, jadi hitungan harus disimpan
// di Redis (store bersama). Didukung dua jenis:
//   1) Redis biasa (redis:// atau rediss://)  -> mis. Redis Cloud dari Vercel Marketplace. Env: REDIS_URL (atau nama mirip, termasuk yang pakai prefix).
//   2) Upstash REST (https://...upstash.io + token) -> env UPSTASH_REDIS_REST_URL/TOKEN atau KV_REST_API_URL/TOKEN.
// Nama env dicari yang mirip (bukan satu nama kaku), karena integrasi Vercel bisa memberi prefix sendiri.
//   - Redis diset        -> hitung beneran (dipakai di Vercel).
//   - Tidak diset, lokal -> hitung di memori (cukup untuk dev).
//   - Tidak diset, di Vercel -> null (fitur mati, UI tidak menampilkan apa-apa).
export function redisConfig(env = process.env) {
  const keys = Object.keys(env).filter(k => env[k])
  const pick = re => keys.find(k => re.test(k) && !/READ_ONLY/i.test(k))
  // --- Upstash REST
  const uk = ['UPSTASH_REDIS_REST_URL', 'KV_REST_API_URL'].find(k => env[k]) || pick(/REST(_API)?_URL$/i)
    || keys.find(k => /^https:\/\/[^\s]*upstash\.io\/?$/i.test(env[k].trim()))
  const tk = ['UPSTASH_REDIS_REST_TOKEN', 'KV_REST_API_TOKEN'].find(k => env[k]) || pick(/(UPSTASH|REDIS|KV).*TOKEN$/i)
  if (uk && tk) return { rest: { url: env[uk].trim().replace(/\/$/, ''), token: env[tk].trim() } }
  // --- Redis biasa (TCP)
  const rk = keys.find(k => /^rediss?:\/\/\S+$/i.test(env[k].trim()))
  if (rk) {
    const tcp = env[rk].trim()
    try { // URL redis milik Upstash -> bisa lewat REST (host sama, password = token)
      const u = new URL(tcp)
      if (/upstash\.io$/i.test(u.hostname) && u.password) return { rest: { url: `https://${u.hostname}`, token: decodeURIComponent(u.password) } }
    } catch {}
    return { tcp }
  }
  return {}
}
const cfg = redisConfig()

// Klien Redis minimal (tanpa dependency): sambung, AUTH, jalankan satu perintah, tutup. Balasan yang dipakai cuma +OK / :angka / -error.
function redisTcp(urlStr, args, timeout = 4000) {
  const u = new URL(urlStr), secure = u.protocol === 'rediss:'
  const user = decodeURIComponent(u.username), pass = decodeURIComponent(u.password)
  const enc = a => `*${a.length}\r\n` + a.map(x => { const s = String(x); return `$${Buffer.byteLength(s)}\r\n${s}\r\n` }).join('')
  const cmds = []
  if (pass) cmds.push(user ? ['AUTH', user, pass] : ['AUTH', pass])
  cmds.push(args)
  return new Promise((resolve, reject) => {
    let buf = '', done = false
    const sock = (secure ? tls : net).connect({ host: u.hostname, port: Number(u.port) || 6379, ...(secure && { servername: u.hostname }) })
    const finish = (err, val) => { if (done) return; done = true; clearTimeout(t); sock.destroy(); err ? reject(err) : resolve(val) }
    const t = setTimeout(() => finish(new Error('redis timeout')), timeout)
    sock.on('error', finish)
    sock.once(secure ? 'secureConnect' : 'connect', () => sock.write(cmds.map(enc).join('')))
    sock.on('data', d => {
      buf += d.toString('latin1')
      const lines = buf.split('\r\n'); lines.pop() // elemen terakhir = sisa baris yang belum lengkap
      const bad = lines.find(l => l[0] === '-')
      if (bad) return finish(new Error('redis: ' + bad.slice(1, 120)))
      if (lines.length >= cmds.length) finish(null, lines[cmds.length - 1])
    })
  })
}

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
  const args = ['EVAL', SCRIPT, '1', KEY, String(now), id, String(cutoff)]
  if (cfg.rest) {
    const { data } = await axios.post(cfg.rest.url, args, { headers: { Authorization: `Bearer ${cfg.rest.token}` }, timeout: 4000 })
    if (data?.error) throw new Error(data.error)
    return Number(data.result)
  }
  if (cfg.tcp) {
    const r = await redisTcp(cfg.tcp, args)
    if (r[0] !== ':') throw new Error('redis: balasan tak terduga')
    return Number(r.slice(1))
  }
  if (process.env.VERCEL) return null
  mem.set(id, now)
  for (const [k, t] of mem) if (t <= cutoff) mem.delete(k)
  return mem.size
}
