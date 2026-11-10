// Mode dev (server): tambah Coin & Gems ke akun sendiri untuk uji coba.
//   /api/auth/dev/grant  (POST, token Bearer)  body { code, coins, gems }  -> { ok, coins, gems }
// Kode dev divalidasi di server dengan hash yang sama seperti DEV_SECRET di index.html / okDev di lib/gc.js
// (bisa diganti lewat env GC_DEV_HASH). Tanpa kode yang cocok = ditolak. Hanya menambah saldo akun si pemanggil.
const hash53 = (str, seed = 0) => {
  let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed
  for (let i = 0, c; i < str.length; i++) { c = str.charCodeAt(i); h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677) }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return 4294967296 * (2097151 & h2) + (h1 >>> 0)
}
const DEV_HASH = Number(process.env.GC_DEV_HASH) || 3608493969801461
const okDev = code => { try { return hash53(String(code || '').trim().toLowerCase().replace(/\s+/g, '')) === DEV_HASH } catch { return false } }

const MAX_ADD = 1_000_000   // batas sekali tambah per jenis
const MAX_BAL = 2_000_000_000 // saldo tidak boleh melewati ini

export function mountDev(router, { wrap, userFromReq, allow, col, ensureWallet }) {
  router.post('/api/auth/dev/grant', wrap(async (req, res) => {
    const a = await userFromReq(req)
    if (!a) return res.status(401).json({ error: 'Sesi berakhir, masuk lagi.' })
    if (!(await allow('devg:' + a.user._id, 30, 600))) return res.status(429).json({ error: 'Terlalu sering, tunggu sebentar.' })
    const { code, coins, gems } = req.body || {}
    if (!okDev(code)) return res.status(403).json({ error: 'Kode dev salah.' })
    const c = Number.isInteger(coins) ? coins : 0, g = Number.isInteger(gems) ? gems : 0
    if (c < 0 || g < 0 || c > MAX_ADD || g > MAX_ADD || (c === 0 && g === 0)) return res.status(400).json({ error: `Isi coin/gems 1 sampai ${MAX_ADD.toLocaleString('id-ID')}.` })
    const w = await ensureWallet(a.user)
    if (w.coins + c > MAX_BAL || w.gems + g > MAX_BAL) return res.status(400).json({ error: 'Saldo terlalu besar.' })
    const r = await (await col('users')).findOneAndUpdate({ _id: a.user._id }, { $inc: { coins: c, gems: g } }, { returnDocument: 'after' })
    const nu = r?.value !== undefined ? r.value : r
    res.json({ ok: true, coins: nu?.coins ?? w.coins + c, gems: nu?.gems ?? w.gems + g })
  }))
}
