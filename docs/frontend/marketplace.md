# Marketplace (Pasaran Barang Antara-Player)

## A. Feature Overview

- **Nama fitur**: Marketplace — jual barang inventaris dengan harga Coin terbuka, siapa pun boleh beli.
- **Tujuan**: harga ditentukan pasar (player-driven), memberi nilai guna ekonomis untuk barang & coin,
  dan memaksa keputusan "jual vs berikan ke karakter".
- **Fungsi utama**:
  - **Jual lot**: pasang `qty` × barang dengan satu harga untuk seluruh lot (pembeli membeli lot penuh).
  - **Barang di-escrow saat dipasang** (langsung keluar dari inventaris penjual): tidak bisa
    berjualan barang yang sama dua kali; listing pasti tersedia.
  - **Beli**: pembeli bayar coin, terima barang (atomik); penjual menerima harga − fee 5% (fee DIBUANG —
    sink ekonomi, mencegah wash-trading menguntungkan diri sendiri).
  - **Batal listing** (barang kembali) dan **hangus otomatis 7 hari** (escrow kembali saat penjual
    membuka layar market).
  - **Riwayat harga**: 10 penjualan terakhir per barang (untuk menaksir harga wajar).
  - Maks 20 listing aktif, 10 listing baru/jam, harga 20–100.000 per lot.
- **Hubungan dengan sistem yang sudah ada**:
  - Backend `lib/market.js`; koleksi `market` (TTL 180 hari). Tidak ada field baru di `users`.
  - Cincin gacha boleh dijual (harga bebas — pasar yang menentukan).
  - Tidak bisa membeli listing sendiri.
  - Penjualan/pembelian tercatat di riwayat ekonomi (`market-buy`/`market-sell`) + notifikasi kedua pihak.

## B. UI Requirements

- **Halaman**: sub-tab "Market" di tab Dompet (`/wallet`) dengan tiga bagian:
  **Jelajah** | **Tokoku** (listing saya) | **Pembelianku**.
- **Komponen**:
  1. **Jelajah**: filter barang (dropdown/chips dari `items` respons — memuat harga toko sebagai
     patokan) → daftar kartu listing: barang + qty, harga besar, fee & proceeds kecil, nama penjual,
     sisa waktu; tombol **Beli lot**.
     Panel **Riwayat harga** untuk barang terpilih (`prices`: harga/qty/waktu terakhir laku).
  2. **Tokoku**: listing aktif (sisa waktu, tombol **Batalkan**), listing laku (`sold` + pembeli),
     listing hangus/batal; form **Pasang lot**: pilih barang (dari `inv`), qty 1..stok, harga total,
     tampilan fee/proceeds; indikator batas (X/20 aktif).
  3. **Pembelianku**: riwayat listing yang kubeli (barang, harga, penjual, waktu).
- **Empty state**: Jelajah → "Belum ada yang jualan. Jadilah yang pertama!" Tokoku → "Pasang lot
  pertamamu." Pembelianku → "Belum ada pembelian."
- **Loading state**: skeleton kartu listing; tombol Beli/Pasang → spinner.
- **Error state**: pesan server inline; khusus 409 "Listing sudah terjual..." → muat ulang Jelajah.
- **Success feedback**: Beli → toast "Dapat X <barang>" + saldo header update + kartu hilang dari Jelajah;
  Pasang → kartu baru di Tokoku + inventaris berkurang (dari respons `inv`).

## C. User Flow

1. Buka sub-tab → `POST /api/auth/market` (tanpa `item` = semua listing) → Jelajah + Tokoku + Pembelianku.
2. (Filter) pilih barang → `market { item: "<id>" }` → listing terfilter + `prices` barang itu.
3. **Beli**: klik Beli lot → modal ringkas (barang, qty, harga, fee info "penjual menerima X") →
   konfirmasi (dengan `idem`) → `market/buy` → hasil + semua angka baru.
4. **Jual**: klik Pasang lot → pilih barang+qty+harga (pratinjau fee & proceeds live) → Pasang
   (dengan `idem`) → `market/list` → barang keluar inventaris seketika, listing aktif.
5. **Batal**: di Tokoku → Batalkan → `market/cancel` → barang kembali ke inventaris.
6. Hangus: setelah 7 hari, saat Tokoku dibuka listing jadi `expire` + barang sudah kembali.

## D. Backend Integration

### POST `/api/auth/market` — jelajah + milik saya
Body: `{ "item": "apel" }` (`item` opsional = id barang untuk filter + riwayat harga).
Response 200:
```json
{
  "ok": true,
  "rates": { "feePct": 0.05, "minPrice": 20, "maxPrice": 100000, "maxQty": 99,
             "expHours": 168, "pendingMax": 20, "rateMax": 10, "listLimit": 50 },
  "trust": true, "item": "apel", "itemName": "Apel",
  "items": [ { "id": "apel", "name": "Apel", "price": 50 }, ... ],  // termasuk cincin (price = harga toko / 0 utk cincin)
  "coins": 12500, "inv": { "apel": 10 },
  "listings": [ { "id": "<uuid>", "seller": "Delta", "item": "apel", "qty": 10, "price": 700,
                  "fee": 35, "proceeds": 665, "status": "listed",
                  "createdAt": "...", "expAt": "..." } ],
  "prices": [ { "price": 700, "qty": 10, "at": "...", "seller": "Delta" } ],
  "mine": [ ...listing saya semua status... ],
  "bought": [ ...listing status sold yang kupilih, memuat "buyer", "soldAt"... ]
}
```

### POST `/api/auth/market/list` — pasang (escrow)
Body: `{ "item": "apel", "qty": 10, "price": 700, "idem": "<uuid>" }` →
Response 200: `{ "ok": true, "listing": { ... }, "inv": { "apel": 2 }, "coins": 12500 }`
Error: `400` barang/qty (1–99)/harga (20–100.000) tidak valid; `403` akun belum berumur;
`409` stok kurang; `429` > 20 aktif / > 10 listing baru per jam.

### POST `/api/auth/market/buy` — beli lot penuh
Body: `{ "id": "<uuid listing>", "idem": "<uuid>" }` → Response 200:
```json
{ "ok": true, "listing": { ...status sold, buyer: "Alfa"... },
  "coins": 11800, "got": { "item": "apel", "qty": 10 }, "paid": 700 }
```
Error: `400` id palsu / beli listing sendiri; `409` listing sudah terjual/dibatalkan/hangus
ATAWA coin kurang ATAWA simpanan pembeli penuh (body tetap memuat `coins` terbaru); `429`.

### POST `/api/auth/market/cancel` — batalkan listing
Body: `{ "id": "<uuid>" }` → Response 200: `{ "ok": true }`
Error: `409` tidak ditemukan / sudah tidak bisa dibatalkan (terjual/hangus); `429`.

## E. UI State Management

- State: `view` (listings/prices/mine/bought/inv/coins), form pasang, filter aktif.
- Muat ulang `market` (dengan filter aktif) setelah: beli sukses, pasang, batal; juga saat notifikasi
  `market` masuk dan layar terbuka (listing kita bisa laku kapan saja).
- Countdown sisa listing: dari `expAt` lokal; status final selalu dari server saat muat ulang.
- Fee/proceeds pratinjau dihitung lokal `floor(price * rates.feePct)` untuk tampilan, nilai final dari respons.

## F. Validation (tampilan)

- Pasang: barang dari `inv` (bukan kosong), qty 1..min(99, stok), harga 20..100.000, ≤ `rates.maxPrice`.
- Beli: coin dompet ≥ harga (cegah lokal + pesan ramah), tombol nonaktif bila kurang.
- Tampilkan harga toko (`items[].price`) sebagai "harga toko" agar penjual menaksir; cincin ditandai
  "gacha — harga bebas".
- `idem` sekali per konfirmasi; 409 idem → jangan auto-retry.

## G. Responsive Design

- **Desktop**: Jelajah grid 2–3 kolom kartu; Tokoku/Pembelianku daftar baris.
- **Mobile**: kartu listing 1 kolom (barang + qty + harga besar + tombol Beli penuh); filter chips
  horizontal; form pasang jadi bottom-sheet; modal beli bottom-sheet.
- Riwayat harga: tabel kecil di desktop → daftar baris di mobile.
- Waktu sisa listing relatif ("6 hari lagi").

## H. Acceptance Criteria

1. Pasang lot 10 apel @ 700 → inventaris penjual berkurang 10 SEKETIKA dan listing tampil di Jelajah.
2. Beli → pembeli -700 & +10 apel; penjual +665 (fee 35) — SEMUA angka dari respons; saldo header benar.
3. Beli listing sendiri → ditolak (400) dengan pesan.
4. Coin kurang saat beli → 409, listing tetap `listed` (bisa dibeli orang lain), penjual TIDAK dikredit.
5. Dua pembeli paralel → satu sukses satu 409; total coin semua pihak berkurang tepat nilai fee sekali.
6. Batalkan → barang kembali persis jumlahnya; hangus 7 hari → otomatis expire + barang kembali
   saat Tokoku dibuka.
7. Riwayat harga per barang menampilkan penjualan terbaru (harga/qty/waktu).
8. Batas 20 listing aktif & 10/jam terjaga (429 dengan pesan); akun baru tidak bisa berjualan (403).
9. Filter barang memuat harga toko sebagai patokan + riwayat harga (tidak ada angka hardcode).
