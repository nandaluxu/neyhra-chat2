/* ===== Tab Musik: cari lagu, putar (audio di-proxy server per potongan 1 MB), antrean, lirik =====
   Dimuat setelah shell.js, sebelum router.js (lihat index.html). Server: lib/music.js.
   Memakai global index.html: $, store, cid, app, devOn (let/const global, akses langsung).
   Kejadian: 'shell:tab' (dari Shell.setTab) menyegarkan layar saat tabnya tampil; 'devmode' (dari switch
   Mode dev di Pengaturan) menghentikan musik saat Mode dev dimatikan.

   STATUS: fitur DITUTUP untuk user biasa (streaming YouTube dari IP server sering ditolak, bot check).
   Tab, ikon rail, alamat /music, dan antrean tersimpan hanya aktif saat Mode dev menyala —
   pagar di klien (pola kode rahasia yang lain), endpoint server tetap ada untuk pengujian.

   Cara kerja singkat:
   - Pencarian memanggil /api/music/search (server pakai YouTube Music; cache Redis 30 menit).
   - Memutar lagu memanggil /api/music/stream -> server mengembalikan URL /api/music/audio?id=..
     (proxy milik server sendiri) -> <audio> memutar dari situ lewat Range request; server
     meneruskan potongan ±1 MB dari googlevideo. Ini wajib karena URL googlevideo terikat IP yang
     me-resolve (IP Vercel) sehingga kalau diputar langsung oleh browser user akan 403.
   - Musik terus jalan saat pindah tab, tapi tampilannya (mini player, Now Playing, toast) hanya
     muncul di tab Musik supaya tidak menimpa halaman lain. Ikon Musik di rail menandakan sedang memutar.
   - Antrean + posisi + mode (acak/ulang) disimpan di localStorage ('mqueue') seperti chat. */
(() => {
'use strict';
const $ = id => document.getElementById(id);
const app = $('app'), body = $('mubody');
const dev = () => typeof devOn === 'function' && devOn(); /* Musik hanya untuk Mode dev (lihat catatan status di atas) */
const active = () => app.dataset.tab === 'music' && dev();
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = s => { if (!s || !isFinite(s) || s < 0) return '0:00'; const m = Math.floor(s / 60), r = Math.floor(s % 60); return m + ':' + String(r).padStart(2, '0') };
const jget = async url => { try { const r = await fetch(url); return await r.json() } catch { return { error: 'Gagal menghubungi server' } } };
const SPIN = '<svg class="muspin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 3a9 9 0 109 9"/></svg>';
const SVG = {
  play: '<svg viewBox="0 0 24 24"><path d="M8 5.5v13l11-6.5z"/></svg>',
  pause: '<svg viewBox="0 0 24 24"><path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z"/></svg>',
  next: '<svg viewBox="0 0 24 24"><path d="M6 5.5l9 6.5-9 6.5zM16.5 5H19v14h-2.5z"/></svg>',
  prev: '<svg viewBox="0 0 24 24"><path d="M18 5.5l-9 6.5 9 6.5zM5 5h2.5v14H5z"/></svg>',
  shuffle: '<svg class="sv" viewBox="0 0 24 24"><path d="M3 7h4l10 10h4M17 3l4 4-4 4M3 17h4M13 7h4M17 13l4 4-4 4"/></svg>',
  repeat: '<svg class="sv" viewBox="0 0 24 24"><path d="M7 7h10a3 3 0 013 3v1M17 17H7a3 3 0 01-3-3v-1M7 4.5L4 7l3 2.5M17 19.5L20 17l-3-2.5"/></svg>',
  repeat1: '<svg class="sv" viewBox="0 0 24 24"><path d="M7 7h10a3 3 0 013 3v1M17 17H7a3 3 0 01-3-3v-1M7 4.5L4 7l3 2.5M17 19.5L20 17l-3-2.5M11 11.5l1.5-1v4"/></svg>',
  close: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  check: '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  panel: '<svg viewBox="0 0 24 24"><rect x="3.5" y="4.5" width="17" height="15" rx="3"/><path d="M14.5 4.5v15"/></svg>',
  vol2: '<svg class="sv" viewBox="0 0 24 24"><path d="M4 9.5v5h3.5l4.5 4v-13l-4.5 4z"/><path d="M15.5 9a4 4 0 010 6M18 6.5a8 8 0 010 11"/></svg>',
  vol1: '<svg class="sv" viewBox="0 0 24 24"><path d="M4 9.5v5h3.5l4.5 4v-13l-4.5 4z"/><path d="M15.5 9a4 4 0 010 6"/></svg>',
  vol0: '<svg class="sv" viewBox="0 0 24 24"><path d="M4 9.5v5h3.5l4.5 4v-13l-4.5 4z"/><path d="M16 9.5l5 5M21 9.5l-5 5"/></svg>',
  search: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/></svg>'
};

/* ---------- toast sendiri (toast bawaan ada di footer chat, terlihat hanya saat chat terbuka) ---------- */
let mtEl = null, mtT = 0;
function say(t) {
  if (!mtEl) { mtEl = document.createElement('div'); mtEl.id = 'mutoast'; mtEl.setAttribute('role', 'status'); mtEl.setAttribute('aria-live', 'polite'); app.append(mtEl); mtEl.addEventListener('click', () => mtEl.classList.remove('show')); }
  mtEl.textContent = t; mtEl.classList.add('show'); clearTimeout(mtT); mtT = setTimeout(() => mtEl.classList.remove('show'), 3200);
}

/* ---------- elemen audio tunggal (di luar semua section: tidak pernah dibongkar) ---------- */
const audio = document.createElement('audio');
audio.preload = 'metadata';
app.append(audio);

/* ---------- keadaan ---------- */
let queue = [], qi = -1;            // antrean + indeks lagu aktif
let repeat = 'off', shuffle = false; // 'off' | 'all' | 'one'
let songs = [], searched = false;   // hasil pencarian terakhir
let loading = false, searching = false, notice = '', lastErr = ''; // loading = memuat stream lagu; searching = menunggu hasil pencarian (dulu satu flag -> daftar jadi skeleton saat lagu diklik)
let lyr = null, lyrLoading = false; // lirik: [{t, text}] atau null
let lrcIdx = -1, lrcHold = 0, lrcBuilt = ''; // baris aktif, jeda auto-scroll (user sedang menggulir), tanda isi yang sudah dirender
let sheet = false, sheetTab = 'lyrics';
const cur = () => (qi >= 0 && qi < queue.length ? queue[qi] : null);

/* muat/simpan antrean (pola store seperti pin/logs aplikasi); antrean HANYA dipulihkan saat Mode dev
   aktif — user biasa tidak melihat mini player dari sisa antrean lama */
if (dev()) try { const o = JSON.parse(store.get('mqueue') || 'null'); if (o && Array.isArray(o.queue)) { queue = o.queue; qi = Math.min(o.qi ?? -1, o.queue.length - 1); repeat = ['off', 'all', 'one'].includes(o.repeat) ? o.repeat : 'off'; shuffle = !!o.shuffle; } } catch {}
const save = () => store.set('mqueue', JSON.stringify({ queue: queue.slice(0, 100), qi, repeat, shuffle }));

/* riwayat putar ('mhist', terbaru di depan, maks 40) — jadi bahan rekomendasi di beranda */
const slim = s => ({ id: s.id, title: s.title, artist: s.artist, album: s.album || '', dur: s.dur || 0, thumb: s.thumb || '' });
const hget = () => { try { const a = JSON.parse(store.get('mhist') || '[]'); return Array.isArray(a) ? a : [] } catch { return [] } };
const hadd = s => { const a = hget().filter(x => x.id !== s.id); a.unshift(slim(s)); store.set('mhist', JSON.stringify(a.slice(0, 40))) };

/* lagu tersimpan ('mlib', terbaru di depan, maks 500) — tombol + di mini player. Hanya di perangkat ini (tidak ikut sinkron cloud, sama seperti 'mqueue') */
const LIB_MAX = 500;
const lget = () => { try { const a = JSON.parse(store.get('mlib') || '[]'); return Array.isArray(a) ? a.filter(x => x && x.id) : [] } catch { return [] } };
const inLib = id => !!id && lget().some(x => x.id === id);
/* true = tersimpan, false = dihapus dari simpanan, null = penuh / gagal menulis */
function libToggle(s) {
  const a = lget(), i = a.findIndex(x => x.id === s.id);
  if (i >= 0) a.splice(i, 1);
  else { if (a.length >= LIB_MAX) return null; a.unshift(slim(s)) }
  try { localStorage.setItem('mlib', JSON.stringify(a)) } catch { return null } /* store.set menelan error: di sini perlu tahu kalau penyimpanan penuh */
  return i < 0;
}

/* ---------- mini player + lembar now playing: dibangun sekali, isi diperbarui ---------- */
const pl = document.createElement('div'); pl.id = 'mupl'; pl.setAttribute('role', 'complementary'); pl.setAttribute('aria-label', 'Pemutar musik');
pl.innerHTML = '<div class="mupb"><i id="mupb-fl"></i></div><div class="mupl-in">' +
  /* kiri: cover + judul + artis + tombol + (simpan ke 'Lagu tersimpan', lihat mlib) */
  '<div class="mupl-l"><img class="art" id="muart" alt="" draggable="false">' +
  '<div class="si" id="musi"><b id="mupt"></b><span id="mupa"></span></div>' +
  '<button type="button" class="mupl-add" id="muadd" aria-label="Simpan lagu" title="Simpan lagu" aria-pressed="false">' + SVG.plus + '</button></div>' +
  /* HP: tombol ringkas (di desktop disembunyikan, diganti kolom tengah) */
  '<button type="button" class="mupl-play" id="muplay" aria-label="Putar / jeda">' + SVG.play + '</button>' +
  '<button type="button" class="mupl-nxt" id="munext" aria-label="Lagu berikutnya">' + SVG.next + '</button>' +
  /* tengah: kontrol + penggeser waktu */
  '<div class="mupl-c"><div class="mupl-ctl">' +
  '<button type="button" class="mupl-b" id="mupsh" aria-label="Acak">' + SVG.shuffle + '</button>' +
  '<button type="button" class="mupl-b" id="muppv" aria-label="Lagu sebelumnya">' + SVG.prev + '</button>' +
  '<button type="button" class="mupl-play" id="mupplay" aria-label="Putar / jeda">' + SVG.play + '</button>' +
  '<button type="button" class="mupl-b" id="mupnx" aria-label="Lagu berikutnya">' + SVG.next + '</button>' +
  '<button type="button" class="mupl-b" id="muprp" aria-label="Ulangi">' + SVG.repeat + '</button></div>' +
  '<div class="mupl-tl"><span class="t1" id="mupt1">0:00</span>' +
  '<div class="mupl-seek" id="mupseek" role="slider" tabindex="0" aria-label="Posisi lagu" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><div class="tr"></div><div class="fl" id="mupfl"></div><div class="kn" id="mupkn"></div></div>' +
  '<span class="t2" id="mupt2">0:00</span></div></div>' +
  /* kanan: volume */
  '<div class="mupl-r"><button type="button" class="mupl-b" id="muvolb" aria-label="Bisukan / bunyikan">' + SVG.vol2 + '</button>' +
  '<input type="range" class="mupl-vol" id="muvol" min="0" max="100" value="100" aria-label="Volume"></div></div>';
app.append(pl);
const seek2 = $('mupseek'), vol = $('muvol');

const np = document.createElement('div'); np.id = 'mnp'; np.setAttribute('role', 'dialog'); np.setAttribute('aria-label', 'Layar pemutar');
np.innerHTML = '<div class="mnp-in">' +
  '<div class="mnp-top"><button type="button" class="mnp-x" id="mnpx" aria-label="Tutup">' + SVG.close + '</button><span class="t">Sedang diputar</span><span style="width:38px;flex:none"></span></div>' +
  '<div class="mnp-empty" id="mnpempty">Belum ada lagu yang diputar.<br>Pilih lagu dari beranda atau cari di atas.</div>' +
  '<img class="mnp-art" id="mnpart" alt="">' +
  '<div class="mnp-meta"><h1 id="mnpt"></h1><p id="mnpa"></p><div class="mnp-err" id="mnperr" hidden></div></div>' +
  '<div class="mnp-seek" id="mnpseek" role="slider" aria-label="Posisi lagu" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><div class="tr"></div><div class="fl" id="mnpfl"></div><div class="kn" id="mnpkn"></div></div>' +
  '<div class="mnp-time"><span id="mnpt1">0:00</span><span id="mnpt2">0:00</span></div>' +
  '<div class="mnp-ctl">' +
  '<button type="button" class="mnp-side" id="mnpsh" aria-label="Acak">' + SVG.shuffle + '</button>' +
  '<button type="button" class="mnp-side" id="mnppv" aria-label="Lagu sebelumnya">' + SVG.prev + '</button>' +
  '<button type="button" class="mupl-play big" id="mnpplay" aria-label="Putar / jeda">' + SVG.play + '</button>' +
  '<button type="button" class="mnp-side" id="mnpnx" aria-label="Lagu berikutnya">' + SVG.next + '</button>' +
  '<button type="button" class="mnp-side" id="mnprp" aria-label="Ulangi">' + SVG.repeat + '</button></div>' +
  '<div class="mnp-tabs"><button type="button" class="mnp-tab on" id="mnptab-l" data-t="lyrics">Lirik</button><button type="button" class="mnp-tab" id="mnptab-q" data-t="queue">Antrean</button></div>' +
  '<div id="mnplrc" class="mu-lrc" hidden></div>' +
  '<div id="mnpq" hidden></div></div>';
app.append(np);
const lrcBox = np.querySelector('#mnplrc'), qBox = np.querySelector('#mnpq');
/* Desktop (>=800px): lembar Now Playing = panel kanan yang menempel di grid (bisa disembunyikan, pilihan diingat di 'mpanel');
   panel terbuka -> mini player bawah disembunyikan (CSS), panel disembunyikan -> mini player muncul lagi.
   Mobile: tetap lembar layar penuh yang naik dari bawah. */
const desk = () => matchMedia('(min-width:800px)').matches;
function applyPanel() {
  const d = desk();
  const x = $('mnpx'); x.innerHTML = d ? SVG.panel : SVG.close; x.setAttribute('aria-label', d ? 'Sembunyikan pemutar' : 'Tutup'); x.title = d ? 'Sembunyikan pemutar' : '';
  if (!d) { app.classList.remove('mp-off'); sheet = false; np.classList.remove('on', 'none'); return }
  const on = store.get('mpanel') !== '0';
  app.classList.toggle('mp-off', !on);
  np.classList.remove('on');
  sheet = on && active();
  if (sheet) { renderSheet(); if (sheetTab === 'lyrics') lrcShow() }
  renderPl(); paintTime();
}
function setPanel(on) {
  if (desk()) { store.set('mpanel', on ? '1' : '0'); applyPanel(); return }
  sheet = on; np.classList.toggle('on', on);
  if (on) { renderSheet(); if (sheetTab === 'lyrics') lrcShow() }
}
$('mnpx').addEventListener('click', () => setPanel(false));
$('musi').addEventListener('click', () => setPanel(true));
$('muart').addEventListener('click', () => $('musi').click());

/* ---------- beranda ala Spotify: tiap kategori = 1 baris carousel (10 lagu, geser pakai panah) ----------
   Urutan: "Jump back in" (10 lagu terakhir diputar) -> "Rekomendasi" -> satu baris per artis favorit ("Lainnya dari X").
   "Lihat semua" membuka seluruh isi kategori (grid). Semua dari /api/music/search (tanpa endpoint baru). */
const REC_TTL = 3 * 3600e3, ROW_N = 10;
let rec = null, recBusy = false;   // rec = {k, secs:[{key,title,sub,avatar,songs}], err}
const recLists = {};               // key kategori -> daftar lagu (dipakai klik card)
let page = null, pageY = 0;        // halaman "Lihat semua" (di dalam tab Musik): {key,title,sub,avatar}; pageY = posisi gulir beranda untuk dipulihkan saat kembali
const firstArtist = a => String(a || '').split(/,|&| feat\.? /i)[0].trim();
const CHEV = '<svg viewBox="0 0 24 24"><path d="M9 5l7 7-7 7"/></svg>';
function recPlan() {
  const h = hget(), cnt = {};
  h.forEach((s, i) => { const a = firstArtist(s.artist); if (a && a !== '—') cnt[a] = (cnt[a] || 0) + (h.length - i) }); /* lagu yang lebih baru berbobot lebih besar */
  const top = Object.keys(cnt).sort((a, b) => cnt[b] - cnt[a]).slice(0, 3);
  const qs = [{ key: 'r0', q: 'lagu indonesia populer', rec: true }, { key: 'r1', q: 'top hits 2026', rec: true }]
    .concat(top.length ? top.map((a, i) => ({ key: 'a' + i, q: a, artist: a })) : [{ key: 'g0', q: 'lagu viral', title: 'Lagu viral' }]);
  return { hist: h, personal: !!top.length, qs };
}
async function loadRec() {
  if (recBusy) return;
  const plan = recPlan(), k = plan.qs.map(x => x.q).join('|');
  if (rec && rec.k === k && !rec.err) return;
  try {
    const c = JSON.parse(store.get('mrec3') || 'null');
    if (c && c.k === k && Date.now() - c.t < REC_TTL && Array.isArray(c.secs) && c.secs.length) { rec = { k, secs: c.secs }; paintHome(); return }
  } catch {}
  recBusy = true; paintHome();
  const rs = await Promise.all(plan.qs.map(x => jget('/api/music/search?q=' + encodeURIComponent(x.q) + '&clientId=' + encodeURIComponent(cid))));
  recBusy = false;
  const seen = new Set(plan.personal ? plan.hist.map(s => s.id) : []);
  const got = plan.qs.map((x, i) => ({ x, all: Array.isArray(rs[i].songs) ? rs[i].songs.filter(s => s && s.id) : [] }));
  const rows = [];
  /* baris artis/lainnya dulu (agar tidak habis dimakan Rekomendasi), tapi ditampilkan setelah Rekomendasi */
  got.filter(g => !g.x.rec).forEach(({ x, all }) => {
    const songs = all.filter(s => !seen.has(s.id)).slice(0, 20).map(slim);
    songs.forEach(s => seen.add(s.id));
    if (songs.length) rows.push(x.artist ? { key: x.key, title: x.artist, sub: 'Lainnya dari', avatar: (all[0] && all[0].thumb) || songs[0].thumb, songs } : { key: x.key, title: x.title, songs });
  });
  const lists = got.filter(g => g.x.rec).map(g => g.all), mix = [];
  for (let i = 0; mix.length < 30 && i < 20; i++) for (const l of lists) { const s = l[i]; if (s && !seen.has(s.id)) { seen.add(s.id); mix.push(slim(s)) } }
  const secs = (mix.length ? [{ key: 'rec', title: 'Rekomendasi', songs: mix }] : []).concat(rows);
  rec = { k, secs, err: !secs.length };
  if (secs.length) store.set('mrec3', JSON.stringify({ k, t: Date.now(), secs }));
  paintHome();
}
function cardHtml(s, key, i) {
  const c = cur(), now = c && c.id === s.id;
  return '<button type="button" class="mu-card' + (now ? ' now' : '') + '" data-k="' + key + '" data-i="' + i + '">' +
    '<span class="cv"><img src="' + esc(s.thumb || '') + '" alt="" loading="lazy" draggable="false">' +
    (now ? '<span class="mu-eq" aria-label="Sedang diputar"><i></i><i></i><i></i></span>' : '') +
    '<span class="pp" aria-hidden="true">' + SVG.play + '</span>' +
    '<span class="mu-cadd" role="button" tabindex="0" data-add title="Tambah ke antrean" aria-label="Tambah ' + esc(s.title) + ' ke antrean">' + SVG.plus + '</span></span>' +
    '<b class="t">' + esc(s.title) + '</b><span class="a">' + esc(s.artist) + '</span></button>';
}
/* satu kategori: header (avatar bulat bila artis) + Lihat semua + baris card dengan panah geser */
function secHtml(key, title, songs, o = {}) {
  recLists[key] = songs;
  const open = false;
  return '<section class="mu-sec' + (open ? ' open' : '') + '" data-sec="' + key + '"><div class="mu-shr"><div class="mu-sht">' +
    (o.avatar ? '<img class="av" src="' + esc(o.avatar) + '" alt="" draggable="false">' : '') +
    '<div>' + (o.sub ? '<small>' + esc(o.sub) + '</small>' : '') + '<h2>' + esc(title) + '</h2></div></div>' +
    '<button type="button" class="mu-more" data-more="' + key + '"' + (songs.length > ROW_N ? '' : ' hidden') + '>' + (open ? 'Tutup' : 'Lihat semua') + '</button></div>' +
    '<div class="mu-rw"><div class="mu-grid">' + songs.map((s, i) => cardHtml(s, key, i)).join('') + '</div>' +
    '<button type="button" class="mu-arr l" data-arr="-1" aria-label="Geser ke kiri" hidden>' + CHEV + '</button>' +
    '<button type="button" class="mu-arr r" data-arr="1" aria-label="Geser ke kanan" hidden>' + CHEV + '</button></div></section>';
}
const skelSec = () => '<section class="mu-sec"><div class="mu-shr"><div class="mu-sht"><div><h2 class="mu-skh"></h2></div></div></div><div class="mu-rw"><div class="mu-grid">' +
  Array.from({ length: 8 }).map(() => '<div class="mu-card sk"><span class="cv"></span><b class="t"></b><span class="a"></span></div>').join('') + '</div></div></section>';
function paintHome() {
  const el = $('muhome');
  if (!el || !active()) return;
  if (searching || searched) { el.innerHTML = ''; return }
  const hist = hget().slice(0, 40), lib = lget();
  let h = lib.length ? secHtml('lib', 'Lagu tersimpan', lib) : '';
  if (hist.length) h += secHtml('hist', 'Jump back in', hist);
  if (recBusy || !rec) h += skelSec();
  else if (rec.err) h += '<div class="mu-msg">Rekomendasi belum bisa dimuat. Coba cari lagu di atas, misalnya <b>monokrom tulus</b> atau <b>yoasobi racing</b>.</div>';
  else h += rec.secs.map(x => secHtml(x.key, x.title, x.songs, x)).join('');
  el.innerHTML = h;
  fitRows();
}
/* panah kiri/kanan hanya tampil bila masih ada yang bisa digeser (dan baris tidak sedang dibuka penuh) */
function updateArrows(sec) {
  const g = sec && sec.querySelector('.mu-grid'), l = sec && sec.querySelector('.mu-arr.l'), r = sec && sec.querySelector('.mu-arr.r');
  if (!g || !l || !r) return;
  const open = sec.classList.contains('open');
  l.hidden = open || g.scrollLeft <= 2;
  r.hidden = open || g.scrollLeft + g.clientWidth >= g.scrollWidth - 2;
  sec.classList.toggle('sl', !l.hidden); sec.classList.toggle('sr', !r.hidden); /* sisi yang masih bisa digeser = sisi yang memudar */
}
const fitRows = () => document.querySelectorAll('#muhome .mu-sec').forEach(updateArrows);
addEventListener('resize', () => { if (active()) fitRows() });
function onHome(e) {
  const arr = e.target.closest('[data-arr]');
  if (arr) { const g = arr.closest('.mu-rw').querySelector('.mu-grid'); g.scrollBy({ left: +arr.dataset.arr * g.clientWidth * .9, behavior: 'smooth' }); return }
  const more = e.target.closest('[data-more]');
  if (more) { openPage(more.dataset.more); return }
  const card = e.target.closest('.mu-card');
  if (!card || card.classList.contains('sk')) return;
  const list = recLists[card.dataset.k], i = +card.dataset.i;
  if (!list || !list[i]) return;
  if (e.target.closest('[data-add]')) { e.stopPropagation(); queue.push(list[i]); save(); say('Ditambahkan ke antrean: ' + list[i].title); if (sheet) renderSheet(); return }
  playSong(0, list.slice(i).concat(list.slice(0, i))); /* klik = putar; sisanya mengikuti sebagai antrean */
}

/* ---------- halaman "Lihat semua": seluruh isi satu kategori sebagai halaman sendiri (tombol kembali) ---------- */
function pageSongs() {
  if (!page) return [];
  const l = page.key === 'hist' ? hget().slice(0, 40) : page.key === 'lib' ? lget() : (recLists[page.key] || []);
  recLists[page.key] = l;
  return l;
}
function openPage(key) {
  const meta = key === 'hist' ? { key, title: 'Jump back in' } : key === 'lib' ? { key, title: 'Lagu tersimpan' } : (rec && rec.secs || []).find(x => x.key === key);
  if (!meta) return;
  pageY = $('music') ? $('music').scrollTop : 0;
  page = { key, title: meta.title, sub: meta.sub, avatar: meta.avatar };
  render();
  if ($('music')) $('music').scrollTop = 0;
}
function closePage() {
  page = null; render();
  if ($('music')) $('music').scrollTop = pageY;
}
function renderPage() {
  const songs = pageSongs();
  body.innerHTML =
    '<div class="mu-ptw"><button type="button" class="mu-ptog" id="muptog" aria-label="Tampilkan pemutar" title="Tampilkan pemutar">' + SVG.panel + '</button></div>' +
    '<div class="mu-pgh"><button type="button" class="mu-back" id="muback" aria-label="Kembali">' + CHEV + '</button><div class="mu-sht">' +
    (page.avatar ? '<img class="av" src="' + esc(page.avatar) + '" alt="" draggable="false">' : '') +
    '<div>' + (page.sub ? '<small>' + esc(page.sub) + '</small>' : '') + '<h1>' + esc(page.title) + '</h1></div></div></div>' +
    '<div class="mu-pgn" id="mupgn">' + songs.length + ' lagu</div>' +
    '<section class="mu-sec open"><div class="mu-rw"><div class="mu-grid" id="mupage">' + songs.map((x, i) => cardHtml(x, page.key, i)).join('') + '</div></div></section>';
  $('muback').addEventListener('click', closePage);
  $('muptog').addEventListener('click', () => setPanel(true));
  $('mupage').addEventListener('click', onHome);
}
function paintPage() {
  const g = $('mupage');
  if (!g || !active() || !page) return;
  const l = pageSongs();
  g.innerHTML = l.map((x, i) => cardHtml(x, page.key, i)).join('');
  const n = $('mupgn'); if (n) n.textContent = l.length + ' lagu';
}

/* ---------- render: layar pencarian ---------- */
function render() {
  if (!active()) return;
  if (page) { renderPage(); return }
  body.innerHTML =
    '<div class="mu-ptw"><button type="button" class="mu-ptog" id="muptog" aria-label="Tampilkan pemutar" title="Tampilkan pemutar">' + SVG.panel + '</button></div>' +
    '<div class="mu-top"><h1>Musik</h1><p class="mu-sub">Cari lagu dan dengarkan langsung — tetap bisa jalan sambil ngobrol di tab lain.<small>Sumber audio: YouTube Music · Lirik: LRCLIB</small></p></div>' +
    '<form class="mu-srch" id="musrch"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/></svg>' +
    '<input id="muq" type="search" placeholder="Judul lagu, artis, atau album…" autocomplete="off" enterkeyhint="search" aria-label="Cari lagu">' +
    '<button class="mu-go" type="submit" id="mugo" aria-label="Cari">' + SVG.search.replace('<svg ', '<svg class="mu-goi" ') + '</button></form>' +
    '<div id="muhome"></div><div id="mures"></div>';
  const inp = $('muq'), res = $('mures');
  $('musrch').addEventListener('submit', e => { e.preventDefault(); doSearch(inp.value) });
  /* kolom dikosongkan (termasuk tombol x) -> kembali ke beranda rekomendasi */
  inp.addEventListener('input', () => { if (!inp.value && searched) { searched = false; searching = false; songs = []; lastErr = ''; window.muLastQ = ''; render(); $('muq').focus() } });
  $('muhome').addEventListener('click', onHome);
  $('muptog').addEventListener('click', () => setPanel(true));
  $('muhome').addEventListener('scroll', e => { const g = e.target; if (g.classList && g.classList.contains('mu-grid')) updateArrows(g.closest('.mu-sec')) }, true); /* scroll tidak bubble: pakai capture */
  if (searching) res.innerHTML = Array.from({ length: 6 }).map(() => '<div class="mu-skel"><div class="a"></div><div class="b"><i></i><i></i></div></div>').join('');
  else if (searched) res.innerHTML = renderResults();
  res.addEventListener('click', onResults);
  if (inp && window.muLastQ) inp.value = window.muLastQ;
  paintHome();
  if (!searching && !searched) loadRec();
}

/* segarkan HANYA daftar hasil (tanpa membongkar kolom cari: fokus & teks ketikan tidak hilang) */
function paintResults() {
  const res = $('mures');
  if (!res || !active()) return;
  if (!searching && searched) res.innerHTML = renderResults();
}
function renderResults() {
  if (!songs.length) return '<div class="mu-msg">Tidak ada lagu yang cocok. Coba kata kunci lain.</div>';
  const c = cur();
  return '<div class="mu-res-h">' + songs.length + ' lagu ditemukan</div>' + songs.map((s, i) =>
    '<button type="button" class="mu-song' + (c && c.id === s.id ? ' now' : '') + '" data-i="' + i + '">' +
    '<span class="th"><img src="' + esc(s.thumb || '') + '" alt="" loading="lazy">' + (c && c.id === s.id ? '<span class="mu-eq" aria-label="Sedang diputar"><i></i><i></i><i></i></span>' : '') + '</span>' +
    '<span class="si"><b>' + esc(s.title) + '</b><span>' + esc(s.artist) + (s.album ? ' · ' + esc(s.album) : '') + '</span></span>' +
    '<span class="dur">' + fmt(s.dur) + '</span>' +
    '<span class="mu-add" role="button" tabindex="0" data-add="' + i + '" title="Tambah ke antrean" aria-label="Tambah ' + esc(s.title) + ' ke antrean">' + SVG.plus + '</span></button>'
  ).join('');
}
function onResults(e) {
  const add = e.target.closest('[data-add]');
  if (add) { e.stopPropagation(); const i = +add.dataset.add; queue.push(songs[i]); save(); say('Ditambahkan ke antrean: ' + songs[i].title); if (sheet) renderSheet(); return }
  const row = e.target.closest('.mu-song');
  if (row) playFromResults(+row.dataset.i);
}

async function doSearch(qRaw) {
  const q = String(qRaw || '').trim();
  if (!q) return;
  window.muLastQ = q; lastErr = ''; searching = true; searched = true; render();
  const j = await jget('/api/music/search?q=' + encodeURIComponent(q) + '&clientId=' + encodeURIComponent(cid));
  searching = false;
  if (j.error) { lastErr = j.error; songs = [] } else songs = Array.isArray(j.songs) ? j.songs : [];
  render();
}

/* ---------- memutar lagu ---------- */
async function playSong(idx, list) {
  const nq = list || queue;
  const s = nq[idx];
  if (!s) return;
  if (list) { queue = list }
  qi = idx; loading = true; lastErr = ''; hadd(s); save(); paintResults(); paintHome(); paintPage(); renderPl(); renderSheet();
  /* lirik dulu (independen dari stream: tetap tampil walau stream diblokir bot-check) */
  lyr = null; lrcIdx = -1; lyrLoading = true; renderLrc();
  jget('/api/music/lyrics?title=' + encodeURIComponent(s.title) + '&artist=' + encodeURIComponent(s.artist) + '&dur=' + (s.dur || 0))
    .then(j => { lyr = j.lyrics ? (j.lyrics.synced && j.lyrics.synced.length ? j.lyrics.synced : j.lyrics.plain ? [{ t: -1, text: j.lyrics.plain }] : null) : null })
    .catch(() => {})
    .finally(() => { lyrLoading = false; renderLrc() });
  let j = await jget('/api/music/stream?id=' + encodeURIComponent(s.id) + '&clientId=' + encodeURIComponent(cid));
  /* 'sabr' = YouTube acak mengirim format tanpa URL (bukan soal IP): ulangi otomatis sampai 2x */
  for (let k = 0; k < 2 && !j.url && j.code === 'sabr' && qi === idx; k++) {
    await new Promise(r => setTimeout(r, 1200));
    j = await jget('/api/music/stream?id=' + encodeURIComponent(s.id) + '&clientId=' + encodeURIComponent(cid));
  }
  if (qi !== idx || cur() !== s) return; /* user sudah pindah lagu selagi menunggu */
  loading = false;
  if (!j.url) {
    lastErr = (j.error || 'Stream tidak tersedia') + (j.detail ? ' [' + j.detail + ']' : '');
    say(j.error || lastErr); renderPl(); renderSheet(); return
  }
  audio.muAt = Date.now(); // waktu src diganti (pagar anti-loop di event error)
  audio.src = j.url;
  audio.play().catch(e => {
    /* hanya NotAllowedError yang benar-benar autoplay; selain itu = sumber audio gagal dimuat (jangan salah tuduh browser) */
    if (e && e.name === 'NotAllowedError') say('Ketuk tombol putar untuk memulai (browser memblokir autoplay).');
    else if (e && e.name !== 'AbortError') explainFail();
  });
  if ('mediaSession' in navigator) {
    try {
      navigator.mediaSession.metadata = new MediaMetadata({ title: s.title, artist: s.artist, artwork: s.thumb ? [{ src: s.thumb, sizes: '544x544', type: 'image/jpeg' }] : [] });
      navigator.mediaSession.setActionHandler('play', () => audio.play());
      navigator.mediaSession.setActionHandler('pause', () => audio.pause());
      navigator.mediaSession.setActionHandler('nexttrack', () => next());
      navigator.mediaSession.setActionHandler('previoustrack', () => prev());
    } catch {}
  }
  renderPl(); renderSheet();
}
function playFromResults(i) { playSong(0, songs.slice(i).concat(songs.slice(0, i))) } /* klik = putar; sisanya mengikuti sebagai antrean */

function next() {
  if (!queue.length) return;
  if (shuffle && queue.length > 1) { let n = qi; while (n === qi) n = Math.floor(Math.random() * queue.length); return playSong(n) }
  if (qi + 1 < queue.length) return playSong(qi + 1);
  if (repeat === 'all') return playSong(0);
  audio.pause();
}
function prev() {
  if (audio.currentTime > 3) { audio.currentTime = 0; return }
  if (qi > 0) playSong(qi - 1);
  else if (repeat === 'all' && queue.length) playSong(queue.length - 1);
}
function toggle() {
  if (!cur()) return;
  if (audio.paused) {
    if (!audio.src) { playSong(qi); return } /* dipulihkan dari localStorage: URL sudah kedaluwarsa -> resolve ulang */
    audio.play().catch(() => say('Tidak bisa memutar.'));
  } else audio.pause();
}

/* ---------- render: mini player + tombol rail ---------- */
function renderPl() {
  const s = cur();
  app.classList.toggle('mu-paused', audio.paused); /* equalizer hanya bergerak saat lagu benar-benar diputar (lihat music.css) */
  pl.classList.toggle('on', !!s);
  const rb = $('rmusic'); if (rb) rb.classList.toggle('play', !!s && !audio.paused);
  if (!s) return;
  $('muart').src = s.thumb || ''; $('muart').hidden = !s.thumb;
  $('mupt').textContent = s.title;
  $('mupa').textContent = s.artist;
  $('muplay').innerHTML = loading ? SPIN : (audio.paused ? SVG.play : SVG.pause);
  $('muplay').setAttribute('aria-label', audio.paused ? 'Putar' : 'Jeda');
  paintCtl(); paintAdd();
}
function paintAdd() {
  const s = cur(), b = $('muadd'), on = !!s && inLib(s.id);
  b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on));
  b.innerHTML = on ? SVG.check : SVG.plus;
  b.title = on ? 'Hapus dari lagu tersimpan' : 'Simpan lagu';
  b.setAttribute('aria-label', b.title);
}
/* kontrol di bar bawah desktop: ikon putar/jeda, acak, ulang (tanpa ulang <-> ulang lagu yang sama) */
function paintCtl() {
  $('mupplay').innerHTML = loading ? SPIN : (audio.paused ? SVG.play : SVG.pause);
  $('mupplay').setAttribute('aria-label', audio.paused ? 'Putar' : 'Jeda');
  $('mupsh').classList.toggle('on', shuffle);
  $('muprp').innerHTML = repeat === 'one' ? SVG.repeat1 : SVG.repeat;
  $('muprp').classList.toggle('on', repeat !== 'off');
  $('muprp').setAttribute('aria-label', repeat === 'one' ? 'Ulangi lagu ini (aktif)' : 'Ulangi');
}
$('muplay').addEventListener('click', toggle);
$('munext').addEventListener('click', () => next());
$('mupplay').addEventListener('click', toggle);
$('mupnx').addEventListener('click', () => next());
$('muppv').addEventListener('click', () => prev());
$('mupsh').addEventListener('click', () => { shuffle = !shuffle; save(); renderPl(); renderSheet() });
$('muprp').addEventListener('click', () => { repeat = repeat === 'off' ? 'one' : 'off'; save(); renderPl(); renderSheet(); say(repeat === 'off' ? 'Ulangi mati' : 'Ulangi satu lagu') });
$('muadd').addEventListener('click', e => {
  e.stopPropagation();
  const s = cur(); if (!s) return;
  const r = libToggle(s);
  if (r === null) say(lget().length >= LIB_MAX ? 'Lagu tersimpan penuh (maks ' + LIB_MAX + ').' : 'Gagal menyimpan: penyimpanan browser penuh.');
  else say(r ? 'Disimpan ke Lagu tersimpan: ' + s.title : 'Dihapus dari Lagu tersimpan: ' + s.title);
  paintAdd(); paintHome(); paintPage();
});

/* volume (disimpan di 'mvol'); tombol speaker = bisukan / bunyikan */
{ const v = parseFloat(store.get('mvol')); if (isFinite(v)) audio.volume = Math.min(1, Math.max(0, v)) }
let lastVol = audio.volume || 1;
function paintVol() {
  const v = audio.muted ? 0 : audio.volume;
  vol.value = Math.round(v * 100); vol.style.setProperty('--v', vol.value + '%');
  $('muvolb').innerHTML = v === 0 ? SVG.vol0 : v < .5 ? SVG.vol1 : SVG.vol2;
}
vol.addEventListener('input', () => { audio.muted = false; audio.volume = vol.value / 100; if (audio.volume > 0) lastVol = audio.volume; store.set('mvol', String(audio.volume)) });
$('muvolb').addEventListener('click', () => {
  if (audio.muted || audio.volume === 0) { audio.muted = false; if (audio.volume === 0) audio.volume = lastVol || .7 }
  else { lastVol = audio.volume; audio.muted = true }
  store.set('mvol', String(audio.volume));
});
audio.addEventListener('volumechange', paintVol);
paintVol();

/* ---------- render: lembar now playing ---------- */
function renderSheet() {
  if (!sheet) return;
  const s = cur();
  if (!s) { if (desk()) { np.classList.add('none'); return } np.classList.remove('on'); sheet = false; return }
  np.classList.remove('none');
  $('mnpart').src = s.thumb || '';
  $('mnpt').textContent = s.title;
  $('mnpa').textContent = s.artist + (s.album ? ' · ' + s.album : '');
  const err = $('mnperr');
  if (lastErr) { err.hidden = false; err.innerHTML = '<b>' + esc(lastErr) + '</b> — pencarian & lirik tetap jalan; ini hanya soal stream.' } else err.hidden = true;
  $('mnpplay').innerHTML = loading ? SPIN : (audio.paused ? SVG.play : SVG.pause);
  $('mnprp').innerHTML = repeat === 'one' ? SVG.repeat1 : SVG.repeat;
  $('mnprp').classList.toggle('on', repeat !== 'off');
  $('mnpsh').classList.toggle('on', shuffle);
  $('mnptab-q').textContent = 'Antrean' + (queue.length ? ' (' + queue.length + ')' : '');
  $('mnptab-l').classList.toggle('on', sheetTab === 'lyrics');
  $('mnptab-q').classList.toggle('on', sheetTab === 'queue');
  lrcBox.hidden = sheetTab !== 'lyrics';
  qBox.hidden = sheetTab !== 'queue';
  if (sheetTab === 'queue') renderQueue();
  paintTime();
}
function renderQueue() {
  if (!sheet || sheetTab !== 'queue') return;
  if (!queue.length) { qBox.innerHTML = '<div class="mu-qempty">Antrean kosong. Cari lagu lalu ketuk untuk memutar.</div>'; return }
  qBox.innerHTML = '<div class="mu-qhead"><b>Antrean</b>' + (queue.length > 1 ? '<button type="button" id="muqclear">Bersihkan</button>' : '') + '</div>' +
    queue.map((s, i) =>
      '<div class="mu-qrow' + (i === qi ? ' now' : '') + '" data-i="' + i + '" role="button" tabindex="0">' +
      '<span class="n">' + (i === qi ? '▶' : i + 1) + '</span>' +
      '<img src="' + esc(s.thumb || '') + '" alt="" loading="lazy">' +
      '<span class="si"><b>' + esc(s.title) + '</b><span>' + esc(s.artist) + '</span></span>' +
      '<span class="dur">' + fmt(s.dur) + '</span>' +
      '<span class="rm" role="button" tabindex="0" data-rm="' + i + '" aria-label="Hapus dari antrean">' + SVG.close + '</span></div>').join('');
  const cl = $('muqclear'); if (cl) cl.addEventListener('click', () => { const s = cur(); queue = s ? [s] : []; qi = s ? 0 : -1; save(); renderSheet() });
}
qBox.addEventListener('click', e => {
  const rm = e.target.closest('[data-rm]');
  if (rm) { const i = +rm.dataset.rm; if (i === qi) audio.pause(); queue.splice(i, 1); qi = i < qi ? qi - 1 : (i === qi ? -1 : qi); save(); renderSheet(); return }
  const row = e.target.closest('.mu-qrow');
  if (row) playSong(+row.dataset.i);
});
function renderLrc() {
  if (!sheet || sheetTab !== 'lyrics') return;
  const c = cur();
  const key = (c ? c.id : '') + ':' + (lyrLoading ? 'L' : !lyr ? 'N' : lyr.length);
  if (key === lrcBuilt && lrcBox.firstChild) return; /* sudah dirender: jangan bongkar (scroll & sorotan ikut hilang tiap play/pause) */
  lrcBuilt = key; lrcIdx = -1;
  const synced = !!(lyr && lyr.length && lyr[0].t >= 0);
  lrcBox.classList.toggle('sync', synced);
  if (lyrLoading) { lrcBox.innerHTML = '<div class="mu-lrc-empty">Mencari lirik…</div>'; return }
  if (!lyr || !lyr.length) { lrcBox.innerHTML = '<div class="mu-lrc-empty">Lirik tidak ditemukan untuk lagu ini.</div>'; return }
  lrcBox.innerHTML = lyr.map((l, i) => '<div class="ln" data-i="' + i + '"' + (l.t < 0 ? ' data-plain="1"' : '') + '>' + esc(l.text) + '</div>').join('');
  lrcBox.scrollTop = 0;
}
/* baris yang sedang dinyanyikan (pencarian biner; +0.25 dtk supaya sorotan sedikit mendahului suara) */
function lrcFind(t) {
  let lo = 0, hi = lyr.length - 1, k = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (lyr[mid].t <= t + 0.25) { k = mid; lo = mid + 1 } else hi = mid - 1 }
  return k;
}
/* tengahkan satu baris di dalam kotak lirik. Pakai getBoundingClientRect: offsetTop salah karena kotak ini
   bukan offsetParent langsung (dulu hasilnya melenceng ke posisi di layar, bukan di kotak). */
function lrcCenter(el, smooth) {
  const b = lrcBox.getBoundingClientRect(), r = el.getBoundingClientRect();
  const top = lrcBox.scrollTop + (r.top - b.top) - (b.height - r.height) / 2;
  lrcBox.scrollTo({ top: Math.max(0, top), behavior: smooth ? 'smooth' : 'auto' });
}
/* force = gambar ulang sorotan + loncat langsung (saat lembar dibuka / pindah tab / seek). Selain itu hanya bila baris berganti. */
function syncLrc(force) {
  if (!sheet || sheetTab !== 'lyrics' || !lyr || !lyr.length || lyr[0].t < 0 || lrcBox.hidden) return;
  const k = lrcFind(audio.currentTime);
  if (k === lrcIdx && !force) return;
  lrcIdx = k;
  const els = lrcBox.querySelectorAll('.ln');
  els.forEach((el, i) => { el.dataset.lrc = i === k ? 'on' : 'off'; el.classList.toggle('past', i < k) });
  if (k < 0) { if (force) lrcBox.scrollTop = 0; return }
  if (force || Date.now() > lrcHold) lrcCenter(els[k], !force);
}
const lrcShow = () => { renderLrc(); requestAnimationFrame(() => syncLrc(true)) };
/* user menggulir sendiri -> auto-scroll berhenti 4 dtk (kalau tidak, kotak "melawan" jari) */
for (const ev of ['wheel', 'touchstart', 'pointerdown']) lrcBox.addEventListener(ev, () => { lrcHold = Date.now() + 4000 }, { passive: true });
lrcBox.addEventListener('click', e => {
  const ln = e.target.closest('.ln');
  if (ln && ln.dataset.i !== undefined && lyr) { const l = lyr[+ln.dataset.i]; if (l && l.t >= 0) { lrcHold = 0; audio.currentTime = l.t; syncLrc(true) } }
});

/* tab lirik / antrean */
for (const id of ['mnptab-l', 'mnptab-q']) $(id).addEventListener('click', () => { sheetTab = $(id).dataset.t; renderSheet(); if (sheetTab === 'lyrics') lrcShow() });
$('mnpsh').addEventListener('click', () => { shuffle = !shuffle; save(); renderSheet(); renderPl() });
$('mnprp').addEventListener('click', () => { repeat = repeat === 'off' ? 'all' : repeat === 'all' ? 'one' : 'off'; save(); renderSheet(); renderPl(); say(repeat === 'off' ? 'Ulangi mati' : repeat === 'all' ? 'Ulangi semua' : 'Ulangi satu lagu') });
$('mnpplay').addEventListener('click', toggle);
$('mnpnx').addEventListener('click', () => next());
$('mnppv').addEventListener('click', () => prev());

/* ---------- penggeser waktu ---------- */
const seek = $('mnpseek');
function seekP(e) { const r = seek.getBoundingClientRect(); return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) }
seek.addEventListener('pointerdown', e => { seek.setPointerCapture(e.pointerId); seek.classList.add('drag'); seek.dataset.p = String(seekP(e)); paintTime() });
seek.addEventListener('pointermove', e => { if (seek.classList.contains('drag')) seek.dataset.p = String(seekP(e)); paintTime() });
seek.addEventListener('pointerup', e => { seek.classList.remove('drag'); const p = +(seek.dataset.p || 0); if (audio.duration) { audio.currentTime = p * audio.duration; lrcHold = 0 } delete seek.dataset.p; paintTime() });
audio.addEventListener('seeked', () => syncLrc(true));
/* penggeser waktu di bar bawah (desktop) */
const seekP2 = e => { const r = seek2.getBoundingClientRect(); return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) };
seek2.addEventListener('pointerdown', e => { seek2.setPointerCapture(e.pointerId); seek2.classList.add('drag'); seek2.dataset.p = String(seekP2(e)); paintTime() });
seek2.addEventListener('pointermove', e => { if (seek2.classList.contains('drag')) { seek2.dataset.p = String(seekP2(e)); paintTime() } });
seek2.addEventListener('pointerup', () => {
  if (!seek2.classList.contains('drag')) return;
  seek2.classList.remove('drag'); const p = +(seek2.dataset.p || 0);
  if (audio.duration) { audio.currentTime = p * audio.duration; lrcHold = 0 }
  delete seek2.dataset.p; paintTime();
});
seek2.addEventListener('pointercancel', () => { seek2.classList.remove('drag'); delete seek2.dataset.p; paintTime() });
seek2.addEventListener('keydown', e => {
  if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && audio.duration) { e.preventDefault(); audio.currentTime = Math.max(0, Math.min(audio.duration, audio.currentTime + (e.key === 'ArrowRight' ? 5 : -5))) }
});

function paintTime() {
  const d = audio.duration || (cur() && cur().dur) || 0;
  let p = seek.classList.contains('drag') ? +(seek.dataset.p || 0) : (d ? Math.min(1, audio.currentTime / d) : 0);
  $('mnpfl').style.width = (p * 100) + '%';
  $('mnpkn').style.left = (p * 100) + '%';
  $('mnpt1').textContent = fmt(audio.currentTime);
  $('mnpt2').textContent = fmt(d);
  seek.setAttribute('aria-valuenow', String(Math.round(p * 100)));
  $('mupb-fl').style.width = (d ? Math.min(1, audio.currentTime / d) * 100 : 0) + '%';
  const dr = seek2.classList.contains('drag'), p2 = dr ? +(seek2.dataset.p || 0) : (d ? Math.min(1, audio.currentTime / d) : 0);
  $('mupfl').style.width = (p2 * 100) + '%';
  $('mupkn').style.left = (p2 * 100) + '%';
  $('mupt1').textContent = fmt(dr ? p2 * d : audio.currentTime);
  $('mupt2').textContent = fmt(d);
  seek2.setAttribute('aria-valuenow', String(Math.round(p2 * 100)));
}

/* ---------- peristiwa audio ---------- */
audio.addEventListener('loadedmetadata', paintTime);
audio.addEventListener('timeupdate', () => {
  paintTime();
  syncLrc(false);
});
audio.addEventListener('play', () => { renderPl(); renderSheet() });
audio.addEventListener('pause', () => { renderPl(); renderSheet() });
audio.addEventListener('ended', () => { if (repeat === 'one') { audio.currentTime = 0; audio.play().catch(() => {}) } else next() });
/* ambil alasan asli dari server (JSON error dari /api/music/audio) lalu tampilkan */
async function explainFail() {
  let msg = 'Gagal memutar lagu ini.';
  try {
    const r = await fetch(audio.src, { headers: { Range: 'bytes=0-1' } });
    if (!r.ok) { const j = await r.json().catch(() => ({})); msg = (j.error || 'Server error ' + r.status) + (j.detail ? ' [' + j.detail + ']' : '') + ' — cek /api/music/debug' }
    else msg = 'Browser tidak bisa memutar format audio ini' + (audio.error ? ' (kode ' + audio.error.code + ')' : '') + '.';
  } catch (e) { msg = 'Gagal menghubungi server musik.' }
  lastErr = msg; say(msg); renderPl(); renderSheet();
}
audio.addEventListener('error', () => {
  if (!audio.src) return;
  /* URL kedaluwarsa (±6 jam) = hal biasa setelah lama idle: selesaikan ulang sekali.
     Pagar anti-loop: kalau error terjadi <4 dtk setelah src terakhir diganti, tampilkan pesan saja. */
  if (Date.now() - (audio.muAt || 0) < 4000) { explainFail(); return }
  lastErr = 'URL stream kedaluwarsa — mengambil yang baru…';
  playSong(qi);
});

/* ---------- pintasan keyboard ---------- */
addEventListener('keydown', e => {
  const tag = (e.target && e.target.tagName) || '';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target.isContentEditable) return;
  if (e.key === 'Escape' && sheet && !desk()) { setPanel(false); return }
  if (e.key === 'Escape' && page) { closePage(); return }
  if (e.code === 'Space' && cur() && (!sheet || desk())) { e.preventDefault(); toggle() }
});

/* ---------- integrasi shell ---------- */
addEventListener('shell:tab', () => { if (active()) { render(); applyPanel() } else { sheet = false; np.classList.remove('on') } });
if (active()) render();
applyPanel();
renderPl();
/* lebar kolom berubah (panel dibuka/ditutup) tidak memicu 'resize' jendela: pantau #music langsung supaya panah carousel ikut menyesuaikan */
let lastDesk = desk();
addEventListener('resize', () => { const d = desk(); if (d !== lastDesk) { lastDesk = d; applyPanel() } });
if (window.ResizeObserver && $('music')) new ResizeObserver(() => { if (active()) fitRows() }).observe($('music'));

/* konteks untuk mode dev (opsional dipakai lewat konsol) — hanya terpasang saat Mode dev aktif */
const MU_API = { play: playSong, next, prev, queue: () => queue, search: doSearch };
if (dev()) window.MU = MU_API;
/* Mode dev dimatikan saat musik jalan (kejadian 'devmode' dari Pengaturan): hentikan lagu,
   bersihkan antrean, sembunyikan pemutar, dan pulangkan tab ke Beranda. */
addEventListener('devmode', () => {
  if (dev()) { window.MU = MU_API; return }
  try { delete window.MU } catch {}
  audio.pause();
  try { audio.removeAttribute('src'); audio.load() } catch {}
  queue = []; qi = -1; save();
  sheet = false; np.classList.remove('on');
  renderPl();
  if (app.dataset.tab === 'music' && typeof setTab === 'function') setTab('home');
});
})();
