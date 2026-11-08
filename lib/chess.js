import crypto from 'node:crypto'
import { ensureIndexes } from './mongo.js'
import { dayNum } from './bonus.js'
import { loadChars } from './chars.js'
import { reply } from './sessions.js'
import { finalize } from './finalize.js'

// Game CATUR melawan AI. Semua aturan (langkah sah, rokade, en passant, promosi, skakmat, seri) dan AI lawan
// dijalankan DI SINI; client (public/games.js) cuma menampilkan papan dan mengirim kotak asal/tujuan.
// Dipasang ke router auth (lib/auth.js) lewat mountChess(), jadi memakai sesi/token, pembatas laju, dan
// koleksi `users`/`game_state` yang sama dengan game lain.
//
// Pemain selalu PUTIH (bawah), AI selalu HITAM. Kotak = indeks 0..63, baris 0 = rank 8 (kiri atas a8),
// baris 7 = rank 1 (a1 = 56, e1 = 60). Papan = array 64 karakter: 'PNBRQK' putih, 'pnbrqk' hitam, '.' kosong.
//
// Endpoint (POST, token Bearer, jawaban JSON):
//   /api/auth/chess         -> { ok, cfg:{levels,drawPct}, daily:{wins,cap}, game|null, coins, gems }
//   /api/auth/chess/start   -> { ok, ... }  permainan baru. body { level: 1|2|3 } (yang belum selesai diganti)
//   /api/auth/chess/move    -> { ok, ... }  body { from, to, promo? }. Langkah pemain divalidasi, lalu AI membalas.
//   /api/auth/chess/resign  -> { ok, ... }  menyerah (kalah, tanpa hadiah)
//   /api/auth/chess/say     -> { ok, say: string|null }  lawan "mengoceh" (lihat bagian Lawan karakter). Dipanggil client setelah tiap langkah
//
// LAWAN KARAKTER: karakter yang di file char/<id>.js punya `chess: true` bisa dipilih jadi lawan (body start { opp: '<id>' }). Langkahnya tetap
// dihitung engine di sini (karakter tidak memilih langkah), tapi sesekali dia berkomentar sesuai kepribadiannya, dan komentarnya dibuat dengan
// memberi model keadaan papan nyata (papan ASCII, langkah terakhir, tangkapan, material, skak, hasil), jadi tidak mengarang. Opsional di file
// karakter: `chessStyle: '...'` = tambahan gaya bicara saat main catur (maks 300 karakter).
//
// Koleksi `game_state` (sama dengan game lain, TTL 24 jam): { _id:'<userId>:chess', b:[64], t, c, e, h, ply,
//   level, opp (id karakter lawan, boleh kosong), say:{t,ply,diff} (ocehan terakhir), sayKey (penjaga: satu kali ocehan per posisi), hist:[...], capsW:[], capsB:[], keys:[...], lastMove, done, won, reason, reward, exp }
// Field tambahan di `users`: chessDay, chessWins (kemenangan berhadiah hari itu, WIB)

// ===== Atur permainan & hadiah di sini =====
export const CHESS = {
  levels: {
    1: { name: 'Mudah', depth: 1, rand: 0.35, near: 30, prize: 25 },  // rand = peluang langkah acak; near = selisih skor (centipion) yang masih dianggap sama bagus
    2: { name: 'Sedang', depth: 2, rand: 0.08, near: 12, prize: 60 },
    3: { name: 'Sulit', depth: 3, rand: 0, near: 0, prize: 150 }
  },
  drawPct: 0.4,  // seri dapat 40% hadiah level (dibulatkan)
  drawMin: 5,
  dailyWins: 3   // maksimal kemenangan BERHADIAH per hari (WIB). Setelah itu tetap bisa main tanpa hadiah
}
const TTL_MS = 24 * 3600e3
const MATE = 100000

/* ---------- Dasar papan ---------- */
const isW = p => p >= 'A' && p <= 'Z'
const FILES = 'abcdefgh'
const sqName = i => FILES[i & 7] + (8 - (i >> 3))
const START = 'rnbqkbnrpppppppp' + '.'.repeat(32) + 'PPPPPPPPRNBQKBNR'
const newState = () => ({ b: [...START], t: 'w', c: 'KQkq', e: -1, h: 0 })
function kingSq(b, white) { const k = white ? 'K' : 'k'; for (let i = 0; i < 64; i++) if (b[i] === k) return i; return -1 }

const KN = [[-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1]]
const KG = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]]
const RD = [[-1, 0], [1, 0], [0, -1], [0, 1]]
const BD = [[-1, -1], [-1, 1], [1, -1], [1, 1]]

/* apakah kotak sq diserang oleh pihak byWhite */
function attacked(b, sq, byWhite) {
  const r = sq >> 3, c = sq & 7
  // pion: pion putih menyerang ke arah baris lebih kecil, jadi penyerang putih ada satu baris DI BAWAH kotak
  const pr = byWhite ? r + 1 : r - 1, pw = byWhite ? 'P' : 'p'
  if (pr >= 0 && pr < 8) {
    if (c > 0 && b[pr * 8 + c - 1] === pw) return true
    if (c < 7 && b[pr * 8 + c + 1] === pw) return true
  }
  for (const [dr, dc] of KN) { const rr = r + dr, cc = c + dc; if (rr >= 0 && rr < 8 && cc >= 0 && cc < 8 && b[rr * 8 + cc] === (byWhite ? 'N' : 'n')) return true }
  for (const [dr, dc] of KG) { const rr = r + dr, cc = c + dc; if (rr >= 0 && rr < 8 && cc >= 0 && cc < 8 && b[rr * 8 + cc] === (byWhite ? 'K' : 'k')) return true }
  for (const [dr, dc] of RD) {
    let rr = r + dr, cc = c + dc
    while (rr >= 0 && rr < 8 && cc >= 0 && cc < 8) {
      const p = b[rr * 8 + cc]
      if (p !== '.') { if (p === (byWhite ? 'R' : 'r') || p === (byWhite ? 'Q' : 'q')) return true; break }
      rr += dr; cc += dc
    }
  }
  for (const [dr, dc] of BD) {
    let rr = r + dr, cc = c + dc
    while (rr >= 0 && rr < 8 && cc >= 0 && cc < 8) {
      const p = b[rr * 8 + cc]
      if (p !== '.') { if (p === (byWhite ? 'B' : 'b') || p === (byWhite ? 'Q' : 'q')) return true; break }
      rr += dr; cc += dc
    }
  }
  return false
}
const inCheck = (b, white) => { const k = kingSq(b, white); return k >= 0 ? attacked(b, k, !white) : false }

/* ---------- Pembangkit langkah ---------- */
/* pseudo-sah (belum menyaring raja jadi skak). m = { f, t, pr?, ep?, cs?, dbl? } */
function pseudo(st) {
  const { b, t, c, e } = st, white = t === 'w', out = []
  for (let i = 0; i < 64; i++) {
    const p = b[i]
    if (p === '.' || isW(p) !== white) continue
    const r = i >> 3, c0 = i & 7
    if (p === 'P' || p === 'p') {
      const dir = white ? -1 : 1, start = white ? 6 : 1, last = white ? 0 : 7, r1 = r + dir
      if (r1 >= 0 && r1 < 8 && b[r1 * 8 + c0] === '.') {
        if (r1 === last) for (const pr of 'QRBN') out.push({ f: i, t: r1 * 8 + c0, pr })
        else {
          out.push({ f: i, t: r1 * 8 + c0 })
          const r2 = r + 2 * dir
          if (r === start && b[r2 * 8 + c0] === '.') out.push({ f: i, t: r2 * 8 + c0, dbl: true })
        }
      }
      for (const dc of [-1, 1]) {
        const cc = c0 + dc
        if (cc < 0 || cc > 7 || r1 < 0 || r1 > 7) continue
        const q = r1 * 8 + cc, tp = b[q]
        if (tp !== '.' && isW(tp) !== white) {
          if (r1 === last) for (const pr of 'QRBN') out.push({ f: i, t: q, pr })
          else out.push({ f: i, t: q })
        } else if (tp === '.' && q === e) out.push({ f: i, t: q, ep: true })
      }
    } else if (p === 'N' || p === 'n' || p === 'K' || p === 'k') {
      for (const [dr, dc] of ((p === 'N' || p === 'n') ? KN : KG)) {
        const rr = r + dr, cc = c0 + dc
        if (rr < 0 || rr > 7 || cc < 0 || cc > 7) continue
        const tp = b[rr * 8 + cc]
        if (tp === '.' || isW(tp) !== white) out.push({ f: i, t: rr * 8 + cc })
      }
      if (p === 'K' || p === 'k') {
        const home = white ? 60 : 4 // e1 / e8
        if (i === home && !attacked(b, home, !white)) {
          const kr = white ? 'K' : 'k', qr = white ? 'Q' : 'q', rk = white ? 'R' : 'r'
          if (c.includes(kr) && b[home + 1] === '.' && b[home + 2] === '.' && b[home + 3] === rk
            && !attacked(b, home + 1, !white) && !attacked(b, home + 2, !white)) out.push({ f: i, t: home + 2, cs: 'K' })
          if (c.includes(qr) && b[home - 1] === '.' && b[home - 2] === '.' && b[home - 3] === '.' && b[home - 4] === rk
            && !attacked(b, home - 1, !white) && !attacked(b, home - 2, !white)) out.push({ f: i, t: home - 2, cs: 'Q' })
        }
      }
    } else {
      const dirs = (p === 'R' || p === 'r') ? RD : (p === 'B' || p === 'b') ? BD : [...RD, ...BD]
      for (const [dr, dc] of dirs) {
        let rr = r + dr, cc = c0 + dc
        while (rr >= 0 && rr < 8 && cc >= 0 && cc < 8) {
          const tp = b[rr * 8 + cc]
          if (tp === '.') out.push({ f: i, t: rr * 8 + cc })
          else { if (isW(tp) !== white) out.push({ f: i, t: rr * 8 + cc }); break }
          rr += dr; cc += dc
        }
      }
    }
  }
  return out
}

/* terapkan langkah -> keadaan baru (immutabel: papan disalin) */
function apply(st, m) {
  const b = st.b.slice(), white = st.t === 'w', p = b[m.f]
  const cap = m.ep || b[m.t] !== '.' // ada tangkapan (jam 50 langkah kembali ke 0)
  b[m.f] = '.'
  if (m.ep) b[m.t + (white ? 8 : -8)] = '.' // pion yang dimakan en passang ada di belakang kotak tujuan
  b[m.t] = m.pr ? (white ? m.pr : m.pr.toLowerCase()) : p
  if (m.cs === 'K') { b[m.t + 1] = '.'; b[m.t - 1] = white ? 'R' : 'r' }      // rokade: benteng h -> f
  else if (m.cs === 'Q') { b[m.t - 2] = '.'; b[m.t + 1] = white ? 'R' : 'r' } // rokade: benteng a -> d
  let c = st.c
  if (p === 'K') c = c.replace(/[KQ]/g, '')
  if (p === 'k') c = c.replace(/[kq]/g, '')
  if (m.f === 63 || m.t === 63) c = c.replace('K', '')
  if (m.f === 56 || m.t === 56) c = c.replace('Q', '')
  if (m.f === 7 || m.t === 7) c = c.replace('k', '')
  if (m.f === 0 || m.t === 0) c = c.replace('q', '')
  return { b, t: white ? 'b' : 'w', c, e: m.dbl ? (m.f + m.t) / 2 : -1, h: (p === 'P' || p === 'p' || cap) ? 0 : st.h + 1 }
}

/* langkah sah: raja sendiri tidak boleh kena skak setelah langkah */
function legal(st) {
  const white = st.t === 'w'
  return pseudo(st).filter(m => !inCheck(apply(st, m).b, white))
}

/* kunci posisi buat deteksi pengulangan (en passang hanya dihitung kalau memang bisa dimanfaatkan) */
function posKey(st) {
  let e = -1
  if (st.e >= 0 && pseudo(st).some(m => m.ep)) e = st.e
  return st.b.join('') + st.t + st.c + e
}

/* material tidak cukup untuk skakmat: K vs K, K+B/N vs K, K+B vs K+B (gajah sewarna) */
function insufficient(b) {
  const rest = []
  for (let i = 0; i < 64; i++) { const p = b[i]; if (p !== '.' && p !== 'K' && p !== 'k') rest.push({ p, i }) }
  if (!rest.length) return true
  if (rest.length === 1) { const q = rest[0].p.toLowerCase(); return q === 'b' || q === 'n' }
  if (rest.length === 2 && rest[0].p.toLowerCase() === 'b' && rest[1].p.toLowerCase() === 'b' && isW(rest[0].p) !== isW(rest[1].p))
    return ((rest[0].i >> 3) + (rest[0].i & 7)) % 2 === ((rest[1].i >> 3) + (rest[1].i & 7)) % 2
  return false
}

/* akhir permainan setelah langkah pihak `st.t` (yang sekarang giliran): null = masih lanjut */
function endOf(st, keys) {
  if (!legal(st).length) return inCheck(st.b, st.t === 'w') ? { won: st.t === 'w' ? 'b' : 'w', reason: 'mate' } : { won: 'd', reason: 'stale' }
  if (st.h >= 100) return { won: 'd', reason: '50' }
  const k = keys[keys.length - 1]
  if (keys.filter(x => x === k).length >= 3) return { won: 'd', reason: 'rep' }
  if (insufficient(st.b)) return { won: 'd', reason: 'material' }
  return null
}

/* ---------- Notasi panjang (mudah dibaca): Nb1-c3, e2xe4, e7-e8=Q, O-O ---------- */
function note(st, m) {
  if (m.cs) return m.cs === 'K' ? 'O-O' : 'O-O-O'
  const p = st.b[m.f], q = p.toLowerCase()
  const cap = m.ep ? 'p' : st.b[m.t].toLowerCase()
  let s = (q !== 'p' ? p.toUpperCase() : '') + sqName(m.f) + (cap !== '.' ? 'x' : '-') + sqName(m.t)
  if (m.pr) s += '=' + m.pr
  return s
}

/* ---------- AI: negamax alpha-beta + tabel posisi (evaluasi sederhana Michniewski) ---------- */
const VAL = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 }
const PST = {
  p: [0, 0, 0, 0, 0, 0, 0, 0, 50, 50, 50, 50, 50, 50, 50, 50, 10, 10, 20, 30, 30, 20, 10, 10, 5, 5, 10, 25, 25, 10, 5, 5, 0, 0, 0, 20, 20, 0, 0, 0, 5, -5, -10, 0, 0, -10, -5, 5, 5, 10, 10, -20, -20, 10, 10, 5, 0, 0, 0, 0, 0, 0, 0, 0],
  n: [-50, -40, -30, -30, -30, -30, -40, -50, -40, -20, 0, 0, 0, 0, -20, -40, -30, 0, 10, 15, 15, 10, 0, -30, -30, 5, 15, 20, 20, 15, 5, -30, -30, 0, 15, 20, 20, 15, 0, -30, -30, 5, 10, 15, 15, 10, 5, -30, -40, -20, 0, 5, 5, 0, -20, -40, -50, -40, -30, -30, -30, -30, -40, -50],
  b: [-20, -10, -10, -10, -10, -10, -10, -20, -10, 0, 0, 0, 0, 0, 0, -10, -10, 0, 5, 10, 10, 5, 0, -10, -10, 5, 5, 10, 10, 5, 5, -10, -10, 0, 10, 10, 10, 10, 0, -10, -10, 10, 10, 10, 10, 10, 10, -10, -10, 5, 0, 0, 0, 0, 5, -10, -20, -10, -10, -10, -10, -10, -10, -20],
  r: [0, 0, 0, 0, 0, 0, 0, 0, 5, 10, 10, 10, 10, 10, 10, 5, -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5, 0, 0, 0, 5, 5, 0, 0, 0],
  q: [-20, -10, -10, -5, -5, -10, -10, -20, -10, 0, 0, 0, 0, 0, 0, -10, -10, 0, 5, 5, 5, 5, 0, -10, -5, 0, 5, 5, 5, 5, 0, -5, 0, 0, 5, 5, 5, 5, 0, -5, -10, 5, 5, 5, 5, 5, 0, -10, -10, 0, 5, 0, 0, 0, 0, -10, -20, -10, -10, -5, -5, -10, -10, -20],
  k: [-30, -40, -40, -50, -50, -40, -40, -30, -30, -40, -40, -50, -50, -40, -40, -30, -30, -40, -40, -50, -50, -40, -40, -30, -30, -40, -40, -50, -50, -40, -40, -30, -20, -30, -30, -40, -40, -30, -30, -20, -10, -20, -20, -20, -20, -20, -20, -10, 20, 20, 0, 0, 0, 0, 20, 20, 20, 30, 10, 0, 0, 10, 30, 20]
}
function evaluate(b) { // skor dari sudut PUTIH
  let s = 0
  for (let i = 0; i < 64; i++) {
    const p = b[i]
    if (p === '.') continue
    const white = isW(p), q = p.toLowerCase()
    s += (white ? 1 : -1) * (VAL[q] + PST[q][white ? i : (7 - (i >> 3)) * 8 + (i & 7)])
  }
  return s
}
function mScore(st, m) { // urutan eksplorasi: tangkapan paling mahal dulu (MVV-LVA) + promosi
  const victim = m.ep ? 'p' : st.b[m.t].toLowerCase()
  let s = victim === '.' ? 0 : VAL[victim] * 10 - VAL[st.b[m.f].toLowerCase()]
  if (m.pr) s += VAL[m.pr.toLowerCase()]
  return s
}
function negamax(st, depth, alpha, beta, ply) {
  const ms = legal(st)
  if (!ms.length) return inCheck(st.b, st.t === 'w') ? -MATE + ply : 0
  if (st.h >= 100 || insufficient(st.b)) return 0
  if (depth <= 0) return st.t === 'w' ? evaluate(st.b) : -evaluate(st.b)
  ms.sort((x, y) => mScore(st, y) - mScore(st, x))
  let best = -Infinity
  for (const m of ms) {
    const v = -negamax(apply(st, m), depth - 1, -beta, -alpha, ply + 1)
    if (v > best) best = v
    if (best > alpha) alpha = best
    if (alpha >= beta) break
  }
  return best
}
/* langkah AI (hitam). Level menentukan kedalaman + keacakan supaya tiap permainan beda */
function aiMove(st, level) {
  const ms = legal(st)
  if (!ms.length) return null
  const L = CHESS.levels[level] || CHESS.levels[2]
  if (L.rand && Math.random() < L.rand) return ms[crypto.randomInt(ms.length)]
  ms.sort((x, y) => mScore(st, y) - mScore(st, x))
  const scored = ms.map(m => ({ m, v: -negamax(apply(st, m), L.depth - 1, -Infinity, Infinity, 1) }))
  scored.sort((a, b) => b.v - a.v)
  const top = scored.filter(s => s.v >= scored[0].v - L.near)
  return top[crypto.randomInt(top.length)].m
}

/* ---------- Lawan karakter: kapan dan apa yang diocehkan ---------- */
const PN = { p: 'pion', n: 'kuda', b: 'gajah', r: 'benteng', q: 'ratu', k: 'raja' }
const matOf = arr => (arr || []).reduce((a, p) => a + ({ p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 }[p.toLowerCase()] || 0), 0)
// diff > 0: pemain (putih) unggul material; < 0: lawan (hitam) unggul
const matDiff = s => matOf(s.capsW) - matOf(s.capsB)
const pName = p => PN[String(p || '').toLowerCase()] || 'bidak'

// kejadian penting pada langkah terakhir, dipakai untuk menentukan peluang berbicara dan isi komentar
export function factsOf(s) {
  const h = s.hist || [], n = h.length
  const lastAi = n && n % 2 === 0 ? h[n - 1] : null            // hist genap = langkah terakhir adalah balasan hitam
  const lastUser = n % 2 === 0 ? h[n - 2] : h[n - 1]
  const st = { b: s.b }
  return {
    n, lastUser: lastUser || '', lastAi: lastAi || '',
    userCap: !!lastUser && lastUser.includes('x') ? (s.capsW || []).slice(-1)[0] || '' : '',   // bidak hitam yang kamu... (bidak lawan) ditangkap pemain
    aiCap: !!lastAi && lastAi.includes('x') ? (s.capsB || []).slice(-1)[0] || '' : '',         // bidak putih yang ditangkap lawan
    userInCheck: !s.done && inCheck(st.b, true),
    diff: matDiff(s)
  }
}
export function shouldSay(s, rnd = Math.random) {
  if (s.done) return true                                    // komentar penutup selalu ada
  const f = factsOf(s)
  if (f.n === 0) return rnd() < 0.8                           // sapaan di awal
  let p = 0.2
  if (f.aiCap) p = Math.max(p, 0.55)
  if (f.userCap) p = Math.max(p, 0.6)
  if (f.userInCheck) p = Math.max(p, 0.6)
  if (Math.abs(f.diff - (s.say?.diff ?? 0)) >= 3) p = Math.max(p, 0.75)  // keunggulan berubah banyak sejak ocehan terakhir
  const gap = (s.ply ?? 0) - (s.say?.ply ?? -99)
  if (gap < 4) p = p >= 0.6 ? p * 0.6 : 0                     // jangan cerewet: minimal 2 giliran antar ocehan (kecuali kejadian besar)
  return rnd() < p
}
export function sayPrompt(s, user, charName, style = '') {
  const f = factsOf(s), L = CHESS.levels[s.level]?.name || ''
  const rows = []
  for (let r = 0; r < 8; r++) rows.push((8 - r) + '  ' + s.b.slice(r * 8, r * 8 + 8).join(' '))
  const recent = (s.hist || []).slice(-6).map((m, i, a) => { const idx = s.hist.length - a.length + i; return `${idx % 2 === 0 ? user : 'kamu'}: ${m}` }).join(' | ')
  const ev = []
  if (f.n === 0) ev.push(`Permainan baru mulai. ${user} jalan duluan (putih).`)
  if (f.userCap) ev.push(`${user} baru menangkap ${pName(f.userCap)}mu.`)
  if (f.aiCap) ev.push(`Kamu baru menangkap ${pName(f.aiCap)} milik ${user}.`)
  if (f.userInCheck) ev.push(`Kamu sedang men-skak raja ${user}.`)
  const d = f.diff
  const mat = d === 0 ? 'Material seimbang.' : d > 0 ? `${user} unggul material ${d} poin.` : `Kamu unggul material ${-d} poin.`
  let end = ''
  if (s.done) {
    const why = { mate: 'skakmat', stale: 'pat', 50: 'aturan 50 langkah', rep: 'posisi berulang', material: 'material tidak cukup', resign: 'menyerah' }[s.reason] || s.reason
    end = s.won === 'b' ? (s.reason === 'resign' ? `PERMAINAN SELESAI: ${user} menyerah, kamu menang.` : `PERMAINAN SELESAI: kamu menang (${why}).`)
      : s.won === 'w' ? `PERMAINAN SELESAI: ${user} menang (${why}), kamu kalah.` : `PERMAINAN SELESAI: seri (${why}).`
  }
  return [
    `[Konteks game, bukan chat biasa: kamu sedang main catur melawan ${user}. Kamu memegang bidak HITAM, ${user} memegang PUTIH. Tingkat permainan: ${L}.`,
    'Papan sekarang (baris atas = rank 8, kolom kiri = a; HURUF BESAR = bidak putih milik ' + user + ', huruf kecil = bidak hitam milikmu, titik = kosong; K/k raja, Q/q ratu, R/r benteng, B/b gajah, N/n kuda, P/p pion):',
    rows.join('\n') + '\n   a b c d e f g h',
    recent ? 'Langkah terakhir (lama ke baru): ' + recent : 'Belum ada langkah.',
    ev.length ? 'Kejadian terbaru: ' + ev.join(' ') : '',
    mat, end,
    `Tugasmu: balas dengan SATU komentar singkat (maksimal 2 kalimat, di bawah 200 karakter) tentang permainan ini, dengan kepribadian dan gaya bicaramu sendiri, dalam bahasa Indonesia. Hanya bicara soal yang benar-benar ada di papan dan daftar langkah di atas; jangan menyebut langkah atau bidak yang tidak ada, jangan membuat analisis panjang, jangan menyebut kamu diberi prompt atau data.${style ? ' Gaya saat main catur: ' + style : ''}]`
  ].filter(Boolean).join('\n')
}
const cleanSay = t => String(t || '').replace(/<[^>]*>/g, '').replace(/\s+\n/g, '\n').trim().slice(0, 300)

/* ---------- Server ---------- */
export function mountChess(router, { wrap, userFromReq, allow, col, ensureWallet }) {
  const doc = r => (r && r.value !== undefined ? r.value : r)
  let idx
  const ready = () => idx ??= ensureIndexes('game_state', [[{ exp: 1 }, { expireAfterSeconds: 0 }]]).catch(e => { idx = null; throw e })
  const need = async (req, res) => {
    const a = await userFromReq(req)
    if (!a) { res.status(401).json({ error: 'Sesi berakhir, masuk lagi.' }); return null }
    await ready()
    return a.user
  }
  const sid = u => u._id + ':chess'
  const winsToday = u => (u.chessDay === dayNum(Date.now()) ? u.chessWins || 0 : 0)
  const stOf = s => ({ b: s.b, t: s.t, c: s.c, e: s.e, h: s.h }) // keadaan papan yang dipakai engine

  // bentuk permainan untuk client. Kotak langkah sah pemain (moves) hanya dikirim saat giliran pemain;
  // client tidak perlu tahu aturan catur, dia cuma menandai kotak tujuan yang dikirim server.
  function gameView(s) {
    if (!s) return null
    const st = stOf(s)
    const yourTurn = !s.done && s.t === 'w'
    const moves = {}
    if (yourTurn) for (const m of legal(st)) (moves[m.f] ??= []).push(m.t)
    return {
      active: !s.done, level: s.level, turn: s.t, board: s.b.join(''), moves: yourTurn ? moves : null,
      opp: s.opp || '', say: s.say?.t || '', ply: s.ply,
      last: s.lastMove || null, hist: s.hist.slice(-60), capsW: s.capsW || [], capsB: s.capsB || [],
      check: yourTurn && inCheck(st.b, true) ? kingSq(st.b, true) : -1,
      ...(s.done ? { result: { won: s.won, reason: s.reason }, reward: s.reward || 0 } : {})
    }
  }
  async function view(u, s) {
    const w = await ensureWallet(u)
    return { ok: true, cfg: { levels: Object.fromEntries(Object.entries(CHESS.levels).map(([k, v]) => [k, { name: v.name, prize: v.prize }])), drawPct: CHESS.drawPct }, daily: { wins: winsToday(u), cap: CHESS.dailyWins }, game: gameView(s), coins: w.coins, gems: w.gems }
  }

  // hadiah sekali di akhir permainan (menang = penuh, seri = persen). Balikan: { cu, reward, capped }
  async function grant(u, states, ns) {
    const L = CHESS.levels[ns.level] || CHESS.levels[2]
    const prize = ns.won === 'w' ? L.prize : Math.max(CHESS.drawMin, Math.round(L.prize * CHESS.drawPct))
    const users = await col('users'), today = dayNum(Date.now())
    await ensureWallet(u)
    await users.updateOne({ _id: u._id, chessDay: { $ne: today } }, { $set: { chessDay: today, chessWins: 0 } })
    const nu = doc(await users.findOneAndUpdate({ _id: u._id, chessDay: today, chessWins: { $lt: CHESS.dailyWins } }, { $inc: { coins: prize, chessWins: 1 } }, { returnDocument: 'after' }))
    if (nu) { await states.updateOne({ _id: sid(u) }, { $set: { reward: prize } }); return { cu: nu, reward: prize, capped: false } }
    return { cu: await users.findOne({ _id: u._id }) || u, reward: 0, capped: true }
  }

  router.post('/api/auth/chess', wrap(async (req, res) => {
    const u = await need(req, res); if (!u) return
    if (!(await allow('ch:' + u._id, 60, 60))) return res.status(429).json({ error: 'Terlalu sering, tunggu sebentar.' })
    res.json(await view(u, await (await col('game_state')).findOne({ _id: sid(u) })))
  }))

  router.post('/api/auth/chess/start', wrap(async (req, res) => {
    const u = await need(req, res); if (!u) return
    if (!(await allow('chs:' + u._id, 20, 60))) return res.status(429).json({ error: 'Terlalu sering, tunggu sebentar.' })
    const level = Number(req.body?.level)
    if (!CHESS.levels[level]) return res.status(400).json({ error: 'Pilih tingkat kesulitan 1-3.' })
    let opp = ''
    if (req.body?.opp) { // lawan karakter: hanya karakter yang punya `chess: true`
      const oc = (await loadChars()).find(c => c.id === String(req.body.opp))
      if (!oc || oc.chess !== true) return res.status(400).json({ error: 'Karakter itu belum bisa jadi lawan catur.' })
      opp = oc.id
    }
    const st = newState()
    const s = { _id: sid(u), userId: u._id, opp, b: st.b, t: st.t, c: st.c, e: st.e, h: st.h, ply: 0, level, hist: [], capsW: [], capsB: [], keys: [posKey(st)], lastMove: null, done: false, won: null, reason: null, reward: 0, exp: new Date(Date.now() + TTL_MS) }
    await (await col('game_state')).replaceOne({ _id: s._id }, s, { upsert: true })
    res.json(await view(u, s))
  }))

  router.post('/api/auth/chess/move', wrap(async (req, res) => {
    const u = await need(req, res); if (!u) return
    if (!(await allow('chm:' + u._id, 90, 60))) return res.status(429).json({ error: 'Terlalu sering, tunggu sebentar.' })
    const f = Number(req.body?.from), t = Number(req.body?.to), pr = String(req.body?.promo || 'Q').toUpperCase()
    if (![f, t].every(Number.isInteger) || (f < 0 || f > 63 || t < 0 || t > 63) || !'QRBN'.includes(pr))
      return res.status(400).json({ error: 'Langkah tidak dikenal.' })
    const states = await col('game_state'), s = await states.findOne({ _id: sid(u) })
    if (!s) return res.status(409).json({ error: 'Mulai permainan baru dulu.' })
    if (s.done) return res.status(409).json({ error: 'Permainan sudah selesai.' })
    if (s.t !== 'w') return res.status(409).json({ error: 'Bukan giliranmu.' })
    const st = stOf(s)
    const m = legal(st).find(x => x.f === f && x.t === t && (x.pr ? x.pr === pr : !x.pr))
    if (!m) return res.status(400).json({ error: 'Langkah itu tidak boleh.' })

    // 1) langkah pemain (putih)
    let st2 = apply(st, m), hist = [...s.hist, note(st, m)], keys = [...s.keys, posKey(st2)]
    let capsW = [...s.capsW], capsB = [...s.capsB]
    const victimP = m.ep ? 'p' : st.b[m.t]
    if (victimP !== '.') capsW.push(victimP)
    let lastMove = { f: m.f, t: m.t }, done = false, won = null, reason = null
    let end = endOf(st2, keys)
    if (end) ({ won, reason } = end, done = true)

    // 2) balasan AI (hitam), kalau permainan belum selesai
    let aiNote = ''
    if (!done) {
      const am = aiMove(st2, s.level)
      if (am) {
        const victimA = am.ep ? 'P' : st2.b[am.t]
        if (victimA !== '.') capsB.push(victimA)
        aiNote = note(st2, am)
        st2 = apply(st2, am)
        hist.push(aiNote); keys.push(posKey(st2))
        lastMove = { f: am.f, t: am.t }
        end = endOf(st2, keys)
        if (end) ({ won, reason } = end, done = true)
      }
    }

    // tulis atomik: hanya kalau giliran/ply masih sama (dua permintaan bersamaan tidak bisa dobel). exp ikut diperbarui: permainan hangus 24 jam setelah langkah TERAKHIR
    const ns = doc(await states.findOneAndUpdate(
      { _id: sid(u), done: false, ply: s.ply },
      { $set: { b: st2.b, t: st2.t, c: st2.c, e: st2.e, h: st2.h, hist, keys, capsW, capsB, lastMove, done, won, reason, exp: new Date(Date.now() + TTL_MS) }, $inc: { ply: 2 } },
      { returnDocument: 'after' }
    ))
    if (!ns) return res.status(409).json({ error: 'Permainan berubah, coba lagi.' })

    let reward = 0, capped = false, cu = u
    if (done && (won === 'w' || won === 'd')) {
      const g = await grant(u, states, ns)
      ;({ cu, reward, capped } = g) // titik koma wajib: tanpa ini baris atas terbaca sebagai pemanggilan fungsi (ASI)
      ns.reward = g.reward
    }
    res.json({ ...(await view(cu, ns)), ...(aiNote ? { aiNote } : {}), reward, capped })
  }))

  // Lawan "mengoceh". Aman dipanggil tiap langkah: kebanyakan panggilan selesai cepat tanpa memanggil model (peluang & jeda di shouldSay).
  router.post('/api/auth/chess/say', wrap(async (req, res) => {
    const u = await need(req, res); if (!u) return
    if (!(await allow('chsay:' + u._id, 40, 60))) return res.status(429).json({ error: 'Terlalu sering, tunggu sebentar.' })
    const states = await col('game_state'), s0 = await states.findOne({ _id: sid(u) })
    if (!s0 || !s0.opp) return res.json({ ok: true, say: null })
    const key = s0.ply + (s0.done ? ':end' : '')
    // penjaga atomik: satu kali percobaan per posisi (dua permintaan bersamaan atau muat ulang tidak memanggil model dua kali)
    const s = doc(await states.findOneAndUpdate({ _id: s0._id, sayKey: { $ne: key } }, { $set: { sayKey: key } }, { returnDocument: 'after' }))
    if (!s || !shouldSay(s)) return res.json({ ok: true, say: null })
    const oc = (await loadChars()).find(c => c.id === s.opp && c.chess === true)
    if (!oc) return res.json({ ok: true, say: null })
    let text = '', vn = ''
    // suara ikut pengaturan bawaan chat: client mengirim { on, lang } sama seperti /api/chat (jp | id). Kalau mati, tidak ada <jp>/<vn> yang diminta.
    const vq = req.body?.voice, voice = vq?.on ? { on: true, lang: vq.lang === 'id' ? 'id' : 'jp' } : { on: false }
    try {
      const style = String(oc.chessStyle || '').slice(0, 300)
      const out = await Promise.race([
        reply('chess:' + u._id, oc, sayPrompt(s, String(u.name || 'kamu').slice(0, 24), oc.name, style), { user: String(u.name || '').slice(0, 24), history: [], voice, memory: [], rel: null }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 30000))
      ])
      let fin; try { fin = finalize(out, oc, voice) } catch { fin = { id: out?.id } } // perapihan yang sama dengan chat biasa (tag ekspresi, bacaan nama, tawa)
      text = cleanSay(fin.id)
      if (voice.on && text && fin.vn) vn = String(fin.vn).slice(0, 600)
    } catch (e) { console.error('[chess] ocehan gagal:', e.message) }
    if (!text) return res.json({ ok: true, say: null })
    await states.updateOne({ _id: s._id }, { $set: { say: { t: text, ply: s.ply, diff: matDiff(s) } } })
    res.json({ ok: true, say: text, ...(vn && { vn }) })
  }))

  router.post('/api/auth/chess/resign', wrap(async (req, res) => {
    const u = await need(req, res); if (!u) return
    if (!(await allow('chr:' + u._id, 20, 60))) return res.status(429).json({ error: 'Terlalu sering, tunggu sebentar.' })
    const states = await col('game_state'), s = await states.findOne({ _id: sid(u) })
    if (!s) return res.status(409).json({ error: 'Belum ada permainan.' })
    if (s.done) return res.json(await view(u, s))
    const ns = doc(await states.findOneAndUpdate({ _id: sid(u), done: false }, { $set: { done: true, won: 'b', reason: 'resign' } }, { returnDocument: 'after' }))
    res.json(await view(u, ns || s))
  }))
}
