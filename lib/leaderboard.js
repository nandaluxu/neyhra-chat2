import { avatarOf } from './profile.js'

// Leaderboard: tab baru "Peringkat". Kategori -> sub kategori -> metrik. Semua hitungan diputuskan server; client (public/leaderboard.js) hanya menampilkan.
//
// Sumber data:
//   achv       { _id: userId, c:{ chat, quests, maxLv, ... } }   hitungan seumur hidup yang sudah ada (lib/quests.js) — chat dihitung server saat /api/chat sukses
//   lb_stats   { _id: userId, c:{ guessTries, guessPlayed, guessWon, picTries, picPlayed, picWon, chessPlayed, chessWon } }   BARU: penghitung game, ditambah lewat bump()
//   users      slot.demo/slot.paid { spins, wins } (sudah ada di lib/slot.js), coins
//   gc_messages  Chat Global: dihitung per `au` (username pengirim yang masuk akun), di-cache 90 detik per instance
// Penghitung baru mulai dari 0 sejak fitur ini aktif (riwayat game lama tidak tercatat di server).
//
// Endpoint (POST, token Bearer OPSIONAL — tanpa token tetap bisa melihat, hanya tanpa baris "kamu"):
//   /api/auth/lb  body { cat?, sub?, metric? } -> { ok, cfg, cat, sub, metric, unit, rows:[{rank,name,username,avatar,v,me}], me:{v,rank,hidden}|null }
// Pengguna yang menyembunyikan statistik profil (users.hideStats) tidak ditampilkan di peringkat.

const sum = (...f) => ({ $add: f.map(x => ({ $ifNull: [x, 0] })) })
const slotSpins = sum('$slot.demo.spins', '$slot.paid.spins'), slotWins = sum('$slot.demo.wins', '$slot.paid.wins')
const LB = f => ({ src: 'lb_stats', expr: { $ifNull: ['$c.' + f, 0] } })

export const CATS = [
  { id: 'chat', name: 'Chat', subs: [
    { id: 'char', name: 'Chat Karakter', metrics: [{ id: 'sent', name: 'Pesan terkirim', unit: 'pesan', src: 'achv', expr: { $ifNull: ['$c.chat', 0] } }] },
    { id: 'global', name: 'Chat Global', metrics: [{ id: 'sent', name: 'Pesan terkirim', unit: 'pesan', src: 'gc' }] }
  ] },
  { id: 'game', name: 'Game', subs: [
    { id: 'all', name: 'Semua Game', metrics: [
      { id: 'plays', name: 'Game dimainkan', unit: 'game', src: 'lb_stats', expr: sum('$c.guessPlayed', '$c.picPlayed', '$c.chessPlayed') },
      { id: 'wins', name: 'Game dimenangkan', unit: 'menang', src: 'lb_stats', expr: sum('$c.guessWon', '$c.picWon', '$c.chessWon') }
    ] },
    { id: 'guess', name: 'Tebak Angka', metrics: [
      { id: 'tries', name: 'Tebakan dijawab', unit: 'tebakan', ...LB('guessTries') },
      { id: 'played', name: 'Permainan', unit: 'game', ...LB('guessPlayed') },
      { id: 'won', name: 'Menang', unit: 'menang', ...LB('guessWon') }
    ] },
    { id: 'pic', name: 'Tebak Gambar', metrics: [
      { id: 'tries', name: 'Jawaban diberikan', unit: 'jawaban', ...LB('picTries') },
      { id: 'played', name: 'Soal dimainkan', unit: 'soal', ...LB('picPlayed') },
      { id: 'won', name: 'Soal benar', unit: 'benar', ...LB('picWon') }
    ] },
    { id: 'chess', name: 'Catur', metrics: [
      { id: 'played', name: 'Permainan', unit: 'game', ...LB('chessPlayed') },
      { id: 'won', name: 'Menang', unit: 'menang', ...LB('chessWon') }
    ] },
    { id: 'slot', name: 'Fruit Slot', metrics: [
      { id: 'spins', name: 'Spin', unit: 'spin', src: 'users', expr: slotSpins },
      { id: 'wins', name: 'Spin menang', unit: 'menang', src: 'users', expr: slotWins }
    ] }
  ] },
  { id: 'other', name: 'Lainnya', subs: [
    { id: 'coins', name: 'Kekayaan', metrics: [{ id: 'coins', name: 'Coin', unit: 'coin', src: 'users', expr: { $ifNull: ['$coins', 0] } }] },
    { id: 'bond', name: 'Hubungan', metrics: [{ id: 'lv', name: 'Level tertinggi', unit: 'level', src: 'achv', expr: { $ifNull: ['$c.maxLv', 0] } }] },
    { id: 'quest', name: 'Misi', metrics: [{ id: 'done', name: 'Misi harian selesai', unit: 'misi', src: 'achv', expr: { $ifNull: ['$c.quests', 0] } }] }
  ] }
]
const cfgView = CATS.map(c => ({ id: c.id, name: c.name, subs: c.subs.map(s => ({ id: s.id, name: s.name, metrics: s.metrics.map(m => ({ id: m.id, name: m.name, unit: m.unit })) })) }))

const FIELD = /^[a-zA-Z]{1,24}$/, TOP = 50

// Tambah hitungan penghitung game. inc = { guessTries: 1, ... }. Tidak pernah melempar error (ditelan supaya endpoint game tetap sukses).
export async function bump(col, userId, inc) {
  try {
    const $inc = {}
    for (const [k, v] of Object.entries(inc)) if (FIELD.test(k) && Number.isInteger(v) && v > 0) $inc['c.' + k] = v
    if (!Object.keys($inc).length) return
    await (await col('lb_stats')).updateOne({ _id: userId }, { $inc }, { upsert: true })
  } catch (e) { console.error('[lb] bump gagal:', e?.message || e) }
}

export async function purgeLb(col, userId) {
  await (await col('lb_stats')).deleteOne({ _id: userId })
}

export function mountLeaderboard(router, { wrap, userFromReq, allow, col }) {
  let hid = { at: 0, ids: [] }, gcc = { at: 0, rows: [] }
  const hidden = async () => { // id pengguna yang menyembunyikan statistik (cache 60 dtk)
    if (Date.now() - hid.at < 60e3) return hid.ids
    const ids = (await (await col('users')).find({ hideStats: true }, { projection: { _id: 1 } }).toArray()).map(x => x._id)
    hid = { at: Date.now(), ids }; return ids
  }
  const decorate = async (rows, meId) => {
    const users = await col('users')
    const us = await users.find({ _id: { $in: rows.map(r => r.id) } }, { projection: { salt: 0, hash: 0 } }).toArray()
    const by = new Map(us.map(x => [x._id, x]))
    return rows.map((r, i) => { const x = by.get(r.id); return { rank: i + 1, name: x?.name || x?.username || 'Pengguna', username: x?.username || '', avatar: x ? avatarOf(x) : '', v: r.v, me: r.id === meId } })
  }

  router.post('/api/auth/lb', wrap(async (req, res) => {
    const a = await userFromReq(req).catch(() => null), u = a?.user
    if (!(await allow('lb:' + (u ? u._id : req.ip || 'x'), 60, 60))) return res.status(429).json({ error: 'Terlalu sering, tunggu sebentar.' })
    const b = req.body || {}
    const cat = CATS.find(c => c.id === b.cat) || CATS[0]
    const sub = cat.subs.find(s => s.id === b.sub) || cat.subs[0]
    const m = sub.metrics.find(x => x.id === b.metric) || sub.metrics[0]
    const base = { ok: true, cfg: cfgView, cat: cat.id, sub: sub.id, metric: m.id, unit: m.unit }
    const nin = await hidden(), meHidden = !!u && nin.includes(u._id)

    if (m.src === 'gc') { // Chat Global: hitung pesan per username akun, cache 90 dtk
      if (Date.now() - gcc.at > 90e3) {
        const g = await (await col('gc_messages')).aggregate([{ $match: { au: { $type: 'string' } } }, { $group: { _id: '$au', v: { $sum: 1 } } }, { $sort: { v: -1 } }, { $limit: 150 }]).toArray()
        const us = await (await col('users')).find({ username: { $in: g.map(x => x._id) } }, { projection: { _id: 1, username: 1 } }).toArray()
        const idOf = new Map(us.map(x => [x.username, x._id]))
        gcc = { at: Date.now(), rows: g.filter(x => idOf.has(x._id)).map(x => ({ id: idOf.get(x._id), v: x.v })) }
      }
      const list = gcc.rows.filter(r => !nin.includes(r.id)).slice(0, TOP)
      const rows = await decorate(list, u?._id)
      let me = null
      if (u) {
        const i = list.findIndex(r => r.id === u._id)
        me = i >= 0 ? { v: list[i].v, rank: i + 1 } : { v: await (await col('gc_messages')).countDocuments({ au: u.username }), rank: null }
        if (meHidden) me.hidden = true
      }
      return res.json({ ...base, rows, me })
    }

    const c = await col(m.src)
    const pipe = [{ $addFields: { _v: m.expr } }, { $project: { _v: 1 } }]
    const top = await c.aggregate([...pipe, { $match: { _v: { $gt: 0 }, _id: { $nin: nin } } }, { $sort: { _v: -1, _id: 1 } }, { $limit: TOP }]).toArray()
    const rows = await decorate(top.map(x => ({ id: x._id, v: x._v })), u?._id)
    let me = null
    if (u) {
      const mine = (await c.aggregate([{ $match: { _id: u._id } }, ...pipe]).toArray())[0]?._v || 0
      let rank = null
      if (mine > 0 && !meHidden) rank = 1 + ((await c.aggregate([...pipe, { $match: { _v: { $gt: mine }, _id: { $nin: nin } } }, { $count: 'n' }]).toArray())[0]?.n || 0)
      me = { v: mine, rank, ...(meHidden ? { hidden: true } : {}) }
    }
    res.json({ ...base, rows, me })
  }))
}
