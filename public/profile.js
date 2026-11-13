/* ===== Tab Profil: foto, nama, bio, mengikuti/pengikut, tab Ringkasan / Karakter / Teman.
   Profil sendiri memakai data lokal. Profil orang lain juga punya tab Ringkasan & Karakter dari snapshot statistik
   yang diterbitkan perangkat pemiliknya (pushStats di index.html); pemiliknya bisa menyembunyikannya di Pengaturan. =====
   Dimuat setelah shell.js (setelah bonus.js dan games.js), sebelum router.js. Data profil dan relasi ikuti ada di server (lib/profile.js);
   statistik obrolan dihitung di browser dari data lokal (hanya untuk profil sendiri).
   Memakai global index.html: atok, aOn, aApi, store, allChars, loadLog, relLoad, lvOf, expAt, REL, idxOf, img, dispName, openChat, toast.
   Kejadian: 'shell:tab' (dari Shell.setTab) dan 'acct' (dari paintAcct) menyegarkan halaman ini. Semua teks dari data lewat textContent. */
(() => {
'use strict';
const $ = id => document.getElementById(id);
const app = $('app'), body = $('pfbody'), rbtn = $('rprofile');
const nf = new Intl.NumberFormat('id-ID');
const active = () => app.dataset.tab === 'profile';
const h = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const btn = (cls, text, act) => { const b = h('button', cls, text); b.type = 'button'; if (act) b.dataset.act = act; return b; };
const ICON = {
  back: '<svg viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6"/></svg>',
  close: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>'
};
const iconBtn = (cls, svg, label) => { const b = h('button', cls); b.type = 'button'; b.setAttribute('aria-label', label); b.innerHTML = svg; return b; }; // svg = konstanta statis di atas

let me = null;          // profil sendiri { username, name, bio, avatar (alamat foto atau ''), joined, invited, followers, following }
let view = null;        // profil yang sedang ditampilkan (me atau akun lain)
let viewing = '';       // username akun lain yang sedang dilihat ('' = profil sendiri)
let tabKey = 'sum';     // 'sum' | 'chars' | 'cups' | 'friends'
let ready = false, failed = '', busy = false, lastTok = '', lastAt = 0;
const fr = { q: '', items: null, err: '', seq: 0 }; // tab Teman
let cups = null; // tab Piala: { ach:[...], streak:{now,best} } dari /api/auth/quests (profil sendiri)
let frT = 0;

/* nama profil dipakai juga di Beranda (sapaan), chat dengan karakter, dan Chat Global */
function shareName() { if (me && me.name && atok) { store.set('authname', me.name); if (typeof syncUname === 'function') syncUname(); } }

/* ---------- Util tampilan ---------- */
function avatar(name, username, src, cls) { // src = alamat foto lengkap (dari server, kolom `avatar`) atau '' untuk huruf awal nama
  const a = h('span', 'pf-av' + (cls ? ' ' + cls : ''), (String(name || username || '?').trim()[0] || '?').toUpperCase());
  a.setAttribute('aria-hidden', 'true');
  if (src) {
    const im = new Image(); im.alt = ''; im.decoding = 'async'; im.draggable = false;
    im.onerror = () => im.remove();
    im.src = src; im.referrerPolicy = 'no-referrer'; a.append(im);
  }
  return a;
}
const joinedText = t => t ? new Date(t).toLocaleDateString('id-ID', { month: 'long', year: 'numeric' }) : '–';
const gate = (title, text, label, act) => {
  const g = h('div', 'pf-gate'); g.append(h('h2', null, title));
  if (text) g.append(h('p', null, text));
  if (label) g.append(btn('pf-btn', label, act));
  return g;
};

function syncRail() {
  const im = rbtn.querySelector('.r-av'), svg = rbtn.querySelector('svg'), url = me && me.avatar && atok ? me.avatar : '';
  if (url) { if (im.getAttribute('src') !== url) im.src = url; im.onerror = () => { im.classList.add('hide'); svg.classList.remove('hide'); }; }
  im.classList.toggle('hide', !url); svg.classList.toggle('hide', !!url);
  rbtn.title = me && atok ? 'Profil · @' + me.username : 'Profil';
}

/* ---------- Statistik obrolan (lokal, hanya profil sendiri) ---------- */
function localStats() {
  const sod = d => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x.getTime(); }, today = sod(Date.now());
  const days = new Array(7).fill(0), rows = [];
  let sent = 0;
  for (const c of allChars) {
    const l = loadLog(c.id); if (!l.length) continue;
    let mine = 0;
    for (const e of l) {
      if (e.r !== 'me') continue; mine++;
      const d = Math.round((today - sod(e.t || 0)) / 864e5); if (e.t && d >= 0 && d < 7) days[6 - d]++;
    }
    sent += mine;
    const st = relLoad(c.id); rows.push({ c, total: (typeof loadCnt === 'function' ? loadCnt(c.id) : l.length), mine, exp: st.r, lv: lvOf(st.r) }); /* total = seumur hidup per karakter (counter), bukan panjang log yang dipangkas 150 */
  }
  rows.sort((a, b) => b.total - a.total);
  const best = rows.reduce((b, r) => (!b || r.lv > b.lv ? r : b), null);
  if (typeof sentTotal === 'function') sent = sentTotal(); // total seumur hidup (tidak turun saat obrolan dihapus), lihat record() di index.html
  return { sent, chars: rows.length, rows, best, days, today };
}
const stageName = lv => { const S = REL && REL.stages; return S && S.length ? S[idxOf(S, lv)].name : ''; };

/* ---------- Kerangka halaman ---------- */
function render() {
  body.textContent = '';
  if (!ready && !aOn) { body.append(gate('Memuat…')); return; }
  if (!aOn) { body.append(gate('Profil belum tersedia', 'Fitur akun belum aktif di server ini, jadi profil belum bisa dipakai.')); return; }
  if (!atok) { body.append(gate('Masuk dulu ya', 'Profil, pengikut, dan mengikuti tersimpan di akunmu, jadi kamu perlu masuk atau daftar dulu.', 'Masuk / Daftar', 'login')); return; }
  if (!view) { body.append(failed ? gate('Gagal memuat', failed, 'Coba lagi', 'retry') : gate('Memuat…')); return; }

  const p = view, own = p.isMe;
  if (!own) { const b = btn('pf-back', '', 'back'); b.innerHTML = ICON.back; b.append(document.createTextNode('Profilku')); body.append(b); }

  const card = h('div', 'pf-card'), top = h('div', 'pf-top'), who = h('div', 'pf-who');
  who.append(h('h1', 'pf-name', p.name), h('div', 'pf-handle', '@' + p.username));
  top.append(avatar(p.name, p.username, p.avatar), who);
  card.append(top);
  card.append(h('p', 'pf-bio' + (p.bio ? '' : ' none'), p.bio || (own ? 'Belum ada bio. Ketuk Edit profil untuk menambahkannya.' : 'Belum ada bio.')));

  const stats = h('div', 'pf-stats');
  for (const [k, n, label] of [['followers', p.followers, 'Pengikut'], ['following', p.following, 'Mengikuti']]) {
    const b = btn('pf-stat', null, 'list'); b.dataset.k = k; b.setAttribute('aria-label', nf.format(n) + ' ' + label);
    b.append(h('b', null, nf.format(n)), h('span', null, label)); stats.append(b);
  }
  const jd = h('div', 'pf-stat date'); jd.append(h('b', null, joinedText(p.joined)), h('span', null, 'Bergabung')); stats.append(jd);
  card.append(stats);

  const acts = h('div', 'pf-acts');
  if (own) acts.append(btn('pf-btn', 'Edit profil', 'edit'));
  else {
    const f = btn('pf-btn' + (p.isFollowing ? ' alt' : ''), p.isFollowing ? 'Mengikuti' : (p.followsMe ? 'Ikuti balik' : 'Ikuti'), 'follow');
    f.setAttribute('aria-pressed', String(!!p.isFollowing)); acts.append(f);
  }
  card.append(acts); body.append(card);

  if (!own) {
    const note = h('p', 'pf-note', 'Mengundang ' + nf.format(p.invited || 0) + ' teman ke Neyhra Chat.' + (p.followsMe ? ' Dia mengikutimu.' : ''));
    body.append(note);
    if (p.hideStats) body.append(h('p', 'pf-note', 'Ringkasan dan karakter obrolannya disembunyikan pemiliknya.'));
    else renderTabs([['sum', 'Ringkasan'], ['chars', 'Karakter']]); // seperti profil sendiri, tanpa tab Teman
    return;
  }
  renderTabs([['sum', 'Ringkasan'], ['chars', 'Karakter'], ['cups', 'Piala'], ['friends', 'Teman']]);
}

/* kerangka tab + panel; list = [key, label]. Profil orang tidak punya tab Teman, jadi tabKey yang tidak ada di list kembali ke tab pertama */
function renderTabs(list) {
  if (!list.some(([k]) => k === tabKey)) tabKey = list[0][0];
  const tabs = h('div', 'pf-tabs'); tabs.setAttribute('role', 'tablist');
  for (const [k, label] of list) {
    const t = btn('pf-tab', label, 'tab'); t.dataset.k = k; t.id = 'pftab-' + k; t.setAttribute('role', 'tab'); t.setAttribute('aria-selected', String(tabKey === k)); t.tabIndex = tabKey === k ? 0 : -1; tabs.append(t);
  }
  const panel = h('div', 'pf-panel'); panel.id = 'pfpanel'; panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', 'pftab-' + tabKey);
  body.append(tabs, panel); paintPanel();
}

function paintPanel() {
  const panel = $('pfpanel'); if (!panel) return;
  panel.textContent = '';
  const own = !!(view && view.isMe);
  if (tabKey === 'chars') panelChars(panel, own); else if (own && tabKey === 'cups') panelCups(panel); else if (own && tabKey === 'friends') panelFriends(panel); else panelSum(panel, own);
}

/* ---------- Statistik profil orang lain (dari server; diterbitkan perangkat pemiliknya lewat profile/stats) ---------- */
function otherStats() {
  const st = (view && view.stats) || {}, rows = [];
  for (const x of Array.isArray(st.chars) ? st.chars : []) {
    const c = allChars.find(k => k.id === x.id);
    if (c) rows.push({ c, lv: x.lv || 1, exp: x.e || 0, total: x.m || 0 });
  }
  rows.sort((a, b) => b.total - a.total);
  const best = rows.reduce((b, r) => (!b || r.lv > b.lv ? r : b), null);
  const days = Array.isArray(st.days) && st.days.length === 7 ? st.days.map(Number) : [0, 0, 0, 0, 0, 0, 0];
  return { sent: st.sent || 0, chars: rows.length, rows, best, days, today: Date.now() };
}

/* ---------- Tab Ringkasan ---------- */
function panelSum(panel, own) {
  const s = own ? localStats() : otherStats();
  const sec1 = h('div', 'pf-sec'), tiles = h('div', 'pf-tiles');
  const tile = (v, label) => { const t = h('div', 'pf-tile'); t.append(h('b', null, v), h('span', null, label)); return t; };
  tiles.append(
    tile(nf.format(s.sent), 'Pesan terkirim'),
    tile(nf.format(s.chars), 'Karakter diajak ngobrol'),
    tile(s.best ? 'Lv ' + s.best.lv : '–', s.best ? 'Hubungan tertinggi · ' + (s.best.c.name || '') : 'Hubungan tertinggi'),
    tile(nf.format(view.invited || 0), own ? 'Teman yang kamu undang' : 'Teman yang diundangnya')
  );
  sec1.append(tiles);
  const sec2 = h('div', 'pf-sec'); sec2.append(h('h3', null, own ? 'Pesanmu 7 hari terakhir' : 'Pesannya 7 hari terakhir'));
  const max = Math.max(1, ...s.days), chart = h('div', 'pf-chart'), nm = ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'];
  chart.setAttribute('role', 'img'); chart.setAttribute('aria-label', 'Grafik pesan 7 hari terakhir: ' + s.days.join(', '));
  s.days.forEach((n, i) => {
    const col = h('div', 'pf-col'), bar = h('i', n ? '' : 'z'); bar.style.height = n ? Math.max(8, Math.round(n / max * 78)) + 'px' : '4px'; bar.title = n + ' pesan';
    col.append(bar, h('small', null, nm[new Date(s.today - (6 - i) * 864e5).getDay()])); chart.append(col);
  });
  sec2.append(chart, own
    ? h('p', 'pf-note', 'Jumlah pesan dihitung seumur hidup dan tidak berkurang saat obrolan dihapus. Di perangkat ini hanya 150 pesan terakhir per karakter yang disimpan; pesan sebelum fitur penghitung ini ada mulai dari jumlah yang tersimpan saat itu.')
    : h('p', 'pf-note', view.statsAt ? 'Terakhir diperbarui ' + new Date(view.statsAt).toLocaleString('id-ID', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) + ' dari perangkat pemiliknya.' : 'Diterbitkan dari perangkat pemilik profil ini.'));
  panel.append(sec1, sec2);
}

/* ---------- Tab Piala (achievements, data /api/auth/quests; hanya profil sendiri) ---------- */
let cupsBusy = false, cupsAt = 0, cupsErr = '';
async function loadCups(force) { // true = baru selesai mengambil data (layar perlu digambar ulang), false = tidak ada yang berubah
  if (!atok || cupsBusy || (!force && Date.now() - cupsAt < 15000)) return false; // cupsAt juga dicatat saat gagal: tidak mengulang fetch terus-menerus
  cupsBusy = true; cupsErr = ''; cupsAt = Date.now();
  try { const r = await aApi('quests'); if (r && r.ok) cups = r; else cupsErr = (r && r.error) || 'Gagal memuat.'; }
  catch (e) { cupsErr = (e && e.status === 401) ? '' : (e && e.message) || 'Gagal memuat.'; }
  cupsBusy = false;
  return true;
}
function panelCups(panel) {
  loadCups().then(fresh => { if (fresh && tabKey === 'cups') paintPanel(); }); // data baru datang belakangan: gambar ulang SEKALI (jangan tanpa syarat: itu memanggil panelCups lagi -> loop tak berujung)
  const head = h('div', 'pf-sec');
  const got = cups ? cups.ach.filter(a => a.got).length : 0, all = cups ? cups.ach.length : 0;
  head.append(h('h3', null, 'Piala ' + got + '/' + all));
  head.append(h('p', 'pf-note', 'Piala didapat otomatis dari aktivitasmu: ngobrol, main game, beri hadiah, klaim harian, dan misi. Hadiahnya langsung masuk saldo.'));
  if (cups && cups.streak && (cups.streak.now > 1 || cups.streak.best > 1)) {
    const st = h('p', 'pf-note', 'Streak klaim harian: ' + cups.streak.now + ' hari (rekor ' + cups.streak.best + ').');
    head.append(st);
  }
  panel.append(head);
  const grid = h('div', 'pf-cups');
  if (!cups) { grid.append(h('p', 'pf-note', cupsErr || 'Memuat piala…')); panel.append(grid); return; }
  const nf2 = new Intl.NumberFormat('id-ID');
  for (const a of cups.ach) {
    const c = h('div', 'pf-cup' + (a.got ? ' got' : ''));
    c.setAttribute('role', 'listitem');
    const pct = Math.min(100, Math.round(a.v / a.n * 100));
    c.innerHTML = '<span class="pc-ic" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 01-10 0V4zM7 6H4a3 3 0 003 4M17 6h3a3 3 0 01-3 4"/></svg></span>';
    const t = h('div', 'pc-t');
    t.append(h('b', null, a.name));
    t.append(h('small', null, a.desc + ' · ' + (a.got ? 'terbuka' : nf2.format(a.v) + '/' + nf2.format(a.n))));
    const bar = h('div', 'pc-bar'), fill = h('i'); fill.style.width = pct + '%'; bar.append(fill);
    t.append(bar);
    c.append(t);
    grid.append(c);
  }
  panel.append(grid);
}

/* ---------- Tab Karakter ---------- */
function panelChars(panel, own) {
  const rows = (own ? localStats() : otherStats()).rows.slice(0, 10);
  if (!rows.length) {
    if (!own) { panel.append(h('div', 'pf-empty', 'Belum ada obrolan dengan karakter.')); return; }
    const e = h('div', 'pf-empty', 'Belum ada obrolan. Mulai ngobrol dengan karakter dari Beranda, nanti karakter favoritmu muncul di sini.');
    e.append(document.createElement('br'), btn('pf-btn', 'Ke Beranda', 'home')); panel.append(e); return;
  }
  const list = h('div', 'pf-list');
  for (const r of rows) {
    const row = btn('pf-row', null, 'chat'); row.dataset.id = r.c.id;
    const im = img(r.c); im.loading = 'lazy'; im.decoding = 'async';
    const lo = expAt(r.lv), hi = r.lv >= (REL && REL.maxLevel || 100) ? lo : expAt(r.lv + 1), pct = hi > lo ? Math.max(0, Math.min(100, (r.exp - lo) / (hi - lo) * 100)) : 100;
    const bd = h('span', 'pf-rb'), bar = h('span', 'pf-bar'), fill = h('i'); fill.style.width = pct + '%'; bar.append(fill);
    bd.append(h('b', null, dispName(r.c)), h('small', null, 'Lv ' + r.lv + (stageName(r.lv) ? ' · ' + stageName(r.lv) : '') + ' · ' + nf.format(r.total) + ' pesan'), bar);
    row.append(im, bd); list.append(row);
  }
  panel.append(list);
}

/* ---------- Tab Teman ---------- */
function userRow(it) {
  const row = h('div', 'pf-row'); row.tabIndex = 0; row.setAttribute('role', 'button'); row.dataset.u = it.username; row.setAttribute('aria-label', 'Lihat profil ' + it.name);
  const bd = h('span', 'pf-rb'); bd.append(h('b', null, it.name), h('small', null, '@' + it.username));
  row.append(avatar(it.name, it.username, it.avatar, 'sm'), bd);
  if (!it.isMe) { const f = btn('pf-fbtn' + (it.isFollowing ? ' on' : ''), it.isFollowing ? 'Mengikuti' : 'Ikuti', 'rowfollow'); f.dataset.u = it.username; f.setAttribute('aria-pressed', String(!!it.isFollowing)); row.append(f); }
  return row;
}
function panelFriends(panel) {
  const lab = h('label', 'srch pf-search');
  lab.innerHTML = '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/></svg>'; // ikon statis
  const inp = h('input'); inp.id = 'pfq'; inp.type = 'search'; inp.placeholder = 'Cari username'; inp.autocomplete = 'off'; inp.autocapitalize = 'off'; inp.spellcheck = false; inp.maxLength = 20; inp.value = fr.q; inp.setAttribute('aria-label', 'Cari username');
  lab.append(inp);
  const box = h('div'); box.id = 'pfres';
  panel.append(lab, box); paintFriends();
  if (!fr.items) searchUsers();
}
function paintFriends() {
  const box = $('pfres'); if (!box) return; box.textContent = '';
  if (fr.err) { box.append(h('div', 'pf-empty', fr.err)); return; }
  if (!fr.items) { box.append(h('div', 'pf-empty', 'Memuat…')); return; }
  if (!fr.items.length) { box.append(h('div', 'pf-empty', fr.q ? 'Tidak ada akun dengan awalan itu.' : 'Belum ada akun lain.')); return; }
  box.append(h('h3', 'pf-h', fr.q ? 'Hasil pencarian' : 'Baru bergabung'));
  const list = h('div', 'pf-list'); fr.items.forEach(it => list.append(userRow(it))); box.append(list);
}
async function searchUsers() {
  const seq = ++fr.seq, q = fr.q;
  try {
    const r = await aApi('users', { q });
    if (seq !== fr.seq) return;
    fr.items = r && r.ok ? r.items : []; fr.err = r && r.ok ? '' : ((r && r.error) || 'Gagal mencari.');
  } catch (e) { if (seq !== fr.seq) return; fr.err = (e && e.message) || 'Tidak bisa terhubung ke server.'; }
  if (tabKey === 'friends') paintFriends();
}

/* ---------- Ikuti ---------- */
// was = status ikuti sebelum diklik. Menyinkronkan hitungan dan semua salinan data (profil, hasil cari, daftar modal).
async function toggleFollow(username, on, was) {
  const r = await aApi('follow', { username, on });
  if (!r || !r.ok) throw new Error((r && r.error) || 'Gagal.');
  if (me && Number.isFinite(me.following)) me.following = Math.max(0, me.following + (r.isFollowing ? 1 : 0) - (was ? 1 : 0));
  if (view && view.username === username) { view.isFollowing = r.isFollowing; view.followers = r.followers; }
  for (const it of fr.items || []) if (it.username === username) it.isFollowing = r.isFollowing;
  for (const it of modalItems) if (it.username === username) it.isFollowing = r.isFollowing;
  return r;
}
async function followFromRow(b) {
  const u = b.dataset.u, was = b.getAttribute('aria-pressed') === 'true';
  b.disabled = true;
  try { await toggleFollow(u, !was, was); }
  catch (e) { toast(e.message || 'Gagal, coba lagi.'); }
  syncRows(u); b.disabled = false;
}
// segarkan tombol ikuti untuk username itu (hasil cari, modal) dan hitungan Mengikuti di profil sendiri
function syncRows(u) {
  const st = (fr.items || []).find(i => i.username === u) || modalItems.find(i => i.username === u);
  const on = !!(st && st.isFollowing);
  document.querySelectorAll('.pf-fbtn[data-u="' + CSS.escape(u) + '"]').forEach(b => { b.classList.toggle('on', on); b.textContent = on ? 'Mengikuti' : 'Ikuti'; b.setAttribute('aria-pressed', String(on)); });
  if (view && view.isMe && me) { const n = body.querySelectorAll('.pf-stat b'); if (n[1]) n[1].textContent = nf.format(me.following); }
}

/* ---------- Server ---------- */
// pengaturan hide statistik: samakan kotak centang di Pengaturan (index.html) dan cache lokal yang dipakai pushStats di sana
function syncHide(v) {
  const cb = document.getElementById('shide'); if (cb && !cb.disabled) cb.checked = !!v;
  store.set('phide', v ? '1' : '0');
}
async function fetchMe() {
  try {
    const r = await aApi('profile');
    if (r && r.ok) { me = r.profile; if (!viewing) view = me; failed = ''; shareName(); syncRail(); syncHide(me.hideStats); return true; }
    failed = (r && r.error) || 'Gagal memuat profil.';
  } catch (e) { failed = e && e.status === 401 ? '' : (e && e.message) || 'Tidak bisa terhubung ke server.'; }
  return false;
}
async function load(force) {
  if (lastTok !== atok) { lastTok = atok; me = null; view = null; viewing = ''; failed = ''; fr.items = null; fr.q = ''; fr.err = ''; cups = null; tabKey = 'sum'; syncRail(); }
  if (!aOn || !atok) { me = null; view = null; render(); syncRail(); return; }
  if (busy || (!force && me && Date.now() - lastAt < 4000)) { render(); return; }
  busy = true; if (!view) render();
  await fetchMe();
  if (viewing && view && view.username !== viewing) { try { const r = await aApi('profile', { username: viewing }); if (r && r.ok) view = r.profile; } catch {} }
  lastAt = Date.now(); busy = false; render();
}
async function openUser(username) {
  if (!username) return;
  if (me && username === me.username) { backToMe(); return; }
  viewing = username; view = null; closeModal(); render(); scrollTop();
  try {
    const r = await aApi('profile', { username });
    if (r && r.ok) { view = r.profile; failed = ''; if (view.isMe) { me = view; viewing = ''; } }
    else { failed = (r && r.error) || 'Gagal memuat profil.'; }
  } catch (e) { failed = (e && e.message) || 'Tidak bisa terhubung ke server.'; }
  if (!view) { viewing = ''; view = me; if (failed) toast(failed); failed = ''; }
  render();
}
function backToMe() { viewing = ''; view = me; render(); scrollTop(); }
const scrollTop = () => { $('profile').scrollTop = 0; };

/* ---------- Modal (edit profil, pengikut/mengikuti) ---------- */
let modal = null, modalItems = [], modalState = null;
function openModal(box) {
  closeModal();
  modal = h('div'); modal.id = 'pfmodal'; box.classList.add('nbox', 'sbox'); box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true');
  modal.append(box); modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });
  app.append(modal);
}
function closeModal() { if (modal) { modal.remove(); modal = null; modalItems = []; modalState = null; } }
document.addEventListener('keydown', e => { if (e.key === 'Escape' && modal) { e.stopPropagation(); closeModal(); } }, true);

async function openList(kind) {
  const label = kind === 'followers' ? 'Pengikut' : 'Mengikuti', box = h('div'), head = h('div', 'pf-mh');
  const x = iconBtn('', ICON.close, 'Tutup'); x.addEventListener('click', closeModal);
  head.append(h('h2', null, label + ' · @' + view.username), x);
  const list = h('div', 'pf-list'); list.id = 'pflist'; const more = btn('pf-more hide', 'Muat lebih banyak', 'more');
  box.append(head, list, more); openModal(box);
  modalState = { kind, username: view.username, next: 0, loading: false }; modalItems = [];
  list.append(h('div', 'pf-empty', 'Memuat…'));
  await loadList(true);
  const f = modal && modal.querySelector('button'); if (f) f.focus({ preventScroll: true });
}
async function loadList(first) {
  const st = modalState; if (!st || st.loading) return; st.loading = true;
  const list = $('pflist'), more = modal && modal.querySelector('[data-act="more"]');
  try {
    const r = await aApi('follows', { username: st.username, kind: st.kind, ...(st.next ? { before: st.next } : {}) });
    if (modalState !== st) return;
    if (!r || !r.ok) throw new Error((r && r.error) || 'Gagal memuat.');
    if (first) list.textContent = '';
    modalItems.push(...r.items); r.items.forEach(it => list.append(userRow(it)));
    st.next = r.more ? r.next : 0; more.classList.toggle('hide', !r.more);
    if (!modalItems.length) list.append(h('div', 'pf-empty', st.kind === 'followers' ? 'Belum ada pengikut.' : 'Belum mengikuti siapa pun.'));
  } catch (e) { if (modalState === st) { if (first) list.textContent = ''; list.append(h('div', 'pf-empty', (e && e.message) || 'Tidak bisa terhubung ke server.')); } }
  st.loading = false;
}

/* edit profil */
let editState = null;
function openEdit() {
  if (!me) return;
  editState = { av: undefined, preview: me.avatar ? 'cur' : '' }; // av: undefined = tidak berubah, null = hapus, string = JPEG baru
  const box = h('div'), head = h('div', 'pf-mh');
  const x = iconBtn('', ICON.close, 'Tutup'); x.addEventListener('click', closeModal);
  head.append(h('h2', null, 'Edit profil'), x);

  const pic = h('div', 'pf-epic'), holder = h('span'); holder.id = 'pfepic';
  const acts = h('div'), file = h('input'); file.type = 'file'; file.accept = 'image/*'; file.hidden = true; file.id = 'pffile';
  const ch = btn('pf-lnk', 'Ganti foto', 'pick'), rm = btn('pf-lnk d', 'Hapus foto', 'rmpic'); rm.id = 'pfrm';
  acts.append(ch, rm, file); pic.append(holder, acts);

  const l1 = h('label', 'pf-lab', 'Nama'), n = h('input', 'pf-inp'); n.id = 'pfname'; n.maxLength = 20; n.value = me.name; n.autocomplete = 'off'; n.enterkeyhint = 'done'; l1.append(n);
  const l2 = h('label', 'pf-lab', 'Bio'), b = h('textarea', 'pf-inp'); b.id = 'pfbio'; b.maxLength = 120; b.rows = 3; b.value = me.bio || ''; b.placeholder = 'Ceritakan sedikit tentangmu'; l2.append(b);
  const cnt = h('div', 'pf-cnt', (me.bio || '').length + '/120'); cnt.id = 'pfcnt';
  const un = h('p', 'pf-note', 'Username @' + me.username + ' tidak bisa diganti.');
  const msg = h('p', 'pf-msg'); msg.id = 'pfmsg'; msg.setAttribute('role', 'status');
  const act = h('div', 'pf-mact'), cancel = btn('', 'Batal', 'cancel'), save = btn('go', 'Simpan', 'save'); save.id = 'pfsave'; act.append(cancel, save);
  box.append(head, pic, l1, l2, cnt, un, msg, act); openModal(box); paintEditPic();
  b.addEventListener('input', () => { cnt.textContent = b.value.length + '/120'; });
  n.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); saveEdit(); } });
  file.addEventListener('change', async () => {
    const f = file.files && file.files[0]; file.value = ''; if (!f) return;
    msg.className = 'pf-msg'; msg.textContent = '';
    if (!/^image\//.test(f.type) || f.size > 15 * 1024 * 1024) { msg.className = 'pf-msg err'; msg.textContent = 'Pilih file gambar (maks 15 MB).'; return; }
    try { editState.av = await toJpeg(f); editState.preview = editState.av; paintEditPic(); }
    catch (e) { msg.className = 'pf-msg err'; msg.textContent = (e && e.message) || 'Foto tidak bisa dipakai.'; }
  });
  setTimeout(() => n.focus({ preventScroll: true }), 30);
}
function paintEditPic() {
  const holder = $('pfepic'); if (!holder || !editState) return;
  const p = editState.preview, a = avatar(($('pfname') && $('pfname').value) || me.name, me.username, p === 'cur' ? me.avatar : '');
  if (p && p !== 'cur') { const im = new Image(); im.alt = ''; im.src = p; im.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:cover'; a.append(im); }
  holder.replaceWith(a); a.id = 'pfepic';
  $('pfrm').classList.toggle('hide', !p);
}
function toJpeg(file) { // kecilkan ke 256x256 (potong tengah) lalu JPEG; target <= ±80 KB
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file), im = new Image();
    im.onload = () => {
      URL.revokeObjectURL(url);
      const S = 256, c = document.createElement('canvas'); c.width = c.height = S;
      const g = c.getContext('2d'), m = Math.min(im.naturalWidth, im.naturalHeight);
      if (!m) { rej(new Error('Foto tidak bisa dibaca.')); return; }
      g.fillStyle = '#fff'; g.fillRect(0, 0, S, S);
      g.drawImage(im, (im.naturalWidth - m) / 2, (im.naturalHeight - m) / 2, m, m, 0, 0, S, S);
      let q = .86, out = c.toDataURL('image/jpeg', q);
      while (out.length > 110000 && q > .4) { q -= .1; out = c.toDataURL('image/jpeg', q); }
      if (out.length > 110000) rej(new Error('Foto terlalu besar, coba foto lain.')); else res(out);
    };
    im.onerror = () => { URL.revokeObjectURL(url); rej(new Error('Foto tidak bisa dibaca.')); };
    im.src = url;
  });
}
async function saveEdit() {
  if (!editState || !me) return;
  const msg = $('pfmsg'), save = $('pfsave'), name = $('pfname').value.trim(), bio = $('pfbio').value.trim();
  msg.className = 'pf-msg';
  if (!name) { msg.className = 'pf-msg err'; msg.textContent = 'Nama tidak boleh kosong.'; $('pfname').focus(); return; }
  const payload = {}; if (name !== me.name) payload.name = name; if (bio !== (me.bio || '')) payload.bio = bio; if (editState.av !== undefined) payload.avatar = editState.av;
  if (!Object.keys(payload).length) { closeModal(); return; }
  save.disabled = true; msg.textContent = 'Menyimpan…';
  try {
    const r = await aApi('profile/edit', payload);
    if (!r || !r.ok) throw new Error((r && r.error) || 'Gagal menyimpan.');
    me = r.profile; view = me; shareName(); syncRail(); closeModal(); render(); toast('Profil disimpan');
  } catch (e) { msg.className = 'pf-msg err'; msg.textContent = (e && e.message) || 'Gagal menyimpan, coba lagi.'; save.disabled = false; }
}

/* ---------- Klik & input ---------- */
document.addEventListener('click', e => {
  const b = e.target.closest('[data-act]'); if (!b || b.disabled) return;
  const inBody = body.contains(b), inModal = modal && modal.contains(b); if (!inBody && !inModal) return;
  const a = b.dataset.act;
  if (a === 'login') openLogin();
  else if (a === 'retry') load(true);
  else if (a === 'back') backToMe();
  else if (a === 'edit') openEdit();
  else if (a === 'list') openList(b.dataset.k);
  else if (a === 'more') loadList(false);
  else if (a === 'home') Shell.setTab('home');
  else if (a === 'tab') { tabKey = b.dataset.k; body.querySelectorAll('.pf-tab').forEach(t => { const on = t === b; t.setAttribute('aria-selected', String(on)); t.tabIndex = on ? 0 : -1; }); const p = $('pfpanel'); if (p) p.setAttribute('aria-labelledby', 'pftab-' + tabKey); paintPanel(); }
  else if (a === 'chat') { const c = allChars.find(x => x.id === b.dataset.id); if (c) openChat(c, b.querySelector('img')); }
  else if (a === 'follow') { b.disabled = true; toggleFollow(view.username, b.getAttribute('aria-pressed') !== 'true', b.getAttribute('aria-pressed') === 'true').then(() => render()).catch(er => { toast(er.message || 'Gagal, coba lagi.'); b.disabled = false; }); }
  else if (a === 'rowfollow') followFromRow(b);
  else if (a === 'pick') $('pffile').click();
  else if (a === 'rmpic') { editState.av = null; editState.preview = ''; paintEditPic(); }
  else if (a === 'cancel') closeModal();
  else if (a === 'save') saveEdit();
});
// baris pengguna (hasil cari / modal): klik di luar tombol = buka profilnya
function rowOpen(e) {
  const row = e.target.closest('.pf-row[data-u]'); if (!row || e.target.closest('button')) return;
  if (e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ') return;
  e.preventDefault(); openUser(row.dataset.u);
}
document.addEventListener('click', e => { if ((body.contains(e.target) || (modal && modal.contains(e.target)))) rowOpen(e); });
document.addEventListener('keydown', e => { if ((body.contains(e.target) || (modal && modal.contains(e.target)))) rowOpen(e); });
body.addEventListener('input', e => {
  if (e.target.id !== 'pfq') return;
  e.target.value = e.target.value.toLowerCase().replace(/[^a-z0-9_.-]/g, ''); fr.q = e.target.value; fr.items = null; fr.err = '';
  clearTimeout(frT); frT = setTimeout(searchUsers, 300); paintFriends();
});
body.addEventListener('keydown', e => { // panah kiri/kanan pindah tab
  const t = e.target.closest && e.target.closest('.pf-tab'); if (!t || (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft')) return;
  const all = [...body.querySelectorAll('.pf-tab')], i = all.indexOf(t), n = all[(i + (e.key === 'ArrowRight' ? 1 : all.length - 1)) % all.length];
  n.focus(); n.click();
});

/* ---------- Kapan menyegarkan ---------- */
window.addEventListener('shell:tab', e => { if (e.detail === 'profile') load(); });
window.addEventListener('acct', () => { ready = true; load(true); });
document.addEventListener('visibilitychange', () => { if (!document.hidden && active()) load(); });
new MutationObserver(() => { if (active() && $('smodal').classList.contains('hide')) load(true); }) // pulang dari Pengaturan (mungkin baru masuk/keluar akun)
  .observe($('smodal'), { attributes: true, attributeFilter: ['class'] });

ready = aOn || !!window.__acctSeen; // __acctSeen: paintAcct sudah jalan sebelum file ini dimuat (event 'acct' terlewat)
if (ready && atok && aOn) load(true); else render();
window.PF = { open: u => { Shell.setTab('profile', { auto: false }); setTimeout(() => openUser(u), 0); } }; // dipakai tab Peringkat untuk membuka profil pemain
})();
