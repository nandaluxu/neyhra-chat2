/* ===== Sub-tab Dompet > Market (pasaran barang antar-player) =====
   Spesifikasi: docs/frontend/marketplace.md (urutan README #6). Semua angka (fee, batas harga/qty, masa hangus, batas listing) DIPUTUSKAN
   SERVER dan ditampilkan dari `rates`; client hanya validasi tampilan + pratinjau fee (floor(harga * rates.feePct)).
   Endpoint (POST + Bearer, lewat aApi): market (jelajah + milik saya, body { item? }), market/list, market/buy, market/cancel.
   Dimuat SETELAH wallet.js (mendaftar lewat WALLET.register), sebelum router.js. Gaya: market.css (kelas mk-*) + kelas wl-* dan tr-* yang sudah ada.
   Tiga bagian: Jelajah | Tokoku (listing saya) | Pembelianku.
   Aturan konvensi (docs/frontend/README.md):
     - `idem` (UUID baru) dikirim di setiap konfirmasi beli/pasang. 409 "sudah diproses" ditampilkan apa adanya, TIDAK diulang otomatis.
     - 429 -> pesan server tampil + tombol aksi nonaktif ±10 dtk (tidak ada Retry-After).
     - Saldo header dari `coins` respons (pushWallet), bukan request `me` tambahan.
   Pintu masuk lain: klik notifikasi `market` -> WALLET.open('market', meta) -> bagian Tokoku (listingku laku). */
(() => {
'use strict';
if (!window.WALLET || typeof WALLET.register !== 'function') return;
const $ = id => document.getElementById(id);
const app = $('app'), wallet = $('wallet');
if (!app || !wallet) return;
const nf = new Intl.NumberFormat('id-ID');
const active = () => app.dataset.tab === 'wallet' && !!$('mkbody');
const h = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'id' + Date.now().toString(36) + Math.random().toString(36).slice(2, 12));
const poke = () => { try { window.NOTIF && NOTIF.poke(); } catch {} };
const toInt = v => { const n = Number(String(v).replace(/[^\d]/g, '')); return Number.isFinite(n) ? Math.floor(n) : 0; };
const COIN = '<img src="/coin.svg" alt="" draggable="false">';
const PLUS = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
const CHECK = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M8 12l3 3 5-6"/></svg>';
const itemIcon = id => '/shop/' + encodeURIComponent(id) + '.svg';
const COOL_MS = 10000; // setelah 429: nonaktifkan tombol aksi sebentar (konvensi docs/frontend/README.md)

function pushWallet(r) { // saldo header dari respons, tanpa request `me` tambahan
  try {
    if (!r || !Number.isFinite(r.coins)) return;
    const cur = (typeof loadWallet === 'function' && loadWallet()) || {};
    const next = { ...cur, coins: r.coins };
    if (Number.isFinite(r.gems)) next.gems = r.gems;
    if (Number.isFinite(next.coins) && Number.isFinite(next.gems)) saveWallet(next);
  } catch {}
}

/* toast bersama tab Dompet */
let toastEl = null, toastT = 0;
function say(t) {
  if (!toastEl) { toastEl = wallet.querySelector('.wl-toast'); if (!toastEl) { toastEl = h('div', 'wl-toast'); toastEl.setAttribute('role', 'status'); toastEl.setAttribute('aria-live', 'polite'); wallet.append(toastEl); } }
  toastEl.textContent = t; toastEl.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => toastEl.classList.remove('show'), 2800);
}

/* ---------- State ---------- */
const M = {
  view: null, loading: false, again: false, err: '', at: 0, tok: '',
  tab: 'browse',          // browse | mine | bought
  item: '',               // filter barang di Jelajah ('' = semua)
  busyId: '',             // listing yang sedang dibeli/dibatalkan (satu aksi pada satu waktu)
  msgs: {},               // id listing -> { text, kind }
  notice: null,           // { text, kind } di atas daftar
  done: null,             // ringkasan pembelian terakhir { text }
  cool: 0                 // sampai kapan tombol aksi dinonaktifkan (setelah 429)
};
const cooling = () => Date.now() < M.cool;
function startCool() { M.cool = Date.now() + COOL_MS; setTimeout(() => { if (active() && !cooling()) render(); }, COOL_MS + 50); }

/* ---------- Util tampilan ---------- */
const itemOf = id => ((M.view && M.view.items) || []).find(i => i.id === id) || null;
const nameOf = id => (itemOf(id) && itemOf(id).name) || String(id).replace(/-/g, ' ').replace(/^./, c => c.toUpperCase());
const relTime = iso => {
  const t = Date.parse(iso); if (!Number.isFinite(t)) return '';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return 'baru saja';
  if (s < 3600) return Math.floor(s / 60) + ' mnt lalu';
  if (s < 86400) return Math.floor(s / 3600) + ' jam lalu';
  return Math.floor(s / 86400) + ' hari lalu';
};
const leftTxt = ms => {
  if (ms <= 0) return 'Hangus';
  const m = Math.ceil(ms / 60e3);
  if (m < 60) return m + ' mnt lagi';
  const j = Math.floor(m / 60);
  return j < 24 ? j + ' jam lagi' : Math.floor(j / 24) + ' hari lagi';
};
const feeOf = (price, pct) => Math.floor(price * (pct || 0));
const STATUS = { listed: ['Aktif', ''], lock: ['Diproses', ''], sold: ['Terjual', 'ok'], cancel: ['Dibatalkan', ''], expire: ['Hangus', 'bad'] };
const isLive = l => l.status === 'listed' || l.status === 'lock';
const mineIds = () => new Set(((M.view && M.view.mine) || []).map(l => l.id));
const skeleton = () => {
  const g = h('div', 'wl-grid tr-grid'), a = h('div', 'wl-col tr-aside'), m = h('div', 'wl-col tr-main');
  for (const [c, hh] of [[a, 150], [m, 46], [m, 150], [m, 150]]) { const s = h('div', 'wl-sk'); s.style.height = hh + 'px'; s.setAttribute('aria-hidden', 'true'); c.append(s); }
  g.append(a, m); return g;
};
function itemIconEl(id, cls) {
  const im = new Image(); im.src = itemIcon(id); im.alt = ''; im.draggable = false; im.className = cls || 'mk-ic'; im.onerror = () => { im.style.visibility = 'hidden'; };
  return im;
}

/* ---------- Muat data ---------- */
async function load(force) {
  if (typeof atok !== 'string' || !atok) return;
  if (M.loading) { if (force) M.again = true; return; }
  if (!force && M.view && Date.now() - M.at < 4000) return;
  M.loading = true; M.err = ''; if (active() && !M.view) render();
  try {
    const r = await aApi('market', M.item ? { item: M.item } : {});
    if (!r || !r.ok) throw new Error((r && r.error) || 'Gagal memuat market.');
    M.view = r; M.at = Date.now(); pushWallet(r);
    // pesan di kartu yang sudah tidak ada di daftar (mis. 409 "sudah terjual"): angkat ke atas daftar
    const live = new Set([...(r.listings || []), ...(r.mine || [])].map(l => l.id));
    for (const id of Object.keys(M.msgs)) if (!live.has(id)) { M.notice = M.msgs[id]; delete M.msgs[id]; }
    if (M.item && !(r.items || []).some(i => i.id === M.item)) M.item = '';
  } catch (e) { if (!(e && e.status === 401)) M.err = (e && e.message) || 'Gagal memuat market.'; }
  M.loading = false;
  if (active()) render();
  if (M.again) { M.again = false; load(true); }
}

/* ---------- Render halaman ---------- */
function render() {
  const box = $('mkbody'); if (!box) return;
  const top = wallet.scrollTop, chipsX = (box.querySelector('.mk-filter') || {}).scrollLeft || 0;
  box.textContent = '';
  if (!M.view && !M.err) { box.append(skeleton()); return; }
  if (M.err && !M.view) {
    const g = h('div', 'wl-gate'); g.append(h('h2', null, 'Gagal memuat'), h('p', null, M.err));
    const b = h('button', 'wl-btn', 'Coba lagi'); b.type = 'button'; b.addEventListener('click', () => load(true)); g.append(b); box.append(g); return;
  }
  const v = M.view, r = v.rates, grid = h('div', 'wl-grid tr-grid'), main = h('div', 'wl-col tr-main'), aside = h('div', 'wl-col tr-aside');
  const live = (v.mine || []).filter(isLive).length;

  /* --- samping (di mobile paling atas): tombol pasang + batas + aturan --- */
  const full = live >= r.pendingMax;
  const cta = h('button', 'wl-btn tr-new'); cta.type = 'button'; cta.dataset.a = 'new'; cta.disabled = !v.trust || full || cooling();
  cta.innerHTML = PLUS; cta.append(h('span', null, 'Pasang lot'));
  const ctaBox = h('div', 'tr-ctabox'); ctaBox.append(cta);
  if (!v.trust) ctaBox.append(h('div', 'wl-note warn', 'Akunmu belum cukup berumur, jadi belum bisa berjualan (anti akun cadangan). Membeli tetap bisa.'));
  else if (full) ctaBox.append(h('p', 'wl-why', 'Kamu sudah punya ' + r.pendingMax + ' listing aktif. Batalkan satu atau tunggu ada yang laku.'));
  aside.append(ctaBox);

  const lim = h('section', 'wl-card tr-lim'); lim.append(h('h3', null, 'Batas listing'));
  const bar = h('div', 'wl-bar'), bt = h('div', 'wl-bartop'); bt.append(h('span', null, 'Listing aktif'), h('b', null, live + ' dari ' + r.pendingMax));
  const tr = h('div', 'wl-track'), fi = h('i'); fi.style.width = Math.max(0, Math.min(100, r.pendingMax ? live / r.pendingMax * 100 : 0)) + '%'; tr.append(fi);
  bar.append(bt, tr); lim.append(bar);
  lim.append(h('p', 'wl-small', 'Maksimal ' + r.rateMax + ' listing baru per jam.'));
  const rules = h('ul', 'wl-rules tr-rules');
  for (const t of [
    'Satu lot = satu harga untuk seluruh jumlahnya; pembeli membeli lot penuh.',
    'Barang langsung keluar dari inventaris saat dipasang (ditahan), dan kembali kalau dibatalkan atau hangus.',
    'Penjual menerima harga dikurangi fee ' + Math.round(r.feePct * 100) + '%. Fee dibuang dari permainan.',
    'Harga ' + nf.format(r.minPrice) + '–' + nf.format(r.maxPrice) + ' Coin per lot. Listing hangus otomatis dalam ' + Math.round(r.expHours / 24) + ' hari.'
  ]) rules.append(h('li', null, t));
  lim.append(rules); aside.append(lim);

  /* --- utama --- */
  if (M.done) {
    const ok = h('section', 'wl-card wl-done'), ic = h('span', 'wl-doneic'); ic.innerHTML = CHECK;
    const t = h('div', 'wl-donet'); t.append(h('b', null, M.done.title), h('small', null, M.done.sub));
    const x = h('button', 'wl-x', '×'); x.type = 'button'; x.dataset.a = 'dismiss'; x.setAttribute('aria-label', 'Tutup');
    ok.append(ic, t, x); main.append(ok);
  }
  if (M.notice) {
    const n = h('div', 'wl-msg ' + (M.notice.kind || 'err') + ' tr-notice'); n.setAttribute('role', 'alert');
    n.append(h('span', null, M.notice.text));
    const x = h('button', 'wl-x', '×'); x.type = 'button'; x.dataset.a = 'dismissn'; x.setAttribute('aria-label', 'Tutup pesan'); n.append(x); main.append(n);
  }
  const tabs = h('div', 'tr-tabs'); tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', 'Bagian market');
  for (const [k, label, n] of [['browse', 'Jelajah', 0], ['mine', 'Tokoku', live], ['bought', 'Pembelianku', 0]]) {
    const b = h('button', 'tr-tab' + (M.tab === k ? ' sel' : ''), label); b.type = 'button'; b.setAttribute('role', 'tab'); b.setAttribute('aria-selected', String(M.tab === k)); b.dataset.a = 'tab'; b.dataset.k = k;
    if (n > 0) b.append(h('span', 'tr-n', String(n)));
    tabs.append(b);
  }
  main.append(tabs);
  if (M.tab === 'browse') main.append(...browseEls(v));
  else if (M.tab === 'mine') main.append(mineEl(v));
  else main.append(boughtEl(v));

  grid.append(aside, main); box.append(grid);
  wallet.scrollTop = top;
  const f = box.querySelector('.mk-filter'); if (f) f.scrollLeft = chipsX;
}

/* ---------- Jelajah ---------- */
function browseEls(v) {
  const out = [], r = v.rates;
  // filter barang: chip "Semua" + tiap barang (daftar dari server, memuat harga toko sebagai patokan)
  const fl = h('div', 'wl-chips scroll mk-filter'); fl.setAttribute('role', 'group'); fl.setAttribute('aria-label', 'Filter barang');
  const all = h('button', 'wl-q mk-chip' + (!M.item ? ' sel' : ''), 'Semua'); all.type = 'button'; all.dataset.a = 'filter'; all.dataset.id = ''; all.setAttribute('aria-pressed', String(!M.item)); fl.append(all);
  for (const i of v.items || []) {
    const b = h('button', 'wl-q mk-chip' + (M.item === i.id ? ' sel' : '')); b.type = 'button'; b.dataset.a = 'filter'; b.dataset.id = i.id; b.setAttribute('aria-pressed', String(M.item === i.id));
    b.append(itemIconEl(i.id, 'mk-cic'), h('span', null, i.name)); fl.append(b);
  }
  out.push(fl);

  if (M.item) { // patokan harga: harga toko + 10 penjualan terakhir
    const it = itemOf(M.item), p = h('section', 'wl-card mk-prices');
    const head = h('div', 'tr-phead'); head.append(h('h3', null, 'Harga ' + (v.itemName || nameOf(M.item))), h('small', null, it && it.price > 0 ? 'Harga toko ' + nf.format(it.price) + ' Coin' : 'Cincin gacha: harga bebas'));
    p.append(head);
    if (!(v.prices || []).length) p.append(h('p', 'wl-small mk-p0', 'Belum ada penjualan untuk barang ini.'));
    else {
      const ul = h('ul', 'mk-plist');
      for (const x of v.prices) {
        const li = h('li'); li.append(h('b', null, nf.format(x.price) + ' Coin'), h('span', null, '×' + x.qty), h('small', null, (x.seller ? x.seller + ' · ' : '') + relTime(x.at)));
        ul.append(li);
      }
      p.append(ul);
    }
    out.push(p);
  }

  const list = v.listings || [], mine = mineIds();
  if (!list.length) out.push(h('section', 'wl-card tr-empty', M.item ? 'Belum ada yang menjual ' + (v.itemName || nameOf(M.item)) + '. Jadilah yang pertama!' : 'Belum ada yang jualan. Jadilah yang pertama!'));
  else {
    const g = h('div', 'mk-grid');
    for (const l of list) g.append(listingCard(l, { mine: mine.has(l.id), buy: true }));
    out.push(g);
    if (list.length >= r.listLimit) out.push(h('p', 'wl-small mk-more', 'Menampilkan ' + r.listLimit + ' listing terbaru. Pakai filter barang untuk mempersempit.'));
  }
  return out;
}

/* kartu listing: dipakai Jelajah (tombol Beli), Tokoku (Batalkan/status), Pembelianku */
function listingCard(l, o) {
  const v = M.view, exp = isLive(l) && Date.parse(l.expAt) <= Date.now(), st = exp ? 'expire' : l.status;
  const c = h('article', 'mk-card st-' + st); c.dataset.id = l.id; if (st === 'listed') c.dataset.exp = l.expAt;
  const head = h('div', 'mk-head');
  head.append(itemIconEl(l.item));
  const t = h('div', 'mk-t');
  const nm = h('b', null, nameOf(l.item)); nm.append(h('span', 'mk-q', ' ×' + l.qty)); t.append(nm);
  let sub = '';
  if (o.kind === 'bought') sub = 'Dari ' + l.seller + ' · ' + relTime(l.soldAt);
  else if (o.kind === 'mine') sub = st === 'sold' ? 'Dibeli ' + (l.buyer || '?') + ' · ' + relTime(l.soldAt) : 'Dipasang ' + relTime(l.createdAt);
  else sub = o.mine ? 'Listing milikmu' : 'Oleh ' + l.seller;
  t.append(h('small', null, sub));
  if (st === 'listed') t.append(h('small', 'mk-left', leftTxt(Date.parse(l.expAt) - Date.now())));
  head.append(t);
  if (o.kind === 'mine' || o.kind === 'bought') { const [lab, cls] = STATUS[st] || [st, '']; head.append(h('span', 'tr-st' + (cls ? ' ' + cls : ''), lab)); }
  c.append(head);

  const pr = h('div', 'mk-price'); pr.innerHTML = COIN; pr.append(h('b', null, nf.format(l.price)), h('span', null, 'Coin'));
  c.append(pr);
  const it = itemOf(l.item), shop = it && it.price > 0 ? it.price * l.qty : 0;
  const meta = [];
  if (o.kind === 'bought') meta.push('Harga toko ' + (shop ? nf.format(shop) : '—'));
  else {
    meta.push('Penjual terima ' + nf.format(l.proceeds) + ' (fee ' + nf.format(l.fee) + ')');
    if (shop) meta.push('Harga toko ' + nf.format(shop));
  }
  c.append(h('small', 'mk-meta', meta.join(' · ')));

  const m = M.msgs[l.id];
  if (m) { const e = h('div', 'wl-msg ' + (m.kind || 'err'), m.text); e.setAttribute('role', 'alert'); c.append(e); }

  const busy = M.busyId === l.id;
  if (o.buy && st === 'listed') {
    const lack = v.coins < l.price, b = h('button', 'wl-btn mk-buy' + (o.mine || lack ? ' alt' : '')); b.type = 'button'; b.dataset.a = 'buy'; b.dataset.id = l.id;
    b.disabled = !!M.busyId || o.mine || lack || cooling();
    if (busy) { b.append(h('i', 'tr-spin'), document.createTextNode('Memproses…')); b.setAttribute('aria-busy', 'true'); }
    else b.textContent = o.mine ? 'Milikmu' : lack ? 'Coin kurang' : 'Beli lot';
    c.append(b);
  } else if (o.kind === 'mine' && st === 'listed') {
    const b = h('button', 'wl-btn alt mk-buy'); b.type = 'button'; b.dataset.a = 'cancel'; b.dataset.id = l.id; b.disabled = !!M.busyId || cooling();
    if (busy) { b.append(h('i', 'tr-spin'), document.createTextNode('Membatalkan…')); b.setAttribute('aria-busy', 'true'); }
    else b.textContent = 'Batalkan';
    c.append(b);
  } else if (o.kind === 'mine' && st === 'lock') c.append(h('p', 'tr-need', 'Sedang diproses server. Daftar akan diperbarui sebentar lagi.'));
  return c;
}

/* ---------- Tokoku & Pembelianku ---------- */
function mineEl(v) {
  const w = h('div', 'tr-list'), list = v.mine || [];
  if (!list.length) { w.append(h('section', 'wl-card tr-empty', 'Pasang lot pertamamu.')); return w; }
  const g = h('div', 'mk-grid');
  for (const l of list) g.append(listingCard(l, { kind: 'mine' }));
  w.append(g);
  if (list.some(l => l.status === 'expire')) w.append(h('p', 'wl-small', 'Listing yang hangus: barangnya sudah kembali ke inventarismu.'));
  return w;
}
function boughtEl(v) {
  const w = h('div', 'tr-list'), list = v.bought || [];
  if (!list.length) { w.append(h('section', 'wl-card tr-empty', 'Belum ada pembelian.')); return w; }
  const g = h('div', 'mk-grid');
  for (const l of list) g.append(listingCard(l, { kind: 'bought' }));
  w.append(g);
  return w;
}

/* =====================================================================================================
   BELI (modal konfirmasi) + BATAL
   ===================================================================================================== */
const buyM = h('div', 'wl-modal hide'); buyM.setAttribute('role', 'dialog'); buyM.setAttribute('aria-modal', 'true'); buyM.setAttribute('aria-label', 'Konfirmasi pembelian');
buyM.innerHTML = '<div class="wl-mbox"><h2>Beli lot ini?</h2><div class="wl-mbody"></div><div class="wl-mmsg wl-msg hide" role="alert"></div><div class="wl-mbtns"><button type="button" class="wl-no">Batal</button><button type="button" class="wl-btn wl-yes">Ya, beli</button></div></div>';
wallet.append(buyM);
let buyL = null, buyBusy = false;
const bmMsg = (t) => { const m = buyM.querySelector('.wl-mmsg'); m.textContent = t || ''; m.className = 'wl-mmsg wl-msg' + (t ? ' err' : ' hide'); };
function openBuy(id) {
  const l = ((M.view && M.view.listings) || []).find(x => x.id === id); if (!l || M.busyId) return;
  buyL = l; buyBusy = false; bmMsg('');
  const v = M.view, box = buyM.querySelector('.wl-mbody'); box.textContent = '';
  const rows = [['Barang', nameOf(l.item) + ' ×' + l.qty], ['Harga', nf.format(l.price) + ' Coin'], ['Penjual', l.seller], ['Penjual menerima', nf.format(l.proceeds) + ' Coin (fee ' + nf.format(l.fee) + ')'], ['Saldomu setelah beli', nf.format(Math.max(0, v.coins - l.price)) + ' Coin']];
  const dl = h('dl', 'wl-sum'); for (const [k, val] of rows) { const r = h('div'); r.append(h('dt', null, k), h('dd', null, val)); dl.append(r); }
  box.append(dl, h('p', 'wl-warn', 'Kamu membeli seluruh lot. Pembelian tidak bisa dibatalkan.'));
  buyM.querySelector('.wl-yes').disabled = false; buyM.querySelector('.wl-no').disabled = false;
  buyM.classList.remove('hide'); requestAnimationFrame(() => buyM.classList.add('show'));
  buyM.querySelector('.wl-yes').focus({ preventScroll: true });
}
function closeBuy() {
  if (buyBusy) return;
  buyL = null; buyM.classList.remove('show'); setTimeout(() => { if (!buyM.classList.contains('show')) buyM.classList.add('hide'); }, 220);
}
async function confirmBuy() {
  if (buyBusy || !buyL || M.busyId) return;
  const l = buyL, yes = buyM.querySelector('.wl-yes'), no = buyM.querySelector('.wl-no');
  if (M.view && M.view.coins < l.price) { bmMsg('Coin kamu belum cukup.'); return; }
  buyBusy = true; yes.disabled = true; no.disabled = true; yes.textContent = 'Memproses…'; bmMsg('');
  M.busyId = l.id; delete M.msgs[l.id]; M.notice = null;
  let okRes = null, errText = '', errStatus = 0;
  try {
    const r = await aApi('market/buy', { id: l.id, idem: uuid() });
    if (!r || !r.ok) throw new Error((r && r.error) || 'Gagal membeli.');
    okRes = r;
  } catch (e) { errText = (e && e.message) || 'Gagal membeli.'; errStatus = (e && e.status) || 0; if (e && e.status === 401) errText = ''; }
  buyBusy = false; yes.textContent = 'Ya, beli'; yes.disabled = false; no.disabled = false; M.busyId = '';
  if (okRes) {
    pushWallet(okRes);
    const got = okRes.got || { item: l.item, qty: l.qty };
    M.done = { title: 'Dapat ' + got.qty + ' ' + nameOf(got.item), sub: 'Bayar ' + nf.format(okRes.paid != null ? okRes.paid : l.price) + ' Coin ke ' + l.seller };
    say('Dapat ' + got.qty + ' ' + nameOf(got.item)); poke();
    closeBuy();
  } else if (errText) {
    if (errStatus === 429) startCool();
    M.msgs[l.id] = { text: errText, kind: 'err' }; // 409 (sudah terjual / coin kurang / simpanan penuh): kalimat server apa adanya
    closeBuy();
  } else closeBuy();
  render(); await load(true);
}
buyM.addEventListener('click', e => {
  if (e.target === buyM || e.target.closest('.wl-no')) { closeBuy(); return; }
  if (e.target.closest('.wl-yes')) confirmBuy();
});
buyM.addEventListener('keydown', e => {
  if (e.key === 'Escape') { e.stopPropagation(); closeBuy(); return; }
  if (e.key === 'Tab') {
    const f = [...buyM.querySelectorAll('button:not([disabled])')]; if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
});

async function cancel(id) {
  if (M.busyId || !M.view) return;
  delete M.msgs[id]; M.notice = null; M.busyId = id; render();
  try {
    const r = await aApi('market/cancel', { id });
    if (!r || !r.ok) throw new Error((r && r.error) || 'Gagal membatalkan listing.');
    say('Listing dibatalkan, barang kembali'); poke();
  } catch (e) {
    if (e && e.status === 429) startCool();
    if (!(e && e.status === 401)) M.msgs[id] = { text: (e && e.message) || 'Gagal membatalkan listing.', kind: 'err' };
  }
  M.busyId = '';
  render(); await load(true);
}

/* =====================================================================================================
   FORM PASANG LOT (modal; bottom-sheet di mobile)
   ===================================================================================================== */
const F = { open: false, busy: false, item: '', qty: 1, price: '' };
const fm = h('div', 'tr-modal hide mk-form'); fm.setAttribute('role', 'dialog'); fm.setAttribute('aria-modal', 'true'); fm.setAttribute('aria-label', 'Pasang lot');
fm.innerHTML = '<div class="tr-mbox mk-fbox"><div class="tr-mhead"><div class="tr-mt"><h2>Pasang lot</h2></div><button type="button" class="wl-x" data-a="close" aria-label="Tutup">×</button></div>' +
  '<div class="tr-mscroll"><div class="wl-field"><label>Barang dari inventarismu</label><div class="mk-picks" id="mkpicks"></div></div>' +
  '<div class="wl-field mk-qtyf"><label for="mkqty">Jumlah</label><div class="wl-step"><button type="button" data-a="qm" aria-label="Kurangi jumlah">−</button><input type="text" id="mkqty" inputmode="numeric" autocomplete="off" aria-label="Jumlah barang"><button type="button" data-a="qp" aria-label="Tambah jumlah">+</button></div><small class="mk-hint" id="mkqh"></small></div>' +
  '<div class="wl-field"><label for="mkprice">Harga untuk seluruh lot (Coin)</label><input type="text" id="mkprice" inputmode="numeric" autocomplete="off" placeholder="mis. 700"><div class="wl-chips" id="mkpq"></div></div>' +
  '<div class="tr-preview mk-prev" id="mkprev"></div></div>' +
  '<div class="tr-mfoot"><div class="wl-msg hide" id="mkfmsg" role="alert"></div><p class="wl-why" id="mkwhy"></p><div class="tr-btns"><button type="button" class="tr-no" data-a="close">Batal</button><button type="button" class="wl-btn" id="mkgo" data-a="go">Pasang lot</button></div></div></div>';
wallet.append(fm);
const fmsg = t => { const m = $('mkfmsg'); m.textContent = t || ''; m.className = 'wl-msg' + (t ? ' err' : ' hide'); };
const stock = id => Math.max(0, ((M.view && M.view.inv && M.view.inv[id]) | 0));
const ownedItems = () => ((M.view && M.view.items) || []).filter(i => stock(i.id) > 0);
function openForm() {
  const v = M.view; if (!v || F.open) return;
  if (!v.trust) { say('Akunmu belum cukup berumur untuk berjualan'); return; }
  const own = ownedItems();
  F.open = true; F.busy = false; F.item = own.length ? own[0].id : ''; F.qty = 1; F.price = ''; fmsg('');
  buildPicks(); paintForm();
  fm.classList.remove('hide'); requestAnimationFrame(() => fm.classList.add('show'));
  setTimeout(() => { const f = F.item ? $('mkprice') : fm.querySelector('[data-a="close"]'); if (f) f.focus({ preventScroll: true }); }, 60);
}
function closeForm(force) {
  if (!F.open || (F.busy && !force)) return;
  F.open = false; fm.classList.remove('show'); setTimeout(() => { if (!fm.classList.contains('show')) fm.classList.add('hide'); }, 220);
  const c = document.querySelector('#mkbody .tr-new'); if (c) c.focus({ preventScroll: true });
}
function buildPicks() {
  const box = $('mkpicks'); box.textContent = '';
  const own = ownedItems();
  if (!own.length) { box.append(h('p', 'wl-empty', 'Inventarismu kosong. Beli barang di Toko atau dapatkan dari gacha dulu.')); return; }
  for (const i of own) {
    const b = h('button', 'mk-pick' + (F.item === i.id ? ' on' : '')); b.type = 'button'; b.dataset.a = 'pick'; b.dataset.id = i.id; b.setAttribute('aria-pressed', String(F.item === i.id));
    b.append(itemIconEl(i.id, 'mk-pic'), h('span', 'mk-pn', i.name), h('small', null, '×' + stock(i.id)));
    box.append(b);
  }
}
function paintForm() {
  const v = M.view; if (!v) return;
  const r = v.rates, st = stock(F.item), maxQ = Math.min(r.maxQty, st);
  F.qty = Math.max(maxQ ? 1 : 0, Math.min(maxQ, F.qty | 0));
  $('mkpicks').querySelectorAll('.mk-pick').forEach(b => { const on = b.dataset.id === F.item; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); });
  const qi = $('mkqty'); if (document.activeElement !== qi) qi.value = F.item ? String(F.qty) : '';
  qi.disabled = !F.item || F.busy;
  fm.querySelector('[data-a="qm"]').disabled = !F.item || F.qty <= 1 || F.busy;
  fm.querySelector('[data-a="qp"]').disabled = !F.item || F.qty >= maxQ || F.busy;
  $('mkqh').textContent = F.item ? 'Stok ' + st + ', maksimal ' + r.maxQty + ' per lot' : '';
  const pi = $('mkprice'); if (document.activeElement !== pi) pi.value = F.price; pi.disabled = !F.item || F.busy;
  // pakai harga toko sebagai patokan cepat
  const it = itemOf(F.item), q = $('mkpq'); q.textContent = '';
  if (it && it.price > 0) {
    const base = it.price * F.qty;
    for (const [lab, val] of [['Harga toko ' + nf.format(base), base], ['−20%', Math.round(base * 0.8)], ['+20%', Math.round(base * 1.2)]]) {
      const b = h('button', 'wl-q', lab); b.type = 'button'; b.dataset.a = 'pq'; b.dataset.v = String(Math.max(r.minPrice, Math.min(r.maxPrice, val))); b.disabled = F.busy; q.append(b);
    }
  } else if (F.item) q.append(h('small', 'mk-hint', 'Cincin gacha: harga bebas, pasar yang menentukan.'));
  // pratinjau fee + penerimaan
  const price = toInt(F.price), pv = $('mkprev'); pv.textContent = '';
  pv.append(h('h3', null, 'Ringkasan'));
  const fee = feeOf(price, r.feePct), rows = [['Lot', F.item ? nameOf(F.item) + ' ×' + F.qty : '—'], ['Harga', price ? nf.format(price) + ' Coin' : '—'], ['Fee ' + Math.round(r.feePct * 100) + '%', price ? '−' + nf.format(fee) : '—'], ['Kamu terima jika laku', price ? nf.format(price - fee) + ' Coin' : '—']];
  const dl = h('dl', 'wl-sum'); for (const [k, val] of rows) { const rw = h('div'); rw.append(h('dt', null, k), h('dd', null, val)); dl.append(rw); }
  pv.append(dl);
  const why = problem(); $('mkwhy').textContent = why;
  $('mkgo').disabled = !!why || F.busy || cooling();
  $('mkgo').textContent = F.busy ? 'Memasang…' : 'Pasang lot';
}
function problem() {
  const v = M.view, r = v.rates, price = toInt(F.price);
  if (!F.item) return ownedItems().length ? 'Pilih barang yang mau dijual.' : 'Kamu belum punya barang untuk dijual.';
  if (F.qty < 1 || F.qty > Math.min(r.maxQty, stock(F.item))) return 'Jumlah 1 sampai ' + Math.min(r.maxQty, stock(F.item)) + '.';
  if (!price) return 'Isi harga untuk seluruh lot.';
  if (price < r.minPrice || price > r.maxPrice) return 'Harga ' + nf.format(r.minPrice) + ' sampai ' + nf.format(r.maxPrice) + ' Coin per lot.';
  if ((v.mine || []).filter(isLive).length >= r.pendingMax) return 'Listing aktifmu sudah penuh (' + r.pendingMax + ').';
  return '';
}
async function submitList() {
  if (F.busy || problem() || cooling()) return;
  F.busy = true; fmsg(''); paintForm();
  const body = { item: F.item, qty: F.qty, price: toInt(F.price), idem: uuid() };
  try {
    const r = await aApi('market/list', body);
    if (!r || !r.ok) throw new Error((r && r.error) || 'Gagal memasang listing.');
    pushWallet(r);
    if (M.view && r.inv) M.view.inv = r.inv; // inventaris berkurang seketika (dari respons)
    F.busy = false; closeForm(true);
    M.tab = 'mine'; M.notice = null; M.done = { title: 'Lot terpasang', sub: body.qty + ' ' + nameOf(body.item) + ' dijual ' + nf.format(body.price) + ' Coin' };
    say('Lot terpasang'); poke(); render(); await load(true); return;
  } catch (e) {
    F.busy = false;
    if (e && e.status === 401) { closeForm(true); return; }
    if (e && e.status === 429) startCool();
    fmsg((e && e.message) || 'Gagal memasang listing.'); // 400/403/409: kalimat server apa adanya
    if (e && e.status === 409) load(true); // stok berubah: segarkan inventaris
  }
  if (F.open) paintForm();
}
fm.addEventListener('click', e => {
  if (e.target === fm) { closeForm(); return; }
  const b = e.target.closest('[data-a]'); if (!b || b.disabled) return;
  const a = b.dataset.a;
  if (a === 'close') closeForm();
  else if (a === 'pick') { F.item = b.dataset.id; F.qty = 1; F.price = ''; fmsg(''); paintForm(); }
  else if (a === 'qm') { F.qty -= 1; paintForm(); }
  else if (a === 'qp') { F.qty += 1; paintForm(); }
  else if (a === 'pq') { F.price = b.dataset.v; fmsg(''); paintForm(); }
  else if (a === 'go') submitList();
});
fm.addEventListener('input', e => {
  const t = e.target;
  if (t.id === 'mkqty') { F.qty = toInt(t.value); t.value = t.value.replace(/[^\d]/g, ''); paintForm(); }
  else if (t.id === 'mkprice') {
    const n = Math.min(toInt(t.value), M.view.rates.maxPrice); F.price = t.value.replace(/[^\d]/g, '') ? String(n) : ''; if (t.value !== F.price) t.value = F.price; fmsg(''); paintForm();
  }
});
fm.addEventListener('keydown', e => {
  if (e.key === 'Escape') { e.stopPropagation(); closeForm(); return; }
  if (e.key === 'Enter' && (e.target.id === 'mkprice' || e.target.id === 'mkqty')) { e.preventDefault(); submitList(); return; }
  if (e.key === 'Tab') {
    const f = [...fm.querySelectorAll('button:not([disabled]),input:not([disabled])')].filter(x => x.offsetParent !== null); if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
});

/* ---------- Klik di halaman ---------- */
$('wtbody').addEventListener('click', e => {
  if (!$('mkbody')) return;
  const b = e.target.closest('[data-a]'); if (!b || b.disabled) return;
  const a = b.dataset.a;
  if (a === 'tab') { M.tab = b.dataset.k; render(); if (M.tab === 'mine' || M.tab === 'bought') load(true); }
  else if (a === 'filter') { M.item = b.dataset.id || ''; render(); load(true); } // muat ulang dengan filter: listing terfilter + riwayat harga
  else if (a === 'new') openForm();
  else if (a === 'buy') openBuy(b.dataset.id);
  else if (a === 'cancel') cancel(b.dataset.id);
  else if (a === 'dismiss') { M.done = null; render(); }
  else if (a === 'dismissn') { M.notice = null; render(); }
});

/* sisa waktu listing dihitung lokal; yang lewat batas langsung "Hangus" (status asli dari server saat muat ulang) */
setInterval(() => {
  if (document.hidden || !active() || !M.view) return;
  let redraw = false;
  $('mkbody').querySelectorAll('.mk-card[data-exp]').forEach(c => {
    const ms = Date.parse(c.dataset.exp) - Date.now();
    if (ms <= 0) redraw = true; else { const l = c.querySelector('.mk-left'); if (l) l.textContent = leftTxt(ms); }
  });
  if (redraw) load(true);
}, 30000);

/* =====================================================================================================
   Daftarkan sub-tab + peristiwa
   ===================================================================================================== */
WALLET.register('market', {
  label: 'Market', title: 'Market', sub: 'Jual barangmu dengan harga Coin terbuka, atau beli dari pemain lain. Harga ditentukan pasar.',
  onOpen(meta) {
    if (meta && meta.u) M.tab = 'mine'; // dari notifikasi "listingmu laku"
    M.done = null; M.notice = null;
  },
  render(ctx) {
    ctx.body.textContent = ''; const box = h('div'); box.id = 'mkbody'; ctx.body.append(box);
    render();
    load(true);
  }
});
window.addEventListener('acct', () => { // ganti akun / keluar: bersihkan semuanya
  const tok = typeof atok === 'string' ? atok : '';
  if (M.tok !== tok) {
    M.tok = tok; M.view = null; M.msgs = {}; M.notice = null; M.done = null; M.busyId = ''; M.tab = 'browse'; M.item = ''; M.cool = 0;
    if (F.open) { F.open = false; F.busy = false; fm.classList.remove('show'); fm.classList.add('hide'); }
    if (buyL) { buyBusy = false; buyL = null; buyM.classList.remove('show'); buyM.classList.add('hide'); }
  }
});
window.addEventListener('notif:new', e => { // listingku laku / pembelian tercatat saat layar terbuka: muat ulang
  const types = (e.detail && e.detail.types) || [];
  if (active() && !M.busyId && !F.busy && !buyBusy && types.includes('market')) load(true);
});
document.addEventListener('visibilitychange', () => { if (!document.hidden && active()) load(true); });
})();
