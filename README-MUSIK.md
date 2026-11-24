# Fitur Musik untuk neyhra-chat2 — Delta Zip

> 🔁 **Update 25 Nov 2026 (tiga) — `music.js`/`music.css` dikembalikan ke versi pemilik (commit `e49643d`).**
> - Upload delta sebelumnya menimpa editan pemilik di `public/music.js` + `public/music.css`. Kini
>   keduanya **persis versi pemilik**: label menu ⋮ kembali ke **"Publik"/"Private"** (bukan
>   "Jadikan Publik/Jadikan Private"), gaya tombol lebar "Simpan ke playlist saya" versi pemilik,
>   klik kanan / tekan lama lagu → popup pilih playlist tanpa memutar, dan **geser urutan lagu di
>   playlist sendiri** (tahan lalu geser, Alt+↑/↓) — semua utuh kembali.
> - Di atas versi pemilik itu ditanam ulang (tetap ada): seksi **"Pilihan Orang Lain"**, tombol
>   **terjemahan lirik** (ikon translate milik pemilik, teks kecil di bawah tiap baris), dan
>   **"Lainnya dari X" maks 100 lagu**. Server tidak berubah dari update sebelumnya.
> - Diuji ulang: `node scripts/music-ui-test.mjs` — **94 asersi, 0 gagal** (asersi label menu ⋮
>   disesuaikan ke label versi pemilik).

> 🆕 **Update 25 Nov 2026 — "Pilihan Orang Lain": playlist publik pengguna lain tampil di beranda.**
> - Playlist yang dijadikan **Publik** (lewat ⋮) kini tidak hanya bisa dibuka lewat link — muncul juga
>   di baris **"Pilihan Orang Lain"** di beranda musik semua orang: judul kartu = nama playlist,
>   baris artis = **oleh @username pembuatnya** (+ jumlah lagu). Klik kartu → halaman playlist publik
>   (putar / acak / simpan ke playlist sendiri); tombol ▶ di kartu → langsung putar seluruhnya.
>   Playlist milik sendiri tidak ikut (disaring lewat token). Endpoint baru `GET /api/auth/pl/list`
>   (`lib/musicpl.js`): 24 playlist publik terbaru, tanpa isi lagu (cuma kode, nama, pembuat, jumlah,
>   sampul) — tanpa login juga bisa melihat. Masih lewat koleksi Mongo `music_pl` yang sama.

> 🆕 **Update 25 Nov 2026 (dua) — Terjemahan lirik (DeepL) + "Lainnya dari X" sampai 100 lagu.**
> - **Tombol terjemahan di lirik.** Di layar Now Playing, di baris tab Lirik/Antrean ada tombol ikon
>   translate (ikon dari pemilik, `translate.svg` — kini inline di `SVG.translate`). Ditekan → semua
>   baris lirik diterjemahkan (satu permintaan per lagu) dan hasilnya tampil sebagai **teks kecil di
>   bawah tiap baris lirik asli** (`.mu-lrc .ln .tr`). Ditekan lagi → terjemahan hilang; pilihan
>   diingat di localStorage (`mlrctr`) seperti mode acak/ulang. Terjemahan per lagu di-cache (memori,
>   maks 30 lagu) — pindah lagu balik-lalu tidak mengulang permintaan; kalau lagu berganti saat
>   terjemahan nyala, lagu baru diterjemahkan otomatis (gagal = diam saja, tanpa toast beruntun).
> - **Server:** endpoint baru `POST /api/music/translate` di `lib/music.js` — port dari kode Rust
>   milik pemilik (klien aplikasi DeepL Android): payload `{ text: [...], target_lang }` ke endpoint
>   oneshot gratis `oneshot.fal.free.deepl.com` (fallback `oneshot.kef.free.deepl.com`), header
>   `User-Agent: DeepL/26.41.0 (com.deepl.mobiletranslator; build:264100; Android 14)`. Bahasa
>   dinormalisasi seperti di Rust: kosong → `id`, kode `in` (ISO lama Indonesia) → `id`. Maks 200
>   baris × 600 karakter, rate-limit 20/menit per clientId, hasil di-cache Redis 7 hari (lirik
>   statis). Tanpa env baru.
> - **"Lainnya dari X" kini maks 100 lagu per baris artis** (sebelumnya 20). Server
>   `/api/music/artist-songs` memang sudah memotong 100 dari playlist "Top songs" halaman artis;
>   frontend yang masih memotong 20 — sekarang ikut 100. Baris carousel & halaman "Lihat semua"
>   langsung menerima semua.
> - Diuji: `node scripts/music-ui-test.mjs` — **94 asersi, 0 gagal** (termasuk 13 asersi baru:
>   tombol translate, permintaan sekali + cache, terjemahan tampil/hilang, dan batas 100 kartu
>   per baris artis dari stub 120 lagu).

> 🆕 **Update 25 Nov 2026 — "Lainnya dari X" berbasis artis (channel) + playlist Publik/Private.**
> - **"Lainnya dari X" tidak lagi "sepi" & tidak salah artis.** Dulu: cari *nama* artis (20 hasil,
>   tercampur artis lain yang kebetulan bernama sama, mis. Tulus Indonesia vs Tulus band Norwegia,
>   dan sebagian besar sudah ada di riwayat). Sekarang: setiap lagu hasil pencarian membawa `ch`
>   (channel YouTube Music artis utamanya — halaman `music.youtube.com/@nama` itu), dan baris
>   "Lainnya dari X" diambil dari **halaman artis** lewat endpoint baru
>   `/api/music/artist-songs?id=UC…` → playlist otomatis "Top songs" milik artis = SEMUA lagunya
>   (Tulus 71, Rex Orange County 92, YOASOBI 98). Riwayat lama tanpa `ch` tetap jalan lewat jalur
>   lama (cari nama + filter). Cache Redis 12 jam. Fallback: isi shelf halaman artis; gagal → cari nama.
> - **Playlist publik/private (tombol titik-tiga).** Setiap playlist (termasuk "Lagu disukai")
>   punya ⋮ di kartu & halaman playlist → **Jadikan Publik** (unggah salinan ke server, dapat kode
>   tetap; link `https://web-kamu/music?pl=KODE` bisa dibuka siapa pun — tamu juga bisa — untuk
>   diputar / disalin ke playlist sendiri) atau **Jadikan Private** (kode dihapus, link mati).
>   Playlist diedit saat publik → salinan server diperbarui otomatis (kode tidak berubah).
>   Butuh masuk akun untuk membagikan; server: `lib/musicpl.js` (koleksi Mongo `music_pl`, rute
>   `/api/auth/pl/share|unshare|get`, dihapus bersama akun). Tanpa MongoDB: rute balas
>   `{enabled:false}` (pagar bawaan `/api/auth/*`) — fitur lain musik tidak terpengaruh.
> - Diuji: `node scripts/music-ui-test.mjs` (81 asersi, termasuk menu ⋮, link publik, baris
>   artis, dan seksi "Pilihan Orang Lain") + live `/api/music/artist-songs` (Tulus 71 lagu, Rex Orange County 92 lagu).
>   (Angka asersi itu sebelum seksi terjemahan — kini 94, lihat catatan update di atas.)

> ⚠️ **STATUS: DITUTUP — hanya bisa diakses saat Mode dev aktif.**
> Streaming YouTube dari IP server sering ditolak (bot check), jadi fitur Musik disembunyikan dari
> user biasa: ikon di rail, tab Musik, alamat `/music`, pemulihan antrean, dan `window.MU` hanya
> aktif saat **Mode dev** menyala (kode rahasia ke Reze → switch Mode dev di Pengaturan; matikan
> Mode dev saat musik jalan → lagu berhenti dan tab pulang ke Beranda). Pagar di sisi klien, pola
> kode rahasia yang lain — bukan keamanan; endpoint `/api/music/*` tetap ada di server untuk
> pengujian. Cara buka lagi untuk semua user: hapus pagar `devOn` di `paintMusic`/`setTab`
> (`public/index.html`, `public/shell.js`, `public/music.js`).

> 🔧 **Fix 20 Nov 2026 — pesan "bot check / IP" sering salah tuduh.** Dulu semua kegagalan stream
> (format tanpa URL karena eksperimen SABR YouTube, client TV yang memang minta login, gagal decipher)
> dilaporkan sebagai bot check. Sekarang tiap kegagalan punya kode sendiri (`bot_check`, `sabr`, `decipher`,
> `no_streams`, `session`) + `detail` per client; ANDROID_VR diulang 3x untuk kasus SABR (acak per-sesi);
> UA googlevideo memakai `cver` dari URL; DNS IPv4-dulu. Diagnosa: `/api/music/debug` (memakai jalur sungguhan)
> dan log Vercel `[music:resolve]`.


Tab **Musik** di rail/sidepanel: cari lagu, putar, antrean, lirik tersinkron (karaoke).
Musik **tetap berjalan** saat pindah tab (Beranda, Minigame, dst.) — seperti Spotify.

- Pencarian & metadata: **YouTube Music** (lewat library `youtubei.js` v18, lisensi MIT)
- Lirik: **LRCLIB** (gratis, tanpa auth)
- Cache & rate-limit: **Redis Upstash** kamu (otomatis terpakai, pola sama dengan `lib/online.js`)
- Arsitektur **proxy per-potongan**: server me-resolve URL stream (client ANDROID_VR dulu, lalu
  TV_SIMPLY/IOS/WEB_EMBEDDED/WEB) lalu menyalurkan audio lewat `/api/music/audio` dalam potongan
  1 MB (Range/206). Kenapa tidak langsung dari googlevideo: URL-nya **terikat IP yang me-resolve**
  (IP Vercel), jadi browser user kena 403 → lagu "tidak bisa diputar". Itu penyebab bug sebelumnya.

---

## Import link YouTube → tersimpan PERMANEN di data server (v1.3)

Tempel link YouTube apa pun di kolom cari (`youtube.com/watch?v=…`, `youtu.be/…`, `/shorts/…`,
`/live/…`, `/embed/…`, `music.youtube.com`, dengan/tanpa `https://`) → **bukan pencarian, tapi import**:
server audio Pterodactyl menyimpan metadata + file audio ke **folder library permanen** (`music/`,
env `LIB_DIR`) yang tidak pernah dibersihkan TTL cache dan bertahan restart panel. Lagu hasil import
muncul di seksi **“Lagu tersimpan di server”** di beranda tab Musik (badge PERMANEN, bisa diputar
kapan pun tanpa unduh ulang, bisa dihapus lewat “Lihat semua” — ketuk ikon tempat sampah 2x).

- Butuh **server audio Ptero v1.4+** (`server-audio-v1.4.zip`, lihat `UBAHAN-MUSIC-IMPORT.md`) dan
  env `MUSIC_PTERO_URL` + `MUSIC_PTERO_KEY` di Vercel (yang sudah terpasang dari setup musik Ptero).
- Endpoint baru: `/api/music/import?url=|id=` (simpan permanen; unduhan file jalan di latar di
  server), `/api/music/library` (daftar + status unduhan + total/kuota), `/api/music/library/remove?id=`.
- `/audio` dan `/prefetch` di server Ptero kini memakai **file permanen dulu** sebelum cache, jadi
  lagu import selalu instan. Unduhan yang terputus (panel restart) dilanjutkan otomatis.
- Kuota disk dijaga env `LIB_MAX_MB` (default 2048) di Ptero; folder `LIB_DIR` default `./music`.
- Tanpa `MUSIC_PTERO_URL`: endpoint balas 501 dan seksi server disembunyikan — pencarian, streaming,
  lirik, playlist, semuanya tetap jalan seperti biasa.

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
| `lib/music.js` | **baru** | router Express `/api/music/search\|stream\|lyrics\|translate` |
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
- ✅ `/api/music/stream` + `/api/music/audio` — diuji dengan server googlevideo tiruan (Range/206, 416, retry saat 403, cache resolve). Belum diuji ke YouTube asli.
- ⚠️ (catatan lama) `/api/music/stream` — dari IP sandbox yang di-flag, semua client kena bot-check
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
2. Kalau kena: pasang cookie YouTube lewat env `YT_COOKIE` (cara paling gampang, pakai ekstensi):
   - Pakai akun Google **cadangan** (bukan akun utama), login di youtube.com.
   - Pasang ekstensi **Get cookies.txt LOCALLY**, buka youtube.com, klik ekstensi → **Export** (format Netscape) → dapat file `.txt`.
   - Buka file itu di Notepad, **Select All → Copy**.
   - Vercel → Project → Settings → Environment Variables → tambah `YT_COOKIE`, **paste isi file utuh** (multi-baris boleh; server mengubahnya sendiri ke format header). Simpan, lalu **Redeploy**.
   - ⚠️ JANGAN commit file cookies.txt ke GitHub / taruh di repo: isinya = kunci masuk akun Google. Cukup di env Vercel.
   - Cookie bisa kedaluwarsa (mingguan-bulanan); kalau mati lagi, ekspor ulang.
   Cek hasilnya: buka `https://web-kamu/api/music/debug` → harus muncul `"kesimpulan":"OK: server bisa mengambil audio"`.
3. Kalau masih gagal: pindah region function (Vercel → Settings → Functions → Region), atau
   cari diskusi terbaru issue `LuanRT/YouTube.js` soal PO token.

Yang JANGAN dilakukan:
- Jangan menyimpan file audio ke R2 ("sekalian di-download sekalian") — itu berubah jadi
  distribusi konten, risikonya jauh lebih tinggi daripada sekadar proxy streaming.

Catatan bandwidth: satu lagu ≈ 3–4 MB lewat function Vercel. Untuk pemakaian pribadi/kecil aman;
kalau ramai, pertimbangkan host lain untuk proxy. Env opsional `MUSIC_DIRECT=1` mengembalikan mode
lama (URL googlevideo langsung ke browser) — hanya berguna kalau server dan user satu IP (mis. dev lokal).

## Batasan & catatan jujur

- **URL stream kedaluwarsa ±6 jam** dan terikat IP pemesan. Server menyimpannya di memori 90 menit dan
  otomatis me-resolve ulang kalau googlevideo menolak; antrean tersimpan di localStorage user.
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
  |  terjemahan lirik ---------->  /api/music/translate --(cache Redis 7h)--> DeepL (oneshot, fal->kef)
```
