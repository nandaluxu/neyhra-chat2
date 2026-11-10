# README 1 — AUDIT PENYIMPANAN DATA (STORAGE MAP)

> Audit repo `nandaluxu/neyhra-chat2` (commit `321c74a`).
> Dokumen ini memetakan **semua tempat penyimpanan data**: apa disimpan, di mana, untuk apa, berapa besar, siapa yang mengelola, dan kapan data itu hilang.
> Pendamping: `readme2.md` — audit data yang dikirim ke AI + peta "kalau mau ubah X mulai dari mana".

---

## 0. Peta Besar (satu layar)

```
┌───────────────────────── BROWSER (milik user) ─────────────────────────┐
│  localStorage  : riwayat chat, memori, EXP hubungan, token, pengaturan │
│  IndexedDB     : audio voice note (db "neyhra", store "vn")            │
└───────────────┬────────────────────────────────────────────────────────┘
                │ HTTPS (JSON, body maks ±50 KB / 3,5 MB utk sinkron cloud)
┌───────────────▼──────────── SERVER (Vercel serverless) ────────────────┐
│  RAM instance  : sesi anon ChatGPT/Lorka (Map), pool Mongo             │
│  MongoDB       : akun, sesi login, data cloud, skrip skenario, game,   │
│                  follow, avatar (cadangan), state roleplay,            │
│                  riwayat Chat Global (gc_messages)                     │
│  Redis/Upstash : presence, heartbeat, rate limit, feed realtime GC     │
│                  (riwayat chat global ada di MongoDB)                  │
│  Cloudflare R2 : foto profil (JPEG)                                    │
│  File repo     : char/*.js, data/*.json, assets/ (read-only)           │
└────────────────────────────────────────────────────────────────────────┘
                │
                ▼
   AI eksternal: android.chat.openai.com (anon), lorka.ai (dev),
                 api.fish.audio (TTS) — TIDAK menyimpan apa pun di repo
```

Prinsip utama proyek ini: **server stateless** (aman untuk Vercel serverless). Sebagian besar data percakapan hidup di browser user dan dikirim ulang tiap request; server hanya menyimpan yang memang harus persisten dan lintas perangkat (akun, saldo, skrip, dsb.).

---

## 1. MongoDB — database utama fitur akun

**File:** `lib/mongo.js` (koneksi + `col()` + `ensureIndexes()`)

**Env:**
| Env | Kegunaan |
|---|---|
| `MONGODB_URI` (atau `MONGO_URL` / `MONGODB_URL` / value env apa pun yang berformat `mongodb+srv://...`) | alamat koneksi |
| `MONGODB_DB` | nama database (opsional; default nama di URI, atau `neyhra`) |

**Perilaku koneksi:**
- Klien disimpan di `globalThis.__neyhraMongo` supaya instance serverless **memakai ulang koneksi** antar request (Atlas gratis kuat ±500 koneksi, jadi `maxPoolSize: 5`, timeout 5 detik).
- Tanpa URI → `mongoEnabled()` = false → semua fitur yang butuh Mongo menjawab `enabled:false` (UI menyembunyikan fiturnya, aplikasi tetap jalan).
- `ensureIndexes()` dijalankan sekali per instance (cache di `Set done`).

**Koleksi (10):**

### 1.1 `users` — akun + dompet + progres
Ditulis oleh: `lib/auth.js` (register), `lib/bonus.js`, `lib/games.js`, `lib/picgame.js`, `lib/profile.js`. Dibaca juga `scripts/migrate-avatars-r2.js`.

```js
{
  _id: UUID,              // id user
  username: "hurufkecil", // UNIK (index unique) — dipakai login & profil publik
  name: "Nama Tampilan",  // boleh diedit user (maks 20 char)
  salt, hash,             // password scrypt (TIDAK pernah dikirim ke browser)
  coins: 150, gems: 10,   // saldo; awal START_COINS/START_GEMS; hanya server boleh mengubah
  createdAt,              // index; dipakai daftar "Baru bergabung" di tab Profil
  // --- bonus (lib/bonus.js) ---
  bonusDay, bonusN,       // hari WIB terakhir klaim & streak klaim harian
  refCode,                // kode referal UNIK (sparse) milik user
  invited, refBy, refAt,  // jumlah undangan / pemilik kode yang dipakai / waktunya
  // --- games (lib/games.js, lib/picgame.js) ---
  gameDay, gameWins,      // kemenangan berhadiah Tebak Angka hari itu (anti farming)
  picDay, picWins, picDone,
  // --- profil (lib/profile.js) ---
  bio,                    // maks 120 char
  av,                     // versi foto (angka); tidak ada = belum punya foto
  avatarUrl,              // alamat foto di Cloudflare R2 (mode utama)
  avKey,                  // nama objek di bucket (untuk hapus foto lama di R2)
  // --- toko (lib/shop.js) ---
  inv                     // { bunga: 2, coklat: 1, eskrim: 0 } isi Inventory; berubah hanya lewat /api/auth/shop/buy dan /gift
}
```
Index: `{username:1} unique`, `{refCode:1} unique sparse`, `{createdAt:-1}`.

### 1.2 `auth_sessions` — sesi login
`lib/auth.js`. `{ _id: sha256(token), userId, createdAt }`.
- Token asli (256-bit) HANYA dipegang browser (localStorage `authtok`); database cuma menyimpan hash-nya.
- Index TTL `createdAt` **60 hari** → kedaluwarsa otomatis; index `{userId:1}` untuk hapus massal saat akun dihapus.

### 1.3 `userdata` — sinkronisasi data obrolan antar perangkat
`lib/auth.js`. `{ _id: userId, data: "<string JSON>", size, updatedAt }`.
- Isinya hasil ekspor localStorage user (riwayat chat, memori, EXP, grup) sebagai **satu string JSON**.
- Batas `MAX_DATA = 3,5 MB` (di bawah batas body Vercel ±4,5 MB).
- Server TIDAK membaca isinya (opaque blob); hanya menyimpan dan mengembalikan utuh.

### 1.4 `auth_rl` — pembatas laju (rate limit)
`lib/auth.js`. `{ _id: "kunci", n, exp }` — penghitung percobaan login/registrasi per IP/username. Index TTL pada `exp` → terhapus otomatis. Diperlukan karena instance serverless tidak berbagi memori.

### 1.5 `scripts` — skrip Skenario Skrip buatan user
`lib/scenario.js`. `{ _id: UUID, userId, slot: 0..2, title, content, charId, createdAt, updatedAt }`.
- **Kuota 3 skrip per user** ditegakkan lewat index unique `{userId, slot}` → dua request bersamaan tidak bisa merebut slot yang sama (anti race).
- `content` maksimal **1000 karakter** (divalidasi backend + frontend).
- `charId` divalidasi harus ada di `char/`.

### 1.6 `rp_state` — skenario roleplay yang sedang aktif
`lib/scenario.js`. Satu dokumen per user (index unique `{userId:1}`):
```js
{ _id, userId, scriptId (null kalau jalankan tanpa simpan), title, content, charId,
  phase: 'choosing'|'running', first: 'ai'|'user'|null,
  sinceDir,          // berapa pesan sejak sutradara terakhir dipanggil
  msgs, meta,        // meta = arahan sutradara {lokasi, suasana, event, tujuan, karakter, instruksi, nextIn}
  director: {auth, chatId, startedAt},   // sesi ChatGPT sutradara (AI 1)
  actor:    {auth, chatId, startedAt, fmt}, // sesi ChatGPT aktor (AI 2)
  createdAt, updatedAt }
```
- Index TTL `updatedAt` **7 hari** → skenario ditinggalkan 7 hari otomatis dibersihkan.
- Menjalankan skenario baru otomatis mengakhiri (hapus) state lama user.

### 1.7 `game_state` — papan permainan berjalan
`lib/games.js` (Tebak Angka) + `lib/picgame.js` (Tebak Gambar). Satu dokumen per user per game:
- `"<userId>:guess"` → `{secret, hist:[{n,r}], done, won, reward, exp}`
- `"<userId>:pic"` → `{id soal, hist:[{t}], hint, done, won, reward, exp}`
- Angka rahasia, jawaban, dan penilaian **hanya di sini** (client tidak pernah menerima jawaban sebelum selesai). Index TTL `exp` **24 jam**.

### 1.8 `avatars` — foto profil (mode cadangan)
`lib/profile.js`. `{ _id: userId, data: "<JPEG base64>", v }`.
- HANYA dipakai kalau env R2 belum lengkap, dan untuk foto lama sebelum migrasi R2.
- Foto baru 256×256 JPEG ≤100 KB (dikecilkan di browser sebelum dikirim).

### 1.9 `follows` — ikuti / diikuti
`lib/profile.js`. `{ _id: "<pengikut>:<diikuti>", follower, followee, createdAt }` — `_id` gabungan mencegah dobel-follow. Index `{follower:1, createdAt:-1}` dan `{followee:1, createdAt:-1}` untuk paging 20/halaman.

### 1.10 `gc_messages` — riwayat Chat Global (penyimpanan utama)
`lib/gc.js`. `{ _id: <UUID pesan>, senderId, senderName, text, ts, replyTo, au?, av? }`.
- `_id` = id pesan (UUID dibuat server), `ts` = waktu server (client tidak menentukan urutan), `replyTo` = id pesan yang dibalas (disiapkan untuk fitur balas; belum ada UI-nya).
- `au`/`av` = username + versi foto profil, hanya untuk pengirim yang masuk akun (alamat foto dibangun client dari pola tetap, bukan URL kiriman orang lain).
- Index `{ts:-1, _id:-1}` = urutan pagination riwayat (kursor `{ts, id}`, terbaru dulu lalu mundur, maks 30–50 per halaman).
- Alur: `send` → insert ke koleksi ini dulu (gagal = pesan gagal terkirim) → baru push ke feed Redis. `history`/gap-patch `sync` membaca dari sini. `delete` menghapus di sini + tombstone/watermark di Redis supaya klien online ikut membuang.

**Alur 4 endpoint Chat Global (`lib/gc.js`, semua POST):**
| Endpoint | Alur |
|---|---|
| `/api/gc/send` | validasi teks (1–256 codepoint, ditolak bukan dipangkas) → identitas: token Bearer sah = nama+foto profil akun, tanpa token = tamu (nama dari body) → rate-limit `rls` → **insert ke `gc_messages`** → push ke feed Redis (best-effort; gagal = warning saja, pesan tetap terkirim) → balas `{m}` |
| `/api/gc/history` | rate-limit `rlh` → baca watermark → query Mongo `ts < before.ts` ATAU (`ts == before.ts` DAN `_id < before.id`) (kursor `{ts,id}` stabil, tanpa skip/offset, index `{ts:-1,_id:-1}`) → 30–50 pesan urut naik + `more` + `t0` (titik awal tombstone client) |
| `/api/gc/sync` | heartbeat presence `live` (rate-limit `rlb`) → feed Redis: pesan dengan `ts > since` + watermark + tombstone baru → **gap-patch**: kalau pesan tertua di feed lebih baru dari `since` klien (pesan terdorong keluar LTRIM / push gagal / feed terisi sebagian), ambil dari Mongo urut naik (maks 50, `more` = masih sisa → klien polling cepat) |
| `/api/gc/delete` | wajib kode dev (hash dicek server) → satu pesan: deleteOne Mongo + tombstone Redis; semua: deleteMany Mongo + watermark Redis → klien online membuang pesan lewat `sync`; Redis gagal = best-effort (Mongo sudah bersih, respons tetap `ok`) |

**Di browser TIDAK ada penyimpanan Chat Global** (`public/globalchat.adapter.js`): riwayat hanya di memori (maks 3000 pesan, yang terlama dibuang dan bisa dimuat lagi lewat `loadOlder`), dedup by id + tombstone/watermark. `loadOlder` menjaga posisi scroll; pesan lama tidak memicu notifikasi (baseline `nMax` saat pertama online).

*(+ `_selftest` sementara — hanya dipakai `scripts/db-test.js` untuk tes koneksi.)*

**Alat bantu:**
- `npm run db:test` → `scripts/db-test.js` (cek koneksi & koleksi)
- `npm run r2:migrate` → `scripts/migrate-avatars-r2.js` (pindah foto lama `avatars` → R2, aman diulang, ada `--dry`)

---

## 2. Redis / Upstash — presence, rate limit & cache realtime Chat Global

**File:** `lib/online.js` (konfigurasi + klien minimal sendiri), `lib/gcstore.js` (layout key + skrip Lua), `lib/gc.js` (API `/api/gc/*`).

**Env (salah satu):**
- `REDIS_URL` / value env apa pun berformat `redis://` atau `rediss://` (TCP)
- `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` (REST) atau `KV_REST_API_URL` + `KV_REST_API_TOKEN` (integrasi Vercel KV)

**Mode otomatis:** REST → TCP → memori lokal (dev). Tanpa env di Vercel → fitur mati rapi (`enabled:false`).

**Pembagian tugas (arsitektur Mongo-utama):** seluruh riwayat Chat Global tersimpan di MongoDB (koleksi `gc_messages`, lihat §1.10). Redis hanya memegang yang cepat dan sementara: presence, rate limit, dan feed 10 pesan terbaru untuk polling realtime. Redis tidak pernah jadi sumber riwayat — pesan yang hilang/tertinggal dari feed selalu bisa ditambal dari Mongo.

**Tata letak key (semua berprefiks `neyhra:`):**

| Key | Tipe | Isi & umur |
|---|---|---|
| `neyhra:online` | counter | jumlah pengunjung yang buka situs (heartbeat ±60 dtk) |
| `neyhra:gc:msgs` | LIST | **feed 10 pesan terbaru** untuk polling (salinan cepat; sumber kebenaran = `gc_messages` di Mongo), TTL 24 jam. Pesan baru masuk ke feed SETELAH tersimpan di Mongo — kalau push gagal, riwayat tetap aman dan klien lain menambalnya dari Mongo |
| `neyhra:gc:tombs` | ZSET | id pesan yang dihapus (skor = waktu hapus), TTL 60 hari → klien yang sedang online ikut membuangnya lewat `/api/gc/sync` |
| `neyhra:gc:clear` | STRING | watermark (ms): pesan dengan ts ≤ nilai ini dianggap terhapus semua, TTL 60 hari (sinkron "hapus semua" lintas klien) |
| `neyhra:gc:live` | ZSET | presence ruang chat (skor = heartbeat terakhir), dianggap hidup < 30 dtk, TTL key 120 dtk |
| `neyhra:gc:rls:<pengirim>` | counter | rate-limit kirim pesan: 6/12 dtk per senderId (akun) / clientId (tamu) |
| `neyhra:gc:rlb:<clientId>` | counter | rate-limit heartbeat/sync: 90/15 dtk per clientId |
| `neyhra:gc:rlh:<clientId>` | counter | rate-limit ambil riwayat Mongo: 30/15 dtk per clientId |

**Catatan desain:** Redis Pub/Sub sengaja tidak dipakai (serverless tidak bisa memegang subscription). Realtime = polling adaptif ke `/api/gc/sync` (burst 3 dtk saat ramai, melambat ke 10 dtk saat sepi, bisa diatur via env `GC_POLL_BASE`/`GC_POLL_BURST`).

**Kegagalan Redis:** `send` tetap berhasil selama Mongo sukses (push feed best-effort, hanya warning di log); `sync`/`history` balas 502 → klien tampil offline tapi pesan yang sudah dimuat tetap terbaca; data di Mongo tidak pernah hilang karena Redis mati.

---

## 3. Cloudflare R2 — foto profil

**File:** `lib/r2.js` (AWS Signature V4 tanpa library, `fetch` bawaan Node), `lib/profile.js` (pemakaian), `scripts/r2-test.js` + `scripts/migrate-avatars-r2.js`.

**Env (semua wajib agar R2 aktif):** `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `R2_PUBLIC_URL` (+ opsional `R2_ENDPOINT` untuk bucket EU).

- Objek: `pfp/<24-hex-acak>.jpg` — JPEG 256×256 ≤100 KB, header `Cache-Control: public, max-age=31536000, immutable`.
- Nama objek (`avKey`) + alamat publik (`avatarUrl`) disimpan di koleksi `users`; foto lama dihapus dari bucket saat diganti / akun dihapus.
- **Fallback:** env R2 tidak lengkap → foto disimpan di MongoDB `avatars` (dikembalikan lewat `GET /api/auth/avatar/:username?v=`). Client selalu menerima satu field `avatar` (alamat lengkap) jadi tidak perlu tahu foto ada di mana.
- Avatar **karakter** (bukan user) TIDAK di R2 — lihat §5.

---

## 4. Memori instance (RAM) — hilang saat instance serverless berganti

| Struktur | File | Isi | Umur |
|---|---|---|---|
| `sessions` Map | `lib/sessions.js` | sesi ChatGPT per chat: key `clientId:charId` (+ `:scn` untuk skenario) → `{auth (cookie anon), chatId, parentMessageId, fmt, q (antrian per chat)}` | sesi "hangat" ±50 menit (TTL provider); entri idle >12 jam dibersihkan tiap jam |
| `gAuth` Map | `lib/sessions.js` | cookie anon ChatGPT per clientId untuk **mode grup** (dipakai ulang antar giliran) | sama |
| `genAuth` Map | `lib/scenario.js` | cookie anon ChatGPT per user untuk **AI Hasilkan** | sama |
| `globalThis.__neyhraMongo` | `lib/mongo.js` | pool koneksi MongoDB (dipakai ulang antar request) | selama instance hidup |
| `done` Set | `lib/mongo.js` | nama koleksi yang index-nya sudah dibuat di instance ini | selama instance hidup |
| `ready` / `idx` promise | `lib/auth.js`, `lib/games.js`, `lib/picgame.js`, `lib/profile.js`, `lib/scenario.js` | janji init index per modul | selama instance hidup |

**Skenario lintas instance:** sesi Director/Actor disimpan di Mongo (`rp_state.director` / `rp_state.actor`) dan di-*seed* kembali ke Map saat request berikutnya — itulah kenapa skenario bisa lanjut setelah reload atau pindah instance, selama masih < 50 menit hangat.

**Cache karakter: TIDAK ADA.** `loadChars()` (`lib/chars.js`) membaca ulang folder `char/` di setiap request dengan import ber-versioning `?v=<mtime>` — perubahan file karakter langsung berlaku tanpa redeploy lokal (di Vercel, file ikut bundle `includeFiles`).

---

## 5. File statis di repo (read-only di Vercel)

| Path | Ukuran | Isi | Siapa yang memakai |
|---|---|---|---|
| `char/*.js` (55 file) | 236 KB | definisi karakter: `id, name, prompt, tagline, trait, voiceId, relations, pronounce` | dimuat server tiap request (`loadChars`); **tidak pernah** dikirim utuh ke browser (browser hanya dapat `id, name, tagline, avatar, voices{key,label}` lewat `/api/chars`) |
| `data/tebakgambar.json` | 232 KB | soal game Tebak Gambar (jawaban & deskripsi disimpan server-side) | `lib/picgame.js` |
| `assets/*.jpg` (59) | 2,2 MB | avatar karakter — dilayani **GitHub raw CDN** (`AVATAR_BASE` env, default `raw.githubusercontent.com/nandaluxu/ppcp/refs/heads/main/assets`, file `<id>.jpg`), bukan dari server Vercel | `<img>` di browser |
| `public/` | 512 KB | seluruh client bundle — detail §6 | dilayani CDN Vercel / `express.static` lokal |
| `api/index.js` → `lib/app.js` | — | satu fungsi serverless untuk semua `/api/*` (rewrite `vercel.json`), `maxDuration: 60` | — |

---

## 6. Penyimpanan di browser (client side)

**Helper:** `store.get/set` di `public/index.html` (menelan error private-mode). Reset total ada di Pengaturan (hapus localStorage + IndexedDB + sessionStorage lalu reload). Penghitung pemakaian ada di layar Pengaturan (batas localStorage ±5 MB).

### 6.1 localStorage — kunci lengkap

**Identitas & sesi**
| Key | Isi |
|---|---|
| `cid` | UUID perangkat (dibuat sekali) — `clientId` untuk AI & presence |
| `authtok` | token login (Bearer) — sumber kebenaran sesi |
| `authname` | nama tampilan dari akun (jadi `userName` di prompt AI) |
| `uname` | *(legacy, dihapus otomatis — nama lama tanpa login)* |
| `dataowner` | penanda pemilik data lokal saat ini (anti tabrakan antar akun di satu browser) |
| `dev`, `devu` | flag mode dev + kode dev |

**Chat global**
| Key | Isi |
|---|---|
| `gid` | id pengirim global (= `gcSenderId(userId)` dari login; dipakai menandai "ini pesanku") |
| `gu` | username akun (pencocok identitas pesan di Chat Global) |
| `gcids` | daftar clientId yang pernah dipakai akun (agar pesan lama dari browser lain tetap diakui milik sendiri) |

**Percakapan 1-lawan-1 (per karakter `<id>`)** — inti data user:
| Key | Isi | Batas |
|---|---|---|
| `log:<id>` | riwayat tampilan (bubble, versi voice note) | **150 pesan** (LOGMAX); yang keluar → audionya dibuang dari IndexedDB |
| `h:<id>` | riwayat yang dikirim ke AI (`[role, teks]`) | **40 pesan** (server pakai 24 terakhir) |
| `mem:<id>` | memori ringkasan obrolan lama `[{id,title,body}]` | dipakai maks **1500 karakter** (MEM_MAX_USE) |
| `rel:<id>` | EXP total + mood hubungan dengan karakter | EXP maks 17.325 (Lv 100) |
| `draft:<id>` | teks yang belum terkirim | — |
| `pos:<id>` | posisi playback audio terakhir per voice note (`t.s` → detik) | — |
| `alias:<id>` | panggilan nama karakter buatan user | — |
| `vv:<id>` | voice terpilih (key) untuk karakter multi-voice | mengikuti daftar voices karakter |

**Mode grup**
| Key | Isi |
|---|---|
| `groups` | daftar grup buatan user (anggota, muted, scene) — maks 20 grup (CFG.MAX_GROUPS) |
| `g:<id>:msgs` | pesan grup per perangkat |
| `gx` | flag grup aktif |

**Pengaturan & cache UI**
| Key | Isi |
|---|---|
| `recent` | 3 karakter terakhir dibuka (menu atas) |
| `theme` | tema tampilan |
| `von`, `vl`, `vspeed` | voice aktif / bahasa (id/jp) / kecepatan |
| `vcode` | kode unlock voice ( pagar kuota TTS) |
| `eng`, `lmodel` | engine AI dev (lorka) + modelnya — hanya Mode dev |
| `rp` | switch Mode Roleplay |
| `autonext` | putar otomatis voice note berikutnya |
| `lastgreet` | waktu sapaan terakhir |
| `sl` | bahasa subtitle (id/jp/both) |
| `wallet` | cache saldo coin/gems (sumber asli MongoDB, cache supaya angka instan) |
| `cloudsig`, `cloudts` | tanda tangan & waktu sinkron cloud terakhir (deteksi perangkat mana yang lebih baru) |

### 6.2 IndexedDB — audio voice note
- Database `neyhra`, object store `vn` (dibuat on-the-fly, `onupgradeneeded` versi 1).
- Menyimpan blob audio mp3 per versi voice note (kunci dari `log:` entry `k/ks`).
- Batas: maks **30 audio** tersimpan (AUDMAX) — melebihi itu audio paling lama dibuang, **teksnya tetap** di `log:`.
- Dihapus saat: pesan terdorong keluar dari 150, note diganti, chat dihapus, atau Reset Semua.

### 6.3 Ukuran client bundle (yang diunduh browser)
| Komponen | Ukuran (di disk, belum gzip) |
|---|---|
| `public/` total | **512 KB** |
| `index.html` (aplikasi utama, inline) | 160 KB |
| `group.js` | 48 KB |
| `profile.js` / `globalchat.js` / `globalchat.adapter.js` | 28 KB masing-masing |
| `shell.js` / `scenario.js` | 24 KB masing-masing |
| CSS (shell, scenario, profile, games, extras, group, globalchat, bonus) | ±100 KB total |
| `assets/` avatar karakter (via GitHub CDN) | 2,2 MB — dimuat malas per karakter yang dilihat |

Skenario UI (`scenario.js/css`) dimuat sebagai modul terpisah, hanya aktif di layar chat.

---

## 7. Matriks "kalau ini hilang, apa yang hilang"

| Kejadian | Konsekuensi |
|---|---|
| User bersihkan localStorage (belum login) | **semua** riwayat chat, memori, EXP, grup, draft hilang permanen (tidak ada salinan server) |
| User bersihkan localStorage (sudah login) | riwayat bisa dipulihkan via sinkron cloud (`userdata` di Mongo) dari perangkat mana pun |
| MongoDB terhapus | akun, saldo, skrip Skenario Skrip, follow, state roleplay, papan game hilang; **riwayat chat di browser tetap aman** |
| Redis mati / env dihapus | Chat Global mati rapi (`enabled:false`; butuh Redis + Mongo) — riwayat di `gc_messages` **tetap aman**; penghitung online hilang; fitur lain normal |
| Redis error saat runtime | kirim pesan tetap berhasil (Mongo sukses, feed best-effort); sync/history balas 502 → klien offline tapi pesan yang sudah dimuat tetap terbaca |
| R2 env dihapus | foto profil baru disimpan ke MongoDB (fallback); foto lama di R2 tetap tampil |
| Instance serverless berganti | sesi AI di RAM hilang → otomatis buat sesi anon baru (riwayat tetap dikirim ulang dari browser, jadi obrolan tidak putus); sesi skenario di-seed ulang dari Mongo |
| Token `authtok` dicuri | penyerang bisa memakai akun (token 256-bit, DB simpan hash) — tidak ada data kartu/pembayaran apa pun di sistem |

---

## 8. Ringkasan env yang mengendalikan penyimpanan

| Env | Menyalakan |
|---|---|
| `MONGODB_URI`, `MONGODB_DB` | login, dompet, bonus, game, profil, follow, Skenario Skrip, sinkron cloud |
| `REDIS_URL` / `UPSTASH_REDIS_REST_URL`+`_TOKEN` / `KV_REST_API_*` | chat global + penghitung online |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `R2_PUBLIC_URL` (`R2_ENDPOINT`) | foto profil di R2 |
| `FISH_API_KEY`, `FISH_MODEL` | TTS voice note |
| `VOICE_CODE` | kode unlock fitur voice (default `NANDAxFURINA`) |
| `AVATAR_BASE` | CDN avatar karakter |
| `DEBUG_RAW` | log prompt/balasan AI mentah ke console server |

*Tidak ada satu pun secret yang boleh dikirim ke browser; semua kunci hanya dibaca `process.env` di server.*
