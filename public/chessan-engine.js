/* ===== Live Move Analysis — engine catur mandiri (tanpa Stockfish, tanpa dependency) =====
   Dipakai dua tempat dengan file yang SAMA: Web Worker (public/chessan-worker.js) untuk menilai langkah,
   dan thread utama (public/chessan.js) hanya untuk menerapkan langkah -> papan (riwayat). Murni analisis/tampilan:
   kebenaran aturan catur tetap 100% di server (lib/chess.js, lib/chessmp.js); engine ini TIDAK dipakai untuk
   memvalidasi langkah pemain.

   Representasi papan = sama dengan aplikasi: 64 kotak, indeks 0 = a8 ... 63 = h1 (indeks = (8 - rank) * 8 + file).
   Bidak: putih 1..6 (P N B R Q K), hitam 9..14 (8 | tipe). Langkah = int: dari | ke<<6 | promosi<<12 | flag<<16
   (flag: 1 tangkapan, 2 en passant, 4 rokade, 8 langkah dua kotak).

   Hasil sengaja DETERMINISTIK (batas simpul, bukan waktu; tabel hash dikosongkan tiap pencarian), jadi dua perangkat
   yang menilai permainan yang sama mendapat rating yang sama persis.

   API: CHENG = { VER, newPos, fromFen, applyMove, findMove, legalMoves, boardStr, uci, perft, search, rateMove, winPct } */
(function (G) {
'use strict';
const VER = 1;                       // naikkan bila perilaku penilaian berubah (cache rating lama otomatis dibuang)
const MATE = 100000, INF = 1000000, MATE_BAND = MATE - 1000;
const PCH = ['.', 'P', 'N', 'B', 'R', 'Q', 'K', '', '', 'p', 'n', 'b', 'r', 'q', 'k'];
const CHP = {}; for (let i = 1; i < 15; i++) if (PCH[i]) CHP[PCH[i]] = i;
const FILES = 'abcdefgh';
const sqName = i => FILES[i & 7] + (8 - (i >> 3));

/* ---------- tabel statis ---------- */
const KN = [], KG = [], RAY = [], PAW = [[], []];
const DIRS = [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [-1, 1], [1, -1], [1, 1]]; // 0-3 benteng, 4-7 gajah
(function () {
  const inb = (r, c) => r >= 0 && r < 8 && c >= 0 && c < 8;
  for (let sq = 0; sq < 64; sq++) {
    const r = sq >> 3, c = sq & 7;
    KN[sq] = []; KG[sq] = []; RAY[sq] = []; PAW[0][sq] = []; PAW[1][sq] = [];
    for (const [dr, dc] of [[-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1]]) if (inb(r + dr, c + dc)) KN[sq].push((r + dr) * 8 + c + dc);
    for (const [dr, dc] of DIRS) if (inb(r + dr, c + dc)) KG[sq].push((r + dr) * 8 + c + dc);
    for (const [dr, dc] of DIRS) { const a = []; let rr = r + dr, cc = c + dc; while (inb(rr, cc)) { a.push(rr * 8 + cc); rr += dr; cc += dc; } RAY[sq].push(a); }
    for (const dc of [-1, 1]) {
      if (inb(r - 1, c + dc)) PAW[0][sq].push((r - 1) * 8 + c + dc); // kotak yang diserang pion putih di sq
      if (inb(r + 1, c + dc)) PAW[1][sq].push((r + 1) * 8 + c + dc); // ... pion hitam
    }
  }
})();
const CRM = new Int8Array(64).fill(15);
CRM[60] = 15 & ~3; CRM[63] = 15 & ~1; CRM[56] = 15 & ~2; CRM[4] = 15 & ~12; CRM[7] = 15 & ~4; CRM[0] = 15 & ~8;

/* zobrist (PRNG xorshift32 tetap -> hash identik di semua perangkat) */
let seed = 0x9e3779b9;
const rnd = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed | 0; };
const ZLO = new Int32Array(16 * 64), ZHI = new Int32Array(16 * 64), ZCRL = new Int32Array(16), ZCRH = new Int32Array(16), ZEPL = new Int32Array(8), ZEPH = new Int32Array(8);
for (let i = 0; i < 16 * 64; i++) { ZLO[i] = rnd(); ZHI[i] = rnd(); }
for (let i = 0; i < 16; i++) { ZCRL[i] = rnd(); ZCRH[i] = rnd(); }
for (let i = 0; i < 8; i++) { ZEPL[i] = rnd(); ZEPH[i] = rnd(); }
const ZSL = rnd(), ZSH = rnd();

/* ---------- posisi ---------- */
const STK = 2048;
function Pos() {
  this.bd = new Int8Array(64); this.stm = 0; this.cr = 0; this.ep = -1; this.half = 0; this.ks = [-1, -1];
  this.hlo = 0; this.hhi = 0; this.n = 0;
  this.uMove = new Int32Array(STK); this.uCap = new Int8Array(STK); this.uCr = new Int8Array(STK); this.uEp = new Int8Array(STK);
  this.uHalf = new Int16Array(STK); this.uLo = new Int32Array(STK); this.uHi = new Int32Array(STK);
}
function rehash(pos) {
  let lo = 0, hi = 0;
  for (let i = 0; i < 64; i++) { const p = pos.bd[i]; if (p) { lo ^= ZLO[p * 64 + i]; hi ^= ZHI[p * 64 + i]; } }
  lo ^= ZCRL[pos.cr]; hi ^= ZCRH[pos.cr];
  if (pos.ep >= 0) { lo ^= ZEPL[pos.ep & 7]; hi ^= ZEPH[pos.ep & 7]; }
  if (pos.stm) { lo ^= ZSL; hi ^= ZSH; }
  pos.hlo = lo; pos.hhi = hi;
}
const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
function fromFen(fen) {
  const pos = new Pos(), parts = String(fen || START_FEN).trim().split(/\s+/);
  let sq = 0;
  for (const ch of parts[0]) {
    if (ch === '/') continue;
    if (ch >= '1' && ch <= '8') { sq += +ch; continue; }
    const p = CHP[ch]; if (!p) return null;
    pos.bd[sq] = p; if ((p & 7) === 6) pos.ks[p >> 3] = sq; sq++;
  }
  if (sq !== 64) return null;
  pos.stm = parts[1] === 'b' ? 1 : 0;
  const c = parts[2] || '-'; pos.cr = (c.includes('K') ? 1 : 0) | (c.includes('Q') ? 2 : 0) | (c.includes('k') ? 4 : 0) | (c.includes('q') ? 8 : 0);
  const ep = parts[3] || '-'; pos.ep = ep !== '-' && ep.length === 2 ? (8 - +ep[1]) * 8 + (ep.charCodeAt(0) - 97) : -1;
  pos.half = +parts[4] || 0;
  if (pos.ks[0] < 0 || pos.ks[1] < 0) return null;
  rehash(pos);
  return pos;
}
const newPos = () => fromFen(START_FEN);
const boardStr = pos => { let s = ''; for (let i = 0; i < 64; i++) s += PCH[pos.bd[i]] || '.'; return s; };

function attacked(bd, sq, by) {
  const off = by << 3;
  let t = PAW[by ^ 1][sq];
  for (let i = 0; i < t.length; i++) if (bd[t[i]] === (1 | off)) return true;
  t = KN[sq]; for (let i = 0; i < t.length; i++) if (bd[t[i]] === (2 | off)) return true;
  t = KG[sq]; for (let i = 0; i < t.length; i++) if (bd[t[i]] === (6 | off)) return true;
  const rays = RAY[sq];
  for (let d = 0; d < 8; d++) {
    const ray = rays[d], a = d < 4 ? 4 | off : 3 | off, q = 5 | off;
    for (let i = 0; i < ray.length; i++) { const p = bd[ray[i]]; if (p) { if (p === a || p === q) return true; break; } }
  }
  return false;
}

function make(pos, m) {
  const bd = pos.bd, from = m & 63, to = (m >> 6) & 63, pr = (m >> 12) & 7, fl = m >> 16, us = pos.stm, piece = bd[from], n = pos.n++;
  pos.uMove[n] = m; pos.uCr[n] = pos.cr; pos.uEp[n] = pos.ep; pos.uHalf[n] = pos.half; pos.uLo[n] = pos.hlo; pos.uHi[n] = pos.hhi;
  let lo = pos.hlo ^ ZLO[piece * 64 + from], hi = pos.hhi ^ ZHI[piece * 64 + from], cap = 0;
  if (fl & 2) { const cs = to + (us ? -8 : 8); cap = bd[cs]; bd[cs] = 0; lo ^= ZLO[cap * 64 + cs]; hi ^= ZHI[cap * 64 + cs]; }
  else if (bd[to]) { cap = bd[to]; lo ^= ZLO[cap * 64 + to]; hi ^= ZHI[cap * 64 + to]; }
  pos.uCap[n] = cap;
  bd[from] = 0;
  const placed = pr ? (pr | (us << 3)) : piece;
  bd[to] = placed; lo ^= ZLO[placed * 64 + to]; hi ^= ZHI[placed * 64 + to];
  if (fl & 4) {
    const rf = to > from ? from + 3 : from - 4, rt = to > from ? from + 1 : from - 1, rk = bd[rf];
    bd[rf] = 0; bd[rt] = rk;
    lo ^= ZLO[rk * 64 + rf] ^ ZLO[rk * 64 + rt]; hi ^= ZHI[rk * 64 + rf] ^ ZHI[rk * 64 + rt];
  }
  if (pos.ep >= 0) { lo ^= ZEPL[pos.ep & 7]; hi ^= ZEPH[pos.ep & 7]; }
  pos.ep = (fl & 8) ? (from + to) >> 1 : -1;
  if (pos.ep >= 0) { lo ^= ZEPL[pos.ep & 7]; hi ^= ZEPH[pos.ep & 7]; }
  const ncr = pos.cr & CRM[from] & CRM[to];
  if (ncr !== pos.cr) { lo ^= ZCRL[pos.cr] ^ ZCRL[ncr]; hi ^= ZCRH[pos.cr] ^ ZCRH[ncr]; pos.cr = ncr; }
  if ((piece & 7) === 6) pos.ks[us] = to;
  pos.half = ((piece & 7) === 1 || cap) ? 0 : pos.half + 1;
  pos.stm ^= 1; lo ^= ZSL; hi ^= ZSH;
  pos.hlo = lo; pos.hhi = hi;
}
function unmake(pos) {
  const n = --pos.n, m = pos.uMove[n], bd = pos.bd, from = m & 63, to = (m >> 6) & 63, pr = (m >> 12) & 7, fl = m >> 16;
  pos.stm ^= 1;
  const us = pos.stm, piece = pr ? (1 | (us << 3)) : bd[to], cap = pos.uCap[n];
  bd[from] = piece; bd[to] = 0;
  if (fl & 2) bd[to + (us ? -8 : 8)] = cap; else if (cap) bd[to] = cap;
  if (fl & 4) {
    const rf = to > from ? from + 3 : from - 4, rt = to > from ? from + 1 : from - 1;
    bd[rf] = bd[rt]; bd[rt] = 0;
  }
  pos.cr = pos.uCr[n]; pos.ep = pos.uEp[n]; pos.half = pos.uHalf[n]; pos.hlo = pos.uLo[n]; pos.hhi = pos.uHi[n];
  if ((piece & 7) === 6) pos.ks[us] = from;
}
function makeNull(pos) {
  const n = pos.n++;
  pos.uMove[n] = 0; pos.uCr[n] = pos.cr; pos.uEp[n] = pos.ep; pos.uHalf[n] = pos.half; pos.uLo[n] = pos.hlo; pos.uHi[n] = pos.hhi;
  if (pos.ep >= 0) { pos.hlo ^= ZEPL[pos.ep & 7]; pos.hhi ^= ZEPH[pos.ep & 7]; pos.ep = -1; }
  pos.stm ^= 1; pos.hlo ^= ZSL; pos.hhi ^= ZSH; pos.half++;
}
function unmakeNull(pos) {
  const n = --pos.n;
  pos.stm ^= 1; pos.cr = pos.uCr[n]; pos.ep = pos.uEp[n]; pos.half = pos.uHalf[n]; pos.hlo = pos.uLo[n]; pos.hhi = pos.uHi[n];
}

/* ---------- pembangkit langkah ---------- */
function gen(pos, out, capsOnly) {
  out.length = 0;
  const bd = pos.bd, us = pos.stm;
  for (let sq = 0; sq < 64; sq++) {
    const p = bd[sq];
    if (!p || (p >> 3) !== us) continue;
    const t = p & 7;
    if (t === 1) {
      const r = sq >> 3, fwd = sq + (us ? 8 : -8), promoRow = us ? 7 : 0, startRow = us ? 1 : 6;
      if (!bd[fwd]) {
        if ((fwd >> 3) === promoRow) { for (let pr = 5; pr >= 2; pr--) out.push(sq | fwd << 6 | pr << 12); }
        else if (!capsOnly) {
          out.push(sq | fwd << 6);
          const f2 = fwd + (us ? 8 : -8);
          if (r === startRow && !bd[f2]) out.push(sq | f2 << 6 | 8 << 16);
        }
      }
      const at = PAW[us][sq];
      for (let i = 0; i < at.length; i++) {
        const s = at[i], q = bd[s];
        if (q) { if ((q >> 3) !== us) { if ((s >> 3) === promoRow) { for (let pr = 5; pr >= 2; pr--) out.push(sq | s << 6 | pr << 12 | 1 << 16); } else out.push(sq | s << 6 | 1 << 16); } }
        else if (s === pos.ep) out.push(sq | s << 6 | 3 << 16);
      }
    } else if (t === 2 || t === 6) {
      const tb = t === 2 ? KN[sq] : KG[sq];
      for (let i = 0; i < tb.length; i++) { const s = tb[i], q = bd[s]; if (!q) { if (!capsOnly) out.push(sq | s << 6); } else if ((q >> 3) !== us) out.push(sq | s << 6 | 1 << 16); }
      if (t === 6 && !capsOnly && pos.cr) {
        if (us === 0 && sq === 60 && !attacked(bd, 60, 1)) {
          if ((pos.cr & 1) && !bd[61] && !bd[62] && bd[63] === 4 && !attacked(bd, 61, 1) && !attacked(bd, 62, 1)) out.push(60 | 62 << 6 | 4 << 16);
          if ((pos.cr & 2) && !bd[59] && !bd[58] && !bd[57] && bd[56] === 4 && !attacked(bd, 59, 1) && !attacked(bd, 58, 1)) out.push(60 | 58 << 6 | 4 << 16);
        } else if (us === 1 && sq === 4 && !attacked(bd, 4, 0)) {
          if ((pos.cr & 4) && !bd[5] && !bd[6] && bd[7] === 12 && !attacked(bd, 5, 0) && !attacked(bd, 6, 0)) out.push(4 | 6 << 6 | 4 << 16);
          if ((pos.cr & 8) && !bd[3] && !bd[2] && !bd[1] && bd[0] === 12 && !attacked(bd, 3, 0) && !attacked(bd, 2, 0)) out.push(4 | 2 << 6 | 4 << 16);
        }
      }
    } else {
      const d0 = t === 3 ? 4 : 0, d1 = t === 4 ? 4 : 8, rays = RAY[sq];
      for (let d = d0; d < d1; d++) {
        const ray = rays[d];
        for (let i = 0; i < ray.length; i++) {
          const s = ray[i], q = bd[s];
          if (!q) { if (!capsOnly) out.push(sq | s << 6); }
          else { if ((q >> 3) !== us) out.push(sq | s << 6 | 1 << 16); break; }
        }
      }
    }
  }
  return out;
}
function legalMoves(pos) {
  const ps = gen(pos, [], false), out = [], us = pos.stm;
  for (const m of ps) { make(pos, m); if (!attacked(pos.bd, pos.ks[us], us ^ 1)) out.push(m); unmake(pos); }
  return out;
}
const uci = m => sqName(m & 63) + sqName((m >> 6) & 63) + (((m >> 12) & 7) ? 'nbrq'[((m >> 12) & 7) - 2] : '');
/* cari langkah sah dari kotak asal/tujuan (+ promosi 'Q'/'R'/'B'/'N', default Q). null kalau tidak sah */
function findMove(pos, f, t, pr) {
  const want = pr ? ({ N: 2, B: 3, R: 4, Q: 5 })[String(pr).toUpperCase()] : 5;
  for (const m of legalMoves(pos)) {
    if ((m & 63) === f && ((m >> 6) & 63) === t) { const mp = (m >> 12) & 7; if (!mp || mp === want) return m; }
  }
  return null;
}
function applyMove(pos, f, t, pr) { const m = findMove(pos, f, t, pr); if (m == null) return null; make(pos, m); return m; }
function perft(pos, d) {
  if (d === 0) return 1;
  let n = 0; const us = pos.stm;
  for (const m of gen(pos, [], false)) { make(pos, m); if (!attacked(pos.bd, pos.ks[us], us ^ 1)) n += perft(pos, d - 1); unmake(pos); }
  return n;
}

/* ---------- evaluasi (dari sudut pihak yang giliran) ---------- */
const MGV = [0, 100, 320, 330, 500, 900, 0], EGV = [0, 115, 300, 320, 520, 930, 0], MATV = [0, 1, 3, 3, 5, 9, 0];
const PST = {
  1: [0, 0, 0, 0, 0, 0, 0, 0, 50, 50, 50, 50, 50, 50, 50, 50, 10, 10, 20, 30, 30, 20, 10, 10, 5, 5, 10, 25, 25, 10, 5, 5, 0, 0, 0, 20, 20, 0, 0, 0, 5, -5, -10, 0, 0, -10, -5, 5, 5, 10, 10, -20, -20, 10, 10, 5, 0, 0, 0, 0, 0, 0, 0, 0],
  2: [-50, -40, -30, -30, -30, -30, -40, -50, -40, -20, 0, 0, 0, 0, -20, -40, -30, 0, 10, 15, 15, 10, 0, -30, -30, 5, 15, 20, 20, 15, 5, -30, -30, 0, 15, 20, 20, 15, 0, -30, -30, 5, 10, 15, 15, 10, 5, -30, -40, -20, 0, 5, 5, 0, -20, -40, -50, -40, -30, -30, -30, -30, -40, -50],
  3: [-20, -10, -10, -10, -10, -10, -10, -20, -10, 0, 0, 0, 0, 0, 0, -10, -10, 0, 5, 10, 10, 5, 0, -10, -10, 5, 5, 10, 10, 5, 5, -10, -10, 0, 10, 10, 10, 10, 0, -10, -10, 10, 10, 10, 10, 10, 10, -10, -10, 5, 0, 0, 0, 0, 5, -10, -20, -10, -10, -10, -10, -10, -10, -20],
  4: [0, 0, 0, 0, 0, 0, 0, 0, 5, 10, 10, 10, 10, 10, 10, 5, -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5, 0, 0, 0, 5, 5, 0, 0, 0],
  5: [-20, -10, -10, -5, -5, -10, -10, -20, -10, 0, 0, 0, 0, 0, 0, -10, -10, 0, 5, 5, 5, 5, 0, -10, -5, 0, 5, 5, 5, 5, 0, -5, 0, 0, 5, 5, 5, 5, 0, -5, -10, 5, 5, 5, 5, 5, 0, -10, -10, 0, 5, 0, 0, 0, 0, -10, -20, -10, -10, -5, -5, -10, -10, -20],
  6: [-30, -40, -40, -50, -50, -40, -40, -30, -30, -40, -40, -50, -50, -40, -40, -30, -30, -40, -40, -50, -50, -40, -40, -30, -30, -40, -40, -50, -50, -40, -40, -30, -20, -30, -30, -40, -40, -30, -30, -20, -10, -20, -20, -20, -20, -20, -20, -10, 20, 20, 0, 0, 0, 0, 20, 20, 20, 30, 10, 0, 0, 10, 30, 20]
};
const KING_EG = [-50, -40, -30, -20, -20, -30, -40, -50, -30, -20, -10, 0, 0, -10, -20, -30, -30, -10, 20, 30, 30, 20, -10, -30, -30, -10, 30, 40, 40, 30, -10, -30, -30, -10, 30, 40, 40, 30, -10, -30, -30, -10, 20, 30, 30, 20, -10, -30, -30, -30, 0, 0, 0, 0, -30, -30, -50, -30, -30, -30, -30, -30, -30, -50];
const PMG = [], PEG = []; // [piece][sq] sudah termasuk nilai bidak; hitam dicerminkan
for (let p = 0; p < 16; p++) { PMG.push(new Int16Array(64)); PEG.push(new Int16Array(64)); }
for (let t = 1; t <= 6; t++) for (let sq = 0; sq < 64; sq++) {
  const wi = sq, bi = (7 - (sq >> 3)) * 8 + (sq & 7);
  PMG[t][sq] = MGV[t] + PST[t][wi]; PEG[t][sq] = EGV[t] + (t === 6 ? KING_EG[wi] : PST[t][wi]);
  PMG[8 | t][sq] = MGV[t] + PST[t][bi]; PEG[8 | t][sq] = EGV[t] + (t === 6 ? KING_EG[bi] : PST[t][bi]);
}
const PASS = [0, 5, 10, 20, 40, 70, 120, 0];
const fileOf = s => s & 7, rowOf = s => s >> 3;

function evaluate(pos) {
  const bd = pos.bd;
  let mg = 0, eg = 0, phase = 0;
  const pcnt = [new Int8Array(8), new Int8Array(8)], pmin = [new Int8Array(8).fill(9), new Int8Array(8).fill(9)], pmax = [new Int8Array(8).fill(-1), new Int8Array(8).fill(-1)];
  const bish = [0, 0], minors = [0, 0], majors = [0, 0], pawns = [0, 0], mat = [0, 0];
  const rooks = [[], []];
  for (let sq = 0; sq < 64; sq++) {
    const p = bd[sq]; if (!p) continue;
    const c = p >> 3, t = p & 7, s = c ? -1 : 1, f = sq & 7, r = sq >> 3;
    mg += s * PMG[p][sq]; eg += s * PEG[p][sq];
    mat[c] += MATV[t];
    if (t === 1) { pcnt[c][f]++; pawns[c]++; if (r < pmin[c][f]) pmin[c][f] = r; if (r > pmax[c][f]) pmax[c][f] = r; }
    else if (t === 2) { phase += 1; minors[c]++; const tb = KN[sq]; let cnt = 0; for (let i = 0; i < tb.length; i++) { const q = bd[tb[i]]; if (!q || (q >> 3) !== c) cnt++; } mg += s * (cnt - 4) * 4; eg += s * (cnt - 4) * 4; }
    else if (t === 3) {
      phase += 1; minors[c]++; bish[c]++; let cnt = 0; const rays = RAY[sq];
      for (let d = 4; d < 8; d++) { const ray = rays[d]; for (let i = 0; i < ray.length; i++) { const q = bd[ray[i]]; if (!q) cnt++; else { if ((q >> 3) !== c) cnt++; break; } } }
      mg += s * (cnt - 6) * 4; eg += s * (cnt - 6) * 4;
    } else if (t === 4) {
      phase += 2; majors[c]++; rooks[c].push(sq); let cnt = 0; const rays = RAY[sq];
      for (let d = 0; d < 4; d++) { const ray = rays[d]; for (let i = 0; i < ray.length; i++) { const q = bd[ray[i]]; if (!q) cnt++; else { if ((q >> 3) !== c) cnt++; break; } } }
      mg += s * (cnt - 7) * 2; eg += s * (cnt - 7) * 4;
    } else if (t === 5) {
      phase += 4; majors[c]++; let cnt = 0; const rays = RAY[sq];
      for (let d = 0; d < 8; d++) { const ray = rays[d]; for (let i = 0; i < ray.length; i++) { const q = bd[ray[i]]; if (!q) cnt++; else { if ((q >> 3) !== c) cnt++; break; } } }
      mg += s * (cnt - 13); eg += s * (cnt - 13) * 2;
    }
  }
  // bidak mustahil menang: K v K, K+minor v K
  if (!pawns[0] && !pawns[1] && !majors[0] && !majors[1] && minors[0] + minors[1] <= 1) return 0;
  if (bish[0] >= 2) { mg += 30; eg += 45; }
  if (bish[1] >= 2) { mg -= 30; eg -= 45; }
  // struktur pion
  for (let c = 0; c < 2; c++) {
    const s = c ? -1 : 1, en = c ^ 1;
    for (let f = 0; f < 8; f++) {
      const n = pcnt[c][f]; if (!n) continue;
      if (n > 1) { mg -= s * 10 * (n - 1); eg -= s * 15 * (n - 1); }
      const iso = (f === 0 || !pcnt[c][f - 1]) && (f === 7 || !pcnt[c][f + 1]);
      if (iso) { mg -= s * 12; eg -= s * 16; }
      // pion paling maju di file ini: cek lolos (tidak ada pion lawan di depan pada file f-1..f+1)
      const r = c ? pmax[c][f] : pmin[c][f];
      let passed = true;
      for (let g = f - 1; g <= f + 1 && passed; g++) {
        if (g < 0 || g > 7 || !pcnt[en][g]) continue;
        if (c === 0 ? pmin[en][g] < r : pmax[en][g] > r) passed = false;
      }
      if (passed) { const rel = c ? r : 7 - r; mg += s * PASS[rel]; eg += s * Math.round(PASS[rel] * 1.7); }
    }
    for (const sq of rooks[c]) {
      const f = sq & 7;
      if (!pcnt[c][f]) { if (!pcnt[en][f]) { mg += s * 20; eg += s * 20; } else { mg += s * 10; eg += s * 10; } }
    }
  }
  for (let c = 0; c < 2; c++) {
    const k = c === 0 ? kingOf(bd, 6) : kingOf(bd, 14), kr = k >> 3, kc = k & 7, s = c ? -1 : 1, dir = c ? 1 : -1, home = c ? kr <= 1 : kr >= 6;
    if (!home) { mg -= s * 25; continue; }
    let sh = 0;
    for (let g = kc - 1; g <= kc + 1; g++) {
      if (g < 0 || g > 7) continue;
      const r1 = kr + dir, r2 = kr + 2 * dir, own = 1 | (c << 3);
      if (r1 >= 0 && r1 < 8 && bd[r1 * 8 + g] === own) sh += 10;
      else if (r2 >= 0 && r2 < 8 && bd[r2 * 8 + g] === own) sh += 5;
      else sh -= 8;
    }
    mg += s * sh * (mat[c ^ 1] >= 9 ? 1 : 0.4) | 0;
  }
  // mop-up: pihak unggul besar tanpa lawan punya pion -> dorong raja lawan ke tepi dan dekatkan raja sendiri
  const md = mat[0] - mat[1];
  if (Math.abs(md) >= 4 && (md > 0 ? !pawns[1] : !pawns[0])) {
    const w = md > 0 ? 0 : 1, l = w ^ 1, ws = kingOf(bd, w ? 14 : 6), ls = kingOf(bd, l ? 14 : 6);
    const cd = Math.max(3 - (ls >> 3), (ls >> 3) - 4) + Math.max(3 - (ls & 7), (ls & 7) - 4);
    const dist = Math.abs((ws >> 3) - (ls >> 3)) + Math.abs((ws & 7) - (ls & 7));
    eg += (w ? -1 : 1) * (cd * 10 + (14 - dist) * 4);
  }
  const ph = phase > 24 ? 24 : phase;
  let sc = ((mg * ph + eg * (24 - ph)) / 24) | 0;
  sc += pos.stm ? -10 : 10;
  return pos.stm ? -sc : sc;
}
function kingOf(bd, king) { for (let i = 0; i < 64; i++) if (bd[i] === king) return i; return 0; }
/* evaluasi material murni (untuk deteksi pengorbanan): selisih nilai bidak dari sudut pihak yang giliran */
function matEval(pos) {
  let s = 0; const bd = pos.bd;
  for (let i = 0; i < 64; i++) { const p = bd[i]; if (p) s += ((p >> 3) ? -1 : 1) * MATV[p & 7] * 100; }
  return pos.stm ? -s : s;
}

/* ---------- SEE ---------- */
const SV = [0, 100, 320, 330, 500, 900, 20000];
function leastAttacker(b, to, side) {
  const off = side << 3;
  let t = PAW[side ^ 1][to]; for (let i = 0; i < t.length; i++) if (b[t[i]] === (1 | off)) return t[i];
  t = KN[to]; for (let i = 0; i < t.length; i++) if (b[t[i]] === (2 | off)) return t[i];
  const rays = RAY[to];
  for (let d = 4; d < 8; d++) { const ray = rays[d]; for (let i = 0; i < ray.length; i++) { const p = b[ray[i]]; if (p) { if (p === (3 | off)) return ray[i]; break; } } }
  for (let d = 0; d < 4; d++) { const ray = rays[d]; for (let i = 0; i < ray.length; i++) { const p = b[ray[i]]; if (p) { if (p === (4 | off)) return ray[i]; break; } } }
  for (let d = 0; d < 8; d++) { const ray = rays[d]; for (let i = 0; i < ray.length; i++) { const p = b[ray[i]]; if (p) { if (p === (5 | off)) return ray[i]; break; } } }
  t = KG[to]; for (let i = 0; i < t.length; i++) if (b[t[i]] === (6 | off)) return t[i];
  return -1;
}
function see(pos, m) {
  const from = m & 63, to = (m >> 6) & 63, fl = m >> 16, b = pos.bd.slice(), us = pos.stm;
  const gain = [fl & 2 ? SV[1] : SV[b[to] & 7]];
  let cur = SV[b[from] & 7]; b[to] = b[from]; b[from] = 0;
  if (fl & 2) b[to + (us ? -8 : 8)] = 0;
  let side = us ^ 1, d = 0;
  for (;;) {
    const a = leastAttacker(b, to, side); if (a < 0) break;
    d++; gain[d] = cur - gain[d - 1]; cur = SV[b[a] & 7]; b[a] = 0; side ^= 1;
    if (d > 30) break;
  }
  while (--d > 0) gain[d - 1] = -Math.max(-gain[d - 1], gain[d]);
  return gain[0];
}

/* ---------- pencarian ---------- */
const TT_BITS = 17, TT_SIZE = 1 << TT_BITS, TT_MASK = TT_SIZE - 1;
const ttHi = new Int32Array(TT_SIZE), ttMv = new Int32Array(TT_SIZE), ttSc = new Int32Array(TT_SIZE), ttDp = new Int8Array(TT_SIZE), ttFl = new Uint8Array(TT_SIZE);
const killers = new Int32Array(66 * 2), history = new Int32Array(2 * 4096);
const MVL = [], SCL = []; for (let i = 0; i < 70; i++) { MVL.push([]); SCL.push([]); }
const S = { nodes: 0, limit: 0, stopped: false, rootDepth: 0, mat: false };

function hasNonPawn(pos, us) { const bd = pos.bd; for (let i = 0; i < 64; i++) { const p = bd[i]; if (p && (p >> 3) === us) { const t = p & 7; if (t >= 2 && t <= 5) return true; } } return false; }
function scoreMoves(pos, mv, sc, ttMove, ply) {
  const bd = pos.bd, us = pos.stm, k0 = killers[ply * 2], k1 = killers[ply * 2 + 1];
  for (let i = 0; i < mv.length; i++) {
    const m = mv[i], fl = m >> 16, from = m & 63, to = (m >> 6) & 63, pr = (m >> 12) & 7;
    let s;
    if (m === ttMove) s = 2000000;
    else if (fl & 1) { const victim = (fl & 2) ? 1 : (bd[to] & 7), att = bd[from] & 7; s = 1000000 + victim * 16 - att + (pr ? pr * 4 : 0); }
    else if (pr) s = 950000 + pr;
    else if (m === k0) s = 900000;
    else if (m === k1) s = 890000;
    else s = history[us * 4096 + from * 64 + to];
    sc[i] = s;
  }
}
function pickNext(mv, sc, i) {
  let bi = i, bs = sc[i];
  for (let j = i + 1; j < mv.length; j++) if (sc[j] > bs) { bs = sc[j]; bi = j; }
  if (bi !== i) { const tm = mv[i]; mv[i] = mv[bi]; mv[bi] = tm; const ts = sc[i]; sc[i] = sc[bi]; sc[bi] = ts; }
  return mv[i];
}
const evalFn = pos => S.mat ? matEval(pos) : evaluate(pos);

function qsearch(pos, alpha, beta, ply, qd) {
  S.nodes++;
  if (S.nodes > S.limit && S.rootDepth > 1) { S.stopped = true; return 0; }
  const us = pos.stm, inChk = attacked(pos.bd, pos.ks[us], us ^ 1);
  let best, stand = 0;
  if (ply >= 64) return evalFn(pos);
  const evasions = inChk && qd < 3;
  if (!evasions) {
    stand = evalFn(pos);
    if (stand >= beta) return stand;
    if (stand > alpha) alpha = stand;
    best = stand;
  } else best = -INF;
  const mv = MVL[ply], sc = SCL[ply];
  gen(pos, mv, !evasions);
  scoreMoves(pos, mv, sc, 0, ply);
  let legal = 0;
  for (let i = 0; i < mv.length; i++) {
    const m = pickNext(mv, sc, i), fl = m >> 16, pr = (m >> 12) & 7;
    if (!evasions) {
      if (fl & 1) {
        const victim = (fl & 2) ? 100 : SV[pos.bd[(m >> 6) & 63] & 7];
        if (!S.mat && stand + victim + 200 < alpha && !pr) continue;
        if (!S.mat && !pr && see(pos, m) < 0) continue;
      }
    }
    make(pos, m);
    if (attacked(pos.bd, pos.ks[us], us ^ 1)) { unmake(pos); continue; }
    legal++;
    const v = -qsearch(pos, -beta, -alpha, ply + 1, qd + 1);
    unmake(pos);
    if (S.stopped) return 0;
    if (v > best) { best = v; if (v > alpha) { alpha = v; if (alpha >= beta) break; } }
  }
  if (evasions && !legal) return -MATE + ply;
  return best;
}

function negamax(pos, depth, alpha, beta, ply, nullOk) {
  if (S.stopped) return 0;
  S.nodes++;
  if (S.nodes > S.limit && S.rootDepth > 1) { S.stopped = true; return 0; }
  if (ply > 0) {
    if (pos.half >= 100) return 0;
    const lim = Math.max(0, pos.n - pos.half);
    for (let i = pos.n - 2; i >= lim; i -= 2) if (pos.uLo[i] === pos.hlo && pos.uHi[i] === pos.hhi) return 0;
    if (alpha < -MATE + ply) alpha = -MATE + ply;
    if (beta > MATE - ply - 1) beta = MATE - ply - 1;
    if (alpha >= beta) return alpha;
  }
  const us = pos.stm, inChk = attacked(pos.bd, pos.ks[us], us ^ 1);
  if (inChk && ply < 60) depth++;
  if (depth <= 0) return qsearch(pos, alpha, beta, ply, 0);
  if (ply >= 62) return evaluate(pos);
  const pvNode = beta - alpha > 1, idx = pos.hlo & TT_MASK;
  let ttMove = 0;
  if (ttFl[idx] && ttHi[idx] === pos.hhi) {
    ttMove = ttMv[idx];
    if (!pvNode && ttDp[idx] >= depth) {
      let v = ttSc[idx]; if (v > MATE_BAND) v -= ply; else if (v < -MATE_BAND) v += ply;
      const f = ttFl[idx];
      if (f === 1 || (f === 2 && v >= beta) || (f === 3 && v <= alpha)) return v;
    }
  }
  let stat = 0;
  if (!inChk) {
    stat = evaluate(pos);
    if (!pvNode && depth <= 3 && stat - 110 * depth >= beta && beta > -MATE_BAND) return stat;
    if (!pvNode && nullOk && depth >= 3 && stat >= beta && hasNonPawn(pos, us)) {
      makeNull(pos);
      const v = -negamax(pos, depth - 1 - (depth > 5 ? 3 : 2), -beta, -beta + 1, ply + 1, false);
      unmakeNull(pos);
      if (S.stopped) return 0;
      if (v >= beta) return v > MATE_BAND ? beta : v;
    }
  }
  const mv = MVL[ply], sc = SCL[ply];
  gen(pos, mv, false);
  scoreMoves(pos, mv, sc, ttMove, ply);
  let best = -INF, bestMove = 0, legal = 0, flag = 3;
  for (let i = 0; i < mv.length; i++) {
    const m = pickNext(mv, sc, i);
    make(pos, m);
    if (attacked(pos.bd, pos.ks[us], us ^ 1)) { unmake(pos); continue; }
    legal++;
    const quiet = !((m >> 16) & 1) && !((m >> 12) & 7);
    let v;
    if (legal === 1) v = -negamax(pos, depth - 1, -beta, -alpha, ply + 1, true);
    else {
      let red = 0;
      if (depth >= 3 && legal > 3 && quiet && !inChk) red = 1 + (legal > 8 && depth >= 5 ? 1 : 0);
      v = -negamax(pos, depth - 1 - red, -alpha - 1, -alpha, ply + 1, true);
      if (v > alpha && red) v = -negamax(pos, depth - 1, -alpha - 1, -alpha, ply + 1, true);
      if (v > alpha && v < beta) v = -negamax(pos, depth - 1, -beta, -alpha, ply + 1, true);
    }
    unmake(pos);
    if (S.stopped) return 0;
    if (v > best) {
      best = v; bestMove = m;
      if (v > alpha) {
        alpha = v; flag = 1;
        if (alpha >= beta) {
          flag = 2;
          if (quiet) {
            if (killers[ply * 2] !== m) { killers[ply * 2 + 1] = killers[ply * 2]; killers[ply * 2] = m; }
            const h = us * 4096 + (m & 63) * 64 + ((m >> 6) & 63); history[h] += depth * depth; if (history[h] > 800000) history[h] = 800000;
          }
          break;
        }
      }
    }
  }
  if (!legal) return inChk ? -MATE + ply : 0;
  let sv = best; if (sv > MATE_BAND) sv += ply; else if (sv < -MATE_BAND) sv -= ply;
  if (!ttFl[idx] || ttHi[idx] !== pos.hhi || ttDp[idx] <= depth) { ttHi[idx] = pos.hhi; ttMv[idx] = bestMove; ttSc[idx] = sv; ttDp[idx] = depth; ttFl[idx] = flag; }
  return best;
}

/* Cari langkah terbaik. opts: { nodes (batas simpul, default 90000), maxDepth (default 9), exclude: [langkah], depth (pasti selesai sampai kedalaman ini, abaikan batas simpul bila hanya ini), mat }
   Hasil: { best, score (cp dari sudut pihak yang giliran), depth, nodes, pv:[langkah], legal: jumlah langkah sah } */
function search(pos, opts) {
  opts = opts || {};
  ttFl.fill(0); killers.fill(0); history.fill(0);
  S.nodes = 0; S.limit = opts.nodes || 90000; S.stopped = false; S.rootDepth = 1; S.mat = !!opts.mat;
  const us = pos.stm, ex = opts.exclude || [];
  let root = legalMoves(pos);
  const total = root.length;
  root = root.filter(m => !ex.includes(m));
  if (!root.length) {
    const inChk = attacked(pos.bd, pos.ks[us], us ^ 1);
    return { best: 0, score: total ? null : (inChk ? -MATE : 0), depth: 0, nodes: 0, pv: [], legal: total };
  }
  const sc = new Array(root.length); scoreMoves(pos, root, sc, 0, 0);
  for (let i = 0; i < root.length; i++) pickNext(root, sc, i);
  let bestMove = root[0], bestScore = -INF, doneDepth = 0;
  const maxD = Math.min(opts.maxDepth || 9, 40);
  for (let d = 1; d <= maxD; d++) {
    S.rootDepth = d;
    let alpha = -INF, curBest = 0, curScore = -INF;
    for (let i = 0; i < root.length; i++) {
      const m = root[i];
      make(pos, m);
      let v;
      if (i === 0) v = -negamax(pos, d - 1, -INF, -alpha, 1, true);
      else {
        v = -negamax(pos, d - 1, -alpha - 1, -alpha, 1, true);
        if (v > alpha && !S.stopped) v = -negamax(pos, d - 1, -INF, -alpha, 1, true);
      }
      unmake(pos);
      if (S.stopped) break;
      if (v > curScore) { curScore = v; curBest = m; if (v > alpha) alpha = v; }
    }
    if (S.stopped) break;
    bestMove = curBest; bestScore = curScore; doneDepth = d;
    const bi = root.indexOf(curBest); if (bi > 0) { root.splice(bi, 1); root.unshift(curBest); }
    // simpan akar di TT supaya PV bisa ditelusuri
    const ix = pos.hlo & TT_MASK; ttHi[ix] = pos.hhi; ttMv[ix] = curBest; ttSc[ix] = curScore; ttDp[ix] = d; ttFl[ix] = 1;
    if (Math.abs(curScore) > MATE - 200) break;      // mat terpaksa ditemukan (iterasi terpendek)
    if (opts.depth && d >= opts.depth) break;
    if (S.nodes > S.limit && !opts.depth) break;
  }
  // PV dari TT
  const pv = [bestMove]; let made = 0;
  make(pos, bestMove); made++;
  for (let i = 0; i < 14; i++) {
    const ix = pos.hlo & TT_MASK;
    if (!(ttFl[ix] && ttHi[ix] === pos.hhi && ttMv[ix])) break;
    const m = ttMv[ix];
    if (!legalMoves(pos).includes(m)) break;
    make(pos, m); made++; pv.push(m);
    const lim = Math.max(0, pos.n - pos.half); let rep = false;
    for (let j = pos.n - 2; j >= lim; j -= 2) if (pos.uLo[j] === pos.hlo && pos.uHi[j] === pos.hhi) { rep = true; break; }
    if (rep) break;
  }
  while (made--) unmake(pos);
  return { best: bestMove, score: bestScore, depth: doneDepth, nodes: S.nodes, pv, legal: total };
}

/* ---------- penilaian langkah ---------- */
const winPct = cp => 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * Math.max(-2000, Math.min(2000, cp)))) - 1);
const matOf = (pos, side) => { let s = 0; for (let i = 0; i < 64; i++) { const p = pos.bd[i]; if (p && (p >> 3) === side) s += MATV[p & 7]; } return s; };
const NODES = 90000;

/* pengorbanan: mainkan PV (langkah pertama = langkah yang dinilai), selesaikan tangkapan dengan qsearch material,
   bandingkan material pemain sebelum vs sesudah. Hasil = defisit (poin) — >= 2 berarti mengorbankan material. */
function sacDeficit(pos, pv) {
  const us = pos.stm, before = matOf(pos, us) - matOf(pos, us ^ 1);
  let made = 0;
  for (const m of pv) { make(pos, m); made++; }
  const staticEnd = matOf(pos, us) - matOf(pos, us ^ 1);
  S.nodes = 0; S.limit = 20000; S.stopped = false; S.rootDepth = 1; S.mat = true;
  const v = qsearch(pos, -INF, INF, 0, 0);                  // sudut pihak yang giliran di ujung PV
  S.mat = false;
  while (made--) unmake(pos);
  // PV berakhir skakmat/pat -> qsearch mengembalikan skor mat, bukan material: pakai material statis di ujung PV
  const endMine = Math.abs(v) > MATE_BAND || S.stopped ? staticEnd : (pv.length % 2 === 0 ? v : -v) / 100;
  return before - endMine;
}

/* Nilai satu langkah. pos = posisi SEBELUM langkah, m = langkah (int dari legalMoves/findMove), memo = { full: {} } cache pencarian penuh per posisi.
   Hasil: { k, l, b, e, s? }
     k = brilliant|best|excellent|good|inaccuracy|mistake|blunder; l = penurunan peluang menang (poin %); b = langkah terbaik (uci);
     e = evaluasi setelah langkah (cp, sudut pemain); s = pengorbanan material (poin) bila Brilliant */
function rateMove(pos, m, memo, opt) {
  opt = opt || {};
  const nodes = opt.nodes || NODES, us = pos.stm;
  memo = memo || { full: {} };
  const key = pos.hhi + ':' + pos.hlo + ':' + pos.n;
  let full = memo.full[key];
  if (!full) full = memo.full[key] = search(pos, { nodes });
  if (full.score == null) return null;
  const isBest = full.best === m, legalN = full.legal;
  const beforeCp = full.score;
  let afterCp = beforeCp, pv;
  if (isBest) pv = full.pv;
  else {
    make(pos, m);
    const res = search(pos, { nodes, depth: Math.max(1, full.depth - 1), maxDepth: Math.max(1, full.depth - 1) });
    const term = legalMoves(pos).length === 0;
    unmake(pos);
    if (term) { afterCp = (res.score == null || res.score <= -MATE + 1) ? MATE : 0; pv = [m]; }
    else { afterCp = -res.score; pv = [m].concat(res.pv); }
  }
  const wB = winPct(beforeCp), wA = winPct(afterCp);
  const ply = opt.ply != null ? opt.ply : pos.n;
  // pembukaan: evaluasi posisi-awal sangat tipis, jadi selisih kecil di 8 ply pertama dianggap derau, bukan kesalahan
  const delta = isBest ? 0 : Math.max(0, wB - wA - (ply < 8 ? 1.5 : 0));
  let k;
  if (isBest || delta <= 0.25) k = 'best';
  else if (delta <= 2) k = 'excellent';
  else if (delta <= 5) k = 'good';
  else if (delta <= 10) k = 'inaccuracy';
  else if (delta <= 20) k = 'mistake';
  else k = 'blunder';
  const out = { k, l: +delta.toFixed(2), b: uci(full.best), e: afterCp, bs: beforeCp };
  if (legalN === 1) out.f = 1;                                   // satu-satunya langkah sah: tidak pernah Brilliant
  // Brilliant: langkah setara terbaik engine yang mengorbankan material, posisi sesudahnya tidak kalah, dan belum menang telak sebelumnya
  if (k === 'best' && legalN > 1) {
    const mateWin = afterCp > MATE_BAND;
    if (afterCp >= -50 && (beforeCp <= 400 || mateWin)) {
      const def = sacDeficit(pos, pv);
      if (def >= 2 && (!mateWin || def >= 5 || beforeCp <= 400)) {
        const alt = search(pos, { nodes, exclude: [m], depth: full.depth, maxDepth: full.depth });
        if (alt.score == null || alt.score < afterCp - 35) { out.k = 'brilliant'; out.s = +def.toFixed(1); }
      }
    }
  }
  return out;
}


/* ---------- Hint "brutal" (Mode dev) ----------
   1) pencarian dalam (default 700rb simpul, sampai kedalaman 18) mencari langkah terkuat;
   2) hasilnya divalidasi dengan penilai langkah yang SAMA dengan Live Move Analysis (rateMove),
      supaya langkah yang disarankan benar-benar dinilai Best / Brilliant kalau dimainkan;
   3) kalau langkah dalam itu tidak dinilai Best oleh penilai, dipakai langkah terbaik penilai.
   Hasil: { m, uci, from, to, promo, k, s?, cp, mate, depth, nodes, legal, agree } atau null (tidak ada langkah). */
function hint(pos, memo, opt) {
  opt = opt || {};
  memo = memo || { full: {} };
  const base = opt.nodes || NODES, key = pos.hhi + ':' + pos.hlo + ':' + pos.n;
  let full = memo.full[key];
  if (!full) full = memo.full[key] = search(pos, { nodes: base });
  if (full.score == null || !full.legal) return null;
  let deep = full;
  if (full.legal > 1) deep = search(pos, { nodes: opt.deepNodes || 700000, maxDepth: opt.maxDepth || 18 });
  if (deep.score == null || !deep.best) deep = full;
  const cands = [deep.best]; if (full.best !== deep.best) cands.push(full.best);
  const rated = [];
  for (const m of cands) { const r = full.legal === 1 ? { k: 'best', e: full.score, f: 1 } : rateMove(pos, m, memo, { nodes: base }); if (r) rated.push({ m, r }); }
  const pick = rated.find(x => x.r.k === 'brilliant') || rated.find(x => x.r.k === 'best') || { m: full.best, r: rated.length ? rated[rated.length - 1].r : null };
  const m = pick.m, r = pick.r, cp = r && r.e != null ? r.e : full.score;
  const pr = (m >> 12) & 7;
  const out = { m, uci: uci(m), from: m & 63, to: (m >> 6) & 63, promo: pr ? 'nbrq'[pr - 2].toUpperCase() : '', k: r ? r.k : 'best', cp, depth: deep.depth, nodes: deep.nodes, legal: full.legal, agree: deep.best === full.best };
  if (r && r.s != null) out.s = r.s;
  if (Math.abs(cp) > MATE - 1000) out.mate = (cp > 0 ? 1 : -1) * Math.max(1, Math.ceil((MATE - Math.abs(cp)) / 2));
  return out;
}

G.CHENG = { hint, VER, MATE, newPos, fromFen, applyMove, findMove, legalMoves, make, unmake, boardStr, uci, sqName, perft, search, rateMove, winPct, evaluate, see, NODES };
})(typeof self !== 'undefined' ? self : globalThis);
