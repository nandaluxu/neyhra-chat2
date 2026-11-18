# Persona (Identitas Alternatif User)

## A. Feature Overview

- **Nama fitur**: Persona — identitas alternatif **PENGGUNA** (bukan persona AI) yang dipakai sebagai
  konteks percakapan AI: nama, gender, profil karakter, dan foto.
- **Tujuan**: user bisa menentukan "siapa dirinya" di mata AI tanpa mengubah data akun. AI memanggil
  nama persona, mengenali gender, dan memakai profil karakternya secara natural.
- **Batasan penting (dirancang sejak awal)**:
  - Persona **TIDAK mengubah identitas/kepribadian karakter AI** (`char/*.js` tidak tersentuh).
    Persona hanya menambah blok konteks tentang *user* di prompt.
  - **Hanya satu persona default**; tanpa persona default, seluruh sistem berperilaku seperti
    sebelumnya (AI memanggil nama akun).
- **Fungsi utama**:
  - Buat beberapa persona (maks 6): nama (≤24 char), gender opsional (laki-laki/perempuan),
    profil karakter (≤300 char), foto/PFP 256×256 JPEG ≤100 KB.
  - Tandai satu persona sebagai default — otomatis dipakai di **semua** percakapan AI yang relevan:
    chat 1-lawan-1, mode grup, Skenario Skrip (sutradara + aktor), AI Hasilkan, ringkasan memori,
    dan pesan proaktif.
  - Tambah / edit / hapus persona dalam bentuk kartu.
  - **Pilih persona per karakter** dari halaman chat: kartu "Persona" di panel Detail karakter
    (`/chat/<id>`) membuka daftar seluruh persona milik user; satu persona bisa dipilih khusus
    untuk percakapan dengan karakter AI itu (menimpa default hanya untuk karakter tersebut).
    Tersimpan persisten per user × per karakter (koleksi `persona_picks`), jadi karakter berbeda
    boleh memakai persona berbeda dan pilihan ikut saat pindah perangkat.
- **Hubungan dengan sistem yang sudah ada**:
  - Backend `lib/persona.js` (koleksi MongoDB `personas` + `persona_picks`, dipasang di router auth
    `lib/auth.js` — semua endpoint butuh token Bearer dan selalu difilter `userId`, jadi persona tidak
    pernah tercampur antar akun).
  - Integrasi prompt di `lib/sessions.js` (`personaBlock`/`personaLine`/`personaHash` masuk head
    prompt + `fmtKey`), `lib/app.js` (`personaFor()` di `/api/chat`, `/api/proactive`, `/api/memory`),
    `lib/scenario.js` (sutradara/aktor/AI Hasilkan).
  - Upload foto memakai jalur yang sama dengan foto profil: R2 kalau env lengkap, fallback MongoDB
    (field `avData` per dokumen persona, disajikan lewat `GET /api/auth/persona-av/:id?v=`).
  - Hapus akun ikut membersihkan persona + pilihan per-karakter (`purgePersonas` di `/api/auth/delete`).
  - Persona yang dihapus otomatis melepas pilihan per-karakter yang menunjuknya (kembali ikut default).

### UI tambahan: kartu persona di halaman chat (panel Detail karakter)

- **Lokasi**: `/chat/<id>` → ketuk avatar/nama karakter di header (mobile: panel menutupi kanan,
  desktop: panel otomatis tampil di samping chat — `.dp-on`).
- **Kartu** (`#pecard`, di bagian "Persona" `#dpers` di atas bagian Hubungan): avatar (foto persona
  atau inisial), nama efektif, keterangan sumber — "Persona default — dipakai di semua chat" /
  "Persona khusus untuk <karakter>" / "Profil akun — tanpa persona" / "Belum ada persona default".
- **Pemilih persona** (`#pemodal`, pola modal `.nbox` + bottom-sheet di mobile): `role="radiogroup"`, opsi
  "Ikut persona default" → semua persona user (avatar, nama, chip gender, 2 baris profil) → "Profil akun";
  opsi terpilih diberi outline + titik centang (`aria-checked`). Tombol **Kelola persona di Profil**
  menutup modal, pindah ke Profil, dan langsung membuka tab Persona.
- **Status akun**: tamu → kartu "Masuk akun untuk memakai identitas lain saat ngobrol", ketuk = buka
  overlay login. Fitur akun mati di server (`enabled:false`) → bagian persona disembunyikan.
- **Responsif + aksesibilitas**: kartu/opsi `button` penuh (`focus-visible`, `aria-checked`,
  `aria-haspopup="dialog"`), Escape menutup pemilih, maks 1× muat `pick-get` per 5 detik per karakter.

## B. UI Requirements

- **Halaman**: tab **Persona** di tab Profil (profil sendiri saja; profil orang lain tidak melihat
  persona milik siapa pun — data pribadi, bukan konten publik).
- **Komponen**:
  1. **Header penjelasan**: satu paragraf apa itu persona + efek persona default.
  2. **Grid kartu persona** (responsif, `auto-fill minmax(200px,1fr)`):
     - avatar (foto atau inisial nama), nama, chip gender (biru = laki-laki, pink = perempuan,
       tidak tampil bila tidak dipilih), potongan profil (maks 2 baris),
     - kartu default diberi outline; tombol **Default / Jadikan default** (toggle) + tombol
       **hapus** (ikon tempat sampah, merah),
     - klik kartu = buka form edit.
  3. **Kartu tambah** (`+ Tambah persona`, border putus-putus) selama di bawah kuota; hilang saat
     kuota penuh dan diganti catatan "Kuota penuh (6/6)…".
  4. **Modal tambah/edit** (pola modal edit profil):
     - foto: pratinjau bulat + "Ganti foto" / "Hapus foto" (file input tersembunyi),
     - input nama (maks 24), **segmented gender dua tombol** (ketuk aktif, ketuk lagi = kosong /
       tidak ditentukan), textarea profil karakter (maks 300 + counter),
     - baris **Persona default** dengan switch (komponen `.sw` global),
     - tombol Batal / Simpan; pesan error inline (`role="status"`).
  5. **Modal konfirmasi hapus**: teks peringatan (menyebut kalau persona yang dihapus adalah
     default) + tombol Batal / **Hapus** (merah).
- **Empty state**: "Belum ada persona…" + tombol **Buat persona**.
- **Loading state**: "Memuat…" (satu fetch `persona/list` per kali tab dibuka; data di-cache di
  memori selama sesi tab).
- **Error state**: pesan server inline di panel / modal; 401 ditangani global `aApi` (logout).
- **Accessibility**: kartu bisa difokuskan (`tabIndex=0`, `role=button`, Enter/Space membuka edit),
  semua tombol punya `aria-label`/`aria-pressed`, switch memakai `role="switch"` + `aria-checked`,
  tab ikut pola `role="tablist"` yang sudah ada.

## C. User Flow

1. Buka Profil → tab **Persona** → `POST /api/auth/persona/list` → grid kartu.
2. Klik **Tambah persona** → isi form → Simpan → `POST /api/auth/persona/save` → kartu muncul.
3. Aktifkan **Persona default** (switch di form, atau tombol "Jadikan default" di kartu) →
   `POST /api/auth/persona/default { id }` → sejak pesan berikutnya AI memanggil nama persona.
   Menyalakan default persona lain otomatis mematikan yang lama (server clear-then-set).
4. Klik kartu → edit (nama/gender/profil/foto/default) → Simpan (`persona/save { id, ... }`).
5. Hapus → konfirmasi → `POST /api/auth/persona/delete { id }`.
6. Matikan default (tombol "Default" pada kartu default) → `persona/default { id: null }` →
   AI kembali memanggil nama akun.

Flow pemilihan persona per karakter (halaman chat):
1. Buka `/chat/<id>` → ketuk avatar karakter → panel Detail karakter → kartu "Persona" memuat
   `POST /api/auth/persona/pick-get { char }` (status pilihan + daftar persona, satu request).
2. Ketuk kartu → pemilih persona menampilkan: Ikut persona default / seluruh persona / Profil akun.
3. Pilih salah satu → `POST /api/auth/persona/pick` → toast "Persona untuk <karakter>: <nama>",
   kartu diperbarui. Sejak pesan berikutnya AI memakai identitas itu untuk karakter ini
   (sesi AI dimulai ulang otomatis — `personaHash` di `fmtKey`).
4. Pilihan tersimpan di akun (per user × per karakter): reload / pindah perangkat tetap berlaku,
   dan karakter lain tidak terpengaruh.

Perilaku AI yang diharapkan (tidak ada UI khusus — efek terlihat di balasan karakter):
- Sesi AI lama otomatis dimulai ulang saat persona berganti (`fmtKey` memuat `personaHash`),
  jadi blok identitas baru langsung berlaku tanpa reload.

## D. Backend Integration

### POST `/api/auth/persona/list`
Response 200:
```json
{ "ok": true, "personas": [ { "id": "uuid", "name": "Ayu", "gender": "f",
  "bio": "mahasiswa psikologi, suka kucing", "def": true,
  "avatar": "/api/auth/persona-av/uuid?v=1731920000000" } ], "max": 6 }
```
`avatar` kosong = belum ada foto (UI pakai inisial nama). `def: true` maksimal satu entri.

### POST `/api/auth/persona/save`
Body (tambah): `{ "name": "Ayu", "gender": "f", "bio": "...", "def": true, "avatar": "<data URL JPEG>" }`
Body (edit): sama + `"id": "uuid"`. `avatar`: tanpa field = biarkan; `null` = hapus; data URL JPEG = ganti.
Response 200: `{ "ok": true, "personas": [...], "max": 6 }`.
Error: `400` nama kosong / foto tidak valid / kuota penuh ("Maksimal 6 persona…"); `404` id bukan milik sendiri; `429` rate limit.

### POST `/api/auth/persona/default`
Body: `{ "id": "uuid" }` (jadikan default satu-satunya) atau `{ "id": null }` (lepas default).
Response 200: sama dengan list. `404` id tidak ditemukan milik sendiri.

### POST `/api/auth/persona/delete`
Body: `{ "id": "uuid" }` → Response 200: sama dengan list. Foto di R2 ikut dihapus.

### POST `/api/auth/persona/pick`
Pemilihan persona untuk SATU karakter (halaman chat). Body:
- `{ "char": "reze", "persona": "<id>" }` → persona itu khusus untuk karakter itu.
- `{ "char": "reze", "persona": null }` → eksplisit "Profil akun" (tanpa persona untuk karakter itu,
  walau ada persona default).
- `{ "char": "reze", "follow": true }` → hapus pilihan, ikut persona default lagi.

Response 200: `{ "ok": true, "mode": "pick"|"none"|"follow", "personaId": "<id>|null" }`.
Error: `400` karakter tidak dikenal; `404` persona bukan milik sendiri; `401` tanpa token; `429` rate limit.

### POST `/api/auth/persona/pick-get`
Body `{ "char": "reze" }` → status pilihan satu karakter + daftar persona lengkap (satu request
untuk kartu + isi pemilih):
```json
{ "ok": true, "mode": "follow", "personaId": null,
  "personas": [ { "id": "uuid", "name": "Ayu", "gender": "f", "bio": "…", "def": true,
                  "avatar": "/api/auth/persona-av/uuid?v=1731920000000" } ], "max": 6 }
```
`mode`: `follow` (tidak ada pilihan → ikut default) | `none` (eksplisit profil akun) | `pick` (personaId terisi).
Persona terpilih yang sudah dihapus dijawab `follow` (pilihan basi dibersihkan malas oleh `personaForUser`).

### GET `/api/auth/persona-av/:id?v=<versi>
Foto persona (JPEG) untuk fallback MongoDB; bila foto ada di R2 dijawab `302` redirect ke URL publik
R2. Publik-tak-tertebak (id UUID acak, pola sama seperti `gc/<24-hex>.jpg`), cache `immutable`
selama versi sama.

## E. Integrasi Prompt (server-side, client tidak mengirim apa pun)

- `lib/app.js` `personaFor(req, charId)`: baca token Bearer → persona efektif user untuk karakter itu
  (atau `null`). Resolusi: **pilihan per-karakter (`persona_picks`) menimpa persona default**;
  pilihan `null` = tanpa persona (nama akun); tanpa pilihan = persona default.
  Dipakai `/api/chat` (1-lawan-1 & skenario dengan `charId`, mode grup dengan default), `/api/proactive`,
  `/api/memory`. `lib/scenario.js` (sutradara/aktor) dan `/api/scenario/generate` memakai
  `personaForUser(col, userId, charId)` dengan resolusi yang sama.
- `user` yang masuk prompt = `persona.name` kalau ada, selain itu `cleanName(userName)` seperti biasa
  — jadi `userRule`, `historyBlock`, `memBlock`, giliran grup, prompt sutradara, dan ringkasan memori
  otomatis memakai nama persona.
- `lib/sessions.js`:
  - `personaBlock(p)` (chat 1-lawan-1/skenario, di HEAD saat sesi baru): blok
    "IDENTITAS USER SAAT INI" — gender + "Tentang dirinya" + instruksi memakai secara natural
    tanpa menyebut kata "persona".
  - `personaLine(p)` (grup, sutradara, AI Hasilkan): versi satu baris.
  - `personaHash(p)` masuk `fmtKey` → ganti persona / ganti pilihan per-karakter = sesi baru = blok
    langsung dipakai.
- Tanpa persona default dan tanpa pilihan per-karakter semua fungsi mengembalikan string kosong/null
  → prompt dan perilaku **identik dengan sebelum fitur ini ada**.

## F. File yang berubah / baru

| File | Perubahan |
|---|---|
| `lib/persona.js` | BARU — koleksi `personas` + `persona_picks`, endpoint CRUD + default + avatar + `pick`/`pick-get`, `defaultPersona()`/`personaForUser()`, `purgePersonas()` |
| `lib/auth.js` | mount `mountPersona`, purge persona saat hapus akun |
| `lib/sessions.js` | `personaBlock`/`personaLine`/`personaHash`, parameter `persona` di `ask/run/reply/openWith/groupPrompt` |
| `lib/app.js` | `personaFor(req, charId)`, persona + nama persona di `/api/chat` `/api/proactive` `/api/memory` (chat 1-lawan-1 & skenario pakai pilihan per-karakter, grup pakai default) |
| `lib/scenario.js` | persona ke prompt sutradara (`directorHead`), aktor (`reply`), dan AI Hasilkan (`genPrompt`) — resolusi per-karakter |
| `public/profile.js` | tab Persona: kartu, modal tambah/edit, konfirmasi hapus, toggle default, segmented gender; pintasan `__wantPersonaTab` dari halaman chat |
| `public/profile.css` | styling kartu persona, form, segmented, kartu tambah, tab 5-kolom responsif |
| `public/index.html` | kartu persona per-karakter di panel Detail karakter (`#dpers`/`#pecard`), pemilih persona (`#pemodal`) dengan opsi ikut-default/persona/profil akun, sinkron `peSync()` saat panel tampil, respons akun berubah, styling |
| `public/shell.js` | `peSync()` ikut dipanggil saat panel detail dibuka/di-segarkan (openRel/afterOpen/refreshDetail) |
| `scripts/persona-test.mjs` | BARU — tes endpoint + blok prompt + resolusi per-karakter (koleksi tiruan) |
| `scripts/persona-e2e.mjs` | BARU — E2E MongoDB asli: prompt chat/grup/proaktif/memori + pemilihan per karakter |
| `scripts/persona-ui-server.mjs` | BARU — server UI tes (Mongo memori + provider AI tiruan) |
| `scripts/persona-ui-test.mjs` | BARU — tes UI tab Persona (Playwright, mobile + desktop) |
| `scripts/persona-chat-ui-test.mjs` | BARU — tes UI kartu persona halaman chat (Playwright: pilih, persisten, isolasi antar karakter, tamu, desktop) |
