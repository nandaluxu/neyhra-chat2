// Server tiruan untuk uji UI musik: halaman harness + public/music.js ASLI + stub /api/music/*.
// Dipakai scripts/music-ui-test.mjs. Jalankan manual: node scripts/music-ui-server.mjs (port 4581)
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public')
const PORT = Number(process.env.PORT) || 4581

/* WAV kecil yang valid (±0.1 dtk) untuk elemen <audio> */
const wav = Buffer.from('UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=' , 'base64')

/* keadaan stub */
const state = {
  imported: [],          // id yang sudah diimpor lewat /api/music/import
  libPolls: 0,           // berapa kali /api/music/library dipanggil SETELAH import terakhir
  lib: [
    { id: 'SRVSONG00001', title: 'Lagu Server Satu', artist: 'Artis A', album: '', dur: 201, thumb: '', status: 'ok', bytes: 4096000, size: '3.91 MB', source: 'yt-dlp' },
    { id: 'SRVSONG00002', title: 'Lagu Server Dua', artist: 'Artis B', album: '', dur: 155, thumb: '', status: 'ok', bytes: 3100000, size: '2.96 MB', source: 'nexray' }
  ],
  removed: [],
  calls: []
}
const songs = [
  { id: 'SEARCHSONG01', title: 'Monokrom', artist: 'Tulus', album: 'Monokrom', dur: 261, thumb: '' },
  { id: 'SEARCHSONG02', title: 'Racing Into The Night', artist: 'YOASOBI', album: 'THE BOOK', dur: 247, thumb: '' }
]

const j = (res, o, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify(o)) }

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x')
  const p = u.pathname
  state.calls.push(p + '?' + u.searchParams.toString())

  if (p === '/' || p === '/music' || p === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    return res.end(`<!doctype html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Uji UI Musik</title>
<link rel="stylesheet" href="/music.css">
<style>
:root{--ink:#ececec;--mut:#8f8f8f;--surface:#1c1c1c;--line:#2c2c2c;--bg:#101010;--rec:#ff5b5b}
html,body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.45 system-ui,sans-serif}
/* shell asli: #app setinggi viewport & position:relative (jangkar absolute mini player). Tiruan sama. */
#app{position:relative;height:100dvh;overflow:hidden;display:grid;grid-template-columns:220px 1fr}
#music{overflow-y:auto;height:100dvh}
button{font:inherit;color:inherit;background:none;border:0;cursor:pointer;padding:0}
</style></head><body>
<div id="app" data-tab="music">
  <section id="music" aria-label="Musik"><div class="mu-in"><div id="mubody"></div></div></section>
</div>
<script>
  const $ = id => document.getElementById(id);
  const cid = 'uji-cid-ui';
  const store = { get(k){ try { return localStorage.getItem(k) } catch { return null } }, set(k,v){ try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k,v) } catch {} } };
  localStorage.setItem('devu','1'); localStorage.setItem('dev','1');
  const devOn = () => store.get('devu') === '1' && store.get('dev') === '1';
</script>
<script src="/music.js"></script>
</body></html>`)
  }
  if (p === '/music.css') { res.writeHead(200, { 'Content-Type': 'text/css' }); return res.end(fs.readFileSync(path.join(PUB, 'music.css'))) }
  if (p === '/music.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }); return res.end(fs.readFileSync(path.join(PUB, 'music.js'))) }

  if (p === '/api/music/search') return j(res, { songs })
  if (p === '/api/music/lyrics') return j(res, { lyrics: null })
  if (p === '/api/music/stream') return j(res, { url: '/api/music/audio?id=' + encodeURIComponent(u.searchParams.get('id') || '') + '&clientId=' + u.searchParams.get('clientId'), itag: 140, kbps: 128 })
  if (p === '/api/music/audio') { res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': String(wav.length), 'Accept-Ranges': 'bytes' }); return res.end(wav) }

  if (p === '/api/music/import') {
    const id = u.searchParams.get('id') || u.searchParams.get('url') || ''
    if (!/^[\w-]{11}$/.test(id)) return j(res, { code: 'bukan_link', error: 'bukan link' }, 400)
    state.imported.push(id)
    state.libPolls = 0
    return j(res, { ok: true, ready: false, song: { id, title: 'Lagu Import Uji', artist: 'Channel Import', album: '', dur: 99, thumb: '', status: 'downloading' } })
  }
  if (p === '/api/music/library') {
    const songs = state.lib.filter(s => !state.removed.includes(s.id)).map(s => ({ ...s }))
    /* lagu yang baru diimpor: poll pertama masih 'downloading', mulai poll kedua jadi 'ok' */
    for (const id of state.imported) {
      if (state.removed.includes(id)) continue
      const ada = songs.some(s => s.id === id)
      if (!ada) songs.unshift({ id, title: 'Lagu Import Uji', artist: 'Channel Import', album: '', dur: 99, thumb: '', status: state.libPolls < 1 ? 'downloading' : 'ok', bytes: 0, size: '', source: 'yt-dlp' })
    }
    state.libPolls++
    return j(res, { ok: true, jumlah: songs.length, total_bytes: 7196000, kuota_bytes: 2147483648, songs })
  }
  if (p === '/api/music/library/remove') {
    const id = u.searchParams.get('id') || ''
    state.removed.push(id)
    return j(res, { ok: true, ada: true })
  }
  if (p === '/__state') return j(res, state)
  res.writeHead(404, { 'Content-Type': 'application/json' })
  res.end('{}')
})

server.listen(PORT, '127.0.0.1', () => console.log('server tiruan uji UI musik di http://127.0.0.1:' + PORT))
