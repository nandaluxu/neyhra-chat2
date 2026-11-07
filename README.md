# neyhra chat

## Jalan lokal

    npm install
    cp .env.example .env   # isi FISH_API_KEY
    npm start              # butuh Node >= 20.6 (jalan lokal lewat dev.js)

## Voice

- Diatur di **Pengaturan → Fitur → Voice note**: nyalakan/matikan, bahasa voice (Indonesia/Jepang), subtitle.
- Menyalakan voice butuh kode (default `NANDAxFURINA`, bisa diganti lewat env `VOICE_CODE`). Tanpa login/session, kode disimpan di browser.
- Tiap balasan dibuat 3 bagian: `<id>` (chat), `<jp>` (subtitle Jepang), `<vn>` (teks voice note + tag ekspresi seperti `[laughing]`, `[sad]`, `[whisper]`, `(break)`).
- Ganti bahasa/nyalakan voice => sesi ChatGPT baru otomatis, riwayat tetap ikut.

### Banyak voice per karakter

`voiceId` di `char/<nama>.js` boleh satu string (seperti biasa) atau banyak:

    voiceId: [
      { label: 'Normal', id: 'abc123...' },
      { label: 'Manja',  id: 'def456...' }
    ]
    // atau cukup array string: ['abc123...', 'def456...']  -> label otomatis "Voice 1", "Voice 2"

Kalau ada lebih dari satu, di header chat muncul tombol titik tiga untuk memilih suara (disimpan per karakter di browser). Pilihan ini juga dipakai tombol "kirim ulang" voice note.
voiceId asli **tidak pernah dikirim ke browser**: yang keluar cuma `label` dan `key` (hash satu arah), server yang menerjemahkan `key` jadi voiceId saat memanggil Fish Audio.

## Indikator online

Pill "N online" di menu utama. Browser kirim heartbeat ke `/api/online` tiap 60 detik (hanya saat tab kelihatan); dianggap online kalau heartbeat terakhir < 150 detik.

- **Lokal**: jalan otomatis (hitung di memori).
- **Vercel**: serverless tidak punya memori bersama, jadi butuh Redis. Di dashboard Vercel: *Storage -> Marketplace -> Upstash Redis* (ada paket gratis), connect ke project, lalu redeploy. Env `UPSTASH_REDIS_REST_URL/TOKEN` (atau `KV_REST_API_URL/TOKEN`) terisi sendiri. Tanpa itu, indikatornya otomatis tidak ditampilkan dan sisanya tetap jalan normal.

## MongoDB (fitur baru)

Dipakai untuk fitur yang butuh data permanen (login sederhana, persona buatan user, dst). **Redis tidak diubah**: indikator online dan Chat Global tetap di Redis.

- **Env**: `MONGODB_URI` (wajib untuk mengaktifkan), `MONGODB_DB` (opsional). Atlas gratis (M0) cukup. Di Atlas: Network Access -> izinkan `0.0.0.0/0` supaya Vercel bisa masuk.
- **Kode**: `lib/mongo.js` -> `col('nama')`, `getDb()`, `ensureIndexes()`, `mongoEnabled()`. Klien di-cache di `globalThis` (aman untuk serverless) dengan pool kecil dan timeout 5 dtk.
- **Cek koneksi**: `GET /api/db/health` -> `{enabled, ok, ms}` (hanya ping, tidak menulis).
- **Uji tulis/hapus**: `npm run db:test` (insert, update, delete, lalu 200x tulis+hapus).
- Tanpa `MONGODB_URI`, fitur yang butuh Mongo harus menjawab "tidak aktif" (cek `mongoEnabled()`), sisanya jalan normal.

## Login & sinkron antar perangkat (butuh MongoDB)

Login sederhana, tujuannya memindahkan obrolan antar perangkat, **bukan** keamanan tinggi. Tanpa `MONGODB_URI`, bagian "Akun" di Pengaturan tidak muncul dan sisanya jalan normal.

- **UI**: Pengaturan -> Akun. Daftar/Masuk dengan username (3-20 karakter) + password (min 6). Setelah masuk, tombol **Sinkronkan sekarang**: ambil data akun, gabungkan ke perangkat ini (tidak menimpa), lalu simpan hasil gabungan ke akun. Ada juga Keluar dan Hapus akun (akun + cadangan cloud, butuh password).
- **Yang ikut disinkron**: teks obrolan 1-lawan-1, riwayat konteks, memori, hubungan karakter, dan nama. **Tidak ikut**: voice note (audio) dan chat grup. Pesan voice note tampil sebagai teks di perangkat lain. Pakai Ekspor/Impor JSON kalau butuh audio.
- **Batas**: data akun maks ±3,5 MB (batas body Vercel ±4,5 MB). Ini fitur "pindah data", bukan sinkron realtime: pesan yang dihapus di satu perangkat bisa muncul lagi saat sinkron dari perangkat lain, dan hubungan/riwayat konteks hanya diisi kalau di perangkat itu belum ada.
- **Keamanan**: password di-hash scrypt + salt acak; token sesi acak 256-bit (di DB hanya hash-nya, kedaluwarsa 60 hari, disimpan di localStorage `authtok`); pembatas laju per IP dan per username (disimpan di Mongo). Tidak ada reset password: lupa password = buat akun baru.
- **API** (semua POST, `lib/auth.js`): `/api/auth/register|login|me|logout|pull|push|delete`. Token lewat header `Authorization: Bearer ...`.
- **Koleksi**: `users` (username unik), `auth_sessions` (TTL), `userdata` (satu dokumen per user), `auth_rl` (TTL). Index dibuat otomatis saat request pertama.

## Deploy ke Vercel

1. Push folder ini ke GitHub, import di Vercel (framework: Other).
2. Isi Environment Variables: `FISH_API_KEY`, `FISH_MODEL` (opsional), `VOICE_CODE` (opsional), dan (opsional, untuk indikator online) integrasi Upstash Redis.
3. Deploy. `/api/*` jalan lewat `api/index.js`, halaman statis dari `public/`.

Server stateless: riwayat chat, nama, dan pengaturan disimpan di localStorage browser.

## Chat grup (fitur rahasia)

Grup 2-5 karakter yang saling membalas. Desain lengkap ada di `design.md`.

- **Membuka**: kirim pesan rahasia ke Reze (kodenya hash di `public/group.js`, konstanta `SECRET`). Pesan itu dicegat di browser: tidak dikirim ke ChatGPT maupun Fish Audio, tidak jadi bubble, tidak dicatat. Yang muncul cuma notifikasi di atas layar. Setelah itu menu utama punya tombol "Buat grup".
- **Mengganti kode**: buka console, jalankan `GX.hash('kode baru')`, tempel angkanya ke `SECRET`. Ini pagar UI, bukan keamanan.
- **Alur**: browser mengatur rantai giliran (satu request = satu karakter bicara). Server stateless: `POST /api/chat` dengan field tambahan `group` (`members`, `muted`, `scene`, `replyTo`, `depth`) dan riwayat `[pengirim, teks]`. Respons ditambah `next` (id anggota atau `null`). Tanpa field `group`, chat 1-lawan-1 sama persis seperti dulu.
- **Rem**: konstanta di `CFG` (`public/group.js`): `MAX_CHAIN`, `MAX_PER_CHAR`, `ACCEPT`, `AUTO_CHAIN`. Server memvalidasi anggota ke `char/`, `next` hanya diterima kalau anggota yang tidak dibisukan.
- **Biaya**: satu giliran = satu panggilan ChatGPT anonim, jadi grup bisa kena limit lebih cepat. Kalau voice nyala, voice note dibuat otomatis tiap balasan dan tampilannya sama seperti chat biasa (waveform, progres, subtitle). Voice note diputar otomatis satu per satu: karakter berikutnya boleh sudah selesai mikir/merekam, tapi bubble-nya baru muncul dan bicara setelah voice note sebelumnya selesai. Kalau voice mati, balasan tampil sebagai teks.
- **Relasi**: field opsional di `char/<nama>.js`: `relations: { ram: '...' }` (hanya yang hadir di grup masuk prompt) dan `trait: '...'` (satu baris sifat di daftar anggota; kalau kosong diambil dari "Kepribadian:" di prompt).

## Chat global

Satu ruang obrolan untuk semua pengguna: teks saja, maks 256 karakter. Tombol **Chat global** ada di menu utama. Arsitekturnya **hybrid P2P (Redis + WebRTC)**:

- **Riwayat penuh ada di perangkat masing-masing** (IndexedDB, db `neyhra-gc`, maks 2000 pesan, tampilan 300 terakhir) dan ditukar antar-browser lewat **WebRTC DataChannel** (signaling lewat server).
- **Redis hanya menyimpan 10 pesan terbaru dengan TTL 24 jam** — jalur bootstrap pengguna baru dan fallback kalau P2P gagal, bukan penyimpanan utama. Redis Pub/Sub sengaja tidak dipakai: serverless tidak bisa memegang subscription dan itu bukan penyimpanan event.
- **Realtime**: pesan baru didorong langsung ke peer yang terhubung (relay terbatas, maks 3 lompatan di dalam mesh, maks 3 koneksi per pengguna). Di luar mesh, pesan sampai lewat polling adaptif: 3 dtk saat ramai, melambat ke 10 dtk saat sepi (bisa diatur lewat env `GC_POLL_BASE`/`GC_POLL_BURST`, dikirim ke client saat sync).
- **Keamanan**: server yang membuat id pesan (UUID), timestamp, dan menstempel nama; teks divalidasi (1–256 karakter, karakter kontrol dibuang); rate-limit per clientId (6 pesan/12 dtk, signaling 60/12 dtk, heartbeat 90/15 dtk). Setiap pesan **ditandatangani kunci ECDSA P-256** yang dibuat sekali dan disimpan di Redis — browser memverifikasi tanda tangan pesan yang diterima dari peer, jadi peer jahat tidak bisa memalsukan/mengubah pesan. Signaling juga divalidasi: `from` harus tercatat hidup di presence dan ukurannya dibatasi.

### Notifikasi Chat Global

- Menu utama sekarang cuma berisi **nama, Pengaturan, dan Chat global**. Voice note dan Memori pindah ke **Pengaturan → Fitur**.
- **Pengaturan → Notifikasi → "Notifikasi Chat Global"** (switch, default nyala, disimpan di localStorage `gcn`). Kalau nyala, ada pesan baru dari orang lain di Chat Global akan memunculkan banner di atas layar di mana pun kamu berada (menu, chat dengan karakter, chat grup). Tap banner untuk langsung membuka Chat Global; hilang sendiri setelah ~5 detik. Beberapa pesan beruntun digabung ("Budi · 3 pesan"). Tombol Chat global di menu juga dapat badge jumlah pesan yang belum dibaca.
- Saat tab disembunyikan dan izin notifikasi browser sudah diberikan (diminta sekali saat switch dinyalakan), muncul juga notifikasi sistem.
- Cara kerja: `GlobalChatAdapter.keepAlive(true)` membuat adapter tidak tidur walau ruang Chat Global ditutup, jadi polling tetap jalan (tiap 3-10 dtk, 30 dtk kalau tab tersembunyi). Konsekuensinya setiap pengguna dengan notifikasi nyala ikut memakai kuota Redis; kalau terasa berat, ubah default di `globalchat.js` (`store.get(NKEY) !== '0'` menjadi `=== '1'`). Pesan dianggap baru kalau `ts`-nya lebih baru dari semua pesan yang sudah terlihat, jadi riwayat yang baru disinkronkan tidak memicu notifikasi.

### File

- `public/globalchat.js` — UI (tidak tahu soal jaringan).
- `public/globalchat.adapter.js` — adapter sungguhan yang mengisi `window.GlobalChatAdapter` (kontrak sama seperti yang didokumentasikan di kepala `globalchat.mock.js`). Mengurus IndexedDB, polling, WebRTC, verifikasi tanda tangan, dan tombstone. `globalchat.mock.js` tidak lagi dimuat (disimpan sebagai referensi kontrak).
- `lib/gc.js` — router API. `lib/gcstore.js` — lapisan Redis (REST ala Upstash / TCP RESP2 / memori lokal, pola sama seperti `lib/online.js`; semua operasi dibungkus satu skrip Lua = satu perintah, hemat kuota Upstash).

### API (semua POST, satu domain dengan frontend)

- `/api/gc/sync` — heartbeat presence + daftar peer + pesan baru sejak `since` + signaling untuk saya + tombstone/watermark + kunci publik + interval polling. Dipanggil tiap beberapa detik selama ruang dibuka.
- `/api/gc/send` — kirim pesan (`clientId`, `name`, `text`). Balasan berisi pesan final yang sudah ditandatangani.
- `/api/gc/signal` — signaling WebRTC (`from`, `to`, `t`: o/a/i, `d`). Hanya diterima kalau `from` ada di presence.
- `/api/gc/delete` — hapus satu pesan (`code`, `id`) atau semua (`code`, `all:1`). `code` divalidasi di backend dengan hash yang sama seperti Mode dev di browser (cyrb53, default sama dengan `DEV_SECRET`; bisa diganti lewat env `GC_DEV_HASH` untuk pengujian). Tanpa auth baru.

### Penghapusan (Mode dev)

Tombol tempat sampah per bubble dan "Hapus semua pesan" (panel dev, keduanya tap dua kali) memanggil adapter yang mengirim kode dev ke `/api/gc/delete`. Kode ditangkap otomatis saat Mode dev dibuka (pembungkus `GX.hash`), atau diminta lewat prompt kalau halaman dimuat ulang; validasi sebenarnya tetap di server. Hasil penghapusan adalah **tombstone persisten**: id pesan masuk ZSET `neyhra:gc:tombs` (TTL 60 hari), "hapus semua" menaikkan watermark `neyhra:gc:clear` (pesan dengan `ts <= watermark` dianggap terhapus). Tombstone disebarkan lewat polling, dibroadcast lewat P2P, dan **disimpan permanen di IndexedDB** setiap pengguna — jadi pesan yang dihapus tidak bisa muncul lagi lewat IndexedDB, Redis, maupun transfer P2P. Pengguna yang offline menerima tombstone begitu kembali (selama masih dalam TTL Redis, atau selamanya lewat peer yang sempat menerimanya).

### Keterbatasan yang disadari

- **Tanpa TURN**: hanya STUN publik. Dua pengguna di NAT simetris tidak bisa terhubung P2P — chat tetap jalan lewat polling, hanya tidak realtime (ini alasan utama arsitektur hybrid).
- **Antara dua polling bisa ada pesan terlewat dari jalur Redis** (Redis hanya 10 terakhir). Celah ini ditambal: adapter meminta celah itu ke peer yang terhubung (`gapFill`), dan pertukaran riwayat P2P memakai batch maks 25 pesan dengan batas ukuran frame.
- **Tombstone di Redis berumur 60 hari**. Kalau semua pengguna yang pernah menerimanya hilang selamanya DAN Redis-nya kedaluwarsa, pesan lama dari IndexedDB orang yang tidak pernah menerima tombstone bisa muncul lagi di transfer P2P. Untuk alat dev di aplikasi ini risikonya diterima.
- **Identitas tidak diautentikasi**: siapa pun bisa memakai nama apa pun (sama seperti seluruh aplikasi, tanpa login). Rate-limit membatasi spam; presence bisa "dipenuhi" id palsu oleh penyerang yang sengaja menembak API — paling berdampak ke hitungan "N aktif" dan koneksi P2P yang gagal (self-healing).
- **Kunci tanda tangan ikut hilang kalau Redis di-flush** — pesan lama yang tersimpan di peer akan gagal verifikasi dan dibuang.
- Butuh Redis (sama seperti indikator online). Di Vercel tanpa env Redis, semua endpoint `/api/gc/*` menjawab `enabled:false` dan UI menampilkan status offline dengan alasan; riwayat lokal tetap bisa dibaca.

## Tema, pencarian, ringkasan (public/extras.js + extras.css)

- **Tema & aksen** (Pengaturan → Tampilan): mode Ikuti sistem / Terang / Gelap, dan switch "Warna aksen per karakter". Warna khas tiap karakter dihitung di browser dari rata-rata rona foto avatarnya (di-cache di localStorage `ac:<id>`), lalu dipakai untuk gelembung pesanmu, tombol kirim, dan gelombang voice note di chat karakter itu. Foto abu-abu = tanpa aksen. Chat grup tidak memakai aksen.
- **Cari isi semua obrolan**: ketik minimal 2 huruf di kotak cari panel "Lihat semua karakter"; hasil dari pesan di semua karakter muncul di atas daftar (terbaru dulu, maks 30). Tap hasil untuk membuka chat dan melompat ke pesannya. Hanya chat 1-lawan-1 (chat grup belum ikut), dan terbatas pada 150 pesan terakhir per karakter (`LOGMAX`).
- **Ringkasan harian** (Pengaturan → Fitur): Hari ini / Kemarin / 7 hari terakhir: jumlah pesan, balasan, voice note, karakter teratas, kata yang sering dipakai, jam paling ramai, dan streak. "Bagikan sebagai gambar" membuat PNG 1080x1350 lewat canvas (Web Share bila ada, kalau tidak diunduh). Semua dihitung di perangkat dari `log:<id>`.

## Hubungan & mood (chat 1-lawan-1)

Karakter tidak langsung suka: tiap karakter mulai dari **Asing** dan hubungannya naik pelan-pelan lewat obrolan. Lihat lewat **tap foto/nama karakter di header chat** -> panel Profil (tahap hubungan, bar kedekatan, mood, daftar tahap, tombol Reset hubungan).

- **Tahap** (`lib/relation.js`, `STAGES`): Asing 0, Kenalan 12, Teman 30, Dekat 55, Spesial 80 (skala 0-100). Tiap tahap punya `rule` (masuk prompt, mengatur seberapa dekat/terbuka karakter) dan `desc` (tampil di panel). **Mood** 0-100 (netral 50) dengan label di `MOODS`.
- **Cara menghitung**: model menambahkan blok `<rel>+2</rel><mood>-3</mood>` di akhir balasannya. Blok itu **tidak tampil di chat**: server membuangnya dari teks, membatasi angkanya (rel -10..+4, mood -15..+15), lalu mengirim `dRel` dan `dMood` ke browser. Browser yang menambahkannya ke skor.
- **Penyimpanan**: server tetap stateless. Skor disimpan di localStorage `rel:<id>` (ikut ekspor/impor JSON dan Reset semua) dan dikirim tiap pesan sebagai `rel: { rel, mood, shift }`. Blok `[STATUS HUBUNGAN ...]` ditempel di **setiap** pesan supaya tahap dan mood terbaru selalu terbaca model.
- **Supaya ada alurnya**: kenaikan rel dibatasi `DAILY_CAP` (15/hari, jadi dari Asing ke Spesial minimal beberapa hari), mood rendah menahan kenaikan rel (maks +1 kalau mood < 30), rayuan atau permintaan "naikin hubungan" disuruh dinilai 0/negatif, dan mood pelan-pelan kembali ke 50 (`MOOD_DECAY` poin/jam). Waktu naik/turun tahap, muncul toast dan pesan berikutnya membawa `shift: 'up'|'down'` supaya karakter menunjukkan perubahan sikap.
- **Cerita per karakter (opsional)**: di `char/<nama>.js` tambahkan `story: { 0: '...', 1: '...', 2: '...', 3: '...', 4: '...' }` (kunci = nomor tahap 0-4, atau nama tahap). Teksnya masuk prompt hanya saat hubungan ada di tahap itu, mis. `1: 'mulai penasaran pada user tapi gengsi mengakuinya'`.
- **Belum**: chat grup tidak memakai sistem ini (field `rel` hanya dikirim di chat 1-lawan-1).
- **Debug**: set env `DEBUG_RAW=1` untuk mencetak balasan mentah model di log server (berguna kalau format balasan aneh).
- **Format balasan**: semua paragraf harus di dalam satu `<id>...</id>`. Parser (`idText` di `lib/sessions.js`) juga menggabungkan kalau model membuat `<id>` per paragraf atau menulis sisanya di luar tag, dan jeda paragraf dipertahankan sampai ke bubble chat.

## Lainnya

- Taruh `reze.jpg` dll di `public/assets/`.
- Karakter baru: buat `char/<nama>.js` (lihat `char/reze.js`). Field wajib: `id`, `name`, `voiceId`, `prompt`. Opsional: `tagline`, `avatar`, `pronounce`, `trait`, `relations`.
