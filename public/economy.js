/* ===== Ekonomi: Gacha (Card Flip / Deck Reveal) + Tukar Currency =====
   Dimuat setelah shop.js. Tab Toko punya 3 bagian (#shnav): "Belanja" dirender shop.js, "Gacha" dan "Tukar"
   dirender file ini lewat window.ECON.show(). Semua aturan (rasio tukar, bonus bertingkat, harga tiket, peluang
   Ring, pity, refund) dijaga server (lib/economy.js) dan dikirim lewat /api/auth/economy — di sini hanya
   menampilkan pratinjau dari config yang sama dan memanggil endpoint transaksinya.

   Alur gacha: hasil DITENTUKAN SERVER dulu (/api/auth/economy/gacha, RNG di server), baru animasi jalan.
   Pemilihan kartu hanya visual (posisi diacak di client, isi tiap kartu sudah dipatok server) — client
   tidak pernah menentukan reward. Single pull = pilih 1 dari 3-5 kartu tertutup (semuanya berisi hasil
   yang sama); multi 10x = 10 kartu dibuka bertahap, bisa "Buka Semua" / "Lewati".

   Memakai global index.html: atok, aOn, aApi, saveWallet, paintWallet, loadWallet, toast, openLogin, Shell,
   store, SHP (shop.js). */
(() => {
'use strict';
const $ = id => document.getElementById(id);
const app = $('app'), body = $('shbody');
const nf = new Intl.NumberFormat('id-ID');
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'id' + Date.now() + Math.random().toString(36).slice(2));
const active = () => app.dataset.tab === 'shop';
const icon = id => '/shop/' + encodeURIComponent(id) + '.svg';
const COIN = '<img src="/coin.svg" alt="" draggable="false">';
const GEM = '<img src="/gems.png" alt="" draggable="false">';
const TICK = '<img src="/ticket.svg" alt="" draggable="false">';

let E = null;                 // jawaban /api/auth/economy
let view = 'gacha';           // 'gacha' | 'tukar'
let failed = '', loading = false, busy = false;

/* ---------- Pintu dari shop.js (#shnav) ---------- */
window.ECON = {
  show(v) {
    if (v !== 'gacha' && v !== 'tukar') return;
    view = v; render(); load(false);
  }
};

async function load(force) {
  if (!aOn || !atok) { E = null; failed = ''; render(); return; }
  if (loading) return;
  if (!force && E && Date.now() - (E.at || 0) < 15000) { render(); return; }
  loading = true; if (!E && viewNeedsData()) render();
  try {
    const r = await aApi('economy');
    if (r && r.ok) { E = { ...r, at: Date.now() }; failed = ''; saveWallet(r); }
  } catch (e) { if (!E) failed = e.message || 'Gagal memuat.'; }
  loading = false; render();
}
const viewNeedsData = () => true;

const empty = (title, text, btn) => '<div class="bn-empty"><h2>' + esc(title) + '</h2>' + (text ? '<p>' + esc(text) + '</p>' : '') + (btn || '') + '</div>';
function render() {
  if (!SHP || SHP.view !== view) return; // bukan bagian yang sedang aktif
  if (!aOn) { body.innerHTML = empty('Belum tersedia', 'Fitur akun belum aktif di server ini.'); return; }
  if (!atok) { body.innerHTML = empty('Masuk dulu ya', 'Tiket, gems, dan coin tersimpan di akunmu, jadi kamu perlu masuk atau daftar dulu.', '<button class="bn-go" type="button" data-act="login">Masuk / Daftar</button>'); return; }
  if (!E) { body.innerHTML = failed ? empty('Gagal memuat', failed, '<button class="bn-go" type="button" data-act="retry">Coba lagi</button>') : empty('Memuat…'); return; }
  view === 'gacha' ? (stage ? renderStage() : renderGacha()) : renderEx();
}

/* ================= GACHA ================= */
let stage = null; // { mode, results, order:[idx kartu -> idx hasil], opened:Set, all:boolean }

function renderGacha() {
  const g = E.gacha || {}, p = E.pity || { now: 0, max: 60 }, rings = E.rings || [];
  const left = Math.max(0, (p.max || 60) - (p.now || 0));
  const singleOk = E.tickets >= g.single.tickets, multiOk = E.tickets >= g.multi.tickets;
  body.innerHTML =
    '<div class="gc-hero">' +
      '<div class="gc-hero-cards">' + rings.map((r, i) => '<img src="' + icon(r.id) + '" alt="" class="gc-hero-r' + (rings.length - i) + '" draggable="false">').join('') + '</div>' +
      '<h2>Gacha Cincin</h2>' +
      '<p>Gunakan tiket untuk menarik kartu. Dapat <b>Cincin</b> = hadiah utama masuk Inventory. Tidak dapat? <b>Gems-mu kembali</b> (' + nf.format(g.refundGems) + ' per kartu).</p>' +
    '</div>' +
    '<div class="gc-stats">' +
      '<div class="gc-pity"><div class="gc-pity-t"><span>Jaminan Cincin</span><b>' + left + ' pull lagi</b></div>' +
        '<div class="gc-bar"><i style="width:' + Math.min(100, Math.round(100 * (p.now || 0) / (p.max || 60))) + '%"></i></div>' +
        '<small>Tanpa cincin ' + nf.format(p.max) + ' pull berturut-turut, pull berikutnya pasti cincin.</small></div>' +
      '<div class="gc-inv">' + (rings.map(r => '<span class="gc-ring' + (invRing(r.id) ? '' : ' zero') + '"><img src="' + icon(r.id) + '" alt="" draggable="false"><b>' + nf.format(invRing(r.id)) + '</b></span>').join('')) + '</div>' +
    '</div>' +
    '<div class="gc-pull">' +
      '<button type="button" class="gc-btn" data-act="pull" data-id="single"' + (!singleOk || busy ? ' disabled' : '') + '><b>Single Pull</b><span>' + TICK + ' ' + nf.format(g.single.tickets) + '</span></button>' +
      '<button type="button" class="gc-btn main" data-act="pull" data-id="multi"' + (!multiOk || busy ? ' disabled' : '') + '><b>Multi Pull ×10</b><span>' + TICK + ' ' + nf.format(g.multi.tickets) + ' <em>hemat 1</em></span></button>' +
    '</div>' +
    (E.tickets < (g.single ? g.single.tickets : 1) ? '<div class="bn-msg">Tiket habis. Beli di bagian <button type="button" class="lnk" data-act="gotukar">Tukar</button> pakai Gems atau Coin.</div>' : '') +
    '<div class="gc-rates"><table><caption>Peluang &amp; nilai</caption>' +
      '<tr><td>Peluang Cincin</td><td>' + nf.format(g.ringChance * 100) + '% per kartu</td></tr>' +
      '<tr><td>Refund bila tidak dapat</td><td>' + GEM + ' +' + nf.format(g.refundGems) + ' Gems</td></tr>' +
      '<tr><td>Multi Pull ×10</td><td>' + nf.format(g.multi.tickets) + ' tiket (hemat 1)</td></tr>' +
      '<tr><td>Total tarikanmu</td><td>' + nf.format(p.tot) + ' pull · ' + nf.format(p.rings) + ' cincin</td></tr>' +
    '</table></div>';
}
const invRing = id => (E && E.inv && E.inv[id]) | 0;

/* ---- panggil server, lalu mulai animasi ---- */
async function pull(mode) {
  if (busy || !E) return;
  const g = E.gacha, cost = mode === 'multi' ? g.multi.tickets : g.single.tickets;
  if ((E.tickets || 0) < cost) return;
  busy = true; render(); // tombol terkunci selama menunggu
  try {
    const r = await aApi('economy/gacha', { pulls: mode === 'multi' ? 10 : 1, idem: uuid() });
    if (r && r.ok) {
      E = { ...E, ...r, at: Date.now() }; saveWallet(r);
      startStage(r, mode);
    }
  } catch (e) { toast(e.message || 'Gagal menarik, coba lagi.'); }
  busy = false;
  if (!stage) render();
}

function startStage(r, mode) {
  const results = r.results || [];
  const n = mode === 'multi' ? 10 : (matchMedia('(min-width:700px)').matches ? 5 : 3);
  /* urutan kartu = hasil diacak posisinya (HANYA visual — isi tiap kartu sudah dipatok server) */
  const order = [...Array(mode === 'multi' ? 10 : n).keys()];
  for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1));[order[i], order[j]] = [order[j], order[i]]; }
  stage = { mode, results, n, order, opened: new Set(), all: false, r };
  renderStage();
}

function renderStage() {
  const st = stage, res = st.results;
  const cards = [...Array(st.n)].map((_, i) => {
    const r = st.mode === 'multi' ? res[st.order[i]] : res[0]; // single: semua kartu berisi hasil yang sama
    const open = st.mode === 'multi' ? st.opened.has(st.order[i]) : st.opened.has(i);
    const front = r.t === 'ring'
      ? '<span class="gc-face front ring"><img src="' + icon(r.id) + '" alt="" draggable="false"><b>' + esc(r.name) + '</b><i class="gc-shine"></i></span>'
      : '<span class="gc-face front gems"><img src="/gems.png" alt="" draggable="false"><b>+' + nf.format(r.n) + ' Gems</b><i class="gc-shine"></i></span>';
    return '<button type="button" class="gc-card' + (open ? ' flip' : '') + (st.mode !== 'multi' && st.opened.size && !open ? ' dead' : '') + '" data-gc="' + i + '" aria-label="Kartu tertutup"' + (open ? ' disabled' : '') + '>' +
      '<span class="gc-face back"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l2.2 5.2L19.5 6l-2.7 4.8 4.7 2.4-5.2 1.1 1.4 5-4.2-2.6-2.5 4.4-1.3-5.1-5.2 1.6 3-4.3L3 11.5l5-1.9L6 4.6l5.1 1.9z"/></svg></span>' + front + '</button>';
  }).join('');
  const doneAll = st.mode === 'multi' ? st.opened.size >= 10 : st.opened.size >= 1;
  body.innerHTML =
    '<div class="gc-stage' + (st.mode === 'multi' ? ' multi' : '') + '">' +
      '<p class="gc-stage-t">' + (st.mode === 'multi' ? 'Pilih kartu untuk membuka — atau buka semuanya' : 'Pilih salah satu kartu') + '</p>' +
      '<div class="gc-cards">' + cards + '</div>' +
      (doneAll ? '' : '<div class="gc-tools">' +
        (st.mode === 'multi' ? '<button type="button" data-act="gcall">Buka Semua</button><button type="button" data-act="gcskip">Lewati ▸</button>' : '') +
      '</div>') +
      (doneAll ? summaryHTML(st) : '') +
    '</div>';
}
function summaryHTML(st) {
  const res = st.results, rings = res.filter(r => r.t === 'ring'), refund = res.reduce((s, r) => s + (r.t === 'gems' ? r.n : 0), 0);
  const g = E.gacha;
  const singleOk = E.tickets >= g.single.tickets, multiOk = E.tickets >= g.multi.tickets;
  return '<div class="gc-sum">' +
    (rings.length
      ? '<div class="gc-sum-hero ring"><img src="' + icon(rings[0].id) + '" alt="" draggable="false"><div><b>' + rings.length + '× ' + esc(rings[0].name) + (rings.length > 1 ? ' dll.' : '') + '</b><small>Cincin masuk ke Inventory-mu 🎉</small></div></div>'
      : '<div class="gc-sum-hero gems"><img src="/gems.png" alt="" draggable="false"><div><b>+' + nf.format(refund) + ' Gems</b><small>Tidak ada cincin kali ini — gems kembali ke saldomu</small></div></div>') +
    (rings.length && refund ? '<div class="gc-sum-sub">+' + nf.format(refund) + ' Gems dari kartu tanpa cincin</div>' : '') +
    '<div class="gc-sum-bal">' + COIN + nf.format(E.coins) + '<span>Coin</span>' + GEM + nf.format(E.gems) + '<span>Gems</span>' + TICK + nf.format(E.tickets) + '<span>Tiket</span></div>' +
    '<div class="gc-sum-btns">' +
      '<button type="button" class="gc-btn" data-act="pull" data-id="single"' + (!singleOk || busy ? ' disabled' : '') + '><b>Tarik lagi</b><span>' + TICK + ' ' + nf.format(g.single.tickets) + '</span></button>' +
      '<button type="button" class="gc-btn main" data-act="pull" data-id="multi"' + (!multiOk || busy ? ' disabled' : '') + '><b>Multi ×10</b><span>' + TICK + ' ' + nf.format(g.multi.tickets) + '</span></button>' +
      '<button type="button" data-act="gcdone">Selesai</button>' +
    '</div></div>';
}

/* buka kartu ke-i (klik / buka semua / lewati) */
function flipCard(i, instant) {
  const st = stage; if (!st) return;
  const key = st.mode === 'multi' ? st.order[i] : i;
  if (st.opened.has(key)) return;
  const el = body.querySelector('[data-gc="' + i + '"]');
  if (el) {
    if (instant) el.classList.add('noanim');
    el.classList.add('flip'); el.disabled = true;
    const r = st.mode === 'multi' ? st.results[key] : st.results[0];
    if (r && r.t === 'ring') burst(el); // efek partikel cahaya untuk cincin
  }
  st.opened.add(key);
  const doneAll = st.mode === 'multi' ? st.opened.size >= 10 : true;
  if (doneAll) setTimeout(() => { if (stage === st) renderStage(); }, instant || !matchMedia('(prefers-reduced-motion: reduce)').matches ? 620 : 0);
}
/* partikel cahaya tipis saat kartu cincin terbuka (transform-only, hemat performa) */
function burst(el) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const n = el.classList.contains('flip') ? 9 : 0;
  for (let i = 0; i < n; i++) {
    const p = document.createElement('i');
    p.className = 'gc-pt';
    const a = (Math.PI * 2 * i) / n + Math.random() * .6, d = 46 + Math.random() * 40;
    p.style.setProperty('--tx', Math.cos(a) * d + 'px');
    p.style.setProperty('--ty', Math.sin(a) * d + 'px');
    p.style.animationDelay = (Math.random() * 120) + 'ms';
    el.append(p);
    setTimeout(() => p.remove(), 1100);
  }
}
function openAll(instant) {
  const st = stage; if (!st) return;
  const rest = [...Array(st.n)].map((_, i) => i).filter(i => { const k = st.mode === 'multi' ? st.order[i] : i; return !st.opened.has(k); });
  rest.forEach((i, j) => setTimeout(() => flipCard(i, instant), instant ? 0 : j * 150));
}

/* ================= TUKAR CURRENCY ================= */
let exQty = { c2t: 1, g2t: 1 }, exCoin = 200;

function renderEx() {
  const r = E.rates || {}, T = E.hist || [];
  body.innerHTML =
    '<div class="ex-card main">' +
      '<h2><img src="/coin.svg" alt="" draggable="false"> Coin → Gems' + GEM + '</h2>' +
      '<p class="ex-rate">' + nf.format(r.coinPerGem) + ' Coin = 1 Gem. Tukar banyak, bonus bertingkat:</p>' +
      '<div class="ex-tiers">' + (r.tiers || []).map((t, i) =>
        '<span class="' + (exCoin >= t.min ? 'on' : '') + '">' + nf.format(t.min) + '+ <b>+' + nf.format(Math.round(t.bonus * 100)) + '%</b></span>').join('') + '</div>' +
      '<div class="ex-row"><input id="excoin" type="number" inputmode="numeric" min="' + r.coinPerGem + '" step="40" value="' + exCoin + '" aria-label="Jumlah Coin yang ditukar">' +
        '<div class="ex-chips">' + [200, 800, 2400, 8000].map(v => '<button type="button" data-act="chip" data-id="' + v + '"' + (exCoin === v ? ' class="on"' : '') + '>' + (v >= 1000 ? nf.format(v) : v) + '</button>').join('') + '</div></div>' +
      '<div class="ex-prev" id="exprev"></div>' +
      '<button type="button" class="bn-btn" data-act="ex" data-id="c2g">Tukar jadi Gems</button>' +
    '</div>' +
    '<div class="ex-two">' +
      '<div class="ex-card">' +
        '<h2>' + GEM + ' Gems → Tiket</h2><p class="ex-rate">' + nf.format(r.gemPerTicket) + ' Gems = 1 Tiket — <b>opsi utama</b>.</p>' +
        '<div class="ex-qt">' + exStep('g2t', exQty.g2t) + '<div class="ex-tot"><b>' + GEM + ' ' + nf.format(exQty.g2t * r.gemPerTicket) + '</b><small>saldo ' + nf.format(E.gems) + '</small></div></div>' +
        '<button type="button" class="bn-btn" data-act="ex" data-id="g2t"' + (exQty.g2t * r.gemPerTicket > E.gems ? ' disabled' : '') + '>Beli Tiket</button>' +
      '</div>' +
      '<div class="ex-card">' +
        '<h2>' + COIN + ' Coin → Tiket</h2><p class="ex-rate">' + nf.format(r.coinPerTicket) + ' Coin = 1 Tiket — mahal, buat <b>alternatif</b>.</p>' +
        '<div class="ex-qt">' + exStep('c2t', exQty.c2t) + '<div class="ex-tot"><b>' + COIN + ' ' + nf.format(exQty.c2t * r.coinPerTicket) + '</b><small>saldo ' + nf.format(E.coins) + '</small></div></div>' +
        '<button type="button" class="bn-btn" data-act="ex" data-id="c2t"' + (exQty.c2t * r.coinPerTicket > E.coins ? ' disabled' : '') + '>Beli Tiket</button>' +
      '</div>' +
    '</div>' +
    '<div class="ex-note">Konversi hanya satu arah: Gems tidak bisa kembali ke Coin, dan Tiket tidak bisa ditukar ke currency lain.</div>' +
    (T.length ? '<div class="ex-hist"><h3>Riwayat transaksi</h3>' + T.map(h =>
      '<div class="ex-hrow"><span class="ex-hic ' + esc(h.kind) + '">' + histIcon(h.kind) + '</span><span class="ex-htx">' + esc(h.txt || h.kind) + '<small>' + fmtTime(h.at) + '</small></span></div>').join('') + '</div>' : '');
  paintPrev();
}
const exStep = (k, n) =>
  '<div class="sh-step" role="group" aria-label="Jumlah tiket"><button type="button" data-act="xq-" data-id="' + k + '" aria-label="Kurangi"' + (n <= 1 ? ' disabled' : '') + '>−</button>' +
  '<output>' + n + '</output><button type="button" data-act="xq+" data-id="' + k + '" aria-label="Tambah"' + (n >= 99 ? ' disabled' : '') + '>+</button></div>';

/* pratinjau Coin->Gems: Coin terpakai, gems dasar, bonus, total (angka final tetap keputusan server) */
function paintPrev() {
  const el = $('exprev'); if (!el || !E) return;
  const r = E.rates, input = $('excoin');
  const coins = Math.max(0, Math.floor(Number(input && input.value) || 0));
  const base = Math.floor(coins / r.coinPerGem), used = base * r.coinPerGem;
  const tier = [...(r.tiers || [])].reverse().find(t => used >= t.min);
  const bonus = tier ? Math.floor(base * tier.bonus) : 0;
  el.innerHTML = coins < r.coinPerGem
    ? '<span class="bad">Masukkan minimal ' + nf.format(r.coinPerGem) + ' Coin.</span>'
    : '<div class="ex-prev-r"><span>Coin terpakai</span><b>' + nf.format(used) + (used !== coins ? ' <small>(dari ' + nf.format(coins) + ')</small>' : '') + '</b></div>' +
      '<div class="ex-prev-r"><span>Gems dasar</span><b>' + nf.format(base) + '</b></div>' +
      (bonus ? '<div class="ex-prev-r bon"><span>Bonus tingkat ' + nf.format(Math.round(tier.bonus * 100)) + '%</span><b>+' + nf.format(bonus) + '</b></div>' : '<div class="ex-prev-r"><span>Bonus</span><b>—</b></div>') +
      '<div class="ex-prev-r tot"><span>Total diterima</span><b>' + GEM + ' ' + nf.format(base + bonus) + '</b></div>' +
      (used > E.coins ? '<span class="bad">Coin kamu belum cukup (saldo ' + nf.format(E.coins) + ')</span>' : '');
  /* tingkat bonus ikut menyala mengikuti angka yang sedang diketik */
  body.querySelectorAll('.ex-tiers span').forEach((s, i) => s.classList.toggle('on', used >= (r.tiers[i] ? r.tiers[i].min : Infinity)));
  const btn = body.querySelector('[data-act="ex"][data-id="c2g"]');
  if (btn) btn.disabled = coins < r.coinPerGem || used > E.coins;
}
const histIcon = k => ({ c2g: '⇄', c2t: '🎟', g2t: '🎟', gacha: '✦', buy: '🛍' }[k] || '•');
const fmtTime = at => { const d = new Date(at); return isNaN(d) ? '' : d.toLocaleDateString('id-ID', { day: 'numeric', month: 'short' }) + ' ' + d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }); };

/* ---- modal konfirmasi tukar (pola yang sama dengan #shqmodal di shop.js) ---- */
const qm = document.createElement('div');
qm.id = 'exqmodal'; qm.className = 'hide'; qm.setAttribute('role', 'dialog'); qm.setAttribute('aria-modal', 'true'); qm.setAttribute('aria-label', 'Konfirmasi tukar');
qm.innerHTML = '<div class="qbox"><h2>Konfirmasi</h2><div id="exqbody"></div><div class="qbtns"><button type="button" id="exqno">Batal</button><button type="button" id="exqyes">Tukar</button></div></div>';
document.getElementById('app').append(qm);
let qCb = null;
function askEx(html, cb) { $('exqbody').innerHTML = html; qCb = cb; qm.classList.remove('hide'); $('exqyes').focus({ preventScroll: true }); }
function closeEx() { qm.classList.add('hide'); qCb = null; }
qm.addEventListener('click', e => { if (e.target === qm) closeEx(); });
$('exqno').onclick = closeEx;
$('exqyes').onclick = () => { const cb = qCb; closeEx(); if (cb) cb(); };
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !qm.classList.contains('hide')) { e.stopPropagation(); closeEx(); } }, true);

async function doExchange(kind, amount) {
  if (busy || !E) return;
  busy = true;
  try {
    const r = await aApi('economy/exchange', { kind, amount, idem: uuid() });
    if (r && r.ok) {
      E = { ...E, ...r, at: Date.now() }; saveWallet(r);
      toast((r.done && r.done.txt) || 'Transaksi berhasil.');
    }
  } catch (e) { toast(e.message || 'Transaksi gagal.'); }
  busy = false; load(true);
}
function confirmExchange(kind) {
  const r = E.rates;
  if (kind === 'c2g') {
    const coins = Math.max(0, Math.floor(Number($('excoin') && $('excoin').value) || 0));
    const base = Math.floor(coins / r.coinPerGem), used = base * r.coinPerGem;
    if (base < 1 || used > E.coins) return;
    const tier = [...(r.tiers || [])].reverse().find(t => used >= t.min);
    const bonus = tier ? Math.floor(base * tier.bonus) : 0;
    askEx('<div class="qitem"><img src="/coin.svg" alt=""><div><b>' + nf.format(used) + ' Coin → ' + nf.format(base + bonus) + ' Gems</b>' +
      '<small>Gems dasar ' + nf.format(base) + (bonus ? ' · bonus +' + nf.format(bonus) : ' · tanpa bonus') + '</small>' +
      '<small>Saldo coin jadi ' + nf.format(E.coins - used) + '</small></div></div>', () => doExchange('c2g', coins));
  } else {
    const n = exQty[kind], cost = n * (kind === 'g2t' ? r.gemPerTicket : r.coinPerTicket);
    const cur = kind === 'g2t' ? 'Gems' : 'Coin', ico = kind === 'g2t' ? GEM : COIN;
    if (cost > (kind === 'g2t' ? E.gems : E.coins)) return;
    askEx('<div class="qitem"><img src="/ticket.svg" alt=""><div><b>' + n + ' Tiket — ' + nf.format(cost) + ' ' + cur + '</b>' +
      '<small>Saldo ' + cur.toLowerCase() + ' jadi ' + nf.format((kind === 'g2t' ? E.gems : E.coins) - cost) + '</small></div></div>', () => doExchange(kind, n));
  }
}

/* ---------- Interaksi (delegasi; render() menimpa isi #shbody, listener tetap satu) ---------- */
body.addEventListener('input', e => { if (e.target.id === 'excoin') { exCoin = Math.max(0, Math.floor(Number(e.target.value) || 0)); paintPrev(); } });
body.addEventListener('click', e => {
  const b = e.target.closest('[data-act],[data-gc]'); if (!b || b.disabled) return;
  if (b.dataset.gc !== undefined) { flipCard(+b.dataset.gc); return; }
  const a = b.dataset.act, id = b.dataset.id;
  if (a === 'pull') pull(id);
  else if (a === 'gcall') openAll(false);
  else if (a === 'gcskip') openAll(true);
  else if (a === 'gcdone') { stage = null; render(); }
  else if (a === 'gotukar') SHP.set('tukar');
  else if (a === 'chip') { exCoin = +id; const inp = $('excoin'); if (inp) { inp.value = exCoin; } renderEx(); }
  else if (a === 'xq+' || a === 'xq-') { const k = id; exQty[k] = Math.max(1, Math.min(99, exQty[k] + (a === 'xq+' ? 1 : -1))); renderEx(); }
  else if (a === 'ex') confirmExchange(id);
  else if (a === 'login') openLogin();
  else if (a === 'retry') load(true);
});

/* ---------- Kapan menyegarkan ---------- */
window.addEventListener('acct', () => { if (!atok) { E = null; stage = null; } });
document.addEventListener('visibilitychange', () => { if (!document.hidden && active() && SHP && SHP.view === view && !stage) load(); });
})();
