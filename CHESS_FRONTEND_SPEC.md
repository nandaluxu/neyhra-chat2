# CHESS_FRONTEND_SPEC.md — Kontrak Integrasi Frontend untuk Catur Multiplayer

> Dokumen ini adalah **kontrak integrasi eksplisit** antara backend catur multiplayer (`lib/chessmp.js`, ter-mount di `lib/auth.js`) dan frontend yang akan dibangun. Semua endpoint, field, status, dan contoh respons di bawah diambil dari **implementasi yang sudah jalan dan lulus test e2e** (`scripts/chessmp-e2e.mjs`, 47/47 lulus). AI frontend TIDAK PERLU membaca kode backend — semua yang perlu diketahui ada di sini.
>
> Fitur catur **melawan AI** lama (`/api/auth/chess/*`, `public/games.js`) TIDAK berubah dan tidak dibahas di sini (kecuali untuk referensi bentuk data yang sengaja dibuat konsisten).

---

## 0. Ringkasan kontrak (baca dulu bagian ini)

| Hal | Nilai |
|---|---|
| Base URL semua endpoint | `POST /api/auth/mp/<nama>` (14 endpoint, semua **POST + JSON**) |
| Autentikasi | Header `Authorization: Bearer <token>` (token login yang sama dengan fitur lain) |
| Body | `application/json` |
| Respons sukses | `{ ok: true, ...data }` (HTTP 200) |
| Respons gagal | `{ error: "pesan Indonesian" }` + kode 400/401/403/404/409/429 |
| Sumber kebenaran aturan catur | **100% backend** — frontend hanya mengirim `{ from, to, promo? }` |
| Drag-and-drop | **Milik frontend penuh** — backend tidak tahu UI; server hanya validasi |
| Sinkronisasi multiplayer | **Polling** `POST /api/auth/mp/sync` (2–3 detik saat menunggu lawan; langsung setelah aksi sendiri) |
| Penyimpanan permainan | MongoDB: `chess_rooms` (ruang tantangan, TTL 1 jam), `chess_games` (permainan; aktif TTL 7 hari, selesai permanen), `chess_stats` (statistik pemain) |
| Engine analisis | Internal (negamax + quiescence, default depth 3) — tanpa dependency baru. Kalau admin set env `STOCKFISH_PATH`, otomatis pakai Stockfish UCI (depth `CHESS_SF_DEPTH`, default 12). Frontend tidak memilih engine; nama engine dilaporkan di respons review/hint |
| Tanpa akun? | Semua endpoint mp **wajib login** (401 kalau token invalid/kedaluwarsa) |

### Representasi papan (SAMA dengan game vs AI lama — `public/games.js` bisa jadi referensi render)

- **`board`**: string 64 karakter. Uppercase = putih (`PNBRQK`), lowercase = hitam (`pnbrqk`), `.` = kosong.
- **Indeks kotak 0..63**: `indeks = (8 - rank) * 8 + fileIndex`. Baris 0 = rank 8 (a8 = 0, h8 = 7), baris 7 = rank 1 (a1 = 56, e1 = 60). e2 = 52, e4 = 36.
- **`turn`**: `'w'` (putih) | `'b'` (hitam) — pihak yang giliran sekarang.
- **`you`**: warna pemain yang meminta (`'w'` / `'b'`).
- **`last`**: `{ f, t }` indeks kotak asal & tujuan langkah terakhir — untuk highlight.
- **`moves`** (legal moves, hanya dikirim saat itu giliranmu & game aktif): objek `{ indeksAsal: [indeksTujuan, ...], ... }`. `null` kalau bukan giliranmu — UI harus mematikan interaksi papan.
- **`check`**: indeks kotak raja pihak giliran kalau sedang skak, selain itu `-1`.
- **`capsW` / `capsB`**: daftar karakter bidak yang ditangkap putih / hitam (untuk baris bidak tertangkap). Urut dari yang pertama ditangkap.

### Format catur standar yang tersedia

| Format | Field | Contoh |
|---|---|---|
| SAN (tampilan di move list) | `san` | `Nbd2`, `exd5`, `e8=Q+`, `O-O`, `Qh4#` |
| UCI (engine) | `uci` | `e2e4`, `e7e8q` |
| Long notation (kompatibel game lama) | `hist` | `e2-e4`, `Nb1-c3`, `e7-e8=Q` |
| FEN (replay, integrasi pustaka lain) | `fen` | `rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1` |
| PGN (ekspor/impor) | `pgn` | lihat contoh §9 |

---

## 1. DAFTAR ENDPOINT LENGKAP

Semua endpoint di bawah: `POST`, JSON, butuh `Authorization: Bearer <token>`. Kolom "Rate limit" = panggilan per menit per user (429 kalau lewat: `{ error: "Terlalu sering, tunggu sebentar." }`).

### 1.1 `POST /api/auth/mp/room` — buat ruang tantangan

Membuat kode ruangan untuk diajak main. Host menerima warna sesuai pilihan.

**Request** `{ "color": "w" | "b" }` — opsional; tanpa `color` diacak.

**Respons 200**
```json
{ "ok": true, "code": "6AXXZM", "color": "w", "ttlMin": 60 }
```
- `code`: 6 karakter dari `A-Z` & `2-9` (tanpa 0/1/I/O agar tidak tertukar). Bagikan ke lawan (chat, dsb).
- Ruang otomatis hangus setelah 60 menit tanpa lawan (TTL Mongo).

**Error**: 401 sesi; 429 (10/mnt); 500 kalau gagal membuat kode unik.

### 1.2 `POST /api/auth/mp/room/status` — polling status ruang (dipakai HOST)

**Request** `{ "code": "6AXXZM" }`

**Respons 200**
```json
{ "ok": true, "status": "open", "code": "6AXXZM" }
```
atau ketika lawan sudah join:
```json
{ "ok": true, "status": "matched", "gameId": "008ba093-53f0-4b94-8496-00278545b8bc" }
```
atau `{ "ok": true, "status": "gone" }` kalau ruang tidak ada / hangus / sudah dipakai.

- Frontend host: polling tiap ±2.5 dtk → `matched` → pindah ke layar permainan (GET `game` pakai `gameId`).
- `gone` → kembali ke lobby (kode kadaluarsa atau dibatalkan).
- Rate limit 90/mnt (dirancang untuk polling).

### 1.3 `POST /api/auth/mp/cancel` — batalkan ruang

**Request** `{ "code": "..." }` — hanya host; hanya ruang ber-status `open`. Idempoten (kode tak dikenal tetap `ok`).

**Respons** `{ "ok": true }`

### 1.4 `POST /api/auth/mp/join` — masuk ruangan lewat kode (dipakai TAMU)

**Request** `{ "code": "6AXXZM" }`

**Respons 200** — langsung mendapat state permainan lengkap (struktur `game` = sama dengan §1.6):
```json
{ "ok": true, "game": { "id": "...", "status": "active", "turn": "w", "you": "b", ... } }
```
Warna: host mendapat `color` yang dipilihnya saat membuat ruang; tamu mendapat warna sisanya.

**Error**
- 400 — `"Itu kode ruanganmu sendiri."` (host join kode sendiri)
- 404 — `"Ruang tidak ditemukan. Periksa kodenya lagi."`
- 409 — `"Ruang itu sudah penuh atau sudah dimulai."`
- 429 (10/mnt)

### 1.5 `POST /api/auth/mp/games` — daftar permainan saya

**Request** `{ "page": 0 }` (opsional; default 0; 15 per halaman)

**Respons 200** (nyata dari e2e):
```json
{
  "ok": true,
  "games": [
    {
      "id": "008ba093-53f0-4b94-8496-00278545b8bc",
      "status": "done",
      "turn": "w",
      "you": "b",
      "yourTurn": false,
      "ply": 4,
      "opp": { "name": "Nanda", "username": "nanda" },
      "last": { "f": 3, "t": 39 },
      "sans": ["f3", "e5", "g4", "Qh4#"],
      "result": { "won": "b", "reason": "mate", "score": "0-1" },
      "reviewed": false,
      "updatedAt": "2026-11-16T16:44:19.519Z"
    }
  ],
  "page": 0,
  "more": false,
  "active": 0
}
```
- `status`: `'active'` | `'done'` | `'aborted'` (aborted = dibatalkan sebelum 2 langkah, tidak dihitung).
- `result` hadir hanya untuk `done`/`aborted` (aborted: `{ won: null, reason: "abort", score: "*" }`).
- `reviewed`: apakah analisis sudah pernah dijalankan (untuk badge "Sudah direview").
- `active`: jumlah game masih jalan (badge lobby).
- `more`: true kalau masih ada halaman berikutnya.
- Rate limit 30/mnt.

### 1.6 `POST /api/auth/mp/game` — detail permainan (state penuh)

**Request** `{ "id": "<gameId>" }`

**Respons 200** (nyata, host putih, posisi awal — contoh `moves` dipangkas):
```json
{
  "ok": true,
  "game": {
    "id": "008ba093-53f0-4b94-8496-00278545b8bc",
    "status": "active",
    "turn": "w",
    "you": "w",
    "yourTurn": true,
    "active": true,
    "board": "rnbqkbnrpppppppp................................PPPPPPPPRNBQKBNR",
    "ply": 0,
    "moves": { "12": [28, 20], "52": [36, 44], "53": [37, 45], "54": [38, 46], "55": [39, 47], "62": [45, 52], "57": [40, 42], "58": [43, 51], "59": [44, 52], "60": [48, 52] },
    "last": null,
    "hist": [],
    "sans": [],
    "capsW": [],
    "capsB": [],
    "check": -1,
    "draw": null,
    "white": { "name": "Nanda", "username": "nanda" },
    "black": { "name": "Luxu", "username": "luxu" },
    "opp": { "name": "Luxu", "username": "luxu", "online": true },
    "createdAt": "2026-11-16T16:44:19.495Z",
    "updatedAt": "2026-11-16T16:44:19.495Z",
    "reviewed": false
  }
}
```
- `moves`: **20 langkah sah** pada posisi awal (10 kotak asal, tiap kotak punya array target). PENTING: jumlah langkah = total semua target, bukan jumlah key.
- `hist`: notasi panjang terakhir (maks 80). `sans`: SAN terakhir (maks 80) — **pakai `sans` untuk move list modern**.
- `draw`: `{ "by": "w"|"b", "mine": true|false }` kalau ada tawaran seri aktif (hangus otomatis 90 dtk).
- `opp.online`: lawan aktif < 45 dtk lalu (presence).
- Saat `status: "done"` tambahan: `"result": { "won": "b", "reason": "mate", "score": "0-1" }, "pgn": "<string PGN>"`.
- **Error 404** `"Permainan tidak ditemukan."` — dipakai juga untuk game milik orang lain (tidak membocorkan keberadaan). Rate limit 60/mnt.

### 1.7 `POST /api/auth/mp/sync` — polling ringan (inti sinkronisasi multiplayer)

**Request** `{ "id": "<gameId>", "ply": 4 }` — `ply` = jumlah langkah yang SUDAH diketahui frontend (dari respons sebelumnya). Kirim `0` kalau belum tahu apa-apa.

**Respons 200** (nyata, e2e — tamu mengecek setelah 2 langkah dikenalnya):
```json
{
  "ok": true,
  "id": "008ba093-53f0-4b94-8496-00278545b8bc",
  "status": "done",
  "ply": 4,
  "turn": "w",
  "yourTurn": false,
  "board": "rnb.kbnrpppp.ppp............p.........Pq.....P..PPPPP..PRNBQKBNR",
  "last": { "f": 3, "t": 39 },
  "check": -1,
  "draw": null,
  "newMoves": [
    { "n": 3, "from": 54, "to": 38, "uci": "g2g4", "san": "g4", "ts": 1794847459516 },
    { "n": 4, "from": 3, "to": 39, "uci": "d8h4", "san": "Qh4#", "ts": 1794847459518 }
  ],
  "oppOnline": false,
  "result": { "won": "b", "reason": "mate", "score": "0-1" },
  "pgn": "[Event \"Neyhra Multiplayer Chess\"]\n...",
  "reviewed": false
}
```
- `newMoves`: HANYA dikirim kalau `ply` server > `ply` yang dikirim frontend. Berisi semua langkah sejak itu (sampai 1 objek per langkah). Frontend menerapkan animasi satu per satu.
- Kalau tidak ada perubahan: field `newMoves` tidak ada sama sekali (hemat byte).
- `result`+`pgn` hanya muncul saat status `done`; game `aborted`: `result: { won: null, reason: "abort", score: "*" }`.
- `check`: kotak raja pihak giliran kalau skak (setelah langkah lawan = raja MU skak).
- **Setelah menerima `newMoves`, update state lokal: `ply` = `newMoves[newMoves.length-1].n`, terapkan `board`, `last`, `check`.**
- Rate limit 40/30 dtk — polling 2–3 dtk aman.

### 1.8 `POST /api/auth/mp/move` — kirim langkah (divalidasi backend)

Frontend drag-and-drop → saat drop, kirim:

**Request** `{ "id": "<gameId>", "from": 53, "to": 45, "promo": "Q" }`
- `from`/`to`: indeks 0..63. `promo`: `"Q"|"R"|"B"|"N"` (opsional, default Q — hanya relevan untuk promosi pion; nilai lain ditolak 400).

**Respons 200** (nyata, e2e — langkah terakhir `Qh4#`):
```json
{
  "ok": true,
  "game": { "id": "...", "status": "done", "turn": "w", "you": "b", "yourTurn": false,
            "board": "rnb.kbnrpppp.ppp............p.........Pq.....P..PPPPP..PRNBQKBNR", "ply": 4, "moves": null,
            "last": { "f": 3, "t": 39 }, "hist": ["f2-f3", "e7-e5", "g2-g4", "Qd8-h4"],
            "sans": ["f3", "e5", "g4", "Qh4#"], "capsW": [], "capsB": [],
            "check": -1, "draw": null, "...": "...",
            "result": { "won": "b", "reason": "mate", "score": "0-1" },
            "pgn": "[Event \"Neyhra Multiplayer Chess\"]\n...\n\n1. f3 e5 2. g4 Qh4# 0-1\n" },
  "move": { "n": 4, "san": "Qh4#", "uci": "d8h4", "from": 3, "to": 39 }
}
```
- `game`: state penuh SETELAH langkah diterapkan (format = §1.6). Kalau permainan berakhir, `result`+`pgn` sudah termasuk.
- `move`: langkah yang barusan diterima (untuk animasi lokal / konfirmasi).
- **Semua aturan divalidasi backend**: langkah pseudo-ilegal, melanggar giliran, meninggalkan raja terskak, rokade lewat kotak diserang, promosi salah — semua ditolak. Frontend TIDAK perlu (dan tidak boleh) memvalidasi ulang.
- **Error**
  - 400 `"Langkah tidak dikenal."` (from/to/promo rusak) / `"Langkah itu tidak boleh."` (langkah ilegal — tampilkan highlight merah / batalkan drag)
  - 404 `"Permainan tidak ditemukan."`
  - 409 `"Permainan sudah selesai."` / `"Bukan giliranmu."` (race: lawan lebih cepat — refresh state) / `"Permainan berubah, coba lagi."` (race langkah ganda — ambil `game` ulang)
  - 429 (120/mnt)
- Rate limit 120/mnt per user.

### 1.9 `POST /api/auth/mp/resign` — menyerah / batal

**Request** `{ "id": "<gameId>" }`

**Respons 200**: `{ ok, game }` (state setelah resign).
- Kalau `ply < 2` (belum ada 1 langkah lengkap): game jadi `status: "aborted"`, `result: { won: null, reason: "abort", score: "*" }` — **tidak masuk statistik** (UI: tombol "Batalkan").
- Kalau sudah ≥ 2 langkah: `status: "done"`, `won` = warna lawan, `reason: "resign"`, skor `1-0`/`0-1`.
- Kalau game sudah selesai sebelumnya: respons tetap `ok` + state terakhir (idempoten).

### 1.10 `POST /api/auth/mp/draw` — tawarkan / terima / tolak seri

**Request** `{ "id": "<gameId>", "act": "offer" | "accept" | "decline" }`

**Respons**
- `offer` → `{ "ok": true, "draw": { "by": "w", "mine": true } }`. Tawaran terlihat lawan lewat `sync`/`game` field `draw` selama ≤ 90 dtk. **Melangkah otomatis menolak tawaran** (drawOffer dihapus saat move).
- `accept` → `{ ok, game }` dengan `status: "done"`, `result: { won: "d", reason: "agreement", score: "1/2-1/2" }` — statistik seri untuk kedua pemain.
  - 409 `"Tidak ada tawaran seri dari lawan."` kalau tidak ada tawaran aktif / sudah hangus / itu tawaranmu sendiri.
- `decline` → `{ "ok": true, "draw": null }`.
- Error lain: 404, 409 `"Permainan sudah selesai."`, 429 (20/mnt).

### 1.11 `POST /api/auth/mp/hint` — rekomendasi langkah terbaik (game AKTIF)

**Request** `{ "id": "<gameId>" }` — harus game aktif & **giliranmu** (409 `"Bukan giliranmu."`).

**Respons 200** (nyata, e2e):
```json
{ "ok": true, "best": { "san": "Nc3", "uci": "b1c3", "from": 57, "to": 42, "evalCp": 50 }, "engine": "internal-d3" }
```
- `evalCp`: evaluasi **dari perspektif pemain yang minta** (positif = posisimu lebih baik, dalam centipawn).
- Kalau posisi menang/kalah pasti: tambahan `"mate": 3` (positif = kamu menang dalam 3 langkah; negatif = kamu kalah dalam N).
- `best: null` hanya kalau posisi sudah mati/pat (teoretis tidak terjadi di game aktif).
- Rate limit 10/mnt. UI: tombol "Hint" dengan konfirmasi, highlight panah dari `from` → `to`.

### 1.12 `POST /api/auth/mp/review` — analisis pasca-permainan (Chess Review)

**Request** `{ "id": "<gameId>" }` — game harus `status: "done"`.

**Respons 200** — objek `review` (nyata dari e2e, Fool's mate; dipangkas):
```json
{
  "ok": true,
  "review": {
    "engine": "internal-d2",
    "depth": 2,
    "ev": [0, -20, -60, -99999, -100000],
    "mates": [null, null, null, -1, 0],
    "moves": [
      {
        "ply": 1, "color": "w", "san": "f3", "uci": "f2f3", "from": 53, "to": 45,
        "evalBefore": 0, "evalAfter": -20, "cpLoss": 20,
        "winBefore": 50, "winAfter": 48.2, "delta": 1.8, "acc": 92.1,
        "label": "Great", "bestSan": "Nc3", "bestUci": "b1c3"
      },
      {
        "ply": 3, "color": "w", "san": "g4", "uci": "g2g4", "from": 54, "to": 38,
        "evalBefore": -60, "evalAfter": -99999, "cpLoss": 99939,
        "winBefore": 44.5, "winAfter": 0, "delta": 44.5, "acc": 11.7,
        "label": "Blunder", "bestSan": "Nc3", "bestUci": "b1c3"
      }
    ],
    "accuracy": { "w": 51.9, "b": 100 },
    "counts": {
      "w": { "best": 0, "great": 1, "excellent": 0, "mistake": 0, "miss": 0, "blunder": 1 },
      "b": { "best": 1, "great": 1, "excellent": 0, "mistake": 0, "miss": 0, "blunder": 0 }
    },
    "reviewedAt": "2026-11-16T16:44:19.665Z"
  }
}
```
- **Perhitungan berat** (satu kali per game; hasil disimpan permanen — panggilan berikutnya instan). UI WAJIB menampilkan loading "Menganalisis..." (bisa 2–30 detik tergantung panjang game & engine).
- `ev`: evaluasi tiap posisi (cp, **perspektif PUTIH**, panjang = `ply + 1`) — **data grafik evaluasi**. Nilai ±99999/±100000 = mate (clamp ke ±10 saat menggambar agar grafik tetap terbaca).
- `mates`: null | ±N per posisi (N = sisa langkah sampai mat; **tanda dari perspektif putih**: positif = putih menang dalam N, negatif = hitam menang dalam N, `0` = posisi sudah skakmat). Contoh: `-1` = hitam punya mate dalam 1).
- `moves[]`: analisis per langkah:
  - `color`: pemain yang melangkah. `evalBefore`/`evalAfter`: cp putih sebelum/sesudah.
  - `cpLoss`: kerugian pemain (cp, positif = buruk). `winBefore`/`winAfter`/`delta`: win% pemain.
  - `acc`: akurasi langkah 0–100. `label`: **`Best` | `Great` | `Excellent` | `Mistake` | `Miss` | `Blunder`** (definisi & warna rekomendasi di §7).
  - `bestSan`/`bestUci`: **rekomendasi langkah terbaik** pada posisi sebelum langkah (untuk "kamu sebaiknya main ...").
- `accuracy`: rata-rata per pemain. `counts`: jumlah tiap label per pemain (untuk ringkasan/chip).
- `engine`: `"internal-d<n>"` atau `"stockfish-d<n>"` (admin set `STOCKFISH_PATH`).
- **Error**: 404; 409 `"Analisis hanya untuk permainan yang sudah selesai."` / `"Permainan yang dibatalkan tidak dianalisis."`; 429 (3/mnt).
- Setelah review pertama kali, statistik akurasi + label kedua pemain otomatis masuk `chess_stats`.

### 1.13 `POST /api/auth/mp/replay` — data memutar ulang

**Request** `{ "id": "<gameId>" }` (peserta game; game aktif pun boleh — replay berjalan).

**Respons 200** (nyata, e2e; FEN dipangkas):
```json
{
  "ok": true,
  "meta": {
    "id": "008ba093-53f0-4b94-8496-00278545b8bc",
    "status": "done", "ply": 4,
    "white": { "name": "Nanda", "username": "nanda" },
    "black": { "name": "Luxu", "username": "luxu" },
    "result": { "won": "b", "reason": "mate", "score": "0-1" },
    "pgn": "[Event \"...\"]...\n\n1. f3 e5 2. g4 Qh4# 0-1\n",
    "reviewed": false, "createdAt": "...", "endedAt": "..."
  },
  "initial": { "board": "rnbqkbnrpppppppp....PPPPPPPPRNBQKBNR", "fen": "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1" },
  "positions": [
    { "ply": 1, "color": "w", "san": "f3", "uci": "f2f3", "from": 53, "to": 45, "board": "<64 char>", "fen": "rnbqkbnr/pppppppp/8/8/8/5P2/PPPPP1PP/RNBQKBNR b KQkq - 0 1", "lastMove": { "f": 53, "t": 45 }, "ts": 1794847459516 },
    { "ply": 4, "color": "b", "san": "Qh4#", "uci": "d8h4", "from": 3, "to": 39, "board": "<64 char>", "fen": "rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3", "lastMove": { "f": 3, "t": 39 }, "ts": 1794847459518 }  ]
}
```
- Stepper frontend: index `-1` = `initial`; index `i` = `positions[i]`. Setiap posisi sudah berisi `board` JADI (tinggal render, tidak perlu engine frontend). `fen` disertakan supaya bisa dipakai pustaka papan eksternal kalau mau.
- `check` muncul di posisi kalau raja pihak giliran sedang skak (indeks kotaknya).
- Rate limit 20/mnt.

### 1.14 `POST /api/auth/mp/stats` — statistik pemain

**Request** `{ "user": "luxu" }` — opsional; tanpa `user` = statistik sendiri. Username (huruf kecil) seperti di profil.

**Respons 200** (nyata, e2e):
```json
{
  "ok": true,
  "user": { "username": "luxu", "name": "Luxu" },
  "stats": {
    "played": 1, "won": 1, "drawn": 0, "lost": 0,
    "winRate": 100,
    "accuracy": null, "accGames": 0, "bestAcc": 0,
    "labels": { "best": 0, "great": 0, "excellent": 0, "mistake": 0, "miss": 0, "blunder": 0 },
    "updatedAt": "2026-11-16T16:44:19.519Z"
  }
}
```
- `accuracy`: rata-rata akurasi dari game yang sudah **direview** (`accGames`); `null` kalau belum ada game yang dianalisis.
- `labels`: akumulasi label seumur hidup (bertambah tiap review dijalankan).
- **Error**: 404 `"Pemain itu tidak ditemukan."` (username tak dikenal); 429 (20/mnt).

---

## 2. ALUR KOMUNIKASI END-TO-END

### 2.1 Memulai pertandingan (host)

```
[Host] POST /mp/room { color } ──► { code }            (UI: tampilkan kode besar + tombol "Salin")
[Host] polling POST /mp/room/status { code } tiap 2.5 dtk
        ├─ status "open"    → tetap menunggu (timer ttl 60 mnt)
        └─ status "matched" + gameId → POST /mp/game { id: gameId } → layar permainan
```

### 2.2 Memulai pertandingan (tamu)

```
[Tamu] input kode ──► POST /mp/join { code }
        └─ 200 { game } → langsung render papan (PUTIH jalan duluan bila tamu = hitam)
        └─ 404/409 → pesan error sesuai §1.4
```

### 2.3 Selama permainan (kedua pihak, loop utama)

```
saat giliranmu (game.moves ≠ null):
  drag & drop bidak ──► (opsional preview) ──► POST /mp/move { id, from, to, promo? }
      ├─ 200 { game, move } → render state baru + animasi; LANJUT polling (bukan giliranmu lagi)
      ├─ 400 "Langkah itu tidak boleh." → kembalikan bidak ke posisi semula (drag dibatalkan)
      └─ 409 "Permainan berubah/Bukan giliranmu." → POST /mp/game ulang, render ulang

saat menunggu lawan:
  polling POST /mp/sync { id, ply } tiap 2–3 dtk
      ├─ newMoves ada → animasikan tiap langkah berurutan → update ply/board/last/check
      ├─ draw dari lawan → tampilkan modal terima/tolak (POST /mp/draw { act })
      ├─ status done → tampilkan hasil + tombol "Lihat Analisis" & "Putar Ulang"
      └─ tidak ada perubahan → ulangi polling
```

**Optimasi**: setelah `move` sukses giliran kembali ke lawan — mulai polling. Setelah `sync` menerima langkah lawan dan itu giliranmu — STOP polling, aktifkan interaksi (`game.moves` dari respons `sync` tidak lengkap untuk interaksi → panggil `POST /mp/game` satu kali untuk mendapatkan `moves` sah, ATAU langsung coba `move` — backend tetap memvalidasi; rekomendasi: panggil `game` agar UI bisa highlight kotak asal bidak sendiri).

### 2.4 Setelah permainan selesai

```
POST /mp/games { page }           → daftar (badge "aktif N", tombol Lanjut/Review/Replay)
POST /mp/review { id }             → pertama kali: HITUNG (loading...) → review lengkap (§1.12)
                                    kali berikutnya: instan (cached di dokumen game)
POST /mp/replay { id }             → stepper posisi (§1.13)
POST /mp/stats                    → statistik saya / pemain lain (§1.14)
```

---

## 3. MEKANISME SINKRONISASI MULTIPLAYER (kontrak polling)

Tidak ada WebSocket di infrastruktur ini (Vercel serverless — sama seperti Chat Global yang memakai polling adaptif). Kontrak sinkronisasi:

1. **State versi** = `ply` (jumlah langkah total). Frontend menyimpan `ply` terakhir yang diketahuinya.
2. `sync { id, ply }` mengembalikan **semua langkah sejak `ply` tersebut** (`newMoves`) + state ringan terkini (`board`, `turn`, `check`, `draw`, `result`). Server TIDAK mengirim ulang seluruh riwayat.
3. `board` di `sync` SELALU terkini (64 char) — frontend boleh langsung render tanpa menerapkan langkah satu-satu (gunakan `newMoves` hanya untuk animasi berurutan).
4. **Presence**: `oppOnline` (heartbeat implisit dari aktivitas lawan < 45 dtk). Tampilkan titik hijau/abu.
5. **Tawaran seri** dikirim lewat field `draw` di `game`/`sync`; kadaluarsa 90 dtk otomatis (server mengabaikan saat terjadi); melangkah = menolak implisit.
6. **Rate limit sync 40/30 dtk** → interval polling MINIMAL 2 dtk. Rekomendasi: 2.5 dtk saat menunggu, 5 dtk saat idle lama, berhenti saat game selesai / tab tidak aktif (`visibilitychange`).
7. Semua operasi tulis (`move`, `draw`, `resign`) **atomik di server** (guard `ply`/`status`): dua klik bersamaan → satu sukses, satu dapat 409 → UI cukup refresh state. Tidak ada state ganda.

---

## 4. STRUKTUR DATA PERSISTEN (untuk pemahaman, bukan akses langsung)

### 4.1 `chess_games` (koleksi Mongo — game)
```
{ _id: gameId, status: 'active' | 'done' | 'aborted',
  whiteId, whiteName, whiteUser, blackId, blackName, blackUser,   // User = username
  b: [64 char], t: 'w'|'b', c: 'KQkq-subset', e: indeksEP|-1, h: halfmoveClock,   // keadaan engine
  ply, hist: [long-notation], moves: [{ n, from, to, promo?, uci, san, ts }],
  keys: [posKey] (deteksi pengulangan), capsW: [], capsB: [], lastMove: {f,t},
  drawOffer: { by, at } | null,
  won: 'w'|'b'|'d'|null, reason: 'mate'|'stale'|'50'|'rep'|'material'|'agreement'|'resign'|'abort'|null,
  result: '1-0'|'0-1'|'1/2-1/2'|'*'|null, pgn: string|null,
  review: objek-review (sekali dihitung), seenW, seenB (presence),
  createdAt, updatedAt, endedAt, exp: TTL 7 hari (HANYA saat aktif; dihapus saat selesai → game selesai permanen) }
```

### 4.2 `moves[]` per langkah (unit riwayat)
`{ n: 1.., from: 0..63, to: 0..63, promo?: 'Q'|'R'|'B'|'N', uci: "e2e4", san: "Nbd2", ts: milidetik }`

### 4.3 `review` (hasil analisis, disimpan permanen di dokumen game)
Struktur = respons §1.12 `review`. Field: `engine, depth, ev[], mates[], moves[], accuracy{w,b}, counts{w,b}{...}, reviewedAt`.

### 4.4 `chess_stats` (statistik pemain)
```
{ _id: userId, name, played, won, drawn, lost,
  accSum, accGames (jumlah game yang direview), bestAcc (akurasi game terbaik),
  labels: { best, great, excellent, mistake, miss, blunder }, updatedAt }
```
Di-update otomatis: game selesai → played/won/drawn/lost; review dijalankan → akurasi + label.

### 4.5 PGN yang dihasilkan (nyata)
```
[Event "Neyhra Multiplayer Chess"]
[Site "neyhra-chat2"]
[Date "2026.11.16"]
[Round "-"]
[White "Nanda"]
[Black "Luxu"]
[Result "0-1"]
[Termination "checkmate"]

1. f3 e5 2. g4 Qh4# 0-1
```
- `Termination`: checkmate | stalemate | threefold repetition | 50-move rule | insufficient material | draw by agreement | resignation | abandoned.

---

## 5. KOMPONEN UI YANG PERLU DIBUAT + DATA YANG DIAMBIL

| # | Komponen | Endpoint/data yang dipakai |
|---|---|---|
| 1 | **Lobby Catur MP** — daftar game aktif/selesai, tombol "Buat Tantangan", "Masuk dengan Kode" | `POST /mp/games` (`games[]`, `active`, `more`, `page`) |
| 2 | **Panel Buat Tantangan** — pilih warna (Putih/Hitam/Acak), tampilkan kode + countdown TTL + tombol salin | `POST /mp/room` (`code`, `color`, `ttlMin`) |
| 3 | **Panel Masuk Kode** — input 6 karakter | `POST /mp/join` (`game`) |
| 4 | **Layar Permainan** — papan 8×8, highlight `moves`, `last`, `check`, bidak tertangkap, nama+presence lawan, move list SAN, tombol Menyerah / Seri / Hint | `POST /mp/game` + `POST /mp/sync` (loop) + `POST /mp/move` |
| 5 | **Modal Promosi** — pilih Q/R/B/N saat pion sampai rank akhir (frontend tahu dari `from` pion & `to` di baris 0/7); kirim `promo` | `POST /mp/move { promo }` |
| 6 | **Modal Tawaran Seri** — dari `draw` (mine:false) di `sync`/`game`; tombol Terima/Tolak | `POST /mp/draw { act }` |
| 7 | **Modal Hasil** — `result.score` + alasan (`reason`), tombol Analisis & Replay, tombol PGN (copy) | dari `game`/`sync`/`resign`/`draw-accept` |
| 8 | **Layar Review (Chess Review)** — grafik evaluasi (SVG/canvas dari `ev`), move list dengan label berwarna, akurasi kedua pemain, ringkasan counts, detail per langkah (`evalBefore/After`, `delta`, `acc`, `bestSan`) | `POST /mp/review` |
| 9 | **Replay Player** — stepper < 1/N >, auto-play, papan + `lastMove` + `san`, FEN opsional; mulai dari `initial` | `POST /mp/replay` (`initial`, `positions`, `meta.pgn`) |
| 10 | **Panel Statistik** — W/D/L, winRate, akurasi rata-rata, bestAcc, distribusi label | `POST /mp/stats` (`stats`) |
| 11 | **Komponen Papan reusable** — render `board` (64 char), orientasi (putih bawah bila `you==='w'`, hitam bawah bila `'b'`), koordinat a-h/1-8 | dipakai 4, 9 |
| 12 | **Hint overlay** — panah `from → to` dari `best` | `POST /mp/hint` |

**Catatan render papan**: format identik dengan game vs AI yang sudah ada (`public/games.js` — fungsi render board/unicode piece bisa dipakai ulang). `you==='b'` → papan diputar 180° (indeks i tetap absolut; frontend memetakan ke sel grid sendiri).

---

## 6. STATUS LOADING, ERROR, DAN KONDISI KHUSUS UI

### 6.1 Loading states yang WAJIB ada
| Konteks | Tampilkan |
|---|---|
| `room/status` polling | indikator kecil "menunggu lawan..." + countdown TTL 60 mnt |
| `move` (network) | bidak "melayang" di kotak tujuan (optimistik) → sukses: animasi; 400: snap-back |
| `review` PERTAMA (belum ada) | loading besar "Menganalisis permainan... (bisa 30 dtk)" — jangan timeout di client fetch (set > 35 dtk) |
| `replay`, `game`, `stats` | skeleton ringan |

### 6.2 Kode error → perlakuan UI
| HTTP | Kondisi | UI |
|---|---|---|
| 400 | input/langkah ilegal | pesan inline (tanpa modal) + snap-back bidak |
| 401 | sesi habis | arahkan login ulang (sama seperti pola fitur lain) |
| 403 | — | (tidak dipakai modul ini) |
| 404 | game/room/user tidak ada (atau bukan milikmu) | "Permainan tidak ditemukan" → kembali ke lobby; **jangan** tampilkan detail |
| 409 | state konflik (bukan giliranmu / game berubah / sudah selesai / ruang penuh) | refresh state dari `POST /mp/game`; kalau game selesai → layar hasil |
| 429 | rate limit (terlalu sering polling/klik) | delay otomatis (jangan spam retry); pesan "Terlalu sering, tunggu sebentar." |
| 500/502 | server | toast error + retry manual |

### 6.3 Kondisi khusus
- **`moves: null`** → bukan giliranmu ATAU game tidak aktif → papan read-only (drag dimatikan).
- **`promo`**: frontend mendeteksi pion sendiri menuju rank 1/8 → tampilkan modal pilih bidak SEBELUM kirim `move` (backend juga memvalidasi promo; default Q).
- **`check >= 0`** → highlight merah kotak raja pihak giliran + status "Skak!".
- **`draw` kadaluarsa**: server mengabaikan tawaran > 90 dtk; UI menyembunyikan modal saat `draw: null` pada sync berikutnya.
- **Game `aborted`** (resign < 2 langkah): tampil "Permainan dibatalkan" — tanpa statistik, tanpa tombol review.
- **`oppOnline: false`** saat menunggu > 2 mnt → info "lawan mungkin offline — game hangus otomatis setelah 7 hari tidak aktif".
- **Race double-click** → satu request 409 → jangan double-submit; disable tombol saat request jalan.
- **`reviewed: true`** di list → tombol review langsung (cached); `false` → tombol dengan peringatan "menganalisis memakan waktu".
- **Nilai `ev` ekstrem (±99999/±100000)** = mate → clamp saat menggambar grafik (mis. ±10 → "M" marker).
- **Papan `you==='b'`**: semua indeks tetap 0..63 absolut; hanya rendering yang diputar.

---

## 7. LABEL REVIEW, GRAFIK EVALUASI & AKURASI (definisi EKSPLISIT)

### 7.1 Label langkah
`delta` = penurunan peluang menang pemain karena langkahnya (poin win%). `isBest` = langkah persis sama dengan best move engine.

| Label | Syarat | Warna rekomendasi |
|---|---|---|
| **Best** | `isBest` | hijau tua / bintang |
| **Great** | `delta ≤ 2` | hijau muda |
| **Excellent** | `2 < delta ≤ 5` | hijau sangat muda / netral positif |
| **Mistake** | `5 < delta < 15` | oranye |
| **Miss** | khusus: sebelumnya posisi MENANG (win% ≥ 90) menjadi tidak menang (< 90), delta < 20 | kuning (ikon "⚠" — "peluang menang terlewat") |
| **Blunder** | `delta ≥ 15` (dan bukan kasus Miss) | merah |

### 7.2 Grafik evaluasi
- Data = `review.ev` (cp perspektif PUTIH, index 0 = posisi awal). Titik i = posisi SEBELUM langkah ke-i.
- Skala: clamp ±10 untuk mate (99999/100000). Garis nol = seimbang. Warna area atas (positif) = putih, bawah = hitam.
- `mates[i]` non-null → tandai segmen dengan "M<N>" (tanda mengikuti perspektif putih, lihat di atas).
- Hover titik i → tampilkan `san` langkah ke-i + `evalBefore` → pasangkan dengan `review.moves[i-1]` (evalAfter = ev[i]).

### 7.3 Akurasi
- Per langkah: `acc = clamp(103.1668 × e^(−0.04354×delta) − 3.1668, 0, 100)`.
- Per pemain: rata-rata `acc` seluruh langkahnya (`accuracy.w/b`).
- Statistik profil (`mp/stats`): rata-rata akurasi antar game yang sudah direview + `bestAcc`.

---

## 8. CONTOH RESPONSE NYATA LENGKAP (dari test e2e yang lulus)

Contoh lengkap tersimpan di `scripts/chessmp-sample-responses.json` (hasil run `scripts/chessmp-e2e.mjs`): `room`, `join`, `game`, `sync`, `games`, `stats`, `review`, `replay`, `hint`, `draw_accept`, `move_mate`. Contoh terpenting sudah tercetak di §1.1–§1.14.

Skenario contoh: Fool's mate — Nanda (putih) vs Luxu (hitam): `1. f3 e5 2. g4 Qh4# 0-1`.
Review menghasilkan: `ev = [0, -20, -60, -99999, -100000]`, `f3=Great (acc 92.1)`, `e5=Great`, `g4=Blunder (acc 11.7, cpLoss 99939)`, `Qh4#=Best`; akurasi `w=51.9, b=100`; counts `w: {great:1, blunder:1}`, `b: {best:1, great:1}`.

---

## 9. ENV BACKEND (konteks — frontend tidak mengatur)

| Env | Default | Efek |
|---|---|---|
| `STOCKFISH_PATH` | (kosong) | path binary engine UCI; kosong → engine internal. Vercel serverless tidak bisa spawn → biarkan kosong di Vercel |
| `CHESS_MP_DEPTH` | 3 (maks 5) | kedalaman engine internal untuk review |
| `CHESS_MP_HINT_DEPTH` | 3 | kedalaman hint |
| `CHESS_SF_DEPTH` | 12 | kedalaman Stockfish saat dipakai |

Semua endpoint tetap berfungsi identik apapun engine aktif; hanya nama `engine` + ketelitian yang berubah.

---

## 10. CHECKLIST INTEGRASI CEPAT

1. Token Bearer sama dengan fitur auth lain → semua request `POST /api/auth/mp/*`.
2. Render papan: `board` 64 char + indeks `(8-rank)*8+file` (salin pola dari `public/games.js` game vs AI).
3. Mulai game: `room` → bagikan `code` → `join` (host polling `room/status`).
4. Loop: giliranmu → `move { from, to, promo? }`; nunggu → `sync { id, ply }` tiap 2.5 dtk.
5. Selesai → `review` (loading sekali) → grafik `ev` + label + akurasi; `replay` → stepper; `stats` untuk profil.
6. Error: 400 inline, 409 refresh state, 429 delay, 404 balik lobby.
7. Jangan validasi aturan catur di frontend — backend satu-satunya sumber kebenaran; `moves` dari server untuk highlight saja.

---

## 11. Catatan implementasi frontend (ditemukan saat membangun `public/chessmp.js`)

Bagian-bagian spec di atas yang ternyata tidak lengkap / perlu diturunkan sendiri oleh frontend.
Backend TIDAK diubah; semua sudah ditangani di `public/chessmp.js`:

1. **`check: -1` saat permainan selesai (termasuk skakmat).** Endpoint `game`/`sync`/`move` hanya
   mengirim `check` saat game AKTIF (lihat §1.6/§1.7 contoh mate: `check: -1`). Supaya raja yang
   skakmat tetap disorot merah, frontend menurunkan sendiri kotak rajanya dari `board` + `result`
   (murni tampilan; kebenaran aturan tetap 100% di server).
2. **`sync` tidak memuat `capsW`/`capsB`.** Baris bidak tertangkap setelah langkah lawan hanya
   bisa diperbarui lewat `move`/`game` penuh. Frontend menurunkan bidak tertangkap dari isi
   `board` (16 bidak awal dikurangi yang tersisa) — ikut benar otomatis setelah promosi.
3. **`sans`/`hist` dipangkas 80 TERAKHIR.** Untuk game > 80 ply, penomoran daftar langkah harus
   dihitung dari offset (`ply total - panjang + 1`), bukan dari 1 — kalau tidak, nomor baris dan
   pasangan putih/hitam bisa salah. `review.moves[]`/`replay.positions[]` memuat semua, jadi
   daftar lengkap ambil dari sana.
4. **Presence beda bentuk:** `game` → `opp.online` (boolean), `sync` → `oppOnline` (boolean).
   Keduanya harus dipetai ke titik presence yang sama.
5. **Modal/tombol `closeovl`** (Tutup) adalah kebutuhan frontend murni — tidak ada di spec;
   idempoten terhadap `resultShown`.
6. **`svg` global CSS di index.html** (`svg{fill:none;stroke:currentColor;stroke-width:1.7}`):
   elemen SVG baru di frontend WAJIB men-set `fill`/`stroke`/`stroke-width`/`width`/`height`
   secara eksplisit per elemen (atribut presentasi dikalahkan rule CSS ini lewat pewarisan),
   kalau tidak akan muncul artefak stroke raksasa & ukuran 20×20 default.

---

## 12. Live Move Analysis (rating tiap langkah, jalan di klien)

Menilai setiap langkah **secara otomatis saat dimainkan** — di Catur vs AI (`public/games.js`) dan Catur Multiplayer (`public/chessmp.js`) — tanpa Stockfish dan tanpa endpoint baru. Murni tampilan: **tidak memvalidasi langkah dan tidak mengubah state permainan** (aturan tetap 100% dari server). Review pasca-game di §7 (label backend: Best/Great/Excellent/Mistake/Miss/Blunder) **tidak berubah**; ini sistem terpisah dengan tujuh label sendiri.

### File
| File | Peran |
|---|---|
| `public/chessan-engine.js` | Engine mandiri: generator langkah (lolos perft), evaluasi (material + PST + struktur pion + mobilitas + keselamatan raja), pencarian alpha-beta (TT, null-move, LMR, quiescence+SEE), `rateMove`. Dipakai Worker dan thread utama (file yang sama). |
| `public/chessan-worker.js` | Web Worker: menilai di luar thread UI + cache pencarian per game. |
| `public/chessan.js` | Manajer `window.CHAN`: antrean, penyimpanan, indikator papan, ikon. Tanpa Worker otomatis jatuh ke thread utama (hasil sama). |
| `public/chessan.css` | Indikator + ikon daftar + banner telusur. |
| `scripts/chessan-test.mjs` (`npm run an:test`) | Perft, taktik, regresi rating, determinisme. |

### Tujuh rating
Dihitung dari **penurunan peluang menang** (`winPct(cp) = 50 + 50·(2/(1+e^(−0.00368208·cp)) − 1)`, skor mat dijepit) antara evaluasi terbaik sebelum langkah dan evaluasi setelah langkah yang dimainkan, dari sudut pemain yang melangkah:

| Rating | Ikon | Warna | Syarat |
|---|---|---|---|
| Brilliant | `!!` | `#26c2a3` (baru) | setara langkah terbaik **dan** mengorbankan material ≥ 2 poin (diukur di ujung PV setelah tangkapan diselesaikan) **dan** posisi sesudahnya ≥ −0,5 pion **dan** belum menang telak (≤ +4 pion, kecuali pengorbanan ≥ 5 poin menuju mat) **dan** tidak ada alternatif tanpa pengorbanan yang sama kuatnya (selisih ≥ 35 cp) **dan** bukan langkah satu-satunya |
| Best | `!` | `#81b64c` | langkah pilihan engine, atau selisih ≤ 0,25% |
| Excellent | jempol | `#81b64c` | ≤ 2% |
| Good | centang | `#95b776` | ≤ 5% |
| Inaccuracy | `?!` | `#f7c631` | ≤ 10% |
| Mistake | `?` | `#f0a037` | ≤ 20% |
| Blunder | `??` | `#d93a32` | > 20% |

Warna/ikon memakai palet penanda review di `chessmp.js`; hanya Brilliant (teal), Good, dan Inaccuracy yang baru. Pada 8 ply pertama selisih 1,5% diabaikan (evaluasi posisi awal sangat tipis).

### Indikator di papan
- Kotak tujuan diberi warna rating (`.cn-sq`) dan ikon di **pojok kanan atas bidak** (`.cn-bg`, **anak elemen `.ch-p`** sehingga ikut meluncur selama animasi langkah).
- Muncul **seketika** (tanpa animasi masuk), bertahan `CHAN.CFG.hold` (700 ms), lalu memudar `CHAN.CFG.fade` (2600 ms). Sisa waktu dihitung dari `born`, jadi render ulang papan di tengah fade **melanjutkan**, bukan mengulang.
- `render()` mengganti seluruh papan, maka `CHAN.attach()` dipanggil di akhir `render()` (games.js) dan `afterPaint()` (chessmp.js). Pengaman: indikator hanya dipasang bila bidak di kotak tujuan cocok dengan posisi langkah itu.

### Penyimpanan & telusur riwayat
- Rating tersimpan di `localStorage` (`chan1:<id game>`; vs AI memakai `ai:cur`), maksimal 30 game, divalidasi terhadap urutan langkah (prefix beda → dibuang) dan `CHENG.VER` (**naikkan `VER` bila perilaku penilaian berubah**).
- Telusur: Multiplayer & vs AI — klik langkah di daftar atau tombol ‹ ›; papan dikunci (read-only) sampai "Posisi terkini". Replay Multiplayer memakai rating yang sama. Langkah baru otomatis kembali ke posisi terkini. Ikon rating juga permanen di daftar langkah.
- Riwayat dibangun dari: langkah yang dimainkan sesi ini; `/mp/replay` (hanya bila tracker kurang, maks 1× per 15 dtk); `hist` vs AI (diparse, hanya jika `hist.length === ply`); atau penyimpanan lokal (`CHAN.resume`) untuk game vs AI > 60 ply. Papan hasil tracker **dibandingkan dengan papan server**; beda → analisis game itu dimatikan diam-diam (tidak pernah menampilkan rating yang mungkin salah).

### Determinisme & performa
Batas simpul (`CFG.nodes`, 90 000), bukan waktu; tabel hash dikosongkan tiap pencarian → dua perangkat memberi rating sama persis (dicek di `an:test`). Kira-kira 0,1–0,4 dtk per langkah di PC (pencarian posisi berikutnya dipanaskan saat senggang, jadi rating langkah biasanya siap dalam ~0,2 dtk). Menaikkan `CFG.nodes` memperdalam analisis tapi memperlambat HP.

---

## 13. Suara Catur (`public/chesssfx.js`)

Efek suara untuk Catur vs AI dan Catur Multiplayer. **Disintesis di browser dengan WebAudio — tanpa file audio, tanpa dependency** (pola sama dengan Word Search). Gagal/diblokir/tanpa `AudioContext` => diam, tidak pernah melempar error.

| Peristiwa | Bunyi | Dipicu di |
|---|---|---|
| Langkah biasa | ketukan kayu | langkah sendiri, langkah lawan, replay maju 1 langkah, telusur riwayat 1 langkah |
| Tangkapan (termasuk en passant) | ketukan lebih berat + ketukan kedua | idem |
| Rokade | dua ketukan | idem |
| Promosi | ketukan + arpeggio naik | idem |
| Skak | ping tinggi | saat kamu diskak (vs AI: `fin.check`; MP: `r.check`) atau lawanmu diskak (respons `move`) |
| Mulai game | dua nada naik | `cstart` (vs AI), join/host-match (MP) |
| Menang / Kalah / Seri | arpeggio naik / tiga nada turun / dua nada | `onGameDone` (MP), `fin.result` & `cresign` (vs AI); tertunda 450 ms agar tidak menimpa bunyi langkah |
| Sting rating | Brilliant = kilau, Blunder = nada turun (rating lain senyap) | saat indikator Live Move Analysis muncul (`chessan.js`) |

- Jenis langkah dihitung dari papan **sebelum** langkah: `CHSFX.kind(papan, dari, ke)`.
- Toggle: tombol speaker di baris aksi game (`data-act="csnd"` di games.js, `data-cm="snd"` di chessmp.js, juga di kontrol Replay). Tersimpan di `localStorage` kunci `chsfx` (`'0'` = mati, default nyala). Menyalakan kembali memainkan satu ketukan contoh (sekaligus membuka AudioContext lewat gestur pengguna, syarat autoplay browser).
- Level tiap bunyi dikalibrasi (`LEVEL` di chesssfx.js) supaya setara (puncak ≈ 0,3–0,45 setelah kompresor); noise ketukan deterministik (bukan `Math.random`) sehingga bunyinya selalu sama.
- Telusur riwayat yang melompat (klik langkah jauh) sengaja **tidak** berbunyi; hanya langkah satu-satu.
