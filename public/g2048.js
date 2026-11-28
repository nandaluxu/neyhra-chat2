/* ===== Minigame 2048 (tab Minigame, layar 'g2048') =====
   Dimuat setelah games.js. Papan, tile baru, skor, dan hadiah diputuskan SERVER (lib/g2048.js) lewat /api/auth/g2048*;
   file ini hanya menampilkan dan menganimasikan. Supaya geseran terasa instan, hasil geser (tanpa tile baru) dihitung
   lokal dan dianimasikan seketika, sementara tile baru + skor resmi datang dari respons server. Kalau papan lokal
   berbeda dari papan server, layar disinkronkan ke server (server selalu benar).

   Dipanggil games.js: G2048.enter() (buka layar, ambil keadaan), G2048.render(body) (gambar ulang; NO-OP saat animasi
   berjalan supaya innerHTML tidak memutus animasi), G2048.leave() (pulang ke hub / keluar tab).
   Kelas CSS berprefix g48-, aksi data-act berprefix g48- (handler klik games.js mengabaikannya).
   Global index.html yang dipakai: atok, aOn, aApi, toast, saveWallet. */
(() => {
'use strict';
const $ = id => document.getElementById(id);
const app = $('app');
const nf = new Intl.NumberFormat('id-ID');
const lvChip = m => (window.LEVEL ? LEVEL.chip(m) : ''); // chip "Hadiah ×1,06" (pengali level akun dari server; level.js). Tidak dipakai di Fruit Slot & gacha
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const host = () => $('gmbody');
const N = 4, SLIDE_MS = 115;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const ICON = '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="8" height="8" rx="2"/><rect x="13" y="3" width="8" height="8" rx="2"/><rect x="3" y="13" width="8" height="8" rx="2"/><path d="M14 17h6M17 14v6" /></svg>';
const BACK = '<svg viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6"/></svg>';

let on = false;            // layar 2048 sedang dibuka
let intro = true;          // true = layar pembuka (aturan + tombol), false = papan
let st = null;             // keadaan terakhir dari server { cfg, daily, best, bestTile, game, coins, gems }
let failed = '';           // pesan kalau gagal memuat
let tiles = [], nid = 1;   // tile di layar: { id, v, r, c }
let lock = false;          // ada geseran yang sedang dianimasikan / menunggu server
let pending = '';          // satu arah yang ditekan saat lock (dijalankan setelahnya)
let armNew = 0;            // konfirmasi dua-tap "Game baru"
let msg = ['', ''];        // [teks, kelas] di bawah papan
let wonOpen = false;       // overlay "2048!" tampil
let wonSeen = false;       // overlay menang sudah ditutup pemain untuk permainan ini
let shown = 0;             // skor yang tampil (naik seketika saat geser, dikoreksi dari server)

const reduce = () => !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
const game = () => (st && st.game) || null;
const live = () => { const g = game(); return !!(g && g.active); };

/* ---------- Logika geser lokal (cermin lib/g2048.js, hanya untuk animasi) ---------- */
function lineCells(d, k) { // sel baris/kolom ke-k, urut dari sisi tujuan geser
  const a = [];
  for (let i = 0; i < N; i++) {
    if (d === 'left') a.push([k, i]);
    else if (d === 'right') a.push([k, N - 1 - i]);
    else if (d === 'up') a.push([i, k]);
    else a.push([N - 1 - i, k]);
  }
  return a;
}
function simulate(d) {
  const at = new Map(tiles.map(t => [t.r * N + t.c, t]));
  const moves = [], merges = [];
  let score = 0, moved = false;
  for (let k = 0; k < N; k++) {
    const cells = lineCells(d, k), line = cells.map(([r, c]) => at.get(r * N + c)).filter(Boolean);
    let j = 0;
    for (let i = 0; i < line.length; i++) {
      const a = line[i], b = line[i + 1], [r, c] = cells[j];
      if (b && a.v === b.v) {
        moves.push({ t: a, r, c }, { t: b, r, c });
        merges.push({ keep: a, gone: b });
        score += a.v * 2; i++;
        moved = true;
      } else moves.push({ t: a, r, c });
      if (a.r !== r || a.c !== c) moved = true;
      j++;
    }
  }
  return { moved, moves, merges, score };
}
const boardOf = () => { const b = new Array(N * N).fill(0); tiles.forEach(t => { b[t.r * N + t.c] = t.v; }); return b; };

/* ---------- Gambar ---------- */
const sizeCls = v => (v >= 10000 ? ' d5' : v >= 1000 ? ' d4' : v >= 100 ? ' d3' : '');
const valCls = v => 'v' + (v > 8192 ? 'x' : v);
const tileHtml = (t, extra) => '<div class="g48-t" data-id="' + t.id + '" style="--r:' + t.r + ';--c:' + t.c + '"><div class="g48-v ' + valCls(t.v) + sizeCls(t.v) + (extra ? ' ' + extra : '') + '">' + t.v + '</div></div>';
function syncTiles() { // bangun ulang tile dari papan server
  tiles = []; const g = game(); if (!g) return;
  g.b.forEach((v, i) => { if (v) tiles.push({ id: nid++, v, r: (i / N) | 0, c: i % N }); });
}
const wallet = () => st ? '<span class="g48-chip"><img src="/coin.svg" alt="">' + nf.format(st.daily.coins) + '/' + nf.format(st.daily.cap) + ' hari ini</span>' : '';

function overlayHtml() {
  const g = game(); if (!g) return '';
  if (g.over) {
    const best = g.score >= (st.best || 0) && g.score > 0;
    return '<div class="g48-ov" role="dialog" aria-label="Permainan selesai"><h3>Game over</h3><p>Skor ' + nf.format(g.score) + (best ? ' · rekor baru!' : '') + ' · tile terbesar ' + nf.format(g.max) + '</p>' +
      (g.earned ? '<div class="gm-prize"><img src="/coin.svg" alt="">+' + nf.format(g.earned) + ' coin</div>' : '') +
      '<button class="gm-btn" type="button" data-act="g48-new">Main lagi</button></div>';
  }
  if (wonOpen) return '<div class="g48-ov" role="dialog" aria-label="Kamu menang"><h3>2048!</h3><p>Kamu berhasil. Lanjut main untuk skor yang lebih tinggi?</p>' +
    '<button class="gm-btn" type="button" data-act="g48-go">Lanjut main</button></div>';
  return '';
}
function boardHtml() {
  let cells = ''; for (let i = 0; i < N * N; i++) cells += '<i></i>';
  return '<div class="g48-board" id="g48b" tabindex="0" aria-label="Papan 2048. Geser atau pakai tombol panah."><div class="g48-grid">' + cells + '</div>' +
    '<div class="g48-tiles" id="g48t">' + tiles.map(t => tileHtml(t)).join('') + '</div><div id="g48o">' + overlayHtml() + '</div></div>';
}
const msgHtml = () => '<p class="gm-msg' + (msg[1] ? ' ' + msg[1] : '') + '" role="status">' + esc(msg[0]) + '</p>';

function introView() {
  const g = game(), rw = st.cfg.rewards, keys = Object.keys(rw), resume = !!(g && g.active && g.moves > 0);
  return '<button class="gm-back" type="button" data-act="hub">' + BACK + 'Semua game</button><div class="gm-panel"><div class="gm-intro"><span class="ic">' + ICON + '</span><h2>2048</h2>' +
    '<p class="gm-hint">Gabungkan tile yang angkanya sama sampai membentuk 2048.</p>' +
    '<div class="gm-facts"><span><b>4×4</b>papan</span><span><b>2048</b>tile target</span><span><b>+' + nf.format(rw[keys[keys.length - 1]]) + '</b>coin maksimal</span></div>' +
    '<ol class="gm-how"><li>Geser papan (atau pakai tombol panah / WASD) ke segala arah.</li><li>Dua tile dengan angka sama bergabung jadi dua kali lipat.</li><li>Tiap tile target yang baru tercapai memberi coin, sekali per permainan.</li></ol>' +
    (resume ? '<p class="gm-resume">Ada permainan yang belum selesai (skor ' + nf.format(g.score) + ').</p>' : '') +
    '<button class="gm-btn full" type="button" data-act="' + (resume ? 'g48-play' : 'g48-new') + '">' + (resume ? 'Lanjutkan' : g ? 'Main lagi' : 'Mulai') + '</button>' + msgHtml() + '</div></div>' + infoView();
}
function infoView() {
  const g = game(), d = st.daily, rw = st.cfg.rewards, capped = d.coins >= d.cap;
  return '<div class="gm-info"><h3>Hadiah tile' + lvChip(st && st.mul) + '</h3><div class="gm-rw">' + Object.entries(rw).map(([t, c]) =>
    '<div' + (g && g.max >= Number(t) ? ' class="g48-got"' : '') + '>Tile ' + nf.format(t) + '<b><img src="/coin.svg" alt="">' + nf.format(c) + '</b></div>').join('') + '</div>' +
    '<p class="gm-cap">' + (capped ? 'Batas coin hari ini sudah tercapai (' + nf.format(d.coins) + '/' + nf.format(d.cap) + '). Kamu tetap bisa main buat skor, hadiah kembali besok pukul 00.00 WIB.'
      : 'Maksimal ' + nf.format(d.cap) + ' coin dari 2048 per hari (sekarang ' + nf.format(d.coins) + '/' + nf.format(d.cap) + '). Hari berganti pukul 00.00 WIB.') + '</p></div>';
}
function gameView() {
  const g = game(), best = Math.max(st.best || 0, g.score);
  return '<button class="gm-back" type="button" data-act="hub">' + BACK + 'Semua game</button><div class="gm-panel g48-panel">' +
    '<div class="g48-top"><div class="g48-box"><span>Skor</span><b id="g48s">' + nf.format(shown) + '</b></div><div class="g48-box"><span>Terbaik</span><b id="g48r">' + nf.format(best) + '</b></div>' +
    '<button class="gm-ghost g48-newb" type="button" data-act="g48-ask" id="g48n">' + (armNew ? 'Yakin? Tap lagi' : 'Game baru') + '</button></div>' +
    boardHtml() + '<div id="g48m">' + msgHtml() + '</div><p class="gm-hint g48-help">Geser papan atau pakai tombol panah. Papan tidak bergerak kalau geserannya tidak mengubah apa pun.</p></div>' + infoView();
}

function render() {
  const h = host(); if (!h || !on) return;
  if (lock && h.querySelector('#g48t')) return;              // animasi berjalan: jangan hancurkan DOM
  if (!st) {
    h.innerHTML = '<button class="gm-back" type="button" data-act="hub">' + BACK + 'Semua game</button><div class="gm-panel"><h2>2048</h2><p class="gm-hint">' + esc(failed || 'Memuat…') + '</p>' +
      (failed ? '<button class="gm-btn full" type="button" data-act="g48-retry">Coba lagi</button>' : '') + '</div>';
    return;
  }
  if (intro || !game()) { h.innerHTML = introView(); return; }
  h.innerHTML = gameView();
}

/* ---------- Server ---------- */
async function call(path, data) {
  const r = await aApi('g2048' + path, data || {});
  if (!r || !r.ok) throw new Error('Gagal memuat 2048.');
  st = r; failed = ''; saveWallet(r);
  if (Array.isArray(r.nq)) { if (window.LEVEL) LEVEL.nq(r.nq); (window.LEVEL ? LEVEL.rest(r.nq) : r.nq).forEach((t, i) => setTimeout(() => toast(t), 500 + i * 2300)); } /* catatan level-up jadi toast level (level.js) */
  return r;
}
async function load() {
  try { await call(''); } catch (e) { failed = e && e.status === 401 ? '' : (e && e.message) || 'Tidak bisa terhubung ke server.'; }
  if (game()) { syncTiles(); shown = game().score; wonOpen = false; wonSeen = !!game().won; }
  render();
}
async function newGame() {
  if (lock) return;
  lock = true; msg = ['', '']; clearTimeout(armNew); armNew = 0;
  try { await call('/start'); syncTiles(); shown = 0; wonOpen = false; wonSeen = false; intro = false; }
  catch (e) { msg = [(e && e.message) || 'Gagal memulai, coba lagi.', 'err']; }
  lock = false; render();
}

/* ---------- Geser ---------- */
function paintMeta() {
  const g = game(); if (!g) return;
  const s = $('g48s'), r = $('g48r'), o = $('g48o'), m = $('g48m');
  if (s) s.textContent = nf.format(shown);
  if (r) r.textContent = nf.format(Math.max(st.best || 0, shown));
  if (o) o.innerHTML = overlayHtml();
  if (m) m.innerHTML = msgHtml();
}
function floatScore(add) {
  const box = $('g48s'); if (!box || !add || reduce()) return;
  const f = document.createElement('i'); f.className = 'g48-plus'; f.textContent = '+' + nf.format(add);
  box.parentNode.appendChild(f); setTimeout(() => f.remove(), 700);
}
function placeTile(t) { const el = $('g48t') && $('g48t').querySelector('[data-id="' + t.id + '"]'); if (el) { el.style.setProperty('--r', t.r); el.style.setProperty('--c', t.c); } return el; }

async function move(d) {
  const g = game();
  if (!on || intro || !g || !g.active || !$('g48t')) return;
  if (lock) { pending = d; return; }
  const sim = simulate(d);
  if (!sim.moved) { const b = $('g48b'); if (b && !reduce()) { b.classList.remove('shake'); void b.offsetWidth; b.classList.add('shake'); } return; }
  lock = true; msg = ['', ''];
  // 1) animasi geser seketika (tanpa menunggu server)
  sim.moves.forEach(m => { m.t.r = m.r; m.t.c = m.c; placeTile(m.t); });
  shown += sim.score; paintMeta(); floatScore(sim.score);
  const req = call('/move', { d }).then(r => ({ r }), e => ({ e }));
  await sleep(reduce() ? 0 : SLIDE_MS);
  // 2) tile yang bergabung: yang terserap dibuang, yang bertahan berlipat ganda
  const layer = $('g48t');
  sim.merges.forEach(({ keep, gone }) => {
    const ge = layer && layer.querySelector('[data-id="' + gone.id + '"]'); if (ge) ge.remove();
    tiles = tiles.filter(t => t !== gone);
    keep.v *= 2;
    const ke = layer && layer.querySelector('[data-id="' + keep.id + '"] .g48-v');
    if (ke) { ke.textContent = keep.v; ke.className = 'g48-v ' + valCls(keep.v) + sizeCls(keep.v) + ' pop'; }
  });
  // 3) jawaban server: tile baru + skor resmi
  const res = await req;
  if (res.e) { // gagal / ditolak: ikut keadaan server
    const e = res.e;
    msg = [e.status === 429 ? 'Terlalu cepat, tunggu sebentar.' : (e.message || 'Gagal mengirim geseran.'), 'err'];
    pending = ''; lock = false;
    try { await call(''); } catch {}
    syncTiles(); if (game()) shown = game().score;
    render(); return;
  }
  const r = res.r, sp = r.spawn;
  if (sp) { const t = { id: nid++, v: sp.v, r: sp.r, c: sp.c }; tiles.push(t); if (layer) layer.insertAdjacentHTML('beforeend', tileHtml(t, 'new')); }
  const sg = r.game;
  if (JSON.stringify(boardOf()) !== JSON.stringify(sg.b)) { // papan lokal menyimpang dari server: tampilkan versi server
    pending = ''; lock = false; syncTiles(); shown = sg.score; render(); return;
  }
  shown = sg.score;
  if (r.gain && r.gain.length) {
    const tot = r.gain.reduce((a, x) => a + x.coin, 0);
    msg = ['Tile ' + r.gain.map(x => nf.format(x.tile)).join(' & ') + ' tercapai! +' + nf.format(tot) + ' coin', 'ok'];
  } else if (r.capped) msg = ['Batas coin harian tercapai, hadiah kembali besok pukul 00.00 WIB.', ''];
  if (sg.won && !wonSeen) { wonOpen = true; }
  paintMeta();
  const info = host() && host().querySelector('.gm-info'); if (info) info.outerHTML = infoView(); // tabel hadiah + batas harian ikut baru
  lock = false;
  if (sg.over) { pending = ''; return; }
  if (pending) { const p = pending; pending = ''; move(p); }
}

/* ---------- Masukan: keyboard & swipe ---------- */
const KEYS = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', w: 'up', s: 'down', a: 'left', d: 'right', W: 'up', S: 'down', A: 'left', D: 'right' };
window.addEventListener('keydown', e => {
  if (!on || intro || app.dataset.tab !== 'games' || e.ctrlKey || e.metaKey || e.altKey) return;
  const el = e.target; if (el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable)) return;
  const sm = $('smodal'); if (sm && !sm.classList.contains('hide')) return;
  const d = KEYS[e.key]; if (!d) return;
  e.preventDefault(); move(d);
});
let sw = null;
document.addEventListener('pointerdown', e => {
  if (!on || e.button > 0) return;
  const b = e.target.closest && e.target.closest('#g48b'); if (!b || e.target.closest('.g48-ov')) return;
  sw = { x: e.clientX, y: e.clientY, id: e.pointerId };
});
const swEnd = e => {
  if (!sw || e.pointerId !== sw.id) return;
  const dx = e.clientX - sw.x, dy = e.clientY - sw.y; sw = null;
  if (e.type === 'pointercancel') return;
  const ax = Math.abs(dx), ay = Math.abs(dy);
  if (Math.max(ax, ay) < 24) return;
  move(ax > ay ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up'));
};
document.addEventListener('pointerup', swEnd);
document.addEventListener('pointercancel', swEnd);

/* ---------- Klik ---------- */
document.addEventListener('click', e => {
  const b = e.target.closest && e.target.closest('[data-act^="g48-"]'); if (!b || !on || b.disabled) return;
  const a = b.dataset.act;
  if (a === 'g48-new') { intro = false; newGame(); }
  else if (a === 'g48-play') { intro = false; msg = ['', '']; render(); }
  else if (a === 'g48-retry') { failed = ''; render(); load(); }
  else if (a === 'g48-go') { wonOpen = false; wonSeen = true; paintMeta(); }
  else if (a === 'g48-ask') { // konfirmasi dua-tap supaya permainan berjalan tidak hilang karena salah sentuh
    const g = game();
    if (!g || !g.active || g.moves === 0) { newGame(); return; }
    if (!armNew) { armNew = setTimeout(() => { armNew = 0; const n = $('g48n'); if (n) n.textContent = 'Game baru'; }, 2600); b.textContent = 'Yakin? Tap lagi'; }
    else { clearTimeout(armNew); armNew = 0; newGame(); }
  }
});

/* ---------- API publik (games.js) ---------- */
function enter() {
  on = true; intro = true; msg = ['', '']; lock = false; pending = '';
  if (failed) st = null;
  render(); load();
}
function leave() { on = false; lock = false; pending = ''; clearTimeout(armNew); armNew = 0; sw = null; }
window.addEventListener('shell:tab', e => { if (e.detail !== 'games') leave(); });
window.addEventListener('acct', () => { st = null; });
window.G2048 = { enter, leave, active: () => on, render() { render(); } };
})();
