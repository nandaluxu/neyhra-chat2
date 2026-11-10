/* ===== Overlay Masuk (password + Google) dan pilih username =====
   Dimuat setelah semua tab, sebelum router.js. Dipanggil lewat openLogin() dari halaman yang butuh akun (Profil, Bonus, Minigame, Toko, Chat Global, Skrip).
   Memakai global index.html: $, store, atok, aApi, authGo, initAcct, setA (let/const/function global, akses langsung).
   Google: Google Identity Services (token ID dikirim ke /api/auth/google atau /api/auth/google/link, diverifikasi server di lib/google.js).
   Tombol Google hanya muncul kalau server punya env GOOGLE_CLIENT_ID (dibaca dari /api/auth/config). */
(() => {
'use strict';
const $ = id => document.getElementById(id);
const app = $('app');

const m = document.createElement('div');
m.id = 'lmodal'; m.className = 'hide'; m.setAttribute('role', 'dialog'); m.setAttribute('aria-modal', 'true'); m.setAttribute('aria-label', 'Masuk');
m.innerHTML = `<div class="lbox" id="lbox">
  <button class="lx" id="lclose" type="button" aria-label="Tutup"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
  <div id="lstep1">
    <h2>Masuk</h2>
    <p class="lsub">Masuk untuk memakai profil, bonus, coin, dan memindahkan obrolan ke perangkat lain.</p>
    <div id="lgwrap" class="hide"><div id="lgbtn"></div><div class="lor"><span>atau pakai username</span></div></div>
    <input id="auser" class="ainp" type="text" autocomplete="username" autocapitalize="off" spellcheck="false" maxlength="20" placeholder="Username" aria-label="Username">
    <input id="apass" class="ainp" type="password" autocomplete="current-password" maxlength="100" placeholder="Password" aria-label="Password">
    <div class="seg"><button type="button" id="alogin">Masuk</button><button type="button" id="areg">Daftar</button></div>
    <p id="lstat" class="lstat" role="status"></p>
  </div>
  <div id="lstep2" class="hide">
    <h2>Pilih username</h2>
    <p class="lsub">Akunmu sudah dibuat. Pilih username unik (3-20 karakter: huruf, angka, titik, strip, garis bawah). Ini tidak bisa diganti lagi, nama tampilan tetap bisa diubah di Profil.</p>
    <input id="lun" class="ainp" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="20" placeholder="username" aria-label="Username baru" enterkeyhint="done">
    <button class="lprimary" id="lunok" type="button">Simpan</button>
    <button class="llink" id="lunskip" type="button">Lewati dulu</button>
    <p id="lstat2" class="lstat" role="status"></p>
  </div>
</div>`;
app.append(m);

const box = $('lbox');
const say = (id, t, err) => { const el = $(id); el.textContent = t || ''; el.classList.toggle('err', !!err); };
const ui1 = { set: (t, e) => say('lstat', t, e), busy: on => box.classList.toggle('sbusy', on), ok: r => { if (!(r && r.needUsername)) close(); } }; /* ok: dipanggil authGo begitu login sukses — overlay menutup sendiri, sinkron lanjut di belakang layar (akun Google baru tetap dibuka untuk langkah pilih username) */
let step = 1, lastFocus = null;

function showStep(n) {
  step = n;
  $('lstep1').classList.toggle('hide', n !== 1);
  $('lstep2').classList.toggle('hide', n !== 2);
  m.setAttribute('aria-label', n === 1 ? 'Masuk' : 'Pilih username');
  if (n === 2) { say('lstat2', ''); setTimeout(() => $('lun').focus(), 60); }
}
function open(n) {
  if (typeof atok !== 'undefined' && atok && n !== 2) return; // sudah masuk
  lastFocus = document.activeElement;
  showStep(n || 1);
  ui1.set(''); ui1.busy(false);
  m.classList.remove('hide');
  if ((n || 1) === 1) { paintGoogle(); setTimeout(() => { if (matchMedia('(hover:hover)').matches) $('auser').focus(); }, 60); }
}
function close() {
  m.classList.add('hide');
  $('apass').value = '';
  try { if (lastFocus && lastFocus.focus) lastFocus.focus(); } catch {}
}
window.openLogin = n => open(n === 2 ? 2 : 1);

/* ---------- password ---------- */
async function go(kind) {
  const username = $('auser').value.trim(), password = $('apass').value;
  if (!username || !password) { ui1.set('Isi username dan password dulu.', true); return; }
  const r = await authGo(kind, { username, password }, ui1);
  if (r) { $('apass').value = ''; close(); }
}
$('alogin').onclick = () => go('login');
$('areg').onclick = () => go('register');
$('apass').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); go('login'); } });
$('auser').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $('apass').focus(); } });

/* ---------- username (setelah daftar lewat Google) ---------- */
const skipKey = 'unskip';
async function saveName() {
  const username = $('lun').value.trim();
  if (!username) { say('lstat2', 'Isi username dulu.', true); return; }
  box.classList.add('sbusy'); say('lstat2', 'Menyimpan…');
  try {
    const r = await aApi('username', { username });
    store.set('gu', r.username || null);
    await initAcct();
    close();
  } catch (e) { say('lstat2', e.message, true); }
  box.classList.remove('sbusy');
}
$('lunok').onclick = saveName;
$('lun').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); saveName(); } });
$('lunskip').onclick = () => { try { sessionStorage.setItem(skipKey, '1'); } catch {} close(); };

/* ---------- penutup ---------- */
$('lclose').onclick = () => { if (step === 2) $('lunskip').click(); else close(); };
m.addEventListener('mousedown', e => { if (e.target === m) m._down = true; else m._down = false; });
m.addEventListener('click', e => { if (e.target === m && m._down) $('lclose').click(); });
addEventListener('keydown', e => { if (e.key === 'Escape' && !m.classList.contains('hide')) { e.preventDefault(); $('lclose').click(); } });

/* ---------- Google ---------- */
let gcid = null, gisP = null, gInit = false;
async function clientId() {
  if (gcid !== null) return gcid;
  try { gcid = (await (await fetch('/api/auth/config')).json()).google || ''; } catch { gcid = ''; return ''; }
  return gcid;
}
function loadGis() {
  return gisP ??= new Promise((res, rej) => {
    const s = document.createElement('script'); s.src = 'https://accounts.google.com/gsi/client'; s.async = true;
    s.onload = res; s.onerror = () => { gisP = null; rej(new Error('gis')); };
    document.head.append(s);
  });
}
async function gisReady() {
  const id = await clientId(); if (!id) return false;
  try { await loadGis(); } catch { return false; }
  if (!window.google || !google.accounts || !google.accounts.id) return false;
  if (!gInit) { google.accounts.id.initialize({ client_id: id, callback: onCredential, use_fedcm_for_prompt: true }); gInit = true; }
  return true;
}
const dark = () => document.documentElement.dataset.theme === 'dark' || (document.documentElement.dataset.theme !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
function drawBtn(el, text) {
  el.textContent = '';
  const w = Math.max(200, Math.min(380, Math.round(el.parentElement.clientWidth || el.clientWidth || 300)));
  google.accounts.id.renderButton(el, { type: 'standard', theme: dark() ? 'filled_black' : 'outline', size: 'large', text, shape: 'pill', width: w, logo_alignment: 'left' });
}
async function paintGoogle() {
  const ok = await gisReady();
  $('lgwrap').classList.toggle('hide', !ok);
  if (ok && !m.classList.contains('hide') && step === 1) drawBtn($('lgbtn'), 'continue_with');
}
/* Satu callback untuk dua keperluan: belum masuk (atok kosong) = login, sudah masuk = tautkan ke akun ini. */
async function onCredential(resp) {
  const credential = resp && resp.credential; if (!credential) return;
  if (typeof atok !== 'undefined' && atok) return link(credential);
  const r = await authGo('google', { credential }, ui1);
  if (!r) return;
  if (r.needUsername) { showStep(2); try { sessionStorage.removeItem(skipKey); } catch {} } /* overlay sudah ditutup oleh ui.ok untuk yang tidak perlu username */
}

/* ---------- Pengaturan: hubungkan / lepas Google (akun lama) ---------- */
async function link(credential) {
  setA('Menghubungkan Google…');
  try {
    const r = await aApi('google/link', { credential });
    await initAcct();
    setA('Google (' + (r.email || 'akun') + ') terhubung. Sekarang kamu bisa masuk dengan Google ke akun ini.');
  } catch (e) { setA(e.message, true); }
}
async function paintLink() {
  const row = $('grow'); if (!row) return;
  const g = window.__gacct;
  if (!atok || !g) { row.classList.add('hide'); return; }
  const id = await clientId();
  if (!id) { row.classList.add('hide'); return; }
  row.classList.remove('hide');
  $('gtxt').textContent = g.linked ? (g.email || 'Terhubung') : 'Belum terhubung';
  $('gunl').classList.toggle('hide', !(g.linked && g.hasPassword));
  const holder = $('gbtn');
  if (g.linked) { holder.textContent = ''; return; }
  if (await gisReady() && !holder.firstChild) drawBtn(holder, 'signin_with');
}
$('gunl').onclick = async () => {
  if (!confirm('Lepas Google dari akun ini? Kamu tetap bisa masuk dengan username dan password.')) return;
  try { await aApi('google/unlink'); await initAcct(); setA('Google dilepas dari akun ini.'); } catch (e) { setA(e.message, true); }
};

/* ---------- reaksi status akun ---------- */
addEventListener('acct', () => {
  paintLink();
  const g = window.__gacct;
  if (g && g.pendingName && m.classList.contains('hide')) { // login Google sebelumnya belum memilih username (mis. halaman dimuat ulang)
    let skipped = false; try { skipped = !!sessionStorage.getItem(skipKey); } catch {}
    if (!skipped) open(2);
  } else if (g && !g.pendingName && step === 2 && !m.classList.contains('hide')) close();
});
})();
