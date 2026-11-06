import axios from 'axios'
import net from 'node:net'
import tls from 'node:tls'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { redisConfig } from './online.js'

/* ===== Chat Global: penyimpanan bersama (Redis) =====
   Melanjutkan pola lib/online.js: Vercel serverless tidak punya memori bersama, jadi state chat global
   disimpan di Redis. Tiga mode (otomatis dari env, urutan: REST -> TCP -> memori):
     1) Upstash REST  : 1 request = 1 perintah, EVAL dihitung SATU perintah (hemat kuota harian).
     2) Redis TCP     : klien RESP2 minimal (tanpa dependency), satu koneksi per perintah.
     3) Memori lokal  : tanpa Redis di lokal (dev). Di Vercel tanpa env Redis -> fitur mati (enabled:false).

   Tata letak kunci (semua berprefiks neyhra:gc:):
     msgs   LIST    maks 10 pesan terbaru, TTL 24 jam (batas sesuai desain, bukan penyimpanan penuh)
     tombs  ZSET    id pesan yang dihapus (skor = waktu hapus), TTL 60 hari -> invalidasi persisten
     clear  STRING  watermark (ms): pesan dengan ts <= nilai ini dianggap terhapus semua, TTL 60 hari
     live   ZSET    presence ruang chat (skor = heartbeat terakhir), dianggap hidup < 30 detik
     sig:*  LIST    signaling WebRTC untuk satu penerima, TTL 60 detik, maks 20 (dibuang setelah dibaca)
     rls/rlx/rlb     penghitung rate-limit (kirim pesan / signaling / heartbeat)
     sign:priv / sign:pub  kunci ECDSA P-256 untuk tanda tangan pesan (dibuat sekali, tanpa TTL)

   Catatan: Redis Pub/Sub sengaja TIDAK dipakai — serverless tidak bisa memegang subscription dan
   Pub/Sub bukan penyimpanan event. Realtime ditangani WebRTC DataChannel; polling hanya fallback. */

const cfg = redisConfig()

const MAX_MSGS = 10            // Redis hanya menyimpan N pesan terbaru
const MSG_TTL = 86400          // 24 jam
const TOMB_TTL = 5184000       // 60 hari
const LIVE_WIN = 30            // detik
const SIG_TTL = 60
const RL_SEND = 6              // maks pesan per 12 detik per clientId
const RL_SIG = 60              // maks signaling per 12 detik per clientId
const RL_BEAT = 90             // maks heartbeat per 15 detik per clientId

const KEY = {
  msgs: 'neyhra:gc:msgs', tombs: 'neyhra:gc:tombs', clear: 'neyhra:gc:clear', live: 'neyhra:gc:live',
  sig: id => `neyhra:gc:sig:${id}`, rls: id => `neyhra:gc:rls:${id}`, rlx: id => `neyhra:gc:rlx:${id}`, rlb: id => `neyhra:gc:rlb:${id}`,
  priv: 'neyhra:gc:sign:priv', pub: 'neyhra:gc:sign:pub'
}

/* ---------- Skrip Lua (semuanya satu EVAL = satu perintah) ---------- */

// Heartbeat + ambil semua: peer aktif, pesan baru sejak `since`, signaling untuk saya, watermark, tombstone baru.
const SYNC = `local now = tonumber(ARGV[1])
local me = ARGV[2]
local since = tonumber(ARGV[3]) or 0
local tb = tonumber(ARGV[4]) or 0
local b = redis.call('INCR', KEYS[6])
if b == 1 then redis.call('EXPIRE', KEYS[6], 15) end
if b > ${RL_BEAT} then return {'RL'} end
redis.call('ZADD', KEYS[1], now, me)
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - ${LIVE_WIN})
redis.call('EXPIRE', KEYS[1], 120)
local peers = redis.call('ZRANGE', KEYS[1], 0, 7)
local count = redis.call('ZCARD', KEYS[1])
local msgs = {}
for _, j in ipairs(redis.call('LRANGE', KEYS[2], 0, -1)) do
  local ok, m = pcall(cjson.decode, j)
  if ok and m and tonumber(m.ts) and tonumber(m.ts) > since then table.insert(msgs, j) end
end
local sigs = redis.call('LRANGE', KEYS[3], 0, -1)
if #sigs > 0 then redis.call('DEL', KEYS[3]) end
local wm = redis.call('GET', KEYS[4])
local tombs
if tb > 0 then tombs = redis.call('ZRANGEBYSCORE', KEYS[5], '(' .. tb, '+inf', 'WITHSCORES')
else tombs = redis.call('ZRANGE', KEYS[5], 0, -1, 'WITHSCORES') end
return {peers, count, msgs, sigs, wm, tombs}`

// Simpan satu pesan (sudah divalidasi & bertanda tangan) + rate-limit per clientId.
const SEND = `local n = redis.call('INCR', KEYS[2])
if n == 1 then redis.call('EXPIRE', KEYS[2], 12) end
if n > ${RL_SEND} then return 0 end
redis.call('RPUSH', KEYS[1], ARGV[1])
redis.call('LTRIM', KEYS[1], -${MAX_MSGS}, -1)
redis.call('EXPIRE', KEYS[1], ${MSG_TTL})
return 1`

// Simpan satu frame signaling untuk `to`. `from` wajib tercatat hidup di presence (identitas tidak dipercaya begitu saja).
const SIGNAL = `local now = tonumber(ARGV[1])
local t = redis.call('ZSCORE', KEYS[1], ARGV[2])
if not t or tonumber(t) < now - ${LIVE_WIN} then return -1 end
local n = redis.call('INCR', KEYS[3])
if n == 1 then redis.call('EXPIRE', KEYS[3], 12) end
if n > ${RL_SIG} then return -2 end
redis.call('RPUSH', KEYS[2], ARGV[3])
redis.call('LTRIM', KEYS[2], -20, -1)
redis.call('EXPIRE', KEYS[2], ${SIG_TTL})
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

const mem = () => M || (M = { msgs: [], mt: 0, tombs: new Map(), clear: 0, live: new Map(), sigs: new Map(), rl: new Map(), priv: null, pub: null })
let M = null
const liveNow = now => { const m = mem(); for (const [k, t] of m.live) if (t <= now - LIVE_WIN * 1000) m.live.delete(k); return m }
const rlHit = (k, max, winMs, now) => { const m = mem(), e = m.rl.get(k); if (!e || e.until < now) { m.rl.set(k, { n: 1, until: now + winMs }); return 1 } e.n++; return e.n <= max ? e.n : e.n }
const j = o => JSON.stringify(o)

function memSync(id, nowMs, sinceMs, tombMs) {
  const m = liveNow(nowMs)
  if (rlHit('b:' + id, RL_BEAT, 15000, nowMs) > RL_BEAT) return { rl: true }
  m.live.set(id, nowMs)
  const peers = [...m.live.keys()].slice(0, 8)
  if (m.mt && m.mt < nowMs) { m.msgs = []; m.mt = 0 } // TTL 24 jam
  const msgs = m.msgs.filter(x => x.ts > sinceMs).map(j)
  const sigs = m.sigs.get(id) || []
  m.sigs.delete(id)
  const tombs = [...m.tombs.entries()].filter(([, t]) => t > tombMs).flatMap(([k, t]) => [k, String(t)])
  return { peers, count: m.live.size, msgs, sigs, wm: m.clear || null, tombs }
}
function memSend(msg, nowMs) {
  const m = mem()
  if (rlHit('s:' + msg.senderId, RL_SEND, 12000, nowMs) > RL_SEND) return 0
  m.msgs.push(msg); m.msgs = m.msgs.slice(-MAX_MSGS); m.mt = nowMs + MSG_TTL * 1000
  return 1
}
function memSignal(from, to, payload, nowMs) {
  const m = liveNow(nowMs)
  const t = m.live.get(from)
  if (!t || t < nowMs - LIVE_WIN * 1000) return -1
  if (rlHit('x:' + from, RL_SIG, 12000, nowMs) > RL_SIG) return -2
  const q = m.sigs.get(to) || []; q.push(payload); m.sigs.set(to, q.slice(-20))
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
  const r = await eval_(SYNC, [KEY.live, KEY.msgs, KEY.sig(id), KEY.clear, KEY.tombs, KEY.rlb(id)], [nowMs, id, sinceMs, tombMs])
  if (r?.[0] === 'RL') return { rl: true }
  return { peers: r[0] || [], count: r[1] || 0, msgs: r[2] || [], sigs: r[3] || [], wm: r[4], tombs: r[5] || [] }
}

export async function send(msg, nowMs) {
  if (local) return memSend(msg, nowMs)
  return eval_(SEND, [KEY.msgs, KEY.rls(msg.senderId)], [j(msg)])
}

export async function signal(from, to, payload, nowMs) {
  if (local) return memSignal(from, to, payload, nowMs)
  return eval_(SIGNAL, [KEY.live, KEY.sig(to), KEY.rlx(from)], [nowMs, from, payload])
}

export async function tomb(id, nowMs) {
  if (local) return memTomb(id, nowMs)
  return eval_(TOMB, [KEY.tombs, KEY.msgs], [nowMs, id])
}

export async function clear(nowMs) {
  if (local) return memClear(nowMs)
  return eval_(CLEAR, [KEY.clear, KEY.msgs, KEY.tombs], [nowMs])
}

/* ---------- Kunci tanda tangan pesan (ECDSA P-256) ----------
   Dibuat sekali lalu disimpan di Redis (atau file lokal) supaya semua instance serverless
   menandatangani dengan kunci yang sama dan browser bisa memverifikasi pesan dari peer. */

let pair = null

async function loadPair() {
  if (pair) return pair
  if (local) {
    const f = path.join(process.cwd(), '.gc-sign.json')
    try {
      const o = JSON.parse(fs.readFileSync(f, 'utf8'))
      pair = { priv: crypto.createPrivateKey(o.priv), pub: o.pub }
      return pair
    } catch {}
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    const priv = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    const pub = publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
    try { fs.writeFileSync(f, j({ priv, pub })) } catch {}
    pair = { priv: privateKey, pub }
    return pair
  }
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  const pubB64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
  // SETNX: instance pertama yang menang menentukan kunci, sisanya memakai kunci yang sama.
  const won = await redis(['SET', KEY.priv, privPem, 'NX'])
  if (won === 'OK') { await redis(['SET', KEY.pub, pubB64, 'NX']); pair = { priv: privateKey, pub: pubB64 }; return pair }
  const priv = await redis(['GET', KEY.priv]), pub = await redis(['GET', KEY.pub])
  if (!priv || !pub) throw new Error('kunci tanda tangan rusak di Redis')
  pair = { priv: crypto.createPrivateKey(priv), pub }
  return pair
}

// Tanda tangan server atas identitas lengkap sebuah pesan -> dipakai browser untuk memverifikasi pesan dari peer P2P.
// dsaEncoding 'ieee-p1363' (r||s mentah 64 byte) karena itulah format yang diverifikasi WebCrypto di browser;
// format bawaan Node (DER) akan selalu gagal di crypto.subtle.verify.
export async function sign(msg) {
  const { priv } = await loadPair()
  const payload = j([msg.id, msg.senderId, msg.senderName, msg.ts, msg.text])
  return crypto.sign('sha256', Buffer.from(payload), { key: priv, dsaEncoding: 'ieee-p1363' }).toString('base64')
}

export async function pubKey() { return (await loadPair()).pub }
