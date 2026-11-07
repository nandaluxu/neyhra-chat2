/* ===== Chat grup dengan banyak karakter (fitur rahasia) =====
   Dimuat setelah script utama di index.html, jadi semua fungsi/variabel global di sana (store, chat, addText, idb, post, ...)
   langsung bisa dipakai. Server tetap stateless: riwayat grup disimpan di browser dan dikirim tiap request.
   Browser yang mengatur rantai giliran: satu request = satu karakter bicara. Model mengusulkan `next`, client memutuskan.

   Cara membuka: kirim pesan rahasia ke Reze (lihat SECRET). Pesan itu dicegat di browser dan TIDAK dikirim ke ChatGPT maupun Fish Audio.
   Mengganti kode: jalankan GX.hash('kode baru') di console, tempel angkanya ke SECRET. Ini cuma pagar UI, bukan keamanan sungguhan. */
(() => {
'use strict';

/* ---------- Konstanta (mudah diubah) ---------- */
const CFG = {
  MAX_CHAIN: 4,            // maks balasan AI per pesan user
  MAX_PER_CHAR: 2,         // maks balasan satu karakter dalam satu rantai
  ACCEPT: [0.85, 0.65, 0.40], // peluang menerima `next` setelah balasan ke-1, ke-2, ke-3
  AUTO_CHAIN: 3,           // maks giliran untuk "Biarkan mereka ngobrol"
  MIN_MEMBERS: 2, MAX_MEMBERS: 5, MAX_GROUPS: 20,
  HIST: 30,                // riwayat yang dikirim ke server (riwayat lokal tetap lengkap)
  MSGMAX: 400, AUDMAX: 30  // maks pesan per grup, dan maks voice note yang audionya disimpan
};
const SECRET = 3761943960696751; // hash dari kode rahasia (huruf besar/kecil dan spasi diabaikan)
const PRESETS = [
  ['Kafe', 'Mereka nongkrong di kafe'],
  ['Kelas', 'Mereka sekelas dan lagi istirahat di kelas'],
  ['Guild', 'Mereka berkumpul di markas guild'],
  ['Pantai', 'Mereka liburan bareng di pantai'],
  ['Asrama', 'Malam hari di asrama, semuanya belum mengantuk']
];

/* ---------- Util ---------- */
const hash = (str, seed = 0) => { // cyrb53
  let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
  for (let i = 0, c; i < str.length; i++) { c = str.charCodeAt(i); h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677); }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
};
const norm = s => String(s || '').trim().toLowerCase().replace(/\s+/g, '');
const ID_RE = /^[\w-]{1,64}$/;
const cleanLine = t => String(t == null ? '' : t).replace(/[\u0000-\u001f<>\[\]{}`]/g, ' ').replace(/\s+/g, ' ').trim();
// Warna bubble grup = hue warna terbanyak di avatar karakter (dihitung dari assets/*.jpg, warna kulit, abu-abu, hitam, dan putih diabaikan).
// Karakter baru yang belum ada di daftar ini jatuh ke hue acak dari id seperti sebelumnya.
const AVATAR_HUE = { aqua: 207, asa: 3, asuka: 24, ayumu: 203, darkness: 27, denji: 55, emilia: 266, furina: 218, gojo: 102, hutao: 9, iroha: 327, kafka: 325, kazuma: 23, kobeni: 40, kurumi: 355, makima: 356, megumin: 349, nagumo: 214, ram: 295, raphael: 204, rem: 208, ren: 235, reze: 6, rimuru: 38, shinobu: 251, subaru: 340, subaru1: 200, sukuna: 327, theherta: 248, tohka: 246, urabe: 34, yuuji: 4, zeta: 4 };
const hue = id => AVATAR_HUE[id] ?? hash(String(id)) % 360;
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const escRe = s => s.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&');
const STOP = ['the', 'and', 'dan', 'iff', 'gluttony'];
const tokens = name => [...new Set(String(name).replace(/\([^)]*\)/g, ' ').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(t => t.length >= 3 && !STOP.includes(t)))];
const charOf = id => allChars.find(c => c.id === id) || null;
const pseudo = id => ({ id, name: id.charAt(0).toUpperCase() + id.slice(1), avatar: '' });
const cOrP = id => charOf(id) || pseudo(id);
const firstName = c => String(c.name).replace(/\([^)]*\)/g, ' ').trim().split(/[\s/]+/)[0] || c.name;

const GX = window.GX = { cur: null, hash: s => hash(norm(s)), CFG };
const enabled = GX.enabled = () => store.get('gx') === '1';

/* ---------- Penyimpanan (localStorage perangkat ini) ---------- */
const normGroup = g => {
  if (!g || typeof g !== 'object' || typeof g.id !== 'string' || !ID_RE.test(g.id) || !Array.isArray(g.members)) return null;
  const members = [...new Set(g.members.filter(i => typeof i === 'string' && ID_RE.test(i)))].slice(0, CFG.MAX_MEMBERS);
  if (!members.length) return null;
  return {
    id: g.id, name: cleanLine(g.name).slice(0, 40) || 'Grup', members,
    muted: (Array.isArray(g.muted) ? g.muted : []).filter(i => members.includes(i)),
    scene: cleanLine(g.scene).slice(0, 120), createdAt: isNum(g.createdAt) ? g.createdAt : Date.now()
  };
};
let groups = (() => { try { const a = JSON.parse(store.get('groups') || '[]'); return (Array.isArray(a) ? a : []).map(normGroup).filter(Boolean).slice(0, CFG.MAX_GROUPS); } catch { return []; } })();
const saveGroups = () => store.set('groups', groups.length ? JSON.stringify(groups) : null);
const msgKey = id => 'g:' + id + ':msgs';
const loadMsgs = id => { try { const l = JSON.parse(store.get(msgKey(id)) || '[]'); return Array.isArray(l) ? l.filter(m => m && typeof m.from === 'string' && isNum(m.ts)) : []; } catch { return []; } };
const saveMsgs = (id, l) => store.set(msgKey(id), l.length ? JSON.stringify(l) : null);
function trimMsgs(l) {
  while (l.length > CFG.MSGMAX) { const o = l.shift(); keysOf(o).forEach(k => idb.del(k)); }
  let n = 0;
  for (let i = l.length - 1; i >= 0; i--) { const ks = keysOf(l[i]); if (!ks.length) continue; n += ks.length; if (n > CFG.AUDMAX) { ks.forEach(k => idb.del(k)); delete l[i].ks; } } // voice note lama: audio dibuang, teks tetap
}
const delAudio = l => l.forEach(m => keysOf(m).forEach(k => idb.del(k)));
const persist = st => { trimMsgs(st.msgs); saveMsgs(st.g.id, st.msgs); };
function patchMsg(gid, m, fn) { fn(m); const l = loadMsgs(gid), e = l.find(x => x.ts === m.ts && x.from === m.from); if (e) { fn(e); saveMsgs(gid, l); } }

let state = null; // { g, msgs, ctl, running, pending, tail } untuk grup yang lagi dibuka
// pending = balasan yang sudah jadi tapi belum tampil (menunggu voice note sebelumnya selesai); tail = promise "voice note terakhir selesai"

/* ---------- Notifikasi atas layar ---------- */
let noteEl = null, noteT = 0;
function notify(title, sub) {
  if (!noteEl) {
    noteEl = document.createElement('div'); noteEl.id = 'gnote'; noteEl.setAttribute('role', 'status');
    noteEl.innerHTML = '<svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.6-3.6 3.2-5.5 6.5-5.5s5.9 1.9 6.5 5.5M17 5.5a3.5 3.5 0 010 6.5M18.5 14.8c1.8.7 3 2.4 3.4 5.2"/></svg><div><b></b><span></span></div>';
    noteEl.onclick = () => noteEl.classList.remove('show');
    app.append(noteEl);
  }
  noteEl.querySelector('b').textContent = title; noteEl.querySelector('span').textContent = sub;
  void noteEl.offsetWidth; noteEl.classList.add('show');
  clearTimeout(noteT); noteT = setTimeout(() => noteEl.classList.remove('show'), 5200);
}

/* Pesan rahasia ke Reze: dicegat di browser, tidak dikirim ke server (jadi tidak memanggil ChatGPT maupun Fish Audio).
   Mengembalikan true kalau pesan itu kode rahasia; pemanggil (submit di index.html) lalu membuang pesannya: tidak jadi bubble, tidak dicatat. */
GX.trySecret = text => {
  if (!ch || ch.id !== 'reze' || hash(norm(text)) !== SECRET) return false;
  if (enabled()) notify('Fitur grup sudah terbuka', 'Buka Obrolan Terakhir → tab Grup → "Buat grup".');
  else {
    store.set('gx', '1');
    notify('Fitur rahasia terbuka', 'Chat grup aktif. Buka Obrolan Terakhir → tab Grup → "Buat grup".');
    renderList(); paintAll();
    if (window.Shell) Shell.syncTabs();
  }
  return true;
};

/* ---------- Avatar kolase ---------- */
function stack(g, cls) {
  const ids = g.members.slice(0, 4), d = document.createElement('div');
  d.className = (cls ? cls + ' ' : '') + 'gcol n' + Math.max(1, ids.length);
  ids.forEach(id => d.append(img(cOrP(id))));
  return d;
}

/* ---------- Menu utama: kartu grup + tombol "Buat grup" ---------- */
GX.entry = rid => {
  if (typeof rid !== 'string' || !rid.startsWith('g:')) return null;
  const g = groups.find(x => 'g:' + x.id === rid);
  return g ? { isGroup: true, id: rid, group: g } : null;
};
GX.card = e => {
  const g = e.group, b = document.createElement('button'); b.className = 'm-card'; b.type = 'button';
  b.innerHTML = '<span class="m-av"><i class="m-dot"></i></span><span class="m-info"><b></b><small class="gsmall"></small></span><span class="m-go"><svg viewBox="0 0 24 24"><path d="M4 12h16M14 6l6 6-6 6"/></svg></span>';
  const av = b.querySelector('.m-av'); av.prepend(stack(g));
  b.querySelector('b').textContent = g.name;
  b.querySelector('small').textContent = 'Grup · ' + g.members.map(i => firstName(cOrP(i))).join(', ');
  b.onclick = () => open(g, av);
  return b;
};
let newBtnEl = null;
GX.newBtn = () => {
  if (!newBtnEl) {
    newBtnEl = document.createElement('button'); newBtnEl.className = 'm-all'; newBtnEl.type = 'button';
    newBtnEl.innerHTML = '<svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.6-3.6 3.2-5.5 6.5-5.5s5.9 1.9 6.5 5.5M18 8v6M15 11h6"/></svg><span>Buat grup</span>';
    newBtnEl.onclick = () => openEditor(null);
  }
  return newBtnEl;
};
/* Grup tidak lagi tampil di Beranda (hanya di tab Grup pada Obrolan Terakhir). Dibiarkan ada karena index.html masih memanggilnya. */
function paintAll() {}
GX.paintAll = paintAll;

/* ---------- API untuk shell.js (daftar Obrolan Terakhir) ---------- */
GX.groups = () => groups.slice();
GX.avatar = g => stack(g, 'lp-gav'); // kolase avatar (46px lewat shell.css)
GX.preview = g => {
  const l = loadMsgs(g.id); let m = null;
  for (let i = l.length - 1; i >= 0; i--) { if (l[i].from !== 'system') { m = l[i]; break; } }
  if (!m) { m = l[l.length - 1]; if (!m) return { text: '', t: 0 }; }
  const who = m.from === 'user' ? 'Kamu: ' : m.from === 'system' ? '' : firstName(cOrP(m.from)) + ': ';
  const txt = (keysOf(m).length ? 'Voice note' : String(m.text == null ? '' : m.text).replace(/\*/g, '').replace(/\s+/g, ' ').trim()).slice(0, 120);
  return { text: who + txt, t: m.ts || 0 };
};
GX.openGroup = (g, el) => { if (window.Shell) Shell.enterChatTab(); open(g, el); };
GX.rename = (id, name) => {
  const g = groups.find(x => x.id === id); if (!g) return false;
  const n = cleanLine(name).slice(0, 40); if (!n) return false;
  g.name = n; saveGroups(); if (GX.cur === g) paintHeader(); renderList(); return true;
};
GX.remove = id => { const g = groups.find(x => x.id === id); if (g) removeGroup(g); };

/* ---------- Modal buat grup / atur anggota ---------- */
app.insertAdjacentHTML('beforeend', `
<div id="gmodal" class="gov hide"><div class="nbox sbox" role="dialog" aria-labelledby="gmtitle">
  <div class="shead"><h2 id="gmtitle">Buat grup</h2><button id="gmx" type="button" aria-label="Tutup"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>
  <p id="gmsub"></p>
  <div id="gmmeta">
    <label class="gl" for="gmname">Nama grup</label><input id="gmname" class="gin" maxlength="40" autocomplete="off" placeholder="Nama grup">
    <label class="gl" for="gmscene">Scene (opsional)</label><input id="gmscene" class="gin" maxlength="120" autocomplete="off" placeholder="mis. Mereka nongkrong di kafe guild">
    <div class="gchips" id="gmchips"></div>
  </div>
  <span class="gl">Anggota <span id="gmcnt"></span></span>
  <label class="srch gsrch"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/></svg><input id="gmq" type="search" placeholder="Cari karakter" autocomplete="off"></label>
  <div class="gpick" id="gmlist"></div>
  <p id="gmerr" class="gerr" role="alert"></p>
  <div class="nact"><button id="gmcancel" type="button">Batal</button><button id="gmok" type="button" class="gprim">Buat grup</button></div>
</div></div>
<div id="gpanel" class="gov hide"><div class="nbox sbox" role="dialog" aria-labelledby="gptitle">
  <div class="shead"><h2 id="gptitle">Panel grup</h2><button id="gpx" type="button" aria-label="Tutup"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>
  <div class="sgroup"><h3>Grup</h3>
    <input id="gpname" class="gin" maxlength="40" autocomplete="off" placeholder="Nama grup" aria-label="Nama grup">
    <input id="gpscene" class="gin" maxlength="120" autocomplete="off" placeholder="Scene (opsional)" aria-label="Scene">
    <div class="gchips" id="gpchips"></div>
  </div>
  <div class="sgroup"><h3>Anggota <span id="gpmc"></span></h3>
    <div id="gpmem"></div>
    <button class="srow" id="gpedit" type="button"><span><b>Tambah / keluarkan anggota</b><i>Pesan lama tetap tampil dengan nama dan avatar aslinya.</i></span><svg viewBox="0 0 24 24"><path d="M9 5l7 7-7 7"/></svg></button>
  </div>
  <div class="sgroup"><h3>Obrolan</h3>
    <button class="srow" id="gptalk" type="button"><span><b>Biarkan mereka ngobrol</b><i>Anggota saling bicara tanpa pesanmu, maksimal ${CFG.AUTO_CHAIN} giliran.</i></span><svg viewBox="0 0 24 24"><path d="M9 5l7 7-7 7"/></svg></button>
    <button class="srow danger" id="gpclr" type="button"><span><b>Hapus obrolan grup</b><i>Grupnya tetap ada, hanya pesannya yang dihapus.</i></span></button>
    <button class="srow danger" id="gpdel" type="button"><span><b>Hapus grup</b><i>Grup dan seluruh obrolannya dihapus dari perangkat ini.</i></span></button>
  </div>
</div></div>`);
const gm = $('gmodal'), gp = $('gpanel');
let ed = null; // { g, sel:Set } state modal

function chips(box, input) {
  box.innerHTML = '';
  PRESETS.forEach(([label, text]) => {
    const b = document.createElement('button'); b.type = 'button'; b.textContent = label;
    b.onclick = () => { input.value = text; input.dispatchEvent(new Event('input')); };
    box.append(b);
  });
}
const defaultName = ids => {
  const n = ids.map(i => firstName(cOrP(i)));
  return n.length < 2 ? (n[0] || '') : n.length === 2 ? n.join(' & ') : n.slice(0, -1).join(', ') + ' & ' + n[n.length - 1];
};
function syncPick() {
  const n = ed.sel.size;
  $('gmcnt').textContent = '(' + n + '/' + CFG.MAX_MEMBERS + ')';
  gm.querySelectorAll('#gmlist input').forEach(cb => { cb.disabled = !cb.checked && n >= CFG.MAX_MEMBERS; });
  if (!ed.g) $('gmname').placeholder = defaultName([...ed.sel]) || 'Nama grup';
  $('gmerr').textContent = '';
}
function filterPick() {
  const k = $('gmq').value.trim().toLowerCase();
  gm.querySelectorAll('#gmlist .gpr').forEach(l => l.classList.toggle('hide', !!k && !l.dataset.q.includes(k)));
}
function openEditor(g) {
  if (!enabled()) return;
  ed = { g: g || null, sel: new Set(g ? g.members.filter(charOf) : []) };
  const edit = !!g, full = !edit && groups.length >= CFG.MAX_GROUPS;
  $('gmtitle').textContent = edit ? 'Anggota grup' : 'Buat grup';
  $('gmsub').textContent = 'Pilih ' + CFG.MIN_MEMBERS + '–' + CFG.MAX_MEMBERS + ' karakter yang ada di grup.';
  $('gmmeta').classList.toggle('hide', edit);
  $('gmok').textContent = edit ? 'Simpan' : 'Buat grup'; $('gmok').disabled = full;
  $('gmname').value = ''; $('gmscene').value = ''; $('gmq').value = '';
  chips($('gmchips'), $('gmscene'));
  const box = $('gmlist'); box.innerHTML = '';
  allChars.forEach(c => {
    const lab = document.createElement('label'); lab.className = 'gpr'; lab.dataset.q = (c.name + ' ' + (c.tagline || '')).toLowerCase();
    lab.innerHTML = '<span><b></b><small></small></span><input type="checkbox">';
    lab.prepend(img(c)); lab.querySelector('b').textContent = c.name; lab.querySelector('small').textContent = c.tagline || '';
    const cb = lab.querySelector('input'); cb.checked = ed.sel.has(c.id);
    cb.onchange = () => { cb.checked ? ed.sel.add(c.id) : ed.sel.delete(c.id); syncPick(); };
    box.append(lab);
  });
  syncPick();
  if (full) $('gmerr').textContent = 'Maksimal ' + CFG.MAX_GROUPS + ' grup. Hapus salah satu dulu.';
  gm.classList.remove('hide');
}
const closeEditor = () => { gm.classList.add('hide'); ed = null; };
$('gmx').onclick = $('gmcancel').onclick = closeEditor;
gm.addEventListener('click', e => { if (e.target === gm) closeEditor(); });
$('gmq').addEventListener('input', filterPick);
$('gmok').onclick = () => {
  if (!ed) return;
  const n = ed.sel.size;
  if (n < CFG.MIN_MEMBERS || n > CFG.MAX_MEMBERS) {
    $('gmerr').textContent = n < CFG.MIN_MEMBERS ? 'Pilih minimal ' + CFG.MIN_MEMBERS + ' karakter.' : 'Maksimal ' + CFG.MAX_MEMBERS + ' karakter.';
    return;
  }
  if (ed.g) { // atur anggota grup yang sudah ada
    const g = ed.g, old = g.members, ids = [...old.filter(i => ed.sel.has(i)), ...[...ed.sel].filter(i => !old.includes(i))];
    const added = ids.filter(i => !old.includes(i)), removed = old.filter(i => !ids.includes(i));
    closeEditor();
    if (!added.length && !removed.length) return;
    g.members = ids; g.muted = (g.muted || []).filter(i => ids.includes(i)); saveGroups();
    removed.forEach(i => sysAdd(cOrP(i).name + ' keluar dari grup'));
    added.forEach(i => sysAdd(cOrP(i).name + ' ditambahkan ke grup'));
    paintHeader(); paintPanel(); renderList(); paintAll();
    return;
  }
  const ids = [...ed.sel];
  const g = { id: newId(), name: cleanLine($('gmname').value).slice(0, 40) || defaultName(ids), members: ids, muted: [], scene: cleanLine($('gmscene').value).slice(0, 120), createdAt: Date.now() };
  groups.unshift(g); saveGroups();
  const r = $('gmok').getBoundingClientRect(); // titik awal animasi buka chat
  closeEditor(); renderList(); paintAll();
  open(g, { getBoundingClientRect: () => r });
};

/* ---------- Layar chat grup ---------- */
const gmore = document.createElement('button');
gmore.id = 'gmore'; gmore.type = 'button'; gmore.className = 'hide'; gmore.title = 'Panel grup'; gmore.setAttribute('aria-label', 'Panel grup'); gmore.setAttribute('aria-haspopup', 'dialog');
gmore.innerHTML = '<svg viewBox="0 0 24 24"><circle cx="12" cy="5" r="1.9"/><circle cx="12" cy="12" r="1.9"/><circle cx="12" cy="19" r="1.9"/></svg>';
$('vmore').after(gmore);

const baseStatus = () => { if (GX.cur) setStatus(GX.cur.members.length + ' anggota', false); };
const paintHeader = () => {
  const g = GX.cur; if (!g) return;
  $('hname').textContent = g.name; $('hpfp').replaceWith(Object.assign(stack(g, 'pfp'), { id: 'hpfp' })); baseStatus();
};

function open(g, avEl) {
  if (moving) return;
  const was = app.classList.contains('open');
  if (was && GX.cur === g) return; // sudah terbuka
  if (window.Shell) Shell.enterChatTab();
  const inline = isDesk(); // desktop: tanpa animasi lingkaran
  if (was) { // GANTI instan (daftar -> grup lain / dari chat karakter)
    closeSearch(); closePicker();
    if (GX.cur) GX.onClose(); // simpan draft grup, hentikan rantai
    else if (ch) store.set('draft:' + ch.id, inp.value.trim() ? inp.value : null);
  } else if (!inline) { moving = true; setTimeout(() => moving = false, DUR); }
  ch = null; GX.cur = g; state = { g, msgs: [], ctl: null, running: false, pending: [], tail: null };
  closeSearch(); if (current) current.stop(); openSub = null; urls.forEach(u => URL.revokeObjectURL(u)); urls = []; clearTimeout(clrT); clrT = 0;
  chat.innerHTML = ''; lastDay = ''; ready = false; const tok = ++openTok;
  clearTimeout(draftT); inp.value = store.get('draft:g:' + g.id) || ''; grow(); refresh();
  inp.placeholder = 'Pesan ke grup (@ untuk mention)';
  $('vmore').classList.add('hide'); gmore.classList.remove('hide');
  paintHeader();
  if (!was && !inline) {
    const a = app.getBoundingClientRect(), r = avEl && avEl.getBoundingClientRect ? avEl.getBoundingClientRect() : null;
    if (r) { ox = r.left + r.width / 2 - a.left; oy = r.top + r.height / 2 - a.top; } else { ox = a.width / 2; oy = a.height / 2; }
  }
  touchRecent('g:' + g.id); setTimeout(renderList, was || inline ? 0 : DUR);
  app.classList.add('open'); menu.classList.add('away'); restore(g, tok);
  if (!was && !inline) view.animate({ clipPath: [circle(0), circle(reach())] }, { duration: DUR, easing: 'cubic-bezier(.7,0,.2,1)' });
  else if (!was) view.animate({ opacity: [0, 1] }, { duration: 180, easing: 'ease-out' });
  if (window.Shell) Shell.afterOpen(null); // sembunyikan #dtoggle, tutup panel detail, sinkron daftar
  setTimeout(() => { if (app.classList.contains('open') && GX.cur === g) inp.focus({ preventScroll: true }); }, was || inline ? 60 : DUR);
}

async function restore(g, tok) {
  if (tok !== openTok || GX.cur !== g) return;
  const st = state, msgs = loadMsgs(g.id); st.msgs = msgs;
  const recs = await Promise.all(msgs.map(m => Promise.all(keysOf(m).map(k => idb.get(k)))));
  if (tok !== openTok || GX.cur !== g || state !== st) return; // sudah pindah layar
  restoring = true;
  try { msgs.forEach((m, i) => render(m, recs[i])); } catch {}
  restoring = false;
  if (!msgs.length) { ensureDay(Date.now()); emptyHint(); }
  ready = true; chat.scrollTop = chat.scrollHeight; updDown();
}

function emptyHint() {
  const d = document.createElement('div'); d.className = 'gempty';
  d.innerHTML = '<div>Grup siap. Kirim pesan, atau ketik @ untuk menunjuk siapa yang menjawab.</div><button type="button">Biarkan mereka ngobrol</button>';
  d.querySelector('button').onclick = autoChat;
  chat.append(d);
}
const dropHint = () => { const h = chat.querySelector('.gempty'); if (h) h.remove(); };

function render(m, recs) {
  if (m.from === 'user') addText(m.text, m.ts);
  else if (m.from === 'system') sysLine(m.text, m.ts);
  else {
    const ks = keysOf(m), takes = [];
    (recs || []).forEach((a, j) => { if (a && a.ab) { const u = URL.createObjectURL(new Blob([a.ab], { type: 'audio/mpeg' })); urls.push(u); takes.push({ url: u, dur: a.dur, bins: a.bins, k: ks[j] }); } });
    if (m.vn && takes.length) vnBubble(m, takes); else bubble(m); // audio sudah dibuang -> tampil sebagai teks
  }
}
function sysLine(text, t) {
  ensureDay(t || Date.now());
  const d = document.createElement('div'); d.className = 'gsys'; d.textContent = text; chat.append(d); scroll();
}
function sysAdd(text) {
  if (!state) return;
  const m = { from: 'system', text, ts: Date.now() }; state.msgs.push(m); persist(state); sysLine(text, m.ts);
}
function errLine(text) {
  const d = document.createElement('div'); d.className = 'gsys err'; d.textContent = text; chat.append(d); scroll();
}

// bubble teks biasa (voice mati, suara gagal dibuat, atau audio lama sudah dibuang)
function bubble(m) {
  const t = m.ts || Date.now(); ensureDay(t);
  const c = cOrP(m.from), row = document.createElement('div');
  row.className = 'row them grow' + (restoring ? ' rs' : ''); row.dataset.from = m.from; row.style.setProperty('--h', hue(m.from));
  row.innerHTML = '<div class="bub"><div class="gname"></div><div class="txt"></div><div class="ts">' + now(t) + '</div></div>';
  row.prepend(img(c, 'gav'));
  row.querySelector('.gname').textContent = c.name;
  row.querySelector('.txt').textContent = m.text;
  chat.append(row); scroll();
}

// voice note: pakai pemutar yang sama persis dengan chat biasa (addVN di index.html): waveform, progres, subtitle, kecepatan, versi, download.
// `done` selesai (true) kalau voice note habis diputar, (false) kalau dijeda / diganti yang lain.
function vnBubble(m, takes) {
  const c = cOrP(m.from), gid = state.g.id;
  let fin; const done = new Promise(r => fin = r);
  const row = addVN({ id: m.text, jp: m.jp, lang: m.lang, vn: m.vn, si: m.si || 0 }, takes, m.ts, {
    owner: m.from, gid, name: c.name, char: c, hue: hue(m.from),
    onStop: ended => fin(!!ended),
    persist: (ks, si) => patchMsg(gid, m, e => { e.ks = ks; e.si = si; })
  });
  return { row, done };
}

// indikator sebelum bubble muncul: titik (berpikir) lalu mic + bar (sedang merekam suara / menunggu giliran)
function typingRow(id) {
  const c = cOrP(id), row = document.createElement('div');
  row.className = 'row them grow typ'; row.style.setProperty('--h', hue(id));
  row.innerHTML = '<div class="bub"><div class="gname"></div><div class="typing-b"><i></i><i></i><i></i></div></div>';
  row.prepend(img(c, 'gav')); row.querySelector('.gname').textContent = c.name;
  chat.append(row); scroll(); setStatus((String(c.name || '').replace(/\([^)]*\)/g, ' ').trim().split(/\s+/)[0] || c.name) + ' sedang mengetik…', true);
  return row;
}
function recRow(row, id) {
  const tb = row.querySelector('.typing-b'); if (!tb) return;
  const rec = document.createElement('div'); rec.className = 'rec-b';
  rec.innerHTML = '<svg viewBox="0 0 24 24"><path d="M9 3h6v10a3 3 0 01-6 0zM5 11a7 7 0 0014 0M12 18v3"/></svg><div class="bars">' + '<i></i>'.repeat(14) + '</div>';
  rec.querySelectorAll('.bars i').forEach((b, i) => b.style.animationDelay = (i * 0.07) + 's');
  tb.replaceWith(rec); scroll(); setStatus(cOrP(id).name + ' merekam suara…', true);
}
const badCode = () => { vcode = ''; voiceOn = false; store.set('vcode', null); store.set('von', '0'); paintVoice(); toast('Kode voice tidak valid, voice dimatikan'); };

/* ---------- Mesin giliran ---------- */
function activeIds(g) { return g.members.filter(i => charOf(i) && !(g.muted || []).includes(i)); }
function mentions(g, text) {
  const low = text.toLowerCase(), hits = [];
  g.members.forEach(id => {
    const c = charOf(id); if (!c) return;
    const words = new Set([id.toLowerCase(), String(c.name).toLowerCase().replace(/\s*\([^)]*\)\s*/g, ' ').trim(), ...tokens(c.name)]);
    let best = -1;
    words.forEach(w => {
      if (!w) return;
      const m = new RegExp('(^|[^\\p{L}\\p{N}_])@?' + escRe(w) + '(?![\\p{L}\\p{N}_])', 'iu').exec(low);
      if (m) { const pos = m.index + m[1].length; if (best < 0 || pos < best) best = pos; }
    });
    if (best >= 0) hits.push([best, id]);
  });
  return hits.sort((a, b) => a[0] - b[0]).map(h => h[1]);
}
// acak berbobot: anggota yang sudah lama diam bobotnya lebih besar
function weighted(ids) {
  const msgs = state.msgs.filter(m => m.from !== 'system');
  const w = ids.map(id => {
    let since = 8;
    for (let i = msgs.length - 1, k = 0; i >= 0 && k < 8; i--, k++) if (msgs[i].from === id) { since = k; break; }
    return 1 + since;
  });
  let r = Math.random() * w.reduce((a, b) => a + b, 0);
  for (let i = 0; i < ids.length; i++) { r -= w[i]; if (r <= 0) return ids[i]; }
  return ids[ids.length - 1];
}
function pickFirst(g, text) {
  const act = activeIds(g), ment = mentions(g, text).filter(i => act.includes(i)); // yang dibisukan tidak ikut
  return ment.length ? ment : [weighted(act)];
}

function abortChain() {
  if (state && state.ctl) { state.ctl.abort(); state.ctl = null; state.running = false; }
  if (state) state.pending = [];
  chat.querySelectorAll('.row.typ').forEach(r => r.remove());
  baseStatus();
}

async function callChat(g, sp, { userText, replyTo, depth, ctl }) {
  const useVoice = voiceOn && !!vcode, lang = voiceLang;
  // balasan yang sudah jadi tapi belum tampil tetap ikut jadi konteks, supaya karakter berikutnya nyambung
  const history = [...state.msgs, ...state.pending].filter(m => m.from !== 'system').slice(-CFG.HIST).map(m => [m.from, String(m.text).slice(0, 600)]);
  const body = {
    clientId: cid, char: sp, message: userText || '', userName: uname, history,
    group: { members: g.members.filter(charOf), muted: g.muted || [], scene: g.scene || '', ...(replyTo && { replyTo }), depth },
    voice: { on: useVoice, lang }
  };
  const r = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctl.signal });
  if (!r.ok) { const j = await r.json().catch(() => ({})); const e = new Error(j.error || 'Gagal terhubung'); e.status = r.status; throw e; }
  return { ...(await r.json()), lang };
}

const aborted = ctl => new Promise(r => { if (ctl.signal.aborted) r(null); else ctl.signal.addEventListener('abort', () => r(null), { once: true }); });

// Tahap 1: satu karakter berpikir (ChatGPT), lalu kalau voice nyala suaranya langsung dibuat (Fish Audio). Belum ditampilkan.
// Tahap ini boleh jalan sementara voice note karakter sebelumnya masih diputar.
async function compose(st, sp, opts) {
  const { ctl } = opts, c = charOf(sp);
  if (!c) return { ok: false };
  const row = typingRow(sp), t0 = Date.now();
  try {
    const r = await callChat(st.g, sp, opts);
    const text = String(r.id || '').trim();
    if (!text) throw new Error('Balasan kosong');
    const m = { from: sp, text, ts: 0 };
    let take = null;
    if (voiceOn && vcode && r.vn) {
      m.vn = r.vn; m.jp = r.jpText || ''; m.lang = r.lang;
      recRow(row, sp);
      try {
        const ab = await (await post('/api/tts', { char: sp, text: r.vn, voice: voiceKeyOf(sp) }, { 'x-voice-code': vcode })).arrayBuffer();
        const p = await decode(ab); urls.push(p.url); take = { ...p, ab };
      } catch (e) {
        delete m.vn; delete m.jp; delete m.lang; // suara gagal -> teksnya tetap tampil
        if (e.status === 403) badCode(); else if (!ctl.signal.aborted) toast(e.message || 'Suara gagal dibuat');
      }
    } else {
      const min = Math.min(1800, 800 + text.length * 14), el = Date.now() - t0; // jeda 0,8-1,8 dtk sebanding panjang teks, biar terasa hidup
      if (el < min) await wait(min - el);
    }
    if (ctl.signal.aborted || state !== st) { row.remove(); return { ok: false }; }
    st.pending.push(m);
    return { ok: true, text, next: typeof r.next === 'string' ? r.next : null, m, take, row };
  } catch (e) {
    row.remove();
    if (ctl.signal.aborted || e.name === 'AbortError' || state !== st) return { ok: false };
    errLine(c.name + ': ' + (e.message || 'gagal membalas')); // rantai berhenti, pesan yang sudah ada tetap tersimpan
    baseStatus();
    return { ok: false };
  }
}

// Tahap 2: tunggu voice note sebelumnya selesai, baru tampilkan bubble ini dan putar otomatis.
// Mengembalikan promise yang selesai saat voice note ini selesai diputar, jadi bisa dirantai (st.tail).
async function reveal(st, res, prev, ctl, shown) {
  try {
    const ended = await Promise.race([prev, aborted(ctl)]); // false = sebelumnya dijeda user, jangan putar otomatis
    res.row.remove();
    if (ctl.signal.aborted || state !== st) return null;
    const m = res.m; m.ts = Date.now();
    st.pending = st.pending.filter(x => x !== m);
    const gid = st.g.id;
    if (!chat.querySelector('.row.typ')) baseStatus();
    st.msgs.push(m); persist(st);
    if (!res.take) { bubble(m); shown(); return true; }
    const p = res.take, v = vnBubble(m, [p]);
    shown(); // bubble sudah tampil: karakter berikutnya boleh mulai mikir selagi voice note ini diputar
    const k = newKey(); // audio disimpan lokal (IndexedDB) supaya voice note bisa diputar lagi nanti
    idb.put(k, { ab: p.ab, dur: p.dur, bins: p.bins }).then(ok => { if (ok) { p.k = k; patchMsg(gid, m, e => { e.ks = [k]; e.si = 0; }); } });
    if (ended === false) return false;
    v.row._vn.play(true);
    return await v.done;
  } finally { shown(); }
}

async function runChain(g, { userText, first, max }) {
  const st = state, ctl = new AbortController(), counts = {};
  st.ctl = ctl; st.running = true;
  st.tail = (st.tail || Promise.resolve(true)).then(v => v === false ? true : v); // rantai baru: kalau user menjeda tadi, balasan baru tetap boleh putar otomatis
  let depth = 0, nextId = null, replyTo = null, shownPrev = Promise.resolve();
  const queue = [...first];
  try {
    while (depth < max && !ctl.signal.aborted && state === st) {
      let sp;
      if (queue.length) { sp = queue.shift(); replyTo = null; } // yang disebut user: berurutan, tidak kena ACCEPT
      else if (nextId) { sp = nextId; nextId = null; }
      else break;
      if (!activeIds(g).includes(sp)) continue;
      await Promise.race([shownPrev, aborted(ctl)]); // karakter berikutnya mulai mikir setelah yang sebelumnya tampil (tidak numpuk indikator)
      if (ctl.signal.aborted || state !== st) break;
      const r = await compose(st, sp, { userText, replyTo, depth, ctl });
      if (!r.ok) break;
      let shown; shownPrev = new Promise(res => shown = res);
      st.tail = reveal(st, r, st.tail || Promise.resolve(true), ctl, shown); // antre: tampil + putar setelah voice note sebelumnya selesai
      depth++; counts[sp] = (counts[sp] || 0) + 1;
      if (queue.length) continue;
      const nx = r.next;
      const accept = nx && activeIds(g).includes(nx) && (counts[nx] || 0) < CFG.MAX_PER_CHAR && depth < max && Math.random() < (CFG.ACCEPT[depth - 1] ?? 0);
      if (!accept) break;
      nextId = nx; replyTo = { from: sp, text: r.text };
    }
    if (!ctl.signal.aborted && state === st && st.tail) await Promise.race([st.tail, aborted(ctl)]); // tunggu bubble terakhir tampil dan selesai diputar
  } finally {
    if (st.ctl === ctl) { st.ctl = null; st.running = false; if (state === st) baseStatus(); }
  }
}

function allMuted() { toast('Semua anggota dibisukan. Nyalakan lagi lewat panel grup.'); }

GX.submit = async () => {
  const g = GX.cur, text = inp.value.trim();
  if (mention.open) { pickMention(mention.items[mention.sel]); return; }
  if (!g || !ready || !text) { inp.classList.remove('shake'); void inp.offsetWidth; inp.classList.add('shake'); return; }
  abortChain(); // pesan baru membatalkan rantai lama; balasan yang sudah tampil tetap ada
  dropHint(); hideMention();
  inp.value = ''; grow(); refresh(); clearTimeout(gdraft); store.set('draft:g:' + g.id, null);
  const m = { from: 'user', text, ts: Date.now() };
  state.msgs.push(m); persist(state); addText(text, m.ts);
  if (!activeIds(g).length) { allMuted(); return; }
  runChain(g, { userText: text, first: pickFirst(g, text), max: CFG.MAX_CHAIN });
};
function autoChat() {
  const g = GX.cur; if (!g || !ready) return;
  const act = activeIds(g); if (!act.length) { allMuted(); return; }
  abortChain(); dropHint();
  runChain(g, { userText: '', first: [weighted(act)], max: CFG.AUTO_CHAIN });
}

/* ---------- Autocomplete @ ---------- */
const mentionEl = document.createElement('div');
mentionEl.id = 'gmention'; mentionEl.className = 'hide'; mentionEl.setAttribute('role', 'listbox');
document.querySelector('footer').append(mentionEl);
const mention = { open: false, items: [], sel: 0, start: 0 };
const handleOf = (g, c) => {
  const f = firstName(c).toLowerCase();
  const same = g.members.map(charOf).filter(Boolean).filter(x => firstName(x).toLowerCase() === f || tokens(x.name).includes(f));
  return same.length > 1 ? c.id : firstName(c);
};
function hideMention() { mention.open = false; mentionEl.classList.add('hide'); }
function paintMention() {
  mentionEl.innerHTML = '';
  mention.items.forEach((c, i) => {
    const b = document.createElement('button'); b.type = 'button'; b.className = i === mention.sel ? 'sel' : ''; b.setAttribute('role', 'option');
    b.innerHTML = '<b></b><small></small>'; b.prepend(img(c));
    b.querySelector('b').textContent = c.name; b.querySelector('small').textContent = (GX.cur.muted || []).includes(c.id) ? 'dibisukan' : (c.tagline || '');
    b.onpointerdown = e => e.preventDefault(); // jangan menutup keyboard
    b.onclick = () => pickMention(c);
    mentionEl.append(b);
  });
  mentionEl.classList.remove('hide');
  const sel = mentionEl.querySelector('.sel'); if (sel) sel.scrollIntoView({ block: 'nearest' });
}
function mentionCheck() {
  const g = GX.cur; if (!g) { hideMention(); return; }
  const pos = inp.selectionStart == null ? inp.value.length : inp.selectionStart, before = inp.value.slice(0, pos);
  const m = before.match(/(^|\s)@([\p{L}\p{N}_-]{0,20})$/u);
  if (!m) { hideMention(); return; }
  const q = m[2].toLowerCase();
  const items = g.members.map(charOf).filter(Boolean).filter(c => !q || c.id.toLowerCase().startsWith(q) || tokens(c.name).some(t => t.startsWith(q)));
  if (!items.length) { hideMention(); return; }
  Object.assign(mention, { open: true, items, sel: 0, start: pos - q.length - 1 });
  paintMention();
}
function pickMention(c) {
  const g = GX.cur; if (!g || !c) { hideMention(); return; }
  const end = inp.selectionStart == null ? inp.value.length : inp.selectionStart, ins = '@' + handleOf(g, c) + ' ';
  inp.value = inp.value.slice(0, mention.start) + ins + inp.value.slice(end);
  const p = mention.start + ins.length; inp.setSelectionRange(p, p);
  hideMention(); grow(); refresh(); inp.focus({ preventScroll: true });
}
let gdraft = 0;
inp.addEventListener('input', () => {
  if (!GX.cur) return;
  clearTimeout(gdraft); const id = GX.cur.id, v = inp.value; gdraft = setTimeout(() => store.set('draft:g:' + id, v.trim() ? v : null), 250);
  mentionCheck();
});
inp.addEventListener('click', () => { if (GX.cur) mentionCheck(); });
inp.addEventListener('blur', () => setTimeout(hideMention, 150));
inp.addEventListener('keydown', e => {
  if (!GX.cur || !mention.open) return;
  const k = e.key, n = mention.items.length;
  if (k === 'ArrowDown' || k === 'ArrowUp') { mention.sel = (mention.sel + (k === 'ArrowDown' ? 1 : n - 1)) % n; paintMention(); }
  else if (k === 'Enter' || k === 'Tab') pickMention(mention.items[mention.sel]);
  else if (k === 'Escape') hideMention();
  else return;
  e.preventDefault(); e.stopImmediatePropagation();
}, true);

/* ---------- Panel grup (titik tiga di header) ---------- */
function twoTap(btn, fn) {
  const b0 = btn.querySelector('b'), orig = b0.textContent; let t = 0;
  btn.onclick = () => {
    if (!t) { b0.textContent = 'Tap lagi untuk konfirmasi'; t = setTimeout(() => { t = 0; b0.textContent = orig; }, 2500); return; }
    clearTimeout(t); t = 0; b0.textContent = orig; fn();
  };
}
function paintPanel() {
  const g = GX.cur; if (!g) return;
  $('gpname').value = g.name; $('gpscene').value = g.scene || '';
  $('gpmc').textContent = '(' + g.members.length + '/' + CFG.MAX_MEMBERS + ')';
  const box = $('gpmem'); box.innerHTML = '';
  g.members.forEach(id => {
    const c = charOf(id), d = document.createElement('div'); d.className = 'gmem' + (c ? '' : ' miss');
    d.innerHTML = '<span class="gmn"><b></b></span><label class="gmute"><span>Bisukan</span><input type="checkbox" class="sw"></label>';
    d.prepend(img(cOrP(id)));
    d.querySelector('b').textContent = c ? c.name : 'Karakter hilang (' + id + ')';
    const vs = c ? charVoices(id) : [];
    if (vs.length > 1) { // pilihan suara per karakter (sama dengan pemilih suara di chat biasa: vv:<charId>)
      const sel = document.createElement('select'); sel.className = 'gsel'; sel.setAttribute('aria-label', 'Suara ' + c.name);
      vs.forEach(v => { const o = document.createElement('option'); o.value = v.key; o.textContent = 'Suara: ' + v.label; sel.append(o); });
      sel.value = voiceKeyOf(id);
      sel.onchange = () => { store.set('vv:' + id, sel.value); toast('Suara ' + c.name + ': ' + (vs.find(v => v.key === sel.value) || {}).label); };
      d.querySelector('.gmn').append(sel);
    }
    const cb = d.querySelector('input'); cb.checked = (g.muted || []).includes(id); cb.disabled = !c; cb.setAttribute('aria-label', 'Bisukan ' + (c ? c.name : id));
    cb.onchange = () => { g.muted = (g.muted || []).filter(x => x !== id); if (cb.checked) g.muted.push(id); saveGroups(); };
    box.append(d);
  });
}
function openPanel() {
  if (!GX.cur) return;
  hideMention(); chips($('gpchips'), $('gpscene')); paintPanel(); gp.classList.remove('hide');
}
function closePanel() {
  if (gp.classList.contains('hide')) return;
  gp.classList.add('hide');
  const g = GX.cur; if (!g) return;
  const nm = cleanLine($('gpname').value).slice(0, 40) || g.name, sc = cleanLine($('gpscene').value).slice(0, 120);
  if (nm !== g.name) { g.name = nm; paintHeader(); }
  if (sc !== (g.scene || '')) { g.scene = sc; sysAdd(sc ? 'Scene diubah: ' + sc : 'Scene dihapus'); } // berlaku mulai giliran berikutnya
  saveGroups(); renderList(); paintAll();
}
gmore.onclick = openPanel;
$('gpx').onclick = closePanel;
gp.addEventListener('click', e => { if (e.target === gp) closePanel(); });
$('gpedit').onclick = () => { if (GX.cur) openEditor(GX.cur); };
$('gptalk').onclick = () => { closePanel(); autoChat(); };

function clearMsgs() {
  const g = GX.cur; if (!g) return;
  abortChain(); if (current) current.stop(); openSub = null;
  delAudio(state.msgs); state.msgs = []; saveMsgs(g.id, []);
  urls.forEach(u => URL.revokeObjectURL(u)); urls = [];
  chat.innerHTML = ''; lastDay = ''; ensureDay(Date.now()); emptyHint();
}
twoTap($('gpclr'), () => { closePanel(); clearMsgs(); toast('Obrolan grup dihapus'); });
/* hapus grup: dipakai tombol "Hapus grup" di panel dan GX.remove (menu titik tiga di daftar) */
function removeGroup(g) {
  const cur = GX.cur === g, msgs = cur && state ? state.msgs : loadMsgs(g.id);
  if (cur) { gp.classList.add('hide'); abortChain(); inp.value = ''; clearTimeout(gdraft); } // supaya draft grup yang dihapus tidak tersimpan lagi lewat GX.onClose
  delAudio(msgs);
  store.set(msgKey(g.id), null); store.set('draft:g:' + g.id, null); store.set('pos:g:' + g.id, null);
  groups = groups.filter(x => x !== g); saveGroups();
  recent = recent.filter(x => x !== 'g:' + g.id); store.set('recent', JSON.stringify(recent));
  if (cur) closeChat();
  renderList(); paintAll();
}
twoTap($('gpdel'), () => { const g = GX.cur; if (g) removeGroup(g); });

/* header: hapus obrolan (2x tap) */
GX.clear = () => {
  const g = GX.cur; if (!g || !ready) return;
  if (!clrT) { toast('Tap lagi untuk hapus obrolan grup ini'); clrT = setTimeout(() => clrT = 0, 2500); return; }
  clearTimeout(clrT); clrT = 0; clearMsgs(); toast('Obrolan grup dihapus');
};

/* ---------- Ekspor / impor ---------- */
let gexp = false;
GX.exportChat = async () => {
  const g = GX.cur; if (!g || !ready || gexp) return;
  if (!state.msgs.length) { toast('Belum ada obrolan untuk diekspor'); return; }
  gexp = true; toast('Menyiapkan ekspor…');
  try {
    const me = uname || 'Kamu', files = [], out = [];
    const stamp = t => new Date(t).toLocaleDateString('id-ID', { day: '2-digit', month: '2-digit', year: 'numeric' }) + ' ' + now(t);
    const body = x => String(x || '').replace(/\n/g, '\n    ');
    out.push('Obrolan grup: ' + g.name, 'Anggota: ' + g.members.map(i => cOrP(i).name).join(', '));
    if (g.scene) out.push('Scene: ' + g.scene);
    out.push('Diekspor: ' + stamp(Date.now()), '');
    let n = 0;
    for (const m of state.msgs) {
      const head = '[' + stamp(m.ts) + '] ';
      if (m.from === 'system') { out.push(head + '* ' + body(m.text)); continue; }
      const who = m.from === 'user' ? me : cOrP(m.from).name;
      if (!m.vn) { out.push(head + who + ': ' + body(m.text)); continue; }
      const ks = keysOf(m), names = [], base = 'vn-' + String(++n).padStart(3, '0') + '-' + safeName(who);
      for (let j = 0; j < ks.length; j++) { const a = await idb.get(ks[j]); if (a && a.ab) { const nm = base + (j ? '-v' + (j + 1) : '') + '.mp3'; files.push({ name: nm, data: new Uint8Array(a.ab) }); names.push(nm); } }
      out.push(head + who + ': [Voice note] ' + (names.length ? '(' + names.join(', ') + ')' : '(audio belum dibuat atau tidak tersimpan)'));
      if (m.text) out.push('    Indonesia: ' + body(m.text));
      if (m.jp) out.push('    Jepang: ' + body(m.jp));
    }
    const txt = out.join('\n') + '\n', d = new Date();
    const base = safeName(g.name) + '-' + d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
    if (files.length) saveBlob(makeZip([{ name: 'chat.txt', data: new TextEncoder().encode(txt) }, ...files]), base + '.zip');
    else saveBlob(new Blob([txt], { type: 'text/plain;charset=utf-8' }), base + '.txt');
    toast(files.length ? 'Diekspor: chat + ' + files.length + ' audio (.zip)' : 'Obrolan diekspor (.txt)');
  } catch { toast('Gagal ekspor obrolan'); }
  gexp = false;
};

// cadangan lengkap (Pengaturan > Ekspor semua): grup + pesan + audio yang sudah dibuat
GX.exportData = async () => {
  const out = []; let nAud = 0, nMsg = 0;
  for (const g of groups) {
    const msgs = loadMsgs(g.id), audio = {};
    for (const m of msgs) for (const k of keysOf(m)) {
      if (audio[k]) continue;
      const a = await idb.get(k);
      if (a && a.ab) { audio[k] = { mime: 'audio/mpeg', dur: a.dur == null ? null : a.dur, bins: a.bins ? Array.from(a.bins) : null, data: b64(a.ab) }; nAud++; }
    }
    nMsg += msgs.length;
    out.push({ id: g.id, name: g.name, members: g.members, muted: g.muted || [], scene: g.scene || '', createdAt: g.createdAt, msgs, audio });
  }
  return { groups: out, nAud, nMsg };
};
function cleanMsg(e) { // file impor itu data tak tepercaya
  if (!e || typeof e !== 'object' || !isNum(e.ts) || typeof e.from !== 'string' || !(e.from === 'user' || e.from === 'system' || ID_RE.test(e.from))) return null;
  const o = { from: e.from, ts: e.ts, text: String(e.text == null ? '' : e.text).slice(0, 8000) };
  if (e.from !== 'user' && e.from !== 'system') {
    if (typeof e.vn === 'string' && e.vn) { o.vn = e.vn.slice(0, 8000); o.jp = typeof e.jp === 'string' ? e.jp.slice(0, 8000) : ''; o.lang = typeof e.lang === 'string' ? e.lang.slice(0, 8) : 'jp'; }
    const ks = (Array.isArray(e.ks) ? e.ks : []).filter(isKey).slice(0, 5);
    if (ks.length) { o.ks = ks; if (isNum(e.si)) o.si = Math.max(0, Math.min(ks.length - 1, e.si | 0)); }
  }
  return o;
}
GX.importData = async list => {
  let nGroups = 0, nMsgs = 0, nAud = 0;
  for (const raw of (Array.isArray(list) ? list : []).slice(0, 50)) {
    if (!raw || typeof raw.id !== 'string' || !ID_RE.test(raw.id) || !Array.isArray(raw.msgs)) continue;
    let g = groups.find(x => x.id === raw.id);
    if (!g) {
      if (groups.length >= CFG.MAX_GROUPS) continue;
      g = normGroup(raw); if (!g || g.members.length < CFG.MIN_MEMBERS) continue;
      groups.push(g); nGroups++;
    }
    for (const [k, a] of Object.entries(raw.audio || {})) {
      if (!isKey(k) || !a || typeof a.data !== 'string' || await idb.get(k)) continue;
      const bins = Array.isArray(a.bins) ? a.bins.filter(isNum).slice(0, 512) : null;
      if (await idb.put(k, { ab: unb64(a.data), dur: isNum(a.dur) ? a.dur : null, bins: bins && bins.length ? bins : null })) nAud++;
    }
    const cur = loadMsgs(g.id), idx = new Map(cur.map(m => [m.ts + '|' + m.from, m]));
    for (const r of raw.msgs) {
      const m = cleanMsg(r); if (!m) continue;
      const key = m.ts + '|' + m.from, ex = idx.get(key);
      if (!ex) { cur.push(m); idx.set(key, m); nMsgs++; }
      else if (m.ks && !keysOf(ex).length) ex.ks = m.ks;
    }
    cur.sort((a, b) => a.ts - b.ts); trimMsgs(cur); saveMsgs(g.id, cur);
  }
  saveGroups(); renderList(); paintAll();
  return { groups: nGroups, msgs: nMsgs, aud: nAud };
};

/* ---------- Keluar dari layar grup ---------- */
GX.onClose = () => { // dipanggil closeChat(): rantai berhenti, tidak dilanjutkan otomatis saat dibuka lagi
  const g = GX.cur; if (!g) return;
  abortChain(); clearTimeout(gdraft); hideMention();
  if (groups.includes(g)) store.set('draft:g:' + g.id, inp.value.trim() ? inp.value : null);
  gm.classList.add('hide'); gp.classList.add('hide'); ed = null;
  GX.cur = null; state = null;
};
GX.reset = () => { // dipanggil openChat() untuk karakter biasa
  gmore.classList.add('hide'); inp.placeholder = 'Ketik pesan'; hideMention();
  if (GX.cur) { abortChain(); GX.cur = null; state = null; }
};
GX.esc = () => { // Escape: tutup modal grup dulu sebelum keluar chat
  if (!gm.classList.contains('hide')) { closeEditor(); return true; }
  if (!gp.classList.contains('hide')) { closePanel(); return true; }
  if (mention.open) { hideMention(); return true; }
  return false;
};
})();
