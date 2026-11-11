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

/* kelas warna dari tag kelangkaan (tag dikonfigurasi di GACHA.rings, server) */
const rarityCls = t => t === 'Legendaris' ? 'leg' : t === 'Epik' ? 'epic' : 'rare';
const ringTag = id => ((E && E.rings) || []).find(r => r.id === id)?.tag || 'Langka';
const ringExp = id => ((E && E.rings) || []).find(r => r.id === id)?.exp || 0;

/* partikel bintang kecil di banner (posisi acak tiap render, transform/opacity saja) */
const sparks = n => Array.from({ length: n }, (_, i) =>
  '<i class="gx-spark" style="--x:' + (6 + 88 * Math.random()).toFixed(1) + '%;--y:' + (8 + 74 * Math.random()).toFixed(1) + '%;--d:' + (i * 0.9).toFixed(1) + 's;--s:' + (0.6 + Math.random() * 0.9).toFixed(2) + '"></i>').join('');

function renderGacha() {
  const g = E.gacha || {}, p = E.pity || { now: 0, max: 60 };
  /* urutkan dari nilai hadiah terbesar (proxy kelangkaan: exp makin besar makin langka) supaya banner memimpin cincin terbaik */
  const rings = (E.rings || []).slice().sort((a, b) => (b.exp || 0) - (a.exp || 0));
  const left = Math.max(0, (p.max || 60) - (p.now || 0));
  const pct = Math.min(100, Math.round(100 * (p.now || 0) / (p.max || 60)));
  const singleOk = E.tickets >= g.single.tickets, multiOk = E.tickets >= g.multi.tickets;
  const pullsLeft = Math.floor((E.tickets || 0) / (g.single ? g.single.tickets : 1));
  const minT = g.single ? g.single.tickets : 1;
  body.innerHTML =
    '<div class="gx-hero">' + sparks(9) +
      '<i class="gx-hero-glow" aria-hidden="true"></i>' +
      '<div class="gx-hero-cards">' +
        rings.slice(1).map((r, i) => '<img src="' + icon(r.id) + '" alt="" class="gx-hero-side s' + (i + 1) + '" draggable="false">').join('') +
        (rings[0] ? '<img src="' + icon(rings[0].id) + '" alt="" class="gx-hero-main" draggable="false"><i class="gx-hero-halo" aria-hidden="true"></i>' : '') +
      '</div>' +
      '<h2>Gacha <em>Cincin</em></h2>' +
      '<p>Tukar tiket jadi tarikan kartu. Dapat <b>Cincin</b> — hadiah utama yang bisa kamu berikan ke karakter untuk EXP hubungan besar. Tidak dapat? <b>Gems-mu kembali</b>.</p>' +
      '<div class="gx-hero-bal">' + TICK + '<b>' + nf.format(E.tickets) + '</b><span>tiket</span>' +
        (pullsLeft >= 1 ? '<small>cukup untuk ' + pullsLeft + ' single pull</small>' : '<button type="button" data-act="gotukar">Beli tiket ▸</button>') + '</div>' +
    '</div>' +
    '<div class="gx-prizes">' +
      '<div class="gx-prizes-t"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l2.2 5.2L19.5 6l-2.7 4.8 4.7 2.4-5.2 1.1 1.4 5-4.2-2.6-2.5 4.4-1.3-5.1-5.2 1.6 3-4.3L3 11.5l5-1.9L6 4.6l5.1 1.9z"/></svg> Hadiah utama</div>' +
      '<div class="gx-prizes-g">' + rings.map(r =>
        '<button type="button" class="gx-prize ' + rarityCls(r.tag) + (invRing(r.id) ? '' : ' zero') + '" data-act="ringinfo" data-id="' + esc(r.id) + '" aria-label="' + esc(r.name) + '">' +
          '<span class="gx-prize-ic"><img src="' + icon(r.id) + '" alt="" draggable="false"></span>' +
          '<b>' + esc(r.name) + '</b>' +
          '<span class="gx-prize-tag">' + esc(r.tag || '') + '</span>' +
          '<small>+' + nf.format(r.exp || 0) + ' EXP kalau diberikan</small>' +
          '<span class="gx-prize-own">Dimiliki ' + nf.format(invRing(r.id)) + '</span>' +
        '</button>').join('') + '</div>' +
    '</div>' +
    '<div class="gx-pitybox">' +
      '<div class="gx-pity-t"><span class="gx-pity-l"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l2.2 5.2L19.5 6l-2.7 4.8 4.7 2.4-5.2 1.1 1.4 5-4.2-2.6-2.5 4.4-1.3-5.1-5.2 1.6 3-4.3L3 11.5l5-1.9L6 4.6l5.1 1.9z"/></svg> Jaminan Cincin</span><b>' + nf.format(left) + ' pull lagi</b></div>' +
      '<div class="gx-bar' + (pct >= 80 ? ' hot' : '') + '" role="progressbar" aria-valuenow="' + pct + '" aria-valuemin="0" aria-valuemax="100" aria-label="Progres jaminan cincin"><i style="width:' + pct + '%"></i></div>' +
      '<small>Tanpa cincin ' + nf.format(p.max) + ' pull berturut-turut, pull berikutnya pasti cincin — total ' + nf.format(p.tot || 0) + ' pull · ' + nf.format(p.rings || 0) + ' cincin didapat.</small>' +
    '</div>' +
    '<div class="gx-pull">' +
      '<button type="button" class="gx-btn" data-act="pull" data-id="single"' + (!singleOk || busy ? ' disabled' : '') + '><b>Single Pull</b><span>' + TICK + ' ' + nf.format(g.single.tickets) + '</span></button>' +
      '<button type="button" class="gx-btn main" data-act="pull" data-id="multi"' + (!multiOk || busy ? ' disabled' : '') + '><b>Multi Pull ×10</b><span>' + TICK + ' ' + nf.format(g.multi.tickets) + ' <em>hemat 1</em></span></button>' +
    '</div>' +
    ((E.tickets || 0) < minT ? '<div class="bn-msg">Tiket habis. Beli di bagian <button type="button" class="lnk" data-act="gotukar">Tukar</button> pakai Gems atau Coin.</div>' : '') +
    '<div class="gx-rates">' +
      '<div><span>Peluang cincin</span><b>' + nf.format((g.ringChance || 0) * 100) + '% <small>/kartu</small></b></div>' +
      '<div><span>Refund bila lolos</span><b>' + GEM + ' +' + nf.format(g.refundGems) + '</b></div>' +
      '<div><span>Multi ×10</span><b>' + nf.format(g.multi.tickets) + ' tiket</b></div>' +
      '<div><span>Tarikanmu</span><b>' + nf.format(p.tot || 0) + ' pull</b></div>' +
    '</div>';
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
      ? '<span class="gx-face front ring ' + rarityCls(ringTag(r.id)) + '"><i class="gx-rays" aria-hidden="true"></i><img src="' + icon(r.id) + '" alt="" draggable="false"><b>' + esc(r.name) + '</b><i class="gx-shine"></i></span>'
      : '<span class="gx-face front gems"><img src="/gems.png" alt="" draggable="false"><b>+' + nf.format(r.n) + '</b><i class="gx-shine"></i></span>';
    return '<button type="button" class="gx-card' + (open ? ' flip' : '') + (st.mode !== 'multi' && st.opened.size && !open ? ' dead' : '') + '" data-gx="' + i + '" style="--i:' + i + '" aria-label="Kartu tertutup"' + (open ? ' disabled' : '') + '>' +
      '<span class="gx-face back"><i class="gx-pip tl"></i><i class="gx-pip br"></i><i class="gx-back-gem" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 3l2.2 5.2L19.5 6l-2.7 4.8 4.7 2.4-5.2 1.1 1.4 5-4.2-2.6-2.5 4.4-1.3-5.1-5.2 1.6 3-4.3L3 11.5l5-1.9L6 4.6l5.1 1.9z"/></svg></i></span>' + front + '</button>';
  }).join('');
  const doneAll = st.mode === 'multi' ? st.opened.size >= 10 : st.opened.size >= 1;
  body.innerHTML =
    '<div class="gx-stage' + (st.mode === 'multi' ? ' multi' : '') + '">' +
      '<i class="gx-flash" aria-hidden="true"></i>' +
      '<p class="gx-stage-t">' + (st.mode === 'multi' ? 'Pilih kartu untuk membuka <b>' + st.opened.size + '/10</b> — atau buka semuanya' : 'Pilih salah satu kartu') + '</p>' +
      '<div class="gx-cards" style="--cols:' + (st.mode === 'multi' ? 5 : st.n) + '">' + cards + '</div>' +
      (doneAll ? '' : '<div class="gx-tools">' +
        (st.mode === 'multi' ? '<button type="button" data-act="gcall">Buka Semua</button><button type="button" data-act="gcskip">Lewati ▸</button>' : '') +
      '</div>') +
      (doneAll ? summaryHTML(st) : '') +
    '</div>';
  /* panggung (awal) dan ringkasan (selesai) digulir ke area terlihat supaya tidak ketutup tepi layar / bottom nav */
  const shop = document.getElementById('shop'), target = doneAll ? body.querySelector('.gx-sum') : body.querySelector('.gx-stage');
  if (shop && target) {
    const rel = target.getBoundingClientRect().top - shop.getBoundingClientRect().top + shop.scrollTop;
    const y = doneAll ? Math.max(0, rel - Math.max(0, (shop.clientHeight - target.offsetHeight) / 2)) : Math.max(0, rel - 10);
    shop.scrollTo({ top: y, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }
}
function summaryHTML(st) {
  const res = st.results, rings = res.filter(r => r.t === 'ring'), refund = res.reduce((s, r) => s + (r.t === 'gems' ? r.n : 0), 0);
  const g = E.gacha;
  const singleOk = E.tickets >= g.single.tickets, multiOk = E.tickets >= g.multi.tickets;
  const top = rings[0];
  return '<div class="gx-sum' + (rings.length ? ' win' : '') + '">' +
    (rings.length
      ? '<div class="gx-sum-hero ring"><span class="gx-sum-rays" aria-hidden="true"></span><img src="' + icon(top.id) + '" alt="" draggable="false"><div><span class="gx-sum-tag ' + rarityCls(ringTag(top.id)) + '">' + esc(ringTag(top.id)) + '</span>' +
          '<b>' + (rings.length > 1 ? rings.length + '× CINCIN!' : esc(top.name) + '!') + '</b>' +
          '<small>Cincin masuk Inventory — berikan ke karakter untuk +' + nf.format(ringExp(top.id)) + ' EXP</small></div></div>'
      : '<div class="gx-sum-hero gems"><img src="/gems.png" alt="" draggable="false"><div><b>+' + nf.format(refund) + ' Gems</b><small>Tidak ada cincin kali ini — gems kembali ke saldomu</small></div></div>') +
    ((st.mode === 'multi' || rings.length > 1) ? '<div class="gx-sum-grid">' + res.map(r => r.t === 'ring'
      ? '<span class="gx-mini ring"><img src="' + icon(r.id) + '" alt="" draggable="false"></span>'
      : '<span class="gx-mini gems"><img src="/gems.png" alt="" draggable="false"><b>+' + r.n + '</b></span>').join('') + '</div>' : '') +
    (rings.length && refund ? '<div class="gx-sum-sub">+' + nf.format(refund) + ' Gems dari kartu tanpa cincin</div>' : '') +
    '<div class="gx-sum-bal"><div><b>' + COIN + nf.format(E.coins) + '</b><small>Coin</small></div><div><b>' + GEM + nf.format(E.gems) + '</b><small>Gems</small></div><div><b>' + TICK + nf.format(E.tickets) + '</b><small>Tiket</small></div></div>' +
    '<div class="gx-sum-btns">' +
      '<button type="button" class="gx-btn" data-act="pull" data-id="single"' + (!singleOk || busy ? ' disabled' : '') + '><b>Tarik lagi</b><span>' + TICK + ' ' + nf.format(g.single.tickets) + '</span></button>' +
      '<button type="button" class="gx-btn main" data-act="pull" data-id="multi"' + (!multiOk || busy ? ' disabled' : '') + '><b>Multi ×10</b><span>' + TICK + ' ' + nf.format(g.multi.tickets) + '</span></button>' +
      '<button type="button" data-act="gcdone">Selesai</button>' +
    '</div></div>';
}

/* buka kartu ke-i (klik / buka semua / lewati).
   Urutan: charge (kartu bergetar + aura kelangkaan) -> flip 3D -> gelombang kejut + partikel + kilatan panggung.
   Cincin lebih lama & besar (legendaris paling meriah); gems singkat dan lembut. Hasilnya tetap dari server. */
const reduceMo = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
function flipCard(i, instant) {
  const st = stage; if (!st) return;
  const key = st.mode === 'multi' ? st.order[i] : i;
  if (st.opened.has(key)) return;
  const el = body.querySelector('[data-gx="' + i + '"]');
  const r = st.mode === 'multi' ? st.results[key] : st.results[0];
  const isRing = !!(r && r.t === 'ring'), rc = isRing ? rarityCls(ringTag(r.id)) : 'gem';
  const quick = instant || reduceMo();
  const wait = quick ? 0 : (isRing ? (rc === 'leg' ? 720 : 560) : 240); // lama "charge" sebelum kartu terbuka
  st.opened.add(key);
  if (el) {
    el.disabled = true;
    if (instant) el.classList.add('noanim');
    el.classList.add('r-' + rc);
    if (wait) el.classList.add('charge');
  }
  const reveal = () => {
    if (stage !== st) return;
    if (el) {
      el.classList.remove('charge');
      el.classList.add('flip');
      if (isRing) el.classList.add('big');
      if (isRing) { burst(el, rc === 'leg' ? 30 : 22, 'gold', rc); wave(el, rc); flashStage(rc); hitStage(rc); }
      else if (r) burst(el, 6, 'gems', rc);
    }
  };
  wait ? setTimeout(reveal, wait) : reveal();
  const doneAll = st.mode === 'multi' ? st.opened.size >= 10 : true;
  if (doneAll) setTimeout(() => { if (stage === st) renderStage(); }, wait + (quick ? (instant ? 700 : 0) : (isRing ? 1500 : 800)));
}
/* kilatan di panggung saat cincin terbuka (warna ikut kelangkaan) */
function flashStage(rc) {
  if (reduceMo()) return;
  const f = body.querySelector('.gx-flash'); if (!f) return;
  f.className = 'gx-flash ' + (rc || '');
  void f.offsetWidth; f.classList.add('go');
}
/* panggung berguncang sebentar (epik & legendaris) */
function hitStage(rc) {
  if (reduceMo() || rc === 'rare') return;
  const s = body.querySelector('.gx-stage'); if (!s) return;
  s.classList.remove('hit'); void s.offsetWidth; s.classList.add('hit');
  setTimeout(() => s.classList.remove('hit'), 520);
}
/* titik tengah kartu relatif ke panggung (efek ditaruh di panggung, bukan di kartu, supaya tidak ikut terputar 3D) */
function cardCenter(el) {
  const s = body.querySelector('.gx-stage');
  if (!s) return null;
  /* posisi layout kartu TANPA transform (hover/charge/flip mengangkat & memutar kartu, jadi rect kartu meleset):
     rect induk offset (tanpa transform) + offsetLeft/Top kartu, lalu dikonversi ke koordinat panggung */
  const sr = s.getBoundingClientRect(), op = el.offsetParent || s, pr = op.getBoundingClientRect();
  return { s, x: pr.left - sr.left + op.clientLeft + el.offsetLeft + el.offsetWidth / 2, y: pr.top - sr.top + op.clientTop + el.offsetTop + el.offsetHeight / 2 };
}
/* gelombang kejut: dua cincin cahaya melebar dari kartu */
function wave(el, rc) {
  if (reduceMo()) return;
  const c = cardCenter(el); if (!c) return;
  for (let k = 0; k < 2; k++) {
    const w = document.createElement('i');
    w.className = 'gx-wave ' + rc;
    w.style.left = c.x + 'px'; w.style.top = c.y + 'px'; w.style.animationDelay = (k * 130) + 'ms';
    c.s.append(w);
    setTimeout(() => w.remove(), 1100);
  }
}
/* partikel cahaya: cincin = emas/pink/biru berbagai ukuran + percikan memanjang; gems = hijau kecil. transform/opacity saja */
function burst(el, n, kind, rc) {
  if (reduceMo()) return;
  const c = cardCenter(el); if (!c) return;
  const far = kind === 'gems' ? 46 : 70;
  for (let i = 0; i < n; i++) {
    const p = document.createElement('i');
    p.className = 'gx-pt' + (kind === 'gems' ? ' g' : ' ' + rc) + (kind !== 'gems' && i % 3 === 0 ? ' streak' : '');
    const a = (Math.PI * 2 * i) / n + Math.random() * .5, d = far * .5 + Math.random() * far;
    p.style.left = c.x + 'px'; p.style.top = c.y + 'px';
    p.style.setProperty('--tx', Math.cos(a) * d + 'px');
    p.style.setProperty('--ty', Math.sin(a) * d + 'px');
    p.style.setProperty('--rot', (a * 180 / Math.PI) + 'deg');
    p.style.setProperty('--sz', (0.6 + Math.random() * 0.9).toFixed(2));
    p.style.animationDelay = (Math.random() * 120) + 'ms';
    c.s.append(p);
    setTimeout(() => p.remove(), 1200);
  }
}
function openAll(instant) {
  const st = stage; if (!st) return;
  const rest = [...Array(st.n)].map((_, i) => i).filter(i => { const k = st.mode === 'multi' ? st.order[i] : i; return !st.opened.has(k); });
  rest.forEach((i, j) => setTimeout(() => flipCard(i, instant), instant ? 0 : j * 170));
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
  const b = e.target.closest('[data-act],[data-gx]'); if (!b || b.disabled) return;
  if (b.dataset.gx !== undefined) { flipCard(+b.dataset.gx); return; }
  const a = b.dataset.act, id = b.dataset.id;
  if (a === 'pull') pull(id);
  else if (a === 'gcall') openAll(false);
  else if (a === 'gcskip') openAll(true);
  else if (a === 'gcdone') { stage = null; render(); }
  else if (a === 'gotukar') SHP.set('tukar');
  else if (a === 'ringinfo') { const rr = ((E && E.rings) || []).find(x => x.id === id); if (rr) toast(rr.name + ' (' + rr.tag + ') · +' + nf.format(rr.exp) + ' EXP kalau diberikan · ' + rr.desc); }
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
