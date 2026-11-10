/* ===== Toko + Inventory =====
   Dimuat setelah shell.js, sebelum router.js dan economy.js. Semua aturan (harga, saldo, stok, EXP hadiah, bonus favorit)
   dijaga server (lib/shop.js + lib/economy.js): di sini hanya menampilkan dan memanggil endpoint-nya.
   Bagian:
     1. Navigasi bagian Toko (#shnav): Belanja (file ini) | Gacha | Tukar (public/economy.js, window.ECON).
     2. Tab Belanja (#shop): kategori -> daftar barang -> detail barang -> beli (dengan modal konfirmasi).
     3. Menu "+" di kolom ketik (#plusbtn): Inventory dan Skenario Skrip.
     4. Inventory (#invmodal): pilih jenis + jumlah, "Lampirkan ke chat" -> hadiah jadi lampiran di kotak ketik (#attbar);
        saat kirim: EXP hubungan naik (bonus x1,5 / Mood x2 kalau barang favorit karakternya), ada bubble roleplay + balasan AI.
        Cincin hasil gacha juga bisa diberikan (hadiah istimewa, EXP/mood besar dari GACHA.rings di server).
   Memakai global index.html: atok, aOn, aApi, saveWallet, loadWallet, paintWallet, ch, allChars, ready, busy, selOn, inp,
   sendB, grow, refresh, draftT, submit, relApply, shortName, toast, GX, store, openLogin, rpOn, Shell. */
(() => {
'use strict';
const $ = id => document.getElementById(id);
const app = $('app'), body = $('shbody');
const nf = new Intl.NumberFormat('id-ID');
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const active = () => app.dataset.tab === 'shop';
const icon = id => '/shop/' + encodeURIComponent(id) + '.svg';
const COIN = '<img src="/coin.svg" alt="" draggable="false">';
const TICK = '<img src="/ticket.svg" alt="" draggable="false">';
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'id' + Date.now() + Math.random().toString(36).slice(2));

let S = null;               // { items, cats, rings, fav, favMult, inv, max, coins, gems, tickets } dari server
let ready0 = false, failed = '', lastTok = '', lastAt = 0, loading = false;
const gsel = {};            // hadiah: id -> jumlah
let shMsg = ['', ''], buying = false, giving = false;

/* ---------- Navigasi bagian Toko: Belanja / Gacha / Tukar ---------- */
const HEAD = {
  toko: ['Toko', 'Beli hadiah pakai coin, lalu berikan ke karakter lewat tombol + di kolom chat untuk menaikkan hubungan.'],
  gacha: ['Gacha', 'Tukar tiket jadi kesempatan dapat Cincin. Tidak dapat? Gems-mu kembali.'],
  tukar: ['Tukar Currency', 'Coin ke Gems (bonus bertingkat), atau beli Tiket pakai Coin / Gems.']
};
window.SHP = {
  view: 'toko',
  set(v, opts) {
    if (!HEAD[v] || v === this.view && !(opts && opts.force)) { if (v === this.view) this.paint(); return; }
    this.view = v;
    $('shh1').textContent = HEAD[v][0]; $('shsub').textContent = HEAD[v][1];
    $('shnav').querySelectorAll('button').forEach(b => {
      const on = b.dataset.v === v;
      b.classList.toggle('sel', on); b.setAttribute('aria-selected', String(on));
    });
    if (v === 'toko') { load(); render(); }
    else if (window.ECON && ECON.show) ECON.show(v); // economy.js merender #shbody untuk Gacha/Tukar
    window.dispatchEvent(new CustomEvent('shop:nav', { detail: v }));
  },
  paint() { // sinkronkan tampilan nav + judul dengan state sekarang (dipakai saat tab Toko dibuka lagi)
    const v = this.view;
    $('shh1').textContent = HEAD[v][0]; $('shsub').textContent = HEAD[v][1];
    $('shnav').querySelectorAll('button').forEach(b => {
      const on = b.dataset.v === v;
      b.classList.toggle('sel', on); b.setAttribute('aria-selected', String(on));
    });
  }
};
$('shnav').addEventListener('click', e => {
  const b = e.target.closest('button[data-v]'); if (!b) return;
  SHP.set(b.dataset.v);
});

/* ---------- Tab Belanja: kategori -> barang -> detail ---------- */
let place = 'home'; // 'home' | 'cat:<id>' | 'item:<id>'
const itemsOf = () => (S && S.items) || [];
const catsOf = () => (S && S.cats) || [];
/* pool hadiah di client: barang toko + cincin gacha (S.rings dari server, exp/mood/tag dari GACHA.rings).
   Hanya untuk pratinjau EXP/mood — angka final tetap keputusan server (lib/shop.js). */
const giftPool = () => [...itemsOf(), ...((S && S.rings) || [])];
const isRingId = id => ((S && S.rings) || []).some(r => r.id === id);
const invN = id => Math.max(0, (S && S.inv && S.inv[id]) | 0);
const invTotal = () => itemsOf().reduce((s, i) => s + invN(i.id), 0);
const ringIds = () => ((S && S.rings) || []).map(r => r.id);
const ringTotal = () => ringIds().reduce((s, id) => s + invN(id), 0);
const itemOf = id => itemsOf().find(i => i.id === id);
const catOf = id => catsOf().find(c => c.id === id);
/* siapa saja yang memfavoritkan barang ini (S.fav = { charId: itemId }, nama dari allChars) */
const favChars = id => {
  const f = (S && S.fav) || {}, out = [];
  for (const cid in f) if (f[cid] === id) {
    const c = (typeof allChars !== 'undefined' ? allChars : []).find(x => x.id === cid);
    out.push(c ? shortName(c) : cid);
  }
  return out;
};

const empty = (title, text, btn) => '<div class="bn-empty"><h2>' + esc(title) + '</h2>' + (text ? '<p>' + esc(text) + '</p>' : '') + (btn || '') + '</div>';
const stepper = (act, id, n, min, max) =>
  '<div class="sh-step" role="group" aria-label="Jumlah"><button type="button" data-act="' + act + '-" data-id="' + id + '" aria-label="Kurangi"' + (n <= min ? ' disabled' : '') + '>−</button>' +
  '<output>' + n + '</output><button type="button" data-act="' + act + '+" data-id="' + id + '" aria-label="Tambah"' + (n >= max ? ' disabled' : '') + '>+</button></div>';
const backRow = (label, act) => '<button type="button" class="sh-back" data-act="' + act + '"><svg viewBox="0 0 24 24"><path d="M19 12H5M11 6l-6 6 6 6"/></svg>' + esc(label) + '</button>';

function render() {
  if (SHP.view !== 'toko') return; // Gacha/Tukar dirender economy.js
  const focus = document.activeElement && body.contains(document.activeElement) ? document.activeElement.dataset.act + '|' + document.activeElement.dataset.id : '';
  if (!ready0 && !aOn) { body.innerHTML = empty('Memuat…'); return; }
  if (!aOn) { body.innerHTML = empty('Toko belum tersedia', 'Fitur akun belum aktif di server ini, jadi toko belum bisa dipakai.'); return; }
  if (!atok) { body.innerHTML = empty('Masuk dulu ya', 'Coin, gems, dan inventory tersimpan di akunmu, jadi kamu perlu masuk atau daftar dulu.', '<button class="bn-go" type="button" data-act="login">Masuk / Daftar</button>'); return; }
  if (!S) { body.innerHTML = failed ? empty('Gagal memuat', failed, '<button class="bn-go" type="button" data-act="retry">Coba lagi</button>') : empty('Memuat…'); return; }

  if (place.startsWith('item:')) return renderItem(place.slice(5));
  if (place.startsWith('cat:')) return renderCat(place.slice(4));
  /* beranda Belanja: kartu kategori (barang tidak ditumpuk dalam satu halaman) */
  body.innerHTML = '<div class="sh-cats">' + catsOf().map(cat => {
    const its = itemsOf().filter(i => i.cat === cat.id);
    return '<button type="button" class="sh-cat" data-act="cat" data-id="' + esc(cat.id) + '">' +
      '<span class="sh-cat-ic">' + its.slice(0, 4).map(i => '<img src="' + icon(i.id) + '" alt="" draggable="false">').join('') + '</span>' +
      '<span class="sh-cat-t"><b>' + esc(cat.name) + '</b><small>' + its.length + ' barang · ' + esc(cat.desc) + '</small></span>' +
      '<svg viewBox="0 0 24 24" class="sh-cat-go"><path d="M9 6l6 6-6 6"/></svg></button>';
  }).join('') + '</div>' +
    (ringTotal() ? '<div class="sh-ringrow" data-act="rings"><span class="sh-ringics">' + ringIds().filter(id => invN(id)).map(id => '<img src="' + icon(id) + '" alt="">').join('') + '</span><span>Kamu punya <b>' + ringTotal() + ' cincin</b> dari gacha<span class="mut"> · hadiah istimewa, berikan lewat Inventory (tombol + di kolom chat)</span></span></div>' : '');
  refocus(focus);
}
function renderCat(catId) {
  const cat = catOf(catId);
  if (!cat) { place = 'home'; return render(); }
  body.innerHTML = backRow('Semua kategori', 'home') +
    '<div class="sh-grid">' + itemsOf().filter(i => i.cat === catId).map(it => {
      const favs = favChars(it.id);
      return '<button type="button" class="sh-card sh-tap" data-act="item" data-id="' + esc(it.id) + '"><div class="sh-ic"><img src="' + icon(it.id) + '" alt="" draggable="false"></div><h3>' + esc(it.name) + '</h3>' +
        (favs.length ? '<span class="sh-fav">❤ Favorit ' + esc(favs.map(x => x.split(' ')[0]).join(', ')) + '</span>' : '') +
        '<div class="sh-meta"><span class="sh-price">' + COIN + nf.format(it.price) + '</span><span class="sh-own">Punya ' + nf.format(invN(it.id)) + '</span></div></button>';
    }).join('') + '</div>';
  refocus('');
}
let qty = 1;
function renderItem(id) {
  const it = itemOf(id);
  if (!it) { place = 'home'; return render(); }
  const max = S.max.qty, n = Math.max(1, Math.min(max, qty)), total = it.price * n, poor = total > S.coins;
  const favs = favChars(it.id), favMult = (S && S.favMult) || { exp: 1.5, mood: 2 };
  const exp = it.exp * n, mood = Math.min(15, it.mood * n);
  body.innerHTML = backRow(catOf(it.cat) ? catOf(it.cat).name : 'Kategori', 'cat:' + it.cat) +
    '<div class="sh-detail"><div class="sh-dic"><img src="' + icon(it.id) + '" alt="" draggable="false"></div>' +
    '<div class="sh-dinfo"><h2>' + esc(it.name) + '</h2><p class="sh-desc">' + esc(it.desc) + '</p>' +
    '<div class="sh-meta l"><span class="sh-price">' + COIN + nf.format(it.price) + '</span><span class="sh-own">Punya ' + nf.format(invN(it.id)) + '</span></div>' +
    '<div class="sh-eff"><span>+' + nf.format(exp) + ' EXP hubungan</span><span>+' + nf.format(mood) + ' Mood</span></div>' +
    (favs.length ? '<div class="sh-favbig">❤ Barang favorit <b>' + esc(favs.join(', ')) + '</b><small>Diberikan ke mereka: EXP ×' + String(favMult.exp).replace('.', ',') + ' · Mood ×' + favMult.mood + '</small></div>' : '') +
    '</div></div>' +
    '<div class="sh-sum"><div class="t"><b>' + COIN + nf.format(total) + '</b><small>' + (poor ? 'Coin kamu belum cukup' : 'Saldo: ' + nf.format(S.coins) + ' coin') + '</small></div>' +
    stepper('q', it.id, n, 1, max) +
    '<button type="button" data-act="buy"' + (poor || buying ? ' disabled' : '') + '>' + (buying ? 'Membeli…' : 'Beli') + '</button></div>';
  refocus('');
}
function refocus(focus) {
  if (!focus) return;
  const [a, id] = focus.split('|');
  const el = body.querySelector('[data-act="' + a + '"][data-id="' + id + '"]');
  if (el && !el.disabled) el.focus({ preventScroll: true });
}
function setMsg(t, c) { shMsg = [t || '', c || '']; }

/* ---------- Muat dari server ---------- */
async function load(force) {
  if (!aOn || !atok) { S = null; failed = ''; render(); return; }
  if (loading) return;
  if (!force && S && atok === lastTok && Date.now() - lastAt < 15000) { render(); return; }
  loading = true; if (!S) render();
  try {
    const r = await aApi('shop');
    if (r && r.ok) { S = r; failed = ''; lastTok = atok; lastAt = Date.now(); saveWallet(r); }
  } catch (e) { if (!S) failed = e.message || 'Gagal memuat toko.'; }
  loading = false; render(); renderInv();
}

/* ---------- Modal konfirmasi pembelian ---------- */
const qm = document.createElement('div');
qm.id = 'shqmodal'; qm.className = 'hide'; qm.setAttribute('role', 'dialog'); qm.setAttribute('aria-modal', 'true'); qm.setAttribute('aria-label', 'Konfirmasi pembelian');
qm.innerHTML = '<div class="qbox"><h2>Konfirmasi</h2><div id="shqbody"></div><div class="qbtns"><button type="button" id="shqno">Batal</button><button type="button" id="shqyes">Beli</button></div></div>';
document.getElementById('app').append(qm);
let qCb = null;
function askConfirm(html, label, cb) {
  $('shqbody').innerHTML = html;
  $('shqyes').textContent = label || 'Beli';
  qCb = cb; qm.classList.remove('hide'); $('shqyes').focus({ preventScroll: true });
}
function closeConfirm() { qm.classList.add('hide'); qCb = null; }
qm.addEventListener('click', e => { if (e.target === qm) closeConfirm(); });
$('shqno').onclick = closeConfirm;
$('shqyes').onclick = () => { const cb = qCb; closeConfirm(); if (cb) cb(); };
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !qm.classList.contains('hide')) { e.stopPropagation(); closeConfirm(); } }, true);

async function buy() {
  if (buying || !S || !place.startsWith('item:')) return;
  const it = itemOf(place.slice(5)); if (!it) return;
  const n = Math.max(1, Math.min(S.max.qty, qty)), total = it.price * n;
  if (total > S.coins) return;
  buying = true; renderItem(it.id);
  try {
    const r = await aApi('shop/buy', { items: { [it.id]: n }, idem: uuid() }); /* idem: double-click/replay tidak dobel potong */
    if (r && r.ok) { S = r; lastAt = Date.now(); saveWallet(r); setMsg('ok'); toast('Berhasil membeli ' + n + ' ' + it.name.toLowerCase() + '. Cek di Inventory (tombol + di kolom chat).'); }
  } catch (e) { toast(e.message || 'Gagal membeli.'); load(true); }
  buying = false; renderItem(it.id); renderInv();
}

body.addEventListener('click', e => {
  const b = e.target.closest('[data-act]'); if (!b || b.disabled) return;
  const a = b.dataset.act, id = b.dataset.id;
  if (a === 'cat') { place = 'cat:' + id; render(); }
  else if (a === 'item') { qty = 1; place = 'item:' + id; render(); }
  else if (a === 'home') { place = 'home'; render(); }
  else if (a.startsWith('cat:')) { place = a; render(); }
  else if (a === 'q+' || a === 'q-') { qty = Math.max(1, Math.min(S.max.qty, qty + (a === 'q+' ? 1 : -1))); render(); }
  else if (a === 'buy') {
    const it = itemOf(place.slice(5)); if (!it) return;
    const n = Math.max(1, Math.min(S.max.qty, qty)), total = it.price * n;
    askConfirm('<div class="qitem"><img src="' + icon(it.id) + '" alt=""><div><b>' + esc(it.name) + ' × ' + n + '</b><small>Total ' + nf.format(total) + ' coin · saldo jadi ' + nf.format(Math.max(0, S.coins - total)) + '</small></div></div>', 'Beli', buy);
  }
  else if (a === 'login') openLogin();
  else if (a === 'retry') load(true);
  else if (a === 'rings') toast('Cincin bisa kamu berikan ke karakter: buka chat mana pun, tombol + di kolom ketik, pilih cincinnya di Inventory.');
});

/* ---------- Menu "+" di kolom ketik ---------- */
const plus = $('plusbtn'), pmenu = $('plusmenu'), scn = $('scnbtn');
const scnItem = pmenu.querySelector('[data-a="scn"]'), sceneItem = pmenu.querySelector('[data-a="scene"]'), imgItem = pmenu.querySelector('[data-a="img"]');
function syncPlus() { /* tombol + tetap ada di semua chat 1-lawan-1 (Inventory selalu tersedia); titik hijau = skenario aktif.
  Yang menyesuaikan adalah item di dalamnya (paintPlusItems): Skenario Skrip hanya saat Mode roleplay aktif
  (lihat public/scenario.js), Scene Capture hanya untuk karakter yang punya gambar referensi (ch.scene). */
  const on = !!(app.classList.contains('open') && ch && !(window.GX && GX.cur));
  plus.classList.toggle('hide', !on);
  plus.classList.toggle('scn-on', scn.classList.contains('on'));
  if (!on) closePlus();
}
new MutationObserver(syncPlus).observe(scn, { attributes: true, attributeFilter: ['class'] });
new MutationObserver(syncPlus).observe(app, { attributes: true, attributeFilter: ['class'] }); /* buka/tutup layar chat */
syncPlus();
function paintPlusItems() { /* dipanggil tiap menu dibuka dan saat chat berpindah karakter
  Yang menyesuaikan adalah item di dalamnya: Skenario Skrip hanya saat Mode roleplay aktif (lihat public/scenario.js),
  Scene Capture hanya untuk karakter yang punya gambar referensi (ch.scene), Kirim Gambar hanya untuk
  karakter yang bisa melihat gambar (ch.vision, field `vision: true` di char/<id>.js -> public/vision.js).
  Scene Capture & Kirim Gambar juga fitur rahasia: cuma muncul setelah kode ke Reze (mediau, tryMedia di index.html). */
  const rp = typeof rpOn === 'function' ? rpOn() : true;
  const media = store.get('mediau') === '1'; /* fitur gambar terbuka lewat kode rahasia ke Reze (index.html, tryMedia) */
  if (scnItem) scnItem.classList.toggle('hide', !rp);
  if (sceneItem) sceneItem.classList.toggle('hide', !(media && ch && ch.scene && !(window.GX && GX.cur)));
  if (imgItem) imgItem.classList.toggle('hide', !(media && ch && ch.vision && !(window.GX && GX.cur)));
}
new MutationObserver(paintPlusItems).observe($('hname'), { childList: true, characterData: true, subtree: true });
function openPlus() {
  $('plusinv').textContent = S ? invTotal() + ringTotal() : '';
  $('plusinv').classList.toggle('hide', !S);
  paintPlusItems();
  pmenu.classList.remove('hide'); plus.setAttribute('aria-expanded', 'true');
  if (atok && !S) load(false);
}
function closePlus() { pmenu.classList.add('hide'); plus.setAttribute('aria-expanded', 'false'); }
plus.addEventListener('pointerdown', e => e.preventDefault()); /* tap "+" tidak menutup keyboard */
plus.onclick = () => (pmenu.classList.contains('hide') ? openPlus() : closePlus());
pmenu.addEventListener('pointerdown', e => e.preventDefault());
pmenu.addEventListener('click', e => {
  const b = e.target.closest('button[data-a]'); if (!b) return;
  closePlus();
  if (b.dataset.a === 'inv') openInv();
  else if (b.dataset.a === 'scn') scn.click();
  else if (b.dataset.a === 'scene' && window.SCENE) SCENE.manual(); /* pasang lampiran Scene Capture di kotak ketik (public/scene.js): ketik prompt sendiri atau kosongkan -> otomatis dari adegan */
  else if (b.dataset.a === 'img' && window.VISION) VISION.pick(); /* pasang lampiran gambar di kotak ketik (public/vision.js): karakter dengan vision:true bisa melihatnya */
});
document.addEventListener('pointerdown', e => { if (!pmenu.classList.contains('hide') && !e.target.closest('#plusmenu,#plusbtn')) closePlus(); }, true);
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !pmenu.classList.contains('hide')) { e.stopPropagation(); closePlus(); plus.focus({ preventScroll: true }); } }, true);

/* ---------- Inventory ---------- */
const inv = $('invmodal'), ibody = $('invbody');
const invOpen = () => !inv.classList.contains('hide');
function openInv() {
  if (!ch || (window.GX && GX.cur)) return;
  for (const k in gsel) delete gsel[k];
  $('invsub').textContent = 'Pilih hadiah untuk ' + shortName(ch) + '. Hadiah muncul di kotak ketik dan terkirim bersama pesanmu.';
  inv.classList.remove('hide'); renderInv();
  if (atok) load(true);
}
function closeInv() { inv.classList.add('hide'); }
inv.addEventListener('click', e => { if (e.target === inv) closeInv(); });
$('invx').onclick = closeInv;
document.addEventListener('keydown', e => { if (e.key === 'Escape' && invOpen()) { e.stopPropagation(); closeInv(); } }, true);

function renderInv() {
  if (!invOpen()) return;
  const focus = document.activeElement && ibody.contains(document.activeElement) ? document.activeElement.dataset.act + '|' + document.activeElement.dataset.id : '';
  const foot = $('invfoot');
  foot.classList.add('hide');
  if (!aOn || !atok) { ibody.innerHTML = empty('Masuk dulu ya', 'Inventory tersimpan di akunmu, jadi kamu perlu masuk atau daftar dulu.', '<button class="bn-go" type="button" data-act="login">Masuk / Daftar</button>'); return; }
  if (!S) { ibody.innerHTML = failed ? empty('Gagal memuat', failed, '<button class="bn-go" type="button" data-act="retry">Coba lagi</button>') : empty('Memuat…'); return; }
  const rings = ((S.rings) || []).filter(r => invN(r.id) > 0);
  const favId = (S.fav && ch && S.fav[ch.id]) || null;
  const favMult = S.favMult || { exp: 1.5, mood: 2 };
  if (!invTotal() && !rings.length) { ibody.innerHTML = empty('Inventory kosong', 'Beli hadiah di Toko dulu, lalu berikan ke karakter. Cincin bisa didapat dari Gacha.', '<button class="bn-go" type="button" data-act="shop">Ke Toko</button>'); return; }
  for (const i of giftPool()) if ((gsel[i.id] | 0) > invN(i.id)) gsel[i.id] = invN(i.id);
  ibody.innerHTML =
    (rings.length ? '<div class="inv-sec">Cincin gacha · hadiah istimewa</div>' + rings.map(r => { /* cincin BISA diberikan: EXP/mood besar, tanpa bonus favorit */
      const have = invN(r.id), n = gsel[r.id] | 0;
      return '<div class="inv-row ring' + (n ? ' sel' : '') + '"><div class="sh-ic"><img src="' + icon(r.id) + '" alt="" draggable="false"></div>' +
        '<div class="inv-info"><b>' + esc(r.name) + '</b><span class="inv-ringtag">' + esc(r.tag || 'Langka') + '</span>' +
        '<small>Punya ' + nf.format(have) + ' · +' + nf.format(r.exp) + ' EXP · hadiah istimewa</small></div>' +
        stepper('g', r.id, n, 0, have) + '</div>';
    }).join('') + (invTotal() ? '<div class="inv-sec">Hadiah untuk diberikan</div>' : '') : '') +
    itemsOf().filter(it => invN(it.id) > 0).map(it => { /* barang yang tidak dipunya tidak ditampilkan */
      const have = invN(it.id), n = gsel[it.id] | 0, fav = favId === it.id;
      return '<div class="inv-row' + (fav ? ' fav' : '') + '"><div class="sh-ic"><img src="' + icon(it.id) + '" alt="" draggable="false"></div>' +
        '<div class="inv-info"><b>' + esc(it.name) + '</b><small>Punya ' + nf.format(have) + ' · +' + nf.format(it.exp) + ' EXP' + (fav ? ' <span class="inv-favtag">❤ ×' + String(favMult.exp).replace('.', ',') + '</span>' : '') + '</small>' +
        (fav ? '<span class="inv-favb">❤ Favorit ' + esc(shortName(ch)) + ' — EXP ×' + String(favMult.exp).replace('.', ',') + ', Mood ×' + favMult.mood + '</span>' : '') + '</div>' + stepper('g', it.id, n, 0, have) + '</div>';
    }).join('');
  /* ringkasan: EXP/Mood dihitung dengan multiplier favorit (cincin tidak berbonus favorit; server yang memutuskan angka final) */
  let exp = 0, moodRaw = 0, favHit = false, ringHit = false;
  for (const it of giftPool()) {
    const n = gsel[it.id] | 0; if (!n) continue;
    if (isRingId(it.id)) { ringHit = true; exp += it.exp * n; moodRaw += it.mood * n; continue; }
    const fav = favId === it.id;
    if (fav) favHit = true;
    exp += it.exp * n * (fav ? favMult.exp : 1);
    moodRaw += it.mood * n * (fav ? favMult.mood : 1);
  }
  const cnt = Object.values(gsel).reduce((s, n) => s + (n | 0), 0);
  foot.classList.remove('hide');
  $('invsum').innerHTML = cnt
    ? cnt + ' barang · +' + nf.format(Math.round(exp)) + ' EXP' + (ringHit ? ' <span class="inv-favtag gold">💍 hadiah istimewa</span>' : '') + (favHit ? ' <span class="inv-favtag">❤ bonus favorit</span>' : '')
    : 'Pilih barang yang mau diberikan';
  const go = $('invgo'); go.disabled = !cnt || giving; go.textContent = 'Lampirkan ke chat';
  if (focus) { const [a, id] = focus.split('|'); const el = ibody.querySelector('[data-act="' + a + '"][data-id="' + id + '"]'); if (el && !el.disabled) el.focus({ preventScroll: true }); }
}
ibody.addEventListener('click', e => {
  const b = e.target.closest('[data-act]'); if (!b || b.disabled) return;
  const a = b.dataset.act, id = b.dataset.id;
  if (a === 'g+' || a === 'g-') { gsel[id] = Math.max(0, Math.min(invN(id), (gsel[id] | 0) + (a === 'g+' ? 1 : -1))); renderInv(); }
  else if (a === 'login') { closeInv(); openLogin(); }
  else if (a === 'retry') load(true);
  else if (a === 'shop') { closeInv(); Shell.setTab('shop'); }
});
$('invgo').onclick = attach;

/* Hadiah = LAMPIRAN di kotak ketik (seperti file yang dilampirkan di chat): "Lampirkan ke chat" cuma menyiapkan hadiahnya, belum dikirim
   dan barang belum berkurang. Saat tombol kirim ditekan (atau Enter), hadiah dan ketikan user (boleh kosong) terkirim sekaligus:
   server mengurangi barang (atomik) dan menghitung EXP (bonus favorit kalau cocok); di sini EXP/mood ditambahkan ke hubungan,
   bubble roleplay masuk ke chat dan AI menjawab keduanya (lewat submit() di index.html dengan field `gift`).
   Lampiran hanya berlaku untuk chat tempat ia dibuat. */
let att = null; // { char, items:{id:n}, parts:[{id,name,n}], what, exp, fav }
const attbar = document.createElement('div');
attbar.id = 'attbar'; attbar.className = 'hide'; attbar.setAttribute('aria-live', 'polite');
document.querySelector('#chatview footer').before(attbar);

const hasAtt = () => !!(att && ch && ch.id === att.char && !(window.GX && GX.cur));
function renderAtt() {
  if (att && !hasAtt()) att = null; // pindah chat / masuk grup / keluar akun: lampiran dibuang (barang belum berkurang)
  attbar.textContent = '';
  attbar.classList.toggle('hide', !att);
  if (!att) { if (typeof refresh === 'function') refresh(); return; }
  const chip = document.createElement('div'); chip.className = 'att-chip' + (att.ring ? ' ring' : '') + (att.fav ? ' fav' : '');
  const ics = document.createElement('span'); ics.className = 'att-ic';
  att.parts.slice(0, 3).forEach(p => { const im = new Image(); im.src = icon(p.id); im.alt = ''; im.draggable = false; ics.append(im); });
  const tx = document.createElement('span'); tx.className = 'att-tx';
  const t1 = document.createElement('b'), t2 = document.createElement('small');
  t1.textContent = att.parts.map(p => p.n + ' ' + p.name.toLowerCase()).join(', ');
  t2.textContent = att.ring ? '💍 Hadiah istimewa · +' + nf.format(att.exp) + ' EXP' : 'Hadiah · +' + nf.format(att.exp) + ' EXP' + (att.fav ? ' · ❤ bonus favorit' : '');
  chip.title = 'Hadiah ini terkirim bersama pesanmu';
  tx.append(t1, t2);
  const x = document.createElement('button'); x.type = 'button'; x.className = 'att-x'; x.title = 'Lepas hadiah'; x.setAttribute('aria-label', 'Lepas hadiah dari kotak ketik');
  x.innerHTML = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>'; // ikon statis
  x.addEventListener('pointerdown', e => e.preventDefault()); // tap tidak menutup keyboard
  x.addEventListener('click', () => { att = null; renderAtt(); inp.focus({ preventScroll: true }); });
  chip.append(ics, tx, x); attbar.append(chip);
  if (typeof refresh === 'function') refresh();
}
new MutationObserver(renderAtt).observe($('hname'), { childList: true, characterData: true, subtree: true });
window.addEventListener('acct', () => { if (!atok) { att = null; renderAtt(); } });

function attach() { // tombol di Inventory: siapkan hadiah di kotak ketik, belum dikirim (boleh campur barang + cincin)
  if (giving || !S || !ch || (window.GX && GX.cur)) return;
  const items = {}; let cnt = 0;
  for (const i of giftPool()) if ((gsel[i.id] | 0) > 0) { items[i.id] = gsel[i.id] | 0; cnt += items[i.id]; }
  if (!cnt) return;
  const favId = (S.fav && S.fav[ch.id]) || null, favMult = S.favMult || { exp: 1.5, mood: 2 };
  const parts = giftPool().filter(i => items[i.id]).map(i => ({ id: i.id, name: i.name, n: items[i.id], ring: isRingId(i.id) }));
  let exp = 0, favHit = false, ringHit = false;
  for (const i of giftPool()) {
    const n = items[i.id]; if (!n) continue;
    if (isRingId(i.id)) { ringHit = true; exp += i.exp * n; continue; } /* cincin: tanpa bonus favorit, sudah istimewa */
    const fav = favId === i.id; if (fav) favHit = true; exp += i.exp * n * (fav ? favMult.exp : 1);
  }
  att = { char: ch.id, items, parts, what: parts.map(p => p.n + ' ' + p.name.toLowerCase()).join(', '), exp: Math.round(exp), fav: favHit, ring: ringHit };
  for (const k in gsel) delete gsel[k];
  closeInv(); renderAtt();
  inp.focus({ preventScroll: true });
}

async function send(userText) { // dipanggil submit() saat ada lampiran
  if (giving || !S || !hasAtt()) return;
  if (busy || !ready || selOn) { toast('Tunggu balasan selesai dulu ya'); return; }
  const a = att, chId = a.char, name = shortName(ch), say = String(userText || '').trim();
  giving = true; sendB.disabled = true;
  let r;
  try { r = await aApi('shop/gift', { char: chId, items: a.items }); }
  catch (e) { giving = false; refresh(); toast(e.message || 'Gagal memberikan hadiah'); load(true); return; } // lampiran tetap ada, bisa dicoba lagi
  giving = false;
  if (!r || !r.ok) { refresh(); return; }
  S = r; lastAt = Date.now(); saveWallet(r);
  if (Array.isArray(r.nq)) r.nq.forEach((t, i) => setTimeout(() => toast(t), 900 + i * 2300)); /* misi selesai / piala baru (lib/quests.js) */
  att = null; renderAtt();
  const note = relApply(chId, r.exp, r.mood, true); /* EXP hadiah tidak kena batas harian obrolan: sudah dibayar pakai coin */
  const expTxt = '+' + nf.format(r.exp) + ' EXP';
  const ringHit = !!(r.ringHit || a.ring);
  if (r.favHit) setTimeout(() => toast('❤ ' + name + ' benar-benar suka hadiahmu! Bonus favorit: EXP ×' + String(r.favHit.exp).replace('.', ',') + ' · Mood ×' + r.favHit.mood), 500);
  if (ringHit) setTimeout(() => toast('💍 ' + name + ' menerima cincinmu — hadiah istimewa!'), r.favHit ? 2600 : 500);
  if (!ch || ch.id !== chId || (window.GX && GX.cur)) { toast('Hadiah terkirim ke ' + name + ' · ' + expTxt + (note ? ' · ' + note : '')); return; } /* chat sudah pindah: EXP tetap masuk ke karakter yang benar */
  inp.value = ''; grow(); refresh(); clearTimeout(draftT); store.set('draft:' + chId, null); // ketikan ikut terkirim, kotak ketik dikosongkan
  toast('Kamu memberikan ' + a.what + ' ke ' + name + ' · ' + expTxt);
  submit({ gift: true, items: a.items, say, text: (ringHit ? '💍 ' : '🎁 ') + '*memberikan ' + a.what + '*' + (ringHit ? ' *(hadiah istimewa!)*' : '') + (r.favHit ? ' *(barang favoritnya!)*' : '') + (say ? '\n' + say : ''), hist: '*memberikan ' + a.what + ' kepadamu*' + (ringHit ? ' (hadiah istimewa!)' : '') + (r.favHit ? ' (barang favoritnya!)' : '') + (say ? ' sambil bilang: ' + say : ''), note });
}
window.SHOP = { has: hasAtt, send };

/* ---------- Kapan menyegarkan ---------- */
window.addEventListener('shell:tab', e => {
  if (e.detail !== 'shop') return;
  SHP.paint();
  if (SHP.view === 'toko') load(); else if (window.ECON && ECON.show) ECON.show(SHP.view);
});
window.addEventListener('shop:nav', () => { if (SHP.view === 'toko' && active()) load(true); }); /* balik dari Gacha/Tukar: data bisa saja berubah */
window.addEventListener('acct', () => { ready0 = true; if (!atok) S = null; if (active() && SHP.view === 'toko') load(true); else if (invOpen()) { renderInv(); } });
document.addEventListener('visibilitychange', () => { if (!document.hidden && active() && SHP.view === 'toko') load(); });
new MutationObserver(() => { if (active() && $('smodal').classList.contains('hide') && SHP.view === 'toko') load(true); })
  .observe($('smodal'), { attributes: true, attributeFilter: ['class'] });

paintWallet(loadWallet());
ready0 = aOn || !!window.__acctSeen; render();
})();
