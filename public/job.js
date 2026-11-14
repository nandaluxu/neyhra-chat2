/* ===== Sub-tab Dompet > Kerja (pekerjaan part-time) =====
   Spesifikasi: docs/frontend/job-system.md (urutan README #7). Semua angka (gaji, jeda, kuota harian, peluang bonus) DIPUTUSKAN SERVER dan
   ditampilkan dari respons; tidak ada angka hardcode di sini. Hasil gaji (dan 2x bila `bonus`) selalu dari respons `work`.
   Endpoint (POST + Bearer, lewat aApi): jobs (daftar + kuota + riwayat), jobs/work { id }.
   Dimuat SETELAH market.js (urutan sub-tab: ... Market | Kerja), sebelum router.js. Gaya: job.css (kelas jb-*) + kelas wl-* dan tr-* yang sudah ada.
   Konvensi:
     - Countdown dihitung di client dari `cdLeft` (interval 1 dtk), TANPA polling server; status asli divalidasi server saat klik.
     - 429 jeda ("tunggu X menit lagi") dibuka sebagai countdown; 429 kuota -> kartu kuota "Balik besok".
     - Tombol "Bekerja…" minimal ±600 ms (artifisial) sebelum hasil tampil. Tidak ada suara autoplay.
     - Saldo header dari `coins` respons (pushWallet). Riwayat dimuat ulang bersama daftar tiap sub-tab dibuka. */
(() => {
'use strict';
if (!window.WALLET || typeof WALLET.register !== 'function') return;
const $ = id => document.getElementById(id);
const app = $('app'), wallet = $('wallet');
if (!app || !wallet) return;
const nf = new Intl.NumberFormat('id-ID');
const active = () => app.dataset.tab === 'wallet' && !!$('jbbody');
const h = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const reduceMo = () => window.matchMedia && matchMedia('(prefers-reduced-motion:reduce)').matches;
const poke = () => { try { window.NOTIF && NOTIF.poke(); } catch {} };
const COIN = '<img src="/coin.svg" alt="" draggable="false">';
const MIN_WORK_MS = 600; // spinner artifisial (spesifikasi): hasil server tampil setelahnya
const DAY_MS = 86400e3, WIB_MS = 7 * 3600e3; // hari berganti 00.00 WIB (sama dengan dayNum di server)

const ICONS = { // ikon dari `icon` respons; id tak dikenal -> koper generik
  coffee: '<path d="M5 9h11v5a5 5 0 01-5 5H10a5 5 0 01-5-5V9z"/><path d="M16 11h1.5a2.5 2.5 0 010 5H16"/><path d="M8 3v3M12 3v3"/>',
  box: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z"/><path d="M4 7.5l8 4.5 8-4.5M12 12v9"/>',
  shield: '<path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6l7-3z"/><path d="M9 12l2 2 4-4"/>',
  spark: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3z"/><path d="M18.5 16.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7.7-1.8z"/>',
  _: '<rect x="4" y="8" width="16" height="11" rx="2.5"/><path d="M9 8V6.5A1.5 1.5 0 0110.5 5h3A1.5 1.5 0 0115 6.5V8M4 13h16"/>'
};
const icon = name => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('aria-hidden', 'true'); s.innerHTML = ICONS[name] || ICONS._; return s; };

function pushCoins(r) { // saldo header dari respons, tanpa request `me` tambahan
  try {
    if (!r || !Number.isFinite(r.coins)) return;
    const cur = (typeof loadWallet === 'function' && loadWallet()) || {};
    const next = { ...cur, coins: r.coins };
    if (Number.isFinite(next.coins) && Number.isFinite(next.gems)) saveWallet(next);
    else if (typeof saveWallet === 'function' && Number.isFinite(next.coins)) saveWallet({ ...next, gems: next.gems || 0 });
  } catch {}
}
let toastEl = null, toastT = 0;
function say(t) {
  if (!toastEl) { toastEl = wallet.querySelector('.wl-toast'); if (!toastEl) { toastEl = h('div', 'wl-toast'); toastEl.setAttribute('role', 'status'); toastEl.setAttribute('aria-live', 'polite'); wallet.append(toastEl); } }
  toastEl.textContent = t; toastEl.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => toastEl.classList.remove('show'), 2600);
}

/* ---------- State ---------- */
const J = {
  view: null, loading: false, again: false, err: '', tok: '',
  until: {},            // id pekerjaan -> timestamp (ms) siap lagi (dihitung dari cdLeft saat muat / setelah bekerja)
  quotaFull: false,     // dari 429 kuota (sebelum muat ulang): semua tombol nonaktif
  busy: '',             // id pekerjaan yang sedang dikerjakan (satu aksi pada satu waktu)
  msgs: {},             // id -> { text } pesan inline di kartu
  result: null          // panel hasil terakhir { name, pay, bonus, id }
};
const left = id => Math.max(0, (J.until[id] || 0) - Date.now());
const used = () => (J.view && J.view.daily ? J.view.daily.used : 0);
const maxQ = () => (J.view && J.view.daily ? J.view.daily.max : 0);
const full = () => J.quotaFull || (maxQ() > 0 && used() >= maxQ());
const resetMs = () => Math.max(0, (Math.floor((Date.now() + WIB_MS) / DAY_MS) + 1) * DAY_MS - WIB_MS - Date.now()); // sisa waktu ke 00.00 WIB

/* ---------- Format ---------- */
const mmss = ms => { const s = Math.ceil(ms / 1000), hh = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60; return (hh ? hh + ':' + String(m).padStart(2, '0') : String(m).padStart(2, '0')) + ':' + String(ss).padStart(2, '0'); };
const words = ms => {
  const m = Math.ceil(ms / 60e3);
  if (m < 60) return m + ' menit';
  const hh = Math.floor(m / 60), r = m % 60;
  return hh + ' jam' + (r ? ' ' + r + ' menit' : '');
};
const rel = iso => {
  const t = Date.parse(iso); if (!Number.isFinite(t)) return '';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return 'baru saja';
  if (s < 3600) return Math.floor(s / 60) + ' mnt lalu';
  if (s < 86400) return Math.floor(s / 3600) + ' jam lalu';
  return Math.floor(s / 86400) + ' hari lalu';
};
const range = p => Array.isArray(p) ? (p[0] === p[1] ? nf.format(p[0]) : nf.format(p[0]) + '–' + nf.format(p[1])) : '';
const skeleton = () => {
  const g = h('div', 'jb-grid');
  for (const hh of [96, 210, 210, 150]) { const s = h('div', 'wl-sk'); s.style.height = hh + 'px'; s.setAttribute('aria-hidden', 'true'); g.append(s); }
  return g;
};

/* angka naik (panel hasil); tanpa animasi bila reduced-motion */
function countUp(el, to) {
  if (reduceMo() || !(to > 0)) { el.textContent = nf.format(to); return; }
  const t0 = performance.now(), dur = 700;
  const step = now => { const k = Math.min(1, (now - t0) / dur); el.textContent = nf.format(Math.round(to * (1 - Math.pow(1 - k, 3)))); if (k < 1 && el.isConnected) requestAnimationFrame(step); };
  requestAnimationFrame(step);
}

/* ---------- Muat daftar ---------- */
async function load(force) {
  if (typeof atok !== 'string' || !atok) return;
  if (J.loading) { if (force) J.again = true; return; }
  J.loading = true; J.err = ''; if (active() && !J.view) render();
  try {
    const r = await aApi('jobs');
    if (!r || !r.ok) throw new Error((r && r.error) || 'Gagal memuat pekerjaan.');
    J.view = r; J.quotaFull = false; pushCoins(r);
    const now = Date.now(); J.until = {};
    for (const j of r.jobs || []) J.until[j.id] = now + Math.max(0, Number(j.cdLeft) || 0);
  } catch (e) { if (!(e && e.status === 401)) J.err = (e && e.message) || 'Gagal memuat pekerjaan.'; }
  J.loading = false;
  if (active() && !J.busy) render();
  if (J.again) { J.again = false; load(true); }
}

/* ---------- Render ---------- */
function render() {
  const box = $('jbbody'); if (!box) return;
  const top = wallet.scrollTop;
  box.textContent = '';
  if (!J.view && !J.err) { box.append(skeleton()); return; }
  if (J.err && !J.view) {
    const g = h('div', 'wl-gate'); g.append(h('h2', null, 'Gagal memuat'), h('p', null, J.err));
    const b = h('button', 'wl-btn', 'Coba lagi'); b.type = 'button'; b.addEventListener('click', () => load(true)); g.append(b); box.append(g); return;
  }
  const v = J.view, grid = h('div', 'jb-grid');

  /* kuota harian */
  const q = h('section', 'wl-card jb-quota'), qh = h('div', 'jb-qh');
  qh.append(h('h3', null, 'Shift hari ini'), h('b', 'jb-qn', nf.format(used()) + '/' + nf.format(maxQ())));
  q.append(qh);
  const tr = h('div', 'wl-track'), fi = h('i'); fi.style.width = Math.max(0, Math.min(100, maxQ() ? used() / maxQ() * 100 : 0)) + '%'; tr.append(fi); q.append(tr);
  if (full()) {
    const bk = h('p', 'jb-back'); bk.append(h('b', null, 'Balik besok'), h('span', 'jb-reset', ' · reset 00.00 WIB, ' + words(resetMs()) + ' lagi')); q.append(bk);
  } else {
    q.append(h('p', 'wl-small', 'Sisa ' + nf.format(Math.max(0, maxQ() - used())) + ' shift. Kuota dipakai bersama semua pekerjaan dan reset 00.00 WIB.'));
  }
  const bc = v.daily && Number(v.daily.bonusChance);
  if (bc > 0) q.append(h('p', 'jb-bonus', Math.round(bc * 100) + '% kesempatan gaji dobel tiap shift'));
  grid.append(q);

  /* kartu pekerjaan + panel hasil */
  const main = h('div', 'jb-main');
  if (J.result) main.append(resultEl(J.result));
  const list = h('div', 'jb-jobs');
  for (const j of v.jobs || []) list.append(jobCard(j));
  main.append(list);
  grid.append(main);

  /* riwayat */
  const hs = h('section', 'wl-card jb-hist'); hs.append(h('h3', null, 'Riwayat shift'));
  if (!(v.hist || []).length) hs.append(h('p', 'jb-empty', 'Belum ada shift. Mulai dari ' + ((v.jobs || []).slice().sort((a, b) => a.cdMin - b.cdMin)[0] || { name: 'pekerjaan pertama' }).name + ' — paling cepat siap lagi.'));
  else {
    const ul = h('ul', 'jb-hl');
    for (const x of v.hist) { const li = h('li'); const t = h('div', 'jb-ht'); t.append(h('span', null, x.txt || ''), h('small', null, rel(x.at))); li.append(t, h('b', 'jb-hc', '+' + nf.format(x.coins || 0))); ul.append(li); }
    hs.append(ul);
  }
  grid.append(hs);

  box.append(grid);
  wallet.scrollTop = top;
  tick();
}

function resultEl(r) {
  const c = h('section', 'wl-card jb-result' + (r.bonus ? ' bonus' : '') + (r.shown ? '' : ' fresh')); /* animasi masuk hanya sekali, bukan tiap render ulang */ c.setAttribute('role', 'status'); c.setAttribute('aria-live', 'polite');
  const x = h('button', 'wl-x', '×'); x.type = 'button'; x.dataset.a = 'dismiss'; x.setAttribute('aria-label', 'Tutup hasil shift');
  c.append(x, h('small', 'jb-rl', 'Shift ' + r.name + ' selesai'));
  const amt = h('div', 'jb-amt'); amt.innerHTML = COIN; const n = h('b', null, '0'); n.dataset.to = String(r.pay); amt.append(n, h('span', null, 'Coin')); c.append(amt);
  if (r.bonus) c.append(h('p', 'jb-spark', '✦ Shift bonus! Gaji dobel ✦'));
  else c.append(h('p', 'jb-note', 'Gaji masuk ke saldomu.'));
  if (!r.shown) { r.shown = true; requestAnimationFrame(() => countUp(n, r.pay)); } else n.textContent = nf.format(r.pay);
  return c;
}

function jobCard(j) {
  const ms = left(j.id), ready = ms <= 0, blocked = full(), busy = J.busy === j.id;
  const c = h('article', 'jb-card' + (ready && !blocked ? ' ready' : '')); c.dataset.id = j.id;
  const head = h('div', 'jb-head'), ic = h('span', 'jb-ic'); ic.append(icon(j.icon)); head.append(ic);
  const t = h('div', 'jb-t'); t.append(h('b', null, j.name), h('small', null, 'Jeda ' + nf.format(j.cdMin) + ' menit')); head.append(t);
  const pay = h('div', 'jb-pay'); pay.innerHTML = COIN; pay.append(h('b', null, range(j.pay)), h('span', null, 'Coin')); head.append(pay);
  c.append(head, h('p', 'jb-desc', j.desc || ''));

  const act = h('div', 'jb-act');
  if (!ready && !busy) { // countdown: bar + teks besar (mono) + padanan teks untuk pembaca layar
    const cd = h('div', 'jb-cd'); cd.dataset.id = j.id;
    const top = h('div', 'jb-cdt'); top.append(h('span', 'jb-cdl', 'Siap dalam'), h('b', 'jb-cdn', mmss(ms)));
    const bar = h('div', 'wl-track'), fi = h('i'); fi.style.width = Math.max(0, Math.min(100, (1 - ms / (j.cdMin * 60e3)) * 100)) + '%'; bar.append(fi);
    const sr = h('span', 'jb-sr', 'Siap dalam ' + words(ms)); cd.append(top, bar, sr); act.append(cd);
  }
  const b = h('button', 'wl-btn jb-go' + (!ready || blocked ? ' alt' : '')); b.type = 'button'; b.dataset.a = 'work'; b.dataset.id = j.id;
  b.disabled = !!J.busy || !ready || blocked;
  if (busy) { b.append(h('i', 'tr-spin'), document.createTextNode('Bekerja…')); b.setAttribute('aria-busy', 'true'); }
  else b.textContent = blocked ? 'Kuota habis' : ready ? 'Kerjakan' : 'Belum siap';
  act.append(b); c.append(act);
  const m = J.msgs[j.id]; if (m) { const e = h('div', 'wl-msg err', m.text); e.setAttribute('role', 'alert'); c.append(e); }
  return c;
}

/* ---------- Aksi: kerjakan ---------- */
const wait = ms => new Promise(r => setTimeout(r, ms));
async function work(id) {
  if (J.busy || !J.view || left(id) > 0 || full()) return;
  delete J.msgs[id]; J.busy = id; J.result = null; render();
  let res = null, err = null;
  const min = wait(reduceMo() ? 0 : MIN_WORK_MS);
  try { res = await aApi('jobs/work', { id }); if (!res || !res.ok) throw new Error((res && res.error) || 'Gagal bekerja.'); }
  catch (e) { err = e; }
  await min;
  J.busy = '';
  if (res) {
    pushCoins(res);
    const j = (J.view.jobs || []).find(x => x.id === id);
    if (j) J.until[id] = Date.now() + j.cdMin * 60e3; // jeda baru dihitung dari cdMin (respons work tidak memuat cdLeft)
    if (res.daily) J.view.daily = { ...J.view.daily, used: res.daily.used, max: res.daily.max != null ? res.daily.max : J.view.daily.max };
    J.result = { id, name: res.name || (j && j.name) || id, pay: res.pay, bonus: !!res.bonus };
    if (res.bonus) say('Shift bonus! Gaji dobel');
    poke(); render();
    load(true); // sinkronkan riwayat + jeda asli dari server
    return;
  }
  const msg = (err && err.message) || 'Gagal bekerja.', status = err && err.status;
  if (status === 401) { render(); return; }
  if (status === 429) {
    const mm = /tunggu\s+(\d+)\s+menit/i.exec(msg);
    if (mm) J.until[id] = Date.now() + Number(mm[1]) * 60e3; // 429 jeda -> jadi countdown (perkiraan; sinkron saat muat ulang)
    else if (/kuota/i.test(msg)) J.quotaFull = true;
  }
  J.msgs[id] = { text: msg };
  render();
  if (status === 429 || status === 503) load(true);
}

$('wtbody').addEventListener('click', e => {
  if (!$('jbbody')) return;
  const b = e.target.closest('[data-a]'); if (!b || b.disabled) return;
  if (b.dataset.a === 'work') work(b.dataset.id);
  else if (b.dataset.a === 'dismiss') { J.result = null; render(); }
});

/* ---------- Countdown 1 dtk (client-side, tanpa polling server) ---------- */
let lastWords = {};
function tick() {
  const box = $('jbbody'); if (!box || !J.view) return;
  let redraw = false;
  box.querySelectorAll('.jb-cd[data-id]').forEach(el => {
    const id = el.dataset.id, ms = left(id), j = (J.view.jobs || []).find(x => x.id === id);
    if (ms <= 0) { redraw = true; return; }
    const n = el.querySelector('.jb-cdn'); if (n) n.textContent = mmss(ms);
    const fi = el.querySelector('.wl-track i'); if (fi && j) fi.style.width = Math.max(0, Math.min(100, (1 - ms / (j.cdMin * 60e3)) * 100)) + '%';
    const w = words(ms), sr = el.querySelector('.jb-sr'); if (sr && lastWords[id] !== w) { lastWords[id] = w; sr.textContent = 'Siap dalam ' + w; } // pembaca layar: teks berubah per menit, bukan per detik
  });
  const rs = box.querySelector('.jb-reset'); if (rs) { const m = resetMs(); if (m <= 0) { J.quotaFull = false; load(true); } else rs.textContent = ' · reset 00.00 WIB, ' + words(m) + ' lagi'; }
  if (redraw && !J.busy) render();
}
setInterval(() => { if (!document.hidden && active()) tick(); }, 1000);

/* =====================================================================================================
   Daftarkan sub-tab + peristiwa
   ===================================================================================================== */
WALLET.register('job', {
  label: 'Kerja', title: 'Kerja', sub: 'Shift pendek dibayar Coin. Tiap pekerjaan punya jeda sendiri, kuota harian dipakai bersama.',
  onOpen() { J.msgs = {}; },
  render(ctx) {
    ctx.body.textContent = ''; const box = h('div'); box.id = 'jbbody'; ctx.body.append(box);
    render();
    load(true); // muat ulang daftar + riwayat tiap sub-tab dibuka
  }
});
window.addEventListener('acct', () => { // ganti akun / keluar: bersihkan semuanya
  const tok = typeof atok === 'string' ? atok : '';
  if (J.tok !== tok) { J.tok = tok; J.view = null; J.until = {}; J.msgs = {}; J.result = null; J.busy = ''; J.quotaFull = false; lastWords = {}; }
});
document.addEventListener('visibilitychange', () => { if (!document.hidden && active() && !J.busy) load(true); });
})();
