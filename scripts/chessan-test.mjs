/* Tes engine Live Move Analysis (public/chessan-engine.js) — tanpa browser, tanpa server, tanpa Stockfish.
   Jalankan: npm run an:test
   Isi: (1) perft (kebenaran generator langkah), (2) taktik dasar, (3) regresi klasifikasi rating, (4) determinisme. */
import '../public/chessan-engine.js'
const E = globalThis.CHENG
let fail = 0
const ok = (name, cond, extra = '') => { if (!cond) fail++; console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra !== '' ? '  ' + extra : '')) }

// 1) perft: 6 posisi standar (chessprogramming.org/Perft_Results)
const PERFT = [
  ['awal', 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', [20, 400, 8902, 197281]],
  ['kiwipete', 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1', [48, 2039, 97862]],
  ['posisi 3', '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1', [14, 191, 2812, 43238]],
  ['posisi 4', 'r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1', [6, 264, 9467]],
  ['posisi 5', 'rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8', [44, 1486, 62379]],
  ['posisi 6', 'r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 10', [46, 2079, 89890]]
]
for (const [n, fen, exp] of PERFT) {
  const p = E.fromFen(fen), h = p.hlo + ':' + p.hhi
  const got = exp.map((_, i) => E.perft(p, i + 1))
  ok('perft ' + n, got.every((g, i) => g === exp[i]), got.join('/'))
  ok('hash stabil setelah perft ' + n, p.hlo + ':' + p.hhi === h)
}

// 2) taktik
const best = (fen, opts) => { const p = E.fromFen(fen), r = E.search(p, opts); return { uci: E.uci(r.best), r } }
ok('mat dalam 1', best('6k1/5ppp/8/8/8/8/8/R3K3 w Q - 0 1').uci === 'a1a8')
ok('mat dalam 2 (tangga)', best('7k/8/8/8/8/8/1R6/R3K3 w - - 0 1').uci === 'b2b7')
ok('ambil ratu yang menggantung', best('rnb1kbnr/pppp1ppp/8/4p3/4P2q/5N2/PPPP1PPP/RNBQKB1R w KQkq - 0 1').uci === 'f3h4')

// 3) regresi rating: utilitas SAN sederhana lewat legalMoves
const files = 'abcdefgh'
const sanOf = (pos, m) => {
  const bd = pos.bd, f = m & 63, t = (m >> 6) & 63, pr = (m >> 12) & 7, fl = m >> 16, pc = '.PNBRQK'[bd[f] & 7]
  if (fl & 4) return t > f ? 'O-O' : 'O-O-O'
  const cap = (fl & 1) ? 'x' : '', tn = E.sqName(t)
  if (pc === 'P') return (cap ? files[f & 7] + 'x' : '') + tn + (pr ? '=' + '  NBRQ'[pr] : '')
  const oth = E.legalMoves(pos).filter(o => o !== m && ((o >> 6) & 63) === t && '.PNBRQK'[bd[o & 63] & 7] === pc)
  let dis = ''
  if (oth.length) dis = !oth.some(o => (o & 7) === (f & 7)) ? files[f & 7] : !oth.some(o => (o >> 3) === (f >> 3)) ? String(8 - (f >> 3)) : E.sqName(f)
  return pc + dis + cap + tn
}
function rateGame(sans) {
  const pos = E.newPos(), memo = { full: {} }, out = []
  for (const s of sans.split(/\s+/)) {
    const m = E.legalMoves(pos).find(x => sanOf(pos, x) === s.replace(/[+#]/g, ''))
    if (m == null) throw new Error('SAN tidak cocok: ' + s)
    out.push(E.rateMove(pos, m, memo)); E.make(pos, m)
  }
  return out
}
const fm = rateGame('f3 e5 g4 Qh4#')
ok("Fool's mate: 2.g4 = blunder", fm[2].k === 'blunder', fm[2].k)
ok("Fool's mate: Qh4# = best", fm[3].k === 'best')
const op = rateGame('e4 e5 Nf3 d6 d4 Bg4 dxe5 Bxf3 Qxf3 dxe5 Bc4 Nf6 Qb3 Qe7 Nc3 c6 Bg5 b5 Nxb5 cxb5 Bxb5+ Nbd7 O-O-O Rd8 Rxd7 Rxd7 Rd1 Qe6 Bxd7+ Nxd7 Qb8+ Nxb8 Rd8#')
ok('Opera Game: 16.Qb8+ (pengorbanan ratu menuju mat) = brilliant', op[30].k === 'brilliant', op[30].k + ' sac=' + op[30].s)
ok('Opera Game: Brilliant langka (<= 1 dari 33 langkah)', op.filter(r => r.k === 'brilliant').length <= 1)
ok('Opera Game: 17.Rd8# = best', op[32].k === 'best')
const lg = rateGame('e4 e5 Nf3 d6 Bc4 Bg4 Nc3 g6 Nxe5 Bxd1 Bxf7+ Ke7 Nd5#')
ok("Légal: 5...Bxd1 = blunder", lg[9].k === 'blunder', lg[9].k)
ok('Hanya tujuh label yang valid', [...fm, ...op, ...lg].every(r => ['brilliant', 'best', 'excellent', 'good', 'inaccuracy', 'mistake', 'blunder'].includes(r.k)))

// 4) determinisme: memo baru / urutan berbeda -> hasil identik (dua perangkat harus sepakat)
const again = rateGame('e4 e5 Nf3 d6 Bc4 Bg4 Nc3 g6 Nxe5 Bxd1 Bxf7+ Ke7 Nd5#')
ok('determinis: dua kali jalan = hasil sama', JSON.stringify(again) === JSON.stringify(lg))
{
  // menilai satu langkah langsung (tanpa memo hangat dari langkah sebelumnya) harus sama dengan menilai berurutan
  const pos = E.newPos(); const sans = 'e4 e5 Nf3 d6 Bc4 Bg4 Nc3 g6'.split(' ')
  for (const s of sans) E.make(pos, E.legalMoves(pos).find(x => sanOf(pos, x) === s))
  const m = E.legalMoves(pos).find(x => sanOf(pos, x) === 'Nxe5')
  const solo = E.rateMove(pos, m, { full: {} })
  ok('determinis: langkah dinilai sendirian = saat dinilai berurutan', JSON.stringify(solo) === JSON.stringify(lg[8]))
}
console.log(fail ? '\nGAGAL: ' + fail : '\nSEMUA LULUS')
process.exit(fail ? 1 : 0)
