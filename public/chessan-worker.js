/* Web Worker Live Move Analysis: menilai langkah di luar thread UI. Protokol:
     masuk  { cmd:'rate', job, gid, moves:[[from,to,promo],...], idx, nodes }  nilai langkah ke-idx (0-based) dari awal standar
            { cmd:'warm', job, gid, moves, nodes }                              pemanasan: cari posisi sesudah moves (dipakai langkah berikutnya)
            { cmd:'hint', job, gid, moves, deepNodes?, maxDepth? }              hint dev: langkah terkuat + rating (keluar { job, gid, hint })
            { cmd:'drop', gid }                                                 buang cache game
     keluar { job, gid, idx, r:{k,l,b,e,...}|null, err? }
   Cache pencarian per game ada di sini (memo), jadi langkah berikutnya tidak mengulang pencarian posisi yang sama. */
importScripts('/chessan-engine.js?v=2');
const E = self.CHENG, memos = new Map();
const memoOf = gid => { let m = memos.get(gid); if (!m) { if (memos.size > 8) memos.delete(memos.keys().next().value); m = { full: {} }; memos.set(gid, m); } return m; };
function replay(moves, upto) {
  const pos = E.newPos();
  for (let i = 0; i < upto; i++) { const mv = moves[i]; if (E.applyMove(pos, mv[0], mv[1], mv[2]) == null) return null; }
  return pos;
}
self.onmessage = e => {
  const d = e.data || {};
  try {
    if (d.cmd === 'drop') { memos.delete(d.gid); return; }
    if (d.cmd === 'warm') {
      const pos = replay(d.moves, d.moves.length); if (!pos) return self.postMessage({ job: d.job, gid: d.gid, idx: -1, r: null, err: 'ilegal' });
      const memo = memoOf(d.gid), key = pos.hhi + ':' + pos.hlo + ':' + pos.n;
      if (!memo.full[key]) memo.full[key] = E.search(pos, { nodes: d.nodes || E.NODES });
      return self.postMessage({ job: d.job, gid: d.gid, idx: -1, r: null });
    }
    if (d.cmd === 'hint') {
      const pos = replay(d.moves, d.moves.length); if (!pos) return self.postMessage({ job: d.job, gid: d.gid, idx: -1, r: null, err: 'ilegal' });
      const h = E.hint(pos, memoOf(d.gid), { deepNodes: d.deepNodes, maxDepth: d.maxDepth });
      if (h) delete h.m;   // int langkah internal tidak perlu dikirim
      return self.postMessage({ job: d.job, gid: d.gid, idx: -1, r: null, hint: h });
    }
    if (d.cmd === 'rate') {
      const pos = replay(d.moves, d.idx), mv = d.moves[d.idx];
      const m = pos && mv ? E.findMove(pos, mv[0], mv[1], mv[2]) : null;
      if (m == null) return self.postMessage({ job: d.job, gid: d.gid, idx: d.idx, r: null, err: 'ilegal' });
      self.postMessage({ job: d.job, gid: d.gid, idx: d.idx, r: E.rateMove(pos, m, memoOf(d.gid), { nodes: d.nodes || E.NODES }) });
    }
  } catch (err) { self.postMessage({ job: d.job, gid: d.gid, idx: d.idx, r: null, err: String(err && err.message || err) }); }
};
