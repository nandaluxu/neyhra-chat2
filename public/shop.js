/* ===== Toko + Inventory =====
   Dimuat setelah shell.js, sebelum router.js. Semua aturan (harga, saldo, stok, EXP hadiah) dijaga server (lib/shop.js):
   di sini hanya menampilkan dan memanggil /api/auth/shop, /buy, /gift.
   Bagian:
     1. Tab Toko (#shop): beli bunga/coklat/eskrim dengan coin, beberapa jenis & jumlah sekaligus.
     2. Menu "+" di kolom ketik (#plusbtn): Inventory dan Skenario Skrip.
     3. Inventory (#invmodal): pilih jenis + jumlah, "Berikan" -> EXP hubungan naik, ada bubble roleplay + balasan AI.
   Memakai global index.html: atok, aOn, aApi, saveWallet, loadWallet, paintWallet, ch, ready, busy, submit, relApply, shortName, toast, GX, store. */
(() => {
'use strict';
const $ = id => document.getElementById(id);
const app = $('app'), body = $('shbody');
const nf = new Intl.NumberFormat('id-ID');
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const active = () => app.dataset.tab === 'shop';
const icon = id => '/shop/' + encodeURIComponent(id) + '.svg';
const COIN = '<img src="/coin.svg" alt="" draggable="false">';

let S = null;               // { items, inv, max, coins, gems } dari server
let ready0 = false, failed = '', lastTok = '', lastAt = 0, loading = false;
const cart = {};            // beli: id -> jumlah
const gsel = {};            // hadiah: id -> jumlah
let shMsg = ['', ''], buying = false, giving = false;

const itemsOf = () => (S && S.items) || [];
const invN = id => Math.max(0, (S && S.inv && S.inv[id]) | 0);
const invTotal = () => itemsOf().reduce((s, i) => s + invN(i.id), 0);
const sumOf = (sel, key) => itemsOf().reduce((s, i) => s + (sel[i.id] | 0) * i[key], 0);
const pairs = sel => Object.fromEntries(itemsOf().filter(i => (sel[i.id] | 0) > 0).map(i => [i.id, sel[i.id] | 0]));
const sentence = sel => { const a = itemsOf().filter(i => (sel[i.id] | 0) > 0).map(i => (sel[i.id] | 0) + ' ' + i.name.toLowerCase()); return a.join(', ').replace(/, ([^,]*)$/, ' dan $1'); };

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

/* ---------- Tab Toko ---------- */
const empty = (title, text, btn) => '<div class="bn-empty"><h2>' + esc(title) + '</h2>' + (text ? '<p>' + esc(text) + '</p>' : '') + (btn || '') + '</div>';
const stepper = (act, id, n, min, max) =>
  '<div class="sh-step" role="group" aria-label="Jumlah"><button type="button" data-act="' + act + '-" data-id="' + id + '" aria-label="Kurangi"' + (n <= min ? ' disabled' : '') + '>−</button>' +
  '<output>' + n + '</output><button type="button" data-act="' + act + '+" data-id="' + id + '" aria-label="Tambah"' + (n >= max ? ' disabled' : '') + '>+</button></div>';

function render() {
  const focus = document.activeElement && body.contains(document.activeElement) ? document.activeElement.dataset.act + '|' + document.activeElement.dataset.id : '';
  if (!ready0 && !aOn) { body.innerHTML = empty('Memuat…'); return; }
  if (!aOn) { body.innerHTML = empty('Toko belum tersedia', 'Fitur akun belum aktif di server ini, jadi toko belum bisa dipakai.'); return; }
  if (!atok) { body.innerHTML = empty('Masuk dulu ya', 'Coin dan inventory tersimpan di akunmu, jadi kamu perlu masuk atau daftar dulu.', '<button class="bn-go" type="button" data-act="login">Masuk / Daftar</button>'); return; }
  if (!S) { body.innerHTML = failed ? empty('Gagal memuat', failed, '<button class="bn-go" type="button" data-act="retry">Coba lagi</button>') : empty('Memuat…'); return; }
  const max = S.max.qty, total = sumOf(cart, 'price'), poor = total > S.coins;
  body.innerHTML =
    '<div class="sh-grid">' + itemsOf().map(it => {
      const n = cart[it.id] | 0;
      return '<div class="sh-card"><div class="sh-ic"><img src="' + icon(it.id) + '" alt="" draggable="false"></div><h3>' + esc(it.name) + '</h3><p class="sh-desc">' + esc(it.desc) + '</p>' +
        '<div class="sh-meta"><span class="sh-price">' + COIN + nf.format(it.price) + '</span><span class="sh-own">Punya ' + nf.format(invN(it.id)) + '</span></div>' +
        '<div class="sh-meta">+' + nf.format(it.exp) + ' EXP hubungan</div>' + stepper('c', it.id, n, 0, max) + '</div>';
    }).join('') + '</div>' +
    '<div class="bn-msg' + (shMsg[1] ? ' ' + shMsg[1] : '') + '" role="status" id="shmsg">' + esc(shMsg[0]) + '</div>' +
    '<div class="sh-sum"><div class="t"><b>' + COIN + nf.format(total) + '</b><small>' + (total ? (poor ? 'Coin kamu belum cukup' : 'Saldo: ' + nf.format(S.coins) + ' coin') : 'Pilih barang yang mau dibeli') + '</small></div>' +
    '<button type="button" data-act="buy"' + (!total || poor || buying ? ' disabled' : '') + '>' + (buying ? 'Membeli…' : 'Beli') + '</button></div>';
  if (focus) { const [a, id] = focus.split('|'); const el = body.querySelector('[data-act="' + a + '"][data-id="' + id + '"]'); if (el && !el.disabled) el.focus({ preventScroll: true }); }
}
function setMsg(t, c) { shMsg = [t || '', c || '']; const el = $('shmsg'); if (el) { el.textContent = shMsg[0]; el.className = 'bn-msg' + (c ? ' ' + c : ''); } }

async function buy() {
  if (buying || !S) return;
  const items = pairs(cart); if (!Object.keys(items).length) return;
  buying = true; setMsg(''); render();
  try {
    const r = await aApi('shop/buy', { items });
    if (r && r.ok) { const was = sentence(cart); S = r; lastAt = Date.now(); saveWallet(r); for (const k in cart) delete cart[k]; setMsg('Berhasil membeli ' + was + '. Cek di Inventory (tombol + di kolom chat).', 'ok'); }
  } catch (e) { setMsg(e.message || 'Gagal membeli.', 'err'); load(true); }
  buying = false; render(); renderInv();
}

body.addEventListener('click', e => {
  const b = e.target.closest('[data-act]'); if (!b || b.disabled) return;
  const a = b.dataset.act, id = b.dataset.id;
  if (a === 'c+' || a === 'c-') { const n = (cart[id] | 0) + (a === 'c+' ? 1 : -1); cart[id] = Math.max(0, Math.min(S.max.qty, n)); setMsg(''); render(); }
  else if (a === 'buy') buy();
  else if (a === 'login') $('setbtn').click();
  else if (a === 'retry') load(true);
});

/* ---------- Menu "+" di kolom ketik ---------- */
const plus = $('plusbtn'), pmenu = $('plusmenu'), scn = $('scnbtn');
function syncPlus() { /* ikut status tombol skenario lama (tampil hanya di chat 1-lawan-1; titik hijau = skenario aktif) */
  plus.classList.toggle('hide', scn.classList.contains('hide'));
  plus.classList.toggle('scn-on', scn.classList.contains('on'));
  if (plus.classList.contains('hide')) closePlus();
}
new MutationObserver(syncPlus).observe(scn, { attributes: true, attributeFilter: ['class'] });
syncPlus();
function openPlus() {
  $('plusinv').textContent = S ? invTotal() : '';
  $('plusinv').classList.toggle('hide', !S);
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
  if (b.dataset.a === 'inv') openInv(); else if (b.dataset.a === 'scn') scn.click();
});
document.addEventListener('pointerdown', e => { if (!pmenu.classList.contains('hide') && !e.target.closest('#plusmenu,#plusbtn')) closePlus(); }, true);
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !pmenu.classList.contains('hide')) { e.stopPropagation(); closePlus(); plus.focus({ preventScroll: true }); } }, true);

/* ---------- Inventory ---------- */
const inv = $('invmodal'), ibody = $('invbody');
const invOpen = () => !inv.classList.contains('hide');
function openInv() {
  if (!ch || (window.GX && GX.cur)) return;
  for (const k in gsel) delete gsel[k];
  $('invsub').textContent = 'Berikan hadiah ke ' + shortName(ch) + ' untuk menaikkan hubungan.';
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
  if (!invTotal()) { ibody.innerHTML = empty('Inventory kosong', 'Beli bunga, coklat, atau eskrim di Toko dulu, lalu berikan ke karakter.', '<button class="bn-go" type="button" data-act="shop">Ke Toko</button>'); return; }
  for (const i of itemsOf()) if ((gsel[i.id] | 0) > invN(i.id)) gsel[i.id] = invN(i.id);
  ibody.innerHTML = itemsOf().map(it => {
    const have = invN(it.id), n = gsel[it.id] | 0;
    return '<div class="inv-row' + (have ? '' : ' zero') + '"><div class="sh-ic"><img src="' + icon(it.id) + '" alt="" draggable="false"></div>' +
      '<div class="inv-info"><b>' + esc(it.name) + '</b><small>Punya ' + nf.format(have) + ' · +' + nf.format(it.exp) + ' EXP</small></div>' + stepper('g', it.id, n, 0, have) + '</div>';
  }).join('');
  const cnt = Object.values(gsel).reduce((s, n) => s + (n | 0), 0), exp = sumOf(gsel, 'exp');
  foot.classList.remove('hide');
  $('invsum').textContent = cnt ? cnt + ' barang · +' + nf.format(exp) + ' EXP' : 'Pilih barang yang mau diberikan';
  const go = $('invgo'); go.disabled = !cnt || giving; go.textContent = giving ? 'Memberikan…' : 'Berikan ke ' + shortName(ch);
  if (focus) { const [a, id] = focus.split('|'); const el = ibody.querySelector('[data-act="' + a + '"][data-id="' + id + '"]'); if (el && !el.disabled) el.focus({ preventScroll: true }); }
}
ibody.addEventListener('click', e => {
  const b = e.target.closest('[data-act]'); if (!b || b.disabled) return;
  const a = b.dataset.act, id = b.dataset.id;
  if (a === 'g+' || a === 'g-') { gsel[id] = Math.max(0, Math.min(invN(id), (gsel[id] | 0) + (a === 'g+' ? 1 : -1))); renderInv(); }
  else if (a === 'login') { closeInv(); $('setbtn').click(); }
  else if (a === 'retry') load(true);
  else if (a === 'shop') { closeInv(); Shell.setTab('shop'); }
});
$('invgo').onclick = give;

/* Memberikan hadiah: server mengurangi barang (atomik) dan menghitung EXP; di sini EXP/mood ditambahkan ke hubungan,
   lalu bubble roleplay masuk ke chat dan AI menjawab (lewat submit() di index.html dengan field `gift`). */
async function give() {
  if (giving || !S || !ch || (window.GX && GX.cur)) return;
  if (busy || !ready) { toast('Tunggu balasan selesai dulu ya'); return; }
  const items = pairs(gsel); if (!Object.keys(items).length) return;
  const chId = ch.id, name = shortName(ch), what = sentence(gsel);
  giving = true; renderInv();
  let r;
  try { r = await aApi('shop/gift', { char: chId, items }); }
  catch (e) { giving = false; toast(e.message || 'Gagal memberikan hadiah'); load(true); return; }
  giving = false;
  if (!r || !r.ok) { renderInv(); return; }
  S = r; lastAt = Date.now(); saveWallet(r);
  for (const k in gsel) delete gsel[k];
  closeInv(); render();
  const note = relApply(chId, r.exp, r.mood, true); /* EXP hadiah tidak kena batas harian obrolan: sudah dibayar pakai coin */
  const expTxt = '+' + nf.format(r.exp) + ' EXP';
  if (!ch || ch.id !== chId || (window.GX && GX.cur)) { toast('Hadiah terkirim ke ' + name + ' · ' + expTxt + (note ? ' · ' + note : '')); return; } /* chat sudah pindah: EXP tetap masuk ke karakter yang benar */
  toast('Kamu memberikan ' + what + ' ke ' + name + ' · ' + expTxt);
  submit({ gift: true, items, text: '🎁 *memberikan ' + what + '*', hist: '*memberikan ' + what + ' kepadamu*', note });
}

/* ---------- Kapan menyegarkan ---------- */
window.addEventListener('shell:tab', e => { if (e.detail === 'shop') load(); });
window.addEventListener('acct', () => { ready0 = true; if (!atok) S = null; if (active()) load(true); else if (invOpen()) { renderInv(); } });
document.addEventListener('visibilitychange', () => { if (!document.hidden && active()) load(); });
new MutationObserver(() => { if (active() && $('smodal').classList.contains('hide')) load(true); })
  .observe($('smodal'), { attributes: true, attributeFilter: ['class'] });

paintWallet(loadWallet());
ready0 = aOn || !!window.__acctSeen; render();
})();
