#!/usr/bin/env node
/* Pasang fitur Musik ke repo neyhra-chat2.
   Cara pakai (dari akar repo):
     node add-music.mjs
   Apa yang dilakukan:
     1. Menyalin 3 file baru: public/music.css, public/music.js, lib/music.js
     2. Menambal (anchor-based, idempotent — aman dijalankan berulang):
        public/index.html, public/shell.js, public/router.js, lib/app.js, vercel.json, package.json
   Setelah selesai: npm install (untuk youtubei.js) lalu deploy biasa.
   Kalau ada anchor yang tidak ketemu (repo sudah berubah), patch itu dilewati dan
   dicetak instruksi manualnya — tidak ada file yang dirusak. */

import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url)) // folder script ini (…/neyhra-music)
const ROOT = resolve(HERE, '..') // akar repo (induk folder ini)
const read = f => readFileSync(join(ROOT, f), 'utf8')
const write = (f, s) => writeFileSync(join(ROOT, f), s)
let ok = 0, skip = 0, fail = 0

/* tambalan teks: cari `a` persis, ganti dengan `b`. idempotent: kalau `b` sudah ada, lewati. */
function patch(file, name, a, b) {
  let s
  try { s = read(file) } catch { console.log(`✗ ${name}: file ${file} tidak ditemukan`); fail++; return }
  if (s.includes(b)) { console.log(`• ${name}: sudah terpasang, lewati`); skip++; return }
  const i = s.indexOf(a)
  if (i < 0) { console.log(`✗ ${name}: anchor tidak ketemu di ${file} — pasang manual (lihat README-MUSIK.md bagian "${name}")`); fail++; return }
  s = s.slice(0, i) + b + s.slice(i + a.length)
  write(file, s)
  console.log(`✓ ${name}`)
  ok++
}

console.log('== 1. Menyalin file baru ==')
for (const f of ['public/music.css', 'public/music.js', 'lib/music.js']) {
  const src = join(HERE, f)
  const dst = join(ROOT, f)
  if (existsSync(dst)) { console.log(`• ${f} sudah ada, lewati`); skip++; continue }
  if (!existsSync(src)) { console.log(`✗ sumber ${src} tidak ditemukan`); fail++; continue }
  copyFileSync(src, dst)
  console.log(`✓ ${f}`)
  ok++
}

console.log('\n== 2. Menambal file lama ==')

/* ---------- index.html ---------- */
patch('public/index.html', 'index: css',
  '<link rel="stylesheet" href="/profile.css">',
  '<link rel="stylesheet" href="/profile.css">\n<link rel="stylesheet" href="/music.css">')

patch('public/index.html', 'index: tombol rail',
  '    <button class="r-item" id="rtools" type="button" data-tab="tools" title="Tools">',
  `    <button class="r-item" id="rmusic" type="button" data-tab="music" title="Musik">
      <svg viewBox="0 0 24 24"><path d="M9 18V5l12-2v13M9 18a3 3 0 11-6 0 3 3 0 016 0zm12-2a3 3 0 11-6 0 3 3 0 016 0z"/></svg>
      <span class="r-label">Musik</span>
    </button>
    <button class="r-item" id="rtools" type="button" data-tab="tools" title="Tools">`)

patch('public/index.html', 'index: section musik',
  '  <div id="chatview">',
  `  <section id="music" aria-label="Musik">
    <div class="mu-in"><div id="mubody"></div></div>
  </section>
  <div id="chatview">`)

patch('public/index.html', 'index: script',
  '<script src="/shop.js"></script>',
  '<script src="/shop.js"></script>\n<script src="/music.js"></script>')

/* ---------- shell.js ---------- */
patch('public/shell.js', 'shell: tombol',
  "const rhome = $('rhome'), rrecent = $('rrecent'), rbonus = $('rbonus'), rgames = $('rgames'), rshop = $('rshop'), rtools = $('rtools'), rprofile = $('rprofile'), rlogo = $('rlogo');",
  "const rhome = $('rhome'), rrecent = $('rrecent'), rbonus = $('rbonus'), rgames = $('rgames'), rshop = $('rshop'), rtools = $('rtools'), rprofile = $('rprofile'), rmusic = $('rmusic'), rlogo = $('rlogo');")

patch('public/shell.js', 'shell: syncRail',
  "[[rhome, 'home'], [rrecent, 'recent'], [rbonus, 'bonus'], [rgames, 'games'], [rshop, 'shop'], [rtools, 'tools'], [rprofile, 'profile']]",
  "[[rhome, 'home'], [rrecent, 'recent'], [rbonus, 'bonus'], [rgames, 'games'], [rshop, 'shop'], [rtools, 'tools'], [rprofile, 'profile'], [rmusic, 'music']]")

patch('public/shell.js', 'shell: setTab daftar',
  "t = t === 'recent' || t === 'bonus' || t === 'games' || t === 'shop' || t === 'tools' || t === 'profile' ? t : 'home';",
  "t = t === 'recent' || t === 'bonus' || t === 'games' || t === 'shop' || t === 'tools' || t === 'profile' || t === 'music' ? t : 'home';")

patch('public/shell.js', 'shell: setTab layar tanpa chat',
  "if (t === 'home' || t === 'bonus' || t === 'games' || t === 'shop' || t === 'tools' || t === 'profile') { // layar tanpa chat: Beranda, Bonus, Minigame, Toko, Tools, Profil",
  "if (t === 'home' || t === 'bonus' || t === 'games' || t === 'shop' || t === 'tools' || t === 'profile' || t === 'music') { // layar tanpa chat: Beranda, Bonus, Minigame, Toko, Tools, Musik, Profil")

patch('public/shell.js', 'shell: klik',
  "rbonus.addEventListener('click', () => setTab('bonus'));",
  "rbonus.addEventListener('click', () => setTab('bonus'));\nrmusic.addEventListener('click', () => setTab('music'));")

/* ---------- router.js ---------- */
patch('public/router.js', 'router: curPath',
  "    if (appEl.dataset.tab === 'bonus') return '/bonus'",
  "    if (appEl.dataset.tab === 'bonus') return '/bonus'\n    if (appEl.dataset.tab === 'music') return '/music'")

patch('public/router.js', 'router: apply',
  `      } else if (path === '/bonus') {
        Shell.setTab('bonus', { auto: false })`,
  `      } else if (path === '/bonus') {
        Shell.setTab('bonus', { auto: false })
      } else if (path === '/music') {
        Shell.setTab('music', { auto: false })`)

/* ---------- lib/app.js ---------- */
patch('lib/app.js', 'app: import',
  "import { authRouter } from './auth.js'",
  "import { authRouter } from './auth.js'\nimport { musicRouter } from './music.js'")

patch('lib/app.js', 'app: pasang router',
  "app.use(gcRouter) // Chat Global: /api/gc/sync|send|signal|delete (lihat lib/gc.js)",
  "app.use(gcRouter) // Chat Global: /api/gc/sync|send|signal|delete (lihat lib/gc.js)\napp.use(musicRouter) // Musik: /api/music/search|stream|lyrics (lihat lib/music.js)")

patch('lib/app.js', 'app: alamat layar',
  "app.get(['/chat', '/chat/:id', '/global', '/bonus', '/games', '/shop', '/tools', '/tools/:id', '/profile', '/settings'], (_req, res) => res.sendFile(path.join(PUBLIC, 'index.html')))",
  "app.get(['/chat', '/chat/:id', '/global', '/bonus', '/games', '/shop', '/tools', '/tools/:id', '/profile', '/settings', '/music'], (_req, res) => res.sendFile(path.join(PUBLIC, 'index.html')))")

/* ---------- vercel.json ---------- */
patch('vercel.json', 'vercel: rewrite /music',
  `    {
      "source": "/profile",
      "destination": "/index.html"
    }`,
  `    {
      "source": "/profile",
      "destination": "/index.html"
    },
    {
      "source": "/music",
      "destination": "/index.html"
    }`)

/* ---------- package.json ---------- */
patch('package.json', 'package: dep youtubei.js',
  `"dependencies": {
    "axios": "^1.7.0",`,
  `"dependencies": {
    "axios": "^1.7.0",
    "youtubei.js": "^18.3.0",`)

console.log(`\n== Selesai: ${ok} dipasang, ${skip} sudah ada, ${fail} gagal ==`)
if (fail) console.log('Item gagal bisa dipasang manual — lihat README-MUSIK.md.')
else console.log('Langkah berikutnya:\n  1. npm install\n  2. Redeploy ke Vercel (env tetap sama, tidak ada env baru yang wajib)\n  3. Buka /music di web kamu')
