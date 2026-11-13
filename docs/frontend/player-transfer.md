# Player Transfer (Transfer Coin & Barang Antar-Player)

## A. Feature Overview

- **Nama fitur**: Transfer — kirim Coin dan/atau barang inventaris ke pemain lain, langsung sampai.
- **Tujuan**: berbagi kekayaan antar teman, hadiah antar pemain, dan pondasi ekonomi sosial
  (sebelum trading/marketplace yang butuh persetujuan dua pihak).
- **Fungsi utama**:
  - Kirim coin (fee 5% dibuang sebagai sink ekonomi; penerima menerima bersih).
  - Kirim barang inventaris (barang toko + cincin gacha).
  - Riwayat masuk/keluar lewat `econ_log` (tab Tukar) + notifikasi kedua pihak.
- **Hubungan dengan sistem yang sudah ada**:
  - Backend `lib/transfer.js`. Saldo tetap di field `users.coins` dan `users.inv` — tidak ada koleksi baru.
  - Riwayat muncul di tab "Tukar" (hist kind `transfer-out`/`transfer-in`) tanpa perubahan UI lama.
  - Gems SENGAJA tidak bisa ditransfer (anti ternak akun: setiap akun baru dapat 10 gems — akan
    dijavah kalau bisa dikirim). Jangan tampilkan opsi gems.
  - Cincin hasil gacha BOLEH dikirim (hadiah prestisius antar teman).

## B. UI Requirements

- **Halaman**: sub-tab "Transfer" di tab Dompet (`/wallet`).
- **Komponen**:
  1. Form tujuan: input username (autocomplete dari `/api/auth/users` yang sudah ada, pola cari teman).
  2. Form coin: input angka + tampilan besar "Penerima mendapat X (fee Y)" yang dihitung lokal
     (`coins - floor(coins*0.05)`) untuk pratinjau; angka final tetap dari server.
  3. Pemilih barang: daftar `inv` milik user (dari respons `transfer`) dengan stepper jumlah 1..stok.
  4. Tombol **Kirim** → modal konfirmasi ringkas (tujuan, item, coin, fee) → tombol konfirmasi mengirim `idem`.
  5. Kartu batas harian: "Sisa transfer hari ini: X Coin / Y item" (dari `daily`).
  6. Riwayat singkat 8 entri terakhir `hist` (kind transfer-out/in) dari endpoint economy lama — opsional.
- **Empty state inventaris**: "Simpananmu kosong — beli dulu di Toko."
- **Empty state form**: petunjuk "Ketik username temanmu, pilih coin/barang, lalu kirim."
- **Loading state**: tombol Kirim berubah spinner; input dikunci saat mengirim.
- **Error state**: pesan `error` server ditampilkan di kotak inline merah; tombol aktif kembali.
  - Khusus 409 "Simpanan <nama> penuh": tampilkan juga bahwa transfer dibatalkan dan saldo pengirim aman.
- **Success feedback**: panel ringkas "Terkirim ke <nama> — <nama> menerima <net> Coin (fee <fee>)" +
  toast; notifikasi keluar muncul di bel kedua pihak; saldo header diperbarui dari `coins` respons.

## C. User Flow

1. Buka tab Dompet → sub-tab Transfer. Data ringkasan dimuat (`/api/auth/transfer`).
2. Ketik username (autocomplete), isi coin dan/atau pilih barang.
3. Pratinjau fee/net tampil langsung; tombol Kirib aktif hanya bila: username valid, total > 0,
   coin ≥ 100 (atau 0 kalau hanya barang), dan tidak melebihi sisa batas harian.
4. Klik Kirim → modal konfirmasi (ringkasan + peringatan fee) → "Ya, kirim" → generate `idem` (crypto.randomUUID) →
   POST `transfer/send`.
5. Sukses: tutup modal, tampilkan hasil, refresh saldo (dari respons), refresh sub-tab, polling bel.
6. Gagal: tampilkan pesan; kalau 409 idem — jangan ulangi otomatis (transaksi sudah diproses).
7. Alternatif: dari profil pemain lain → tombol "Transfer" → buka sub-tab dengan username terisi.

## D. Backend Integration

### POST `/api/auth/transfer` — ringkasan & batas
Response 200:
```json
{
  "ok": true,
  "rates": { "feePct": 0.05, "minCoin": 100, "maxCoin": 100000, "dayCoin": 100000,
             "dayItem": 200, "maxKinds": 8, "trustHours": 24 },
  "trust": true,
  "coins": 12500, "gems": 10, "inv": { "macaron": 2, "cincin-biru": 1 },
  "daily": { "coins": 7000, "coinLeft": 93000, "items": 3, "itemLeft": 197 }
}
```
- `trust: false` → akun belum berumur 24 jam: SEMUA aksi keluar (transfer/trade/market/rob) ditolak
  server. Sembunyikan/disable tombol kirim + tampilkan penjelasan.

### POST `/api/auth/transfer/send` — kirim
Body:
```json
{ "to": "bravo", "coins": 5000, "items": { "macaron": 3, "cincin-biru": 1 }, "idem": "<uuid>" }
```
(`coins` boleh tidak dikirim bila murni barang; `items` juga opsional bila murni coin.
Jangan kirim `items: {}` kosong — omit saja.)
Response 200:
```json
{
  "ok": true, "coins": 7500, "gems": 10, "inv": { "macaron": 2 },
  "done": { "to": "Bravo", "coins": 5000, "fee": 250, "net": 4750,
            "items": [ { "id": "macaron", "n": 3 } ] },
  "daily": { "coins": 12000, "coinLeft": 88000, "items": 3, "itemLeft": 197 }
}
```
Error ( semua berisi `{ "error": "..." }` siap tampil):
| Kode | Penyebab |
|------|----------|
| 400 | username kosong / diri sendiri / coin < 100 atau > 100.000 / > 8 jenis barang / barang tidak dikenal / transfer kosong |
| 403 | akun belum berumur (anti ternak) |
| 404 | penerima tidak ditemukan |
| 409 | `idem` sudah diproses ATAU coin/barang pengirim kurang ATAU simpanan penerima penuh (999/barang) — body tetap memuat `coins/inv` terbaru |
| 429 | pembatas laju (10/menit) atau batas harian coin/barang |

## E. UI State Management

- State lokal sub-tab: `to`, `coins`, `items` (peta id→qty), `busy`, `view` (data ringkasan).
- Refresh `view` setelah: aksi sukses (pakai body respons — sudah memuat view baru) atau error 409
  (body 409 juga memuat view terbaru — pakai untuk sinkron saldo).
- Jangan cache `inv` lebih lama dari sesi tampilan; buka ulang sub-tab selalu memuat `transfer`.
- `idem` dibuat SEKALI per niat mengirim (saat modal konfirmasi terbuka); refresh halaman = idem baru.

## F. Validation (tampilan; server tetap penentu akhir)

- Username: pola `^[a-z0-9_.-]{3,20}$`, lowercase.
- Coin: bulat ≥ 100 (atau 0 bila ada barang), ≤ 100.000, ≤ `coinLeft`.
- Barang: jumlah 1..stok milik user; total jenis ≤ 8; total item hari ini ≤ `itemLeft`.
- Tampilkan sisa batas harian; disable tombol bila melebihi.
- Fee tampil sebelum kirim: `floor(coins * rates.feePct)`.

## G. Responsive Design

- **Desktop**: dua kolom — form kiri, kartu batas+riwayat kanan.
- **Mobile**: satu kolom; pemilih barang jadi daftar collapsible ("Pilih barang (2 dipilih)");
  modal konfirmasi jadi bottom-sheet.
- Stepper barang: tombol − / + minimal 44px; input angka `inputmode="numeric"`.

## H. Acceptance Criteria

1. Kirim 5.000 coin ke pemain valid → pengirim -5.000, penerima +4.750 (fee 250 terlihat di modal SEBELUM kirim).
2. Kirim barang → inventaris pengirim & penerima berubah tepat jumlahnya; cincin bisa dikirim.
3. Ganda-klik "Ya, kirim" hanya memproses sekali (respons kedua 409 "sudah diproses", saldo tetap benar).
4. Coin kurang / barang kurang / penuh di penerima → pesan jelas dan TIDAK ADA saldo/inventaris berubah.
5. Dua tab paralel mengirim dengan saldo hanya cukup satu → satu 200, satu 409, saldo tidak minus.
6. Batas harian tampil benar dan request melebihi batas ditolak dengan pesan.
7. Akun baru (< 24 jam) melihat tombol kirim nonaktif + alasan.
8. Setelah sukses: saldo header, sub-tab, dan badge bel semuanya diperbarui tanpa reload halaman.
