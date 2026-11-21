/* ===== Live Move Analysis — manajer (dipakai chessmp.js untuk Catur Multiplayer dan games.js untuk Catur vs AI) =====
   Menilai tiap langkah (Brilliant, Best, Excellent, Good, Inaccuracy, Mistake, Blunder) dengan engine buatan sendiri
   (public/chessan-engine.js, jalan di Web Worker public/chessan-worker.js — tanpa Stockfish, tanpa server).
   Modul ini TIDAK memvalidasi langkah pemain dan TIDAK mengubah state permainan; murni analisis + tampilan.

   API (window.CHAN):
     track(gid, moves, {board})    daftar langkah lengkap dari posisi awal: [[dari, ke, 'Q'|'R'|'B'|'N'|''], ...] (indeks kotak 0..63)
     add(gid, dari, ke, promo)     tambah satu langkah di ujung (langkah baru saja dimainkan)
     undo(gid)                     buang langkah terakhir (langkah ditolak server)
     ensure(gid, ply, board, loader) -> Promise: pastikan tracker punya `ply` langkah; kalau kurang, panggil loader() -> [[dari,ke,promo]...]
     get(gid, ply) / board(gid, ply) / last(gid, ply) / count(gid) / ok(gid)
     show(gid, ply)                tampilkan indikator langkah ke-ply (menunggu bila ratingnya belum selesai)
     attach()                      pasang indikator aktif ke papan di DOM (dipanggil setelah tiap render)
     pill(gid, ply)                HTML ikon kecil untuk daftar langkah (terisi otomatis saat rating selesai)
     icon(kunci, ukuran) / META    ikon + warna + nama tiap rating
   Rating disimpan di localStorage per game, jadi tetap muncul saat riwayat ditelusuri & dibuka ulang. */
(() => {
'use strict';
const E = window.CHENG;
if (!E) return;
const CFG = { enabled: true, nodes: E.NODES, hold: 700, fade: 2600, keep: 30 };   // hold + fade = lama indikator tampil (ms)
const TOTAL = () => CFG.hold + CFG.fade;
const LS = 'chan' + E.VER + ':';

/* ---------- warna & ikon (palet yang sama dengan penanda review di chessmp.js; Brilliant = teal baru) ---------- */
const META = {
  brilliant: { n: 'Brilliant', c: '#26c2a3', g: '!!' },
  best: { n: 'Best', c: '#81b64c', g: '!' },
  excellent: { n: 'Excellent', c: '#81b64c', g: 'thumb' },
  good: { n: 'Good', c: '#95b776', g: 'check' },
  inaccuracy: { n: 'Inaccuracy', c: '#f7c631', g: '?!' },
  mistake: { n: 'Mistake', c: '#f0a037', g: '?' },
  blunder: { n: 'Blunder', c: '#d93a32', g: '??' }
};
const PATH = {
  thumb: '<path d="M8 11v8H5v-8zM10 11l3-6c1.4 0 2.2 1.1 1.9 2.4L14.4 10H19a1.6 1.6 0 011.6 1.9l-1.1 6A1.8 1.8 0 0117.8 19H10z" fill="#fff" stroke="none"/>',
  check: '<path d="M7 12.6l3.4 3.4L17.2 8.6" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>'
};
/* fill/stroke diset eksplisit per elemen: CSS global index.html (svg{fill:none;stroke:currentColor}) mengalahkan atribut presentasi lewat pewarisan */
function icon(k, size) {
  const m = META[k]; if (!m) return '';
  const s = size || 18;
  const body = PATH[m.g] || '<text x="12" y="' + (m.g.length > 1 ? 16.2 : 17) + '" text-anchor="middle" font-size="' + (m.g.length > 1 ? 12.5 : 16) + '" font-weight="800" fill="#fff" stroke="none" font-family="system-ui,-apple-system,Segoe UI,sans-serif">' + m.g + '</text>';
  return '<svg class="cn-ic" viewBox="0 0 24 24" width="' + s + '" height="' + s + '" aria-hidden="true"><circle cx="12" cy="12" r="11.2" fill="' + m.c + '" stroke="rgba(0,0,0,.22)" stroke-width="1"/>' + body + '</svg>';
}

/* ---------- penyimpanan per game ---------- */
const games = new Map();
const newGame = gid => ({ gid, moves: [], boards: [E.boardStr(E.newPos())], pos: E.newPos(), rate: [], fail: {}, pend: -1, gen: 1, bad: false, want: 0, warmed: -1, saveT: 0 });
const uciOf = m => E.sqName(m[0]) + E.sqName(m[1]) + (m[2] ? String(m[2]).toLowerCase() : '');
let mru = [];   // gid terbaru di depan
const touch = gid => { mru = [gid].concat(mru.filter(x => x !== gid)).slice(0, 6); };

function push(G, mv) {
  const pr = mv[2] ? String(mv[2]).toUpperCase() : '';
  if (E.applyMove(G.pos, mv[0] | 0, mv[1] | 0, pr || null) == null) { G.bad = true; return false; }
  G.moves.push([mv[0] | 0, mv[1] | 0, pr]);
  G.boards.push(E.boardStr(G.pos));
  return true;
}
function restore(G) {
  try {
    const raw = localStorage.getItem(LS + G.gid); if (!raw) return;
    const d = JSON.parse(raw); if (!d || d.v !== E.VER || !Array.isArray(d.m)) return;
    for (let i = 0; i < d.m.length && i < G.moves.length; i++) {
      if (d.m[i] !== uciOf(G.moves[i])) break;               // beda langkah -> rating sesudahnya tidak berlaku
      const x = d.r && d.r[i];
      if (x && META[x[0]]) G.rate[i] = { k: x[0], l: x[1], e: x[2], b: x[3] || '', s: x[4] };
    }
  } catch { /* penyimpanan penuh/diblokir: abaikan, rating dihitung ulang */ }
}
function save(G) {
  clearTimeout(G.saveT);
  G.saveT = setTimeout(() => {
    try {
      const r = G.moves.map((_, i) => { const x = G.rate[i]; return x ? [x.k, x.l, x.e, x.b || '', x.s || 0] : 0; });
      localStorage.setItem(LS + G.gid, JSON.stringify({ v: E.VER, m: G.moves.map(uciOf), r }));
      let idx = []; try { idx = JSON.parse(localStorage.getItem(LS + 'idx') || '[]'); } catch {}
      idx = [G.gid].concat(idx.filter(x => x !== G.gid));
      for (const old of idx.slice(CFG.keep)) localStorage.removeItem(LS + old);
      localStorage.setItem(LS + 'idx', JSON.stringify(idx.slice(0, CFG.keep)));
    } catch { /* abaikan */ }
  }, 500);
}

function track(gid, list, opt) {
  if (!CFG.enabled) return null;
  list = list || [];
  let G = games.get(gid);
  const same = G && G.moves.length <= list.length && G.moves.every((m, i) => m[0] === (list[i][0] | 0) && m[1] === (list[i][1] | 0) && m[2] === (list[i][2] ? String(list[i][2]).toUpperCase() : ''));
  const fresh = !G || !same;
  if (fresh) { G = newGame(gid); games.set(gid, G); }
  for (let i = G.moves.length; i < list.length; i++) if (!push(G, list[i])) break;
  if (fresh) restore(G);
  if (opt && opt.board && !G.bad && G.boards[G.moves.length] !== opt.board) G.bad = true;   // papan lokal beda dengan server: jangan tampilkan penilaian yang mungkin salah
  touch(gid); pump();
  return G;
}
function add(gid, f, t, pr) {
  const G = games.get(gid); if (!G || G.bad) return false;
  if (!push(G, [f, t, pr || ''])) return false;
  touch(gid); save(G); pump(); return true;
}
function undo(gid) {
  const G = games.get(gid); if (!G) return;
  const list = G.moves.slice(0, -1), rates = G.rate.slice(0, list.length);
  const N = newGame(gid); N.gen = G.gen + 1; games.set(gid, N);
  for (const m of list) if (!push(N, m)) break;
  N.rate = rates;
  if (IND && IND.gid === gid && IND.ply > list.length) IND = null;
}
const get = (gid, ply) => { const G = games.get(gid); return G && !G.bad && ply >= 1 ? G.rate[ply - 1] || null : null; };
const board = (gid, ply) => { const G = games.get(gid); return G && !G.bad && ply >= 0 && ply < G.boards.length ? G.boards[ply] : null; };
const last = (gid, ply) => { const G = games.get(gid); const m = G && !G.bad && ply >= 1 ? G.moves[ply - 1] : null; return m ? { f: m[0], t: m[1] } : null; };
const count = gid => { const G = games.get(gid); return G && !G.bad ? G.moves.length : 0; };
const ok = gid => { const G = games.get(gid); return !!G && !G.bad; };

/* buka ulang game dari penyimpanan lokal (riwayat server terpotong / tidak ada): hanya berisi langkah, papan tetap diverifikasi lewat opt.board */
function resume(gid, bd) {
  try {
    const d = JSON.parse(localStorage.getItem(LS + gid) || 'null'); if (!d || d.v !== E.VER || !Array.isArray(d.m)) return null;
    return track(gid, d.m.map(u => [(8 - +u[1]) * 8 + (u.charCodeAt(0) - 97), (8 - +u[3]) * 8 + (u.charCodeAt(2) - 97), u[4] ? u[4].toUpperCase() : '']), { board: bd });
  } catch { return null; }
}
const loading = {};
function ensure(gid, ply, bd, loader) {
  if (!CFG.enabled) return Promise.resolve(false);
  const G = games.get(gid);
  if (G && !G.bad && G.moves.length === ply && (!bd || G.boards[ply] === bd)) { touch(gid); return Promise.resolve(true); }
  if (ply === 0) { track(gid, [], { board: bd }); return Promise.resolve(true); }
  if (!loader) return Promise.resolve(false);
  if (loading[gid] && Date.now() - loading[gid] < 15000) return Promise.resolve(false);   // jangan menembak endpoint berulang
  loading[gid] = Date.now();
  return Promise.resolve().then(loader).then(list => { const g = track(gid, list || [], { board: bd }); return !!g && !g.bad; }).catch(() => false);
}

/* ---------- eksekusi: worker, dengan cadangan di thread utama ---------- */
let worker = null, workerBad = false, busy = false, jobId = 0, watch = 0;
const localMemo = new Map();
function getWorker() {
  if (worker || workerBad) return worker;
  try {
    worker = new Worker('/chessan-worker.js?v=1');
    worker.onmessage = ev => onResult(ev.data);
    worker.onerror = () => { workerBad = true; try { worker.terminate(); } catch {} worker = null; if (busy) { busy = false; } pump(); };
  } catch { workerBad = true; worker = null; }
  return worker;
}
function runLocal(job) {   // tanpa Worker: tetap jalan di thread utama (sedikit tersendat, tapi hasil identik)
  setTimeout(() => {
    let m = localMemo.get(job.gid); if (!m) { if (localMemo.size > 4) localMemo.clear(); m = { full: {} }; localMemo.set(job.gid, m); }
    try {
      const pos = E.newPos(); for (let i = 0; i < (job.cmd === 'warm' ? job.moves.length : job.idx); i++) E.applyMove(pos, job.moves[i][0], job.moves[i][1], job.moves[i][2] || null);
      if (job.cmd === 'warm') { const key = pos.hhi + ':' + pos.hlo + ':' + pos.n; if (!m.full[key]) m.full[key] = E.search(pos, { nodes: job.nodes }); onResult({ job: job.job, gid: job.gid, idx: -1, r: null }); }
      else { const mv = job.moves[job.idx], mm = E.findMove(pos, mv[0], mv[1], mv[2] || null); onResult({ job: job.job, gid: job.gid, idx: job.idx, r: mm == null ? null : E.rateMove(pos, mm, m, { nodes: job.nodes }) }); }
    } catch (e) { onResult({ job: job.job, gid: job.gid, idx: job.idx, r: null, err: String(e) }); }
  }, 0);
}
function pump() {
  if (busy || !CFG.enabled) return;
  let job = null;
  for (const gid of mru) {
    const G = games.get(gid); if (!G || G.bad) continue;
    const todo = i => i >= 0 && i < G.moves.length && !G.rate[i] && !G.fail[i];
    let idx = -1;
    if (todo(G.want - 1)) idx = G.want - 1;                          // langkah yang sedang ditunggu layar didahulukan
    else for (let i = G.moves.length - 1; i >= 0; i--) if (todo(i)) { idx = i; break; }   // lalu yang terbaru
    if (idx >= 0) { job = { cmd: 'rate', gid, idx, moves: G.moves.slice(0, idx + 1), nodes: CFG.nodes, gen: G.gen }; break; }
  }
  if (!job) {                                                         // senggang: panaskan posisi sekarang supaya langkah berikutnya cepat
    const gid = mru[0], G = gid && games.get(gid);
    if (G && !G.bad && G.warmed !== G.moves.length && G.moves.length < 400) { G.warmed = G.moves.length; job = { cmd: 'warm', gid, moves: G.moves.slice(), nodes: CFG.nodes, gen: G.gen, idx: -1 }; }
  }
  if (!job) return;
  job.job = ++jobId; busy = true; current = job;
  clearTimeout(watch); watch = setTimeout(() => {          // pengaman: pekerja macet -> tandai gagal, jangan menahan antrean
    if (!busy || current !== job) return;
    busy = false; const G = games.get(job.gid); if (G && job.idx >= 0) G.fail[job.idx] = true;
    try { if (worker) worker.terminate(); } catch {} worker = null; pump();
  }, 25000);
  const w = getWorker();
  if (w) w.postMessage(job); else runLocal(job);
}
let current = null;
function onResult(d) {
  if (!current || d.job !== current.job) return;
  clearTimeout(watch); busy = false;
  const job = current; current = null;
  const G = games.get(job.gid);
  if (G && G.gen === job.gen && job.idx >= 0) {
    if (d.r && META[d.r.k]) {
      G.rate[job.idx] = d.r; save(G);
      fire(job.gid, job.idx + 1, d.r);
    } else G.fail[job.idx] = true;
  }
  pump();
}

/* ---------- indikator di papan ---------- */
let IND = null, cleanT = 0;
const listeners = [];
function fire(gid, ply, r) {
  if (IND && IND.gid === gid && IND.ply === ply && IND.born == null) { IND.born = Date.now(); attach(); }
  fillPills();
  for (const f of listeners) { try { f({ gid, ply, r }); } catch {} }
}
function show(gid, ply) {
  if (!CFG.enabled || !ply || ply < 1) { IND = null; attach(); return; }
  const G = games.get(gid); if (!G || G.bad) { IND = null; attach(); return; }
  G.want = ply; touch(gid);
  IND = { gid, ply, born: G.rate[ply - 1] ? Date.now() : null };
  attach(); pump();
}
function clear() { IND = null; attach(); }
function boardEl() { return document.querySelector('#gmbody .ch-board'); }
function attach() {
  const bd = boardEl();
  clearTimeout(cleanT);
  if (!bd) return;
  bd.querySelectorAll('.cn-sq,.cn-bg').forEach(e => e.remove());
  const I = IND; if (!I || I.born == null) return;
  const el = Date.now() - I.born;
  if (el >= TOTAL()) { IND = null; return; }
  const G = games.get(I.gid); if (!G || G.bad) return;
  const r = G.rate[I.ply - 1], mv = G.moves[I.ply - 1]; if (!r || !mv) return;
  const sq = bd.querySelector('.ch-sq[data-i="' + mv[1] + '"]'); if (!sq) return;
  // pengaman: bidak di kotak tujuan pada papan yang tampil harus sama dengan hasil langkah ini (jenis + warna); kalau tidak, papan itu bukan posisinya
  const want = (G.boards[I.ply] || '')[mv[1]], pe = sq.querySelector('.ch-p:not(.ch-ghost)');
  if (pe && want && want !== '.') {
    const typ = 'KQRBNP'.indexOf(want.toUpperCase()), code = pe.textContent.charCodeAt(0) - 0x265A;
    if (typ !== code || pe.classList.contains('ch-w') !== (want === want.toUpperCase())) return;
  }
  const m = META[r.k], delay = 'animation-delay:' + (CFG.hold - el) + 'ms;animation-duration:' + CFG.fade + 'ms';
  const tint = document.createElement('i');
  tint.className = 'cn-sq'; tint.setAttribute('aria-hidden', 'true');
  tint.style.cssText = '--rc:' + m.c + ';' + delay;
  sq.insertBefore(tint, sq.firstChild);
  const pc = sq.querySelector('.ch-p:not(.ch-ghost)');
  if (pc) {
    const b = document.createElement('i');
    b.className = 'cn-bg'; b.setAttribute('aria-hidden', 'true'); b.title = m.n;
    b.style.cssText = delay;
    b.innerHTML = icon(r.k, 100);
    pc.appendChild(b);                                   // anak bidak: ikut meluncur bersama bidak selama animasi
  }
  cleanT = setTimeout(() => { if (IND === I) IND = null; bd.querySelectorAll('.cn-sq,.cn-bg').forEach(e => e.remove()); }, TOTAL() - el + 60);
}

/* ---------- ikon kecil untuk daftar langkah ---------- */
function pill(gid, ply) {
  const r = get(gid, ply);
  return '<span class="cn-slot" data-cng="' + String(gid).replace(/[^\w:.-]/g, '') + '" data-cnp="' + ply + '"' + (r ? ' title="' + META[r.k].n + '"' : '') + '>' + (r ? icon(r.k, 15) : '') + '</span>';
}
function fillPills() {
  const root = document.getElementById('gmbody'); if (!root) return;
  root.querySelectorAll('.cn-slot').forEach(s => {
    const r = get(s.dataset.cng, +s.dataset.cnp);
    if (r && !s.firstChild) { s.innerHTML = icon(r.k, 15); s.title = META[r.k].n; }
  });
}

window.CHAN = {
  CFG, META, icon, pill, track, add, undo, ensure, resume, get, board, last, count, ok, show, clear, attach, fillPills,
  onRate: f => { listeners.push(f); },
  has: gid => games.has(gid),
  /* ringkasan jumlah tiap rating satu pemain (0 = putih / 1 = hitam) — untuk tampilan ringkas bila dibutuhkan */
  tally(gid, side) { const G = games.get(gid), out = {}; if (!G) return out; G.rate.forEach((r, i) => { if (r && i % 2 === side) out[r.k] = (out[r.k] || 0) + 1; }); return out; }
};
})();
