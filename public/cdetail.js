/* Halaman detail karakter: dibuka dari kartu karakter di Beranda (bukan langsung masuk chat). Tombol "Obrolan" baru membuka chat.
   Baru TIRUAN TAMPILAN: sapaan, jumlah obrolan, kategori lengkap, atribut persona, Dukung/Follow, bagikan masih placeholder
   ("fitur belum selesai"). Yang sudah nyata: sapaan (c.greeting, teks pembuka chat buatan pemilik AI), tab Story (cerita AI buatan user: ditulis / dikembangkan AI di Profil > AI Saya, lib/userchars.js charstory), like, komentar (public/cdetail.js <-> lib/charsocial.js), tombol Follow pembuat, nama, label (tagline), foto, pembuat (AI buatan user -> pemiliknya, bisa orang lain kalau AI-nya Publik; bawaan -> akun default nandasikma; nama/foto pembuat bisa dipencet -> profilnya),
   tanggal diperbarui, dan "Robot Terkait" (karakter lain dengan label sama).
   Memakai global index.html: allChars, openChat, img, ph, dispName, toast, store. Semua teks dari data lewat textContent.
   Dibuka lewat window.CD.open(char); ditutup oleh tombol kembali, Escape, atau pindah tab (event 'shell:tab'). */
(() => {
'use strict';
const app = document.getElementById('app'), menu = document.getElementById('menu');
if (!app || !menu) return;
const root = document.createElement('section');
root.id = 'cdetail'; root.setAttribute('aria-label', 'Detail karakter');
menu.after(root);

const h = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const btn = (cls, text, label) => { const b = h('button', cls, text); b.type = 'button'; if (label) b.setAttribute('aria-label', label); return b; };
const svg = d => { const w = h('span'); w.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true">' + d + '</svg>'; return w.firstChild; }; // d = konstanta statis di bawah
const I = {
  back: '<path d="M15 6l-6 6 6 6"/>',
  chat: '<path d="M4 5h16v11H9l-5 4z"/>',
  like: '<path d="M7 11v9H4v-9zM7 11l4-7c1.5 0 2.5 1 2.5 2.5V9H19a2 2 0 012 2.3l-1 6A2.5 2.5 0 0117.5 19H7"/>',
  share: '<path d="M12 15V4M8 8l4-4 4 4M5 13v6h14v-6"/>',
  spark: '<path d="M12 3l2 6 6 2-6 2-2 6-2-6-6-2 6-2z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>'
};
const SOON = 'Fitur ini belum selesai.';
const soon = () => { if (typeof toast === 'function') toast(SOON); };
let cur = null, tab = 'detail';
const chars = () => (typeof allChars !== 'undefined' ? allChars : []);

function dateText(iso) { // 2026-08-08 (format yang sama dengan contoh desain)
  const d = iso ? new Date(iso) : null;
  return d && !isNaN(d) ? d.toISOString().slice(0, 10) : '–';
}
function related(c) {
  const all = chars().filter(x => x.id !== c.id);
  const same = c.tagline ? all.filter(x => x.tagline === c.tagline) : [];
  return same.concat(all.filter(x => !same.includes(x))).slice(0, 3);
}
// pembuat: dari server (`creator`: AI buatan user = pemiliknya, karakter bawaan = akun default). Tanpa creator: bawaan -> Neyhra, buatan user -> Pengguna.
const createdBy = c => c.creator || (c.custom ? { name: 'Pengguna', username: '', bio: '', avatar: '' } : { name: 'Neyhra', username: '', bio: '', avatar: '/icon.svg' });
// Nama/foto pembuat bisa dipencet -> buka profil akunnya (PF.open di profile.js). Tanpa username (fallback Neyhra/Pengguna) = bukan tautan.
function userLink(el, by) {
  if (!by.username || !window.PF || typeof PF.open !== 'function') return el;
  el.classList.add('cd-lnk'); el.tabIndex = 0; el.setAttribute('role', 'link'); el.setAttribute('aria-label', 'Buka profil ' + by.name);
  const go = () => { close(true); PF.open(by.username); };
  el.addEventListener('click', go);
  el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
  return el;
}

/* ---- Like & komentar (lib/charsocial.js). Membaca boleh tamu; menulis butuh login (belum masuk -> toast + overlay login). ---- */
const S = { id: '', likes: null, liked: false, comments: null }; // null = belum termuat
const C = { id: '', items: [], next: 0, more: false, loading: false, err: '', loaded: false }; // daftar komentar tab Komentar
let likeBusy = false;
const ST = { id: '', state: 'idle', text: '' }; // tab Story: idle | loading | ok | err
const loggedIn = () => typeof atok === 'string' && !!atok;
const api = (p, b) => (typeof aApi === 'function' ? aApi(p, b) : Promise.reject(new Error('Fitur tidak tersedia.')));
const nfmt = n => (Number.isFinite(n) ? new Intl.NumberFormat('id-ID').format(n) : '–');
const needLogin = msg => { if (typeof toast === 'function') toast(msg); if (typeof openLogin === 'function') openLogin(); };
const say = m => { if (typeof toast === 'function') toast(m); };
function resetSocial(c) {
  S.id = c.id; S.likes = null; S.liked = false; S.comments = null; likeBusy = false;
  ST.id = c.id; ST.state = 'idle'; ST.text = '';
  C.id = c.id; C.items = []; C.next = 0; C.more = false; C.loading = false; C.err = ''; C.loaded = false;
}
function ago(ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return 'baru saja';
  if (s < 3600) return Math.floor(s / 60) + ' mnt lalu';
  if (s < 86400) return Math.floor(s / 3600) + ' jam lalu';
  if (s < 2592000) return Math.floor(s / 86400) + ' hari lalu';
  return dateText(new Date(ms).toISOString());
}
// perbarui angka like/komentar + tombol like + label tab pada tampilan yang sedang terbuka
function paintSocial() {
  const lk = root.querySelector('.cd-likes'); if (lk) lk.textContent = (S.likes === null ? '–' : nfmt(S.likes)) + ' likes';
  const cc = root.querySelector('.cd-cc'); if (cc) cc.textContent = (S.comments === null ? '–' : nfmt(S.comments)) + ' Komentar';
  const lb = root.querySelector('.cd-like'); if (lb) { lb.classList.toggle('on', S.liked); lb.setAttribute('aria-pressed', String(S.liked)); lb.setAttribute('aria-label', S.liked ? 'Batal suka' : 'Suka'); }
  const tb = root.querySelector('.cd-tab[data-k="komentar"]'); if (tb) tb.textContent = 'Komentar(' + (S.comments === null ? '–' : nfmt(S.comments)) + ')';
  if (S.likes !== null && S.comments !== null) window.dispatchEvent(new CustomEvent('charstats', { detail: { id: S.id, likes: S.likes, comments: S.comments } })); // kartu di Beranda ikut menyesuaikan
}
async function loadSocial(c) {
  try {
    const r = await api('charsocial', { char: c.id });
    if (!r || !r.ok || S.id !== c.id) return;
    S.likes = r.likes; S.liked = !!r.liked; S.comments = r.comments; paintSocial();
  } catch (e) { /* gagal: angka tetap "–" */ }
}
async function toggleLike() {
  if (!loggedIn()) { needLogin('Masuk dulu untuk menyukai'); return; }
  if (S.likes === null || likeBusy || !cur) return;
  likeBusy = true;
  const id = cur.id, was = S.liked;
  S.liked = !was; S.likes = Math.max(0, S.likes + (was ? -1 : 1)); paintSocial(); // langsung terlihat, dibatalkan kalau server menolak
  try {
    const r = await api('charlike', { char: id, on: !was });
    if (!r || !r.ok) throw new Error((r && r.error) || 'Gagal.');
    if (S.id === id) { S.liked = !!r.liked; S.likes = r.likes; }
  } catch (e) {
    if (S.id === id) { S.liked = was; S.likes = Math.max(0, S.likes + (was ? 1 : -1)); }
    say((e && e.message) || 'Gagal, coba lagi.');
  }
  likeBusy = false; paintSocial();
}
async function loadComments() {
  if (C.loading || !cur) return;
  const id = cur.id; C.loading = true; C.err = ''; drawComments();
  try {
    const r = await api('charcomments', { char: id, ...(C.next ? { before: C.next } : {}) });
    if (!r || !r.ok) throw new Error((r && r.error) || 'Gagal memuat komentar.');
    if (C.id !== id) return;
    C.items.push(...r.items); C.more = !!r.more; C.next = r.next || 0; C.loaded = true;
  } catch (e) { if (C.id === id) C.err = (e && e.message) || 'Gagal memuat komentar.'; }
  if (C.id === id) { C.loading = false; drawComments(); }
}
function commentRow(it) {
  const row = h('div', 'cd-cm');
  const av = new Image(); av.className = 'cd-cav'; av.alt = ''; av.referrerPolicy = 'no-referrer';
  av.onerror = () => { av.onerror = null; if (typeof ph === 'function') av.src = ph(it.user.name); };
  av.src = it.user.avatar || (typeof ph === 'function' ? ph(it.user.name) : ''); userLink(av, it.user);
  const body = h('div', 'cd-cmb'), top = h('div', 'cd-cmt');
  top.append(userLink(h('b', null, it.user.name), it.user), h('small', null, ago(it.at)));
  if (it.canDelete) {
    const del = btn('cd-cdel', 'Hapus'); let armed = false;
    del.onclick = async () => {
      if (!armed) { armed = true; del.textContent = 'Yakin?'; setTimeout(() => { if (armed && !del.disabled) { armed = false; del.textContent = 'Hapus'; } }, 3000); return; }
      del.disabled = true;
      try {
        const r = await api('charcomment/delete', { id: it.id });
        if (!r || !r.ok) throw new Error((r && r.error) || 'Gagal.');
        C.items = C.items.filter(x => x.id !== it.id); S.comments = r.comments; paintSocial(); drawComments();
      } catch (e) { say((e && e.message) || 'Gagal, coba lagi.'); armed = false; del.disabled = false; del.textContent = 'Hapus'; }
    };
    top.append(del);
  }
  body.append(top, h('p', 'cd-cmx', it.text)); row.append(av, body); return row;
}
function drawComments() {
  const list = root.querySelector('.cd-clist'); if (!list) return;
  list.textContent = '';
  for (const it of C.items) list.append(commentRow(it));
  if (C.err) list.append(box(C.err));
  else if (!C.loaded) list.append(box('Memuat…'));
  else if (!C.items.length) list.append(box('Belum ada komentar. Jadilah yang pertama!'));
  if (C.more) { const m = btn('cd-cmore', C.loading ? 'Memuat…' : 'Muat lebih banyak'); m.disabled = C.loading; m.onclick = loadComments; list.append(m); }
}
function panelComments(c) {
  C.err = '';
  const sec = section('Komentar');
  if (loggedIn()) {
    const f = h('div', 'cd-cform'), ta = h('textarea', 'cd-cinp'), row = h('div', 'cd-crow'), cnt = h('small', null, '0/300'), send = btn('cd-csend', 'Kirim');
    ta.maxLength = 300; ta.rows = 2; ta.placeholder = 'Tulis komentar…'; ta.setAttribute('aria-label', 'Tulis komentar');
    ta.addEventListener('input', () => { cnt.textContent = ta.value.length + '/300'; });
    send.onclick = async () => {
      const text = ta.value.trim(); if (!text || send.disabled) return;
      send.disabled = true;
      try {
        const r = await api('charcomment', { char: c.id, text });
        if (!r || !r.ok) throw new Error((r && r.error) || 'Gagal mengirim.');
        if (C.id === c.id) { C.items.unshift(r.item); S.comments = r.comments; paintSocial(); drawComments(); }
        ta.value = ''; cnt.textContent = '0/300';
      } catch (e) { say((e && e.message) || 'Gagal mengirim, coba lagi.'); }
      send.disabled = false;
    };
    row.append(cnt, send); f.append(ta, row); sec.append(f);
  } else {
    const b = box('Masuk untuk ikut berkomentar.'), lg = btn('cd-csend', 'Masuk'); lg.onclick = () => needLogin('Masuk dulu untuk berkomentar');
    b.append(document.createElement('br'), lg); b.classList.add('cd-clogin'); sec.append(b);
  }
  sec.append(h('div', 'cd-clist'));
  Promise.resolve().then(() => { if (!C.loaded && !C.loading) loadComments(); else drawComments(); }); // setelah panel terpasang di DOM
  return sec;
}

/* Tombol Follow pembuat: memakai endpoint ikuti yang sama dengan tab Profil (PF.follow -> /api/auth/follow). Status awal (sudah mengikuti / dia mengikutimu / akun sendiri)
   diambil dari /api/auth/profile. Tanpa username (fallback Neyhra/Pengguna) atau akun sendiri = tombol disembunyikan. Belum masuk = diarahkan ke login. */
function followBtn(by) {
  const fl = btn('cd-pill t', '+ Follow');
  if (!by.username) { fl.style.display = 'none'; return fl; }
  const st = { on: false, back: false, busy: false };
  const paint = () => { fl.textContent = st.on ? 'Mengikuti' : (st.back ? '+ Follow balik' : '+ Follow'); fl.classList.toggle('on', st.on); fl.setAttribute('aria-pressed', String(st.on)); fl.disabled = st.busy; };
  const loggedIn = () => typeof atok === 'string' && !!atok;
  if (loggedIn() && typeof aApi === 'function') {
    st.busy = true; paint(); // tunggu status awal supaya tidak salah toggle
    aApi('profile', { username: by.username }).then(r => {
      const p = r && r.ok ? r.profile : null;
      if (p && p.isMe) { fl.style.display = 'none'; return; }
      if (p) { st.on = !!p.isFollowing; st.back = !!p.followsMe; }
    }).catch(() => {}).then(() => { st.busy = false; paint(); });
  } else paint();
  fl.onclick = async () => {
    if (!loggedIn()) { if (typeof toast === 'function') toast('Masuk dulu untuk mengikuti'); if (typeof openLogin === 'function') openLogin(); return; }
    if (st.busy || !window.PF || typeof PF.follow !== 'function') return;
    const was = st.on; st.busy = true; paint();
    try {
      const r = await PF.follow(by.username, !was, was);
      st.on = !!r.isFollowing; if (typeof toast === 'function') toast(st.on ? 'Mengikuti ' + by.name : 'Berhenti mengikuti ' + by.name);
    } catch (e) { if (typeof toast === 'function') toast((e && e.message) || 'Gagal, coba lagi.'); }
    st.busy = false; paint();
  };
  return fl;
}

function section(title, ...kids) { const s = h('div', 'cd-sec'); s.append(h('h2', null, title), ...kids); return s; }
const box = text => h('div', 'cd-box', text);

function panelDetail(c) {
  const p = h('div');
  const gr = typeof c.greeting === 'string' ? c.greeting.trim() : '';
  p.append(section('Sapaan', box(gr || 'Tidak ada deskripsi. ' + SOON)));
  const kat = h('div'); kat.append(h('span', 'cd-chip', c.tagline || (c.custom ? (c.mine ? 'AI buatanmu' : 'AI buatan pengguna') : 'Lainnya')));
  p.append(section('Kategori', kat));
  const at = h('div', 'cd-box'); at.append(h('div', 'cd-boxh', 'Appearance + body of {{char}}'), document.createTextNode('Tidak ada deskripsi. ' + SOON));
  p.append(section('Atribut Persona', at));
  return p;
}
/* Story: cerita AI buatan user (tanpa login boleh dibaca selama AI-nya publik). Karakter bawaan belum punya cerita. Teks selalu lewat textContent. */
async function loadStory(c) {
  if (ST.state === 'loading') return;
  if (!c.custom) { ST.state = 'ok'; ST.text = ''; drawStory(); return; }
  const id = c.id; ST.state = 'loading'; drawStory();
  try {
    const r = await api('charstory', { char: id });
    if (!r || !r.ok) throw new Error((r && r.error) || 'Gagal memuat cerita.');
    if (ST.id !== id) return;
    ST.text = String(r.story || ''); ST.state = 'ok';
  } catch (e) { if (ST.id === id) { ST.state = 'err'; ST.text = (e && e.message) || 'Gagal memuat cerita.'; } }
  if (ST.id === id) drawStory();
}
function drawStory() {
  const body = root.querySelector('.cd-story'); if (!body) return;
  body.textContent = '';
  if (ST.state === 'loading' || ST.state === 'idle') { body.append(box('Memuat…')); return; }
  if (ST.state === 'err') { const b = box(ST.text), r = btn('cd-csend', 'Coba lagi'); r.onclick = () => { ST.state = 'idle'; loadStory(cur); }; b.append(document.createElement('br'), r); body.append(b); return; }
  if (!ST.text.trim()) { body.append(box(cur && cur.mine ? 'Kamu belum menulis cerita untuk AI ini. Isi lewat Profil > AI Saya > Edit, lalu ketuk ✨ supaya AI mengembangkannya.' : cur && cur.custom ? 'Pembuat belum menulis cerita untuk AI ini.' : 'Karakter ini belum punya cerita.')); return; }
  const card = h('div', 'cd-box cd-story-text');
  for (const para of ST.text.split(/\n{2,}/)) if (para.trim()) card.append(h('p', null, para.trim()));
  body.append(card);
}
function panelStory(c) {
  const sec = section('Story', h('div', 'cd-story'));
  Promise.resolve().then(() => { if (ST.state === 'idle') loadStory(c); else drawStory(); }); // setelah panel terpasang di DOM
  return sec;
}

function paintTab(c) {
  const holder = root.querySelector('.cd-pane'); if (!holder) return;
  holder.textContent = '';
  holder.append(tab === 'story' ? panelStory(c) : tab === 'komentar' ? panelComments(c) : panelDetail(c));
  root.querySelectorAll('.cd-tab').forEach(t => t.setAttribute('aria-selected', String(t.dataset.k === tab)));
}

function render(c) {
  root.textContent = '';
  const wrap = h('div', 'cd-wrap');
  const back = btn('cd-back', null, 'Kembali ke daftar karakter'); back.append(svg(I.back), h('span', 'cd-backt', 'Kembali')); back.onclick = close;
  const grid = h('div', 'cd-grid');

  /* kolom kiri: foto, likes, tombol, robot terkait */
  const left = h('div', 'cd-left');
  const cover = h('div', 'cd-cover');
  const im = typeof img === 'function' ? img(c) : new Image(); im.removeAttribute('class'); im.decoding = 'async'; cover.append(im);
  const badge = h('div', 'cd-badge'); badge.append(svg(I.chat), document.createTextNode('–')); badge.title = 'Jumlah obrolan: ' + SOON; cover.append(badge);
  const stat = h('div', 'cd-stat'), sl = h('div');
  const lb = h('b'); lb.append(svg(I.like), h('span', 'cd-likes', '– likes'));
  const cc = btn('cd-cc', '– Komentar', 'Lihat komentar'); cc.onclick = () => { tab = 'komentar'; paintTab(cur); const t = root.querySelector('.cd-tabs'); if (t) t.scrollIntoView({ block: 'start', behavior: 'smooth' }); };
  sl.append(lb, cc);
  const like = btn('cd-like', null, 'Suka'); like.append(svg(I.like)); like.onclick = toggleLike;
  stat.append(sl, like);
  const act = h('div', 'cd-act');
  const go = btn('cd-chat', 'Obrolan'); go.onclick = () => { const c0 = cur; close(true); if (c0 && typeof openChat === 'function') openChat(c0, im); };
  const share = btn('cd-share', null, 'Bagikan'); share.append(svg(I.share)); share.onclick = soon;
  act.append(go, share);
  const rel = h('div', 'cd-rel'), rlist = h('div', 'cd-rlist'); rel.append(h('h3', null, 'Robot Terkait'), rlist);
  for (const r of related(c)) {
    const it = btn('cd-ritem'); const ri = typeof img === 'function' ? img(r) : new Image(); ri.removeAttribute('class'); ri.loading = 'lazy';
    const tx = h('div'); tx.append(h('b', null, r.name), h('span', null, r.tagline || 'AI buatan'));
    it.append(ri, tx); it.onclick = () => { cur = r; tab = 'detail'; resetSocial(r); render(r); root.scrollTop = 0; };
    rlist.append(it);
  }
  if (!rlist.children.length) rel.hidden = true; // tidak ada karakter lain: sembunyikan judulnya juga
  left.append(cover, stat, act, rel);

  /* kolom kanan: judul, pembuat, tab */
  const by = createdBy(c), right = h('div', 'cd-right');
  const meta = h('div', 'cd-meta');
  const m1 = h('span', null, 'Dibuat oleh : '); m1.append(userLink(h('b', null, by.name), by)); const m2 = h('span', null, 'Diperbarui: '); m2.append(h('b', null, dateText(c.updated)));
  meta.append(m1, m2);
  const card = h('div', 'cd-by'), top = h('div', 'cd-byt');
  const av = new Image(); av.className = 'cd-av'; av.alt = ''; av.referrerPolicy = 'no-referrer'; av.onerror = () => { av.onerror = null; if (typeof ph === 'function') av.src = ph(by.name); }; av.src = by.avatar || (typeof ph === 'function' ? ph(by.name) : ''); userLink(av, by);
  const dk = btn('cd-pill o', 'Dukung'); dk.prepend(svg(I.spark)); dk.style.display = 'inline-flex'; dk.style.alignItems = 'center'; dk.style.gap = '6px'; dk.onclick = soon;
  const fl = followBtn(by);
  top.append(av, userLink(h('div', 'cd-bn', by.name), by), dk, fl);
  card.append(top, h('p', 'cd-bio', by.bio || 'Tidak ada deskripsi.'));
  const tabs = h('div', 'cd-tabs'); tabs.setAttribute('role', 'tablist');
  for (const [k, label] of [['detail', 'Detail'], ['story', 'Story'], ['komentar', 'Komentar(–)']]) {
    const t = btn('cd-tab', label); t.dataset.k = k; t.setAttribute('role', 'tab'); t.onclick = () => { tab = k; paintTab(cur); }; tabs.append(t);
  }
  const head = h('div', 'cd-head'); head.append(h('h1', 'cd-title', typeof dispName === 'function' ? dispName(c) : c.name), meta, h('p', 'cd-sub', c.tagline || ''));
  right.append(head, card, tabs, h('div', 'cd-pane'));

  grid.append(left, right); wrap.append(back, grid); root.append(wrap);
  paintTab(c); paintSocial(); loadSocial(c);
}

function open(c) {
  if (!c) return;
  cur = c; tab = 'detail'; resetSocial(c); render(c);
  app.classList.add('cd-on'); root.scrollTop = 0; root.classList.remove('cd-sc');
  const b = root.querySelector('.cd-back'); if (b) b.focus({ preventScroll: true });
}
function close(silent) {
  if (!app.classList.contains('cd-on')) return;
  app.classList.remove('cd-on'); cur = null;
  if (silent !== true) { const t = document.getElementById('alllist'); if (t) t.scrollIntoView({ block: 'nearest' }); }
}
/* mobile: tombol kembali melayang di atas foto (gelap transparan); setelah foto lewat, jadi solid supaya tetap terbaca di atas isi halaman */
root.addEventListener('scroll', () => { const cv = root.querySelector('.cd-cover'); root.classList.toggle('cd-sc', !!cv && root.scrollTop > cv.offsetHeight - 80); }, { passive: true });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && app.classList.contains('cd-on') && !document.querySelector('.modal:not(.hide)')) close(); });
window.addEventListener('shell:tab', () => close(true)); // pindah tab (Obrolan, Profil, dst.) menutup detail
window.CD = { open, close, get current() { return cur; } };
})();
