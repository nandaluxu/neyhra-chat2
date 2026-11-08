import express from 'express'
import axios from 'axios'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadChars, fixReading } from './chars.js'
import { reply, groupReply, summarize } from './sessions.js'
import { finalize, baseName, stripTags, hasJp, stripLB } from './finalize.js' // perapihan balasan model (dipakai bersama lib/scenario.js)
import { scenarioRouter, scenarioChat } from './scenario.js'
import { sceneRouter, refImgOf } from './scene.js'
import { visionRouter } from './vision.js'
import { getLorkaModels } from './lorka.js'
import { ping } from './online.js'
import { gcRouter } from './gc.js'
import { cleanState, readDeltas, publicConfig } from './relation.js'
import { giftLine } from './shop.js'
import { mongoEnabled, pingMongo } from './mongo.js'
import { authRouter } from './auth.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const PUBLIC = path.join(ROOT, 'public')

const app = express()
app.use(authRouter) // Login: /api/auth/* (lib/auth.js). Dipasang SEBELUM parser global karena body-nya lebih besar (data obrolan).
app.use(visionRouter) // Vision: /api/vision (lib/vision.js). Juga SEBELUM parser global (body membawa gambar data URL ±6 MB).
app.use(express.json({ limit: '50kb' }))
app.use(gcRouter) // Chat Global: /api/gc/sync|send|signal|delete (lihat lib/gc.js)
app.use(scenarioRouter) // Skenario Skrip: /api/scenario/* (lihat lib/scenario.js)
app.use(sceneRouter) // Scene Capture: /api/scene/capture (lihat lib/scene.js)

// MongoDB: cek koneksi saja (tidak menulis). Fitur login/persona nanti menumpang di lib/mongo.js.
app.get('/api/db/health', async (_req, res) => {
  if (!mongoEnabled()) return res.json({ enabled: false })
  try { res.json({ enabled: true, ok: true, ms: await pingMongo() }) }
  catch (e) { res.status(503).json({ enabled: true, ok: false, error: String(e?.message || e).slice(0, 120) }) }
})
// Di Vercel, folder public/ dilayani CDN langsung. Baris ini untuk jalan lokal (dan cadangan kalau request sampai ke sini).
app.use(express.static(PUBLIC, { redirect: false })) // redirect:false supaya /tools (ada foldernya) tidak dialihkan ke /tools/ tapi dijawab index.html
// URL per layar (lihat public/router.js): semua alamat ini menampilkan aplikasi yang sama. Di Vercel ditangani `rewrites` di vercel.json.
app.get(['/chat', '/chat/:id', '/global', '/bonus', '/games', '/shop', '/tools', '/tools/:id', '/profile', '/settings'], (_req, res) => res.sendFile(path.join(PUBLIC, 'index.html')))

// nama user masuk ke prompt -> buang karakter yang bisa merusak format prompt
const cleanName = n => String(n ?? '').replace(/[\u0000-\u001f<>\[\]{}`]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 24)

// riwayat dikirim dari browser (server stateless, cocok untuk Vercel)
const cleanHistory = (h, n = 24) => (Array.isArray(h) ? h : []).slice(-n)
  .map(x => Array.isArray(x) && x[1] ? [x[0] === 'user' ? 'user' : 'char', cleanText(x[1], 600)] : null)
  .filter(Boolean)

// kode untuk menyalakan voice (bisa diganti lewat env VOICE_CODE). Bukan login, cuma pagar supaya kuota TTS tidak dipakai sembarang orang.
const okCode = c => typeof c === 'string' && c.trim().toLowerCase() === (process.env.VOICE_CODE || 'NANDAxFURINA').toLowerCase()

const find = async id => (await loadChars()).find(c => c.id === id)

// ===== Mode grup (lihat design: Kontrak API) =====
const ID_RE = /^[\w-]{1,64}$/
const MAX_MEMBERS = 5, GROUP_HIST = 30
const cleanText = (t, n) => String(t ?? '').replace(/[\u0000-\u001f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n)
// Memori dari client: data tak tepercaya -> dibersihkan sama seperti nama/riwayat. Maks 30 entri dan ±1600 karakter total.
const cleanMemory = m => {
  let left = 1600
  return (Array.isArray(m) ? m : []).slice(0, 30).map(x => {
    const title = cleanText(x?.title, 40).replace(/[\[\]{}`]/g, ' ').replace(/\s+/g, ' ').trim(), body = cleanText(x?.body, 500).replace(/[\[\]{}`]/g, ' ').replace(/\s+/g, ' ').trim()
    return title && body ? { title, body } : null
  }).filter(Boolean).filter(x => (left -= x.title.length + x.body.length + 4) >= 0)
}
const cleanScene = t => cleanText(t, 120).replace(/[\[\]{}`]/g, ' ').replace(/\s+/g, ' ').trim()
const STOP = new Set(['the', 'and', 'dan', 'iff', 'gluttony'])
const nameTokens = n => [...new Set(baseName(n).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(t => t.length >= 3 && !STOP.has(t)))]

// Anggota DIVALIDASI ke char/: id tak dikenal dibuang, maksimal 5. Client tidak bisa menyuruh server memuat prompt sembarang.
function groupContext(all, c, gr, user, history) {
  if (!gr || typeof gr !== 'object') return null
  const ids = [...new Set((Array.isArray(gr.members) ? gr.members : []).filter(i => typeof i === 'string' && ID_RE.test(i)))]
  const members = ids.map(i => all.find(x => x.id === i)).filter(Boolean).slice(0, MAX_MEMBERS)
  if (members.length < 2 || !members.some(m => m.id === c.id)) return null
  const muted = new Set((Array.isArray(gr.muted) ? gr.muted : []).filter(i => typeof i === 'string'))
  const allowed = members.filter(m => !muted.has(m.id)).map(m => m.id) // yang dibisukan tidak boleh ditunjuk lewat <next>
  const nameOf = id => id === 'user' ? (user || 'User') : all.find(x => x.id === id)?.name // pengirim lama yang sudah keluar grup tetap dikenali
  const hist = (Array.isArray(history) ? history : []).slice(-GROUP_HIST)
    .map(x => { const who = Array.isArray(x) && typeof x[0] === 'string' ? nameOf(x[0]) : null; const t = Array.isArray(x) ? cleanText(x[1], 600) : ''; return who && t ? [who, t] : null })
    .filter(Boolean)
  const rt = gr.replyTo, rname = rt && typeof rt.from === 'string' ? all.find(x => x.id === rt.from)?.name : null
  const replyTo = rname && cleanText(rt.text, 600) ? { name: rname, text: cleanText(rt.text, 600) } : null
  return { members, allowed, scene: cleanScene(gr.scene), replyTo, depth: Math.max(0, Math.min(10, parseInt(gr.depth) || 0)), history: hist }
}

// <next> dari model -> id anggota yang boleh bicara, atau null. Id dicocokkan dulu, nama cuma cadangan; ambigu = null.
const NO_NEXT = new Set(['', 'none', 'null', 'no', 'nobody', 'n/a', 'na', '-', '--', 'kosong', 'tidakada', 'tidak', 'nol'])
function resolveNext(raw, members, allowed) {
  const t = String(raw || '').replace(/[<>\[\]{}`"'*@.,;:!?]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase()
  if (NO_NEXT.has(t.replace(/\s/g, ''))) return null
  const pool = members.filter(m => allowed.includes(m.id))
  const byId = pool.find(m => m.id.toLowerCase() === t)
  if (byId) return byId.id
  const hit = pool.filter(m => baseName(m.name).toLowerCase() === t)
  if (hit.length === 1) return hit[0].id
  if (hit.length > 1) return null
  const tok = pool.filter(m => nameTokens(m.name).includes(t))
  return tok.length === 1 ? tok[0].id : null
}

// avatar: <AVATAR_BASE>/<id>.jpg (kalau char punya avatar berupa URL penuh, itu yang dipakai)
const AVATAR_BASE = process.env.AVATAR_BASE || 'https://raw.githubusercontent.com/nandaluxu/neyhra-chat2/refs/heads/main/assets'
// voices: hanya dikirim kalau karakter punya >1 voice, dan hanya { key, label }. voiceId asli TIDAK pernah dikirim ke browser.
// scene: penanda karakter bisa diilustrasikan Scene Capture (punya refImg). URL refImg sendiri TIDAK dikirim ke browser.
// vision: penanda karakter bisa melihat gambar yang dikirim user (field `vision: true` di char/<id>.js).
app.get('/api/chars', async (_, res) =>
  res.json((await loadChars()).map(c => {
    const { id, name, tagline, avatar, voices } = c
    return {
      id, name, tagline, avatar: /^https?:\/\//.test(avatar || '') ? avatar : `${AVATAR_BASE}/${id}.jpg`,
      ...(voices.length > 1 && { voices: voices.map(({ key, label }) => ({ key, label })) }),
      ...(refImgOf(c) && { scene: true }),
      ...(c.vision === true && { vision: true })
    }
  })))

// tabel tahap hubungan + label mood untuk panel profil (satu sumber kebenaran, sama dengan yang dipakai prompt)
app.get('/api/relation', (_, res) => res.json(publicConfig()))

app.post('/api/unlock', (req, res) =>
  okCode(req.body?.code) ? res.json({ ok: true }) : res.status(403).json({ error: 'Kode salah' }))

// Satu panggilan ChatGPT -> id (chat), jp (subtitle), vn (teks voice note + tag ekspresi)
app.post('/api/chat', async (req, res) => {
  const { clientId, char, message, userName, history, voice: v, group: gr, memory, rel: relIn, engine: engIn, rp: rpIn, scenario: scnIn, gift: giftIn, vision: visIn, cont: contIn } = req.body || {}
  const all = await loadChars()
  const c = all.find(x => x.id === char)
  const isGroup = gr != null // tidak ada field `group` = chat 1-lawan-1 seperti biasa
  // cont = tombol "lanjut ngobrol sendiri": pesan user boleh kosong, model diminta melanjutkan sebagai karakternya (lihat lib/sessions.js).
  // Hanya untuk chat 1-lawan-1; di mode grup/skenario diabaikan supaya alur yang ada tidak berubah.
  const cont = contIn === true && !isGroup && typeof scnIn !== 'string'
  // vision = deskripsi gambar dari /api/vision (lib/vision.js): user mengirim gambar ke karakter yang bisa melihatnya.
  // Pesan boleh kosong (gambar tanpa caption). Di mode grup diabaikan (lampiran gambar memang cuma untuk chat 1-lawan-1).
  const vd = !isGroup && typeof visIn === 'string' ? cleanText(visIn, 800) : ''
  if (!c || !clientId || (!isGroup && !cont && !vd && !message?.trim())) return res.status(400).json({ error: 'Request tidak valid' })
  const voice = v?.on ? { on: true, lang: v.lang === 'id' ? 'id' : 'jp' } : { on: false }
  if (isGroup) {
    const user = cleanName(userName), g = groupContext(all, c, gr, user, history)
    if (!g) return res.status(400).json({ error: 'Grup tidak valid' })
    try {
      const out = await groupReply(String(clientId).slice(0, 64), c, { ...g, user, message: cleanText(message, 2000), voice })
      const fin = finalize(out, c, voice, g.members)
      return res.json({ ...fin, next: resolveNext(out.next, g.members, g.allowed) })
    } catch (e) {
      console.error('[chat:grup]', e.response?.status || '', e.message)
      return res.status(e.response?.status === 429 ? 429 : 502).json({ error: e.response?.status === 429 ? 'Terlalu sering, coba lagi sebentar' : 'ChatGPT gagal merespons, coba lagi' })
    }
  }
  // Mesin alternatif (Lorka) HANYA untuk uji dari Mode dev di browser. Tanpa field `engine` = ChatGPT seperti biasa. Nama model divalidasi ketat.
  const engine = engIn?.name === 'lorka' ? { name: 'lorka', model: /^[\w.:\/-]{1,60}$/.test(engIn.model || '') ? engIn.model : undefined } : null
  const rp = rpIn === true // Mode roleplay (switch di Pengaturan), hanya chat 1-lawan-1
  try {
    // relIn = { rel, mood, shift } dari browser. Tanpa field ini (client lama) chat jalan seperti dulu, tanpa sistem hubungan.
    const rel = relIn && typeof relIn === 'object' ? cleanState(relIn) : null
    // Hadiah dari Inventory (field `gift` = { items }): bentuknya dicek ulang di sini, lalu pesan ke AI diganti kalimat kejadian. EXP-nya diurus client dari /api/auth/shop/gift.
    // Hadiah + pesan: client boleh mengirim `gift.text` (ketikan user yang menyertai hadiah). Dibersihkan lalu ditempel ke kalimat kejadian supaya AI menanggapi keduanya.
    const gl = giftLine(giftIn)
    const gsay = gl && typeof giftIn?.text === 'string' ? giftIn.text.replace(/[\u0000-\u001f\[\]"]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500) : ''
    // pesan yang sampai ke AI: hadiah -> kalimat kejadian; gambar (vision) -> deskripsi isi gambar; selain itu pesan biasa.
    // Pola kalimatnya sama dengan hadiah: kejadian dulu, lalu ketikan user (boleh tidak ada) ditempel setelahnya.
    const visBlock = vd
      ? `[User mengirim sebuah GAMBAR dan kamu bisa melihat isinya. Isi gambarnya: "${vd}".]` + (cleanText(message, 500)
        ? `\n\n[Sambil mengirim gambar itu, user juga menulis: "${cleanText(message, 500)}". Tanggapi gambar sekaligus ucapannya secara natural.]`
        : '\n\n[User tidak menulis apa pun selain gambar itu. Tanggapi gambarnya.]')
      : ''
    const msg = ((gl ? gl + (gsay ? `\n\n[Sambil memberikan hadiah itu, user juga bilang: "${gsay}". Tanggapi hadiahnya sekaligus ucapannya.]` : '') : visBlock || message) || '').trim().slice(0, 2000)
    // Skenario Skrip (field `scenario` = id state aktif dari panel Skenario Skrip): sutradara menilai kalau perlu,
    // Actor membalas dengan arahan sutradara. Respons bentuknya sama persis dengan chat biasa, jadi UI
    // (voice note, hubungan, memori) tidak perlu tahu bedanya.
    if (scnIn && typeof scnIn === 'string') {
      const out = await scenarioChat({ req, stateId: scnIn, clientId: String(clientId).slice(0, 64), char: c, message: msg, user: cleanName(userName), history: cleanHistory(history), voice, memory: cleanMemory(memory), rel, engine, rp })
      return res.json({ ...finalize(out, c, voice, [c], rp), ...(rel && readDeltas(out, rel)) })
    }
    const out = await reply(clientId, c, msg, { user: cleanName(userName), history: cleanHistory(history), voice, memory: cleanMemory(memory), rel, engine, rp, cont })
    res.json({ ...finalize(out, c, voice, [c], rp), ...(rel && readDeltas(out, rel)) })
  } catch (e) {
    if (e?.scn) return res.status(e.status || 400).json({ error: e.message, scn: true }) // error khusus skenario (belum login, kuota, state tidak aktif): client membersihkan statusnya
    console.error('[chat]', engine ? engine.name : '', e.response?.status || '', e.message)
    res.status(502).json({ error: engine ? `Lorka gagal: ${e.message}`.slice(0, 160) : 'ChatGPT gagal merespons, coba lagi' })
  }
})

// Daftar model Lorka (panel Dev). Cuma membaca daftar publik, tidak membawa data user.
app.get('/api/lorka/models', async (req, res) => {
  res.set('Cache-Control', 'no-store')
  try { res.json({ ver: req.query.v === 'v1' ? 'v1' : 'v2', models: await getLorkaModels(req.query.v) }) }
  catch (e) { console.error('[lorka:models]', e.message); res.status(502).json({ error: String(e.message).slice(0, 200) }) }
})

// Ringkas bagian lama obrolan 1-lawan-1 jadi satu memori { title, body }. Server tidak menyimpan apa pun; client yang menyimpan ke localStorage.
const MEM_HIST = 40
app.post('/api/memory', async (req, res) => {
  const { clientId, char, userName, history } = req.body || {}
  const c = await find(char)
  const hist = cleanHistory(history, MEM_HIST)
  if (!c || !clientId || hist.length < 2) return res.status(400).json({ error: 'Request tidak valid' })
  const tag = t => String(t || '').replace(/<\/?[a-z][^>]*>/gi, ' ') // tag HTML nyasar dibuang utuh, bukan cuma <>
  const tidy = o => ({
    title: cleanText(stripTags(tag(o.title)), 40),
    body: cleanText(stripTags(tag(o.body)), 500)
  })
  try {
    const out = await summarize(String(clientId).slice(0, 64), c, { user: cleanName(userName), history: hist }, tidy)
    res.json({ title: out.title || `Obrolan ${new Date().toLocaleDateString('id-ID', { day: 'numeric', month: 'short' })}`, body: out.body })
  } catch (e) {
    console.error('[memory]', e.response?.status || '', e.message)
    res.status(e.response?.status === 429 ? 429 : 502).json({ error: e.response?.status === 429 ? 'Terlalu sering, coba lagi sebentar' : 'Ringkasan gagal dibuat' })
  }
})

// Teks (dengan tag ekspresi) -> mp3 lewat Fish Audio
app.post('/api/tts', async (req, res) => {
  if (!okCode(req.get('x-voice-code'))) return res.status(403).json({ error: 'Kode voice tidak valid' })
  const { char, text, voice } = req.body || {}
  const c = await find(char)
  if (!c || !text?.trim()) return res.status(400).json({ error: 'Request tidak valid' })
  const v = c.voices.find(x => x.key === voice) || c.voices[0] // key tidak dikenal -> voice pertama
  if (!process.env.FISH_API_KEY) return res.status(500).json({ error: 'FISH_API_KEY belum diisi' })
  try {
    const r = await axios.post('https://api.fish.audio/v1/tts',
      { text: stripLB(hasJp.test(text) ? fixReading(c, text) : text).slice(0, 800), reference_id: v.id, format: 'mp3' },
      {
        headers: { Authorization: `Bearer ${process.env.FISH_API_KEY}`, model: process.env.FISH_MODEL || 's2.1-pro-free' },
        responseType: 'arraybuffer', timeout: 60000
      })
    res.type('audio/mpeg').send(Buffer.from(r.data))
  } catch (e) {
    console.error('[tts]', e.response?.status || '', e.message)
    res.status(502).json({ error: 'Suara gagal dibuat' })
  }
})

// Indikator "yang lagi online": browser kirim heartbeat tiap ±60 dtk. Butuh Redis (lihat lib/online.js), kalau belum diset -> enabled:false dan UI menyembunyikannya.
app.post('/api/online', async (req, res) => {
  const id = req.body?.clientId
  if (typeof id !== 'string' || !/^[\w-]{8,64}$/.test(id)) return res.status(400).json({ error: 'Request tidak valid' })
  res.set('Cache-Control', 'no-store')
  try {
    const count = await ping(id)
    res.json(count == null ? { enabled: false, reason: 'redis env belum terbaca (cek nama variabel + redeploy)' } : { enabled: true, count })
  } catch (e) {
    console.error('[online]', e.response?.status || '', e.message)
    res.status(502).json({ error: 'Gagal' })
  }
})

export default app
