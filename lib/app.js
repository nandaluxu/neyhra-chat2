import express from 'express'
import axios from 'axios'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadChars, fixReading } from './chars.js'
import { reply } from './sessions.js'

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
  .map(x => Array.isArray(x) && x[1] ? [x[0] === 'user' ? 'user' : 'char', String(x[1]).slice(0, 600)] : null)
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

app.get('/api/chars', async (_, res) =>
  res.json((await loadChars()).map(({ id, name, tagline, avatar }) => ({ id, name, tagline, avatar }))))

app.post('/api/unlock', (req, res) =>
  okCode(req.body?.code) ? res.json({ ok: true }) : res.status(403).json({ error: 'Kode salah' }))

// Satu panggilan ChatGPT -> id (chat), jp (subtitle), vn (teks voice note + tag ekspresi)
app.post('/api/chat', async (req, res) => {
  const { clientId, char, message, userName, history, voice: v } = req.body || {}
  const c = await find(char)
  if (!c || !clientId || !message?.trim()) return res.status(400).json({ error: 'Request tidak valid' })
  const voice = v?.on ? { on: true, lang: v.lang === 'id' ? 'id' : 'jp' } : { on: false }
  try {
    const out = await reply(clientId, c, message.trim().slice(0, 2000), { user: cleanName(userName), history: cleanHistory(history), voice })
    const id = stripTags(out.id)
    if (!voice.on) return res.json({ id })
    const jpText = fixReading(c, stripTags(out.jp)) // 南雲 -> ナグモ, dll, supaya subtitle tidak salah baca
    let vn = normTags(out.vn)
    if (!vn || (voice.lang === 'jp' && !hasJp.test(vn))) vn = voice.lang === 'jp' ? (jpText || id) : id // jaga-jaga model salah format
    vn = laughify(vn)
    res.json({ id, jpText, vn })
  } catch (e) {
    console.error('[chat]', e.response?.status || '', e.message)
    res.status(502).json({ error: 'ChatGPT gagal merespons, coba lagi' })
  }
})

// Teks (dengan tag ekspresi) -> mp3 lewat Fish Audio
app.post('/api/tts', async (req, res) => {
  if (!okCode(req.get('x-voice-code'))) return res.status(403).json({ error: 'Kode voice tidak valid' })
  const { char, text } = req.body || {}
  const c = await find(char)
  if (!c || !text?.trim()) return res.status(400).json({ error: 'Request tidak valid' })
  if (!process.env.FISH_API_KEY) return res.status(500).json({ error: 'FISH_API_KEY belum diisi' })
  try {
    const r = await axios.post('https://api.fish.audio/v1/tts',
      { text: (hasJp.test(text) ? fixReading(c, text) : text).slice(0, 800), reference_id: c.voiceId, format: 'mp3' },
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

export default app
