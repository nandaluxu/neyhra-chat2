# Dokumentasi Frontend — Ekonomi Antar-Player (Fase Backend Selesai)

Dokumen ini adalah spesifikasi implementasi UI untuk fitur backend yang **sudah jadi dan teruji**
(`scripts/p2p-e2e.mjs`, 161 asersi lulus). Setiap file mendokumentasikan SATU fitur + SATU UI.
Semua endpoint berupa POST dengan token Bearer (sama seperti API auth lain di aplikasi ini),
dan SEMUA angka (fee, batas, peluang) diputuskan server — client hanya menampilkan.

## Daftar dokumentasi & urutan pengerjaan yang disarankan

| # | File | Fitur | Dependen UI | Prioritas |
|---|------|-------|-------------|-----------|
| 1 | [notification-center.md](./notification-center.md) | Pusat notifikasi (bel) | — | WAJIB PERTAMA |
| 2 | [player-transfer.md](./player-transfer.md) | Transfer coin & barang | notification-center | Tinggi |
| 3 | [bank-system.md](./bank-system.md) | Bank (simpanan aman) | — | Tinggi |
| 4 | [robbery-system.md](./robbery-system.md) | Pencurian + perisai | bank (komunikasi "bank aman") | Tinggi |
| 5 | [player-trading.md](./player-trading.md) | Trading dua pihak | notification-center | Tinggi |
| 6 | [marketplace.md](./marketplace.md) | Marketplace | notification-center | Tinggi |
| 7 | [job-system.md](./job-system.md) | Pekerjaan part-time | — | Sedang |

Urutan itu disarankan karena notifikasi adalah komponen yang dipakai semua fitur lain (umpan balik
aksi), dan transfer/bank menjadi pintu masuk paling sederhana sebelum UI sosial yang lebih kompleks.

## Arsitektur UI yang disarankan

### Tab baru "Dompet" (`/wallet`)

Semua fitur ini kecuali notifikasi sebaiknya berada di SATU tab baru **Dompet** di menu samping
(sejajar Toko/Bonus/Peringkat), dengan sub-navigasi horizontal ala `#shnav` di Toko:

```
Dompet (sub-tab): Transfer | Bank | Pencurian | Perdagangan | Market | Kerja
```

Pengerjaan yang harus dilakukan di file yang sudah ada (pola sama seperti saat tab Musik/Peringkat ditambahkan):

1. `public/index.html` — tombol nav baru `id="rwallet" data-tab="wallet"` (ikon dompet/koin),
   tombol bel notifikasi di header (`id="nbell"`), dan section `<main id="wallet">` dengan sub-nav `#wtnav`.
2. `public/shell.js` — `setTab` mengenali `'wallet'` (pola `music`/`leaderboard`).
3. `public/router.js` — `curPath()` mengembalikan `'/wallet'` untuk `app.dataset.tab === 'wallet'`;
   `apply()` membuka tab wallet.
4. `lib/app.js` — tambah `'/wallet'` ke daftar rute yang menjawab `index.html` (baris `app.get(['/chat', ...])`).
5. `vercel.json` — tambah rewrite `{ "source": "/wallet", "destination": "/index.html" }`.
6. File baru `public/wallet.js` (+ `wallet.css` kalau perlu) — semua layar sub-tab di atas,
   dimuat dari `index.html` seperti file layar lain (`<script type="module" src="/wallet.js">`).

### Titik integrasi lintas fitur

- **Header saldo** (`coins`) wajib direfresh setelah aksi apa pun yang mengubah coin
  (transfer, bank, robbery, trade, market, kerja). Respons semua endpoint selalu mengembalikan
  `coins` terbaru — pakai itu, jangan kirim request `me` tambahan.
- **Profil pemain lain** (layar Profil → lihat user lain): tombol aksi "Transfer" dan "Ajak Trade"
  langsung membuka sub-tab Dompet dengan username terisi (lihat dokumen masing-masing).
- **Bel notifikasi** muncul di semua layar (komponen shell), bukan hanya di tab Dompet.
- Notifikasi tipe `rob` pada profil korban memuat meta `m.u` (nama penyerang) — bisa dipakai
  tombol "Balas menyerang?" ke layar pencurian dengan username penyerang.

## Konvensi wajib (berlaku untuk semua dokumen di folder ini)

- **Token Bearer** dari sesi login yang sudah ada (`Authorization: Bearer <token>`).
- **Idempotency**: setiap aksi yang mengubah saldo/barang mengirim `idem` (UUID baru per konfirmasi).
  Kalau respons 409 "sudah diproses", tunjukkan pesan itu — JANGAN otomatis ulangi.
- **Angka dari server**: fee, batas harian, cooldown, peluang — selalu tampilkan dari field
  `rates`/`daily`/`cd`/`shield` respons, jangan hardcode.
- **Semua aksi pakai POST** (konsisten dengan API lain aplikasi ini).
- Semua endpoint membalik `error` berupa string bahasa Indonesia siap tampil.
- Waktu `at`/`createdAt` berupa ISO string; cooldown dalam milidetik (`leftMs`/`cdLeft`).
- Batas umum pembatas laju: bila respons 429, tampilkan pesan error-nya dan NONAKTIFKAN tombol
  selama ±10 detik (tidak ada header Retry-After — semua batas ada di body).

## Diharapkan tidak berubah

- Tidak ada perubahan skema backend yang dibutuhkan frontend — semua koleksi/index/rule sudah jadi.
- Semua fitur berjalan tanpa Redis (hanya MongoDB).
- Data pengguna lama kompatibel: field baru (`bank`, `job`, `rob`, koleksi `notif`/`trades`/`market`/
  `rob_log`) dibuat otomatis saat pertama dipakai.
