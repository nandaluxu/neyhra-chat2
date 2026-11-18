# UBAHAN-PERSONA — Delta Persona (tab Profil + pemilihan per karakter di halaman chat)

Delta ini berisi SEMUA file baru/berubah untuk fitur Persona di Neyhra Chat, relatif terhadap kondisi
repo sebelum pekerjaan Persona dimulai (commit `25832dc`). Menutup dua tahap pekerjaan:

1. **Tahap 1 — Persona (tab Profil)**: identitas alternatif PENGGUNA (bukan persona AI): nama,
   gender, profil karakter, foto; satu persona default dipakai di seluruh prompt AI.
2. **Tahap 2 — Pemilihan persona per karakter (halaman chat)**: kartu "Persona" di panel Detail
   karakter (`/chat/<id>`) yang bisa ditekan dan membuka daftar seluruh persona milik user; satu
   persona dipilih khusus untuk percakapan dengan karakter AI tersebut, tersimpan persisten
   **per user × per karakter**.

Cara pakai: ekstrak ZIP ini di akar proyek (semua jalur relatif akar proyek), lalu deploy biasa.
Tidak ada migrasi manual — koleksi MongoDB baru dibuat otomatis bersama index-nya saat endpoint
persona pertama kali dipakai.

---

## A. Ringkasan perilaku

- **Tanpa persona default & tanpa pilihan per-karakter** → seluruh sistem berperilaku PERSIS seperti
  sebelum fitur ini ada (AI memanggil nama akun, prompt tanpa blok persona).
- **Persona default** → dipakai di semua percakapan: chat 1-lawan-1, mode grup, Skenario Skrip
  (sutradara + aktor), AI Hasilkan, ringkasan memori, pesan proaktif.
- **Pilihan per-karakter (baru, tahap 2)** → menimpa default HANYA untuk karakter itu:
  - `pick persona = <id>` → persona itu dipakai khusus untuk chat dengan karakter tersebut;
  - `pick persona = null` → eksplisit "Profil akun" (tanpa persona untuk karakter itu, walau ada
    default — AI memanggil nama akun);
  - `pick follow = true` → hapus pilihan, ikut default lagi (perilaku sebelumnya).
- Persona TIDAK menyentuh `char/*.js` / kepribadian karakter AI — hanya menambah blok konteks
  tentang USER di prompt, dan nama persona menggantikan nama akun (`userRule`, `historyBlock`,
  `memBlock`, giliran grup, prompt sutradara, ringkasan memori).
- Ganti persona / ganti pilihan → `personaHash` di `fmtKey` berubah → sesi AI dimulai ulang otomatis,
  blok identitas baru langsung berlaku tanpa reload.
- Persona yang dihapus otomatis melepas pilihan per-karakter yang menunjuknya (kembali ikut default,
  degradasi lembut). Hapus akun ikut membersihkan persona + semua pilihannya.
- Semua endpoint butuh token Bearer dan selalu difilter `userId` — persona & pilihan tidak pernah
  tercampur antar akun. Resolusi persona dibaca SERVER lewat token + field `char` yang memang sudah
  dikirim, jadi client tidak bisa memalsukannya dan otomatis konsisten antar perangkat.

## B. Penyimpanan baru (MongoDB, otomatis)

| Koleksi | Isi | Index |
|---|---|---|
| `personas` | `{ _id: UUID, userId, name (≤24), gender ('m'\|'f'\|''), bio (≤300), av, avatarUrl, avKey, avData (fallback tanpa R2), def, createdAt, updatedAt }` | `{userId:1, def:1}`, `{userId:1, updatedAt:-1}` |
| `persona_picks` | `{ _id: "<userId>:<charId>", userId, charId, personaId (id \| null), createdAt, updatedAt }` | `{userId:1}` |

## C. Endpoint baru (semua POST kecuali avatar, butuh token Bearer)

| Endpoint | Fungsi |
|---|---|
| `/api/auth/persona/list` | daftar persona milik sendiri + kuota (maks 6) |
| `/api/auth/persona/save` | tambah/edit persona (`avatar`: data URL JPEG / `null` hapus / tanpa field = biarkan) |
| `/api/auth/persona/delete` | hapus persona (foto R2 ikut dibuang; pilihan per-karakter yang menunjuk ikut dilepas) |
| `/api/auth/persona/default` | `{ id }` jadikan default tunggal / `{ id: null }` lepas default |
| `/api/auth/persona/pick` | **(tahap 2)** pilih persona untuk SATU karakter: `{ char, persona }` / `{ char, persona: null }` / `{ char, follow: true }` |
| `/api/auth/persona/pick-get` | **(tahap 2)** status pilihan satu karakter + daftar persona (satu request untuk kartu + pemilih) |
| `GET /api/auth/persona-av/:id?v=` | foto persona (R2 redirect / fallback MongoDB) |

## D. Daftar file (isi ZIP)

**File baru:**

| File | Isi |
|---|---|
| `lib/persona.js` | backend persona: koleksi + endpoint di atas, `defaultPersona()`, `personaForUser()` (resolusi pilihan per-karakter menimpa default), `purgePersonas()` |
| `docs/frontend/persona.md` | dokumentasi fitur (overview, UI, flow, API, integrasi prompt) |
| `scripts/persona-test.mjs` | tes unit endpoint + blok prompt + resolusi per-karakter (koleksi tiruan, tanpa Mongo asli) |
| `scripts/persona-e2e.mjs` | tes E2E MongoDB asli + provider AI tiruan: isi prompt chat/grup/proaktif/memori + pemilihan per karakter |
| `scripts/persona-ui-server.mjs` | server untuk tes UI (Mongo memori + provider AI tiruan) |
| `scripts/persona-ui-test.mjs` | tes UI tab Persona di Profil (Playwright, mobile + desktop) |
| `scripts/persona-chat-ui-test.mjs` | tes UI kartu persona di halaman chat (Playwright: buka detail, pilih, persisten, isolasi antar karakter, tamu, desktop) |

**File berubah:**

| File | Perubahan |
|---|---|
| `lib/auth.js` | mount `mountPersona`; `purgePersonas` saat hapus akun |
| `lib/sessions.js` | `personaBlock`/`personaLine`/`personaHash`; parameter `persona` di `ask/run/reply/openWith/groupPrompt`; `personaHash` masuk `fmtKey` |
| `lib/app.js` | `personaFor(req, charId)`; persona + nama persona di `/api/chat` (1-lawan-1 & skenario pakai pilihan per-karakter, grup pakai default), `/api/proactive`, `/api/memory` |
| `lib/scenario.js` | persona ke prompt sutradara (`directorHead`), aktor, dan AI Hasilkan — resolusi per-karakter |
| `public/index.html` | bagian "Persona" (`#dpers`) + kartu (`#pecard`) di panel Detail karakter; pemilih persona (`#pemodal`: ikut default / seluruh persona / profil akun, `role="radiogroup"`); `peSync()`/`peLoad()`/`peChoose()`; tangani Escape, klik latar, perubahan status akun; tombol "Kelola persona di Profil"; styling responsif (bottom-sheet di mobile) |
| `public/shell.js` | `peSync()` dipanggil saat panel detail dibuka/di-segarkan (`openRel`/`afterOpen`/`refreshDetail`) |
| `public/profile.js` | tab Persona di Profil: grid kartu, modal tambah/edit, konfirmasi hapus, toggle default, segmented gender; pintasan `__wantPersonaTab` (dari tombol "Kelola persona" di halaman chat) |
| `public/profile.css` | styling tab & kartu persona, form, segmented gender, grid responsif |
| `package.json` | script tes: `npm run persona:test`, `npm run persona:e2e` |

Tidak ada file lain yang berubah. `node_modules`, `.git`, dan cache TIDAK termasuk.

## E. Hasil pengujian (ringkas)

| Suite | Cakupan | Hasil |
|---|---|---|
| `npm run persona:test` (unit, koleksi tiruan) | endpoint CRUD/default/pick/pick-get + keamanan antar akun + blok prompt + resolusi per-karakter + purge | **64 lulus, 0 gagal** |
| `npm run persona:e2e` (MongoDB asli + provider AI tiruan) | isi prompt nyata `/api/chat` (1-lawan-1, grup), `/api/proactive`, `/api/memory`; pilihan per-karakter menimpa default; mode none; follow; isolasi antar karakter; restart sesi via `fmtKey`; hapus akun | **45 lulus, 0 gagal** |
| `node scripts/persona-ui-test.mjs` (Playwright) | UI tab Persona di Profil: buat/edit/hapus/default, empty state, tab lain tak rusak, responsif | **25 lulus, 0 gagal** |
| `node scripts/persona-chat-ui-test.mjs` (Playwright) | UI halaman chat: `/chat/<id>` → detail → kartu persona → pemilih → pilih → toast → persisten setelah reload → karakter lain tak terpengaruh → profil akun → ikut default → Escape → kelola di Profil → tamu (overlay login) → desktop | **36 lulus, 0 gagal** |

Total **170 asersi lulus, 0 gagal**. UI dites pada viewport ponsel (390×844) dan desktop (1280×800)
tanpa error JavaScript.

Perbaikan bug yang ditemukan selama pengujian tahap 2:
- `lib/persona.js`: validasi id karakter memakai pola 8–64 karakter sehingga id pendek seperti
  `aki`/`rem`/`reze` ditolak — diganti pola longgar 1–64 (kebenaran tetap dicek ke `loadChars`).

## F. Catatan integrasi

- Mode **grup** memakai persona **default** (grup multi-karakter tidak terikat satu pilihan);
  chat 1-lawan-1, skenario, proaktif, dan ringkasan memori memakai **pilihan per-karakter**.
- Tamu (belum masuk): kartu persona menampilkan ajakan masuk akun; ketuk = buka overlay login.
  Fitur akun mati di server (`enabled:false`) → bagian persona disembunyikan.
- Tanpa env R2: foto persona disimpan sebagai base64 di dokumen persona (pola fallback `avatars`).
- `npm run persona:test` tidak butuh MongoDB; `persona:e2e` dan tes UI butuh
  `mongodb-memory-server` + `playwright` (dev-dependency tes, tidak dipakai produksi).
