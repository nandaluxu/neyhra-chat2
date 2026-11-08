import express from 'express'
import crypto from 'node:crypto'
import { chatgpt, getSession } from './chatgpt.js'
import { loadChars } from './chars.js'
import { traitOf } from './sessions.js'
import { bearerUser, allow } from './auth.js'
import { r2Enabled, r2Put, r2PublicUrl } from './r2.js'

/* ===== Scene Capture: AI mengilustrasikan adegan percakapan =====
   Alur (satu endpoint POST /api/scene/capture, semuanya di server):
     1. client (public/scene.js) memanggil setelah balasan AI tampil (mode auto) atau dari menu "+" (mode manual).
        Mode manual berupa LAMPIRAN di kotak ketik (pola hadiah): klik "Scene Capture" memasang chip,
        user boleh mengetik prompt sendiri di kotak ketik; saat dikirim, ketikan itu jadi prompt ilustrasi.
     2. AI penilai (sesi anon ChatGPT, pola genAuth di lib/scenario.js) membaca konteks percakapan lalu memutuskan:
        mode auto  -> boleh ditolak ("adegan tidak cukup visual / mirip scene terakhir") -> {ok:true, skipped:true}
        mode manual -> prompt user diisi -> dipakai langsung TANPA AI penilai; prompt kosong -> AI menyusun prompt
        Output AI: satu JSON {"relevan":bool,"prompt":"<English image prompt>"}.
     3. Prompt dikirim ke provider image-to-image bersama refImg karakter (referensi visual: wajah/rambut/gaya
        harus tetap sama). Provider = adapter (PROVIDERS di bawah); sekarang ada "nano", ganti/tambah lewat
        SCENE_PROVIDER tanpa menyentuh kode lain.
     4. Hasil (URL sementara dari provider) disalin ke Cloudflare R2 kalau env R2 lengkap -> URL publik permanen
        (pola yang sama dengan foto profil); kalau R2 tidak aktif, URL provider dipakai apa adanya.
     5. Client menampilkan hasil sebagai lampiran gambar di percakapan (pola lampiran Gift: tanpa overlay).
   Client TIDAK pernah menerima refImg, nama provider, atau konfigurasi apa pun — hanya {ok, url, prompt, at}.

   Env (semua opsional, default sudah jalan):
     SCENE_ENABLED   = '0' untuk mematikan fitur total (default: aktif)
     SCENE_PROVIDER  = 'nano' (satu-satunya sekarang; adapter baru tinggal didaftarkan di PROVIDERS)
     SCENE_BASE_URL  = alamat API provider (default: nano)
     SCENE_TIMEOUT_MS = batas polling gambar (default 45000; Vercel maxDuration 60s, sisakan waktu untuk AI penilai)

   Provider "nano" juga menyediakan textToImage / removeBg / upscale / getMasterData (lihat KODE LAINNYA) —
   disiapkan untuk tools berikutnya; saat ini hanya image-to-image yang dipakai Scene Capture. */

const DEF_TIMEOUT = Number(process.env.SCENE_TIMEOUT_MS) || 48000 // job image-to-image nyata bisa ±50 detik; Vercel maxDuration 60 sisakan untuk AI penilai
const enabled = () => process.env.SCENE_ENABLED !== '0'
const AVATAR_BASE = process.env.AVATAR_BASE || 'https://raw.githubusercontent.com/nandaluxu/neyhra-chat2/refs/heads/main/assets'

// refImg karakter: URL http(s) penuh, atau path '/assets/<id>.jpg' -> diselesaikan ke AVATAR_BASE
export const refImgOf = c => {
  const r = String(c?.refImg || '').trim()
  if (/^https?:\/\/\S+$/.test(r)) return r
  if (/^\/assets\/[\w.-]+$/.test(r)) return AVATAR_BASE + r
  return ''
}

/* ---------- Provider adapter: nano (image-to-image) ----------
   Antarmuka provider: async { imageToImage(refUrl, prompt, opts) -> { url } }. Semua detail HTTP ada di sini;
   sisanya (validasi, AI, R2) tidak tahu provider apa yang dipakai. */
const UA = 'okhttp/4.12.0'

const toBlob = async input => {
  if (typeof input === 'string') {
    let res = await fetch(input)
    const ct = res.headers.get('content-type') || ''
    if (ct.includes('text/html')) {
      const html = await res.text()
      const m = html.match(/<img[^>]+id=["']img_preview["'][^>]+src=["']([^"']+)["']/i) ||
        html.match(/<a[^>]+class=["']download["'][^>]+href=["']([^"']+)["']/i)
      if (m) res = await fetch(m[1])
    }
    return await res.blob()
  }
  if (input instanceof Blob) return input
  return new Blob([input])
}

const nano = () => ({
  base: String(process.env.SCENE_BASE_URL || 'https://api2.ashirwadinfotech.com:22993'),
  async createDevice() {
    const id = crypto.randomBytes(8).toString('hex')
    const form = new FormData()
    form.append('android_id', id); form.append('app_id', 'dalle2-bhargav'); form.append('in_app', ''); form.append('in_app_sku', '')
    form.append('app_version', '20'); form.append('package_name', 'com.bhargav.nanobananaai'); form.append('is_premium', 'false')
    form.append('fcm_token', ''); form.append('country_code', 'US')
    const res = await fetch(this.base + '/api/image/android-app-config/', { method: 'POST', headers: { 'User-Agent': UA }, body: form })
    if (!res.ok) throw new Error('Device initialization failed')
    return id
  },
  async poll(jobId, timeoutMs) {
    const start = Date.now(), url = this.base + '/api/image/image-generator/' + jobId + '/'
    while (Date.now() - start < timeoutMs) {
      await new Promise(r => setTimeout(r, 1800))
      const res = await fetch(url, { headers: { 'User-Agent': UA } })
      const data = await res.json().catch(() => ({}))
      if (data.status === 'COMPLETED') return data.output
      if (data.status === 'FAILED') throw new Error(data.error || 'Generation failed')
    }
    throw new Error('Polling timeout')
  },
  async run({ refUrl, prompt, timeoutMs, processType = 'image_to_image', trendName = 'Image To Image' }) {
    const imageBlob = await toBlob(refUrl)
    const androidId = await this.createDevice()
    const form = new FormData()
    form.append('image', imageBlob, 'input.png')
    form.append('prompt', prompt)
    form.append('app_id', 'dalle2-bhargav'); form.append('android_id', androidId); form.append('is_premium', 'false')
    form.append('app_version', '20'); form.append('process_type', processType); form.append('image_style', '')
    form.append('aspect_ratio', 'square'); form.append('scale', '12'); form.append('steps', '20'); form.append('enhance', 'false')
    form.append('baby_gender', ''); form.append('baby_age', ''); form.append('cloth_type', ''); form.append('room_style', '')
    form.append('interior_style', ''); form.append('color_palette', ''); form.append('is_ref_image', 'true')
    form.append('name', ''); form.append('accessories', ''); form.append('country_code', 'US')
    form.append('trend_name', trendName); form.append('use_queue', 'true')
    const res = await fetch(this.base + '/api/image/image-generator/', { method: 'POST', headers: { 'User-Agent': UA }, body: form })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error?.[0] || data.output?.[0] || 'Request failed')
    const out = await this.poll(data.job_id, timeoutMs)
    const url = Array.isArray(out) ? out[0] : out
    if (!url || !/^https?:\/\//.test(String(url))) throw new Error('Provider tidak mengembalikan gambar')
    return { url: String(url), jobId: data.job_id }
  },
  /* KODE LAINNYA (belum dipakai endpoint mana pun; ruang untuk tools berikutnya — jangan dihapus):
     textToImage(prompt, opts)  : run({ prompt, processType:'text_to_image', ... }) tanpa image
     removeBg(image, opts)      : run({ refUrl:image, processType:'remove_bg', trendName:'Remove Background', ... })
     upscale(image, scale, opts): run({ refUrl:image, processType:'image_upscale', trendName:'Image Enhance', ... }) */
  async textToImage(prompt, opts = {}) {
    const androidId = await this.createDevice()
    const form = new FormData()
    form.append('prompt', prompt); form.append('app_id', 'dalle2-bhargav'); form.append('android_id', androidId)
    form.append('is_premium', 'false'); form.append('app_version', '20'); form.append('process_type', 'text_to_image')
    form.append('image_style', opts.style || ''); form.append('aspect_ratio', opts.aspectRatio || 'square')
    form.append('scale', String(opts.scale || 12)); form.append('steps', String(opts.steps || 20)); form.append('enhance', 'false')
    form.append('is_ref_image', 'false'); form.append('country_code', 'US'); form.append('trend_name', opts.trendName || 'text_to_image')
    form.append('use_queue', 'true')
    const res = await fetch(this.base + '/api/image/image-generator/', { method: 'POST', headers: { 'User-Agent': UA }, body: form })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error?.[0] || 'Request failed')
    const out = await this.poll(data.job_id, opts.timeoutMs || DEF_TIMEOUT)
    const url = Array.isArray(out) ? out[0] : out
    if (!url || !/^https?:\/\//.test(String(url))) throw new Error('Provider tidak mengembalikan gambar')
    return { url: String(url) }
  }
})

const PROVIDERS = { nano }

/* ---------- AI penilai + penyusun prompt (pola genAuth lib/scenario.js) ---------- */
const TTL = 50 * 60 * 1000
const judgeAuth = new Map()
async function judgeAuthFor(userId, fresh) {
  let e = judgeAuth.get(userId)
  if (fresh || !e || Date.now() - e.startedAt > TTL) { e = { base: await getSession(), startedAt: Date.now() }; judgeAuth.set(userId, e) }
  e.seen = Date.now()
  return { ...e.base }
}
setInterval(() => { for (const [k, e] of judgeAuth) if (Date.now() - e.seen > 12 * 3600 * 1000) judgeAuth.delete(k) }, 3600 * 1000).unref()

const cleanLine = (t, n) => String(t ?? '').replace(/[\u0000-\u001f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n)

function judgePrompt({ char, user, history, reply, lastScene, manual }) {
  const hist = history.slice(-8).map(([r, t]) => `${r === 'user' ? (user || 'User') : char.name}: ${String(t).slice(0, 160)}`).join('\n')
  return `Kamu penilai adegan sekaligus penulis prompt ilustrasi untuk fitur "Scene Capture" di aplikasi chat. Tugasmu ${manual ? 'MENYUSUN PROMPT ILUSTRASI dari adegan percakapan terbaru (user sendiri yang meminta ilustrasinya, jadi "relevan" SELALU true)' : 'MENILAI apakah adegan terbaru layak divisualisasikan, lalu kalau layak menyusun promptnya'}.

KONTEKS:
- Karakter: ${char.name}${char.tagline ? ' - ' + cleanLine(char.tagline, 100) : ''}
- Kepribadian: ${traitOf(char)}
- User (pemain): ${user || 'User'}
${lastScene ? `- Ilustrasi TERAKHIR yang sudah dibuat (${lastScene.mins} menit lalu): "${lastScene.prompt}". Kalau adegan sekarang masih hampir sama dengan itu, JANGAN buat lagi.\n` : ''}PERCAKAPAN TERAKHIR:
${hist || '(belum ada)'}

BALASAN TERBARU KARAKTER:
${String(reply || '').slice(0, 800)}
${manual ? '' : `
Kapan LAYAK (relevan=true): ada adegan visual yang kuat — aktivitas/aksi yang jelas, ekspresi atau emosi kuat, pakaian/pose/suasana yang khas, momen penting cerita.
Kapan TIDAK LAYAK (relevan=false): obrolan biasa/tanya-jawab datar, adegan hampir sama dengan ilustrasi terakhir, tidak ada elemen visual yang berarti. Jangan memaksakan gambar kalau tidak ada alasannya.`}

Membuat prompt (kalau relevan): prompt BAHASA INGGRIS untuk model image-to-image. Gambar referensi karakter sudah dilampirkan otomatis — PERTAHANKAN identitas visualnya persis (wajah, warna rambut, gaya gambar). Tuliskan: gaya ilustrasi anime yang konsisten dengan referensi, ekspresi karakter, pakaian, pose, latar/lingkungan, pencahayaan, dan suasana adegan dari percakapan. SATU paragraf padat 40-80 kata, tanpa teks/tulisan di dalam gambar, tanpa menyebut "reference image".

Balas HANYA SATU objek JSON valid (tanpa teks lain): {"relevan":true,"prompt":"..."} atau {"relevan":false}`
}

function parseJudge(raw) {
  const t = String(raw || '').replace(/```[a-z]*\n?/gi, ' ')
  const s = t.indexOf('{'), e = t.lastIndexOf('}')
  if (s < 0 || e <= s) return null
  try {
    const o = JSON.parse(t.slice(s, e + 1))
    return { ok: o.relevan === true, prompt: cleanLine(o.prompt, 600) }
  } catch { return null }
}

/* ---------- R2: salin hasil provider supaya URL-nya permanen (pola foto profil) ---------- */
async function persist(url) {
  if (!r2Enabled()) return url
  try {
    const res = await fetch(url)
    if (!res.ok) throw new Error('HTTP ' + res.status)
    const ct = res.headers.get('content-type') || ''
    if (!/^(image\/(jpeg|png|webp))/.test(ct)) throw new Error('bukan gambar: ' + ct)
    const buf = Buffer.from(await res.arrayBuffer())
    if (!buf.length || buf.length > 4 * 1024 * 1024) throw new Error('ukuran tidak wajar')
    const ext = ct.includes('png') ? 'png' : ct.includes('webp') ? 'webp' : 'jpg'
    const key = 'scene/' + crypto.randomBytes(12).toString('hex') + '.' + ext
    await r2Put(key, buf, ct)
    return r2PublicUrl(key)
  } catch (e) {
    console.error('[scene:r2] pakai URL provider:', e.message)
    return url // R2 gagal -> URL provider tetap dipakai (gambar masih tampil, hanya mungkin tidak permanen)
  }
}

/* ===== Router ===== */
const router = express.Router()

router.post('/api/scene/capture', async (req, res) => {
  try {
    if (!enabled()) return res.status(503).json({ error: 'Scene Capture tidak aktif di server ini.' })
    const a = await bearerUser(req)
    if (!a) return res.status(401).json({ error: 'Masuk dulu untuk memakai Scene Capture.' })
    const b = req.body || {}
    const manual = b.mode === 'manual'
    // prompt manual dari ketikan user (hanya mode manual): diisi -> dipakai langsung tanpa AI penilai
    const manualPrompt = manual ? cleanLine(b.prompt, 600) : ''
    if (!(await allow((manual ? 'scnman:' : 'scnau:') + a.user._id, manual ? 12 : 6, 3600)))
      return res.status(429).json({ error: 'Terlalu sering membuat ilustrasi, tunggu sebentar.' })

    const c = (await loadChars()).find(x => x.id === String(b.char || '').slice(0, 64))
    if (!c) return res.status(400).json({ error: 'Karakter tidak dikenal.' })
    const refImg = refImgOf(c)
    if (!refImg) return res.status(400).json({ error: 'Karakter ini belum bisa diilustrasikan (tidak ada gambar referensi).' })

    // riwayat dari client (data tak tepercaya -> dibersihkan, pola cleanHistory di lib/app.js)
    const history = (Array.isArray(b.history) ? b.history : []).slice(-24)
      .map(x => Array.isArray(x) && x[1] ? [x[0] === 'user' ? 'user' : 'char', cleanLine(x[1], 600)] : null)
      .filter(Boolean)
    // ilustrasi terakhir (untuk menghindari adegan nyaris sama) — dikirim client dari riwayat lokalnya
    let lastScene = null
    if (b.lastScene && typeof b.lastScene === 'object') {
      const p = cleanLine(b.lastScene.prompt, 600), mins = Math.round(Number(b.lastScene.mins))
      if (p && Number.isFinite(mins) && mins >= 0 && mins < 1440) lastScene = { prompt: p, mins }
    }

    // 1) prompt manual terisi -> pakai langsung; kosong -> AI menilai + menyusun prompt dari konteks
    const ask = async prompt => {
      for (let fresh = false; ; fresh = true) {
        try { return await chatgpt(prompt, await judgeAuthFor(a.user._id, fresh), null) }
        catch (e) { if (fresh) throw e }
      }
    }
    let judge
    if (manualPrompt) {
      judge = { ok: true, prompt: manualPrompt } /* prompt dari user sendiri: hormati pilihan user */
    } else {
      try {
        let r = await ask(judgePrompt({ char: c, user: cleanLine(b.userName, 24), history, reply: b.reply, lastScene, manual }))
        judge = parseJudge(r.response)
        if (!judge) {
          r = await chatgpt('Formatmu salah. Ulangi jawabanmu HANYA berupa satu objek JSON valid: {"relevan":true,"prompt":"<English image prompt>"} atau {"relevan":false}.', r.auth, r.chatId)
          judge = parseJudge(r.response)
        }
      } catch (e) {
        console.error('[scene:judge]', e.message)
        return res.status(502).json({ error: 'AI gagal menilai adegan, coba lagi.' })
      }
      if (!judge) return res.status(502).json({ error: 'AI belum bisa menyusun prompt, coba lagi.' })
    }
    if (!judge.ok || !judge.prompt) return res.json({ ok: true, skipped: true })

    // 2) provider image-to-image (refImg = referensi visual karakter)
    const name = process.env.SCENE_PROVIDER || 'nano'
    const prov = (PROVIDERS[name] || nano)()
    let out
    try { out = await prov.run({ refUrl: refImg, prompt: judge.prompt, timeoutMs: DEF_TIMEOUT }) }
    catch (e) {
      console.error('[scene:provider]', e.message)
      // filter provider sering false-positive untuk gambar anime: kasih pesan yang bisa dimengerti user
      if (/nsfw/i.test(String(e.message))) return res.status(502).json({ error: 'Gambar referensi karakter ini ditolak filter provider (sering keliru untuk gambar anime). Coba lagi, ganti refImg karakter, atau pakai karakter lain.' })
      return res.status(502).json({ error: 'Gagal membuat gambar, coba lagi sebentar.' })
    }

    // 3) simpan permanen kalau R2 aktif, lalu jawab
    res.json({ ok: true, url: await persist(out.url), prompt: judge.prompt, at: Date.now() })
  } catch (e) {
    console.error('scene:', e?.message)
    res.status(500).json({ error: 'Terjadi kesalahan di server.' })
  }
})

export const sceneRouter = router
