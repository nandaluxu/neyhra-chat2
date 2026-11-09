import express from 'express'
import axios from 'axios'
import { Innertube, UniversalCache } from 'youtubei.js'
import { redisConfig } from './online.js'

// ===== Fitur Musik: cari lagu (YouTube Music), URL stream audio, lirik (LRCLIB) =====
// Dipasang di lib/app.js: app.use(musicRouter). Frontend: public/music.js (tab "Musik").
//
// Arsitektur (diperbaiki): server mencari URL stream, lalu MENERUSKAN audionya per potongan kecil (/api/music/audio,
// Range 1 MB per permintaan). Kenapa tidak lagi "resolve-only" (browser memutar URL googlevideo langsung)?
// URL googlevideo terikat ke IP yang meminta URL-nya (parameter ip=). Server Vercel yang mencari URL, browser user (IP
// lain) yang memutarnya -> googlevideo membalas 403 -> lagu tidak pernah bisa diputar. Jadi pencari dan pemutar HARUS
// IP yang sama = server. Satu lagu ±4 MB lewat Vercel; potongan 1 MB menjaga tiap permintaan tetap singkat (aman dari
// batas durasi fungsi). Jalan lokal (npm start) tidak punya masalah ini; MUSIC_DIRECT=1 mengembalikan perilaku lama.
//
// Cache & rate-limit memakai Redis lewat konfigurasi yang sama dengan lib/online.js (Upstash REST
// atau Redis TCP). Tanpa Redis (jalan lokal) keduanya jatuh ke memori — cukup untuk dev.
//
// Catatan riset (Nov 2026) soal bot-check YouTube, supaya tidak bingung kalau stream gagal:
//   - music.search (client YouTube Music) selalu jalan dari IP datacenter → pencarian stabil.
//   - endpoint "player" bisa kena "Sign in to confirm you're not a bot" tergantung reputasi IP.
//     Kalau kena: dicoba berurutan client paling tahan (ANDROID_VR, TV_EMBEDDED, IOS, WEB).
//     Masih gagal? Set env YT_COOKIE = nilai header Cookie browser kamu yang login YouTube,
//     lalu redeploy. (Pencarian dan lirik tetap jalan walau stream diblokir.)
const r = express.Router()
const cfg = redisConfig()

/* ---------- kunci + cache ---------- */
const K = 'neyhra:music'
const mem = new Map()
async function cget(k) {
  if (cfg.rest) {
    try {
      const { data } = await axios.post(cfg.rest.url, ['GET', k], { headers: { Authorization: `Bearer ${cfg.rest.token}` }, timeout: 3000 })
      return data?.result ?? null
    } catch { return null }
  }
  const e = mem.get(k)
  return e && Date.now() < e.exp ? e.v : null
}
async function cset(k, v, ttl) { // ttl detik; nilai selalu string (JSON)
  if (cfg.rest) {
    try { await axios.post(cfg.rest.url, ['SET', k, v, 'EX', ttl], { headers: { Authorization: `Bearer ${cfg.rest.token}` }, timeout: 3000 }) } catch {}
    return
  }
  if (mem.size > 400) mem.clear()
  mem.set(k, { v, exp: Date.now() + ttl * 1000 })
}

/* ---------- rate-limit per pengguna ( EVAL tunggal seperti lib/online.js ) ---------- */
const RL_SCRIPT = `local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return n`
const rl = new Map()
async function allow(cid, limit, windowSec) {
  const k = K + ':rl:' + String(cid || 'anon').slice(0, 64)
  if (cfg.rest) {
    try {
      const { data } = await axios.post(cfg.rest.url, ['EVAL', RL_SCRIPT, '1', k, String(windowSec)], { headers: { Authorization: `Bearer ${cfg.rest.token}` }, timeout: 3000 })
      return Number(data.result) <= limit
    } catch { return true } /* Redis bermasalah = jangan blokir pengguna */
  }
  const e = rl.get(k), now = Date.now()
  if (!e || now > e.reset) { rl.set(k, { n: 1, reset: now + windowSec * 1000 }); return true }
  if (e.n >= limit) return false
  e.n++
  return true
}

/* ---------- sesi Innertube tunggal (dibuat mahal: 2-4 dtk, jangan per request) ---------- */
// YT_COOKIE boleh berisi: (a) satu baris header Cookie "a=1; b=2", atau (b) isi file cookies.txt format Netscape
// (hasil ekstensi "Get cookies.txt LOCALLY"; ditempel utuh, multi-baris). Format (b) diubah ke (a) di sini.
export function cookieHeader(raw) {
  raw = String(raw || '').trim()
  if (!raw) return ''
  if (!/\n/.test(raw) && /^[^\s=]+=/.test(raw)) return raw
  const jar = new Map()
  for (let line of raw.split(/\r?\n/)) {
    line = line.replace(/^#HttpOnly_/, '').trim()
    if (!line || line.startsWith('#')) continue
    const f = line.split(/\s+/)
    if (f.length < 7 || !/^(TRUE|FALSE)$/i.test(f[1])) continue
    if (!/(^|\.)(youtube|google)\.com$/i.test(f[0].replace(/^\./, ''))) continue
    jar.set(f[5], f.slice(6).join(''))
  }
  return [...jar].map(([k, v]) => k + '=' + v).join('; ')
}
const COOKIE = cookieHeader(process.env.YT_COOKIE)
let ytP = null
function getYt() {
  if (!ytP) {
    ytP = Innertube.create({
      cache: new UniversalCache(false), // memori saja: FS serverless read-only
      retrieve_player: true,
      ...(COOKIE && { cookie: COOKIE }) // kunci kalau IP Vercel di-flag YouTube
    }).catch(e => { ytP = null; throw e })
  }
  return ytP
}

/* ---------- endpoint: pencarian lagu ---------- */
const big = u => typeof u === 'string' ? u.replace(/w\d+-h\d+/, 'w544-h544') : undefined
r.get('/api/music/search', async (req, res) => {
  const q = String(req.query.q || '').trim()
  const cid = String(req.query.clientId || '')
  if (!q) return res.json({ songs: [] })
  if (q.length > 80) return res.status(400).json({ error: 'Pencarian terlalu panjang' })
  if (!(await allow(cid, 30, 60))) return res.status(429).json({ error: 'Terlalu sering, tunggu sebentar' })
  res.set('Cache-Control', 'no-store')
  const ck = K + ':s:' + q.toLowerCase().slice(0, 80)
  const cached = await cget(ck)
  if (cached) return res.json({ songs: JSON.parse(cached) })
  try {
    const yt = await getYt()
    const out = await yt.music.search(q, { type: 'song' })
    const shelf = (out.contents || []).find(c => c && c.type === 'MusicShelf')
    const songs = (((shelf && shelf.contents) || [])).map(it => {
      if (!it || !it.id || !it.title) return null
      const artists = (it.artists || []).map(a => a && a.name).filter(Boolean)
      return {
        id: it.id,
        title: it.title,
        artist: artists.join(', ') || '—',
        album: it.album && it.album.name || '',
        dur: it.duration && it.duration.seconds || 0,
        thumb: big(it.thumbnail && it.thumbnail.contents && it.thumbnail.contents[0] && it.thumbnail.contents[0].url)
      }
    }).filter(Boolean)
    if (songs.length) cset(ck, JSON.stringify(songs), 1800) // hasil pencarian stabil: cache 30 menit
    res.json({ songs })
  } catch (e) {
    console.error('[music:search]', e.message)
    res.status(502).json({ error: 'Pencarian gagal, coba lagi' })
  }
})

/* ---------- endpoint: URL stream audio ---------- */
// Client diurut dari yang paling tahan bot-check (pola yt-dlp). Cookie otomatis ikut kalau YT_COOKIE diset.
// Nama = nilai InnerTubeClient youtubei.js (bukan nama ClientType; 'TVHTML5_SIMPLY_EMBEDDED_PLAYER' dulu salah dan tidak dikenali).
const CHAIN = ['ANDROID_VR', 'TV_SIMPLY', 'IOS', 'WEB_EMBEDDED', 'WEB']
// User-Agent sesuai client yang mengeluarkan URL (googlevideo kadang menolak/menahan kalau tidak cocok)
const UA_WEB = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const UA = {
  ANDROID_VR: 'com.google.android.apps.youtube.vr.oculus/1.62.27 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip',
  IOS: 'com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)'
}
// Cari URL stream terbaik untuk satu lagu. Hasil di-cache DI MEMORI instance (bukan Redis): URL terikat ke IP instance yang
// mencarinya, jadi URL dari instance lain tidak berguna. force=true = abaikan cache (URL sudah ditolak googlevideo).
const sc = new Map(), inflight = new Map()
async function resolveStream(id, force = false) {
  const hit = sc.get(id)
  if (!force && hit && Date.now() < hit.exp) return hit.s
  if (inflight.has(id)) return inflight.get(id)
  const p = (async () => {
    let bot = false
    try {
      const yt = await getYt()
      for (const client of CHAIN) {
        try {
          const info = await yt.getBasicInfo(id, { client }) // opsi objek: kalau string dilempar langsung, client diabaikan dan selalu WEB
          const st = info.playability_status && info.playability_status.status
          if (st === 'LOGIN_REQUIRED') { bot = true; continue }
          if (st !== 'OK') continue
          const audio = (info.streaming_data && info.streaming_data.adaptive_formats || [])
            .filter(f => f.has_audio && !f.has_video)
            // m4a/AAC dulu (jalan di semua browser, termasuk Safari), lalu bitrate tertinggi
            .sort((a, b) => (/mp4/.test(b.mime_type || '') - /mp4/.test(a.mime_type || '')) || ((b.bitrate || 0) - (a.bitrate || 0)))
          if (!audio.length) continue
          const best = audio[0], url = best.decipher(yt.session.player)
          if (!url) continue
          const s = { url, ua: UA[client] || UA_WEB, mime: String(best.mime_type || 'audio/mp4').split(';')[0], len: Number(best.content_length) || 0, itag: best.itag, kbps: Math.round((best.bitrate || 0) / 1000), client }
          if (sc.size > 200) sc.clear()
          sc.set(id, { s, exp: Date.now() + 90 * 60e3 }) // 90 menit; URL aslinya ±6 jam
          return s
        } catch (e) { console.error('[music:resolve]', client, e.message) /* client ini gagal; coba berikutnya */ }
      }
    } catch (e) {
      console.error('[music:stream]', e.message)
      return { fail: { status: 502, error: 'Stream gagal diambil, coba lagi' } }
    }
    // semua client gagal. bot=true = IP server kena bot-check (umum di beberapa region Vercel).
    if (bot) return { fail: { status: 503, code: 'bot_check', error: 'YouTube menolak dari IP server ini (bot check). Set env YT_COOKIE (Cookie browser yang login YouTube) lalu redeploy.' } }
    return { fail: { status: 503, code: 'no_streams', error: 'Lagu ini tidak bisa diputar (tidak ada format audio).' } }
  })().finally(() => inflight.delete(id))
  inflight.set(id, p)
  return p
}

r.get('/api/music/stream', async (req, res) => {
  const id = String(req.query.id || '')
  const cid = String(req.query.clientId || '')
  if (!/^[\w-]{6,20}$/.test(id)) return res.status(400).json({ error: 'ID lagu tidak valid' })
  if (!(await allow(cid, 60, 60))) return res.status(429).json({ error: 'Terlalu sering, tunggu sebentar' })
  res.set('Cache-Control', 'no-store')
  const s = await resolveStream(id)
  if (s.fail) return res.status(s.fail.status).json({ code: s.fail.code, error: s.fail.error })
  // MUSIC_DIRECT=1: kembalikan URL googlevideo langsung (hanya benar kalau server dan pemutar satu IP, mis. npm start lokal)
  const url = process.env.MUSIC_DIRECT === '1' ? s.url : '/api/music/audio?id=' + encodeURIComponent(id) + '&clientId=' + encodeURIComponent(cid)
  res.json({ url, itag: s.itag, kbps: s.kbps })
})

/* ---------- endpoint: audio (diteruskan dari googlevideo per potongan, mendukung Range) ---------- */
const CHUNK = 1024 * 1024
r.get('/api/music/audio', async (req, res) => {
  const id = String(req.query.id || '')
  const cid = String(req.query.clientId || '')
  if (!/^[\w-]{6,20}$/.test(id)) return res.status(400).json({ error: 'ID lagu tidak valid' })
  if (!(await allow('a' + cid, 600, 60))) return res.status(429).json({ error: 'Terlalu sering, tunggu sebentar' })
  for (let attempt = 0; attempt < 2; attempt++) {
    const s = await resolveStream(id, attempt > 0) // percobaan ke-2: cari URL baru (URL lama ditolak / instance lain)
    if (s.fail) return res.status(s.fail.status).json({ code: s.fail.code, error: s.fail.error })
    // Range dari browser: "bytes=a-b", "bytes=a-", atau "bytes=-n" (n byte terakhir). Tanpa Range = mulai dari 0.
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''))
    let start = 0, end = CHUNK - 1
    if (m && (m[1] || m[2])) {
      if (m[1]) { start = +m[1]; end = m[2] ? +m[2] : start + CHUNK - 1 }
      else if (s.len) { start = Math.max(0, s.len - +m[2]); end = s.len - 1 }
    }
    end = Math.min(end, start + CHUNK - 1)
    if (s.len) { if (start >= s.len) return res.status(416).set('Content-Range', 'bytes */' + s.len).end(); end = Math.min(end, s.len - 1) }
    let up
    try {
      up = await axios.get(s.url, { responseType: 'stream', headers: { Range: `bytes=${start}-${end}`, 'User-Agent': s.ua, 'Accept-Encoding': 'identity' }, timeout: 12000, maxRedirects: 3, validateStatus: () => true, decompress: false })
    } catch (e) { console.error('[music:audio]', e.message); continue }
    if (up.status === 403 || up.status === 404 || up.status === 410) { up.data.destroy(); sc.delete(id); continue }
    if (up.status !== 206 && up.status !== 200) { up.data.destroy(); return res.status(502).json({ error: 'Audio tidak tersedia dari sumber' }) }
    const cr = /bytes (\d+)-(\d+)\/(\d+|\*)/.exec(String(up.headers['content-range'] || ''))
    const total = cr && cr[3] !== '*' ? +cr[3] : s.len || 0
    const a = cr ? +cr[1] : 0, b = cr ? +cr[2] : (+up.headers['content-length'] || 0) - 1 // 200 (Range diabaikan) = isi penuh dari byte 0
    res.status(206).set({
      'Content-Type': s.mime, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=3600',
      'Content-Range': `bytes ${a}-${b}/${total || '*'}`, 'Content-Length': String(b - a + 1)
    })
    req.on('close', () => up.data.destroy())
    up.data.on('error', () => res.destroy())
    up.data.pipe(res)
    return
  }
  res.status(502).json({ error: 'Audio tidak bisa diambil, coba lagi' })
})

/* ---------- endpoint: diagnosa (buka di browser: /api/music/debug) ---------- */
r.get('/api/music/debug', async (req, res) => {
  const id = /^[\w-]{6,20}$/.test(String(req.query.id || '')) ? String(req.query.id) : 'dQw4w9WgXcQ'
  if (!(await allow('dbg' + String(req.query.clientId || req.ip || ''), 6, 60))) return res.status(429).json({ error: 'Terlalu sering' })
  res.set('Cache-Control', 'no-store')
  const out = { id, cookie: { diset: !!COOKIE, jumlah: COOKIE ? COOKIE.split('; ').length : 0, ada_SAPISID: /(^|; )(__Secure-3PAPISID|SAPISID)=/.test(COOKIE) }, clients: [] }
  let yt
  try { yt = await getYt() } catch (e) { out.error = 'Innertube gagal dibuat: ' + e.message; return res.json(out) }
  for (const client of CHAIN) {
    const row = { client }
    try {
      const info = await yt.getBasicInfo(id, { client })
      const ps = info.playability_status || {}
      row.status = ps.status; row.alasan = ps.reason || undefined
      const fm = (info.streaming_data && info.streaming_data.adaptive_formats || []).filter(f => f.has_audio && !f.has_video)
      row.format_audio = fm.length
      if (ps.status === 'OK' && fm.length) {
        const url = fm[0].decipher(yt.session.player)
        const t = await axios.get(url, { headers: { Range: 'bytes=0-1', 'User-Agent': UA[client] || UA_WEB }, timeout: 8000, validateStatus: () => true, responseType: 'arraybuffer' }).catch(e => ({ status: 'error: ' + e.message }))
        row.googlevideo_dari_server = t.status
      }
    } catch (e) { row.error = e.message }
    out.clients.push(row)
    if (row.googlevideo_dari_server === 206) break
  }
  out.kesimpulan = out.clients.some(c => c.googlevideo_dari_server === 206) ? 'OK: server bisa mengambil audio' : out.clients.some(c => c.status === 'LOGIN_REQUIRED') ? 'BOT CHECK: butuh YT_COOKIE' : 'Gagal, lihat detail clients'
  res.json(out)
})

/* ---------- endpoint: lirik (LRCLIB: gratis, tanpa auth, tanpa bot-check) ---------- */
const LRC = /\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g
function parseLrc(lrc) {
  const out = []
  for (const raw of String(lrc || '').split('\n')) {
    const stamps = []
    LRC.lastIndex = 0
    let m, end = 0
    while ((m = LRC.exec(raw))) { stamps.push(Number(m[1]) * 60 + Number(m[2]) + (m[3] ? Number('0.' + m[3]) : 0)); end = LRC.lastIndex }
    const text = raw.slice(end).trim()
    for (const t of stamps) if (text) out.push({ t, text })
  }
  return out.sort((a, b) => a.t - b.t)
}
const LRC_HEADERS = { 'User-Agent': 'neyhra-music/1.0 (https://github.com/nandaluxu/neyhra-chat2)' }
r.get('/api/music/lyrics', async (req, res) => {
  const title = String(req.query.title || '').trim().slice(0, 120)
  const artist = (String(req.query.artist || '').trim().slice(0, 120)) || 'Unknown'
  const dur = parseInt(req.query.dur, 10) || 0
  if (!title) return res.json({ lyrics: null })
  const ck = K + ':l:' + title.toLowerCase() + '|' + artist.toLowerCase()
  const cached = await cget(ck)
  if (cached) return res.json({ lyrics: JSON.parse(cached) })
  let out = null
  try {
    const opt = { headers: LRC_HEADERS, timeout: 8000 }
    let hit = null
    if (dur) hit = (await axios.get(`https://lrclib.net/api/get?artist_name=${encodeURIComponent(artist)}&track_name=${encodeURIComponent(title)}&duration=${dur}`, opt).catch(() => null))?.data
    if (!hit || !(hit.syncedLyrics || hit.plainLyrics))
      hit = (await axios.get(`https://lrclib.net/api/search?track_name=${encodeURIComponent(title)}&artist_name=${encodeURIComponent(artist)}`, opt).catch(() => null))?.data
    hit = Array.isArray(hit) ? hit[0] : hit
    if (hit && (hit.syncedLyrics || hit.plainLyrics))
      out = { synced: parseLrc(hit.syncedLyrics), plain: hit.plainLyrics || '' }
  } catch { /* anggap tidak ada lirik */ }
  cset(ck, JSON.stringify(out), 7 * 24 * 3600) // lirik tidak berubah: cache 7 hari
  res.json({ lyrics: out })
})

export const musicRouter = r
