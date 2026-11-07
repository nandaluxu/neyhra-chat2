/* ===== Tab Minigame: hub game + Tebak Angka =====
   Dimuat setelah shell.js (dan bonus.js), sebelum router.js. Semua hasil permainan, hadiah, dan saldo diputuskan server
   (lib/games.js): di sini hanya menampilkan dan memanggil /api/auth/game, /game/start, /game/guess.
   Memakai global index.html: atok, aOn, aApi, saveWallet, loadWallet, paintWallet (let/const global, akses langsung).
   Kejadian: 'shell:tab' (dari Shell.setTab) dan 'acct' (dari paintAcct) menyegarkan halaman ini.

   Menambah game baru: tambah entri di GAMES (ready:true) + fungsi render layarnya, lalu route aksinya di body click handler. */
(() => {
'use strict';
const $ = id => document.getElementById(id);
const app = $('app'), body = $('gmbody');
const nf = new Intl.NumberFormat('id-ID');
const active = () => app.dataset.tab === 'games';
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const SVG = {
  back: '<svg viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6"/></svg>',
  guess: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 115 0c0 1.7-2.5 2-2.5 3.5M12 17h.01"/></svg>',
  soon: '<svg viewBox="0 0 24 24"><path d="M6 12h4M8 10v4M15 13h.01M18 11h.01"/><path d="M17.32 5H6.68a4 4 0 00-3.98 3.59C2.6 9.42 2 14.46 2 16a3 3 0 003 3c1 0 1.5-.5 2-1l1.41-1.41A2 2 0 019.83 16h4.34a2 2 0 011.41.59L17 18c.5.5 1 1 2 1a3 3 0 003-3c0-1.55-.6-6.58-.68-7.26A4 4 0 0017.32 5z"/></svg>'
};
// daftar game. ready:false = kartu "segera hadir" (belum bisa dibuka)
const GAMES = [
  { id: 'guess', ready: true, icon: SVG.guess, title: 'Tebak Angka', desc: 'Tebak angka rahasia 1-100 dalam 7 kali tebakan. Makin cepat, makin banyak coin.' },
  { id: 'soon', ready: false, icon: SVG.soon, title: 'Segera hadir', desc: 'Minigame lain lagi disiapkan.' }
];

let st = null;            // keadaan terakhir dari server { cfg, daily, game, coins, gems }
let screen = 'hub';       // 'hub' | id game
let ready = false;        // status akun (aktif/tidak) sudah diketahui
let failed = '';          // pesan kalau gagal memuat
let busy = false, lastTok = '', lastAt = 0;
let msg = ['', ''];       // pesan di bawah input [teks, kelas 'ok'|'err']

const empty = (title, text, btn) => '<div class="gm-empty"><h2>' + esc(title) + '</h2>' + (text ? '<p>' + esc(text) + '</p>' : '') + (btn || '') + '</div>';
const setMsg = (text, cls) => {
  msg = [text || '', cls || ''];
  const el = body.querySelector('.gm-msg');
  if (el) { el.textContent = msg[0]; el.className = 'gm-msg' + (cls ? ' ' + cls : ''); }
};

function hub() {
  const d = st.daily;
  return '<div class="gm-grid">' + GAMES.map(g =>
    '<button class="gm-card' + (g.ready ? '' : ' soon') + '" type="button" data-act="open" data-g="' + g.id + '"' + (g.ready ? '' : ' disabled') + '>' +
      '<span class="ic">' + g.icon + '</span><b>' + esc(g.title) + '</b><span>' + esc(g.desc) + '</span>' +
      (g.id === 'guess' ? '<span class="gm-tag">Hadiah hari ini ' + d.wins + '/' + d.cap + '</span>' : '') + '</button>'
  ).join('') + '</div>';
}

function guessScreen() {
  const g = st.game, d = st.daily, rw = st.cfg.rewards, total = rw.length, capped = d.wins >= d.cap;
  const last = g && g.hist.length ? g.hist[g.hist.length - 1] : null;
  const hist = g ? g.hist.map(h => '<span' + (h.r === 'win' ? ' class="win"' : '') + '>' + h.n + (h.r === 'up' ? ' ↑' : h.r === 'down' ? ' ↓' : ' ✓') + '</span>').join('') : '';
  let main;
  if (g && g.active) {
    const left = total - g.tries;
    main =
      '<h2>Tebak angkanya</h2><p class="gm-hint">Angkanya ada di antara dua angka ini. Panah ↑ berarti angkanya lebih besar dari tebakanmu, ↓ lebih kecil.</p>' +
      '<div class="gm-range"><b>' + g.lo + '</b><i>sampai</i><b>' + g.hi + '</b></div>' +
      '<div class="gm-dots" aria-hidden="true">' + Array.from({ length: total }, (_, i) => '<i' + (i < g.tries ? ' class="used"' : '') + '></i>').join('') + '</div>' +
      '<p class="gm-left">Sisa ' + left + ' tebakan' + (g.tries < rw.length ? ' · menang sekarang +' + nf.format(rw[g.tries]) + ' coin' : '') + '</p>' +
      '<div class="gm-row"><input class="gm-f" id="gmin" type="number" inputmode="numeric" min="' + st.cfg.min + '" max="' + st.cfg.max + '" placeholder="' + g.lo + '-' + g.hi + '" aria-label="Tebakanmu" autocomplete="off" enterkeyhint="go">' +
      '<button class="gm-btn" type="button" data-act="guess">Tebak</button></div>' +
      '<p class="gm-msg' + (msg[1] ? ' ' + msg[1] : '') + '" role="status">' + esc(msg[0]) + '</p>' +
      (hist ? '<div class="gm-hist">' + hist + '</div>' : '');
  } else if (g) { // selesai: menang atau kalah
    const won = g.won, prize = g.reward;
    main = '<h2>Tebak angkanya</h2><div class="gm-result">' + (won
      ? '<h3>Benar! Angkanya ' + (last ? last.n : '') + '</h3><p>Ketemu dalam ' + g.tries + ' tebakan.</p>' +
        (prize ? '<div class="gm-prize"><img src="/coin.svg" alt="">+' + nf.format(prize) + ' coin</div>'
               : '<p>Hadiah harian sudah habis (' + d.wins + '/' + d.cap + '), jadi kali ini tanpa coin. Hadiah kembali besok pukul 00.00 WIB.</p>')
      : '<h3>Yah, belum berhasil</h3><p>Angka rahasianya ' + g.secret + '. Coba lagi, bagi dua rentangnya tiap tebakan supaya selalu ketemu dalam ' + total + ' kali.</p>') +
      '</div>' + (hist ? '<div class="gm-hist">' + hist + '</div>' : '') +
      '<button class="gm-btn full" type="button" data-act="start">Main lagi</button><p class="gm-msg' + (msg[1] ? ' ' + msg[1] : '') + '" role="status">' + esc(msg[0]) + '</p>';
  } else {
    main = '<h2>Tebak Angka</h2><p class="gm-hint">Aku memilih satu angka rahasia dari ' + st.cfg.min + ' sampai ' + st.cfg.max + '. Kamu punya ' + total + ' kali tebakan, dan tiap kali kujawab angkanya lebih besar atau lebih kecil.</p>' +
      '<button class="gm-btn full" type="button" data-act="start">Mulai</button><p class="gm-msg' + (msg[1] ? ' ' + msg[1] : '') + '" role="status">' + esc(msg[0]) + '</p>';
  }
  const table = rw.map((c, i) => '<div>Tebakan ke-' + (i + 1) + '<b><img src="/coin.svg" alt="">' + nf.format(c) + '</b></div>').join('');
  return '<button class="gm-back" type="button" data-act="hub">' + SVG.back + 'Semua game</button>' +
    '<div class="gm-panel">' + main + '</div>' +
    '<div class="gm-info"><h3>Hadiah menang</h3><div class="gm-rw">' + table + '</div>' +
    '<p class="gm-cap">' + (capped ? 'Hadiah hari ini sudah habis (' + d.wins + '/' + d.cap + '). Kamu tetap bisa main buat latihan, hadiah kembali besok pukul 00.00 WIB.'
      : 'Maksimal ' + d.cap + ' kemenangan berhadiah per hari (sekarang ' + d.wins + '/' + d.cap + '). Hari berganti pukul 00.00 WIB.') + '</p></div>';
}

function render() {
  if (!ready && !aOn) { body.innerHTML = empty('Memuat…'); return; }
  if (!aOn) { body.innerHTML = empty('Minigame belum tersedia', 'Fitur akun belum aktif di server ini, jadi coin hasil main belum bisa disimpan.'); return; }
  if (!atok) { body.innerHTML = empty('Masuk dulu ya', 'Coin hasil main tersimpan di akunmu, jadi kamu perlu masuk atau daftar dulu.', '<button class="gm-btn" type="button" data-act="login">Masuk / Daftar</button>'); return; }
  if (!st) { body.innerHTML = failed ? empty('Gagal memuat', failed, '<button class="gm-btn" type="button" data-act="retry">Coba lagi</button>') : empty('Memuat…'); return; }
  body.innerHTML = screen === 'guess' ? guessScreen() : hub();
  if (screen === 'guess' && st.game && st.game.active && active()) { const i = $('gmin'); if (i && !msg[1]) i.focus({ preventScroll: true }); }
  else if (screen === 'guess' && $('gmin') && active()) $('gmin').focus({ preventScroll: true });
}

/* ---------- Server ---------- */
async function call(path, data) {
  const r = await aApi(path, data);
  if (r && r.ok) { st = r; failed = ''; saveWallet(r); return true; }
  return false;
}
async function fetchState() {
  try { if (await call('game')) return true; failed = 'Gagal memuat minigame.'; }
  catch (e) { failed = e && e.status === 401 ? '' : (e && e.message) || 'Tidak bisa terhubung ke server.'; }
  return false;
}
async function load(force) {
  if (lastTok !== atok) { lastTok = atok; st = null; failed = ''; screen = 'hub'; msg = ['', '']; }
  if (!aOn || !atok) { st = null; render(); return; }
  if (busy || (!force && st && Date.now() - lastAt < 3000)) { render(); return; }
  busy = true; if (!st) render();
  await fetchState();
  lastAt = Date.now(); busy = false; render();
}

async function start() {
  if (busy) return; busy = true; msg = ['', ''];
  const b = body.querySelector('[data-act="start"]'); if (b) b.disabled = true;
  try { await call('game/start'); } catch (e) { msg = [e.message || 'Gagal memulai, coba lagi.', 'err']; }
  busy = false; render();
}

async function guess() {
  if (busy) return;
  const inp = $('gmin'), n = inp ? Number(inp.value) : NaN, g = st && st.game;
  if (!g || !g.active) return;
  if (inp && inp.value.trim() === '') { setMsg('Isi angka tebakanmu dulu.', 'err'); inp.focus(); return; }
  if (!Number.isInteger(n) || n < g.lo || n > g.hi) { setMsg('Tebak angka bulat antara ' + g.lo + ' dan ' + g.hi + '.', 'err'); inp.focus(); inp.select(); return; }
  busy = true;
  const b = body.querySelector('[data-act="guess"]'); if (b) b.disabled = true;
  try {
    if (await call('game/guess', { n })) {
      const r = st.result;
      msg = r === 'up' ? [n + ' terlalu kecil. Angkanya lebih besar ↑', ''] : r === 'down' ? [n + ' terlalu besar. Angkanya lebih kecil ↓', ''] : ['', ''];
      if (r === 'win' && st.game && st.game.reward) saveWallet(st);
    }
  } catch (e) {
    msg = [e.message || 'Gagal mengirim tebakan, coba lagi.', 'err'];
    if (e.status === 409) await fetchState(); // permainan berubah (mis. dari perangkat lain): ikut keadaan server
  }
  busy = false; render();
}

body.addEventListener('click', e => {
  const b = e.target.closest('[data-act]'); if (!b || b.disabled) return;
  const a = b.dataset.act;
  if (a === 'open') { screen = b.dataset.g; msg = ['', '']; render(); }
  else if (a === 'hub') { screen = 'hub'; msg = ['', '']; render(); }
  else if (a === 'start') start();
  else if (a === 'guess') guess();
  else if (a === 'login') $('setbtn').click();
  else if (a === 'retry') load(true);
});
body.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.id === 'gmin') { e.preventDefault(); guess(); } });

/* ---------- Kapan menyegarkan ---------- */
window.addEventListener('shell:tab', e => { if (e.detail === 'games') load(); });
window.addEventListener('acct', () => { ready = true; if (active()) load(true); });
document.addEventListener('visibilitychange', () => { if (!document.hidden && active()) load(); });
new MutationObserver(() => { if (active() && $('smodal').classList.contains('hide')) load(true); }) // pulang dari Pengaturan (mungkin baru masuk/keluar akun)
  .observe($('smodal'), { attributes: true, attributeFilter: ['class'] });

paintWallet(loadWallet());
ready = aOn || !!window.__acctSeen; render(); // __acctSeen: paintAcct sudah jalan sebelum file ini dimuat (event 'acct' terlewat)
})();
