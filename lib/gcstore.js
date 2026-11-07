import axios from 'axios'
import net from 'node:net'
import tls from 'node:tls'
import { redisConfig } from './online.js'

/* ===== Chat Global: presence, rate-limit, dan feed realtime (Redis) =====
   Riwayat pesan LENGKAP ada di MongoDB (koleksi gc_messages, lihat lib/gc.js). Redis hanya memegang yang cepat dan sementara.
   Melanjutkan pola lib/online.js: Vercel serverless tidak punya memori bersama. Tiga mode (otomatis dari env, urutan: REST -> TCP -> memori):
     1) Upstash REST  : 1 request = 1 perintah, EVAL dihitung SATU perintah (hemat kuota harian).
     2) Redis TCP     : klien RESP2 minimal (tanpa dependency), satu koneksi per perintah.
     3) Memori lokal  : tanpa Redis di lokal (dev). Di Vercel tanpa env Redis -> fitur mati (enabled:false).

   Tata letak kunci (semua berprefiks neyhra:gc:):
     msgs   LIST    maks 10 pesan terbaru, TTL 24 jam: feed polling (salinan cepat, BUKAN penyimpanan; sumber kebenaran = Mongo)
     tombs  ZSET    id pesan yang dihapus (skor = waktu hapus), TTL 60 hari -> klien yang sedang online ikut membuangnya
     clear  STRING  watermark (ms): pesan dengan ts <= nilai ini dianggap terhapus semua, TTL 60 hari
     live   ZSET    presence ruang chat (skor = heartbeat terakhir), dianggap hidup < 30 detik
     rls/rlb/rlh     penghitung rate-limit (kirim pesan / heartbeat / ambil riwayat)

   Catatan: Redis Pub/Sub sengaja TIDAK dipakai — serverless tidak bisa memegang subscription. Realtime = polling adaptif ke feed `msgs`. */

const cfg = redisConfig()

export const MAX_MSGS = 10     // Redis hanya menyimpan N pesan terbaru
const MSG_TTL = 86400          // 24 jam
const TOMB_TTL = 5184000       // 60 hari
const LIVE_WIN = 30            // detik
const RL_SEND = 6              // maks pesan per 12 detik per pengirim
const RL_BEAT = 90             // maks heartbeat per 15 detik per clientId
const RL_HIST = 30             // maks permintaan riwayat (Mongo) per 15 detik per clientId

const KEY = {
  msgs: 'neyhra:gc:msgs', tombs: 'neyhra:gc:tombs', clear: 'neyhra:gc:clear', live: 'neyhra:gc:live',
  rls: id => `neyhra:gc:rls:${id}`, rlb: id => `neyhra:gc:rlb:${id}`, rlh: id => `neyhra:gc:rlh:${id}`
}

/* ---------- Skrip Lua (semuanya satu EVAL = satu perintah) ---------- */

// Heartbeat + ambil: jumlah presence, pesan baru sejak `since` dari feed, watermark, tombstone baru.
// llen/oldest = isi feed (dipakai gc.js untuk tahu apakah klien tertinggal lebih dari 10 pesan -> tambal dari Mongo).
const SYNC = `local now = tonumber(ARGV[1])
local me = ARGV[2]
local since = tonumber(ARGV[3]) or 0
local tb = tonumber(ARGV[4]) or 0
local b = redis.call('INCR', KEYS[5])
if b == 1 then redis.call('EXPIRE', KEYS[5], 15) end
if b > ${RL_BEAT} then return {'RL'} end
redis.call('ZADD', KEYS[1], now, me)
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - ${LIVE_WIN})
redis.call('EXPIRE', KEYS[1], 120)
local count = redis.call('ZCARD', KEYS[1])
local msgs = {}
local oldest = 0
local all = redis.call('LRANGE', KEYS[2], 0, -1)
for i, j in ipairs(all) do
  local ok, m = pcall(cjson.decode, j)
  if ok and m and tonumber(m.ts) then
    if i == 1 then oldest = tonumber(m.ts) end
    if tonumber(m.ts) > since then table.insert(msgs, j) end
  end
end
local wm = redis.call('GET', KEYS[3])
local tombs
if tb > 0 then tombs = redis.call('ZRANGEBYSCORE', KEYS[4], '(' .. tb, '+inf', 'WITHSCORES')
else tombs = redis.call('ZRANGE', KEYS[4], 0, -1, 'WITHSCORES') end
return {count, msgs, wm, tombs, #all, oldest}`

// Rate-limit generik: KEYS[1] penghitung, ARGV[1] maks, ARGV[2] jendela detik. 1 = boleh, 0 = ditolak.
const HIT = `local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('EXPIRE', KEYS[1], tonumber(ARGV[2])) end
if n > tonumber(ARGV[1]) then return 0 end
return 1`

// Taruh pesan (yang SUDAH tersimpan di Mongo) ke feed realtime.
const PUSH = `redis.call('RPUSH', KEYS[1], ARGV[1])
redis.call('LTRIM', KEYS[1], -${MAX_MSGS}, -1)
redis.call('EXPIRE', KEYS[1], ${MSG_TTL})
return 1`

// Tombstone satu pesan: catat id-nya selamanya (60 hari) dan buang dari daftar pesan Redis.
const TOMB = `redis.call('ZADD', KEYS[1], tonumber(ARGV[1]), ARGV[2])
redis.call('EXPIRE', KEYS[1], ${TOMB_TTL})
local keep = {}
for _, j in ipairs(redis.call('LRANGE', KEYS[2], 0, -1)) do
  local ok, m = pcall(cjson.decode, j)
  if not ok or not m or m.id ~= ARGV[2] then table.insert(keep, j) end
end
redis.call('DEL', KEYS[2])
if #keep > 0 then
  redis.call('RPUSH', KEYS[2], unpack(keep))
  redis.call('EXPIRE', KEYS[2], ${MSG_TTL})
end
return 1`

// Hapus semua: naikkan watermark (maksimum), kosongkan daftar pesan dan tombstone lama (sudah tercakup watermark).
const CLEAR = `local now = tonumber(ARGV[1])
local prev = tonumber(redis.call('GET', KEYS[1]) or 0)
if now > prev then
  redis.call('SET', KEYS[1], now)
  redis.call('EXPIRE', KEYS[1], ${TOMB_TTL})
  prev = now
end
redis.call('DEL', KEYS[2])
redis.call('DEL', KEYS[3])
return prev`

/* ---------- Klien Redis ---------- */

// RESP2: satu nilai = [nilai, jumlah byte terpakai], atau null kalau belum lengkap.
function respParse(buf, off = 0) {
  const idx = buf.indexOf('\r\n', off)
  if (idx < 0) return null
  const t = String.fromCharCode(buf[off]), rest = buf.slice(off + 1, idx).toString('latin1')
  if (t === '+') return [rest, idx + 2 - off]
  if (t === '-') throw new Error('redis: ' + rest.slice(0, 160))
  if (t === ':') return [Number(rest), idx + 2 - off]
  if (t === '$') {
    const n = Number(rest)
    if (n < 0) return [null, idx + 2 - off]
    if (buf.length < idx + 2 + n + 2) return null
    return [buf.slice(idx + 2, idx + 2 + n).toString('utf8'), idx + 2 + n + 2 - off]
  }
  if (t === '*') {
    const n = Number(rest)
    if (n < 0) return [null, idx + 2 - off]
    let p = idx + 2, out = []
    for (let i = 0; i < n; i++) {
      const r = respParse(buf, p)
      if (!r) return null
      out.push(r[0]); p += r[1]
    }
    return [out, p - off]
  }
  throw new Error('redis: balasan tak dikenal')
}

function redisTcp(urlStr, args, timeout = 5000) {
  const u = new URL(urlStr), secure = u.protocol === 'rediss:'
  const user = decodeURIComponent(u.username), pass = decodeURIComponent(u.password)
  const enc = a => `*${a.length}\r\n` + a.map(x => { const s = String(x); return `$${Buffer.byteLength(s)}\r\n${s}\r\n` }).join('')
  const cmds = []
  if (pass) cmds.push(user ? ['AUTH', user, pass] : ['AUTH', pass])
  cmds.push(args)
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0), done = false, got = 0
    const finish = (err, val) => { if (done) return; done = true; clearTimeout(t); sock.destroy(); err ? reject(err) : resolve(val) }
    const t = setTimeout(() => finish(new Error('redis timeout')), timeout)
    const sock = (secure ? tls : net).connect({ host: u.hostname, port: Number(u.port) || 6379, ...(secure && { servername: u.hostname }) })
    sock.on('error', finish)
    sock.once(secure ? 'secureConnect' : 'connect', () => sock.write(cmds.map(enc).join('')))
    sock.on('data', d => {
      buf = Buffer.concat([buf, d])
      try {
        while (got < cmds.length) {
          const r = respParse(buf)
          if (!r) return
          buf = buf.slice(r[1]); got++
          if (got === cmds.length) return finish(null, r[0])
        }
      } catch (e) { finish(e) }
    })
  })
}

async function redis(args) {
  if (cfg.rest) {
    const { data } = await axios.post(cfg.rest.url, args, { headers: { Authorization: `Bearer ${cfg.rest.token}` }, timeout: 5000 })
    if (data?.error) throw new Error(data.error)
    return data.result
  }
  if (cfg.tcp) return redisTcp(cfg.tcp, args)
  throw new Error('redis tidak terpasang')
}

/* ---------- Mode memori (lokal tanpa Redis; semantik sama, satu proses) ---------- */

const mem = () => M || (M = { msgs: [], mt: 0, tombs: new Map(), clear: 0, live: new Map(), rl: new Map() })
let M = null
const liveNow = now => { const m = mem(); for (const [k, t] of m.live) if (t <= now - LIVE_WIN * 1000) m.live.delete(k); return m }
const rlHit = (k, max, winMs, now) => { const m = mem(), e = m.rl.get(k); if (!e || e.until < now) { m.rl.set(k, { n: 1, until: now + winMs }); return 1 } e.n++; return e.n <= max ? e.n : e.n }
const j = o => JSON.stringify(o)

function memSync(id, nowMs, sinceMs, tombMs) {
  const m = liveNow(nowMs)
  if (rlHit('b:' + id, RL_BEAT, 15000, nowMs) > RL_BEAT) return { rl: true }
  m.live.set(id, nowMs)
  if (m.mt && m.mt < nowMs) { m.msgs = []; m.mt = 0 } // TTL 24 jam
  const msgs = m.msgs.filter(x => x.ts > sinceMs).map(j)
  const tombs = [...m.tombs.entries()].filter(([, t]) => t > tombMs).flatMap(([k, t]) => [k, String(t)])
  return { count: m.live.size, msgs, wm: m.clear || null, tombs, llen: m.msgs.length, oldest: m.msgs[0]?.ts || 0 }
}
function memAllow(kind, id, nowMs) {
  const [max, win] = kind === 'send' ? [RL_SEND, 12000] : [RL_HIST, 15000]
  return rlHit(kind + ':' + id, max, win, nowMs) <= max ? 1 : 0
}
function memPush(msg, nowMs) {
  const m = mem()
  m.msgs.push(msg); m.msgs = m.msgs.slice(-MAX_MSGS); m.mt = nowMs + MSG_TTL * 1000
  return 1
}
function memTomb(id, nowMs) {
  const m = mem()
  m.tombs.set(id, nowMs); m.msgs = m.msgs.filter(x => x.id !== id)
  return 1
}
function memClear(nowMs) {
  const m = mem()
  if (nowMs > m.clear) m.clear = nowMs
  m.msgs = []; m.tombs.clear()
  return m.clear
}

/* ---------- API penyimpanan (dipakai lib/gc.js) ---------- */

export const enabled = !!(cfg.rest || cfg.tcp) || !process.env.VERCEL
const local = !cfg.rest && !cfg.tcp

function eval_(script, keys, args) { return redis(['EVAL', script, String(keys.length), ...keys, ...args]) }

export async function sync(id, nowMs, sinceMs, tombMs) {
  if (local) return memSync(id, nowMs, sinceMs, tombMs)
  const r = await eval_(SYNC, [KEY.live, KEY.msgs, KEY.clear, KEY.tombs, KEY.rlb(id)], [nowMs, id, sinceMs, tombMs])
  if (r?.[0] === 'RL') return { rl: true }
  return { count: r[0] || 0, msgs: r[1] || [], wm: r[2], tombs: r[3] || [], llen: r[4] || 0, oldest: Number(r[5]) || 0 }
}

// kind: 'send' (pesan per pengirim) | 'hist' (permintaan riwayat per clientId). true = boleh.
export async function allow(kind, id, nowMs) {
  if (local) return !!memAllow(kind, id, nowMs)
  const send = kind === 'send'
  return !!(await eval_(HIT, [send ? KEY.rls(id) : KEY.rlh(id)], [send ? RL_SEND : RL_HIST, send ? 12 : 15]))
}

export async function push(msg, nowMs) {
  if (local) return memPush(msg, nowMs)
  return eval_(PUSH, [KEY.msgs], [j(msg)])
}

export async function tomb(id, nowMs) {
  if (local) return memTomb(id, nowMs)
  return eval_(TOMB, [KEY.tombs, KEY.msgs], [nowMs, id])
}

export async function clear(nowMs) {
  if (local) return memClear(nowMs)
  return eval_(CLEAR, [KEY.clear, KEY.msgs, KEY.tombs], [nowMs])
}

// Watermark "hapus semua" saat ini (ms), 0 kalau belum pernah.
export async function wm() {
  if (local) return mem().clear || 0
  return Number(await redis(['GET', KEY.clear])) || 0
}
