# Player Trading (Perdagangan Dua Pihak)

## A. Feature Overview

- **Nama fitur**: Trading — penawaran tukar barang dan/atau coin antara dua pemain yang harus
  **disetujui kedua pihak** sebelum dieksekusi.
- **Tujuan**: perbandingan barang yang adil ("aku kasih 3 roti + 200 coin, kamu kasih 2 teh"),
  lebih slow-paced daripada marketplace; murni sosial/negosiasi.
- **Fungsi utama**:
  - Buat penawaran: sisi **offer** (apa yang aku bayar) dan sisi **want** (apa yang aku minta) —
    masing-masing kombinasi coin (0–50.000) dan barang (barang toko + cincin gacha, maks 8 jenis).
  - Penerima menawar → **Terima** (escrow + tukar atomik dengan kompensasi penuh) atau menunggu;
    penawar → **Batalkan**.
  - Kedaluwarsa otomatis 48 jam (status `expire`).
  - Riwayat status: `pending` → `done` / `cancel` / `expire` (+ `lock` sesaat diproses).
- **Hubungan dengan sistem yang sudah ada**:
  - Backend `lib/trade.js`; koleksi `trades` (TTL 180 hari). Tidak ada field baru di `users`.
  - Barang TIDAK ditahan saat membuat penawaran (kewajiban stok di-revalidasi saat diterima).
  - Transaksi selesai tercatat di riwayat ekonomi kedua pihak (`trade-in`/`trade-out`) + notifikasi.

## B. UI Requirements

- **Halaman**: sub-tab "Perdagangan" di tab Dompet (`/wallet`) dengan tiga bagian:
  **Masuk** (incoming) | **Ku.tawarkan** (outgoing) | **Riwayat** (done).
- **Komponen**:
  1. **Kartu penawaran** (dipakai di ketiga bagian): dua kolom bertemu di tengah —
     `[offer: coins + item chips] ⇄ [want: coins + item chips]`, lawan (`from`/`to`), status chip
     (Menunggu/Selesai/Dibatalkan/Hangus + sisa waktu), tombol per peran:
     - Masuk (aku penerima): **Terima** (hijau) + pratinjau syarat ku.
     - Ku.tawarkan (aku penawar): **Batalkan**.
     - Riwayat: tanpa tombol.
  2. **Form buat penawaran** (modal atau inline): target username (autocomplete),
     dua panel "Kamu berikan" / "Kamu minta": pemilih barang dari `inv` + input coin (0..50.000).
  3. Kartu batas: maks 5 penawaran aktif, maks 10 baru per jam (dari `rates`).
  4. Indikator `trust` (akun < 24 jam tidak bisa menawarkan).
- **Empty state tiap bagian**: Masuk → "Belum ada penawaran untukmu." Ku.tawarkan → "Buat penawaran
  pertamamu — tukar barang yang tidak kamu butuhkan." Riwayat → kosong.
- **Loading state**: skeleton kartu; tombol Terima/Batalkan → spinner.
- **Error state**: pesan server inline; khusus 409 alasan per status (lihat D) — tampilkan kalimat lengkap.
- **Success feedback**: Terima sukses → kartu pindah ke Riwayat + ringkasan "Dapat X, bayar Y" +
  saldo header berubah; penawar menerima notifikasi `trade-done`.

## C. User Flow

1. Buka sub-tab → `POST /api/auth/trade` → incoming/outgoing/done + inv/coins/rates.
2. **Buat**: klik "Penawaran baru" → pilih target → isi kedua sisi → (pratinjau otomatis) → Kirim
   (dengan `idem`) → penawaran muncul di "Ku.tawarkan"; target dapat notifikasi `trade`.
3. **Terima** (sebagai penerima): tinjau kartu penawaran → validasi cepat bahwa aku punya sisi `want`
   → klik Terima → `POST /api/auth/trade/accept { id }` → hasil (dapat/bayar) + semua saldo/inv baru.
   Bila 409 (stok kurang dsb.) → kartu tetap "Menunggu" (penawaran tidak hilang) + pesan.
4. **Batalkan** (sebagai penawar): klik Batalkan → `trade/cancel` → kartu pindah ke Riwayat (cancel),
   penerima dapat notifikasi.
5. Hangus: kartu melewati 48 jam → saat daftar dimuat ulang, status otomatis `expire`.

## D. Backend Integration

Semua POST + token Bearer.

### POST `/api/auth/trade` — halaman saya
Response 200:
```json
{
  "ok": true,
  "rates": { "maxCoin": 50000, "maxKinds": 8, "expHours": 48, "pendingMax": 5, "rateMax": 10 },
  "trust": true, "coins": 49350, "gems": 10, "inv": { "roti": 7, "teh": 2 },
  "incoming": [ { "id": "<uuid>", "from": "Bravo", "to": "Charlie",
      "offer": { "coins": 100, "items": [ { "id": "teh", "n": 2 } ] },
      "want":   { "coins": 0,   "items": [ { "id": "roti", "n": 3 } ] },
      "status": "pending", "createdAt": "...", "expAt": "...", "doneAt": null } ],
  "outgoing": [ ... ],
  "done": [ ...status done|cancel|expire... ]
}
```

### POST `/api/auth/trade/create`
Body:
```json
{ "to": "bravo",
  "offer": { "coins": 200, "items": { "roti": 3 } },
  "want":   { "items": { "teh": 2 } },
  "idem": "<uuid>" }
```
(`coins` boleh dihilangkan bila 0; `items` juga. Jangan kirim `items: {}` kosong.)
Response 200: `{ "ok": true, "trade": { ...objek kartu sama di atas... } }`
Error: `400` bentuk salah / diri sendiri / kedua sisi kosong / coin > 50.000 / > 8 jenis / barang palsu;
`403` salah satu akun belum berumur; `404` target tidak ditemukan; `409` stok penawar kurang (saat buat)
atau `idem` duplikat; `429` > 5 aktif atau > 10 buat/jam.

### POST `/api/auth/trade/accept` — hanya penerima
Body: `{ "id": "<uuid trade>" }` → Response 200:
```json
{ "ok": true, "trade": { ...status done... },
  "coins": 49550, "got": "200 Coin + 3 roti", "paid": "2 teh" }
```
Error `409` dengan alasan lengkap, antara lain:
- "Penawaran sudah hangus (lewat 48 jam)."
- "Penawaran sudah selesai / sudah dibatalkan / sedang diproses."
- "Penawar tidak lagi punya barang/coin yang ditawarkan..." (penawaran tetap menunggu)
- "Barang/coin kamu untuk menerima penawaran ini belum cukup..." (penawaran tetap menunggu)
- "Simpanan salah satu pihak penuh (maks 999 per barang)..." (semua dikembalikan, penawaran menunggu)
`400` id tidak valid; `429` (12 accept/menit).

### POST `/api/auth/trade/cancel` — hanya penawar
Body: `{ "id": "<uuid>" }` → Response 200: `{ "ok": true }`.
Error: `409` tidak ditemukan / sudah tidak bisa dibatalkan; `429`.

## E. UI State Management

- State: `view` (incoming/outgoing/done/inv/coins), modal buat penawaran, hasil accept terakhir.
- Muat ulang `trade` setelah: create/accept/cancel (apa pun hasilnya — status kartu bisa berubah),
  dan saat notifikasi `trade`/`trade-done` masuk saat layar terbuka.
- Sisa waktu penawaran: hitung lokal dari `expAt`; saat habis, ubah tampilan kartu menjadi "Hangus"
  secara optimis (server menetapkan status sebenarnya saat dimuat ulang).
- `idem` dibuat saat form dikirim (satu niah = satu idem).

## F. Validation (tampilan)

- Target: username valid, bukan diri sendiri.
- Tiap sisi: coin 0..50.000 (bulat), maks 8 jenis barang, jumlah 1..stok `inv` untuk sisi offer
  (sisi want bebas — kepemilikan penerima dicek server saat accept).
- Kedua sisi tidak boleh kosong bersamaan.
- Tombol Terima: WAJIB cek lokal dulu sisi want terhadap inv/coins saya (pesan ramah sebelum request);
  server tetap penentu akhir — 409 stok kurang ditampilkan apa adanya.

## G. Responsive Design

- **Desktop**: tiga bagian dalam sub-nav vertikal kecil atau tab horizontal; kartu penawaran
  dua kolom berhadapan dengan tanda ⇄ besar di tengah.
- **Mobile**: kartu penawaran menjadi bertumpuk ("Dia berikan" di atas, "Kamu berikan" di bawah,
  ⇄ di antaranya); tombol Terima/Batalkan lebar penuh; form buat jadi bottom-sheet bertahap
  (langkah 1 target, langkah 2 dua sisi).
- Chips barang: ikon + "×n"; sentuh chip = kurangi jumlah.

## H. Acceptance Criteria

1. Buat penawaran valid → muncul di "Ku.tawarkan" + notifikasi `trade` ke target (dicek lewat bel).
2. Terima → SEMUA perubahan tepat: penawar kehilangan offer & menerima want; penerima sebaliknya;
   saldo header kedua sisi (bila dibuka) benar.
3. Accept saat stok salah satu pihak kurang → 409, penawaran tetap menunggu, tidak ada yang berubah.
4. Batalkan oleh penawar → status `cancel`; penerima tidak bisa accept lagi (409).
5. Penawaran > 48 jam tidak bisa diterima (409 "hangus") dan terlihat `expire` di Riwayat.
6. Dua klik Terima paralel → hanya satu yang berhasil (satu 200, satu 409), barang tidak dobel.
7. Maks 5 penawaran aktif dan 10 baru/jam ditampilkan/dijaga (429 dengan pesan).
8. Cincin gacha bisa masuk kedua sisi penawaran; gems tidak ada di UI (memang tidak didukung).
