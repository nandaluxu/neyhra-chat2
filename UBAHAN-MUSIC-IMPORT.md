# UBAHAN-MUSIC-IMPORT — Import lagu lewat link YouTube + tersimpan PERMANEN di data server

Delta ini menambah dua hal yang diminta ke fitur Musik:

1. **Ambil lagu langsung lewat link YouTube.** Tempel link apa pun (`youtube.com/watch?v=…`,
   `youtu.be/…`, `/shorts/…`, `/live/…`, `/embed/…`, `music.youtube.com`, dengan/tanpa `https://`)
   di kolom cari tab Musik → bukan pencarian, tapi **import**: server mengambil judul, artis, durasi,
   dan sampul lagu itu, lalu **mengunduh file audionya ke data server (Pterodactyl) secara permanen**.
2. **Hasil import permanen di data server.** File tersimpan di folder library khusus (`music/`, env
   `LIB_DIR`) yang **tidak pernah dibersihkan** oleh pembersih TTL cache (cache lama hangus ±1 hari;
   library selamanya, bertahan restart panel). Lagu tersimpan muncul di seksi baru **“Lagu tersimpan
   di server”** di beranda tab Musik, bisa diputar kapan pun tanpa unduh ulang, dan bisa dihapus.

Dasar perubahan: `server (1).zip` (server audio Ptero milikmu) di-upgrade ke **v1.3**; repo ini
(Vercel + frontend) menambah endpoint dan UI untuk memakainya.

---

## A. Arsitektur

```
Browser                       Vercel (lib/music.js)            Server Ptero (server.js v1.3)
  | tempel link, Enter
  |--> /api/music/import?id= -->  validasi link (ytId)
  |                               proxy /save?id=  ---------->  /save: metadata (yt-dlp ->
  |                                                            nexray -> minimum) tulis <id>.json,
  |                                                            lalu unduh file DI LATAR
  | <-- {ok, ready:false, song} <--------------------------------  (tidak menunggu unduhan)
  |    kartu import "Mengunduh…"
  |--> /api/music/library  ---->  proxy /library  ----------->  daftar + status unduhan
  | <-- (poll tiap 4 dtk)                                            (selesai -> status 'ok')
  |    kartu jadi "Tersimpan permanen"
  |
  | klik Putar
  |--> /api/music/stream?id= -->  proxy /prefetch  ------------>  file library? -> instan
  | <-- {url:/api/music/audio}                                  (belum ada? -> tunggu job unduhan)
  |--> /api/music/audio  ------>  proxy (Range)  ------------->  /audio: PERMANEN dulu, baru cache
```

- **Urutan penyajian `/audio` di Ptero: library permanen → cache → unduh baru.** Lagu yang pernah
  diimpor selalu instan dan tidak pernah re-resolve.
- **Unduhan di latar + job tunggal per lagu** (`libJobs`, dedupe): `/save`, `/audio`, `/library`,
  dan pemulihan restart memakai job yang sama — tidak ada unduhan dobel. `/save` hanya menunggu
  metadata (detik), bukan unduhan, jadi tidak kena timeout fungsi Vercel (±60 dtk).
- **Pemulihan otomatis**: panel restart di tengah unduhan → entri `downloading` dilanjutkan lagi
  saat start server, saat `/library` dipanggil (entri > 2 menit tanpa job), atau saat lagu diputar.
- **Kuota disk**: `LIB_MAX_MB` (default 2048). Unduhan yang membuat total lewat kuota langsung
  dibuang + ditandai `error` (bisa dihapus / dicoba lagi). `/save` juga menolak (507) kalau kuota
  sudah penuh sebelum unduh.
- **Hemat unduhan**: file cache yang masih segar cukup **disalin** ke library (tidak unduh ulang).

## B. Perubahan kode

| File | Status | Isi |
|---|---|---|
| `download/server-audio-v1.3/server.js` (zip) | **baru (server Ptero)** | v1.3: `LIB_DIR`/`LIB_MAX_MB`, helper library (`findLib`/`readMeta`/`writeMeta`/`libSongs`/`libTotal`/`shapeSong`), `bestMeta` (yt-dlp → nexray → minimum), `ensureLibFile` (rantai provider + salin-dari-cache + kuota), `kickLib` (job latar + pemulihan + kuota pasca-unduh). Endpoint baru `/save`, `/library`, `/remove`; `/audio` & `/prefetch` memprioritaskan library; `/version` & `/health` melaporkan library; `runYtDlp`/`runNexray` menerima tujuan file; pembersih TTL dijaga agar tak pernah menyentuh `LIB_DIR` (dan menolak start kalau `CACHE_DIR` = `LIB_DIR`). |
| `lib/music.js` | berubah | `ytId()` (parser link YouTube, diekspor). Endpoint baru: `/api/music/import` (proxy `/save`, timeout 55 dtk, balasan 504 `ptero_lambat` kalau Ptero lambat — impor tetap jalan di latar), `/api/music/library` (proxy `/library`), `/api/music/library/remove` (proxy `/remove`). Semua rate-limit per clientId (10–30/menit) dan 501 `butuh_ptero` kalau `MUSIC_PTERO_URL` belum diset. |
| `public/music.js` | berubah | `ytLink()` (salinan parser untuk kolom cari; ID polos sengaja TIDAK dianggap link biar judul pencarian tidak salah tangkap). `doImport`/`impCard`/`pollImp`: kartu import (mengambil → mengunduh → tersimpan permanen → Putar/Antrean/Coba lagi). Seksi beranda `srvSecHtml` “Lagu tersimpan di server” (badge PERMANEN di kartu) + `loadSrv` (cache 1 menit, sembunyi otomatis kalau Ptero belum diset) + halaman `renderSrvPage` (baris ala playlist, status unduhan/ukuran, hapus ketuk-2x `rmSrv`) + integrasi `openPage`/`pageSongs`/`paintHome`/`paintPage`. Placeholder kolom cari disebut "link YouTube". |
| `public/music.css` | berubah | Gaya `.mu-impc` (kartu import: mini player status, tombol Putar/Antrean, hint), `.pin` (badge PERMANEN di kartu), `.mu-tr .rm.arm` (tombol hapus merah saat dikokang). |
| `scripts/music-import-test.mjs` | baru | 51 tes: server Ptero v1.3 end-to-end dengan yt-dlp TIRUAN (import, idempoten, /library, Range, kuota, salin-cache, pemulihan terputus via /audio dan /library, remove, auth) + router Vercel dengan Ptero tiruan (parser, import, library, remove, 501 tanpa Ptero) + parser `ytLink` frontend (diekstrak dari sumber asli). |
| `scripts/music-ui-server.mjs`, `scripts/music-ui-test.mjs` | baru | Uji UI Playwright dengan `public/music.js` ASLI: beranda + seksi server + badge, import link (kartu mengunduh → permanen), putar, pencarian biasa tetap jalan, halaman “Lihat semua”, hapus ketuk-2x, putar dari daftar. 25 tes. |
| `package.json` | berubah | Script `music:test` dan `music:ui`. |
| `README-MUSIK.md` | berubah | Bagian baru “Import link YouTube & lagu permanen” (cara pakai, env, endpoint). |

Perilaku lama yang tidak berubah: pencarian, streaming non-import (jalur proxy potongan 1 MB /
Ptero), pemanasan prefetch 2 lagu, lirik, playlist lokal, antrean, dan seluruh UI pemutar.

## C. Env

**Vercel** — tidak ada env baru; yang dipakai sudah ada: `MUSIC_PTERO_URL`, `MUSIC_PTERO_KEY`
(wajib untuk import; tanpa itu endpoint balas 501 dan seksi server disembunyikan).

**Server Ptero (server.js v1.3)** — tambahan opsional:

| Env | Default | Keterangan |
|---|---|---|
| `LIB_DIR` | `./music` (di sebelah server.js) | Folder library permanen. Pastikan di dalam data server (mis. `/home/container/music`) supaya bertahan, JANGAN di folder ephemeral. |
| `LIB_MAX_MB` | `2048` | Kuota total isi library. Unduhan yang melebihi kuota dibuang + entri ditandai error. |

Env lama (`API_KEY`, `PUBLIC_URL`, `CACHE_DIR`, `CACHE_TTL_MIN`, `MAX_MB`, `MAX_PARALLEL`,
`YT_COOKIES_FILE`, `NEXRAY_*`, `PROVIDER_ORDER`, `YTDL_UPDATE_HOURS`, dst.) tidak berubah.

## D. Cara pasang

1. **Ptero**: upload isi `server-audio-v1.3.zip` (timpa `server.js`; `package.json` tak berubah —
   tetap cuma `express`). Set env baru kalau mau (`LIB_DIR`, `LIB_MAX_MB`), lalu **reinstall/start**.
   Cek: `GET /version` (dengan `x-api-key`) → bagian `library` muncul.
2. **Vercel**: pastikan `MUSIC_PTERO_URL` + `MUSIC_PTERO_KEY` terpasang (sudah ada dari setup musik
   Ptero sebelumnya), lalu deploy repo ini.
3. **Pakai**: buka tab Musik (Mode dev) → tempel link YouTube di kolom cari → Enter. Kartu import
   muncul → tunggu “Tersimpan permanen” → Putar. Lagu juga muncul di seksi “Lagu tersimpan di
   server” di beranda; “Lihat semua” untuk hapus.

## E. Tes (semua lulus, 24 Nov 2026)

| Suite | Cakupan | Hasil |
|---|---|---|
| `npm run music:test` | 51 tes lihat bagian B | **51 lulus, 0 gagal** |
| `npm run music:ui` | 25 tes UI Playwright lihat bagian B | **25 lulus, 0 gagal** |
| `node --check` | `lib/music.js`, `public/music.js`, `server.js` v1.3 | lolos |

## F. Catatan jujur

- **Keamanan hapus/list**: `/api/music/library/remove` mengikuti pola endpoint musik lainnya —
  tanpa login, hanya rate-limit 10/menit per clientId. Untuk app pribadi (fitur musik sendiri
  sudah pagar Mode dev di klien) cukup; kalau mau lebih ketat, tambah cek token admin nanti.
- Metadata artis dari nexray fallback kosong (nexray hanya memberi judul+durasi); dari yt-dlp
  berupa nama channel. Judul lagu asli biasanya sudah memuat nama artis.
- File library berformat m4a (yt-dlp, kualitas 128k) atau mp3 (fallback nexray, ±64k) — sama
  seperti jalur putar biasa.
- `MUSIC_DIRECT=1` (mode lokal) tidak relevan untuk import — import selalu lewat Ptero.
