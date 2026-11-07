/* ===== Shell UI: tab (Beranda / Obrolan Terakhir), rail, daftar obrolan, menu titik tiga, panel detail =====
   Dimuat setelah script utama dan extras.js, sebelum router.js. Memakai global index.html: app, menu, inp, ch, allChars, recent,
   store, img, now, loadLog, charOf, shortName, dispName, openChat, closeChat, toast, cleanName, wipeChat, renderCharMem,
   paintRel, openRel, closeRel, isDesk, draftT. `ch`, `allChars`, `recent` adalah `let` global (bukan properti window): akses langsung.
   Aturan: script utama tidak boleh memanggil Shell di top-level (Shell baru ada setelah file ini dimuat), pakai `window.Shell&&...`. */
(() => {
'use strict';
const $ = id => document.getElementById(id);
const gxOn = () => !!(window.GX && GX.enabled && GX.enabled());
const mqD = matchMedia('(min-width:800px)'), mqW = matchMedia('(min-width:1200px)');
const docked = () => mqW.matches;
const tab = () => app.dataset.tab;
const isOpen = () => app.classList.contains('open');

/* ---------- Penyimpanan kecil: pin ---------- */
const getPins = () => { try { const a = JSON.parse(store.get('pins') || '[]'); return Array.isArray(a) ? a.filter(x => typeof x === 'string') : []; } catch { return []; } };
const setPins = a => store.set('pins', a.length ? JSON.stringify(a) : null);

/* ---------- Toast ringan (toast bawaan ada di footer chat, tidak kelihatan kalau chat tertutup) ---------- */
let ltEl = null, ltT = 0;
function say(t) {
  if (isOpen()) { toast(t); return; }
  if (!ltEl) { ltEl = document.createElement('div'); ltEl.id = 'ltoast'; ltEl.setAttribute('role', 'status'); ltEl.setAttribute('aria-live', 'polite'); app.append(ltEl); }
  ltEl.textContent = t; ltEl.classList.add('show'); clearTimeout(ltT); ltT = setTimeout(() => ltEl.classList.remove('show'), 1800);
}

/* ---------- Tab ---------- */
let mode = 'char'; // sub-tab daftar: 'char' | 'group'
const rhome = $('rhome'), rrecent = $('rrecent'), rlogo = $('rlogo');

function syncRail() {
  const home = tab() === 'home';
  rhome.classList.toggle('on', home); rrecent.classList.toggle('on', !home);
  if (home) rhome.setAttribute('aria-current', 'page'); else rhome.removeAttribute('aria-current');
  if (!home) rrecent.setAttribute('aria-current', 'page'); else rrecent.removeAttribute('aria-current');
  rlogo.setAttribute('aria-expanded', String(home && mqD.matches && app.classList.contains('rail-x')));
}
function setTab(t, opts) {
  t = t === 'recent' ? 'recent' : 'home';
  const auto = !opts || opts.auto !== false;
  app.dataset.tab = t; syncRail();
  if (t === 'home') {
    closeMenu();
    if (isOpen()) closeChat();
    detail(false, { keep: true });
  } else {
    renderRecent();
    if (auto && mqD.matches && !isOpen()) openFirst();
  }
}
function enterChatTab() { if (tab() !== 'recent') setTab('recent', { auto: false }); }

/* ---------- Daftar obrolan ---------- */
const lplist = $('lplist');
const MIC = '<svg viewBox="0 0 24 24"><path d="M9 3h6v10a3 3 0 01-6 0zM5 11a7 7 0 0014 0M12 18v3"/></svg>';
const PIN = '<svg class="lp-pin" viewBox="0 0 24 24" aria-label="Disematkan"><path d="M12 17v5M9 3h6l-1 6 3 3v2H7v-2l3-3z"/></svg>';
const DOTS = '<svg viewBox="0 0 24 24"><circle cx="12" cy="5" r="1.9"/><circle cx="12" cy="12" r="1.9"/><circle cx="12" cy="19" r="1.9"/></svg>';

function timeLabel(t) {
  if (!t) return '';
  const d = new Date(t), n = new Date();
  const diff = Math.round((new Date(n.getFullYear(), n.getMonth(), n.getDate()) - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 864e5);
  return diff === 0 ? now(t) : diff === 1 ? 'Kemarin' : d.toLocaleDateString('id-ID', { day: 'numeric', month: 'short' });
}
function charPrev(id) {
  const l = loadLog(id), e = l[l.length - 1];
  if (!e) return { text: 'Belum ada pesan', t: 0 };
  if (e.ks || e.k) return { mic: true, text: 'Voice note', t: e.t || 0 };
  const x = String(e.x || '').replace(/\*/g, '').replace(/\s+/g, ' ').trim();
  return { text: (e.r === 'me' ? 'Kamu: ' : '') + x, t: e.t || 0 };
}
const activeChar = () => (isOpen() && ch && !(window.GX && GX.cur)) ? ch.id : null;

/* entri daftar = { key, kind:'char'|'group', id, c?, g?, name, t, pinned, active, prev:{text,mic} } */
function buildEntries(m, exclude) {
  const pins = getPins(), out = [];
  if (m === 'group') {
    if (!gxOn()) return out;
    for (const g of GX.groups()) {
      const key = 'g:' + g.id; if (key === exclude) continue;
      const p = GX.preview(g);
      out.push({ key, kind: 'group', id: g.id, g, name: g.name, t: p.t || 0, ord: g.createdAt || 0, pinned: pins.includes(key), active: !!(isOpen() && GX.cur && GX.cur === g), prev: { text: p.text || 'Belum ada pesan' } });
    }
  } else {
    const open = activeChar();
    for (const c of allChars) {
      if (c.id === exclude) continue;
      const hasLog = !!store.get('log:' + c.id) && loadLog(c.id).length > 0;
      if (!(hasLog || pins.includes(c.id) || c.id === open)) continue;
      const p = charPrev(c.id);
      out.push({ key: c.id, kind: 'char', id: c.id, c, name: dispName(c), t: p.t, ord: 0, pinned: pins.includes(c.id), active: c.id === open, prev: p });
    }
  }
  out.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    if (a.pinned) return pins.indexOf(a.key) - pins.indexOf(b.key);
    return (b.t - a.t) || (b.ord - a.ord);
  });
  return out;
}

let raf = 0, dirty = false;
function renderRecent() {
  if (raf) return;
  raf = requestAnimationFrame(() => { raf = 0; draw(); });
}
let touchT = 0;
function touch() { clearTimeout(touchT); touchT = setTimeout(renderRecent, 250); }

function syncTabs() {
  const on = gxOn();
  $('lptabs').classList.toggle('hide', !on);
  if (!on && mode === 'group') mode = 'char';
  $('lptabs').querySelectorAll('button').forEach(b => b.classList.toggle('sel', b.dataset.v === mode));
  const nb = $('lpnew');
  if (on && mode === 'group' && window.GX && GX.newBtn) {
    const btn = GX.newBtn();
    if (btn.parentNode !== nb) { nb.textContent = ''; nb.append(btn); }
    nb.classList.remove('hide');
  } else nb.classList.add('hide');
}
function setMode(m) {
  if (m !== 'char' && m !== 'group') return;
  if (m === 'group' && !gxOn()) m = 'char';
  if (mode === m) { syncTabs(); return; }
  mode = m; syncTabs(); renderRecent();
}

function buildItem(en) {
  const el = document.createElement('div');
  el.className = 'lp-item' + (en.active ? ' on' : ''); el.setAttribute('role', 'listitem'); el.tabIndex = 0; el.dataset.key = en.key;
  const av = document.createElement('span'); av.className = 'lp-av';
  if (en.kind === 'group') av.append(GX.avatar(en.g)); else { const im = img(en.c); im.loading = 'lazy'; im.decoding = 'async'; av.append(im); }
  const bd = document.createElement('span'); bd.className = 'lp-bd';
  const r1 = document.createElement('span'); r1.className = 'lp-row';
  const nm = document.createElement('b'); nm.className = 'lp-name'; nm.textContent = en.name; nm.title = en.name;
  const tm = document.createElement('small'); tm.className = 'lp-time'; tm.textContent = timeLabel(en.t);
  r1.append(nm, tm);
  const r2 = document.createElement('span'); r2.className = 'lp-row';
  const pv = document.createElement('span'); pv.className = 'lp-prev';
  if (en.prev.mic) pv.insertAdjacentHTML('beforeend', MIC);
  pv.append(document.createTextNode(en.prev.text));
  r2.append(pv); if (en.pinned) r2.insertAdjacentHTML('beforeend', PIN);
  bd.append(r1, r2);
  const more = document.createElement('button'); more.type = 'button'; more.className = 'lp-more';
  more.setAttribute('aria-haspopup', 'menu'); more.setAttribute('aria-expanded', 'false'); more.setAttribute('aria-label', 'Menu obrolan'); more.insertAdjacentHTML('beforeend', DOTS);
  el.append(av, bd, more);
  const go = () => openEntry(en, av);
  el.addEventListener('click', e => { if (e.target.closest('.lp-more')) return; go(); });
  el.addEventListener('keydown', e => { if (e.target !== el) return; if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
  more.addEventListener('click', e => { e.stopPropagation(); if (menuFor && menuFor.btn === more) closeMenu(true); else openMenu(en, more); });
  return el;
}

function draw() {
  syncTabs();
  if (tab() !== 'recent') return;
  if (menuFor) { dirty = true; return; } // menu lagi terbuka: gambar ulang setelah ditutup
  const fk = document.activeElement && document.activeElement.closest && document.activeElement.closest('#lplist .lp-item');
  const fkey = fk && fk.dataset.key, st = lplist.scrollTop;
  const items = buildEntries(mode);
  const frag = document.createDocumentFragment();
  items.forEach(en => frag.append(buildItem(en)));
  lplist.textContent = ''; lplist.append(frag); lplist.scrollTop = st;
  if (fkey) { const n = [...lplist.children].find(x => x.dataset.key === fkey); if (n) n.focus({ preventScroll: true }); }
  const em = $('lpempty'), empty = !items.length;
  em.classList.toggle('hide', !empty);
  if (empty) {
    em.querySelector('p').textContent = mode === 'group' ? 'Belum ada grup. Tap "Buat grup" di atas.' : 'Belum ada obrolan. Pilih karakter dari Beranda untuk mulai ngobrol.';
    $('lpempty-home').classList.toggle('hide', mode === 'group');
  }
}

function openEntry(en, avEl) {
  if (en.active) return; // sudah terbuka
  if (en.kind === 'group') GX.openGroup(en.g, avEl); else openChat(en.c, avEl);
}
/* desktop: buka chat terakhir otomatis (6.5) */
function openFirst(exclude) {
  const all = [...buildEntries('char', exclude), ...(gxOn() ? buildEntries('group', exclude) : [])];
  let pick = null;
  for (const r of recent) { pick = all.find(e => e.key === r); if (pick) break; }
  if (!pick) pick = buildEntries(mode, exclude)[0] || null;
  if (!pick) { renderRecent(); return; }
  if (pick.kind === 'group') setMode('group'); else setMode('char');
  openEntry(pick);
}

/* ---------- Panel daftar: tutup/buka ---------- */
function togglePanel() {
  app.classList.toggle('lp-off');
  store.set('lp', app.classList.contains('lp-off') ? '0' : null);
}

/* ---------- Menu titik tiga ---------- */
const lpmenu = $('lpmenu');
let menuFor = null; // { en, btn }
function openMenu(en, btn) {
  closeMenu();
  menuFor = { en, btn }; btn.setAttribute('aria-expanded', 'true');
  lpmenu.querySelector('[data-a="pin"] span').textContent = en.pinned ? 'Lepas sematan' : 'Sematkan';
  lpmenu.classList.remove('hide'); lpmenu.style.visibility = 'hidden';
  const r = btn.getBoundingClientRect(), w = 190, h = lpmenu.offsetHeight;
  let left = Math.max(8, Math.min(innerWidth - w - 8, r.right - w)), top = r.bottom + 6;
  if (r.bottom + h > innerHeight - 8) top = Math.max(8, r.top - h - 6);
  lpmenu.style.left = left + 'px'; lpmenu.style.top = top + 'px'; lpmenu.style.visibility = '';
  const first = lpmenu.querySelector('button'); if (first) first.focus({ preventScroll: true });
}
function closeMenu(refocus) {
  if (!menuFor) { lpmenu.classList.add('hide'); return; }
  const { btn } = menuFor; menuFor = null;
  btn.setAttribute('aria-expanded', 'false'); lpmenu.classList.add('hide');
  if (refocus && btn.isConnected) btn.focus({ preventScroll: true });
  if (dirty) { dirty = false; renderRecent(); }
}
lpmenu.addEventListener('click', e => {
  const b = e.target.closest('button[data-a]'); if (!b || !menuFor) return;
  const en = menuFor.en, a = b.dataset.a; closeMenu(false);
  if (a === 'pin') togglePin(en); else if (a === 'rename') openRename(en); else if (a === 'del') openDelete(en);
});
lpmenu.addEventListener('keydown', e => {
  const items = [...lpmenu.querySelectorAll('button')], i = items.indexOf(document.activeElement);
  if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
  else if (e.key === 'Home') { e.preventDefault(); items[0].focus(); }
  else if (e.key === 'End') { e.preventDefault(); items[items.length - 1].focus(); }
  else if (e.key === 'Tab') closeMenu(true);
});
document.addEventListener('pointerdown', e => { if (menuFor && !e.target.closest('#lpmenu') && !e.target.closest('.lp-more')) closeMenu(false); }, true);
lplist.addEventListener('scroll', () => closeMenu(false), { passive: true });
addEventListener('resize', () => closeMenu(false));

function togglePin(en) {
  let pins = getPins();
  if (pins.includes(en.key)) { pins = pins.filter(x => x !== en.key); say('Sematan dilepas'); }
  else { pins = [en.key, ...pins]; say('Disematkan'); }
  setPins(pins); renderRecent();
}

/* ---------- Ganti nama ---------- */
const rnmodal = $('rnmodal'), rninp = $('rninp');
let rnFor = null;
function openRename(en) {
  rnFor = en;
  const grp = en.kind === 'group', alias = grp ? '' : (store.get('alias:' + en.id) || '');
  rninp.maxLength = grp ? 40 : 24;
  rninp.value = grp ? en.g.name : alias;
  rninp.placeholder = grp ? 'Nama grup' : en.c.name;
  $('rntitle').textContent = grp ? 'Ganti nama grup' : 'Ganti nama obrolan';
  $('rnsub').textContent = grp ? 'Nama grup ini tampil di perangkat ini.' : 'Nama ini hanya tampil di perangkat ini. Karakternya tidak berubah.';
  $('rnreset').classList.toggle('hide', grp || !alias);
  rnmodal.classList.remove('hide');
  setTimeout(() => { rninp.focus(); rninp.select(); }, 30);
}
function closeRename() { rnmodal.classList.add('hide'); rnFor = null; }
function saveRename(reset) {
  const en = rnFor; if (!en) return;
  if (en.kind === 'group') {
    const ok = GX.rename(en.id, rninp.value);
    if (!ok) { say('Nama grup tidak boleh kosong'); return; }
    closeRename(); say('Nama diganti'); renderRecent(); return;
  }
  const v = reset ? '' : cleanName(rninp.value);
  store.set('alias:' + en.id, v || null);
  closeRename(); renamed(en.id);
}
function renamed(id) {
  renderRecent();
  if (isOpen() && ch && ch.id === id && !(window.GX && GX.cur)) { $('hname').textContent = dispName(ch); $('rname').textContent = dispName(ch); }
  say('Nama diganti');
}
$('rnsave').onclick = () => saveRename(false);
$('rnreset').onclick = () => saveRename(true);
$('rncancel').onclick = closeRename;
rninp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); saveRename(false); } });
rnmodal.addEventListener('click', e => { if (e.target === rnmodal) closeRename(); });

/* ---------- Hapus ---------- */
const dlmodal = $('dlmodal');
let dlFor = null;
function openDelete(en) {
  dlFor = en;
  $('dlsub').textContent = en.kind === 'group'
    ? 'Grup "' + en.g.name + '" beserta semua pesannya akan dihapus dari perangkat ini. Tidak bisa dibatalkan.'
    : 'Semua pesan dan voice note dengan ' + en.name + ' di perangkat ini akan dihapus dan obrolan mulai dari awal. Memori dan hubungan tetap ada. Tidak bisa dibatalkan.';
  dlmodal.classList.remove('hide');
  setTimeout(() => $('dlcancel').focus(), 30);
}
function closeDelete() { dlmodal.classList.add('hide'); dlFor = null; }
function doDelete() {
  const en = dlFor; if (!en) return; closeDelete();
  const wasOpen = !!en.active;
  if (en.kind === 'group') {
    GX.remove(en.id); // kalau sedang terbuka, GX.remove menutup chat
    setPins(getPins().filter(x => x !== en.key));
    say('Grup dihapus');
  } else {
    if (wasOpen) { inp.value = ''; clearTimeout(draftT); } // supaya draft chat yang dihapus tidak tersimpan lagi
    wipeChat(en.id);
    setPins(getPins().filter(x => x !== en.key)); store.set('alias:' + en.id, null);
    say('Obrolan dihapus');
  }
  if (wasOpen) {
    if (isOpen()) closeChat(); // karakter: tutup dulu supaya "sedang terbuka" tidak menahan item yang baru dihapus; grup sudah ditutup GX.remove
    if (mqD.matches) { // desktop: pindah ke item pertama sisa daftar, kalau kosong tampil placeholder
      const next = buildEntries(mode)[0] || null;
      if (next) openEntry(next);
    }
  }
  renderRecent();
}
$('dlok').onclick = doDelete;
$('dlcancel').onclick = closeDelete;
dlmodal.addEventListener('click', e => { if (e.target === dlmodal) closeDelete(); });

/* ---------- Panel detail karakter ---------- */
const detailOpen = () => app.classList.contains('dp-on');
function detail(on, opts) {
  app.classList.toggle('dp-on', !!on);
  if (docked() && !(opts && opts.keep)) store.set('dp', on ? null : '0'); // hanya >= 1200px yang diingat
}
let rdRaf = 0;
function refreshDetail() {
  if (rdRaf) return;
  rdRaf = requestAnimationFrame(() => {
    rdRaf = 0;
    if (!ch || (window.GX && GX.cur) || !detailOpen()) return;
    paintRel(); renderCharMem(ch.id);
  });
}
function afterOpen(c) {
  $('dtoggle').classList.toggle('hide', !c);
  setMode(c ? 'char' : 'group');
  if (c) {
    const on = docked() && store.get('dp') !== '0';
    app.classList.toggle('dp-on', on);
    if (on) { paintRel(); renderCharMem(c.id); }
  } else app.classList.remove('dp-on');
  renderRecent();
}
function afterClose() { app.classList.remove('dp-on'); renderRecent(); }

/* ---------- Esc ---------- */
function esc() {
  if (!rnmodal.classList.contains('hide')) { closeRename(); return true; }
  if (!dlmodal.classList.contains('hide')) { closeDelete(); return true; }
  if (menuFor) { closeMenu(true); return true; }
  return false;
}

/* ---------- Inisialisasi ---------- */
if (store.get('rail') === '1') app.classList.add('rail-x');
if (store.get('lp') === '0') app.classList.add('lp-off');
if (!app.dataset.tab) app.dataset.tab = 'home';
syncRail();

rlogo.addEventListener('click', () => {
  if (tab() !== 'home' || !mqD.matches) return;
  const on = app.classList.toggle('rail-x');
  store.set('rail', on ? '1' : null); syncRail();
});
rhome.addEventListener('click', () => setTab('home'));
rrecent.addEventListener('click', () => setTab('recent', { auto: true }));
$('lpclose').addEventListener('click', togglePanel);
$('lpopen').addEventListener('click', togglePanel);
$('dtoggle').addEventListener('click', () => { if (detailOpen()) closeRel(); else openRel(); });
$('dscrim').addEventListener('click', () => closeRel());
$('cetohome').addEventListener('click', () => setTab('home'));
$('lpempty-home').addEventListener('click', () => setTab('home'));
$('lptabs').addEventListener('click', e => { const b = e.target.closest('button'); if (b) setMode(b.dataset.v); });

mqD.addEventListener('change', () => {
  closeMenu(false);
  if (!mqD.matches) app.classList.remove('dp-on');
  syncRail(); renderRecent();
});
mqW.addEventListener('change', () => {
  closeMenu(false);
  if (!mqW.matches) app.classList.remove('dp-on');
  else if (tab() === 'recent' && isOpen() && ch && !(window.GX && GX.cur) && store.get('dp') !== '0') { app.classList.add('dp-on'); paintRel(); renderCharMem(ch.id); }
});

/* ---------- Lebar area chat (slider di Pengaturan > Tampilan, disimpan di `cw`) ----------
   0 = luas (penuh), 0.5 = sempit seperti dulu (720px), 1 = paling sempit (360px). Dipakai lewat variabel CSS --cw. */
const CW_MIN = 360, CW_MID = 720, CW_MAX = 1600;
const cwVal = () => { const v = parseFloat(store.get('cw')); return isFinite(v) ? Math.min(1, Math.max(0, v)) : 0; };
const cwPx = t => Math.round(t <= .5 ? CW_MAX + (CW_MID - CW_MAX) * (t / .5) : CW_MID + (CW_MIN - CW_MID) * ((t - .5) / .5));
function applyCw(t) {
  document.documentElement.style.setProperty('--cw', cwPx(t) + 'px');
  const lab = t < .15 ? 'Luas' : t < .4 ? 'Agak luas' : t < .6 ? 'Sedang' : t < .85 ? 'Agak sempit' : 'Sempit';
  const sl = $('scw'), v = $('cwv');
  if (v) v.textContent = lab + ' · ' + t.toFixed(2);
  if (sl && +sl.value !== t) sl.value = t;
}
{
  const sl = $('scw');
  applyCw(cwVal());
  if (sl) sl.addEventListener('input', () => { const t = Math.round(parseFloat(sl.value) * 100) / 100; store.set('cw', t ? String(t) : null); applyCw(t); });
}

window.Shell = { setTab, tab, enterChatTab, renderRecent, touch, syncTabs, afterOpen, afterClose, togglePanel, detail, detailOpen, docked, refreshDetail, renamed, esc, isDesk: () => mqD.matches };
syncTabs(); renderRecent();
})();
