/* ===== Fruit Slot Arcade — mesin slot buah 3x3 (tab Minigame, layar 'slot') =====
   Dimuat setelah games.js. Semua hasil (grid, kemenangan, combo, bonus, saldo VP) diputuskan SERVER
   (lib/slot.js) lewat /api/auth/slot*; file ini hanya menampilkan dan menganimasikan. Hasil spin
   DITENTUKAN SEBELUM animasi: respons memuat grid final, gulungan hanya memutarakannya — Turbo dan
   Quick Stop tidak pernah mengubah hasil.

   Dipanggil games.js: SLOT.enter() (buka layar, ambil keadaan, SFX start), SLOT.render(body) (gambar
   ulang; NO-OP kalau animasi berjalan supaya innerHTML tidak mematikan gulungan), SLOT.leave() (pulang
   ke hub: hentikan SFX & timer). Semua kelas CSS berprefix sl-, semua aksi data-act berprefix sl-
   (handler klik games.js mengabaikannya). Global index.html yang dipakai: atok, aOn, aApi, toast, store.

   SFX (public/sounds/slot/): start (masuk layar), spin (looping selama gulungan berputar), lose
   (kalah, TIDAK dimainkan kalau pemain menekan STOP), combo1-6 (sesuai level combo), combo7 (transisi
   Bonus Session). Tidak ada file audio lain. Satu SFX hasil pada satu waktu (tidak bertumpuk), volume
   + mute + Turbo diingat di localStorage. */

(() => {
'use strict';
const $ = id => document.getElementById(id);
const app = $('app');
const nf = new Intl.NumberFormat('id-ID');
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const reduceMo = () => !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
const host = () => $('gmbody');

const IC = { // ikon garis tipis (stroke currentColor), 24x24
  back: '<svg viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6"/></svg>',
  gear: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3.2"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.09a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55h.09a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.09a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1z"/></svg>',
  list: '<svg viewBox="0 0 24 24"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg>',
  table: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M3 9h18M9 9v11M15 9v11"/></svg>',
  bolt: '<svg viewBox="0 0 24 24"><path d="M13 2L4.5 13.5H11L9.5 22 19 10h-6.5z"/></svg>',
  star: '<svg viewBox="0 0 24 24"><path d="M12 3l2.2 5.2 5.3-.9-2.7 4.8 4.7 2.4-5.2 1.1 1.4 5-4.2-2.6-2.5 4.4-1.3-5.1-5.2 1.6 3-4.3L3 11.5l5-1.9L6 4.6l5.1 1.9z"/></svg>'
};
const VP = '<img src="/slot/vp.svg" alt="" draggable="false" class="sl-vpic">';
const symImg = (id, cls) => '<img src="/slot/' + esc(id) + '.svg" alt="" draggable="false"' + (cls ? ' class="' + cls + '"' : '') + '>';

// garis bayaran (sama dengan LINE_CELLS lib/slot.js): 3 baris + 2 diagonal, index = baris*3+kolom
const LINES = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 4, 8], [2, 4, 6]];
const LINE_COLOR = ['#ff5d8f', '#ffc94d', '#7bd88f', '#6ec3ff', '#c792ea'];

/* ---------- Keadaan ---------- */
let cfg = null;          // config publik dari server (simbol, garis, taruhan, combo, bonus, refill)
let st = null;           // keadaan terakhir dari server (bal, combo, bonus, hist, ...)
let failed = '';         // pesan gagal memuat
let on = false;          // layar slot sedang tampil
let busy = false;        // spin/antrean berjalan (tombol jadi STOP)
let stopReq = false;     // pemain menekan STOP: selesaikan putaran aktif, batalkan sisanya
let quicked = false;     // putaran aktif di-quick-stop (lose.mp3 tidak dimainkan)
let bonusPh = '';        // '' | 'intro' | 'rounds' | 'summary' (fase Bonus Session)
let modal = '';          // '' | 'pay' | 'set'
let betIx = 2, countIx = 0;
let lastGrid = null;    // grid terakhir yang sudah BERHENTI (dipakai render ulang antar putaran, supaya repaint tidak mengubah hasil di layar)
let noPaint = false;   // true = ada animasi yang tidak boleh diganggu (gulungan berputar / intro / ronde bonus); render() hanya menyegarkan angka
const COUNTS = [1, 5, 10];
let turbo = false, sfxVol = .8, sfxMute = false;
try { turbo = store.get('slturbo') === 1; const v = Number(store.get('slvol')); if (Number.isFinite(v) && v >= 0 && v <= 1) sfxVol = v; sfxMute = store.get('slmute') === 1; } catch { }
let remT0 = 0, remNext = 30 * 60e3, remIv = 0;   // pengingat durasi bermain
let refillIv = 0;

/* ---------- SFX: preload semua, satu oneshot pada satu waktu, spin looping terpisah ---------- */
const SFX = (() => {
  const files = { start: 'start.mp3', spin: 'spin.mp3', lose: 'lose.mp3', combo1: 'combo/combo1.mp3', combo2: 'combo/combo2.mp3', combo3: 'combo/combo3.mp3', combo4: 'combo/combo4.mp3', combo5: 'combo/combo5.mp3', combo6: 'combo/combo6.mp3', combo7: 'combo/combo7.mp3' };
  let pool = null, cur = null, loop = null;
  const ensure = () => { if (pool) return; pool = {}; for (const k in files) { try { const a = new Audio('/sounds/slot/' + files[k]); a.preload = 'auto'; pool[k] = a; } catch { } } };
  const apply = a => { try { a.volume = sfxMute ? 0 : sfxVol; } catch { } };
  const stopCur = () => { if (cur) { try { cur.pause(); cur.currentTime = 0; } catch { } } cur = null; };
  return {
    warm() { ensure(); },
    play(k) {
      ensure(); const a = pool && pool[k]; if (!a) return;
      if (cur === a) { try { a.currentTime = 0; } catch { } } else { stopCur(); cur = a; }
      apply(a); try { a.play().catch(() => { }); } catch { }
    },
    spinStart() { // looping selama gulungan berputar; berhenti saat semua selesai
      ensure(); const a = pool && pool.spin; if (!a || loop === a) return;
      if (loop) { try { loop.pause(); } catch { } }
      loop = a; try { a.loop = true; a.currentTime = 0; apply(a); a.play().catch(() => { }); } catch { }
    },
    spinStop() { if (loop) { try { loop.pause(); loop.currentTime = 0; loop.loop = false; } catch { } loop = null; } },
    stopAll() { this.spinStop(); stopCur(); },
    setVol(v, m) { sfxVol = v; sfxMute = m; if (pool) for (const k in pool) apply(pool[k]); }
  };
})();

/* ---------- Waktu animasi (Turbo/Quick Stop tidak pernah mengubah hasil) ---------- */
const T = () => turbo
  ? { reel: [360, 460, 560], stag: 90, banner: 800, gap: 140, hold: 500 }
  : { reel: [800, 1010, 1230], stag: 250, banner: 1500, gap: 380, hold: 900 };
const TRED = () => ({ reel: [150, 150, 150], stag: 0, banner: 650, gap: 120, hold: 500 });
const TT = () => reduceMo() ? TRED() : T();

/* ---------- Permintaan ke server ---------- */
async function api(path, body) {
  const r = await aApi(path ? 'slot/' + path : 'slot', body);
  if (r && r.ok) { st = r; if (r.cfg) cfg = r.cfg; return r; }
  throw new Error(r && r.error || 'Gagal terhubung ke server.');
}

/* ================= RENDER ================= */
// layar slot = dunia arcade gelapnya sendiri: seluruh area tab Minigame digelapkan (header tab disembunyikan,
// saldo coin/gems app tidak dipakai di sini). Kelas dilepas saat pulang ke daftar game / keluar tab.
const stageDark = on => { const g = document.getElementById('games'); if (g) g.classList.toggle('slot-on', !!on) };
function render() {
  const b = host(); if (!b) return;
  if (noPaint) { paintLive(); return; }             // animasi berjalan: jangan sentuh DOM gulungan/ronde
  stageDark(true);
  b.innerHTML = shellHtml();
  paintLive();
  SFX.warm();
}
function paintLive() { // bagian yang boleh diperbarui tanpa membangun ulang layar
  const b = host(); if (!b) return;
  const bal = b.querySelector('#slbal'), cb = b.querySelector('#slcombo'), bn = b.querySelector('#slbest');
  if (st && bal) bal.textContent = nf.format(st.bal);
  if (st && cb) {
    const c = st.combo || 0;
    cb.dataset.c = c; cb.classList.toggle('hot', c >= 4);
    const n = cb.querySelector('.sl-combo-n'); if (n) n.textContent = 'x' + c;
    const dots = cb.querySelector('.sl-combo-dots');
    if (dots) dots.innerHTML = Array.from({ length: cfg ? cfg.comboMax : 7 }, (_, i) => '<i' + (i < c ? ' class="on"' : '') + '></i>').join('');
  }
  if (st && bn && Number.isFinite(st.best)) bn.textContent = nf.format(st.best);
  const sp = b.querySelector('[data-act="sl-spin"]'); if (sp) sp.innerHTML = busy ? 'STOP' : 'SPIN <em>' + nf.format((cfg ? cfg.bets[betIx] : 0)) + ' VP</em>';
  setBusyUi();
}

function shellHtml() {
  if (failed) return '<button class="gm-back" type="button" data-act="hub">' + IC.back + 'Semua game</button>' +
    '<div class="gm-panel"><h2>Fruit Slot</h2><p class="gm-hint">' + esc(failed) + '</p>' +
    '<button class="gm-btn full" type="button" data-act="sl-retry">Coba lagi</button></div>';
  if (!st || !cfg) return '<button class="gm-back" type="button" data-act="hub">' + IC.back + 'Semua game</button>' +
    '<div class="gm-panel"><h2>Fruit Slot</h2><p class="gm-hint">Memuat mesin…</p></div>';
  if (st.bonus && !st.bonus.done) return bonusHtml();   // Bonus Session berjalan (termasuk lanjutan setelah muat ulang)
  if (st.bonus && st.bonus.done) return bonusSummaryHtml(st.bonus);
  return gameHtml();
}

function gameHtml() {
  const bet = cfg.bets[betIx], minBet = cfg.bets[0], broke = st.bal < minBet;
  const counts = COUNTS.map((n, i) => '<button type="button" class="sl-seg' + (i === countIx ? ' on' : '') + '" data-act="sl-count" data-i="' + i + '"' + (busy ? ' disabled' : '') + '>' + n + 'x</button>').join('');
  const dots = Array.from({ length: cfg.comboMax }, (_, i) => '<i' + (i < (st.combo || 0) ? ' class="on"' : '') + '></i>').join('');
  // gulungan diam memakai grid terakhir yang sudah berhenti (bukan pola default) supaya render ulang tidak mengubah isi layar
  const settled = lastGrid ? colsOf(lastGrid) : [0, 1, 2].map(c => [cfg.symbols[(c * 3) % cfg.symbols.length].id, cfg.symbols[(c * 3 + 1) % cfg.symbols.length].id, cfg.symbols[(c * 3 + 2) % cfg.symbols.length].id]);
  const fillers = settled.map((col, c) => '<div class="sl-reel" data-c="' + c + '"><div class="sl-strip">' +
    col.map(id => '<div class="sl-cell">' + symImg(id) + '</div>').join('') + '</div></div>').join('');
  return '<div class="sl-root" id="slroot">' +
    '<button class="gm-back" type="button" data-act="hub">' + IC.back + 'Semua game</button>' +

    '<div class="sl-top">' +
      '<div class="sl-bal"' + (broke ? ' data-broke="1"' : '') + '>' + VP + '<div><b id="slbal">' + nf.format(st.bal) + '</b><span>Virtual Point</span></div></div>' +
      '<div class="sl-tbtns">' +
        '<button type="button" class="sl-tbtn" data-act="sl-pay">' + IC.table + 'Paytable</button>' +
        '<button type="button" class="sl-tbtn" data-act="sl-set" aria-label="Pengaturan">' + IC.gear + '</button>' +
      '</div>' +
    '</div>' +

    '<div class="sl-cab">' +
      '<div class="sl-combo' + ((st.combo || 0) >= 4 ? ' hot' : '') + '" id="slcombo" data-c="' + (st.combo || 0) + '" aria-label="Combo ' + (st.combo || 0) + ' dari ' + cfg.comboMax + '">' +
        '<span class="sl-combo-l">COMBO</span><span class="sl-combo-dots">' + dots + '</span><b class="sl-combo-n">x' + (st.combo || 0) + '</b>' +
      '</div>' +
      '<div class="sl-stage">' +
        '<div class="sl-reels" data-act="sl-quick" role="grid" aria-label="Gulungan buah">' + fillers + '</div>' +
        '<svg class="sl-lines" viewBox="0 0 300 300" preserveAspectRatio="none" aria-hidden="true"></svg>' +
      '</div>' +
      '<div class="sl-banner" aria-live="polite"></div>' +
      '<div class="sl-remind" role="status"></div>' +
    '</div>' +

    (broke ? brokeHtml() : '') +

    '<div class="sl-ctrl">' +
      '<div class="sl-betrow">' +
        '<button type="button" class="sl-step" data-act="sl-betm" aria-label="Kurangi taruhan"' + (busy || betIx <= 0 ? ' disabled' : '') + '>&minus;</button>' +
        '<div class="sl-bet"><b>' + nf.format(bet) + '</b><span>VP / putaran</span></div>' +
        '<button type="button" class="sl-step" data-act="sl-betp" aria-label="Tambah taruhan"' + (busy || betIx >= cfg.bets.length - 1 ? ' disabled' : '') + '>+</button>' +
        '<button type="button" class="sl-max" data-act="sl-max"' + (busy ? ' disabled' : '') + '>MAX</button>' +
      '</div>' +
      '<div class="sl-countrow" role="group" aria-label="Jumlah putaran">' + counts + '</div>' +
      '<button type="button" class="sl-spin' + (busy ? ' stop' : '') + '" data-act="sl-spin">' + (busy ? 'STOP' : 'SPIN <em>' + nf.format(bet) + ' VP</em>') + '</button>' +
      '<div class="sl-turbo' + (turbo ? ' on' : '') + '"><button type="button" data-act="sl-turbo" aria-pressed="' + turbo + '">' + IC.bolt + 'Turbo</button><span>animasi cepat — hasil tetap sama</span></div>' +
    '</div>' +
    '<div class="sl-stat"><span><b>' + nf.format(st.spins || 0) + '</b>putaran</span><span><b>' + nf.format(st.wins || 0) + '</b>menang</span><span><b id="slbest">' + nf.format(st.best || 0) + '</b>menang terbesar</span></div>' +
  '</div>';
}

function brokeHtml() { // saldo di bawah taruhan terkecil: panel isi ulang gratis (server yang menjamin waktunya)
  const ready = st.refillReady, left = Math.max(0, Math.ceil(((st.refillAt || 0) - Date.now()) / 60e3));
  return '<div class="sl-broke"><b>Saldo virtual point habis</b>' +
    '<p>Isi ulang gratis ' + nf.format(cfg.refill.amount) + ' VP — virtual point tidak bisa dibeli atau ditukar, jadi pengisiannya cuma ini.</p>' +
    '<button type="button" class="sl-refill" data-act="sl-refill"' + (ready ? '' : ' disabled') + '>' +
      (ready ? 'Isi ulang gratis ' + nf.format(cfg.refill.amount) + ' VP' : 'Isi ulang tersedia dalam ' + left + ' menit') + '</button></div>';
}

/* ---------- Bonus Session ---------- */
function bonusHtml() {
  const b = st.bonus, r = Math.min(b.r + 1, cfg.bonusRounds);
  const cards = Array.from({ length: cfg.bonusRounds }, (_, i) => {
    const got = b.log && b.log[i] != null;
    return '<div class="sl-bcard' + (i < b.r ? ' done' : i === b.r ? ' now' : '') + '"><span>RONDE ' + (i + 1) + '</span>' +
      (got ? '<b>+' + nf.format(b.log[i]) + '</b>' : '<i>' + (i === b.r ? 'siap' : '·') + '</i>') + '</div>';
  }).join('');
  return '<div class="sl-root" id="slroot">' +
    '<button class="gm-back" type="button" data-act="hub">' + IC.back + 'Semua game</button>' +
    '<div class="sl-top"><div class="sl-bal">' + VP + '<div><b id="slbal">' + nf.format(st.bal) + '</b><span>Virtual Point</span></div></div>' +
      '<div class="sl-tbtns"><button type="button" class="sl-tbtn" data-act="sl-pay">' + IC.table + 'Paytable</button><button type="button" class="sl-tbtn" data-act="sl-set" aria-label="Pengaturan">' + IC.gear + '</button></div></div>' +
    '<div class="sl-bov">' +
      (bonusPh === 'intro' ? introHtml() : '') +
      '<div class="sl-bhead"><span class="sl-btag">' + IC.star + 'BONUS SESSION</span>' +
        '<div class="sl-bprog"><span>RONDE ' + r + '/' + cfg.bonusRounds + '</span><div class="sl-bdots">' +
          Array.from({ length: cfg.bonusRounds }, (_, i) => '<i' + (i < b.r ? ' class="on"' : '') + '></i>').join('') + '</div></div>' +
        '<div class="sl-btot"><span>Terkumpul</span><b>' + nf.format(b.total || 0) + ' VP</b></div></div>' +
      '<div class="sl-bcards">' + cards + '</div>' +
      '<div class="sl-bstage"><div class="sl-bmini" aria-hidden="true">' +
        Array.from({ length: 3 }, () => '<span class="sl-bm">' + symImg('seven') + '</span>').join('') + '</div>' +
        '<b class="sl-breward" aria-live="polite"></b></div>' +
      '<button type="button" class="sl-bgo" data-act="sl-bgo">PUTAR RONDE ' + r + '</button>' +
      '<p class="sl-bnote">Tanpa biaya VP. Hasil tiap ronde ditentukan server; total masuk saldo sekali setelah ronde ' + cfg.bonusRounds + '.</p>' +
    '</div></div>';
}
function introHtml() {
  return '<div class="sl-bintro" aria-hidden="true"><b>COMBO x7</b><i>BONUS SESSION</i></div>';
}
function bonusSummaryHtml(b) { // ronde 3 selesai (termasuk saat halaman dimuat ulang tepat setelahnya)
  return '<div class="sl-root" id="slroot">' +
    '<button class="gm-back" type="button" data-act="hub">' + IC.back + 'Semua game</button>' +
    '<div class="sl-top"><div class="sl-bal">' + VP + '<div><b id="slbal">' + nf.format(st.bal) + '</b><span>Virtual Point</span></div></div></div>' +
    '<div class="sl-bov">' +
      '<div class="sl-bhead"><span class="sl-btag">' + IC.star + 'BONUS SELESAI</span></div>' +
      '<div class="sl-bcards">' + (b.log || []).map((v, i) => '<div class="sl-bcard done"><span>RONDE ' + (i + 1) + '</span><b>+' + nf.format(v) + '</b></div>').join('') + '</div>' +
      '<div class="sl-btotal"><span>Total bonus masuk saldo</span><b>+' + nf.format(b.total || 0) + ' VP</b></div>' +
      '<button type="button" class="sl-bgo" data-act="sl-bdone">Kembali bermain</button>' +
    '</div></div>';
}

/* ---------- Modal: Paytable & Pengaturan ---------- */
function payHtml() {
  const bet = cfg.bets[betIx], lb = bet / cfg.lines;
  const rows = [...cfg.symbols].sort((a, b) => (b.pay3 || 0) - (a.pay3 || 0)).map(s =>
    '<div class="sl-prow">' +
      '<span class="sl-psym">' + symImg(s.id) + symImg(s.id) + symImg(s.id) + '</span>' +
      '<b>' + esc(s.name) + '</b><i>3 sejenis</i><em>+' + nf.format(s.pay3 * lb) + ' VP</em>' +
    '</div>').join('');
  const cherry = cfg.symbols.find(s => s.id === 'cherry');
  const lineDots = LINES.map((cells, li) => '<div class="sl-pline" aria-label="Garis ' + (li + 1) + '">' +
    Array.from({ length: 9 }, (_, i) => '<i' + (cells.includes(i) ? ' class="on" style="--lc:' + LINE_COLOR[li] + '"' : '') + '></i>').join('') + '</div>').join('');
  return '<div class="sl-modal" data-act="sl-mclose" role="dialog" aria-modal="true" aria-label="Paytable">' +
    '<div class="sl-mbox" data-stop="1">' +
      '<div class="sl-mhead"><h3>Paytable</h3><button type="button" class="sl-mx" data-act="sl-mclose" aria-label="Tutup">&times;</button></div>' +
      '<p class="sl-msub">Taruhan <b>' + nf.format(bet) + ' VP</b> = ' + cfg.lines + ' garis &times; ' + nf.format(lb) + ' VP. Semua angka mengikuti taruhanmu sekarang.</p>' +
      '<div class="sl-prows">' + rows + '</div>' +
      (cherry && cherry.pay2 ? '<div class="sl-prow cherry"><span class="sl-psym">' + symImg('cherry') + symImg('cherry') + '</span><b>Ceri</b><i>2 di satu garis</i><em>+' + nf.format(cherry.pay2 * lb) + ' VP</em></div>' : '') +
      '<h4>Garis bayaran</h4><div class="sl-plines">' + lineDots + '</div>' +
      '<h4>Combo &amp; Bonus Session</h4>' +
      '<p class="sl-mnote">Menang menaikkan combo +1, kalah me-reset. <b>Combo x' + cfg.comboMax + '</b> membuka Bonus Session: ' + cfg.bonusRounds + ' ronde tanpa biaya VP, reward dari pool khusus, totalnya masuk saldo sekali setelah ronde terakhir.</p>' +
    '</div></div>';
}
function setHtml() {
  const hists = (st.hist || []).map(h => {
    const bonus = h.g === 'bonus';
    const t = h.at ? new Date(h.at) : null;
    return '<div class="sl-hrow' + (h.win > 0 ? ' win' : '') + '"><span class="sl-ht">' + (t ? String(t.getHours()).padStart(2, '0') + '.' + String(t.getMinutes()).padStart(2, '0') : '') + '</span>' +
      (bonus ? '<b class="sl-hb">BONUS</b>' : '<b>' + (h.win > 0 ? '+' : '') + nf.format(h.win - (bonus ? 0 : h.bet)) + '</b>') +
      '<span>' + (bonus ? 'ronde bonus' : 'taruhan ' + nf.format(h.bet) + ' · ' + (h.win > 0 ? 'menang ' + nf.format(h.win) : 'kalah')) + '</span></div>';
  }).join('');
  return '<div class="sl-modal" data-act="sl-mclose" role="dialog" aria-modal="true" aria-label="Pengaturan">' +
    '<div class="sl-mbox" data-stop="1">' +
      '<div class="sl-mhead"><h3>Pengaturan</h3><button type="button" class="sl-mx" data-act="sl-mclose" aria-label="Tutup">&times;</button></div>' +
      '<div class="sl-setrow"><div><b>Volume</b><span>Semua sound effect permainan</span></div>' +
        '<input type="range" min="0" max="100" step="5" value="' + Math.round(sfxVol * 100) + '" data-act="sl-vol" aria-label="Volume"></div>' +
      '<div class="sl-setrow"><div><b>Suara mati</b><span>Matikan semua SFX</span></div>' +
        '<button type="button" class="sl-sw' + (sfxMute ? ' on' : '') + '" data-act="sl-mute" role="switch" aria-checked="' + sfxMute + '"><i></i></button></div>' +
      '<div class="sl-setrow"><div><b>' + IC.bolt + 'Turbo</b><span>Animasi gulungan lebih cepat — hasil tidak berubah</span></div>' +
        '<button type="button" class="sl-sw' + (turbo ? ' on' : '') + '" data-act="sl-turbo" role="switch" aria-checked="' + turbo + '"><i></i></button></div>' +
      '<h4>Riwayat putaran</h4>' +
      '<div class="sl-hists">' + (hists || '<p class="sl-mnote">Belum ada putaran.</p>') + '</div>' +
      '<p class="sl-mnote">Virtual point hanya untuk permainan: tidak bisa dibeli dan tidak bisa ditukar menjadi coin, gems, atau uang.</p>' +
    '</div></div>';
}

/* ================= GULUNGAN ================= */
const FILLER_N = 15; // sel iseng di atas 3 sel final (kosmetik; hasil tetap dari server)
let curAnims = [];   // animasi strip yang sedang jalan (untuk Quick Stop)

function stripHtml(finalCol) { // finalCol = [idSimbol baris atas..bawah]
  const ids = cfg.symbols.map(s => s.id);
  let out = '';
  for (let i = 0; i < FILLER_N; i++) out += '<div class="sl-cell">' + symImg(ids[(Math.random() * ids.length) | 0]) + '</div>';
  for (const id of finalCol) out += '<div class="sl-cell">' + symImg(id) + '</div>';
  return out;
}
const cellH = reel => { const c = reel.querySelector('.sl-cell'); if (!c) return 80; const h = c.getBoundingClientRect().height; return h > 10 ? h : 80; };

// Putar 3 gulungan lalu berhenti berurutan (kiri -> tengah -> kanan). Grid final dari server.
function spinReels(cols) {
  const t = TT();
  const reels = [...host().querySelectorAll('.sl-reel')];
  SFX.spinStart();
  const anims = [];
  reels.forEach((reel, i) => {
    const strip = reel.querySelector('.sl-strip');
    strip.innerHTML = stripHtml(cols[i]);
    strip.getAnimations().forEach(a => a.cancel());
    strip.style.transform = '';
    const off = FILLER_N * cellH(reel);
    const blurT = setTimeout(() => strip.classList.add('fast'), 30);
    const a = strip.animate(
      [{ transform: 'translateY(0)' }, { transform: 'translateY(-' + off + 'px)' }],
      { duration: t.reel[i], delay: i * t.stag, easing: 'cubic-bezier(.15,.6,.16,1)', fill: 'forwards' }
    );
    const unblur = setTimeout(() => strip.classList.remove('fast'), (t.reel[i] + i * t.stag) * .6);
    a.finished.then(() => {
      clearTimeout(blurT); clearTimeout(unblur); strip.classList.remove('fast');
      reel.classList.add('land'); setTimeout(() => reel.classList.remove('land'), 240);
    });
    anims.push(a);
  });
  curAnims = anims;
  const total = t.reel[2] + 2 * t.stag + 400;
  // pengaman: kalau finish() Quick Stop tidak memicu 'finished' di browser tertentu, tetap lanjut
  return Promise.race([Promise.all(anims.map(a => a.finished)).then(() => { SFX.spinStop(); curAnims = []; }), sleep(total)]).then(() => { SFX.spinStop(); });
}
function quickStop() { // percepat putaran AKTIF tanpa mengubah hasil (animasi melompat ke akhir)
  if (!curAnims.length) return;
  quicked = true;
  curAnims.forEach(a => { try { a.finish(); } catch { } });
}
// setelah berhenti: normalisasi strip jadi 3 sel final di posisi atas (transform bersih)
function settleReels(cols) {
  host().querySelectorAll('.sl-reel').forEach((reel, i) => {
    const strip = reel.querySelector('.sl-strip');
    strip.getAnimations().forEach(a => a.cancel());
    strip.style.transform = '';
    strip.innerHTML = cols[i].map(id => '<div class="sl-cell">' + symImg(id) + '</div>').join('');
  });
}
function clearWinFx() {
  const root = host().querySelector('.sl-cab'); if (!root) return;
  root.classList.remove('flash');
  root.querySelectorAll('.sl-cell.win').forEach(c => c.classList.remove('win'));
  const svg = root.querySelector('.sl-lines'); if (svg) svg.innerHTML = '';
}
function showWins(lines, comboLv) { // sorot sel + garis pemenang, kilat kabinet
  const root = host().querySelector('.sl-cab'); if (!root) return;
  const cells = [...root.querySelectorAll('.sl-reel')];
  const svg = root.querySelector('.sl-lines');
  let svgOut = '';
  for (const l of lines) {
    for (const ci of LINES[l.line]) {
      const r = Math.floor(ci / 3), c = ci % 3;
      const cell = cells[c] && cells[c].querySelectorAll('.sl-cell')[r];
      if (cell) cell.classList.add('win');
    }
    const pts = LINES[l.line].map(ci => ((ci % 3) * 100 + 50) + ',' + (Math.floor(ci / 3) * 100 + 50)).join(' ');
    svgOut += '<polyline points="' + pts + '" style="stroke:' + LINE_COLOR[l.line] + '"/>';
  }
  if (svg) svg.innerHTML = svgOut;
  if (comboLv >= 4) { root.classList.add('flash'); setTimeout(() => root.classList.remove('flash'), 1200); }
}
function banner(txt, cls) {
  const b = host().querySelector('.sl-banner'); if (!b) return;
  b.className = 'sl-banner show ' + (cls || '');
  b.innerHTML = txt;
  clearTimeout(banner._t);
  banner._t = setTimeout(() => { b.className = 'sl-banner'; b.textContent = ''; }, TT().banner + 200);
}
function burst(n, gold) { // percikan ringan (transform/opacity saja, buang sendiri)
  const root = host().querySelector('.sl-cab'); if (!root || reduceMo()) return;
  for (let i = 0; i < n; i++) {
    const p = document.createElement('i');
    p.className = 'sl-spark' + (gold ? ' gold' : '');
    p.style.left = (12 + Math.random() * 76) + '%';
    p.style.top = (14 + Math.random() * 66) + '%';
    p.style.setProperty('--dx', (Math.random() * 120 - 60).toFixed(0) + 'px');
    p.style.setProperty('--dy', (-40 - Math.random() * 110).toFixed(0) + 'px');
    root.appendChild(p);
    setTimeout(() => p.remove(), 950);
  }
}

/* ================= ALUR SPIN ================= */
const colsOf = grid => [0, 1, 2].map(c => [grid[c], grid[3 + c], grid[6 + c]]); // grid index baris*3+kolom -> kolom gulungan

function setBusyUi() {
  const root = host().querySelector('.sl-root'); if (!root) return;
  root.classList.toggle('busy', busy);
  root.querySelectorAll('.sl-step,.sl-max,.sl-seg').forEach(b => { b.disabled = busy; });
}

async function doSpin() {
  if (bonusPh || !st || !cfg) return;
  if (busy) { // tombol sedang jadi STOP: hentikan antrean + percepat putaran aktif
    stopReq = true; quickStop();
    return;
  }
  const bet = cfg.bets[betIx];
  if (st.bal < bet) { banner('Saldo VP tidak cukup', 'dim'); render(); return; }
  busy = true; stopReq = false; quicked = false; paintLive(); SFX.warm();
  let left = COUNTS[countIx];
  try {
    while (left > 0 && !stopReq) {
      if ((st.bal || 0) < bet) { banner('Saldo VP tidak cukup', 'dim'); break; } // auto-spin berhenti saat saldo kurang
      let r;
      try { r = await api('spin', { bet }); }
      catch (e) {
        banner(e.message || 'Gagal memutar', 'dim');
        try { await api(''); } catch { }          // sinkronkan ulang saldo/combo dari server
        break;
      }
      const res = await presentSpin(r);
      left--;
      if (res === 'bonus') { busy = false; return; } // Bonus Session mengambil alih layar
      if (stopReq) break;
      await sleep(TT().gap);
    }
  } finally {
    busy = false; stopReq = false; paintLive();
    if (!bonusPh) { render(); remindMaybe(true); }
  }
}

// Tampilkan satu hasil: gulungan -> sorotan -> banner + SFX hasil (SETELAH spin selesai, tidak bertumpuk)
async function presentSpin(r) {
  const cols = colsOf(r.grid);
  clearWinFx();
  noPaint = true;                                  // gulungan beranimasi: render() dari luar tidak boleh membangun ulang DOM
  await spinReels(cols);
  settleReels(cols);
  lastGrid = r.grid;
  if (r.win > 0) showWins(r.lines || [], r.combo || 0);
  noPaint = false;                                 // papan sudah diam: render ulang kembali aman (lastGrid dipakai)
  const t = TT();
  if (r.win > 0) {
    const big = r.win >= r.bet * 10;
    banner('<b>MENANG +' + nf.format(r.win) + '</b>' + (big ? '<i>BIG WIN!</i>' : '') + ((r.combo || 0) >= 2 ? '<u>COMBO x' + r.combo + '</u>' : ''), big ? 'big' : 'win');
    burst(big ? 16 : 8, true);
    if (r.bonusHit) SFX.play('combo7');          // combo 7: SFX panjang transisi Bonus Session
    else SFX.play('combo' + Math.min(r.combo, 6)); // combo 1-6 sesuai levelnya
  } else {
    if (!quicked) SFX.play('lose');              // pemain menekan STOP: tanpa lose.mp3
    banner('Zonk…', 'dim');
  }
  paintLive();
  await sleep(t.hold);
  if (r.bonusHit) { await enterBonus(); return 'bonus'; }
  return 'ok';
}

/* ================= BONUS SESSION ================= */
async function enterBonus() {
  bonusPh = 'intro';
  noPaint = false; render(); noPaint = true;       // pasang intro, lalu kunci selama animasinya (repaint akan memutar ulang CSS intro)
  const cab = host().querySelector('.sl-cab');
  if (cab) burst(22, true);
  await sleep(reduceMo() ? 700 : 3400);          // combo7.mp3 (9,6 dtk) mengiringi transisi, ekornya menyusul ke ronde 1
  bonusPh = 'rounds';
  noPaint = false; render();                       // layar ronde menunggu pemain: render/modal kembali boleh
}
async function bonusGo() {
  if (busy || !st || !st.bonus || bonusPh !== 'rounds') return;
  busy = true; paintLive();
  try {
    const r = await api('bonus', {});
    noPaint = true;                               // animasi ronde berjalan: jangan dibangun ulang
    await presentBonusRound(r);
    noPaint = false;
    busy = false;
    if (r.done) { bonusPh = 'summary'; render(); }
    else render();
  } catch (e) {
    noPaint = false; busy = false; toast(e.message || 'Gagal memutar ronde bonus'); render();
  }
}

async function presentBonusRound(r) {
  const b = host().querySelector('.sl-bov'); if (!b) { await sleep(200); return; }
  const mini = [...b.querySelectorAll('.sl-bm')];
  const rw = b.querySelector('.sl-breward');
  const btn = b.querySelector('.sl-bgo'); if (btn) btn.disabled = true;
  const t = TT();
  SFX.play('spin');                              // petunjuk suara putaran ronde (file yang sama, sekali jalan)
  const anims = mini.map((m, i) => {
    const ids = cfg.symbols.map(s => s.id);
    let n = 0;
    const iv = setInterval(() => { m.innerHTML = symImg(ids[(Math.random() * ids.length) | 0]); if (++n > 30) clearInterval(iv); }, 70);
    return sleep((reduceMo() ? 200 : 700) + i * (reduceMo() ? 60 : 260)).then(() => {
      clearInterval(iv);
      m.innerHTML = symImg(r.sym); m.classList.add('hit');
      SFX.play('combo' + Math.min(4 + i, 6));    // dentang tiap gulungan ronde mendarat
    });
  });
  await Promise.all(anims);
  await sleep(160);
  if (rw) { rw.textContent = '+' + nf.format(r.reward) + ' VP'; rw.classList.add('pop'); }
  const tot = b.querySelector('.sl-btot b');
  if (tot) { // akumulasi real-time
    const from = r.total - r.reward, to = r.total, t0 = performance.now(), dur = reduceMo() ? 200 : 700;
    await new Promise(res => {
      const tick = now => {
        const k = Math.min(1, (now - t0) / dur), v = Math.round(from + (to - from) * (1 - Math.pow(1 - k, 3)));
        tot.textContent = nf.format(v) + ' VP';
        k < 1 ? requestAnimationFrame(tick) : res();
      };
      requestAnimationFrame(tick);
    });
  }
  burst(12, true);
  await sleep(r.done ? 600 : t.hold);
  if (btn) btn.disabled = false;
}
async function bonusDone() { // ringkasan ditutup pemain: bersihkan bonus di server, kembali ke mode normal
  try { await api('', { clear: true }); } catch { }
  bonusPh = '';
  render();
}

/* ================= INTERAKSI ================= */
host().addEventListener('click', e => {
  const b = e.target.closest('[data-act]');
  if (!b || b.disabled) return;
  const a = b.dataset.act;
  if (!a.startsWith('sl-')) return;                        // aksi milik games.js (hub, login, dsb.)
  if (a === 'sl-spin') doSpin();
  else if (a === 'sl-quick') { if (busy) quickStop(); } // ketuk papan = percepat putaran AKTIF saja (antrean tetap jalan; hanya tombol STOP yang membatalkan)
  else if (a === 'sl-betm') { if (!busy && betIx > 0) { betIx--; render(); } }
  else if (a === 'sl-betp') { if (!busy && betIx < cfg.bets.length - 1) { betIx++; render(); } }
  else if (a === 'sl-max') { if (!busy && cfg) { let ix = 0; cfg.bets.forEach((v, i) => { if (v <= (st.bal || 0)) ix = i; }); betIx = ix; render(); } }
  else if (a === 'sl-count') { if (!busy) { countIx = Number(b.dataset.i) || 0; render(); } }
  else if (a === 'sl-turbo') { turbo = !turbo; try { store.set('slturbo', turbo ? 1 : 0); } catch { } paintWithModal(); }
  else if (a === 'sl-pay') { modal = 'pay'; paintWithModal(); }
  else if (a === 'sl-set') { modal = 'set'; paintWithModal(); }
  else if (a === 'sl-mute') { sfxMute = !sfxMute; try { store.set('slmute', sfxMute ? 1 : 0); } catch { } SFX.setVol(sfxVol, sfxMute); paintWithModal(); }
  else if (a === 'sl-mclose') { if (!e.target.closest('[data-stop]') || e.target.closest('.sl-mx')) { modal = ''; render(); } }
  else if (a === 'sl-bgo') bonusGo();
  else if (a === 'sl-bdone') bonusDone();
  else if (a === 'sl-retry') enter(true);
  else if (a === 'sl-refill') refill(b);
});
host().addEventListener('input', e => {
  if (e.target.dataset.act === 'sl-vol') {
    sfxVol = Number(e.target.value) / 100;
    try { store.set('slvol', sfxVol); } catch { }
    SFX.setVol(sfxVol, sfxMute);
  }
});
document.addEventListener('keydown', e => {
  if (!on || modal || e.repeat) return;
  const ae = document.activeElement;
  if (ae && ae !== document.body && ae.closest && ae.closest('button,input,textarea,[role="switch"]')) return; // tombol fokus: klik native sudah cukup
  if (e.code === 'Space') { e.preventDefault(); doSpin(); }
  else if (e.key === 'Escape' && modal) { modal = ''; render(); }
});

async function refill(btn) {
  if (btn.disabled) return; btn.disabled = true;
  try {
    await api('refill', {});
    toast('Saldo virtual point terisi ' + nf.format(cfg.refill.amount) + ' VP');
  } catch (err2) { toast(err2.message || 'Gagal mengisi ulang'); }
  render();
}

/* ================= SIKLUS LAYAR ================= */
function modalNow() { return modal ? (modal === 'pay' ? payHtml() : setHtml()) : ''; }

function paintWithModal() { render(); const b = host(); if (b && modal) b.insertAdjacentHTML('beforeend', modalNow()); }

async function enter(retry) {
  on = true; failed = retry ? '' : failed; modal = '';
  if (!st) render();
  try { await api('', {}); failed = ''; if (st.bonus && !st.bonus.done) bonusPh = 'rounds'; else if (st.bonus && st.bonus.done) bonusPh = 'summary'; else bonusPh = ''; }
  catch (e) { failed = e.message || 'Gagal memuat.'; }
  betIx = Math.min(betIx, cfg ? cfg.bets.length - 1 : 2);
  render();
  paintWithModal();
  SFX.warm();
  SFX.play('start');                              // permainan dimulai (sekali per masuk layar)
  remT0 = Date.now(); remNext = 30 * 60e3; remindStart();
}
function leave() { // pulang ke daftar game / keluar tab Minigame
  on = false; bonusPh = ''; modal = ''; noPaint = false; stageDark(false);
  SFX.stopAll(); remindStop();
  if (busy) { stopReq = true; quickStop(); }      // putaran aktif tetap diselesaikan datanya, tanpa suara
}
window.addEventListener('shell:tab', e => { if (e.detail !== 'games') leave(); });

/* ---------- Pengingat durasi bermain (tiap 30 menit pertama, lalu tiap 15 menit) ---------- */
function remindStart() {
  remindStop();
  remIv = setInterval(() => {
    if (!on || document.hidden) return;
    remindMaybe(false);
  }, 30e3);
}
function remindStop() { clearInterval(remIv); remIv = 0; }
function remindMaybe(force) {
  if (!on) return;
  const played = Date.now() - remT0;
  if (played < remNext) return;
  remNext += remNext <= 30 * 60e3 ? 15 * 60e3 : 15 * 60e3;
  const box = host().querySelector('.sl-remind'); if (!box) return;
  const mins = Math.round(played / 60e3);
  box.textContent = 'Sudah bermain ' + (mins >= 60 ? Math.floor(mins / 60) + ' jam ' + (mins % 60) + ' menit' : mins + ' menit') + ' — sempatkan istirahat sebentar ya.';
  box.classList.add('show');
  setTimeout(() => box.classList.remove('show'), 8000);
}

/* ---------- Isi ulang: label hitung menang terbaru ---------- */
setInterval(() => {
  if (!on || busy || bonusPh || !st || !cfg || !host().querySelector('.sl-refill')) return;
  if ((st.bal || 0) >= cfg.bets[0]) return;
  const left = Math.max(0, Math.ceil(((st.refillAt || 0) - Date.now()) / 60e3));
  const btn = host().querySelector('.sl-refill');
  if (left <= 0) { btn.disabled = false; btn.textContent = 'Isi ulang gratis ' + nf.format(cfg.refill.amount) + ' VP'; }
  else { btn.disabled = true; btn.textContent = 'Isi ulang tersedia dalam ' + left + ' menit'; }
}, 5e3);

/* ================= API PUBLIK (games.js) ================= */
window.SLOT = {
  enter, leave,
  active: () => on,
  render(h) { if (h && !host()) return; render(); paintWithModal(); }
};
})();
