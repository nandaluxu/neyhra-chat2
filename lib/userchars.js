// AI buatan user: user membuat karakter AI-nya sendiri (nama, identitas, kepribadian, gaya bicara, foto).
// Dipakai di tab Profil > "AI Saya" (public/profile.js). Karakter jadi dapat dipilih di Beranda seperti karakter bawaan
// dan ikut seluruh fitur chat (hubungan, memori, grup, skenario, persona), KECUALI suara/TTS (tidak ada voiceId).
//
// Koleksi MongoDB:
//   user_chars { _id: "u_<16 hex>", ownerId, name (maks 40), tagline (maks 40), identity (maks 600), personality (maks 600),
//                speech (maks 300), rules (maks 400), story (maks 2000, opsional; tab Story di halaman detail), greeting (maks 300, opsional; sapaan pembuka chat), av (versi foto), avatarUrl + avKey (R2) | avData (JPEG base64, tanpa R2),
//                gender ('cowo' | 'cewe' | '' = belum di set), attrs ([{title, content}], maks 6; atribut persona), public (boolean, default false = privat), createdAt, updatedAt }
//   Index {ownerId:1, updatedAt:-1}. Maksimal MAX_CHARS per akun.
//
// Privasi: default PRIVAT = hanya pemilik yang melihat dan bisa memakainya (/api/chars menyaring per token, /api/chat dkk memeriksa
// kepemilikan lewat canUseChar). Kalau pemilik menyalakan `public`, AI muncul di Beranda semua orang (termasuk tamu) dan bisa dipakai
// siapa pun untuk chat; yang keluar ke publik hanya id, nama, label, foto, dan pembuat — identitas/kepribadian/aturan tetap rahasia.
// Hanya pemilik yang bisa mengedit/menghapus/mengubah status publik.
//
// Endpoint (POST kecuali dicatat, semua butuh token Bearer kecuali avatar):
//   aichar/list                                   daftar AI milik sendiri + kuota
//   aichar/save { id?, name, tagline, identity, personality, speech, rules, avatar?, public?, gender? }   tambah/edit (public: true/false)
//   aichar/delete { id }                          hapus AI (foto R2 dibuang, pilihan persona per-karakter dibersihkan)
//   GET aichar-av/:id?v=                          foto AI (R2 redirect / fallback MongoDB)
//   aichar/story { seed, name, tagline, identity, personality, speech, rules }   AI-nya sendiri (mesin ChatGPT yang sama dengan chat, dengan prompt karakter itu)
//                                                 mengembangkan tulisan singkat user (seed, 10-2000 huruf) jadi cerita -> { ok, story }. Belum menyimpan apa pun.
//   charstory { char }                            (login opsional) cerita + atribut persona satu karakter -> { ok, story, attrs }; AI privat orang lain = 404

import crypto from 'node:crypto'
import { r2Enabled, r2Put, r2Delete, r2PublicUrl } from './r2.js'
import { avatarBuffer } from './profile.js'
import { clearCustomCache, customAvatarUrl, CUSTOM_PREFIX, voiceCatalog, loadChars, buildCustomPrompt, normGender, normAttrs } from './chars.js'
import { okDev } from './dev.js'
import { purgeCharsSocial } from './charsocial.js'
import { chatgpt, getSession } from './chatgpt.js'

export const MAX_CHARS = 10
const LIM = { name: 40, tagline: 40, identity: 600, personality: 600, speech: 300, rules: 400, story: 2000, greeting: 300 }
const STORY_MIN_SEED = 10, STORY_MIN = 120, STORY_TARGET = '600-1500'
const ID_RE = /^u_[0-9a-f]{16}$/

// Teks bebas dari user masuk ke prompt AI: buang karakter kontrol dan tanda < > (supaya tidak bisa memalsukan tag format
// <id>/<jp>/<vn>/<rel>/<next> yang dibaca parser balasan). Baris baru boleh (maks 2 berturut-turut) di kolom panjang.
const clean = (s, max, multiline) => {
  let t = String(s ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f<>]/g, ' ')
  t = multiline ? t.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n') : t.replace(/\s+/g, ' ')
  return t.trim().slice(0, max)
}
export const cleanFields = b => ({
  name: clean(b?.name, LIM.name).replace(/[\[\]{}`]/g, ' ').replace(/\s+/g, ' ').trim(),
  tagline: clean(b?.tagline, LIM.tagline).replace(/[\[\]{}`]/g, ' ').replace(/\s+/g, ' ').trim(),
  identity: clean(b?.identity, LIM.identity, true),
  personality: clean(b?.personality, LIM.personality, true),
  speech: clean(b?.speech, LIM.speech, true),
  rules: clean(b?.rules, LIM.rules, true)
})

const pub = d => ({
  id: d._id, name: d.name, tagline: d.tagline || '', identity: d.identity || '', personality: d.personality || '',
  speech: d.speech || '', rules: d.rules || '', story: d.story || '', greeting: d.greeting || '', gender: normGender(d.gender), attrs: normAttrs(d.attrs), avatar: customAvatarUrl(d), public: d.public === true,
  voice: d.voiceRef && typeof d.voiceRef === 'object' ? { char: d.voiceRef.char, key: d.voiceRef.key } : null // pilihan suara bawaan; id mentah (voiceIds, diisi dev) tidak pernah dikirim
})

// ===== Cerita AI (tab Story di halaman detail) =====
// Ditulis user sendiri, atau dikembangkan AI dari tulisan singkat user. Hanya tampilan: TIDAK masuk ke prompt chat.
const storyPrompt = (f, seed) => `${buildCustomPrompt(f)}

TUGAS KHUSUS (bukan roleplay chat): tulis CERITA / LORE tentang ${f.name} untuk halaman profil karakternya, berdasarkan ide singkat dari pembuatmu di bawah ini.
IDE DARI PEMBUAT (batas awal dan akhir ditandai ###):
###
${seed}
###

Aturan:
- Kembangkan ide itu jadi cerita utuh: latar belakang, peristiwa penting, dan kesan tentang dunia ${f.name}. Pertahankan semua fakta dan nama dari ide (jangan mengubah atau membuang), tambahkan detail yang selaras dengan identitas dan kepribadian di atas.
- Tulis dalam bahasa Indonesia, sudut pandang orang ketiga, 2-4 paragraf dipisah satu baris kosong. Panjang ${STORY_TARGET} karakter; batas mutlak ${LIM.story} karakter termasuk spasi.
- Jangan menulis dialog dengan user, jangan menyapa pembaca, jangan menyebut dirimu AI, jangan menulis tag/format balasan chat (<id>, <jp>, dll.), jangan memakai judul, markdown, atau tanda bintang.
- Konten harus aman untuk semua umur.
- Balas HANYA dengan isi ceritanya, tanpa pembuka atau penutup.`

// bersihkan hasil AI: buang code fence, markdown ringan, tag, kutip pembungkus; rapikan paragraf (maks 1 baris kosong)
function cleanStory(t) {
  let s = String(t || '').replace(/```[a-z]*\n?/gi, '').replace(/<[^>]*>/g, ' ').replace(/[<>]/g, ' ')
  s = s.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ').replace(/^\s*#{1,6}\s+/gm, '').replace(/\*\*?|__/g, '')
  s = s.replace(/^["'“「『]+/, '').replace(/["'”」』]+$/, '')
  return s.split(/\n{2,}/).map(b => b.split('\n').map(l => l.replace(/[ \t ]+/g, ' ').trim()).filter(Boolean).join(' ')).filter(Boolean).join('\n\n').trim()
}
// terlalu panjang -> potong di akhir kalimat terakhir yang masih muat
function fitStory(s) {
  if (s.length <= LIM.story) return s
  const cut = s.slice(0, LIM.story), at = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('.\n'), cut.lastIndexOf('! '), cut.lastIndexOf('? '))
  return (at > LIM.story * 0.6 ? cut.slice(0, at + 1) : cut.replace(/\s+\S*$/, '…')).trim()
}
const genAuth = new Map() // userId -> { base, startedAt, seen }: sesi anon ChatGPT dipakai ulang per user (pola lib/scenario.js)
async function storyAuth(userId, fresh) {
  let e = genAuth.get(userId)
  if (fresh || !e || Date.now() - e.startedAt > 50 * 60 * 1000) { e = { base: await getSession(), startedAt: Date.now() }; genAuth.set(userId, e) }
  e.seen = Date.now()
  return { ...e.base }
}
setInterval(() => { for (const [k, e] of genAuth) if (Date.now() - e.seen > 12 * 3600 * 1000) genAuth.delete(k) }, 3600 * 1000).unref()

// Hapus semua AI milik satu akun (dipanggil saat akun dihapus)
export async function purgeUserChars(col, userId) {
  const c = await col('user_chars')
  const rows = await c.find({ ownerId: userId }, { projection: { avKey: 1 } }).toArray()
  if (r2Enabled()) for (const r of rows) if (r.avKey) await r2Delete(r.avKey).catch(e => console.error('[r2] hapus foto AI gagal:', e.message))
  await c.deleteMany({ ownerId: userId })
  if (rows.length) await (await col('persona_picks')).deleteMany({ charId: { $in: rows.map(r => r._id) } }).catch(() => {}) // AI publik bisa dipilih persona-nya oleh user lain
  await purgeCharsSocial(col, rows.map(r => r._id)) // like & komentar AI itu ikut hilang
  clearCustomCache()
}

export function mountUserChars(router, { wrap, userFromReq, allow, col, ensureIndexes }) {
  let ready
  const init = () => ready ??= ensureIndexes('user_chars', [[{ ownerId: 1, updatedAt: -1 }]]).catch(e => { ready = null; throw e })
  const noAuth = res => res.status(401).json({ error: 'Sesi berakhir, masuk lagi.' })
  const list = async ownerId => (await (await col('user_chars')).find({ ownerId }).sort({ updatedAt: -1 }).toArray()).map(pub)
  const ans = (res, chars) => res.json({ ok: true, chars, max: MAX_CHARS })

  router.post('/api/auth/aichar/list', wrap(async (req, res) => {
    const a = await userFromReq(req); if (!a) return noAuth(res)
    if (!(await allow('aclist:' + a.user._id, 120, 60))) return res.status(429).json({ error: 'Terlalu sering, tunggu sebentar.' })
    await init()
    ans(res, await list(a.user._id))
  }))

  router.post('/api/auth/aichar/save', wrap(async (req, res) => {
    const a = await userFromReq(req); if (!a) return noAuth(res)
    if (!(await allow('acsv:' + a.user._id, 40, 3600))) return res.status(429).json({ error: 'Terlalu sering menyimpan AI, coba lagi nanti.' })
    await init()
    const b = req.body || {}
    const f = cleanFields(b)
    if (!f.name) return res.status(400).json({ error: 'Nama AI tidak boleh kosong.' })
    if (!f.personality && !f.identity) return res.status(400).json({ error: 'Isi minimal identitas atau kepribadian supaya AI-mu punya karakter.' })
    const chars = await col('user_chars')
    const id = typeof b.id === 'string' ? b.id.slice(0, 64) : ''
    if (id && !ID_RE.test(id)) return res.status(404).json({ error: 'AI tidak ditemukan.' })
    const edit = id ? await chars.findOne({ _id: id, ownerId: a.user._id }) : null // selalu difilter ownerId: AI orang lain = tidak ada
    if (id && !edit) return res.status(404).json({ error: 'AI tidak ditemukan.' })
    if (!edit && (await chars.countDocuments({ ownerId: a.user._id })) >= MAX_CHARS) {
      return res.status(400).json({ error: `Maksimal ${MAX_CHARS} AI. Hapus yang tidak terpakai dulu.` })
    }

    // foto: tanpa field = biarkan; null = hapus; string data URL JPEG = ganti (pola lib/persona.js)
    const set = { ...f, updatedAt: new Date() }
    // public: tanpa field = biarkan (AI baru = privat); hanya boolean true yang dianggap publik
    if ('public' in b) set.public = b.public === true
    // story: tanpa field = biarkan; string = ganti (kosong = hapus cerita)
    if ('story' in b) set.story = clean(b.story, LIM.story, true)
    // greeting (sapaan): tanpa field = biarkan; string = ganti (kosong = hapus). Dikirim apa adanya ke client lewat /api/chars, jadi hanya teks biasa.
    // gender: tanpa field = biarkan; 'cowo' | 'cewe' = set; selain itu (kosong) = belum di set
    if ('gender' in b) set.gender = normGender(b.gender)
    // attrs (atribut persona): tanpa field = biarkan; array = ganti seluruh daftar (maks 6, judul 60, isi 1200; kosong = hapus semua)
    if ('attrs' in b) set.attrs = normAttrs(b.attrs)
    if ('greeting' in b) set.greeting = clean(b.greeting, LIM.greeting, true)
    let newKey = '', oldKey = ''
    // suara: tanpa field = biarkan; null = tanpa suara bawaan; { char, key } = pakai suara karakter bawaan (divalidasi ke katalog server)
    if ('voice' in b) {
      if (b.voice === null) set.voiceRef = null
      else {
        const cat = await voiceCatalog()
        const src = cat.find(x => x.char === String(b.voice?.char)), v = src?.voices.find(x => x.key === String(b.voice?.key))
        if (!v) return res.status(400).json({ error: 'Suara yang dipilih tidak tersedia.' })
        set.voiceRef = { char: src.char, key: v.key }
      }
    }

    if ('avatar' in b) {
      if (!(await allow('acav:' + a.user._id, 20, 3600))) return res.status(429).json({ error: 'Terlalu sering mengganti foto, coba lagi nanti.' })
      oldKey = edit?.avKey || ''
      if (b.avatar === null) { set.av = 0; set.avatarUrl = ''; set.avKey = ''; set.avData = '' }
      else {
        const buf = avatarBuffer(b.avatar)
        if (!buf) return res.status(400).json({ error: 'Foto tidak valid (harus JPEG, maks 100 KB).' })
        const v = Date.now()
        if (r2Enabled()) {
          newKey = `aichar/${crypto.randomBytes(12).toString('hex')}.jpg`
          try { await r2Put(newKey, buf, 'image/jpeg') }
          catch (e) {
            console.error('[r2] unggah foto AI gagal:', e.message)
            return res.status(502).json({ error: 'Gagal menyimpan foto' + (e.status ? ` (kode R2: ${e.status}). Cek pengaturan R2 di server.` : ' (server tidak bisa menghubungi R2). Cek pengaturan R2 di server.') })
          }
          set.avatarUrl = r2PublicUrl(newKey); set.avKey = newKey; set.avData = ''; set.av = v
        } else { set.avData = buf.toString('base64'); set.av = v; set.avatarUrl = ''; set.avKey = '' }
      }
    }

    try {
      if (edit) await chars.updateOne({ _id: edit._id, ownerId: a.user._id }, { $set: set })
      else {
        await chars.insertOne({
          _id: CUSTOM_PREFIX + crypto.randomBytes(8).toString('hex'), ownerId: a.user._id, ...f,
          voiceRef: set.voiceRef || null, voiceIds: [], gender: set.gender || '', attrs: set.attrs || [], public: set.public === true, story: set.story || '', greeting: set.greeting || '',
          av: set.av || 0, avatarUrl: set.avatarUrl || '', avKey: set.avKey || '', avData: set.avData || '',
          createdAt: new Date(), updatedAt: set.updatedAt
        })
      }
    } catch (e) { if (newKey) await r2Delete(newKey).catch(() => {}); throw e }
    if (newKey && oldKey && oldKey !== newKey) await r2Delete(oldKey).catch(e => console.error('[r2] hapus foto AI lama gagal:', e.message))
    clearCustomCache() // instance ini langsung melihat perubahan (instance lain menyusul dalam hitungan detik)
    ans(res, await list(a.user._id))
  }))

  // AI mengembangkan cerita: mesin & prompt karakter yang sama dengan chat (buildCustomPrompt), user wajib menulis sedikit ide dulu (seed).
  // Form bisa belum disimpan, jadi data karakter dibaca dari body (dibersihkan sama seperti save). Tidak menulis ke database.
  router.post('/api/auth/aichar/story', wrap(async (req, res) => {
    const a = await userFromReq(req); if (!a) return noAuth(res)
    if (!(await allow('acstory:' + a.user._id, 10, 3600))) return res.status(429).json({ error: 'Terlalu sering memakai AI untuk cerita. Coba lagi nanti.' })
    const b = req.body || {}
    const f = cleanFields(b)
    const seed = clean(b.seed, LIM.story, true)
    if (!f.name) return res.status(400).json({ error: 'Isi nama AI dulu.' })
    if (seed.length < STORY_MIN_SEED) return res.status(400).json({ error: `Tulis dulu sedikit ide ceritanya (minimal ${STORY_MIN_SEED} huruf), lalu AI akan mengembangkannya.` })
    const ask = async prompt => {
      for (let fresh = false; ; fresh = true) {
        try { return await chatgpt(prompt, await storyAuth(a.user._id, fresh), null) }
        catch (e) { if (fresh) throw e } // sesi lama gagal -> ulang sekali dengan sesi baru
      }
    }
    try {
      let story = cleanStory((await ask(storyPrompt(f, seed))).response)
      if (story.length < STORY_MIN) { // terlalu pendek / kosong -> satu kali minta ulang
        story = cleanStory((await ask(storyPrompt(f, seed) + `\n\nPERBAIKAN: percobaan sebelumnya terlalu pendek. Tulis ulang sepanjang ${STORY_TARGET} karakter.`)).response)
      }
      story = fitStory(story)
      if (story.length < 40) return res.status(502).json({ error: 'AI belum berhasil membuat cerita. Coba lagi sebentar.' })
      res.json({ ok: true, story })
    } catch (e) {
      console.error('[aichar:story]', e?.message)
      res.status(502).json({ error: 'AI gagal membuat cerita. Coba lagi sebentar.' })
    }
  }))

  // Cerita untuk tab Story (login opsional). AI privat orang lain = tidak ditemukan; karakter bawaan = belum punya cerita.
  router.post('/api/auth/charstory', wrap(async (req, res) => {
    const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim().slice(0, 64) || 'unknown'
    const a = await userFromReq(req).catch(() => null)
    if (!(await allow('cstory:' + (a?.user?._id || ip), 120, 60))) return res.status(429).json({ error: 'Terlalu sering, tunggu sebentar.' })
    const id = String(req.body?.char || '').slice(0, 64)
    if (!ID_RE.test(id)) return res.json({ ok: true, story: '', attrs: [] }) // karakter bawaan
    await init()
    const d = await (await col('user_chars')).findOne({ _id: id }, { projection: { ownerId: 1, public: 1, story: 1, attrs: 1 } })
    if (!d || !(d.public === true || (a && d.ownerId === a.user._id))) return res.status(404).json({ error: 'Karakter tidak ditemukan.' })
    res.json({ ok: true, story: d.story || '', attrs: normAttrs(d.attrs) })
  }))

  router.post('/api/auth/aichar/delete', wrap(async (req, res) => {
    const a = await userFromReq(req); if (!a) return noAuth(res)
    if (!(await allow('acdel:' + a.user._id, 60, 600))) return res.status(429).json({ error: 'Terlalu sering, tunggu sebentar.' })
    await init()
    const id = String(req.body?.id || '').slice(0, 64)
    if (!ID_RE.test(id)) return res.status(404).json({ error: 'AI tidak ditemukan.' })
    const d = await (await col('user_chars')).findOneAndDelete({ _id: id, ownerId: a.user._id })
    if (!d) return res.status(404).json({ error: 'AI tidak ditemukan.' })
    if (d.avKey && r2Enabled()) await r2Delete(d.avKey).catch(e => console.error('[r2] hapus foto AI gagal:', e.message))
    await (await col('persona_picks')).deleteMany({ charId: id }).catch(() => {}) // pilihan persona untuk AI ini ikut dibersihkan (milik semua user: AI publik bisa dipakai orang lain)
    await purgeCharsSocial(col, [id]) // like & komentar AI ini ikut dihapus
    clearCustomCache()
    ans(res, await list(a.user._id))
  }))

  router.get('/api/auth/aichar-av/:id', wrap(async (req, res) => {
    const id = String(req.params.id || '')
    if (!ID_RE.test(id)) return res.status(404).end()
    const d = await (await col('user_chars')).findOne({ _id: id }, { projection: { avatarUrl: 1, avData: 1 } })
    if (d?.avatarUrl) return res.redirect(302, d.avatarUrl)
    if (!d?.avData) return res.status(404).end()
    res.set({ 'Content-Type': 'image/jpeg', 'X-Content-Type-Options': 'nosniff',
      'Cache-Control': req.query.v ? 'public, max-age=31536000, immutable' : 'public, max-age=300' })
    res.send(Buffer.from(d.avData, 'base64'))
  }))

  // ===== Mode dev: kelola suara (id Fish Audio mentah) AI buatan user. Dijaga kode dev yang sama dengan lib/dev.js (okDev). =====
  //   dev/aivoice/list { code, id? }              semua AI buatan (atau satu) + suara mentahnya + pemilik
  //   dev/aivoice/set  { code, id, voices:[{label,id}] }   ganti seluruh daftar suara dev AI itu (kosong = hapus semua)
  const devGate = async (req, res) => {
    const a = await userFromReq(req); if (!a) { noAuth(res); return null }
    if (!(await allow('devav:' + a.user._id, 60, 600))) { res.status(429).json({ error: 'Terlalu sering, tunggu sebentar.' }); return null }
    if (!okDev(req.body?.code)) { res.status(403).json({ error: 'Kode dev salah.' }); return null }
    return a
  }
  const rawVoices = d => (Array.isArray(d.voiceIds) ? d.voiceIds : []).map(v => ({ label: v.label || '', id: v.id }))
  router.post('/api/auth/dev/aivoice/list', wrap(async (req, res) => {
    if (!(await devGate(req, res))) return
    await init()
    const id = String(req.body?.id || '').slice(0, 64)
    const q = id ? (ID_RE.test(id) ? { _id: id } : null) : {}
    if (!q) return res.status(404).json({ error: 'AI tidak ditemukan.' })
    const docs = await (await col('user_chars')).find(q).sort({ updatedAt: -1 }).limit(200).toArray()
    const owners = new Map((await (await col('users')).find({ _id: { $in: [...new Set(docs.map(d => d.ownerId))] } }, { projection: { username: 1 } }).toArray()).map(u => [u._id, u.username]))
    res.json({ ok: true, chars: docs.map(d => ({ id: d._id, name: d.name, owner: owners.get(d.ownerId) || '', voice: d.voiceRef || null, voices: rawVoices(d) })) })
  }))
  router.post('/api/auth/dev/aivoice/set', wrap(async (req, res) => {
    const a = await devGate(req, res); if (!a) return
    await init()
    const id = String(req.body?.id || '').slice(0, 64)
    if (!ID_RE.test(id)) return res.status(404).json({ error: 'AI tidak ditemukan.' })
    const inp = Array.isArray(req.body?.voices) ? req.body.voices.slice(0, 6) : null
    if (!inp) return res.status(400).json({ error: 'Daftar suara tidak valid.' })
    const voices = [], seen = new Set()
    for (const v of inp) {
      const vid = String(v?.id ?? '').trim()
      if (!vid) continue
      if (!/^[\w-]{8,64}$/.test(vid)) return res.status(400).json({ error: `Voice ID "${vid.slice(0, 20)}" tidak valid (8-64 huruf/angka).` })
      if (seen.has(vid)) continue
      seen.add(vid); voices.push({ label: clean(v?.label, 30) || `Voice ${voices.length + 1}`, id: vid })
    }
    const r = await (await col('user_chars')).findOneAndUpdate({ _id: id }, { $set: { voiceIds: voices, updatedAt: new Date() } }, { returnDocument: 'after' })
    const d = r?.value !== undefined ? r.value : r
    if (!d) return res.status(404).json({ error: 'AI tidak ditemukan.' })
    console.warn(`[dev/aivoice] suara AI "${d.name}" (${id}) diubah oleh ${a.user.username} (${a.user._id}): ${voices.length} suara, ${new Date().toISOString()}`)
    clearCustomCache()
    res.json({ ok: true, voices: rawVoices(d) })
  }))
}
