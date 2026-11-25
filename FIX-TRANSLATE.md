# FIX-TRANSLATE — Terjemahan lirik "kadang berfungsi, kadang tidak"

Delta kecil di atas kondisi repo terbaru (commit `47c91da`). Tanpa env baru, tanpa dependency
baru, tanpa perubahan skema. Fix playlist sebelumnya (`mine`/badge Kamu) tidak disentuh.

## Gejala

Tombol terjemahan lirik kadang menampilkan terjemahan, kadang toast "Terjemahan gagal, coba
lagi nanti" — lagu yang sama bisa berhasil lalu gagal, tanpa pola yang jelas bagi pengguna.

## Akar masalah (diukur langsung, 25 Nov 2026)

Endpoint gratis DeepL oneshot yang dipakai `lib/music.js`
(`https://oneshot.fal.free.deepl.com/v1/translate`, host cadangan `kef`) menolak request yang
total teksnya melewati **±1500 karakter** dengan **HTTP 400 "text exceeds maximum length"** —
batas ini bergulir (dipengaruhi request sebelumnya dari IP yang sama dalam jendela waktu).

Server lama mengirim **semua baris lirik sekaligus** (maks 200 baris × 600 char = hingga 120
ribu char). Akibatnya:

- Lirik pendek (total < ±1500 char) → lolos → "berfungsi".
- Lirik panjang/normal (kebanyakan lagu!) → 400 di host `fal`, dicoba host `kef` → 400 juga →
  server membalas 502 → "tidak berfungsi".

Kedua host berbagi kuota yang sama, jadi fallback host tidak menolong. Kegagalan terlihat
"acak" karena bergantung panjang lirik lagu yang diputar + sisa kuota bergulir.

## Perubahan

| File | Perubahan |
|---|---|
| `lib/music.js` | `/api/music/translate` kini **memecah lirik jadi potongan kecil** (maks 1200 char / 50 baris per request, pagar maks 26 potongan ≈ 30 ribu char). Tiap potongan dikirim ke DeepL lewat `deeplOnce()`: coba host `fal` → `kef`, ulangi sekali setelah jeda 0,8 dtk kalau keduanya gagal (429/5xx/timeout). Potongan yang isinya cuma spasi dilewati (hemat kuota). Posisi jawaban selalu sejajar dengan baris asli — jawaban pendek tidak menggeser potongan berikutnya. Cache 7 hari tetap; rate-limit 20/menit tetap. |
| `public/music.js` | `ensureTr()` kini **coba sekali lagi otomatis setelah 3 dtk** kalau permintaan pertama gagal (kegagalan kuota sesaat sangat umum). Tanpa ini, satu kegagalan mematikan terjemahan lagu itu sampai ganti lagu. |
| `scripts/translate-fix-test.mjs` | Test baru: unit logika chunking (diekstrak dari sumber asli) + live test endpoint dengan lirik 60 baris yang DULU selalu gagal, sejajaran baris kosong, cache, lirik Jepang. |
| `scripts/deepl-probe.mjs`, `deepl-limit*.mjs` | Skrip riset pemetaan perilaku endpoint (bukti akar masalah; boleh dihapus). |

## Cara pasang — Cara A (ekstrak zip)

1. Ekstrak zip ini di **akar repo** (folder yang ada `package.json`), timpa.
2. Tidak ada `npm install` baru, tidak ada env baru.
3. Commit + push — Vercel otomatis deploy.
4. Cek: putar lagu dengan lirik panjang (mis. lagu barat 4-5 menit), nyalakan ikon terjemahan
   di tab Lirik → terjemahan muncul di bawah tiap baris (dulu: gagal).

> ⚠️ **Syarat Cara A:** repo lokal sama dengan yang di GitHub. File yang ditimpa:
> `lib/music.js`, `public/music.js` (+ 3 script test jika ikut).

## Setelah deploy — perilaku baru

- Lirik panjang kini diterjemahkan (dipecah otomatis menjadi beberapa request kecil).
- Kegagalan sesaat dijawab dengan 1x percobaan ulang otomatis (server: jeda 0,8 dtk antar
  host; klien: ulang setelah 3 dtk), bukan langsung menyerah.
- Lagu yang sangat ekstrem (>26 potongan) tetap dapat terjemahan untuk ±30 ribu karakter
  pertama; baris setelah itu tampil tanpa terjemahan (bukan kegagalan total).
- Cache 7 hari: lagu yang sudah pernah diterjemahkan tetap instan dan tidak memakai kuota.

## Hasil tes (25 Nov 2026, sandbox ini)

| Suite | Hasil |
|---|---|
| `node scripts/translate-fix-test.mjs` (unit + live DeepL) | **19 lulus, 0 gagal** |
| `node scripts/music-ui-test.mjs` (regresi UI, termasuk seksi terjemahan) | **101 lulus, 0 gagal** |
| `node --check` lib/music.js, public/music.js | lolos |
| Bukti akar masalah: probe langsung ke endpoint DeepL | 5000-120000 char → 400; ≤1500 char → 200 (setelah kuota pulih) |
