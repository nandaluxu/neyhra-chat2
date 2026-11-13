# Notification Center (Pusat Notifikasi)

## A. Feature Overview

- **Nama fitur**: Pusat Notifikasi (bel di header aplikasi).
- **Tujuan**: satu tempat untuk semua kejadian yang menimpa pemain saat dia tidak sedang berada di
  layar terkait — transfer masuk/keluar, penawaran trade, hasil jual-beli market, menjadi target
  pencurian, bunga bank, misi selesai, piala baru.
- **Fungsi utama**:
  - Daftar notifikasi terbaru (halaman 30 item, kursor `before`).
  - Penanda belum-baca (badge angka di ikon bel).
  - Tandai satu / semua sudah dibaca.
  - Notifikasi misi harian & piala yang sebelumnya hanya muncul sekilas (`nq` di respons chat/claim/gift)
    kini juga tersimpan di sini.
- **Hubungan dengan sistem yang sudah ada**:
  - Backend: `lib/notify.js`, koleksi MongoDB `notif` (TTL 90 hari), dipasang di router auth.
  - Sumber `nq` lama TIDAK berubah — `track()` di `lib/quests.js` sekarang MENYALIN catatan misi/piala
    ke koleksi `notif` (best-effort) sehingga muncul di bel. Toast inline lama tetap boleh dipakai.
  - Dipakai oleh: transfer, trade, market, robbery, bank (semua sudah menulis notifikasi).

## B. UI Requirements

- **Komponen**:
  1. **Ikon bel** (`id="nbell"`) di header shell (dekat indikator "N online"), dengan badge merah
     angka belum-baca (disembunyikan kalau 0; maks tampil `9+`).
  2. **Panel/dropdown notifikasi** — lebar ±360px di desktop, sheet penuh dari bawah di mobile;
     tinggi maks 70vh, isi scrollable.
  3. **Baris notifikasi**: ikon per tipe + teks `txt` + waktu relatif ("baru saja", "5 mnt", "2 jam",
     "Kemarin") + titik penanda belum-baca. Klik baris = tandai terbaca (+ buka layar terkait bila ada).
  4. **Tombol "Tandai semua dibaca"** di header panel.
  5. **Loader "Muat lebih banyak"** di akhir daftar bila `more === true`.
- **Ikon per `type`** (usulan): `quest` papan misi, `ach` trofi, `transfer-in` panah masuk + koin,
  `transfer-out` panah keluar, `trade` dua panah bertukar, `trade-done` tanda centang ganda,
  `market` etalase/keranjang, `rob` topeng pencuri, `bank` lemari besi, `sys` info.
- **Empty state**: "Belum ada notifikasi. Ngobrol, klaim bonus, atau transfer sesuatu — kejadiannya muncul di sini."
- **Loading state**: skeleton 5 baris saat panel dibuka pertama kali (data belum ada di cache).
- **Error state**: baris tunggal "Notifikasi gagal dimuat" + tombol "Coba lagi" (panggil ulang endpoint list).
- **Success feedback**: badge mengecil secara animasi saat `unread` turun; tidak perlu toast.

## C. User Flow

1. User membuka aplikasi (login atau sudah punya sesi) → bel polling pertama → badge muncul jika ada belum-baca.
2. User klik bel → panel terbuka → daftar `items` terbaru dulu (belum-baca ditandai).
3. User klik satu baris → `notify/seen { id }` → titik hilang, badge berkurang, dan bila `type`
   punya layar tujuan (mis. `transfer-in` → sub-tab Transfer) panel tertutup dan layar itu dibuka.
4. User klik "Tandai semua" → `notify/seen { all: true }` → badge kosong.
5. User scroll sampai bawah → bila `more`, kirim `notify { before: next }` → tambahkan item berikutnya.
6. Polling: ulangi `notify` (tanpa `before`) tiap ±60 detik saat tab terlihat (pola yang sama dengan
   heartbeat `/api/online`), dan segera setelah aksi ekonomi apa pun sukses (transfer/trade/market/rob/kerja).

## D. Backend Integration

Semua POST + token Bearer. Tidak ada parameter rahasia; `rates` tidak ada di sini.

### POST `/api/auth/notify` — daftar + jumlah belum-baca
Body: `{ "before": 1730000000000 }` (`before` opsional = nilai `next` halaman sebelumnya; tanpa itu = halaman pertama).
Response 200:
```json
{
  "ok": true,
  "items": [
    { "id": "<uid>:<rand>", "type": "transfer-in", "txt": "alfa mengirim transfer 950 Coin",
      "at": "2026-11-12T10:00:00.000Z", "seen": false, "m": { "u": "alfa" } }
  ],
  "more": true, "next": 1730000000000, "unread": 4
}
```
- `m.u` (bila ada) = nama tampilan lawan pihak — bisa dipakai tombol buka profil/layar.
- Error: `401` sesi berakhir; `429` terlalu sering (jeda 60 dtk per pemain dibatasi 60/menit).

### POST `/api/auth/notify/seen` — tandai dibaca
Body: `{ "id": "<id item>" }` ATAU `{ "all": true }`.
Response 200: `{ "ok": true, "unread": 0 }`.
Error: `400` id tidak dikenal (id harus milik akun sendiri — server cek prefiks `<uid>:`);
`401`; `429`.

## E. UI State Management

- Cache state: `{ items: [], unread: 0, next: 0, more: false, loadedAt: 0 }` di memori modul
  (bukan localStorage — riwayat 90 hari cukup panjang, segarkan dari server).
- Kapan refresh: (1) polling 60 dtk saat tab terlihat, (2) setelah SEMUA aksi ekonomi sukses
  (respons aksi tidak mengembalikan notifikasi — polling singkat 1-2 dtk setelahnya juga boleh),
  (3) saat panel dibuka jika cache > 30 dtk.
- Tandai-dibaca optimis: hilangkan titik lokal dulu, lalu kirim request; gagal → kembalikan titik.
- Item lama harus TIDAK di-cache permanen: bila panel ditutup > 1 jam, muat ulang halaman pertama.

## F. Validation (tampilan)

- Tidak ada input user kecuali klik; tidak ada validasi client yang wajib.
- Waktu relatif: hitung dari `at` (ISO string) vs waktu browser.
- Badge: `unread` langsung dari server; jangan dihitung dari cache sendiri.

## G. Responsive Design

- **Desktop**: panel dropdown menempel di bawah ikon bel (posisi absolut, maks lebar 360px,
  tinggi 70vh). Klik luar menutup (backdrop transparan).
- **Mobile**: panel menjadi bottom-sheet penuh (border-radius atas, tinggi 80vh, handle geser).
  Bel tetap terlihat di header yang sudah ada.
- Baris: ikon 40px + teks 2 baris maks (ellipsis), tinggi baris ±64px, area sentuh minimal 48px.

## H. Acceptance Criteria

1. Bel muncul di semua layar (bukan hanya di tab tertentu) dan badge menunjukkan `unread` server.
2. Membuka panel memuat maksimal 30 item terbaru, urut dari yang paling baru.
3. Klik satu baris menandai item itu terbaca (`seen` → true, badge berkurang tepat 1).
4. "Tandai semua" mengosongkan badge (`unread` = 0 dari respons server).
5. `more === true` menampilkan loader; klik/scroll memuat halaman berikutnya tanpa menduplikasi item.
6. Notifikasi dari minimal 4 sumber nyata terlihat setelah skenario uji: transfer (transfer-in),
   klaim/piala (quest/ach), pembelian market (market), bunga bank (bank).
7. Tanpa login: bel disembunyikan (semua endpoint 401).
8. Id tidak valid pada seen → 409/400 ditangani tanpa merusak state panel.
