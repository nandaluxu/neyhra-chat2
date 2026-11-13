/* ===== Sub-tab Dompet > Perdagangan (trade dua pihak) =====
   Spesifikasi: docs/frontend/player-trading.md (urutan README #5). Semua angka (batas coin, jenis barang, penawaran
   aktif, masa berlaku) DIPUTUSKAN SERVER dan ditampilkan dari `rates`; client hanya validasi tampilan.
   Endpoint (POST + Bearer, lewat aApi): trade, trade/create, trade/accept, trade/cancel, users (cari username),
   shop (daftar barang untuk sisi "minta").
   Dimuat SETELAH wallet.js (mendaftar lewat WALLET.register), sebelum router.js. Gayanya ada di wallet.css (kelas tr-*).
   Pintu masuk lain:
     - Klik notifikasi `trade` / `trade-done` -> WALLET.open('trade', meta) -> tab Masuk bila meta.u ada.
     - Tombol "Ajak Trade" di profil -> WALLET.open('trade', { u, name, avatar, compose: true }) -> form terbuka, target terisi.
   Setelah create/accept/cancel (apa pun hasilnya) daftar dimuat ulang, karena status kartu bisa berubah di server. */
(() => {
'use strict';
if (!window.WALLET || typeof WALLET.register !== 'function') return;
const $ = id => document.getElementById(id);
const app = $('app'), wallet = $('wallet');
if (!app || !wallet) return;
const nf = new Intl.NumberFormat('id-ID');
const mqM = window.matchMedia('(max-width:799px)');
const active = () => app.dataset.tab === 'wallet' && !!$('trbody');
const h = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'id' + Date.now().toString(36) + Math.random().toString(36).slice(2, 12));
const poke = () => { try { window.NOTIF && NOTIF.poke(); } catch {} };
const toInt = v => { const n = Number(String(v).replace(/[^\d]/g, '')); return Number.isFinite(n) ? Math.floor(n) : 0; };
const USER_RE = /^[a-z0-9_.-]{3,20}$/;
const QTY_MAX = 99; // batas per jenis barang per sisi (server: LIMITS.qty)
const COIN = '<img src="/coin.svg" alt="" draggable="false">';
const SWAP = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8h15M15 4l4 4-4 4M20 16H5M9 12l-4 4 4 4"/></svg>';
const PLUS = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
const CHECK = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M8 12l3 3 5-6"/></svg>';
const itemIcon = id => '/shop/' + encodeURIComponent(id) + '.svg';

function pushWallet(r) { // saldo header dari respons (coins/gems), tanpa request `me` tambahan
  try {
    if (!r) return;
    const cur = (typeof loadWallet === 'function' && loadWallet()) || {};
    const next = { ...cur };
    if (Number.isFinite(r.coins)) next.coins = r.coins;
    if (Number.isFinite(r.gems)) next.gems = r.gems;
    if (Number.isFinite(next.coins) && Number.isFinite(next.gems)) saveWallet(next);
  } catch {}
}

/* toast bersama tab Dompet (pakai elemen yang sudah dibuat wallet.js/rob.js bila ada) */
let toastEl = null, toastT = 0;
function say(t) {
  if (!toastEl) { toastEl = wallet.querySelector('.wl-toast'); if (!toastEl) { toastEl = h('div', 'wl-toast'); toastEl.setAttribute('role', 'status'); toastEl.setAttribute('aria-live', 'polite'); wallet.append(toastEl); } }
  toastEl.textContent = t; toastEl.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => toastEl.classList.remove('show'), 2800);
}

/* ---------- State ---------- */
const S = {
  view: null, loading: false, again: false, err: '', at: 0, tok: '',
  tab: 'in',                 // in | out | done
  busyId: '',                // kartu yang sedang Terima/Batalkan (satu aksi pada satu waktu -> tak ada dobel klik)
  msgs: {},                  // id -> { text, kind } pesan di kartu
  notice: null,              // { text, kind } pesan di atas daftar (mis. kartu hilang setelah 409)
  done: null,                // ringkasan accept terakhir { who, got, paid }
  compose: false             // buka form setelah daftar termuat (dari "Ajak Trade")
};
const F = {                  // form penawaran baru
  open: false, step: 1, busy: false, idem: '', msg: '',
  to: '', pick: null, res: [], resSeq: 0, resErr: '',
  offer: { coins: '', items: {} }, want: { coins: '', items: {} },
  list: { offer: false, want: false }
};
const roles = new Map();     // id trade -> 'from' (aku penawar) | 'to' (aku penerima); dipakai untuk menandai kartu Riwayat
let qT = 0;

/* ---------- Daftar barang (nama + ikon): barang toko + cincin gacha ---------- */
let CAT = [], CATM = new Map(), catAt = 0, catBusy = null;
function loadCat() {
  if (CAT.length && Date.now() - catAt < 300000) return Promise.resolve();
  if (catBusy) return catBusy;
  catBusy = (async () => {
    try {
      const r = await aApi('shop');
      if (r && r.ok) {
        CAT = [...(r.items || []).map(i => ({ id: i.id, name: i.name || i.id })), ...(r.rings || []).map(i => ({ id: i.id, name: i.name || i.id, ring: true }))].filter(i => i.id);
        CATM = new Map(CAT.map(i => [i.id, i.name])); catAt = Date.now();
      }
    } catch {}
    catBusy = null;
  })();
  return catBusy;
}
const nameOf = id => CATM.get(id) || String(id).replace(/-/g, ' ').replace(/^./, c => c.toUpperCase());
function repaintNames() { wallet.querySelectorAll('[data-nm]').forEach(e => { e.textContent = nameOf(e.dataset.nm); }); }

/* ---------- Util tampilan ---------- */
const relTime = iso => {
  const t = Date.parse(iso); if (!Number.isFinite(t)) return '';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return 'baru saja';
  if (s < 3600) return Math.floor(s / 60) + ' mnt lalu';
  if (s < 86400) return Math.floor(s / 3600) + ' jam lalu';
  return Math.floor(s / 86400) + ' hari lalu';
};
const leftTxt = ms => { const m = Math.max(1, Math.ceil(ms / 60e3)); return m >= 60 ? 'Sisa ' + Math.floor(m / 60) + ' j ' + (m % 60) + ' mnt' : 'Sisa ' + m + ' mnt'; };
const expired = t => t.status === 'pending' && Date.parse(t.expAt) <= Date.now();
const STATUS = { pending: ['Menunggu', ''], lock: ['Diproses', ''], done: ['Selesai', 'ok'], cancel: ['Dibatalkan', ''], expire: ['Hangus', 'bad'] };
const roleOf = t => {
  const r = roles.get(t.id); if (r) return r;
  try { if (typeof uname === 'string' && uname) { if (t.from === uname) return 'from'; if (t.to === uname) return 'to'; } } catch {}
  return '';
};
const sideTxt = s => {
  const parts = [];
  if (s && s.coins > 0) parts.push(nf.format(s.coins) + ' Coin');
  for (const i of (s && s.items) || []) parts.push(i.n + ' ' + nameOf(i.id));
  return parts.join(', ') || 'kosong';
};
function avatarEl(label, url) {
  const a = h('span', 'wl-av', (String(label || '?').trim()[0] || '?').toUpperCase()); a.setAttribute('aria-hidden', 'true');
  if (url) { const im = new Image(); im.alt = ''; im.decoding = 'async'; im.draggable = false; im.referrerPolicy = 'no-referrer'; im.onerror = () => im.remove(); im.src = url; a.append(im); }
  return a;
}
const skeleton = () => {
  const g = h('div', 'wl-grid tr-grid'), a = h('div', 'wl-col tr-aside'), m = h('div', 'wl-col tr-main');
  for (const [c, hh] of [[a, 150], [m, 52], [m, 230], [m, 230]]) { const s = h('div', 'wl-sk'); s.style.height = hh + 'px'; s.setAttribute('aria-hidden', 'true'); c.append(s); }
  g.append(a, m); return g;
};

/* ---------- Muat daftar ---------- */
async function load(force) {
  if (typeof atok !== 'string' || !atok) return;
  if (S.loading) { if (force) S.again = true; return; }
  if (!force && S.view && Date.now() - S.at < 4000) return;
  S.loading = true; S.err = ''; if (active() && !S.view) render();
  try {
    const r = await aApi('trade');
    if (!r || !r.ok) throw new Error((r && r.error) || 'Gagal memuat perdagangan.');
    S.view = r; S.at = Date.now(); pushWallet(r);
    for (const t of r.incoming || []) roles.set(t.id, 'to');
    for (const t of r.outgoing || []) roles.set(t.id, 'from');
    // kartu yang punya pesan tapi sudah tidak ada di daftar aktif (mis. 409 "sudah dibatalkan"): angkat pesannya ke atas
    for (const id of Object.keys(S.msgs)) {
      if (![...(r.incoming || []), ...(r.outgoing || [])].some(t => t.id === id)) { S.notice = S.msgs[id]; delete S.msgs[id]; }
    }
    clampOffer();
  } catch (e) { if (!(e && e.status === 401)) S.err = (e && e.message) || 'Gagal memuat perdagangan.'; }
  S.loading = false;
  if (active()) render();
  if (F.open) { rebuildLists(); paintAll(); }
  if (S.again) { S.again = false; load(true); return; }
  loadCat().then(() => { if (active()) repaintNames(); if (F.open) rebuildLists(); });
}

/* ---------- Render halaman ---------- */
function render() {
  const box = $('trbody'); if (!box) return;
  const top = wallet.scrollTop;
  box.textContent = '';
  if (!S.view && !S.err) { box.append(skeleton()); return; }
  if (S.err && !S.view) {
    const g = h('div', 'wl-gate'); g.append(h('h2', null, 'Gagal memuat'), h('p', null, S.err));
    const b = h('button', 'wl-btn', 'Coba lagi'); b.type = 'button'; b.addEventListener('click', () => load(true)); g.append(b); box.append(g); return;
  }
  const v = S.view, r = v.rates, grid = h('div', 'wl-grid tr-grid'), main = h('div', 'wl-col tr-main'), aside = h('div', 'wl-col tr-aside');

  /* --- samping (di mobile tampil paling atas): tombol buat + batas --- */
  const full = v.outgoing.length >= r.pendingMax;
  const cta = h('button', 'wl-btn tr-new'); cta.type = 'button'; cta.dataset.a = 'new'; cta.disabled = !v.trust || full;
  cta.innerHTML = PLUS; cta.append(h('span', null, 'Penawaran baru'));
  const ctaBox = h('div', 'tr-ctabox'); ctaBox.append(cta);
  if (!v.trust) { const n = h('div', 'wl-note warn', 'Akunmu belum cukup berumur, jadi belum bisa membuat penawaran (anti akun cadangan).'); ctaBox.append(n); }
  else if (full) ctaBox.append(h('p', 'wl-why', 'Kamu sudah punya ' + r.pendingMax + ' penawaran aktif. Batalkan satu atau tunggu ada yang diterima.'));
  aside.append(ctaBox);

  const lim = h('section', 'wl-card tr-lim'); lim.append(h('h3', null, 'Batas penawaran'));
  const bar = h('div', 'wl-bar'), bt = h('div', 'wl-bartop'); bt.append(h('span', null, 'Penawaran aktif'), h('b', null, v.outgoing.length + ' dari ' + r.pendingMax));
  const tr = h('div', 'wl-track'), fi = h('i'); fi.style.width = Math.max(0, Math.min(100, r.pendingMax ? v.outgoing.length / r.pendingMax * 100 : 0)) + '%'; tr.append(fi);
  bar.append(bt, tr); lim.append(bar);
  lim.append(h('p', 'wl-small', 'Maksimal ' + r.rateMax + ' penawaran baru per jam.'));
  const rules = h('ul', 'wl-rules tr-rules');
  for (const t of [
    'Penawaran hangus otomatis dalam ' + r.expHours + ' jam kalau tidak diterima.',
    'Barang tidak ditahan saat kamu membuat penawaran. Stok dicek lagi saat penawaran diterima.',
    'Coin 0–' + nf.format(r.maxCoin) + ' per sisi, maksimal ' + r.maxKinds + ' jenis barang. Cincin gacha bisa ikut, Gems tidak.'
  ]) rules.append(h('li', null, t));
  lim.append(rules); aside.append(lim);

  /* --- utama: kabar, tab, daftar --- */
  if (S.done) {
    const ok = h('section', 'wl-card wl-done'), ic = h('span', 'wl-doneic'); ic.innerHTML = CHECK;
    const t = h('div', 'wl-donet'); t.append(h('b', null, 'Trade dengan ' + S.done.who + ' selesai'), h('small', null, 'Dapat ' + S.done.got + ', bayar ' + S.done.paid));
    const x = h('button', 'wl-x', '×'); x.type = 'button'; x.dataset.a = 'dismiss'; x.setAttribute('aria-label', 'Tutup');
    ok.append(ic, t, x); main.append(ok);
  }
  if (S.notice) {
    const n = h('div', 'wl-msg ' + (S.notice.kind || 'err') + ' tr-notice'); n.setAttribute('role', 'alert');
    n.append(h('span', null, S.notice.text));
    const x = h('button', 'wl-x', '×'); x.type = 'button'; x.dataset.a = 'dismissn'; x.setAttribute('aria-label', 'Tutup pesan'); n.append(x); main.append(n);
  }
  const tabs = h('div', 'tr-tabs'); tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', 'Bagian perdagangan');
  for (const [k, label, n] of [['in', 'Masuk', v.incoming.length], ['out', 'Kutawarkan', v.outgoing.length], ['done', 'Riwayat', 0]]) {
    const b = h('button', 'tr-tab' + (S.tab === k ? ' sel' : ''), label); b.type = 'button'; b.setAttribute('role', 'tab'); b.setAttribute('aria-selected', String(S.tab === k)); b.dataset.a = 'tab'; b.dataset.k = k;
    if (n > 0) b.append(h('span', 'tr-n', String(n)));
    tabs.append(b);
  }
  main.append(tabs);
  const list = S.tab === 'in' ? v.incoming : S.tab === 'out' ? v.outgoing : v.done;
  const lst = h('div', 'tr-list'); lst.setAttribute('role', 'tabpanel');
  if (!list.length) lst.append(h('section', 'wl-card tr-empty', { in: 'Belum ada penawaran untukmu.', out: 'Buat penawaran pertamamu — tukar barang yang tidak kamu butuhkan.', done: 'Belum ada riwayat.' }[S.tab]));
  else for (const t of list) lst.append(tradeCard(t, S.tab));
  main.append(lst);

  grid.append(aside, main); box.append(grid);
  wallet.scrollTop = top;
}

/* ---------- Kartu penawaran (dipakai di ketiga bagian) ---------- */
function lackOf(side) { // kekurangan SAYA untuk memenuhi satu sisi (dipakai pratinjau syarat + cek sebelum Terima)
  const v = S.view, out = [];
  if (side.coins > (v.coins || 0)) out.push({ k: 'coins', need: side.coins, have: v.coins || 0 });
  for (const i of side.items || []) { const have = (v.inv && v.inv[i.id]) | 0; if (have < i.n) out.push({ k: i.id, need: i.n, have }); }
  return out;
}
const lackTxt = l => l.k === 'coins' ? nf.format(l.need) + ' Coin (punya ' + nf.format(l.have) + ')' : l.need + ' ' + nameOf(l.k) + ' (punya ' + l.have + ')';

function chipEl(id, n, o) {
  const el = h(o && o.btn ? 'button' : 'span', 'tr-chip' + (o && o.short ? ' short' : ''));
  if (o && o.btn) { el.type = 'button'; el.dataset.a = 'dec'; el.dataset.k = o.key; el.dataset.id = id; }
  const im = new Image(); im.src = itemIcon(id); im.alt = ''; im.draggable = false; im.onerror = () => im.remove(); el.append(im);
  const nm = h('span', 'tr-nm', nameOf(id)); nm.dataset.nm = id; el.append(nm, h('b', null, '×' + n));
  if (o && o.btn) el.setAttribute('aria-label', 'Kurangi ' + nameOf(id) + ', sekarang ' + n);
  if (o && o.short) el.title = 'Kamu belum punya cukup';
  return el;
}
function sideEl(side, label, lack) {
  const d = h('div', 'tr-side'); d.append(h('small', 'tr-lab', label));
  const items = (side && side.items) || [], coins = (side && side.coins) || 0;
  if (!(coins > 0) && !items.length) { d.append(h('p', 'tr-none', 'Tidak ada')); return d; }
  if (coins > 0) {
    const c = h('div', 'tr-coin' + (lack && lack.has('coins') ? ' short' : '')); c.innerHTML = COIN; c.append(h('b', null, nf.format(coins)), h('span', null, 'Coin')); d.append(c);
  }
  if (items.length) { const w = h('div', 'tr-chips'); for (const i of items) w.append(chipEl(i.id, i.n, { short: lack && lack.has(i.id) })); d.append(w); }
  return d;
}
const swapEl = () => { const s = h('span', 'tr-swap'); s.innerHTML = SWAP; return s; };

function tradeCard(t, kind) {
  const exp = expired(t), st = exp ? 'expire' : t.status;
  const role = kind === 'in' ? 'to' : kind === 'out' ? 'from' : roleOf(t);
  const c = h('article', 'tr-card st-' + st); c.dataset.id = t.id;
  if (st === 'pending') c.dataset.exp = t.expAt;

  const head = h('div', 'tr-head');
  const other = role === 'to' ? t.from : role === 'from' ? t.to : '';
  head.append(avatarEl(other || '⇄'));
  const who = h('div', 'tr-who');
  who.append(h('b', null, role === 'to' ? 'Dari ' + t.from : role === 'from' ? 'Untuk ' + t.to : t.from + ' dan ' + t.to));
  const sm = h('small', null, st === 'done' && t.doneAt ? 'Selesai ' + relTime(t.doneAt) : 'Dibuat ' + relTime(t.createdAt));
  who.append(sm);
  if (st === 'pending') { const lt = h('small', 'tr-left', leftTxt(Date.parse(t.expAt) - Date.now())); who.append(lt); }
  head.append(who);
  const [stLabel, stCls] = STATUS[st] || [st, ''];
  head.append(h('span', 'tr-st' + (stCls ? ' ' + stCls : ''), stLabel));
  c.append(head);

  const canAccept = kind === 'in' && st === 'pending';
  const lack = canAccept ? lackOf(t.want) : [];
  const lackSet = new Set(lack.map(l => l.k));
  const labels = role === 'to' ? ['Dia berikan', 'Kamu berikan'] : role === 'from' ? ['Kamu berikan', 'Dia berikan'] : ['Penawar memberi', 'Penerima memberi'];
  const body = h('div', 'tr-body');
  body.append(sideEl(t.offer, labels[0], null), swapEl(), sideEl(t.want, labels[1], lackSet));
  c.append(body);

  if (canAccept) {
    const n = h('p', 'tr-need ' + (lack.length ? 'bad' : 'ok'));
    n.textContent = lack.length ? 'Syarat belum terpenuhi: kamu butuh ' + lack.map(lackTxt).join(', ') + '.' : 'Kamu punya semua yang diminta.';
    c.append(n);
  }
  if (st === 'done' && role) {
    const got = role === 'from' ? t.want : t.offer, paid = role === 'from' ? t.offer : t.want;
    c.append(h('p', 'tr-need', 'Dapat ' + sideTxt(got) + ', bayar ' + sideTxt(paid) + '.'));
  }
  if (st === 'lock') c.append(h('p', 'tr-need', 'Sedang diproses server. Daftar akan diperbarui sebentar lagi.'));
  const m = S.msgs[t.id];
  if (m) { const e = h('div', 'wl-msg ' + (m.kind || 'err'), m.text); e.setAttribute('role', 'alert'); c.append(e); }

  if (st === 'pending' && (kind === 'in' || kind === 'out')) {
    const busy = S.busyId === t.id, acts = h('div', 'tr-acts');
    const b = h('button', 'wl-btn' + (kind === 'in' ? ' tr-ok' : ' alt')); b.type = 'button'; b.dataset.a = kind === 'in' ? 'accept' : 'cancel'; b.dataset.id = t.id;
    b.disabled = !!S.busyId;
    if (busy) { b.append(h('i', 'tr-spin'), document.createTextNode(kind === 'in' ? 'Memproses…' : 'Membatalkan…')); b.setAttribute('aria-busy', 'true'); }
    else b.textContent = kind === 'in' ? 'Terima' : 'Batalkan';
    acts.append(b); c.append(acts);
  }
  return c;
}

/* ---------- Aksi: Terima / Batalkan ---------- */
const setMsg = (id, text, kind) => { S.msgs[id] = { text, kind: kind || 'err' }; };
async function accept(id) {
  if (S.busyId || !S.view) return;
  const t = (S.view.incoming || []).find(x => x.id === id); if (!t) return;
  if (expired(t)) { render(); return; }
  delete S.msgs[id]; S.notice = null;
  const lack = lackOf(t.want);
  if (lack.length) { // cek lokal dulu: pesan ramah sebelum request (server tetap penentu akhir)
    setMsg(id, 'Belum bisa diterima: simpananmu belum cukup untuk syarat di atas. Lengkapi dulu, lalu terima lagi.', 'err'); render(); load(true); return;
  }
  S.busyId = id; render();
  try {
    const r = await aApi('trade/accept', { id });
    if (!r || !r.ok) throw new Error((r && r.error) || 'Gagal menerima penawaran.');
    pushWallet(r); S.done = { who: t.from, got: r.got || sideTxt(t.offer), paid: r.paid || sideTxt(t.want) };
    roles.set(id, 'to');
    say('Trade selesai'); poke();
  } catch (e) {
    if (!(e && e.status === 401)) setMsg(id, (e && e.message) || 'Gagal menerima penawaran.', 'err'); // 409: kalimat server apa adanya
  }
  S.busyId = '';
  render(); await load(true);
}
async function cancel(id) {
  if (S.busyId || !S.view) return;
  delete S.msgs[id]; S.notice = null; S.busyId = id; render();
  try {
    const r = await aApi('trade/cancel', { id });
    if (!r || !r.ok) throw new Error((r && r.error) || 'Gagal membatalkan penawaran.');
    roles.set(id, 'from'); say('Penawaran dibatalkan'); poke();
  } catch (e) { if (!(e && e.status === 401)) setMsg(id, (e && e.message) || 'Gagal membatalkan penawaran.', 'err'); }
  S.busyId = '';
  render(); await load(true);
}

$('wtbody').addEventListener('click', e => {
  if (!$('trbody')) return;
  const b = e.target.closest('[data-a]'); if (!b || b.disabled) return;
  const a = b.dataset.a;
  if (a === 'tab') { S.tab = b.dataset.k; render(); }
  else if (a === 'new') openForm();
  else if (a === 'accept') accept(b.dataset.id);
  else if (a === 'cancel') cancel(b.dataset.id);
  else if (a === 'dismiss') { S.done = null; render(); }
  else if (a === 'dismissn') { S.notice = null; render(); }
});

/* sisa waktu dihitung lokal; kartu yang lewat batas langsung tampil "Hangus" (server menetapkan status sebenarnya saat dimuat ulang) */
setInterval(() => {
  if (document.hidden || !active() || !S.view) return;
  let redraw = false;
  $('trbody').querySelectorAll('.tr-card[data-exp]').forEach(c => {
    const ms = Date.parse(c.dataset.exp) - Date.now();
    if (ms <= 0) redraw = true;
    else { const l = c.querySelector('.tr-left'); if (l) l.textContent = leftTxt(ms); }
  });
  if (redraw) render();
}, 20000);

/* =====================================================================================================
   FORM PENAWARAN BARU (modal; bottom-sheet bertahap di mobile)
   ===================================================================================================== */
const modal = h('div', 'tr-modal hide'); modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true'); modal.setAttribute('aria-label', 'Penawaran baru');
modal.innerHTML = '<div class="tr-mbox" data-step="1"><div class="tr-mhead"><div class="tr-mt"><h2>Penawaran baru</h2><small class="tr-stepno"></small></div>' +
  '<button type="button" class="wl-x" data-a="close" aria-label="Tutup">×</button></div><div class="tr-mscroll"></div>' +
  '<div class="tr-mfoot"><div class="wl-msg hide" id="trfmsg" role="alert"></div><p class="wl-why" id="trwhy"></p>' +
  '<div class="tr-btns"><button type="button" class="tr-no" id="trsec"></button><button type="button" class="wl-btn" id="trpri"></button></div></div></div>';
wallet.append(modal);
const mBox = modal.querySelector('.tr-mbox'), mScroll = modal.querySelector('.tr-mscroll'), mMsg = $('trfmsg'), mWhy = $('trwhy'), mSec = $('trsec'), mPri = $('trpri'), mNo = modal.querySelector('.tr-stepno');

const sideNow = key => { // bentuk kerja satu sisi: { coins, kinds, n, items:[{id,n}] }
  const s = F[key], items = Object.keys(s.items).filter(k => s.items[k] > 0).map(id => ({ id, n: s.items[id] }));
  return { coins: toInt(s.coins), kinds: items.length, n: items.reduce((t, i) => t + i.n, 0), items };
};
const invOf = id => (S.view && S.view.inv && S.view.inv[id]) | 0;
const invIds = () => { const ids = Object.keys((S.view && S.view.inv) || {}).filter(k => invOf(k) > 0); const ord = new Map(CAT.map((c, i) => [c.id, i])); return ids.sort((a, b) => (ord.has(a) ? ord.get(a) : 999) - (ord.has(b) ? ord.get(b) : 999)); };
function clampOffer() { // stok berubah di server: jangan biarkan form menjanjikan lebih dari yang kupunya
  if (!S.view) return;
  for (const k of Object.keys(F.offer.items)) { const m = Math.min(QTY_MAX, invOf(k)); if (m <= 0) delete F.offer.items[k]; else if (F.offer.items[k] > m) F.offer.items[k] = m; }
}
function targetProblem() {
  if (!USER_RE.test(F.to)) return F.to ? 'Username tidak valid (3–20 huruf kecil, angka, titik, strip, garis bawah).' : 'Ketik username pemain yang mau kamu ajak trade.';
  try { if (typeof uname === 'string' && uname && uname.toLowerCase() === F.to) return 'Tidak bisa trade dengan diri sendiri.'; } catch {}
  return null;
}
function problem() { // alasan tombol Kirim nonaktif (null = boleh kirim)
  const v = S.view; if (!v) return 'Memuat…';
  if (!v.trust) return 'Akunmu belum cukup berumur, jadi belum bisa membuat penawaran (anti akun cadangan).';
  if (v.outgoing.length >= v.rates.pendingMax) return 'Kamu sudah punya ' + v.rates.pendingMax + ' penawaran aktif. Batalkan satu atau tunggu ada yang diterima.';
  const tp = targetProblem(); if (tp) return tp;
  const o = sideNow('offer'), w = sideNow('want'), r = v.rates;
  if (o.coins > r.maxCoin || w.coins > r.maxCoin) return 'Coin maksimal ' + nf.format(r.maxCoin) + ' per sisi.';
  if (o.kinds > r.maxKinds || w.kinds > r.maxKinds) return 'Maksimal ' + r.maxKinds + ' jenis barang per sisi.';
  if (!o.coins && !o.n && !w.coins && !w.n) return 'Isi coin atau barang di salah satu sisi.';
  if (o.coins > (v.coins || 0)) return 'Coin di dompetmu belum cukup untuk penawaran ini.';
  const lack = o.items.find(i => i.n > invOf(i.id)); if (lack) return 'Stok ' + nameOf(lack.id) + ' kamu belum cukup.';
  return null;
}
const touched = () => !!(F.to || F.offer.coins || F.want.coins || sideNow('offer').n || sideNow('want').n);

function buildPanel(key, title) {
  const p = h('section', 'tr-panel'); p.dataset.k = key;
  const hd = h('div', 'tr-phead'); hd.append(h('h3', null, title)); const cnt = h('small', null); cnt.id = 'tr-cnt-' + key; hd.append(cnt); p.append(hd);
  const f = h('div', 'wl-field'), l = h('label', null, 'Coin (0–' + nf.format(S.view.rates.maxCoin) + ')'); l.htmlFor = 'tr-c-' + key;
  const inp = h('input'); inp.type = 'text'; inp.id = 'tr-c-' + key; inp.inputMode = 'numeric'; inp.placeholder = '0'; inp.autocomplete = 'off'; inp.dataset.k = key; inp.value = F[key].coins; inp.disabled = F.busy;
  f.append(l, inp);
  if (key === 'offer') f.append(h('small', 'tr-hint', 'Saldomu: ' + nf.format(S.view.coins || 0) + ' Coin'));
  p.append(f);
  const picked = h('div', 'tr-picked'); picked.id = 'tr-p-' + key; p.append(picked);
  const head = h('button', 'wl-ihead'); head.type = 'button'; head.dataset.a = 'toggle'; head.dataset.k = key; head.id = 'tr-h-' + key; head.setAttribute('aria-expanded', String(F.list[key])); p.append(head);
  const list = h('div', 'wl-ilist' + (F.list[key] ? ' open' : '')); list.id = 'tr-l-' + key; p.append(list);
  return p;
}
function buildForm() {
  mScroll.textContent = '';
  const s1 = h('div', 'tr-s1'), f1 = h('div', 'wl-field'), l1 = h('label', null, 'Kirim penawaran ke'); l1.htmlFor = 'trto';
  const wrap = h('div', 'wl-ac tr-ac'), inp = h('input'); inp.id = 'trto'; inp.type = 'text'; inp.placeholder = 'username, mis. bravo'; inp.autocomplete = 'off'; inp.autocapitalize = 'off'; inp.spellcheck = false; inp.maxLength = 20; inp.value = F.to; inp.disabled = F.busy;
  wrap.append(inp); f1.append(l1, wrap);
  const pk = h('div', 'tr-pick'); pk.id = 'trpick'; f1.append(pk);
  const res = h('div', 'wl-res tr-res'); res.id = 'trres'; res.setAttribute('role', 'listbox'); f1.append(res);
  s1.append(f1);
  const s2 = h('div', 'tr-s2');
  const who = h('div', 'tr-who2'); who.id = 'trwho2'; s2.append(who);
  const pn = h('div', 'tr-panels'); pn.append(buildPanel('offer', 'Kamu berikan'), buildPanel('want', 'Kamu minta')); s2.append(pn);
  const pv = h('div', 'tr-preview'); pv.id = 'trpv'; s2.append(pv);
  mScroll.append(s1, s2);
  paintTarget(); rebuildLists(); paintAll();
}
function itemRow(key, id) {
  const q = F[key].items[id] | 0, max = key === 'offer' ? Math.min(QTY_MAX, invOf(id)) : QTY_MAX;
  const row = h('div', 'wl-irow' + (q ? ' on' : '')); row.dataset.id = id; row.dataset.k = key;
  const im = new Image(); im.src = itemIcon(id); im.alt = ''; im.draggable = false; im.className = 'wl-iic'; im.onerror = () => { im.style.visibility = 'hidden'; };
  const t = h('div', 'wl-it'), nm = h('b', null, nameOf(id)); nm.dataset.nm = id; t.append(nm);
  if (key === 'offer') t.append(h('small', null, 'Punya ' + nf.format(invOf(id))));
  const st = h('div', 'wl-step');
  const mi = h('button', null, '−'); mi.type = 'button'; mi.dataset.a = 'step'; mi.dataset.d = '-1'; mi.setAttribute('aria-label', 'Kurangi ' + nameOf(id)); mi.disabled = F.busy || q <= 0;
  const val = h('input'); val.type = 'text'; val.inputMode = 'numeric'; val.value = String(q); val.dataset.id = id; val.dataset.k = key; val.dataset.max = String(max); val.setAttribute('aria-label', 'Jumlah ' + nameOf(id)); val.disabled = F.busy;
  const pl = h('button', null, '+'); pl.type = 'button'; pl.dataset.a = 'step'; pl.dataset.d = '1'; pl.setAttribute('aria-label', 'Tambah ' + nameOf(id)); pl.disabled = F.busy || q >= max;
  st.append(mi, val, pl); row.append(im, t, st); return row;
}
function rebuildLists() { // isi daftar barang kedua panel (offer = stokku, want = seluruh katalog)
  if (!F.open) return;
  for (const key of ['offer', 'want']) {
    const list = $('tr-l-' + key); if (!list) continue;
    if (list.contains(document.activeElement)) continue; // jangan ganggu yang sedang diketik
    list.textContent = '';
    const ids = key === 'offer' ? invIds() : CAT.map(c => c.id);
    if (key === 'want' && !ids.length) {
      list.append(h('p', 'wl-empty', catBusy ? 'Memuat daftar barang…' : 'Daftar barang belum termuat.'));
      if (!catBusy) { const b = h('button', 'wl-q', 'Muat ulang'); b.type = 'button'; b.dataset.a = 'cat'; list.append(b); }
    } else if (!ids.length) list.append(h('p', 'wl-empty', 'Simpananmu kosong — beli dulu di Toko.'));
    else for (const id of ids) list.append(itemRow(key, id));
  }
  paintLimits();
}
function paintTarget() {
  const pk = $('trpick'), res = $('trres'); if (!pk || !res) return;
  pk.textContent = '';
  if (F.pick && F.pick.username === F.to) { const c = h('div', 'wl-chip'); c.append(avatarEl(F.pick.name || F.pick.username, F.pick.avatar), h('span', null, F.pick.name || F.pick.username), h('small', null, '@' + F.pick.username)); pk.append(c); }
  res.textContent = '';
  const open = !!(F.res.length || F.resErr);
  res.classList.toggle('open', open);
  if (F.resErr) res.append(h('div', 'wl-resmsg', F.resErr));
  for (const u of F.res) {
    const b = h('button', 'wl-resrow'); b.type = 'button'; b.setAttribute('role', 'option'); b.dataset.a = 'pick'; b.dataset.u = u.username;
    const t = h('span', 'wl-rt'); t.append(h('b', null, u.name || u.username), h('small', null, '@' + u.username));
    b.append(avatarEl(u.name || u.username, u.avatar), t); res.append(b);
  }
  const w2 = $('trwho2');
  if (w2) { w2.textContent = ''; w2.append(avatarEl((F.pick && F.pick.name) || F.to, F.pick && F.pick.avatar), h('span', null, 'Untuk ' + ((F.pick && F.pick.username === F.to && F.pick.name) ? F.pick.name + ' (@' + F.to + ')' : '@' + F.to))); const ch = h('button', 'tr-link', 'Ubah'); ch.type = 'button'; ch.dataset.a = 'back'; w2.append(ch); }
}
function paintPicked(key) {
  const box = $('tr-p-' + key); if (!box) return;
  box.textContent = '';
  const s = sideNow(key);
  for (const i of s.items) box.append(chipEl(i.id, i.n, { btn: true, key }));
  const r = S.view.rates, cnt = $('tr-cnt-' + key); if (cnt) cnt.textContent = s.kinds + '/' + r.maxKinds + ' jenis';
  const head = $('tr-h-' + key);
  if (head) { head.textContent = ''; head.append(h('span', null, key === 'offer' ? 'Pilih barang dari simpananmu' : 'Pilih barang yang kamu minta'), h('i', 'wl-chev')); head.disabled = F.busy; }
}
function paintLimits() { // jenis barang sudah penuh: kunci "+" untuk jenis yang belum dipilih
  const r = S.view.rates;
  for (const key of ['offer', 'want']) {
    const full = sideNow(key).kinds >= r.maxKinds;
    document.querySelectorAll('#tr-l-' + key + ' .wl-irow').forEach(row => {
      const id = row.dataset.id, q = F[key].items[id] | 0, pl = row.querySelector('button[data-d="1"]'), max = key === 'offer' ? Math.min(QTY_MAX, invOf(id)) : QTY_MAX;
      if (pl) pl.disabled = F.busy || q >= max || (q === 0 && full);
    });
  }
}
function paintPreview() {
  const pv = $('trpv'); if (!pv) return;
  pv.textContent = '';
  const o = sideNow('offer'), w = sideNow('want');
  pv.append(h('h3', null, 'Pratinjau penawaran'));
  const mk = s => ({ coins: s.coins, items: s.items });
  if (!o.coins && !o.n && !w.coins && !w.n) { pv.append(h('p', 'tr-none', 'Isi minimal satu sisi untuk melihat pratinjau.')); return; }
  const body = h('div', 'tr-body');
  body.append(sideEl(mk(o), 'Kamu berikan', null), swapEl(), sideEl(mk(w), 'Kamu dapat', null)); pv.append(body);
}
function paintFoot() {
  const stepped = mqM.matches, p = problem();
  mBox.dataset.step = String(F.step);
  mNo.textContent = stepped ? 'Langkah ' + F.step + ' dari 2' : '';
  if (stepped && F.step === 1) { mSec.textContent = 'Batal'; mSec.dataset.a = 'close'; mPri.textContent = 'Lanjut'; mPri.dataset.a = 'next'; mPri.disabled = !!(targetProblem() || (S.view && !S.view.trust)); mWhy.textContent = touched() ? (targetProblem() || '') : 'Ketik username pemain yang mau kamu ajak trade.'; }
  else {
    mSec.textContent = stepped ? 'Kembali' : 'Batal'; mSec.dataset.a = stepped ? 'back' : 'close';
    mPri.dataset.a = 'send'; mPri.textContent = F.busy ? 'Mengirim…' : 'Kirim penawaran'; mPri.disabled = !!p || F.busy; mPri.classList.toggle('busy', F.busy);
    mWhy.textContent = F.busy ? '' : (p && touched() ? p : '');
  }
  mSec.disabled = F.busy;
}
function paintAll() { if (!F.open || !S.view) return; paintPicked('offer'); paintPicked('want'); paintPreview(); paintFoot(); paintLimits(); }
function fmsg(text, kind) { F.msg = text || ''; mMsg.textContent = F.msg; mMsg.className = 'wl-msg' + (text ? ' ' + (kind || 'err') : ' hide'); }

function setQty(key, id, q) {
  const s = F[key].items, r = S.view.rates;
  q = Math.max(0, Math.min(key === 'offer' ? Math.min(QTY_MAX, invOf(id)) : QTY_MAX, q | 0));
  if (q > 0 && !(s[id] > 0) && sideNow(key).kinds >= r.maxKinds) { fmsg('Maksimal ' + r.maxKinds + ' jenis barang per sisi.', 'err'); return; }
  if (F.msg) fmsg('');
  if (q > 0) s[id] = q; else delete s[id];
  const row = document.querySelector('#tr-l-' + key + ' .wl-irow[data-id="' + CSS.escape(id) + '"]');
  if (row) {
    row.classList.toggle('on', q > 0);
    const inp = row.querySelector('input'); if (inp && document.activeElement !== inp) inp.value = String(q);
    const mi = row.querySelector('button[data-d="-1"]'); if (mi) mi.disabled = F.busy || q <= 0;
  }
  paintPicked(key); paintPreview(); paintFoot(); paintLimits();
}

async function searchUsers(q) {
  const seq = ++F.resSeq; F.resErr = '';
  try {
    const r = await aApi('users', { q });
    if (seq !== F.resSeq) return;
    F.res = ((r && r.items) || []).filter(u => !u.isMe).slice(0, 6);
  } catch (e) { if (seq !== F.resSeq || (e && e.status === 401)) return; F.res = []; F.resErr = (e && e.message) || 'Gagal mencari.'; }
  paintTarget();
}

function openForm(prefill) {
  if (!S.view) return;
  if (F.busy) return;
  F.open = true; F.step = 1; fmsg('');
  if (!F.idem) F.idem = uuid(); // satu niat = satu idem; baru dibuang setelah penawaran tercatat
  if (prefill && USER_RE.test(prefill.u)) { F.to = prefill.u; F.pick = prefill.name ? { username: prefill.u, name: prefill.name, avatar: prefill.avatar || '' } : null; F.res = []; }
  if (mqM.matches && !targetProblem()) F.step = 2; // target sudah terisi (mis. dari profil): langsung ke dua sisi
  buildForm();
  modal.classList.remove('hide'); requestAnimationFrame(() => modal.classList.add('show'));
  setTimeout(() => { const t = $('trto'); if (t && !F.to && (!mqM.matches || F.step === 1)) t.focus({ preventScroll: true }); else mPri.focus({ preventScroll: true }); }, 60);
}
function closeForm() {
  if (F.busy) return;
  F.open = false; F.res = []; modal.classList.remove('show');
  setTimeout(() => { if (!modal.classList.contains('show')) modal.classList.add('hide'); }, 220);
  const c = document.querySelector('#trbody .tr-new'); if (c) c.focus({ preventScroll: true });
}
function resetDraft() { F.to = ''; F.pick = null; F.res = []; F.offer = { coins: '', items: {} }; F.want = { coins: '', items: {} }; F.list = { offer: false, want: false }; F.idem = ''; F.step = 1; }
const sidePayload = key => { const s = sideNow(key), out = {}; if (s.coins > 0) out.coins = s.coins; if (s.kinds) out.items = Object.fromEntries(s.items.map(i => [i.id, i.n])); return out; }; // JANGAN kirim items kosong

async function submit() {
  if (F.busy || problem()) return;
  const payload = { to: F.to, offer: sidePayload('offer'), want: sidePayload('want'), idem: F.idem || (F.idem = uuid()) };
  const toName = (F.pick && F.pick.username === F.to && F.pick.name) || F.to;
  F.busy = true; fmsg(''); buildDisable(true); paintFoot();
  try {
    const r = await aApi('trade/create', payload);
    if (!r || !r.ok) throw new Error((r && r.error) || 'Gagal mengirim penawaran.');
    F.busy = false; resetDraft(); F.open = false; modal.classList.remove('show'); setTimeout(() => modal.classList.add('hide'), 220);
    S.tab = 'out'; S.notice = null;
    if (r.trade && S.view) { S.view.outgoing = [r.trade, ...(S.view.outgoing || []).filter(t => t.id !== r.trade.id)]; roles.set(r.trade.id, 'from'); }
    say('Penawaran terkirim ke ' + toName); poke();
    render(); await load(true);
    return;
  } catch (e) {
    F.busy = false; buildDisable(false);
    if (e && e.status === 401) { closeForm(); return; }
    const m = (e && e.message) || 'Gagal mengirim penawaran.';
    if (e && e.status === 409 && /sudah diproses/i.test(m)) { // idem duplikat: penawaran ini sudah tercatat (mis. respons sebelumnya hilang)
      resetDraft(); F.open = false; modal.classList.remove('show'); setTimeout(() => modal.classList.add('hide'), 220);
      S.tab = 'out'; say('Penawaranmu sudah tercatat. Cek di Kutawarkan.'); render(); await load(true); return;
    }
    fmsg(m, 'err');
    if (e && e.status === 404 && mqM.matches) F.step = 1;
    paintFoot();
    load(true); // status/saldo bisa berubah (mis. 409 stok kurang, 429 batas)
  }
}
function buildDisable(on) { // saat mengirim: kunci semua isian; setelah gagal: buka lagi dengan status tombol yang benar
  modal.querySelectorAll('input,.wl-step button,.wl-ihead,.tr-chip').forEach(x => { x.disabled = on; });
  if (!on) { rebuildLists(); paintPicked('offer'); paintPicked('want'); }
}

modal.addEventListener('click', e => {
  if (e.target === modal) { closeForm(); return; }
  const b = e.target.closest('[data-a]'); if (!b || b.disabled) return;
  const a = b.dataset.a;
  if (a === 'close') closeForm();
  else if (a === 'next') { if (!targetProblem()) { F.step = 2; mScroll.scrollTop = 0; paintFoot(); } }
  else if (a === 'back') { F.step = 1; paintFoot(); const t = $('trto'); if (t) t.focus({ preventScroll: true }); }
  else if (a === 'send') submit();
  else if (a === 'pick') {
    const u = F.res.find(x => x.username === b.dataset.u);
    F.to = b.dataset.u; F.pick = { username: F.to, name: (u && u.name) || '', avatar: (u && u.avatar) || '' }; F.res = []; F.resErr = '';
    const t = $('trto'); if (t) t.value = F.to; paintTarget(); paintFoot();
  }
  else if (a === 'toggle') { const k = b.dataset.k; F.list[k] = !F.list[k]; $('tr-l-' + k).classList.toggle('open', F.list[k]); b.setAttribute('aria-expanded', String(F.list[k])); }
  else if (a === 'step') { const row = b.closest('.wl-irow'); setQty(row.dataset.k, row.dataset.id, (F[row.dataset.k].items[row.dataset.id] | 0) + Number(b.dataset.d)); }
  else if (a === 'dec') setQty(b.dataset.k, b.dataset.id, (F[b.dataset.k].items[b.dataset.id] | 0) - 1); // sentuh chip = kurangi jumlah
  else if (a === 'cat') { loadCat().then(rebuildLists); rebuildLists(); }
});
modal.addEventListener('input', e => {
  const t = e.target;
  if (t.id === 'trto') {
    t.value = t.value.toLowerCase().replace(/[^a-z0-9_.-]/g, ''); F.to = t.value; if (F.pick && F.pick.username !== F.to) F.pick = null;
    clearTimeout(qT);
    if (F.to.length >= 1) qT = setTimeout(() => searchUsers(F.to), 250); else { F.res = []; F.resErr = ''; }
    paintTarget(); paintFoot();
  } else if (t.id === 'tr-c-offer' || t.id === 'tr-c-want') {
    const k = t.dataset.k, max = S.view.rates.maxCoin;
    const n = Math.min(toInt(t.value), max); F[k].coins = t.value.replace(/[^\d]/g, '') ? String(n) : ''; if (t.value !== F[k].coins) t.value = F[k].coins;
    if (F.msg) fmsg(''); paintPreview(); paintFoot();
  } else if (t.matches && t.matches('.wl-step input')) {
    const max = Number(t.dataset.max) || 0, q = Math.max(0, Math.min(max, toInt(t.value))); t.value = String(q); setQty(t.dataset.k, t.dataset.id, q);
  }
});
modal.addEventListener('keydown', e => {
  if (e.key === 'Escape') { e.stopPropagation(); if (F.res.length) { F.res = []; paintTarget(); } else closeForm(); return; }
  if (e.key === 'Enter' && e.target.id === 'trto') { e.preventDefault(); if (F.res.length === 1 && !F.pick) modal.querySelector('.wl-resrow').click(); else if (mqM.matches && F.step === 1 && !targetProblem()) { F.step = 2; paintFoot(); } return; }
  if (e.key === 'Tab') { // fokus tetap di dalam dialog
    const f = [...modal.querySelectorAll('button:not([disabled]),input:not([disabled])')].filter(x => x.offsetParent !== null);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
});
mqM.addEventListener && mqM.addEventListener('change', () => { if (F.open) { if (!mqM.matches) F.step = 1; paintFoot(); } });

/* =====================================================================================================
   Daftarkan sub-tab + peristiwa
   ===================================================================================================== */
WALLET.register('trade', {
  label: 'Perdagangan', title: 'Perdagangan', sub: 'Tukar barang dan Coin dengan teman. Kedua pihak harus setuju sebelum ada yang berpindah.',
  onOpen(meta) {
    if (meta && meta.u) {
      if (meta.compose) { const u = String(meta.u).toLowerCase().replace(/[^a-z0-9_.-]/g, '').slice(0, 20); F.to = u; F.pick = meta.name ? { username: u, name: meta.name, avatar: meta.avatar || '' } : null; S.compose = true; }
      else S.tab = 'in'; // dari notifikasi penawaran masuk
    }
    S.done = null; S.notice = null;
  },
  render(ctx) {
    ctx.body.textContent = ''; const box = h('div'); box.id = 'trbody'; ctx.body.append(box);
    render();
    load(true).then(() => { if (S.compose && S.view && active()) { S.compose = false; openForm(F.to ? { u: F.to, name: F.pick && F.pick.name, avatar: F.pick && F.pick.avatar } : null); } });
  }
});
window.addEventListener('acct', () => { // ganti akun / keluar: bersihkan semuanya
  const tok = typeof atok === 'string' ? atok : '';
  if (S.tok !== tok) {
    S.tok = tok; S.view = null; S.msgs = {}; S.notice = null; S.done = null; S.busyId = ''; S.tab = 'in'; S.compose = false; roles.clear(); resetDraft(); fmsg('');
    CAT = []; CATM = new Map(); catAt = 0;
    if (F.open) { F.open = false; F.busy = false; modal.classList.remove('show'); modal.classList.add('hide'); }
  }
});
window.addEventListener('notif:new', e => { // penawaran baru / diterima / dibatalkan saat layar terbuka: muat ulang
  const types = (e.detail && e.detail.types) || [];
  if (active() && !S.busyId && !F.busy && (types.includes('trade') || types.includes('trade-done'))) load(true);
});
document.addEventListener('visibilitychange', () => { if (!document.hidden && active()) load(true); });
})();
