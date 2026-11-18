/* Halaman detail karakter: dibuka dari kartu karakter di Beranda (bukan langsung masuk chat). Tombol "Obrolan" baru membuka chat.
   Baru TIRUAN TAMPILAN: sapaan, story, komentar, likes, kategori lengkap, atribut persona, Dukung/Follow, bagikan masih placeholder
   ("fitur belum selesai"). Yang sudah nyata: nama, label (tagline), foto, pembuat (AI buatan user -> pemiliknya, bawaan -> Neyhra),
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
const createdBy = c => c.custom && c.creator ? c.creator : { name: 'Neyhra', username: '', bio: '', avatar: '/icon.svg' };

function section(title, ...kids) { const s = h('div', 'cd-sec'); s.append(h('h2', null, title), ...kids); return s; }
const box = text => h('div', 'cd-box', text);

function panelDetail(c) {
  const p = h('div');
  p.append(section('Sapaan', box('Tidak ada deskripsi. ' + SOON)));
  const kat = h('div'); kat.append(h('span', 'cd-chip', c.tagline || (c.custom ? 'AI buatanmu' : 'Lainnya')));
  p.append(section('Kategori', kat));
  const at = h('div', 'cd-box'); at.append(h('div', 'cd-boxh', 'Appearance + body of {{char}}'), document.createTextNode('Tidak ada deskripsi. ' + SOON));
  p.append(section('Atribut Persona', at));
  return p;
}
function panelSoon(label) { return section(label, box(SOON)); }

function paintTab(c) {
  const holder = root.querySelector('.cd-pane'); if (!holder) return;
  holder.textContent = '';
  holder.append(tab === 'story' ? panelSoon('Story') : tab === 'komentar' ? panelSoon('Komentar') : panelDetail(c));
  root.querySelectorAll('.cd-tab').forEach(t => t.setAttribute('aria-selected', String(t.dataset.k === tab)));
}

function render(c) {
  root.textContent = '';
  const wrap = h('div', 'cd-wrap');
  const back = btn('cd-back', null, 'Kembali ke daftar karakter'); back.append(svg(I.back), document.createTextNode('Kembali')); back.onclick = close;
  const grid = h('div', 'cd-grid');

  /* kolom kiri: foto, likes, tombol, robot terkait */
  const left = h('div', 'cd-left');
  const cover = h('div', 'cd-cover');
  const im = typeof img === 'function' ? img(c) : new Image(); im.removeAttribute('class'); im.decoding = 'async'; cover.append(im);
  const badge = h('div', 'cd-badge'); badge.append(svg(I.chat), document.createTextNode('–')); badge.title = 'Jumlah obrolan: ' + SOON; cover.append(badge);
  const stat = h('div', 'cd-stat'), sl = h('div');
  const lb = h('b'); lb.append(svg(I.like), document.createTextNode('– likes')); sl.append(lb, h('small', null, '– Komentar'));
  const like = btn('cd-like', null, 'Suka'); like.append(svg(I.like)); like.onclick = soon;
  stat.append(sl, like);
  const act = h('div', 'cd-act');
  const go = btn('cd-chat', 'Obrolan'); go.onclick = () => { const c0 = cur; close(true); if (c0 && typeof openChat === 'function') openChat(c0, im); };
  const share = btn('cd-share', null, 'Bagikan'); share.append(svg(I.share)); share.onclick = soon;
  act.append(go, share);
  const rel = h('div', 'cd-rel'); rel.append(h('h3', null, 'Robot Terkait'));
  for (const r of related(c)) {
    const it = btn('cd-ritem'); const ri = typeof img === 'function' ? img(r) : new Image(); ri.removeAttribute('class'); ri.loading = 'lazy';
    const tx = h('div'); tx.append(h('b', null, r.name), h('span', null, r.tagline || 'AI buatan'));
    it.append(ri, tx); it.onclick = () => { cur = r; tab = 'detail'; render(r); root.scrollTop = 0; };
    rel.append(it);
  }
  left.append(cover, stat, act, rel);

  /* kolom kanan: judul, pembuat, tab */
  const by = createdBy(c), right = h('div', 'cd-right');
  const meta = h('div', 'cd-meta');
  const m1 = h('span', null, 'Dibuat oleh : '); m1.append(h('b', null, by.name)); const m2 = h('span', null, 'Diperbarui: '); m2.append(h('b', null, dateText(c.updated)));
  meta.append(m1, m2);
  const card = h('div', 'cd-by'), top = h('div', 'cd-byt');
  const av = new Image(); av.className = 'cd-av'; av.alt = ''; av.referrerPolicy = 'no-referrer'; av.onerror = () => { av.onerror = null; if (typeof ph === 'function') av.src = ph(by.name); }; av.src = by.avatar || (typeof ph === 'function' ? ph(by.name) : '');
  const dk = btn('cd-pill o', 'Dukung'); dk.prepend(svg(I.spark)); dk.style.display = 'inline-flex'; dk.style.alignItems = 'center'; dk.style.gap = '6px'; dk.onclick = soon;
  const fl = btn('cd-pill t', '+ Follow'); fl.onclick = soon;
  top.append(av, h('div', 'cd-bn', by.name), dk, fl);
  card.append(top, h('p', 'cd-bio', by.bio || 'Tidak ada deskripsi.'));
  const tabs = h('div', 'cd-tabs'); tabs.setAttribute('role', 'tablist');
  for (const [k, label] of [['detail', 'Detail'], ['story', 'Story'], ['komentar', 'Komentar(–)']]) {
    const t = btn('cd-tab', label); t.dataset.k = k; t.setAttribute('role', 'tab'); t.onclick = () => { tab = k; paintTab(cur); }; tabs.append(t);
  }
  right.append(h('h1', 'cd-title', typeof dispName === 'function' ? dispName(c) : c.name), meta, h('p', 'cd-sub', c.tagline || ''), card, tabs, h('div', 'cd-pane'));

  grid.append(left, right); wrap.append(back, grid); root.append(wrap);
  paintTab(c);
}

function open(c) {
  if (!c) return;
  cur = c; tab = 'detail'; render(c);
  app.classList.add('cd-on'); root.scrollTop = 0;
  const b = root.querySelector('.cd-back'); if (b) b.focus({ preventScroll: true });
}
function close(silent) {
  if (!app.classList.contains('cd-on')) return;
  app.classList.remove('cd-on'); cur = null;
  if (silent !== true) { const t = document.getElementById('alllist'); if (t) t.scrollIntoView({ block: 'nearest' }); }
}
document.addEventListener('keydown', e => { if (e.key === 'Escape' && app.classList.contains('cd-on') && !document.querySelector('.modal:not(.hide)')) close(); });
window.addEventListener('shell:tab', () => close(true)); // pindah tab (Obrolan, Profil, dst.) menutup detail
window.CD = { open, close, get current() { return cur; } };
})();
