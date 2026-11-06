# neyhra chat

## Jalan lokal

    npm install
    cp .env.example .env   # isi FISH_API_KEY
    npm start              # butuh Node >= 20.6 (jalan lokal lewat dev.js)

## Voice

- Diatur di **menu utama** (tombol "Voice mati/nyala"): nyalakan/matikan, bahasa voice (Indonesia/Jepang), subtitle.
- Menyalakan voice butuh kode (default `NANDAxFURINA`, bisa diganti lewat env `VOICE_CODE`). Tanpa login/session, kode disimpan di browser.
- Tiap balasan dibuat 3 bagian: `<id>` (chat), `<jp>` (subtitle Jepang), `<vn>` (teks voice note + tag ekspresi seperti `[laughing]`, `[sad]`, `[whisper]`, `(break)`).
- Ganti bahasa/nyalakan voice => sesi ChatGPT baru otomatis, riwayat tetap ikut.

### Banyak voice per karakter

`voiceId` di `char/<nama>.js` boleh satu string (seperti biasa) atau banyak:

    voiceId: [
      { label: 'Normal', id: 'abc123...' },
      { label: 'Manja',  id: 'def456...' }
    ]
    // atau cukup array string: ['abc123...', 'def456...']  -> label otomatis "Voice 1", "Voice 2"

Kalau ada lebih dari satu, di header chat muncul tombol titik tiga untuk memilih suara (disimpan per karakter di browser). Pilihan ini juga dipakai tombol "kirim ulang" voice note.
voiceId asli **tidak pernah dikirim ke browser**: yang keluar cuma `label` dan `key` (hash satu arah), server yang menerjemahkan `key` jadi voiceId saat memanggil Fish Audio.

## Indikator online

Pill "N online" di menu utama. Browser kirim heartbeat ke `/api/online` tiap 60 detik (hanya saat tab kelihatan); dianggap online kalau heartbeat terakhir < 150 detik.

- **Lokal**: jalan otomatis (hitung di memori).
- **Vercel**: serverless tidak punya memori bersama, jadi butuh Redis. Di dashboard Vercel: *Storage -> Marketplace -> Upstash Redis* (ada paket gratis), connect ke project, lalu redeploy. Env `UPSTASH_REDIS_REST_URL/TOKEN` (atau `KV_REST_API_URL/TOKEN`) terisi sendiri. Tanpa itu, indikatornya otomatis tidak ditampilkan dan sisanya tetap jalan normal.

## Deploy ke Vercel

1. Push folder ini ke GitHub, import di Vercel (framework: Other).
2. Isi Environment Variables: `FISH_API_KEY`, `FISH_MODEL` (opsional), `VOICE_CODE` (opsional), dan (opsional, untuk indikator online) integrasi Upstash Redis.
3. Deploy. `/api/*` jalan lewat `api/index.js`, halaman statis dari `public/`.

Server stateless: riwayat chat, nama, dan pengaturan disimpan di localStorage browser.

## Lainnya

- Taruh `reze.jpg` dll di `public/assets/`.
- Karakter baru: buat `char/<nama>.js` (lihat `char/reze.js`). Field wajib: `id`, `name`, `voiceId`, `prompt`. Opsional: `tagline`, `avatar`, `pronounce`.
