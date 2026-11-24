// ===== Tes: import lagu lewat link YouTube + library permanen di server audio (Ptero) =====
// Dua bagian, tanpa jaringan luar:
//   A) SERVER AUDIO (server.js v1.4 di download/server-audio-v1.3) — dijalankan dengan yt-dlp TIRUAN
//      (stub binary yang menulis file 300 KB / memuntahkan JSON metadata). Diuji end-to-end:
//      /save (impor permanen), /library, /remove, /audio prioritas permanen + Range, kuota
//      LIB_MAX_MB, salin-dari-cache, dan pemulihan unduhan yang terputus.
//   A2) SERVER AUDIO v1.4 dengan nexray TIRUAN + yt-dlp yang selalu kena limit: /save&via=link
//      wajib nexray dulu (metadata & audio, tanpa menyentuh yt-dlp), cooldown yt-dlp setelah
//      bot-check, dan file sampah < MIN_FILE_KB (contoh nyata: 637 B) dipulihkan otomatis.
//   B) ROUTER VERCEL (lib/music.js) — dengan server Ptero TIRUAN. Diuji: parser link ytId,
//      /api/music/import, /api/music/library, /api/music/library/remove, kasus tanpa Ptero (501),
//      plus parser ytLink di public/music.js (diekstrak dari sumber aslinya, bukan disalin).
// Jalankan: node scripts/music-import-test.mjs  (atau npm run music:test)

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SERVER_SRC = path.resolve(ROOT, '../download/server-audio-v1.4/server.js')
const sleep = ms => new Promise(r => setTimeout(r, ms))

/* bersihkan env yang bisa mengganggu (Redis/Upstash/Ptero) sebelum modul dibaca */
for (const k of Object.keys(process.env)) if (/^(MUSIC_PTERO|UPSTASH|KV_|REDIS)/i.test(k)) delete process.env[k]

let pass = 0, fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok -', name) }
  else { fail++; console.log('  GAGAL -', name, extra ? '-> ' + extra : '') }
}
const get = (port, p, headers = {}) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path: p, headers }, r => {
    let b = Buffer.alloc(0)
    r.on('data', c => { b = Buffer.concat([b, c]) })
    r.on('end', () => { let j = null; try { j = JSON.parse(b.toString()) } catch {}; resolve({ status: r.statusCode, headers: r.headers, body: b, json: j }) })
  }).on('error', reject)
})
const waitPort = async (port, ms = 8000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) { try { await get(port, '/health'); return true } catch { await sleep(150) } }
  return false
}
/* tunggu kondisi (polling singkat) */
const waitFor = async (fn, ms = 15000, step = 250) => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(step) }
  return await fn()
}

/* ================================================================ */
console.log('== A. server audio Ptero (server.js v1.3) dengan yt-dlp tiruan ==')
{
  if (!fs.existsSync(SERVER_SRC)) { console.log('  (dilewati: ' + SERVER_SRC + ' tidak ada)') }
  else {
    /* salin server.js ke dalam repo (folder sementara): node_modules repo menyediakan express.
       Ekstensi .cjs karena package.json repo bertipe module (server.js asli CJS — di Ptero ia tetap .js). */
    const tmp = fs.mkdtempSync(path.join(ROOT, '.musimp-'))
    fs.copyFileSync(SERVER_SRC, path.join(tmp, 'server.cjs'))
    const SERVER_JS = path.join(tmp, 'server.cjs')
    const CACHE = path.join(tmp, 'cache'), LIB = path.join(tmp, 'music')
    fs.mkdirSync(CACHE); fs.mkdirSync(LIB)

    /* stub yt-dlp: --version, --dump-single-json (metadata), mode unduh (-o) menulis 300 KB */
    const stub = path.join(tmp, 'ytdlp-stub.mjs')
    fs.writeFileSync(stub, `#!/usr/bin/env node
import fs from 'node:fs'
const a = process.argv.slice(2)
if (a.includes('--version')) { console.log('2026.11.24-test'); process.exit(0) }
if (a.includes('--dump-single-json')) {
  const m = /v=([\\w-]{11})/.exec(a.join(' ')) || []
  const id = m[1] || 'unknown00000'
  console.log(JSON.stringify({ id, title: 'Lagu Uji ' + id, channel: 'Channel Uji', uploader: 'Channel Uji', duration: 123, thumbnail: 'https://i.ytimg.com/vi/' + id + '/hqdefault.jpg', formats: [] }))
  process.exit(0)
}
const o = a.indexOf('-o')
if (o >= 0) { fs.writeFileSync(a[o + 1], Buffer.alloc(300 * 1024, 7)); process.exit(0) }
process.exit(1)
`)
    fs.chmodSync(stub, 0o755)

    const PORT = 21000 + Math.floor(Math.random() * 2000)
    const env = {
      ...process.env,
      API_KEY: 'kunci-a', PORT: String(PORT), YTDLP_BIN: stub,
      CACHE_DIR: CACHE, LIB_DIR: LIB, LIB_MAX_MB: '1', // kuota 1 MB = 3 file stub (300 KB) muat, file ke-4 ditolak
      NEXRAY_FALLBACK: '0', YTDL_UPDATE_HOURS: '0', MAX_PARALLEL: '2', PROVIDER_ORDER: 'ytdlp'
    }
    const proc = spawn(process.execPath, [SERVER_JS], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let logS = ''
    proc.stdout.on('data', d => { logS += d })
    proc.stderr.on('data', d => { logS += d })
    try {
      const up = await waitPort(PORT)
      ok('server menyala', up)
      if (!up) { console.log('  --- log server ---\n' + logS.slice(0, 2000)); throw new Error('server tidak menyala') }
      const H = { 'x-api-key': 'kunci-a' }
      const A = 'AAAAAAAAAAA', B = 'BBBBBBBBBBB', C = 'CCCCCCCCCCC', D = 'DDDDDDDDDDD', E = 'EEEEEEEEEEE', F = 'FFFFFFFFFFF', X = 'XXXXXXXXXXX'

      /* 1. impor pertama: metadata + unduhan di latar */
      let r = await get(PORT, '/save?id=' + A, H)
      ok('/save A balas 200 ok', r.status === 200 && r.json && r.json.ok === true, JSON.stringify(r.json))
      ok('/save A tidak menunggu unduhan (ready:false)', r.json && r.json.ready === false)
      ok('/save A bawa metadata lagu', r.json && r.json.song && r.json.song.title === 'Lagu Uji ' + A && r.json.song.artist === 'Channel Uji', JSON.stringify(r.json && r.json.song))

      /* 2. idempoten: tunggu file lalu save ulang */
      ok('file A muncul di library permanen', await waitFor(() => !!fs.existsSync(path.join(LIB, A + '.m4a'))))
      r = await get(PORT, '/save?id=' + A, H)
      ok('/save A lagi = sudah_ada', r.status === 200 && r.json && r.json.sudah_ada === true && r.json.ready === true)

      /* 3. /library */
      r = await get(PORT, '/library', H)
      ok('/library menampilkan 1 lagu status ok', r.json && r.json.jumlah === 1 && r.json.songs[0].id === A && r.json.songs[0].status === 'ok', JSON.stringify(r.json))
      ok('/library melaporkan total + kuota', r.json && r.json.total_bytes === 300 * 1024 && r.json.kuota_bytes === 1024 * 1024)

      /* 4. /audio dari permanen: Range + header sumber */
      r = await get(PORT, '/audio?id=' + A, { ...H, Range: 'bytes=0-99' })
      ok('/audio A = 206 permanen', r.status === 206 && r.headers['x-source'] === 'permanen')
      ok('/audio A Range 100 byte', r.body.length === 100 && r.headers['content-length'] === '100')

      /* 5. /prefetch dari permanen */
      r = await get(PORT, '/prefetch?id=' + A, H)
      ok('/prefetch A = permanen', r.json && r.json.ok === true && r.json.source === 'permanen' && r.json.bytes === 300 * 1024, JSON.stringify(r.json))

      /* 6. isi sampai hampir kuota: B dan C masuk (total 900 KB < 1 MB) */
      await get(PORT, '/save?id=' + B, H); await get(PORT, '/save?id=' + C, H)
      ok('B & C tersimpan', await waitFor(() => [A, B, C].every(id => fs.existsSync(path.join(LIB, id + '.m4a')))))

      /* 7. D melewati kuota (900 + 300 > 1024 KB): ditolak setelah unduhan */
      r = await get(PORT, '/save?id=' + D, H)
      const dDitolak = (r.status === 507) || (r.status === 200 && await waitFor(() => {
        try { return JSON.parse(fs.readFileSync(path.join(LIB, D + '.json'), 'utf8')).status === 'error' } catch { return false }
      }))
      ok('D ditolak kuota (507 atau status error)', dDitolak)
      ok('file D TIDAK ada di library', !fs.existsSync(path.join(LIB, D + '.m4a')))

      /* 8. hapus A lalu putar: jatuh ke cache biasa (unduh ulang via stub) */
      r = await get(PORT, '/remove?id=' + A, H)
      ok('/remove A ok', r.json && r.json.ok === true)
      r = await get(PORT, '/audio?id=' + A, H)
      ok('/audio setelah dihapus = unduh cache biasa (yt-dlp)', r.status === 200 && r.headers['x-source'] === 'yt-dlp')
      ok('file A kini di CACHE (bukan library)', fs.existsSync(path.join(CACHE, A + '.m4a')) && !fs.existsSync(path.join(LIB, A + '.m4a')))

      /* 9. impor ulang A: file cache masih segar -> cukup disalin, tidak unduh ulang */
      r = await get(PORT, '/save?id=' + A, H)
      ok('/save A ulang ok', r.status === 200 && r.json && r.json.ok === true)
      ok('A kembali permanen (salinan dari cache)', await waitFor(() => fs.existsSync(path.join(LIB, A + '.m4a'))))
      await sleep(400) /* baris log lewat pipe stdout agak terlambat dari file: beri jeda sebelum membaca logS */
      if (!/salin dari cache/.test(logS)) console.log('  --- log server (salin-cache) ---\n' + logS.slice(-1500))
      ok('log menyebut salin dari cache', /salin dari cache/.test(logS))

      /* 10. pemulihan via /audio: meta "downloading" tanpa file -> unduhan dilanjutkan, lalu 206.
          (B & C dihapus dulu supaya kuota 1 MB cukup untuk A + E) */
      await get(PORT, '/remove?id=' + B, H); await get(PORT, '/remove?id=' + C, H)
      fs.writeFileSync(path.join(LIB, E + '.json'), JSON.stringify({ id: E, title: 'Lagu Uji ' + E, artist: 'Channel Uji', dur: 123, thumb: 'x', status: 'downloading', added_at: Date.now(), updated_at: Date.now() }))
      r = await get(PORT, '/audio?id=' + E, { ...H, Range: 'bytes=0-1' })
      ok('/audio E menyambung unduhan terputus lalu 206 permanen', r.status === 206 && r.headers['x-source'] === 'permanen' && fs.existsSync(path.join(LIB, E + '.m4a')), 'status=' + r.status + ' src=' + r.headers['x-source'])

      /* 11. pemulihan via /library: meta "downloading" LAMA (2 menit+) tanpa job -> dilanjutkan */
      fs.writeFileSync(path.join(LIB, F + '.json'), JSON.stringify({ id: F, title: 'Lagu Uji ' + F, artist: 'Channel Uji', dur: 123, thumb: 'x', status: 'downloading', added_at: Date.now() - 10 * 60e3, updated_at: Date.now() - 10 * 60e3 }))
      await get(PORT, '/library', H)
      ok('/library melanjutkan unduhan F yang terputus', await waitFor(() => {
        try { return JSON.parse(fs.readFileSync(path.join(LIB, F + '.json'), 'utf8')).status === 'ok' } catch { return false }
      }))

      /* 12. bersih-bersih: semua terhapus rapi */
      for (const id of [A, D, E, F]) await get(PORT, '/remove?id=' + id, H)
      r = await get(PORT, '/library', H)
      ok('/library kosong setelah semua dihapus', r.json && r.json.jumlah === 0, JSON.stringify(r.json))
      r = await get(PORT, '/remove?id=ZZZZZZZZZZZ', H)
      ok('/remove yang tidak ada tetap ok', r.json && r.json.ok === true && r.json.ada === false)

      /* 13. lagu biasa (bukan hasil impor) tetap lewat jalur cache lama */
      r = await get(PORT, '/audio?id=' + X, H)
      ok('/audio lagu asing = jalur cache biasa', r.status === 200 && r.headers['x-source'] === 'yt-dlp')

      /* 14. auth tetap dijaga */
      r = await get(PORT, '/library', {})
      ok('tanpa api-key ditolak (401)', r.status === 401)
    } catch (e) {
      if (e && e.message === 'server tidak menyala') { /* sudah dilaporkan */ }
      else { fail++; console.log('  GAGAL - bagian A melempar: ' + (e && e.message)) }
    } finally {
      proc.kill('SIGKILL')
      try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
    }
  }
}

/* ================================================================ */
console.log('== A2. server.js v1.4: via=link (nexray dulu), cooldown yt-dlp, pemulihan file sampah ==')
{
  /* nexray TIRUAN: API ytmp3 + CDN file 500 KB di localhost (tanpa jaringan luar) */
  const MP3 = Buffer.alloc(500 * 1024, 9)
  const NEX_PORT = 22000 + Math.floor(Math.random() * 1000)
  const nex = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x')
    if (u.pathname === '/downloader/ytmp3') {
      const id = String(u.searchParams.get('url') || '').split('/').pop() || 'x'
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ status: true, result: { url: 'http://127.0.0.1:' + NEX_PORT + '/file/' + id, title: 'Nexray Artis - Nexray Judul ' + id, filesize: MP3.length, duration: 120 } }))
    }
    if (u.pathname.startsWith('/file/')) { res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': String(MP3.length) }); return res.end(MP3) }
    res.writeHead(404, { 'Content-Type': 'application/json' }); res.end('{}')
  })
  await new Promise(r => nex.listen(NEX_PORT, '127.0.0.1', r))

  const tmp = fs.mkdtempSync(path.join(ROOT, '.musimp2-'))
  fs.copyFileSync(SERVER_SRC, path.join(tmp, 'server.cjs'))
  const CACHE = path.join(tmp, 'cache'), LIB = path.join(tmp, 'music')
  fs.mkdirSync(CACHE); fs.mkdirSync(LIB)

  /* yt-dlp stub: metadata & unduhan SELALU kena bot-check (limit) */
  const stub = path.join(tmp, 'ytdlp-stub.mjs')
  fs.writeFileSync(stub, `#!/usr/bin/env node
if (process.argv.includes('--version')) { console.log('2026.11.24-test'); process.exit(0) }
console.error('ERROR: Sign in to confirm you are not a bot. This helps protect our community.')
process.exit(1)
`)
  fs.chmodSync(stub, 0o755)

  const PORT = 24000 + Math.floor(Math.random() * 2000)
  const env = {
    ...process.env, API_KEY: 'kunci-a2', PORT: String(PORT), YTDLP_BIN: stub,
    CACHE_DIR: CACHE, LIB_DIR: LIB, LIB_MAX_MB: '20', MAX_PARALLEL: '3',
    NEXRAY_FALLBACK: '1', NEXRAY_BASE: 'http://127.0.0.1:' + NEX_PORT, NEXRAY_API_SEC: '10', NEXRAY_DL_SEC: '30',
    YTDL_UPDATE_HOURS: '0', PROVIDER_ORDER: 'ytdlp,nexray' /* sengaja ytdlp dulu: via=link HARUS tetap nexray dulu */
  }
  const proc = spawn(process.execPath, [path.join(tmp, 'server.cjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let logS = ''
  proc.stdout.on('data', d => { logS += d })
  proc.stderr.on('data', d => { logS += d })
  const H = { 'x-api-key': 'kunci-a2' }
  try {
    const up = await waitPort(PORT)
    ok('server menyala', up)
    if (!up) throw new Error('server tidak menyala')

    /* 1. via=link: nexray dulu untuk metadata + audio, yt-dlp TIDAK disentuh */
    let r = await get(PORT, '/save?id=NEWRAYTEST1&via=link', H)
    ok('/save via=link ok', r.status === 200 && r.json && r.json.ok === true, JSON.stringify(r.json))
    ok('via=link metadata dari nexray (judul dipecah artis)', r.json && r.json.song && r.json.song.title === 'Nexray Judul NEWRAYTEST1' && r.json.song.artist === 'Nexray Artis', JSON.stringify(r.json && r.json.song))
    ok('via=link tidak menyentuh yt-dlp (tanpa penalty)', !/kena limit/.test(logS), logS.slice(-400))
    const libOk = await waitFor(async () => {
      const l = await get(PORT, '/library', H)
      const s = l.json && l.json.songs && l.json.songs.find(x => x.id === 'NEWRAYTEST1')
      return s && s.status === 'ok' && s.bytes >= 500 * 1024
    })
    ok('via=link file audio dari nexray (500 KB tersimpan)', !!libOk)
    ok('log pakai nexray, bukan yt-dlp', /ok lib nexray NEWRAYTEST1/.test(logS) && !/ok lib ytdlp NEWRAYTEST1/.test(logS))

    /* 2. file sampah 637 B (kasus nyata) dimasukkan SETELAH server jalan, lalu /library memulihkannya:
          pemulihan coba yt-dlp dulu (urutan asli) -> kena bot-check -> cooldown -> nexray menyembuhkan */
    fs.writeFileSync(path.join(LIB, 'GARBAGE00001.mp3'), Buffer.alloc(637, 3))
    fs.writeFileSync(path.join(LIB, 'GARBAGE00001.json'), JSON.stringify({ id: 'GARBAGE00001', title: 'Lagu Sampah', artist: '', dur: 30, thumb: '', status: 'ok', added_at: Date.now(), bytes: 637, ext: 'mp3', source: 'nexray' }))
    await get(PORT, '/library', H) /* picu pemulihan malas */
    const gar = await waitFor(async () => {
      const l = await get(PORT, '/library', H)
      const s = l.json && l.json.songs && l.json.songs.find(x => x.id === 'GARBAGE00001')
      return s && s.status === 'ok' && s.bytes >= 500 * 1024
    }, 20000)
    ok('file sampah 637 B dipulihkan jadi audio valid', !!gar)
    ok('yt-dlp kena bot-check -> cooldown aktif', /kena limit/.test(logS))

    /* 3. import berikutnya (tanpa via): yt-dlp DISKIP selama cooldown, nexray yang mengerjakan */
    r = await get(PORT, '/save?id=COOLTEST001', H)
    ok('/save tanpa via tetap ok (nexray mengambil alih)', r.status === 200 && r.json && r.json.ok === true)
    await waitFor(() => /ytdlp_cooldown/.test(logS), 5000) /* kickLib jalan di latar: tunggu lognya */
    ok('save berikutnya skip yt-dlp (cooldown)', /ytdlp_cooldown/.test(logS) && !/ok lib ytdlp COOLTEST/.test(logS), logS.slice(-600))
    const h = await get(PORT, '/health', H)
    ok('/health menampilkan cooldown', h.json && typeof h.json.ytdlp_cooldown_dtk === 'number' && h.json.ytdlp_cooldown_dtk > 0, JSON.stringify(h.json))
  } catch (e) {
    fail++
    console.error('  GAGAL - bagian A2 melempar: ' + (e && e.message))
    console.error(logS.slice(-2000))
  } finally {
    proc.kill('SIGKILL'); nex.close()
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
  }
}

/* ================================================================ */
console.log('== B. router Vercel lib/music.js dengan server Ptero tiruan ==')
{
  /* server Ptero tiruan: /save /library /remove — memeriksa api-key yang dikirim */
  const seenKeys = [], seenSaveQ = []
  const ptero = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x')
    seenKeys.push(req.headers['x-api-key'])
    if (u.pathname === '/save') seenSaveQ.push(u.search)
    const j = (o, s = 200) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)) }
    if (u.pathname === '/save') return j({ ok: true, ready: false, song: { id: u.searchParams.get('id'), title: 'Lagu Ptero', artist: 'Artis Ptero', dur: 200, thumb: 'https://i.ytimg.com/vi/x/hqdefault.jpg', status: 'downloading' } })
    if (u.pathname === '/library') return j({ ok: true, jumlah: 1, total_bytes: 123456, kuota_bytes: 2048 * 1048576, songs: [{ id: 'AAAAAAAAAAA', title: 'Lagu Ptero', artist: 'Artis Ptero', dur: 200, thumb: 'x', status: 'ok', bytes: 123456, size: '120.56 KB' }] })
    if (u.pathname === '/remove') return j({ ok: true, ada: true })
    j({ error: 'not found' }, 404)
  })
  await new Promise(r => ptero.listen(0, r))
  const PPORT = ptero.address().port

  process.env.MUSIC_PTERO_URL = 'http://127.0.0.1:' + PPORT
  process.env.MUSIC_PTERO_KEY = 'kunci-b'

  const { musicRouter, ytId } = await import(path.join(ROOT, 'lib/music.js'))
  const express = (await import('express')).default
  const app = express()
  app.use(musicRouter)
  const vsrv = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)) })
  const VPORT = vsrv.address().port
  const V = '/api/music'

  try {
    /* parser ytId (server): menerima ID polos + semua bentuk link */
    const id = 'dQw4w9WgXcQ'
    ok('ytId ID polos', ytId(id) === id)
    ok('ytId watch?v=', ytId('https://www.youtube.com/watch?v=' + id + '&t=30s') === id)
    ok('ytId youtu.be', ytId('https://youtu.be/' + id + '?si=abc') === id)
    ok('ytId shorts', ytId('https://youtube.com/shorts/' + id) === id)
    ok('ytId music.youtube.com', ytId('https://music.youtube.com/watch?v=' + id) === id)
    ok('ytId embed', ytId('https://www.youtube-nocookie.com/embed/' + id) === id)
    ok('ytId live', ytId('https://www.youtube.com/live/' + id) === id)
    ok('ytId tanpa skema', ytId('youtu.be/' + id) === id)
    ok('ytId bukan youtube = null', ytId('https://open.spotify.com/track/abc') === null)
    ok('ytId omong kosong = null', ytId('monokrom tulus') === null)
    ok('ytId id salah panjang = null', ytId('abc123') === null)

    /* /api/music/import */
    let r = await get(VPORT, V + '/import?url=' + encodeURIComponent('https://youtu.be/dQw4w9WgXcQ') + '&clientId=t1')
    ok('import youtu.be ok', r.status === 200 && r.json && r.json.ok === true && r.json.song && r.json.song.id === 'dQw4w9WgXcQ', JSON.stringify(r.json))
    r = await get(VPORT, V + '/import?id=dQw4w9WgXcQ&clientId=t1')
    ok('import id polos ok', r.status === 200 && r.json && r.json.ok === true)
    r = await get(VPORT, V + '/import?url=' + encodeURIComponent('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=30') + '&clientId=t1')
    ok('import watch?v= ok', r.status === 200 && r.json && r.json.ok === true)
    r = await get(VPORT, V + '/import?url=' + encodeURIComponent('https://example.com/lagu') + '&clientId=t1')
    ok('import bukan link = 400 bukan_link', r.status === 400 && r.json && r.json.code === 'bukan_link')
    r = await get(VPORT, V + '/import?q=monokrom+tulus&clientId=t1')
    ok('import tanpa url = 400', r.status === 400)
    ok('api-key Ptero terkirim benar', seenKeys.length > 0 && seenKeys.every(k => k === 'kunci-b'))
    ok('import meneruskan &via=link ke /save Ptero (nexray dulu, tanpa yt-dlp)', seenSaveQ.some(q => q === '?id=dQw4w9WgXcQ&via=link'), JSON.stringify(seenSaveQ))

    /* /api/music/library dan /remove */
    r = await get(VPORT, V + '/library?clientId=t1')
    ok('library meneruskan daftar lagu', r.status === 200 && r.json && r.json.ok === true && r.json.jumlah === 1 && r.json.songs[0].id === 'AAAAAAAAAAA' && r.json.songs[0].status === 'ok', JSON.stringify(r.json))
    r = await get(VPORT, V + '/library/remove?id=AAAAAAAAAAA&clientId=t1')
    ok('library/remove ok', r.status === 200 && r.json && r.json.ok === true)
    r = await get(VPORT, V + '/library/remove?id=tidak-valid!&clientId=t1')
    ok('library/remove id jelek = 400', r.status === 400)
  } finally {
    ptero.close(); vsrv.close()
  }

  /* tanpa env Ptero: 501 butuh_ptero (proses anak terpisah supaya env bersih) */
  const neg = await new Promise(resolve => {
    const code = `
      import(${JSON.stringify('file://' + path.join(ROOT, 'lib/music.js'))}).then(async ({ musicRouter }) => {
        const express = (await import('express')).default
        const app = express(); app.use(musicRouter)
        const srv = app.listen(0, '127.0.0.1', async () => {
          const http = await import('node:http')
          const get = p => new Promise((res2, rej2) => http.get({ host: '127.0.0.1', port: srv.address().port, path: p }, r => {
            let b = ''; r.on('data', c => b += c); r.on('end', () => res2({ status: r.statusCode, body: b }))
          }).on('error', rej2))
          const a = await get('/api/music/library?clientId=neg')
          const b = await get('/api/music/import?id=dQw4w9WgXcQ&clientId=neg')
          console.log(JSON.stringify({ lib: a.status, libCode: (JSON.parse(a.body).code || null), imp: b.status, impCode: (JSON.parse(b.body).code || null) }))
          srv.close()
        })
      }).catch(e => { console.error(e.message); process.exit(1) })
    `
    const env = { ...process.env }
    delete env.MUSIC_PTERO_URL; delete env.MUSIC_PTERO_KEY
    const p = spawn(process.execPath, ['--input-type=module', '-e', code], { env, cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    p.stdout.on('data', d => { out += d })
    p.stderr.on('data', d => { out += d })
    p.on('close', () => {
      try { resolve(JSON.parse(out.trim().split('\n').pop())) } catch { resolve(null) }
    })
  })
  ok('tanpa Ptero: /library = 501 butuh_ptero', neg && neg.lib === 501 && neg.libCode === 'butuh_ptero', JSON.stringify(neg))
  ok('tanpa Ptero: /import = 501 butuh_ptero', neg && neg.imp === 501 && neg.impCode === 'butuh_ptero', JSON.stringify(neg))
}

/* ================================================================ */
console.log('== C. parser link di public/music.js (kode asli diekstrak dari sumber) ==')
{
  const src = fs.readFileSync(path.join(ROOT, 'public/music.js'), 'utf8')
  const start = src.indexOf('function ytLink(')
  ok('fungsi ytLink ada di public/music.js', start >= 0)
  if (start >= 0) {
    let depth = 0, end = -1, began = false
    for (let i = start; i < src.length; i++) {
      if (src[i] === '{') { depth++; began = true }
      else if (src[i] === '}') { depth--; if (began && depth === 0) { end = i + 1; break } }
    }
    ok('blok ytLink utuh (kurung seimbang)', end > start)
    if (end > start) {
      const YT_OK = /^[\w-]{11}$/
      const ytLink = eval('(' + src.slice(start, end).replace(/^function ytLink/, 'function') + ')')
      const id = 'dQw4w9WgXcQ'
      const cases = [
        ['https://www.youtube.com/watch?v=' + id, id],
        ['https://youtu.be/' + id, id],
        ['https://www.youtube.com/watch?v=' + id + '&t=30s&pp=x', id],
        ['https://youtube.com/shorts/' + id, id],
        ['https://music.youtube.com/watch?v=' + id + '&si=zzz', id],
        ['https://www.youtube.com/live/' + id, id],
        ['https://www.youtube.com/embed/' + id, id],
        ['youtu.be/' + id, id], /* tanpa skema */
        ['www.youtube.com/watch?v=' + id, id], /* tanpa skema */
        ['monokrom tulus', null], /* judul lagu biasa: BUKAN link */
        [id, null], /* ID polos: sengaja tidak dianggap link di kolom cari */
        ['https://open.spotify.com/track/abc', null],
        ['https://example.com/watch?v=' + id, null]
      ]
      let all = true, bad = ''
      for (const [q, want] of cases) { const got = ytLink(q); if (got !== want) { all = false; bad = q + ' -> ' + got + ' (harusnya ' + want + ')' } }
      ok('ytLink: 13 kasus link/judul semua benar', all, bad)
    }
  }
}

console.log('')
console.log(`Hasil: ${pass} lulus, ${fail} gagal`)
process.exit(fail ? 1 : 0)
