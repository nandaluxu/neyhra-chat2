/* ===== Tab Peringkat (Leaderboard): kategori -> sub kategori -> metrik =====
   Dimuat setelah shell.js, sebelum router.js. Semua hitungan diputuskan server (lib/leaderboard.js, endpoint /api/auth/lb);
   di sini hanya menampilkan. Tanpa login tetap bisa melihat daftar, hanya kartu "peringkatmu" yang tidak ada.
   Memakai global index.html: atok, aOn, aApi, toast (let/const global, akses langsung) dan Shell, window.PF (profile.js).
   Kejadian: 'shell:tab' (Shell.setTab) dan 'acct' (login/logout) menyegarkan halaman ini. */
(() => {
'use strict';
const $ = id => document.getElementById(id);
const app = $('app'), body = $('lbbody');
if (!app || !body) return;
const nf = new Intl.NumberFormat('id-ID');
const active = () => app.dataset.tab === 'leaderboard';
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

let cfg = null;                       // pohon kategori dari server
let sel = { cat: 'chat', sub: '', metric: '' };
let data = null, failed = '', busy = false, seq = 0;
const cache = new Map();              // kunci cat|sub|metric|token -> { at, data }
const TTL = 30e3;

const SVG = {
  medal: '<svg viewBox="0 0 24 24"><circle cx="12" cy="14.5" r="5.5"/><path d="M8.5 9.5L6 3h4l2 4 2-4h4l-2.5 6.5M12 12v5"/></svg>',
  empty: '<svg viewBox="0 0 24 24"><path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 01-10 0V4zM7 6H4a3 3 0 003 4M17 6h3a3 3 0 01-3 4"/></svg>'
};

const catOf = () => cfg && (cfg.find(c => c.id === sel.cat) || cfg[0]);
const subOf = () => { const c = catOf(); return c && (c.subs.find(s => s.id === sel.sub) || c.subs[0]); };
const metOf = () => { const s = subOf(); return s && (s.metrics.find(m => m.id === sel.metric) || s.metrics[0]); };
const fix = () => { const c = catOf(), s = subOf(), m = metOf(); if (c) sel = { cat: c.id, sub: s.id, metric: m.id }; };

async function load(force) {
  const key = [sel.cat, sel.sub, sel.metric, typeof atok === 'string' ? atok.slice(0, 8) : ''].join('|');
  const hit = cache.get(key);
  if (!force && hit && Date.now() - hit.at < TTL) { data = hit.data; failed = ''; render(); return; }
  const my = ++seq; busy = true; failed = ''; render();
  try {
    const r = await aApi('lb', sel);
    if (my !== seq) return;
    if (!r || !r.ok) throw new Error((r && r.error) || 'Gagal memuat peringkat.');
    cfg = r.cfg; sel = { cat: r.cat, sub: r.sub, metric: r.metric }; data = r;
    cache.set(key, { at: Date.now(), data: r });
  } catch (e) {
    if (my !== seq) return;
    failed = (e && e.message) || 'Tidak bisa terhubung ke server.'; data = null;
  }
  busy = false; render();
}

const ini = n => esc((String(n || '?').trim()[0] || '?').toUpperCase());
function row(r, unit) {
  const av = r.avatar ? `<img src="${esc(r.avatar)}" alt="" draggable="false" loading="lazy">` : `<i class="lb-ph">${ini(r.name)}</i>`;
  const tag = r.rank <= 3 ? ` lb-t${r.rank}` : '';
  return `<li><button type="button" class="lb-row${r.me ? ' me' : ''}${tag}" data-u="${esc(r.username)}">
    <b class="lb-rank">${r.rank}</b>${av}
    <span class="lb-who"><b>${esc(r.name)}${r.me ? ' <em>kamu</em>' : ''}</b>${r.username ? `<small>@${esc(r.username)}</small>` : ''}</span>
    <span class="lb-val"><b>${nf.format(r.v)}</b><small>${esc(unit)}</small></span></button></li>`;
}

function meCard(unit) {
  const me = data && data.me;
  if (!me) return `<div class="lb-me off"><span>Masuk ke akunmu untuk melihat peringkatmu.</span><button type="button" data-act="login">Masuk</button></div>`;
  if (me.hidden) return `<div class="lb-me off"><span>Statistikmu disembunyikan, jadi kamu tidak tampil di peringkat. Ubah di Pengaturan Akun.</span></div>`;
  const rk = me.rank ? `#${me.rank}` : me.v > 0 ? 'Di luar 50 besar' : 'Belum masuk';
  return `<div class="lb-me"><div><small>Peringkatmu</small><b>${rk}</b></div><div class="lb-mv"><small>Skormu</small><b>${nf.format(me.v)} <em>${esc(unit)}</em></b></div></div>`;
}

function render() {
  if (!cfg) {
    body.innerHTML = failed ? `<div class="lb-state"><p>${esc(failed)}</p><button type="button" data-act="retry">Coba lagi</button></div>` : '<div class="lb-skel"></div>';
    return;
  }
  fix();
  const c = catOf(), s = subOf(), m = metOf();
  const cats = cfg.map(x => `<button type="button" role="tab" aria-selected="${x.id === c.id}" class="${x.id === c.id ? 'sel' : ''}" data-cat="${x.id}">${esc(x.name)}</button>`).join('');
  const subs = c.subs.length > 1 ? `<div class="lb-chips" role="tablist" aria-label="Sub kategori">${c.subs.map(x => `<button type="button" role="tab" aria-selected="${x.id === s.id}" class="${x.id === s.id ? 'sel' : ''}" data-sub="${x.id}">${esc(x.name)}</button>`).join('')}</div>` : '';
  const mets = s.metrics.length > 1 ? `<div class="lb-chips lb-m" role="tablist" aria-label="Metrik">${s.metrics.map(x => `<button type="button" role="tab" aria-selected="${x.id === m.id}" class="${x.id === m.id ? 'sel' : ''}" data-met="${x.id}">${esc(x.name)}</button>`).join('')}</div>` : '';
  let list;
  if (busy && !data) list = '<div class="lb-skel"></div>';
  else if (failed) list = `<div class="lb-state"><p>${esc(failed)}</p><button type="button" data-act="retry">Coba lagi</button></div>`;
  else if (!data || !data.rows.length) list = `<div class="lb-state">${SVG.empty}<p>Belum ada yang masuk peringkat ini.<br>Jadilah yang pertama!</p></div>`;
  else list = `<ol class="lb-list${busy ? ' dim' : ''}">${data.rows.map(r => row(r, data.unit)).join('')}</ol>`;
  body.innerHTML = `<nav class="lb-cats" role="tablist" aria-label="Kategori">${cats}</nav>${subs}${mets}
    <div class="lb-head"><h2>${esc(s.name)}</h2><span>${esc(m.name)}</span></div>
    ${data && !failed ? meCard(data.unit) : ''}${list}`;
}

body.addEventListener('click', e => {
  const t = e.target.closest('button'); if (!t || !body.contains(t)) return;
  if (t.dataset.cat) { sel = { cat: t.dataset.cat, sub: '', metric: '' }; data = null; load(); }
  else if (t.dataset.sub) { sel = { cat: sel.cat, sub: t.dataset.sub, metric: '' }; data = null; load(); }
  else if (t.dataset.met) { sel = { ...sel, metric: t.dataset.met }; data = null; load(); }
  else if (t.dataset.act === 'retry') load(true);
  else if (t.dataset.act === 'login') { if (typeof openLogin === 'function') openLogin(); else toast('Masuk lewat menu Profil.'); }
  else if (t.classList.contains('lb-row') && t.dataset.u && window.PF) window.PF.open(t.dataset.u);
});
body.addEventListener('keydown', e => { // panah kiri/kanan pindah kategori
  if ((e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') || !e.target.closest('.lb-cats') || !cfg) return;
  const i = cfg.findIndex(x => x.id === sel.cat), n = cfg[(i + (e.key === 'ArrowRight' ? 1 : cfg.length - 1)) % cfg.length];
  sel = { cat: n.id, sub: '', metric: '' }; data = null; load();
  setTimeout(() => { const b = body.querySelector('.lb-cats .sel'); if (b) b.focus(); }, 0);
});

window.addEventListener('shell:tab', e => { if (e.detail === 'leaderboard') load(); });
window.addEventListener('acct', () => { cache.clear(); if (active()) load(true); });
document.addEventListener('visibilitychange', () => { if (!document.hidden && active()) load(); });
render();
})();
