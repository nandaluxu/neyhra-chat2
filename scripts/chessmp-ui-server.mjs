// Server HANYA untuk menguji frontend catur multiplayer (public/chessmp.js) secara end-to-end
// tanpa MongoDB asli. Mock koleksi in-memory disalin dari scripts/chessmp-e2e.mjs (implementasi
// operasi Mongo yang benar-benar dipakai lib/chessmp.js). Backend yang di-mount adalah KODE ASLI
// lib/chessmp.js — tidak diubah. Jalankan: node scripts/chessmp-ui-server.mjs [port]
import express from 'express'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/* ---------- Mock Mongo (salinan dari scripts/chessmp-e2e.mjs) ---------- */
const clone = d => (d && typeof d === 'object') ? JSON.parse(JSON.stringify(d)) : d
const getPath = (o, p) => p.split('.').reduce((a, k) => (a == null ? undefined : a[k]), o)
const setPath = (o, p, v) => { const ks = p.split('.'); const last = ks.pop(); let t = o; for (const k of ks) { if (t[k] == null || typeof t[k] !== 'object') t[k] = {}; t = t[k] } t[last] = v }
const delPath = (o, p) => { const ks = p.split('.'); const last = ks.pop(); const t = ks.reduce((a, k) => (a == null ? undefined : a[k]), o); if (t && typeof t === 'object') delete t[last] }
function match(d, q) {
  if (!q || typeof q !== 'object') return true
  for (const [k, v] of Object.entries(q)) {
    if (k === '$or') { if (!v.some(x => match(d, x))) return false; continue }
    if (k === '$and') { if (!v.every(x => match(d, x))) return false; continue }
    const cur = getPath(d, k)
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const [op, val] of Object.entries(v)) {
        if (op === '$ne' && cur === val) return false
        if (op === '$exists' && (val ? cur === undefined : cur !== undefined)) return false
        if (op === '$lt' && !(cur < val)) return false
        if (op === '$gt' && !(cur > val)) return false
        if (op === '$in' && !val.includes(cur)) return false
        if (op === '$gte' && !(cur >= val)) return false
        if (op === '$lte' && !(cur <= val)) return false
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
    else if (op === '$unset') for (const k of Object.keys(spec)) delPath(d, k)
    else if (op === '$inc') for (const [k, v] of Object.entries(spec)) setPath(d, k, (getPath(d, k) ?? 0) + v)
    else if (op === '$setOnInsert') { /* ditangani saat insert */ }
    else if (op === '$push') for (const [k, v] of Object.entries(spec)) {
      const arr = getPath(d, k) ?? (setPath(d, k, []), getPath(d, k))
      let items = Array.isArray(v) && v.$each ? v.$each : [v]
      if (v.$slice != null) items = items.slice(v.$slice)
      arr.push(...clone(items))
    }
  }
  return d
}
class MemCol {
  constructor(name) { this.name = name; this.docs = new Map() }
  async insertOne(d) { if (this.docs.has(d._id)) { const e = new Error('dup'); e.code = 11000; throw e } this.docs.set(d._id, clone(d)); return { acknowledged: true } }
  async findOne(q) { for (const d of this.docs.values()) if (match(d, q)) return clone(d); return null }
  async findOneAndUpdate(q, upd, opts = {}) {
    for (const [id, d] of this.docs) {
      if (match(d, q)) {
        const before = clone(d)
        applyUpdate(d, upd)
        return opts.returnDocument === 'before' ? before : clone(d)
      }
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
  async updateOne(q, upd, opts = {}) { return this.findOneAndUpdate(q, upd, { ...opts, returnDocument: 'after' }).then(() => ({ acknowledged: true, matchedCount: 1 })) }
  async deleteOne(q) { let n = 0; for (const [id, d] of this.docs) if (match(d, q)) { this.docs.delete(id); n++ } return { deletedCount: n } }
  find(q, opts = {}) {
    const self = this
    let rows = [...self.docs.values()].filter(d => match(d, q)).map(clone)
    const projection = opts.projection
    if (projection) for (const r of rows) for (const k of Object.keys(projection)) if (projection[k] === 0) delPath(r, k)
    return {
      sort(s) { if (s) for (const [k, dir] of Object.entries(s).reverse()) rows.sort((a, b) => (getPath(a, k) > getPath(b, k) ? dir : -(dir))); return this },
      skip(n) { rows = rows.slice(n); return this },
      limit(n) { rows = rows.slice(0, n); return this },
      async toArray() { return rows }
    }
  }
}
const cols = {}
const col = async name => cols[name] ??= new MemCol(name)
const ensureIndexes = async () => { }

/* ---------- Pengguna uji ---------- */
process.env.CHESS_MP_DEPTH = process.env.CHESS_MP_DEPTH || '3'
const USERS = {
  toknanda1234567890abcd: { _id: 'u-nanda', username: 'nanda', name: 'Nanda' },
  tokluxu1234567890abcde: { _id: 'u-luxu', username: 'luxu', name: 'Luxu' }
}
const userFromReq = async req => {
  const m = /^Bearer (\w+)$/.exec(req.headers.authorization || '')
  const u = m && USERS[m[1]]
  return u ? { user: u, sid: 's-' + u._id } : null
}
const wrap = fn => async (req, res) => { try { await fn(req, res) } catch (e) { console.error('ui-wrap:', e); res.status(500).json({ error: 'Kesalahan server uji' }) } }
const allow = async () => true

/* ---------- App ---------- */
const { mountChessMp } = await import('../lib/chessmp.js')
const app = express()
app.use(express.json({ limit: '1mb' }))

// /api/auth/me minimal supaya frontend menganggap sesi valid (initAcct di index.html)
app.post('/api/auth/me', (req, res) => {
  const m = /^Bearer (\w+)$/.exec(req.headers.authorization || '')
  const u = m && USERS[m[1]]
  if (!u) return res.status(401).json({ ok: false })
  res.json({ ok: true, uid: u._id, name: u.name, username: u.username, coins: 500, gems: 5, tickets: 3, chips: 0, cloud: null })
})

// Mock minimal endpoint minigame lain supaya HUB Minigame (games.js) bisa dirender:
// hanya field yang dipakai render hub/kartu. Permainan vs AI tidak diuji di sini.
app.post(['/api/auth/game', '/api/auth/pic', '/api/auth/chess'], (req, res) => {
  const m = /^Bearer (\w+)$/.exec(req.headers.authorization || '')
  if (!m || !USERS[m[1]]) return res.status(401).json({ error: 'Sesi tidak valid' })
  res.json({
    ok: true,
    cfg: { min: 1, max: 100, rewards: [100, 80, 60, 40, 20], cap: 5,
      levels: { 1: { name: 'Mudah', prize: 20 }, 2: { name: 'Sedang', prize: 45 }, 3: { name: 'Sulit', prize: 90 } } },
    daily: { wins: 0, cap: 5 },
    game: null, coins: 500, gems: 5, tickets: 3, chips: 0
  })
})

mountChessMp(app, { wrap, userFromReq, allow, col, ensureIndexes })

// seed koleksi users: endpoint /mp/stats mencari pemain lain lewat username di koleksi ini
;(async () => {
  const users = await col('users')
  for (const u of Object.values(USERS)) {
    if (!(await users.findOne({ _id: u._id }))) await users.insertOne({ _id: u._id, username: u.username, name: u.name })
  }
})()

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
app.use(express.static(path.join(ROOT, 'public'), { redirect: false }))
app.get(/.*/, (req, res) => res.sendFile(path.join(ROOT, 'public', 'index.html'))) // semua alamat -> aplikasi (pola vercel.json)

const port = Number(process.argv[2] || 4177)
app.listen(port, () => console.log('UI test server: http://localhost:' + port))
