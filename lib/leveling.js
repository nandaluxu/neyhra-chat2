import crypto from 'node:crypto'
import { ensureIndexes } from './mongo.js'
import { dayNum } from './bonus.js'
import { track } from './quests.js'
import { push as notify } from './notify.js'
import { avatarOf } from './profile.js'

// ===== Level Akun (lib/leveling.js) =====
// Leveling AKUN PENGGUNA — bukan level hubungan karakter (sistem relasi pakai EXP-mood, ada di lib/relation.js;
// piala "Sahabat Sejati" dst. di lib/quests.js memakai c.maxLv dari sana). Di sini yang naik adalah PEMAIN:
// makin seriatif main, makin tinggi level, dan hadiah minigame ikut membesar (pengali lihat mulFor()).
//
// Sumber XP (semua diputuskan server, client tidak bisa mengirim jumlah XP):
//   gc    pesan Chat Global yang sukses terkirim (dipasang di lib/gc.js /api/gc/send; tamu tanpa akun tidak dapat XP)
//   time  lama main di web: heartbeat /api/online (tiap 60 dtk) yang masuk akun; gerbang minimal TIME_GATE_MS
//         antar XP, jadi multi-tab tidak bisa mempercepat dan tab dibiarkan semalaman pun terhitung wajar
//   win   menang minigame (Tebak Angka, Tebak Gambar, 2048, Word Search, Catur vs AI — titik yang sama dengan
//         track(col, u, 'win') di lib/quests.js; menang tetap tercatat walau hadiah coin mentok batas harian)
//   ext   tambahan dari LUAR web lewat API /api/xp/grant (lib/xpext.js, kunci env LEVEL_EXT_KEY) — misal
//         giveaway, event, atau integrasi bot. Tanpa cap harian (pengirim sudah dipercaya lewat kuncinya).
//
// Koleksi MongoDB:
//   level   { _id: userId, xp (total seumur hidup), lvl (level terakhir yang sudah dibayar hadiahnya),
//            capDay (hari WIB), cap: { gc, time, win } (XP hari ini per sumber), lastBeat,
//            stats: { gc, time, win, ext } (XP seumur hidup per sumber), at }
//            Index { lvl: -1, xp: -1 } untuk daftar 10 level tertinggi.
//   xp_log  { _id: "<uid>:<waktu>:<rand>", uid, src, amt, xp (total setelahnya), lvl, note?, at }  riwayat XP, TTL 90 hari.
//
// Endpoint (POST, token Bearer, lihat mountLeveling):
//   /api/auth/level -> profil level lengkap (progres, cap harian, pengali, riwayat, 10 teratas)
// Respons endpoint lain yang ikut berubah (field baru, kompatibel dengan client lama):
//   /api/gc/send              -> { m, lv? }              lv muncul kalau pesan itu menambah XP / menaikkan level
//   /api/online               -> { enabled, count, lv? } sama, dari XP waktu-main
//   game/g2048/ws/pic/chess   -> view memuat `mul` (pengali hadiah), nq bisa berisi catatan level-up
//   /api/auth/me              -> `level` (untuk badge header tanpa request tambahan)
//
// Semua angka bisa ditala ulang lewat env tanpa deploy ulang kode: LEVEL_BASE, LEVEL_STEP, LEVEL_MAX,
// LEVEL_MUL_STEP, LEVEL_MUL_CAP, LEVEL_XP_GC, LEVEL_XP_WIN, LEVEL_CAP_GC, LEVEL_CAP_TIME, LEVEL_CAP_WIN.
// levelOf() selalu dihitung dari xp (lvl hanya penanda "sampai mana hadiah sudah dibayar"), jadi mengubah
// kurva di tengah jalan aman: level semua orang langsung mengikuti, hadiah hanya dibayar untuk kenaikan baru.

const WIB = 7 * 3600e3, DAY = 86400e3
const int = (v, d) => { const n = parseInt(v); return Number.isFinite(n) ? n : d }

// ===== Kurva & pengali (atur di sini) =====
export const LEVEL = {
  base: Math.max(10, int(process.env.LEVEL_BASE, 80)),     // XP dari level 1 -> 2
  step: Math.max(0, int(process.env.LEVEL_STEP, 40)),      // tambahan kebutuhan XP per level (linear)
  max: Math.min(200, Math.max(10, int(process.env.LEVEL_MAX, 100)))
}
// XP per aksi & batas XP per hari (WIB) per sumber. 'time' & 'ext' tidak punya batas sekali aksi yang berbeda.
export const XP = { gc: Math.max(1, int(process.env.LEVEL_XP_GC, 5)), time: 1, win: Math.max(1, int(process.env.LEVEL_XP_WIN, 15)) }
export const XP_CAP = {
  gc: Math.max(0, int(process.env.LEVEL_CAP_GC, 150)),      // 30 pesan global/hari
  time: Math.max(0, int(process.env.LEVEL_CAP_TIME, 120)),  // 1 XP tiap >= 4 menit aktif -> 120 XP = 8 jam
  win: Math.max(0, int(process.env.LEVEL_CAP_WIN, 150))     // 10 kemenangan/hari
}
export const TIME_GATE_MS = 4 * 60 * 1000
export const MUL = {
  step: Math.max(0, Math.min(0.2, Number(process.env.LEVEL_MUL_STEP) || 0.02)), // +2% hadiah minigame per level
  cap: Math.max(1, Math.min(5, Number(process.env.LEVEL_MUL_CAP) || 2.5))
}
// hadiah sekali naik level: coin tumbuh mengikuti level, gems tiap kelipatan LEVEL_GEM_EVERY
export const LEVELUP = { base: 30, per: 5, gemEvery: 5, gemAmt: 5 }

// total XP yang harus dikumpulkan untuk MENCAPAI `level` (level 1 = 0 XP). Selalu bilangan bulat.
export function xpTotalFor(level) {
  const L = Math.max(1, Math.floor(Number(level) || 1))
  return Math.round((L - 1) * LEVEL.base + (L - 1) * (L - 2) / 2 * LEVEL.step)
}
// level seseorang dengan total XP `xp`. Mentok di LEVEL.max (XP tetap terkumpul, ditampilkan sebagai MAX).
export function levelOf(xp) {
  let x = Math.max(0, Math.floor(Number(xp) || 0)), lvl = 1
  while (lvl < LEVEL.max && x >= xpTotalFor(lvl + 1)) lvl++
  return lvl
}
// pengali hadiah minigame pada level `lvl` (1.0 di level 1). Dipakai semua game lewat mulOf().
export const mulFor = lvl => Math.round(Math.min(MUL.cap, 1 + MUL.step * (Math.max(1, Math.floor(Number(lvl) || 1)) - 1)) * 100) / 100

const doc = r => (r && r.value !== undefined ? r.value : r) // findOneAndUpdate: driver baru mengembalikan dokumen, driver lama { value }

// hadiah level-up untuk menyeberangi level from+1..to sekaligus (grant eksternal bisa melompat beberapa level)
function rewardsFor(from, to) {
  let c = 0, g = 0
  for (let l = from + 1; l <= to; l++) { c += LEVELUP.base + LEVELUP.per * l; if (l % LEVELUP.gemEvery === 0) g += LEVELUP.gemAmt }
  return { c, g }
}

// ===== award(): SATU pintu semua penambahan XP =====
// Dipanggil fitur lain SETELAH aksinya sukses (pesan global terkirim, heartbeat, menang game, grant eksternal).
// Penjaga: (1) cap harian per sumber dijaga atomik di filter update, (2) gerbang waktu untuk 'time', (3) kenaikan
// level dibayar sekali lewat filter lvl (dua request bersamaan tidak bisa dobel hadiah), (4) XP tidak pernah minus.
// Tidak pernah melempar error (ditelan + dicatat) supaya endpoint utamanya tetap sukses — pola yang sama dengan
// track() di lib/quests.js. Balikan: { gained, xp, level, mul, capped, levelUp, notes }.
export async function award(col, u, src, amt, meta = {}) {
  const notes = []
  try {
    if (!u?._id) return { gained: 0, notes }
    const kind = String(src)
    const amount = Math.max(-1e6, Math.min(1e6, Math.round(Number(amt) || 0)))
    if (!amount) return { gained: 0, notes }
    const lcol = await col('level')
    const today = dayNum(Date.now())

    // 1) pastikan dokumen level ada (akun lama / belum pernah dapat XP)
    const d0 = doc(await lcol.findOneAndUpdate(
      { _id: u._id },
      { $setOnInsert: { xp: 0, lvl: 1, capDay: today, cap: { gc: 0, time: 0, win: 0 }, stats: { gc: 0, time: 0, win: 0, ext: 0 }, lastBeat: 0, at: new Date() } },
      { upsert: true, returnDocument: 'after' }
    )) || { xp: 0, lvl: 1 }
    // 2) hari berganti -> cap harian mulai dari 0 lagi
    await lcol.updateOne({ _id: u._id, capDay: { $ne: today } }, { $set: { capDay: today, cap: { gc: 0, time: 0, win: 0 } } })
    // 3) tambah XP. Cap & gerbang waktu dijaga di filter (atomik): kalau tidak lolos -> null, XP tidak berubah.
    const filter = { _id: u._id }
    if (kind !== 'ext' && kind in XP_CAP) filter[`cap.${kind}`] = { $lt: XP_CAP[kind] }
    if (kind === 'time') filter.lastBeat = { $lt: Date.now() - TIME_GATE_MS }
    const after = doc(await lcol.findOneAndUpdate(filter, {
      $inc: { xp: amount, [`cap.${kind}`]: amount, [`stats.${kind}`]: amount },
      $set: { at: new Date(), ...(kind === 'time' ? { lastBeat: Date.now() } : {}) }
    }, { returnDocument: 'after' }))
    if (!after) return { gained: 0, xp: d0.xp || 0, level: d0.lvl || 1, capped: true, levelUp: null, notes } // mentok cap harian / heartbeat terlalu rapat

    // penyesuaian eksternal negatif tidak membuat XP minus
    let xp = Math.max(0, after.xp || 0)
    if ((after.xp || 0) < 0) { await lcol.updateOne({ _id: u._id, xp: { $lt: 0 } }, { $set: { xp: 0 } }); after.xp = 0 }

    const newLv = levelOf(xp), oldLv = Math.max(1, after.lvl || 1)
    let levelUp = null
    const own = []
    if (newLv > oldLv) {
      const won = doc(await lcol.findOneAndUpdate({ _id: u._id, lvl: { $lt: newLv } }, { $set: { lvl: newLv } }, { returnDocument: 'after' }))
      if (won) { // hanya satu request yang naikkan level ini yang membayar hadiah
        const r = rewardsFor(oldLv, newLv)
        if (r.c || r.g) await (await col('users')).updateOne({ _id: u._id }, { $inc: { coins: r.c || 0, gems: r.g || 0 } })
        levelUp = { from: oldLv, to: newLv, reward: r }
        own.push(`Naik ke Level ${newLv}!${r.c ? ` (+${r.c} coin)` : ''}${r.g ? ` (+${r.g} gems)` : ''}`)
      }
    } else if (newLv < oldLv) { // penyesuaian eksternal negatif: level turun tanpa hadiah, tanpa catatan misi
      await lcol.updateOne({ _id: u._id, lvl: { $gt: newLv } }, { $set: { lvl: newLv } })
      own.push(`Level akun diatur ulang ke ${newLv}.`)
    }

    // 4) riwayat XP (best-effort; dipangkas di sini supaya client tidak bisa menyimpan teks panjang)
    await (await col('xp_log')).insertOne({
      _id: `${u._id}:${Date.now().toString(36)}:${crypto.randomBytes(4).toString('hex')}`,
      uid: u._id, src: kind, amt: amount, xp, lvl: newLv, at: new Date(),
      ...(meta.note ? { note: String(meta.note).replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, 80) } : {})
    }).catch(() => { })
    // 5) piala level akun (lib/quests.js: event 'level' -> c.acctLv). Catatannya milik track(), tidak diulang di sini.
    const trophy = levelUp ? await track(col, u, 'level', { lvl: newLv }) : []
    // 6) catatan level-up milik sistem ini -> Pusat Notifikasi (lib/notify.js), best-effort
    for (const n of own) await notify(col, u._id, 'level', n, { lvl: newLv })
    return { gained: amount, xp, level: newLv, mul: mulFor(newLv), capped: false, levelUp, notes: [...own, ...trophy] }
  } catch (e) {
    console.error('leveling:award', e?.message)
    return { gained: 0, notes }
  }
}

// pengali hadiah minigame milik satu user (1.0 kalau belum pernah dapat XP). Satu baca kecil ber-_id, aman dipanggil tiap respons game.
export async function mulOf(col, u) {
  try {
    const d = await (await col('level')).findOne({ _id: u?._id }, { projection: { xp: 1 } })
    return mulFor(levelOf(d?.xp || 0))
  } catch { return 1 }
}

// hadiah minigame setelah pengali: dibulatkan ke bawah, minimal nilai aslinya tidak pernah 0 karena pengali (>= 1).
export const prizeWith = (prize, mul) => Math.floor(prize * mul)

// profil level lengkap untuk /api/auth/level (dipakai juga /api/xp/lookup lewat bagian ringkasnya)
export async function levelView(col, u, { ensureWallet } = {}) {
  const d = (await (await col('level')).findOne({ _id: u._id })) || {}
  const xp = Math.max(0, d.xp || 0), level = levelOf(xp)
  const today = dayNum(Date.now()), now = Date.now()
  const cap = d.capDay === today ? (d.cap || {}) : {}
  const stats = d.stats || {}
  const w = ensureWallet ? await ensureWallet(u) : { coins: u.coins, gems: u.gems }
  // 10 level tertinggi + posisi sendiri (lvl disinkronkan award(), jadi cukup sort { lvl, xp })
  const rows = await (await col('level')).find().sort({ lvl: -1, xp: -1 }).limit(10).toArray()
  const ids = rows.map(r => r._id)
  const us = ids.length ? await (await col('users')).find({ _id: { $in: ids } }, { projection: { username: 1, name: 1, av: 1, avatarUrl: 1, hideStats: 1 } }).toArray() : []
  const by = new Map(us.map(x => [x._id, x]))
  const mine = d.lvl || level
  const rank = 1 + (await (await col('level')).countDocuments({ $or: [{ lvl: { $gt: mine } }, { lvl: mine, xp: { $gt: xp } }] }))
  const hist = await (await col('xp_log')).find({ uid: u._id }, { projection: { src: 1, amt: 1, xp: 1, lvl: 1, note: 1, at: 1 } }).sort({ at: -1 }).limit(15).toArray()
  return {
    ok: true, level, xp, max: LEVEL.max, maxed: level >= LEVEL.max,
    cur: xp - xpTotalFor(level), need: xpTotalFor(level + 1) - xpTotalFor(level), // progres level sekarang
    nextAt: xpTotalFor(level + 1),
    mul: { now: mulFor(level), next: mulFor(level + 1), cap: MUL.cap, step: MUL.step },
    daily: {
      gc: { xp: cap.gc || 0, cap: XP_CAP.gc, per: XP.gc },
      time: { xp: cap.time || 0, cap: XP_CAP.time, per: XP.time, perMin: TIME_GATE_MS / 60000 },
      win: { xp: cap.win || 0, cap: XP_CAP.win, per: XP.win },
      ext: { xp: cap.ext || 0, cap: null }, // tanpa cap: diatur pemberi grant, bukan sistem
      resetMs: (today + 1) * DAY - WIB - now
    },
    sources: {
      gc: { title: 'Pesan Chat Global', xp: stats.gc || 0 },
      time: { title: 'Lama main di web', xp: stats.time || 0 },
      win: { title: 'Menang minigame', xp: stats.win || 0 },
      ext: { title: 'Bonus eksternal', xp: stats.ext || 0 }
    },
    hist: hist.map(h => ({ src: h.src, amt: h.amt, xp: h.xp, lvl: h.lvl, ...(h.note ? { note: h.note } : {}), at: h.at })),
    top: rows.map(r => { const x = by.get(r._id); return { name: x?.name || x?.username || 'Pengguna', avatar: x ? avatarOf(x) : '', level: r.lvl || levelOf(r.xp), me: r._id === u._id } }),
    rank: { level: mine, at: rank },
    coins: w.coins, gems: w.gems
  }
}

// Hapus semua data level milik satu akun (dipanggil saat akun dihapus di lib/auth.js)
export async function purgeLevel(col, userId) {
  await Promise.all([
    (await col('level')).deleteOne({ _id: userId }),
    (await col('xp_log')).deleteMany({ uid: userId })
  ])
}

export function mountLeveling(router, { wrap, userFromReq, allow, col, ensureWallet }) {
  let ready
  const init = () => ready ??= ensureIndexes('level', [[{ lvl: -1, xp: -1 }]])
    .then(() => ensureIndexes('xp_log', [[{ uid: 1, at: -1 }], [{ at: 1 }, { expireAfterSeconds: 90 * 86400 }]]))
    .catch(e => { ready = null; throw e })

  router.post('/api/auth/level', wrap(async (req, res) => {
    const a = await userFromReq(req)
    if (!a) return res.status(401).json({ error: 'Sesi berakhir, masuk lagi.' })
    if (!(await allow('lvl:' + a.user._id, 60, 60))) return res.status(429).json({ error: 'Terlalu sering, tunggu sebentar.' })
    await init()
    res.json(await levelView(col, a.user, { ensureWallet }))
  }))
}
