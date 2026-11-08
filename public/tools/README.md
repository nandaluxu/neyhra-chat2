# Folder `public/tools/` — tab Tools

Satu tab, banyak alat kecil. Tiap tool punya foldernya sendiri dan **hanya diunduh saat dibuka**.

```
public/tools/
  tools.js        hub: daftar tool (LIST), pemuat, alamat /tools dan /tools/<id>
  tools.css       gaya hub + kelas bersama .tl-* (tombol, field, chip, ...)
  voice/          tool "AI Voice"
    voice.js
    voice.css
```

Alamat: `/tools` (daftar) dan `/tools/<id>` (mis. `/tools/voice`). `router.js` memakai `Tools.path()` dan `Tools.open(id)`.

## Menambah tool baru

1. Buat folder `public/tools/<id>/` berisi `<id>.js` (dan `<id>.css` kalau perlu). Awali kelas CSS dengan awalan unik (mis. `vx-` untuk voice) supaya tidak bentrok. Jangan memakai elemen `<header>` (sudah ada gaya global di `index.html`).
2. Di `<id>.js` daftarkan tool:
   ```js
   Tools.register('<id>', {
     mount(host, ctx) { /* gambar UI ke dalam host (elemen kosong) */ },
     unmount() { /* hentikan timer / permintaan yang masih jalan */ }
   })
   ```
   `ctx` = `{ toast(teks), post(url, body, headers), chars(), store }` (meminjam fungsi/variabel global `index.html`).
   Dari global lain yang bisa dipakai langsung: `vcode` (kode voice yang sudah terbukti benar), `atok`/`aApi` (akun), `allChars`.
3. Tambah satu entri di `LIST` pada `tools.js`: `{ id, title, desc, icon (isi <svg viewBox="0 0 24 24">), css, js }`. Selesai: `index.html` tidak perlu diubah.

Tool dipasang ulang (`mount`) tiap dibuka dari daftar; simpan state yang mau dipertahankan di variabel modul (seperti `results` di voice).

## Tool: AI Voice (`voice/`)

Ketik teks → pilih karakter (diambil otomatis dari `allChars`, yaitu daftar yang sama dengan `/api/chars`, jadi karakter baru di `char/` langsung muncul) → kalau karakter punya lebih dari satu suara (mis. Reze) pilih suaranya → **Buat suara**. Hasil bisa diputar dan diunduh (mp3). 8 hasil terakhir disimpan di memori halaman saja.

- Memakai endpoint voice note yang sudah ada: `POST /api/tts` (`lib/app.js`, Fish Audio). **Tidak ada kode server baru.** Aturannya ikut: header `x-voice-code` harus cocok `VOICE_CODE`, teks maks 800 karakter, nama karakter dilafalkan benar kalau teks Jepang.
- Belum punya kode voice? Kotak "Kode voice dibutuhkan" muncul di halaman tool; kodenya sama dengan di Pengaturan (disimpan di `localStorage.vcode`).
- Tag ekspresi (`[whisper]`, `[laughing]`, dst., sama dengan `TAGS` di `lib/sessions.js`) bisa disisipkan lewat tombol di bawah kotak teks.
- Karakter dan suara terakhir yang dipilih diingat di `localStorage['tool:voice']`.
