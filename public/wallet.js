/* ===== Tab Dompet (/wallet): sub-tab Transfer dan Bank =====
   Spesifikasi: docs/frontend/player-transfer.md dan docs/frontend/bank-system.md (urutan README #2 dan #3).
   Semua angka (fee, batas, bunga, sisa kuota) DIPUTUSKAN SERVER dan ditampilkan dari respons `rates`/`daily`/`interest`;
   client hanya pratinjau (fee = floor(coin * rates.feePct)) dan validasi tampilan. Saldo diganti penuh dari respons terakhir.
   Endpoint (POST + Bearer, lewat aApi): transfer, transfer/send, bank, bank/deposit, bank/withdraw, users (cari username), shop (nama barang).

   Dimuat setelah shop.js/economy.js, sebelum router.js. Memakai global index.html: atok, aOn, aApi, saveWallet, loadWallet, openLogin, Shell.
   Pintu untuk layar lain:
     WALLET.open(sub, meta)      -> buka tab Dompet di sub-tab itu (mis. 'transfer' dengan meta { u: 'alfa' } mengisi penerima).
                                    Dipakai tombol "Transfer" di profil pemain lain dan klik notifikasi bel.
     WALLET.has(sub)             -> sub-tab itu sudah ada?
     WALLET.register(sub, def)   -> tambah sub-tab baru (Pencurian/Trade/Market/Kerja): def = { label, title, sub, render(ctx), onOpen?(meta) }
   Setelah aksi ekonomi sukses: saldo header diperbarui dari respons dan NOTIF.poke() menyegarkan bel. */
(() => {
'use strict';
const $ = id => document.getElementById(id);
const app = $('app'), body = $('wtbody'), nav = $('wtnav');
if (!app || !body || !nav) return;
const nf = new Intl.NumberFormat('id-ID');
const active = () => app.dataset.tab === 'wallet';
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'id' + Date.now().toString(36) + Math.random().toString(36).slice(2, 12));
const h = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const COIN = '<img src="/coin.svg" alt="" draggable="false">';
const CHECK = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M8 12l3 3 5-6"/></svg>';
const SHIELD = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6l7-3zM9 12l2 2 4-4"/></svg>';
const toInt = v => { const n = Number(String(v).replace(/[^\d]/g, '')); return Number.isFinite(n) ? Math.floor(n) : 0; };
const reduceMo = () => window.matchMedia && matchMedia('(prefers-reduced-motion:reduce)').matches;
const poke = () => { try { window.NOTIF && NOTIF.poke(); } catch {} };
const mqM = window.matchMedia('(max-width:799px)');

/* saldo header + semua kotak [data-w]: pakai coins dari respons (jangan kirim request `me` tambahan). tickets/chips tetap dari cache. */
function pushCoins(r) {
  try {
    if (!r || !Number.isFinite(r.coins)) return;
    const cur = (typeof loadWallet === 'function' && loadWallet()) || {};
    saveWallet({ ...cur, coins: r.coins, gems: Number.isFinite(r.gems) ? r.gems : (cur.gems || 0) });
  } catch {}
}

/* ---------- Toast kecil khusus tab ini (toast bawaan ada di footer chat, tak terlihat di sini) ---------- */
let toastEl = null, toastT = 0;
function say(t) {
  if (!toastEl) { toastEl = h('div', 'wl-toast'); toastEl.setAttribute('role', 'status'); toastEl.setAttribute('aria-live', 'polite'); $('wallet').append(toastEl); }
  toastEl.textContent = t; toastEl.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => toastEl.classList.remove('show'), 2600);
}

/* angka berjalan (saldo naik/turun), tanpa animasi bila reduced-motion */
const rafs = new WeakMap();
function tween(el, to) {
  const from = Number(el.dataset.v);
  el.dataset.v = String(to);
  cancelAnimationFrame(rafs.get(el));
  if (!Number.isFinite(from) || from === to || reduceMo()) { el.textContent = nf.format(to); return; }
  const t0 = performance.now(), dur = 550;
  el.classList.toggle('up', to > from); el.classList.toggle('down', to < from);
  const step = now => {
    const k = Math.min(1, (now - t0) / dur);
    el.textContent = nf.format(Math.round(from + (to - from) * (1 - Math.pow(1 - k, 3))));
    if (k < 1) rafs.set(el, requestAnimationFrame(step)); else { el.classList.remove('up', 'down'); }
  };
  rafs.set(el, requestAnimationFrame(step));
}

/* ---------- Registri sub-tab (Transfer & Bank sekarang; Pencurian/Trade/Market/Kerja bisa mendaftar nanti) ---------- */
const TABS = {};
const ORDER = [];
let sub = 'transfer';
function register(key, def) {
  if (!key || !def || typeof def.render !== 'function') return;
  if (!TABS[key]) ORDER.push(key);
  TABS[key] = def; buildNav();
}
function buildNav() {
  nav.textContent = '';
  nav.style.setProperty('--n', String(ORDER.length));
  for (const k of ORDER) {
    const b = h('button', k === sub ? 'sel' : '', TABS[k].label); b.type = 'button'; b.setAttribute('role', 'tab'); b.dataset.v = k; b.setAttribute('aria-selected', String(k === sub));
    nav.append(b);
  }
}
nav.addEventListener('click', e => { const b = e.target.closest('button[data-v]'); if (b) setSub(b.dataset.v); });
function setSub(k, meta) {
  if (!TABS[k]) return;
  sub = k;
  $('wth1').textContent = TABS[k].title || TABS[k].label;
  $('wtsub').textContent = TABS[k].sub || '';
  nav.querySelectorAll('button').forEach(b => { const on = b.dataset.v === k; b.classList.toggle('sel', on); b.setAttribute('aria-selected', String(on)); });
  body.textContent = '';
  if (!aOn || !atok) { gate(); return; }
  try { if (TABS[k].onOpen) TABS[k].onOpen(meta || {}); } catch {}
  TABS[k].render({ body, meta: meta || {} });
}
function gate() {
  body.textContent = '';
  const g = h('div', 'wl-gate');
  if (!aOn) { g.append(h('h2', null, 'Dompet belum tersedia'), h('p', null, 'Fitur akun belum aktif di server ini, jadi Dompet belum bisa dipakai.')); }
  else {
    g.append(h('h2', null, 'Masuk dulu ya'), h('p', null, 'Transfer dan Bank tersimpan di akunmu, jadi kamu perlu masuk atau daftar dulu.'));
    const b = h('button', 'wl-btn', 'Masuk / Daftar'); b.type = 'button'; b.addEventListener('click', () => { if (typeof openLogin === 'function') openLogin(); }); g.append(b);
  }
  body.append(g);
}

/* ---------- Util: kotak pesan, kartu ---------- */
const msgBox = () => { const m = h('div', 'wl-msg hide'); m.setAttribute('role', 'alert'); return m; };
function showMsg(m, text, kind) { m.textContent = text || ''; m.className = 'wl-msg' + (text ? ' ' + (kind || 'err') : ' hide'); }
const card = (cls, title) => { const c = h('section', 'wl-card' + (cls ? ' ' + cls : '')); if (title) c.append(h('h3', null, title)); return c; };
const itemIcon = id => '/shop/' + encodeURIComponent(id) + '.svg';

/* nama barang dari endpoint toko (sekali, di-cache 5 menit); gagal -> pakai id */
let names = {}, namesAt = 0, namesBusy = null;
function loadNames() {
  if (Date.now() - namesAt < 300000) return Promise.resolve();
  if (namesBusy) return namesBusy;
  namesBusy = (async () => {
    try {
      const r = await aApi('shop');
      if (r && r.ok) { const m = {}; for (const i of [...(r.items || []), ...(r.rings || [])]) if (i && i.id) m[i.id] = i.name || i.id; names = m; namesAt = Date.now(); }
    } catch {}
    namesBusy = null;
  })();
  return namesBusy;
}
const nameOf = id => names[id] || String(id).replace(/-/g, ' ').replace(/^./, c => c.toUpperCase());

/* =====================================================================================================
   TRANSFER
   ===================================================================================================== */
const T = {
  view: null, loading: false, err: '', at: 0,
  to: '', pick: null,                 // pick = { username, name, avatar } bila dipilih dari daftar
  coins: '', items: {},               // items: id -> jumlah
  busy: false, res: [], resSeq: 0, resErr: '', showRes: false,
  done: null, msg: '', msgKind: 'err',
  idem: '', itemsOpen: false
};
const USER_RE = /^[a-z0-9_.-]{3,20}$/;
let qT = 0;

const feeOf = c => (T.view ? Math.floor(c * T.view.rates.feePct) : 0);
const coinsN = () => toInt(T.coins);
const itemKinds = () => Object.keys(T.items).filter(k => T.items[k] > 0);
const itemTotal = () => itemKinds().reduce((s, k) => s + T.items[k], 0);

async function tLoad(force) {
  if (!atok || T.loading) return;
  if (!force && T.view && Date.now() - T.at < 4000) return;
  T.loading = true; T.err = ''; if (active() && sub === 'transfer' && !T.view) tRender();
  try {
    const r = await aApi('transfer');
    if (!r || !r.ok) throw new Error((r && r.error) || 'Gagal memuat transfer.');
    T.view = r; T.at = Date.now(); pushCoins(r);
    for (const k of Object.keys(T.items)) if (!(r.inv && r.inv[k] > 0)) delete T.items[k]; else T.items[k] = Math.min(T.items[k], r.inv[k]);
  } catch (e) { if (!(e && e.status === 401)) T.err = (e && e.message) || 'Gagal memuat transfer.'; }
  T.loading = false;
  if (active() && sub === 'transfer') tRender();
  loadNames().then(() => { if (active() && sub === 'transfer') paintItems(); });
}

/* alasan tombol Kirim nonaktif (null = boleh kirim); semua batas dari server */
function tProblem() {
  const v = T.view; if (!v) return 'Memuat…';
  if (Date.now() < (T.cool || 0)) return 'Terlalu sering, tunggu ±10 detik.';
  if (!v.trust) return 'Akunmu belum berumur ' + nf.format(v.rates.trustHours) + ' jam, jadi belum bisa mengirim (anti akun cadangan).';
  if (!USER_RE.test(T.to)) return T.to ? 'Username tidak valid (3–20 huruf kecil, angka, titik, strip, garis bawah).' : 'Ketik username temanmu dulu.';
  const c = coinsN(), n = itemTotal();
  if (c === 0 && n === 0) return 'Isi coin atau pilih barang dulu.';
  if (c > 0 && c < v.rates.minCoin) return 'Transfer coin minimal ' + nf.format(v.rates.minCoin) + '.';
  if (c > v.rates.maxCoin) return 'Transfer coin maksimal ' + nf.format(v.rates.maxCoin) + ' per kali.';
  if (c > v.coins) return 'Coin di dompetmu belum cukup.';
  if (c > v.daily.coinLeft) return 'Sisa batas harian hanya ' + nf.format(v.daily.coinLeft) + ' Coin.';
  if (itemKinds().length > v.rates.maxKinds) return 'Maksimal ' + v.rates.maxKinds + ' jenis barang per transfer.';
  if (n > v.daily.itemLeft) return 'Sisa batas harian hanya ' + nf.format(v.daily.itemLeft) + ' barang.';
  return null;
}

function tRender() {
  body.textContent = '';
  if (!T.view && !T.err) { body.append(skeleton()); return; }
  if (T.err && !T.view) {
    const g = h('div', 'wl-gate'); g.append(h('h2', null, 'Gagal memuat'), h('p', null, T.err));
    const b = h('button', 'wl-btn', 'Coba lagi'); b.type = 'button'; b.addEventListener('click', () => tLoad(true)); g.append(b); body.append(g); return;
  }
  const v = T.view, grid = h('div', 'wl-grid'), left = h('div', 'wl-col'), right = h('div', 'wl-col');

  /* --- hasil terakhir --- */
  if (T.done) {
    const d = T.done, ok = card('wl-done');
    const ic = h('span', 'wl-doneic'); ic.innerHTML = CHECK;
    const t = h('div', 'wl-donet');
    t.append(h('b', null, 'Terkirim ke ' + d.to));
    const parts = [];
    if (d.coins) parts.push(d.to + ' menerima ' + nf.format(d.net) + ' Coin' + (d.fee ? ' (fee ' + nf.format(d.fee) + ')' : ''));
    if (d.items && d.items.length) parts.push(d.items.map(i => i.n + ' ' + nameOf(i.id)).join(', '));
    t.append(h('small', null, parts.join(' · ')));
    const x = h('button', 'wl-x', '×'); x.type = 'button'; x.setAttribute('aria-label', 'Tutup'); x.addEventListener('click', () => { T.done = null; tRender(); });
    ok.append(ic, t, x); left.append(ok);
  }

  /* --- form --- */
  const form = card('wl-form', 'Kirim');
  if (!v.trust) {
    const w = h('div', 'wl-note warn'); w.textContent = 'Akunmu belum berumur ' + nf.format(v.rates.trustHours) + ' jam, jadi transfer belum bisa dipakai. Kamu tetap bisa menyimpan coin di Bank.'; form.append(w);
  }
  // penerima
  const f1 = h('div', 'wl-field'), l1 = h('label', null, 'Username penerima'); l1.htmlFor = 'wtto';
  const wrap = h('div', 'wl-ac');
  const inp = h('input'); inp.id = 'wtto'; inp.type = 'text'; inp.placeholder = 'mis. bravo'; inp.autocomplete = 'off'; inp.autocapitalize = 'off'; inp.spellcheck = false; inp.maxLength = 20; inp.value = T.to; inp.setAttribute('aria-autocomplete', 'list'); inp.setAttribute('aria-controls', 'wtres'); inp.disabled = T.busy;
  wrap.append(inp);
  if (T.pick && T.pick.username === T.to) {
    const chip = h('div', 'wl-chip'); chip.append(avatarEl(T.pick), h('span', null, T.pick.name || T.pick.username), h('small', null, '@' + T.pick.username));
    f1.append(l1, wrap, chip);
  } else f1.append(l1, wrap);
  const res = h('div', 'wl-res'); res.id = 'wtres'; res.setAttribute('role', 'listbox'); wrap.append(res);
  form.append(f1);
  // coin
  const f2 = h('div', 'wl-field'), l2 = h('label', null, 'Jumlah Coin'); l2.htmlFor = 'wtcoin';
  const ci = h('input'); ci.id = 'wtcoin'; ci.type = 'text'; ci.inputMode = 'numeric'; ci.placeholder = '0'; ci.autocomplete = 'off'; ci.value = T.coins; ci.disabled = T.busy;
  const chips = h('div', 'wl-chips');
  for (const [label, val] of [['100', 100], ['500', 500], ['1.000', 1000], ['5.000', 5000], ['Maks', -1]]) {
    const b = h('button', 'wl-q', label); b.type = 'button'; b.dataset.q = String(val); b.disabled = T.busy; chips.append(b);
  }
  f2.append(l2, ci, chips);
  const pv = h('div', 'wl-preview'); pv.id = 'wtpv'; f2.append(pv);
  form.append(f2);
  // barang
  const f3 = h('div', 'wl-field wl-items');
  const head = h('button', 'wl-ihead'); head.type = 'button'; head.id = 'wtih'; head.setAttribute('aria-expanded', String(T.itemsOpen));
  f3.append(head);
  const list = h('div', 'wl-ilist'); list.id = 'wtil'; list.classList.toggle('open', T.itemsOpen); f3.append(list);
  form.append(f3);
  // kirim
  const em = msgBox(); em.id = 'wtmsg'; form.append(em);
  const why = h('p', 'wl-why'); why.id = 'wtwhy';
  const send = h('button', 'wl-btn wl-send', 'Kirim'); send.type = 'button'; send.id = 'wtsend';
  form.append(why, send);
  left.append(form);

  /* --- batas harian + aturan --- */
  const lim = card('wl-lim', 'Batas hari ini');
  lim.append(barRow('Coin', v.daily.coinLeft, v.rates.dayCoin, 'tersisa'), barRow('Barang', v.daily.itemLeft, v.rates.dayItem, 'tersisa'));
  const rules = h('ul', 'wl-rules');
  for (const t of [
    'Fee ' + (v.rates.feePct * 100).toLocaleString('id-ID', { maximumFractionDigits: 1 }) + '% dipotong dari yang diterima penerima.',
    'Coin ' + nf.format(v.rates.minCoin) + '–' + nf.format(v.rates.maxCoin) + ' per transfer, maksimal ' + v.rates.maxKinds + ' jenis barang.',
    'Gems tidak bisa ditransfer. Cincin gacha bisa.'
  ]) rules.append(h('li', null, t));
  lim.append(rules); right.append(lim);
  const bal = card('wl-balmini');
  const bl = h('div', 'wl-balrow'); bl.innerHTML = COIN; const bs = h('div'); bs.append(h('small', null, 'Saldo dompet'), h('b', null, nf.format(v.coins))); bl.append(bs);
  bal.append(bl); right.prepend(bal);

  grid.append(left, right); body.append(grid);
  paintItems(); paintPreview(); paintSend();
  if (T.showRes) paintRes();
}

const barRow = (label, left, total, word) => {
  const r = h('div', 'wl-bar'), top = h('div', 'wl-bartop');
  top.append(h('span', null, label), h('b', null, nf.format(left) + ' ' + word));
  const tr = h('div', 'wl-track'), fill = h('i'); fill.style.width = Math.max(0, Math.min(100, total ? left / total * 100 : 0)) + '%'; tr.append(fill);
  r.append(top, tr); return r;
};
function avatarEl(u) {
  const a = h('span', 'wl-av', (String(u.name || u.username || '?').trim()[0] || '?').toUpperCase()); a.setAttribute('aria-hidden', 'true');
  if (u.avatar) { const im = new Image(); im.alt = ''; im.decoding = 'async'; im.draggable = false; im.referrerPolicy = 'no-referrer'; im.onerror = () => im.remove(); im.src = u.avatar; a.append(im); }
  return a;
}
function skeleton() {
  const g = h('div', 'wl-grid'); const a = h('div', 'wl-col'), b = h('div', 'wl-col');
  for (const [c, hh] of [[a, 360], [b, 160]]) { const s = h('div', 'wl-sk'); s.style.height = hh + 'px'; s.setAttribute('aria-hidden', 'true'); c.append(s); }
  g.append(a, b); return g;
}

function paintPreview() {
  const pv = $('wtpv'); if (!pv || !T.view) return;
  const c = coinsN(); pv.textContent = '';
  if (c <= 0) { pv.append(h('small', null, 'Penerima mendapat: pilih jumlah coin (fee dipotong dari penerima).')); return; }
  const fee = feeOf(c), net = c - fee;
  const big = h('div', 'wl-net'); big.innerHTML = COIN; big.append(h('b', null, nf.format(net)), h('span', null, 'Coin diterima'));
  pv.append(big, h('small', null, 'Fee ' + nf.format(fee) + ' · kamu membayar ' + nf.format(c)));
}
function paintItems() {
  const head = $('wtih'), list = $('wtil'); if (!head || !list || !T.view) return;
  const inv = T.view.inv || {}, ids = Object.keys(inv).filter(k => inv[k] > 0);
  const n = itemKinds().length;
  head.textContent = '';
  head.append(h('span', null, 'Pilih barang' + (n ? ' (' + n + ' dipilih)' : '')), h('i', 'wl-chev'));
  head.disabled = T.busy;
  list.textContent = '';
  if (!ids.length) { list.append(h('p', 'wl-empty', 'Simpananmu kosong — beli dulu di Toko.')); return; }
  for (const id of ids) {
    const q = T.items[id] | 0, row = h('div', 'wl-irow' + (q ? ' on' : '')); row.dataset.id = id;
    const im = new Image(); im.src = itemIcon(id); im.alt = ''; im.draggable = false; im.className = 'wl-iic';
    const t = h('div', 'wl-it'); t.append(h('b', null, nameOf(id)), h('small', null, 'Punya ' + nf.format(inv[id])));
    const st = h('div', 'wl-step');
    const mi = h('button', null, '−'); mi.type = 'button'; mi.dataset.d = '-1'; mi.setAttribute('aria-label', 'Kurangi ' + nameOf(id)); mi.disabled = T.busy || q <= 0;
    const val = h('input'); val.type = 'text'; val.inputMode = 'numeric'; val.value = String(q); val.setAttribute('aria-label', 'Jumlah ' + nameOf(id)); val.dataset.id = id; val.disabled = T.busy;
    const pl = h('button', null, '+'); pl.type = 'button'; pl.dataset.d = '1'; pl.setAttribute('aria-label', 'Tambah ' + nameOf(id)); pl.disabled = T.busy || q >= inv[id];
    st.append(mi, val, pl); row.append(im, t, st); list.append(row);
  }
}
function paintSend() {
  const send = $('wtsend'), why = $('wtwhy'); if (!send) return;
  const p = tProblem();
  send.disabled = !!p || T.busy; send.classList.toggle('busy', T.busy);
  send.textContent = T.busy ? 'Mengirim…' : 'Kirim';
  if (why) { why.textContent = T.busy ? '' : (p && (T.to || coinsN() || itemTotal()) ? p : (!p ? '' : 'Ketik username temanmu, pilih coin/barang, lalu kirim.')); }
}
function paintRes() {
  const box = $('wtres'); if (!box) return;
  box.textContent = '';
  const inp = $('wtto');
  const open = T.showRes && (document.activeElement === inp || box.contains(document.activeElement)) && (T.res.length || T.resErr);
  box.classList.toggle('open', !!open);
  if (!open) return;
  if (T.resErr) { box.append(h('div', 'wl-resmsg', T.resErr)); return; }
  for (const u of T.res) {
    const b = h('button', 'wl-resrow'); b.type = 'button'; b.setAttribute('role', 'option'); b.dataset.u = u.username; b.dataset.n = u.name || '';
    const t = h('span', 'wl-rt'); t.append(h('b', null, u.name || u.username), h('small', null, '@' + u.username));
    b.append(avatarEl(u), t); box.append(b);
  }
}
async function searchUsers(q) {
  const seq = ++T.resSeq; T.resErr = '';
  try {
    const r = await aApi('users', { q });
    if (seq !== T.resSeq) return;
    T.res = ((r && r.items) || []).filter(u => !u.isMe).slice(0, 6);
  } catch (e) { if (seq !== T.resSeq || (e && e.status === 401)) return; T.res = []; T.resErr = (e && e.message) || 'Gagal mencari.'; }
  paintRes();
}

/* ---------- Event form Transfer (delegasi) ---------- */
body.addEventListener('input', e => {
  const t = e.target;
  if (t.id === 'wtto') {
    t.value = t.value.toLowerCase().replace(/[^a-z0-9_.-]/g, ''); T.to = t.value; if (T.pick && T.pick.username !== T.to) T.pick = null;
    clearTimeout(qT); T.showRes = true;
    if (T.to.length >= 1) qT = setTimeout(() => searchUsers(T.to), 250); else { T.res = []; paintRes(); }
    paintSend();
  } else if (t.id === 'wtcoin') {
    t.value = t.value.replace(/[^\d]/g, ''); T.coins = t.value ? String(Math.min(toInt(t.value), 99999999)) : ''; if (t.value !== T.coins) t.value = T.coins;
    paintPreview(); paintSend();
  } else if (t.matches && t.matches('.wl-step input')) {
    const id = t.dataset.id, max = (T.view && T.view.inv[id]) | 0;
    const q = Math.max(0, Math.min(max, toInt(t.value))); t.value = String(q); setItem(id, q);
  }
});
body.addEventListener('focusin', e => { if (e.target.id === 'wtto') { T.showRes = true; if (!T.res.length && !T.to) searchUsers(''); paintRes(); } });
body.addEventListener('focusout', e => {
  if (e.target.id !== 'wtto' && !(e.target.closest && e.target.closest('.wl-res'))) return;
  if (e.relatedTarget && e.relatedTarget.closest && (e.relatedTarget.closest('.wl-res') || e.relatedTarget.id === 'wtto')) return; // pindah dalam daftar saran: tetap terbuka
  setTimeout(() => { if (document.activeElement && document.activeElement.closest && document.activeElement.closest('.wl-ac')) return; T.showRes = false; paintRes(); }, 150);
});
body.addEventListener('keydown', e => {
  const rows = () => [...body.querySelectorAll('.wl-resrow')];
  if (e.target.id === 'wtto' && e.key === 'ArrowDown') { const r = rows(); if (r.length) { e.preventDefault(); r[0].focus(); } }
  else if (e.target.classList && e.target.classList.contains('wl-resrow')) {
    const r = rows(), i = r.indexOf(e.target);
    if (e.key === 'ArrowDown') { e.preventDefault(); (r[i + 1] || r[0]).focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); if (i <= 0) $('wtto').focus(); else r[i - 1].focus(); }
    else if (e.key === 'Escape') { e.preventDefault(); $('wtto').focus(); T.showRes = false; paintRes(); }
  }
});
body.addEventListener('mousedown', e => { if (e.target.closest('.wl-resrow')) e.preventDefault(); }); // pilih hasil tanpa input kehilangan fokus dulu
function setItem(id, q) {
  if (q > 0) T.items[id] = q; else delete T.items[id];
  const row = body.querySelector('.wl-irow[data-id="' + CSS.escape(id) + '"]');
  if (row) { row.classList.toggle('on', q > 0); const inp = row.querySelector('input'); if (inp) inp.value = String(q); const [mi, pl] = row.querySelectorAll('.wl-step button'); mi.disabled = q <= 0; pl.disabled = q >= (T.view.inv[id] | 0); }
  const head = $('wtih'); if (head) { const n = itemKinds().length; head.firstChild.textContent = 'Pilih barang' + (n ? ' (' + n + ' dipilih)' : ''); }
  paintSend();
}
body.addEventListener('click', e => {
  const t = e.target;
  const rr = t.closest('.wl-resrow');
  if (rr) { T.to = rr.dataset.u; T.pick = { username: rr.dataset.u, name: rr.dataset.n, avatar: ((T.res.find(u => u.username === rr.dataset.u) || {}).avatar) || '' }; T.showRes = false; T.res = []; tRender(); return; }
  const q = t.closest('.wl-q');
  if (q && sub === 'transfer') {
    const v = Number(q.dataset.q);
    const max = T.view ? Math.max(0, Math.min(T.view.rates.maxCoin, T.view.coins, T.view.daily.coinLeft)) : 0;
    T.coins = v < 0 ? (max ? String(max) : '') : String(v); const ci = $('wtcoin'); if (ci) ci.value = T.coins; paintPreview(); paintSend(); return;
  }
  if (t.closest('#wtih')) { T.itemsOpen = !T.itemsOpen; $('wtil').classList.toggle('open', T.itemsOpen); $('wtih').setAttribute('aria-expanded', String(T.itemsOpen)); return; }
  const sb = t.closest('.wl-step button');
  if (sb) { const row = sb.closest('.wl-irow'), id = row.dataset.id, max = (T.view.inv[id]) | 0; setItem(id, Math.max(0, Math.min(max, (T.items[id] | 0) + Number(sb.dataset.d)))); return; }
  if (t.closest('#wtsend') && !t.closest('#wtsend').disabled) openConfirm();
});

/* ---------- Modal konfirmasi (bottom-sheet di mobile) ---------- */
const modal = h('div', 'wl-modal hide'); modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true'); modal.setAttribute('aria-label', 'Konfirmasi transfer');
modal.innerHTML = '<div class="wl-mbox"><h2>Konfirmasi transfer</h2><div class="wl-mbody"></div><div class="wl-mmsg wl-msg hide" role="alert"></div><div class="wl-mbtns"><button type="button" class="wl-no">Batal</button><button type="button" class="wl-btn wl-yes">Ya, kirim</button></div></div>';
$('wallet').append(modal);
const mBody = modal.querySelector('.wl-mbody'), mMsg = modal.querySelector('.wl-mmsg'), mNo = modal.querySelector('.wl-no'), mYes = modal.querySelector('.wl-yes');
function openConfirm() {
  if (tProblem() || T.busy) return;
  const c = coinsN(), fee = feeOf(c), name = (T.pick && T.pick.username === T.to && T.pick.name) ? T.pick.name + ' (@' + T.to + ')' : '@' + T.to;
  T.idem = uuid(); // SATU idem per niat mengirim (modal terbuka); refresh halaman = idem baru
  mBody.textContent = '';
  const rows = [['Penerima', name]];
  if (c > 0) rows.push(['Coin', nf.format(c)], ['Fee (dibuang)', nf.format(fee)], ['Penerima mendapat', nf.format(c - fee) + ' Coin']);
  const its = itemKinds(); if (its.length) rows.push(['Barang', its.map(k => T.items[k] + ' ' + nameOf(k)).join(', ')]);
  const dl = h('dl', 'wl-sum'); for (const [k, v] of rows) { const r = h('div'); r.append(h('dt', null, k), h('dd', null, v)); dl.append(r); }
  mBody.append(dl);
  if (c > 0) mBody.append(h('p', 'wl-warn', 'Fee ' + (T.view.rates.feePct * 100).toLocaleString('id-ID', { maximumFractionDigits: 1 }) + '% tidak kembali. Transfer tidak bisa dibatalkan.'));
  else mBody.append(h('p', 'wl-warn', 'Transfer tidak bisa dibatalkan.'));
  showMsg(mMsg, ''); mYes.disabled = false; mYes.textContent = 'Ya, kirim'; mNo.disabled = false; mNo.textContent = 'Batal';
  modal.classList.remove('hide'); requestAnimationFrame(() => modal.classList.add('show')); mYes.focus({ preventScroll: true });
}
function closeConfirm() { if (T.busy) return; modal.classList.remove('show'); setTimeout(() => { if (!modal.classList.contains('show')) modal.classList.add('hide'); }, 220); }
mNo.addEventListener('click', closeConfirm);
modal.addEventListener('click', e => { if (e.target === modal) closeConfirm(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !modal.classList.contains('hide')) closeConfirm(); });
mYes.addEventListener('click', doSend);

async function doSend() {
  if (T.busy) return;
  const payload = { to: T.to, idem: T.idem }, c = coinsN(), its = {};
  if (c > 0) payload.coins = c;
  for (const k of itemKinds()) its[k] = T.items[k];
  if (Object.keys(its).length) payload.items = its; // jangan kirim items kosong
  T.busy = true; mYes.disabled = true; mNo.disabled = true; mYes.textContent = 'Mengirim…'; showMsg(mMsg, '');
  paintSend();
  let lock = 0;
  try {
    const r = await aApi('transfer/send', payload);
    if (!r || !r.ok) throw new Error((r && r.error) || 'Transfer gagal.');
    T.view = r; T.at = Date.now(); pushCoins(r);
    T.done = r.done; T.coins = ''; T.items = {}; T.msg = '';
    T.busy = false; modal.classList.remove('show'); modal.classList.add('hide');
    say('Terkirim ke ' + (r.done && r.done.to || T.to));
    poke();
    tRender();
    return;
  } catch (e) {
    T.busy = false;
    if (e && e.status === 401) { modal.classList.add('hide'); return; }
    const m = (e && e.message) || 'Transfer gagal.';
    let text = m;
    if (e && e.status === 409 && /sudah diproses/i.test(m)) text = m + ' Cek saldo dan notifikasimu sebelum mengirim lagi.'; // idem: JANGAN ulangi otomatis
    else if (e && e.status === 409 && /penuh/i.test(m)) text = m + ' Saldomu aman, tidak ada yang berkurang.';
    if (e && e.status === 429) { lock = 10000; }
    showMsg(mMsg, text, 'err'); mNo.disabled = false; mYes.textContent = 'Ya, kirim';
    mYes.disabled = true; // satu niat = satu idem: untuk mencoba lagi, tutup dan kirim ulang (idem baru)
    mNo.textContent = 'Tutup';
    tLoad(true); // 409 membawa saldo terbaru di server: sinkronkan
    if (lock) { T.cool = Date.now() + lock; setTimeout(() => { T.cool = 0; paintSend(); }, lock); }
  }
  paintSend();
}
mNo.addEventListener('click', () => { mNo.textContent = 'Batal'; });

/* =====================================================================================================
   BANK
   ===================================================================================================== */
const B = { view: null, loading: false, err: '', at: 0, amount: '', busy: false, msg: '', msgKind: 'err' };
async function bLoad(force) {
  if (!atok || B.loading) return;
  if (!force && B.view && Date.now() - B.at < 4000) return;
  B.loading = true; B.err = ''; if (active() && sub === 'bank' && !B.view) bRender();
  try {
    const r = await aApi('bank'); // sekaligus memicu bunga harian (lazy) di server
    if (!r || !r.ok) throw new Error((r && r.error) || 'Gagal memuat bank.');
    B.view = r; B.at = Date.now(); pushCoins(r);
  } catch (e) { if (!(e && e.status === 401)) B.err = (e && e.message) || 'Gagal memuat bank.'; }
  B.loading = false;
  if (active() && sub === 'bank') bRender();
}
function bRender() {
  body.textContent = '';
  if (B.loading && !B.view) { body.append(skeleton()); return; }
  if (B.err && !B.view) {
    const g = h('div', 'wl-gate'); g.append(h('h2', null, 'Gagal memuat'), h('p', null, B.err));
    const b = h('button', 'wl-btn', 'Coba lagi'); b.type = 'button'; b.addEventListener('click', () => bLoad(true)); g.append(b); body.append(g); return;
  }
  const v = B.view; if (!v) return;
  const r = v.rates, pct = (r.interestPct * 100).toLocaleString('id-ID', { maximumFractionDigits: 2 });

  const bal = h('div', 'wl-bals');
  const c1 = h('div', 'wl-bal'); c1.innerHTML = '<span class="wl-bk">Dompet</span>';
  const n1 = h('b', null, nf.format(v.coins)); n1.id = 'wbcoin'; n1.dataset.v = String(v.coins);
  const k1 = h('div', 'wl-bv'); k1.innerHTML = COIN; k1.append(n1); c1.append(k1, h('small', null, 'Bisa dicuri pemain lain'));
  const c2 = h('div', 'wl-bal safe'); c2.innerHTML = '<span class="wl-bk">Bank</span>';
  const n2 = h('b', null, nf.format(v.bank)); n2.id = 'wbbank'; n2.dataset.v = String(v.bank);
  const k2 = h('div', 'wl-bv'); k2.innerHTML = COIN; k2.append(n2); const sh = h('span', 'wl-shield'); sh.innerHTML = SHIELD; sh.title = 'Aman dari pencurian'; k2.append(sh);
  c2.append(k2, h('small', null, 'Aman dari pencurian'));
  bal.append(c1, c2); body.append(bal);

  if (v.bank === 0) {
    const e = card('wl-bempty'); e.append(h('b', null, 'Setor pertamamu'), h('p', null, 'Setor pertamamu untuk mengamankan coin dari pencuri.')); body.append(e);
  }

  const form = card('wl-bform', 'Setor atau tarik');
  const f = h('div', 'wl-field'), l = h('label', null, 'Jumlah Coin'); l.htmlFor = 'wbamt';
  const inp = h('input'); inp.id = 'wbamt'; inp.type = 'text'; inp.inputMode = 'numeric'; inp.placeholder = '0'; inp.autocomplete = 'off'; inp.value = B.amount; inp.disabled = B.busy;
  const chips = h('div', 'wl-chips scroll');
  for (const [label, key] of [['100', '100'], ['500', '500'], ['1.000', '1000'], ['5.000', '5000'], ['Semua dompet', 'wallet'], ['Semua bank', 'bank']]) {
    const b = h('button', 'wl-q', label); b.type = 'button'; b.dataset.q = key; b.disabled = B.busy; chips.append(b);
  }
  f.append(l, inp, chips); form.append(f);
  const em = msgBox(); em.id = 'wbmsg'; form.append(em);
  const why = h('p', 'wl-why'); why.id = 'wbwhy'; form.append(why);
  const row = h('div', 'wl-bbtns');
  const dep = h('button', 'wl-btn', 'Setor'); dep.type = 'button'; dep.id = 'wbdep';
  const wd = h('button', 'wl-btn alt', 'Tarik'); wd.type = 'button'; wd.id = 'wbwd';
  row.append(dep, wd); form.append(row); body.append(form);

  const info = card('wl-binfo');
  const st = v.interest && v.interest.day;
  const s = h('div', 'wl-status' + (st ? ' ok' : '')); s.append(h('i'), h('span', null, st ? 'Bunga hari ini sudah masuk' : 'Belum berbunga hari ini'));
  info.append(h('h3', null, 'Bunga harian'), h('p', null, 'Bunga ' + pct + '% per hari, maks ' + nf.format(r.interestMax) + '/hari — masuk otomatis setiap hari.'), s);
  const edu = h('div', 'wl-note'); edu.textContent = v.pocketNote || 'Coin di dompet bisa jadi target pencurian pemain lain. Coin di Bank aman.';
  info.append(edu);
  const lim = h('p', 'wl-small', 'Setor ' + nf.format(r.minDeposit) + '–' + nf.format(r.maxDeposit) + ' · tarik maks ' + nf.format(r.maxWithdraw) + ' per aksi.');
  info.append(lim); body.append(info);
  paintBank();
}
const bAmt = () => toInt(B.amount);
function bProblem(kind) {
  const v = B.view; if (!v) return 'Memuat…';
  const a = bAmt(), r = v.rates;
  if (kind === 'dep') {
    if (a < r.minDeposit) return 'Setor minimal ' + nf.format(r.minDeposit) + ' Coin.';
    if (a > r.maxDeposit) return 'Setor maksimal ' + nf.format(r.maxDeposit) + ' Coin sekali aksi.';
    if (a > v.coins) return 'Coin di dompet kamu belum cukup.';
  } else {
    if (a < 1) return 'Isi jumlah yang mau ditarik.';
    if (a > r.maxWithdraw) return 'Tarik maksimal ' + nf.format(r.maxWithdraw) + ' Coin sekali aksi.';
    if (a > v.bank) return 'Saldo bank kamu belum cukup.';
  }
  return null;
}
function paintBank() {
  const dep = $('wbdep'), wd = $('wbwd'), why = $('wbwhy'); if (!dep) return;
  const pd = bProblem('dep'), pw = bProblem('wd'), a = bAmt();
  dep.disabled = !!pd || B.busy || Date.now() < (B.cool || 0); wd.disabled = !!pw || B.busy || Date.now() < (B.cool || 0);
  dep.textContent = B.busy === 'dep' ? 'Menyetor…' : (a ? 'Setor ' + nf.format(a) : 'Setor'); wd.textContent = B.busy === 'wd' ? 'Menarik…' : (a ? 'Tarik ' + nf.format(a) : 'Tarik');
  why.textContent = B.busy ? '' : (!a ? 'Pilih jumlah, lalu Setor atau Tarik.' : [pd && 'Setor: ' + pd, pw && 'Tarik: ' + pw].filter(Boolean).join(' · '));
}
async function bAct(kind) {
  if (B.busy || bProblem(kind)) return;
  const a = bAmt(), path = kind === 'dep' ? 'bank/deposit' : 'bank/withdraw', m = $('wbmsg');
  B.busy = kind; showMsg(m, ''); paintBank(); body.querySelectorAll('.wl-q,#wbamt').forEach(x => { x.disabled = true; });
  const old = B.view;
  try {
    const r = await aApi(path, { amount: a });
    if (!r || !r.ok) throw new Error((r && r.error) || 'Gagal.');
    B.view = { ...(old || {}), ...r, interest: (old && old.interest) || r.interest }; B.at = Date.now(); B.amount = ''; pushCoins(r);
    B.busy = false;
    const ci = $('wbamt'); if (ci) { ci.value = ''; }
    tween($('wbcoin'), r.coins); tween($('wbbank'), r.bank);
    body.querySelectorAll('.wl-q,#wbamt').forEach(x => { x.disabled = false; });
    const bk = body.querySelector('.wl-bempty'); if (bk && r.bank > 0) bk.remove();
    say((kind === 'dep' ? 'Setor ' : 'Tarik ') + nf.format(a) + ' berhasil');
    poke(); paintBank();
  } catch (e) {
    B.busy = false;
    if (e && e.status === 401) return;
    body.querySelectorAll('.wl-q,#wbamt').forEach(x => { x.disabled = false; });
    showMsg(m, (e && e.message) || 'Gagal.', 'err');
    if (e && e.status === 429) { B.cool = Date.now() + 10000; setTimeout(() => { B.cool = 0; paintBank(); }, 10000); }
    if (e && e.status === 409) bLoad(true); // saldo di server beda dengan tampilan: sinkronkan
    paintBank();
  }
}
body.addEventListener('input', e => {
  if (e.target.id !== 'wbamt') return;
  const t = e.target; t.value = t.value.replace(/[^\d]/g, ''); B.amount = t.value ? String(Math.min(toInt(t.value), 99999999)) : ''; if (t.value !== B.amount) t.value = B.amount;
  showMsg($('wbmsg'), ''); paintBank();
});
body.addEventListener('click', e => {
  if (sub !== 'bank') return;
  const q = e.target.closest('.wl-q');
  if (q && B.view) {
    const k = q.dataset.q; B.amount = k === 'wallet' ? String(Math.max(0, B.view.coins)) : k === 'bank' ? String(Math.max(0, B.view.bank)) : k;
    if (B.amount === '0') B.amount = ''; const ci = $('wbamt'); if (ci) ci.value = B.amount; paintBank(); return;
  }
  if (e.target.closest('#wbdep')) bAct('dep'); else if (e.target.closest('#wbwd')) bAct('wd');
});

/* ---------- Daftarkan sub-tab ---------- */
register('transfer', {
  label: 'Transfer', title: 'Transfer', sub: 'Kirim Coin atau barang ke teman, langsung sampai. Gems tidak bisa dikirim.',
  onOpen(meta) { if (meta && meta.u) { const u = String(meta.u).toLowerCase().replace(/[^a-z0-9_.-]/g, '').slice(0, 20); T.to = u; T.pick = meta.name ? { username: u, name: meta.name, avatar: meta.avatar || '' } : null; T.done = null; } },
  render() { tRender(); tLoad(true); }
});
register('bank', {
  label: 'Bank', title: 'Bank', sub: 'Simpan Coin di tempat aman dari pencurian dan dapat bunga tiap hari.',
  render() { bRender(); bLoad(true); }
});

/* ---------- Pintu publik + peristiwa ---------- */
let pend = null; // tujuan dari WALLET.open yang menunggu event 'shell:tab' (supaya hanya sekali render)
window.WALLET = {
  has: k => !!TABS[k],
  register,
  open(k, meta) {
    if (k && !TABS[k]) k = '';
    pend = { k: k || sub, meta: meta || {} };
    if (window.Shell) Shell.setTab('wallet', { auto: false });
    if (pend) { const p = pend; pend = null; setSub(p.k, p.meta); } // Shell.setTab tidak memicu 'shell:tab' bila sudah di tab ini
  },
  reload() { if (!active()) return; if (sub === 'bank') bLoad(true); else if (sub === 'transfer') tLoad(true); }
};
window.addEventListener('shell:tab', e => {
  if (e.detail !== 'wallet') return;
  const p = pend; pend = null;
  setSub(p ? p.k : sub, p ? p.meta : undefined);
});
window.addEventListener('acct', () => {
  const tok = typeof atok === 'string' ? atok : '';
  if (T.tok !== tok) { T.tok = tok; T.view = null; T.done = null; T.items = {}; T.coins = ''; T.to = ''; T.pick = null; B.view = null; B.amount = ''; names = {}; namesAt = 0; if (active()) setSub(sub); }
});
window.addEventListener('notif:new', e => { // notifikasi baru (bunga bank, transfer masuk): muat ulang sub-tab bila sedang terbuka
  const types = (e.detail && e.detail.types) || [];
  if (active() && !T.busy && !B.busy && (types.includes('bank') || types.includes('transfer-in'))) window.WALLET.reload();
});
document.addEventListener('visibilitychange', () => { if (!document.hidden && active()) window.WALLET.reload(); });
buildNav();
})();