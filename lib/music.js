import express from 'express'
import axios from 'axios'
import { Innertube, UniversalCache } from 'youtubei.js'
import { redisConfig } from './online.js'

// ===== Fitur Musik: cari lagu (YouTube Music), URL stream audio, lirik (LRCLIB) =====
// Dipasang di lib/app.js: app.use(musicRouter). Frontend: public/music.js (tab "Musik").
//
// Arsitektur "resolve-only": server hanya MENCARI URL stream (1-5 detik), browser user yang
// memutarnya langsung dari googlevideo lewat tag <audio>. File audio tidak pernah lewat server
// ini, jadi bandwidth Vercel tetap tipis (per lagu hanya beberapa KB) dan fungsi cepat selesai.
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
let ytP = null
function getYt() {
  if (!ytP) {
    ytP = Innertube.create({
      cache: new UniversalCache(false), // memori saja: FS serverless read-only
      retrieve_player: true,
      ...(process.env.YT_COOKIE && { cookie: process.env.YT_COOKIE }) // kunci kalau IP Vercel di-flag YouTube
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
const CHAIN = ['ANDROID_VR', 'TVHTML5_SIMPLY_EMBEDDED_PLAYER', 'IOS', 'WEB']
r.get('/api/music/stream', async (req, res) => {
  const id = String(req.query.id || '')
  const cid = String(req.query.clientId || '')
  if (!/^[\w-]{6,20}$/.test(id)) return res.status(400).json({ error: 'ID lagu tidak valid' })
  if (!(await allow(cid, 60, 60))) return res.status(429).json({ error: 'Terlalu sering, tunggu sebentar' })
  res.set('Cache-Control', 'no-store')
  const ck = K + ':v:' + id
  const cached = await cget(ck)
  if (cached) return res.json(JSON.parse(cached))
  let bot = false
  try {
    const yt = await getYt()
    for (const client of CHAIN) {
      try {
        const info = await yt.getBasicInfo(id, client)
        const st = info.playability_status && info.playability_status.status
        if (st === 'LOGIN_REQUIRED') { bot = true; continue }
        if (st !== 'OK') continue
        const audio = (info.streaming_data && info.streaming_data.adaptive_formats || [])
          .filter(f => f.has_audio).sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))
        if (!audio.length) continue
        const best = audio[0]
        const out = { url: best.decipher(yt.session.player), itag: best.itag, kbps: Math.round((best.bitrate || 0) / 1000) }
        cset(ck, JSON.stringify(out), 4 * 3600) // URL googlevideo ±6 jam: 4 jam = margin aman
        return res.json(out)
      } catch { /* client ini gagal; coba client berikutnya */ }
    }
  } catch (e) {
    console.error('[music:stream]', e.message)
    return res.status(502).json({ error: 'Stream gagal diambil, coba lagi' })
  }
  // semua client gagal. bot=true = IP server kena bot-check (umum di beberapa region Vercel).
  if (bot) return res.status(503).json({ code: 'bot_check', error: 'YouTube menolak dari IP server ini (bot check). Set env YT_COOKIE (Cookie browser yang login YouTube) lalu redeploy.' })
  res.status(503).json({ code: 'no_streams', error: 'Lagu ini tidak bisa diputar (tidak ada format audio).' })
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
