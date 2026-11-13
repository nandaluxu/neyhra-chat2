import { ensureIndexes } from './mongo.js'
import { dayNum } from './bonus.js'
import { levelOf } from './relation.js'
import { avatarOf } from './profile.js'
import { push as notify } from './notify.js'

// Misi harian + Piala (achievements) + Peringkat mingguan. Semua hitungan, hadiah, dan saldo diputuskan di sini;
// client (public/bonus.js, public/profile.js) hanya menampilkan. Dipasang ke router auth (lib/auth.js) lewat mountQuests().
//
// Cara kerja: endpoint lain memanggil track() SETELAH aksinya sukses (chat sukses, menang game, klaim bonus, beri hadiah).
// track() memperbarui dua koleksi sekaligus:
//   quests  { _id: "<userId>:<hari>", userId, day, msgs, chars:[id...], wins, claims, gifts, got:{<misId>:true}, at }
//           -> hitungan harian untuk misi. Dokumen hari lama dibiarkan (bisa dibersihkan lewat index TTL kalau makin lama).
//   achv    { _id: userId, c: { chat, wins, gifts, claims, quests, streak, streakMax, maxLv }, chars:[id...], got:{<pialaId>:true} }
//           -> hitungan seumur hidup untuk piala.
// Misi yang baru selesai: hadiah coin masuk ke users (penjaga atomik got.<id> supaya tidak dobel) + 10 poin ke lb_week.
// Piala yang baru terbuka: hadiahnya juga coin/gems ke users, penjaga atomik got.<id>.
// track() tidak pernah melempar error (ditelan + dicatat) supaya endpoint utamanya tetap sukses.
//
// Koleksi lb_week { _id: "<userId>:<minggu>", userId, pts, at }: poin misi minggu ini untuk leaderboard.
// Minggu = floor(hari/7) versi dayNum (berganti Kamis 00.00 WIB; cukup untuk reset rutin, tanggal pastinya tidak penting).
//
// Endpoint (POST, token Bearer):
//   /api/auth/quests  -> { ok, quests:[...3 aktif hari ini], streak, ach:{list, got, c}, lb:{top, rank, pts, left}, resetMs }
//
// Field tambahan di `users`: questPts tidak disimpan (ada di lb_week), saldo coin/gems tetap satu-satunya sumber di `users`.

const WIB = 7 * 3600e3, DAY = 86400e3

// ===== Misi harian: 3 aktif tiap hari, dipilih deterministik dari tanggal (sama di semua perangkat) =====
// kind = field hitungan di dokumen `quests`: msgs | chars | wins | claims | gifts
export const QUESTS = [
  { id: 'chat10', kind: 'msgs', title: 'Ngobrol 10 pesan', target: 10, reward: { c: 40 }, icon: 'chat' },
  { id: 'chat3c', kind: 'chars', title: 'Chat dengan 3 karakter berbeda', target: 3, reward: { c: 50 }, icon: 'chars' },
  { id: 'wingame', kind: 'wins', title: 'Menangkan 1 minigame', target: 1, reward: { c: 60 }, icon: 'game' },
  { id: 'claim1', kind: 'claims', title: 'Klaim bonus harian', target: 1, reward: { c: 20 }, icon: 'gift' },
  { id: 'gift1', kind: 'gifts', title: 'Beri 1 hadiah ke karakter', target: 1, reward: { c: 40 }, icon: 'gift' },
  { id: 'win3', kind: 'wins', title: 'Menangkan 3 minigame', target: 3, reward: { c: 100 }, icon: 'game' },
  { id: 'chat25', kind: 'msgs', title: 'Ngobrol 25 pesan', target: 25, reward: { c: 80 }, icon: 'chat' }
]

// ===== Piala (seumur hidup). k = field hitungan di achv.c; chars & streak diurus khusus =====
export const ACHV = [
  { id: 'chat100', k: 'chat', n: 100, name: 'Pemula Ramah', desc: 'Kirim 100 pesan', reward: { c: 50 } },
  { id: 'chat1000', k: 'chat', n: 1000, name: 'Ahli Ngobrol', desc: 'Kirim 1.000 pesan', reward: { c: 200 } },
  { id: 'chat10000', k: 'chat', n: 10000, name: 'Legenda Obrolan', desc: 'Kirim 10.000 pesan', reward: { g: 20 } },
  { id: 'chars5', k: 'chars', n: 5, name: 'Sosialita', desc: 'Ngobrol dengan 5 karakter berbeda', reward: { c: 50 } },
  { id: 'chars25', k: 'chars', n: 25, name: 'Wajah Baru', desc: 'Ngobrol dengan 25 karakter berbeda', reward: { c: 150 } },
  { id: 'chars50', k: 'chars', n: 50, name: 'Dikenal Semua', desc: 'Ngobrol dengan 50 karakter berbeda', reward: { g: 15 } },
  { id: 'win1', k: 'wins', n: 1, name: 'Kemenangan Pertama', desc: 'Menangkan 1 minigame', reward: { c: 30 } },
  { id: 'win25', k: 'wins', n: 25, name: 'Raja Minigame', desc: 'Menangkan 25 minigame', reward: { c: 200 } },
  { id: 'win100', k: 'wins', n: 100, name: 'Tak Terkalahkan', desc: 'Menangkan 100 minigame', reward: { g: 25 } },
  { id: 'gift1', k: 'gifts', n: 1, name: 'Pemberi Hadiah', desc: 'Beri hadiah pertamamu ke karakter', reward: { c: 30 } },
  { id: 'gift25', k: 'gifts', n: 25, name: 'Dermawan', desc: 'Beri 25 hadiah ke karakter', reward: { g: 10 } },
  { id: 'claim7', k: 'claims', n: 7, name: 'Setia Sepekan', desc: 'Klaim bonus harian 7 kali', reward: { c: 50 } },
  { id: 'claim30', k: 'claims', n: 30, name: 'Sebulan Setia', desc: 'Klaim bonus harian 30 kali', reward: { g: 15 } },
  { id: 'streak7', k: 'streak', n: 7, name: 'Api Tak Padam', desc: 'Klaim harian 7 hari berturut-turut', reward: { c: 100 } },
  { id: 'streak30', k: 'streak', n: 30, name: 'Api Abadi', desc: 'Klaim harian 30 hari berturut-turut', reward: { g: 30 } },
  { id: 'quest10', k: 'quests', n: 10, name: 'Pemburu Misi', desc: 'Selesaikan 10 misi harian', reward: { c: 100 } },
  { id: 'quest100', k: 'quests', n: 100, name: 'Penakluk Misi', desc: 'Selesaikan 100 misi harian', reward: { g: 25 } },
  { id: 'lv15', k: 'maxLv', n: 15, name: 'Sahabat Sejati', desc: 'Capai tahap Sahabat dengan satu karakter', reward: { c: 80 } },
  { id: 'lv30', k: 'maxLv', n: 30, name: 'Orang Spesial', desc: 'Capai tahap Spesial dengan satu karakter', reward: { g: 10 } },
  { id: 'lv50', k: 'maxLv', n: 50, name: 'Sepasang Kekasih', desc: 'Capai tahap Pasangan dengan satu karakter', reward: { g: 25 } }
]

export const QUEST_PTS = 10 // poin leaderboard per misi selesai

// 3 misi aktif hari ini (stabil: index = (hari*3, +1, +2) mod jumlah misi)
export const questsOfDay = day => {
  const n = QUESTS.length, s = (day * 3) % n
  return [0, 1, 2].map(i => QUESTS[(s + i) % n])
}

const doc = r => (r && r.value !== undefined ? r.value : r) // findOneAndUpdate: driver baru mengembalikan dokumen, driver lama { value }
const CLEAN_ID = /^[\w-]{1,64}$/

// event: 'chat' { charId, exp } | 'win' | 'claim' { streak } | 'gift'
// Mengembalikan daftar notifikasi string untuk client (mis. "Misi selesai: ... (+40 coin)"), atau [] kalau tidak ada.
// Sejak ada Pusat Notifikasi (lib/notify.js), catatan ini JUGA disimpan ke koleksi `notif` (best-effort)
// supaya muncul di bel notifikasi; respons `nq` tetap seperti sebelumnya supaya UI lama tidak berubah.
export async function track(col, u, event, meta = {}) {
  try {
    const notes = [], today = dayNum(Date.now()), qid = `${u._id}:${today}`
    const qcol = await col('quests')

    // 1) hitungan harian (misi)
    let dayDoc
    if (event === 'chat' && CLEAN_ID.test(String(meta.charId || ''))) {
      dayDoc = doc(await qcol.findOneAndUpdate(
        { _id: qid },
        { $inc: { msgs: 1 }, $addToSet: { chars: meta.charId }, $setOnInsert: { userId: u._id, day: today, wins: 0, claims: 0, gifts: 0, got: {} }, $set: { at: new Date() } },
        { upsert: true, returnDocument: 'after' }
      ))
    } else if (event === 'win' || event === 'claim' || event === 'gift') {
      const f = event === 'win' ? 'wins' : event === 'claim' ? 'claims' : 'gifts'
      dayDoc = doc(await qcol.findOneAndUpdate(
        { _id: qid },
        { $inc: { [f]: 1 }, $setOnInsert: { userId: u._id, day: today, msgs: 0, chars: [], got: {} }, $set: { at: new Date() } },
        { upsert: true, returnDocument: 'after' }
      ))
    }

    // 2) misi yang baru selesai (penjaga atomik got.<id>: dua request bersamaan hanya satu yang dapat hadiah)
    let questsDone = 0
    if (dayDoc) {
      const got = dayDoc.got || {}
      for (const q of questsOfDay(today)) {
        if (got[q.id]) continue
        const prog = q.kind === 'chars' ? (dayDoc.chars || []).length : dayDoc[q.kind] || 0
        if (prog < q.target) continue
        const won = doc(await qcol.findOneAndUpdate(
          { _id: qid, [`got.${q.id}`]: { $ne: true } },
          { $set: { [`got.${q.id}`]: true }, $inc: { done: 1 } },
          { returnDocument: 'after' }
        ))
        if (!won) continue
        questsDone++
        await Promise.all([
          (await col('users')).updateOne({ _id: u._id }, { $inc: { coins: q.reward.c || 0, gems: q.reward.g || 0 } }),
          (await col('lb_week')).updateOne({ _id: `${u._id}:${Math.floor(today / 7)}`, userId: u._id }, { $inc: { pts: QUEST_PTS }, $set: { at: new Date() } }, { upsert: true })
        ])
        notes.push(`Misi selesai: ${q.title} (+${q.reward.c || 0} coin)`)
      }
    }

    // 3) hitungan seumur hidup (piala)
    const acol = await col('achv')
    let aDoc = null
    if (event === 'chat') {
      const exp = Math.max(0, Math.min(9999999, Math.round(Number(meta.exp)) || 0))
      aDoc = doc(await acol.findOneAndUpdate(
        { _id: u._id },
        { $inc: { 'c.chat': 1, 'c.quests': questsDone }, $addToSet: { chars: String(meta.charId || '').slice(0, 64) }, $max: { 'c.maxLv': levelOf(exp) }, $setOnInsert: { got: {} } },
        { upsert: true, returnDocument: 'after' }
      ))
    } else if (event === 'win' || event === 'gift') {
      aDoc = doc(await acol.findOneAndUpdate(
        { _id: u._id },
        { $inc: { [`c.${event === 'win' ? 'wins' : 'gifts'}`]: 1, 'c.quests': questsDone }, $setOnInsert: { got: {} } },
        { upsert: true, returnDocument: 'after' }
      ))
    } else if (event === 'claim') {
      const st = Math.max(1, Math.min(9999, Math.round(Number(meta.streak)) || 1))
      aDoc = doc(await acol.findOneAndUpdate(
        { _id: u._id },
        { $inc: { 'c.claims': 1, 'c.quests': questsDone }, $set: { 'c.streak': st }, $max: { 'c.streakMax': st }, $setOnInsert: { got: {} } },
        { upsert: true, returnDocument: 'after' }
      ))
    }
    if (aDoc) {
      const c = aDoc.c || {}, gotA = aDoc.got || {}
      const cur = { ...c, chars: (aDoc.chars || []).length }
      for (const a of ACHV) {
        if (gotA[a.id]) continue
        const v = a.k === 'streak' ? c.streakMax || 0 : cur[a.k] || 0
        if (v < a.n) continue
        const won = doc(await acol.findOneAndUpdate(
          { _id: u._id, [`got.${a.id}`]: { $ne: true } },
          { $set: { [`got.${a.id}`]: true } },
          { returnDocument: 'after' }
        ))
        if (!won) continue
        await (await col('users')).updateOne({ _id: u._id }, { $inc: { coins: a.reward.c || 0, gems: a.reward.g || 0 } })
        notes.push(`Piala baru: ${a.name}${a.reward.c ? ` (+${a.reward.c} coin)` : ` (+${a.reward.g} gems)`}`)
      }
    }
    // mirror ke Pusat Notifikasi (lib/notify.js): push() sendiri best-effort, tidak melempar error
    for (const n of notes) await notify(col, u._id, n.startsWith('Piala') ? 'ach' : 'quest', n)
    return notes
  } catch (e) {
    console.error('quests:track', e?.message)
    return []
  }
}

// Hapus semua data misi/piala/peringkat milik satu akun (dipanggil saat akun dihapus di lib/auth.js)
export async function purgeQuests(col, userId) {
  const esc = String(userId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  await Promise.all([
    (await col('quests')).deleteMany({ userId }),
    (await col('achv')).deleteOne({ _id: userId }),
    (await col('lb_week')).deleteMany({ _id: { $regex: `^${esc}:` } })
  ])
}

// Tampilan misi hari ini + piala + leaderboard untuk client.
export function mountQuests(router, { wrap, userFromReq, allow, col, ensureWallet }) {
  let ready
  const init = () => ready ??= ensureIndexes('quests', [[{ at: 1 }, { expireAfterSeconds: 90 * 86400 }]]).catch(e => { ready = null; throw e })
  // dokumen quests berumur 90 hari lalu dihapus otomatis (misi cuma butuh hari ini; sisanya cadangan audit)

  router.post('/api/auth/quests', wrap(async (req, res) => {
    const a = await userFromReq(req)
    if (!a) return res.status(401).json({ error: 'Sesi berakhir, masuk lagi.' })
    if (!(await allow('qs:' + a.user._id, 60, 60))) return res.status(429).json({ error: 'Terlalu sering, tunggu sebentar.' })
    await init()
    const u = a.user, today = dayNum(Date.now()), now = Date.now()
    await ensureWallet(u)

    // hitungan hari ini (buat dokumen kalau belum ada, supaya progres 0 tetap tampil)
    const d = doc(await (await col('quests')).findOneAndUpdate(
      { _id: `${u._id}:${today}` },
      { $setOnInsert: { userId: u._id, day: today, msgs: 0, chars: [], wins: 0, claims: 0, gifts: 0, got: {} }, $set: { at: new Date() } },
      { upsert: true, returnDocument: 'after' }
    ))
    const quests = questsOfDay(today).map(q => ({
      id: q.id, title: q.title, icon: q.icon, target: q.target, reward: q.reward,
      progress: Math.min(q.target, q.kind === 'chars' ? (d.chars || []).length : d[q.kind] || 0),
      done: !!(d.got || {})[q.id]
    }))

    // piala + hitungan seumur hidup
    const av = (await (await col('achv')).findOne({ _id: u._id })) || { c: {}, chars: [], got: {} }
    const cur = { ...av.c, chars: (av.chars || []).length }
    const ach = ACHV.map(a => ({
      id: a.id, name: a.name, desc: a.desc, reward: a.reward, n: a.n,
      v: Math.min(a.n, a.k === 'streak' ? cur.streakMax || 0 : cur[a.k] || 0),
      got: !!(av.got || {})[a.id]
    }))

    // leaderboard minggu ini: 10 teratas + posisi sendiri
    const week = Math.floor(today / 7), lb = await col('lb_week')
    const rows = await lb.find({ _id: { $regex: `:${week}$` } }).sort({ pts: -1 }).limit(10).toArray()
    const ids = rows.map(r => r.userId)
    const us = ids.length ? await (await col('users')).find({ _id: { $in: ids } }, { projection: { username: 1, name: 1, av: 1, avatarUrl: 1 } }).toArray() : []
    const byId = new Map(us.map(x => [x._id, x]))
    const mine = await lb.findOne({ _id: `${u._id}:${week}` })
    const myPts = mine?.pts || 0
    const rank = myPts ? (await lb.countDocuments({ _id: { $regex: `:${week}$` }, pts: { $gt: myPts } })) + 1 : 0
    res.json({
      ok: true, quests, ach,
      streak: { now: av.c?.streak || 0, best: av.c?.streakMax || 0 },
      lb: {
        top: rows.map(r => { const x = byId.get(r.userId); return { name: x?.name || x?.username || 'Pengguna', avatar: x ? avatarOf(x) : '', pts: r.pts, me: r.userId === u._id } }),
        pts: myPts, rank, mine: !!mine
      },
      resetMs: (today + 1) * DAY - WIB - now, // misi berganti 00.00 WIB
      coins: u.coins, gems: u.gems
    })
  }))
}
