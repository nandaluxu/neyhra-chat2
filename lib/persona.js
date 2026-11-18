// Persona user: identitas alternatif PENGGUNA (bukan persona AI — karakter sudah punya identitas sendiri di char/*.js).
// Dipakai di tab Profil > Persona (public/profile.js), pemilihan persona per karakter di panel Detail karakter
// (public/index.html), dan sebagai konteks prompt AI (nama/gender/profil user).
//
// Koleksi MongoDB:
//   personas { _id: UUID, userId, name (maks 24), gender ('m'|'f'|''), bio (maks 300, profil karakter user),
//              av (versi foto), avatarUrl + avKey (foto di Cloudflare R2, mode utama),
//              avData (JPEG base64, HANYA mode cadangan tanpa env R2 — pola koleksi `avatars` di lib/profile.js),
//              def (true = persona default: DIPAKAI DI SELURUH PROMPT AI), createdAt, updatedAt }
//   Index {userId:1, def:1} + {userId:1, updatedAt:-1}. "Hanya satu default" ditegakkan lewat updateMany-lalu-updateOne
//   saat set default; defaultPersona() juga meng-sort deterministik supaya kondisi lomba kecil pun tetap satu jawaban.
//
//   persona_picks { _id: "<userId>:<charId>", userId, charId, personaId (id persona | null), updatedAt }
//   Pilihan persona KHUSUS PER KARAKTER (dipilih dari halaman chat, panel Detail karakter):
//     - dokumen tidak ada            -> ikut persona default (perilaku lama)
//     - personaId = id persona       -> persona itu dipakai khusus untuk chat dengan karakter itu
//     - personaId = null             -> eksplisit tanpa persona untuk karakter itu (AI memanggil nama akun)
//   _id gabungan mencegah dobel pilihan per (user, karakter). Index {userId:1} untuk pembersihan saat akun dihapus.
//   Persona yang terhapus ikut membuang pilihan yang menunjuknya (deleteMany saat persona/delete + bersih-bersih
//   malas di personaForUser kalau ada sisa balapan).
//
// Endpoint (POST kecuali dicatat, semua butuh token Bearer kecuali avatar):
//   persona/list                          daftar persona milik sendiri + kuota
//   persona/save   { id?, name, gender, bio, avatar?, def? }   tambah/edit; avatar = data URL JPEG / null hapus / tanpa field = biarkan
//   persona/delete { id }                 hapus persona (foto di R2 ikut dibuang; pilihan per-karakter yang menunjuk ikut dibersihkan)
//   persona/default { id | null }         jadikan default satu-satunya / lepas default
//   persona/pick   { char, persona }      pilih persona untuk SATU karakter (persona = id | null); { char, follow:true } = ikut default lagi
//   persona/pick-get { char }             status pilihan untuk satu karakter + daftar persona (satu request untuk kartu + pemilih)
//   GET persona-av/:id?v=                 foto persona (JPEG) — id UUID acak tidak bisa ditebak (pola gc/<hex>.jpg), fallback MongoDB
//
// Integrasi prompt AI (nama user diganti nama persona + blok identitas): lib/sessions.js personaBlock/personaLine,
// lib/app.js personaFor() di /api/chat /api/proactive /api/memory, lib/scenario.js (sutradara/aktor/AI Hasilkan).
// Resolusi: pilihan per-karakter menimpa default; tanpa keduanya semua jalur AI berperilaku seperti sebelum fitur ini.

import crypto from 'node:crypto'
import { r2Enabled, r2Put, r2Delete, r2PublicUrl } from './r2.js'
import { avatarBuffer } from './profile.js'
import { loadChars } from './chars.js'

const NAME_MAX = 24, BIO_MAX = 300, MAX_PERSONAS = 6, ID_RE = /^[\w-]{8,64}$/, CHAR_RE = /^[\w-]{1,64}$/ // CHAR_RE longgar: id karakter bisa pendek ("aki", "rem") — kebenaran tetap dicek ke loadChars()

export const cleanPersonaName = s => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX)
export const cleanPersonaBio = s => String(s ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ')
  .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, BIO_MAX)
const cleanGender = g => g === 'm' || g === 'f' ? g : ''
const genderText = g => g === 'f' ? 'perempuan' : g === 'm' ? 'laki-laki' : ''

// bentuk yang dikirim ke browser (tanpa avData/avKey — data internal tidak keluar)
const pubPersona = p => ({ id: p._id, name: p.name, gender: p.gender || '', bio: p.bio || '', def: p.def === true, avatar: p.avatarUrl || (p.avData ? `/api/auth/persona-av/${p._id}?v=${p.av || 0}` : '') })

// Persona default user untuk prompt AI. Return { name, gender, bio } atau null. Gagal baca = null (chat jalan seperti biasa).
export async function defaultPersona(col, userId) {
  try {
    const p = await (await col('personas')).findOne({ userId, def: true }, { projection: { name: 1, gender: 1, bio: 1 }, sort: { updatedAt: -1 } })
    return p ? { name: p.name, gender: cleanGender(p.gender), bio: p.bio || '' } : null
  } catch (e) { console.error('[persona] baca default gagal:', e?.message); return null }
}

// Persona EFECTIF untuk satu karakter (dipakai prompt AI): pilihan per-karakter (persona_picks) menimpa default.
// Urutan: pilihan personaId -> persona itu; pilihan null -> tanpa persona (nama akun); tanpa pilihan -> persona default.
// Persona terpilih yang sudah terhapus dianggap tidak ada pilihan (pilihan basi dibersihkan, lanjut ke default).
// Gagal baca apa pun = null supaya chat tetap jalan seperti tanpa persona. Diekspor untuk lib/app.js dan lib/scenario.js.
export async function personaForUser(col, userId, charId) {
  try {
    if (charId) {
      const pick = await (await col('persona_picks')).findOne({ _id: userId + ':' + charId })
      if (pick) {
        if (pick.personaId == null) return null // eksplisit: karakter ini mengenal nama akun, bukan persona
        const p = await (await col('personas')).findOne({ _id: pick.personaId, userId }, { projection: { name: 1, gender: 1, bio: 1 } })
        if (p) return { name: p.name, gender: cleanGender(p.gender), bio: p.bio || '' }
        await (await col('persona_picks')).deleteOne({ _id: pick._id }).catch(() => {}) // sisa basi: persona sudah dihapus
      }
    }
    return await defaultPersona(col, userId)
  } catch (e) { console.error('[persona] baca pilihan karakter gagal:', e?.message); return null }
}

// Hapus semua persona milik satu akun (dipanggil saat akun dihapus lewat /api/auth/delete)
export async function purgePersonas(col, userId) {
  const c = await col('personas')
  const rows = await c.find({ userId }, { projection: { avKey: 1 } }).toArray()
  if (r2Enabled()) for (const r of rows) if (r.avKey) await r2Delete(r.avKey).catch(e => console.error('[r2] hapus foto persona gagal:', e.message))
  await c.deleteMany({ userId })
  await (await col('persona_picks')).deleteMany({ userId }) // pilihan per-karakter ikut hilang bersama akunnya
}

export function mountPersona(router, { wrap, userFromReq, allow, col, ensureIndexes }) {
  let ready
  const init = () => ready ??= ensureIndexes('personas', [[{ userId: 1, def: 1 }], [{ userId: 1, updatedAt: -1 }]])
    .then(() => ensureIndexes('persona_picks', [[{ userId: 1 }]])).catch(e => { ready = null; throw e })
  const noAuth = res => res.status(401).json({ error: 'Sesi berakhir, masuk lagi.' })
  const list = async userId => (await (await col('personas')).find({ userId }).sort({ updatedAt: -1 }).toArray()).map(pubPersona)
  const ans = (res, personas) => res.json({ ok: true, personas, max: MAX_PERSONAS })

  router.post('/api/auth/persona/list', wrap(async (req, res) => {
    const a = await userFromReq(req); if (!a) return noAuth(res)
    if (!(await allow('plist:' + a.user._id, 120, 60))) return res.status(429).json({ error: 'Terlalu sering, tunggu sebentar.' })
    await init()
    ans(res, await list(a.user._id))
  }))

  router.post('/api/auth/persona/save', wrap(async (req, res) => {
    const a = await userFromReq(req); if (!a) return noAuth(res)
    if (!(await allow('psv:' + a.user._id, 30, 3600))) return res.status(429).json({ error: 'Terlalu sering menyimpan persona, coba lagi nanti.' })
    await init()
    const b = req.body || {}
    const name = cleanPersonaName(b.name)
    if (!name) return res.status(400).json({ error: 'Nama persona tidak boleh kosong.' })
    const gender = cleanGender(b.gender), bio = cleanPersonaBio(b.bio)
    const personas = await col('personas')
    const id = typeof b.id === 'string' ? b.id.slice(0, 64) : ''
    const edit = id ? await personas.findOne({ _id: id, userId: a.user._id }) : null // selalu difilter userId: persona orang lain = tidak ada
    if (id && !edit) return res.status(404).json({ error: 'Persona tidak ditemukan.' })
    if (!edit) {
      const n = await personas.countDocuments({ userId: a.user._id })
      if (n >= MAX_PERSONAS) return res.status(400).json({ error: `Maksimal ${MAX_PERSONAS} persona. Hapus yang tidak terpakai dulu.` })
    }

    // avatar: tanpa field = biarkan; null = hapus; string data URL JPEG = ganti (pola profile/edit di lib/profile.js)
    const set = { name, gender, bio, updatedAt: new Date() }
    let newKey = '', oldKey = ''
    if ('avatar' in b) {
      if (!(await allow('ppav:' + a.user._id, 12, 3600))) return res.status(429).json({ error: 'Terlalu sering mengganti foto, coba lagi nanti.' })
      oldKey = edit?.avKey || ''
      if (b.avatar === null) { set.av = 0; set.avatarUrl = ''; set.avKey = ''; set.avData = '' }
      else {
        const buf = avatarBuffer(b.avatar)
        if (!buf) return res.status(400).json({ error: 'Foto tidak valid (harus JPEG, maks 100 KB).' })
        const v = Date.now()
        if (r2Enabled()) {
          newKey = `persona/${crypto.randomBytes(12).toString('hex')}.jpg` // nama acak: alamat tidak bisa ditebak, tak perlu cache-busting
          try { await r2Put(newKey, buf, 'image/jpeg') }
          catch (e) {
            console.error('[r2] unggah foto persona gagal:', e.message)
            return res.status(502).json({ error: 'Gagal menyimpan foto' + (e.status ? ` (kode R2: ${e.status}). Cek pengaturan R2 di server.` : ' (server tidak bisa menghubungi R2). Cek pengaturan R2 di server.') })
          }
          set.avatarUrl = r2PublicUrl(newKey); set.avKey = newKey; set.avData = ''; set.av = v
        } else { // tanpa env R2: JPEG base64 ikut dokumen persona (pola fallback `avatars` di lib/profile.js)
          set.avData = buf.toString('base64'); set.av = v; set.avatarUrl = ''; set.avKey = ''
        }
      }
    }

    let docId = edit?._id
    try {
      if (edit) await personas.updateOne({ _id: edit._id, userId: a.user._id }, { $set: set })
      else {
        docId = crypto.randomUUID()
        await personas.insertOne({ _id: docId, userId: a.user._id, name, gender, bio, av: set.av || 0, avatarUrl: set.avatarUrl || '', avKey: set.avKey || '', avData: set.avData || '', def: false, createdAt: new Date(), updatedAt: set.updatedAt })
      }
    } catch (e) { if (newKey) await r2Delete(newKey).catch(() => {}); throw e } // database gagal: jangan tinggalkan objek yatim di bucket

    if (newKey && oldKey && oldKey !== newKey) await r2Delete(oldKey).catch(e => console.error('[r2] hapus foto persona lama gagal:', e.message)) // foto baru sudah tercatat

    // default: hanya satu. def=true -> bersihkan default lain lalu angkat ini; def=false pada persona yang tadinya default -> turunkan.
    if (b.def === true) {
      await personas.updateMany({ userId: a.user._id, def: true, _id: { $ne: docId } }, { $set: { def: false } })
      await personas.updateOne({ _id: docId, userId: a.user._id }, { $set: { def: true } })
    } else if (edit && b.def === false && edit.def) {
      await personas.updateOne({ _id: edit._id, userId: a.user._id }, { $set: { def: false } })
    }
    ans(res, await list(a.user._id))
  }))

  router.post('/api/auth/persona/delete', wrap(async (req, res) => {
    const a = await userFromReq(req); if (!a) return noAuth(res)
    if (!(await allow('pdel:' + a.user._id, 60, 600))) return res.status(429).json({ error: 'Terlalu sering, tunggu sebentar.' })
    await init()
    const id = String(req.body?.id || '').slice(0, 64)
    const p = await (await col('personas')).findOneAndDelete({ _id: id, userId: a.user._id })
    if (!p) return res.status(404).json({ error: 'Persona tidak ditemukan.' })
    if (p.avKey && r2Enabled()) await r2Delete(p.avKey).catch(e => console.error('[r2] hapus foto persona gagal:', e.message))
    await (await col('persona_picks')).deleteMany({ userId: a.user._id, personaId: id }) // pilihan per-karakter yang menunjuk persona ini kembali ikut default
    ans(res, await list(a.user._id)) // persona default ikut hilang -> perilaku AI kembali seperti tanpa persona
  }))

  router.post('/api/auth/persona/default', wrap(async (req, res) => {
    const a = await userFromReq(req); if (!a) return noAuth(res)
    if (!(await allow('pdef:' + a.user._id, 60, 60))) return res.status(429).json({ error: 'Terlalu sering, tunggu sebentar.' })
    await init()
    const personas = await col('personas')
    if (req.body?.id == null) { // lepas default (tidak ada persona default -> perilaku lama)
      await personas.updateMany({ userId: a.user._id, def: true }, { $set: { def: false } })
      return ans(res, await list(a.user._id))
    }
    const id = String(req.body.id).slice(0, 64)
    const p = await personas.findOne({ _id: id, userId: a.user._id })
    if (!p) return res.status(404).json({ error: 'Persona tidak ditemukan.' })
    await personas.updateMany({ userId: a.user._id, def: true, _id: { $ne: id } }, { $set: { def: false } }) // satu-satunya cara jadi default
    await personas.updateOne({ _id: id, userId: a.user._id }, { $set: { def: true } })
    ans(res, await list(a.user._id))
  }))

  // Pemilihan persona PER KARAKTER (halaman chat, panel Detail karakter). Tiga keadaan:
  //   { char, persona: "<id>" }  -> persona itu khusus untuk karakter itu
  //   { char, persona: null }    -> eksplisit tanpa persona untuk karakter itu (AI memanggil nama akun)
  //   { char, follow: true }     -> hapus pilihan, ikut persona default lagi (perilaku sebelumnya)
  router.post('/api/auth/persona/pick', wrap(async (req, res) => {
    const a = await userFromReq(req); if (!a) return noAuth(res)
    if (!(await allow('pset:' + a.user._id, 60, 60))) return res.status(429).json({ error: 'Terlalu sering, tunggu sebentar.' })
    await init()
    const b = req.body || {}
    const charId = typeof b.char === 'string' ? b.char.slice(0, 64) : ''
    if (!CHAR_RE.test(charId) || !(await loadChars()).some(c => c.id === charId)) return res.status(400).json({ error: 'Karakter tidak dikenal.' })
    const picks = await col('persona_picks')
    if (b.follow === true) {
      await picks.deleteOne({ _id: a.user._id + ':' + charId })
      return res.json({ ok: true, mode: 'follow', personaId: null })
    }
    if (b.persona == null) { // eksplisit "profil akun" untuk karakter ini
      await picks.updateOne({ _id: a.user._id + ':' + charId }, { $set: { userId: a.user._id, charId, personaId: null, updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } }, { upsert: true })
      return res.json({ ok: true, mode: 'none', personaId: null })
    }
    const id = String(b.persona).slice(0, 64)
    const p = await (await col('personas')).findOne({ _id: id, userId: a.user._id }, { projection: { _id: 1 } }) // persona orang lain = tidak ada
    if (!p) return res.status(404).json({ error: 'Persona tidak ditemukan.' })
    await picks.updateOne({ _id: a.user._id + ':' + charId }, { $set: { userId: a.user._id, charId, personaId: id, updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } }, { upsert: true })
    res.json({ ok: true, mode: 'pick', personaId: id })
  }))

  // Status pilihan satu karakter + daftar persona lengkap (satu request: kartu di panel detail + isi pemilih persona).
  // mode: 'follow' (tidak ada pilihan -> ikut default) | 'none' (eksplisit profil akun) | 'pick' (personaId terisi).
  router.post('/api/auth/persona/pick-get', wrap(async (req, res) => {
    const a = await userFromReq(req); if (!a) return noAuth(res)
    if (!(await allow('pget:' + a.user._id, 120, 60))) return res.status(429).json({ error: 'Terlalu sering, tunggu sebentar.' })
    await init()
    const charId = typeof req.body?.char === 'string' ? req.body.char.slice(0, 64) : ''
    if (!CHAR_RE.test(charId) || !(await loadChars()).some(c => c.id === charId)) return res.status(400).json({ error: 'Karakter tidak dikenal.' })
    const pick = await (await col('persona_picks')).findOne({ _id: a.user._id + ':' + charId })
    const personas = await list(a.user._id)
    let mode = 'follow', personaId = null
    if (pick) {
      if (pick.personaId == null) mode = 'none'
      else if (personas.some(p => p.id === pick.personaId)) { mode = 'pick'; personaId = pick.personaId }
      // persona terpilih sudah dihapus -> jawab 'follow' (personaForUser juga membersihkan sisa basinya)
    }
    res.json({ ok: true, mode, personaId, personas, max: MAX_PERSONAS })
  }))

  router.get('/api/auth/persona-av/:id', wrap(async (req, res) => {
    const id = String(req.params.id || '')
    if (!ID_RE.test(id)) return res.status(404).end()
    const p = await (await col('personas')).findOne({ _id: id }, { projection: { avatarUrl: 1, avData: 1, av: 1 } })
    if (p?.avatarUrl) return res.redirect(302, p.avatarUrl) // foto di R2
    if (!p?.avData) return res.status(404).end()
    res.set({ 'Content-Type': 'image/jpeg', 'X-Content-Type-Options': 'nosniff', // alamat memuat ?v=<versi>, aman di-cache lama
      'Cache-Control': req.query.v ? 'public, max-age=31536000, immutable' : 'public, max-age=300' })
    res.send(Buffer.from(p.avData, 'base64'))
  }))
}
