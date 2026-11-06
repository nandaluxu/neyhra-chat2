import express from 'express'
import axios from 'axios'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadChars, fixReading } from './chars.js'
import { reply, groupReply } from './sessions.js'
import { ping } from './online.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const PUBLIC = path.join(ROOT, 'public')

const app = express()
app.use(express.json({ limit: '50kb' }))
// Di Vercel, folder public/ dilayani CDN langsung. Baris ini untuk jalan lokal (dan cadangan kalau request sampai ke sini).
app.use(express.static(PUBLIC))

// nama user masuk ke prompt -> buang karakter yang bisa merusak format prompt
const cleanName = n => String(n ?? '').replace(/[\u0000-\u001f<>\[\]{}`]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 24)
const hasJp = /[\u3040-\u30ff\u4e00-\u9fff]/

// riwayat dikirim dari browser (server stateless, cocok untuk Vercel)
const cleanHistory = h => (Array.isArray(h) ? h : []).slice(-24)
  .map(x => Array.isArray(x) && x[1] ? [x[0] === 'user' ? 'user' : 'char', cleanText(x[1], 600)] : null)
  .filter(Boolean)

// tag ekspresi untuk TTS: [laughing], [sad], (break), ... -> dibuang untuk teks subtitle/chat
const stripTags = t => String(t || '').replace(/\[[^\]]*\]|\((?:break|long-break|breath)\)/gi, ' ').replace(/\s+/g, ' ').trim()
// kalau model menulis <whisper>kata</whisper>, ubah ke gaya Fish Audio: [whisper] kata [normal voice]
const normTags = t => String(t || '')
  .replace(/<([a-z][a-z \-]{1,24})>([\s\S]*?)<\/\1>/gi, (_, tag, inner) => `[${tag.trim()}] ${inner.trim()} [normal voice]`)
  .replace(/<\/?[a-z][^>]*>/gi, ' ')
  .replace(/\s+/g, ' ').trim()

// kode untuk menyalakan voice (bisa diganti lewat env VOICE_CODE). Bukan login, cuma pagar supaya kuota TTS tidak dipakai sembarang orang.
const okCode = c => typeof c === 'string' && c.trim().toLowerCase() === (process.env.VOICE_CODE || 'NANDAxFURINA').toLowerCase()

// Tawa tulis (wkwk, haha, あはは, ...) di teks voice -> diberi tag [laughing]/[chuckling] supaya TTS benar-benar tertawa,
// bukan membaca "w-k-w-k". Tawa yang sudah diberi tag oleh model dibiarkan (hanya teksnya dirapikan).
const LAUGHS = [
  [/\b(?=[wk]{3,}\b)(?=\w*w)(?=\w*k)[wk]+\b|\bawokawok\w*\b/, 'Haha', 'laughing'],  // wkwk, kwkw, awokawok
  [/\b[ae]?(?:ha){2,}h?\b/, null, 'laughing'],                                   // haha, ahaha
  [/\b[ae]?(?:he|hi){2,}h?\b/, null, 'chuckling'],                               // hehe, hihi
  [/\bxi(?:xi)+\b/, 'Hihi', 'chuckling'],
  [/あは{2,}|は{3,}|アハハ+|ハハハ+/, null, 'laughing'],
  [/うふふ+|ふふ+っ?|えへへ+|くすくす|ククク+|クスクス|フフ+|ウフフ+|エヘヘ+/, null, 'chuckling']
].map(([re, sound, kind]) => [new RegExp(`((?:\\[(?:laughing|chuckling)[^\\]]*\\]\\s*)?)(${re.source})([!！?？.。…~]*)`, 'gi'), sound, kind])
const laughify = t => LAUGHS.reduce((out, [re, sound, kind]) =>
  out.replace(re, (_, tag, word, punct) => tag
    ? `${tag}${sound || word}${punct}`
    : `[${kind}] ${sound || word}${punct} [normal voice] `), String(t || ''))
  .replace(/\s*\[normal voice\]\s*$/i, '').replace(/(\[normal voice\])\s+(?=[,，、.。!！?？])/gi, '$1').replace(/\s+/g, ' ').trim()

const find = async id => (await loadChars()).find(c => c.id === id)

// ===== Mode grup (lihat design: Kontrak API) =====
const ID_RE = /^[\w-]{1,64}$/
const MAX_MEMBERS = 5, GROUP_HIST = 30
const cleanText = (t, n) => String(t ?? '').replace(/[\u0000-\u001f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n)
const cleanScene = t => cleanText(t, 120).replace(/[\[\]{}`]/g, ' ').replace(/\s+/g, ' ').trim()
const baseName = n => String(n || '').replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim()
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

// model kadang meniru format riwayat dan membuka balasan dengan "Nama:" -> dibuang (juga kalau didahului tag ekspresi, mis. "[sad] Furina: ...")
const dropSelfLabel = (text, c) => {
  const esc = k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const names = [...new Set([baseName(c.name), baseName(c.name).split(/[\s/]+/)[0]].filter(Boolean))]
  return String(text || '').replace(new RegExp(`^((?:\\s*\\[[^\\]]*\\])*)\\s*(?:${names.map(esc).join('|')})\\s*[:：]\\s*`, 'i'), '$1 ').trim()
}

// Satu-satunya tempat teks balasan model dirapikan, dipakai chat biasa DAN grup supaya fix tidak perlu ditulis dua kali.
// `readers` = karakter yang namanya mungkin disebut (di grup: semua anggota), supaya bacaan nama (南雲 -> ナグモ) benar walau yang menyebut karakter lain.
function finalize(out, c, voice, readers = [c]) {
  const pronounce = Object.assign({}, ...readers.map(r => r?.pronounce).filter(Boolean))
  const reader = { ...c, pronounce: Object.keys(pronounce).length ? pronounce : undefined }
  const id = dropSelfLabel(stripTags(out.id), c)
  if (!id) throw new Error('Respons kosong')
  if (!voice.on) return { id }
  const jpText = fixReading(reader, dropSelfLabel(stripTags(out.jp), c)) // 南雲 -> ナグモ, dll, supaya subtitle tidak salah baca
  let vn = fixReading(reader, dropSelfLabel(normTags(out.vn), c))
  if (!vn || (voice.lang === 'jp' && !hasJp.test(vn))) vn = voice.lang === 'jp' ? (jpText || id) : id // jaga-jaga model salah format
  return { id, jpText, vn: laughify(vn) }
}

// avatar: <AVATAR_BASE>/<id>.jpg (kalau char punya avatar berupa URL penuh, itu yang dipakai)
const AVATAR_BASE = process.env.AVATAR_BASE || 'https://raw.githubusercontent.com/nandaluxu/neyhra-chat2/refs/heads/main/assets'
// voices: hanya dikirim kalau karakter punya >1 voice, dan hanya { key, label }. voiceId asli TIDAK pernah dikirim ke browser.
app.get('/api/chars', async (_, res) =>
  res.json((await loadChars()).map(({ id, name, tagline, avatar, voices }) => ({
    id, name, tagline, avatar: /^https?:\/\//.test(avatar || '') ? avatar : `${AVATAR_BASE}/${id}.jpg`,
    ...(voices.length > 1 && { voices: voices.map(({ key, label }) => ({ key, label })) })
  }))))

app.post('/api/unlock', (req, res) =>
  okCode(req.body?.code) ? res.json({ ok: true }) : res.status(403).json({ error: 'Kode salah' }))

// Satu panggilan ChatGPT -> id (chat), jp (subtitle), vn (teks voice note + tag ekspresi)
app.post('/api/chat', async (req, res) => {
  const { clientId, char, message, userName, history, voice: v, group: gr } = req.body || {}
  const all = await loadChars()
  const c = all.find(x => x.id === char)
  const isGroup = gr != null // tidak ada field `group` = chat 1-lawan-1 seperti biasa
  if (!c || !clientId || (!isGroup && !message?.trim())) return res.status(400).json({ error: 'Request tidak valid' })
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
  try {
    const out = await reply(clientId, c, message.trim().slice(0, 2000), { user: cleanName(userName), history: cleanHistory(history), voice })
    res.json(finalize(out, c, voice))
  } catch (e) {
    console.error('[chat]', e.response?.status || '', e.message)
    res.status(502).json({ error: 'ChatGPT gagal merespons, coba lagi' })
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
      { text: (hasJp.test(text) ? fixReading(c, text) : text).slice(0, 800), reference_id: v.id, format: 'mp3' },
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
