// Test end-to-end HUBUNGAN 500 + saklar fitur hubungan AI buatan user (relOn/relStages) TANPA MongoDB asli:
// mock koleksi in-memory (salinan scripts/chessmp-e2e.mjs). Yang diuji:
//   [1] lib/relation.js — LVL_MAX 500, kurva EXP, 12 tahap (6 baru di Lv 100+), stateBlock dengan relStages khusus
//   [2] lib/chars.js — normRelStages/relStageNames + toChar (lewat loadChars + injeksi cache __neyhraCustomChars)
//   [3] lib/userchars.js — aichar/save: relOn default/ubah, relStages ganti seluruhnya/sanitasi
//   [4] lib/shop.js — hadiah ditolak untuk AI relOn=false (lewat untuk yang aktif)
// Jalankan: node scripts/rel500-e2e.mjs
import express from 'express'

/* ---------- Mock Mongo (salinan dari scripts/chessmp-e2e.mjs) ---------- */
const clone = d => (d && typeof d === 'object') ? JSON.parse(JSON.stringify(d)) : d
const getPath = (o, p) => p.split('.').reduce((a, k) => (a == null ? undefined : a[k]), o)
const setPath = (o, p, v) => { const ks = p.split('.'); const last = ks.pop(); let t = o; for (const k of ks) { if (t[k] == null || typeof t[k] !== 'object') t[k] = {}; t = t[k] } t[last] = v }
function match(d, q) {
  if (!q || typeof q !== 'object') return true
  for (const [k, v] of Object.entries(q)) {
    const cur = getPath(d, k)
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const [op, val] of Object.entries(v)) {
        if (op === '$gte' && !(cur >= val)) return false
        if (op === '$gt' && !(cur > val)) return false
        if (op === '$lt' && !(cur < val)) return false
        if (op === '$ne' && cur === val) return false
        if (op === '$exists' && (val ? cur === undefined : cur !== undefined)) return false
        if (op === '$in' && !val.includes(cur)) return false
      }
      continue
    }
    if (cur !== v) return false
  }
  return true
}
function applyUpdate(d, upd) {
  for (const [op, spec] of Object.entries(upd)) {
    if (op === '$set') for (const [k, v] of Object.entries(spec)) setPath(d, k, clone(v))
    else if (op === '$inc') for (const [k, v] of Object.entries(spec)) setPath(d, k, (getPath(d, k) ?? 0) + v)
    else if (op === '$setOnInsert') { /* ditangani saat insert */ }
  }
  return d
}
class MemCol {
  constructor(name) { this.name = name; this.docs = new Map() }
  async insertOne(d) { if (this.docs.has(d._id)) { const e = new Error('dup'); e.code = 11000; throw e } this.docs.set(d._id, clone(d)); return { acknowledged: true } }
  async findOne(q) { for (const d of this.docs.values()) if (match(d, q)) return clone(d); return null }
  async findOneAndUpdate(q, upd, opts = {}) {
    for (const [id, d] of this.docs) {
      if (match(d, q)) { const before = clone(d); applyUpdate(d, upd); return opts.returnDocument === 'before' ? before : clone(d) }
    }
    if (opts.upsert) {
      const fresh = {}
      for (const [k, v] of Object.entries(q)) if (typeof v !== 'object' || v === null) setPath(fresh, k, clone(v))
      if (upd.$setOnInsert) for (const [k, v] of Object.entries(upd.$setOnInsert)) setPath(fresh, k, clone(v))
      applyUpdate(fresh, upd)
      if (fresh._id === undefined) fresh._id = 'mock-' + Math.random().toString(36).slice(2)
      this.docs.set(fresh._id, fresh)
      return opts.returnDocument === 'before' ? null : clone(fresh)
    }
    return null
  }
  async updateOne(q, upd) { return this.findOneAndUpdate(q, upd, { returnDocument: 'after' }).then(() => ({ acknowledged: true, matchedCount: 1 })) }
  async countDocuments(q) { let n = 0; for (const d of this.docs.values()) if (match(d, q)) n++; return n }
  find(q) {
    const self = this
    let rows = [...self.docs.values()].filter(d => match(d, q)).map(clone)
    return {
      sort(s) { if (s) for (const [k, dir] of Object.entries(s).reverse()) rows.sort((a, b) => (getPath(a, k) > getPath(b, k) ? dir : -(dir))); return this },
      async toArray() { return rows }
    }
  }
}
const cols = {}
const col = async name => cols[name] ??= new MemCol(name)
const ensureIndexes = async () => { }

/* ---------- Sesi tiruan ---------- */
const USERS = { tokA: { _id: 'u-aura', username: 'aura', name: 'Aura' } }
const userFromReq = async req => {
  const m = /^Bearer (\w+)$/.exec(req.headers.authorization || '')
  return m && USERS[m[1]] ? { user: USERS[m[1]], sid: 's' } : null
}
const wrap = fn => async (req, res) => { try { await fn(req, res) } catch (e) { console.error('test-wrap:', e); res.status(500).json({ error: 'err', msg: String(e?.message) }) } }
const allow = async () => true
const ensureWallet = async u => u

let PASS = 0, FAIL = 0
const ok = (cond, name, extra) => { if (cond) { PASS++; console.log('  ok -', name) } else { FAIL++; console.error('  GAGAL -', name, extra !== undefined ? JSON.stringify(extra)?.slice(0, 400) : '') } }

/* MONGODB_URI palsu: mongoEnabled() jadi true (customChars diproses) tapi koneksi asli tidak pernah
   dibuka — semua koleksi diuji lewat mock col di atas, dan cache __neyhraCustomChars dijaga segar. */
process.env.MONGODB_URI = 'mongodb://127.0.0.1:1/tidak-ada'
process.env.MONGODB_DB = 'test'

const R = await import('../lib/relation.js')
const CH = await import('../lib/chars.js')

try {
  console.log('== [1] lib/relation.js: maks level 500 + tahap baru 100+ ==')
  ok(R.LVL_MAX === 500, 'LVL_MAX = 500', R.LVL_MAX)
  ok(R.EXP_MAX === 386725, 'EXP_MAX = 386.725 (total EXP untuk Lv 500)', R.EXP_MAX)
  ok(R.expAtLevel(1) === 0 && R.expAtLevel(100) === 17325 && R.expAtLevel(500) === 386725, 'kurva EXP tidak bergeser: Lv 1/100/500 = 0/17.325/386.725', [R.expAtLevel(1), R.expAtLevel(100), R.expAtLevel(500)])
  ok(R.levelOf(0) === 1 && R.levelOf(R.expAtLevel(99)) === 99 && R.levelOf(R.expAtLevel(100) - 1) === 99 && R.levelOf(R.expAtLevel(100)) === 100 && R.levelOf(386725) === 500 && R.levelOf(9999999) === 500, 'levelOf: EXP lama tetap level lama, maks 500', [R.levelOf(R.expAtLevel(99)), R.levelOf(R.expAtLevel(100))])
  const names = R.STAGES.map(s => s.name)
  ok(names.join('|') === 'Kenalan|Teman|Sahabat|Spesial|Pasangan|Belahan Jiwa|Seumur Hidup|Tak Terpisahkan|Ikatan Takdir|Sejiwa|Sumpah Abadi|Kekal', '12 tahap: 6 lama + Seumur Hidup(100), Tak Terpisahkan(150), Ikatan Takdir(200), Sejiwa(300), Sumpah Abadi(400), Kekal(500)', names)
  ok(R.STAGES.map(s => s.min).join(',') === '1,6,15,30,50,75,100,150,200,300,400,500', 'batas tahap naik monoton', R.STAGES.map(s => s.min))
  ok(R.stageIdx(99) === 5 && R.stageIdx(100) === 6 && R.stageIdx(499) === 10 && R.stageIdx(500) === 11, 'stageIdx: 99=Belahan Jiwa, 100=Seumur Hidup, 500=Kekal', [R.stageIdx(99), R.stageIdx(100), R.stageIdx(500)])
  ok(R.cleanState({ rel: 9999999 }).rel === R.EXP_MAX, 'cleanState clamp EXP ke maks baru', R.cleanState({ rel: 9999999 }).rel)
  const rd = R.readDeltas({ rel: '+2', mood: '+3' }, { mood: 50 })
  ok(rd.dExp === 2 * R.EXP_PER_POINT + R.EXP_BASE_MSG && rd.dMood === 3, 'readDeltas tidak berubah (sanity)', rd)

  const st = { rel: R.expAtLevel(200), mood: 50, shift: '' } // Lv 200 = Ikatan Takdir
  const blk = R.stateBlock({ name: 'X' }, st)
  ok(blk.includes('tahap "Ikatan Takdir"') && blk.includes('200/500'), 'stateBlock bawaan: tahap + level/500', blk.slice(0, 200))
  const custom = new Array(12).fill(null).map((_, i) => i === 8 ? { name: 'Teman Takdir', rule: 'Bersikap seperti detektif yang menolong user.' } : {})
  const blk2 = R.stateBlock({ name: 'X', relStages: custom }, st)
  ok(blk2.includes('tahap "Teman Takdir"') && blk2.includes('Bersikap seperti detektif'), 'stateBlock + relStages: nama & rule khusus dipakai di tahap itu', blk2.slice(0, 200))
  ok(!blk2.includes('Ikatan Takdir'), 'nama bawaan tertimpa nama khusus', blk2.slice(0, 200))
  const blk3 = R.stateBlock({ name: 'X', relStages: custom }, { rel: R.expAtLevel(6) - 1, mood: 50, shift: '' }) // Lv 5 = Kenalan (entri kosong)
  ok(blk3.includes('tahap "Kenalan"') && blk3.includes('Kamu baru kenal user'), 'entri kosong = tahap bawaan', blk3.slice(0, 200))
  const onlyName = custom.map((x, i) => i === 8 ? { name: 'Soulmate' } : {})
  const blk4 = R.stateBlock({ name: 'X', relStages: onlyName }, st)
  ok(blk4.includes('tahap "Soulmate"') && blk4.includes('takdir'), 'nama khusus tanpa rule = nama khusus + rule bawaan', blk4.slice(0, 300))
  const pc = R.publicConfig()
  ok(pc.maxLevel === 500 && pc.stages.length === 12 && pc.stages.every(s => !('rule' in s)), 'publicConfig: maks 500, 12 tahap, rule tidak bocor ke browser', pc.stages[6])

  console.log('\n== [2] lib/chars.js: normRelStages + toChar ==')
  ok(CH.normRelStages(null).length === 0, 'normRelStages: non-array -> []')
  const ns = CH.normRelStages([{ name: 'A<b>', rule: 'x\n y  <>z' }])
  ok(ns[0].name === 'A b' && ns[0].rule === 'x y z', 'sanitasi: <>, baris baru, spasi ganda dibersihkan', ns)
  ok(CH.normRelStages(new Array(15).fill({ name: 'x' })).length === 12, 'maks 12 entri')
  ok(CH.normRelStages([{}, { name: 'X' }]).length === 2, 'entri kosong TETAP disimpan (index sejajar STAGES)', CH.normRelStages([{}, { name: 'X' }]))
  ok(CH.relStageNames({}) === null && CH.relStageNames({ relStages: [{}, {}] }) === null, 'relStageNames: tanpa nama khusus -> null')
  ok(JSON.stringify(CH.relStageNames({ relStages: [{ name: 'Musuh' }, {}] })) === JSON.stringify(['Musuh', '']), 'relStageNames: hanya nama, entri kosong tetap string kosong', CH.relStageNames({ relStages: [{ name: 'Musuh' }, {}] }))

  // toChar lewat loadChars: injeksi cache custom (CG) + MONGODB_URI palsu, tanpa menyentuh Mongo asli
  const docOff = { _id: 'u_0123456789abcdef', ownerId: 'u-aura', name: 'Relkit', tagline: 'AI uji hubungan', identity: 'Robot uji.', speech: '', rules: '', voiceIds: [], voiceRef: null, public: true, relOn: false, relStages: custom, updatedAt: new Date() }
  const CG = globalThis.__neyhraCustomChars ??= { at: 0, list: [] }
  const inject = d => { CG.list = [d]; CG.at = Date.now() } // jaga cache segar supaya loadChars tidak mencoba Mongo asli
  inject(docOff)
  const all = await CH.loadChars()
  const kit = all.find(c => c.id === 'u_0123456789abcdef')
  ok(!!kit && kit.custom, 'AI buatan termuat lewat cache custom')
  ok(kit.relOn === false, 'toChar: relOn=false terbawa')
  ok(kit.relStages.length === 12 && kit.relStages[8].name === 'Teman Takdir', 'toChar: relStages terbawa utuh (sejajar 12 tahap)', kit.relStages && kit.relStages[8])
  const bawaan = all.find(c => !c.custom)
  ok(bawaan && bawaan.relOn !== false, 'karakter bawaan: relOn tidak pernah false (fitur selalu aktif)', bawaan && bawaan.relOn)
  const blkKit = R.stateBlock(kit, st)
  ok(blkKit.includes('tahap "Teman Takdir"') && blkKit.includes('Bersikap seperti detektif'), 'wiring penuh: loadChars -> stateBlock memakai tahap khusus milik AI itu', blkKit.slice(0, 200))

  console.log('\n== [3] aichar/save: relOn + relStages ==')
  const { mountUserChars } = await import('../lib/userchars.js')
  const router = express.Router()
  router.use(express.json({ limit: '1mb' }))
  mountUserChars(router, { wrap, userFromReq, allow, col, ensureIndexes })
  const app = express(); app.use(router)
  const server = app.listen(0)
  const BASE = `http://127.0.0.1:${server.address().port}`
  const call = async (path, body) => {
    const r = await fetch(BASE + path, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer tokA' }, body: JSON.stringify(body ?? {}) })
    return { status: r.status, json: await r.json().catch(() => null) }
  }
  let r = await call('/api/auth/aichar/save', { name: 'Polos', identity: 'AI tanpa hubungan.', personality: 'Tenang.' })
  ok(r.status === 200 && r.json.ok, 'AI baru tersimpan', r.json)
  const idPolos = r.json.chars[0].id
  ok(r.json.chars[0].relOn === true && JSON.stringify(r.json.chars[0].relStages) === '[]', 'AI baru tanpa field rel: fitur hubungan AKTIF + relStages kosong (perilaku lama)', r.json.chars[0])
  r = await call('/api/auth/aichar/save', { id: idPolos, name: 'Polos', identity: 'AI tanpa hubungan.', personality: 'Tenang.', relOn: false })
  ok(r.status === 200 && r.json.chars[0].relOn === false, 'relOn:false tersimpan', r.json.chars[0])
  r = await call('/api/auth/aichar/save', { id: idPolos, name: 'Polos', identity: 'AI tanpa hubungan.', personality: 'Tenang.', relStages: custom })
  ok(r.json.chars[0].relOn === false && r.json.chars[0].relStages.length === 12, 'relStages bisa diisi walau hubungan mati (tersimpan, tidak dipakai prompt)', r.json.chars[0])
  r = await call('/api/auth/aichar/save', { id: idPolos, name: 'Polos', identity: 'AI tanpa hubungan.', personality: 'Tenang.', relOn: true, relStages: [{ name: 'Musuh <berat>', rule: 'Kaku dan dingin ke <user>.' }] })
  const saved = r.json.chars[0]
  ok(saved.relOn === true && saved.relStages.length === 1 && saved.relStages[0].name === 'Musuh berat' && !saved.relStages[0].rule.includes('<'), 'relOn:true + relStages diganti seluruhnya + sanitasi server', saved)
  r = await call('/api/auth/aichar/save', { id: idPolos, name: 'Polos', identity: 'AI tanpa hubungan.', personality: 'Tenang.' })
  ok(r.json.chars[0].relOn === true && r.json.chars[0].relStages.length === 1, 'tanpa field rel = kedua field tidak diubah (biarkan)', r.json.chars[0])
  r = await call('/api/auth/aichar/save', { id: idPolos, name: 'Polos', identity: 'AI tanpa hubungan.', personality: 'Tenang.', relStages: [] })
  ok(r.json.chars[0].relStages.length === 0, 'relStages [] = kembali ke bawaan', r.json.chars[0])

  console.log('\n== [4] shop/gift: ditolak untuk AI tanpa hubungan ==')
  const { mountShop } = await import('../lib/shop.js')
  const router2 = express.Router()
  router2.use(express.json({ limit: '1mb' }))
  mountShop(router2, { wrap, userFromReq, allow, col, ensureWallet })
  const app2 = express(); app2.use(router2)
  const server2 = app2.listen(0)
  const BASE2 = `http://127.0.0.1:${server2.address().port}`
  const call2 = async (path, body) => {
    const r = await fetch(BASE2 + path, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer tokA' }, body: JSON.stringify(body ?? {}) })
    return { status: r.status, json: await r.json().catch(() => null) }
  }
  inject({ ...docOff, relOn: false }) // karakter aktif untuk guard hadiah
  let g = await call2('/api/auth/shop/gift', { char: 'u_0123456789abcdef', items: { bunga: 1 } })
  ok(g.status === 400 && (g.json.error || '').includes('tidak memakai sistem hubungan'), 'hadiah ke AI relOn=false ditolak dengan pesan jelas', g)
  inject({ ...docOff, relOn: true })
  g = await call2('/api/auth/shop/gift', { char: 'u_0123456789abcdef', items: { bunga: 1 } })
  ok(g.status === 409 && (g.json.error || '').includes('Barangmu tidak cukup'), 'hadiah ke AI relOn=true LANJUT (kena cek inventory, bukan ditolak guard)', g)
  server.close(); server2.close()
} catch (e) {
  console.error('GAGAL menjalankan test:', e)
  process.exitCode = 1
}

console.log(`\n${FAIL ? 'GAGAL' : 'LULUS'}: ${PASS} lulus, ${FAIL} gagal`)
process.exit(FAIL ? 1 : 0)
