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
    if (url) return { ok: { url, ua: uaFor(client, url), mime: String(f.mime_type || 'audio/mp4').split(';')[0], len: Number(f.content_length) || 0, itag: f.itag, kbps: Math.round((f.bitrate || 0) / 1000), client } }
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
  const s = await resolveStream(id)
  if (s.fail) return res.status(s.fail.status).json({ code: s.fail.code, error: s.fail.error, detail: s.fail.detail })
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
    if (s.fail) return res.status(s.fail.status).json({ code: s.fail.code, error: s.fail.error, detail: s.fail.detail })
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
// Memakai resolveStream() yang sama dengan pemutaran sungguhan, lalu menguji googlevideo dengan UA & URL yang sama.
r.get('/api/music/debug', async (req, res) => {
  const id = /^[\w-]{6,20}$/.test(String(req.query.id || '')) ? String(req.query.id) : 'dQw4w9WgXcQ'
  if (!(await allow('dbg' + String(req.query.clientId || req.ip || ''), 6, 60))) return res.status(429).json({ error: 'Terlalu sering' })
  res.set('Cache-Control', 'no-store')
  const out = { id, cookie: { diset: !!COOKIE, jumlah: COOKIE ? COOKIE.split('; ').length : 0, ada_SAPISID: /(^|; )(__Secure-3PAPISID|SAPISID)=/.test(COOKIE) } }
  const s = await resolveStream(id, true)
  if (s.fail) { out.hasil = s.fail.code; out.pesan = s.fail.error; out.detail = s.fail.detail; out.kesimpulan = s.fail.code === 'bot_check' ? 'BOT CHECK: butuh YT_COOKIE' : 'Gagal: ' + s.fail.code + ' (lihat detail)'; return res.json(out) }
  out.client = s.client; out.itag = s.itag; out.ua = s.ua
  out.gagal_sebelumnya = s.tried && s.tried.length ? s.tried : 'tidak ada (client pertama langsung berhasil)'
  try { const u = new URL(s.url); out.url_bentuk = { host: u.hostname, path: u.pathname, param: [...u.searchParams.keys()].join(',').slice(0, 120) } } catch { out.url_bentuk = 'TIDAK VALID: ' + shape(s.url) }
  const t = await axios.get(s.url, { headers: { Range: 'bytes=0-1', 'User-Agent': s.ua, 'Accept-Encoding': 'identity' }, timeout: 8000, validateStatus: () => true, responseType: 'arraybuffer' }).catch(e => ({ status: 'error: ' + e.message }))
  out.googlevideo_dari_server = t.status
  out.kesimpulan = t.status === 206 ? 'OK: server bisa mengambil audio' : t.status === 403 ? 'googlevideo 403: URL ditolak (IP/IPv6 tidak cocok atau butuh PO token)' : /Invalid URL/i.test(String(t.status)) ? 'URL stream tidak valid (lihat url_bentuk)' : 'Gagal, status googlevideo ' + t.status
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
