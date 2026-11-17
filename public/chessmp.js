/* ===== Catur Multiplayer — layar 'chessmp' (tab Minigame, dipanggil games.js) =====
   Kontrak API: CHESS_FRONTEND_SPEC.md (POST /api/auth/mp/*, 14 endpoint). Frontend TIDAK memvalidasi
   aturan catur — semua legalitas diputuskan server; data `moves` dari server hanya untuk highlight.
   Dipanggil games.js: CHMP.enter() (buka layar), CHMP.render(body) (gambar ulang), CHMP.leave()
   (pulang ke hub: hentikan polling & timer). Semua kelas CSS baru berprefix cm- (papan memakai kelas
   .ch-* dari games.css yang bentuk datanya identik). Aksi modul ini memakai atribut data-cm, bukan
   data-act, supaya handler klik games.js mengabaikannya (pola yang sama dengan slot.js).
   Global index.html yang dipakai: atok, aOn, aApi, app, toast, store, copyText. */

(() => {
'use strict';
const $ = id => document.getElementById(id);
const host = () => $('gmbody');
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const reduceMo = () => !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
const vibrate = n => { if (navigator.vibrate) try { navigator.vibrate(n) } catch {} };
const inTab = () => app.dataset.tab === 'games';

/* ---------- konstanta catur (pola dari games.js game vs AI) ---------- */
const CH_G = { k: '\u265A\uFE0E', q: '\u265B\uFE0E', r: '\u265C\uFE0E', b: '\u265D\uFE0E', n: '\u265E\uFE0E', p: '\u265F\uFE0E' };
const CH_NAME = { k: 'raja', q: 'ratu', r: 'benteng', b: 'gajah', n: 'kuda', p: 'pion' };
const CH_VAL = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
const isW = p => p >= 'A' && p <= 'Z';
const sqName = i => 'abcdefgh'[i & 7] + (8 - (i >> 3));
const uci2sq = u => [(8 - Number(u[1])) * 8 + (u.charCodeAt(0) - 97), (8 - Number(u[3])) * 8 + (u.charCodeAt(2) - 97)];
const REASONS = { mate: 'skakmat', stale: 'pat', '50': 'aturan 50 langkah', rep: 'pengulangan posisi 3x', material: 'material tidak cukup', agreement: 'kesepakatan', resign: 'menyerah', abort: 'dibatalkan' };
const LABELS = [
  { k: 'best', n: 'Best' }, { k: 'great', n: 'Great' }, { k: 'excellent', n: 'Excellent' },
  { k: 'mistake', n: 'Mistake' }, { k: 'miss', n: 'Miss' }, { k: 'blunder', n: 'Blunder' }
];
const SVG = {
  back: '<svg viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6"/></svg>',
  copy: '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 012-2h9"/></svg>',
  check: '<svg viewBox="0 0 24 24"><path d="M5 13l4 4 10-11"/></svg>',
  flip: '<svg viewBox="0 0 24 24"><path d="M3 12a9 9 0 0115.5-6.2M21 12a9 9 0 01-15.5 6.2M18 3v4h-4M6 21v-4h4"/></svg>',
  first: '<svg viewBox="0 0 24 24"><path d="M18 6l-6 6 6 6M7 5v14"/></svg>',
  prev: '<svg viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6"/></svg>',
  next: '<svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>',
  last: '<svg viewBox="0 0 24 24"><path d="M6 6l6 6-6 6M17 5v14"/></svg>',
  play: '<svg viewBox="0 0 24 24"><path d="M7 4l13 8-13 8z"/></svg>',
  pause: '<svg viewBox="0 0 24 24"><path d="M7 4h3.5v16H7zM13.5 4H17v16h-3.5z"/></svg>',
  bulb: '<svg viewBox="0 0 24 24"><path d="M9 18h6M10 21h4M12 3a6 6 0 00-4 10.5c.8.7 1 1.5 1 2.5h6c0-1 .2-1.8 1-2.5A6 6 0 0012 3z"/></svg>',
  flag: '<svg viewBox="0 0 24 24"><path d="M5 21V4m0 0h13l-2.5 4L18 12H5"/></svg>',
  half: '<svg viewBox="0 0 24 24"><path d="M12 3a9 9 0 109 9h-9z"/><path d="M12 3v9h9a9 9 0 00-9-9z" fill="currentColor" stroke="none" opacity=".45"/></svg>',
  hand: '<svg viewBox="0 0 24 24"><path d="M8 11V5.5a1.5 1.5 0 013 0V11m0-.5v-6a1.5 1.5 0 013 0V11m0-.5v-5a1.5 1.5 0 013 0V13c0 4-2.5 7-6.5 7S6 17.5 6 14v-3a1.5 1.5 0 013 0"/></svg>',
  chart: '<svg viewBox="0 0 24 24"><path d="M4 19V5m0 14h16M7 15l4-5 3 3 5-7"/></svg>',
  users: '<svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.5-3.5 3-5.5 6.5-5.5s6 2 6.5 5.5M16 5a3.5 3.5 0 010 6.6M17.5 14.7c2.3.7 3.8 2.5 4 5.3"/></svg>',
  tv: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="13" rx="2.5"/><path d="M10 21h4M8 9.5l3.5 2L8 13.5z"/></svg>'
};

/* ---------- API ---------- */
async function api(name, body) {
  const r = await aApi('mp/' + name, body || {});
  if (r && r.ok) return r;
  const e = new Error((r && r.error) || 'Kesalahan tak dikenal');
  e.status = 200; /* HTTP 200 tapi bukan ok: perlakukan seperti error server */
  throw e;
}

/* ---------- state modul ---------- */
let view = 'lobby';                 // 'lobby' | 'host' | 'game' | 'review' | 'replay' | 'stats'
let lobby = { games: null, page: 0, more: false, active: 0, loading: false, err: '' };
let room = null;                    // { code, color, ttlMin, createdAt }
let game = null;                    // state penuh dari /mp/game
let myPly = 0;                      // ply terakhir yang sudah diketahui (untuk sync)
let sel = -1;                       // kotak asal yang dipilih
let flip = false;                   // orientasi papan (default: aku di bawah)
let promo = null;                   // { from, to } menunggu pilihan bidak promosi
let hint = null;                    // { best, engine, evalCp, mate } hint aktif
let hintBusy = false;
let busyMove = false;               // request move sedang berjalan (jangan double-submit)
let msg = ['', ''];                 // [teks, kelas 'ok'|'err']
let drawShownFor = null;            // tawaran seri yang modalnya sudah pernah ditampilkan
let resultShown = false;            // modal hasil sudah ditutup untuk game ini
let resultAnim = '';                // id game yang animasi modalnya sudah diputar
let resCache = { id: '', loading: false, rv: null, rp: null, err: '' };   // analisis latar belakang untuk modal hasil
let gameFrom = 'lobby';             // asal saat membuka review/replay (tombol kembali)
let review = { loading: false, err: '', data: null, pos: null, ply: 0, gameId: '' };
let replay = { loading: false, err: '', data: null, idx: -1, playing: false, gameId: '' };
let stats = { loading: false, err: '', data: null, user: '' };
let drag = null;                    // drag & drop aktif
let pendingPaint = false;           // render ditunda sampai drag selesai
let resignArm = 0;
let lastTok = '';
let pollT = 0, pollGen = 0, pollFast = 0;      // polling sync
let roomT = 0, roomGen = 0, ttlT = 0;          // polling ruang + countdown
let autoT = 0;                                  // autoplay replay
let attached = false;

/* ---------- util kecil ---------- */
const legalOf = i => (game && game.moves && game.moves[i] && game.moves[i].length) ? game.moves[i] : null;
const canPlay = () => !!(game && game.status === 'active' && game.moves && game.yourTurn && !busyMove && !promo && view === 'game' && !drag);
const youName = () => (game && game.white && game.black) ? (game.you === 'w' ? game.white : game.black) : null;
const oppOf = () => (game && game.opp) ? game.opp : (game ? (game.you === 'w' ? game.black : game.white) : null);
const capStr = arr => arr.slice().sort((a, b) => CH_VAL[b.toLowerCase()] - CH_VAL[a.toLowerCase()]).map(p => CH_G[p.toLowerCase()]).join('');
const matVal = arr => arr.reduce((s, p) => s + CH_VAL[p.toLowerCase()], 0);
/* bidak tertangkap diturunkan dari isi papan (16 bidak awal - yang tersisa).
   Respons /mp/sync tidak memuat capsW/capsB, jadi penurunan ini menjaga baris tetap benar
   setelah langkah lawan; promosi pion pun tetap masuk hitungan (pionnya memang hilang). */
function deriveCaps(board) {
  const cnt = {};
  for (const ch of board) if (ch !== '.') cnt[ch] = (cnt[ch] || 0) + 1;
  const miss = (p, n) => Math.max(0, n - (cnt[p] || 0));
  const w = [], b = []; // w = bidak HITAM yang sudah ditangkap putih, b = bidak PUTIH yang ditangkap hitam
  for (const [p, n] of [['p', 8], ['n', 2], ['b', 2], ['r', 2], ['q', 1]]) for (let k = 0; k < miss(p, n); k++) w.push(p);
  for (const [p, n] of [['P', 8], ['N', 2], ['B', 2], ['R', 2], ['Q', 1]]) for (let k = 0; k < miss(p, n); k++) b.push(p);
  return { w, b };
}
function ago(ts) {
  if (!ts) return '';
  const d = new Date(ts), s = (Date.now() - d.getTime()) / 1000;
  if (s < 60) return 'baru saja';
  if (s < 3600) return Math.floor(s / 60) + ' mnt lalu';
  if (s < 86400) return Math.floor(s / 3600) + ' jam lalu';
  if (s < 172800) return 'kemarin';
  return d.toLocaleDateString('id-ID', { day: 'numeric', month: 'short' });
}
const initial = (name) => (name || '?').trim().charAt(0).toUpperCase() || '?';

/* ---------- render papan (kelas .ch-* dari games.css; indeks tetap absolut 0..63) ---------- */
function boardHtml(board, o) {
  o = o || {};
  const flipOn = !!o.flip;
  const ranks = flipOn ? [1, 2, 3, 4, 5, 6, 7, 8] : [8, 7, 6, 5, 4, 3, 2, 1];
  const files = flipOn ? 'hgfedcba'.split('') : 'abcdefgh'.split('');
  let h = '<div class="ch-bwrap cm-bwrap"><div class="ch-mid"><div class="ch-board cm-board" data-cm-board role="grid" aria-label="Papan catur">';
  const targets = o.targets || [];
  for (let g = 0; g < 64; g++) {
    const i = flipOn ? 63 - g : g;
    const p = board[i];
    const cls = ['ch-sq', ((i >> 3) + (i & 7)) % 2 ? 'ch-d' : 'ch-l'];
    if (o.last && (o.last.f === i || o.last.t === i)) cls.push('ch-last');
    if (o.sel === i) cls.push('ch-sel');
    if (o.check === i) cls.push('ch-chk');
    if (targets.includes(i)) cls.push(p !== '.' ? 'ch-cap' : 'ch-dot');
    const nm = p !== '.' ? CH_NAME[p.toLowerCase()] + ' ' + (isW(p) ? 'putih' : 'hitam') : 'kosong';
    h += '<button type="button" class="' + cls.join(' ') + '" data-cm-sq data-i="' + i + '" aria-label="' + sqName(i) + ', ' + nm + '"' + (o.interactive ? '' : ' disabled') + '>' +
      ((g & 7) === 0 ? '<i class="ch-co r" aria-hidden="true">' + ranks[g >> 3] + '</i>' : '') + ((g >> 3) === 7 ? '<i class="ch-co f" aria-hidden="true">' + files[g & 7] + '</i>' : '') + // koordinat mengikuti orientasi papan (g = urutan tampil)
      (p !== '.' ? '<span class="ch-p ' + (isW(p) ? 'ch-w' : 'ch-b') + '" aria-hidden="true">' + CH_G[p.toLowerCase()] + '</span>' : '') + '</button>';
  }
  h += (o.arrows || '') + '</div></div></div>';
  return h;
}

/* panah from -> to di atas papan (viewBox 8x8, ikut orientasi). Tipis & temaram supaya
   tetap terbaca tanpa menutupi bidak (pola lichess/chesscom). */
function arrowSvg(list) {
  const items = (list || []).filter(a => a && a.f != null && a.t != null && a.f !== a.t);
  if (!items.length) return '';
  const disp = i => flipNow() ? 63 - i : i;
  const cxy = i => [(disp(i) & 7) + .5, (disp(i) >> 3) + .5];
  let h = '<svg class="cm-arrow" viewBox="0 0 8 8" preserveAspectRatio="none" aria-hidden="true">';
  for (const a of items) {
    const [x1, y1] = cxy(a.f), [x2, y2] = cxy(a.t);
    const dx = x2 - x1, dy = y2 - y1, L = Math.hypot(dx, dy) || 1, ux = dx / L, uy = dy / L, px = -uy, py = ux;
    const col = a.color || '#2e7d46';
    const op = a.op || .55;
    h += '<line x1="' + (x1 + ux * .3) + '" y1="' + (y1 + uy * .3) + '" x2="' + (x2 - ux * .4) + '" y2="' + (y2 - uy * .4) + '" stroke="' + col + '" stroke-width=".16" stroke-linecap="round" opacity="' + op + '"/>' +
      '<polygon points="' + [x2 - ux * .08 + px * .17, y2 - uy * .08 + py * .17, x2 - ux * .42 + px * .17, y2 - uy * .42 + py * .17, x2 - ux * .25, y2 - uy * .25].join(' ') + '" fill="' + col + '" stroke="none" opacity="' + (op + .1) + '"/>';
  }
  return h + '</svg>';
}
const flipNow = () => (view === 'game' && game) ? ((game.you === 'b') !== flip) : !!flip;

/* ---------- daftar langkah SAN (penomoran aman untuk sans yang dipangkas 80 terakhir) ---------- */
function sanRowsHtml(sans, totalPly, selPly, withLabels, movesData) {
  const n = sans.length;
  if (!n) return '';
  const firstPly = (totalPly || n) - n + 1;
  const rows = [];
  let cur = null;
  for (let k = 0; k < n; k++) {
    const ply = firstPly + k;
    const lab = withLabels && movesData ? labelOf(movesData, ply) : null;
    const btn = '<button type="button" class="cm-mvbtn' + (selPly === ply ? ' on' : '') + '" data-cm="selmove" data-ply="' + ply + '">' +
      (lab ? '<span class="cm-lab ' + lab.k + '">' + (lab.k === 'best' ? '★' : lab.k === 'miss' ? '⚠' : '') + '</span>' : '') +
      '<span>' + esc(sans[k]) + '</span>' + (lab && lab.acc != null ? '<small>' + lab.acc.toFixed(0) + '</small>' : '') + '</button>';
    if (ply % 2 === 1) { cur = { no: (ply + 1) / 2, w: btn, b: '' }; rows.push(cur); }
    else if (cur) cur.b = btn;
    else rows.push({ no: (ply + 1) / 2, w: '', b: btn });
  }
  return rows.map(r => '<div class="cm-mvrow"><span class="no">' + r.no + '.</span>' + r.w + r.b + '</div>').join('');
}
function labelOf(movesData, ply) {
  const m = movesData && movesData.find ? movesData.find(x => x.ply === ply) : null;
  if (!m) return null;
  return { k: String(m.label || '').toLowerCase(), acc: m.acc };
}

/* ============================================================
   RENDER — dipanggil games.js tiap keadaan berubah
   ============================================================ */
function render() {
  if (!inTab()) return;
  if (drag) { pendingPaint = true; return; }
  const b = host();
  if (!b) return;
  const gm = $('games'); if (gm) gm.classList.toggle('ch-ingame', view === 'game' || view === 'review' || view === 'replay'); // HP: header Minigame disembunyikan agar papan tampil utuh
  b.innerHTML = view === 'game' ? gameScreen()
    : view === 'host' ? hostScreen()
    : view === 'review' ? reviewScreen()
    : view === 'replay' ? replayScreen()
    : view === 'stats' ? statsScreen()
    : lobbyScreen();
  afterPaint();
}

function afterPaint() {
  const b = host();
  if (view === 'game') {
    const ml = b.querySelector('.cm-mvl');
    if (ml) ml.scrollTop = ml.scrollHeight;
  }
}

/* ---------- lobby ---------- */
function lobbyScreen() {
  const back = '<button class="gm-back" type="button" data-act="hub">' + SVG.back + 'Semua game</button>';
  if (!atok || !aOn) {
    return back + '<div class="gm-panel"><h2>Catur Multiplayer</h2>' +
      '<p class="gm-hint">Lawan teman lewat kode ruangan: main bersamaan, lengkap dengan analisis permainan, statistik, dan replay.</p>' +
      '<button class="gm-btn full" type="button" data-act="login">Masuk dulu</button></div>';
  }
  const colorPick = '<div class="cm-colorpick" role="radiogroup" aria-label="Pilih warna">' +
    [['w', 'Putih'], ['b', 'Hitam'], ['r', 'Acak']].map(c =>
      '<button type="button" class="cm-cbtn" role="radio" aria-checked="' + (pickColor === c[0]) + '" data-cm="pick" data-v="' + c[0] + '">' + c[1] + '</button>').join('') + '</div>';
  const create = '<div class="cm-card"><h3><span class="ic">' + SVG.users + '</span>Buat Tantangan</h3>' +
    '<p>Pilih warnamu, bagikan kode 6 karakter ke lawan, lalu tunggu dia masuk.</p>' + colorPick +
    '<button class="gm-btn" type="button" data-cm="createroom">Buat kode ruangan</button></div>';
  const join = '<div class="cm-card"><h3><span class="ic">' + SVG.hand + '</span>Masuk dengan Kode</h3>' +
    '<p>Minta kode dari temanmu yang sudah membuat ruangan.</p>' +
    '<div class="cm-joinrow"><input class="cm-code" id="cmjoin" maxlength="6" autocapitalize="characters" autocomplete="off" spellcheck="false" placeholder="ABC234" aria-label="Kode ruangan" enterkeyhint="go">' +
    '<button class="gm-btn" type="button" data-cm="join">Masuk</button></div></div>';

  let listHtml = '';
  if (lobby.loading && !lobby.games) {
    listHtml = '<div class="cm-skel"><i></i><i></i><i></i></div>';
  } else if (lobby.err) {
    listHtml = '<div class="cm-empty-mini">' + esc(lobby.err) + '</div><button class="cm-more" type="button" data-cm="reloadlobby">Coba lagi</button>';
  } else if (!lobby.games || !lobby.games.length) {
    listHtml = '<div class="cm-empty-mini">Belum ada permainan. Buat tantangan atau masuk dengan kode untuk mulai.</div>';
  } else {
    listHtml = '<div class="cm-list">' + lobby.games.map(rowHtml).join('') + '</div>' +
      (lobby.more ? '<button class="cm-more" type="button" data-cm="moregames">Muat lebih lama</button>' : '');
  }

  const s = stats.data && stats.data.stats;
  const strip = s ? '<div class="cm-stat-strip">' +
    '<span class="k"><span class="n">' + s.played + '</span><span class="l">main</span></span>' +
    '<span class="k"><span class="n">' + s.won + '<small style="color:var(--ok)">W</small></span><span class="l">menang</span></span>' +
    '<span class="k"><span class="n">' + s.drawn + '<small>D</small></span><span class="l">seri</span></span>' +
    '<span class="k"><span class="n">' + s.lost + '<small style="color:var(--rec)">L</small></span><span class="l">kalah</span></span>' +
    '<span class="k"><span class="n">' + (s.accuracy == null ? '–' : s.accuracy.toFixed(1)) + '</span><span class="l">akurasi</span></span>' +
    '<button class="gm-ghost link" type="button" data-cm="openstats">Statistik lengkap</button></div>' : '';

  return back +
    '<div class="gm-panel"><h2>Catur Multiplayer</h2><p class="gm-hint">Lawan teman lewat kode ruangan. Aturan lengkap divalidasi server, plus analisis, statistik, dan replay setelah permainan.</p>' +
    '<div class="cm-lobby-top">' + create + join + '</div>' +
    '<p class="gm-msg' + (msg[1] ? ' ' + msg[1] : '') + '" role="status">' + esc(msg[0]) + '</p></div>' +
    '<div class="cm-sec"><div class="cm-sec-h"><h3>Permainanmu</h3><span class="cm-badge' + (lobby.active ? '' : ' zero') + '">' + (lobby.active ? lobby.active + ' aktif' : 'tidak ada aktif') + '</span></div>' + listHtml + '</div>' +
    (strip || '<button class="cm-more" type="button" data-cm="openstats">Lihat statistik caturku</button>');
}
let pickColor = 'r';

function rowHtml(g) {
  const res = g.result;
  const isAborted = g.status === 'aborted';
  const mine = g.you === 'w' ? 'w' : 'b';
  let right = '', acts = '';
  if (g.status === 'active') {
    right = '<b>' + (g.yourTurn ? 'Giliranmu' : 'Menunggu') + '</b><span>' + g.ply + ' langkah</span>';
    acts = '<button class="gm-ghost" type="button" data-cm="open" data-id="' + esc(g.id) + '">Lanjutkan</button>';
  } else if (isAborted) {
    right = '<b>*</b><span>dibatalkan</span>';
  } else if (res) {
    const won = res.won === 'd' ? 'Seri' : res.won === mine ? 'Menang' : 'Kalah';
    right = '<b style="color:' + (res.won === 'd' ? 'var(--mut)' : res.won === mine ? 'var(--ok)' : 'var(--rec)') + '">' + esc(res.score) + '</b><span>' + esc(won) + ' · ' + esc(REASONS[res.reason] || res.reason) + '</span>';
    acts = '<button class="gm-ghost" type="button" data-cm="review" data-id="' + esc(g.id) + '">' + (g.reviewed ? 'Analisis' : 'Analisis ✦') + '</button>' +
      '<button class="gm-ghost" type="button" data-cm="replay" data-id="' + esc(g.id) + '">Replay</button>';
  }
  return '<div class="cm-row"><span class="cm-row-av" aria-hidden="true">' + esc(initial(g.opp && g.opp.name)) + '</span>' +
    '<span class="cm-row-m"><b>' + esc((g.opp && g.opp.name) || 'Lawan') + '</b><small>' + (g.status === 'active' ? 'sedang berjalan' : isAborted ? 'dibatalkan' : 'selesai') + ' · ' + ago(g.updatedAt) + '</small></span>' +
    '<span class="cm-res">' + right + '</span>' + acts + '</div>';
}

/* ---------- host: menunggu lawan ---------- */
function hostScreen() {
  const back = '<button class="gm-back" type="button" data-act="hub">' + SVG.back + 'Semua game</button>';
  if (!room) return back + lobbyScreen().slice(back.length);
  const colorName = room.color === 'w' ? 'Putih' : 'Hitam';
  return back + '<div class="gm-panel"><h2>Menunggu Lawan</h2>' +
    '<p class="gm-hint">Kamu main <b>' + colorName + '</b>. Bagikan kode ini ke lawanmu:</p>' +
    '<div class="cm-room"><div class="cm-room-code"><b>' + esc(room.code) + '</b>' +
    '<button type="button" class="cm-copy" data-cm="copycode" aria-label="Salin kode">' + SVG.copy + '</button></div>' +
    '<div class="cm-room-wait"><span class="dot"></span>Menunggu lawan masuk…</div>' +
    '<p class="cm-ttl" id="cm-ttl" role="timer">Kode berlaku 60:00</p>' +
    '<button class="gm-ghost" type="button" data-cm="cancelroom">Batalkan ruangan</button></div>' +
    '<p class="gm-msg' + (msg[1] ? ' ' + msg[1] : '') + '" role="status">' + esc(msg[0]) + '</p></div>';
}

/* ============================================================
   LAYAR PERMAINAN
   ============================================================ */
function gameScreen() {
  const back = '<button class="gm-back" type="button" data-act="hub">' + SVG.back + 'Semua game</button>';
  if (!game) return back + '<div class="gm-panel"><h2>Catur Multiplayer</h2><p class="gm-hint">Memuat permainan…</p></div>';
  const g = game;
  const yourTurn = g.status === 'active' && g.yourTurn;
  // orientasi efektif: pemain selalu di bawah saat mulai (hitam -> papan diputar); tombol putar membaliknya
  const eff = (g.you === 'b') !== flip;
  const bottomColor = eff ? (g.you === 'w' ? 'b' : 'w') : g.you;
  const topColor = bottomColor === 'w' ? 'b' : 'w';
  // kotak raja untuk indikator skak. Server mengirim check:-1 saat permainan SUDAH SELESAI (termasuk
  // skakmat), jadi raja yang mati diturunkan di sini hanya untuk tampilan (kebenaran aturan tetap server).
  let checkIdx = g.check == null ? -1 : g.check;
  if (checkIdx < 0 && g.status !== 'active' && g.result && g.result.reason === 'mate') {
    checkIdx = g.board.indexOf(g.result.won === 'w' ? 'k' : 'K');
  }
  // bidak tertangkap diturunkan dari papan (respons sync tidak memuat capsW/capsB; penurunan
  // otomatis benar lagi setelah promosi juga, pion yang "hilang" tetap terhitung)
  const dc = deriveCaps(g.board);
  const pl = c => {
    const who = c === 'w' ? g.white : g.black;
    const isMe = c === g.you;
    const diff = matVal(dc.w) - matVal(dc.b);             // selisih material (putih di atas)
    const mine = c === 'w' ? dc.b : dc.w;                 // bidak musuh yang tertangkap pemain c
    const turn = g.status === 'active' && g.turn === c;
    const online = isMe ? true : (g.opp && g.opp.online !== undefined ? g.opp.online : true);
    return '<div class="cm-pl' + (turn ? ' turn' : '') + '">' +
      '<span class="cm-pl-av" aria-hidden="true">' + esc(initial(who && who.name)) + '</span>' +
      '<span class="cm-pl-m"><b>' + esc((who && who.name) || (c === 'w' ? 'Putih' : 'Hitam')) + (isMe ? ' (kamu)' : '') + '</b>' +
      (isMe ? '' : '<span class="cm-pres' + (online ? ' on' : '') + '" title="' + (online ? 'Lawan online' : 'Lawan tampak offline') + '"></span>') + '</span>' +
      '<span class="cm-pp" style="display:flex;align-items:center;gap:8px">' +
      '<span class="cm-pc' + (c === 'b' ? ' w' : '') + '" style="font-family:' + "'Segoe UI Symbol','Noto Sans Symbols 2','DejaVu Sans',serif" + '">' + capStr(mine) + (diff !== 0 && (c === 'w' ? diff > 0 : diff < 0) ? ' <b>+' + Math.abs(diff) + '</b>' : '') + '</span>' +
      '<span class="cm-turnchip' + (turn ? (c === g.you ? ' me' : '') : '') + '">' + (turn ? (c === g.you ? 'Giliranmu' : 'Lawan') : (c === 'w' ? 'putih' : 'hitam')) + '</span></span></div>';
  };
  const arrows = [];
  if (hint && hint.best) arrows.push({ f: hint.best.from, t: hint.best.to, color: '#f5c542', op: .8 });
  const board = boardHtml(g.board, {
    flip: eff, last: g.last || null, check: checkIdx, sel,
    targets: sel >= 0 ? (legalOf(sel) || []) : [],
    interactive: canPlay(), arrows: arrowSvg(arrows)
  });
  const status = g.status !== 'active'
    ? '<span>' + (g.result ? esc(g.result.score) + ' · ' + esc(REASONS[g.result.reason] || g.result.reason) : 'selesai') + '</span>'
    : yourTurn
      ? '<span class="dot" style="background:var(--ok)"></span><span>' + (checkIdx >= 0 ? '<b style="color:var(--rec)">Skak! </b>' : '') + 'Giliranmu</span>'
      : '<span class="dot"></span><span>Menunggu lawan' + (checkIdx >= 0 ? ' · <b style="color:var(--rec)">kamu diskak!</b>' : '') + '</span>';
  const drawChip = g.draw ? (g.draw.mine ? '<span class="cm-turnchip">tawaran seri menunggu lawan…</span>' : '') : '';
  const acts = '<div class="cm-acts">' +
    (g.status === 'active' ?
    '<button class="gm-ghost" type="button" data-cm="resign"' + (resignArm ? ' data-arm="1"' : '') + '>' + (g.ply < 2 ? (resignArm ? 'Tap lagi: batalkan' : 'Batalkan') : (resignArm ? 'Tap lagi: menyerah' : 'Menyerah')) + '</button>' +
    '<button class="gm-ghost" type="button" data-cm="draw">' + SVG.half.replace('<svg', '<svg style="width:13px;height:13px;vertical-align:-2px"') + ' Seri</button>' +
    '<button class="gm-ghost" type="button" data-cm="hint"' + (yourTurn ? '' : ' disabled') + '>' + (hintBusy ? 'Menghitung…' : 'Hint') + '</button>' : '') +
    '<button class="gm-ghost cm-flip" type="button" data-cm="flip" aria-label="Putar papan">' + SVG.flip + '</button></div>';
  const done = g.status !== 'active' && g.result ? '<div class="cm-pgn">' +
    '<button class="gm-ghost" type="button" data-cm="copypgn">Salin PGN</button>' +
    (g.status === 'done' ? '<button class="gm-ghost" type="button" data-cm="review" data-id="' + esc(g.id) + '">Analisis</button><button class="gm-ghost" type="button" data-cm="replay" data-id="' + esc(g.id) + '">Replay</button>' : '') +
    '<button class="gm-ghost" type="button" data-cm="lobby">Ke lobby</button></div>' : '';
  const totalPly = g.ply || (g.sans ? g.sans.length : 0);
  return back + '<div class="cm-game"><div class="cm-main">' +
    pl(topColor) + board + pl(bottomColor) +
    '<div class="cm-status' + (msg[1] ? ' ' + msg[1] : '') + '" role="status">' + (msg[0] ? esc(msg[0]) : status) + drawChip + '</div>' +
    (promo ? promoHtml() : '') + acts + done +
    '</div><div class="cm-side"><div class="gm-info"><h3>Langkah (' + totalPly + ')</h3>' +
    (g.sans && g.sans.length ? '<div class="cm-mvl">' + sanRowsHtml(g.sans, totalPly, -1, false) + '</div>' : '<p class="gm-cap">Belum ada langkah.</p>') +
    '</div></div></div>' + overlaysHtml();
}

function promoHtml() {
  const white = game && game.you === 'w';
  return '<div class="cm-promo" role="dialog" aria-label="Pilih bidak promosi"><span style="width:100%;text-align:center;font-size:13px;color:var(--mut)">Pionnya jadi apa?</span>' +
    ['Q', 'R', 'B', 'N'].map(x => '<button type="button" class="ch-pr" data-cm="pickpromo" data-p="' + x + '" aria-label="Promosi ' + CH_NAME[x.toLowerCase()] + '"><span class="ch-p ' + (white ? 'ch-w' : 'ch-b') + '" style="position:static;display:grid;place-items:center;font-size:30px">' + CH_G[x.toLowerCase()] + '</span></button>').join('') +
    '<button type="button" class="ch-prx" data-cm="cancelpromo">Batal</button></div>';
}

function overlaysHtml() {
  let h = '';
  if (game && game.status !== 'active' && !resultShown && game.result && view === 'game') {
    h += resultModalHtml();
    ensureResultReview();
  }
  if (game && game.draw && !game.draw.mine && drawShownFor !== game.draw.by + ':' + (game.draw.at || '') && game.status === 'active') {
    drawShownFor = game.draw.by + ':' + (game.draw.at || '');
    h += '<div class="cm-ovl" data-cm-ovl="draw" role="dialog" aria-modal="true"><div class="cm-modal">' +
      '<h3>Tawaran Seri</h3><p class="sub">' + esc((oppOf() && oppOf().name) || 'Lawan') + ' menawarkan hasil seri. Tawaran hangus otomatis setelah 90 detik; melangkah berarti menolak.</p>' +
      '<div class="row"><button class="gm-btn" type="button" data-cm="drawaccept">Terima seri</button><button class="gm-ghost" type="button" data-cm="drawdecline">Tolak</button></div></div></div>';
  }
  return h;
}

/* ============================================================
   MODAL HASIL + RINGKASAN REVIEW (gaya chess.com)
   ============================================================ */
const MARK = {
  great: { c: '#6b9bd1', g: '!' }, best: { c: '#81b64c', g: 'star' }, excellent: { c: '#81b64c', g: 'thumb' },
  mistake: { c: '#f0a037', g: '?' }, miss: { c: '#ee6b5e', g: 'x' }, blunder: { c: '#d93a32', g: '??' }
};
const MK_PATH = {
  star: '<path d="M12 4.2l2.4 4.9 5.4.8-3.9 3.8.9 5.3-4.8-2.5-4.8 2.5.9-5.3-3.9-3.8 5.4-.8z" fill="#fff"/>',
  thumb: '<path d="M8 11v8H5v-8zM10 11l3-6c1.4 0 2.2 1.1 1.9 2.4L14.4 10H19a1.6 1.6 0 011.6 1.9l-1.1 6A1.8 1.8 0 0117.8 19H10z" fill="#fff"/>',
  x: '<path d="M8 8l8 8M16 8l-8 8" stroke="#fff" stroke-width="2.6" stroke-linecap="round" fill="none"/>'
};
function markIcon(k, size) {
  const m = MARK[k]; if (!m) return '';
  const body = MK_PATH[m.g] || '<text x="12" y="16.6" text-anchor="middle" font-size="' + (m.g.length > 1 ? 12 : 15) + '" font-weight="800" fill="#fff" font-family="system-ui,sans-serif">' + m.g + '</text>';
  return '<svg class="cm-mk" viewBox="0 0 24 24" width="' + (size || 22) + '" height="' + (size || 22) + '" aria-hidden="true"><circle cx="12" cy="12" r="11" fill="' + m.c + '"/>' + body + '</svg>';
}
const TROPHY = '<svg viewBox="0 0 24 24" width="30" height="30" aria-hidden="true"><path d="M7 3h10v5a5 5 0 01-10 0z" fill="#f5c542"/><path d="M7 5H4v1.5A3.5 3.5 0 007.6 10M17 5h3v1.5A3.5 3.5 0 0116.4 10" fill="none" stroke="#f5c542" stroke-width="1.6"/><path d="M11 13h2v3h-2zM8 19.5h8M9 16h6v3.5H9z" fill="#c9972a" stroke="#c9972a" stroke-width="1"/></svg>';

/* estimasi rating permainan dari akurasi (perkiraan, bukan rating resmi) */
function gameRating(acc) {
  if (acc == null) return null;
  const t = Math.max(0, (acc - 45) / 55);
  return Math.max(100, Math.min(3200, Math.round((100 + 3100 * t * t) / 50) * 50));
}
const MAT_V = { n: 3, b: 3, r: 5, q: 9 };
function nonPawnMat(board) { let t = 0; for (const ch of board) t += MAT_V[ch.toLowerCase()] || 0; return t; }

/* fase permainan per langkah: Pembukaan (≤10 langkah), Endgame (material tinggal sedikit),
   sisanya Taktik (ada tangkapan/skak) atau Strategi (langkah tenang). Rating tiap fase = rata-rata akurasi. */
function phaseRatings(rv, rp) {
  const out = { w: {}, b: {} };
  const bucket = { w: { open: [], tact: [], strat: [], end: [] }, b: { open: [], tact: [], strat: [], end: [] } };
  const posBd = ply => ply <= 1 ? (rp && rp.initial && rp.initial.board) : (rp && rp.positions && rp.positions[ply - 2] ? rp.positions[ply - 2].board : null);
  for (const m of rv.moves) {
    if (m.acc == null) continue;
    const bd = rp ? posBd(m.ply) : null;
    let ph;
    if (m.ply <= 20) ph = 'open';
    else if (bd && nonPawnMat(bd) <= 26) ph = 'end';
    else ph = /[x+#]/.test(m.san || '') ? 'tact' : 'strat';
    bucket[m.color][ph].push(m);
  }
  for (const c of ['w', 'b']) for (const k of ['open', 'tact', 'strat', 'end']) {
    const arr = bucket[c][k];
    if (!arr.length) { out[c][k] = null; continue; }
    const avg = arr.reduce((a, m) => a + m.acc, 0) / arr.length;
    const bl = arr.some(m => String(m.label).toLowerCase() === 'blunder');
    out[c][k] = avg >= 75 && !(bl && avg < 85) ? 'ok' : avg >= 55 ? 'warn' : 'bad';
  }
  return out;
}
function phaseIcon(v) {
  if (!v) return '<span class="cm-ph na">–</span>';
  if (v === 'ok') return '<span class="cm-ph ok"><svg viewBox="0 0 24 24"><path d="M6 12.5l4 4 8-9"/></svg></span>';
  return '<span class="cm-ph ' + v + '">' + (v === 'warn' ? '?!' : '??') + '</span>';
}
const cntOf = (rv, c, k) => ((rv.counts && rv.counts[c]) || {})[k] || 0;

function avatarHtml(who, big) {
  return '<span class="cm-av' + (big ? ' big' : '') + '" aria-hidden="true">' + esc(initial(who && who.name)) + '</span>';
}
function oppLine(win, draw, rv, me) {
  if (!rv) return win ? 'Selamat! Permainan yang bagus.' : draw ? 'Seri yang adil. Mau coba lagi?' : 'Permainan yang seru. Rematch?';
  const rp = resCache.rp, ph = rp ? phaseRatings(rv, rp)[me] : null;
  const acc = rv.accuracy && rv.accuracy[me];
  if (win && ph && ph.end === 'ok') return 'Kamu tetap tenang di endgame, dan itu memberimu kemenangan.';
  if (win && cntOf(rv, me, 'blunder') === 0) return 'Nyaris tanpa blunder — permainan yang rapi!';
  if (win) return 'Kamu menang! Masih ada ruang untuk lebih akurat.';
  if (draw) return 'Seri. Akurasimu ' + (acc != null ? acc.toFixed(1) : '–') + ' — lumayan.';
  if (cntOf(rv, me, 'blunder') > 2) return 'Beberapa blunder menentukan hasilnya. Cek Game Review!';
  return 'Kamu sudah berusaha. Lihat di mana kuncinya lewat Game Review.';
}
function resultModalHtml() {
  const r = game.result, me = game.you, opp = oppOf();
  const win = r.won === me, draw = r.won === 'd', aborted = r.reason === 'abort';
  const still = resultAnim === game.id ? ' still' : '';
  resultAnim = game.id;
  const rv = resCache.id === game.id ? resCache.rv : null;
  const loading = !rv && resCache.id === game.id && resCache.loading;
  const title = aborted ? 'Permainan Dibatalkan' : win ? 'Kamu Menang!' : draw ? 'Seri' : 'Kamu Kalah';
  const by = aborted ? 'Dibatalkan sebelum dua langkah' : (draw ? 'Karena ' : 'Oleh ') + (REASONS[r.reason] || r.reason) + ' · ' + esc(r.score);
  const icon = aborted ? '' : win ? TROPHY : draw ? '<span class="cm-rico">½</span>' : '<span class="cm-rico lose">⚑</span>';
  const stat = (k, n, label) => '<div class="cm-rs"><span class="ic">' + markIcon(k, 24) + '</span><b' + (n == null ? ' class="sk"' : '') + '>' + (n == null ? '' : n) + '</b><small>' + label + '</small></div>';
  const stats = aborted ? '' : '<div class="cm-rstats' + (loading ? ' load' : '') + '">' +
    stat('great', rv ? cntOf(rv, me, 'great') : null, 'Great') + stat('best', rv ? cntOf(rv, me, 'best') : null, 'Best') + stat('excellent', rv ? cntOf(rv, me, 'excellent') : null, 'Excellent') + '</div>';
  const bubble = aborted ? '' : '<div class="cm-rbub"><div class="cm-rbav">' + avatarHtml(opp, true) + '</div><div class="cm-bubble">' + esc(oppLine(win, draw, rv, me)) + '</div></div>';
  const canReview = game.status === 'done' && !aborted;
  return '<div class="cm-ovl" data-cm-ovl="result" role="dialog" aria-modal="true" aria-label="' + esc(title) + '"><div class="cm-rmod' + still + '">' +
    '<button class="cm-res-x" type="button" data-cm="closeovl" aria-label="Tutup">×</button>' +
    '<div class="cm-res-top"><h3>' + icon + '<span>' + esc(title) + '</span></h3><p>' + by + '</p></div>' +
    bubble + stats +
    (canReview ? '<button class="cm-res-main" type="button" data-cm="review" data-id="' + esc(game.id) + '"><span class="st">★</span>Game Review</button>' : '') +
    '<div class="cm-res-row"><button type="button" data-cm="newgame">Game Baru</button><button type="button" data-cm="rematch"' + (aborted ? ' disabled' : '') + '>Rematch</button></div>' +
    '<div class="cm-res-row sm">' + (canReview ? '<button type="button" data-cm="replay" data-id="' + esc(game.id) + '">Putar Ulang</button>' : '') +
    (game.pgn ? '<button type="button" data-cm="copypgn">Salin PGN</button>' : '') + '</div>' +
    '</div></div>';
}
/* ambil analisis di latar belakang agar angka Great/Best/Excellent muncul di modal */
function ensureResultReview() {
  if (!game || game.status !== 'done' || !game.result || game.result.reason === 'abort') return;
  const id = game.id;
  if (resCache.id === id) return;
  resCache = { id, loading: true, rv: null, rp: null, err: '' };
  Promise.allSettled([api('review', { id }), api('replay', { id })]).then(([rv, rp]) => {
    if (resCache.id !== id) return;
    resCache.loading = false;
    if (rv.status === 'fulfilled') resCache.rv = rv.value.review; else resCache.err = (rv.reason && rv.reason.message) || 'gagal';
    if (rp.status === 'fulfilled') resCache.rp = rp.value;
    if (view === 'game' && game && game.id === id && !resultShown) render();
  });
}
async function doRematch() {
  if (!game || busyMove) return;
  const color = game.you === 'w' ? 'b' : 'w';
  busyMove = true;
  try {
    const r = await api('room', { color });
    resultShown = true; game = null;
    room = { code: r.code, color: r.color, ttlMin: r.ttlMin || 60, createdAt: Date.now() };
    msg = ['', ''];
    view = 'host'; render(); startRoomPoll();
  } catch (e) { msg = [e.message || 'Gagal membuat rematch.', 'err']; render(); }
  busyMove = false;
}

/* kartu ringkasan Game Review */
function reviewSummaryHtml(rv, white, black) {
  const rp = review.pos;
  const acc = c => rv.accuracy && rv.accuracy[c] != null ? rv.accuracy[c] : null;
  const rate = c => gameRating(acc(c));
  const ph = rp ? phaseRatings(rv, rp) : null;
  const pcol = c => '<div class="c"><span class="cm-pav ' + c + '">' + (c === 'w' ? '♙' : '♟') + '</span><small>' + esc(((c === 'w' ? white : black) || {}).name || (c === 'w' ? 'Putih' : 'Hitam')) + '</small></div>';
  const row = (lab, a, b, mid) => '<div class="r"><span class="l">' + lab + '</span><b class="v ' + (mid || '') + '">' + a + '</b><span class="m">' + (mid ? markIcon(mid, 22) : '') + '</span><b class="v ' + (mid || '') + '">' + b + '</b></div>';
  const cnt = ['great', 'best', 'excellent', 'mistake', 'miss', 'blunder'].map(k => row(k[0].toUpperCase() + k.slice(1), cntOf(rv, 'w', k), cntOf(rv, 'b', k), k)).join('');
  const prow = (lab, k) => '<div class="r"><span class="l">' + lab + '</span><span class="v">' + phaseIcon(ph[ 'w'][k]) + '</span><span class="m"></span><span class="v">' + phaseIcon(ph['b'][k]) + '</span></div>';
  return '<div class="cm-sum" aria-label="Ringkasan Game Review">' +
    '<div class="cm-sum-h">' + markIcon('best', 26) + '<b>Game Review</b></div>' +
    '<div class="r"><span class="l">Pemain</span>' + pcol('w') + '<span class="m"></span>' + pcol('b') + '</div>' +
    '<div class="r"><span class="l">Akurasi</span><b class="v acc">' + (acc('w') != null ? acc('w').toFixed(1) : '–') + '</b><span class="m"></span><b class="v acc">' + (acc('b') != null ? acc('b').toFixed(1) : '–') + '</b></div>' +
    '<hr>' + cnt + '<hr>' +
    '<div class="r"><span class="l">Rating Game</span><b class="v acc">' + (rate('w') || '–') + '</b><span class="m"></span><b class="v acc">' + (rate('b') || '–') + '</b></div>' +
    (ph ? '<hr>' + prow('Pembukaan', 'open') + prow('Taktik', 'tact') + prow('Strategi', 'strat') + prow('Endgame', 'end') : '') +
    '<p class="cm-sum-n">Rating Game adalah perkiraan dari akurasi, bukan rating resmi.</p></div>';
}

/* ============================================================
   REVIEW (Chess Review)
   ============================================================ */
function reviewScreen() {
  const back = '<button class="gm-back" type="button" data-cm="back">' + SVG.back + (gameFrom === 'game' ? 'Ke permainan' : 'Semua game') + '</button>';
  if (review.loading) {
    return back + '<div class="gm-panel"><div class="cm-analyzing"><div class="spin" role="status" aria-label="Menganalisis"></div>' +
      '<b>Menganalisis permainan…</b><p>Engine menilai setiap langkah kedua pemain. Ini bisa memakan waktu beberapa detik hingga ±30 detik untuk permainan panjang — hasilnya tersimpan permanen, pembukaan berikutnya instan.</p></div></div>';
  }
  if (review.err) {
    return back + '<div class="gm-panel"><h2>Analisis</h2><div class="cm-empty-mini">' + esc(review.err) + '</div>' +
      '<button class="gm-btn full" type="button" data-cm="back">Kembali</button></div>';
  }
  const rv = review.data;
  if (!rv) return back + '<div class="gm-panel"><p class="gm-hint">Memuat…</p></div>';
  const meta = review.pos && review.pos.meta;
  const white = meta ? meta.white : (game ? game.white : null);
  const black = meta ? meta.black : (game ? game.black : null);
  const result = meta && meta.result;
  const N = rv.moves.length;

  const graph = evalGraphHtml(rv);
  const ply = review.ply;                       // 1..N langkah yang dipilih (0 = belum)
  const mv = ply >= 1 && ply <= N ? rv.moves[ply - 1] : null;
  const boardStr = posBefore(ply);
  const arrows = [];
  if (mv) {
    arrows.push({ f: mv.from, t: mv.to, color: '#e8a13a', op: .6 });
    if (mv.bestUci && mv.uci !== mv.bestUci) { const [bf, bt] = uci2sq(mv.bestUci); arrows.push({ f: bf, t: bt, color: '#4db56e', op: .65 }); }
  }
  const board = boardHtml(boardStr, {
    flip, last: mv ? { f: mv.from, t: mv.to } : null,
    check: posCheck(ply), sel: -1, targets: [], interactive: false, arrows: arrowSvg(arrows)
  });
  const nav = '<div class="cm-rp-ctrl">' +
    '<button type="button" class="cm-rpb" data-cm="rstep" data-v="first" aria-label="Langkah pertama">' + SVG.first + '</button>' +
    '<button type="button" class="cm-rpb" data-cm="rstep" data-v="prev" aria-label="Sebelumnya">' + SVG.prev + '</button>' +
    '<button type="button" class="cm-rpb" data-cm="rstep" data-v="next" aria-label="Berikutnya">' + SVG.next + '</button>' +
    '<button type="button" class="cm-rpb" data-cm="rstep" data-v="last" aria-label="Terakhir">' + SVG.last + '</button></div>';

  const detail = mv ? '<div class="cm-detail">' +
    '<div class="dtop"><span class="san">' + esc(mv.san) + '</span>' +
    '<span class="cm-lab ' + String(mv.label).toLowerCase() + '">' + (mv.label === 'Best' ? '★ ' : mv.label === 'Miss' ? '⚠ ' : '') + esc(mv.label) + '</span>' +
    '<span style="color:var(--mut);font-size:12px">' + esc(((mv.color === 'w' ? white : black) || {}).name || '') + ' · langkah ke-' + Math.ceil(mv.ply / 2) + (mv.color === 'w' ? ' (putih)' : ' (hitam)') + '</span></div>' +
    '<div class="arrows"><span>dipilih:</span><span class="mv">' + esc(mv.san) + '</span>' + (mv.bestSan ? '<span>· terbaik:</span><span class="mv" style="color:var(--ok)">' + esc(mv.bestSan) + '</span>' : '') + '</div>' +
    '<div class="nums"><span>eval <b>' + fmtCp(mv.evalBefore) + '</b> → <b>' + fmtCp(mv.evalAfter) + '</b></span>' +
    '<span>kerugian <b>' + (mv.cpLoss >= 90000 ? 'mati' : '+' + Math.round(mv.cpLoss)) + '</b> cp</span>' +
    '<span>menang <b>' + (mv.winBefore == null ? '–' : mv.winBefore.toFixed(1) + '%') + '</b> → <b>' + (mv.winAfter == null ? '–' : mv.winAfter.toFixed(1) + '%') + '</b></span>' +
    '<span>akurasi <b>' + (mv.acc == null ? '–' : mv.acc.toFixed(1)) + '</b></span></div>' +
    (mv.label !== 'Best' && mv.bestSan ? '<p class="cm-hintline">Sebaiknya: <b>' + esc(mv.bestSan) + '</b> (' + esc(mv.bestUci) + ') — posisi sebelum langkahmu, bandingkan dengan panah kuning (langkahmu) dan hijau (terbaik).</p>' : '') +
    '</div>' : '<div class="cm-detail" style="text-align:center;color:var(--mut)">Pilih langkah pada grafik atau daftar untuk melihat detailnya.</div>';

  const sans = rv.moves.map(m => m.san);
  return back + '<div class="gm-panel"><h2>Analisis Permainan</h2>' +
    '<p class="gm-hint">' + esc((white && white.name) || 'Putih') + ' vs ' + esc((black && black.name) || 'Hitam') + (result ? ' · ' + esc(result.score) + ' (' + esc(REASONS[result.reason] || result.reason) + ')' : '') + '</p>' +
    reviewSummaryHtml(rv, white, black) +
    '<p class="cm-eng">Engine: ' + esc(rv.engine || '-') + (rv.depth ? ' · kedalaman ' + rv.depth : '') + (N ? ' · ' + N + ' langkah dianalisis' : '') + '</p>' +
    graph +
    '<div class="cm-rev-grid"><div class="cm-main">' + board + nav + '</div>' +
    '<div class="cm-rev-side">' + detail +
    '<div class="gm-info" style="margin-top:12px"><h3>Daftar langkah</h3><div class="cm-mvlist">' + sanRowsHtml(sans, N, ply, true, rv.moves) + '</div></div>' +
    '</div></div></div>';
}

/* posisi papan SEBELUM langkah ke-ply (untuk board + panah review) */
function posBefore(ply) {
  const rp = review.pos;
  if (!rp) { // tanpa data replay (gagal): pakai papan akhir — tetap berguna untuk label
    return game && game.board ? game.board : '........................................................';
  }
  if (ply <= 1) return rp.initial.board;
  const p = rp.positions[ply - 2];
  return p ? p.board : rp.initial.board;
}
function posCheck(ply) {
  const rp = review.pos;
  if (!rp || ply <= 1) return -1;
  const p = rp.positions[ply - 2];
  return p && p.check != null ? p.check : -1;
}
function fmtCp(cp) {
  if (cp == null) return '–';
  if (cp <= -90000) return 'M';
  if (cp >= 90000) return '+M';
  const v = cp / 100;
  return (v > 0 ? '+' : '') + v.toFixed(1);
}

/* grafik evaluasi: ev[] (cp perspektif putih, panjang ply+1). ±99999/100000 = mate → clamp ±10 */
function evalGraphHtml(rv) {
  const ev = rv.ev || [];
  const n = ev.length;
  if (!n) return '';
  const W = 620, H = 132, mid = H / 2, sc = (H / 2 - 8) / 10;
  const clamp = v => Math.max(-10, Math.min(10, v));
  const X = i => n > 1 ? (i / (n - 1)) * W : 0;
  const Y = v => mid - clamp(v) * sc;
  let line = 'M' + X(0).toFixed(1) + ',' + Y(ev[0]).toFixed(1);
  for (let i = 1; i < n; i++) line += ' L' + X(i).toFixed(1) + ',' + Y(ev[i]).toFixed(1);
  const area = line + ' L' + W + ',' + mid + ' L0,' + mid + ' Z';
  let dots = '';
  for (let i = 0; i < n; i++) {
    if (rv.mates && rv.mates[i] != null) dots += '<circle cx="' + X(i).toFixed(1) + '" cy="' + Y(ev[i]).toFixed(1) + '" r="3.2" fill="' + (rv.mates[i] > 0 ? '#f5f0e6' : '#2b2420') + '" stroke="' + (rv.mates[i] > 0 ? '#6b5136' : '#f5f0e6') + '" stroke-width="1.2"/>';
  }
  const cur = review.ply; // garis penanda ply terpilih
  const marker = cur >= 0 && cur < n ? '<line x1="' + X(cur).toFixed(1) + '" y1="4" x2="' + X(cur).toFixed(1) + '" y2="' + (H - 4) + '" stroke="currentColor" stroke-width="1.5" opacity=".55" stroke-dasharray="4 3"/>' : '';
  return '<div class="cm-graph-wrap"><svg class="cm-graph" data-cm-graph viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" role="img" aria-label="Grafik evaluasi per langkah">' +
    '<defs><clipPath id="cmgt"><rect x="0" y="0" width="' + W + '" height="' + mid + '"/></clipPath><clipPath id="cmgb"><rect x="0" y="' + mid + '" width="' + W + '" height="' + mid + '"/></clipPath></defs>' +
    '<line x1="0" y1="' + mid + '" x2="' + W + '" y2="' + mid + '" stroke="currentColor" opacity=".25" stroke-width="1"/>' +
    '<path d="' + area + '" clip-path="url(#cmgt)" fill="#f5f0e6" stroke="none" opacity=".92"/>' +
    '<path d="' + area + '" clip-path="url(#cmgb)" fill="#2b2420" stroke="none" opacity=".85"/>' +
    '<path d="' + line + '" fill="none" stroke="currentColor" stroke-width="1.6"/>' +
    dots + marker + '</svg>' +
    '<div class="cm-graph-tip" data-cm-tip></div>' +
    '<div class="cm-graph-x"><span>awal</span><span>+' + n / 2 + ' langkah</span><span>' + (n - 1) + ' ply</span></div></div>';
}

/* ============================================================
   REPLAY
   ============================================================ */
function replayScreen() {
  const back = '<button class="gm-back" type="button" data-cm="back">' + SVG.back + (gameFrom === 'game' ? 'Ke permainan' : 'Semua game') + '</button>';
  if (replay.loading) return back + '<div class="gm-panel"><div class="cm-skel"><i></i><i></i></div></div>';
  if (replay.err) return back + '<div class="gm-panel"><h2>Replay</h2><div class="cm-empty-mini">' + esc(replay.err) + '</div><button class="gm-btn full" type="button" data-cm="back">Kembali</button></div>';
  const rp = replay.data;
  if (!rp) return back + '<div class="gm-panel"><p class="gm-hint">Memuat…</p></div>';
  const meta = rp.meta, pos = rp.positions, N = pos.length;
  const idx = Math.max(-1, Math.min(replay.idx, N - 1));
  const cur = idx >= 0 ? pos[idx] : null;
  const boardStr = cur ? cur.board : rp.initial.board;
  const board = boardHtml(boardStr, {
    flip, last: cur && cur.lastMove ? cur.lastMove : null,
    check: cur && cur.check != null ? cur.check : -1, sel: -1, targets: [], interactive: false, arrows: ''
  });
  const playing = replay.playing;
  const ctr = '<div class="cm-rp-ctrl">' +
    '<button type="button" class="cm-rpb" data-cm="step" data-v="first" aria-label="Posisi awal"' + (idx <= -1 ? ' disabled' : '') + '>' + SVG.first + '</button>' +
    '<button type="button" class="cm-rpb" data-cm="step" data-v="prev" aria-label="Sebelumnya"' + (idx <= -1 ? ' disabled' : '') + '>' + SVG.prev + '</button>' +
    '<button type="button" class="cm-rpb play" data-cm="play" aria-label="' + (playing ? 'Jeda' : 'Putar otomatis') + '">' + (playing ? SVG.pause : SVG.play) + '</button>' +
    '<button type="button" class="cm-rpb" data-cm="step" data-v="next" aria-label="Berikutnya"' + (idx >= N - 1 ? ' disabled' : '') + '>' + SVG.next + '</button>' +
    '<button type="button" class="cm-rpb" data-cm="step" data-v="last" aria-label="Posisi akhir"' + (idx >= N - 1 ? ' disabled' : '') + '>' + SVG.last + '</button></div>';
  const slider = '<div class="cm-rp-slider"><span>awal</span><input type="range" min="0" max="' + N + '" value="' + (idx + 1) + '" data-cm-slider aria-label="Garis waktu permainan"><span>' + N + '</span></div>';
  const now = cur
    ? '<div class="cm-rp-now">' + Math.ceil(cur.ply / 2) + (cur.color === 'w' ? '. <b>' + esc(cur.san) + '</b> (putih)' : '… <b>' + esc(cur.san) + '</b> (hitam)') + '</div>'
    : '<div class="cm-rp-now">Posisi awal — putih jalan duluan</div>';
  const sans = pos.map(p => p.san);
  const r = meta.result;
  return back + '<div class="gm-panel"><h2>Putar Ulang</h2>' +
    '<p class="gm-hint">' + esc((meta.white && meta.white.name) || 'Putih') + ' vs ' + esc((meta.black && meta.black.name) || 'Hitam') + (r ? ' · ' + esc(r.score) + ' (' + esc(REASONS[r.reason] || r.reason) + ')' : '') + ' · ' + N + ' langkah</p>' +
    board + ctr + slider + now +
    '<div class="cm-pgn"><button class="gm-ghost" type="button" data-cm="copypgn">Salin PGN</button></div></div>' +
    '<div class="gm-info"><h3>Riwayat langkah</h3><div class="cm-mvlist">' + sanRowsHtml(sans, N, idx + 1, false) + '</div></div>';
}

/* ============================================================
   STATISTIK
   ============================================================ */
function statsScreen() {
  const back = '<button class="gm-back" type="button" data-cm="back">' + SVG.back + 'Kembali</button>';
  if (stats.loading) return back + '<div class="gm-panel"><div class="cm-skel"><i></i><i></i><i></i></div></div>';
  if (stats.err) return back + '<div class="gm-panel"><h2>Statistik</h2><div class="cm-empty-mini">' + esc(stats.err) + '</div><button class="gm-btn full" type="button" data-cm="back">Kembali</button></div>';
  const d = stats.data;
  if (!d) return back + '<div class="gm-panel"><p class="gm-hint">Memuat…</p></div>';
  const s = d.stats, who = d.user || {};
  const cards = [['played', s.played, 'dimainkan', ''], ['won', s.won, 'menang', 'hl'], ['drawn', s.drawn, 'seri', ''], ['lost', s.lost, 'kalah', ''], ['winRate', s.winRate + '%', 'rasio menang', s.winRate >= 50 ? 'hl' : '']]
    .map(c => '<div class="cm-stk ' + c[3] + '"><b>' + esc(String(c[1])) + '</b><small>' + c[2] + '</small></div>').join('');
  const labels = LABELS.map(l => '<div class="cm-lrow"><span class="cm-lab ' + l.k + '">' + l.n + '</span><b>' + (s.labels ? s.labels[l.k] || 0 : 0) + '</b></div>').join('');
  return back + '<div class="gm-panel"><h2>Statistik Catur <small class="ch-lv">' + esc(who.name || who.username || 'Pemain') + '</small></h2>' +
    '<p class="gm-hint">Statistik multiplayer: hasil permainan tercatat otomatis saat selesai; akurasi & label masuk setiap kali analisis dijalankan.</p>' +
    '<div class="cm-stats-grid">' + cards + '</div>' +
    '<div class="cm-lookup"><input id="cmuser" maxlength="20" placeholder="Lihat statistik pemain lain (username)" aria-label="Username pemain" enterkeyhint="go">' +
    '<button class="gm-btn" type="button" data-cm="lookup">Cari</button></div>' +
    '<div class="gm-info" style="margin-top:14px"><h3>Akurasi</h3>' +
    '<div class="cm-stats-grid"><div class="cm-stk"><b>' + (s.accuracy == null ? '–' : s.accuracy.toFixed(1)) + '</b><small>akurasi rata-rata</small></div>' +
    '<div class="cm-stk hl"><b>' + (s.bestAcc ? s.bestAcc.toFixed(1) : '–') + '</b><small>akurasi terbaik</small></div>' +
    '<div class="cm-stk"><b>' + s.accGames + '</b><small>game dianalisis</small></div></div>' +
    '<p class="cm-note">' + (s.accuracy == null ? 'Belum ada game yang dianalisis — buka "Analisis" pada permainan yang sudah selesai untuk menghitung akurasi dan label.' : 'Akurasi dihitung dari ' + s.accGames + ' game yang sudah dianalisis (rata-rata ala Lichess dari win% tiap langkah).') + '</p></div>' +
    '<div class="gm-info" style="margin-top:14px"><h3>Label langkah seumur hidup</h3><div class="cm-lgrid">' + labels + '</div></div></div>';
}

/* ============================================================
   INTERAKSI PAPAN: drag & drop (mouse + touchscreen) + klik-klik
   Pointer Events: pointerdown memilih bidak; gerak >7px = seret (bidak
   mengikuti pointer, kotak tujuan disorot); lepas di kotak sah = kirim
   langkah; lepas di luar = bidak kembali (snap-back + tetap terpilih).
   Klik biasa (tanpa seret) tetap bisa: pilih bidak lalu ketuk kotak
   tujuan. Keyboard: tombol kotak bisa difokus + Enter (rute click).
   ============================================================ */
function boardEl() { return host().querySelector('[data-cm-board]'); }
function squareAt(x, y) {
  const el = boardEl();
  if (!el) return null;
  const r = el.getBoundingClientRect(), s = r.width / 8;
  const gx = Math.floor((x - r.left) / s), gy = Math.floor((y - r.top) / s);
  if (gx < 0 || gx > 7 || gy < 0 || gy > 7) return null;
  const g = gy * 8 + gx;
  return flipNow() ? 63 - g : g;
}
function setSel(i) { if (sel !== i) { sel = i; render(); } }

function onPointerDown(e) {
  if (e.pointerType === 'keyboard') return;
  if (view !== 'game' || !canPlay()) return;
  const sqEl = e.target.closest ? e.target.closest('[data-cm-sq]') : null;
  if (!sqEl || sqEl.disabled) return;
  const i = +sqEl.dataset.i;
  if (!(e.pointerType === 'mouse' ? e.button === 0 : true)) return;
  // klik-klik: kotak tujuan sah saat ada bidak terpilih
  if (sel >= 0 && i !== sel) {
    const ts = legalOf(sel);
    if (ts && ts.includes(i)) { e.preventDefault(); tryMove(sel, i); return; }
  }
  const p = game.board[i];
  const own = p !== '.' && isW(p) === (game.you === 'w');
  if (own && legalOf(i)) {
    e.preventDefault();
    const wasSel = sel === i;
    sel = i; render();                       // tampilkan titik tujuan dulu (render aman: belum menyeret)
    const el = boardEl();
    const piece = el && el.querySelector('.ch-sq[data-i="' + i + '"] .ch-p');
    if (!piece) { setSel(-1); return; }
    try { el.setPointerCapture(e.pointerId); } catch {}
    drag = { from: i, pid: e.pointerId, x0: e.clientX, y0: e.clientY, moved: false, wasSel, piece };
  } else if (sel !== -1) {
    setSel(-1);
  } else if (own) {
    // bidak sendiri tanpa langkah sah (mis. terkunci skak): tetap beri umpan balik singkat
    msg = ['Bidak itu tidak punya langkah sah.', '']; render();
  }
}

function onPointerMove(e) {
  if (!drag || e.pointerId !== drag.pid) return;
  const dx = e.clientX - drag.x0, dy = e.clientY - drag.y0;
  if (!drag.moved) {
    if (Math.hypot(dx, dy) < 7) return;
    drag.moved = true;
    drag.piece.classList.add('cm-drag');
    const be = boardEl();
    if (be) be.classList.add('cm-dragsrc');
    vibrate(5);
  }
  drag.piece.style.transform = 'translate(' + dx + 'px,' + dy + 'px) scale(1.16)';
  // sorot kotak tujuan saat hover
  const be = boardEl();
  if (be) {
    const t = squareAt(e.clientX, e.clientY);
    be.querySelectorAll('.cm-sqhov').forEach(el => el.classList.remove('cm-sqhov'));
    if (t != null && t !== drag.from) {
      const ts = legalOf(drag.from);
      const el = be.querySelector('.ch-sq[data-i="' + t + '"]');
      if (el && ts && ts.includes(t)) el.classList.add('cm-sqhov');
    }
  }
}

function onPointerUp(e) {
  if (!drag || e.pointerId !== drag.pid) return;
  const d = drag; drag = null;
  const be = boardEl();
  if (be) { be.classList.remove('cm-dragsrc'); be.querySelectorAll('.cm-sqhov').forEach(el => el.classList.remove('cm-sqhov')); }
  d.piece.classList.remove('cm-drag');
  d.piece.style.transform = '';
  if (d.moved) {
    const t = squareAt(e.clientX, e.clientY);
    if (t != null && t !== d.from) {
      const ts = legalOf(d.from);
      if (ts && ts.includes(t)) { finishDrag(); tryMove(d.from, t); return; }
      msg = ['Tidak bisa ke sana.', '']; render(); snapBack(d.from, t);
    } else if (t === d.from) {
      finishDrag(); setSel(-1);   // dilepas di kotak asalnya: batal pilih
      return;
    } else { finishDrag(); snapBack(d.from, null); }
  } else if (d.wasSel) {
    // ketuk bidak yang sudah terpilih: batal pilih (render sudah terjadi di pointerdown)
    setSel(-1);
  }
  finishDrag();
}
function finishDrag() {
  if (pendingPaint) { pendingPaint = false; render(); }
}
function snapBack(from, badTo) {
  if (badTo != null && reduceMo() === false) {
    const be = boardEl();
    const a = be && be.querySelector('.ch-sq[data-i="' + badTo + '"]');
    const b = be && be.querySelector('.ch-sq[data-i="' + from + '"]');
    const piece = b && b.querySelector('.ch-p');
    if (a && b && piece) {
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      b.classList.add('ch-fly');
      const an = piece.animate([{ transform: 'translate(' + (ra.left - rb.left) + 'px,' + (ra.top - rb.top) + 'px) scale(1.12)' }, { transform: 'translate(0,0) scale(1)' }], { duration: 180, easing: 'ease-out' });
      an.onfinish = () => b.classList.remove('ch-fly');
    }
  }
}

/* ---------- kirim langkah ---------- */
function midBoard(old, from, to, promoP) {
  const b = old.split('');
  const p = promoP || b[from];
  b[to] = p; b[from] = '.';
  if ((p === 'P' || p === 'p') && old[to] === '.' && (to & 7) !== (from & 7)) b[p === 'P' ? to + 8 : to - 8] = '.';
  if ((p === 'K' || p === 'k') && Math.abs(to - from) === 2) {
    if (to > from) { b[from + 1] = b[from + 3]; b[from + 3] = '.'; } else { b[from - 1] = b[from - 4]; b[from - 4] = '.'; }
  }
  return b.join('');
}
function planAnim(old, from, to) {
  const steps = [{ f: from, t: to }], ghosts = [];
  const p = old[from], cap = old[to];
  if (cap !== '.') ghosts.push({ sq: to, p: cap });
  if ((p === 'P' || p === 'p') && cap === '.' && (to & 7) !== (from & 7)) ghosts.push({ sq: p === 'P' ? to + 8 : to - 8, p: p === 'P' ? 'p' : 'P' });
  if ((p === 'K' || p === 'k') && Math.abs(to - from) === 2) steps.push(to > from ? { f: from + 3, t: from + 1 } : { f: from - 4, t: from - 1 });
  return { steps, ghosts };
}
function runAnim(plan) {
  if (reduceMo()) return;
  const be = boardEl();
  if (!be) return;
  for (const g of plan.ghosts) {
    const host2 = be.querySelector('.ch-sq[data-i="' + g.sq + '"]');
    if (!host2) continue;
    const el = document.createElement('span');
    el.className = 'ch-p ch-ghost ' + (isW(g.p) ? 'ch-w' : 'ch-b');
    el.setAttribute('aria-hidden', 'true'); el.textContent = CH_G[g.p.toLowerCase()];
    host2.prepend(el);
    const an = el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 200, easing: 'ease-in', fill: 'both' });
    an.onfinish = () => el.remove();
  }
  for (const s of plan.steps) {
    const from = be.querySelector('.ch-sq[data-i="' + s.f + '"]'), to = be.querySelector('.ch-sq[data-i="' + s.t + '"]');
    const piece = to && to.querySelector('.ch-p:not(.ch-ghost)');
    if (!from || !to || !piece) continue;
    const ra = from.getBoundingClientRect(), rb = to.getBoundingClientRect();
    to.classList.add('ch-fly');
    const an = piece.animate([{ transform: 'translate(' + (ra.left - rb.left) + 'px,' + (ra.top - rb.top) + 'px) scale(1.06)' }, { transform: 'translate(0,0) scale(1)' }], { duration: 240, easing: 'cubic-bezier(.3,.7,.25,1)', fill: 'backwards' });
    an.onfinish = () => to.classList.remove('ch-fly');
  }
}

function tryMove(from, to) {
  const g = game;
  if (!g || g.status !== 'active') return;
  const p = g.board[from];
  const lastRow = g.you === 'w' ? to < 8 : to >= 56;
  if ((p === 'P' || p === 'p') && lastRow) { promo = { from, to }; sel = -1; msg = ['', '']; render(); return; }
  sendMove(from, to);
}

async function sendMove(from, to, promoP) {
  const g = game;
  if (!g || g.status !== 'active' || busyMove) return;
  busyMove = true; sel = -1; hint = null; promo = null;
  msg = ['', ''];
  const pre = g, oldBoard = pre.board;
  const vic = oldBoard[to] !== '.' ? oldBoard[to] : ((oldBoard[from] === 'P' || oldBoard[from] === 'p') && (to & 7) !== (from & 7) ? (pre.you === 'w' ? 'p' : 'P') : '');
  // tampilan optimistik: bidak langsung "terbang" ke kotak tujuan sambil menunggu server
  const mid = { ...pre, board: midBoard(oldBoard, from, to, promoP), turn: pre.you === 'w' ? 'b' : 'w', moves: null, check: -1, last: { f: from, t: to }, ply: (pre.ply || 0) + 1,
    ...(vic ? (pre.you === 'w' ? { capsW: [...pre.capsW, vic] } : { capsB: [...pre.capsB, vic] }) : {}) };
  mid.sans = [...(pre.sans || [])]; // sans diperbarui saat respons server datang
  game = mid; myPly = mid.ply;
  render();
  runAnim(planAnim(oldBoard, from, to));
  vibrate(10);
  try {
    const r = await api('move', { id: pre.id, from, to, ...(promoP ? { promo: promoP } : {}) });
    game = r.game; myPly = r.game.ply;
    msg = ['', ''];
    if (r.game.status === 'done') { stopPoll(); onGameDone(); }
    render();
    startPoll(true);              // mulai menunggu balasan lawan
  } catch (e) {
    game = pre; myPly = pre.ply || 0;
    if (e.status === 400) { msg = [e.message || 'Langkah itu tidak boleh.', 'err']; }
    else if (e.status === 409) { msg = [e.message || 'Permainan berubah.', 'err']; await fetchGame(pre.id, true); }
    else if (e.status === 401) { msg = ['Sesi berakhir — masuk lagi untuk melanjutkan.', 'err']; }
    else { msg = [e.message || 'Gagal mengirim langkah, coba lagi.', 'err']; }
    render();
    snapBack(from, to);           // bidak kembali ke kotak asalnya
    if (e.status === 409) startPoll(true);
  }
  busyMove = false;
}

/* ---------- menyerah / batal / seri / hint ---------- */
async function doResign() {
  if (!game || game.status !== 'active' || busyMove) return;
  busyMove = true;
  try {
    const r = await api('resign', { id: game.id });
    game = r.game; myPly = r.game.ply || myPly;
    msg = ['', ''];
    stopPoll(); onGameDone(); render();
  } catch (e) { msg = [e.message || 'Gagal, coba lagi.', 'err']; render(); }
  busyMove = false;
}
async function doDraw(act) {
  if (!game || game.status !== 'active' || busyMove) return;
  busyMove = true;
  try {
    const r = await api('draw', { id: game.id, act });
    if (act === 'accept') { game = r.game; msg = ['', '']; stopPoll(); onGameDone(); }
    else { game.draw = r.draw; msg = act === 'offer' ? ['Tawaran seri dikirim — menunggu lawan.', 'ok'] : ['', '']; if (act === 'decline') drawShownFor = null; }
    render();
  } catch (e) { msg = [e.message || 'Gagal memproses tawaran.', 'err']; render(); }
  busyMove = false;
}
async function doHint() {
  if (!game || game.status !== 'active' || hintBusy) return;
  hintBusy = true; msg = ['', '']; render();
  try {
    const r = await api('hint', { id: game.id });
    hint = r;
    const ev = r.best ? (r.mate != null ? (r.mate > 0 ? 'menang dalam ' + r.mate : 'kalah dalam ' + (-r.mate)) : ((r.best.evalCp || 0) / 100).toFixed(2)) : '';
    msg = [r.best ? 'Terbaik: ' + r.best.san + ' (' + sqName(r.best.from) + '→' + sqName(r.best.to) + ')' + (ev ? ' · eval ' + ev : '') : 'Tidak ada langkah.', 'ok'];
  } catch (e) {
    msg = [e.status === 429 ? 'Terlalu sering minta hint — tunggu sebentar.' : (e.message || 'Gagal menghitung hint.'), 'err'];
  }
  hintBusy = false; render();
}
function onGameDone() {
  resultShown = false;           // biarkan overlaysHtml menampilkan modal sekali untuk hasil ini
  hint = null; sel = -1; promo = null;
  vibrate([30, 60, 30]);
  stopPoll();
}

/* ============================================================
   SINKRONISASI MULTIPLAYER — polling POST /mp/sync (kontrak §3)
   Interval 2.5 dtk saat menunggu lawan, 4 dtk saat giliranmu
   (untuk menangkap tawaran seri / menyerah), berhenti saat game
   selesai atau tab tidak aktif. 429 -> mundur otomatis.
   ============================================================ */
function stopPoll() { pollGen++; clearTimeout(pollT); pollT = 0; }
function startPoll(immediate) {
  stopPoll();
  const gen = ++pollGen;
  const tick = async () => {
    if (gen !== pollGen) return;
    if (view !== 'game' || !game || !inTab()) return;          // berhenti sendiri saat keluar layar
    if (game.status !== 'active') return;
    if (document.hidden) { pollT = setTimeout(tick, 3000); return; }
    try {
      const r = await api('sync', { id: game.id, ply: myPly });
      if (gen !== pollGen) return;
      applySync(r);
      if (gen !== pollGen || !game || game.status !== 'active') return;
      pollT = setTimeout(tick, pollFast > Date.now() ? 5200 : (r.yourTurn ? 4000 : 2500));
    } catch (e) {
      if (gen !== pollGen) return;
      if (e.status === 404) { msg = ['Permainan tidak ditemukan.', 'err']; goLobby(); return; }
      if (e.status === 429) { pollFast = Date.now() + 20000; pollT = setTimeout(tick, 6000); return; }
      if (e.status === 401) { msg = ['Sesi berakhir — masuk lagi.', 'err']; render(); return; }
      pollT = setTimeout(tick, 4500);
    }
  };
  pollT = setTimeout(tick, immediate ? 350 : 2500);
}

async function applySync(r) {
  if (!game || r.id !== game.id) return;
  const prevBoard = game.board;
  if (Array.isArray(r.newMoves) && r.newMoves.length) {
    const last = r.newMoves[r.newMoves.length - 1];
    myPly = last.n;
    hint = null;
    // animasikan berurutan (maks 3 langkah terakhir; lebih dari itu langsung final)
    const seq = r.newMoves.slice(-3);
    if (r.newMoves.length <= 3) {
      let b = prevBoard;
      for (const m of seq) {
        const plan = planAnim(b, m.from, m.to);
        b = midBoard(b, m.from, m.to, m.promo);
        game.board = b; game.last = { f: m.from, t: m.to };
        render();
        runAnim(plan);
        if (seq.indexOf(m) < seq.length - 1) await sleep(300);
      }
    } else {
      game.board = r.board; game.last = r.last;
      render();
      const m = seq[seq.length - 1];
      runAnim(planAnim(prevBoard, m.from, m.to));
    }
    vibrate(12);
  }
  game.board = r.board; game.last = r.last; game.check = r.check;
  game.turn = r.turn; game.ply = r.ply != null ? r.ply : myPly;
  if (r.yourTurn !== undefined) game.yourTurn = r.yourTurn;
  game.moves = null;                       // sync tidak memuat langkah sah: ambil lewat game bila giliranku
  if (r.draw !== undefined) game.draw = r.draw;
  if (r.oppOnline !== undefined && game.opp) game.opp = { ...game.opp, online: r.oppOnline };
  if (r.reviewed !== undefined) game.reviewed = r.reviewed;
  if (r.status && r.status !== game.status) {
    game.status = r.status;
    if (r.result) game.result = r.result;
    if (r.pgn) game.pgn = r.pgn;
    if (game.status !== 'active') { render(); onGameDone(); render(); return; }
  }
  if (r.yourTurn && game.status === 'active') await fetchGame(game.id, true); // dapatkan moves utk interaksi
  else render();
}

async function fetchGame(id, quiet) {
  try {
    const r = await api('game', { id });
    if (r.game.id !== (game && game.id) && view === 'game' && game) { /* game sama saja */ }
    game = r.game; myPly = r.game.ply;
    if (view === 'game') render();
    return true;
  } catch (e) {
    if (e.status === 404) { toast('Permainan tidak ditemukan'); goLobby(); }
    else if (!quiet) { msg = [e.message || 'Gagal memuat permainan.', 'err']; render(); }
    return false;
  }
}

/* ---------- ruangan (host) ---------- */
function stopRoomPoll() { roomGen++; clearTimeout(roomT); clearTimeout(ttlT); roomT = 0; ttlT = 0; }
function startRoomPoll() {
  stopRoomPoll();
  const gen = ++roomGen;
  const code = room && room.code;
  if (!code) return;
  const tick = async () => {
    if (gen !== roomGen || !room || view !== 'host' || !inTab()) return;
    if (document.hidden) { roomT = setTimeout(tick, 3000); return; }
    try {
      const r = await api('room/status', { code });
      if (gen !== roomGen) return;
      if (r.status === 'matched' && r.gameId) {
        stopRoomPoll(); room = null;
        await fetchGame(r.gameId);
        if (game) { view = 'game'; gameFrom = 'lobby'; msg = ['', 'Permainan dimulai!']; render(); startPoll(true); }
        return;
      }
      if (r.status === 'gone') { stopRoomPoll(); room = null; msg = ['Kode ruangan sudah hangus atau dibatalkan.', 'err']; view = 'lobby'; loadLobby(); return; }
    } catch (e) {
      if (gen !== roomGen) return;
      if (e.status === 401) { msg = ['Sesi berakhir — masuk lagi.', 'err']; render(); return; }
    }
    roomT = setTimeout(tick, 2500);
  };
  roomT = setTimeout(tick, 2000);
  const exp = room.createdAt + (room.ttlMin || 60) * 60000;
  const paintTtl = () => {
    if (gen !== roomGen) return;
    const el = $('cm-ttl');
    if (!el) return;
    const left = exp - Date.now();
    if (left <= 0) { el.textContent = 'Kode sedang hangus…'; return; }
    const m = Math.floor(left / 60000), s = Math.floor((left % 60000) / 1000);
    el.textContent = 'Kode berlaku ' + m + ':' + String(s).padStart(2, '0');
    ttlT = setTimeout(paintTtl, 1000);
  };
  paintTtl();
}

async function createRoom() {
  if (busyMove) return;
  busyMove = true; msg = ['', ''];
  try {
    const color = pickColor === 'r' ? (Math.random() < .5 ? 'w' : 'b') : pickColor;
    const r = await api('room', { color });
    room = { code: r.code, color: r.color, ttlMin: r.ttlMin || 60, createdAt: Date.now() };
    view = 'host'; render(); startRoomPoll();
  } catch (e) { msg = [e.message || 'Gagal membuat ruangan.', 'err']; render(); }
  busyMove = false;
}
async function cancelRoom() {
  if (!room) return;
  const code = room.code;
  stopRoomPoll(); room = null; view = 'lobby'; msg = ['Ruangan dibatalkan.', ''];
  render();
  try { await api('cancel', { code }); } catch {}
  loadLobby();
}
async function joinRoom() {
  const inp = $('cmjoin');
  const code = (inp ? inp.value : '').trim().toUpperCase();
  if (!/^[A-Z2-9]{6}$/.test(code)) { msg = ['Kode ruangan 6 karakter (huruf & angka, tanpa 0/1/I/O).', 'err']; if (inp) inp.focus(); render(); return; }
  msg = ['Mencari ruangan…', '']; render();
  try {
    const r = await api('join', { code });
    game = r.game; myPly = r.game.ply; view = 'game'; gameFrom = 'lobby';
    msg = ['', r.game.yourTurn ? 'Kamu melangkah duluan!' : 'Lawan melangkah duluan.'];
    sel = -1; hint = null; promo = null; resultShown = false; drawShownFor = null;
    render(); startPoll(true);
  } catch (e) {
    msg = [e.message || 'Gagal masuk ruangan.', 'err']; render();
  }
}

/* ---------- lobby ---------- */
async function loadLobby(page) {
  const p = page || 0;
  lobby.loading = true; if (p === 0) lobby.games = null;
  render();
  try {
    const r = await api('games', { page: p });
    lobby.games = p === 0 ? r.games : (lobby.games || []).concat(r.games);
    lobby.page = r.page || p; lobby.more = !!r.more; lobby.active = r.active || 0; lobby.err = '';
  } catch (e) {
    if (e.status === 401) lobby.err = 'Sesi berakhir — masuk lagi.';
    else lobby.err = e.message || 'Gagal memuat daftar permainan.';
  }
  lobby.loading = false; render();
  loadStatsQuiet();
  paintHubTag();
}
async function loadStatsQuiet() {
  try {
    const r = await api('stats', {});
    stats.data = r; stats.user = '';
    if (view === 'lobby') render();
  } catch {}
}
async function openStats(user) {
  view = 'stats'; stats = { loading: true, err: '', data: null, user: user || '' };
  render();
  try {
    const r = await api('stats', user ? { user } : {});
    stats.data = r; stats.err = '';
  } catch (e) {
    stats.err = e.status === 404 ? 'Pemain itu tidak ditemukan.' : (e.message || 'Gagal memuat statistik.');
  }
  stats.loading = false; render();
}

/* ---------- review & replay ---------- */
async function openReview(id) {
  view = 'review'; gameFrom = (game && game.id === id) ? 'game' : 'lobby';
  review = { loading: true, err: '', data: null, pos: null, ply: 1, gameId: id };
  render();
  if (resCache.id === id && resCache.rv) {   // sudah dianalisis di latar belakang (modal hasil)
    review.data = resCache.rv; review.pos = resCache.rp; review.loading = false; review.ply = 1; render(); return;
  }
  const [rv, rp] = await Promise.allSettled([api('review', { id }), api('replay', { id })]);
  if (rv.status === 'rejected') {
    const e = rv.reason;
    review.loading = false;
    review.err = e.status === 409 ? (e.message || 'Analisis hanya untuk permainan yang sudah selesai.') : (e.message || 'Gagal menganalisis.');
    render(); return;
  }
  review.data = rv.value.review;
  review.pos = rp.status === 'fulfilled' ? rp.value : null;
  review.ply = 1;
  review.loading = false;
  render();
}
async function openReplay(id) {
  view = 'replay'; gameFrom = (game && game.id === id) ? 'game' : 'lobby';
  replay = { loading: true, err: '', data: null, idx: -1, playing: false, gameId: id };
  stopAuto();
  render();
  try {
    const r = await api('replay', { id });
    replay.data = r; replay.idx = -1; replay.loading = false;
    render();
  } catch (e) {
    replay.loading = false; replay.err = e.message || 'Gagal memuat replay.'; render();
  }
}
function stopAuto() { clearTimeout(autoT); autoT = 0; if (replay) replay.playing = false; }
function replayStep(dir) {
  const rp = replay.data;
  if (!rp) return;
  const N = rp.positions.length;
  const old = replay.idx;
  let ni = old;
  if (dir === 'first') ni = -1;
  else if (dir === 'last') ni = N - 1;
  else if (dir === 'prev') ni = Math.max(-1, old - 1);
  else if (dir === 'next') ni = Math.min(N - 1, old + 1);
  if (ni === old) return;
  replay.idx = ni;
  render();
  // animasi FLIP antar posisi bersebelahan
  if (!reduceMo() && Math.abs(ni - old) === 1) {
    const cur = ni >= 0 ? rp.positions[ni] : null;
    const prv = old >= 0 ? rp.positions[old] : null;
    if (ni > old && cur) runAnim(planAnim(posBeforeReplay(rp, ni), cur.from, cur.to));
    else if (prv) runAnim({ steps: [{ f: prv.to, t: prv.from }], ghosts: [] });   // mundur: bidak "kembali"
  }
  if (ni >= N - 1) stopAuto();
}
function posBeforeReplay(rp, idx) {
  if (idx <= 0) return rp.initial.board;
  return rp.positions[idx - 1] ? rp.positions[idx - 1].board : rp.initial.board;
}
function replayToggle() {
  const rp = replay.data;
  if (!rp) return;
  if (replay.playing) { stopAuto(); render(); return; }
  if (replay.idx >= rp.positions.length - 1) replay.idx = -1; // mulai lagi dari awal
  replay.playing = true; render();
  const step = () => {
    if (!replay.playing || !replay.data) return;
    if (replay.idx >= replay.data.positions.length - 1) { stopAuto(); render(); return; }
    replayStep('next');
    autoT = setTimeout(step, 950);
  };
  step();
}

/* ---------- navigasi ---------- */
function goLobby() {
  stopPoll(); stopRoomPoll(); stopAuto();
  view = 'lobby'; game = null; sel = -1; promo = null; hint = null;
  resultShown = false; drawShownFor = null;
  loadLobby();   // selalu segarkan: hasil/daftar permainan bisa saja berubah
}
function goBack() {
  if (gameFrom === 'game' && game) { view = 'game'; render(); if (game.status === 'active') startPoll(true); return; }
  goLobby();
}

/* ============================================================
   EVENT DELEGATION (data-cm; klik games.js mengabaikan atribut ini)
   ============================================================ */
function onHostClick(e) {
  const b = e.target.closest ? e.target.closest('[data-cm]') : null;
  if (!b || b.disabled) return;
  const a = b.dataset.cm;
  if (a === 'pick') { pickColor = b.dataset.v || 'r'; render(); }
  else if (a === 'createroom') createRoom();
  else if (a === 'cancelroom') cancelRoom();
  else if (a === 'join') joinRoom();
  else if (a === 'copycode') { copyText(room ? room.code : ''); toast('Kode disalin'); }
  else if (a === 'copypgn') { if (view === 'replay' && replay.data && replay.data.meta) { copyText(replay.data.meta.pgn || ''); toast('PGN disalin'); } else if (game && game.pgn) { copyText(game.pgn); toast('PGN disalin'); } }
  else if (a === 'reloadlobby') { msg = ['', '']; loadLobby(0); }
  else if (a === 'moregames') loadLobby(lobby.page + 1);
  else if (a === 'open') { msg = ['', '']; fetchGame(b.dataset.id).then(ok => { if (ok) { view = 'game'; gameFrom = 'lobby'; sel = -1; resultShown = false; drawShownFor = null; render(); if (game.status === 'active') startPoll(true); } }); }
  else if (a === 'review') { msg = ['', '']; resultShown = true; openReview(b.dataset.id); }
  else if (a === 'replay') { msg = ['', '']; resultShown = true; openReplay(b.dataset.id); }
  else if (a === 'openstats') { msg = ['', '']; gameFrom = 'lobby'; openStats(''); }
  else if (a === 'lookup') { const inp = $('cmuser'); openStats((inp ? inp.value : '').trim().toLowerCase()); }
  else if (a === 'lobby') goLobby();
  else if (a === 'back') goBack();
  else if (a === 'resign') {
    if (!resignArm) { resignArm = setTimeout(() => { resignArm = 0; render(); }, 2600); render(); }
    else { clearTimeout(resignArm); resignArm = 0; doResign(); }
  }
  else if (a === 'draw') doDraw('offer');
  else if (a === 'drawaccept') doDraw('accept');
  else if (a === 'drawdecline') doDraw('decline');
  else if (a === 'hint') doHint();
  else if (a === 'flip') { flip = !flip; render(); }
  else if (a === 'pickpromo') { if (promo) { const { from, to } = promo; promo = null; sendMove(from, to, b.dataset.p); } }
  else if (a === 'cancelpromo') { promo = null; render(); }
  else if (a === 'closeovl') { resultShown = true; render(); }
  else if (a === 'newgame') { resultShown = true; goLobby(); }
  else if (a === 'rematch') doRematch();
  else if (a === 'selmove') {
    const p = +b.dataset.ply;
    if (view === 'review') { review.ply = p; render(); }
    else if (view === 'replay' && replay.data) { replay.idx = p - 1; stopAuto(); render(); }
  }
  else if (a === 'rstep') {
    const v = b.dataset.v;
    const N = review.data ? review.data.moves.length : 0;
    if (v === 'first') review.ply = 1;
    else if (v === 'last') review.ply = N;
    else if (v === 'prev') review.ply = Math.max(1, review.ply - 1);
    else if (v === 'next') review.ply = Math.min(N, review.ply + 1);
    render();
  }
  else if (a === 'step') replayStep(b.dataset.v);
  else if (a === 'play') replayToggle();
}
function onHostKey(e) {
  if (e.key !== 'Enter') return;
  const t = e.target;
  if (t && t.id === 'cmjoin') { e.preventDefault(); joinRoom(); }
  else if (t && t.id === 'cmuser') { e.preventDefault(); openStats((t.value || '').trim().toLowerCase()); }
  else if (t && t.classList && t.classList.contains('cm-graph')) { /* grafik: biarkan click handler */ }
}

/* klik via keyboard (Enter di tombol kotak yang difokus): rute klik-klik */
function onHostKeyClick(e) {
  if (e.detail !== 0) return;                     // klik mouse/sentuhan sudah ditangani pointer events
  const sq = e.target.closest ? e.target.closest('[data-cm-sq]') : null;
  if (!sq || sq.disabled || view !== 'game' || !canPlay()) return;
  const i = +sq.dataset.i;
  if (sel >= 0 && i !== sel) {
    const ts = legalOf(sel);
    if (ts && ts.includes(i)) { tryMove(sel, i); return; }
  }
  const p = game.board[i];
  if (p !== '.' && isW(p) === (game.you === 'w') && legalOf(i)) setSel(i); else setSel(-1);
}

/* grafik evaluasi: klik/tap memilih ply; hover menampilkan tooltip */
function graphAt(e, svg) {
  const r = svg.getBoundingClientRect();
  const ev = review.data && review.data.ev;
  if (!ev || !ev.length) return -1;
  const x = Math.max(0, Math.min(r.width, e.clientX - r.left));
  const i = Math.round((x / r.width) * (ev.length - 1));
  return Math.max(0, Math.min(ev.length - 1, i));
}
function onGraph(e, svg) {
  if (view !== 'review' || !review.data) return;
  const i = graphAt(e, svg);
  if (i < 0) return;
  review.ply = Math.min(i, review.data.moves.length);   // index grafik = ply (0 = awal)
  render();
}
function onGraphMove(e, svg) {
  if (view !== 'review' || !review.data) return;
  const tip = host().querySelector('[data-cm-tip]');
  if (!tip) return;
  const i = graphAt(e, svg);
  if (i < 0) { tip.classList.remove('show'); return; }
  const ev = review.data.ev, mates = review.data.mates;
  const mv = i >= 1 ? review.data.moves[i - 1] : null;
  const val = ev[i] >= 90000 ? '+M' : ev[i] <= -90000 ? '-M' : (ev[i] / 100).toFixed(1);
  const mtxt = mates && mates[i] != null ? ' · mate ' + (mates[i] > 0 ? '+' : '') + mates[i] : '';
  tip.textContent = (mv ? mv.san + ' ' : (i === 0 ? 'awal ' : '')) + '(' + val + ')' + mtxt;
  const sr = svg.getBoundingClientRect(), wr = svg.parentElement.getBoundingClientRect();
  const px = Math.max(10, Math.min(sr.width - 10, e.clientX - sr.left));
  tip.style.left = (sr.left - wr.left + px) + 'px';
  tip.style.top = (sr.top - wr.top + 6) + 'px';
  tip.classList.add('show');
}
function onGraphLeave() { const tip = host().querySelector('[data-cm-tip]'); if (tip) tip.classList.remove('show'); }

/* slider replay */
function onSlider(e) {
  if (view !== 'replay' || !replay.data) return;
  const v = +e.target.value;
  stopAuto();
  replay.idx = v - 1;
  render();
}

/* ============================================================
   LIFECYCLE
   ============================================================ */
function attachOnce() {
  if (attached) return;
  attached = true;
  const b = host();
  b.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerUp);
  b.addEventListener('click', onHostClick);
  b.addEventListener('click', onHostKeyClick);
  b.addEventListener('keydown', onHostKey);
  b.addEventListener('input', e => { if (e.target && e.target.id === 'cmjoin') { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z2-9]/g, '').slice(0, 6); } });
  b.addEventListener('change', e => { if (e.target && e.target.dataset && e.target.dataset.cmSlider != null) onSlider(e); });
  b.addEventListener('pointermove', e => { const g = e.target && e.target.closest && e.target.closest('[data-cm-graph]'); if (g) onGraphMove(e, g); });
  b.addEventListener('click', e => { const g = e.target && e.target.closest && e.target.closest('[data-cm-graph]'); if (g) onGraph(e, g); });
  b.addEventListener('pointerleave', e => { const g = e.target && e.target.closest && e.target.closest('[data-cm-graph]'); if (g) onGraphLeave(); });
}
function resetAll() {
  stopPoll(); stopRoomPoll(); stopAuto();
  view = 'lobby'; lobby = { games: null, page: 0, more: false, active: 0, loading: false, err: '' };
  room = null; game = null; myPly = 0; sel = -1; promo = null; hint = null;
  review = { loading: false, err: '', data: null, pos: null, ply: 0, gameId: '' };
  replay = { loading: false, err: '', data: null, idx: -1, playing: false, gameId: '' };
  stats = { loading: false, err: '', data: null, user: '' };
  msg = ['', '']; resultShown = false; resultAnim = ''; resCache = { id: '', loading: false, rv: null, rp: null, err: '' }; drawShownFor = null; flip = false; resignArm = 0;
}
function suspend() { stopPoll(); stopRoomPoll(); stopAuto(); }   // keluar tab games / layar: timer berhenti, state tetap

window.addEventListener('shell:tab', e => {
  if (e.detail === 'games') { attachOnce(); if (view !== 'lobby' && view !== 'host') return; /* layar games.js di-set hub; pengguna menekan kartu untuk kembali */ }
  else suspend();
});
window.addEventListener('acct', () => {
  if (atok !== lastTok) { lastTok = atok; resetAll(); }
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && inTab() && view === 'game' && game && game.status === 'active' && !pollT) startPoll(true);
});

/* badge jumlah game aktif pada kartu hub (games.js) */
function paintHubTag() {
  const card = document.querySelector('.gm-card[data-g="chessmp"]');
  if (!card) return;
  let tag = card.querySelector('.gm-tag');
  if (lobby.active > 0) {
    if (!tag) { tag = document.createElement('span'); tag.className = 'gm-tag'; card.append(tag); }
    tag.textContent = lobby.active + ' permainan aktif';
  } else if (tag) tag.remove();
}

/* API untuk games.js */
window.CHMP = {
  enter() {
    attachOnce();
    if (atok !== lastTok) { lastTok = atok; resetAll(); }
    if (!atok || !aOn) { view = 'lobby'; render(); return; }
    if (view === 'game' && game && game.status === 'active') { render(); fetchGame(game.id, true).then(() => startPoll(true)); return; } // lanjutkan game berjalan
    if (view === 'host' && room) { render(); startRoomPoll(); return; }
    if ((view === 'review' || view === 'replay' || view === 'stats') && !review.loading && !replay.loading && !stats.loading) { render(); return; }
    view = 'lobby';
    if (!lobby.games && !lobby.loading) loadLobby(); else render();
  },
  render() { render(); },
  leave() { suspend(); }
};
})();
