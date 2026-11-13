# Job System (Pekerjaan Part-Time)

## A. Feature Overview

- **Nama fitur**: Pekerjaan part-time — shift pendek yang dibayar Coin, dengan jeda & kuota harian.
- **Tujuan**: faucet Coin harian yang terkontrol + alasan kembali beberapa kali sehari (loop
  engagement yang tidak menekan, terpisah dari minigame yang butuh fokus).
- **Fungsi utama**:
  - 4 pekerjaan dengan ritme berbeda (jeda / bayaran): Barista 20mnt 30-50, Kurir 45mnt 45-75,
    Satpam 90mnt 80-130, Pembersih Aset 180mnt 150-240.
  - Maks **8 shift per hari (WIB, gabungan semua pekerjaan)**; peluang 10% shift bonus digaji 2×.
  - Riwayat 10 shift terakhir (dari riwayat ekonomi kind `job`).
- **Hubungan dengan sistem yang sudah ada**:
  - Backend `lib/jobs.js`; field baru `users.job { day, n, last }` dibuat otomatis — akun lama kompatibel.
  - Pendapatan sebanding klaim harian + misi (pemain paling rajin ±240–480 coin/hari) — tidak
    menyaingi minigame/gacha sebagai sumber utama.
  - Bekerja tercatat di riwayat ekonomi (`job`) dan muncul di Tukar/Toko hist bila UI lama menampilkannya.

## B. UI Requirements

- **Halaman**: sub-tab "Kerja" di tab Dompet (`/wallet`).
- **Komponen**:
  1. **Kartu pekerjaan** (4): nama + ikon + deskripsi singkat + jeda + rentang gaji ("30–50 Coin")
     + status: tombol **Kerjakan** (aktif) ATAU bar countdown ("Siap dalam 12:34") bila `cdLeft > 0`.
  2. **Kartu kuota harian**: progres "Shift hari ini: 3/8" + reset 00.00 WIB; peluang bonus disebut
     ("10% kesempatan gaji dobel").
  3. **Riwayat**: 10 baris terakhir ("Kerja Barista: +42 coin", waktu relatif).
  4. **Panel hasil**: kartu hasil shift (pekerjaan, gaji, penanda bonus 2×) — momen kecil yang menyenangkan.
- **Empty state riwayat**: "Belum ada shift. Mulai dari Barista — paling cepat siap lagi."
- **Loading state**: tombol Kerjakan → teks "Bekerja..." (spinner ±600ms artifisial, hasil server tampil setelahnya).
- **Error state**: pesan server inline; khusus 429 cooldown → tombol berubah countdown otomatis.
- **Success feedback**: panel hasil + koin beranimasi naik + saldo header update; bila `bonus: true`
  → efek teks khusus (mis. percikan/"Shift bonus!") — JANGAN efek suara autoplay.

## C. User Flow

1. Buka sub-tab → `POST /api/auth/jobs` → daftar (siap/jeda), kuota, riwayat.
2. Klik **Kerjakan** pada pekerjaan yang siap → `POST /api/auth/jobs/work { id }`.
3. Hasil: gaji + (mungkin) bonus → panel hasil; kartu pekerjaan itu berubah countdown baru;
   kuota bertambah.
4. Semua kartu jeda / kuota penuh → kartu kuota menampilkan "Balik besok" + jam reset.
5. Kembali kapan saja: hitung countdown dari `cdLeft` respons (tidak perlu polling server).

## D. Backend Integration

### POST `/api/auth/jobs` — daftar + status
Response 200:
```json
{
  "ok": true,
  "jobs": [
    { "id": "barista", "name": "Barista", "icon": "coffee", "cdMin": 20,
      "pay": [30, 50], "desc": "...", "cdLeft": 0 },
    { "id": "kurir", "name": "Kurir", "icon": "box", "cdMin": 45, "pay": [45, 75],
      "desc": "...", "cdLeft": 738000 }
  ],
  "daily": { "used": 3, "max": 8, "bonusChance": 0.1 },
  "coins": 12500,
  "hist": [ { "txt": "Kerja Barista: +42 coin", "coins": 42, "at": "..." } ]
}
```

### POST `/api/auth/jobs/work` — kerjakan satu shift
Body: `{ "id": "barista" }` → Response 200:
```json
{ "ok": true, "job": "barista", "name": "Barista", "pay": 84, "bonus": true,
  "coins": 12584, "daily": { "used": 4, "max": 8 } }
```
Error: `400` id pekerjaan tidak dikenal; `429` "Pekerjaan ini belum siap: tunggu X menit lagi"
atau "Kuota kerja harian habis (8 shift/hari). Balik lagi besok."

## E. UI State Management

- State: `view` (jobs/daily/coins/hist), panel hasil terakhir.
- Countdown client-side per pekerjaan dari `cdLeft` (interval 1 dtk); saat 0 → tombol aktif.
  TANPA polling server — status sebenarnya divalidasi server saat klik (429 dibuka sebagai countdown).
- Setelah `work` sukses: perbarui `coins` (header), `daily.used`, countdown kartu itu (hitung dari
  `cdMin`), dan TAMPILKAN panel hasil. Muat ulang `jobs` saat sub-tab dibuka lagi.
- Riwayat: cukup dari `hist`; muat ulang bersama `jobs`.

## F. Validation (tampilan)

- Tidak ada input bebas — hanya klik pekerjaan.
- Tombol nonaktif bila `cdLeft > 0` atau `daily.used >= daily.max`; server tetap penentu akhir
  (race dua tab → salah satu 429, tampilkan pesannya).
- Rentang gaji & jeda selalu dari respons (bukan hardcode) supaya server bisa menyetel ulang angkanya.

## G. Responsive Design

- **Desktop**: 4 kartu pekerjaan grid 2×2; kuota + riwayat di kolom samping.
- **Mobile**: daftar kartu vertikal (ikon kiri, info + tombol kanan); tombol Kerjakan lebar penuh;
  countdown mono-spaced besar.
- Aksesibilitas: countdown juga berupa teks ("Siap dalam 12 menit"), bukan hanya bar.

## H. Acceptance Criteria

1. Kerjakan shift → gaji dalam rentang `pay` (atau 2× bila `bonus: true`), coin bertambah pas.
2. Shift kedua pekerjaan yang sama langsung → tombol menampilkan countdown (429 ditangani).
3. Pekerjaan lain yang siap tetap bisa dikerjakan (jeda per pekerjaan, kuota gabungan).
4. Setelah 8 shift → semua tombol nonaktif + pesan "Balik besok" (429 kuota).
5. Riwayat shift tampil (teks + coin + waktu) bertambah setelah bekerja.
6. Semua rentang gaji/jeda/kuota ditampilkan dari respons — tidak ada angka hardcode.
7. Id pekerjaan tidak dikenal ditolak dengan pesan (uji lewat konsol: `{ id: 'presiden' }` → 400).
