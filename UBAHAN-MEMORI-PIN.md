# UBAHAN — Memori manual + Pesan disematkan (pin)

> Perubahan di `public/index.html` (+ `public/shell.css`, `public/shell.js`), semua di sisi client.
> Server tidak berubah: memori tulisan manual memakai jalur `mem:<id>` yang sudah ada,
> pin sama sekali tidak lewat server (hanya ikut sinkron akun sebagai data obrolan).

---

## 1. Memori "kok punya gw ga kesimpen?" — kenapa + apa yang dibenerin

Gejala: obrolan sudah lama tapi menu Memori tetap kosong, tanpa pesan error apa pun.

Penyebab paling umum (kombinasi):
1. **Ringkasan otomatis gagal diam-diam.** `maybeMemorize()` cuma jalan setelah balasan AI,
   dan kalau `/api/memory` gagal (ChatGPT anon 429/502, jaringan), mode otomatis TIDAK menampilkan
   apa pun. Jeda coba ulangnya malah makin panjang (`MEM_RETRY × 2^fail`, maks 16 menit) —
   kegagalan berturut-turst membuatnya nyaris berhenti tanpa gejala.
2. **Tombol "Ringkas sekarang" cuma ada di Mode dev** — user biasa tidak bisa memaksa
   meringkas atau melihat errornya.

Perbaikan:
| # | Perubahan | Detail |
|---|---|---|
| 1 | **"Ringkas sekarang" untuk semua user** | Dulu `if(devOn())` di `renderCharMem`; sekarang selalu tampil di Kotak memori (panel Detail karakter). Kalau gagal, toast errornya kelihatan (perilaku lama tombol dev, sekarang milik semua orang). |
| 2 | **Toast kalau otomatis gagal berkali-kali** | Di `memorize()` catch: setelah gagal ke-2 (dan maks 1×/30 menit, `memWarnAt`) tampil "Memori belum tersimpan, akan dicoba lagi otomatis. Bisa dipaksa lewat 'Ringkas sekarang' di Kotak memori." — kegagalan tidak lagi tanpa gejala. |
| 3 | **Tulis memori manual** (lihat §2) | jalan keluar kalau ringkasan otomatis membandel: user tulis sendiri. |

---

## 2. Tulis memori manual (user biasa juga bisa)

- **Tombol "Tulis memori"** ada di dua tempat: **Kotak memori** (panel Detail karakter, per karakter)
  dan di **menu Memori** (per grup karakter). Tidak ada lagi syarat Mode dev.
- Form modal (`#mwmodal`): judul (maks 40) + isi (maks 500, counter `x/500`).
- Disimpan ke `mem:<id>` dengan bentuk SAMA seperti ringkasan otomatis:
  `{id,title,body,ts,n:0,mn:1}` — jadi **ikut terkirim ke AI** sebagai ingatan (`memUse()`), ikut
  sinkron akun & impor file (tanda `mn` ikut divalidasi di `cleanMemEntry`).
- Di UI ditandai **"ditulis tangan"** pada baris tanggal (pengganti label "belum dipakai").
- `writeMemEntry()` (index.html): rapikan teks sama seperti server (buang kontrol/`<>`, pangkas 40/500),
  tolak judul/isi kosong, cek penyimpanan penuh lewat baca-ulang seperti `saveMem`.

## 3. Pesan disematkan (pin message)

Untuk nyimpen pesan penting AI — contoh pemakaian: silsilah keluarga di RPG, janji, info penting.

- **Penyimpanan: `pin:<id>`** (per karakter, terpisah dari `log:`). Maks **100 pin/karakter** (`PIN_MAX`).
  Bentuk entri: `{t (waktu pesan asal), r ('me'|'them'|'vn'|'scene'), x (teks, ≤8000), ts (waktu sematkan),
  jp/lang (khusus voice note)}`.
- **Sifat "salinan"**: pin TETAP ada walau pesannya dihapus (`removeEntries`) atau seluruh obrolan
  dihapus (`wipeChat`) — memang disimpan terpisah. Tombstone hapus tidak membuang pin di perangkat lain.
- **Cara sematkan:**
  - Desktop: klik kanan pesan → **Sematkan** / **Lepas sematan** (item pertama menu pesan).
  - HP: tekan lama → Mode seleksi → pilih pesan → tombol **Sematkan** di bilah seleksi (bisa banyak sekaligus).
- **Tanda di layar:** gelembung pesan tersemat diberi kelas `.pinned` → kotak kecil di pojok kanan atas
  (CSS `.row.pinned>.bub::after` / `.vcol>.bub:first-child::after`). Dipasang ulang tiap chat dibuka
  (`markPinRows()` di `restoreChat`).
- **Pembuka daftar:** tombol pin baru di header chat (`#pinbtn`, antara Cari dan Ekspor) + lencana jumlah
  (`#pinn`, merah). Di HP tombolnya masuk menu titik-tiga (`shell.js` `ITEMS`: "Pesan disematkan",
  `shell.css` hide-list). Modal `#pnmodal`: daftar pin terbaru di atas, tiap entri ada **Salin** dan
  **Lepas sematan** (tap dua kali, pola `memArm`).
- **Sinkron akun & impor:** `pin:` ikut discan `collectChars()` (field `pin` per karakter), digabung di
  `applyImport()` per pesan asal (`t`), salinan yang paling baru (`ts` terbesar) menang, dibatasi
  `PIN_MAX`. `cleanPinEntry()` memvalidasi file impor. `hasLocalData()` mengenali `pin:`
  (proteksi kepemilikan data antar akun). Keluar akun → `wipeLocal()` menghapus semua localStorage — pin ikut.

---

## 4. File yang berubah

| File | Isi |
|---|---|
| `public/index.html` | tombol header + badge, modal `#pnmodal` + `#mwmodal`, CSS, tombol ctxmenu/selbar, inti pin (`loadPin/savePin/pinAdd/pinRemove/markPinRows/pinPaint/renderPin`), `writeMemEntry` + `openMw/closeMw/mwSave`, toast kegagalan memori, tombol Tulis memori + Ringkas sekarang tanpa gerbang dev, Escape handler, sinkron (`collectChars`/`applyImport`/pesan impor), `hasLocalData` |
| `public/shell.css` | hanya 1 baris: `#pinbtn` masuk daftar sembunyi HP (menu titik-tiga). (CSS `#pinn`, `.row.pinned`, `#selpin`, form `#mwin/#mwbody` ada di `<style>` inline `index.html`, bukan di shell.css) |
| `public/shell.js` | item "Pesan disematkan" di menu titik-tiga HP |
| `scripts/pin-mem-test.mjs` | uji logika (35 asersi): tulis memori, mn, pin tambah/hapus/batas, cleanPinEntry, gabungan sinkron, scan kunci, gerbang dev hilang |

Server (`lib/*`, `api/*`), karakter, dan **catur tidak disentuh sama sekali**.
