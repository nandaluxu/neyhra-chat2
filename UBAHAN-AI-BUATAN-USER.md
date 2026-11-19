# UBAHAN — AI buatan user ("AI Saya")

User yang sudah login bisa membuat karakter AI sendiri (maks 10/akun): nama, label, identitas, kepribadian,
gaya bicara, aturan tambahan, foto. Dikelola di **Profil > tab "AI Saya"**; langsung muncul di Beranda
(milik sendiri, atau milik semua orang kalau diset **Publik**) dan ikut hubungan, memori, grup, skenario, persona, proaktif. Suara dipilih dari suara karakter bawaan; tanpa voiceId AI tidak bisa voice note.

## File
| File | Perubahan |
|---|---|
| `lib/userchars.js` (baru) | endpoint `/api/auth/aichar/list|save|delete`, `GET aichar-av/:id`, sanitasi, kuota, purge |
| `lib/chars.js` | `loadChars(extraId?)` menggabungkan koleksi `user_chars` (cache 3 dtk); `buildCustomPrompt`, `canUseChar` |
| `lib/app.js` | `/api/chars` menyaring per token; `find(id, req)` + cek kepemilikan di chat/proactive/memory/tts; AI buatan selalu voice off; guard TTS |
| `lib/auth.js` | mount `mountUserChars`; hapus AI saat akun dihapus |
| `public/index.html` | `loadAllChars()` (kirim token, dipanggil ulang saat masuk/keluar & `window.reloadChars`) |
| `public/profile.js` | tab "AI Saya": daftar, form modal, hapus, tombol Chat |

## Penyimpanan
Koleksi MongoDB `user_chars` `{_id:"u_<16hex>", ownerId, name, tagline, identity, personality, speech, rules, public, av, avatarUrl/avKey (R2) | avData}` — dibuat otomatis. `public` = boolean, default `false` (AI lama tanpa field ini otomatis privat).

## Keamanan
- Default Privat: hanya pemilik yang melihat/memakai (`canUseChar`); id acak 64-bit. Kalau `public: true`, semua orang (termasuk tamu) bisa melihat & memakainya.
- Yang keluar ke publik lewat `/api/chars` hanya `id, name, tagline, avatar, creator` (+ `public`, `mine`). Identitas/kepribadian/gaya bicara/aturan tetap hanya di server dan di tab "AI Saya" milik pemilik.
- Edit, hapus, dan ubah status publik hanya bisa oleh pemilik (selalu difilter `ownerId`).
- Belum ada moderasi/laporan untuk AI publik.
- Teks user dibersihkan (tanda `<>` dibuang agar tak memalsukan tag format balasan) dan prompt memuat penegasan "ikuti ATURAN FORMAT".
- Rate limit simpan/foto/hapus; foto JPEG ≤100 KB (R2 atau fallback MongoDB).
- Catatan: endpoint skenario/scene/vision/shop memakai id karakter tanpa cek pemilik (id tak bisa ditebak); tambahkan `canUseChar` di sana kalau mau ketat.

## Suara (update)
- **User**: di form AI ada pilihan "Suara" (daftar dari `GET /api/voices`, hanya key+label; id asli tidak keluar server). Disimpan sebagai `voiceRef {char,key}`.
- **Dev** (Mode dev aktif + kode dev): di form AI muncul "Suara dev" — satu baris `Label | voiceId` (Fish Audio), simpan lewat `POST /api/auth/dev/aivoice/set` (juga `.../list`, bisa lintas pemilik). Disimpan di `voiceIds`, digabung dengan suara pilihan user; tiap perubahan dicatat di log server.
- **Tanpa voiceId** (`voices=[]`): server memaksa `voice.on=false` dan `/api/tts` ditolak; `/api/chars` memberi flag `novoice`, client (`canVoice`) tidak meminta voice note di chat, grup, dan skenario walau voice dinyalakan.
- File tambahan berubah: `lib/dev.js` (export `okDev`), `public/group.js`, `public/scenario.js`.

## Halaman detail karakter (update)
Ketuk karakter di Beranda sekarang membuka **halaman detail** dulu (`public/cdetail.js` + `cdetail.css`, dipasang di `index.html`); chat baru dibuka lewat tombol **Obrolan**.
- Nyata: nama, label, foto, **"Dibuat oleh"** (AI buatan = nama pemiliknya dari `/api/chars` field `creator`; bawaan = "Neyhra"), "Diperbarui" (`updated`), Robot Terkait (label sama).
- Placeholder ("Tidak ada deskripsi. Fitur ini belum selesai."): Atribut Persona, Dukung, bagikan. (Sapaan, Story, Komentar, likes sudah nyata, lihat bagian di bawah.) (Story, Komentar, likes sudah nyata, lihat bagian di bawah.)
- Tutup: tombol Kembali, Escape, atau pindah tab. Belum punya URL sendiri / tombol back browser.
- File tambahan: `public/cdetail.js`, `public/cdetail.css`, `lib/app.js` (creator, updated), `lib/chars.js` (updatedAt).

## Privat / Publik (update)
- Form AI (Profil > AI Saya) punya saklar **Publik** (default mati = Privat). Kartu AI di tab menampilkan lencana Privat/Publik.
- `POST /api/auth/aichar/save` menerima `public: true|false` (tanpa field = status tidak diubah; AI baru = privat). `aichar/list` mengembalikan `public`.
- `lib/chars.js`: `toChar` membawa `public`; `canUseChar` = bawaan, atau `public`, atau pemilik. Fallback label AI tanpa tagline jadi "AI buatan pengguna".
- `lib/app.js` `/api/chars`: tamu pun dapat AI publik. **Pembuat dicari per pemilik** (query `users` untuk `ownerId` yang tampil), bukan lagi diasumsikan akun yang sedang masuk. Field tambahan: `public`, `mine` (milik akun yang sedang masuk), `creator {name, username, bio, avatar}` (kalau akun pembuat tak ditemukan: "Pengguna").
- Halaman detail (`public/cdetail.js`): "Dibuat oleh" + kartu pembuat memakai `creator` AI itu, jadi nama pembuat tampil untuk AI publik milik orang lain.
- Hapus AI / hapus akun sekarang membersihkan `persona_picks` semua user untuk AI itu (sebelumnya hanya milik pemilik), karena AI publik bisa dipilih persona-nya oleh orang lain.
- Kalau AI diubah publik -> privat: user lain tidak bisa chat lagi (server menjawab "Request tidak valid"); riwayat lokal mereka tetap ada di perangkat.
- File berubah: `lib/userchars.js`, `lib/chars.js`, `lib/app.js`, `public/profile.js`, `public/profile.css`, `public/cdetail.js`.

## Pembuat bisa dipencet + pembuat default (update)
- Halaman detail: nama di baris "Dibuat oleh", foto, dan nama di kartu pembuat bisa dipencet/Enter -> menutup detail lalu membuka profil akun itu (`PF.open(username)` di `public/profile.js`; URL jadi `/profile/<username>`). Tanpa username (fallback) = bukan tautan.
- Karakter bawaan (`char/*.js`) sekarang punya pembuat default: akun **nandasikma** (env `DEFAULT_CREATOR` untuk mengganti). `/api/chars` mencarinya sekali bersama pemilik AI buatan (satu query `users`) dan mengirimnya sebagai `creator`. Kalau akunnya tidak ada di database, kembali ke "Neyhra" tanpa tautan.
- File berubah: `lib/app.js`, `public/cdetail.js`, `public/cdetail.css`.

## Tombol Follow di detail karakter (update)
- Tombol "+ Follow" di kartu pembuat sekarang berfungsi: ikuti / berhenti mengikuti lewat endpoint yang sama dengan tab Profil (`POST /api/auth/follow`), dipanggil lewat `PF.follow` (= `toggleFollow` di `public/profile.js`) supaya hitungan Mengikuti/Pengikut dan cache profil ikut sinkron.
- Status awal diambil dari `POST /api/auth/profile` (`isFollowing`, `followsMe`, `isMe`): label "+ Follow" / "+ Follow balik" / "Mengikuti". Tombol dinonaktifkan sebentar sampai status awal termuat.
- Disembunyikan kalau pembuatnya akun sendiri atau tidak punya username (fallback Neyhra/Pengguna). Belum login: toast + overlay login. "Dukung" masih placeholder.
- File berubah: `public/cdetail.js`, `public/cdetail.css`, `public/profile.js`.

## Like & komentar di detail karakter (update)
- Tombol like, angka "likes", angka/tombol "Komentar", dan tab **Komentar** di halaman detail sekarang nyata (berlaku untuk karakter bawaan dan AI buatan user yang boleh dilihat pemanggil).
- **Like:** toggle per akun per karakter (optimistis, dibatalkan kalau server menolak). Belum login -> toast + overlay login. Satu like per akun (id gabungan `<charId>:<userId>`).
- **Komentar:** kotak tulis (maks 300 huruf), daftar terbaru dulu 20 per halaman + "Muat lebih banyak". Nama/foto penulis bisa dipencet -> profilnya. Hapus: penulisnya, atau pemilik AI buatan itu (dua langkah: Hapus -> Yakin?). Tamu boleh membaca, tidak boleh menulis.
- **Backend baru `lib/charsocial.js`** (dipasang di `lib/auth.js`): `charsocial`, `charlike`, `charcomments`, `charcomment`, `charcomment/delete`. Koleksi `char_likes` dan `char_comments` (index dibuat otomatis). Karakter harus ada dan lolos `canUseChar` (AI privat orang lain tidak bisa disukai/dikomentari). Pembatas laju: tulis per akun (8 komentar/menit, 60/jam), baca per IP.
- Pembersihan: hapus AI buatan (`aichar/delete`, `purgeUserChars`) menghapus like & komentarnya; hapus akun menghapus semua like & komentar milik akun itu.
- Belum ada: notifikasi ke pemilik AI saat disukai/dikomentari, laporan/moderasi komentar, jumlah obrolan (badge di foto masih "–").
- File: `lib/charsocial.js` (baru), `lib/auth.js`, `lib/userchars.js`, `public/cdetail.js`, `public/cdetail.css`.

## Kartu AI di Beranda (update)
- Kartu = frame foto 4:5 yang berisi info (nama & label tidak lagi di bawah frame). **Tampilan awal:** gradasi bawah dengan nama, label, foto profil pembuat (kiri), jumlah like & komentar (kanan; "–" sampai angka termuat, format 1,2rb / 1,5jt).
- **Hover (mouse) / fokus keyboard:** frame menggelap + foto zoom (zoom lama tetap); tampil foto AI kecil (bulat), nama, label, "oleh <pembuat>", bagian **Sapaan** (placeholder "Tidak ada deskripsi. Fitur ini belum selesai." muncul bertahap seperti diketik; langsung tampil penuh kalau `prefers-reduced-motion`) dan tombol **Ngobrol sekarang** (langsung membuka chat). Tata letak sebelum & sesudah hover berbeda (`.b-front` <-> `.b-back`). Layar sentuh tanpa hover hanya memakai tampilan awal.
- Ketuk/klik frame tetap membuka halaman detail. Tile sekarang `div` + tombol `.b-open` yang menutupi frame (supaya tombol "Ngobrol sekarang" tidak bersarang di dalam `<button>`).
- Endpoint baru `POST /api/auth/charstats` (lib/charsocial.js): `{ ok, stats: { <charId>: [likes, komentar] } }` sekali untuk semua kartu; hanya karakter yang boleh dilihat pemanggil; cache 15 dtk per instance. Like/komentar di halaman detail memperbarui kartu langsung lewat event `charstats`.
- Foto pembuat: `creator.avatar` dari `/api/chars` (bawaan = akun default nandasikma; tanpa pembuat = ikon Neyhra).
- File: `public/index.html` (`card()`, `loadTileStats`), `public/shell.css`, `public/cdetail.js`, `lib/charsocial.js`.

## Cerita (Story) + tombol ✨ AI (update)
- Form AI (Profil > AI Saya) punya kolom **Cerita (opsional)**, maks 2000 huruf. Isinya tampil di tab **Story** halaman detail karakter (AI buatan, publik atau milik sendiri). Karakter bawaan: "Karakter ini belum punya cerita."
- **Tombol ✨ "Kembangkan dengan AI"** di bawah kolom Cerita: user wajib menulis dulu minimal 10 huruf (ide singkat) di kolom itu; AI lalu mengembangkannya jadi 2-4 paragraf (target 600-1500 huruf) dan hasilnya menggantikan isi kolom. Ada tombol "Kembalikan tulisanku" untuk membatalkan. Hasil baru tersimpan saat tombol Simpan ditekan, jadi bisa diedit dulu.
- **AI yang dipakai = AI yang dipakai karakter itu untuk chat**: mesin ChatGPT (`chatgpt()`, sesi anon dipakai ulang per user) dengan prompt karakter yang sama (`buildCustomPrompt`: identitas, kepribadian, gaya bicara, aturan) + blok "TUGAS KHUSUS" yang memuat ide user di antara penanda `###`. Form bisa belum disimpan: data karakter dibaca dari body request, dibersihkan dengan `cleanFields`.
- Prompt menekankan: pertahankan semua fakta/nama dari ide user, orang ketiga, bahasa Indonesia, tanpa dialog ke user / judul / markdown / tag format chat, aman semua umur. Hasil dibersihkan (`cleanStory`: buang code fence, tag, markdown, kutip pembungkus), kalau terlalu pendek (<120) diminta ulang sekali, kalau terlalu panjang dipotong di akhir kalimat (`fitStory`).
- Cerita **tidak masuk ke prompt chat** (hanya tampilan). Kalau mau jadi "canon" untuk obrolan, tambahkan satu baris `Cerita: ...` di `buildCustomPrompt` (`lib/chars.js`).
- **Endpoint** (`lib/userchars.js`):
  - `POST /api/auth/aichar/story { seed, name, tagline, identity, personality, speech, rules }` -> `{ ok, story }` (login; 10x/jam per akun; seed 10-2000 huruf, nama wajib; tidak menulis ke database).
  - `POST /api/auth/charstory { char }` -> `{ ok, story }` (login opsional; AI privat milik orang lain = 404; id bawaan = story kosong; 120x/menit per akun/IP). Dipanggil lazy saat tab Story dibuka, jadi `/api/chars` tidak membengkak.
  - `aichar/save` menerima `story` (tanpa field = tidak diubah, string kosong = hapus); `aichar/list` mengembalikan `story`.
- Penyimpanan: field `story` di koleksi `user_chars`.
- Catatan: satu panggilan AI bisa sampai ~30 dtk (batas fungsi Vercel 60 dtk, maksimal 2 percobaan). Belum ada moderasi cerita untuk AI publik (sama seperti identitas/kepribadian).
- File: `lib/userchars.js`, `public/profile.js`, `public/profile.css`, `public/cdetail.js`, `public/cdetail.css`.

## Sapaan (update)
- Form AI punya kolom **Sapaan (opsional)**, maks 300 huruf, teks biasa tanpa AI. Disimpan di `user_chars.greeting` (`aichar/save` menerima `greeting`; tanpa field = tidak diubah, kosong = hapus; `aichar/list` mengembalikannya).
- **Dipakai saat chat baru dibuka** (1-lawan-1, log obrolan karakter itu masih kosong): karakter langsung mengirim sapaan itu sebagai pesan pertamanya, murni teks dari sistem (tidak memanggil AI, tidak ada voice note). Pesan masuk log tampilan dan riwayat konteks (`h:<id>` sebagai giliran `char`), jadi AI tahu sapaannya saat user membalas. Kalau obrolan dihapus lalu dibuka lagi, sapaan muncul lagi. Kalau sapaan kosong, perilaku lama (tidak ada pesan pembuka). Berlaku hanya untuk AI buatan user; karakter bawaan belum punya sapaan.
- **Hover kartu Beranda**: judul "Sapaan" dihapus, yang tampil hanya isinya (diketik bertahap). Sapaan kosong = placeholder lama "Tidak ada deskripsi. Fitur ini belum selesai." tetap tampil. Bagian "Sapaan" di halaman detail ikut menampilkan isi yang sama.
- `/api/chars` mengirim `greeting` untuk AI buatan yang boleh dilihat pemanggil (sapaan memang tampil ke semua pemakai; identitas/kepribadian tetap rahasia).
- File: `lib/userchars.js`, `lib/chars.js`, `lib/app.js`, `public/profile.js`, `public/index.html` (`card()`, `restoreChat()`), `public/shell.css`, `public/cdetail.js`.
