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
- Placeholder ("Tidak ada deskripsi. Fitur ini belum selesai."): Sapaan, Atribut Persona, Story, Komentar, likes, Dukung/Follow, bagikan.
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
