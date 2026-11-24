import express from 'express'
import dns from 'node:dns'
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
// LAPISAN NEXRAY (fallback downloader MP3, tanpa login/cookie, tidak kena bot-check):
//   1. Di DALAM server Ptero (server.js): kalau yt-dlp gagal (cookie mati dsb.) /prefetch dan /audio
//      di sana otomatis lanjut ke nexray. Transparan untuk lib ini — tidak perlu perubahan apa pun.
//   2. /api/music/direct (rute baru di sini): untuk "download doang" — balikin JSON URL MP3 di CDN
//      nexray; browser mengunduh LANGSUNG dari CDN (bandwidth Vercel & Ptero = nol, yang lewat
//      server cuma JSON kecil). URL bertanda tangan, berlaku ±2 jam.
//   3. Penyelamat /api/music/stream: kalau server Ptero tidak bisa dihubungi / gagal menyiapkan
//      file, browser dipersilakan memutar MP3 langsung dari CDN nexray (CDN dukung Range/206 dan
//      Accept-Ranges, jadi seek tetap jalan). Kualitas MP3 64kbps < m4a 128kbps dari yt-dlp —
//      makanya nexray hanya lapisan terakhir, bukan jalur utama.
//   4. /api/music/info (rute baru): data YouTube (judul/channel/durasi/views) + daftar kualitas audio
//      & video dari /info server Ptero (yt-dlp). Tiap kualitas punya url unduhan LANGSUNG ke server
//      Ptero (bertoken 6 jam, tanpa API key) — bandwidth Vercel nol. Fallback /direct di Ptero kini
//      juga bisa bersumber 'ytdlp' (url /download relatif -> diabsolutkan di sini pakai MUSIC_PTERO_URL).
//
// Catatan riset (Nov 2026) soal bot-check YouTube, supaya tidak bingung kalau stream gagal:
//   - music.search (client YouTube Music) selalu jalan dari IP datacenter → pencarian stabil.
//   - endpoint "player" bisa kena "Sign in to confirm you're not a bot" tergantung reputasi IP.
//     Kalau kena: dicoba berurutan client paling tahan (ANDROID_VR, TV_EMBEDDED, IOS, WEB).
//     Masih gagal? Set env YT_COOKIE = nilai header Cookie browser kamu yang login YouTube,
//     lalu redeploy. (Pencarian dan lirik tetap jalan walau stream diblokir.)
// URL googlevideo terikat ke IP (ip=) yang me-resolve-nya. Kalau fetch youtubei.js keluar lewat IPv6 sedangkan axios ke googlevideo
// lewat IPv4 (atau sebaliknya) hasilnya 403 padahal IP "sama". Urutan IPv4-dulu membuat keduanya memilih alamat yang sama.
try { dns.setDefaultResultOrder('ipv4first') } catch {}
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
// Dua sesi: dengan cookie (WEB/TV/embedded, kunci bot-check) dan TANPA cookie (client mobile ANDROID_VR/IOS).
// Client mobile tidak mendukung login lewat cookie web: youtubei.js tetap mengirim Authorization SAPISIDHASH + Cookie,
// dan YouTube membalas error pada /youtubei/v1/player. Jadi mereka dipanggil lewat sesi anonim.
const ytP = { ck: null, anon: null }
function getYt(useCookie = true) {
  const k = useCookie && COOKIE ? 'ck' : 'anon'
  if (!ytP[k]) {
    ytP[k] = Innertube.create({
      cache: new UniversalCache(false), // memori saja: FS serverless read-only
      retrieve_player: true,
      ...(k === 'ck' && { cookie: COOKIE }) // kunci kalau IP Vercel di-flag YouTube
    }).catch(e => { ytP[k] = null; throw e })
  }
  return ytP[k]
}

/* ---------- mode PTERO: audio diunduh server lain (yt-dlp), Vercel cuma meneruskan ---------- */
// MUSIC_PTERO_URL=http://domain:2115 + MUSIC_PTERO_KEY=<API_KEY server Ptero>. Kalau diset, resolveStream/googlevideo tidak dipakai sama sekali.
// Server->server HTTP biasa itu boleh (mixed content cuma masalah di browser). Pencarian & lirik tetap di sini.
const PTERO = String(process.env.MUSIC_PTERO_URL || '').trim().replace(/\/+$/, '')
const PTERO_KEY = String(process.env.MUSIC_PTERO_KEY || '').trim()
const pteroOn = () => !!(PTERO && PTERO_KEY)
const pteroGet = (p, o = {}) => axios.get(PTERO + p, { validateStatus: () => true, ...o, headers: { 'x-api-key': PTERO_KEY, ...(o.headers || {}) } })
const pteroFail = (res, d, status) => {
  const b = d && typeof d === 'object' ? d : {}
  res.status(status === 503 ? 503 : 502).json({ code: b.code || 'ptero', error: b.error ? 'Server audio: ' + String(b.error).slice(0, 200) : 'Server audio tidak merespons', detail: '' })
}

/* ---------- NEXRAY: fallback downloader MP3 (tanpa login/cookie) ---------- */
// Env NEXRAY_BASE (default https://api.nexray.eu.cc); set string kosong (NEXRAY_BASE="") untuk
// mematikan lapisan nexray di Vercel. Pemanggilan dari sini cuma JSON kecil — file MP3 tidak pernah lewat Vercel.
const NEXRAY = String(process.env.NEXRAY_BASE || 'https://api.nexray.eu.cc').trim().replace(/\/+$/, '')
async function nexrayResolve(id) {
  const { data: j } = await axios.get(`${NEXRAY}/downloader/ytmp3?url=${encodeURIComponent('https://youtu.be/' + id)}`, { timeout: 25000, headers: { Accept: 'application/json' }, validateStatus: () => true })
  if (!j || j.status !== true || !j.result || !j.result.url) {
    const why = j && (j.error || j.message) ? String(j.error || j.message) : 'respon tidak valid'
    throw Object.assign(new Error(String(why).replace(/\s+/g, ' ').slice(0, 150)), { code: 'nexray' })
  }
  return j.result // { title, duration, filesize, url }
}
// Respons stream berbasis URL nexray: browser memutar/mengunduh LANGSUNG dari CDN (bukan lewat server ini).
async function nexrayStream(id) {
  try {
    const n = await nexrayResolve(id)
    console.error('[music:stream] Ptero bermasalah — lanjut nexray langsung untuk', id)
    return { url: n.url, itag: 'mp3', kbps: n.duration ? Math.max(1, Math.round(n.filesize * 8 / n.duration / 1000)) : 64, source: 'nexray', catatan: 'URL langsung dari CDN (server Ptero bermasalah; berlaku ±2 jam)' }
  } catch { return null }
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
// (UA_WEB/UA per client dipindah ke bawah: uaFor())
// Nama = nilai InnerTubeClient youtubei.js (bukan nama ClientType; 'TVHTML5_SIMPLY_EMBEDDED_PLAYER' dulu salah dan tidak dikenali).
// User-Agent sesuai client yang mengeluarkan URL (googlevideo kadang menolak/menahan kalau tidak cocok).
// Versi client dibaca dari URL stream itu sendiri (cver=), jadi tidak ketinggalan saat youtubei.js menaikkan versinya.
const UA_WEB = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
function uaFor(client, url) {
  let v = ''
  try { v = new URL(url).searchParams.get('cver') || '' } catch {}
  if (client === 'ANDROID_VR') return `com.google.android.apps.youtube.vr.oculus/${v || '1.62.27'} (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip`
  if (client === 'IOS') return `com.google.ios.youtube/${v || '20.10.4'} (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)`
  return UA_WEB
}
// Validasi URL stream sebelum dipercaya. Dulu `f.url || f.decipher()` diterima asal truthy, jadi string yang bukan URL
// (cipher mentah "s=..&url=..", path relatif, "undefined") lolos sebagai "sukses" lalu axios melempar "Invalid URL"
// di /audio dan /debug. Mengembalikan URL absolut http(s) yang sudah dinormalkan, atau null.
export function goodUrl(u) {
  if (typeof u !== 'string') return null
  u = u.trim()
  if (!u) return null
  if (u.startsWith('//')) u = 'https:' + u // protocol-relative
  // cipher mentah yang bocor ke f.url: ambil parameter url= kalau ada (tanpa tanda tangan s= tidak bisa dipakai → ditolak di bawah)
  if (!/^https?:\/\//i.test(u) && /(^|&)url=/.test(u)) { try { u = new URLSearchParams(u).get('url') || '' } catch { return null } }
  try {
    const x = new URL(u)
    if (x.protocol !== 'https:' && x.protocol !== 'http:') return null
    if (!x.hostname || !x.hostname.includes('.')) return null
    // URL googlevideo yang valid selalu bawa parameter signature/expire; tanpa itu pasti 403
    if (/googlevideo\.com$/i.test(x.hostname) && !x.searchParams.has('expire') && !x.searchParams.has('sig') && !x.searchParams.has('lsig')) return null
    return x.toString()
  } catch { return null }
}
// Bentuk URL yang ditolak, untuk diagnosa (tanpa isi query/tanda tangan)
const shape = u => u == null ? String(u) : (typeof u + ' len=' + String(u).length + ' ' + String(u).split(/[?&]/)[0].slice(0, 40).replace(/[^\w:/.\-=%]/g, '?'))
// Ringkas pesan error youtubei.js: buang URL (makan tempat, status HTTP-nya malah terpotong) dan ambil alasan dari body kalau ada.
function errNote(e) {
  let m = String(e && e.message || e).replace(/https?:\/\/\S+/g, '<url>'), b = ''
  const raw = e && typeof e.info === 'string' ? e.info : ''
  if (raw) { try { b = JSON.parse(raw).error.message } catch { b = raw.replace(/\s+/g, ' ').slice(0, 60) } }
  return (m + (b ? ' — ' + String(b).slice(0, 60) : '')).slice(0, 140)
}
// Satu percobaan satu client. Mengembalikan { ok } atau { why } — SELALU dengan alasan, supaya kegagalan tidak lagi disamakan dengan "bot check".
//   bot     = YouTube bilang "Sign in to confirm you're not a bot" (benar-benar IP/reputasi)
//   login   = LOGIN_REQUIRED karena hal lain (client TV/embedded memang minta login, umur, dll) — BUKAN masalah IP
//   nourl   = format audio ada tapi tanpa URL (eksperimen SABR YouTube yang acak per-sesi; ulang sering langsung beres)
//   decipher= URL ada tapi gagal diurai (player JS berubah -> npm update youtubei.js)
async function tryClient(yt, id, client) {
  const info = await yt.getBasicInfo(id, { client }) // opsi objek: kalau string dilempar langsung, client diabaikan dan selalu WEB
  const ps = info.playability_status || {}
  if (ps.status !== 'OK') return { why: ps.status === 'LOGIN_REQUIRED' ? (/bot/i.test(ps.reason || '') ? 'bot' : 'login') : 'unplayable', note: ps.status + (ps.reason ? ': ' + String(ps.reason).slice(0, 80) : '') }
  const fm = (info.streaming_data && info.streaming_data.adaptive_formats || []).filter(f => f.has_audio && !f.has_video)
    // m4a/AAC dulu (jalan di semua browser, termasuk Safari), lalu bitrate tertinggi
    .sort((a, b) => (/mp4/.test(b.mime_type || '') - /mp4/.test(a.mime_type || '')) || ((b.bitrate || 0) - (a.bitrate || 0)))
  if (!fm.length) return { why: 'noformat', note: 'tidak ada format audio' }
  let err = '', bad = ''
  for (const f of fm) {
    let url = goodUrl(f.url) // URL langsung dari respons (client Android/iOS)
    if (!url) {
      let raw = null
      try { raw = f.decipher(yt.session.player) } catch (e) { err = e.message } // client WEB/TV: URL harus di-decipher dulu
      url = goodUrl(raw)
      if (!url && (raw || f.url)) bad = bad || shape(raw || f.url)
    }
    if (url) return { ok: { url, ua: uaFor(client, url), mime: String(f.mime_type || 'audio/mp4').split(';')[0], len: Number(f.content_length) || Number((() => { try { return new URL(url).searchParams.get('clen') } catch { return 0 } })()) || 0, itag: f.itag, kbps: Math.round((f.bitrate || 0) / 1000), client } }
  }
  if (bad) return { why: 'badurl', note: 'URL bukan URL valid: ' + bad }
  return err ? { why: 'decipher', note: err.slice(0, 80) } : { why: 'nourl', note: fm.length + ' format tanpa URL' }
}
// [client, pakai cookie?, jumlah percobaan]. Mobile = anonim; TV/embedded/WEB = bercookie. ANDROID_VR diulang (SABR acak per-sesi).
const STEPS = [['ANDROID_VR', false, 3], ['TV_SIMPLY', true, 1], ['IOS', false, 1], ['WEB_EMBEDDED', true, 1], ['WEB', true, 1]]
const FAIL = {
  bot: { code: 'bot_check', error: 'YouTube menolak dari IP server ini (bot check). Set env YT_COOKIE (Cookie browser yang login YouTube) lalu redeploy.' },
  nourl: { code: 'sabr', error: 'YouTube mengirim format tanpa URL untuk lagu ini (eksperimen SABR). Ini bukan soal IP — coba putar lagi sebentar lagi.' },
  request: { code: 'request', error: 'YouTube menolak permintaan player dari semua client (lihat detail untuk status HTTP-nya). Cek YT_COOKIE (mungkin kedaluwarsa) atau npm update youtubei.js.' },
  badurl: { code: 'badurl', error: 'YouTube/decipher menghasilkan URL stream yang rusak (bukan URL valid). Biasanya player YouTube berubah: jalankan npm update youtubei.js lalu deploy ulang.' },
  decipher: { code: 'decipher', error: 'Gagal mengurai URL stream (player YouTube berubah). Jalankan npm update youtubei.js lalu deploy ulang.' }
}
// Cari URL stream terbaik untuk satu lagu. Hasil di-cache DI MEMORI instance (bukan Redis): URL terikat ke IP instance yang
// mencarinya, jadi URL dari instance lain tidak berguna. force=true = abaikan cache (URL sudah ditolak googlevideo).
const sc = new Map(), inflight = new Map()
async function resolveStream(id, force = false) {
  const hit = sc.get(id)
  if (!force && hit && Date.now() < hit.exp) return hit.s
  if (inflight.has(id)) return inflight.get(id)
  const p = (async () => {
    const log = [] // "CLIENT:alasan" per percobaan
    const ses = {} // sesi dibuat sekali per jenis (bercookie/anonim)
    for (const [client, ck, tries] of STEPS) {
      const label = client + (COOKIE && ck ? '+ck' : '')
      const kind = ck && COOKIE ? 'ck' : 'anon'
      if (!ses[kind]) {
        try { ses[kind] = await getYt(ck) } catch (e) {
          console.error('[music:stream] Innertube gagal dibuat:', e.message)
          ses[kind] = null; log.push(label + ':session(' + errNote(e) + ')'); continue
        }
      }
      if (!ses[kind]) { log.push(label + ':session(sesi gagal dibuat)'); continue }
      for (let n = 0; n < tries; n++) {
        let t
        try { t = await tryClient(ses[kind], id, client) } catch (e) { t = { why: 'error', note: errNote(e) } }
        if (t.ok) {
          if (sc.size > 200) sc.clear()
          t.ok.tried = log.slice() // client yang gagal sebelum yang ini jalan (ditampilkan di /debug)
          t.ok.client = label
          sc.set(id, { s: t.ok, exp: Date.now() + 90 * 60e3 }) // 90 menit; URL aslinya ±6 jam
          return t.ok
        }
        log.push(label + ':' + t.why + (t.note ? '(' + t.note + ')' : ''))
        if (t.why !== 'nourl') break // hanya "tanpa URL" yang layak diulang
      }
    }
    console.error('[music:resolve]', id, log.join(' | '))
    const has = w => log.some(l => l.includes(':' + w))
    if (log.length && log.every(l => /:session\(/.test(l))) return { fail: { status: 502, code: 'session', error: 'Sesi YouTube gagal dibuat, coba lagi.', detail: log.join(' | ').slice(0, 900) } }
    const f = has('bot') ? FAIL.bot : has('nourl') ? FAIL.nourl : has('badurl') ? FAIL.badurl : has('decipher') ? FAIL.decipher : has('error') ? FAIL.request : { code: 'no_streams', error: 'Lagu ini tidak bisa diputar (tidak ada format audio).' }
    return { fail: { status: 503, ...f, detail: log.join(' | ').slice(0, 900) } }
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
  if (pteroOn()) { // siapkan file di server Ptero dulu, supaya kegagalan yt-dlp muncul di sini (bukan diam-diam di <audio>)
    let r = null
    try {
      r = await pteroGet('/prefetch?id=' + encodeURIComponent(id), { timeout: 55000 })
    } catch (e) {
      // Server Ptero tidak bisa dihubungi (mati / restart panel) — musik tetap bisa jalan:
      // browser memutar MP3 LANGSUNG dari CDN nexray (bandwidth Vercel & Ptero tetap nol).
      const n = NEXRAY ? await nexrayStream(id) : null
      if (n) return res.json(n)
      return res.status(502).json({ code: 'ptero', error: 'Server audio tidak bisa dihubungi (' + (e.code || e.message) + ')' })
    }
    if (r.status !== 200) {
      // Ptero hidup tapi gagal menyiapkan file (mis. cookie mati DAN fallback nexray di Ptero juga gagal).
      // Upaya terakhir dari sini — kadang jaringan Ptero ke CDN bermasalah padahal Vercel bisa.
      const n = NEXRAY ? await nexrayStream(id) : null
      if (n) return res.json(n)
      return pteroFail(res, r.data, r.status)
    }
    return res.json({ url: '/api/music/audio?id=' + encodeURIComponent(id) + '&clientId=' + encodeURIComponent(cid), itag: 140, kbps: 128 })
  }
  const s = await resolveStream(id)
  if (s.fail) return res.status(s.fail.status).json({ code: s.fail.code, error: s.fail.error, detail: s.fail.detail })
  // MUSIC_DIRECT=1: kembalikan URL googlevideo langsung (hanya benar kalau server dan pemutar satu IP, mis. npm start lokal)
  const url = process.env.MUSIC_DIRECT === '1' ? s.url : '/api/music/audio?id=' + encodeURIComponent(id) + '&clientId=' + encodeURIComponent(cid)
  res.json({ url, itag: s.itag, kbps: s.kbps })
})

/* ---------- endpoint: URL download langsung (nexray; bandwidth server nol) ---------- */
// Untuk kebutuhan "download doang": JSON berisi URL MP3 di CDN nexray. Browser/user mengunduh LANGSUNG
// dari CDN — bukan lewat Vercel, bukan lewat Ptero (yang lewat server cuma JSON kecil ini).
// CDN mengirim Content-Disposition: attachment, jadi membuka URL itu langsung memicu unduhan dengan
// nama file rapi. URL bertanda tangan (s=) dan berlaku ±2 jam — berikan ke user untuk langsung dipakai.
// Urutan: lewat Ptero /direct dulu (satu jaringan dengan /audio); kalau Ptero mati atau masih
// menjalankan server.js versi lama (404) -> panggil nexray langsung dari Vercel.
r.get('/api/music/direct', async (req, res) => {
  const id = String(req.query.id || '')
  const cid = String(req.query.clientId || '')
  if (!/^[\w-]{6,20}$/.test(id)) return res.status(400).json({ error: 'ID lagu tidak valid' })
  if (!(await allow(cid, 20, 60))) return res.status(429).json({ error: 'Terlalu sering, tunggu sebentar' })
  if (!NEXRAY) return res.status(501).json({ error: 'nexray dimatikan (set NEXRAY_BASE di env Vercel)' })
  res.set('Cache-Control', 'no-store')
  if (pteroOn()) {
    try {
      const r = await pteroGet('/direct?id=' + encodeURIComponent(id), { timeout: 30000 })
      if (r.status === 200 && r.data && r.data.url) {
        // fallback yt-dlp di Ptero mengembalikan url relatif /download?... -> absolutkan ke Ptero
        if (typeof r.data.url === 'string' && r.data.url.startsWith('/')) r.data.url = PTERO + r.data.url
        return res.json(r.data)
      }
      // 404 = server.js di Ptero versi lama (belum ada /direct); apa pun alasannya, coba dari sini
    } catch { /* Ptero tidak bisa dihubungi -> lanjut minta langsung dari Vercel */ }
  }
  try {
    const n = await nexrayResolve(id)
    res.json({ ok: true, id, source: 'nexray', title: n.title ?? null, duration: n.duration ?? null, filesize: n.filesize ?? null, url: n.url, url_sementara: true })
  } catch (e) {
    res.status(502).json({ code: e.code || 'nexray', error: 'URL download tidak bisa didapat (' + String(e.message).slice(0, 150) + ')' })
  }
})

/* ---------- endpoint: info + daftar unduhan YouTube (proxy ke /info server Ptero) ---------- */
// Metadata (judul, channel, durasi, views, thumbnail) + daftar kualitas audio & video beserta ukuran.
// Tiap kualitas punya "url" yang menunjuk LANGSUNG ke /download di server Ptero (bertoken 6 jam) —
// browser mengunduh langsung dari Ptero, bandwidth Vercel nol. Kalau url yang datang masih relatif
// (PUBLIC_URL belum diset di Ptero), diabsolutkan di sini pakai MUSIC_PTERO_URL.
r.get('/api/music/info', async (req, res) => {
  const id = String(req.query.id || '')
  const url = String(req.query.url || '')
  const cid = String(req.query.clientId || '')
  if (!/^[\w-]{6,20}$/.test(id) && !url) return res.status(400).json({ error: 'ID lagu tidak valid' })
  if (!(await allow(cid, 20, 60))) return res.status(429).json({ error: 'Terlalu sering, tunggu sebentar' })
  if (!pteroOn()) return res.status(501).json({ error: 'fitur info butuh MUSIC_PTERO_URL (endpoint /info ada di server Ptero)' })
  res.set('Cache-Control', 'no-store')
  try {
    const q = new URLSearchParams()
    if (id) q.set('id', id); else q.set('url', url)
    const r = await pteroGet('/info?' + q.toString(), { timeout: 60000 })
    if (r.status !== 200) return pteroFail(res, r.data, r.status)
    const d = r.data && r.data.data
    if (d && d.downloads) {
      const abs = u => (typeof u === 'string' && u.startsWith('/')) ? PTERO + u : u
      for (const x of (d.downloads.mp3 || [])) x.url = abs(x.url)
      for (const x of (d.downloads.mp4 || [])) x.url = abs(x.url)
    }
    res.json(r.data)
  } catch (e) { return res.status(502).json({ code: 'ptero', error: 'Server audio tidak bisa dihubungi (' + (e.code || e.message) + ')' }) }
})

/* ---------- endpoint: audio (diteruskan dari googlevideo per potongan, mendukung Range) ---------- */
const CHUNK = 1024 * 1024
// Satu permintaan ke googlevideo. mode 'h' = header Range (standar), 'q' = parameter &range=a-b di URL tanpa header Range
// (cadangan: sebagian URL menolak/mengabaikan header Range setelah potongan pertama).
function upstream(s, start, end, mode) {
  let url = s.url
  if (mode === 'q') { const x = new URL(url); x.searchParams.set('range', start + '-' + end); url = x.toString() }
  const headers = { 'User-Agent': s.ua, 'Accept-Encoding': 'identity' }
  if (mode === 'h') headers.Range = `bytes=${start}-${end}`
  return axios.get(url, { responseType: 'stream', headers, timeout: 12000, maxRedirects: 3, validateStatus: () => true, decompress: false })
}
// Rentang byte yang BENAR-BENAR dikirim upstream (a..b dari total). ok = sama dengan yang diminta (start). Tanpa ini, balasan 200
// (Range diabaikan) dulu dilabeli \"bytes 0-..\" padahal browser minta potongan berikutnya → browser berhenti setelah potongan pertama.
function span(up, s, start, mode) {
  const cr = /bytes (\d+)-(\d+)\/(\d+|\*)/.exec(String(up.headers['content-range'] || ''))
  const clen = +up.headers['content-length'] || 0
  let a, b, total
  if (cr) { a = +cr[1]; b = +cr[2]; total = cr[3] !== '*' ? +cr[3] : s.len || 0 }
  else if (mode === 'q') { a = start; b = start + clen - 1; total = s.len || 0 } // &range= membalas 200 berisi tepat potongan itu
  else { a = 0; b = clen - 1; total = clen || s.len || 0 }                     // 200 tanpa Content-Range = isi penuh dari byte 0
  return { a, b, total, ok: (up.status === 206 || up.status === 200) && b >= a && a === start }
}
// Ambil potongan [start..end]: coba header Range, lalu &range=. Mengembalikan { up, sp } atau { tried:[...] }.
async function fetchPart(s, start, end) {
  const tried = []
  for (const mode of ['h', 'q']) {
    let up
    try { up = await upstream(s, start, end, mode) } catch (e) { tried.push(mode + ':' + (e.code || e.message || 'err').toString().slice(0, 30)); continue }
    if (up.status !== 206 && up.status !== 200) { tried.push(mode + ':' + up.status); up.data.destroy(); continue }
    const sp = span(up, s, start, mode)
    if (!sp.ok) { tried.push(mode + ':' + up.status + ' rentang ' + sp.a + '-' + sp.b + ' (minta ' + start + ')'); up.data.destroy(); continue }
    return { up, sp, mode }
  }
  return { tried }
}
r.get('/api/music/audio', async (req, res) => {
  const id = String(req.query.id || '')
  const cid = String(req.query.clientId || '')
  if (!/^[\w-]{6,20}$/.test(id)) return res.status(400).json({ error: 'ID lagu tidak valid' })
  if (!(await allow('a' + cid, 600, 60))) return res.status(429).json({ error: 'Terlalu sering, tunggu sebentar' })
  if (pteroOn()) { // teruskan Range browser apa adanya ke server Ptero (yang melayani 206 dari file lokal)
    try {
      const h = {}
      if (req.headers.range) h.Range = String(req.headers.range)
      const up = await pteroGet('/audio?id=' + encodeURIComponent(id), { responseType: 'stream', headers: h, timeout: 60000, decompress: false })
      if (up.status !== 200 && up.status !== 206) {
        let body = ''; await new Promise(ok => { up.data.on('data', d => { if (body.length < 2000) body += d }); up.data.on('end', ok); up.data.on('error', ok) })
        let j = null; try { j = JSON.parse(body) } catch {}
        if (up.status === 416) return res.status(416).set('Content-Range', up.headers['content-range'] || '').end()
        return pteroFail(res, j, up.status)
      }
      const H = { 'Content-Type': up.headers['content-type'] || 'audio/mp4', 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=3600' }
      for (const k of ['content-length', 'content-range']) if (up.headers[k]) H[k] = up.headers[k]
      res.status(up.status).set(H)
      req.on('close', () => up.data.destroy())
      up.data.on('error', () => res.destroy())
      return up.data.pipe(res)
    } catch (e) { return res.status(502).json({ code: 'ptero', error: 'Server audio tidak bisa dihubungi (' + (e.code || e.message) + ')' }) }
  }
  let detail = ''
  for (let attempt = 0; attempt < 2; attempt++) {
    const s = await resolveStream(id, attempt > 0) // percobaan ke-2: cari URL baru (URL lama ditolak / instance lain)
    if (s.fail) return res.status(s.fail.status).json({ code: s.fail.code, error: s.fail.error, detail: s.fail.detail })
    // Range dari browser: "bytes=a-b", "bytes=a-", atau "bytes=-n" (n byte terakhir).
    // TANPA Range (buka URL langsung / unduh) = kirim seluruh berkas sebagai 200, bukan cuma 1 MB.
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''))
    const ranged = !!(m && (m[1] || m[2]))
    let start = 0, end = CHUNK - 1
    if (ranged) {
      if (m[1]) { start = +m[1]; end = m[2] ? +m[2] : start + CHUNK - 1 }
      else if (s.len) { start = Math.max(0, s.len - +m[2]); end = s.len - 1 }
      end = Math.min(end, start + CHUNK - 1)
    } else end = s.len ? s.len - 1 : 8 * CHUNK - 1
    if (s.len) { if (start >= s.len) return res.status(416).set('Content-Range', 'bytes */' + s.len).end(); end = Math.min(end, s.len - 1) }
    const got = await fetchPart(s, start, end)
    if (!got.up) {
      detail = got.tried.join(' ')
      console.error('[music:audio]', id, 'start=' + start, detail)
      if (/\b(h|q):(403|404|410)\b/.test(detail)) sc.delete(id) // URL ditolak: ulangi dengan URL baru
      continue
    }
    const { up, sp } = got
    res.status(ranged ? 206 : 200).set({
      'Content-Type': s.mime, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=3600',
      'Content-Length': String(sp.b - sp.a + 1),
      ...(ranged && { 'Content-Range': `bytes ${sp.a}-${sp.b}/${sp.total || '*'}` })
    })
    req.on('close', () => up.data.destroy())
    up.data.on('error', () => res.destroy())
    up.data.pipe(res)
    return
  }
  res.status(502).json({ error: 'Audio tidak bisa diambil, coba lagi', detail: detail.slice(0, 200) })
})

/* ---------- endpoint: diagnosa (buka di browser: /api/music/debug) ---------- */
// Memakai resolveStream() yang sama dengan pemutaran sungguhan, lalu menguji googlevideo dengan UA & URL yang sama:
// potongan 1 (byte 0) DAN potongan 2 (byte 1 MB, yang dulu diam-diam gagal) lewat header Range maupun &range=.
async function probe(s, start, mode) {
  const t0 = Date.now()
  try {
    const up = await upstream(s, start, start + CHUNK - 1, mode)
    const sp = span(up, s, start, mode)
    let n = 0
    if (up.status === 206 || up.status === 200) await new Promise((ok, no) => { up.data.on('data', d => { n += d.length }); up.data.on('end', ok); up.data.on('error', no) })
    else up.data.destroy()
    return { status: up.status, rentang: sp.a + '-' + sp.b + '/' + (sp.total || '?'), sesuai_permintaan: sp.ok, byte: n, ms: Date.now() - t0 }
  } catch (e) { return { error: e.code || e.message, ms: Date.now() - t0 } }
}
r.get('/api/music/debug', async (req, res) => {
  const id = /^[\w-]{6,20}$/.test(String(req.query.id || '')) ? String(req.query.id) : 'dQw4w9WgXcQ'
  if (!(await allow('dbg' + String(req.query.clientId || req.ip || ''), 6, 60))) return res.status(429).json({ error: 'Terlalu sering' })
  res.set('Cache-Control', 'no-store')
  if (pteroOn()) { // mode Ptero: cek koneksi, versi yt-dlp/ffmpeg, dan unduhan + Range sungguhan
    const out = { mode: 'ptero', server: PTERO.replace(/^(https?:\/\/)([^:/]+)/, '$1***'), id, nexray_dari_vercel: null }
    if (NEXRAY) { // dites terpisah dari Ptero: ini jalur penyelamat kalau Ptero mati
      const t0 = Date.now()
      try { const n = await nexrayResolve(id); out.nexray_dari_vercel = { ok: true, ms: Date.now() - t0, title: n.title, filesize: n.filesize } }
      catch (e) { out.nexray_dari_vercel = { ok: false, error: String(e.message).slice(0, 120) } }
    }
    try {
      const v = await pteroGet('/version', { timeout: 8000 }); out.versi = v.status === 200 ? v.data : { status: v.status }
      const t0 = Date.now(); const p = await pteroGet('/prefetch?id=' + encodeURIComponent(id), { timeout: 55000 }); out.prefetch = { status: p.status, ms: Date.now() - t0, ...(typeof p.data === 'object' ? p.data : {}) }
      const a = await pteroGet('/audio?id=' + encodeURIComponent(id), { headers: { Range: 'bytes=1048576-1048675' }, responseType: 'arraybuffer', timeout: 15000 })
      out.range_potongan_2 = { status: a.status, content_range: a.headers['content-range'] || null, byte: a.data ? a.data.length : 0 }
      out.kesimpulan = p.status === 200 && a.status === 206 ? 'OK: server Ptero mengunduh dan melayani Range (seek jalan)' : 'Gagal: lihat prefetch / range_potongan_2'
    } catch (e) { out.kesimpulan = 'Server Ptero tidak bisa dihubungi: ' + (e.code || e.message) }
    return res.json(out)
  }
  const out = { id, cookie: { diset: !!COOKIE, jumlah: COOKIE ? COOKIE.split('; ').length : 0, ada_SAPISID: /(^|; )(__Secure-3PAPISID|SAPISID)=/.test(COOKIE) } }
  const s = await resolveStream(id, true)
  if (s.fail) { out.hasil = s.fail.code; out.pesan = s.fail.error; out.detail = s.fail.detail; out.kesimpulan = s.fail.code === 'bot_check' ? 'BOT CHECK: butuh YT_COOKIE' : 'Gagal: ' + s.fail.code + ' (lihat detail)'; return res.json(out) }
  out.client = s.client; out.itag = s.itag; out.ua = s.ua
  out.gagal_sebelumnya = s.tried && s.tried.length ? s.tried : 'tidak ada (client pertama langsung berhasil)'
  try { const u = new URL(s.url); out.url_bentuk = { host: u.hostname, path: u.pathname, param: [...u.searchParams.keys()].join(',').slice(0, 400) } } catch { out.url_bentuk = 'TIDAK VALID: ' + shape(s.url) }
  try {
    const u = new URL(s.url), q = u.searchParams
    out.param_penting = { c: q.get('c'), clen: q.get('clen'), ratebypass: q.get('ratebypass'), rqh: q.get('rqh'), source: q.get('source'), ada_pot: q.has('pot'), ada_n: q.has('n'), ada_sig: q.has('sig') || q.has('lsig') }
  } catch {}
  out.panjang_file = s.len
  out.mime = s.mime
  const full = s.len || 3 * CHUNK
  out.potongan_1 = { header: await probe(s, 0, 'h') }
  if (full > CHUNK) {
    out.potongan_2 = { header: await probe(s, CHUNK, 'h'), query_range: await probe(s, CHUNK, 'q') }
  }
  const ok = c => c && (c.status === 206 || c.status === 200) && c.sesuai_permintaan && c.byte >= Math.min(CHUNK, Math.max(0, full - 0)) * 0.95
  const p1 = out.potongan_1.header, p2 = out.potongan_2
  if (!ok(p1) && !(p1 && p1.sesuai_permintaan && p1.byte > 0 && full <= CHUNK)) out.kesimpulan = 'Potongan 1 (byte 0) gagal: ' + JSON.stringify(p1)
  else if (!p2) out.kesimpulan = 'OK: file <= 1 MB, satu potongan cukup'
  else if (ok(p2.header)) out.kesimpulan = 'OK: potongan 1 dan 2 sampai lewat header Range (' + p2.header.ms + ' ms)'
  else if (ok(p2.query_range)) out.kesimpulan = 'Potongan 2 GAGAL lewat header Range tapi JALAN lewat &range= → handler /audio otomatis memakai cadangan ini'
  else out.kesimpulan = 'Potongan 2 GAGAL di kedua cara (header Range dan &range=): YouTube hanya melayani ±1 MB pertama untuk URL ini. Lihat param_penting (ada_pot=false → butuh PO token) — ganti client / YT_COOKIE / update youtubei.js'
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
