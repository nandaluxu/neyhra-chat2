# UBAHAN — AI buatan user ("AI Saya")

User yang sudah login bisa membuat karakter AI sendiri (maks 10/akun): nama, label, identitas, kepribadian,
gaya bicara, aturan tambahan, foto. Dikelola di **Profil > tab "AI Saya"**; langsung muncul di Beranda
dan ikut hubungan, memori, grup, skenario, persona, proaktif. Suara dipilih dari suara karakter bawaan; tanpa voiceId AI tidak bisa voice note.

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
Koleksi MongoDB `user_chars` `{_id:"u_<16hex>", ownerId, name, tagline, identity, personality, speech, rules, av, avatarUrl/avKey (R2) | avData}` — dibuat otomatis.

## Keamanan
- Privat: hanya pemilik yang melihat/memakai (`canUseChar`); id acak 64-bit.
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
