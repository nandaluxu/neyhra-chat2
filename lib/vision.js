import express from 'express'
import { loadChars } from './chars.js'
import { allow } from './auth.js'
import { chat as deepChat } from './deepchat.js'

/* ===== Vision: karakter "melihat" gambar yang dikirim user =====
   Khusus karakter dengan field `vision: true` di char/<id>.js (client menyembunyikan menu "Kirim Gambar"
   untuk karakter lain; /api/chars mengirim flag `vision`).

   Alurnya DUA LANGKAH supaya pipeline chat yang ada tidak disentuh:
     1. POST /api/vision  { clientId, char, image }  -> { ok, desc }
        Server memakai DeepChat (gpt-4o-mini multimodal, lib/deepchat.js) untuk mendeskripsikan gambar
        secara faktual dan padat dalam bahasa Indonesia. Body parser 8 MB (dipasang SEBELUM parser global
        50 KB di lib/app.js, pola yang sama dengan lib/auth.js) karena membawa data URL gambar.
     2. Client memanggil /api/chat biasa dengan field tambahan `vision: <desc>`: server menempelkan
        deskripsi ke pesan user (pola kalimat kejadian hadiah di lib/shop.js), lalu balasan karakter
        dibuat seperti biasa — format <id>/<jp>/<vn>, hubungan, memori, skenario, semuanya tetap jalan.

   Gambar TIDAK pernah disimpan di server (hanya lewat ke provider lalu dibuang); yang tersimpan di log
   client hanyalah thumbnail kecil buatan browser + deskripsinya. Pembatas laju per clientId (Mongo);
   kalau Mongo belum dikonfigurasi, pembatasnya dilewati (fitur tetap jalan). */

const router = express.Router()
router.use('/api/vision', express.json({ limit: '8mb' })) // lebih besar dari batas global (50 KB) karena membawa gambar

// deskripsi yang dipakai ulang: faktual, padat, bahasa Indonesia, tanpa basa-basi
const DESCRIBE = `Deskripsikan gambar ini secara faktual dan padat dalam bahasa Indonesia (maksimal 120 kata) untuk diteruskan ke karakter AI: objek atau orang utama, tindakan/pose, pakaian, ekspresi, latar/lingkungan, warna dan suasana, teks yang terlihat kalau ada, serta detail mencolok lain. Jangan mengarang hal yang tidak ada di gambar, jangan memberi penilaian atau saran, dan balas HANYA deskripsinya tanpa kalimat pembuka.`

router.post('/api/vision', async (req, res) => {
  try {
    const b = req.body || {}
    const clientId = String(b.clientId || '').trim().slice(0, 64)
    if (!clientId || !/^[\w-]{8,64}$/.test(clientId)) return res.status(400).json({ error: 'Request tidak valid' })

    const c = (await loadChars()).find(x => x.id === String(b.char || '').slice(0, 64))
    if (!c) return res.status(400).json({ error: 'Karakter tidak dikenal.' })
    if (c.vision !== true) return res.status(403).json({ error: `${c.name} belum bisa melihat gambar.` })

    // gambar: data URL (dari canvas browser) atau base64 mentah; maks ±6 MB setelah decode
    const img = String(b.image || '')
    const b64 = img.replace(/^data:image\/[\w.+-]+;base64,/, '').replace(/\s+/g, '')
    if (!b64 || b64.length > 8_000_000 || b64.length < 64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64.slice(0, 1024)))
      return res.status(400).json({ error: 'Gambar tidak valid atau terlalu besar (maks ±6 MB).' })

    try { // pembatas laju berbasis Mongo; tanpa Mongo (belum diset) fitur tetap jalan
      if (!(await allow('vis:' + clientId, 20, 3600)))
        return res.status(429).json({ error: 'Terlalu sering mengirim gambar, tunggu sebentar.' })
    } catch { /* Mongo tidak aktif -> lewati */ }

    const r = await deepChat(DESCRIBE, { image: img.startsWith('data:') ? img : 'data:image/jpeg;base64,' + b64, timeoutMs: 25000 })
    const desc = String(r.reply || '').replace(/\s+/g, ' ').trim().slice(0, 800)
    if (!desc) return res.status(502).json({ error: 'AI gagal membaca gambar, coba lagi.' })
    res.json({ ok: true, desc })
  } catch (e) {
    console.error('[vision]', e?.message)
    res.status(502).json({ error: 'AI gagal membaca gambar, coba lagi.' })
  }
})

export const visionRouter = router
