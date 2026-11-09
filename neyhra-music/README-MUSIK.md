# Fitur Musik untuk neyhra-chat2 — Delta Zip

Tab **Musik** di rail/sidepanel: cari lagu, putar, antrean, lirik tersinkron (karaoke).
Musik **tetap berjalan** saat pindah tab (Beranda, Minigame, dst.) — seperti Spotify.

- Pencarian & metadata: **YouTube Music** (lewat library `youtubei.js` v18, lisensi MIT)
- Lirik: **LRCLIB** (gratis, tanpa auth)
- Cache & rate-limit: **Redis Upstash** kamu (otomatis terpakai, pola sama dengan `lib/online.js`)
- Arsitektur *resolve-only*: audio TIDAK lewat server Vercel — server hanya mencari URL stream
  (1–5 detik), browser user memutar langsung dari googlevideo. Bandwidth Vercel tetap tipis.

---

## Cara pasang — Cara A (ekstrak zip, paling gampang)

File di zip ini sudah dalam keadaan **terpasang penuh** — 3 file baru + 6 file lama yang sudah
ditambal, berdasarkan **main branch per 9 Nov 2026**:

1. Ekstrak zip ini di **akar repo** (folder yang ada `package.json`), timpa semuanya saat ditanya.
   - Windows: klik kanan zip → *Extract Here* (bukan "Extract to neyhra-music-delta\")
   - Linux/Mac: `unzip -o neyhra-music-delta.zip -d .`
2. `npm install` (mendownload `youtubei.js`)
3. Commit + push — Vercel otomatis deploy
4. Buka `https://web-kamu/music`

> ⚠️ **Syarat Cara A:** repo lokal kamu sama dengan yang ada di GitHub (tidak ada edit lokal
> yang belum di-push). Kalau ada, pakai Cara B — jangan menimpa file lamamu.
>
> ⚠️ `package.json` di zip ini = main branch + `youtubei.js`. Kalau kamu baru menambah
> dependency lain secara lokal, jangan timpa file ini — cukup jalankan
> `npm install youtubei.js@^18.3.0`.

## Cara B — kalau repo lokal sudah beda dari GitHub (pakai script penambal)

1. Ekstrak zip ini di **folder sementara** (JANGAN langsung di akar repo)
2. Salin folder `neyhra-music/` ke akar repo
3. Dari akar repo jalankan: `node neyhra-music/add-music.mjs`
   - Menyalin 3 file baru + menambal 6 file lamamu dengan anchor teks yang persis
   - **Idempotent** (aman dijalankan berulang), dan kalau ada anchor yang tidak ketemu
     ia melewati item itu tanpa merusak apa pun — pasang manual item itu (lihat bawah)
4. `npm install` lalu push

Setelah terpasang lewat cara mana pun, folder `neyhra-music/` boleh dihapus (dia cuma toolkit).

## File yang ditambah / ditambal

| File | Status | Perubahan |
|---|---|---|
| `public/music.css` | **baru** | styling tab, mini player, lembar Now Playing, lirik karaoke |
| `public/music.js` | **baru** | logika frontend (pola IIFE seperti `bonus.js`) |
| `lib/music.js` | **baru** | router Express `/api/music/search\|stream\|lyrics` |
| `public/index.html` | ditambal | tombol rail `#rmusic` + `<section id="music">` + link css + tag script |
| `public/shell.js` | ditambal | `rmusic` masuk `setTab`/`syncRail` + handler klik |
| `public/router.js` | ditambal | alamat `/music` (tombol back/forward browser tetap jalan) |
| `lib/app.js` | ditambal | `app.use(musicRouter)` + rute `/music` |
| `vercel.json` | ditambal | rewrite `/music` |
| `package.json` | ditambal | dependency `youtubei.js` |

Tidak ada env baru yang wajib. MONGODB/REDIS/R2 milikmu tidak disentuh.

## Sudah diuji (9 Nov 2026, dari IP datacenter yang di-flag berat)

- ✅ `/api/music/search` — 20 lagu untuk "monokrom tulus", struktur field pas dengan frontend
- ✅ `/api/music/lyrics` — lirik synced LRCLIB dengan timestamp benar (28 baris)
- ✅ Validasi input (query kosong/kepanjangan → 400, ID ngaco → 400), rate-limit → 429
- ✅ Installer `add-music.mjs` — 19/19 tambalan kena pada salinan main branch
- ⚠️ `/api/music/stream` — dari IP sandbox yang di-flag, semua client kena bot-check
  (dibalas rapi dengan pesan set `YT_COOKIE`). Di IP Vercel hasilnya bisa berbeda —
  lihat bagian bot-check di bawah.

## Env (semua opsional)

| Env | Kapan dipakai |
|---|---|
| `YT_COOKIE` | Kalau endpoint stream kena bot-check YouTube dari IP Vercel kamu (lihat bawah). Isi: nilai header `Cookie` browser kamu yang sedang login YouTube. |
| — | Tidak ada env wajib baru. |

## 🚨 Penting: kalau muncul "YouTube menolak dari IP server (bot check)"

Ini realita 2026: YouTube memblokir endpoint `player` dari IP datacenter yang di-flag
(IP Vercel kadang ya kadang tidak, tergantung region). **Pencarian dan lirik tetap jalan
walau ini terjadi** — yang mati hanya stream. Urutan solusi:

1. **Deploy dulu, coba dulu.** Banyak kasus langsung jalan di Vercel.
2. Kalau kena: set env `YT_COOKIE` di Vercel (Settings → Environment Variables):
   - buka youtube.com di browser kamu (login akun Google biasa — boleh akun kosong khusus ini),
   - DevTools → Network → klik request apa pun ke youtube.com → copy nilai header `Cookie`,
   - paste sebagai value `YT_COOKIE`, redeploy.
   Catatan: cookie bisa kadaluarsa (mingguan-bulanan); kalau stream mati lagi, ulangi.
3. Kalau masih gagal: pindah region function (Vercel → Settings → Functions → Region), atau
   cari diskusi terbaru issue `LuanRT/YouTube.js` soal PO token.

Dua hal yang JANGAN dilakukan:
- Jangan menyimpan file audio ke R2 ("sekalian di-download sekalian") — itu berubah jadi
  distribusi konten, risikonya jauh lebih tinggi daripada sekadar memberi link stream.
- Jangan buat proxy audio lewat Vercel — bandwidthnya meledak.

## Batasan & catatan jujur

- **URL stream kedaluwarsa ±6 jam** dan terikat IP pemesan. Frontend otomatis me-resolve ulang
  kalau gagal; antrean tersimpan di localStorage user.
- **Risiko ToS YouTube tetap ada** — ini risiko yang sama dengan NewPipe/ytdlp. Untuk pemakaian
  pribadi/kecil-kecilan umumnya aman, tapi jangan dijadikan produk komersial.
- Kadaluwarsa antrean: lagu yang diputar berhari-hari lalu akan re-resolve saat diputar lagi.
- youtubei.js perlu di-update kalau YouTube mengubah API-nya (`npm update youtubei.js`).

## Dipasang manual (kalau anchor patch gagal — hanya relevan untuk Cara B)

1. **index.html** — di dalam `<nav id="rail">`, sebelum tombol `#rtools`, tambah:
   ```html
   <button class="r-item" id="rmusic" type="button" data-tab="music" title="Musik">
     <svg viewBox="0 0 24 24"><path d="M9 18V5l12-2v13M9 18a3 3 0 11-6 0 3 3 0 016 0zm12-2a3 3 0 11-6 0 3 3 0 016 0z"/></svg>
     <span class="r-label">Musik</span>
   </button>
   ```
   Sebelum `<div id="chatview">` tambah:
   ```html
   <section id="music" aria-label="Musik"><div class="mu-in"><div id="mubody"></div></div></section>
   ```
   Di `<head>`: `<link rel="stylesheet" href="/music.css">`. Sebelum `<script src="/router.js"></script>`: `<script src="/music.js"></script>`.
2. **shell.js** — tambah `rmusic = $('rmusic'),` di baris tombol; tambah `[rmusic, 'music'],`
   di `syncRail`; tambah `|| t === 'music'` (dua tempat) di `setTab`; tambah
   `rmusic.addEventListener('click', () => setTab('music'));` di baris klik tombol lain.
3. **router.js** — di `curPath()`: `if (appEl.dataset.tab === 'music') return '/music'`.
   Di `apply()`: `else if (path === '/music') { Shell.setTab('music', { auto: false }) }`.
4. **lib/app.js** — `import { musicRouter } from './music.js'`, `app.use(musicRouter)`
   (setelah `app.use(gcRouter)`), dan tambah `'/music'` di daftar `app.get([/chat, ...])`.
5. **vercel.json** — tambah rewrite `{"source": "/music", "destination": "/index.html"}`.
6. **package.json** — tambah `"youtubei.js": "^18.3.0"` di dependencies.

## Cara kerja (ringkas, buat referensi kamu)

```
Browser                          Server (Vercel)                Luar
  |  search "monokrom tulus" -->  /api/music/search  --(cache Redis 30m)--> YouTube Music
  |  <-- { songs: [ {id, judul, artis, thumb} ] }
  |
  |  klik lagu ----------------->  /api/music/stream --(cache Redis 4j)--> youtubei.js
  |  <-- { url: https://...googlevideo.com/... }       (rantai client ANDROID_VR dkk.)
  |
  |  <audio>.src = url  ====== langsung ke googlevideo (tidak lewat Vercel) ======>>
  |
  |  lirik --------------------->  /api/music/lyrics --(cache Redis 7h)------> LRCLIB
```
