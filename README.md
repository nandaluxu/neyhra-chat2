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
- **Masuk = langsung sinkron, Keluar = simpan lalu hapus data perangkat**: tepat setelah Masuk/Daftar berhasil, sinkron jalan sendiri (tanpa perlu menekan tombol): obrolan akun digabung ke perangkat ini dan obrolan perangkat ini disimpan ke akun. Saat **Keluar** (tap dua kali): (1) semua obrolan disimpan ke akun lebih dulu, (2) kalau berhasil baru keluar lalu **semua data di perangkat ini dihapus** (localStorage + audio IndexedDB + sessionStorage, mirip Reset semua; hanya pilihan tema yang dipertahankan) dan halaman dimuat ulang. Kalau gagal menyimpan (mis. offline), data TIDAK dihapus dan tombol berubah jadi "Tap lagi untuk keluar tanpa menyimpan" untuk keluar paksa. Sesi yang kedaluwarsa (401) tidak menghapus data lokal. Karena voice note dan chat grup tidak ikut tersinkron, keduanya ikut hilang saat Keluar; ekspor JSON dulu kalau perlu. Logikanya ada di `index.html` (cari `flushCloud`, `wipeLocal`, `outEl().onclick`).
- **Sinkron otomatis**: berjalan senyap saat aplikasi dibuka dan saat tab kembali aktif (maks sekali per 20 dtk, hanya saat tab kelihatan). Murah: dicek dulu lewat `/api/auth/me` (waktu update cloud), data baru diunduh/dikirim hanya kalau ada yang berubah di cloud atau di perangkat. Kalau ada pesan baru dari perangkat lain saat sebuah chat sedang terbuka, muncul toast; buka ulang chat untuk melihatnya. Tidak ada polling.
- **Data tidak pernah tercampur antar akun** (mis. pinjam akun teman): perangkat mencatat pemilik datanya di localStorage `dataowner` (= `uid` akun dari server, bukan nama tampilan yang bisa diganti; `uid` ikut di respons `register|login|me`). Saat **Masuk/Daftar** ke akun yang uid-nya BERBEDA dari pemilik data di perangkat dan masih ada obrolan lokal (jalur yang tidak lewat tombol Keluar, mis. sesi habis atau token dicabut server), muncul konfirmasi: kalau lanjut, data lama dihapus dulu (token akun baru dipertahankan), halaman dimuat ulang, lalu sinkron otomatis mengambil data akun barunya; kalau batal, sesi barunya langsung ditutup dan data tidak diubah. Data tamu (belum ada pemilik) tetap digabung ke akun yang masuk. Sebagai pengaman tambahan `syncCloud` menolak sinkron kalau uid akun != pemilik data, jadi data akun lain tidak pernah terkirim ke akun ini. Tab lain di browser yang sama ikut memuat ulang saat login/logout/hapus data terjadi di tab lain (event `storage`).
- **Yang ikut disinkron**: teks obrolan 1-lawan-1, riwayat konteks, memori, hubungan karakter, dan nama. **Tidak ikut**: voice note (audio) dan chat grup. Pesan voice note tampil sebagai teks di perangkat lain. Pakai Ekspor/Impor JSON kalau butuh audio.
- **Pesan yang dulunya voice note**: di perangkat lain tampil sebagai teks dengan tombol **Jadikan voice note**. Tombol membuat audio baru lewat `/api/tts` dari teks ucapan yang ikut tersinkron (butuh voice sudah dinyalakan di perangkat itu, dan memakai kuota TTS), lalu mengganti bubble teks jadi voice note biasa. Suaranya bisa sedikit beda dari aslinya.
- **Batas**: data akun maks ±3,5 MB (batas body Vercel ±4,5 MB). Ini fitur "pindah data", bukan sinkron realtime: pesan yang dihapus di satu perangkat bisa muncul lagi saat sinkron dari perangkat lain, dan hubungan/riwayat konteks hanya diisi kalau di perangkat itu belum ada.
- **Keamanan**: password di-hash scrypt + salt acak; token sesi acak 256-bit (di DB hanya hash-nya, kedaluwarsa 60 hari, disimpan di localStorage `authtok`); pembatas laju per IP dan per username (disimpan di Mongo). Tidak ada reset password: lupa password = buat akun baru.
- **API** (semua POST, `lib/auth.js`): `/api/auth/register|login|me|logout|pull|push|delete`. Token lewat header `Authorization: Bearer ...`.
- **Koleksi**: `users` (username unik), `auth_sessions` (TTL), `userdata` (satu dokumen per user), `auth_rl` (TTL). Index dibuat otomatis saat request pertama.

## Coin & Gems (saldo akun)

Saldo ada di dokumen `users` (MongoDB), field `coins` dan `gems`. Akun baru otomatis dapat **150 coin dan 10 gems** (konstanta `START_COINS` / `START_GEMS` di `lib/auth.js`). Akun lama yang belum punya field itu diisi saldo awal sekali saat `/api/auth/me` pertama kali dipanggil (tidak menimpa saldo yang sudah ada).

- **Tampilan**: di navbar, tepat di bawah logo/nama "Neyhra Chat" (mode ikon: ikon di atas angka; expand: ikon + angka + "Coin"/"Gems"). Di mobile tampil di bar atas Beranda. Belum masuk akun: angka `–` (redup). Angka ≥ 10.000 ditulis ringkas (mis. `12,5 rb`).
- **Sumber data**: `/api/auth/register` dan `/api/auth/me` mengembalikan `coins` dan `gems`. Browser cuma membaca (cache di localStorage `wallet`, dihapus saat keluar/hapus akun). **Belum ada endpoint untuk mengubah saldo**; kalau nanti ada pemakaian/hadiah, ubah di server (`$inc` pada `users`), jangan dari client.
- **Aset**: `public/coin.svg`, `public/gems.png`.

## Foto profil di Cloudflare R2

Foto profil (Profil → Edit profil → ganti foto) disimpan di **Cloudflare R2**, dan **alamat fotonya** disimpan di MongoDB (`users.avatarUrl`, plus `users.avKey` = nama objek di bucket). Browser mengecilkan foto jadi 256x256 JPEG (maks 100 KB), server memeriksanya (harus JPEG sungguhan), mengunggahnya ke R2 dengan nama acak (`pfp/<acak>.jpg`), lalu menyimpan alamatnya. Ganti atau hapus foto otomatis menghapus objek lama; hapus akun menghapus fotonya juga. Kode: `lib/r2.js` (klien R2 tanpa library tambahan, tanda tangan AWS SigV4), `lib/profile.js`.

Kalau env R2 belum diisi, foto tetap disimpan di MongoDB seperti sebelumnya (koleksi `avatars`), jadi lokal tanpa R2 tetap jalan. Foto lama yang masih di MongoDB tetap tampil; pindahkan ke R2 dengan `npm run r2:migrate` (tambah `-- --dry` untuk hitung dulu).

### Pasang (sekali saja)

1. **Buat bucket**: dashboard Cloudflare → **R2 Object Storage** → **Create bucket** (mis. `neyhra-pfp`, lokasi Automatic). R2 bisa meminta metode pembayaran untuk mengaktifkan layanan; paket gratisnya (10 GB simpanan) lebih dari cukup untuk foto 100 KB.
2. **Buka akses baca publik**: masuk ke bucket → **Settings** → **Public access**.
   - Cepat untuk mencoba: **Public Development URL** → Enable → salin alamat `https://pub-xxxxxxxx.r2.dev`. (Cloudflare membatasi r2.dev dan tidak menyarankannya untuk produksi.)
   - Untuk produksi: **Custom Domains** → Connect Domain (mis. `pfp.domainmu.com`, domainnya harus di Cloudflare). Foto ikut di-cache CDN.
3. **Buat API token**: halaman R2 utama → **API** / **Manage API Tokens** → **Create API token** → izin **Object Read & Write** → batasi ke bucket tadi → Create. Salin **Access Key ID** dan **Secret Access Key** (Secret hanya muncul sekali). **Account ID** ada di halaman R2 yang sama (juga di alamat S3 API `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`).
4. **Isi env** (di `.env` lokal, dan di Vercel: Project → Settings → Environment Variables lalu **Redeploy**):

```
R2_ACCOUNT_ID=isi_account_id
R2_ACCESS_KEY_ID=isi_access_key_id
R2_SECRET_ACCESS_KEY=isi_secret_access_key
R2_BUCKET=neyhra-pfp
R2_PUBLIC_URL=https://pub-xxxxxxxx.r2.dev
# opsional, hanya kalau bucketmu berjurisdiksi EU: R2_ENDPOINT=https://<ACCOUNT_ID>.eu.r2.cloudflarestorage.com
```

   `R2_PUBLIC_URL` tanpa garis miring di akhir (kalau ada, dibuang otomatis). Jangan pernah commit `.env` atau menaruh Secret di kode.
5. **Tes**: `npm run r2:test` → harus mencetak `unggah: ok`, `baca publik: ok`, `hapus: ok`. Kalau gagal, pesannya menunjuk penyebabnya (token/izin salah, bucket salah, atau akses publik belum dinyalakan).
6. (Opsional) `npm run r2:migrate -- --dry` lalu `npm run r2:migrate` untuk memindahkan foto lama dari MongoDB ke R2.

Respons profil kini memuat `avatar` (alamat foto lengkap atau `''`); client memakainya langsung. Endpoint lama `GET /api/auth/avatar/:username` tetap ada untuk foto yang masih di MongoDB, dan mengalihkan (302) ke R2 kalau fotonya sudah di sana.

## Bonus (klaim harian + kode referal)

Tab ketiga di navbar (ikon hadiah), alamat `/bonus`. Perlu akun (MongoDB aktif dan sudah masuk); kalau belum, halamannya mengajak masuk. Semua hadiah dan saldo diputuskan server, browser cuma menampilkan.

- **Klaim harian**: siklus 7 hari (hari 1-6 coin, hari 7 gems). Hari berganti **pukul 00.00 WIB**. Melewatkan satu hari = hitungan mulai lagi dari hari 1; setelah hari 7 siklus mengulang. Klaim ganda (dua tab/perangkat) ditolak atomik lewat filter `bonusDay: { $ne: hariIni }`.
- **Kode referal**: tiap akun punya kode 8 karakter (dibuat sekali saat pertama buka tab Bonus). Teman memasukkan kode itu satu kali per akun; keduanya dapat hadiah. Tidak bisa memakai kode sendiri. Pemilik kode paling banyak dapat hadiah dari 50 teman (`REF_MAX_REWARDED`), temannya tetap dapat.
- **Atur hadiah**: konstanta `DAILY` (7 hari) dan `REF` (pemilik/pemakai kode) di atas `lib/bonus.js`. Tidak perlu mengubah kode lain.
- **API** (POST, token Bearer, `lib/bonus.js`): `/api/auth/bonus` (keadaan), `/api/auth/claim`, `/api/auth/redeem` (body `{ code }`). Respons memuat `coins`/`gems` terbaru, jadi saldo di navbar ikut berubah.
- **Field baru di `users`**: `bonusDay`, `bonusN`, `refCode` (index unik sparse), `invited`, `refBy`, `refAt`.
- **Client**: `public/bonus.js` + `bonus.css`. Menyegarkan lewat kejadian `shell:tab` (dari `Shell.setTab`) dan `acct` (dari `paintAcct`).

## Toko + Inventory (hadiah untuk menaikkan hubungan)

Tab **Toko** di navbar (alamat `/shop`). Perlu akun. Barang: Bunga 75, Coklat 120, Eskrim 125 coin. Ikon di `public/shop/*.svg`.

- **Beli**: pilih beberapa jenis + jumlah sekaligus, satu tombol "Beli". Coin berkurang dan barang masuk Inventory dalam satu operasi atomik di server (tidak bisa minus / dobel belanja).
- **Memberi hadiah**: di layar chat 1-lawan-1 ada tombol **+** di kanan kolom ketik. Isinya **Inventory** dan **Skenario Skrip**. Di Inventory pilih jenis + jumlah (boleh campur), tekan "Berikan". Barang berkurang, EXP + mood hubungan naik (tidak kena batas harian obrolan, karena dibayar coin), bubble roleplay `🎁 *memberikan 2 bunga dan 1 coklat*` muncul di chat, lalu karakter menjawab.
- **Atur barang/harga/EXP**: tabel `ITEMS` di atas `lib/shop.js` (price, exp, mood). Tidak perlu mengubah kode lain, kecuali menambah ikon `public/shop/<id>.svg`.
- **API** (POST, Bearer, `lib/shop.js`): `/api/auth/shop`, `/api/auth/shop/buy` (`{ items }`), `/api/auth/shop/gift` (`{ char, items }` -> `{ exp, mood }`).
- **AI**: `/api/chat` menerima field `gift: { items }`; bentuknya dicek ulang server (`giftLine`) lalu pesan ke AI diganti kalimat kejadian. Angka `<rel>/<mood>` dari AI diabaikan di giliran hadiah (EXP sudah dihitung server).
- **Field baru di `users`**: `inv` `{ <idBarang>: jumlah }`.
- **Client**: `public/shop.js` + `shop.css`; `submit({ gift:true, ... })` di `index.html`; `relApply(..., free)`.

## Minigame (coin dari main game)

Tab di navbar (ikon gamepad, di atas Bonus), alamat `/games`. Perlu akun (MongoDB aktif dan sudah masuk). Halaman berisi daftar game; sekarang baru **Tebak Angka** (kartu kedua "Segera hadir" sebagai tempat game berikutnya).

- **Tebak Angka**: server memilih angka 1-100, pemain punya 7 tebakan dan dijawab "lebih besar/kecil". Dengan membagi dua rentang, angka selalu ketemu dalam 7 tebakan. Hadiah menurut jumlah tebakan: 1-3 = 50, 4 = 40, 5 = 30, 6 = 20, 7 = 10 coin. Maksimal **5 kemenangan berhadiah per hari** (reset 00.00 WIB, anti farming); setelah itu tetap bisa main tanpa hadiah.
- **Tebak Gambar**: soal dibaca dari `data/tebakgambar.json` (lihat di bawah). Pemain melihat gambar, melihat pola huruf jawaban (jumlah kata dan huruf), lalu menjawab. Kesempatan 5 kali per soal. Hadiah: benar di jawaban pertama 40 coin, dikurangi 5 tiap jawaban salah (minimal 10). **Petunjuk** (isi `deskripsi` soal) bisa dibuka lewat tombol, hadiah soal itu jadi setengah. Maksimal 10 kemenangan berhadiah per hari. Soal yang sudah selesai atau dilewati tidak muncul lagi untuk akun itu sampai semua soal habis (lalu putaran baru).
- **Format `data/tebakgambar.json`**: array objek `{ "index": 0, "img": "https://...", "jawaban": "TANTANGAN SERU", "deskripsi": "..." }`. `index` = id soal (angka unik, kalau dihilangkan dipakai urutan array). `img` harus URL `http(s)`. `jawaban` dicocokkan tanpa memperhatikan huruf besar/kecil, spasi, dan tanda baca. `deskripsi` boleh kosong (soal itu tidak punya tombol petunjuk). Entri yang rusak dilewati. Jawaban dan deskripsi tidak dikirim ke browser sampai soal selesai atau petunjuk dibuka. File dibaca ulang otomatis kalau berubah (lokal); di Vercel perlu deploy ulang. Gambar dari situs lain bisa saja diblokir hotlink, kalau gagal dimuat pemain bisa melewati soalnya. `img` harus URL penuh (`http://` atau `https://`).
- **Atur hadiah Tebak Gambar**: objek `PIC` di atas `lib/picgame.js`.
- **Atur hadiah**: objek `GUESS` di atas `lib/games.js` (`rewards` = coin per jumlah tebakan, panjang array = jumlah tebakan maksimal; `dailyWins` = batas harian). Tidak perlu mengubah kode lain.
- **Anti curang**: angka rahasia hanya ada di server (koleksi `game_state`, TTL 24 jam) dan baru dikirim setelah pemain kalah. Penilaian tebakan, hadiah, dan `$inc` saldo semuanya di server dengan penjaga atomik (dua permintaan bersamaan tidak bisa menang dua kali), plus pembatas laju.
- **API** (POST, token Bearer, `lib/games.js`, dipasang lewat `mountGames` di `lib/auth.js`): `/api/auth/game` (keadaan, untuk memulihkan layar), `/api/auth/game/start`, `/api/auth/game/guess` (body `{ n }`). Respons memuat `coins`/`gems` terbaru, jadi saldo di navbar ikut berubah.
- **Field baru** di `users`: `gameDay`, `gameWins` (Tebak Angka), `picDay`, `picWins`, `picDone` (Tebak Gambar). Koleksi baru: `game_state`.
- **Client**: `public/games.js` + `games.css`. Menambah game baru: tambah entri di `GAMES` (`ready:true`), fungsi render layarnya, dan route aksinya di handler klik.

## Tools (tab "Tools", folder `public/tools/`)
Tab di navbar (ikon kunci inggris, di bawah Bonus; di HP ada di menu panel kiri), alamat `/tools` dan `/tools/<id>`. Isinya kumpulan alat kecil; tiap tool punya foldernya sendiri dan baru diunduh saat dibuka. Tool pertama: **AI Voice** (`/tools/voice`): ketik teks, pilih karakter (dipindai otomatis dari daftar karakter) dan suaranya kalau karakternya punya lebih dari satu, lalu langsung jadi audio yang bisa diputar/diunduh. Memakai `POST /api/tts` yang sama dengan voice note, jadi butuh kode voice yang sama (kotak kodenya muncul di halaman tool kalau belum aktif). Tidak ada kode server baru.
- **Menambah tool**: folder baru `public/tools/<id>/`, `Tools.register(...)` di `<id>.js`, satu entri di `LIST` pada `public/tools/tools.js`. Langkah lengkap: `public/tools/README.md`.
- `lib/app.js`: `express.static` sekarang `{ redirect: false }` (supaya `/tools` tidak dialihkan ke `/tools/` karena ada foldernya) dan rute `/tools`, `/tools/:id` menjawab `index.html`. `vercel.json`: rewrite `/tools` dan `/tools/:id`.

## URL per layar (public/router.js)

Tetap satu aplikasi (tanpa muat ulang), tapi tiap layar punya alamat dan tombol back/forward browser berfungsi:

| Alamat | Layar |
| --- | --- |
| `/` | Beranda |
| `/chat` | Obrolan Terakhir (termasuk chat grup yang lagi terbuka) |
| `/chat/<id>` | Obrolan Terakhir dengan chat karakter terbuka, mis. `/chat/reze` |
| `/global` | Chat Global |
| `/bonus` | Bonus (klaim harian, kode referal) |
| `/shop` | Toko (beli hadiah pakai coin) |
| `/games` | Minigame (Tebak Angka) |
| `/tools`, `/tools/<id>` | Tools (mis. `/tools/voice` = AI Voice) |
| `/settings` | Pengaturan |

- Bisa dibuka langsung lewat tautan. `id` yang tidak dikenal kembali ke `/`. Chat grup (fitur rahasia) memakai alamat `/chat`.
- `router.js` hanya mengamati layar yang tampil lalu memperbarui URL, dan membuka/menutup layar lewat fungsi yang sudah ada. Kode layar tidak diubah.
- Server harus menjawab alamat di atas dengan `index.html`: `rewrites` di `vercel.json` (Vercel) dan `app.get(...)` di `lib/app.js` (lokal).
- File CSS/JS di `index.html` ditulis dengan path absolut (`/group.js`, bukan `group.js`) supaya tetap termuat di alamat bersarang seperti `/chat/reze`. Tambah file baru? Tulis dengan `/` di depan juga.
- Tambah alamat baru: tambahkan di `curPath()` dan `apply()` di `router.js`, lalu satu aturan di `vercel.json` dan `lib/app.js`.

## Deploy ke Vercel

1. Push folder ini ke GitHub, import di Vercel (framework: Other).
2. Isi Environment Variables: `FISH_API_KEY`, `FISH_MODEL` (opsional), `VOICE_CODE` (opsional), dan (opsional, untuk indikator online) integrasi Upstash Redis.
3. Deploy. `/api/*` jalan lewat `api/index.js`, halaman statis dari `public/`.

Server stateless: riwayat chat, nama, dan pengaturan disimpan di localStorage browser.

## Chat grup (fitur rahasia)

Grup 2-5 karakter yang saling membalas. Desain shell ada di `design.md`.

- **Membuka**: kirim pesan rahasia ke Reze (kodenya hash di `public/group.js`, konstanta `SECRET`). Pesan itu dicegat di browser: tidak dikirim ke ChatGPT maupun Fish Audio, tidak jadi bubble, tidak dicatat. Yang muncul cuma notifikasi di atas layar. Setelah itu muncul tab "Grup" di Obrolan Terakhir dengan tombol "Buat grup".
- **Mengganti kode**: buka console, jalankan `GX.hash('kode baru')`, tempel angkanya ke `SECRET`. Ini pagar UI, bukan keamanan.
- **Alur**: browser mengatur rantai giliran (satu request = satu karakter bicara). Server stateless: `POST /api/chat` dengan field tambahan `group` (`members`, `muted`, `scene`, `replyTo`, `depth`) dan riwayat `[pengirim, teks]`. Respons ditambah `next` (id anggota atau `null`). Tanpa field `group`, chat 1-lawan-1 sama persis seperti dulu.
- **Rem**: konstanta di `CFG` (`public/group.js`): `MAX_CHAIN`, `MAX_PER_CHAR`, `ACCEPT`, `AUTO_CHAIN`. Server memvalidasi anggota ke `char/`, `next` hanya diterima kalau anggota yang tidak dibisukan.
- **Biaya**: satu giliran = satu panggilan ChatGPT anonim, jadi grup bisa kena limit lebih cepat. Kalau voice nyala, voice note dibuat otomatis tiap balasan dan tampilannya sama seperti chat biasa (waveform, progres, subtitle). Voice note diputar otomatis satu per satu: karakter berikutnya boleh sudah selesai mikir/merekam, tapi bubble-nya baru muncul dan bicara setelah voice note sebelumnya selesai. Kalau voice mati, balasan tampil sebagai teks.
- **Relasi**: field opsional di `char/<nama>.js`: `relations: { ram: '...' }` (hanya yang hadir di grup masuk prompt) dan `trait: '...'` (satu baris sifat di daftar anggota; kalau kosong diambil dari "Kepribadian:" di prompt).

## Hapus pesan & "lanjut ngobrol sendiri" (chat 1-lawan-1)

Dua fitur baru di layar chat dengan karakter (`public/index.html`), hanya untuk chat 1-lawan-1 (di mode grup dan saat Skenario Skrip aktif otomatis nonaktif):

- **Hapus pesan satu per satu**. Desktop: **klik kanan** pesan → overlay menu *Salin teks / Hapus pesan ini / Mode seleksi* (hapus = tap dua kali untuk konfirmasi). HP: **tekan lama** pesan → langsung masuk **Mode seleksi** dengan pesan itu sudah terpilih (getar singkat); tap pesan lain untuk menambah pilihan, lalu **Hapus** di bar bawah (tap dua kali). *Salin teks* (dulu tekan lama langsung menyalin) ikut pindah ke menu klik kanan dan ke bar seleksi (saat tepat satu pesan dipilih). Menghapus membuang pesan dari `log:` (tampilan), audio voice note di IndexedDB, posisi putar terakhir (`pos:`), dan pasangan `[role, teks]` di `h:` — jadi konteks yang dikirim ke AI juga bersih dan AI tidak lagi "mengingat" pesan itu. Pemisah hari yang menganggung ikut dibuang dan daftar obrolan terbaru diperbarui (`Shell.touch`).
- **Tombol "lanjut ngobrol sendiri"** di samping pesan / voice note AI terbaru (hanya tampil kalau giliran terakhir adalah karakter). Menekannya mengirim `POST /api/chat` dengan field baru `cont: true` **tanpa pesan user**; server ("lib/sessions.js" `ask()`) mengganti baris "Pesan dari user" menjadi instruksi "lanjutkan obrolan sendiri sebagai <karakter>". Balasannya lewat jalur biasa (voice note, subtitle, EXP/mood, memori), tapi `h:` hanya bertambah `['char', ...]` tanpa `['user', ...]`. Di server `cont` hanya berlaku untuk chat 1-lawan-1 dan diabaikan di grup/skenario; client lama tanpa field ini tidak berubah.

## Chat global

Satu ruang obrolan untuk semua pengguna: teks saja, maks 256 karakter. Tombol **Chat global** ada di menu utama. Riwayat disimpan di **MongoDB**; **Redis** dipakai untuk presence, rate-limit, dan feed realtime:

- **Riwayat penuh di MongoDB** (koleksi `gc_messages`, tanpa TTL): `{ _id, senderId, senderName, text, ts, replyTo, au?, av? }`, index `{ ts: -1, _id: -1 }` (dibuat otomatis lewat `ensureIndexes`). Tidak ada penyimpanan lokal di browser, jadi riwayat sama di semua perangkat.
- **Pagination**: browser memuat 30 pesan terbaru saat terhubung (`/api/gc/history`), lalu halaman yang lebih lama saat pengguna menggulir ke atas (kursor `before: {ts, id}`, maks 50 per halaman, urutan stabil karena `ts` lalu `_id`).
- **Realtime lewat polling adaptif** (tanpa P2P/WebRTC): 3 dtk saat ramai, melambat ke 10 dtk saat sepi (env `GC_POLL_BASE`/`GC_POLL_BURST`, dikirim ke client saat sync). `/api/gc/sync` membaca **feed Redis** (10 pesan terbaru, TTL 24 jam, hanya salinan cepat). Kalau klien tertinggal lebih dari 10 pesan, server menambal dari Mongo.
- **Redis**: presence (`live`, aktif < 30 dtk), rate-limit, feed `msgs`, serta tombstone/watermark penghapusan. Redis Pub/Sub sengaja tidak dipakai (serverless tidak bisa memegang subscription).
- **Keamanan**: server yang membuat id pesan (UUID), timestamp, dan menstempel nama; teks divalidasi (1–256 karakter, karakter kontrol dibuang); rate-limit per pengirim (6 pesan/12 dtk, heartbeat 90/15 dtk, riwayat 30/15 dtk). Rate-limit dicek **sebelum** menulis ke Mongo.
- **`replyTo`**: field opsional (id pesan yang dibalas, UUID atau `null`) diterima `/api/gc/send`, disimpan, dan ikut keluar di semua balasan. UI-nya ada: tombol **balas** di bubble terakhir tiap grup pesan (hover di desktop, selalu tampil di layar sentuh), cuplikan pesan yang dibalas di dalam bubble (tap untuk lompat + sorot sejenak ke pesan asalnya; kalau pesan asal tidak ada di tampilan, tampil "Pesan asli tidak tersedia"), dan pratinjau di atas kolom ketik yang bisa dibatalkan. `GlobalChatAdapter.send(text, replyTo)` meneruskannya. Keberadaan pesan yang dibalas tidak dicek di server.
- **Identitas pengirim = akun, bukan browser**: `senderId` tamu = `clientId` (UUID per browser, `localStorage.cid`). Kalau pengirim masuk akun (token Bearer sah di `/api/gc/send`), server menimpa `senderId` dengan **id tetap akun** `gcSenderId(uid)` (`lib/auth.js`: `'a'` + 32 hex dari SHA-256 uid; uid tidak pernah tampil di publik), tidak bisa dipalsukan client. Jadi akun yang sama di browser/perangkat berbeda terbaca sebagai satu orang: bubble "saya", pengelompokan pesan, warna avatar, dan notifikasi pesan baru konsisten. Client mendapat id itu dari `gid` di respons `register|login|me` (localStorage `gid`; dipakai hanya selama ada token). `clientId` (`cid`) tetap dipakai untuk presence dan rate-limit karena itu memang per browser. **Pesan lama** (dikirim sebelum perbaikan ini, `senderId` = `cid` browser asalnya, sudah ditandatangani sehingga tidak diubah) tetap dikenali sebagai "saya" lewat `gcIsMine(m)` di `index.html`, yang benar kalau salah satu terpenuhi: (1) `senderId` = `cid` browser ini; (2) `senderId` = id tetap akun (`gid`); (3) `senderId` ada di daftar **cid yang ditautkan ke akun**: setiap kali browser yang sedang login membuka aplikasi, `/api/auth/me` menerima `clientId` (cid) dan server menyimpannya di `users.gcids` (maks 30 terakhir, hanya dicatat kalau token sah, hanya dikirim balik ke pemilik akun), lalu daftar itu dikirim ke semua browser akun yang sama lewat field `cids` (localStorage `gcids`); (4) stempel server `au` (username) pada pesan sama dengan username akun ini (`gu`). Pesan lama dari browser yang belum pernah dibuka lagi setelah update dan tanpa `au` (pengirim tanpa foto profil) baru ikut tampil di kanan setelah browser itu dibuka sekali dalam keadaan login. Saat tertaut, pesan beruntun dari id berbeda tapi orang yang sama juga dikelompokkan jadi satu (`authorKey`). `cid` baru (mis. setelah Keluar menghapus data) tidak otomatis ditautkan ke akun lain: penautan hanya terjadi untuk akun yang sedang login.

### Nama & foto di Chat Global
Nama dan foto di mana pun (sapaan Beranda, nama yang dikirim ke karakter, Chat Global) **diambil dari Profil** (tab Profil → Edit). Tidak ada lagi tombol "Isi namamu" di Beranda. Belum masuk akun: sapaan umum di Beranda dan pengirim "Tamu" di Chat Global.
- `POST /api/gc/send` menerima token Bearer (opsional). Token sah: `senderName` = nama profil, dan pesan diberi `au` (username) + `av` (versi foto) kalau akun punya foto. Tanpa token: pengirim "Tamu"/nama dari body seperti dulu.
- Browser membuat alamat foto sendiri dari pola tetap `/api/auth/avatar/<au>?v=<av>` (satu domain), jadi `au`/`av` palsu tidak bisa dipakai memuat gambar dari situs lain.
- Pesan lama (tanpa `au`/`av`) tetap tampil dengan huruf awal.

### Notifikasi Chat Global

- Menu utama sekarang cuma berisi **Pengaturan dan Chat global**. Voice note dan Memori pindah ke **Pengaturan → Fitur**.
- **Pengaturan → Notifikasi → "Notifikasi Chat Global"** (switch, default nyala, disimpan di localStorage `gcn`). Kalau nyala, ada pesan baru dari orang lain di Chat Global akan memunculkan banner di atas layar di mana pun kamu berada (menu, chat dengan karakter, chat grup). Tap banner untuk langsung membuka Chat Global; hilang sendiri setelah ~5 detik. Beberapa pesan beruntun digabung ("Budi · 3 pesan"). Tombol Chat global di menu juga dapat badge jumlah pesan yang belum dibaca.
- Saat tab disembunyikan dan izin notifikasi browser sudah diberikan (diminta sekali saat switch dinyalakan), muncul juga notifikasi sistem.
- Cara kerja: `GlobalChatAdapter.keepAlive(true)` membuat adapter tidak tidur walau ruang Chat Global ditutup, jadi polling tetap jalan (tiap 3-10 dtk, 30 dtk kalau tab tersembunyi). Konsekuensinya setiap pengguna dengan notifikasi nyala ikut memakai kuota Redis; kalau terasa berat, ubah default di `globalchat.js` (`store.get(NKEY) !== '0'` menjadi `=== '1'`). Pesan dianggap baru kalau `ts`-nya lebih baru dari semua pesan yang sudah terlihat, jadi riwayat yang baru disinkronkan tidak memicu notifikasi.

### File

- `public/globalchat.js` — UI (tidak tahu soal jaringan).
- `public/globalchat.adapter.js` — adapter sungguhan yang mengisi `window.GlobalChatAdapter` (kontrak sama seperti yang didokumentasikan di kepala `globalchat.mock.js`, ditambah `keepAlive` dan `loadOlder`). Mengurus muat riwayat per halaman, polling, kirim, dan penghapusan. `globalchat.mock.js` tidak lagi dimuat (disimpan sebagai referensi kontrak).
- `lib/gc.js` — router API (riwayat + kirim + hapus di MongoDB). `lib/gcstore.js` — lapisan Redis (REST ala Upstash / TCP RESP2 / memori lokal, pola sama seperti `lib/online.js`; operasi dibungkus satu skrip Lua = satu perintah, hemat kuota Upstash).

### API (semua POST, satu domain dengan frontend)

- `/api/gc/sync` — heartbeat presence + pesan baru sejak `since` (feed Redis, ditambal dari Mongo kalau tertinggal; `more:true` = masih ada sisa) + tombstone/watermark + interval polling. Dipanggil tiap beberapa detik selama ruang dibuka.
- `/api/gc/history` — riwayat dari Mongo: `{ clientId, before?: {ts, id}, limit? }` → `{ msgs (urut naik), more, t0, wm }`. Tanpa `before` = halaman terbaru.
- `/api/gc/send` — kirim pesan (`clientId`, `name`, `text`, `replyTo?`). Disimpan ke Mongo, lalu ke feed Redis. Balasan berisi pesan final.
- `/api/gc/delete` — hapus satu pesan (`code`, `id`) atau semua (`code`, `all:1`), dihapus dari Mongo + tombstone/watermark di Redis. `code` divalidasi di backend dengan hash yang sama seperti Mode dev di browser (cyrb53, default sama dengan `DEV_SECRET`; bisa diganti lewat env `GC_DEV_HASH` untuk pengujian). Tanpa auth baru.

### Penghapusan (Mode dev)

Tombol tempat sampah per bubble dan "Hapus semua pesan" (panel dev, keduanya tap dua kali) memanggil adapter yang mengirim kode dev ke `/api/gc/delete`. Kode ditangkap otomatis saat Mode dev dibuka (pembungkus `GX.hash`), atau diminta lewat prompt kalau halaman dimuat ulang; validasi sebenarnya tetap di server. Pesan dihapus permanen dari MongoDB; id-nya (atau watermark "hapus semua") dicatat di Redis selama 60 hari supaya klien yang sedang online ikut membuangnya lewat `/api/gc/sync`. Klien yang memuat ulang mengambil riwayat langsung dari Mongo, jadi tidak perlu tombstone.

### Keterbatasan yang disadari

- **Butuh Redis dan MongoDB**. Salah satu tidak terpasang → semua endpoint `/api/gc/*` menjawab `enabled:false` dan UI menampilkan status offline dengan alasannya.
- **Feed Redis hanya 10 pesan**. Celahnya ditambal dari Mongo saat klien tertinggal. Kalau Redis di-flush atau gagal menyimpan satu pesan padahal Mongo sudah menerimanya, pesan itu baru muncul di klien yang sedang terbuka setelah halaman dimuat ulang.
- **Riwayat tidak punya batas umur** (tanpa TTL), jadi koleksi `gc_messages` terus bertambah (±300 byte per pesan). Atlas gratis 512 MB; tambahkan index TTL di `ts` kalau perlu membatasi.
- **Identitas tidak diautentikasi**: siapa pun bisa memakai nama apa pun (sama seperti seluruh aplikasi, tanpa login). Rate-limit membatasi spam; presence bisa "dipenuhi" id palsu oleh penyerang yang sengaja menembak API — paling berdampak ke hitungan "N aktif".
- **Pesan lama yang tersimpan di IndexedDB `neyhra-gc` (versi P2P) tidak dipakai lagi** dan tidak dimigrasi; data itu hanya ada di perangkat masing-masing. Browser boleh menghapusnya.

## Skenario Skrip (mode roleplay: dua AI)

Mode roleplay yang sudah ada (switch di Pengaturan) dikembangkan jadi *interactive storytelling* dengan **dua AI** plus fitur skenario buatan sendiri. Semuanya menempel di chat 1-lawan-1 yang sekarang; tidak ada halaman/mode baru.

- **Scenario Director (AI 1)**: sutradara. Mengatur arah cerita, event, konflik, lokasi, suasana, karakter yang terlibat, dan pacing. Tidak menulis dialog karakter. Balasannya selalu satu objek JSON (`lokasi`, `suasana`, `event`, `tujuan`, `karakter`, `instruksi`, `panggil_lagi`) yang divalidasi dan di-clamp server. Dipanggil hemat: saat skenario dimulai, lalu tiap `panggil_lagi` pesan (3-8, ia atur sendiri), atau saat user melakukan aksi besar (narasi `*...*` panjang / pesan ≥400 karakter).
- **Character Actor (AI 2)**: karakter biasa (`lib/sessions.js`), plus blok **ARAHAN SUTRADARA** tiap pesan. Sesi provider-nya terpisah dari chat biasa (kunci `clientId:charId:scn`), jadi percakapan skenario tidak mencampoi obrolan normal. Responsnya bentuknya sama persis dengan `/api/chat` biasa: voice note, subtitle, hubungan, memori, dan riwayat tetap jalan.
- **Sesi dilanjutkan setelah reload**: auth + conversation id Director dan Actor disimpan di dokumen `rp_state` (MongoDB), lalu di-seed balik ke sesi in-memory saat instance serverless baru. Kalau sesi anon sudah kedaluwarsa, otomatis mulai baru dengan riwayat dari browser (pola yang sama seperti chat biasa).

### Panel & tombol

- Tombol clapperboard di footer chat (kiri tombol kirim), hanya muncul di chat 1-lawan-1. Panelnya: judul **Skenario Skrip**, deskripsi, daftar skrip, kuota `Skrip tersisa: N`, dan tombol **+ Skrip Baru**.
- Editor: **Tema Skrip** (placeholder "Masukkan judul atau tema...", maks 100 karakter) dan **Isi Skrip** (placeholder "Buat cerita baru dengan anda dan karakter anda...", maks 1000 karakter, ada penghitung). **AI Hasilkan** membuat pembukaan cerita dari tema (konteks: karakter terpilih + kepribadiannya + nama user; hasil maks 900 karakter, bisa diedit). **Jalankan Skrip** menjalankan apa yang sedang tertulis (tidak harus disimpan dulu); **Simpan** menyimpan ke MongoDB.
- Skrip tersimpan tampil sebagai **card landscape**: judul, cuplikan, avatar karakter di kanan dengan gradien transparan, dan tiga aksi (Edit, Hapus dua-tap, Jalankan).
- Setelah dijalankan: kartu "Skenario aktif" di area percakapan (judul, karakter, status) dengan pilihan **AI Mulai Duluan** / **Saya Mulai Duluan**, plus tombol **End Script**. Saat berjalan ada bar tipis "Skenario aktif: ..." + End Script di atas kolom ketik (elemen tetap, bukan overlay, jadi tidak menutupi chat). Mengetik saat fase memilih otomatis dianggap "Saya Mulai Duluan".

### Kuota & penyimpanan

- **Maksimal 3 skrip per akun** (dihitung yang tersimpan; menghapus mengembalikan slot; skrip belum disimpan tidak pakai kuota). Kuota dijaga server lewat index unik `{userId, slot}` di koleksi `scripts`: klaim slot 0-2 atomik, jadi dua permintaan bersamaan tidak bisa lolos batas. Validasi juga di backend: tema 1-100 karakter, isi 1-1000, `charId` harus ada di `char/`.
- Koleksi `rp_state` (satu skenario aktif per user, index unik `userId`, TTL 7 hari): id user, judul, isi, karakter, fase (`choosing`/`running`), sesi Director/Actor, dan state cerita terakhir dari sutradara. Menjalankan skenario baru mengakhiri skenario lama otomatis (skrip tersimpan tidak ikut terhapus).
- Semua endpoint butuh akun (token Bearer) dan hanya menyentuh data milik sendiri.

### API (semua POST, `lib/scenario.js`, token Bearer)

`/api/scenario/list | save | delete | generate | start | state | begin | end`. Chat berjalan lewat `/api/chat` biasa dengan field tambahan `scenario: <id state>`; tanpa field itu semuanya seperti dulu (client lama tetap kompatibel).

## Tema, pencarian, ringkasan (public/extras.js + extras.css)

- **Tema & aksen** (Pengaturan → Tampilan): mode Ikuti sistem / Terang / Gelap, dan switch "Warna aksen per karakter". Warna khas tiap karakter dihitung di browser dari rata-rata rona foto avatarnya (di-cache di localStorage `ac:<id>`), lalu dipakai untuk gelembung pesanmu, tombol kirim, dan gelombang voice note di chat karakter itu. Foto abu-abu = tanpa aksen. Chat grup tidak memakai aksen.
- **Cari isi semua obrolan**: ketik minimal 2 huruf di kotak cari Beranda; hasil dari pesan di semua karakter muncul di atas daftar (terbaru dulu, maks 30). Tap hasil untuk membuka chat dan melompat ke pesannya. Hanya chat 1-lawan-1 (chat grup belum ikut), dan terbatas pada 150 pesan terakhir per karakter (`LOGMAX`).
- **Ringkasan harian** (Pengaturan → Fitur): Hari ini / Kemarin / 7 hari terakhir: jumlah pesan, balasan, voice note, karakter teratas, kata yang sering dipakai, jam paling ramai, dan streak. "Bagikan sebagai gambar" membuat PNG 1080x1350 lewat canvas (Web Share bila ada, kalau tidak diunduh). Semua dihitung di perangkat dari `log:<id>`.

## Hubungan & mood (chat 1-lawan-1): sistem EXP dan Level

Tiap karakter punya **Level hubungan 1-100** yang naik lewat **EXP** dari obrolan. Lihat lewat **tap foto/nama karakter di header chat** -> panel Profil (tahap, Lv, bar EXP menuju level berikutnya, EXP hari ini, mood, daftar tahap, tombol Reset hubungan).

- **Tahap** (`lib/relation.js`, `STAGES`, batas = level): Kenalan Lv 1-5, Teman 6-14, Sahabat 15-29, Spesial 30-49, **Pasangan Lv 50+**, Belahan Jiwa 75-100. Tiap tahap punya `rule` (masuk prompt, mengatur seberapa dekat/terbuka karakter) dan `desc` (tampil di panel). Karakter baru dikenal di Lv 1, tidak boleh flirting/manja sebelum tahap Spesial, dan baru berstatus pasangan di Lv 50.
- **Kurva EXP**: EXP dari level L ke L+1 = `EXP_BASE + EXP_STEP * L` (25 + 3L). Total EXP: Lv 6 = 170, Lv 15 = 665, Lv 30 = 2.030, **Lv 50 = 4.900**, Lv 75 = 10.175, Lv 100 = 17.325. Level makin tinggi makin mahal.
- **Cara menghitung EXP**: model tetap menulis blok `<rel>+2</rel><mood>-3</mood>` di akhir balasan (dibuang dari teks chat, di-clamp: rel -10..+4, mood -15..+15). Server mengubahnya jadi `dExp` (`readDeltas`): `<rel>` positif = `+3 EXP` per poin ditambah `+2 EXP` dasar tiap pesan (jadi obrolan biasa +1 = 5 EXP, +2 = 8 EXP, momen bermakna +4 = 14 EXP); `<rel>` 0 = 2 EXP dasar; negatif = `-4 EXP` per poin (maks -40). Mood < 30: tidak ada EXP dasar dan `<rel>` positif dibatasi +1 (orang yang lagi kesal tidak mudah luluh).
- **Batas harian**: `DAILY_CAP` = 200 EXP positif per hari per karakter. Dengan pemakaian sangat aktif (batas harian tercapai tiap hari) Lv 50 tercapai ~25 hari dan Lv 100 ~87 hari; pemakaian normal lebih lama. Rayuan atau permintaan "naikin hubungan" disuruh dinilai 0/negatif oleh prompt.
- **Atur kecepatan**: semua konstanta ada di kepala `lib/relation.js` (`EXP_BASE`, `EXP_STEP`, `DAILY_CAP`, `EXP_BASE_MSG`, `EXP_PER_POINT`, `EXP_PER_NEG`). Client mengambil kurva dan tahap dari `/api/relation`, jadi cukup ubah di satu tempat.
- **Penyimpanan**: server stateless. Yang disimpan hanya total EXP di localStorage `rel:<id>` (field `r`, penanda versi `v:2`; ikut ekspor/impor JSON, sinkron akun, dan Reset semua). Level dan tahap selalu dihitung dari EXP. Dikirim tiap pesan sebagai `rel: { rel: <EXP>, mood, shift }`; blok `[STATUS HUBUNGAN ...]` (Lv, tahap, mood) ditempel di **setiap** pesan.
- **Migrasi data lama**: data tanpa `v:2` (skala 0-100 versi lama) otomatis dikonversi: nilai lama 0-100 menjadi Lv 1-51 (`1 + lama/2`), mis. Teman(30) -> Lv 16, Spesial(80) -> Lv 41. Konversi berjalan di `relSan` dan aman dipanggil berulang.
- **Notifikasi**: toast tiap level naik/turun, dan toast khusus saat tahap berubah; pesan berikutnya membawa `shift: 'up'|'down'` supaya karakter menunjukkan perubahan sikap.
- **Cerita per karakter (opsional)**: di `char/<nama>.js` tambahkan `story: { 0: '...', 1: '...', ... }` (kunci = nomor tahap 0-5, atau nama tahap: Kenalan, Teman, Sahabat, Spesial, Pasangan, Belahan Jiwa). Teksnya masuk prompt hanya saat hubungan ada di tahap itu.
- **Belum**: chat grup tidak memakai sistem ini (field `rel` hanya dikirim di chat 1-lawan-1).
- **Debug**: set env `DEBUG_RAW=1` untuk mencetak balasan mentah model di log server (berguna kalau format balasan aneh).
- **Format balasan**: semua paragraf harus di dalam satu `<id>...</id>`. Parser (`idText` di `lib/sessions.js`) juga menggabungkan kalau model membuat `<id>` per paragraf atau menulis sisanya di luar tag, dan jeda paragraf dipertahankan sampai ke bubble chat.

## Shell UI (public/shell.js + shell.css)

- **Tab**: `#app[data-tab="home|recent|bonus"]` (Bonus: lihat bagian "Bonus"). Beranda = grid avatar semua karakter (satu-satunya tempat mulai chat baru). Obrolan Terakhir = daftar obrolan di kiri, chat di kanan, panel detail karakter (hubungan, mood, perjalanan, kotak memori) paling kanan. Chat terbuka (`#app.open`) hanya mungkin di tab `recent`.
- **Rail**: sidebar ikon (bottom bar di HP). Klik logo di Beranda untuk expand/ciutkan; di Obrolan Terakhir rail terkunci mode ikon.
- **Daftar obrolan**: tiap item punya menu titik tiga: Sematkan, Ganti nama (hanya tampilan di perangkat ini), Hapus. Tab "Grup" muncul setelah fitur rahasia terbuka.
- **localStorage baru**: `rail`, `lp` (panel daftar ditutup), `dp` (panel detail ditutup, hanya >= 1200px), `pins`, `alias:<id>`.
- **Aturan**: script utama (`index.html`) tidak boleh memanggil `Shell` di top-level karena `shell.js` dimuat sesudahnya. Pakai `window.Shell&&...` atau panggil dari event handler.

## Lainnya

- Taruh `reze.jpg` dll di `public/assets/`.
- Karakter baru: buat `char/<nama>.js` (lihat `char/reze.js`). Field wajib: `id`, `name`, `voiceId`, `prompt`. Opsional: `tagline`, `avatar`, `pronounce`, `trait`, `relations`.
