# Leveling System (Level Akun & XP)

## A. Feature Overview

- **Nama fitur**: Level Akun — XP dan level untuk PEMAIN (user yang login), bukan level hubungan
  karakter (yang itu sistem relasi yang sudah ada, "tahap Sahabat/Pasangan" — jangan tertukar).
- **Tujuan**: memberi alasan betah: progres terlihat (bar XP + badge level), reward naik seiring
  level (pengali hadiah minigame), dan piala/leaderboard baru.
- **Sumber XP** (semua dihitung SERVER, client tidak pernah mengirim jumlah XP):
  | Sumber | XP | Batas/hari (reset 00.00 WIB) |
  |---|---|---|
  | `gc` — pesan Chat Global terkirim | +5 | 150 XP (30 pesan) |
  | `time` — lama main di web (heartbeat `/api/online`) | +1 tiap ≥ 4 menit aktif | 120 XP (±8 jam) |
  | `win` — menang minigame | +15 | 150 XP (10 kemenangan) |
  | `ext` — bonus dari luar web (event/giveaway, lewat API admin) | bebas | tanpa batas |
- **Kurva level**: XP untuk naik dari level L ke L+1 = `80 + 40 × (L-1)` (total: L2=80, L5=560,
  L10=2.160, L25=12.960, L50=50.960, L100=201.960; level mentok di 100, XP tetap terkumpul).
- **Hadiah naik level** (dikirim server otomatis ke saldo): `30 + 5 × level baru` coin, plus
  `+5 gems` di setiap kelipatan 5 (5, 10, 15, ...).
- **Pengali hadiah minigame** (makin tinggi level, makin besar reward): `mul = 1 + 0,02 × (level - 1)`,
  mentok `2,5×` (L10 = 1,18×, L25 = 1,48×, L50 = 1,98×). Berlaku untuk Tebak Angka, Tebak Gambar,
  2048, Word Search, dan Catur (menang & seri). **Tidak** berlaku untuk Fruit Slot & gacha (bet
  berbasis RTP — sengaja tidak dikalikan). Batas coin harian tiap game TETAP absolut (tidak ikut
  dikalikan), jadi pengali hanya memperbesar tiap hadiah, bukan batas hariannya.
- **Hubungan dengan sistem yang sudah ada**:
  - Backend `lib/leveling.js` (+ `lib/xpext.js`); uji: `npm run level:e2e` (25 asersi).
  - Piala baru di profil: `alv10` / `alv25` / `alv50` (Level 10/25/50 akun) — otomatis muncul di
    daftar piala `/api/auth/quests`, tanpa UI baru.
  - Leaderboard baru: kategori **Lainnya → Level Akun** di `/api/auth/lb` — otomatis muncul di
    tab Peringkat yang sekarang (cfg-nya dinamis); TIDAK perlu kerja UI tambahan.
  - Notifikasi tipe baru `level` di Pusat Notifikasi (`/api/auth/notify`).
  - Badge level siap pakai: `/api/auth/me` sekarang mengembalikan `level`.

## B. UI Requirements

- **Lokasi yang disarankan** (pilih satu, konsisten):
  1. **Badge level di header** — angka kecil (lingkaran/pill) di samping nama user, sumber:
     `level` dari `/api/auth/me` (sudah ada di state login — tidak perlu request baru). Untuk
     tamu (belum login): badge disembunyikan.
  2. **Panel "Level Akun"** — sub-tab baru di halaman Profil (`/profile`) atau kartu di atas
     daftar piala. Semua data dari SATU endpoint: `POST /api/auth/level`.
- **Komponen panel Level Akun**:
  1. **Kartu level**: angka level besar + bar progres XP (`cur / need`), label "MAX" bila
     `maxed: true` (bar penuh, tanpa persen). Sub-teks: total XP (`xp`) dan sisa XP ke level
     berikutnya (`need - cur`).
  2. **Kartu pengali hadiah**: "Hadiah minigame ×`mul.now`" → "×`mul.next`" di level berikutnya
     (kecil: "maks ×`mul.cap`"). Ini menjelaskan KENAPA level penting.
  3. **Kartu XP harian**: satu baris per sumber `daily` — `gc`, `time`, `win`, `ext`:
     bar progres `xp / cap` + "reset 00.00 WIB" (hitung mundur dari `daily.resetMs`).
     `ext.cap` = `null` → tampilkan "tanpa batas".
  4. **Rincian sumber seumur hidup** (`sources`): 4 baris kecil "Pesan Chat Global — 245 XP" dst.
  5. **Riwayat XP** (`hist`, 15 terbaru): "+5 gc — 2 mnt lalu", "+15 win", catatan `note` bila ada
     (mis. "Event Jumat"), waktu relatif.
  6. **Papan 10 level tertinggi** (`top`): mirip leaderboard mini — nama, avatar, level;
     baris sendiri ditandai `me: true`. Di bawahnya "Peringkatmu: #`rank.at`".
- **Toast level-up**: kalau respons berisi `lv.levelUp` atau `nq` dengan teks "Naik ke Level ..."
  → toast/perayaan singkat (bisa animasi confetti ringan, JANGAN suara autoplay). Tempat
  respons-nya bermunculan: kirim pesan Chat Global (`lv`), heartbeat online (`lv`), dan semua
  respons menang minigame (`nq`).
- **Chip pengali di layar minigame**: tampilkan "Hadiah ×`mul`" (dari respons `view` tiap game)
  dekat info hadiah — supaya pemain tahu angkanya sudah dikalikan level.
- **Empty state**: akun baru → level 1, bar 0/80, riwayat kosong ("Belum ada XP — kirim pesan di
  Chat Global atau menangi minigame"), top list tetap ditampilkan.
- **Loading state**: skeleton panel; badge header langsung dari cache `me`.
- **Error state**: 401 → minta login (level hanya untuk akun); 429 → tampilkan pesannya, matikan
  tombol refresh ±10 detik.

## C. User Flow

1. Login → `me` mengembalikan `level` → badge header tampil.
2. Buka panel Level Akun → `POST /api/auth/level` → semua kartu terisi dari respons.
3. Main seperti biasa (chat global, main game) → sesekali respons membawa `lv`/`nq` level-up →
   toast; panel menyimpan data lama sampai dibuka lagi (tidak ada polling).
4. Buka tab Peringkat → pilih Lainnya → Level Akun (tanpa kerja ekstra, sudah jalan).
5. Naik level → saldo coin/gems naik otomatis (server) → catatan juga masuk Pusat Notifikasi
   (ikon bel, tipe `level`).

## D. Backend Integration

### POST `/api/auth/level` — profil level lengkap
Body: `{}`. Response 200:
```json
{
  "ok": true,
  "level": 4, "xp": 500, "max": 100, "maxed": false,
  "cur": 140, "need": 200, "nextAt": 560,
  "mul": { "now": 1.06, "next": 1.08, "cap": 2.5, "step": 0.02 },
  "daily": {
    "gc":   { "xp": 45,  "cap": 150, "per": 5 },
    "time": { "xp": 12,  "cap": 120, "per": 1, "perMin": 4 },
    "win":  { "xp": 15,  "cap": 150, "per": 15 },
    "ext":  { "xp": 0,   "cap": null },
    "resetMs": 43200000
  },
  "sources": {
    "gc":   { "title": "Pesan Chat Global", "xp": 245 },
    "time": { "title": "Lama main di web",  "xp": 60 },
    "win":  { "title": "Menang minigame",   "xp": 225 },
    "ext":  { "title": "Bonus eksternal",   "xp": 100 }
  },
  "hist": [ { "src": "win", "amt": 15, "xp": 500, "lvl": 4, "at": "..." },
            { "src": "ext", "amt": 500, "xp": 500, "lvl": 4, "note": "Event Jumat", "at": "..." } ],
  "top": [ { "name": "Nanda", "avatar": "...", "level": 12, "me": false } ],
  "rank": { "level": 4, "at": 3 },
  "coins": 825, "gems": 20
}
```
Error: `401` sesi berakhir; `429` terlalu sering (maks 60/menit).

### Field baru di endpoint LAMA (semua kompatibel mundur — client lama abaikan saja)

| Endpoint | Field | Isi |
|---|---|---|
| `POST /api/auth/me` | `level` | level akun sekarang (badge header) |
| `POST /api/gc/send` | `lv?` | `{ level, xp, levelUp: { from, to, reward: { c, g } } \| null }` — HANYA muncul kalau pesan itu menambah XP |
| `POST /api/online` | `lv?` | sama seperti di atas, dari XP waktu-main (heartbeat 60 dtk; `lv` muncul paling sering tiap 4 menit) |
| `POST /api/auth/game\|g2048\|ws\|pic\|chess` (+ `/start`, `/move`, `/guess`, `/select`) | `mul` | pengali hadiah level akun, sudah dipakai server pada `reward`/`gain`/`prize` di respons yang sama |
| `nq` di respons game | — | bisa berisi teks `"Naik ke Level X! (+Y coin, +Z gems)"` di samping misi/piala — tampilkan seperti `nq` biasa |
| `POST /api/auth/notify` | `type: "level"` | item baru berbentuk sama dengan tipe lain; `m.lvl` = level baru (meta opsional) |
| `POST /api/auth/lb` | cfg | kategori `other` punya sub baru `level` (metric `lvl`, unit `level`) — tidak perlu perubahan UI |
| `POST /api/auth/quests` | `ach` | tiga piala baru `alv10`/`alv25`/`alv50` (`k: "acctLv"`) — tampil otomatis di daftar piala |

### Catatan penting untuk UI

- **Jangan hitung XP sendiri**: semua angka (XP, cap, pengali, hadiah level-up) selalu ambil dari
  respons. Cap/pengali bisa diatur ulang server lewat env tanpa deploy frontend.
- `reward`/`gain` di respons game SUDAH dikalikan `mul` (dibulatkan ke bawah oleh server) —
  jangan kalikan lagi di client.
- XP `time` hanya muncul untuk yang login; tamu tetap dihitung "online" tanpa XP.
- Slot & gacha memang tanpa pengali — jangan tampilkan chip `mul` di layar itu.
- API eksternal `/api/xp/grant|lookup` pakai API key rahasia server (`env LEVEL_EXT_KEY`) —
  BUKAN untuk frontend. Hadiah `ext` terlihat pemain lewat `hist.note` + notifikasi biasa.

## E. UI State Management

- State panel: satu objek dari respons `/api/auth/level`; refresh setiap kali panel dibuka
  (pola yang sama dengan sub-tab lain) — TIDAK perlu polling; level-up diketahui lewat `lv`/`nq`
  di respons aksi (toast), lalu panel menyegarkan saat dibuka lagi.
- Badge header: dari `me.level` saat login/muat; kalau toast level-up muncul, naikkan angka badge
  +1 secara lokal (server tetap sumber kebenaran saat reload).
- Hitung mundur reset harian dari `daily.resetMs` (ms menuju 00.00 WIB) — interval 1 dtk,
  dihitung dari waktu respons diterima.
- Waktu relatif `hist.at` / `notif.at` pakai helper yang sudah ada di layar lain ("2 mnt lalu").
- Setelah `nq` berisi level-up: refresh saldo coin/gems header dari field `coins`/`gems` respons
  game (sudah dikembalikan terbaru) — jangan request `me` tambahan.

## F. Validation (tampilan)

- Tidak ada input bebas di panel ini — semua tampilan read-only.
- Bar XP: `cur / need` (0–100%); saat `maxed` → bar penuh + label "MAX" (jangan tampilkan %).
- Bar harian `ext` tanpa cap: tampilkan jumlahnya saja tanpa bar ("Tanpa batas").
- Angka XP format Indonesia (2.160), pengali dua desimal (×1,18 — koma desimal, sesuai locale).
- 429 pada `/api/auth/level`: pesan inline + tombol refresh nonaktif 10 dtk.

## G. Responsive Design

- **Desktop**: panel Level Akun dua kolom (kartu level+pengali kiri; XP harian & riwayat kanan),
  top-10 di bawah lebar penuh.
- **Mobile**: satu kolom vertikal; badge header kecil (min 20×20 px, angka tetap terbaca);
  bar harian memakai lebar penuh kartu; tabel riwayat → daftar baris (ikon sumber + XP + waktu).
- Aksesibilitas: bar XP punya teks ("140/200 XP"), bukan warna saja; level-up toast juga teks,
  bukan hanya animasi.

## H. Acceptance Criteria

1. Login → badge level muncul di header dengan angka dari `me.level`; tamu tidak punya badge.
2. Buka panel Level → level, bar XP (`cur/need`), pengali (`mul.now`), 4 kartu XP harian, riwayat
   15 entri, top-10, dan peringkat sendiri tampil — semua nilainya dari respons (uji: ubah tidak
   mungkin di client, tidak ada angka hardcode).
3. Kirim 1 pesan Chat Global (login) → respons `/api/gc/send` kadang membawa `lv`; saat `lv.levelUp`
   ada → toast "Naik ke Level X!" + badge header naik + saldo header update.
4. Menang Tebak Angka dengan level ≥ 2 → `reward` > hadiah dasar (mis. level 4: 200 → 212) dan
   chip "×1,06" tampil di layar game; `nq` bisa berisi catatan level-up.
5. `maxed: true` (level 100) → bar penuh + label MAX, tanpa persentase.
6. Cap harian: kirim >30 pesan global dalam sehari → kartu harian `gc` menunjukkan "150/150"
   dan pesan berikutnya tidak membawa `lv` (XP berhenti, chat tetap jalan normal).
7. Tab Peringkat → Lainnya → Level Akun menampilkan daftar (tanpa perubahan kode UI Peringkat).
8. Halaman piala (Profil) menampilkan 3 piala baru `alv10`/`alv25`/`alv50` dengan progres dari `v`.
9. Ikon bel: ada item tipe `level` "Naik ke Level X!" setelah naik level.
10. 401 → arahkan ke login; 429 → pesan + tombol refresh mati 10 dtk.
