/* ===== Pusat Notifikasi (bel) — spesifikasi: docs/frontend/notification-center.md =====
   Bel `#nbell` ada di rail (desktop: sidebar; mobile: bar bawah), jadi terlihat di semua layar selama login.
   Panel: dropdown ±360px di sebelah bel (desktop) / bottom-sheet 80vh dengan handle geser (mobile).
   Backend (lib/notify.js): POST /api/auth/notify { before? } dan /api/auth/notify/seen { id | all:true }.
   Angka dan isi sepenuhnya dari server: badge = `unread` server, teks = `txt`. Semua teks lewat textContent (aman dari HTML).

   Memakai global index.html: atok, aApi (401 otomatis mengosongkan sesi + event 'acct'), Shell.
   Event yang didengar: 'acct' (masuk/keluar), 'shell:tab' (pindah layar), visibilitychange.
   Pintu untuk fitur lain:
     NOTIF.poke()            -> segarkan ±1,5 dtk lagi; panggil setelah aksi ekonomi sukses (transfer/trade/market/rob/kerja)
     NOTIF.refresh()         -> segarkan sekarang
     NOTIF.open()/close()
     NOTIF.route(type, fn)   -> daftarkan layar tujuan untuk tipe tertentu: fn(item) dipanggil saat baris diklik
   Layar Dompet nanti cukup menyediakan window.WALLET.open(sub, meta): klik notifikasi transfer/trade/market/rob/bank
   otomatis membukanya (sub = 'transfer' | 'trade' | 'market' | 'rob' | 'bank', meta = `m` dari server, mis. { u }). */
(() => {
'use strict';
const $ = id => document.getElementById(id);
const btn = $('nbell');
if (!btn) return;
const badge = btn.querySelector('.nb-badge');

const POLL_MS = 60000, STALE_OPEN_MS = 30000, RESET_AFTER_MS = 3600000, MIN_GAP_MS = 3000;
const mqM = window.matchMedia('(max-width:799px)');
const h = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

/* ---------- Ikon per tipe (SVG statis, gaya garis seperti ikon rail) ---------- */
const ICON = {
  quest: '<path d="M9 4h6a1 1 0 011 1v1H8V5a1 1 0 011-1zM8 6H6a1 1 0 00-1 1v13a1 1 0 001 1h12a1 1 0 001-1V7a1 1 0 00-1-1h-2M9 12h6M9 16h4"/>',
  ach: '<path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 01-10 0V4zM7 6H4a3 3 0 003 4M17 6h3a3 3 0 01-3 4"/>',
  'transfer-in': '<path d="M17 7L7 17M7 9v8h8"/>',
  'transfer-out': '<path d="M7 17L17 7M9 7h8v8"/>',
  trade: '<path d="M4 8h15M15 4l4 4-4 4M20 16H5M9 12l-4 4 4 4"/>',
  'trade-done': '<path d="M2 13l4 4 8-9M12 15l2 2 8-9"/>',
  market: '<path d="M4 9h16l-1.2 9.2A2 2 0 0116.8 20H7.2a2 2 0 01-2-1.8L4 9zM8 9l1.5-4h5L16 9"/>',
  rob: '<path d="M3 9c0-2 2-3 9-3s9 1 9 3v2c0 3-2 5-4 5-1.5 0-2.2-1-5-1s-3.5 1-5 1c-2 0-4-2-4-5V9zM8 11h2M14 11h2"/>',
  bank: '<path d="M3 7a2 2 0 012-2h14a2 2 0 012 2v10a2 2 0 01-2 2H5a2 2 0 01-2-2V7zM14 12a3 3 0 11-6 0 3 3 0 016 0zM17 9v6"/>',
  sys: '<path d="M12 21a9 9 0 100-18 9 9 0 000 18zM12 11v5M12 8h.01"/>'
};
const svg = d => '<svg viewBox="0 0 24 24" aria-hidden="true">' + d + '</svg>';
const BELL = svg('<path d="M6 9a6 6 0 1112 0c0 5 2 6 2 7H4c0-1 2-2 2-7zM10 19a2 2 0 004 0"/>');
const X = svg('<path d="M6 6l12 12M18 6L6 18"/>');

/* ---------- Layar tujuan saat baris diklik ---------- */
const WSUB = { 'transfer-in': 'transfer', 'transfer-out': 'transfer', trade: 'trade', 'trade-done': 'trade', market: 'market', rob: 'rob', bank: 'bank' };
const TAB = { quest: 'bonus', ach: 'profile' };
const custom = {};   // NOTIF.route(type, fn)

/* ---------- State (memori modul, tidak disimpan di localStorage) ---------- */
const S = { items: [], unread: 0, next: 0, more: false, loadedAt: 0, loading: false, moreBusy: false, err: '', moreErr: '', closedAt: 0, cool: 0, lastAt: 0, tok: '' };
let open = false, pollT = 0, pokeT = 0, tickT = 0;

/* ---------- Waktu relatif ---------- */
function rel(iso) {
  const t = Date.parse(iso); if (!Number.isFinite(t)) return '';
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return 'baru saja';
  const m = Math.floor(s / 60); if (m < 60) return m + ' mnt';
  const hr = Math.floor(m / 60); if (hr < 24) return hr + ' jam';
  const d = Math.floor(hr / 24); if (d === 1) return 'Kemarin';
  if (d < 7) return d + ' hari';
  return new Date(t).toLocaleDateString('id-ID', { day: 'numeric', month: 'short' });
}

/* ---------- Panel (dibuat sekali, ditempel ke body) ---------- */
const scrim = h('div', 'nt-scrim');
const panel = h('div', 'nt-panel');
panel.id = 'npanel'; panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', 'Notifikasi'); panel.tabIndex = -1;
panel.innerHTML = '<div class="nt-head"><span class="nt-grab" aria-hidden="true"></span><h2>Notifikasi <span class="nt-count hide" aria-hidden="true"></span></h2>' +
  '<button type="button" class="nt-all">Tandai semua dibaca</button><button type="button" class="nt-x" aria-label="Tutup">' + X + '</button></div>' +
  '<div class="nt-list" role="list"></div>';
const live = h('div', 'nt-sr'); live.setAttribute('role', 'status'); live.setAttribute('aria-live', 'polite');
document.body.append(scrim, panel, live);
const head = panel.querySelector('.nt-head'), list = panel.querySelector('.nt-list'), cnt = panel.querySelector('.nt-count'), allBtn = panel.querySelector('.nt-all');
btn.setAttribute('aria-haspopup', 'dialog'); btn.setAttribute('aria-controls', 'npanel'); btn.setAttribute('aria-expanded', 'false');

/* ---------- Badge & kepala panel ---------- */
function paintBadge() {
  const n = S.unread, on = !!atok && n > 0, txt = n > 9 ? '9+' : String(n);
  badge.classList.toggle('hide', !on);
  if (badge.textContent !== txt) {
    const down = Number(badge.dataset.n || 0) > n;
    badge.textContent = txt;
    if (down) { badge.classList.remove('shrink'); void badge.offsetWidth; badge.classList.add('shrink'); } // mengecil saat unread turun
  }
  badge.dataset.n = String(n);
  const label = on ? 'Notifikasi, ' + n + ' belum dibaca' : 'Notifikasi';
  btn.setAttribute('aria-label', label); btn.title = label;
}
function paintHead() {
  cnt.textContent = S.unread > 99 ? '99+' : String(S.unread);
  cnt.classList.toggle('hide', S.unread <= 0);
  allBtn.disabled = S.unread <= 0;
}

/* ---------- Daftar ---------- */
function skeleton() {
  const f = document.createDocumentFragment();
  for (let i = 0; i < 5; i++) { const r = h('div', 'nt-sk'); r.setAttribute('aria-hidden', 'true'); r.innerHTML = '<span></span><div><i></i><i></i></div>'; f.append(r); }
  return f;
}
function rowOf(n) {
  const type = ICON[n.type] ? n.type : 'sys';
  const wrap = h('div', 'nt-item'); wrap.setAttribute('role', 'listitem');
  const b = h('button', 'nt-row' + (n.seen ? '' : ' un')); b.type = 'button'; b.dataset.id = n.id;
  b.setAttribute('aria-label', (n.seen ? '' : 'Belum dibaca. ') + n.txt + '. ' + rel(n.at));
  const ic = h('span', 'nt-ic t-' + type); ic.innerHTML = svg(ICON[type]); // ikon = konstanta statis di atas
  const tx = h('span', 'nt-tx'), t = h('span', 'nt-t', n.txt), tm = h('small', 'nt-time', rel(n.at)); tm.dataset.at = n.at;
  tx.append(t, tm);
  const dot = h('i', 'nt-dot'); dot.setAttribute('aria-hidden', 'true');
  b.append(ic, tx, dot); wrap.append(b);
  return wrap;
}
function paintList() {
  const y = list.scrollTop;
  list.textContent = '';
  if (!S.items.length) {
    if (S.err) {
      const e = h('div', 'nt-empty err'); e.append(h('p', null, 'Notifikasi gagal dimuat'));
      if (S.err !== 'Notifikasi gagal dimuat') e.append(h('small', null, S.err));
      const r = h('button', 'nt-retry', 'Coba lagi'); r.type = 'button'; r.dataset.act = 'retry'; e.append(r); list.append(e);
    } else if (S.loading || !S.loadedAt) list.append(skeleton());
    else {
      const e = h('div', 'nt-empty'); e.innerHTML = '<span class="nt-eic" aria-hidden="true">' + BELL + '</span>';
      e.append(h('p', null, 'Belum ada notifikasi. Ngobrol, klaim bonus, atau transfer sesuatu — kejadiannya muncul di sini.')); list.append(e);
    }
  } else {
    const f = document.createDocumentFragment();
    for (const n of S.items) f.append(rowOf(n));
    if (S.more) {
      const m = h('div', 'nt-more'), b = h('button', 'nt-morebtn', S.moreBusy ? 'Memuat…' : S.moreErr ? 'Gagal. Coba lagi' : 'Muat lebih banyak');
      b.type = 'button'; b.dataset.act = 'more'; b.disabled = S.moreBusy; m.append(b); f.append(m);
      moreObs.disconnect(); moreObs.observe(m);
    }
    list.append(f);
  }
  list.scrollTop = y;
  paintHead();
}
const moreObs = new IntersectionObserver(es => { if (es.some(e => e.isIntersecting) && open) loadMore(); }, { root: list, rootMargin: '0px 0px 120px 0px' });

/* ---------- Data ---------- */
function mergeFirst(r) {
  const fresh = Array.isArray(r.items) ? r.items : [];
  if (S.items.length <= 30) { S.items = fresh; S.next = r.next || 0; S.more = !!r.more; return; } // baru halaman pertama: ganti penuh
  const have = new Map(S.items.map(n => [n.id, n]));
  const add = [];
  for (const n of fresh) { const o = have.get(n.id); if (o) o.seen = n.seen; else add.push(n); } // sudah memuat halaman berikutnya: sisipkan yang baru di atas
  S.items = add.concat(S.items);
}
async function fetchFirst(manual) {
  if (!atok || S.loading) return;
  const now = Date.now();
  if (now < S.cool || (!manual && now - S.lastAt < MIN_GAP_MS)) return;
  S.lastAt = now; S.loading = true; S.err = '';
  if (open) paintList();
  try {
    const r = await aApi('notify', {});
    if (!r || !r.ok) throw new Error((r && r.error) || 'Notifikasi gagal dimuat');
    const prev = S.unread;
    mergeFirst(r);
    S.unread = Math.max(0, r.unread | 0); S.loadedAt = Date.now();
    if (S.unread > prev && !open) { ring(); live.textContent = S.unread + ' notifikasi belum dibaca'; }
  } catch (e) {
    if (e && e.status === 401) { S.loading = false; return; } // sesi berakhir: aApi sudah mengosongkan token, event 'acct' merapikan sisanya
    if (e && e.status === 429) S.cool = Date.now() + 10000;
    if (!S.items.length) S.err = (e && e.status === 429 && e.message) || 'Notifikasi gagal dimuat';
  }
  S.loading = false;
  paintBadge(); if (open) paintList();
}
async function loadMore() {
  if (!atok || !S.more || S.moreBusy) return;
  S.moreBusy = true; S.moreErr = ''; paintList();
  try {
    const r = await aApi('notify', { before: S.next });
    if (!r || !r.ok) throw new Error((r && r.error) || 'gagal');
    const ids = new Set(S.items.map(n => n.id));
    for (const n of r.items || []) if (!ids.has(n.id)) S.items.push(n); // tanpa duplikat
    S.more = !!r.more; S.next = r.next || 0; S.unread = Math.max(0, r.unread | 0);
  } catch (e) { if (e && e.status === 401) { S.moreBusy = false; return; } S.moreErr = (e && e.message) || 'gagal'; }
  S.moreBusy = false; paintBadge(); paintList();
}

/* ---------- Tandai dibaca (optimis, kembali kalau gagal) ---------- */
async function markOne(n, rowEl) {
  if (n.seen) return;
  n.seen = true; S.unread = Math.max(0, S.unread - 1);
  if (rowEl) rowEl.classList.remove('un');
  paintBadge(); paintHead();
  try {
    const r = await aApi('notify/seen', { id: n.id });
    if (r && r.ok && Number.isFinite(r.unread)) { S.unread = r.unread; paintBadge(); paintHead(); }
  } catch (e) {
    if (e && e.status === 401) return;
    n.seen = false; S.unread += 1; if (rowEl) rowEl.classList.add('un'); // id ditolak / jaringan gagal: titik kembali
    paintBadge(); paintHead();
  }
}
async function markAll() {
  if (S.unread <= 0) return;
  const snap = S.items.map(n => n.seen), before = S.unread;
  S.items.forEach(n => { n.seen = true; }); S.unread = 0;
  paintBadge(); paintList();
  try {
    const r = await aApi('notify/seen', { all: true });
    if (r && r.ok && Number.isFinite(r.unread)) { S.unread = r.unread; paintBadge(); paintHead(); }
  } catch (e) {
    if (e && e.status === 401) return;
    S.items.forEach((n, i) => { n.seen = snap[i]; }); S.unread = before; paintBadge(); paintList();
  }
}

/* ---------- Klik baris: tandai terbaca + buka layar terkait bila ada ---------- */
function go(n) {
  if (custom[n.type]) { close(); try { custom[n.type](n); } catch {} return; }
  const sub = WSUB[n.type];
  if (sub && window.WALLET && typeof window.WALLET.open === 'function') { close(); window.WALLET.open(sub, n.m || {}); return; }
  const t = TAB[n.type];
  if (t && window.Shell) { close(); window.Shell.setTab(t); }
}
list.addEventListener('click', e => {
  const act = e.target.closest('[data-act]');
  if (act) { if (act.dataset.act === 'retry') fetchFirst(true); else if (act.dataset.act === 'more') loadMore(); return; }
  const row = e.target.closest('.nt-row'); if (!row) return;
  const n = S.items.find(x => x.id === row.dataset.id); if (!n) return;
  markOne(n, row); go(n);
});
allBtn.addEventListener('click', markAll);
panel.querySelector('.nt-x').addEventListener('click', () => close());
scrim.addEventListener('click', () => close());

/* ---------- Buka / tutup ---------- */
function place() {
  if (mqM.matches) { panel.style.left = panel.style.top = panel.style.bottom = ''; return; } // mobile: bottom-sheet diatur CSS
  const r = btn.getBoundingClientRect(), W = Math.min(360, innerWidth - 24);
  let left = r.right + 10; if (left + W > innerWidth - 12) left = Math.max(12, innerWidth - 12 - W);
  panel.style.left = left + 'px';
  if (r.top + r.height / 2 > innerHeight / 2) { panel.style.top = 'auto'; panel.style.bottom = Math.max(12, innerHeight - r.bottom - 4) + 'px'; }
  else { panel.style.bottom = 'auto'; panel.style.top = Math.max(12, r.top - 4) + 'px'; }
}
function openPanel() {
  if (open || !atok) return;
  open = true;
  if (S.closedAt && Date.now() - S.closedAt > RESET_AFTER_MS) { S.items = []; S.next = 0; S.more = false; S.loadedAt = 0; S.err = ''; } // tertutup > 1 jam: muat ulang halaman pertama
  place(); paintList();
  scrim.classList.add('show'); panel.classList.add('show');
  btn.setAttribute('aria-expanded', 'true');
  if (!S.loadedAt || Date.now() - S.loadedAt > STALE_OPEN_MS) fetchFirst(true);
  clearInterval(tickT); tickT = setInterval(() => list.querySelectorAll('.nt-time').forEach(t => { t.textContent = rel(t.dataset.at); }), 30000);
  panel.focus({ preventScroll: true });
}
function close(restoreFocus) {
  if (!open) return;
  open = false; S.closedAt = Date.now();
  scrim.classList.remove('show'); panel.classList.remove('show');
  btn.setAttribute('aria-expanded', 'false');
  clearInterval(tickT); moreObs.disconnect();
  if (restoreFocus) btn.focus({ preventScroll: true });
}
btn.addEventListener('click', () => (open ? close(true) : openPanel()));
document.addEventListener('keydown', e => { if (open && e.key === 'Escape') { e.preventDefault(); close(true); } });
addEventListener('resize', () => { if (open) place(); });

/* geser handle ke bawah untuk menutup (mobile) */
let drag = null;
head.addEventListener('pointerdown', e => {
  if (!mqM.matches || e.target.closest('button')) return;
  drag = { y: e.clientY, dy: 0, t: performance.now() };
  try { head.setPointerCapture(e.pointerId); } catch {}
  panel.style.transition = 'none';
});
head.addEventListener('pointermove', e => { if (!drag) return; drag.dy = Math.max(0, e.clientY - drag.y); panel.style.transform = 'translateY(' + drag.dy + 'px)'; });
const endDrag = () => {
  if (!drag) return;
  const { dy, t } = drag; drag = null;
  panel.style.transition = ''; panel.style.transform = '';
  if (dy > 90 || dy / (performance.now() - t + 1) > 0.6) close();
};
head.addEventListener('pointerup', endDrag); head.addEventListener('pointercancel', endDrag);

/* ---------- Polling ±60 dtk saat tab terlihat + sesudah aksi ---------- */
function ring() { btn.classList.remove('ring'); void btn.offsetWidth; btn.classList.add('ring'); }
function arm() {
  clearTimeout(pollT);
  if (!atok || document.hidden) return;
  pollT = setTimeout(async () => { await fetchFirst(false); arm(); }, POLL_MS + Math.random() * 4000);
}
function poke() { clearTimeout(pokeT); if (atok) pokeT = setTimeout(() => fetchFirst(false), 1500); }

function sync() { // masuk / keluar / ganti akun
  const t = typeof atok === 'string' ? atok : '';
  btn.classList.toggle('hide', !t);
  if (t === S.tok) { paintBadge(); return; }
  S.tok = t;
  Object.assign(S, { items: [], unread: 0, next: 0, more: false, loadedAt: 0, loading: false, moreBusy: false, err: '', moreErr: '', closedAt: 0, cool: 0, lastAt: 0 });
  paintBadge();
  if (!t) { close(); clearTimeout(pollT); return; } // tanpa login: bel disembunyikan
  fetchFirst(true); arm();
}
addEventListener('acct', sync);
addEventListener('shell:tab', () => { close(); if (atok && Date.now() - S.loadedAt > 45000) fetchFirst(false); });
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { clearTimeout(pollT); return; }
  if (atok && Date.now() - S.loadedAt > 20000) fetchFirst(false);
  arm();
});

window.NOTIF = { poke, refresh: () => fetchFirst(true), open: openPanel, close, unread: () => S.unread, route: (type, fn) => { if (typeof fn === 'function') custom[String(type)] = fn; else delete custom[String(type)]; } };
sync();
})();
