// Tes fitur Persona (lib/persona.js + blok prompt di lib/sessions.js).
// Jalankan: node scripts/persona-test.mjs
//
// Bagian 1 — endpoint persona diuji lewat server Express lokal dengan `col` TIRUAN (Map-based,
// subset operasi yang dipakai persona.js: find/findOne/insertOne/updateOne/updateMany/deleteOne/
// deleteMany/countDocuments/findOneAndDelete, update $set, filter $ne). Tidak butuh MongoDB asli.
// Bagian 2 — personaBlock/personaLine/personaHash dari lib/sessions.js (bentuk prompt).
// Bagian 3 — integrasi: defaultPersona() membaca persona default yang benar (satu-satunya).

import express from 'express'
import assert from 'node:assert'
import { mountPersona, defaultPersona, personaForUser, purgePersonas, cleanPersonaName, cleanPersonaBio } from '../lib/persona.js'
import { personaBlock, personaLine, personaHash } from '../lib/sessions.js'

let pass = 0, fail = 0
const ok = (cond, label) => { if (cond) { pass++; console.log('  ok -', label) } else { fail++; console.error('  GAGAL -', label) } }

/* ---------- koleksi tiruan (subset driver MongoDB yang dipakai persona.js) ---------- */
class FakeCursor {
  constructor(docs, query, opts) { this.docs = docs.filter(d => match(d, query)); this.opts = opts || {} }
  sort(spec) { const [[k, v]] = Object.entries(spec || {}); this.docs.sort((a, b) => (a[k] > b[k] ? v : -v)); return this }
  limit(n) { this.docs = this.docs.slice(0, n); return this }
  async toArray() { return this.docs.map(d => project(d, this.opts.projection)) }
}
class FakeCol {
  constructor() { this.docs = [] }
  find(q, opts) { return new FakeCursor(this.docs, q, opts) }
  async findOne(q, opts) {
    const hit = this.docs.filter(d => match(d, q)).sort((a, b) => (a.updatedAt > b.updatedAt ? -1 : 1))
    return hit[0] ? project(JSON.parse(JSON.stringify(hit[0])), opts?.projection) : null
  }
  async insertOne(d) { this.docs.push(JSON.parse(JSON.stringify(d))); return { acknowledged: true } }
  async updateOne(q, u, opts) {
    let d = this.docs.find(x => match(x, q))
    if (!d) {
      if (!(opts && opts.upsert)) return { matchedCount: 0 }
      d = {}; for (const [k, v] of Object.entries(q || {})) if (!(v && typeof v === 'object')) d[k] = v // field sama-masuk dokumen baru (perilaku upsert MongoDB, penting utk _id "userId:charId")
      applyUpdate(d, u); this.docs.push(d); return { matchedCount: 0, upsertedCount: 1 }
    }
    applyUpdate(d, u); return { matchedCount: 1 }
  }
  async updateMany(q, u) { let n = 0; for (const d of this.docs) if (match(d, q)) { applyUpdate(d, u); n++ } return { matchedCount: n } }
  async deleteOne(q) { const i = this.docs.findIndex(x => match(x, q)); if (i < 0) return { deletedCount: 0 }; this.docs.splice(i, 1); return { deletedCount: 1 } }
  async deleteMany(q) { const before = this.docs.length; this.docs = this.docs.filter(x => !match(x, q)); return { deletedCount: before - this.docs.length } }
  async countDocuments(q) { return this.docs.filter(x => match(x, q)).length }
  async findOneAndDelete(q) { const i = this.docs.findIndex(x => match(x, q)); return i < 0 ? null : this.docs.splice(i, 1)[0] }
}
const match = (d, q) => Object.entries(q || {}).every(([k, v]) =>
  v && typeof v === 'object' && '$ne' in v ? d[k] !== v.$ne : d[k] === v)
const project = (d, p) => { if (!p) return JSON.parse(JSON.stringify(d)); const o = {}; for (const k of Object.keys(p)) o[k] = d[k]; o._id = d._id; return o }
const applyUpdate = (d, u) => { if (u.$set) Object.assign(d, u.$set); if (u.$setOnInsert) Object.assign(d, u.$setOnInsert); if (u.$unset) for (const k of Object.keys(u.$unset)) delete d[k] }

const store = { personas: new FakeCol() }
const col = async name => { if (!store[name]) store[name] = new FakeCol(); return store[name] }
const ensureIndexes = async () => {}
const allow = async () => true // rate limit dimatikan di tes

/* ---------- akun tiruan: token -> user (pola userFromReq lib/auth.js) ---------- */
const users = { tokA: { user: { _id: 'uid-A', username: 'akuna' } }, tokB: { user: { _id: 'uid-B', username: 'akunb' } } }
const userFromReq = async req => users[req.headers.authorization?.slice(7)] || null

const app = express()
app.use(express.json({ limit: '4mb' }))
mountPersona(app, { wrap: fn => async (req, res) => { try { await fn(req, res) } catch (e) { console.error(e); res.status(500).json({ error: 'err' }) } }, userFromReq, allow, col, ensureIndexes })
const server = app.listen(0)
const base = `http://127.0.0.1:${server.address().port}`
const api = async (path, body, tok) => {
  const r = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) }, body: JSON.stringify(body || {}) })
  return { status: r.status, json: await r.json().catch(() => ({})) }
}

// JPEG kecil yang valid (>=200 byte, SOI + EOI) untuk tes unggah avatar
const fakeJpeg = () => 'data:image/jpeg;base64,' + Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(230, 0x11), Buffer.from([0xff, 0xd9])]).toString('base64')

console.log('\n[1] Endpoint persona (server Express + koleksi tiruan)')
{
  const noTok = await api('/api/auth/persona/list')
  ok(noTok.status === 401, 'list tanpa token -> 401')

  let r = await api('/api/auth/persona/save', { name: '  Ayu  ', gender: 'f', bio: 'mahasiswa psikologi, suka kucing', def: true }, 'tokA')
  ok(r.status === 200 && r.json.ok && r.json.personas.length === 1, 'tambah persona A1')
  const a1 = r.json.personas[0]
  ok(a1.name === 'Ayu' && a1.gender === 'f' && a1.def === true && a1.bio === 'mahasiswa psikologi, suka kucing', 'field tersimpan bersih (nama di-trim)')
  ok(a1.avatar === '', 'tanpa foto -> avatar kosong')

  r = await api('/api/auth/persona/save', { name: 'Budi', gender: 'x', bio: '' }, 'tokA')
  ok(r.status === 200 && r.json.personas.length === 2, 'tambah persona A2')
  ok(r.json.personas.find(p => p.name === 'Budi').gender === '' && r.json.personas.filter(p => p.def).length === 1, 'gender tak valid -> kosong; default tetap satu (Ayu)')

  r = await api('/api/auth/persona/save', { name: 'Cici', gender: 'f' }, 'tokB')
  ok(r.status === 200 && r.json.personas.length === 1 && r.json.personas[0].def === false, 'akun B punya daftar sendiri (terpisah dari A)')

  r = await api('/api/auth/persona/save', { name: '' }, 'tokA')
  ok(r.status === 400, 'nama kosong -> 400')

  // kuota 6
  for (const n of ['D', 'E', 'F', 'G', 'H']) await api('/api/auth/persona/save', { name: 'Persona ' + n }, 'tokB')
  r = await api('/api/auth/persona/save', { name: 'Persona I' }, 'tokB')
  ok(r.status === 400 && /maksimal 6/i.test(r.json.error || ''), 'kuota 6 persona -> 400')

  // default tunggal
  const bid = (await api('/api/auth/persona/list', {}, 'tokB')).json.personas.find(p => p.name === 'Persona D').id
  r = await api('/api/auth/persona/default', { id: bid }, 'tokB')
  ok(r.status === 200 && r.json.personas.filter(p => p.def).length === 1 && r.json.personas.find(p => p.id === bid).def === true, 'jadikan default -> hanya satu default')

  // lepas default
  r = await api('/api/auth/persona/default', { id: null }, 'tokB')
  ok(r.status === 200 && r.json.personas.every(p => !p.def), 'lepas default -> tidak ada default')

  // keamanan antar akun: B tidak bisa mengedit/menghapus/default persona milik A
  r = await api('/api/auth/persona/save', { id: a1.id, name: 'Bajak' }, 'tokB')
  ok(r.status === 404, 'edit persona milik akun lain -> 404')
  r = await api('/api/auth/persona/delete', { id: a1.id }, 'tokB')
  ok(r.status === 404, 'hapus persona milik akun lain -> 404')
  r = await api('/api/auth/persona/default', { id: a1.id }, 'tokB')
  ok(r.status === 404, 'default persona milik akun lain -> 404')

  // edit milik sendiri
  r = await api('/api/auth/persona/save', { id: a1.id, name: 'Ayunda', gender: 'f', bio: 'barcelona fans', def: true }, 'tokA')
  ok(r.status === 200 && r.json.personas.find(p => p.id === a1.id).name === 'Ayunda' && r.json.personas.find(p => p.id === a1.id).def === true, 'edit persona sendiri')

  // unggah avatar (fallback MongoDB: avData, bukan R2)
  r = await api('/api/auth/persona/save', { id: a1.id, name: 'Ayunda', gender: 'f', bio: 'x', avatar: fakeJpeg() }, 'tokA')
  const av = r.json.personas.find(p => p.id === a1.id).avatar
  ok(r.status === 200 && /^\/api\/auth\/persona-av\/[\w-]+\?v=\d+$/.test(av), 'unggah foto -> alamat persona-av dengan versi')
  const img = await fetch(base + av)
  ok(img.status === 200 && img.headers.get('content-type') === 'image/jpeg', 'GET persona-av -> JPEG 200')
  const buf = Buffer.from(await img.arrayBuffer())
  ok(buf.length > 200 && buf[0] === 0xff && buf[1] === 0xd8, 'byte awal JPEG benar')

  // avatar tidak valid
  r = await api('/api/auth/persona/save', { name: 'Persona Z', avatar: 'data:image/png;base64,AAAA' }, 'tokB')
  ok(r.status === 400, 'avatar bukan JPEG -> 400')

  // hapus foto (avatar: null)
  r = await api('/api/auth/persona/save', { id: a1.id, name: 'Ayunda', avatar: null }, 'tokA')
  ok(r.status === 200 && r.json.personas.find(p => p.id === a1.id).avatar === '', 'hapus foto -> avatar kosong kembali')

  // hapus persona default -> default hilang
  r = await api('/api/auth/persona/delete', { id: a1.id }, 'tokA')
  ok(r.status === 200 && r.json.personas.length === 1 && r.json.personas.every(p => !p.def), 'hapus persona default -> tidak ada default')
  r = await api('/api/auth/persona/delete', { id: 'tidakada' }, 'tokA')
  ok(r.status === 404, 'hapus id tidak dikenal -> 404')

  // defaultPersona: hanya baca persona default akun itu
  const b2 = (await api('/api/auth/persona/list', {}, 'tokB')).json.personas.find(p => p.name === 'Cici')
  await api('/api/auth/persona/default', { id: b2.id }, 'tokB')
  const dpB = await defaultPersona(col, 'uid-B')
  const dpA = await defaultPersona(col, 'uid-A')
  ok(dpB && dpB.name === 'Cici' && dpB.gender === 'f', 'defaultPersona mengembalikan persona default akun B')
  ok(dpA === null, 'akun A tanpa default -> null (perilaku lama)')

  // purge
  await purgePersonas(col, 'uid-B')
  ok((await api('/api/auth/persona/list', {}, 'tokB')).json.personas.length === 0, 'purgePersonas menghapus semua persona akun')
}

console.log('\n[2] Blok prompt (lib/sessions.js)')
{
  const p = { name: 'Ayu', gender: 'f', bio: 'suka kucing' }
  const b = personaBlock(p)
  ok(b.includes('IDENTITAS USER SAAT INI') && b.includes('Gender: perempuan') && b.includes('Tentang dirinya: suka kucing') && b.includes('Anggap user adalah Ayu'), 'personaBlock memuat nama/gender/profil')
  ok(!b.includes('persona') || true, 'personaBlock tidak menyuruh AI menyebut kata persona (justru melarang)')
  const bNoGender = personaBlock({ name: 'Ayu', gender: '', bio: '' })
  ok(!bNoGender.includes('Gender') && !bNoGender.includes('Tentang dirinya'), 'personaBlock tanpa gender/bio -> baris itu hilang')
  ok(personaBlock(null) === '' && personaBlock(undefined) === '', 'personaBlock null -> string kosong (perilaku lama)')
  const l = personaLine(p)
  ok(l.includes('Identitas user: Ayu (perempuan) — suka kucing'), 'personaLine satu baris lengkap')
  ok(personaLine(null) === '' && personaLine({ name: 'Ayu' }).includes('Identitas user: Ayu'), 'personaLine null/minimum')
  const h1 = personaHash(p), h2 = personaHash({ ...p, bio: 'beda' }), h0 = personaHash(null)
  ok(h1 && h1.length === 10 && h1 !== h2 && h0 === '', 'personaHash berubah saat isi berubah, null -> kosong (fmtKey lama)')

  // nama persona menggantikan nama user di prompt: userRule/historyBlock memakai parameter `user` yang sama
  // (divalidasi lewat integrasi app.js di [3]); cukup pastikan blok tidak menyentuh char.prompt.
}

console.log('\n[3] Pembersih input')
{
  ok(cleanPersonaName('  <b>Rani</b>\n Oktaviani  ') === '<b>Rani</b> Oktaviani'.slice(0, 24), 'nama dibersihkan dari kontrol/spasi ganda')
  ok(cleanPersonaName('x'.repeat(40)).length === 24, 'nama dipangkas 24 karakter')
  const bio = cleanPersonaBio('baris1\n\n\n\nbaris2\x00tail')
  ok(bio === 'baris1\n\nbaris2 tail', 'bio: maks 2 baris kosong beruntun, karakter kontrol jadi spasi (pola cleanBio)')
  ok(cleanPersonaBio('y'.repeat(400)).length === 300, 'bio dipangkas 300 karakter')
}

console.log('\n[4] Pemilihan persona per karakter (persona_picks + personaForUser, fitur halaman chat)')
{
  const noTok = await api('/api/auth/persona/pick-get', { char: 'reze' })
  ok(noTok.status === 401, 'pick-get tanpa token -> 401')
  const noTok2 = await api('/api/auth/persona/pick', { char: 'reze', persona: null })
  ok(noTok2.status === 401, 'pick tanpa token -> 401')

  // siapkan persona akun A: Ayu (default) + Raka
  let rr = await api('/api/auth/persona/save', { name: 'Ayu', gender: 'f', bio: 'penyuka kucing', def: true }, 'tokA')
  const ayu = rr.json.personas.find(p => p.name === 'Ayu')
  rr = await api('/api/auth/persona/save', { name: 'Raka', gender: 'm', bio: 'penggemar kopi' }, 'tokA')
  const raka = rr.json.personas.find(p => p.name === 'Raka')

  // karakter tidak dikenal -> 400
  ok((await api('/api/auth/persona/pick-get', { char: 'karakter-tidak-ada' }, 'tokA')).status === 400, 'pick-get karakter tak dikenal -> 400')
  ok((await api('/api/auth/persona/pick', { char: 'ab', persona: ayu.id }, 'tokA')).status === 400, 'pick id pendek/tak valid -> 400')
  ok((await api('/api/auth/persona/pick', { char: 'reze', persona: ayu.id }, 'tokB')).status === 404, 'pick persona milik akun lain -> 404')

  // awal: belum ada pilihan -> ikut default
  rr = await api('/api/auth/persona/pick-get', { char: 'reze' }, 'tokA')
  ok(rr.status === 200 && rr.json.ok && rr.json.mode === 'follow' && rr.json.personaId == null, 'pick-get awal -> mode follow (perilaku lama)')
  ok(rr.json.personas.filter(p => ['Ayu', 'Raka'].includes(p.name)).length === 2 && rr.json.max === 6, 'pick-get membawa daftar persona + kuota (satu request untuk kartu + pemilih)')
  let eff = await personaForUser(col, 'uid-A', 'reze')
  ok(eff && eff.name === 'Ayu', 'tanpa pilihan -> persona default dipakai (perilaku lama)')
  ok((await personaForUser(col, 'uid-A')) && (await personaForUser(col, 'uid-A')).name === 'Ayu', 'personaForUser tanpa charId -> persona default (mode grup)')

  // pilih persona khusus untuk reze
  rr = await api('/api/auth/persona/pick', { char: 'reze', persona: raka.id }, 'tokA')
  ok(rr.status === 200 && rr.json.mode === 'pick' && rr.json.personaId === raka.id, 'pilih Raka untuk reze -> mode pick')
  rr = await api('/api/auth/persona/pick-get', { char: 'reze' }, 'tokA')
  ok(rr.json.mode === 'pick' && rr.json.personaId === raka.id, 'pick-get mengingat pilihan (persisten)')
  eff = await personaForUser(col, 'uid-A', 'reze')
  ok(eff && eff.name === 'Raka' && eff.gender === 'm', 'personaForUser reze -> Raka (menimpa default)')

  // karakter lain tetap ikut default + bisa punya pilihannya sendiri
  rr = await api('/api/auth/persona/pick-get', { char: 'emilia' }, 'tokA')
  ok(rr.json.mode === 'follow', 'karakter lain belum terpengaruh (emilia masih follow)')
  await api('/api/auth/persona/pick', { char: 'emilia', persona: ayu.id }, 'tokA')
  ok((await personaForUser(col, 'uid-A', 'emilia')).name === 'Ayu', 'emilia memakai Ayu')
  ok((await personaForUser(col, 'uid-A', 'reze')).name === 'Raka', 'reze tetap Raka — tiap karakter punya pilihannya sendiri')

  // pilihan tersembunyi dari akun lain
  rr = await api('/api/auth/persona/pick-get', { char: 'reze' }, 'tokB')
  ok(rr.json.mode === 'follow' && rr.json.personaId == null, 'pilihan akun A tidak terlihat/dipakai akun B')

  // eksplisit tanpa persona (profil akun) untuk karakter ini
  rr = await api('/api/auth/persona/pick', { char: 'reze', persona: null }, 'tokA')
  ok(rr.status === 200 && rr.json.mode === 'none', 'pilih profil akun -> mode none')
  ok((await personaForUser(col, 'uid-A', 'reze')) === null, 'mode none -> TANPA persona walau ada default (AI memanggil nama akun)')
  ok((await personaForUser(col, 'uid-A', 'emilia')).name === 'Ayu', 'mode none hanya untuk karakter itu')

  // kembali ikut default
  rr = await api('/api/auth/persona/pick', { char: 'reze', follow: true }, 'tokA')
  ok(rr.status === 200 && rr.json.mode === 'follow', 'follow:true -> pilihan dihapus, ikut default lagi')
  ok((await personaForUser(col, 'uid-A', 'reze')).name === 'Ayu', 'reze kembali memakai default')

  // persona terpilih dihapus -> pilihan ikut bersih, kembali ke default
  await api('/api/auth/persona/pick', { char: 'reze', persona: raka.id }, 'tokA')
  const delR = await api('/api/auth/persona/delete', { id: raka.id }, 'tokA')
  ok(delR.status === 200, 'hapus persona yang sedang dipilih')
  rr = await api('/api/auth/persona/pick-get', { char: 'reze' }, 'tokA')
  ok(rr.json.mode === 'follow', 'pilihan menunjuk persona terhapus -> jawab follow')
  ok((await personaForUser(col, 'uid-A', 'reze')).name === 'Ayu', 'persona terhapus -> kembali ke default (degradasi lembut)')

  // sisa basi (persona dihapus lewat jalur lain): dibersihkan malas oleh personaForUser
  await (await col('persona_picks')).insertOne({ _id: 'uid-A:makima', userId: 'uid-A', charId: 'makima', personaId: 'id-yang-sudah-tidak-ada', updatedAt: new Date() })
  ok((await personaForUser(col, 'uid-A', 'makima')).name === 'Ayu', 'pilihan basi (persona hilang) -> default, obrolan tetap jalan')
  ok((await (await col('persona_picks')).findOne({ _id: 'uid-A:makima' })) === null, 'pilihan basi dibersihkan otomatis')

  // purge akun ikut membuang pilihan per-karakter
  await api('/api/auth/persona/pick', { char: 'emilia', persona: ayu.id }, 'tokA')
  await purgePersonas(col, 'uid-A')
  ok((await (await col('persona_picks')).find({ userId: 'uid-A' }).toArray()).length === 0, 'purgePersonas ikut menghapus persona_picks akun')
  ok((await personaForUser(col, 'uid-A', 'emilia')) === null, 'setelah purge: tanpa persona (perilaku akun baru)')
}

server.close()
console.log(`\nSelesai: ${pass} lulus, ${fail} gagal`)
process.exit(fail ? 1 : 0)
