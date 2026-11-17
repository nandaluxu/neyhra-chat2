/* ===== Minigame Word Search (tab Minigame, layar 'ws') =====
   Dimuat setelah games.js. Papan, posisi kata, waktu, petunjuk, dan hadiah diputuskan SERVER (lib/wordsearch.js) lewat /api/auth/ws*;
   file ini hanya menampilkan dan mengirim garis yang dipilih pemain. Kata-katanya sendiri datang dari data/wordS.json (dibaca server).

   Memilih kata: seret dari huruf pertama ke huruf terakhir (garis otomatis menempel ke 8 arah), ATAU ketuk huruf pertama lalu ketuk huruf terakhir.
   Timer: server yang menghitung. Client hanya menjalankan jam lokal dari angka terakhir server supaya angkanya berjalan mulus.
   Jeda otomatis saat pemain keluar dari layar / tab disembunyikan (supaya waktu tidak jalan selagi tidak bermain).

   Dipanggil games.js: WSRCH.enter() (buka layar), WSRCH.render(body) (gambar ulang), WSRCH.leave() (pulang ke hub / keluar tab).
   Kelas CSS berprefix ws-, aksi data-act berprefix ws- (handler klik games.js mengabaikannya).
   Global index.html yang dipakai: aApi, toast, saveWallet. */
(() => {
'use strict';
const $ = id => document.getElementById(id);
const app = $('app');
const nf = new Intl.NumberFormat('id-ID');
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const host = () => $('gmbody');
const ls = { get: k => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };

const I = {
  game: '<svg viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5L21 21M8 10.5h5"/></svg>',
  back: '<svg viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6"/></svg>',
  letter: '<svg viewBox="0 0 24 24"><path d="M5 19l7-14 7 14M8.5 14h7"/></svg>',
  word: '<svg viewBox="0 0 24 24"><path d="M4 7h16M4 12h10M4 17h13"/></svg>',
  pause: '<svg viewBox="0 0 24 24"><path d="M9 6v12M15 6v12"/></svg>',
  play: '<svg viewBox="0 0 24 24"><path d="M8 5.5l10 6.5-10 6.5z"/></svg>',
  on: '<svg viewBox="0 0 24 24"><path d="M4 10v4h4l5 4V6L8 10H4zM16.5 9a4 4 0 010 6"/></svg>',
  off: '<svg viewBox="0 0 24 24"><path d="M4 10v4h4l5 4V6L8 10H4zM17 9.5l4 5M21 9.5l-4 5"/></svg>',
  again: '<svg viewBox="0 0 24 24"><path d="M20 12a8 8 0 11-2.4-5.7M20 4v5h-5"/></svg>',
  menu: '<svg viewBox="0 0 24 24"><path d="M5 12h13M12 6l-6 6 6 6"/></svg>'
};

let on = false;            // layar Word Search sedang dibuka
let intro = true;          // true = layar pembuka (aturan + tombol), false = papan
let st = null;             // keadaan terakhir dari server { cfg, daily, best, game, coins, gems }
let failed = '';           // pesan kalau gagal memuat
let busy = false;          // ada permintaan yang sedang berjalan
let msg = ['', ''];        // [teks, kelas] di bawah papan
let armNew = 0;            // konfirmasi dua-tap "Puzzle baru"
let sound = ls.get('wsSound') !== '0';
let clock = { base: 0, at: 0, run: false };
let tick = 0;
let drag = null;           // { a, b, id, moved } seretan yang sedang berjalan
let anchor = null;         // { r, c } huruf pertama yang diketuk (mode ketuk-ketuk)
let fresh = '';            // kata yang baru ketemu (untuk animasi garis)

const game = () => (st && st.game) || null;
const live = () => { const g = game(); return !!(g && g.active); };
const reduce = () => !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);

/* ---------- Waktu ---------- */
const fmt = ms => {
  const s = Math.max(0, Math.floor(ms / 1000)), h = (s / 3600) | 0, m = ((s % 3600) / 60) | 0, x = s % 60, p = n => String(n).padStart(2, '0');
  return (h ? p(h) + ':' : '') + p(m) + ':' + p(x);
};
const nowMs = () => clock.base + (clock.run ? performance.now() - clock.at : 0);
function setClock() {
  const g = game();
  clock = g ? { base: g.ms + g.pen, at: performance.now(), run: g.active && !g.paused } : { base: 0, at: 0, run: false };
  clearInterval(tick); tick = 0;
  paintClock();
  if (on && clock.run) tick = setInterval(paintClock, 250);
}
function paintClock() { const t = $('wst'); if (t) t.textContent = fmt(nowMs()); }

/* ---------- Suara (WebAudio, tanpa file) ---------- */
let ac = null;
function beep(seq) {
  if (!sound) return;
  try {
    ac ||= new (window.AudioContext || window.webkitAudioContext)();
    if (ac.state === 'suspended') ac.resume();
    let t = ac.currentTime + 0.01;
    seq.forEach(([f, d, v, type]) => {
      const o = ac.createOscillator(), g = ac.createGain();
      o.type = type || 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(v || 0.12, t + 0.015); g.gain.exponentialRampToValueAtTime(0.0001, t + d);
      o.connect(g); g.connect(ac.destination); o.start(t); o.stop(t + d + 0.02); t += d * 0.8;
    });
  } catch {}
}
const SFX = {
  hit: () => beep([[660, .09], [880, .14]]),
  miss: () => beep([[200, .12, .09, 'triangle']]),
  hint: () => beep([[520, .07, .08], [520, .07, .08]]),
  win: () => beep([[523, .12], [659, .12], [784, .12], [1047, .26]])
};

/* ---------- Gambar ---------- */
const msgHtml = () => '<p class="gm-msg' + (msg[1] ? ' ' + msg[1] : '') + '" id="wsm" role="status">' + esc(msg[0]) + '</p>';

function introView() {
  const g = game(), c = st.cfg, R = c.reward, resume = !!(g && g.active);
  return '<button class="gm-back" type="button" data-act="hub">' + I.back + 'Semua game</button><div class="gm-panel"><div class="gm-intro"><span class="ic">' + I.game + '</span><h2>Word Search</h2>' +
    '<p class="gm-hint">Temukan semua kata yang tersembunyi di dalam papan huruf, secepat mungkin.</p>' +
    '<div class="gm-facts"><span><b>' + c.size + '×' + c.size + '</b>papan</span><span><b>' + c.words + '</b>kata</span><span><b>+' + nf.format(R.base) + '</b>coin maksimal</span></div>' +
    '<ol class="gm-how"><li>Cari kata dari daftar. Kata bisa mendatar, menurun, atau miring, ke arah mana pun, termasuk terbalik.</li><li>Seret dari huruf pertama ke huruf terakhir, atau ketuk keduanya satu per satu.</li><li>Makin cepat selesai, makin besar hadiahnya. Buka huruf atau kata kalau buntu, tapi waktumu bertambah.</li></ol>' +
    (resume ? '<p class="gm-resume">Ada puzzle yang belum selesai (' + g.found + '/' + g.total + ' kata).</p>' : '') +
    (st.best ? '<p class="gm-resume">Waktu terbaikmu ' + fmt(st.best) + '</p>' : '') +
    '<button class="gm-btn full" type="button" data-act="' + (resume ? 'ws-play' : 'ws-new') + '">' + (resume ? 'Lanjutkan' : g ? 'Main lagi' : 'Mulai') + '</button>' + msgHtml() + '</div></div>' + infoView();
}
function infoView() {
  const d = st.daily, R = st.cfg.reward, capped = d.wins >= d.cap;
  return '<div class="gm-info"><h3>Hadiah</h3><p class="gm-cap">Selesai dalam ' + R.freeSec + ' detik atau kurang dapat ' + nf.format(R.base) + ' coin. Setelah itu hadiah turun ' + String(R.perSec).replace('.', ',') + ' coin tiap detik, paling sedikit ' + nf.format(R.min) + ' coin. ' +
    'Buka huruf menambah ' + st.cfg.hintLetterSec + ' detik, buka kata menambah ' + st.cfg.hintWordSec + ' detik ke waktumu. ' +
    (capped ? 'Batas hadiah hari ini sudah tercapai (' + d.wins + '/' + d.cap + '). Kamu tetap bisa main, hadiah kembali besok pukul 00.00 WIB.' : 'Maksimal ' + d.cap + ' kemenangan berhadiah per hari (sekarang ' + d.wins + '/' + d.cap + '), hari berganti pukul 00.00 WIB.') + '</p></div>';
}

function linesHtml(g) {
  let out = '';
  g.words.forEach(w => {
    if (!w.found || !w.at) return;
    const [r, c, dr, dc] = w.at, e = w.w.length - 1;
    out += '<line class="ws-fl' + (w.revealed ? ' rv' : '') + (fresh === w.w ? ' new' : '') + '" x1="' + (c + .5) + '" y1="' + (r + .5) + '" x2="' + (c + dc * e + .5) + '" y2="' + (r + dr * e + .5) + '"/>';
  });
  return out + '<line id="wssel" class="ws-sl" x1="0" y1="0" x2="0" y2="0" visibility="hidden"/>';
}
function overlayHtml(g) {
  if (g.over) {
    return '<div class="ws-ov" role="dialog" aria-label="Puzzle selesai"><h3>Selesai!</h3><p>Waktumu ' + fmt(g.ms + g.pen) + (g.pen ? ' (termasuk +' + Math.round(g.pen / 1000) + ' detik petunjuk)' : '') + (g.newBest ? ' · rekor baru!' : '') + '</p>' +
      (g.reward ? '<div class="gm-prize"><img src="/coin.svg" alt="">+' + nf.format(g.reward) + ' coin</div>' : g.capped ? '<p class="ws-ovnote">Batas hadiah harian sudah tercapai.</p>' : '') +
      '<button class="gm-btn" type="button" data-act="ws-new">Main lagi</button></div>';
  }
  if (g.paused) return '<div class="ws-ov" role="dialog" aria-label="Permainan dijeda"><h3>Dijeda</h3><p>Waktu berhenti. Papan disembunyikan selama jeda.</p><button class="gm-btn" type="button" data-act="ws-pause">Lanjut main</button></div>';
  return '';
}
function boardHtml(g) {
  const n = g.n, hint = new Set(g.marks.map(m => m[0] * n + m[1]));
  let cells = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) cells += '<b' + (hint.has(r * n + c) ? ' class="hint"' : '') + '>' + esc(g.rows[r][c]) + '</b>';
  return '<div class="ws-board' + (g.paused ? ' paused' : '') + (g.over ? ' over' : '') + '" id="wsb" style="--n:' + n + '" tabindex="0" aria-label="Papan Word Search. Seret dari huruf pertama ke huruf terakhir sebuah kata.">' +
    '<svg class="ws-lines" viewBox="0 0 ' + n + ' ' + n + '" aria-hidden="true">' + linesHtml(g) + '</svg><div class="ws-grid">' + cells + '</div><div id="wso">' + overlayHtml(g) + '</div></div>';
}
function wordsHtml(g) {
  return '<aside class="ws-words" aria-label="Daftar kata"><h3>Kata <span>' + g.found + '/' + g.total + '</span></h3><ul>' +
    g.words.map(w => '<li class="' + (w.found ? 'got' : '') + (w.revealed ? ' rv' : '') + '">' + esc(w.w) + '</li>').join('') + '</ul></aside>';
}
function timeHtml(g) {
  return '<div class="ws-time"><div><span>Waktu</span><b id="wst">' + fmt(nowMs()) + '</b></div><div><span>Terbaik</span><b class="sm">' + (st.best ? fmt(st.best) : '–') + '</b></div><div class="ws-cnt"><span>Kata</span><b class="sm">' + g.found + '/' + g.total + '</b></div></div>';
}
function actsHtml(g) {
  const act = g.active && !g.paused, left = g.total - g.found > 0;
  const btn = (a, ic, label, chip, extra) => '<button class="ws-btn' + (extra ? ' ' + extra : '') + '" type="button" data-act="ws-' + a + '"' + (extra === 'dis' ? ' disabled' : '') + '><i>' + ic + '</i><span>' + label + (chip ? '<small>' + chip + '</small>' : '') + '</span></button>';
  return '<div class="ws-acts">' +
    btn('hl', I.letter, 'Buka huruf', '+' + st.cfg.hintLetterSec + ' dtk', act && left ? '' : 'dis') +
    btn('hw', I.word, 'Buka kata', '+' + st.cfg.hintWordSec + ' dtk', act && left ? '' : 'dis') +
    btn('pause', g.paused ? I.play : I.pause, g.paused ? 'Lanjut' : 'Jeda', '', g.active ? (g.paused ? 'on' : '') : 'dis') +
    btn('snd', sound ? I.on : I.off, 'Suara', sound ? 'nyala' : 'mati', '') +
    btn('ask', I.again, armNew ? 'Yakin? Tap lagi' : 'Puzzle baru', '', '') +
    '<button class="ws-btn" type="button" data-act="hub"><i>' + I.menu + '</i><span>Menu</span></button></div>';
}
function gameView() {
  const g = game();
  return '<div class="ws-cq"><div class="ws-wrap" id="wsw">' + timeHtml(g) + '<div class="ws-stage">' + boardHtml(g) + msgHtml() + '</div>' + wordsHtml(g) + actsHtml(g) + '</div></div>';
}

function render() {
  const h = host(); if (!h || !on) return;
  const g = $('games'); if (g) g.classList.toggle('ws-on', !!(st && !intro && game()));
  if (!st) {
    h.innerHTML = '<button class="gm-back" type="button" data-act="hub">' + I.back + 'Semua game</button><div class="gm-panel"><h2>Word Search</h2><p class="gm-hint">' + esc(failed || 'Memuat…') + '</p>' +
      (failed ? '<button class="gm-btn full" type="button" data-act="ws-retry">Coba lagi</button>' : '') + '</div>';
    return;
  }
  if (intro || !game()) { h.innerHTML = introView(); return; }
  h.innerHTML = gameView();
}

/* ---------- Server ---------- */
async function call(path, data) {
  const r = await aApi('ws' + path, data || {});
  if (!r || !r.ok) throw new Error((r && r.error) || 'Gagal memuat Word Search.');
  st = r; failed = ''; saveWallet(r);
  if (Array.isArray(r.nq)) r.nq.forEach((t, i) => setTimeout(() => toast(t), 500 + i * 2300));
  return r;
}
async function load() {
  try { await call(''); } catch (e) { failed = e && e.status === 401 ? '' : (e && e.message) || 'Tidak bisa terhubung ke server.'; }
  setClock(); render();
}
async function newGame() {
  if (busy) return;
  busy = true; msg = ['', '']; clearTimeout(armNew); armNew = 0; anchor = null;
  try { await call('/start'); intro = false; fresh = ''; }
  catch (e) { msg = [(e && e.message) || 'Gagal memulai, coba lagi.', 'err']; }
  busy = false; setClock(); render();
}

/* ---------- Memilih kata ---------- */
const N = () => (game() ? game().n : 10);
function cellAt(e, clamp) {
  const grid = $('wsb') && $('wsb').querySelector('.ws-grid'); if (!grid) return null;
  const b = grid.getBoundingClientRect(), n = N();
  let c = Math.floor((e.clientX - b.left) / b.width * n), r = Math.floor((e.clientY - b.top) / b.height * n);
  if (!clamp && (c < 0 || r < 0 || c >= n || r >= n)) return null;
  return { r: Math.min(n - 1, Math.max(0, r)), c: Math.min(n - 1, Math.max(0, c)) };
}
function snap(a, p) { // tempelkan garis ke salah satu dari 8 arah
  const dr = p.r - a.r, dc = p.c - a.c;
  if (!dr && !dc) return a;
  const k = Math.round(Math.atan2(dr, dc) / (Math.PI / 4)), sr = Math.round(Math.sin(k * Math.PI / 4)), sc = Math.round(Math.cos(k * Math.PI / 4));
  let L = Math.round((dr * sr + dc * sc) / (sr * sr + sc * sc)); const n = N();
  while (L > 0 && (a.r + sr * L < 0 || a.r + sr * L >= n || a.c + sc * L < 0 || a.c + sc * L >= n)) L--;
  return { r: a.r + sr * L, c: a.c + sc * L };
}
function paintSel(a, b, bad) {
  const s = $('wssel'); if (!s) return;
  if (!a) { s.setAttribute('visibility', 'hidden'); s.classList.remove('bad'); return; }
  s.setAttribute('x1', a.c + .5); s.setAttribute('y1', a.r + .5); s.setAttribute('x2', b.c + .5); s.setAttribute('y2', b.r + .5);
  s.setAttribute('visibility', 'visible'); s.classList.toggle('bad', !!bad);
}
async function submit(a, b) {
  if (busy || !live() || game().paused) { paintSel(null); return; }
  if (a.r === b.r && a.c === b.c) { paintSel(null); return; }
  busy = true; msg = ['', ''];
  try {
    const r = await call('/select', { a: [a.r, a.c], b: [b.r, b.c] });
    if (r.hit) {
      fresh = r.word; msg = [r.game.over ? '' : 'Ketemu: ' + r.word, 'ok'];
      if (r.game.over) SFX.win(); else SFX.hit();
      busy = false; anchor = null; setClock(); render(); return;
    }
    SFX.miss(); paintSel(a, b, true);
    setTimeout(() => { if (!anchor && !drag) paintSel(null); }, 340);
  } catch (e) {
    msg = [e.status === 429 ? 'Terlalu cepat, tunggu sebentar.' : (e.message || 'Gagal mengirim pilihan.'), 'err'];
    try { await call(''); } catch {}
    setClock(); render();
  }
  busy = false;
}
document.addEventListener('pointerdown', e => {
  if (!on || intro || e.button > 0) return;
  const b = e.target.closest && e.target.closest('#wsb'); if (!b || e.target.closest('.ws-ov')) return;
  if (!live() || game().paused || busy) return;
  const p = cellAt(e, false); if (!p) return;
  if (anchor) { // mode ketuk-ketuk: ketukan kedua menentukan huruf terakhir
    const a = anchor;
    if (a.r === p.r && a.c === p.c) { anchor = null; paintSel(null); return; }
    anchor = null; submit(a, snap(a, p)); return;
  }
  drag = { a: p, b: p, id: e.pointerId, moved: false };
  try { b.setPointerCapture(e.pointerId); } catch {}
  paintSel(p, p);
});
document.addEventListener('pointermove', e => {
  if (!drag || e.pointerId !== drag.id) return;
  const p = cellAt(e, true); if (!p) return;
  const b = snap(drag.a, p);
  if (b.r !== drag.b.r || b.c !== drag.b.c) { drag.b = b; drag.moved = b.r !== drag.a.r || b.c !== drag.a.c; paintSel(drag.a, b); }
});
const dragEnd = e => {
  if (!drag || e.pointerId !== drag.id) return;
  const d = drag; drag = null;
  if (e.type === 'pointercancel') { paintSel(null); return; }
  if (d.moved) submit(d.a, d.b);
  else { anchor = { r: d.a.r, c: d.a.c }; paintSel(anchor, anchor); } // ketukan biasa: tandai huruf pertama, tunggu ketukan kedua
};
document.addEventListener('pointerup', dragEnd);
document.addEventListener('pointercancel', dragEnd);
window.addEventListener('keydown', e => { if (e.key === 'Escape' && anchor) { anchor = null; paintSel(null); } });

/* ---------- Tombol ---------- */
async function hint(kind) {
  if (busy || !live() || game().paused) return;
  busy = true;
  try {
    const r = await call('/hint', { kind });
    if (kind === 'word') { fresh = r.hint.word; msg = [r.hint.word + ' dibuka (+' + st.cfg.hintWordSec + ' dtk)', ''] ; if (r.game.over) SFX.win(); else SFX.hint(); }
    else { msg = ['Satu huruf dibuka (+' + st.cfg.hintLetterSec + ' dtk)', '']; SFX.hint(); }
    anchor = null;
  } catch (e) { msg = [e.message || 'Gagal membuka petunjuk.', 'err']; }
  busy = false; setClock(); render();
}
async function pause(wantOn, quiet) {
  if (!live() || busy) return;
  const g = game(); if (wantOn === undefined) wantOn = !g.paused;
  if (wantOn === g.paused) return;
  busy = true; anchor = null; drag = null;
  try { await call('/pause', { on: wantOn }); msg = ['', '']; }
  catch (e) { if (!quiet) msg = [e.message || 'Gagal mengubah jeda.', 'err']; }
  busy = false; setClock(); render();
}
document.addEventListener('click', e => {
  const b = e.target.closest && e.target.closest('[data-act^="ws-"]'); if (!b || !on || b.disabled) return;
  const a = b.dataset.act;
  if (a === 'ws-new') { intro = false; newGame(); }
  else if (a === 'ws-play') { intro = false; msg = ['', '']; setClock(); render(); }
  else if (a === 'ws-retry') { failed = ''; render(); load(); }
  else if (a === 'ws-hl') hint('letter');
  else if (a === 'ws-hw') hint('word');
  else if (a === 'ws-pause') pause();
  else if (a === 'ws-snd') { sound = !sound; ls.set('wsSound', sound ? '1' : '0'); if (sound) SFX.hint(); render(); }
  else if (a === 'ws-ask') { // konfirmasi dua-tap supaya puzzle berjalan tidak hilang karena salah sentuh
    const g = game();
    if (!g || !g.active || g.found === 0) { newGame(); return; }
    if (!armNew) { armNew = setTimeout(() => { armNew = 0; render(); }, 2600); render(); }
    else { clearTimeout(armNew); armNew = 0; newGame(); }
  }
});

/* ---------- API publik (games.js) ---------- */
function enter() {
  on = true; intro = true; msg = ['', '']; busy = false; anchor = null; drag = null;
  if (failed) st = null;
  render(); load();
}
function leave() {
  if (on && live() && !game().paused) pauseQuiet();
  on = false; busy = false; anchor = null; drag = null; clearTimeout(armNew); armNew = 0;
  clearInterval(tick); tick = 0;
  const g = $('games'); if (g) g.classList.remove('ws-on');
}
function pauseQuiet() { // jeda tanpa menunggu: dipakai saat keluar layar / tab disembunyikan
  const g = game(); if (!g || !g.active || g.paused) return;
  g.paused = true; g.ms = Math.max(0, nowMs() - g.pen); clock.run = false;
  aApi('ws/pause', { on: true }).then(r => { if (r && r.ok) st = r; }).catch(() => {});
}
document.addEventListener('visibilitychange', () => { if (document.hidden && on && !intro && live() && !game().paused) { pauseQuiet(); setClock(); render(); } });
window.addEventListener('shell:tab', e => { if (e.detail !== 'games') leave(); });
window.addEventListener('acct', () => { st = null; });
window.WSRCH = { enter, leave, active: () => on, render() { render(); } };
})();
