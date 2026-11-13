# Bank System (Bank — Simpanan Aman dari Pencurian)

## A. Feature Overview

- **Nama fitur**: Bank.
- **Tujuan**: tempat menyimpan Coin yang **aman dari pencurian pemain lain** (lihat robbery-system.md);
  sumber pendapatan pasif kecil (bunga harian) sebagai alasan kembali tiap hari.
- **Fungsi utama**: setor coin dompet → bank; tarik bank → dompet; bunga 0,5%/hari (plafon 200/hari),
  dihitung otomatis (lazy) pada aksi/tampilan pertama tiap hari (00.00 WIB).
- **Hubungan dengan sistem yang sudah ada**:
  - Backend `lib/bank.js`, field baru `users.bank` + `users.bankIntDay` (dibuat otomatis saat
    pertama dipakai — akun lama kompatibel).
  - **Robbery hanya membaca `coins` (dompet)** — saldo bank tidak tersentuh; layar pencurian
    menampilkan pesan "Coin di Bank aman" di setiap kejadian dirampok.
  - Bunga juga muncul sebagai notifikasi `bank` di pusat notifikasi.

## B. UI Requirements

- **Halaman**: sub-tab "Bank" di tab Dompet (`/wallet`).
- **Komponen**:
  1. Kartu saldo besar: **Dompet** (`coins`, bisa dicuri) dan **Bank** (`bank`, aman) bersebelahan,
     dengan ikon perisai kecil di angka bank.
  2. Slider/toggle jumlah setor: chip cepat (100, 500, 1000, 5000, "Semua dompet") + input angka.
  3. Tombol **Setor** dan **Tarik** (tarik: chip 100/500/"Semua bank").
  4. Kartu bunga: "Bunga 0,5% per hari, maks 200/hari — masuk otomatis setiap hari."
     + status hari ini ("Bunga hari ini sudah masuk" / "Belum berbunga hari ini" dari `interest.day`).
  5. Kartu edukasi singkat: "Coin di dompet bisa jadi target pencurian pemain lain. Coin di Bank aman."
  6. (opsional) Riwayat `bank`/`rob-*` dari tab Tukar lama — tidak wajib.
- **Empty state**: saldo bank 0 → kartu ilustrasi + "Setor pertamamu untuk mengamankan coin dari pencuri."
- **Loading state**: tombol setor/tarik spinner; angka saldo dikunci sesaat.
- **Error state**: pesan server inline (mis. "Coin di dompet kamu belum cukup.").
- **Success feedback**: angka dompet & bank beranimasi turun/naik; toast "Setor X berhasil" /
  "Tarik X berhasil"; bunga masuk ditampilkan sebagai notifikasi bel + toast kecil saat terdeteksi.

## C. User Flow

1. Buka sub-tab Bank → `POST /api/auth/bank` (bunga hari itu otomatis masuk kalau belum).
2. Setor: pilih/jumlah chip → tombol Setor → (tanpa konfirmasi tambahan untuk setoran biasa) →
   `POST /api/auth/bank/deposit`.
3. Tarik: pilih jumlah → Tarik → `POST /api/auth/bank/withdraw`.
4. Setelah aksi: dua angka diperbarui dari respons; saldo header shell juga.
5. Setiap hari pertama kali dibuka: bunga otomatis terlihat (saldo bank naik + notifikasi).

## D. Backend Integration

### POST `/api/auth/bank` — ringkasan (sekaligus memicu bunga lazy)
Response 200:
```json
{
  "ok": true, "bank": 5025, "coins": 3475,
  "rates": { "minDeposit": 100, "maxDeposit": 500000, "maxWithdraw": 500000,
             "interestPct": 0.005, "interestMax": 200 },
  "interest": { "day": true, "pct": 0.005, "max": 200 },
  "pocketNote": "Coin di dompet bisa jadi target pencurian; saldo Bank aman."
}
```
`interest.day: true` = bunga hari ini SUDAH masuk (atau hari masih berjalan).

### POST `/api/auth/bank/deposit` — setor
Body: `{ "amount": 5000 }` → Response 200:
```json
{ "ok": true, "bank": 5000, "coins": 3475, "done": { "kind": "deposit", "amount": 5000 } }
```
Error: `400` amount < 100 / > 500.000 / bukan angka; `409` dompet kurang; `429` (20 aksi/menit).

### POST `/api/auth/bank/withdraw` — tarik
Body: `{ "amount": 1025 }` → Response 200:
```json
{ "ok": true, "bank": 4000, "coins": 4500, "done": { "kind": "withdraw", "amount": 1025 } }
```
Error: `400` amount < 1 / > 500.000; `409` saldo bank kurang; `429`.

## E. UI State Management

- State: `{ bank, coins, rates, interest }` — SELALU diganti penuh dari body respons terakhir
  (semua endpoint membalik `bank` + `coins` terbaru).
- Tidak perlu timer client: bunga dihitung server. Cukup muat ulang `bank` saat sub-tab dibuka.
- Setelah notifikasi tipe `bank` diterima (bel), muat ulang sub-tab bila sedang terbuka.

## F. Validation (tampilan)

- Setor: 100..500.000, ≤ `coins` dompet. Tarik: 1..500.000, ≤ `bank`.
- Input `inputmode="numeric"`; tolak desimal/negatif sebelum kirim.
- Semua batas tampil di kartu bunga/kartu saldo (dari `rates`) — jangan hardcode.

## G. Responsive Design

- **Desktop**: kartu dompet & bank bersebelahan; form aksi di bawahnya.
- **Mobile**: dua kartu bertumpuk (dompet dulu, bank dengan aksen perisai); chip cepat scroll horizontal;
  tombol setor/tarik lebar penuh berdampingan.

## H. Acceptance Criteria

1. Setor 5.000 → dompet -5.000, bank +5.000 (angka dari respons, bukan hitungan lokal).
2. Tarik sebagian/semua berhasil; tarik melebihi saldo ditolak dengan pesan.
3. Bunga 0,5% (maks 200) masuk otomatis sekali per hari WIB saat layar dibuka / aksi pertama;
   membuka layar lagi di hari yang sama TIDAK menambah bunga lagi.
4. Setelah kejadian pencurian di layar lain: saldo bank korban tidak berkurang (dompet saja).
5. Setoran < 100 ditolak dengan pesan yang jelas sebelum request (validasi lokal) dan oleh server.
6. Semua angka `rates` ditampilkan dari respons (tidak ada angka hardcode di UI).
