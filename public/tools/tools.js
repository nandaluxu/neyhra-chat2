/* ===== Tab Tools: hub + pemuat tool =====
   Dimuat setelah shell.js, sebelum router.js. Isi tab ini (#tlbody) dibuat di sini; tiap tool hidup di foldernya sendiri:
     public/tools/<id>/<id>.js   dan   public/tools/<id>/<id>.css   (hanya diunduh saat tool pertama kali dibuka)

   Menambah tool baru (cukup 2 langkah, index.html tidak perlu disentuh):
     1. Tambah satu entri di LIST di bawah  { id, title, desc, icon, css, js }
     2. Di <id>.js panggil  Tools.register('<id>', { mount(host, ctx) {...}, unmount() {...} })
        host = elemen kosong tempat tool menggambar UI; ctx = { toast, post, chars, store } (lihat catatan di bawah).
   Alamat: /tools (daftar) dan /tools/<id> (tool terbuka); router.js memakai Tools.path() dan Tools.open(id).

   ctx meminjam global index.html (let/const/function di script klasik bisa diakses langsung):
     toast(teks), post(url, body, headers) (lempar Error dengan .status kalau gagal), allChars (daftar karakter), store.get/set. */
(() => {
'use strict';
const $ = id => document.getElementById(id);
const app = $('app'), body = $('tlbody');
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const LIST = [
  { id: 'voice', title: 'AI Voice', desc: 'Ketik teks, pilih karakter dan suaranya, langsung jadi audio.',
    icon: '<path d="M12 3a3 3 0 00-3 3v6a3 3 0 006 0V6a3 3 0 00-3-3z"/><path d="M5 11a7 7 0 0014 0M12 18v3"/>',
    css: '/tools/voice/voice.css', js: '/tools/voice/voice.js' },
  // ↑ tool berikutnya ditambah di sini
];

const impls = {}                 // id -> { mount, unmount } (diisi lewat Tools.register)
const loading = {}               // id -> Promise (cache pemuatan aset)
let curId = null, mounted = null, seq = 0, lastTab = app.dataset.tab

const ctx = () => ({
  toast: t => toast(t),
  post: (u, b, h) => post(u, b, h),
  chars: () => (typeof allChars !== 'undefined' ? allChars : []),
  store
})

function load(def) {
  return loading[def.id] || (loading[def.id] = new Promise((ok, no) => {
    if (def.css) { const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = def.css; document.head.append(l) }
    const s = document.createElement('script'); s.src = def.js
    s.onload = () => (impls[def.id] ? ok() : no(new Error('Tool tidak mendaftar')))
    s.onerror = () => no(new Error('Gagal memuat'))
    document.head.append(s)
  }).catch(e => { delete loading[def.id]; throw e }))
}

function unmountCur() {
  if (mounted) { try { impls[mounted.id]?.unmount?.() } catch {} mounted = null }
}

function hub() {
  unmountCur(); curId = null; delete app.dataset.tool; seq++
  body.innerHTML = `<div class="tl-top"><h1>Tools</h1><p class="tl-sub">Alat bantu kecil di luar obrolan.</p></div>
    <div class="tl-grid">${LIST.map(t => `<button class="tl-card" type="button" data-id="${esc(t.id)}"><span class="ic"><svg viewBox="0 0 24 24">${t.icon}</svg></span><b>${esc(t.title)}</b><span class="d">${esc(t.desc)}</span></button>`).join('')}
    <div class="tl-card soon"><span class="ic"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg></span><b>Segera hadir</b><span class="d">Tool lain menyusul.</span></div></div>`
  $('tools').scrollTop = 0
}

async function open(id) {
  const def = LIST.find(t => t.id === id)
  if (!def) { if (curId || !body.children.length) hub(); return }
  if (curId === id && mounted) return
  unmountCur(); curId = id; app.dataset.tool = id
  const my = ++seq
  body.innerHTML = `<div class="tl-head"><button class="tl-back" type="button" aria-label="Kembali ke Tools"><svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg></button><h1>${esc(def.title)}</h1></div><div id="tlhost"><p class="tl-load">Memuat…</p></div>`
  $('tools').scrollTop = 0
  try {
    await load(def)
    if (my !== seq) return // sudah pindah ke layar lain selagi memuat
    const host = $('tlhost'); host.textContent = ''
    impls[id].mount(host, ctx()); mounted = def
  } catch (e) {
    if (my !== seq) return
    $('tlhost').innerHTML = `<div class="tl-err">Tool gagal dimuat. Periksa koneksi lalu coba lagi.<br><button class="tl-btn" type="button" data-retry="${esc(id)}">Coba lagi</button></div>`
  }
}

body.addEventListener('click', e => {
  const card = e.target.closest('.tl-card[data-id]'); if (card) return open(card.dataset.id)
  if (e.target.closest('.tl-back')) return hub()
  const r = e.target.closest('[data-retry]'); if (r) { curId = null; open(r.dataset.retry) }
})

// klik "Tools" di navbar saat sudah di tab ini = kembali ke daftar
window.addEventListener('shell:tab', e => {
  const t = e.detail
  if (t === 'tools' && lastTab === 'tools' && curId) hub()
  lastTab = t
})

window.Tools = {
  register(id, impl) { impls[id] = impl },
  open: id => open(id),
  path: () => (curId ? '/tools/' + curId : '/tools'),
  cur: () => curId
}
hub()
})()
