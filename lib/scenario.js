import express from 'express'
import crypto from 'node:crypto'
import { chatgpt, getSession } from './chatgpt.js'
import { mongoEnabled, col, ensureIndexes } from './mongo.js'
import { loadChars } from './chars.js'
import { reply, traitOf } from './sessions.js'
import { finalize } from './finalize.js'
import { cleanState, readDeltas } from './relation.js'
import { bearerUser, allow } from './auth.js'

/* ===== Skenario Skrip: mode roleplay dengan dua AI =====
   - Scenario Director (AI 1): sutradara. Mengatur arah cerita, event, lokasi, suasana, pacing.
     TIDAK menulis dialog karakter. Dipanggil hanya saat diperlukan (awal, tiap N pesan, aksi besar).
     Balasan selalu satu objek JSON (lokasi, suasana, event, tujuan, karakter, instruksi, panggil_lagi).
   - Character Actor (AI 2): karakter yang biasa (lib/sessions.js `reply`), plus blok ARAHAN SUTRADARA
     di tiap pesan. Sesi provider terpisah dari chat biasa (kunci `clientId:charId:scn`), auth+chatId
     disimpan di Mongo supaya sesi berlanjut setelah reload.
   - Penyimpanan: MongoDB (koleksi `scripts` dan `rp_state`). Kuota 3 skrip per user dijaga index unik
     {userId, slot} -> klaim slot atomik, bebas race condition. Semua operasi CRUD divalidasi server
     dan hanya menyentuh skrip milik user sendiri.
   Semua endpoint POST + token Bearer (sama seperti fitur akun). Tanpa MONGODB_URI -> {enabled:false}. */

const MAX_SCRIPTS = 3          // kuota skrip tersimpan per user (gratis)
const ID_RE = /^[\w-]{1,64}$/
const TTL = 50 * 60 * 1000     // sesi anon ChatGPT +-1 jam -> segarkan di 50 menit (sama seperti sessions.js)
const DIR_HIST = 8             // berapa baris riwayat yang dilihat sutradara
const STATE_TTL_DAYS = 7       // skenario aktif yang ditinggalkan >7 hari dibersihkan otomatis (TTL index)

const cleanText = (t, n) => String(t ?? '').replace(/[\u0000-\u001f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n)
// isi skrip boleh multi-paragraf: baris baru dipertahankan, tag dan karakter kontrol dibuang
const cleanMulti = (t, n) => String(t ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f<>]/g, ' ').replace(/\r\n?/g, '\n')
  .replace(/[ \t\u00a0]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, n)
const cleanName = n => String(n ?? '').replace(/[\u0000-\u001f<>\[\]{}`]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 24)
const sanitizeVoice = v => v?.on ? { on: true, lang: v.lang === 'id' ? 'id' : 'jp' } : { on: false }
const scnErr = (status, message) => Object.assign(new Error(message), { scn: true, status })

let ready
const init = () => ready ??= Promise.all([
  ensureIndexes('scripts', [[{ userId: 1, slot: 1 }, { unique: true }], [{ userId: 1 }]]),
  ensureIndexes('rp_state', [[{ userId: 1 }, { unique: true }], [{ updatedAt: 1 }, { expireAfterSeconds: STATE_TTL_DAYS * 86400 }]])
]).catch(e => { ready = null; throw e })

const pubScript = s => ({ id: s._id, title: s.title, content: s.content, charId: s.charId, createdAt: s.createdAt, updatedAt: s.updatedAt })
const pubState = s => ({ id: s._id, title: s.title, charId: s.charId, phase: s.phase, first: s.first ?? null, createdAt: s.createdAt })
const quota = async userId => {
  const n = await (await col('scripts')).countDocuments({ userId })
  return { max: MAX_SCRIPTS, left: Math.max(0, MAX_SCRIPTS - n) }
}

async function saveState(st) {
  await (await col('rp_state')).updateOne({ _id: st._id }, {
    $set: {
      phase: st.phase, first: st.first, sinceDir: st.sinceDir, msgs: st.msgs, meta: st.meta,
      director: st.director, actor: st.actor, updatedAt: new Date()
    }
  })
}

/* ===== Scenario Director =====
   Percakapan tersendiri di provider (chatId), konteks penuh dikirim ulang saat sesi baru.
   Gagal total -> kembalikan null; chat tetap jalan dengan arahan lama/default (degradasi lembut). */

const DEF_META = () => ({ lokasi: '', suasana: '', event: '', tujuan: '', karakter: '', instruksi: '', nextIn: 6 })

function parseDirector(raw) {
  const t = String(raw || '').replace(/```[a-z]*\n?/gi, ' ')
  const s = t.indexOf('{'), e = t.lastIndexOf('}')
  if (s < 0 || e <= s) return null
  let o
  try { o = JSON.parse(t.slice(s, e + 1)) } catch { return null }
  const str = (v, n) => String(v ?? '').replace(/[\u0000-\u001f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n)
  const n = Math.round(Number(o.panggil_lagi ?? o.nextIn))
  return {
    lokasi: str(o.lokasi, 120), suasana: str(o.suasana, 120), event: str(o.event, 200),
    tujuan: str(o.tujuan, 160), karakter: str(o.karakter, 120), instruksi: str(o.instruksi, 400),
    nextIn: Number.isFinite(n) ? Math.max(3, Math.min(8, n)) : 6
  }
}

const directorHead = (st, { char, user, history, message, first }) => {
  const hist = history.slice(-DIR_HIST).map(([r, t]) => `${r === 'user' ? (user || 'User') : char.name}: ${String(t).slice(0, 160)}`).join('\n')
  return `Kamu adalah SUTRADARA sebuah cerita roleplay interaktif. Tugasmu mengatur arah dan perkembangan cerita: event, konflik, kejutan, perpindahan lokasi, pergantian adegan, karakter yang terlibat, dan pacing supaya cerita tidak monoton. Kamu TIDAK memerankan karakter dan TIDAK menulis dialog atau aksi karakter (itu tugas Actor). Kamu juga tidak pernah memutuskan tindakan atau keputusan user. Sesuaikan rencanamu dengan tindakan user, dan jaga konsistensi dunia cerita.

SKENARIO (dibuat user, jadi fondasi cerita):
Judul: ${st.title}
${st.content}

KARAKTER YANG DIPERANKAN ACTOR: ${char.name} - ${traitOf(char)}
USER (pemain): ${user || 'User'}

${first
    ? 'Adegan baru saja dimulai. Tentukan kondisi awal cerita: lokasi, suasana, event pembuka, tujuan adegan, dan instruksi untuk Actor.'
    : `STATE CERITA SAAT INI (buatmu sendiri sebelumnya):
${JSON.stringify(st.meta || DEF_META())}

PERCAKAPAN TERAKHIR:
${hist || '(belum ada)'}

PESAN USER TERBARU: ${String(message || '').slice(0, 400)}
Nilai pesan itu: apakah ada tindakan penting, perubahan situasi, atau saatnya event/adegan baru?`}

Balas HANYA dengan SATU objek JSON valid (tanpa teks lain, tanpa penjelasan) dengan bentuk persis:
{"lokasi":"...","suasana":"...","event":"...","tujuan":"...","karakter":"...","instruksi":"...","panggil_lagi":N}
- Semua nilai bahasa Indonesia, singkat, konkret. "karakter" = siapa saja yang terlibat di adegan (nama).
- "instruksi" = arahan khusus untuk Actor untuk beberapa pesan ke depan (bukan dialog, bukan narasi jadi).
- "panggil_lagi" = berapa pesan user lagi sebelum kamu perlu ditanya ulang (angka bulat 3-8). Cerita mulai monoton atau ada momentum -> angka kecil; masih berkembang halus -> angka besar.
- Jangan menuliskan dialog, keputusan, atau tindakan user maupun karakter.`
}

const directorFollowUp = ({ char, user, history, message }) => {
  const hist = history.slice(-DIR_HIST).map(([r, t]) => `${r === 'user' ? (user || 'User') : char.name}: ${String(t).slice(0, 160)}`).join('\n')
  return `Perkembangan terbaru:
${hist || '(belum ada)'}

PESAN USER TERBARU: ${String(message || '').slice(0, 400)}

[Ingat: kamu sutradara, bukan Actor. Balas HANYA SATU objek JSON valid: {"lokasi":"...","suasana":"...","event":"...","tujuan":"...","karakter":"...","instruksi":"...","panggil_lagi":N} dengan "panggil_lagi" angka 3-8]`
}

async function directorTurn(st, { char, user, history, message, first }) {
  const warm = st.director?.auth && st.director.chatId && Date.now() - st.director.startedAt < TTL
  for (let fresh = !warm; ; fresh = true) {
    try {
      const auth = fresh ? await getSession() : st.director.auth
      const prompt = fresh ? directorHead(st, { char, user, history, message, first }) : directorFollowUp({ char, user, history, message })
      let r = await chatgpt(prompt, auth, fresh ? null : st.director.chatId)
      st.director = { auth: r.auth, chatId: r.chatId, startedAt: Date.now() }
      let d = parseDirector(r.response)
      if (!d) {
        r = await chatgpt('Formatmu salah. Ulangi jawabanmu barusan HANYA berupa satu objek JSON valid dengan kunci: lokasi, suasana, event, tujuan, karakter, instruksi, panggil_lagi (angka 3-8).', r.auth, r.chatId)
        st.director = { auth: r.auth, chatId: r.chatId, startedAt: Date.now() }
        d = parseDirector(r.response)
      }
      if (!d) throw new Error('JSON sutradara tidak terbaca')
      return d
    } catch (e) {
      if (fresh) { console.error('[scn:director]', e.message); return null }
    }
  }
}

/* Blok yang masuk prompt Actor */
function scenarioBlock(st) {
  return `SKENARIO ROLEPLAY AKTIF (fondasi adegan ini, dibuat user. Jadikan kenyataan di dunia cerita; jangan dibacakan ulang dan jangan menyebut kata "skenario"):\nJudul: ${st.title}\n${st.content}`
}
function directivesBlock(meta) {
  if (!meta) return ''
  const L = [
    meta.lokasi && `- Lokasi adegan: ${meta.lokasi}`,
    meta.suasana && `- Suasana: ${meta.suasana}`,
    meta.event && `- Event aktif: ${meta.event}`,
    meta.tujuan && `- Tujuan adegan: ${meta.tujuan}`,
    meta.karakter && `- Karakter yang terlibat: ${meta.karakter}`,
    meta.instruksi && `- Instruksi khusus untukmu: ${meta.instruksi}`
  ].filter(Boolean)
  if (!L.length) return ''
  return `ARAHAN SUTRADARA (satu tingkat di atasmu; patuhi secara natural. JANGAN pernah menyebut "sutradara", "arahan", "skenario", atau "instruksi" kepada user):\n${L.join('\n')}`
}

/* aksi roleplay besar (narasi *...* panjang) atau pesan sangat panjang -> sutradara ikut menilai */
const isBigAction = m => { const t = String(m || ''); return /\*[^*]{15,}\*/.test(t) || t.length >= 400 }

/* ===== Jalur chat: dipanggil dari /api/chat (lib/app.js) saat body memuat field `scenario` ===== */
export async function scenarioChat({ req, stateId, clientId, char, message, user, history, voice, memory, rel, engine, rp }) {
  const a = await bearerUser(req)
  if (!a) throw scnErr(401, 'Masuk dulu untuk melanjutkan skenario.')
  if (!(await allow('scnchat:' + a.user._id, 60, 300))) throw scnErr(429, 'Terlalu sering, tunggu sebentar.')
  const st = await (await col('rp_state')).findOne({ _id: String(stateId).slice(0, 64), userId: a.user._id })
  if (!st) throw scnErr(400, 'Skenario ini sudah tidak aktif. Jalankan ulang dari panel Skenario Skrip.')
  if (st.charId !== char.id) throw scnErr(400, 'Skenario ini bukan di chat karakter ini.')

  let meta = st.meta || null
  let sinceDir = st.sinceDir || 0
  if (st.phase === 'choosing') { st.phase = 'running'; st.first = 'user'; sinceDir = 0 } /* user mengetik duluan tanpa memilih: otomatis dianggap "Saya mulai duluan" */

  const needDir = !meta || sinceDir >= (meta.nextIn || 6) || isBigAction(message)
  if (needDir) {
    const d = await directorTurn(st, { char, user, history, message, first: !meta })
    meta = st.meta = d || meta || DEF_META()
    sinceDir = 0
  } else sinceDir++
  st.sinceDir = sinceDir
  st.msgs = (st.msgs || 0) + 1
  st.updatedAt = new Date()

  const scn = {
    scenarioBlock: scenarioBlock(st),
    directives: directivesBlock(meta),
    seed: st.actor, /* sesi Actor dari Mongo -> lanjut percakapan provider yang sama kalau masih hangat */
    done: (auth, chatId, startedAt, fmt) => { st.actor = { auth, chatId, startedAt, fmt } }
  }
  try {
    const out = await reply(String(clientId).slice(0, 64), char, message, { user, history, voice, memory, rel, engine, rp, scn })
    await saveState(st)
    return out
  } catch (e) {
    await saveState(st).catch(() => {}) /* arahan sutradara tetap tersimpan walau Actor gagal */
    throw e
  }
}

/* ===== AI Hasilkan: SATU PARAGRAF pembukaan skenario, maks 900 karakter =====
   Batas ditegakkan sejak prompt. Jika hasil melanggar (kepanjangan / lebih dari satu
   paragraf / terlalu pendek / kosong) -> REGENERASI dengan instruksi lebih ketat,
   TIDAK pernah memotong teks dengan slice/substring. */
const GEN_INSTR = 'Buat SATU PARAGRAF pembukaan skenario roleplay berdasarkan tema yang diberikan. Libatkan karakter yang dipilih dan user secara natural. Gambarkan situasi awal, tindakan karakter, suasana, dan konteks interaksi secukupnya. Buat cerita menarik dan langsung menuju inti adegan. Jangan menulis cerita lengkap, jangan membuat beberapa paragraf, dan jangan melanjutkan adegan terlalu jauh. Akhiri dengan situasi yang memberikan kesempatan bagi user untuk merespons dan menentukan kelanjutan cerita.'
const GEN_MAX = 900                      // batas mutlak output generasi (termasuk spasi, tanda baca, tanda kutip)
const GEN_TARGET_LO = 400, GEN_TARGET_HI = 700 // target panjang ideal
const GEN_MIN = 150                      // di bawah ini dianggap respons degenerate -> regenerasi
const GEN_ATTEMPTS = 3                   // total percobaan generasi + regenerasi

const genPrompt = ({ char, user, theme, feedback }) => `${GEN_INSTR}

Konteks:
- Nama karakter: ${char.name}${char.tagline ? ` - ${cleanText(char.tagline, 120)}` : ''}
- Informasi dan kepribadian karakter: ${traitOf(char)}
- Tema atau judul skrip dari user: ${theme}
- Nama user (pemain): ${user || 'User'}

Format wajib:
- Tepat SATU PARAGRAF: satu blok teks utuh, tanpa baris baru, tanpa pemisah paragraf.
- Target panjang ${GEN_TARGET_LO}-${GEN_TARGET_HI} karakter. Batas mutlak ${GEN_MAX} karakter, dihitung termasuk spasi, tanda baca, dan tanda kutip.
- Ini deskripsi pembukaan skenario, bukan respons roleplay: jangan menyelesaikan konflik, jangan dialog berulang, jangan menulis cerita lengkap.
- Jangan menuliskan dialog atau keputusan atas nama user.
- Balas HANYA dengan isi paragrafnya: tanpa judul, tanpa tanda kutip pembungkus, tanpa penjelasan apa pun.

Tulis dalam bahasa Indonesia.${feedback ? `

PERBAIKAN ATAS PERCOBAAN SEBELUMNYA:
${feedback}

Buat ulang sekarang sambil mematuhi semua aturan di atas.` : ''}`

/* bersihkan hasil AI TANPA memotong: buang code fence & kutip pembungkus, rapikan spasi.
   Baris-baris dalam satu blok (hard-wrap) digabung; pemisah paragraf (baris kosong)
   dipertahankan agar validasi bisa mendeteksi output multi-paragraf. */
function cleanGenerated(t) {
  let s = String(t || '').replace(/```[a-z]*\n?/gi, '').trim()
  s = s.replace(/^["'\u201c\u300c\u300e]+/, '').replace(/["'\u201d\u300d\u300f]+$/, '')
  s = s.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
  s = s.replace(/[ \t\u00a0]+/g, ' ')
  return s.split(/\n{2,}/).map(b => b.split('\n').map(l => l.trim()).filter(Boolean).join(' ')).filter(Boolean).join('\n\n').trim()
}

/* validasi hasil generasi: null = lolos; selain itu alasan regenerasi */
function validateGen(s) {
  if (!s) return 'empty'
  if (s.split(/\n{2,}/).filter(Boolean).length > 1) return 'multi'
  if (s.length > GEN_MAX) return 'long'
  if (s.length < GEN_MIN) return 'short'
  return null
}

/* instruksi lebih ketat untuk regenerasi, sesuai pelanggaran yang terdeteksi */
function genFeedback(why, s) {
  if (why === 'multi') return 'Percobaan sebelumnya menghasilkan lebih dari satu paragraf. Buat ulang dalam TEPAT SATU PARAGRAF saja: satu blok teks utuh tanpa baris baru dan tanpa pemisah paragraf.'
  if (why === 'long') return `Percobaan sebelumnya sepanjang ${s.length} karakter, melebihi batas mutlak ${GEN_MAX} karakter. Buat ulang jauh lebih singkat: target ${GEN_TARGET_LO}-${GEN_TARGET_HI} karakter dihitung termasuk spasi dan tanda baca, tetap TEPAT SATU PARAGRAF. Buang dialog yang berulang dan detail yang tidak perlu.`
  if (why === 'short') return `Percobaan sebelumnya terlalu pendek dan belum membentuk adegan. Buat ulang TEPAT SATU PARAGRAF utuh sepanjang ${GEN_TARGET_LO}-${GEN_TARGET_HI} karakter.`
  return 'Percobaan sebelumnya kosong. Buat ulang TEPAT SATU PARAGRAF pembukaan skenario.'
}

/* auth anon untuk generate: dipakai ulang per user (pola gAuth di sessions.js) */
const genAuth = new Map()
async function genAuthFor(userId, fresh) {
  let e = genAuth.get(userId)
  if (fresh || !e || Date.now() - e.startedAt > TTL) { e = { base: await getSession(), startedAt: Date.now() }; genAuth.set(userId, e) }
  e.seen = Date.now()
  return { ...e.base }
}
setInterval(() => { for (const [k, e] of genAuth) if (Date.now() - e.seen > 12 * 3600 * 1000) genAuth.delete(k) }, 3600 * 1000).unref()

/* ===== Router: /api/scenario/* (semua POST, token Bearer) ===== */
const router = express.Router()

router.use('/api/scenario', async (_req, res, next) => {
  if (!mongoEnabled()) return res.json({ enabled: false })
  try { await init(); next() } catch { return res.status(503).json({ error: 'Database tidak bisa dihubungi.' }) }
})

const wrap = fn => async (req, res) => {
  try { await fn(req, res) } catch (e) { console.error('scenario:', e?.message); res.status(500).json({ error: 'Terjadi kesalahan di server.' }) }
}
const needUser = async req => {
  const a = await bearerUser(req)
  return a || null
}

router.post('/api/scenario/list', wrap(async (req, res) => {
  const a = await needUser(req)
  if (!a) return res.status(401).json({ error: 'Masuk dulu untuk memakai Skenario Skrip.' })
  const cur = await (await col('scripts')).find({ userId: a.user._id }).sort({ updatedAt: -1 }).toArray()
  res.json({ ok: true, scripts: cur.map(pubScript), quota: { max: MAX_SCRIPTS, left: Math.max(0, MAX_SCRIPTS - cur.length) } })
}))

router.post('/api/scenario/save', wrap(async (req, res) => {
  const a = await needUser(req)
  if (!a) return res.status(401).json({ error: 'Masuk dulu untuk menyimpan skrip.' })
  if (!(await allow('scnsv:' + a.user._id, 30, 600))) return res.status(429).json({ error: 'Terlalu sering, tunggu sebentar.' })
  const b = req.body || {}
  const title = cleanText(b.title, 100), content = cleanMulti(b.content, 1000), charId = cleanText(b.charId, 64)
  if (!title) return res.status(400).json({ error: 'Tema skrip belum diisi.' })
  if (!content) return res.status(400).json({ error: 'Isi skrip belum diisi.' })
  if (String(b.content ?? '').length > 1000) return res.status(400).json({ error: 'Isi skrip maksimal 1000 karakter.' })
  if (!ID_RE.test(charId) || !(await loadChars()).some(x => x.id === charId)) return res.status(400).json({ error: 'Karakter tidak dikenal.' })
  const c = await col('scripts'), now = new Date()
  if (b.id) {
    const r = await c.findOneAndUpdate({ _id: String(b.id).slice(0, 64), userId: a.user._id }, { $set: { title, content, charId, updatedAt: now } }, { returnDocument: 'after' })
    if (!r) return res.status(404).json({ error: 'Skrip tidak ditemukan.' })
    return res.json({ ok: true, script: pubScript(r), quota: await quota(a.user._id) })
  }
  /* buat baru: klaim slot 0..2 lewat index unik {userId, slot} -> dua permintaan bersamaan tidak bisa lolos kuota */
  for (let slot = 0; ; slot++) {
    if (slot >= MAX_SCRIPTS) return res.status(409).json({ error: `Kuota skrip penuh (maksimal ${MAX_SCRIPTS}). Hapus salah satu skrip untuk mengembalikan slot.` })
    try {
      const doc = { _id: crypto.randomUUID(), userId: a.user._id, slot, title, content, charId, createdAt: now, updatedAt: now }
      await c.insertOne(doc)
      return res.json({ ok: true, script: pubScript(doc), quota: await quota(a.user._id) })
    } catch (e) { if (e?.code !== 11000) throw e }
  }
}))

router.post('/api/scenario/delete', wrap(async (req, res) => {
  const a = await needUser(req)
  if (!a) return res.status(401).json({ error: 'Masuk dulu.' })
  if (!(await allow('scndl:' + a.user._id, 60, 600))) return res.status(429).json({ error: 'Terlalu sering, tunggu sebentar.' })
  const r = await (await col('scripts')).deleteOne({ _id: String(req.body?.id || '').slice(0, 64), userId: a.user._id })
  if (!r.deletedCount) return res.status(404).json({ error: 'Skrip tidak ditemukan.' })
  res.json({ ok: true, quota: await quota(a.user._id) })
}))

router.post('/api/scenario/generate', wrap(async (req, res) => {
  const a = await needUser(req)
  if (!a) return res.status(401).json({ error: 'Masuk dulu untuk memakai AI Hasilkan.' })
  if (!(await allow('scngen:' + a.user._id, 8, 3600))) return res.status(429).json({ error: 'Terlalu sering membuat skrip dengan AI. Coba lagi nanti.' })
  const theme = cleanText(req.body?.theme, 120), charId = cleanText(req.body?.charId, 64)
  if (theme.length < 3) return res.status(400).json({ error: 'Tulis dulu tema skripnya (minimal 3 karakter).' })
  const c = (await loadChars()).find(x => x.id === charId)
  if (!c) return res.status(400).json({ error: 'Karakter tidak dikenal.' })
  /* satu panggilan chatgpt + satu kali ulang dengan sesi segar bila sesi mati (pola lama) */
  const ask = async prompt => {
    for (let fresh = false; ; fresh = true) {
      try { return await chatgpt(prompt, await genAuthFor(a.user._id, fresh), null) }
      catch (e) { if (fresh) throw e }
    }
  }
  try {
    let feedback = ''
    for (let attempt = 1; attempt <= GEN_ATTEMPTS; attempt++) {
      const r = await ask(genPrompt({ char: c, user: cleanName(req.body?.userName), theme, feedback }))
      const content = cleanGenerated(r.response)
      const why = validateGen(content)
      if (!why) return res.json({ ok: true, content })
      feedback = genFeedback(why, content)
      console.warn(`[scn:generate] percobaan ${attempt} tidak lolos (${why}, ${content.length} char) -> regenerasi`)
    }
    console.error('[scn:generate] semua percobaan gagal memenuhi format')
    return res.status(502).json({ error: 'AI belum berhasil membuat skrip satu paragraf. Coba lagi sebentar.' })
  } catch (e) {
    console.error('[scn:generate]', e.message)
    return res.status(502).json({ error: 'AI gagal membuat skrip. Coba lagi sebentar.' })
  }
}))

router.post('/api/scenario/start', wrap(async (req, res) => {
  const a = await needUser(req)
  if (!a) return res.status(401).json({ error: 'Masuk dulu untuk menjalankan skrip.' })
  if (!(await allow('scnst:' + a.user._id, 20, 600))) return res.status(429).json({ error: 'Terlalu sering, tunggu sebentar.' })
  const b = req.body || {}
  let title, content, charId, scriptId = null
  if (b.id) {
    const s = await (await col('scripts')).findOne({ _id: String(b.id).slice(0, 64), userId: a.user._id })
    if (!s) return res.status(404).json({ error: 'Skrip tidak ditemukan.' })
    title = s.title; content = s.content; charId = s.charId; scriptId = s._id
  } else {
    title = cleanText(b.title, 100); content = cleanMulti(b.content, 1000); charId = cleanText(b.charId, 64)
  }
  if (!title || !content || !ID_RE.test(charId)) return res.status(400).json({ error: 'Skrip belum lengkap (tema dan isi wajib).' })
  const c = (await loadChars()).find(x => x.id === charId)
  if (!c) return res.status(400).json({ error: 'Karakter tidak dikenal.' })

  /* satu skenario aktif per user: skenario lama diakhiri otomatis (skrip tersimpan tidak ikut terhapus) */
  const states = await col('rp_state')
  const prev = await states.findOne({ userId: a.user._id })
  const doc = { _id: crypto.randomUUID(), userId: a.user._id, scriptId, title, content, charId, phase: 'choosing', first: null, sinceDir: 0, msgs: 0, meta: null, director: null, actor: null, createdAt: new Date(), updatedAt: new Date() }
  try { await states.insertOne(doc) }
  catch (e) {
    if (e?.code !== 11000) throw e
    await states.deleteMany({ userId: a.user._id })
    try { await states.insertOne(doc) } catch (e2) { if (e2?.code === 11000) return res.status(409).json({ error: 'Masih ada skenario lain sedang dimulai, coba lagi.' }); throw e2 }
  }
  res.json({ ok: true, state: pubState(doc), ...(prev && { ended: prev.title }) })
}))

router.post('/api/scenario/state', wrap(async (req, res) => {
  const a = await needUser(req)
  if (!a) return res.status(401).json({ error: 'Masuk dulu.' })
  const st = await (await col('rp_state')).findOne({ userId: a.user._id })
  res.json({ ok: true, active: st ? pubState(st) : null })
}))

router.post('/api/scenario/begin', wrap(async (req, res) => {
  const a = await needUser(req)
  if (!a) return res.status(401).json({ error: 'Masuk dulu.' })
  const b = req.body || {}
  const id = String(b.id || '').slice(0, 64)
  if (!/^[0-9a-f-]{8,64}$/i.test(id) || (b.mode !== 'ai' && b.mode !== 'user')) return res.status(400).json({ error: 'Request tidak valid' })
  const st = await (await col('rp_state')).findOne({ _id: id, userId: a.user._id })
  if (!st) return res.status(404).json({ error: 'Skenario tidak ditemukan atau sudah berakhir.' })
  if (st.phase === 'running') return res.json({ ok: true, already: true, state: pubState(st) }) /* idempotent: tekan lagi setelah reload */
  const c = (await loadChars()).find(x => x.id === st.charId)
  if (!c) return res.status(400).json({ error: 'Karakter skenario tidak dikenal.' })

  const voice = sanitizeVoice(b.voice), user = cleanName(b.userName), rp = b.rp === true
  const rel = b.rel && typeof b.rel === 'object' ? cleanState(b.rel) : null

  /* Director menentukan kondisi awal (dipanggil juga saat "Saya mulai duluan" supaya tetap tahu konteks) */
  const d = await directorTurn(st, { char: c, user, history: [], message: '', first: true })
  st.meta = d || DEF_META()
  st.phase = 'running'; st.first = b.mode; st.sinceDir = 0; st.updatedAt = new Date()

  if (b.mode === 'user') {
    await saveState(st)
    return res.json({ ok: true, waiting: 'user', state: pubState(st) })
  }

  /* AI mulai duluan: Actor membuka adegan berdasarkan arahan Director */
  const scn = {
    scenarioBlock: scenarioBlock(st),
    directives: directivesBlock(st.meta),
    seed: st.actor,
    done: (auth, chatId, startedAt, fmt) => { st.actor = { auth, chatId, startedAt, fmt } }
  }
  try {
    const out = await reply(String(b.clientId || '').slice(0, 64), c,
      '[User memilih AI untuk mulai duluan. Mulailah adegan pembuka sesuai skenario dan arahan sutradara, lalu beri ruang bagi user untuk merespons.]',
      { user, history: [], voice, memory: [], rel, engine: null, rp, scn })
    await saveState(st)
    res.json({ ok: true, reply: finalize(out, c, voice, [c], rp), ...(rel && readDeltas(out, rel)) })
  } catch (e) {
    await saveState(st).catch(() => {}) /* fase tetap running: user tetap bisa mengetik untuk memulai */
    console.error('[scn:begin]', e.response?.status || '', e.message)
    res.status(e.response?.status === 429 ? 429 : 502).json({ error: e.response?.status === 429 ? 'Terlalu sering, coba lagi sebentar' : 'ChatGPT gagal merespons, coba lagi' })
  }
}))

router.post('/api/scenario/end', wrap(async (req, res) => {
  const a = await needUser(req)
  if (!a) return res.status(401).json({ error: 'Masuk dulu.' })
  if (!(await allow('scned:' + a.user._id, 60, 600))) return res.status(429).json({ error: 'Terlalu sering, tunggu sebentar.' })
  const r = await (await col('rp_state')).deleteOne({ _id: String(req.body?.id || '').slice(0, 64), userId: a.user._id })
  res.json({ ok: true, ended: r.deletedCount > 0 }) /* skrip tersimpan TIDAK ikut terhapus */
}))

export const scenarioRouter = router
