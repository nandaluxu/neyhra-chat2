/* ===== Level Akun (XP + level pemain) =====
   Spesifikasi: docs/frontend/leveling-system.md (README #8). Ini level AKUN pemain, BUKAN level hubungan karakter.
   Semua angka (XP, cap, pengali, hadiah level-up) DIPUTUSKAN SERVER dan hanya ditampilkan di sini; client tidak pernah
   menghitung atau mengirim XP. Teks dari data selalu lewat textContent.

   Dimuat sebelum profile.js. Memakai global index.html: atok, aApi, store, loadWallet, saveWallet. Pintu untuk layar lain:
     LEVEL.set(n)          -> pasang angka badge header (null = sembunyikan; dipanggil saveWallet saat login/keluar)
     LEVEL.gain(lv)        -> respons `lv` dari /api/gc/send & /api/online: { level, xp, levelUp: { from, to, reward:{c,g} } | null }
                              (levelUp -> toast + badge naik + saldo header ikut naik dari reward)
     LEVEL.nq(list)        -> daftar `nq` dari respons game: teks \"Naik ke Level X! ...\" -> toast + badge (saldo sudah dari respons game)
     LEVEL.chip(mul)       -> HTML chip \"Hadiah ×1,06\" untuk layar minigame (mul dari respons `view`; kosong bila belum diketahui)
     LEVEL.panel(el)       -> gambar panel Level Akun ke dalam elemen (dipakai tab Level di Profil)
     LEVEL.open()          -> buka Profil > tab Level
   Tidak ada polling: panel menyegarkan diri tiap kali dibuka; level-up diketahui dari `lv`/`nq` di respons aksi. */
(() => {
'use strict';
const nf = new Intl.NumberFormat('id-ID');
const nfMul = new Intl.NumberFormat('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); // koma desimal: ×1,18
const h = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const reduceMo = () => window.matchMedia && matchMedia('(prefers-reduced-motion:reduce)').matches;
const signedIn = () => { try { return typeof atok === 'string' && !!atok; } catch { return false; } };
const lsGet = k => { try { return typeof store !== 'undefined' ? store.get(k) : localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { if (typeof store !== 'undefined') store.set(k, v); else if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch {} };

let level = (() => { const n = parseInt(lsGet('acclv'), 10); return Number.isFinite(n) && n >= 1 ? n : null; })(); // cache supaya badge langsung tampil saat dibuka
let lastMul = null;

/* ---------- Badge level di header (rail desktop + atas layar HP) ---------- */
const HOSTS = [['.r-wallet', 'r-b'], ['.m-wallet', 'm-b']]; // r-b = rail desktop, m-b = bar atas HP (CSS memilih salah satu per lebar layar)
function mountBadges() {
  for (const [sel, pos] of HOSTS) {
    const host = document.querySelector(sel);
    if (!host || !host.parentNode || host.parentNode.querySelector(':scope > .lv-badge.' + pos)) continue;
    const b = h('button', 'lv-badge hide ' + pos); b.type = 'button'; b.dataset.lvb = '1';
    b.append(h('small', null, 'Lv'), h('b', null, '1'));
    b.addEventListener('click', open);
    host.parentNode.insertBefore(b, host);
  }
}
function paintBadges() {
  mountBadges();
  const on = signedIn() && Number.isFinite(level); // tamu: badge disembunyikan
  document.querySelectorAll('.lv-badge').forEach(b => {
    b.classList.toggle('hide', !on);
    if (!on) return;
    b.querySelector('b').textContent = nf.format(level);
    b.title = 'Level akun ' + nf.format(level) + ' · ketuk untuk detail';
    b.setAttribute('aria-label', 'Level akun ' + nf.format(level) + '. Buka detail level.');
  });
}
function set(n) {
  const v = Math.floor(Number(n));
  level = Number.isFinite(v) && v >= 1 ? v : null;
  lsSet('acclv', level == null ? null : String(level));
  paintBadges();
}

/* ---------- Toast level-up (teks + confetti ringan; TANPA suara) ---------- */
let toastEl = null, toastT = 0;
const CONF = ['#f5b942', '#6bd49a', '#6aa8ff', '#f27d9b', '#b58cff'];
function celebrate(title, sub) {
  if (!toastEl) {
    toastEl = h('div', 'lv-toast'); toastEl.setAttribute('role', 'status'); toastEl.setAttribute('aria-live', 'polite');
    document.body.append(toastEl);
  }
  toastEl.textContent = '';
  toastEl.append(h('b', null, title)); if (sub) toastEl.append(h('span', null, sub));
  if (!reduceMo()) {
    const c = h('i', 'lv-conf'); c.setAttribute('aria-hidden', 'true');
    for (let i = 0; i < 16; i++) {
      const p = h('s'); p.style.setProperty('--x', (Math.random() * 2 - 1).toFixed(2)); p.style.setProperty('--d', (Math.random() * .25).toFixed(2) + 's');
      p.style.setProperty('--r', Math.round(Math.random() * 360) + 'deg'); p.style.background = CONF[i % CONF.length]; c.append(p);
    }
    toastEl.append(c);
  }
  toastEl.classList.remove('show'); void toastEl.offsetWidth; toastEl.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => toastEl && toastEl.classList.remove('show'), 4200);
}
const rewardText = r => {
  if (!r) return '';
  const p = [];
  if (r.c) p.push('+' + nf.format(r.c) + ' coin');
  if (r.g) p.push('+' + nf.format(r.g) + ' gems');
  return p.join(', ');
};
const staleData = () => { S.stale = true; };

/* respons `lv` dari Chat Global / heartbeat online. Hadiah level-up dibayar server; di sini hanya mencerminkannya ke saldo header. */
function gain(lv) {
  if (!lv || typeof lv !== 'object') return;
  if (Number.isFinite(lv.level)) set(lv.level);
  staleData();
  const up = lv.levelUp;
  if (!up) return;
  if (Number.isFinite(up.to)) set(up.to);
  celebrate('Naik ke Level ' + nf.format(up.to || lv.level) + '!', rewardText(up.reward));
  try {
    const rw = up.reward || {};
    if ((rw.c || rw.g) && typeof loadWallet === 'function' && typeof saveWallet === 'function') {
      const cur = loadWallet();
      if (cur) saveWallet({ ...cur, coins: (cur.coins || 0) + (rw.c || 0), gems: (cur.gems || 0) + (rw.g || 0) }); // server tetap sumber kebenaran saat reload
    }
  } catch {}
  try { window.NOTIF && NOTIF.poke(); } catch {} // catatan tipe `level` ikut masuk bel
}

/* `nq` dari respons game: teks \"Naik ke Level X! (+Y coin, +Z gems)\". Saldo sudah diperbarui oleh respons game itu sendiri. */
const NQ_RE = /Naik ke Level\s+(\d+)/i;
function nq(list) {
  if (!Array.isArray(list)) return;
  for (const t of list) {
    const m = typeof t === 'string' ? NQ_RE.exec(t) : null;
    if (!m) continue;
    set(Number(m[1])); staleData();
    celebrate('Naik ke Level ' + nf.format(Number(m[1])) + '!', (/\(([^)]*)\)/.exec(t) || [])[1] || '');
    try { window.NOTIF && NOTIF.poke(); } catch {}
    return;
  }
}

/* ---------- Chip pengali hadiah di layar minigame ---------- */
function chip(mul) {
  const v = Number(mul);
  if (Number.isFinite(v) && v > 0) lastMul = v;
  if (!Number.isFinite(lastMul) || !signedIn()) return '';
  return '<span class="lv-mul" title="Hadiah menang dikalikan level akunmu (sudah dihitung server)">Hadiah ×' + nfMul.format(lastMul) + '</span>';
}

/* ---------- Panel Level Akun ---------- */
const S = { data: null, at: 0, err: '', busy: false, cd: 0, host: null, stale: false, tick: 0, cdT: 0 };
const SRC_ORDER = ['gc', 'time', 'win', 'ext'];

function rel(iso) {
  const t = Date.parse(iso); if (!Number.isFinite(t)) return '';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return 'baru saja';
  if (s < 3600) return Math.floor(s / 60) + ' mnt lalu';
  if (s < 86400) return Math.floor(s / 3600) + ' jam lalu';
  if (s < 86400 * 30) return Math.floor(s / 86400) + ' hari lalu';
  return new Date(t).toLocaleDateString('id-ID', { day: 'numeric', month: 'short' });
}
const hms = ms => { const s = Math.max(0, Math.ceil(ms / 1000)), hh = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60; return hh + ':' + String(m).padStart(2, '0') + ':' + String(ss).padStart(2, '0'); };
const mounted = () => !!(S.host && S.host.isConnected);

async function load(force) {
  if (!signedIn() || S.busy) return;
  if (!force && S.data && !S.stale && Date.now() - S.at < 3000) return;
  S.busy = true; S.err = ''; if (mounted()) render();
  try {
    const r = await aApi('level');
    if (r && r.ok) {
      S.data = r; S.at = Date.now(); S.stale = false;
      set(r.level);
      try { if (Number.isFinite(r.coins) && typeof loadWallet === 'function') { const cur = loadWallet() || {}; saveWallet({ ...cur, coins: r.coins, gems: Number.isFinite(r.gems) ? r.gems : (cur.gems || 0) }); } } catch {}
    } else S.err = (r && r.error) || 'Gagal memuat level.';
  } catch (e) {
    if (e && e.status === 429) { S.cd = Date.now() + 10000; S.err = e.message || 'Terlalu sering, tunggu sebentar.'; }
    else if (e && e.status === 401) S.err = '';
    else S.err = (e && e.message) || 'Gagal memuat level.';
  }
  S.busy = false;
  if (mounted()) render();
}

function bar(pct, label, cls) {
  const b = h('div', 'lv-bar' + (cls ? ' ' + cls : '')), f = h('i');
  f.style.width = Math.max(0, Math.min(100, pct)) + '%'; b.append(f);
  b.setAttribute('role', 'progressbar'); b.setAttribute('aria-valuemin', '0'); b.setAttribute('aria-valuemax', '100'); b.setAttribute('aria-valuenow', String(Math.round(pct))); b.setAttribute('aria-label', label);
  return b;
}
const card = (title, ...kids) => { const c = h('section', 'lv-card'); if (title) c.append(h('h3', null, title)); c.append(...kids); return c; };

function avatarEl(name, src) {
  const a = h('span', 'lv-av', (String(name || '?').trim()[0] || '?').toUpperCase()); a.setAttribute('aria-hidden', 'true');
  if (src) { const im = new Image(); im.alt = ''; im.decoding = 'async'; im.draggable = false; im.referrerPolicy = 'no-referrer'; im.onerror = () => im.remove(); im.src = src; a.append(im); }
  return a;
}

function render() {
  const el = S.host; if (!el) return;
  el.textContent = '';
  el.classList.add('lv-wrap');
  if (!signedIn()) { el.append(h('p', 'lv-note', 'Level hanya untuk akun. Masuk dulu untuk mengumpulkan XP.')); return; }
  const d = S.data;
  const top = h('div', 'lv-top');
  const rf = h('button', 'lv-refresh', S.busy ? 'Memuat…' : 'Segarkan'); rf.type = 'button';
  rf.disabled = S.busy || Date.now() < S.cd;
  rf.addEventListener('click', () => load(true));
  top.append(h('h3', null, 'Level Akun'), rf);
  el.append(top);
  if (S.err) { const e = h('p', 'lv-err', S.err); e.setAttribute('role', 'alert'); el.append(e); }
  if (S.cd > Date.now()) { clearTimeout(S.cdT); S.cdT = setTimeout(() => { if (mounted()) render(); }, S.cd - Date.now() + 50); }
  if (!d) { // loading state: kerangka
    if (!S.err) { const sk = h('div', 'lv-skel'); sk.setAttribute('aria-busy', 'true'); sk.append(h('i'), h('i'), h('i')); el.append(sk); }
    return;
  }

  const left = h('div', 'lv-col'), right = h('div', 'lv-col');

  // 1) kartu level + bar XP
  const big = h('div', 'lv-big'); big.append(h('small', null, 'Level'), h('b', null, nf.format(d.level)));
  const lc = card(null);
  lc.classList.add('lv-main');
  if (d.maxed) {
    lc.append(big, bar(100, 'Level maksimal', 'max'), h('p', 'lv-sub', 'MAX · total ' + nf.format(d.xp) + ' XP'));
    const mx = h('span', 'lv-maxtag', 'MAX'); big.append(mx);
  } else {
    const pct = d.need > 0 ? d.cur / d.need * 100 : 0;
    lc.append(big, bar(pct, nf.format(d.cur) + ' dari ' + nf.format(d.need) + ' XP'),
      h('p', 'lv-xp', nf.format(d.cur) + '/' + nf.format(d.need) + ' XP'),
      h('p', 'lv-sub', 'Total ' + nf.format(d.xp) + ' XP · ' + nf.format(Math.max(0, d.need - d.cur)) + ' XP lagi ke Level ' + nf.format(d.level + 1)));
  }
  left.append(lc);

  // 2) kartu pengali hadiah
  const m = d.mul || {};
  const mc = card('Pengali hadiah minigame');
  const mrow = h('div', 'lv-mulrow');
  mrow.append(h('b', null, '×' + nfMul.format(m.now)));
  if (!d.maxed && Number.isFinite(m.next)) { mrow.append(h('span', 'lv-arrow', '→'), h('b', 'next', '×' + nfMul.format(m.next))); }
  mc.append(mrow,
    h('p', 'lv-sub', d.maxed ? 'Pengali tertinggi untuk level ini.' : 'Hadiah menang naik jadi ×' + nfMul.format(m.next) + ' di Level ' + nf.format(d.level + 1) + '.'),
    h('small', 'lv-fine', 'maks ×' + nfMul.format(m.cap) + ' · berlaku di Tebak Angka, Tebak Gambar, 2048, Word Search, dan Catur'));
  left.append(mc);

  // 3) XP harian
  const dc = card('XP hari ini');
  const names = { gc: 'Pesan Chat Global', time: 'Lama main di web', win: 'Menang minigame', ext: 'Bonus eksternal' };
  for (const k of SRC_ORDER) {
    const x = d.daily && d.daily[k]; if (!x) continue;
    const row = h('div', 'lv-drow'), t = h('div', 'lv-dt');
    const title = (d.sources && d.sources[k] && d.sources[k].title) || names[k];
    t.append(h('b', null, title));
    if (x.cap == null) { t.append(h('span', null, nf.format(x.xp) + ' XP · tanpa batas')); row.append(t); }
    else { t.append(h('span', null, nf.format(x.xp) + '/' + nf.format(x.cap) + ' XP')); row.append(t, bar(x.cap > 0 ? x.xp / x.cap * 100 : 0, title + ' ' + nf.format(x.xp) + ' dari ' + nf.format(x.cap) + ' XP', x.xp >= x.cap ? 'full' : '')); }
    dc.append(row);
  }
  const rs = h('p', 'lv-reset'); rs.append('Reset 00.00 WIB · ', h('b', 'lv-cd', ''));
  dc.append(rs);
  right.append(dc);
  const tickCd = () => { const c = rs.querySelector('.lv-cd'); if (!c || !rs.isConnected) return false; c.textContent = hms((d.daily.resetMs || 0) - (Date.now() - S.at)); return true; };

  // 4) rincian sumber seumur hidup
  const sc = card('Sumber XP seumur hidup'), sl = h('ul', 'lv-src');
  for (const k of SRC_ORDER) { const s = d.sources && d.sources[k]; if (!s) continue; const li = h('li'); li.append(h('span', null, s.title), h('b', null, nf.format(s.xp) + ' XP')); sl.append(li); }
  sc.append(sl); right.append(sc);

  // 5) riwayat XP
  const hc = card('Riwayat XP'), hist = Array.isArray(d.hist) ? d.hist : [];
  if (!hist.length) hc.append(h('p', 'lv-note', 'Belum ada XP — kirim pesan di Chat Global atau menangi minigame.'));
  else {
    const hl = h('ul', 'lv-hist');
    for (const x of hist) {
      const li = h('li'), t = h('span', 'lv-ht');
      t.append(h('b', null, '+' + nf.format(x.amt) + ' XP'), ' ' + ((d.sources && d.sources[x.src] && d.sources[x.src].title) || names[x.src] || x.src));
      if (x.note) t.append(h('small', null, x.note));
      li.append(t, h('time', null, rel(x.at))); hl.append(li);
    }
    hc.append(hl);
  }
  right.append(hc);

  const cols = h('div', 'lv-cols'); cols.append(left, right); el.append(cols);

  // 6) papan 10 level tertinggi
  const tc = card('10 level tertinggi'), tl = h('ol', 'lv-top10'), top10 = Array.isArray(d.top) ? d.top : [];
  top10.forEach((u, i) => {
    const li = h('li', u.me ? 'me' : '');
    li.append(h('b', 'lv-rk', String(i + 1)), avatarEl(u.name, u.avatar));
    const w = h('span', 'lv-who'); w.append(h('b', null, u.name)); if (u.me) w.append(h('em', null, 'kamu'));
    li.append(w, h('span', 'lv-lv', 'Lv ' + nf.format(u.level)));
    tl.append(li);
  });
  if (!top10.length) tc.append(h('p', 'lv-note', 'Belum ada pemain di papan ini.')); else tc.append(tl);
  if (d.rank && Number.isFinite(d.rank.at)) tc.append(h('p', 'lv-rank', 'Peringkatmu: #' + nf.format(d.rank.at)));
  el.append(tc);

  clearInterval(S.tick); tickCd(); // dipanggil SETELAH semua kartu terpasang (elemen harus sudah di dokumen)
  S.tick = setInterval(() => { if (!tickCd()) clearInterval(S.tick); }, 1000); // hitung mundur dari waktu respons diterima
}

function panel(el) {
  S.host = el;
  render();
  load(S.stale); // dibuka -> segarkan (tanpa polling); load() sendiri melewati kalau data baru <3 dtk atau sedang memuat
}

/* ---------- Pintu masuk ---------- */
function open() {
  try { if (window.PF && PF.openTab) PF.openTab('level'); else if (window.Shell) Shell.setTab('profile'); } catch {}
}
window.addEventListener('acct', () => { if (!signedIn()) { level = null; S.data = null; lsSet('acclv', null); } paintBadges(); });
window.addEventListener('shell:tab', e => { if (e.detail !== 'profile') { clearInterval(S.tick); } });

// klik notifikasi bertipe `level` di bel -> panel Level Akun
try { window.NOTIF && NOTIF.route('level', open); } catch {}
window.addEventListener('load', () => { try { window.NOTIF && NOTIF.route('level', open); } catch {} paintBadges(); });

const rest = list => (Array.isArray(list) ? list.filter(t => !(typeof t === 'string' && NQ_RE.test(t))) : []); // nq tanpa catatan level-up (yang itu sudah jadi toast level-up sendiri)
window.LEVEL = { set, gain, nq, rest, chip, panel, open, level: () => level };
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', paintBadges); else paintBadges();
})();
