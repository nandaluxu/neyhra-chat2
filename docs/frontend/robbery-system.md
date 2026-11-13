# Robbery System (Sistem Pencurian Antara-Player)

## A. Feature Overview

- **Nama fitur**: Pencurian (robbery) — mencoba mencuri Coin dompet pemain lain, dengan risiko nyata.
- **Tujuan**: gameplay sosial berisiko-reward yang membuat coin punya "rasa" (ada alasan setor bank,
  beli perisai, dan memperhatikan wanted), tanpa bisa menghancurkan pemain baru.
- **Fungsi utama**:
  - Mencoba mencuri dari pemain lain (peluang dasar 35%, +5% per poin wanted target, maks 80%).
  - Curian berhasil: 5–15% dompet korban (plafon 5.000) pindah ke pencuri; wanted pencuri +1.
  - Gagal: pencuri **membayar ganti rugi ke korban** (½ nilai incian, 25–500) dan wanted +2.
  - Perisai (beli dengan **Gems** — sink premium): blokir semua percobaan 24 jam (bisa ditumpuk);
    pencuri yang menabrak perisai tetap bayar ganti rugi.
  - Wanted (buronan): meluruh 1 poin tiap 6 jam; wanted tinggi = kamu lebih mudah dijarah orang.
  - Cooldown 30 menit antar percobaan; maksimal 5 percobaan/hari (WIB).
  - Statistik seumur hidup + riwayat 15 kejadian terakhir (sebagai pencuri DAN korban).
- **Hubungan dengan sistem yang sudah ada**:
  - Backend `lib/robbery.js`; field baru `users.rob {...}` + koleksi `rob_log` (TTL 180 hari).
  - **Bank (`lib/bank.js`) adalah perlindungan pasif**: hanya `coins` (dompet) yang bisa dicuri.
  - Semua kejadian pencurian juga masuk riwayat ekonomi kedua pihak (kind `rob-win/rob-gain/rob-fine/rob-back/rob-lost`)
    dan pusat notifikasi.
  - Perlindungan pemain baru: target sah minimal dompet 500 coin (akun baru bermodal 150 aman);
    pencuri juga wajib bawa dompet ≥ 200 (jaga modal ganti rugi).

## B. UI Requirements

- **Halaman**: sub-tab "Pencurian" di tab Dompet (`/wallet`).
- **Komponen**:
  1. **Kartu status pencuri**: dompet sendiri (modal), cooldown ("Siap mencuri" / "Tunggu X mnt Y dtk",
     hitung mundur dari `cd.leftMs`), kuota hari ini (`daily.used/5`), wanted meter (0–10) +
     "peluang kamu dijarah: Z%" (`stats.chanceOfMe`).
  2. **Form target**: input username (autocomplete) + tombol **Incari!**. Tombol aktif hanya bila
     cooldown habis, kuota tersisa, dan dompet ≥ `rates.stake` (200).
  3. **Panel perisai**: status ("Perisai aktif s/d <waktu>" / "Tanpa perisai"), tombol **Beli Perisai
     24 jam — 5 Gems** (menumpuk: 24 jam ditambah dari waktu aktif terjauh).
  4. **Statistik karier**: berhasil/gagal, total curian (`got`), total ganti rugi dibayar (`fine`),
     total dijarah (`lost`), total ganti rugi diterima (`back`).
  5. **Riwayat** (`hist`): 15 kejadian — kolom peran (PENCURI/KORBAN), lawan (`other`), hasil
     (`win`/`fail`/`shield`), nilai `amt`/`fine`, waktu relatif.
  6. **Hasil percobaan**: panel hasil besar (animasi sesuai `out`):
     - `win`: "Berhasil! Kamu mencuri X Coin dari <nama>" (animasi dompet terbuka).
     - `fail`: "Ketaguan! Kamu membayar ganti rugi X ke <nama>".
     - `shield`: "Perisai <nama> menggagalkanmu — kamu bayar ganti rugi X".
     Tampilkan juga perubahan wanted.
- **Empty state riwayat**: "Belum ada kejadian. Semua orang mulai dari bersih... untuk saat ini."
- **Loading state**: tombol Incari → "Menyusup..." (spinner ±700ms artifisial untuk ketegangan,
  hasil server baru ditampilkan setelahnya).
- **Error state**: pesan server inline; khusus 429 cooldown → tampilkan tombol dengan countdown aktif.
- **Success/Outcome feedback**: panel hasil + badge notifikasi; saldo header refresh dari `coins` respons.

## C. User Flow

1. Buka sub-tab → `POST /api/auth/rob` (stats, cooldown, wanted terluruhan otomatis, perisai, riwayat).
2. (Opsional) beli perisai → `POST /api/auth/rob/shield` → status perisai baru + gems berkurang.
3. Ketik username target → tombol Incari aktif → klik → `POST /api/auth/rob/attempt { username }`.
4. Animasi hasil → panel hasil + angka (`stolen`/`fine`, `wanted`) → riwayat & stats dimuat ulang.
5. Jadi korban (kejadian dari pemain lain): notifikasi `rob` masuk di bel; klik notifikasi membuka
   sub-tab Pencurian; user bisa membalas dengan mencuri `m.u` (nama penyerang) bila memenuhi syarat.

## D. Backend Integration

### POST `/api/auth/rob` — ringkasan
Response 200:
```json
{
  "ok": true, "me": "Alfa",
  "stats": { "win": 3, "fail": 2, "got": 1240, "fine": 150, "lost": 300, "back": 75,
             "wanted": 1, "wantedMax": 10, "chanceOfMe": 0.4 },
  "cd": { "leftMs": 0, "min": 30 },
  "daily": { "used": 2, "max": 5 },
  "shield": { "until": 0, "gems": 5, "hours": 24 },
  "rates": { "baseChance": 0.35, "pocketMin": 500, "stake": 200, "stealPct": [0.05, 0.15],
             "maxStolen": 5000, "cdMin": 30, "dailyMax": 5, "wantedMax": 10, "wantedDecayH": 6,
             "wantedPerWin": 1, "wantedPerFail": 2, "shieldGems": 5, "shieldHours": 24,
             "chanceAt0": 0.35 },
  "hist": [ { "at": "...", "out": "win", "amt": 120, "fine": 0, "role": "atk", "other": "Bravo" } ]
}
```

### POST `/api/auth/rob/attempt` — mencoba mencuri
Body: `{ "username": "bravo" }` → Response 200 (bentuk menurut `out`):
```json
{ "ok": true, "out": "win",  "stolen": 420, "coins": 12920, "wanted": 2 }
{ "ok": true, "out": "fail", "fine": 210, "attempted": 420, "coins": 12050, "wanted": 3 }
{ "ok": true, "out": "shield", "fine": 105, "attempted": 210, "coins": 11980, "wanted": 3 }
```
Error: `400` target kosong / diri sendiri / dompet target < 500 / dompet pencuri < 200;
`403` akun pencuri belum berumur; `404` target tak dikenal;
`429` cooldown ("Tunggu X menit lagi") atau kuota harian.

### POST `/api/auth/rob/shield` — beli perisai
Body: `{}` → Response 200: `{ "ok": true, "shieldUntil": 1731380000000, "gems": 15 }`.
Error: `409` "Butuh 5 Gems untuk perisai." (+ `gems` saldo sekarang); `429` (maks 10 pembelian/jam).

## E. UI State Management

- State: `view` (dari `rob`), hasil percobaan terakhir, countdown timer.
- Countdown: dari `cd.leftMs` → interval 1 dtk; saat mencapai 0 → tombol Incari aktif (tanpa polling).
- Refresh `view` setelah: attempt (sebagian field terbaru ada di respons attempt, tapi stats/hist
  hanya di `rob` → panggil ulang), pembelian perisai, notifikasi `rob` masuk saat layar terbuka.
- `wanted` meter & `chanceOfMe` harus selalu dari `stats` terbaru.

## F. Validation (tampilan)

- Username target: pola `^[a-z0-9_.-]{3,20}$`.
- Sebelum kirim: cooldown 0, `daily.used < daily.max`, dompet ≥ `rates.stake`.
- Pesan server untuk target terlalu tipis ("Dompet <nama> terlalu tipis untuk diincar") ditampilkan
  apa adanya — jangan divalidasi lokal (saldo orang lain tidak diketahui client).
- Perisai: tampilkan harga `shield.gems` & sisa waktu; tombol nonaktif bila gems kurang.

## G. Responsive Design

- **Desktop**: kartu status & form di kiri, statistik + riwayat di kanan (2 kolom).
- **Mobile**: satu kolom; meter wanted jadi bar horizontal tipis; hasil percobaan jadi kartu
  full-width dengan animasi kecil (jangan autoplay suara — cukup getar halus bila didukung).
- Riwayat: tabel → di mobile jadi daftar kartu 2 baris.
- Aksesibilitas: hasil `out` juga ditulis sebagai teks, bukan hanya warna/ikon.

## H. Acceptance Criteria

1. Percobaan sah selalu menghasilkan panel hasil (`win`/`fail`/`shield`) dengan angka dari server.
2. Percobaan kedua dalam < 30 menit → tombol menampilkan countdown aktif (429 ditangani).
3. Perisai: dibeli dengan gems, menumpuk durasi, dan percobaan ke pemain bers perisai menghasilkan `shield`.
4. Wanted: naik saat mencuri, turun otomatis di tampilan setelah 6 jam/poin (tanpa reload berjam-jam).
5. Korban selalu menerima notifikasi `rob` (ketiga hasil) dan statistik `lost`/`back`-nya tercatat.
6. Coin TOTAL kedua pihak tidak pernah berubah akibat pencurian (hanya berpindah + wanted/riwayat).
7. Pemain baru (dompet < 500) tidak bisa diincar; pencuri bokek (< 200) tidak bisa mencuri — pesan server ditampilkan.
8. Semua angka (peluang, plafon, cooldown, harga perisai) ditampilkan dari `rates`/`shield` respons.
