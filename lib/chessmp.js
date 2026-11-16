import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import {
  newState, legal, apply, posKey, endOf, note, sqName, inCheck, kingSq,
  insufficient, evaluate, VAL, MATE
} from './chess.js'

// CATUR MULTIPLAYER (PvP) + REVIEW + REPLAY + STATISTIK.
// Dipasang ke router auth (lib/auth.js) lewat mountChessMp(), jadi memakai sesi/token, pembatas laju,
// dan pola respons yang sama dengan fitur lain. Game catur melawan AI (lib/chess.js) TIDAK disentuh.
//
// Pembagian kerja frontend/backend:
//   - Frontend menangani seluruh interaksi papan (drag-and-drop, highlight, animasi).
//   - Backend adalah sumber kebenaran: semua aturan catur (langkah sah, rokade, en passant, promosi,
//     skak/skakmat, pat, 50 langkah, pengulangan tiga kali, material tidak cukup) divalidasi DI SINI
//     dengan engine yang sama dengan game vs AI (lib/chess.js). Langkah dikirim sebagai { from, to, promo? }.
//
// Koleksi MongoDB baru:
//   chess_rooms { _id: kode 6 char, hostId, hostName, hostColor 'w'|'b', status 'open'|'matched', guestId?,
//                 gameId?, createdAt, exp (TTL 1 jam) }
//   chess_games { _id: UUID, status 'active'|'done'|'aborted', whiteId/whiteName/whiteUser, blackId/blackName/blackUser,
//                 b:[64], t, c, e, h, ply, hist:[notasi panjang], moves:[{n,from,to,promo,uci,san,ts}],
//                 keys:[posKey], capsW:[], capsB:[], lastMove, drawOffer:{by,at},
//                 won, reason, result '1-0'|'0-1'|'1/2-1/2'|'*', pgn, review, seenW, seenB,
//                 createdAt, updatedAt, endedAt, exp (TTL 7 jam HANYA saat aktif; dilepas saat selesai supaya permanen) }
//   chess_stats { _id: userId, name, played, won, drawn, lost, accSum, accGames, bestAcc,
//                 labels:{best,great,excellent,mistake,miss,blunder}, updatedAt }
//
// Engine analisis:
//   - Default: engine INTERNAL (negamax alpha-beta + quiescence search, evaluasi Michniewski) — tanpa dependency baru.
//   - Opsional: Stockfish (atau engine UCI lain) lewat env STOCKFISH_PATH + CHESS_SF_DEPTH (default 12).
//     Kalau binary tidak ada / gagal dijalankan (mis. di Vercel serverless), otomatis fallback ke internal.
//
// Endpoints (semua POST, token Bearer, jawaban JSON) — dokumentasi lengkap: CHESS_FRONTEND_SPEC.md
//   /api/auth/mp/room         buat ruang tantangan (dapat kode 6 char)
//   /api/auth/mp/room/status  polling status ruang (host menunggu lawan)
//   /api/auth/mp/cancel       batalkan ruang
//   /api/auth/mp/join         masuk ke ruang lewat kode -> permainan dimulai
//   /api/auth/mp/games        daftar permainan saya
//   /api/auth/mp/game         detail permainan (papan + langkah sah)
//   /api/auth/mp/sync         polling ringan perubahan (langkah lawan, tawaran seri, hasil)
//   /api/auth/mp/move         kirim langkah { from, to, promo? } (divalidasi backend)
//   /api/auth/mp/resign       menyerah / batalkan (jika <2 langkah)
//   /api/auth/mp/draw         tawarkan / terima / tolak seri
//   /api/auth/mp/hint         rekomendasi langkah terbaik untuk posisi sekarang
//   /api/auth/mp/review       analisis pasca-permainan (label langkah, akurasi, grafik evaluasi)
//   /api/auth/mp/replay       data lengkap untuk memutar ulang tiap langkah
//   /api/auth/mp/stats        statistik pemain

export const MP = {
  roomTtlMin: 60,        // ruang tantangan hangus 1 jam
  gameTtlDays: 7,        // permainan AKTIF yang ditinggal 7 hari dihapus TTL (yang selesai permanen)
  drawTtlMs: 90e3,       // tawaran seri hangus 90 detik
  onlineMs: 45e3,        // lawan dianggap online kalau aktif < 45 detik lalu
  depth: (() => { const d = parseInt(process.env.CHESS_MP_DEPTH); return Number.isInteger(d) && d >= 1 && d <= 5 ? d : 3 })(),
  hintDepth: (() => { const d = parseInt(process.env.CHESS_MP_HINT_DEPTH); return Number.isInteger(d) && d >= 1 && d <= 5 ? d : 3 })(),
  sfDepth: (() => { const d = parseInt(process.env.CHESS_SF_DEPTH); return Number.isInteger(d) && d >= 1 && d <= 20 ? d : 12 })(),
  sfPath: process.env.STOCKFISH_PATH || '',
  listPage: 15           // permainan per halaman di /games
}
const FILES = 'abcdefgh'
const CODE_AB = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // tanpa karakter yang mudah tertukar (0/O/1/I)
const RESULT_OF = { w: '1-0', b: '0-1', d: '1/2-1/2' }

/* ================= NOTASI: SAN, UCI, FEN, PGN ================= */

/* SAN (Standar Algebraic Notation) dengan disambiguasi: Nbd2, R1xa3, exd5, e8=Q+, O-O, Qh4# */
export function sanOf(st, m, allLegal) {
  if (m.cs) return m.cs === 'K' ? 'O-O' : 'O-O-O'
  const p = st.b[m.f], q = p.toLowerCase()
  const cap = m.ep || st.b[m.t] !== '.'
  const n2 = apply(st, m)
  const oppCheck = inCheck(n2.b, n2.t === 'w')
  const suffix = oppCheck ? (legal(n2).length ? '+' : '#') : ''
  if (q === 'p') {
    let s = (cap ? FILES[m.f & 7] + 'x' : '') + sqName(m.t)
    if (m.pr) s += '=' + m.pr
    return s + suffix
  }
  // disambiguasi: ada bidak sejenis lain yang juga bisa ke kotak tujuan
  const others = (allLegal || legal(st)).filter(x => x.t === m.t && x.f !== m.f && st.b[x.f] === p)
  let dis = ''
  if (others.length) {
    const sameFile = others.some(x => (x.f & 7) === (m.f & 7))
    const sameRank = others.some(x => (x.f >> 3) === (m.f >> 3))
    if (!sameFile) dis = FILES[m.f & 7]
    else if (!sameRank) dis = String(8 - (m.f >> 3))
    else dis = sqName(m.f)
  }
  return p.toUpperCase() + dis + (cap ? 'x' : '') + sqName(m.t) + suffix
}

/* UCI: e2e4, e7e8q */
export const uciOf = m => sqName(m.f) + sqName(m.t) + (m.pr ? m.pr.toLowerCase() : '')

/* FEN penuh dari keadaan papan + nomor langkah penuh (fullmove) */
export function fenOf(st, fullmove) {
  let board = ''
  for (let r = 0; r < 8; r++) {
    let empty = 0
    for (let c = 0; c < 8; c++) {
      const p = st.b[r * 8 + c]
      if (p === '.') { empty++; continue }
      if (empty) { board += empty; empty = 0 }
      board += p
    }
    if (empty) board += empty
    if (r < 7) board += '/'
  }
  return `${board} ${st.t} ${st.c || '-'} ${st.e >= 0 ? sqName(st.e) : '-'} ${st.h} ${fullmove}`
}

/* PGN dari dokumen permainan (header + movetext SAN + hasil) */
export function pgnOf(g) {
  const d = new Date(g.createdAt || Date.now())
  const pad = n => String(n).padStart(2, '0')
  const why = { mate: 'checkmate', stale: 'stalemate', 50: '50-move rule', rep: 'threefold repetition', material: 'insufficient material', agreement: 'draw by agreement', resign: 'resignation', abort: 'abandoned' }[g.reason] || ''
  const heads = [
    ['Event', 'Neyhra Multiplayer Chess'],
    ['Site', 'neyhra-chat2'],
    ['Date', `${d.getUTCFullYear()}.${pad(d.getUTCMonth() + 1)}.${pad(d.getUTCDate())}`],
    ['Round', '-'],
    ['White', g.whiteName || '?'],
    ['Black', g.blackName || '?'],
    ['Result', g.result || '*'],
    ...(why ? [['Termination', why]] : [])
  ]
  let mt = '', line = ''
  const sans = (g.moves || []).map(m => m.san)
  for (let i = 0; i < sans.length; i++) {
    const tok = (i % 2 === 0 ? (i / 2 + 1) + '. ' : '') + sans[i]
    if ((line + ' ' + tok).trim().length > 78) { mt += line + '\n'; line = '' }
    line += (line ? ' ' : '') + tok
  }
  mt += (line ? line + ' ' : '') + (g.result || '*')
  return heads.map(([k, v]) => `[${k} "${v}"]`).join('\n') + '\n\n' + mt + '\n'
}

/* ================= ENGINE ANALISIS ================= */
/* Negamax alpha-beta + quiescence search (menyelesaikan pertukaran bidak supaya deteksi blunder tidak
   kena horizon effect). Skor selalu dari perspektif PIHAK YANG JALAN (side to move), seperti konvensi UCI. */

function mScoreOf(st, m) { // urutan eksplorasi MVV-LVA + promosi (sama dengan lib/chess.js)
  const victim = m.ep ? 'p' : st.b[m.t].toLowerCase()
  let s = victim === '.' ? 0 : VAL[victim] * 10 - VAL[st.b[m.f].toLowerCase()]
  if (m.pr) s += VAL[m.pr.toLowerCase()]
  return s
}

function qsearch(st, alpha, beta, ply) {
  const ms = legal(st)
  if (!ms.length) return inCheck(st.b, st.t === 'w') ? -MATE + ply : 0
  const white = st.t === 'w'
  let stand = white ? evaluate(st.b) : -evaluate(st.b)
  if (st.h >= 100 || insufficient(st.b)) return 0
  if (stand >= beta) return stand
  if (stand > alpha) alpha = stand
  const caps = ms.filter(m => m.ep || st.b[m.t] !== '.' || m.pr)
  caps.sort((a, b) => mScoreOf(st, b) - mScoreOf(st, a))
  for (const m of caps) {
    const v = -qsearch(apply(st, m), -beta, -alpha, ply + 1)
    if (v >= beta) return v
    if (v > alpha) alpha = v
  }
  return alpha
}

function absearch(st, depth, alpha, beta, ply) {
  const ms = legal(st)
  if (!ms.length) return inCheck(st.b, st.t === 'w') ? -MATE + ply : 0
  if (st.h >= 100 || insufficient(st.b)) return 0
  if (depth <= 0) return qsearch(st, alpha, beta, ply)
  ms.sort((a, b) => mScoreOf(st, b) - mScoreOf(st, a))
  let best = -Infinity
  for (const m of ms) {
    const v = -absearch(apply(st, m), depth - 1, -beta, -alpha, ply + 1)
    if (v > best) best = v
    if (best > alpha) alpha = best
    if (alpha >= beta) break
  }
  return best
}

/* Cari langkah terbaik pada posisi st. Hasil: { best: langkah|null, score: cp side-to-move } */
export function rootSearch(st, depth) {
  const ms = legal(st)
  if (!ms.length) return { best: null, score: inCheck(st.b, st.t === 'w') ? -MATE : 0 }
  ms.sort((a, b) => mScoreOf(st, b) - mScoreOf(st, a))
  let best = null, bestV = -Infinity
  for (const m of ms) {
    const v = -absearch(apply(st, m), depth - 1, -Infinity, Infinity, 1)
    if (v > bestV) { bestV = v; best = m }
  }
  return { best, score: bestV }
}

/* ---------- Adapter UCI (Stockfish atau engine lain) — OPSIONAL via env STOCKFISH_PATH ---------- */
let sfDead = 0 // timestamp terakhir kali binary gagal dijalankan (jangan coba-coba tiap posisi kalau memang mati)
/* Analisis satu posisi lewat proses UCI. Hasil { bestUci, cpSideToMove, mateSideToMove|null } atau null kalau gagal. */
function sfAnalyze(fen, depth) {
  return new Promise(resolve => {
    let out = '', best = null, score = null, done = false
    const p = spawn(MP.sfPath, [], { stdio: ['pipe', 'pipe', 'ignore'] })
    const finish = r => { if (done) return; done = true; clearTimeout(to); try { p.stdin.destroy(); p.kill() } catch {} resolve(r) }
    const to = setTimeout(() => finish(null), 20000)
    p.on('error', () => { sfDead = Date.now(); finish(null) })
    p.stdout.on('data', d => {
      out += d.toString()
      let idx
      while ((idx = out.indexOf('\n')) >= 0) {
        const line = out.slice(0, idx).trim(); out = out.slice(idx + 1)
        if (line.startsWith('info') && line.includes('score')) {
          const cp = /score cp (-?\d+)/.exec(line), mate = /score mate (-?\d+)/.exec(line)
          if (cp) score = { cp: parseInt(cp[1]) }
          else if (mate) score = { mate: parseInt(mate[1]) }
        } else if (line.startsWith('bestmove')) {
          best = line.split(/\s+/)[1]
          finish({ bestUci: best, score })
        }
      }
    })
    p.stdin.write(`uci\nisready\nposition fen ${fen}\ngo depth ${depth}\n`)
  })
}
/* true kalau Stockfish siap dipakai (env terisi dan tidak baru saja gagal) */
const sfReady = () => !!MP.sfPath && Date.now() - sfDead > 60000

/* Analisis satu posisi: pakai Stockfish kalau siap, kalau tidak engine internal.
   Hasil { cpWhite, mateInWhite|null, best: langkah|null } — cpWhite = evaluasi dari sudut PUTIH. */
async function analyzePos(st, fullmove, depth, sfDepth) {
  if (sfReady()) {
    const r = await sfAnalyze(fenOf(st, fullmove), sfDepth)
    if (r && r.bestUci) {
      const mv = parseUci(st, r.bestUci)
      let cpWhite = 0, mate = null
      if (r.score?.mate != null) {
        const n = r.score.mate
        mate = n > 0 ? (st.t === 'w' ? n : -n) : (st.t === 'w' ? n : -n) // +N = putih menang dalam N, -N = hitam menang dalam N
        cpWhite = n > 0 ? (st.t === 'w' ? MATE - n : -(MATE - n)) : (st.t === 'w' ? -(MATE + n) : MATE + n)
      } else cpWhite = st.t === 'w' ? (r.score?.cp ?? 0) : -(r.score?.cp ?? 0)
      return { cpWhite, mateInWhite: mate, best: mv }
    }
    sfDead = Date.now() // gagal -> matikan sejenak, pakai internal
  }
  const r = rootSearch(st, depth)
  const cpWhite = st.t === 'w' ? r.score : -r.score
  let mate = null
  if (Math.abs(r.score) >= MATE - 1000) {
    const n = MATE - Math.abs(r.score)
    mate = r.score > 0 ? (st.t === 'w' ? n : -n) : (st.t === 'w' ? -n : n)
  }
  return { cpWhite, mateInWhite: mate, best: r.best }
}

/* "e2e4"/"e7e8q" -> objek langkah dari daftar langkah sah (null kalau tidak cocok) */
export function parseUci(st, uci) {
  const s = String(uci || '').toLowerCase()
  if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(s)) return null
  const f = (8 - +s[1]) * 8 + FILES.indexOf(s[0])
  const t = (8 - +s[3]) * 8 + FILES.indexOf(s[2])
  const pr = s[4] ? s[4].toUpperCase() : null
  return legal(st).find(x => x.f === f && x.t === t && (x.pr ? x.pr === pr : !x.pr)) || null
}

/* ================= REVIEW (Chess Review) ================= */
/* Peluang menang (0..100) dari skor centipawn PUTIH — kurva sigmoid ala Lichess (k = 0.00368208).
   |cp| >= 10000 dianggap mate. winPct pemain HITAM = 100 - winPct putih. */
const K_SIG = 0.00368208
export const winPct = cpWhite => 50 + 50 * (2 / (1 + Math.exp(-K_SIG * Math.max(-10000, Math.min(10000, cpWhite)))) - 1)
/* Akurasi satu langkah dari penurunan peluang menang (delta, poin win%). Formula ala Lichess. */
export const moveAcc = delta => Math.max(0, Math.min(100, 103.1668 * Math.exp(-0.04354 * Math.max(0, delta)) - 3.1668))
/* Label langkah. delta = win% sebelum - sesudah (pemain yang melangkah; positif = memburuk).
   Urutan kualitas: Best > Great > Excellent > Mistake > Blunder; Miss = khusus "kehilangan kemenangan". */
export function labelOf(delta, isBest, winBefore, winAfter) {
  if (isBest) return 'Best'
  if (winBefore >= 90 && winAfter < 90 && delta < 20) return 'Miss'
  if (delta <= 2) return 'Great'
  if (delta <= 5) return 'Excellent'
  if (delta < 15) return 'Mistake'
  return 'Blunder'
}

/* Susun ulang semua posisi dari awal (untuk review & replay). positions[0] = posisi awal. */
export function positionsOf(g) {
  const st0 = newState()
  const positions = [st0]
  for (const mv of g.moves || []) {
    const st = positions[positions.length - 1]
    const m = legal(st).find(x => x.f === mv.from && x.t === mv.to && (x.pr ? x.pr === mv.promo : !x.pr))
    positions.push(m ? apply(st, m) : st) // mv tersimpan dari server sehingga selalu sah; guard kalau data rusak
  }
  return positions
}

/* Hitung review lengkap sebuah permainan (dipanggil sekali, hasilnya disimpan di dokumen game). */
export async function buildReview(g) {
  const useSf = sfReady()
  const positions = positionsOf(g)
  const ev = [], mates = [], bests = []
  for (let i = 0; i < positions.length; i++) {
    const r = await analyzePos(positions[i], Math.floor(i / 2) + 1, MP.depth, MP.sfDepth)
    ev.push(Math.round(r.cpWhite))
    mates.push(r.mateInWhite)
    bests.push(r.best)
  }
  const moves = (g.moves || []).map((mv, i) => {
    const before = ev[i], after = ev[i + 1]
    const color = i % 2 === 0 ? 'w' : 'b'
    const winB = color === 'w' ? winPct(before) : 100 - winPct(before)
    const winA = color === 'w' ? winPct(after) : 100 - winPct(after)
    const delta = Math.max(0, winB - winA)
    const best = bests[i]
    const isBest = !!best && best.f === mv.from && best.t === mv.to && (best.pr || null) === (mv.promo || null)
    const cpLoss = color === 'w' ? before - after : after - before
    const st = positions[i]
    return {
      ply: i + 1, color, san: mv.san, uci: mv.uci, from: mv.from, to: mv.to, ...(mv.promo ? { promo: mv.promo } : {}),
      evalBefore: before, evalAfter: after, cpLoss: Math.round(cpLoss),
      winBefore: Math.round(winB * 10) / 10, winAfter: Math.round(winA * 10) / 10, delta: Math.round(delta * 10) / 10,
      acc: Math.round(moveAcc(delta) * 10) / 10,
      label: labelOf(delta, isBest, winB, winA),
      bestSan: best ? sanOf(st, best) : null, bestUci: best ? uciOf(best) : null
    }
  })
  const round1 = x => x == null ? null : Math.round(x * 10) / 10
  const avg = c => { const a = moves.filter(x => x.color === c); return a.length ? a.reduce((s, x) => s + x.acc, 0) / a.length : null }
  const counts = {}
  for (const c of ['w', 'b']) {
    counts[c] = { best: 0, great: 0, excellent: 0, mistake: 0, miss: 0, blunder: 0 }
    for (const x of moves.filter(x => x.color === c)) counts[c][x.label.toLowerCase()]++
  }
  return {
    engine: useSf ? `stockfish-d${MP.sfDepth}` : `internal-d${MP.depth}`,
    depth: useSf ? MP.sfDepth : MP.depth,
    ev, mates,
    moves,
    accuracy: { w: round1(avg('w')), b: round1(avg('b')) },
    counts,
    reviewedAt: new Date().toISOString()
  }
}

/* ================= SERVER ================= */
const doc = r => (r && r.value !== undefined ? r.value : r)
const stOf = g => ({ b: g.b, t: g.t, c: g.c, e: g.e, h: g.h })
const now = () => Date.now()

export function mountChessMp(router, { wrap, userFromReq, allow, col, ensureIndexes }) {
  let idx
  const ready = () => idx ??= ensureIndexes('chess_rooms', [[{ exp: 1 }, { expireAfterSeconds: 0 }], [{ hostId: 1 }, { createdAt: -1 }]])
    .then(() => ensureIndexes('chess_games', [[{ exp: 1 }, { expireAfterSeconds: 0 }], [{ whiteId: 1 }, { updatedAt: -1 }], [{ blackId: 1 }, { updatedAt: -1 }]]))
    .catch(e => { idx = null; throw e })
  const need = async (req, res) => {
    const a = await userFromReq(req)
    if (!a) { res.status(401).json({ error: 'Sesi berakhir, masuk lagi.' }); return null }
    await ready()
    return a.user
  }

  /* ---------- Helper permainan ---------- */
  const oppSeen = (g, you) => (you === 'w' ? g.seenB : g.seenW) || 0
  const drawActive = g => (g.drawOffer && g.status === 'active' && now() - g.drawOffer.at < MP.drawTtlMs) ? g.drawOffer : null
  const touchSeen = async (g, you) => {
    await (await col('chess_games')).updateOne({ _id: g._id }, { $set: you === 'w' ? { seenW: now() } : { seenB: now() } }).catch(() => { })
  }

  function gameView(g, uid) {
    if (!g) return null
    const st = stOf(g)
    const you = g.whiteId === uid ? 'w' : 'b'
    const active = g.status === 'active'
    const yourTurn = active && g.t === you
    const moves = {}
    if (yourTurn) for (const m of legal(st)) (moves[m.f] ??= []).push(m.t)
    const check = active && inCheck(st.b, st.t === 'w') ? kingSq(st.b, st.t === 'w') : -1
    const dr = drawActive(g)
    return {
      id: g._id, status: g.status, turn: g.t, you, yourTurn, active,
      board: g.b.join(''), ply: g.ply,
      moves: yourTurn ? moves : null,
      last: g.lastMove || null,
      hist: (g.hist || []).slice(-80),
      sans: (g.moves || []).slice(-80).map(m => m.san),
      capsW: g.capsW || [], capsB: g.capsB || [],
      check,
      draw: dr ? { by: dr.by, mine: dr.by === you } : null,
      white: { name: g.whiteName, username: g.whiteUser },
      black: { name: g.blackName, username: g.blackUser },
      opp: { name: you === 'w' ? g.blackName : g.whiteName, username: you === 'w' ? g.blackUser : g.whiteUser, online: active && now() - oppSeen(g, you) < MP.onlineMs },
      createdAt: g.createdAt, updatedAt: g.updatedAt,
      ...(g.status === 'done' ? { result: { won: g.won, reason: g.reason, score: g.result }, pgn: g.pgn || pgnOf(g) } : {}),
      ...(g.status === 'aborted' ? { result: { won: null, reason: g.reason || 'abort', score: '*' } } : {}),
      reviewed: !!g.review
    }
  }

  async function loadGame(u, id) {
    const g = await (await col('chess_games')).findOne({ _id: String(id || '').slice(0, 64) })
    if (!g || (g.whiteId !== u._id && g.blackId !== u._id)) return null
    return g
  }

  /* Selesaikan permainan: status done + pgn + lepas TTL + statistik kedua pemain. Dipanggil dengan dokumen SUDAH di-update atomik. */
  async function finishStats(g) {
    if (g.status !== 'done') return
    const stats = await col('chess_stats')
    const incFor = (uid, name, won) => {
      // upsert + $inc: dokumen baru otomatis dapat struktur lengkap dari $setOnInsert (tanpa `played`, itu milik $inc)
      const u = { $inc: { played: 1 }, $set: { name, updatedAt: new Date() }, $setOnInsert: { won: 0, drawn: 0, lost: 0, accSum: 0, accGames: 0, bestAcc: 0, labels: { best: 0, great: 0, excellent: 0, mistake: 0, miss: 0, blunder: 0 } } }
      if (won === 'w') u.$inc.won = 1
      else if (won === 'd') u.$inc.drawn = 1
      else u.$inc.lost = 1
      return stats.updateOne({ _id: uid }, u, { upsert: true })
    }
    const myWon = p => (g.won === 'd' ? 'd' : g.won === p ? 'w' : 'b')
    await incFor(g.blackId, g.blackName, myWon('b'))
    await incFor(g.whiteId, g.whiteName, myWon('w'))
  }

  /* Simpan review ke statistik kedua pemain (akurasi + label). Dipanggil setelah review tersimpan. */
  async function reviewStats(g, review) {
    const stats = await col('chess_stats')
    for (const [uid, name, c] of [[g.whiteId, g.whiteName, 'w'], [g.blackId, g.blackName, 'b']]) {
      const acc = review.accuracy[c]
      if (acc == null) continue
      const u = {
        $inc: { accSum: acc, accGames: 1, ...Object.fromEntries(Object.entries(review.counts[c]).map(([k, v]) => ['labels.' + k, v])) },
        $set: { name, updatedAt: new Date() }
      }
      await stats.updateOne({ _id: uid }, u, { upsert: true })
      await stats.updateOne({ _id: uid, bestAcc: { $lt: acc } }, { $set: { bestAcc: acc } })
    }
  }

  /* ---------- Ruang tantangan ---------- */
  router.post('/api/auth/mp/room', wrap(async (req, res) => {
    const u = await need(req, res); if (!u) return
    if (!(await allow('mpr:' + u._id, 10, 60))) return res.status(429).json({ error: 'Terlalu sering, tunggu sebentar.' })
    let color = req.body?.color
    if (color !== 'w' && color !== 'b') color = crypto.randomInt(2) ? 'w' : 'b'
    const rooms = await col('chess_rooms')
    for (let i = 0; i < 6; i++) {
      const code = Array.from(crypto.randomBytes(6)).map(b => CODE_AB[b % CODE_AB.length]).join('')
      try {
        await rooms.insertOne({ _id: code, hostId: u._id, hostName: String(u.name || '').slice(0, 20), hostUser: u.username, hostColor: color, status: 'open', createdAt: new Date(), exp: new Date(now() + MP.roomTtlMin * 60e3) })
        return res.json({ ok: true, code, color, ttlMin: MP.roomTtlMin })
      } catch { /* kode bentrok: coba lagi */ }
    }
    res.status(500).json({ error: 'Gagal membuat kode ruang, coba lagi.' })
  }))

  router.post('/api/auth/mp/room/status', wrap(async (req, res) => {
    const u = await need(req, res); if (!u) return
    if (!(await allow('mps:' + u._id, 90, 60))) return res.status(429).json({ error: 'Terlalu sering, tunggu sebentar.' })
    const code = String(req.body?.code || '').toUpperCase()
    const r = await (await col('chess_rooms')).findOne({ _id: code })
    if (!r || r.hostId !== u._id) return res.json({ ok: true, status: 'gone' })
    if (r.status !== 'matched') return res.json({ ok: true, status: 'open', code })
    // ruang sudah cocok: beri gameId hanya kalau pemain ini peserta permainannya
    let gameId = null
    if (r.gameId) {
      const g = await (await col('chess_games')).findOne({ _id: r.gameId })
      if (g && (g.whiteId === u._id || g.blackId === u._id)) gameId = g._id
    }
    res.json({ ok: true, status: gameId ? 'matched' : 'gone', ...(gameId ? { gameId } : {}) })
  }))

  router.post('/api/auth/mp/cancel', wrap(async (req, res) => {
    const u = await need(req, res); if (!u) return
    if (!(await allow('mpc:' + u._id, 10, 60))) return res.status(429).json({ error: 'Terlalu sering, tunggu sebentar.' })
    const code = String(req.body?.code || '').toUpperCase()
    await (await col('chess_rooms')).deleteOne({ _id: code, hostId: u._id, status: 'open' })
    res.json({ ok: true })
  }))

  router.post('/api/auth/mp/join', wrap(async (req, res) => {
    const u = await need(req, res); if (!u) return
    if (!(await allow('mpj:' + u._id, 10, 60))) return res.status(429).json({ error: 'Terlalu sering, tunggu sebentar.' })
    const code = String(req.body?.code || '').toUpperCase()
    if (!/^[A-Z2-9]{6}$/.test(code)) return res.status(400).json({ error: 'Kode ruang tidak valid.' })
    const rooms = await col('chess_rooms')
    const r = doc(await rooms.findOneAndUpdate(
      { _id: code, status: 'open', hostId: { $ne: u._id } },
      { $set: { status: 'matched', guestId: u._id, guestName: String(u.name || '').slice(0, 20), guestUser: u.username } },
      { returnDocument: 'after' }
    ))
    if (!r) {
      const again = await rooms.findOne({ _id: code })
      if (again && again.hostId === u._id) return res.status(400).json({ error: 'Itu kode ruanganmu sendiri.' })
      if (again && again.status !== 'open') return res.status(409).json({ error: 'Ruang itu sudah penuh atau sudah dimulai.' })
      return res.status(404).json({ error: 'Ruang tidak ditemukan. Periksa kodenya lagi.' })
    }
    // buat permainan: hostColor menentukan warna host, tamu dapat sisanya
    const st = newState()
    const white = r.hostColor === 'w'
      ? { id: r.hostId, name: r.hostName, user: r.hostUser }
      : { id: r.guestId, name: r.guestName, user: r.guestUser }
    const black = r.hostColor === 'w'
      ? { id: r.guestId, name: r.guestName, user: r.guestUser }
      : { id: r.hostId, name: r.hostName, user: r.hostUser }
    const g = {
      _id: crypto.randomUUID(), status: 'active',
      whiteId: white.id, whiteName: white.name, whiteUser: white.user,
      blackId: black.id, blackName: black.name, blackUser: black.user,
      b: st.b, t: st.t, c: st.c, e: st.e, h: st.h, ply: 0,
      hist: [], moves: [], keys: [posKey(st)], capsW: [], capsB: [], lastMove: null, drawOffer: null,
      won: null, reason: null, result: null, pgn: null, // `review` sengaja TIDAK diisi: guard penyimpanan analisis memakai { review: { $exists: false } }
      seenW: now(), seenB: now(),
      createdAt: new Date(), updatedAt: new Date(), endedAt: null,
      exp: new Date(now() + MP.gameTtlDays * 86400e3)
    }
    const games = await col('chess_games')
    try { await games.insertOne(g) } catch (e) {
      await rooms.updateOne({ _id: code }, { $set: { status: 'open' }, $unset: { guestId: '', guestName: '', guestUser: '' } }).catch(() => { })
      throw e
    }
    await rooms.updateOne({ _id: code }, { $set: { gameId: g._id } })
    res.json({ ok: true, game: gameView(g, u._id) })
  }))

  /* ---------- Daftar & detail ---------- */
  router.post('/api/auth/mp/games', wrap(async (req, res) => {
    const u = await need(req, res); if (!u) return
    if (!(await allow('mpg:' + u._id, 30, 60))) return res.status(429).json({ error: 'Terlalu sering, tunggu sebentar.' })
    const page = Math.max(0, Math.min(50, parseInt(req.body?.page) || 0))
    const games = await col('chess_games')
    const cur = games.find({ $or: [{ whiteId: u._id }, { blackId: u._id }] }, { projection: { review: 0, keys: 0 } })
      .sort({ updatedAt: -1 }).skip(page * MP.listPage).limit(MP.listPage + 1)
    const rows = (await cur.toArray()).slice(0, MP.listPage).map(g => {
      const you = g.whiteId === u._id ? 'w' : 'b'
      return {
        id: g._id, status: g.status, turn: g.t, you, yourTurn: g.status === 'active' && g.t === you, ply: g.ply,
        opp: { name: you === 'w' ? g.blackName : g.whiteName, username: you === 'w' ? g.blackUser : g.whiteUser },
        last: g.lastMove || null, sans: (g.moves || []).slice(-12).map(m => m.san),
        ...(g.status === 'done' ? { result: { won: g.won, reason: g.reason, score: g.result } } : {}),
        ...(g.status === 'aborted' ? { result: { won: null, reason: g.reason || 'abort', score: '*' } } : {}),
        reviewed: !!g.review, updatedAt: g.updatedAt
      }
    })
    res.json({ ok: true, games: rows, page, more: rows.length === MP.listPage, active: rows.filter(r => r.status === 'active').length })
  }))

  router.post('/api/auth/mp/game', wrap(async (req, res) => {
    const u = await need(req, res); if (!u) return
    if (!(await allow('mpd:' + u._id, 60, 60))) return res.status(429).json({ error: 'Terlalu sering, tunggu sebentar.' })
    const g = await loadGame(u, req.body?.id)
    if (!g) return res.status(404).json({ error: 'Permainan tidak ditemukan.' })
    await touchSeen(g, g.whiteId === u._id ? 'w' : 'b')
    res.json({ ok: true, game: gameView(g, u._id) })
  }))

  /* ---------- Sinkronisasi ringan (polling) ---------- */
  router.post('/api/auth/mp/sync', wrap(async (req, res) => {
    const u = await need(req, res); if (!u) return
    if (!(await allow('mpsy:' + u._id, 40, 30))) return res.status(429).json({ error: 'Terlalu sering, tunggu sebentar.' })
    const g = await loadGame(u, req.body?.id)
    if (!g) return res.status(404).json({ error: 'Permainan tidak ditemukan.' })
    const you = g.whiteId === u._id ? 'w' : 'b'
    await touchSeen(g, you)
    const known = Math.max(0, parseInt(req.body?.ply) || 0)
    const newMoves = g.ply > known ? (g.moves || []).slice(known).map(m => ({ n: m.n, from: m.from, to: m.to, ...(m.promo ? { promo: m.promo } : {}), uci: m.uci, san: m.san, ts: m.ts })) : []
    const dr = drawActive(g)
    res.json({
      ok: true, id: g._id, status: g.status, ply: g.ply, turn: g.t, yourTurn: g.status === 'active' && g.t === you,
      board: g.b.join(''), last: g.lastMove || null,
      ...(g.status === 'active' && inCheck(g.b, g.t === 'w') ? { check: kingSq(g.b, g.t === 'w') } : { check: -1 }),
      draw: dr ? { by: dr.by, mine: dr.by === you } : null,
      ...(newMoves.length ? { newMoves } : {}),
      oppOnline: g.status === 'active' && now() - oppSeen(g, you) < MP.onlineMs,
      ...(g.status === 'done' ? { result: { won: g.won, reason: g.reason, score: g.result }, pgn: g.pgn || pgnOf(g) } : {}),
      ...(g.status === 'aborted' ? { result: { won: null, reason: g.reason || 'abort', score: '*' } } : {}),
      reviewed: !!g.review
    })
  }))

  /* ---------- Langkah (divalidasi backend: seluruh aturan catur) ---------- */
  router.post('/api/auth/mp/move', wrap(async (req, res) => {
    const u = await need(req, res); if (!u) return
    if (!(await allow('mpm:' + u._id, 120, 60))) return res.status(429).json({ error: 'Terlalu sering, tunggu sebentar.' })
    const f = Number(req.body?.from), t = Number(req.body?.to), pr = String(req.body?.promo || 'Q').toUpperCase()
    if (![f, t].every(Number.isInteger) || (f < 0 || f > 63 || t < 0 || t > 63) || !'QRBN'.includes(pr))
      return res.status(400).json({ error: 'Langkah tidak dikenal.' })
    const games = await col('chess_games')
    const s = await games.findOne({ _id: String(req.body?.id || '').slice(0, 64) })
    if (!s || (s.whiteId !== u._id && s.blackId !== u._id)) return res.status(404).json({ error: 'Permainan tidak ditemukan.' })
    if (s.status !== 'active') return res.status(409).json({ error: 'Permainan sudah selesai.' })
    const you = s.whiteId === u._id ? 'w' : 'b'
    if (s.t !== you) return res.status(409).json({ error: 'Bukan giliranmu.' })
    const st = stOf(s)
    const m = legal(st).find(x => x.f === f && x.t === t && (x.pr ? x.pr === pr : !x.pr))
    if (!m) return res.status(400).json({ error: 'Langkah itu tidak boleh.' })

    const san = sanOf(st, m), uci = uciOf(m), longNote = note(st, m)
    const ns = apply(st, m)
    const hist = [...(s.hist || []), longNote]
    const keys = [...(s.keys || []), posKey(ns)]
    const capsW = [...(s.capsW || [])], capsB = [...(s.capsB || [])]
    const victim = m.ep ? (you === 'w' ? 'p' : 'P') : s.b[m.t]
    if (victim !== '.') (you === 'w' ? capsW : capsB).push(victim)
    const moves = [...(s.moves || []), { n: s.ply + 1, from: m.f, to: m.t, ...(m.pr ? { promo: m.pr } : {}), uci, san, ts: now() }]
    let done = false, won = null, reason = null
    const end = endOf(ns, keys)
    if (end) ({ won, reason } = end, done = true)

    const ns2 = doc(await games.findOneAndUpdate(
      { _id: s._id, status: 'active', ply: s.ply },
      {
        $set: {
          b: ns.b, t: ns.t, c: ns.c, e: ns.e, h: ns.h, hist, keys, capsW, capsB, moves,
          lastMove: { f: m.f, t: m.t }, updatedAt: new Date(), drawOffer: null,
          ...(you === 'w' ? { seenW: now() } : { seenB: now() }),
          ...(done ? { status: 'done', won, reason, result: RESULT_OF[won], pgn: pgnOf({ ...s, moves, won, reason, result: RESULT_OF[won], createdAt: s.createdAt }), endedAt: new Date() } : {})
        },
        $unset: { ...(done ? { exp: '' } : {}) },
        $inc: { ply: 1 }
      },
      { returnDocument: 'after' }
    ))
    if (!ns2) return res.status(409).json({ error: 'Permainan berubah, coba lagi.' })
    if (ns2.status === 'done') await finishStats(ns2)
    res.json({ ok: true, game: gameView(ns2, u._id), move: { n: ns2.ply, san, uci, from: m.f, to: m.t, ...(m.pr ? { promo: m.pr } : {}) } })
  }))

  /* ---------- Menyerah / batal ---------- */
  router.post('/api/auth/mp/resign', wrap(async (req, res) => {
    const u = await need(req, res); if (!u) return
    if (!(await allow('mprs:' + u._id, 10, 60))) return res.status(429).json({ error: 'Terlalu sering, tunggu sebentar.' })
    const games = await col('chess_games')
    const s = await games.findOne({ _id: String(req.body?.id || '').slice(0, 64) })
    if (!s || (s.whiteId !== u._id && s.blackId !== u._id)) return res.status(404).json({ error: 'Permainan tidak ditemukan.' })
    if (s.status !== 'active') return res.json({ ok: true, game: gameView(s, u._id) })
    const you = s.whiteId === u._id ? 'w' : 'b'
    // belum ada langkah sama sekali -> batal (tidak dihitung sebagai kalah)
    if (s.ply < 2) {
      const ns = doc(await games.findOneAndUpdate(
        { _id: s._id, status: 'active' },
        { $set: { status: 'aborted', reason: 'abort', result: '*', endedAt: new Date(), updatedAt: new Date() }, $unset: { exp: '', drawOffer: '' } },
        { returnDocument: 'after' }
      ))
      return res.json({ ok: true, game: gameView(ns || s, u._id) })
    }
    const won = you === 'w' ? 'b' : 'w'
    const ns = doc(await games.findOneAndUpdate(
      { _id: s._id, status: 'active' },
      {
        $set: { status: 'done', won, reason: 'resign', result: RESULT_OF[won], pgn: pgnOf({ ...s, won, reason: 'resign', result: RESULT_OF[won] }), endedAt: new Date(), updatedAt: new Date() },
        $unset: { exp: '', drawOffer: '' }
      },
      { returnDocument: 'after' }
    ))
    if (ns) await finishStats(ns)
    res.json({ ok: true, game: gameView(ns || s, u._id) })
  }))

  /* ---------- Seri (tawarkan / terima / tolak) ---------- */
  router.post('/api/auth/mp/draw', wrap(async (req, res) => {
    const u = await need(req, res); if (!u) return
    if (!(await allow('mpdr:' + u._id, 20, 60))) return res.status(429).json({ error: 'Terlalu sering, tunggu sebentar.' })
    const act = req.body?.act
    const games = await col('chess_games')
    const s = await games.findOne({ _id: String(req.body?.id || '').slice(0, 64) })
    if (!s || (s.whiteId !== u._id && s.blackId !== u._id)) return res.status(404).json({ error: 'Permainan tidak ditemukan.' })
    if (s.status !== 'active') return res.status(409).json({ error: 'Permainan sudah selesai.' })
    const you = s.whiteId === u._id ? 'w' : 'b'
    if (act === 'offer') {
      const ns = doc(await games.findOneAndUpdate(
        { _id: s._id, status: 'active' },
        { $set: { drawOffer: { by: you, at: now() }, updatedAt: new Date() } },
        { returnDocument: 'after' }
      ))
      return res.json({ ok: true, draw: { by: you, mine: true } })
    }
    if (act === 'decline') {
      await games.updateOne({ _id: s._id, status: 'active' }, { $set: { updatedAt: new Date() }, $unset: { drawOffer: '' } })
      return res.json({ ok: true, draw: null })
    }
    if (act === 'accept') {
      const offer = drawActive(s)
      if (!offer || offer.by === you) return res.status(409).json({ error: 'Tidak ada tawaran seri dari lawan.' })
      const ns = doc(await games.findOneAndUpdate(
        { _id: s._id, status: 'active', 'drawOffer.by': offer.by },
        {
          $set: { status: 'done', won: 'd', reason: 'agreement', result: '1/2-1/2', pgn: pgnOf({ ...s, won: 'd', reason: 'agreement', result: '1/2-1/2' }), endedAt: new Date(), updatedAt: new Date() },
          $unset: { exp: '', drawOffer: '' }
        },
        { returnDocument: 'after' }
      ))
      if (ns) await finishStats(ns)
      return res.json({ ok: true, game: gameView(ns || s, u._id) })
    }
    res.status(400).json({ error: 'Aksi tidak dikenal (offer | accept | decline).' })
  }))

  /* ---------- Rekomendasi langkah (hint) ---------- */
  router.post('/api/auth/mp/hint', wrap(async (req, res) => {
    const u = await need(req, res); if (!u) return
    if (!(await allow('mph:' + u._id, 10, 60))) return res.status(429).json({ error: 'Terlalu sering, tunggu sebentar.' })
    const s = await loadGame(u, req.body?.id)
    if (!s) return res.status(404).json({ error: 'Permainan tidak ditemukan.' })
    if (s.status !== 'active') return res.status(409).json({ error: 'Permainan sudah selesai.' })
    const you = s.whiteId === u._id ? 'w' : 'b'
    if (s.t !== you) return res.status(409).json({ error: 'Bukan giliranmu.' })
    const st = stOf(s)
    const r = await analyzePos(st, Math.floor(s.ply / 2) + 1, MP.hintDepth, Math.min(MP.sfDepth, 10))
    if (!r.best) return res.json({ ok: true, best: null }) // posisi sudah berakhir (mati/pat) — seharusnya tidak terjadi karena status masih aktif
    const mine = you === 'w' ? r.cpWhite : -r.cpWhite
    const mateIn = r.mateInWhite == null ? null : (you === 'w' ? r.mateInWhite : -r.mateInWhite)
    res.json({ ok: true, best: { san: sanOf(st, r.best), uci: uciOf(r.best), from: r.best.f, to: r.best.t, ...(r.best.pr ? { promo: r.best.pr } : {}), evalCp: Math.round(mine), ...(mateIn != null ? { mate: mateIn } : {}) }, engine: sfReady() ? `stockfish-d${Math.min(MP.sfDepth, 10)}` : `internal-d${MP.hintDepth}` })
  }))

  /* ---------- Review (analisis pasca-permainan) ---------- */
  router.post('/api/auth/mp/review', wrap(async (req, res) => {
    const u = await need(req, res); if (!u) return
    if (!(await allow('mprv:' + u._id, 3, 60))) return res.status(429).json({ error: 'Analisis terlalu sering diminta, tunggu sebentar.' })
    const games = await col('chess_games')
    let g = await loadGame(u, req.body?.id)
    if (!g) return res.status(404).json({ error: 'Permainan tidak ditemukan.' })
    if (g.status === 'aborted') return res.status(409).json({ error: 'Permainan yang dibatalkan tidak dianalisis.' })
    if (g.status !== 'done') return res.status(409).json({ error: 'Analisis hanya untuk permainan yang sudah selesai.' })
    if (g.review) return res.json({ ok: true, review: g.review })
    const review = await buildReview(g)
    // simpan sekali (dua permintaan bersamaan: yang menang tulis, yang kalah baca ulang)
    const ns = doc(await games.findOneAndUpdate({ _id: g._id, review: { $exists: false } }, { $set: { review } }, { returnDocument: 'after' }))
    const saved = ns ? ns.review : (await games.findOne({ _id: g._id }))?.review || review
    if (ns) await reviewStats(g, review)
    res.json({ ok: true, review: saved })
  }))

  /* ---------- Replay ---------- */
  router.post('/api/auth/mp/replay', wrap(async (req, res) => {
    const u = await need(req, res); if (!u) return
    if (!(await allow('mprp:' + u._id, 20, 60))) return res.status(429).json({ error: 'Terlalu sering, tunggu sebentar.' })
    const g = await loadGame(u, req.body?.id)
    if (!g) return res.status(404).json({ error: 'Permainan tidak ditemukan.' })
    const positions = positionsOf(g)
    const st0 = positions[0]
    const out = []
    let prev = st0
    for (let i = 0; i < (g.moves || []).length; i++) {
      const st = positions[i + 1]
      const mv = g.moves[i]
      out.push({
        ply: i + 1, color: i % 2 === 0 ? 'w' : 'b', san: mv.san, uci: mv.uci, from: mv.from, to: mv.to, ...(mv.promo ? { promo: mv.promo } : {}),
        board: st.b.join(''), fen: fenOf(st, Math.floor(i / 2) + 1),
        lastMove: { f: mv.from, t: mv.to },
        ...(inCheck(st.b, st.t === 'w') ? { check: kingSq(st.b, st.t === 'w') } : {}),
        ts: mv.ts
      })
      prev = st
    }
    res.json({
      ok: true,
      meta: {
        id: g._id, status: g.status, ply: g.ply,
        white: { name: g.whiteName, username: g.whiteUser }, black: { name: g.blackName, username: g.blackUser },
        ...(g.status === 'done' ? { result: { won: g.won, reason: g.reason, score: g.result }, pgn: g.pgn || pgnOf(g) } : {}),
        ...(g.status === 'aborted' ? { result: { won: null, reason: g.reason || 'abort', score: '*' } } : {}),
        reviewed: !!g.review, createdAt: g.createdAt, endedAt: g.endedAt
      },
      initial: { board: st0.b.join(''), fen: fenOf(st0, 1) },
      positions: out
    })
  }))

  /* ---------- Statistik pemain ---------- */
  router.post('/api/auth/mp/stats', wrap(async (req, res) => {
    const u = await need(req, res); if (!u) return
    if (!(await allow('mpst:' + u._id, 20, 60))) return res.status(429).json({ error: 'Terlalu sering, tunggu sebentar.' })
    let target = u
    const wantUser = String(req.body?.user || '').trim().toLowerCase()
    if (wantUser && wantUser !== u.username) {
      target = await (await col('users')).findOne({ username: wantUser.slice(0, 20) })
      if (!target) return res.status(404).json({ error: 'Pemain itu tidak ditemukan.' })
    }
    const s = await (await col('chess_stats')).findOne({ _id: target._id })
    const st = s || { played: 0, won: 0, drawn: 0, lost: 0, accSum: 0, accGames: 0, bestAcc: 0, labels: { best: 0, great: 0, excellent: 0, mistake: 0, miss: 0, blunder: 0 } }
    res.json({
      ok: true,
      user: { username: target.username, name: target.name },
      stats: {
        played: st.played || 0, won: st.won || 0, drawn: st.drawn || 0, lost: st.lost || 0,
        winRate: st.played ? Math.round((st.won || 0) / st.played * 1000) / 10 : null,
        accuracy: st.accGames ? Math.round((st.accSum || 0) / st.accGames * 10) / 10 : null,
        accGames: st.accGames || 0, bestAcc: st.bestAcc || 0,
        labels: st.labels || { best: 0, great: 0, excellent: 0, mistake: 0, miss: 0, blunder: 0 },
        updatedAt: st.updatedAt || null
      }
    })
  }))
}
